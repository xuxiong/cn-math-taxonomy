#!/usr/bin/env node
/* LLM 讲解（diagnose/explain.js）的画板接线测试：node tests/test_explain.js
 *
 * t_85395e07「AI 讲解看到画板」专项：
 *   1. userPrompt / askUserPrompt：有 labDesc 时在「知识点」之后、「学生答案」之前插入「画板：」行；
 *      无 / 空串 / undefined → 不出现「画板：」。
 *   2. systemPrompt / askSystemPrompt：包含针对「画板上留白量 / 图上元素」的约束句。
 *   3. 缓存隔离：同一题 有/无 画板 两次 generate 不得互相命中（key = q.id + '|' + 有无画板）。
 *   4. ask 第 6 个参数 labDesc 透传到 llmAsk 的 user 消息。
 *   5. max_tokens 契约：讲解 2048 / 追问 4096（与 test_engine.js 一致，防止回落到不够的 1024/2048）。
 *
 * 说明：与 test_engine.js 一样，Node 下跑需要把 engine.js 装成 window.DiagEngine。
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
  g.Funclab = F;   // askSystemPrompt 的能力清单运行时从 global.Funclab 读取
  delete require.cache[require.resolve('../diagnose/explain.js')];
  require('../diagnose/explain.js');
  return g.Explain;
}

/* 简单的 topic 与题目（真实题面在题库里，这里只验证 prompt 拼装与缓存契约） */
const T = { id: 'cnm_043', name: '含括号的一元一次方程', chapter: '七上 第五章 5.2', type: 'procedural' };
const Q = { id: 'lab-board-1', type: 'numeric', prompt: '解方程 2(x-3)=4-(x+1)。', answer: '3' };
const DESC = '画板：⊙O 中的弦与弦心距\n- 蓝色实线圆：以 O 为圆心的圆\n- 留白说明：弦心距 OH 等推导量在图上以 ? 表示';

/* ---- 1. userPrompt / askUserPrompt 的画板行 ---- */
test('userPrompt：无画板 → 不含「画板：」', function () {
  const X = loadExplain();
  [undefined, null, ''].forEach(function (labDesc) {
    const p = X._userPrompt(T, Q, '1', labDesc);
    assert.ok(p.indexOf('画板：') < 0, 'labDesc=' + JSON.stringify(labDesc) + ' 不应有画板行\n' + p);
  });
});

test('userPrompt：有画板 → 画板行在知识点之后、学生答案之前', function () {
  const X = loadExplain();
  const p = X._userPrompt(T, Q, '1', DESC);
  assert.ok(p.indexOf('画板：' + DESC) >= 0, '应含完整画板行\n' + p);
  assert.ok(p.indexOf('知识点：') < p.indexOf('画板：'), '画板行应在知识点之后');
  assert.ok(p.indexOf('画板：') < p.indexOf('学生答案：'), '画板行应在学生答案之前');
});

test('askUserPrompt：无画板 → 不含「画板：」', function () {
  const X = loadExplain();
  const steps = [{ kind: 'reveal', text: '第一步先想移项。' }];
  [undefined, null, ''].forEach(function (labDesc) {
    const p = X._askUserPrompt(T, Q, '1', steps, '什么叫移项？', labDesc);
    assert.ok(p.indexOf('画板：') < 0, 'labDesc=' + JSON.stringify(labDesc) + ' 不应有画板行\n' + p);
  });
});

test('askUserPrompt：有画板 → 画板行在知识点之后、学生答案之前', function () {
  const X = loadExplain();
  const steps = [{ kind: 'reveal', text: '第一步先想移项。' }];
  const p = X._askUserPrompt(T, Q, '1', steps, '什么叫移项？', DESC);
  assert.ok(p.indexOf('画板：' + DESC) >= 0, '应含完整画板行\n' + p);
  assert.ok(p.indexOf('知识点：') < p.indexOf('画板：'), '画板行应在知识点之后');
  assert.ok(p.indexOf('画板：') < p.indexOf('学生答案：'), '画板行应在学生答案之前');
});

/* ---- 2. 两条系统提示词的画板约束句 ---- */
test('systemPrompt：含「画板上刻意留白的量…不许说出数值」硬规则', function () {
  const X = loadExplain();
  const s = X._systemPrompt();
  assert.ok(s.indexOf('画板上刻意留白的量') >= 0, 'systemPrompt 应说明留白量不许说出数值');
  assert.ok(s.indexOf('不许') >= 0, 'systemPrompt 应含「不许」');
});

test('askSystemPrompt：含「以画板描述为准」与「虚线还是实线」约束', function () {
  const X = loadExplain();
  const s = X._askSystemPrompt();
  assert.ok(s.indexOf('以「画板」这段描述为准') >= 0, 'askSystemPrompt 应要求以画板描述为准');
  assert.ok(s.indexOf('虚线还是实线') >= 0, 'askSystemPrompt 应约束虚线/实线照描述说');
});

test('askSystemPrompt：追问侧也必须有「画板留白量不许说出数值」硬规则', function () {
  /* 回归锁（t_85395e07 实测）：这条规则原先只加在 systemPrompt()（三步讲解）里，
   * 追问走的是 askSystemPrompt()，结果学生问「顶点坐标是多少」AI 直接答 (-1,-4)。
   * 两条链路都必须带这条规则，否则「留白不剧透」在被追问时整个失效。 */
  const X = loadExplain();
  const s = X._askSystemPrompt();
  assert.ok(s.indexOf('画板上刻意留白的量') >= 0, 'askSystemPrompt 应含「画板上刻意留白的量」');
  assert.ok(s.indexOf('不许你直接说出数值') >= 0, 'askSystemPrompt 应明确不许说出数值');
  assert.ok(s.indexOf('标准解析') >= 0, 'askSystemPrompt 应说明即使标准解析里有这个数也不许读出');
});

test('askSystemPrompt：含 JSON 协议（text / graph 两个字段）', function () {
  const X = loadExplain();
  const s = X._askSystemPrompt();
  assert.ok(s.indexOf('JSON') >= 0, '应说明输出 JSON');
  assert.ok(s.indexOf('text') >= 0, 'JSON 应含 text 字段');
  assert.ok(s.indexOf('graph') >= 0, 'JSON 应含 graph 字段');
});

test('askSystemPrompt：拼进 Funclab.CAPABILITIES 的能力清单', function () {
  const X = loadExplain();
  const s = X._askSystemPrompt();
  assert.ok(s.indexOf('quadratic-vertex') >= 0, '能力清单应含 quadratic-vertex');
  assert.ok(s.indexOf('linear-intercepts') >= 0, '能力清单应含另一个画板（linear-intercepts）');
});

test('askSystemPrompt：新图同样不许在 text 里说出具体数值', function () {
  const X = loadExplain();
  const s = X._askSystemPrompt();
  assert.ok(s.indexOf('说出具体数值') >= 0, '应约束顶点/最值不许在正文里说出具体数值');
});

/* ---- 3 & 5. 缓存隔离 + max_tokens 契约 + ask 透传（异步，mock fetch） ---- */
function mockLLM(stepsContent, answerText) {
  const calls = [];
  const real = globalThis.fetch;
  const body = { choices: [{ message: { content: stepsContent } }] };
  globalThis.fetch = function (url, opts) {
    const req = JSON.parse(opts.body);
    calls.push(req);
    return Promise.resolve({ ok: true, json: function () { return Promise.resolve(body); } });
  };
  return { restore: function () { globalThis.fetch = real; }, calls: calls };
}

testAsync('generate：讲解请求 max_tokens=2048，且带画板时 user 消息含画板行', async () => {
  const X = loadExplain();
  X._cache.clear();
  const reveal = '去括号得2x-6=4-x-1，移项合并得3x=9，所以x=3。答案：x = 3';
  const m = mockLLM(JSON.stringify({ prompt: '先想想怎么去括号？', hint: '注意符号要变号。', reveal: reveal }), '3');
  try {
    await X.generate(T, Q, '1', DESC);
    assert.strictEqual(m.calls.length, 1, '应恰好发起一次讲解请求');
    const req = m.calls[0];
    assert.strictEqual(req.max_tokens, 2048, '讲解 max_tokens 应为 2048');
    assert.strictEqual(req.messages[0].role, 'system');
    assert.ok(req.messages[1].content.indexOf('画板：' + DESC) >= 0, 'user 消息应含画板行');
    assert.ok(req.messages[1].content.indexOf('画板：') < req.messages[1].content.indexOf('学生答案：'), '画板行应在学生答案之前');
  } finally { m.restore(); }
});

testAsync('缓存隔离：同一题 有/无画板 两次 generate 不互相命中', async () => {
  const X = loadExplain();
  X._cache.clear();
  const reveal = '去括号得2x-6=4-x-1，移项合并得3x=9，所以x=3。答案：x = 3';
  const m = mockLLM(JSON.stringify({ prompt: '先想想怎么去括号？', hint: '注意符号要变号。', reveal: reveal }), '3');
  try {
    await X.generate(T, Q, '1', null);        // ckey = 'lab-board-1|0'
    await X.generate(T, Q, '1', DESC);        // ckey = 'lab-board-1|1' —— 必须真的再发一次
    assert.strictEqual(m.calls.length, 2, '有/无画板两次 generate 应各发一次请求（不得互相命中）');
    assert.ok(m.calls[0].messages[1].content.indexOf('画板：') < 0, '无画板的请求不应含画板行');
    assert.ok(m.calls[1].messages[1].content.indexOf('画板：') >= 0, '有画板的请求应含画板行');
  } finally { m.restore(); }
});

testAsync('ask：追问请求 max_tokens=4096（JSON 输出 + reasoning 长尾，JSON 比纯文本多吃 token），且第 6 参 labDesc 透传到 user 消息', async () => {
  const X = loadExplain();
  const steps = [{ kind: 'hint', text: '移项要变号。' }];
  const m = mockLLM('移项就是把项从一边挪到另一边，注意变号。', null);
  try {
    const r = await X.ask(T, Q, '1', steps, '什么叫移项？', DESC);
    assert.strictEqual(r.from, 'llm');
    assert.strictEqual(m.calls.length, 1, '应恰好发起一次追问请求');
    const req = m.calls[0];
    assert.strictEqual(req.max_tokens, 4096, '追问 max_tokens 应为 4096（防止回落到不够的 1024/2048：JSON 被 reasoning 吃光后 content 为空）');
    assert.deepStrictEqual(req.response_format, { type: 'json_object' }, '追问应要求 JSON 对象输出');
    assert.ok(req.messages[1].content.indexOf('画板：' + DESC) >= 0, '追问 user 消息应含画板行');
    assert.ok(req.messages[1].content.indexOf('学生的问题：什么叫移项？') >= 0, '追问内容应保留');
  } finally { m.restore(); }
});

testAsync('ask：无 labDesc（第 6 参不传）仍可正常追问（向后兼容）', async () => {
  const X = loadExplain();
  const steps = [{ kind: 'hint', text: '移项要变号。' }];
  const m = mockLLM('直接解释，不含画板。', null);
  try {
    const r = await X.ask(T, Q, '1', steps, '为什么去括号要变号？');
    assert.strictEqual(r.from, 'llm');
    assert.ok(m.calls[0].messages[1].content.indexOf('画板：') < 0, '不传 labDesc 不应有画板行');
  } finally { m.restore(); }
});

testAsync('ask：JSON 回答 graph=null → res.graph 为 null、正文正确', async () => {
  const X = loadExplain();
  const steps = [{ kind: 'hint', text: '移项要变号。' }];
  const m = mockLLM(JSON.stringify({ text: '移项就是把项从一边挪到另一边，注意变号。', graph: null }), null);
  try {
    const r = await X.ask(T, Q, '1', steps, '什么叫移项？');
    assert.strictEqual(r.from, 'llm');
    assert.strictEqual(r.graph, null);
    assert.strictEqual(r.text, '移项就是把项从一边挪到另一边，注意变号。');
  } finally { m.restore(); }
});

testAsync('ask：JSON 缺 graph 字段 → graph null，不抛', async () => {
  const X = loadExplain();
  const steps = [{ kind: 'hint', text: '移项要变号。' }];
  const m = mockLLM(JSON.stringify({ text: '先去括号，再移项。' }), null);
  try {
    const r = await X.ask(T, Q, '1', steps, '怎么算？');
    assert.strictEqual(r.from, 'llm');
    assert.strictEqual(r.graph, null);
    assert.strictEqual(r.text, '先去括号，再移项。');
  } finally { m.restore(); }
});

testAsync('ask：JSON 被截断（网关 token 截断）→ 不吐半截 JSON，只给 text 半句、graph=null', async () => {
  const X = loadExplain();
  const steps = [{ kind: 'hint', text: '先看开口方向。' }];
  const m = mockLLM('{"text":"你问得很好，y=x²+3 的顶点', null);
  try {
    const r = await X.ask(T, Q, '1', steps, '顶点在哪里？');
    assert.strictEqual(r.from, 'llm');
    assert.strictEqual(r.graph, null);
    assert.ok(r.text.indexOf('你问得很好') === 0, '正文应是抠出的 text 半句');
    assert.ok(r.text.indexOf('"text"') < 0, '不得残留 "text" 字段名');
    assert.ok(r.text.indexOf('{') < 0, '不得残留 JSON 花括号');
    assert.ok(r.text.indexOf('graph') < 0, '不得出现 graph');
  } finally { m.restore(); }
});

testAsync('ask：JSON 带 graph → res.graph 原样透出（结构不丢）', async () => {
  const X = loadExplain();
  const steps = [{ kind: 'hint', text: '先看开口方向。' }];
  const g = { type: 'quadratic', lab: 'quadratic-vertex', intent: '最小值', params: { a: 1, h: 0, k: 3 } };
  const m = mockLLM(JSON.stringify({ text: '我画了一条抛物线，你看图。', graph: g }), null);
  try {
    const r = await X.ask(T, Q, '1', steps, '画个图看看');
    assert.strictEqual(r.from, 'llm');
    assert.deepStrictEqual(r.graph, g);
  } finally { m.restore(); }
});

/* ---- 4. 超时（t_b30f8c7c）：两处 fetch 都接 AbortController，网络挂起不再永远等 ---- */
const LLMCFG = require('../diagnose/llm-config.js');

/* 假 AbortError（浏览器里是 DOMException，Node 里用 Error + name 等价） */
function abortError() {
  const e = new Error('The operation was aborted.');
  e.name = 'AbortError';
  return e;
}

/* 永不 resolve 的 fetch：只在 signal abort 时 reject AbortError（模拟代理半开 / Provider 不返回） */
function hangingFetch(state) {
  const real = globalThis.fetch;
  globalThis.fetch = function (url, opts) {
    state.calls++;
    state.signals.push(opts && opts.signal);
    return new Promise(function (_resolve, reject) {
      const sig = opts && opts.signal;
      if (!sig) return;   // 没有 signal 就永远挂着（超时没接上时测试会超时失败）
      sig.addEventListener('abort', function () { state.aborted++; reject(abortError()); });
    });
  };
  return function () { globalThis.fetch = real; };
}

/* 临时把配置里的超时调小（不真等 30s） */
function withChatTimeout(ms) {
  const real = LLMCFG.timeouts.chat;
  LLMCFG.timeouts.chat = ms;
  return function () { LLMCFG.timeouts.chat = real; };
}

const QT = { id: 'timeout-q1', type: 'numeric', prompt: '解方程 x+2=5。', answer: '3' };

testAsync('generate：fetch 永不 resolve → 在配置的超时 + 500ms 内返回失败结果（不永远 pending）', async () => {
  const X = loadExplain();
  X._cache.clear();
  const TIMEOUT = 120;
  const restoreCfg = withChatTimeout(TIMEOUT);
  const state = { calls: 0, aborted: 0, signals: [] };
  const restoreFetch = hangingFetch(state);
  const t0 = Date.now();
  try {
    const r = await X.generate(T, QT, '1');
    const dt = Date.now() - t0;
    assert.ok(dt <= TIMEOUT + 500, '应在配置超时 + 500ms 内返回，实际 ' + dt + 'ms');
    assert.strictEqual(r.from, 'static', '超时应回退静态讲解（永不 reject）');
    assert.strictEqual(r.reason, 'timeout', '超时的 reason 应为 timeout');
    assert.ok(r.notice && r.notice.indexOf('重试') >= 0 && r.notice.indexOf('看答案') >= 0,
      '超时文案应可操作（重试 / 看答案），实际：' + r.notice);
    assert.deepStrictEqual(r.steps, E.socraticSteps(T, QT), '失败仍给静态三步，不是空内容');
    assert.strictEqual(state.calls, 1, '不应自动重试（总时长以配置超时为界）');
    assert.strictEqual(state.aborted, 1, '定时器到点应 abort 一次');
    assert.ok(state.signals[0] && typeof state.signals[0].addEventListener === 'function',
      'fetch 必须收到 AbortSignal');
  } finally { restoreFetch(); restoreCfg(); }
});

testAsync('generate：fetch 直接以 AbortError 拒绝 → 走既有失败分支，文案与普通网络失败一致', async () => {
  const X = loadExplain();
  const real = globalThis.fetch;
  try {
    X._cache.clear();
    globalThis.fetch = function () { return Promise.reject(abortError()); };
    const aborted = await X.generate(T, { id: 'abort-q1', type: 'numeric', prompt: 'x+2=5', answer: '3' }, '1');

    X._cache.clear();
    globalThis.fetch = function () { return Promise.reject(new Error('econnrefused')); };
    const netfail = await X.generate(T, { id: 'net-q1', type: 'numeric', prompt: 'x+2=5', answer: '3' }, '1');

    assert.strictEqual(aborted.from, 'static', 'AbortError 应回退静态讲解');
    assert.strictEqual(aborted.reason, 'timeout', 'AbortError 的 reason 应为 timeout');
    assert.strictEqual(netfail.from, 'static', '网络错误仍回退静态讲解');
    assert.strictEqual(netfail.reason, 'network', '网络错误的 reason 应为 network');
    assert.strictEqual(aborted.notice, netfail.notice, 'aborted 与网络失败的文案必须一致');
    assert.ok(aborted.notice.indexOf('重试') >= 0, '文案应可操作');
  } finally { globalThis.fetch = real; }
});

testAsync('ask（追问）：fetch 永不 resolve → 超时后返回 offline 失败、不 reject、文案同一条', async () => {
  const X = loadExplain();
  const TIMEOUT = 120;
  const restoreCfg = withChatTimeout(TIMEOUT);
  const state = { calls: 0, aborted: 0, signals: [] };
  const restoreFetch = hangingFetch(state);
  const steps = [{ kind: 'hint', text: '移项要变号。' }];
  const t0 = Date.now();
  try {
    const r = await X.ask(T, QT, '1', steps, '什么叫移项？');
    const dt = Date.now() - t0;
    assert.ok(dt <= TIMEOUT + 500, '追问也应在配置超时 + 500ms 内返回，实际 ' + dt + 'ms');
    assert.strictEqual(r.from, 'offline', '追问超时应走既有 offline 分支');
    assert.strictEqual(r.text, null, '超时不得当成空内容渲染');
    assert.strictEqual(r.graph, null);
    assert.strictEqual(r.reason, 'timeout', '追问超时的 reason 应为 timeout');
    assert.ok(r.notice && r.notice.indexOf('重试') >= 0, '追问超时也要给可操作文案，实际：' + r.notice);
    assert.strictEqual(state.aborted, 1, '追问的第二处 fetch 同样要接 AbortController');
  } finally { restoreFetch(); restoreCfg(); }
});

(async function main() {
  for (const t of asyncTests) {
    try { await t.fn(); passed++; console.log('  ok   ' + t.name); }
    catch (e) { failed++; console.log('  FAIL ' + t.name + '\n       ' + (e && e.stack || e).split('\n').slice(0, 6).join('\n       ')); }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();