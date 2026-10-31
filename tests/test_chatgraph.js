#!/usr/bin/env node
/* 对话内嵌画板校验层（diagnose/chatgraph.js）测试：node tests/test_chatgraph.js
 *
 * 纯函数、无 DOM：verifyChatGraph(g, F) 必须 fail-closed ——
 * 图类型 / 画板名 / intent / 参数（齐全、有限、在滑块范围内）任何一项不过都不挂图。
 */
'use strict';
const assert = require('assert');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e).split('\n').slice(0, 6).join('\n       ')); }
}

const F = require('../diagnose/funclab.js');
const CG = require('../diagnose/chatgraph.js');

function bad(g, reason) {
  const r = CG.verifyChatGraph(g, F);
  assert.strictEqual(r.ok, false, JSON.stringify(g) + ' 应被拒绝');
  assert.strictEqual(r.reason, reason, '拒绝原因应为 ' + reason + '，实际 ' + r.reason);
}

test('正常 y=x²+3（a=1,h=0,k=3,quadratic-vertex,最小值）通过', function () {
  const r = CG.verifyChatGraph({
    type: 'quadratic', lab: 'quadratic-vertex', intent: '最小值',
    params: { a: 1, h: 0, k: 3 }
  }, F);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.type, 'quadratic');
  assert.strictEqual(r.lab, 'quadratic-vertex');
  assert.strictEqual(r.intent, '最小值');
  assert.deepStrictEqual(r.params, { a: 1, h: 0, k: 3 });
});

test('a=0 拒绝（二次函数 a 不能为 0）', function () {
  bad({ type: 'quadratic', lab: 'quadratic-vertex', intent: '最小值', params: { a: 0, h: 0, k: 3 } }, 'zero-a');
});

test('h 超范围拒绝（h 必须在 -8~8）', function () {
  bad({ type: 'quadratic', lab: 'quadratic-vertex', intent: '最小值', params: { a: 1, h: 9, k: 3 } }, 'param-out-of-range:h');
});

test('lab 不在 CAPABILITIES 清单里拒绝', function () {
  bad({ type: 'quadratic', lab: 'quadratic-nope', intent: '最小值', params: { a: 1, h: 0, k: 3 } }, 'bad-lab');
});

test('lab 与 type 不匹配拒绝', function () {
  bad({ type: 'quadratic', lab: 'linear-intercepts', intent: '最小值', params: { a: 1, h: 0, k: 3 } }, 'lab-type-mismatch');
});

test('缺参数拒绝（不许靠默认值补）', function () {
  bad({ type: 'quadratic', lab: 'quadratic-vertex', intent: '最小值', params: { a: 1, h: 0 } }, 'missing-param:k');
});

test('intent 不在 canAnswer 里拒绝', function () {
  bad({ type: 'quadratic', lab: 'quadratic-vertex', intent: '三角形的面积', params: { a: 1, h: 0, k: 3 } }, 'bad-intent');
});

test('intent 归一化后匹配（空格差异不算不同）通过', function () {
  const r = CG.verifyChatGraph({
    type: 'linear', lab: 'linear-intercepts', intent: '与 y 轴交点的纵坐标',
    params: { k: 2, b: 1 }
  }, F);
  assert.strictEqual(r.ok, true);
});

test('非滑块参数也必须是有限数且 |v| <= 100', function () {
  bad({
    type: 'quadratic', lab: 'quadratic-range-on-interval', intent: '在给定区间上的最小值',
    params: { a: 1, h: 0, k: 0, xMin: 0, xMax: 101 }
  }, 'param-out-of-range:xMax');
});

test('params 只保留数字键', function () {
  const r = CG.verifyChatGraph({
    type: 'quadratic', lab: 'quadratic-vertex', intent: '最小值',
    params: { a: 1, h: 0, k: 3, junk: 'x' }
  }, F);
  assert.strictEqual(r.ok, false, '非数值参数应被拒绝');
});

test('Funclab 缺失 → no-funclab', function () {
  const r = CG.verifyChatGraph({ type: 'quadratic' }, null);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no-funclab');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
