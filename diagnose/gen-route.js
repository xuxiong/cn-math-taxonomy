/* 「再来一道」的路由层（卡 E / t_0772253d）：construct / verify(LLM) / 不出题 三选一。
 *
 * 为什么需要这一层：卡 D 的「再来一道」走的是 O3 老路径 llm-variants.genLLMVariant ——
 * 那条路只认 3 个知识点（cnm_221 配方 / cnm_222 公式 / cnm_224 因式分解），
 * 其余 1000+ 个点点了按钮只会拿到「AI 这次没出出来」。卡 C 把出题做成了参数化管线
 * （llm-recipes + llm-gates + llm-gen，吃 plan 条目），卡 B 做成了确定性构造器
 * （construct.js，零网络）。这一层负责「按 plan 给这个点派活」，不复制它们的任何逻辑。
 *
 * 三条边界的硬约束（卡 D 的红线，回退即红）：
 *   - human-only / plan 查不到 的点：**不发任何请求**，只给一句确定提示，绝不静默降级去 O3；
 *   - 只有过了七道门的题才打 llmVerified（练习队列准入要它，见 llm-variants._admitToPracticeQueue）；
 *   - 文本规范化只有一处（卡 t_42e5978b 的 textfmt，在 llm-gen 门禁之前跑），本层不再洗第二遍。
 *
 * plan 从哪来：浏览器没有 tmp/gap-plan.json，只有构建期剪出来的 data/gen-plan.json
 * （scripts/build-gen-plan-lite.mjs，只含 verify|construct 的 1084 个点）。human-only 的
 * 2213 个点在包里是「缺席」—— 缺席即不出题，与 plan 里查不到走同一条分支。
 *
 * 无依赖 UMD：不 require 任何别的模块（recipes / gates / gen / construct 都由调用方注入），
 * 这样本文件可以单独懒加载 —— human-only 的点连一个 LLM 模块都不用下载。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.DiagGenRoute = factory();
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this),
function () {
  'use strict';

  var VERSION = 1;
  var PLAN_URL = '../data/gen-plan.json';
  var PLAN_SCHEMA = 'gen-plan-lite/1';
  /** 与 scripts/build-gen-plan-lite.mjs 的 DESC_LITE_MAX 同一个界：
   *  recipes.recipeFromPlanEntry 用 descendants.length < 50 决定走黑名单还是年级章节白名单，
   *  构建期把 descendants 截到 50 仍能保持两侧判定不变（≥50 依旧 ≥50）。 */
  var DESC_LITE_MAX = 50;
  /** 现有题只喂这么多条（id + 题面，不含答案）。实测单点题库 4–8 条；
   *  上限是为了 prompt 体积可控 —— 全部灌进去会把 prompt 撑大一倍，闸门收益却不增。 */
  var EXISTING_MAX = 8;
  /** 构造器按难度重抽的上限：genConstruct 的难度从 RNG 流里取并按 attempt 轮转，
   *  没有难度入参。用户点了「难一点」就多扫几个 index 找同档题，扫不到就用第一道（不退化成不出题）。 */
  var CONSTRUCT_SCAN = 8;

  /* 确定性提示语：文案与卡 D 的既有口径一致（既有测试钉着那几句），只多一句「暂时只能做原题」。 */
  var NOTICE = {
    'plan-missing': '这个知识点暂时只能做原题：题库判定它没有可机验的题（或题型需要老师判断），不交给 AI 出题。',
    'human-only': '这个知识点暂时只能做原题：题库判定它没有可机验的题，不交给 AI 出题。',
    'verify-without-verifier': '这个知识点暂时只能做原题：没有可用的验证方式。',
    'construct-unsupported': '这个知识点暂时只能做原题：没有对应的题目构造函数。',
    'llm-modules-missing': '出题组件没有加载出来，请刷新页面重试。'
  };
  var NOTICE_CONSTRUCT_OK = '已排到下一题（本机生成，零网络）。';
  var NOTICE_CONSTRUCT_FAIL = '本机构造器这次没造出题（和已有题撞了骨架），先接着做原来的题。';
  var NOTICE_LLM_FAIL = 'AI 这次没出出来（验证没通过），先接着做原来的题。';
  var NOTICE_GATEWAY = 'AI 现在出不了题（网关不通），先接着做原来的题。';

  /* ================================================================
   * plan：解析 / 取一次 / 查表
   * ================================================================ */

  /**
   * 解析 gen-plan-lite。schema 不对直接抛 —— 悄悄按「查不到 = 不出题」处理会把
   * 整站「再来一道」变成一句提示，而这在界面上看起来和「这个点确实没工单」一模一样。
   * @param {string|object} json
   * @returns {{schema:string, counts:object, byId:object, nodes:Array, size:number}}
   */
  function parsePlan(json) {
    var doc = typeof json === 'string' ? JSON.parse(json) : json;
    if (!doc || doc.schema !== PLAN_SCHEMA) {
      throw new Error('gen-route: plan schema 不是 ' + PLAN_SCHEMA + '（拿到 ' + (doc && doc.schema) + '）');
    }
    var nodes = Array.isArray(doc.nodes) ? doc.nodes : [];
    var byId = Object.create(null);
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n && n.topicId) byId[n.topicId] = n;
    }
    return { schema: doc.schema, counts: doc.counts || {}, byId: byId, nodes: nodes, size: nodes.length };
  }

  var _planPromise = null;
  /**
   * 取一次 plan 并缓存（同一页面只发一次请求；SW 对 .json 走 staleWhileRevalidate）。
   * @param {object} deps - {fetch}
   * @returns {Promise<object|null>} 失败返回 null（调用方按「查不到」处理，不抛）
   */
  function ensurePlan(deps) {
    if (_planPromise) return _planPromise;
    deps = deps || {};
    var f = deps.fetch || (typeof fetch === 'function' ? fetch : null);
    if (!f) return Promise.resolve(null);
    _planPromise = Promise.resolve()
      .then(function () { return f(PLAN_URL); })
      .then(function (r) {
        if (!r || !r.ok) throw new Error('gen-plan 取不到：HTTP ' + (r && r.status));
        return r.json();
      })
      .then(function (json) { return parsePlan(json); })
      .catch(function (err) {
        if (typeof console !== 'undefined' && console.warn) console.warn('[gen-route] ' + (err && err.message));
        _planPromise = null;   // 失败清缓存，下次点击可重试
        return null;
      });
    return _planPromise;
  }

  /* ================================================================
   * 路由判定（纯数据，不依赖任何模块）
   * ================================================================ */

  /**
   * 这个点该怎么出题。判定只看 plan 条目，不看模块是否加载 ——
   * 模块检查放在 ask() 里，避免「模块没加载」被误报成「这个点不支持」。
   * @param {object} index - parsePlan 的返回值
   * @param {string} topicId
   * @returns {{action:'construct'|'llm'|'none', reason:string, strategy:string|null, entry:object|null}}
   */
  function decide(index, topicId) {
    var e = index && index.byId ? index.byId[topicId] : null;
    if (!e) return { action: 'none', reason: 'plan-missing', strategy: null, entry: null };
    if (e.strategy === 'construct') {
      return { action: 'construct', reason: 'strategy-construct', strategy: 'construct', entry: e };
    }
    if (e.strategy === 'verify') {
      if (!e.verifier) return { action: 'none', reason: 'verify-without-verifier', strategy: 'verify', entry: e };
      return { action: 'llm', reason: 'strategy-verify', strategy: 'verify', entry: e };
    }
    if (e.strategy === 'human-only') return { action: 'none', reason: 'human-only', strategy: 'human-only', entry: e };
    return { action: 'none', reason: 'unknown-strategy:' + e.strategy, strategy: e.strategy, entry: e };
  }

  /**
   * 轻量节点 → recipes.recipeFromPlanEntry 认的 plan 条目形状。
   * gaps / prereqClosure / descendants 三个字段名必须与 plan 一致（recipe 直接读它们）；
   * descendantsLite 是构建期的截断版（≤50 条），route 判定依赖的「≥50 / <50」同侧性不变。
   */
  function planEntryOf(node) {
    if (!node) return null;
    return {
      topicId: node.topicId,
      strategy: node.strategy,
      verifier: node.verifier || null,
      gaps: Array.isArray(node.gaps) ? node.gaps : [],
      prereqClosure: Array.isArray(node.prereqClosure) ? node.prereqClosure : [],
      descendants: Array.isArray(node.descendantsLite) ? node.descendantsLite : []
    };
  }

  /**
   * 把用户点的那一档挪到难度轮转的第一位（recipe.constraints.difficulties 是原地数组）。
   * 为什么改数组而不是别的地方：gen() 只认 difficulties[0] 作为默认档，
   * 重试时难度不变（重试只换 seed），所以「用户点哪档」唯一能落地的地方就是这里。
   * @returns {object} 同一个 recipe（便于链式）
   */
  function rotateDifficulty(recipe, want) {
    if (!recipe || !want) return recipe;
    var c = recipe.constraints || (recipe.constraints = {});
    var ds = Array.isArray(c.difficulties) ? c.difficulties.slice() : [];
    var at = ds.indexOf(want);
    if (at > 0) { ds.splice(at, 1); ds.unshift(want); c.difficulties = ds; }
    else if (at < 0) { ds.unshift(want); c.difficulties = ds; }   // plan 没给这一档（理论上不会）：放最前
    return recipe;
  }

  /* ================================================================
   * 上下文（给 llm-gen 的 ctx：topic / existing / standards / vocabulary / corpus）
   * ================================================================ */

  /**
   * 拼 llm-gen 需要的 ctx。纯函数，不取数据 —— 取数据是调用方（app-flow）的事，
   * 因为 topics-detail / 课标 / 题库都在首屏层的状态里。
   * @param {object} o - {topic, detail, bank, stdById, vocabulary, gates, existingMax, subject}
   * @returns {object|null} 缺 gates 或缺 topicId 返回 null（调用方按 context-missing 报）
   */
  function buildContext(o) {
    o = o || {};
    var topic = o.topic || {};
    var gates = o.gates;
    if (!topic.id || !gates) return null;
    var detail = o.detail || {};
    var bank = Array.isArray(o.bank) ? o.bank : [];

    var existing = [];
    for (var i = 0; i < bank.length && existing.length < (o.existingMax || EXISTING_MAX); i++) {
      var q = bank[i];
      if (!q || !q.id || !q.prompt) continue;
      existing.push({ id: q.id, prompt: q.prompt });   // 只给 id 与题面，不给答案（constraints.existingAnswersVisible=false）
    }

    /* 课标：detail.standards 是 [{id, confidence}] 引用，正文在 stdById（cn-curriculum-standards.json）。
     * 拿不到正文时仍把 id 传下去 —— prompt 里至少能列出「挂了哪几条课标」。 */
    var refs = Array.isArray(detail.standards) ? detail.standards
      : (Array.isArray(topic.standards) ? topic.standards : []);
    var byId = o.stdById || {};
    var standards = [];
    for (var j = 0; j < refs.length; j++) {
      var ref = refs[j];
      if (!ref || !ref.id) continue;
      var body = byId[ref.id] || null;
      standards.push({
        id: ref.id,
        text: (body && (body.text || body.title || body.content)) || '',
        confidence: ref.confidence || (body && body.confidence) || 'unknown'
      });
    }

    var vocabulary = Array.isArray(o.vocabulary) ? o.vocabulary : [];
    var ctx = {
      topic: {
        id: topic.id,
        name: topic.name || '',
        subject: o.subject || topic.subject || '',
        grade: topic.grade != null ? topic.grade : null,
        chapter: topic.chapter || '',
        description: detail.description || topic.description || '',
        mastery_criteria: detail.mastery_criteria || topic.mastery_criteria || ''
      },
      existing: existing,
      standards: standards,
      vocabulary: vocabulary,
      /* 撞题/换数闸门的语料：本知识点所在章节的真题（已到货的那一份）。
       * 语料只含本章节而不是全库 13335 题 —— 全库要再拉 1MB+，而撞题在跨章节上极罕见。
       * 这一条是「本卡没证明什么」里的已知缺口，写在卡评论里。 */
      corpus: gates.buildIndex({ questions: bank })
    };
    return ctx;
  }

  /**
   * 按 questions-index 的 key 取 topics-detail 分片（description / mastery_criteria / standards）。
   * 拿不到返回 null（出题照跑，只是 prompt 少了知识点描述）—— 不让它变成不出题。
   * @param {object} o - {fetch, index, key, base}
   * @returns {Promise<object|null>}
   */
  function fetchDetail(o) {
    o = o || {};
    var f = o.fetch || (typeof fetch === 'function' ? fetch : null);
    var index = o.index || null;
    var key = o.key || null;
    if (!f || !index || !key) return Promise.resolve(null);
    var file = typeof index[key] === 'string' ? index[key] : null;
    if (!file) return Promise.resolve(null);
    var base = o.base || '../data/topics-detail/';
    return Promise.resolve()
      .then(function () { return f(base + file); })
      .then(function (r) {
        if (!r || !r.ok) return null;
        return r.json();
      })
      .then(function (doc) {
        if (!doc) return null;
        /* topics-detail 分片是「按章节一包」：{topics:[{id,...}]} 或直接是数组，两种都认。 */
        var list = Array.isArray(doc) ? doc : (Array.isArray(doc.topics) ? doc.topics : null);
        if (!list) return doc;
        for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === o.topicId) return list[i];
        return null;
      })
      .catch(function () { return null; });
  }

  /* ================================================================
   * 出题
   * ================================================================ */

  /** 过了七道门的 LLM 题：打上卡 D 的准入标。llmVerified 的语义就是「过了验证门」。 */
  function markVerified(q) {
    if (!q) return q;
    q.variant = true;
    q.variantSource = q.variantSource || 'llm';
    q.llmVerified = true;
    return q;
  }

  /** 本机构造的题：是变式，但不是 AI 题 —— 不打 AI 标、不打 llmVerified（准入天然放行）。 */
  function markLocal(q) {
    if (!q) return q;
    q.variant = true;
    q.variantSource = q.variantSource || 'construct';
    return q;
  }

  /* 管线实例按 pipelineKey 缓存：缓存池 / 同批去重 / 统计都在实例里，
   * 每次点击新建一个实例等于把「同一批里别重复」这条闸门废掉。 */
  var _pipelines = Object.create(null);
  function pipelineFor(deps) {
    var key = deps.pipelineKey || 'default';
    if (_pipelines[key]) return _pipelines[key];
    _pipelines[key] = deps.gen.createPipeline({
      transport: deps.transport, now: deps.now, maxRetries: deps.maxRetries, poolMax: deps.poolMax
    });
    return _pipelines[key];
  }

  function askConstruct(o, deps) {
    var C = deps.construct;
    if (!C || typeof C.supports !== 'function' || !C.supports(o.topicId)) {
      return Promise.resolve({ action: 'construct', question: null, reason: 'construct-unsupported', topicId: o.topicId });
    }
    var base = o.index != null ? Number(o.index) : 0;
    var best = null;
    var fallback = null;
    for (var i = 0; i < CONSTRUCT_SCAN; i++) {
      var cand = null;
      try {
        cand = C.genConstruct(o.topicId, base + i, {
          seed: o.seed, avoidPrompts: o.avoidPrompts, avoidSkeletons: o.avoidSkeletons
        });
      } catch (e) { cand = null; }
      if (!cand) continue;
      if (!fallback) fallback = cand;
      if (!o.difficulty || cand.difficulty === o.difficulty) { best = cand; break; }
    }
    if (!best) best = fallback;
    if (!best) return Promise.resolve({ action: 'construct', question: null, reason: 'construct-exhausted', topicId: o.topicId });
    return Promise.resolve({
      action: 'construct', question: markLocal(best), reason: 'produced', topicId: o.topicId,
      difficulty: best.difficulty, requested: o.difficulty || null
    });
  }

  function askLLM(o, d, deps) {
    var R = deps.recipes;
    var G = deps.gen;
    if (!R || !G || typeof R.recipeFromPlanEntry !== 'function') {
      return Promise.resolve({ action: 'llm', question: null, reason: 'llm-modules-missing', topicId: o.topicId });
    }
    var recipe = R.recipeFromPlanEntry(planEntryOf(d.entry));
    if (!recipe) return Promise.resolve({ action: 'llm', question: null, reason: 'recipe-unsupported', topicId: o.topicId });
    rotateDifficulty(recipe, o.difficulty);
    if (!o.ctx) return Promise.resolve({ action: 'llm', question: null, reason: 'context-missing', topicId: o.topicId });

    var pipeline = pipelineFor(deps);
    return pipeline.gen(recipe, o.ctx, { difficulty: o.difficulty, seed: o.seed }).then(function (r) {
      if (!r || !r.ok || !r.question) {
        return {
          action: 'llm', question: null, topicId: o.topicId,
          reason: (r && r.reason) || 'no-result',
          attempts: (r && r.attempts) || 0,
          checks: (r && r.checks) || [],
          recipe: recipe
        };
      }
      return {
        action: 'llm', question: markVerified(r.question), reason: 'produced', topicId: o.topicId,
        attempts: r.attempts, checks: r.checks, recipe: recipe
      };
    }, function (err) {
      return {
        action: 'llm', question: null, topicId: o.topicId,
        reason: 'transport-error:' + (err && err.message ? err.message : String(err)), attempts: 0, checks: []
      };
    });
  }

  /**
   * 「再来一道」的唯一入口。
   * @param {object} o - {topicId, difficulty, seed, ctx, plan, index, indexPlan, deps}
   *   deps: {construct, recipes, gen, gates, transport, now, pipelineKey, maxRetries, poolMax}
   * @returns {Promise<{action:string, question:object|null, reason:string}>}
   */
  function ask(o) {
    o = o || {};
    var deps = o.deps || {};
    var index = o.plan || deps.plan || null;
    var d = decide(index, o.topicId);
    if (d.action === 'none') {
      return Promise.resolve({ action: 'none', question: null, reason: d.reason, topicId: o.topicId, strategy: d.strategy });
    }
    if (d.action === 'construct') return askConstruct(o, deps).then(withStrategy(d));
    return askLLM(o, d, deps).then(withStrategy(d));
  }

  function withStrategy(d) {
    return function (r) {
      r.strategy = d.strategy;
      r.planReason = d.reason;
      return r;
    };
  }

  /**
   * 结果 → 给用户看的那一句。文案单点在这里，app-flow 不再拼字符串
   * （唯一的例外是 AI 标：它必须来自 LLMV.AI_DRAFT_BADGE 这个单一常量，由调用方注入）。
   * @param {object} r - ask() 的返回值
   * @param {object} opts - {badgeText}
   */
  function noticeFor(r, opts) {
    opts = opts || {};
    var badge = opts.badgeText || 'AI 现出题·未审核';
    if (!r) return NOTICE['plan-missing'];
    if (r.question) {
      return r.action === 'construct' ? NOTICE_CONSTRUCT_OK : badge + '，已排到下一题。';
    }
    if (r.action === 'none') return NOTICE[r.reason] || NOTICE['plan-missing'];
    if (r.reason === 'gateway-unreachable') return NOTICE_GATEWAY;
    if (r.action === 'construct') return NOTICE_CONSTRUCT_FAIL;
    if (r.reason === 'llm-modules-missing') return NOTICE['llm-modules-missing'];
    return NOTICE_LLM_FAIL;
  }

  /** 测试/换科/清缓存用：把 plan 与管线实例一起丢掉。 */
  function reset() {
    _planPromise = null;
    _pipelines = Object.create(null);
  }

  return {
    VERSION: VERSION,
    PLAN_URL: PLAN_URL,
    PLAN_SCHEMA: PLAN_SCHEMA,
    DESC_LITE_MAX: DESC_LITE_MAX,
    EXISTING_MAX: EXISTING_MAX,
    NOTICE: NOTICE,
    parsePlan: parsePlan,
    ensurePlan: ensurePlan,
    decide: decide,
    planEntryOf: planEntryOf,
    rotateDifficulty: rotateDifficulty,
    buildContext: buildContext,
    fetchDetail: fetchDetail,
    markVerified: markVerified,
    markLocal: markLocal,
    ask: ask,
    noticeFor: noticeFor,
    reset: reset
  };
});
