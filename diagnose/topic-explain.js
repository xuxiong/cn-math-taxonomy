/* O4 卡 A：知识点讲解纯模块（素材组装 + 学科×学段 prompt + 5 段解析 + 两道闸 + 多轮追问 + 缓存读写）。
 *
 * 口径：用户裁定闸门只留两道 —— G1 结构 / G5 文本卫生，全部布尔判据。
 * 本文件是**纯模块**：零 DOM、零 fetch、零 localStorage 直连、零 Date.now。
 *   - storage 由调用方注入（localStorage-like：getItem/setItem/removeItem/key/length）；
 *   - 模型由调用方注入（卡 B 负责真发送；本文件只产出 messages）；
 *   - 文本规范化复用 textfmt.js 的 normalize，本文件不写第二份清洗实现。
 *
 * UMD 与 diagnose/llm-gates.js 同款：浏览器 root.CnmTopicExplain，Node require() 直接拿到对象。
 * 浏览器侧必须在 textfmt.js 之后加载（卡 B 接线时注意脚本顺序）。
 */

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./textfmt.js'));
  } else {
    root.CnmTopicExplain = factory(root.CnmTextFmt);
  }
})(typeof self !== 'undefined' ? self : this, function (TextFmt) {
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

  /* ================================================================
   * 2. 学段 / 语言四档（档位只决定 prompt 措辞，不再有字数上限）
   * ================================================================ */

  function levelOf(grade) {
    var g = gradeNumber(grade);
    if (g === null) return 'primary';   /* 缺年级：按小学档兜底 */
    if (g <= 2) return 'early';
    if (g <= 6) return 'primary';
    if (g <= 9) return 'middle';
    return 'high';
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
   * 5. 素材组装（buildInputs）—— §3 的素材
   * ================================================================ */

  var DIFF_RANK = { basic: 0, standard: 1, challenge: 2, advanced: 3 };

  /* 卡 t_8f63df21：素材只收「能完整回填」的那一道题的字段。
   * 题面 / 选项 / 答案 / 答案原文 / 解析 由页面直出，模型只写分步解答 —— 素材照旧全给，
   * 但 choices 只留 key/text 两个字符串字段（figure 等重字段会爆炸，不进素材）。 */
  function normalizeQuestion(q) {
    var out = {
      id: asText(q.id),
      difficulty: asText(q.difficulty) || 'basic',
      type: asText(q.type),
      prompt: normalize(asText(q.prompt)).trim(),
      answer: normalize(asText(q.answer)).trim(),
      explanation: normalize(asText(q.explanation)).trim(),
      answerText: '',
      choices: []
    };
    if (out.type === 'choice' && Array.isArray(q.choices)) {
      for (var i = 0; i < q.choices.length; i++) {
        var c = q.choices[i];
        if (!c) continue;
        out.choices.push({ key: asText(c.key), text: normalize(asText(c.text)).trim() });
        if (!out.answerText && asText(c.key) === out.answer) {
          out.answerText = out.choices[out.choices.length - 1].text;
        }
      }
    }
    return out;
  }

  /* 选题（纯函数）：ordered 是已按难度升序的 [{q, i}]。页面只用 examples[0] 回填题面 / 选项 /
   * 答案 / 解析，所以优先挑「五块能填满」的那道：选择题（≥2 选项）且有解析 > 有解析 > 排第一的那道。
   * 返回题目对象，没有题返回 null。 */
  function pickExample(ordered) {
    var rows = Array.isArray(ordered) ? ordered : [];
    if (!rows.length) return null;
    var i, q;
    for (i = 0; i < rows.length; i++) {
      q = rows[i] && rows[i].q;
      if (q && q.type === 'choice' && q.choices && q.choices.length >= 2 && trimText(q.explanation)) return q;
    }
    for (i = 0; i < rows.length; i++) {
      q = rows[i] && rows[i].q;
      if (q && trimText(q.explanation)) return q;
    }
    return rows[0].q;
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
    var subject = asText(opts.subject || subjectOf(topic));
    var tone = subjectTone(subject);

    var prereqs = prereqsOf(topic.id, o.deps, o.topics, opts.maxPrereqs);

    /* 卡 t_8f63df21：默认只挑 1 道 —— 渲染层靠 examples[0] 回填，多塞的题只会拉长素材并
     * 把长尾推近 max_tokens。显式传 exampleCount 仍尊重（上限 5），第一道始终是 pickExample 挑的那道。 */
    var cap = (opts.exampleCount === null || opts.exampleCount === undefined)
      ? 1 : Math.max(1, Math.min(5, Math.floor(Number(opts.exampleCount) || 1)));
    var ordered = allQuestions.map(function (q, i) { return { q: q, i: i }; });
    ordered.sort(function (a, b) {
      var ra = DIFF_RANK[a.q.difficulty];
      var rb = DIFF_RANK[b.q.difficulty];
      if (ra === undefined) ra = 1;
      if (rb === undefined) rb = 1;
      if (ra !== rb) return ra - rb;
      return a.i - b.i;
    });
    var examples = [];
    if (ordered.length) {
      var picked = pickExample(ordered);
      examples.push(picked);
      if (cap > 1) {
        ordered.forEach(function (row) {
          if (examples.length < cap && row.q !== picked) examples.push(row.q);
        });
      }
    }

    var whitelist = [];
    [asText(topic.name)].concat(prereqs.map(function (p) { return p.name; }))
      .forEach(function (n) {
        n = trimText(n);
        if (n && whitelist.indexOf(n) < 0) whitelist.push(n);
      });

    return {
      topicId: asText(topic.id),
      name: asText(topic.name),
      grade: topic.grade,
      level: level,
      subject: subject,
      tone: tone,
      desc: normalize(asText(topic.description)).trim(),
      criteria: (Array.isArray(topic.mastery_criteria) ? topic.mastery_criteria : [])
        .slice(0, 3).map(function (c) { return trimText(c); }).filter(Boolean),
      examples: examples,
      prereqs: prereqs,
      whitelist: whitelist
    };
  }

  /* ================================================================
   * 6. prompt（学科 × 学段）
   * ================================================================ */

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
    lines.push('【可以提到的知识点】' + whitelistLine(inputs));
    lines.push('【举例子】必须用下面素材里的例题；例子里的数必须来自那道题的题面；算出来的结果必须等于那道题的答案。');
    lines.push('【不许引用课标】不要出现 `cms-2022` 之类的编号，也不要复述课标原文或课标要求。');
    lines.push('【输出格式】只输出一个 JSON 对象，不要别的话，恰好 6 个键：what（是什么）、why（为什么要学）、how（怎么做）、demo（看个例子）、trap（容易错的地方）、suggests（你可能想问）；前 5 个值都是中文字符串，段内换行写成 \\n（JSON 转义）；suggests 是字符串数组，恰好 3 条，每条 ≤ 20 字，每条都是一个学生能直接问出口的具体问题。');
    lines.push('【suggests 怎么写】贴住本题讲解来问，不许问「你想知道什么」「还有什么不懂」「需要我讲什么」这类空问；不许重复上面 5 段标题；问法要符合学段（低年级用日常话，不出现术语和公式）。');
    /* 卡 t_8f63df21：题面 / 选项 / 答案 / 解析由页面从题库直出，模型只写「看个例子」的分步解答 ——
     * 排版与每段形状都不再要求它抄题面、抄答案行。 */
    lines.push('【排版】每段用分点或分步写，一点一行；不要写成一大段；不要出现课标编号或课标原文。');
    lines.push('【每段形状】是什么 / 为什么要学 / 容易错的地方：写 1–3 个分点，一点一行。怎么做：写成分步，每步一行，以 1. 2. 3. 开头，不许写成「先做什么、然后做什么、最后做什么」一整句。看个例子：只写分步解答，一步一行，写 2–5 行；不要写题面、不要写选项字母、不要写答案、不要写解析（页面会显示）。');
    lines.push('【文字要求】短句，不要 Markdown（星号、井号、反引号），不要 LaTeX 反斜杠命令，不要代码块，不要省略号。');
    /* 卡 H 作答纪律：这是给模型的写作纪律，不是闸门 —— 代码里不许因它新增任何判定。
     * 实测（DeepSeek-V4.1-Flash，cnm_p031 口算加法，同一 prompt、max_tokens=4096）：
     * 推理长度有长尾，reasoning 5614–11272 字符那些次正文被吃光或截断（finish_reason=length），
     * 5 次里 3 次失败；加这一句后同一提示词 reasoning 1528 字符、5.2s 拿到完整 5 段。 */
    lines.push('答题要求：直接给出结论，不要在心里反复推演同一个点；想清楚一遍就写。');
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
    L.push('【例题】');
    if (!inputs.examples || !inputs.examples.length) {
      L.push('本点暂无例题。');
    } else {
      inputs.examples.forEach(function (e, i) {
        L.push((i + 1) + '. 题面：' + e.prompt);
        if (e.type === 'choice' && e.choices && e.choices.length) {
          /* 选项进素材：模型才知道答案字母指的是哪个选项（页面也照这份直出）。 */
          L.push('   选项：' + e.choices.map(function (c) {
            return asText(c.key) + '. ' + asText(c.text);
          }).join('｜'));
        }
        L.push('   答案：' + e.answer + (e.answerText ? '（' + e.answerText + '）' : ''));
        if (e.explanation) L.push('   解析：' + e.explanation);
      });
    }
    L.push('【直接先修】' + ((inputs.prereqs && inputs.prereqs.length)
      ? inputs.prereqs.map(function (p) { return p.name || p.id; }).join('、')
      : '这是起点，没有更早的先修知识点'));
    L.push('【学科语气】' + (inputs.tone ? inputs.tone.tone : ''));
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
    var lines = [];
    lines.push(teacherLine(inputs));
    lines.push('学生刚听完你讲这个知识点，现在开始提问。');
    lines.push('【讲课语气】' + tone.tone + '。');
    lines.push('【不许做的事】' + tone.forbid.join('；') + '；数字只用素材里出现过的，素材里没有的人名、年份、作品名、实验数据一律不许编。');
    lines.push('【一次只答一个问题】只回答与「' + inputs.name + '」有关的问题；学生问到别的知识点，先用一句话把话拉回本知识点。');
    lines.push('【不替学生做题】学生直接要答案时，让他自己算，问清卡在哪一步再帮他看。');
    lines.push('【可以提到的知识点】' + whitelistLine(inputs));
    lines.push('【不许引用课标】不要出现 `cms-2022` 之类的编号，也不要复述课标原文或课标要求。');
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

  /* 卡 t_1ff271ac：suggests（「你可能想问」）也顺手带出来 —— 与 5 段同一次响应、
   * 同一个 JSON.parse，页面层不用再解一遍。这是**附加字段**：返回结构里 segs 的
   * 语义与缺键判定一个字节都没动，checkExplain 也只吃 segs。
   * 半截 JSON 逐键抠那一步拿不到数组（pickKey 只认字符串），suggests 就是 undefined。 */
  function parseExplain(raw) {
    if (raw && typeof raw === 'object') {
      var direct = segsFromObject(raw);
      if (direct && direct.segs) return { segs: direct.segs, suggests: raw.suggests };
      return { segs: null, why: '结构不全：缺 ' + (direct ? direct.missing.join('/') : '全部'), suggests: raw.suggests };
    }
    var text = stripFence(raw);
    if (!text) return { segs: null, why: '空返回' };

    var parsed = null;
    try { parsed = JSON.parse(text); } catch (e) { parsed = null; }
    if (parsed && typeof parsed === 'object') {
      var fromJson = segsFromObject(parsed);
      if (fromJson && fromJson.segs) return { segs: fromJson.segs, suggests: parsed.suggests };
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

  /* 截断判定：网关把 reasoning 计入 max_tokens，推理长的那些次会
   * finish_reason=length 且正文可能一个字都没有。这不是格式问题，是没拿到东西，
   * 值得原样再要一次（同预算即可：推理长度是抖动的，重发常用的一次就够）。
   *
   * 判据只有两条：finish_reason === 'length'，或 message.content trim 后为空。
   * 空 body / 缺 choices / 取不到字符串 content 一律 false —— 那些走上层的「网关失败」分支，
   * 不当截断。纯函数，无副作用，不判断内容质量。 */
  function needsRefetch(body) {
    try {
      var ch = body && body.choices;
      if (!ch || !ch.length) return false;
      var c0 = ch[0];
      if (!c0 || typeof c0 !== 'object') return false;
      if (c0.finish_reason === 'length') return true;
      var msg = c0.message;
      if (!msg || typeof msg !== 'object') return false;
      var content = msg.content;
      if (typeof content !== 'string') return false;
      return !trimText(content);
    } catch (e) {
      return false;
    }
  }

  /* 网关错误体：网关在 HTTP 200 里回自己的业务错误包（实测 {"retCode":9}），
   * 没有 choices、没有 message —— 这不是模型的输出，不能按「格式」处理。
   *
   * 判据只有三类（别的都不加）：
   *   1) retCode 存在且 !== 0 → {code: retCode}；
   *   2) error 存在 → {code: error.code || error.type || 'error'}；
   *   3) 既无 choices 也无 message → {code: 'no-choices'}。
   * 有正常 choices 一律 null（拿到模型输出了，即便同时有 retCode:0）。
   * 纯函数，无副作用，不改入参，不判断内容质量。 */
  function gatewayErrorOf(body) {
    try {
      if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
      var has = Object.prototype.hasOwnProperty;

      /* 1) 显式 retCode（0 不算错误；0 且无 choices 会落到第 3 类） */
      if (has.call(body, 'retCode') && body.retCode !== 0) {
        return { code: body.retCode };
      }

      /* 2) 显式 error 对象 */
      if (has.call(body, 'error') && body.error) {
        return { code: body.error.code || body.error.type || 'error' };
      }

      /* 有正常 choices：拿到模型输出了，优先于 no-choices 兜底 */
      if (has.call(body, 'choices') && body.choices && body.choices.length) return null;

      /* 3) 兜底：既无 choices 也无 message */
      if (!has.call(body, 'choices') && !has.call(body, 'message')) {
        return { code: 'no-choices' };
      }

      return null;
    } catch (e) {
      return null;
    }
  }

  /* ================================================================
   * 9. 闸门（只剩两道：G1 结构 / G5 文本卫生）
   * ================================================================ */

  function textOfSegs(segs) {
    var parts = [];
    SEG_KEYS.forEach(function (k) {
      if (segs && typeof segs[k] === 'string') parts.push(segs[k]);
    });
    return parts.join('\n');
  }

  /* G1 结构（全布尔）：
   *   1) 5 段齐全且都是字符串；
   *   2) 每段 trim 后非空；
   *   3) demo（看个例子）只剩模型的「分步解答」，有效行数 < 2 视为没写分步。
   * 题面 / 选项 / 答案 / 解析由页面从题库回填，既不进模型输出、也不进闸门判据。 */
  function gateStructure(segs, reasons) {
    var missing = [];
    SEG_KEYS.forEach(function (k) {
      if (!segs || typeof segs[k] !== 'string') missing.push(SEG_TITLES[k]);
    });
    if (missing.length) {
      reasons.push({ gate: 'G1', why: '缺少段落：' + missing.join('/') });
      return;
    }
    SEG_KEYS.forEach(function (k) {
      if (!trimText(segs[k])) {
        reasons.push({ gate: 'G1', why: SEG_TITLES[k] + '为空' });
      }
    });
    var demoRows = asText(segs.demo).split('\n').filter(function (row) { return trimText(row); });
    if (demoRows.length < 2) {
      reasons.push({ gate: 'G1', why: SEG_TITLES.demo + '缺少分步' });
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

  function checkExplain(segs) {
    var reasons = [];
    if (!segs || typeof segs !== 'object') {
      reasons.push({ gate: 'G1', why: '讲解结构缺失' });
      return { ok: false, reasons: reasons };
    }
    gateStructure(segs, reasons);
    gateHygiene(textOfSegs(segs), reasons);
    return { ok: reasons.length === 0, reasons: reasons };
  }

  function checkReply(text) {
    var reasons = [];
    gateHygiene(asText(text), reasons);
    return { ok: reasons.length === 0, reasons: reasons };
  }

  /* ================================================================
   * 9b. suggests（「你可能想问」）—— 软校验，不是闸门
   *
   * 红线（卡 t_1ff271ac）：本函数只被页面层（explore/topic-ai.js）调用，**绝不进
   * checkExplain / gateStructure** —— chips 的好坏不许给讲解加任何一条 reasons，
   * 也不许把讲解打成 gate 状态。讲解的 5 段合格与否只由 §9 的两道闸决定。
   *
   * 返回 { ok, list, reasons }：
   *   - list：通过校验的条目，按原顺序，最多 3 条；
   *   - ok：list 非空（至少一条能用；调用方据此决定「无 chips」）；
   *   - reasons：恒为 []（软校验不产出闸门理由，免得下游把它当 gate 用）。
   *
   * 判据全部确定性（字数口径与模块内 charLen 一致：Array.from(s).length，中文一字一码点）：
   *   1) 入参必须是数组（缺失 / 类型不对 → 空 list，不报错）；
   *   2) 每条 trim 后非空、≤ 20 字；
   *   3) trim 后完全相同的算重复，只留第一次出现；
   *   4) 空问黑名单命中即剔除；
   *   5) 与 SEG_TITLES 的 5 个标题文本相同、或只差标点 → 剔除；
   *   6) 通过后最多留前 3 条。
   */
  var SUGGEST_MAX = 3;
  var SUGGEST_MAX_CHARS = 20;
  var SUGGEST_BAN = ['你想知道什么', '还有什么不懂', '需要我讲什么', '还有什么问题', '要我讲'];
  var SUGGEST_PUNCT_RE = /[\s，。、？！：；,\.\?!:;"'“”‘’「」『』（）()《》〈〉【】\[\]…—\-·．]/g;

  function bareSuggestion(s) { return asText(s).replace(SUGGEST_PUNCT_RE, ''); }

  function checkSuggest(v) {
    var empty = { ok: false, list: [], reasons: [] };
    if (!Array.isArray(v)) return empty;
    var titles = SEG_KEYS.map(function (k) { return bareSuggestion(SEG_TITLES[k]); });
    var seen = Object.create(null);
    var list = [];
    for (var i = 0; i < v.length; i++) {
      if (typeof v[i] !== 'string') continue;
      var s = trimText(v[i]);
      if (!s) continue;
      if (charLen(s) > SUGGEST_MAX_CHARS) continue;
      if (seen[s]) continue;
      var banned = false;
      for (var b = 0; b < SUGGEST_BAN.length; b++) {
        if (s.indexOf(SUGGEST_BAN[b]) >= 0) { banned = true; break; }
      }
      if (banned) continue;
      var bare = bareSuggestion(s);
      if (!bare) continue;
      var isTitle = false;
      for (var t = 0; t < titles.length; t++) {
        if (bare === titles[t]) { isTitle = true; break; }
      }
      if (isTitle) continue;
      seen[s] = true;
      list.push(s);
      if (list.length >= SUGGEST_MAX) break;
    }
    return { ok: list.length > 0, list: list, reasons: [] };
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
      /* 卡 t_8f63df21：v1 → v2（demo 结构变成「页面回填 + 模型分步」，旧条目必须自然不命中）。 */
      'v2',
      asText(h.topicId),
      asText(h.name),
      asText(h.grade),
      asText(h.level),
      asText(h.desc),
      (h.criteria || []).join('|'),
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
   * 11. 导出（名字固定；末尾几个是给卡 B 的便利出口）
   * ================================================================ */

  return {
    /* 卡面 §3 固定 API */
    levelOf: levelOf,
    subjectTone: subjectTone,
    prereqsOf: prereqsOf,
    buildInputs: buildInputs,
    explainMessages: explainMessages,
    parseExplain: parseExplain,
    needsRefetch: needsRefetch,
    gatewayErrorOf: gatewayErrorOf,
    checkExplain: checkExplain,
    chatMessages: chatMessages,
    checkReply: checkReply,
    checkSuggest: checkSuggest,
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
    pickExample: pickExample,
    segsToText: segsToText
  };
});
