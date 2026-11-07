#!/usr/bin/env node
/* 卡 E（t_0772253d）：「再来一道」切到卡 C 参数化管线的接线测试。
 * node tests/test_llm_frontend_wire.js
 *
 * 钉住四件事（都在卡面上，回退即红）：
 *   1. data/gen-plan.json 可重建、幂等、与 tmp/gap-plan.json 三方一致、gzip ≤ 60KB；
 *   2. 三级路由：construct → construct.js、verify → DiagLLMGen、human-only/查不到 → 不发请求；
 *   3. 卡 D 的红线在新路径上仍然成立：未过门的题不进队列；human-only 绝不发 LLM 请求；
 *   4. 接线本身：app-flow 的 askAnother 走路由层、不再直连 O3 genLLMVariant；
 *      app.js 的 LAZY_VARIANTS 里 llm-recipes → llm-gates → llm-gen 顺序正确。
 *
 * 无网络：所有 fetch / transport 都是假的；数据只读 data/ 与 tmp/。
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PLAN = path.join(ROOT, 'data/gen-plan.json');

const R = require('../diagnose/gen-route.js');
const GATES = require('../diagnose/llm-gates.js');
const RECIPES = require('../diagnose/llm-recipes.js');
const GEN = require('../diagnose/llm-gen.js');
const CTOR = require('../diagnose/construct.js');
const TX = require('../diagnose/textfmt.js');
const LLMV = require('../diagnose/llm-variants.js');

let passed = 0;
let failed = 0;
const QUEUE = [];
/* 用例表：统一在文件末尾串行跑（有的用例是异步的，同步 try/catch 抓不到它们的失败）。 */
function test(name, fn) { QUEUE.push({ name: name, fn: fn }); }
/* 组标题也进队列：保证 console 顺序 = 执行顺序，而不是模块加载时就全打出来。 */
function group(title) { QUEUE.push({ group: title }); }
function gz(text) { return zlib.gzipSync(Buffer.from(text, 'utf8'), { level: 9 }).length; }

/* ------------------------------------------------------------------ *
 * 0. 准备：gen-plan-lite 构建脚本（ESM）+ gap-plan（可能被 git 忽略）
 * ------------------------------------------------------------------ */

const buildMod = execFileSync(process.execPath, ['--input-type=module', '-e', `
  import { buildGenPlanLite, genPlanText } from './scripts/build-gen-plan-lite.mjs';
  import fs from 'node:fs';
  const plan = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
  const topics = JSON.parse(fs.readFileSync('data/topics-lite.json', 'utf8'));
  process.stdout.write(genPlanText(buildGenPlanLite(plan, topics)));
`, gapPlanPath()], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }).toString();

function gapPlanPath() {
  const p = path.join(ROOT, 'tmp/gap-plan.json');
  if (fs.existsSync(p)) return p;
  /* tmp/ 被 git 忽略：干净检出时现跑一次（只读 data/，零网络），产物放临时目录不碰仓库。 */
  const out = path.join(os.tmpdir(), 'cnm-gap-plan-' + process.pid + '.json');
  execFileSync(process.execPath, ['scripts/gen-gap-plan.mjs', '--out', out, '--quiet'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  return out;
}

const PLAN_TEXT = fs.readFileSync(PLAN, 'utf8');
const PLAN_DOC = JSON.parse(PLAN_TEXT);
const INDEX = R.parsePlan(PLAN_DOC);

/* ------------------------------------------------------------------ *
 * 1. 产物：可重建 / 幂等 / 体积 / 与 plan 三方一致
 * ------------------------------------------------------------------ */

group('[1] data/gen-plan.json');
test('schema 是 gen-plan-lite/1，只含 verify|construct（human-only 用缺席表达）', function () {
  assert.strictEqual(PLAN_DOC.schema, 'gen-plan-lite/1');
  const bad = PLAN_DOC.nodes.filter((n) => n.strategy !== 'verify' && n.strategy !== 'construct');
  assert.deepStrictEqual(bad.map((n) => n.topicId), []);
  assert.strictEqual(PLAN_DOC.counts.kept, PLAN_DOC.nodes.length);
  assert.strictEqual(PLAN_DOC.counts.verify + PLAN_DOC.counts.construct, PLAN_DOC.nodes.length);
  /* 2213 个 human-only 点不在包里：它们在 decide() 里落到 plan-missing 分支（不出题）。 */
  assert.ok(PLAN_DOC.counts.humanOnly > 0, 'plan 里应当有 human-only 点');
  assert.strictEqual(PLAN_DOC.counts.verify + PLAN_DOC.counts.construct + PLAN_DOC.counts.humanOnly, PLAN_DOC.counts.topics);
});

test('磁盘文件 == 现场重建（构建脚本与产物同步；CI 不会拿到过期包）', function () {
  assert.strictEqual(buildMod, PLAN_TEXT);
});

test('幂等：同一份 plan 两次构建字节相同', function () {
  const again = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { buildGenPlanLite, genPlanText } from './scripts/build-gen-plan-lite.mjs';
    import fs from 'node:fs';
    const plan = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
    const topics = JSON.parse(fs.readFileSync('data/topics-lite.json', 'utf8'));
    process.stdout.write(genPlanText(buildGenPlanLite(plan, topics)));
  `, gapPlanPath()], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }).toString();
  assert.strictEqual(again, buildMod);
});

test('gzip ≤ 60KB（卡面硬顶）', function () {
  const g = gz(PLAN_TEXT);
  assert.ok(g <= 60 * 1024, 'gen-plan.json gzip ' + g + 'B 超过 60KB 硬顶');
});

test('与 tmp/gap-plan.json 三方一致：topicId / strategy / verifier 逐点相同', function () {
  const plan = JSON.parse(fs.readFileSync(gapPlanPath(), 'utf8'));
  const want = new Map();
  for (const e of plan.topics) {
    if (e.strategy === 'verify' || e.strategy === 'construct') want.set(e.topicId, e);
  }
  assert.strictEqual(want.size, PLAN_DOC.nodes.length, 'keep 的点数应与 plan 里的 verify+construct 相同');
  for (const n of PLAN_DOC.nodes) {
    const e = want.get(n.topicId);
    assert.ok(e, n.topicId + ' 在 plan 里不存在');
    assert.strictEqual(n.strategy, e.strategy, n.topicId + ' strategy 不一致');
    assert.strictEqual(n.verifier || null, e.verifier || null, n.topicId + ' verifier 不一致');
    /* descendantsLite 只允许「原数组长度 > 50 时截到 50」，其余必须一字不差 */
    const full = Array.isArray(e.descendants) ? e.descendants : [];
    assert.strictEqual(n.descendantsLite.length, Math.min(full.length, R.DESC_LITE_MAX), n.topicId + ' descendantsLite 长度不对');
    if (full.length <= R.DESC_LITE_MAX) assert.deepStrictEqual(n.descendantsLite, full, n.topicId + ' descendants 被改');
  }
});

/* ------------------------------------------------------------------ *
 * 2. 三级路由（纯判定 + fake 传输计数）
 * ------------------------------------------------------------------ */

const CONSTRUCT_TOPIC = 'cnm_039';   // 方程与方程的解（construct）
const VERIFY_TOPIC = 'cnm_p047';     // 除法的基本应用（verify / numeric-compare，descendants=0；卡1 把原 cnm_p013 迁到了 construct）
const HUMAN_TOPIC = 'cnm_p014';      // 认识立体图形（human-only，plan 里缺席）

/* 每个用例一个独立管线（pipelineKey），避免缓存池跨用例串味。 */
function deps(transport, key) {
  return {
    construct: CTOR, recipes: RECIPES, gates: GATES, gen: GEN,
    transport: transport, pipelineKey: key || 'test', maxRetries: 3
  };
}
function ctxFor(topicId, extra) {
  const t = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/topics-lite.json'), 'utf8'))
    .filter((x) => x.id === topicId)[0];
  return R.buildContext(Object.assign({
    topic: t, detail: null, bank: [], stdById: {}, gates: GATES, subject: 'math',
    vocabulary: [{ topicId: t.id, name: t.name, subject: 'math', grade: t.grade, chapter: t.chapter }]
  }, extra || {}));
}

group('[2] 三级路由');
test('construct 点 → construct 路线（零网络）', function () {
  const d = R.decide(INDEX, CONSTRUCT_TOPIC);
  assert.strictEqual(d.action, 'construct');
  assert.strictEqual(d.strategy, 'construct');
  assert.ok(CTOR.supports(CONSTRUCT_TOPIC), '前提：这个点卡 B 的构造器要支持');
});

test('verify 点 → llm 路线；verifier 为空的 verify 点 → 不出题', function () {
  const d = R.decide(INDEX, VERIFY_TOPIC);
  assert.strictEqual(d.action, 'llm');
  assert.strictEqual(d.strategy, 'verify');
  assert.strictEqual(d.entry.verifier, 'numeric-compare');
  const fake = { byId: { x: { topicId: 'x', strategy: 'verify', verifier: null } } };
  assert.strictEqual(R.decide(fake, 'x').action, 'none');
  assert.strictEqual(R.decide(fake, 'x').reason, 'verify-without-verifier');
});

test('human-only 点 / plan 查不到 → none + 确定提示，且**一个请求都不发**', function () {
  let calls = 0;
  const counter = function () { calls++; return Promise.resolve('{}'); };
  const d = R.decide(INDEX, HUMAN_TOPIC);
  assert.strictEqual(d.action, 'none');
  assert.strictEqual(d.reason, 'plan-missing');   // human-only 在包里是缺席

  const p = R.ask({ topicId: HUMAN_TOPIC, difficulty: 'standard', plan: INDEX, deps: deps(counter, 'hu') });
  const q = R.ask({ topicId: 'cnm_does_not_exist', difficulty: 'standard', plan: INDEX, deps: deps(counter, 'hu2') });
  return Promise.all([p, q]).then(function (rs) {
    rs.forEach(function (r) {
      assert.strictEqual(r.action, 'none');
      assert.strictEqual(r.question, null);
    });
    assert.strictEqual(calls, 0, 'human-only / 查不到的点不许发请求');
    const notice = R.noticeFor(rs[0], {});
    assert.ok(/只能做原题/.test(notice), '应给出「只能做原题」的确定提示，实际：' + notice);
  });
});

test('O3 老路径保留但不再是默认入口：3 个老配方之外的点 genLLMVariant 拿不到题', function () {
  const src = fs.readFileSync(path.join(ROOT, 'diagnose/app-flow.js'), 'utf8');
  const fn = src.slice(src.indexOf('function askAnother('), src.indexOf('function anotherRow('));
  assert.ok(fn.indexOf('genRouteMod()') >= 0, 'askAnother 应先取路由层');
  assert.ok(fn.indexOf('R.decide(') >= 0, 'askAnother 应经 decide() 分流');
  assert.strictEqual(fn.indexOf('genLLMVariant'), -1, 'askAnother 不许再直连 O3 老路径');
  assert.ok(fn.indexOf("reason: d.reason") >= 0, 'none 分支要把确定提示交给 noticeFor');
});

/* ------------------------------------------------------------------ *
 * 3. 三条路线各自的产物（含卡 D 红线）
 * ------------------------------------------------------------------ */

group('[3] 出题产物与红线');
test('construct 路线：拿得到题、标 variantSource=construct、零网络、被准入放行', function () {
  let calls = 0;
  return R.ask({
    topicId: CONSTRUCT_TOPIC, difficulty: 'standard', plan: INDEX, index: 0, seed: 'wire-1',
    deps: deps(function () { calls++; return Promise.resolve('{}'); }, 'c1')
  }).then(function (r) {
    assert.strictEqual(calls, 0);
    assert.strictEqual(r.action, 'construct');
    assert.ok(r.question, '构造点应能出题：' + r.reason);
    assert.strictEqual(r.question.variantSource, 'construct');
    assert.notStrictEqual(r.question.llmVerified, true, '本机构造的题不该打 AI 验证标');
    assert.strictEqual(LLMV._admitToPracticeQueue(r.question), true);
    assert.strictEqual(LLMV.badgeFor(r.question), null, '本机题不该带 AI 标');
    assert.ok(r.question.prompt && r.question.answer, '题面与答案都要有');
  });
});

const GOOD = {
  /* 题面里刻意留 `$…$` 数学定界符：textfmt.normalize 会剥掉它（卡 t_42e5978b 规则 4），
   * 这样「上屏必经 normalize」这条断言才有意义 —— 清洗是真的发生了，不是恒等。 */
  prompt: '小明有 $12+7$ 个苹果的故事不重要，只算这个式子：12+7 等于多少？',
  answer: '19', verify: '12+7', verifyType: 'numeric', difficulty: 'standard',
  explanation: '把两个数合起来，用加法算一次就得到结果。'
};
const BAD = Object.assign({}, GOOD, { answer: '20' });

test('verify 路线（好候选）：过七道门 → llmVerified、AI 标、题面已规范化', function () {
  assert.notStrictEqual(TX.normalize(GOOD.prompt), GOOD.prompt, '前提：这条题面确实需要规范化（$ 定界符要被剥掉）');
  const bodies = [];
  return R.ask({
    topicId: VERIFY_TOPIC, difficulty: 'standard', plan: INDEX, ctx: ctxFor(VERIFY_TOPIC), seed: 'wire-2',
    deps: deps(function (body) { bodies.push(JSON.stringify(body)); return Promise.resolve(JSON.stringify(GOOD)); }, 'l1')
  }).then(function (r) {
    assert.strictEqual(bodies.length, 1, '一次通过时只该发一次请求');
    assert.ok(r.question, '应出题成功：' + r.reason + ' / ' + JSON.stringify(r.checks));
    assert.strictEqual(r.question.llmVerified, true, '过门的题必须打 llmVerified（卡 D 准入要它）');
    assert.strictEqual(r.question.variantSource, 'llm');
    assert.strictEqual(r.question.gates.length, 7, '七道门都要留痕');
    assert.ok(r.question.gates.every(function (c) { return c.ok; }));
    assert.strictEqual(r.question.prompt, TX.normalize(GOOD.prompt), '题面必须过 textfmt.normalize 再上屏');
    assert.strictEqual(LLMV._admitToPracticeQueue(r.question), true);
    assert.ok(LLMV.badgeFor(r.question), 'AI 题必须带 AI 现出题标');
    assert.ok(/未审核/.test(R.noticeFor(r, { badgeText: LLMV.AI_DRAFT_BADGE.text })));
  });
});

test('verify 路线（坏候选）：三次重试都过不了门 → 不出题、不进队列', function () {
  let calls = 0;
  return R.ask({
    topicId: VERIFY_TOPIC, difficulty: 'standard', plan: INDEX, ctx: ctxFor(VERIFY_TOPIC), seed: 'wire-3',
    deps: deps(function () { calls++; return Promise.resolve(JSON.stringify(BAD)); }, 'l2')
  }).then(function (r) {
    assert.strictEqual(calls, 3, '默认重试 3 次');
    assert.strictEqual(r.question, null);
    assert.strictEqual(r.reason, 'max-retries');
    /* 卡 D 口径：没过门的 llm 题一律不许进练习队列 */
    assert.strictEqual(LLMV._admitToPracticeQueue({ variantSource: 'llm' }), false);
    assert.strictEqual(LLMV._admitToPracticeQueue({ variantSource: 'llm', llmVerified: true }), true);
    assert.ok(/验证没通过/.test(R.noticeFor(r, {})));
  });
});

test('确定性：同 seed + 同 plan 条目 → 请求体字节相同', function () {
  function run(key) {
    const bodies = [];
    return R.ask({
      topicId: VERIFY_TOPIC, difficulty: 'standard', plan: INDEX, ctx: ctxFor(VERIFY_TOPIC), seed: 'wire-det',
      deps: deps(function (body) { bodies.push(JSON.stringify(body)); return Promise.resolve(JSON.stringify(GOOD)); }, key)
    }).then(function () { return bodies[0]; });
  }
  return Promise.all([run('d1'), run('d2')]).then(function (bs) {
    assert.ok(bs[0] && bs[1]);
    assert.strictEqual(bs[0], bs[1]);
  });
});

test('难度三档落到 recipe（「难一点」= advanced 排到轮转首位）', function () {
  const recipe = RECIPES.recipeFromPlanEntry(R.planEntryOf(INDEX.byId[VERIFY_TOPIC]));
  assert.deepStrictEqual(recipe.constraints.difficulties, ['standard', 'basic', 'advanced']);
  R.rotateDifficulty(recipe, 'advanced');
  assert.deepStrictEqual(recipe.constraints.difficulties, ['advanced', 'standard', 'basic']);
});

/* ------------------------------------------------------------------ *
 * 4. ctx 构建：真实数据（topics-detail 分片）与体积口径
 * ------------------------------------------------------------------ */

group('[4] ctx 与数据源');
test('buildContext：existing 只给 id+题面（≤8）、语料用本章节真题、缺 gates 返回 null', function () {
  const t = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/topics-lite.json'), 'utf8')).filter((x) => x.id === VERIFY_TOPIC)[0];
  const bank = [];
  for (let i = 0; i < 20; i++) bank.push({ id: 'b' + i, prompt: '第' + (i + 1) + '题：算一算 1+1', answer: '2' });
  const ctx = R.buildContext({ topic: t, detail: { description: '描述', mastery_criteria: '会算', standards: [{ id: 's1', confidence: 'exact' }] },
    bank: bank, stdById: { s1: { text: '课标正文' } }, gates: GATES, subject: 'math', vocabulary: [] });
  assert.strictEqual(ctx.existing.length, R.EXISTING_MAX);
  assert.strictEqual(ctx.corpus.size, bank.length);
  assert.strictEqual(ctx.standards[0].text, '课标正文');
  assert.strictEqual(ctx.topic.subject, 'math');
  assert.strictEqual(R.buildContext({ topic: t, gates: null }), null);
});

test('fetchDetail：按 questions-index 的 key 取分片，取不到返回 null（不影响出题）', function () {
  const t = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/topics-lite.json'), 'utf8')).filter((x) => x.id === VERIFY_TOPIC)[0];
  const key = 'math|' + t.grade + '|' + t.chapter;
  const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/questions-index/math.json'), 'utf8'));
  const file = idx[key];
  assert.ok(file, '前提：' + key + ' 应在 questions-index 里');
  const doc = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/topics-detail', file), 'utf8'));
  const fakeFetch = function (url) {
    assert.ok(url.indexOf(file) >= 0, 'URL 应指向分片：' + url);
    return Promise.resolve({ ok: true, json: function () { return Promise.resolve(doc); } });
  };
  const miss = function () { return Promise.resolve({ ok: false, status: 404 }); };
  return Promise.all([
    R.fetchDetail({ fetch: fakeFetch, index: idx, key: key, topicId: VERIFY_TOPIC }),
    R.fetchDetail({ fetch: miss, index: idx, key: key, topicId: VERIFY_TOPIC })
  ]).then(function (rs) {
    assert.ok(rs[0] && rs[0].id === VERIFY_TOPIC, '应取回本知识点的详情');
    assert.strictEqual(rs[1], null);
  });
});

/* ------------------------------------------------------------------ *
 * 5. 懒加载与缓存（sw.js 不需要改动的证据）
 * ------------------------------------------------------------------ */

group('[5] 懒加载与缓存');
test('app.js：LAZY_VARIANTS 里 llm-config → textfmt → … → recipes → gates → gen，gen-route/construct 各自成组', function () {
  const src = fs.readFileSync(path.join(ROOT, 'diagnose/app.js'), 'utf8');
  const block = src.slice(src.indexOf('const LAZY_VARIANTS'), src.indexOf('const LAZY_GENROUTE'));
  const order = ['llm-config.js', 'textfmt.js', 'llm-eval.js', 'llm-gateway.js', 'llm-recipes.js', 'llm-gates.js', 'llm-gen.js', 'llm-variants.js'];
  let at = -1;
  order.forEach(function (f) {
    const i = block.indexOf("'" + f + "'");
    assert.ok(i > at, f + ' 缺失或顺序不对（依赖必须先加载）');
    at = i;
  });
  assert.ok(/const LAZY_GENROUTE = \['gen-route\.js'\]/.test(src));
  /* construct.js 的浏览器分支要 window.DiagLLMEval 与 window.DiagConstructNum：两个依赖都必须在
   * 同一个数组里、且都排在它前面，否则构造路线一加载就炸（算术族连题都拼不出来）。 */
  const lc = /const LAZY_CONSTRUCT = \[([^\]]*)\]/.exec(src);
  assert.ok(lc, 'app.js 里找不到 LAZY_CONSTRUCT 数组声明');
  const lcFiles = lc[1].split(',').map(function (s) { return s.trim().replace(/^['"]|['"]$/g, ''); }).filter(Boolean);
  const lcAt = function (f) { return lcFiles.indexOf(f); };
  assert.ok(lcAt('llm-eval.js') >= 0 && lcAt('llm-eval.js') < lcAt('construct.js'),
    'LAZY_CONSTRUCT 必须把 llm-eval.js 排在 construct.js 前（construct.js 的浏览器分支取 root.DiagLLMEval），实际 ' + lc[1]);
  assert.ok(lcAt('construct-num.js') >= 0 && lcAt('construct-num.js') < lcAt('construct.js'),
    'LAZY_CONSTRUCT 必须把 construct-num.js 排在 construct.js 前（算术族取 root.DiagConstructNum），实际 ' + lc[1]);
  assert.ok(lcAt('construct.js') >= 0 && lcAt('llm-eval.js') >= 0 && lcAt('construct-num.js') >= 0,
    'llm-eval.js / construct-num.js / construct.js 必须都在这同一个数组里，实际 ' + lc[1]);
});

test('sw.js 一个字节不用改：.json 已走 staleWhileRevalidate，gen-plan 不必进 SHELL/DATA', function () {
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  /* fetch 策略 ②：扩展名命中 .json 的请求一律 staleWhileRevalidate。
   * gen-plan.json 天然落在这一条里，所以 SHELL / DATA / VERSION 都不用动（改了就要同步 4 处版本锚点）。 */
  const rule = /if \(\/\\\.\(\?:([a-z|]+)\)\$\/\.test\(url\.pathname\)\) \{\s*event\.respondWith\(staleWhileRevalidate\(req\)\);/.exec(sw);
  assert.ok(rule, 'sw.js 丢了「按扩展名走 staleWhileRevalidate」这条 fetch 策略');
  assert.ok(rule[1].split('|').indexOf('json') >= 0, '.json 必须在 SWR 的扩展名集合里，实际：' + rule[1]);
  assert.strictEqual(sw.indexOf('gen-plan.json'), -1, 'gen-plan.json 不进预缓存清单（SWR 就够了）');
  /* 懒加载模块不在 SHELL 里（SHELL 只预缓存首屏）：锚在真正的 `var SHELL = [` 上，别撞注释里的 SHELL 二字。 */
  const shellBlock = sw.slice(sw.indexOf('var SHELL = ['), sw.indexOf('var DATA = ['));
  assert.ok(shellBlock.length > 0, '前提：SHELL 与 DATA 两个清单都存在');
  ['llm-recipes', 'llm-gates', 'llm-gen', 'gen-route', 'construct'].forEach(function (f) {
    assert.strictEqual(shellBlock.indexOf(f), -1, f + ' 是懒加载模块，不许进 SHELL 预缓存');
  });
});

/* ------------------------------------------------------------------ *
 * 收尾
 * ------------------------------------------------------------------ */

/* 串行跑：用例之间有共享的模块级缓存（route 的 plan 缓存、管线实例池），
 * 并发跑会互相污染；顺序执行也让第一条失败的原因读起来最干净。 */
(async function main() {
  for (const t of QUEUE) {
    if (t.group) { console.log('\n' + t.group); continue; }
    try {
      await t.fn();
      passed++;
      console.log('  ok   ' + t.name);
    } catch (e) {
      failed++;
      console.log('  FAIL ' + t.name + '\n       ' + (e && e.stack || e).split('\n').slice(0, 6).join('\n       '));
    }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
