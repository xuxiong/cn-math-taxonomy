#!/usr/bin/env node
/* 卡 B 确定性构造器测试：node tests/test_variants_construct.js（零依赖、零网络、零 LLM）
 *
 * 与 diagnose/construct.js 的模块内自检有意分离：
 *   construct.js 里的 verify() 闭包和 numberParts 是「构造侧的自我陈述」，
 *   本文件一律不采信 —— 只看题面（prompt）与答案（answer）文本，
 *   自己解析、自己拟合、自己解方程、自己复算派生量，然后比对答案。
 * 这样构造器写错（符号、根不全、判别式、派生量公式）时测试才会红。
 *
 * 覆盖卡面要求的 5 道门 + 确定性/重复率 + 覆盖度 + 反证（不空转）。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const C = require('../diagnose/construct.js');
const E = require('../diagnose/llm-eval.js');
const ENGINE = require('../diagnose/engine.js');

const ROOT = path.join(__dirname, '..');
const EPS = 1e-9;

let passed = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { passed++; return true; }
  failures.push(msg);
  return false;
}
function eq(actual, expected, msg) {
  return ok(actual === expected, msg + '（期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual) + '）');
}

/* ================================================================
 * 一、独立复算工具：不 import construct.js 的任何内部函数
 * ================================================================ */

/** 文本规范化（与构造器无关的一套实现：NFKC + 去空白 + 全角标点归一） */
function canon(s) {
  return String(s == null ? '' : s)
    .normalize('NFKC')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，、]/g, ',')
    .replace(/[（]/g, '(').replace(/[）]/g, ')')
    .replace(/[－−‐]/g, '-');
}

/** 骨架：把题面里的所有数字抽掉（「同题换数」检测用） */
function skeleton(s) {
  return canon(s).replace(/\d+(?:\.\d+)?/g, '#');
}

/** 答案文本 → 数值数组（只接受整数或 p/q，其他一律 NaN） */
function parseAnswer(answer) {
  if (typeof answer !== 'string' || !answer.trim()) return [NaN];
  return answer.split(/[,;、，；]/).map(function (t) { return t.trim(); }).filter(Boolean).map(function (t) {
    const m = /^(-?\d+)(?:\/(\d+))?$/.exec(t);
    if (!m) return NaN;
    return Number(m[1]) / Number(m[2] || 1);
  });
}

/** 变量替换：把 {x:-2,y:3} 代进纯文本表达式（构造成 (-2) 这种带括号形式，避免符号粘连） */
function subst(expr, vals) {
  let s = String(expr);
  const keys = Object.keys(vals);
  // 两遍：第一遍替换可能产生新的邻接（kx → (3)*x），第二遍才能替换紧跟其后的字母
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const v = '(' + vals[k] + ')';
      s = s.replace(new RegExp('(^|[^A-Za-z])' + k + '(?=[A-Za-z])', 'g'), function (_, pre) { return pre + v + '*'; });
      s = s.replace(new RegExp('(^|[^A-Za-z])' + k + '(?![A-Za-z])', 'g'), function (_, pre) { return pre + v; });
    }
  }
  return s;
}

/** 在给定变量取值下求值（借 llm-eval 的表达式求值器，只有它负责「算得对不对」） */
function evalAt(expr, vals) {
  const s = subst(expr, vals);
  const r = E.evaluateExpression(s, [0]);
  if (!r || !isFinite(r[0])) return null;
  return r[0];
}

/** f(x) = lhs - rhs 取样后拟合成 ax²+bx+c；不是（至多二次的）多项式返回 null */
function fitQuadratic(lhs, rhs, extraVars) {
  const base = extraVars || {};
  const at = function (x) {
    const vals = Object.assign({}, base, { x: x });
    const l = evalAt(lhs, vals), r = evalAt(rhs, vals);
    if (l === null || r === null) return null;
    return l - r;
  };
  const v = {};
  const xs = [-2, -1, 0, 1, 2, 3];
  for (let i = 0; i < xs.length; i++) {
    v[xs[i]] = at(xs[i]);
    if (v[xs[i]] === null) return null;
  }
  const a = (v[1] - 2 * v[0] + v[-1]) / 2;
  const b = (v[1] - v[-1]) / 2;
  const c = v[0];
  // 用未参与拟合的点复验，确认确实（至多）是二次多项式
  const check = [2, 3, -2];
  for (let i = 0; i < check.length; i++) {
    const x = check[i];
    if (Math.abs(a * x * x + b * x + c - v[x]) > 1e-9) return null;
  }
  return { a: a, b: b, c: c, f: function (x) { return a * x * x + b * x + c; } };
}

/** 精确求多项式实根（一次/二次），返回升序数组 */
function polyRoots(p) {
  if (Math.abs(p.a) < EPS) {
    if (Math.abs(p.b) < EPS) return [];
    return [-p.c / p.b];
  }
  const d = p.b * p.b - 4 * p.a * p.c;
  if (d < -EPS) return [];
  if (Math.abs(d) < EPS) return [-p.b / (2 * p.a)];
  const r = Math.sqrt(d);
  return [(-p.b - r) / (2 * p.a), (-p.b + r) / (2 * p.a)].sort(function (x, y) { return x - y; });
}

function sameSet(xs, ys) {
  if (xs.length !== ys.length) return false;
  const a = xs.slice().sort(function (m, n) { return m - n; });
  const b = ys.slice().sort(function (m, n) { return m - n; });
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 1e-9) return false;
  return true;
}

function allDistinct(xs) {
  for (let i = 0; i < xs.length; i++) {
    for (let j = i + 1; j < xs.length; j++) if (Math.abs(xs[i] - xs[j]) <= 1e-9) return false;
  }
  return true;
}

/** 题干里是否以断言形式写出了答案（独立实现，比 construct.js 内部口径更宽地扫断言上下文） */
function answerAssertedInPrompt(prompt, answerValues) {
  const text = canon(prompt);
  const re = /(?:已知|当|若|解为|根为|的解是|根是|答案是|答案为)x?(?:=)(-?\d+(?:\/\d+)?)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const v = Number(m[1].split('/')[0]) / Number(m[1].split('/')[1] || 1);
    for (let i = 0; i < answerValues.length; i++) if (Math.abs(answerValues[i] - v) <= 1e-9) return true;
  }
  return false;
}

/** 解析线性多项式的系数：ax+by+cz = d → {coef:{x,y,z}, d} */
function parseLinear(eqText, vars) {
  // eqText 形如 "2x-y+3z=6"
  const idx = eqText.lastIndexOf('=');
  if (idx < 0) return null;
  const lhs = eqText.slice(0, idx), rhs = eqText.slice(idx + 1);
  const constTerm = Number(rhs);
  if (!isFinite(constTerm)) return null;
  const coef = {};
  for (let i = 0; i < vars.length; i++) coef[vars[i]] = evalAt(lhs, (function () {
    const v = {}; vars.forEach(function (k) { v[k] = 0; }); v[vars[i]] = 1; return v;
  })()) - evalAt(lhs, (function () {
    const v = {}; vars.forEach(function (k) { v[k] = 0; }); return v;
  })());
  const zero = evalAt(lhs, (function () { const v = {}; vars.forEach(function (k) { v[k] = 0; }); return v; })());
  if (zero === null || Math.abs(zero) > EPS) return null;      // 线性式不该有常数项
  return { coef: coef, d: constTerm };
}

/** 行列式（2/3 阶） */
function det(m) {
  if (m.length === 1) return m[0][0];
  if (m.length === 2) return m[0][0] * m[1][1] - m[0][1] * m[1][0];
  return m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
    - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
    + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
}

/* ================================================================
 * 二、题库：全库题干与骨架（撞题门）
 * ================================================================ */

function loadLibrary() {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'questions.json'), 'utf8'));
  const list = Array.isArray(raw) ? raw : (raw.questions || []);
  const prompts = new Set(), skeletons = new Set();
  list.forEach(function (q) {
    if (!q || typeof q.prompt !== 'string') return;
    prompts.add(canon(q.prompt));
    skeletons.add(skeleton(q.prompt));
  });
  return { count: list.length, prompts: prompts, skeletons: skeletons };
}

/* ================================================================
 * 三、单题门禁（全部从题面独立复算）
 * ================================================================ */

/**
 * @returns {string[]} 违反的门禁列表（空数组 = 全过）
 */
function gates(q, lib, opts) {
  const bad = [];
  const spec = q.constructSpec || {};
  const kind = spec.kind;
  const answers = parseAnswer(q.answer);

  /* 结构 */
  if (q.type !== 'numeric') bad.push('type');
  if (!/^(basic|standard|advanced)$/.test(q.difficulty)) bad.push('difficulty');
  if (!q.topicId || q.topicId !== opts.topic) bad.push('topic');
  if (typeof q.prompt !== 'string' || q.prompt.length < 8) bad.push('prompt');
  if (answers.some(function (v) { return !isFinite(v); })) bad.push('answer-format');
  if (typeof q.explanation !== 'string' || !q.explanation.trim()) bad.push('explanation-missing');
  if (q.figure) bad.push('figure-forbidden');

  if (bad.length) return bad;

  /* 门 5a：题干不得断言答案 */
  if (answerAssertedInPrompt(q.prompt, answers)) bad.push('answer-in-prompt');

  /* 门 5b：解析不含答案、不含任何数字（比 checkLeak 更严的口径） */
  if (/\d/.test(q.explanation)) bad.push('explanation-digits');
  if (canon(q.explanation).indexOf(canon(q.answer)) >= 0) bad.push('explanation-answer');
  if (!C.checkLeak(q.explanation, q.answer)) bad.push('leak-clause');

  /* 门 4：与全库撞题（题干规范化 + 骨架） */
  if (lib && lib.prompts.has(canon(q.prompt))) bad.push('collision-library');
  if (lib && lib.skeletons.has(skeleton(q.prompt))) bad.push('skeleton-library');

  /* 门 3：不变量（数字规模按难度档，独立从题面抽数） */
  const inv = C.INVARIANT[q.difficulty];
  const nums = (canon(q.prompt).match(/\d+(?:\.\d+)?/g) || []).map(Number);
  for (let i = 0; i < nums.length; i++) {
    if (nums[i] > inv.maxNumber) { bad.push('inv-number-range'); break; }
  }
  if (!inv.allowFraction) {
    if (/[／/]/.test(q.prompt)) bad.push('inv-basic-fraction');
    for (let i = 0; i < answers.length; i++) if (Math.abs(answers[i] - Math.round(answers[i])) > 1e-9) bad.push('inv-basic-not-int');
  }

  /* 门 1 + 2：按 kind 独立复算 */
  if (kind === 'roots') {
    const p = fitQuadratic(spec.display.lhs, spec.display.rhs);
    if (!p) { bad.push('poly-parse'); return bad; }
    const trueRoots = polyRoots(p);
    if (trueRoots.length !== spec.degree) bad.push('poly-degree-mismatch');
    if (answers.length !== spec.degree) bad.push('root-count');
    if (!allDistinct(answers)) bad.push('root-duplicate');
    // 代回：每个答案根都让 lhs-rhs=0
    for (let i = 0; i < answers.length; i++) {
      if (Math.abs(p.f(answers[i])) > EPS) bad.push('root-substitute');
    }
    // 解集完整：方程的真根集合 == 答案集合
    if (!sameSet(trueRoots, answers)) bad.push('root-set-incomplete');
    // 二次：判别式性质（本族要求是完全平方式 / 有理根）
    if (spec.degree === 2) {
      const d = p.b * p.b - 4 * p.a * p.c;
      if (d < -EPS) bad.push('discriminant');
      if (spec.invariants && spec.invariants.perfectSquare) {
        const s = Math.sqrt(d);
        if (Math.abs(s - Math.round(s)) > 1e-6) bad.push('not-perfect-square');
      }
    }
  } else if (kind === 'frac-roots') {
    const lhs = spec.display.lhs, rhs = spec.display.rhs;
    // 极点：极点不能是根（独立判定：只要有一侧在该点无定义，或两侧不相等，就不是根）
    (spec.poles || []).forEach(function (pole) {
      const l = evalAt(lhs, { x: pole }), r = evalAt(rhs, { x: pole });
      if (l !== null && r !== null && Math.abs(l - r) <= EPS) bad.push('pole-is-root');
    });
    for (let i = 0; i < answers.length; i++) {
      const l = evalAt(lhs, { x: answers[i] }), r = evalAt(rhs, { x: answers[i] });
      if (l === null || r === null || Math.abs(l - r) > EPS) bad.push('frac-substitute');
    }
    // 唯一性：在 [-20,20] 步长 0.01 扫一遍，只允许答案根取等（去分母后等价于一次方程）
    let extra = 0;
    for (let x = -20; x <= 20 + 1e-12; x += 0.01) {
      const l = evalAt(lhs, { x: x }), r = evalAt(rhs, { x: x });
      if (l === null || r === null) continue;
      if (Math.abs(l - r) < 1e-7) {
        const hit = answers.some(function (a) { return Math.abs(a - x) < 0.02; });
        if (!hit) extra++;
      }
    }
    if (extra > 0) bad.push('frac-extra-root');
  } else if (kind === 'system') {
    const vars = spec.vars || ['x', 'y'];
    if (answers.length !== vars.length) bad.push('system-answer-count');
    const mat = [];
    spec.display.forEach(function (eqn) {
      const line = parseLinear(eqn.lhs + '=' + eqn.rhs, vars);
      if (!line) { bad.push('system-parse'); return; }
      mat.push(vars.map(function (v) { return line.coef[v]; }));
      // 代入答案：Σ coef*ans 必须 = 常数项
      let sum = 0;
      vars.forEach(function (v, i) { sum += line.coef[v] * answers[i]; });
      if (Math.abs(sum - line.d) > EPS) bad.push('system-substitute');
    });
    if (mat.length === vars.length && Math.abs(det(mat)) < EPS) bad.push('system-singular');
  } else if (kind === 'coeffs') {
    const p = fitQuadratic(spec.display.lhs, spec.display.rhs);
    if (!p) { bad.push('poly-parse'); return bad; }
    if (answers.length !== 3) bad.push('coeffs-count');
    if (!sameSet([p.a, p.b, p.c], answers.slice(0, 3))) bad.push('coeffs-value');
    if (!(answers[0] > 0)) bad.push('coeffs-lead-positive');
    // 一般形式必须与题面恒等：把答案拼回 ax²+bx+c 与 lhs-rhs 逐点比
    for (let x = -3; x <= 3; x++) {
      const rebuilt = answers[0] * x * x + answers[1] * x + answers[2];
      if (Math.abs(rebuilt - p.f(x)) > EPS) bad.push('coeffs-identity');
    }
  } else if (kind === 'derived') {
    const p = fitQuadratic(spec.display.lhs, spec.display.rhs);
    if (!p) { bad.push('poly-parse'); return bad; }
    const roots = polyRoots(p);
    if (roots.length !== 2) { bad.push('derived-roots'); return bad; }
    const r1 = roots[0], r2 = roots[1];
    const want = {
      'sum-product': [r1 + r2, r1 * r2],
      'square-sum': [r1 * r1 + r2 * r2],
      'distance': [Math.abs(r1 - r2)],
      'max-root': [Math.max(r1, r2)],
      'min-root': [Math.min(r1, r2)]
    }[spec.derived];
    if (!want) { bad.push('derived-kind'); return bad; }
    if (answers.length !== want.length) bad.push('derived-count');
    if (!sameSet(want, answers)) bad.push('derived-value');
    for (let i = 0; i < roots.length; i++) if (Math.abs(p.f(roots[i])) > EPS) bad.push('derived-root-not-root');
  } else if (kind === 'perfect-square') {
    const p = fitQuadratic(spec.display.lhs, spec.display.rhs);
    if (!p) { bad.push('poly-parse'); return bad; }
    if (answers.length !== 1) bad.push('ps-count');
    const c = answers[0];
    // 完全平方式判据：b²-4ac=0，其中 a、b 从题面读，c 是答案
    const a = spec.a || p.a;
    const b = p.b;
    if (Math.abs(b * b - 4 * a * c) > EPS) bad.push('ps-discriminant');
    if (Math.abs(a - p.a) > EPS) bad.push('ps-lead-mismatch');
  } else if (kind === 'param') {
    // 把答案代进未知数的位置，在 anchor 处两边必须相等；再把答案 ±1 代入必须不等（解唯一）
    const unknowns = spec.unknowns || [];
    const anchors = spec.anchors || {};
    if (answers.length !== unknowns.length) bad.push('param-count');
    const mk = function (i) {
      const v = Object.assign({}, anchors);
      unknowns.forEach(function (u, j) { v[u] = answers[j] + i; });
      return v;
    };
    const l0 = evalAt(spec.display.lhs, mk(0));
    const r0 = evalAt(spec.display.rhs, mk(0));
    if (l0 === null || r0 === null) bad.push('param-eval');
    else if (Math.abs(l0 - r0) > EPS) bad.push('param-substitute');
    const l1 = evalAt(spec.display.lhs, mk(1));
    const r1 = evalAt(spec.display.rhs, mk(1));
    if (l1 !== null && r1 !== null && Math.abs(l1 - r1) <= EPS) bad.push('param-not-unique');
  } else {
    bad.push('unknown-kind');
  }

  /* 引擎兼容：engine.js 判分必须认自己的答案 */
  const verdict = ENGINE.judgeQuestion(q, q.answer);
  if (!verdict || verdict.verdict !== 'correct') bad.push('engine-reject-own-answer');

  return bad;
}

/* ================================================================
 * 四、抽样：每个 recipe ≥ 50 道（撞题门用 batch 内 avoid 集）
 * ================================================================ */

function sampleByRecipe(lib, perRecipe, seedPrefix) {
  const buckets = new Map();       // recipeId → question[]
  const statsAll = {};
  C.RECIPES.forEach(function (r) { buckets.set(r.id, []); });

  C.TOPICS.forEach(function (topic) {
    const recipes = C.recipesFor(topic);
    const avoidPrompts = new Set(), avoidSkeletons = new Set();
    const need = function () {
      return recipes.some(function (r) { return buckets.get(r.id).length < perRecipe; });
    };
    for (let i = 0; i < 4000 && need(); i++) {
      const stats = {};
      const q = C.genConstruct(topic, i, {
        seed: seedPrefix, attempts: 60, stats: stats,
        avoidPrompts: avoidPrompts, avoidSkeletons: avoidSkeletons
      });
      if (stats.rejected) {
        Object.keys(stats.rejected).forEach(function (k) {
          statsAll[topic] = statsAll[topic] || {};
          statsAll[topic][k] = (statsAll[topic][k] || 0) + stats.rejected[k];
        });
      }
      if (!q) continue;
      const bucket = buckets.get(q.constructRecipe);
      if (!bucket) { buckets.set(q.constructRecipe, []); }
      if (bucket.length < perRecipe) {
        bucket.push(q);
        avoidPrompts.add(canon(q.prompt));
        avoidSkeletons.add(skeleton(q.prompt));
      }
      // 即便该 recipe 已够数，也把题干加进 avoid 集，避免后续 index 反复撞同一题
      avoidPrompts.add(canon(q.prompt));
      avoidSkeletons.add(skeleton(q.prompt));
    }
  });
  return { buckets: buckets, stats: statsAll };
}

/* ================================================================
 * 五、用例
 * ================================================================ */

// 卡 A（wt/gap-plan 8ab7b47）tmp/gap-plan.json 中 strategy=construct 的 19 个点
const PLAN_CONSTRUCT = [
  'cnm_039', 'cnm_042', 'cnm_043', 'cnm_044', 'cnm_087', 'cnm_088', 'cnm_093',
  'cnm_165', 'cnm_206', 'cnm_208', 'cnm_219', 'cnm_220', 'cnm_221', 'cnm_222',
  'cnm_224', 'cnm_225', 'cnm_226', 'cnm_234', 'cnm_h023'
];

function testStructure() {
  eq(C.TOPICS.length, 19, '构造器覆盖的 topic 数应为 19');
  PLAN_CONSTRUCT.forEach(function (t) {
    ok(C.supports(t), 'plan 里的 construct 点必须被支持：' + t);
    ok(C.recipesFor(t).length >= 1, '每个点至少一个 recipe：' + t);
  });
  C.TOPICS.forEach(function (t) {
    ok(PLAN_CONSTRUCT.indexOf(t) >= 0, '不得混入 plan 之外的 topic：' + t);
  });

  // 家族归属：cnm_221 配方法，其余 equation；不许出现 formParam
  C.RECIPES.forEach(function (r) {
    const want = r.topic === 'cnm_221' ? 'completeSquare' : 'equation';
    eq(r.family, want, 'recipe 家族归属：' + r.id);
    ok(r.difficulties.length >= 1, 'recipe 至少一个难度档：' + r.id);
  });
  const fams = new Set(C.RECIPES.map(function (r) { return r.family; }));
  ok(!fams.has('formParam'), 'plan 里 formParam=0，不得出现该族');

  // 每个 topic 的 recipe 都能出题（否则是死模板）
  C.TOPICS.forEach(function (t) {
    const q = C.genConstruct(t, 0, { seed: 'structure' });
    ok(!!q, 'topic 必须能出题：' + t);
    if (q) eq(q.topicId, t, 'topicId 必须回填：' + t);
  });

  // 解析文案：全库模板都不许含数字（比 checkLeak 更严）
  Object.keys(C.RULES).forEach(function (id) {
    ok(!/\d/.test(C.RULES[id]), '解析模板不得含数字：' + id);
  });
}

function testDeterminism() {
  C.TOPICS.forEach(function (t) {
    for (let i = 0; i < 3; i++) {
      const a = C.genConstruct(t, i, { seed: 'det' });
      const b = C.genConstruct(t, i, { seed: 'det' });
      ok(JSON.stringify(stripFn(a)) === JSON.stringify(stripFn(b)), '同 seed+index 必须完全同题：' + t + '#' + i);
    }
  });
  // 换 seed 应当换题（至少绝大多数不同）
  let diff = 0, total = 0;
  C.TOPICS.forEach(function (t) {
    const a = C.genConstruct(t, 0, { seed: 's1' });
    const b = C.genConstruct(t, 0, { seed: 's2' });
    if (a && b) { total++; if (canon(a.prompt) !== canon(b.prompt)) diff++; }
  });
  ok(total > 0 && diff / total >= 0.7, '换 seed 应改变大多数题目（' + diff + '/' + total + '）');
}

function stripFn(q) {
  if (!q) return q;
  const out = {};
  Object.keys(q).forEach(function (k) { if (typeof q[k] !== 'function') out[k] = q[k]; });
  return out;
}

function testRepeatRate() {
  // 卡面口径：不同 seed 抽样 200 道，重复率 < 1%。
  // 单批 200 道只有 23 个族、平均每族 9 道，重复条数是小整数（0/1/2），单批读数抖动很大；
  // 这里做 12 批独立抽样（每批 200 道、各自一套 seed），以「合并重复率 = 累计重复/累计道数」
  // 作为判定口径，并把每批读数原样打印出来，不藏最坏的那批。
  const BATCHES = 12, PER = 200;
  const perBatch = [];
  let pooled = 0, pooledDup = 0;
  for (let b = 0; b < BATCHES; b++) {
    const seen = new Set();
    let n = 0, dup = 0;
    for (let k = 0; k < PER; k++) {
      const t = C.TOPICS[k % C.TOPICS.length];
      const q = C.genConstruct(t, k, { seed: 'rep' + b + '-' + k });
      if (!q) continue;
      n++;
      const key = canon(q.prompt) + '||' + q.answer;
      if (seen.has(key)) dup++; else seen.add(key);
    }
    perBatch.push({ n: n, dup: dup, rate: n ? dup / n : 1 });
    ok(n >= 195, '第 ' + b + ' 批 200 次抽样应几乎全部出题（实际 ' + n + '）');
    pooled += n;
    pooledDup += dup;
  }
  const rate = pooled ? pooledDup / pooled : 1;
  ok(pooled >= BATCHES * 195, '累计抽样应 ≥ ' + (BATCHES * 195) + ' 道（实际 ' + pooled + '）');
  ok(rate < 0.01, BATCHES + ' 批 × 200 道（共 ' + pooled + ' 道）合并重复率应 < 1%（实际 ' +
    (rate * 100).toFixed(2) + '%，' + pooledDup + '/' + pooled + '）');
  return { n: pooled, dup: pooledDup, rate: rate, perBatch: perBatch, batches: BATCHES, per: PER };
}

/** 每族题面空间普查：4000 次不同 seed 抽样里的去重题数（下界估计） */
function recipeSpace() {
  const rows = [];
  C.RECIPES.forEach(function (r) {
    let n = 0;
    const seen = new Set();
    for (let k = 0; k < 4000; k++) {
      const q = C.genConstruct(r.topic, k, { seed: 'space-' + k, recipe: r.id });
      if (!q) continue;
      n++;
      seen.add(q.difficulty + '|' + canon(q.prompt) + '||' + q.answer);
    }
    rows.push({ id: r.id, space: seen.size, produced: n });
  });
  return rows;
}

function testGates() {
  const lib = loadLibrary();
  const { buckets } = sampleByRecipe(lib, 50, 'gate');
  const perRecipe = [];
  let totalQ = 0, totalBad = 0;
  const reasonCount = {};

  C.RECIPES.forEach(function (r) {
    const list = buckets.get(r.id) || [];
    let bad = 0;
    const localReasons = {};
    list.forEach(function (q) {
      const reasons = gates(q, lib, { topic: r.topic });
      if (reasons.length) {
        bad++;
        reasons.forEach(function (x) { localReasons[x] = (localReasons[x] || 0) + 1; reasonCount[x] = (reasonCount[x] || 0) + 1; });
      }
    });
    totalQ += list.length;
    totalBad += bad;
    perRecipe.push({ id: r.id, topic: r.topic, family: r.family, n: list.length, bad: bad, reasons: localReasons });
    ok(list.length >= 50, '每个族至少抽 50 道：' + r.id + ' 只有 ' + list.length);
    ok(bad === 0, '族内全部题目必须过 5 道门：' + r.id + ' 有 ' + bad + ' 道失败 ' + JSON.stringify(localReasons));
  });

  ok(totalQ >= C.RECIPES.length * 50, '抽样总数应 ≥ 50×族数（实际 ' + totalQ + '）');
  return { perRecipe: perRecipe, totalQ: totalQ, totalBad: totalBad, reasonCount: reasonCount, lib: lib };
}

function testDifficultyTiers() {
  // 难度档必须“声明什么就抽到什么”：旧实现 hashStr(base+'|d')%n 恒为 0，
  // 600 次抽样 100% 落在 basic，standard/advanced 事实上从未产出过。这条断言专防它回归。
  const rows = [];
  C.RECIPES.forEach(function (r) {
    const seen = Object.create(null);
    for (let k = 0; k < 300; k++) {
      const q = C.genConstruct(r.topic, k, { seed: 'tier-' + k, recipe: r.id });
      if (q) seen[q.difficulty] = (seen[q.difficulty] || 0) + 1;
    }
    r.difficulties.forEach(function (d) {
      ok((seen[d] || 0) > 0, r.id + ' 声明的 ' + d + ' 档必须真实产题（实际 ' + (seen[d] || 0) + ' 道）');
    });
    Object.keys(seen).forEach(function (d) {
      ok(r.difficulties.indexOf(d) >= 0, r.id + ' 不应产出未声明的 ' + d + ' 档');
    });
    rows.push({ id: r.id, seen: seen, declared: r.difficulties });
  });
  return rows;
}

function testCoverage(perRecipe) {
  // plan 的 19 个点都实际覆盖到，且每个点都有 ≥50 道产出
  const covered = new Set();
  perRecipe.forEach(function (r) { if (r.n >= 50 && r.bad === 0) covered.add(r.topic); });
  eq(covered.size, 19, '19 个 construct 点应全部覆盖');
  PLAN_CONSTRUCT.forEach(function (t) {
    ok(covered.has(t), 'plan 点必须有覆盖：' + t);
  });
  return covered;
}

function testRejectionStats() {
  // 每族成功率：opts.recipe 钉住模板，raw = attempts=1（一次成型率）,retry = attempts=60
  const rows = [];
  C.RECIPES.forEach(function (r) {
    let rawOk = 0;
    const rawStats = {};
    for (let i = 0; i < 60; i++) {
      const st = {};
      const q = C.genConstruct(r.topic, i, { seed: 'raw-' + i, attempts: 1, stats: st, recipe: r.id });
      if (st.rejected) Object.keys(st.rejected).forEach(function (k) { rawStats[k] = (rawStats[k] || 0) + st.rejected[k]; });
      if (q) rawOk++;
    }
    let retryOk = 0;
    const retryStats = {};
    for (let i = 0; i < 60; i++) {
      const st = {};
      const q = C.genConstruct(r.topic, i, { seed: 'retry-' + i, attempts: 60, stats: st, recipe: r.id });
      if (st.rejected) Object.keys(st.rejected).forEach(function (k) { retryStats[k] = (retryStats[k] || 0) + st.rejected[k]; });
      if (q) retryOk++;
    }
    rows.push({ id: r.id, topic: r.topic, raw: rawOk, retry: retryOk, rawReasons: rawStats, retryReasons: retryStats });
  });
  return rows;
}

function testAntiVacuity(lib) {
  // ① 独立复算能识别错答案：把某题的第一个根 +1，门禁必须报错
  const q = C.genConstruct('cnm_222', 0, { seed: 'anti' }) || C.genConstruct('cnm_219', 0, { seed: 'anti' });
  ok(!!q, '反证用例需要一个可用的二次方程题');
  if (q) {
    const parts = parseAnswer(q.answer);
    const wrong = q.answer.replace(String(parts[0]), String(parts[0] + 1));
    const mutated = Object.assign({}, q, { answer: wrong });
    const reasons = gates(mutated, null, { topic: q.topicId });
    ok(reasons.length > 0, '改掉一个根后门禁必须报错（否则断言空转），实际 ' + JSON.stringify(reasons));
  }

  // ② 骨架去重能识别「同题换数」：把某库题里的一个数字换掉，骨架不变
  const anyPrompt = Array.from(lib.prompts)[0];
  const swapped = anyPrompt.replace(/\d+/, '881');
  if (anyPrompt !== swapped) {
    eq(skeleton(anyPrompt), skeleton(swapped), '换掉数字后骨架必须相同');
    ok(lib.skeletons.has(skeleton(swapped)), '换数后的题必须被骨架集合命中');
  }

  // ③ 泄漏检测不空转：解析里加一个数字，门禁必须报 explanation-digits
  const q2 = C.genConstruct('cnm_226', 0, { seed: 'anti2' });
  if (q2) {
    const leaky = Object.assign({}, q2, { explanation: q2.explanation + '结果是 7。' });
    ok(gates(leaky, null, { topic: q2.topicId }).indexOf('explanation-digits') >= 0, '解析含数字必须被拦');
    const leaky2 = Object.assign({}, q2, { explanation: q2.explanation + '答案是 ' + q2.answer + '。' });
    ok(gates(leaky2, null, { topic: q2.topicId }).indexOf('explanation-answer') >= 0, '解析含答案必须被拦');
  }

  // ④ 题干断言检测不空转
  ok(answerAssertedInPrompt('已知 x=3 是方程 2x+1=m 的解，求 m。', [3]), '应识别题干里的断言式答案');
  ok(!answerAssertedInPrompt('解方程 3x=12。', [4]), '正常题面不应误报');

  // ⑤ 引擎兼容性反证：错答案必须不被判对
  if (q) {
    const parts = parseAnswer(q.answer);
    const wrong = Object.assign({}, q, { answer: String(parts[0] + 1) + (q.unordered ? '，' + String(parts[1]) : '') });
    const v = ENGINE.judgeQuestion(wrong, q.answer);
    ok(!v || v.verdict !== 'correct', '引擎不应把错答案判对');
  }
}

/* ================================================================
 * 六、跑
 * ================================================================ */

function main() {
  console.log('== 卡B 确定性构造器测试 ==');
  testStructure();
  testDeterminism();
  const rep = testRepeatRate();
  const spaces = recipeSpace();
  const minSpace = spaces.reduce(function (a, r) { return Math.min(a, r.space); }, Infinity);
  ok(minSpace >= 300, '每个族的题面空间应 ≥ 300 道（最贫瘠的族只有 ' + minSpace + ' 道）');
  const g = testGates();
  const tiers = testDifficultyTiers();
  const covered = testCoverage(g.perRecipe);
  testAntiVacuity(g.lib);
  const rejectRows = testRejectionStats();

  console.log('\n-- 每族抽样门禁 --');
  console.log('recipe\ttopic\tfamily\tn\tbad\treasons');
  g.perRecipe.forEach(function (r) {
    console.log([r.id, r.topic, r.family, r.n, r.bad, JSON.stringify(r.reasons)].join('\t'));
  });
  console.log('\n抽检合计 ' + g.totalQ + ' 道，门禁失败 ' + g.totalBad + ' 道，覆盖点 ' + covered.size + '/19');
  console.log(rep.batches + ' 批 × ' + rep.per + ' 道不同 seed：出题 ' + rep.n + '，重复 ' + rep.dup +
    '，合并重复率 ' + (rep.rate * 100).toFixed(2) + '%  单批 dup=[' +
    rep.perBatch.map(function (b) { return b.dup; }).join(',') + ']');
  console.log('\n-- 每族题面空间（4000 次不同 seed 抽样去重下界） --');
  console.log(spaces.sort(function (a, b) { return a.space - b.space; })
    .map(function (r) { return r.id + ':' + r.space; }).join('  '));
  console.log('\n-- 难度档实测（每族 300 次抽样，b/s/a 为各档产出数） --');
  console.log(tiers.map(function (t) {
    return t.id + ':' + t.declared.map(function (d) { return d[0] + (t.seen[d] || 0); }).join('');
  }).join('  '));

  console.log('\n-- 每族成功率（60 次抽取） --');
  console.log('recipe\traw(attempts=1)\tretry(attempts=60)\t主要拒绝原因');
  rejectRows.forEach(function (r) {
    const top = Object.keys(r.retryReasons).sort(function (a, b) { return r.retryReasons[b] - r.retryReasons[a]; })
      .slice(0, 4).map(function (k) { return k + ':' + r.retryReasons[k]; }).join(' ');
    console.log([r.id, r.raw + '/60', r.retry + '/60', top || '-'].join('\t'));
  });

  console.log('\n通过断言 ' + passed + ' 条');
  if (failures.length) {
    console.log('\n失败 ' + failures.length + ' 条：');
    failures.slice(0, 40).forEach(function (f) { console.log('  ✗ ' + f); });
    process.exit(1);
  }
  console.log('全部通过');
}

main();
