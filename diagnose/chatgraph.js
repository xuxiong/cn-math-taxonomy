/* 对话内嵌画板校验层（fail-closed，纯函数，可单测）。
 *
 * LLM 在追问回答里可以附带 {"graph":{...}}；本模块只负责「这个图能不能挂」：
 *   - type / lab / intent 必须在 Funclab 已声明的能力清单里；
 *   - 参数必须齐全、有限、在滑块范围内（缺参数不许靠默认值补）；
 *   - 返回的 params 只保留数字键，供 Funclab.mount 直接使用。
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

  /**
   * @param {*} g  LLM 给的 graph 对象
   * @param {object} [F] Funclab 模块；省略时取 globalThis.Funclab
   * @returns {{ok:true,type:string,lab:string,intent:string,params:object}|{ok:false,reason:string}}
   */
  function verifyChatGraph(g, F) {
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

    /* 3. intent 归一后属于该画板的 canAnswer */
    const intent = Fl.intentKey(g.intent);
    if (!intent) return fail('bad-intent');
    const cap = Fl.CAPABILITIES[lab] || {};
    const allowed = (cap.canAnswer || []).map(function (s) { return Fl.intentKey(s); });
    if (allowed.indexOf(intent) < 0) return fail('bad-intent');

    /* 4. params 是对象 */
    const params = g.params;
    if (!params || typeof params !== 'object' || Array.isArray(params)) return fail('bad-params');

    /* 5/6. 每个滑块参数必须存在、有限、在 [min,max] 内；其它数值键 |v| <= 100 */
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
      const v = params[k];
      if (!isFiniteNum(v)) return fail('bad-param:' + k);
      if (Math.abs(v) > 100) return fail('param-out-of-range:' + k);
    }

    /* 7. 二次函数 a !== 0 */
    if (type === 'quadratic' && params.a === 0) return fail('zero-a');

    /* 只保留数字键（返回给 mount 的参数必须是干净的数值） */
    const out = {};
    keys.forEach(function (k) { if (isFiniteNum(params[k])) out[k] = params[k]; });
    return { ok: true, type: type, lab: lab, intent: intent, params: out };
  }

  return { verifyChatGraph: verifyChatGraph };
});
