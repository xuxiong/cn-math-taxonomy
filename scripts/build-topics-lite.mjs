#!/usr/bin/env node
/* 生成首屏用的知识点瘦身文件：data/topics.json → data/topics-lite.json
 *
 * 为什么要有它（线上 50KB/s 手机冷启动实测 29.2s / 32.4s）：
 *   首屏的选题界面只需要「名称 / 章节 / 学段 / 领域 / 类型」，
 *   但 topics.json 里 80% 的体积是 description / mastery_criteria /
 *   diagnostic_question / standards —— 这些只有进了详情、出题、课标对照才用。
 *   只保留白名单字段后：565KB 原文 → gzip 57KB（全量是 331KB）。
 *   剩下的字段由 diagnose/app.js 在选中知识点之后懒取全量 topics.json 补齐。
 *
 * 用法：
 *   node scripts/build-topics-lite.mjs                     # 就地生成 data/topics-lite.json
 *   node scripts/build-topics-lite.mjs --out /tmp/x.json    # 只写到别处（测试用，不碰仓库）
 *   node scripts/build-topics-lite.mjs --in  a.json --out b.json
 *
 * 约定（tests/test_data_split.js 会守）：
 *   - 白名单之外一个字段都不留；空值字段直接省掉（不输出 "subject": ""）；
 *   - JSON.stringify(..., null, 0) 紧凑格式（省字节），中文不转义（JSON.stringify 本就不转义）；
 *   - 幂等：同一份输入重复跑，输出字节完全一致（字段按固定顺序写、不依赖随机/时间）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 首屏白名单：字段顺序固定，保证输出字节稳定。 */
export const LITE_FIELDS = ['id', 'name', 'domain', 'grade', 'semester', 'chapter', 'type', 'subject'];

/** 空值判据：null / undefined / 空串 / 空数组 都不写进 lite。 */
function isEmpty(v) {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

/** 单条知识点 → 瘦身对象（只留白名单字段，空值省掉）。 */
export function toLite(topic) {
  const out = {};
  LITE_FIELDS.forEach((k) => {
    if (!Object.prototype.hasOwnProperty.call(topic, k)) return;
    const v = topic[k];
    if (isEmpty(v)) return;
    out[k] = v;
  });
  return out;
}

/** 整个数组 → 紧凑 JSON 文本（末尾带一个换行，便于 git 显示）。 */
export function buildLiteText(topics) {
  if (!Array.isArray(topics)) throw new Error('topics 必须是数组');
  return JSON.stringify(topics.map(toLite), null, 0) + '\n';
}

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const inPath = path.resolve(arg('--in') || path.join(ROOT, 'data', 'topics.json'));
  const outPath = path.resolve(arg('--out') || path.join(ROOT, 'data', 'topics-lite.json'));
  const topics = JSON.parse(fs.readFileSync(inPath, 'utf8'));
  const text = buildLiteText(topics);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, text);
  console.log(`topics-lite: ${topics.length} 条 → ${outPath}（${Buffer.byteLength(text)} 字节）`);
}
