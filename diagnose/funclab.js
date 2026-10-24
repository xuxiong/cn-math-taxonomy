/* 初中函数实验室：把题面里的函数参数解析出来，渲染可拖拽的画板。
 *
 * 支持的函数类型（初中全部函数）：
 *   quadratic  二次函数  y = a(x-h)² + k    滑块 a(开口/宽窄)、h(左右平移)、k(上下平移)
 *   linear     一次函数  y = kx + b         滑块 k(斜率)、b(截距)
 *   inverse    反比例    y = k / x          滑块 k(象限/离轴远近)
 *
 * 方案：配置驱动（预置组件，LLM 零参与）。题型白名单 + 题面解析出参数就挂载，
 * 解析不出就不挂（静默降级），因此对题库内容零侵入。
 *
 * UMD：浏览器暴露 window.Funclab，Node require() 可单测 fromPrompt（纯函数，无 DOM）。
 */
(function (root, factory) {
  'use strict';
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.Funclab = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* engine.js 的数值等价（numericEqual）是判定学生填数的唯一归一化出处（与 geomlab 同源）。
   * node 下 require 注入，浏览器由 index.html 的 <script> 顺序保证（engine.js 在 funclab.js 之前）。 */
  let _engine = null;
  try {
    if (typeof module !== 'undefined' && module.exports && typeof require === 'function') {
      _engine = require('./engine.js');
    }
  } catch (e) { _engine = null; }

  /* ------------------------------------------------------------ 纯解析（可单测） */

  /** 把一次项系数 b 提取成数字。s 形如 "+6" / "-4" / "" / "2" / "-"，null/undefined 视为省略（=1） */
  function coeffNum(s) {
    if (s == null) return 1;
    const t = String(s).replace(/\s+/g, '');
    if (t === '' || t === '+') return 1;
    if (t === '-') return -1;
    return parseFloat(t);
  }

  /** 归一化题面：全角转半角、x^2 -> x²、去掉空格，保留可读性 */
  function normalize(prompt) {
    let s = String(prompt || '');
    s = s.replace(/[（]/g, '(').replace(/[）]/g, ')');   // 全角括号只影响系数，转半角防解析偏
    s = s.replace(/x\s*\^\s*2/g, 'x²');
    return s;
  }

  /** 从字串抠数字，抠不出（字母 k/b/m 之类参数）返回 null */
  function numOrNull(s) {
    if (s == null) return null;
    const t = String(s).replace(/\s+/g, '');
    if (t === '' || t === '+' || t === '-') return NaN;   // 孤立符号 = 系数 ±1 但这里统一用 coeffNum
    const v = parseFloat(t);
    return isFinite(v) ? v : null;
  }

  /**
   * 匹配紧跟其后的 "= 右式"，用于方程题：把右式移到左边（y = 左式 - 右式），
   * 这样画板与 x 轴的交点（绿点）就是方程的根。
   * 返回 {state:'none'} 无等号 / {state:'num', value:数} / {state:'bad'} 右式含字母或无法数值化。
   */
  function rhsAfter(rest) {
    // 紧接除法（y=-x²/8 之类）意味着系数被约掉了，画板会画出错误曲线 → 不挂
    if (/^\s*\//.test(rest)) return { state: 'bad' };
    const m = /^\s*=\s*([^\s，,。；;、）)]+)/.exec(rest);
    if (!m) return { state: 'none' };
    const tok = m[1];
    if (!/^[+-]?\d*\.?\d+$/.test(tok)) return { state: 'bad' };   // "k-3" / "a" 之类含参，画板无法确定
    return { state: 'num', value: parseFloat(tok) };
  }

  /** 由 ax²+bx+c 的系数换算成画板参数 {type:'quadratic', a, h, k}；a=0/非有限 → null */
  function quadFromABC(a, b, c) {
    if (!isFinite(a) || !isFinite(b) || !isFinite(c) || a === 0) return null;
    // 配方换算：y = a(x-h)² + k，其中 h = -b/(2a)，k = c - b²/(4a)
    // 归一化 -0 → 0，避免 h/k 呈现 -0（deepStrictEqual 与下游标注都干净）
    let h = -b / (2 * a);
    let k = c - (b * b) / (4 * a);
    if (h === 0) h = 0;
    if (k === 0) k = 0;
    if (!isFinite(h) || !isFinite(k)) return null;
    return { type: 'quadratic', a: a, h: h, k: k };
  }

  /**
   * 把 "<k>x<b>" 这种一次因子拆成系数。只接受纯数字系数（"2x-3"、"-x"、"x+1"）；
   * 出现字母（"kx+b"、"px"）或多余符号返回 null。
   */
  function linearFactor(str) {
    const m = /^\s*([+-]?\s*\d*\.?\d*)\s*x\s*([+-]\s*\d+\.?\d*)?\s*$/.exec(String(str || ''));
    if (!m) return null;
    const k = coeffNum(m[1]);
    const b = m[2] ? coeffNum(m[2]) : 0;
    if (!isFinite(k) || !isFinite(b)) return null;
    return { k: k, b: b };
  }

  /**
   * 方程写成展开式之前的样子（题面不会给出目标式，参数藏在待展开的式子里）。
   * 目前覆盖两种真实题库写法：
   *   P1 乘积式：两个一次式相乘 = 常数      例 (2x-1)(x+1)=2
   *   P2 完全平方 = 一次式：两边都是表达式    例 (x-2)²=3(x-2)
   * 两者都要"移项 → 展开 → 配方"，画板的零点才是方程的根。
   * 任何一处含参（字母系数）或右侧不是纯数字，一律返回 undefined 交给后续分支，绝不猜。
   */
  function quadFromExpandedEquation(s) {
    // P1：乘积式方程
    let m = /\(\s*([^()]{1,16})\)\s*\(\s*([^()]{1,16})\)\s*=\s*([+-]?\d+\.?\d*)(?![.\d])/.exec(s);
    if (m) {
      const f1 = linearFactor(m[1]);
      const f2 = linearFactor(m[2]);
      const rhs = parseFloat(m[3]);
      if (f1 && f2 && isFinite(rhs)) {
        // (k1x+b1)(k2x+b2) = RHS → k1k2 x² + (k1b2+k2b1) x + (b1b2-RHS) = 0
        return quadFromABC(f1.k * f2.k, f1.k * f2.b + f2.k * f1.b, f1.b * f2.b - rhs);
      }
      return undefined;
    }

    // P2：完全平方 = 一次式（右侧可带数字系数）
    m = /\(\s*([+-]?\s*\d*\.?\d*)\s*x\s*([+-]\s*\d+\.?\d*)\s*\)\s*²\s*=\s*([+-]?\s*\d*\.?\d*)\s*\(\s*x\s*([+-]\s*\d+\.?\d*)\s*\)(?![²\dx])/.exec(s);
    if (m) {
      const A = coeffNum(m[1]);          // 平方项的一次系数
      const C = coeffNum(m[2]);          // 括号内常数
      const k = coeffNum(m[3]);          // 右侧一次式系数
      const C2 = coeffNum(m[4]);         // 右侧一次式常数
      if ([A, C, k, C2].every(isFinite)) {
        // (Ax+C)² - k(x+C2) = A²x² + (2AC-k)x + (C²-kC2) = 0
        return quadFromABC(A * A, 2 * A * C - k, C * C - k * C2);
      }
    }
    return undefined;
  }

  /**
   * 变量名不是 x 的二次式（如球的高度 h=-5t²+20t）。要求：
   *   · 立方之前的二次项系数必须**显式写出来**（"-5"、"-"、"2"），否则 "a_n=n²" 这类
   *     递推式记号会被误认成抛物线；
   *   · 系数必须是数字，不能是字母；
   *   · 等式右侧不能再接"= 某式"（那说明还有未知量）。
   * 画板统一用 x 作自变量，曲线形状与顶点/零点不受改名影响。
   */
  function quadFromRenamedVar(s) {
    const m = /(?<![a-zA-Z])([a-zA-Z])\s*=\s*((?:[+-]?\s*\d+\.?\d*)|[+-])\s*([a-zA-Z])\s*²\s*(?:([+-]\s*\d+\.?\d*)\s*\3\s*)?([+-]\s*\d+\.?\d*)?(?![\d.])/.exec(s);
    if (!m) return null;
    const tail = s.slice(m.index + m[0].length);
    if (/^\s*=/.test(tail)) return null;          // 后面还有等式 → 未知量未定
    const a = coeffNum(m[2]);
    const b = m[4] ? coeffNum(m[4]) : 0;
    const c = m[5] ? coeffNum(m[5]) : 0;
    if (![a, b, c].every(isFinite)) return null;
    const r = quadFromABC(a, b, c);
    return r && r.type === 'quadratic' ? r : null;
  }

  /**
   * 从题面解析函数参数 → {type, ...params}，解析不出返回 null。
   * 二次：{type:'quadratic', a, h, k}   一次：{type:'linear', k, b}   反比例：{type:'inverse', k}
   */
  function fromPrompt(prompt) {
    const s = normalize(prompt);
    if (!s) return null;

    // ---------- 反比例：y = k/x（k 可能带符号/省略=1） ----------
    let m = s.match(/y\s*=\s*([+-]?\s*\d*\.?\d*)\s*\/\s*x/);
    if (m) {
      const k = coeffNum(m[1]);
      if (k !== 0 && isFinite(k)) return { type: 'inverse', k: k };
    }

    // ---------- 一次函数：y = kx + b ----------
    // 排除 y=ax² / ax³ / ax^n 被误匹配：负向断言 x 后不是上标或幂号
    m = s.match(/y\s*=\s*([+-]?\s*\d*\.?\d*)?\s*x(?![\u00B2\u00B3\u00B9^])\s*([+-]\s*\d*\.?\d*)?/);
    if (m) {
      // "y=kx+b" 里 k/b 是字母 → 跳过（概念题让模型讲，不挂画板）
      const kS = String(m[1] == null ? '' : m[1]).replace(/\s+/g, '');
      const k = coeffNum(m[1]);
      const b = m[2] ? coeffNum(m[2]) : 0;
      if (/[a-zA-Z]/.test(kS)) return null;
      if (isFinite(k) && isFinite(b)) return { type: 'linear', k: k, b: b };
    }

    // ---------- 展开式方程（乘积式 / 两边都是表达式）：先移项展开再配方 ----------
    // 这类题面把目标式藏在待展开的式子里（(2x-1)(x+1)=2、(x-2)²=3(x-2)），
    // 不展开就解析不出；展开后画板零点正是方程的根。
    // 必须排在顶点式之前：顶点式分支遇到 "= 3(x-2)" 这类表达式右侧会直接放弃，
    // 但它其实是"移项后可解"的方程，不能当成含参放弃。
    const expanded = quadFromExpandedEquation(s);
    if (expanded) return expanded;

    // ---------- 二次函数（顶点式/一般式/方程，含配方题） ----------
    // 1) 顶点式：y = a(x±h)² ± k 或 a(x±m)² ± n。x² 前不允许是字母（y=a(x-2)² 的 a 未知，不画）
    m = s.match(/(?<![a-zA-Z)）])([+-]?\s*\d*\.?\d*)\s*\(\s*x\s*([+-]\s*\d*\.?\d*)\s*\)\s*²\s*([+-]\s*\d*\.?\d*)?(?!\s*x)/);
    if (m) {
      const a = coeffNum(m[1]);
      const h = -coeffNum(m[2]);
      let k = m[3] ? coeffNum(m[3]) : 0;
      const rhs = rhsAfter(s.slice(m.index + m[0].length));
      if (rhs.state === 'bad') return null;               // 方程右侧含参，参数不确定
      if (rhs.state === 'num') {
        // 方程题：a(x-h)² + c = RHS → 画 y = (左式) - RHS，其零点就是方程的根。
        // 顶点纵坐标 k = c - RHS（**不除 a**）：画板绘制的是 a(x-h)²+k，
        // 由 a(x-h)² + (c-RHS) = 0 得 x = h ± √((RHS-c)/a)，与方程 a(x-h)² = RHS-c 的解一致。
        // 例：4(x+2)²=25 → k=-25，零点 -2±√(25/4) = 1/2、-9/2（等于题库答案）。
        // 若误写成 k=-25/4，零点会变成 -3/4、-13/4，与答案不符。
        k = k - rhs.value;
      }
      if (a !== 0 && isFinite(a) && isFinite(h) && isFinite(k)) {
        if (k === 0) k = 0;                               // 归一化 -0
        return { type: 'quadratic', a: a, h: h, k: k };
      }
    }

    // ---------- 一般式 & 方程：提取 ax²+bx+c（可缺 bx 项；可能接 =0 或 = 某数）。
    // x² 前不允许是字母/括号（如 (m-2)x² 是含参概念题）
    m = s.match(/(?<![a-zA-Z)）])([+-]?\s*\d*\.?\d*)?\s*x²\s*(?:([+-]\s*\d*\.?\d*)\s*x\s*)?([+-]\s*\d*\.?\d*)?/);
    if (!m) {
      // 变量名不是 x 的二次式（h=-5t²+20t）：前面的 x 型分支都匹配不到
      return quadFromRenamedVar(s);
    }
    // 式子后面还挂着字母项（如 x²+px+q）说明含参，画不出确定曲线 → 不解析
    const afterPoly = s.slice(m.index + m[0].length);
    if (/^\s*[+-]?\s*[a-zA-Z]/.test(afterPoly)) return null;
    const a = coeffNum(m[1]);
    const b = m[2] ? coeffNum(m[2]) : 0;
    let c = m[3] ? coeffNum(m[3]) : 0;
    const rhs2 = rhsAfter(s.slice(m.index + m[0].length));
    if (rhs2.state === 'bad') return null;
    // 方程题移项：ax²+bx+c = RHS → ax²+bx+(c-RHS) = 0，所以常数项减 RHS 后再做配方换算
    if (rhs2.state === 'num') c -= rhs2.value;
    if (a === 0 || !isFinite(a) || !isFinite(b) || !isFinite(c)) return null;
    // 配方换算：y = a(x-h)² + k，其中 h = -b/(2a)，k = c - b²/(4a)
    // 归一化 -0 → 0，避免 h/k 呈现 -0（deepStrictEqual 与下游标注都干净）
    let h = -b / (2 * a);
    let k = c - (b * b) / (4 * a);
    if (h === 0) h = 0;
    if (k === 0) k = 0;
    if (!isFinite(h) || !isFinite(k)) return null;
    return { type: 'quadratic', a: a, h: h, k: k };
  }

  /** 题型 → 函数类型：分到能挂画布的知识点类别，挂不了返回 null */
  function topicKind(topicId) {
    const id = String(topicId || '');
    // cnm_200..209 正比例/一次函数章；cnm_220..224 一元二次方程；cnm_229..236 二次函数章；cnm_237..242 反比例函数章
    if (/^cnm_20[0-9]$/.test(id)) return 'linear';
    if (/^cnm_2(2[0-4]|2[9]|3[0-6])$/.test(id)) return 'quadratic';
    if (/^cnm_2(3[7-9]|4[0-2])$/.test(id)) return 'inverse';
    return null;
  }

  /** 兼容旧 API：topicSupported(topicId) 是否可能是某种函数类型 */
  function topicSupported(topicId) {
    return topicKind(topicId) !== null;
  }

  /**
   * 一元二次方程章（cnm_220..224）的题面门禁：画板只在"答案就是方程的根"时才挂。
   *
   * 学生看图会把 x 轴交点（绿点）当答案 —— 答案若其实是判别式、配方常数、m/n、k 的范围，
   * 画板就与答案无关，比没画板更糟（Review 1 缺陷 7：cnm_221 由"无画板"变成"画板与答案无关"）。
   *
   * 判定是**逐题**的，不是逐章的：同一章里"答根"的题必须挂（绿点就是答案），"答别的"的题必须不挂。
   * 各章答案语义（依据 data/questions.json 实际答案，不是猜的）：
   *   cnm_220（直接开平方）：q1/q2/q3 答根，q4 答 k 的范围 → 放行，q4 由解析/门禁挡下
   *   cnm_221（配方法）：q1 答选项、q2 答配方常数、q4 答 m/n → 不放行；q3 答根 1、-7 → 逐题放行
   *   cnm_222（公式法）：q1/q2/q4 答根，q3 答无理根的选项 → 放行，无理零点由 hasCleanRoots 挡下
   *   cnm_223（根的判别式）：答判别式/根的情况/k 范围 → 整章不放行
   *   cnm_224（因式分解法）：全部答根 → 放行
   *
   * 同时要求题面里有方程语境（等号/解/根/配方……），避免把应用题里的算式当方程画；
   * 并要求题面是"解方程"形态 —— "配方成 2(x-m)²=n 的形式" 这类问的是形态参数 m/n，
   * 画板会把 n 显示成顶点纵坐标 -7（正确是 +7，方向相反），所以形态标签题统一不挂。
   */
  const EQUATION_CHAPTERS = {
    cnm_220: true,
    cnm_221: true,      // 章级放行，但下面 EQUATION_ITEM_ALLOW 之外的题一律不挂
    cnm_222: true,
    cnm_224: true
  };
  /** 章级封禁 → 只按题目 id 放行（键是 questions.json 的题 id） */
  const CHAPTERS_ITEM_ONLY = { cnm_221: true };
  const EQUATION_ITEM_ALLOW = {
    cnm_221_q3: true    // 用配方法解方程 x²+6x-7=0，答案 1、-7 == 画板绿点
  };
  const EQUATION_WORDS = /解|根|配方|方程|或|=|求\s*x|两个|交点|平方/;
  /** 形态标签题（求"配方成 … 的形式"里的 m/n），画板表达不了，直接不挂 */
  const EQUATION_FORM_LABEL = /的形式/;

  /**
   * 零点是否为"干净"的有限小数/整数。无理根（√37 之类）画板只能标近似小数，
   * 与题目要求写的精确形式对不上（cnm_222_q3 的 3x²+5x-1），因此不挂。
   */
  function hasCleanRoots(a, k) {
    if (a === 0) return true;
    const disc = -k / a;
    if (disc < 0) return true;                     // 无实根：画板只说"没有交点"，不会标数
    const r = Math.sqrt(disc);
    if (r === 0) return true;
    const roots = [r, -r];
    return roots.every(function (v) {
      const t = Math.round(v * 120) / 120;         // 1/2、3/4、5/6… 这类可标注的有理根
      return Math.abs(v - t) < 1e-9;
    });
  }

  /**
   * 方程题是否该挂画板（只在"答案就是根"的章节 + 题面确实是方程 + 根能精确标注）。
   * itemId 可选：给了就参与"章级封禁、逐题放行"的判定（cnm_221 只放 q3）。
   */
  function equationAllowed(topicId, prompt, parsed, itemId) {
    if (!EQUATION_CHAPTERS[topicId]) return false;
    if (CHAPTERS_ITEM_ONLY[topicId] && !EQUATION_ITEM_ALLOW[String(itemId || '')]) return false;
    const norm = normalize(prompt);
    if (EQUATION_FORM_LABEL.test(norm)) return false;        // "配方成 … 的形式"问的是 m/n，不是根
    if (!EQUATION_WORDS.test(norm)) return false;
    return hasCleanRoots(parsed.a, parsed.k);
  }

  /**
   * 画板要叠画的「原曲线」参数：题目给出/默认参数的那条，灰色虚线。
   *
   * 图形讲解的核心价值是让学生**直接看见**「原曲线 → 目标曲线」的变化，所以只靠解析出的
   * 目标参数（labFor 的 a/h/k）不够 —— 例如「将 y=x² 先向左平移 2，再向下平移 3」，
   * 解析出的 r 就是 a:1,h:0,k:0，只画 r 等于什么都没变。这里按题型补出原曲线：
   *
   *   linear    原曲线 = 同斜率、b=0 的过原点直线（b 的变化就是上下平移量）
   *   inverse   原曲线 = k=1 的基准双曲线（k 的变化是软件缩放）
   *   quadratic 由题面措辞定：
   *     · 题面里出现「y=x² / y＝x²」这种显式基准 → 原曲线就是它（a=1,h=0,k=0）
   *     · 「向左/向右/向上/向下平移」类题 → 默认基准 y=x²
   *     · 否则（配方/求顶点/一般式）原曲线 = 目标抛物线的对称轴与开口下的基准：
   *       a 不变、顶点 x 不变、顶点 y 拉到 y=0，即 a(x-h)² —— 只体现代数配方里的「k」
   *
   * 一律返回 null 表示「没有可对比的原曲线」→ 调用方降级为只画一条，不报错。
   */
  function baseOf(parsed, prompt) {
    if (!parsed) return null;
    const type = parsed.type || 'quadratic';
    if (type === 'linear') {
      return { type: 'linear', k: parsed.k, b: 0 };
    }
    if (type === 'inverse') {
      return { type: 'inverse', k: 1 };
    }
    const s = normalize(prompt);
    const shiftWord = /平移|向左|向右|向上|向下/.test(s);
    const explicitBase = /y\s*=\s*[+-]?\s*x²/.test(s) && !/y\s*=\s*[+-]?\s*\d/.test(s);
    if (shiftWord || explicitBase) {
      return { type: 'quadratic', a: 1, h: 0, k: 0 };
    }
    // 配方/顶点类：a 与顶点横坐标不变，顶点纵坐标拉到 y=0
    const a = parsed.a === 0 ? 1 : parsed.a;
    return { type: 'quadratic', a: a, h: parsed.h, k: 0 };
  }

  /** 组合入口：知识点支持 && 题面能解析 && 类型匹配 && 题面门禁 → 参数对象，否则 null
   *  opts.itemId 可选（题库题 id）：方程章里决定个别题是否放行（cnm_221_q3） */
  function labFor(topicId, prompt, opts) {
    const kind = topicKind(topicId);
    if (!kind) return null;
    const r = fromPrompt(prompt);
    if (!r || r.type !== kind) return null;
    // 一元二次方程章：答案必须是根，且根要能被绿点精确标出来
    if (/^cnm_22[0-4]$/.test(String(topicId)) && r.type === 'quadratic') {
      const itemId = opts && opts.itemId;
      if (!equationAllowed(String(topicId), prompt, r, itemId)) return null;
    }
    return r;
  }

  /** 挂载用的完整配置：解析出目标参数时，附带原曲线用于叠画对比 */
  function labForScene(topicId, prompt, opts) {
    const target = labFor(topicId, prompt, opts);
    if (!target) return null;
    const base = baseOf(target, prompt);
    if (!base) return target;
    return Object.assign({}, target, { base: base });
  }

  /* ============================================================ 任务一：画板能力声明（代码写死，不由 LLM 生成）
   *
   * 每个画板 declare 自己能回答什么问题（canAnswer）、需要哪些参数（params）、内部说明（note）。
   * 措辞必须精确：LLM 严格按这份清单做「该不该挂图」的判断 ——
   *   清单里没有的能力，LLM 才会干脆说 null；措辞模糊会让它硬凑或过度拒绝。
   * 匹配层（diagnose/labmatch.js）用 key 作为唯一画板名，intent 必须逐字取自 canAnswer。
   *
   * NOTE_INTENT：intent → 文案方向。文案是**代码写的**，LLM 只选 intent，不写文案。
   *   （LLM 不参与"怎么讲"，否则同一句讲解可能漂移成题目没问的意思）
   * 文案里可用的占位符：{a} {h} {k} {y} {roots} {cnt} {dir} {axis} {xMin} {xMax}……
   *   由 noteText() 用确定性数值填充（画板的 h/k 已过代回校验，数值可信）。
   */
  const CAPABILITIES = {
    /* ---- 二次函数（抛物线 a(x-h)²+k：标顶点、对称轴、零点绿点） ---- */
    'quadratic-vertex': {
      canAnswer: ['顶点坐标', '对称轴', '开口方向', '最小值', '最大值', '平移方向'],
      params: ['a', 'h', 'k'],
      note: '标准式 y=a(x-h)²+k。顶点 (h,k)。a>0 开口向上有最小值 k；a<0 开口向下有最大值 k。'
    },
    'quadratic-roots': {
      canAnswer: ['方程的根', '与x轴交点的横坐标', '零点'],
      params: ['a', 'h', 'k'],
      note: '同上标准式。与 x 轴交点满足 a(x-h)²+k=0，根为 h±√(-k/a)。'
    },
    'quadratic-inequality': {
      canAnswer: ['y>0 或 y<0 的 x 范围', 'x 取何值时函数值为正/负'],
      params: ['a', 'h', 'k'],
      note: '看图判断抛物线在 x 轴上方/下方的区间。'
    },
    'quadratic-range-on-interval': {
      canAnswer: ['在给定区间上的最大值', '在给定区间上的最小值'],
      params: ['a', 'h', 'k', 'xMin', 'xMax'],
      note: '查闭区间最值：先看顶点是否落在区间内，再比较端点。题面必须给出区间端点。'
    },
    /* ---- 一次函数（直线 y=kx+b：标 y 轴截距红点、x 轴交点绿点） ---- */
    'linear-intercepts': {
      canAnswer: ['与 y 轴交点的纵坐标', '与 x 轴交点的横坐标', '与两坐标轴交点的坐标', '直线与两坐标轴围成的三角形面积'],
      params: ['k', 'b'],
      note: '直线 y=kx+b。与 y 轴交于 (0,b)，与 x 轴交于 (-b/k,0)，两点与原点围成直角三角形。'
    },
    'linear-trend': {
      canAnswer: ['y 随 x 的增大而增大还是减小', '直线经过哪几个象限', '直线上几个点的函数值大小比较'],
      params: ['k', 'b'],
      note: '斜率 k 决定升降：k>0 直线上升（y 随 x 增大而增大），k<0 下降；k、b 的符号决定经过的象限。'
    },
    /* 刻意不声明「平移后所得直线」类能力：画板的参数只能来自题面里那条直线，
     * 而平移题的答案（平移后的解析式/截距）不在题面上 —— 挂上去只会画出平移**前**的直线，
     * 正是 KNOWN_MISMOUNT 里 cnm_204_q1 那类错。要挂得先让画板画出平移结果，属另一张卡。 */
    'linear-equation': {
      canAnswer: ['一次函数与一元一次方程的关系', '不等式 kx+b>0 或 kx+b<0 的解集'],
      params: ['k', 'b'],
      note: '直线与 x 轴交点横坐标即 kx+b=0 的解，也是 kx+b>0 / <0 解集的分界点；图象在 x 轴上方那段对应 kx+b>0。'
    },
    /* ---- 反比例函数（双曲线 y=k/x） ---- */
    'inverse-quadrants': {
      canAnswer: ['图象所在的象限', 'y 随 x 的增大而增大还是减小', '同一象限内几个点的函数值大小比较'],
      params: ['k'],
      note: 'y=k/x（k≠0）。k>0 两支在第一、三象限，k<0 在第二、四象限；每一支各自单调，两支不能连起来比较。'
    },
    'inverse-area': {
      canAnswer: ['点与坐标轴围成的矩形或三角形面积', '由面积反求 |k|'],
      params: ['k'],
      note: '点 P 在 y=k/x 上，过 P 作两坐标轴的垂线：矩形面积 = |k|，三角形（原点、P、一个垂足）面积 = |k|/2。'
    }
  };

  /** 画板名 → 参数类型（labForScene 解析出的 type 必须与之一致） */
  const CAP_TYPE = {
    'quadratic-vertex': 'quadratic',
    'quadratic-roots': 'quadratic',
    'quadratic-inequality': 'quadratic',
    'quadratic-range-on-interval': 'quadratic',
    'linear-intercepts': 'linear',
    'linear-trend': 'linear',
    'linear-equation': 'linear',
    'inverse-quadrants': 'inverse',
    'inverse-area': 'inverse'
  };

  /**
   * intent → 文案模板。按画板分档，同一 intent 在多个画板里出现时取先声明的那条。
   *
   * ★ P 卡规则 ★ 文案只许出现**题面已知量**（a、区间端点 {xMin}/{xMax}、原函数 {y}、直线的 k/b），
   * 派生量（顶点坐标、最值、对称轴位置、截距数值 {xInt}、根）一律以 ? 或引导提问出现。
   * 站位符里的 {h}/{k}/{xInt}/{absK} 在 P 卡之后**不再进任何模板** —— 它们就是答案。
   * 硬约束（验收标准 1）：讲顶点/最值的文案里绝不出现「根」字 —— 由 tests 断言锁死。
   */
  const NOTE_INTENT = {
    'quadratic-vertex': {
      '顶点坐标': '红色是抛物线的顶点，但横、纵坐标都没标：顶点是整条曲线从「往下」转为「往上」（或反过来）的那个转折点。**你能读出它的横、纵坐标是多少吗？** 图上顶点位置已标红，坐标留给你读。',
      '最小值': 'a = {a} > 0，抛物线开口向上，顶点就是整条曲线的最低点——**顶点的纵坐标是多少？** 最低点的 y 就是这个函数的最小值。图上顶点位置已标红，坐标留给你读。',
      '最大值': 'a = {a} < 0，抛物线开口向下，顶点就是整条曲线最高的那一点——**它的纵坐标是多少？** 最高点的 y 就是这个函数的最大值。图上顶点位置已标红，坐标留给你读。',
      '对称轴': '抛物线（{y2}）左右对称，对称轴穿过顶点且垂直于 x 轴。**这条直线是 x = ?** 图上把这条竖线画出来了，它落在 x 轴上的哪个数，要你自己读。',
      '开口方向': 'a = {a}：a > 0 开口向上且 a 越大开口越窄（a < 0 时开口向下，a 的绝对值越大越窄）。拖动 a 看开口怎么变。',
      '平移方向': '灰色虚线是原函数的曲线，蓝色实线是题目要的函数：橙色箭头标出平移的方向和距离。'
    },
    'quadratic-range-on-interval': {
      '在给定区间上的最大值': '{xMin} ≤ x ≤ {xMax} 这一段（阴影部分）：先看顶点的横坐标落没落在区间内，再算顶点值和两个端点值比一比，最大的那个就是最大值——**三个数分别是多少？最大的那个是多少？** 图上端点与顶点位置都已标出，数值留给你算。',
      '在给定区间上的最小值': '{xMin} ≤ x ≤ {xMax} 这一段（阴影部分）：先看顶点的横坐标落没落在区间内，再算顶点值和两个端点值比一比，最小的那个就是最小值——**三个数分别是多少？最小的那个是多少？** 图上端点与顶点位置都已标出，数值留给你算。'
    },
    'quadratic-roots': {
      '方程的根': '抛物线与 x 轴的交点（绿点）的横坐标，就是方程的两个根。**这两个横坐标分别是多少？** 图上只标了点，数值留给你读。拖动 h、k 看交点怎么移动。',
      '与x轴交点的横坐标': '抛物线与 x 轴的交点（绿点）的横坐标，就是方程的两个根。**这两个横坐标分别是多少？** 图上只标了点，数值留给你读。拖动 h、k 看交点怎么移动。',
      '零点': '抛物线与 x 轴的交点（绿点）的横坐标，就是方程的两个根。**这两个横坐标分别是多少？** 图上只标了点，数值留给你读。拖动 h、k 看交点怎么移动。'
    },
    'quadratic-inequality': {
      'y>0 或 y<0 的 x 范围': '看曲线在 x 轴上方/下方的部分：绿点是分界点，曲线在上方的那一段，对应的 x 就是 y>0 的范围。**两个分界点的横坐标是多少？** 图上只标了点，数值留给你读。',
      'x 取何值时函数值为正/负': '看曲线在 x 轴上方/下方的部分：绿点是分界点，曲线在上方的那一段，对应的 x 就是函数值为正的范围。**两个分界点的横坐标是多少？** 图上只标了点，数值留给你读。'
    },
    'linear-intercepts': {
      '与 y 轴交点的纵坐标': '红点是直线与 y 轴的交点 (0, ?)：它就在 y 轴上。**这个点的纵坐标是多少？** 拖动 b 看它上下移动，读数自己从坐标轴上看。',
      '与 x 轴交点的横坐标': '绿点是直线与 x 轴的交点 (?, 0)：令 y = 0 解 kx+b = 0 就得到它的横坐标——**把这个方程解出来是多少？** 图上只标了点，数值留给你算。拖动 k、b 看交点怎么移动。',
      '与两坐标轴交点的坐标': '红点是直线与 y 轴的交点（0, ?），绿点是直线与 x 轴的交点（?, 0）：**两组坐标各是多少？** 图上只标了点的位置，坐标留给你读。',
      '直线与两坐标轴围成的三角形面积': '红点（y 轴交点）、绿点（x 轴交点）和原点围成直角三角形：两条直角边就是两个截距的绝对值。**两个截距各是多少？面积是多少？** 数值留给你算。'
    },
    'linear-trend': {
      'y 随 x 的增大而增大还是减小': 'k = {k}：k>0 时直线从左下往右上，y 随 x 的增大而增大；k<0 时从左上往右下，y 随 x 的增大而减小。拖动 k 看方向怎么翻。',
      '直线经过哪几个象限': '看直线穿过哪几个象限：k = {k}、b = {b}，把 k、b 拖过 0 就能看到直线换象限。',
      '直线上几个点的函数值大小比较': '在同一坐标系里比高低：直线上升（k>0）时 x 越大点越高，下降（k<0）时 x 越大点越低；离对称位置越远，差距越大。'
    },
    'linear-equation': {
      '一次函数与一元一次方程的关系': '绿点是直线与 x 轴的交点：方程 kx+b=0 的解，就是函数图象与 x 轴交点的横坐标。**这个横坐标是多少？** 把 kx+b=0 解出来，再和图上绿点的位置对一对。',
      '不等式 kx+b>0 或 kx+b<0 的解集': '看直线在 x 轴上方/下方的部分：绿点的横坐标是分界点，直线在上方的那一段对应的 x 就是 kx+b>0 的解集。**这个分界点是多少？解集怎么表示？** 数值留给你算。'
    },
    'inverse-quadrants': {
      '图象所在的象限': 'k = {k}：k>0 时两支曲线在第一、三象限，k<0 时在第二、四象限，且关于原点对称。拖动 k 看它怎么翻。',
      'y 随 x 的增大而增大还是减小': '每一支各自单调：k>0 时在同一支上 x 增大 y 减小，k<0 时在同一支上 x 增大 y 增大。两支不能连起来说。',
      '同一象限内几个点的函数值大小比较': '先确认几个点是否在同一支上：同一支上按单调性比大小，跨支时先比正负（k>0 时第一象限的点都为正、第三象限的点都为负）。'
    },
    'inverse-area': {
      '点与坐标轴围成的矩形或三角形面积': '点 P 在 y = k/x 上，k = {k}：过 P 向两条坐标轴作垂线，就围出矩形和三角形。**矩形的面积是多少？三角形（原点、P、一个垂足）的面积是多少？** 用 |k| 的关系自己算，图上不标数值。',
      '由面积反求 |k|': '面积只由 |k| 决定：矩形的面积就等于 |k|，三角形（原点、P、一个垂足）的面积是矩形的一半。**反过来，由题面给的面积求出 |k| 是多少？** 再结合图象落在哪几个象限定符号。'
    }
  };

  /** intent 归一化：只做空白折叠（中文题面里 LLM 偶尔会带回空格） */
  function intentKey(intent) {
    const s = String(intent == null ? '' : intent).replace(/\s+/g, '').trim();
    return s || null;
  }

  /** 归一化后的 intent → 文案模板（不区分画板：模板本身不依赖画板，画板只决定能选哪些 intent）
   *  键必须走 intentKey()：模板名里带空格（「与 y 轴交点的纵坐标」），LLM 回的 intent 也可能带空格，
   *  两边不归一化就会出现「清单里有、模板查不到」的假缺失。 */
  const NOTE_BY_INTENT = (function () {
    const m = {};
    Object.keys(NOTE_INTENT).forEach(function (lab) {
      Object.keys(NOTE_INTENT[lab]).forEach(function (it) {
        const key = intentKey(it);
        if (key && !m[key]) m[key] = NOTE_INTENT[lab][it];
      });
    });
    return m;
  })();

  /** 讲「与 x 轴交点」的 intent（只有这些 intent 的文案才允许出现「根 / 零点」的说法） */
  const ROOT_INTENTS = ['方程的根', '与x轴交点的横坐标', '零点'];

  /** 画板 + intent 是否是可渲染的组合（capability 的 canAnswer 必须真的含这个 intent，且文案模板存在） */
  function intentSupported(lab, intent) {
    const c = CAPABILITIES[String(lab || '')];
    const it = intentKey(intent);
    if (!c || !it) return false;
    return capabilityIntents(lab).indexOf(it) >= 0 && !!NOTE_BY_INTENT[it];
  }

  /** 某画板 canAnswer 的归一化副本（「与 y 轴交点的纵坐标」→「与y轴交点的纵坐标」） */
  function capabilityIntents(lab) {
    const c = CAPABILITIES[String(lab || '')];
    return c ? c.canAnswer.map(intentKey) : [];
  }

  /** intent 是否需要「交点个数」这类事实描述（顶点/最值/面积类永远不需要） */
  function intentUsesRoots(intent) {
    return ROOT_INTENTS.indexOf(intentKey(intent)) >= 0;
  }

  /** 数值填空：{k} → 数字，未知保持原样（不猜、不留 undefined） */
  function fill(tpl, vars) {
    return String(tpl || '').replace(/\{(\w+)\}/g, function (m, name) {
      const v = vars && vars[name];
      if (v == null || v === '') return m;
      return String(v);
    });
  }

  /**
   * 由 (画板, intent, 参数) 生成画板下的教学文案 —— **纯函数**，可单测。
   * 返回 null 表示该组合不该挂图（intent 缺失/编造 → 调用方不挂）。
   * 注意：文案里讲什么由 intent 决定，与「有没有零点」无关 —— 这正是 M 卡修的 bug。
   * P 卡：只填**已知量**（a、b、k(一次)/k(反比例)、区间端点、原函数式、直线系数），
   * 派生量（顶点横纵坐标/对称轴位置/截距位置/根的数值）一律不填 —— 模板里根本不用它们。
   */
  function noteText(lab, intent, params) {
    if (!intentSupported(lab, intent)) return null;
    const p = params || {};
    const it = intentKey(intent);
    const type = CAP_TYPE[String(lab || '')] || 'quadratic';
    const xMin = p.xMin != null ? p.xMin : '-∞';
    const xMax = p.xMax != null ? p.xMax : '+∞';
    return fill(NOTE_BY_INTENT[it], {
      /* 已知量：a（二次系数）、b（一次截距）、k（一次斜率/反比例系数）—— 题面原样给出 */
      a: fmtQuad(p.a), k: fmtQuad(p.k), b: fmtQuad(p.b),
      y: formatFormula({ type: type, a: p.a, h: p.h, k: p.k, b: p.b }),
      /* 对称轴题专用：抛物线式里不能带顶点的横坐标（(x - {h})² 的 h 就是对称轴 = 答案），
       * 所以只印「开口与宽窄」（y = a·x² + …），曲线的形状照画，位置留问号。 */
      y2: type === 'quadratic'
        ? ('y = ' + (p.a === 1 ? '' : p.a === -1 ? '-' : fmtQuad(p.a)) + 'x² + …')
        : formatFormula({ type: type, a: p.a, h: p.h, k: p.k, b: p.b }),
      xMin: xMin, xMax: xMax,
      /* 以下占位符自 P 卡起禁止在模板里使用（它们是派生量 = 答案）；保留键只为兼容旧测试 */
      h: '?', xInt: '?', absK: '?', halfAbsK: '?', dir: '竖直虚线',
      axis: 'x = ?'
    });
  }

  /** 数值美化（文案里用；与渲染层 fmt 同规则，但接受 null） */
  function fmtQuad(n) {
    if (n == null || !isFinite(n)) return '?';
    return fmt(n);
  }

  /* ============================================================ 已知量 vs 派生量（P 卡）
   *
   * ★ 教学硬规则（与 geomlab D 卡同一条，用户判据）★
   * 画板的目的是让学生看懂**问题怎么解决**，不是看到答案。
   * 题面给出的量（a、区间端点 xMin/xMax、原函数表达式）照常显示真值；
   * 由它推出来的量（顶点坐标、最小值/最大值、对称轴位置、根的数值、截距坐标）
   * 一律不得静态标注 —— 那等于图替学生把题算完了。派生量只能以 '?' 占位，
   * 学生自己算完点「我算好了」填数，才逐行显示对比结果。
   *
   * 所以 annotate()/drawShift() 里读派生量必须走 deriveText()，
   * 真实数值只活在 answerRows() 的 real 字段与自检面板里，不许进画布静态标注。
   *
   * 判定（numEqual / checkAnswerRow）照搬 diagnose/geomlab.js 的 numEqual + judgeRow 口径：
   *   · 空白 → blank：只说「未作答」，既不出真值也不出 ✓/✗（不能空着就让答案露出来）
   *   · 数值等价 → right：3 / 3.0 / 3/1 都算对，等价交给 engine.js 的 numericEqual（唯一归一化出处）
   *   · 其余 → wrong：回显学生原样输入（**不回显实际值** —— 回显等于把答案送到学生的错误答案旁边）
   */

  /** 数值等价判定依赖 engine.js（node 下 require，浏览器由 index.html 的 <script> 顺序注入） */
  function numEqual(a, b) {
    const E = _engine || (typeof DiagEngine !== 'undefined' ? DiagEngine : null); // eslint-disable-line no-undef
    if (!E || typeof E.numericEqual !== 'function') return null;
    return E.numericEqual(a, b);
  }

  /** 派生量的占位符：图上只许出现这个，不许出现真值 */
  function deriveText() {
    return '?';
  }

  /** 一对派生数值 → 「(?, ?)」；pad 由调用方控制（顶点要带括号） */
  function derivePair() {
    return '(' + deriveText() + ', ' + deriveText() + ')';
  }

  /** 数值对 → 文案里的短句：3、-4 → 「3、-4」（学生按题目要求依次写横坐标、纵坐标） */
  function fmtPair(pair) {
    const arr = (pair && pair.length) ? pair : [];
    if (!arr.length) return '?';
    return arr.map(fmtQuad).join('、');
  }

  /** 参数里的区间端点（没有就 null） */
  function intervalOf(p) {
    if (!p) return null;
    if (p.xMin == null || p.xMax == null) return null;
    if (!isFinite(p.xMin) || !isFinite(p.xMax) || !(p.xMax > p.xMin)) return null;
    return { xMin: p.xMin, xMax: p.xMax };
  }

  /** 二次函数在闭区间上的最值（供自检面板核对；图上不显示） */
  function quadRangeExtrema(a, h, k, xMin, xMax) {
    const f = function (x) { return a * (x - h) * (x - h) + k; };
    const ys = [f(xMin), f(xMax)];
    if (h > xMin && h < xMax) ys.push(k);
    return { max: Math.max.apply(null, ys), min: Math.min.apply(null, ys) };
  }

  /**
   * 由 (画板, intent, 参数) 推出「这道题的答案」是什么，拆成若干数值项 —— **纯函数**，可单测。
   * 这是「图上问号 ↔ 学生答案」的对应表：图上留了几个 ? ，这里就有几项。
   *
   * 返回 [{ label, kind, values, axis? }]
   *   kind: 'scalar'（一个数）| 'pair'（两个数，按题目要求依次写）| 'interval'（两个数：先大后小）
   *   axis: 'x' 表示这组数在 x 轴上（对称轴/根），自检面板据此按 x 轴真值判定
   *
   * 参数不全（或在区间最值缺区间）→ 返回 []，调用方据此不显示输入框（绝不猜）。
   */
  function labAnswerParts(lab, intent, params) {
    const p = params || {};
    const type = CAP_TYPE[String(lab || '')];
    const it = intentKey(intent);
    if (!type) return [];
    const res = function (label, kind, values, axis) {
      const vals = (values || []).filter(function (v) { return v != null && isFinite(v); });
      if (!vals.length || vals.length !== (values || []).length) return null;
      return { label: label, kind: kind, values: vals, axis: axis || null };
    };
    if (type === 'quadratic') {
      if (!isFinite(p.a) || !isFinite(p.h) || !isFinite(p.k) || p.a === 0) return [];
      switch (it) {
        case '顶点坐标': return [res('顶点坐标（横、纵坐标）', 'pair', [p.h, p.k])];
        case '最小值': return [res('最小值', 'scalar', [p.k])];
        case '最大值': return [res('最大值', 'scalar', [p.k])];
        case '对称轴': return [res('对称轴 x =', 'scalar', [p.h], 'x')];
        case '方程的根':
        case '与x轴交点的横坐标':
        case '零点': {
          const disc = -p.k / p.a;
          if (!(disc >= 0) || disc === 0) return [];          // 无实根/重根：不是「两个根」的题
          const rt = Math.sqrt(disc);
          return [res('两个根（用、隔开）', 'pair', [p.h - rt, p.h + rt].sort(function (x, y) { return x - y; }), 'x')];
        }
        case '在给定区间上的最大值': {
          const iv = intervalOf(p);
          if (!iv) return [];
          const e = quadRangeExtrema(p.a, p.h, p.k, iv.xMin, iv.xMax);
          return [res('区间上的最大值', 'scalar', [e.max])];
        }
        case '在给定区间上的最小值': {
          const iv = intervalOf(p);
          if (!iv) return [];
          const e = quadRangeExtrema(p.a, p.h, p.k, iv.xMin, iv.xMax);
          return [res('区间上的最小值', 'scalar', [e.min])];
        }
        default: return [];                                    // 开口方向 / 不等式范围：不是数值
      }
    }
    if (type === 'linear') {
      if (!isFinite(p.k) || !isFinite(p.b)) return [];
      const xInt = p.k === 0 ? null : -p.b / p.k;
      switch (it) {
        case '与 y 轴交点的纵坐标': return [res('与 y 轴交点的纵坐标', 'scalar', [p.b])];
        case '与 x 轴交点的横坐标': return xInt == null ? [] : [res('与 x 轴交点的横坐标', 'scalar', [xInt], 'x')];
        case '与两坐标轴交点的坐标': return xInt == null ? []
          : [res('两组交点坐标（依次写 0、纵坐标、横坐标、0）', 'pair', [p.b, xInt])];
        case '直线与两坐标轴围成的三角形面积': return xInt == null ? []
          : [res('三角形面积', 'scalar', [Math.abs(p.b) * Math.abs(xInt) / 2])];
        default: return [];
      }
    }
    if (!isFinite(p.k) || p.k === 0) return [];
    const absK = Math.abs(p.k);
    switch (it) {
      case '点与坐标轴围成的矩形或三角形面积':
        return [res('矩形面积', 'scalar', [absK]), res('三角形面积', 'scalar', [absK / 2])];
      case '由面积反求 |k|': return [res('|k|', 'scalar', [absK])];
      default: return [];
    }
  }

  /**
   * 自检面板要核对的结果行 —— 学生点「我算好了」之后才显示。
   * 每行：{ label, kind, yours(恒空串，绝不预填), real(只给判定用，未作答时渲染层不得显示) }
   * 区间最值按题目要求「先最大值后最小值」合并成一行两空。
   */
  function answerRows(lab, intent, params) {
    const parts = labAnswerParts(lab, intent, params);
    const it = intentKey(intent);
    const rows = [];
    parts.forEach(function (part) {
      if (part.kind === 'pair') {
        /* 区间最值题：两个数同属「答案」，合成一行（与题库答案格式一致） */
        part.values.forEach(function (v, i) {
          rows.push({
            label: (part.label.replace(/（.*$/, '') + (part.values.length > 1 ? (i === 0 ? '（第 1 个）' : '（第 2 个）') : '')),
            kind: 'scalar', yours: '', real: v, axis: part.axis
          });
        });
      } else {
        rows.push({ label: part.label, kind: part.kind, yours: '', real: part.values[0], axis: part.axis });
      }
    });
    /* 区间最值：题目要求「先最大值后最小值」，labAnswerParts 已经是这个顺序；别处两个根也保持从小到大 */
    return rows;
  }

  /**
   * 逐行判定的对外出口（纯函数，渲染层只负责显示）。
   * 返回 { verdict: 'right'|'wrong'|'blank', shown: 面板文案, real: 是否可显示真值 }
   * 与 geomlab 的 checkOne 同口径，唯一差别：填错时不回显实际值（回显 = 把答案塞给做错的学生）。
   */
  function checkAnswerRow(row, raw) {
    if (!row || !isFinite(row.real)) return { verdict: 'wrong', shown: '✗', real: false };
    const text = String(raw == null ? '' : raw);
    const trimmed = text.trim();
    if (!trimmed) return { verdict: 'blank', shown: '未作答', real: false };
    /* 一对数值：允许「3、-4」「3,-4」「3 -4」这类写法，逐个数按同一口径比对 */
    const mine = trimmed.split(/[、,，\s]+/).filter(function (s) { return s !== ''; });
    const one = function (tok) {
      const eq = numEqual(tok, row.real);
      return eq === true || tok === fmt(row.real);
    };
    if (one(trimmed)) return { verdict: 'right', shown: '✓', real: false };
    if (mine.length === 2 && (one(mine[0]) || one(mine[1]))) {
      /* 学生把一个数写成了两个数（或多写），不判对也不替他算：按填错处理 */
      return { verdict: 'wrong', shown: '✗ 你的答案：' + trimmed, real: false };
    }
    /* eq === null 说明解析不出数值 —— 学生写的不是数，按填错处理；不回显实际值 */
    return { verdict: 'wrong', shown: '✗ 你的答案：' + trimmed, real: false };
  }

  /* ------------------------------------------------------------ 渲染（需要 DOM） */

  const TYPE_DEF = {
    quadratic: {
      sliders: [
        { key: 'a', label: 'a(开口方向和宽窄)', min: -4, max: 4, step: 0.05 },
        { key: 'h', label: 'h(左右平移)', min: -8, max: 8, step: 0.05 },
        { key: 'k', label: 'k(上下平移)', min: -8, max: 8, step: 0.05 }
      ],
      defaults: { a: 1, h: 0, k: 0 }
    },
    linear: {
      sliders: [
        { key: 'k', label: 'k(斜率,陡不陡)', min: -6, max: 6, step: 0.1 },
        { key: 'b', label: 'b(截距,和y轴交点)', min: -8, max: 8, step: 0.1 }
      ],
      defaults: { k: 1, b: 0 }
    },
    inverse: {
      sliders: [
        { key: 'k', label: 'k(正负定象限,|k| 定远近)', min: -10, max: 10, step: 0.1 }
      ],
      defaults: { k: 1 }
    }
  };

  /** 数字小数化：0 -> "0"，1.5 -> "1.5"，去掉尾零 */
  function fmt(n) {
    if (n === 0) return '0';
    const r = Math.round(n * 100) / 100;
    return String(r);
  }

  /** 美化函数式（按类型） */
  function formatFormula(p) {
    const type = p.type || 'quadratic';
    if (type === 'linear') {
      let s = 'y = ';
      let head;
      if (p.k === 1) head = 'x';
      else if (p.k === -1) head = '-x';
      else if (p.k === 0) head = '';          // 系数 0：整项消失（不显示 0x）
      else head = fmt(p.k) + 'x';
      s += head;
      if (p.b > 0) s += (head ? ' + ' : '') + fmt(p.b);
      else if (p.b < 0) s += (head ? ' - ' : '-') + fmt(-p.b);
      if (!head && p.b === 0) s += '0';        // k=0 且 b=0：不能只留 "y = "
      return s;
    }
    if (type === 'inverse') {
      const kAbs = Math.abs(p.k);
      const sign = p.k < 0 ? '-' : '';
      return 'y = ' + sign + fmt(kAbs) + ' / x';
    }
    // quadratic
    let aPart;
    if (p.a === 1) aPart = '';
    else if (p.a === -1) aPart = '-';
    else aPart = fmt(p.a);
    let xPart = 'x';
    if (p.h > 0) xPart += ' - ' + fmt(p.h);
    else if (p.h < 0) xPart += ' + ' + fmt(-p.h);
    let s;
    // h=0 时统一写 x²（不带括号）：a=4 → "y = 4x²"，a=1 → "y = x²"。
    // 修复前 h=0 且 |a|≠1 会拼出 "y = 4x²²"（aPart 与 xPart 直接相连又多一个 ²）
    if (p.h === 0) s = 'y = ' + aPart + xPart + '²';
    else s = 'y = ' + aPart + '(' + xPart + ')²';
    if (p.k > 0) s += ' + ' + fmt(p.k);
    else if (p.k < 0) s += ' - ' + fmt(-p.k);
    return s;
  }

  /** 创建画板元素。opts: {type, ...params, intent?, lab?, xMin?, xMax?} 返回 {el, reset}
   *  intent/lab（必填，由匹配层给出）：这道题问什么、用的是哪个已声明画板。
   *   - intent 属于该画板的 canAnswer → note 由 noteText() 生成，视觉重点按 intent 走
   *   - intent 缺失/不属于该画板 → **不渲染画板**（返回 null，调用方不挂图）
   *     原则：画板必须回答「题目问的那件事」，答不上来就不挂 —— 讲别的事比没画板更糟。
   */
  function mount(opts) {
    const o = opts || {};
    const type = TYPE_DEF[o.type] ? o.type : 'quadratic';
    const def = TYPE_DEF[type];
    const p = Object.assign({}, def.defaults, o);
    p.type = type;
    delete p.base;      // 原曲线配置只放进 base，不污染目标参数 p（否则滑块/公式会带上它）
    const intent = intentKey(o.intent);
    const noteLab = o.lab || null;
    // 类型必须与画板声明的类型一致，且 intent 必须在该画板的 canAnswer 里
    if (!noteLab || CAP_TYPE[noteLab] !== type) return null;
    const note0 = noteText(noteLab, intent, p);
    if (!note0) return null;
    // 确定性退化解：一次函数 k=0（水平线）、反比例 k=0 时画板画不出有效曲线，直接不挂
    if (type === 'linear' && p.k === 0) return null;
    if (type === 'inverse' && p.k === 0) return null;
    // 原曲线（题目给出/默认参数那条）：只有调用方给了才叠画，没给就降级为单曲线
    const baseRaw = (o.base && (!o.base.type || o.base.type === type)) ? o.base : null;
    const base = baseRaw ? Object.assign({}, def.defaults, baseRaw, { type: type }) : null;
    const start = {};

    const wrap = document.createElement('div');
    wrap.className = 'funclab funclab-' + type;
    const canvas = document.createElement('canvas');
    canvas.className = 'funclab-canvas';
    const info = document.createElement('div');
    info.className = 'funclab-formula';
    /* P 卡：**没拖动前**公式行不能印顶点式 —— 二次函数的顶点式 a(x - h)² + k 里，h 就是对称轴/顶点横坐标、
     * k 就是最值/顶点纵坐标，学生不点「我算好了」就能直接读到答案。初始只印题面已知的「开口与宽窄」
     * （y = 2x² + …，a 是题面给的），拖动后画布才与顶点式对应，那时学生已在主动探索，再显示实时式。
     * 一次/反比例的 k、b 是题面原样给出的，本来就该印，不受影响。 */
    /* ---- P 卡：派生量的显示开关（声明必须在 formulaText 首次调用之前，否则 TDZ） ----
     * shown = false（默认）：画布上的派生量（顶点坐标/最值/对称轴位置/交点坐标/端点函数值）
     *                       一律画成 ?，学生点「我算好了」并填对那一行后，才把真值画上去。
     * moved = true（拖过滑块）：画布的 p 已经不是题面那条曲线，静态真值会与曲线对不上，
     *                       所以文案追加一句提醒，让学生按当前曲线重新量。
     * 真实的派生数值只活在 answerRows() 与自检面板的闭包 rows 里，从不进 note 文案。 */
    let shown = false;
    let moved = false;

    function formulaText() {
      if (type === 'quadratic' && !moved) {
        return 'y = ' + (p.a === 1 ? '' : p.a === -1 ? '-' : fmtQuad(p.a)) + 'x² + …（拖动滑块看它变成哪条抛物线）';
      }
      return formatFormula(p);
    }
    info.textContent = formulaText();
    const note = document.createElement('div');
    note.className = 'funclab-note';
    if (note0) note.textContent = note0;      // 二次函数：intent 驱动的文案（见 noteText）

    const ctrl = document.createElement('div');
    ctrl.className = 'funclab-sliders';
    const sliders = {};
    const sliderVals = {};      // P 卡：滑块读数 span（没拖动时显示 ?）
    def.sliders.forEach(function (sd) {
      start[sd.key] = p[sd.key];
      const row = document.createElement('label');
      row.className = 'funclab-slider';
      row.appendChild(document.createTextNode(sd.label + ' = '));
      const val = document.createElement('span');
      /* P 卡：滑块读数在「没动过」时不显示真值 —— h 的读数就是顶点横坐标、k 的读数就是顶点纵坐标，
       * 一上来就印出来等于把顶点坐标放在画板下面（学生不用读图）。
       * 学生主动拖动时才是探索（待定细节的 B 方案）：拖动后实时显示，边上文案同时提醒
       * 「曲线已不是题面那条」，两者对得上。 */
      val.textContent = '?';
      const input = document.createElement('input');
      input.type = 'range';
      input.min = sd.min; input.max = sd.max; input.step = sd.step;
      input.value = p[sd.key];
      input.addEventListener('input', function () {
        p[sd.key] = parseFloat(input.value);
        val.textContent = fmt(p[sd.key]);
        info.textContent = formatFormula(p);
        moved = true;                 // 曲线已不是题面那条：文案要提醒，图上真值不再适用
        note.textContent = noteTextOf();
        syncCheck();                  // 参数变了 → 清掉旧作答，避免拿旧答案判新曲线
        draw();
      });
      row.appendChild(val);
      row.appendChild(input);
      sliders[sd.key] = input;
      sliderVals[sd.key] = val;
      ctrl.appendChild(row);
    });
    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'small';
    resetBtn.textContent = '回到题目参数';
    resetBtn.addEventListener('click', function () {
      Object.keys(start).forEach(function (k) {
        p[k] = start[k];
        sliders[k].value = start[k];
        sliders[k].dispatchEvent(new Event('input'));
      });
      /* 回到题目参数 → 读数重新变回 ?（又是「题面那条曲线」，值要学生自己算） */
      Object.keys(sliderVals).forEach(function (k) { sliderVals[k].textContent = '?'; });
      moved = false;
      note.textContent = noteTextOf();
      syncCheck();
      draw();
    });
    ctrl.appendChild(resetBtn);

    wrap.appendChild(info);
    wrap.appendChild(note);
    wrap.appendChild(canvas);
    wrap.appendChild(ctrl);

    const dpr = (typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1) || 1;
    const ctx = canvas.getContext('2d');
    let lastRoots = -1;   // 拖动滑块后交点个数的变化只在讲根的题上体现在文案里

    /* shown / moved 已在 formulaText 之前声明（P 卡：避免 TDZ） */
    let syncCheck = function () {};

    /** 世界坐标 → 屏幕坐标。二次以顶点为中心；一次/反比例固定窗口含坐标轴。 */
    function view() {
      let xMin, xMax, yMin, yMax;
      if (type === 'quadratic') {
        // 叠画原曲线时，视野要同时容下两个顶点（顶点 + 各自 ±4 的纵向窗口），
        // 否则原曲线整个跑出画布，对比就白做了。
        const refs = [{ h: p.h, k: p.k }];
        if (base) refs.push({ h: base.h, k: base.k });
        let hMin = p.h, hMax = p.h, kMin = p.k, kMax = p.k;
        refs.forEach(function (r) {
          hMin = Math.min(hMin, r.h); hMax = Math.max(hMax, r.h);
          kMin = Math.min(kMin, r.k); kMax = Math.max(kMax, r.k);
        });
        xMin = hMin - 6; xMax = hMax + 6;
        // 区间最值画板：视野必须容下整个区间，否则 xMin/xMax 竖线跑到画布外就白画了
        if (p.xMin != null && p.xMax != null && isFinite(p.xMin) && isFinite(p.xMax) && p.xMax > p.xMin) {
          xMin = Math.min(xMin, p.xMin - 1);
          xMax = Math.max(xMax, p.xMax + 1);
        }
        yMin = kMin - 4; yMax = kMax + 4;
        if (yMin > 0) yMin = 0;
        if (yMax < 0) yMax = 0;
        if (yMax - yMin < 6) {
          const mid = (yMin + yMax) / 2;
          yMin = mid - 3; yMax = mid + 3;
          if (yMin > 0) yMin = 0; else if (yMax < 0) yMax = 0;
        }
      } else {
        xMin = -8; xMax = 8; yMin = -8; yMax = 8;
      }
      const w = canvas.clientWidth || 560, hpx = canvas.clientHeight || 320;
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(hpx * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return { w: w, hp: hpx, xMin: xMin, xMax: xMax, yMin: yMin, yMax: yMax };
    }
    function sx(v, w) { return (v.x - w.xMin) / (w.xMax - w.xMin) * w.w; }
    function sy(v, w) { return (w.yMax - v.y) / (w.yMax - w.yMin) * w.hp; }
    /** 求值：不传 pp 就用当前目标参数 p（滑块控制的那条） */
    function fAt(pp, x) {
      const q = pp || p;
      if (type === 'linear') return q.k * x + q.b;
      if (type === 'inverse') return q.k / x;
      return q.a * (x - q.h) * (x - q.h) + q.k;
    }

    function gridAndAxes(w) {
      ctx.strokeStyle = 'rgba(0,0,0,.08)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let gx = Math.ceil(w.xMin); gx <= w.xMax; gx++) {
        const X = sx({ x: gx }, w);
        ctx.moveTo(X, 0); ctx.lineTo(X, w.hp);
      }
      for (let gy = Math.ceil(w.yMin); gy <= w.yMax; gy++) {
        const Y = sy({ y: gy }, w);
        ctx.moveTo(0, Y); ctx.lineTo(w.w, Y);
      }
      ctx.stroke();
      ctx.strokeStyle = 'rgba(0,0,0,.5)';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      const Y0 = sy({ y: 0 }, w), X0 = sx({ x: 0 }, w);
      if (Y0 >= 0 && Y0 <= w.hp) { ctx.moveTo(0, Y0); ctx.lineTo(w.w, Y0); }
      if (X0 >= 0 && X0 <= w.w) { ctx.moveTo(X0, 0); ctx.lineTo(X0, w.hp); }
      ctx.stroke();
      ctx.fillStyle = '#000';
      ctx.font = '11px sans-serif';
      for (let gx = Math.ceil(w.xMin); gx <= w.xMax; gx++) {
        if (gx === 0) continue;
        ctx.fillText(String(gx), sx({ x: gx }, w) + 3, Y0 + 14);
      }
      for (let gy = Math.ceil(w.yMin); gy <= w.yMax; gy++) {
        if (gy === 0) continue;
        ctx.fillText(String(gy), X0 + 4, sy({ y: gy }, w) - 3);
      }
    }

    /** 画多项式曲线（一次/二次直线段采样；反比例跳过 x=0 断点）
     *  opts: { color, width, dash, params } —— 不传 params 就画当前目标曲线 */
    function plotCurve(w, xFrom, xTo, opts) {
      const oc = opts || {};
      ctx.save();
      ctx.strokeStyle = oc.color || '#2a7de1';
      ctx.lineWidth = oc.width == null ? 2.4 : oc.width;
      ctx.setLineDash(oc.dash || []);
      ctx.beginPath();
      let first = true;
      const N = 240;
      const pp = oc.params || p;
      for (let i = 0; i <= N; i++) {
        const x = xFrom + (xTo - xFrom) * i / N;
        const y = fAt(pp, x);
        if (!isFinite(y)) { first = true; continue; }
        const X = sx({ x: x }, w), Y = sy({ y: y }, w);
        if (Y < -2000 || Y > w.hp + 2000) { first = true; continue; }
        if (first) { ctx.moveTo(X, Y); first = false; } else ctx.lineTo(X, Y);
      }
      ctx.stroke();
      ctx.restore();
    }
    /** 按给定参数画整条曲线（反比例画两支） */
    function plotShape(w, pp, opts) {
      const oc = Object.assign({}, opts, { params: pp });
      if (type === 'inverse') {
        const EPS = 0.02;
        plotCurve(w, w.xMin, -EPS, oc);
        plotCurve(w, EPS, w.xMax, oc);
      } else {
        plotCurve(w, w.xMin, w.xMax, oc);
      }
    }
    /** 区间最值：标出 xMin/xMax 两条竖线与端点值（只在 range-on-interval 画板 + 区间有效时画） */
    function drawInterval(w) {
      const xa = p.xMin, xb = p.xMax;
      if (xa == null || xb == null || !isFinite(xa) || !isFinite(xb) || !(xb > xa)) return;
      const XA = sx({ x: xa }, w), XB = sx({ x: xb }, w);
      const left = Math.max(Math.min(XA, XB), 0), right = Math.min(Math.max(XA, XB), w.w);
      if (right <= left) return;
      ctx.save();
      // 区间着色：只弱化提示「这一段在考虑范围内」，不抢曲线的视觉
      ctx.fillStyle = 'rgba(230,126,34,.10)';
      ctx.fillRect(left, 0, right - left, w.hp);
      ctx.strokeStyle = 'rgba(230,126,34,.75)';
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      [XA, XB].forEach(function (X) { if (X >= 0 && X <= w.w) { ctx.moveTo(X, 0); ctx.lineTo(X, w.hp); } });
      ctx.stroke();
      ctx.setLineDash([]);
      // 端点：x 坐标是题面给的区间端点（已知量，照常显示），函数值要自己代入算（派生量 → ?）
      ctx.font = 'bold 11px sans-serif';
      [[xa, 'x=' + fmt(xa)], [xb, 'x=' + fmt(xb)]].forEach(function (pair) {
        const x = pair[0];
        const X = sx({ x: x }, w), Y = sy({ y: fAt(p, x) }, w);
        if (X < 0 || X > w.w || Y < 0 || Y > w.hp) return;
        ctx.fillStyle = '#e67e22';
        ctx.beginPath(); ctx.arc(X, Y, 3.5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#b35c00';
        ctx.fillText(pair[1] + ' → ' + (shown ? fmt(fAt(p, x)) : deriveText()),
          Math.min(Math.max(X + 6, 2), w.w - 60), Math.max(Y - 7, 12));
      });
      ctx.restore();
    }

    /** 这个 intent 要靠「提到根」来讲吗（只有根/零点/交点类才是）；顶点/最值类永远不提根 */
    function rootsIntent() {
      return intentUsesRoots(intent);
    }
    /** 区间最值画板：画区间标线 */
    function intervalIntent() {
      return !!(noteLab === 'quadratic-range-on-interval' || intent === '在给定区间上的最大值' || intent === '在给定区间上的最小值');
    }

    /** 类型相关标注 + 教学说明（二次函数的说明文案由 intent 决定，见 noteText） */
    function annotate(w) {
      if (type === 'quadratic') {
        // 对称轴虚线：一直都在（它是抛物线的固有结构），讲「对称轴」时改成粗实线强调
        const axisIntent = intent === '对称轴';
        {
          ctx.save();
          ctx.strokeStyle = axisIntent ? 'rgba(52,73,94,.85)' : 'rgba(120,120,120,.55)';
          ctx.lineWidth = axisIntent ? 1.8 : 1;
          ctx.setLineDash(axisIntent ? [] : [5, 4]);
          ctx.beginPath();
          const HX = sx({ x: p.h }, w);
          if (HX >= 0 && HX <= w.w) { ctx.moveTo(HX, 0); ctx.lineTo(HX, w.hp); }
          ctx.stroke();
          ctx.restore();
        }
        // 顶点：讲顶点/最值/对称轴/开口时高亮（大号红点 + 十字准线），其余保持小点
        const vertIntent = intent === '顶点坐标' || intent === '最小值' || intent === '最大值' ||
          intent === '对称轴' || intent === '开口方向';
        const VX = sx({ x: p.h }, w), VY = sy({ y: p.k }, w);
        if (vertIntent && VX >= 0 && VX <= w.w && VY >= 0 && VY <= w.hp) {
          ctx.save();
          ctx.strokeStyle = 'rgba(192,57,43,.45)';
          ctx.lineWidth = 1;
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.moveTo(0, VY); ctx.lineTo(w.w, VY);          // 水平准线：y = k
          ctx.moveTo(VX, VY); ctx.lineTo(VX, w.hp);
          ctx.stroke();
          ctx.restore();
        }
        ctx.fillStyle = '#c0392b';
        ctx.beginPath(); ctx.arc(VX, VY, vertIntent ? 6 : 4.5, 0, Math.PI * 2); ctx.fill();
        /* 顶点坐标是派生量（答案）：位置照画，数值留问号；学生点「我算好了」答对后才画真值 */
        ctx.fillText(shown ? '(' + fmt(p.h) + ', ' + fmt(p.k) + ')' : derivePair(), VX + 8, VY - 8);
        // 对称轴位置同样是派生量：讲对称轴的题把线画粗强调，但轴上不写 x = h
        if (intent === '对称轴') {
          ctx.save();
          ctx.font = 'bold 11px sans-serif';
          ctx.fillStyle = '#34495e';
          const HX0 = sx({ x: p.h }, w);
          ctx.fillText('对称轴 ' + (shown ? 'x = ' + fmt(p.h) : 'x = ' + deriveText()),
            Math.min(Math.max(HX0 + 6, 4), w.w - 80), 14);
          ctx.restore();
        }
        // 最值题再加一行「最小值/最大值 = ?」的提示（数值是答案，学生自己算）
        if (intent === '最小值' || intent === '最大值') {
          ctx.save();
          ctx.font = 'bold 12px sans-serif';
          ctx.fillStyle = '#b03a2e';
          const label = (intent === '最小值' ? '最小值' : '最大值') + ' = '
            + (shown ? fmt(p.k) : deriveText());
          ctx.fillText(label, Math.min(Math.max(VX + 8, 4), w.w - 90), Math.max(VY + 16, 14));
          ctx.restore();
        }
        // 零点（绿点）：只画点，**文案不在这里决定** —— 问顶点的题上不能出现「就是方程的两个根」
        // P 卡：交点坐标是派生量，标位置 + (?, 0)；学生答对后再画真值
        const disc = -p.k / p.a;
        if (p.a !== 0 && disc >= 0) {
          const r = Math.sqrt(disc);
          [p.h - r, p.h + r].forEach(function (x) {
            const X = sx({ x: x }, w), Y = sy({ y: 0 }, w);
            if (X < 0 || X > w.w) return;
            ctx.fillStyle = '#2ecc71';
            ctx.beginPath(); ctx.arc(X, Y, 4, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = '#1e8449';
            ctx.font = 'bold 11px sans-serif';
            ctx.fillText(shown ? '(' + fmt(x) + ', 0)' : '(?, 0)',
              Math.min(Math.max(X + 6, 2), w.w - 46), Math.min(Math.max(Y + 16, 12), w.hp - 4));
          });
        }
        if (intervalIntent()) drawInterval(w);
        // 文案已在 mount 时按 intent 生成；这里只处理拖动滑块后「交点个数」的事实描述变化
        // —— 仍然只在讲根/零点时才提根，讲顶点/最值的题永远不提。
        if (rootsIntent()) {
          const roots = (p.a === 0 || disc < 0) ? 0 : (disc === 0 ? 1 : 2);
          if (roots !== lastRoots) {
            lastRoots = roots;
            const base = noteText(noteLab, intent, p);
            if (base) {
              const fact = roots === 2 ? '（当前参数下有两个交点）'
                : roots === 1 ? '（当前参数下恰好相切，两个相等的根）'
                  : '（当前参数下没有交点，方程无实数根）';
              note.textContent = base + fact;
            }
          }
        }
      } else if (type === 'linear') {
        // 与 y 轴交点 (0,b) 红点；与 x 轴交点 (-b/k, 0) 绿点
        // 文案不在这里写 —— 由 mount 时按 intent 生成（讲截距/面积/解集的题不能都被写成「方程的解」）
        // P 卡：两点的坐标都是派生量（答案），位置照画、数值留问号。只有「一次函数与一元一次方程的关系」
        // 里 b、k 是题面已知量，仍不直接写坐标 —— 让学生自己从 kx+b=0 读出来。
        const BY = sy({ y: p.b }, w), BX = sx({ x: 0 }, w);
        ctx.fillStyle = '#c0392b';
        ctx.beginPath(); ctx.arc(BX, BY, 4.5, 0, Math.PI * 2); ctx.fill();
        ctx.fillText(shown ? '(0, ' + fmt(p.b) + ')' : '(0, ?)', BX + 8, BY - 8);
        if (p.k !== 0) {
          const xInt = -p.b / p.k;
          const IX = sx({ x: xInt }, w), IY = sy({ y: 0 }, w);
          ctx.fillStyle = '#2ecc71';
          ctx.beginPath(); ctx.arc(IX, IY, 4.5, 0, Math.PI * 2); ctx.fill();
          ctx.fillText(shown ? '(' + fmt(xInt) + ', 0)' : '(?, 0)', IX + 8, IY + 14);
        }
      } else {
        // inverse：双曲线两支 + 渐近线虚线（文案同样由 intent 生成）
      }
    }

    /** 顶点/基准点：平移向量从它指向目标顶点 */
    function anchorOf(pp) {
      if (type === 'linear') return { x: 0, y: pp.b };
      if (type === 'inverse') return { x: pp.k >= 0 ? 1 : -1, y: pp.k >= 0 ? pp.k : -pp.k };
      return { x: pp.h, y: pp.k };
    }
    /** 带箭头的平移向量 + 位移量标注（「←2, ↓3」），数值由两顶点坐标差算出 */
    function drawShift(w, from, to) {
      const dx = to.x - from.x, dy = to.y - from.y;
      if (!isFinite(dx) || !isFinite(dy)) return;
      if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return;    // 没有位移就不画箭头
      const X1 = sx(from, w), Y1 = sy(from, w), X2 = sx(to, w), Y2 = sy(to, w);
      const ang = Math.atan2(Y2 - Y1, X2 - X1);
      const head = 10;
      const tipX = X2 - Math.cos(ang) * 6, tipY = Y2 - Math.sin(ang) * 6;
      ctx.save();
      ctx.strokeStyle = '#e67e22';
      ctx.fillStyle = '#e67e22';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(X1, Y1);
      ctx.lineTo(tipX, tipY);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(X2 - Math.cos(ang) * 6, Y2 - Math.sin(ang) * 6);
      ctx.lineTo(X2 - Math.cos(ang - 0.4) * (head + 6), Y2 - Math.sin(ang - 0.4) * (head + 6));
      ctx.lineTo(X2 - Math.cos(ang + 0.4) * (head + 6), Y2 - Math.sin(ang + 0.4) * (head + 6));
      ctx.closePath();
      ctx.fill();
      // 位移量标注：x 方向 "←2 / →2"，y 方向 "↓3 / ↑3"（屏幕 y 向下为正，所以 y 减用 ↓）
      // P 卡：平移量是从题面「向左/向下平移几格」读出的已知量（题型由措辞识别，不是算出来的），
      // 学生对过箭头方向后仍按原值显示 —— 拖动滑块改变位移时才改成 ?（那时已是学生在自己试）
      const parts = [];
      if (Math.abs(dx) >= 1e-9) parts.push((dx < 0 ? '←' : '→') + (shown ? fmt(Math.abs(dx)) : deriveText()));
      if (Math.abs(dy) >= 1e-9) parts.push((dy < 0 ? '↓' : '↑') + (shown ? fmt(Math.abs(dy)) : deriveText()));
      const label = parts.join(', ');
      const mx = (X1 + X2) / 2, my = (Y1 + Y2) / 2;
      ctx.font = 'bold 12px sans-serif';
      const tw = ctx.measureText(label).width;
      const lx = Math.min(Math.max(mx + 8, 4), w.w - tw - 10);
      const ly = Math.max(my - 8, 14);
      ctx.fillStyle = 'rgba(255,255,255,.88)';
      ctx.fillRect(lx - 4, ly - 12, tw + 8, 17);
      ctx.fillStyle = '#b35c00';
      ctx.fillText(label, lx, ly);
      ctx.restore();
    }

    function draw() {
      const w = view();
      ctx.clearRect(0, 0, w.w, w.hp);
      gridAndAxes(w);
      if (type === 'inverse') {
        // 渐近线虚线（坐标轴本就实线，这里补 x=0 竖虚线警示）
        ctx.save();
        ctx.strokeStyle = 'rgba(120,120,120,.5)';
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        const X0 = sx({ x: 0 }, w);
        if (X0 >= 0 && X0 <= w.w) { ctx.moveTo(X0, 0); ctx.lineTo(X0, w.hp); }
        ctx.stroke();
        ctx.restore();
      }
      // 原曲线先画（灰色细虚线），目标曲线压在上面（实线主色）—— 变化关系一眼看见
      if (base) plotShape(w, base, { color: 'rgba(120,120,120,.85)', width: 1.6, dash: [6, 5] });
      plotShape(w, p, { color: '#2a7de1', width: 2.4 });
      annotate(w);
      if (base) drawShift(w, anchorOf(base), anchorOf(p));
    }

    /* ---------------- 自检面板（「我算好了」才显形） ----------------
     * 静态标注全留 ?，学生需要一个对答案的地方，否则不知道自己对错。折中：
     * 默认只有按钮；点它才给每项一个输入框让他填自己算的数，边填边逐行判定 ——
     * 没填的行永远只说「未作答」，不出真值（空着就能看到答案 = 又变成给答案）。
     * 填对的那一行才把真值画到图上（那已经是他自己算出来的）。
     * 判定口径与 geomlab D2 卡一致（checkAnswerRow → engine.numericEqual）。
     */
    function noteTextOf() {
      const baseNote = note0 || '';
      const tail = '（参数已改动：图上曲线已经不是题面那条，问号请按当前曲线重新量。）';
      return moved ? baseNote + tail : baseNote;
    }

    function buildCheck() {
      const box = document.createElement('div');
      box.className = 'funclab-check';
      box.hidden = true;                       // 没有可核对的数值（如开口方向/选项题）就整块不显示
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'small funclab-check-btn';
      btn.textContent = '我算好了，对答案';
      const out = document.createElement('div');
      out.className = 'funclab-check-out';
      out.hidden = true;
      /* 本次展开对应的结果行；真实值只活在这里与 answerRows()，不进 DOM 文本 */
      let rows = [];
      const inputsOf = function () { return Array.prototype.slice.call(out.querySelectorAll('input.funclab-check-ans')); };
      function judgeLine(row, input, res) {
        const v = checkAnswerRow(row, input.value);
        res.className = 'funclab-check-res ' + (
          v.verdict === 'right' ? 'is-ok' : v.verdict === 'wrong' ? 'is-no' : 'is-empty'
        );
        res.textContent = v.shown;
      }
      function judgeAll() {
        const ins = inputsOf();
        rows.forEach(function (r, i) { if (ins[i]) judgeLine(r, ins[i], out.querySelectorAll('.funclab-check-res')[i]); });
        syncShown();
        draw();
      }
      /* 只有「这份答案里没有任何一个未作答」时才把真值画到图上 —— 否则等于在学生还没算的时候先给一半答案 */
      function syncShown() {
        const ins = inputsOf();
        if (!ins.length || !rows.length) { shown = false; return; }
        const allDone = ins.every(function (input) {
          return String(input.value || '').trim() !== '';
        });
        shown = allDone && ins.every(function (input, i) {
          return checkAnswerRow(rows[i], input.value).verdict === 'right';
        });
      }
      syncCheck = function () {
        /* 参数变了（拖动滑块）→ 清空面板，避免拿旧答案判新曲线 */
        if (out.hidden) return;
        out.textContent = '';
        out.hidden = true;
        btn.textContent = '我算好了，对答案';
        shown = false;
      };
      btn.addEventListener('click', function () {
        const list = answerRows(noteLab, intent, p);
        rows = list;
        /* 面板已经展开时，点按钮是「用我填的数重新核对」，不能清空重建 ——
         * 那样学生刚填的答案会被冲掉，判定永远读到空值（表现为一直「未作答」）。
         * 只有首次展开（或答案行数量变了）才重建输入框。 */
        const existing = inputsOf();
        if (!out.hidden && existing.length && existing.length === list.length) {
          judgeAll();
          return;
        }
        out.textContent = '';
        if (!list.length) {
          out.textContent = '这类图没有可核对的数值答案。';
          out.hidden = false;
          return;
        }
        list.forEach(function (r, i) {
          const line = document.createElement('div');
          line.className = 'funclab-check-row';
          const name = document.createElement('span');
          name.className = 'funclab-check-name';
          name.textContent = r.label + (/[=：]$/.test(r.label) ? ' ' : '：');
          const input = document.createElement('input');
          input.type = 'text';
          input.inputMode = 'decimal';
          input.autocomplete = 'off';
          input.className = 'funclab-check-ans';
          input.value = '';                    // 绝不预填真值
          input.setAttribute('aria-label', '我算的 ' + r.label);
          input.dataset.idx = String(i);
          const res = document.createElement('span');
          res.className = 'funclab-check-res is-empty';
          res.textContent = '未作答';
          line.appendChild(name);
          line.appendChild(input);
          line.appendChild(res);
          out.appendChild(line);
          input.addEventListener('input', function () { judgeLine(r, input, res); syncShown(); draw(); });
          input.addEventListener('keydown', function (ev) {
            if (ev.key === 'Enter') { ev.preventDefault(); judgeAll(); }
          });
        });
        out.hidden = false;
        btn.textContent = '重新核对';
        const first = out.querySelector('input.funclab-check-ans');
        if (first) first.focus();
      });
      box.appendChild(btn);
      box.appendChild(out);
      return box;
    }

    /* 自检面板里「这道题要核对什么」先按初始参数算一遍 —— 没有数值答案就整块不显示 */
    if (answerRows(noteLab, intent, p).length) {
      const chk = buildCheck();
      chk.hidden = false;
      wrap.appendChild(chk);
    }

    // 首次绘制（canvas 可能尚未布局,ResizeObserver 会补一次）
    draw();
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(function () { draw(); });
      ro.observe(canvas);
      wrap._funclabRo = ro;
    }
    // 实例引用挂到元素上，便于浏览器侧排查/验收读取画板状态（不新增全局变量）
    const inst = {
      el: wrap,
      /* 供测试/排查读取当前画板状态（纯数据，不依赖 DOM） */
      state: function () {
        return {
          type: type,
          lab: noteLab,
          intent: intent,
          note: note.textContent,
          params: Object.assign({}, p),
          /* P 卡：派生量是否已显示真值（只有学生点「我算好了」且全部答对才为 true）。
           * 这里刻意不暴露真实答案 —— 画板实例挂在 dom 上（wrap._funclab），学生 F12 就能读到，
           * 答案必须在答题前不进 DOM/实例状态。 */
          shown: shown,
          base: base ? Object.assign({}, base) : null,
          curves: base ? 2 : 1,
          shift: type === 'quadratic' ? (base ? { dx: p.h - base.h, dy: p.k - base.k } : null)
            : type === 'linear' ? (base ? { dx: 0, dy: p.b - base.b } : null)
              : null,
          focus: {
            vertex: type === 'quadratic' && (intent === '顶点坐标' || intent === '最小值' || intent === '最大值' || intent === '对称轴' || intent === '开口方向'),
            axis: type === 'quadratic' && (intent === '对称轴' || intent === '顶点坐标' || intent === '开口方向'),
            interval: type === 'quadratic' && intervalIntent() && p.xMin != null && p.xMax != null,
            roots: type === 'quadratic' && rootsIntent(),
            /* 一次函数：标出的两个截距 / 反比例：标出象限说明 */
            intercepts: type === 'linear',
            quadrants: type === 'inverse'
          }
        };
      },
      clear: function () {
        if (wrap._funclabRo) wrap._funclabRo.disconnect();
        wrap.remove();
      }
    };
    wrap._funclab = inst;
    return inst;
  }

  return {
    fromPrompt: fromPrompt, topicSupported: topicSupported, topicKind: topicKind,
    labFor: labFor, labForScene: labForScene, baseOf: baseOf, mount: mount, formatFormula: formatFormula,
    /* 任务一：能力清单 + intent 文案（匹配层/审计脚本/测试的唯一来源） */
    CAPABILITIES: CAPABILITIES, CAP_TYPE: CAP_TYPE, NOTE_BY_INTENT: NOTE_BY_INTENT,
    intentKey: intentKey, intentSupported: intentSupported, intentUsesRoots: intentUsesRoots,
    capabilityIntents: capabilityIntents,
    noteText: noteText, ROOT_INTENTS: ROOT_INTENTS.slice(),
    /* P 卡：已知量/派生量分层 + 自检判定（纯函数，供测试与审计脚本复用） */
    labAnswerParts: labAnswerParts, answerRows: answerRows, checkAnswerRow: checkAnswerRow,
    numEqual: numEqual, deriveText: deriveText, derivePair: derivePair,
    quadRangeExtrema: quadRangeExtrema, fmtPair: fmtPair, fmtQuad: fmtQuad,
    /** 某类画板（quadratic/linear/inverse）的能力清单子集（匹配层只喂相关画板，减少 LLM 误选） */
    capabilitiesFor: function (type) {
      const out = {};
      Object.keys(CAPABILITIES).forEach(function (name) {
        if (CAP_TYPE[name] === type) out[name] = CAPABILITIES[name];
      });
      return out;
    }
  };
});