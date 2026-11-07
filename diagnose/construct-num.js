/* 卡1 数值基础层：整数 / 分数 / 定点小数 / 根式 / 幂 的**精确**运算（零依赖、无 DOM、无网络）。
 *
 * 为什么单独一层：算术题的答案必须「本地算出来、不可能错」，任何一处走浮点都会破这个前提。
 *   · 整数：BigInt（不用 Number，不用 Math.pow / Math.sqrt）
 *   · 分数：{n: BigInt, d: BigInt>0}，构造即约分、分母恒正、符号只挂在分子上
 *   · 定点小数：{v: BigInt, s: Number} 表示 v / 10^s；四舍五入用「整数除 + 余数比较」，不用 toFixed
 *   · 根式：{k: BigInt, m: BigInt} 表示 k·√m（m 平方自由），开方靠整数试除，不用 Math.sqrt 反推
 *   · 幂：powInt(base, exp)，exp 可为负整数 → 返回分数
 *
 * 两条求值路径（混合运算的「双路一致」校验就靠它们）：
 *   evalAst(node)   递归求值（AST 直算）
 *   evalInfix(text) 中缀文本 → 调度场算法转逆波兰 → 栈求值（题面显示的那串式子直算）
 * 两条路径独立实现，结果必须逐位相等；不等就是题面括号/优先级写错了。
 *
 * 浏览器：window.DiagConstructNum（构造器脚本要排在 construct.js 前面）
 * Node：require('./construct-num.js') 直接用，同进程重复 require 拿到同一实例。
 *
 * 老引擎没有 BigInt 时本模块整体降级为 {available:false}：调用方据此放弃算术族，
 * 不抛错、不影响其它族（见 diagnose/construct.js 的 NumUsable）。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.DiagConstructNum = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  if (typeof BigInt !== 'function') return { available: false, reason: 'no-bigint' };

  var ZERO = BigInt(0), ONE = BigInt(1), TWO = BigInt(2), TEN = BigInt(10);

  /* ---------------------------------------------------------------- 小工具 */

  /** 只接受「小整数」的场合（位数、指数、下标），先卡住再转 BigInt */
  function bigFromSmall(x, what) {
    if (typeof x !== 'number' || !isFinite(x) || x !== Math.round(x) || Math.abs(x) > 1e6) {
      throw new Error('construct-num: ' + (what || 'small-int') + ' 必须是 1e6 内的小整数，实际 ' + String(x));
    }
    return BigInt(x);
  }

  /** 任意整数输入 → BigInt（bigint / 安全整数字符串 / 安全整数 number） */
  function int(x) {
    if (typeof x === 'bigint') return x;
    if (typeof x === 'number') {
      if (!isFinite(x) || x !== Math.round(x) || !isFinite(x)) throw new Error('construct-num: 非整数 ' + String(x));
      return BigInt(x);
    }
    if (typeof x === 'string' && /^-?\d+$/.test(x)) return BigInt(x);
    throw new Error('construct-num: 无法转成整数 ' + String(x));
  }

  function abs(a) { a = int(a); return a < ZERO ? -a : a; }
  function sign(a) { a = int(a); return a < ZERO ? -1 : (a > ZERO ? 1 : 0); }
  function cmp(a, b) { a = int(a); b = int(b); return a < b ? -1 : (a > b ? 1 : 0); }
  function add(a, b) { return int(a) + int(b); }
  function sub(a, b) { return int(a) - int(b); }
  function mul(a, b) { return int(a) * int(b); }

  /** 带余除法（商向零截断，余数与被除数同号；除数为零直接抛） */
  function divmod(a, b) {
    a = int(a); b = int(b);
    if (b === ZERO) throw new Error('construct-num: 除数为零');
    return { q: a / b, r: a % b };
  }
  function quot(a, b) { return divmod(a, b).q; }
  function rem(a, b) { return divmod(a, b).r; }

  function gcd(a, b) {
    a = abs(a); b = abs(b);
    while (b !== ZERO) { var t = a % b; a = b; b = t; }
    return a === ZERO ? ONE : a;
  }

  function ipow(base, exp) {
    base = int(base);
    exp = int(exp);
    if (exp < ZERO) throw new Error('construct-num: ipow 指数必须非负');
    var r = ONE, b = base, e = exp;
    while (e > ZERO) {
      if (e % TWO === ONE) r *= b;
      b *= b;
      e /= TWO;
    }
    return r;
  }

  function pow10(k) {
    if (typeof k !== 'number' || k < 0 || k !== Math.round(k) || k > 60) throw new Error('construct-num: pow10 参数非法 ' + String(k));
    var r = ONE;
    for (var i = 0; i < k; i++) r *= TEN;
    return r;
  }

  function digitsOf(a) {
    a = abs(a);
    return a === ZERO ? 1 : a.toString().length;
  }

  /* ---------------------------------------------------------------- 分数 */

  /** 规范化分数：分母恒正、gcd 约分、符号只留在分子 */
  function frac(n, d) {
    n = int(n);
    d = (d === undefined || d === null) ? ONE : int(d);
    if (d === ZERO) throw new Error('construct-num: 分数分母为零');
    if (d < ZERO) { n = -n; d = -d; }
    var g = gcd(n, d);
    if (g > ONE) { n /= g; d /= g; }
    return { n: n, d: d };
  }

  function fInt(a) { return frac(a, ONE); }
  function fIsInt(f) { return f.d === ONE; }
  function fNeg(f) { return frac(-f.n, f.d); }
  function fAbs(f) { return frac(abs(f.n), f.d); }
  function fAdd(a, b) { return frac(a.n * b.d + b.n * a.d, a.d * b.d); }
  function fSub(a, b) { return frac(a.n * b.d - b.n * a.d, a.d * b.d); }
  function fMul(a, b) { return frac(a.n * b.n, a.d * b.d); }
  function fDiv(a, b) {
    if (b.n === ZERO) throw new Error('construct-num: 分数除零');
    return frac(a.n * b.d, a.d * b.n);
  }
  function fCmp(a, b) { return cmp(a.n * b.d, b.n * a.d); }
  function fEq(a, b) { return fCmp(a, b) === 0; }

  /** 分数 → 文本：整数写整数，其余写最简 a/b */
  function fText(f) {
    f = frac(f.n, f.d);
    return f.d === ONE ? f.n.toString() : f.n.toString() + '/' + f.d.toString();
  }

  /** 文本 → 分数（'3' / '-7/4'）；解析失败返回 null */
  function fFromText(text) {
    var s = String(text == null ? '' : text).replace(/\s+/g, '');
    var m = /^(-?\d+)(?:\/(\d+))?$/.exec(s);
    if (!m) return null;
    try { return frac(BigInt(m[1]), m[2] ? BigInt(m[2]) : ONE); } catch (e) { return null; }
  }

  /** 幂：base 可为整数/分数，exp 为（可负的）小整数；负指数返回分数 */
  function powInt(base, exp) {
    var e = exp;
    if (typeof e !== 'number' || e !== Math.round(e) || Math.abs(e) > 64) throw new Error('construct-num: powInt 指数非法 ' + String(exp));
    var f = (base && typeof base === 'object' && base.d !== undefined) ? frac(base.n, base.d) : fInt(base);
    var n = Math.abs(e);
    var acc = fInt(ONE), i;
    for (i = 0; i < n; i++) acc = fMul(acc, f);
    return e < 0 ? fDiv(fInt(ONE), acc) : acc;
  }

  /* ---------------------------------------------------------------- 定点小数
   * {v: BigInt, s: Number} 表示 v / 10^s（s ≥ 0）。构造即去掉尾随零（保证同一数值只有一种表示），
   * 显示时再按调用方要求的位数补零（toText 定长）。 */

  function fx(v, s) {
    v = int(v);
    s = (s === undefined || s === null) ? 0 : s;
    if (typeof s !== 'number' || s < 0 || s !== Math.round(s) || s > 30) throw new Error('construct-num: 小数位数非法 ' + String(s));
    while (s > 0 && v % TEN === ZERO) { v /= TEN; s--; }
    return { v: v, s: s };
  }

  /** 只补位、不约：对齐两条定点数的小数位（内部用，避免把 1.0 约成 1 后丢失位数） */
  function fxScaled(v, s) { return { v: int(v), s: s }; }

  function fxAlign(a, b) {
    var s = Math.max(a.s, b.s);
    return { a: fxScaled(a.v * pow10(s - a.s), s), b: fxScaled(b.v * pow10(s - b.s), s), s: s };
  }
  function fxAdd(a, b) { var p = fxAlign(a, b); return fx(p.a.v + p.b.v, p.s); }
  function fxSub(a, b) { var p = fxAlign(a, b); return fx(p.a.v - p.b.v, p.s); }
  function fxMul(a, b) { return fx(a.v * b.v, a.s + b.s); }
  function fxToFrac(a) { return frac(a.v, pow10(a.s)); }

  /** 四舍五入（远离零方向的 .5 进位），返回保留 digits 位小数的定点数 */
  function fxRound(a, digits) {
    if (typeof digits !== 'number' || digits < 0 || digits !== Math.round(digits) || digits > 30) throw new Error('construct-num: fxRound 位数非法 ' + String(digits));
    if (digits >= a.s) return fx(a.v * pow10(digits - a.s), digits);
    var drop = pow10(a.s - digits);
    var neg = a.v < ZERO;
    var av = neg ? -a.v : a.v;
    var q = av / drop, r = av % drop;
    if (r * TWO >= drop) q += ONE;
    return fx(neg ? -q : q, digits);
  }

  /** 分数 → 定点小数（按 digits 位四舍五入） */
  function fracToFx(f, digits) {
    digits = (digits === undefined || digits === null) ? 0 : digits;
    if (typeof digits !== 'number' || digits < 0 || digits !== Math.round(digits) || digits > 30) throw new Error('construct-num: fracToFx 位数非法 ' + String(digits));
    var scale = pow10(digits);
    var num = f.n * scale;
    var neg = num < ZERO;
    var an = neg ? -num : num;
    var q = an / f.d, r = an % f.d;
    if (r * TWO >= f.d) q += ONE;
    return fx(neg ? -q : q, digits);
  }

  /** 定长小数串（默认按定点数自身位数；给 digits 则先四舍五入再补零到 digits 位） */
  function fxText(a, digits) {
    var s = (digits === undefined || digits === null) ? a.s : digits;
    var g = fxRound(a, s);
    var v = g.v * pow10(s - g.s);          // 显示用：补回被约掉的尾零
    var neg = v < ZERO;
    var str = (neg ? -v : v).toString();
    while (str.length <= s) str = '0' + str;
    var out = s > 0 ? str.slice(0, str.length - s) + '.' + str.slice(str.length - s) : str;
    return (neg ? '-' : '') + out;
  }

  /* ---------------------------------------------------------------- 根式
   * {k: BigInt, m: BigInt} 表示 k·√m，m 平方自由且 ≥ 1，k ≠ 0（k=0 时 m 归一为 1）。
   * 开方**不用** Math.sqrt：逐个质因数试除，偶次幂搬出根号。 */

  function sqrtSimplify(n) {
    n = int(n);
    if (n < ZERO) throw new Error('construct-num: 负数的算术平方根无定义');
    if (n === ZERO) return { k: ZERO, m: ONE };
    var k = ONE, m = ONE, rest = n, i = TWO;
    while (i * i <= rest) {
      var e = 0;
      while (rest % i === ZERO) { rest /= i; e++; }
      if (e > 0) {
        k *= ipow(i, BigInt(Math.floor(e / 2)));
        if (e % 2 === 1) m *= i;
      }
      i += ONE;
    }
    if (rest > ONE) m *= rest;              // 剩下的大于 1 的因子必然是一次（平方自由）
    return { k: k, m: m };
  }

  /** 规整根式：把 m 里能开出来的平方因子搬进 k */
  function radical(k, m) {
    k = int(k);
    m = (m === undefined || m === null) ? ONE : int(m);
    if (m <= ZERO) throw new Error('construct-num: 根号内必须为正整数');
    if (k === ZERO) return { k: ZERO, m: ONE };
    var s = sqrtSimplify(m);
    return { k: k * s.k, m: s.m };
  }

  /** 'k√m' / 'k' / '√m' / '-k√m' */
  function radText(r) {
    r = radical(r.k, r.m);
    if (r.m === ONE) return r.k.toString();
    var head = r.k === ONE ? '' : (r.k === -ONE ? '-' : r.k.toString());
    return head + '√' + r.m.toString();
  }

  function radMul(a, b) { return radical(a.k * b.k, a.m * b.m); }
  function radEq(a, b) {
    var x = radical(a.k, a.m), y = radical(b.k, b.m);
    return x.k === y.k && x.m === y.m;
  }
  /** k²·m：还原成被开方数（测试用它核对「根式还原」） */
  function radSquare(r) { return r.k * r.k * r.m; }

  /* ---------------------------------------------------------------- 表达式 AST
   * 叶子：{n: 整数}（整数）或 {frac: {n, d}}；运算：{op:'+'|'-'|'×'|'÷', l, r}
   * 全部用 BigInt/分数精确求值，除法不整除就得到分数（不丢精度、不四舍五入）。 */

  var PREC = { '+': 1, '-': 1, '×': 2, '÷': 2 };

  function isLeaf(a) { return a && (typeof a.n !== 'undefined' || typeof a.frac !== 'undefined'); }
  function precOf(a) { return isLeaf(a) ? 9 : (PREC[a.op] || 0); }

  function evalAst(a) {
    if (!a) throw new Error('construct-num: 空 AST');
    if (typeof a.n !== 'undefined') return fInt(a.n);
    if (a.frac) return frac(a.frac.n, a.frac.d);
    if (!a.op || !PREC[a.op]) throw new Error('construct-num: 非法运算 ' + String(a.op));
    var l = evalAst(a.l), r = evalAst(a.r);
    if (a.op === '+') return fAdd(l, r);
    if (a.op === '-') return fSub(l, r);
    if (a.op === '×') return fMul(l, r);
    return fDiv(l, r);
  }

  /** AST → 中缀文本（按优先级补最少括号；减/除的右子树同级也要括号） */
  function render(a) {
    if (isLeaf(a)) {
      if (typeof a.n !== 'undefined') { var iv = int(a.n); return iv < ZERO ? '(' + iv.toString() + ')' : iv.toString(); }
      return '(' + fText(frac(a.frac.n, a.frac.d)) + ')';
    }
    var p = PREC[a.op];
    var ls = render(a.l), rs = render(a.r);
    if (precOf(a.l) < p) ls = '(' + ls + ')';
    if (precOf(a.r) < p || (precOf(a.r) === p && (a.op === '-' || a.op === '÷'))) rs = '(' + rs + ')';
    return ls + a.op + rs;
  }

  /** AST 里所有整数叶子（按出现顺序） */
  function leaves(a) {
    var out = [];
    (function walk(x) {
      if (!x) return;
      if (typeof x.n !== 'undefined') { out.push(int(x.n)); return; }
      if (x.frac) return;
      walk(x.l); walk(x.r);
    })(a);
    return out;
  }

  function statTree(a) {
    if (isLeaf(a)) return { steps: 0, depth: 0, heads: [] };
    var l = statTree(a.l), r = statTree(a.r);
    return { steps: l.steps + r.steps + 1, depth: Math.max(l.depth, r.depth) + 1, heads: [{ op: a.op, node: a }].concat(l.heads, r.heads) };
  }

  /* ---------------------------------------------------------------- 中缀文本求值（独立第二条路径） */

  var OP_ALIAS = {
    '＋': '+', '﹢': '+', 'ᐩ': '+',
    '－': '-', '−': '-', '–': '-', '—': '-', '﹣': '-',
    '×': '×', '✕': '×', '✖': '×', '·': '×', '⋅': '×', '*': '×', '＊': '×',
    '÷': '÷', '／': '÷', '/': '÷',
    '（': '(', '）': ')'
  };

  function tokenize(text) {
    var s = String(text == null ? '' : text);
    /* 全角数字（２７）→ 半角：题面偶尔用全角排印，求值口径不能因此变化 */
    s = s.replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); });
    var out = [], i = 0;
    while (i < s.length) {
      var ch = s.charAt(i);
      if (/\s/.test(ch)) { i++; continue; }
      if (/[0-9]/.test(ch)) {
        var j = i;
        while (j < s.length && /[0-9]/.test(s.charAt(j))) j++;
        out.push({ t: 'num', v: BigInt(s.slice(i, j)) });
        i = j;
        continue;
      }
      if (ch === '.') throw new Error('construct-num: 本层不解析小数文本（用分数/定点数表达）');
      var m = OP_ALIAS[ch] || ch;
      if (m === '+' || m === '-' || m === '×' || m === '÷' || m === '(' || m === ')') { out.push({ t: m }); i++; continue; }
      throw new Error('construct-num: 无效字符 ' + ch);
    }
    return out;
  }

  /** 调度场算法：中缀 token → 逆波兰 token */
  function toRpn(tokens) {
    var out = [], ops = [], i, t;
    for (i = 0; i < tokens.length; i++) {
      t = tokens[i].t;
      if (t === 'num') { out.push(tokens[i]); continue; }
      if (t === '(') { ops.push(t); continue; }
      if (t === ')') {
        while (ops.length && ops[ops.length - 1] !== '(') out.push({ t: ops.pop() });
        if (!ops.length) throw new Error('construct-num: 括号不匹配');
        ops.pop();
        continue;
      }
      while (ops.length && ops[ops.length - 1] !== '(' && PREC[ops[ops.length - 1]] >= PREC[t]) out.push({ t: ops.pop() });
      ops.push(t);
    }
    while (ops.length) {
      var o = ops.pop();
      if (o === '(') throw new Error('construct-num: 括号不匹配');
      out.push({ t: o });
    }
    return out;
  }

  function evalRpn(list) {
    var st = [], i, k;
    for (i = 0; i < list.length; i++) {
      k = list[i];
      if (k.t === 'num') { st.push(fInt(k.v)); continue; }
      if (st.length < 2) throw new Error('construct-num: 表达式不完整');
      var r = st.pop(), l = st.pop();
      if (k.t === '+') st.push(fAdd(l, r));
      else if (k.t === '-') st.push(fSub(l, r));
      else if (k.t === '×') st.push(fMul(l, r));
      else if (k.t === '÷') st.push(fDiv(l, r));
      else throw new Error('construct-num: 非法逆波兰算子 ' + k.t);
    }
    if (st.length !== 1) throw new Error('construct-num: 表达式多余操作数');
    return st[0];
  }

  function evalInfix(text) { return evalRpn(toRpn(tokenize(text))); }

  /** 双路求值：AST 直算 vs 中缀文本（调度场 + 栈）→ 两条路径必须逐位相等，否则返回 null */
  function evalBoth(node, text) {
    var a, b;
    try { a = evalAst(node); } catch (e) { return null; }
    try { b = evalInfix(text); } catch (e2) { return null; }
    return fEq(a, b) ? a : null;
  }

  /* ---------------------------------------------------------------- 出口 */

  return {
    available: true,
    // 整数
    int: int, abs: abs, sign: sign, cmp: cmp, add: add, sub: sub, mul: mul,
    divmod: divmod, quot: quot, rem: rem, gcd: gcd, ipow: ipow, pow10: pow10, digitsOf: digitsOf,
    // 分数
    frac: frac, fInt: fInt, fIsInt: fIsInt, fNeg: fNeg, fAbs: fAbs,
    fAdd: fAdd, fSub: fSub, fMul: fMul, fDiv: fDiv, fCmp: fCmp, fEq: fEq,
    fText: fText, fFromText: fFromText, powInt: powInt,
    // 定点小数
    fx: fx, fxAdd: fxAdd, fxSub: fxSub, fxMul: fxMul, fxRound: fxRound,
    fxText: fxText, fxToFrac: fxToFrac, fracToFx: fracToFx,
    // 根式
    sqrtSimplify: sqrtSimplify, radical: radical, radText: radText,
    radMul: radMul, radEq: radEq, radSquare: radSquare,
    // 表达式
    evalAst: evalAst, render: render, leaves: leaves, statTree: statTree,
    tokenize: tokenize, toRpn: toRpn, evalRpn: evalRpn, evalInfix: evalInfix, evalBoth: evalBoth,
    PREC: PREC
  };
});
