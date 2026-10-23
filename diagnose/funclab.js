/* 二次函数实验室：把题面里的抛物线参数解析出来，渲染可拖拽的 y=a(x-h)²+k 画板。
 *
 * 方案：配置驱动（预置组件，LLM 零参与）。题型白名单 + 题面解析出 {a,h,k} 就挂载，
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

  /**
   * 从题面解析抛物线参数 → {a, h, k}（顶点式 y=a(x-h)²+k），解析不出返回 null。
   * 支持四类写法：
   *   1) 顶点式   y=2(x+3)²-5 / y=(x-1)²+2
   *   2) 一般式   y=x²-4x+3 / y=-2x²+8x-3
   *   3) 一元二次方程 x²-4x-1=0 / 2x²-8x+1=0（对应抛物线 y=ax²+bx+c）
   *   4) 配方题   "配成 2(x-m)²=n 的形式"（m 即 -h 的系数）
   */
  function fromPrompt(prompt) {
    const s = normalize(prompt);
    if (!s) return null;

    // 1) 顶点式：y = a(x±h)² ± k 或 a(x±m)² ± n
    let m = s.match(/([+-]?\s*\d*\.?\d*)\s*\(\s*x\s*([+-]\s*\d*\.?\d*)\s*\)\s*²\s*([+-]\s*\d*\.?\d*)?/);
    if (m) {
      const a = coeffNum(m[1]);
      const h = -coeffNum(m[2]);
      const k = m[3] ? coeffNum(m[3]) : 0;
      if (a !== 0 && isFinite(a) && isFinite(h) && isFinite(k)) return { a: a, h: h, k: k };
    }

    // 2/3) 一般式 & 方程：提取 ax²+bx+c（可能接 =0 或 = 某式）
    //     a 可省略（x² → a=1）或带负号（-x² → a=-1）；b 同理；c 可省略
    m = s.match(/([+-]?\s*\d*\.?\d*)?\s*x²\s*([+-]\s*\d*\.?\d*)?\s*x\s*([+-]\s*\d*\.?\d*)?/);
    if (!m) return null;
    const a = coeffNum(m[1]);
    const b = m[2] ? coeffNum(m[2]) : 0;
    const c = m[3] ? coeffNum(m[3]) : 0;
    if (a === 0 || !isFinite(a) || !isFinite(b) || !isFinite(c)) return null;
    // 配方换算：y = a(x-h)² + k，其中 h = -b/(2a)，k = c - b²/(4a)
    const h = -b / (2 * a);
    const k = c - (b * b) / (4 * a);
    if (!isFinite(h) || !isFinite(k)) return null;
    return { a: a, h: h, k: k };
  }

  /** 题型白名单：一元二次方程（22x）与二次函数（23x、24x 里的二次函数相关章）都可能配画板 */
  function topicSupported(topicId) {
    const id = String(topicId || '');
    // cnm_220..224 一元二次方程四方法；cnm_229..236 二次函数章
    return /^cnm_2(2[0-4]|2[9]|3[0-6])$/.test(id);
  }

  /** 组合入口：知识点支持 && 题面能解析 → {a,h,k}，否则 null */
  function labFor(topicId, prompt) {
    if (!topicSupported(topicId)) return null;
    return fromPrompt(prompt);
  }

  /* ------------------------------------------------------------ 渲染（需要 DOM） */

  const SLIDER_DEF = [
    { key: 'a', label: 'a', min: -4, max: 4, step: 0.05 },
    { key: 'h', label: 'h', min: -8, max: 8, step: 0.05 },
    { key: 'k', label: 'k', min: -8, max: 8, step: 0.05 }
  ];

  /** 数字小数化：0 -> "0"，1.5 -> "1.5"，去掉尾零 */
  function fmt(n) {
    if (n === 0) return '0';
    const r = Math.round(n * 100) / 100;
    return String(r);
  }

  /** 美化函数式：y = a(x-h)²+k。系数省略 1、去掉 0/±1 冗余、紧凑排版 */
  function formatFormula(p) {
    // a 部分
    let aPart;
    if (p.a === 1) aPart = '';
    else if (p.a === -1) aPart = '-';
    else aPart = fmt(p.a);
    // (x - h) 部分：h=0 省略括号写 x²；h>0 写作 x - h；h<0 写作 x + |h|
    let xPart = 'x';
    if (p.h > 0) xPart += ' - ' + fmt(p.h);
    else if (p.h < 0) xPart += ' + ' + fmt(-p.h);
    let s = p.h === 0 ? 'y = ' + aPart + xPart + '²' : 'y = ' + aPart + '(' + xPart + ')²';
    // k 部分：k=0 省略
    if (p.k > 0) s += ' + ' + fmt(p.k);
    else if (p.k < 0) s += ' - ' + fmt(-p.k);
    return s;
  }

  /** 创建画板元素。opts: {a,h,k,focus?} 返回 {el, reset} */
  function mount(opts) {
    const p = { a: 1, h: 0, k: 0 };
    Object.assign(p, opts || {});
    const start = { a: p.a, h: p.h, k: p.k };

    const wrap = document.createElement('div');
    wrap.className = 'funclab';
    const canvas = document.createElement('canvas');
    canvas.className = 'funclab-canvas';
    const info = document.createElement('div');
    info.className = 'funclab-formula';
    info.textContent = formatFormula(p);

    const ctrl = document.createElement('div');
    ctrl.className = 'funclab-sliders';
    const sliders = {};
    SLIDER_DEF.forEach(function (def) {
      const row = document.createElement('label');
      row.className = 'funclab-slider';
      row.appendChild(document.createTextNode(def.label + ' = '));
      const val = document.createElement('span');
      val.textContent = fmt(p[def.key]);
      const input = document.createElement('input');
      input.type = 'range';
      input.min = def.min; input.max = def.max; input.step = def.step;
      input.value = p[def.key];
      input.addEventListener('input', function () {
        p[def.key] = parseFloat(input.value);
        val.textContent = fmt(p[def.key]);
        info.textContent = formatFormula(p);
        draw();
      });
      row.appendChild(val);
      row.appendChild(input);
      sliders[def.key] = input;
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
    wrap.appendChild(canvas);
    wrap.appendChild(ctrl);

    const dpr = (typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1) || 1;
    const ctx = canvas.getContext('2d');

    /** 世界坐标 → 屏幕坐标。窗口以顶点为中心，固定跨度 12×8，
     *  但 y 范围强制包含 x 轴（0 线），保证零点/刻度可见。 */
    function view() {
      let xMin = p.h - 6, xMax = p.h + 6;
      let yMin = p.k - 4, yMax = p.k + 4;
      if (yMin > 0) yMin = 0;        // 顶点在 x 轴上方时，拉低窗口底边到 0
      if (yMax < 0) yMax = 0;        // 顶点在 x 轴下方时，抬高窗口顶边到 0
      if (yMax - yMin < 6) {         // 极平缓时保最小窗口高度
        const mid = (yMin + yMax) / 2;
        yMin = mid - 3; yMax = mid + 3;
        if (yMin > 0) yMin = 0; else if (yMax < 0) yMax = 0;
      }
      const w = canvas.clientWidth || 560, hpx = canvas.clientHeight || 320;
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(hpx * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return {
        w: w, hp: hpx,
        xMin: xMin, xMax: xMax,
        yMin: yMin, yMax: yMax
      };
    }
    function sx(v, w) { return (v.x - w.xMin) / (w.xMax - w.xMin) * w.w; }
    function sy(v, w) { return (w.yMax - v.y) / (w.yMax - w.yMin) * w.hp; }
    function f(x) { return p.a * (x - p.h) * (x - p.h) + p.k; }

    function draw() {
      const w = view();
      ctx.clearRect(0, 0, w.w, w.hp);
      // 网格
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
      // 坐标轴
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
      // 对称轴 x=h（虚线）
      ctx.save();
      ctx.strokeStyle = 'rgba(120,120,120,.55)';
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      const HX = sx({ x: p.h }, w);
      if (HX >= 0 && HX <= w.w) { ctx.moveTo(HX, 0); ctx.lineTo(HX, w.hp); }
      ctx.stroke();
      ctx.restore();
      // 抛物线
      ctx.strokeStyle = '#2a7de1';
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      let first = true;
      for (let i = 0; i <= 240; i++) {
        const x = w.xMin + (w.xMax - w.xMin) * i / 240;
        const y = f(x);
        const X = sx({ x: x }, w), Y = sy({ y: y }, w);
        if (Y < -2000 || Y > w.hp + 2000) { first = true; continue; }
        if (first) { ctx.moveTo(X, Y); first = false; } else ctx.lineTo(X, Y);
      }
      ctx.stroke();
      // 顶点
      const VX = sx({ x: p.h }, w), VY = sy({ y: p.k }, w);
      ctx.fillStyle = '#c0392b';
      ctx.beginPath(); ctx.arc(VX, VY, 4.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillText('(' + fmt(p.h) + ', ' + fmt(p.k) + ')', VX + 8, VY - 8);
      // 零点（若有）
      const disc = -p.k / p.a;
      if (p.a !== 0 && disc >= 0) {
        const r = Math.sqrt(disc);
        [p.h - r, p.h + r].forEach(function (x) {
          const X = sx({ x: x }, w), Y = sy({ y: 0 }, w);
          if (X < 0 || X > w.w) return;
          ctx.fillStyle = '#2ecc71';
          ctx.beginPath(); ctx.arc(X, Y, 4, 0, Math.PI * 2); ctx.fill();
        });
      }
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

  return { fromPrompt: fromPrompt, topicSupported: topicSupported, labFor: labFor, mount: mount, formatFormula: formatFormula };
});