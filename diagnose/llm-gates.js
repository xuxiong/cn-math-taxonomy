/* O3 出题管线的「七道脚本门禁」（卡 C / t_faca95d0）。
 *
 * 顺序执行，任一不过即拒（runGates 返回第一个失败的 gate，同时保留全部已跑结果）：
 *   1 schema     字段白名单 / verifyType 枚举 / answer 非空 / 长度上限
 *   2 substitute 代回验证：equation|completeSquare|formParam 走 llm-eval.validateLLMQuestion
 *                （ok===null 一律按拒处理）；numeric 用 llm-eval 的求值原语组合（见 gateSubstitute）
 *   3 rootSet    解集完整：方程类必须给出与次数相符且互异的根集
 *                （堵 verifyEquationRoots 不校验根数的缺口）
 *   4 duplicate  去重：与全库 / 同批已生成 / 缓存池比「归一化题面」完全一致
 *   5 renumber   换数检测：数字抽掉后的题干骨架相同 → 判重（LLM 出题最大污染源）
 *   6 leak       泄露：explanation 首句不得含 x=<根> 或「系数化为」（沿用 variants.js checkLeak 口径）
 *   7 syllabus   超纲：复合判据（板主 2026-11-07 裁决）
 *                a) descendants < 50 → descendants 概念词黑名单
 *                b) descendants ≥ 50 → 同年级 + 同章节白名单，白名单外的概念词即超纲
 *                c) 白名单算不出来（grade/chapter 缺失）→ fail-closed 拒题
 *
 * 口径说明（写进卡评论）：
 *   - 本文件不改 llm-eval.js 的求值口径，只调用它导出的 evaluateExpression / parseRootValue /
 *     parseRoots / parseQuadraticCoeffs / validateLLMQuestion。numeric 验证器 = 这四个原语的组合，
 *     没有新的表达式解析或求值实现。
 *   - 门 6 沿用 checkLeak 的**首句**口径（variants.js:336），不是全文扫答案：讲解本来就要讲答案。
 *   - 门 7 的 a) 路线只查 descendants 名称，不查闭包外其它知识点（裁决口径如此，局限写进卡评论）。
 *
 * 零网络、零 DOM、零 localStorage、无 Date.now（纯函数）。UMD：window.DiagLLMGates / require。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./llm-eval.js'), require('./llm-recipes.js'));
  } else {
    root.DiagLLMGates = factory(root.DiagLLMEval, root.DiagLLMRecipes);
  }
})(typeof self !== 'undefined' ? self : this, function (__evaldn, __recipes) {
  'use strict';

  var ev = __evaldn;
  var recipes = __recipes;

  var EPS = (ev && ev.EPS) || 1e-9;

  var GATE_NAMES = ['schema', 'substitute', 'rootSet', 'duplicate', 'renumber', 'leak', 'syllabus'];

  /* 字段白名单（门 1）：多一个字段就拒 —— LLM 常顺手把 id/type/答案写进别的字段里 */
  var ALLOWED_FIELDS = ['prompt', 'answer', 'explanation', 'verify', 'verifyType', 'difficulty'];

  /* 长度上限（防上下文/缓存被一条巨型题撑爆；与 8192 max_tokens 无关，是产物侧约束） */
  var MAX_LEN = { prompt: 400, answer: 60, explanation: 800, verify: 200 };

  /* ================================================================
   * 文本归一化（去重 / 换数共用的两个投影）
   * ================================================================ */

  var PUNCT = /[\s\u3000，。、；：？！,.;:?!"'“”‘’（）()【】\[\]{}「」《》<>—–\-_~·|]/g;

  /** 归一化题面：NFKC + 去空白与标点 + 小写（同 variants.js canon 的加严版） */
  function normText(s) {
    return String(s == null ? '' : s).normalize('NFKC').replace(PUNCT, '').toLowerCase();
  }

  /** 骨架里剔掉的答题指令尾巴：这些词是模板固定的，不该让「同骨架」判定失效 */
  var FILLER = /只填数值|只填答案|只填数字|不写单位|单位不写/g;

  /** 数字抽掉后的题干骨架：所有数字（含小数、²→2）→ '#'，再去掉所有非中文/字母/占位符字符。
   *  这样 "+ − ×" 之类的运算符、括号、标点都不影响骨架比较 —— 只换数和换运算符都算同一骨架。
   *  代价：同一模板（如「解方程 Nx+N=N」）会被判为同一骨架，题库里已有该模板时新题一律被门 5 挡；
   *  这是刻意的「宁严勿松」（换数是 LLM 出题最大污染源），代价写进卡评论。 */
  function skeleton(s) {
    var t = String(s == null ? '' : s).normalize('NFKC').replace(FILLER, '').replace(/\d+(?:\.\d+)?/g, '#');
    return t.replace(/[^\u4e00-\u9fa5a-zA-Z#]/g, '').toLowerCase();
  }

  /** 题面里出现的数字（字符串形式，去重排序）—— 门 2 numeric 的反自证用 */
  function numbersOf(s) {
    /* 上标先在前后加空格再折叠：`x²-4=0` 要能看出 2，`10⁶` 要能看出 10 和 6 两个数
     * （规范化出口 textfmt 会把 x^2 洗成 x²，若这里不认上标，门 2 会看不到题面里的指数）。 */
    var folded = String(s == null ? '' : s).replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]+/g, function (run) {
      var digits = '';
      for (var i = 0; i < run.length; i++) digits += '⁰¹²³⁴⁵⁶⁷⁸⁹'.indexOf(run[i]);
      return ' ' + digits + ' ';
    });
    var m = folded.match(/\d+(?:\.\d+)?/g) || [];
    var seen = {};
    var out = [];
    for (var i = 0; i < m.length; i++) {
      var k = String(parseFloat(m[i]));
      if (!seen[k]) { seen[k] = 1; out.push(k); }
    }
    out.sort();
    return out;
  }

  /* ================================================================
   * 门 1：schema
   * ================================================================ */

  function gateSchema(candidate) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      return { ok: false, reason: 'not-an-object' };
    }
    var keys = Object.keys(candidate);
    for (var i = 0; i < keys.length; i++) {
      if (ALLOWED_FIELDS.indexOf(keys[i]) < 0) return { ok: false, reason: 'unknown-field:' + keys[i] };
    }
    var required = ['prompt', 'answer', 'explanation', 'verifyType', 'difficulty'];
    for (var j = 0; j < required.length; j++) {
      var f = required[j];
      if (typeof candidate[f] !== 'string' || candidate[f].trim() === '') {
        return { ok: false, reason: 'missing-field:' + f };
      }
    }
    if (candidate.verify != null && typeof candidate.verify !== 'string') {
      return { ok: false, reason: 'bad-type:verify' };
    }
    if (recipes.VERIFY_TYPES.indexOf(candidate.verifyType) < 0) {
      return { ok: false, reason: 'unknown-verify-type:' + candidate.verifyType };
    }
    if (recipes.DIFFICULTIES.indexOf(candidate.difficulty) < 0) {
      return { ok: false, reason: 'unknown-difficulty:' + candidate.difficulty };
    }
    for (var f2 in MAX_LEN) {
      if (typeof candidate[f2] === 'string' && candidate[f2].length > MAX_LEN[f2]) {
        return { ok: false, reason: 'too-long:' + f2 };
      }
    }
    return { ok: true, reason: 'ok' };
  }

  /* ================================================================
   * 门 2：代回验证
   * ================================================================ */

  /**
   * numeric 验证器：answer 必须等于 verify 算式的值，且 verify 只能是题面数字的算术组合。
   * 三段（缺一不可，因为 answer==verify 单独存在时，LLM 可以写 verify="3" 来自证 answer=3）：
   *   a) answer 可解析为一个数；
   *   b) verify 含至少一个运算符（纯字面量 = 自证，拒）；
   *   c) verify 里出现的每个数字都能在题面找到（题面没有的数字不许凭空出现）。
   * 求值只用 ev.evaluateExpression / ev.parseRootValue，不新写解析或求值。
   * @returns {{ok:boolean, reason:string}}
   */
  function verifyNumeric(prompt, answer, verify) {
    var ans = ev.parseRootValue(String(answer == null ? '' : answer));
    if (ans === null || isNaN(ans)) return { ok: false, reason: 'answer-not-numeric' };

    var v = String(verify == null ? '' : verify).trim();
    if (!v) return { ok: false, reason: 'no-verify-expression' };
    if (!/[+\-*/×÷]/.test(v)) return { ok: false, reason: 'verify-not-an-expression' };

    var vNums = numbersOf(v);
    var pNums = numbersOf(prompt);
    for (var i = 0; i < vNums.length; i++) {
      if (pNums.indexOf(vNums[i]) < 0) return { ok: false, reason: 'verify-number-not-in-prompt:' + vNums[i] };
    }

    var vals = ev.evaluateExpression(v, [0]);
    if (!vals || typeof vals[0] !== 'number' || isNaN(vals[0])) return { ok: false, reason: 'verify-eval-failed' };
    if (Math.abs(vals[0] - ans) >= EPS) {
      return { ok: false, reason: 'answer-mismatch', expected: vals[0], actual: ans };
    }
    return { ok: true, reason: 'numeric-verified' };
  }

  /**
   * 门 2 入口：按 verifyType 路由。verifyType 必须与配方一致（防「配方说数值题、模型交方程题」）。
   * @param {object} candidate
   * @param {object} recipe
   * @returns {{ok:boolean, reason:string}}
   */
  function gateSubstitute(candidate, recipe) {
    if (candidate.verifyType !== recipe.verifyType) {
      return { ok: false, reason: 'verify-type-mismatch:' + recipe.verifyType + '!=' + candidate.verifyType };
    }
    if (recipe.verifyType === 'numeric') {
      return verifyNumeric(candidate.prompt, candidate.answer, candidate.verify);
    }
    /* 三个原生验证器：只调用，不改口径；ok===null（未知类型/缺类型）一律按拒 */
    var r = ev.validateLLMQuestion({
      prompt: candidate.prompt, answer: candidate.answer, verifyType: candidate.verifyType
    });
    if (r.ok === true) return { ok: true, reason: 'substituted:' + r.reason };
    return { ok: false, reason: 'substitute-failed:' + r.reason };
  }

  /* ================================================================
   * 门 3：解集完整（方程类）
   * ================================================================ */

  /**
   * 方程类必须给出与次数相符且互异的根集：
   *   二次（a≠0）：Δ>0 → 2 个互异实根；Δ=0 → 1 个（重根只写一次）；Δ<0 → 判无实根，拒。
   *   一次（a=0）：1 个根。
   * 根的「对不对」由门 2 保证（逐根代回），本门只补「根数/互异」这个缺口。
   */
  function gateRootSet(candidate) {
    if (candidate.verifyType !== 'equation') return { ok: true, reason: 'not-equation' };

    var roots = ev.parseRoots(candidate.answer);
    if (!roots || roots.length === 0) return { ok: false, reason: 'no-roots' };

    /* 互异：任意两根差 >= EPS */
    for (var i = 0; i < roots.length; i++) {
      for (var j = i + 1; j < roots.length; j++) {
        if (Math.abs(roots[i] - roots[j]) < EPS) return { ok: false, reason: 'repeated-root' };
      }
    }

    var coeffs = ev.parseQuadraticCoeffs(candidate.prompt);
    if (!coeffs) {
      /* 二次项系数为 0（或题面无法提取系数）→ 按一次方程算：必须恰好 1 个根。
       * 题面无法提取系数的情况在门 2 已经被 verifyEquationRoots 拦掉，这里只是形状兜底。 */
      if (roots.length !== 1) return { ok: false, reason: 'degree-1-needs-1-root' };
      return { ok: true, reason: 'linear-ok' };
    }
    var delta = coeffs.b * coeffs.b - 4 * coeffs.a * coeffs.c;
    if (delta < -EPS) return { ok: false, reason: 'no-real-roots' };
    var expect = Math.abs(delta) <= EPS ? 1 : 2;
    if (roots.length !== expect) return { ok: false, reason: 'root-count:' + roots.length + '!=' + expect };
    return { ok: true, reason: 'root-set-complete' };
  }

  /* ================================================================
   * 门 4 / 门 5：去重 + 换数
   * ================================================================ */

  /**
   * 去重：归一化题面与三个来源逐一比（顺序固定 → 拒因稳定可回放）：
   *   corpus（全库 13335 题）/ batch（同批已生成）/ pool（缓存池）
   */
  function gateDuplicate(candidate, ctx) {
    var n = normText(candidate.prompt);
    var sources = ['corpus', 'batch', 'pool'];
    for (var i = 0; i < sources.length; i++) {
      var set = _setOf(ctx, sources[i], 'prompts');
      if (set && set.has(n)) return { ok: false, reason: 'duplicate:' + sources[i] };
    }
    return { ok: true, reason: 'unique' };
  }

  /** 换数检测：数字抽掉后的骨架相同即判重（同三个来源） */
  function gateRenumber(candidate, ctx) {
    var sk = skeleton(candidate.prompt);
    if (!sk) return { ok: false, reason: 'empty-skeleton' };
    var sources = ['corpus', 'batch', 'pool'];
    for (var i = 0; i < sources.length; i++) {
      var set = _setOf(ctx, sources[i], 'skeletons');
      if (set && set.has(sk)) return { ok: false, reason: 'renumber:' + sources[i] };
    }
    return { ok: true, reason: 'fresh-skeleton' };
  }

  function _setOf(ctx, name, field) {
    var box = ctx && ctx[name];
    if (!box) return null;
    var s = box[field];
    if (!s) return null;
    if (typeof s.has === 'function') return s;
    return null;
  }

  /* ================================================================
   * 门 6：泄露（checkLeak 口径）
   * ================================================================ */

  function _escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  /**
   * 沿用 variants.js checkLeak 口径：explanation 的首句（到第一个逗号/句号/分号）
   * 不得出现 x=<根>，且全文不得出现「系数化为」（后者原本只看首句，这里收紧到全文，方向是更严）。
   * @returns {{ok:boolean, reason:string}}
   */
  function gateLeak(candidate) {
    var text = String(candidate.explanation || '');
    var idx = text.search(/[，。；;,]/);
    var firstClause = idx < 0 ? text : text.slice(0, idx + 1);

    var roots = ev.parseRoots(candidate.answer) || [];
    for (var i = 0; i < roots.length; i++) {
      var numStr = String(roots[i]);
      var re = new RegExp('x\\s*=\\s*' + _escapeRe(numStr));
      if (re.test(firstClause)) return { ok: false, reason: 'answer-in-first-clause:x=' + numStr };
    }
    if (text.indexOf('系数化为') >= 0) return { ok: false, reason: 'answer-in-explanation:系数化为' };
    return { ok: true, reason: 'no-leak' };
  }

  /* ================================================================
   * 门 7：超纲（复合判据）
   * ================================================================ */

  /**
   * @param {object} candidate
   * @param {object} recipe
   * @param {object} ctx - {topic, vocabulary:[{topicId,name,subject,grade,chapter}], chapter?:string}
   * @returns {{ok:boolean, reason:string, route:string}}
   */
  function gateSyllabus(candidate, recipe, ctx) {
    var syl = (recipe && recipe.constraints && recipe.constraints.syllabus) || {};
    var topic = (ctx && ctx.topic) || {};
    var vocab = (ctx && ctx.vocabulary) || [];
    var prompt = String(candidate.prompt || '');
    var route = syl.route;

    var allow = { };
    allow[topic.id || recipe.topicId] = 1;
    var closure = syl.allowed || [];
    for (var i = 0; i < closure.length; i++) allow[closure[i]] = 1;

    if (route === 'desc-blacklist') {
      var denied = syl.denied || [];
      var hit = _matchTerms(prompt, vocab, function (t) {
        return denied.indexOf(t.topicId) >= 0 && _termLen(t.name) >= 2 && !allow[t.topicId];
      });
      if (hit) return { ok: false, reason: 'descendant-term:' + hit.name, route: route };
      return { ok: true, reason: 'in-syllabus-desc', route: route };
    }

    if (route !== 'grade-chapter-whitelist') {
      return { ok: false, reason: 'fail-closed:unknown-route', route: String(route) };
    }

    /* 白名单路线：同年级 + 同章节。数据缺失 → fail-closed（不放行）。 */
    var grade = topic.grade;
    var chapter = topic.chapter;
    if (grade == null || !chapter) {
      return { ok: false, reason: 'fail-closed:no-chapter-data', route: route };
    }
    var subject = topic.subject;
    for (var k = 0; k < vocab.length; k++) {
      var t = vocab[k];
      if (t.subject === subject && t.grade === grade && t.chapter === chapter) allow[t.topicId] = 1;
    }

    var minLen = syl.minTermLen || recipes.WHITELIST_MIN_TERM_LEN;
    var out = _matchTerms(prompt, vocab, function (x) {
      return !allow[x.topicId] && x.subject === subject && _termLen(x.name) >= minLen;
    });
    if (out) return { ok: false, reason: 'out-of-scope-term:' + out.name, route: route };
    return { ok: true, reason: 'in-syllabus-whitelist', route: route };
  }

  function _termLen(s) { return Array.from(String(s || '')).length; }

  /**
   * 在题面里找第一个命中 pred 的知识点名称（按名称长度降序检查，长名优先，避免短名误命中）。
   * @returns {{topicId:string,name:string}|null}
   */
  function _matchTerms(prompt, vocab, pred) {
    var cands = [];
    for (var i = 0; i < vocab.length; i++) {
      var t = vocab[i];
      if (!t || !t.name) continue;
      if (!pred(t)) continue;
      cands.push(t);
    }
    if (!cands.length) return null;
    cands.sort(function (a, b) {
      var d = _termLen(b.name) - _termLen(a.name);
      if (d !== 0) return d;
      return String(a.topicId < b.topicId ? -1 : 1);
    });
    for (var j = 0; j < cands.length; j++) {
      if (prompt.indexOf(cands[j].name) >= 0) return { topicId: cands[j].topicId, name: cands[j].name };
    }
    return null;
  }

  /* ================================================================
   * 索引（一次性预计算，批次内复用）
   * ================================================================ */

  /**
   * 从题库 + 知识点表建门 4/5/7 用的索引。
   * @param {object} input - {questions:[{id,prompt}], topics:[{id,name,subject,grade,chapter}]}
   * @returns {{prompts:Set, skeletons:Set, vocabulary:Array, byId:Map?}}
   */
  function buildIndex(input) {
    input = input || {};
    var questions = input.questions || [];
    var topics = input.topics || [];
    var prompts = new Set();
    var skeletons = new Set();
    for (var i = 0; i < questions.length; i++) {
      var q = questions[i];
      if (!q || !q.prompt) continue;
      prompts.add(normText(q.prompt));
      var sk = skeleton(q.prompt);
      if (sk) skeletons.add(sk);
    }
    var vocabulary = [];
    for (var j = 0; j < topics.length; j++) {
      var t = topics[j];
      if (!t || !t.id || !t.name) continue;
      vocabulary.push({
        topicId: t.id, name: t.name, subject: t.subject,
        grade: t.grade, chapter: t.chapter
      });
    }
    return { prompts: prompts, skeletons: skeletons, vocabulary: vocabulary, size: questions.length };
  }

  /** 空的批次/池索引（生成过程中追加） */
  function emptyCorpus() { return { prompts: new Set(), skeletons: new Set() }; }

  /** 把一道已通过的题加进索引（batch 或 pool） */
  function addToIndex(index, prompt) {
    if (!index || !prompt) return index;
    index.prompts.add(normText(prompt));
    var sk = skeleton(prompt);
    if (sk) index.skeletons.add(sk);
    return index;
  }

  /* ================================================================
   * 总入口
   * ================================================================ */

  /**
   * 顺序跑七道门，任一不过即停。
   * @param {object} candidate
   * @param {object} ctx - {recipe, topic, corpus, batch, pool, vocabulary}
   * @returns {{ok:boolean, gate:string|null, reason:string, checks:Array}}
   */
  function runGates(candidate, ctx) {
    ctx = ctx || {};
    var recipe = ctx.recipe;
    if (!recipe) return { ok: false, gate: 'schema', reason: 'no-recipe', checks: [] };

    var checks = [];
    var steps = [
      ['schema', function () { return gateSchema(candidate); }],
      ['substitute', function () { return gateSubstitute(candidate, recipe); }],
      ['rootSet', function () { return gateRootSet(candidate); }],
      ['duplicate', function () { return gateDuplicate(candidate, ctx); }],
      ['renumber', function () { return gateRenumber(candidate, ctx); }],
      ['leak', function () { return gateLeak(candidate); }],
      ['syllabus', function () { return gateSyllabus(candidate, recipe, ctx); }]
    ];
    for (var i = 0; i < steps.length; i++) {
      var r = steps[i][1]();
      checks.push({ gate: steps[i][0], ok: r.ok, reason: r.reason });
      if (!r.ok) {
        return { ok: false, gate: steps[i][0], reason: r.reason, checks: checks };
      }
    }
    return { ok: true, gate: null, reason: 'all-gates-pass', checks: checks };
  }

  return {
    GATE_NAMES: GATE_NAMES,
    ALLOWED_FIELDS: ALLOWED_FIELDS,
    MAX_LEN: MAX_LEN,
    normText: normText,
    skeleton: skeleton,
    numbersOf: numbersOf,
    gateSchema: gateSchema,
    gateSubstitute: gateSubstitute,
    verifyNumeric: verifyNumeric,
    gateRootSet: gateRootSet,
    gateDuplicate: gateDuplicate,
    gateRenumber: gateRenumber,
    gateLeak: gateLeak,
    gateSyllabus: gateSyllabus,
    buildIndex: buildIndex,
    emptyCorpus: emptyCorpus,
    addToIndex: addToIndex,
    runGates: runGates
  };
});
