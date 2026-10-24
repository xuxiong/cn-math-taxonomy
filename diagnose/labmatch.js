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
   * lenient 复用它一定安全。因此两张表单向流动：strict → lenient（可复用），lenient -/-> strict。 */
  const LENIENT_CACHE_KEY = 'cnmLabMatchLenient.v1';
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
   * 与默认规则的唯一差别：第 1 条从「题目所问必须在 canAnswer 里」放宽为
   * 「能不能画出一张对学生理解这道题有帮助的图」。其余（intent 逐字取自 canAnswer、
   * params 只来自题面、不许编造）**一个字都不放宽** —— 参数最终还要过 verifyParams 代回校验。
   * 规则 4、5 故意保留：宁可诚实说画不了，也不许硬凑一张误导的图。
   */
  function lenientSystemPrompt() {
    return '你是数学教学系统的画板匹配器。这次的场景不同：学生做完题、看完解析后，**自己要求看一眼图**。'
      + '\n只输出 JSON，不要任何解释文字、不要 Markdown 代码块。格式严格为：'
      + '\n{"match":"画板名或null","params":{},"intent":"","reason":"一句话理由"}'
      + '\n规则：'
      + '\n1. 判断标准放宽为：**能不能画出一张对学生理解这道题有帮助的图**（哪怕题目本身问的不是图形）。'
      + '例如题目「把 y=x²-4x+3 化为顶点式」：配方是代数操作、画板不教配方，但学生想看顶点在哪、开口朝哪，'
      + 'quadratic-vertex 是能帮上忙的，此时应给 match（intent 选「顶点坐标」）。'
      + '\n2. intent 仍然必须是所选画板 canAnswer 数组里的**某一整项**，逐字照抄、一个字都不能改，也不能把两项拼起来。'
      + '\n3. params 仍然必须能从题面原样读出、或由题面表达式直接换算（如 y=x²-4x+3 配方得 a=1,h=2,k=-1）。'
      + '**不许编造题面没有的数**；题面给了几个函数时，只用与题目直接相关的那个。'
      + '\n4. 即使放宽，画板也只负责"看见关系"：如果题面里根本没有能画出图的表达式，或者画出来的图与题目完全无关、'
      + '只会误导学生，才给 match=null，不要硬凑一张图。'
      + '\n5. match 为 null 时 params 给 {}，intent 给 ""，reason 写明"画不出对理解这道题有帮助的图"。';
  }

  function userPrompt(prompt, capabilities) {
    const caps = capabilities || Funclab.CAPABILITIES;
    const capText = Object.keys(caps).map(function (name) {
      const c = caps[name];
      return '- ' + name
        + '\n  能回答: ' + c.canAnswer.join('、')
        + '\n  参数: ' + c.params.join(',')
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
   *   lenient（卡 t_f80f900e）：学生自己点「画图给我看」时才传 true。
   *     放宽的**只有** system prompt 里「题目所问必须在 canAnswer 里」→「能不能画出一张有帮助的图」；
   *     画板白名单 / intent 白名单 / verifyParams 代回校验 / 网关失败即不挂，全部与默认路径一致。
   *     缓存与去重都走独立命名空间，见 CACHE_KEY 注释。
   *
   *   为什么「没挂上」要旁路记录：调用方要分三种文案（挂上了 / 图帮不上忙 / 画图功能暂时用不了），
   *   而最后一个状态只差在「LLM 拒绝」与「网关失败」上。改返回契约会波及现有调用方与测试，
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
    getLastError: getLastError, lastFailure: getLastFailure,
    promptInterval: promptInterval, expandVertex: expandVertex,
    systemPrompt: systemPrompt, userPrompt: userPrompt, extractJson: extractJson,
    setStore: setStore, defaultStore: defaultStore, validEntry: validEntry
  };
});
