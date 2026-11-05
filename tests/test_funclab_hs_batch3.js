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
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

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

test('x / x² / x^2 交回既有通道（p∈{1,2} 不截走；x³ 批4 归 cubic）', function () {
  assert.deepStrictEqual(F.fromPrompt('y=x'), { type: 'linear', k: 1, b: 0 });
  assert.deepStrictEqual(F.fromPrompt('y=x²'), { type: 'quadratic', a: 1, h: 0, k: 0 });
  assert.deepStrictEqual(F.fromPrompt('y=x^2'), { type: 'quadratic', a: 1, h: 0, k: 0 });
  /* 批4（t_34817311）：三次多项式独立成 cubic 族，不再交回 null。 */
  assert.deepStrictEqual(F.fromPrompt('y=x^3'), { type: 'cubic', a: 1, b: 0, c: 0, d: 0 });
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

/* ================================================================
 * 1. 白名单：HS_ITEMS 恰好 30 条，旧 23 条逐字不动
 * ================================================================ */

console.log('\n--- 1. 白名单 30 条 ---');

/* 批3 之前的 23 条（批1/1.5/1.6 的 14 + 批2 三角 9），逐条 deepStrictEqual 锁死。 */
const OLD23 = {
  'cnm_h023_q4': 'quadratic',
  'cnm_h029_q2': 'quadratic',
  'cnm_h032_q4': 'quadratic',
  'cnm_h034_q2': 'quadratic',
  'cnm_h034_q3': 'quadratic',
  'cnm_h035_q1': 'quadratic',
  'cnm_h036_q4': 'quadratic',
  'cnm_h049_q1': 'quadratic',
  'cnm_h226_q1': 'quadratic',
  'cnm_h227_q2': 'quadratic',
  'cnm_h032_q1': 'linear',
  'cnm_h032_q2': 'linear',
  'cnm_h049_q2': 'linear',
  'cnm_h028_q3': 'inverse',
  'cnm_h066_q1': 'trig',
  'cnm_h066_q2': 'trig',
  'cnm_h066_q3': 'trig',
  'cnm_h066_q4': 'trig',
  'cnm_h067_q1': 'trig',
  'cnm_h067_q4': 'trig',
  'cnm_h068_q4': 'trig',
  'cnm_h075_q1': 'trig',
  'cnm_h075_q2': 'trig'
};

test('HS_ITEMS 恰好 30 条：旧 23 条逐条键值不动 + 新增 7 条 exp/log', function () {
  const ids = Object.keys(F.HS_ITEMS).sort();
  assert.strictEqual(ids.length, 30, 'HS_ITEMS 应为 30 条（23 + 7），实际 ' + ids.length);
  Object.keys(OLD23).forEach(function (id) {
    assert.strictEqual(F.HS_ITEMS[id], OLD23[id], id + ' 的类型被改动（旧 23 条必须逐字不动）');
  });
  const NEW7 = {
    'cnm_h029_q4': 'exp', 'cnm_h042_q1': 'exp', 'cnm_h042_q2': 'exp',
    'cnm_h046_q2': 'log', 'cnm_h046_q4': 'log',
    'cnm_h047_q1': 'log', 'cnm_h047_q2': 'log'
  };
  Object.keys(NEW7).forEach(function (id) {
    assert.strictEqual(F.HS_ITEMS[id], NEW7[id], id + ' 应以 ' + NEW7[id] + ' 进白名单');
  });
  assert.deepStrictEqual(ids, Object.keys(OLD23).concat(Object.keys(NEW7)).sort(),
    'HS_ITEMS 键集合应与「旧 23 + 新 7」完全一致');
});

/* ================================================================
 * 2. 7 题逐题过「白名单 + intent + 代回」三道闸
 * ================================================================ */

console.log('\n--- 2. 7 题三道闸 ---');

const LEDGER_LAB = {
  'cnm_h029_q4': ['exp-curve', '值域'],
  'cnm_h042_q1': ['exp-curve', '单调性'],
  'cnm_h042_q2': ['exp-curve', '单调性'],
  'cnm_h046_q2': ['log-curve', '定义域'],
  'cnm_h046_q4': ['log-curve', '图象经过的定点'],
  'cnm_h047_q1': ['log-curve', '单调性'],
  'cnm_h047_q2': ['log-curve', '单调性']
};

test('7 题逐题过「白名单 + intent + 代回」三道闸', function () {
  const L = require('../diagnose/labmatch.js');
  const bad = [];
  LEDGER.forEach(function (c) {
    const item = q(c.id);
    const pair = LEDGER_LAB[c.id];
    const scene = F.labForScene(item.topicId, item.prompt, { itemId: c.id });
    if (!scene) { bad.push(c.id + ' labForScene=null'); return; }
    if (F.HS_ITEMS[c.id] !== c.type) bad.push(c.id + ' HS_ITEMS 类型=' + F.HS_ITEMS[c.id]);
    if (!F.intentSupported(pair[0], pair[1])) { bad.push(c.id + ' intent 不支持'); return; }
    const params = Object.assign({}, scene);
    delete params.type;
    const v = L.verifyParams(item.prompt, { match: pair[0], intent: pair[1], params: params }, { itemId: c.id });
    if (!v.ok) bad.push(c.id + ' 代回不过：' + v.why.join('; '));
    if (!F.noteText(pair[0], pair[1], params)) bad.push(c.id + ' 没有文案');
  });
  assert.deepStrictEqual(bad, [], bad.join(' / '));
});

/* ================================================================
 * 3. fail-closed：7 题不带 itemId 一律不挂
 * ================================================================ */

console.log('\n--- 3. fail-closed ---');

test('7 题不带 itemId 时 labFor / labForScene 都不挂', function () {
  LEDGER.forEach(function (c) {
    const item = q(c.id);
    assert.strictEqual(F.labFor(item.topicId, item.prompt), null, c.id + ' labFor 无 itemId 不应挂');
    assert.strictEqual(F.labForScene(item.topicId, item.prompt), null, c.id + ' labForScene 无 itemId 不应挂');
  });
});

/* ================================================================
 * 4. 高中全量挂载恰好 33 题
 * ================================================================ */

console.log('\n--- 4. 高中全量挂载 ---');

test('高中（cnm_h*）全量挂载恰好 33 题（30 白名单 + cnm_h172 三题）', function () {
  const hs = QUESTIONS.filter(function (x) { return /^cnm_h/.test(x.id); });
  const mounted = hs.filter(function (x) {
    return !!F.labForScene(x.topicId, x.prompt, { itemId: x.id });
  }).map(function (x) { return x.id; }).sort();
  const want = Object.keys(OLD23).concat(Object.keys(LEDGER_LAB))
    .concat(['cnm_h172_q1', 'cnm_h172_q2', 'cnm_h172_q3']).sort();
  assert.deepStrictEqual(mounted, want, '高中挂载清单与预期不符（多：' +
    mounted.filter(function (id) { return want.indexOf(id) < 0; }).join(',') + '；少：' +
    want.filter(function (id) { return mounted.indexOf(id) < 0; }).join(',') + '）');
});

/* ================================================================
 * 8. 三个画板注册齐全 + TYPE_DEF 滑块键序
 * ================================================================ */

console.log('\n--- 8. 画板注册 / TYPE_DEF ---');

const REG = {
  'exp-curve': {
    type: 'exp', canAnswer: ['值域', '单调性'],
    params: ['a', 'base', 'w', 'phi', 'k'], sliders: ['a', 'base', 'k'],
    defaults: { a: 1, base: 2, w: 1, phi: 0, k: 0 }
  },
  'log-curve': {
    type: 'log', canAnswer: ['定义域', '单调性', '图象经过的定点'],
    params: ['c', 'base', 'shift', 'd'], sliders: ['c', 'base', 'd'],
    defaults: { c: 1, base: 2, shift: 0, d: 0 }
  },
  'power-curve': {
    type: 'power', canAnswer: ['定义域', '单调性', '图象经过的定点', '值域'],
    params: ['a', 'p', 'root', 'k'], sliders: ['a'],
    defaults: { a: 1, p: 4, k: 0 }
  }
};

test('CAP_TYPE / canAnswer / params / intentSupported / capabilitiesFor 三画板齐全', function () {
  Object.keys(REG).forEach(function (lab) {
    const want = REG[lab];
    assert.strictEqual(F.CAP_TYPE[lab], want.type, lab + ' CAP_TYPE 不对');
    assert.deepStrictEqual(F.CAPABILITIES[lab].canAnswer, want.canAnswer, lab + ' canAnswer 应逐字一致');
    assert.deepStrictEqual(F.CAPABILITIES[lab].params, want.params, lab + ' params 应逐字一致');
    want.canAnswer.forEach(function (it) {
      assert.ok(F.intentSupported(lab, it), lab + '/' + it + ' 应受支持');
      assert.ok(F.noteTemplate(lab, it), lab + '/' + it + ' 应有文案模板');
    });
    assert.deepStrictEqual(Object.keys(F.capabilitiesFor(want.type)), [lab],
      'capabilitiesFor(' + want.type + ') 应恰好只有 ' + lab);
  });
});

test('TYPE_DEF 三族滑块键序与默认值', function () {
  Object.keys(REG).forEach(function (lab) {
    const type = REG[lab].type;
    const def = F.TYPE_DEF[type];
    assert.ok(def, 'TYPE_DEF.' + type + ' 必须存在');
    assert.deepStrictEqual(def.sliders.map(function (s) { return s.key; }), REG[lab].sliders,
      type + ' 滑块键序不对');
    Object.keys(REG[lab].defaults).forEach(function (k) {
      assert.strictEqual(def.defaults[k], REG[lab].defaults[k], type + ' 默认值 ' + k + ' 不对');
    });
  });
});

/* ================================================================
 * 9. 文案铁律：无派生结论 / 无 Markdown / 线型词与 paintModel 同源
 * ================================================================ */

console.log('\n--- 9. 文案铁律 ---');

const SAMPLE = {
  'exp-curve': { a: 1, base: 2, w: 1, phi: 0, k: 0 },
  'log-curve': { c: 1, base: 2, shift: 0, d: 0 },
  'power-curve': { a: 1, root: { b: 1, c: 0 }, k: 0 }
};
const STYLE_WORDS = ['灰色水平虚线', '灰色竖直虚线', '蓝色实线', '红色圆点', '浅色底纹'];

test('三族全部 (lab, intent) 文案非空、无占位符残留、无派生结论/坐标', function () {
  Object.keys(REG).forEach(function (lab) {
    const p = SAMPLE[lab];
    REG[lab].canAnswer.forEach(function (it) {
      const s = F.noteText(lab, it, p);
      assert.ok(s && s.length > 0, lab + '/' + it + ' 文案非空');
      assert.strictEqual(/\{\w+\}/.test(s), false, lab + '/' + it + ' 有占位符残留：' + s);
      assert.strictEqual(/undefined|NaN/.test(s), false, lab + '/' + it + ' 有 undefined/NaN：' + s);
      assert.strictEqual(/\*\*/.test(s), false, lab + '/' + it + ' 不许出现 Markdown 强调符：' + s);
      if (it === '值域') assert.strictEqual(/全体正实数|y\s*>\s*0|大于\s*0/.test(s), false, lab + '/' + it + ' 泄了值域结论：' + s);
      if (it === '定义域') assert.strictEqual(/x\s*>\s*0|全体正实数/.test(s), false, lab + '/' + it + ' 泄了定义域结论：' + s);
      if (it === '单调性') assert.strictEqual(/是(增|减)函数|单调递增|单调递减/.test(s), false, lab + '/' + it + ' 泄了增减结论：' + s);
      if (it === '图象经过的定点') assert.strictEqual(/\(\s*-?\d+(\.\d+)?\s*[,，]\s*-?\d+/.test(s), false, lab + '/' + it + ' 泄了坐标：' + s);
    });
  });
});

test('文案里的线型/颜色词与 paintModel 描述逐字一致（防漂移）', function () {
  Object.keys(REG).forEach(function (lab) {
    const p = SAMPLE[lab];
    REG[lab].canAnswer.forEach(function (it) {
      const s = F.noteText(lab, it, p);
      const d = F.describe(lab, it, p);
      assert.ok(d, lab + '/' + it + ' describe 非空');
      STYLE_WORDS.forEach(function (w) {
        if (s.indexOf(w) >= 0) {
          assert.ok(d.indexOf(w) >= 0, lab + '/' + it + ' 文案说「' + w + '」，但 paintModel 描述里没有：' + d);
        }
      });
    });
  });
});

/* ================================================================
 * 10. paintModel 三族元素清单
 * ================================================================ */

console.log('\n--- 10. paintModel 元素清单 ---');

function modelText(lab, it, p) {
  const m = F.paintModel(lab, it, p);
  assert.ok(m && m.elements, lab + '/' + it + ' paintModel 非空');
  return m.elements.map(function (e) { return e.kind + '|' + e.text + '|' + (e.style || ''); }).join('\n');
}

test('exp：渐近线 + x=0/x=1 红点', function () {
  const t = modelText('exp-curve', '值域', SAMPLE['exp-curve']);
  assert.ok(/asymptote\|.*灰色水平虚线.*渐近线/.test(t), 'exp 应列灰色水平虚线渐近线：\n' + t);
  assert.ok(/sample-points\|.*x=0 与 x=1.*红色圆点/.test(t), 'exp 应列 x=0/x=1 红点：\n' + t);
});

test('log：定义域底纹 + 灰色竖直虚线 + 定点红点', function () {
  const t = modelText('log-curve', '定义域', SAMPLE['log-curve']);
  assert.ok(/domain-band\|.*浅色底纹.*定义域/.test(t), 'log 应列定义域底纹：\n' + t);
  assert.ok(/asymptote\|.*灰色竖直虚线.*渐近线/.test(t), 'log 应列灰色竖直虚线渐近线：\n' + t);
  assert.ok(/fixed-point\|.*红色圆点.*定点/.test(t), 'log 应列定点红点：\n' + t);
});

test('power：根式定义域边界 / p<0 两条渐近线 / p>0 两个参考点', function () {
  const root = modelText('power-curve', '定义域', { a: 1, root: { b: 1, c: -1 }, k: 0 });
  assert.ok(/domain-boundary\|.*定义域边界.*灰色竖直虚线/.test(root), '根式应列定义域边界：\n' + root);
  assert.ok(/fixed-point\|.*红色圆点/.test(root), '根式应列起点红点：\n' + root);
  const neg = modelText('power-curve', '值域', { a: 1, p: -1 });
  assert.ok(/asymptote\|.*x=0.*y=0.*渐近线/.test(neg), 'p<0 应列 x=0 / y=0 渐近线：\n' + neg);
  const pos = modelText('power-curve', '图象经过的定点', { a: 1, p: 4 });
  assert.ok(/fixed-point\|.*\(0,0\).*\(1,1\)/.test(pos), 'p>0 应列 (0,0)/(1,1)：\n' + pos);
});

/* ================================================================
 * 11. labAnswerParts 输入行行为
 * ================================================================ */

console.log('\n--- 11. labAnswerParts ---');

test('值域/定义域/单调性 → []；定点 → 两个数字框', function () {
  assert.deepStrictEqual(F.labAnswerParts('exp-curve', '值域', SAMPLE['exp-curve']), []);
  assert.deepStrictEqual(F.labAnswerParts('exp-curve', '单调性', SAMPLE['exp-curve']), []);
  assert.deepStrictEqual(F.labAnswerParts('log-curve', '定义域', SAMPLE['log-curve']), []);
  assert.deepStrictEqual(F.labAnswerParts('log-curve', '单调性', SAMPLE['log-curve']), []);

  const lp = F.labAnswerParts('log-curve', '图象经过的定点', SAMPLE['log-curve']);
  assert.strictEqual(lp.length, 1, 'log 定点应有一行');
  assert.strictEqual(lp[0].kind, 'pair', 'log 定点应是两个数字框');
  assert.deepStrictEqual(lp[0].values, [1, 0], 'log₂x 定点应为 (1,0)');

  const rp = F.labAnswerParts('power-curve', '图象经过的定点', { a: 1, root: { b: 1, c: -1 }, k: 2 });
  assert.strictEqual(rp[0].kind, 'pair');
  assert.deepStrictEqual(rp[0].values, [1, 2], '√(x−1)+2 起点应为 (1,2)');

  const pp = F.labAnswerParts('power-curve', '图象经过的定点', { a: 1, p: 4 });
  assert.deepStrictEqual(pp[0].values, [1, 1], 'x^4 定点应为 (1,1)');
  assert.deepStrictEqual(F.labAnswerParts('power-curve', '值域', { a: 1, p: 4 }), []);
  assert.deepStrictEqual(F.labAnswerParts('power-curve', '定义域', { a: 1, p: 4 }), []);
  assert.deepStrictEqual(F.labAnswerParts('power-curve', '单调性', { a: 1, p: 4 }), []);
});

/* ================================================================
 * 12. verifyParams：代回通过 / base=1、base<0、w=0、改一个数 → 拒绝
 * ================================================================ */

console.log('\n--- 12. verifyParams ---');

const L = require('../diagnose/labmatch.js');
function verify(prompt, lab, intent, params, opts) {
  return L.verifyParams(prompt, { match: lab, intent: intent, params: params }, opts);
}

test('三族参数代回通过（含 f(x)= 前缀）', function () {
  const ok = [
    ['y=2^x', 'exp-curve', '值域', { a: 1, base: 2, w: 1, phi: 0, k: 0 }],
    ['y=log_2(x+1)-2', 'log-curve', '定义域', { c: 1, base: 2, shift: 1, d: -2 }],
    ['y=x^4', 'power-curve', '值域', { a: 1, p: 4 }],
    ['y=√(x−1)', 'power-curve', '定义域', { a: 1, root: { b: 1, c: -1 }, k: 0 }],
    ['f(x)=2^x', 'exp-curve', '单调性', { a: 1, base: 2, w: 1, phi: 0, k: 0 }]
  ];
  ok.forEach(function (row) {
    const v = verify(row[0], row[1], row[2], row[3]);
    assert.ok(v.ok, row[0] + ' 应通过代回，实际：' + v.why.join('; '));
  });
});

test('base=1 / base<0 / w=0 / 参数被改一个数 → 拒绝', function () {
  const bad = [
    ['y=2^x', 'exp-curve', '值域', { a: 1, base: 1, w: 1, phi: 0, k: 0 }],
    ['y=2^x', 'exp-curve', '值域', { a: 1, base: -2, w: 1, phi: 0, k: 0 }],
    ['y=2^x', 'exp-curve', '值域', { a: 1, base: 2, w: 0, phi: 0, k: 0 }],
    ['y=2^x', 'exp-curve', '值域', { a: 3, base: 2, w: 1, phi: 0, k: 0 }],
    ['y=log_2(x+1)-2', 'log-curve', '定义域', { c: 1, base: 2, shift: 0, d: -2 }],
    ['y=log_2(x+1)-2', 'log-curve', '定义域', { c: 1, base: 1, shift: 1, d: -2 }],
    ['y=x^4', 'power-curve', '值域', { a: 1, p: 5 }],
    ['y=√(x−1)', 'power-curve', '定义域', { a: 1, root: { b: 1, c: 0 }, k: 0 }]
  ];
  bad.forEach(function (row) {
    const v = verify(row[0], row[1], row[2], row[3]);
    assert.strictEqual(v.ok, false, row[0] + ' 应被拒绝：' + JSON.stringify(row[3]));
    assert.ok(v.why.length > 0, row[0] + ' 拒绝时必须给原因');
  });
});

/* ================================================================
 * 13. mount 对 w=0 / base=1 拒绝挂载（与批2 同口径：源码契约）
 * ================================================================ */

console.log('\n--- 13. mount 退化解拒绝 ---');

test('mount 对 exp w=0、exp/log base=1 拒绝挂载', function () {
  const src = fs.readFileSync(path.join(__dirname, '..', 'diagnose', 'funclab.js'), 'utf8');
  assert.ok(/type === 'exp' && p\.w === 0/.test(src), 'mount 必须在 exp 且 w=0 时返回 null');
  assert.ok(/\(type === 'exp' \|\| type === 'log'\) && \(!\(p\.base > 0\) \|\| Math\.abs\(p\.base - 1\) < 1e-12\)/.test(src),
    'mount 必须在 exp/log 且 base≤0 或 base=1 时返回 null');
});

/* ================================================================
 * 14. 审计预演：全库跑，三族零泄漏
 * ================================================================ */

console.log('\n--- 14. 审计 ---');

test('audit_funclab_notes 全库跑：答案数字 0 处泄漏、组合无文案 0 条', function () {
  const out = cp.execFileSync('node', [path.join(__dirname, '..', 'scripts', 'audit_funclab_notes.js')], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8'
  });
  assert.ok(out.indexOf('答案数字 0 处泄漏') >= 0, '审计应报 0 处泄漏：\n' + out.slice(0, 400));
  assert.ok(out.indexOf('组合无文案：0 条') >= 0, '审计应报组合无文案 0 条');
});

/* ================================================================
 * 15. 真 mount：7 题都能挂上、画布有尺寸、note 在；退化解必须拒绝
 *     （DOM/canvas 桩与 test_funclab_curves.js / test_funclab_labels.js 同一套路）
 * ================================================================ */

console.log('\n--- 15. 真 mount ---');

function makeCtx(rec) {
  const noop = function () {};
  const ctx = {
    save: noop, restore: noop, beginPath: noop, moveTo: noop, lineTo: noop,
    arc: noop, closePath: noop, fill: noop, fillRect: noop, clearRect: noop, setTransform: noop,
    set strokeStyle(v) { rec.strokeStyle = v; }, get strokeStyle() { return rec.strokeStyle; },
    set fillStyle(v) { rec.fillStyle = v; }, get fillStyle() { return rec.fillStyle; },
    set lineWidth(v) { rec.lineWidth = v; }, get lineWidth() { return rec.lineWidth; },
    set font(v) { rec.font = v; }, get font() { return rec.font; },
    set textAlign(v) { rec.textAlign = v || 'left'; }, get textAlign() { return rec.textAlign; },
    setLineDash: function (d) { rec.dash = d; },
    stroke: function () { rec.strokes++; },
    fillText: function (text) { rec.texts.push(String(text)); },
    measureText: function (text) { return { width: String(text).length * 7 }; }
  };
  return ctx;
}

function makeDom() {
  const created = [];
  function el(tag) {
    const node = {
      tagName: String(tag).toUpperCase(), className: '', hidden: false, children: [],
      listeners: {}, attributes: {}, parent: null, _text: '', style: {},
      appendChild: function (c) { node.children.push(c); c.parent = node; return c; },
      remove: function () {
        if (!node.parent) return;
        const i = node.parent.children.indexOf(node);
        if (i >= 0) node.parent.children.splice(i, 1);
        node.parent = null;
      },
      setAttribute: function (k, v) { node.attributes[k] = v; },
      getAttribute: function (k) { return node.attributes[k]; },
      addEventListener: function (ev, fn) { (node.listeners[ev] = node.listeners[ev] || []).push(fn); },
      _all: function (pred, out) {
        out = out || [];
        node.children.forEach(function (c) { if (pred(c)) out.push(c); c._all && c._all(pred, out); });
        return out;
      },
      querySelectorAll: function (sel) {
        const cls = sel.replace(/^\./, '');
        return node._all(function (c) { return String(c.className).split(/\s+/).indexOf(cls) >= 0; });
      },
      querySelector: function (sel) { return node.querySelectorAll(sel)[0] || null; }
    };
    Object.defineProperty(node, 'textContent', {
      get: function () { return node._text; },
      set: function (v) { node._text = String(v); node.children = []; }
    });
    if (node.tagName === 'CANVAS') {
      node.clientWidth = 560;
      node.clientHeight = 320;
      node.width = 0;
      node.height = 0;
      node._rec = { strokes: 0, texts: [], dash: [], strokeStyle: '', fillStyle: '',
        lineWidth: 0, font: '', textAlign: 'left' };
      node.getContext = function () { return makeCtx(node._rec); };
    }
    created.push(node);
    return node;
  }
  return {
    document: {
      createElement: el,
      createTextNode: function (t) { return { nodeValue: String(t), textContent: String(t) }; }
    },
    created: created,
    findCanvas: function () { return created.filter(function (n) { return n.tagName === 'CANVAS'; }); }
  };
}

function withDom(fn) {
  const dom = makeDom();
  const prevDoc = global.document;
  const prevDpr = global.devicePixelRatio;
  const prevRO = global.ResizeObserver;
  global.document = dom.document;
  global.devicePixelRatio = 1;
  global.ResizeObserver = undefined;
  try { return fn(dom); }
  finally {
    global.document = prevDoc;
    if (prevDpr === undefined) delete global.devicePixelRatio; else global.devicePixelRatio = prevDpr;
    global.ResizeObserver = prevRO;
  }
}

test('7 题真 mount：都非 null、el 内含正尺寸 canvas、note 文案在', function () {
  const bad = [];
  LEDGER.forEach(function (c) {
    const item = q(c.id);
    const pair = LEDGER_LAB[c.id];
    const scene = F.labForScene(item.topicId, item.prompt, { itemId: c.id });
    withDom(function (dom) {
      const inst = F.mount(Object.assign({}, scene, { lab: pair[0], intent: pair[1] }));
      if (!inst) { bad.push(c.id + ' mount=null'); return; }
      const canvas = dom.findCanvas()[0];
      if (!canvas || inst.el.children.indexOf(canvas) < 0) { bad.push(c.id + ' el 内没有 canvas'); return; }
      if (!(canvas.width > 0) || !(canvas.height > 0)) {
        bad.push(c.id + ' canvas 尺寸非正：' + canvas.width + '×' + canvas.height);
      }
      const note = inst.state().note;
      if (!note || !String(note).trim()) bad.push(c.id + ' note 文案为空');
    });
  });
  assert.deepStrictEqual(bad, [], bad.join(' / '));
});

test('mount 拒绝退化解：exp w=0、exp/log base=1、exp/log base≤0', function () {
  withDom(function () {
    const bad = [];
    function mustNull(cfg, label) {
      const inst = F.mount(cfg);
      if (inst !== null) bad.push(label + ' 应返回 null');
    }
    mustNull({ type: 'exp', a: 1, base: 2, w: 0, phi: 0, k: 0, lab: 'exp-curve', intent: '值域' }, 'exp w=0');
    mustNull({ type: 'exp', a: 1, base: 1, w: 1, phi: 0, k: 0, lab: 'exp-curve', intent: '值域' }, 'exp base=1');
    mustNull({ type: 'exp', a: 1, base: 0, w: 1, phi: 0, k: 0, lab: 'exp-curve', intent: '值域' }, 'exp base=0');
    mustNull({ type: 'exp', a: 1, base: -2, w: 1, phi: 0, k: 0, lab: 'exp-curve', intent: '值域' }, 'exp base<0');
    mustNull({ type: 'log', c: 1, base: 1, shift: 0, d: 0, lab: 'log-curve', intent: '定义域' }, 'log base=1');
    mustNull({ type: 'log', c: 1, base: 0, shift: 0, d: 0, lab: 'log-curve', intent: '定义域' }, 'log base=0');
    mustNull({ type: 'log', c: 1, base: -2, shift: 0, d: 0, lab: 'log-curve', intent: '定义域' }, 'log base<0');
    assert.deepStrictEqual(bad, [], bad.join(' / '));
  });
});

test('exp/log/power 的 describe 与 paintModel 都不描述基准曲线', function () {
  const cases = [
    ['exp-curve', '值域', { a: 1, base: 2, w: 1, phi: 0, k: 0 }],
    ['exp-curve', '单调性', { a: 1, base: 0.5, w: 1, phi: 0, k: 0 }],
    ['log-curve', '定义域', { c: 1, base: 2, shift: 0, d: 0 }],
    ['log-curve', '单调性', { c: 1, base: 0.5, shift: 0, d: 0 }],
    ['log-curve', '图象经过的定点', { c: 1, base: 2, shift: 0, d: 0 }],
    ['power-curve', '值域', { a: 1, p: 4, k: 0 }],
    ['power-curve', '单调性', { a: 1, p: -1, k: 0 }],
    ['power-curve', '定义域', { a: 1, root: { b: 1, c: 0 }, k: 0 }]
  ];
  const bad = [];
  cases.forEach(function (row) {
    [['describe', F.describe(row[0], row[1], row[2])],
      ['paintModel', F.paintModel(row[0], row[1], row[2])]].forEach(function (pair) {
      const name = pair[0], model = pair[1];
      if (!model) { bad.push(row[0] + '/' + row[1] + ' ' + name + '=null'); return; }
      const text = (Array.isArray(model) ? model : [model])
        .map(function (e) { return String((e && (e.text || e.label)) || e); }).join('\n');
      if (/基准曲线/.test(text)) bad.push(row[0] + '/' + row[1] + ' ' + name + ' 出现基准曲线');
      if (/y = x²/.test(text)) bad.push(row[0] + '/' + row[1] + ' ' + name + ' 出现 y = x²');
    });
  });
  assert.deepStrictEqual(bad, [], bad.join(' / '));
});

/* ================================================================ */

console.log('\n== ' + passed + ' passed / ' + failed + ' failed ==');
process.exit(failed ? 1 : 0);
