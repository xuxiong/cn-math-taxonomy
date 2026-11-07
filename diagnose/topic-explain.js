/* O4 卡 A：知识点讲解纯模块（素材组装 + 学科×学段 prompt + 5 段解析 + 讲解 5 闸 + 多轮追问 + 缓存读写）。
 *
 * 口径来源：docs/o4-topic-explain.md（D1–D23 / §3 素材 / §4 语言四档 / §5 闸门 / §6 学科语气 / §8 多轮）。
 * 本文件是**纯模块**：零 DOM、零 fetch、零 localStorage 直连、零 Date.now。
 *   - storage 由调用方注入（localStorage-like：getItem/setItem/removeItem/key/length）；
 *   - 模型由调用方注入（卡 B 负责真发送；本文件只产出 messages）；
 *   - 依赖复用：文本规范化走 textfmt.js 的 normalize，数值比对走 llm-eval.js 的 evaluateExpression，
 *     本文件没有第二份实现（这是卡面 §2 的硬要求）。
 *
 * UMD 与 diagnose/llm-gates.js 同款：浏览器 root.CnmTopicExplain，Node require() 直接拿到对象。
 * 浏览器侧必须在 textfmt.js、llm-eval.js 之后加载（卡 B 接线时注意脚本顺序）。
 *
 * 与卡面的两处如实披露（细节见交卡评论）：
 *   1) 卡面 §1 说收尾「与 textfmt.js 同款 module.exports = factory()」；本文件与 llm-gates.js 一致，
 *      写成 factory(require('./textfmt.js'), require('./llm-eval.js'))，把两个依赖显式注入 ——
 *      这样浏览器与 Node 走同一份依赖，不必再写第二套解析/求值。
 *   2) G5 同时查**原始文本**与 normalize 之后的文本：textfmt.normalize 会把 `**`、反引号洗掉，
 *      只查清洗后文本等于给 Markdown 泄漏开后门；两处都查才是「清洗后仍不过 → 拒」的严格版。
 *
 * 卡 A′（补卡 A 主动披露的两个缺口，口径来源 docs/o4-topic-explain.md §4.2 / §5）：
 *   - limitsOf 增加 forbidSymbols / requireRealLife 两键（仅 early 档为 true，其余三档 false），
 *     checkExplain 在 G1 里据此加「禁符号算式」与「demo 必须生活场景」两条布尔判据；
 *   - 新增 G7（讲解全文）与 G7r（追问答复）数字白名单闸：正文里每个数字 token 都必须能在
 *     本次素材里找到同形 token（+ allowedDigits + 小整数常量），逐 token 精确比对、不做算术等价。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./textfmt.js'), require('./llm-eval.js'));
  } else {
    root.CnmTopicExplain = factory(root.CnmTextFmt, root.DiagLLMEval);
  }
})(typeof self !== 'undefined' ? self : this, function (TextFmt, LLMEval) {
  'use strict';

  /* ================================================================
   * 0. 常量
   * ================================================================ */

  var SEG_KEYS = ['what', 'why', 'how', 'demo', 'trap'];
  var SEG_TITLES = {
    what: '这是什么',
    why: '为什么要学',
    how: '怎么做',
    demo: '看个例子',
    trap: '容易错的地方'
  };

  var MAX_ROUNDS = 10;      /* D19：单次会话 ≤10 轮追问（页面执行，本模块只给常量） */
  var WINDOW_ROUNDS = 6;    /* D17：中间问答窗口 6 轮（12 条） */
  var WINDOW_CHARS = 4000;  /* D17：窗口内总字符上限，从最早一轮成对丢 */
  var MAX_ENTRIES = 200;    /* §8.4：讲解缓存 200 条 LRU */

  var CACHE_PREFIX = 'cnmDiagnose.topicExplain.v1:';
  var MIN_NAME_LEN = 4;     /* G2：长度 < 4 字的知识点名不参与匹配（避免「数」「比」误命中） */
  var NUM_EPS = 1e-6;

  /* §4.2 幼儿级（1–2 年级）额外规则：不许出现符号算式。这里是唯一的符号表，
   * 判据是布尔命中（出现任意一个即拒），不用「命中率低于阈值」这类模糊判据。 */
  var EARLY_FORBID_SYMBOLS = [
    '+', '-', '＋', '－', '×', '÷', '*', '/', '=', '＝',
    '<', '>', '≤', '≥', '(', ')', '（', '）'
  ];

  /* §4.2 幼儿级：demo 段必须至少有一句是真生活场景（按句判定，任一句满足即通过）。
   * 卡 A‴ 起不再用「裸子串」：单字量词 / 动词会被「这个」「个人」「支持」这类词白撞。
   *   - 量词（LIFE_SCENE_MEASURES）：必须紧跟阿拉伯数字或中文数字（3 个 / 九个 / 十几个），
   *     裸「这个」「个人」不算；
   *   - 动作动词（LIFE_SCENE_ACTIONS）：只有该动词所在句子里同时出现数字才计数
   *     （「小明买了 9 个苹果」算，「把数字加起来」不算）；
   *   - 纯语法词 / 副词 / 术语（把 / 被 / 就 / 了 / 一共 / 平均）一个都不进表。 */
  var LIFE_SCENE_MEASURES = [
    '个', '只', '块', '元', '根', '本', '朵', '人', '颗', '盒', '袋', '张', '支', '瓶',
    '件', '米', '厘米'
  ];
  var LIFE_SCENE_ACTIONS = [
    '买', '卖', '送', '给', '分给', '拿走', '剩下', '还剩',
    '排队', '上车', '下车', '吃'
  ];
  /* 导出名保留（卡 B / 既有测试会读），内容只放动作动词。 */
  var LIFE_SCENE_WORDS = LIFE_SCENE_ACTIONS;

  /* 量词必须紧跟数字（阿拉伯或中文数字）；动作动词只在「同句有数字」时才计数。 */
  var LIFE_SCENE_MEASURE_RE = new RegExp(
    '(?:\\d+|[两二三四五六七八九十百千几]+)\\s*(?:' + LIFE_SCENE_MEASURES.join('|') + ')'
  );
  var LIFE_SCENE_DIGIT_RE = /(?:\d+|[两二三四五六七八九十百千几]+)/;

  /* G7 / G7r 的小整数白名单常量。卡 A″ 从 [0,1,2,3,4,5,10] 收窄到 [0,1]：
   * 中文里「第一步 / 两只手」本来就用汉字，不需要为「第 2 步」「10 只」放行阿拉伯数字；
   * 而 3/4/5/10 放行等于给「随口编个数」开了四个口子（素材里没有 3 也能写「3 个苹果」）。
   * 只留 0 与 1 —— 这两个数在任何语境下都不构成「编造题目数据」，且中文讲解里
   * 「0 个」「1 个」确实常见。超出 {0,1} 的数都必须能在本次素材里找到。 */
  var COMMON_SMALL_DIGITS = [0, 1];

  var LEVEL_LABELS = {
    early: '幼儿级（1-2 年级）',
    primary: '小学高年级（3-6 年级）',
    middle: '初中（7-9 年级）',
    high: '高中（10 年级以上）'
  };

  /* ================================================================
   * 1. 基础工具（纯函数）
   * ================================================================ */

  function asText(v) { return (v === null || v === undefined) ? '' : String(v); }

  /* 字数按 Unicode 码点算（中文一字一码点；emoji 等代理对不会被算成 2） */
  function charLen(s) { return Array.from(asText(s)).length; }

  function trimText(s) { return asText(s).trim(); }

  function isFiniteNum(n) { return typeof n === 'number' && isFinite(n); }

  function byLengthDesc(a, b) { return charLen(b) - charLen(a); }

  function gradeNumber(grade) {
    if (typeof grade === 'number' && isFinite(grade)) return grade;
    var m = /-?\d+(?:\.\d+)?/.exec(asText(grade));
    return m ? parseFloat(m[0]) : null;
  }

  /* 复用 textfmt.js：拿不到（脚本没先加载）就原样返回，绝不自己写第二份清洗实现 */
  function normalize(text) {
    if (!TextFmt || typeof TextFmt.normalize !== 'function') return asText(text);
    try { return asText(TextFmt.normalize(asText(text))); } catch (e) { return asText(text); }
  }

  /* 复用 llm-eval.js 的求值器（白名单 + new Function 在那边，本文件不新增求值实现） */
  function evalNum(expr) {
    if (!LLMEval || typeof LLMEval.evaluateExpression !== 'function') return null;
    var v = LLMEval.evaluateExpression(asText(expr), [0]);
    if (v && v.length && isFiniteNum(v[0])) return v[0];
    return null;
  }

  /* ================================================================
   * 2. 学段 / 语言四档（§4.2）
   * ================================================================ */

  function levelOf(grade) {
    var g = gradeNumber(grade);
    if (g === null) return 'primary';   /* 缺年级：按小学档兜底（档位决定长度，not 决定内容） */
    if (g <= 2) return 'early';
    if (g <= 6) return 'primary';
    if (g <= 9) return 'middle';
    return 'high';
  }

  var LEVEL_LIMITS = {
    early: {
      segMax: { what: 40, why: 40, how: 60, demo: 70, trap: 40 },
      replyMax: 60, sentenceMax: 12
    },
    primary: {
      segMax: { what: 60, why: 60, how: 90, demo: 110, trap: 60 },
      replyMax: 120, sentenceMax: 20
    },
    middle: {
      segMax: { what: 80, why: 80, how: 120, demo: 150, trap: 80 },
      replyMax: 150, sentenceMax: null
    },
    high: {
      segMax: { what: 100, why: 80, how: 140, demo: 160, trap: 100 },
      replyMax: 180, sentenceMax: null
    }
  };

  function limitsOf(level) {
    var key = LEVEL_LIMITS[level] ? level : 'primary';
    var L = LEVEL_LIMITS[key];
    return {
      segMax: {
        what: L.segMax.what, why: L.segMax.why, how: L.segMax.how,
        demo: L.segMax.demo, trap: L.segMax.trap
      },
      replyMax: L.replyMax,
      sentenceMax: L.sentenceMax,
      /* §4.2 幼儿级两条额外规则（其余三档 false）。卡 A′ 新增，既有三键不改不删。 */
      forbidSymbols: key === 'early',
      requireRealLife: key === 'early'
    };
  }

  /* ================================================================
   * 3. 学科语气（§6，10 学科 + 未知兜底）
   * ================================================================ */

  var TONES = {
    math: {
      key: 'math',
      label: '数学',
      tone: '讲算理，先讲为什么再讲怎么做，例子必须是算式题',
      forbid: ['使用未定义的符号']
    },
    physics: {
      key: 'physics',
      label: '物理',
      tone: '讲现象、规律到公式，例子用生活装置',
      forbid: ['编造实验数据']
    },
    chemistry: {
      key: 'chemistry',
      label: '化学',
      tone: '讲物质与反应，例子只用投放的题目',
      forbid: ['编造反应式（素材里没投放的就不写）']
    },
    biology: {
      key: 'biology',
      label: '生物',
      tone: '讲结构与功能的对应',
      forbid: ['编造物种名称', '编造数字']
    },
    science: {
      key: 'science',
      label: '科学',
      tone: '只讲现象与观察，不引入术语',
      forbid: ['使用公式']
    },
    chinese: {
      key: 'chinese',
      label: '语文',
      tone: '讲字词、句式、文体的规则，例子用真题句',
      forbid: ['编造诗文原文']
    },
    english: {
      key: 'english',
      label: '英语',
      tone: '讲用法与语境，例子用真题句',
      forbid: ['生造语法术语的中文译名']
    },
    history: {
      key: 'history',
      label: '历史',
      tone: '讲事件因果与时间定位',
      forbid: ['编造年份、人物、地名']
    },
    geography: {
      key: 'geography',
      label: '地理',
      tone: '讲空间与成因',
      forbid: ['编造数据']
    },
    morality: {
      key: 'morality',
      label: '道德与法治',
      tone: '讲概念与情境判断',
      forbid: ['编造法条编号']
    },
    general: {
      key: 'general',
      label: '',
      tone: '用平实的话讲清概念与做法，例子只用投放素材',
      forbid: ['编造事实']
    }
  };

  /* 学科中文名 / 别名 → key（只做归一，不是知识点名字面量） */
  var SUBJECT_ALIAS = {
    '数学': 'math', '物理': 'physics', '化学': 'chemistry', '生物': 'biology',
    '科学': 'science', '语文': 'chinese', '英语': 'english', '历史': 'history',
    '地理': 'geography', '道法': 'morality', '道德与法治': 'morality'
  };

  function subjectTone(subject) {
    var key = trimText(subject).toLowerCase();
    if (SUBJECT_ALIAS[key]) key = SUBJECT_ALIAS[key];
    var t = TONES[key] || TONES.general;
    return { key: t.key, tone: t.tone, forbid: t.forbid.slice() };
  }

  /* 知识点 id 前缀 → 学科（数据事实，不是知识点名）：全部由 topics.json 实测得出 */
  var SUBJECT_BY_PREFIX = {
    cnm: 'math', cne: 'english', cnc: 'chinese', cnp: 'physics', cns: 'science',
    cnd: 'morality', cnh: 'history', cng: 'geography', cnb: 'biology', cnk: 'chemistry'
  };

  function subjectOf(topic) {
    if (typeof topic === 'string') {
      return SUBJECT_BY_PREFIX[topic.split('_')[0]] || '';
    }
    if (topic && typeof topic === 'object') {
      if (topic.subject) return asText(topic.subject);
      return subjectOf(asText(topic.id));
    }
    return '';
  }

  /* ================================================================
   * 4. 先修（hard 优先，≤max，默认 6）
   * ================================================================ */

  function topicIndex(topics) {
    var map = {};
    if (Array.isArray(topics)) {
      topics.forEach(function (t) { if (t && t.id) map[t.id] = t; });
    } else if (topics && typeof topics === 'object') {
      Object.keys(topics).forEach(function (k) {
        var t = topics[k];
        if (t && typeof t === 'object' && t.id) map[t.id] = t;
        else if (typeof t === 'string') map[k] = { id: k, name: t };
      });
    }
    return map;
  }

  function prereqsOf(topicId, deps, topics, max) {
    var cap = (max === null || max === undefined) ? 6 : Math.max(0, Math.floor(Number(max) || 0));
    var idx = topicIndex(topics);
    var order = [];
    var best = {};
    (Array.isArray(deps) ? deps : []).forEach(function (e) {
      if (!e || e.topicId !== topicId || !e.prerequisiteId) return;
      var pid = asText(e.prerequisiteId);
      var strength = e.strength === 'soft' ? 'soft' : 'hard';
      if (!best[pid]) {
        order.push(pid);
        best[pid] = strength;
      } else if (strength === 'hard') {
        best[pid] = 'hard';
      }
    });
    var hard = [], soft = [];
    order.forEach(function (pid) {
      var row = { id: pid, name: (idx[pid] && idx[pid].name) || '', strength: best[pid] };
      if (row.strength === 'hard') hard.push(row); else soft.push(row);
    });
    return hard.concat(soft).slice(0, cap);
  }

  /* ================================================================
   * 5. 素材组装（buildInputs）—— §3 的八项
   * ================================================================ */

  var DIFF_RANK = { basic: 0, standard: 1, challenge: 2, advanced: 3 };

  /* standardsById 允许三种形状：{id: text} / {id: {id,text}} / {items:{...}}（课标库原样） */
  function standardsMap(standardsById) {
    var out = {};
    if (!standardsById || typeof standardsById !== 'object') return out;
    var items = (standardsById.items && typeof standardsById.items === 'object')
      ? standardsById.items : standardsById;
    Object.keys(items).forEach(function (k) {
      var v = items[k];
      if (v === null || v === undefined) return;
      if (typeof v === 'string') { out[k] = v; return; }
      if (typeof v !== 'object') return;
      if (v.id) out[asText(v.id)] = asText(v.text);
      else out[k] = asText(v.text);
    });
    return out;
  }

  function normalizeQuestion(q) {
    var out = {
      id: asText(q.id),
      difficulty: asText(q.difficulty) || 'basic',
      type: asText(q.type),
      prompt: normalize(asText(q.prompt)).trim(),
      answer: normalize(asText(q.answer)).trim(),
      explanation: normalize(asText(q.explanation)).trim(),
      answerText: ''
    };
    if (out.type === 'choice' && Array.isArray(q.choices)) {
      for (var i = 0; i < q.choices.length; i++) {
        var c = q.choices[i];
        if (c && asText(c.key) === out.answer) {
          out.answerText = normalize(asText(c.text)).trim();
          break;
        }
      }
    }
    return out;
  }

  /* 题库答案 → 可比较的数值集合（复用 llm-eval 求值；纯文字答案不进集合） */
  function answerValuesOf(questions) {
    var vals = [];
    questions.forEach(function (q) {
      var cands = [q.answer];
      var at = q.answerText;
      if (at) cands.push(at);
      cands.forEach(function (raw) {
        asText(raw).split(/[,，、;；]/).forEach(function (piece) {
          var s = piece.replace(/\s+/g, '');
          if (!s) return;
          var v = evalNum(s);
          var m = /^[a-zA-Z]=(.+)$/.exec(s);   /* x=3 / y=1/2 */
          if (v === null && m) v = evalNum(m[1]);
          if (v !== null && vals.indexOf(v) < 0) vals.push(v);
        });
      });
    });
    return vals;
  }

  function buildInputs(arg) {
    var o = arg || {};
    var topic = o.topic;
    if (!topic || !topic.id) throw new Error('topic-explain.buildInputs: 缺少 topic');
    var opts = o.opts || {};

    var allQuestions = (Array.isArray(o.questions) ? o.questions : [])
      .filter(function (q) { return q && trimText(q.prompt); })
      .map(normalizeQuestion);

    var level = levelOf(topic.grade);
    var limits = limitsOf(level);
    var subject = asText(opts.subject || subjectOf(topic));
    var tone = subjectTone(subject);

    var stdMap = standardsMap(o.standardsById);
    var standards = (Array.isArray(topic.standards) ? topic.standards : [])
      .filter(function (s) { return s && s.id; })
      .map(function (s) {
        var id = asText(s.id);
        return { id: id, confidence: asText(s.confidence), text: stdMap[id] || '' };
      });
    var noStandard = standards.length === 0;

    var prereqs = prereqsOf(topic.id, o.deps, o.topics, opts.maxPrereqs);

    var cap = (opts.exampleCount === null || opts.exampleCount === undefined)
      ? 3 : Math.max(1, Math.min(5, Math.floor(Number(opts.exampleCount) || 3)));
    var ordered = allQuestions.map(function (q, i) { return { q: q, i: i }; });
    ordered.sort(function (a, b) {
      var ra = DIFF_RANK[a.q.difficulty];
      var rb = DIFF_RANK[b.q.difficulty];
      if (ra === undefined) ra = 1;
      if (rb === undefined) rb = 1;
      if (ra !== rb) return ra - rb;
      return a.i - b.i;
    });
    var examples = ordered.slice(0, cap).map(function (row) { return row.q; });

    var whitelist = [];
    [asText(topic.name)].concat(prereqs.map(function (p) { return p.name; }))
      .forEach(function (n) {
        n = trimText(n);
        if (n && whitelist.indexOf(n) < 0) whitelist.push(n);
      });

    var namePool = [];
    var idx = topicIndex(o.topics);
    Object.keys(idx).forEach(function (k) {
      var n = trimText(idx[k].name);
      if (n && namePool.indexOf(n) < 0) namePool.push(n);
    });

    var questionText = allQuestions.map(function (q) { return q.prompt; }).join('\n');

    return {
      topicId: asText(topic.id),
      name: asText(topic.name),
      grade: topic.grade,
      level: level,
      limits: limits,
      subject: subject,
      tone: tone,
      desc: normalize(asText(topic.description)).trim(),
      criteria: (Array.isArray(topic.mastery_criteria) ? topic.mastery_criteria : [])
        .slice(0, 3).map(function (c) { return trimText(c); }).filter(Boolean),
      standards: standards,
      examples: examples,
      prereqs: prereqs,
      whitelist: whitelist,
      namePool: namePool,
      questionText: questionText,
      answerValues: answerValuesOf(allQuestions),
      noStandard: noStandard
    };
  }

  /* ================================================================
   * 6. prompt（学科 × 学段）
   * ================================================================ */

  function levelRuleText(inputs) {
    var L = (inputs && inputs.limits) || limitsOf(inputs && inputs.level);
    var parts = [
      '每段字数上限：是什么 ' + L.segMax.what + ' 字、为什么要学 ' + L.segMax.why +
      ' 字、怎么做 ' + L.segMax.how + ' 字、看个例子 ' + L.segMax.demo +
      ' 字、容易错的地方 ' + L.segMax.trap + ' 字'
    ];
    if (L.sentenceMax !== null && L.sentenceMax !== undefined) {
      parts.push('每句话不超过 ' + L.sentenceMax + ' 字（用句号、问号、感叹号、分号断句）');
    }
    parts.push('追问的回答不超过 ' + L.replyMax + ' 字');
    return parts.join('；');
  }

  function subjectLabel(key) {
    var t = TONES[key];
    return (t && t.label) ? t.label : '';
  }

  function teacherLine(inputs) {
    var label = subjectLabel(inputs.tone && inputs.tone.key);
    var grade = trimText(inputs.grade) || '';
    return '你是一位' + (LEVEL_LABELS[inputs.level] || LEVEL_LABELS.primary) +
      (label ? '的' + label : '') + '老师，正在给 ' + (grade ? grade + ' 年级学生' : '学生') + ' 讲「' +
      inputs.name + '」这个知识点。';
  }

  function whitelistLine(inputs) {
    var wl = (inputs.whitelist || []).filter(Boolean);
    if (!wl.length) return '只许提「' + inputs.name + '」，不许提别的知识点。';
    return '只许提这些知识点：' + wl.join('、') + '；不许提名单外的别的知识点。';
  }

  function explainSystem(inputs) {
    var tone = inputs.tone || subjectTone('');
    var lines = [];
    lines.push(teacherLine(inputs));
    lines.push('【讲课语气】' + tone.tone + '。');
    lines.push('【不许做的事】' + tone.forbid.join('；') + '；数字只用素材里出现过的，素材里没有的人名、年份、作品名、实验数据一律不许编。');
    lines.push('【语言档】' + (LEVEL_LABELS[inputs.level] || '') + '：' + levelRuleText(inputs) + '。');
    lines.push('【可以提到的知识点】' + whitelistLine(inputs));
    lines.push('【举例子】必须用下面素材里的例题；例子里的数必须来自那道题的题面；算出来的结果必须等于那道题的答案。');
    lines.push('【课标】引用课标原句时必须带上它的 cms-2022 编号，编号只能是素材里给出的；素材没有课标就不要引课标。');
    lines.push('【输出格式】只输出一个 JSON 对象，不要别的话，恰好 5 个键：what（是什么）、why（为什么要学）、how（怎么做，最多三步）、demo（看个例子）、trap（容易错的地方）；每个值都是纯中文字符串。');
    lines.push('【文字要求】短句，不要 Markdown（星号、井号、反引号），不要 LaTeX 反斜杠命令，不要代码块，不要省略号。');
    return { role: 'system', content: lines.join('\n') };
  }

  function materialText(inputs) {
    var L = [];
    L.push('【知识点】' + inputs.name + '（' + inputs.topicId + '）');
    L.push('【年级】' + asText(inputs.grade) + ' 年级');
    if (inputs.desc) L.push('【一句话介绍】' + inputs.desc);
    if (inputs.criteria && inputs.criteria.length) {
      L.push('【掌握标准】');
      inputs.criteria.forEach(function (c, i) { L.push((i + 1) + '. ' + c); });
    }
    L.push('【课标原文】');
    if (inputs.noStandard) {
      L.push('本点暂无对应课标条目。');
    } else {
      (inputs.standards || []).forEach(function (s) {
        L.push('- ' + s.id + '：' + (s.text || '（课标原文缺失）'));
      });
    }
    L.push('【例题】');
    if (!inputs.examples || !inputs.examples.length) {
      L.push('本点暂无例题。');
    } else {
      inputs.examples.forEach(function (e, i) {
        L.push((i + 1) + '. 题面：' + e.prompt);
        L.push('   答案：' + e.answer + (e.answerText ? '（' + e.answerText + '）' : ''));
        if (e.explanation) L.push('   解析：' + e.explanation);
      });
    }
    L.push('【直接先修】' + ((inputs.prereqs && inputs.prereqs.length)
      ? inputs.prereqs.map(function (p) { return p.name || p.id; }).join('、')
      : '这是起点，没有更早的先修知识点'));
    L.push('【学科语气】' + (inputs.tone ? inputs.tone.tone : ''));
    L.push('【语言档】' + levelRuleText(inputs));
    return L.join('\n');
  }

  function explainMessages(inputs) {
    return [
      explainSystem(inputs),
      {
        role: 'user',
        content: materialText(inputs) + '\n\n请按上面的要求，输出这个知识点的 5 段 JSON 讲解。'
      }
    ];
  }

  function segsToText(segs) {
    if (!segs || typeof segs !== 'object') return '';
    var out = [];
    SEG_KEYS.forEach(function (k) {
      var v = trimText(segs[k]);
      if (v) out.push('【' + SEG_TITLES[k] + '】' + v);
    });
    return out.join('\n');
  }

  function chatSystem(inputs) {
    var tone = inputs.tone || subjectTone('');
    var L = inputs.limits || limitsOf(inputs.level);
    var lines = [];
    lines.push(teacherLine(inputs));
    lines.push('学生刚听完你讲这个知识点，现在开始提问。');
    lines.push('【讲课语气】' + tone.tone + '。');
    lines.push('【不许做的事】' + tone.forbid.join('；') + '；数字只用素材里出现过的，素材里没有的人名、年份、作品名、实验数据一律不许编。');
    lines.push('【回答长度】每次回答不超过 ' + L.replyMax + ' 字' +
      (L.sentenceMax !== null && L.sentenceMax !== undefined ? '，每句不超过 ' + L.sentenceMax + ' 字' : '') + '。');
    lines.push('【一次只答一个问题】只回答与「' + inputs.name + '」有关的问题；学生问到别的知识点，先用一句话把话拉回本知识点。');
    lines.push('【不替学生做题】学生直接要答案时，让他自己算，问清卡在哪一步再帮他看。');
    lines.push('【可以提到的知识点】' + whitelistLine(inputs));
    lines.push('【课标】引用课标原句必须带上素材里给出的 cms-2022 编号。');
    lines.push('【输出格式】直接给纯文本回答，不要 JSON、不要小标题、不要 Markdown（星号、井号、反引号）、不要 LaTeX 反斜杠命令、不要代码块、不要省略号。');
    return { role: 'system', content: lines.join('\n') };
  }

  /* ================================================================
   * 7. 多轮 messages（D16/D17/D21）—— 前 3 条是锚点，永不出窗口
   * ================================================================ */

  /* 失败轮不入史：pending / failed / 空答 / 空问 一律跳过 */
  function validRounds(history) {
    var out = [];
    (Array.isArray(history) ? history : []).forEach(function (h) {
      if (!h || typeof h !== 'object') return;
      if (h.pending === true || h.failed === true) return;
      var q = h.q, a = h.a;
      if (typeof a !== 'string' || !a.trim()) return;
      if (typeof q !== 'string' || !q.trim()) return;
      out.push({ q: q, a: a });
    });
    return out;
  }

  function chatMessages(inputs, segs, history, question) {
    var ins = inputs || {};
    var anchors = [
      chatSystem(ins),
      { role: 'user', content: materialText(ins) },
      { role: 'assistant', content: segsToText(segs) }
    ];
    var rounds = validRounds(history).slice(-WINDOW_ROUNDS);
    var q = asText(question);

    var total = charLen(anchors[0].content) + charLen(anchors[1].content) +
      charLen(anchors[2].content) + charLen(q);
    rounds.forEach(function (r) { total += charLen(r.q) + charLen(r.a); });
    /* 按总字符从最早一轮成对丢；至少保留最近 1 轮（锚点本来就不参与裁剪） */
    while (total > WINDOW_CHARS && rounds.length > 1) {
      var dropped = rounds.shift();
      total -= charLen(dropped.q) + charLen(dropped.a);
    }

    var out = anchors.slice();
    rounds.forEach(function (r) {
      out.push({ role: 'user', content: r.q });
      out.push({ role: 'assistant', content: r.a });
    });
    out.push({ role: 'user', content: q });
    return out;
  }

  /* ================================================================
   * 8. 解析（半截 JSON 逐键抠，抠不到就 null，不猜）
   * ================================================================ */

  function stripFence(s) {
    var t = asText(s).trim();
    t = t.replace(/^```[A-Za-z0-9_-]*\s*/, '');
    t = t.replace(/\s*```\s*$/, '');
    return t.trim();
  }

  function unescapeJsonString(s) {
    return asText(s).replace(/\\(u[0-9a-fA-F]{4}|.)/g, function (all, g) {
      if (g.length === 5 && g[0] === 'u') {
        var code = parseInt(g.slice(1), 16);
        return isFinite(code) ? String.fromCharCode(code) : all;
      }
      switch (g) {
        case 'n': return '\n';
        case 't': return '\t';
        case 'r': return '\r';
        case 'b': return '\b';
        case 'f': return '\f';
        case '"': return '"';
        case '\\': return '\\';
        case '/': return '/';
        default: return g;
      }
    });
  }

  function segsFromObject(obj) {
    if (!obj || typeof obj !== 'object') return null;
    var segs = {}, missing = [];
    SEG_KEYS.forEach(function (k) {
      var v = obj[k];
      if (typeof v === 'string') segs[k] = v;
      else if (typeof v === 'number') segs[k] = String(v);
      else missing.push(k);
    });
    if (missing.length) return { segs: null, missing: missing };
    return { segs: segs, missing: [] };
  }

  function pickKey(raw, key) {
    /* 容忍半截 JSON：值里可以有未转义的换行，直到下一个引号为止 */
    var re = new RegExp('"' + key + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"');
    var m = re.exec(raw);
    return m ? unescapeJsonString(m[1]) : null;
  }

  function parseExplain(raw) {
    if (raw && typeof raw === 'object') {
      var direct = segsFromObject(raw);
      if (direct && direct.segs) return { segs: direct.segs };
      return { segs: null, why: '结构不全：缺 ' + (direct ? direct.missing.join('/') : '全部') };
    }
    var text = stripFence(raw);
    if (!text) return { segs: null, why: '空返回' };

    var parsed = null;
    try { parsed = JSON.parse(text); } catch (e) { parsed = null; }
    if (parsed && typeof parsed === 'object') {
      var fromJson = segsFromObject(parsed);
      if (fromJson && fromJson.segs) return { segs: fromJson.segs };
    }

    /* JSON 解析失败（截断 / 尾逗号 / 夹了说明文字）→ 逐键抠；少一个键就整份作废 */
    var segs = {}, missing = [];
    SEG_KEYS.forEach(function (k) {
      var v = pickKey(text, k);
      if (v === null) missing.push(k); else segs[k] = v;
    });
    if (missing.length) return { segs: null, why: '解析失败：缺 ' + missing.join('/') };
    return { segs: segs };
  }

  /* ================================================================
   * 9. 闸门（§5）
   * ================================================================ */

  function sentencesOf(text) {
    return asText(text).split(/[。？！;；]/)
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 0; });
  }

  function textOfSegs(segs) {
    var parts = [];
    SEG_KEYS.forEach(function (k) {
      if (segs && typeof segs[k] === 'string') parts.push(segs[k]);
    });
    return parts.join('\n');
  }

  /* G1 结构：5 键齐全 + 非空 + 每段字数 + 每句字数（sentenceMax 非 null 的档） */
  function gateStructure(segs, inputs, reasons) {
    var L = (inputs && inputs.limits) || limitsOf(inputs && inputs.level);
    var missing = [];
    SEG_KEYS.forEach(function (k) {
      if (!segs || typeof segs[k] !== 'string') missing.push(SEG_TITLES[k]);
    });
    if (missing.length) {
      reasons.push({ gate: 'G1', why: '缺少段落：' + missing.join('/') });
      return;
    }
    SEG_KEYS.forEach(function (k) {
      var t = trimText(segs[k]);
      if (!t) {
        reasons.push({ gate: 'G1', why: SEG_TITLES[k] + '为空' });
        return;
      }
      var n = charLen(t);
      if (n > L.segMax[k]) {
        reasons.push({ gate: 'G1', why: SEG_TITLES[k] + '太长（' + n + ' 字，上限 ' + L.segMax[k] + ' 字）' });
      }
      if (L.sentenceMax !== null && L.sentenceMax !== undefined && L.sentenceMax > 0) {
        var bad = sentencesOf(t).filter(function (s) { return charLen(s) > L.sentenceMax; });
        if (bad.length) {
          reasons.push({ gate: 'G1', why: SEG_TITLES[k] + '有 ' + bad.length + ' 句超过 ' + L.sentenceMax + ' 字' });
        }
      }
    });
  }

  /* G2 / G2r 不超纲：白名单外的知识点名一处都不许出现 */
  function gateWhitelist(text, inputs, reasons, gate) {
    var wl = (inputs && Array.isArray(inputs.whitelist)) ? inputs.whitelist.filter(Boolean) : [];
    var pool = (inputs && Array.isArray(inputs.namePool)) ? inputs.namePool : [];
    var masked = asText(text);
    wl.slice().sort(byLengthDesc).forEach(function (n) {
      if (n) masked = masked.split(n).join('\u0001');
    });
    var hits = [];
    pool.slice().sort(byLengthDesc).forEach(function (n) {
      if (!n || charLen(n) < MIN_NAME_LEN) return;
      if (wl.indexOf(n) >= 0) return;
      if (masked.indexOf(n) >= 0 && hits.indexOf(n) < 0) hits.push(n);
    });
    if (hits.length) {
      reasons.push({ gate: gate || 'G2', why: '提到了白名单外的知识点：' + hits.join('、') });
    }
  }

  var NUM_SRC = '-?\\d+(?:\\.\\d+)?';
  var FRAC_SRC = NUM_SRC + '(?:\\s*[\\/／]\\s*' + NUM_SRC + ')?';
  var OP_SRC = '\\+\\-−＋×÷*·⋅';
  var EXPR_SRC = '(' + FRAC_SRC + ')\\s*([' + OP_SRC + '])\\s*(' + FRAC_SRC + ')';
  var EQ_SRC = '(' + FRAC_SRC + '\\s*[' + OP_SRC + ']\\s*' + FRAC_SRC + ')\\s*[=＝]\\s*(' + FRAC_SRC + ')';

  function firstNumInRe(text, re) {
    var m, out = [];
    while ((m = re.exec(asText(text))) !== null) {
      out.push(m);
      if (m.index === re.lastIndex) re.lastIndex++;
    }
    return out;
  }

  /* 一个数（或分数）是否作为独立的数出现在文本里（13 里不算有 3） */
  function containsNumber(text, literal) {
    var s = asText(text).replace(/\s+/g, '');
    var l = asText(literal).replace(/\s+/g, '');
    if (!l) return false;
    var esc = l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('(^|[^0-9.])' + esc + '(?![0-9])').test(s);
  }

  function operandPresent(text, op) {
    if (containsNumber(text, op)) return true;
    if (/^[-\d.]+\s*[\/／]\s*[-\d.]+$/.test(op)) {
      var parts = op.split(/[\/／]/);
      return containsNumber(text, parts[0]) && containsNumber(text, parts[1]);
    }
    return false;
  }

  /* G3 引用一致 / G3r 算式不矛盾
   *  - 讲解轮（gate === 'G3'）：算式操作数必须出现在本点题面拼接文本里；demo 的结论数字必须是本点某道题的答案；
   *  - 追问轮（gate === 'G3r'）：允许引用学生自己给的数，只核对「算式本身成立」；
   *  - 两轮都做：`a 运算 b = c` 必须真的成立（含未知数的等式跳过，不做算术核对）；
   *  - 讲解里没有任何算式 → 通过（卡面明写「不是拒」）。
   *   注：按卡面口径「形如 a 运算 b」一律当算式，因此「1-2 年级」这类区间写法也会被当作算式核对
   *   （prompt 已要求只用素材里的数）；宁可多拦一次让模型重试，也不放过编造的算式。 */
  function gateNumbers(text, demoText, inputs, reasons, gate) {
    var isExplain = gate === 'G3';
    var qtext = asText(inputs && inputs.questionText);

    if (isExplain && qtext) {
      var missing = [];
      firstNumInRe(text, new RegExp(EXPR_SRC, 'g')).forEach(function (m) {
        [m[1], m[3]].forEach(function (raw) {
          var op = asText(raw).replace(/\s+/g, '');
          if (op && !operandPresent(qtext, op) && missing.indexOf(op) < 0) missing.push(op);
        });
      });
      if (missing.length) {
        reasons.push({ gate: gate, why: '算式里的数没出现在本点题面：' + missing.join('、') });
      }
    }

    var bad = [];
    firstNumInRe(text, new RegExp(EQ_SRC, 'g')).forEach(function (m) {
      var lhs = asText(m[1]).replace(/\s+/g, '');
      var rhs = asText(m[2]).replace(/\s+/g, '');
      if (/[a-zA-Z]/.test(lhs)) return;          /* 含未知数：不做算术核对 */
      var lv = evalNum(lhs), rv = evalNum(rhs);
      if (lv !== null && rv !== null && Math.abs(lv - rv) > NUM_EPS && bad.indexOf(m[0]) < 0) {
        bad.push(m[0]);
      }
    });
    if (bad.length) {
      reasons.push({ gate: gate, why: '算式与结果对不上：' + bad.join('，') });
    }

    if (isExplain) {
      var answers = (inputs && Array.isArray(inputs.answerValues)) ? inputs.answerValues : [];
      if (answers.length) {
        var results = [];
        firstNumInRe(asText(demoText),
          new RegExp('(?:[=＝]|答案[是为：:])\\s*(' + FRAC_SRC + ')', 'g')).forEach(function (m) {
          var v = evalNum(asText(m[1]).replace(/\s+/g, ''));
          if (v !== null) results.push(v);
        });
        if (results.length) {
          var hit = false;
          results.forEach(function (r) {
            answers.forEach(function (a) {
              if (Math.abs(a - r) <= NUM_EPS) hit = true;
            });
          });
          if (!hit) {
            reasons.push({ gate: 'G3', why: '例子给出的结果不是本点题库里的答案' });
          }
        }
      }
    }
  }

  /* G4 课标忠实：出现 cms-2022: 就必须是本点 standards 里的 id；无课标点跳过 */
  function gateStandards(text, inputs, reasons) {
    if (!inputs || inputs.noStandard === true) return;
    var ids = (inputs.standards || []).map(function (s) { return asText(s.id); });
    var bad = [];
    firstNumInRe(text, /cms-2022:[0-9A-Za-z._\-]+/g).forEach(function (m) {
      var id = asText(m[0]).replace(/[.。,，;；、）)]+$/, '');
      if (ids.indexOf(id) < 0 && bad.indexOf(id) < 0) bad.push(id);
    });
    if (bad.length) {
      reasons.push({ gate: 'G4', why: '引用了本点没有的课标编号：' + bad.join('、') });
    }
  }

  /* G5 文本卫生：原始文本与 normalize 之后都查（normalize 会把 ** 和反引号洗掉，不能只看洗后） */
  function gateHygiene(text, reasons) {
    var raw = asText(text);
    var norm = normalize(raw);
    var hits = [];
    if (raw.indexOf('**') >= 0 || norm.indexOf('**') >= 0) hits.push('星号加粗');
    if (raw.indexOf('`') >= 0 || norm.indexOf('`') >= 0) hits.push('反引号');
    if (/^[ \t]*#{1,6}[ \t]/m.test(raw)) hits.push('井号标题');
    if (/\\[A-Za-z]+/.test(raw) || /\\[A-Za-z]+/.test(norm)) hits.push('反斜杠命令');
    if (raw.indexOf('…') >= 0 || norm.indexOf('…') >= 0) hits.push('省略号占位');
    if (hits.length) {
      reasons.push({ gate: 'G5', why: '文本卫生：出现' + hits.join('、') });
    }
  }

  /* G1 早期档两条（§4.2 幼儿级额外规则；标志恒由 limitsOf 决定，其余三档整段跳过 → 行为一点不变）
   *   1) 禁符号算式：5 段正文（归一文本 norm）不得出现 EARLY_FORBID_SYMBOLS 里任何一个；
   *   2) 必须有生活场景：demo 段（归一文本 normDemo）按句判定，任一句满足即通过 ——
   *      量词紧跟数字（3 个 / 九个 / 十几个），或动作动词所在句同时出现数字。
   * 两条都是布尔命中，不做比例/阈值判断。归一文本由入口传入，本函数不再各自 normalize。 */
  function gateEarlyLevel(segs, inputs, reasons, norm, normDemo) {
    var L = (inputs && inputs.limits) || limitsOf(inputs && inputs.level);
    if (!L.forbidSymbols && !L.requireRealLife) return;

    if (L.forbidSymbols) {
      var text = asText(norm);
      var hits = [];
      EARLY_FORBID_SYMBOLS.forEach(function (sym) {
        if (text.indexOf(sym) >= 0 && hits.indexOf(sym) < 0) hits.push(sym);
      });
      if (hits.length) {
        reasons.push({ gate: 'G1', why: '1–2 年级不许出现符号算式：' + hits.join('') });
      }
    }

    if (L.requireRealLife) {
      var demo = asText(normDemo).trim();
      if (!demo) return;   /* 空段已由 G1 结构报过一次，不重复 */
      var found = false;
      demo.split(/[。！？!?；;\n]/).forEach(function (s) {
        if (found) return;
        var sent = s.trim();
        if (!sent) return;
        if (LIFE_SCENE_MEASURE_RE.test(sent)) { found = true; return; }
        if (LIFE_SCENE_DIGIT_RE.test(sent) && LIFE_SCENE_ACTIONS.some(function (w) {
          return sent.indexOf(w) >= 0;
        })) found = true;
      });
      if (!found) {
        reasons.push({ gate: 'G1', why: '1–2 年级的例子必须是生活场景，当前例子是抽象算式' });
      }
    }
  }

  /* 全角 → 半角归一（唯一实现）。闸门入口对 normalize 后的文本调用一次，之后
   * G2 / G3 / G4 / G7（含 G2r / G3r / G7r）与早期档符号 / 生活场景都只看归一文本。
   *
   * 为什么需要：模型偶尔输出全角数字 / 全角运算符（「３＋１＝２」），正则 /\d/ 与
   * 半角运算符整段失明 → G3r / G7 放行错误答案。归一后 ３ 与 3、＋ 与 + 走同一套判据。
   *
   * 映射（只做这些，不动全角字母）：
   *   ０-９ → 0-9，．→ .，％→ %，＋→ +，－→ -，×→ *，÷→ /，＝→ =，
   *   ＜→ <，＞→ >，≤→ <=，≥→ >=，（→ (，）→ )
   * 幂等：toNarrow(toNarrow(x)) === toNarrow(x)（所有目标字符都不在源字符集里）。
   * 唯一入口：digitTokens() 抽数前也调这一层，别处不许再写第二份映射表。 */
  var NARROW_MAP = {
    '\uFF0E': '.', '\uFF05': '%',
    '\uFF0B': '+', '\uFF0D': '-', '\u00D7': '*', '\u00F7': '/', '\uFF1D': '=',
    '\uFF1C': '<', '\uFF1E': '>', '\u2264': '<=', '\u2265': '>=',
    '\uFF08': '(', '\uFF09': ')'
  };
  function toNarrow(text) {
    return asText(text).replace(
      /[\uFF0E\uFF05\uFF0B\uFF0D\uFF1D\uFF1C\uFF1E\u2264\u2265\uFF08\uFF09\u00D7\u00F7\uFF10-\uFF19]/g,
      function (ch) {
        var code = ch.charCodeAt(0);
        if (code >= 0xFF10 && code <= 0xFF19) return String.fromCharCode(code - 0xFF10 + 0x30);
        return NARROW_MAP[ch];
      }
    );
  }

  /* G7 / G7r 数字白名单：正文里每个数字 token 都必须能在本次素材里找到同形 token。
   *   - 允许集合全部从入参算出（没有任何业务数字字面量白名单）；
   *   - 抽取规则 /\d+(?:\.\d+)?/g 逐 token 精确比对：1/2 抽成 1 与 2，两个都要在集合里；
   *   - 抽数前先走 toNarrow（全角 ７ / ３．５ 与 7 / 3.5 同判）；
   *   - 不做算术等价转换（3+4 不会因为 7 在素材里就放行），宁可保守；
   *   - 与既有闸门并列：命中只 push，不提前 return（多因一起返回）。
   * 素材来源 = 模型在 materialText 里真能看到的那些字段（卡面表格所列 6 项全在内），
   * 另外补上 grade / standards[].id / examples 的答案与解析 / 先修名 —— 这些也在素材里，
   * 不列会把「引用课标编号」（G4 反而要求必须带编号）判成编造。 */
  function digitTokens(text) {
    var s = toNarrow(text);
    var re = /\d+(?:\.\d+)?/g;
    var out = [], m;
    while ((m = re.exec(s)) !== null) {
      if (m[0] && out.indexOf(m[0]) < 0) out.push(m[0]);
      if (m.index === re.lastIndex) re.lastIndex++;
    }
    return out;
  }

  function digitAllowedSet(inputs) {
    var ins = inputs || {};
    var src = [
      asText(ins.name), asText(ins.desc), asText(ins.grade), asText(ins.questionText)
    ];
    (Array.isArray(ins.criteria) ? ins.criteria : []).forEach(function (c) { src.push(asText(c)); });
    (Array.isArray(ins.standards) ? ins.standards : []).forEach(function (s) {
      if (!s || typeof s !== 'object') return;
      src.push(asText(s.text));
      src.push(asText(s.id));
    });
    (Array.isArray(ins.examples) ? ins.examples : []).forEach(function (e) {
      if (!e || typeof e !== 'object') return;
      src.push(asText(e.prompt));
      src.push(asText(e.answer));
      src.push(asText(e.answerText));
      src.push(asText(e.explanation));
    });
    (Array.isArray(ins.prereqs) ? ins.prereqs : []).forEach(function (p) {
      if (!p || typeof p !== 'object') return;
      src.push(asText(p.name));
    });
    (Array.isArray(ins.answerValues) ? ins.answerValues : []).forEach(function (v) { src.push(asText(v)); });
    (Array.isArray(ins.allowedDigits) ? ins.allowedDigits : []).forEach(function (v) { src.push(asText(v)); });

    var allowed = [];
    src.forEach(function (s) {
      digitTokens(s).forEach(function (t) { if (allowed.indexOf(t) < 0) allowed.push(t); });
    });
    COMMON_SMALL_DIGITS.forEach(function (n) {
      var t = asText(n);
      if (allowed.indexOf(t) < 0) allowed.push(t);
    });
    return allowed;
  }

  function gateDigitWhitelist(text, inputs, reasons, gate) {
    var allowed = digitAllowedSet(inputs);
    var bad = digitTokens(asText(text)).filter(function (t) { return allowed.indexOf(t) < 0; });
    if (!bad.length) return;
    var why = '出现了素材里没有的数：' + bad.slice(0, 5).join('，');
    if (bad.length > 5) why += '（共 ' + bad.length + ' 个）';
    reasons.push({ gate: gate || 'G7', why: why });
  }

  function checkExplain(segs, inputs) {
    var reasons = [];
    var ins = inputs || {};
    if (!segs || typeof segs !== 'object') {
      reasons.push({ gate: 'G1', why: '讲解结构缺失' });
      return { ok: false, reasons: reasons };
    }
    var raw = textOfSegs(segs);
    var norm = toNarrow(normalize(raw));
    var normDemo = toNarrow(normalize(asText(segs.demo)));
    gateStructure(segs, ins, reasons);
    gateEarlyLevel(segs, ins, reasons, norm, normDemo);
    gateWhitelist(norm, ins, reasons, 'G2');
    gateNumbers(norm, normDemo, ins, reasons, 'G3');
    gateStandards(norm, ins, reasons);
    gateHygiene(raw, reasons);
    gateDigitWhitelist(norm, ins, reasons, 'G7');
    return { ok: reasons.length === 0, reasons: reasons };
  }

  /* question = 本轮学生提问原文（可选）。G7r 只额外放行**本轮问题里出现过的**数字，
   * 不放行整个 history 的数字（history 不在入参里，调用方也不许把它塞进 question）。 */
  function checkReply(text, inputs, question) {
    var reasons = [];
    var ins = inputs || {};
    var raw = asText(text);
    var norm = toNarrow(normalize(raw));
    var L = ins.limits || limitsOf(ins.level);

    if (!raw.trim()) {
      reasons.push({ gate: 'G6', why: '回复为空' });
    } else if (charLen(raw.trim()) > L.replyMax) {
      reasons.push({ gate: 'G6', why: '回复太长（' + charLen(raw.trim()) + ' 字，上限 ' + L.replyMax + ' 字）' });
    }
    gateWhitelist(norm, ins, reasons, 'G2r');
    gateNumbers(norm, norm, ins, reasons, 'G3r');
    gateStandards(norm, ins, reasons);
    gateHygiene(raw, reasons);

    var qins = ins;
    if (question !== null && question !== undefined && asText(question).trim()) {
      qins = {};
      Object.keys(ins).forEach(function (k) { qins[k] = ins[k]; });
      qins.questionText = asText(ins.questionText) + '\n' + asText(question);
    }
    gateDigitWhitelist(norm, qins, reasons, 'G7r');
    return { ok: reasons.length === 0, reasons: reasons };
  }

  /* ================================================================
   * 10. 缓存（key = topicId + 素材版本 + 模型；storage 由调用方注入）
   * ================================================================ */

  function fnv(str, seed) {
    var h = seed >>> 0;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ('00000000' + h.toString(16)).slice(-8);
  }

  function cacheKey(inputs, model) {
    var h = inputs || {};
    var parts = [
      'v1',
      asText(h.topicId),
      asText(h.name),
      asText(h.grade),
      asText(h.level),
      asText(h.desc),
      (h.criteria || []).join('|'),
      (h.standards || []).map(function (s) { return asText(s.id) + '=' + asText(s.text); }).join('|'),
      (h.examples || []).map(function (e) {
        return [asText(e.id), asText(e.prompt), asText(e.answer), asText(e.explanation)].join('~');
      }).join('|'),
      (h.prereqs || []).map(function (p) { return asText(p.id); }).join('|'),
      asText(model)
    ];
    var s = parts.join('\u0001');
    return CACHE_PREFIX + asText(h.topicId) + '|' + fnv(s, 0x811c9dc5) + fnv(s, 0x01000193);
  }

  function readCache(storage, key) {
    if (!storage || typeof storage.getItem !== 'function') return null;
    var raw;
    try { raw = storage.getItem(key); } catch (e) { return null; }
    if (raw === null || raw === undefined) return null;
    try {
      var v = JSON.parse(raw);
      return (v === undefined) ? null : v;
    } catch (e) {
      return null;
    }
  }

  function writeCache(storage, key, value) {
    if (!storage || typeof storage.setItem !== 'function') return false;
    try {
      storage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      return false;
    }
  }

  /* 保留最近 maxEntries 条（按 value.at 新的优先；没有 at 的按写入顺序，越晚越新） */
  function pruneCache(storage, maxEntries) {
    var max = (maxEntries === null || maxEntries === undefined)
      ? MAX_ENTRIES : Math.max(0, Math.floor(Number(maxEntries) || 0));
    if (!storage || typeof storage.key !== 'function' || typeof storage.removeItem !== 'function') return 0;
    var keys = [];
    var n = 0;
    try { n = Number(storage.length) || 0; } catch (e) { n = 0; }
    for (var i = 0; i < n; i++) {
      var k = null;
      try { k = storage.key(i); } catch (e) { k = null; }
      if (k && k.indexOf(CACHE_PREFIX) === 0) keys.push(k);
    }
    if (keys.length <= max) return 0;
    var rows = keys.map(function (k, order) {
      var v = readCache(storage, k);
      var at = (v && typeof v.at === 'number') ? v.at : -Infinity;
      return { k: k, at: at, order: order };
    });
    rows.sort(function (a, b) {
      if (a.at !== b.at) return a.at - b.at;
      return a.order - b.order;
    });
    var drop = rows.length - max;
    for (var j = 0; j < drop; j++) {
      try { storage.removeItem(rows[j].k); } catch (e) { /* 单条删失败不阻断淘汰 */ }
    }
    return drop;
  }

  /* ================================================================
   * 11. 导出（名字固定；末尾几个是给卡 B 的便利出口，不改上面任何一个）
   * ================================================================ */

  return {
    /* 卡面 §3 固定 API */
    levelOf: levelOf,
    limitsOf: limitsOf,
    subjectTone: subjectTone,
    prereqsOf: prereqsOf,
    buildInputs: buildInputs,
    explainMessages: explainMessages,
    parseExplain: parseExplain,
    checkExplain: checkExplain,
    chatMessages: chatMessages,
    checkReply: checkReply,
    cacheKey: cacheKey,
    readCache: readCache,
    writeCache: writeCache,
    pruneCache: pruneCache,
    MAX_ROUNDS: MAX_ROUNDS,
    WINDOW_ROUNDS: WINDOW_ROUNDS,
    WINDOW_CHARS: WINDOW_CHARS,
    /* 便利出口（卡 B 渲染/调试用） */
    SEG_KEYS: SEG_KEYS,
    SEG_TITLES: SEG_TITLES,
    LEVEL_LABELS: LEVEL_LABELS,
    CACHE_PREFIX: CACHE_PREFIX,
    MAX_ENTRIES: MAX_ENTRIES,
    subjectOf: subjectOf,
    materialText: materialText,
    segsToText: segsToText,
    /* 卡 A′ 两条早期档判据的词表 / 符号表 + G7 小整数常量（卡 B 也可读） */
    EARLY_FORBID_SYMBOLS: EARLY_FORBID_SYMBOLS,
    LIFE_SCENE_WORDS: LIFE_SCENE_WORDS,
    LIFE_SCENE_MEASURES: LIFE_SCENE_MEASURES,
    LIFE_SCENE_ACTIONS: LIFE_SCENE_ACTIONS,
    COMMON_SMALL_DIGITS: COMMON_SMALL_DIGITS
  };
});
