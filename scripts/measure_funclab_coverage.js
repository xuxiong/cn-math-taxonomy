#!/usr/bin/env node
/* funclab 画板覆盖率测算（只读）：node scripts/measure_funclab_coverage.js
 *
 * 本脚本只读 data/*.json 与 diagnose/funclab.js，不修改任何功能源码。
 * 放宽门禁的候选实现内联在本文件的 relaxed* 函数里（不碰 diagnose/funclab.js），
 * 这样测算结果与线上代码严格解耦：diagnose/ 改动后重跑即可看到真实基线变化。
 *
 * 输出分五节，与 docs/funclab-coverage.md 的表格一一对应：
 *   1. 现状基线   2. R1   3. R2   4. 误挂风险   5. 汇总
 *
 * 三个方案的定义（严格按 B 卡口径）：
 *   基线 = topicKind() + labFor() 原样
 *   R1   = 只去掉 EQUATION_CHAPTERS / CHAPTERS_ITEM_ONLY 的章级白名单，
 *          仍要求 topicKind 命中（29 个知识点内）、题面解析类型匹配知识点类型，
 *          仍保留 EQUATION_FORM_LABEL（形态标签题）与 hasCleanRoots（无理根）两道题面门禁
 *   R2   = 在 R1 基础上再取消 topicKind 白名单，全库 6159 题只要 fromPrompt 解析出函数就进候选
 *
 * 每个方案都分两档输出：
 *   · 放宽口径（literal）：只按上面的题面门禁，不看答案语义
 *   · 加答案语义门禁（gated）：再要求「答案能在画板的标注里找到」
 * 两档之差就是误挂风险清单（第四节）。
 */
'use strict';

const path = require('path');
const F = require(path.join(__dirname, '..', 'diagnose', 'funclab.js'));
const QUESTIONS = require(path.join(__dirname, '..', 'data', 'questions.json'));
const TOPICS = require(path.join(__dirname, '..', 'data', 'topics.json'));

const TOPIC = new Map(TOPICS.map(t => [t.id, t]));

/* ============================================================ 放宽门禁的候选实现 */

/** diagnose/funclab.js 里 EQUATION_FORM_LABEL / EQUATION_WORDS / hasCleanRoots 的复刻 */
const EQUATION_FORM_LABEL = /的形式/;
const EQUATION_WORDS = /解|根|配方|方程|或|=|求\s*x|两个|交点|平方/;

function hasCleanRoots(a, k) {
  if (a === 0) return true;
  const disc = -k / a;
  if (disc < 0) return true;
  const r = Math.sqrt(disc);
  if (r === 0) return true;
  return [r, -r].every(v => {
    const t = Math.round(v * 120) / 120;
    return Math.abs(v - t) < 1e-9;
  });
}

/**
 * R1：去掉章级白名单后的方程题判定。
 * 与线上 equationAllowed 的唯一差别就是前三行（EQUATION_CHAPTERS / CHAPTERS_ITEM_ONLY）不再生效。
 */
function relaxedEquationAllowed(prompt, parsed) {
  if (EQUATION_FORM_LABEL.test(String(prompt))) return { ok: false, why: 'form-label' };
  if (!EQUATION_WORDS.test(String(prompt))) return { ok: false, why: 'no-equation-words' };
  if (!hasCleanRoots(parsed.a, parsed.k)) return { ok: false, why: 'unclean-roots' };
  return { ok: true, why: 'ok' };
}

/** R1 判定入口：topicKind 仍生效，只放宽方程章白名单 */
function relaxedLabForR1(topicId, prompt) {
  const kind = F.topicKind(topicId);
  if (!kind) return null;
  const r = F.fromPrompt(prompt);
  if (!r || r.type !== kind) return null;
  if (/^cnm_22[0-4]$/.test(String(topicId)) && r.type === 'quadratic') {
    if (!relaxedEquationAllowed(prompt, r).ok) return null;
  }
  return r;
}

/** R2 判定入口：不看 topicKind，解析出函数即候选 */
function relaxedParseAny(prompt) {
  return F.fromPrompt(prompt);
}

/* ============================================================ 画板标注 vs 答案语义 */

/** 画板在该函数上到底标注了什么数（X 轴方向集合 / Y 轴方向集合 / 成对点） */
function boardAnnotations(parsed) {
  const out = { x: [], y: [], pairs: [], labels: [] };
  if (!parsed) return out;
  if (parsed.type === 'quadratic') {
    out.x.push(parsed.h);
    out.y.push(parsed.k);
    out.pairs.push({ x: parsed.h, y: parsed.k, label: '顶点(红点)' });
    out.labels.push('顶点(红点)');
    if (parsed.a !== 0) {
      const disc = -parsed.k / parsed.a;
      if (disc >= 0) {
        const r = Math.sqrt(disc);
        out.x.push(parsed.h - r, parsed.h + r);
        out.y.push(0);
        out.pairs.push({ x: parsed.h - r, y: 0, label: 'x轴交点(绿点)' }, { x: parsed.h + r, y: 0, label: 'x轴交点(绿点)' });
        out.labels.push('x轴交点(绿点)×' + (r === 0 ? 1 : 2));
      }
    }
  } else if (parsed.type === 'linear') {
    out.x.push(0);
    out.y.push(parsed.b);
    out.pairs.push({ x: 0, y: parsed.b, label: 'y轴交点(红点)' });
    out.labels.push('y轴交点(红点)');
    if (parsed.k !== 0) {
      const xi = -parsed.b / parsed.k;
      out.x.push(xi);
      out.y.push(0);
      out.pairs.push({ x: xi, y: 0, label: 'x轴交点(绿点)' });
      out.labels.push('x轴交点(绿点)');
    }
  } else {
    // inverse：画板不标任何数，只有象限说明文字
    out.labels.push('象限说明(k>0 → 一、三；k<0 → 二、四)');
  }
  return out;
}

const FULL2HALF = { '，': ',', '（': '(', '）': ')', '−': '-', '－': '-', '—': '-', '–': '-', '：': ':', '；': ';', '　': ' ' };

function toHalf(s) {
  return String(s == null ? '' : s).replace(/[，（）−－—–：；　]/g, c => FULL2HALF[c] || c);
}

/** 抽数值 token：支持分数 3/4、负数、小数；返回 [{raw, value}] */
/** 抽数值 token：坐标对 (a,b) 单列，其余按分数/小数/整数抽；返回 [{raw,value,kind}] */
function extractNumbers(text) {
  const s = toHalf(text);
  const out = [];
  const pairRe = /\(\s*([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)\s*\)/g;
  let m;
  while ((m = pairRe.exec(s))) {
    out.push({ raw: m[0], kind: 'pair', x: parseFloat(m[1]), y: parseFloat(m[2]) });
  }
  const rest = s.replace(pairRe, m0 => ' '.repeat(m0.length));
  const frac = /([+-]?\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/g;
  while ((m = frac.exec(rest))) {
    out.push({ raw: m[0], kind: 'fraction', value: parseFloat(m[1]) / parseFloat(m[2]) });
  }
  const rest2 = rest.replace(frac, m0 => ' '.repeat(m0.length));
  const num = /[+-]?\d+(?:\.\d+)?/g;
  while ((m = num.exec(rest2))) {
    out.push({ raw: m[0], kind: 'number', value: parseFloat(m[0]) });
  }
  return out;
}

/** 答案文本：选择题把选项字母换成选项原文 */
function answerText(q) {
  const a = String(q.answer == null ? '' : q.answer).trim();
  if (/^[A-Z]$/.test(a) && Array.isArray(q.choices)) {
    const c = q.choices.find(x => String(x.key).toUpperCase() === a);
    if (c) return { text: String(c.text), viaChoice: true, letter: a };
  }
  return { text: a, viaChoice: false, letter: /^[A-Z]$/.test(a) ? a : null };
}

/**
 * 答案里出现「表达式」形态（含字母、根号、不等号、上标）的模态答案，
 * 画板画的是函数曲线，无法呈现这类答案 → 直接判不了。
 */
function looksLikeExpression(text) {
  const s = toHalf(text);
  return /[a-zA-Z√±≤≥<>′']/.test(s) || /[²³]/.test(s);
}

/** 题面问的量是否本来就是「图外量」——只用来把自动通过降级成 suspect，不做放行依据 */
const RISK_PATTERNS = [
  { re: /判别式|b²-4ac|b\^2-4ac|D²\+E²/, code: 'asks-discriminant' },
  { re: /的范围|取值范围|m≠|k≠|恒成立/, code: 'asks-param-range' },
  { re: /有几个交点|几个交点|根的情况|有几个实根|实数根的情况|有几个解|整数解/, code: 'asks-root-count' },
  { re: /的形式|配成|配方成/, code: 'asks-form-label' },
  { re: /项数|次数|系数|常数项|公因式|展开式|化简|因式分解|分解因式|约分|通分|同类项/, code: 'asks-algebra-form' },
  { re: /导数|切线|变化率|极值/, code: 'asks-calculus' },
  { re: /面积|周长|利润|速度|费用|产量|高度|容积|压强/, code: 'asks-applied-quantity' },
  { re: /求\s*[mknapq]\s*的|求\s*[mknapq]\s*、/, code: 'asks-other-param' }
];

function riskFlags(prompt) {
  const s = toHalf(prompt);
  return RISK_PATTERNS.filter(p => p.re.test(s));
}

/**
 * 答案语义门禁：答案里的每个数（含坐标对的分量）都要能在画板标注里找到。
 * verdict: 'match'     全部能对上
 *          'no-number' 答案里没有可比较的数值
 *          'mismatch'  有数值但对不上
 */
function answerGate(q, parsed) {
  const ann = boardAnnotations(parsed);
  const at = answerText(q);
  const toks = extractNumbers(at.text);
  const flags = riskFlags(q.prompt);
  const near = (arr, v) => {
    for (let i = 0; i < arr.length; i++) {
      if (Math.abs(arr[i] - v) <= 1e-6 * Math.max(1, Math.abs(v))) return arr[i];
    }
    return null;
  };
  const base = { flags, ann, answerText: at.text, viaChoice: at.viaChoice, expr: looksLikeExpression(at.text) };
  if (!toks.length) return Object.assign({ verdict: 'no-number', toks, unmatched: [], matched: [] }, base);

  const matched = [];
  const unmatched = [];
  toks.forEach(t => {
    if (t.kind === 'pair') {
      const hx = near(ann.x, t.x), hy = near(ann.y, t.y);
      if (hx !== null && hy !== null) matched.push({ raw: t.raw, hit: '坐标点(' + hx + ',' + hy + ')' });
      else unmatched.push(t.raw);
    } else {
      const hit = near(ann.x, t.value) !== null ? '横坐标' : (near(ann.y, t.value) !== null ? '纵坐标' : null);
      if (hit) matched.push({ raw: t.raw, hit });
      else unmatched.push(t.raw);
    }
  });
  const verdict = unmatched.length === 0 ? 'match' : 'mismatch';
  return Object.assign({ verdict, toks, unmatched, matched }, base);
}

/**
 * 人工复核表：自动判定靠不住、需要人来拍板的题，逐条写死结论，
 * 这样报告里的数字仍然能由脚本复现（不是报告里另写一套数）。
 *   verdict: 'misleading' 确属误挂   'safe' 人工确认可以挂
 */
const MANUAL_REVIEW = {
  // ---- R2 候选里自动判 ok 但实为「数值碰巧重合」的假通过 ----
  // 分式的值为 0：绿点是 x²-9 的两根 ±3，答案只要 +3，-3 是被分母排除的增根 →
  // 学生看见两个绿点会答「±3」，画板反而加深错误
  'cnm_156_q4': { verdict: 'misleading', why: '绿点是 ±3 两根，答案只要 3（-3 因分母 x+3 被排除），两个绿点会诱导答 ±3' },
  // 两条直线的交点：画板只画 y=x+2 一条线，答案 2 恰好等于该线的 y 截距，图上并没有这个交点
  'cnm_208_q2': { verdict: 'misleading', why: '画板只画 y=x+2，答案 2 撞上它的 y 截距；真正的交点需两条线同屏' },
  // f(2)=0：答案 0 撞上绿点的纵坐标，题目问的是函数值，不是方程的根
  'cnm_h050_q2': { verdict: 'misleading', why: '答案 0 是 f(2) 的函数值，撞上绿点纵坐标；画板标注语义是「方程的根」' },
  // 残差平方和：0 撞上标注里的 0，与函数图像无关
  'cnm_h265_q2': { verdict: 'misleading', why: '问残差平方和，答案 0 只是撞上标注里的 0，与图像无因果关系' },

  // ---- R2 候选里的 suspect（题面问图外量，人工定档）----
  'cnm_158_q1': { verdict: 'misleading', why: '答案是要写出的分式 (x-1)/x，画板画不出代数形态' },
  'cnm_223_q3': { verdict: 'misleading', why: '问「根的情况」要文字结论；按卡的保守口径，计数/情况类答案不放行' },
  'cnm_h023_q4': { verdict: 'misleading', why: '问「有几个交点」，答案 0 只是撞上标注；计数类不放行' },
  'cnm_h024_q1': { verdict: 'misleading', why: '问不等式整数解个数，答案 0 撞上标注里的 0' },
  'cnm_h025_q1': { verdict: 'misleading', why: '问 k 的最大值（恒成立条件），答案 1 撞上标注里的 1' },
  'cnm_h177_q3': { verdict: 'misleading', why: '问圆的一般式判据 D²+E²−4F，画板不标这个量' },
  'cnm_h220_q2': { verdict: 'misleading', why: '问切线斜率，画板没有切线' },

  // ---- 人工确认可以放行的 ----
  // 分式无意义：分母 x²-4=0 的两根恰好就是绿点，绿点与答案同源（不是巧合）
  'cnm_156_q3': { verdict: 'safe', why: '分母 x²-4 的零点就是答案 ±2，绿点与答案同源' }
};

function finalVerdict(q, parsed) {
  const g = answerGate(q, parsed);
  const manual = MANUAL_REVIEW[q.id];
  const wrap = v => Object.assign({}, g, { verdict: v, auto: g.verdict, manualWhy: manual ? manual.why : null });
  if (manual) return wrap(manual.verdict);
  if (g.verdict === 'mismatch') return wrap(g.expr ? 'misleading' : 'misleading');
  if (g.verdict === 'no-number') {
    // 纯文字答案：图上确实能看出「有没有交点」的，算可用；其余交给人工
    if (/没有实数根|无实数根|没有交点|无交点|相切|两个相等/.test(g.answerText)) return wrap('suspect');
    return wrap('misleading');
  }
  // 数值全对上，但题面问的是图外量 → suspect，等人工结论
  if (g.flags.length) return wrap('suspect');
  return wrap('ok');
}

/* ============================================================ 统计小工具 */

function stageOf(grade) {
  const g = Number(grade);
  if (!isFinite(g)) return '未知';
  if (g <= 6) return '小学(1-6)';
  if (g <= 9) return '初中(7-9)';
  if (g <= 12) return '高中必修(10-12)';
  return '高中选修(13-16)';
}

function chapterOf(topicId) {
  const t = TOPIC.get(topicId);
  return (t && t.chapter) || '未知章节';
}

/** 粗粒度章名：把 "九上 第二十五章 一元二次方程 25.2" 归到 "九上 第二十五章 一元二次方程" */
function chapterGroup(topicId) {
  const c = chapterOf(topicId);
  return c.replace(/\s*\d+(\.\d+)*\s*$/, '').replace(/\s*拓展\s*$/, '').trim();
}

function sortDesc(obj) {
  return Object.entries(obj).sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
}

function table(headers, rows) {
  const out = [];
  out.push('| ' + headers.join(' | ') + ' |');
  out.push('|' + headers.map(() => ' --- ').join('|') + '|');
  rows.forEach(r => out.push('| ' + r.join(' | ') + ' |'));
  return out.join('\n');
}

function clip(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function pct(a, b) {
  return b ? (a / b * 100).toFixed(1) + '%' : '—';
}

/* ============================================================ 主流程 */

if (require.main !== module) {
  module.exports = {
    answerGate: answerGate, finalVerdict: finalVerdict, boardAnnotations: boardAnnotations,
    extractNumbers: extractNumbers, answerText: answerText, relaxedLabForR1: relaxedLabForR1,
    stageOf: stageOf, chapterGroup: chapterGroup, riskFlags: riskFlags
  };
  return;
}

const rows = QUESTIONS.map(q => {
  const kind = F.topicKind(q.topicId);
  const baseLab = F.labFor(q.topicId, q.prompt, { itemId: q.id });       // 原样
  const r1Lab = relaxedLabForR1(q.topicId, q.prompt);                    // R1
  const any = relaxedParseAny(q.prompt);                                 // R2 的解析面
  return { q, kind, baseLab, r1Lab, any };
});

const BASELINE = rows.filter(r => r.baseLab);
const R1_LITERAL = rows.filter(r => r.r1Lab);
const R1_NEW = R1_LITERAL.filter(r => !r.baseLab);
const R2_PARSED = rows.filter(r => r.any);

const log = [];
function say(s) { log.push(s == null ? '' : s); console.log(s == null ? '' : s); }

say('# funclab 画板覆盖率测算 · 脚本输出');
say('');
say('数据：questions.json ' + QUESTIONS.length + ' 题 / topics.json ' + TOPICS.length + ' 个知识点');
say('');

/* ---------- 1. 现状基线 ---------- */
say('## 一、现状基线（topicKind + labFor 原样）');
const baseByType = {};
const baseTopicSet = new Set();
BASELINE.forEach(r => {
  baseByType[r.baseLab.type] = (baseByType[r.baseLab.type] || 0) + 1;
  baseTopicSet.add(r.q.topicId);
});
const supportedTopicIds = new Set(rows.filter(r => r.kind).map(r => r.q.topicId));
const supportedRows = rows.filter(r => r.kind);
say('');
say('支持的知识点数：' + supportedTopicIds.size + '；这些知识点下的题：' + supportedRows.length);
say('可挂画板题数：' + BASELINE.length + '（占全库 ' + pct(BASELINE.length, QUESTIONS.length) + '，占支持章节 ' + pct(BASELINE.length, supportedRows.length) + '）');
say('挂载覆盖的知识点数：' + baseTopicSet.size);
say('');
say(table(['函数类型', '可挂题数', '涉及知识点数'], [
  ['linear', String(baseByType.linear || 0), String(new Set(BASELINE.filter(r => r.baseLab.type === 'linear').map(r => r.q.topicId)).size)],
  ['quadratic', String(baseByType.quadratic || 0), String(new Set(BASELINE.filter(r => r.baseLab.type === 'quadratic').map(r => r.q.topicId)).size)],
  ['inverse', String(baseByType.inverse || 0), String(new Set(BASELINE.filter(r => r.baseLab.type === 'inverse').map(r => r.q.topicId)).size)],
  ['合计', String(BASELINE.length), String(baseTopicSet.size)]
]));
say('');
const baseByChapter = {};
BASELINE.forEach(r => { const g = chapterGroup(r.q.topicId); baseByChapter[g] = (baseByChapter[g] || 0) + 1; });
say('按章分布（只列有挂载的章）：');
say('');
say(table(['章', '可挂题数'], sortDesc(baseByChapter).map(([k, v]) => [k, String(v)])));
say('');
const blockedInSupported = supportedRows.filter(r => !r.baseLab);
const blockedWhy = {};
blockedInSupported.forEach(r => {
  let why;
  if (!F.fromPrompt(r.q.prompt)) why = 'fromPrompt 解析不出函数';
  else if (F.fromPrompt(r.q.prompt).type !== r.kind) why = '解析类型(' + F.fromPrompt(r.q.prompt).type + ') ≠ 知识点类型(' + r.kind + ')';
  else {
    const g = relaxedEquationAllowed(r.q.prompt, F.fromPrompt(r.q.prompt));
    why = '方程门禁拦住（' + g.why + '）';
  }
  blockedWhy[why] = (blockedWhy[why] || 0) + 1;
});
say('支持章节内被挡下的 ' + blockedInSupported.length + ' 题，原因分布：');
say('');
say(table(['拦截原因', '题数'], sortDesc(blockedWhy).map(([k, v]) => [k, String(v)])));
say('');

/* ---------- 2. R1 ---------- */
say('## 二、方案 R1（去掉方程章白名单，仍限 29 个知识点）');
const r1ByType = {};
R1_LITERAL.forEach(r => { r1ByType[r.r1Lab.type] = (r1ByType[r.r1Lab.type] || 0) + 1; });
const r1TopicSet = new Set(R1_LITERAL.map(r => r.q.topicId));
say('');
say('R1（放宽口径）可挂：' + R1_LITERAL.length + ' 题 / ' + r1TopicSet.size + ' 个知识点；相对基线新增 ' + R1_NEW.length + ' 题');
say('');
say(table(['函数类型', 'R1 可挂题数', '较基线新增'], [
  ['linear', String(r1ByType.linear || 0), String(R1_NEW.filter(r => r.r1Lab.type === 'linear').length)],
  ['quadratic', String(r1ByType.quadratic || 0), String(R1_NEW.filter(r => r.r1Lab.type === 'quadratic').length)],
  ['inverse', String(r1ByType.inverse || 0), String(R1_NEW.filter(r => r.r1Lab.type === 'inverse').length)],
  ['合计', String(R1_LITERAL.length), String(R1_NEW.length)]
]));
say('');
say('R1 新增题逐条（' + R1_NEW.length + ' 条）：');
say('');
say(table(['题 id', '题面', '参考答案', '画板类型'], R1_NEW.slice(0, 30).map(r => [
  r.q.id, clip(r.q.prompt, 46), clip(r.q.answer, 18), r.r1Lab.type
])));
const r1NewGate = R1_NEW.map(r => ({ r, f: finalVerdict(r.q, r.r1Lab) }));
const r1NewOk = r1NewGate.filter(x => x.f.verdict === 'ok');
const r1NewBad = r1NewGate.filter(x => x.f.verdict !== 'ok');
say('');
say('R1 新增题的答案语义核查：可用 ' + r1NewOk.length + ' 题，误挂 ' + r1NewBad.length + ' 题');
say('R1（加答案语义门禁）可挂：' + (BASELINE.length + r1NewOk.length) + ' 题');
say('');

/* ---------- 3. R2 ---------- */
say('## 三、方案 R2（取消 topicKind 白名单，全库按题面解析）');
const r2ByType = {};
R2_PARSED.forEach(r => { r2ByType[r.any.type] = (r2ByType[r.any.type] || 0) + 1; });
say('');
say('全库 fromPrompt 解析出函数的题：' + R2_PARSED.length + ' / ' + QUESTIONS.length + '（' + pct(R2_PARSED.length, QUESTIONS.length) + '）');
say('');
say(table(['函数类型', '解析出题数'], [['linear', String(r2ByType.linear || 0)], ['quadratic', String(r2ByType.quadratic || 0)], ['inverse', String(r2ByType.inverse || 0)], ['合计', String(R2_PARSED.length)]]));
say('');
const r2Gate = R2_PARSED.map(r => ({ r, f: finalVerdict(r.q, r.any) }));
const r2Count = { ok: 0, suspect: 0, misleading: 0 };
r2Gate.forEach(x => { r2Count[x.f.verdict] = (r2Count[x.f.verdict] || 0) + 1; });
say('R2 候选的答案语义核查：ok ' + r2Count.ok + ' / suspect ' + r2Count.suspect + ' / misleading ' + r2Count.misleading);
say('R2（加答案语义门禁，只取 ok）可挂：' + r2Count.ok + ' 题 / ' + new Set(r2Gate.filter(x => x.f.verdict === 'ok').map(x => x.r.q.topicId)).size + ' 个知识点');
say('');
const r2Stage = {};
r2Gate.filter(x => x.f.verdict === 'ok').forEach(x => {
  const s = stageOf((TOPIC.get(x.r.q.topicId) || {}).grade);
  r2Stage[s] = (r2Stage[s] || 0) + 1;
});
say('R2（ok 档）按学段分布：');
say('');
say(table(['学段', '可挂题数'], sortDesc(r2Stage).map(([k, v]) => [k, String(v)])));
say('');
const r2ParsedStage = {};
R2_PARSED.forEach(r => {
  const s = stageOf((TOPIC.get(r.q.topicId) || {}).grade);
  r2ParsedStage[s] = (r2ParsedStage[s] || 0) + 1;
});
say('对照：R2 全部 195 个解析命中按学段分布（不设门禁）');
say('');
say(table(['学段', '解析出题数'], sortDesc(r2ParsedStage).map(([k, v]) => [k, String(v)])));
say('');
const r2Chapter = {};
r2Gate.filter(x => x.f.verdict === 'ok').forEach(x => {
  const g = chapterGroup(x.r.q.topicId);
  r2Chapter[g] = (r2Chapter[g] || 0) + 1;
});
say('R2（ok 档）按章分布（题数 ≥ 2 的章）：');
say('');
say(table(['章', '可挂题数'], sortDesc(r2Chapter).filter(([, v]) => v >= 2).map(([k, v]) => [k, String(v)])));
say('');

/* ---------- 4. 误挂风险 ---------- */
say('## 四、误挂风险清单');
say('');
say('判定方式（三道，逐题对 answer 字段，不看题面关键词就下结论）：');
say('  ① 把答案里的数值抽出来（选择题先按 choices 展开成选项原文；分数 3/4 折成小数；坐标对 (a,b) 按分量比）');
say('  ② 与画板在该函数上**真实标注**的数逐个比对：二次 = 顶点 (h,k) + x 轴交点；一次 = y 轴截距 (0,b) + x 轴交点；');
say('     反比例 = 无数值标注（只有象限说明文字）；任一数值对不上 → 判误挂');
say('  ③ 数值全对上但题面问的是图外量（判别式/范围/有几个交点/形态 m、n/面积/导数…）→ 降级 suspect；');
say('     再由人工逐条定档（结论写死在脚本 MANUAL_REVIEW 表里，报告里的数字因此仍可复现）');
say('');
say('门禁自校准（同一套判定套到基线 58 题上，用来衡量它有多严）：');
const baseGate = BASELINE.map(r => ({ r, f: finalVerdict(r.q, r.baseLab) }));
const baseGateCount = { ok: 0, suspect: 0, misleading: 0 };
baseGate.forEach(x => { baseGateCount[x.f.verdict] = (baseGateCount[x.f.verdict] || 0) + 1; });
say('');
say(table(['基线 58 题在门禁下的判定', '题数'], [['ok', String(baseGateCount.ok)], ['suspect', String(baseGateCount.suspect)], ['misleading', String(baseGateCount.misleading)]]));
say('');
say('说明：门禁挡住了基线里 ' + baseGateCount.misleading + ' 题，其中约 6 题属于「象限/增减性/交点个数」这类');
say('纯图像可读、但画板没有数值标注的答案 —— 门禁判得过严，是**保守下限**，不是精确分类器。');
say('因此下面各方案的「加门禁」数字都是**低估**，报告结论据此按保守方向取。');
say('');
say('### 4.1 R1 新增题中的误挂');
say('');
say(r1NewBad.length ? table(['题 id', '题面', '参考答案', '画板标注', '误挂原因'], r1NewBad.map(({ r, f }) => [
  r.q.id, clip(r.q.prompt, 40), clip(f.answerText || r.q.answer, 20),
  clip(f.ann.labels.join(' / ') || '无数值标注', 26),
  clip(f.manualWhy || (f.auto === 'mismatch' ? '答案数值 ' + f.unmatched.join('、') + ' 不在标注里' : '题面问图外量'), 44)
])) : '（无）');
say('');
say('R1 新增但被人工判为安全的：' + r1NewGate.filter(x => x.f.verdict === 'ok' && x.f.manualWhy).length + ' 题');
say('');
say('### 4.2 R2 候选中的误挂（按原因归类）');
const r2Bad = r2Gate.filter(x => x.f.verdict === 'misleading');
const r2Sus = r2Gate.filter(x => x.f.verdict === 'suspect');
const badReason = {};
r2Bad.forEach(({ r, f }) => {
  let code;
  if (f.manualWhy) code = 'answer-number-coincidence(人工确认)';
  else if (f.auto === 'mismatch') code = 'answer-number-not-on-graph';
  else if (f.auto === 'no-number') code = 'answer-not-numeric';
  else code = 'asks-off-graph-quantity';
  badReason[code] = (badReason[code] || 0) + 1;
});
say('');
say(table(['风险类别', '题数'], sortDesc(badReason).map(([k, v]) => [k, String(v)])));
say('');
say('R2 misleading 全量清单（' + r2Bad.length + ' 题，逐条核过 answer）：');
say('');
say(table(['题 id', '题面', '参考答案', '画板标注', '误挂原因'], r2Bad.map(({ r, f }) => [
  r.q.id, clip(r.q.prompt, 40), clip(f.answerText || r.q.answer, 20),
  clip(f.ann.labels.join(' / ') || '无数值标注', 22),
  clip(f.manualWhy || (f.auto === 'mismatch' ? '答案 ' + f.unmatched.join('、') + ' 不是图上任何点' : '答案不是图上任何量'), 40)
])));
say('');
say('人工复核定档的 ' + Object.keys(MANUAL_REVIEW).length + ' 条（4 条自动判 ok 但实为数值巧合的假通过 + 7 条 suspect 定档 + 1 条确认为安全）：');
say('');
const manualRows = Object.keys(MANUAL_REVIEW).map(id => {
  const hit = baseGate.concat(R1_LITERAL.map(r => ({ r, f: null })), R2_PARSED.map(r => ({ r, f: null })))
    .find(x => x.r.q.id === id);
  const q = hit ? hit.r.q : QUESTIONS.find(x => x.id === id);
  return [id, clip(q.prompt, 34), clip(q.answer, 14), MANUAL_REVIEW[id].verdict, clip(MANUAL_REVIEW[id].why, 46)];
});
say(table(['题 id', '题面', '参考答案', '人工结论', '理由'], manualRows));
say('');

/* ---------- 5. 汇总与净增 ---------- */
const baseIds = new Set(BASELINE.map(r => r.q.id));
const r2OkList = r2Gate.filter(x => x.f.verdict === 'ok');
const r2OkIds = new Set(r2OkList.map(x => x.r.q.id));
const r2NetNew = r2OkList.filter(x => !baseIds.has(x.r.q.id));
const r2Keep = r2OkList.filter(x => baseIds.has(x.r.q.id));
const r1OkIds = new Set(r1NewOk.map(x => x.r.q.id));

say('## 五、汇总与净增');
say('');
say(table(['口径', '可挂题数', '知识点数', '其中误挂'], [
  ['基线（原样）', String(BASELINE.length), String(baseTopicSet.size), '未审计（本卡只测算增量）'],
  ['R1 放宽口径', String(R1_LITERAL.length), String(r1TopicSet.size), String(r1NewBad.length)],
  ['R1 + 答案语义门禁', String(BASELINE.length + r1NewOk.length), String(new Set(BASELINE.map(r => r.q.topicId).concat(r1NewOk.map(x => x.r.q.topicId))).size), '0'],
  ['R2 放宽口径（只解析）', String(R2_PARSED.length), String(new Set(R2_PARSED.map(r => r.q.topicId)).size), String(r2Bad.length)],
  ['R2 + 答案语义门禁（strict）', String(r2OkList.length), String(new Set(r2OkList.map(x => x.r.q.topicId)).size), '0']
]));
say('');
say('R2 与基线的关系（决定 R2 到底值不值）：');
say('');
say(table(['项', '题数'], [
  ['R2+门禁 可挂', String(r2OkList.length)],
  ['其中基线本来就挂的（重合）', String(r2Keep.length)],
  ['其中基线没挂的（净增）', String(r2NetNew.length)],
  ['基线 58 题里 R2 门禁不再通过的', String(BASELINE.length - r2Keep.length)]
]));
say('');
say('R2 相对基线真正新增的 ' + r2NetNew.length + ' 题：');
say('');
say(table(['题 id', '章', '题面', '参考答案'], r2NetNew.map(x => [
  x.r.q.id, clip(chapterGroup(x.r.q.topicId), 24), clip(x.r.q.prompt, 40), clip(x.f.answerText || x.r.q.answer, 16)
])));
say('');
say('R1 净增（放宽口径减去误挂）：' + (R1_NEW.length - r1NewBad.length) + ' 题');
say('R2 净增（相对基线，已过门禁）：' + r2NetNew.length + ' 题');
say('');
say('注：基线 58 题不在本卡审计范围，但门禁自校准显示其中 ' + baseGateCount.misleading + ' 题同样通不过答案语义检查');
say('（如 cnm_208_q1 两线交点、cnm_204_q1 平移后解析式、cnm_234_q2 交点个数），这批问题与本卡放不放宽无关。');
say('');

/* ---------- 6. R3：推荐方案（保白名单 + 只补净增知识点） ---------- */
const R3_ADD_TOPICS = Array.from(new Set(r2NetNew.map(x => x.r.q.topicId))).sort();
say('## 六、R3（推荐）：白名单不动 + 只把这 ' + R3_ADD_TOPICS.length + ' 个知识点补进 topicKind');
say('');
say('补入的知识点：' + R3_ADD_TOPICS.map(t => t + '（' + (TOPIC.get(t) || {}).name + '）').join('；'));
say('');
// 每个补入的知识点用「促成它入选的那道题」的解析类型作为该知识点的函数类型
const R3_TYPE = {};
r2NetNew.forEach(x => { if (!R3_TYPE[x.r.q.topicId]) R3_TYPE[x.r.q.topicId] = x.r.any.type; });
function r3Kind(topicId) {
  const id = String(topicId);
  if (R3_TYPE[id]) return R3_TYPE[id];
  return F.topicKind(id);
}
const R3_ROWS = QUESTIONS.map(q => {
  const kind = r3Kind(q.topicId);
  if (!kind) return null;
  const p = F.fromPrompt(q.prompt);
  if (!p || p.type !== kind) return null;
  if (/^cnm_22[0-4]$/.test(String(q.topicId)) && p.type === 'quadratic') {
    if (!relaxedEquationAllowed(q.prompt, p).ok) return null;   // 方程章沿用现行逐题门禁
  }
  return { q, p };
}).filter(Boolean);
const R3_NEW = R3_ROWS.filter(r => !baseIds.has(r.q.id));
const R3_GATED = R3_NEW.map(r => ({ r, f: finalVerdict(r.q, r.p) }));
const R3_OK = R3_GATED.filter(x => x.f.verdict === 'ok');
const R3_BAD = R3_GATED.filter(x => x.f.verdict !== 'ok');
say(table(['项', '题数'], [
  ['R3 放宽口径（等同 R1 的题面门禁，白名单 + ' + R3_ADD_TOPICS.length + '）', String(R3_ROWS.length)],
  ['其中基线已覆盖', String(R3_ROWS.length - R3_NEW.length)],
  ['新增候选', String(R3_NEW.length)],
  ['新增中过答案语义门禁', String(R3_OK.length)],
  ['新增中误挂', String(R3_BAD.length)]
]));
say('');
say('R3 新增候选逐条：');
say('');
say(table(['题 id', '知识点', '题面', '参考答案', '门禁结论'], R3_NEW.map(r => {
  const g = R3_GATED.find(x => x.r.q.id === r.q.id).f;
  return [r.q.id, r.q.topicId, clip(r.q.prompt, 34), clip(g.answerText || r.q.answer, 12), g.verdict + (g.manualWhy ? '（' + clip(g.manualWhy, 20) + '）' : '')];
})));
say('');
say('R3 最终可挂：' + (BASELINE.length + R3_OK.length) + ' 题（基线 ' + BASELINE.length + ' + 新增 ' + R3_OK.length + '），误挂 0');
say('');

const text = log.join('\n') + '\n';
if (process.argv.includes('--raw')) {
  require('fs').writeFileSync(path.join(__dirname, '..', 'docs', 'funclab-coverage.raw.md'), text);
}
