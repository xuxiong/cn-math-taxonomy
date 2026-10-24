/* 作业分析文字 → 知识点定位 → 学习路径（kanban t_da399cfb）
 *
 * 输入是外部 app 对作业照片给出的**一段自然语言分析文字**，本模块负责：
 *   ① parseFields(text)    抽年级/学段/领域/章节/考点描述（纯确定性，正则 + 关键词）
 *   ② candidates(fields)   按降级阶梯筛候选池（纯确定性，只做筛选不做定位）
 *   ③ LLM 在候选池内选 1-3 个 + 置信度 + 理由（唯一需要网关的一步）
 *   ④ verifyPick(...)      确定性校验：id 必须在池内、名字必须与库一致、考点关键词必须对得上
 *   ⑤ prerequisites(...)   沿 hard 边回溯（soft 边单列「可选补充」，不进主路径）
 *   ⑥ buildPath(...)       只走 hard 边，每个节点标「候选，待测确认」
 *
 * 三条不可妥协的判据（来自用户）：
 *   - 定位不出就说定位不出，不猜。降级阶梯到底就说「信息不足，请补充年级」。
 *   - 置信度不高就给 3 个候选让学生点，不自作聪明只给一个。
 *   - 依赖图不是诊断结果。图只说明「谁是谁的前置」，不说明学生哪里断了；
 *     路径里的每个节点都是**候选薄弱点，待测确认**。
 *
 * 结构：UMD。浏览器 → window.DiagRoute；Node → require('./route.js')。
 * 数据靠 setData(topics, dependencies) 注入：Node 下测试直接 require JSON，
 * 浏览器下由 route-page.js 先 fetch data/*.json。本文件无 DOM、无 fetch、无 localStorage，
 * 保证纯函数层可以在 Node 里零依赖直测（fetch 由调用方注入，见 locate()）。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.DiagRoute = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ================================================================
   * 0. 数据注入
   * ================================================================ */

  var TOPICS = [];          /* 全部知识点（数学 + 英语） */
  var MATH = [];            /* 只留数学（id 前缀 cnm；cne 是 701 个英语知识点，必须排除） */
  var BY_ID = {};
  var PARENTS = {};         /* topicId → [{prerequisiteId, strength, reason}] */
  var CHAPTERS = [];        /* [{chapter, title, grade, num, kind}] */
  var TITLE_TO_CHAPTERS = {}; /* 章节标题 → [完整 chapter 字符串] */
  var CORPUS = {};          /* topicId → 用于语义校验的字符 n-gram 集合 */

  var ENGLISH_PREFIX = 'cne';
  var MATH_PREFIX = 'cnm';

  /* 领域 → 关键词（weight = 关键词长度，越长的词越具体，命中也越可信）
   * 只用于 ② candidates 的粗筛，不用于定位（关键词匹配定位实测只有 3% 覆盖率，这条路已死）。 */
  var DOMAIN_WORDS = {
    '数与代数': ['数与代数', '一元二次方程', '二元一次方程', '分式方程', '一元一次方程', '不等式组', '不等式', '因式分解',
      '配方法', '公式法', '整式', '分式', '二次根式', '有理数', '实数', '数列', '导数', '集合', '函数',
      '指数', '对数', '三角函数', '方程', '代数式', '绝对值', '幂', '多项式', '单项式', '系数',
      '解方程', '求根', '算术', '计算', '运算', '化简', '求值', '数轴', '相反数', '倒数', '平方根',
      '立方根', '开平方', '判别式', '韦达定理', '排列组合', '计数原理', '二项式', '向量运算'],
    '图形与几何': ['图形与几何', '三角形', '四边形', '平行四边形', '矩形', '菱形', '正方形', '梯形', '圆', '扇形', '弧',
      '相似', '全等', '轴对称', '中心对称', '平移', '旋转', '勾股定理', '垂径定理', '圆周角', '切线',
      '平行线', '垂线', '角平分线', '中位线', '立体图形', '圆柱', '圆锥', '棱柱', '球', '三视图',
      '投影', '视图', '平面直角坐标系', '坐标', '尺规作图', '作图', '证明', '几何', '面积', '周长',
      '体积', '边长', '对称', '空间向量', '立体几何', '解析几何', '直线与圆', '圆锥曲线'],
    '统计与概率': ['统计与概率', '统计', '概率', '随机', '抽样', '样本', '总体', '平均数', '中位数', '众数', '方差',
      '标准差', '频数', '频率', '直方图', '条形图', '折线图', '扇形图', '统计图', '分布', '期望',
      '回归', '相关性', '独立性检验', '随机变量', '古典概型'],
    '综合与实践': ['综合与实践', '综合实践', '数学建模', '建模', '课题学习', '实践活动', '探究活动']
  };

  /* 非数学学科：出现这些词且没有任何数学领域线索 → 直接拒绝定位，不强行匹配 */
  var NON_MATH_SUBJECTS = ['语文', '英语', '物理', '化学', '生物', '历史', '地理', '政治', '道德与法治',
    '阅读理解', '作文', '古诗', '文言文'];

  var CN_NUM = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };

  function cn2num(s) {
    if (!s) return null;
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    if (s === '十') return 10;
    if (/^十[一二三四五六七八九]$/.test(s)) return 10 + CN_NUM[s[1]];
    if (/^[一二三四五六七八九]十$/.test(s)) return CN_NUM[s[0]] * 10;
    if (/^[一二三四五六七八九]十[一二三四五六七八九]$/.test(s)) return CN_NUM[s[0]] * 10 + CN_NUM[s[2]];
    return CN_NUM[s] || null;
  }

  /** 章节标题：把「九上 第二十五章 一元二次方程 25.2」剥成「一元二次方程」 */
  function chapterTitle(ch) {
    var s = String(ch || '');
    s = s.replace(/^[^\s]+\s+/, '');                              /* 去掉第一个 token：九上 / 高一 / 选必二 / 一年级上册 */
    s = s.replace(/^第[一二三四五六七八九十百0-9]+\s*[章单元]\s*/, ''); /* 去掉「第二十五章」「第1单元」 */
    s = s.replace(/\s+[\d.]+(?:\s*[。（(].*)?$/, '');              /* 去掉尾部 25.2 / 34.1.1 */
    s = s.replace(/^(数学建模|数学探究)\s*/, '');                   /* 数学建模 建立函数模型 → 建立函数模型 */
    return s.trim();
  }

  function chapterNum(ch) {
    var m = /第([一二三四五六七八九十百0-9]+)\s*[章单元]/.exec(String(ch || ''));
    return m ? cn2num(m[1]) : null;
  }

  /* 语义校验用的字符 n-gram 集合（2~4 字），不用分词词典，纯确定性 */
  function ngrams(text, sizes) {
    var out = {};
    var s = String(text || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, ' ');
    var runs = s.split(/\s+/);
    for (var r = 0; r < runs.length; r++) {
      var run = runs[r];
      for (var n = 0; n < sizes.length; n++) {
        var k = sizes[n];
        for (var i = 0; i + k <= run.length; i++) out[run.substr(i, k)] = 1;
      }
    }
    return out;
  }

  function topicCorpus(t) {
    var parts = [t.name, t.description || ''];
    if (Array.isArray(t.mastery_criteria)) parts = parts.concat(t.mastery_criteria);
    return parts.join('；');
  }

  /**
   * 注入数据。
   * @param {Array} topics data/topics.json 的内容（数组）
   * @param {Array} dependencies data/dependencies.json 的内容（数组或 {dependencies: [...]}）
   */
  function setData(topics, dependencies) {
    TOPICS = Array.isArray(topics) ? topics : (topics && topics.topics) || [];
    var deps = Array.isArray(dependencies) ? dependencies
      : ((dependencies && dependencies.dependencies) || []);
    MATH = TOPICS.filter(function (t) {
      return t && typeof t.id === 'string' && t.id.indexOf(MATH_PREFIX) === 0 &&
        t.id.indexOf(ENGLISH_PREFIX) !== 0;
    });
    BY_ID = {};
    CORPUS = {};
    TOPICS.forEach(function (t) { if (t && t.id) BY_ID[t.id] = t; });
    MATH.forEach(function (t) { CORPUS[t.id] = ngrams(topicCorpus(t), [2, 3, 4]); });

    PARENTS = {};
    deps.forEach(function (e) {
      if (!e || !e.topicId || !e.prerequisiteId) return;
      if (!BY_ID[e.topicId] || !BY_ID[e.prerequisiteId]) return;
      (PARENTS[e.topicId] = PARENTS[e.topicId] || []).push({
        prerequisiteId: e.prerequisiteId,
        strength: e.strength === 'soft' ? 'soft' : 'hard',
        reason: e.reason || ''
      });
    });

    CHAPTERS = [];
    TITLE_TO_CHAPTERS = {};
    var seen = {};
    MATH.forEach(function (t) {
      if (!t.chapter || seen[t.chapter]) return;
      seen[t.chapter] = 1;
      var title = chapterTitle(t.chapter);
      var rec = { chapter: t.chapter, title: title, grade: t.grade, num: chapterNum(t.chapter) };
      CHAPTERS.push(rec);
      if (title) (TITLE_TO_CHAPTERS[title] = TITLE_TO_CHAPTERS[title] || []).push(t.chapter);
    });
    return { topics: MATH.length, dependencies: deps.length, chapters: CHAPTERS.length };
  }

  /* ================================================================
   * 1. parseFields —— 自由文字 → 字段（纯确定性）
   * ================================================================
   * 每个字段都是 { parsed: boolean, value: <值|null>, raw: <原文片段|null> }。
   * parsed=false 表示「没解析出」（value 必为 null），与「解析出空值」在结构上不可混淆。
   */

  var FIELD_NAMES = ['grade', 'stage', 'domain', 'chapter', 'topicHint'];

  function field(parsed, value, raw) {
    return { parsed: !!parsed, value: parsed ? value : null, raw: parsed ? (raw == null ? null : raw) : null };
  }

  /* 年级 → 筛选用的年级集合。13-16 是高中（不是大学）；12/13/14 是选择性必修三册，
   * 高三学生实际在学这三年级的点，所以「高三」要展开成 [12,13,14]。 */
  function gradesFor(grade) {
    if (grade == null) return [];
    if (grade >= 12) return [12, 13, 14];
    return [grade];
  }

  function stageOfGrade(g) {
    if (g == null) return null;
    if (g <= 6) return '小学';
    if (g <= 9) return '初中';
    return '高中';
  }

  function gradeLabel(g) {
    if (g == null) return '';
    if (g <= 6) return ['一', '二', '三', '四', '五', '六'][g - 1] + '年级（' + g + '年级/小学）';
    if (g <= 9) return '初' + ['一', '二', '三'][g - 7] + '（' + g + '年级/初中）';
    if (g === 12) return '高三（12 年级）';
    return '高' + ['一', '二'][Math.min(g - 10, 2)] + '（' + g + '年级/高中）';
  }

  /** 抽年级。返回 {grade, raw, source} 或 null */
  function parseGrade(text) {
    var m;
    /* 选择性必修一/二/三（库里 grade 12/13/14）、必修一/二（grade 10/11） */
    if ((m = /选必\s*([一二三])/.exec(text))) {
      return { grade: 11 + CN_NUM[m[1]], raw: m[0], source: '选必X' };
    }
    if ((m = /必修\s*([一二])/.exec(text))) {
      return { grade: 9 + CN_NUM[m[1]], raw: m[0], source: '必修X' };
    }
    /* 高中二年级 / 初中三年级 / 小学四年级 */
    if ((m = /(高中|初中|小学)\s*([一二三四五六])\s*年级/.exec(text))) {
      var st = m[1], n = CN_NUM[m[2]];
      if (st === '小学') return { grade: n, raw: m[0], source: '学段+年级' };
      if (st === '初中') return { grade: n + 6, raw: m[0], source: '学段+年级' };
      return { grade: n + 9, raw: m[0], source: '学段+年级' };
    }
    /* 七年级 / 九年级（初中说法） */
    if ((m = /([七八九])\s*年级/.exec(text))) {
      return { grade: CN_NUM[m[1]], raw: m[0], source: 'X年级' };
    }
    /* 一年级 ~ 六年级 */
    if ((m = /([一二三四五六])\s*年级/.exec(text))) {
      return { grade: CN_NUM[m[1]], raw: m[0], source: 'X年级' };
    }
    /* 数字写法：9年级 / 12 年级 */
    if ((m = /(\d{1,2})\s*年级/.exec(text))) {
      var d = parseInt(m[1], 10);
      if (d >= 1 && d <= 16) return { grade: Math.min(d, 14), raw: m[0], source: '数字年级' };
    }
    /* 高三 / 高二 / 高一（注意不能吃到「高中」里的「高」加「中」） */
    if ((m = /高([一二三])(?!年级)/.exec(text))) {
      return { grade: CN_NUM[m[1]] + 9, raw: m[0], source: '高X' };
    }
    /* 初三 / 初二 / 初一 */
    if ((m = /初([一二三])(?!年级)/.exec(text))) {
      return { grade: CN_NUM[m[1]] + 6, raw: m[0], source: '初X' };
    }
    return null;
  }

  /** 抽学段（显式提到，或由年级推出） */
  function parseStage(text) {
    var m = /(小学|初中|高中)/.exec(text);
    if (m) return { stage: m[1], raw: m[0], explicit: true };
    return null;
  }

  /** 抽领域：按关键词命中长度加权投票，最高分且 >0 才认 */
  function parseDomain(text) {
    var best = null;
    Object.keys(DOMAIN_WORDS).forEach(function (dom) {
      var score = 0, hits = [];
      DOMAIN_WORDS[dom].forEach(function (w) {
        if (text.indexOf(w) >= 0) { score += w.length; hits.push(w); }
      });
      if (score > 0 && (!best || score > best.score)) best = { domain: dom, score: score, hits: hits };
    });
    return best;
  }

  /** 抽章节：优先章节标题匹配（标题比编号更具体），其次「第X章」「第X单元」编号 */
  function parseChapter(text, grade) {
    /* 章节标题最长匹配。标题至少 2 字；2 字标题要求词边界，否则「二次函数」里的
     * 「函数」会被当成八下第二十二章「函数」——章节是极强的筛子，误判比不筛更糟。 */
    var titles = Object.keys(TITLE_TO_CHAPTERS).filter(function (t) { return t.length >= 2; });
    titles.sort(function (a, b) { return b.length - a.length; });
    for (var i = 0; i < titles.length; i++) {
      var title = titles[i];
      if (!textContainsTitle(text, title)) continue;
      var chs = TITLE_TO_CHAPTERS[title].slice();
      var recs = CHAPTERS.filter(function (c) { return chs.indexOf(c.chapter) >= 0; });
      var gg = bestGradeBucket(recs, grade);
      var keep = recs.filter(function (c) { return c.grade === gg; }).map(function (c) { return c.chapter; });
      return { title: title, raw: title, chapters: keep.length ? keep : chs };
    }

    var m = /第\s*([一二三四五六七八九十百0-9]{1,4})\s*([章单元])/.exec(text);
    if (m) {
      var num = cn2num(m[1]);
      var kind = m[2];
      var byNum = CHAPTERS.filter(function (c) {
        return c.num === num && String(c.chapter).indexOf('第' + m[1] + kind) >= 0;
      });
      if (!byNum.length) {
        byNum = CHAPTERS.filter(function (c) { return c.num === num; });
      }
      if (byNum.length) {
        var g = bestGradeBucket(byNum, grade);
        return { title: num ? ('第' + m[1] + kind) : m[0], raw: m[0],
          chapters: byNum.filter(function (c) { return c.grade === g; }).map(function (c) { return c.chapter; }) };
      }
    }
    return null;
  }

  /** 标题是否在文字里出现；2 字标题要求词边界（避免「二次函数」命中「函数」） */
  function textContainsTitle(text, title) {
    if (title.length >= 3) return text.indexOf(title) >= 0;
    var re = new RegExp('(^|[^\\u4e00-\\u9fa5])' + title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
      '([^\\u4e00-\\u9fa5]|$)');
    return re.test(text);
  }

  /** 章节候选里，若有与已解析年级同年级的，优先用它（同一章节名可能跨学段重名） */
  function bestGradeBucket(recs, grade) {
    if (grade == null) return recs.length ? recs[0].grade : null;
    var pool = gradesFor(grade);
    for (var i = 0; i < recs.length; i++) {
      if (pool.indexOf(recs[i].grade) >= 0) return recs[i].grade;
    }
    /* 年级对不上时允许邻近 1 个年级（上册/下册、以及教材编排差一学期的情况） */
    for (var j = 0; j < recs.length; j++) {
      if (Math.abs(recs[j].grade - grade) <= 1) return recs[j].grade;
    }
    return recs.length ? recs[0].grade : null;
  }

  /* 考点描述里要剥掉的填充词（不含「解」「求」这类有信息量的字） */
  var HINT_FILLERS = /(这是一道|这是一份|这部分是|这是|这道|那道|一道|两份|该生|该学生|题目|习题|试题|作业|照片|图片|截图|识别|分析|文字|学生|孩子|同学|作答|答案|算到|写到|一半|卡住|不会|做错|错了|出错|失败|不理解|没掌握|比较困难|困难|考查|考察|测试|涉及|主要是|主要考|内容为|本题|该题|这题|数学|题)/g;

  /** 抽考点描述：按标点切句，剥掉已解析字段和填充词，取剩下最长的一句 */
  function parseTopicHint(text, consumed) {
    var clauses = String(text || '').split(/[，,。；;！!？?\n\r、]+/);
    var best = null;
    clauses.forEach(function (c) {
      var s = String(c).trim();
      if (!s) return;
      consumed.forEach(function (w) {
        if (!w) return;
        while (s.indexOf(w) >= 0) s = s.replace(w, ' ');
      });
      s = s.replace(/[（(][^）)]*[）)]/g, ' ');
      s = s.replace(/第[一二三四五六七八九十百0-9]{1,4}\s*[章单元]/g, ' ');
      s = s.replace(/(^|\s)[上下](?=\S)/g, ' ');
      var stripped = s.replace(HINT_FILLERS, ' ').replace(/[的地得着了呢吗]/g, ' ').replace(/等(?=\s|$)/g, ' ').trim();
      stripped = stripped.replace(/\s+/g, '');
      if (stripped.length < 2) return;
      if (!best || stripped.length > best.length) best = stripped;
    });
    return best;
  }

  function detectSubject(text, domainHit) {
    var explicit = null;
    for (var i = 0; i < NON_MATH_SUBJECTS.length; i++) {
      if (text.indexOf(NON_MATH_SUBJECTS[i]) >= 0) {
        explicit = NON_MATH_SUBJECTS[i];
        if (explicit === '阅读理解' || explicit === '作文' || explicit === '古诗' || explicit === '文言文') {
          explicit = '语文';
        }
        break;
      }
    }
    var saysMath = text.indexOf('数学') >= 0;
    /* 明确提到别的学科、而全文一个字都没提「数学」→ 不是数学题。
     * 领域关键词不能救：语文阅读里也可能出现「面积」「计算」这类词。 */
    if (explicit) return { value: explicit, parsed: true, math: saysMath };
    if (saysMath) return { value: '数学', parsed: true, math: true };
    return { value: null, parsed: false, math: true };
  }

  /**
   * parseFields(text) —— 抽字段。纯函数，不调 LLM。
   * @returns {Object} 见文件头。附加 missing 数组（未解析出的字段名，用于页面显式标「未解析出」）。
   */
  function parseFields(text) {
    var t = String(text == null ? '' : text);
    var g = parseGrade(t);
    var st = parseStage(t);
    var dom = parseDomain(t);

    var gradeVal = g ? g.grade : null;
    if (gradeVal == null && st) {
      /* 只说了学段没说年级：grade 仍算未解析出，stage 已解析出 */
    }
    var stageVal = st ? st.stage : stageOfGrade(gradeVal);

    var ch = parseChapter(t, gradeVal);

    var consumed = [];
    if (g) {
      consumed.push(g.raw);
      /* 「高一下」「初一下」里的册次：年级原文后面紧跟的上/下也别留在考点描述里 */
      if (text.indexOf(g.raw) >= 0 && /^[上下]/.test(text.slice(text.indexOf(g.raw) + g.raw.length))) {
        consumed.push(g.raw + text.charAt(text.indexOf(g.raw) + g.raw.length));
      }
    }
    if (st) consumed.push(st.raw);
    /* 章节不剥：章节名往往就是「考什么」本身（「一元二次方程」），剥掉等于把语义锚点扔了。
     * 只剥领域标签（「数与代数」这种），领域关键词（配方法/方程）必须留着。 */
    if (dom) consumed.push(dom.domain);
    consumed.sort(function (a, b) { return b.length - a.length; });  /* 长的先剥：「高一下」要先于「高一」 */
    var hint = parseTopicHint(t, consumed);

    var subject = detectSubject(t, dom);

    var f = {
      text: t,
      grade: g ? field(true, g.grade, g.raw) : field(false, null, null),
      gradeSource: g ? g.source : null,
      grades: gradesFor(gradeVal),
      stage: stageVal ? field(true, stageVal, (st && st.raw) || null) : field(false, null, null),
      domain: dom ? field(true, dom.domain, dom.hits.join('、')) : field(false, null, null),
      domainScore: dom ? dom.score : 0,
      chapter: ch ? field(true, ch.title, ch.raw) : field(false, null, null),
      chapters: ch ? ch.chapters.slice() : [],
      topicHint: hint ? field(true, hint, hint) : field(false, null, null),
      subject: subject,
      missing: []
    };
    FIELD_NAMES.forEach(function (k) { if (!f[k].parsed) f.missing.push(k); });
    return f;
  }

  /* ================================================================
   * 2. candidates —— 降级阶梯（纯确定性）
   * ================================================================
   * 年级 + 领域  → ~10-25（有章节线索时更窄）
   * 学段 + 领域  → ~50-140
   * 只有领域     → ~150-400
   * 什么都解析不出 → ok:false + 「信息不足，请补充年级」，不给任何知识点
   *
   * 注意：候选池只是**筛选**，不是定位。定位交给 LLM，再由 verifyPick 确定性校验。
   */

  var MIN_POOL = 3; /* 章节筛完少于 3 个就认为章节线索不可靠，退回上一级 */

  function candidates(fields) {
    var f = fields || {};
    var hasGrade = !!(f.grade && f.grade.parsed);
    var hasStage = !!(f.stage && f.stage.parsed);
    var hasDomain = !!(f.domain && f.domain.parsed);
    var hasChapter = !!(f.chapter && f.chapter.parsed) && (f.chapters || []).length > 0;

    if (!hasGrade && !hasDomain) {
      return {
        ok: false, level: 'none', levelLabel: '信息不足', topics: [], count: 0,
        reason: '信息不足，请补充年级',
        detail: '这段文字里没解析出年级/学段，也没解析出数学领域。' +
          '没有年级就没有办法把 802 个数学知识点缩小到可判断的范围——宁可让你补一句年级，也不猜。'
      };
    }

    var base = MATH.slice();
    var level, levelLabel;

    if (hasGrade) {
      var gpool = f.grades && f.grades.length ? f.grades : gradesFor(f.grade.value);
      base = base.filter(function (t) { return gpool.indexOf(t.grade) >= 0; });
      level = hasDomain ? 'grade+domain' : 'grade';
      levelLabel = hasDomain ? '年级 + 领域' : '年级';
    } else if (hasStage) {
      base = base.filter(function (t) { return stageOfGrade(t.grade) === f.stage.value; });
      level = hasDomain ? 'stage+domain' : 'stage';
      levelLabel = hasDomain ? '学段 + 领域' : '学段';
    } else {
      level = 'domain';
      levelLabel = '只有领域';
    }

    if (hasDomain) {
      base = base.filter(function (t) { return t.domain === f.domain.value; });
    }

    var chapterUsed = null;
    var chapterNote = null;
    /* 章节只在已经解析出年级时才当筛子：只有领域时章节标题太容易撞车
     * （「函数」「相似」「旋转」这种 2 字标题），会把 401 缩到个位数，召回风险不值当。 */
    if (hasChapter && hasGrade) {
      var narrowed = base.filter(function (t) { return f.chapters.indexOf(t.chapter) >= 0; });
      if (narrowed.length >= MIN_POOL) {
        chapterUsed = f.chapter.value;
        base = narrowed;
      } else if (narrowed.length > 0) {
        chapterNote = '章节线索「' + f.chapter.value + '」与其它字段交叉后只剩 ' + narrowed.length +
          ' 个知识点，不足 3 个，为保证召回不采用该章节筛子';
      } else {
        chapterNote = '章节线索「' + f.chapter.value + '」与其它字段对不上任何知识点，已忽略';
      }
    }

    return {
      ok: base.length > 0,
      level: base.length ? level : 'none',
      levelLabel: levelLabel,
      topics: base,
      count: base.length,
      chapterUsed: chapterUsed,
      chapterNote: chapterNote,
      reason: base.length ? null : '信息不足，请补充年级',
      detail: base.length ? null : '降级阶梯走到底仍然筛不出候选（字段之间互相矛盾），不做猜测。'
    };
  }

  /* ================================================================
   * 3. 语义校验（verifyPick）—— 防幻觉的关键
   * ================================================================
   * 三条硬规则：
   *   规则1 选中 id 必须在候选池内
   *   规则2 返回的知识点名必须是库里真实存在的名字（且与 id 对应）
   *   规则3 考点描述的关键词必须能在该知识点 name/description/mastery_criteria 里找到对应
   *         完全对不上 → 拒绝；对上一部分 → 降置信度并标注
   */

  var MIN_COVERAGE = 0.18;   /* 低于此覆盖率：降置信度 */
  var REJECT_COVERAGE = 0;   /* 等于 0：拒绝 */

  /** 考点描述 vs 知识点文本的覆盖率：hint 的 2~4 字 n-gram 有多少能在知识点文本里找到 */
  function hintCoverage(hint, topic) {
    var h = String(hint || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
    if (h.length < 4) return null;           /* 太短，判不了 */
    var grams = ngrams(h, [2, 3, 4]);
    var keys = Object.keys(grams);
    if (!keys.length) return null;
    var corpus = CORPUS[topic.id] || ngrams(topicCorpus(topic), [2, 3, 4]);
    var hit = 0;
    for (var i = 0; i < keys.length; i++) if (corpus[keys[i]]) hit++;
    return hit / keys.length;
  }

  function clamp01(x) { return Math.max(0, Math.min(1, x)); }

  /**
   * verifyPick(picks, opts) —— 确定性校验 LLM 的选择。
   * @param {Array} picks [{id, name, confidence, reason}]
   * @param {Object} opts {pool: [...topics], fields: parseFields 结果}
   * @returns {Object} {ok, kept:[...], rejected:[{id,name,rule,why}], why:[...]}
   */
  function verifyPick(picks, opts) {
    var o = opts || {};
    var pool = o.pool || [];
    var fields = o.fields || {};
    var poolIds = {};
    pool.forEach(function (t) { poolIds[t.id] = 1; });
    var hint = fields.topicHint && fields.topicHint.parsed ? fields.topicHint.value : null;

    var why = [], kept = [], rejected = [];
    var list = Array.isArray(picks) ? picks : [];

    if (!list.length) {
      return { ok: false, kept: [], rejected: [], why: ['LLM 没有返回任何选择'], hintUsed: hint };
    }

    list.forEach(function (p) {
      var id = String((p && p.id) || '').trim();
      var name = String((p && p.name) || '').trim();
      var conf = Number(p && p.confidence);
      if (!isFinite(conf)) conf = 0.5;

      /* 规则1：id 必须在库中且在候选池内 */
      var topic = BY_ID[id];
      if (!topic) {
        /* LLM 只给了名字没给 id：名字在池内唯一时按名字回填，否则拒绝 */
        var byName = pool.filter(function (t) { return t.name === name; });
        if (byName.length === 1) { topic = byName[0]; id = topic.id; }
        else {
          rejected.push({ id: id, name: name, rule: '规则1', why: 'id「' + (id || '(空)') + '」不在知识点库里，且名字「' + (name || '(空)') + '」也无法在候选池里唯一定位' });
          return;
        }
      }
      if (!poolIds[id]) {
        rejected.push({ id: id, name: name, rule: '规则1', why: '「' + topic.name + '」(' + id + ') 不在本次候选池内（候选池 ' + pool.length + ' 个），LLM 越出候选范围' });
        return;
      }
      /* 规则2：名字必须是库里真实的名字 */
      if (name && name !== topic.name) {
        rejected.push({ id: id, name: name, rule: '规则2', why: 'id ' + id + ' 在库里对应的名字是「' + topic.name + '」，LLM 说的是「' + name + '」——名字对不上，按编造处理' });
        return;
      }

      /* 规则3：考点描述关键词必须对得上 */
      var cov = hint ? hintCoverage(hint, topic) : null;
      var notes = [];
      var finalConf = clamp01(conf);
      if (cov === null) {
        finalConf = clamp01(conf * 0.7);
        notes.push(hint ? '考点描述太短，无法做语义核对' : '未解析出考点描述，语义未核对');
      } else if (cov <= REJECT_COVERAGE) {
        rejected.push({ id: id, name: name, rule: '规则3', why: '考点描述「' + hint + '」里的关键词在「' + topic.name + '」的 name/description/mastery_criteria 里完全找不到对应' });
        return;
      } else if (cov < MIN_COVERAGE) {
        finalConf = clamp01(conf * 0.6);
        notes.push('考点描述与知识点文本的关键词覆盖率仅 ' + Math.round(cov * 100) + '%，置信度已下调');
      }

      kept.push({
        id: id,
        name: topic.name,
        grade: topic.grade,
        domain: topic.domain,
        chapter: topic.chapter,
        confidence: Math.round(finalConf * 100) / 100,
        llmConfidence: conf,
        coverage: cov === null ? null : Math.round(cov * 1000) / 1000,
        reason: (p && p.reason) || '',
        notes: notes
      });
    });

    /* 置信度排序；只有 1 个且置信度 < 0.5 → 仍然保留，但页面要提示「只是候选，请确认」 */
    kept.sort(function (a, b) { return b.confidence - a.confidence; });
    if (kept.length > 3) kept = kept.slice(0, 3);

    if (!kept.length) {
      why = rejected.map(function (r) { return r.rule + '：' + r.why; });
      return { ok: false, kept: [], rejected: rejected, why: why, hintUsed: hint };
    }
    return { ok: true, kept: kept, rejected: rejected, why: [], hintUsed: hint };
  }

  /* ================================================================
   * 4. prerequisites / buildPath —— 只走 hard 边
   * ================================================================
   * 依赖图不是诊断结果。图只说明「谁是谁的前置」，不说明学生哪里断了。
   * 所以这里产出的每个节点都是**候选薄弱点**，必须学生做题确认。
   *
   * 噪音过滤（两条，均来自实测）：
   *   a) soft 边 + 前置年级比目标低 4 年以上 → 过滤（配方法 ← 三年级「长方形和正方形的面积」）
   *   b) 目标在初中/高中、前置在小学 → 过滤（垂径定理 hard 链里有四年级「轴对称」）
   *      这条比 a 更硬：主路径不允许出现小学低学段节点，除非目标本身就是小学。
   */

  var GRADE_GAP_LIMIT = 4;
  var PRIMARY_MAX = 6;

  function exclusionReason(prereq, target, strength) {
    if (!prereq || !target) return null;
    if (target.grade > PRIMARY_MAX && prereq.grade <= PRIMARY_MAX) {
      return '跨学段：前置在小学（' + gradeLabel(prereq.grade) + '），目标在' +
        stageOfGrade(target.grade) + '，不进主路径';
    }
    if (strength === 'soft' && (target.grade - prereq.grade) >= GRADE_GAP_LIMIT) {
      return '低年级 soft 前置（年级差 ' + (target.grade - prereq.grade) + ' 年 ≥ ' +
        GRADE_GAP_LIMIT + '），按噪音过滤';
    }
    return null;
  }

  /**
   * prerequisites(topicId, depth) —— 沿依赖边回溯。
   * @param {string} topicId
   * @param {number} [depth=2]
   * @returns {Object|null} {target, levels:[{depth, items:[...]}], soft:[...], excluded:[...]}
   *   levels 里只有 hard 边（已过滤噪音）；soft 边单独在 soft 里，不进主路径。
   */
  function prerequisites(topicId, depth) {
    var target = BY_ID[topicId];
    if (!target) return null;
    var maxDepth = (depth == null || !isFinite(depth)) ? 2 : Math.max(1, Math.floor(depth));

    var seen = {};
    seen[topicId] = 1;
    var frontier = [topicId];
    var levels = [];
    var soft = [];
    var excluded = [];

    for (var d = 1; d <= maxDepth && frontier.length; d++) {
      var items = [];
      var next = [];
      frontier.forEach(function (fromId) {
        (PARENTS[fromId] || []).forEach(function (e) {
          var p = BY_ID[e.prerequisiteId];
          if (!p) return;
          var rec = {
            fromId: fromId, fromName: (BY_ID[fromId] || {}).name,
            id: p.id, name: p.name, grade: p.grade, domain: p.domain, chapter: p.chapter,
            strength: e.strength, reason: e.reason, depth: d
          };
          var why = exclusionReason(p, target, e.strength);
          if (e.strength === 'soft') {
            if (why) { rec.excludedWhy = why; excluded.push(rec); }
            else if (!seen[p.id]) soft.push(rec);
            return;
          }
          if (seen[p.id]) return;   /* 已在更近的一层列出 */
          seen[p.id] = 1;
          next.push(p.id);
          if (why) { rec.excludedWhy = why; excluded.push(rec); return; }
          items.push(rec);
        });
      });
      levels.push({ depth: d, items: items });
      frontier = next;
    }

    return { target: pickTopic(target), levels: levels, soft: soft, excluded: excluded };
  }

  function pickTopic(t) {
    return {
      id: t.id, name: t.name, grade: t.grade, domain: t.domain,
      semester: t.semester, chapter: t.chapter, description: t.description,
      masteryCriteria: t.mastery_criteria || []
    };
  }

  /**
   * buildPath(prereqResult) —— 学习路径：只走 hard 边，按年级从低到高，同年级先修在前，目标在最后。
   * 每个节点都带 pending:true（页面显示「候选，待测确认」）。
   */
  function buildPath(prereqResult) {
    if (!prereqResult) return { nodes: [], note: '没有前置数据' };
    var flat = [];
    var seen = {};
    prereqResult.levels.forEach(function (lv) {
      lv.items.forEach(function (it) {
        if (seen[it.id]) return;
        seen[it.id] = 1;
        flat.push({
          id: it.id, name: it.name, grade: it.grade, domain: it.domain, chapter: it.chapter,
          depth: it.depth, strength: 'hard', pending: true, label: '候选，待测确认'
        });
      });
    });
    flat.sort(function (a, b) {
      if (a.grade !== b.grade) return a.grade - b.grade;
      if (a.depth !== b.depth) return b.depth - a.depth;  /* 同年年级里更基础的在前 */
      return a.name.localeCompare(b.name, 'zh');
    });
    var t = prereqResult.target;
    var nodes = flat.concat([{
      id: t.id, name: t.name, grade: t.grade, domain: t.domain, chapter: t.chapter,
      depth: 0, strength: 'target', pending: true, label: '候选，待测确认', isTarget: true
    }]);
    return {
      nodes: nodes,
      note: '依赖图不是诊断结果：图只说明「谁是谁的前置」，不说明学生哪里断了。' +
        '下面每个节点都是候选薄弱点，需要学生做题确认，未确认前不要当成已诊断。'
    };
  }

  /* ================================================================
   * 4b. 接线 engine（kanban t_40c26d7d）—— 候选 → 确认 → 出题测 → 真路径
   * ================================================================
   * route 的产出只是**候选**，不是诊断。要变成真路径必须让 engine 出题测。
   * 本文件的职责到此为止：**只生成跳转地址**，不启动 session、不读 engine、不碰 DOM。
   *   - 候选确认不能省、不能默认选第一个：只有 ④ 校验通过（stage==='verified'）
   *     且学生确实点了某个候选，才有入口。多个候选就每个给一个。
   *   - 跳转复用 diagnose 现成的 ?target= 参数（app.js resolveTargets 已能开 session），
   *     不新造参数；额外只带一个 from=route 标记，让 diagnose 能回升到本页。
   */

  var DIAGNOSE_PAGE = 'index.html';   /* 与 route.html 同目录 */

  /** 这段定位结果够不够格让学生「确认」？只有校验通过才够。 */
  function canStartDiagnosis(result) {
    return !!(result && result.stage === 'verified' && result.verify && result.verify.ok &&
      Array.isArray(result.verify.kept) && result.verify.kept.length > 0);
  }

  /**
   * 可确认的候选列表 —— 这是「开始诊断」入口的唯一数据来源，不满足就返回空数组。
   * @returns {Array} [{id, name, grade, confidence, url}]
   */
  function diagnosisCandidates(result) {
    if (!canStartDiagnosis(result)) return [];
    return result.verify.kept.map(function (k) {
      return {
        id: k.id, name: k.name, grade: k.grade, confidence: k.confidence,
        url: diagnosisUrl(k.id)
      };
    });
  }

  /** diagnose/index.html?target=<topicId>&from=route */
  function diagnosisUrl(topicId) {
    var id = String(topicId == null ? '' : topicId).trim();
    if (!id) throw new Error('diagnosisUrl 需要 topicId');
    return DIAGNOSE_PAGE + '?target=' + encodeURIComponent(id) + '&from=route';
  }

  /** 第 ⑥ 段（依赖图上的前置节点）的标题与说明——不再是「学习路径」 */
  var STRUCTURE_TITLE = '接下来需要确认的知识点';
  var STRUCTURE_NOTE = '这些是依赖图上的前置节点，不是诊断结论。点上面的按钮开始诊断，' +
    '做完几道题才能确定你实际卡在哪。';
  var STRUCTURE_FOOTNOTE = '从低年级往上走：除最后一个是目标知识点，前面的都是它在图上的 hard 前置。' +
    '过滤掉的节点在下一段「已过滤（噪音）」里';
  var FILTERED_TITLE = '已过滤（噪音）';

  function structureNote() { return { title: STRUCTURE_TITLE, text: STRUCTURE_NOTE }; }

  /* ================================================================
   * 4c. 诊断结果写回 route（kanban t_d623773c）—— 候选 → 真结论
   * ================================================================
   * 定位→做题→判出根因→回到 route，页面必须变。本段只做**纯函数**：
   *   入参是 diagnose 存在 localStorage 的 session（app.js:239 的结构）和 E.summarize() 的结果，
   *   不读 localStorage、不调 engine、不碰 DOM —— 读与算都在 route-page.js。
   *
   * 四条不可妥协的判据：
   *   a) 不是本页跳过去的（session.targets 不含当前定位 id）→ 当作没有结果，不显示。
   *   b) 一题没答（answers 为空）→ 没有结果可讲。
   *   c) 没做完（finished===false 或 limitReached===true）→ **绝不显示半截结论**。
   *      limitReached 即使 finished 也为真时也按没做完算：可能还有前置没测到。
   *   d) 有真结论（根因）时，第 ⑥ 段的候选列表必须被**换掉**，不能两条并列 ——
   *      候选是图上的前置节点，根因是实测的断点，两个都显示学生不知道信哪个。
   */

  var RESULT_TITLE = '刚才的诊断结果';
  var WEAK_TITLE = '你的薄弱点';
  var ROOT_LIMIT = 2;   /* 与 engine.js studentAdvice「根因取前 2 个」一致 */

  var RESULT_NOTE = '同一道题重新定位不会改变这里；换了题（定位到别的知识点）就不再显示上一次的诊断。';

  /** localStorage 里 session 的键（与 app.js:9 一致，本文件只当常量用，不读写存储） */
  var LS_SESSION_KEY = 'cnmDiagnose.session.v2';

  /** 「没有结果」的唯一表示：所有渲染点都判 null，不判 stage。 */
  function noResult(why) {
    return { ok: false, why: why, stage: null, topicId: null, roots: [], shaky: [], asked: 0, limit: null, detail: '' };
  }

  function numOr(x, dflt) {
    var n = Number(x);
    return isFinite(n) ? n : dflt;
  }

  function nameOfTopic(id) {
    var t = BY_ID[id];
    return t ? t.name : String(id == null ? '' : id);
  }

  /**
   * 这份 session 是不是本页跳过去的诊断？三条前置条件缺一不可。
   * @param {Object|null} session localStorage 里 cnmDiagnose.session.v2 的内容
   * @param {string} currentTopicId 第 ④ 段校验通过、正被展示的那个知识点
   */
  function matchSession(session, currentTopicId) {
    var id = String(currentTopicId == null ? '' : currentTopicId).trim();
    if (!session || typeof session !== 'object') return { ok: false, why: 'no-session' };
    if (!id) return { ok: false, why: 'no-topic' };
    if (!Array.isArray(session.targets) || session.targets.indexOf(id) < 0) {
      /* 换了一道题重新定位：旧 session 与本页无关，当作没有（不删 localStorage） */
      return { ok: false, why: 'target-mismatch' };
    }
    if (!Array.isArray(session.answers) || session.answers.length === 0) {
      return { ok: false, why: 'no-answers' };
    }
    return { ok: true, why: null };
  }

  /**
   * 是不是「做完了」？两个字段都可能缺（页面层算出 sum 之后才调，但测试会手造）。
   * limitReached 为真时一律算没做完（坑 6）。
   */
  function isUnfinished(sum) {
    if (!sum) return true;
    if (sum.limitReached === true) return true;
    return sum.finished !== true;
  }

  /**
   * 根因的前 N 个，带上名字/年级/可靠性标注。
   * pendingPrereqs 非空的根因不可靠（还有前置没测到）→ unreliable:true，页面要标注。
   */
  function rootItems(sum) {
    var roots = sum && Array.isArray(sum.roots) ? sum.roots : [];
    var out = [];
    var seen = Object.create(null);
    for (var i = 0; i < roots.length && out.length < ROOT_LIMIT; i++) {
      var r = roots[i];
      var rid = typeof r === 'string' ? r : (r && r.id);
      if (!rid || seen[rid]) continue;
      seen[rid] = 1;
      var pending = (r && Array.isArray(r.pendingPrereqs)) ? r.pendingPrereqs.slice() : [];
      out.push({
        id: rid,
        name: nameOfTopic(rid),
        grade: BY_ID[rid] ? BY_ID[rid].grade : null,
        pendingPrereqs: pending,
        unreliable: pending.length > 0
      });
    }
    return out;
  }

  /** shaky 的名字（最多 3 个，页面只用来提示「再练几道」） */
  function shakyNames(sum) {
    var list = sum && Array.isArray(sum.shaky) ? sum.shaky : [];
    var out = [];
    for (var i = 0; i < list.length && out.length < 3; i++) {
      var sid = typeof list[i] === 'string' ? list[i] : (list[i] && list[i].id);
      if (!sid) continue;
      if (out.indexOf(nameOfTopic(sid)) < 0) out.push(nameOfTopic(sid));
    }
    return out;
  }

  /**
   * 建议顺序：根因（按年级从低到高）→ 定位到的知识点本身。去重。
   * 只有一个根因且它就是要定位的点时，顺序就只有它自己（不硬凑第二个）。
   */
  function suggestedOrder(roots, targetId) {
    var list = (roots || []).slice();
    var ids = [];
    list.forEach(function (r) { if (ids.indexOf(r.id) < 0) ids.push(r.id); });
    if (targetId && ids.indexOf(targetId) < 0) ids.push(targetId);
    return ids.map(function (id) {
      var r = null;
      list.forEach(function (x) { if (x.id === id) r = x; });
      return { id: id, name: nameOfTopic(id), grade: BY_ID[id] ? BY_ID[id].grade : null, isTarget: id === targetId };
    });
  }

  /** 「没做完」里「还有 M 个知识点没测到」—— untested 优先，缺了就用 limit-asked 兜底 */
  function untestedCount(sum, session) {
    if (sum && Array.isArray(sum.untested)) return sum.untested.length;
    var limit = numOr(sum && sum.limit, numOr(session && session.limit, 0));
    var asked = numOr(sum && sum.asked, Array.isArray(session && session.answers) ? session.answers.length : 0);
    return Math.max(0, limit - asked);
  }

  /** 短年级标签（「初二」这种），rootItems 里展示用；gradeLabel 太长不适合放进一句话里 */
  function shortGradeLabel(g) {
    if (g == null) return '';
    if (g <= 6) return ['一', '二', '三', '四', '五', '六'][g - 1] + '年级';
    if (g <= 9) return '初' + ['一', '二', '三'][g - 7];
    if (g === 12) return '高三';
    if (g === 13) return '选必一';
    if (g === 14) return '选必二';
    return '高' + ['一', '二'][Math.min(g - 10, 2)];
  }

  /**
   * buildResultView(session, sum, currentTopicId) —— 第 ⑥ 段「刚才的诊断结果」的唯一数据来源。
   *
   * @param {Object|null} session localStorage 里的诊断 session（可为 null）
   * @param {Object|null} sum E.summarize(graph, session) 的结果（可为 null → 只能报「没做完」）
   * @param {string} currentTopicId 当前定位出的知识点 id
   * @returns {Object} 见文件头；ok:false 时页面什么都不显示。
   *   stage: 'roots'     —— 做完且有根因：显示「你卡在」+ 建议顺序，并**盖住候选列表**
   *          'no-root'   —— 做完但没根因（shaky 非空才值得讲，否则 ok:false）
   *          'unfinished'—— 没做完：只说没做完，一个字都不提根因
   */
  function buildResultView(session, sum, currentTopicId) {
    var m = matchSession(session, currentTopicId);
    if (!m.ok) return noResult(m.why);

    if (isUnfinished(sum)) {
      var asked = numOr(sum && sum.asked, Array.isArray(session.answers) ? session.answers.length : 0);
      var missing = untestedCount(sum, session);
      return {
        ok: true, stage: 'unfinished', topicId: String(currentTopicId), roots: [], shaky: [],
        asked: asked, limit: numOr(sum && sum.limit, numOr(session.limit, null)), missing: missing,
        /* 题量用完时 engine 会同时给 finished:true 和 limitReached:true（可能还有前置没测），
         * 这时说清「题量用完了」，别让学生以为是自己没继续答 */
        limitReached: !!(sum && sum.limitReached === true),
        detail: (sum && sum.limitReached === true
            ? '诊断做到题量上限了（已答 ' + asked + ' 题' +
              (missing > 0 ? '，还有 ' + missing + ' 个知识点没测到' : '') + '）'
            : '诊断还没做完（已答 ' + asked + ' 题' +
              (missing > 0 ? '，还有 ' + missing + ' 个知识点没测到' : '') + '）') + '\n' +
          '结论要等测完才能确定 —— 现在还不说「你卡在哪」',
        title: RESULT_TITLE
      };
    }

    var roots = rootItems(sum);
    var shaky = shakyNames(sum);
    if (roots.length) {
      var order = suggestedOrder(roots, currentTopicId);
      var detail = '你卡在：' + roots.map(function (r) {
        var g = shortGradeLabel(BY_ID[r.id] ? BY_ID[r.id].grade : r.grade);
        return r.name + (g ? '（' + g + '）' : '');
      }).join('、') + '\n' +
        '依据：该知识点答错；它的所有前置都已经答对（或没测出问题）\n' +
        '建议顺序：' + order.map(function (o) { return o.name; }).join(' → ');
      return {
        ok: true, stage: 'roots', topicId: String(currentTopicId), roots: roots, shaky: shaky,
        order: order, asked: numOr(sum.asked, session.answers.length), limit: numOr(sum.limit, session.limit),
        title: RESULT_TITLE,
        /* 任务二：真结论要盖住候选。标题与内容都换掉，并保留一行小字说明范围 */
        sectionTitle: WEAK_TITLE,
        sectionNote: '这是基于刚才诊断的结果：只测了本次范围里的知识点，没测到的仍然未知。',
        detail: detail
      };
    }

    if (!shaky.length) {
      /* 做完了、没根因、也没不稳：没有可讲的不良结论（已掌握的不需要在这里说教） */
      return noResult('no-finding');
    }
    return {
      ok: true, stage: 'no-root', topicId: String(currentTopicId), roots: [], shaky: shaky,
      asked: numOr(sum.asked, session.answers.length), limit: numOr(sum.limit, session.limit),
      title: RESULT_TITLE,
      detail: '没有明确的断点，但「' + shaky.join('」「') + '」答得不稳，建议再练几道'
    };
  }

  /** 页面渲染用：结果里根因的「可能不准」标注文案（空字符串 = 不需要标注） */
  function rootCaveat(root) {
    if (!root || !root.unreliable) return '';
    return '可能不准：还有前置没测';
  }

  /* ================================================================
   * 5. LLM 选择（唯一需要网关的一步）
   * ================================================================
   * 网关：http://127.0.0.1:3000/v1/chat/completions（max_tokens ≥ 1200，网关把 reasoning 算进预算）。
   * fetch 由调用方注入，本模块自己不碰网络，保证 Node 测试不需要网关。
   */

  var PROXY = 'http://127.0.0.1:3000/v1/chat/completions';
  var MODEL = 'DeepSeek-V4-Flash-0731-Unlimited';
  var MAX_TOKENS = 1600;      /* ≥1200：网关把 reasoning 算进预算 */
  var TIMEOUT_MS = 60000;
  var POOL_IN_PROMPT = 120;   /* 候选池太大时只喂前 N 个（域内已按年级/章节排序） */

  function buildPrompt(fields, pool) {
    var f = fields || {};
    var lines = pool.slice(0, POOL_IN_PROMPT).map(function (t) {
      return '- id=' + t.id + ' | ' + t.name + ' | ' + gradeLabel(t.grade) + ' | ' +
        t.domain + ' | ' + (t.chapter || '') + ' | ' + (t.description || '');
    });
    var fieldDesc = [
      '年级：' + (f.grade && f.grade.parsed ? gradeLabel(f.grade.value) : '未解析出'),
      '学段：' + (f.stage && f.stage.parsed ? f.stage.value : '未解析出'),
      '领域：' + (f.domain && f.domain.parsed ? f.domain.value : '未解析出'),
      '章节：' + (f.chapter && f.chapter.parsed ? f.chapter.value : '未解析出'),
      '考点描述：' + (f.topicHint && f.topicHint.parsed ? f.topicHint.value : '未解析出')
    ].join('\n');

    var sys = [
      '你是中小学数学教研员。你的任务：在一份**给定的候选知识点列表**里，选出最贴合这段作业分析文字的 1-3 个知识点。',
      '',
      '硬规则：',
      '1. 只能从给出的候选列表里选。列表里没有的知识点，绝对不许编造，也不许用「同类」或「相近」的替代。',
      '2. 返回的 id 和 name 必须与列表里那一行的 id/name 逐字一致。',
      '3. 如果候选列表里没有任何一个能对上这段文字，返回 {"picks": []}，不要硬凑。宁可说定位不出，也不要给一个错的知识点——学生会照着复习一小时。',
      '4. 最多 3 个，按置信度从高到低。置信度 0-1 的小数。',
      '5. reason 一句话，说明「为什么是这个知识点」，必须引用文字里或知识点描述里的具体词，不要空话。',
      '',
      '只输出 JSON，不要解释：',
      '{"picks":[{"id":"cnm_xxx","name":"知识点名","confidence":0.0,"reason":"一句话理由"}]}'
    ].join('\n');

    var user = [
      '## 作业分析文字',
      (f.text || '').trim(),
      '',
      '## 已解析出的字段',
      fieldDesc,
      '',
      '## 候选知识点（共 ' + pool.length + ' 个' +
        (pool.length > POOL_IN_PROMPT ? '，下面列出前 ' + POOL_IN_PROMPT + ' 个' : '') + '）',
      lines.join('\n')
    ].join('\n');

    return [{ role: 'system', content: sys }, { role: 'user', content: user }];
  }

  /** 从 LLM 回复里抠 JSON（容忍 ```json 围栏、前后废话） */
  function extractJSON(content) {
    var s = String(content || '');
    var fence = /```(?:json)?\s*([\s\S]*?)```/.exec(s);
    if (fence) s = fence[1];
    var i = s.indexOf('{'), j = s.lastIndexOf('}');
    if (i < 0 || j <= i) return null;
    try { return JSON.parse(s.slice(i, j + 1)); } catch (e) { return null; }
  }

  function askLLM(fields, pool, opts) {
    var o = opts || {};
    var fetchFn = o.fetch;
    if (typeof fetchFn !== 'function') {
      return Promise.resolve({ ok: false, kind: 'offline', why: '当前环境没有 fetch，无法调用网关' });
    }
    var body = {
      model: o.model || MODEL,
      messages: buildPrompt(fields, pool),
      temperature: 0,
      max_tokens: Math.max(1200, o.maxTokens || MAX_TOKENS),
      response_format: { type: 'json_object' }
    };
    var ctrl = null, timer = null;
    if (typeof AbortController !== 'undefined') {
      ctrl = new AbortController();
      timer = setTimeout(function () { ctrl.abort(); }, o.timeoutMs || TIMEOUT_MS);
    }
    return fetchFn(o.proxy || PROXY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      if (timer) clearTimeout(timer);
      if (!res || !res.ok) {
        return { ok: false, kind: 'offline', why: '网关返回 HTTP ' + (res && res.status) };
      }
      return res.json().then(function (json) {
        var msg = json && json.choices && json.choices[0] && json.choices[0].message;
        var content = msg && msg.content;
        var parsed = extractJSON(content);
        if (!parsed) return { ok: false, kind: 'bad-json', why: '网关返回的不是可解析的 JSON', raw: content };
        return { ok: true, picks: Array.isArray(parsed.picks) ? parsed.picks : [], raw: parsed };
      });
    }).catch(function (err) {
      if (timer) clearTimeout(timer);
      return { ok: false, kind: 'offline', why: '连不上网关：' + ((err && err.message) || err) };
    });
  }

  /* ================================================================
   * 6. locate —— 把 ①~⑥ 串起来（页面直接用这个）
   * ================================================================ */

  /**
   * locate(text, opts) → Promise<result>
   * result.stage: 'insufficient' | 'not-math' | 'await-llm' | 'verified' | 'rejected' | 'offline'
   * ①② 永远有值（纯确定性）；③④ 需要网关；⑤⑥ 只在 ④ 通过后才有。
   */
  function locate(text, opts) {
    var o = opts || {};
    var fields = parseFields(text);
    var poolInfo = candidates(fields);
    var result = {
      text: String(text == null ? '' : text),
      fields: fields,
      pool: poolInfo,
      picks: null,
      verify: null,
      prereq: null,
      path: null,
      stage: null,
      message: null
    };

    if (fields.subject.parsed && !fields.subject.math) {
      result.stage = 'not-math';
      result.message = '这段文字看起来不是数学题（识别到「' + fields.subject.value + '」）。' +
        '本页只做数学知识点定位，不做强行匹配。';
      return Promise.resolve(result);
    }
    if (!poolInfo.ok) {
      result.stage = 'insufficient';
      result.message = poolInfo.reason;
      return Promise.resolve(result);
    }

    result.stage = 'await-llm';
    return askLLM(fields, poolInfo.topics, o).then(function (llm) {
      if (!llm.ok) {
        result.stage = 'offline';
        result.message = '网关不可用，第 ③ 步（LLM 选择）没能完成。' +
          '上面 ①② 是纯确定性结果，不受影响。原因：' + llm.why;
        return result;
      }
      result.picks = llm.picks;
      var v = verifyPick(llm.picks, { pool: poolInfo.topics, fields: fields });
      result.verify = v;
      if (!v.ok) {
        result.stage = 'rejected';
        result.message = '分析结果无法定位到知识点';
        return result;
      }
      result.stage = 'verified';
      var pre = prerequisites(v.kept[0].id, o.depth == null ? 2 : o.depth);
      result.prereq = pre;
      result.path = buildPath(pre);
      return result;
    });
  }

  /* ================================================================
   * 7. 导出
   * ================================================================ */

  return {
    /* 数据 */
    setData: setData,
    /* 纯函数 */
    parseFields: parseFields,
    candidates: candidates,
    verifyPick: verifyPick,
    hintCoverage: hintCoverage,
    prerequisites: prerequisites,
    buildPath: buildPath,
    /* 接线 engine（只生成跳转地址，不动 engine） */
    canStartDiagnosis: canStartDiagnosis,
    diagnosisCandidates: diagnosisCandidates,
    diagnosisUrl: diagnosisUrl,
    structureNote: structureNote,
    /* 诊断结果写回（kanban t_d623773c）：纯函数，session/sum 由调用方注入 */
    buildResultView: buildResultView,
    matchSession: matchSession,
    rootCaveat: rootCaveat,
    suggestedOrder: suggestedOrder,
    /* 工具 */
    gradeLabel: gradeLabel,
    stageOfGrade: stageOfGrade,
    gradesFor: gradesFor,
    chapterTitle: chapterTitle,
    extractJSON: extractJSON,
    /* 需要网关 */
    buildPrompt: buildPrompt,
    askLLM: askLLM,
    locate: locate,
    /* 常量（页面/测试共用） */
    PROXY: PROXY, MODEL: MODEL, MAX_TOKENS: MAX_TOKENS,
    MIN_COVERAGE: MIN_COVERAGE, MIN_POOL: MIN_POOL,
    PRIMARY_MAX: PRIMARY_MAX, GRADE_GAP_LIMIT: GRADE_GAP_LIMIT,
    LS_SESSION_KEY: LS_SESSION_KEY, RESULT_TITLE: RESULT_TITLE,
    WEAK_TITLE: WEAK_TITLE, RESULT_NOTE: RESULT_NOTE, ROOT_LIMIT: ROOT_LIMIT,
    DOMAIN_WORDS: DOMAIN_WORDS
  };
});
