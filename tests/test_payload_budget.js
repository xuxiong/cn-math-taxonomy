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
const SUBJECTS = ['math', 'english', 'physics', 'chinese', 'science', 'morality', 'history', 'geography', 'biology', 'chemistry'];
const LITE_FIELDS = ['id', 'name', 'domain', 'grade', 'semester', 'chapter', 'type'];
const HEAVY_FIELDS = ['description', 'mastery_criteria', 'diagnostic_question', 'standards', 'root_reason', 'mathLinks'];
const FORBIDDEN = ['questions.json', 'data/topics.json', 'dependencies.json', 'cn-curriculum-standards'];
const BUDGET_LIMIT = 80 * 1024;

/* 每页首屏请求数上限（文档 + 同源子资源 + 首屏数据）。
 * 字节预算管不住「把字节拆小了、把往返拆多了」：300ms RTT 下多 3 个往返 ≈ 0.9s，
 * 而多 20KB 在 8~10KB/s 的链路上虽要 2s、但可与其它请求并行 —— 两条线都要守，否则把某个
 * 脚本再拆成两个文件没人拦得住（用户明确要求过：超一点字节对性能影响不大，多次往返也耗时）。
 * 口径：文档 1 + 首屏同源 <script src>（data-lazy 的运行期注入不计）+ <link rel=stylesheet>
 *       + manifest/apple-touch-icon + BOOT_FILES 展开后的首屏数据。
 *       数据份数按默认学科 math 计（home/diagnose 各学科同数；explore 的 physics 见「已知偏差」用例）。 */
const REQ_CAP = { home: 13, explore: 14, diagnose: 17 };

const DATA = path.join(ROOT, 'data');
const TOPICS_PATH = path.join(DATA, 'topics.json');
const DEPS_PATH = path.join(DATA, 'dependencies.json');
const QUESTIONS_PATH = path.join(DATA, 'questions.json');
const QI_PATH = path.join(DATA, 'questions-index.json');
const STD_PATH = path.join(DATA, 'cn-curriculum-standards.json');
const HOME = fs.readFileSync(path.join(ROOT, 'assets', 'home.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const EXPLORE_APP = fs.readFileSync(path.join(ROOT, 'explore', 'app.js'), 'utf8');
const EXPLORE_HTML = fs.readFileSync(path.join(ROOT, 'explore', 'index.html'), 'utf8');

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
  if (id.indexOf('cnb_') === 0) return 'biology';
  if (id.indexOf('cnk_') === 0) return 'chemistry';
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
  if (id.indexOf('cbs-') === 0) return 'biology';
  if (id.indexOf('cks-') === 0) return 'chemistry';
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
  const wantTotal = { topics: 3297, edges: 4868, questions: 13335, standards: 786 };
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

test('stats.json：total 固定 3297/4868/13335/786，各学科与全量重算一致、求和等于 total', function () {
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

/** 首屏脚本集合（index.html 里同源的 <script src>，defer 也计入——defer 仍在开机就下载，
 *  同样占首屏带宽。只有带 data-lazy（页面运行期才注入的脚本）的不计）。
 *  8-10KB/s 链路：任何同源 <script src> 都是首绘的一部分，没有豁免。 */
function firstPaintScripts(html) {
  const out = [];
  const re = /<script\b([^>]*)\bsrc="([^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] || '';
    if (/\bdata-lazy\b/.test(attrs)) continue;
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

test('index.html：同源首屏脚本恰好是 children/blindspots/home/stats-config/stats/pwa 六件（defer 也计入）', function () {
  const scripts = firstPaintScripts(INDEX_HTML);
  assert.deepStrictEqual(scripts,
    ['assets/blindspots.js', 'assets/children.js', 'assets/home.js', 'assets/pwa.js', 'assets/stats-config.js', 'assets/stats.js'],
    '首屏脚本集合应为这六个，新增首屏脚本必须过预算关：' + scripts.join(','));
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

test('index.html：首页首屏请求数 ≤ 13（文档 + 6 脚本 + 2 样式 + manifest/图标 + 2 份数据）', function () {
  const htmlPath = path.join(ROOT, 'index.html');
  const bootFiles = expandBootFiles(extractBootFiles(HOME), 'math');
  const n = assertReqCap('首页', htmlPath, bootFiles, REQ_CAP.home);
  console.log('    index.html 首屏请求数 ' + n + ' / 上限 ' + REQ_CAP.home);
  assert.strictEqual(n, REQ_CAP.home, '首页首屏请求数应按实算为 ' + REQ_CAP.home + '（口径变了请同步改这条断言）');
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

/* ------------------------------------------------ G2. explore（知识图谱）首屏预算 */

const EXPLORE_SCRIPTS = firstPaintScripts(EXPLORE_HTML);
const EXPLORE_SCRIPT_GZ = EXPLORE_SCRIPTS.reduce((sum, s) => sum + gzipBytes(exploreAssetPath(s)), 0);

/** explore 的 BOOT_FILES 用的是相对 explore/ 的 '../data/...'，这里归一成 data/ 再取 gzip。 */
function dataPath(p) {
  return path.join(ROOT, p.replace(/^\.\.\//, ''));
}

/** explore/index.html 的脚本 src：'../assets/...' 相对站点根，'app.js' 相对 explore/ 目录。 */
function exploreAssetPath(s) {
  if (s.indexOf('../') === 0) return path.join(ROOT, s.slice(3));
  return path.join(ROOT, 'explore', s);
}

/** 展开 explore BOOT_FILES：物理额外补一份数学 lite（mathLinks 名字用）。 */
function expandExploreBootFiles(bootFiles, subject) {
  const files = bootFiles.map((p) => p.replace('{subject}', subject));
  if (subject === 'physics') files.push('../data/topics-lite/math.json');
  return files;
}

/* ------------------------------------------------ 请求数口径：每页首屏请求数（文档 + 同源子资源 + 首屏数据） */

/* 上限常量 REQ_CAP 定义在文件顶部（BUDGET_LIMIT 旁边）——本段只放计数与断言辅助函数，
 * 因为顶层 test(...) 是按书写顺序执行的，const 在用到之后才初始化会触发 TDZ。 */

/** 从 HTML 里抽出同源子资源：scripts（跳过 data-lazy 与跨域/data:）、stylesheets、manifest/图标。 */
function subresources(html) {
  const scripts = [];
  const styles = [];
  const misc = [];
  const sre = /<script\b([^>]*)\bsrc="([^"]+)"/g;
  let m;
  while ((m = sre.exec(html)) !== null) {
    const attrs = m[1] || '';
    const src = m[2];
    if (/\bdata-lazy\b/.test(attrs)) continue;
    if (/^(https?:)?\/\//.test(src) || src.indexOf('data:') === 0) continue;
    scripts.push(src);
  }
  const lre = /<link\b([^>]*)>/g;
  while ((m = lre.exec(html)) !== null) {
    const href = /href="([^"]+)"/.exec(m[1]);
    const rel = /rel="([^"]+)"/.exec(m[1]);
    if (!href || !rel) continue;
    const h = href[1];
    if (/^(https?:)?\/\//.test(h) || h.indexOf('data:') === 0) continue;
    if (/stylesheet/.test(rel[1])) styles.push(h);
    else if (/manifest|icon/.test(rel[1])) misc.push(h);
  }
  return { scripts, styles, misc };
}

/** 一页首屏请求明细：一个请求一行，失败信息里据此指出是谁超的。
 *  extra 可以是数组（逐个列出「列表之后才取」的模块）或数字（只计数）。 */
function requestDetail(htmlPath, dataFiles, extra) {
  const refs = subresources(fs.readFileSync(htmlPath, 'utf8'));
  const rel = path.relative(ROOT, htmlPath);
  const docLabel = rel.startsWith('..') ? htmlPath : rel;
  const lines = ['文档      ' + docLabel];
  refs.scripts.forEach((s) => lines.push('脚本      ' + s));
  refs.styles.forEach((s) => lines.push('样式      ' + s));
  refs.misc.forEach((s) => lines.push('清单/图标  ' + s));
  dataFiles.forEach((p) => lines.push('数据      ' + p));
  if (Array.isArray(extra)) extra.forEach((m) => lines.push('列表后    ' + m));
  else if (extra > 0) lines.push('列表后    ×' + extra + ' 个辅助模块');
  return lines;
}

/** 一页首屏请求数（文档算一个）：
 *  1 + 首屏脚本 + 样式 + manifest/图标 + 首屏数据 + extra（数组取长度，数字直接用）。 */
function pageRequests(htmlPath, dataFiles, extra) {
  const refs = subresources(fs.readFileSync(htmlPath, 'utf8'));
  const n = Array.isArray(extra) ? extra.length : (extra || 0);
  return 1 + refs.scripts.length + refs.styles.length + refs.misc.length + dataFiles.length + n;
}

/** 请求数上限断言：失败信息带「实际 N / 上限 M / 超出几个 / 逐个请求明细」。 */
function assertReqCap(label, htmlPath, dataFiles, cap, extra) {
  const n = pageRequests(htmlPath, dataFiles, extra);
  const detail = requestDetail(htmlPath, dataFiles, extra);
  assert.ok(n <= cap,
    label + ' 首屏请求数 ' + n + ' / 上限 ' + cap + '（超出 ' + (n - cap) + ' 个）\n       明细：\n         '
      + detail.join('\n         '));
  return n;
}

/** explore 预算检查器：给定首屏脚本 gzip + 一份 BOOT_FILES 展开文件，断言 gzip 与禁用串。 */
function checkExploreBudget(bootFiles, scriptGz, subject) {
  let total = scriptGz;
  expandExploreBootFiles(bootFiles, subject).forEach((p) => {
    FORBIDDEN.forEach((needle) => {
      assert.ok(p.indexOf(needle) < 0, 'explore 首屏数据引用了禁用的数据文件：' + p);
    });
    assert.ok(p.startsWith('../data/'), 'explore BOOT_FILES 只能含 ../data/ 下的同源文件：' + p);
    total += gzipBytes(dataPath(p));
  });
  assert.ok(total <= BUDGET_LIMIT, subject + ' explore 首屏 gzip ' + total + 'B 超过预算 ' + BUDGET_LIMIT + 'B（' + (total / 1024).toFixed(1) + 'KB）');
  return total;
}

/** explore 守恒检查器：逐学科 lite 条数=全量过滤；边按 app 的 allow 过滤后=全量过滤；总数固定。 */
function checkExploreConservation(liteBySubject, depsBySubject) {
  const topics = JSON.parse(fs.readFileSync(TOPICS_PATH, 'utf8'));
  const depsAll = JSON.parse(fs.readFileSync(DEPS_PATH, 'utf8'));
  const byId = new Map();
  topics.forEach((t) => { if (t && t.id) byId.set(t.id, t); });
  let nodes = 0;
  let edges = 0;
  SUBJECTS.forEach((s) => {
    const lite = liteBySubject[s];
    assert.ok(Array.isArray(lite), '缺学科 ' + s + ' 的 lite 数组');
    const fullCount = topics.filter((t) => subjectOf(t) === s).length;
    assert.strictEqual(lite.length, fullCount, s + ' explore lite 条数 ' + lite.length + ' ≠ 全量过滤 ' + fullCount);
    nodes += lite.length;
    /* 复刻 explore/app.js 的 load()：allow = 本学科全部 lite id，边两端都命中才算。 */
    const allow = {};
    lite.forEach((t) => { allow[t.id] = true; });
    const arr = depsBySubject[s];
    assert.ok(Array.isArray(arr), '缺学科 ' + s + ' 的边数组');
    const appDeps = arr.filter((e) => allow[e.topicId] && allow[e.prerequisiteId]);
    const expect = filterBySubject(depsAll, s, byId).filter((e) => allow[e.topicId] && allow[e.prerequisiteId]);
    assert.deepStrictEqual(appDeps, expect, s + ' explore 边（allow 过滤后）应等于全量过滤结果');
    edges += appDeps.length;
  });
  assert.strictEqual(nodes, 3297, 'explore 各学科 lite 节点和应为 3297，实际 ' + nodes);
  assert.strictEqual(edges, 4868, 'explore 各学科边和应为 4868，实际 ' + edges);
}

test('explore/index.html：同源首屏脚本恰好是 app/stats-config/stats/pwa/lazyload 五件（无渲染库 vendor）', function () {
  assert.deepStrictEqual(EXPLORE_SCRIPTS,
    ['../assets/pwa.js', '../assets/stats-config.js', '../assets/stats.js', '../diagnose/lazyload.js', 'app.js'],
    'explore 首屏脚本应为这五个，渲染库必须移除：' + EXPLORE_SCRIPTS.join(','));
});

test('explore/app.js：BOOT_FILES 清单正确，逐学科首屏 gzip ≤ 80KB', function () {
  const bootFiles = extractBootFiles(EXPLORE_APP);
  assert.deepStrictEqual(bootFiles,
    ['../data/topics-lite/{subject}.json', '../data/dependencies/{subject}.json', '../data/id-aliases.json'],
    'explore BOOT_FILES 应为 topics-lite + dependencies + id-aliases（保留 {subject} 字面量）');
  let maxGz = -1;
  SUBJECTS.forEach((s) => {
    const total = checkExploreBudget(bootFiles, EXPLORE_SCRIPT_GZ, s);
    if (total > maxGz) maxGz = total;
    console.log('    explore ' + s.padEnd(9) + ' 首屏 gzip ' + (total / 1024).toFixed(1) + ' KB');
  });
  assert.ok(maxGz >= 0, 'explore 首屏为空');
});

const EXPLORE_HTML_PATH = path.join(ROOT, 'explore', 'index.html');

test('explore/index.html：图谱页首屏请求数 ≤ 14（文档 + 5 脚本 + 3 样式 + manifest/图标 + 3 份数据）', function () {
  const bootFiles = expandExploreBootFiles(extractBootFiles(EXPLORE_APP), 'math')
    .map((p) => p.replace(/^\.\.\//, ''));
  const n = assertReqCap('图谱页', EXPLORE_HTML_PATH, bootFiles, REQ_CAP.explore);
  console.log('    explore/index.html 首屏请求数 ' + n + ' / 上限 ' + REQ_CAP.explore);
  assert.strictEqual(n, REQ_CAP.explore, '图谱页首屏请求数应按实算为 ' + REQ_CAP.explore + '（口径变了请同步改这条断言）');
});

test('explore：physics 多取一份 math lite（15 = 上限 14 + 1）是已知偏差，再涨一个就报红', function () {
  /* explore/app.js load() 里 physics 额外 push 一份 '../data/topics-lite/math.json'（mathLinks 取数学名字），
   * 所以 physics 页首屏 15 个请求 > 上限 14。**这不是放宽上限**：上限仍是 14，
   * 只是把「已知的 +1」钉死在这里 —— 长到 +2 会立刻报红；哪天额外那份拆掉了，也应改回 ≤ 上限。 */
  const bootFiles = expandExploreBootFiles(extractBootFiles(EXPLORE_APP), 'physics')
    .map((p) => p.replace(/^\.\.\//, ''));
  const n = pageRequests(EXPLORE_HTML_PATH, bootFiles);
  console.log('    explore physics 首屏请求数 ' + n + ' / 上限 ' + REQ_CAP.explore + '（多出 data/topics-lite/math.json）');
  assert.strictEqual(n, REQ_CAP.explore + 1,
    'explore physics 首屏请求数应恰为上限+1（超出项：physics 额外取的 data/topics-lite/math.json），实际 ' + n
      + '：\n         ' + requestDetail(EXPLORE_HTML_PATH, bootFiles).join('\n         '));
});

test('explore/app.js：不再首屏 fetch 全量 topics/dependencies/questions，课标只在懒加载路径出现一次', function () {
  ['../data/questions.json', '../data/topics.json', '../data/dependencies.json'].forEach((needle) => {
    assert.ok(EXPLORE_APP.indexOf(needle) < 0, 'explore/app.js 不应再 fetch 全量文件：' + needle);
  });
  const stdRefs = EXPLORE_APP.split('../data/cn-curriculum-standards.json').length - 1;
  assert.strictEqual(stdRefs, 1, '课标文件应在 app.js 只出现一次（懒加载路径），实际 ' + stdRefs);
  extractBootFiles(EXPLORE_APP).forEach((p) => {
    assert.ok(p.indexOf('cn-curriculum-standards') < 0, '课标不应在 BOOT_FILES 里：' + p);
  });
});

test('explore 守恒：逐学科 lite 条数=全量过滤，边（allow 过滤后）=全量过滤，总数 3297/4868', function () {
  const lite = {};
  const dep = {};
  SUBJECTS.forEach((s) => {
    lite[s] = JSON.parse(fs.readFileSync(path.join(DATA, 'topics-lite', s + '.json'), 'utf8'));
    dep[s] = JSON.parse(fs.readFileSync(path.join(DATA, 'dependencies', s + '.json'), 'utf8'));
  });
  checkExploreConservation(lite, dep);
});

test('explore 渲染库：index.html 无 vendor 脚本，app.js 用 Lazy.load 懒加载三个 vendor', function () {
  ['assets/vendor/cytoscape.min.js', 'assets/vendor/dagre.min.js', 'assets/vendor/cytoscape-dagre.js'].forEach((v) => {
    assert.ok(EXPLORE_HTML.indexOf(v) < 0, 'explore/index.html 不应再直接引用 ' + v);
  });
  assert.ok(EXPLORE_HTML.indexOf('../diagnose/lazyload.js') >= 0, 'explore/index.html 应引入 ../diagnose/lazyload.js');
  assert.ok(/Lazy\.load\(\s*\[/.test(EXPLORE_APP), 'explore/app.js 应调用 Lazy.load 数组形式');
  ['../assets/vendor/cytoscape.min.js', '../assets/vendor/dagre.min.js', '../assets/vendor/cytoscape-dagre.js'].forEach((v) => {
    assert.ok(EXPLORE_APP.indexOf(v) >= 0, 'explore/app.js 应通过 Lazy.load 引用 ' + v);
  });
});

/* ------------------------------------------------ G3. diagnose（诊断入口）首屏请求数 */

const DIAG_DIR = path.join(ROOT, 'diagnose');
const DIAG_HTML_PATH = path.join(DIAG_DIR, 'index.html');
const DIAG_HTML = fs.readFileSync(DIAG_HTML_PATH, 'utf8');
const DIAG_APP = fs.readFileSync(path.join(DIAG_DIR, 'app.js'), 'utf8');

/** 列表画完之后才补取的辅助模块（孩子档案 / 薄弱点 / LLM 配置 / 统计 / PWA）：
 *  它们仍然是首屏这一段要付的往返，所以算进请求数（但不进入口字节预算）。 */
function diagDeferredModules() {
  const calls = DIAG_APP.match(/Lazy\.load\(\[[\s\S]*?\]\)/g) || [];
  const aux = calls.filter((c) => c.indexOf('children.js') >= 0)[0];
  assert.ok(aux, 'diagnose/app.js 里应有「列表之后」补取辅助模块的 Lazy.load([...])');
  const items = aux.match(/'([^']+)'/g) || [];
  assert.ok(items.length > 0, '辅助模块清单不应为空');
  return items.map((s) => s.slice(1, -1));
}

test('diagnose/index.html：入口首屏请求数 ≤ 17（文档 + 3 脚本 + 3 样式 + manifest/图标 + 2 份数据 + 列表后 6 个辅助模块）', function () {
  const bootFiles = expandBootFiles(extractBootFiles(DIAG_APP), 'math')
    .map((p) => p.replace(/^\.\.\//, ''));
  const deferred = diagDeferredModules();
  const n = assertReqCap('诊断入口', DIAG_HTML_PATH, bootFiles, REQ_CAP.diagnose, deferred);
  console.log('    diagnose/index.html 首屏请求数 ' + n + ' / 上限 ' + REQ_CAP.diagnose
    + '（其中列表之后补取 ' + deferred.length + ' 个）');
  assert.strictEqual(n, REQ_CAP.diagnose, '诊断入口首屏请求数应按实算为 ' + REQ_CAP.diagnose + '（口径变了请同步改这条断言）');
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

test('自检3：把 questions.json 注入 explore BOOT_FILES，预算 checker 必须报红', function () {
  const bootFiles = extractBootFiles(EXPLORE_APP);
  const dirty = bootFiles.concat(['../data/questions.json']);
  let threw = false;
  try { checkExploreBudget(dirty, EXPLORE_SCRIPT_GZ, 'math'); } catch (e) { threw = true; }
  assert.ok(threw, '注入 questions.json 后 checkExploreBudget 必须抛错');
});

test('自检4：删掉某学科 dependencies 10 行，explore conservation checker 必须报红', function () {
  const lite = {};
  const dep = {};
  SUBJECTS.forEach((s) => {
    lite[s] = JSON.parse(fs.readFileSync(path.join(DATA, 'topics-lite', s + '.json'), 'utf8'));
    dep[s] = JSON.parse(fs.readFileSync(path.join(DATA, 'dependencies', s + '.json'), 'utf8'));
  });
  const dirty = {};
  SUBJECTS.forEach((s) => { dirty[s] = s === 'math' ? dep[s].slice(10) : dep[s]; });
  let threw = false;
  try { checkExploreConservation(lite, dirty); } catch (e) { threw = true; }
  assert.ok(threw, '删 10 行后 checkExploreConservation 必须报红');
});

test('自检5：给首页硬塞一个首屏脚本，请求数上限必须报红（防止拆碎了字节却拆多了往返）', function () {
  const dirty = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
    .replace('</head>', '<script src="assets/extra.js"></script></head>');
  assert.ok(dirty.indexOf('assets/extra.js') >= 0, '构造的脏 HTML 里应含 assets/extra.js');
  const bootFiles = expandBootFiles(extractBootFiles(HOME), 'math');
  const tmp = path.join(os.tmpdir(), 'cnm-reqcap-extra-home.html');
  fs.writeFileSync(tmp, dirty);
  try {
    /* 一、先证明它真的多算了一个请求（13 → 14）：若 pageRequests 漏数脚本，这里就报红 */
    const n = pageRequests(tmp, bootFiles);
    assert.strictEqual(n, REQ_CAP.home + 1,
      '多塞一个首屏脚本后请求数应为 ' + (REQ_CAP.home + 1) + '，实际 ' + n);
    /* 二、再用真上限断言跑一遍：必须抛错（上限形同虚设时不会抛 → 本自检报红） */
    let threw = false;
    try { assertReqCap('首页(脏)', tmp, bootFiles, REQ_CAP.home); } catch (e) { threw = true; }
    assert.ok(threw, '首屏多一个脚本后 assertReqCap 必须报红，实际没报');
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

test('自检6：把 engine.js 塞回诊断页首屏脚本链，首屏脚本集合断言必须报红', function () {
  const dirty = DIAG_HTML.replace('<script src="app.js"></script>',
    '<script src="app.js"></script>\n<script src="engine.js"></script>');
  assert.ok(dirty !== DIAG_HTML, '诊断页 HTML 里应能找到 <script src="app.js"></script> 锚点');
  const scripts = firstPaintScripts(dirty);
  assert.ok(scripts.indexOf('engine.js') >= 0, '构造的脏 HTML 应含 engine.js');
  let threw = false;
  try {
    assert.deepStrictEqual(scripts, ['app.js', 'chapter.js', 'lazyload.js'],
      '诊断入口首屏脚本应只有这三件：' + scripts.join(','));
  } catch (e) { threw = true; }
  assert.ok(threw, 'engine.js 回到首屏后，首屏脚本集合断言必须报红，实际没报');
});

console.log('\n' + (failed === 0 ? '全部通过' : '存在失败') + '：' + passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);