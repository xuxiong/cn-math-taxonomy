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
    lines.push('【输出格式】只输出一个 JSON 对象，不要别的话，恰好 5 个键：what（是什么）、why（为什么要学）、how（怎么做）、demo（看个例子）、trap（容易错的地方）；每个值都是中文字符串，段内换行写成 \\n（JSON 转义）。');
    lines.push('【排版】每段用分点或分步写，一点一行；不要写成一大段；例子先出题面，再分步解答，最后一行写「答案：」；不要出现课标编号或课标原文。');
    lines.push('【每段形状】是什么 / 为什么要学 / 容易错的地方：写 1–3 个分点，一点一行。怎么做：写成分步，每步一行，以 1. 2. 3. 开头，不许写成「先做什么、然后做什么、最后做什么」一整句。看个例子：第一行写题面（必须是问句），中间分步解答，最后一行以「答案：」开头。');
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
   *   3) demo 必含问句（？或 ?）；
   *   4) demo 必有一行以「答案」开头（只查有没有，不查第几行）。 */
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
    var demo = asText(segs.demo);
    if (!/[？?]/.test(demo)) {
      reasons.push({ gate: 'G1', why: SEG_TITLES.demo + '缺少问句' });
    }
    var hasAnswer = demo.split('\n').some(function (line) {
      return line.trim().indexOf('答案') === 0;
    });
    if (!hasAnswer) {
      reasons.push({ gate: 'G1', why: SEG_TITLES.demo + '缺少以「答案」开头的行' });
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
    segsToText: segsToText
  };
});
