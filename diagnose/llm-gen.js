/* O3 出题管线的「编排层」（卡 C / t_faca95d0）：
 *   prompt（llm-recipes）→ 网关 1 次 → 解析 → 七道门（llm-gates）→ 不过重试（MAX_RETRIES=3）
 *   → 全不过返回 null（降级题库）→ 命中进缓存池（POOL_MAX=50）+ 批次索引。
 *
 * 与 llm-variants.js 的分工
 * -------------------------
 * llm-variants.js 是 O3 试点（3 族手写 prompt、只覆盖 cnm_221/222/224，且那三点在卡 A 的
 * plan 里是 strategy=construct，归卡 B）。本文件不碰它：新管线覆盖 plan.strategy=verify 的点，
 * 配方来自 llm-recipes.js，判据来自 llm-gates.js。llm-eval.js / engine.js / data/* 一行未改。
 *
 * 确定性（便于回放/对比）
 * ----------------------
 * 默认 seed = topicId + '|' + difficulty + '|attempt' + n，不含 Date.now；
 * 请求体只由 (recipe, ctx, seed) 决定 → 同输入同 seed 字节相同。createdAt 只在产物里（injectable now）。
 *
 * 安全
 * ----
 * - 网关地址/型号/max_tokens/超时全部来自 llm-config.js 与 llm-gateway.js，本文件零裸数字、零 URL。
 * - key 走 llm-config 的 localStorage / .env（服务端反代），本文件不读、不打印、不写日志。
 * - 产物只进内存批次 + 缓存池；落盘只允许 tmp/（writeBatch 会拒绝 data/ 路径）。
 *
 * UMD：window.DiagLLMGen / require。Node 下自行 require 三个子模块。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(
      require('./llm-recipes.js'), require('./llm-gates.js'),
      require('./llm-config.js'), require('./llm-gateway.js'),
      require('./textfmt.js')
    );
  } else {
    root.DiagLLMGen = factory(root.DiagLLMRecipes, root.DiagLLMGates, root.LLMConfig, root.DiagLLMGateway, root.CnmTextFmt);
  }
})(typeof self !== 'undefined' ? self : this, function (__recipes, __gates, __cfg, __gw, __textfmt) {
  'use strict';

  var recipes = __recipes;
  var gates = __gates;
  var CFG = __cfg || null;
  var gw = __gw || null;
  var textfmt = __textfmt || null;

  var VERSION = 1;

  var MAX_RETRIES = 3;

  var POOL_MAX = 50;

  var BATCH_SCHEMA = 'llm-batch/1';

  /* 采样温度：与 O3 试点一致（llm-variants.js 的 body.temperature），不是 max_tokens/超时类
   * 「必须单一真源」的常量；改它不影响截断或超时。 */
  var TEMPERATURE = 0.8;

  /* ================================================================
   * 请求体 / 解析
   * ================================================================ */

  /**
   * 构建请求体（纯函数）：同 (recipe, ctx, seed) → 字节相同的 JSON。
   * max_tokens 取 llm-config.js 的 maxTokens.variants（与 O3 一致），不写裸数字。
   */
  function buildRequestBody(recipe, ctx, opts) {
    opts = opts || {};
    var seed = opts.seed == null ? defaultSeed(recipe.topicId, opts.difficulty, opts.attempt) : opts.seed;
    var messages = recipes.buildMessages(recipe, ctx, { seed: seed });
    return {
      model: opts.model || (gw ? gw.MODEL : (CFG ? CFG.model : null)),
      messages: messages,
      max_tokens: opts.maxTokens != null ? opts.maxTokens : (CFG ? CFG.maxTokens.variants : null),
      temperature: opts.temperature != null ? opts.temperature : TEMPERATURE
    };
  }

  function defaultSeed(topicId, difficulty, attempt) {
    return topicId + '|' + (difficulty || 'standard') + '|attempt' + (attempt || 0);
  }

  /**
   * 从模型返回内容里取候选 JSON（同 llm-variants._parseCandidate 口径：正则提 {...} → JSON.parse）。
   * @returns {{ok:boolean, candidate:object|null, reason:string}}
   */
  function parseCandidate(content) {
    if (!content) return { ok: false, candidate: null, reason: 'empty-content' };
    var text = typeof content === 'string' ? content : String(content);
    var m = text.match(/\{[\s\S]*\}/);
    if (!m) return { ok: false, candidate: null, reason: 'no-json-object' };
    var j;
    try { j = JSON.parse(m[0]); } catch (e) { return { ok: false, candidate: null, reason: 'bad-json' }; }
    if (!j || typeof j !== 'object') return { ok: false, candidate: null, reason: 'not-an-object' };
    return { ok: true, candidate: j, reason: 'parsed' };
  }

  /**
   * 模型文本 → 展示形态（卡 t_42e5978b）。
   * 只洗「上屏字段」：prompt / answer / explanation / options。
   * verify 与 verifyType 不洗 —— verify 是给 llm-eval 求值用的机器表达式，
   * 把 `x^2` 洗成 `x²` 会让求值白名单只认 ASCII 的那半边口径漂移（见 textfmt.js 文件头）。
   * @param {object} candidate
   * @returns {object} 浅拷贝（不改模型返回的原对象）
   */
  function normalizeCandidate(candidate) {
    if (!candidate || typeof candidate !== 'object') return candidate;
    if (!textfmt || typeof textfmt.normalize !== 'function') return candidate;
    var out = {};
    for (var k in candidate) if (Object.prototype.hasOwnProperty.call(candidate, k)) out[k] = candidate[k];
    ['prompt', 'answer', 'explanation'].forEach(function (f) {
      if (typeof out[f] === 'string') out[f] = textfmt.normalize(out[f]);
    });
    if (Array.isArray(out.options)) {
      out.options = out.options.map(function (o) { return typeof o === 'string' ? textfmt.normalize(o) : o; });
    }
    if (Array.isArray(out.choices)) {
      out.choices = out.choices.map(function (o) { return typeof o === 'string' ? textfmt.normalize(o) : o; });
    }
    return out;
  }

  /* ================================================================
   * 默认传输层（真网关）：单层请求，不做 function calling 工具轮
   * ================================================================ */

  function defaultTransport(body) {
    if (!gw || typeof gw.postOnce !== 'function') return Promise.resolve(null);
    return gw.postOnce(body).then(function (data) {
      if (!data || !data.choices || !data.choices[0] || !data.choices[0].message) return null;
      return data.choices[0].message.content;
    });
  }

  /* ================================================================
   * 产物对象
   * ================================================================ */

  function buildQuestion(recipe, candidate, ctx, meta) {
    var topic = (ctx && ctx.topic) || {};
    return {
      id: recipe.topicId + '_lg' + (meta.index + 1),
      topicId: recipe.topicId,
      subject: topic.subject || null,
      grade: topic.grade != null ? topic.grade : null,
      difficulty: candidate.difficulty,
      type: 'numeric',
      prompt: candidate.prompt,
      answer: candidate.answer,
      explanation: candidate.explanation || '',
      verify: candidate.verify || '',
      verifyType: candidate.verifyType,
      answerShape: recipe.answerShape,
      variant: true,
      variantSource: 'llm',
      variantIndex: meta.index,
      seed: meta.seed,
      gates: meta.checks,
      createdAt: meta.now
    };
  }

  /* ================================================================
   * 管线（一次运行一个实例；批次/缓存池/统计都在实例里）
   * ================================================================ */

  /**
   * @param {object} opts - {transport, now, maxRetries, poolMax, config}
   * @returns {object} 管线实例
   */
  function createPipeline(opts) {
    opts = opts || {};
    var transport = opts.transport || defaultTransport;
    var now = opts.now || function () { return Date.now(); };
    var maxRetries = opts.maxRetries || MAX_RETRIES;
    var poolMax = opts.poolMax || POOL_MAX;

    var batch = gates.emptyCorpus();          /* 同批已生成（门 4/5） */
    var poolByTopic = {};                     /* topicId → {prompts, skeletons, questions} */
    var batchQuestions = [];

    var stats = {
      attempts: 0,
      produced: 0,
      exhausted: 0,          /* 3 次全废的 (topic,difficulty) 次数 */
      producedByAttempt: [0, 0, 0, 0],
      byGate: {},            /* 各门拒绝数 */
      byReason: {},          /* 细化拒因 */
      dupHits: { corpus: 0, batch: 0, pool: 0 },
      renumberHits: { corpus: 0, batch: 0, pool: 0 },
      syllabusHits: { 'descendant-term': 0, 'out-of-scope-term': 0, 'fail-closed': 0 },
      byTopic: {},           /* topicId → {attempts, produced, exhausted, byGate} */
      byDifficulty: {},      /* difficulty → {attempts, produced} */
      bySubject: {},         /* subject → {attempts, produced, exhausted} */
      byAnswerShape: {}      /* answerShape → {attempts, produced} */
    };

    function _bucket(box, key) {
      if (typeof box[key] !== 'object' || box[key] === null) box[key] = { attempts: 0, produced: 0 };
      return box[key];
    }

    function _topicStats(topicId) {
      if (!stats.byTopic[topicId]) {
        stats.byTopic[topicId] = { attempts: 0, produced: 0, exhausted: 0, byGate: {} };
      }
      return stats.byTopic[topicId];
    }

    function _poolIndex(topicId) {
      if (!poolByTopic[topicId]) poolByTopic[topicId] = { prompts: new Set(), skeletons: new Set(), questions: [] };
      return poolByTopic[topicId];
    }

    function _recordReject(recipe, ctx, gate, reason) {
      stats.byGate[gate] = (stats.byGate[gate] || 0) + 1;
      stats.byReason[reason] = (stats.byReason[reason] || 0) + 1;
      var ts = _topicStats(recipe.topicId);
      ts.byGate[gate] = (ts.byGate[gate] || 0) + 1;
      if (gate === 'duplicate') {
        var k = reason.split(':')[1];
        if (stats.dupHits[k] != null) stats.dupHits[k]++;
      }
      if (gate === 'renumber') {
        var k2 = reason.split(':')[1];
        if (stats.renumberHits[k2] != null) stats.renumberHits[k2]++;
      }
      if (gate === 'syllabus') {
        var head = reason.split(':')[0];
        if (stats.syllabusHits[head] != null) stats.syllabusHits[head]++;
      }
    }

    /**
     * 生成 1 道：最多 maxRetries 次请求，任一候选过七门即返回。
     * @param {object} recipe - llm-recipes.recipeFromPlanEntry 的返回值
     * @param {object} ctx - {topic, existing, standards, nameOf, corpus:{prompts,skeletons}, vocabulary}
     * @param {object} o - {difficulty, seed}
     * @returns {Promise<{ok:boolean, question:object|null, attempts:number, reason:string, checks:Array}>}
     */
    function gen(recipe, ctx, o) {
      o = o || {};
      var difficulty = o.difficulty || recipe.constraints.difficulties[0];
      var topicId = recipe.topicId;
      var ts = _topicStats(topicId);
      var subject = (ctx && ctx.topic && ctx.topic.subject) || 'unknown';

      function attemptOnce(n) {
        if (n >= maxRetries) {
          stats.exhausted++;
          ts.exhausted++;
          _bucket(stats.bySubject, subject).exhausted = (_bucket(stats.bySubject, subject).exhausted || 0) + 1;
          return Promise.resolve({ ok: false, question: null, attempts: n, reason: 'max-retries', checks: [] });
        }
        var seed = o.seed != null ? String(o.seed) + '#' + n : defaultSeed(topicId, difficulty, n);
        var body = buildRequestBody(recipe, ctx, {
          seed: seed, difficulty: difficulty, attempt: n,
          temperature: o.temperature   /* 仅回放/探针用：默认走 llm-gen 的常量 */
        });

        stats.attempts++;
        ts.attempts++;
        _bucket(stats.bySubject, subject).attempts++;
        _bucket(stats.byDifficulty, difficulty).attempts++;
        _bucket(stats.byAnswerShape, recipe.answerShape).attempts++;

        return Promise.resolve()
          .then(function () { return transport(body, { topicId: topicId, difficulty: difficulty, seed: seed, attempt: n }); })
          .then(function (content) {
            var parsed = parseCandidate(content);
            if (!parsed.ok) {
              _recordReject(recipe, ctx, 'transport', parsed.reason);
              return attemptOnce(n + 1);
            }
            /* 文本规范化出口（卡 t_42e5978b）：模型文本先洗成展示形态，再进七道门。
             * 顺序理由：门 4/5（去重/撞题骨架）比的是题面文本，若门看未清洗文本、上屏看清洗后
             * 文本，两边口径不一致 —— 同一道题写成 x^2 与 x² 会被当成两道。规范化会改文本，
             * 所以「答案是否出现在题面」的泄露判定必须在清洗之后再跑一次（门 6 在 runGates 里）。 */
            var cand = normalizeCandidate(parsed.candidate);
            var gateCtx = {
              recipe: recipe,
              topic: ctx.topic,
              vocabulary: ctx.vocabulary,
              corpus: ctx.corpus,
              batch: batch,
              pool: _poolIndex(topicId)
            };
            var r = gates.runGates(cand, gateCtx);
            if (!r.ok) {
              _recordReject(recipe, ctx, r.gate, r.reason);
              return attemptOnce(n + 1);
            }
            var pool = _poolIndex(topicId);
            var index = pool.questions.length;
            var q = buildQuestion(recipe, cand, ctx, {
              index: index, seed: seed, checks: r.checks, now: now()
            });
            pool.questions.push(q);
            while (pool.questions.length > poolMax) pool.questions.shift();
            gates.addToIndex(pool, q.prompt);
            gates.addToIndex(batch, q.prompt);
            batchQuestions.push(q);
            stats.produced++;
            stats.producedByAttempt[Math.min(n, stats.producedByAttempt.length - 1)]++;
            ts.produced++;
            _bucket(stats.bySubject, subject).produced++;
            _bucket(stats.byDifficulty, difficulty).produced++;
            _bucket(stats.byAnswerShape, recipe.answerShape).produced++;
            return { ok: true, question: q, attempts: n + 1, reason: 'produced', checks: r.checks };
          });
      }

      return attemptOnce(0);
    }

    function getStats() { return stats; }

    function getBatch() { return batchQuestions.slice(); }

    function getPool(topicId) {
      if (topicId) return (poolByTopic[topicId] || { questions: [] }).questions.slice();
      var out = {};
      for (var k in poolByTopic) out[k] = poolByTopic[k].questions.slice();
      return out;
    }

    function exportBatch(meta) {
      return {
        schema: BATCH_SCHEMA,
        variantSource: 'llm',
        meta: meta || null,
        count: batchQuestions.length,
        stats: stats,
        questions: batchQuestions.slice()
      };
    }

    return {
      gen: gen,
      getStats: getStats,
      getBatch: getBatch,
      getPool: getPool,
      exportBatch: exportBatch,
      _batchIndex: function () { return batch; }
    };
  }

  /* ================================================================
   * 落盘（只允许 tmp/）
   * ================================================================ */

  /** 生成的题不许写 data/*：路径必须落在 tmp/ 下（相对或绝对） */
  function assertSafeOutPath(p) {
    var s = String(p || '').replace(/\\/g, '/');
    if (!s) throw new Error('out path required');
    if (/(^|\/)data\//.test(s)) throw new Error('refusing to write generated questions into data/: ' + s);
    if (!/(^|\/)tmp\//.test(s)) throw new Error('generated questions may only be written under tmp/: ' + s);
    return s;
  }

  function writeBatch(filePath, payload) {
    assertSafeOutPath(filePath);
    if (typeof require !== 'function') return false;
    var fs = require('fs');
    var path = require('path');
    var dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    return true;
  }

  return {
    VERSION: VERSION,
    MAX_RETRIES: MAX_RETRIES,
    POOL_MAX: POOL_MAX,
    BATCH_SCHEMA: BATCH_SCHEMA,
    TEMPERATURE: TEMPERATURE,
    buildRequestBody: buildRequestBody,
    defaultSeed: defaultSeed,
    parseCandidate: parseCandidate,
    createPipeline: createPipeline,
    assertSafeOutPath: assertSafeOutPath,
    writeBatch: writeBatch,
    _defaultTransport: defaultTransport
  };
});
