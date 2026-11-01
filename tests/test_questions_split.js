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
const APP = fs.readFileSync(path.join(ROOT, 'diagnose', 'app.js'), 'utf8');
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
  ['data/topics-lite.json', 'data/topics.json', 'data/dependencies.json', 'data/cn-curriculum-standards.json', 'data/id-aliases.json']
    .forEach(function (p) { assert.ok(items.indexOf("'" + p + "'") >= 0, 'DATA 里仍应有 ' + p); });
  assert.ok(/var VERSION = 'v8';/.test(SW), 'VERSION 应已是 v8');
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

console.log('\n' + (failed === 0 ? '全部通过' : '存在失败') + '：' + passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);
