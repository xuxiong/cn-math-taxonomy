#!/usr/bin/env node
/* 题库按章节拆分：data/questions.json（唯一真源） → data/questions/<slug>.json + data/questions-index.json
 *
 * 为什么拆（已实测，见卡 t_e855de2f）：
 *   questions.json 单文件 7657KB 原文 / 1164KB gzip，12135 题。孩子只做 1 个知识点的题，
 *   却要下整份 1164KB；sw.js 还把它整个预热，慢网下和首屏、和正在做的题抢带宽。
 *   三种粒度实测（中位/p90/最大）：按学科 85/213/224KB、按章节 1.5/2.9/6.0KB、按知识点 0.7/1.0/4.7KB。
 *   选按章节：正好对齐界面的两个单位（单点 / 整章），比知识点粒度只大 0.8KB 却少发几十个请求。
 *
 * 输出：
 *   data/questions/<subject>__<grade>__<sha1(chapter) 前 10 位>.json   每章节一个 bundle
 *   data/questions-index.json   {"<subject>|<grade>|<chapter>": "<slug>.json", ...}
 *
 * 约定（tests/test_questions_split.js 会守）：
 *   - slug 纯 ASCII 且确定：章节名可能是中文，不能直接当文件名；也不依赖运行环境的编码/顺序；
 *   - 幂等：同一份输入重复跑，输出字节完全一致（key 排序、字段顺序都不依赖随机/时间）；
 *   - 构建前清理 data/questions/ 下不再需要的文件（残留会让离线缓存和测试都莫名其妙）；
 *   - 每个 bundle 内的题目顺序 = 输入 questions.json 里的相对顺序（便于 diff 和复现）。
 *
 * 用法：
 *   node scripts/build-questions-split.mjs                       # 就地生成（默认）
 *   node scripts/build-questions-split.mjs --out-dir /tmp/q       # 写到别处（测试用，不碰仓库）
 *   node scripts/build-questions-split.mjs --in q.json --topics t.json
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/* 与 diagnose/engine.js 的 subjectOf() 同一套规则（数学没有 subject 字段，按 id 前缀 / 默认值推）。
 * 这里独立实现一份：构建脚本不依赖浏览器 UMD 模块，测试也用它反向核对。 */
export function subjectOf(topic) {
  const s = topic && topic.subject;
  if (s === 'english' || s === 'math' || s === 'physics' || s === 'chinese'
    || s === 'science' || s === 'morality' || s === 'history' || s === 'geography') return s;
  const id = String((topic && topic.id) || '');
  if (id.indexOf('cne_') === 0) return 'english';
  if (id.indexOf('cnp_') === 0) return 'physics';
  if (id.indexOf('cnc_') === 0) return 'chinese';
  if (id.indexOf('cns_') === 0) return 'science';
  if (id.indexOf('cnd_') === 0) return 'morality';
  if (id.indexOf('cnh_') === 0) return 'history';
  if (id.indexOf('cng_') === 0) return 'geography';
  return 'math';
}

/** (学科,年级,章节) → index 的 key。grade 统一转字符串（数据里可能是数字 1 或 '七年级'）。 */
export function keyOf(topic) {
  const grade = topic && topic.grade != null && topic.grade !== '' ? String(topic.grade) : '';
  return subjectOf(topic) + '|' + grade + '|' + String((topic && topic.chapter) || '');
}

/** key → 纯 ASCII 的 slug：<subject>__<grade 的 ascii 化>__<sha1(key 的章节部分) 前 10 位>。
 *  chapter 用 sha1 缩到 10 位十六进制：中文不能当文件名，但 hash 是纯 ASCII 且与编码无关（按 UTF-8 取字节）。 */
export function slugOf(topic) {
  const subject = subjectOf(topic);
  const grade = topic && topic.grade != null && topic.grade !== '' ? String(topic.grade) : 'na';
  const chapter = String((topic && topic.chapter) || '');
  const h = crypto.createHash('sha1').update(chapter, 'utf8').digest('hex').slice(0, 10);
  return sanitize(subject) + '__' + sanitize(grade) + '__' + h;
}

/** slug 片段只留 [a-z0-9-]：其它字符（中文年级名之类）也一并转成 - 连接的 ascii。 */
function sanitize(s) {
  const ascii = String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return ascii || 'na';
}

/* ------------------------------------------------------------ 纯函数层（测试可直接 import 复用） */

/** questions + topics → { index: {key: '<slug>.json'}, bundles: {key: [question...]} }。
 *  题目顺序严格按输入顺序；没有对应 topic 的题（脏数据）直接丢掉并在摘要里报数。 */
export function splitQuestions(questions, topics) {
  if (!Array.isArray(questions)) throw new Error('questions 必须是数组');
  if (!Array.isArray(topics)) throw new Error('topics 必须是数组');
  const byId = new Map();
  topics.forEach((t) => { if (t && t.id) byId.set(t.id, t); });
  const bundles = new Map();
  const index = {};
  let orphan = 0;
  questions.forEach((q) => {
    const t = q && byId.get(q.topicId);
    if (!t) { orphan++; return; }
    const key = keyOf(t);
    let b = bundles.get(key);
    if (!b) {
      b = [];
      bundles.set(key, b);
      index[key] = slugOf(t) + '.json';
    }
    b.push(q);
  });
  /* key 排序固定：输出字节与遍历顺序无关，重复跑必然一致 */
  const keys = Array.from(bundles.keys()).sort();
  const sortedBundles = {};
  const sortedIndex = {};
  keys.forEach((k) => { sortedBundles[k] = bundles.get(k); sortedIndex[k] = index[k]; });
  return { index: sortedIndex, bundles: sortedBundles, orphan };
}

/** 紧凑 JSON 文本（中文不转义 + 末尾一个换行，便于 git 显示）。字段顺序沿用输入对象。 */
export function jsonText(value) {
  return JSON.stringify(value) + '\n';
}

/* ------------------------------------------------------------ CLI */
function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

function main() {
  const inPath = path.resolve(arg('--in') || path.join(ROOT, 'data', 'questions.json'));
  const topicsPath = path.resolve(arg('--topics') || path.join(ROOT, 'data', 'topics.json'));
  const outDir = path.resolve(arg('--out-dir') || path.join(ROOT, 'data', 'questions'));
  const indexPath = path.resolve(arg('--index') || path.join(ROOT, 'data', 'questions-index.json'));

  const questions = JSON.parse(fs.readFileSync(inPath, 'utf8'));
  const topics = JSON.parse(fs.readFileSync(topicsPath, 'utf8'));
  const { index, bundles, orphan } = splitQuestions(questions, topics);

  fs.mkdirSync(outDir, { recursive: true });

  /* 先写新文件（覆盖同名），再删掉这一轮不需要的残留：
   * 反序做（先写后删）可以保证中途失败也不会把 index 指向的文件删掉一半。 */
  const wanted = new Set();
  let total = 0;
  let maxBytes = 0;
  let maxFile = '';
  Object.keys(bundles).sort().forEach((key) => {
    const name = index[key];
    const text = jsonText(bundles[key]);
    fs.writeFileSync(path.join(outDir, name), text);
    wanted.add(name);
    total += bundles[key].length;
    const bytes = Buffer.byteLength(text);
    if (bytes > maxBytes) { maxBytes = bytes; maxFile = name; }
  });

  let removed = 0;
  fs.readdirSync(outDir).forEach((name) => {
    if (wanted.has(name)) return;
    fs.rmSync(path.join(outDir, name), { recursive: true, force: true });
    removed++;
  });

  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  fs.writeFileSync(indexPath, jsonText(index));

  if (orphan) console.warn(`⚠ ${orphan} 道题的 topicId 在 topics.json 里查不到，已跳过`);
  console.log(`questions-split: ${Object.keys(bundles).length} 个 bundle、${total} 题、`
    + `最大文件 ${maxBytes} 字节（${maxFile}）、清理 ${removed} 个陈旧文件`);
  console.log(`  输出：${outDir}`);
  console.log(`  索引：${indexPath}（${Buffer.byteLength(jsonText(index))} 字节）`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
