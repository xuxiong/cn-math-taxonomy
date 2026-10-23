/* O1 变式生成器：先定根再反推系数，确定性地产出无限变式方程题。
 *
 * 设计文档：docs/o1-random-variants.md
 * 零依赖、纯函数、无 console、无 Math.random/Date.now。
 * 浏览器中暴露为 window.DiagVariants，Node 中 require() 即可。
 *
 * 核心思路：每个模板展开后都是 Ax+B=Cx+D（整数系数）。
 * 先在根空间定一个规整的根 r，再抽系数、把常数项反解出来，
 * 使方程的解恰好是 r——答案规整是构造出来的，不需要事后校验。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.DiagVariants = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---- 确定性 RNG（与 engine.js 同款，刻意复制不做跨模块 require） ---- */

  function hashStr(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  }

  function mulberry32(a) {
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ---- 有理数工具（全程整数运算，不出现浮点） ---- */

  function gcd(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) { var t = a % b; a = b; b = t; } return a || 1; }

  function reduceFrac(p, q) {
    if (q < 0) { p = -p; q = -q; }
    var g = gcd(p, q);
    return { p: p / g, q: q / g };
  }

  // 有理数乘法 (p1/q1) * n → {p, q}
  function fracMulInt(p, q, n) { return reduceFrac(p * n, q); }
  // 有理数加法 (p1/q1) + (p2/q2) → {p, q}
  function fracAdd(p1, q1, p2, q2) { return reduceFrac(p1 * q2 + p2 * q1, q1 * q2); }
  // 有理数 = 整数？
  function fracIsInt(p, q) { return q === 1; }

  /* ---- 题面渲染辅助 ---- */

  // 括号内常数：+3 / -3
  function signed(n) { return n >= 0 ? '+' + n : '' + n; }

  // 项：5x / -3x / x / -x / ''（n==0）
  function term(n, v) {
    if (n === 0) return '';
    if (n === 1) return v;
    if (n === -1) return '-' + v;
    return n + v;
  }

  // 常数项：+13 / -8 / +0（首项为 0 时省略）
  function constTerm(n) {
    if (n === 0) return '';
    return n >= 0 ? '+' + n : '' + n;
  }

  /* ---- 分类工具 ---- */

  function classifyLinear(L) {
    if (L.A !== L.C) return 'unique';
    if (L.B === L.D) return 'identity';
    return 'contradiction';
  }

  /* ---- 根空间 ---- */

  // 整数根 r ∈ [-6..6]（含 0）
  var INT_ROOTS = [];
  for (var r = -6; r <= 6; r++) INT_ROOTS.push(r);

  // 分数根 p/q，q ∈ {2,3,4}，gcd(|p|,q)=1，|p/q| ≤ 3.5
  var FRAC_ROOTS = [];
  [2, 3, 4].forEach(function (q) {
    for (var p = -Math.floor(3.5 * q); p <= Math.floor(3.5 * q); p++) {
      if (p === 0) continue;
      if (gcd(p, q) === 1) FRAC_ROOTS.push({ p: p, q: q });
    }
  });

  /* ---- recipe 表（表驱动，不用 if/elif 长链） ---- */
  // 每个难度档有哪些 recipe
  var DIFF_RECIPES = {
    basic: ['T1'],
    standard: ['T2', 'T4'],
    advanced: ['T3']
  };
  var DIFF_RANK = ['basic', 'standard', 'advanced'];

  /* ---- 支持的 topic ---- */

  var SUPPORTED = { cnm_043: true };
  function supports(topicId) { return !!SUPPORTED[topicId]; }

  /* ---- 四个模板的生成与展开 ---- */

  // 从抽到的参数生成 {A,B,C,D} 并返回题面参数
  // T1: a(x+b)=c，自由量 c，反推 c=a(b+r)
  function buildT1(rng, root, intOnly) {
    var a = randInt(rng, 2, 6, true);  // ±[2..6]
    var b = randInt(rng, -9, 9, false); // [-9..9]\{0}
    // r = root (整数或分数 p/q)
    // c = a * (b + r) = a*b + a*r
    // a*r 必须是整数（root.q 整除 a）
    if (!fracIsInt(root.p, root.q) && root.q !== 1) {
      // 分数根：需要 q | a
      if (a % root.q !== 0) return null;
    }
    // a*(b + p/q) = a*b + a*p/q
    var ar_p = root.p * a, ar_q = root.q;
    var ar = reduceFrac(ar_p, ar_q);
    if (!fracIsInt(ar.p, ar.q)) return null; // 不整除
    var c = a * b + ar.p;
    if (c === 0) return null; // c_T1 ≠ 0
    if (Math.abs(c) > 60) return null;
    // 展开: A=a, B=a*b, C=0, D=c
    var A = a, B = a * b, C = 0, D = c;
    return { A: A, B: B, C: C, D: D, a: a, b: b, c: c, root: root };
  }

  // T2: a(x+b)=c(x+d)，自由量 d，反推 d=(a*b + r*(a-c))/c，须整除
  function buildT2(rng, root, intOnly) {
    var a = randInt(rng, 2, 6, true);
    var c = randInt(rng, 2, 6, true);
    if (a === c) return null; // A≠C
    var b = randInt(rng, -9, 9, false);
    // d = (a*b + r*(a-c)) / c
    // r*(a-c) = p*(a-c)/q
    var rc_p = root.p * (a - c), rc_q = root.q;
    var rc = reduceFrac(rc_p, rc_q);
    // a*b + rc
    var num = fracAdd(a * b, 1, rc.p, rc.q);
    if (!fracIsInt(num.p, num.q)) return null; // 分子不整除
    var numerator = num.p;
    if (numerator % c !== 0) return null;
    var d = numerator / c;
    if (d === 0) return null; // d ≠ 0
    if (d === b) return null; // d ≠ b（形态约束）
    if (Math.abs(d) > 9) return null;
    var A = a, B = a * b, C = c, D = c * d;
    if (Math.abs(D) > 60) return null;
    return { A: A, B: B, C: C, D: D, a: a, b: b, c: c, d: d, root: root };
  }

  // T3: a(x+b)-c(x+d)=e，自由量 e，反推 e=a*b-c*d+r*(a-c)
  function buildT3(rng, root, intOnly) {
    var a = randInt(rng, 2, 6, true);
    var c = randInt(rng, 2, 6, true);
    if (a === c) return null;
    var b = randInt(rng, -9, 9, false);
    var d = randInt(rng, -9, 9, false);
    if (d === b) return null; // d ≠ b
    // r*(a-c)
    var rc_p = root.p * (a - c), rc_q = root.q;
    var rc = reduceFrac(rc_p, rc_q);
    // a*b - c*d + rc
    var base = a * b - c * d;
    var sum = fracAdd(base, 1, rc.p, rc.q);
    if (!fracIsInt(sum.p, sum.q)) return null;
    var e = sum.p;
    if (e === 0) return null; // e ≠ 0
    if (Math.abs(e) > 60) return null;
    var A = a - c, B = a * b - c * d, C = 0, D = e;
    if (Math.abs(B) > 60) return null;
    return { A: A, B: B, C: C, D: D, a: a, b: b, c: c, d: d, e: e, root: root };
  }

  // T4: a(x+b)=m-(x+d)，自由量 m，反推 m=a*b+r*(a+1)+d
  function buildT4(rng, root, intOnly) {
    var a = randInt(rng, 2, 6, true);
    var b = randInt(rng, -9, 9, false);
    var d = randInt(rng, -9, 9, false);
    if (d === b) return null; // d ≠ b
    // r*(a+1)
    var ra_p = root.p * (a + 1), ra_q = root.q;
    var ra = reduceFrac(ra_p, ra_q);
    // a*b + ra + d
    var base = a * b + d;
    var sum = fracAdd(base, 1, ra.p, ra.q);
    if (!fracIsInt(sum.p, sum.q)) return null;
    var m = sum.p;
    if (m < 1) return null; // m ≥ 1
    if (Math.abs(m) > 60) return null;
    var A = a, B = a * b, C = -1, D = m - d;
    if (Math.abs(D) > 60) return null;
    return { A: A, B: B, C: C, D: D, a: a, b: b, m: m, d: d, root: root };
  }

  // T1 兜底（必然成功）
  function buildT1Fallback(rng, root) {
    var a = randInt(rng, 2, 6, false); // 正数 [2..6]
    var b = randInt(rng, -9, 9, false);
    // root 只取整数
    var rInt = INT_ROOTS[Math.floor(rng() * INT_ROOTS.length)];
    var c = a * (b + rInt);
    if (c === 0) c = a; // 保证非 0
    return { A: a, B: a * b, C: 0, D: c, a: a, b: b, c: c, root: { p: rInt, q: 1 } };
  }

  var RECIPE_BUILDERS = {
    T1: buildT1,
    T2: buildT2,
    T3: buildT3,
    T4: buildT4
  };

  /* ---- 随机整数辅助 ---- */

  // ±[lo..hi]，allowNeg 控制是否允许负数
  function randInt(rng, lo, hi, allowNeg) {
    var range = hi - lo + 1;
    var n = lo + Math.floor(rng() * range);
    if (allowNeg && rng() < 0.5) n = -n;
    if (n === 0) n = lo; // 不允许 0（b, d 用）
    return n;
  }

  /* ---- 抽根 ---- */

  function pickRoot(rng, difficulty, intOnly) {
    if (intOnly || difficulty === 'basic') {
      return { p: INT_ROOTS[Math.floor(rng() * INT_ROOTS.length)], q: 1 };
    }
    var fracProb = difficulty === 'advanced' ? 0.6 : 0.2;
    if (rng() < fracProb) {
      var fr = FRAC_ROOTS[Math.floor(rng() * FRAC_ROOTS.length)];
      return { p: fr.p, q: fr.q };
    }
    return { p: INT_ROOTS[Math.floor(rng() * INT_ROOTS.length)], q: 1 };
  }

  /* ---- 题面与解析渲染 ---- */

  function renderPrompt(recipe, p) {
    var prefix = '解方程 ';
    var suffix = '。（只填 x 的值）';
    if (recipe === 'T1') return prefix + p.a + '(x' + signed(p.b) + ')=' + p.c + suffix;
    if (recipe === 'T2') return prefix + p.a + '(x' + signed(p.b) + ')=' + p.c + '(x' + signed(p.d) + ')' + suffix;
    if (recipe === 'T3') return prefix + p.a + '(x' + signed(p.b) + ')' + (p.c >= 0 ? '-' : '+') + Math.abs(p.c) + '(x' + signed(p.d) + ')=' + p.e + suffix;
    if (recipe === 'T4') return prefix + p.a + '(x' + signed(p.b) + ')=' + p.m + '-(x' + signed(p.d) + ')' + suffix;
    return '';
  }

  function formatRoot(root) {
    if (root.q === 1) return '' + root.p;
    return root.p + '/' + root.q;
  }

  // accept：仅当根为分数且分母能整除某个 10 的幂（q ∈ {2,4,5,8,10}）
  function computeAccept(root) {
    if (root.q === 1) return undefined;
    if (root.q === 2 || root.q === 4) {
      // 3/2 → 1.5, -1/4 → -0.25
      var denom = root.q === 2 ? 2 : 4;
      var decimal = root.p / denom;
      var s = '' + decimal;
      // 确认是终止小数
      if (s.indexOf('.') >= 0 && !/(e|E)/.test(s)) {
        return [s];
      }
    }
    return undefined;
  }

  function renderExplanation(recipe, p, L, root) {
    var ans = formatRoot(root);
    if (recipe === 'T1') {
      // 去括号得 {a*x}{+ab}={c}，移项得 {a*x}={c-ab}，系数化为 1 得 x={r}。
      var ax = term(p.a, 'x');
      var ab = constTerm(p.a * p.b);
      var cAb = p.c - p.a * p.b;
      return '去括号得 ' + ax + ab + '=' + p.c + '，移项得 ' + ax + '=' + cAb + '，系数化为 1 得 x=' + ans + '。';
    }
    // T2/T3/T4: 去括号得 {逐项展开}，合并同类项得 {A·x}{+B}={D}，移项得 {A·x}={D−B}，系数化为 1 得 x={r}。
    var expand = renderExpand(recipe, p);
    var Ax = term(L.A, 'x');
    var B = constTerm(L.B);
    var DB = L.D - L.B;
    return '去括号得 ' + expand + '，合并同类项得 ' + Ax + B + '=' + L.D + '，移项得 ' + Ax + '=' + DB + '，系数化为 1 得 x=' + ans + '。';
  }

  // 渲染去括号后的逐项展开
  function renderExpand(recipe, p) {
    if (recipe === 'T2') {
      // a(x+b)=c(x+d) → ax+ab=cx+cd
      return term(p.a, 'x') + constTerm(p.a * p.b) + '=' + term(p.c, 'x') + constTerm(p.c * p.d);
    }
    if (recipe === 'T3') {
      // a(x+b)-c(x+d)=e → ax+ab-cx-cd=e
      return term(p.a, 'x') + constTerm(p.a * p.b) + '-' + term(p.c, 'x') + constTerm(-p.c * p.d) + '=' + p.e;
    }
    if (recipe === 'T4') {
      // a(x+b)=m-(x+d) → ax+ab=m-x-d
      return term(p.a, 'x') + constTerm(p.a * p.b) + '=' + p.m + '-' + term(1, 'x') + constTerm(-p.d);
    }
    return '';
  }

  /* ---- 不变量断言 ---- */

  function checkInvariants(L, recipe, p) {
    if (classifyLinear(L) !== 'unique') return false;
    if (Math.abs(L.A) > 12 || Math.abs(L.C) > 12) return false;
    if (Math.abs(L.B) > 60 || Math.abs(L.D) > 60) return false;
    // 形态约束
    if ((recipe === 'T2' || recipe === 'T3' || recipe === 'T4') && p.d === p.b) return false;
    if (recipe === 'T4' && p.m < 1) return false;
    if (recipe === 'T3' && p.e === 0) return false;
    if (recipe === 'T1' && p.c === 0) return false;
    // 代入精确成立：A*r + B = C*r + D（有理数比较）
    // A*p/q + B vs C*p/q + D
    var lhs = fracAdd(L.A * p.root.p, p.root.q, L.B, 1);
    var rhs = fracAdd(L.C * p.root.p, p.root.q, L.D, 1);
    if (lhs.p !== rhs.p || lhs.q !== rhs.q) return false;
    // 答案最简
    var fr = reduceFrac(p.root.p, p.root.q);
    if (fr.q !== p.root.q || fr.p !== p.root.p) return false;
    if (fr.q <= 0) return false;
    return true;
  }

  /* ---- 泄露检查 ---- */

  function checkLeak(explanation, answer) {
    // 首句（到第一个逗号）不含 x=<answer> 且不含"系数化为"
    var i = explanation.search(/[，。；;,]/);
    var firstClause = i < 0 ? explanation : explanation.slice(0, i + 1);
    var ansRe = new RegExp('x\\s*=\\s*' + answer.replace('/', '\\/'));
    if (ansRe.test(firstClause)) return false;
    if (firstClause.indexOf('系数化为') >= 0) return false;
    return true;
  }

  /* ---- 撞题去重 ---- */

  function canon(s) { return String(s || '').replace(/\s+/g, ''); }

  function checkCollision(prompt, avoidPrompts) {
    if (!avoidPrompts || !avoidPrompts.length) return false;
    var c = canon(prompt);
    for (var i = 0; i < avoidPrompts.length; i++) {
      if (canon(avoidPrompts[i]) === c) return true;
    }
    return false;
  }

  /* ---- 核心：genVariant ---- */

  function genVariant(topicId, index, opts) {
    if (!supports(topicId)) return null;
    opts = opts || {};
    index = index || 0;

    var base = (opts.seed || topicId) + '|' + topicId + '|v' + index;
    var avoidPrompts = opts.avoidPrompts || [];

    // 难度与 recipe 由 index 决定（不参与重抽）
    var diffIdx = hashStr(base) % 3;
    var difficulty = DIFF_RANK[diffIdx];
    var recipes = DIFF_RECIPES[difficulty];
    var recipeIdx = hashStr(base + '|r') % recipes.length;
    var recipe = recipes[recipeIdx];

    var branch = 'normal';

    for (var attempt = 0; attempt < 60; attempt++) {
      var seedKey = base + '#' + attempt;
      var rng = mulberry32(hashStr(seedKey));
      rng(); // 预热

      // 分级兜底
      var intOnly = false;
      var useRecipe = recipe;
      if (attempt >= 30 && attempt < 50) { intOnly = true; branch = 'intOnly'; }
      else if (attempt >= 50) {
        // 降级 recipe：standard T2↔T4，advanced 只有 T3 时落兜底
        if (difficulty === 'standard') {
          useRecipe = recipe === 'T2' ? 'T4' : 'T2';
          intOnly = true;
          branch = 'downgrade';
        } else if (difficulty === 'advanced') {
          // 落到 T1 兜底
          useRecipe = 'T1';
          intOnly = true;
          branch = 'fallback';
        } else {
          // basic 已是 T1，保持
          intOnly = true;
          branch = 'downgrade';
        }
      }

      // 抽根
      var root = pickRoot(rng, difficulty, intOnly);

      // 用 recipe builder 生成
      var builder = RECIPE_BUILDERS[useRecipe];
      var result = builder(rng, root, intOnly);

      if (!result) continue;

      // 展开成 A,B,C,D
      var L = { A: result.A, B: result.B, C: result.C, D: result.D };

      // 不变量断言
      if (!checkInvariants(L, useRecipe, result)) continue;

      // 生成题面
      var prompt = renderPrompt(useRecipe, result);
      if (!prompt) continue;

      // 撞题检查
      if (checkCollision(prompt, avoidPrompts)) continue;

      // 泄露检查
      var answer = formatRoot(result.root);
      var explanation = renderExplanation(useRecipe, result, L, result.root);
      if (!checkLeak(explanation, answer)) continue;

      // 生成 verify
      var verifyNum = reduceFrac(L.D - L.B, L.A - L.C);
      var verify = 'Fraction(' + verifyNum.p + ',' + verifyNum.q + ')';

      // 生成 accept
      var accept = computeAccept(result.root);

      // 构造题对象
      var q = {
        id: topicId + '_v' + (index + 1),
        topicId: topicId,
        difficulty: branch === 'fallback' ? 'basic' : difficulty,
        type: 'numeric',
        prompt: prompt,
        answer: answer,
        verify: verify,
        explanation: explanation,
        variant: true,
        variantIndex: index,
        variantRecipe: useRecipe,
        branch: branch
      };
      if (accept) q.accept = accept;

      return q;
    }

    // 末级兜底：T1 固定参数（必然成功）
    var fbRng = mulberry32(hashStr(base + '#fallback'));
    fbRng();
    var fb = buildT1Fallback(fbRng);
    var fbL = { A: fb.A, B: fb.B, C: fb.C, D: fb.D };
    var fbRoot = fb.root;
    var fbPrompt = renderPrompt('T1', fb);
    var fbAnswer = formatRoot(fbRoot);
    var fbExpl = renderExplanation('T1', fb, fbL, fbRoot);
    var fbVerify = reduceFrac(fbL.D - fbL.B, fbL.A - fbL.C);

    return {
      id: topicId + '_v' + (index + 1),
      topicId: topicId,
      difficulty: 'basic',
      type: 'numeric',
      prompt: fbPrompt,
      answer: fbAnswer,
      verify: 'Fraction(' + fbVerify.p + ',' + fbVerify.q + ')',
      explanation: fbExpl,
      variant: true,
      variantIndex: index,
      variantRecipe: 'T1',
      branch: 'fallback'
    };
  }

  /* ---- variantSet：连续生成 count 道 ---- */

  function variantSet(topicId, startIndex, count, opts) {
    if (!supports(topicId)) return [];
    opts = opts || {};
    var out = [];
    var idx = startIndex || 0;
    for (var i = 0; i < count; i++) {
      var q = genVariant(topicId, idx, opts);
      if (q) { out.push(q); idx++; }
      else break;
    }
    return out;
  }

  /* ---- fillPractice：共存策略（纯函数） ---- */

  function fillPractice(bankPicks, topicId, n, opts) {
    opts = opts || {};
    var done = new Set(opts.doneIds || []);
    var picks = (bankPicks || []).slice();
    var fresh = picks.filter(function (q) { return !done.has(q.id); });
    var out = fresh.slice(0, Math.max(1, n));
    var next = opts.startIndex || 0;
    var used = 0;
    if (out.length < n && supports(topicId)) {
      var vs = variantSet(topicId, next, n - out.length, {
        seed: opts.seed, difficulty: opts.difficulty, avoidPrompts: opts.avoidPrompts
      });
      used = vs.length; next += vs.length;
      for (var i = 0; i < vs.length; i++) out.push(vs[i]);
    }
    // 现状兜底：题库复用
    for (var j = 0; j < picks.length && out.length < n; j++) {
      if (out.indexOf(picks[j]) < 0) out.push(picks[j]);
    }
    return { list: out, usedVariants: used, nextIndex: next };
  }

  return {
    VERSION: 1,
    supports: supports,
    genVariant: genVariant,
    variantSet: variantSet,
    classifyLinear: classifyLinear,
    fillPractice: fillPractice
  };
});
