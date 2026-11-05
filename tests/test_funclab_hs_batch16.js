#!/usr/bin/env node
/* 高中函数画板 批1.6（t_e63a9673）：白名单最后 6 题上线 —— 4 能力缺口 + 2 全角区间
 *   node tests/test_funclab_hs_batch16.js
 *
 * 批1.5（t_f752c3df）把白名单 14 题里的 8 题接通，剩下 6 条卡在两处：
 *   · 4 条能力缺口：quadratic 的 canAnswer 里没有「交点个数 / 单调性 / 奇偶性」三个问法，
 *     LLM 严格按清单拒挂（cnm_h023_q4 / cnm_h032_q4 / cnm_h035_q1 / cnm_h036_q4）；
 *   · 2 条区间缺口：题面区间写作 `x∈[−1，2]`（全角逗号 + 数学减号），promptInterval 抠不出端点，
 *     代回校验永远说「区间端点无法校核」（cnm_h034_q2 / cnm_h227_q2）。
 *
 * 本文件锁六件事：
 *   1. 白名单 14 题**逐题**过「表 + intent + 代回」三道闸 —— 这就是「线上可见 8→14」的机器判据；
 *   2. 三条新能力项都在 CAPABILITIES / CAP_TYPE 里注册，且 intentSupported 成立（能渲染才收）；
 *   3. 三条新文案**答案真能从图上读出来**：数绿点 / 看走向 / 看对称轴与 y 轴重不重合；
 *      且不许出现「根」字（非根的 intent）、不许报出派生值（个数、h、k）；
 *   4. 「与 x 轴交点的个数」的答案行 0 / 1 / 2 三态都对（含无交点时必须给输入行，学生要能填 0）；
 *   5. 区间解析入口的全角归还化：认 `[−1，2]`、`［−1，2］`、`０＜x＜２`，**不认**无界 `[0,+∞)`、
 *      点的坐标 `(−1，2)`；并加一条反例 —— 含全角逗号但不是区间的题干不得被误认成区间；
 *   6. 归一化不许渗进 funclab.js：fromPrompt 的曲线解析语义零改动（结构断言 + 行为断言）。
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e).split('\n').slice(0, 8).join('\n       ')); }
}

const F = require('../diagnose/funclab.js');
const L = require('../diagnose/labmatch.js');
const QUESTIONS = require('../data/questions.json');
const QMAP = new Map(QUESTIONS.map(function (x) { return [x.id, x]; }));
function q(id) {
  const item = QMAP.get(id);
  assert.ok(item, '题库里找不到题目 ' + id);
  return item;
}

/* 白名单 14 题 × (画板, intent)；区间题另给端点来源（promptInterval 实抠）。
 * 前 8 条是批1.5 已接通的，本卡只许它们零回退；后 6 条是本卡新接通的。 */
const LEDGER = [
  { id: 'cnm_h029_q2', lab: 'quadratic-vertex', intent: '最大值', since: '1.5' },
  { id: 'cnm_h034_q3', lab: 'quadratic-vertex', intent: '最大值', since: '1.5' },
  { id: 'cnm_h049_q1', lab: 'quadratic-roots', intent: '零点', since: '1.5' },
  { id: 'cnm_h226_q1', lab: 'quadratic-vertex', intent: '顶点坐标', since: '1.5' },
  { id: 'cnm_h032_q1', lab: 'linear-trend', intent: 'y 随 x 的增大而增大还是减小', since: '1.5' },
  { id: 'cnm_h032_q2', lab: 'linear-trend', intent: 'y 随 x 的增大而增大还是减小', since: '1.5' },
  { id: 'cnm_h049_q2', lab: 'linear-intercepts', intent: '与 x 轴交点的横坐标', since: '1.5' },
  { id: 'cnm_h028_q3', lab: 'inverse-domain', intent: '定义域', since: '1.5' },
  { id: 'cnm_h023_q4', lab: 'quadratic-roots', intent: '与 x 轴交点的个数', since: '1.6' },
  { id: 'cnm_h032_q4', lab: 'quadratic-monotonic', intent: '单调性', since: '1.6' },
  { id: 'cnm_h035_q1', lab: 'quadratic-parity', intent: '奇偶性', since: '1.6' },
  { id: 'cnm_h036_q4', lab: 'quadratic-parity', intent: '奇偶性', since: '1.6' },
  { id: 'cnm_h034_q2', lab: 'quadratic-range-on-interval', intent: '在给定区间上的最小值', since: '1.6' },
  { id: 'cnm_h227_q2', lab: 'quadratic-range-on-interval', intent: '在给定区间上的最小值', since: '1.6' }
];

/** 按台账一题一遍走三道闸；返回失败原因数组（空 = 全过） */
function gateAll() {
  const bad = [];
  LEDGER.forEach(function (c) {
    const item = q(c.id);
    const scene = F.labForScene(item.topicId, item.prompt, { itemId: c.id });
    if (!scene) { bad.push(c.id + ' labForScene=null'); return; }
    const params = Object.assign({}, scene);
    delete params.type;
    delete params.base;
    const iv = L.promptInterval(item.prompt);
    if (iv) { params.xMin = iv.xMin; params.xMax = iv.xMax; }
    if (!F.intentSupported(c.lab, c.intent)) { bad.push(c.id + ' ' + c.lab + '/' + c.intent + ' intent 不支持'); return; }
    const v = L.verifyParams(item.prompt, { match: c.lab, intent: c.intent, params: params }, { itemId: c.id });
    if (!v.ok) { bad.push(c.id + ' 代回不过：' + v.why.join('; ')); return; }
    if (!F.noteText(c.lab, c.intent, params)) bad.push(c.id + ' 没有文案');
  });
  return bad;
}

/* ================================================================
 * 1. 14 题全部线上可见（8→14 的机器判据）
 * ================================================================ */

test('白名单 14 题逐题过「表 + intent + 代回」三道闸（8 条旧题零回退）', function () {
  const bad = gateAll();
  assert.deepStrictEqual(bad, [], bad.join(' / '));
  assert.strictEqual(LEDGER.length, 14, '台账必须恰好 14 题');
  assert.strictEqual(LEDGER.filter(function (c) { return c.since === '1.6'; }).length, 6, '本卡新接通 6 题');
});

test('HS_ITEMS 仍是 14 条，一题不增一题不删（白名单是批1/1.5 成果）', function () {
  const ids = Object.keys(F.HS_ITEMS).sort();
  assert.strictEqual(ids.length, 14);
  assert.deepStrictEqual(ids, LEDGER.map(function (c) { return c.id; }).sort());
});

test('高中全量挂载仍是 17 题（本批 14 + 既有 cnm_h172 三题），没有顺手放宽', function () {
  const hs = QUESTIONS.filter(function (x) { return /^cnm_h/.test(x.id); });
  const mounted = hs.filter(function (x) {
    return !!F.labForScene(x.topicId, x.prompt, { itemId: x.id });
  }).map(function (x) { return x.id; }).sort();
  assert.deepStrictEqual(mounted, LEDGER.map(function (c) { return c.id; })
    .concat(['cnm_h172_q1', 'cnm_h172_q2', 'cnm_h172_q3']).sort());
});

/* ================================================================
 * 2. 三条新能力项注册
 * ================================================================ */

test('「与 x 轴交点的个数」挂在 quadratic-roots 上，且能渲染', function () {
  const cap = F.CAPABILITIES['quadratic-roots'];
  assert.ok(cap.canAnswer.indexOf('与 x 轴交点的个数') >= 0, 'canAnswer 必须逐字含这一项');
  assert.ok(F.intentSupported('quadratic-roots', '与 x 轴交点的个数'));
});

test('「单调性」「奇偶性」各有独立画板，CAP_TYPE 归 quadratic', function () {
  assert.deepStrictEqual(F.CAPABILITIES['quadratic-monotonic'].canAnswer, ['单调性']);
  assert.deepStrictEqual(F.CAPABILITIES['quadratic-parity'].canAnswer, ['奇偶性']);
  assert.strictEqual(F.CAP_TYPE['quadratic-monotonic'], 'quadratic');
  assert.strictEqual(F.CAP_TYPE['quadratic-parity'], 'quadratic');
  assert.ok(F.intentSupported('quadratic-monotonic', '单调性'));
  assert.ok(F.intentSupported('quadratic-parity', '奇偶性'));
});

test('匹配层喂给 LLM 的 quadratic 候选画板里确实有这三个 lab', function () {
  const labs = Object.keys(F.capabilitiesFor('quadratic'));
  ['quadratic-roots', 'quadratic-monotonic', 'quadratic-parity'].forEach(function (lab) {
    assert.ok(labs.indexOf(lab) >= 0, 'capabilitiesFor(quadratic) 缺 ' + lab);
  });
});

/* ================================================================
 * 3. 文案：答案真能从图上读出来，且不剧透
 * ================================================================ */

test('交点个数文案：读数动作是「数绿点」，不出现「根」字、不报个数', function () {
  const s = F.noteText('quadratic-roots', '与 x 轴交点的个数', { a: 1, h: 0, k: 1 });
  assert.ok(s, '必须生成文案');
  assert.ok(/绿色圆点|绿点/.test(s), '必须点明绿点（原文字样：' + s + '）');
  assert.ok(/数一数/.test(s), '必须给出读数动作：数一数');
  assert.ok(s.indexOf('根') < 0, '非根的 intent 不许出现「根」字');
  assert.ok(!/\d/.test(s.replace(/a = 1/g, '')), '文案里不许出现数字（个数就是答案）：' + s);
});

test('单调性文案：靠曲线在对称轴两侧的走向读，不报 h/k', function () {
  const s = F.noteText('quadratic-monotonic', '单调性', { a: 2, h: -1, k: -4 });
  assert.ok(s.indexOf('对称轴') >= 0, '必须提对称轴这条参照线');
  assert.ok(/上升/.test(s) && /下降/.test(s), '必须讲清两侧走向相反');
  assert.ok(/增函数|递减|递增/.test(s), '必须落到「增/减」的结论词');
  assert.ok(s.indexOf('a = 2') >= 0, '已知量 a 照常显示');
  assert.ok(s.indexOf('-1') < 0 && s.indexOf('-4') < 0, '不许报出顶点 (h,k)：' + s);
});

test('奇偶性文案：靠「对称轴与 y 轴重不重合」读，且不报 h', function () {
  const s = F.noteText('quadratic-parity', '奇偶性', { a: 1, h: -0.5, k: -0.25 });
  assert.ok(s.indexOf('y 轴') >= 0 && s.indexOf('对称轴') >= 0, '必须把两条线都点出来');
  assert.ok(/重合/.test(s), '读数动作是「重不重合」');
  assert.ok(/偶函数/.test(s) && /f\(-x\)/.test(s), '必须落到偶函数的定义');
  assert.ok(s.indexOf('-0.5') < 0 && s.indexOf('-0.25') < 0, '不许报出 h/k：' + s);
});

test('三条文案都不许串台（出现别的函数的专属名词）', function () {
  [['quadratic-roots', '与 x 轴交点的个数'], ['quadratic-monotonic', '单调性'], ['quadratic-parity', '奇偶性']]
    .forEach(function (pair) {
      const s = F.noteText(pair[0], pair[1], { a: 1, h: 0, k: -4 });
      assert.ok(s.indexOf('双曲线') < 0 && s.indexOf('直线') < 0, pair[0] + ' 串台：' + s);
    });
});

/* ================================================================
 * 4. 答案行：交点个数 0 / 1 / 2 三态
 * ================================================================ */

test('「与 x 轴交点的个数」答案行：无交点 → 0（必须给输入行，学生要能填 0）', function () {
  const rows = F.answerRows('quadratic-roots', '与 x 轴交点的个数', { a: 1, h: 0, k: 1 });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].real, 0);
});

test('「与 x 轴交点的个数」答案行：相切 → 1、两个交点 → 2', function () {
  assert.strictEqual(F.answerRows('quadratic-roots', '与 x 轴交点的个数', { a: 1, h: 2, k: 0 })[0].real, 1);
  assert.strictEqual(F.answerRows('quadratic-roots', '与 x 轴交点的个数', { a: 1, h: 0, k: -4 })[0].real, 2);
  /* 开口向下也一样按判别式数 */
  assert.strictEqual(F.answerRows('quadratic-roots', '与 x 轴交点的个数', { a: -1, h: 0, k: -4 })[0].real, 0);
});

test('单调性 / 奇偶性不是数值题：不给输入行（不许硬凑一个数当答案）', function () {
  assert.deepStrictEqual(F.answerRows('quadratic-monotonic', '单调性', { a: 1, h: 0, k: -4 }), []);
  assert.deepStrictEqual(F.answerRows('quadratic-parity', '奇偶性', { a: 1, h: 0, k: -4 }), []);
});

/* ================================================================
 * 5. 区间解析入口：全角归一化（+ 三条反例）
 * ================================================================ */

test('promptInterval 认全角区间：x∈[−1，2] / 在 [0，3] 上', function () {
  assert.deepStrictEqual(L.promptInterval(q('cnm_h034_q2').prompt), { xMin: -1, xMax: 2 });
  assert.deepStrictEqual(L.promptInterval(q('cnm_h227_q2').prompt), { xMin: 0, xMax: 3 });
});

test('promptInterval 认全角方括号与全角数字（［−1，2］ / ０＜x＜２）', function () {
  assert.deepStrictEqual(L.promptInterval('f(x)=x²，x∈［−1，2］'), { xMin: -1, xMax: 2 });
  assert.deepStrictEqual(L.promptInterval('当 ０＜x＜２ 时，求最大值'), { xMin: 0, xMax: 2 });
});

test('历史写法零变化：2≤x≤4 仍抠出 [2,4]，无区间题仍 null', function () {
  assert.deepStrictEqual(L.promptInterval(q('cnm_235_q4').prompt), { xMin: 2, xMax: 4 });
  assert.strictEqual(L.promptInterval(q('cnm_235_q2').prompt), null);
});

test('反例 1：含全角逗号但不是区间 → null（不许被归一化「造」出区间）', function () {
  assert.strictEqual(L.promptInterval('已知 f(x)=x²+1，x 轴交点有几个？'), null);
  assert.strictEqual(L.promptInterval('当 x=1，y=2 时，求函数值。'), null);
});

test('反例 2：点的坐标 (−1，2) 是圆括号，不是区间 → null', function () {
  assert.strictEqual(L.promptInterval('点 P(−1，2) 在抛物线 y=x² 上，求 a。'), null);
});

test('反例 3：无界/半开区间 [0，+∞) 画不出阴影 → null', function () {
  assert.strictEqual(L.promptInterval(q('cnm_h032_q4').prompt), null);
  assert.strictEqual(L.promptInterval('[0，+∞) 上单调递增'), null);
});

test('归一化只作用于区间解析：不认识「全角」的地方行为一字不变（结构断言）', function () {
  const funclabSrc = fs.readFileSync(path.join(__dirname, '..', 'diagnose', 'funclab.js'), 'utf8');
  assert.ok(funclabSrc.indexOf('normalizeIntervalText') < 0,
    '全角归一化不许渗进 funclab.js —— fromPrompt 的曲线解析语义必须零改动');
  assert.ok(Object.keys(L).indexOf('normalizeIntervalText') < 0,
    '归一化函数不许导出（作用范围限定在 promptInterval 内部）');
});

test('fromPrompt 行为零改动：同一题面加不加全角逗号，解析结果一致且与批1.5 同值', function () {
  /* fromPrompt 本就不认区间，只认 y= 表达式：全角逗号出现在题面里不该改变它的结果 */
  const a = F.fromPrompt('y=x²−2x 在 [0，3] 上的最小值是多少？');
  const b = F.fromPrompt('y=x²−2x 在 [0,3] 上的最小值是多少？');
  assert.deepStrictEqual(a, b, 'fromPrompt 的结果不该受区间标点影响');
  assert.deepStrictEqual(F.fromPrompt('y=x²-2x-3'), { type: 'quadratic', a: 1, h: 1, k: -4 }, 'fromPrompt 的曲线解析值与批1.5 一致');
  assert.ok(a && a.xMin === undefined && a.xMax === undefined, 'fromPrompt 不产出区间端点（那是 promptInterval 的活）');
});

/* ================================================================
 * 6. describe：AI 讲解看到的画板描述与新画法一致
 * ================================================================ */

test('describe：三个新组合都非空，且描述里的画法与学生看到的画法一致', function () {
  const d1 = F.describe('quadratic-roots', '与 x 轴交点的个数', { a: 1, h: 0, k: 1 });
  assert.ok(d1 && d1.indexOf('没有绿色圆点') >= 0, '无交点时描述必须说图上没有绿点：' + d1);
  const d2 = F.describe('quadratic-monotonic', '单调性', { a: 1, h: 0, k: -4 });
  assert.ok(d2 && d2.indexOf('升降方向') >= 0, '单调性描述必须讲走向：' + d2);
  const d3 = F.describe('quadratic-parity', '奇偶性', { a: 1, h: 0, k: -4 });
  assert.ok(d3 && d3.indexOf('紫色虚线') >= 0 && d3.indexOf('y 轴') >= 0, '奇偶性描述必须讲紫线与 y 轴：' + d3);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exitCode = failed ? 1 : 0;
