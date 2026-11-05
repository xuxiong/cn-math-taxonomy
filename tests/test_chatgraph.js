#!/usr/bin/env node
/* 对话内嵌画板校验层（diagnose/chatgraph.js）测试：node tests/test_chatgraph.js
 *
 * 纯函数、无 DOM：verifyChatGraph(g, baseline, F) 必须 fail-closed ——
 * 图身份必须与本题 baseline 一致，且类型 / 画板名 / intent / 参数
 * （齐全、有限、在滑块范围内）任何一项不过都不挂图。
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

const QUAD_BASE = { type: 'quadratic', lab: 'quadratic-vertex' };

function bad(g, baseline, reason) {
  const r = CG.verifyChatGraph(g, baseline, F);
  assert.strictEqual(r.ok, false, JSON.stringify(g) + ' 应被拒绝');
  assert.strictEqual(r.reason, reason, '拒绝原因应为 ' + reason + '，实际 ' + r.reason);
}

/* 能力矩阵用：按 type 的 defaults 造一份合法参数，滑块键缺失时在滑块范围内取值 */
function matrixParams(type) {
  const def = F.TYPE_DEF[type] || {};
  const p = {};
  const defaults = def.defaults || {};
  Object.keys(defaults).forEach(function (k) { p[k] = defaults[k]; });
  const sliders = def.sliders || [];
  sliders.forEach(function (sd) {
    if (Object.prototype.hasOwnProperty.call(p, sd.key)) return;
    p[sd.key] = (sd.min <= 0 && 0 <= sd.max) ? 0
      : (Math.abs(sd.min) <= Math.abs(sd.max) ? sd.min : sd.max);
  });
  if (type === 'trig') p.fn = 'sin';
  return p;
}

test('正常 y=x²+3（a=1,h=0,k=3,quadratic-vertex,最小值）通过', function () {
  const r = CG.verifyChatGraph({
    type: 'quadratic', lab: 'quadratic-vertex', intent: '最小值',
    params: { a: 1, h: 0, k: 3 }
  }, QUAD_BASE, F);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.type, 'quadratic');
  assert.strictEqual(r.lab, 'quadratic-vertex');
  assert.strictEqual(r.intent, '最小值');
  assert.deepStrictEqual(r.params, { a: 1, h: 0, k: 3 });
});

test('a=0 拒绝（二次函数 a 不能为 0）', function () {
  bad({ type: 'quadratic', lab: 'quadratic-vertex', intent: '最小值', params: { a: 0, h: 0, k: 3 } }, QUAD_BASE, 'zero-a');
});

test('h 超范围拒绝（h 必须在 -8~8）', function () {
  bad({ type: 'quadratic', lab: 'quadratic-vertex', intent: '最小值', params: { a: 1, h: 9, k: 3 } }, QUAD_BASE, 'param-out-of-range:h');
});

test('lab 不在 CAPABILITIES 清单里拒绝', function () {
  bad({ type: 'quadratic', lab: 'quadratic-nope', intent: '最小值', params: { a: 1, h: 0, k: 3 } }, QUAD_BASE, 'bad-lab');
});

test('lab 与 type 不匹配拒绝', function () {
  bad({ type: 'quadratic', lab: 'linear-intercepts', intent: '最小值', params: { a: 1, h: 0, k: 3 } }, QUAD_BASE, 'lab-type-mismatch');
});

test('缺参数拒绝（不许靠默认值补）', function () {
  bad({ type: 'quadratic', lab: 'quadratic-vertex', intent: '最小值', params: { a: 1, h: 0 } }, QUAD_BASE, 'missing-param:k');
});

test('intent 不在 canAnswer 里拒绝', function () {
  bad({ type: 'quadratic', lab: 'quadratic-vertex', intent: '三角形的面积', params: { a: 1, h: 0, k: 3 } }, QUAD_BASE, 'bad-intent');
});

test('intent 归一化后匹配（空格差异不算不同）通过', function () {
  const r = CG.verifyChatGraph({
    type: 'linear', lab: 'linear-intercepts', intent: '与 y 轴交点的纵坐标',
    params: { k: 2, b: 1 }
  }, { type: 'linear', lab: 'linear-intercepts' }, F);
  assert.strictEqual(r.ok, true);
});

test('非滑块参数也必须是有限数且 |v| <= 100', function () {
  bad({
    type: 'quadratic', lab: 'quadratic-range-on-interval', intent: '在给定区间上的最小值',
    params: { a: 1, h: 0, k: 0, xMin: 0, xMax: 101 }
  }, { type: 'quadratic', lab: 'quadratic-range-on-interval' }, 'param-out-of-range:xMax');
});

test('params 只保留数字键', function () {
  bad({
    type: 'quadratic', lab: 'quadratic-vertex', intent: '最小值',
    params: { a: 1, h: 0, k: 3, junk: 'x' }
  }, QUAD_BASE, 'bad-param:junk');
});

test('Funclab 缺失 → no-funclab', function () {
  const r = CG.verifyChatGraph({ type: 'quadratic' }, QUAD_BASE, null);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no-funclab');
});

test('identity-type：换函数类型拒绝', function () {
  bad({
    type: 'linear', lab: 'linear-intercepts', intent: '与 y 轴交点的纵坐标',
    params: { k: 2, b: 1 }
  }, QUAD_BASE, 'identity-type');
});

test('identity-lab：同 type 换画板拒绝', function () {
  bad({
    type: 'quadratic', lab: 'quadratic-roots', intent: '方程的根',
    params: { a: 1, h: 0, k: 3 }
  }, QUAD_BASE, 'identity-lab');
});

test('identity-fn：函数身份不同拒绝', function () {
  bad({
    type: 'trig', lab: 'trig-domain', intent: '定义域',
    params: { fn: 'tan', A: 1, w: 1, phi: 0, k: 0 }
  }, { type: 'trig', lab: 'trig-domain', fn: 'sin' }, 'identity-fn');
});

test('identity-fn：缺函数身份拒绝', function () {
  bad({
    type: 'trig', lab: 'trig-domain', intent: '定义域',
    params: { A: 1, w: 1, phi: 0, k: 0 }
  }, { type: 'trig', lab: 'trig-domain', fn: 'sin' }, 'identity-fn');
});

test('同身份改参数允许（a 从 1 改到 3）', function () {
  const r = CG.verifyChatGraph({
    type: 'quadratic', lab: 'quadratic-vertex', intent: '最小值',
    params: { a: 3, h: 0, k: 3 }
  }, { type: 'quadratic', lab: 'quadratic-vertex', a: 1 }, F);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.params.a, 3);
});

test('三角族同身份通过且 fn 字符串保留', function () {
  const r = CG.verifyChatGraph({
    type: 'trig', lab: 'trig-domain', intent: '定义域',
    params: { fn: 'sin', A: 2, w: 1, phi: 0, k: 1 }
  }, { type: 'trig', lab: 'trig-domain', fn: 'sin' }, F);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.params.fn, 'sin');
});

test('缺省 fail-closed：baseline 缺失 / null / 不完整一律 identity-unknown', function () {
  const g = {
    type: 'quadratic', lab: 'quadratic-vertex', intent: '最小值',
    params: { a: 1, h: 0, k: 3 }
  };
  bad(g, undefined, 'identity-unknown');
  bad(g, null, 'identity-unknown');
  bad(g, { lab: 'quadratic-vertex' }, 'identity-unknown');
});

test('absentNotice：有 baseline 时带出本题公式', function () {
  const notice = CG.absentNotice({
    type: 'trig', lab: 'trig-domain', fn: 'sin', A: 1, w: 1, phi: 0, k: 0
  }, F);
  assert.ok(notice.indexOf('画板仍是本题的') >= 0, notice);
  assert.ok(notice.indexOf('y = sin(x)') >= 0, notice);
});

test('absentNotice：无 baseline 时是固定陈述', function () {
  assert.strictEqual(CG.absentNotice(null, F), '本次回答没有配图。');
});

test('absentNotice：无 Funclab 时不抛错，降级为固定陈述', function () {
  assert.strictEqual(CG.absentNotice({ type: 'trig', lab: 'trig-domain', fn: 'sin', A: 1, w: 1, phi: 0, k: 0 }, null), '本次回答没有配图。');
});

/* 画板契约清单：CAPABILITIES 的键（新增 / 改名画板时同步这里）。
 * lab 数量一律运行时取（Object.keys(F.CAPABILITIES).length），测试里不写字面量 ——
 * 批4 新增了两个三次画板 cubic-parity / cubic-extremum。 */
const LAB_NAMES = [
  'quadratic-vertex', 'quadratic-roots', 'quadratic-monotonic', 'quadratic-parity',
  'quadratic-inequality', 'quadratic-range-on-interval',
  'linear-intercepts', 'linear-trend', 'linear-equation',
  'inverse-quadrants', 'inverse-area', 'inverse-domain',
  'trig-extremum', 'trig-period', 'trig-parity', 'trig-domain', 'trig-monotonic',
  'exp-curve', 'log-curve', 'power-curve',
  'cubic-parity', 'cubic-extremum',
  'two-curves-intersect'
];

test('能力矩阵：CAPABILITIES 的每个 lab 都可挂', function () {
  const labs = Object.keys(F.CAPABILITIES);
  const declared = Object.keys(F.CAP_TYPE);
  /* 数量从 CAPABILITIES 动态取：两边数量必须一致（每个 lab 都要有类型声明），
   * 且 lab 集合必须与清单逐个对上（含 cubic-parity / cubic-extremum）。 */
  assert.strictEqual(labs.length, declared.length,
    'CAPABILITIES 与 CAP_TYPE 的 lab 数应一致，实际 ' + labs.length + ' / ' + declared.length);
  assert.deepStrictEqual(labs.slice().sort(), LAB_NAMES.slice().sort(),
    'CAPABILITIES 的 lab 集合应与清单一致（实际 ' + labs.length + ' 个：' + labs.join(',') + '）');
  let checked = 0;
  labs.forEach(function (lab) {
    const type = F.CAP_TYPE[lab];
    const intent = F.CAPABILITIES[lab].canAnswer[0];
    const baseline = { type: type, lab: lab };
    if (type === 'trig') baseline.fn = 'sin';
    const r = CG.verifyChatGraph({
      type: type, lab: lab, intent: intent, params: matrixParams(type)
    }, baseline, F);
    if (r.ok !== true) {
      console.log('  FAIL matrix: ' + lab + ' / ' + intent + ' / ' + r.reason);
      assert.fail(lab + ' / ' + intent + ' / ' + r.reason);
    }
    console.log('  ok   matrix: ' + lab + ' / ' + intent + ' / ok');
    checked++;
  });
  assert.strictEqual(checked, labs.length, '每个 lab 都要过矩阵，实际 ' + checked + ' / ' + labs.length);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
