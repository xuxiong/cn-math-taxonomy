#!/usr/bin/env node
/* 详情说明审计：复刻 explore/app.js 的查找链，确认每个知识点都能取到非空 description。
 *
 * 查找链（与 explore/app.js 的 topicBundleKey 同构）：
 *   topics-lite/<subject>.json 的每条 topic
 *   → key = subject + '|' + String(topic.grade) + '|' + String(topic.chapter || '')
 *   → questions-index/<subject>.json[key] = <slug>.json
 *   → topics-detail/<slug>.json 里按 id 找条目
 *   → description 必须存在且不是空白字符串
 *
 * 同时把全部 data/topics-detail/*.json 扫一遍，统计所有包里缺 description / 空白
 * description 的条目（不只是被 lite 引用的那部分）。
 *
 * 用法：node scripts/audit-detail-descriptions.js
 * 全绿打印 OK；任何索引缺 key、bundle 缺条目、说明缺失/空白都打印 FAIL 并 exit 1。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const LITE_DIR = path.join(DATA, 'topics-lite');
const INDEX_DIR = path.join(DATA, 'questions-index');
const DETAIL_DIR = path.join(DATA, 'topics-detail');

const SAMPLE_LIMIT = 8;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function listJson(dir) {
  return fs.readdirSync(dir).filter(function (name) { return name.slice(-5) === '.json'; }).sort();
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isBlank(value) {
  return typeof value !== 'string' || value.trim() === '';
}

const issues = {
  indexMissing: [],
  bundleEntryMissing: [],
  descMissing: [],
  descBlank: [],
  missingFiles: new Set(),
  parseErrors: new Set()
};

/* 同 slug 只读一次；引用链和全库扫描共用。 */
const bundleCache = new Map();
function loadBundle(slug) {
  if (bundleCache.has(slug)) return bundleCache.get(slug);
  const file = path.join(DETAIL_DIR, slug);
  let entries = null;
  if (!fs.existsSync(file)) {
    issues.missingFiles.add(slug);
  } else {
    try {
      entries = readJson(file);
      if (!Array.isArray(entries)) entries = null;
    } catch (e) {
      entries = null;
    }
    if (!entries) issues.parseErrors.add(slug);
  }
  bundleCache.set(slug, entries);
  return entries;
}

function describe(topic, key, slug) {
  return {
    subject: topic.__subject,
    id: topic.id,
    key: key,
    slug: slug || '-'
  };
}

function pushSample(list, item) {
  if (list.length < SAMPLE_LIMIT) list.push(item);
}

/* ------------------------------------------------ 1. 复刻 app 的查找链 */

const subjectFiles = listJson(LITE_DIR);
let topicCount = 0;
const referencedSlugs = new Set();

subjectFiles.forEach(function (file) {
  const subject = file.slice(0, -5);
  const lite = readJson(path.join(LITE_DIR, file));
  const indexPath = path.join(INDEX_DIR, file);
  const index = fs.existsSync(indexPath) ? readJson(indexPath) : {};

  lite.forEach(function (topic) {
    topicCount++;
    topic.__subject = subject;
    /* 与 explore/app.js 的 topicBundleKey 同构 */
    const key = subject + '|' + String(topic.grade) + '|' + String((topic && topic.chapter) || '');
    if (!hasOwn(index, key)) {
      pushSample(issues.indexMissing, describe(topic, key, '-'));
      return;
    }
    const slug = index[key];
    referencedSlugs.add(slug);
    const entries = loadBundle(slug);
    if (!entries) return;

    let heavy = null;
    for (let i = 0; i < entries.length; i++) {
      if (entries[i] && entries[i].id === topic.id) { heavy = entries[i]; break; }
    }
    if (!heavy) {
      pushSample(issues.bundleEntryMissing, describe(topic, key, slug));
      return;
    }
    if (!hasOwn(heavy, 'description') || heavy.description == null) {
      pushSample(issues.descMissing, describe(topic, key, slug));
    } else if (isBlank(heavy.description)) {
      pushSample(issues.descBlank, describe(topic, key, slug));
    }
  });
});

/* ------------------------------------------------ 2. 全库 topics-detail 扫描 */

const detailFiles = listJson(DETAIL_DIR);
let detailEntries = 0;
let scanMissing = 0;
let scanBlank = 0;
let scanBadPacks = 0;
const scanSamples = [];
const scanBadPackDetails = [];

detailFiles.forEach(function (slug) {
  const entries = loadBundle(slug);
  if (!entries) return;
  let packMissing = 0;
  let packBlank = 0;
  entries.forEach(function (entry) {
    detailEntries++;
    if (!entry || !hasOwn(entry, 'description') || entry.description == null) {
      scanMissing++;
      packMissing++;
      if (scanSamples.length < SAMPLE_LIMIT) scanSamples.push({ slug: slug, id: entry && entry.id, kind: '缺失' });
    } else if (isBlank(entry.description)) {
      scanBlank++;
      packBlank++;
      if (scanSamples.length < SAMPLE_LIMIT) scanSamples.push({ slug: slug, id: entry.id, kind: '空白' });
    }
  });
  if (packMissing || packBlank) {
    scanBadPacks++;
    if (scanBadPackDetails.length < SAMPLE_LIMIT) {
      scanBadPackDetails.push({ slug: slug, missing: packMissing, blank: packBlank });
    }
  }
});

/* ------------------------------------------------ 3. 输出 */

function line(label, value) {
  console.log('  ' + label + '：' + value);
}

function printSamples(title, list, format) {
  if (!list.length) return;
  console.log('  ' + title + '（前 ' + list.length + ' 条）：');
  list.forEach(function (item) { console.log('    - ' + format(item)); });
}

console.log('详情说明审计（查找链与 explore/app.js 的 topicBundleKey 同构）');
console.log('');
line('学科数', subjectFiles.length);
line('知识点总数', topicCount);
line('全库 bundle 文件数', detailFiles.length);
line('唯一 bundle（被引用）', referencedSlugs.size);
line('唯一 bundle（全库）', detailFiles.length);
console.log('');
line('索引缺 key', issues.indexMissing.length);
line('bundle 文件缺失', issues.missingFiles.size);
line('bundle 解析失败', issues.parseErrors.size);
line('bundle 缺条目', issues.bundleEntryMissing.length);
line('description 缺失', issues.descMissing.length);
line('description 空白', issues.descBlank.length);
console.log('');
line('全库扫描条目数', detailEntries);
line('全库缺 description', scanMissing);
line('全库空白 description', scanBlank);
line('有问题的 bundle 数', scanBadPacks);

printSamples('索引缺 key', issues.indexMissing, function (x) {
  return x.subject + ' / ' + x.id + ' / ' + x.key;
});
printSamples('bundle 缺条目', issues.bundleEntryMissing, function (x) {
  return x.subject + ' / ' + x.id + ' / ' + x.key + ' → ' + x.slug;
});
printSamples('description 缺失', issues.descMissing, function (x) {
  return x.subject + ' / ' + x.id + ' / ' + x.key + ' → ' + x.slug;
});
printSamples('description 空白', issues.descBlank, function (x) {
  return x.subject + ' / ' + x.id + ' / ' + x.key + ' → ' + x.slug;
});
printSamples('全库扫描异常条目', scanSamples, function (x) {
  return x.slug + ' / ' + x.id + ' / ' + x.kind;
});
printSamples('有问题的 bundle', scanBadPackDetails, function (x) {
  return x.slug + ' / 缺 ' + x.missing + ' 条 / 空白 ' + x.blank + ' 条';
});

const failed = issues.indexMissing.length
  || issues.bundleEntryMissing.length
  || issues.descMissing.length
  || issues.descBlank.length
  || issues.missingFiles.size
  || issues.parseErrors.size
  || scanMissing
  || scanBlank;

console.log('');
if (failed) {
  console.log('FAIL：详情说明链路有缺口（见上）。');
  process.exit(1);
}
console.log('OK：所有被引用的知识点都能取到非空 description，全库 ' + detailFiles.length + ' 个 bundle 无缺说明条目。');
