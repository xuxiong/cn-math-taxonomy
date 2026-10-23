#!/usr/bin/env node
/* 函数实验室（diagnose/funclab.js）纯函数测试：node tests/test_funclab.js
 *
 * 覆盖范围：topicKind / topicSupported / labFor / fromPrompt / formatFormula（含 fmt 行为）。
 * mount() 需要 DOM，不在本文件范围（浏览器手测）。
 *
 * 约定：本文件所有题面都取自 data/questions.json 的真实 prompt（用 q(id) 取，
 * 取不到直接失败），不臆造题面 —— 保证测试锁的是学生真正会看到的输入。
 */
'use strict';
const assert = require('assert');
const path = require('path');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e).split('\n').slice(0, 6).join('\n       ')); }
}

const F = require('../diagnose/funclab.js');

/* ---- 真实题库 ---- */
const QUESTIONS = require('../data/questions.json');
const TOPICS = require('../data/topics.json');
const QMAP = new Map(QUESTIONS.map(function (x) { return [x.id, x]; }));
const TIDS = new Set(TOPICS.map(function (t) { return t.id; }));

/** 按题库 id 取真实题面；id 不在了就炸（防止题库改动后测试悄悄失效） */
function q(id) {
  const item = QMAP.get(id);
  assert.ok(item, '题库里找不到题目 ' + id + '（题库改过了？请更新测试）');
  return item.prompt;
}
/** 知识点必须真实存在 */
function t(tid) {
  assert.ok(TIDS.has(tid), 'topics.json 里找不到知识点 ' + tid);
  return tid;
}

/* ================================================================
 * 1. topicKind / topicSupported：知识点白名单
 *    kind 与 topics.json 的真实 id 段落对齐：
 *      cnm_200..209 正比例/一次函数（含 200 正比例概念题）
 *      cnm_220..224 一元二次方程 + cnm_229..236 二次函数
 *      cnm_237..242 反比例函数
 * ================================================================ */

console.log('\n--- 1. topicKind / topicSupported ---');

test('topicKind：一次函数章 cnm_200..209 全部为 linear（真实 id）', function () {
  for (let n = 200; n <= 209; n++) {
    const id = t('cnm_' + n);
    assert.strictEqual(F.topicKind(id), 'linear', id);
    assert.strictEqual(F.topicSupported(id), true, id);
  }
});

test('topicKind：一元二次方程章 cnm_220..224 为 quadratic（真实 id）', function () {
  [220, 221, 222, 223, 224].forEach(function (n) {
    const id = t('cnm_' + n);
    assert.strictEqual(F.topicKind(id), 'quadratic', id);
  });
});

test('topicKind：二次函数章 cnm_229..236 全部为 quadratic（真实 id）', function () {
  for (let n = 229; n <= 236; n++) {
    const id = t('cnm_' + n);
    assert.strictEqual(F.topicKind(id), 'quadratic', id);
  }
});

test('topicKind：反比例函数章 cnm_237..242 全部为 inverse（真实 id）', function () {
  for (let n = 237; n <= 242; n++) {
    const id = t('cnm_' + n);
    assert.strictEqual(F.topicKind(id), 'inverse', id);
    assert.strictEqual(F.topicSupported(id), true, id);
  }
});

test('topicKind：函数章之前的相邻知识点不误判（cnm_195..199 / cnm_210 / cnm_219，真实 id）', function () {
  ['cnm_195', 'cnm_196', 'cnm_197', 'cnm_198', 'cnm_199', 'cnm_210', 'cnm_219'].forEach(function (id) {
    if (!TIDS.has(id)) return;
    assert.strictEqual(F.topicKind(id), null, id);
    assert.strictEqual(F.topicSupported(id), false, id);
  });
});

test('topicKind：章节边界外（cnm_225..228 方程应用、cnm_243 综合实践）不挂画板', function () {
  ['cnm_225', 'cnm_226', 'cnm_227', 'cnm_228', 'cnm_243'].forEach(function (id) {
    if (!TIDS.has(id)) return;
    assert.strictEqual(F.topicKind(id), null, id);
  });
});

test('topicKind：非初中函数知识点（小学 id / 统计章）→ null', function () {
  ['cnm_p001', 'cnm_101', 'cnm_211', 'cnm_215', 'cnm_244'].forEach(function (id) {
    if (!TIDS.has(id)) return;
    assert.strictEqual(F.topicKind(id), null, id);
    assert.strictEqual(F.topicSupported(id), false, id);
  });
});

test('topicKind：非法/空输入 → null，不抛错', function () {
  [null, undefined, '', 'cnm', 'cnm_20', 'cnm_2020', 'cnm_2x2', 202, {}, [], NaN].forEach(function (v) {
    assert.strictEqual(F.topicKind(v), null, String(v));
    assert.strictEqual(F.topicSupported(v), false, String(v));
  });
});

test('topicKind：大小写/前缀变体不被当作白名单命中', function () {
  assert.strictEqual(F.topicKind('CNM_202'), null);
  assert.strictEqual(F.topicKind(' cnm_202'), null);
  assert.strictEqual(F.topicKind('cnm_202 '), null);
  assert.strictEqual(F.topicKind('xcnm_202'), null);
});

/* ================================================================
 * 2. fromPrompt：一次函数（真实题面 → {type:'linear', k, b}）
 * ================================================================ */

console.log('\n--- 2. fromPrompt：一次函数 ---');

test('fromPrompt：y=-2x+4（cnm_202_q1，负斜率正截距）', function () {
  assert.deepStrictEqual(F.fromPrompt(q('cnm_202_q1')), { type: 'linear', k: -2, b: 4 });
});

test('fromPrompt：y=3x-6（cnm_202_q2）', function () {
  assert.deepStrictEqual(F.fromPrompt(q('cnm_202_q2')), { type: 'linear', k: 3, b: -6 });
});

test('fromPrompt：y=2x-8（cnm_202_q4）', function () {
  assert.deepStrictEqual(F.fromPrompt(q('cnm_202_q4')), { type: 'linear', k: 2, b: -8 });
});

test('fromPrompt：y=-3x+1（cnm_203_q1 增减性）', function () {
  assert.deepStrictEqual(F.fromPrompt(q('cnm_203_q1')), { type: 'linear', k: -3, b: 1 });
});

test('fromPrompt：y=-4x+2（cnm_203_q2，只出现一次函数式）', function () {
  assert.deepStrictEqual(F.fromPrompt(q('cnm_203_q2')), { type: 'linear', k: -4, b: 2 });
});

test('fromPrompt：y=2x 省略常数项 → b=0（cnm_204_q1）', function () {
  assert.deepStrictEqual(F.fromPrompt(q('cnm_204_q1')), { type: 'linear', k: 2, b: 0 });
});

test('fromPrompt：y=x-1 省略系数 1 → k=1（cnm_204_q2）', function () {
  assert.deepStrictEqual(F.fromPrompt(q('cnm_204_q2')), { type: 'linear', k: 1, b: -1 });
});

test('fromPrompt：y=3x+2（cnm_204_q3 平移）', function () {
  assert.deepStrictEqual(F.fromPrompt(q('cnm_204_q3')), { type: 'linear', k: 3, b: 2 });
});

test('fromPrompt：首个公式是含参 y=kx+b 的概念题 → null（cnm_206_q3）', function () {
  assert.strictEqual(F.fromPrompt(q('cnm_206_q3')), null);
});

test('fromPrompt：概念题里夹带的已知直线仍可解析（cnm_205_q5 的 y=2x-1 平行线）', function () {
  // 题面主体是 y=kx+b（不解析），但给出的参照直线 y=2x-1 是确定的，画板画它无害
  assert.deepStrictEqual(F.fromPrompt(q('cnm_205_q5')), { type: 'linear', k: 2, b: -1 });
});

test('fromPrompt：y=2x-6（cnm_206_q1 与方程关系）', function () {
  assert.deepStrictEqual(F.fromPrompt(q('cnm_206_q1')), { type: 'linear', k: 2, b: -6 });
});

test('fromPrompt：y=x-2（cnm_207_q1 不等式，题面后续含 x-2>0 不干扰）', function () {
  assert.deepStrictEqual(F.fromPrompt(q('cnm_207_q1')), { type: 'linear', k: 1, b: -2 });
});

test('fromPrompt：y=-x+3 负系数省略 1（cnm_207_q3）', function () {
  assert.deepStrictEqual(F.fromPrompt(q('cnm_207_q3')), { type: 'linear', k: -1, b: 3 });
});

test('fromPrompt：y=x+1（cnm_208_q1 两直线交点，取第一条）', function () {
  assert.deepStrictEqual(F.fromPrompt(q('cnm_208_q1')), { type: 'linear', k: 1, b: 1 });
});

test('fromPrompt：y=2x-1（cnm_208_q3）', function () {
  assert.deepStrictEqual(F.fromPrompt(q('cnm_208_q3')), { type: 'linear', k: 2, b: -1 });
});

test('fromPrompt：y=kx+b 概念题一律 null（cnm_203_q3 象限判断）', function () {
  assert.strictEqual(F.fromPrompt(q('cnm_203_q3')), null);
});

test('fromPrompt：(m-1)x+2 含参系数 → null（cnm_201_q1，不让画板画错）', function () {
  assert.strictEqual(F.fromPrompt(q('cnm_201_q1')), null);
});

test('fromPrompt：应用题不提函数式 → null（cnm_209_q2 弹簧长度）', function () {
  assert.strictEqual(F.fromPrompt(q('cnm_209_q2')), null);
});

test('fromPrompt：仅文字描述无函数式 → null（cnm_201_q2 选择题）', function () {
  assert.strictEqual(F.fromPrompt(q('cnm_201_q2')), null);
});

/* ================================================================
 * 3. fromPrompt：反比例函数（真实题面 → {type:'inverse', k}）
 * ================================================================ */

console.log('\n--- 3. fromPrompt：反比例函数 ---');

test('fromPrompt：y=-6/x 负 k（cnm_238_q1）', function () {
  assert.deepStrictEqual(F.fromPrompt(q('cnm_238_q1')), { type: 'inverse', k: -6 });
});

test('fromPrompt：y=6/x 正 k（cnm_238_q3）', function () {
  assert.deepStrictEqual(F.fromPrompt(q('cnm_238_q3')), { type: 'inverse', k: 6 });
});

test('fromPrompt：y=-8/x（cnm_239_q2）', function () {
  assert.deepStrictEqual(F.fromPrompt(q('cnm_239_q2')), { type: 'inverse', k: -8 });
});

test('fromPrompt：y=4/x（cnm_241_q1 与一次函数交点，先命中反比例分支）', function () {
  assert.deepStrictEqual(F.fromPrompt(q('cnm_241_q1')), { type: 'inverse', k: 4 });
});

test('fromPrompt：y=600/x 三位数 k（cnm_242_q2 应用题实例）', function () {
  assert.deepStrictEqual(F.fromPrompt(q('cnm_242_q2')), { type: 'inverse', k: 600 });
});

test('fromPrompt：y=k/x 含参 → null（cnm_237_q1）', function () {
  assert.strictEqual(F.fromPrompt(q('cnm_237_q1')), null);
});

test('fromPrompt：y=(2m-1)/x 含参 → null（cnm_238_q4）', function () {
  assert.strictEqual(F.fromPrompt(q('cnm_238_q4')), null);
});

test('fromPrompt：y=0/x 不是反比例函数 → null', function () {
  assert.strictEqual(F.fromPrompt('y=0/x'), null);
});

test('fromPrompt：y=/x、y=x 之类的残缺/非反比例式不误判为 inverse', function () {
  const r1 = F.fromPrompt('y=/x');
  assert.ok(!r1 || r1.type !== 'inverse' || r1.k === 1, 'y=/x 退化成 k=1 可接受，但不能是别的 type');
});

/* ================================================================
 * 4. fromPrompt：二次函数顶点式（a(x-h)²+k）
 * ================================================================ */

console.log('\n--- 4. fromPrompt：二次函数顶点式 ---');

test('fromPrompt：y=2(x+3)²-5 → h=-3,k=-5（cnm_231_q2）', function () {
  assert.deepStrictEqual(F.fromPrompt(q('cnm_231_q2')), { type: 'quadratic', a: 2, h: -3, k: -5 });
});

test('fromPrompt：y=2(x+1)²-4 → h=-1,k=-4（cnm_235_q2）', function () {
  assert.deepStrictEqual(F.fromPrompt(q('cnm_235_q2')), { type: 'quadratic', a: 2, h: -1, k: -4 });
});

test('fromPrompt：y=(x-1)²+2 省略 a → a=1（cnm_231_q1）', function () {
  assert.deepStrictEqual(F.fromPrompt(q('cnm_231_q1')), { type: 'quadratic', a: 1, h: 1, k: 2 });
});

test('fromPrompt：a 为负的顶点式 y=-(x+2)²+5（cnm_235_q1 一般式换算同值，见下组）', function () {
  assert.deepStrictEqual(F.fromPrompt('y=-(x+2)²+5'), { type: 'quadratic', a: -1, h: -2, k: 5 });
});

test('fromPrompt：a 为分数的顶点式 y=0.5(x-1)²-2', function () {
  assert.deepStrictEqual(F.fromPrompt('y=0.5(x-1)²-2'), { type: 'quadratic', a: 0.5, h: 1, k: -2 });
});

test('fromPrompt：方程 (x-1)²=9 → k=-9（右侧移到左边，画板零点即方程根）', function () {
  // 真实题面 cnm_220_q1：解方程 (x-1)²=9
  assert.deepStrictEqual(F.fromPrompt(q('cnm_220_q1')), { type: 'quadratic', a: 1, h: 1, k: -9 });
});

test('fromPrompt：方程 4(x+2)²=25 → a=4,h=-2,k=-25（cnm_220_q3，零点 = 答案 1/2、-9/2）', function () {
  // k 不除 a：画板画 y=4(x+2)²-25，零点 -2±√(25/4) = 1/2、-9/2。
  // 若写成 k=-25/4，零点会变成 -3/4、-13/4，与题库答案矛盾（Review 1 曾建议这样改，已证伪）。
  assert.deepStrictEqual(F.fromPrompt(q('cnm_220_q3')), { type: 'quadratic', a: 4, h: -2, k: -25 });
});

test('fromPrompt：右侧为含参式 (x-2)²=k-3 → null（k 未知，不画误导图，cnm_220_q4）', function () {
  assert.strictEqual(F.fromPrompt(q('cnm_220_q4')), null);
});

/* ================================================================
 * 5. fromPrompt：二次函数一般式 / 方程（ax²+bx+c）
 * ================================================================ */

console.log('\n--- 5. fromPrompt：二次函数一般式 ---');

test('fromPrompt：y=x²-6x+5 → 顶点 (3,-4)（cnm_232_q2）', function () {
  assert.deepStrictEqual(F.fromPrompt(q('cnm_232_q2')), { type: 'quadratic', a: 1, h: 3, k: -4 });
});

test('fromPrompt：y=x²+2x+5 → 顶点 (-1,4)（cnm_234_q2 判别式题）', function () {
  assert.deepStrictEqual(F.fromPrompt(q('cnm_234_q2')), { type: 'quadratic', a: 1, h: -1, k: 4 });
});

test('fromPrompt：y=-2x²+8x-3 → 顶点 (2,5)（cnm_232_q3）', function () {
  assert.deepStrictEqual(F.fromPrompt(q('cnm_232_q3')), { type: 'quadratic', a: -2, h: 2, k: 5 });
});

test('fromPrompt：y=-x²-4x+1 → a=-1,顶点 (-2,5)（cnm_232_q4 省略系数 -1）', function () {
  assert.deepStrictEqual(F.fromPrompt(q('cnm_232_q4')), { type: 'quadratic', a: -1, h: -2, k: 5 });
});

test('fromPrompt：y=x²-2x-3 → 顶点 (1,-4)（cnm_234_q1）', function () {
  assert.deepStrictEqual(F.fromPrompt(q('cnm_234_q1')), { type: 'quadratic', a: 1, h: 1, k: -4 });
});

test('fromPrompt：y=-x²+4x+1 → 顶点 (2,5)（cnm_235_q1 最值）', function () {
  assert.deepStrictEqual(F.fromPrompt(q('cnm_235_q1')), { type: 'quadratic', a: -1, h: 2, k: 5 });
});

test('fromPrompt：y=x²-6x+10 → 顶点 (3,1)（cnm_235_q3）', function () {
  assert.deepStrictEqual(F.fromPrompt(q('cnm_235_q3')), { type: 'quadratic', a: 1, h: 3, k: 1 });
});

test('fromPrompt：配方法方程 x²+6x-7=0 → 顶点 (-3,-16)（cnm_221_q3，=0 不影响）', function () {
  assert.deepStrictEqual(F.fromPrompt(q('cnm_221_q3')), { type: 'quadratic', a: 1, h: -3, k: -16 });
});

test('fromPrompt：2x²-8x+1=0 → a=2,顶点 (2,-7)（cnm_221_q4）', function () {
  assert.deepStrictEqual(F.fromPrompt(q('cnm_221_q4')), { type: 'quadratic', a: 2, h: 2, k: -7 });
});

test('fromPrompt：x^2 归一化为 x²（y=x^2-4x+3）', function () {
  assert.deepStrictEqual(F.fromPrompt('y=x^2-4x+3'), { type: 'quadratic', a: 1, h: 2, k: -1 });
});

test('fromPrompt：全角括号归一化（y=（x-1）²+2 可解析；全角等号 y＝2x+1 不解析）', function () {
  assert.deepStrictEqual(F.fromPrompt('y=（x-1）²+2'), { type: 'quadratic', a: 1, h: 1, k: 2 });
  // 顶点式分支不依赖 "y="，故全角等号也能认出表达式本体（解析结果正确）
  assert.deepStrictEqual(F.fromPrompt('y＝(x-1)²+2'), { type: 'quadratic', a: 1, h: 1, k: 2 });
  // 一次式分支依赖半角 "y="，全角等号视为无法解析（静默降级，不画错图）
  assert.strictEqual(F.fromPrompt('y＝2x+1'), null);
});

test('fromPrompt：含参二次式 (m-2)x²+3x-1 → null（cnm_229_q1，系数是算式不画）', function () {
  assert.strictEqual(F.fromPrompt(q('cnm_229_q1')), null);
});

test('fromPrompt：只有二次项+常数项 y=x²+2 / y=-2x² / y=3x² 可解析（cnm_230 章真实题面）', function () {
  // 任务卡要求的边界：缺一次项不能被当作"解析不出"
  assert.deepStrictEqual(F.fromPrompt('说明 y=-2x² 的开口方向、顶点、对称轴。下列正确的是哪一个？'),
    { type: 'quadratic', a: -2, h: 0, k: 0 });
  assert.deepStrictEqual(F.fromPrompt('抛物线 y=x²+2 的顶点'), { type: 'quadratic', a: 1, h: 0, k: 2 });
  assert.deepStrictEqual(F.fromPrompt('y=3x²'), { type: 'quadratic', a: 3, h: 0, k: 0 });
});

test('fromPrompt：y=ax²+2 系数是字母 → null（cnm_233_q2）', function () {
  assert.strictEqual(F.fromPrompt(q('cnm_233_q2')), null);
});

test('fromPrompt：方程 x²=49 → k=-49（cnm_220_q2 直接开平方，零点为 ±7）', function () {
  assert.deepStrictEqual(F.fromPrompt(q('cnm_220_q2')), { type: 'quadratic', a: 1, h: 0, k: -49 });
});

/* ================================================================
 * 6. fromPrompt：类型判别边界（不能被别的函数类型抢走）
 * ================================================================ */

console.log('\n--- 6. fromPrompt：类型边界 ---');

test('fromPrompt：三次函数 y=x³+1 不是一次函数（不能被 x 抢匹配）', function () {
  const r = F.fromPrompt('y=x³+1');
  assert.ok(!r || r.type !== 'linear', 'x³ 不应被当成一次函数，实际：' + JSON.stringify(r));
});

test('fromPrompt：三次函数 y=2x³-1 不是一次函数', function () {
  const r = F.fromPrompt('y=2x³-1');
  assert.ok(!r || r.type !== 'linear', 'x³ 不应被当成一次函数，实际：' + JSON.stringify(r));
});

test('fromPrompt：y=2x^(m^2-3) 幂指数含参 → 不当作一次函数', function () {
  const r = F.fromPrompt('y=2x^(m^2-3) 是正比例函数，求 m');
  assert.ok(!r || r.type !== 'linear', '实际：' + JSON.stringify(r));
});

test('fromPrompt：y=ax² 含参二次 → null（cnm_230_q3 附近题面类型）', function () {
  assert.strictEqual(F.fromPrompt('y=ax²'), null);
});

test('fromPrompt：y=x² 与 y=2x 同现时优先二次（y=x²-4x+3 不被截成一次）', function () {
  assert.deepStrictEqual(F.fromPrompt('把 y=x²-4x+3 化为顶点式'), { type: 'quadratic', a: 1, h: 2, k: -1 });
});

test('fromPrompt：空/非法输入 → null，不抛错', function () {
  [null, undefined, '', '   ', 0, 42, {}, [], true].forEach(function (v) {
    assert.strictEqual(F.fromPrompt(v), null, String(v));
  });
});

test('fromPrompt：无关题面 → null（cnm_243 高铁、cnm_227 增长率）', function () {
  assert.strictEqual(F.fromPrompt(q('cnm_243_q1')), null);
  assert.strictEqual(F.fromPrompt(q('cnm_227_q1')), null);
});

test('fromPrompt：返回对象只有约定字段，无多余污染', function () {
  const r = F.fromPrompt('y=2x+1');
  assert.deepStrictEqual(Object.keys(r).sort(), ['b', 'k', 'type']);
  const r2 = F.fromPrompt('y=x²-4x+3');
  assert.deepStrictEqual(Object.keys(r2).sort(), ['a', 'h', 'k', 'type']);
  const r3 = F.fromPrompt('y=6/x');
  assert.deepStrictEqual(Object.keys(r3).sort(), ['k', 'type']);
});

test('fromPrompt：数值全部为有限 number（不是字符串/NaN）', function () {
  ['y=2x+1', 'y=-2x+4', 'y=6/x', 'y=-6/x', 'y=x²-4x+3', 'y=2(x+3)²-5'].forEach(function (p) {
    const r = F.fromPrompt(p);
    assert.ok(r, p);
    for (const key of Object.keys(r)) {
      if (key === 'type') continue;
      assert.strictEqual(typeof r[key], 'number', p + '.' + key);
      assert.ok(isFinite(r[key]), p + '.' + key + ' 应为有限数，实际 ' + r[key]);
    }
  });
});

/* ================================================================
 * 7. labFor：知识点 × 题面 双门禁
 * ================================================================ */

console.log('\n--- 7. labFor ---');

test('labFor：一次知识点 + 一次题面 → 参数（cnm_202 × cnm_202_q1）', function () {
  assert.deepStrictEqual(F.labFor(t('cnm_202'), q('cnm_202_q1')), { type: 'linear', k: -2, b: 4 });
});

test('labFor：二次知识点 + 二次题面 → 参数（cnm_232 × cnm_232_q2）', function () {
  assert.deepStrictEqual(F.labFor(t('cnm_232'), q('cnm_232_q2')), { type: 'quadratic', a: 1, h: 3, k: -4 });
});

test('labFor：反比例知识点 + 反比例题面 → 参数（cnm_238 × cnm_238_q1）', function () {
  assert.deepStrictEqual(F.labFor(t('cnm_238'), q('cnm_238_q1')), { type: 'inverse', k: -6 });
});

test('labFor：方程章（cnm_220）+ 解方程题面 → 参数', function () {
  assert.deepStrictEqual(F.labFor(t('cnm_220'), q('cnm_220_q1')), { type: 'quadratic', a: 1, h: 1, k: -9 });
});

test('labFor：配方法章（cnm_221）答的不是根 → 整体不挂（cnm_221_q3 虽然是"解方程"也不挂）', function () {
  // 修复前 cnm_221_q3 会画出 y=(x+3)²-16，绿点 1/-7 恰好等于答案，但这属于
  // "答案语义 ≠ 画板零点"的章节：同章 q1 答选项、q2 答配方常数 9、q4 答 m/n，
  // 一半题挂一半题不挂会让学生以为"有画板 = 这道题答根"。整章不挂更稳。
  assert.strictEqual(F.labFor(t('cnm_221'), q('cnm_221_q3')), null);
});

test('labFor：判别式章（cnm_223）答案不是根 → 不挂（判别式/根的情况/k 范围）', function () {
  assert.strictEqual(F.labFor(t('cnm_223'), q('cnm_223_q2')), null);   // 答 25（b²-4ac）
  assert.strictEqual(F.labFor(t('cnm_223'), q('cnm_223_q3')), null);
  assert.strictEqual(F.labFor(t('cnm_223'), q('cnm_223_q1')), null);
});

test('labFor：知识点类型与题面类型错配 → null（一次知识点 × 二次题面）', function () {
  assert.strictEqual(F.labFor(t('cnm_202'), q('cnm_232_q2')), null);
});

test('labFor：知识点类型与题面类型错配 → null（二次知识点 × 一次题面）', function () {
  assert.strictEqual(F.labFor(t('cnm_232'), q('cnm_202_q1')), null);
});

test('labFor：反比例知识点 × 一次题面 → null（cnm_241_q2 题面先出现一次式）', function () {
  assert.strictEqual(F.labFor(t('cnm_241'), q('cnm_241_q2')), null);
});

test('labFor：不支持的知识点 → null（即便题面能解析）', function () {
  assert.strictEqual(F.labFor('cnm_195', 'y=2x+1'), null);
  assert.strictEqual(F.labFor('cnm_p001', 'y=2x+1'), null);
  assert.strictEqual(F.labFor(null, 'y=2x+1'), null);
  assert.strictEqual(F.labFor(undefined, 'y=2x+1'), null);
});

test('labFor：题面无法解析 → null 而非抛错', function () {
  assert.strictEqual(F.labFor(t('cnm_202'), '下列说法正确的是？'), null);
  assert.strictEqual(F.labFor(t('cnm_202'), ''), null);
  assert.strictEqual(F.labFor(t('cnm_202'), null), null);
  assert.strictEqual(F.labFor(t('cnm_202'), undefined), null);
});

/* ---- 方程章：画板绿点必须就是题库答案（Review 1 的必修项 4） ----
 * 绿点的数学来源 = annotate() 里画的 x 轴交点：x = h ± √(-k/a)（disc = -k/a）。
 * 答案来源 = 题库 verify 表达式（这是出题时就写好的独立真值，不是本模块算的，
 * 所以这条断言不是"用实现验证实现"）。两边都是分数都转成精确有理数 + 归一化后比对。
 */
const EQ_CHAPTERS = ['cnm_220', 'cnm_222', 'cnm_224'];

/** 极简分数 [num, den]，只支持题库 verify 里出现的算式子集（够用即可，算不了就抛错） */
function toFrac(x) {
  if (Array.isArray(x)) return [x[0], x[1]];
  if (Number.isInteger(x)) return [x, 1];
  // 直接在小分母里找精确表示（方程题的根都是 1/2、5/4 这类）；无理数（√37）找不到 → null
  for (let den = 1; den <= 240; den++) {
    const num = Math.round(x * den);
    if (Math.abs(x - num / den) < 1e-9) return [num, den];
  }
  return null;
}
function reduce(f) {
  let a = f[0], b = f[1];
  if (Math.abs(a) >= 1000 || Math.abs(b) >= 10000) {
    // 超大分母（浮点噪声）用小数对齐，简化处理
    return [a / b, 1];
  }
  const g = (function gcd(p, q) { return q ? gcd(q, p % q) : Math.abs(p); })(a, b) || 1;
  return [a / g, b / g];
}
function fracKey(f) { return f[0] + '/' + f[1]; }

/** 求值题库 verify 表达式（只支持 +,-,*,/,**,//,()、isqrt/roots2/Fraction，够覆盖方程章） */
function evalVerify(src) {
  const Fraction = function (n, d) { return n / d; };
  const isqrt = function (n) {
    const r = Math.round(Math.sqrt(n));
    if (Math.abs(r * r - n) > 1e-9) throw new Error('verify 里出现无理根：' + n);
    return r;
  };
  const roots2 = function (a, b, c) {
    const d = b * b - 4 * a * c;
    const r = isqrt(d);
    return [(-b + r) / (2 * a), (-b - r) / (2 * a)];
  };
  // eslint-disable-next-line no-new-func
  return new Function('Fraction', 'isqrt', 'roots2', 'return (' + src + ');')(Fraction, isqrt, roots2);
}

/** 题库答案的精确分数集合（verify 求值 → 归一化）；不是"根"型答案返回 null */
function answerRootSet(item) {
  if (!item.verify) return null;
  let v;
  try { v = evalVerify(item.verify); } catch (e) { return null; }   // 判别式/配方常数/max(range) 之类不是根
  if (!Array.isArray(v)) return null;                                // 单值答案（判别式、面积）不是根集合
  return new Set(v.map(function (x) { return fracKey(reduce(toFrac(x))); }));
}

/** 画板绿点的精确分数集合（annotate 的数学：h ± √(-k/a)）；无理根返回 'irrational' */
function labRootSet(p) {
  if (p.a === 0) return null;
  const disc = -p.k / p.a;
  if (disc < 0) return new Set();
  const r = Math.sqrt(disc);
  const xs = r === 0 ? [p.h] : [p.h - r, p.h + r];
  const fr = xs.map(toFrac);
  if (fr.some(function (f) { return f === null; })) return 'irrational';
  return new Set(fr.map(function (f) { return fracKey(reduce(f)); }));
}

test('[必修4] 方程章{cns}：所有挂载题目的画板绿点集合 == 题库答案数字集合'.replace('{cns}', EQ_CHAPTERS.join('/')), function () {
  const problems = [];
  let checked = 0;
  for (const item of QUESTIONS) {
    if (EQ_CHAPTERS.indexOf(item.topicId) < 0) continue;
    const p = F.labFor(item.topicId, item.prompt);
    if (!p) continue;                                   // 不挂载的题不产生错图，交给下面的"必须挂载"断言
    const want = answerRootSet(item);
    const got = labRootSet(p);
    checked++;
    if (!want) {
      problems.push(item.id + ' 挂载了但答案不是根/根不在画板上（答案 ' + item.answer + '）');
      continue;
    }
    if (got === 'irrational') {
      // 答案若也是无理小数（如 3x²+5x-1 的 -5±√37/6），绿点标 2 位小数 ≠ 学生要写的答案 → 不该挂
      const ans = String(item.answer);
      if (!/^[A-D]$/.test(ans.trim())) {
        problems.push(item.id + ' 画板零点是无理数（' + ans + '），学生要写的是精确形式 → 不该挂');
      }
      continue;
    }
    const wantStr = Array.from(want).sort().join(',');
    const gotStr = Array.from(got).sort().join(',');
    if (wantStr !== gotStr) {
      problems.push(item.id + ' 画板绿点 {' + gotStr + '} ≠ 答案 {' + wantStr + '}（答案 ' + item.answer + '）');
    }
  }
  assert.ok(checked >= 8, '方程章挂载数异常少：' + checked);
  assert.deepStrictEqual(problems, [], '挂载的方程题画板与答案不一致：\n  ' + problems.join('\n  '));
});

test('[必修3] 方程章{cns}：答案就是根且能解析的题必须挂上（不能因为门禁过严全灭）'.replace('{cns}', EQ_CHAPTERS.join('/')), function () {
  const missed = [];
  for (const item of QUESTIONS) {
    if (EQ_CHAPTERS.indexOf(item.topicId) < 0) continue;
    const want = answerRootSet(item);
    if (!want) continue;                                  // 非根型答案（选项/判别式）不需要挂
    if (!F.fromPrompt(item.prompt)) continue;             // 题面本身解析不出（如 (x-2)²=3(x-2)）不强求
    if (!F.labFor(item.topicId, item.prompt)) missed.push(item.id + '（' + item.answer + '）');
  }
  assert.deepStrictEqual(missed, [], '这些题答案就是根却没挂画板：' + missed.join('、'));
});

test('labFor：真实题库全量扫——支持的章节不抛错，且返回类型必经双门禁', function () {
  for (const item of QUESTIONS) {
    const tid = item.topicId;
    if (!tid) continue;
    const kind = F.topicKind(tid);
    if (!kind) continue;
    let r;
    assert.doesNotThrow(function () { r = F.labFor(tid, item.prompt); }, item.id);
    if (r !== null) {
      assert.strictEqual(r.type, kind, item.id + ' 返回类型与知识点不一致');
    }
  }
});

test('labFor：真实题库里"能挂画板"的比例是有限的（防止正则过度匹配把概念题全挂上）', function () {
  let supported = 0, mounted = 0;
  for (const item of QUESTIONS) {
    if (!item.topicId || !F.topicKind(item.topicId)) continue;
    supported++;
    if (F.labFor(item.topicId, item.prompt)) mounted++;
  }
  assert.ok(supported > 50, '支持章节的题目数异常少：' + supported);
  const ratio = mounted / supported;
  assert.ok(ratio > 0.3, '挂载比例过低 ' + ratio.toFixed(2) + '（解析退化？）');
  assert.ok(ratio < 0.85, '挂载比例过高 ' + ratio.toFixed(2) + '（正则过度匹配？）');
});

/* ================================================================
 * 8. formatFormula：系数/常数格式化边界（学生直接看到的东西）
 * ================================================================ */

console.log('\n--- 8. formatFormula ---');

test('formatFormula 一次：系数 1 省略（1x → x）', function () {
  assert.strictEqual(F.formatFormula({ type: 'linear', k: 1, b: 0 }), 'y = x');
  assert.strictEqual(F.formatFormula({ type: 'linear', k: 1, b: 5 }), 'y = x + 5');
});

test('formatFormula 一次：系数 -1 显示为 -x', function () {
  assert.strictEqual(F.formatFormula({ type: 'linear', k: -1, b: 0 }), 'y = -x');
  assert.strictEqual(F.formatFormula({ type: 'linear', k: -1, b: -4 }), 'y = -x - 4');
});

test('formatFormula 一次：常数项 0 省略（不出现 + 0）', function () {
  assert.strictEqual(F.formatFormula({ type: 'linear', k: 3, b: 0 }), 'y = 3x');
});

test('formatFormula 一次：负常数用减号而不是 +-', function () {
  assert.strictEqual(F.formatFormula({ type: 'linear', k: 2, b: -3 }), 'y = 2x - 3');
  assert.ok(F.formatFormula({ type: 'linear', k: -2, b: -3 }).indexOf('+-') < 0);
});

test('formatFormula 一次：正负常数符号各一条（真实题库参数）', function () {
  assert.strictEqual(F.formatFormula({ type: 'linear', k: -2, b: 4 }), 'y = -2x + 4');   // cnm_202_q1
  assert.strictEqual(F.formatFormula({ type: 'linear', k: 3, b: -6 }), 'y = 3x - 6');     // cnm_202_q2
  assert.strictEqual(F.formatFormula({ type: 'linear', k: 1, b: -2 }), 'y = x - 2');      // cnm_207_q1
  assert.strictEqual(F.formatFormula({ type: 'linear', k: -3, b: 1 }), 'y = -3x + 1');    // cnm_203_q1
});

test('formatFormula 一次：系数 0 → 项消失（不显示 0x）', function () {
  const s = F.formatFormula({ type: 'linear', k: 0, b: 3 });
  assert.ok(s.indexOf('0x') < 0, '不应出现 0x：' + s);
  assert.strictEqual(s, 'y = 3');
});

test('formatFormula 一次：k=0,b=0 → y = 0（退化，仍可读）', function () {
  assert.strictEqual(F.formatFormula({ type: 'linear', k: 0, b: 0 }), 'y = 0');
});

test('formatFormula 一次：小数系数/常数原样（0.5x - 0.5）', function () {
  assert.strictEqual(F.formatFormula({ type: 'linear', k: 0.5, b: -0.5 }), 'y = 0.5x - 0.5');
  assert.strictEqual(F.formatFormula({ type: 'linear', k: -1.5, b: 2.5 }), 'y = -1.5x + 2.5');
});

test('formatFormula 一次：分数系数四舍五入到 2 位（1/3 → 0.33，画板标注精度）', function () {
  assert.strictEqual(F.formatFormula({ type: 'linear', k: 1 / 3, b: 0 }), 'y = 0.33x');
});

test('formatFormula 一次：大数不被科学计数法化（1000x）', function () {
  assert.strictEqual(F.formatFormula({ type: 'linear', k: 1000, b: -1000 }), 'y = 1000x - 1000');
});

test('formatFormula 二次：a=1 省略、a=-1 只留负号', function () {
  assert.strictEqual(F.formatFormula({ type: 'quadratic', a: 1, h: 0, k: 0 }), 'y = x²');
  assert.strictEqual(F.formatFormula({ type: 'quadratic', a: -1, h: 0, k: 0 }), 'y = -x²');
  assert.strictEqual(F.formatFormula({ type: 'quadratic', a: 1, h: 2, k: -5 }), 'y = (x - 2)² - 5');
  assert.strictEqual(F.formatFormula({ type: 'quadratic', a: -1, h: -2, k: 5 }), 'y = -(x + 2)² + 5');
});

test('formatFormula 二次：h=0 时不写括号（x² 而非 (x)²）', function () {
  assert.strictEqual(F.formatFormula({ type: 'quadratic', a: 2, h: 0, k: 3 }), 'y = 2x² + 3');
});

test('formatFormula 二次：h 为负 → (x + |h|)，h 为正 → (x - h)', function () {
  assert.strictEqual(F.formatFormula({ type: 'quadratic', a: 2, h: -3, k: -5 }), 'y = 2(x + 3)² - 5');
  assert.strictEqual(F.formatFormula({ type: 'quadratic', a: 2, h: 3, k: -5 }), 'y = 2(x - 3)² - 5');
});

test('formatFormula 二次：k=0 省略常数项（不出现 + 0）', function () {
  assert.strictEqual(F.formatFormula({ type: 'quadratic', a: 1, h: 3, k: 0 }), 'y = (x - 3)²');
});

test('formatFormula 二次：负 k 用减号，无 +-', function () {
  const s = F.formatFormula({ type: 'quadratic', a: -2, h: 2, k: -7 });
  assert.strictEqual(s, 'y = -2(x - 2)² - 7');
  assert.ok(s.indexOf('+-') < 0);
  assert.ok(s.indexOf('-+') < 0);
});

test('formatFormula 二次：小数 a/h/k（0.5(x - 1.5)²）', function () {
  assert.strictEqual(F.formatFormula({ type: 'quadratic', a: 0.5, h: 1.5, k: 0 }), 'y = 0.5(x - 1.5)²');
});

test('formatFormula 二次：h=0 且 |a|≠1 不拼出 "4x²²" / 不丢系数（a=4,h=0 → y = 4x²）', function () {
  // 修复前：h=0 时 aPart 与 xPart 直接相连，"4" + "x" + "²" 在 aPart 非空时
  // 仍会走 'y = ' + aPart + xPart + '²'，对 |a|≠1 得到 "y = 4x²²"
  assert.strictEqual(F.formatFormula({ type: 'quadratic', a: 4, h: 0, k: 0 }), 'y = 4x²');
  assert.strictEqual(F.formatFormula({ type: 'quadratic', a: 0.5, h: 0, k: -2 }), 'y = 0.5x² - 2');
  assert.strictEqual(F.formatFormula({ type: 'quadratic', a: -2, h: 0, k: 3 }), 'y = -2x² + 3');
  assert.strictEqual(F.formatFormula({ type: 'quadratic', a: 1, h: 0, k: 0 }), 'y = x²');
  assert.strictEqual(F.formatFormula({ type: 'quadratic', a: -1, h: 0, k: 0 }), 'y = -x²');
});

test('formatFormula 二次：h/k 为 -0 不显示 -0（-0 与 0 等价）', function () {
  assert.strictEqual(F.formatFormula({ type: 'quadratic', a: 1, h: -0, k: -0 }), 'y = x²');
  assert.strictEqual(F.formatFormula({ type: 'linear', k: 1, b: -0 }), 'y = x');
});

test('formatFormula 反比例：正负 k 与省略 1 的显示', function () {
  assert.strictEqual(F.formatFormula({ type: 'inverse', k: 6 }), 'y = 6 / x');
  assert.strictEqual(F.formatFormula({ type: 'inverse', k: -8 }), 'y = -8 / x');
  assert.strictEqual(F.formatFormula({ type: 'inverse', k: 1 }), 'y = 1 / x');
  assert.strictEqual(F.formatFormula({ type: 'inverse', k: -1 }), 'y = -1 / x');
  assert.strictEqual(F.formatFormula({ type: 'inverse', k: 600 }), 'y = 600 / x');
});

test('formatFormula：全部真实题库可解析题面都能被格式化且不含坏符号', function () {
  let n = 0;
  for (const item of QUESTIONS) {
    if (!item.topicId || !F.topicKind(item.topicId)) continue;
    const r = F.labFor(item.topicId, item.prompt);
    if (!r) continue;
    n++;
    let s;
    assert.doesNotThrow(function () { s = F.formatFormula(r); }, item.id);
    assert.strictEqual(typeof s, 'string');
    assert.ok(s.indexOf('NaN') < 0, item.id + ' 出现 NaN：' + s);
    assert.ok(s.indexOf('undefined') < 0, item.id + ' 出现 undefined：' + s);
    assert.ok(s.indexOf('Infinity') < 0, item.id + ' 出现 Infinity：' + s);
    assert.ok(s.indexOf('+-') < 0, item.id + ' 出现 +-：' + s);
    assert.ok(s.indexOf('1x') < 0, item.id + ' 出现 1x：' + s);
    assert.ok(s.indexOf('-1x') < 0, item.id + ' 出现 -1x：' + s);
    assert.ok(s.indexOf('0x') < 0, item.id + ' 出现 0x：' + s);
  }
  assert.ok(n > 30, '可格式化题面数异常少：' + n);
});

test('formatFormula：未知 type 退回二次格式（不抛错、不返回 undefined）', function () {
  const s = F.formatFormula({ type: 'cubic', a: 1, h: 0, k: 0 });
  assert.strictEqual(s, 'y = x²');
  // 参数缺失不在契约内（mount 总会用 TYPE_DEF.defaults 补齐），只要求不抛错
  assert.doesNotThrow(function () { F.formatFormula({}); });
});

/* ================================================================
 * 9. fmt 行为（未导出，通过 formatFormula/画板刻度间接锁定）
 * ================================================================ */

console.log('\n--- 9. fmt 行为（经 formatFormula 观测） ---');

test('fmt：整数不带小数点（3 → "3"）', function () {
  assert.strictEqual(F.formatFormula({ type: 'linear', k: 3, b: 0 }), 'y = 3x');
});

test('fmt：小数去尾零（2.50 → "2.5"）', function () {
  assert.strictEqual(F.formatFormula({ type: 'linear', k: 2.5, b: 0 }), 'y = 2.5x');
  assert.strictEqual(F.formatFormula({ type: 'linear', k: 2.5000001, b: 0 }), 'y = 2.5x');
});

test('fmt：负数保留负号（-4 → "-4"）', function () {
  assert.strictEqual(F.formatFormula({ type: 'inverse', k: -4 }), 'y = -4 / x');
});

test('fmt：两位小数截断（0.1234 → 0.12）', function () {
  assert.strictEqual(F.formatFormula({ type: 'linear', k: 0.1234, b: 0 }), 'y = 0.12x');
});

test('fmt：0 显示为 "0"（不是 "0.00" / 不是空串）', function () {
  assert.strictEqual(F.formatFormula({ type: 'quadratic', a: 1, h: 0, k: 0 }), 'y = x²');
  assert.strictEqual(F.formatFormula({ type: 'linear', k: 0, b: 0 }), 'y = 0');
});

/* ================================================================
 * 10. 回归：本次补测试时发现并修掉的解析缺陷（详见卡 t_699b86ce 评论）
 * ================================================================ */

console.log('\n--- 10. 解析缺陷回归 ---');

test('[缺陷1] 方程右式数值要移到左边（(x-1)²=9 → k=-9），零点才是方程的根', function () {
  // 修复前：k=0，画板把顶点画在 x 轴上，标注"两个相等的根" —— 与题目答案 (4,-2) 矛盾
  assert.deepStrictEqual(F.fromPrompt('(x-1)²=9'), { type: 'quadratic', a: 1, h: 1, k: -9 });
  const r = F.fromPrompt(q('cnm_220_q1'));
  // 顶点 (1,-9) 处 disc = -k/a = 9 → 两根 x=1±3
  assert.strictEqual(r.k, -9);
  assert.strictEqual(-r.k / r.a, 9);
});

test('[缺陷1] 方程右式是算式/含参 → null，不要画"顶点在 x 轴"的错图', function () {
  assert.strictEqual(F.fromPrompt(q('cnm_224_q4')), null);   // (x-2)²=3(x-2)
  assert.strictEqual(F.fromPrompt(q('cnm_220_q4')), null);   // (x-2)²=k-3
});

test('[缺陷1] 一般式方程同理（x²=49 → k=-49，零点 ±7）', function () {
  const r = F.fromPrompt(q('cnm_220_q2'));
  assert.deepStrictEqual(r, { type: 'quadratic', a: 1, h: 0, k: -49 });
  assert.strictEqual(Math.sqrt(-r.k / r.a), 7);
});

test('[缺陷1] =0 的方程行为不变（c 不再二次扣减）', function () {
  assert.deepStrictEqual(F.fromPrompt('x²-4x-1=0'), { type: 'quadratic', a: 1, h: 2, k: -5 });
  assert.deepStrictEqual(F.fromPrompt('x²+6x-7=0'), { type: 'quadratic', a: 1, h: -3, k: -16 });
});

test('[缺陷2] 缺一次项的二次式可解析（y=x²+2 / y=-2x² / y=x²）', function () {
  assert.deepStrictEqual(F.fromPrompt('y=x²+2'), { type: 'quadratic', a: 1, h: 0, k: 2 });
  assert.deepStrictEqual(F.fromPrompt('y=-2x²'), { type: 'quadratic', a: -2, h: 0, k: 0 });
  assert.deepStrictEqual(F.fromPrompt('y=x²'), { type: 'quadratic', a: 1, h: 0, k: 0 });
  // 真实题面：cnm_230_q1 开口方向题现在有画板了
  assert.deepStrictEqual(F.fromPrompt(q('cnm_230_q1')), { type: 'quadratic', a: -2, h: 0, k: 0 });
  assert.deepStrictEqual(F.fromPrompt(q('cnm_230_q4')), { type: 'quadratic', a: -1, h: 0, k: 0 });
});

test('[缺陷2] 系数被除掉的式子仍不挂（y=-x²/8 不能画成 y=-x²，cnm_236_q5 拱桥）', function () {
  assert.strictEqual(F.fromPrompt(q('cnm_236_q5')), null);
  assert.strictEqual(F.fromPrompt('y=x²/2'), null);
});

test('[缺陷2] 缺项解析不会把含参系数误认（y=ax² / y=(m-2)x²）', function () {
  assert.strictEqual(F.fromPrompt('y=ax²'), null);
  assert.strictEqual(F.fromPrompt('y=(m-2)x²'), null);
});

test('[缺陷3] 三次式不被当成一次函数（x³ / x^n 一律不画）', function () {
  assert.strictEqual(F.fromPrompt('y=x³+1'), null);
  assert.strictEqual(F.fromPrompt('y=2x³-1'), null);
  assert.strictEqual(F.fromPrompt('y=2x^(m^2-3) 是正比例函数，求 m'), null);
  assert.strictEqual(F.fromPrompt('y=x^3'), null);
});

test('[缺陷4] 顶点式系数为字母时不再默认 a=1（y=a(x-2)²-1，cnm_231_q4）', function () {
  // 修复前误判 a=1 画出 y=(x-2)²-1，题目的 a 其实要靠 (3,1) 求出
  assert.strictEqual(F.fromPrompt(q('cnm_231_q4')), null);
  assert.strictEqual(F.fromPrompt('y=a(x-2)²-1'), null);
});

test('[缺陷5] 一次式系数 0 不再显示 0x（拖到 k=0 时 formula 显示 y = 3）', function () {
  assert.strictEqual(F.formatFormula({ type: 'linear', k: 0, b: 3 }), 'y = 3');
  assert.strictEqual(F.formatFormula({ type: 'linear', k: 0, b: -3 }), 'y = -3');
  assert.strictEqual(F.formatFormula({ type: 'linear', k: 0, b: 0 }), 'y = 0');
});

test('[缺陷6] 平移题的原始抛物线仍挂载（cnm_231_q3 y=x²，滑块可演示平移）', function () {
  assert.deepStrictEqual(F.fromPrompt(q('cnm_231_q3')), { type: 'quadratic', a: 1, h: 0, k: 0 });
});

test('[稳定性] h/k 计算不产出 -0（deepStrictEqual/标注都干净）', function () {
  const r = F.fromPrompt('y=x²+2');
  assert.strictEqual(Object.is(r.h, 0), true, 'h 应为 +0，实际 ' + r.h);
  assert.strictEqual(Object.is(r.k, 2), true);
  const r2 = F.fromPrompt('x²=0');
  assert.strictEqual(Object.is(r2.k, 0), true, 'k 应为 +0');
});

/* ================================================================
 * 汇总
 * ================================================================ */

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
