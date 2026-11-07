#!/usr/bin/env node
/* 卡 D：追问 chip 化（diagnose/explain.js Tutor 层 + llm-variants.js 准入 + llm-config.js 预算）
 *
 * node tests/test_chat_chips.js
 *
 * 覆盖（规格第五节的 7 组断言，先写测试跑红，再实现转绿）：
 *   1. chip 动作白名单 —— resolveChip 只认 4 个 action；不认识的不发请求（fetch 计数 0）。
 *   2. 题面不可变 —— 会话键 = qid + prompt_hash；题面一变即新会话，旧会话拒绝新题面的轮次。
 *   3. 未验证标记 —— 本地判解只认本地求值：无最终答案 → unverified；渲染文案不含「答对了」。
 *   4. 轮数上限 —— 10 轮封顶；第 11 轮裁到最近 3 轮 + 摘要（trimmed）。
 *   5. AI 题标识 + 队列准入 —— 未过验证门的 llm 题不进练习队列；badge 只从 AI_DRAFT_BADGE 取。
 *   6. 提示分级 —— L1/L2 泄漏答案换成固定安全文案（redacted）；L3 原样（gate: reveal）。
 *   7. 单一真源 —— chip 请求体 max_tokens / response_format / schema 字段名来自 llm-config.js
 *      与固定 system 指令；timeouts.tutor 存在且为正数。
 */
'use strict';
const assert = require('assert');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e).split('\n').slice(0, 6).join('\n       ')); }
}
const asyncTests = [];
function testAsync(name, fn) { asyncTests.push({ name: name, fn: fn }); }

const E = require('../diagnose/engine.js');
const F = require('../diagnose/funclab.js');
const Cfg = require('../diagnose/llm-config.js');
const LLMV = require('../diagnose/llm-variants.js');

function loadExplain() {
  const g = globalThis;
  g.window = g;
  g.DiagEngine = E;
  g.Funclab = F;
  delete require.cache[require.resolve('../diagnose/explain.js')];
  require('../diagnose/explain.js');
  return g.Explain;
}

/* 题目 fixture：answer '3' 是纯数字，泄漏判据两条路（verifyReveal / 数字边界）都能验证 */
const Q = { id: 'chip-1', type: 'numeric', prompt: '解方程 2(x-3)=4-(x+1)。', answer: '3' };
const Q_NO_ANS = { id: 'chip-noans', type: 'short', prompt: '说说移项要注意什么。', answer: '' };

/* runChip 的合法 ctx（规格 2.5：topic/q/userAnswer/steps/labDesc/session/level/solution） */
function makeCtx(T, over) {
  const ctx = {
    topic: { id: 'cnm_043', name: '含括号的一元一次方程' },
    q: Q,
    userAnswer: '5',
    steps: [{ kind: 'hint', text: '移项要变号。' }],
    labDesc: '',
    session: T.newSession(Q),
    level: 1,
    solution: ''
  };
  Object.keys(over || {}).forEach(function (k) { ctx[k] = over[k]; });
  return ctx;
}

/* 桩 fetch：捕获请求体，返回固定 content 的成功响应 */
function stubFetch(content) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = function (url, opts) {
    calls.push(opts ? JSON.parse(opts.body) : null);
    return Promise.resolve({ ok: true, json: function () { return Promise.resolve({ choices: [{ message: { content: content } }] }); } });
  };
  return { calls: calls, restore: function () { globalThis.fetch = real; } };
}

/* ================= 1. chip 动作白名单 ================= */

test('TUTOR_CHIPS：4 个 chip 的顺序与文案（UI 顺序，文案一字不改）', function () {
  const X = loadExplain();
  assert.deepStrictEqual(X._tutor.CHIPS.map(function (c) {
    return { action: c.action, label: c.label };
  }), [
    { action: 'why_step', label: '这一步为什么这么做' },
    { action: 'variant', label: '换个数字再来一道' },
    { action: 'judge_mine', label: '我这样算对不对' },
    { action: 'hint_leveled', label: '给我一点点提示' }
  ]);
});

test('resolveChip：只认 4 个白名单 action，其余一律 null', function () {
  const X = loadExplain();
  const T = X._tutor;
  assert.strictEqual(T.resolveChip('why_step').action, 'why_step');
  assert.strictEqual(T.resolveChip('variant').action, 'variant');
  assert.strictEqual(T.resolveChip('judge_mine').action, 'judge_mine');
  assert.strictEqual(T.resolveChip('hint_leveled').action, 'hint_leveled');
  assert.strictEqual(T.resolveChip('nope'), null);
  assert.strictEqual(T.resolveChip(null), null);
  assert.strictEqual(T.resolveChip(''), null);
  assert.strictEqual(T.resolveChip(123), null);
});

testAsync('runChip：不认识的 action 绝不发请求（fetch 计数 0）→ unknown-action；variant → pipeline-action', async () => {
  const X = loadExplain();
  const T = X._tutor;
  const m = stubFetch('{}');
  try {
    const res = await X.runChip('nope', makeCtx(T));
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.from, 'none');
    assert.strictEqual(res.action, 'nope');
    assert.strictEqual(res.reason, 'unknown-action');
    assert.strictEqual(m.calls.length, 0, '白名单不认时不得碰 fetch');
    const v = await X.runChip('variant', makeCtx(T));
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.from, 'pipeline');
    assert.strictEqual(v.reason, 'pipeline-action');
    assert.strictEqual(m.calls.length, 0, 'variant 是管线动作，不在本层发请求');
  } finally { m.restore(); }
});

testAsync('runChip：缺会话 → no-session，不发请求', async () => {
  const X = loadExplain();
  const m = stubFetch('{}');
  try {
    const res = await X.runChip('why_step', {
      topic: { id: 'cnm_043', name: '含括号的一元一次方程' },
      q: Q, userAnswer: '', steps: [], labDesc: '', session: null, level: 1, solution: ''
    });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.from, 'none');
    assert.strictEqual(res.reason, 'no-session');
    assert.strictEqual(m.calls.length, 0);
  } finally { m.restore(); }
});

/* ================= 2. 题面不可变（会话锚定） ================= */

test('promptHash：空白归一；8 位小写 hex；题面一变即变', function () {
  const X = loadExplain();
  const T = X._tutor;
  const h1 = T.promptHash('解方程 2(x-3)=4-(x+1)。');
  const h2 = T.promptHash('解方程  2(x-3)=4-(x+1)。 \n');
  assert.strictEqual(h1, h2, '连续空白 / 换行 / 首尾空白不改变题面');
  assert.ok(/^[0-9a-f]{8}$/.test(h1), '应为 8 位小写 hex：' + h1);
  assert.notStrictEqual(T.promptHash('解方程 2(x-3)=5-(x+1)。'), h1, '题面一变 hash 必须变');
});

test('identify / sessionKeyOf：键 = qid + prompt_hash', function () {
  const X = loadExplain();
  const T = X._tutor;
  const idn = T.identify(Q);
  assert.strictEqual(idn.qid, 'chip-1@' + T.promptHash(Q.prompt));
  assert.strictEqual(idn.prompt, Q.prompt);
  assert.strictEqual(T.sessionKeyOf(Q), idn.qid + '|' + idn.promptHash);
  /* 无 id 的题不炸：落到 'anon' */
  const anon = T.identify({ prompt: '随便一题' });
  assert.ok(anon.qid.indexOf('anon@') === 0, '无 id 应回退 anon：' + anon.qid);
});

test('newSession：题面快照 + 空 rounds；appendRound 不可变风格（旧对象不被原地改）', function () {
  const X = loadExplain();
  const T = X._tutor;
  const s0 = T.newSession(Q);
  assert.strictEqual(s0.promptHash, T.promptHash(Q.prompt));
  assert.strictEqual(s0.prompt, Q.prompt);
  assert.strictEqual(s0.qid, T.identify(Q).qid);
  assert.strictEqual(s0.key, T.sessionKeyOf(Q));
  assert.deepStrictEqual(s0.rounds, []);
  assert.strictEqual(s0.summary, '');
  assert.strictEqual(s0.trimmed, false);
  const r1 = T.appendRound(s0, { q: '问1', a: '答1', action: 'why_step', promptHash: s0.promptHash });
  const r2 = T.appendRound(r1.session, { q: '问2', a: '答2', action: 'judge_mine', promptHash: s0.promptHash });
  assert.ok(r2.ok);
  assert.strictEqual(r2.session.rounds.length, 2);
  assert.strictEqual(r2.session.promptHash, T.promptHash(Q.prompt), '两轮后 hash 不变');
  assert.strictEqual(r2.session.qid, s0.qid);
  assert.strictEqual(s0.rounds.length, 0, '不可变风格：旧 session 不被改');
  assert.strictEqual(r1.session.rounds.length, 1);
});

test('题面不可变：改一个字 → 新 hash；旧会话拒绝新题面的轮次（prompt-changed）', function () {
  const X = loadExplain();
  const T = X._tutor;
  const s0 = T.newSession(Q);
  const r = T.appendRound(s0, { q: '问1', a: '答1', action: 'why_step', promptHash: s0.promptHash });
  const Q2 = JSON.parse(JSON.stringify(Q));
  Q2.prompt = Q.prompt.replace('4-(x+1)', '5-(x+1)');
  assert.notStrictEqual(T.identify(Q2).promptHash, s0.promptHash, '题面改一个字 hash 必须变');
  const bad = T.appendRound(r.session, { q: '问2', a: '答2', action: 'why_step', promptHash: T.identify(Q2).promptHash });
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.reason, 'prompt-changed');
});

/* ================= 3. 本地判解（未验证标记） ================= */

test('extractFinalAnswer / normalizeClaim：三条路径 + 剥变量前缀', function () {
  const X = loadExplain();
  const T = X._tutor;
  /* 路径 1：答案/答: 前缀 */
  assert.strictEqual(T.extractFinalAnswer('答案：x=3'), 'x=3');
  assert.strictEqual(T.extractFinalAnswer('答: x = 5'), 'x = 5');
  /* 路径 2：所以/因此/故/即/得 + 数值 */
  assert.strictEqual(T.extractFinalAnswer('所以 x=3'), 'x=3');
  assert.strictEqual(T.extractFinalAnswer('故 x＝-2'), 'x＝-2');
  assert.strictEqual(T.extractFinalAnswer('得 3'), '3');
  /* 路径 3：行首/行尾的 x = 3 形态 */
  assert.strictEqual(T.extractFinalAnswer('解：\nx = 3\n'), 'x = 3');
  /* 无命中 */
  assert.strictEqual(T.extractFinalAnswer('先去括号：2x-6=4-x，然后移项，最后合并同类项。'), null);
  /* normalizeClaim 剥变量前缀、去尾部标点空白 */
  assert.strictEqual(T.normalizeClaim('x=3'), '3');
  assert.strictEqual(T.normalizeClaim('x = 3'), '3');
  assert.strictEqual(T.normalizeClaim('x＝-2'), '-2');
  assert.strictEqual(T.normalizeClaim('x1=2'), '2');
  assert.strictEqual(T.normalizeClaim('3。'), '3');
});

test('judgeSolution：无最终答案 → unverified（no-final-answer）；对照组 correct / wrong', function () {
  const X = loadExplain();
  const T = X._tutor;
  const r1 = T.judgeSolution(Q, '先去括号：2x-6=4-x，然后移项，最后合并同类项。');
  assert.strictEqual(r1.conclusion, 'unverified');
  assert.strictEqual(r1.reason, 'no-final-answer');
  const r2 = T.judgeSolution(Q, '答案：x=3');
  assert.strictEqual(r2.conclusion, 'correct');
  assert.strictEqual(r2.reason, 'local-correct');
  assert.strictEqual(r2.claim, '3');
  const r3 = T.judgeSolution(Q, '答案：x=5');
  assert.strictEqual(r3.conclusion, 'wrong');
  assert.strictEqual(r3.reason, 'local-wrong');
});

test('judgeSolution：没有 q.answer → unverified（no-reference）', function () {
  const X = loadExplain();
  const T = X._tutor;
  const r = T.judgeSolution(Q_NO_ANS, '答案：先移项再合并。');
  assert.strictEqual(r.conclusion, 'unverified');
  assert.strictEqual(r.reason, 'no-reference');
});

test('renderVerdict：三档文案/类名/badge；unverified 不含「答对了」', function () {
  const X = loadExplain();
  const T = X._tutor;
  const ok = T.renderVerdict(T.judgeSolution(Q, '答案：x=3'));
  assert.strictEqual(ok.cls, 'ask-verdict ok');
  assert.strictEqual(ok.badge, '已核对');
  assert.ok(ok.text.indexOf('一致') >= 0);
  const no = T.renderVerdict(T.judgeSolution(Q, '答案：x=5'));
  assert.strictEqual(no.cls, 'ask-verdict no');
  assert.strictEqual(no.badge, '已核对');
  assert.ok(no.text.indexOf('不一致') >= 0);
  const un = T.renderVerdict(T.judgeSolution(Q, '先去括号：2x-6=4-x，然后移项，最后合并同类项。'));
  assert.strictEqual(un.cls, 'ask-verdict unverified');
  assert.strictEqual(un.badge, '未验证');
  assert.ok(un.text.indexOf('未验证') >= 0, 'unverified 文案应含「未验证」：' + un.text);
  assert.ok(un.text.indexOf('答对了') < 0, 'unverified 文案不得出现「答对了」');
  assert.ok(un.text.indexOf('你做对了') < 0, 'unverified 文案不得出现「你做对了」');
});

/* ================= 4. 轮数上限 ================= */

test('轮数上限：10 轮封顶；第 11 轮裁到最近 3 轮 + 摘要（trimmed）', function () {
  const X = loadExplain();
  const T = X._tutor;
  assert.strictEqual(T.MAX_ROUNDS, 10);
  assert.strictEqual(T.KEEP_ROUNDS, 3);
  const s0 = T.newSession(Q);
  let s = s0;
  for (let i = 1; i <= T.MAX_ROUNDS; i++) {
    const r = T.appendRound(s, { q: '问' + i, a: '答' + i, action: 'why_step', promptHash: s0.promptHash });
    assert.ok(r.ok, '第 ' + i + ' 轮应成功');
    s = r.session;
  }
  assert.strictEqual(s.rounds.length, T.MAX_ROUNDS);
  assert.strictEqual(s.trimmed, false);
  const r11 = T.appendRound(s, { q: '问11', a: '答11', action: 'judge_mine', promptHash: s0.promptHash });
  assert.ok(r11.ok, '第 11 轮应 ok（先裁剪再入列）');
  const s11 = r11.session;
  assert.strictEqual(s11.rounds.length, T.KEEP_ROUNDS);
  assert.strictEqual(s11.trimmed, true);
  assert.ok(s11.summary.length > 0, '被裁掉的轮次应并成摘要');
  assert.ok(s11.summary.indexOf('问1') >= 0, '最早一轮应进摘要');
  assert.strictEqual(s11.rounds[0].q, '问9', '保留最近 KEEP-1=2 轮再入新轮');
  assert.strictEqual(s11.rounds[2].q, '问11');
  /* 不可变风格：裁剪也不改旧对象 */
  assert.strictEqual(s.rounds.length, T.MAX_ROUNDS);
  assert.strictEqual(s.trimmed, false);
});

test('summarize：确定性摘要；每轮 q/a 截 24 字；总长 ≤ 200；prevSummary 接在前面', function () {
  const X = loadExplain();
  const T = X._tutor;
  const rounds = [{ q: '问一', a: '答一' }, { q: '问二', a: '答二' }];
  const sm = T.summarize('', rounds);
  assert.ok(sm.indexOf('更早的 2 轮') >= 0, '摘要应带轮数：' + sm);
  assert.ok(sm.indexOf('问「问一」') >= 0);
  assert.ok(sm.indexOf('答「答二」') >= 0);
  /* 长输入截 24 字 */
  const long = [];
  for (let i = 0; i < 40; i++) long.push('字');
  const q40 = long.join('');
  const smLong = T.summarize('', [{ q: q40, a: q40 }]);
  assert.ok(smLong.indexOf(q40.slice(0, 24)) >= 0, '应保留前 24 字');
  assert.ok(smLong.indexOf(q40.slice(0, 26)) < 0, '第 25 字起不应保留');
  assert.ok(smLong.length <= 200, '摘要总长 ≤ 200：' + smLong.length);
  /* prevSummary 非空接在前面，仍受总长约束 */
  const sm2 = T.summarize('旧摘要;', rounds);
  assert.ok(sm2.indexOf('旧摘要') >= 0);
  assert.ok(sm2.length <= 200);
});

test('contextFor：返回 qid/promptHash/prompt/summary/rounds 拷贝（不返回内部引用）', function () {
  const X = loadExplain();
  const T = X._tutor;
  const s0 = T.newSession(Q);
  const r = T.appendRound(s0, { q: '问1', a: '答1', action: 'why_step', promptHash: s0.promptHash });
  const ctx = T.contextFor(r.session);
  assert.strictEqual(ctx.qid, r.session.qid);
  assert.strictEqual(ctx.promptHash, r.session.promptHash);
  assert.strictEqual(ctx.prompt, r.session.prompt);
  assert.strictEqual(ctx.summary, r.session.summary);
  assert.strictEqual(ctx.rounds.length, 1);
  assert.notStrictEqual(ctx.rounds, r.session.rounds, 'rounds 必须是拷贝');
  ctx.rounds.push({ q: '篡改', a: '篡改' });
  assert.strictEqual(r.session.rounds.length, 1, '改拷贝不影响内部会话');
});

/* ================= 5. AI 题标识 + 队列准入 ================= */

test('AI_DRAFT_BADGE / badgeFor：文案与类名只从单一常量取；返回拷贝', function () {
  assert.strictEqual(LLMV.AI_DRAFT_BADGE.text, 'AI 现出题·未审核');
  assert.strictEqual(LLMV.AI_DRAFT_BADGE.cls, 'tag tag-ai-draft');
  const b = LLMV.badgeFor({ variantSource: 'llm' });
  assert.strictEqual(b.text, LLMV.AI_DRAFT_BADGE.text);
  assert.strictEqual(b.cls, LLMV.AI_DRAFT_BADGE.cls);
  assert.strictEqual(LLMV.badgeFor({}), null, '题库题不带 AI 标识');
  /* 拷贝语义：改返回值不得污染常量 */
  b.text = '篡改';
  assert.strictEqual(LLMV.AI_DRAFT_BADGE.text, 'AI 现出题·未审核');
});

test('admitToPracticeQueue：未验证 llm 题拒入；题库题与已验证题放行', function () {
  assert.strictEqual(LLMV.admitToPracticeQueue({ variantSource: 'llm' }), false);
  assert.strictEqual(LLMV.admitToPracticeQueue({ variantSource: 'llm', llmVerified: false }), false);
  assert.strictEqual(LLMV.admitToPracticeQueue({ variantSource: 'llm', llmVerified: true }), true);
  assert.strictEqual(LLMV.admitToPracticeQueue({}), true, '题库题（无 variantSource）一律放行');
  /* 内部同口径 */
  assert.strictEqual(LLMV._admitToPracticeQueue({ variantSource: 'llm', llmVerified: true }), true);
});

test('fillPracticeLLM 的过滤口径：[llm 未验证, 题库题, llm 已验证] 只放行后两者', function () {
  const list = [
    { id: 'a', variantSource: 'llm' },
    { id: 'b' },
    { id: 'c', variantSource: 'llm', llmVerified: true }
  ];
  const admitted = list.filter(LLMV.admitToPracticeQueue);
  assert.deepStrictEqual(admitted.map(function (q) { return q.id; }), ['b', 'c']);
});

/* ================= 6. 提示分级 ================= */

test('sanitizeHint：L1 泄漏 → 固定安全文案（redacted+leaked）；不泄漏原样；L3 原样（reveal）', function () {
  const X = loadExplain();
  const T = X._tutor;
  /* L1 泄漏（'3' 前后都不是数字 → 纯数字边界判据）*/
  const r1 = T.sanitizeHint(1, '算出来 x=3 就对了', Q);
  assert.strictEqual(r1.leaked, true);
  assert.strictEqual(r1.redacted, true);
  assert.strictEqual(r1.level, 1);
  assert.strictEqual(r1.text, T.SAFE_HINT[1], '泄漏时换成固定安全文案');
  assert.ok(r1.text.indexOf('3') < 0, 'L1 替换文案不得含答案数值：' + r1.text);
  assert.ok(r1.text.indexOf('x=3') < 0);
  /* L1 不泄漏：原样 */
  const r2 = T.sanitizeHint(1, '先看等号两边各有什么', Q);
  assert.strictEqual(r2.leaked, false);
  assert.strictEqual(r2.redacted, false);
  assert.strictEqual(r2.text, '先看等号两边各有什么');
  /* L3：原样放行（此时就是要给答案）*/
  const r3 = T.sanitizeHint(3, '答案：x=3', Q);
  assert.strictEqual(r3.redacted, false);
  assert.strictEqual(r3.gate, 'reveal');
  assert.strictEqual(r3.text, '答案：x=3');
  /* L2 也有一句固定安全文案 */
  assert.ok(typeof T.SAFE_HINT[2] === 'string' && T.SAFE_HINT[2].length > 0);
  /* 相邻数字不算泄漏：'13' 里的 3 不是答案 */
  const r4 = T.sanitizeHint(1, '先算 13-10 这一步', Q);
  assert.strictEqual(r4.leaked, false, '13 里的 3 前面是数字，不算泄漏');
});

test('sanitizeHint：level 归一为 1/2/3；无参考答案原样放行（no-reference）', function () {
  const X = loadExplain();
  const T = X._tutor;
  assert.strictEqual(T.sanitizeHint(0, '先看等号两边各有什么', Q).level, 1);
  assert.strictEqual(T.sanitizeHint(9, '先看等号两边各有什么', Q).level, 1);
  assert.strictEqual(T.sanitizeHint(null, '先看等号两边各有什么', Q).level, 1);
  assert.strictEqual(T.sanitizeHint('2', '先看等号两边各有什么', Q).level, 1);
  /* q.answer 缺失：无从判泄漏，原样 + gate no-reference */
  const rn = T.sanitizeHint(1, '算出来 x=3 就对了', Q_NO_ANS);
  assert.strictEqual(rn.gate, 'no-reference');
  assert.strictEqual(rn.redacted, false);
  assert.strictEqual(rn.text, '算出来 x=3 就对了');
  /* L3 优先：即使没有参考答案，L3 也原样（reveal）*/
  const r3n = T.sanitizeHint(3, '答案：先移项。', Q_NO_ANS);
  assert.strictEqual(r3n.gate, 'reveal');
});

/* ================= 7. 单一真源 + chip 请求 ================= */

test('llm-config：maxTokens.tutor / timeouts.tutor 存在且为正数', function () {
  assert.strictEqual(typeof Cfg.maxTokens.tutor, 'number', 'maxTokens.tutor 应为数字');
  assert.ok(Cfg.maxTokens.tutor > 0);
  assert.strictEqual(typeof Cfg.timeouts.tutor, 'number', 'timeouts.tutor 应为数字');
  assert.ok(Cfg.timeouts.tutor > 0);
});

testAsync('why_step 请求体：max_tokens=maxTokens.tutor、response_format=json_object、system 含 schema 字段名', async () => {
  const X = loadExplain();
  const T = X._tutor;
  const m = stubFetch(JSON.stringify({ text: '去括号时 2 要乘进去：2x-6，这一步就是分配律。' }));
  try {
    const res = await X.runChip('why_step', makeCtx(T));
    assert.strictEqual(res.ok, true, JSON.stringify(res));
    assert.strictEqual(res.from, 'llm');
    assert.strictEqual(res.action, 'why_step');
    assert.strictEqual(m.calls.length, 1);
    const body = m.calls[0];
    assert.strictEqual(body.max_tokens, Cfg.maxTokens.tutor, 'max_tokens 必须取自 llm-config.maxTokens.tutor');
    assert.strictEqual(body.response_format.type, 'json_object');
    assert.ok(body.messages[0].content.indexOf('text') >= 0, 'why_step 的 system 应写明 schema 字段 text');
    assert.ok(body.messages[1].content.indexOf(Q.prompt) >= 0, 'user 消息应带题干');
    assert.strictEqual(res.payload.text, '去括号时 2 要乘进去：2x-6，这一步就是分配律。');
  } finally { m.restore(); }
});

testAsync('why_step：text 超 120 字截断到 120 字 + 「…」', async () => {
  const X = loadExplain();
  const T = X._tutor;
  const long = [];
  for (let i = 0; i < 130; i++) long.push('字');
  const m = stubFetch(JSON.stringify({ text: long.join('') }));
  try {
    const res = await X.runChip('why_step', makeCtx(T));
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.payload.text.length, 121, '应为 120 字 + 省略号');
    assert.strictEqual(res.payload.text.charAt(120), '…');
  } finally { m.restore(); }
});

testAsync('judge_mine：conclusion 由本地判解决定；unverified 时模型文本的结论词被替换', async () => {
  const X = loadExplain();
  const T = X._tutor;
  /* 对照组：solution 有明确最终答案且正确 → conclusion correct，模型文本原样 */
  let m = stubFetch(JSON.stringify({ firstError: '', explain: '你答对了，移项忘了变号。' }));
  try {
    const res = await X.runChip('judge_mine', makeCtx(T, { solution: '答案：x=3' }));
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.payload.conclusion, 'correct');
    assert.strictEqual(res.payload.verified, true);
    assert.strictEqual(res.payload.text, '你答对了，移项忘了变号。', 'correct 情形不改模型文本');
    assert.strictEqual(res.payload.verdict.cls, 'ask-verdict ok');
    assert.ok(m.calls[0].messages[0].content.indexOf('firstError') >= 0, 'judge_mine 的 system 应写明 schema 字段 firstError');
  } finally { m.restore(); }
  /* 无最终答案 → unverified：模型说了结论也不算，结论词替换掉 */
  m = stubFetch(JSON.stringify({ firstError: '', explain: '你答对了，移项忘了变号。' }));
  try {
    const res = await X.runChip('judge_mine', makeCtx(T, { solution: '先去括号：2x-6=4-x。' }));
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.payload.conclusion, 'unverified');
    assert.strictEqual(res.payload.verified, false);
    assert.ok(res.payload.text.indexOf('答对了') < 0, 'unverified 不得说「答对了」');
    assert.ok(res.payload.text.indexOf('这里先不下结论') >= 0, '结论词应替换为「这里先不下结论」');
    assert.strictEqual(res.payload.verdict.cls, 'ask-verdict unverified');
  } finally { m.restore(); }
});

testAsync('hint_leveled：system 含 L1/L2/L3 分级规则；返回必过 sanitizeHint（泄漏被兜底替换）', async () => {
  const X = loadExplain();
  const T = X._tutor;
  const m = stubFetch(JSON.stringify({ text: '答案就是 x=3，直接写上。' }));
  try {
    const res = await X.runChip('hint_leveled', makeCtx(T, { level: 1 }));
    assert.strictEqual(res.ok, true);
    assert.strictEqual(m.calls.length, 1);
    const body = m.calls[0];
    assert.strictEqual(body.max_tokens, Cfg.maxTokens.tutor);
    const sys = body.messages[0].content;
    assert.ok(sys.indexOf('text') >= 0, 'hint_leveled 的 system 应写明 schema 字段 text');
    assert.ok(sys.indexOf('L1') >= 0 && sys.indexOf('L2') >= 0 && sys.indexOf('L3') >= 0, 'system 应含 L1/L2/L3 分级规则字样');
    /* 模型不听话把答案写进 L1：代码侧必须兜底替换 */
    assert.strictEqual(res.payload.level, 1);
    assert.strictEqual(res.payload.leaked, true);
    assert.strictEqual(res.payload.redacted, true);
    assert.ok(res.payload.text.indexOf('3') < 0, 'L1 兜底文案不得含答案数值：' + res.payload.text);
  } finally { m.restore(); }
});

testAsync('runChip 失败：llm 坏 JSON → badjson 文案，永不 reject', async () => {
  const X = loadExplain();
  const T = X._tutor;
  const m = stubFetch('这不是 JSON');
  try {
    const res = await X.runChip('why_step', makeCtx(T));
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.from, 'none');
    assert.strictEqual(res.reason, 'llm');
    assert.ok(typeof res.notice === 'string' && res.notice.length > 0);
    assert.ok(res.notice.indexOf('没按格式来') >= 0, 'badjson 应走既有文案：' + res.notice);
  } finally { m.restore(); }
});

(async function main() {
  for (const t of asyncTests) {
    try { await t.fn(); passed++; console.log('  ok   ' + t.name); }
    catch (e) { failed++; console.log('  FAIL ' + t.name + '\n       ' + (e && e.stack || e).split('\n').slice(0, 6).join('\n       ')); }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
