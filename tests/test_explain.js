#!/usr/bin/env node
/* LLM 讲解（diagnose/explain.js）的画板接线测试：node tests/test_explain.js
 *
 * t_85395e07「AI 讲解看到画板」专项：
 *   1. userPrompt / askUserPrompt：有 labDesc 时在「知识点」之后、「学生答案」之前插入「画板：」行；
 *      无 / 空串 / undefined → 不出现「画板：」。
 *   2. systemPrompt / askSystemPrompt：包含针对「画板上留白量 / 图上元素」的约束句。
 *   3. 缓存隔离：同一题 有/无 画板 两次 generate 不得互相命中（key = q.id + '|' + 有无画板）。
 *   4. ask 第 6 个参数 labDesc 透传到 llmAsk 的 user 消息。
 *   5. max_tokens 契约：讲解 2048 / 追问 1024（与 test_engine.js 一致，防止误改）。
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

function loadExplain() {
  const g = globalThis;
  g.window = g;
  g.DiagEngine = E;
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

testAsync('ask：追问请求 max_tokens=1024，且第 6 参 labDesc 透传到 user 消息', async () => {
  const X = loadExplain();
  const steps = [{ kind: 'hint', text: '移项要变号。' }];
  const m = mockLLM('移项就是把项从一边挪到另一边，注意变号。', null);
  try {
    const r = await X.ask(T, Q, '1', steps, '什么叫移项？', DESC);
    assert.strictEqual(r.from, 'llm');
    assert.strictEqual(m.calls.length, 1, '应恰好发起一次追问请求');
    const req = m.calls[0];
    assert.strictEqual(req.max_tokens, 1024, '追问 max_tokens 应为 1024');
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

(async function main() {
  for (const t of asyncTests) {
    try { await t.fn(); passed++; console.log('  ok   ' + t.name); }
    catch (e) { failed++; console.log('  FAIL ' + t.name + '\n       ' + (e && e.stack || e).split('\n').slice(0, 6).join('\n       ')); }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();