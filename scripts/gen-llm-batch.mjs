#!/usr/bin/env node
/* LLM 出题批次（卡 C / t_faca95d0）：按卡 A 的 plan 取 strategy=verify 的知识点，
 * 走「参数化 prompt → 七道门 → 重试 3 次 → 缓存池 + 批次」管线，产物只落 tmp/。
 *
 * 用法
 * ----
 *   node scripts/gen-llm-batch.mjs --limit 20 --subject math --concurrency 3
 *   node scripts/gen-llm-batch.mjs --topics cnp_003,cnp_007 --difficulty advanced
 *   node scripts/gen-llm-batch.mjs --fake --limit 5        # 离线冒烟：确定性假网关，不出网
 *
 * 关键参数
 *   --plan <path>     卡 A 的 plan（默认 tmp/gap-plan.json）
 *   --out <path>      产物落盘（默认 tmp/llm-batch.json；只允许 tmp/，拒绝 data/）
 *   --limit N         取前 N 个知识点（按 plan 顺序 = 教学顺序）
 *   --topics a,b,c    只跑指定知识点（优先于 --limit）
 *   --subject math    只跑某学科
 *   --per-topic K     每个知识点生成几道（默认 1）
 *   --difficulty D    固定难度（默认按配方的第一档：no-challenge 的点先 advanced）
 *   --concurrency C   并发请求数（默认 3）
 *   --seed S          固定种子前缀（默认按 (topic,difficulty,attempt) 派生，便于回放）
 *   --no-write        只打印统计，不落盘
 *
 * 安全：网关地址/型号/max_tokens/超时全部走 diagnose/llm-config.js 与 llm-gateway.js；
 *  key 由 .env / 服务端反代提供，本脚本不读、不打印。产物带 variantSource:'llm'。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const recipes = require(path.join(ROOT, 'diagnose', 'llm-recipes.js'));
const gates = require(path.join(ROOT, 'diagnose', 'llm-gates.js'));
const gen = require(path.join(ROOT, 'diagnose', 'llm-gen.js'));

/* ---------------------------------------------------------------- 参数 */

export function parseArgs(argv) {
  const out = {
    plan: 'tmp/gap-plan.json',
    out: 'tmp/llm-batch.json',
    limit: 0,
    offset: 0,
    topics: null,
    subject: null,
    perTopic: 1,
    difficulty: null,
    concurrency: 3,
    seed: null,
    write: true,
    fake: false,
    quiet: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--plan') out.plan = next();
    else if (a === '--out') out.out = next();
    else if (a === '--limit') out.limit = parseInt(next(), 10);
    else if (a === '--offset') out.offset = parseInt(next(), 10);
    else if (a === '--topics') out.topics = String(next()).split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--subject') out.subject = next();
    else if (a === '--per-topic') out.perTopic = parseInt(next(), 10);
    else if (a === '--difficulty') out.difficulty = next();
    else if (a === '--concurrency') out.concurrency = parseInt(next(), 10);
    else if (a === '--seed') out.seed = next();
    else if (a === '--no-write') out.write = false;
    else if (a === '--fake') out.fake = true;
    else if (a === '--quiet') out.quiet = true;
    else throw new Error('unknown arg: ' + a);
  }
  return out;
}

/* ---------------------------------------------------------------- 数据 */

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

export function loadInputs(root = ROOT, planPath = 'tmp/gap-plan.json') {
  const plan = readJson(path.resolve(root, planPath));
  const topics = readJson(path.join(root, 'data', 'topics.json'));
  const questions = readJson(path.join(root, 'data', 'questions.json'));
  const standardsFile = readJson(path.join(root, 'data', 'cn-curriculum-standards.json'));
  const stdById = new Map();
  for (const sect of Object.keys(standardsFile)) {
    const v = standardsFile[sect];
    if (!Array.isArray(v)) continue;
    for (const s of v) if (s && s.id) stdById.set(s.id, s);
  }
  return { plan, topics, questions, stdById };
}

/** 每个知识点生成时用的 ctx（prompt 注入 + 门禁索引） */
export function buildContext(entry, topic, byQuestionId, index, stdById) {
  const existing = [];
  for (const id of entry.existing || []) {
    const q = byQuestionId.get(id);
    if (q) existing.push({ id: q.id, prompt: q.prompt });
  }
  const standards = (Array.isArray(topic.standards) ? topic.standards : []).map((s) => {
    const full = stdById.get(s.id);
    return { id: s.id, confidence: s.confidence, text: full ? full.text : '' };
  });
  const nameOf = (id) => (index.nameById.get(id) || '');
  return {
    topic: {
      id: topic.id, name: topic.name,
      /* topics.json 没有 subject 字段（只有 domain），学科以 plan 条目为准 */
      subject: entry.subject || topic.subject || null,
      grade: topic.grade,
      chapter: topic.chapter, description: topic.description,
      mastery_criteria: topic.mastery_criteria
    },
    existing,
    standards,
    nameOf,
    corpus: { prompts: index.prompts, skeletons: index.skeletons },
    vocabulary: index.vocabulary
  };
}

/** 建门禁索引 + id 反查（一次，批次内复用） */
export function buildGateIndex(topics, questions) {
  const idx = gates.buildIndex({ questions, topics });
  const nameById = new Map();
  const byQuestionId = new Map();
  for (const t of topics) if (t && t.id) nameById.set(t.id, t.name);
  for (const q of questions) if (q && q.id) byQuestionId.set(q.id, q);
  idx.nameById = nameById;
  idx.byQuestionId = byQuestionId;
  return idx;
}

/* ---------------------------------------------------------------- 离线假网关 */

/** 确定性假网关：按 seed 生成一条「看起来像题」的候选，纯粹用于离线冒烟（不证明任何质量）。
 *  契约与真网关一致：transport 返回**模型内容字符串**（不是整个 API 响应体）。 */
export function fakeTransport(body, meta) {
  const sys = body.messages && body.messages[0] ? body.messages[0].content : '';
  const m = /【知识点】([^｜]+)｜([^｜]*)｜([^｜\n]*)/.exec(sys);
  const name = m ? m[2] : '';
  const n = 2 + (hash(meta.seed) % 7);
  return JSON.stringify({
    prompt: `${name}：把 ${n} 与 ${n + 3} 相加（只填数值）。`,
    answer: String(2 * n + 3),
    explanation: `先读题，再按题意把两个数相加，得到 ${2 * n + 3}。`,
    verify: `${n}+${n + 3}`,
    verifyType: 'numeric',
    difficulty: meta.difficulty
  });
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < String(s).length; i++) {
    h ^= String(s).charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/* ---------------------------------------------------------------- 并发 */

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.max(1, Math.min(limit, items.length))).fill(0).map(async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/* ---------------------------------------------------------------- 汇总 */

export function summarize(pipeline, selected, results) {
  const stats = pipeline.getStats();
  const produced = results.filter((r) => r && r.ok).length;
  const attempts = stats.attempts;
  const gateTotal = Object.values(stats.byGate).reduce((a, b) => a + b, 0);
  const byGateShare = {};
  for (const [g, n] of Object.entries(stats.byGate)) byGateShare[g] = pct(n, gateTotal);
  const bySubject = {};
  for (const [s, v] of Object.entries(stats.bySubject)) {
    bySubject[s] = {
      attempts: v.attempts, produced: v.produced, exhausted: v.exhausted || 0,
      successRate: pct(v.produced, v.attempts)
    };
  }
  const byDifficulty = {};
  for (const [d, v] of Object.entries(stats.byDifficulty)) {
    byDifficulty[d] = { attempts: v.attempts, produced: v.produced, successRate: pct(v.produced, v.attempts) };
  }
  const perTopic = {};
  for (const [id, v] of Object.entries(stats.byTopic)) {
    perTopic[id] = {
      attempts: v.attempts, produced: v.produced, exhausted: v.exhausted,
      successRate: pct(v.produced, v.attempts)
    };
  }
  const topicsWithOutput = Object.values(stats.byTopic).filter((v) => v.produced > 0).length;
  return {
    topicsSelected: selected.length,
    topicsWithOutput,
    topicSuccessRate: pct(topicsWithOutput, selected.length),
    generated: produced,
    attempts,
    meanAttemptsPerQuestion: produced ? round(attempts / produced, 2) : null,
    exhaustedTasks: stats.exhausted,
    exhaustedRate: pct(stats.exhausted, selected.length),
    producedByAttempt: stats.producedByAttempt,
    byGate: stats.byGate,
    byGateShare,
    byReason: stats.byReason,
    dupHits: stats.dupHits,
    renumberHits: stats.renumberHits,
    syllabusHits: stats.syllabusHits,
    bySubject,
    byDifficulty,
    byAnswerShape: stats.byAnswerShape,
    routeSplit: countRoutes(selected)
  };
}

function countRoutes(selected) {
  const out = {};
  for (const s of selected) {
    const r = s.recipe.constraints.syllabus.route;
    out[r] = out[r] || {};
    out[r][s.entry.subject] = (out[r][s.entry.subject] || 0) + 1;
  }
  return out;
}

function pct(a, b) { return b ? Number(((a / b) * 100).toFixed(1)) : 0; }
function round(x, d) { const p = Math.pow(10, d); return Math.round(x * p) / p; }

/* ---------------------------------------------------------------- 主流程 */

export async function run(argv = process.argv.slice(2), root = ROOT) {
  const args = parseArgs(argv);
  const { plan, topics, questions, stdById } = loadInputs(root, args.plan);
  const index = buildGateIndex(topics, questions);
  const topicById = new Map(topics.map((t) => [t.id, t]));

  let entries = (plan.topics || []).filter((e) => e.strategy === 'verify');
  if (args.topics) {
    const want = new Set(args.topics);
    entries = entries.filter((e) => want.has(e.topicId));
  }
  if (args.subject) entries = entries.filter((e) => e.subject === args.subject);
  if (args.offset > 0) entries = entries.slice(args.offset);
  if (args.limit > 0) entries = entries.slice(0, args.limit);

  const selected = [];
  for (const entry of entries) {
    const topic = topicById.get(entry.topicId);
    const recipe = recipes.recipeFromPlanEntry(entry);
    if (!topic || !recipe) continue;
    selected.push({ entry, topic, recipe, ctx: buildContext(entry, topic, index.byQuestionId, index, stdById) });
  }

  const pipeline = gen.createPipeline({
    transport: args.fake ? fakeTransport : undefined
  });

  const tasks = [];
  for (const s of selected) {
    for (let k = 0; k < Math.max(1, args.perTopic); k++) {
      tasks.push({ s, k });
    }
  }

  const results = await mapLimit(tasks, args.concurrency, async (task) => {
    const { s, k } = task;
    const difficulty = args.difficulty || s.recipe.constraints.difficulties[Math.min(k, s.recipe.constraints.difficulties.length - 1)];
    const o = { difficulty };
    if (args.seed) o.seed = args.seed + '|' + s.entry.topicId + '|' + k;
    const r = await pipeline.gen(s.recipe, s.ctx, o);
    r.topicId = s.entry.topicId;
    r.k = k;
    return r;
  });

  const summary = summarize(pipeline, selected, results);
  const payload = pipeline.exportBatch({
    plan: args.plan,
    planSchema: plan.schema,
    topicsSelected: selected.length,
    perTopic: args.perTopic,
    fake: args.fake
  });

  if (args.write) {
    const outPath = path.isAbsolute(args.out) ? args.out : path.resolve(root, args.out);
    gen.writeBatch(outPath, payload);
    summary.out = path.relative(root, outPath);
  }

  const samples = payload.questions.slice(0, 5).map((q) => ({
    id: q.id, topicId: q.topicId, subject: q.subject, difficulty: q.difficulty,
    prompt: q.prompt, answer: q.answer, verify: q.verify, verifyType: q.verifyType,
    explanation: q.explanation,
    gateVerdicts: (q.gates || []).map((c) => c.gate + ':' + c.reason)
  }));
  summary.samples = samples;
  return summary;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  run().then((s) => { console.log(JSON.stringify(s, null, 2)); })
    .catch((e) => { console.error(String(e && e.stack || e)); process.exit(1); });
}
