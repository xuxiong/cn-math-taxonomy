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

    // 2/3) 一般式 & 方程：提取 ax²+bx+c（可缺 bx 项；可能接 =0 或 = 某数）。
    // x² 前不允许是字母/括号（如 (m-2)x² 是含参概念题）
    m = s.match(/(?<![a-zA-Z)）])([+-]?\s*\d*\.?\d*)?\s*x²\s*(?:([+-]\s*\d*\.?\d*)\s*x\s*)?([+-]\s*\d*\.?\d*)?/);
    if (!m) return null;
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

  /* ------------------------------------------------------------ 渲染（需要 DOM） */

  const TYPE_DEF = {
    quadratic: {
      sliders: [
        { key: 'a', label: 'a(开口方向和宽窄)', min: -4, max: 4, step: 0.05 },
        { key: 'h', label: 'h(左右平移,顶点x)', min: -8, max: 8, step: 0.05 },
        { key: 'k', label: 'k(上下平移,顶点y)', min: -8, max: 8, step: 0.05 }
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

  /** 创建画板元素。opts: {type, ...params} 返回 {el, reset} */
  function mount(opts) {
    const o = opts || {};
    const type = TYPE_DEF[o.type] ? o.type : 'quadratic';
    const def = TYPE_DEF[type];
    const p = Object.assign({}, def.defaults, o);
    p.type = type;
    const start = {};

    const wrap = document.createElement('div');
    wrap.className = 'funclab funclab-' + type;
    const canvas = document.createElement('canvas');
    canvas.className = 'funclab-canvas';
    const info = document.createElement('div');
    info.className = 'funclab-formula';
    info.textContent = formatFormula(p);
    const note = document.createElement('div');
    note.className = 'funclab-note';

    const ctrl = document.createElement('div');
    ctrl.className = 'funclab-sliders';
    const sliders = {};
    def.sliders.forEach(function (sd) {
      start[sd.key] = p[sd.key];
      const row = document.createElement('label');
      row.className = 'funclab-slider';
      row.appendChild(document.createTextNode(sd.label + ' = '));
      const val = document.createElement('span');
      val.textContent = fmt(p[sd.key]);
      const input = document.createElement('input');
      input.type = 'range';
      input.min = sd.min; input.max = sd.max; input.step = sd.step;
      input.value = p[sd.key];
      input.addEventListener('input', function () {
        p[sd.key] = parseFloat(input.value);
        val.textContent = fmt(p[sd.key]);
        info.textContent = formatFormula(p);
        draw();
      });
      row.appendChild(val);
      row.appendChild(input);
      sliders[sd.key] = input;
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
    });
    ctrl.appendChild(resetBtn);

    wrap.appendChild(info);
    wrap.appendChild(note);
    wrap.appendChild(canvas);
    wrap.appendChild(ctrl);

    const dpr = (typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1) || 1;
    const ctx = canvas.getContext('2d');

    /** 世界坐标 → 屏幕坐标。二次以顶点为中心；一次/反比例固定窗口含坐标轴。 */
    function view() {
      let xMin, xMax, yMin, yMax;
      if (type === 'quadratic') {
        xMin = p.h - 6; xMax = p.h + 6;
        yMin = p.k - 4; yMax = p.k + 4;
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
    function f(x) {
      if (type === 'linear') return p.k * x + p.b;
      if (type === 'inverse') return p.k / x;
      return p.a * (x - p.h) * (x - p.h) + p.k;
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

    /** 画多项式曲线（一次/二次直线段采样；反比例跳过 x=0 断点） */
    function plotCurve(w, xFrom, xTo) {
      ctx.strokeStyle = '#2a7de1';
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      let first = true;
      const N = 240;
      for (let i = 0; i <= N; i++) {
        const x = xFrom + (xTo - xFrom) * i / N;
        const y = f(x);
        if (!isFinite(y)) { first = true; continue; }
        const X = sx({ x: x }, w), Y = sy({ y: y }, w);
        if (Y < -2000 || Y > w.hp + 2000) { first = true; continue; }
        if (first) { ctx.moveTo(X, Y); first = false; } else ctx.lineTo(X, Y);
      }
      ctx.stroke();
    }
    function plotAll(w) {
      if (type === 'inverse') {
        // 两支曲线，避免连过渐近线 x=0
        const EPS = 0.02;
        plotCurve(w, w.xMin, -EPS);
        plotCurve(w, EPS, w.xMax);
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
      } else {
        plotCurve(w, w.xMin, w.xMax);
      }
    }

    /** 类型相关标注 + 教学说明 */
    function annotate(w) {
      if (type === 'quadratic') {
        // 对称轴虚线
        ctx.save();
        ctx.strokeStyle = 'rgba(120,120,120,.55)';
        ctx.setLineDash([5, 4]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        const HX = sx({ x: p.h }, w);
        if (HX >= 0 && HX <= w.w) { ctx.moveTo(HX, 0); ctx.lineTo(HX, w.hp); }
        ctx.stroke();
        ctx.restore();
        // 顶点
        const VX = sx({ x: p.h }, w), VY = sy({ y: p.k }, w);
        ctx.fillStyle = '#c0392b';
        ctx.beginPath(); ctx.arc(VX, VY, 4.5, 0, Math.PI * 2); ctx.fill();
        ctx.fillText('(' + fmt(p.h) + ', ' + fmt(p.k) + ')', VX + 8, VY - 8);
        // 零点
        const disc = -p.k / p.a;
        let roots = 0;
        if (p.a !== 0 && disc >= 0) {
          const r = Math.sqrt(disc);
          roots = r === 0 ? 1 : 2;
          [p.h - r, p.h + r].forEach(function (x) {
            const X = sx({ x: x }, w), Y = sy({ y: 0 }, w);
            if (X < 0 || X > w.w) return;
            ctx.fillStyle = '#2ecc71';
            ctx.beginPath(); ctx.arc(X, Y, 4, 0, Math.PI * 2); ctx.fill();
          });
        }
        if (roots === 2) note.textContent = '抛物线与 x 轴的交点（绿点）的横坐标，就是方程的两个根。';
        else if (roots === 1) note.textContent = '抛物线与 x 轴刚好相切：方程有两个相等的根。';
        else note.textContent = '抛物线没有碰到 x 轴：方程没有实数根。';
      } else if (type === 'linear') {
        // 与 y 轴交点 (0,b) 红点；与 x 轴交点 (-b/k, 0) 绿点
        const BY = sy({ y: p.b }, w), BX = sx({ x: 0 }, w);
        ctx.fillStyle = '#c0392b';
        ctx.beginPath(); ctx.arc(BX, BY, 4.5, 0, Math.PI * 2); ctx.fill();
        ctx.fillText('(0, ' + fmt(p.b) + ')', BX + 8, BY - 8);
        if (p.k !== 0) {
          const xInt = -p.b / p.k;
          const IX = sx({ x: xInt }, w), IY = sy({ y: 0 }, w);
          ctx.fillStyle = '#2ecc71';
          ctx.beginPath(); ctx.arc(IX, IY, 4.5, 0, Math.PI * 2); ctx.fill();
          ctx.fillText('(' + fmt(xInt) + ', 0)', IX + 8, IY + 14);
          note.textContent = '绿点是直线与 x 轴的交点：它的横坐标就是方程 kx+b=0 的解。';
        } else {
          note.textContent = p.b === 0 ? 'k=0 且 b=0：直线就是 x 轴（无数个根）。' : 'k=0：水平直线，与 x 轴不相交（方程无解）。';
        }
      } else {
        // inverse：象限说明
        if (p.k > 0) note.textContent = 'k>0：两支曲线在第一、三象限，且关于原点对称。';
        else if (p.k < 0) note.textContent = 'k<0：两支曲线在第二、四象限，且关于原点对称。';
        else note.textContent = 'k=0：y=0 就是 x 轴（这不是反比例函数）。';
        // 渐近线交点在曲线附近标注 "y=k/x 两支离坐标轴越来越近但不相交"
      }
    }

    function draw() {
      const w = view();
      ctx.clearRect(0, 0, w.w, w.hp);
      gridAndAxes(w);
      plotAll(w);
      annotate(w);
    }

    // 首次绘制（canvas 可能尚未布局,ResizeObserver 会补一次）
    draw();
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(function () { draw(); });
      ro.observe(canvas);
      wrap._funclabRo = ro;
    }
    return {
      el: wrap,
      clear: function () {
        if (wrap._funclabRo) wrap._funclabRo.disconnect();
        wrap.remove();
      }
    };
  }

  return { fromPrompt: fromPrompt, topicSupported: topicSupported, topicKind: topicKind, labFor: labFor, mount: mount, formatFormula: formatFormula };
});