/* 对话内嵌画板校验层（fail-closed，纯函数，可单测）。
 *
 * LLM 在追问回答里可以附带 {"graph":{...}}；本模块只负责「这个图能不能挂」：
 *   - type / lab / intent 必须在 Funclab 已声明的能力清单里；
 *   - 图身份必须与本题基线（baseline：题面画板配置）一致，缺 baseline 一律拒绝；
 *   - 参数必须齐全、有限、在滑块范围内（缺参数不许靠默认值补）；
 *   - 返回的 params 保留数字键，若 fn 是合法字符串枚举（sin/cos/tan）也一并保留，
 *     否则 mount 拿不到函数身份，会画错函数。
 * 任何一项不过都返回 {ok:false,reason}，调用方不挂图（讲错图比没图更糟）。
 *
 * UMD：浏览器暴露 window.ChatGraph，Node require() 可单测。
 */
(function (root, factory) {
  'use strict';
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.ChatGraph = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  function isFiniteNum(v) { return typeof v === 'number' && isFinite(v); }

  function fail(reason) { return { ok: false, reason: reason }; }

  function isFnEnum(v) { return v === 'sin' || v === 'cos' || v === 'tan'; }

  /**
   * @param {*} g  LLM 给的 graph 对象
   * @param {object} baseline 题面当前画板配置（S.ui.labCfg：至少 type、lab，三角族还带 fn）
   * @param {object} [F] Funclab 模块；省略时取 globalThis.Funclab
   * @returns {{ok:true,type:string,lab:string,intent:string,params:object}|{ok:false,reason:string}}
   */
  function verifyChatGraph(g, baseline, F) {
    const Fl = F || (typeof globalThis !== 'undefined' ? globalThis.Funclab : null);
    if (!Fl || !Fl.TYPE_DEF || !Fl.CAPABILITIES || !Fl.CAP_TYPE || typeof Fl.intentKey !== 'function') {
      return fail('no-funclab');
    }

    /* 1. g 是对象；type 在 TYPE_DEF 里 */
    if (!g || typeof g !== 'object' || Array.isArray(g)) return fail('bad-graph');
    const type = g.type;
    if (typeof type !== 'string' || !hasOwn(Fl.TYPE_DEF, type)) return fail('bad-type');
    const def = Fl.TYPE_DEF[type];

    /* 2. lab 是字符串且在 CAPABILITIES 里，且声明的类型与 type 一致 */
    const lab = g.lab;
    if (typeof lab !== 'string' || !hasOwn(Fl.CAPABILITIES, lab)) return fail('bad-lab');
    if (Fl.CAP_TYPE[lab] !== type) return fail('lab-type-mismatch');

    /* 3. 身份基线必须存在，且与 g 完全一致。
     * 为什么缺省 fail-closed：没有 baseline 就无法证明这张图和题面是同一个函数；
     * 上一版不校验身份等于「模型说画啥就画啥」，线上已出现 y=sin(x) 的题被追问后
     * 文案讲 cos、画板还是 sin 的脱节。宁可没图，也不许挂一张身份不明的图。 */
    if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)
      || typeof baseline.type !== 'string' || typeof baseline.lab !== 'string') {
      return fail('identity-unknown');
    }
    if (type !== baseline.type) return fail('identity-type');
    if (lab !== baseline.lab) return fail('identity-lab');

    /* 4. intent 归一后属于该画板的 canAnswer */
    const intent = Fl.intentKey(g.intent);
    if (!intent) return fail('bad-intent');
    const cap = Fl.CAPABILITIES[lab] || {};
    const allowed = (cap.canAnswer || []).map(function (s) { return Fl.intentKey(s); });
    if (allowed.indexOf(intent) < 0) return fail('bad-intent');

    /* 5. params 是对象 */
    const params = g.params;
    if (!params || typeof params !== 'object' || Array.isArray(params)) return fail('bad-params');

    /* 6. baseline 带函数身份时，g 的 fn 必须严格相等（缺失或不同都拒绝）。
     * baseline 兼容拍平的 fn 与 params.fn 两种形态。 */
    let hasBaseFn = false;
    let baseFn = null;
    if (hasOwn(baseline, 'fn') && baseline.fn != null) {
      hasBaseFn = true;
      baseFn = baseline.fn;
    } else if (baseline.params && typeof baseline.params === 'object'
      && hasOwn(baseline.params, 'fn') && baseline.params.fn != null) {
      hasBaseFn = true;
      baseFn = baseline.params.fn;
    }
    if (hasBaseFn && (!hasOwn(params, 'fn') || params.fn !== baseFn)) {
      return fail('identity-fn');
    }

    /* 7. 每个滑块参数必须存在、有限、在 [min,max] 内；其它数值键 |v| <= 100 */
    const sliders = (def && def.sliders) || [];
    const sliderKeys = {};
    for (let i = 0; i < sliders.length; i++) {
      const sd = sliders[i];
      sliderKeys[sd.key] = true;
      if (!hasOwn(params, sd.key)) return fail('missing-param:' + sd.key);
      const v = params[sd.key];
      if (!isFiniteNum(v)) return fail('bad-param:' + sd.key);
      if (v < sd.min || v > sd.max) return fail('param-out-of-range:' + sd.key);
    }
    const keys = Object.keys(params);
    for (let j = 0; j < keys.length; j++) {
      const k = keys[j];
      if (sliderKeys[k]) continue;
      /* fn 是函数身份而非连续量：校验层以前只收数字，导致 5 张三角画板的合法请求
       * 一律被 bad-param:fn 拒掉（21 个 lab 里有 5 个永远挂不出来）。
       * 枚举只认 sin/cos/tan，与 funclab.js 的 TYPE_DEF.trig / formatFormula 归一一致。 */
      if (k === 'fn') {
        if (typeof params.fn !== 'string' || !isFnEnum(params.fn)) return fail('bad-param:fn');
        continue;
      }
      const v = params[k];
      if (!isFiniteNum(v)) return fail('bad-param:' + k);
      if (Math.abs(v) > 100) return fail('param-out-of-range:' + k);
    }

    /* 8. 二次函数 a !== 0 */
    if (type === 'quadratic' && params.a === 0) return fail('zero-a');

    /* 只保留数字键，合法 fn 字符串枚举一并保留（返回给 mount 的参数必须干净且带身份） */
    const out = {};
    keys.forEach(function (k) {
      if (isFiniteNum(params[k])) out[k] = params[k];
      else if (k === 'fn' && isFnEnum(params.fn)) out.fn = params.fn;
    });
    return { ok: true, type: type, lab: lab, intent: intent, params: out };
  }

  /**
   * 未配图时的确定性系统陈述（学生可见）。
   * 公式只来自 Funclab.formatFormula，本函数不手写任何公式。
   * @param {object|null} baseline 题面当前画板配置
   * @param {object} [F] Funclab 模块；省略时取 globalThis.Funclab
   * @returns {string}
   */
  function absentNotice(baseline, F) {
    const Fl = F || (typeof globalThis !== 'undefined' ? globalThis.Funclab : null);
    const plain = '本次回答没有配图。';
    if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)
      || typeof baseline.type !== 'string') {
      return plain;
    }
    if (!Fl || typeof Fl.formatFormula !== 'function') return plain;
    try {
      const formula = Fl.formatFormula(baseline);
      if (typeof formula !== 'string' || !formula) return plain;
      return '本次回答没有配图；画板仍是本题的 ' + formula + '。';
    } catch (err) {
      return plain;
    }
  }

  return { verifyChatGraph: verifyChatGraph, absentNotice: absentNotice };
});
