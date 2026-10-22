/* O3 LLM 变式出题管线：LLM 产候选 → 验证门校验 → 不过重试（限 3 次）→ 全不过返回 null。
 *
 * 设计文档：docs/o3-llm-variants.md
 * 零新依赖（用 fetch 调本地网关）、UMD 包装、不修改 engine.js/variants.js。
 * 浏览器中暴露为 window.DiagLLMVariants，Node 中 require() 即可。
 *
 * 核心思路：LLM 只管"出题面"，引擎管"验对错"——LLM 算错不要紧，
 * 验证门拦住就不让学生看到错题。工具自验（§2.4）是效率层，验证门是正确性层。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.DiagLLMVariants = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = 1;
  var PROXY = 'http://127.0.0.1:3000/v1/chat/completions';
  var MODEL = 'DeepSeek-V4-Flash-0731-Unlimited';
  var MAX_RETRIES = 3;
  var TIMEOUT_MS = 10000;
  var CACHE_KEY = 'cnmDiagnose.llmVariants.v1';
  var STATS_KEY = 'cnmDiagnose.llmVariantStats.v1';
  var POOL_MAX = 50;
  var EPS = 1e-9;

  /* 试点族 recipe：当前仅 cnm_221（配方法） */
  var RECIPES = {
    'cnm_221': { difficulties: ['basic', 'standard', 'advanced'] }
  };

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

  /* ================================================================
   * prompt 模板（§4）
   * ================================================================ */

  function _systemPrompt() {
    return '你是人教版初中数学出题老师。请按照要求出一道「配方法」练习题。'
      + '\n\n要求：'
      + '\n1. 题目必须是「用配方法解一元二次方程」或「配方相关」的数值题。'
      + '\n2. 系数必须是整数，判别式必须非负（保证有实数根）。'
      + '\n3. 答案如果是根式（如 2±√5），判别式不能是完全平方数。'
      + '\n4. 答案如果是有理数（如 1，-7），判别式必须是完全平方数。'
      + '\n5. 不要照抄任何已有题目，每次用不同的系数。'
      + '\n\n输出格式严格为 JSON，不要任何多余文字：'
      + '\n{"prompt":"题面文本","answer":"答案","explanation":"分步解析","verifyType":"equation|completeSquare|formParam","difficulty":"basic|standard|advanced"}';
  }

  function _userPrompt(difficulty) {
    if (difficulty === 'basic') {
      return '出一道基础题：给定一个二次多项式 x²+bx，问"需要加上的常数是多少"。'
        + '\n答案格式：一个整数（即 (b/2)²）。'
        + '\nverifyType: "completeSquare"'
        + '\n难度: basic';
    }
    if (difficulty === 'advanced') {
      return '出一道进阶题，从以下两种中选一种：'
        + '\nA) 二次项系数≠1的配方：如 "把 2x²-8x+1=0 配方成 2(x-m)²=n，依次求 m 与 n"'
        + '\n   答案格式：如 "2，7"，verifyType: "formParam"'
        + '\nB) 判别式非完全平方的解方程：如 "用配方法解 x²-4x-1=0"'
        + '\n   答案格式：如 "2±√5"，verifyType: "equation"'
        + '\n难度: advanced';
    }
    /* standard 默认 */
    return '出一道标准题：用配方法解一个一元二次方程 x²+bx+c=0（b 为偶数，使配方干净）。'
      + '\n要求判别式为完全平方数（答案是有理数），两个根用逗号隔开。'
      + '\n答案格式：如 "1，-7"'
      + '\nverifyType: "equation"'
      + '\n难度: standard';
  }

  /* ================================================================
   * 缓存池（§5）
   * ================================================================ */

  /* Node 环境 fallback：没有 localStorage 时用内存 Map */
  var _memCache = {};
  var _memStats = {};

  function _getStorage() {
    try {
      if (typeof localStorage !== 'undefined') return localStorage;
    } catch (e) { /* SSR / Node */ }
    return null;
  }

  function _readCache() {
    var storage = _getStorage();
    if (storage) {
      try {
        var raw = storage.getItem(CACHE_KEY);
        return raw ? JSON.parse(raw) : {};
      } catch (e) { return {}; }
    }
    /* Node fallback */
    return _memCache;
  }

  function _writeCache(data) {
    var storage = _getStorage();
    if (storage) {
      try { storage.setItem(CACHE_KEY, JSON.stringify(data)); } catch (e) { /* quota */ }
    } else {
      _memCache = data;
    }
  }

  function _getCachePool(topicId) {
    var cache = _readCache();
    return cache[topicId] || [];
  }

  function _pushCache(topicId, q) {
    var cache = _readCache();
    if (!cache[topicId]) cache[topicId] = [];
    cache[topicId].push(q);
    /* LIFO 淘汰：超过上限时移除最旧的 */
    while (cache[topicId].length > POOL_MAX) {
      cache[topicId].shift();
    }
    _writeCache(cache);
  }

  function _clearCache() {
    _writeCache({});
  }

  /* ================================================================
   * 健康指标（§8）
   * ================================================================ */

  var _stats = { attempts: 0, passed: 0, failed: 0, byReason: {} };
  var _topicStats = {};

  function _readStatsStorage() {
    var storage = _getStorage();
    if (storage) {
      try {
        var raw = storage.getItem(STATS_KEY);
        return raw ? JSON.parse(raw) : {};
      } catch (e) { return {}; }
    }
    return _memStats;
  }

  function _writeStatsStorage(data) {
    var storage = _getStorage();
    if (storage) {
      try { storage.setItem(STATS_KEY, JSON.stringify(data)); } catch (e) { /* quota */ }
    } else {
      _memStats = data;
    }
  }

  function _resetStats() {
    _stats = { attempts: 0, passed: 0, failed: 0, byReason: {} };
    _topicStats = _readStatsStorage();  /* 重置内存，但从 storage 读取持久化的 */
    /* 测试场景下也清空 storage */
    _writeStatsStorage({});
    _topicStats = {};
  }

  function _recordStat(key, passed, reason) {
    /* 更新聚合统计（getStats 返回） */
    _stats.attempts++;
    if (passed) {
      _stats.passed++;
    } else {
      _stats.failed++;
      if (reason) {
        _stats.byReason[reason] = (_stats.byReason[reason] || 0) + 1;
      }
    }
    /* 更新按 topic+difficulty 分组的统计（supports 健康检查用） */
    if (!_topicStats[key]) _topicStats[key] = { attempts: 0, passed: 0, failed: 0, byReason: {} };
    _topicStats[key].attempts++;
    if (passed) {
      _topicStats[key].passed++;
    } else {
      _topicStats[key].failed++;
      if (reason) {
        _topicStats[key].byReason[reason] = (_topicStats[key].byReason[reason] || 0) + 1;
      }
    }
    _writeStatsStorage(_topicStats);
  }

  function getStats() {
    return { attempts: _stats.attempts, passed: _stats.passed, failed: _stats.failed, byReason: _stats.byReason };
  }

  /* ================================================================
   * 网关可达性探测（§6.1 调用前检查）
   * try 一次 /v1/models 或超时标记，不可达直接走降级，不拖慢页面。
   * ================================================================ */

  var _gatewayReachable = null;   /* null=未探测, true=可达, false=不可达 */

  /**
   * 探测网关是否可达。try 一次 /v1/models，3 秒超时。
   * 结果缓存在 _gatewayReachable，同一次页面会话只探测一次。
   * @returns {Promise<boolean>}
   */
  function probeGateway() {
    if (_gatewayReachable !== null) return Promise.resolve(_gatewayReachable);
    if (typeof fetch !== 'function') {
      _gatewayReachable = false;
      return Promise.resolve(false);
    }

    var modelsUrl = PROXY.replace('/chat/completions', '/models');
    var controller = null;
    var timeoutId = null;
    if (typeof AbortController !== 'undefined') {
      controller = new AbortController();
      timeoutId = setTimeout(function () { controller.abort(); }, 3000);
    }

    return fetch(modelsUrl, {
      method: 'GET',
      signal: controller ? controller.signal : undefined
    })
      .then(function (res) {
        if (timeoutId) clearTimeout(timeoutId);
        _gatewayReachable = res.ok;
        return _gatewayReachable;
      })
      .catch(function () {
        if (timeoutId) clearTimeout(timeoutId);
        _gatewayReachable = false;
        return false;
      });
  }

  /* ================================================================
   * function calling 探测（§2.4 工具自验）
   * 探测网关模型是否支持 function calling（OpenAI 兼容 tools 参数）。
   * 支持 → LLM 侧 tools 接入（evaluateExpression/solveCheck/normalizeSet）。
   * 不支持 → 记录结论，维持引擎外部验证路径（验证门仍保留为硬保证）。
   * ================================================================ */

  var _supportsTools = null;   /* null=未探测, true=支持, false=不支持 */

  /**
   * 探测网关模型是否支持 function calling。
   * 发一个带 tools 参数的最小候选请求，看返回是否含 tool_calls。
   * @returns {Promise<boolean>}
   */
  function probeFunctionCalling() {
    if (_supportsTools !== null) return Promise.resolve(_supportsTools);
    if (typeof fetch !== 'function') {
      _supportsTools = false;
      return Promise.resolve(false);
    }

    var controller = null;
    var timeoutId = null;
    if (typeof AbortController !== 'undefined') {
      controller = new AbortController();
      timeoutId = setTimeout(function () { controller.abort(); }, 5000);
    }

    var body = {
      model: MODEL,
      messages: [
        { role: 'user', content: '调用 check 工具验证 x=1 是否满足 x-1=0' }
      ],
      tools: [{
        type: 'function',
        function: {
          name: 'solveCheck',
          description: '代入验根：验证 candidate 是否满足 equation',
          parameters: {
            type: 'object',
            properties: {
              equation: { type: 'string', description: '方程表达式' },
              candidate: { type: 'string', description: '候选根' }
            },
            required: ['equation', 'candidate']
          }
        }
      }],
      tool_choice: 'auto',
      max_tokens: 100
    };

    return fetch(PROXY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller ? controller.signal : undefined
    })
      .then(function (res) {
        if (timeoutId) clearTimeout(timeoutId);
        if (!res.ok) { _supportsTools = false; return false; }
        return res.json();
      })
      .then(function (data) {
        if (!data) return _supportsTools;
        var msg = data.choices && data.choices[0] && data.choices[0].message;
        /* 支持 function calling 的标志：返回 tool_calls 或接受 tools 参数不报错 */
        _supportsTools = !!(msg && msg.tool_calls && msg.tool_calls.length > 0);
        /* 如果没返回 tool_calls 但也没报错（接受 tools 参数），标记为可能支持 */
        if (!_supportsTools && msg && msg.content) {
          _supportsTools = true;  /* 模型接受了 tools 参数，只是选择直接回答 */
        }
        return _supportsTools;
      })
      .catch(function () {
        if (timeoutId) clearTimeout(timeoutId);
        _supportsTools = false;
        return false;
      });
  }

  /* ================================================================
   * supports / genLLMVariant / fillPracticeLLM
   * ================================================================ */

  /**
   * 该知识点是否有 LLM 变式 recipe。
   * @param {string} topicId
   * @param {string} [difficulty] - 传入时检查健康指标
   * @returns {boolean}
   */
  function supports(topicId, difficulty) {
    if (!RECIPES[topicId]) return false;
    if (difficulty) {
      var key = topicId + ':' + difficulty;
      var ts = _topicStats[key];
      if (ts && ts.attempts >= 10) {
        var failRate = ts.failed / ts.attempts;
        if (failRate > 0.3) return false;
      }
    }
    return true;
  }

  /**
   * 异步生成 1 道 LLM 变式。
   * 管线：调网关 → 验证门 → 通过则写缓存返回 / 不通过重试（限 3 次）→ 全不过返回 null。
   * @param {string} topicId
   * @param {object} opts - {difficulty, avoidPrompts, seed}
   * @returns {Promise<question|null>}
   */
  function genLLMVariant(topicId, opts) {
    opts = opts || {};
    var difficulty = opts.difficulty || 'standard';
    var seed = opts.seed || (topicId + '|s' + Date.now());

    /* 先查缓存池 */
    var pool = _getCachePool(topicId);
    if (pool.length > 0) {
      /* 取最后一道（LIFO） */
      var cached = pool[pool.length - 1];
      /* 如果缓存的题难度匹配，直接返回 */
      if (!difficulty || cached.difficulty === difficulty) {
        return Promise.resolve(cached);
      }
    }

    return _genWithRetry(topicId, difficulty, seed, 0);
  }

  function _genWithRetry(topicId, difficulty, seed, attempt) {
    if (attempt >= MAX_RETRIES) {
      return Promise.resolve(null);
    }

    var statKey = topicId + ':' + difficulty;

    return _callGateway(difficulty)
      .then(function (candidate) {
        if (!candidate) {
          _recordStat(statKey, false, 'no-candidate');
          return _genWithRetry(topicId, difficulty, seed, attempt + 1);
        }

        /* 验证门校验 */
        var result = validateLLMQuestion(candidate);
        if (result.ok === true) {
          _recordStat(statKey, true);
          /* 构建题对象 */
          var pool = _getCachePool(topicId);
          var q = {
            id: topicId + '_lv' + (pool.length + 1),
            topicId: topicId,
            difficulty: candidate.difficulty || difficulty,
            type: 'numeric',
            prompt: candidate.prompt,
            answer: candidate.answer,
            explanation: candidate.explanation || '',
            verifyType: candidate.verifyType,
            verify: candidate.verify || '',
            variant: true,
            variantSource: 'llm',
            variantIndex: pool.length,
            seed: seed,
            createdAt: Date.now()
          };
          /* 多根答案设 unordered */
          if (candidate.answer && /[，,；;、]/.test(candidate.answer)) {
            q.unordered = true;
          }
          /* 写入缓存池 */
          _pushCache(topicId, q);
          return q;
        } else {
          _recordStat(statKey, false, result.reason);
          /* 重试 */
          return _genWithRetry(topicId, difficulty, seed, attempt + 1);
        }
      })
      .catch(function () {
        _recordStat(statKey, false, 'gateway-error');
        /* 网关错误也重试（超时、连接拒绝等） */
        return _genWithRetry(topicId, difficulty, seed, attempt + 1);
      });
  }

  /**
   * 调用本地网关生成 1 道候选题。
   * @param {string} difficulty
   * @returns {Promise<object|null>}
   */
  function _callGateway(difficulty) {
    if (typeof fetch !== 'function') return Promise.resolve(null);

    var controller = null;
    var timeoutId = null;
    if (typeof AbortController !== 'undefined') {
      controller = new AbortController();
      timeoutId = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
    }

    var body = {
      model: MODEL,
      messages: [
        { role: 'system', content: _systemPrompt() },
        { role: 'user', content: _userPrompt(difficulty) }
      ],
      max_tokens: 500,
      temperature: 0.8
    };

    return fetch(PROXY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller ? controller.signal : undefined
    })
      .then(function (res) {
        if (timeoutId) clearTimeout(timeoutId);
        if (!res.ok) return null;
        return res.json();
      })
      .then(function (data) {
        if (!data || !data.choices || !data.choices[0]) return null;
        var content = data.choices[0].message.content;
        return _parseCandidate(content);
      })
      .catch(function () {
        if (timeoutId) clearTimeout(timeoutId);
        return null;
      });
  }

  /**
   * 从 LLM 返回内容中解析候选题 JSON。
   * 同 explain.js parseSteps：正则提取 {...}。
   */
  function _parseCandidate(content) {
    if (!content) return null;
    var m = String(content).match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      var j = JSON.parse(m[0]);
      if (!j.prompt || !j.answer || !j.verifyType) return null;
      return j;
    } catch (e) { return null; }
  }

  /**
   * 补位 gap 道 LLM 变式到 fp.list 后面。
   * @param {object} fp - O1 fillPractice 的返回值 {list, usedVariants, nextIndex}
   * @param {string} topicId
   * @param {number} gap - 需要补几道
   * @param {object} opts - {doneIds, avoidPrompts}
   * @returns {Promise<{list, usedVariants, nextIndex}>}
   */
  function fillPracticeLLM(fp, topicId, gap, opts) {
    opts = opts || {};
    var list = (fp && fp.list) ? fp.list.slice() : [];
    var usedVariants = (fp && fp.usedVariants) || 0;
    var nextIndex = (fp && fp.nextIndex) || 0;

    if (gap <= 0 || !supports(topicId)) {
      return Promise.resolve({ list: list, usedVariants: usedVariants, nextIndex: nextIndex });
    }

    var promises = [];
    for (var i = 0; i < gap; i++) {
      promises.push(genLLMVariant(topicId, {
        difficulty: 'standard',
        avoidPrompts: opts.avoidPrompts
      }));
    }

    return Promise.all(promises).then(function (results) {
      for (var j = 0; j < results.length; j++) {
        if (results[j]) {
          list.push(results[j]);
          usedVariants++;
        }
      }
      return { list: list, usedVariants: usedVariants, nextIndex: nextIndex };
    });
  }

  /* ================================================================
   * 导出
   * ================================================================ */

  return {
    VERSION: VERSION,
    supports: supports,
    genLLMVariant: genLLMVariant,
    fillPracticeLLM: fillPracticeLLM,
    validateLLMQuestion: validateLLMQuestion,
    verifyEquationRoots: verifyEquationRoots,
    verifyCompletingSquare: verifyCompletingSquare,
    verifyFormParam: verifyFormParam,
    evaluateExpression: evaluateExpression,
    solveCheck: solveCheck,
    normalizeSet: normalizeSet,
    getStats: getStats,
    probeGateway: probeGateway,
    probeFunctionCalling: probeFunctionCalling,
    /* 测试用内部接口 */
    _systemPrompt: _systemPrompt,
    _userPrompt: _userPrompt,
    _resetStats: _resetStats,
    _clearCache: _clearCache,
    _pushCache: _pushCache,
    _getCachePool: _getCachePool,
    _recordStat: _recordStat,
    _resetProbe: function () { _gatewayReachable = null; _supportsTools = null; }
  };
});
