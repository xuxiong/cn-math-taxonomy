#!/usr/bin/env node
/* 高中函数画板 批2：三角函数 9 题上线 —— y = A·sin(ωx+φ)+k 解析 + 5 个 trig-* 画板
 *   node tests/test_funclab_hs_batch2.js
 *
 * 白名单 14 → 23（+9 三角），高中挂载 17 → 26。批1/1.5/1.6 的 14 条契约一题不动，
 * 逐题台账仍在 tests/test_funclab_hs_batch1.js / test_funclab_hs_batch16.js。
 *
 * 本文件锁十三件事：
 *   1. 白名单 +9：HS_ITEMS 里三角 9 条全是 'trig'，h069_q4（tan 90°，测算判 misleading）不进表；
 *   2. 9 题逐题过「表 + intent + 代回」三道闸（线上可见的机器判据），区间题端点实抠；
 *   3. fromPrompt 三角解析全表（题面实取）：A·fn(ωx+φ)+k 各形态；含参 / sin² / 括号内无 x → null；
 *   4. 既有语义零改动：y=x² / y=2x+1 / y=k/x / 隐式直线 / 方程段代表题结果逐字不变；
 *   5. 5 个 trig-* 画板注册齐全（CAP_TYPE / canAnswer 措辞 / params / intentSupported / capabilitiesFor）；
 *   6. 文案铁律：不印 A/w/phi/k 数值（题面省略形态的 1/0 不是已知量，印了就是给答案递数字）；
 *      trig-period 的「一个周期 T = 2π」是唯一允许直接印派生数值的标注（周期不是答案，商才是）；
 *      非根 intent 不出现「根」字；空参数调用文案非空、无占位符残留（审计扰动路径同款）；
 *   7. describe/paintModel：period 标注「一个周期 T = 2π」；extremum 留白不泄答案数字；
 *   8. labAnswerParts：extremum → k±|A|、period → T 与 T/π、domain/monotonic/parity → []；
 *   9. verifyParams：fn 是字符串特判（不参与 Number()）、fn 不符拒绝、w=0 拒绝、buildCfg 透传 fn；
 *  10. promptInterval 认 π 端点（[−π/2，π/2] / [π/2，3π/2] / [0，2π] / -π/2<x<π/2），
 *      整数/小数旧行为逐字不变；圆括号、无界区间仍 null；
 *  11. 答案语义门禁（answer-gate trig 分支）：9 题 misfitOf 全 null；h069_q4 与 31 条冒充题仍全挡；
 *  12. 2902 行 bug 修正：mount 的 focus.rootCount 用 intentKey 归一化后的字面量比较，
 *      源码里「与 x 轴交点的个数」带空格写法清零（原先与归一化 intent 比较永远 false）；
 *  13. 审计预演：audit_funclab_notes 全库跑一遍，三角 9 题零泄漏（「2π」的 2 走结构常量口径）。
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e).split('\n').slice(0, 8).join('\n       ')); }
}

const F = require('../diagnose/funclab.js');
const L = require('../diagnose/labmatch.js');
const GATE = require('./lib/answer-gate.js');
const QUESTIONS = require('../data/questions.json');
const QMAP = new Map(QUESTIONS.map(function (x) { return [x.id, x]; }));
function q(id) {
  const item = QMAP.get(id);
  assert.ok(item, '题库里找不到题目 ' + id);
  return item;
}
const PI = Math.PI;

/* ================================================================
 * 台账：批2 上线的 9 题 × (画板, intent) —— 全部来自测算脚本 gated ok 的三角族
 * （三角族 10 题：ok 9 / 误挂 1；误挂的 cnm_h069_q4 见第 11 组）
 * ================================================================ */
const LEDGER = [
  { id: 'cnm_h066_q1', lab: 'trig-extremum', intent: '最大值' },
  { id: 'cnm_h066_q2', lab: 'trig-extremum', intent: '最小值' },
  { id: 'cnm_h066_q3', lab: 'trig-period', intent: '最小正周期除以 π 后的值' },
  { id: 'cnm_h066_q4', lab: 'trig-domain', intent: '定义域' },
  { id: 'cnm_h067_q1', lab: 'trig-monotonic', intent: '单调性' },
  { id: 'cnm_h067_q4', lab: 'trig-monotonic', intent: '单调性' },
  { id: 'cnm_h068_q4', lab: 'trig-parity', intent: '奇偶性' },
  { id: 'cnm_h075_q1', lab: 'trig-extremum', intent: '最大值' },
  { id: 'cnm_h075_q2', lab: 'trig-period', intent: '最小正周期除以 π 后的值' }
];

/* 批1/1.5/1.6 的 14 条白名单（契约表来源 test_funclab_hs_batch1.js 的 WANT，一题不动） */
const OLD14 = [
  'cnm_h023_q4', 'cnm_h029_q2', 'cnm_h032_q1', 'cnm_h032_q2', 'cnm_h032_q4',
  'cnm_h034_q2', 'cnm_h034_q3', 'cnm_h035_q1', 'cnm_h036_q4', 'cnm_h049_q1',
  'cnm_h049_q2', 'cnm_h226_q1', 'cnm_h227_q2', 'cnm_h028_q3'
];

/* 测算判 misleading 的 31 条（batch1 的闸门清单，本文件复用做答案门禁回归） */
const MISLEADING = [
  'cnm_h027_q4', 'cnm_h029_q3', 'cnm_h032_q3', 'cnm_h033_q1', 'cnm_h033_q2', 'cnm_h033_q3',
  'cnm_h035_q3', 'cnm_h035_q4', 'cnm_h049_q3', 'cnm_h069_q4',
  'cnm_h216_q2', 'cnm_h217_q1', 'cnm_h217_q2', 'cnm_h218_q3', 'cnm_h219_q1',
  'cnm_h220_q1', 'cnm_h220_q2', 'cnm_h220_q3', 'cnm_h221_q1', 'cnm_h221_q2',
  'cnm_h222_q1', 'cnm_h222_q2', 'cnm_h222_q3', 'cnm_h223_q1', 'cnm_h223_q2',
  'cnm_h223_q3', 'cnm_h224_q1', 'cnm_h225_q2', 'cnm_h225_q3', 'cnm_h229_q1', 'cnm_h229_q3'
];

/* ================================================================
 * 1. 白名单 +9：HS_ITEMS 逐题放行，类型 'trig'
 * ================================================================ */

console.log('\n--- 1. 白名单 +9（14 → 23） ---');

test('HS_ITEMS 恰好 23 条：旧 14 条逐字不动 + 三角 9 条，全部标 trig', function () {
  const ids = Object.keys(F.HS_ITEMS).sort();
  assert.strictEqual(ids.length, 23, 'HS_ITEMS 应为 23 条（14 + 9），实际 ' + ids.length);
  OLD14.forEach(function (id) {
    assert.ok(ids.indexOf(id) >= 0, '批1/1.5/1.6 的 ' + id + ' 不许从白名单里消失');
  });
  LEDGER.forEach(function (c) {
    assert.strictEqual(F.HS_ITEMS[c.id], 'trig', c.id + ' 应以 trig 进白名单');
  });
  const oldKinds = OLD14.map(function (id) { return F.HS_ITEMS[id]; });
  assert.deepStrictEqual(oldKinds.filter(function (k) { return k === 'trig'; }), [],
    '旧 14 条的类型不许被改成 trig');
});

test('三角 9 题挂载：labFor / labForScene 都返回 trig 解析结果', function () {
  LEDGER.forEach(function (c) {
    const item = q(c.id);
    const got = F.labFor(item.topicId, item.prompt, { itemId: c.id });
    assert.ok(got, c.id + ' labFor 应挂上（题面：' + item.prompt + '）');
    assert.strictEqual(got.type, 'trig', c.id + ' 类型应为 trig');
    const scene = F.labForScene(item.topicId, item.prompt, { itemId: c.id });
    assert.ok(scene, c.id + ' labForScene 应挂上');
    assert.strictEqual(scene.type, 'trig', c.id + ' scene 类型应为 trig');
    assert.ok(scene.base == null, c.id + ' 三角无基准曲线（baseOf 应返回 null）');
  });
});

test('三角 9 题不带 itemId 时不挂（fail-closed 口径与批1 一致）', function () {
  LEDGER.forEach(function (c) {
    const item = q(c.id);
    assert.strictEqual(F.labFor(item.topicId, item.prompt), null, c.id + ' 无 itemId 不应挂');
    assert.strictEqual(F.labForScene(item.topicId, item.prompt), null, c.id + ' 无 itemId 不应挂');
  });
});

test('h069_q4（y=tan x 在 x=90°，测算判 misleading）不进白名单、挂不上', function () {
  const item = q('cnm_h069_q4');
  assert.strictEqual(F.HS_ITEMS['cnm_h069_q4'], undefined, 'h069_q4 不应进 HS_ITEMS（板主严读口径）');
  assert.strictEqual(F.labFor(item.topicId, item.prompt, { itemId: item.id }), null, 'h069_q4 不应挂单曲线画板');
  assert.strictEqual(F.labForScene(item.topicId, item.prompt, { itemId: item.id }), null, 'h069_q4 不应挂画板');
});

test('高中全量挂载恰好 26 题（批1 14 + 批2 9 + 既有 cnm_h172 三题）', function () {
  const hs = QUESTIONS.filter(function (x) { return /^cnm_h/.test(x.id); });
  const mounted = hs.filter(function (x) {
    return !!F.labForScene(x.topicId, x.prompt, { itemId: x.id });
  }).map(function (x) { return x.id; }).sort();
  const want = OLD14.concat(LEDGER.map(function (c) { return c.id; }))
    .concat(['cnm_h172_q1', 'cnm_h172_q2', 'cnm_h172_q3']).sort();
  assert.deepStrictEqual(mounted, want, '高中挂载清单与预期不符（多：' +
    mounted.filter(function (id) { return want.indexOf(id) < 0; }).join(',') + '；少：' +
    want.filter(function (id) { return mounted.indexOf(id) < 0; }).join(',') + '）');
});

/* ================================================================
 * 2. 9 题逐题过三道闸（表 + intent + 代回校验 + 文案）
 * ================================================================ */

console.log('\n--- 2. 三道闸 ---');

test('9 题逐题过「表 + intent + 代回」三道闸，区间题端点实抠', function () {
  const bad = [];
  LEDGER.forEach(function (c) {
    const item = q(c.id);
    const scene = F.labForScene(item.topicId, item.prompt, { itemId: c.id });
    if (!scene) { bad.push(c.id + ' labForScene=null'); return; }
    const params = Object.assign({}, scene);
    delete params.type;
    delete params.base;
    if (c.lab === 'trig-monotonic') {
      const iv = L.promptInterval(item.prompt);
      if (!iv) { bad.push(c.id + ' 区间端点抠不出'); return; }
      params.xMin = iv.xMin; params.xMax = iv.xMax;
    }
    if (!F.intentSupported(c.lab, c.intent)) { bad.push(c.id + ' ' + c.lab + '/' + c.intent + ' intent 不支持'); return; }
    const v = L.verifyParams(item.prompt, { match: c.lab, intent: c.intent, params: params }, { itemId: c.id });
    if (!v.ok) bad.push(c.id + ' 代回不过：' + v.why.join('; '));
    if (!F.noteText(c.lab, c.intent, params)) bad.push(c.id + ' 没有文案');
  });
  assert.deepStrictEqual(bad, [], bad.join(' / '));
});

test('两道单调题的题面区间都抠得出：[-π/2,π/2] 与 [π/2,3π/2]', function () {
  assert.deepStrictEqual(L.promptInterval(q('cnm_h067_q1').prompt), { xMin: -PI / 2, xMax: PI / 2 });
  assert.deepStrictEqual(L.promptInterval(q('cnm_h067_q4').prompt), { xMin: PI / 2, xMax: 3 * PI / 2 });
});

/* ================================================================
 * 3. fromPrompt 三角解析：全表 + 反例 + 既有语义零改动
 * ================================================================ */

console.log('\n--- 3. 解析 ---');

test('三角解析全表：题库 9 题实面 + 参数形态变体', function () {
  const cases = [
    ['y=sin x 的最大值是多少？', { fn: 'sin', A: 1, w: 1, phi: 0, k: 0 }],
    ['y=2sin x 的最大值是多少？', { fn: 'sin', A: 2, w: 1, phi: 0, k: 0 }],
    ['y=sin(2x) 的最小正周期除以 π，结果是多少？', { fn: 'sin', A: 1, w: 2, phi: 0, k: 0 }],
    ['y=sin x（x 为弧度）的最小正周期除以 π，结果是多少？', { fn: 'sin', A: 1, w: 1, phi: 0, k: 0 }],
    ['y=cos x 的奇偶性是？', { fn: 'cos', A: 1, w: 1, phi: 0, k: 0 }],
    ['y=tan x 在 x=90° 处？', { fn: 'tan', A: 1, w: 1, phi: 0, k: 0 }],
    ['y=sin x 在 [−π/2，π/2] 上是？', { fn: 'sin', A: 1, w: 1, phi: 0, k: 0 }],
    ['y=sin x 在 [π/2，3π/2] 上整体是？', { fn: 'sin', A: 1, w: 1, phi: 0, k: 0 }],
    ['y=3cos(2x+π/3)-1 的最大值', { fn: 'cos', A: 3, w: 2, phi: PI / 3, k: -1 }],
    ['y=-2sin x+3', { fn: 'sin', A: -2, w: 1, phi: 0, k: 3 }],
    ['y=sin(2x−π/6)+1', { fn: 'sin', A: 1, w: 2, phi: -PI / 6, k: 1 }],
    ['y=sin(x-π/6)', { fn: 'sin', A: 1, w: 1, phi: -PI / 6, k: 0 }],
    ['y=sin(x+1)', { fn: 'sin', A: 1, w: 1, phi: 1, k: 0 }],
    ['y=sin2x', { fn: 'sin', A: 1, w: 2, phi: 0, k: 0 }],
    ['y=2*sin x', { fn: 'sin', A: 2, w: 1, phi: 0, k: 0 }],
    ['y=cos(-2x)', { fn: 'cos', A: 1, w: -2, phi: 0, k: 0 }]
  ];
  cases.forEach(function (c) {
    const got = F.fromPrompt(c[0]);
    assert.deepStrictEqual(got, Object.assign({ type: 'trig' }, c[1]),
      '「' + c[0] + '」解析应为 ' + JSON.stringify(c[1]) + '，实际 ' + JSON.stringify(got));
  });
});

test('三角解析反例：含参 / sin² / 括号内无 x / ω=0 → null（确认是三角题但不画）', function () {
  [
    'y=Asin(ωx+φ)',
    'y=sin²x',
    'y=sin(π/2)',
    'y=sin(kx)',
    'y=sin(2x²)',
    'y=sin(0x)',
    'sin x 的最大值',
    'y=a sin x'
  ].forEach(function (s) {
    assert.strictEqual(F.fromPrompt(s), null, '「' + s + '」应解析不出（含参/非常规形态不挂画板）');
  });
});

test('既有语义零改动：二次/一次/反比例/隐式直线/方程段代表题逐字不变', function () {
  assert.deepStrictEqual(F.fromPrompt('y=x²+1'), { type: 'quadratic', a: 1, h: 0, k: 1 });
  assert.deepStrictEqual(F.fromPrompt('y=x²-2x-3'), { type: 'quadratic', a: 1, h: 1, k: -4 });
  assert.deepStrictEqual(F.fromPrompt('y=2x+1'), { type: 'linear', k: 2, b: 1 });
  assert.deepStrictEqual(F.fromPrompt('y=6/x'), { type: 'inverse', k: 6 });
  assert.deepStrictEqual(F.fromPrompt('x+y=5'), { type: 'linear', k: -1, b: 5 });
  assert.deepStrictEqual(F.fromPrompt('y=k/x'), null, 'y=k/x 含字母参数，本来就不解析，不许被三角分支截走');
  assert.deepStrictEqual(F.fromPrompt('f(x)=x²−5'), null, 'f(x)= 记法 fromPrompt 本身不认（别名只在白名单题上生效）');
  const eq = F.fromPrompt('(x-2)(x+1)=0');
  assert.strictEqual(eq.type, 'quadratic', '展开式方程仍走 quadratic 分支');
  const v = F.fromPrompt('y=-(x-2)²+5');
  assert.deepStrictEqual({ a: v.a, h: v.h, k: v.k }, { a: -1, h: 2, k: 5 }, '顶点式解析不变');
});

test('白名单 9 题的 fromPrompt 解析值逐题锁定（滑块初值 = 题面参数）', function () {
  const want = {
    'cnm_h066_q1': { fn: 'sin', A: 1, w: 1, phi: 0, k: 0 },
    'cnm_h066_q2': { fn: 'sin', A: 1, w: 1, phi: 0, k: 0 },
    'cnm_h066_q3': { fn: 'sin', A: 1, w: 1, phi: 0, k: 0 },
    'cnm_h066_q4': { fn: 'sin', A: 1, w: 1, phi: 0, k: 0 },
    'cnm_h067_q1': { fn: 'sin', A: 1, w: 1, phi: 0, k: 0 },
    'cnm_h067_q4': { fn: 'sin', A: 1, w: 1, phi: 0, k: 0 },
    'cnm_h068_q4': { fn: 'cos', A: 1, w: 1, phi: 0, k: 0 },
    'cnm_h075_q1': { fn: 'sin', A: 2, w: 1, phi: 0, k: 0 },
    'cnm_h075_q2': { fn: 'sin', A: 1, w: 2, phi: 0, k: 0 }
  };
  Object.keys(want).forEach(function (id) {
    const item = q(id);
    const got = F.labFor(item.topicId, item.prompt, { itemId: id });
    ['fn', 'A', 'w', 'phi', 'k'].forEach(function (key) {
      assert.ok(got && Math.abs((got[key] || 0) - want[id][key]) < 1e-9,
        id + ' 的 ' + key + ' 应为 ' + want[id][key] + '，实际 ' + (got && got[key]));
    });
  });
});

/* ================================================================
 * 4. 画板注册：CAP_TYPE / canAnswer / params / intentSupported / capabilitiesFor
 * ================================================================ */

console.log('\n--- 4. 画板注册 ---');

test('5 个 trig-* 画板的 CAP_TYPE / canAnswer / params 逐字锁定', function () {
  assert.deepStrictEqual(F.CAPABILITIES['trig-extremum'].canAnswer, ['最大值', '最小值']);
  assert.deepStrictEqual(F.CAPABILITIES['trig-period'].canAnswer, ['最小正周期', '最小正周期除以 π 后的值']);
  assert.deepStrictEqual(F.CAPABILITIES['trig-domain'].canAnswer, ['定义域', '渐近线']);
  assert.deepStrictEqual(F.CAPABILITIES['trig-monotonic'].canAnswer, ['单调性']);
  assert.deepStrictEqual(F.CAPABILITIES['trig-parity'].canAnswer, ['奇偶性']);
  assert.deepStrictEqual(F.CAPABILITIES['trig-extremum'].params, ['fn', 'A', 'w', 'phi', 'k']);
  assert.deepStrictEqual(F.CAPABILITIES['trig-period'].params, ['fn', 'A', 'w', 'phi', 'k']);
  assert.deepStrictEqual(F.CAPABILITIES['trig-domain'].params, ['fn', 'A', 'w', 'phi', 'k']);
  assert.deepStrictEqual(F.CAPABILITIES['trig-monotonic'].params, ['fn', 'A', 'w', 'phi', 'k', 'xMin', 'xMax']);
  assert.deepStrictEqual(F.CAPABILITIES['trig-parity'].params, ['fn', 'A', 'w', 'phi', 'k']);
  ['trig-extremum', 'trig-period', 'trig-domain', 'trig-monotonic', 'trig-parity'].forEach(function (lab) {
    assert.strictEqual(F.CAP_TYPE[lab], 'trig', lab + ' 的 CAP_TYPE 应为 trig');
  });
});

test('5 lab × 全部 intent：intentSupported 成立且模板齐全（能渲染才收）', function () {
  Object.keys(F.capabilitiesFor('trig')).forEach(function (lab) {
    F.capabilityIntents(lab).forEach(function (it) {
      assert.ok(F.intentSupported(lab, it), lab + '/' + it + ' 应受支持');
      assert.ok(F.noteTemplate(lab, it), lab + '/' + it + ' 应有文案模板');
    });
  });
  assert.deepStrictEqual(Object.keys(F.capabilitiesFor('trig')).sort(),
    ['trig-domain', 'trig-extremum', 'trig-monotonic', 'trig-parity', 'trig-period'],
    'capabilitiesFor(trig) 应恰好 5 个画板（匹配层只喂这些）');
});

test('TYPE_DEF.trig：滑块键序 A / w / phi / k', function () {
  const def = F.TYPE_DEF.trig;
  assert.ok(def, 'TYPE_DEF.trig 必须存在（mount 靠它建滑块）');
  assert.deepStrictEqual(def.sliders.map(function (s) { return s.key; }), ['A', 'w', 'phi', 'k']);
  assert.ok(def.defaults && def.defaults.A === 1 && def.defaults.w === 1, '默认参数应含 A=1、w=1');
});

test('mount 对 trig 的 w=0 拒绝挂载（w 滑到 0 时画板收起，不是画一条水平线）', function () {
  const src = fs.readFileSync(path.join(__dirname, '..', 'diagnose', 'funclab.js'), 'utf8');
  assert.ok(/type === 'trig' && p\.w === 0/.test(src),
    'mount 必须在 trig 且 w=0 时返回 null（w=0 退化为常函数，画出来是错的）');
});

/* ================================================================
 * 5. 文案铁律：不印参数数值；period 的 T 例外；无「根」字；空参数可渲染
 * ================================================================ */

console.log('\n--- 5. 文案 ---');

const TRIG_PARAMS = { fn: 'sin', A: 1, w: 1, phi: 0, k: 0 };

test('trig-period 文案：印「一个周期 T = 2π」（w=2 时 T = π），除以 π 的商留白', function () {
  const s1 = F.noteText('trig-period', '最小正周期除以 π 后的值', TRIG_PARAMS);
  assert.ok(s1 && s1.indexOf('2π') >= 0, 'w=1 时文案应含「2π」：' + s1);
  assert.ok(s1.indexOf('一个周期') >= 0, '文案应说明「一个周期」：' + s1);
  const s2 = F.noteText('trig-period', '最小正周期除以 π 后的值', { fn: 'sin', A: 1, w: 2, phi: 0, k: 0 });
  assert.ok(s2.indexOf('T = π') >= 0, 'w=2 时文案应含「T = π」：' + s2);
  assert.ok(!/商\s*=\s*\d/.test(s1) && !/= 1\b/.test(s1), '除以 π 后的商是答案，文案不许报出来：' + s1);
  const s3 = F.noteText('trig-period', '最小正周期', TRIG_PARAMS);
  assert.ok(s3 && s3.indexOf('2π') >= 0, '「最小正周期」intent 同样印 T：' + s3);
});

test('trig-extremum 文案：最大值/最小值留白，不报 k±|A| 的数值', function () {
  const smax = F.noteText('trig-extremum', '最大值', TRIG_PARAMS);
  const smin = F.noteText('trig-extremum', '最小值', TRIG_PARAMS);
  assert.ok(/最大值/.test(smax) && /最小值/.test(smin), '文案必须落到最大/最小值');
  assert.ok(!/最大值\s*[=＝]\s*\d/.test(smax), '最大值数值不许出现在文案（A=1,k=0 时答案是 1）：' + smax);
  assert.ok(!/最小值\s*[=＝]\s*[-−]?\d/.test(smin), '最小值数值不许出现在文案：' + smin);
  assert.ok(smax.indexOf('1') < 0, 'A=1 时文案里不许出现数字 1（题面省略形态，1 不是已知量）：' + smax);
  assert.ok(smin.indexOf('-1') < 0 && smin.indexOf('−1') < 0, 'k-A = -1 是答案，不许出现：' + smin);
  const s2 = F.noteText('trig-extremum', '最大值', { fn: 'sin', A: 2, w: 1, phi: 0, k: 0 });
  assert.ok(!/最大值\s*[=＝]\s*2/.test(s2), '2·sin x 的最大值 2 不许直接报（要学生读）：' + s2);
});

test('trig-monotonic 文案：题面区间端点照印（π 记法），结论留白', function () {
  const s = F.noteText('trig-monotonic', '单调性', { fn: 'sin', A: 1, w: 1, phi: 0, k: 0, xMin: -PI / 2, xMax: PI / 2 });
  assert.ok(s.indexOf('-π/2') >= 0 && s.indexOf('π/2') >= 0, '区间端点应照印 π 记法：' + s);
  /* 「是增函数还是减函数」是提问；不许出现「是增函数。/是减函数。」这类下结论的句式 */
  assert.ok(!/是(增|减)函数[。！；]|为(增|减)函数/.test(s), '结论不许说死：' + s);
});

test('trig-parity 文案：讲「对折」与 f(-x)，不替学生下奇偶结论', function () {
  const s = F.noteText('trig-parity', '奇偶性', { fn: 'cos', A: 1, w: 1, phi: 0, k: 0 });
  assert.ok(s.indexOf('对折') >= 0, '读数动作是「对折」：' + s);
  assert.ok(/f\(-x\)/.test(s), '必须落到 f(-x) 的定义：' + s);
  assert.ok(!/是偶函数[。！]/.test(s), '不许直接替学生说「是偶函数」：' + s);
});

test('trig-domain 文案：讲断点/渐近线的读法，不报「全体实数」结论', function () {
  const s = F.noteText('trig-domain', '定义域', TRIG_PARAMS);
  assert.ok(s && s.length > 6, '定义域文案非空');
  assert.ok(/断|连续|渐近/.test(s), '必须讲断点/连续/渐近线的读法：' + s);
  assert.ok(s.indexOf('全体实数') < 0, '「全体实数」是答案（选择题），文案不许直接报：' + s);
  const s2 = F.noteText('trig-domain', '渐近线', { fn: 'tan', A: 1, w: 1, phi: 0, k: 0 });
  assert.ok(/渐近/.test(s2), 'tan 的渐近线 intent 有文案：' + s2);
});

test('非根 intent 的文案绝不出现「根」字（含「根据」这类词也在禁区）', function () {
  Object.keys(F.capabilitiesFor('trig')).forEach(function (lab) {
    F.capabilityIntents(lab).forEach(function (it) {
      const s = F.noteText(lab, it, TRIG_PARAMS);
      assert.ok(s, lab + '/' + it + ' 应有文案');
      assert.ok(s.indexOf('根') < 0, lab + '/' + it + ' 出现了「根」：' + s);
    });
  });
});

test('空参数调用文案非空、无 undefined、无占位符残留（审计扰动路径同款）', function () {
  Object.keys(F.capabilitiesFor('trig')).forEach(function (lab) {
    F.capabilityIntents(lab).forEach(function (it) {
      const s = F.noteText(lab, it, {});
      assert.ok(s && s.length > 6, lab + '/' + it + ' 空参数文案非空');
      assert.ok(s.indexOf('undefined') < 0 && !/\{\w+\}/.test(s), lab + '/' + it + ' 有未填占位符：' + s);
    });
  });
});

test('trig 文案不串台：不出现抛物线/双曲线等别的函数的专属名词', function () {
  Object.keys(F.capabilitiesFor('trig')).forEach(function (lab) {
    F.capabilityIntents(lab).forEach(function (it) {
      const s = F.noteText(lab, it, TRIG_PARAMS);
      assert.ok(s.indexOf('抛物线') < 0 && s.indexOf('双曲线') < 0, lab + '/' + it + ' 串台：' + s);
    });
  });
});

test('trig 文案里没有 A/w/phi/k 的数值（题面省略形态的 1/0 不是已知量）', function () {
  Object.keys(F.capabilitiesFor('trig')).forEach(function (lab) {
    F.capabilityIntents(lab).forEach(function (it) {
      const s = F.noteText(lab, it, TRIG_PARAMS);
      assert.ok(!/A\s*[=＝]\s*1/.test(s) && !/ω\s*[=＝]\s*1/.test(s) && !/φ\s*[=＝]\s*0/.test(s),
        lab + '/' + it + ' 不许印参数数值（归一化出来的 1/0 不在题面已知量集合里）：' + s);
    });
  });
});

/* ================================================================
 * 6. describe / paintModel：标注与描述同源
 * ================================================================ */

console.log('\n--- 6. describe ---');

test('trig-period 的 describe 含「一个周期 T = 2π」，w=2 时是「T = π」', function () {
  const d1 = F.describe('trig-period', '最小正周期除以 π 后的值', TRIG_PARAMS);
  assert.ok(d1, 'describe 非空');
  assert.ok(d1.indexOf('一个周期') >= 0, '应含「一个周期」：' + d1);
  assert.ok(d1.indexOf('T = 2π') >= 0, '应含「T = 2π」标注：' + d1);
  const d2 = F.describe('trig-period', '最小正周期除以 π 后的值', { fn: 'sin', A: 1, w: 2, phi: 0, k: 0 });
  assert.ok(d2.indexOf('T = π') >= 0, 'w=2 应标「T = π」：' + d2);
  assert.ok(d2.indexOf('T = 2π') < 0, 'w=2 不该再标 2π：' + d2);
});

test('trig-extremum 的 describe 不泄答案：A=1,k=0 时不含「1」，标注是「最大值 = ?」', function () {
  const d = F.describe('trig-extremum', '最大值', TRIG_PARAMS);
  assert.ok(d, 'describe 非空');
  assert.ok(d.indexOf('最大值 = ?') >= 0, '极值标注应留白「最大值 = ?」：' + d);
  assert.ok(d.indexOf('1') < 0, 'A=1,k=0 时最大值就是 1，describe 不许出现 1：' + d);
  const d2 = F.describe('trig-extremum', '最小值', TRIG_PARAMS);
  assert.ok(d2.indexOf('-1') < 0 && d2.indexOf('−1') < 0, '最小值 -1 不许出现：' + d2);
});

test('5 lab × 全部 intent 的 describe 都非空且含通用要素（坐标/实线/留白 ?）', function () {
  Object.keys(F.capabilitiesFor('trig')).forEach(function (lab) {
    F.capabilityIntents(lab).forEach(function (it) {
      const params = lab === 'trig-monotonic'
        ? Object.assign({}, TRIG_PARAMS, { xMin: -PI / 2, xMax: PI / 2 }) : TRIG_PARAMS;
      const d = F.describe(lab, it, params);
      assert.ok(d && d.length > 0, lab + '/' + it + ' describe 应非空');
      assert.ok(d.indexOf('坐标') >= 0, lab + '/' + it + ' 应含坐标平面');
      assert.ok(d.indexOf('实线') >= 0, lab + '/' + it + ' 应含实线描述');
      assert.ok(d.indexOf('?') >= 0, lab + '/' + it + ' 应含留白问号');
    });
  });
});

test('trig-monotonic 的 describe 含区间端点（π 记法，题面已知量）', function () {
  const d = F.describe('trig-monotonic', '单调性', { fn: 'sin', A: 1, w: 1, phi: 0, k: 0, xMin: -PI / 2, xMax: PI / 2 });
  assert.ok(d.indexOf('-π/2') >= 0, '应含端点 -π/2：' + d);
  assert.ok(d.indexOf('3π/2') < 0, '不该出现别的端点：' + d);
});

test('trig-parity 的 describe 讲「对折」与 y 轴；trig-domain(tan) 讲渐近线', function () {
  const dp = F.describe('trig-parity', '奇偶性', { fn: 'cos', A: 1, w: 1, phi: 0, k: 0 });
  assert.ok(dp.indexOf('对折') >= 0 && dp.indexOf('y 轴') >= 0, 'parity 描述应有对折与 y 轴：' + dp);
  const dd = F.describe('trig-domain', '渐近线', { fn: 'tan', A: 1, w: 1, phi: 0, k: 0 });
  assert.ok(dd.indexOf('渐近') >= 0, 'tan 渐近线描述：' + dd);
  const ds = F.describe('trig-domain', '定义域', TRIG_PARAMS);
  assert.ok(/连续|断/.test(ds), 'sin 定义域描述应讲连续/断点：' + ds);
});

/* ================================================================
 * 7. labAnswerParts / answerRows：答案行的真实值
 * ================================================================ */

console.log('\n--- 7. 答案行 ---');

test('trig-extremum：最大值 k+|A|、最小值 k-|A|', function () {
  const p = { fn: 'sin', A: 2, w: 1, phi: 0, k: 1 };
  const rmax = F.labAnswerParts('trig-extremum', '最大值', p);
  assert.strictEqual(rmax.length, 1);
  assert.strictEqual(rmax[0].kind, 'scalar');
  assert.strictEqual(rmax[0].values[0], 3);
  const rmin = F.labAnswerParts('trig-extremum', '最小值', p);
  assert.strictEqual(rmin[0].values[0], -1);
  /* A 取绝对值：A=-2 时最值上下界仍是 k±2 */
  const rneg = F.labAnswerParts('trig-extremum', '最大值', { fn: 'sin', A: -2, w: 1, phi: 0, k: 1 });
  assert.strictEqual(rneg[0].values[0], 3);
});

test('trig-period：最小正周期 T、除以 π 后的商 T/π', function () {
  const p1 = { fn: 'sin', A: 1, w: 1, phi: 0, k: 0 };
  const t1 = F.labAnswerParts('trig-period', '最小正周期', p1);
  assert.strictEqual(t1.length, 1);
  assert.ok(Math.abs(t1[0].values[0] - 2 * PI) < 1e-9, 'w=1 时 T = 2π');
  const d1 = F.labAnswerParts('trig-period', '最小正周期除以 π 后的值', p1);
  assert.ok(Math.abs(d1[0].values[0] - 2) < 1e-9, 'w=1 时 T/π = 2');
  const d2 = F.labAnswerParts('trig-period', '最小正周期除以 π 后的值', { fn: 'sin', A: 1, w: 2, phi: 0, k: 0 });
  assert.ok(Math.abs(d2[0].values[0] - 1) < 1e-9, 'w=2 时 T/π = 1');
  const d3 = F.labAnswerParts('trig-period', '最小正周期除以 π 后的值', { fn: 'sin', A: 1, w: 3, phi: 0, k: 0 });
  assert.ok(Math.abs(d3[0].values[0] - 2 / 3) < 1e-9, 'w=3 时 T/π = 2/3');
  /* tan 的周期是 π：T = π/|w| */
  const dt = F.labAnswerParts('trig-period', '最小正周期除以 π 后的值', { fn: 'tan', A: 1, w: 2, phi: 0, k: 0 });
  assert.ok(Math.abs(dt[0].values[0] - 0.5) < 1e-9, 'tan w=2 时 T/π = 1/2');
});

test('trig-domain / monotonic / parity 不是数值题：答案行为空（不许硬凑）', function () {
  assert.deepStrictEqual(F.labAnswerParts('trig-domain', '定义域', TRIG_PARAMS), []);
  assert.deepStrictEqual(F.labAnswerParts('trig-domain', '渐近线', TRIG_PARAMS), []);
  assert.deepStrictEqual(F.labAnswerParts('trig-monotonic', '单调性',
    Object.assign({}, TRIG_PARAMS, { xMin: -PI / 2, xMax: PI / 2 })), []);
  assert.deepStrictEqual(F.labAnswerParts('trig-parity', '奇偶性', TRIG_PARAMS), []);
  assert.deepStrictEqual(F.answerRows('trig-parity', '奇偶性', TRIG_PARAMS), []);
});

test('answerRows：extremum/period 给输入行，real 是真值、yours 恒空', function () {
  const rows = F.answerRows('trig-extremum', '最大值', { fn: 'sin', A: 2, w: 1, phi: 0, k: 1 });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].real, 3);
  assert.strictEqual(rows[0].yours, '');
  const rows2 = F.answerRows('trig-period', '最小正周期除以 π 后的值', { fn: 'sin', A: 1, w: 2, phi: 0, k: 0 });
  assert.ok(Math.abs(rows2[0].real - 1) < 1e-9, 'w=2 的商是 1');
  /* 学生填 1 应判对（checkAnswerRow 走 numEqual 口径） */
  const v = F.checkAnswerRow(rows2[0], '1');
  assert.strictEqual(v.verdict, 'right', '学生填 1 应判对，实际 ' + JSON.stringify(v));
});

test('labAnswerParts 对不完整参数返回 []（绝不猜）', function () {
  assert.deepStrictEqual(F.labAnswerParts('trig-extremum', '最大值', {}), []);
  assert.deepStrictEqual(F.labAnswerParts('trig-period', '最小正周期', { fn: 'sin' }), []);
  assert.deepStrictEqual(F.labAnswerParts('trig-extremum', '最大值', { fn: 'sin', A: 1, w: 0, phi: 0, k: 0 }), []);
});

/* ================================================================
 * 8. verifyParams / buildCfg：fn 是字符串，不参与 Number()
 * ================================================================ */

console.log('\n--- 8. 匹配层 ---');

test('fn 特判：字符串参数能过「参数齐全」检查（不被 Number() 打成 NaN 拒掉）', function () {
  const item = q('cnm_h066_q1');
  const v = L.verifyParams(item.prompt, {
    match: 'trig-extremum', intent: '最大值',
    params: { fn: 'sin', A: 1, w: 1, phi: 0, k: 0 }
  }, { itemId: item.id });
  assert.strictEqual(v.ok, true, JSON.stringify(v.why));
});

test('fn 非法值拒绝：sec / 数字 / 缺失都不行', function () {
  const item = q('cnm_h066_q1');
  ['sec', 'SIN', 1, null].forEach(function (bad) {
    const params = { fn: bad, A: 1, w: 1, phi: 0, k: 0 };
    const v = L.verifyParams(item.prompt, { match: 'trig-extremum', intent: '最大值', params: params }, { itemId: item.id });
    assert.strictEqual(v.ok, false, 'fn=' + JSON.stringify(bad) + ' 必须被拒');
  });
  const v2 = L.verifyParams(item.prompt, {
    match: 'trig-extremum', intent: '最大值', params: { A: 1, w: 1, phi: 0, k: 0 }
  }, { itemId: item.id });
  assert.strictEqual(v2.ok, false, '缺 fn 必须被拒');
});

test('fn 不符拒绝：题面是 cos，LLM 给 sin → 代回校验拦下', function () {
  const item = q('cnm_h068_q4');   // y=cos x 的奇偶性
  const v = L.verifyParams(item.prompt, {
    match: 'trig-parity', intent: '奇偶性',
    params: { fn: 'sin', A: 1, w: 1, phi: 0, k: 0 }
  }, { itemId: item.id });
  assert.strictEqual(v.ok, false, 'fn 代回不符必须拒绝');
  assert.ok(/fn|函数名|代回/.test(v.why.join(';')), '拒绝理由应指向 fn：' + v.why.join(';'));
});

test('trig 的 w=0 拒绝（LLM 给 w=0 不是三角函数）', function () {
  const item = q('cnm_h066_q1');
  const v = L.verifyParams(item.prompt, {
    match: 'trig-extremum', intent: '最大值',
    params: { fn: 'sin', A: 1, w: 0, phi: 0, k: 0 }
  }, { itemId: item.id });
  assert.strictEqual(v.ok, false, 'w=0 必须被拒');
});

test('trig 参数代回：A/w/phi/k 逐项比对，给错就拒', function () {
  const item = q('cnm_h075_q1');   // y=2sin x
  const bad = L.verifyParams(item.prompt, {
    match: 'trig-extremum', intent: '最大值',
    params: { fn: 'sin', A: 3, w: 1, phi: 0, k: 0 }
  }, { itemId: item.id });
  assert.strictEqual(bad.ok, false, 'A=3 ≠ 题面 2 必须被拒');
  assert.ok(/代回/.test(bad.why.join(';')), '拒绝理由应是代回不符：' + bad.why.join(';'));
});

test('buildCfg 透传 fn 字符串（不 Number() 成 NaN），产出可挂载配置', function () {
  const cfg = L.buildCfg('trig', { type: 'trig' }, {
    match: 'trig-extremum', intent: '最大值',
    params: { fn: 'sin', A: 1, w: 1, phi: 0, k: 0 }
  });
  assert.ok(cfg, 'buildCfg 应产出配置');
  assert.strictEqual(cfg.fn, 'sin', 'fn 必须原样是字符串 sin');
  assert.strictEqual(cfg.A, 1);
  assert.strictEqual(cfg.lab, 'trig-extremum');
});

test('缓存条目校验 validEntry 认字符串 fn（trig 缓存不至于永远失效）', function () {
  assert.strictEqual(L.validEntry({
    match: 'trig-extremum', intent: '最大值',
    params: { fn: 'sin', A: 1, w: 1, phi: 0, k: 0 }
  }), true, '含字符串 fn 的合法缓存条目应通过 validEntry');
  assert.strictEqual(L.validEntry({
    match: 'trig-extremum', intent: '最大值',
    params: { fn: 'sin', A: NaN, w: 1, phi: 0, k: 0 }
  }), false, '数值参数 NaN 仍应拒绝');
});

/* ================================================================
 * 9. promptInterval：π 端点（旧行为逐字不变）
 * ================================================================ */

console.log('\n--- 9. 区间 ---');

test('promptInterval 认 π 端点：[−π/2，π/2] / [π/2，3π/2] / [0，2π] / -π/2<x<π/2', function () {
  assert.deepStrictEqual(L.promptInterval('y=sin x 在 [−π/2，π/2] 上是？'), { xMin: -PI / 2, xMax: PI / 2 });
  assert.deepStrictEqual(L.promptInterval('y=sin x 在 [π/2，3π/2] 上整体是？'), { xMin: PI / 2, xMax: 3 * PI / 2 });
  assert.deepStrictEqual(L.promptInterval('y=sin x 在 [0，2π] 上的最大值'), { xMin: 0, xMax: 2 * PI });
  assert.deepStrictEqual(L.promptInterval('当 -π/2<x<π/2 时'), { xMin: -PI / 2, xMax: PI / 2 });
  assert.deepStrictEqual(L.promptInterval('x∈[−2π，2π]'), { xMin: -2 * PI, xMax: 2 * PI });
  assert.deepStrictEqual(L.promptInterval('x∈[π/3，5π/6]'), { xMin: PI / 3, xMax: 5 * PI / 6 });
});

test('整数/小数区间的旧行为逐字不变（含全角与反例）', function () {
  assert.deepStrictEqual(L.promptInterval('当 2<x<4 时'), { xMin: 2, xMax: 4 });
  assert.deepStrictEqual(L.promptInterval('x∈[−1，2]'), { xMin: -1, xMax: 2 });
  assert.deepStrictEqual(L.promptInterval('在 [0，3] 上'), { xMin: 0, xMax: 3 });
  assert.deepStrictEqual(L.promptInterval('当 ０＜x＜２ 时'), { xMin: 0, xMax: 2 });
  assert.strictEqual(L.promptInterval('点 P(−1，2) 在抛物线 y=x² 上'), null, '圆括号是坐标不是区间');
  assert.strictEqual(L.promptInterval('[0，+∞) 上单调递增'), null, '无界区间仍不认');
  assert.strictEqual(L.promptInterval('已知 f(x)=x²+1，x 轴交点有几个？'), null, '全角逗号但非区间仍 null');
});

test('π 端点反例：点坐标 (π/2，1) 圆括号 → null；端点次序颠倒 → null', function () {
  assert.strictEqual(L.promptInterval('点 P(π/2，1) 在曲线上'), null);
  assert.strictEqual(L.promptInterval('x∈[3π/2，π/2]'), null, '右端不大于左端');
});

/* ================================================================
 * 10. 答案语义门禁：answer-gate 的 trig 分支
 * ================================================================ */

console.log('\n--- 10. 门禁 ---');

test('annotationValues 的 trig 分支：k±|A|、T、T/π 都进标注集合', function () {
  const ann = GATE.annotationValues({ type: 'trig', fn: 'sin', A: 1, w: 1, phi: 0, k: 0 });
  ['1', '-1', String(Number((2 * PI).toFixed(6))), '2'].forEach(function (v) {
    assert.ok(ann.has(v), '标注集合应含 ' + v + '，实际 {' + Array.from(ann).join(',') + '}');
  });
  const ann2 = GATE.annotationValues({ type: 'trig', fn: 'sin', A: 2, w: 2, phi: 0, k: 1 });
  assert.ok(ann2.has('3') && ann2.has('-1'), 'k±|A| = 3/-1');
  assert.ok(ann2.has('1'), 'T/π = 1');
});

test('9 题 misfitOf 全部 null（答案都能从画板语义读出）', function () {
  const bad = [];
  LEDGER.forEach(function (c) {
    const item = q(c.id);
    const p = F.fromPrompt(item.prompt);
    assert.ok(p && p.type === 'trig', c.id + ' 应解析出 trig');
    const why = GATE.misfitOf(item, p);
    if (why) bad.push(c.id + '：' + why);
  });
  assert.deepStrictEqual(bad, [], bad.join(' / '));
});

test('h069_q4（tan 90° 没有定义）即使解析出 trig 也过不了门禁', function () {
  const item = q('cnm_h069_q4');
  const p = F.fromPrompt(item.prompt);
  assert.ok(p && p.type === 'trig', 'y=tan x 现在解析得出（这正是要门禁挡的原因）');
  const why = GATE.misfitOf(item, p);
  assert.ok(why, 'h069_q4 必须被门禁挡下');
  assert.ok(/不是可读数字|没有定义/.test(why), '拒绝理由应说明答案不可从图上读：' + why);
});

test('31 条冒充题：能解析出参数的也要被语义门禁全挡（答案不在图上）', function () {
  const passed = [];
  MISLEADING.forEach(function (id) {
    const item = q(id);
    let p = F.fromPrompt(item.prompt);
    if (!p && F.hsItemKind(id)) p = F.fromPrompt(F.hsPromptAlias(item.prompt));
    if (!p) return;                                 // 解析不出的由 labFor 白名单闸挡
    if (!GATE.misfitOf(item, p)) passed.push(id);   // 门禁放行 = 漏过
  });
  assert.deepStrictEqual(passed, [], '这些题蒙过了语义门禁：' + passed.join(','));
});

/* ================================================================
 * 11. 2902 行修正：focus.rootCount 与 intentKey 同口径
 * ================================================================ */

console.log('\n--- 11. rootCount 字面量 ---');

test('intentKey 归一化：「与 x 轴交点的个数」→「与x轴交点的个数」', function () {
  assert.strictEqual(F.intentKey('与 x 轴交点的个数'), '与x轴交点的个数');
  assert.strictEqual(F.intentKey('与x轴交点的个数'), '与x轴交点的个数');
});

test('funclab.js 源码里带空格的「与 x 轴交点的个数」清零（canAnswer/NOTE_INTENT/注释一起）', function () {
  const src = fs.readFileSync(path.join(__dirname, '..', 'diagnose', 'funclab.js'), 'utf8');
  assert.ok(src.indexOf('与 x 轴交点的个数') < 0,
    '带空格字面量是比较永远 false 的源头（2902 行 bug），全文件（含注释）都必须用无空格写法');
  assert.ok(/rootCount: type === 'quadratic' && intent === '与x轴交点的个数'/.test(src),
    'focus.rootCount 必须用归一化后的字面量比较');
});

test('canAnswer / NOTE_INTENT / labAnswerParts 三处口径一致（无空格键）', function () {
  assert.ok(F.CAPABILITIES['quadratic-roots'].canAnswer.indexOf('与x轴交点的个数') >= 0,
    'canAnswer 应含无空格的「与x轴交点的个数」');
  assert.ok(F.noteTemplate('quadratic-roots', '与x轴交点的个数'), 'NOTE_INTENT 应有无空格键的模板');
  assert.ok(F.noteText('quadratic-roots', '与 x 轴交点的个数', { a: 1, h: 0, k: 1 }),
    '带空格的 intent 调用仍能命中模板（intentKey 归一化）');
  const rows = F.answerRows('quadratic-roots', '与x轴交点的个数', { a: 1, h: 0, k: 1 });
  assert.strictEqual(rows.length, 1, '答案行仍能产出（disc<0 → 0）');
  assert.strictEqual(rows[0].real, 0);
});

/* ================================================================
 * 12. 审计预演：三角 9 题进 audit 后零泄漏
 * ================================================================ */

console.log('\n--- 12. 审计 ---');

test('audit_funclab_notes 全库跑：三角 9 题零泄漏（「2π」的 2 走结构常量口径）', function () {
  const out = execFileSync('node', [path.join(__dirname, '..', 'scripts', 'audit_funclab_notes.js'), '--json'],
    { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  const rep = JSON.parse(out);
  assert.deepStrictEqual(rep.leaks, [], '全库审计必须零泄漏（共 ' + rep.leaks.length + ' 处）：'
    + rep.leaks.map(function (l) { return l.id + '/' + l.intent + '→' + l.value; }).join('; '));
  /* 三角 9 题确实进了审计（有文案被检查），而不是靠「没挂上」绕过检查：
   * noteCount 基线 613（批1.6 实测）+ 三角 5 道可判题 × 8 个 intent 组合 ≈ 40 条 */
  assert.ok(rep.noteCount > 640, '审计条数应比批1.6 基线（613）多出三角部分，实际 ' + rep.noteCount);
  const trigIds = LEDGER.map(function (c) { return c.id; });
  const trigUndecidable = (rep.undecidable || []).filter(function (u) { return trigIds.indexOf(u.id) >= 0; });
  /* h066_q4/h067_q1/h067_q4/h068_q4 是选择题（答案字母），进「无法判定」是预期口径 */
  ['cnm_h066_q4', 'cnm_h067_q1', 'cnm_h067_q4', 'cnm_h068_q4'].forEach(function (id) {
    assert.ok(trigUndecidable.some(function (u) { return u.id === id; }),
      id + ' 是选择题，应进「无法判定」名单（不参与数值审计）');
  });
});

/* ================================================================
 * 汇总
 * ================================================================ */

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exitCode = failed ? 1 : 0;
