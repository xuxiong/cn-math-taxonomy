#!/usr/bin/env node
/* 高中函数画板 批3：指数 / 对数 / 幂根式三族 —— 第 1 段（解析 + 答案门禁）
 *   node tests/test_funclab_hs_batch3.js
 *
 * 本文件当前只锁「解析层 + 答案语义门禁」：
 *   · 7 题实面的 fromPrompt 结果（题面从 data/questions.json 实取，不臆造）；
 *   · 三族正向形态全表（含参数逐项 deepStrictEqual）；
 *   · 三族反例一律 null，x / x² / x³ 交回既有通道；
 *   · 既有一次 / 二次 / 反比例 / 三角 / 隐式直线代表题结果逐字不变；
 *   · answer-gate 的 exp / log / power 标注集合、READABLE_BY_TYPE 分档、
 *     7 题 misfitOf 全 null、31 条 misleading 仍全挡、cnm_h221_q2 被挡下。
 * 画板注册 / 文案 / paintModel / verifyParams / mount 等属第 2 段，后续补齐。
 */
'use strict';
const assert = require('assert');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e).split('\n').slice(0, 8).join('\n       ')); }
}

const F = require('../diagnose/funclab.js');
const GATE = require('./lib/answer-gate.js');
const QUESTIONS = require('../data/questions.json');
const QMAP = new Map(QUESTIONS.map(function (x) { return [x.id, x]; }));
function q(id) {
  const item = QMAP.get(id);
  assert.ok(item, '题库里找不到题目 ' + id);
  return item;
}

/* 7 题台账（族 / 画板 / intent 见任务书 §2；本段只用到族与题面） */
const LEDGER = [
  { id: 'cnm_h029_q4', type: 'exp' },
  { id: 'cnm_h042_q1', type: 'exp' },
  { id: 'cnm_h042_q2', type: 'exp' },
  { id: 'cnm_h046_q2', type: 'log' },
  { id: 'cnm_h046_q4', type: 'log' },
  { id: 'cnm_h047_q1', type: 'log' },
  { id: 'cnm_h047_q2', type: 'log' }
];

/* 测算判 misleading 的 31 条（与批1/批2 同一张闸门清单） */
const MISLEADING = [
  'cnm_h027_q4', 'cnm_h029_q3', 'cnm_h032_q3', 'cnm_h033_q1', 'cnm_h033_q2', 'cnm_h033_q3',
  'cnm_h035_q3', 'cnm_h035_q4', 'cnm_h049_q3', 'cnm_h069_q4',
  'cnm_h216_q2', 'cnm_h217_q1', 'cnm_h217_q2', 'cnm_h218_q3', 'cnm_h219_q1',
  'cnm_h220_q1', 'cnm_h220_q2', 'cnm_h220_q3', 'cnm_h221_q1', 'cnm_h221_q2',
  'cnm_h222_q1', 'cnm_h222_q2', 'cnm_h222_q3', 'cnm_h223_q1', 'cnm_h223_q2',
  'cnm_h223_q3', 'cnm_h224_q1', 'cnm_h225_q2', 'cnm_h225_q3', 'cnm_h229_q1', 'cnm_h229_q3'
];

/* ================================================================
 * 0. 7 题实面：fromPrompt 认得出、类型与参数对得上
 * ================================================================ */

console.log('\n--- 0. 7 题实面 fromPrompt ---');

test('7 题实面逐题解析成 exp / log，参数逐项对上', function () {
  LEDGER.forEach(function (c) {
    const item = q(c.id);
    const p = F.fromPrompt(item.prompt);
    assert.ok(p, c.id + ' 应能解析（题面：' + item.prompt + '）');
    assert.strictEqual(p.type, c.type, c.id + ' 类型应为 ' + c.type);
  });
  /* 逐题参数（题面已知量） */
  assert.deepStrictEqual(F.fromPrompt(q('cnm_h029_q4').prompt),
    { type: 'exp', a: 1, base: 2, w: 1, phi: 0, k: 0 });
  assert.deepStrictEqual(F.fromPrompt(q('cnm_h042_q2').prompt),
    { type: 'exp', a: 1, base: 0.5, w: 1, phi: 0, k: 0 });
  assert.deepStrictEqual(F.fromPrompt(q('cnm_h046_q2').prompt),
    { type: 'log', c: 1, base: 2, shift: 0, d: 0 });
  assert.deepStrictEqual(F.fromPrompt(q('cnm_h047_q2').prompt),
    { type: 'log', c: 1, base: 0.5, shift: 0, d: 0 });
});

/* ================================================================
 * 5. fromPrompt 三族全表（题面实面 + 参数形态变体）
 * ================================================================ */

console.log('\n--- 5. 三族正向形态全表 ---');

test('指数族：底数 2 / (1/2) / 带 ω 与 φ 与 k', function () {
  assert.deepStrictEqual(F.fromPrompt('y=2^x'),
    { type: 'exp', a: 1, base: 2, w: 1, phi: 0, k: 0 });
  assert.deepStrictEqual(F.fromPrompt('y=(1/2)^x'),
    { type: 'exp', a: 1, base: 0.5, w: 1, phi: 0, k: 0 });
  assert.deepStrictEqual(F.fromPrompt('y=3^(2x-1)+1'),
    { type: 'exp', a: 1, base: 3, w: 2, phi: -1, k: 1 });
  assert.deepStrictEqual(F.fromPrompt('y=1/2^x'),
    { type: 'exp', a: 1, base: 0.5, w: 1, phi: 0, k: 0 });
});

test('对数族：log₂ / log_(1/2) / lg / ln / 真数平移与 d', function () {
  assert.deepStrictEqual(F.fromPrompt('y=log₂x'),
    { type: 'log', c: 1, base: 2, shift: 0, d: 0 });
  assert.deepStrictEqual(F.fromPrompt('y=log_(1/2) x'),
    { type: 'log', c: 1, base: 0.5, shift: 0, d: 0 });
  assert.deepStrictEqual(F.fromPrompt('y=lg x'),
    { type: 'log', c: 1, base: 10, shift: 0, d: 0 });
  assert.deepStrictEqual(F.fromPrompt('y=ln x'),
    { type: 'log', c: 1, base: Math.E, shift: 0, d: 0 });
  assert.deepStrictEqual(F.fromPrompt('y=log_2(x+1)-2'),
    { type: 'log', c: 1, base: 2, shift: 1, d: -2 });
  assert.deepStrictEqual(F.fromPrompt('y=log_{1/2}(x-3)'),
    { type: 'log', c: 1, base: 0.5, shift: -3, d: 0 });
});

test('幂族：x^4 / x^(-1) / x^(1/2) / x^0.5', function () {
  assert.deepStrictEqual(F.fromPrompt('y=x^4'), { type: 'power', a: 1, p: 4 });
  assert.deepStrictEqual(F.fromPrompt('y=x^(-1)'), { type: 'power', a: 1, p: -1 });
  assert.deepStrictEqual(F.fromPrompt('y=x^(1/2)'), { type: 'power', a: 1, p: 0.5 });
  assert.deepStrictEqual(F.fromPrompt('y=x^0.5'), { type: 'power', a: 1, p: 0.5 });
  assert.deepStrictEqual(F.fromPrompt('y=-2x^(-2)'), { type: 'power', a: -2, p: -2 });
});

test('根式族：√(x−1) / 2√(3x+1)-1 / sqrt 写法', function () {
  assert.deepStrictEqual(F.fromPrompt('y=√(x−1)'),
    { type: 'power', a: 1, root: { b: 1, c: -1 }, k: 0 });
  assert.deepStrictEqual(F.fromPrompt('y=2√(3x+1)-1'),
    { type: 'power', a: 2, root: { b: 3, c: 1 }, k: -1 });
  assert.deepStrictEqual(F.fromPrompt('y=sqrt(2x-3)+4'),
    { type: 'power', a: 1, root: { b: 2, c: -3 }, k: 4 });
});

test('f(x)= / g(x)= 前缀只在这三支内被容忍', function () {
  assert.deepStrictEqual(F.fromPrompt('f(x)=x^4。f\'(1) 等于多少？'),
    { type: 'power', a: 1, p: 4 });
  assert.deepStrictEqual(F.fromPrompt('g(x)=2^x'),
    { type: 'exp', a: 1, base: 2, w: 1, phi: 0, k: 0 });
  assert.deepStrictEqual(F.fromPrompt('f(x)=log₂x'),
    { type: 'log', c: 1, base: 2, shift: 0, d: 0 });
});

/* ================================================================
 * 6. 三族反例一律 null；x / x² / x³ 交回既有通道
 * ================================================================ */

console.log('\n--- 6. 三族反例 ---');

test('含参 / 叠幂 / 根号内非一次：一律 null（头匹配后不许掉进别的分支）', function () {
  ['y=ab^x', 'y=log_a x', 'y=2^x²', 'y=√(x²+1)', 'y=a√x'].forEach(function (s) {
    assert.strictEqual(F.fromPrompt(s), null, s + ' 应为 null，实际 ' + JSON.stringify(F.fromPrompt(s)));
  });
});

test('x / x² / x³ / x^2 交回既有通道（p∈{1,2,3} 不截走）', function () {
  assert.deepStrictEqual(F.fromPrompt('y=x'), { type: 'linear', k: 1, b: 0 });
  assert.deepStrictEqual(F.fromPrompt('y=x²'), { type: 'quadratic', a: 1, h: 0, k: 0 });
  assert.deepStrictEqual(F.fromPrompt('y=x^2'), { type: 'quadratic', a: 1, h: 0, k: 0 });
  assert.strictEqual(F.fromPrompt('y=x^3'), null);
});

/* ================================================================
 * 7. 既有语义零改动：一次 / 二次 / 反比例 / 三角 / 隐式直线代表题
 * ================================================================ */

console.log('\n--- 7. 既有语义零改动 ---');

test('代表题逐字不变（期望值取自基点 122df03 的实测结果）', function () {
  assert.deepStrictEqual(F.fromPrompt(q('cnm_h023_q4').prompt),
    { type: 'quadratic', a: 1, h: 0, k: 1 });
  assert.deepStrictEqual(F.fromPrompt(q('cnm_h066_q1').prompt),
    { type: 'trig', fn: 'sin', A: 1, w: 1, phi: 0, k: 0 });
  assert.deepStrictEqual(F.fromPrompt(q('cnm_h172_q1').prompt),
    { type: 'linear', k: -1, b: 5 });
  assert.deepStrictEqual(F.fromPrompt(q('cnm_029_q3').prompt),
    { type: 'quadratic', a: 3, h: 0.3333333333333333, k: 0.6666666666666667 });
  assert.deepStrictEqual(F.fromPrompt(q('cnm_029_q4').prompt),
    { type: 'linear', k: 0.5, b: -1.5 });
  assert.deepStrictEqual(F.fromPrompt('y=1/x'), { type: 'inverse', k: 1 });
  assert.deepStrictEqual(F.fromPrompt('x+y=5'), { type: 'linear', k: -1, b: 5 });
});

/* ================================================================
 * 13（门禁部分）. answer-gate 三族分支
 * ================================================================ */

console.log('\n--- 13. 答案语义门禁（exp / log / power 分支） ---');

test('annotationValues 的 exp 分支：k、y 轴截距、x=1 处函数值', function () {
  assert.deepStrictEqual(Array.from(GATE.annotationValues(F.fromPrompt('y=2^x'))).sort(),
    ['0', '1', '2']);
  assert.deepStrictEqual(Array.from(GATE.annotationValues(F.fromPrompt('y=3^(2x-1)+1'))).sort(),
    ['1', '1.333333', '4']);
});

test('annotationValues 的 log 分支：-shift、定点、-shift+base、c+d', function () {
  assert.deepStrictEqual(Array.from(GATE.annotationValues(F.fromPrompt('y=log_2(x+1)-2'))).sort(),
    ['-1', '-2', '0', '1']);
  assert.deepStrictEqual(Array.from(GATE.annotationValues(F.fromPrompt('y=log₂x'))).sort(),
    ['0', '1', '2']);
});

test('annotationValues 的 power 分支：多项式 0/1；根式 -c/b 与 k', function () {
  assert.deepStrictEqual(Array.from(GATE.annotationValues(F.fromPrompt('y=x^4'))).sort(),
    ['0', '1']);
  assert.deepStrictEqual(Array.from(GATE.annotationValues(F.fromPrompt('y=2√(3x+1)-1'))).sort(),
    ['-0.333333', '-1']);
});

test('READABLE_BY_TYPE 按画板分档，power 为空；READABLE_PROPERTY 未全局放宽', function () {
  assert.deepStrictEqual(Object.keys(GATE.READABLE_BY_TYPE).sort(), ['exp', 'log', 'power']);
  assert.strictEqual(GATE.READABLE_BY_TYPE.exp.length, 1);
  assert.strictEqual(GATE.READABLE_BY_TYPE.log.length, 1);
  assert.strictEqual(GATE.READABLE_BY_TYPE.power.length, 0);
  assert.ok(GATE.READABLE_BY_TYPE.exp[0].test('全体正实数'));
  assert.ok(GATE.READABLE_BY_TYPE.log[0].test('全体正实数'));
  assert.strictEqual(GATE.READABLE_BY_TYPE.exp[0].test('全体实数'), false);
  assert.strictEqual(GATE.READABLE_PROPERTY.test('全体正实数'), false,
    'READABLE_PROPERTY 不许被全局放宽（全体正实数只能按 exp/log 分档放行）');
});

test('7 题 misfitOf 全部 null（答案都能从画板语义读出）', function () {
  LEDGER.forEach(function (c) {
    const item = q(c.id);
    const p = F.fromPrompt(item.prompt);
    const why = GATE.misfitOf(item, p);
    assert.strictEqual(why, null, c.id + ' 应过门禁，实际：' + why);
  });
});

test('31 条 misleading 仍一条都过不了门禁', function () {
  const leaked = [];
  MISLEADING.forEach(function (id) {
    const item = q(id);
    let p = F.fromPrompt(item.prompt);
    if (!p && F.hsItemKind(id)) p = F.fromPrompt(F.hsPromptAlias(item.prompt));
    if (!p) return;                                  // 解析闸上游挡住，不算门禁漏过
    if (!GATE.misfitOf(item, p)) leaked.push(id);    // 门禁放行 = 漏过
  });
  assert.deepStrictEqual(leaked, [], '这些题被门禁放过了：' + leaked.join(','));
});

test('cnm_h221_q2 解析得出、被门禁挡下（不是解析不出）', function () {
  const item = q('cnm_h221_q2');
  const p = F.fromPrompt(item.prompt);
  assert.deepStrictEqual(p, { type: 'power', a: 1, p: 4 });
  const why = GATE.misfitOf(item, p);
  assert.ok(why, 'h221_q2 必须被门禁挡下');
  assert.ok(String(why).indexOf('∉') >= 0, '挡下原因应是「答案不属于画板标注」，实际：' + why);
});

/* ================================================================ */

console.log('\n== ' + passed + ' passed / ' + failed + ' failed ==');
process.exit(failed ? 1 : 0);
