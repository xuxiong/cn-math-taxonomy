/* LLM 语义匹配层（M 卡）：决定「这道题该不该挂画板、挂哪个、讲什么」。
 *
 * 为什么需要它
 * ------------
 * 画板能不能挂，靠正则只能判断「题面里有没有一个能画出图形的函数」，
 * 判断不了「画板讲的那件事，跟题目问的是不是同一件」——
 * 于是出现过「求 y=2(x+1)²-4 的最小值」却显示「交点横坐标就是方程的两个根」这种挂错。
 * 语义判断交给 LLM；**数值正确性**仍由确定性校验（verifyParams）把关，LLM 绕不过去。
 *
 * 三条铁律
 *   1. 没有 LLM 就不挂图：网络失败 / 非 200 / JSON 解析失败 / 超时 → matchLab 返回 null，调用方不挂。
 *      **不做正则保底**（保底会把已知的误挂重新带回来）。
 *   2. LLM 只选画板 + 给参数 + 选 intent；文案与绘制方式全在 funclab.js（NOTE_INTENT），
 *      本模块不写任何教学文案。
 *   3. 参数必须代回原式验算通过（展开系数逐项比对，误差 > 1e-9 拒绝）——
 *      防 LLM 编造数字，也防题面有多个函数时它挑错一个。
 *
 * 缓存
 *   localStorage['cnmLabMatch.v1'] = { [itemId]: {match, params, intent, reason, at} }
 *   只缓存「校验通过」的结果；失败不缓存（否则网关抖一次就永久无图）。
 *   结构损坏 → 整表丢弃重建（不当真，也不抛异常）。
 *
 * UMD：浏览器暴露 window.Labmatch（需先加载 funclab.js），Node require('./labmatch.js') 可单测
 * （fetch 可注入，无 DOM / 无网络也能跑）。
 */
(function (root, factory) {
  'use strict';
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./funclab.js'));
  else root.Labmatch = factory(root.Funclab);
})(typeof self !== 'undefined' ? self : this, function (Funclab) {
  'use strict';

  const PROXY = 'http://127.0.0.1:3000/v1/chat/completions';
  const MODEL = 'DeepSeek-V4-Flash-0731-TokenPlan';
  const CACHE_KEY = 'cnmLabMatch.v1';
  /* lenient（学生主动点「画图给我看」）用**独立**缓存表，理由见 resolve() 的注释：
   * lenient 会挂上「题目没直接问、但能帮助学生理解」的图，如果把这种宽松判定写进正常缓存，
   * 下次自动挂图就会跟着挂（污染自动路径）；反过来，正常缓存里的条目是「严格判定通过」的强结果，
   * lenient 复用它一定安全。因此两张表单向流动：strict → lenient（可复用），lenient -/-> strict。
   *
   * v2（卡 t_4eed15b3）：lenient 的判定标准变了 —— 从「图有没有帮助」改成「只提取参数、只判能不能画」。
   * 旧 v1 表里存的是「LLM 判过、但通过的是旧 prompt」的结果（参数校验同样能过），换 key 让它们整体作废，
   * 否则学生本地缓存的旧判定会继续生效，新 prompt 根本没机会跑。 */
  const LENIENT_CACHE_KEY = 'cnmLabMatchLenient.v2';
  /** 旧版本 key：启动时清掉，避免 localStorage 里留一堆再也不会被读的垃圾（以及旧 key 拿去复用） */
  const LEGACY_LENIENT_CACHE_KEYS = ['cnmLabMatchLenient.v1'];
  /* 验证时用 500 会把 JSON 截断（reason 字段被切掉一半 → 解析失败）。
   * 注意网关把 reasoning_content 也算进预算：1200 在长推理题上仍会截断（实测 cnm_202_q1 同题重试就顶到上限），
   * 因此给 2000 —— 卡面「给足 1200」是最低要求，不是上限。 */
  const MAX_TOKENS = 2000;
  const TIMEOUT_MS = 20000;   // 推理模型 + 多选项题面实测可超 12s（cnm_230_q1 就吃过超时）
  /* 代回验算容差：系数是浮点配方的结果（h=-b/2a），1e-9 足够严，又不会被 0.30000000000000004 绊倒 */
  const EPS = 1e-9;

  const NO_FUNCLAB = 'Labmatch 需要先加载 funclab.js（能力清单的唯一来源）';

  /* ============================================================ 缓存 */

  /** 内存存储（Node 测试 / 无 localStorage 环境） */
  function memoryStore() {
    const m = {};
    return {
      get: function (k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
      set: function (k, v) { m[k] = v; },
      remove: function (k) { delete m[k]; }
    };
  }

  /** localStorage 存储：整表一个 key，读写都做结构校验 */
  function localStorageStore(ls) {
    return {
      get: function (k) {
        try {
          const raw = ls.getItem(k);
          if (!raw) return null;
          const obj = JSON.parse(raw);
          if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
          return obj;
        } catch (e) { return null; }          // 损坏 → 当没有（下次写入重建）
      },
      set: function (k, v) { try { ls.setItem(k, JSON.stringify(v)); } catch (e) { /* 配额满：静默 */ } },
      remove: function (k) { try { ls.removeItem(k); } catch (e) { /* ignore */ } }
    };
  }

  let _store = null;
  function defaultStore() {
    if (_store) return _store;
    if (typeof localStorage !== 'undefined' && localStorage) _store = localStorageStore(localStorage);
    else _store = memoryStore();
    /* 旧版本 lenient 表（v1 及更早）整体作废：判定标准已经变了（卡 t_4eed15b3），
     * 留着只会占 localStorage，也容易被别的代码误读成「当前判定结果」。清一次就够。 */
    if (typeof localStorage !== 'undefined' && localStorage) {
      LEGACY_LENIENT_CACHE_KEYS.forEach(function (k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } });
    }
    return _store;
  }
  /** 测试/宿主替换存储（传 null 恢复默认探测） */
  function setStore(s) { _store = s || null; }

  /** 缓存条目结构是否完整（缺字段 / 类型不对 → 当作没缓存） */
  function validEntry(e) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return false;
    if (typeof e.match !== 'string' || !e.match) return false;
    if (!e.params || typeof e.params !== 'object' || Array.isArray(e.params)) return false;
    if (typeof e.intent !== 'string' || !e.intent) return false;
    if (Object.keys(e.params).some(function (k) { return !isFinite(Number(e.params[k])); })) return false;
    return true;
  }

  function cacheGet(itemId, key) {
    if (!itemId) return null;
    const all = defaultStore().get(key || CACHE_KEY);
    if (!all || typeof all !== 'object') return null;
    const e = all[String(itemId)];
    return validEntry(e) ? e : null;
  }

  function cachePut(itemId, choice, key) {
    if (!itemId) return;
    const k = key || CACHE_KEY;
    const all = defaultStore().get(k);
    const table = (all && typeof all === 'object' && !Array.isArray(all)) ? all : {};
    table[String(itemId)] = {
      match: choice.match, params: choice.params, intent: choice.intent,
      reason: choice.reason || '', at: Date.now()
    };
    defaultStore().set(k, table);
  }

  /** 丢掉一条缓存（结构损坏 / 重新校验不过） */
  function cacheDrop(itemId, key) {
    if (!itemId) return;
    const k = key || CACHE_KEY;
    const all = defaultStore().get(k);
    if (!all || typeof all !== 'object' || Array.isArray(all)) return;
    if (!Object.prototype.hasOwnProperty.call(all, String(itemId))) return;
    delete all[String(itemId)];
    defaultStore().set(k, all);
  }

  /* ============================================================ 题面 → 规范参数（校验基准，与 LLM 无关） */

  /** 从题面抠出区间端点（「2≤x≤4」「当 2<x<4 时」）；取不到返回 null */
  function promptInterval(prompt) {
    const s = String(prompt || '')
      .replace(/\s+/g, '')
      .replace(/[⩽＜]/g, '<')
      .replace(/≤/g, '<')
      .replace(/[，。；、]/g, ',');
    const m = /(-?\d+(?:\.\d+)?)<x<(-?\d+(?:\.\d+)?)/.exec(s);
    if (!m) return null;
    const a = parseFloat(m[1]), b = parseFloat(m[2]);
    if (!isFinite(a) || !isFinite(b) || !(b > a)) return null;
    return { xMin: a, xMax: b };
  }

  /** 顶点式 a(x-h)²+k 展开成标准式的系数 (a, b, c)：a=-? 见下 */
  function expandVertex(a, h, k) {
    return { a: a, b: -2 * a * h, c: a * h * h + k };
  }

  function close(x, y) {
    if (!isFinite(x) || !isFinite(y)) return false;
    return Math.abs(x - y) <= EPS * Math.max(1, Math.abs(x), Math.abs(y));
  }

  /* ============================================================ 确定性校验（LLM 绕不过去） */

  /**
   * verifyParams(prompt, choice) → {ok, why}
   * 逐条：
   *   1. choice.match 必须是已注册画板（funclab.CAPABILITIES 的 key）
   *   2. choice.intent 必须逐字属于该画板的 canAnswer（归一化空白后比较）
   *   3. choice.params 的数值必须**代回原式验算通过**：
   *      题面解析出的原式（funclab.fromPrompt，与 LLM 完全独立的另一条路径）
   *      vs 用 LLM 的 {a,h,k} 构造顶点式再展开 —— 系数逐项比对，误差 > 1e-9 拒绝
   *   4. 区间最值画板：题面必须真的给出区间，且端点与 LLM 给的一致
   */
  function verifyParams(prompt, choice) {
    const why = [];
    if (!Funclab || !Funclab.CAPABILITIES) return { ok: false, why: [NO_FUNCLAB] };
    const c = choice || {};
    const lab = typeof c.match === 'string' ? c.match : '';
    // 1. 画板必须注册过
    const cap = Funclab.CAPABILITIES[lab];
    if (!cap) return { ok: false, why: ['未注册画板: ' + (lab || '(空)')] };
    // 2. intent 必须在该画板 canAnswer 里
    const intent = Funclab.intentKey(c.intent);
    const allowed = Funclab.capabilityIntents(lab);
    if (!intent || allowed.indexOf(intent) < 0) {
      return { ok: false, why: ['intent 不在 ' + lab + '.canAnswer: ' + (c.intent || '(空)')] };
    }
    if (!Funclab.NOTE_BY_INTENT[intent]) return { ok: false, why: ['intent 没有文案模板: ' + intent] };

    // 3. 参数齐全且是有限数
    const p = c.params || {};
    const need = cap.params.slice();
    const type = Funclab.CAP_TYPE[lab];

    /* ---- 多曲线画板（t_1d3fe77a）：参数是数组，形状与单曲线完全不同，先单独走 ----
     * 铁律不变：**每条曲线**都要与题面解析结果逐条对上（不是只对上其中一条就算过），
     * 交点是推导量、不进参数，所以这里校验的是「表达式认对没有」。 */
    if (type === 'curves') return verifyCurves(prompt, c, why);

    /* ---- 拒绝规则（t_1d3fe77a）：题面有 ≥2 条表达式 + 问交点 → 不许挂单曲线画板 ----
     * 单曲线画板只能画其中一条，学生看到的是「半道题」，还容易被当成完整图。
     * 这条必须在代回校验**之前**判：否则 LLM 挑中第一条直线时参数是能对上的，
     * 代回校验会放它过去（cnm_208_q1 / cnm_h172_q1 就是这么被误挂的）。 */
    if (INTERSECT_WORDS.test(String(prompt || '')) && curvesOfPrompt(prompt).length >= 2) {
      return {
        ok: false,
        why: ['题面含两条以上曲线且问交点：单曲线画板（' + lab + '）画不全，'
          + '这类题只能用 ' + CURVES_LAB]
      };
    }

    for (let i = 0; i < need.length; i++) {
      const key = need[i];
      const v = Number(p[key]);
      if (!isFinite(v)) return { ok: false, why: ['参数缺失或非数值: ' + key] };
    }
    if (type === 'quadratic' && Number(p.a) === 0) return { ok: false, why: ['a=0 不是二次函数'] };
    if ((type === 'linear' || type === 'inverse') && Number(p.k) === 0) return { ok: false, why: ['k=0 画不出图象'] };

    // 3'. 代回原式：题面规范参数 vs LLM 参数，展开后逐项比对
    const parsed = Funclab.fromPrompt(prompt);
    if (!parsed || parsed.type !== type) {
      return { ok: false, why: ['题面解析不出与画板类型一致的函数（' + type + '）'] };
    }
    if (type === 'quadratic') {
      const got = expandVertex(Number(p.a), Number(p.h), Number(p.k));
      const ref = expandVertex(parsed.a, parsed.h, parsed.k);
      if (!close(got.a, ref.a) || !close(got.b, ref.b) || !close(got.c, ref.c)) {
        why.push('参数代回不符：LLM a=' + p.a + ',h=' + p.h + ',k=' + p.k
          + ' 展开 (' + round6(got.a) + ',' + round6(got.b) + ',' + round6(got.c) + ')'
          + ' ≠ 题面 (' + round6(ref.a) + ',' + round6(ref.b) + ',' + round6(ref.c) + ')');
      }
    } else if (type === 'linear') {
      if (!close(Number(p.k), parsed.k) || !close(Number(p.b), parsed.b)) {
        why.push('参数代回不符：LLM k=' + p.k + ',b=' + p.b + ' ≠ 题面 k=' + parsed.k + ',b=' + parsed.b);
      }
    } else if (type === 'inverse') {
      if (!close(Number(p.k), parsed.k)) why.push('参数代回不符：LLM k=' + p.k + ' ≠ 题面 k=' + parsed.k);
    }

    // 4. 区间：题面必须真的给了区间，且端点一致
    if (need.indexOf('xMin') >= 0 || need.indexOf('xMax') >= 0) {
      const iv = promptInterval(prompt);
      if (!iv) why.push('题面没有可解析的区间端点（xMin/xMax 无法校核）');
      else if (!close(Number(p.xMin), iv.xMin) || !close(Number(p.xMax), iv.xMax)) {
        why.push('区间不符：LLM [' + p.xMin + ',' + p.xMax + '] ≠ 题面 [' + iv.xMin + ',' + iv.xMax + ']');
      }
    }
    return { ok: why.length === 0, why: why };
  }

  function round6(x) { return isFinite(x) ? Math.round(x * 1e6) / 1e6 : String(x); }

  /* ============================================================ 多曲线（t_1d3fe77a）
   *
   * 三条卡面硬性纪律，这里逐条落地：
   *   1. `curves` 数组长度必须恰好 2（多于 2 条返回 null 的规则由 funclab.mountCurves 兜；
   *      匹配层同样拒绝 3 条以上 / 1 条 —— 单曲线题不该走多曲线画板）。
   *   2. **每条曲线都要代回**：拿题面自己的解析结果（curvesFromPrompt，与 LLM 完全独立的另一条路径）
   *      逐条比对，缺一条或多一条都算不符 —— 只对上其中一条就放过，等于放它画半道题。
   *   3. 题面必须真的是「两条曲线 + 问交点」；否则即使 LLM 报了 curves 画板也不挂。
   */
  const CURVES_LAB = 'two-curves-intersect';
  /** 题面里能数出几条可解析曲线 */
  function curvesOfPrompt(prompt) {
    if (!Funclab || typeof Funclab.curvesFromPrompt !== 'function') return [];
    try { return Funclab.curvesFromPrompt(prompt) || []; } catch (e) { return []; }
  }
  const INTERSECT_WORDS = /交点|公共点|相交|位置关系/;
  /* 与 funclab.CURVES_EXCLUDE 同一口径（单测两边都锁）：
   * 「求 m 的值/求 m=」类（交点是已知量）与「解集/不等式」类（答案不是交点）都不算交点题。
   * 「求…」后必须紧跟单个字母参数，不能是 y=/x= 这种函数式开头（cnm_241_q1 是正当交点题）。 */
  const CURVES_EXCLUDE = /求\s*([a-wz])\s*(?:的值|[＝=])|解集|取值范围|不等式/;
  /** 题面是否「两条曲线 + 问交点」（交点坐标才是答案的那类） */
  function isIntersectItem(prompt) {
    const s = String(prompt || '');
    if (!INTERSECT_WORDS.test(s)) return false;
    if (CURVES_EXCLUDE.test(s)) return false;
    return curvesOfPrompt(s).length === 2;
  }

  /** 两条曲线数值上是否同一条（type 相同 + 参数逐个 close） */
  function sameCurve(a, b) {
    if (!a || !b) return false;
    if (String(a.type) !== String(b.type)) return false;
    if (a.type === 'quadratic') {
      return close(Number(a.a), Number(b.a)) && close(Number(a.h), Number(b.h)) && close(Number(a.k), Number(b.k));
    }
    if (a.type === 'linear') return close(Number(a.k), Number(b.k)) && close(Number(a.b), Number(b.b));
    if (a.type === 'inverse') return close(Number(a.k), Number(b.k));
    return false;
  }

  /**
   * 把「表达式字符串」形态的一条曲线规约成曲线对象（纯确定性解析，不做任何猜测）。
   *
   * 为什么需要：实测 LLM 会把 curves 写成 ["y=x+1", "y=-x+3"]（式子串）而不是对象数组。
   * **这不是放宽严格性** —— 规约用的是 funclab 自己的解析器，解析结果仍然要拿回下面的
   * 第 3 步与题面解析结果逐项比系数；解析不出来、或解析出不止一条曲线（有歧义）就拒绝。
   *
   * 返回 {ok:true, curve} 或 {ok:false, why}
   */
  function coerceCurveSpec(raw) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return { ok: true, curve: raw };
    if (typeof raw !== 'string') return { ok: false, why: '既不是对象也不是表达式字符串: ' + JSON.stringify(raw) };
    const text = raw.trim();
    if (!text) return { ok: false, why: '空字符串' };
    let parsed = null;
    try {
      // 先按多曲线解析（题面里可能写了 y=… 与 y=…），再退到单函数解析
      const list = (typeof Funclab.curvesFromPrompt === 'function') ? (Funclab.curvesFromPrompt(text) || []) : [];
      if (list.length === 1) parsed = list[0];
      else if (list.length > 1) return { ok: false, why: '字符串里有 ' + list.length + ' 条曲线，无法确定是哪一条: ' + text };
    } catch (e) { parsed = null; }
    if (!parsed) {
      try {
        const one = Funclab.fromPrompt(text);
        if (one && (one.type === 'linear' || one.type === 'inverse' || one.type === 'quadratic')) parsed = one;
      } catch (e) { parsed = null; }
    }
    if (!parsed) return { ok: false, why: '解析不出曲线（不是可识别的函数表达式）: ' + text };
    /* 只回传画板认识的字段，别把 base/原始串等杂质带进后续比对 */
    const curve = { type: parsed.type };
    if (parsed.type === 'linear') { curve.k = parsed.k; curve.b = parsed.b; }
    else if (parsed.type === 'inverse') { curve.k = parsed.k; }
    else { curve.a = parsed.a; curve.h = parsed.h; curve.k = parsed.k; }
    return { ok: true, curve: curve };
  }

  /** 多曲线参数校验（verifyParams 的 curves 分支） */
  function verifyCurves(prompt, c, why) {
    const p = c.params || {};
    const raw = p.curves;
    /* 1. 形状：恰好两条，且每条都是画板支持的类型 */
    if (!Array.isArray(raw)) return { ok: false, why: ['curves 必须是数组（两条曲线的参数）'] };
    if (raw.length !== 2) {
      return { ok: false, why: ['curves 长度必须为 2（收到 ' + raw.length + ' 条）：多曲线画板只画两条'] };
    }
    /* 1'. 逐条规约：对象照收；表达式字符串用确定性解析转成对象（解析不出就拒绝） */
    const got = [];
    for (let i = 0; i < raw.length; i++) {
      const co = coerceCurveSpec(raw[i]);
      if (!co.ok) return { ok: false, why: ['第 ' + (i + 1) + ' 条曲线' + co.why] };
      got.push(co.curve);
    }
    const TYPES = ['linear', 'inverse', 'quadratic'];
    for (let i = 0; i < got.length; i++) {
      const g = got[i] || {};
      if (TYPES.indexOf(String(g.type)) < 0) return { ok: false, why: ['第 ' + (i + 1) + ' 条曲线类型不支持: ' + (g.type || '(空)')] };
      if (g.type === 'inverse' && Number(g.k) === 0) return { ok: false, why: ['第 ' + (i + 1) + ' 条双曲线 k=0，画不出图象'] };
      if (g.type === 'quadratic' && Number(g.a) === 0) return { ok: false, why: ['第 ' + (i + 1) + ' 条抛物线 a=0，不是二次函数'] };
      if (g.type === 'linear' && Number(g.k) === 0) return { ok: false, why: ['第 ' + (i + 1) + ' 条直线 k=0（水平线）：多曲线画板只画能解出交点的斜率'] };
      if (g.type === 'linear' && !isFinite(Number(g.k))) return { ok: false, why: ['第 ' + (i + 1) + ' 条直线缺 k'] };
      if (g.type === 'linear' && !isFinite(Number(g.b))) return { ok: false, why: ['第 ' + (i + 1) + ' 条直线缺 b'] };
      if (g.type === 'inverse' && !isFinite(Number(g.k))) return { ok: false, why: ['第 ' + (i + 1) + ' 条双曲线缺 k'] };
      if (g.type === 'quadratic' && (!isFinite(Number(g.h)) || !isFinite(Number(g.k)) || !isFinite(Number(g.a)))) {
        return { ok: false, why: ['第 ' + (i + 1) + ' 条抛物线缺 a/h/k'] };
      }
    }

    /* 2. 题面必须真的是「两条曲线 + 问交点」 */
    if (!INTERSECT_WORDS.test(String(prompt || ''))) {
      return { ok: false, why: ['题面没有问交点/公共点/位置关系：不该挂多曲线画板'] };
    }
    /* 交点是已知量（求 m 的值）或答案不是交点（解集/不等式）→ 不挂 */
    if (CURVES_EXCLUDE.test(String(prompt || ''))) {
      return { ok: false, why: ['题面问的是参数/解集（交点不是答案）：不该挂多曲线画板'] };
    }
    const ref = curvesOfPrompt(prompt);
    if (ref.length !== 2) {
      return { ok: false, why: ['题面只解析出 ' + ref.length + ' 条曲线（需要 2 条）：多曲线画板画不了'] };
    }

    /* 3. 每条曲线都要对上（顺序不敏感：LLM 可能把两条调换了） */
    const used = [false, false];
    for (let i = 0; i < got.length; i++) {
      let hit = -1;
      for (let j = 0; j < ref.length; j++) {
        if (!used[j] && sameCurve(got[i], ref[j])) { hit = j; break; }
      }
      if (hit < 0) {
        why.push('第 ' + (i + 1) + ' 条曲线代回不符：LLM ' + JSON.stringify(got[i])
          + ' 不在题面解析结果 ' + JSON.stringify(ref) + ' 里');
      } else {
        used[hit] = true;
      }
    }
    return { ok: why.length === 0, why: why };
  }

  /* ============================================================ LLM 调用 */

  function systemPrompt(opts) {
    const o = opts || {};
    if (o.lenient) return lenientSystemPrompt();
    return '你是数学教学系统的画板匹配器：给一道题和一份画板能力清单，判断该不该挂画板、挂哪个、画板要讲清单里的哪一条。'
      + '\n只输出 JSON，不要任何解释文字、不要 Markdown 代码块。格式严格为：'
      + '\n{"match":"画板名或null","params":{},"intent":"","reason":"一句话理由"}'
      + '\n规则：'
      + '\n1. 只有题目真正要问的东西落在某个画板的 canAnswer 里，才给 match；否则 match 必须为 null，不要硬凑。'
      + '\n2. intent 必须是所选画板 canAnswer 数组里的**某一整项**，逐字照抄、一个字都不能改，也不能把两项拼起来'
      + '（题目同时问了几件事时，选与题目首要提问最接近的那一项）。'
      + '\n3. params 必须能从题面原样读出、或由题面表达式直接换算（如 y=x²-4x+3 配方得 a=1,h=2,k=-1）。'
      + '不许编造题面没有的数；题面给了几个函数时，只用与题目所问直接相关的那个。'
      + '\n4. 画板只负责"看见关系"，不负责写解题步骤：如果题目问的是化简结果、求参数取值、求面积/长度的具体数值计算、'
      + '两图象交点坐标等 canAnswer 未列出的东西，一律 match=null。'
      + '\n5. match 为 null 时 params 给 {}，intent 给 ""，reason 写明"清单里没有能回答这个问题的画板"。';
  }

  /**
   * lenient 的 system 规则（学生主动要求看图：diagnose/app.js 的「画图给我看」按钮）。
   *
   * 卡 t_4eed15b3：学生点了按钮，**「需不需要这张图」就已经由学生回答了**，系统不再评判。
   * 这里唯一要判的是「题面里的函数能不能画出来」，所以 LLM 的任务收缩成**纯参数提取**：
   *   题面里有可画出的函数 → 选画板 + 给参数（intent 只是画板文案的选择项，不代表「值不值得画」）
   *   题面里没有可画出的函数 → match=null
   * 绝不出现「这图对理解这题有没有帮助」「不能完整回答就不要选」这类价值判断 ——
   * 那是在替学生决定他要不要看图；也不许因为「题目问的不是图形」而拒绝。
   *
   * 「intent 逐字取自 canAnswer」「params 不许编造」「只输出 JSON」三条与默认路径一致，
   * 参数最终还要过 verifyParams 代回校验（这条是唯一防线，不放宽）。
   */
  function lenientSystemPrompt() {
    return '你是数学教学系统的画板匹配器。这次的场景不同：学生自己要求看一眼图，'
      + '**需不需要这张图学生已经决定了，你不要评判这张图有没有用、值不值得画**。'
      + '你唯一要做的事：从题面里提取函数表达式，选一个能画出它们的画板。'
      + '\n只输出 JSON，不要任何解释文字、不要 Markdown 代码块。格式严格为：'
      + '\n{"match":"画板名或null","params":{},"intent":"","reason":"一句话说明提取到的表达式"}'
      + '\n规则：'
      + '\n1. 只要题面里出现能画出来的函数表达式（直线 y=kx+b、双曲线 y=k/x、抛物线 y=ax²+bx+c 或 y=a(x-h)²+k 等），'
      + '就选一个能画出它的画板并给 params。**不要考虑题目问的是什么、这个图有没有帮助** —— '
      + '配方、化简、求根这类题目问的是代数操作，但题面里的函数照样能画，照样要给 match。'
      + '\n2. 题面里有**两条可画曲线**（如 y=x 与 y=4/x）且问的是它们的交点/位置关系：用 two-curves-intersect，'
      + 'curves 给这两条曲线（两条都要给，少一条就画不全）。'
      + '\n3. intent 必须从所选画板 canAnswer 数组里挑**某一整项**，逐字照抄、一个字都不能改，也不能把两项拼起来。'
      + 'intent 只决定画布上标注哪句话，不代表「这张图有用」。'
      + '\n4. params 必须能从题面原样读出、或由题面表达式直接换算（如 y=x²-4x+3 配方得 a=1,h=2,k=-1）。'
      + '**不许编造题面没有的数**。'
      + '\n5. 只有一种情况给 match=null：**题面里根本没有能画出来的函数表达式**（纯文字概念、几何图形、纯方程不等式无函数式、'
      + '表格或统计数据等）。此时 params 给 {}，intent 给 ""，reason 写「题面没有可画出的函数表达式」。'
      + '不要因为「画出来对理解帮助不大」而给 null —— 那不是你该判断的事。'
      + '\n6. 代数操作题（配方法、化顶点式、因式分解、解方程）题面里的函数照样画：'
      + '例如「把 y=x²-4x+3 化为顶点式」，提取 a=1,h=2,k=-1，选 quadratic-vertex，intent 取「顶点坐标」。';
  }

  function userPrompt(prompt, capabilities) {
    const caps = capabilities || Funclab.CAPABILITIES;
    const capText = Object.keys(caps).map(function (name) {
      const c = caps[name];
      return '- ' + name
        + '\n  能回答: ' + c.canAnswer.join('、')
        + '\n  参数: ' + c.params.join(',')
        + (c.paramsDoc ? '\n  参数格式: ' + c.paramsDoc : '')
        + '\n  说明: ' + c.note;
    }).join('\n');
    return '可用画板：\n' + capText + '\n\n题目：' + String(prompt || '');
  }

  /** 从模型输出里抠第一个 JSON 对象（容忍代码块围栏和前后废话） */
  function extractJson(text) {
    const s = String(text || '');
    const m = s.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch (e) { return null; }
  }

  /** 一次性 LLM 调用。失败一律 reject（上层 catch 成 null），不在这一层混入业务判断 */
  function callGateway(prompt, capabilities, opts) {
    const o = opts || {};
    const fetchImpl = o.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    if (!fetchImpl) return Promise.reject(new Error('no fetch'));
    const body = {
      model: o.model || MODEL,
      max_tokens: o.maxTokens || MAX_TOKENS,
      temperature: 0,
      messages: [
        { role: 'system', content: systemPrompt({ lenient: !!o.lenient }) },
        { role: 'user', content: userPrompt(prompt, capabilities) }
      ]
    };
    const init = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    };
    const timeout = o.timeoutMs == null ? TIMEOUT_MS : o.timeoutMs;
    let timer = null;
    if (timeout > 0 && typeof AbortController !== 'undefined') {
      const ac = new AbortController();
      init.signal = ac.signal;
      timer = setTimeout(function () { try { ac.abort(); } catch (e) { /* ignore */ } }, timeout);
    }
    return Promise.resolve()
      .then(function () { return fetchImpl(o.proxy || PROXY, init); })
      .then(function (resp) {
        if (!resp || !resp.ok) throw new Error('http ' + (resp && resp.status));
        return resp.json();
      })
      .then(function (data) {
        const c = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        const obj = extractJson(c);
        if (!obj) throw new Error('bad json');
        return obj;
      })
      .then(
        function (v) { if (timer) clearTimeout(timer); return v; },
        function (e) { if (timer) clearTimeout(timer); throw e; }
      );
  }

  /* ============================================================ 对外主入口 */

  /** 同题并发去重：同一个 itemId/题面同时在飞时只发一次请求 */
  const inflight = {};

  /** 最近一次调用失败的原因（诊断用；UI 不依赖它） */
  let lastError = null;
  function getLastError() { return lastError; }

  /* 最近一次 resolve 的「为什么没挂上」——给 UI 分文案用（卡 t_f80f900e 三条文案）。
   * 不改 resolve 的返回契约（仍返回 null），只额外旁路记录：
   *   kind = 'rejected'（LLM 明确拒绝 / 参数校验不过）| 'offline'（网关失败、非 200、坏 JSON、超时）
   * 每次 resolve 进入时清空，避免下一题读到上一题的残留状态。 */
  let lastFailure = null;
  function getLastFailure() { return lastFailure; }

  /** 单次调用；失败重试（只重试传输/解析失败，LLM 明确拒绝不重试） */
  function callWithRetry(prompt, caps, o, attempt) {
    const n = o.retries == null ? 1 : Math.max(0, Number(o.retries) || 0);
    const cur = attempt || 0;
    return callGateway(prompt, caps, o).catch(function (e) {
      if (cur >= n) throw e;
      // 网关抖动（socket closed / 500 / 截断）重试一次就够，不做指数退避
      return new Promise(function (res) { setTimeout(res, 400); }).then(function () {
        return callWithRetry(prompt, caps, o, cur + 1);
      });
    });
  }

  /**
   * matchLab(prompt, capabilities, opts) → Promise<choice|null>
   *   choice = {match, params, intent, reason, verified, from:'llm'|'cache', why?:[]}
   *   返回 null 的三种情况：网关失败 / 非 200 / JSON 解析失败（含超时）。
   *   LLM 明确拒绝时返回 {match:null, reason:...}（调用方据此不挂图，审计脚本据此统计"拒绝数"）。
   *   opts: {itemId, capabilities, fetchImpl, proxy, model, timeoutMs, maxTokens, noCache}
   */
  function matchLab(prompt, capabilities, opts) {
    const o = opts || {};
    const caps = capabilities || (Funclab && Funclab.CAPABILITIES) || {};
    const itemId = o.itemId ? String(o.itemId) : '';
    const cacheKey = o.lenient ? LENIENT_CACHE_KEY : CACHE_KEY;
    if (!Funclab || !Funclab.CAPABILITIES) return Promise.resolve(null);

    // 缓存优先（只可能是校验通过的结果）—— 但**必须重新校验**：
    // 能力清单会在代码里演进（画板改名/下线，如 linear-shift），旧缓存里可能留着已下线的画板名。
    // 校验不过就丢掉这条缓存，走真实请求。
    if (itemId && !o.noCache) {
      const hit = cacheGet(itemId, cacheKey);
      if (hit) {
        const v = verifyParams(prompt, hit);
        if (v.ok) return Promise.resolve(Object.assign({ verified: true, from: 'cache' }, hit));
        cacheDrop(itemId, cacheKey);
      }
    }
    // 去重 key 必须区分 lenient：同一题正常/宽松两种请求同时飞，结果完全不同（一个是 null 一个能挂），
    // 共用 key 会让后到的调用方拿到别人的结果。
    const key = (o.lenient ? 'L|' : '') + (itemId || String(prompt || ''));
    if (inflight[key]) return inflight[key];

    const p = callWithRetry(prompt, caps, o).then(function (obj) {
      // 模型偶尔把「不挂」写成字符串 "null"/"none"/"无"：一律当 LLM 拒绝，别当画板名
      const rawMatch = obj.match == null ? null : String(obj.match).trim();
      const isNullish = rawMatch == null || /^(null|none|nil|undefined|无|不挂|不挂图)$/i.test(rawMatch);
      const choice = {
        match: isNullish ? null : rawMatch,
        params: (obj.params && typeof obj.params === 'object') ? obj.params : {},
        intent: obj.intent == null ? '' : String(obj.intent),
        reason: obj.reason == null ? '' : String(obj.reason),
        from: 'llm'
      };
      if (!choice.match) {
        // LLM 明确说「不挂」：不缓存（能力清单改动后应该有机会重新判断）
        choice.verified = false;
        return choice;
      }
      const v = verifyParams(prompt, choice);
      choice.verified = v.ok;
      choice.why = v.why;
      if (v.ok && !o.noCache && itemId) cachePut(itemId, choice, cacheKey);   // 只缓存成功
      return choice;
    }).catch(function (e) { lastError = e; return null; });

    inflight[key] = p;
    p.then(function () { delete inflight[key]; }, function () { delete inflight[key]; });
    return p;
  }

  /**
   * resolve({prompt, lab, itemId}, opts) → Promise<挂载配置|null>
   *   挂载配置 = {type, lab, intent, ...参数, base, xMin?, xMax?}，可直接喂 Funclab.mount()。
   *   lab 是 labForScene 给出的候选（没有候选就不用问了：题库里根本没有可画的函数）。
   *   降级：LLM 失败 / 拒绝 / 参数校验不过 → null（不挂图，不回退旧逻辑）。
   */
  /**
   * resolve({prompt, lab, itemId, lenient?}, opts) → Promise<挂载配置|null>
   *   挂载配置 = {type, lab, intent, ...参数, base, xMin?, xMax?}，可直接喂 Funclab.mount()。
   *   lab 是 labForScene 给出的候选（没有候选就不用问了：题库里根本没有可画的函数）。
   *   降级：LLM 失败 / 拒绝 / 参数校验不过 → null（不挂图，不回退旧逻辑）。
   *
   *   lenient（卡 t_f80f900e / t_4eed15b3）：学生自己点「画图给我看」时才传 true。
   *     系统不评判「这图有没有用」（学生点了按钮就是答案），只判「能不能画」：
   *     LLM 只做参数提取，画板白名单 / intent 白名单 / verifyParams 代回校验 / 网关失败即不挂，
   *     全部与默认路径一致。缓存与去重都走独立命名空间，见 CACHE_KEY 注释。
   *
   *   为什么「没挂上」要旁路记录：调用方要分三种文案（挂上了 / 这题的图形我暂时画不出来 / 画图功能暂时用不了），
   *   而最后一个状态只差在「LLM 说题面没有可画的函数，或参数校验不过」与「网关失败」上。改返回契约会波及现有调用方与测试，
   *   所以 resolve 仍返回 null，另用 lastFailure() 记录 kind。注意这是模块级状态：
   *   并发调用不同题时以最后一次完成为准（UI 侧用 explainTick 竞态令牌兜住）。
   */
  function resolve(input, opts) {
    const inp = input || {};
    const prompt = inp.prompt;
    const cand = inp.lab;
    const lenient = !!inp.lenient;
    lastFailure = null;   // 每次进入清空，避免调用方读到上一题的残留
    if (!Funclab || !Funclab.CAPABILITIES || !cand || !cand.type) {
      lastFailure = { kind: 'rejected', lenient: lenient, reason: 'no-candidate' };
      return Promise.resolve(null);
    }
    const type = cand.type;
    const caps = Funclab.capabilitiesFor(type);
    if (!Object.keys(caps).length) {
      lastFailure = { kind: 'rejected', lenient: lenient, reason: 'no-capability' };
      return Promise.resolve(null);
    }
    const o = Object.assign({}, opts, { itemId: inp.itemId, lenient: lenient });
    // lenient 先复用正常缓存里的强结果（严格通过 = 在宽松标准下也成立），省一次调用；
    // 但**不写回**正常缓存，也不把 lenient 表喂给正常路径（单向流动，见 CACHE_KEY 注释）。
    if (lenient && inp.itemId && !o.noCache) {
      const hit = cacheGet(inp.itemId, CACHE_KEY);
      if (hit && verifyParams(prompt, hit).ok) {
        const strictCfg = buildCfg(type, cand, hit);
        if (strictCfg) return Promise.resolve(strictCfg);
      }
    }
    return matchLab(prompt, caps, o).then(function (choice) {
      if (!choice) {
        lastFailure = { kind: 'offline', lenient: lenient, reason: lastError ? (lastError.message || String(lastError)) : 'gateway' };
        return null;
      }
      if (!choice.match) {
        lastFailure = { kind: 'rejected', lenient: lenient, reason: choice.reason || '' };
        return null;
      }
      if (!choice.verified) {
        lastFailure = { kind: 'rejected', lenient: lenient, reason: (choice.why || []).join('; ') || 'verify-failed' };
        return null;
      }
      const cfg = buildCfg(type, cand, choice);
      if (!cfg) {
        lastFailure = { kind: 'rejected', lenient: lenient, reason: 'intent-not-supported' };
        return null;
      }
      lastFailure = null;
      return cfg;
    }).catch(function () { return null; });
  }

  /** choice → mount 配置（两条入口共用，避免 lenient 复制一份组装逻辑） */
  function buildCfg(type, cand, choice) {
    if (!choice || !choice.match || !Funclab.CAPABILITIES[choice.match]) return null;
    const params = {};
    (Funclab.CAPABILITIES[choice.match].params || []).forEach(function (k) {
      /* 多曲线（t_1d3fe77a）：curves 是对象数组，**不能 Number()** ——
       * Number([{...}]) 会变成 NaN，画板挂不上（也会把 LLM 给的两条曲线丢掉）。
       * 深拷贝一层，防止调用方之后改配置影响缓存里的对象。 */
      if (k === 'curves' && Array.isArray(choice.params[k])) {
        /* 与 verifyParams 同一套规约：LLM 给的可能是表达式串，这里转成对象再交给 mount
         * （verifyParams 已经用同一函数判定过，能走到这里的都解析得出来） */
        params.curves = choice.params[k].map(function (c) {
          if (c && typeof c === 'object' && !Array.isArray(c)) return Object.assign({}, c);
          const co = coerceCurveSpec(c);
          return co.ok ? co.curve : null;
        }).filter(Boolean);
        return;
      }
      params[k] = Number(choice.params[k]);
    });
    const cfg = Object.assign({ type: type, lab: choice.match, intent: choice.intent }, params);
    // base（原曲线）继续由 funclab 的 baseOf 决定；候选里带了就带上，不带就是单曲线
    if (cand.base) cfg.base = cand.base;
    // mount 会再校验一遍 lab/intent/params；这里提前挡掉，避免调用方拿到 null 还去 append
    if (!Funclab.intentSupported(cfg.lab, cfg.intent)) return null;
    if (!Funclab.noteText(cfg.lab, cfg.intent, cfg)) return null;
    return cfg;
  }

  return {
    PROXY: PROXY, MODEL: MODEL, CACHE_KEY: CACHE_KEY, LENIENT_CACHE_KEY: LENIENT_CACHE_KEY,
    MAX_TOKENS: MAX_TOKENS, EPS: EPS,
    matchLab: matchLab, resolve: resolve, verifyParams: verifyParams,
    /* t_1d3fe77a：choice → mount 配置（含 curves 字符串→对象规约），供测试直接验证 */
    buildCfg: buildCfg,
    getLastError: getLastError, lastFailure: getLastFailure,
    promptInterval: promptInterval, expandVertex: expandVertex,
    systemPrompt: systemPrompt, userPrompt: userPrompt, extractJson: extractJson,
    setStore: setStore, defaultStore: defaultStore, validEntry: validEntry
  };
});
