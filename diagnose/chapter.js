/* 章节解析纯函数层（首屏专用）：浏览器 window.CnmChapter，Node 下 require('./chapter.js')。
 *
 * WHY：diagnose 首屏（骨架 → 学科外壳 → 可搜索知识点列表 → 年级卡片）只用到
 * parseChapter / subjectOf / buildGraph / gradeTargets 这几个纯函数，而 engine.js
 * 全量 71KB / gz 23KB 且被懒加载（进入诊断流程才拉）。把首屏真正要用的纯函数
 * 连同年级确认题数、题量默认值常量拆成独立小文件，首屏就不必等 engine.gz。
 *
 * UMD 沿用 engine.js 风格：浏览器挂 window.CnmChapter；Node 直测纯函数用 module.exports。
 * 下面每个函数都被 engine.js 以同名 alias 引用（那里不再有第二份实现），
 * 保证「首屏层 / 引擎层」语义完全一致（行为零变更）。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.CnmChapter = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* 年级确认题数常量：引擎内部判「掌握」需连续答对 confirm 题，界面只给 2 / 3 / 5 可选。 */
  const DEFAULT_CONFIRM = 3;
  const CONFIRM_CHOICES = [2, 3, 5];

  /* 题量常量：普通诊断默认 16 题，整体筛查默认 40 题。首屏的「题量上限」卡片与
   * getSettings 读默认值，故与 parseChapter 一起放在首屏层。 */
  const DEFAULT_LIMIT = 16;
  const SCREEN_LIMIT = 40;

  /** 界面可选值：只接受 2 / 3 / 5，其它回退默认。 */
  function clampConfirm(n) {
    const v = Math.floor(Number(n));
    return CONFIRM_CHOICES.indexOf(v) >= 0 ? v : DEFAULT_CONFIRM;
  }

  /** 题号：id 形如 xxx_q3 → 3，用于同一知识点内按题号排序。 */
  function qNum(q) { const m = /_q(\d+)$/.exec(q.id); return m ? parseInt(m[1], 10) : 0; }

  /**
   * 建图：byId / index / 先修（prereqs、dependents）/ 题池（bank）。
   * WHY 在首屏层：选题列表与年级卡片要按图取范围（gradeTargets）与条数，
   * 这一步是纯内存计算（几毫秒），不该为了它先下 23KB 的 engine.js。
   * 行为与拆分前 engine.js 的 buildGraph 逐字一致（engine.js 侧 alias 本函数）。
   */
  function buildGraph(topics, deps, questions) {
    const byId = Object.create(null);
    const index = Object.create(null);
    topics.forEach(function (t, i) { byId[t.id] = t; index[t.id] = i; });
    const prereqs = Object.create(null);
    const dependents = Object.create(null);
    topics.forEach(function (t) { prereqs[t.id] = []; dependents[t.id] = []; });
    const seen = Object.create(null);
    deps.forEach(function (d) {
      if (!byId[d.topicId] || !byId[d.prerequisiteId]) return;
      const k = d.topicId + '<' + d.prerequisiteId;
      if (seen[k]) return;
      seen[k] = true;
      const strength = d.strength === 'soft' ? 'soft' : 'hard';
      prereqs[d.topicId].push({ id: d.prerequisiteId, strength: strength, reason: d.reason });
      dependents[d.prerequisiteId].push({ id: d.topicId, strength: strength });
    });
    // 先修按 hard 优先、再 soft，同级按 topics 文件顺序，保证出题次序确定
    const rank = function (e) { return (e.strength === 'hard' ? 0 : 1) * 1e6 + index[e.id]; };
    Object.keys(prereqs).forEach(function (id) {
      prereqs[id].sort(function (a, b) { return rank(a) - rank(b); });
      dependents[id].sort(function (a, b) { return index[a.id] - index[b.id]; });
    });
    // 题库：每个知识点的题目，按题号排序；没有题库（或某知识点没有题）时回退到 diagnostic_question
    const bank = Object.create(null);
    topics.forEach(function (t) { bank[t.id] = []; });
    let fromFile = 0;
    (Array.isArray(questions) ? questions : []).forEach(function (q) {
      if (q && bank[q.topicId] && !byId[q.topicId].external) { bank[q.topicId].push(q); fromFile++; }
    });
    topics.forEach(function (t) {
      const dq = t.diagnostic_question;
      if (!t.external && !bank[t.id].length && dq && dq.question) {
        bank[t.id].push({ id: t.id + '_q1', topicId: t.id, difficulty: 'standard', type: 'legacy', prompt: dq.question, answer: dq.answer, explanation: '' });
      }
    });
    Object.keys(bank).forEach(function (id) { bank[id].sort(function (a, b) { return qNum(a) - qNum(b); }); });
    return {
      topics: topics, byId: byId, index: index, prereqs: prereqs, dependents: dependents, bank: bank,
      hasBank: fromFile > 0, _anc: Object.create(null)
    };
  }

  /**
   * 章节字符串 → {volume, chapterNo, chapterName, section}。
   * 各学段格式不同（WHY：topics 数据里 chapter 是「册名 章名」自由文本，
   * 列表分组 / 展开依赖这里统一切成结构化字段）：
   *   初中：七上 第一章 有理数 1.1 -> {volume:'七上', chapterNo:'第一章', chapterName:'有理数', section:'1.1'}
   *   小学：一年级上册 第1单元 单元名 / 一年级上册 综合与实践 活动名
   */
  function parseChapter(chapter) {
    const s = chapter || '';
    const pm = /^([一二三四五六七八九])年级([上下全])册 (第\d+单元|预备单元\d) (.+)$/.exec(s);
    if (pm) return { volume: pm[1] + pm[2], chapterNo: pm[3], chapterName: pm[4], section: '' };
    const pi = /^([一二三四五六])年级([上下])册 (综合与实践) (.+)$/.exec(s);
    if (pi) return { volume: pi[1] + pi[2], chapterNo: pi[3], chapterName: pi[4], section: '' };
    // 小学英语复习 / Recycle（如「四年级上册 复习 Let's help!」）
    const prev = /^([一二三四五六])年级([上下])册 (复习) (.+)$/.exec(s);
    if (prev) return { volume: prev[1] + prev[2], chapterNo: prev[3], chapterName: prev[4], section: '' };
    // 高中英语按册名解析，避免「第1单元 Teenage Life」被空格拆成章名和节。
    const enHs = /^(必修第([一二三])册|选择性必修第([一二三四])册) (欢迎单元|第\d+单元) (.+)$/.exec(s);
    if (enHs) {
      return {
        volume: enHs[2] ? ('必修' + enHs[2]) : ('选必' + enHs[3]),
        chapterNo: enHs[4],
        chapterName: enHs[5],
        section: ''
      };
    }
    // 高中数学不拆上下册。高一/高二是必修两册，选必一/二/三是选择性必修三册。
    const hs = /^(高[一二]|选必[一二三]) (数学建模|数学探究) (\S+)$/.exec(s);
    if (hs) return { volume: hs[1], chapterNo: hs[2], chapterName: hs[3], section: '' };
    const m = /^(\S+) (第\S+章) (\S+?)(?: (\S+))?$/.exec(s);
    if (!m) return { volume: '', chapterNo: '', chapterName: s, section: '' };
    return { volume: m[1], chapterNo: m[2], chapterName: m[3], section: m[4] || '' };
  }

  /** 学科：显式 subject 优先，否则 cne_ 是英语、cnp_ 是物理、cnc_ 是语文、cns_ 是科学、cnd_ 是道德与法治、cnh_ 是历史、cng_ 是地理，其余算数学。 */
  function subjectOf(topic) {
    if (!topic) return 'math';
    if (topic.subject === 'english' || topic.subject === 'math' || topic.subject === 'physics' || topic.subject === 'chinese' || topic.subject === 'science' || topic.subject === 'morality' || topic.subject === 'history' || topic.subject === 'geography') return topic.subject;
    if (String(topic.id || '').indexOf('cne_') === 0) return 'english';
    if (String(topic.id || '').indexOf('cnp_') === 0) return 'physics';
    if (String(topic.id || '').indexOf('cnc_') === 0) return 'chinese';
    if (String(topic.id || '').indexOf('cns_') === 0) return 'science';
    if (String(topic.id || '').indexOf('cnd_') === 0) return 'morality';
    if (String(topic.id || '').indexOf('cnh_') === 0) return 'history';
    if (String(topic.id || '').indexOf('cng_') === 0) return 'geography';
    return 'math';
  }

  /**
   * 整年级 / 整册的知识点：'一年级' = 一上 + 一下，'七上' = 七年级上册。
   * 高中不拆上下册：'高一' / '高一必修' = 必修第一册，'高二' / '高二必修' = 必修第二册。
   * '选必一' / '选择性必修第一册'、选必二、选必三 = 选择性必修三册。
   * 高中英语用「必修一」「必修二」「必修三」「选必四」，不占用数学的「高一」「高二」。
   * subject 默认 math，避免三上、四上和选必一把英语和数学混在一起。
   * 不带 subject 时「必修一」没有数学知识点，返回 null。
   * 返回 {ids, volumes, label}（ids 按 topics 文件顺序，只含正式知识点）；不认识的写法返回 null。
   * WHY 在首屏层：年级卡片首屏就要显示「某年级：N 个知识点」，并按年级取整体诊断的 ids。
   */
  function gradeTargets(graph, scope, subject) {
    const subj = subject == null || subject === '' ? 'math' : subject;
    const key = String(scope == null ? '' : scope).trim();
    const books = {
      '高一': ['高一', '高一（必修第一册）'],
      '高一必修': ['高一', '高一（必修第一册）'],
      '高二': ['高二', '高二（必修第二册）'],
      '高二必修': ['高二', '高二（必修第二册）'],
      '选必一': ['选必一', '选必一（选择性必修第一册）'],
      '选择性必修第一册': ['选必一', '选必一（选择性必修第一册）'],
      '选必二': ['选必二', '选必二（选择性必修第二册）'],
      '选择性必修第二册': ['选必二', '选必二（选择性必修第二册）'],
      '选必三': ['选必三', '选必三（选择性必修第三册）'],
      '选择性必修第三册': ['选必三', '选必三（选择性必修第三册）'],
      '必修一': ['必修一', '必修一（必修第一册）'],
      '必修第一册': ['必修一', '必修一（必修第一册）'],
      '必修二': ['必修二', '必修二（必修第二册）'],
      '必修第二册': ['必修二', '必修二（必修第二册）'],
      '必修三': ['必修三', '必修三（必修第三册）'],
      '必修第三册': ['必修三', '必修三（必修第三册）'],
      '选必四': ['选必四', '选必四（选择性必修第四册）'],
      '选择性必修第四册': ['选必四', '选必四（选择性必修第四册）']
    };
    let volumes = null;
    let label = '';
    if (books[key]) {
      volumes = [books[key][0]];
      label = books[key][1];
    } else {
      const g = /^([一二三四五六七八九])年级$/.exec(key);
      const v = /^([一二三四五六七八九])([上下])$/.exec(key);
      const whole = /^([一二三四五六七八九])全$/.exec(key);
      if (g) {
        volumes = [g[1] + '上', g[1] + '下'];
        if (g[1] === '九') volumes.push('九全');
        label = g[1] + '年级';
      } else if (whole) {
        volumes = [whole[1] + '全'];
        label = whole[1] + '年级全一册';
      } else if (v) { volumes = [key]; label = v[1] + '年级' + (v[2] === '上' ? '上册' : '下册'); }
    }
    if (!volumes) return null;
    const ids = graph.topics.filter(function (t) {
      if (t.external) return false;
      if (subj !== 'all' && subjectOf(t) !== subj) return false;
      return volumes.indexOf(parseChapter(t.chapter).volume) >= 0;
    }).map(function (t) { return t.id; });
    return ids.length ? { ids: ids, volumes: volumes, label: label } : null;
  }

  return {
    DEFAULT_CONFIRM: DEFAULT_CONFIRM,
    CONFIRM_CHOICES: CONFIRM_CHOICES.slice(),
    DEFAULT_LIMIT: DEFAULT_LIMIT,
    SCREEN_LIMIT: SCREEN_LIMIT,
    clampConfirm: clampConfirm,
    qNum: qNum,
    buildGraph: buildGraph,
    gradeTargets: gradeTargets,
    parseChapter: parseChapter,
    subjectOf: subjectOf
  };
});
