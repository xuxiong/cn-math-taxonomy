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

test('labFor：配方法章（cnm_221）只有 q3（答案就是根）放行，q1/q2/q4 不挂', function () {
  // 逐题白名单，不是整章：q1 答选项 C、q2 答配方常数 9、q4 答 m/n —— 画板与答案无关；
  // 而 q3「用配方法解方程 x²+6x-7=0」的答案 1、-7 就是画板的两个绿点，不挂等于丢了准确图。
  assert.deepStrictEqual(F.labFor(t('cnm_221'), q('cnm_221_q3'), { itemId: 'cnm_221_q3' }),
    { type: 'quadratic', a: 1, h: -3, k: -16 });
  assert.strictEqual(F.labFor(t('cnm_221'), q('cnm_221_q1'), { itemId: 'cnm_221_q1' }), null);
  assert.strictEqual(F.labFor(t('cnm_221'), q('cnm_221_q2'), { itemId: 'cnm_221_q2' }), null);
  assert.strictEqual(F.labFor(t('cnm_221'), q('cnm_221_q4'), { itemId: 'cnm_221_q4' }), null);
});

test('labFor：章级封禁必须靠 itemId 才放行 —— 不给 itemId 时 cnm_221 一律不挂（含 q3）', function () {
  // app.js 传 {itemId: q.id}；不传就退化成最保守的"整章不挂"，不会因为缺参而误挂同章非根题
  assert.strictEqual(F.labFor(t('cnm_221'), q('cnm_221_q3')), null);
  assert.strictEqual(F.labFor(t('cnm_221'), q('cnm_221_q3'), {}), null);
  assert.strictEqual(F.labFor(t('cnm_221'), q('cnm_221_q3'), { itemId: 'cnm_221_q1' }), null);
});

test('labFor：白名单按题目粒度生效 —— 把 q3 题面挂到未放行的 cnm_223 章仍不挂', function () {
  assert.strictEqual(F.labFor(t('cnm_223'), q('cnm_221_q3'), { itemId: 'cnm_221_q3' }), null);
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
 *
 * 扫描集合 = 一切可能挂画板的一元二次方程章，**含 cnm_221（配方法）**。
 * 曾把 cnm_221 排除在外，于是"答案就是根却因整章封禁不挂"的误伤（cnm_221_q3）
 * 永远不可能被断言发现 —— 扫描集合必须与 chapter 判定同源。
 */
const EQ_CHAPTERS = ['cnm_220', 'cnm_221', 'cnm_222', 'cnm_223', 'cnm_224'];

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

/** 题库答案的精确分数集合（verify 求值 → 归一化）；不是"根"型答案返回 null
 *  answer 形如 "1，-7" / "2，-1/2" 才算根；含 m/n 之类字母（"m=2，n=7"）不是根集合。 */
function answerRootSet(item) {
  if (!item.verify) return null;
  if (/[a-zA-Z]/.test(String(item.answer))) return null;
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
  EQ_CHAPTERS.forEach(function (tid) { assert.ok(t(tid)); });   // 扫描集合里的章必须真实存在
  for (const item of QUESTIONS) {
    if (EQ_CHAPTERS.indexOf(item.topicId) < 0) continue;
    const p = F.labFor(item.topicId, item.prompt, { itemId: item.id });
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
  assert.ok(checked >= 9, '方程章挂载数异常少：' + checked);
  assert.ok(EQ_CHAPTERS.indexOf('cnm_221') >= 0, '扫描集合必须含配方法章，否则整章封禁的误伤不可见');
  // cnm_221 只有 q3 是"答案就是根"的题，它必须落在 checked 里（绿点已与答案对上）
  const q3 = QMAP.get('cnm_221_q3');
  assert.ok(F.labFor('cnm_221', q3.prompt, { itemId: 'cnm_221_q3' }), 'cnm_221_q3 答案 1、-7 就是绿点，必须挂载');
  assert.deepStrictEqual(problems, [], '挂载的方程题画板与答案不一致：\n  ' + problems.join('\n  '));
});

/** 整章封禁（答案语义与画板零点无关的章）：cnm_221 只有个例放行、cnm_223 整章（判别式/根的情况/k 范围） */
const EQ_CHAPTER_BANNED = ['cnm_221', 'cnm_223'];

test('[必修3] 方程章{cns}：答案就是根的题必须挂上（不能因为门禁过严全灭）'.replace('{cns}', EQ_CHAPTERS.join('/')), function () {
  const missed = [];
  for (const item of QUESTIONS) {
    if (EQ_CHAPTERS.indexOf(item.topicId) < 0) continue;
    if (EQ_CHAPTER_BANNED.indexOf(item.topicId) >= 0) continue;   // 整章不放行的章不要求挂（cnm_221_q3 由下面单独锁）
    const want = answerRootSet(item);
    if (!want) continue;                                  // 非根型答案（选项/判别式）不需要挂
    if (!F.fromPrompt(item.prompt)) continue;             // 题面本身解析不出（如 (x-2)²=3(x-2)）不强求
    if (!F.labFor(item.topicId, item.prompt, { itemId: item.id })) missed.push(item.id + '（' + item.answer + '）');
  }
  assert.deepStrictEqual(missed, [], '这些题答案就是根却没挂画板：' + missed.join('、'));
});

test('[必修3b] 个例放行的题（cnm_221_q3）也必须在扫描范围内，且答案集合 == 绿点集合', function () {
  const item = QMAP.get('cnm_221_q3');
  assert.ok(item, '题库里找不到 cnm_221_q3');
  const want = answerRootSet(item);
  assert.ok(want, 'cnm_221_q3 的答案应当是根集合');
  const p = F.labFor(item.topicId, item.prompt, { itemId: item.id });
  assert.ok(p, 'cnm_221_q3 答案 1、-7 就是绿点，不该被整章封禁误伤');
  const got = labRootSet(p);
  assert.deepStrictEqual(Array.from(got).sort(), Array.from(want).sort(), '绿点 ≠ 答案');
});

test('[必修3c] 必挂的根型题不允许被误伤：每一章里"答案=根"且可解析的题逐题校验', function () {
  // 按 item.verify 是否为 Array 判根型（独立于答案文字），对已放行章做逐题正断言
  const missed = [];
  for (const item of QUESTIONS) {
    if (EQ_CHAPTERS.indexOf(item.topicId) < 0) continue;
    if (EQ_CHAPTER_BANNED.indexOf(item.topicId) >= 0) continue;
    if (!item.verify) continue;
    let v;
    try { v = evalVerify(item.verify); } catch (e) { continue; }
    if (!Array.isArray(v)) continue;
    if (!F.fromPrompt(item.prompt)) continue;
    if (!F.labFor(item.topicId, item.prompt, { itemId: item.id })) missed.push(item.id);
  }
  assert.deepStrictEqual(missed, [], '根型题被门禁误伤：' + missed.join('、'));
});

test('labFor：真实题库全量扫——支持的章节不抛错，且返回类型必经双门禁', function () {
  for (const item of QUESTIONS) {
    const tid = item.topicId;
    if (!tid) continue;
    const kind = F.topicKind(tid);
    if (!kind) continue;
    let r;
    assert.doesNotThrow(function () { r = F.labFor(tid, item.prompt, { itemId: item.id }); }, item.id);
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
    if (F.labFor(item.topicId, item.prompt, { itemId: item.id })) mounted++;
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
    const r = F.labFor(item.topicId, item.prompt, { itemId: item.id });
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
  // (x-2)²=3(x-2) 原先是 null（那时解析器不会移项展开）；E 卡补上展开后它可解，
  // 且零点 2、5 == 题库答案（由 [E-3]/[E-4] 与必修4 的绿点扫描共同锁定），故改为精确断言。
  assert.deepStrictEqual(F.fromPrompt(q('cnm_224_q4')), { type: 'quadratic', a: 1, h: 3.5, k: -2.25 });
  // 右侧真的含参（k 未知）的仍然 null —— 这类题画什么曲线都是猜
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

test('[缺陷10] 放行 cnm_221_q3 后，q4 的"配方成 2(x-m)²=n 的形式"仍不挂（求的是 m/n，不是根）', function () {
  // q4 的题面能解析出 {a:2,h:2,k:-7}，但画板会把 k=-7 当作"n"，而正确答案是 n=+7（方向相反），
  // 绿点 0.13/3.87 与答案 m=2、n=7 毫无关系 → 必须由形态门禁挡住。
  const prompt = q('cnm_221_q4');
  assert.deepStrictEqual(F.fromPrompt(prompt), { type: 'quadratic', a: 2, h: 2, k: -7 });
  assert.strictEqual(F.labFor('cnm_221', prompt, { itemId: 'cnm_221_q4' }), null);
  // 同一题面放到已放行章 cnm_222 也必须被挡住：门禁不能只依赖章白名单
  assert.strictEqual(F.labFor('cnm_222', prompt), null);
  // 用能解析的等价题面再锁一次"…的形式"判定本身
  assert.deepStrictEqual(F.fromPrompt('把 2x²-8x+1=0 配方成 2(x-m)²=n 的形式'), { type: 'quadratic', a: 2, h: 2, k: -7 });
  assert.strictEqual(F.labFor('cnm_222', '把 2x²-8x+1=0 配方成 2(x-m)²=n 的形式'), null);
});

test('[缺陷10b] 形态门禁不误伤正常题面：以「解方程」「用配方法解」开头的题照常挂载', function () {
  assert.deepStrictEqual(F.labFor('cnm_221', q('cnm_221_q3'), { itemId: 'cnm_221_q3' }), { type: 'quadratic', a: 1, h: -3, k: -16 });
  assert.deepStrictEqual(F.labFor('cnm_222', q('cnm_222_q2'), { itemId: 'cnm_222_q2' }), { type: 'quadratic', a: 1, h: 0.5, k: -6.25 });
});

/* ================================================================
 * 11. E 卡：fromPrompt 解析增强（救回 docs/fromprompt-gaps.md 的 (a) 类）
 *
 * 三条新解析路径，均由 data/questions.json 的真实题面驱动：
 *   P1 乘积式方程：两个一次式相乘 = 常数          → cnm_222_q4
 *   P2 完全平方 = 一次式：两边都是表达式需移项展开 → cnm_224_q4
 *   P3 变量名不是 x/y：h=-5t²+20t                → cnm_236_q2
 * 后面 5 条是同一批解析路径的守卫：宁可解析不出，也不能挂错曲线。
 * ================================================================ */

console.log('\n--- 11. fromPrompt 解析增强（E 卡） ---');

test('[E-1] 乘积式方程 (2x-1)(x+1)=2 展开成 2x²+x-3（cnm_222_q4）', function () {
  // (2x-1)(x+1)=2 → 2x²+x-1=2 → 2x²+x-3=0 → 顶点 (-1/4, -25/8)，零点 1、-3/2
  assert.deepStrictEqual(F.fromPrompt(q('cnm_222_q4')), { type: 'quadratic', a: 2, h: -0.25, k: -3.125 });
});

test('[E-2] 乘积式方程的零点就是题库答案 1、-3/2（cnm_222_q4，且必须挂载）', function () {
  const item = QMAP.get('cnm_222_q4');
  assert.ok(item, '题库里找不到 cnm_222_q4');
  const p = F.labFor(t('cnm_222'), q('cnm_222_q4'), { itemId: 'cnm_222_q4' });
  assert.ok(p, 'cnm_222_q4 答案 1、-3/2 就是画板绿点，应救回');
  assert.strictEqual(p.type, 'quadratic');
  const got = Array.from(labRootSet(p)).sort();
  const want = Array.from(answerRootSet(item)).sort();
  assert.deepStrictEqual(got, want, '绿点 ≠ 答案');
});

test('[E-3] 两边都是表达式 (x-2)²=3(x-2) 移项得 x²-7x+10（cnm_224_q4）', function () {
  // (x-2)²-3(x-2) = x²-7x+10 → 顶点 (7/2, -9/4)，零点 2、5
  assert.deepStrictEqual(F.fromPrompt(q('cnm_224_q4')), { type: 'quadratic', a: 1, h: 3.5, k: -2.25 });
});

test('[E-4] 上式零点就是题库答案 2、5（cnm_224_q4，且必须挂载）', function () {
  const item = QMAP.get('cnm_224_q4');
  assert.ok(item, '题库里找不到 cnm_224_q4');
  const p = F.labFor(t('cnm_224'), q('cnm_224_q4'), { itemId: 'cnm_224_q4' });
  assert.ok(p, 'cnm_224_q4 答案 2、5 就是画板绿点，应救回');
  const got = Array.from(labRootSet(p)).sort();
  const want = Array.from(answerRootSet(item)).sort();
  assert.deepStrictEqual(got, want, '绿点 ≠ 答案');
});

test('[E-5] 变量名不是 x/y 的二次式 h=-5t²+20t（cnm_236_q2）', function () {
  // a=-5, b=20, c=0 → 顶点 (2, 20)：题目问"最大高度"，答案 20 就是顶点纵坐标
  assert.deepStrictEqual(F.fromPrompt(q('cnm_236_q2')), { type: 'quadratic', a: -5, h: 2, k: 20 });
});

test('[E-6] 顶点纵坐标 20 与题库答案一致，且必须挂载（cnm_236_q2）', function () {
  const p = F.labFor(t('cnm_236'), q('cnm_236_q2'), { itemId: 'cnm_236_q2' });
  assert.ok(p, 'cnm_236_q2 的答案 20 就是画板顶点纵坐标，应救回');
  assert.strictEqual(p.k, 20);
});

test('[E-守卫1] 非方程语境的两个一次式相乘不展开（cnm_146_q1 整式乘法）', function () {
  // 「计算 (x+2)(x-3)。」问的是展开结果，不是函数图像 → 解析必须保持 null
  assert.strictEqual(F.fromPrompt(q('cnm_146_q1')), null);
});

test('[E-守卫2] 系数被除法约掉的式子仍不挂（cnm_236_q5 y=-x²/8 拱桥）', function () {
  // 水面宽 16 不是画板标注量（画板只标顶点与 x 轴交点），且 y=-x²/8≠-x² 不能近似
  assert.strictEqual(F.fromPrompt(q('cnm_236_q5')), null);
  assert.strictEqual(F.labFor(t('cnm_236'), q('cnm_236_q5'), { itemId: 'cnm_236_q5' }), null);
});

test('[E-守卫3] 含参系数的二次式仍不解析（cnm_229_q1 (m-2)x²+3x-1）', function () {
  assert.strictEqual(F.fromPrompt(q('cnm_229_q1')), null);
});

test('[E-守卫4] 等式右侧含参的方程仍不解析（cnm_220_q4 (x-2)²=k-3）', function () {
  assert.strictEqual(F.fromPrompt(q('cnm_220_q4')), null);
  assert.strictEqual(F.labFor(t('cnm_220'), q('cnm_220_q4'), { itemId: 'cnm_220_q4' }), null);
});

test('[E-守卫5] 乘积式里出现参数 p、q 时不当作二次函数（cnm_150_q4）', function () {
  // 若 x²+px+q=(x+2)(x-5)，求 p、q —— 左边含参，画不出确定曲线
  assert.strictEqual(F.fromPrompt(q('cnm_150_q4')), null);
});

test('[E-守卫6] 数列记号 a_n=n² 不被当成抛物线（cnm_h199_q2）', function () {
  // 变量改名分支要求二次项系数显式写出，否则 "a_n=n²" 这类递推式会被误认成 y=x²
  assert.strictEqual(F.fromPrompt(q('cnm_h199_q2')), null);
});

/* ================================================================
 * 11b. E 卡复核：把答案语义门禁（B 卡定档）落到全库挂载上
 *
 * 卡面第 5 步要求「新增题必须全部落在 (a) 类」，而 (a)/(b) 的分界就是
 * 「答案是不是画板真会标出来的量」。前一轮只在上限 55 题（29 个知识点）
 * 内人工逐条判过；这里把同一口径做成机器检查，并**扫全库**：
 * 只要某道题被挂载、而它的答案不属于该函数类型的标注量，就是误挂。
 *
 * 标注量口径（与 docs/fromprompt-gaps.md 一致）：
 *   二次：顶点 h/k，或与 x 轴交点（根）
 *   一次：y 轴截距 b，或与 x 轴交点（x 轴交点只在不含语境的纯方程题里算）
 *   反比例：象限位置，或 |k|
 * 答案能解析成数字/解析式 → 至少有一个数必须对得上标注量；
 * 答案解析不了（分类/范围/文字）→ 只有"象限/增减性/交点个数"三种纯图像
 * 可读的答案算通过，其余一律判误挂。
 *
 * 已知双向噪声（门禁本身不完美，两个方向都按保守口径处理）：
 *   · 过严：比较大小 / 对称轴 / 最值 / 平移后解析式 / 两线交点 / 面积 —— 答案其实是
 *     图像可读或图像可算的，这里判不过，因此"必须为空"这条测试只允许「命中已知
 *     存量误挂表」的例外，其余一律失败；不允许为凑数再加例外。
 *   · 过松：数字碰巧重合（cnm_208_q2 答案 2 = 所画直线的 y 截距而非两线交点）——
 *     纯数值门禁看不出来，只能人工核，结论见附 5。
 * ================================================================ */

console.log('\n--- 11b. 答案语义门禁（全库挂载） ---');

/** 画板对该参数会标注出来的数值集合（字符串化，便于与答案数字比对） */
function annotationValues(p, topicId) {
  const vals = new Set();
  const push = function (x) { if (isFinite(x)) vals.add(String(Number(x.toFixed(6)))); };
  if (p.type === 'quadratic') {
    push(p.h); push(p.k);
    push(p.h - Math.sqrt(-p.k / p.a)); push(p.h + Math.sqrt(-p.k / p.a));
  } else if (p.type === 'linear') {
    push(p.b);                                    // y 轴截距 (0,b)
    if (/^cnm_2(0[0-9]|2[0-4])$/.test(String(topicId))) push(-p.b / p.k); // 方程语境才标 x 轴交点
  } else if (p.type === 'inverse') {
    push(p.k);                                    // |k| 本身就是答案对象
  }
  return vals;
}

/** 从答案里抠数字（支持 1，-3/2、-2，5、y=2x+1、112.5、m≠1 等） */
function answerNumbers(answer) {
  const s = String(answer == null ? '' : answer).replace(/[（）()]/g, '');
  const out = [];
  const re = /(-?\d+(?:\.\d+)?)(?:\s*\/\s*(\d+(?:\.\d+)?))?/g;
  let m;
  while ((m = re.exec(s))) {
    const v = m[2] ? Number(m[1]) / Number(m[2]) : Number(m[1]);
    if (isFinite(v)) out.push(v);
  }
  return out;
}

/** 答案解析不了数字时，允许通过的纯图像可读答案 */
const IMAGE_READABLE = /象限|增大而|减小而|交点个数|开口|无交点|没有交点/;

/** 门禁判不过、但已人工定档为"图像可读 / 图像可算"的题（口径偏严的方向），逐条留痕 */
const GATE_LOOSE_OK = new Set([
  'cnm_202_q1', 'cnm_202_q2', 'cnm_203_q1', 'cnm_204_q2', 'cnm_205_q5',
  'cnm_206_q1', 'cnm_206_q2', 'cnm_207_q1', 'cnm_230_q2', 'cnm_232_q2',
  'cnm_235_q1', 'cnm_235_q2', 'cnm_235_q3', 'cnm_235_q4', 'cnm_239_q1',
  'cnm_239_q2', 'cnm_239_q4', 'cnm_241_q1', 'cnm_241_q3', 'cnm_242_q2',
  'cnm_230_q1', 'cnm_231_q1', 'cnm_203_q4', 'cnm_234_q2',
  /* 选择题：题面给了确定函数、选项里写着图像可读/可算的结论（象限、解集、配方形态、最值比较） */
  'cnm_202_q3', 'cnm_203_q2', 'cnm_204_q3', 'cnm_207_q2', 'cnm_207_q3',
  'cnm_230_q4', 'cnm_232_q1', 'cnm_232_q4', 'cnm_238_q1', 'cnm_238_q3',
  /* 数值题：两坐标轴围成的三角形面积（标了两截距即可算）、平移后 k+b（题面给了反向条件）、
     点在某函数图象上求 m（|k| 决定了函数，点是图像上的点；门禁对反比例只认 |k|） */
  'cnm_202_q4', 'cnm_204_q4', 'cnm_238_q2'
]);

/** 已定档为"画出来的曲线与题目问的根本不是一回事"的挂载（真误挂，需解析侧修） */
const KNOWN_MISMOUNT = new Set([
  'cnm_204_q1',  // y=2x 向上平移 3 → 画板仍画平移前的 y=2x
  'cnm_231_q3',  // y=x² 平移 → 画板仍画平移前的 y=x²
  'cnm_208_q1',  // 两直线交点 → 画板只画第一条，标的是它自己的截距/交点
  'cnm_208_q2',  // 同上，且答案 2 与所画直线的 y 截距数值碰巧重合
  'cnm_208_q3',  // 同上
  'cnm_208_q4',  // 同上
  'cnm_241_q3',  // 直线与双曲线交点/面积 → 画板只画双曲线
  'cnm_241_q4',  // 同上，答案是不等式解集
  'cnm_234_q3'   // AB 线段长：画板标注 A/B 两点，但答案 6 是两点距离
]);

test('[E-语义1] 全库挂载题：误挂 = 只允许已知那 9 条（新误挂必须为 0）', function () {
  const misfits = [];
  let mounted = 0;
  for (const item of QUESTIONS) {
    const p = F.labFor(item.topicId, item.prompt, { itemId: item.id });
    if (!p) continue;
    mounted++;
    const id = item.id;
    if (KNOWN_MISMOUNT.has(id)) continue;
    const ansStr = String(item.answer == null ? '' : item.answer);
    if (GATE_LOOSE_OK.has(id)) continue;
    if (/^[A-D]$/.test(ansStr.trim())) { misfits.push(id + ' 选择题（答案 ' + ansStr + '）'); continue; }
    const nums = answerNumbers(ansStr);
    if (!nums.length) {
      if (IMAGE_READABLE.test(ansStr)) continue;      // 象限/增减性/交点个数：图像可读
      misfits.push(id + ' 答案「' + ansStr + '」不是可读数字');
      continue;
    }
    const ann = annotationValues(p, item.topicId);
    const ok = nums.some(function (n) { return ann.has(String(Number(n.toFixed(6)))) || ann.has(String(n)); });
    if (!ok) misfits.push(id + ' 答案 ' + ansStr + ' ∉ 画板标注 {' + Array.from(ann).join(',') + '}');
  }
  assert.deepStrictEqual(misfits, [], '新误挂 ' + misfits.length + ' 题（共挂载 ' + mounted + ' 题）');
});

test('[E-语义2] 已知存量误挂 9 题仍在挂载：修好它们要动解析语义（改挂/改画），属另一张卡', function () {
  const still = [];
  for (const id of KNOWN_MISMOUNT) {
    const item = QMAP.get(id);
    assert.ok(item, '题库里找不到 ' + id + '（题库改过了？请更新名单）');
    if (F.labFor(item.topicId, item.prompt, { itemId: id })) still.push(id);
  }
  // 这条断言是"现状快照"：一旦有人修好其中某条，这里会失败，提醒把该 id 从名单删掉
  assert.deepStrictEqual(still.sort(), Array.from(KNOWN_MISMOUNT).sort());
});



/* ================================================================
 * 12. P 卡：画板只标题面已知量（派生量留 ?）+ 自检判定
 *    验收标准：① 求最小值那题文案不出现 -4、标注是 ? ② 对称轴题不出现 3
 *    ③ 方程的根不出现 2 和 3 ④ 点「我算好了」空着不给真值 ⑤ 填对 ✓ / 填错 ✗
 *    ⑥ 全库审计 0 泄漏 ⑦ 判定逻辑正误
 * ================================================================ */

console.log('\n--- 12. P 卡：已知量/派生量分层 + 自检 ---');

/** 文案里是否出现某个数字（按数值比较，避免 "-4" 被 "2-4" 之类的子串误判） */
function hasNumber(text, n) {
  const s = String(text).replace(/[−–—]/g, '-');
  const re = /-?\d+(?:\.\d+)?/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (Math.abs(Number(m[0]) - n) < 1e-9) return true;
  }
  return false;
}

test('[P-1] cnm_235_q2 求 y=2(x+1)²-4 的最小值：文案不出现 -4（也不出现顶点横坐标 -1），但显示已知量 a = 2', function () {
  const s = F.noteText('quadratic-vertex', '最小值', { a: 2, h: -1, k: -4 });
  assert.ok(s, '文案为空');
  assert.ok(!hasNumber(s, -4), '文案直接报出了最小值 -4：' + s);
  assert.ok(!hasNumber(s, -1), '文案报出了顶点横坐标 -1：' + s);
  assert.ok(s.indexOf('a = 2') >= 0, '题面已知量 a = 2 应当显示：' + s);
  assert.ok(/纵坐标是多少/.test(s), '应当改成引导提问：' + s);
});

test('[P-2] cnm_232_q2 求 y=x²-6x+5 的对称轴：文案不出现 3（也不出现顶点纵坐标 -4），标注写 x = ?', function () {
  const p = { a: 1, h: 3, k: -4 };
  const s = F.noteText('quadratic-vertex', '对称轴', p);
  assert.ok(!hasNumber(s, 3), '文案报出了对称轴 3：' + s);
  assert.ok(!hasNumber(s, -4), '文案报出了顶点纵坐标 -4：' + s);
  assert.ok(/x = \?/.test(s), '对称轴要留问号：' + s);
  /* 图上标注：对称轴位置不写数字 */
  assert.strictEqual(F.deriveText(), '?');
  assert.strictEqual(F.derivePair(), '(?, ?)');
});

test('[P-3] cnm_224_q1 解方程 x²-5x+6=0：文案不出现根 2、3，也不出现顶点坐标（2.5, -0.25）', function () {
  const p = { a: 1, h: 2.5, k: -0.25 };
  const s = F.noteText('quadratic-roots', '方程的根', p);
  assert.ok(!hasNumber(s, 2), '文案出现了 2：' + s);
  assert.ok(!hasNumber(s, 3), '文案出现了 3：' + s);
  assert.ok(/分别是多少/.test(s), '应当改成引导提问：' + s);
});

test('[P-4] 区间最值（cnm_235_q4）：区间端点照常显示（已知量），端点函数值与最值留问号', function () {
  const p = { a: 1, h: 1, k: -4, xMin: 2, xMax: 4 };
  const s = F.noteText('quadratic-range-on-interval', '在给定区间上的最大值', p);
  assert.ok(s.indexOf('2 ≤ x ≤ 4') >= 0, '区间端点是题面已知量，要显示：' + s);
  assert.ok(!hasNumber(s, 5), '文案报出了最大值 5：' + s);
  assert.ok(!hasNumber(s, -4), '文案报出了顶点纵坐标 -4：' + s);
  assert.ok(/最大的那个是多少/.test(s), '要引导学生自己算：' + s);
});

test('[P-5] 开口方向：a 是题面已知量，允许直接讲（保留原文案）', function () {
  const s = F.noteText('quadratic-vertex', '开口方向', { a: -2, h: 1, k: 3 });
  assert.ok(s.indexOf('a = -2') >= 0, s);
  assert.ok(/开口向下/.test(s), s);
});

test('[P-6] 二次函数的文案里不出现顶点横坐标 h（派生量）；一次/反比例的 k、b 是题面已知量允许显示', function () {
  const sample = {
    quadratic: { a: 2, h: -1, k: -4, xMin: 2, xMax: 4 },
    linear: { k: 2, b: -6 },
    inverse: { k: -8 }
  };
  const bad = [];
  Object.keys(F.CAPABILITIES).forEach(function (lab) {
    const type = F.CAP_TYPE[lab];
    F.CAPABILITIES[lab].canAnswer.forEach(function (intent) {
      const s = F.noteText(lab, intent, Object.assign({}, sample[type]));
      if (!s) return;
      /* 只有二次函数的 h 必然是派生量（配方才得到）；一次/反比例的 k、b 是题面原式里就有的已知量 */
      if (type === 'quadratic' && hasNumber(s, -1)) bad.push(lab + '/' + intent + ' 出现顶点横坐标 -1');
      if (type === 'quadratic' && hasNumber(s, -4)) bad.push(lab + '/' + intent + ' 出现顶点纵坐标 -4');
    });
  });
  assert.deepStrictEqual(bad, [], '文案里出现了派生量：' + bad.join('; '));
});

test('[P-7] answerRows：按 intent 决定问几个数，且真值与题库答案一致（cnm_235_q2/q1/q4/232_q2/231_q2/224_q1）', function () {
  const cases = [
    ['cnm_235_q2', 'quadratic-vertex', '最小值', -4],
    ['cnm_235_q1', 'quadratic-vertex', '最大值', 5],
    ['cnm_232_q2', 'quadratic-vertex', '对称轴', 3],
    ['cnm_236_q2', 'quadratic-vertex', '最大值', 20]
  ];
  cases.forEach(function (c) {
    const item = QMAP.get(c[0]);
    assert.ok(item, '题库里找不到 ' + c[0]);
    const cand = F.labForScene(item.topicId, item.prompt, { itemId: item.id });
    assert.ok(cand, c[0] + ' 应能挂画板');
    const rows = F.answerRows(c[1], c[2], cand);
    assert.strictEqual(rows.length, 1, c[0] + ' 应问一个数，实际 ' + rows.length);
    assert.ok(Math.abs(rows[0].real - c[3]) < 1e-9,
      c[0] + ' 真值应为 ' + c[3] + '，实际 ' + rows[0].real + '（题库答案 ' + item.answer + '）');
    assert.strictEqual(rows[0].yours, '', '作答位必须是空串（绝不预填真值）');
  });
});

test('[P-8] answerRows：顶点坐标问两个数，根问两个数，区间最值题按「问哪个就给哪个」合成一行', function () {
  const vertex = F.answerRows('quadratic-vertex', '顶点坐标', { a: 2, h: -3, k: -5 });
  assert.deepStrictEqual(vertex.map(function (r) { return r.real; }), [-3, -5]);

  /* cnm_235_q4 问「最大值」，只核对最大值 5；问最小值时只核对 -3（题目问什么就问什么） */
  const maxRows = F.answerRows('quadratic-range-on-interval', '在给定区间上的最大值',
    { a: 1, h: 1, k: -4, xMin: 2, xMax: 4 });
  assert.deepStrictEqual(maxRows.map(function (r) { return r.real; }), [5]);
  const minRows = F.answerRows('quadratic-range-on-interval', '在给定区间上的最小值',
    { a: 1, h: 1, k: -4, xMin: 2, xMax: 4 });
  assert.deepStrictEqual(minRows.map(function (r) { return r.real; }), [-3]);

  /* 顶点落在区间内时，最值就是顶点的纵坐标 */
  assert.deepStrictEqual(F.answerRows('quadratic-range-on-interval', '在给定区间上的最小值',
    { a: 1, h: 3, k: -4, xMin: 2, xMax: 4 }).map(function (r) { return r.real; }), [-4]);

  const roots = F.answerRows('quadratic-roots', '方程的根', { a: 1, h: 2.5, k: -0.25 });
  assert.deepStrictEqual(roots.map(function (r) { return r.real; }).sort(function (x, y) { return x - y; }), [2, 3]);
});

test('[P-9] answerRows：不是数值题的 intent 不给输入框（开口方向 / 象限 / 趋势）', function () {
  assert.deepStrictEqual(F.answerRows('quadratic-vertex', '开口方向', { a: 1, h: 2, k: 3 }), []);
  assert.deepStrictEqual(F.answerRows('inverse-quadrants', '图象所在的象限', { k: -8 }), []);
  assert.deepStrictEqual(F.answerRows('linear-trend', 'y 随 x 的增大而增大还是减小', { k: 2, b: 1 }), []);
});

test('[P-10] checkAnswerRow：未作答只说「未作答」，不出真值、不出 ✓/✗', function () {
  const row = { label: '最小值', real: -4, yours: '' };
  ['', '   ', '\t\n'].forEach(function (raw) {
    const v = F.checkAnswerRow(row, raw);
    assert.strictEqual(v.verdict, 'blank', JSON.stringify(raw) + ' 应判未作答');
    assert.strictEqual(v.shown, '未作答');
    assert.strictEqual(v.real, false, '未作答时不得给真值');
    assert.ok(v.shown.indexOf('-4') < 0, '未作答时不能露出真值');
  });
});

test('[P-11] checkAnswerRow：数值写法归一（3 / 3.0 / 3/1 / 6/2 / 全角负号）都算对', function () {
  [['3', 3], ['3.0', 3], ['3/1', 3], ['6/2', 3], ['-4', -4], ['-4.00', -4], ['−4', -4], ['-8/2', -4]]
    .forEach(function (c) {
      const v = F.checkAnswerRow({ label: 'x', real: c[1] }, c[0]);
      assert.strictEqual(v.verdict, 'right', c[0] + ' 应为 ✓，实际 ' + v.verdict);
      assert.strictEqual(v.shown, '✓');
    });
  assert.strictEqual(F.numEqual('1/2', '0.5'), true);
  assert.strictEqual(F.numEqual('3', '3.0'), true);
});

test('[P-12] checkAnswerRow：填错判 ✗ 且**不回显实际值**（否则做错的学生的答案旁边就摆着正确答案）', function () {
  const v = F.checkAnswerRow({ label: '最小值', real: -4 }, '-5');
  assert.strictEqual(v.verdict, 'wrong');
  assert.ok(v.shown.indexOf('-5') >= 0, '要回显学生自己的答案：' + v.shown);
  assert.ok(v.shown.indexOf('-4') < 0, '不得回显实际值：' + v.shown);
  assert.strictEqual(v.real, false);
  /* 不是数的输入同样按填错处理，不暴露真值 */
  const w = F.checkAnswerRow({ label: '最小值', real: -4 }, '不知道');
  assert.strictEqual(w.verdict, 'wrong');
  assert.ok(w.shown.indexOf('-4') < 0, w.shown);
});

test('[P-13] 图上静态标注不出现派生量：quadRangeExtrema 只给面板用，derivePair 恒为 (?, ?)', function () {
  const e = F.quadRangeExtrema(1, 1, -4, 2, 4);
  assert.strictEqual(e.max, 5);
  assert.strictEqual(e.min, -3);
  /* 顶点在区间内时也要把顶点值纳入比较 */
  const e2 = F.quadRangeExtrema(1, 3, -4, 2, 4);
  assert.strictEqual(e2.min, -4);
  assert.strictEqual(F.derivePair(), '(?, ?)');
  assert.strictEqual(F.fmtPair([3, -4]), '3、-4');
});

test('[P-14] 全库审计：所有挂图题 × 全部 intent 的文案与图上标注都不含答案数字（scripts/audit_funclab_notes.js）', function () {
  const { execFileSync } = require('child_process');
  const out = execFileSync(process.execPath,
    [path.join(__dirname, '..', 'scripts', 'audit_funclab_notes.js'), '--json'],
    { encoding: 'utf8', env: Object.assign({}, process.env, { TMPDIR: path.join(require('os').tmpdir(), 'no-cache-for-audit') }) });
  const rep = JSON.parse(out);
  assert.ok(rep.noteCount > 100, '审计覆盖的文案条数太少：' + rep.noteCount);
  assert.deepStrictEqual(rep.leaks, [], '有 ' + rep.leaks.length + ' 处泄漏：'
    + rep.leaks.map(function (l) { return l.id + '/' + l.intent + '→' + l.value; }).join('; '));
});



/* ================================================================
 * 描述（t_85395e07）：Funclab.describe —— AI 讲解看到画板
 *   9 个 lab × 各自全部 intent 都要能出描述；派生量一律 ?，不许剧透。
 * ================================================================ */

/* 每个画板一套合法参数（curated，避免派生量数值与已知量 fmt 串撞车干扰断言）。
 * quadratic-vertex / linear 带 base，才能覆盖「基准曲线 + 平移箭头」这些可见元素。 */
const DESC_LABS = {
  'quadratic-vertex': { a: -1, h: 2, k: 5, base: { type: 'quadratic', a: -1, h: 2, k: 0 } },
  'quadratic-roots': { a: 1, h: 0, k: -4 },
  'quadratic-inequality': { a: 1, h: 0, k: -4 },
  'quadratic-range-on-interval': { a: 1, h: 0, k: -4, xMin: -1, xMax: 3 },
  'linear-intercepts': { k: 2, b: -4, base: { type: 'linear', k: 2, b: 0 } },
  'linear-trend': { k: 2, b: -4, base: { type: 'linear', k: 2, b: 0 } },
  'linear-equation': { k: 2, b: -4, base: { type: 'linear', k: 2, b: 0 } },
  'inverse-quadrants': { k: 3 },
  'inverse-area': { k: 3 }
};
function descParams(lab) {
  const p = Object.assign({}, DESC_LABS[lab]);
  p.type = F.CAP_TYPE[lab];
  return p;
}

test('describe：9 个 lab × 各自全部 intent 都返回非空字符串，且覆盖关键元素词', function () {
  Object.keys(F.CAPABILITIES).forEach(function (lab) {
    F.CAPABILITIES[lab].canAnswer.forEach(function (raw) {
      const it = F.intentKey(raw);
      const d = F.describe(lab, it, descParams(lab));
      assert.ok(d && d.length > 0, lab + '/' + it + ' describe 应为非空字符串');
      assert.ok(d.indexOf('坐标') >= 0, lab + '/' + it + ' 应含坐标平面');
      assert.ok(d.indexOf('实线') >= 0, lab + '/' + it + ' 应含实线描述');
      assert.ok(d.indexOf('?') >= 0, lab + '/' + it + ' 应含留白问号');
    });
  });
});

test('describe：cnm_235 最大值题（顶点 (2,5)）不含任何派生量数值', function () {
  const params = F.labForScene('cnm_235', q('cnm_235_q1'), { itemId: 'cnm_235_q1' });
  assert.ok(params, 'cnm_235_q1 应能解析出画板参数');
  assert.deepStrictEqual({ a: params.a, h: params.h, k: params.k }, { a: -1, h: 2, k: 5 }, 'cnm_235 顶点应为 (2,5)');
  const d = F.describe('quadratic-vertex', '最大值', params);
  assert.ok(d, 'cnm_235 describe 非空');
  ['5', '(2, 5)', 'x = 2', '(2,', '坐标 (2'].forEach(function (leak) {
    assert.ok(d.indexOf(leak) < 0, 'describe 不应包含派生量数值片段 ' + JSON.stringify(leak) + '\n' + d);
  });
});

test('describe：逐 lab 通用断言 —— labAnswerParts 算出的派生量值都不出现在 describe（排除已知量重名）', function () {
  Object.keys(F.CAPABILITIES).forEach(function (lab) {
    F.CAPABILITIES[lab].canAnswer.forEach(function (raw) {
      const it = F.intentKey(raw);
      const p = descParams(lab);
      const d = F.describe(lab, it, p);
      if (!d) return;
      const knownNum = [p.a, p.b, p.xMin, p.xMax].filter(function (v) { return v != null && isFinite(v); });
      if (p.type === 'linear' || p.type === 'inverse') knownNum.push(p.k);
      const knownStrs = knownNum.map(function (v) { return F.fmtQuad(v); });
      F.labAnswerParts(lab, it, p).forEach(function (part) {
        part.values.forEach(function (v) {
          if (knownNum.some(function (k) { return Math.abs(k - v) < 1e-9; })) return;   // 与已知量数值重名
          const s = F.fmtQuad(v);
          if (knownStrs.some(function (k) { return k.indexOf(s) >= 0; })) return;       // 是已知量 fmt 串的子串（如面积 4 ⊂ b=-4）
          assert.ok(d.indexOf(s) < 0, lab + '/' + it + ' describe 泄露派生量 ' + s + '\n' + d);
        });
      });
    });
  });
});

test('describe：非法输入 → null（不返回空串）', function () {
  assert.strictEqual(F.describe(null, '最大值', {}), null);
  assert.strictEqual(F.describe('nope', '最大值', {}), null);
  assert.strictEqual(F.describe('quadratic-vertex', '不存在的intent', { a: -1, h: 2, k: 5 }), null);
  assert.strictEqual(F.describe('linear-intercepts', '顶点坐标', { k: 2, b: -4 }), null);   // intent 不属于该画板
});

test('describe：共享标注 helper 被绘制路径与 paintModel 共用（防漂移：新标注漏更新 describe 就红）', function () {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'diagnose', 'funclab.js'), 'utf8');
  // 抽取绘制路径（annotate/drawShift/drawInterval）里 fillText / const label 调用的共享 helper 名
  const used = new Set();
  const re = /(?:ctx\.fillText|const label =)\s*\(\s*(\w+Text)\(/g;
  let m;
  while ((m = re.exec(src))) used.add(m[1]);
  assert.ok(used.size > 0, '应能从绘制路径抽出共享标注 helper');
  // paintModel 函数体必须引用每个 helper（否则 describe 与绘制漂移）
  const pm = src.slice(src.indexOf('function paintModel'), src.indexOf('function blankNote'));
  used.forEach(function (h) {
    assert.ok(pm.indexOf(h + '(') >= 0, 'paintModel 必须引用绘制路径用到的 helper ' + h);
  });
  // describe 必须通过 paintModel 生成
  const dsc = src.slice(src.indexOf('function describe'), src.indexOf('  /** 数值对'));
  assert.ok(dsc.indexOf('paintModel(') >= 0, 'describe 必须调用 paintModel');
});


/* ================================================================
 * 汇总
 * ================================================================ */

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
