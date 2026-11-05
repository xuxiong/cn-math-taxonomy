#!/usr/bin/env node
/* 高中函数画板 批1（t_d3c2ba81）：二次 10 / 一次 3 / 反比例 1 + 批2 三角 9 —— **逐题白名单**测试
 *   node tests/test_funclab_hs_batch1.js
 *
 * 批1 只做「门禁」：把答案就落在画板标注语义里的高中题逐题放行（diagnose/funclab.js 的
 * HS_ITEMS 表）。批2（三角函数）+9 题、批3（指数/对数）+7 题，本文件同步把契约口径扩到 30 题。
 * 这里锁五件事：
 *
 *   1. 表内 30 题**必须挂得上**，且类型与表里写的一致（放行表与实现不许漂移）；
 *   2. 表外高中题**一个都不许挂**——高中全量挂载只允许「本批 30 + 既有 cnm_h172 三题」；
 *      尤其测算判 `misleading` 的那 31 条（切线读数 / 和差组合量 / 概念判断 / 边界读数），
 *      任一条能挂上就是误挂回归，本文件直接红；
 *   3. 敏感项（`f'(x)=0` 三题 + 灰区 tan 90°）按板主「严读」口径**不进表**，指对/幂根式
 *      也一条不进（批3 才做）；
 *   4. 初中那 163 条的行为零变化：初中挂载总数、几个典型知识点（直线 / 方程 / 反比例 / 双曲线）
 *      的放行结果原样锁住 —— 白名单只加不删；
 *   5. 表内集合的**来源可复现**：它就是测算脚本判 `gated ok` 的四族题减去敏感项，
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
  'cnm_h028_q3': 'inverse',
  /* 批2 三角 9：最值 / 周期 / 定义域 / 单调 / 奇偶（台账见 test_funclab_hs_batch2.js） */
  'cnm_h066_q1': 'trig',
  'cnm_h066_q2': 'trig',
  'cnm_h066_q3': 'trig',
  'cnm_h066_q4': 'trig',
  'cnm_h067_q1': 'trig',
  'cnm_h067_q4': 'trig',
  'cnm_h068_q4': 'trig',
  'cnm_h075_q1': 'trig',
  'cnm_h075_q2': 'trig',
  /* 批3 指数 / 对数 7：值域 / 单调 / 定义域 / 定点（台账见 test_funclab_hs_batch3.js） */
  'cnm_h029_q4': 'exp',
  'cnm_h042_q1': 'exp',
  'cnm_h042_q2': 'exp',
  'cnm_h046_q2': 'log',
  'cnm_h046_q4': 'log',
  'cnm_h047_q1': 'log',
  'cnm_h047_q2': 'log',
  /* 批4 新增 4 题：二次 2（顶点横坐标）+ 三次 2（奇偶性 / 极值点横坐标） */
  'cnm_h225_q1': 'quadratic',
  'cnm_h228_q2': 'quadratic',
  'cnm_h035_q2': 'cubic',
  'cnm_h229_q2': 'cubic'
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

/* 敏感项（板主 2026-11-05 裁定）：
 *   · 批4 改宽口径：`f'(x)=0` 的三题（h225_q1 / h228_q2 / h229_q2）按 docs §8
 *     已列明的二选一放行 —— 画板标出的极值点横坐标就是答案，不再是敏感项；
 *   · 灰区（简报 §2）：cnm_h069_q4 的 tan 90° 画板虽有渐近线，但答案是「无定义」这种
 *     否定式结论，画板不能替学生下结论 —— 仍按敏感项处理，不放进白名单。
 *     （批1 登记过的 cnm_h066_q4「sin 定义域」已随批2 放行，移出本清单。） */
const SENSITIVE = [
  /* 板主批4 裁定改宽口径：`f'(x)=0` 的三题（h225_q1 / h228_q2 / h229_q2）按 docs §8
   * 已列明的二选一放行（画板标出的极值点横坐标就是答案），灰区 tan 90° 仍按敏感项挡。 */
  'cnm_h069_q4'  // y=tan x 在 x=90°（三角族；测算判 misleading，板主灰区裁定仍不放行）
];

/* 本批明确不做的族（永久排除），这些题一条都不许挂。
 * 只取样例：全量由「高中挂载恰好 33 题」那条兜住。
 * （批1 登记过的三角样例 cnm_h066_q3 / cnm_h075_q2 已随批2 放行；
 *   批3 登记的 cnm_h046_q2 已随指对族放行，均移出本清单。） */
const NOT_THIS_BATCH = [
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

test('HS_ITEMS 是逐题表，键集合与契约表一致（34 题）', function () {
  assert.ok(F.HS_ITEMS, 'funclab 必须导出 HS_ITEMS（放行表），否则测试无法核对');
  const got = Object.keys(F.HS_ITEMS).sort();
  const want = Object.keys(WANT).sort();
  assert.deepStrictEqual(got, want, 'HS_ITEMS 与测试契约表不一致：多 ' + got.filter(function (k) { return want.indexOf(k) < 0; }).join(',') +
    '；少 ' + want.filter(function (k) { return got.indexOf(k) < 0; }).join(','));
  want.forEach(function (id) {
    assert.strictEqual(F.HS_ITEMS[id], WANT[id], id + ' 的画板类型应为 ' + WANT[id]);
  });
});

test('HS_ITEMS 的题族配比 = 二次 12 / 一次 3 / 反比例 1 / 三角 9 / 指数 3 / 对数 4 / 三次 2', function () {
  const cnt = { quadratic: 0, linear: 0, inverse: 0, trig: 0, exp: 0, log: 0, cubic: 0 };
  Object.keys(F.HS_ITEMS).forEach(function (id) { cnt[F.HS_ITEMS[id]]++; });
  assert.deepStrictEqual(cnt, { quadratic: 12, linear: 3, inverse: 1, trig: 9, exp: 3, log: 4, cubic: 2 });
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

test('表内 34 题 labFor 全部挂得上，类型与表一致', function () {
  Object.keys(WANT).forEach(function (id) {
    const item = q(id);
    const got = F.labFor(item.topicId, item.prompt, { itemId: id });
    assert.ok(got, id + ' 应挂上画板，实际 null（题面：' + item.prompt + '）');
    assert.strictEqual(got.type, WANT[id], id + ' 解析出的类型应为 ' + WANT[id]);
  });
});

test('表内 34 题 labForScene 全部挂得上（学生实际走的入口）', function () {
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

test('敏感项 1 题（灰区 tan 90°）不在表内、也挂不上', function () {
  SENSITIVE.forEach(function (id) {
    assert.strictEqual(F.HS_ITEMS[id], undefined, id + ' 不应进 HS_ITEMS（板主严读口径）');
    const item = q(id);
    assert.strictEqual(F.labFor(item.topicId, item.prompt, { itemId: id }), null, id + ' 不应挂单曲线画板');
    assert.strictEqual(F.labForScene(item.topicId, item.prompt, { itemId: id }), null, id + ' 不应挂画板');
  });
});

test('本批不做的族（含参 / 只给值 / 只给导数 / 复合式）一条都不挂', function () {
  const bad = [];
  NOT_THIS_BATCH.forEach(function (id) {
    const item = q(id);
    if (F.labForScene(item.topicId, item.prompt, { itemId: id })) bad.push(id);
  });
  assert.deepStrictEqual(bad, [], '这些不属批1，挂了就是越界：' + bad.join(','));
});

/* ================================================================
 * 5. 高中挂载总量：恰好 37 = 本批 34 + 既有 cnm_h172 三题
 *    （多一条就是「顺手放宽」，少一条就是本批漏挂 —— 两头都算红）
 * ================================================================ */

test('高中（cnm_h*）全量挂载恰好 37 题，逐题可点名', function () {
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
 * 7. 来源可复现：表 = 测算判 `gated ok` 的六族题 − 敏感项
 *    —— 防止以后有人把 extend / misleading 的题塞进表里，或按喜好加题
 * ================================================================ */

test('表内集合 = 七族 gated ok（二次 12 / 一次 3 / 反比例 1 / 三角 9 / 指数 3 / 对数 4 / 三次 2）减敏感项', function () {
  const okFam = { 'existing.quadratic': [], 'existing.linear': [], 'existing.inverse': [], 'trig': [], 'exp': [], 'log': [], 'power': [], 'cubic': [] };
  QUESTIONS.filter(function (x) { return /^cnm_h/.test(x.id) && inMain(x); }).forEach(function (item) {
    const m = measureOf(item);
    if (m.j && m.j.verdict === 'ok' && okFam[m.fam]) okFam[m.fam].push(item.id);
  });
  assert.strictEqual(okFam['existing.quadratic'].length, 12, '二次 gated ok 应为 12（口径变了？）');
  assert.strictEqual(okFam['existing.linear'].length, 3, '一次 gated ok 应为 3（口径变了？）');
  assert.strictEqual(okFam['existing.inverse'].length, 1, '反比例 gated ok 应为 1（口径变了？）');
  assert.strictEqual(okFam['trig'].length, 9, '三角 gated ok 应为 9（口径变了？）');
  assert.strictEqual(okFam['exp'].length, 3, '指数 gated ok 应为 3（口径变了？）');
  assert.strictEqual(okFam['log'].length, 4, '对数 gated ok 应为 4（口径变了？）');
  assert.strictEqual(okFam['power'].length, 0, '幂根式本批应为 0 条 gated ok（口径变了？）');
  assert.strictEqual(okFam['cubic'].length, 2, '三次 gated ok 应为 2（口径变了？）');

  const expect = okFam['existing.quadratic']
    .filter(function (id) { return SENSITIVE.indexOf(id) < 0; })
    .concat(okFam['existing.linear'], okFam['existing.inverse'],
      okFam['trig'].filter(function (id) { return SENSITIVE.indexOf(id) < 0; }),
      okFam['exp'], okFam['log'],
      okFam['cubic'].filter(function (id) { return SENSITIVE.indexOf(id) < 0; })).sort();
  assert.deepStrictEqual(Object.keys(WANT).sort(), expect,
    '表内集合与「七族 ok − 敏感项」不一致（多/少都算漂移）');
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
 * 8. 批1.5（t_f752c3df）：补漏三件
 *    1. inverse 补「定义域 / 渐近线」能力项 —— 批1 的 cnm_h028_q3 卡在这条缺口上；
 *       另外 verifyParams 不认 f(x)= 记法，是同一道题的第二道闸（见 LABMATCH 段）。
 *    2. NOTE_BY_INTENT 拍平导致同名 intent 串台（直线印抛物线文案）。
 *    3. 测算判 misleading 的 31 题里，cnm_h220_q2 能靠「答案 0 = h 读数 0」蒙过语义门禁。
 * ================================================================ */

console.log('\n--- 8. 批1.5：反比例能力缺口 / 文案串台 / 门禁漏过 ---');

const L = require('../diagnose/labmatch.js');
const GATE = require('./lib/answer-gate.js');

test('第1件：inverse 画板补上「定义域 / 渐近线」能力项', function () {
  const cap = F.CAPABILITIES['inverse-domain'];
  assert.ok(cap, 'CAPABILITIES 必须有 inverse-domain（反比例的定义域/渐近线）');
  assert.strictEqual(F.CAP_TYPE['inverse-domain'], 'inverse', 'CAP_TYPE 必须把它归到 inverse');
  assert.deepStrictEqual(cap.canAnswer, ['定义域', '渐近线'], 'canAnswer 只声明这两项');
  assert.deepStrictEqual(cap.params, ['k'], '参数仍只有 k（反比例只有一个系数）');
  /* 匹配层只喂同类画板：inverse 现在应有 3 个候选，少一个就等于这题又被拒 */
  assert.deepStrictEqual(Object.keys(F.capabilitiesFor('inverse')).sort(),
    ['inverse-area', 'inverse-domain', 'inverse-quadrants']);
  assert.ok(F.intentSupported('inverse-domain', '定义域'), '定义域 必须是可渲染组合');
  assert.ok(F.intentSupported('inverse-domain', '渐近线'), '渐近线 必须是可渲染组合');
});

test('第1件：定义域读数文案 —— 渐近线 x=0 + 除 x=0 外全体实数，且不串别的图', function () {
  const d = F.noteText('inverse-domain', '定义域', { k: 1 });
  assert.ok(d, '定义域文案必须生成得出来');
  assert.ok(d.indexOf('x = 0') >= 0, '必须点明断点 x = 0（原文字样：' + d + '）');
  assert.ok(/除 x = 0 外的全体实数/.test(d), '必须给出定义域读数：除 x = 0 外的全体实数');
  assert.ok(d.indexOf('抛物线') < 0 && d.indexOf('直线') < 0, '反比例文案不许出现抛物线/直线');
  const a = F.noteText('inverse-domain', '渐近线', { k: -2 });
  assert.ok(a && a.indexOf('渐近线 x = 0') >= 0, '渐近线文案必须写明渐近线 x = 0（原文字样：' + a + '）');
  assert.ok(/无限逼近|永不相交/.test(a), '必须讲清「无限逼近、不相交」');
});

test('第1件：verifyParams 认白名单题的 f(x)= 记法（第二道闸），且别名不扩散', function () {
  const item = q('cnm_h028_q3');
  const scene = F.labForScene(item.topicId, item.prompt, { itemId: item.id });
  assert.ok(scene, 'cnm_h028_q3 应能解析出反比例参数');
  const choice = { match: 'inverse-domain', intent: '定义域', params: { k: scene.k } };
  const ok = L.verifyParams(item.prompt, choice, { itemId: item.id });
  assert.ok(ok.ok, '白名单题必须过代回校验，实际：' + JSON.stringify(ok.why));
  /* 同题面但表外 itemId：别名不许兜底（与 labFor 同一口径） */
  const noAlias = L.verifyParams(item.prompt, choice, { itemId: 'cnm_h028_q4' });
  assert.strictEqual(noAlias.ok, false, '表外 itemId 不许靠别名过校验');
  const noId = L.verifyParams(item.prompt, choice);
  assert.strictEqual(noId.ok, false, '不带 itemId 时不许靠别名过校验');
});

/* 白名单 30 题逐题的「答案语义 → (画板, intent)」契约 —— **能过两道闸的 24 题**。
 * 这是把板主口径的「N 题可见」落成可复现的机器判据：题在表里（labFor 挂得上）
 * + intent 有 canAnswer 覆盖 + 参数能过 verifyParams 代回校验，三条全过才算「线上可见」。
 * 批1.5 时点 8 题 + 批2 三角 9 题 + 批3 指对 7 题（区间题另见 CLOSED_INTERVAL_GAPS / 批16 台账）。 */
const EXPECT_MOUNT = {
  'cnm_h029_q2': ['quadratic-vertex', '最大值'],
  'cnm_h034_q3': ['quadratic-vertex', '最大值'],
  'cnm_h049_q1': ['quadratic-roots', '零点'],
  'cnm_h226_q1': ['quadratic-vertex', '顶点坐标'],
  'cnm_h032_q1': ['linear-trend', 'y 随 x 的增大而增大还是减小'],
  'cnm_h032_q2': ['linear-trend', 'y 随 x 的增大而增大还是减小'],
  'cnm_h049_q2': ['linear-intercepts', '与 x 轴交点的横坐标'],   // 批1.5：verifyParams 认 f(x)= 才通
  'cnm_h028_q3': ['inverse-domain', '定义域'],                    // 批1.5 新补：修复前这条不存在
  /* 批2：三角 9 题（与 test_funclab_hs_batch2.js / batch16 的 LEDGER 逐条一致） */
  'cnm_h066_q1': ['trig-extremum', '最大值'],
  'cnm_h066_q2': ['trig-extremum', '最小值'],
  'cnm_h066_q3': ['trig-period', '最小正周期除以 π 后的值'],
  'cnm_h066_q4': ['trig-domain', '定义域'],
  'cnm_h067_q1': ['trig-monotonic', '单调性'],
  'cnm_h067_q4': ['trig-monotonic', '单调性'],
  'cnm_h068_q4': ['trig-parity', '奇偶性'],
  'cnm_h075_q1': ['trig-extremum', '最大值'],
  'cnm_h075_q2': ['trig-period', '最小正周期除以 π 后的值'],
  /* 批3：指数 / 对数 7 题 */
  'cnm_h029_q4': ['exp-curve', '值域'],
  'cnm_h042_q1': ['exp-curve', '单调性'],
  'cnm_h042_q2': ['exp-curve', '单调性'],
  'cnm_h046_q2': ['log-curve', '定义域'],
  'cnm_h046_q4': ['log-curve', '图象经过的定点'],
  'cnm_h047_q1': ['log-curve', '单调性'],
  'cnm_h047_q2': ['log-curve', '单调性'],
  /* 批4：二次 2（顶点横坐标）+ 三次 2（奇偶性 / 极值点横坐标） */
  'cnm_h225_q1': ['quadratic-vertex', '顶点坐标'],
  'cnm_h228_q2': ['quadratic-vertex', '顶点坐标'],
  'cnm_h035_q2': ['cubic-parity', '奇偶性'],
  'cnm_h229_q2': ['cubic-extremum', '极值点的横坐标']
};

/* 能力缺口（批1.5 时点登记）→ **批1.6（t_e63a9673）已补齐**：quadratic 画板新增
 * 「与 x 轴交点的个数」（挂 quadratic-roots）与「单调性」「奇偶性」两个 intent（各挂新画板
 * quadratic-monotonic / quadratic-parity），见 diagnose/funclab.js 的 CAPABILITIES。
 *   cnm_h023_q4 问「与 x 轴有几个交点」（画板画了绿点，数点就是答案）
 *   cnm_h032_q4 问单调性（看曲线在对称轴两侧的走向）
 *   cnm_h035_q1 / cnm_h036_q4 问奇偶性（看对称轴与 y 轴重不重合）
 * 本文件只保留清单用于锁「补齐后不许再退回缺口状态」，14 题逐题台账在 test_funclab_hs_batch16.js。 */
const CLOSED_CAP_GAPS = ['cnm_h023_q4', 'cnm_h032_q4', 'cnm_h035_q1', 'cnm_h036_q4'];

/* 区间缺口（批1.5 时点登记）→ **批1.6 已补齐**：labmatch.promptInterval 在解析入口做了
 * 全角标点归一化（，→, / −→- / ［］→[]），`x∈[−1，2]`、`在 [0，3] 上` 这类写法现在能抠出端点。
 * 归一化只作用于区间解析这一个函数，Funclab.fromPrompt 的曲线解析语义零改动。 */
const CLOSED_INTERVAL_GAPS = ['cnm_h034_q2', 'cnm_h227_q2'];

test('白名单里 28 题能过「表 + intent + 代回」三道闸（批1.5 的 8 + 批2 三角 9 + 批3 指对 7 + 批4 的 4）', function () {
  const bad = [];
  Object.keys(EXPECT_MOUNT).forEach(function (id) {
    const pair = EXPECT_MOUNT[id];
    const item = q(id);
    const scene = F.labForScene(item.topicId, item.prompt, { itemId: id });
    if (!scene) { bad.push(id + ' 挂不上'); return; }
    if (!F.intentSupported(pair[0], pair[1])) { bad.push(id + ' ' + pair.join('/') + ' intent 不支持'); return; }
    const params = Object.assign({}, scene);
    delete params.type;
    if (params.base && typeof params.base === 'object') delete params.base;
    /* 区间题（批2 的 trig-monotonic / 批1.6 的 range-on-interval）端点从题面实抠，
     * 与线上 verifyParams 前置流程、batch16 的 gateAll 同一来源 */
    const iv = L.promptInterval(item.prompt);
    if (iv) { params.xMin = iv.xMin; params.xMax = iv.xMax; }
    const v = L.verifyParams(item.prompt, { match: pair[0], intent: pair[1], params: params }, { itemId: id });
    if (!v.ok) bad.push(id + ' 代回不过：' + v.why.join(';'));
    if (!F.noteText(pair[0], pair[1], params)) bad.push(id + ' 没有文案');
  });
  assert.deepStrictEqual(bad, [], bad.join(' / '));
  assert.strictEqual(Object.keys(EXPECT_MOUNT).length, 28, '可挂契约应为 28 题（8 + 批2 三角 9 + 批3 指对 7 + 批4 的 4）');
  assert.strictEqual(Object.keys(EXPECT_MOUNT).length + CLOSED_CAP_GAPS.length + CLOSED_INTERVAL_GAPS.length,
    34, '28 可挂 + 4 能力缺口 + 2 区间缺口 = 白名单 34 题，一题都不许漏账');
});

test('批1.6：4 条原能力缺口现在都有对应 intent（缺口已补齐，退回缺口状态就红）', function () {
  const still = [];
  CLOSED_CAP_GAPS.forEach(function (id) {
    const kind = F.hsItemKind(id);
    const labs = Object.keys(F.capabilitiesFor(kind));
    const covered = labs.some(function (lab) {
      return F.capabilityIntents(lab).some(function (it) {
        return (id === 'cnm_h023_q4' && /交点的个数|交点个数/.test(it))
          || (id === 'cnm_h032_q4' && /单调|增大而|减小而/.test(it))
          || (/奇偶/.test(it) && /cnm_h03[56]/.test(id));
      });
    });
    if (!covered) still.push(id);
  });
  assert.deepStrictEqual(still, [], '这些题的能力缺口又回来了：' + still.join(',')
    + '（批1.6 台账见 tests/test_funclab_hs_batch16.js）');
});

test('批1.6：2 条区间题现在能过代回校验（全角逗号已在区间解析入口归一化）', function () {
  CLOSED_INTERVAL_GAPS.forEach(function (id) {
    const item = q(id);
    const scene = F.labForScene(item.topicId, item.prompt, { itemId: id });
    assert.ok(scene, id + ' 应能解析出抛物线参数');
    const iv = L.promptInterval(item.prompt);
    assert.ok(iv, id + ' 的区间端点应能从题面抠出来（全角逗号写法），实际 null：' + item.prompt);
    const params = { a: scene.a, h: scene.h, k: scene.k, xMin: iv.xMin, xMax: iv.xMax };
    const v = L.verifyParams(item.prompt, { match: 'quadratic-range-on-interval', intent: '在给定区间上的最小值', params: params }, { itemId: id });
    assert.ok(v.ok, id + ' 应已过代回校验，实际：' + v.why.join(';'));
  });
});

test('第2件：同名 intent 各印各的文案（直线不再印抛物线文案）', function () {
  const line = F.noteText('linear-intercepts', '与 x 轴交点的横坐标', { k: 1, b: -5 });
  assert.ok(line.indexOf('直线') >= 0, '直线画板必须说「直线」，实际：' + line);
  assert.ok(line.indexOf('抛物线') < 0, '直线画板不许出现「抛物线」，实际：' + line);
  assert.ok(line.indexOf('拖动 h、k') < 0, '直线画板不许出现「拖动 h、k」，实际：' + line);
  assert.ok(line.indexOf('拖动 k、b') >= 0, '直线画板应提示拖动自己的参数 k、b');

  const quad = F.noteText('quadratic-roots', '与 x 轴交点的横坐标', { a: 1, h: 0, k: -4 });
  assert.ok(quad.indexOf('抛物线') >= 0, '抛物线画板必须说「抛物线」');
  assert.ok(quad.indexOf('直线') < 0, '抛物线画板不许出现「直线」');

  const inv = F.noteText('inverse-quadrants', 'y 随 x 的增大而增大还是减小', { k: 1 });
  assert.ok(inv.indexOf('直线') < 0, '反比例画板不许印直线文案，实际：' + inv);
  assert.ok(/每一支|两支/.test(inv), '反比例画板应讲「每一支 / 两支」');
});

test('批1+批2 全部 22 题各 × 全部 intent，文案不串别的图', function () {
  /* 只锁「串台」方向（出现别的图的专属名词）。不做正向名词要求：抛物线文案里
   * 「这条直线是 x = ?」（对称轴）是正当说法，硬要求「抛物线」会把正确文案判红。
   * trig 不禁「直线」：tan 的渐近线文案要说「竖直的渐近线」，
   * 且 trig 画板说明里「对称轴」读法也用「直线」一词，属正当用法。 */
  const FORBID = { quadratic: /双曲线/, linear: /抛物线|双曲线/, inverse: /抛物线|直线/, trig: /抛物线|双曲线/ };
  /* 两处历史串台（同名 intent）必须正向归属正确 —— 这是本卡第 2 件的根因 */
  const CROSSOVER = {
    '与x轴交点的横坐标': { quadratic: /抛物线/, linear: /直线/ },
    'y随x的增大而增大还是减小': { linear: /直线/, inverse: /每一支|两支/ }
  };
  const bad = [];
  Object.keys(F.HS_ITEMS).forEach(function (id) {
    const kind = F.HS_ITEMS[id];
    if (!FORBID[kind]) return;                     // curves 不在本批口径内
    Object.keys(F.capabilitiesFor(kind)).forEach(function (lab) {
      F.capabilityIntents(lab).forEach(function (it) {
        /* trig 的 monotonic 文案要把区间端点写成 π 记法（A/w/phi/k 无 w 时用文字占位） */
        const note = F.noteText(lab, it, kind === 'trig'
          ? { fn: 'sin', A: 1, w: 1, phi: 0, k: 0, xMin: -1, xMax: 2 }
          : { a: 1, k: 2, b: -4, xMin: -1, xMax: 2 });
        if (!note) { bad.push(id + ' ' + lab + '/' + it + ' 无文案'); return; }
        const hit = note.match(FORBID[kind]);
        if (hit) bad.push(id + ' ' + lab + '/' + it + ' 串台「' + hit[0] + '」');
        const want = CROSSOVER[it] && CROSSOVER[it][kind];
        if (want && !want.test(note)) bad.push(id + ' ' + lab + '/' + it + ' 归属不对');
      });
    });
  });
  assert.deepStrictEqual(bad, [], bad.slice(0, 6).join(' / '));
});

test('第3件：31 条 misleading 一条都不许挂（17 条语义门禁挡下 + 14 条解析闸上游挡）', function () {
  const passed = [];
  const unparsed = [];
  MISLEADING.forEach(function (id) {
    const item = q(id);
    /* 用「假如它被解析出来」的参数去撞门禁：能挂上的题才有误挂风险 */
    let p = F.fromPrompt(item.prompt);
    if (!p && F.hsItemKind(id)) p = F.fromPrompt(F.hsPromptAlias(item.prompt));
    if (!p) { unparsed.push(id); return; }         // 解析不出 = 本来就挂不上，不算漏
    if (!GATE.misfitOf(item, p)) passed.push(id);  // 门禁放行 = 漏过
  });
  assert.deepStrictEqual(passed, [], '这些题能蒙过语义门禁：' + passed.join(','));
  /* 钉住那一条具体规则：cnm_h220_q2 是「答案 0 撞上切线语义」，不是数值巧合 */
  const it220 = q('cnm_h220_q2');
  const why = GATE.misfitOf(it220, F.fromPrompt(it220.prompt));
  assert.ok(why && why.indexOf('导数语义') >= 0, 'cnm_h220_q2 必须被导数语义那条挡下，实际：' + why);
  assert.ok(unparsed.length > 0, '31 条里应有解析不出的题（它们由 labFor 那条闸挡）');
});

/* ================================================================
 * 汇总
 * ================================================================ */

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
