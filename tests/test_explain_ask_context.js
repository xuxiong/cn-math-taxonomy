#!/usr/bin/env node
/* 追问 prompt 的身份收敛 + 能力清单适用范围 + 最近 2 轮历史（diagnose/explain.js）
 *
 * node tests/test_explain_ask_context.js
 *
 * 覆盖：
 *   1. askSystemPrompt 的规则 9 / 12 已收敛到「只能是本题这个函数」。
 *   2. 能力清单每行带 Funclab.CAPABILITIES[lab].note（运行时取，不在 explain.js 写死）。
 *   3. note 压平并截到 60 字（含「…」时最多 61 字符）。
 *   4~8. history 段落：只取最近 2 轮、跳过空答 / pending、q/a 各截 200 字、缺省不出现。
 *   9. ask() 第 7 参 history 透传到请求体。
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

function loadExplain() {
  const g = globalThis;
  g.window = g;
  g.DiagEngine = E;
  g.Funclab = F;   // 能力清单运行时从 global.Funclab 读取
  delete require.cache[require.resolve('../diagnose/explain.js')];
  require('../diagnose/explain.js');
  return g.Explain;
}

const T = { id: 'cnm_043', name: '含括号的一元一次方程', chapter: '七上 第五章 5.2', type: 'procedural' };
const Q = { id: 'ask-ctx-1', type: 'numeric', prompt: '解方程 2(x-3)=4-(x+1)。', answer: '3' };
const DESC = '画板：⊙O 中的弦与弦心距\n- 蓝色实线圆：以 O 为圆心的圆';
const STEPS = [{ kind: 'hint', text: '移项要变号。' }];

function noWs(s) { return String(s || '').replace(/\s+/g, ''); }

/* ---- 1. 规则收敛 ---- */
test('askSystemPrompt：身份规则为「只能是本题这个函数 / 只允许改参数值」', function () {
  const X = loadExplain();
  const s = X._askSystemPrompt();
  assert.ok(s.indexOf('只能是本题这个函数') >= 0, '规则 12 应锁定本题函数\n' + s);
  assert.ok(s.indexOf('只允许改参数值') >= 0, '应只允许改参数值');
  assert.ok(s.indexOf('照样要给 graph') < 0, '不得再出现「照样要给 graph」');
  assert.ok(s.indexOf('学生问的是题面之外的函数时') < 0, '不得再出现「可以给新函数 graph」的旧表述');
  assert.ok(s.indexOf('说出具体数值') >= 0, '规则 10 仍须保留「说出具体数值」');
  assert.ok(s.indexOf('以「画板」这段描述为准') >= 0, '规则 7 必须一字不改地保留');
  assert.ok(s.indexOf('虚线还是实线') >= 0, '规则 7 必须一字不改地保留');
  assert.ok(s.indexOf('画板上刻意留白的量') >= 0, '规则 8 必须一字不改地保留');
});

/* ---- 2. 能力清单带适用范围（note 运行时取自 Funclab） ---- */
test('能力清单：21 个 lab 都带「；适用：」且 note 前 20 字出现在 prompt', function () {
  const X = loadExplain();
  const s = X._askSystemPrompt();
  const sNoWs = noWs(s);
  const labs = Object.keys(F.CAPABILITIES);
  assert.strictEqual(labs.length, 21, '能力清单应正好 21 个 lab');
  let scopeCount = 0;
  let i = 0;
  while ((i = s.indexOf('；适用：', i)) >= 0) { scopeCount++; i += 4; }
  assert.strictEqual(scopeCount, 21, '21 个 lab 每行都应带「；适用：」，实际 ' + scopeCount);
  labs.forEach(function (lab) {
    const note = String((F.CAPABILITIES[lab] || {}).note || '');
    assert.ok(note.length > 0, lab + ' 应有 note');
    const head = noWs(note).slice(0, 20);
    assert.ok(sNoWs.indexOf(head) >= 0, lab + ' 的 note 前 20 字应出现在能力清单里：' + head);
  });
});

/* ---- 3. note 截断到 60 字（+「…」最多 61） ---- */
test('能力清单：每个「适用：」段长度 <= 61', function () {
  const X = loadExplain();
  const lines = X._askSystemPrompt().split('\n');
  lines.forEach(function (line) {
    const idx = line.indexOf('；适用：');
    if (idx < 0) return;
    const seg = line.slice(idx + '；适用：'.length);
    assert.ok(seg.length <= 61, '「适用：」段超长（' + seg.length + '）：' + seg);
  });
});

/* ---- 4. 历史 3 轮只取后 2 轮 ---- */
test('askUserPrompt：历史 3 轮只带后 2 轮，且标题正确', function () {
  const X = loadExplain();
  const hist = [
    { q: '最早问题AAA', a: '最早答案AAA' },
    { q: '第二问题BBB', a: '第二答案BBB' },
    { q: '第三问题CCC', a: '第三答案CCC' }
  ];
  const p = X._askUserPrompt(T, Q, '1', STEPS, '那 tan 呢', DESC, hist);
  assert.ok(p.indexOf('历史问答（最近 2 轮）') >= 0, '应出现历史段落标题\n' + p);
  assert.ok(p.indexOf('最早问题AAA') < 0, '不应带最早那一轮的问题');
  assert.ok(p.indexOf('最早答案AAA') < 0, '不应带最早那一轮的答案');
  assert.ok(p.indexOf('第二问题BBB') >= 0, '应带第 2 轮问题');
  assert.ok(p.indexOf('第二答案BBB') >= 0, '应带第 2 轮答案');
  assert.ok(p.indexOf('第三问题CCC') >= 0, '应带第 3 轮问题');
  assert.ok(p.indexOf('第三答案CCC') >= 0, '应带第 3 轮答案');
  assert.ok(p.indexOf('历史问答') > p.indexOf('当前讲解进度'), '历史应在讲解进度之后');
  assert.ok(p.indexOf('历史问答') < p.indexOf('学生的问题：'), '历史应在本轮问题之前');
});

/* ---- 5. 历史 1 轮 ---- */
test('askUserPrompt：历史 1 轮只出现 1 轮且没有分隔线', function () {
  const X = loadExplain();
  const p = X._askUserPrompt(T, Q, '1', STEPS, '那 tan 呢', DESC, [{ q: '唯一问题DDD', a: '唯一答案DDD' }]);
  assert.ok(p.indexOf('唯一问题DDD') >= 0);
  assert.ok(p.indexOf('唯一答案DDD') >= 0);
  assert.strictEqual((p.match(/学生：/g) || []).length, 1, '应恰好 1 个「学生：」');
  assert.strictEqual((p.match(/老师：/g) || []).length, 1, '应恰好 1 个「老师：」');
  assert.ok(p.indexOf('---') < 0, '只有 1 轮时不应出现分隔线');
});

/* ---- 6. 缺省第 7 参：整段不出现 ---- */
test('askUserPrompt：缺省 history（向后兼容）不含历史段落', function () {
  const X = loadExplain();
  [undefined, null, []].forEach(function (hist) {
    const p = X._askUserPrompt(T, Q, '1', STEPS, '那 tan 呢', DESC, hist);
    assert.ok(p.indexOf('历史问答') < 0, 'hist=' + JSON.stringify(hist) + ' 不应有历史段落\n' + p);
  });
});

/* ---- 7. 空答 / pending 的轮次被跳过 ---- */
test('askUserPrompt：a 为空 / pending 的轮次被跳过', function () {
  const X = loadExplain();
  const p = X._askUserPrompt(T, Q, '1', STEPS, '继续', DESC, [
    { q: '问A', a: '' },
    { q: '问B', a: '答B' },
    { q: '问C', a: '答C', pending: true }
  ]);
  assert.ok(p.indexOf('问B') >= 0, '应保留有正文的一轮');
  assert.ok(p.indexOf('答B') >= 0, '应保留有正文的一轮');
  assert.ok(p.indexOf('问A') < 0, '空答案的轮次应跳过');
  assert.ok(p.indexOf('问C') < 0, 'pending 的轮次应跳过');
  assert.strictEqual((p.match(/学生：/g) || []).length, 1, '只应剩 1 轮');
});

/* ---- 8. q / a 各截 200 字 ---- */
test('askUserPrompt：答案超过 200 字被截断并加「…」', function () {
  const X = loadExplain();
  const chars = [];
  for (let i = 0; i < 300; i++) chars.push(String.fromCharCode(0x4e00 + i));
  const a = chars.join('');
  const p = X._askUserPrompt(T, Q, '1', STEPS, '继续', DESC, [{ q: '长答案问题', a: a }]);
  assert.ok(p.indexOf(a.slice(0, 200)) >= 0, '应含前 200 字');
  assert.ok(p.indexOf(a.slice(249)) < 0, '不应含第 250 字之后的片段');
  assert.ok(p.indexOf('…') >= 0, '截断处应有省略号');
});

/* ---- 9. ask() 第 7 参透传 ---- */
function mockLLM(content) {
  const calls = [];
  const real = globalThis.fetch;
  const body = { choices: [{ message: { content: content } }] };
  globalThis.fetch = function (url, opts) {
    calls.push(JSON.parse(opts.body));
    return Promise.resolve({ ok: true, json: function () { return Promise.resolve(body); } });
  };
  return { restore: function () { globalThis.fetch = real; }, calls: calls };
}

testAsync('ask：第 7 参 history 透传到 user 消息；缺省时不带历史', async () => {
  const X = loadExplain();
  const content = JSON.stringify({ text: '好的', graph: null });
  let m = mockLLM(content);
  try {
    const r = await X.ask(T, Q, '1', STEPS, '追问', DESC, [{ q: '上一问', a: '上一答' }]);
    assert.strictEqual(r.from, 'llm');
    assert.strictEqual(m.calls.length, 1);
    const msg = m.calls[0].messages[1].content;
    assert.ok(msg.indexOf('上一问') >= 0, '请求应含上一轮问题');
    assert.ok(msg.indexOf('上一答') >= 0, '请求应含上一轮答案');
    assert.ok(msg.indexOf('历史问答（最近 2 轮）') >= 0, '请求应含历史段落标题');
  } finally { m.restore(); }

  m = mockLLM(content);
  try {
    await X.ask(T, Q, '1', STEPS, '追问', DESC);
    assert.ok(m.calls[0].messages[1].content.indexOf('历史问答') < 0, '不传 history 不应出现历史段落');
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
