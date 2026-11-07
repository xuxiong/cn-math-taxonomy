/* O3 出题管线的「参数化配方层」（卡 C / t_faca95d0）：
 * 每族只留三个字段 —— 答案形态（answerShape）/ 验证函数（verifyType）/ 约束（constraints），
 * 其余全部由知识点字段注入：description / mastery_criteria / 现有题 id 与题面 / 课标条目。
 *
 * 与 diagnose/llm-variants.js 的关系
 * --------------------------------
 * llm-variants.js 是 O3 试点：3 个知识点、每族手写 system + 三档难度文案（RECIPES/FAMILY）。
 * 本文件是它的参数化替代：不写任何族专属文案，输入换成卡 A 的 plan 条目
 * （tmp/gap-plan.json 的一条）+ 知识点本体，输出仍是 {system, user} 两份文本。
 * llm-variants.js 一行未改（既有测试断言全部钉在它的手写文案上，改了就是破坏红线）；
 * 新管线只覆盖 strategy=verify 的知识点，construct 类归卡 B。
 *
 * 设计约束
 * --------
 * - 确定性：同 (recipe, ctx, seed) → 请求体字节相同（无时间戳、无随机数、无 Date.now）。
 * - 现有题只注入 id 与题面，**不注入答案**（防 prompt 里直接带出答案）。
 * - 每族文案为零：所有文案都是同一套模板 + 字段插值，按知识点不同只换值。
 * - 不写网关地址/型号（fork 守卫 (h)），模型与 max_tokens 由 llm-config.js / llm-gateway.js 提供。
 *
 * UMD：浏览器 window.DiagLLMRecipes；Node require('./llm-recipes.js')。零依赖、零网络。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.DiagLLMRecipes = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = 1;

  /* 答案形态 → 决定用哪个验证器（卡 C §1 第一个字段） */
  var ANSWER_SHAPE = {
    NUMBER: 'number',        /* 一个数：数值比较（numeric）或 (b/2)²（completeSquare） */
    ROOT_SET: 'rootSet',     /* 根集：逐根代回（equation） */
    PARAM_PAIR: 'paramPair'  /* 参数对 m,n：（formParam） */
  };

  /* 验证器枚举（门 1 的白名单）。前三个是 llm-eval.js 的原生口径（只调用，不改）；
   * numeric 由 llm-gates.js 用 llm-eval 导出的求值原语组合出来（见该文件 gateSubstitute 注释）。 */
  var VERIFY_TYPES = ['equation', 'completeSquare', 'formParam', 'numeric'];

  /* 卡 A 的 plan.verifier → {答案形态, 验证函数}。null / 未知 → 不出题（返回 null）。 */
  var PLAN_VERIFIER = {
    'equation': { answerShape: ANSWER_SHAPE.ROOT_SET, verifyType: 'equation' },
    'completeSquare': { answerShape: ANSWER_SHAPE.NUMBER, verifyType: 'completeSquare' },
    'formParam': { answerShape: ANSWER_SHAPE.PARAM_PAIR, verifyType: 'formParam' },
    'numeric-compare': { answerShape: ANSWER_SHAPE.NUMBER, verifyType: 'numeric' }
  };

  var DIFFICULTIES = ['basic', 'standard', 'advanced'];

  /* 门 7 的复合判据阈值（板主 2026-11-07 裁决：descendants ≥ 50 视为退化，改用白名单）。
   * 实测：cnm_p001 的 descendants 是 790 个点（几乎整个英语科），黑名单等于没有闸门。 */
  var DESC_BLACKLIST_MAX = 50;

  /* 白名单路线里参与「概念词」匹配的最小词长：2 字中文词歧义太大（面积/比例/分数/时间
   * 既是知识点名也是日常词），实测 3297 个知识点名里 108 个是 2 字。只对 ≥3 字的名称做全局
   * 黑名单匹配，命中率与误报率的取舍写进卡评论。descendants 黑名单不受此限（结构相关，2 字也查）。 */
  var WHITELIST_MIN_TERM_LEN = 3;

  /* denied 概念词进 prompt 的上限：cne_p001 一类 700+ 个后继点全写进 prompt 会把上下文吃满，
   * 取前 40（按 id 排序后截断，保证确定性）。 */
  var PROMPT_DENY_CAP = 40;

  /* ================================================================
   * 难度 rubric（每族共用一份，按答案形态追加格式要求）
   * ================================================================ */

  var RUBRIC = {
    basic: '一步运算即可得出答案；已知量不超过 2 个，数字取 1–2 位整数或一位小数；'
      + '答案绝对值不超过 100。',
    standard: '需要两步运算；已知量 2–3 个，可用整数、小数或简单分数；答案绝对值不超过 1000。',
    advanced: '需要三步以上运算，或从结果反求条件（逆向）、含括号/单位换算；'
      + '数字可用两位小数，但不得引入本知识点之外的新概念。'
  };

  var SHAPE_FORMAT = {
    number: '答案是一个数（不带单位）。若题面给了单位，题面里注明「只填数值」。'
      + '另给一个 verify 字段：一条只由题面中出现过的数字与 + - * / ( ) 组成的算式，其计算结果必须等于 answer'
      + '（例：题面「2 h 行驶 144 km，速度是多少（只填数值）」→ answer "72"，verify "144/2"）。',
    rootSet: '答案是方程的根集，多个根用逗号分隔（如 "1，-7"），重根只写一次，'
      + '根式写成 "2±√5" 或 "2+√5，2-√5"。根的个数必须与方程次数一致。',
    paramPair: '答案是参数对，用逗号分隔（如 "2，7"），顺序为题面要求的 (m,n)。'
  };

  /* 学科中文名（只用于 prompt 文案，不含任何模型/网关信息） */
  var SUBJECT_LABEL = {
    math: '数学', physics: '物理', chemistry: '化学', english: '英语',
    chinese: '语文', biology: '生物', geography: '地理', history: '历史',
    science: '科学', morality: '道德与法治'
  };

  function subjectLabel(s) { return SUBJECT_LABEL[s] || String(s || ''); }

  /* ================================================================
   * 配方：plan 条目 → {answerShape, verifyType, constraints}（三字段）
   * ================================================================ */

  /**
   * 从卡 A 的 plan 条目推导配方。三条硬规则：
   *   1. strategy 必须是 verify（construct 归卡 B，human-only 不喂 LLM —— O3 设计 D9）；
   *   2. verifier 必须能映射到已知验证器；
   *   3. 难度档由 gaps 决定（no-challenge 的点必须先出 advanced），其余用标准顺序。
   * @param {object} entry - plan.topics 的一条
   * @returns {object|null}
   */
  function recipeFromPlanEntry(entry) {
    if (!entry || !entry.topicId) return null;
    if (entry.strategy !== 'verify') return null;
    var m = PLAN_VERIFIER[entry.verifier];
    if (!m) return null;

    var gaps = Array.isArray(entry.gaps) ? entry.gaps : [];
    var difficulties = gaps.indexOf('no-challenge') >= 0
      ? ['advanced', 'standard', 'basic']
      : ['standard', 'basic', 'advanced'];

    var denied = Array.isArray(entry.descendants) ? entry.descendants.slice() : [];
    var allowed = Array.isArray(entry.prereqClosure) ? entry.prereqClosure.slice() : [];
    var route = denied.length < DESC_BLACKLIST_MAX ? 'desc-blacklist' : 'grade-chapter-whitelist';

    return {
      topicId: entry.topicId,
      answerShape: m.answerShape,
      verifyType: m.verifyType,
      constraints: {
        rubric: RUBRIC,
        difficulties: difficulties,
        syllabus: {
          /* 门 7 的路线：descendants 少 → 黑名单；≥50 → 同年级同章节白名单；算不出来 → fail-closed */
          route: route,
          allowed: allowed,
          denied: denied,
          descCount: denied.length,
          minTermLen: WHITELIST_MIN_TERM_LEN
        },
        /* 题面约束：不出带图题（裁决 2026-11-07：no-figure 3054 点放弃，不归本卡） */
        noFigure: true,
        /* 现有题只给 id 与题面，不给答案 */
        existingAnswersVisible: false
      }
    };
  }

  /* ================================================================
   * prompt 构建（同一套模板 + 字段插值，每族零手写文案）
   * ================================================================ */

  function _lines(arr, fmt) {
    var out = [];
    for (var i = 0; i < arr.length; i++) out.push(fmt(arr[i], i));
    return out.join('\n');
  }

  /** 概念词（用于 prompt 里点名「不得出现」的后继知识点）：优先名称，缺名称退 id。 */
  function denyTerms(syllabus, nameOf) {
    var ids = syllabus.denied || [];
    var terms = [];
    for (var i = 0; i < ids.length; i++) {
      var n = nameOf ? nameOf(ids[i]) : null;
      terms.push(n || ids[i]);
    }
    terms.sort();
    if (terms.length > PROMPT_DENY_CAP) terms = terms.slice(0, PROMPT_DENY_CAP);
    return terms;
  }

  /**
   * 构建 system + user 两份 prompt。
   * @param {object} recipe - recipeFromPlanEntry 的返回值
   * @param {object} ctx - {topic, existing:[{id,prompt}], standards:[{id,text?,confidence}], nameOf(id)}
   * @returns {{system:string, user:string}}
   */
  function buildPrompt(recipe, ctx) {
    ctx = ctx || {};
    var topic = ctx.topic || {};
    var existing = Array.isArray(ctx.existing) ? ctx.existing : [];
    var standards = Array.isArray(ctx.standards) ? ctx.standards : [];
    var syllabus = recipe.constraints.syllabus;

    var head = [
      '你是中国义务教育阶段的' + subjectLabel(topic.subject) + '出题老师。'
        + '请严格按下面的知识点字段，出 1 道可机验的数值题（type=numeric）。',
      '',
      '【知识点】' + (topic.id || recipe.topicId) + '｜' + (topic.name || '')
        + '｜' + (topic.grade != null ? topic.grade + ' 年级' : '年级未知')
        + (topic.chapter ? '｜' + topic.chapter : ''),
      '【知识点说明】' + (topic.description || '（数据缺失）')
    ];
    if (Array.isArray(topic.mastery_criteria) && topic.mastery_criteria.length) {
      head.push('【掌握标准】');
      head.push(_lines(topic.mastery_criteria, function (t, i) { return (i + 1) + '. ' + t; }));
    }
    if (standards.length) {
      head.push('【课标条目】');
      head.push(_lines(standards, function (s) {
        var title = s.text ? '：' + s.text : '';
        return '- ' + s.id + '（' + (s.confidence || 'unknown') + '）' + title;
      }));
    }

    var rules = [
      '',
      '【出题约束】',
      '1. 只能使用本知识点及其先修范围内已学的概念。' + _syllabusRule(syllabus, ctx),
      '2. 必须原创：不得照抄下面列出的已有题，也不得只把已有题的数字换掉（换数视为抄袭）。',
      '3. 答案必须唯一且可判：一个数值 / 一个根集 / 一个参数对，不能是「以上都对」这类模糊表述。',
      '4. explanation 第一句不得出现答案原文，也不得出现「系数化为」四个字。',
      recipe.constraints.noFigure
        ? '5. 不出带图题：题面不得依赖图形、表格或需要看图才能作答的信息。'
        : '5. 题面自包含。',
      '6. 题面里不要出现「AI 生成」「供练习」之类的元信息。'
    ];

    var existingBlock = '';
    if (existing.length) {
      existingBlock = '\n\n【已有题（只给 id 与题面，用于避让；不要复用，也不要换数）】\n'
        + _lines(existing, function (q) { return '- ' + q.id + '｜' + q.prompt; });
    }

    return {
      system: head.concat(rules).join('\n')
        + '\n\n【输出】严格输出一个 JSON 对象，不要任何多余文字（不要代码块围栏）：\n'
        + '{"prompt":"题面","answer":"答案","explanation":"分步解析","verify":"' + _verifyHint(recipe) + '",'
        + '"verifyType":"' + recipe.verifyType + '","difficulty":"' + DIFFICULTIES.join('|') + '"}',
      user: '【难度】' + _difficultyLine(recipe)
        + '\n\n【答案形态】' + SHAPE_FORMAT[recipe.answerShape]
        + existingBlock
    };
  }

  /** 门 7 的 prompt 侧表述（与实际判据同源：都读 recipe.constraints.syllabus） */
  function _syllabusRule(syllabus, ctx) {
    if (syllabus.route === 'desc-blacklist') {
      var terms = denyTerms(syllabus, ctx.nameOf);
      if (!terms.length) return '题面只能涉及本知识点的概念。';
      return '以下后继知识点的内容一律不得出现（超纲即废）：' + terms.join('、') + '。';
    }
    if (syllabus.route === 'grade-chapter-whitelist') {
      var t = ctx.topic || {};
      return '本题所属年级与章节是「' + (t.grade != null ? t.grade + ' 年级' : '年级未知') + ' '
        + (t.chapter || '章节未知') + '」，题面只许涉及同年级同章节的概念，'
        + '出现更高年级或其它章节的概念即超纲。';
    }
    return '本知识点缺少章节数据，按超纲处理（不会出题）。';
  }

  function _difficultyLine(recipe) {
    var d = recipe.constraints.difficulties[0];
    return d + '（' + RUBRIC[d] + '）';
  }

  function _verifyHint(recipe) {
    if (recipe.verifyType === 'numeric') return '由题面数字组成的算式，如 144/2';
    if (recipe.verifyType === 'completeSquare') return '可留空';
    if (recipe.verifyType === 'formParam') return '可留空';
    return '可留空';
  }

  /**
   * 把种子拼进 user prompt：同 seed → 字节相同；不同 seed → 不同文本（便于多样性与回放）。
   * @param {string} user
   * @param {string|number} seed
   * @returns {string}
   */
  function withSeed(user, seed) {
    return String(user) + '\n\n【变体种子】' + String(seed) + '（请换一组与已有题不同的数字与情境）';
  }

  /**
   * 请求体（不含任何时间戳/随机量）：同 (recipe, ctx, seed) 调两次得到字节相同的 JSON。
   * max_tokens 由调用方从 llm-config.js 取（本文件不写裸数字）。
   * @param {object} recipe
   * @param {object} ctx
   * @param {object} opts - {seed, model, maxTokens, temperature}
   * @returns {object}
   */
  function buildMessages(recipe, ctx, opts) {
    opts = opts || {};
    var p = buildPrompt(recipe, ctx);
    return [
      { role: 'system', content: p.system },
      { role: 'user', content: withSeed(p.user, opts.seed == null ? '' : opts.seed) }
    ];
  }

  return {
    VERSION: VERSION,
    ANSWER_SHAPE: ANSWER_SHAPE,
    VERIFY_TYPES: VERIFY_TYPES,
    DIFFICULTIES: DIFFICULTIES,
    RUBRIC: RUBRIC,
    PLAN_VERIFIER: PLAN_VERIFIER,
    DESC_BLACKLIST_MAX: DESC_BLACKLIST_MAX,
    WHITELIST_MIN_TERM_LEN: WHITELIST_MIN_TERM_LEN,
    PROMPT_DENY_CAP: PROMPT_DENY_CAP,
    subjectLabel: subjectLabel,
    recipeFromPlanEntry: recipeFromPlanEntry,
    buildPrompt: buildPrompt,
    buildMessages: buildMessages,
    withSeed: withSeed,
    denyTerms: denyTerms
  };
});
