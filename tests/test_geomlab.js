#!/usr/bin/env node
/* 几何画板（diagnose/geomlab.js）测试：node tests/test_geomlab.js
 *
 * 覆盖范围：
 *   1. 几何计算函数（余弦定理/勾股/弦长公式/圆周角定理/切线长/相似比）的数值正确性
 *   2. 「拖动不改变数学事实」的不变量（垂径关系、同弧圆周角相等、OP²=r²+PA²、成比例）
 *   3. 答案语义门禁 gate()：命中理由逐条验证（正例 + 反例）
 *   4. 知识点白名单 classOf()
 *   5. labFor() 正例（六个骨架，逐个断言 solve() 复现题库答案）
 *   6. labFor() 反例（题面不足以定形 / 答案在文字里 / 图会送分 / 未实现的骨架）
 *   7. 与 F 卡 scripts/measure_geomlab_coverage.js 的 finalVerdict 对拍（防规则漂移）
 *
 * mount() 需要 DOM，不在本文件范围（浏览器 agent-browser 验收）。
 *
 * 约定与 test_funclab.js 一致：所有题面都取自 data/questions.json 的真实 prompt
 * （用 q(id) 取，取不到直接失败），不臆造题面 —— 保证测试锁的是学生真正会看到的输入。
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
const near = function (a, b, eps, msg) {
  const d = Math.abs(a - b);
  assert.ok(d <= (eps == null ? 1e-6 : eps), (msg || '') + ' 期望 ' + b + '，实际 ' + a + '（差 ' + d + '）');
};

const G = require('../diagnose/geomlab.js');
const M = G.math;

/* ---- 真实题库 ---- */
const QUESTIONS = require('../data/questions.json');
const TOPICS = require('../data/topics.json');
const QMAP = new Map(QUESTIONS.map(function (x) { return [x.id, x]; }));
const TMAP = new Map(TOPICS.map(function (t) { return [t.id, t]; }));

/** 按题库 id 取真实题目；id 不在了就炸（防题库改动后测试悄悄失效） */
function q(id) {
  const item = QMAP.get(id);
  assert.ok(item, '题库里找不到题目 ' + id + '（题库改过了？请更新测试）');
  return item;
}
/** 真实题目 → labFor 的完整调用（topic + answer + choices 都按 app.js 的传法给） */
function lab(id) {
  const item = q(id);
  return G.labFor(item.topicId, item.prompt, {
    itemId: item.id,
    topic: TMAP.get(item.topicId),
    answer: item.answer,
    choices: item.choices
  });
}
function gateOf(id) {
  const item = q(id);
  return G.gate(item.prompt, { itemId: item.id, answer: item.answer, choices: item.choices });
}
function answerTextOf(item) {
  const a = String(item.answer == null ? '' : item.answer).trim();
  if (/^[A-Z]$/.test(a) && Array.isArray(item.choices)) {
    const c = item.choices.filter(function (x) { return String(x.key).toUpperCase() === a; })[0];
    if (c) return String(c.text);
  }
  return a;
}

/* ================================================================
 * 1. 几何计算：数值正确性
 * ================================================================ */

console.log('\n--- 1. 几何计算（边长/角度/面积） ---');

test('余弦定理求第三边：b=5,c=8,∠A=60° → a=7', function () {
  near(M.lawCosSide(5, 8, 60), 7);
});
test('余弦定理求角：3-4-5 三角形中 5 的对角 = 90°', function () {
  near(M.lawCosAngle(5, 3, 4), 90, 1e-9);
});
test('余弦定理求角：等边三角形每个角 60°', function () {
  near(M.lawCosAngle(4, 4, 4), 60, 1e-9);
});
test('两边夹角求面积：b=3,c=4,∠A=90° → S=6', function () {
  near(M.areaSAS(3, 4, 90), 6);
});
test('海伦公式：3-4-5 → S=6', function () {
  near(M.areaSides(3, 4, 5), 6);
});
test('勾股定理：两直角边 8、15 → 斜边 17（题 cnm_174_q3 的量）', function () {
  near(M.rightHypot(8, 15), 17);
});
test('勾股反解：斜边 17、一直角边 8 → 另一边 15', function () {
  near(M.rightLeg(17, 8), 15);
});
test('斜边上的高：6、8、10 → h=4.8（题 cnm_112_q4 的答案）', function () {
  near(M.altitudeToHypotenuse(6, 8, 10), 4.8);
});
test('垂径：r=5, 弦=8 → 弦心距 3（题 cnm_251_q1 的答案）', function () {
  near(M.chordDistance(5, 8), 3);
});
test('垂径：r=10, 弦心距 6 → 弦 16（题 cnm_251_q2 的答案）', function () {
  near(M.chordLength(10, 6), 16);
});
test('垂径反解：弦=24, 弦心距 5 → r=13（题 cnm_251_q3 的答案）', function () {
  near(M.radiusFromChordDist(24, 5), 13);
});
test('垂径三式互逆：r→d→弦→r 回到原值', function () {
  const r = 13;
  const d = M.chordDistance(r, 24);
  const c = M.chordLength(r, d);
  near(c, 24);
  near(M.radiusFromChordDist(c, d), r);
});
test('圆周角定理：圆心角 100° → 圆周角 50°（题 cnm_253_q1 的答案）', function () {
  near(M.inscribedFromCentral(100), 50);
});
test('圆周角定理反解：圆周角 35° → 圆心角 70°（题 cnm_253_q2 的答案）', function () {
  near(M.centralFromInscribed(35), 70);
});
test('劣弧一侧：圆心角 100° → 圆周角 130°（题 cnm_253_q5 的答案）', function () {
  near(M.inscribedOnMinorArc(100), 130);
});
test('切线长：OP=5, r=3 → PA=4（题 cnm_262_q2 的答案）', function () {
  near(M.tangentLength(5, 3), 4);
});
test('切线长：OP=13, r=5 → PA=12', function () {
  near(M.tangentLength(13, 5), 12);
});
test('切线长满足勾股：r² + PA² = OP²', function () {
  const r = 3;
  const OP = 5;
  const PA = M.tangentLength(OP, r);
  near(r * r + PA * PA, OP * OP);
});
test('圆外点的极值距离：OP=8,r=5 → 最近 3、最远 13', function () {
  near(M.secantNear(8, 5), 3);
  near(M.secantFar(8, 5), 13);
});
test('相似：边 6、相似比 3/2 → 对应边 9（题 cnm_270_q2 的答案）', function () {
  near(M.similarSide(6, 1.5), 9);
});
test('相似：面积比 = 相似比的平方（2:3 → 4:9）', function () {
  near(M.similarAreaRatio(2 / 3), 4 / 9);
});

/* ================================================================
 * 2. 不变量：拖动改了参数，但数学关系必须成立
 *    （这是「图上标注可信」的核心 —— 如果拖动能在图上造出假数值，画板就是骗人的）
 * ================================================================ */

console.log('\n--- 2. 拖动不变量（数学事实不变） ---');

test('垂径：任意弦长下 r² = d² + (AB/2)²（题 cnm_251_q1，r 锁 5）', function () {
  const l = lab('cnm_251_q1');
  assert.ok(l, 'cnm_251_q1 应能挂图');
  [4, 6, 7.5, 9.5].forEach(function (c) {
    l.state.chord = c;
    const v = G.solve(l);
    assert.ok(v, '弦长 ' + c + ' 应可解');
    near(v.r, 5, 1e-9, '半径应保持 5：');
    near(v.d * v.d + (v.chord / 2) * (v.chord / 2), 25, 1e-9, '弦长 ' + c + ' 时垂径关系：');
  });
});
test('圆周角：C 沿弧怎么移，∠ACB 都不变（题 cnm_253_q1 = 50°）', function () {
  const l = lab('cnm_253_q1');
  assert.ok(l, 'cnm_253_q1 应能挂图');
  [200, 240, 270, 300, 330].forEach(function (ang) {
    l.state.cAng = ang;
    near(G.solve(l).inscribed, 50, 1e-9, 'C 在 ' + ang + '° 处：');
  });
});
test('圆周角：拖 B 改圆心角，圆周角始终是它的一半', function () {
  const l = lab('cnm_253_q1');
  [40, 80, 120, 160].forEach(function (th) {
    l.state.central = th;
    near(G.solve(l).inscribed, th / 2, 1e-9, '圆心角 ' + th + '：');
  });
});
test('切线：拖 P 改 PA，OP² = r² + PA² 始终成立（题 cnm_262_q2，r=3）', function () {
  const l = lab('cnm_262_q2');
  assert.ok(l, 'cnm_262_q2 应能挂图');
  [2, 4, 6, 9].forEach(function (pa) {
    l.state.PA = pa;
    const v = G.solve(l);
    near(v.r, 3, 1e-9, '半径应保持 3：');
    near(v.r * v.r + v.PA * v.PA, v.OP * v.OP, 1e-9, 'PA=' + pa + ' 时：');
  });
});
test('平行截线：拖 D 改 AD，AD/DB 与 AE/EC 始终相等（题 cnm_269_q1）', function () {
  const l = lab('cnm_269_q1');
  assert.ok(l, 'cnm_269_q1 应能挂图');
  [1, 2, 3, 4].forEach(function (ad) {
    l.state.AD = ad;
    const v = G.solve(l);
    near(v.ratio, v.AEoverEC, 1e-9, 'AD=' + ad + ' 时两段之比：');
  });
});
test('直角三角形：拖两条直角边，c² = a² + b²、CD = ab/c 始终成立（题 cnm_112_q4）', function () {
  const l = lab('cnm_112_q4');
  assert.ok(l, 'cnm_112_q4 应能挂图');
  [[6, 8], [3, 4], [5, 12], [8, 15]].forEach(function (p) {
    l.state.a = p[0];
    l.state.b = p[1];
    const v = G.solve(l);
    near(v.a * v.a + v.b * v.b, v.c * v.c, 1e-9, p.join('/') + ' 时勾股：');
    near(v.altitude, v.a * v.b / v.c, 1e-9, p.join('/') + ' 时斜边高：');
    near(v.area, 0.5 * v.a * v.b, 1e-9, p.join('/') + ' 时面积：');
  });
});

/* ================================================================
 * 3. 答案语义门禁
 * ================================================================ */

console.log('\n--- 3. 答案语义门禁 gate() ---');

test('放行：圆心角 100° 求圆周角（cnm_253_q1，答案不在题面）', function () {
  assert.strictEqual(gateOf('cnm_253_q1').blocked, false);
});
test('放行：半径+弦求弦心距（cnm_251_q1）', function () {
  assert.strictEqual(gateOf('cnm_251_q1').blocked, false);
});
test('放行：平行截线求 EC（cnm_269_q1）', function () {
  assert.strictEqual(gateOf('cnm_269_q1').blocked, false);
});
test('挡下·纯证明：cnm_118_q1（求证类）→ reason=proof', function () {
  const g = gateOf('cnm_118_q1');
  assert.strictEqual(g.blocked, true);
  assert.strictEqual(g.reason, 'proof');
});
test('挡下·判断对错：cnm_252_q4「下列命题正确的是」→ judge-statement', function () {
  const g = gateOf('cnm_252_q4');
  assert.strictEqual(g.blocked, true);
  assert.strictEqual(g.reason, 'judge-statement');
});
test('挡下·问个数：cnm_260_q2「公共点有几个」→ asks-count', function () {
  const g = gateOf('cnm_260_q2');
  assert.strictEqual(g.blocked, true);
  assert.strictEqual(g.reason, 'asks-count');
});
test('挡下·取值/最值：cnm_250_q3「长度有几种可能的取值」→ asks-count', function () {
  assert.strictEqual(gateOf('cnm_250_q3').reason, 'asks-count');
});
test('挡下·纯算式伪装：cnm_p122_q3「计算：3＋3＝？」→ pure-arithmetic', function () {
  assert.strictEqual(gateOf('cnm_p122_q3').reason, 'pure-arithmetic');
});
test('挡下·实景应用：cnm_274_q1 影长求旗杆高 → applied-model', function () {
  assert.strictEqual(gateOf('cnm_274_q1').reason, 'applied-model');
});
test('挡下·动点：cnm_176_q4 → locus-motion', function () {
  assert.strictEqual(gateOf('cnm_176_q4').reason, 'locus-motion');
});
test('挡下·答案即图上数值：cnm_121_q2 全等 ∠B=70 求 ∠E → answer-echoes-given', function () {
  const g = gateOf('cnm_121_q2');
  assert.strictEqual(g.blocked, true);
  assert.strictEqual(g.reason, 'answer-echoes-given');
});
test('挡下·答案即图上数值：cnm_263_q1 切线长 PA=PB → answer-echoes-given', function () {
  assert.strictEqual(gateOf('cnm_263_q1').reason, 'answer-echoes-given');
});
test('挡下·位似坐标题：cnm_275_q2（人工定档 MANUAL_NO）→ manual', function () {
  const g = gateOf('cnm_275_q2');
  assert.strictEqual(g.blocked, true);
  assert.ok(/^manual:/.test(g.reason), 'reason 应为 manual:cnm_275_q2，实际 ' + g.reason);
});
test('fail-closed：没给 answer 时不挂（无法校验送分）', function () {
  const item = q('cnm_251_q1');
  const g = G.gate(item.prompt, { itemId: item.id });
  assert.strictEqual(g.blocked, true);
  assert.strictEqual(g.reason, 'answer-unknown');
});
test('answerEchoesGiven：答案数值全是题面已给量才算送分', function () {
  const item = q('cnm_121_q2');
  assert.deepStrictEqual(G.answerEchoesGiven(item.prompt, item.answer, item.choices), [70]);
  const ok = q('cnm_253_q1');
  assert.strictEqual(G.answerEchoesGiven(ok.prompt, ok.answer, ok.choices), null);
});

/* ================================================================
 * 4. 知识点白名单
 * ================================================================ */

console.log('\n--- 4. 知识点白名单 classOf() ---');

test('圆章 cnm_250..268 → circle', function () {
  [250, 251, 253, 262, 263, 268].forEach(function (n) {
    assert.strictEqual(G.classOf('cnm_' + n), 'circle', 'cnm_' + n);
  });
});
test('相似章 cnm_269..275 → similar', function () {
  [269, 270, 271, 272, 275].forEach(function (n) {
    assert.strictEqual(G.classOf('cnm_' + n), 'similar', 'cnm_' + n);
  });
});
test('三角形章 cnm_110..130、勾股 cnm_174..179 → triangle', function () {
  [110, 112, 121, 128, 174, 177].forEach(function (n) {
    assert.strictEqual(G.classOf('cnm_' + n), 'triangle', 'cnm_' + n);
  });
});
test('范围外章 → null（一元一次方程 cnm_039、圆的方程 cnm_h165）', function () {
  assert.strictEqual(G.classOf('cnm_039'), null);
  assert.strictEqual(G.classOf('cnm_h165'), null);
});
test('三维体剔除：圆锥章知识点 → null（topic 口径）', function () {
  const t = TMAP.get('cnm_258');
  assert.ok(t, 'cnm_258 应存在');
  assert.strictEqual(G.classOfTopic(t), null, 'cnm_258 是圆锥的侧面积，不是二维圆');
});
test('解析几何剔除：直线和圆的方程 → null（topic 口径）', function () {
  const t = TMAP.get('cnm_h169');
  assert.ok(t, 'cnm_h169 应存在');
  assert.strictEqual(G.classOfTopic(t), null);
});

/* ================================================================
 * 5. labFor 正例：六个骨架，逐个用真实题目验证「solve() 复现答案」
 * ================================================================ */

console.log('\n--- 5. labFor 正例（六个骨架 × 真实题目） ---');

test('circle-chord：cnm_251_q1 半径 5、弦 8 → 弦心距 3', function () {
  const l = lab('cnm_251_q1');
  assert.ok(l, '应挂图');
  assert.strictEqual(l.skel, 'circle-chord');
  near(G.solve(l).d, 3);
});
test('circle-chord：cnm_251_q2 半径 10、弦心距 6 → 弦 16', function () {
  const l = lab('cnm_251_q2');
  assert.ok(l, '应挂图');
  assert.strictEqual(l.skel, 'circle-chord');
  near(G.solve(l).chord, 16);
});
test('circle-chord：cnm_251_q3 弦 24、弦心距 5 → 半径 13（锁弦心距）', function () {
  const l = lab('cnm_251_q3');
  assert.ok(l, '应挂图');
  assert.strictEqual(l.fixed, 'd', '题面没给半径，拖动时应锁弦心距');
  near(G.solve(l).r, 13);
});
test('circle-inscribed：cnm_253_q1 圆心角 100° → 圆周角 50°', function () {
  const l = lab('cnm_253_q1');
  assert.ok(l, '应挂图');
  assert.strictEqual(l.skel, 'circle-inscribed');
  near(G.solve(l).inscribed, 50);
});
test('circle-inscribed：cnm_253_q2 圆周角 35° → 圆心角 70°', function () {
  const l = lab('cnm_253_q2');
  assert.ok(l, '应挂图');
  near(G.solve(l).central, 70);
});
test('circle-inscribed：cnm_253_q5 劣弧一侧 → 圆周角 130°（不是 50°）', function () {
  const l = lab('cnm_253_q5');
  assert.ok(l, '应挂图');
  assert.strictEqual(l.state.onMinor, true);
  near(G.solve(l).inscribed, 130);
});
test('circle-tangent：cnm_262_q2 OA=3、PA=4 → OP=5', function () {
  const l = lab('cnm_262_q2');
  assert.ok(l, '应挂图');
  assert.strictEqual(l.skel, 'circle-tangent');
  near(G.solve(l).OP, 5);
});
test('circle-tangent：cnm_262_q5 r=6、∠P=30° → OP=12', function () {
  const l = lab('cnm_262_q5');
  assert.ok(l, '应挂图');
  near(G.solve(l).OP, 12);
});
test('circle-tangent：cnm_263_q5 r=3、OP=5 双切线 → 四边形面积 12', function () {
  const l = lab('cnm_263_q5');
  assert.ok(l, '应挂图');
  assert.strictEqual(l.both, true);
  near(G.solve(l).areaPAOB, 12);
});
test('circle-tangent：cnm_263_q2 只给 ∠APB=70° → 角度全定、不显示尺寸（scaleFree）', function () {
  const l = lab('cnm_263_q2');
  assert.ok(l, '应挂图');
  assert.strictEqual(l.scaleFree, true, '题面没给尺寸，不能把归一化长度当真值显示');
  near(G.solve(l).angleAPO, 35);
});
test('similar-parallel：cnm_269_q1 AD=2,DB=3,AE=4 → EC=6', function () {
  const l = lab('cnm_269_q1');
  assert.ok(l, '应挂图');
  assert.strictEqual(l.skel, 'similar-parallel');
  near(G.solve(l).EC, 6);
});
test('similar-parallel：cnm_269_q4 AD=4,DB=2,EC=3 → AC=9', function () {
  const l = lab('cnm_269_q4');
  assert.ok(l, '应挂图');
  near(G.solve(l).AC, 9);
});
test('similar-pair：cnm_270_q2 相似比 2:3、小边 6 → 大边 9', function () {
  const l = lab('cnm_270_q2');
  assert.ok(l, '应挂图');
  assert.strictEqual(l.skel, 'similar-pair');
  near(G.solve(l).big, 9);
});
test('similar-pair：面积比 S大/S小 = k²（2:3 → 9/4 = 2.25）', function () {
  const l = lab('cnm_270_q2');
  near(G.solve(l).areaK, 2.25);
});
test('triangle-right：cnm_174_q3 斜边 17、直角边 8 → 面积 60', function () {
  const l = lab('cnm_174_q3');
  assert.ok(l, '应挂图');
  assert.strictEqual(l.skel, 'triangle-right');
  near(G.solve(l).area, 60);
});
test('triangle-right：cnm_112_q4 6-8-10 + 斜边高 → CD=4.8', function () {
  const l = lab('cnm_112_q4');
  assert.ok(l, '应挂图');
  assert.strictEqual(l.altitude, true, '题面给了 CD⊥AB，应画斜边上的高');
  near(G.solve(l).altitude, 4.8);
});

/* ================================================================
 * 6. labFor 反例（本组必须不挂）
 * ================================================================ */

console.log('\n--- 6. labFor 反例（不该挂的题） ---');

test('反例·双平行弦：cnm_251_q5（两弦距离，单弦骨架画不出）', function () {
  assert.strictEqual(lab('cnm_251_q5'), null);
});
test('反例·同弧两点：cnm_253_q3（点 C、D 在优弧上，要两条圆周角）', function () {
  assert.strictEqual(lab('cnm_253_q3'), null);
});
test('反例·等弧推理：cnm_252_q5（劣弧 AB 与劣弧 AC 相等）', function () {
  assert.strictEqual(lab('cnm_252_q5'), null);
});
test('反例·只给一个角：cnm_262_q3（∠AOP=65° 求 ∠P，尺寸不定）', function () {
  assert.strictEqual(lab('cnm_262_q3'), null);
});
test('反例·弧长题：cnm_256_q1（半径 6、圆心角 60° 求弧长 k）—— 圆周角骨架曾误挂，回归锁死', function () {
  assert.strictEqual(lab('cnm_256_q1'), null);
});
test('反例·扇形面积：cnm_257_q1 —— 同上，图不承载推理', function () {
  assert.strictEqual(lab('cnm_257_q1'), null);
});
test('反例·直径所对圆周角：cnm_254_q2（未实现泰勒斯骨架）', function () {
  assert.strictEqual(lab('cnm_254_q2'), null);
});
test('反例·极值距离：cnm_259_q5（最短距离 3 求最长距离，答案含 OP+r 的拼装）', function () {
  assert.strictEqual(lab('cnm_259_q5'), null);
});
test('反例·有几个解：cnm_260_q2（l 与⊙O 的公共点有几个 → 门禁拦）', function () {
  assert.strictEqual(lab('cnm_260_q2'), null);
});
test('反例·答案即图上数值：cnm_263_q1（PA=6 求 PB=6 → 门禁拦）', function () {
  assert.strictEqual(lab('cnm_263_q1'), null);
});
test('反例·位似坐标：cnm_275_q2（答案就是对应点坐标）', function () {
  assert.strictEqual(lab('cnm_275_q2'), null);
});
test('反例·实景应用：cnm_274_q1（影长求旗杆）', function () {
  assert.strictEqual(lab('cnm_274_q1'), null);
});
test('反例·相似判定依据：cnm_271_q3（答案是一个判定名称，不在图上）', function () {
  assert.strictEqual(lab('cnm_271_q3'), null);
});
test('反例·面积比：cnm_272_q3（∽ + 面积 24 求面积，没有边长可标）', function () {
  assert.strictEqual(lab('cnm_272_q3'), null);
});
test('反例·非本类知识点：cnm_039_q1（一元一次方程）→ null', function () {
  const item = q('cnm_039_q1');
  assert.strictEqual(G.labFor(item.topicId, item.prompt, {
    itemId: item.id, topic: TMAP.get(item.topicId), answer: item.answer, choices: item.choices
  }), null);
});
test('反例·没给 answer：cnm_251_q1 也不挂（无法校验送分）', function () {
  const item = q('cnm_251_q1');
  assert.strictEqual(G.labFor(item.topicId, item.prompt, { itemId: item.id }), null);
});
test('反例·空题面：labFor 不抛异常，返回 null', function () {
  assert.strictEqual(G.labFor('cnm_251', ''), null);
  assert.strictEqual(G.labFor('cnm_251', null, {}), null);
  assert.strictEqual(G.labFor(null, '⊙O 半径 5', {}), null);
});

/* ================================================================
 * 7. 与 F 卡对拍 + 全库覆盖统计
 *    （线上挂图规则必须与 docs/geomlab-coverage.md 的数字同源，否则会悄悄漂移）
 * ================================================================ */

console.log('\n--- 7. 与 F 卡 finalVerdict 对拍（防漂移） ---');

let MC = null;
try { MC = require('../scripts/measure_geomlab_coverage.js'); } catch (e) { MC = null; }

test('F 卡的覆盖率脚本可 require（docs/geomlab-coverage.md 的数字来源）', function () {
  assert.ok(MC, 'scripts/measure_geomlab_coverage.js 应该能 require，且导出 finalVerdict/ROWS');
  assert.strictEqual(typeof MC.finalVerdict, 'function');
  assert.ok(Array.isArray(MC.ROWS));
});

test('安全方向：凡 geomlab 能挂的题，F 卡判定都不能是 no（283 道几何题逐题对拍）', function () {
  assert.ok(MC, '缺少覆盖率脚本');
  const rows = MC.ROWS.filter(function (r) { return r.cls; });
  assert.ok(rows.length > 200, '几何三类题量应 >200，实际 ' + rows.length);
  const bad = [];
  rows.forEach(function (r) {
    const l = G.labFor(r.q.topicId, r.q.prompt, {
      itemId: r.q.id, topic: r.topic, answer: r.q.answer, choices: r.q.choices
    });
    if (l && r.verdict.level === 'no') bad.push(r.q.id + ':' + (r.verdict.riskCode || r.verdict.reason));
  });
  assert.deepStrictEqual(bad, [], '这些题被 F 卡判定不可画，却被挂图了：' + bad.join(','));
});

test('规则方向：F 卡因「风险规则/答案送分/人工定档」判 no 的题，gate 也必须拦（逐题对拍）', function () {
  assert.ok(MC, '缺少覆盖率脚本');
  const VETO = { proof: 1, 'judge-statement': 1, 'locus-motion': 1, 'pure-arithmetic': 1 };
  const drift = [];
  MC.ROWS.forEach(function (r) {
    if (!r.cls) return;
    const v = r.verdict;
    const ruleNo = !!(v.riskCode || v.reason && VETO[v.reason] || (v.manualWhy && v.level === 'no'));
    if (!ruleNo) return;
    const g = G.gate(r.q.prompt, { itemId: r.q.id, answer: r.q.answer, choices: r.q.choices });
    if (!g.blocked) drift.push(r.q.id + ':' + (v.riskCode || v.reason || 'manual'));
  });
  assert.deepStrictEqual(drift, [], 'geomlab 门禁比 F 卡松，这些题会漏挡：' + drift.join(','));
});

test('全库：凡挂上图的题，solve() 必须复现题库答案（数值可校验）', function () {
  assert.ok(MC, '缺少覆盖率脚本');
  const mism = [];
  let count = 0;
  MC.ROWS.forEach(function (r) {
    if (!r.cls) return;
    const l = G.labFor(r.q.topicId, r.q.prompt, {
      itemId: r.q.id, topic: r.topic, answer: r.q.answer, choices: r.q.choices
    });
    if (!l) return;
    count++;
    const v = G.solve(l);
    assert.ok(v, r.q.id + ' 挂上了图却解不出来');
    const nums = Object.keys(v).map(function (k) { return v[k]; })
      .filter(function (x) { return typeof x === 'number' && isFinite(x); })
      .map(function (x) { return Math.round(x * 100) / 100; });
    const ansNums = (answerTextOf(r.q).match(/-?\d+(?:\.\d+)?/g) || []).map(parseFloat);
    const missing = ansNums.filter(function (a) {
      return !nums.some(function (n) { return Math.abs(n - a) < 0.011; });
    });
    if (missing.length) mism.push(r.q.id + ' 缺 ' + missing.join(','));
  });
  assert.ok(count >= 12, '挂图题量应 >=12，实际 ' + count);
  assert.deepStrictEqual(mism, [], '图上的数算不出答案：' + mism.join('；'));
});

/* ================================================================
 * 8. clampArc：C 点必须被限制在正确的弧上
 *    （否则标注的圆周角会与图上画的角度不符 —— 那就是画错图）
 * ================================================================ */

console.log('\n--- 8. clampArc（C 点限制在弧上） ---');

test('优弧：C 被推到下半圆（圆心角 100° 时不允许跑到 (90±50)° 区间）', function () {
  const a = G.clampArc(90, 100, false);      // 试图放到劣弧正中
  assert.ok(a < 40 || a > 140, 'C 不该落在劣弧上，实际 ' + a + '°');
});
test('劣弧：C 被限制在 (90−θ/2, 90+θ/2) 内', function () {
  const a = G.clampArc(270, 100, true);      // 试图放到优弧上
  assert.ok(a > 40 && a < 140, 'C 应被拉回劣弧，实际 ' + a + '°');
});
test('弧内取值不被改动（优弧 270° 原样保留）', function () {
  near(G.clampArc(270, 100, false), 270);
});

/* ================================================================
 * 9. 渲染层硬规则：图上只许出现「题面已知量」
 *
 * 用户判据：图的目的是让学生看懂问题怎么解决，所以画板不得静态标注推导结论
 * （比值 / 面积 / 第三边 / 定理等式）。这一组锁死渲染层的取值口径：
 *   knownText() 题面给了才出数，没给必须是 '?'
 *   deriveText() 永远是 '?'
 *   checkRows() 才是真实值的唯一出口，且只列「图上留了问号 / 题面要问」的量
 * ================================================================ */

console.log('\n--- 9. 渲染层：只标已知量，派生量必须留 ? ---');

/* 每个骨架挑一道典型题：known 是题面公开可见的量，hidden 是绝不能出现在图上的推导量 */
const RENDER_CASES = [
  { id: 'cnm_251_q1', skel: 'circle-chord', known: ['r', 'chord'], hidden: ['d'] },       // 半径 5、弦 8 → 弦心距 3 是答案
  { id: 'cnm_251_q3', skel: 'circle-chord', known: ['chord', 'd'], hidden: ['r'] },       // 弦 24、弦心距 5 → 半径 13 是答案
  { id: 'cnm_253_q1', skel: 'circle-inscribed', known: ['central'], hidden: ['inscribed'] }, // 圆心角 100 → 圆周角 50 是答案
  { id: 'cnm_253_q2', skel: 'circle-inscribed', known: ['inscribed'], hidden: ['central'] },
  { id: 'cnm_262_q2', skel: 'circle-tangent', known: ['r', 'PA'], hidden: ['OP'] },      // OA=3 PA=4 → OP=5 是答案
  { id: 'cnm_269_q1', skel: 'similar-parallel', known: ['AD', 'DB', 'AE'], hidden: ['EC', 'ratio', 'AEoverEC'] },
  { id: 'cnm_174_q3', skel: 'triangle-right', known: ['a', 'c'], hidden: ['b', 'area'] }, // AB=17 AC=8 → 面积 60 是答案
  { id: 'cnm_112_q4', skel: 'triangle-right', known: ['a', 'b', 'c'], hidden: ['area', 'altitude'] }
];

RENDER_CASES.forEach(function (c) {
  test('knownText：' + c.id + '（' + c.skel + '）只有题面给的量出数', function () {
    const l = lab(c.id);
    assert.ok(l, c.id + ' 应挂图');
    assert.strictEqual(l.skel, c.skel, c.id + ' 骨架不符');
    const v = G.solve(l);
    c.known.forEach(function (k) {
      assert.notStrictEqual(G.knownText(l, v, k), '?', c.id + ' 的 ' + k + ' 是题面已知量，应标出数值');
    });
    c.hidden.forEach(function (k) {
      assert.strictEqual(G.knownText(l, v, k), '?', c.id + ' 的 ' + k + ' 是推导结论，图上必须是 ?');
    });
  });
});

test('deriveText 恒为 ?（派生量没有任何出数口径）', function () {
  assert.strictEqual(G.deriveText(), '?');
});

test('相似图：题面要问的 EC 在图上必须是 ?，比值也不得标数', function () {
  const l = lab('cnm_269_q1');
  const v = G.solve(l);
  near(v.EC, 6, 1e-9, '内部计算仍须正确（EC=6）：');
  assert.strictEqual(G.knownText(l, v, 'EC'), '?');
  /* knownList 只列已知量，不能把 EC 也列进去 */
  const listed = G.knownList(l, v);
  assert.ok(!/EC/.test(listed), '已知量行不该出现 EC，实际：' + listed);
  assert.ok(/AD/.test(listed) && /DB/.test(listed) && /AE/.test(listed), '已知量行应含 AD/DB/AE：' + listed);
});

test('area 永远进不了 knownText：没有任何骨架把面积当已知量', function () {
  Object.keys(G.GIVEN_KEYS).forEach(function (skel) {
    assert.ok(G.GIVEN_KEYS[skel].indexOf('area') < 0, skel + ' 不该把 area 列为可给定');
    assert.ok(G.GIVEN_KEYS[skel].indexOf('ratio') < 0, skel + ' 不该把 ratio 列为可给定');
  });
});

test('checkRows：真实值只出现在自检面板里，且覆盖图上留 ? 的量', function () {
  RENDER_CASES.forEach(function (c) {
    const l = lab(c.id);
    const v = G.solve(l);
    const rows = G.checkRows(l, v);
    assert.ok(rows.length > 0, c.id + ' 的自检面板应有可核对的行');
    const names = rows.map(function (r) { return r.name; }).join('|');
    /* 图上留了 ? 的关键量，必须在自检行里能找到对应条目 */
    if (c.id === 'cnm_251_q1') assert.ok(/弦心距/.test(names), '自检应含弦心距：' + names);
    if (c.id === 'cnm_253_q1') assert.ok(/圆周角/.test(names), '自检应含圆周角：' + names);
    if (c.id === 'cnm_262_q2') assert.ok(/OP/.test(names), '自检应含 OP：' + names);
    if (c.id === 'cnm_269_q1') {
      assert.ok(/EC/.test(names), '自检应含 EC：' + names);
      assert.ok(/AD\/DB/.test(names) && /AE\/EC/.test(names), '自检应含两个比值：' + names);
    }
    if (c.id === 'cnm_174_q3') assert.ok(/面积/.test(names), '自检应含面积：' + names);
    rows.forEach(function (r) {
      assert.ok(r.real != null && isFinite(r.real), c.id + ' 的自检行 ' + r.name + ' 应有真实数值');
      assert.strictEqual(r.yours, '', '「你算的」默认必须是空位（不能预先填好答案）');
    });
  });
});

test('自检行不输出「题面已知量」的假结果：cnm_174_q3 不给 AB 再列一遍', function () {
  const l = lab('cnm_174_q3');
  const names = G.checkRows(l, G.solve(l)).map(function (r) { return r.name; }).join('|');
  assert.ok(!/斜边/.test(names), 'AB=17 是题面已知量，自检不该重复列：' + names);
  assert.ok(!/直角边 AC/.test(names), 'AC=8 是已知量，不该列：' + names);
  assert.ok(/直角边 BC/.test(names), 'BC 是要求的那条，应列：' + names);
});

/* ---- 拖动幅度：不变量必须在拖动全程有肉眼可辨的变化 ---- */

console.log('\n--- 10. 拖动幅度（不变量要有明显变化） ---');

test('相似：AD 从 8% 拖到 92%，AD/DB 与 AE/EC 同步且变化幅度 > 10 倍', function () {
  const l = lab('cnm_269_q1');
  const AB = l.state.AB;
  l.state.AD = 0.08 * AB;
  const lo = G.solve(l);
  l.state.AD = 0.92 * AB;
  const hi = G.solve(l);
  near(lo.ratio, lo.AEoverEC, 1e-9, '起点两比值应相等：');
  near(hi.ratio, hi.AEoverEC, 1e-9, '终点两比值应相等：');
  assert.ok(hi.ratio / lo.ratio > 10, 'AD/DB 应从 ' + lo.ratio + ' 变到 ' + hi.ratio + '（>10 倍）');
  assert.ok(lo.AD > 0 && lo.DB > 0 && hi.AE > 0 && hi.EC > 0, '两端都不能退化');
});

test('圆·弦：弦长可拖到 8% 半径，弦心距 OH 随之明显改变', function () {
  const l = lab('cnm_251_q1');
  l.state.chord = 2 * l.state.r * 0.999;
  const wide = G.solve(l);
  l.state.chord = 0.08 * 2 * l.state.r;
  const narrow = G.solve(l);
  near(wide.r, 5, 1e-9, '半径锁住：');
  /* 弦接近直径时 OH → 0（0.999 直径对应 OH ≈ 0.22，几何上就该这么大） */
  assert.ok(wide.d < 0.3, '弦接近直径时 OH 应接近 0，实际 ' + wide.d);
  assert.ok(narrow.d > 4.9, '弦缩到 8% 直径时 OH 应接近半径，实际 ' + narrow.d);
  /* 关键：OH 的全程变化幅度要肉眼可辨（0.22 → 4.98，二十倍以上） */
  assert.ok(narrow.d / wide.d > 10, 'OH 应至少变 10 倍：' + wide.d + ' → ' + narrow.d);
});

test('三角形：直角边缩到 0.35×，面积与斜边都明显变小', function () {
  const l = lab('cnm_174_q3');
  const base = G.solve(l);
  l.state.a = 0.35 * base.a;
  l.state.b = 0.35 * base.b;
  const small = G.solve(l);
  assert.ok(small.area / base.area < 0.15, '面积应缩到 ' + (small.area / base.area).toFixed(3) + ' 倍');
  assert.ok(base.c - small.c > 5, '斜边应明显变短：' + base.c + ' → ' + small.c);
});

/* ================================================================ */


console.log('\n' + (failed === 0 ? '全部通过' : '存在失败') + '：' + passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);
