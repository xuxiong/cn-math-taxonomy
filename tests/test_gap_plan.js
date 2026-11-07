#!/usr/bin/env node
/* 生成工单（gap-plan）守卫：node tests/test_gap_plan.js
 *
 * 卡 A / t_df6334bb。被测对象 = scripts/gen-gap-plan.mjs（只读 data/，产出 tmp/gap-plan.json）。
 *
 * 本文件守：
 *   结构层   total 与 data/stats.json 一致（总分学科都算，不写死任何数字）、知识点不重不漏、
 *           输出顺序 = topics.json 教学顺序；
 *   口径层   gaps 独立重算（测试侧不 import 脚本的判定函数）逐条比对；
 *            strategy 三条互斥且穷尽：human-only 必须「一道可机验的题都没有」、
 *            construct|verify 必须至少有一道 numeric 或带 verify 的题；
 *            verifier 与 strategy 的搭配合法；
 *   闭包层   prereqClosure 传递闭合、hard 边全在闭包内、闭包与后继不相交、不含自身；
 *   幂等层   同输入两次运行字节级一致（sha256）；
 *   红线层   脚本零网络、零时钟、零随机；拒绝写 data/；.gitignore 忽略 tmp/；
 *   自检层   合成数据反证断言有效（该红的必须真红：numeric 题不许判 human-only、
 *            环必须报错、缺硬前置必须被闭包断言抓住）。
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'gen-gap-plan.mjs');
const GITIGNORE = path.join(ROOT, '.gitignore');

const TOPICS = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'topics.json'), 'utf8'));
const QUESTIONS = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'questions.json'), 'utf8'));
const STATS = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'stats.json'), 'utf8'));

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ok   ' + name);
  } catch (e) {
    failed += 1;
    console.log('  FAIL ' + name + '\n       ' + String((e && e.stack) || e).split('\n').slice(0, 5).join('\n       '));
  }
}

/* ---------------------------------------------------------------- 测试侧独立实现（故意不 import 被测脚本） */

const GAP_ORDER = ['no-challenge', 'no-numeric', 'no-figure', 'no-standards'];
const SUBJECT_BY_PREFIX = [
  ['cne_', 'english'], ['cnp_', 'physics'], ['cnc_', 'chinese'], ['cns_', 'science'],
  ['cnd_', 'morality'], ['cnh_', 'history'], ['cng_', 'geography'], ['cnb_', 'biology'],
  ['cnk_', 'chemistry'],
];
/* 与 scripts/build-questions-split.mjs 的 subjectOf() 同一套规则，这里独立重写一份当反校：
 * 两边不一致就报红（数学没有 subject 字段，按 id 前缀推、默认 math）。 */
function subjectOf(topic) {
  const known = ['english', 'math', 'physics', 'chinese', 'science', 'morality', 'history', 'geography', 'biology', 'chemistry'];
  if (topic && known.indexOf(topic.subject) >= 0) return topic.subject;
  const id = String((topic && topic.id) || '');
  for (const pair of SUBJECT_BY_PREFIX) if (id.indexOf(pair[0]) === 0) return pair[1];
  return 'math';
}

/** 测试侧重算缺口（不看脚本的 gapsOf）。 */
function expectedGaps(topic, qs) {
  const hit = {
    'no-challenge': !qs.some((q) => q.difficulty === 'challenge' || q.difficulty === 'advanced'),
    'no-numeric': !qs.some((q) => q.type === 'numeric'),
    'no-figure': !qs.some((q) => typeof q.figure === 'string' && q.figure.trim() !== ''),
    'no-standards': !(Array.isArray(topic.standards) ? topic.standards : []).some((l) => l && l.confidence === 'exact'),
  };
  return GAP_ORDER.filter((g) => hit[g]);
}

/** 测试侧重算「该题是否可机验」。 */
function gradable(q) {
  if (!q) return false;
  if (q.type === 'numeric') return true;
  return q.type !== 'choice' && typeof q.verify === 'string' && q.verify.trim() !== '';
}

const BY_TOPIC = new Map();
for (const t of TOPICS) BY_TOPIC.set(t.id, []);
for (const q of QUESTIONS) {
  assert.ok(BY_TOPIC.has(q.topicId), '题目引用了不存在的知识点：' + q.id + ' → ' + q.topicId);
  BY_TOPIC.get(q.topicId).push(q);
}
const CORE = TOPICS.filter((t) => !t.external);
const CORE_IDS = new Set(CORE.map((t) => t.id));

/* ---------------------------------------------------------------- 跑真脚本 */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cnm-gap-plan-'));

function runPlan(name) {
  const out = path.join(TMP, name);
  execFileSync(process.execPath, [SCRIPT, '--out', out, '--quiet'], { cwd: ROOT, encoding: 'utf8' });
  const bytes = fs.readFileSync(out);
  return { out, bytes, sha: crypto.createHash('sha256').update(bytes).digest('hex') };
}

/* ---------------------------------------------------------------- 主流程 */

async function main() {
  const runA = runPlan('a.json');
  const runB = runPlan('b.json');
  const PLAN = JSON.parse(runA.bytes.toString('utf8'));
  const ENTRIES = PLAN.topics;
  const ENTRY_BY_ID = new Map(ENTRIES.map((e) => [e.topicId, e]));
  const mod = await import(pathToFileURL(SCRIPT).href);

  /* ================================================================
   * 1. 结构：总数与 data/stats.json 一致，知识点不重不漏
   * ================================================================ */

  console.log('\n--- 结构：与 data/stats.json 对账 ---');

  test('total 与 stats.total.topics 一致（现算，不写死）', () => {
    assert.strictEqual(PLAN.total, STATS.total.topics, 'PLAN.total 与 stats.total.topics 不等');
    assert.strictEqual(ENTRIES.length, PLAN.total, 'topics 数组长度与 total 不等');
    assert.strictEqual(PLAN.total, CORE.length, 'total 与 topics.json 里非 external 的知识点数不等');
  });

  test('分学科知识点数与 stats.subjects[*].topics 逐科一致', () => {
    const got = {};
    for (const e of ENTRIES) got[e.subject] = (got[e.subject] || 0) + 1;
    for (const s of Object.keys(STATS.subjects)) {
      assert.strictEqual(got[s] || 0, STATS.subjects[s].topics, '学科 ' + s + ' 的知识点数对不上 stats.json');
    }
    const sum = Object.values(got).reduce((a, b) => a + b, 0);
    assert.strictEqual(sum, PLAN.total, '分学科求和 != total');
    assert.deepStrictEqual(Object.keys(got).sort(), Object.keys(STATS.subjects).sort(), '学科名集合与 stats.json 不同');
  });

  test('每个核心知识点恰好一条、不重不漏、顺序 = topics.json 教学顺序', () => {
    assert.strictEqual(new Set(ENTRIES.map((e) => e.topicId)).size, ENTRIES.length, '存在重复 topicId');
    assert.deepStrictEqual(ENTRIES.map((e) => e.topicId), CORE.map((t) => t.id), '条目顺序/集合与 topics.json 不同');
    for (const e of ENTRIES) assert.ok(!('external' in e) || e.external !== true, '产出里混进了 external 知识点：' + e.topicId);
  });

  test('subject / grade / name 与 topics.json 逐条一致（subject 用独立重写的前缀规则反校）', () => {
    const bad = [];
    for (const t of CORE) {
      const e = ENTRY_BY_ID.get(t.id);
      if (!e) { bad.push(t.id + ':缺条目'); continue; }
      if (e.subject !== subjectOf(t)) bad.push(t.id + ':subject ' + e.subject + ' != ' + subjectOf(t));
      if (e.grade !== (t.grade == null ? null : t.grade)) bad.push(t.id + ':grade 不一致');
      if (e.name !== String(t.name == null ? '' : t.name)) bad.push(t.id + ':name 不一致');
    }
    assert.deepStrictEqual(bad.slice(0, 10), [], '字段对不上的知识点');
  });

  test('summary 的分项求和自洽（strategy / verifier / workspace 口径）', () => {
    const s = PLAN.summary;
    assert.strictEqual(s.strategy.construct + s.strategy.verify + s.strategy['human-only'], PLAN.total, 'strategy 三桶求和 != total');
    assert.strictEqual(
      s.verifier.equation + s.verifier.completeSquare + s.verifier.formParam + s.verifier['numeric-compare'] + s.verifier.none,
      PLAN.total,
      'verifier 五桶求和 != total'
    );
    for (const g of GAP_ORDER) {
      const real = ENTRIES.filter((e) => e.gaps.indexOf(g) >= 0).length;
      assert.strictEqual(s.gaps[g], real, '缺口 ' + g + ' 的 summary 计数与逐条重算不等');
    }
    for (const g of GAP_ORDER) assert.ok(s.gaps[g] >= 0 && s.gaps[g] <= PLAN.total, '缺口计数超出范围：' + g);
  });

  /* ================================================================
   * 2. 口径：gaps / strategy / verifier
   * ================================================================ */

  console.log('\n--- 口径：gaps 独立重算 + strategy 三条互斥穷尽 ---');

  test('gaps 逐条与测试侧独立重算一致（顺序也一致）', () => {
    const bad = [];
    for (const t of CORE) {
      const want = expectedGaps(t, BY_TOPIC.get(t.id) || []);
      const got = ENTRY_BY_ID.get(t.id).gaps;
      if (JSON.stringify(want) !== JSON.stringify(got)) bad.push(t.id + ': got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want));
    }
    assert.deepStrictEqual(bad.slice(0, 5), [], 'gaps 与实测不符');
  });

  test('gaps 只会出现卡面那四个名字，且不重复', () => {
    for (const e of ENTRIES) {
      assert.deepStrictEqual(e.gaps.filter((g) => GAP_ORDER.indexOf(g) < 0), [], e.topicId + ' 出现未知缺口名');
      assert.strictEqual(new Set(e.gaps).size, e.gaps.length, e.topicId + ' 缺口重复');
    }
  });

  test('human-only：现有题必须一道可机验的都没有（全是 choice，或无 verify 的文本题）', () => {
    const bad = [];
    for (const e of ENTRIES) {
      if (e.strategy !== 'human-only') continue;
      const qs = BY_TOPIC.get(e.topicId) || [];
      const offending = qs.filter(gradable);
      if (offending.length) bad.push(e.topicId + ' 有可机验题：' + offending.map((q) => q.id).join(','));
    }
    assert.deepStrictEqual(bad.slice(0, 5), [], 'human-only 判定放宽了');
  });

  test('human-only 里「非全 choice」的例外只能是 short/self 且无 verify（卡面「全是 choice」的实测例外逐个点名）', () => {
    const notAllChoice = [];
    for (const e of ENTRIES) {
      if (e.strategy !== 'human-only') continue;
      const qs = BY_TOPIC.get(e.topicId) || [];
      if (!qs.length) continue;
      if (qs.every((q) => q.type === 'choice')) continue;
      notAllChoice.push(e.topicId);
      for (const q of qs) {
        if (q.type === 'choice') continue;
        assert.ok(q.type === 'short' || q.type === 'self', e.topicId + ' 的非 choice 题不是文本题：' + q.id + '(' + q.type + ')');
        assert.ok(!q.verify, e.topicId + ' 的非 choice 题带 verify 却仍判 human-only：' + q.id);
      }
    }
    /* 断言「例外集」= 实测那批点：非全 choice 且没有可机验题 —— 与 human-only 集合自洽。
     * 这里不写死数量，只要求两边完全相等。 */
    const derived = [];
    for (const t of CORE) {
      const qs = BY_TOPIC.get(t.id) || [];
      if (!qs.length) continue;
      if (qs.every((q) => q.type === 'choice')) continue;
      if (qs.some(gradable)) continue;
      derived.push(t.id);
    }
    assert.deepStrictEqual(notAllChoice.sort(), derived.sort(), 'human-only 的例外集与实测口径不自洽');
  });

  test('construct|verify：每个知识点至少有一道 numeric 或带 verify 的题', () => {
    const bad = [];
    for (const e of ENTRIES) {
      if (e.strategy === 'human-only') continue;
      const qs = BY_TOPIC.get(e.topicId) || [];
      const ok = qs.some((q) => q.type === 'numeric') || qs.some((q) => typeof q.verify === 'string' && q.verify.trim() !== '');
      if (!ok) bad.push(e.topicId + ' 既无 numeric 也无 verify 题');
    }
    assert.deepStrictEqual(bad.slice(0, 5), [], 'construct/verify 判定过宽');
  });

  test('strategy 三值互斥且穷尽；verifier 与 strategy 搭配合法', () => {
    const ALLOWED = {
      'human-only': [null],
      construct: ['equation', 'completeSquare', 'formParam'],
      verify: ['numeric-compare', null],
    };
    for (const e of ENTRIES) {
      assert.ok(ALLOWED[e.strategy], e.topicId + ' 出现未知 strategy：' + e.strategy);
      assert.ok(ALLOWED[e.strategy].indexOf(e.verifier) >= 0, e.topicId + ' 的 verifier=' + e.verifier + ' 与 strategy=' + e.strategy + ' 不搭');
    }
  });

  test('construct 的知识点必须带 verify 的 numeric 题（闭式关系在现库里有实证）', () => {
    const bad = [];
    for (const e of ENTRIES) {
      if (e.strategy !== 'construct') continue;
      const qs = BY_TOPIC.get(e.topicId) || [];
      if (!qs.some((q) => q.type === 'numeric' && typeof q.verify === 'string' && q.verify.trim() !== '')) bad.push(e.topicId);
    }
    assert.deepStrictEqual(bad, [], 'construct 但库里没有带 verify 的 numeric 题');
  });

  test('construct 的 verifier 与命中族一致（用 diagnose/llm-eval.js 现场重跑验证器反校）', () => {
    const LLM_EVAL = require(path.join(ROOT, 'diagnose', 'llm-eval.js'));
    const bad = [];
    let checked = 0;
    for (const e of ENTRIES) {
      if (e.strategy !== 'construct') continue;
      const qs = (BY_TOPIC.get(e.topicId) || []).filter((q) => q.type === 'numeric');
      /* 期望值独立推：方程族就是 equation；配方法族看库里哪一族验证器真的能过，
       * 都对不上才落到默认的 completeSquare（构造器最容易做 100% 可测的那一族）。 */
      let want;
      if (e.family === 'equation') want = 'equation';
      else if (qs.some((q) => LLM_EVAL.verifyCompletingSquare(q.prompt, q.answer).ok)) want = 'completeSquare';
      else if (qs.some((q) => LLM_EVAL.verifyFormParam(q.prompt, q.answer).ok)) want = 'formParam';
      else want = 'completeSquare';
      checked += 1;
      if (e.verifier !== want) bad.push(e.topicId + ': verifier=' + e.verifier + ' 期望 ' + want);
    }
    assert.ok(checked > 0, '没有任何 construct 知识点，这条断言空转了');
    assert.deepStrictEqual(bad.slice(0, 5), [], 'verifier 族选错');
  });

  test('闭式族词命中 + 有 verify 的 numeric + 非应用/建模题 ⇒ 必须是 construct（反校 strategy 判定没漏）', () => {
    /* 测试侧独立写一份「强信号」族词表：只放不会有歧义的词。
     * 故意不放「公式法 / 因式分解法 / 直接开平方法」——实测 cnm_152「公式法：平方差」、
     * cnm_153「公式法：完全平方」是整式乘法的乘法公式（同章无「方程」），不是解方程。 */
    const STRONG = /(配方法|求根公式|根与系数的关系|解方程|方程的解|方程的根|一元一次方程|一元二次方程|二元一次方程|三元一次方程|方程组|分式方程)/;
    const NON_TEMPLATE = new Set(['modeling', 'application']);
    const TOPIC_BY_ID = new Map(TOPICS.map((t) => [t.id, t]));
    const missed = [];
    for (const e of ENTRIES) {
      if (e.strategy === 'construct') continue;
      const t = TOPIC_BY_ID.get(e.topicId);
      if (!t || !STRONG.test(String(t.name || ''))) continue;
      if (NON_TEMPLATE.has(t.type)) continue;
      const qs = BY_TOPIC.get(e.topicId) || [];
      if (!qs.some((q) => q.type === 'numeric' && typeof q.verify === 'string' && q.verify.trim() !== '')) continue;
      missed.push(e.topicId + '(' + t.name + ') 判成了 ' + e.strategy);
    }
    assert.deepStrictEqual(missed.slice(0, 5), [], '该判 construct 的闭式族被漏掉');
  });

  test('existing 与 questions.json 的分组完全一致（不重不漏、顺序一致）', () => {
    const bad = [];
    for (const e of ENTRIES) {
      const want = (BY_TOPIC.get(e.topicId) || []).map((q) => q.id);
      if (JSON.stringify(want) !== JSON.stringify(e.existing)) bad.push(e.topicId);
    }
    assert.deepStrictEqual(bad.slice(0, 5), [], 'existing 与题库分组不一致');
    const totalExisting = ENTRIES.reduce((a, e) => a + e.existing.length, 0);
    assert.strictEqual(totalExisting, QUESTIONS.length, 'existing 汇总题数与 questions.json 不等（有题被漏掉/重复）');
  });

  /* ================================================================
   * 3. 闭包：闭合、hard 边在内、不含后继
   * ================================================================ */

  console.log('\n--- 闭包：传递闭合 + hard 边在内 + 与后继不相交 ---');

  const EDGES = [];
  const depDir = path.join(ROOT, 'data', 'dependencies');
  for (const f of fs.readdirSync(depDir).filter((x) => x.endsWith('.json')).sort()) {
    for (const e of JSON.parse(fs.readFileSync(path.join(depDir, f), 'utf8'))) {
      EDGES.push({ topicId: e.topicId, prerequisiteId: e.prerequisiteId, strength: e.strength });
    }
  }
  const EDGE_COUNT_IN_STATS = STATS.total.edges;

  test('依赖边总数与 stats.total.edges 一致（说明读的是同一批边）', () => {
    assert.strictEqual(EDGES.length, EDGE_COUNT_IN_STATS, '读到的边数与 stats.total.edges 不等');
  });

  test('prereqClosure 传递闭合：闭包内每个点的前置也必须在闭包内', () => {
    const pre = new Map();
    for (const e of EDGES) {
      if (!pre.has(e.topicId)) pre.set(e.topicId, []);
      pre.get(e.topicId).push(e.prerequisiteId);
    }
    const bad = [];
    for (const e of ENTRIES) {
      const set = new Set(e.prereqClosure);
      for (const p of e.prereqClosure) {
        for (const grand of pre.get(p) || []) {
          if (grand !== e.topicId && !set.has(grand)) bad.push(e.topicId + ': 缺 ' + grand + '（' + p + ' 的前置）');
        }
      }
    }
    assert.deepStrictEqual(bad.slice(0, 5), [], '闭包不闭合');
  });

  test('dependencies 里的 hard 边必须在闭包内（含闭包成员自身的 hard 前置）', () => {
    const hardPre = new Map();
    for (const e of EDGES) {
      if (e.strength !== 'hard') continue;
      if (!hardPre.has(e.topicId)) hardPre.set(e.topicId, []);
      hardPre.get(e.topicId).push(e.prerequisiteId);
    }
    const bad = [];
    for (const e of ENTRIES) {
      const set = new Set(e.prereqClosure);
      const need = (hardPre.get(e.topicId) || []).concat(...e.prereqClosure.map((p) => hardPre.get(p) || []));
      for (const p of need) if (!set.has(p)) bad.push(e.topicId + ': 硬前置 ' + p + ' 不在闭包内');
    }
    assert.deepStrictEqual(bad.slice(0, 5), [], 'hard 边漏出闭包');
  });

  test('闭包与后继不相交、且都不含自身', () => {
    const bad = [];
    for (const e of ENTRIES) {
      const clo = new Set(e.prereqClosure);
      if (clo.has(e.topicId)) bad.push(e.topicId + ': 闭包含自身');
      if (e.descendants.indexOf(e.topicId) >= 0) bad.push(e.topicId + ': 后继含自身');
      for (const d of e.descendants) if (clo.has(d)) bad.push(e.topicId + ': 后继 ' + d + ' 同时出现在闭包里');
      if (new Set(e.descendants).size !== e.descendants.length) bad.push(e.topicId + ': 后继有重复');
      if (new Set(e.prereqClosure).size !== e.prereqClosure.length) bad.push(e.topicId + ': 闭包有重复');
    }
    assert.deepStrictEqual(bad.slice(0, 5), [], '闭包与后继关系不成立');
  });

  test('descendants 传递闭合（反向边闭包），且只含核心知识点', () => {
    const post = new Map();
    for (const e of EDGES) {
      if (!post.has(e.prerequisiteId)) post.set(e.prerequisiteId, []);
      post.get(e.prerequisiteId).push(e.topicId);
    }
    const bad = [];
    for (const e of ENTRIES) {
      const set = new Set(e.descendants);
      for (const d of e.descendants) {
        if (!CORE_IDS.has(d)) bad.push(e.topicId + ': 后继 ' + d + ' 不在核心知识点里');
        for (const child of post.get(d) || []) if (child !== e.topicId && !set.has(child)) bad.push(e.topicId + ': 后继缺 ' + child);
      }
    }
    assert.deepStrictEqual(bad.slice(0, 5), [], '后继集合不闭合');
  });

  /* ================================================================
   * 4. 幂等：两次运行字节级一致
   * ================================================================ */

  console.log('\n--- 幂等：同输入两次运行字节级一致 ---');

  test('两次独立运行 sha256 相同', () => {
    assert.strictEqual(runA.sha, runB.sha, '两次运行字节不同：' + runA.sha + ' vs ' + runB.sha);
    assert.ok(runA.bytes.length > 0, '输出为空');
  });

  test('输出里没有时间戳/随机量残留（同内容再序列化一次仍相同）', () => {
    const again = mod.serializePlan(JSON.parse(runA.bytes.toString('utf8')));
    assert.strictEqual(crypto.createHash('sha256').update(again).digest('hex'), runA.sha, '反序列化再序列化字节变了');
  });

  /* ================================================================
   * 5. 红线：零网络、零时钟、零随机、不写 data/
   * ================================================================ */

  console.log('\n--- 红线：只读 data/、零网络 ---');

  const SRC = fs.readFileSync(SCRIPT, 'utf8');
  const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  test('脚本源码不含 fetch / http / XMLHttpRequest（零网络）', () => {
    assert.ok(!/\bfetch\s*\(/.test(CODE), '发现 fetch 调用');
    assert.ok(!/https?:/.test(CODE.replace(/https?:\/\/github[^\s'"]*/g, '')), '发现网络 URL');
    assert.ok(!/XMLHttpRequest/.test(CODE), '发现 XMLHttpRequest');
  });

  test('脚本源码不含 Date.now / Math.random / new Date（幂等前提）', () => {
    assert.ok(!/Date\.now/.test(CODE), '发现 Date.now');
    assert.ok(!/Math\.random/.test(CODE), '发现 Math.random');
    assert.ok(!/new Date\s*\(/.test(CODE), '发现 new Date');
  });

  test('只有 fs.readFileSync/readdirSync 读入，写盘只有一个出口且拒绝 data/', () => {
    const writes = (CODE.match(/writeFileSync/g) || []).length;
    assert.strictEqual(writes, 1, '写盘出口应只有 writePlan 一处，实测 ' + writes + ' 处');
    assert.throws(() => mod.writePlan(path.join(ROOT, 'data', 'evil.json'), { topics: [] }), /拒绝写入 data\//,
      'writePlan 必须拒绝写 data/');
  });

  test('.gitignore 忽略 tmp/（产物不入库）', () => {
    const gi = fs.readFileSync(GITIGNORE, 'utf8').split('\n').map((l) => l.trim());
    assert.ok(gi.indexOf('tmp/') >= 0 || gi.indexOf('/tmp/') >= 0 || gi.indexOf('tmp') >= 0, '.gitignore 缺少 tmp/');
  });

  test('--help 里写明默认产物路径', () => {
    const out = execFileSync(process.execPath, [SCRIPT, '--help'], { cwd: ROOT, encoding: 'utf8' });
    assert.ok(out.indexOf('tmp/gap-plan.json') >= 0, '--help 未写默认产物路径');
  });

  /* ================================================================
   * 6. 自检：合成数据反证断言有效（该红的必须真红）
   * ================================================================ */

  console.log('\n--- 自检：合成数据反证断言有效 ---');

  const synthTopic = (id, extra) => Object.assign({
    id, name: '合成知识点 ' + id, domain: '数与代数', grade: 7, semester: '上', chapter: '合成章',
    type: 'procedural', description: '', mastery_criteria: [], diagnostic_question: { question: '', answer: '' },
    external: false, standards: [{ id: 'cms-2022:1.NA.01', confidence: 'exact' }],
  }, extra || {});
  const synthQ = (id, topicId, extra) => Object.assign({ id, topicId, type: 'choice', difficulty: 'basic', prompt: 'p', answer: 'A' }, extra || {});

  test('有 numeric 题的知识点不会被判 human-only（反证第 2 组断言能红）', () => {
    const topics = [synthTopic('cnm_t001')];
    const questions = [synthQ('cnm_t001_q1', 'cnm_t001'), synthQ('cnm_t001_q2', 'cnm_t001', { type: 'numeric', answer: '2', verify: '1+1' })];
    const entry = mod.planForTopic(topics[0], questions);
    assert.ok(entry.strategy !== 'human-only', '带 numeric 题仍被判 human-only，断言无效');
    assert.strictEqual(entry.strategy, 'verify');
    assert.strictEqual(entry.verifier, 'numeric-compare');
  });

  test('全 choice 的知识点必判 human-only 且 verifier=null', () => {
    const t = synthTopic('cnm_t002');
    const qs = [synthQ('cnm_t002_q1', 'cnm_t002'), synthQ('cnm_t002_q2', 'cnm_t002', { verify: '1+1' })];
    const entry = mod.planForTopic(t, qs);
    assert.strictEqual(entry.strategy, 'human-only');
    assert.strictEqual(entry.verifier, null);
  });

  test('非 choice 且带 verify 的题也算可机验（不能被判 human-only）', () => {
    /* 现库里目前没有「靠短答题 verify 撑起来的可机验知识点」（每一个 verify 类点都另有 numeric 题），
     * 所以这条只能靠合成数据守：它同时钉住 human-only 的判据是「无可机验题」而不是「无 numeric 题」。 */
    const t = synthTopic('cnm_t005');
    const qs = [synthQ('cnm_t005_q1', 'cnm_t005', { type: 'short', answer: '2', verify: '1+1' })];
    const entry = mod.planForTopic(t, qs);
    assert.strictEqual(entry.strategy, 'verify', '短答 + verify 应算可机验');
    assert.strictEqual(entry.verifier, null, '没有 numeric 题时不给 numeric-compare');
  });

  test('缺口判定：四类缺口全中/全不中的边界都正确', () => {
    const t = synthTopic('cnm_t003', { standards: [] });
    /* 空题库：没有难题、没有数值、没有配图 → 前三类必中（no-standards 由课标算，这里另测）。 */
    assert.deepStrictEqual(mod.gapsOf([]), ['no-challenge', 'no-numeric', 'no-figure'], '空题库的缺口判定不对');
    const full = mod.planForTopic(t, [
      synthQ('cnm_t003_q1', 'cnm_t003', { type: 'numeric', difficulty: 'advanced', verify: '1', answer: '1', figure: '<svg/>' }),
    ]);
    assert.deepStrictEqual(full.gaps, ['no-standards'], '有难题+数值+配图+无课标时应只中 no-standards');
    const withStd = mod.planForTopic(synthTopic('cnm_t004'), [
      synthQ('cnm_t004_q1', 'cnm_t004', { type: 'numeric', difficulty: 'challenge', verify: '1', answer: '1', figure: '<svg/>' }),
    ]);
    assert.deepStrictEqual(withStd.gaps, [], '四类都齐时不应报缺口');
  });

  test('闭包：小 DAG 上算得对（含 soft 边），有环必须报错', () => {
    const ids = ['cnm_t010', 'cnm_t011', 'cnm_t012'];
    const edges = [
      { topicId: 'cnm_t011', prerequisiteId: 'cnm_t010', strength: 'hard' },
      { topicId: 'cnm_t012', prerequisiteId: 'cnm_t011', strength: 'soft' },
    ];
    const clo = mod.buildClosures(ids, edges);
    assert.deepStrictEqual(clo.get('cnm_t012').prereqClosure, ['cnm_t010', 'cnm_t011'], '三段链闭包不对');
    assert.deepStrictEqual(clo.get('cnm_t010').descendants, ['cnm_t011', 'cnm_t012'], '反向闭包不对');
    assert.deepStrictEqual(clo.get('cnm_t010').prereqClosure, [], '根节点闭包应为空');
    assert.throws(() => mod.buildClosures(ids, edges.concat([{ topicId: 'cnm_t010', prerequisiteId: 'cnm_t012', strength: 'hard' }])), /cycle/, '环必须报错');
    assert.throws(() => mod.buildClosures(ids, [{ topicId: 'cnm_t010', prerequisiteId: 'cnm_zzz', strength: 'hard' }]), /unknown endpoint/, '未知端点必须报错');
  });

  test('与 stats.json 对不上时 buildPlan 必须抛错（fail-closed）', () => {
    const fakeStats = { total: { topics: 999 }, subjects: { math: { topics: 999 } } };
    assert.throws(() => mod.buildPlan({
      topics: [synthTopic('cnm_t020')],
      questions: [synthQ('cnm_t020_q1', 'cnm_t020', { type: 'numeric', verify: '1', answer: '1' })],
      stats: fakeStats,
      edges: [],
    }), /对不上/, 'stats 不一致时必须失败而不是静默产出');
  });

  console.log('\n' + (failed === 0 ? '全部通过' : '存在失败') + '：' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.log('  FAIL 测试框架出错\n       ' + String((e && e.stack) || e).split('\n').slice(0, 8).join('\n       '));
  failed += 1;
  console.log('\n存在失败：' + passed + ' passed, ' + failed + ' failed');
  process.exit(1);
});
