#!/usr/bin/env node
/* 单题审计：某道题挂图后用某个 intent 讲解时，文案/图上标注会不会漏答案。
 *
 * 用法：
 *   node scripts/audit_funclab_item.js cnm_235_q2                        # 用缓存里 LLM 选的组合；没缓存就列全部 intent
 *   node scripts/audit_funclab_item.js cnm_235_q2 --intent 最小值 --lab quadratic-vertex
 *   node scripts/audit_funclab_item.js cnm_232_q2 --all                  # 该题所有可挂 intent 逐条检
 *
 * 输出：题面 / 答案 / 用到的参数 / 文案 / 图上静态标注 / 面板要核对的行（未答时不给真值），
 *       并标出「答案数字是否出现在文案或标注里」（题面已给的数不算泄漏，与 P 卡规则一致）。
 * 退出码：发现泄漏 → 1。
 */
'use strict';

const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const QUESTIONS = require(path.join(ROOT, 'data/questions.json'));
const Funclab = require(path.join(ROOT, 'diagnose/funclab.js'));

const argv = process.argv.slice(2);
const id = argv[0];
function opt(name) {
  const i = argv.indexOf('--' + name);
  return i < 0 ? null : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true);
}
const wantIntent = opt('intent');
const wantLab = opt('lab');
const ALL = !!opt('all');

const item = QUESTIONS.find(function (q) { return q.id === id; });
if (!item) {
  console.error('题库里找不到题目 ' + id);
  process.exit(2);
}

const cand = Funclab.labForScene(item.topicId, item.prompt, { itemId: item.id });
if (!cand) {
  console.log(id + '：不是函数画板候选（不挂图）');
  process.exit(0);
}

function key(n) {
  if (!isFinite(n)) return null;
  const r = Math.round(n * 1e6) / 1e6;
  return String(r === 0 ? 0 : r);
}
function numbersIn(text) {
  const out = [];
  const s = String(text == null ? '' : text).replace(/[−–—]/g, '-');
  const re = /-?\d+(?:\.\d+)?(?:\s*\/\s*-?\d+(?:\.\d+)?)?/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const tok = m[0].replace(/\s+/g, '');
    if (tok.indexOf('/') >= 0) {
      const p = tok.split('/');
      const v = Number(p[0]) / Number(p[1]);
      if (isFinite(v)) out.push(v);
    } else if (isFinite(Number(tok))) out.push(Number(tok));
  }
  return out;
}
function answerNumbers(a) {
  const s = String(a == null ? '' : a).replace(/[（(][^）)]*[）)]/g, ' ').replace(/[（）()]/g, '');
  return numbersIn(s);
}

/** 图上静态标注（与 funclab.js annotate() 对应：派生量一律 '?'，只有题面区间端点带真值） */
function annotation(lab, intent) {
  const out = {};
  const t = Funclab.CAP_TYPE[lab];
  out['顶点坐标'] = '(?, ?)';
  if (t === 'quadratic') {
    if (intent === '最小值' || intent === '最大值') out['最值标注'] = intent + ' = ?';
    if (intent === '对称轴') out['对称轴标注'] = '对称轴 x = ?';
    if (Funclab.intentUsesRoots(intent)) out['交点标注'] = '(?, 0)';
    if (intent === '在给定区间上的最大值' || intent === '在给定区间上的最小值') {
      out['端点标注'] = 'x=' + cand.xMin + ' → ?, x=' + cand.xMax + ' → ?';
    }
  } else if (t === 'linear') {
    out['y 轴交点'] = '(0, ?)';
    out['x 轴交点'] = '(?, 0)';
  } else {
    out['曲线'] = '只画两支，不标数值';
  }
  return out;
}

const ansKeys = new Set(answerNumbers(item.answer).map(key));
const given = new Set(numbersIn(item.prompt).map(key));

function check(lab, intent) {
  const note = Funclab.noteText(lab, intent, cand);
  if (note == null) return { lab: lab, intent: intent, note: null, leaks: [] };
  const ann = annotation(lab, intent);
  const seen = [];
  numbersIn(note).forEach(function (n) { seen.push({ n: n, where: '文案' }); });
  Object.keys(ann).forEach(function (k) {
    numbersIn(ann[k]).forEach(function (n) { seen.push({ n: n, where: '标注:' + k }); });
  });
  const leaks = [];
  seen.forEach(function (h) {
    const k = key(h.n);
    if (k == null || !ansKeys.has(k) || given.has(k)) return;
    if (Math.abs(h.n) <= 1) return;              // 结构性 0/1（坐标占位、a=±1），不是答案线索
    leaks.push(h);
  });
  /* 面板行：未作答时不给真值 → 这里只打印「要问几个数」和真值是否与答案一致 */
  const rows = Funclab.answerRows(lab, intent, cand);
  return { lab: lab, intent: intent, note: note, ann: ann, rows: rows, leaks: leaks };
}

let combos = [];
if (wantIntent) {
  const lab = wantLab || Object.keys(Funclab.capabilitiesFor(cand.type)).find(function (l) {
    return Funclab.capabilityIntents(l).indexOf(Funclab.intentKey(wantIntent)) >= 0;
  });
  combos.push({ lab: lab, intent: wantIntent });
} else {
  Object.keys(Funclab.capabilitiesFor(cand.type)).forEach(function (lab) {
    Funclab.capabilitiesFor(cand.type)[lab].canAnswer.forEach(function (intent) {
      combos.push({ lab: lab, intent: intent });
    });
  });
  if (!ALL) combos = combos.slice(0, 6);          // 默认只看前几个，避免刷屏
}

console.log('题目：' + item.id + '（' + item.topicId + '）');
console.log('题面：' + item.prompt);
console.log('答案：' + item.answer);
console.log('画板参数：' + JSON.stringify(cand, function (k, v) { return k === 'base' ? undefined : v; }));
console.log('');

let bad = 0;
combos.forEach(function (c) {
  const r = check(c.lab, c.intent);
  console.log('--- ' + r.lab + ' / ' + r.intent);
  if (r.note == null) { console.log('    （该 intent 无文案模板 → 不挂）'); return; }
  console.log('    文案：' + r.note);
  console.log('    图上标注：' + JSON.stringify(r.ann));
  console.log('    面板行：' + (r.rows.length
    ? r.rows.map(function (x) { return x.label + (/(=|：)$/.test(x.label) ? ' ' : '=') + '?'; }).join('、') + '（未作答不显示真值）'
    : '无（不是数值题）'));
  if (r.leaks.length) {
    bad++;
    console.log('    ✗ 泄漏：' + r.leaks.map(function (h) { return h.n + '(' + h.where + ')'; }).join('、'));
  } else {
    console.log('    ✓ 文案与标注都不含答案数字（题面已给的数不算）');
  }
});
console.log('');
console.log(bad ? '✗ ' + bad + ' 个组合泄漏' : '✓ 全部组合均无泄漏');
process.exit(bad ? 1 : 0);
