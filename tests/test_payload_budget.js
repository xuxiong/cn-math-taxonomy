#!/usr/bin/env node
/* 首屏载荷拆分守卫：node tests/test_payload_budget.js（纯 node，无依赖）
 *
 * 背景（线上 8-10KB/s 的中国链路，1KB gzip ≈ 0.1s 首绘）：
 *   首页上一版首屏同时 fetch topics.json(347KB gz)、dependencies.json(114KB)、
 *   questions.json(1165KB gz)、cn-curriculum-standards(44KB) = 约 1650KB gz ≈ 30s+。
 *   本 fork 由 scripts/build-payload-split.mjs 拆出 stats.json / topics-lite/<s> /
 *   dependencies/<s> / questions-index/<s> / topics-detail/<slug>，首页只取
 *   stats.json + 当前学科 topics-lite。
 *
 * 本文件守：拆分产物与全量真源逐字节/逐数守恒、构建幂等、以及首页首屏 gzip 预算
 * （脚本 + 首屏数据 ≤ 81920B，约 8s）。与 test_data_split.js 同风格：tiny test 助手、
 * 每用例 ok/fail、结尾 "N passed, M failed"、process.exit(failed?1:0)。
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SUBJECTS = ['math', 'english', 'physics', 'chinese', 'science', 'morality', 'history', 'geography'];
const LITE_FIELDS = ['id', 'name', 'domain', 'grade', 'semester', 'chapter', 'type'];
const HEAVY_FIELDS = ['description', 'mastery_criteria', 'diagnostic_question', 'standards', 'root_reason', 'mathLinks'];
const FORBIDDEN = ['questions.json', 'data/topics.json', 'dependencies.json', 'cn-curriculum-standards'];
const BUDGET_LIMIT = 80 * 1024;

const DATA = path.join(ROOT, 'data');
const TOPICS_PATH = path.join(DATA, 'topics.json');
const DEPS_PATH = path.join(DATA, 'dependencies.json');
const QUESTIONS_PATH = path.join(DATA, 'questions.json');
const QI_PATH = path.join(DATA, 'questions-index.json');
const STD_PATH = path.join(DATA, 'cn-curriculum-standards.json');
const HOME = fs.readFileSync(path.join(ROOT, 'assets', 'home.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e).split('\n').slice(0, 8).join('\n       ')); }
}

/* ------------------------------------------------ 学科判定（与 build-payload-split 同一套规则） */

/** subjectOf：先看 topic.subject 字段，缺省按 id 前缀推，数学兜底。 */
function subjectOf(topic) {
  const s = topic && topic.subject;
  if (SUBJECTS.indexOf(s) >= 0) return s;
  return subjectOfId(topic && topic.id);
}

function subjectOfId(id) {
  id = String(id || '');
  if (id.indexOf('cne_') === 0) return 'english';
  if (id.indexOf('cnp_') === 0) return 'physics';
  if (id.indexOf('cnc_') === 0) return 'chinese';
  if (id.indexOf('cns_') === 0) return 'science';
  if (id.indexOf('cnd_') === 0) return 'morality';
  if (id.indexOf('cnh_') === 0) return 'history';
  if (id.indexOf('cng_') === 0) return 'geography';
  return 'math';
}

function subjectOfStd(id) {
  id = String(id || '');
  if (id.indexOf('ces-') === 0) return 'english';
  if (id.indexOf('cps-') === 0) return 'physics';
  if (id.indexOf('ccs-') === 0) return 'chinese';
  if (id.indexOf('css-') === 0) return 'science';
  if (id.indexOf('cds-') === 0) return 'morality';
  if (id.indexOf('chs-') === 0) return 'history';
  if (id.indexOf('cgs-') === 0) return 'geography';
  return 'math';
}

/* ------------------------------------------------ A. stats.json 守恒 */

/** 从全量真源重算各学科计数（独立实现，不复用被测脚本）。 */
function recomputeStats() {
  const topics = JSON.parse(fs.readFileSync(TOPICS_PATH, 'utf8'));
  const deps = JSON.parse(fs.readFileSync(DEPS_PATH, 'utf8'));
  const questions = JSON.parse(fs.readFileSync(QUESTIONS_PATH, 'utf8'));
  const standards = JSON.parse(fs.readFileSync(STD_PATH, 'utf8'));
  const byId = new Map();
  topics.forEach((t) => { if (t && t.id) byId.set(t.id, t); });
  const per = {};
  SUBJECTS.forEach((s) => { per[s] = { topics: 0, edges: 0, questions: 0, standards: 0 }; });
  topics.forEach((t) => { per[subjectOf(t)].topics++; });
  deps.forEach((e) => { per[subjectOf(byId.get(e.topicId) || { id: e.topicId })].edges++; });
  questions.forEach((q) => {
    const t = q && byId.get(q.topicId);
    per[subjectOf(t || { id: q && q.topicId })].questions++;
  });
  (standards.items || []).forEach((it) => { per[subjectOfStd(it.id)].standards++; });
  const total = { topics: 0, edges: 0, questions: 0, standards: 0 };
  SUBJECTS.forEach((s) => {
    total.topics += per[s].topics;
    total.edges += per[s].edges;
    total.questions += per[s].questions;
    total.standards += per[s].standards;
  });
  return { per, total };
}

function checkStatsConservation(stats) {
  const rec = recomputeStats();
  assert.strictEqual(Object.keys(stats.subjects).length, SUBJECTS.length, 'subjects 学科数不对');
  const wantTotal = { topics: 2997, edges: 4456, questions: 12135, standards: 734 };
  Object.keys(wantTotal).forEach((k) => {
    assert.strictEqual(stats.total[k], wantTotal[k], 'total.' + k + ' 应等于 ' + wantTotal[k] + '，实际 ' + stats.total[k]);
  });
  const sum = { topics: 0, edges: 0, questions: 0, standards: 0 };
  SUBJECTS.forEach((s, i) => {
    const got = stats.subjects[s];
    assert.ok(got, '缺学科 ' + s);
    assert.strictEqual(Object.keys(stats.subjects)[i], s, '学科顺序应为 ' + s);
    ['topics', 'edges', 'questions', 'standards'].forEach((k) => {
      sum[k] += got[k];
      assert.strictEqual(got[k], rec.per[s][k], s + '.' + k + ' 与全量重算不一致：' + got[k] + ' vs ' + rec.per[s][k]);
    });
  });
  Object.keys(wantTotal).forEach((k) => {
    assert.strictEqual(sum[k], stats.total[k], k + ' 各学科求和应与 total 一致');
  });
}

test('stats.json：total 固定 2997/4456/12135/734，各学科与全量重算一致、求和等于 total', function () {
  const stats = JSON.parse(fs.readFileSync(path.join(DATA, 'stats.json'), 'utf8'));
  checkStatsConservation(stats);
});

test('stats.json：standards 各学科求和等于 cn-curriculum-standards items.length', function () {
  const stats = JSON.parse(fs.readFileSync(path.join(DATA, 'stats.json'), 'utf8'));
  const items = JSON.parse(fs.readFileSync(STD_PATH, 'utf8')).items || [];
  let sum = 0;
  SUBJECTS.forEach((s) => { sum += stats.subjects[s].standards; });
  assert.strictEqual(sum, items.length, 'standards 和 ' + sum + ' 应等于 items ' + items.length);
});

/* ------------------------------------------------ B. topics-lite 守恒 */

function filterBySubject(arr, subj, byId) {
  return arr.filter((x) => subjectOf(byId ? byId.get(x.topicId) || { id: x.topicId } : x) === subj);
}

function checkLiteConservation(liteBySubject) {
  const topics = JSON.parse(fs.readFileSync(TOPICS_PATH, 'utf8'));
  SUBJECTS.forEach((s) => {
    const rows = liteBySubject[s];
    assert.ok(Array.isArray(rows), '缺学科 ' + s + ' 的 lite 数组');
    const fullCount = topics.filter((t) => subjectOf(t) === s).length;
    assert.strictEqual(rows.length, fullCount, s + ' lite 条数 ' + rows.length + ' ≠ 全量过滤 ' + fullCount);
    rows.forEach((r, i) => {
      const keys = Object.keys(r);
      assert.deepStrictEqual(keys, LITE_FIELDS, s + ' 第 ' + i + ' 行字段应为 ' + LITE_FIELDS.join(',') + '：' + keys.join(','));
    });
  });
  const liteAll = JSON.parse(fs.readFileSync(path.join(DATA, 'topics-lite.json'), 'utf8'));
  const allIds = new Set(liteAll.map((t) => t.id));
  const union = new Set();
  SUBJECTS.forEach((s) => { liteBySubject[s].forEach((t) => union.add(t.id)); });
  assert.strictEqual(union.size, allIds.size, '各学科 lite 的 id 并集应与 data/topics-lite.json 的 id 集合一致');
  union.forEach((id) => assert.ok(allIds.has(id), '并集多出 id ' + id));
  allIds.forEach((id) => assert.ok(union.has(id), '并集少了 id ' + id));
  /* 每个学科的顺序 = 全量里该学科的源顺序 */
  SUBJECTS.forEach((s) => {
    const expect = topics.filter((t) => subjectOf(t) === s).map((t) => t.id);
    const got = liteBySubject[s].map((t) => t.id);
    assert.deepStrictEqual(got, expect, s + ' lite 顺序应与全量源顺序一致');
  });
}

test('topics-lite/*.json：逐学科条数=全量过滤，每行恰 7 个白名单字段，id 并集=topics-lite.json，顺序=源顺序', function () {
  const lite = {};
  SUBJECTS.forEach((s) => { lite[s] = JSON.parse(fs.readFileSync(path.join(DATA, 'topics-lite', s + '.json'), 'utf8')); });
  checkLiteConservation(lite);
});

/* ------------------------------------------------ C. dependencies 守恒 */

function checkDepsConservation(depsBySubject) {
  const depsAll = JSON.parse(fs.readFileSync(DEPS_PATH, 'utf8'));
  const topics = JSON.parse(fs.readFileSync(TOPICS_PATH, 'utf8'));
  const byId = new Map();
  topics.forEach((t) => { if (t && t.id) byId.set(t.id, t); });
  /* 每条边都要在原文件里逐字节出现（原样，不是结构等价） */
  SUBJECTS.forEach((s) => {
    const arr = depsBySubject[s];
    assert.ok(Array.isArray(arr), '缺学科 ' + s + ' 的边数组');
    arr.forEach((e) => {
      const found = depsAll.some((full) => JSON.stringify(full) === JSON.stringify(e));
      assert.ok(found, s + ' 有条边不在 data/dependencies.json：' + JSON.stringify(e));
    });
    const expect = filterBySubject(depsAll, s, byId);
    assert.deepStrictEqual(arr, expect, s + ' 边数组应等于全量过滤后的数组');
  });
}

test('dependencies/*.json：每条边原样在 dependencies.json 中，逐学科数组=全量过滤', function () {
  const dep = {};
  SUBJECTS.forEach((s) => { dep[s] = JSON.parse(fs.readFileSync(path.join(DATA, 'dependencies', s + '.json'), 'utf8')); });
  checkDepsConservation(dep);
});

/* ------------------------------------------------ D. questions-index 守恒 */

function checkQIConservation(qiBySubject) {
  const globalQI = JSON.parse(fs.readFileSync(QI_PATH, 'utf8'));
  const union = {};
  SUBJECTS.forEach((s) => {
    const qi = qiBySubject[s];
    assert.ok(qi && typeof qi === 'object', '缺学科 ' + s + ' 的题库索引');
    Object.keys(qi).forEach((k) => { union[k] = qi[k]; });
  });
  const unionKeys = Object.keys(union).sort();
  const globalKeys = Object.keys(globalQI).sort();
  assert.deepStrictEqual(unionKeys, globalKeys, '各学科索引 key 的并集应与 questions-index.json 的 key 集合一致');
  unionKeys.forEach((k) => {
    assert.strictEqual(union[k], globalQI[k], 'key ' + k + ' 的值不一致：' + union[k] + ' vs ' + globalQI[k]);
  });
}

test('questions-index/*.json：key 并集与 questions-index.json 一致，值逐 key 相等', function () {
  const qi = {};
  SUBJECTS.forEach((s) => { qi[s] = JSON.parse(fs.readFileSync(path.join(DATA, 'questions-index', s + '.json'), 'utf8')); });
  checkQIConservation(qi);
});

/* ------------------------------------------------ E. topics-detail 守恒 */

function isEmpty(v) {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

function checkTopicsDetailConservation(bundles) {
  /* 合并所有 bundle：id → 聚合后的 heavy 字段条目 */
  const merged = {};
  Object.keys(bundles).forEach((slug) => {
    bundles[slug].forEach((entry) => {
      assert.ok(entry && entry.id, 'bundle ' + slug + ' 有条目缺 id');
      if (merged[entry.id]) assert.fail('id ' + entry.id + ' 出现在多个 bundle 中');
      merged[entry.id] = entry;
    });
  });
  const topics = JSON.parse(fs.readFileSync(TOPICS_PATH, 'utf8'));
  assert.strictEqual(Object.keys(merged).length, topics.length, '合并后条目数 ' + Object.keys(merged).length + ' ≠ 全量 ' + topics.length);
  topics.forEach((t) => {
    const entry = merged[t.id];
    assert.ok(entry, '全量 topic ' + t.id + ' 在 topics-detail 中缺失');
    assert.strictEqual(entry.id, t.id, 'id 不一致');
    HEAVY_FIELDS.forEach((f) => {
      if (isEmpty(t[f])) {
        assert.ok(!(f in entry), t.id + ' 空字段 ' + f + ' 不应出现在 bundle 里');
      } else {
        assert.deepStrictEqual(entry[f], t[f], t.id + '.' + f + ' 与全量不一致');
      }
    });
  });
  /* 每个 bundle 的 slug 都要在 questions-index.json 中（value 即 slug） */
  const globalQI = JSON.parse(fs.readFileSync(QI_PATH, 'utf8'));
  const qiSlugs = new Set(Object.keys(globalQI).map((k) => globalQI[k]));
  Object.keys(bundles).forEach((slug) => {
    assert.ok(qiSlugs.has(slug), 'bundle ' + slug + ' 的 slug 不在 questions-index.json 中');
  });
  /* 最大单 bundle gzip ≤ 20KB */
  let maxGz = -1;
  Object.keys(bundles).forEach((slug) => {
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(bundles[slug]))).length;
    if (gz > maxGz) maxGz = gz;
    assert.ok(gz <= 20 * 1024, slug + ' gzip ' + gz + 'B 超过 20KB');
  });
  assert.ok(maxGz >= 0, 'topics-detail 为空');
}

test('topics-detail/*.json：合并后与全量逐 topic 的重字段完全一致，slug 在索引中，最大 bundle ≤20KB', function () {
  const dir = path.join(DATA, 'topics-detail');
  const bundles = {};
  fs.readdirSync(dir).forEach((name) => {
    if (!name.endsWith('.json')) return;
    bundles[name] = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
  });
  checkTopicsDetailConservation(bundles);
});

/* ------------------------------------------------ F. 构建幂等 + 与提交树一致 */

function walkTree(dir) {
  const out = {};
  const walk = (d, rel) => {
    fs.readdirSync(d).forEach((name) => {
      const p = path.join(d, name);
      const r = rel ? rel + '/' + name : name;
      if (fs.statSync(p).isDirectory()) walk(p, r);
      else out[r] = fs.readFileSync(p);
    });
  };
  walk(dir, '');
  return out;
}

test('构建幂等：build-payload-split 两次输出字节完全一致，且与已提交树一致', function () {
  const script = path.join(ROOT, 'scripts', 'build-payload-split.mjs');
  assert.ok(fs.existsSync(script), 'scripts/build-payload-split.mjs 不存在');
  const tmpA = fs.mkdtempSync(path.join(os.tmpdir(), 'cnm-pl-a-'));
  const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), 'cnm-pl-b-'));
  try {
    execFileSync(process.execPath, [script, '--out-root', tmpA], { cwd: ROOT, stdio: 'pipe' });
    execFileSync(process.execPath, [script, '--out-root', tmpB], { cwd: ROOT, stdio: 'pipe' });
    const a = walkTree(tmpA);
    const b = walkTree(tmpB);
    assert.deepStrictEqual(Object.keys(a).sort(), Object.keys(b).sort(), '两次构建文件集合不同');
    Object.keys(a).forEach((k) => {
      assert.ok(a[k].equals(b[k]), '文件 ' + k + ' 两次构建字节不同（不幂等）');
    });
    /* 与已提交树逐字节一致：手改产物会失败 */
    const committed = {
      'stats.json': fs.readFileSync(path.join(DATA, 'stats.json')),
    };
    ['topics-lite', 'dependencies', 'questions-index', 'topics-detail'].forEach((fam) => {
      const dir = path.join(DATA, fam);
      fs.readdirSync(dir).forEach((name) => {
        if (name.endsWith('.json')) committed[fam + '/' + name] = fs.readFileSync(path.join(dir, name));
      });
    });
    Object.keys(a).forEach((k) => {
      assert.ok(committed[k] && a[k].equals(committed[k]), '已提交的 ' + k + ' 与重新构建的不一致（忘了跑构建？）');
    });
  } finally {
    fs.rmSync(tmpA, { recursive: true, force: true });
    fs.rmSync(tmpB, { recursive: true, force: true });
  }
});

/* ------------------------------------------------ G. 首页首屏预算 */

/** 从 home.js 提取 BOOT_FILES 数组字面量（正则扫字符串，不 eval）。 */
function extractBootFiles(src) {
  const m = /var\s+BOOT_FILES\s*=\s*\[([\s\S]*?)\];/.exec(src);
  assert.ok(m, 'home.js 里应有 var BOOT_FILES = [...]（数组字面量）');
  const items = [];
  const re = /'((?:[^'\\]|\\.)*)'/g;
  let hit;
  while ((hit = re.exec(m[1])) !== null) items.push(hit[1]);
  assert.ok(items.length > 0, 'BOOT_FILES 数组为空');
  return items;
}

function expandBootFiles(bootFiles, subject) {
  return bootFiles.map((p) => p.replace('{subject}', subject));
}

function gzipBytes(filePath) {
  return zlib.gzipSync(fs.readFileSync(filePath)).length;
}

/** 首屏脚本集合（index.html 里非 defer / data-lazy 的同源 <script src>）。 */
function firstPaintScripts(html) {
  const out = [];
  const re = /<script\b([^>]*)\bsrc="([^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] || '';
    if (/\bdefer\b/.test(attrs) || /\bdata-lazy\b/.test(attrs)) continue;
    const src = m[2];
    if (/^(https?:)?\/\//.test(src) || src.indexOf('data:') === 0) continue;
    out.push(src);
  }
  return out.sort();
}

/** 预算检查器：给定首屏脚本 gzip 总量 + 一份 BOOT_FILES 展开文件，断言 gzip 与禁用串。 */
function checkBudget(scriptGz, expandedFiles) {
  let total = scriptGz;
  expandedFiles.forEach((p) => {
    FORBIDDEN.forEach((needle) => {
      assert.ok(p.indexOf(needle) < 0, '首屏数据引用了禁用的数据文件：' + p);
    });
    assert.ok(p.startsWith('data/'), 'BOOT_FILES 只能含 data/ 下的同源文件：' + p);
    total += gzipBytes(path.join(ROOT, p));
  });
  assert.ok(total <= BUDGET_LIMIT, '首屏 gzip ' + total + 'B 超过预算 ' + BUDGET_LIMIT + 'B（' + (total / 1024).toFixed(1) + 'KB）');
}

test('index.html：非 defer 的同源首屏脚本恰好是 children/blindspots/home 三件', function () {
  const scripts = firstPaintScripts(INDEX_HTML);
  assert.deepStrictEqual(scripts, ['assets/blindspots.js', 'assets/children.js', 'assets/home.js'],
    '首屏脚本集合应为这三个，新增首屏脚本必须过预算关：' + scripts.join(','));
});

test('home.js：BOOT_FILES 清单正确，逐学科首屏 gzip ≤ 80KB，且无禁用子串', function () {
  const bootFiles = extractBootFiles(HOME);
  assert.deepStrictEqual(bootFiles, ['data/stats.json', 'data/topics-lite/{subject}.json'],
    'BOOT_FILES 应为 stats.json + topics-lite/{subject}.json（保留 {subject} 字面量）');
  FORBIDDEN.forEach((needle) => {
    assert.ok(HOME.indexOf(needle) < 0, 'home.js 不应含禁用子串：' + needle);
  });
  const scripts = firstPaintScripts(INDEX_HTML);
  const scriptGz = scripts.reduce((sum, s) => sum + gzipBytes(path.join(ROOT, s)), 0);
  let maxGz = -1;
  SUBJECTS.forEach((s) => {
    const files = expandBootFiles(bootFiles, s);
    let total = scriptGz;
    files.forEach((p) => { total += gzipBytes(path.join(ROOT, p)); });
    if (total > maxGz) maxGz = total;
    assert.ok(total <= BUDGET_LIMIT, s + ' 首屏 gzip ' + total + 'B 超过预算（' + (total / 1024).toFixed(1) + 'KB）');
  });
});

test('home.js：各学科计数器值 = 全量重算值（数据源由 stats.json 供给）', function () {
  const stats = JSON.parse(fs.readFileSync(path.join(DATA, 'stats.json'), 'utf8'));
  const rec = recomputeStats();
  SUBJECTS.forEach((s) => {
    ['topics', 'edges', 'questions', 'standards'].forEach((k) => {
      assert.strictEqual(stats.subjects[s][k], rec.per[s][k], s + '.' + k + ' 与全量重算不一致');
    });
  });
});

test('home.js：各学科每张年级卡的条数（lite 分组）与全量一致', function () {
  const topics = JSON.parse(fs.readFileSync(TOPICS_PATH, 'utf8'));
  SUBJECTS.forEach((s) => {
    const lite = JSON.parse(fs.readFileSync(path.join(DATA, 'topics-lite', s + '.json'), 'utf8'));
    const full = topics.filter((t) => subjectOf(t) === s);
    const byGradeLite = {};
    const byGradeFull = {};
    lite.forEach((t) => { byGradeLite[t.grade] = (byGradeLite[t.grade] || 0) + 1; });
    full.forEach((t) => { byGradeFull[t.grade] = (byGradeFull[t.grade] || 0) + 1; });
    const grades = new Set(Object.keys(byGradeLite).concat(Object.keys(byGradeFull)));
    grades.forEach((g) => {
      assert.strictEqual(byGradeLite[g] || 0, byGradeFull[g] || 0,
        s + ' 年级 ' + g + ' 卡条数 lite ' + (byGradeLite[g] || 0) + ' ≠ 全量 ' + (byGradeFull[g] || 0));
    });
  });
});

/* ------------------------------------------------ H. 自检（checker 有效性） */

test('自检1：把 questions.json 注入 BOOT_FILES，预算 + 禁用串 checker 必须报红', function () {
  const bootFiles = extractBootFiles(HOME);
  const dirty = bootFiles.concat(['data/questions.json']);
  const scripts = firstPaintScripts(INDEX_HTML);
  const scriptGz = scripts.reduce((sum, s) => sum + gzipBytes(path.join(ROOT, s)), 0);
  let threw = false;
  try {
    checkBudget(scriptGz, expandBootFiles(dirty, 'math'));
  } catch (e) { threw = true; }
  assert.ok(threw, '注入 questions.json 后 checkBudget 必须抛错');
});

test('自检2：删掉某学科 lite 10 行，conservation checker 必须报红', function () {
  const lite = {};
  SUBJECTS.forEach((s) => { lite[s] = JSON.parse(fs.readFileSync(path.join(DATA, 'topics-lite', s + '.json'), 'utf8')); });
  const dirty = {};
  SUBJECTS.forEach((s) => { dirty[s] = s === 'math' ? lite[s].slice(10) : lite[s]; });
  let threw = false;
  try { checkLiteConservation(dirty); } catch (e) { threw = true; }
  assert.ok(threw, '删 10 行后 checkLiteConservation 必须报红');
});

console.log('\n' + (failed === 0 ? '全部通过' : '存在失败') + '：' + passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);