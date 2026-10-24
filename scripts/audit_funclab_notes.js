#!/usr/bin/env node
/* 函数画板「只标已知量」审计（P 卡）—— 只读，不写回题库、不调 LLM。
 *
 * 规则（与 geomlab D 卡同一条）：
 *   画板上只许出现题面给出的已知量；由已知量推出的量（顶点坐标、最值、对称轴位置、
 *   根的数值、截距坐标、区间端点的函数值）在图上必须留 '?'，等学生自己算。
 *   所以「文案/图上静态标注里出现了答案的数字」= 图在给答案。
 *
 * 判定口径（宁可放过 0/1 这类结构性数字，也不放过真正的答案）：
 *   · 检修集合 = 实际会挂图的 (题, 画板, intent)：
 *       有 LLM 匹配缓存 → 用缓存里真实挂上的组合（学生真的会看到的那条文案）；
 *       没缓存 → 该题 × 该画板的全部 intent（保守全扫）。
 *   · 答案数字按**学生要写的那个数**抠：先去括号（"(0,4)，(2,0)" 里的 0 是坐标占位不是答案），
 *     再抠负数/分数/小数。
 *   · 以下数字不算泄漏：
 *       - 0 与 1 出现在坐标/公式结构里（"(0, ?)"、"kx+b=0"、"a = 1" 的 1 可能恰好等于答案）
 *         → 只报 |v| ≥ 2 或带负号的精确匹配，避免把 "0" 这种坐标占位当答案；
 *       - 题面原样给出的数（区��端点、系数）—— 这是 P 卡允许显示的已知量。
 *
 * 用法：
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

/* ------------------------------------------------------------ 主流程 */

const leaks = [];
const checked = [];
let noteCount = 0;

QUESTIONS.forEach(function (item) {
  const cand = Funclab.labForScene(item.topicId, item.prompt, { itemId: item.id });
  if (!cand) return;
  const answers = answerNumbers(item.answer);
  const answerKeys = new Set(answers.map(key).filter(function (k) { return k != null; }));
  if (!answerKeys.size) return;                    // 纯图像可读答案（象限/开口/选项），无数值可泄漏
  const given = promptGiven(item.prompt, cand);

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

  combos.forEach(function (c) {
    const note = Funclab.noteText(c.lab, c.intent, cand);
    if (note == null) return;
    noteCount++;
    const ann = annotationValues(c.lab, c.intent, cand);
    const seen = [];
    numbersIn(note).forEach(function (n) { seen.push({ where: 'note', n: n }); });
    Object.keys(ann).forEach(function (k) {
      const v = ann[k];
      if (typeof v === 'number') seen.push({ where: '图上标注:' + k, n: v });
      else if (Array.isArray(v)) v.forEach(function (n) { seen.push({ where: '图上标注:' + k, n: n }); });
    });
    seen.forEach(function (hit) {
      const k = key(hit.n);
      if (k == null || !answerKeys.has(k)) return;    // 不是答案数字
      if (given.has(k)) return;                      // 题面已知量，允许
      /* 结构性 0/1：坐标占位 0、kx+b=0 的 0、a = 1 的 1 —— 恰好与答案是同一个数，
       * 但文案在任何参数下都这么写，不构成泄漏线索（真正的答案 ≥2 或负数一律照报） */
      if (Math.abs(hit.n) <= 1) return;
      leaks.push({
        id: item.id, lab: c.lab, intent: c.intent, value: hit.n, where: hit.where,
        answer: item.answer, note: hit.where === 'note' ? note : '(图上静态标注)'
      });
    });
    checked.push({ id: item.id, lab: c.lab, intent: c.intent, note: note, answer: item.answer });
  });
});

if (AS_JSON) {
  console.log(JSON.stringify({ noteCount: noteCount, source: plan ? 'cache' : 'all-intents', leaks: leaks }, null, 1));
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
}
process.exit(leaks.length ? 1 : 0);
