#!/usr/bin/env node
/* 高中函数画板 批4：三次多项式族 + S= 窄门 —— 第 1 段（解析 + 答案门禁）
 *   node tests/test_funclab_hs_batch4.js
 *
 * 本文件当前只锁「解析层 + answer-gate 的 cubic 分支」：
 *   · 4 道实面题（h225_q1 / h228_q2 / h035_q2 / h229_q2）的 fromPrompt 结果，题面从
 *     data/questions.json 实取，不臆造；
 *   · 三次正例全表（含参数逐项 deepStrictEqual）；
 *   · 三次反例：x^4 仍归 power、/x 与字母系数一律 null；两道导数题面保持原 quadratic 解析；
 *   · S= 窄门：面积式展开 / 视同 y= 的别名 / 反例；无 S= 的同类式行为不变；
 *   · answer-gate cubic：y=x³−3x 的驻点 ±1 进入标注集合。
 *
 * ======================= TODO（第 2 段补的测试组） =======================
 *   5. 白名单组：HS_ITEMS 恰好 34 条，旧 30 条逐字不动（OLD30 表复用），4 条新增类型正确；
 *      族计数：二次 12 / 一次 3 / 反比例 1 / 三角 9 / 指数 3 / 对数 4 / 三次 2 = 34。
 *   6. 画板组：CAP_TYPE 两块都是 cubic；TYPE_DEF.cubic 的 params/sliders/defaults 逐字；
 *      cubic-parity / cubic-extremum 的 intentSupported；paintModel 双 intent 的元素用词；
 *      真 mount（batch3 的 fake DOM）两块非 null、canvas 正尺寸、note 文案在、
 *      state().focus.cubicParity / cubicExtremum 为 true。
 *   7. 文案审计：两块 note 与两条 NOTE_INTENT 零 `**`；`奇函数/偶函数/原点对称` 零出现；
 *      cubic-parity 的 note / NOTE_INTENT 零 `/奇|偶/`；h225_q1 / h228_q2 的
 *      quadratic-vertex noteText 不出独立数字 2 / 5；h229_q2 不出独立 1 / -1 / −1。
 *   8. 门禁组（补全）：31 条 misleading 仍全挡、h221_q2 仍挡（cubic 的 annotationValues
 *      断言已在本段写好）。
 *   9. 197 题零改动：git show d155a60:diagnose/funclab.js 取旧版，遍历全库比对
 *      「旧版非 null 的题，新版 JSON 逐字相同」，并打印 null→非 null 的新增清单。
 *   另：labmatch.verifyParams 的 cubic 分支（2.6）在本段之后单独补测。
 * ======================================================================
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

/* ================================================================
 * 1. 4 题实面：fromPrompt 认得出、类型与参数对得上（题面运行时读，不复制）
 * ================================================================ */

console.log('\n--- 1. 4 题实面 fromPrompt ---');

test('4 题实面逐题解析，参数逐项对上', function () {
  assert.deepStrictEqual(F.fromPrompt(q('cnm_h225_q1').prompt),
    { type: 'quadratic', a: 1, h: 2, k: -4 });
  assert.deepStrictEqual(F.fromPrompt(q('cnm_h228_q2').prompt),
    { type: 'quadratic', a: -1, h: 5, k: 25 });
  assert.deepStrictEqual(F.fromPrompt(q('cnm_h035_q2').prompt),
    { type: 'cubic', a: 1, b: 0, c: 0, d: 0 });
  assert.deepStrictEqual(F.fromPrompt(q('cnm_h229_q2').prompt),
    { type: 'cubic', a: 1, b: 0, c: -3, d: 0 });
});

/* ================================================================
 * 2. 三次正例全表
 * ================================================================ */

console.log('\n--- 2. 三次正例 ---');

test('y=x³ / y=x^3：a=1，其余项补 0', function () {
  const want = { type: 'cubic', a: 1, b: 0, c: 0, d: 0 };
  assert.deepStrictEqual(F.fromPrompt('y=x³'), want);
  assert.deepStrictEqual(F.fromPrompt('y=x^3'), want);
});

test('缺项补 0 / 负号 / 单项：y=x³−3x / y=x³+1 / y=-x³+x / y=2x³', function () {
  assert.deepStrictEqual(F.fromPrompt('y=x³−3x'),
    { type: 'cubic', a: 1, b: 0, c: -3, d: 0 });
  assert.deepStrictEqual(F.fromPrompt('y=x³+1'),
    { type: 'cubic', a: 1, b: 0, c: 0, d: 1 });
  assert.deepStrictEqual(F.fromPrompt('y=-x³+x'),
    { type: 'cubic', a: -1, b: 0, c: 1, d: 0 });
  assert.deepStrictEqual(F.fromPrompt('y=2x³'),
    { type: 'cubic', a: 2, b: 0, c: 0, d: 0 });
});

test('四项齐全：y=2x^3-3x^2+1（不再被既有二次通道截走）', function () {
  assert.deepStrictEqual(F.fromPrompt('y=2x^3-3x^2+1'),
    { type: 'cubic', a: 2, b: -3, c: 0, d: 1 });
});

test('f(x)= 前缀：f(x)=x³−3x', function () {
  assert.deepStrictEqual(F.fromPrompt('f(x)=x³−3x'),
    { type: 'cubic', a: 1, b: 0, c: -3, d: 0 });
});

/* ================================================================
 * 3. 三次反例 + 既有行为兼容锁
 * ================================================================ */

console.log('\n--- 3. 三次反例 / 兼容锁 ---');

test('y=x^4 仍归 power（三次头只认 ^3）', function () {
  assert.deepStrictEqual(F.fromPrompt('y=x^4'), { type: 'power', a: 1, p: 4 });
});

test('/x 与字母系数：y=x³+1/x / y=ax³ 一律 null', function () {
  assert.strictEqual(F.fromPrompt('y=x³+1/x'), null);
  assert.strictEqual(F.fromPrompt('y=ax³'), null);
});

test('尾部中文说明不参与判型：y=x³−3x，x>0 时… 仍解析为 cubic', function () {
  /* 实际结果：仍为 cubic（是否挂载由 labmatch 的 intent/参数闸挡，不在解析层判）。 */
  assert.deepStrictEqual(F.fromPrompt('y=x³−3x，x>0 时 f(x) 的最小值是多少？'),
    { type: 'cubic', a: 1, b: 0, c: -3, d: 0 });
});

test('兼容锁：导数题面 cnm_h217_q2 仍必须解析成 quadratic', function () {
  assert.deepStrictEqual(F.fromPrompt(q('cnm_h217_q2').prompt),
    { type: 'quadratic', a: 3, h: 0, k: 0 });
});

test('兼容锁：导数题面 cnm_h220_q3 仍必须解析成 quadratic', function () {
  assert.deepStrictEqual(F.fromPrompt(q('cnm_h220_q3').prompt),
    { type: 'quadratic', a: 3, h: 0, k: 0 });
});

/* ================================================================
 * 4. S= 窄门
 * ================================================================ */

console.log('\n--- 4. S= 窄门 ---');

test('面积式展开：S=x(10-x) / S=x(10−x) → 顶点式 a=-1,h=5,k=25', function () {
  const want = { type: 'quadratic', a: -1, h: 5, k: 25 };
  assert.deepStrictEqual(F.fromPrompt('S=x(10-x)'), want);
  assert.deepStrictEqual(F.fromPrompt('S=x(10−x)'), want);
});

test('乘号与因子在后的写法：S=x*(10−x) / S=(10-x)x', function () {
  const want = { type: 'quadratic', a: -1, h: 5, k: 25 };
  assert.deepStrictEqual(F.fromPrompt('S=x*(10−x)'), want);
  assert.deepStrictEqual(F.fromPrompt('S=(10-x)x'), want);
});

test('视同 y= 的窄别名：S=2x+1 → linear；S=1/x → inverse', function () {
  assert.deepStrictEqual(F.fromPrompt('S=2x+1'), { type: 'linear', k: 2, b: 1 });
  assert.deepStrictEqual(F.fromPrompt('S=1/x'), { type: 'inverse', k: 1 });
});

test('反例：S=kx → null；S=x(10-x)/2 → null（不是面积式，别读成 y=x）', function () {
  assert.strictEqual(F.fromPrompt('S=kx'), null);
  assert.strictEqual(F.fromPrompt('S=x(10-x)/2'), null);
});

test('无 S= 的同类式不受影响：y=x(10-x) 仍是既有 linear 行为', function () {
  assert.deepStrictEqual(F.fromPrompt('y=x(10-x)'), { type: 'linear', k: 1, b: 0 });
});

/* ================================================================
 * 8（门禁部分）. answer-gate 的 cubic 分支
 * ================================================================ */

console.log('\n--- 8. 答案语义门禁（cubic 分支） ---');

test('annotationValues(cubic)：y=x³−3x 的驻点 1 与 -1 都在集合里', function () {
  const vals = GATE.annotationValues(F.fromPrompt('y=x³−3x'));
  assert.ok(vals.has('1'), '驻点 1 应在标注集合，实际 {' + Array.from(vals).join(',') + '}');
  assert.ok(vals.has('-1'), '驻点 -1 应在标注集合，实际 {' + Array.from(vals).join(',') + '}');
  assert.deepStrictEqual(Array.from(vals).sort(), ['-1', '1']);
});

test('annotationValues(cubic)：判别式 =0 的退化驻点不算极值（y=x³ → 空集）', function () {
  /* y=x³ 的 f'(x)=3x²=0 只有 x=0，且两侧不变号 —— 不是「转折点」，画板不标；
     这条同时保证 cnm_h035_q4（答案 0）不会被数值巧合放行。 */
  assert.deepStrictEqual(Array.from(GATE.annotationValues(F.fromPrompt('y=x³'))), []);
});

/* ================================================================ */

console.log('\n== ' + passed + ' passed / ' + failed + ' failed ==');
process.exit(failed ? 1 : 0);
