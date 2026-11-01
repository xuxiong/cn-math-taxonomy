#!/usr/bin/env node
/* 首屏载荷按学科拆分：把 data/ 下的几份大文件按学科 + 章节粒度的「轻量版」拆出来。
 *
 * 为什么拆：与 build-questions-split.mjs 同一个性能卡（C1/C2）的延续。页面打开时
 * 首屏会同时抢 topics.json(347KB gzip)、dependencies.json(114KB)、questions-index，
 * 而孩子只关心当前学段/学科。这里把「选题 / 统计 / 学科页」需要的最小数据按学科拆开，
 * 让首屏只取自己学科那份。
 *
 * 输出（相对 data/，--out-root 可写到别处）：
 *   stats.json                8 学科的统计汇总（topics/edges/questions/standards）
 *   topics-lite/<subject>.json    每学科轻量知识点（只留选题白名单字段）
 *   dependencies/<subject>.json   每学科先修关系（raw edges，字段原样）
 *   questions-index/<subject>.json 每学科题库索引（key 以 <subject>| 开头的子集）
 *   topics-detail/<slug>.json     每 (学科,年级,章节) 一文件，只含非空的重字段
 *
 * 约定（与 build-questions-split.mjs / build-topics-lite.mjs 一致，tests 会守）：
 *   - 幂等：同一份输入重复跑，输出字节完全一致（key 排序、字段顺序都不依赖随机/时间）；
 *   - 紧凑 JSON + 末尾换行；中文原样输出，不转 \uXXXX；
 *   - 8 学科固定顺序：math,english,physics,chinese,science,morality,history,geography；
 *   - 构建前清理每个输出目录里这一轮没产生的文件（残留会让离线缓存和测试都莫名其妙）；
 *   - data/ 下的原始大文件绝不动。
 *
 * 用法：
 *   node scripts/build-payload-split.mjs                        # 就地生成（默认）
 *   node scripts/build-payload-split.mjs --out-root /tmp/pl      # 写到别处（测试用，不碰仓库）
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { subjectOf, keyOf, slugOf, jsonText } from './build-questions-split.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const SUBJECTS = ['math', 'english', 'physics', 'chinese', 'science', 'morality', 'history', 'geography'];

/* 与 assets/home.js 的 subjectOfStd() 同一套规则：标准条目 id 前缀 → 学科，其余全算 math。 */
export function subjectOfStd(id) {
  const s = String(id || '');
  if (s.indexOf('ces-') === 0) return 'english';
  if (s.indexOf('cps-') === 0) return 'physics';
  if (s.indexOf('ccs-') === 0) return 'chinese';
  if (s.indexOf('css-') === 0) return 'science';
  if (s.indexOf('cds-') === 0) return 'morality';
  if (s.indexOf('chs-') === 0) return 'history';
  if (s.indexOf('cgs-') === 0) return 'geography';
  return 'math';
}

/* lite 白名单字段（固定顺序；数学无 subject 字段，不输出）。 */
const LITE_FIELDS = ['id', 'name', 'domain', 'grade', 'semester', 'chapter', 'type'];

/* topics-detail 的重字段（固定顺序；只在源值非空时才输出）。 */
const HEAVY_FIELDS = ['description', 'mastery_criteria', 'diagnostic_question', 'standards', 'root_reason', 'mathLinks'];

function isEmpty(v) {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

/* ------------------------------------------------------------ 各产物（纯函数，测试可复用） */

/** stats.json：8 学科固定顺序 + total。counts 来自各源文件。 */
export function buildStats(topics, deps, questions, topicsById, standards) {
  const per = {};
  SUBJECTS.forEach((s) => { per[s] = { topics: 0, edges: 0, questions: 0, standards: 0 }; });
  topics.forEach((t) => { per[subjectOf(t)].topics++; });
  deps.forEach((e) => { per[subjectOf({ id: e.topicId })].edges++; });
  questions.forEach((q) => {
    const t = q && topicsById.get(q.topicId);
    per[subjectOf(t || { id: q && q.topicId })].questions++;
  });
  (standards.items || []).forEach((item) => { per[subjectOfStd(item.id)].standards++; });
  const stats = { subjects: {} };
  const total = { topics: 0, edges: 0, questions: 0, standards: 0 };
  SUBJECTS.forEach((s) => {
    stats.subjects[s] = per[s];
    total.topics += per[s].topics;
    total.edges += per[s].edges;
    total.questions += per[s].questions;
    total.standards += per[s].standards;
  });
  stats.total = total;
  return stats;
}

/** topics-lite/<subject>.json：每学科只留 LITE_FIELDS，源顺序保留。 */
export function buildTopicsLite(topics) {
  const out = {};
  SUBJECTS.forEach((s) => { out[s] = []; });
  topics.forEach((t) => {
    const item = {};
    LITE_FIELDS.forEach((k) => { if (!isEmpty(t[k])) item[k] = t[k]; });
    out[subjectOf(t)].push(item);
  });
  return out;
}

/** dependencies/<subject>.json：topicId 属于该学科的 raw edges，字段原样、源顺序。 */
export function buildDependencies(deps, topicsById) {
  const out = {};
  SUBJECTS.forEach((s) => { out[s] = []; });
  deps.forEach((e) => {
    const s = subjectOf(topicsById.get(e.topicId) || { id: e.topicId });
    out[s].push(e);
  });
  return out;
}

/** questions-index/<subject>.json：key 以 <subject>| 开头的子集，值原样。 */
export function buildQuestionsIndex(index) {
  const out = {};
  SUBJECTS.forEach((s) => { out[s] = {}; });
  Object.keys(index).sort().forEach((key) => {
    const p = key.indexOf('|');
    const s = p < 0 ? '' : key.slice(0, p);
    if (SUBJECTS.indexOf(s) >= 0) out[s][key] = index[key];
  });
  return out;
}

/** topics-detail/<slug>.json：按 (学科,年级,章节) 分组，每文件只含非空重字段。
 *  返回 { files: {slug: [topic...]}, slugsMissing: [slug...] }。 */
export function buildTopicsDetail(topics, index) {
  const groups = new Map();
  topics.forEach((t) => {
    const key = keyOf(t);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  });
  const files = {};
  const slugsMissing = [];
  const values = new Set(Object.keys(index).map((k) => index[k]));
  groups.forEach((group) => {
    const list = [];
    group.forEach((t) => {
      const item = { id: t.id };
      HEAVY_FIELDS.forEach((k) => { if (!isEmpty(t[k])) item[k] = t[k]; });
      list.push(item);
    });
    const slug = slugOf(group[0]) + '.json';
    files[slug] = list;
    if (!values.has(slug)) slugsMissing.push(slug);
  });
  return { files, slugsMissing };
}

/* ------------------------------------------------------------ 写盘 + 统计 */
function writeJson(file, value) {
  fs.writeFileSync(file, jsonText(value));
}

function familyStats(files) {
  let raw = 0;
  let gz = 0;
  let maxGz = -1;
  let maxName = '';
  files.forEach(({ name, text }) => {
    const b = Buffer.byteLength(text);
    raw += b;
    const g = zlib.gzipSync(Buffer.from(text, 'utf8')).length;
    gz += g;
    if (g > maxGz) { maxGz = g; maxName = name; }
  });
  return { count: files.length, raw, gz, maxGz, maxName };
}

function cleanDir(dir, wanted) {
  if (!fs.existsSync(dir)) return 0;
  let removed = 0;
  fs.readdirSync(dir).forEach((name) => {
    if (wanted.has(name)) return;
    fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    removed++;
  });
  return removed;
}

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

function main() {
  const outRoot = arg('--out-root');
  const base = outRoot ? path.resolve(outRoot) : path.join(ROOT, 'data');

  const topics = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'topics.json'), 'utf8'));
  const deps = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'dependencies.json'), 'utf8'));
  const questions = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'questions.json'), 'utf8'));
  const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'questions-index.json'), 'utf8'));
  const standards = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'cn-curriculum-standards.json'), 'utf8'));

  const topicsById = new Map();
  topics.forEach((t) => { if (t && t.id) topicsById.set(t.id, t); });

  /* 守卫：四个总数必须精确匹配，否则说明数据源变了，直接停。 */
  const stats = buildStats(topics, deps, questions, topicsById, standards);
  const want = { topics: 2997, edges: 4456, questions: 12135, standards: 734 };
  Object.keys(want).forEach((k) => {
    if (stats.total[k] !== want[k]) {
      console.error(`build-payload-split: total.${k} = ${stats.total[k]}，期望 ${want[k]}，中止`);
      process.exit(1);
    }
  });

  const lite = buildTopicsLite(topics);
  const depsBySubj = buildDependencies(deps, topicsById);
  const qiBySubj = buildQuestionsIndex(index);
  const { files: detailFiles, slugsMissing } = buildTopicsDetail(topics, index);
  if (slugsMissing.length) {
    console.error(`build-payload-split: ${slugsMissing.length} 个 slug 在 questions-index.json 里不存在：`
      + slugsMissing.slice(0, 5).join(', ') + (slugsMissing.length > 5 ? ' …' : ''));
    process.exit(1);
  }

  /* stats.json（单文件，直接覆盖） */
  const statsPath = path.join(base, 'stats.json');
  fs.mkdirSync(path.dirname(statsPath), { recursive: true });
  const statsText = jsonText(stats);
  fs.writeFileSync(statsPath, statsText);

  /* topics-lite/ */
  const liteDir = path.join(base, 'topics-lite');
  const liteFiles = [];
  const liteWanted = new Set();
  fs.mkdirSync(liteDir, { recursive: true });
  SUBJECTS.forEach((s) => {
    const name = s + '.json';
    const text = jsonText(lite[s]);
    fs.writeFileSync(path.join(liteDir, name), text);
    liteWanted.add(name);
    liteFiles.push({ name: 'topics-lite/' + name, text });
  });

  /* dependencies/ */
  const depDir = path.join(base, 'dependencies');
  const depFiles = [];
  const depWanted = new Set();
  fs.mkdirSync(depDir, { recursive: true });
  SUBJECTS.forEach((s) => {
    const name = s + '.json';
    const text = jsonText(depsBySubj[s]);
    fs.writeFileSync(path.join(depDir, name), text);
    depWanted.add(name);
    depFiles.push({ name: 'dependencies/' + name, text });
  });

  /* questions-index/ */
  const qiDir = path.join(base, 'questions-index');
  const qiFiles = [];
  const qiWanted = new Set();
  fs.mkdirSync(qiDir, { recursive: true });
  SUBJECTS.forEach((s) => {
    const name = s + '.json';
    const text = jsonText(qiBySubj[s]);
    fs.writeFileSync(path.join(qiDir, name), text);
    qiWanted.add(name);
    qiFiles.push({ name: 'questions-index/' + name, text });
  });

  /* topics-detail/ */
  const dtDir = path.join(base, 'topics-detail');
  const dtFiles = [];
  const dtWanted = new Set();
  fs.mkdirSync(dtDir, { recursive: true });
  Object.keys(detailFiles).sort().forEach((name) => {
    const text = jsonText(detailFiles[name]);
    fs.writeFileSync(path.join(dtDir, name), text);
    dtWanted.add(name);
    dtFiles.push({ name: 'topics-detail/' + name, text });
  });

  /* 清理四目录里这一轮没产生的文件 */
  const removedLite = cleanDir(liteDir, liteWanted);
  const removedDep = cleanDir(depDir, depWanted);
  const removedQi = cleanDir(qiDir, qiWanted);
  const removedDt = cleanDir(dtDir, dtWanted);

  /* 汇总打印：每产物族 文件数 / 原始字节 / gzip 字节 / 最大单文件 gzip */
  const report = [
    ['stats', familyStats([{ name: 'stats.json', text: statsText }])],
    ['topics-lite', familyStats(liteFiles)],
    ['dependencies', familyStats(depFiles)],
    ['questions-index', familyStats(qiFiles)],
    ['topics-detail', familyStats(dtFiles)],
  ];
  console.log('payload-split 汇总（相对 data/）：');
  report.forEach(([fam, f]) => {
    console.log(`  ${fam.padEnd(16)} ${String(f.count).padStart(3)} 个文件`
      + `  原始 ${f.raw} B  gzip ${f.gz} B  最大单文件 ${f.maxGz} B（${f.maxName}）`);
  });
  console.log(`  清理陈旧文件：topics-lite ${removedLite}、dependencies ${removedDep}、`
    + `questions-index ${removedQi}、topics-detail ${removedDt}`);
  console.log(`  输出根：${base}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();