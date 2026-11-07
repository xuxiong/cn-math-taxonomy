#!/usr/bin/env node
/* 缺口矩阵 + 生成工单（卡 A / t_df6334bb）：每个知识点缺什么、该用哪种生成策略。
 *
 * 只读 data/（topics / questions / stats / dependencies/* / cn-curriculum-standards）、
 * 零网络、零 LLM、零新依赖。产物是构建中间件：tmp/gap-plan.json（git 忽略，不入库）。
 *
 * 下游两张卡吃这份 plan：
 *   卡 B（确定性构造器）取 strategy=construct 的清单 + verifier 族；
 *   卡 C（LLM 管线）取 strategy=verify 的清单，用 prereqClosure / descendants 做超纲闸门，
 *   用 existing 做撞题闸门，用 gaps 决定该补哪一类题。
 *
 * ── 判定口径（全部写死在下面，可从数据复算，不含任何写死的总数） ──
 *
 * gaps（四类缺口，均按该知识点的现有题现算）：
 *   no-challenge  现有题里没有 difficulty ∈ {challenge, advanced}
 *   no-numeric    现有题里没有 type=numeric
 *   no-figure     现有题里没有 figure（非空 SVG 串）
 *   no-standards  课标链接里没有一条 confidence="exact"（即只能靠 inferred 兜）
 *                 ⚠ 这是本脚本的判断：卡面只给了名字，没给定义。另一种读法是「一条课标都没有」
 *                 （实测只有 2 个点），本口径把它作为子集包含在内。两种读数都在 summary 里报。
 *
 * strategy（三选一，互斥且穷尽）：
 *   human-only  「没有一道可机验的题」——即不存在 type=numeric 的题，也不存在
 *               「非 choice 且带 verify 表达式」的题。choice 题即便带 verify 也算 human-only：
 *               干扰项需要教学判断（O3 设计 D9），不喂 LLM 出新题。
 *               实测：与卡面「全部是 choice」的重合度是 2212/2213，唯一例外 cnm_120
 *               （3 choice + 1 short，short 无 verify）——卡面两条断言在该点上互斥，
 *               这里按「不可机验」统一裁决，例外集由 tests/test_gap_plan.js 逐点点名。
 *   construct   命中闭式族名表（SQUARE / EQUATION_STRONG / EQUATION_WEAK+同章有「方程」）
 *               且该点至少有一道带 verify 表达式的 numeric 题，且题型不是应用题/建模题
 *               ——即「题面 ↔ 答案」的反解关系在现库里已被证实过，可以答案先行反推题面。
 *               卡1 追加：命中 FAMILY_RECIPES（算术运算族，配方在 diagnose/construct.js 里）
 *               也算 construct —— 新族靠「配方存在」准入，不要求现库有带 verify 的 numeric 题；
 *               上面方程族的三条口径一字未改。
 *   verify      其余可机验的知识点：答案可求值，但题面不是模板（应用题、单位换算……）。
 *
 * verifier：
 *   equation      闭式族：解方程 / 方程的根 / 求根公式 / 因式分解 / 分式方程（代入验根）
 *   completeSquare 配方法族的基本式（先定答案 = (b/2)²，再反推 b）
 *   formParam     配方法族里 (m,n) 参数对式（实测证据：该知识点的现有 numeric 题能过 verifyFormParam）
 *   numeric-compare verify 策略且有 numeric 题：算出来比数值
 *   null          没有可用的确定性验证器（human-only，或只有无 verify 的文本题）
 *
 * prereqClosure / descendants：
 *   均取 data/dependencies/*.json 的**全部**边（hard + soft）的传递闭包，均排除自身。
 *   closure 用全部边而不是只取 hard：否则生成器会把「软前置」概念误判成超纲（假阳性）。
 *   descendants 是同一条边的反向闭包 —— 题干命中这些知识点的概念词即超纲。
 *
 * ── 产物字段 ──
 *   每条：topicId / subject / grade / name / existing / gaps / strategy / verifier
 *         + prereqClosure / descendants（卡面要求的 10 个）
 *         + 2 个留痕字段：family（命中哪个闭式族，construct 的依据）、
 *           standards（exact / inferred / total，no-standards 的依据）。
 *   verifier=null 表示没有确定性验证器（human-only 一定有；verify 里只有「无 numeric 题」时才会）。
 *
 * ── 幂等 ──
 * 输出顺序 = data/topics.json 的顺序（教学顺序）；existing 保持 questions.json 内的相对顺序；
 * closure / descendants 按 id 排序；头部两空格缩进、topics 一条一行、无时间戳、无随机量。
 * 同一份输入重复跑 → 字节级完全一致（tests/test_gap_plan.js 会验）。
 *
 * ── 用法 ──
 *   node scripts/gen-gap-plan.mjs                     # 写 tmp/gap-plan.json 并打印摘要
 *   node scripts/gen-gap-plan.mjs --out /tmp/p.json    # 换输出路径（测试用，不碰仓库）
 *   node scripts/gen-gap-plan.mjs --quiet              # 只写文件，不打印摘要
 *   node scripts/gen-gap-plan.mjs --summary-json       # 打印摘要 JSON（给卡评论/二次处理）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { subjectOf } from './build-questions-split.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/* 验证门复用 O3 的纯函数层（零网络零 DOM）。只用来做「现有题属哪一族」的证据判定。 */
const LLM_EVAL = require(path.join(ROOT, 'diagnose', 'llm-eval.js'));

/* 卡1：算术运算族（S1–S4）的族表 —— topicId → 配方 id 列表。
 * 唯一真源是 diagnose/construct.js 的配方表：这里只按 family === 'arithmetic' 投影，
 * 不在脚本里另抄一份 id，改配方不会两边漂移。
 * 新族准入 = 「配方存在」：不要求现库里有带 verify 的 numeric 题（方程族那条口径原样保留）。 */
const CONSTRUCT = require(path.join(ROOT, 'diagnose', 'construct.js'));

export const FAMILY_RECIPES = (() => {
  const out = {};
  for (const r of CONSTRUCT.RECIPES) {
    if (r.family !== 'arithmetic') continue;
    if (!out[r.topic]) out[r.topic] = [];
    out[r.topic].push(r.id);
  }
  for (const k of Object.keys(out)) out[k].sort();
  return out;
})();

export const SCHEMA = 'gap-plan/1';

/* 缺口名的规范顺序：输出里按这个顺序过滤，保证同输入同字节。 */
export const GAP_NAMES = ['no-challenge', 'no-numeric', 'no-figure', 'no-standards'];

/* 闭式族名表（写死，可测）。只对数学生效：别的学科即便名字里有「方程」，答案形态也不同
 * （物理的运动方程、化学的方程式配平都不是「求出确定的根」）。
 * 「公式法 / 因式分解法 / 直接开平方法」有歧义（整式乘法的乘法公式也叫公式法），
 * 所以列为弱词：只有同章章名里出现「方程」才算解方程族。 */
const EQUATION_STRONG =
  /(一元一次方程|一元二次方程|二元一次方程|三元一次方程|方程组|分式方程|解方程|方程的解|方程的根|根与系数的关系|求根公式)/;
const EQUATION_WEAK = /(公式法|因式分解法|直接开平方法)/;
const SQUARE = /配方法/;

/* 应用题 / 建模题即便落在方程族里也不算 construct：卡面把「应用题数值」明确划给 verify，
 * 这类题的题面是情境叙述、不是一个可反解的模板。 */
const NON_TEMPLATE_TYPES = new Set(['modeling', 'application']);

const CHALLENGE_TIERS = new Set(['challenge', 'advanced']);

/* ---------------------------------------------------------------- 读入 */

export function readInputs(root = ROOT) {
  const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
  const topics = readJson(path.join(root, 'data', 'topics.json'));
  const questions = readJson(path.join(root, 'data', 'questions.json'));
  const stats = readJson(path.join(root, 'data', 'stats.json'));

  /* 依赖边按学科分文件：排序后逐份读，避免 readdir 顺序影响输出。 */
  const depDir = path.join(root, 'data', 'dependencies');
  const depFiles = fs.readdirSync(depDir).filter((f) => f.endsWith('.json')).sort();
  const edges = [];
  for (const f of depFiles) {
    for (const e of readJson(path.join(depDir, f))) {
      edges.push({ topicId: e.topicId, prerequisiteId: e.prerequisiteId, strength: e.strength, file: f });
    }
  }
  return { topics, questions, stats, edges, depFiles };
}

/* ---------------------------------------------------------------- 判定 */

/** 该知识点是否有「可机验的题」：numeric 题，或非 choice 且带 verify 表达式的题。 */
export function isMachineGradable(question) {
  if (!question) return false;
  if (question.type === 'numeric') return true;
  return question.type !== 'choice' && typeof question.verify === 'string' && question.verify.trim() !== '';
}

export function gapsOf(questions) {
  const hit = {
    'no-challenge': !questions.some((q) => CHALLENGE_TIERS.has(q.difficulty)),
    'no-numeric': !questions.some((q) => q.type === 'numeric'),
    'no-figure': !questions.some((q) => typeof q.figure === 'string' && q.figure.trim() !== ''),
    'no-standards': false,
  };
  return GAP_NAMES.filter((g) => hit[g]);
}

/** 课标链接的 confidence 分布；no-standards 的口径 = exact 条数为 0。 */
export function standardLinks(topic) {
  const links = Array.isArray(topic.standards) ? topic.standards : [];
  let exact = 0;
  let inferred = 0;
  for (const l of links) {
    if (l && l.confidence === 'exact') exact += 1;
    else inferred += 1;
  }
  return { exact, inferred, total: links.length };
}

/** 闭式族判定：只对数学生效；不命中返回 null。 */
export function familyOf(topic) {
  if (subjectOf(topic) !== 'math') return null;
  const name = String(topic.name || '');
  const chapter = String(topic.chapter || '');
  if (SQUARE.test(name)) return 'square';
  if (EQUATION_STRONG.test(name)) return 'equation';
  if (EQUATION_WEAK.test(name) && /方程/.test(chapter)) return 'equation';
  return null;
}

/**
 * 配方法族里 verifier 的具体形态：有现成 (m,n) 参数对题的证据就取 formParam，
 * 否则按族名默认 completeSquare（先定答案 =(b/2)² 反推 b）。
 * 证据 = 该知识点现有 numeric 题里至少一道能过 O3 的 verifyFormParam。
 */
export function squareVerifier(questions) {
  const numeric = questions.filter((q) => q.type === 'numeric');
  const passes = (fn) => numeric.some((q) => {
    try {
      const r = fn(q.prompt, q.answer);
      return !!(r && r.ok);
    } catch (e) {
      return false;
    }
  });
  /* 基本式（加常数）优先：它是「先定答案 =(b/2)² 再反推 b」的原形，构造器最容易做到 100% 可测。
   * 只有该知识点没有基本式证据时才归到 (m,n) 参数对式。 */
  if (passes(LLM_EVAL.verifyCompletingSquare)) return 'completeSquare';
  if (passes(LLM_EVAL.verifyFormParam)) return 'formParam';
  return 'completeSquare';
}

/** 单个知识点的 plan 条目（不含闭包，闭包由 buildPlan 补）。 */
export function planForTopic(topic, questions) {
  const links = standardLinks(topic);
  const gaps = gapsOf(questions).slice();
  if (links.exact === 0) gaps.push('no-standards');
  const orderedGaps = GAP_NAMES.filter((g) => gaps.indexOf(g) >= 0);

  const gradable = questions.filter(isMachineGradable);
  const hasNumeric = questions.some((q) => q.type === 'numeric');
  const numericWithVerify = questions.some(
    (q) => q.type === 'numeric' && typeof q.verify === 'string' && q.verify.trim() !== ''
  );
  const family = familyOf(topic);
  const arithRecipes = FAMILY_RECIPES[topic.id] || [];

  let strategy;
  let verifier;
  if (arithRecipes.length) {
    /* 卡1 新族：配方存在即可构造，不看现库有没有带 verify 的 numeric 题（放宽准入）。 */
    strategy = 'construct';
    verifier = 'arithmetic';
  } else if (gradable.length === 0) {
    strategy = 'human-only';
    verifier = null;
  } else if (family && numericWithVerify && !NON_TEMPLATE_TYPES.has(topic.type)) {
    strategy = 'construct';
    verifier = family === 'square' ? squareVerifier(questions) : 'equation';
  } else {
    strategy = 'verify';
    verifier = hasNumeric ? 'numeric-compare' : null;
  }

  return {
    topicId: topic.id,
    subject: subjectOf(topic),
    grade: topic.grade == null ? null : topic.grade,
    name: topic.name == null ? '' : String(topic.name),
    existing: questions.map((q) => q.id),
    gaps: orderedGaps,
    strategy,
    verifier,
    standards: { exact: links.exact, inferred: links.inferred, total: links.total },
    family: family || (arithRecipes.length ? 'arithmetic' : null),
  };
}

/* ---------------------------------------------------------------- 闭包 */

/** 全部边（hard + soft）的传递闭包：topicId → {ancestors 集合, descendants 集合}。 */
export function buildClosures(topicIds, edges) {
  const pre = new Map(); // topic → 直接前置
  const post = new Map(); // topic → 直接后继
  for (const id of topicIds) {
    pre.set(id, []);
    post.set(id, []);
  }
  for (const e of edges) {
    if (!pre.has(e.topicId) || !pre.has(e.prerequisiteId)) {
      throw new Error('dependency edge with unknown endpoint: ' + e.topicId + ' <- ' + e.prerequisiteId);
    }
    pre.get(e.topicId).push(e.prerequisiteId);
    post.get(e.prerequisiteId).push(e.topicId);
  }

  const closure = (start, adj) => {
    const seen = new Set();
    const stack = (adj.get(start) || []).slice();
    while (stack.length) {
      const cur = stack.pop();
      if (cur === start) throw new Error('dependency cycle reaches itself: ' + start);
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const next of adj.get(cur) || []) if (!seen.has(next)) stack.push(next);
    }
    return Array.from(seen).sort();
  };

  const out = new Map();
  for (const id of topicIds) out.set(id, { prereqClosure: closure(id, pre), descendants: closure(id, post) });
  return out;
}

/* ---------------------------------------------------------------- 组装 */

function emptyStrategyBuckets() {
  return {
    topics: 0,
    construct: 0,
    verify: 0,
    'human-only': 0,
    gaps: { 'no-challenge': 0, 'no-numeric': 0, 'no-figure': 0, 'no-standards': 0 },
    verifier: { equation: 0, completeSquare: 0, formParam: 0, arithmetic: 0, 'numeric-compare': 0, none: 0 },
  };
}

/** 纯函数：给全部输入，产出 plan 对象（不碰磁盘，测试可直接喂合成数据）。 */
export function buildPlan({ topics, questions, stats, edges }) {
  const topicsById = new Map(topics.map((t) => [t.id, t]));
  const questionsByTopic = new Map();
  for (const t of topics) questionsByTopic.set(t.id, []);
  const orphans = [];
  for (const q of questions) {
    const bucket = questionsByTopic.get(q.topicId);
    if (!bucket) {
      orphans.push(q.id);
      continue;
    }
    bucket.push(q);
  }
  if (orphans.length) throw new Error('questions with unknown topicId: ' + orphans.slice(0, 5).join(', '));

  const core = topics.filter((t) => !t.external);
  const closures = buildClosures(core.map((t) => t.id), edges);

  const entries = [];
  const summary = {
    total: core.length,
    excludedExternal: topics.length - core.length,
    strategy: { construct: 0, verify: 0, 'human-only': 0 },
    verifier: { equation: 0, completeSquare: 0, formParam: 0, arithmetic: 0, 'numeric-compare': 0, none: 0 },
    gaps: { 'no-challenge': 0, 'no-numeric': 0, 'no-figure': 0, 'no-standards': 0 },
    bySubject: {},
    byGrade: {},
    standardsWithoutExact: 0,
    standardsWithoutAny: 0,
  };
  for (const s of Object.keys(stats.subjects || {})) summary.bySubject[s] = emptyStrategyBuckets();

  for (const topic of core) {
    const qs = questionsByTopic.get(topic.id) || [];
    const entry = planForTopic(topic, qs);
    const clo = closures.get(topic.id);
    entry.prereqClosure = clo.prereqClosure;
    entry.descendants = clo.descendants;
    entries.push(entry);

    summary.strategy[entry.strategy] += 1;
    summary.verifier[entry.verifier === null ? 'none' : entry.verifier] += 1;
    for (const g of entry.gaps) summary.gaps[g] += 1;

    if (!summary.bySubject[entry.subject]) summary.bySubject[entry.subject] = emptyStrategyBuckets();
    const subj = summary.bySubject[entry.subject];
    subj.topics += 1;
    subj[entry.strategy] += 1;
    for (const g of entry.gaps) subj.gaps[g] += 1;
    const vk = entry.verifier === null ? 'none' : entry.verifier;
    subj.verifier[vk] += 1;

    const gk = String(entry.grade == null ? 'na' : entry.grade);
    summary.byGrade[gk] = (summary.byGrade[gk] || 0) + 1;

    if (entry.standards.exact === 0) summary.standardsWithoutExact += 1;
    if (entry.standards.total === 0) summary.standardsWithoutAny += 1;
  }

  /* 学科 / 年级分布按稳定顺序输出（学科按 stats.json 的键顺序，年级按数字升序、'na' 最后）。 */
  const byGrade = {};
  for (const k of Object.keys(summary.byGrade).sort((a, b) => {
    if (a === 'na') return 1;
    if (b === 'na') return -1;
    return Number(a) - Number(b);
  })) byGrade[k] = summary.byGrade[k];
  summary.byGrade = byGrade;

  const plan = {
    schema: SCHEMA,
    source: {
      topics: 'data/topics.json',
      questions: 'data/questions.json',
      dependencies: 'data/dependencies/*.json',
      stats: 'data/stats.json',
      statsTotal: stats.total,
      inputTopics: topics.length,
      inputQuestions: questions.length,
      inputEdges: edges.length,
      topicsByIdSize: topicsById.size,
    },
    total: entries.length,
    summary,
    topics: entries,
  };

  verifyAgainstStats(plan, stats);
  return plan;
}

/** 与 data/stats.json 对账：总数与分学科数都必须相等，否则直接失败（fail-closed）。 */
export function verifyAgainstStats(plan, stats) {
  const problems = [];
  if (stats.total && stats.total.topics != null && plan.total !== stats.total.topics) {
    problems.push('total topics ' + plan.total + ' != stats.total.topics ' + stats.total.topics);
  }
  for (const [s, got] of Object.entries(plan.summary.bySubject)) {
    const want = stats.subjects && stats.subjects[s] ? stats.subjects[s].topics : null;
    if (want != null && got.topics !== want) {
      problems.push('subject ' + s + ' topics ' + got.topics + ' != stats ' + want);
    }
  }
  const sumSubj = Object.values(plan.summary.bySubject).reduce((a, b) => a + b.topics, 0);
  if (sumSubj !== plan.total) problems.push('sum(bySubject) ' + sumSubj + ' != total ' + plan.total);
  const sumStrategy = plan.summary.strategy.construct + plan.summary.strategy.verify + plan.summary.strategy['human-only'];
  if (sumStrategy !== plan.total) problems.push('sum(strategy) ' + sumStrategy + ' != total ' + plan.total);
  if (problems.length) throw new Error('gap-plan 与 data/stats.json 对不上：' + problems.join('; '));
  return true;
}

/* ---------------------------------------------------------------- 输出 */

export function serializePlan(plan) {
  /* 头部（schema / source / total / summary）两空格缩进；topics 每个知识点一行。
   * 这样十几 MB 的文件里 `grep '"topicId":"cnm_221"'` 能一眼看完整条，
   * 且同一份输入重复跑字节级完全一致（无时间戳、无随机量、顺序全部固定）。 */
  const head = JSON.stringify({
    schema: plan.schema,
    source: plan.source,
    total: plan.total,
    summary: plan.summary,
  }, null, 2);
  const headLines = head.split('\n');
  headLines.pop(); // 去掉对象结尾的 "}"
  const body = plan.topics.map((t) => '    ' + JSON.stringify(t)).join(',\n');
  const text = headLines.join('\n') + ',\n  "topics": [\n' + body + '\n  ]\n}\n';
  return Buffer.from(text, 'utf8');
}

export function writePlan(outPath, plan) {
  const abs = path.resolve(outPath);
  const dataDir = path.join(ROOT, 'data') + path.sep;
  if (abs.startsWith(dataDir)) throw new Error('拒绝写入 data/（本脚本只读 data/）：' + abs);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, serializePlan(plan));
  return abs;
}

export function formatSummary(plan) {
  const s = plan.summary;
  const lines = [];
  lines.push('gap-plan: ' + plan.total + ' 个知识点 → strategy construct=' + s.strategy.construct
    + ' verify=' + s.strategy.verify + ' human-only=' + s.strategy['human-only']);
  lines.push('verifier: equation=' + s.verifier.equation + ' completeSquare=' + s.verifier.completeSquare
    + ' formParam=' + s.verifier.formParam + ' arithmetic=' + s.verifier.arithmetic
    + ' numeric-compare=' + s.verifier['numeric-compare']
    + ' null=' + s.verifier.none);
  lines.push('gaps: ' + GAP_NAMES.map((g) => g + '=' + s.gaps[g]).join(' '));
  lines.push('课标: 无 exact 锚点 ' + s.standardsWithoutExact + '，一条课标都没有 ' + s.standardsWithoutAny);
  lines.push('学科分布（知识点 / construct / verify / human-only）:');
  for (const [subj, b] of Object.entries(s.bySubject)) {
    lines.push('  ' + subj.padEnd(10) + String(b.topics).padStart(5)
      + '  ' + String(b.construct).padStart(5)
      + '  ' + String(b.verify).padStart(5)
      + '  ' + String(b['human-only']).padStart(5));
  }
  return lines.join('\n');
}

/* ---------------------------------------------------------------- CLI */

function parseArgs(argv) {
  const args = { out: path.join(ROOT, 'tmp', 'gap-plan.json'), quiet: false, summaryJson: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out') {
      i += 1;
      if (!argv[i]) throw new Error('--out 需要一个路径');
      args.out = argv[i];
    } else if (a.startsWith('--out=')) {
      args.out = a.slice('--out='.length);
    } else if (a === '--quiet') {
      args.quiet = true;
    } else if (a === '--summary-json') {
      args.summaryJson = true;
    } else if (a === '--help' || a === '-h') {
      args.help = true;
    } else {
      throw new Error('未知参数: ' + a);
    }
  }
  return args;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write([
      'node scripts/gen-gap-plan.mjs [--out <path>] [--quiet] [--summary-json]',
      '',
      '只读 data/，给每个核心知识点算 gaps + strategy + 依赖闭包，产出生成工单。',
      '默认产物：tmp/gap-plan.json（已在 .gitignore 里，不入库）',
      '  --out <path>     改产物路径（拒绝任何 data/ 下的路径）',
      '  --quiet          不打印汇总',
      '  --summary-json   只打印 JSON 汇总',
      '',
    ].join('\n'));
    return 0;
  }
  const inputs = readInputs(ROOT);
  const plan = buildPlan(inputs);
  const written = writePlan(args.out, plan);
  if (!args.quiet) {
    if (args.summaryJson) process.stdout.write(JSON.stringify(plan.summary, null, 2) + '\n');
    else process.stdout.write(formatSummary(plan) + '\n');
    process.stdout.write('已写入 ' + path.relative(ROOT, written) + '（' + serializePlan(plan).length + ' 字节）\n');
  }
  return 0;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    process.exitCode = main();
  } catch (err) {
    process.stderr.write('gen-gap-plan 失败: ' + (err && err.message ? err.message : String(err)) + '\n');
    process.exitCode = 1;
  }
}
