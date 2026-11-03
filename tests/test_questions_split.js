#!/usr/bin/env node
/* 题库按章节拆分 / 按需取（卡 t_e855de2f）守卫：node tests/test_questions_split.js
 *
 * 背景（已实测）：
 *   data/questions.json 单文件 7657KB 原文 / 1164KB gzip、12135 题。孩子只做 1 个知识点的题，
 *   却要下整份；sw.js 还把它整个预热 —— 慢网下和首屏、和正在做的题抢带宽。
 *   现在拆成 data/questions/<slug>.json（每章节一份，gzip 中位 ≈1.5KB、最大 ≈6KB）
 *   + data/questions-index.json（"<subject>|<grade>|<chapter>" → 文件名）。
 *
 * 本文件守：
 *   数据层  index 覆盖全部组合、每个 bundle 都存在、题数守恒、id 不丢不重、抽样对得上章节、
 *           每个 bundle gzip < 10KB、构建脚本幂等且会清理陈旧文件、slug 纯 ASCII；
 *   代码层  app.js 有按需取的 ensureQuestions（不再首屏拉全量）、index 缺 key 有 warn 兜底、
 *           sw.js 预热清单里没有题库；
 *   自检    删掉/重复一道题时，上面的断言必须真的报红（证明断言有效）。
 *
 * 测试目录没有 DOM 基座：app.js / sw.js 那几条做源码级守卫（与 test_pwa_load.js 同风格：
 * 花括号配对取函数体文本再断言，不做运行期 DOM 断言）。
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const QUESTIONS_PATH = path.join(ROOT, 'data', 'questions.json');
const TOPICS_PATH = path.join(ROOT, 'data', 'topics.json');
const DIR = path.join(ROOT, 'data', 'questions');
const INDEX_PATH = path.join(ROOT, 'data', 'questions-index.json');
const BUILD = path.join(ROOT, 'scripts', 'build-questions-split.mjs');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'diagnose', 'app.js'), 'utf8');
const FLOW_SRC = fs.readFileSync(path.join(ROOT, 'diagnose', 'app-flow.js'), 'utf8');
const APP = APP_SRC + '\n' + FLOW_SRC;
const SW = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');

/* bundle 的 gzip 预算：卡上要求 < 10KB（实际最大 ≈6KB）。 */
const BUNDLE_GZIP_LIMIT = 10 * 1024;
/* 抽样条数（题目 → topics 记录 → 章节 key 的逐条比对）。 */
const SAMPLE = 300;

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e).split('\n').slice(0, 8).join('\n       ')); }
}

/* 花括号配对取函数体（先抹掉字符串字面量里的括号），与 test_pwa_load.js 同法。 */
function bodyAfter(src, startToken) {
  const at = src.indexOf(startToken);
  assert.ok(at >= 0, '源码里找不到：' + startToken);
  const open = src.indexOf('{', at + startToken.length - 1);
  assert.ok(open >= 0, '找不到起始花括号：' + startToken);
  const masked = src.slice(0, open) + src.slice(open).replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, function (s) { return s.replace(/[{}]/g, '_'); });
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    const c = masked[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(open + 1, i); }
  }
  throw new Error('花括号不配对：' + startToken);
}

/* ------------------------------------------------------------ 独立实现（不复用被测代码） */
/* 与 engine.subjectOf() 同一套规则：数学 topics 没有 subject 字段，按 id 前缀/默认值推。 */
function subjectOf(t) {
  const s = t && t.subject;
  if (['english', 'math', 'physics', 'chinese', 'science', 'morality', 'history', 'geography'].indexOf(s) >= 0) return s;
  const id = String((t && t.id) || '');
  if (id.indexOf('cne_') === 0) return 'english';
  if (id.indexOf('cnp_') === 0) return 'physics';
  if (id.indexOf('cnc_') === 0) return 'chinese';
  if (id.indexOf('cns_') === 0) return 'science';
  if (id.indexOf('cnd_') === 0) return 'morality';
  if (id.indexOf('cnh_') === 0) return 'history';
  if (id.indexOf('cng_') === 0) return 'geography';
  return 'math';
}
function keyOf(t) {
  const grade = t && t.grade != null && t.grade !== '' ? String(t.grade) : '';
  return subjectOf(t) + '|' + grade + '|' + String((t && t.chapter) || '');
}

const questions = JSON.parse(fs.readFileSync(QUESTIONS_PATH, 'utf8'));
const topics = JSON.parse(fs.readFileSync(TOPICS_PATH, 'utf8'));
const topicById = new Map();
topics.forEach(function (t) { if (t && t.id) topicById.set(t.id, t); });
const index = fs.existsSync(INDEX_PATH) ? JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8')) : null;

function readBundles() {
  const out = new Map();
  Object.keys(index || {}).forEach(function (key) {
    const file = path.join(DIR, index[key]);
    out.set(key, JSON.parse(fs.readFileSync(file, 'utf8')));
  });
  return out;
}

/* 全套不变量：「题目总数守恒 + 每题 id 恰好一次 + 每题的章节与所在 bundle 一致」。
 * 抽成函数是为了自检（删一道 / 重一道）能复用同一套断言。 */
function assertBankIntegrity(bundles) {
  let total = 0;
  const seen = new Map();   // id → 出现次数
  bundles.forEach(function (list, key) {
    assert.ok(Array.isArray(list), 'bundle 应是数组：' + key);
    total += list.length;
    list.forEach(function (q) {
      assert.ok(q && q.id, '题目缺 id（bundle ' + key + '）');
      seen.set(q.id, (seen.get(q.id) || 0) + 1);
      const t = topicById.get(q.topicId);
      assert.ok(t, '题目 ' + q.id + ' 的 topicId 在 topics.json 里查不到：' + q.topicId);
      assert.strictEqual(keyOf(t), key, '题目 ' + q.id + ' 的 (subject,grade,chapter) 与所在 bundle 的 key 不一致');
    });
  });
  assert.strictEqual(total, questions.length, '所有 bundle 的题目总数应等于 data/questions.json 的题数');
  const dup = [];
  seen.forEach(function (n, id) { if (n !== 1) dup.push(id + '×' + n); });
  assert.strictEqual(dup.length, 0, '这些题的 id 不是恰好出现一次：' + dup.slice(0, 5).join('、'));
  const missing = questions.filter(function (q) { return !seen.has(q.id); }).slice(0, 5);
  assert.strictEqual(missing.length, 0, '这些题在 bundle 里丢了：' + missing.map(function (q) { return q.id; }).join('、'));
  return total;
}

/* 目录快照：文件名 → sha1，用于幂等 / 清理断言。 */
function snapshot() {
  const out = {};
  if (!fs.existsSync(DIR)) return out;
  fs.readdirSync(DIR).sort().forEach(function (name) {
    out[name] = crypto.createHash('sha1').update(fs.readFileSync(path.join(DIR, name))).digest('hex');
  });
  return out;
}
function runBuild() {
  return execFileSync(process.execPath, [BUILD], { cwd: ROOT, encoding: 'utf8' });
}

/* ------------------------------------------------------------ 1. 数据层 */
test('data/questions-index.json 存在，key 数 = questions.json 里出现过的 (subject,grade,chapter) 组合数', function () {
  assert.ok(index && typeof index === 'object' && !Array.isArray(index), '缺 data/questions-index.json（先跑 node scripts/build-questions-split.mjs）');
  const combos = new Set();
  questions.forEach(function (q) {
    const t = topicById.get(q.topicId);
    assert.ok(t, 'questions.json 里有题指向不存在的 topicId：' + q.topicId);
    combos.add(keyOf(t));
  });
  assert.strictEqual(Object.keys(index).length, combos.size, 'index 的 key 数应正好等于章节组合数');
  combos.forEach(function (k) { assert.ok(index[k], 'index 缺这个章节的 key：' + k); });
});

test('所有 index 指向的文件都存在，且 data/questions/ 下没有 index 之外的残留文件', function () {
  const referenced = new Set();
  Object.keys(index).forEach(function (k) {
    const name = index[k];
    assert.strictEqual(typeof name, 'string', 'index 的值应是文件名（string）：' + k);
    const p = path.join(DIR, name);
    assert.ok(fs.existsSync(p), 'index 指向的文件不存在：' + name + '（key ' + k + '）');
    referenced.add(name);
  });
  const onDisk = fs.readdirSync(DIR);
  const orphan = onDisk.filter(function (n) { return !referenced.has(n); });
  assert.deepStrictEqual(orphan, [], 'data/questions/ 下有 index 没引用的残留文件：' + orphan.slice(0, 5).join('、'));
  assert.strictEqual(onDisk.length, Object.keys(index).length, '文件数应与 index 的 key 数一致');
});

test('所有 bundle 的题目总数 = data/questions.json 的题数（不写死数字）', function () {
  const bundles = readBundles();
  let total = 0;
  bundles.forEach(function (list) { total += list.length; });
  assert.strictEqual(total, questions.length, 'bundle 总题数应等于 questions.json（' + questions.length + '）');
});

test('每道题的 id 在所有 bundle 中恰好出现一次（不丢、不重）', function () {
  const bundles = readBundles();
  const seen = new Map();
  bundles.forEach(function (list) {
    list.forEach(function (q) { seen.set(q.id, (seen.get(q.id) || 0) + 1); });
  });
  const bad = [];
  seen.forEach(function (n, id) { if (n !== 1) bad.push(id + '×' + n); });
  assert.strictEqual(bad.length, 0, '重复的题：' + bad.slice(0, 5).join('、'));
  const lost = questions.filter(function (q) { return !seen.has(q.id); });
  assert.strictEqual(lost.length, 0, '丢掉的题：' + lost.slice(0, 5).map(function (q) { return q.id; }).join('、'));
  assert.strictEqual(seen.size, questions.length, 'id 集合大小应等于题数');
});

test('抽样 ' + SAMPLE + ' 题：按 topicId 查到的 topics 记录 (subject,grade,chapter) 与所在 bundle 的 key 一致', function () {
  const bundles = readBundles();
  const flat = [];
  bundles.forEach(function (list, key) { list.forEach(function (q) { flat.push({ key: key, q: q }); }); });
  assert.ok(flat.length >= SAMPLE, '题目太少，抽样不成立');
  /* 等距抽样：覆盖到每个章节边界，不用随机（重复跑结果一致） */
  const step = Math.max(1, Math.floor(flat.length / SAMPLE));
  let checked = 0;
  for (let i = 0; i < flat.length && checked < SAMPLE; i += step, checked++) {
    const item = flat[i];
    const t = topicById.get(item.q.topicId);
    assert.ok(t, '题目 ' + item.q.id + ' 的 topicId 查不到：' + item.q.topicId);
    assert.strictEqual(keyOf(t), item.key,
      '题目 ' + item.q.id + ' 在 bundle「' + item.key + '」，但它的章节是「' + keyOf(t) + '」');
  }
  assert.strictEqual(checked, SAMPLE, '抽样条数不够');
});

test('每道题的字段都没被拆丢（difficulty/type/prompt/answer/explanation/verify 原样）', function () {
  const bundles = readBundles();
  const byId = new Map();
  bundles.forEach(function (list) { list.forEach(function (q) { byId.set(q.id, q); }); });
  const step = Math.max(1, Math.floor(questions.length / SAMPLE));
  for (let i = 0; i < questions.length; i += step) {
    const src = questions[i];
    const got = byId.get(src.id);
    assert.ok(got, '题 ' + src.id + ' 没进 bundle');
    assert.deepStrictEqual(got, src, '题 ' + src.id + ' 的内容与 questions.json 不一致');
  }
});

test('每个 bundle 的 gzip 体积 < 10KB', function () {
  const files = fs.readdirSync(DIR);
  let max = 0;
  let maxFile = '';
  files.forEach(function (name) {
    const gz = zlib.gzipSync(fs.readFileSync(path.join(DIR, name))).length;
    if (gz > max) { max = gz; maxFile = name; }
    assert.ok(gz < BUNDLE_GZIP_LIMIT, name + ' 的 gzip 体积 ' + gz + ' 字节，超过 10KB 预算');
  });
  console.log('       最大 bundle gzip：' + max + ' 字节（' + maxFile + '）');
});

test('slug 纯 ASCII 且形如 <subject>__<grade>__<10 位十六进制>', function () {
  Object.keys(index).forEach(function (key) {
    const name = index[key];
    assert.ok(/^[\x21-\x7e]+\.json$/.test(name), 'slug 必须纯 ASCII：' + name);
    const m = /^([a-z0-9-]+)__([a-z0-9-]+)__([0-9a-f]{10})\.json$/.exec(name);
    assert.ok(m, 'slug 形状不对（应为 <subject>__<grade>__<sha1 前 10 位>.json）：' + name);
    const chapter = key.split('|').slice(2).join('|');
    const want = crypto.createHash('sha1').update(chapter, 'utf8').digest('hex').slice(0, 10);
    assert.strictEqual(m[3], want, 'slug 里的 hash 不是章节名的 sha1 前 10 位：' + name);
  });
});

test('完整不变量（截断/重复都会报红的那套）：总数守恒 + id 唯一 + 章节一致', function () {
  assertBankIntegrity(readBundles());
});

/* ------------------------------------------------------------ 2. 构建脚本 */
test('scripts/build-questions-split.mjs 幂等：连跑两次，data/questions/ 与 index 字节完全一致', function () {
  const before = snapshot();
  const indexBefore = crypto.createHash('sha1').update(fs.readFileSync(INDEX_PATH)).digest('hex');
  runBuild();
  const mid = snapshot();
  runBuild();
  const after = snapshot();
  assert.deepStrictEqual(mid, before, '第一次重跑就改了文件字节（构建不确定）');
  assert.deepStrictEqual(after, mid, '第二次重跑改了文件字节（不幂等）');
  assert.strictEqual(crypto.createHash('sha1').update(fs.readFileSync(INDEX_PATH)).digest('hex'), indexBefore, 'index 字节不稳定');
});

test('构建脚本会清理陈旧文件（造一个落单文件，跑一次后消失）', function () {
  const stray = path.join(DIR, '__stale_probe__.json');
  try {
    fs.writeFileSync(stray, '[]\n');
    assert.ok(fs.existsSync(stray), '自检没造出落单文件');
    runBuild();
    assert.strictEqual(fs.existsSync(stray), false, '构建没有清理 data/questions/ 下的陈旧文件');
  } finally {
    if (fs.existsSync(stray)) fs.rmSync(stray, { force: true });
  }
});

test('构建脚本的摘要包含文件数 / 总题数 / 最大文件字节数', function () {
  const out = runBuild();
  const m = /(\d+) 个 bundle、(\d+) 题、最大文件 (\d+) 字节/.exec(out);
  assert.ok(m, '构建摘要里缺「N 个 bundle、M 题、最大文件 K 字节」：' + out.trim());
  assert.strictEqual(parseInt(m[1], 10), Object.keys(index).length, '摘要的文件数与 index 不一致');
  assert.strictEqual(parseInt(m[2], 10), questions.length, '摘要的题数与 questions.json 不一致');
});

/* ------------------------------------------------------------ 3. app.js 源码级守卫 */
test('app.js：ensureQuestions 存在，且首屏（loadData）不 fetch 全量 questions.json', function () {
  assert.ok(/function ensureQuestions\(/.test(APP), 'app.js 里缺 ensureQuestions（按需取题库的入口）');
  const body = bodyAfter(APP, 'async function loadData()');
  assert.strictEqual(body.indexOf('questions.json'), -1, 'loadData（首屏链）里不许再出现 questions.json');
  assert.ok(!/await[^\n]*questions/.test(body), 'loadData 里不许 await 题库');
  assert.ok(/if \(questionsAutoLoad\) questionsPromise = loadQuestions\(\);/.test(body),
    '全量预取只应挂在默认关闭的 ?questions=full 排障开关上');
  const unguarded = body.split('\n').filter(function (line) {
    return /loadQuestions\(\)/.test(line) && !/questionsAutoLoad/.test(line) && !/^\s*(\*|\/\/|\/\*)/.test(line);
  });
  assert.deepStrictEqual(unguarded, [], '首屏里出现了无条件的全量题库请求：' + unguarded.join(' / '));
});

test('app.js：index 缺 key 的回退分支存在（含 warn 文案，不许删）', function () {
  const body = bodyAfter(APP, 'async function loadBundle(');
  assert.ok(body.indexOf("'[questions] index 缺 key，回退全量'") >= 0,
    '缺 index 缺 key 的 warn 文案：[questions] index 缺 key，回退全量');
  assert.ok(/loadFullQuestions\(\)/.test(body), 'index 缺 key 时必须回退到全量 data/questions.json');
  const full = bodyAfter(APP, 'async function loadQuestions()');
  assert.ok(/await fetch\('\.\.\/data\/questions\.json'\)/.test(full), '全量兜底仍要能取 data/questions.json');
  assert.ok(/questions = null;/.test(full), '全量兜底失败时要静默回落成 questions = null');
});

test('app.js：key 用 topics-lite 的 subject/grade/chapter 拼，章节请求按 key 去重（并发复用同一个 Promise）', function () {
  const kb = bodyAfter(APP, 'function questionsKeyOf(');
  ['subjectOf(t)', "'|'", 't.grade', 't.chapter'].forEach(function (needle) {
    assert.ok(kb.indexOf(needle) >= 0, 'questionsKeyOf 里缺 ' + needle + '（key 必须是 subject|grade|chapter）');
  });
  const eq = bodyAfter(APP, 'function ensureQuestionsForOne(');
  assert.ok(/bundleLoaded\[key\]/.test(eq), 'ensureQuestions 应命中已到货的章节（bundleLoaded）');
  assert.ok(/bundlePromises\[key\]/.test(eq), 'ensureQuestions 必须复用同一个章节的 Promise（并发不打两次）');
  assert.ok(APP.indexOf('questions-index.json') >= 0, 'app.js 应取 data/questions-index.json');
});

test('app.js：题源门只取目标所在章节（ensureQuestions + ensureQuestionsForTopics），并保留「题目还在载入」的处理', function () {
  const gate = bodyAfter(APP, 'async function ensureFlowReady(');
  assert.ok(/ensureQuestions\(\)/.test(gate), '题源门必须走按需取（ensureQuestions），不再是整份题库');
  assert.ok(/ensureFullTopics\(\)/.test(gate), '题源门仍要盯住全量 topics（diagnostic_question 回退）');
  assert.ok(/Promise\.race\(\[full, bank\]\)/.test(gate), '两份题源谁先到就先用谁');
  assert.ok(APP.indexOf('renderQuestionsPending') >= 0, '缺「题目还在载入」的等待页');
  assert.ok(APP.indexOf('题目还在载入，稍等…') >= 0, '缺等待页文案');
  const pre = bodyAfter(APP, 'function ensureQuestionsForTopics(');
  assert.ok(/ensureQuestionsForOne\(/.test(pre), 'ensureQuestionsForTopics 应逐个知识点走 ensureQuestionsForOne');
  assert.ok(/const QUESTION_LANES = 6;/.test(APP), '整年级几十个章节要排 6 条泳道，别一次打几十个请求');
});

test('app.js：答错回溯先修时先取那个章节的题库（跨章先修不会被静默丢掉）', function () {
  const body = bodyAfter(APP, 'function commit(result)');
  assert.ok(/D\.graph\.prereqs\[item\.topicId\]/.test(body), 'commit 应先取本题直接先修所在章节的题库');
  assert.ok(/ensureQuestionsForTopics\(pre\)/.test(body), 'commit 应用作答之前要等先修章节的题库到货');
});

/* ------------------------------------------------------------ 4. sw.js */
test('app.js：题库门没有自我递归（曾因同名函数 ensureQuestions() 被覆盖而栈溢出）', function () {
  const decls = APP.match(/function ensureQuestions[A-Za-z]*\(/g) || [];
  const zeroArg = (APP.match(/function ensureQuestions\(\s*\)/g) || []).length;
  assert.strictEqual(zeroArg, 1, 'ensureQuestions 无参版本应恰好一个，实际 ' + zeroArg);
  const one = bodyAfter(APP, 'function ensureQuestions()');
  assert.ok(/ensureQuestionsForTopics\(flowTargets\)/.test(one), '无参 ensureQuestions 应把 flowTargets 交给 ensureQuestionsForTopics');
  const topicsBody = bodyAfter(APP, 'function ensureQuestionsForTopics(');
  assert.strictEqual(/ensureQuestions\(\s*\)/.test(topicsBody), false,
    'ensureQuestionsForTopics 不许回调无参 ensureQuestions()（自我递归 → 栈溢出）');
  assert.ok(decls.length >= 2, '应有 ensureQuestionsForOne 与 ensureQuestions 两个不同名字的函数');
});

test('sw.js：预热清单不含 data/questions.json、不含 data/questions/*（题库走运行时缓存）', function () {
  const m = /var DATA = \[([\s\S]*?)\];/.exec(SW);
  assert.ok(m, 'sw.js 里应有 var DATA = [...]');
  const items = m[1].match(/'(?:[^'\\]|\\.)*'/g) || [];
  assert.strictEqual(items.indexOf("'data/questions.json'"), -1, 'DATA 里不许再预热 data/questions.json');
  const anyBundle = items.filter(function (s) { return s.indexOf('data/questions/') >= 0; });
  assert.deepStrictEqual(anyBundle, [], 'DATA 里不许预热 data/questions/ 下的 bundle（894 个，预热毫无意义）');
  ['data/topics-lite.json', 'data/id-aliases.json', 'data/questions-index.json']
    .forEach(function (p) { assert.ok(items.indexOf("'" + p + "'") >= 0, 'DATA 里仍应有 ' + p); });
  assert.ok(/var VERSION = 'v9';/.test(SW), 'VERSION 应已是 v9');
  const core = /var CORE = \[([\s\S]*?)\];/.exec(SW);
  assert.strictEqual((core[1].match(/'/g) || []).length, 10, 'CORE 应仍是 5 项');
});

test('sw.js：三条 fetch 策略原样保留（题库 bundle 靠 json 那条走运行时缓存）', function () {
  assert.ok(/req\.mode === 'navigate'/.test(SW), '缺 navigate 分支');
  assert.ok(/json\|png\|svg\|ico\|webmanifest/.test(SW), '缺 json/png/svg/ico/webmanifest 分支（题库 bundle 走这条）');
  assert.ok(/staleWhileRevalidate\(req\)/.test(SW), '数据文件应走 staleWhileRevalidate（取到就写进运行时缓存）');
  assert.ok(/event\.respondWith\(networkFirst\(req, false, null\)\)/.test(SW), '缺「其余资源 → networkFirst」分支');
});

/* ------------------------------------------------------------ 5. 自检：断言真的会红 */
test('自检：从某个 bundle 里删掉一道题，断言必须报红', function () {
  const bundles = readBundles();
  const firstKey = Object.keys(index)[0];
  const copy = new Map(bundles);
  copy.set(firstKey, bundles.get(firstKey).slice(1));   // 少一道
  assert.throws(function () { assertBankIntegrity(copy); }, /总数应等于|丢了/, '删题没有报红：断言无效');
});

test('自检：把一道题复制到另一个 bundle，唯一性断言必须报红', function () {
  const bundles = readBundles();
  const keys = Object.keys(index);
  const copy = new Map(bundles);
  const moved = bundles.get(keys[0])[0];
  if (!moved) return;   // 空 bundle 跳过（正常数据不会出现）
  copy.set(keys[1], bundles.get(keys[1]).concat([moved]));
  assert.throws(function () { assertBankIntegrity(copy); }, /恰好出现一次|不一致/, '重复题没有报红：断言无效');
});

test('自检：index 少了 key 时，覆盖断言必须报红', function () {
  const bad = Object.assign({}, index);
  const lost = Object.keys(bad)[0];
  delete bad[lost];
  const combos = new Set();
  questions.forEach(function (q) { const t = topicById.get(q.topicId); if (t) combos.add(keyOf(t)); });
  assert.throws(function () {
    assert.strictEqual(Object.keys(bad).length, combos.size, 'index 的 key 数应正好等于章节组合数');
    combos.forEach(function (k) { assert.ok(bad[k], 'index 缺这个章节的 key：' + k); });
  }, /key 数应正好等于|缺这个章节的 key/, 'index 少 key 没有报红：断言无效');
});

/* ------------------------------------------------------------ 6. 退化路径（卡 t_83ca3ac5）
 *
 * 复核卡 t_588d8341 用注入 404 的本地服务实测出的两个「测试覆盖不到的破法」：
 *   ① bundle 404 / 离线未缓存 → 无 warn、不回退全量，静默降到 topics.json 的 diagnostic_question，
 *      会话「本知识点第 1 / 1 题」，答完一题结果页说「都掌握啦，真棒！…目标知识点已掌握」；
 *   ② A→B 快速切换（0.45s 内）→ B 的题库一次都没请求，6.5s 后开的是 A 的会话，无任何提示。
 * 下面这组真跑 loadBundle（Node，无 DOM：靠 resetQuestionsCache + 注入 fetch 计数）并用真实数据
 * 跑引擎，断言「warn 文案 + questions.json 只取一次 + 结果页头条/判据不许说已掌握」。
 */
const ENGINE = require('../diagnose/engine.js');
const APP_MOD = require('../diagnose/app.js');
const TOPICS = JSON.parse(fs.readFileSync(TOPICS_PATH, 'utf8')).filter(function (t) { return String(t.id).indexOf('cnm') === 0; });
/* 目标要同时有 diagnostic_question（兜底题来源）和真题（真题库来源），两个方向都能测到 */
const PAIRED = TOPICS.filter(function (t) {
  return t && !t.external && t.diagnostic_question && t.diagnostic_question.question &&
    questions.some(function (q) { return q.topicId === t.id; });
});
const PAIRED_TARGET = PAIRED.length ? PAIRED[0].id : null;
const SESSION_OPTS = { mode: 'target', limit: 8, confirm: 2, seed: 'degrade' };

/* 注入 fetch：按 route 返回假响应，并记下每次请求的 URL（等于服务端日志）。 */
function stubFetch(routes) {
  const calls = [];
  global.fetch = function (url) {
    const u = String(url);
    calls.push(u);
    for (let i = 0; i < routes.length; i++) {
      if (routes[i].test.test(u)) return Promise.resolve(routes[i].res);
    }
    return Promise.resolve({ ok: false, status: 404 });
  };
  return calls;
}
function bundleRequests(calls) {
  return calls.filter(function (u) { return u.indexOf('data/questions/') >= 0; });
}
function fullRequests(calls) {
  return calls.filter(function (u) { return /data\/questions\.json$/.test(u); });
}
async function captureWarns(fn) {
  const warns = [];
  const orig = console.warn;
  console.warn = function () { warns.push(Array.prototype.slice.call(arguments).join(' ')); };
  try { await fn(); } finally { console.warn = orig; }
  return warns;
}
function restoreFetch() { try { delete global.fetch; } catch (e) { global.fetch = undefined; } }

async function testAsync(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e).split('\n').slice(0, 8).join('\n       ')); }
}

test('数据前置：有「既有 diagnostic_question 又有真题」的知识点（本组退化用例的靶子）', function () {
  assert.ok(PAIRED_TARGET, '数据里找不到既有 diagnostic_question 又有真题的数学知识点，本组用例失效');
});

test('app.js：bundle 404 分支在源码里与「index 缺 key」完全对齐（warn 文案 + loadFullQuestions）', function () {
  const body = bodyAfter(APP, 'async function loadBundle(');
  assert.ok(body.indexOf("'[questions] bundle 取不到，回退全量'") >= 0,
    'bundle 取不到时缺 warn 文案：[questions] bundle 取不到，回退全量');
  const pair = /bundle 取不到，回退全量[\s\S]{0,200}?return loadFullQuestions\(\)/.exec(body);
  assert.ok(pair, 'bundle 取不到时必须回退到全量 data/questions.json（不许 return false 了事）');
  const fb = bodyAfter(APP, 'async function fetchBundle(');
  assert.ok(/if \(!r\.ok\) return null;/.test(fb), '非 2xx 应返回 null（交给回退全量）');
  assert.ok(/Array\.isArray\(list\) \? list : null/.test(fb), '坏 JSON / 非数组也应返回 null');
  assert.ok(/catch \(e\)[\s\S]*return null;/.test(fb), '网络错（离线）也要返回 null，不能把异常抛给调用方');
});

test('app.js：结果页在「只有诊断题」时不许出现「已掌握」（头条 / 统计 / 已掌握卡 / 小结四处都改）', function () {
  const rr = bodyAfter(APP, 'function renderResult()');
  assert.ok(/const diagOnly = diagnosticOnlyRound\((?:S\.)?D\.graph, (?:S\.)?session\);/.test(rr), '结果页要先算「本轮只有兜底诊断题」');
  assert.ok(/else if \(diagOnly\) page\.append\(noBankCard\(sum\)\);/.test(rr),
    '只有兜底诊断题时不许画「接下来练什么」小结（那句「都掌握啦，真棒！」是假的）');
  /* 契约更新（卡 t_54813ae7）：这条断言原来把「stat('ok', sum.mastered.length, '已掌握')」这个
   * 不含「实测/推断」拆分的调用形式当成契约。方块口径诚实化后该调用多了第 4 个参数
   * （'实测 X / 推断 Y'），所以这里只锁「diagOnly 时不许出现已掌握统计」这一点，允许可选的第 4 个参数。 */
  assert.ok(/diagOnly \? null : stat\('ok', sum\.mastered\.length, '已掌握'(?:, [^)]*)?\)/.test(rr),
    '只有兜底诊断题时不许显示「已掌握」统计');
  assert.ok(rr.indexOf("'已掌握', '实测 '") >= 0 && rr.indexOf("' / 推断 '") >= 0,
    '「已掌握」方块必须把实测/推断拆开（第 4 个参数），不许只报一个总数');
  assert.ok(/if \(!diagOnly\) page\.append\(h\('details', \{ class: 'card', id: 'mastered' \}/.test(rr),
    '只有兜底诊断题时不许显示「已掌握的知识点」卡');
  assert.ok(/const headline = resultHeadline\(sum, (?:S\.)?session, screen, diagOnly, targetsMastered\);/.test(rr),
    '头条文案应走 resultHeadline（才能被 Node 直测）');
  const head = bodyAfter(APP, 'function resultHeadline(');
  assert.ok(head.indexOf("'题库没取到，本轮只做了 '") >= 0 && head.indexOf("' 道诊断题，结果不作数") >= 0,
    '头条缺「题库没取到…结果不作数」文案');
  const gate = /if \(diagOnly\) \{[\s\S]*?\n    \}/.exec(head);
  assert.ok(gate, 'resultHeadline 应先判 diagOnly');
  assert.strictEqual(gate[0].indexOf('已掌握'), -1, 'diagOnly 分支里不许出现「已掌握」');
});

test('app.js：A→B 快速切换不再被静默吞掉（latest-click-wins：门开时按最后一次点击重过）', function () {
  const body = bodyAfter(APP, 'function withStage2(');
  const guardAt = body.search(/if \((?:S\.)?flowPending\) return;/);
  assert.ok(guardAt > 0, 'withStage2 应保留「门已开着就不叠第二个门」的守卫');
  assert.ok(body.indexOf('flowJob = { targets: targets, mode: mode, fn: fn }') < guardAt,
    '守卫之前必须先把这次点击记成 flowJob —— 实测缺陷就是后一次点击在守卫处被静默丢弃（B 的题库 0 次请求，最后开 A 的会话）');
  assert.ok(body.indexOf('flowSeq++') < guardAt, '守卫之前必须递增点击序号');
  assert.ok(/if \((?:S\.)?flowPending\) return;[\s\S]*openStage2Gate\(\)/.test(body), '门没开着时才开始取题源');
  const gate = bodyAfter(APP, 'function openStage2Gate()');
  assert.ok(/const seq = flowSeq;/.test(gate) && /const job = flowJob;/.test(gate), '门要记住开时的序号与目标');
  assert.ok(/ensureFlowReady\(job\.targets, undefined, job\.mode\)/.test(gate), '门应等「最后一次点击」的目标所在章节');
  assert.ok(/if \(seq !== flowSeq\) return openStage2Gate\(\)/.test(gate),
    '门开时若序号已变（等待期间又点了别的），要按最新点击重过门，不许开旧目标的会话');
  assert.ok(/renderFlowBlocked\(job\.targets, job\.mode, job\.fn\)/.test(gate), '失败时仍要给可操作的重试卡（不许吞掉）');
  const resets = (gate.match(/(?:S\.)?flowPending = false;/g) || []).length;
  assert.strictEqual(resets, 2, '成功 / 兜底两条出口都要放开 flowPending（含取题源抛错时，当前 ' + resets + ' 条）');
});

test('app.js：题源门不许在「题库还在路上」时开门（否则 bundle 404 回退全量那几秒就是 1 题会话）', function () {
  const body = bodyAfter(APP, 'async function ensureFlowReady(');
  assert.ok(/if \(flowAskable\(targets, limit, mode\) && (?:S\.)?questionsInFlight === 0\) return true;/.test(body),
    '过门判据必须等题库定案（在飞请求数归零）—— 实测 bundle 404 时全量 7.8MB 还没到，门就开了，' +
    '会话拿到的是 topics.json 的兜底诊断题（「本知识点第 1 / 1 题」+ 标签「诊断题」）');
  const afterRace = /await Promise\.race\(\[full, bank\]\);([\s\S]*?)await Promise\.all/.exec(body);
  assert.ok(afterRace && afterRace[1].search(/(?:S\.)?questionsInFlight === 0/) >= 0,
    '这个判据要放在 race 之后的第一处开门点，不是最后兜底');
});

async function runDegradeTests() {
  /* ---- ① bundle 404：warn + 回退全量一次（现有 index 缺 key 分支的行为） ---- */
  await testAsync('真跑 loadBundle：bundle 404 时 warn「bundle 取不到，回退全量」且 questions.json 被请求一次', async function () {
    const key = Object.keys(index)[0];
    const file = index[key];
    APP_MOD.resetQuestionsCache();
    const calls = stubFetch([
      { test: /questions-index\.json$/, res: { ok: true, status: 200, json: async function () { return index; } } },
      { test: /data\/questions\/[^/]+\.json$/, res: { ok: false, status: 404 } },
      { test: /data\/questions\.json$/, res: { ok: false, status: 404 } }
    ]);
    try {
      const warns = await captureWarns(async function () { await APP_MOD.loadBundle(key); });
      assert.strictEqual(bundleRequests(calls).length, 1, '只该试一次 bundle');
      assert.strictEqual(bundleRequests(calls)[0], '../data/questions/' + file, 'bundle 请求的应是 index 指向的文件');
      assert.strictEqual(fullRequests(calls).length, 1,
        'bundle 取不到时必须回退全量一次（实测缺陷：服务端 0 次 questions.json，直接静默降级成 1 道诊断题）');
      const line = warns.filter(function (w) { return w.indexOf('回退全量') >= 0; }).join(' | ');
      assert.ok(line.indexOf('[questions] bundle 取不到，回退全量') >= 0, '缺 warn 文案，实际：' + (line || '(无 warn)'));
      assert.ok(line.indexOf(key) >= 0 && line.indexOf(file) >= 0, 'warn 里应带上 key 与文件名，便于排查：' + line);
    } finally { restoreFetch(); APP_MOD.resetQuestionsCache(); }
  });

  await testAsync('真跑 loadBundle：index 缺 key 的老路径行为不变（warn + 只回退一次）', async function () {
    APP_MOD.resetQuestionsCache();
    const calls = stubFetch([
      { test: /questions-index\.json$/, res: { ok: true, status: 200, json: async function () { return {}; } } },
      { test: /data\/questions\.json$/, res: { ok: false, status: 404 } }
    ]);
    try {
      const warns = await captureWarns(async function () { await APP_MOD.loadBundle('math|0|不存在的章节'); });
      assert.strictEqual(fullRequests(calls).length, 1, 'index 缺 key 时仍应回退全量一次');
      assert.ok(warns.join(' | ').indexOf('[questions] index 缺 key，回退全量') >= 0, 'index 缺 key 的 warn 文案丢了');
    } finally { restoreFetch(); APP_MOD.resetQuestionsCache(); }
  });

  /* ---- ② 只有诊断题的一轮：判据 + 头条文案（真引擎、真数据） ---- */
  test('诊断题兜底判据：无题库的图上目标全是 legacy 兜底题 → true；真题到货 → false', function () {
    const gNoBank = ENGINE.buildGraph(TOPICS, [], null);
    const sNoBank = ENGINE.createSession(gNoBank, [PAIRED_TARGET], SESSION_OPTS);
    assert.strictEqual(APP_MOD.diagnosticOnlyRound(gNoBank, sNoBank), true,
      '题库整个没取到（bundle 404 / 离线未缓存）时必须认出「这一轮只有 diagnostic_question」');
    const realQs = questions.filter(function (q) { return q.topicId === PAIRED_TARGET; });
    const gBank = ENGINE.buildGraph(TOPICS, [], realQs);
    const sBank = ENGINE.createSession(gBank, [PAIRED_TARGET], SESSION_OPTS);
    assert.strictEqual(APP_MOD.diagnosticOnlyRound(gBank, sBank), false, '真题库到货时不许误报「不作数」');
    assert.strictEqual(APP_MOD.diagnosticOnlyRound(gNoBank, ENGINE.createSession(gNoBank, [PAIRED_TARGET], SESSION_OPTS)),
      true, '两次会话互不影响');
    assert.strictEqual(APP_MOD.diagnosticOnlyRound(null, sNoBank), false, '空图不许崩');
  });

  test('结果页头条：只有诊断题的一轮说「不作数」，且不含「已掌握」；正常一轮保持原话', function () {
    const gNoBank = ENGINE.buildGraph(TOPICS, [], null);
    const sNoBank = ENGINE.createSession(gNoBank, [PAIRED_TARGET], SESSION_OPTS);
    const sum = ENGINE.summarize(gNoBank, sNoBank);
    const degraded = APP_MOD.resultHeadline(sum, sNoBank, false, true, true);
    assert.ok(degraded.indexOf('不作数') >= 0, '缺「结果不作数」：' + degraded);
    assert.ok(degraded.indexOf('题库没取到') >= 0, '缺「题库没取到」：' + degraded);
    assert.strictEqual(degraded.indexOf('已掌握'), -1, '只有诊断题的一轮头条不许说「已掌握」：' + degraded);
    assert.strictEqual(degraded.indexOf('都掌握啦'), -1, '只有诊断题的一轮头条不许说「都掌握啦」：' + degraded);
    const realQs = questions.filter(function (q) { return q.topicId === PAIRED_TARGET; });
    const gBank = ENGINE.buildGraph(TOPICS, [], realQs);
    const sBank = ENGINE.createSession(gBank, [PAIRED_TARGET], SESSION_OPTS);
    const normal = APP_MOD.resultHeadline(ENGINE.summarize(gBank, sBank), sBank, false, false, true);
    assert.strictEqual(normal.indexOf('不作数'), -1, '真题到货的一轮不许说「不作数」：' + normal);
    assert.ok(normal.indexOf('已掌握') >= 0, '真题到货、目标全对时应保留「目标知识点已掌握」：' + normal);
  });
}

/* ------------------------------------------------------------ 7. 整年级题库门（P0：点了没反应）
 *
 * a94fef3 把 app.js 拆到 app-flow.js 时 CORE 漏挂 registerFlow，FLOW 恒为 null，
 * flow('enter') 恒 null → 整年级/单点都无会话、无报错、无兜底卡。
 * 另一个根因：ensureFlowReady 在 screen 下等全部 targets 的 63 个章节，弱网十几秒才放行。
 * 下面这组守住：注册链路、门只等前缀章节、后台 ≤2 并发补齐（失败重试一次）、等待期不给假结论。
 */
const CHAPTER = require('../diagnose/chapter.js');
const BG_WAIT_MS = 10000;

function okJson(obj) { return { ok: true, status: 200, json: async function () { return obj; } }; }
function notFound() { return { ok: false, status: 404 }; }
function stubFetchDynamic(handler) {
  const calls = [];
  global.fetch = function (url) {
    const u = String(url);
    calls.push(u);
    return Promise.resolve(handler(u));
  };
  return calls;
}
function waitFor(fn) {
  const t0 = Date.now();
  return new Promise(function (resolve, reject) {
    (function tick() {
      let ok = false;
      try { ok = !!fn(); } catch (e) { reject(e); return; }
      if (ok) return resolve();
      if (Date.now() - t0 > BG_WAIT_MS) return reject(new Error('等待后台补齐超时'));
      setTimeout(tick, 5);
    })();
  });
}
function keyForTopic(t) {
  const grade = t && t.grade != null && t.grade !== '' ? String(t.grade) : '';
  return CHAPTER.subjectOf(t) + '|' + grade + '|' + String((t && t.chapter) || '');
}
function setupMathGrade(grade, mod) {
  const M = mod || APP_MOD;
  const ts = TOPICS.filter(function (t) { return CHAPTER.subjectOf(t) === 'math' && String(t.grade) === String(grade); });
  M.S.subject = 'math';
  M.S.D = {
    topics: ts, deps: [], stdById: {}, tree: {}, aliases: {},
    graph: CHAPTER.buildGraph(ts, [], null)
  };
  return ts;
}
function bundleFetcher(calls) {
  return function (u) {
    if (/questions-index\//.test(u)) return okJson(index);
    if (/data\/questions\/[^/]+\.json$/.test(u)) {
      const file = u.split('/').pop();
      const p = path.join(DIR, file);
      if (!fs.existsSync(p)) return notFound();
      return okJson(JSON.parse(fs.readFileSync(p, 'utf8')));
    }
    return notFound();
  };
}

/* 门内章节的 bundle 先挂住不 resolve（模拟弱网），其余数据立刻返回；
 * released 里收每次被挂住的请求，调用 release() 才算到货。 */
function gateHoldFetcher(gateFiles, released) {
  return function (u) {
    if (/data\/topics\.json$/.test(u)) return okJson(TOPICS);
    if (/data\/dependencies\.json$/.test(u)) return okJson([]);
    if (/questions-index\//.test(u)) return okJson(index);
    if (/data\/questions\/[^/]+\.json$/.test(u)) {
      const file = u.split('/').pop();
      if (gateFiles[file]) {
        return new Promise(function (resolve) {
          released.push({
            file: file,
            release: function () {
              const p = path.join(DIR, file);
              resolve(fs.existsSync(p) ? okJson(JSON.parse(fs.readFileSync(p, 'utf8'))) : notFound());
            }
          });
        });
      }
      const p = path.join(DIR, file);
      if (!fs.existsSync(p)) return notFound();
      return okJson(JSON.parse(fs.readFileSync(p, 'utf8')));
    }
    return notFound();
  };
}
function gateFileSet(gateKeys) {
  const out = Object.create(null);
  gateKeys.forEach(function (k) { if (index[k]) out[index[k]] = true; });
  return out;
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function runScreenGateTests() {
  /* ---- ① 根因 A：registerFlow 守卫（源码级 + 行为级） ---- */
  test('app.js：CORE 字面量里必须挂 registerFlow（a94fef3 的 P0 回归）', function () {
    const core = bodyAfter(APP_SRC, 'var CORE = {');
    assert.ok(/registerFlow\s*:\s*registerFlow/.test(core),
      'CORE 漏挂 registerFlow → app-flow 的注册被静默跳过，整年级/单点点了没反应');
  });

  await testAsync('行为级：Node require app.js + app-flow.js 后 DiagCore.flow("enter") 不为 null', async function () {
    require('../diagnose/app-flow.js');   // 已缓存也无妨：关键是注册已发生
    assert.ok(global.DiagCore, 'app.js 应在 Node 下挂 global.DiagCore');
    assert.strictEqual(typeof global.DiagCore.registerFlow, 'function', 'DiagCore.registerFlow 缺失');
    const enter = global.DiagCore.flow('enter');
    assert.strictEqual(typeof enter, 'function', 'flow("enter") 仍是 null：整年级按钮会继续点了没反应');
  });

  /* ---- ①b 根因 B：app-flow 不许把 CORE.E 快照成局部变量（问题 1） ---- */
  test('app-flow.js：引擎不在首屏，不许把 CORE.E 快照成局部变量（必须每次过 eng()）', function () {
    assert.strictEqual(/E\s*=\s*CORE\.E\b/.test(FLOW_SRC), false,
      'E = CORE.E 会在 app-flow 先于 engine.js 加载时把 undefined 永久快照进闭包');
    assert.ok(/function eng\(\)/.test(FLOW_SRC), '缺 eng()：每次用时必须重新读 CORE.E 这个活 getter');
    assert.ok(FLOW_SRC.indexOf('CORE.E') >= 0, 'eng() 里必须真的返回 CORE.E');
    const uses = FLOW_SRC.match(/eng\(\)\./g) || [];
    assert.ok(uses.length >= 20, 'eng(). 调用次数应 ≥ 20（防止只改一半），实际 ' + uses.length);
  });

  await testAsync('行为级：app-flow 先加载、引擎后到，startSession 仍能开会话（问题 1 真身）', async function () {
    const appPath = require.resolve('../diagnose/app.js');
    const flowPath = require.resolve('../diagnose/app-flow.js');
    const unhandled = [];
    const onUnhandled = function (e) { unhandled.push(e); };
    process.on('unhandledRejection', onUnhandled);
    delete require.cache[appPath];
    delete require.cache[flowPath];
    const calls = stubFetchDynamic(bundleFetcher());
    let mod = null;
    try {
      /* app.js 在 Node 分支末尾会立刻 require app-flow：此时 CORE.E 还是 undefined，
       * 等价于浏览器里 app-flow 先于 engine.js 加载。旧代码会在这里把 undefined 快照住。 */
      mod = require('../diagnose/app.js');
      const flowMod = require('../diagnose/app-flow.js');
      assert.strictEqual(mod.S.session, null);
      mod.setEngine(ENGINE);                    // 引擎「后到」
      setupMathGrade(7, mod);                   // 最小 S.D（topics/deps/graph）
      const ids = CHAPTER.gradeTargets(mod.S.D.graph, '七年级', 'math').ids;
      assert.strictEqual(await mod.ensureFlowReady(ids, null, 'screen'), true, '题库应到货并开门');
      let thrown = null;
      try { flowMod.startSession(ids, '七年级', 40, 'screen'); }
      catch (e) { thrown = e; }                 // Node 无 DOM：渲染阶段的错不属于本用例
      assert.ok(mod.S.session, 'startSession 之后 S.session 不能是 null（旧代码在这里抛 reading createSession）');
      assert.ok(ENGINE.nextItem(mod.S.D.graph, mod.S.session), '经新引擎的会话应能拿到题');
      assert.strictEqual(/createSession/.test((thrown && thrown.message) || ''), false,
        '不许再出现 reading \'createSession\'：' + (thrown && thrown.message));
      await new Promise(function (r) { setTimeout(r, 20); });
      assert.strictEqual(unhandled.length, 0,
        '不应有 unhandledRejection：' + (unhandled[0] && unhandled[0].message));
    } finally {
      restoreFetch();
      process.removeListener('unhandledRejection', onUnhandled);
      if (mod && mod.resetQuestionsCache) mod.resetQuestionsCache();   // 停掉这一轮的后台补齐
      delete require.cache[appPath];
      delete require.cache[flowPath];
      global.DiagCore = require('../diagnose/app.js');   // 还原给后面的用例
    }
  });

  /* ---- ② 源码级：screen 门只等 gate 章节 ---- */
  test('app.js：screen 题源门只等 gate 前缀章节，不等整个 targets', function () {
    const body = bodyAfter(APP, 'async function ensureFlowReady(');
    assert.ok(body.indexOf('gateTargetsOf(') >= 0, 'ensureFlowReady 应先用 gateTargetsOf 切出前缀章节');
    assert.strictEqual(body.indexOf('ensureQuestionsForTopics(targets)'), -1,
      '不许对整个 targets 调题库门（弱网下 63 章要等十几秒）');
    assert.strictEqual(body.indexOf('ensureQuestionsForTopics(flowTargets)'), -1,
      '不许把整个 targets 塞进 flowTargets 再交给题库门');
    assert.ok(/flowTargets\s*=\s*gate;/.test(body), 'flowTargets 必须收窄成 gate（门内章节）');
    /* 旧守卫仍要求无参 ensureQuestions() 出现；它现在只读收窄后的 flowTargets（=gate），
     * 所以这里额外断言 flowTargets 在它之前被赋值，防止有人把整个 targets 又放回去。 */
    assert.ok(body.indexOf('flowTargets = gate;') < body.indexOf('const bank = ensureQuestions();'),
      'ensureQuestions() 之前必须先把 flowTargets 收窄成 gate');
    const m = /const SCREEN_GATE_TARGETS = (\d+);/.exec(APP_SRC);
    assert.ok(m, '缺 SCREEN_GATE_TARGETS 常量');
    assert.ok(parseInt(m[1], 10) <= 12, 'SCREEN_GATE_TARGETS 不得超过 12');
    const b = /const SCREEN_GATE_BUNDLES = (\d+);/.exec(APP_SRC);
    assert.ok(b, '缺 SCREEN_GATE_BUNDLES 常量');
    assert.ok(parseInt(b[1], 10) <= 3, 'SCREEN_GATE_BUNDLES 不得超过 3');
  });

  /* ---- ②b 源码级：后台补齐到货不许把页面刷回选题页（问题 3） ---- */
  test('app.js：questionsArrived 在 renderStart 之前必须守住 flowPending 与后台补齐', function () {
    const body = bodyAfter(APP_SRC, 'function questionsArrived(');
    const at = body.indexOf('renderStart(');
    assert.ok(at >= 0, 'questionsArrived 应保留 renderStart(S.startErr)');
    const before = body.slice(0, at);
    const fp = before.indexOf('S.flowPending');
    const bg = before.indexOf('bg.running');
    assert.ok(fp >= 0, 'renderStart 之前必须守 S.flowPending：门还开着时不许回到选题页');
    assert.ok(bg >= 0, 'renderStart 之前必须守 bg.running：后台还在补时保持当前视图');
    assert.ok(fp < bg, '两道守卫顺序：先 flowPending，再后台补齐状态');
  });

  /* ---- ③ 行为级：门开前只请求 gate 章节 ---- */
  await testAsync('真跑 ensureFlowReady：119 targets / 63 章节，开门前只请求 ≤3 个 gate 章节 bundle', async function () {
    APP_MOD.resetQuestionsCache();
    APP_MOD.setEngine(ENGINE);
    setupMathGrade(7);
    const ids = CHAPTER.gradeTargets(APP_MOD.S.D.graph, '七年级', 'math').ids;
    assert.strictEqual(ids.length, 119, '七年级数学目标数应为 119，实际 ' + ids.length);
    const split = APP_MOD.gateTargetsOf(ids, 'screen');
    const gateKeys = APP_MOD.chapterKeysOf(split.gate);
    const gateFiles = gateKeys.map(function (k) { return index[k]; }).sort();
    const calls = stubFetchDynamic(bundleFetcher());
    try {
      const ok = await APP_MOD.ensureFlowReady(ids, null, 'screen');
      assert.strictEqual(ok, true, '题源门应放行（gate 章节已到 + 全量 topics 失败也靠 legacy 兜底）');
      /* backgroundFill 用 setTimeout 起泵：await 恢复时（微任务）后台还没发请求。 */
      const requested = Array.from(new Set(bundleRequests(calls).map(function (u) { return u.split('/').pop(); }))).sort();
      assert.deepStrictEqual(requested, gateFiles, '开门前只该请求 gate 章节的 bundle');
      assert.ok(split.gate.length <= APP_MOD.SCREEN_GATE_TARGETS,
        'gate 目标数应 ≤ ' + APP_MOD.SCREEN_GATE_TARGETS + '，实际 ' + split.gate.length);
      assert.ok(gateKeys.length <= APP_MOD.SCREEN_GATE_BUNDLES,
        'gate 章节数应 ≤ ' + APP_MOD.SCREEN_GATE_BUNDLES + '，实际 ' + gateKeys.length);
      assert.ok(requested.length <= APP_MOD.SCREEN_GATE_BUNDLES,
        '开门前请求的 bundle 应 ≤ ' + APP_MOD.SCREEN_GATE_BUNDLES + '，实际 ' + requested.length);
      assert.ok(requested.length >= 1, '开门前至少应请求 gate 的第一个章节');
      const chapterNos = new Set(split.gate.map(function (id) {
        return CHAPTER.parseChapter(APP_MOD.S.D.graph.byId[id].chapter).chapterNo;
      }));
      assert.ok(chapterNos.size <= 3, 'gate 目标应落在前 1~3 个章，实际 ' + chapterNos.size + ' 个');
      assert.ok(split.rest.length > 0, '整年级应还有章节留给后台补齐');
      assert.strictEqual(new Set(split.rest.map(function (id) { return keyForTopic(APP_MOD.S.D.graph.byId[id]); })).size,
        split.rest.length, 'rest 应按章节只留一个代表');
      assert.strictEqual(APP_MOD.backgroundFillState().total, split.rest.length,
        '后台补齐 total 应等于剩余章节数');
    } finally { restoreFetch(); APP_MOD.resetQuestionsCache(); }
  });

  /* ---- ④ 行为级：后台补齐（并发 ≤2、失败重试一次） ---- */
  await testAsync('真跑后台补齐：门开之后补齐剩余章节，done=total、maxActive≤2、failed=0', async function () {
    APP_MOD.resetQuestionsCache();
    APP_MOD.setEngine(ENGINE);
    setupMathGrade(7);
    const ids = CHAPTER.gradeTargets(APP_MOD.S.D.graph, '七年级', 'math').ids;
    const split = APP_MOD.gateTargetsOf(ids, 'screen');
    const calls = stubFetchDynamic(bundleFetcher());
    try {
      assert.strictEqual(await APP_MOD.ensureFlowReady(ids, null, 'screen'), true);
      await waitFor(function () { return !APP_MOD.backgroundFillState().running; });
      const st = APP_MOD.backgroundFillState();
      assert.strictEqual(st.total, split.rest.length, '后台补齐该覆盖全部剩余章节');
      assert.strictEqual(st.done, st.total, '剩余章节应全部补齐');
      assert.strictEqual(st.failed, 0, '正常数据不应有最终失败');
      assert.ok(st.maxActive <= 2, '后台补齐并发必须 ≤ 2，实际 ' + st.maxActive);
      assert.ok(st.maxActive >= 1, '应真的并发跑过');
    } finally { restoreFetch(); APP_MOD.resetQuestionsCache(); }
  });

  await testAsync('真跑后台补齐：某个 bundle 首次 404、重试成功（请求次数=2、最终 done 覆盖它）', async function () {
    APP_MOD.resetQuestionsCache();
    APP_MOD.setEngine(ENGINE);
    setupMathGrade(7);
    const ids = CHAPTER.gradeTargets(APP_MOD.S.D.graph, '七年级', 'math').ids;
    const split = APP_MOD.gateTargetsOf(ids, 'screen');
    const tryFile = index[APP_MOD.chapterKeysOf([split.rest[0]])[0]];
    const counts = Object.create(null);
    const normal = bundleFetcher();
    const calls = stubFetchDynamic(function (u) {
      if (/data\/questions\/[^/]+\.json$/.test(u)) {
        const file = u.split('/').pop();
        counts[file] = (counts[file] || 0) + 1;
        if (file === tryFile && counts[file] === 1) return notFound();   // 首次 404
        return normal(u);
      }
      return normal(u);
    });
    try {
      assert.strictEqual(await APP_MOD.ensureFlowReady(ids, null, 'screen'), true);
      await waitFor(function () { return !APP_MOD.backgroundFillState().running; });
      const st = APP_MOD.backgroundFillState();
      assert.strictEqual(counts[tryFile], 2, '失败章节应被重试一次（请求次数 2），实际 ' + counts[tryFile]);
      assert.strictEqual(st.done, st.total, '重试成功后最终 done 应覆盖它');
      assert.strictEqual(st.failed, 0, '重试成功后不应计最终失败');
    } finally { restoreFetch(); APP_MOD.resetQuestionsCache(); }
  });

  /* ---- ⑤ 不许假结论：只加载 gate 章节时，未加载章节必须仍是 untested ---- */
  test('只加载 gate 章节：summarize 的 untested 非空、mastered 不含未加载章节、studentAdvice 不说「都掌握啦」', function () {
    APP_MOD.resetQuestionsCache();
    const ts = setupMathGrade(7);
    const ids = CHAPTER.gradeTargets(APP_MOD.S.D.graph, '七年级', 'math').ids;
    const split = APP_MOD.gateTargetsOf(ids, 'screen');
    const gateKeys = APP_MOD.chapterKeysOf(split.gate);
    const gateQs = [];
    gateKeys.forEach(function (k) {
      gateQs.push.apply(gateQs, JSON.parse(fs.readFileSync(path.join(DIR, index[k]), 'utf8')));
    });
    const g = CHAPTER.buildGraph(ts, [], gateQs);
    const session = ENGINE.createSession(g, ids, { mode: 'screen', limit: 40, confirm: 3, seed: 'gate' });
    const sum = ENGINE.summarize(g, session);
    assert.ok(sum.untested.length > 0, '只加载了 gate 章节时一定有没测到的点');
    const gateSet = new Set(gateKeys);
    assert.ok(sum.untested.some(function (id) { return !gateSet.has(keyForTopic(g.byId[id])); }),
      '未加载章节的点必须还在 untested 里');
    assert.ok(sum.mastered.every(function (id) { return gateSet.has(keyForTopic(g.byId[id])); }),
      '已掌握不许包含未加载章节的点（会把「题库没到」当「已掌握」）');
    const advice = ENGINE.studentAdvice(sum, function (id) { return g.byId[id].name; });
    assert.strictEqual(advice.indexOf('都掌握啦'), -1, '还有没测完的点时不许说「都掌握啦」：' + advice);
  });

  /* ---- ⑥ 门内章节没到齐就不许开门（修「57ms 就开会话、开出一堆 legacy 诊断题」） ---- */
  await testAsync('真跑 ensureFlowReady：gate 章节 bundle 挂住时 300ms 仍不 resolve，放行后才 resolve 为 true 且只请求 ≤3 章', async function () {
    APP_MOD.resetQuestionsCache();
    APP_MOD.setEngine(ENGINE);
    setupMathGrade(7);
    const ids = CHAPTER.gradeTargets(APP_MOD.S.D.graph, '七年级', 'math').ids;
    assert.strictEqual(ids.length, 119, '七年级数学目标数应为 119，实际 ' + ids.length);
    const split = APP_MOD.gateTargetsOf(ids, 'screen');
    const gateKeys = APP_MOD.chapterKeysOf(split.gate);
    const gateFiles = gateFileSet(gateKeys);
    assert.ok(gateKeys.length >= 1, 'gate 至少应有 1 个章节');
    const released = [];
    const calls = stubFetchDynamic(gateHoldFetcher(gateFiles, released));
    let settled = false;
    const p = APP_MOD.ensureFlowReady(ids, null, 'screen').then(function (v) {
      settled = true;
      return v;
    });
    try {
      const SENTINEL = {};
      const raced = await Promise.race([
        p.then(function () { return 'resolved'; }),
        sleep(300).then(function () { return SENTINEL; })
      ]);
      assert.strictEqual(raced, SENTINEL,
        'gate bundle 还没到齐就 resolve 了（旧缺陷：topics.json 的兜底诊断题被当成「能出题」，57ms 开门）');
      assert.strictEqual(settled, false, '门内章节挂住时 ensureFlowReady 不许定案');
      const gateReqs = bundleRequests(calls).filter(function (u) { return gateFiles[u.split('/').pop()]; });
      assert.ok(gateReqs.length >= 1, '应已发起 gate 章节的 bundle 请求，实际 ' + gateReqs.length);
      assert.ok(gateReqs.length <= APP_MOD.SCREEN_GATE_BUNDLES,
        '门内只该请求 ≤' + APP_MOD.SCREEN_GATE_BUNDLES + ' 个章节 bundle，实际 ' + gateReqs.length);
      assert.ok(released.length >= 1, 'gate 章节请求应被挂住（模拟弱网），实际 ' + released.length);
      released.forEach(function (r) { r.release(); });
      assert.strictEqual(await p, true, 'gate 章节到货后题源门应放行');
      assert.strictEqual(settled, true);
      const gateFileReqs = Array.from(new Set(bundleRequests(calls)
        .map(function (u) { return u.split('/').pop(); })
        .filter(function (f) { return gateFiles[f]; })));
      assert.ok(gateFileReqs.length <= APP_MOD.SCREEN_GATE_BUNDLES,
        '门内请求的 bundle 章节数应 ≤' + APP_MOD.SCREEN_GATE_BUNDLES + '，实际 ' + gateFileReqs.length);
    } finally {
      released.forEach(function (r) { try { r.release(); } catch (e) {} });
      restoreFetch();
      APP_MOD.resetQuestionsCache();
    }
  });

  await testAsync('真跑 ensureFlowReady：gate 章节未到齐时 startBackgroundFill 不启动；到齐后 total>0 且 maxActive≤2', async function () {
    APP_MOD.resetQuestionsCache();
    APP_MOD.setEngine(ENGINE);
    setupMathGrade(7);
    const ids = CHAPTER.gradeTargets(APP_MOD.S.D.graph, '七年级', 'math').ids;
    const split = APP_MOD.gateTargetsOf(ids, 'screen');
    const gateKeys = APP_MOD.chapterKeysOf(split.gate);
    const gateFiles = gateFileSet(gateKeys);
    const released = [];
    const calls = stubFetchDynamic(gateHoldFetcher(gateFiles, released));
    const p = APP_MOD.ensureFlowReady(ids, null, 'screen');
    try {
      await sleep(300);
      assert.strictEqual(APP_MOD.backgroundFillState().total, 0,
        '门内章节没到齐就开了后台补齐（会在 69ms 起把 60 个章节 bundle 一口气排开）');
      assert.strictEqual(APP_MOD.backgroundFillState().running, false, '门没开时后台补齐不许在跑');
      assert.ok(released.length >= 1, 'gate 章节请求应被挂住');
      released.forEach(function (r) { r.release(); });
      assert.strictEqual(await p, true);
      await waitFor(function () { return APP_MOD.backgroundFillState().total > 0; });
      const st = APP_MOD.backgroundFillState();
      assert.ok(st.total > 0, '门开之后应启动后台补齐，实际 total=' + st.total);
      assert.ok(st.total <= split.rest.length, '后台补齐不许超出 rest 章节数');
      await waitFor(function () { return !APP_MOD.backgroundFillState().running; });
      assert.ok(APP_MOD.backgroundFillState().maxActive <= 2,
        '后台补齐并发必须 ≤ 2，实际 ' + APP_MOD.backgroundFillState().maxActive);
      assert.ok(APP_MOD.backgroundFillState().maxActive >= 1, '后台补齐应真的跑过');
    } finally {
      released.forEach(function (r) { try { r.release(); } catch (e) {} });
      restoreFetch();
      APP_MOD.resetQuestionsCache();
    }
  });

  test('app.js：ensureFlowReady 里 startBackgroundFill 只能在 gateLoaded() 等待之后，且判据逐 key 读 bundleLoaded', function () {
    const body = bodyAfter(APP, 'async function ensureFlowReady(');
    const waitAt = body.indexOf('!gateLoaded()');
    assert.ok(waitAt >= 0, 'screen 门必须先判 gateLoaded() 再等（否则 57ms 就走兜底题开门）');
    const raceAt = body.indexOf('await Promise.race([full, bank]);', waitAt);
    assert.ok(raceAt > waitAt, 'gateLoaded() 判据之后必须真的等待题库');
    const bgAt = body.indexOf('startBackgroundFill(');
    assert.ok(bgAt > raceAt,
      'startBackgroundFill 出现在 gateLoaded() 等待之前（门没开就把后台补齐排开）');
    assert.ok(/gateKeys\.every\(/.test(body), 'gateLoaded 必须是逐 key 判据（gateKeys.every）');
    assert.ok(/S\.bundleLoaded/.test(body), 'gateLoaded 必须读 S.bundleLoaded（bundle 真的到货才算到齐）');
  });

  /* ---- ⑦ screen 会话只能问「已到货章节」：未到货章节的 legacy 兜底题必须先剔掉 ---- */
  test('app.js/app-flow.js：screen 建会话与续接都必须走 screenRoundGraph()', function () {
    const start = bodyAfter(APP, 'function startSession(');
    assert.ok(/screenRoundGraph/.test(start),
      'startSession 必须用 screenRoundGraph 给 screen 会话取图（否则未加载章节的 legacy 点会进 stack）');
    const ext = bodyAfter(APP, 'function extendScreenSession(');
    assert.ok(/screenRoundGraph/.test(ext),
      'extendScreenSession 的 replay 也必须用 screenRoundGraph（否则续接又把 legacy 点放回 stack）');
    const gr = bodyAfter(APP_SRC, 'function screenRoundGraph(');
    assert.ok(/type !== 'legacy'/.test(gr),
      'screenRoundGraph 必须剔掉未到货章节的 legacy 兜底题（engine.isTestable 把 legacy 也当可测）');
    const core = bodyAfter(APP_SRC, 'var CORE = {');
    assert.ok(/screenRoundGraph\s*:\s*screenRoundGraph/.test(core),
      'CORE 必须暴露 screenRoundGraph 给 app-flow');
  });

  await testAsync('行为级：screen 会话只用已到货章节的题（未到货章节的 legacy 点不进 stack）', async function () {
    APP_MOD.resetQuestionsCache();
    APP_MOD.setEngine(ENGINE);
    setupMathGrade(7);
    const ids = CHAPTER.gradeTargets(APP_MOD.S.D.graph, '七年级', 'math').ids;
    assert.strictEqual(ids.length, 119, '七年级数学目标数应为 119，实际 ' + ids.length);
    const split = APP_MOD.gateTargetsOf(ids, 'screen');
    const gateKeys = APP_MOD.chapterKeysOf(split.gate);
    const gateFiles = gateFileSet(gateKeys);
    const calls = stubFetchDynamic(function (u) {
      if (/data\/topics\.json$/.test(u)) return okJson(TOPICS);
      if (/data\/dependencies\.json$/.test(u)) return okJson([]);
      if (/questions-index\//.test(u)) return okJson(index);
      if (/data\/questions\/[^/]+\.json$/.test(u)) {
        const file = u.split('/').pop();
        /* gate 章节的 bundle 立刻到货；其余章节永远挂住（模拟题库还没下来）。 */
        if (gateFiles[file]) {
          const p = path.join(DIR, file);
          return okJson(JSON.parse(fs.readFileSync(p, 'utf8')));
        }
        return new Promise(function () {});
      }
      return notFound();
    });
    try {
      assert.strictEqual(await APP_MOD.ensureFlowReady(ids, null, 'screen'), true, 'gate 章节到货后门应放行');
      assert.ok(gateKeys.length > 0 && gateKeys.every(function (k) { return APP_MOD.S.bundleLoaded[k]; }),
        'gate 章节应已标记到货');
      const g = APP_MOD.screenRoundGraph();
      assert.ok(g, 'screenRoundGraph 应返回图');
      const loaded = APP_MOD.S.bundleLoaded;
      /* 图中还剩题的点必须全部落在已到货章节：未到货章节的 legacy 已被剔掉。 */
      const testableIds = Object.keys(g.bank).filter(function (id) { return g.bank[id] && g.bank[id].length; });
      testableIds.forEach(function (id) {
        const k = keyForTopic(g.byId[id]);
        assert.ok(loaded[k], '可测点 ' + id + ' 落在未到货章节：' + k);
      });
      const session = ENGINE.createSession(g, ids, { mode: 'screen', limit: 40, confirm: 3, seed: 'gate' });
      assert.ok(session.stack.length > 0, 'gate 章节有真题，stack 不应为空');
      session.stack.forEach(function (id) {
        const k = keyForTopic(g.byId[id]);
        assert.ok(loaded[k], 'stack 混进未到货章节的点：' + id + ' / ' + k);
      });
      const item = ENGINE.nextItem(g, session);
      assert.ok(item, '已到货章节应能出第一题');
      assert.notStrictEqual(item.question.type, 'legacy',
        '第一题不许是题库没到的 legacy 兜底题（「本知识点第 1 / 1 题」的假结论）');
      const sum = ENGINE.summarize(g, session);
      assert.ok(sum.untested.length > 0, '未到货章节的点必须仍算未测，不能当成测过');
      console.log('       screenRoundGraph：可测点 ' + testableIds.length + ' 个 / bank key ' +
        Object.keys(g.bank).length + ' 个；createSession(...).stack.length = ' + session.stack.length);
    } finally { restoreFetch(); APP_MOD.resetQuestionsCache(); }
  });

  await testAsync('行为级：gate 章节全 404 且全量回退也失败时 ensureFlowReady 返回 false（不开假会话）', async function () {
    APP_MOD.resetQuestionsCache();
    APP_MOD.setEngine(ENGINE);
    setupMathGrade(7);
    const ids = CHAPTER.gradeTargets(APP_MOD.S.D.graph, '七年级', 'math').ids;
    stubFetchDynamic(function (u) {
      if (/data\/topics\.json$/.test(u)) return okJson(TOPICS);
      if (/data\/dependencies\.json$/.test(u)) return okJson([]);
      if (/questions-index\//.test(u)) return okJson(index);
      return notFound();   // 章节 bundle 404 + 全量 questions.json 也 404
    });
    try {
      const warns = await captureWarns(async function () {
        assert.strictEqual(await APP_MOD.ensureFlowReady(ids, null, 'screen'), false,
          '题源真取不到时必须返回 false：不许拿 topics.json 的 legacy 兜底题开「1/1 题」的假会话');
      });
      assert.ok(warns.join(' | ').indexOf('回退全量') >= 0, 'bundle 404 仍应先按老路径 warn 并尝试回退全量');
    } finally { restoreFetch(); APP_MOD.resetQuestionsCache(); }
  });
}

function report() {
  console.log('\n' + (failed === 0 ? '全部通过' : '存在失败') + '：' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed === 0 ? 0 : 1);
}

runDegradeTests()
  .then(runScreenGateTests)
  .then(report, function (e) {
    console.log('  FAIL 退化/题库门用例框架出错\n       ' + (e && e.stack || e));
    failed++;
    report();
  });
