#!/usr/bin/env node
/* 高中函数画板 批1（t_d3c2ba81）：二次 10 / 一次 3 / 反比例 1 —— **逐题白名单**测试
 *   node tests/test_funclab_hs_batch1.js
 *
 * 本批只做「门禁」：把答案就落在画板标注语义里的高中题逐题放行（diagnose/funclab.js 的
 * HS_ITEMS 表），fromPrompt / 绘制 / 标注渲染一行未改。所以这里锁五件事：
 *
 *   1. 表内 14 题**必须挂得上**，且类型与表里写的一致（放行表与实现不许漂移）；
 *   2. 表外高中题**一个都不许挂**——高中全量挂载只允许「本批 14 + 既有 cnm_h172 三题」；
 *      尤其测算判 `misleading` 的那 31 条（切线读数 / 和差组合量 / 概念判断 / 边界读数），
 *      任一条能挂上就是误挂回归，本文件直接红；
 *   3. 敏感项（`f'(x)=0` 三题 + 两条灰区）按板主「严读」口径**不进表**，三角/指对/幂根式
 *      也一条不进（批2/批3 才做）；
 *   4. 初中那 163 条的行为零变化：初中挂载总数、几个典型知识点（直线 / 方程 / 反比例 / 双曲线）
 *      的放行结果原样锁住 —— 白名单只加不删；
 *   5. 表内集合的**来源可复现**：它就是测算脚本判 `gated ok` 的三族题减去敏感项，
 *      不是人工挑出来的（防止以后有人按喜好加题）。
 *
 * 约定：所有题面都取自 data/questions.json 的真实 prompt（q(id) 取不到直接失败），不臆造题面。
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
const M = require('../scripts/measure_highschool_funclab_coverage.js');
const QUESTIONS = require('../data/questions.json');
const TOPICS = require('../data/topics.json');
const QMAP = new Map(QUESTIONS.map(function (x) { return [x.id, x]; }));
const TOPIC = new Map(TOPICS.map(function (t) { return [t.id, t]; }));

/** 按题库 id 取真题；id 不在了就炸（防止题库改动后测试悄悄失效） */
function q(id) {
  const item = QMAP.get(id);
  assert.ok(item, '题库里找不到题目 ' + id + '（题库改过了？请更新测试）');
  return item;
}

/* 主口径：docs/highschool-funclab-coverage.md §0 的 7 个函数语义章（384 题）。
 * 只有落在这里面的题才参与「gated ok / misleading」的判定，和测算脚本同口径。 */
const MAIN_CHAPTERS = [
  '高一 第三章 函数的概念与性质',
  '高一 第二章 一元二次函数、方程和不等式',
  '高一 第四章 指数函数与对数函数',
  '高一 第五章 三角函数',
  '选必二 第五章 一元函数的导数及其应用',
  '选必二 第四章 数列',
  '高一 数学建模 建立函数模型'
];
function chapterOf(item) { const t = TOPIC.get(item.topicId); return t ? String(t.chapter || '') : ''; }
function inMain(item) { return MAIN_CHAPTERS.some(function (c) { return chapterOf(item).indexOf(c) === 0; }); }

/** 与测算脚本 FAMILY_OF 同口径的族名（一次/二次/反比例三族叫 existing.*） */
function famOf(p) {
  if (!p.family) return 'fail:' + p.why;
  if (p.params === null) return p.family === 'letter-param' ? 'fail:letter-param' : p.family;
  return p.family + (p.params && p.params.type ? '.' + p.params.type : '');
}
/** 测算脚本每题判定：{ fam, verdict, code }；解析不出曲线返回 null */
function measureOf(item) {
  const p = M.parseFunction(item.prompt);
  if (!p || !p.family || !p.params) return { fam: famOf(p || {}), j: null };
  let j = null;
  try { j = M.judge(p, item); } catch (e) { j = { verdict: 'misleading', code: 'judge-error' }; }
  return { fam: famOf(p), j: j };
}

/* ================================================================
 * 白名单期望表：题 id → 画板类型
 *   这份表是「契约」。改它 = 改产品行为，必须同时改 funclab.js 的 HS_ITEMS，
 *   并在 docs/highschool-funclab-coverage.md §8 记录理由。
 * ================================================================ */
const WANT = {
  /* 二次函数 10：绿点个数 / 顶点极值 / 单调 / 奇偶 / 零点 */
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
  /* 一次函数 3：单调 / 零点 */
  'cnm_h032_q1': 'linear',
  'cnm_h032_q2': 'linear',
  'cnm_h049_q2': 'linear',
  /* 反比例 1：定义域边界 = 渐近线 */
  'cnm_h028_q3': 'inverse'
};

/* 测算判 `misleading` 的 31 条（docs/highschool-funclab-coverage.md §3/§6）：
 * 挂了就是误导 —— 21 条切线读数、8 条和差/组合量、1 条概念判断、1 条边界读数。
 * 这份清单是**闸门**：以后谁想「顺手多放几题」，先看这里能不能过。
 * 下面 [来源可复现] 那组测试会把它与测算脚本的实跑结果逐条对齐，手写清单漂移就红。 */
const MISLEADING = [
  'cnm_h027_q4', // asks-concept              概念判断，画板不能替学生下结论
  'cnm_h029_q3', // asks-combination          和差/组合量
  'cnm_h032_q3', // asks-combination
  'cnm_h033_q1', // asks-combination
  'cnm_h033_q2', // asks-combination
  'cnm_h033_q3', // asks-combination
  'cnm_h035_q3', // asks-combination
  'cnm_h035_q4', // asks-combination
  'cnm_h049_q3', // asks-combination
  'cnm_h069_q4', // answer-not-on-board       tan 90° 边界读数（板主灰区裁定：并入敏感项）
  'cnm_h216_q2', // needs-tangent-board       切线/导数读数，归切线画板
  'cnm_h217_q1', // needs-tangent-board
  'cnm_h217_q2', // needs-tangent-board
  'cnm_h218_q3', // needs-tangent-board
  'cnm_h219_q1', // needs-tangent-board
  'cnm_h220_q1', // needs-tangent-board
  'cnm_h220_q2', // needs-tangent-board
  'cnm_h220_q3', // needs-tangent-board
  'cnm_h221_q1', // needs-tangent-board
  'cnm_h221_q2', // needs-tangent-board
  'cnm_h222_q1', // needs-tangent-board
  'cnm_h222_q2', // needs-tangent-board
  'cnm_h222_q3', // needs-tangent-board
  'cnm_h223_q1', // needs-tangent-board
  'cnm_h223_q2', // needs-tangent-board
  'cnm_h223_q3', // needs-tangent-board
  'cnm_h224_q1', // needs-tangent-board
  'cnm_h225_q2', // needs-tangent-board
  'cnm_h225_q3', // needs-tangent-board
  'cnm_h229_q1', // needs-tangent-board
  'cnm_h229_q3'  // needs-tangent-board
];

/* 敏感项（板主 2026-11-05 裁定「严读」）：
 *   · 三题问 `f'(x)=0` 的横坐标 —— 虽然画板标了极值点横坐标，但凡问导数一律归「切线画板」
 *     （尚未立项），本批不放行；
 *   · 两条灰区（简报 §2）：cnm_h066_q4 的 sin 无边界属性质题、cnm_h069_q4 的 tan 90° 画板
 *     有渐近线可读 —— 一并按敏感项处理，不放进本批。 */
const SENSITIVE = [
  'cnm_h225_q1', // f(x)=x²−4x，f'(x)=0 → x（二次族，测算判 ok）
  'cnm_h228_q2', // 面积 S=x(10−x)，S'(x)=0 → x（二次族，测算判 ok；且 S= 记法解析不出）
  'cnm_h229_q2', // f(x)=x³−3x，f'(x)=0 → 正的 x（三次族，本批不做）
  'cnm_h066_q4', // y=sin x 的定义域（三角族，批2 才做）
  'cnm_h069_q4'  // y=tan x 在 x=90°（三角族，批2 才做；测算判 misleading）
];

/* 本批明确不做的族（批2/批3 + 永久排除），这些题一条都不许挂。
 * 只取样例：全量由「高中挂载恰好 17 题」那条兜住。 */
const NOT_THIS_BATCH = [
  'cnm_h066_q3', // 三角 周期 2π（批2；若挂，标注必须把 2π 直接标在图上）
  'cnm_h075_q2', // 三角 周期 π（批2）
  'cnm_h046_q2', // 对数 定义域（批3）
  'cnm_h025_q3', // 二次 含参母题（永久排除：形状不唯一）
  'cnm_h030_q2', // 只给若干函数值（永久排除）
  'cnm_h217_q3', // 只给导函数 f'(x)（永久排除）
  'cnm_h028_q4'  // 复合式 √(4−x)+1/(x−1)（永久排除）
];

/* 批1 之前就存在的高中放行口：cnm_h172（两条直线交点）走多曲线画板，本批原样保留 */
const PRE_EXISTING_CURVES = ['cnm_h172_q1', 'cnm_h172_q2', 'cnm_h172_q3'];

/* ================================================================
 * 1. 放行表 ↔ 实现：一字不差
 * ================================================================ */

test('HS_ITEMS 是逐题表，键集合与契约表一致（14 题）', function () {
  assert.ok(F.HS_ITEMS, 'funclab 必须导出 HS_ITEMS（放行表），否则测试无法核对');
  const got = Object.keys(F.HS_ITEMS).sort();
  const want = Object.keys(WANT).sort();
  assert.deepStrictEqual(got, want, 'HS_ITEMS 与测试契约表不一致：多 ' + got.filter(function (k) { return want.indexOf(k) < 0; }).join(',') +
    '；少 ' + want.filter(function (k) { return got.indexOf(k) < 0; }).join(','));
  want.forEach(function (id) {
    assert.strictEqual(F.HS_ITEMS[id], WANT[id], id + ' 的画板类型应为 ' + WANT[id]);
  });
});

test('HS_ITEMS 的题族配比 = 二次 10 / 一次 3 / 反比例 1', function () {
  const cnt = { quadratic: 0, linear: 0, inverse: 0 };
  Object.keys(F.HS_ITEMS).forEach(function (id) { cnt[F.HS_ITEMS[id]]++; });
  assert.deepStrictEqual(cnt, { quadratic: 10, linear: 3, inverse: 1 });
});

test('表内 id 全部真实存在，且题面就在对应知识点下', function () {
  Object.keys(F.HS_ITEMS).forEach(function (id) {
    const item = q(id);
    assert.strictEqual(item.topicId, id.replace(/_q\d+$/, ''), id + ' 的 topicId 与 id 前缀不一致');
  });
});

/* ================================================================
 * 2. 表内每题必须挂得上（漏挂 = 本批白干）
 * ================================================================ */

test('表内 14 题 labFor 全部挂得上，类型与表一致', function () {
  Object.keys(WANT).forEach(function (id) {
    const item = q(id);
    const got = F.labFor(item.topicId, item.prompt, { itemId: id });
    assert.ok(got, id + ' 应挂上画板，实际 null（题面：' + item.prompt + '）');
    assert.strictEqual(got.type, WANT[id], id + ' 解析出的类型应为 ' + WANT[id]);
  });
});

test('表内 14 题 labForScene 全部挂得上（学生实际走的入口）', function () {
  Object.keys(WANT).forEach(function (id) {
    const item = q(id);
    const scene = F.labForScene(item.topicId, item.prompt, { itemId: id });
    assert.ok(scene, id + ' labForScene 应挂上，实际 null');
    assert.strictEqual(scene.type, WANT[id], id + ' labForScene 类型应为 ' + WANT[id]);
  });
});

test('表内 4 条 f(x)= 记法题靠别名解析（fromPrompt 本身只认 y=）', function () {
  ['cnm_h032_q1', 'cnm_h032_q2', 'cnm_h049_q2', 'cnm_h028_q3'].forEach(function (id) {
    const item = q(id);
    assert.ok(/f\s*\(\s*x\s*\)\s*=/.test(item.prompt), id + ' 应是 f(x)= 记法（题库变了？）');
    assert.strictEqual(F.fromPrompt(item.prompt), null, id + '：fromPrompt 原样不认 f(x)=，别名兜底才有意义');
    assert.ok(F.labFor(item.topicId, item.prompt, { itemId: id }), id + ' 应靠别名挂上');
  });
});

/* ================================================================
 * 3. 门禁必须是 fail-closed：没题 id / 表外题 id 一律不挂
 * ================================================================ */

test('表内题不带 itemId 时不挂（fail-closed，宁可无图不可错图）', function () {
  Object.keys(WANT).forEach(function (id) {
    const item = q(id);
    assert.strictEqual(F.labForScene(item.topicId, item.prompt), null, id + ' 无 itemId 时不应挂');
    assert.strictEqual(F.labFor(item.topicId, item.prompt), null, id + ' 无 itemId 时不应挂');
  });
});

test('f(x)= 别名不扩散：表外 itemId 用同样的题面仍不挂', function () {
  const item = q('cnm_h049_q2');                 // 表内题面（f(x)=x−5）
  const other = q('cnm_h049_q3');                // 同知识点、表外题
  assert.ok(F.labForScene(item.topicId, item.prompt, { itemId: item.id }), '表内题应挂');
  assert.strictEqual(F.labForScene(other.topicId, item.prompt, { itemId: other.id }), null,
    '同一题面挂到表外 itemId 上必须不挂（别名只服务白名单题）');
});

/* ================================================================
 * 4. 误挂回归闸门：31 条一条都不许挂
 * ================================================================ */

test('测算判 misleading 的 31 题：labFor 与 labForScene 都必须返回 null', function () {
  assert.strictEqual(MISLEADING.length, 31, '误挂清单应恰好 31 条');
  const bad = [];
  MISLEADING.forEach(function (id) {
    const item = q(id);
    if (!inMain(item)) bad.push(id + '(不在主口径章里，清单过期)');
    if (F.labFor(item.topicId, item.prompt, { itemId: id })) bad.push(id);
    if (F.labForScene(item.topicId, item.prompt, { itemId: id })) bad.push(id + '(scene)');
  });
  assert.deepStrictEqual(bad, [], '这些题挂了就是误挂回归：' + bad.join(','));
});

test('敏感项 5 题（f\'(x)=0 三题 + 两条灰区）不在表内、也挂不上', function () {
  SENSITIVE.forEach(function (id) {
    assert.strictEqual(F.HS_ITEMS[id], undefined, id + ' 不应进 HS_ITEMS（板主严读口径）');
    const item = q(id);
    assert.strictEqual(F.labFor(item.topicId, item.prompt, { itemId: id }), null, id + ' 不应挂单曲线画板');
    assert.strictEqual(F.labForScene(item.topicId, item.prompt, { itemId: id }), null, id + ' 不应挂画板');
  });
});

test('本批不做的族（三角 / 对数 / 含参 / 只给值 / 只给导数 / 复合式）一条都不挂', function () {
  const bad = [];
  NOT_THIS_BATCH.forEach(function (id) {
    const item = q(id);
    if (F.labForScene(item.topicId, item.prompt, { itemId: id })) bad.push(id);
  });
  assert.deepStrictEqual(bad, [], '这些不属批1，挂了就是越界：' + bad.join(','));
});

/* ================================================================
 * 5. 高中挂载总量：恰好 17 = 本批 14 + 既有 cnm_h172 三题
 *    （多一条就是「顺手放宽」，少一条就是本批漏挂 —— 两头都算红）
 * ================================================================ */

test('高中（cnm_h*）全量挂载恰好 17 题，逐题可点名', function () {
  const hs = QUESTIONS.filter(function (x) { return /^cnm_h/.test(x.id); });
  const mounted = hs.filter(function (x) {
    return !!F.labForScene(x.topicId, x.prompt, { itemId: x.id });
  }).map(function (x) { return x.id; }).sort();
  const want = Object.keys(WANT).concat(PRE_EXISTING_CURVES).sort();
  assert.deepStrictEqual(mounted, want, '高中挂载清单与预期不符（多：' +
    mounted.filter(function (id) { return want.indexOf(id) < 0; }).join(',') + '；少：' +
    want.filter(function (id) { return mounted.indexOf(id) < 0; }).join(',') + '）');
});

test('既有 cnm_h172 三题仍走多曲线画板（本批不许动它）', function () {
  PRE_EXISTING_CURVES.forEach(function (id) {
    const item = q(id);
    const scene = F.labForScene(item.topicId, item.prompt, { itemId: id });
    assert.ok(scene, id + ' 应仍挂曲线画板');
    assert.strictEqual(scene.type, 'curves', id + ' 应仍是 curves 类型');
  });
});

/* ================================================================
 * 6. 初中零回归：白名单只加不删
 * ================================================================ */

test('初中挂载总量仍是 60 题（本批只加高中 id，不改初中）', function () {
  const junior = QUESTIONS.filter(function (x) { return !/^cnm_h/.test(x.id); });
  const mounted = junior.filter(function (x) {
    return !!F.labForScene(x.topicId, x.prompt, { itemId: x.id });
  });
  assert.strictEqual(mounted.length, 60, '初中挂载数变了（实测 ' + mounted.length + '），白名单出现回归');
});

test('初中题带不带 itemId 结果一致（高中逐题表不许渗到初中）', function () {
  /* 例外：一元二次方程章的 cnm_221_q3 本来就靠 itemId 放行（equationAllowed 的既有逐题门禁，
   * 批1 之前就有，测试文件别处也锁着它）。除它以外，itemId 不许改变任何初中题的结果。 */
  const PRE_EXISTING_ITEMID = ['cnm_221_q3'];
  const diff = [];
  QUESTIONS.filter(function (x) { return !/^cnm_h/.test(x.id) && PRE_EXISTING_ITEMID.indexOf(x.id) < 0; }).forEach(function (x) {
    const a = F.labForScene(x.topicId, x.prompt);
    const b = F.labForScene(x.topicId, x.prompt, { itemId: x.id });
    if (JSON.stringify(a) !== JSON.stringify(b)) diff.push(x.id);
  });
  assert.deepStrictEqual(diff, [], 'itemId 改变了初中题的挂载结果：' + diff.slice(0, 5).join(','));
  /* 既有的 cnm_221_q3 逐题门禁必须仍然生效（白名单只加不删） */
  const e = q('cnm_221_q3');
  assert.ok(F.labForScene(e.topicId, e.prompt, { itemId: e.id }), 'cnm_221_q3 的既有放行口被削掉了');
  assert.strictEqual(F.labForScene(e.topicId, e.prompt), null, 'cnm_221_q3 无 itemId 时仍应不挂');
});

test('初中典型放行口原样：一次/二次/反比例/方程门禁/双曲线交点', function () {
  /* 知识点白名单（topicKind）原样 */
  assert.strictEqual(F.topicKind('cnm_208'), 'linear');
  assert.strictEqual(F.topicKind('cnm_229'), 'quadratic');
  assert.strictEqual(F.topicKind('cnm_241'), 'inverse');
  assert.strictEqual(F.topicKind('cnm_h032'), null, '高中 topicId 不该进 topicKind（逐题表才管高中）');
  /* 两道真实初中题照旧挂得上（cnm_208_q1 是已知存量误挂，语义门禁里另档） */
  ['cnm_208_q1', 'cnm_241_q1'].forEach(function (id) {
    const item = q(id);
    assert.ok(F.labForScene(item.topicId, item.prompt, { itemId: id }), id + ' 应仍挂上');
  });
  const quad = QUESTIONS.filter(function (x) { return F.topicKind(x.topicId) === 'quadratic' && F.labFor(x.topicId, x.prompt, { itemId: x.id }); })[0];
  assert.ok(quad, '题库里应有能挂的初中二次函数题');
});

/* ================================================================
 * 7. 来源可复现：表 = 测算判 `gated ok` 的三族题 − 敏感项
 *    —— 防止以后有人把 extend / misleading 的题塞进表里，或按喜好加题
 * ================================================================ */

test('表内集合 = 三族 gated ok（二次 12 / 一次 3 / 反比例 1）减敏感项', function () {
  const okFam = { 'existing.quadratic': [], 'existing.linear': [], 'existing.inverse': [] };
  QUESTIONS.filter(function (x) { return /^cnm_h/.test(x.id) && inMain(x); }).forEach(function (item) {
    const m = measureOf(item);
    if (m.j && m.j.verdict === 'ok' && okFam[m.fam]) okFam[m.fam].push(item.id);
  });
  assert.strictEqual(okFam['existing.quadratic'].length, 12, '二次 gated ok 应为 12（口径变了？）');
  assert.strictEqual(okFam['existing.linear'].length, 3, '一次 gated ok 应为 3（口径变了？）');
  assert.strictEqual(okFam['existing.inverse'].length, 1, '反比例 gated ok 应为 1（口径变了？）');

  const expect = okFam['existing.quadratic']
    .filter(function (id) { return SENSITIVE.indexOf(id) < 0; })
    .concat(okFam['existing.linear'], okFam['existing.inverse']).sort();
  assert.deepStrictEqual(Object.keys(WANT).sort(), expect,
    '表内集合与「三族 ok − 敏感项」不一致（多/少都算漂移）');
});

test('表内每题在测算脚本里都是 gated ok，且不是 extend/misleading', function () {
  const bad = [];
  Object.keys(WANT).forEach(function (id) {
    const item = q(id);
    const m = measureOf(item);
    if (!m.j || m.j.verdict !== 'ok') bad.push(id + '=' + (m.j ? m.j.verdict + '/' + m.j.code : 'no-judge'));
  });
  assert.deepStrictEqual(bad, [], '白名单只收 gated ok，以下不是：' + bad.join(','));
});

test('31 条误挂清单 = 测算脚本实跑判 misleading 的全集（手写清单不许漂移）', function () {
  const actual = [];
  QUESTIONS.filter(function (x) { return /^cnm_h/.test(x.id) && inMain(x); }).forEach(function (item) {
    const m = measureOf(item);
    if (m.j && m.j.verdict === 'misleading') actual.push(item.id);
  });
  assert.deepStrictEqual(actual.sort(), MISLEADING.slice().sort(),
    '误挂清单与测算脚本不一致（脚本口径变了？还是清单手改漏了？）');
});

/* ================================================================
 * 汇总
 * ================================================================ */

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
