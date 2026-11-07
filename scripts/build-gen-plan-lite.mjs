#!/usr/bin/env node
/* 前端出题工单轻量包：tmp/gap-plan.json → data/gen-plan.json（卡 E / t_0772253d）
 *
 * 为什么要有这一层：
 *   卡 C 的参数化管线（llm-recipes / llm-gates / llm-gen）吃的是 plan 条目 ——
 *   strategy / verifier / prereqClosure / descendants。plan 是 Node 侧产物（tmp/），
 *   浏览器拿不到；前端又必须能「一眼判定这个点该走构造、走 LLM、还是不出题」。
 *   所以构建期把 plan 剪成一份只含判定字段的轻量包。
 *
 * 剪枝口径（不是拍脑袋，逐条有据，见卡 E 评论）：
 *   - 只放 strategy = verify | construct 的点（1084 个）。human-only 的 2213 个点
 *     前端不需要逐条知道字段，只要「查不到 = 不出题」这一条规则就够了 ——
 *     gen-route.js 的 plan-missing 与 human-only 走同一个不出题分支，都不发请求。
 *   - descendantsLite = descendants.slice(0, 50)。50 是 gen-route 判定「黑名单/白名单」
 *     切换的界：>=50 走白名单（看 chapter+grade），<50 走黑名单（逐个比 descendant 名）。
 *     截到 50 不改变任何一侧的判定结果，却把最长 869 条的数组压下来。
 *   - prereqClosure / gaps 全量保留（不截断）：它们是门 7「超纲」的 allowed 集合与默认难度顺序的输入，
 *     按 id 排序后截断会静默丢掉随机的一批前置点、改变出题口径。全量装入后整包 gz ≈ 37KB（硬顶 60KB）。
 *   - family / grade / chapter 给 route 判定与上下文兜底用；chapter 取自 topics-lite（plan 条目没有 chapter）。
 *
 * 幂等：输出只依赖输入（顺序 = plan 顺序，字段顺序固定，紧凑 JSON + 单个换行）。
 *       两次生成字节相同 —— tests/test_llm_frontend_wire.js 钉着这条。
 *
 * 用法：
 *   node scripts/build-gen-plan-lite.mjs                       # tmp/gap-plan.json → data/gen-plan.json
 *   node scripts/build-gen-plan-lite.mjs --check               # 只校验 data/gen-plan.json 是否最新（CI/测试用）
 *   node scripts/build-gen-plan-lite.mjs --in X --out Y        # 指定路径
 *   node scripts/build-gen-plan-lite.mjs --stats               # 打印字段与 gz 体积，不写文件
 *
 * 前置：plan 由 node scripts/gen-gap-plan.mjs 生成（tmp/gap-plan.json）。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export const PLAN_SCHEMA = 'gen-plan-lite/1';
export const GAP_PLAN_SCHEMA = 'gap-plan/1';
/** descendants 截断上限：等于 gen-route 的黑名单/白名单切换界。 */
export const DESC_LITE_MAX = 50;
/** 前端只需要知道「要出题」的两类策略；其余（human-only）不出现在包里。 */
export const KEPT_STRATEGIES = ['verify', 'construct'];

/* ------------------------------------------------------------ 纯函数 */

/** topics.json 的 id → topic，用于补 chapter（plan 条目里没有 chapter）。 */
export function topicIndex(topicsDoc) {
  const out = Object.create(null);
  const arr = Array.isArray(topicsDoc) ? topicsDoc : (topicsDoc && Array.isArray(topicsDoc.topics) ? topicsDoc.topics : []);
  for (const t of arr) if (t && t.id) out[t.id] = t;
  return out;
}

/** plan 条目 → 轻量节点。字段顺序固定（幂等的字节来源）。
 *  prereqClosure / gaps 都不截断：它们是门 7（超纲）与难度顺序的输入，截断会静默改变出题口径；
 *  实测全量装入后整包 gz ≈ 37KB，离 60KB 硬顶还有余量（见卡 E 评论的体积表）。 */
export function liteNode(entry, topics) {
  const t = (topics && topics[entry.topicId]) || null;
  const node = { topicId: entry.topicId, strategy: entry.strategy };
  if (entry.verifier) node.verifier = entry.verifier;
  if (entry.family) node.family = entry.family;
  const grade = entry.grade != null ? entry.grade : (t ? t.grade : null);
  if (grade != null) node.grade = grade;
  const chapter = t && t.chapter ? t.chapter : '';
  node.chapter = chapter;
  node.gaps = Array.isArray(entry.gaps) ? entry.gaps.slice() : [];
  node.prereqClosure = Array.isArray(entry.prereqClosure) ? entry.prereqClosure.slice() : [];
  const desc = Array.isArray(entry.descendants) ? entry.descendants : [];
  node.descendantsLite = desc.slice(0, DESC_LITE_MAX);
  return node;
}

/** gap-plan → 轻量包对象（不含文件 IO，测试可直接调）。 */
export function buildGenPlanLite(plan, topicsDoc) {
  if (!plan || !Array.isArray(plan.topics)) {
    throw new Error('build-gen-plan-lite: plan.topics 缺失（先跑 node scripts/gen-gap-plan.mjs）');
  }
  const topics = topicIndex(topicsDoc);
  const all = plan.topics;
  const counts = { topics: all.length, verify: 0, construct: 0, humanOnly: 0, kept: 0 };
  for (const e of all) {
    if (e.strategy === 'verify') counts.verify++;
    else if (e.strategy === 'construct') counts.construct++;
    else if (e.strategy === 'human-only') counts.humanOnly++;
  }
  const nodes = [];
  let descTruncated = 0;
  for (const e of all) {
    if (!e || !e.topicId) continue;
    if (KEPT_STRATEGIES.indexOf(e.strategy) < 0) continue;
    if (Array.isArray(e.descendants) && e.descendants.length > DESC_LITE_MAX) descTruncated++;
    nodes.push(liteNode(e, topics));
  }
  counts.kept = nodes.length;

  return {
    schema: PLAN_SCHEMA,
    source: GAP_PLAN_SCHEMA,
    descLiteMax: DESC_LITE_MAX,
    counts,
    descTruncated,
    nodes,
  };
}

/** 序列化：紧凑 + 单换行（与 build-questions-split.mjs 的 jsonText 同口径）。 */
export function genPlanText(doc) {
  return JSON.stringify(doc) + '\n';
}

export function gzSize(text) {
  return zlib.gzipSync(Buffer.from(text, 'utf8'), { level: 9 }).length;
}

/* ------------------------------------------------------------ CLI */

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function main() {
  const inPath = path.resolve(ROOT, arg('--in') || 'tmp/gap-plan.json');
  const outPath = path.resolve(ROOT, arg('--out') || 'data/gen-plan.json');
  if (!fs.existsSync(inPath)) {
    console.error('✗ 找不到 ' + inPath + '（先跑 node scripts/gen-gap-plan.mjs）');
    process.exit(1);
  }
  const plan = readJson(inPath);
  /* chapter 只用得到一个来源：topics-lite（3297 个点的 id/grade/chapter，比 topics.json 小两个数量级）。
   * 缺失时退回 topics.json；两者都没有 → chapter 为空串（门 7 白名单路线的 chapter 比对仍然自洽）。 */
  const litePath = path.join(ROOT, 'data/topics-lite.json');
  const fullPath = path.join(ROOT, 'data/topics.json');
  const topicsDoc = fs.existsSync(litePath) ? readJson(litePath) : (fs.existsSync(fullPath) ? readJson(fullPath) : []);
  const doc = buildGenPlanLite(plan, topicsDoc);
  const text = genPlanText(doc);
  const gz = gzSize(text);

  if (process.argv.includes('--stats')) {
    console.log('nodes=' + doc.counts.kept + ' verify=' + doc.counts.verify + ' construct=' + doc.counts.construct +
      ' humanOnly(skipped)=' + doc.counts.humanOnly + ' descTruncated=' + doc.descTruncated);
    console.log('raw=' + Buffer.byteLength(text) + 'B gz=' + gz + 'B');
    return;
  }

  if (process.argv.includes('--check')) {
    if (!fs.existsSync(outPath)) {
      console.error('✗ ' + path.relative(ROOT, outPath) + ' 不存在（跑 node scripts/build-gen-plan-lite.mjs 重建）');
      process.exit(1);
    }
    const now = fs.readFileSync(outPath, 'utf8');
    if (now !== text) {
      console.error('✗ ' + path.relative(ROOT, outPath) + ' 与 plan 不一致（跑 node scripts/build-gen-plan-lite.mjs 重建）');
      process.exit(1);
    }
    console.log('✓ ' + path.relative(ROOT, outPath) + ' 是最新的（nodes=' + doc.counts.kept + ' gz=' + gz + 'B）');
    return;
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, text);
  console.log('✓ ' + path.relative(ROOT, outPath) + '：nodes=' + doc.counts.kept +
    '（verify=' + doc.counts.verify + ' construct=' + doc.counts.construct + '，跳过 human-only=' + doc.counts.humanOnly + '）' +
    ' raw=' + Buffer.byteLength(text) + 'B gz=' + gz + 'B');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
