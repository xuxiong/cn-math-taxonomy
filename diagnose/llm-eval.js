/* O3 表达式安全求值 + 验证门（纯函数层）：零依赖、无网络、无 DOM、无 localStorage。
 *
 * 从 llm-variants.js 拆出（O3-8 重构，零行为变更）。职责单一：
 *   - 表达式安全求值：evaluateExpression / solveCheck / normalizeSet（白名单 + new Function）
 *   - 内部解析：expandPlusMinus / splitTop / parseRootValue / parseEquation / parseQuadraticCoeffs
 *   - 验证门：verifyEquationRoots / verifyCompletingSquare / verifyFormParam / validateLLMQuestion
 *
 * UMD 包装沿用 variants.js / llm-variants.js 风格：
 *   浏览器 → window.DiagLLMEval；Node → require() 直接拿到对象。
 * llm-variants.js 在 Node 下自行 require 本模块，浏览器下按 index.html 顺序先加载。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.DiagLLMEval = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* 零网络/零 DOM 的硬保证：本文件不允许出现 fetch / localStorage / Date.now */
  var EPS = 1e-9;

  /* ================================================================
   * 表达式安全求值（§3.3 定稿：白名单 + new Function）
   * 威胁模型：自用工具，输入源仅自身 LLM 网关输出。
   * 硬门槛：过滤后无任何字母才执行；先白名单后转换；抛错即校验失败。
   * ================================================================ */

  var WHITELIST = /^[0-9x+\-*/().^ ]+$/;

  /**
   * 安全求值表达式：在给定 x 值处计算 expr 的数值。
   * 白名单过滤 → ²→**2 / √→Math.sqrt 转换 → 检查无字母 → new Function 执行。
   * 任何不安全或抛错的情况返回 null（不中断页面）。
   * @param {string} expr - 数学表达式，如 "x^2+6x-7" 或 "x²-4"
   * @param {number[]} xValues - 要代入的 x 值数组
   * @returns {number[]|null} - 各 x 处的求值结果，或 null（不安全/抛错）
   */
  function evaluateExpression(expr, xValues) {
    if (expr == null || typeof expr !== 'string') return null;
    var s = String(expr).trim();
    if (!s) return null;

    /* NFKC 归一化 + 统一符号 */
    /* 注意：NFKC 会把 ²(U+00B2) 变成普通数字 2，丢失幂次含义。
     * 所以先转换 ²→**2, ³→**3，再 NFKC。 */
    s = s.replace(/²/g, '**2').replace(/³/g, '**3');
    s = s.normalize('NFKC');
    s = s.replace(/[−‐-―﹣]/g, '-').replace(/[×·⋅∙]/g, '*').replace(/÷/g, '/');
    s = s.replace(/\s+/g, '');

    /* 幂运算符 ^ → **（JS 不支持 ^ 作幂） */
    s = s.replace(/\^/g, '**');

    /* 省略乘号：2x → 2*x, x2 → x*2, x( → x*(, )x → )*x, )( → )*(, 2( → 2*(, )2 → )*2 */
    /* 需要多轮替换（前一轮的结果可能产生新的邻接） */
    for (var guard = 0; guard < 4; guard++) {
      var prev = s;
      s = s.replace(/(\d)x/g, '$1*x')
         .replace(/x(\d)/g, 'x*$1')
         .replace(/x\(/g, 'x*(')
         .replace(/\)x/g, ')*x')
         .replace(/\)\(/g, ')*(')
         .replace(/(\d)\(/g, '$1*(')
         .replace(/\)(\d)/g, ')*$1');
      if (s === prev) break;
    }

    /* 硬门槛：转换后只允许数字、x、加减乘除、括号、点、空格 */
    if (!/^[0-9x+\-*/(). ]+$/.test(s)) return null;
    /* 不含其他字母（x 是唯一允许的变量）—— 检查 a-w, y, z */
    if (/[a-wyz]/i.test(s)) return null;
    /* 不含分号、引号（额外保险） */
    if (/["';]/.test(s)) return null;

    var results = [];
    try {
      var fn = new Function('x', 'return (' + s + ')');
      for (var i = 0; i < xValues.length; i++) {
        results.push(fn(xValues[i]));
      }
      return results;
    } catch (e) {
      return null;
    }
  }

  /**
   * 代入验根：把 candidate 代入 equation，验证等式成立。
   * @param {string} equation - 如 "x²+6x-7=0" 或 "x^2+6x-7=0"
   * @param {string|number} candidate - 如 "1" 或 1
   * @returns {boolean} - 代入后等式成立为 true
   */
  function solveCheck(equation, candidate) {
    if (!equation || candidate == null) return false;
    var eq = String(equation).trim();
    var eqIdx = eq.indexOf('=');
    if (eqIdx < 0) return false;
    var lhs = eq.substring(0, eqIdx);
    var rhs = eq.substring(eqIdx + 1);

    var cand = typeof candidate === 'number' ? candidate : parseRootValue(String(candidate));
    if (cand === null || isNaN(cand)) return false;

    var lhsVals = evaluateExpression(lhs, [cand]);
    var rhsVals = evaluateExpression(rhs, [cand]);
    if (!lhsVals || !rhsVals) return false;

    return Math.abs(lhsVals[0] - rhsVals[0]) < EPS;
  }

  /**
   * 集合归一：把多值答案（含 ± 展开）归一为数值集合。
   * @param {string} answers - 如 "1，-7" 或 "2±√5"
   * @returns {Set} - 数值集合
   */
  function normalizeSet(answers) {
    var s = new Set();
    if (!answers) return s;
    var expanded = expandPlusMinus(String(answers));
    var parts = splitTop(expanded, ',;，；、');
    for (var i = 0; i < parts.length; i++) {
      var subparts = String(parts[i]).split(/或者|或|和|与|及/);
      for (var j = 0; j < subparts.length; j++) {
        var v = parseRootValue(String(subparts[j]).trim());
        if (v !== null && !isNaN(v)) s.add(v);
      }
    }
    return s;
  }

  /* ================================================================
   * 内部解析工具
   * ================================================================ */

  /** ± 展开：2±√5 → "2+√5,2-√5"（用逗号分隔，供 splitTop 切割）。
   * 需要捕获 ± 前面的表达式（如 2）和后面的表达式（如 √5），
   * 展开为 前面+后面,前面-后面。 */
  function expandPlusMinus(text) {
    return String(text == null ? '' : text)
      .replace(/([^，,;；或和与及±]*)±\s*([^，,;；或和与及]+)/g, function (_, pre, post) {
        return pre + '+' + post + ',' + pre + '-' + post;
      });
  }

  /** 顶层分割（不切割括号内的分隔符） */
  function splitTop(s, seps) {
    var parts = [];
    var depth = 0;
    var cur = '';
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (c === '(') depth++;
      else if (c === ')') depth = Math.max(0, depth - 1);
      if (depth === 0 && seps.indexOf(c) >= 0) { parts.push(cur); cur = ''; }
      else cur += c;
    }
    parts.push(cur);
    return parts.filter(function (p) { return p !== ''; });
  }

  /**
   * 解析单个根值：支持整数、小数、负数、根式（如 √5, 2+√5, -2±√3 已展开后各部分）。
   * @returns {number|null}
   */
  function parseRootValue(str) {
    var s = String(str == null ? '' : str).trim();
    if (!s) return null;

    /* 先转 ²→^2, ³→^3 再 NFKC，否则 NFKC 把 ² 变成数字 2 */
    s = s.replace(/²/g, '^2').replace(/³/g, '^3');
    s = s.normalize('NFKC');
    s = s.replace(/[−‐-―﹣]/g, '-').replace(/[×·⋅∙]/g, '*').replace(/÷/g, '/');
    s = s.replace(/\s+/g, '');

    /* 去掉前导 + 号（± 展开后可能出现 +√5 这种形式） */
    if (s.charAt(0) === '+') s = s.substring(1);

    /* 纯数字 */
    var m = /^([+-]?\d+(?:\.\d+)?)$/.exec(s);
    if (m) return parseFloat(m[1]);

    /* 根式：a+√b, √b, a-√b 等 —— 把 √ 转为 Math.sqrt 后用 new Function 求值 */
    if (s.indexOf('√') >= 0) {
      /* √(expr) → Math.sqrt(expr)，√number → Math.sqrt(number) */
      var expr = s.replace(/√\(/g, 'Math.sqrt(').replace(/√(\d+(?:\.\d+)?)/g, 'Math.sqrt($1)');
      /* 如果还有裸 √，无法处理 */
      if (expr.indexOf('√') >= 0) return null;
      /* 插入隐式乘号：2Math.sqrt → 2*Math.sqrt, )Math.sqrt → )*Math.sqrt */
      expr = expr.replace(/(\d)Math\.sqrt/g, '$1*Math.sqrt')
                 .replace(/\)Math\.sqrt/g, ')*Math.sqrt');
      /* 安全检查：移除 Math.sqrt 后剩余应全是算术字符 */
      var safe = expr
        .replace(/Math\.sqrt/g, '')
        .replace(/[0-9+\-*/(). ]/g, '');
      if (safe === '') {
        try {
          var fn = new Function('return (' + expr + ')');
          var v = fn();
          if (typeof v === 'number' && !isNaN(v)) return v;
        } catch (e) { /* fall through */ }
      }
    }

    /* 尝试作为 x 的表达式求值（x=0 时的常量） */
    var vals = evaluateExpression(s, [0]);
    if (vals && typeof vals[0] === 'number' && !isNaN(vals[0])) return vals[0];

    return null;
  }

  /**
   * 从题面文本中提取方程部分（lhs = rhs）。
   * 如 "用配方法解方程 x²+6x-7=0" → { lhs: "x²+6x-7", rhs: "0" }
   */
  function parseEquation(prompt) {
    if (!prompt) return null;
    var s = String(prompt).trim();
    /* 先转 ²→^2, ³→^3 再 NFKC，否则 NFKC 把 ² 变成数字 2 */
    s = s.replace(/²/g, '^2').replace(/³/g, '^3');
    s = s.normalize('NFKC');
    s = s.replace(/[−‐-―﹣]/g, '-');
    s = s.replace(/\s+/g, '');

    /* 找所有 = 号位置，逐个尝试提取方程。
     * 题面可能含多个 = （如 "2x²-8x+1=0 配方成 2(x-m)²=n"），
     * 取第一个左侧是数学表达式、右侧是数字/简单表达式的 = 号。 */
    var eqPositions = [];
    for (var i = 0; i < s.length; i++) {
      if (s[i] === '=') eqPositions.push(i);
    }
    if (eqPositions.length === 0) return null;

    for (var e = 0; e < eqPositions.length; e++) {
      var eqIdx = eqPositions[e];
      var lhs = s.substring(0, eqIdx);
      var rhs = s.substring(eqIdx + 1);

      /* 去掉中文前缀（"用配方法解方程"、"解方程"、"解" 等） */
      /* 方程应以 x 或数字或括号或负号开头 */
      var lhsStart = lhs.search(/[x\d(+-]/);
      if (lhsStart < 0) continue;
      lhs = lhs.substring(lhsStart);

      /* rhs 应该是数字或简单表达式（到下一个中文字符为止） */
      /* 截断 rhs 在第一个中文字符处 */
      var cnIdx = rhs.search(/[一-龥]/);
      if (cnIdx >= 0) rhs = rhs.substring(0, cnIdx);
      rhs = rhs.replace(/[。.！!？?]+$/, '').trim();

      /* 验证 rhs 是数字或简单表达式 */
      if (!rhs) continue;
      /* rhs 应以数字或 x 或负号开头 */
      if (!/^[0-9x\d+-]/.test(rhs)) continue;

      return { lhs: lhs, rhs: rhs };
    }

    /* 没找到有效的方程分割，回退到最后一个 = 号 */
    var lastEq = eqPositions[eqPositions.length - 1];
    var lhsFallback = s.substring(0, lastEq);
    var rhsFallback = s.substring(lastEq + 1);
    var lhsStart2 = lhsFallback.search(/[x\d(+-]/);
    if (lhsStart2 < 0) return null;
    return { lhs: lhsFallback.substring(lhsStart2), rhs: rhsFallback.replace(/[。.！!？?]+$/, '').trim() };
  }

  /**
   * 从题面提取二次方程系数 a, b, c。
   * 支持 x²+bx+c, ax²+bx+c 等形式。
   * @returns {{a:number,b:number,c:number}|null}
   */
  function parseQuadraticCoeffs(prompt) {
    var eq = parseEquation(prompt);
    if (!eq) return null;
    /* 把方程移到一边：lhs - rhs = 0 → 求系数 */
    /* 简化处理：假设 rhs 是常数（如 =0），直接从 lhs 提取系数 */
    var lhs = eq.lhs;
    var rhsVal = parseRootValue(eq.rhs);
    if (rhsVal === null) rhsVal = 0;

    /* 用求值法提取系数：对 lhs 在 x=0,1,-1 处求值，解线性方程组 */
    /* lhs(0) = c - rhs, lhs(1) = a+b+c - rhs, lhs(-1) = a-b+c - rhs */
    var vals = evaluateExpression(lhs, [0, 1, -1]);
    if (!vals) return null;

    var c0 = vals[0] - rhsVal;  /* c - rhs */
    var c1 = vals[1] - rhsVal;  /* a + b + c - rhs */
    var c2 = vals[2] - rhsVal;  /* a - b + c - rhs */

    var a = (c1 + c2 - 2 * c0) / 2;
    var b = (c1 - c2) / 2;
    var c = c0;

    /* 验证 a 不为零（二次方程） */
    if (Math.abs(a) < EPS) return null;

    return { a: a, b: b, c: c };
  }

  /* ================================================================
   * 验证门函数
   * ================================================================ */

  /**
   * 方程类验证：代入答案根求值，验证 |lhs(r) - rhs(r)| < 1e-9。
   * @param {string} prompt - 题面，如 "用配方法解方程 x²+6x-7=0"
   * @param {string} answer - 答案，如 "1，-7" 或 "2±√5"
   * @returns {{ok:boolean, reason:string}}
   */
  function verifyEquationRoots(prompt, answer) {
    var eq = parseEquation(prompt);
    if (!eq) return { ok: false, reason: 'parse-equation-failed' };

    var roots = parseRoots(answer);
    if (!roots || roots.length === 0) return { ok: false, reason: 'parse-roots-failed' };

    for (var i = 0; i < roots.length; i++) {
      var r = roots[i];
      if (r === null || isNaN(r)) return { ok: false, reason: 'invalid-root' };
      var lhsVals = evaluateExpression(eq.lhs, [r]);
      var rhsVals = evaluateExpression(eq.rhs, [r]);
      if (!lhsVals || !rhsVals) return { ok: false, reason: 'eval-failed' };
      if (Math.abs(lhsVals[0] - rhsVals[0]) >= EPS) {
        return { ok: false, reason: 'root-mismatch', root: r, diff: Math.abs(lhsVals[0] - rhsVals[0]) };
      }
    }
    return { ok: true, reason: 'all-roots-verified' };
  }

  /**
   * 配方加常数验证（q2 型）：答案应等于 (b/2)²。
   * @param {string} prompt - 如 "要把 x²+6x 配成完全平方式，需要加上的常数是多少？"
   * @param {string} answer - 如 "9"
   * @returns {{ok:boolean, reason:string}}
   */
  function verifyCompletingSquare(prompt, answer) {
    /* 从题面提取一次项系数 b：找 x²+bx 或 x²-bx 中的 b */
    /* 注意：先转 ²→^2 再 NFKC，否则 NFKC 把 ² 变成数字 2 */
    var s = String(prompt || '').replace(/²/g, '^2').normalize('NFKC').replace(/[−‐-―﹣]/g, '-').replace(/\s+/g, '');

    /* 提取 x²+bx 中的 b：匹配 x^2 后跟 [+-]\d+x */
    var m = /x\^2([+-]\d+)x/.exec(s);
    var b;
    if (m) {
      b = parseInt(m[1], 10);
    } else {
      /* 尝试 x²+bx 形式（b=1 时写 +x 或 -x） */
      m = /x\^2\+x/.exec(s);
      if (m) b = 1;
      else {
        m = /x\^2-x/.exec(s);
        if (m) b = -1;
        else return { ok: false, reason: 'extract-b-failed' };
      }
    }

    var expected = Math.pow(b / 2, 2);
    var actual = parseRootValue(String(answer));
    if (actual === null) return { ok: false, reason: 'parse-answer-failed' };

    if (Math.abs(expected - actual) < EPS) return { ok: true, reason: 'verified' };
    return { ok: false, reason: 'mismatch', expected: expected, actual: actual };
  }

  /**
   * 配方 m,n 验证（q4 型）：验证 m = |b/(2a)|, n = a*m² - c（移项后右边的值）。
   * 题面如 "把 2x²-8x+1=0 配方成 2(x-m)²=n"。
   * @returns {{ok:boolean, reason:string}}
   */
  function verifyFormParam(prompt, answer) {
    var coeffs = parseQuadraticCoeffs(prompt);
    if (!coeffs) return { ok: false, reason: 'parse-coeffs-failed' };

    var a = coeffs.a, b = coeffs.b, c = coeffs.c;

    /* m = |b/(2a)|（配方后 (x-m)² 中的 m 是正值参数） */
    var mExpected = Math.abs(b / (2 * a));
    /* n = a*m² - c（移项：ax²+bx+c=0 → a(x-m)² = a*m² - c） */
    var nExpected = a * mExpected * mExpected - c;

    /* 解析答案 "m，n" */
    var parts = splitTop(String(answer || ''), ',;，；、');
    if (parts.length < 2) return { ok: false, reason: 'parse-answer-failed' };
    var mActual = parseRootValue(String(parts[0]).trim());
    var nActual = parseRootValue(String(parts[1]).trim());
    if (mActual === null || nActual === null) return { ok: false, reason: 'parse-answer-failed' };

    if (Math.abs(mExpected - mActual) >= EPS) {
      return { ok: false, reason: 'm-mismatch', expected: mExpected, actual: mActual };
    }
    if (Math.abs(nExpected - nActual) >= EPS) {
      return { ok: false, reason: 'n-mismatch', expected: nExpected, actual: nActual };
    }
    return { ok: true, reason: 'verified' };
  }

  /**
   * 验证门入口：按 q.verifyType 路由到对应验证函数。
   * @param {object} q - 题对象，含 prompt, answer, verifyType
   * @returns {{ok:boolean|null, reason:string}}
   */
  function validateLLMQuestion(q) {
    if (!q || !q.verifyType) return { ok: null, reason: 'no-verify-type' };
    switch (q.verifyType) {
      case 'equation':
        return verifyEquationRoots(q.prompt, q.answer);
      case 'completeSquare':
        return verifyCompletingSquare(q.prompt, q.answer);
      case 'formParam':
        return verifyFormParam(q.prompt, q.answer);
      default:
        return { ok: null, reason: 'unknown-type:' + q.verifyType };
    }
  }

  /**
   * 解析答案中的根值列表（支持多解、±、根式）。
   * @param {string} answer
   * @returns {number[]|null}
   */
  function parseRoots(answer) {
    if (!answer) return null;
    var expanded = expandPlusMinus(String(answer));
    var parts = splitTop(expanded, ',;，；、');
    var roots = [];
    for (var i = 0; i < parts.length; i++) {
      var subparts = String(parts[i]).split(/或者|或|和|与|及/);
      for (var j = 0; j < subparts.length; j++) {
        var v = parseRootValue(String(subparts[j]).trim());
        if (v !== null && !isNaN(v)) roots.push(v);
      }
    }
    return roots.length > 0 ? roots : null;
  }

  return {
    evaluateExpression: evaluateExpression,
    solveCheck: solveCheck,
    normalizeSet: normalizeSet,
    verifyEquationRoots: verifyEquationRoots,
    verifyCompletingSquare: verifyCompletingSquare,
    verifyFormParam: verifyFormParam,
    validateLLMQuestion: validateLLMQuestion,
    /* 解析工具（llm-variants.js 的生成管线与测试可直接用） */
    parseEquation: parseEquation,
    parseQuadraticCoeffs: parseQuadraticCoeffs,
    parseRootValue: parseRootValue,
    parseRoots: parseRoots,
    expandPlusMinus: expandPlusMinus,
    splitTop: splitTop,
    EPS: EPS
  };
});
