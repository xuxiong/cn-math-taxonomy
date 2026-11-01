#!/usr/bin/env node
/* 函数画板「只标已知量」审计（P 卡）—— 只读，不写回题库、不调 LLM。
 *
 * 规则（与 geomlab D 卡同一条）：
 *   画板上只许出现题面给出的已知量；由已知量推出的量（顶点坐标、最值、对称轴位置、
 *   根的数值、截距坐标、区间端点的函数值）在图上必须留 '?'，等学生自己算。
 *   所以「文案/图上静态标注里出现了答案的数字」= 图在给答案。
 *
 * 判定口径（t_b72f89d1 改写：不再有任何静默丢弃）：
 *   · 检修集合 = 实际会挂图的 (题, 画板, intent)：
 *       有 LLM 匹配缓存 → 用缓存里真实挂上的组合（学生真的会看到的那条文案）；
 *       没缓存 → 该题 × 该画板的全部 intent（保守全扫）。
 *   · 答案数字按**学生要写的那个数**抠：先去括号（"(0,4)，(2,0)" 里的 0 是坐标占位不是答案），
 *     再抠负数/分数/小数。
 *   · 文案/标注里出现的数字逐个归三类，**任何一类都记账，没有「静默放过」**：
 *       a) 题面已知量 → 允许。题面原样给出的数（区间端点、系数）+ 省略写法里的 ±1 系数
 *          （"y = x²" 的 a=1、"y = x" 的 k=1、"y = (x-2)" 的 a=1）由 coeffGiven() 补进已知集。
 *       b) 结构性常量 → 允许，但必须逐条列出。判据是**扰动法**：把参数换成两组不同的合法取值
 *          重新生成同一条文案（perturbCandidate），三份（本题 + 两次扰动）都出现的数 = 模板里
 *          写死的常量（例如 "a > 0" 里的 0），与本题参数无关，不构成泄漏线索；只在本题参数下
 *          才出现的数 = 派生量，落进 c)。
 *       c) 其余 → 泄漏，照报。
 *     （旧版这里是一行 `if (Math.abs(n) <= 1) return;`：它把所有 |n|≤1 的数字一律静默放过，
 *      既看不到放过的是哪些数，也会把「答案真的是 0 或 1」的泄漏一起盖掉。）
 *   · 逐题账：无画板候选 / 答案无法判定（逐条列 id + 原因）/ 组合无文案（逐条列）/
 *     可判定但零泄漏（通过）—— 四类相加必须覆盖全库，报告末尾给出双口径覆盖率。
 *
 * 用法（CLI 不变）：
 *   node scripts/audit_funclab_notes.js             # 全扫
 *   node scripts/audit_funclab_notes.js --sim-delivered  # 每道挂图题只检「实际会用到的那条文案」（无 LLM 时的近似）
 *   node scripts/audit_funclab_notes.js --verbose   # 逐条打印文案
 *   node scripts/audit_funclab_notes.js --json      # 机器可读
 * 退出码：泄漏 0 条 → 0；有泄漏 → 1。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const QUESTIONS = require(path.join(ROOT, 'data/questions.json'));
const Funclab = require(path.join(ROOT, 'diagnose/funclab.js'));

const argv = process.argv.slice(2);
const VERBOSE = argv.indexOf('--verbose') >= 0 || argv.indexOf('-v') >= 0;
const AS_JSON = argv.indexOf('--json') >= 0;
const CACHE = path.join(os.tmpdir(), 'cnm-labmatch-audit-cache.json');

/* ------------------------------------------------------------ 数值工具 */

function key(n) {
  if (!isFinite(n)) return null;
  const r = Math.round(n * 1e6) / 1e6;
  return String(r === 0 ? 0 : r);
}

/** 自由文本里的全部数值（含负号、分数、小数） */
function numbersIn(text) {
  const out = [];
  const s = String(text == null ? '' : text).replace(/[−–—]/g, '-');
  const re = /-?\d+(?:\.\d+)?(?:\s*\/\s*-?\d+(?:\.\d+)?)?/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const tok = m[0].replace(/\s+/g, '');
    if (tok.indexOf('/') >= 0) {
      const parts = tok.split('/');
      const v = Number(parts[0]) / Number(parts[1]);
      if (isFinite(v)) out.push(v);
    } else if (isFinite(Number(tok))) out.push(Number(tok));
  }
  return out;
}

/** 答案里「学生要写的数」：先去括号（坐标占位 0 不算答案），再抠数值 */
function answerNumbers(answer) {
  const s = String(answer == null ? '' : answer)
    .replace(/[（(][^）)]*[）)]/g, ' ')          // 去掉整组坐标：(0,4)、(2,0)
    .replace(/[（）()]/g, '');
  return numbersIn(s);
}

/** 题面原样给出的数（区间端点 + 函数表达式里直接印出的常数）—— P 卡允许显示 */
function promptGiven(prompt, params) {
  const known = new Set();
  const push = function (n) { const k = key(n); if (k != null) known.add(k); };
  if (params && isFinite(params.xMin)) push(params.xMin);
  if (params && isFinite(params.xMax)) push(params.xMax);
  /* 题面里出现的**全部字面数字**都算已知：学生一眼能读到。
   * 注意这只会放宽判定，不会放进「配方算出来的 h/k」—— 那种数题面上根本没有。 */
  numbersIn(prompt).forEach(push);
  /* 省略系数写法（x²、-x² 的 ±1）也是题面给出的 */
  const s = String(prompt || '').replace(/[（]/g, '(').replace(/[）]/g, ')');
  if (/(?:^|[=+\-])\s*x²/.test(s)) push(1);
  if (/(?:^|[=+\-])\s*-\s*x²/.test(s)) push(-1);
  const re = /(?:^|[=+\-*/^(])\s*(-?\d+(?:\.\d+)?)\s*(?=[a-zA-Z^²])/g;
  let m;
  while ((m = re.exec(s)) !== null) push(Number(m[1]));
  return known;
}

/**
 * 解析出来的 ±1 系数 = 题面原样给出的系数。
 * y = x² 的 a=1、y = -x² 的 a=-1、y = (x-2) 的 a=1、y = x 的 k=1：
 * 题面用省略写法印出来，学生一眼读得到，所以文案里写 "a = 1：" 不构成泄漏。
 * 只补 ±1 —— 其它系数（a=3 之类）题面上本来就印着，numbersIn(prompt) 已经收进去了。
 */
function coeffGiven(cand) {
  const out = [];
  const push1 = function (v) { if (v === 1 || v === -1) out.push(v); };
  if (!cand) return out;
  if (cand.type === 'quadratic') push1(cand.a);
  else if (cand.type === 'linear') { push1(cand.k); push1(cand.b); }
  else if (cand.type === 'inverse') push1(cand.k);
  return out;
}

/**
 * 图上静态标注（学生不点「我算好了」就能看到的数值）。
 * 与 diagnose/funclab.js 的 annotate()/drawInterval() 一一对应：
 * P 卡之后派生量全是 '?'，只有区间端点 x 带真值；任何新增数值标注都必须同步改这里。
 */
function annotationValues(lab, intent, params) {
  const p = params || {};
  const t = Funclab.CAP_TYPE[lab];
  const out = { '顶点': '?', '对称轴': '?' };
  if (t === 'quadratic') {
    if (intent === '最小值' || intent === '最大值') out['最值'] = '?';
    if (intent === '方程的根' || intent === '与x轴交点的横坐标' || intent === '零点' ||
      intent === 'y>0或y<0的x范围' || intent === 'x取何值时函数值为正/负') out['交点'] = '?';
  } else if (t === 'linear') {
    out['y 轴交点'] = '?';
    out['x 轴交点'] = '?';
  } else {
    out['象限说明'] = null;                       // 反比例：图上不标数值
  }
  out['区间端点 x'] = (p.xMin != null && p.xMax != null) ? [p.xMin, p.xMax] : null;
  out['区间端点函数值'] = '?';
  return out;
}

/* ------------------------------------------------------------ 结构性常量（扰动法） */

/** 同型、但参数全不同的合法候选：用来把「模板写死的常量」和「本题参数推出来的数」分开。
 *  tri 给出 (a 或 k, h, k 或 b)：取几组彼此都不同的怪值，答案数字撞上它们的概率可忽略。 */
function perturbCandidate(cand, tri) {
  if (!cand) return null;
  const p = { type: cand.type };
  const v1 = tri[0], v2 = tri[1], v3 = tri[2];
  if (cand.type === 'quadratic') {
    p.a = (cand.a < 0 ? -v1 : v1);
    p.h = v2;
    p.k = v3;
  } else if (cand.type === 'linear') {
    p.k = (cand.k < 0 ? -v1 : v1);
    p.b = v3;
  } else {
    p.k = (cand.k < 0 ? -v1 : v1);
  }
  if (isFinite(cand.xMin) && isFinite(cand.xMax)) { p.xMin = cand.xMin + v2; p.xMax = cand.xMax + v3; }
  /* base 只喂渲染，不影响 noteText；给同型合法骨架，避免下游取值 undefined */
  if (cand.base) {
    if (cand.type === 'quadratic') p.base = { type: 'quadratic', a: p.a, h: p.h, k: 0 };
    else if (cand.type === 'linear') p.base = { type: 'linear', k: p.k, b: 0 };
  }
  return p;
}

/** 两组彼此都不同的扰动参数（负数留在负数侧，避免文案分支翻转以外的意外） */
const PERTURB_SETS = [[997.5, 1009.25, 1013.75], [1499.5, 1523.75, 1627.5]];

/**
 * 该 (画板, intent) 文案里的结构性常量集合：
 * 把参数换成**两组**不同的合法取值重新生成文案，三份（本题 + 两次扰动）都出现的数值
 * = 与本题参数无关的模板常量（如 "a > 0" 里的 0），不构成泄漏线索。
 * 扰动后拿不到文案（noteText 返回 null）时返回空集：宁可把它当派生量去查，也不放过。
 */
function structuralNumbers(lab, intent, cand, note) {
  const out = new Set();
  let common = null;
  PERTURB_SETS.forEach(function (tri) {
    const pert = perturbCandidate(cand, tri);
    if (!pert) { common = new Set(); return; }
    let alt = null;
    try { alt = Funclab.noteText(lab, intent, pert); } catch (e) { alt = null; }
    if (alt == null) { common = new Set(); return; }
    const set = new Set(numbersIn(alt).map(key).filter(function (k) { return k != null; }));
    if (common === null) { common = set; return; }
    const next = new Set();
    common.forEach(function (k) { if (set.has(k)) next.add(k); });
    common = next;
  });
  if (!common || !common.size) return out;
  numbersIn(note).forEach(function (n) {
    const k = key(n);
    if (k != null && common.has(k)) out.add(k);
  });
  return out;
}

/* ------------------------------------------------------------ 检修集合 */

/** 有缓存就用缓存里「LLM 真正挂上」的 (题 → [{lab,intent}])；没缓存返回 null */
function cachedPlan() {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    const table = raw['cnmLabMatch.v1'] || raw;
    if (!table || typeof table !== 'object') return null;
    const map = {};
    let n = 0;
    Object.keys(table).forEach(function (k) {
      const v = table[k];
      if (!v || !v.match || !Funclab.CAPABILITIES[v.match]) return;
      const id = k.split('@')[0].split(':')[0];
      if (!map[id]) map[id] = [];
      map[id].push({ lab: v.match, intent: Funclab.intentKey(v.intent) });
      n++;
    });
    return n ? map : null;
  } catch (e) { return null; }                     // 无缓存 → 全扫
}

const plan = cachedPlan();

/** 答案无法判定时给一句具体原因（不许只写「跳过」） */
function undecidableReason(answer) {
  const raw = String(answer == null ? '' : answer).trim();
  if (!raw) return '答案为空';
  if (/^[A-Z]$/.test(raw)) return '答案只有选项字母（本脚本不展开选项文本）';
  if (/[（(]\s*-?\d/.test(raw)) return '答案只有坐标对（坐标按占位规则不参与数值比较）';
  if (/[a-zA-Z√²³π∞]/.test(raw)) return '答案含字母/根号/不等号（不是可比的数值）';
  return '答案里没有可用数值';
}

/* ------------------------------------------------------------ 主流程 */

const leaks = [];
const checked = [];
const structuralHits = [];
const undecidable = [];
const noNote = [];
const passedQuestions = [];
const basicQuestions = [];
const basicPassed = [];
let noteCount = 0;
let givenHits = 0;
let candidateQuestions = 0;
let auditedQuestions = 0;
let noCandidate = 0;

QUESTIONS.forEach(function (item) {
  const cand = Funclab.labForScene(item.topicId, item.prompt, { itemId: item.id });
  if (!cand) { noCandidate++; return; }
  candidateQuestions++;
  const answers = answerNumbers(item.answer);
  const answerKeys = new Set(answers.map(key).filter(function (k) { return k != null; }));
  if (!answerKeys.size) {
    /* 有画板但答案里抽不出可比的数：单独记账、逐条列出，不再静默 return */
    undecidable.push({ id: item.id, answer: item.answer, reason: undecidableReason(item.answer) });
    return;
  }
  auditedQuestions++;
  const given = promptGiven(item.prompt, cand);
  coeffGiven(cand).forEach(function (v) {
    const k = key(v);
    if (k != null) given.add(k);
  });
  /* 「|n|≤1 基础题」：最该被画板覆盖的基础形态（y=x²、y=x、k=1…） */
  const isBasic = (cand.type === 'quadratic' && Math.abs(cand.a) <= 1)
    || (cand.type === 'linear' && (Math.abs(cand.k) <= 1 || Math.abs(cand.b) <= 1))
    || (cand.type === 'inverse' && Math.abs(cand.k) <= 1);
  if (isBasic) basicQuestions.push(item.id);

  /* 要检的 (画板, intent) 组合 */
  const combos = [];
  if (plan && plan[item.id]) {
    plan[item.id].forEach(function (c) { combos.push(c); });
  } else {
    Object.keys(Funclab.capabilitiesFor(cand.type)).forEach(function (lab) {
      Funclab.capabilitiesFor(cand.type)[lab].canAnswer.forEach(function (intent) {
        combos.push({ lab: lab, intent: Funclab.intentKey(intent) });
      });
    });
  }

  let questionLeaks = 0;
  let questionNotes = 0;
  combos.forEach(function (c) {
    const note = Funclab.noteText(c.lab, c.intent, cand);
    if (note == null) {                             // 组合无文案：逐条记账
      noNote.push({ id: item.id, lab: c.lab, intent: c.intent });
      return;
    }
    questionNotes++;
    noteCount++;
    const ann = annotationValues(c.lab, c.intent, cand);
    const seen = [];
    numbersIn(note).forEach(function (n) { seen.push({ where: 'note', n: n }); });
    Object.keys(ann).forEach(function (k) {
      const v = ann[k];
      if (typeof v === 'number') seen.push({ where: '图上标注:' + k, n: v });
      else if (Array.isArray(v)) v.forEach(function (n) { seen.push({ where: '图上标注:' + k, n: n }); });
    });
    /* 结构性常量按 note 的扰动交集算一次，标注里的数照旧走已知量/派生量两条路 */
    const structural = structuralNumbers(c.lab, c.intent, cand, note);
    seen.forEach(function (hit) {
      const k = key(hit.n);
      if (k == null || !answerKeys.has(k)) return;    // 不是答案数字
      if (given.has(k)) { givenHits++; return; }      // 题面已知量，允许
      /* 结构性 0/1（"a > 0" 里的 0）：任何参数下都这么写 → 允许，但逐条列出，不许静默 */
      if (structural.has(k)) {
        structuralHits.push({
          id: item.id, lab: c.lab, intent: c.intent, value: hit.n, where: hit.where,
          answer: item.answer
        });
        return;
      }
      questionLeaks++;
      leaks.push({
        id: item.id, lab: c.lab, intent: c.intent, value: hit.n, where: hit.where,
        answer: item.answer, kind: 'derived',
        note: hit.where === 'note' ? note : '(图上静态标注)'
      });
    });
    checked.push({ id: item.id, lab: c.lab, intent: c.intent, note: note, answer: item.answer });
  });
  if (questionNotes > 0 && questionLeaks === 0) {
    passedQuestions.push(item.id);
    if (isBasic) basicPassed.push(item.id);
  }
});

/* ------------------------------------------------------------ 覆盖率（双口径） */

const TOTAL = QUESTIONS.length;
const DECIDED = auditedQuestions;
const PASSED = passedQuestions.length;
function pct1(a, b) { return b ? (a / b * 100).toFixed(1) + '%' : '—'; }
const coverage = {
  full: pct1(PASSED, TOTAL),                  // 分母 = 全库（含无画板候选 / 无法判定）
  candidate: pct1(PASSED, candidateQuestions),// 分母 = 有画板候选的题
  decided: pct1(PASSED, DECIDED),             // 分母 = 排除无法判定后
  basic: { k: basicQuestions.length, passed: basicPassed.length, rate: pct1(basicPassed.length, basicQuestions.length) }
};

if (AS_JSON) {
  console.log(JSON.stringify({
    noteCount: noteCount,
    source: plan ? 'cache' : 'all-intents',
    leaks: leaks,
    total: TOTAL,
    candidateQuestions: candidateQuestions,
    auditedQuestions: auditedQuestions,
    skipped: { noCandidate: noCandidate },
    undecidable: undecidable,
    noNote: noNote,
    structuralHits: structuralHits,
    givenHits: givenHits,
    passedQuestions: PASSED,
    coverage: coverage
  }, null, 1));
} else {
  if (VERBOSE) {
    console.log('—— 逐条文案（' + (plan ? 'LLM 匹配缓存' : '全部画板 × intent') + '） ——');
    checked.forEach(function (r) {
      console.log('\n[' + r.id + '] ' + r.lab + ' / ' + r.intent + '   答案：' + r.answer);
      console.log('  文案：' + r.note);
    });
    console.log('');
  }
  console.log('审计 ' + noteCount + ' 条（画板 × intent）文案 + 对应图上静态标注   来源=' + (plan ? 'LLM 匹配缓存（学生真会看到的组合）' : '全部 intent') );
  if (leaks.length) {
    console.log('\n✗ 泄漏 ' + leaks.length + ' 处（派生量数值出现在文案/图上标注里）：');
    leaks.forEach(function (l) {
      console.log('  ' + l.id + ' / ' + l.lab + ' / ' + l.intent + ' → ' + l.value + '（' + l.where + '）  答案=' + l.answer);
      console.log('      ' + l.note);
    });
  } else {
    console.log('✓ 没有一处文案或图上标注直接报出派生量数值（答案数字 0 处泄漏）');
  }

  /* ---------- 双口径汇总（固定输出，不受 --verbose 影响） ---------- */
  console.log('');
  console.log('—— 双口径汇总 ——');
  console.log('总计 ' + TOTAL + ' 题；可判定 ' + DECIDED + ' 题；其中 |n|≤1 基础题 ' + basicQuestions.length
    + ' 题（覆盖率 ' + coverage.basic.rate + '，通过 ' + basicPassed.length + '/' + basicQuestions.length
    + '）；无法判定 ' + undecidable.length + ' 题（逐条列出）');
  console.log('覆盖率（全量口径，分母 = 总计 ' + TOTAL + ' 题）：' + coverage.full);
  console.log('覆盖率（有画板候选口径，分母 = ' + candidateQuestions + ' 题）：' + coverage.candidate);
  console.log('覆盖率（排除无法判定后，分母 = 可判定 ' + DECIDED + ' 题）：' + coverage.decided);
  console.log('无画板候选（不进上面任何分母）：' + noCandidate + ' 题');
  console.log('题面已知量命中（允许，不计数为泄漏）：' + givenHits + ' 处');
  console.log('结构性常量（允许出现，' + structuralHits.length + ' 处）：'
    + (structuralHits.length ? '' : ' 本库没有只靠结构常量才放过的命中'));
  structuralHits.forEach(function (s) {
    console.log('  - ' + s.id + ' / ' + s.lab + ' / ' + s.intent + '  ' + s.value + '  来自 ' + s.where);
  });
  console.log('无法判定（' + undecidable.length + ' 题，逐条）：' + (undecidable.length ? '' : '（无）'));
  undecidable.forEach(function (u) {
    console.log('  - ' + u.id + '  答案=' + u.answer + '  原因=' + u.reason);
  });
  if (noNote.length) {
    console.log('组合无文案（' + noNote.length + ' 条，逐条）：');
    noNote.forEach(function (n) { console.log('  - ' + n.id + ' / ' + n.lab + ' / ' + n.intent); });
  } else {
    console.log('组合无文案：0 条');
  }
}
process.exit(leaks.length ? 1 : 0);
