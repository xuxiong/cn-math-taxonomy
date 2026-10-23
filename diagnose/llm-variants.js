/* O3 LLM 变式出题管线：LLM 产候选 → 验证门校验 → 不过重试（限 3 次）→ 全不过返回 null。
 *
 * 设计文档：docs/o3-llm-variants.md
 * 零新依赖（用 fetch 调本地网关）、UMD 包装、不修改 engine.js/variants.js。
 * 浏览器中暴露为 window.DiagLLMVariants，Node 中 require() 即可。
 *
 * O3-8 拆分后的职责：本文件只留「出题管线 + 缓存池 + 统计」。
 *   - 纯函数求值 / 验证门 → llm-eval.js（window.DiagLLMEval）
 *   - 网关探测 / 请求 / 工具自验 → llm-gateway.js（window.DiagLLMGateway）
 * 对外接口与拆分前完全一致（window.DiagLLMVariants 字段一个不少）。
 *
 * 核心思路：LLM 只管"出题面"，引擎管"验对错"——LLM 算错不要紧，
 * 验证门拦住就不让学生看到错题。工具自验（§2.4）是效率层，验证门是正确性层。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    /* Node：自行 require 另两个模块，保证测试可直接 require 本文件 */
    module.exports = factory(require('./llm-eval.js'), require('./llm-gateway.js'));
  } else {
    root.DiagLLMVariants = factory(root.DiagLLMEval, root.DiagLLMGateway);
  }
})(typeof self !== 'undefined' ? self : this, function (__evaldn, __gw) {
  'use strict';

  /* 拆出的两层（浏览器由 index.html 按序加载注入，Node 由 require 注入） */
  var _evaldn = __evaldn;
  var _gw = __gw;

  /* ================================================================
   * 出题配方（族 = 知识点 id → 难度档）
   * ================================================================ */

  var VERSION = 1;

  var MAX_RETRIES = 3;

  /* O3-6：max_tokens 单一出处（各文件自持，关键是一处定义、多处引用）。
   * GEN  —— 出题：一道题 JSON（题面+答案+解析），扩族后题面变长，500 会撞截断，取 1024
   * TOOL —— 工具轮：只需返回 tool_calls 参数，不需要长文本，取 512（也是 >=512 下限）
   * 改这两个值之前先看 tests/test_llm_variants.js 的 max_tokens 契约断言。 */
  var GEN_MAX_TOKENS = 1024;

  var TOOL_MAX_TOKENS = 512;

  var CACHE_KEY = 'cnmDiagnose.llmVariants.v1';

  var STATS_KEY = 'cnmDiagnose.llmVariantStats.v1';

  var POOL_MAX = 50;

  /* LLM 变式 recipe：族 = 知识点 id → 形态配置。
   * cnm_221 配方法 / cnm_222 公式法 / cnm_224 因式分解法（同为"解二次方程"，答案=两根）。
   * verifyType 由 prompt 侧指定：equation（代入验根）为主；配方加常数/formParam 为配方法特有。 */
  var RECIPES = {
    'cnm_221': { difficulties: ['basic', 'standard', 'advanced'] },
    'cnm_222': { difficulties: ['basic', 'standard', 'advanced'] },
    'cnm_224': { difficulties: ['basic', 'standard', 'advanced'] }
  };

  /**
   * 族方法词校验：题面必须体现该知识点的方法（防"练公式法却题面写配方法"）。
   * cnm_221 basic(completeSquare) 的题面是"需要加上的常数是多少"，没有"配方"二字，
   * 但题型本身即配方，故放行。
   * @param {string} topicId
   * @param {string} difficulty
   * @param {object} candidate
   * @returns {boolean}
   */
  function _methodWordMatches(topicId, difficulty, candidate) {
    var fam = FAMILY[topicId];
    if (!fam || !fam.methodWords || fam.methodWords.length === 0) return true;
    if (topicId === 'cnm_221' && difficulty === 'basic') return true;
    var text = String((candidate && (candidate.prompt || '')) || '');
    for (var i = 0; i < fam.methodWords.length; i++) {
      if (text.indexOf(fam.methodWords[i]) >= 0) return true;
    }
    return false;
  }

  /* ================================================================
   * prompt 模板（§4）——按族（知识点）参数化：family 描述 + 三档难度指令 + answer 格式。
   * ================================================================ */

  /* 各族的 system 指令与分档 user 指令。
   * 族名：cnm_221 配方法 / cnm_222 公式法 / cnm_224 因式分解法 */
  var FAMILY = {
    'cnm_221': {
      methodWords: ['配方'],
      system: '你是人教版初中数学出题老师。请按照要求出一道「配方法」练习题。'
        + '\n\n要求：'
        + '\n1. 题目必须是「用配方法解一元二次方程」或「配方相关」的数值题。'
        + '\n2. 系数必须是整数，判别式必须非负（保证有实数根）。'
        + '\n3. 答案如果是根式（如 2±√5），判别式不能是完全平方数。'
        + '\n4. 答案如果是有理数（如 1，-7），判别式必须是完全平方数。'
        + '\n5. 不要照抄任何已有题目，每次用不同的系数。',
      difficulty: {
        basic: '出一道基础题：给定一个二次多项式 x²+bx，问"需要加上的常数是多少"。'
          + '\n答案格式：一个整数（即 (b/2)²）。'
          + '\nverifyType: "completeSquare"'
          + '\n难度: basic',
        advanced: '出一道进阶题，从以下两种中选一种：'
          + '\nA) 二次项系数≠1的配方：如 "把 2x²-8x+1=0 配方成 2(x-m)²=n，依次求 m 与 n"'
          + '\n   答案格式：如 "2，7"，verifyType: "formParam"'
          + '\nB) 判别式非完全平方的解方程：如 "用配方法解 x²-4x-1=0"'
          + '\n   答案格式：如 "2±√5"，verifyType: "equation"'
          + '\n难度: advanced',
        standard: '出一道标准题：用配方法解一个一元二次方程 x²+bx+c=0（b 为偶数，使配方干净）。'
          + '\n要求判别式为完全平方数（答案是有理数），两个根用逗号隔开。'
          + '\n答案格式：如 "1，-7"'
          + '\nverifyType: "equation"'
          + '\n难度: standard'
      }
    },
    'cnm_222': {
      methodWords: ['公式法'],
      system: '你是人教版初中数学出题老师。请按照要求出一道「公式法（求根公式）解一元二次方程」练习题。'
        + '\n\n要求：'
        + '\n1. 题目必须是「用公式法解一元二次方程 ax²+bx+c=0」的数值题，a≠0，a/b/c 均为整数。'
        + '\n2. 判别式 Δ=b²-4ac 必须非负（保证有实数根）；结果必须是有限小数或分数（不能有根式）。'
        + '\n3. 优先选 Δ 是完全平方数（答案是有理数）；也可选 Δ 为正的非完全平方数但答案写成小数。'
        + '\n4. 不要照抄任何已有题目，每次用不同的系数。',
      difficulty: {
        basic: '出一道基础题：a=1 且 Δ 为完全平方数（两个根都是整数），如 "用公式法解 x²-7x+12=0"。'
          + '\n答案格式：两个根用逗号隔开，如 "3，4"'
          + '\nverifyType: "equation"'
          + '\n难度: basic',
        advanced: '出一道进阶题：a≠1 且 Δ 为完全平方数（根可以含分母），如 "用公式法解 2x²-3x-2=0"。'
          + '\n答案格式：两个根用逗号隔开，分数写成 "a/b" 形式，如 "2，-1/2"'
          + '\nverifyType: "equation"'
          + '\n难度: advanced',
        standard: '出一道标准题：a=1 且 Δ 为完全平方数（两个根都是整数），如 "用公式法解 x²+5x+6=0"。'
          + '\n答案格式：两个根用逗号隔开，如 "-2，-3"'
          + '\nverifyType: "equation"'
          + '\n难度: standard'
      }
    },
    'cnm_224': {
      methodWords: ['因式分解'],
      system: '你是人教版初中数学出题老师。请按照要求出一道「因式分解法解一元二次方程」练习题。'
        + '\n\n要求：'
        + '\n1. 题目必须是「用因式分解法解一元二次方程」的数值题，a/b/c 均为整数。'
        + '\n2. 方程必须能十字相乘或提公因式分解成两个一次因式（根必须是整数或简单分数）。'
        + '\n3. 判别式必须是非负完全平方数（保证可整数/简单分数因式分解）。'
        + '\n4. 不要照抄任何已有题目，每次用不同的系数。',
      difficulty: {
        basic: '出一道基础题：a=1、常数项可分解为两个整数因式（根为整数），如 "用因式分解法解方程 x²-5x+6=0"。'
          + '\n题面必须出现「因式分解法」四个字。'
          + '\n答案格式：两个根用逗号隔开，如 "2，3"'
          + '\nverifyType: "equation"'
          + '\n难度: basic',
        advanced: '出一道进阶题：a≠1 且可十字相乘（根为整数或简单分数），如 "用因式分解法解方程 2x²+5x-3=0"。'
          + '\n题面必须出现「因式分解法」四个字。'
          + '\n答案格式：两个根用逗号隔开，分数写成 "a/b" 形式，如 "1/2，-3"'
          + '\nverifyType: "equation"'
          + '\n难度: advanced',
        standard: '出一道标准题：a=1、常数项分解（根为整数），如 "用因式分解法解方程 x²+5x+6=0"。'
          + '\n题面必须出现「因式分解法」四个字。'
          + '\n答案格式：两个根用逗号隔开，如 "-2，-3"'
          + '\nverifyType: "equation"'
          + '\n难度: standard'
      }
    }
  };

  function FAMILY_KEYS() { return Object.keys(FAMILY); }

  function _systemPrompt(topicId) {
    var fam = FAMILY[topicId] || FAMILY['cnm_221'];
    return fam.system
      + '\n\n输出格式严格为 JSON，不要任何多余文字：'
      + '\n{"prompt":"题面文本","answer":"答案","explanation":"分步解析","verifyType":"equation|completeSquare|formParam","difficulty":"basic|standard|advanced"}';
  }

  function _userPrompt(topicId, difficulty) {
    var fam = FAMILY[topicId] || FAMILY['cnm_221'];
    var d = fam.difficulty[difficulty] || fam.difficulty.standard;
    return d;
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

    return _callGateway(topicId, difficulty)
      .then(function (candidate) {
        if (!candidate) {
          _recordStat(statKey, false, 'no-candidate');
          return _genWithRetry(topicId, difficulty, seed, attempt + 1);
        }

        /* 验证门校验 */
        var result = _evaldn.validateLLMQuestion(candidate);
        if (result.ok === true && _methodWordMatches(topicId, difficulty, candidate)) {
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
   * O3-4 工具自验循环（§2.4 效率层）：若网关支持 function calling，
   * 首次请求带 tools；响应若有 tool_calls → 页面端执行对应 JS 函数
   * （evaluateExpression/solveCheck/normalizeSet）→ 追加 assistant+tool 结果
   * 消息 → 二次请求 → 取最终题。模型不返回 tool_calls 或工具执行抛错 →
   * 照旧单层（外部验证门仍是最终硬保证，工具结果只影响生成质量）。
   * @param {string} difficulty
   * @returns {Promise<object|null>}
   */
  function _callGateway(topicId, difficulty) {
    if (typeof fetch !== 'function') return Promise.resolve(null);

    return _gw.probeFunctionCalling().then(function (supportsTools) {
      var messages = [
        { role: 'system', content: _systemPrompt(topicId) },
        { role: 'user', content: _userPrompt(topicId, difficulty) }
      ];
      var body = {
        model: _gw.MODEL,
        messages: messages,
        max_tokens: GEN_MAX_TOKENS,
        temperature: 0.8
      };
      if (supportsTools) body.tools = _gw.TOOLS;

      return _gw.postOnce(body).then(function (data) {
        if (!data || !data.choices || !data.choices[0]) return null;
        var msg = data.choices[0].message;

        /* 工具自验：响应带 tool_calls 且网关支持 → 执行工具并二次请求 */
        if (supportsTools && msg.tool_calls && msg.tool_calls.length > 0) {
          return _gw.runToolLoop(messages, msg, _parseCandidate, _evaldn);
        }
        /* 单层：无 tool_calls → 直接用 content */
        return _parseCandidate(msg.content);
      });
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
   * 接线：常量单源 + 模块注入（拆分产物之间的粘合层）
   * ================================================================ */

  /* max_tokens 常量只在本文件定义（O3-6 契约），推给网关层取用 */
  if (_gw && typeof _gw.setLimits === 'function') {
    _gw.setLimits({ GEN_MAX_TOKENS: GEN_MAX_TOKENS, TOOL_MAX_TOKENS: TOOL_MAX_TOKENS });
  }
  /* 表达式工具注入网关层（工具自验 loop 用） */
  if (_gw && typeof _gw.setEval === 'function') {
    _gw.setEval(_evaldn);
  }

  /* ================================================================
   * 导出（与拆分前完全一致：app.js 与现有测试的消费点不改）
   * ================================================================ */

  return {
    VERSION: VERSION,
    supports: supports,
    genLLMVariant: genLLMVariant,
    fillPracticeLLM: fillPracticeLLM,
    validateLLMQuestion: _evaldn.validateLLMQuestion,
    verifyEquationRoots: _evaldn.verifyEquationRoots,
    verifyCompletingSquare: _evaldn.verifyCompletingSquare,
    verifyFormParam: _evaldn.verifyFormParam,
    evaluateExpression: _evaldn.evaluateExpression,
    solveCheck: _evaldn.solveCheck,
    normalizeSet: _evaldn.normalizeSet,
    getStats: getStats,
    probeGateway: _gw.probeGateway,
    probeFunctionCalling: _gw.probeFunctionCalling,
    /* 测试用内部接口 */
    _systemPrompt: _systemPrompt,
    _userPrompt: _userPrompt,
    _methodWordMatches: _methodWordMatches,
    _resetStats: _resetStats,
    _clearCache: _clearCache,
    _pushCache: _pushCache,
    _getCachePool: _getCachePool,
    _recordStat: _recordStat,
    _resetProbe: function () { _gw.resetProbe(); },
    _setNow: function (fn) { _gw.setNow(fn); },
    /* 拆出的两个子模块（便于 app.js/调试直接取用；不影响原有字段） */
    _eval: function () { return _evaldn; },
    _gateway: function () { return _gw; }
  };
});
