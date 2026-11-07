/* 卡 B 确定性构造器：答案/解集先行（零 LLM、零网络、零新依赖）。
 *
 * 定位：「变式供给」而不是「补缺口」。给卡 A plan 里 strategy=construct 的 19 个
 * 知识点提供无限抽取、答案由构造保证正确的纯文本数值题。不解决 no-figure /
 * no-challenge 缺口（那是明确放弃的部分，见卡 B 评论）。
 *
 * 为什么「解集先行」：二次方程若先定一个根再反推，第二个根会自己冒出来，
 * 答案必然不完整。这里先抽根集 {p,q}（判别式天然 > 0 且为完全平方），
 * 再展开 a(x-p)(x-q) = ax²-a(p+q)x+apq，题面与完整答案一次性得到。
 *
 * 与 variants.js 的关系：同一个「先定答案再反推系数」的模式，但**不改它**。
 * 新文件新入口，19 个知识点各有自己的题面模板（模板文案与题库骨架不撞，
 * 见 tests/test_variants_construct.js 的骨架去重断言）。
 *
 * 五道门（本模块内自带，且测试侧独立重算一遍）：
 *   1 代回成立   根代回方程左右两边（沿用 llm-eval 的 evaluateExpression 口径；
 *                模块内用精确有理数运算，测试侧用 evaluateExpression 独立复算）
 *   2 解集完整   根数 == 次数 且互异；二次还要求判别式 > 0 且为完全平方
 *   3 不变量     系数/根/分母随难度档收紧；分式方程排除增根（根不等于极点）
 *   4 撞题去重   题干规范化后与 avoidPrompts 精确比对 + 抽掉数字的骨架比对
 *   5 泄露       解析不含答案（且解析全篇不含任何数字，最严口径）；
 *                题干不得以「x=…」「根为…」等断言形式给出答案
 *
 * 浏览器：window.DiagConstruct（需先加载 llm-eval.js）；Node：require() 直接用。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./llm-eval.js'));
  else root.DiagConstruct = factory(root.DiagLLMEval);
})(typeof self !== 'undefined' ? self : this, function (__evaldn) {
  'use strict';

  var Eval = __evaldn;

  /* ================================================================
   * 确定性 RNG（与 variants.js / engine.js 同款，刻意复制不做跨模块 require）
   * ================================================================ */

  function hashStr(str) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  }

  function mulberry32(a) {
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function rint(rng, lo, hi) { return lo + Math.floor(rng() * (hi - lo + 1)); }
  function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }
  function signOf(rng) { return rng() < 0.5 ? -1 : 1; }

  // [-hi..hi] 里的非零整数
  function nzInt(rng, hi) {
    var n = 0, guard = 0;
    while (n === 0 && guard < 30) { n = rint(rng, -hi, hi); guard++; }
    return n === 0 ? 1 : n;
  }

  /* ================================================================
   * 有理数（整数分子/分母，全程精确运算，只有渲染处才变字符串）
   * ================================================================ */

  function gcd(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) { var t = a % b; a = b; b = t; } return a || 1; }
  function lcm(a, b) { return Math.abs(a * b) / gcd(a, b); }

  function R(p, q) {
    if (q == null) q = 1;
    if (q < 0) { p = -p; q = -q; }
    var g = gcd(p, q);
    return { p: p / g, q: q / g };
  }
  function rNum(r) { return r.p / r.q; }
  function rStr(r) { return r.q === 1 ? String(r.p) : r.p + '/' + r.q; }

  /* ================================================================
   * 题面渲染（整数系数多项式；ASCII 括号/减号，便于 evaluateExpression 复算）
   * ================================================================ */

  // ax+b（a≠0）：3x+2 / -x-5
  function lin(a, b) {
    var s = a === 1 ? 'x' : (a === -1 ? '-x' : a + 'x');
    if (b !== 0) s += (b > 0 ? '+' : '-') + Math.abs(b);
    return s;
  }

  // 一次项（带符号）：+x / -x / +3x / -12x
  function xTerm(n) {
    return (n >= 0 ? '+' : '-') + (Math.abs(n) === 1 ? '' : Math.abs(n)) + 'x';
  }

  // ax²+bx+c
  function quad(a, b, c) {
    var s = a === 1 ? 'x²' : (a === -1 ? '-x²' : a + 'x²');
    if (b !== 0) s += (b > 0 ? '+' : '-') + (Math.abs(b) === 1 ? '' : Math.abs(b)) + 'x';
    if (c !== 0) s += (c > 0 ? '+' : '-') + Math.abs(c);
    return s;
  }

  // 括号内的常数：+3 / -3
  function sgn(n) { return n >= 0 ? '+' + n : '' + n; }

  // 多未知数线性式（2 或 3 元）：2x-y+3z=6
  function linN(coefs, constTerm) {
    var vars = ['x', 'y', 'z'];
    var s = '';
    for (var i = 0; i < coefs.length; i++) {
      var v = coefs[i];
      if (!v) continue;
      var mag = Math.abs(v) === 1 ? '' : Math.abs(v);
      s += (v > 0 ? (s ? '+' : '') : '-') + mag + vars[i];
    }
    return (s || '0') + '=' + constTerm;
  }

  /* ================================================================
   * 难度档：系数/根/分母上限 + 提示语
   * ================================================================ */

  var RANGE = {
    basic: { coef: 8, root: 8, den: 1, lead: 2 },
    standard: { coef: 16, root: 16, den: 4, lead: 5 },
    advanced: { coef: 24, root: 24, den: 6, lead: 6 }
  };

  /* 不变量表（模块内与测试侧共用同一份口径，但测试侧从题面重新提取数字复算）
   *
   * 两个上限刻意分开：
   *   maxNumber  题面里出现的数（系数、常数项、已知根）的规模 —— 决定题的「样子」有多难
   *   maxAnswer  派生答案（完全平方式里的常数 c=(b/2)²、两根之积、平方和、线段长）的规模
   * 派生量天然是系数的平方量级，用同一个 maxNumber 卡会把完全平方式这类族的题面空间压到
   * 只剩一二十道（实测 basic 档 18 道），变式供给退化成「同一道题反复出现」。
   * 分开后系数规模不变，只是允许答案比系数大。 */
  var INVARIANT = {
    basic: { maxNumber: 12, maxRootAbs: 8, maxDen: 1, maxAnswer: 64, allowFraction: false },
    standard: { maxNumber: 72, maxRootAbs: 16, maxDen: 4, maxAnswer: 900, allowFraction: true },
    advanced: { maxNumber: 120, maxRootAbs: 24, maxDen: 6, maxAnswer: 1600, allowFraction: true }
  };

  function maxNum(d) { return INVARIANT[d].maxNumber; }
  function maxAns(d) { return INVARIANT[d].maxAnswer; }

  /* 抽一个根（留分数根给 standard/advanced） */
  function pickRoot(rng, difficulty) {
    var Rg = RANGE[difficulty];
    if (difficulty !== 'basic' && rng() < (difficulty === 'advanced' ? 0.45 : 0.25)) {
      var dens = difficulty === 'advanced' ? [2, 3, 4, 5, 6] : [2, 3, 4];
      var den = pick(rng, dens);
      var num = 0, guard = 0;
      do { num = rint(rng, -Rg.root, Rg.root); guard++; }
      while ((num === 0 || gcd(num, den) !== 1) && guard < 40);
      if (num !== 0 && gcd(num, den) === 1) return R(num, den);
    }
    var n = rint(rng, -Rg.root, Rg.root);
    if (n === 0) n = pick(rng, [-3, -2, 2, 3]);
    return R(n, 1);
  }

  /* ================================================================
   * 解析模板（每族一条，全篇无数字 → 永不含答案）
   * ================================================================ */

  var RULES = {
    'param-linear-solution': '把已知的解代回方程，先算出含未知数的那一项以外的部分，再移项就得到字母的值。',
    'linear-two-sides': '把含未知数的项移到左边、常数项移到右边，合并同类项后两边同除以未知数的系数。',
    'linear-bracket': '先去括号（注意括号前的负号要变号），再移项、合并同类项，最后两边同除以未知数的系数。',
    'linear-fraction': '两边同乘各分母的最小公倍数去分母，再移项、合并同类项，最后两边同除以未知数的系数。',
    'bivar-value': '把已知的那个未知数的值代入方程，先算出它的项，再把另一个未知数留在一边，两边同除以它的系数。',
    'system2-solve': '用代入消元或加减消元先消去一个未知数，解出一个未知数后回代求另一个。',
    'system3-solve': '按顺序消元：先用前两个方程消去一个未知数，再与第三个方程联立，解出后逐个回代。',
    'frac-linear': '两边同乘各分母的最简公分母去分母，解出整式方程的根后必须检验原分母是否为零。',
    'linear-fn-param-k': '一次函数图象与 x 轴交点的横坐标就是对应一元一次方程的解，把交点坐标代入解析式解出字母系数。',
    'linear-fn-param-k-points': '把已知点的坐标代入解析式，与 y 轴交点的纵坐标就是常数项，代入后解出字母系数。',
    'linear-fn-system-param': '交点同时满足两条直线的解析式，把交点坐标代入含字母的那条解析式就能解出字母。',
    'quad-general-form': '把右边的项全部移到左边，合并同类项后按二次项、一次项、常数项的顺序读系数，并带上符号。',
    'quad-direct-square': '化成 (x-m)²=k 的形式后开平方，被开方数为正时两个根关于 m 对称。',
    'complete-square-const': '完全平方式满足「一次项系数一半的平方等于常数项」，把一次项系数除以二再平方即可。',
    'complete-square-solve': '先把二次项系数变成一，把常数项移到右边，两边加上一次项系数一半的平方配成完全平方式，最后开平方。',
    'quad-formula': '先算判别式，再用求根公式；注意公式分子里是「负的一次项系数」加减判别式的算术平方根。',
    'quad-factor': '把左边分解成两个一次因式的积、右边为零，则每个因式为零，分别解出两个根。',
    'quad-common-factor': '左边提取公因式 x，右边移项后分解；不要两边同除以 x，否则会丢掉一个根。',
    'vieta-sum-product': '两根之和等于一次项系数的相反数除以二次项系数，两根之积等于常数项除以二次项系数。',
    'vieta-square-sum': '先用两根之和与两根之积表示所求的对称式（平方和等于和的平方减去积的二倍），再整体代入。',
    'parabola-intercepts': '抛物线与 x 轴交点的横坐标就是对应一元二次方程的根，令函数值为零解方程即可。',
    'parabola-distance': '先求出两个交点的横坐标，两点纵坐标都是零，所以线段长等于两个横坐标之差的绝对值。',
    'quad-select-root': '先求出方程的两个实根，再比较大小，取题目要求的那个根。'
  };

  /* ================================================================
   * 收口：把参数化结果装配成题对象（含测试侧独立复算所需的 spec）
   * ================================================================ */

  function finish(meta, difficulty, o) {
    var parts = o.parts;
    var answer = parts.map(rStr).join('，');
    var q = {
      topicId: meta.topic,
      difficulty: difficulty,
      type: 'numeric',
      prompt: o.prompt,
      answer: answer,
      explanation: RULES[meta.id],
      variant: true,
      constructFamily: meta.family,
      constructRecipe: meta.id,
      constructSpec: o.spec,
      numberParts: parts.map(function (p) { return { p: p.p, q: p.q }; }),
      verify: o.verify
    };
    if (o.unordered) q.unordered = true;
    if (o.accept) q.accept = o.accept;
    return q;
  }

  /* ================================================================
   * 各族 builder：先定答案 → 反推系数 → 渲染题面
   * 返回 null 表示这组参数不合形态约束（重抽，不是错题）
   * ================================================================ */

  var BUILDERS = {

    /* cnm_039 方程与方程的解：已知解求字母 m（m = ar+b） */
    'param-linear-solution': function (rng, difficulty, meta) {
      var Rg = RANGE[difficulty];
      var a = pick(rng, difficulty === 'basic' ? [2, 3, 4, 5] : [2, 3, 4, 5, 6, 7, 8, 9]);
      var b = nzInt(rng, Rg.coef);
      var r = rint(rng, -Rg.root, Rg.root);
      if (r === 0) r = signOf(rng) * 3;
      var m = a * r + b;
      if (m === r) { b += 1; m = a * r + b; }           // 避免题干「已知 x=r」与答案同值
      if (m === 0 || Math.abs(m) > maxNum(difficulty)) return null;
      var lhs = lin(a, b);
      var prompt = rng() < 0.5
        ? '已知 x=' + r + ' 是方程 ' + lhs + '=m 的解，求 m 的值。'
        : '方程 ' + lhs + '=m 的解是 x=' + r + '，求 m 的值。';
      return finish(meta, difficulty, {
        prompt: prompt,
        parts: [R(m, 1)],
        spec: { kind: 'param', degree: 1, display: { lhs: lhs, rhs: 'm' }, unknowns: ['m'], anchors: { x: r } },
        verify: function () { return a * r + b === m; }
      });
    },

    /* cnm_042 移项与合并同类项：ax+b = cx+d，根空间先行 */
    'linear-two-sides': function (rng, difficulty, meta) {
      var Rg = RANGE[difficulty];
      var a = rint(rng, 2, Rg.coef);
      var c = rint(rng, 2, Rg.coef);
      if (a === c) return null;
      var b = nzInt(rng, Rg.coef);
      var root = pickRoot(rng, difficulty);
      var d = (b * root.q + (a - c) * root.p) / root.q;   // d = b+(a-c)r（使根恰为 r）
      if (!isFinite(d) || d !== Math.round(d)) return null;
      if (d === 0 || Math.abs(d) > Rg.coef * 2 || d === b) return null;
      var lhs = lin(a, b), rhs = lin(c, d);
      return finish(meta, difficulty, {
        prompt: '解方程 ' + lhs + '=' + rhs + '，结果写成整数或最简分数。（只填 x 的值）',
        parts: [root],
        spec: { kind: 'roots', degree: 1, display: { lhs: lhs, rhs: rhs } },
        verify: function () { return (a - c) * root.p + (b - d) * root.q === 0; }
      });
    },

    /* cnm_043 含括号的一元一次方程：a(x+b) = c(x+d) + e */
    'linear-bracket': function (rng, difficulty, meta) {
      var Rg = RANGE[difficulty];
      var a = rint(rng, 2, Rg.coef);
      var c = rint(rng, 2, Rg.coef);
      if (a === c) return null;
      var b = nzInt(rng, Rg.coef);
      var d = nzInt(rng, Rg.coef);
      if (d === b) return null;
      var root = pickRoot(rng, difficulty);
      // e = a(r+b) - c(r+d) = (a-c)r + ab - cd
      var eNum = (a - c) * root.p + (a * b - c * d) * root.q;
      if (eNum % root.q !== 0) return null;
      var e = eNum / root.q;
      if (e === 0 || Math.abs(e) > maxNum(difficulty)) return null;
      var lhs = a + '(x' + sgn(b) + ')';
      var rhs = c + '(x' + sgn(d) + ')' + sgn(e);
      return finish(meta, difficulty, {
        prompt: '解方程 ' + lhs + '=' + rhs + '，结果写成整数或最简分数。（只填 x 的值）',
        parts: [root],
        spec: { kind: 'roots', degree: 1, display: { lhs: lhs, rhs: rhs } },
        verify: function () {
          return (a * (root.p + b * root.q) * root.q === c * (root.p + d * root.q) * root.q + e * root.q * root.q);
        }
      });
    },

    /* cnm_044 含分母的一元一次方程：(x+a)/m - (x+b)/n = c */
    'linear-fraction': function (rng, difficulty, meta) {
      var Rg = RANGE[difficulty];
      var m = pick(rng, [2, 3, 4]);
      var n = pick(rng, [2, 3, 4]);
      if (m === n) return null;
      var r = rint(rng, -Rg.root, Rg.root);
      if (r === 0) r = 2;
      var u = nzInt(rng, Rg.coef);          // (r+a)/m
      var v = nzInt(rng, Rg.coef);          // (r+b)/n
      var a = m * u - r;
      var b = n * v - r;
      var c = u - v;
      if (a === 0 || b === 0 || c === 0) return null;
      if (Math.abs(a) > maxNum(difficulty) || Math.abs(b) > maxNum(difficulty) || Math.abs(c) > maxNum(difficulty)) return null;
      var lhs = '(x' + sgn(a) + ')/' + m + '-(x' + sgn(b) + ')/' + n;
      return finish(meta, difficulty, {
        prompt: '解方程 ' + lhs + '=' + c + '，结果写成整数或最简分数。（只填 x 的值）',
        parts: [R(r, 1)],
        spec: { kind: 'roots', degree: 1, display: { lhs: lhs, rhs: String(c) } },
        verify: function () { return (r + a) * n - (r + b) * m === c * m * n; }
      });
    },

    /* cnm_087 二元一次方程及其解：ax+by=c 中已知 x 求 y */
    'bivar-value': function (rng, difficulty, meta) {
      var Rg = RANGE[difficulty];
      var a = rint(rng, 2, 6);
      var b = rint(rng, 2, 6);
      var x0 = rint(rng, -5, 5);
      if (x0 === 0) x0 = signOf(rng) * 2;              // x=0 会让代入过于退化
      var y0 = nzInt(rng, Rg.coef);
      var c = a * x0 + b * y0;
      if (Math.abs(c) > maxNum(difficulty)) return null;
      if (y0 === x0) return null;                    // 免与已知 x 同值造成歧义
      var lhs = a + 'x' + sgn(b) + 'y';
      return finish(meta, difficulty, {
        prompt: '已知方程 ' + lhs + '=' + c + ' 中，当 x=' + x0 + ' 时，y 的值是多少？',
        parts: [R(y0, 1)],
        spec: { kind: 'param', degree: 1, display: { lhs: lhs, rhs: String(c) }, unknowns: ['y'], anchors: { x: x0 } },
        verify: function () { return a * x0 + b * y0 === c; }
      });
    },

    /* cnm_088 二元一次方程组：解 (x0,y0) 先行 → 反推常数项 */
    'system2-solve': function (rng, difficulty, meta) {
      var Rg = RANGE[difficulty];
      var x0 = rint(rng, -Rg.coef, Rg.coef);
      var y0 = rint(rng, -Rg.coef, Rg.coef);
      var a1 = 0, b1 = 0, a2 = 0, b2 = 0, det = 0, guard = 0;
      while (det === 0 && guard < 60) {
        a1 = rint(rng, -Rg.coef, Rg.coef); if (a1 === 0) a1 = 2;
        b1 = rint(rng, -Rg.coef, Rg.coef); if (b1 === 0) b1 = -3;
        a2 = rint(rng, -Rg.coef, Rg.coef); if (a2 === 0) a2 = 1;
        b2 = rint(rng, -Rg.coef, Rg.coef); if (b2 === 0) b2 = 4;
        det = a1 * b2 - a2 * b1;
        guard++;
      }
      if (det === 0) return null;
      if (a1 === a2 && b1 === b2) return null;
      var c1 = a1 * x0 + b1 * y0;
      var c2 = a2 * x0 + b2 * y0;
      if (Math.abs(c1) > maxNum(difficulty) || Math.abs(c2) > maxNum(difficulty)) return null;
      var e1 = linN([a1, b1], c1);
      var e2 = linN([a2, b2], c2);
      return finish(meta, difficulty, {
        prompt: '解方程组 {' + e1 + ', ' + e2 + '}。（依次写出 x、y 的值，用逗号隔开）',
        parts: [R(x0, 1), R(y0, 1)],
        spec: {
          kind: 'system', degree: 2, vars: ['x', 'y'],
          display: [{ lhs: linN([a1, b1], c1).split('=')[0], rhs: String(c1) },
                    { lhs: linN([a2, b2], c2).split('=')[0], rhs: String(c2) }]
        },
        verify: function () {
          return (a1 * x0 + b1 * y0 === c1) && (a2 * x0 + b2 * y0 === c2) && (det !== 0);
        }
      });
    },

    /* cnm_093 三元一次方程组：解先行 → 反推三个常数项，det≠0 保证唯一 */
    'system3-solve': function (rng, difficulty, meta) {
      var Rg = RANGE[difficulty];
      var x0 = rint(rng, -6, 6), y0 = rint(rng, -6, 6), z0 = rint(rng, -6, 6);
      var M = null, det = 0, guard = 0;
      while (det === 0 && guard < 80) {
        M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
        for (var i = 0; i < 3; i++) {
          for (var j = 0; j < 3; j++) {
            M[i][j] = rint(rng, -3, 3);
            if (M[i][j] === 0 && i === j) M[i][j] = 1;
          }
        }
        // 每行至少两个非零系数：避免出现「-y+2z=1」这类单变量退化行
        var degenerate = false;
        for (var r2 = 0; r2 < 3; r2++) {
          var nnz = 0;
          for (var c2 = 0; c2 < 3; c2++) if (M[r2][c2] !== 0) nnz++;
          if (nnz < 2) degenerate = true;
        }
        det = degenerate ? 0 : det3(M);
        guard++;
      }
      if (det === 0) return null;
      var sol = [x0, y0, z0];
      var cs = [0, 0, 0];
      for (var k = 0; k < 3; k++) cs[k] = M[k][0] * x0 + M[k][1] * y0 + M[k][2] * z0;
      for (var z = 0; z < 3; z++) if (Math.abs(cs[z]) > maxNum(difficulty)) return null;
      var eqs = [linN(M[0], cs[0]), linN(M[1], cs[1]), linN(M[2], cs[2])];
      return finish(meta, difficulty, {
        prompt: '解三元一次方程组 {' + eqs.join(', ') + '}。（依次写出 x、y、z 的值，用逗号隔开）',
        parts: [R(x0, 1), R(y0, 1), R(z0, 1)],
        spec: {
          kind: 'system', degree: 3, vars: ['x', 'y', 'z'],
          display: [
            { lhs: linN(M[0], cs[0]).split('=')[0], rhs: String(cs[0]) },
            { lhs: linN(M[1], cs[1]).split('=')[0], rhs: String(cs[1]) },
            { lhs: linN(M[2], cs[2]).split('=')[0], rhs: String(cs[2]) }
          ]
        },
        verify: function () {
          var ok = det3(M) !== 0;
          for (var t = 0; t < 3; t++) {
            if (M[t][0] * x0 + M[t][1] * y0 + M[t][2] * z0 !== cs[t]) ok = false;
          }
          return ok;
        }
      });
    },

    /* cnm_165 分式方程：a/x = b/(x+k)，解先行 → 反推 k；根不得是极点 */
    'frac-linear': function (rng, difficulty, meta) {
      var as = difficulty === 'basic' ? [2, 3] : [2, 3, 4, 5, 6, 8, 9];
      var a = pick(rng, as);
      var b = pick(rng, [2, 3, 4, 5, 6, 8, 9, 10, 12]);
      if (b === a) return null;
      var r = rint(rng, -14, 14);
      if (r === 0) r = 3;
      var kNum = r * (b - a);
      if (kNum % a !== 0) return null;
      var k = kNum / a;
      if (k === 0 || Math.abs(k) > 24) return null;
      if (r + k === 0) return null;                    // 根不能是极点 x=-k
      var lhs = a + '/x';
      var rhs = b + '/(x' + sgn(k) + ')';
      return finish(meta, difficulty, {
        prompt: '解分式方程 ' + lhs + '=' + rhs + '，把 x 写成整数或最简分数。',
        parts: [R(r, 1)],
        spec: { kind: 'frac-roots', degree: 1, display: { lhs: lhs, rhs: rhs }, poles: [0, -k] },
        verify: function () { return a * (r + k) === b * r && r !== 0 && r + k !== 0; }
      });
    },

    /* cnm_206 一次函数与一元一次方程：给定两轴交点 → 求 k=-b0/r */
    'linear-fn-param-k': function (rng, difficulty, meta) {
      var inv = INVARIANT[difficulty];
      var k = signOf(rng) * rint(rng, 2, 6);
      var r = signOf(rng) * rint(rng, 1, inv.maxRootAbs);
      var b0 = -k * r;
      if (Math.abs(b0) > inv.maxNumber || Math.abs(k) > inv.maxNumber) return null;
      var lhs = 'kx' + sgn(b0);
      var prompt = rng() < 0.5
        ? '已知一次函数 y=kx+b 的图象与 x 轴交于点 (' + r + ',0)，与 y 轴交于点 (0,' + b0 + ')，求 k 的值。'
        : '一次函数 y=kx+b 的图象经过点 (' + r + ',0) 和点 (0,' + b0 + ')，求 k 的值。';
      return finish(meta, difficulty, {
        prompt: prompt,
        parts: [R(k, 1)],
        spec: { kind: 'param', degree: 1, display: { lhs: lhs, rhs: '0' }, unknowns: ['k'], anchors: { x: r } },
        verify: function () { return k * r + b0 === 0; }
      });
    },

    /* cnm_206 一次函数与一元一次方程：给一个非轴点 + 与 y 轴交点 → 求 k */
    'linear-fn-param-k-points': function (rng, difficulty, meta) {
      var inv = INVARIANT[difficulty];
      var x1 = signOf(rng) * rint(rng, 2, inv.maxRootAbs);
      var b0 = nzInt(rng, inv.maxNumber > 20 ? 12 : 6);
      var k = signOf(rng) * rint(rng, 2, 6);
      var y1 = k * x1 + b0;
      if (Math.abs(y1) > inv.maxNumber) return null;
      var lhs = 'kx' + sgn(b0);
      return finish(meta, difficulty, {
        prompt: '已知一次函数 y=kx+b 的图象经过点 (' + x1 + ',' + y1 + ') 和点 (0,' + b0 + ')，求 k 的值。',
        parts: [R(k, 1)],
        spec: { kind: 'param', degree: 1, display: { lhs: lhs, rhs: String(y1) }, unknowns: ['k'], anchors: { x: x1 } },
        verify: function () { return k * x1 + b0 === y1; }
      });
    },

    /* cnm_208 一次函数与二元一次方程组：交点先行 → 反推 m */
    'linear-fn-system-param': function (rng, difficulty, meta) {
      var Rg = RANGE[difficulty];
      var x0 = rint(rng, -6, 6), y0 = rint(rng, -8, 8);
      var k1 = nzInt(rng, 5);
      var b1 = y0 - k1 * x0;
      var k2 = nzInt(rng, 5);
      if (k2 === k1 || k2 === 0) return null;
      var m0 = y0 - k2 * x0;
      if (Math.abs(m0) > Rg.coef * 2 || Math.abs(b1) > Rg.coef * 3) return null;
      var lhs = k2 + 'x+m';
      return finish(meta, difficulty, {
        prompt: '已知直线 y=' + lin(k1, b1) + ' 与直线 y=' + k2 + 'x+m 交于点 (' + x0 + ',' + y0 + ')，求 m 的值。',
        parts: [R(m0, 1)],
        spec: { kind: 'param', degree: 1, display: { lhs: lhs, rhs: String(y0) }, unknowns: ['m'], anchors: { x: x0 } },
        verify: function () {
          return k2 * x0 + m0 === y0 && k1 * x0 + b1 === y0;
        }
      });
    },

    /* cnm_219 一元二次方程的概念：先定 (a,b,c)，再用移项形式藏起来 */
    'quad-general-form': function (rng, difficulty, meta) {
      var a = pick(rng, difficulty === 'basic' ? [1, 2] : [1, 2, 3]);
      var b = nzInt(rng, difficulty === 'basic' ? 6 : 8);
      var c = nzInt(rng, difficulty === 'basic' ? 6 : 8);
      var k = 0, m0 = 0, guard = 0;
      do { k = rint(rng, -5, 5); m0 = rint(rng, -5, 5); guard++; }
      while ((k === 0 && m0 === 0) && guard < 40);
      if (k === 0 && m0 === 0) return null;
      if (Math.abs(b + k) > maxNum(difficulty) || Math.abs(c + m0) > maxNum(difficulty)) return null;
      var lhs = quad(a, b + k, c + m0);
      var rhs = lin(k, m0);
      var spec = { kind: 'coeffs', degree: 2, display: { lhs: lhs, rhs: rhs } };
      return finish(meta, difficulty, {
        prompt: '把方程 ' + lhs + '=' + rhs + ' 化为一般形式 ax²+bx+c=0（a>0），依次写出二次项系数、一次项系数、常数项（用逗号隔开）。',
        parts: [R(a, 1), R(b, 1), R(c, 1)],
        spec: spec,
        verify: function () {
          // 逐点精确验证 lhs-rhs ≡ ax²+bx+c
          for (var x = -2; x <= 2; x++) {
            if ((a * x * x + (b + k) * x + (c + m0)) - (k * x + m0) !== a * x * x + b * x + c) return false;
          }
          return a > 0;
        }
      });
    },

    /* cnm_220 直接开平方法：c0(x-m)²=c0·s²，根集 {m±s} 先行（三种等价写法各占一部分） */
    'quad-direct-square': function (rng, difficulty, meta) {
      var Rg = RANGE[difficulty];
      var m0 = rint(rng, difficulty === 'basic' ? -6 : -9, difficulty === 'basic' ? 6 : 9);
      var s = rint(rng, 1, difficulty === 'basic' ? 3 : 6);
      var c0 = difficulty === 'basic' ? 1 : pick(rng, [1, 1, 2, 3, 4]);
      var k = s * s;
      if (c0 * k > maxNum(difficulty)) return null;
      var inner = m0 === 0 ? 'x' : 'x' + sgn(-m0);
      var sq = (c0 === 1 ? '' : String(c0)) + '(' + inner + ')²';
      var rhs = c0 * k;
      var form = Math.floor(rng() * 3);
      var prompt;
      if (form === 0) prompt = '用直接开平方法解方程 ' + sq + '=' + rhs + '，两个根用逗号隔开。';
      else if (form === 1) prompt = '解方程 ' + sq + '-' + rhs + '=0，两个根用逗号隔开。';
      else prompt = '方程 ' + sq + '=' + rhs + ' 可以用直接开平方法求解，两个根分别是多少？（用逗号隔开）';
      return finish(meta, difficulty, {
        prompt: prompt,
        parts: [R(m0 + s, 1), R(m0 - s, 1)],
        unordered: true,
        spec: { kind: 'roots', degree: 2, display: { lhs: sq, rhs: String(rhs) }, invariants: { perfectSquare: true } },
        verify: function () {
          return c0 !== 0 && s !== 0 &&
            (c0 * (m0 + s - m0) * (m0 + s - m0) === c0 * k) &&
            (c0 * (m0 - s - m0) * (m0 - s - m0) === c0 * k);
        }
      });
    },

    /* cnm_221 配方法（求常数）：答案 a·m² 先行 → 反推一次项 2√a·m */
    'complete-square-const': function (rng, difficulty, meta) {
      var a = pick(rng, [1, 1, 4, 9]);               // a 取完全平方数：(√a·x+m)² 展开后一次项系数整数
      var sq = Math.sqrt(a);                         // 1 / 2 / 3
      var mMax = Math.min(Math.floor(maxNum(difficulty) / (2 * sq)), Math.floor(Math.sqrt(maxAns(difficulty))));
      if (mMax < 1) return null;
      var m0 = rint(rng, 1, mMax) * (rng() < 0.5 ? -1 : 1);
      var letter = pick(rng, ['c', 'k', 'm']);       // 常数项的字母换着用，扩大题面空间
      var b = 2 * sq * m0;
      // (√a·x+m)² 展开后常数项是 m²（不是 a·m²）：b²-4ac = 4a·m² - 4a·m² = 0
      var c = m0 * m0;
      if (Math.abs(b) > maxNum(difficulty) || c > maxAns(difficulty)) return null;
      var lead = a === 1 ? 'x²' : a + 'x²';
      // 第二种形态（standard 起）：一次项系数为奇数时 c=(b/2)² 是最简分数，
      // 答案写成 25/4 这类分数，题面空间扩大一倍以上，也覆盖了「一半的平方」这个易错点。
      if (difficulty !== 'basic' && a === 1 && rng() < 0.45) {
        var oddB = rint(rng, 1, Math.min(maxNum(difficulty), 2 * Math.floor(Math.sqrt(maxAns(difficulty)))));
        if (oddB % 2 === 0) oddB += 1;
        if (oddB > 1) {
          oddB *= (rng() < 0.5 ? -1 : 1);
          var cFrac = R(oddB * oddB, 4);
          if (Math.abs(cFrac.p / cFrac.q) <= maxAns(difficulty)) {
            return finish(meta, difficulty, {
              prompt: '若 x²' + xTerm(oddB) + '+' + letter + ' 是一个完全平方式，那么 ' + letter + ' 的值是多少？',
              parts: [cFrac],
              spec: { kind: 'perfect-square', degree: 2, a: 1, display: { lhs: 'x²' + xTerm(oddB), rhs: '0' } },
              verify: function () { return oddB * oddB - 4 * cFrac.p / cFrac.q === 0 && cFrac.p > 0; }
            });
          }
        }
      }
      return finish(meta, difficulty, {
        prompt: '若 ' + lead + xTerm(b) + '+' + letter + ' 是一个完全平方式，那么 ' + letter + ' 的值是多少？',
        parts: [R(c, 1)],
        spec: { kind: 'perfect-square', degree: 2, a: a, display: { lhs: lead + xTerm(b), rhs: '0' } },
        verify: function () { return b * b - 4 * a * c === 0 && c > 0; }
      });
    },

    /* cnm_221 配方法（解方程）：整数根集先行 → 展开 x²-(p+q)x+pq */
    'complete-square-solve': function (rng, difficulty, meta) {
      var Rg = RANGE[difficulty];
      var p = rint(rng, -Rg.root, Rg.root), q = rint(rng, -Rg.root, Rg.root);
      if (p === q) return null;
      if (p === 0 || q === 0) return null;
      var b = -(p + q), c = p * q;
      if (b === 0) return null;
      if (Math.abs(b) > maxNum(difficulty) || Math.abs(c) > maxNum(difficulty)) return null;
      var body = 'x²' + xTerm(b) + sgn(c);
      return finish(meta, difficulty, {
        prompt: '用配方法求方程 ' + body + '=0 的两个根（用逗号隔开，写成整数或最简分数）。',
        parts: [R(p, 1), R(q, 1)],
        unordered: true,
        spec: { kind: 'roots', degree: 2, display: { lhs: body, rhs: '0' }, invariants: { perfectSquare: true } },
        verify: function () {
          return (p * p + b * p + c === 0) && (q * q + b * q + c === 0) && p !== q;
        }
      });
    },

    /* cnm_222 公式法：根集先行 → 判别式为完全平方 */
    'quad-formula': function (rng, difficulty, meta) {
      var Rg = RANGE[difficulty];
      var p = pickRoot(rng, difficulty), q = pickRoot(rng, difficulty);
      var den = lcm(p.q, q.q);
      if (den > (difficulty === 'basic' ? 1 : Rg.den)) return null;
      var a = den * rint(rng, 1, difficulty === 'basic' ? 1 : 2);
      // 化为整数系数：a'=a/den 使根为 p,q
      var A = a, B = -a * (p.p * q.q + q.p * p.q) / (p.q * q.q), C = a * p.p * q.p / (p.q * q.q);
      if (B !== Math.round(B) || C !== Math.round(C)) return null;
      B = Math.round(B); C = Math.round(C);
      if (Math.abs(B) > maxNum(difficulty) || Math.abs(C) > maxNum(difficulty)) return null;
      if (A * B * C === 0 && C === 0) return null;
      var body = quad(A, B, C);
      return finish(meta, difficulty, {
        prompt: '用求根公式解方程 ' + body + '=0，两个根用逗号隔开（写成整数或最简分数）。',
        parts: [p, q],
        unordered: true,
        spec: { kind: 'roots', degree: 2, display: { lhs: body, rhs: '0' }, invariants: { perfectSquare: true } },
        verify: function () {
          var ok = true;
          [p, q].forEach(function (r) {
            if (A * r.p * r.p + B * r.p * r.q + C * r.q * r.q !== 0) ok = false;
          });
          return ok && p.p !== q.p;
        }
      });
    },

    /* cnm_224 因式分解法：根集先行 → a(x-p)(x-q) */
    'quad-factor': function (rng, difficulty, meta) {
      var Rg = RANGE[difficulty];
      var p = rint(rng, -Rg.root, Rg.root), q = rint(rng, -Rg.root, Rg.root);
      if (p === q || p === 0 || q === 0) return null;
      var A = difficulty === 'basic' ? 1 : pick(rng, [1, 1, 2, 3]);
      var B = -A * (p + q), C = A * p * q;
      if (Math.abs(B) > maxNum(difficulty) || Math.abs(C) > maxNum(difficulty)) return null;
      var body = quad(A, B, C);
      return finish(meta, difficulty, {
        prompt: '用因式分解法解方程 ' + body + '=0，两个根用逗号隔开。',
        parts: [R(p, 1), R(q, 1)],
        unordered: true,
        spec: { kind: 'roots', degree: 2, display: { lhs: body, rhs: '0' }, invariants: { perfectSquare: true } },
        verify: function () { return A * p * p + B * p + C === 0 && A * q * q + B * q + C === 0 && p !== q; }
      });
    },

    /* cnm_225 解法的选择（提公因式型）：根集 {0,r} 先行 → a·x²-a·p·x=0 */
    'quad-common-factor': function (rng, difficulty, meta) {
      var inv = INVARIANT[difficulty];
      var p = rint(rng, -inv.maxRootAbs, inv.maxRootAbs);
      if (p === 0) p = pickRoot(rng, difficulty).p || 2;
      var a = pick(rng, difficulty === 'basic' ? [1, 2, 3] : [1, 2, 3, 4, 5, 6, 7, 8, 9]);   // 二次项系数保持正数：'-x²' 这类写法判题侧解析不了
      var b = -a * p;
      if (Math.abs(a) > 9 || Math.abs(b) > inv.maxNumber) return null;
      var body = quad(a, b, 0);
      var prompt = rng() < 0.5
        ? '解方程 ' + body + '=0，两个根用逗号隔开。'
        : '方程 ' + body + '=0 的两个根分别是多少？（用逗号隔开）';
      return finish(meta, difficulty, {
        prompt: prompt,
        parts: [R(0, 1), R(p, 1)],
        unordered: true,
        spec: { kind: 'roots', degree: 2, display: { lhs: body, rhs: '0' }, invariants: { perfectSquare: true } },
        verify: function () { return a * p * p + b * p === 0 && p !== 0 && a !== 0; }
      });
    },

    /* cnm_226 根与系数的关系：两根之和/积 */
    'vieta-sum-product': function (rng, difficulty, meta) {
      var Rg = RANGE[difficulty];
      var p = rint(rng, -Rg.root, Rg.root), q = rint(rng, -Rg.root, Rg.root);
      if (p === q || p === 0 || q === 0) return null;
      var A = rint(rng, 1, 3);
      var B = -A * (p + q), C = A * p * q;
      if (Math.abs(B) > maxNum(difficulty) || Math.abs(C) > maxNum(difficulty)) return null;
      var body = quad(A, B, C);
      var sum = R(p + q, 1), prod = R(p * q, 1);
      if (sum.q > Rg.den || prod.q > Rg.den) return null;
      return finish(meta, difficulty, {
        prompt: '若 x1、x2 是方程 ' + body + '=0 的两个根，求 x1+x2 与 x1·x2 的值（依次用逗号隔开，积可写成最简分数）。',
        parts: [sum, prod],
        spec: { kind: 'derived', degree: 2, derived: 'sum-product', display: { lhs: body, rhs: '0' } },
        verify: function () { return A * p * p + B * p + C === 0 && A * q * q + B * q + C === 0 && p !== q; }
      });
    },

    /* cnm_226 根与系数的关系：x1²+x2² = (p+q)²-2pq */
    'vieta-square-sum': function (rng, difficulty, meta) {
      var Rg = RANGE[difficulty];
      var p = rint(rng, -Rg.root, Rg.root), q = rint(rng, -Rg.root, Rg.root);
      if (p === q || p === 0 || q === 0) return null;
      var A = rint(rng, 1, 3);
      var B = -A * (p + q), C = A * p * q;
      if (Math.abs(B) > maxNum(difficulty) || Math.abs(C) > maxNum(difficulty)) return null;
      var body = quad(A, B, C);
      var val = (p + q) * (p + q) - 2 * p * q;
      if (Math.abs(val) > maxAns(difficulty)) return null;
      return finish(meta, difficulty, {
        prompt: '已知方程 ' + body + '=0 的两个根为 x1、x2，求 x1²+x2² 的值。',
        parts: [R(val, 1)],
        spec: { kind: 'derived', degree: 2, derived: 'square-sum', display: { lhs: body, rhs: '0' } },
        // 代入必须是 A·p² + B·p + C（漏掉二次项系数 A 会让 A≠1 的题全部自我否决）
        verify: function () { return A * p * p + B * p + C === 0 && A * q * q + B * q + C === 0 && p !== q; }
      });
    },

    /* cnm_234 二次函数与一元二次方程：交点横坐标 = 根集 */
    'parabola-intercepts': function (rng, difficulty, meta) {
      var Rg = RANGE[difficulty];
      var p = rint(rng, -Rg.root, Rg.root), q = rint(rng, -Rg.root, Rg.root);
      if (p === q || p === 0 || q === 0) return null;
      var A = difficulty === 'basic' ? 1 : pick(rng, [1, 1, 2]);
      var B = -A * (p + q), C = A * p * q;
      if (Math.abs(B) > maxNum(difficulty) || Math.abs(C) > maxNum(difficulty)) return null;
      var body = quad(A, B, C);
      return finish(meta, difficulty, {
        prompt: '已知抛物线 y=' + body + ' 与 x 轴交于 A、B 两点，求这两个交点的横坐标（用逗号隔开）。',
        parts: [R(p, 1), R(q, 1)],
        unordered: true,
        spec: { kind: 'roots', degree: 2, display: { lhs: body, rhs: '0' }, invariants: { perfectSquare: true } },
        verify: function () { return A * p * p + B * p + C === 0 && A * q * q + B * q + C === 0 && p !== q; }
      });
    },

    /* cnm_234 二次函数与一元二次方程：线段 AB = |p-q| */
    'parabola-distance': function (rng, difficulty, meta) {
      var Rg = RANGE[difficulty];
      var p = rint(rng, -Rg.root, Rg.root), q = rint(rng, -Rg.root, Rg.root);
      if (p === q || p === 0 || q === 0) return null;
      var B = -(p + q), C = p * q;
      if (Math.abs(B) > maxNum(difficulty) || Math.abs(C) > maxNum(difficulty)) return null;
      var body = quad(1, B, C);
      var dist = Math.abs(p - q);
      return finish(meta, difficulty, {
        prompt: '抛物线 y=' + body + ' 与 x 轴交于 A、B 两点，求 A、B 两点间的距离（单位长度）。',
        parts: [R(dist, 1)],
        spec: { kind: 'derived', degree: 2, derived: 'distance', display: { lhs: body, rhs: '0' } },
        verify: function () { return p * p + B * p + C === 0 && q * q + B * q + C === 0 && p !== q; }
      });
    },

    /* cnm_h023 二次函数与一元二次方程（高中）：取较大/较小实根 */
    'quad-select-root': function (rng, difficulty, meta) {
      var Rg = RANGE[difficulty];
      var p = rint(rng, -Rg.root, Rg.root), q = rint(rng, -Rg.root, Rg.root);
      if (p === q || p === 0 || q === 0) return null;
      var A = rint(rng, 1, 2);
      var B = -A * (p + q), C = A * p * q;
      if (Math.abs(B) > maxNum(difficulty) || Math.abs(C) > maxNum(difficulty)) return null;
      var body = quad(A, B, C);
      var wantMax = difficulty !== 'advanced';
      var answerRoot = wantMax ? Math.max(p, q) : Math.min(p, q);
      return finish(meta, difficulty, {
        prompt: '已知方程 ' + body + '=0 有两个不相等的实根，其中较' + (wantMax ? '大' : '小') +
          '的那个根是多少？',
        parts: [R(answerRoot, 1)],
        spec: { kind: 'derived', degree: 2, derived: wantMax ? 'max-root' : 'min-root', display: { lhs: body, rhs: '0' } },
        verify: function () { return A * p * p + B * p + C === 0 && A * q * q + B * q + C === 0 && p !== q; }
      });
    }
  };

  function det3(m) {
    return m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
      - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
      + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  }

  /* ================================================================
   * recipe 表：19 个知识点 → 23 个模板
   * ================================================================ */

  var RECIPES = [
    { id: 'param-linear-solution', topic: 'cnm_039', family: 'equation', difficulties: ['basic', 'standard'] },
    { id: 'linear-two-sides', topic: 'cnm_042', family: 'equation', difficulties: ['basic', 'standard', 'advanced'] },
    { id: 'linear-bracket', topic: 'cnm_043', family: 'equation', difficulties: ['basic', 'standard', 'advanced'] },
    { id: 'linear-fraction', topic: 'cnm_044', family: 'equation', difficulties: ['standard', 'advanced'] },
    { id: 'bivar-value', topic: 'cnm_087', family: 'equation', difficulties: ['basic', 'standard'] },
    { id: 'system2-solve', topic: 'cnm_088', family: 'equation', difficulties: ['basic', 'standard', 'advanced'] },
    { id: 'system3-solve', topic: 'cnm_093', family: 'equation', difficulties: ['standard', 'advanced'] },
    { id: 'frac-linear', topic: 'cnm_165', family: 'equation', difficulties: ['standard', 'advanced'] },
    { id: 'linear-fn-param-k', topic: 'cnm_206', family: 'equation', difficulties: ['basic', 'standard'] },
    { id: 'linear-fn-param-k-points', topic: 'cnm_206', family: 'equation', difficulties: ['basic', 'standard'] },
    { id: 'linear-fn-system-param', topic: 'cnm_208', family: 'equation', difficulties: ['standard', 'advanced'] },
    { id: 'quad-general-form', topic: 'cnm_219', family: 'equation', difficulties: ['basic', 'standard'] },
    { id: 'quad-direct-square', topic: 'cnm_220', family: 'equation', difficulties: ['basic', 'standard'] },
    { id: 'complete-square-const', topic: 'cnm_221', family: 'completeSquare', difficulties: ['basic', 'standard'] },
    { id: 'complete-square-solve', topic: 'cnm_221', family: 'completeSquare', difficulties: ['standard', 'advanced'] },
    { id: 'quad-formula', topic: 'cnm_222', family: 'equation', difficulties: ['basic', 'standard', 'advanced'] },
    { id: 'quad-factor', topic: 'cnm_224', family: 'equation', difficulties: ['basic', 'standard'] },
    { id: 'quad-common-factor', topic: 'cnm_225', family: 'equation', difficulties: ['basic', 'standard'] },
    { id: 'vieta-sum-product', topic: 'cnm_226', family: 'equation', difficulties: ['basic', 'standard'] },
    { id: 'vieta-square-sum', topic: 'cnm_226', family: 'equation', difficulties: ['advanced'] },
    { id: 'parabola-intercepts', topic: 'cnm_234', family: 'equation', difficulties: ['basic', 'standard'] },
    { id: 'parabola-distance', topic: 'cnm_234', family: 'equation', difficulties: ['standard', 'advanced'] },
    { id: 'quad-select-root', topic: 'cnm_h023', family: 'equation', difficulties: ['basic', 'standard', 'advanced'] }
  ];

  var TOPICS = [];
  var BY_TOPIC = {};
  RECIPES.forEach(function (r) {
    if (!BY_TOPIC[r.topic]) { BY_TOPIC[r.topic] = []; TOPICS.push(r.topic); }
    BY_TOPIC[r.topic].push(r);
  });

  function supports(topicId) { return !!BY_TOPIC[topicId]; }
  function recipesFor(topicId) { return (BY_TOPIC[topicId] || []).slice(); }

  /* ================================================================
   * 门禁
   * ================================================================ */

  function canon(s) { return String(s || '').replace(/\s+/g, ''); }

  /** 题干骨架：抽掉所有数字（保留标点与文字），用于「同题换数」比对 */
  function skeleton(prompt) {
    return String(prompt || '').replace(/\s+/g, '').replace(/\d+(?:\.\d+)?/g, '#');
  }

  /** 泄露检查：与 variants.js 的 checkLeak 同口径（首句不得出现 x=答案 / 系数化为） */
  function checkLeak(explanation, answer) {
    var i = explanation.search(/[，。；;,]/);
    var firstClause = i < 0 ? explanation : explanation.slice(0, i + 1);
    var ansRe = new RegExp('x\\s*=\\s*' + String(answer).replace('/', '\\/'));
    if (ansRe.test(firstClause)) return false;
    if (firstClause.indexOf('系数化为') >= 0) return false;
    return true;
  }

  function has(list, key) {
    if (!list) return false;
    if (typeof list.has === 'function' && !Array.isArray(list)) return list.has(key);
    return list.indexOf(key) >= 0;
  }

  function numbersIn(text) {
    var out = [];
    var re = /\d+(?:\.\d+)?/g, m;
    while ((m = re.exec(String(text))) !== null) out.push(Number(m[0]));
    return out;
  }

  /**
   * 不变量：数字规模、根的绝对值/分母随难度档收紧；basic 必须是整数根且无分数线。
   * @returns {string|null} 违例原因
   */
  function invReason(q) {
    var inv = INVARIANT[q.difficulty];
    if (!inv) return 'inv-difficulty';
    var nums = numbersIn(q.prompt);
    for (var i = 0; i < nums.length; i++) {
      if (nums[i] > inv.maxNumber) return 'inv-number-range';
    }
    var parts = q.numberParts || [];
    var kind = (q.constructSpec && q.constructSpec.kind) || 'roots';
    var isRootKind = (kind === 'roots' || kind === 'frac-roots' || kind === 'system');
    for (var j = 0; j < parts.length; j++) {
      var p = parts[j];
      if (p.q > inv.maxDen) return 'inv-den';
      if (isRootKind) {
        if (p.q === 1 && Math.abs(p.p) > inv.maxRootAbs * 2) return 'inv-root-range';
        if (p.q !== 1 && Math.abs(p.p / p.q) > inv.maxRootAbs) return 'inv-root-range';
      } else {
        // 派生量（完全平方式的常数、和积、平方和、距离）不是根：perfect-square / derived
        // 按 maxAnswer 卡（平方量级），param（方程里解出的字母值）仍按系数规模卡。
        var cap = (kind === 'derived' || kind === 'perfect-square') ? inv.maxAnswer : inv.maxNumber;
        if (Math.abs(p.p) > cap) return 'inv-answer-range';
      }
    }
    if (!inv.allowFraction) {
      if (q.prompt.indexOf('/') >= 0) return 'inv-basic-fraction';
      for (var k = 0; k < parts.length; k++) if (parts[k].q !== 1) return 'inv-basic-not-int';
    }
    return null;
  }

  /** 题干不得以断言形式给出答案：只看「已知/当/若/解为/根为」之后紧跟的 v=值 */
  function answerInPrompt(prompt, parts, unknowns) {
    var text = canon(prompt);
    var wanted = (parts || []).map(function (p) { return p.q === 1 ? String(p.p) : p.p + '/' + p.q; });
    if (!wanted.length) return false;
    var vars = unknowns && unknowns.length ? unknowns : ['x', 'y', 'z'];
    for (var i = 0; i < vars.length; i++) {
      // 断言型上下文：已知 x=3 / 当 x=3 / 若 y=-2 / 解为 x=1（不匹配「4x=0」这类系数紧邻的写法）
      var re = new RegExp('(?:已知|当|若|解为|根为|的解是|根是)[^0-9。，]{0,8}' + vars[i] + '=(-?\\d+(?:\\/\\d+)?)', 'g');
      var m;
      while ((m = re.exec(text)) !== null) {
        if (wanted.indexOf(m[1]) >= 0) return true;
      }
    }
    if (/答案/.test(text)) {
      for (var j = 0; j < wanted.length; j++) if (text.indexOf(wanted[j]) >= 0) return true;
    }
    return false;
  }

  /**
   * 单题门禁（模块内自检；测试侧另有一套从题面独立复算的实现）
   * @returns {string|null} 违例原因（通过为 null）
   */
  function gate(q, opts) {
    if (!q.prompt || !q.answer || !q.numberParts || !q.numberParts.length) return 'empty';
    if (typeof q.verify !== 'function' || q.verify() !== true) return 'selfcheck';
    var inv = invReason(q);
    if (inv) return inv;
    if (/\d/.test(q.explanation)) return 'explanation-digits';
    if (!checkLeak(q.explanation, q.answer)) return 'leak-clause';
    if (q.explanation.indexOf(q.answer) >= 0) return 'leak-answer';
    var unknowns = q.constructSpec && q.constructSpec.unknowns;
    if (answerInPrompt(q.prompt, q.numberParts, unknowns)) return 'answer-in-prompt';
    opts = opts || {};
    if (has(opts.avoidPrompts, canon(q.prompt))) return 'collision';
    if (has(opts.avoidSkeletons, skeleton(q.prompt))) return 'skeleton';
    return null;
  }

  /* ================================================================
   * 核心：genConstruct（确定性，同 seed+index 必然同题）
   * ================================================================ */

  function genConstruct(topicId, index, opts) {
    if (!supports(topicId)) return null;
    opts = opts || {};
    index = index || 0;
    var stats = opts.stats;
    var recipes = BY_TOPIC[topicId];
    var base = (opts.seed || 'construct') + '|' + topicId + '|c' + index;
    var recipe = null;
    if (opts.recipe) {
      for (var ri = 0; ri < recipes.length; ri++) if (recipes[ri].id === opts.recipe) recipe = recipes[ri];
      if (!recipe) return null;
    } else {
      recipe = recipes[hashStr(base + '|r') % recipes.length];
    }
    var builder = BUILDERS[recipe.id];
    var attempts = opts.attempts || 60;

    for (var attempt = 0; attempt < attempts; attempt++) {
      if (stats) stats.attempts = (stats.attempts || 0) + 1;
      var rng = mulberry32(hashStr(base + '#' + attempt));
      rng();
      // 难度档从同一条 RNG 流里取，并按 attempt 轮转：重抽时逐档上升而不是一律退回最简档。
      // （旧写法用 hashStr(base+'|d') 单独取模，实测该串末尾只差一个字符，取模结果恒为 0，
      //   600 次抽样全部落在 basic 档，standard/advanced 事实上从未被抽到。）
      var diffIdx = (Math.floor(rng() * recipe.difficulties.length) + attempt) % recipe.difficulties.length;
      var difficulty = recipe.difficulties[diffIdx];
      var q = builder(rng, difficulty, recipe);
      if (!q) { bump(stats, 'build-null'); continue; }
      var bad = gate(q, opts);
      if (bad) { bump(stats, bad); continue; }
      q.id = topicId + '_c' + (index + 1);
      q.variantIndex = index;
      if (stats) stats.produced = (stats.produced || 0) + 1;
      return q;
    }
    bump(stats, 'exhausted');
    return null;
  }

  function bump(stats, reason) {
    if (!stats) return;
    stats.rejected = stats.rejected || {};
    stats.rejected[reason] = (stats.rejected[reason] || 0) + 1;
  }

  function constructSet(topicId, startIndex, count, opts) {
    if (!supports(topicId)) return [];
    var out = [];
    var idx = startIndex || 0;
    for (var i = 0; i < count; i++) {
      var q = genConstruct(topicId, idx, opts);
      if (!q) break;
      out.push(q);
      idx++;
    }
    return out;
  }

  return {
    VERSION: 1,
    TOPICS: TOPICS.slice(),
    RECIPES: RECIPES.map(function (r) {
      return { id: r.id, topic: r.topic, family: r.family, difficulties: r.difficulties.slice() };
    }),
    RULES: RULES,
    INVARIANT: INVARIANT,
    supports: supports,
    recipesFor: recipesFor,
    genConstruct: genConstruct,
    constructSet: constructSet,
    skeleton: skeleton,
    canon: canon,
    checkLeak: checkLeak,
    gate: gate,
    numbersIn: numbersIn,
    isSupportedTopic: supports
  };
});
