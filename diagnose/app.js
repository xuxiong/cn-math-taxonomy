/* 诊断小工具界面。核心逻辑全部在 engine.js，这里只负责数据加载、渲染与本地存储。 */
(function () {
  'use strict';
  /* Node 直测纯函数时会没有 window（测试只 require 本文件取 routeReturnHref，不跑界面） */
  const Browser = typeof window !== 'undefined' ? window : {};

  /* 模块级共享状态收进一个对象 S：拆分 app-flow.js 时两边读写同一份，避免复制状态。
   * 每个字段后面的注释说明它属于首屏还是流程。 */
  var S = {
    D: null,
    session: null,
    sessionMeta: null,
    demo: null,
    prac: null,
    pracPath: null,
    pracResult: null,
    pracLoading: null,
    ui: { key: null, phase: 'ask', answer: '', verdict: null, explainStep: 0, aiSteps: null, aiState: 'idle', aiRequested: false, askHistory: [], askPending: false, askScroll: false, labCfg: null, labDesc: null, labAsk: null, labAskMsg: null },
    subject: 'math',
    startQuery: '',
    startStage: '',
    startErr: null,
    chapterOpen: false,
    gradeSel: '七',
    volSel: '',
    seedParam: null,
    pathCy: null,
    pathToken: 0,
    pathTipLock: false,
    pathExpanded: false,
    shareBlobUrl: null,
    shareToken: 0,
    graphQuestions: null,
    depsLoaded: false,
    fullTopicsLoaded: false,
    standardsLoaded: false,
    questionsIndex: null,
    questionsIndexPromise: null,
    bundlePromises: Object.create(null),
    bundleLoaded: Object.create(null),
    bankByTopic: Object.create(null),
    questionsInFlight: 0,
    fullBankPromise: null,
    commitPending: false,
    pendingStart: null,
    flowPending: false,
    fullTopicsFailed: false,
    standardsFailed: false,
    lazyFailed: Object.create(null)
  };
  if (Browser) Browser.DiagState = S;   // 供 app-flow.js / 测试访问（Node 下没有 window，用 Browser 兜底）
  const E = Browser.DiagEngine;
  /* ---- 首屏脚本按需加载（A+B）----
   * 下面这些模块不在 index.html 的 <script> 链上（首屏脚本 403KB → ≈85KB），
   * 用到时才由 Lazy.load 按依赖顺序注入。依赖顺序只写在这里，调用点不要自己拼列表。
   * 每个使用点都先 Lazy.load 再调用；Lazy 内部按 src 去重，重复调用零成本。 */
  const LAZY_EXPLAIN = ['explain.js'];                                       // LLM 讲解（依赖首屏的 llm-config.js）
  const LAZY_LAB = ['funclab.js', 'geomlab.js', 'labmatch.js', 'chatgraph.js'];  // 画板 + 追问图校验（labmatch/chatgraph 依赖 funclab）
  const LAZY_SHARE = ['../assets/vendor/qrcode.js', 'share.js'];             // 分享图（share 依赖 qrcode）
  const LAZY_PATH = [                                                        // 先修路径图（dagre 依赖 cytoscape）
    '../assets/vendor/cytoscape.min.js',
    '../assets/vendor/dagre.min.js',
    '../assets/vendor/cytoscape-dagre.js'
  ];
  const LAZY_VARIANTS = ['variants.js', 'llm-eval.js', 'llm-gateway.js', 'llm-variants.js'];  // 练习（llm-* 依赖链）
  /* 懒加载永远失败一次就够：同一次页面访问不反复重试，用户下次操作/刷新再试。
   * 失败只会让对应功能走已有的降级分支，绝不把错误抛给首屏。 */
  function lazyFail(name) {
    return function (err) {
      S.lazyFailed[name] = true;
      if (typeof console !== 'undefined' && console.warn) console.warn('[lazy] ' + name + ' 加载失败：', err);
    };
  }
  /* 变式模块是懒加载的：模块顶层不能抓引用（抓到的一定是 undefined），用到时现取。 */
  function variantsMod() { return Browser.DiagVariants; }
  function llmVariantsMod() { return Browser.DiagLLMVariants; }
  const LS_SESSION = 'cnmDiagnose.session.v2';
  const LS_SESSION_EN = 'cneDiagnose.session.v2';
  const LS_SESSION_PHY = 'cnpDiagnose.session.v2';
  const LS_SESSION_ZH = 'cncDiagnose.session.v2';
  const LS_SESSION_SCI = 'cnsDiagnose.session.v1';
  const LS_SESSION_MOR = 'cndDiagnose.session.v1';
  const LS_SESSION_HIS = 'cnhDiagnose.session.v1';
  const LS_SESSION_GEO = 'cngDiagnose.session.v1';
  const LS_SETTINGS = 'cnmDiagnose.settings.v2';
  const LS_SEEN = 'cnmDiagnose.seen.v1';
  const LS_PRAC = 'cnmDiagnose.practiced.v1';   // T3 练习记录 {topicId: 最近练习时间戳}
  const LS_VSEQ = 'cnmDiagnose.variantSeq.v1';  // O1 变式序号 {topicId: nextIndex}
  const LIMIT_MIN = 8, LIMIT_MAX = 30;
  const SCREEN_MIN = 20, SCREEN_MAX = 60;
  const GRADES = '一二三四五六七八九'.split('');
  const VOLUMES = [
    ['一上', '一年级上册'], ['一下', '一年级下册'], ['二上', '二年级上册'], ['二下', '二年级下册'],
    ['三上', '三年级上册'], ['三下', '三年级下册'], ['四上', '四年级上册'], ['四下', '四年级下册'],
    ['五上', '五年级上册'], ['五下', '五年级下册'], ['六上', '六年级上册'], ['六下', '六年级下册'],
    ['七上', '七年级上册'], ['七下', '七年级下册'], ['八上', '八年级上册'], ['八下', '八年级下册'],
    ['九上', '九年级上册'], ['九下', '九年级下册'], ['九全', '九年级全一册'],
    ['必修一', '必修一 · 必修第一册'], ['必修二', '必修二 · 必修第二册'], ['必修三', '必修三 · 必修第三册'],
    ['高一', '高一 · 必修第一册'], ['高二', '高二 · 必修第二册'],
    ['选必一', '选必一 · 选择性必修第一册'], ['选必二', '选必二 · 选择性必修第二册'],
    ['选必三', '选必三 · 选择性必修第三册'], ['选必四', '选必四 · 选择性必修第四册']
  ];
  const RESULT_LABEL = { correct: '对', wrong: '错', skip: '不会' };
  const STATUS_LABEL = { mastered: '已掌握', shaky: '不稳', weak: '薄弱', unknown: '未测' };
  const DIFF_LABEL = { basic: '基础', standard: '提高', challenge: '拓展', advanced: '拓展' };
  const TYPE_LABEL = { numeric: '数值题', choice: '选择题', short: '短答题', self: '开放题', legacy: '诊断题' };
  const PRACTICE_N = 3;

  const root = typeof document !== 'undefined' ? document.getElementById('root') : null;
  const PATH_FOLD_AT = 40;

  /* ------------------------------------------------------------ 核心↔按需段契约
   * 首屏核心对外只暴露一个对象 CORE：按需段 app-flow.js（DiagFlow）通过它拿状态与工具。
   * 状态只有一份（S），不复制。拆分的唯一目的是首屏字节：
   * app.js 里只有骨架/列表/题源门是首屏要的，出题/结果/路径图/练习都在按需段。
   * 这些函数里凡是 function 声明的都已在作用域顶部提升，此处按需引用即可；const 必须在此之后。 */
  var CORE = {
    S: S, E: E, Browser: Browser, Lazy: Browser.Lazy,
    h: h, append: append, figureEl: figureEl, show: show,
    theme: theme, nameOf: nameOf, labelLimit: labelLimit, clipLabel: clipLabel,
    lazyFail: lazyFail, LAZY_PATH: LAZY_PATH, PATH_FOLD_AT: PATH_FOLD_AT, STATUS_LABEL: STATUS_LABEL
  };
  var FLOW = null;   // app-flow.js 加载后经 registerFlow 注册进来；注册前路径图调用退化成提示
  function registerFlow(api) { FLOW = api; if (Browser) Browser.DiagFlow = api; }
  if (Browser) Browser.DiagCore = CORE;   // 浏览器下 app-flow.js 经 window.DiagCore 拿契约（Node 走 global.DiagCore）
  /* 已搬进 app-flow.js 的函数在这里一律经 FLOW 调用：FLOW 存在就转调，
   * 不存在（本批次还没把它挂上 <script> 链）时不许抛异常，给一行人话提示。 */
  function flow(name) {
    if (FLOW && typeof FLOW[name] === 'function') return FLOW[name].bind(FLOW);
    const cyEl = typeof document !== 'undefined' ? document.getElementById('path-cy') : null;
    if (cyEl && cyEl.dataset.ready !== 'err') {
      cyEl.dataset.ready = 'err';
      cyEl.append(h('p', { class: 'muted', text: '路径图组件未加载，请刷新重试。' }));
    }
    return null;
  }

  /* 三阶段数据：首屏只等 topics-lite + id-aliases，其余按需取。
   * 每个「按需」都是一次性 Promise，模块级缓存（见 loadData 下面的 ensure* 三兄弟）。 */
  let depsPromise = null;
  let fullTopicsPromise = null;
  let standardsPromise = null;
  let questionsPromise = null;   // 首屏之后的全量预取（只有 ?questions=full 排障开关会走，见 questionsAutoLoad）

  /* ---- 题库按章节按需取（卡 t_e855de2f）----
   * data/questions.json 仍是唯一真源，但浏览器不再整份下：构建脚本拆成
   * data/questions/<slug>.json（每章节一份）+ data/questions-index.json（key → 文件）。
   * 选一个知识点后只取它所在章节的那一份（gzip 中位 ≈1.5KB、最大 ≈6KB，原先 1164KB）。 */
  /* 排障开关：?questions=full 恢复「首屏之后立刻整份下题库」的老行为（拆分文件没构建 / 站点没更新时用）。
   * 默认关 —— 所以首屏阶段零题库请求。 */
  const questionsAutoLoad = typeof location !== 'undefined' && /[?&]questions=full(?:&|$)/.test(location.search);

  /* ------------------------------------------------------------ 小工具 */
  function h(tag, attrs) {
    const el = document.createElement(tag);
    const a = attrs || {};
    Object.keys(a).forEach(function (k) {
      const v = a[k];
      if (v == null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else if (k === 'open' || k === 'disabled' || k === 'selected' || k === 'value') el[k] = v === true ? true : v;
      else el.setAttribute(k, v === true ? '' : v);
    });
    for (let i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { append(el, x); }); return; }
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  function figureEl(svg) {
    if (typeof svg !== 'string' || svg.indexOf('<svg') !== 0) return null;
    if (/<\s*script|foreignObject|<\s*image\b|https?:\/\//i.test(svg.replace('xmlns="http://www.w3.org/2000/svg"', ''))) return null;
    const wrap = h('div', { class: 'q-figure' });
    wrap.innerHTML = svg;
    const node = wrap.querySelector('svg');
    if (!node) return null;
    node.setAttribute('role', 'img');
    node.setAttribute('aria-hidden', 'true');
    node.setAttribute('focusable', 'false');
    return wrap;
  }
  function sessionKey() {
    if (S.subject === 'english') return LS_SESSION_EN;
    if (S.subject === 'physics') return LS_SESSION_PHY;
    if (S.subject === 'chinese') return LS_SESSION_ZH;
    if (S.subject === 'science') return LS_SESSION_SCI;
    if (S.subject === 'morality') return LS_SESSION_MOR;
    if (S.subject === 'history') return LS_SESSION_HIS;
    if (S.subject === 'geography') return LS_SESSION_GEO;
    return LS_SESSION;
  }
  function withSubject(href) {
    if (S.subject === 'math' || !href || href.indexOf('subject=') >= 0 || href.indexOf('http') === 0) return href;
    return href + (href.indexOf('?') >= 0 ? '&' : '?') + 'subject=' + S.subject;
  }
  function detectSubject() {
    const params = new URLSearchParams(location.search);
    const explicit = params.get('subject');
    if (explicit === 'english' || explicit === 'math' || explicit === 'physics' || explicit === 'chinese' || explicit === 'science' || explicit === 'morality' || explicit === 'history' || explicit === 'geography') return explicit;
    const target = params.get('target') || '';
    let hashId = (location.hash || '').replace(/^#/, '');
    try { hashId = decodeURIComponent(hashId); } catch (e) { /* 保持原样 */ }
    if (/(^|,)\s*cne_/.test(target) || /^cne_/.test(hashId)) {
      params.set('subject', 'english');
      history.replaceState(null, '', location.pathname + '?' + params.toString() + location.hash);
      return 'english';
    }
    if (/(^|,)\s*cnp_/.test(target) || /^cnp_/.test(hashId)) {
      params.set('subject', 'physics');
      history.replaceState(null, '', location.pathname + '?' + params.toString() + location.hash);
      return 'physics';
    }
    if (/(^|,)\s*cns_/.test(target) || /^cns_/.test(hashId)) {
      params.set('subject', 'science');
      history.replaceState(null, '', location.pathname + '?' + params.toString() + location.hash);
      return 'science';
    }
    if (/(^|,)\s*cnd_/.test(target) || /^cnd_/.test(hashId)) {
      params.set('subject', 'morality');
      history.replaceState(null, '', location.pathname + '?' + params.toString() + location.hash);
      return 'morality';
    }
    if (/(^|,)\s*cng_/.test(target) || /^cng_/.test(hashId)) {
      params.set('subject', 'geography');
      history.replaceState(null, '', location.pathname + '?' + params.toString() + location.hash);
      return 'geography';
    }
    if (/(^|,)\s*cnh_/.test(target) || /^cnh_/.test(hashId)) {
      params.set('subject', 'history');
      history.replaceState(null, '', location.pathname + '?' + params.toString() + location.hash);
      return 'history';
    }
    if (/(^|,)\s*cnc_/.test(target) || /^cnc_/.test(hashId)) {
      params.set('subject', 'chinese');
      history.replaceState(null, '', location.pathname + '?' + params.toString() + location.hash);
      return 'chinese';
    }
    return 'math';
  }
  function applySubjectChrome() {
    document.body.classList.toggle('subject-english', S.subject === 'english');
    document.body.classList.toggle('subject-physics', S.subject === 'physics');
    document.body.classList.toggle('subject-chinese', S.subject === 'chinese');
    document.body.classList.toggle('subject-science', S.subject === 'science');
    document.body.classList.toggle('subject-morality', S.subject === 'morality');
    document.body.classList.toggle('subject-history', S.subject === 'history');
    document.body.classList.toggle('subject-geography', S.subject === 'geography');
    document.querySelectorAll('.site-nav a:not(.subject-link), a.brand').forEach(function (link) {
      const href = link.getAttribute('href');
      const next = withSubject(href);
      if (next && next !== href) link.setAttribute('href', next);
    });
    document.querySelectorAll('.subject-link').forEach(function (link) {
      const on = link.getAttribute('data-subject') === S.subject;
      link.classList.toggle('on', on);
      if (on) link.setAttribute('aria-current', 'true');
      else link.removeAttribute('aria-current');
    });
    if (S.subject === 'english') {
      document.title = '诊断 · 英语';
      var juniorOk = '三四五六七八九'.indexOf(S.gradeSel) >= 0;
      var seniorOk = S.gradeSel.indexOf('必修') === 0 || S.gradeSel.indexOf('选必') === 0;
      if (!juniorOk && !seniorOk) S.gradeSel = '四';
    }
    if (S.subject === 'physics') {
      document.title = '诊断 · 物理';
      if (S.gradeSel !== '八' && S.gradeSel !== '九' && !/^(必修[一二三]|选必[一二三])$/.test(S.gradeSel)) S.gradeSel = '八';
      if (S.gradeSel === '九') S.volSel = '全';
    }
    if (S.subject === 'science') {
      document.title = '诊断 · 小学科学';
      if ('一二三四五六'.indexOf(S.gradeSel) < 0) S.gradeSel = '一';
      if (S.volSel === '全') S.volSel = '';
    }
    if (S.subject === 'morality') {
      document.title = '诊断 · 小学道德与法治';
      if ('一二三四五六'.indexOf(S.gradeSel) < 0) S.gradeSel = '一';
      if (S.volSel === '全') S.volSel = '';
    }
    if (S.subject === 'history') {
      document.title = '诊断 · 初中历史';
      if ('七八九'.indexOf(S.gradeSel) < 0) S.gradeSel = '七';
      if (S.volSel === '全') S.volSel = '';
    }
    if (S.subject === 'geography') {
      document.title = '诊断 · 初中地理';
      if ('七八'.indexOf(S.gradeSel) < 0) S.gradeSel = '七';
      if (S.volSel === '全') S.volSel = '';
    }
    if (S.subject === 'chinese') {
      document.title = '诊断 · 小学语文';
      if ('一二三四五六'.indexOf(S.gradeSel) < 0) S.gradeSel = '一';
      if (S.volSel === '全') S.volSel = '';
    }
  }
  function lsGet(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 隐私模式等 */ } }

  /* ------------------------------------------------ 来自 route 的归途
   * route 页的「从这儿开始诊断」跳过来时 URL 带 from=route（拼装见 route.js 的 diagnosisUrl）。
   * 这里只加一个返回入口，不改 session 启动流程。
   * routeReturnHref 抽成纯函数：不读 DOM/Location，Node 侧可直接测（模块底部 window 检查后导出）。 */
  function routeReturnHref(search) {
    var q = String(search == null ? '' : search);
    if (q.charAt(0) === '?') q = q.slice(1);
    var from = null;
    try { from = new URLSearchParams(q).get('from'); } catch (e) { from = null; }
    if (from !== 'route') return null;
    /* route.html 与 index.html 同目录；不带任何 session 参数，回去就是干净的一页 */
    return 'route.html';
  }
  function routeBackBar() {
    return h('div', { class: 'route-back no-print', id: 'route-back' },
      h('a', { href: routeReturnHref(location.search), id: 'route-back-link' }, '← 回到作业分析'));
  }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  function nameOf(id) { const t = S.D.graph.byId[id]; return t ? t.name : id; }
  function getSettings() {
    const st = lsGet(LS_SETTINGS) || {};
    let limit = parseInt(st.limit, 10);
    if (!(limit >= LIMIT_MIN && limit <= LIMIT_MAX)) limit = E.DEFAULT_LIMIT;
    let screenLimit = parseInt(st.screenLimit, 10);
    if (!(screenLimit >= SCREEN_MIN && screenLimit <= SCREEN_MAX)) screenLimit = E.SCREEN_LIMIT;
    const confirm = E.clampConfirm(st.confirm);
    return { limit: limit, screenLimit: screenLimit, confirm: confirm };
  }
  function setSetting(k, v) { const o = getSettings(); o[k] = v; lsSet(LS_SETTINGS, o); }
  function seenList() { const v = lsGet(LS_SEEN); return Array.isArray(v) ? v : []; }
  function markSeen(qid) {
    if (!qid || S.demo) return;
    const v = seenList();
    if (v.indexOf(qid) < 0) { v.push(qid); lsSet(LS_SEEN, v); }
  }
  function newSeed() { return S.seedParam != null ? S.seedParam : Math.random().toString(36).slice(2, 10); }
  function resetUi() { S.ui = { key: null, phase: 'ask', answer: '', verdict: null, explainStep: 0, aiSteps: null, aiState: 'idle', aiRequested: false, askHistory: [], askPending: false, askScroll: false, labCfg: null, labDesc: null, labAsk: null, labAskMsg: null }; }
  function clearRoot() { while (root.firstChild) root.removeChild(root.firstChild); }
  function teardownPath() {
    S.pathToken++;
    S.pathTipLock = false;
    if (S.pathCy) { S.pathCy.destroy(); S.pathCy = null; window.__pathCy = null; }
  }
  function show(node) { teardownPath(); closeShare(); clearRoot(); root.append(node); window.scrollTo(0, 0); }
  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function theme() {
    return {
      primary: cssVar('--node-primary'), primaryBg: cssVar('--node-primary-bg'),
      junior: cssVar('--node-junior'), juniorBg: cssVar('--node-junior-bg'),
      senior: cssVar('--node-senior'), seniorBg: cssVar('--node-senior-bg'),
      currentBg: cssVar('--node-current-bg'), currentBorder: cssVar('--node-current-border'),
      text: cssVar('--node-text'), edge: cssVar('--edge'), edgeSoft: cssVar('--edge-soft'),
      bad: cssVar('--diagram-bad'), badBg: cssVar('--diagram-bad-bg')
    };
  }
  function labelLimit() { return window.matchMedia('(max-width: 700px)').matches ? 8 : 10; }
  function clipLabel(name) {
    const chars = Array.from(name || '');
    const limit = labelLimit();
    if (chars.length <= limit) return name || '';
    return chars.slice(0, limit - 1).join('') + '…';
  }

  /* ------------------------------------------------------------ 数据 */
  /* 首屏数据（阶段 1，唯一阻挡首屏的请求）：只等 topics-lite + id-aliases（约 60KB gzip）。
   * 另外三份都挪出首屏链：
   *   - dependencies.json（114KB）      → ensureDeps()，选中知识点后、出题前才等（阶段 2）
   *   - topics.json 的说明类字段（347KB）→ ensureFullTopics()，同一时机后台取，到货原地补字段（阶段 2）
   *   - cn-curriculum-standards.json    → ensureStandards()，进结果页 / 课标对照才取（阶段 3）
   * 题库不在首屏链上，见 loadQuestions()。 */
  async function loadData() {
    const urls = ['../data/topics-lite.json', '../data/id-aliases.json'];
    const rs = await Promise.all(urls.map(function (u) { return fetch(u); }));
    rs.forEach(function (r, i) { if (!r.ok) throw new Error(urls[i] + ' → HTTP ' + r.status); });
    const js = await Promise.all(rs.map(function (r) { return r.json(); }));
    const topics = js[0].filter(function (t) { return E.subjectOf(t) === S.subject; });
    // 先修关系先留空：图照样能用（只是暂时不回溯），选中知识点后由 ensureDeps() 补齐再重建
    const deps = [];
    // 题库还没有：buildGraph 会为每个知识点回退到 topics.json 的 diagnostic_question
    const graph = E.buildGraph(topics, deps, null);
    S.D = { topics: topics, deps: deps, stdById: {}, graph: graph, tree: buildTree(topics), aliases: (js[1] && js[1].aliases) || {} };
    /* 题库不再在首屏之后整份预热（原 loadQuestions() 全量拉 1164KB gzip）：改成选中知识点后
     * 由 ensureQuestionsForOne(topicId) 只取它所在章节的那一份。排障开关 ?questions=full 才走老路。 */
    if (questionsAutoLoad) questionsPromise = loadQuestions();
  }

  /* 纯函数（Node 可直测）：这份数据快照上，这些目标还问得出题吗？
   * 为什么需要它：lite 里没有 diagnostic_question，题库又可能还在路上，
   * 这时候开会话 → E.nextItem 立刻 null → 会话一题没问就收敛成 0 题结果页。
   * 所以「点进流程」之前必须先问这一句（见 ensureFlowReady / startSession）。 */
  function askable(Eg, topics, deps, questions, targets, opts) {
    if (!Eg || !Array.isArray(topics) || !topics.length) return false;
    if (!Array.isArray(targets) || !targets.length) return false;
    try {
      const g = Eg.buildGraph(topics, deps || [], questions || null);
      const s = Eg.createSession(g, targets, opts || {});
      return !!Eg.nextItem(g, s);
    } catch (e) {
      return false;   // 目标不在图里等：当作问不出题
    }
  }

  function sessionOpts(limit, mode) {
    const st = getSettings();
    const screen = mode === 'screen';
    return {
      mode: screen ? 'screen' : 'target',
      limit: limit || (screen ? st.screenLimit : st.limit),
      confirm: st.confirm,
      seed: 'probe'
    };
  }

  function flowAskable(targets, limit, mode) {
    if (!S.D) return false;
    return askable(E, S.D.topics, S.D.deps, S.graphQuestions, targets, sessionOpts(limit, mode));
  }

  /* 两份题源（按章节取的题库 / 全量 topics 的 diagnostic_question）都定案了吗？
   * 未定案 = 还有题库请求在路上 → 这时候不给孩子看结果页，显示「题目还在载入，稍等…」。 */
  function questionSourcesSettled() {
    return S.questionsInFlight === 0 && (S.fullTopicsLoaded || S.fullTopicsFailed);
  }

  /* 重建图。D.topics 里始终是同一批对象（字段补齐是原地完成的），所以重建只换索引与先修/题库。 */
  function rebuildGraph() {
    if (!S.D) return;
    S.D.graph = E.buildGraph(S.D.topics, S.D.deps, S.graphQuestions);
    S.D.tree = buildTree(S.D.topics);
  }

  /* 阶段 2a：先修关系。取不到就降级 —— 图里没有先修边，结果页的「先修回溯」不工作，
   * 但孩子照样能做题（界面上本来就有这条兜底）。失败下一次进流程再试。 */
  function ensureDeps() {
    if (S.depsLoaded) return Promise.resolve(true);
    if (depsPromise) return depsPromise;
    depsPromise = (async function () {
      try {
        const r = await fetch('../data/dependencies.json');
        if (!r.ok) return false;
        const all = await r.json();
        if (!Array.isArray(all)) return false;
        const allow = {};
        S.D.topics.forEach(function (t) { allow[t.id] = true; });
        S.D.deps = all.filter(function (d) { return d && allow[d.topicId] && allow[d.prerequisiteId]; });
        S.depsLoaded = true;
        rebuildGraph();
        return true;
      } catch (e) {
        return false;   // 先修数据坏了：静默降级，不挡出题
      }
    })();
    depsPromise.then(function (ok) { if (!ok) depsPromise = null; });
    return depsPromise;
  }

  /* 阶段 2b：全量 topics.json（347KB）只取一次，把 lite 里没有的字段原地补进 D.topics。
   * 只补缺口、不覆盖 lite 已有字段；补完重建一次图（diagnostic_question 回退题要靠它），
   * 再原地刷新正在显示「正在载入说明…」的节点 —— 不整页重绘，界面不会闪。 */
  function ensureFullTopics() {
    if (S.fullTopicsLoaded) return Promise.resolve(true);
    if (fullTopicsPromise) return fullTopicsPromise;
    fullTopicsPromise = (async function () {
      try {
        const r = await fetch('../data/topics.json');
        if (!r.ok) return false;
        const all = await r.json();
        if (!Array.isArray(all)) return false;
        const byId = {};
        all.forEach(function (t) { if (t && t.id) byId[t.id] = t; });
        S.D.topics.forEach(function (t) {
          const full = byId[t.id];
          if (!full) return;
          Object.keys(full).forEach(function (k) { if (!(k in t)) t[k] = full[k]; });
        });
        S.fullTopicsLoaded = true;
        rebuildGraph();
        refreshPending();
        resumePendingStart();   // 题源到了：把「点了目标但还没出题」的那次操作续上
        return true;
      } catch (e) {
        S.fullTopicsFailed = true;   // 失败不挡流程：详情改说「说明载入失败」，可刷新重试
        refreshPending();
        resumePendingStart();      // 另一份题源也可能在这之后失败：这里更新一次挂起状态
        return false;
      }
    })();
    fullTopicsPromise.then(function (ok) { if (!ok) { fullTopicsPromise = null; S.fullTopicsFailed = true; } });
    return fullTopicsPromise;
  }

  /* 阶段 3：课标条目正文。进结果页 / 课标对照时才取，到货后原地换掉「正在载入课标原文…」。 */
  function ensureStandards() {
    if (S.standardsLoaded) return Promise.resolve(true);
    if (standardsPromise) return standardsPromise;
    standardsPromise = (async function () {
      try {
        const r = await fetch('../data/cn-curriculum-standards.json');
        if (!r.ok) return false;
        const js = await r.json();
        const by = {};
        ((js && js.items) || []).forEach(function (x) { if (x && x.id) by[x.id] = x; });
        S.D.stdById = by;
        S.standardsLoaded = true;
        refreshStdText();
        return true;
      } catch (e) {
        S.standardsFailed = true;
        refreshStdText();
        return false;
      }
    })();
    standardsPromise.then(function (ok) { if (!ok) { standardsPromise = null; S.standardsFailed = true; } });
    return standardsPromise;
  }

  /* 阶段 2 的统一入口：先修关系要等（出题正确性依赖它），全量字段后台取（不挡出题）。 */
  function ensureStage2Data() {
    ensureFullTopics();
    return ensureDeps();
  }

  /* ------------------------------------------------------------ 题库（按章节按需取）
   * 一次「取题库」= 一次索引查表 + 一个章节 bundle（中位 ≈1.5KB gzip）。
   * 同一章节只请求一次：并发调用复用同一个 Promise（bundlePromises）。 */

  /* index 的 key：与 scripts/build-questions-split.mjs 的 keyOf() 同一套规则。
   * 数学 topics 没有 subject 字段，用与 engine.subjectOf() 一致的推导。 */
  function questionsKeyOf(t) {
    if (!t) return null;
    const subj = E.subjectOf ? E.subjectOf(t) : (t.subject || 'math');
    const grade = (t.grade == null || t.grade === '') ? '' : String(t.grade);
    return subj + '|' + grade + '|' + String(t.chapter || '');
  }

  /* data/questions-index.json 实测 ≈77KB 原文 / ≈19KB gzip（整份题库的 1/60），用到时才取，取一次记住。 */
  function ensureQuestionsIndex() {
    if (S.questionsIndex) return Promise.resolve(S.questionsIndex);
    if (S.questionsIndexPromise) return S.questionsIndexPromise;
    S.questionsIndexPromise = (async function () {
      try {
        const r = await fetch('../data/questions-index.json');
        if (!r.ok) return null;
        const js = await r.json();
        if (!js || typeof js !== 'object' || Array.isArray(js)) return null;
        S.questionsIndex = js;
        return js;
      } catch (e) {
        return null;   // 索引坏了/没构建：交给全量兜底
      }
    })();
    S.questionsIndexPromise.then(function (m) { if (!m) S.questionsIndexPromise = null; });   // 失败下次可重试
    return S.questionsIndexPromise;
  }

  /* 把一批题并进内存索引并重建图。同一道题（同 id）只进一次：重复调用幂等。 */
  function addQuestions(list) {
    if (!S.D || !Array.isArray(list)) return 0;
    const allow = Object.create(null);
    S.D.topics.forEach(function (t) { allow[t.id] = true; });
    const fresh = [];
    list.forEach(function (q) {
      if (!q || !q.id || !q.topicId || !allow[q.topicId]) return;
      const arr = S.bankByTopic[q.topicId] || (S.bankByTopic[q.topicId] = []);
      for (let i = 0; i < arr.length; i++) { if (arr[i].id === q.id) return; }
      arr.push(q);
      fresh.push(q);
    });
    if (!fresh.length) return 0;
    S.graphQuestions = (S.graphQuestions || []).concat(fresh);   // 重建图时复用（buildGraph 自己按题号排序）
    rebuildGraph();
    return fresh.length;
  }

  /* 题库到货：把「点了目标但还没出题」的那次操作续上；没人等就静默重绘一次当前视图。
   * 与改前 loadQuestions 末尾的行为一致，只是现在每个 bundle 到货都可能触发。 */
  function questionsArrived() {
    if (typeof document === 'undefined') return;
    if (resumePendingStart()) return;
    if (S.session || S.prac || S.pracLoading) return;   // 用户已在流程里：只更新 D，不重绘
    renderStart(S.startErr);
  }

  /* 取一个知识点所在章节的题库：同一章节只请求一次，并发调用复用同一个 Promise。
   * 返回 Promise<boolean>：到货 true（该知识点本身没题也算到货），失败 false（下次可重试）。 */
  function ensureQuestionsForOne(topicId) {
    if (!S.D || !S.D.graph) return Promise.resolve(false);
    const t = S.D.graph.byId[topicId];
    if (!t) return Promise.resolve(false);
    const key = questionsKeyOf(t);
    if (S.bundleLoaded[key]) return Promise.resolve(true);
    if (S.bundlePromises[key]) return S.bundlePromises[key];
    S.questionsInFlight++;
    const p = (async function () {
      try {
        return await loadBundle(key);
      } catch (e) {
        return false;
      } finally {
        S.questionsInFlight--;
      }
    })();
    S.bundlePromises[key] = p;
    p.then(function (ok) {
      if (!ok) { delete S.bundlePromises[key]; return; }   // 失败：清掉 Promise，下次操作再试
      S.bundleLoaded[key] = true;
      questionsArrived();
    });
    return p;
  }

  /* 取一组知识点所在章节的题库（去重后并发；同一章节只会发一个请求）。
   * 并发按 6 条泳道走：整年级诊断的目标可能有几百个、落在几十个章节上，
   * 一次性全部发起会把浏览器同域连接打满（HTTP/1.1 上限 6，多的排队），
   * 也会和首屏/正在做的题抢带宽。总量不变（每章节仍只取一次），只是排成队列。 */
  const QUESTION_LANES = 6;
  function ensureQuestionsForTopics(ids) {
    const uniq = Array.from(new Set((ids || []).filter(Boolean)));
    if (!uniq.length) return Promise.resolve(true);
    const results = new Array(uniq.length);
    let cursor = 0;
    function lane() {
      if (cursor >= uniq.length) return Promise.resolve();
      const i = cursor++;
      return ensureQuestionsForOne(uniq[i]).then(function (ok) {
        results[i] = ok;
        return lane();
      });
    }
    const lanes = [];
    for (let i = 0; i < Math.min(QUESTION_LANES, uniq.length); i++) lanes.push(lane());
    return Promise.all(lanes).then(function () {
      return results.every(function (ok) { return ok; });
    });
  }

  /* 恢复存档用：目标 + 存档里答过的题的章节都要先取到，否则 replay 会用「空题库」算
   * needConfirm，判定与存档时不一致（答 3 题掌握会被算成 1 题）。 */
  function ensureQuestionsForAnswers(targets, answers) {
    return ensureQuestionsForTopics((targets || []).concat((answers || []).map(function (a) { return a && a.id; })));
  }

  /* 取一个章节的 bundle。两条兜底（都与 warn 文案一起，测试守：tests/test_questions_split.js）：
   *   - index 里查不到 key（老数据 / 新加章节没重新构建）→ 回退全量；
   *   - bundle 取不到（404 / 离线未缓存 / 坏 JSON / 非数组）→ 同样的 warn + 回退全量。
   * 为什么 bundle 取不到也必须回退：不回退就静默落到 topics.json 的 diagnostic_question，
   * 每个点只剩 1 道兜底题，答完一题就收敛成「都掌握啦，真棒！…目标知识点已掌握」——
   * 等于给孩子一个假结论（复核卡 t_588d8341 用注入 404 的服务实测过）。 */
  async function loadBundle(key) {
    const index = await ensureQuestionsIndex();
    const file = index && typeof index[key] === 'string' ? index[key] : null;
    if (file) {
      const list = await fetchBundle(file);
      if (Array.isArray(list)) { addQuestions(list); return true; }
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[questions] bundle 取不到，回退全量', key, file);
      }
      return loadFullQuestions();
    }
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[questions] index 缺 key，回退全量', key);
    }
    return loadFullQuestions();
  }

  /* 取一个 bundle 文件：404 / 网络错 / 坏 JSON / 不是数组，一律返回 null（交给 loadBundle 回退全量）。 */
  async function fetchBundle(file) {
    try {
      const r = await fetch('../data/questions/' + file);
      if (!r.ok) return null;
      const list = await r.json();
      return Array.isArray(list) ? list : null;
    } catch (e) {
      return null;
    }
  }

  /* 全量兜底只发起一次；失败清 Promise 以便下次重试。 */
  function loadFullQuestions() {
    if (S.fullBankPromise) return S.fullBankPromise;
    S.fullBankPromise = loadQuestions();
    S.fullBankPromise.then(function (ok) { if (!ok) S.fullBankPromise = null; });
    return S.fullBankPromise;
  }

  /* 题库门：取「这一轮要测的目标」所在章节的题库（无参形式给 ensureFlowReady 用）。
   * flowTargets 由 ensureFlowReady 在调用前放进；显式版本是 ensureQuestionsForTopics(ids)，
   * 练习 / 恢复存档 / 先修回溯那些入口直接传 ids。 */
  let flowTargets = [];
  function ensureQuestions() {
    return ensureQuestionsForTopics(flowTargets);
  }

  /* 「点进流程」的题源门（阶段 2）：先修关系 → 目标所在章节的题库。
   * 顺序：先修关系必须等（出题正确性依赖它）；然后等两份题源里先到的那一份，
   * 够出题就立刻放行（不多等另一份），不够再等齐。两份都失败才返回 false。
   * 为什么不能只 await ensureDeps()：lite 没有 diagnostic_question，
   * 那时候开会话就是一题都问不出来的空结果页（P0 回归，reviewer 在 50KB/s 下必现）。 */
  async function ensureFlowReady(targets, limit, mode) {
    await ensureDeps();
    flowTargets = targets || [];
    /* 先把「这些目标所在章节的题库」这一份开起来，再判能不能出题。
     * 顺序曾经是「能出题就早退」，于是第二次点知识点时（全量 topics 已到货、目标自带
     * diagnostic_question）会直接放行、一次 bundle 都不取 —— 会话退化成「本知识点第 1 / 1 题」，
     * 答完一题就是假结论（A→B 快速切换时必现，卡 t_83ca3ac5 实测）。
     * 同一章节只会请求一次（bundleLoaded / 在途 Promise 去重），重复点不产生额外请求。 */
    const full = ensureFullTopics();
    const bank = ensureQuestions();                   // 只取这些目标所在章节（不再是整份 1164KB 题库）
    if (flowAskable(targets, limit, mode) && S.questionsInFlight === 0) return true;
    stage2Status('题目还在载入，稍等…');
    await Promise.race([full, bank]);
    /* 题库还没定案（还在路上）时不许开门：bundle 404 → 回退全量 7.8MB 的那几秒里，
     * 图里只剩 topics.json 的 diagnostic_question，这时候开出的会话就是「本知识点第 1 / 1 题」，
     * 答完一题直接给结论 —— 复核卡 t_588d8341 与 t_83ca3ac5 都是这么复现的假结论。
     * 判据用 questionsInFlight（在飞的题库请求数）而不是「bank 为空」：
     * buildGraph 给无真题的点塞 type:'legacy' 兜底题，bank 永远非空。 */
    if (flowAskable(targets, limit, mode) && S.questionsInFlight === 0) return true;
    await Promise.all([full, bank]);
    return flowAskable(targets, limit, mode);
  }

  /* 题源到货后，把「点了目标但还没出题」的那次操作原地续上（会话按到货后的图重开）。
   * 返回 true 表示接管了这次渲染（调用方不要再画首页）。 */
  function resumePendingStart() {
    if (!S.pendingStart || !S.D || typeof document === 'undefined') return false;
    const p = S.pendingStart;
    if (flowAskable(p.targets, p.limit, p.mode)) {
      S.pendingStart = null;
      startSession(p.targets, p.label, p.limit, p.mode);
      return true;
    }
    if (!questionSourcesSettled()) return true;   // 还有题源在路上：继续等，别画结果页
    S.pendingStart = null;
    renderNoQuestions(p.targets, p.label, p.limit, p.mode);
    return true;
  }

  /* 全量字段到货后，把正在显示占位文字的节点原地填上（不重绘整页）。
   * 覆盖四类缺口：description（详情）、mastery_criteria（掌握标准）、
   * standards 引用（详情里的课标条目 + 结果页「相关课标条目」整卡）。 */
  function refreshPending() {
    if (typeof document === 'undefined' || !S.D) return;
    Array.prototype.forEach.call(document.querySelectorAll('.desc-pending'), function (el) {
      const t = S.D.graph.byId[el.getAttribute('data-topic-id')];
      if (!t || !t.description) return;
      el.textContent = t.description;
      el.className = 'topic-desc';
      el.removeAttribute('data-topic-id');
    });
    if (!S.fullTopicsLoaded) return;
    Array.prototype.forEach.call(document.querySelectorAll('.mastery-pending'), function (el) {
      const t = S.D.graph.byId[el.getAttribute('data-topic-id')];
      if (!t) return;
      const real = masteryNode(t);
      if (real) el.replaceWith(real); else el.remove();
    });
    Array.prototype.forEach.call(document.querySelectorAll('.std-block-pending'), function (el) {
      const id = el.getAttribute('data-topic-id');
      if (!S.D.graph.byId[id]) return;
      el.replaceWith(standardsBlock(id));
    });
    /* 课标对照卡的结构（哪几条、对应哪些知识点）也依赖全量 standards 引用，到货后整卡换一次 */
    const card = document.getElementById('standards');
    if (card && S.session && S.D.graph) {
      try { card.replaceWith(standardsCard(E.summarize(S.D.graph, S.session))); } catch (e) { /* 结构没变好就留旧的 */ }
    }
  }

  /* 全量兜底（1.27MB gzip）：只在 index 缺 key 或 bundle 取不到时由 loadBundle / ?questions=full 触发。
   * 首屏阶段不再调用它，所以首屏零题库请求。
   * 到货后用同一份 topics / deps 重建图，然后：
   *   - 用户还没进诊断流程（首页 / 图谱 / 选题列表）→ 静默重绘一次当前视图
   *   - 已经进了诊断 / 讲解 / 自评（session / prac 非空）→ 只更新 D，不重绘，
   *     不能把用户正在看的那一页刷掉（会话是纯数据，换图不会坏）
   * 404 / 解析失败 → questions 保持 null，走 topics.json 的 diagnostic_question 回退，静默。 */
  async function loadQuestions() {
    let questions = null;
    let ok = false;
    try {
      const r = await fetch('../data/questions.json');
      if (r.ok) questions = await r.json();          // 404：保持 questions = null
      if (!S.D || !Array.isArray(questions)) { questions = null; }   // 空/坏 JSON：同样当没有题库
      else {
        const allow = {};
        S.D.topics.forEach(function (t) { allow[t.id] = true; });
        questions = questions.filter(function (q) { return q && allow[q.topicId]; });
        addQuestions(questions);                     // 按章节已到货的题不重复加（addQuestions 按 id 去重）
        S.graphQuestions = questions;                  // 全量在手：之后 ensureDeps / ensureFullTopics 重建图时复用
        S.D.graph = E.buildGraph(S.D.topics, S.D.deps, questions);
        ok = true;
      }
    } catch (e) {
      questions = null;   // 题库损坏：静默当作没有题库（首屏阶段 1 早就渲染完了，不受影响）
    }
    if (typeof document === 'undefined') return;
    /* 有人在等这份题库（点了目标但题库还没到货）：按到货后的图重开会话，别让调用方再画首页。 */
    if (resumePendingStart()) return;
    if (!ok) { questionsPromise = null; return; }    // 失败后再点一次时可以重试
    if (S.session || S.prac || S.pracLoading) return;      // 用户已在流程里：只更新 D，不重绘
    renderStart(S.startErr);                           // 首页 / 图谱 / 选题列表：静默重绘
    return ok;
  }

  function buildTree(topics) {
    const vols = {};
    topics.forEach(function (t) {
      if (t.external) return;
      const c = E.parseChapter(t.chapter);
      const v = vols[c.volume] || (vols[c.volume] = { chapters: [], byKey: {} });
      const key = c.chapterNo + ' ' + c.chapterName;
      let ch = v.byKey[key];
      if (!ch) {
        ch = v.byKey[key] = { volume: c.volume, key: c.volume + ' ' + c.chapterNo, label: c.chapterNo + ' ' + c.chapterName, topics: [] };
        v.chapters.push(ch);
      }
      ch.topics.push({ t: t, section: c.section });
    });
    return vols;
  }

  /* ------------------------------------------------------------ 孩子档案 */
  const CC = Browser.CnmChildren;
  function childLabel(c) { return c.name + (c.grade ? '（' + c.grade + '）' : ''); }
  function childrenHref(path) { return '../children/' + (path || ''); }
  function fromQuery() { return '?from=diagnose' + (S.subject !== 'math' ? '&subject=' + S.subject : ''); }
  function childSelect(onPick) {
    const cur = CC.current();
    const sel = h('select', { id: 'child-select', 'aria-label': '当前孩子' },
      h('option', { value: '' }, '不保存到档案'),
      CC.list().map(function (c) { return h('option', { value: c.id, selected: !!cur && cur.id === c.id }, childLabel(c)); }));
    sel.value = cur ? cur.id : '';
    sel.addEventListener('change', function () { onPick(sel.value || null); });
    return sel;
  }
  function childBar(mode) {
    if (S.demo) return null;
    const kids = CC.list();
    const cur = CC.current();
    if (!kids.length) {
      return h('div', { class: 'banner child-bar no-print', id: 'child-bar' },
        h('b', { text: '还没有孩子档案。' }),
        '添加后，诊断结果会按孩子保存，之后能回看每次的记录和薄弱知识点。', ' ',
        h('a', { class: 'btn btn-primary', href: childrenHref(fromQuery()), text: '添加孩子' }));
    }
    if (mode === 'question') {
      return h('div', { class: 'child-bar compact row no-print', id: 'child-bar' },
        h('span', { class: 'muted small' }, '当前孩子'),
        childSelect(function (id) { CC.setCurrent(id); }));
    }
    if (mode === 'result') {
      const key = recordKey();
      return h('div', { class: 'card child-bar no-print', id: 'child-bar' },
        h('p', { style: 'margin:0 0 8px' }, cur
          ? [h('b', { text: '已保存到「' + cur.name + '」的档案。' }), ' 换成别的孩子会把这条记录一起挪过去。']
          : [h('b', { text: '这次结果还没有存入档案。' }), ' 选一个孩子，就会保存。']),
        h('div', { class: 'row' },
          h('label', { for: 'child-select' }, '保存到'),
          childSelect(function (id) {
            if (cur && id !== cur.id) { if (id) CC.moveRecord(key, cur.id, id); else CC.removeRecord(cur.id, key); }
            CC.setCurrent(id);
            renderResult();
          }),
          cur ? h('a', { class: 'btn', href: childrenHref('history.html?child=' + encodeURIComponent(cur.id)), text: '盲区与历史' }) : null));
    }
    return h('div', { class: 'card child-bar no-print', id: 'child-bar' },
      h('div', { class: 'row' },
        h('label', { for: 'child-select' }, '当前孩子'),
        childSelect(function (id) { CC.setCurrent(id); renderStart(); }),
        h('span', { class: 'grow' }),
        cur ? h('a', { class: 'btn', href: childrenHref('history.html?child=' + encodeURIComponent(cur.id)), text: '盲区与历史' }) : null,
        h('a', { class: 'btn', href: childrenHref(fromQuery()), text: '孩子档案' })),
      h('p', { class: 'muted small', style: 'margin:8px 0 0' },
        cur ? '诊断做完，结果会保存到「' + cur.name + '」的档案里。' : '选了“不保存到档案”时，诊断结果不会存下来。'));
  }
  function recordKey() { return [S.subject, S.session.seed, S.session.targets.join(',')].join('|'); }
  function saveToChild(sum) {
    const cur = CC.current();
    if (S.demo || !cur || !sum.asked) return;
    CC.saveRecord(cur.id, {
      key: recordKey(), subject: S.subject, label: S.sessionMeta.label, mode: sum.mode, asked: sum.asked,
      targets: sum.mode === 'screen' || sum.targets.length > 6 ? null : sum.targets,
      counts: { weak: sum.weak.length, shaky: sum.shaky.length, mastered: sum.mastered.length, untested: sum.untested.length },
      weak: sum.weak, roots: sum.roots.map(function (r) { return r.id; }), shaky: sum.shaky, mastered: sum.mastered
    });
  }
  function noteBlind(sum) {
    if (S.demo || !sum || !sum.asked || !window.CnmBlind) return;
    window.CnmBlind.noteResult({
      subject: S.subject, key: recordKey(), label: S.sessionMeta.label, demo: S.demo,
      weak: sum.weak, shaky: sum.shaky, mastered: sum.mastered,
      roots: sum.roots.map(function (r) { return r.id; }),
      answers: S.session.answers
    });
  }
  function diagnoseHrefFor(ids) {
    if (window.CnmBlind) return window.CnmBlind.diagnoseHref(ids, S.subject, './');
    const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
    let q = 'target=' + list.map(encodeURIComponent).join(',');
    if (S.subject !== 'math') q = 'subject=' + S.subject + '&' + q;
    return './?' + q;
  }
  function blindStartCard() {
    if (!window.CnmBlind) return null;
    const rows = window.CnmBlind.list({ subject: S.subject, limit: 6 });
    if (!rows.length) return null;
    const cur = CC.current();
    const more = window.CnmBlind.historyHref(cur && cur.id, '../children/');
    return h('div', { class: 'card', id: 'blind-start' },
      h('h2', { text: '本机盲区（最近薄弱点）' }),
      h('p', { class: 'muted small' }, '根据本机诊断记录汇总，数据只留在这台浏览器。点「再测」会按该知识点重新诊断。'),
      h('ul', { class: 'blind-list' }, rows.map(function (row) {
        return h('li', { class: 'blind-item' },
          h('span', { class: 'blind-name', text: nameOf(row.id) }),
          ' ',
          h('span', { class: 'tag ' + (row.status === 'weak' ? 'weak' : 'shaky'), text: row.status === 'weak' ? (row.root ? '根因' : '薄弱') : '不稳' }),
          row.wrongs ? h('span', { class: 'muted small', text: ' · 答错 ' + row.wrongs + ' 次' }) : null,
          ' ',
          h('a', { class: 'blind-retest', href: diagnoseHrefFor([row.id]), text: '再测' }));
      })),
      h('p', { class: 'row' },
        h('a', { class: 'btn', href: more, text: '查看全部盲区' }),
        rows[0] ? h('a', { class: 'btn btn-primary', href: diagnoseHrefFor(rows.filter(function (r) { return r.status === 'weak'; }).slice(0, 5).map(function (r) { return r.id; })), text: '再测前几个薄弱点' }) : null));
  }
  function blindResultCard(sum) {
    const weakIds = (sum.weak || []).slice();
    const rootIds = (sum.roots || []).map(function (r) { return r.id; });
    const shakyIds = (sum.shaky || []).slice();
    if (!weakIds.length && !shakyIds.length) return null;
    const cur = CC.current();
    const hist = window.CnmBlind ? window.CnmBlind.historyHref(cur && cur.id, '../children/') : '../children/history.html';
    return h('div', { class: 'card no-print', id: 'blind-result' },
      h('h2', { text: '盲区再测' }),
      h('p', { class: 'muted small' }, '把本轮判为薄弱或不稳的知识点收进本机盲区汇总，可一键再测。不会上传答题内容。'),
      rootIds.length ? h('p', null,
        h('a', { class: 'btn btn-primary', href: diagnoseHrefFor(rootIds), text: '再测薄弱根因（' + rootIds.length + '）' })) : null,
      weakIds.length && weakIds.join(',') !== rootIds.join(',') ? h('p', null,
        h('a', { class: 'btn', href: diagnoseHrefFor(weakIds.slice(0, 8)), text: '再测薄弱知识点（' + Math.min(8, weakIds.length) + (weakIds.length > 8 ? '+' : '') + '）' })) : null,
      shakyIds.length ? h('p', null,
        h('a', { class: 'btn', href: diagnoseHrefFor(shakyIds.slice(0, 8)), text: '再测不稳知识点（' + Math.min(8, shakyIds.length) + (shakyIds.length > 8 ? '+' : '') + '）' })) : null,
      h('p', null, h('a', { href: hist, text: '打开本机盲区汇总' })));
  }

  /* ------------------------------------------------------------ 会话 */
  function save() {
    if (S.demo || !S.session) return;
    lsSet(sessionKey(), {
      v: 2, mode: S.session.mode, targets: S.session.targets, limit: S.session.limit, confirm: S.session.confirm,
      label: S.sessionMeta.label, answers: S.session.answers,
      seed: S.session.seed, avoid: S.session.avoid, savedAt: new Date().toISOString()
    });
  }

  function startSession(targets, label, limit, mode) {
    S.pathExpanded = false;
    const screen = mode === 'screen';
    const st = getSettings();
    S.session = E.createSession(S.D.graph, targets, {
      mode: mode, limit: limit || (screen ? st.screenLimit : st.limit), confirm: st.confirm, seed: newSeed(), avoid: seenList()
    });
    S.sessionMeta = { label: label };
    resetUi();
    save();
    /* 兜底：题源还在路上（lite 没有 diagnostic_question + 题库没到 + 全量没到）时开出的会话
     * 一题都问不出来，直接 render() 就会收敛成「0 已答题数 / 未测」的空结果页 ——
     * 孩子一题没答就被告知做完了，弱网 5–25s 窗口内点任何知识点都会踩到（P0 回归）。
     * 这里挂起会话参数、显示「题目还在载入，稍等…」，数据到货后由 resumePendingStart() 重开。 */
    if (!E.nextItem(S.D.graph, S.session) && !S.session.answers.length) {
      if (!questionSourcesSettled()) {
        S.pendingStart = { targets: targets, label: label, limit: limit, mode: mode };
        renderQuestionsPending();
        return;
      }
      renderNoQuestions(targets, label, limit, mode);
      return;
    }
    S.pendingStart = null;
    render();
  }

  /* 阶段 2 的等待只发生在这里：点了目标之后、出题之前。先修关系没到就等一下
   * （弱网下 114KB 约 2s），并在开始页留一行状态文字；全量字段在后台同时开取。 */
  function stage2Status(msg) {
    if (typeof document === 'undefined') return;
    const el = document.getElementById('stage2-status');
    if (el) el.textContent = msg || '';
  }

  async function startSessionReady(targets, label, limit, mode) {
    await ensureFlowReady(targets, limit, mode);
    stage2Status('');
    startSession(targets, label, limit, mode);
  }

  /* 所有「进流程」的按钮都过这一道：先修关系 + 至少一份题源到货（见 ensureFlowReady）。
   * ensureFlowReady 在取不到时会降级/失败返回，绝不会把用户无声卡住：
   *   - 停在中途（题库还在下）→ 开始页留一行「题目还在载入，稍等…」，到货后自动继续；
   *   - 两份题源都失败 → 给一张可操作的重试卡（不是 0 题空结果页）。
   * latest-click-wins：等待期间又点了别的知识点，门一开就按「最后一次点击」重过门，
   * 不为用户已经不想要的那次点击开会话（旧版 `if (flowPending) return;` 把后一次点击静默吞掉：
   * 点 A（慢章）→ 0.45s 内点 B（快章）→ B 的题库一次都没请求，最后开的却是 A 的会话）。
   * 同一章节重过门命中的是 ensureQuestionsForOne 的在途 Promise，不会重复发请求。 */
  let flowSeq = 0;      // 每次点击 +1：门开时用它判断「还是不是最新那次点击」
  let flowJob = null;   // 最后一次点击的 { targets, mode, fn }

  function withStage2(targets, mode, fn) {
    flowJob = { targets: targets, mode: mode, fn: fn };
    flowSeq++;
    if (S.flowPending) return;       // 门已开着：那次门开时会按最新点击重过一遍，不叠第二个门
    openStage2Gate();
  }

  function openStage2Gate() {
    const seq = flowSeq;
    const job = flowJob;
    S.flowPending = true;
    if (typeof document !== 'undefined') stage2Status('正在载入先修关系…');
    ensureFlowReady(job.targets, undefined, job.mode).then(function (ok) {
      if (seq !== flowSeq) return openStage2Gate();   // 等待期间又点了别的：按最新那次重过门
      S.flowPending = false;
      if (typeof document !== 'undefined') stage2Status('');
      if (ok) { job.fn(); return; }
      renderFlowBlocked(job.targets, job.mode, job.fn);
    }, function () {
      /* 取题源本身抛错（不该发生，但别让 flowPending 卡死成「点了没反应」） */
      if (seq !== flowSeq) return openStage2Gate();
      S.flowPending = false;
      if (typeof document !== 'undefined') stage2Status('');
      renderFlowBlocked(job.targets, job.mode, job.fn);
    });
  }

  /* 不走诊断会话的入口（练习 / 路径练习）只需要阶段 2 的先修关系与说明字段，不需要题库门。 */
  function withStage2Data(fn) {
    if (typeof document !== 'undefined') stage2Status('正在载入先修关系…');
    ensureStage2Data().then(function () {
      if (typeof document !== 'undefined') stage2Status('');
      fn();
    });
  }

  /* 恢复存档：先把存档里答过的章节题库取到再 replay（replay 的 needConfirm 看当时的题库），
   * 取不到也照 replay —— 只是判定按现有图算，和改前「题库没到就恢复」的处境一样。 */
  function restoreFromSave(saved, onFail) {
    ensureQuestionsForAnswers(saved.targets, saved.answers).then(function () {
      if (restoreSession(saved)) { render(); return; }
      lsDel(sessionKey());
      if (typeof onFail === 'function') { onFail(); return; }
      renderStart('存档无法恢复，已清除。');
    });
  }

  function restoreSession(saved) {
    try {
      S.session = E.replay(S.D.graph, saved.targets, saved.answers, {
        mode: saved.mode, limit: saved.limit, confirm: saved.confirm, seed: saved.seed, avoid: saved.avoid
      });
      S.sessionMeta = { label: saved.label || saved.targets.map(nameOf).join('、') };
      return true;
    } catch (e) { return false; }
  }

  function restart() {
    S.pathExpanded = false;
    S.session = null; S.demo = null;
    lsDel(sessionKey());
    history.replaceState(null, '', location.pathname + (S.subject !== 'math' ? '?subject=' + S.subject : ''));
    render();
  }

  function commit(result) {
    if (S.commitPending) return;                       // 防连点：上一次作答还没落定
    const item = E.nextItem(S.D.graph, S.session);
    if (!item) return;
    /* 答错 / 不会会向先修回溯，而引擎的 isTestable() 看的是「当时有没有题库」：
     * 题库按章节懒取，所以应用作答之前先把本题直接先修所在章节的题库取到
     * （同一章节只取一次；通常和本题同章 → 0 个新请求）。
     * 取不到（弱网 / 404）就按现有降级继续 —— 引擎跳过没题的先修，绝不静默变成 0 题空结果页。 */
    if (result === 'correct') { applyAnswerAndRender(item, result); return; }
    const pre = (S.D.graph.prereqs[item.topicId] || []).map(function (p) { return p.id; });
    if (!pre.length) { applyAnswerAndRender(item, result); return; }
    S.commitPending = true;
    ensureQuestionsForTopics(pre).then(function () {
      S.commitPending = false;
      applyAnswerAndRender(E.nextItem(S.D.graph, S.session) || item, result);
    });
  }

  /* 落定一次作答并按新图重绘（commit 的两条分支共用）。 */
  function applyAnswerAndRender(item, result) {
    S.session = E.applyAnswer(S.D.graph, S.session, item.topicId, result, { text: S.ui.answer });
    markSeen(item.question.id);
    resetUi();
    save();
    render();
  }

  function rebuild(answers, limit) {
    S.session = E.replay(S.D.graph, S.session.targets, answers, {
      mode: S.session.mode, limit: limit == null ? S.session.limit : limit, confirm: S.session.confirm,
      seed: S.session.seed, avoid: S.session.avoid
    });
    resetUi();
    save();
    render();
  }

  /* ------------------------------------------------------------ 演示模式 */
  // 演示用的“学生”：目标不会（错、错 -> 薄弱）；它的第一个可测先修也不会；再往前（或另一个先修）答错一次、第二题答对 -> 不稳；其余都会
  function makeOracle(targets, mode) {
    const G = S.D.graph;
    if (mode === 'screen') {
      // 整体筛查：按知识点序号，约 1/6 不会、1/6 不稳，其余都会（与 scripts/demo_grade.js 相同）
      return function (id, attempt) {
        const i = G.index[id];
        if (i % 6 === 0) return 'wrong';
        if (i % 6 === 3) return attempt === 1 ? 'wrong' : 'correct';
        return 'correct';
      };
    }
    const t0 = E.createSession(G, targets).stack[0];
    const testablePre = function (id) { return G.prereqs[id].filter(function (x) { return E.isTestable(G, x.id); }).map(function (x) { return x.id; }); };
    const weak = new Set([t0]);
    const shaky = new Set();
    const p = testablePre(t0);
    if (p.length) {
      const q = testablePre(p[0]);
      if (q.length) { weak.add(p[0]); shaky.add(q[0]); }
      else if (p.length > 1) { weak.add(p[0]); shaky.add(p[1]); }
      else shaky.add(p[0]);
    }
    return function (id, attempt) {
      if (weak.has(id)) return 'wrong';
      if (shaky.has(id)) return attempt === 1 ? 'wrong' : 'correct';
      return 'correct';
    };
  }

  function runDemo(steps) {
    let n = 0;
    while (n < steps) {
      const item = E.nextItem(S.D.graph, S.session);
      if (!item) break;
      S.session = E.applyAnswer(S.D.graph, S.session, item.topicId, S.demo.oracle(item.topicId, item.attempt));
      n++;
    }
  }

  /* ------------------------------------------------------------ 渲染入口 */
  function render() {
    if (S.pracLoading) { renderPracticeLoading(); return; }   // O3 LLM 变式加载中
    if (S.prac) { renderQuestion(pracItem()); return; }   // T3 练习模式
    if (!S.session) return renderStart();
    const item = E.nextItem(S.D.graph, S.session);
    if (item) return renderQuestion(item);
    /* 兜底：一题没答却说没题 —— 多半是题源还在路上（弱网题库 1.27MB、全量 265KB），
     * 绝不许把「0 已答题数 / 未测」的空结果页当成结论给孩子。 */
    if (!S.session.answers.length && !questionSourcesSettled()) {
      /* 挂起这次会话的参数，题源到货后由 resumePendingStart() 原地续上（深链/恢复会话也走这里） */
      S.pendingStart = {
        targets: S.session.targets, label: (S.sessionMeta && S.sessionMeta.label) || '',
        limit: S.session.limit || null, mode: S.session.mode || 'target'
      };
      return renderQuestionsPending();
    }
    renderResult();
  }

  /* 来自 route 的 session：页面顶上加一行「← 回到作业分析」。只动这一行，不动流程。 */
  function withRouteBack(page) {
    if (!routeReturnHref(location.search)) return page;
    const wrap = h('div');
    wrap.append(routeBackBar(), page);
    return wrap;
  }

  /* ------------------------------------------------------------ T3 练习模式 */
  function pracItem() {
    return { topicId: S.prac.topicId, question: S.prac.list[S.prac.idx], attempt: S.prac.idx + 1 };
  }
  function practicedMap() { const v = lsGet(LS_PRAC); return v && typeof v === 'object' ? v : {}; }
  function markPracticed(topicId) { const o = practicedMap(); o[topicId] = Date.now(); lsSet(LS_PRAC, o); }
  function variantSeqMap() { const v = lsGet(LS_VSEQ); return v && typeof v === 'object' ? v : {}; }

  /* ------------------------------------------------------------ 路径练习：关卡队列
   * 练习这一层自己筛：引擎的 path 里「未测」也在（学习路径本来就该包含它们），
   * 但没测过的点不知道会不会，练了是浪费，所以练习队列只取 status==='weak'。
   * 顺序沿用 path 的既有顺序（年级低→高、同年级先修在前）。纯函数，不读 DOM。 */
  function pathQueueFrom(sum) {
    return ((sum && sum.path) || []).filter(function (p) { return p && p.status === 'weak'; }).map(function (p) { return p.id; });
  }
  /* 关卡切换时的不变量：pracPath 只在「全部练完」和「学生主动退出」时置空；
   * 它不能跟着 resetUi() 一起被清（resetUi 只重置单题作答状态）。 */
  function pathPracticeExists() { return !!(S.pracPath && S.pracPath.queue && S.pracPath.queue.length); }

  function startPractice(topicId) {
    /* 题库按章节懒取：这个知识点所在章节的题库可能还没到货（结果页学习路径里的点就可能
     * 在别的章节）。先取一次（同一章节只发一个请求），取不到就明确说，不静默变空练习。 */
    var pt = S.D && S.D.graph ? S.D.graph.byId[topicId] : null;
    if (!pt || pt.external) { alert('这个知识点暂时没有练习题。'); return; }
    if (!(S.D.graph.bank[topicId] || []).length) {
      S.pracLoading = { topicId: topicId, bank: true };
      resetUi();
      render();
      ensureQuestionsForOne(topicId).then(function (ok) {
        S.pracLoading = null;
        if (!ok || !(S.D.graph.bank[topicId] || []).length) {
          if (typeof console !== 'undefined' && console.warn) {
            console.warn('[questions] 练习取题库失败', topicId, ok ? 'empty' : 'fetch');
          }
          alert('这个知识点的题库还没取到，请检查网络后重试。');
          render();
          return;
        }
        startPractice(topicId);
      });
      return;
    }
    /* 练习模块（variants.js + llm-* 三件）不在首屏链上：第一次点「练习」才按需加载。
     * 加载期间复用已有的「正在准备题目」页；失败明确告诉学生，不静默降级成空练习。 */
    if (!variantsMod()) {
      if (S.lazyFailed.variants) { alert('练习题组件没有加载出来，请刷新页面重试。'); return; }
      S.pracLoading = { topicId: topicId };
      resetUi();
      render();
      Browser.Lazy.load(LAZY_VARIANTS).then(function () {
        S.pracLoading = null;
        startPractice(topicId);
      }, function (err) {
        lazyFail('variants')(err);
        S.pracLoading = null;
        alert('练习题组件没有加载出来，请检查网络后重试。');
        render();
      });
      return;
    }
    var V = variantsMod();
    var LLMV = llmVariantsMod();
    var bankPicks = E.pickPracticeQuestions(S.D.graph, topicId, PRACTICE_N, seenList());
    var seqMap = variantSeqMap();
    var startIndex = seqMap[topicId] || 0;
    var bankPrompts = (S.D.graph.bank[topicId] || []).map(function (q) { return q.prompt; });

    /* §6.1 四层共存：题库新鲜题 → O1 确定性变式 → O3 LLM 变式 → 题库复用兜底 */
    var fp = V.fillPractice(bankPicks, topicId, PRACTICE_N, {
      doneIds: seenList(),
      avoidPrompts: bankPrompts,
      startIndex: startIndex
    });
    if (!fp.list.length) { alert('这个知识点暂时没有练习题。'); return; }

    /* O3 LLM 变式补位：O1 不够 3 道且 LLM supports 时，异步补位 */
    var llmGap = PRACTICE_N - fp.list.length;
    if (llmGap > 0 && LLMV && LLMV.supports(topicId)) {
      /* 先检查网关可达性（try 一次 /v1/models），不可达直接走降级，不拖慢页面 */
      S.pracLoading = { topicId: topicId };
      resetUi();
      render();

      LLMV.probeGateway().then(function (reachable) {
        if (!reachable) {
          /* 网关不可达：直接用 O1 结果，不阻塞 */
          S.pracLoading = null;
          _startPracticeRender(fp, topicId);
          return;
        }
        /* 网关可达：异步补位 LLM 变式 */
        LLMV.fillPracticeLLM(fp, topicId, llmGap, {
          doneIds: seenList(),
          avoidPrompts: bankPrompts.concat(fp.list.map(function (q) { return q.prompt; }))
        }).then(function (fp2) {
          S.pracLoading = null;
          _startPracticeRender(fp2, topicId);
        }).catch(function () {
          /* LLM 补位失败：降级用 O1 结果 */
          S.pracLoading = null;
          _startPracticeRender(fp, topicId);
        });
      });
    } else {
      _startPracticeRender(fp, topicId);
    }
  }
  function _startPracticeRender(fp, topicId) {
    S.prac = { topicId: topicId, list: fp.list, idx: 0, pact: [], usedVariants: fp.usedVariants, nextIndex: fp.nextIndex };
    S.pracResult = null;
    S.pracLoading = null;
    resetUi();
    render();
  }
  function renderPracticeLoading() {
    var t = S.D.graph.byId[S.pracLoading.topicId];
    root.textContent = '';
    root.append(h('div', { class: 'card' },
      h('div', { class: 'row' },
        h('span', { class: 'muted' }, (pathPracticeExists() ? '路径练习 · ' : '练习：') + (t ? t.name : '')),
        h('span', { class: 'grow' }),
        h('span', { class: 'muted' }, '正在准备题目…')),
      h('div', { class: 'progress' }, h('i', { style: 'width:30%' })),
      h('p', { style: 'margin:12px 0;color:#888' },
        S.pracLoading.bank ? '正在取这个知识点的题库（按章节，几 KB），请稍候…' : '正在向 AI 网关请求变式题，请稍候…')));
  }
  function practiceNext(result) {
    S.prac.pact.push(result);
    markSeen(S.prac.list[S.prac.idx].id);   // §6.4：练习题也记 seen，下次不重复
    S.prac.idx++;
    if (S.prac.idx >= S.prac.list.length) {
      const ok = S.prac.pact.filter(function (r) { return r === 'correct'; }).length;
      markPracticed(S.prac.topicId);
      if (S.prac.usedVariants > 0) {   // 存回变式序号，下次从新序号继续
        var seqMap = variantSeqMap();
        seqMap[S.prac.topicId] = S.prac.nextIndex;
        lsSet(LS_VSEQ, seqMap);
      }
      /* §6.3 统计变式总数 + LLM 变式数（variantSource==='llm'） */
      var llmCount = S.prac.list.filter(function (q) { return q.variantSource === 'llm'; }).length;
      S.pracResult = { topicId: S.prac.topicId, ok: ok, n: S.prac.pact.length, usedVariants: S.prac.usedVariants || 0, usedLLM: llmCount };
      S.prac = null;
      resetUi();
      if (pathPracticeExists()) { finishPathLevel(S.pracResult); return; }   // 路径练习：不直接回结果页，先给「过关」
      renderResult();   // 回到结果页
    } else {
      renderQuestion(pracItem());
    }
  }

  /* ------------------------------------------------------------ 路径练习：一关一关
   * 每关内部完全复用 startPractice（题库新鲜题 → O1 变式 → LLM 变式 → 兜底）。
   * 一关练完只**显示**「过关」和「下一关」按钮，学生点了才进下一关——不自动跳。
   * 练习不改变诊断结论（status 不动），markPracticed 仍只记时间戳。 */
  function nextPathTopic(fromIdx) {
    if (!pathPracticeExists()) return null;
    for (var i = fromIdx + 1; i < S.pracPath.queue.length; i++) {
      var id = S.pracPath.queue[i];
      if ((S.D.graph.bank[id] || []).length) return { idx: i, id: id };   // 没题的点跳过，别让「下一关」点不动
    }
    return null;
  }
  function startPathPractice() {
    if (!S.session) return;
    var queue = pathQueueFrom(E.summarize(S.D.graph, S.session));
    var first = null;
    for (var i = 0; i < queue.length && !first; i++) {
      if ((S.D.graph.bank[queue[i]] || []).length) first = { idx: i, id: queue[i] };
    }
    if (!first) return;
    S.pracPath = { queue: queue, idx: first.idx, results: [] };
    S.pracResult = null;
    startPractice(first.id);
  }
  function finishPathLevel(result) {
    if (!pathPracticeExists()) { renderResult(); return; }   // 状态被清（例如中途退出），退回结果页
    if (result) S.pracPath.results.push(result);
    var next = nextPathTopic(S.pracPath.idx);
    if (next) { renderPathPass(next); return; }
    S.pracPath = null;   // 全部练完：队列结束
    renderPathDone(result);
  }
  function pathLevelHead(title, topicId) {
    var n = S.pracPath.queue.length;
    return h('div', { class: 'row', id: 'path-level-head' },
      h('span', { class: 'muted' }, '路径练习 · 第 ' + (S.pracPath.idx + 1) + ' 关 / 共 ' + n + ' 关' + (topicId ? ' · ' + nameOf(topicId) : '')),
      h('span', { class: 'grow' }),
      h('span', { class: 'muted small', text: title }));
  }
  function pathResultLine(result) {
    var ok = result.ok, n = result.n;
    var good = ok === n;
    return h('div', { class: 'verdict ' + (good ? 'ok' : 'no'), id: 'path-level-verdict' },
      '这一关 ' + n + ' 题，答对 ' + ok + ' 题。' + (good ? '全对，练扎实了！' : '错的题可以在这个知识点的条目里用「为什么错了」再讲一遍。'));
  }
  function renderPathPass(next) {
    var r = S.pracPath.results[S.pracPath.results.length - 1];
    var card = h('div', { class: 'card', id: 'path-pass' },
      pathLevelHead('过关'),
      pathResultLine(r),
      h('p', { class: 'muted small' }, '练习只是巩固，不算掌握：下次进诊断，这个知识点仍然会被测。'),
      h('div', { class: 'row no-print', style: 'margin-top:12px' },
        h('button', { class: 'primary', id: 'btn-path-next-level', onclick: function () {
          S.pracPath.idx = next.idx;   // 先推进 index，再开下一关（startPractice 会沿用 pracPath）
          startPractice(next.id);
        } }, '下一关：' + nameOf(next.id)),
        h('button', { id: 'btn-path-quit', onclick: exitPathPractice }, '先歇一下，回结果页')));
    show(withRouteBack(card));
  }
  function renderPathDone(result) {
    var card = h('div', { class: 'card', id: 'path-done' },
      h('div', { class: 'row' },
        h('span', { class: 'muted' }, '路径练习 · 已练完'),
        h('span', { class: 'grow' })),
      h('div', { class: 'banner ok', style: 'margin-top:12px', id: 'path-done-banner' }, '路径上的 weak 都练过了'),
      result ? pathResultLine(result) : null,
      h('p', { class: 'muted small' }, '练习只是巩固，不算掌握：这里的每个知识点下次进诊断仍然会被测。'),
      h('div', { class: 'row no-print', style: 'margin-top:12px' },
        h('button', { class: 'primary', id: 'btn-path-back', onclick: function () { S.pracResult = null; renderResult(); } }, '回到结果页')));
    show(withRouteBack(card));
  }
  function exitPathPractice() {
    S.prac = null;
    S.pracPath = null;
    S.pracResult = null;
    resetUi();
    if (S.session) renderResult(); else render();
  }
  function finishAnswer(result) {
    if (S.prac) practiceNext(result);
    else commit(result);
  }
  function practiceResultBanner() {
    if (!S.pracResult) return null;
    const t = S.D.graph.byId[S.pracResult.topicId];
    const allRight = S.pracResult.ok === S.pracResult.n;
    const vCount = S.pracResult.usedVariants || 0;
    const llmCount = S.pracResult.usedLLM || 0;
    return h('div', { class: 'banner ' + (allRight ? 'ok' : ''), style: 'margin-bottom:12px' },
      '练习完成：' + (t ? t.name : '') + ' 共 ' + S.pracResult.n + ' 题，答对 ' + S.pracResult.ok + ' 题。' +
        (vCount > 0 ? '其中变式 ' + vCount + ' 道' + (llmCount > 0 ? '（含 LLM 变式 ' + llmCount + ' 道）' : '') + '。' : ''),
      allRight ? '这个知识点练扎实了！' : '错了的题可以点开下方条目，用「为什么错了」再讲一遍。');
  }

  /* ------------------------------------------------------------ 学习小结卡 */
  function adviceCard(sum) {
    const text = E.studentAdvice(sum, nameOf);
    const lines = text.split('\n');
    return h('div', { class: 'card', id: 'advice-summary' },
      h('h2', { text: '接下来练什么' }),
      lines.map(function (line) { return h('p', { style: 'margin:2px 0' }, line); }),
      h('p', { class: 'no-print', style: 'margin-top:8px' },
        h('button', { class: 'small', onclick: function (e) {
          copyText(text);
          const b = e.target;
          b.textContent = '已复制 ✓';
          setTimeout(function () { b.textContent = '复制小结'; }, 2000);
        } }, '复制小结')));
  }
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function () { fallbackCopy(text); });
    } else fallbackCopy(text);
  }
  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* 隐私模式等 */ }
    ta.remove();
  }

  /* ------------------------------------------------------------ 开始页 */
  function stageButton(value, label) {
    return h('button', {
      type: 'button',
      class: 'stage-tab' + (S.startStage === value ? ' on' : ''),
      role: 'tab',
      'aria-selected': S.startStage === value ? 'true' : 'false',
      onclick: function () { S.startStage = value; renderStart(); }
    }, label);
  }

  /* 学段按钮组：骨架（阶段 0）与真界面（阶段 1）共用，保证位置一致、不跳动。 */
  function stageTabs(disabled) {
    const mk = disabled
      ? function (value, label) { return h('button', { type: 'button', class: 'stage-tab', role: 'tab', 'aria-selected': 'false', disabled: 'disabled' }, label); }
      : stageButton;
    const list = S.subject === 'physics' ? [mk('', '全部'), mk('j', '初中'), mk('h', '高中')]
      : S.subject === 'history' || S.subject === 'geography' ? [mk('', '全部'), mk('j', '初中')]
      : S.subject === 'chinese' || S.subject === 'science' || S.subject === 'morality' ? [mk('', '全部'), mk('p', '小学')]
      : [mk('', '全部'), mk('p', '小学'), mk('j', '初中'), mk('h', '高中')];
    return h('div', { class: 'stage-tabs', role: 'tablist', 'aria-label': '学段' }, list);
  }

  /* 阶段 0（0ms，不等任何 fetch）：骨架。
   * 结构与 renderStart 的第一张卡片一致（同样顺序的 h1 / 状态行 / 学段按钮 / 搜索框 / 说明行），
   * 所以数据到货后原地替换不会跳版；不给转圈动画，用文字 + 骨架占位条告诉孩子「在装知识库」。 */
  function renderSkeleton() {
    if (!root) return;
    const page = h('div', null,
      h('div', { class: 'card', id: 'skeleton-card' },
        h('h1', { text: '选择诊断目标' }),
        h('p', { class: 'muted', id: 'skeleton-status', role: 'status' }, '正在载入知识库…'),
        stageTabs(true),
        h('input', {
          type: 'search', class: 'search-lg', id: 'search', placeholder: '正在载入…', autocomplete: 'off',
          'aria-label': '搜索知识点', disabled: 'disabled'
        }),
        h('p', { class: 'muted small', id: 'match-count' }),
        h('div', { class: 'skel', 'aria-hidden': 'true' },
          h('span', { class: 'skel-bar' }), h('span', { class: 'skel-bar' }), h('span', { class: 'skel-bar skel-short' })),
        h('p', { class: 'muted small' }, '知识点清单大约 60KB，弱网几秒；题目和说明在后台接着装，不影响你选。')));
    show(page);
  }

  /* 题源还在路上时的等待界面（阶段 2 中途）：文字 + 占位条，不用转圈；
   * 与骨架同布局（同一张 card、同样的 skel-bar），到货后原地换成题目页/结果页，不跳版。 */
  function renderQuestionsPending() {
    if (typeof document === 'undefined' || !root) return;
    show(h('div', null,
      h('div', { class: 'card', id: 'questions-pending' },
        h('h1', { text: '题目马上就到' }),
        h('p', { class: 'muted', id: 'questions-pending-status', role: 'status' }, '题目还在载入，稍等…'),
        h('div', { class: 'skel', 'aria-hidden': 'true' },
          h('span', { class: 'skel-bar' }), h('span', { class: 'skel-bar' }), h('span', { class: 'skel-bar skel-short' })),
        h('p', { class: 'muted small' }, '知识点清单已经到货，题目和说明在后台接着装；到货后这一页会自动换成第 1 题，不用点。'))));
  }

  /* 题源全部定案（都不在路上了）、但这些目标确实没有可问的题：给可操作的重试卡，不给空结果页。 */
  function renderNoQuestions(targets, label, limit, mode) {
    if (typeof document === 'undefined' || !root) return;
    show(h('div', null,
      h('div', { class: 'card', id: 'questions-unavailable' },
        h('h1', { text: '这个目标暂时没有题' }),
        h('p', { class: 'muted', role: 'status' }, '题库和知识库都到手了，但这个目标没有可问的题（可能是纯前置知识或未录入题目的知识点）。'),
        h('div', { class: 'row no-print' },
          h('button', { class: 'primary', id: 'btn-noq-retry', onclick: function () { startSession(targets, label, limit, mode); } }, '重新试试'),
          h('button', { id: 'btn-noq-back', onclick: function () { renderStart(); } }, '回选题页')))));
  }

  /* 两份题源都取失败（Pages 部署竞态 / 断网首访）：明确告诉孩子「没到」，给重试，不留白屏。 */
  function renderFlowBlocked(targets, mode, fn) {
    if (typeof document === 'undefined' || !root) return;
    show(h('div', null,
      h('div', { class: 'card', id: 'flow-blocked' },
        h('h1', { text: '数据没下来' }),
        h('p', { class: 'muted', id: 'flow-blocked-status', role: 'status' }, '题库和知识点说明都没能载入，可能是网络或站点正在更新。'),
        h('div', { class: 'skel', 'aria-hidden': 'true' },
          h('span', { class: 'skel-bar' }), h('span', { class: 'skel-bar skel-short' })),
        h('div', { class: 'row no-print' },
          h('button', { class: 'primary', id: 'btn-flow-retry', onclick: function () { withStage2(targets, mode, fn); } }, '重新试试'),
          h('button', { id: 'btn-flow-back', onclick: function () { renderStart(); } }, '回选题页')))));
  }

  function renderStart(errMsg) {
    S.startErr = errMsg || null;
    const page = h('div');
    const saved = lsGet(sessionKey());
    if (saved && saved.targets && S.D.graph.byId[saved.targets[0]]) {
      page.append(h('div', { class: 'banner' },
        h('b', { text: '有一份未清除的诊断：' }), saved.label || saved.targets.map(nameOf).join('、'),
        '（已答 ' + (saved.answers || []).length + ' 题）　',
        h('button', { class: 'primary', onclick: function () { withStage2(saved.targets, saved.mode, function () { restoreFromSave(saved); }); } }, '继续'),
        ' ', h('button', { onclick: function () { lsDel(sessionKey()); renderStart(); } }, '放弃存档')));
    }
    if (errMsg) page.append(h('p', { class: 'err', text: errMsg }));
    page.append(childBar('start'));
    const startBlind = blindStartCard();
    if (startBlind) page.append(startBlind);

    const st = getSettings();
    const limitInput = h('input', { type: 'number', min: LIMIT_MIN, max: LIMIT_MAX, step: 1, value: String(st.limit), id: 'limit-input', 'aria-label': '题量上限' });
    limitInput.addEventListener('change', function () {
      let v = parseInt(limitInput.value, 10);
      if (!(v >= LIMIT_MIN)) v = LIMIT_MIN;
      if (v > LIMIT_MAX) v = LIMIT_MAX;
      limitInput.value = String(v);
      setSetting('limit', v);
    });
    const confirmSelect = h('select', { id: 'confirm-select', 'aria-label': '每知识点确认题数' },
      E.CONFIRM_CHOICES.map(function (n) {
        return h('option', { value: String(n), selected: st.confirm === n }, String(n) + ' 题');
      }));
    confirmSelect.addEventListener('change', function () {
      const v = E.clampConfirm(confirmSelect.value);
      setSetting('confirm', v);
      renderStart();
    });
    const listBox = h('div', { id: 'target-list' });
    const browser = h('details', { class: 'chapter-browser', id: 'chapter-browser', open: S.chapterOpen || !!S.startQuery },
      h('summary', null, '按册、章浏览'),
      h('p', { class: 'muted small', text: '列表按年级、册、章折叠。想直接开始，用上面的搜索更快。' }),
      listBox);
    browser.addEventListener('toggle', function () { S.chapterOpen = browser.open; });
    const confirmHelp = '同一知识点连续答对 ' + st.confirm + ' 题（可在下方改成 2 / 3 / 5；题库更少时以题库为准）才算掌握；答错会再出一道同级或更容易的题——确认题也错才算薄弱并回溯先修，确认题答对则标为「不稳」。';
    page.append(h('div', { class: 'card' },
      h('h1', { text: '选择诊断目标' }),
      h('p', { class: 'muted' }, S.subject === 'physics'
        ? '选一个想学会或想检查的物理知识点。' + confirmHelp
        : S.subject === 'english'
        ? '选一个想学会或想检查的英语知识点。' + confirmHelp
        : S.subject === 'chinese'
        ? '选一个想学会或想检查的语文知识点。' + confirmHelp
        : S.subject === 'science'
        ? '选一个想学会或想检查的科学知识点。' + confirmHelp
        : S.subject === 'morality'
        ? '选一个想学会或想检查的道德与法治知识点。' + confirmHelp
        : S.subject === 'history'
        ? '选一个想学会或想检查的历史知识点。' + confirmHelp
        : S.subject === 'geography'
        ? '选一个想学会或想检查的地理知识点。' + confirmHelp
        : '选一个想学会或想检查的知识点。' + confirmHelp),
      stageTabs(false),
      h('input', {
        type: 'search', class: 'search-lg', id: 'search',
        placeholder: S.subject === 'physics' ? '搜索知识点，例如：欧姆定律、浮力、牛顿第二定律、楞次定律' : S.subject === 'english' ? '搜索知识点，例如：现在进行时、虚拟语气、there is' : S.subject === 'chinese' ? '搜索知识点，例如：声母、静夜思、的地得' : S.subject === 'science' ? '搜索知识点，例如：溶解、电路、昼夜交替' : S.subject === 'morality' ? '搜索知识点，例如：升国旗、排队、宪法、节约用水' : S.subject === 'history' ? '搜索知识点，例如：鸦片战争、丝绸之路、五四运动' : S.subject === 'geography' ? '搜索知识点，例如：经纬网、季风气候、长江' : '搜索知识点，例如：配方法、20 以内加法、一次函数',
        value: S.startQuery, autocomplete: 'off', 'aria-label': '搜索知识点',
        oninput: function (e) {
          S.startQuery = e.target.value;
          fillList(listBox);
          if (S.startQuery.trim()) { browser.open = true; S.chapterOpen = true; }
        }
      }),
      h('p', { class: 'muted small', id: 'match-count' }),
      h('p', { class: 'muted small', id: 'stage2-status', role: 'status' }),
      h('div', { class: 'row' },
        h('label', null, '单点 / 整章题量上限（' + LIMIT_MIN + '–' + LIMIT_MAX + '）', limitInput),
        h('label', null, '每知识点确认题数', confirmSelect),
        h('span', { class: 'muted small' }, '连续答对这么多题才判掌握；中途答错会再出一道确认题。到上限后，没测到的标为「未测」。'))));
    page.append(gradeCard());
    page.append(h('div', { class: 'card' }, browser));
    page.append(h('p', { class: 'muted small' },
      '可以诊断的知识点：' + S.D.topics.length + ' 个。进度和出过的题只保存在这台浏览器里。'));
    show(withRouteBack(page));
    fillList(listBox);
    if (S.startQuery) { const el = document.getElementById('search'); if (el) el.focus(); }
  }

  function seniorGrade(sel) {
    return sel === '高一' || sel === '高二' || String(sel).indexOf('选必') === 0 || String(sel).indexOf('必修') === 0;
  }
  function seniorRangeLabel(sel) { return String(sel).indexOf('选必') === 0 ? '整册' : '必修整册'; }
  function gradeScope() {
    if (seniorGrade(S.gradeSel)) return S.gradeSel;
    if (S.subject === 'physics' && S.gradeSel === '九') return '九全';
    if (S.subject === 'english' && S.gradeSel === '九') return S.volSel === '上' ? '九上' : (S.volSel === '全' ? '九全' : '九年级');
    return S.gradeSel + (S.volSel ? S.volSel : '年级');
  }

  function gradeCard() {
    const box = h('div', { class: 'card', id: 'grade-card' });
    const fill = function () {
      while (box.firstChild) box.removeChild(box.firstChild);
      const g = E.gradeTargets(S.D.graph, gradeScope(), S.subject);
      const tabs = function (label, items, current, set) {
        return h('div', { class: 'stage-tabs', role: 'tablist', 'aria-label': label }, items.map(function (it) {
          return h('button', {
            type: 'button', class: 'stage-tab' + (current === it[0] ? ' on' : ''), role: 'tab',
            'aria-selected': current === it[0] ? 'true' : 'false', 'data-value': it[0],
            onclick: function () { set(it[0]); fill(); }
          }, it[1]);
        }));
      };
      const limitInput = h('input', {
        type: 'number', min: SCREEN_MIN, max: SCREEN_MAX, step: 1, value: String(getSettings().screenLimit), id: 'screen-limit-input', 'aria-label': '整体诊断题量上限'
      });
      limitInput.addEventListener('change', function () {
        let v = parseInt(limitInput.value, 10);
        if (!(v >= SCREEN_MIN)) v = SCREEN_MIN;
        if (v > SCREEN_MAX) v = SCREEN_MAX;
        limitInput.value = String(v);
        setSetting('screenLimit', v);
      });
      box.append(
        h('h2', { text: '按年级整体诊断' }),
        h('p', { class: 'muted' }, '本测评检查本年级知识点是否掌握，不是竞赛拔高。按「基础 / 提高 / 拓展」出题：先出提高题，答对再出拓展题确认掌握；答错会先补基础题，仍错会回到前面年级的相关知识点。每个知识点连续答对 ' + getSettings().confirm + ' 题才算掌握（可在上方改），最后按章汇总出哪几章薄弱。适合期初摸底、学期末复习。'),
        tabs('年级', S.subject === 'physics'
          ? [['八', '八年级'], ['九', '九年级'], ['必修一', '必修一'], ['必修二', '必修二'], ['必修三', '必修三'],
            ['选必一', '选必一'], ['选必二', '选必二'], ['选必三', '选必三']]
          : S.subject === 'english'
          ? '三四五六七八九'.split('').map(function (x) { return [x, x + '年级']; }).concat([
            ['必修一', '必修一'], ['必修二', '必修二'], ['必修三', '必修三'],
            ['选必一', '选必一'], ['选必二', '选必二'], ['选必三', '选必三'], ['选必四', '选必四']
          ])
          : S.subject === 'history'
          ? '七八九'.split('').map(function (x) { return [x, x + '年级']; })
          : S.subject === 'geography'
          ? '七八'.split('').map(function (x) { return [x, x + '年级']; })
          : S.subject === 'chinese' || S.subject === 'science' || S.subject === 'morality'
          ? '一二三四五六'.split('').map(function (x) { return [x, x + '年级']; })
          : GRADES.map(function (x) { return [x, x + '年级']; }).concat([
            ['高一', '高一'], ['高二', '高二'], ['选必一', '选必一'], ['选必二', '选必二'], ['选必三', '选必三']
          ]), S.gradeSel, function (v) {
          S.gradeSel = v;
          if (seniorGrade(v)) S.volSel = '';
          else if (S.subject === 'physics' && v === '九') S.volSel = '全';
          else if (S.subject === 'english' && v === '九') S.volSel = '';
          else if (S.volSel === '全') S.volSel = '';
        }),
        h('div', { style: 'margin-top:8px' }),
        seniorGrade(S.gradeSel)
          ? tabs('范围', [['', seniorRangeLabel(S.gradeSel)]], '', function () { S.volSel = ''; })
          : (S.subject === 'physics' && S.gradeSel === '九')
            ? tabs('范围', [['全', '全一册']], '全', function () { S.volSel = '全'; })
          : (S.subject === 'english' && S.gradeSel === '九')
            ? tabs('范围', [['', '整年级'], ['上', '上册（新版）'], ['全', '全一册（旧版，九下暂用）']], S.volSel, function (v) { S.volSel = v; })
            : tabs('范围', [['', '整年级'], ['上', '上册'], ['下', '下册']], S.volSel, function (v) { S.volSel = v; }),
        h('p', { class: 'muted', id: 'grade-info' }, g ? g.label + '：' + g.ids.length + ' 个知识点。' : '这个范围没有知识点。'),
        h('div', { class: 'row' },
          h('label', null, '题量上限（' + SCREEN_MIN + '–' + SCREEN_MAX + '）', limitInput),
          h('button', {
            class: 'primary', id: 'btn-grade-start', disabled: !g,
            onclick: function () { if (g) withStage2(g.ids, 'screen', function () { startSession(g.ids, g.label + '（整体筛查）', null, 'screen'); }); }
          }, '开始整体诊断')),
        h('p', { class: 'muted small' }, '知识点多、题量有限，到上限后没测到的标为「未测」；结果页可以再加题。默认 ' + E.SCREEN_LIMIT + ' 题。'));
    };
    fill();
    return box;
  }

  function fillList(box) {
    while (box.firstChild) box.removeChild(box.firstChild);
    const q = S.startQuery.trim().toLowerCase();
    let shown = 0;
    function volumeStage(key) {
      if (key === '高一' || key === '高二' || key.indexOf('选必') === 0 || key.indexOf('必修') === 0) return 'h';
      if ('一二三四五六'.indexOf(key.charAt(0)) >= 0) return 'p';
      return 'j';
    }
    VOLUMES.forEach(function (vv) {
      if (S.startStage && volumeStage(vv[0]) !== S.startStage) return;
      const v = S.D.tree[vv[0]];
      if (!v) return;
      const chapters = [];
      v.chapters.forEach(function (ch) {
        const chHit = q && ch.label.toLowerCase().indexOf(q) >= 0;
        const rows = ch.topics.filter(function (x) {
          if (!q || chHit) return true;
          return (x.t.name + ' ' + (x.t.description || '') + ' ' + x.t.chapter).toLowerCase().indexOf(q) >= 0;
        });
        if (rows.length) chapters.push({ ch: ch, rows: rows });
      });
      if (!chapters.length) return;
      const count = chapters.reduce(function (n, c) { return n + c.rows.length; }, 0);
      shown += count;
      const openVol = S.subject === 'physics' ? '八上' : S.subject === 'english' ? '三上' : S.subject === 'history' || S.subject === 'geography' ? '七上' : '一上';
      const seniorOpen = S.subject === 'english' || S.subject === 'physics' ? '必修一' : '高一';
      const det = h('details', { class: 'vol', open: !!q || (S.startStage === 'j' ? vv[0] === '七上' : S.startStage === 'h' ? vv[0] === seniorOpen : vv[0] === openVol) },
        h('summary', null, vv[1] + '（' + count + ' 个知识点）'));
      chapters.forEach(function (c) {
        const ch = c.ch;
        det.append(h('div', { class: 'chap' },
          h('div', { class: 'chap-head' },
            h('span', { class: 't', text: ch.label }),
            h('button', {
              class: 'primary', title: '把本章全部 ' + ch.topics.length + ' 个知识点一起作为目标',
              onclick: function () { withStage2(ch.topics.map(function (x) { return x.t.id; }), 'target', function () { startSession(ch.topics.map(function (x) { return x.t.id; }), ch.volume + ' ' + ch.label + '（整章）'); }); }
            }, '以整章为目标')),
          c.rows.map(function (x) {
            return h('div', { class: 'topic-row', title: x.t.description },
              h('span', { class: 'nm', text: x.t.name }),
              h('span', { class: 'sec', text: x.section }),
              h('button', { onclick: function () { withStage2([x.t.id], 'target', function () { startSession([x.t.id], x.t.name); }); } }, '选为目标'));
          })));
      });
      box.append(det);
    });
    if (!shown) box.append(h('p', { class: 'muted', text: '没有匹配的知识点。' }));
    const mc = document.getElementById('match-count');
    if (mc) mc.textContent = (q ? '找到 ' : '册章列表里有 ') + shown + ' 个知识点';
    const browser = document.getElementById('chapter-browser');
    if (browser && q) browser.open = true;
  }

  /* ------------------------------------------------------------ 出题页 */
  function targetMinGrade() {
    let m = Infinity;
    (S.session.targets || []).forEach(function (tid) {
      const x = S.D.graph.byId[tid];
      if (x && typeof x.grade === 'number' && x.grade < m) m = x.grade;
    });
    return m;
  }
  function isPrereqKnowledge(id) {
    const t = S.D.graph.byId[id];
    if (!t || !S.session || (S.session.targets || []).indexOf(id) >= 0) return false;
    return typeof t.grade === 'number' && t.grade < targetMinGrade();
  }
  function reasonFor(item) {
    const id = item.topicId;
    const need = E.needConfirm(S.D.graph, S.session, id);
    const prev = S.session.attempts[id] || [];
    const hadFail = prev.some(function (a) { return a.result !== 'correct'; });
    const diff = item.question && item.question.difficulty;
    if (isPrereqKnowledge(id)) {
      return '这是前面年级的前置知识：因为本年级相关知识点还没过关，先回来检查它。';
    }
    if (hadFail) return '前面有题没答对，再出一道' + (diff === 'basic' ? '基础' : '同级或更容易') + '的题确认：这一题也错才算薄弱，答对则标为「不稳」。';
    if (item.attempt > 1) {
      if (diff === 'challenge' || diff === 'advanced') {
        return '上一题已答对，再出一道拓展题确认掌握（当前第 ' + item.attempt + ' 题，连续答对 ' + need + ' 题才算掌握）。';
      }
      return '同一知识点需连续答对 ' + need + ' 题才算掌握（当前第 ' + item.attempt + ' 题）。';
    }
    for (let i = S.session.answers.length - 1; i >= 0; i--) {
      const a = S.session.answers[i];
      if (a.result === 'correct') continue;
      const p = S.D.graph.prereqs[a.id].find(function (x) { return x.id === id; });
      if (p && E.statusOf(S.session, a.id) === 'weak') return '因为「' + nameOf(a.id) + '」确认后仍没通过，现在检查它的' + (p.strength === 'hard' ? '硬' : '软') + '先修知识点。';
    }
    if (S.session.mode === 'screen') return '整体诊断：先测本年级知识点（离章末近的先测）。先出提高题，答对再出拓展题确认；答错先补基础题。';
    if (S.session.targets.length > 1) return '这是所选章节的知识点（离章末最近的先测，连续答对会连带跳过它的先修）。';
    return S.session.targets.indexOf(id) >= 0 ? '这是你选择的目标知识点，先从它开始测（连续答对 ' + need + ' 题才算掌握）。' : '检查目标的先修知识点。';
  }

  function judgeAndGo(item) {
    const q = item.question;
    const val = S.ui.answer.trim();
    if (!val) { const el = document.getElementById('ans'); if (el) el.focus(); return; }
    const r = E.judgeQuestion(q, val);
    S.ui.verdict = r;
    S.ui.phase = r.verdict === 'manual' ? 'self' : 'auto';
    renderQuestion(item);
  }

  function answerText(q) {
    if (q.type === 'choice') {
      const c = (q.choices || []).find(function (x) { return x.key === q.answer; });
      return q.answer + (c ? '. ' + c.text : '');
    }
    return q.answer;
  }

  function feedbackBlock(q) {
    return h('div', { class: 'feedback' },
      h('div', { class: 'refans' }, h('b', null, '参考答案：'), answerText(q)),
      q.explanation ? h('div', { class: 'explain', id: 'explain' }, h('b', null, '解析：'), q.explanation) : null);
  }

  /* 正确答案的 key。题库统计（全量 3854 道选择题）：answer 100% 是单字母且必在 choices[].key 内，
   * 所以平常原样返回；只有 answer 不是字符串（历史脏数据 / 别的题型混进来）才做首字母兜底，
   * 兜底也落不到任何选项时返回 null —— 调用方据此不做高亮，绝不猜。 */
  function answerKeys(q) {
    const raw = q && q.answer;
    if (typeof raw === 'string') return raw;
    if (raw == null) return null;
    const m = String(raw).trim().toUpperCase().match(/^[A-Z]/);
    return m ? m[0] : null;
  }

  /* 选项块。ask 态可点（button + onclick）；其余 phase 一律只读：
   *   - 用 div 而不是 disabled button —— 键盘 Tab 不会停在讲解态的选项上，读屏仍能读到文字
   *   - 正确项加 .choice-correct（绿），学生选错的项加 .choice-picked-wrong（红）
   *   - 学生答对时只标 .choice-picked（与 ask 态同一个 picked 蓝框，配上绿底＝「选对了」）
   * opts: { item, readonly, correctKey, pickedKey } */
  function choicesBlock(q, opts) {
    const o = opts || {};
    const ro = !!o.readonly;
    const correctKey = o.correctKey == null ? null : o.correctKey;
    const pickedKey = o.pickedKey == null ? null : o.pickedKey;
    return h('div', { class: 'choices' + (q.hideChoiceText ? ' fig-icons' : ''), id: 'choices' }, (q.choices || []).map(function (c) {
      const hideName = !!(q.hideChoiceText && c.figure);
      const kids = [h('b', { class: 'choice-key', text: hideName ? c.key : (c.key + '.') })];
      if (!hideName) kids.push(document.createTextNode(' ' + c.text));
      const fig = c.figure ? figureEl(c.figure) : null;
      if (fig) kids.push(fig);
      const isPicked = pickedKey != null && c.key === pickedKey;
      const isCorrect = correctKey != null && c.key === correctKey;
      const figCls = c.figure ? ' fig-choice' : '';
      const aria = hideName ? ('选项 ' + c.key) : null;
      if (!ro) {
        return h('button', {
          class: 'choice' + figCls + (isPicked ? ' picked' : ''),
          id: 'choice-' + c.key, 'data-key': c.key,
          'aria-label': aria,
          onclick: function () { S.ui.picked = c.key; S.ui.answer = c.key; renderQuestion(o.item); }
        }, kids);
      }
      return h('div', {
        class: 'choice choice-ro' + figCls + (isCorrect ? ' choice-correct' : '') +
          (isPicked ? (isCorrect ? ' choice-picked' : ' choice-picked-wrong') : ''),
        id: 'choice-' + c.key, 'data-key': c.key, role: 'text',
        'aria-label': aria,
        'aria-disabled': 'true'
      }, kids);
    }));
  }

  /* 非选择题在讲解/判定后的答案回显：一行文字，不重建输入框。
   * 学生没答过（「不会」跳过）时不显示「你的答案」那半句。
   * showRef=false 用于讲解阶段（explain）：那时答案还在折叠块里，这里印出来
   * 等于把 G 卡的折叠意义整个架空（学生不用点开就知道答案）。 */
  function answerEcho(q, pickedKey, showRef) {
    const mine = pickedKey == null ? '' : String(pickedKey);
    const kids = [];
    if (mine.trim()) kids.push(h('span', { class: 'echo-mine' }, h('b', null, '你的答案：'), mine));
    if (showRef !== false) kids.push(h('span', { class: 'echo-ref' }, h('b', null, '正确答案：'), answerText(q)));
    if (!kids.length) return null;
    return h('div', { class: 'answer-echo', id: 'answer-echo' }, kids);
  }

  function renderQuestion(item) {
    /* 面板每次重建都会重新挂画板：先销毁上一块几何画板（断开 ResizeObserver + 摘掉画布），
     * 否则来回翻步骤会累积画布与观察者（funclab 靠 DOM 替换回收，geomlab 显式销毁更稳）。 */
    try { if (window.Geomlab && window.Geomlab.destroy) window.Geomlab.destroy(); } catch (e) { /* 不影响渲染 */ }
    const id = item.topicId;
    const q = item.question;
    const t = S.D.graph.byId[id];
    const pr = !!S.prac;   // T3 练习模式
    const key = id + '#' + item.attempt;
    if (S.ui.key !== key) S.ui = { key: key, phase: 'ask', answer: '', verdict: null, picked: null, explainStep: 0, aiSteps: null, aiState: 'idle', aiRequested: false, askHistory: [], askPending: false, askScroll: false, labCfg: null, labDesc: null, labAsk: null, labAskMsg: null };
    const n = pr ? S.prac.idx : S.session.answers.length;
    const card = h('div', { class: 'card' });
    const onPath = pr && pathPracticeExists();
    card.append(
      h('div', { class: 'row', id: onPath ? 'path-level-head' : null },
        h('span', { class: 'muted' }, pr
          ? (onPath ? '路径练习 · 第 ' + (S.pracPath.idx + 1) + ' 关 / 共 ' + S.pracPath.queue.length + ' 关 · ' + t.name : '练习：' + t.name)
          : '目标：' + S.sessionMeta.label),
        h('span', { class: 'grow' }),
        h('span', { class: 'muted' }, pr ? '第 ' + (S.prac.idx + 1) + ' 题 / 共 ' + S.prac.list.length + ' 题' : '第 ' + (n + 1) + ' 题 / 上限 ' + S.session.limit)),
      h('div', { class: 'progress' }, h('i', { style: 'width:' + (pr ? Math.round((S.prac.idx + 1) / S.prac.list.length * 100) : Math.round(n / S.session.limit * 100)) + '%' })),
      h('h2', { class: 'q-title' }, t.name, ' ', h('span', { class: 'tag', text: t.chapter })),
      h('div', { class: 'row small', style: 'margin:2px 0' },
        isPrereqKnowledge(id) ? h('span', { class: 'tag ext', text: '前置知识' }) : null,
        h('span', { class: 'tag diff-' + q.difficulty, text: DIFF_LABEL[q.difficulty] || q.difficulty }),
        h('span', { class: 'tag', text: TYPE_LABEL[q.type] || q.type }),
        h('span', { class: 'tag', text: pr ? '练习第 ' + (S.prac.idx + 1) + ' 题' : '本知识点第 ' + item.attempt + ' / ' + E.needConfirm(S.D.graph, S.session, id) + ' 题' }),
        q.variant ? h('span', { class: 'tag', text: q.variantSource === 'llm' ? 'LLM变式' : '变式' }) : null),
      h('div', { class: 'reason', text: pr ? '针对性练习（不进诊断结果）。做完自动判定对错，答错可以点「为什么错了」看讲解。' : reasonFor(item) }),
      h('div', { class: 'q-text', id: 'q-text', text: q.prompt }));
    const stemFig = figureEl(q.figure);
    if (stemFig) {
      const qt = card.querySelector('#q-text');
      if (qt) qt.insertAdjacentElement('afterend', stemFig);
    }

    if (S.ui.phase === 'ask') {
      if (q.type === 'choice') {
        card.append(choicesBlock(q, { item: item, readonly: false, pickedKey: S.ui.picked }));
      } else if (q.type === 'self') {
        card.append(h('textarea', {
          class: 'ans-input', id: 'ans', rows: 3, placeholder: '开放题：可以写下自己的思路（不会自动判分），再点「看参考答案并自评」', value: S.ui.answer,
          oninput: function (e) { S.ui.answer = e.target.value; }
        }));
      } else {
        card.append(h('input', {
          type: 'text', class: 'ans-input', id: 'ans', autocomplete: 'off', placeholder: '在这里输入答案（数字、分数、多个答案用逗号或“和”分开）', value: S.ui.answer,
          oninput: function (e) { S.ui.answer = e.target.value; },
          onkeydown: function (e) { if (e.key === 'Enter' && !e.isComposing) judgeAndGo(item); }
        }));
      }
      card.append(h('div', { class: 'row', style: 'margin-top:10px' },
        q.type === 'self' ? null : h('button', { class: 'primary', id: 'btn-submit', onclick: function () { judgeAndGo(item); } }, '提交答案'),
        q.type === 'choice' ? null : h('button', { id: 'btn-peek', onclick: function () { S.ui.phase = 'self'; S.ui.verdict = null; renderQuestion(item); } }, '看参考答案并自评'),
        h('button', { id: 'btn-skip', onclick: function () { S.ui.phase = 'explain'; S.ui.explainStep = 0; S.ui.aiSteps = null; S.ui.aiState = 'idle'; S.ui.aiRequested = false; renderQuestion(item); } }, '不会')));
    } else if (S.ui.phase === 'auto') {
      const ok = S.ui.verdict.verdict === 'correct';
      card.append(
        q.type === 'choice'
          ? choicesBlock(q, { item: item, readonly: true, correctKey: answerKeys(q), pickedKey: S.ui.answer })
          : answerEcho(q, S.ui.answer),
        h('div', { class: 'verdict ' + (ok ? 'ok' : 'no') }, ok ? '自动判定：正确' : '自动判定：不正确'),
        feedbackBlock(q),
        h('div', { class: 'row' },
          ok ? null : h('button', { class: 'primary', id: 'btn-explain', onclick: function () { S.ui.phase = 'explain'; S.ui.explainStep = 0; S.ui.aiSteps = null; S.ui.aiState = 'idle'; S.ui.aiRequested = false; renderQuestion(item); } }, '为什么错了？一起想想'),
          h('button', { class: 'primary', id: 'btn-next', onclick: function () { finishAnswer(ok ? 'correct' : 'wrong'); } }, '下一题'),
          h('button', { id: 'btn-flip', onclick: function () { finishAnswer(ok ? 'wrong' : 'correct'); } }, ok ? '判错了，我其实没做对' : '判错了，我其实做对了'),
          h('button', { onclick: function () { S.ui.phase = 'ask'; renderQuestion(item); } }, '重新作答')));
    } else if (S.ui.phase === 'explain') {
      /* 讲解三步（第 1/2/3 步）都保留原题选项/答案，但只读：
       * 学生能对照解析看题，却不能边看答案边改答案。选项块挂在 explainPanel 之前，
       * 折叠块与画板都在 explainPanel 内部，不受影响。 */
      if (q.type === 'choice') {
        card.append(choicesBlock(q, { item: item, readonly: true, correctKey: null, pickedKey: S.ui.answer }));
      } else {
        /* 用自定义 append：学生「不会」进来时 ui.answer 是空的，answerEcho(…, false) 会返回 null，
         * 原生 card.append(null) 会把 null 字符串化插成一个文本节点（讲解首屏题目下面那行 "null"）。 */
        append(card, answerEcho(q, S.ui.answer, false));
      }
      card.append(explainPanel(item));
    } else if (S.ui.phase === 'skip') {
      card.append(
        h('div', { class: 'muted' }, '你选择了「不会」。看一下答案和解析再继续：'),
        q.type === 'choice'
          ? choicesBlock(q, { item: item, readonly: true, correctKey: answerKeys(q), pickedKey: null })
          : answerEcho(q, null),
        feedbackBlock(q),
        h('div', { class: 'row' }, h('button', { class: 'primary', id: 'btn-next', onclick: function () { finishAnswer('skip'); } }, '下一题')));
    } else {
      /* 原生 card.append 会把三目里的 null 字符串化成文本节点（self 阶段、ui.verdict 还空时）。
       * 自定义 append(el, c) 只吃一个子节点，兄弟节点要放进数组里传；它天生跳过 null。 */
      append(card, [
        q.type === 'choice'
          ? choicesBlock(q, { item: item, readonly: true, correctKey: answerKeys(q), pickedKey: S.ui.answer })
          : answerEcho(q, S.ui.answer),
        q.type === 'self' ? h('div', { class: 'muted' }, '开放题：请对照参考答案自己判断。')
          : (S.ui.verdict ? h('div', { class: 'muted' }, '这道题的答案无法被自动可靠地判定，请对照参考答案自己判断。') : null),
        feedbackBlock(q),
        h('div', { class: 'row' },
          h('button', { class: 'good', id: 'btn-right', onclick: function () { finishAnswer('correct'); } }, '对（我做对了）'),
          h('button', { class: 'bad', id: 'btn-wrong', onclick: function () { S.ui.phase = 'explain'; S.ui.explainStep = 0; S.ui.aiSteps = null; S.ui.aiState = 'idle'; S.ui.aiRequested = false; renderQuestion(item); } }, '不对'),
          h('button', { id: 'btn-skip2', onclick: function () { S.ui.phase = 'explain'; S.ui.explainStep = 0; S.ui.aiSteps = null; S.ui.aiState = 'idle'; S.ui.aiRequested = false; renderQuestion(item); } }, '不会'))]);
    }

    card.append(h('div', { class: 'notice' }, '提示：自动判题只是近似的（数字、分数、多个答案会做规范化后比较），一切以参考答案为准；判错了可以手动更正。'));
    card.append(h('div', { class: 'row no-print', style: 'margin-top:12px' },
      pr ? h('button', { class: 'small', id: 'btn-prac-exit', onclick: function () {
        if (pathPracticeExists()) exitPathPractice();   // 路径练习：向学生明确「关掉整条路径」
        else { S.prac = null; S.pracResult = null; resetUi(); render(); }
      } }, pathPracticeExists() ? '退出路径练习' : '退出练习')
        : h('button', { class: 'small', onclick: function () { if (confirm('确定放弃当前诊断并回到开始页吗？')) restart(); } }, '重新开始')));
    const page = h('div');
    if (S.demo) page.append(demoBanner());
    page.append(childBar('question'));
    page.append(card);
    show(withRouteBack(page));
    // 必须放在 show() 之后：show() 内有 window.scrollTo(0,0) 会把页面拉回顶部，且此时节点还没进 document，提前调用 scrollIntoView 无效。
    if (S.ui.askScroll) {
      const items = page.querySelectorAll('.ask-item');
      const last = items.length ? items[items.length - 1] : null;
      if (last) last.scrollIntoView({ block: 'start' });
      S.ui.askScroll = false;   // 用完即清：只有「刚提问」「刚答完」这两次渲染滚动，历史气泡/翻步骤/切题一律不滚
    }
    const inp = document.getElementById('ans');
    if (inp && inp.setSelectionRange && inp.tagName === 'INPUT') { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
    else if (inp) inp.focus();
  }

  /* ------------------------------------------------------------ 苏格拉底讲解面板（T2：静态即时 + LLM 渐进增强） */
  let explainTick = 0;   // 竞态令牌：只接受最后一次请求的结果
  function explainPanel(item) {
    const id = item.topicId;
    const q = item.question;
    const t = S.D.graph.byId[id];
    const steps = (S.ui.aiSteps && S.ui.aiSteps.length === 3) ? S.ui.aiSteps : E.socraticSteps(t, q);
    const show = S.ui.explainStep || 0;      // 0=prompt 1=hint 2=reveal
    /* 讲解模块（explain.js）不在首屏链上：第一次进讲解面板才加载，到货后重渲染一次。
     * 没到货时下面用 window.Explain 守卫，先显示静态三步讲解 —— 学生看不到空白。 */
    if (!window.Explain && !S.lazyFailed.explain) {
      Lazy.load(LAZY_EXPLAIN).then(function () { renderQuestion(item); }, lazyFail('explain'));
    }
    if (window.Explain && S.ui.aiState === 'idle' && !S.ui.aiRequested) {
      S.ui.aiRequested = true;
      S.ui.aiState = 'loading';
      const tick = ++explainTick;
      window.Explain.generate(t, q, S.ui.answer, S.ui.labDesc || null).then(function (res) {
        if (tick !== explainTick || !S.ui || S.ui.phase !== 'explain') return;
        if (res.from === 'llm') { S.ui.aiSteps = res.steps; S.ui.aiState = 'done'; }
        else { S.ui.aiSteps = null; S.ui.aiState = 'static'; }   // 网关挂了，保持静态模板
        renderQuestion(item);
      });
    }
    const aiTag = (S.ui.aiSteps && S.ui.aiSteps.length === 3)
      ? h('span', { class: 'ai-tag' }, 'AI 讲解')
      : h('span', { class: 'ai-tag static' }, S.ui.aiState === 'loading' ? 'AI 正在生成…' : '基础讲解');
    const box = h('div', { class: 'socratic' },
      h('div', { class: 'soc-head' },
        h('h3', null, '苏格拉底引导：我们一起想'), aiTag),
      h('div', { class: 'soc-step muted' },
        show === 0 ? '第 1 步 · 想一想（先别看答案）'
          : show === 1 ? '第 2 步 · 提示（还差一点点）'
            : '第 3 步 · 完整解析'));
    if (show === 0) {
      box.append(h('div', { class: 'q-text' }, steps[0].text));
      box.append(h('div', { class: 'row' },
        h('button', { class: 'good', id: 'btn-soc-got', onclick: function () {
          S.ui.phase = 'ask'; S.ui.answer = ''; S.ui.explainStep = 0; renderQuestion(item);
        } }, '我想出来了，重新做一遍'),
        h('button', { id: 'btn-soc-hint', onclick: function () { S.ui.explainStep = 1; renderQuestion(item); } }, '还是卡住，给我一点提示'),
        h('button', { class: 'small muted', onclick: function () { S.ui.explainStep = 2; renderQuestion(item); } }, '直接看答案')));
    } else if (show === 1) {
      box.append(h('div', { class: 'explain' }, steps[1].text));
      box.append(h('div', { class: 'row' },
        h('button', { id: 'btn-soc-reveal', onclick: function () { S.ui.explainStep = 2; renderQuestion(item); } }, '还是不会，看完整解析'),
        h('button', { class: 'good', onclick: function () {
          S.ui.phase = 'ask'; S.ui.answer = ''; S.ui.explainStep = 0; renderQuestion(item);
        } }, '我明白了，重新做一遍')));
    } else {
      box.append(h('details', { class: 'explain-fold' },
        h('summary', null, '看完整解析（自己想清楚再打开）'),
        h('div', { class: 'explain' }, steps[2].text)));
      /* 函数实验室：配方法/二次函数类题，reveal 时挂可拖拽画板，直观理解几何意义。
       * M 卡：能不能挂、挂哪个画板、讲哪一句话，都由 LLM 语义匹配决定（diagnose/labmatch.js）；
       * 匹配失败/被拒绝/参数校验不过 → 不挂图（无正则保底，见卡面决策 2）。
       * 画板文案与绘制方式仍由 funclab.js 按 intent 决定，LLM 不参与"怎么画"。 */
      /* 画板四件（funclab/geomlab/labmatch/chatgraph）同样不在首屏链上：进讲解面板才加载。
       * 没到货就整块跳过（下面的 window.Funclab / window.Labmatch 守卫保留），讲解照常。 */
      if (!window.Funclab && !S.lazyFailed.lab) {
        Lazy.load(LAZY_LAB).then(function () { renderQuestion(item); }, lazyFail('lab'));
      }
      try {
        const lab = window.Funclab && window.Funclab.labForScene(t && t.id, q && q.prompt, { itemId: q && q.id });
        /* 学生自己点过「画图给我看」：结果已经定了（ui.labAsk 非 null），这里只呈现，不再请求 LLM。
         * 注意只有 'ok' 才需要空槽（画板要挂进去）；loading / none / offline 都不该留空容器。 */
        const asked = !!S.ui.labAsk;
        const slot = lab && window.Labmatch && (!asked || S.ui.labAsk === 'ok' || S.ui.labAsk === 'loading')
          ? h('div', { class: 'funclab-slot' }) : null;
        if (slot && S.ui.labAsk !== 'loading') box.append(slot);
        if (asked) {
          if (S.ui.labAsk === 'ok' && S.ui.labCfg) {
            try {
              const inst = window.Funclab.mount(S.ui.labCfg);
              if (inst && slot) slot.appendChild(inst.el);
              else if (inst) box.append(inst.el);
              else renderLabAsk(box, item);   // 重挂失败：降级成「画不了」提示，不留空槽
            } catch (err) { console.warn('[explain] 重新渲染学生要看到的画板失败：', err); renderLabAsk(box, item); }
          } else if (S.ui.labAsk === 'loading') {
            renderLabAsk(box, item);
          } else {
            renderLabAsk(box, item);
          }
        } else if (lab && window.Labmatch) {
          /* 上面的 Lazy.load(LAZY_LAB) 已保证这批模块到货；此处再 ensure 一次（Lazy 去重，零请求） */
          Lazy.load(LAZY_LAB);
          /* 先用空槽占位再异步填：不阻塞讲解面板渲染，也不留空画板容器（不挂时整槽移除） */
          window.Labmatch.resolve({ prompt: q && q.prompt, lab: lab, itemId: q && q.id })
            .then(function (cfg) {
              /* 学生在这段时间自己点了按钮：以学生那次（lenient）为准，删掉这里的槽 */
              if (S.ui.labAsk) { if (slot.parentNode) slot.remove(); return; }
              if (!cfg) { if (slot.parentNode) slot.remove(); renderLabAsk(box, item); return; }
              const inst = window.Funclab.mount(cfg);
              if (!inst) { if (slot.parentNode) slot.remove(); renderLabAsk(box, item); return; }   // 挂载失败不写 labCfg（TDZ 教训）
              slot.appendChild(inst.el);
              /* t_85395e07：AI 讲解看到画板 —— 挂载成功才记录配置与描述；describe 抛错不连累画板 */
              S.ui.labCfg = cfg;
              S.ui.labDesc = null;
              try { S.ui.labDesc = window.Funclab.describe(cfg.lab, cfg.intent, cfg); }
              catch (err) { S.ui.labDesc = null; console.warn('[explain] Funclab.describe 失败，画板仍正常显示：', err); }
            })
            .catch(function () { if (slot.parentNode) slot.remove(); renderLabAsk(box, item); });
        } else if (!lab && window.Geomlab) {
          /* 几何画板：函数画板没候选时回退尝试（三角形/圆/相似）。
           * 库已由上面的 Lazy.load(LAZY_LAB) 注入；此处 ensure 幂等。
           * answer/choices 必须传 —— 送分门禁靠它判断「答案是否只是题面数值的复制」，
           * 缺了会 fail-closed 不挂（见 geomlab.gate 的 answer-unknown）。 */
          Lazy.load(LAZY_LAB);
          const glab = window.Geomlab.labFor(t && t.id, q && q.prompt, {
            itemId: q && q.id, topic: t, answer: q && q.answer, choices: q && q.choices
          });
          if (glab) {
            const ginst = window.Geomlab.mount(glab);
            if (ginst) {
              box.append(ginst.el);
              /* t_85395e07：挂载成功才记录配置与描述；describe 抛错不连累画板 */
              S.ui.labCfg = glab;
              S.ui.labDesc = null;
              try { S.ui.labDesc = window.Geomlab.describe(glab, glab.state); }
              catch (err) { S.ui.labDesc = null; console.warn('[explain] Geomlab.describe 失败，画板仍正常显示：', err); }
            } else {
              renderLabAsk(box, item);
            }
          } else {
            renderLabAsk(box, item);
          }
        } else {
          renderLabAsk(box, item);
        }
      } catch (e) { /* 画板挂了不影响讲解 */ }
      box.append(h('div', { class: 'row' },
        h('button', { class: 'primary', id: 'btn-soc-done', onclick: function () { finishAnswer('wrong'); } }, '明白了，下一题'),
        h('button', { class: 'good', onclick: function () {
          S.ui.phase = 'ask'; S.ui.answer = ''; S.ui.explainStep = 0; renderQuestion(item);
        } }, '我想再试一遍')));
    }
    /* T3.5 追问区：讲解中随时提问，AI 老师单轮答疑 */
    box.append(askBox(item, steps));
    return box;
  }

  function askBox(item, steps) {
    const q = item.question;
    const t = S.D.graph.byId[item.topicId];
    const hist = h('div', { class: 'ask-hist', id: 'ask-hist' });
    /* 追问气泡里可能带 LLM 给的图（Funclab 画）：渲染气泡前先 ensure 画板库；
     * 没到货就这几条气泡不带图（下面的 window.Funclab 守卫保留），不影响文字回答。 */
    if (!window.Funclab && !S.lazyFailed.lab) {
      Lazy.load(LAZY_LAB).then(function () { renderQuestion(item); }, lazyFail('lab'));
    }
    (S.ui.askHistory || []).forEach(function (entry) {
      const rowEl = h('div', { class: 'ask-item' },
        h('div', { class: 'ask-q' }, '你：' + entry.q),
        entry.pending ? h('div', { class: 'ask-a pending' }, 'AI 老师正在想…')
          : entry.from === 'offline'
            ? h('div', { class: 'ask-a offline' }, 'AI 老师暂时离线，没回答上。稍后再问一次试试。')
            : h('div', { class: 'ask-a' }, '老师：' + entry.a));
      const g = entry.graph;
      if (g && window.Funclab) {
        let inst = null;
        try {
          inst = window.Funclab.mount(Object.assign({ type: g.type, lab: g.lab, intent: g.intent }, g.params));
        } catch (err) { console.warn('[explain] 气泡里的画板挂载失败：', err); }
        if (inst && inst.el) {
          const box2 = h('div', { class: 'ask-graph' });
          box2.append(h('div', { class: 'ask-graph-formula' }, '图：' + window.Funclab.formatFormula(Object.assign({ type: g.type }, g.params))));
          box2.append(inst.el);
          rowEl.append(box2);
        }
      }
      hist.append(rowEl);
    });
    function sendAsk() {
      /* 讲解模块懒加载：理论上首帧就到了；没到货就等加载完自动重发这一次提问（输入框内容还在） */
      if (!window.Explain) {
        if (!S.lazyFailed.explain) Lazy.load(LAZY_EXPLAIN).then(sendAsk, lazyFail('explain'));
        return;
      }
      if (!window.ChatGraph && !S.lazyFailed.chat) {
        /* 追问回答里的图校验要 chatgraph.js；没到货这条回答就不带图（原有降级） */
        Lazy.load(LAZY_LAB).then(null, lazyFail('chat'));
      }
      const inp = document.getElementById('ask-input');
      const text = (inp && inp.value || '').trim();
      if (!text || S.ui.askPending) return;
      S.ui.askHistory = (S.ui.askHistory || []).concat([{ q: text, pending: true }]);
      S.ui.askPending = true;
      S.ui.askScroll = true;   // 刚提问：本次渲染后滚到追问区最后一条，让用户看到自己发的内容
      const tick = ++explainTick;   // 复用竞态令牌：回答只属于当前面板
      renderQuestion(item);
      window.Explain.ask(t, q, S.ui.answer, steps, text, S.ui.labDesc).then(function (res) {
        if (tick !== explainTick || !S.ui || S.ui.phase !== 'explain') return;
        let graph = null;
        try {
          const v = window.ChatGraph ? window.ChatGraph.verifyChatGraph(res.graph) : { ok: false };
          graph = v && v.ok ? v : null;   // 校验不过/异常一律当没有图，不提示「画图失败」
        } catch (err) { graph = null; }
        const entries = (S.ui.askHistory || []).slice();
        entries[entries.length - 1] = { q: text, a: res.text, from: res.from, graph: graph };
        S.ui.askHistory = entries;
        S.ui.askPending = false;
        S.ui.askScroll = true;   // 刚答完：本次渲染后滚到这条问答，否则答案落在折叠线以下看不见
        renderQuestion(item);
      });
    }
    const inp = h('input', {
      type: 'text', class: 'ask-input', id: 'ask-input', autocomplete: 'off',
      placeholder: '没看懂？问 AI 老师，例如：什么叫去括号？为什么这步要变号？',
      value: S.ui.askDraft || '',
      oninput: function (e) { S.ui.askDraft = e.target.value; },
      onkeydown: function (e) { if (e.key === 'Enter' && !e.isComposing) sendAsk(); }
    });
    return h('div', { class: 'ask-box no-print' },
      hist,
      S.ui.askPending ? null : h('div', { class: 'row', style: 'margin-top:8px' },
        h('span', { class: 'grow', style: 'margin-right:8px' }, inp),
        h('button', { class: 'primary', id: 'btn-ask', onclick: sendAsk }, '问 AI 老师')));
  }

  /* ------------------------------------------------------------ 学生自己要看图（卡 t_f80f900e / t_4eed15b3）
   *
   * 只在「系统没挂上图」时出现。学生点了按钮，「需不需要图」就已经有了答案 ——
   * 系统**不再判断**「这图有没有用」，只判断「能不能画」：llm 只从题面提取函数表达式，
   * 参数仍需代回校验、画板/intent 仍必须来自 funclab 的能力清单。
   *
   * 所以失败文案只能是**关于系统自己**的技术限制，不能是对学生需求的否定：
   *   none    → 题面里没有可画出的函数 / 参数校验不过 → 「暂时画不出来」（不否定学生要图的需求）
   *   offline → 网关挂了 → 「画图功能暂时用不了」
   *
   * 状态机（ui.labAsk）：null 未点 → 'loading' 请求中 → 'ok' 已挂 | 'none' 画不出 | 'offline' 网关挂。
   * 点过就记住：重渲染不再请求 LLM（烧钱 + 闪），结果页由 explainPanel 直接按状态呈现。 */
  const LAB_ASK_TEXT = {
    none: '这题的图形我暂时画不出来，咱们按解析一步步来',
    offline: '画图功能暂时用不了'
  };

  function renderLabAsk(box, item) {
    const state = S.ui.labAsk;
    const wrap = h('div', { class: 'lab-ask', id: 'lab-ask' });
    if (state === 'loading') {
      wrap.append(h('span', { class: 'muted' }, '正在画…'));
      return box.append(wrap);
    }
    if (state === 'ok') return;   // 画板已经挂在面板里，不再留提示
    if (state === 'none' || state === 'offline') {
      wrap.append(h('span', { class: 'muted', id: 'lab-ask-msg' }, LAB_ASK_TEXT[state]));
      return box.append(wrap);
    }
    wrap.append(
      h('span', { class: 'muted' }, '这题要是画个图看看会更清楚？'),
      h('button', {
        class: 'small', id: 'btn-lab-ask',
        onclick: function (e) {
          if (e && e.target) e.target.disabled = true;
          askForLab(item);
        }
      }, '画图给我看'));
    box.append(wrap);
  }

  function askForLab(item) {
    if (S.ui.labAsk) return;   // 已在请求中 / 已有结论
    /* 画板库懒加载：没到货先注入，到货后重新走一遍「画图给我看」；失败按「画图功能暂时用不了」降级 */
    if (!window.Funclab || !window.Labmatch) {
      if (!S.lazyFailed.lab) {
        Lazy.load(LAZY_LAB).then(function () { askForLab(item); }, function (err) {
          lazyFail('lab')(err);
          S.ui.labAsk = 'offline';
          S.ui.labAskMsg = 'lazy-load-failed';
          renderQuestion(item);
        });
      } else {
        S.ui.labAsk = 'offline';
        S.ui.labAskMsg = 'lazy-load-failed';
        renderQuestion(item);
      }
      return;
    }
    const q = item.question;
    const t = S.D.graph.byId[item.topicId];
    const lab = window.Funclab && window.Funclab.labForScene(t && t.id, q && q.prompt, { itemId: q && q.id });
    if (!lab || !window.Labmatch) { S.ui.labAsk = 'none'; renderQuestion(item); return; }
    S.ui.labAsk = 'loading';
    S.ui.labAskMsg = null;
    renderQuestion(item);
    const tick = ++explainTick;   // 竞态令牌：只接受当前面板的那次结果
    window.Labmatch.resolve({ prompt: q && q.prompt, lab: lab, itemId: q && q.id, lenient: true })
      .then(function (cfg) {
        if (tick !== explainTick || !S.ui || S.ui.phase !== 'explain') return;
        if (!cfg) {
          const f = window.Labmatch.lastFailure && window.Labmatch.lastFailure();
          S.ui.labAsk = (f && f.kind === 'offline') ? 'offline' : 'none';
          S.ui.labAskMsg = f && f.reason || null;
          renderQuestion(item);
          return;
        }
        /* mount 抛异常会被外层 try/catch 静默吃掉（表现是「图不出现但不报错」），
         * 所以先确认拿到实例再写 ui.labCfg / ui.labDesc。库由上面的 Lazy.load(LAZY_LAB) 保证。 */
        Lazy.load(LAZY_LAB);
        let inst = null;
        try { inst = window.Funclab.mount(cfg); } catch (err) { console.warn('[explain] 学生要的画板挂载失败：', err); }
        if (!inst) { S.ui.labAsk = 'none'; S.ui.labAskMsg = 'mount-failed'; renderQuestion(item); return; }
        S.ui.labAsk = 'ok';
        S.ui.labCfg = cfg;
        S.ui.labDesc = null;
        try { S.ui.labDesc = window.Funclab.describe(cfg.lab, cfg.intent, cfg); }
        catch (err) { S.ui.labDesc = null; console.warn('[explain] Funclab.describe 失败，画板仍正常显示：', err); }
        renderQuestion(item);
      });
  }

  function demoBanner() {
    return h('div', { class: 'banner demo no-print' }, '演示模式：由程序模拟一位学生作答（不会保存进度）。',
      h('a', { href: location.pathname }, '退出演示'));
  }

  /* ------------------------------------------------------------ 分享图 */
  function onShareKey(e) { if (e.key === 'Escape') closeShare(); }
  function closeShare() {
    S.shareToken++;
    document.removeEventListener('keydown', onShareKey);
    var modal = document.getElementById('share-modal');
    if (modal) modal.remove();
    document.body.classList.remove('share-open');
    if (S.shareBlobUrl) { URL.revokeObjectURL(S.shareBlobUrl); S.shareBlobUrl = null; }
  }
  function shareScopeText() {
    var raw = S.sessionMeta && S.sessionMeta.label ? String(S.sessionMeta.label) : '本次诊断';
    raw = raw.replace(/（整体筛查）/g, '').replace(/（整章）/g, '').replace(/（旧编号已对应到小学知识点）/g, '');
    raw = raw.replace(/\s+/g, ' ').trim();
    return raw || '本次诊断';
  }
  function buildShareModel(sum, chapters) {
    var subjectName = S.subject === 'english' ? '英语' : S.subject === 'physics' ? '物理' : S.subject === 'chinese' ? '语文' : S.subject === 'science' ? '科学' : S.subject === 'morality' ? '道德与法治' : S.subject === 'history' ? '历史' : S.subject === 'geography' ? '地理' : '数学';
    var spots = [];
    var spotKind = 'topic';
    if (chapters && chapters.length) {
      spotKind = 'chapter';
      var hot = chapters.filter(function (c) { return c.weak > 0 || c.shaky > 0; });
      if (!hot.length) hot = chapters.slice(0, 3);
      spots = hot.slice(0, 3).map(function (c) {
        return { title: c.label, detail: '薄弱 ' + c.weak + ' · 不稳 ' + c.shaky + ' · 未测 ' + c.untested };
      });
    } else {
      var seen = Object.create(null);
      var ids = [];
      var pushId = function (id) {
        if (!id || seen[id] || ids.length >= 3) return;
        seen[id] = true;
        ids.push(id);
      };
      sum.roots.forEach(function (r) { pushId(r.id); });
      sum.weak.forEach(pushId);
      sum.shaky.forEach(pushId);
      spots = ids.map(function (id) {
        return { title: nameOf(id), detail: STATUS_LABEL[E.statusOf(S.session, id)] || '' };
      });
    }
    var now = new Date();
    return {
      siteName: '中小学·高中知识图谱',
      subject: subjectName,
      scope: shareScopeText(),
      mastered: sum.mastered.length,
      shaky: sum.shaky.length,
      weak: sum.weak.length,
      untested: sum.untested.length,
      spotKind: spotKind,
      spots: spots,
      roots: sum.roots.slice(0, 2).map(function (r) { return nameOf(r.id); }),
      date: now.getFullYear() + '年' + (now.getMonth() + 1) + '月' + now.getDate() + '日'
    };
  }
  function mountShareModal(url) {
    var old = document.getElementById('share-modal');
    if (old) old.remove();
    var img = h('img', { id: 'share-preview', alt: '诊断分享图', src: url });
    var modal = h('div', {
      id: 'share-modal', class: 'share-modal no-print', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'share-title',
      onclick: function (e) { if (e.target === modal) closeShare(); }
    }, h('div', { class: 'share-panel', onclick: function (e) { e.stopPropagation(); } },
      h('div', { class: 'share-bar' },
        h('h2', { id: 'share-title', text: '分享图' }),
        h('button', { type: 'button', id: 'share-close', onclick: closeShare }, '关闭')),
      h('p', { id: 'share-hint', class: 'share-hint', text: '长按图片保存' }),
      h('div', { class: 'share-scroll' }, img),
      h('div', { class: 'share-actions' },
        h('a', { id: 'share-download', class: 'btn btn-primary', href: url, download: '知识图谱诊断分享.png' }, '下载图片'))));
    document.body.classList.add('share-open');
    document.body.append(modal);
    document.addEventListener('keydown', onShareKey);
  }
  function openShare() {
    if (!window.ShareCard) {
      /* 分享图（qrcode 12K + share 3K）不在首屏链上：第一次点「生成分享图」才注入，注入完成后再走一遍。
       * 失败保留原来的「组件没有加载」提示，不静默成功。 */
      Lazy.load(LAZY_SHARE).then(function () { openShare(); }, function (err) {
        lazyFail('share')(err);
        var host1 = document.getElementById('summary');
        if (host1) host1.append(h('p', { id: 'share-error', class: 'err', text: '分享图没有生成：组件没有加载' }));
      });
      return;
    }
    var token = ++S.shareToken;
    var sum = E.summarize(S.D.graph, S.session);
    var chapters = S.session.mode === 'screen' ? E.chapterSummary(S.D.graph, S.session) : null;
    var model = buildShareModel(sum, chapters);
    window.__shareModel = model;
    var canvas = document.createElement('canvas');
    try { window.ShareCard.draw(canvas, model); }
    catch (err) {
      var host = document.getElementById('summary');
      if (host) host.append(h('p', { id: 'share-error', class: 'err', text: '分享图没有生成：' + (err && err.message ? err.message : err) }));
      return;
    }
    var finish = function (url) {
      if (token !== S.shareToken) {
        if (String(url).indexOf('blob:') === 0) URL.revokeObjectURL(url);
        return;
      }
      if (S.shareBlobUrl && S.shareBlobUrl !== url) URL.revokeObjectURL(S.shareBlobUrl);
      S.shareBlobUrl = String(url).indexOf('blob:') === 0 ? url : null;
      mountShareModal(url);
    };
    if (canvas.toBlob) {
      canvas.toBlob(function (blob) {
        if (token !== S.shareToken) return;
        if (!blob) { finish(canvas.toDataURL('image/png')); return; }
        finish(URL.createObjectURL(blob));
      }, 'image/png');
    } else finish(canvas.toDataURL('image/png'));
  }

  /* ------------------------------------------------------------ 结果页 */
  /* 详情面板的说明正文：lite 里没有 description，全量 topics.json 到货后原地补上。
   * 没到货时给一行「正在载入说明…」，不是空白也不是报错（ensureFullTopics 到货后 refreshPending 换掉）。 */
  function descNode(t) {
    if (t.description) return h('div', { class: 'topic-desc', text: t.description });
    if (!S.fullTopicsLoaded && !S.fullTopicsFailed) ensureFullTopics();
    if (S.fullTopicsLoaded) return h('div', { class: 'topic-desc' }, '暂无说明。');
    if (S.fullTopicsFailed) return h('div', { class: 'muted small desc-pending', 'data-topic-id': t.id }, '说明载入失败，可刷新重试。');
    return h('div', { class: 'muted small desc-pending', 'data-topic-id': t.id }, '正在载入说明…');
  }

  /* 课标条目正文：阶段 3 才取（ensureStandards），没到货时同样给占位文字。
   * 到货后 refreshStdText 按 data-std-id 原地换掉，不重绘整页。 */
  function stdText(k) {
    const item = S.D.stdById[k];
    if (item) return item.text;
    if (S.standardsLoaded) return '（课标文件中找不到该条目）';
    if (S.standardsFailed) return '（课标原文载入失败，可刷新重试）';
    return '正在载入课标原文…';
  }
  function refreshStdText() {
    if (typeof document === 'undefined' || !S.D || !S.D.stdById) return;
    Array.prototype.forEach.call(document.querySelectorAll('.std-text'), function (el) {
      el.textContent = stdText(el.getAttribute('data-std-id'));
    });
  }

  function standardsBlock(id) {
    const t = S.D.graph.byId[id];
    const list = t.standards || [];
    if (!list.length) {
      /* lite 里没有 standards 引用：全量到货前不说「没有」，给占位，到货后原地换 */
      if (!S.fullTopicsLoaded && !S.fullTopicsFailed) {
        ensureFullTopics();
        return h('div', { class: 'muted small std-block-pending', 'data-topic-id': id }, '正在载入课标条目…');
      }
      if (S.fullTopicsFailed) return h('div', { class: 'muted small', text: '课标条目载入失败，可刷新重试。' });
      return h('div', { class: 'muted small', text: t.external ? '小学阶段知识点，未对应第四学段课标条目。' : '没有对应的课标条目。' });
    }
    return h('div', null, h('b', null, '课标条目：'), list.map(function (sd) {
      return h('div', { class: 'std' },
        h('code', { text: sd.id }), h('span', { class: 'conf', text: sd.confidence === 'exact' ? '直接对应' : '推断对应' }),
        h('div', { class: 'std-text', 'data-std-id': sd.id }, stdText(sd.id)),
        sd.note ? h('div', { class: 'muted small', text: '说明：' + sd.note }) : null);
    }));
  }

  /* 掌握标准同理：lite 里没有 mastery_criteria，全量到货前给占位而不是静默省略。 */
  function masteryNode(t) {
    if (t.mastery_criteria && t.mastery_criteria.length) {
      return h('div', null, h('b', null, '掌握标准：'), h('ul', null, t.mastery_criteria.map(function (m) { return h('li', { text: m }); })));
    }
    if (!S.fullTopicsLoaded && !S.fullTopicsFailed) {
      ensureFullTopics();
      return h('div', { class: 'muted small mastery-pending', 'data-topic-id': t.id }, '正在载入掌握标准…');
    }
    if (S.fullTopicsFailed) return h('div', { class: 'muted small', text: '掌握标准载入失败，可刷新重试。' });
    return null;
  }

  function topicBody(id, extra) {
    const t = S.D.graph.byId[id];
    const body = h('div', { class: 'body' });
    body.append(h('div', { class: 'muted' }, (t.external ? '小学先修知识点（无诊断题）' : t.chapter) + (t.domain ? ' · ' + t.domain : '')));
    body.append(descNode(t));
    body.append(masteryNode(t));
    if (extra) body.append(extra);
    body.append(standardsBlock(id));
    return body;
  }

  function topicItem(id, tags, extra, pbtn) {
    const t = S.D.graph.byId[id];
    const sumChildren = [tags, h('span', { text: t.name }), ' ', h('span', { class: 'muted small', text: t.external ? '小学' : t.chapter })];
    if (pbtn) sumChildren.push(h('div', { class: 'topic-actions no-print' }, pbtn));
    return h('details', { class: 'topic' },
      h('summary', null, sumChildren),
      topicBody(id, extra));
  }

  function tag(cls, text) { return h('span', { class: 'tag ' + cls, text: text }); }
  function statusTags(id, rootSet, targetSet) {
    const st = E.statusOf(S.session, id);
    const out = [];
    if (targetSet.has(id)) out.push(tag('target', '目标'));
    if (rootSet.has(id)) out.push(tag('root', '根因'));
    if (isPrereqKnowledge(id)) out.push(tag('ext', '前置知识'));
    out.push(tag(st, STATUS_LABEL[st]));
    if (S.D.graph.byId[id].external) out.push(tag('ext', '小学'));
    return out;
  }

  /* T3：练习按钮（结果页每个知识点条目旁）。题库按章节懒取还没到货时也给按钮：
   * 文案退成「练习」，点下去由 startPractice 先取该章节的题库（取不到会明说，不会静默空练习）。 */
  function practiceBtn(id) {
    const t = S.D.graph.byId[id];
    if (!t || t.external) return null;   // 小学 / 前置知识不练
    const bank = S.D.graph.bank[id] || [];
    const done = practicedMap()[id];
    let label;
    if (bank.length) {
      const n = (E.pickPracticeQuestions(S.D.graph, id, PRACTICE_N, seenList()) || []).length;
      label = done ? '再练一遍' : (n > 1 ? '练习这 ' + n + ' 题' : '练习这道题');
    } else {
      label = '练习';
    }
    return h('button', { type: 'button', class: 'practice-btn no-print',
      onclick: function (e) { e.stopPropagation(); e.preventDefault(); withStage2Data(function () { startPractice(id); }); } },
      label);
  }

  /* 路径练习入口（结果页次级入口）。只有弱节点 ≥1 时出现；
   * 与每行「练习这 N 题」并存——那个是「专门练这一个」，这里是「按顺序一关一关练」。 */
  function pathPracticeEntry(sum) {
    const queue = pathQueueFrom(sum).filter(function (id) { return (S.D.graph.bank[id] || []).length; });
    if (!queue.length) return null;
    const first = queue[0];
    return h('div', { class: 'card path-practice no-print', id: 'path-practice' },
      h('p', { class: 'small' }, '你答错的知识点有 ' + queue.length + ' 个，可以按顺序一个个练（一次一关，共 ' + queue.length + ' 关）。'),
      h('button', { type: 'button', class: 'path-practice-btn', id: 'btn-path-practice',
        onclick: function () { withStage2(S.session ? S.session.targets : null, 'target', function () { startPathPractice(); }); } },
        '开始练：' + nameOf(first) + '（第 1 关 / 共 ' + queue.length + ' 关）'));
  }

  /* 这一轮是不是「只有 diagnostic_question 兜底题」？
   * 判据不能是「D.graph.bank 里为空」：engine.buildGraph 会给没有真题的点塞一道 type 'legacy'
   * 的兜底题（diagnostic_question），bank 里永远有题（复核卡 t_588d8341 实测）。所以判据是
   * 「目标点在图里的题全是 legacy 兜底题」——只看图，不动引擎判分。
   * graph/session 作为参数传入是为了 Node 直测（tests/test_questions_split.js）。 */
  function diagnosticOnlyRound(graph, sess) {
    if (!graph || !sess || !Array.isArray(sess.targets) || !sess.targets.length) return false;
    const bank = graph.bank || {};
    const ids = sess.targets.filter(function (id) { return graph.byId && graph.byId[id]; });
    if (!ids.length) return false;
    return ids.every(function (id) {
      const list = bank[id] || [];
      return !list.length || list.every(function (q) { return q && q.type === 'legacy'; });
    });
  }

  /* 结果页头条（纯函数，Node 直测）。只有诊断题的一轮必须先说「不作数」，
   * 绝不能出现「目标知识点已掌握」——那是答完 1 道兜底题就给出的假结论。 */
  function resultHeadline(sum, sess, screen, diagOnly, targetsMastered) {
    if (diagOnly) {
      return '题库没取到，本轮只做了 ' + sum.asked + ' 道诊断题，结果不作数（答完一题说明不了掌握情况）。';
    }
    if (screen) {
      if (!sum.weak.length && !sum.shaky.length) return sum.untested.length
        ? '已测到的知识点没有发现薄弱点，另有 ' + sum.untested.length + ' 个没测到。'
        : '范围内的知识点都已掌握，没有发现薄弱点。';
      return '范围内共 ' + sess.targets.length + ' 个知识点：薄弱 ' + sum.weak.length + '、不稳 ' + sum.shaky.length + '、未测 ' + sum.untested.length +
        '。先看下面的「按章汇总」，薄弱的章排在前面。';
    }
    if (!sum.roots.length && !sum.shaky.length && targetsMastered) return '目标知识点已掌握，没有发现需要补的先修。';
    if (!sum.roots.length && !sum.shaky.length) return '没有判出薄弱点，但目标尚未全部测到。';
    if (!sum.roots.length) return '没有判出薄弱点，但有 ' + sum.shaky.length + ' 个知识点「不稳」（中途答错过、确认题答对），建议巩固。';
    return '共发现 ' + sum.roots.length + ' 个薄弱根因' + (sum.shaky.length ? '、' + sum.shaky.length + ' 个不稳的知识点' : '') + '，按下面的学习路径从前往后补。';
  }

  /* 题库没取到时的结果卡：替掉「接下来练什么」小结（那句「都掌握啦，真棒！」在这一轮是假的）。 */
  function noBankCard(sum) {
    return h('div', { class: 'card', id: 'advice-summary' },
      h('h2', { text: '题库没取到，这轮结果不作数' }),
      h('p', { style: 'margin:2px 0' }, '题库没取到，本轮只做了 ' + sum.asked + ' 道诊断题，结果不作数。'),
      h('p', { class: 'muted small', style: 'margin:2px 0' },
        '这一轮的结论既不能说明掌握，也不能说明薄弱。换个有网的网络后，回到开始页重新点一次这个知识点，工具会重新取整套题。'));
  }

  function renderResult() {
    const sum = E.summarize(S.D.graph, S.session);
    /* 阶段 3：进结果页（详情 / 课标对照）才取课标条目正文；两个 ensure 都到货后原地换掉占位文字，不重绘。 */
    ensureStandards();
    ensureFullTopics();
    const rootSet = new Set(sum.roots.map(function (r) { return r.id; }));
    const screen = S.session.mode === 'screen';
    const targetSet = new Set(screen ? [] : S.session.targets);
    /* 题库整个没取到时（bundle 404 / 离线未缓存 / 全量兜底也失败），本轮只有 diagnostic_question 兜底题：
     * 结果页必须先说「不作数」——「都掌握啦，真棒！」和一题就判的「已掌握」都是假结论。 */
    const diagOnly = diagnosticOnlyRound(S.D.graph, S.session);
    const page = h('div');
    if (S.demo) page.append(demoBanner());
    saveToChild(sum);
    noteBlind(sum);
    page.append(childBar('result'));
    const pracBanner = practiceResultBanner();
    if (pracBanner) page.append(pracBanner);
    else if (diagOnly) page.append(noBankCard(sum));
    else page.append(adviceCard(sum));

    const targetsMastered = S.session.targets.every(function (id) { return E.statusOf(S.session, id) === 'mastered'; });
    const chapters = screen ? E.chapterSummary(S.D.graph, S.session) : null;
    const outOfScope = screen ? sum.roots.filter(function (r) { return r.outOfScopePrereqs.length; }) : [];
    const headline = resultHeadline(sum, S.session, screen, diagOnly, targetsMastered);

    const more = screen ? 10 : 4;
    const summaryCard = h('div', { class: 'card', id: 'summary' },
      h('h2', { text: '诊断结果：' + S.sessionMeta.label }),
      h('p', null, headline),
      h('div', { class: 'stats' },
        stat('ask', sum.asked, '已答题数'),
        stat('bad', sum.weak.length, '薄弱'),
        stat('shaky', sum.shaky.length, '不稳'),
        diagOnly ? null : stat('ok', sum.mastered.length, '已掌握'),
        stat('unk', sum.untested.length, '未测')),
      sum.unconfirmed.length ? h('p', { class: 'notice' }, '「' + sum.unconfirmed.map(nameOf).join('」「') + '」答错过但还没完成确认就到了题量上限，没来得及复测，暂按薄弱处理。') : null,
      sum.limitReached ? h('p', { class: 'notice' }, '已达到题量上限（' + sum.limit + '），剩余没测到的知识点标为「未测」。薄弱根因的先修里若有未测点，真正的根因可能更靠前。',
        S.session.limit >= 60 ? null : h('button', { class: 'no-print', style: 'margin-left:8px', onclick: function () { rebuild(S.session.answers, Math.min(S.session.limit + more, 60)); } }, '再多答 ' + Math.min(more, 60 - S.session.limit) + ' 题')) : null,
      h('p', { class: 'muted small' }, '自动判题只是近似的，答题记录里可以更正任何一题。生成时间：' + new Date().toLocaleString('zh-CN')),
      h('div', { class: 'row no-print' },
        h('button', { class: 'primary', id: 'btn-share', onclick: openShare }, '生成分享图'),
        h('button', { id: 'btn-export', onclick: exportJson }, '导出 JSON'),
        h('button', { id: 'btn-print', onclick: printPage }, '打印 / 另存为 PDF'),
        h('button', { onclick: function () { if (confirm('重新开始会清除当前进度，确定吗？')) restart(); } }, '重新开始'),
        S.session.answers.length ? h('button', { onclick: function () { rebuild(S.session.answers.slice(0, -1)); } }, '撤销上一题') : null));
    page.append(summaryCard);
    const blindCard = blindResultCard(sum);
    if (blindCard) page.append(blindCard);
    if (screen) page.append(chaptersCard(chapters, outOfScope));

    page.append(h('div', { class: 'card', id: 'roots' },
      h('h2', { text: '薄弱的先修知识点（根因）' }),
      h('p', { class: 'muted small' }, '根因 = 被判为薄弱、且它的直接先修里没有薄弱点的知识点。点击展开看描述、掌握标准和课标条目。'),
      sum.roots.length ? sum.roots.map(function (r) {
        const notes = h('div');
        if (r.pendingPrereqs.length) notes.append(h('div', { class: 'notice', text: '它的先修「' + r.pendingPrereqs.map(nameOf).join('」「') + '」没来得及测（题量用完），真正的根因可能更靠前。' }));
        if (r.outOfScopePrereqs.length) notes.append(h('div', { class: 'notice', text: '它的前置知识「' + r.outOfScopePrereqs.map(nameOf).join('」「') + '」不在所选范围内，没有检查。' }));
        if (r.externalPrereqs.length) notes.append(h('div', { class: 'muted small', text: '小学先修（无诊断题，未测）：' + r.externalPrereqs.map(nameOf).join('、') }));
        return topicItem(r.id, statusTags(r.id, rootSet, targetSet), notes, practiceBtn(r.id));
      }) : h('p', { text: targetsMastered ? '没有。' : '暂未发现。' })));

    page.append(h('div', { class: 'card', id: 'shaky' },
      h('h2', { text: '不稳的知识点（' + sum.shaky.length + '）' }),
      h('p', { class: 'muted small' }, '中途答错过，但确认题（同级或更容易）答对了：可能是粗心，也可能掌握得不牢。它们会出现在学习路径里需要巩固，但工具没有继续向它们的先修回溯（只有确认后仍错才回溯）。'),
      sum.shaky.length ? sum.shaky.map(function (id) { return topicItem(id, statusTags(id, rootSet, targetSet), null, practiceBtn(id)); }) : h('p', { text: '没有。' })));

    page.append(h('div', { class: 'card', id: 'path' },
      h('h2', { text: '推荐学习路径' }),
      h('p', { class: 'muted small' }, '从根因（和「不稳」的点）出发到目标之间、尚未判定为掌握的知识点，按年级从低到高排列（同一年级里先修在前），从上往下学。「不稳」「未测」的点也在路径上，建议先巩固 / 自查。'),
      pathPracticeEntry(sum),
      sum.path.length ? h('ol', { class: 'path' }, sum.path.map(function (p) {
        return h('li', null, topicItem(p.id, statusTags(p.id, rootSet, targetSet), null, practiceBtn(p.id)));
      })) : h('p', { text: '不需要补课。' })));

    page.append(h('div', { class: 'card', id: 'graph' },
      h('h2', { text: '路径图' }),
      h('p', { class: 'muted small' }, '小学、初中和高中用不同颜色。硬先修是实线，软先修是虚线，点线表示中间省略了没画出来的知识点。红框是薄弱根因，橙框是目标。节点较多时先按年级收起中间点，可再展开。名称太长会省略，悬停或点按可看全名。滚轮缩放，拖动平移。上面的列表是完整学习顺序。'),
      h('div', { class: 'path-tools no-print' },
        h('button', { type: 'button', id: 'path-zoom-out', onclick: function () { const f = flow('pathZoom'); if (f) f(0.8); } }, '缩小'),
        h('button', { type: 'button', id: 'path-zoom-in', onclick: function () { const f = flow('pathZoom'); if (f) f(1.25); } }, '放大'),
        h('button', { type: 'button', id: 'path-fit', onclick: function () { const f = flow('pathFit'); if (f) f(); } }, '适配画面')),
      h('p', { id: 'path-fold', class: 'graph-fold no-print', hidden: true }),
      h('ul', { class: 'legend' },
        h('li', null, h('i', { class: 'swatch sw-p' }), '小学'),
        h('li', null, h('i', { class: 'swatch sw-j' }), '初中'),
        h('li', null, h('i', { class: 'swatch sw-h' }), '高中'),
        h('li', null, h('i', { class: 'swatch sw-root' }), '薄弱根因'),
        h('li', null, h('i', { class: 'swatch sw-target' }), '目标'),
        h('li', null, h('i', { class: 'swatch line-hard' }), '硬先修（实线）'),
        h('li', null, h('i', { class: 'swatch line-soft' }), '软先修（虚线）'),
        h('li', null, h('i', { class: 'swatch line-skip' }), '中间省略（点线）')),
      h('div', { class: 'path-graph' },
        h('div', { id: 'path-cy', role: 'img', 'aria-label': '先修路径图' }),
        h('div', { id: 'node-tip', class: 'node-tip', role: 'tooltip', hidden: true }))));

    if (!diagOnly) page.append(h('details', { class: 'card', id: 'mastered' },
      h('summary', null, h('b', null, '已掌握的知识点（' + sum.mastered.length + '）')),
      sum.mastered.map(function (id) {
        const src = S.session.status[id].src === 'direct' ? '答对' : '由后续知识点答对推断';
        return topicItem(id, [tag('mastered', src)].concat(S.D.graph.byId[id].external ? [tag('ext', '小学')] : []));
      })));

    page.append(h('details', { class: 'card', id: 'untested' },
      h('summary', null, h('b', null, '未测的知识点（' + sum.untested.length + '）')),
      h('p', { class: 'muted small' }, '题量用完，或不必再测，所以没问到的知识点。小学知识点同样会出题。'),
      sum.untested.map(function (id) { return topicItem(id, statusTags(id, rootSet, targetSet)); })));

    page.append(standardsCard(sum));
    page.append(logCard());
    show(withRouteBack(page));
    const f = flow('mountPathGraph'); if (f) f(sum);
  }

  function nameList(ids) { return ids.map(nameOf).join('、'); }

  function chaptersCard(chapters, outOfScope) {
    const seg = function (cls, n, total) { return n ? h('i', { class: cls, style: 'width:' + (n / total * 100) + '%' }) : null; };
    return h('div', { class: 'card', id: 'chapters' },
      h('h2', { text: '按章汇总' }),
      h('p', { class: 'muted small' }, '每章的知识点掌握情况，薄弱多的章排在前面；点开看具体是哪几个知识点。色条从左到右：掌握、不稳、薄弱、未测。'),
      outOfScope.length ? h('p', { class: 'notice', id: 'out-of-scope' }, '部分薄弱点的前置知识在所选年级之外，未检查（涉及 ' + outOfScope.length + ' 个薄弱点，如「' +
        outOfScope.slice(0, 3).map(function (r) { return nameOf(r.id); }).join('」「') + '」）。可对这些知识点单独做诊断，沿先修继续往前查。') : null,
      chapters.map(function (c) {
        return h('details', { class: 'topic chap-sum', open: c.weak > 0 || c.shaky > 0 },
          h('summary', null,
            h('span', { class: 'chap-name', text: c.label }),
            h('span', { class: 'chap-counts' },
              tag('mastered', '掌握 ' + c.mastered), tag('shaky', '不稳 ' + c.shaky), tag('weak', '薄弱 ' + c.weak), tag('unknown', '未测 ' + c.untested)),
            h('span', { class: 'chap-bar', 'aria-hidden': 'true' },
              seg('m', c.mastered, c.total), seg('s', c.shaky, c.total), seg('w', c.weak, c.total), seg('u', c.untested, c.total))),
          h('div', { class: 'body' },
            h('div', { class: 'muted small', text: '共 ' + c.total + ' 个知识点' }),
            c.weakIds.length ? h('div', { class: 'chap-names' }, tag('weak', '薄弱'), nameList(c.weakIds),
              ' ', h('a', { class: 'blind-retest no-print', href: diagnoseHrefFor(c.weakIds), text: '再测本章薄弱' })) : null,
            c.shakyIds.length ? h('div', { class: 'chap-names' }, tag('shaky', '不稳'), nameList(c.shakyIds),
              ' ', h('a', { class: 'blind-retest no-print', href: diagnoseHrefFor(c.shakyIds), text: '再测本章不稳' })) : null,
            !c.weakIds.length && !c.shakyIds.length ? h('div', { class: 'muted small', text: c.untested ? '没有发现薄弱或不稳的点，另有 ' + c.untested + ' 个没测到。' : '没有发现薄弱或不稳的点。' }) : null));
      }));
  }

  function stat(cls, n, label) { return h('div', { class: 'stat ' + cls }, h('b', { text: String(n) }), label); }

  function standardsCard(sum) {
    const ids = new Set(S.session.mode === 'screen' ? [] : S.session.targets);
    sum.path.forEach(function (p) { ids.add(p.id); });
    const by = {};
    ids.forEach(function (id) {
      (S.D.graph.byId[id].standards || []).forEach(function (sd) { (by[sd.id] || (by[sd.id] = [])).push(id); });
    });
    const keys = Object.keys(by).sort();
    return h('div', { class: 'card', id: 'standards' },
      h('h2', { text: '相关课标条目' }),
      h('p', { class: 'muted small' }, S.subject === 'physics'
        ? '目标与学习路径上的知识点对应的《义务教育物理课程标准（2022年版2025年修订）》和《普通高中物理课程标准（2017年版2020年修订）》内容要求（编号与课标条款一致）。'
        : S.subject === 'english'
        ? '目标与学习路径上的知识点对应的《义务教育英语课程标准（2022年版）》和《普通高中英语课程标准（2017年版2025年修订）》公开转述（一级、二级、三级，以及高中必修、选择性必修）。'
        : S.subject === 'chinese'
        ? '目标与学习路径上的知识点对应的《义务教育语文课程标准（2022年版）》第一至第三学段的公开转述。'
        : S.subject === 'science'
        ? '目标与学习路径上的知识点对应的《义务教育科学课程标准（2022年版）》第一至第三学段学习内容的公开转述。'
        : S.subject === 'morality'
        ? '目标与学习路径上的知识点对应的《义务教育道德与法治课程标准（2022年版）》第一至第三学段内容要求的公开转述。'
        : S.subject === 'history'
        ? '目标与学习路径上的知识点对应的《义务教育历史课程标准（2022年版）》第四学段内容要求的公开转述。'
        : S.subject === 'geography'
        ? '目标与学习路径上的知识点对应的《义务教育地理课程标准（2022年版）》第四学段内容要求的公开转述。'
        : '目标与学习路径上的知识点对应的《义务教育数学课程标准（2022年版）》内容要求（第一至第四学段）。'),
      !S.fullTopicsLoaded ? h('p', { class: 'muted small', text: S.fullTopicsFailed ? '课标条目载入失败，可刷新重试。' : '正在载入课标条目…' })
        : keys.length ? keys.map(function (k) {
        return h('div', { class: 'std' }, h('code', { text: k }),
          h('div', { class: 'std-text', 'data-std-id': k }, stdText(k)),
          h('div', { class: 'muted small', text: '对应知识点：' + by[k].map(nameOf).join('、') }));
      }) : h('p', { class: 'muted', text: '无。' }));
  }

  function logCard() {
    const rows = S.session.answers.map(function (a, i) {
      const q = E.questionById(S.D.graph, a.qid) || { prompt: '', answer: '' };
      const sel = h('select', {
        onchange: function (e) {
          const next = S.session.answers.map(function (x, j) { return j === i ? Object.assign({}, x, { result: e.target.value }) : x; });
          rebuild(next);
        }
      }, ['correct', 'wrong', 'skip'].map(function (r) { return h('option', { value: r, selected: r === a.result }, RESULT_LABEL[r]); }));
      return h('tr', null, h('td', { text: String(i + 1) }),
        h('td', null, nameOf(a.id), h('div', { class: 'muted small', text: q.prompt.length > 60 ? q.prompt.slice(0, 59) + '…' : q.prompt })),
        h('td', { class: 'muted', text: a.text || '' }),
        h('td', null, sel), h('td', { class: 'muted', text: q.answer }));
    });
    return h('div', { class: 'card', id: 'log' },
      h('h2', { text: '答题记录（可更正）' }),
      h('p', { class: 'muted small' }, '自动判题可能判错。在这里改某一题的结果会重新计算整份诊断（后续是否还需要追问也会随之变化）。'),
      S.session.answers.length ? h('table', { class: 'log' },
        h('thead', null, h('tr', null, h('th', { text: '#' }), h('th', { text: '知识点 / 题目' }), h('th', { text: '你的答案' }), h('th', { text: '结果' }), h('th', { text: '参考答案' }))),
        h('tbody', null, rows)) : h('p', { class: 'muted', text: '还没有答题。' }));
  }

  /* ------------------------------------------------------------ 路径图已搬去 app-flow.js（DiagFlow） */

  /* ------------------------------------------------------------ 导出 / 打印 */
  function exportJson() {
    const sum = E.summarize(S.D.graph, S.session);
    const stdIds = new Set();
    const brief = function (id) { return { id: id, name: nameOf(id) }; };
    sum.path.concat(S.session.mode === 'screen' ? [] : S.session.targets.map(function (id) { return { id: id }; })).forEach(function (p) {
      (S.D.graph.byId[p.id].standards || []).forEach(function (sd) { stdIds.add(sd.id); });
    });
    const chapters = S.session.mode === 'screen' ? E.chapterSummary(S.D.graph, S.session) : null;
    const out = {
      tool: 'cn-math-taxonomy/diagnose', version: 2, mode: S.session.mode || 'target', generatedAt: new Date().toISOString(),
      note: '自动判题是近似的，以参考答案为准。',
      label: S.sessionMeta.label,
      targets: S.session.targets.map(brief),
      limit: S.session.limit, seed: S.session.seed, asked: sum.asked, finished: sum.finished, limitReached: sum.limitReached,
      answers: S.session.answers.map(function (a, i) {
        const q = E.questionById(S.D.graph, a.qid) || {};
        return {
          order: i + 1, topicId: a.id, name: nameOf(a.id), questionId: a.qid, difficulty: q.difficulty, type: q.type,
          prompt: q.prompt, userAnswer: a.text == null ? null : a.text, result: a.result,
          referenceAnswer: q.answer, explanation: q.explanation || ''
        };
      }),
      chapters: chapters ? chapters.map(function (c) {
        return {
          label: c.label, total: c.total, mastered: c.mastered, shaky: c.shaky, weak: c.weak, untested: c.untested,
          weakTopics: c.weakIds.map(brief), shakyTopics: c.shakyIds.map(brief), untestedTopics: c.untestedIds.map(brief)
        };
      }) : undefined,
      weakRoots: sum.roots.map(function (r) {
        return Object.assign(brief(r.id), {
          pendingPrereqs: r.pendingPrereqs, outOfScopePrereqs: r.outOfScopePrereqs, externalPrereqs: r.externalPrereqs,
          masteryCriteria: S.D.graph.byId[r.id].mastery_criteria || [],
          standards: (S.D.graph.byId[r.id].standards || []).map(function (sd) { return sd.id; })
        });
      }),
      path: sum.path.map(function (p, i) { return Object.assign({ order: i + 1 }, brief(p.id), { status: p.status, isRoot: p.isRoot, isTarget: p.isTarget }); }),
      weak: sum.weak.map(brief),
      shaky: sum.shaky.map(brief),
      mastered: sum.mastered.map(function (id) { return Object.assign(brief(id), { source: S.session.status[id].src }); }),
      untested: sum.untested.map(function (id) { return Object.assign(brief(id), { external: !!S.D.graph.byId[id].external }); }),
      standards: Array.from(stdIds).sort().map(function (k) { return { id: k, text: S.D.stdById[k] ? S.D.stdById[k].text : '' }; })
    };
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: 'diagnosis-' + new Date().toISOString().slice(0, 10) + '.json' });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }

  function printPage() { window.print(); }
  if (typeof window !== 'undefined') window.addEventListener('beforeprint', function () {
    document.querySelectorAll('details:not([open])').forEach(function (d) { d.setAttribute('open', ''); d.dataset.autoOpen = '1'; });
    if (S.pathCy) { S.pathCy.resize(); S.pathCy.fit(undefined, 20); }
  });
  if (typeof window !== 'undefined') window.addEventListener('afterprint', function () {
    document.querySelectorAll('details[data-auto-open]').forEach(function (d) { d.removeAttribute('open'); delete d.dataset.autoOpen; });
  });

  /* ------------------------------------------------------------ 启动 */
  function resolveTargets(params) {
    const t = params.get('target');
    if (t) {
      const raw = t.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
      const ids = E.resolveTargets(raw, S.D.aliases);
      const bad = ids.filter(function (id) { return !S.D.graph.byId[id] || S.D.graph.byId[id].external; });
      if (bad.length) throw new Error('URL 参数 target 里有无效知识点：' + bad.join(', '));
      const aliased = raw.filter(function (id) { return S.D.aliases[id]; });
      let label = ids.map(nameOf).join('、');
      if (aliased.length) {
        label = aliased.map(function (id) { return (S.D.aliases[id].name || id); }).join('、') + '（旧编号已对应到小学知识点）';
        if (ids.length <= 6) label += '：' + ids.map(nameOf).join('、');
      }
      return { ids: ids, label: label };
    }
    const c = params.get('chapter');
    if (c) {
      const hit = [];
      VOLUMES.forEach(function (vv) {
        ((S.D.tree[vv[0]] || {}).chapters || []).forEach(function (ch) { if (ch.key === c.trim()) hit.push(ch); });
      });
      if (!hit.length) throw new Error('URL 参数 chapter 没有匹配的章节：' + c + '（格式如 “七上 第一章”）');
      return { ids: hit[0].topics.map(function (x) { return x.t.id; }), label: hit[0].volume + ' ' + hit[0].label + '（整章）' };
    }
    const grade = (params.get('grade') || '').trim();
    const volume = (params.get('volume') || '').trim();
    if (grade || volume) {
      let scope = volume || grade;
      const seniorUrl = {
        '高一': '高一', '高一必修': '高一', '高二': '高二', '高二必修': '高二',
        '选必一': '选必一', '选择性必修第一册': '选必一',
        '选必二': '选必二', '选择性必修第二册': '选必二',
        '选必三': '选必三', '选择性必修第三册': '选必三',
        '选必四': '选必四', '选择性必修第四册': '选必四',
        '必修一': '必修一', '必修第一册': '必修一',
        '必修二': '必修二', '必修第二册': '必修二',
        '必修三': '必修三', '必修第三册': '必修三'
      };
      if (seniorUrl[grade]) {
        if (volume && volume !== '必修' && volume !== '整册' && volume !== '必修整册') {
          throw new Error(S.subject === 'english'
            ? '高中英语不拆上下册：' + grade + ' / ' + volume + '（用 grade=必修一 或 grade=选必一）'
            : S.subject === 'physics'
            ? '高中物理不拆上下册：' + grade + ' / ' + volume + '（用 grade=必修一 或 grade=选必一）'
            : '高中不拆上下册：' + grade + ' / ' + volume + '（用 grade=高一、grade=高二 或 grade=选必二）');
        }
        scope = seniorUrl[grade];
      } else if (grade && volume) {
        const gch = /^[一二三四五六七八九]$/.test(grade) ? grade : grade.charAt(0);
        scope = (volume === '全' || volume === '全一册') ? gch + '全' : (/^[上下]$/.test(volume) ? gch + volume : volume);
        if (scope.charAt(0) !== gch) throw new Error('URL 参数 grade 与 volume 不一致：' + grade + ' / ' + volume);
      }
      if (/^[一二三四五六七八九]$/.test(scope)) scope += '年级';
      const g = E.gradeTargets(S.D.graph, scope, S.subject);
      if (!g) throw new Error('URL 参数 grade / volume 无法识别：' + (volume || grade) + '（写法如 grade=七年级、volume=七上）');
      return { ids: g.ids, label: g.label + '（整体筛查）', mode: 'screen' };
    }
    return null;
  }

  async function init() {
    S.subject = detectSubject();
    applySubjectChrome();
    renderSkeleton();                       // 阶段 0：0ms，不等任何 fetch，先给出可看的界面
    try { await loadData(); } catch (e) {
      clearRoot();
      root.append(h('div', { class: 'card' }, h('h2', { class: 'err', text: '数据加载失败' }),
        h('p', null, String(e.message || e)),
        h('p', null, '请在项目根目录运行 ', h('code', { text: 'python3 -m http.server 8000' }), '，再访问 http://localhost:8000/diagnose/ （不能直接用 file:// 打开）。')));
      return;
    }
    renderStart();                          // 阶段 1：知识库清单（topics-lite）到货，选题界面可用
    const params = new URLSearchParams(location.search);
    let resolved = null;
    try { resolved = resolveTargets(params); } catch (e) { renderStart(e.message); return; }
    if (params.get('seed')) S.seedParam = params.get('seed');
    const paramLimit = parseInt(params.get('limit'), 10);
    const limit = paramLimit > 0 ? paramLimit : undefined;
    if (resolved) {
      /* 直接带 ?target= / ?grade= 进来：出题前把先修关系与至少一份题源等到（弱网题库 25s）。
       * 等不到就明给「数据没下来 + 重试」，绝不进 0 题空结果页。 */
      const ready = await ensureFlowReady(resolved.ids, limit, resolved.mode);
      if (!ready) { renderStart('题目没能载入，可刷新重试。'); return; }
    }
    if (resolved && params.get('demo')) {
      S.demo = { oracle: makeOracle(resolved.ids, resolved.mode) };
      S.session = E.createSession(S.D.graph, resolved.ids, {
        mode: resolved.mode, limit: limit || (resolved.mode === 'screen' ? getSettings().screenLimit : getSettings().limit),
        confirm: getSettings().confirm, seed: S.seedParam == null ? 'demo' : S.seedParam
      });
      S.sessionMeta = { label: resolved.label };
      const step = parseInt(params.get('step'), 10);
      runDemo(step >= 0 ? step : Infinity);
      render();
      return;
    }
    if (resolved) {
      const saved = lsGet(sessionKey());
      const same = saved && JSON.stringify(saved.targets) === JSON.stringify(Array.from(new Set(resolved.ids))) &&
        (saved.mode || 'target') === (resolved.mode || 'target') && (S.seedParam == null || saved.seed === S.seedParam);
      if (same) { restoreFromSave(saved, function () { startSession(resolved.ids, resolved.label, limit, resolved.mode); }); return; }
      startSession(resolved.ids, resolved.label, limit, resolved.mode);
      return;
    }
    /* 没有深链参数：上面的 renderStart() 已经把选题界面画好了，不再重绘一次（避免闪一下） */
  }

  if (typeof document !== 'undefined') document.addEventListener('click', function (event) {
    const origin = event.target && event.target.closest ? event.target : (event.target && event.target.parentElement);
    if (!origin || !origin.closest) return;
    if (!origin.closest('#btn-path-expand') && !origin.closest('#btn-path-collapse')) return;
    S.pathExpanded = !!origin.closest('#btn-path-expand');
    const f = flow('mountPathGraph'); if (f) f(E.summarize(S.D.graph, S.session));
  });

  if (typeof window !== 'undefined' && window.matchMedia) {
    const scheme = window.matchMedia('(prefers-color-scheme: dark)');
    const relayout = function () {
      if (!S.session || !document.getElementById('path-cy')) return;
      const f = flow('mountPathGraph'); if (f) f(E.summarize(S.D.graph, S.session));
    };
    if (scheme.addEventListener) scheme.addEventListener('change', relayout);
    const narrow = window.matchMedia('(max-width: 700px)');
    if (narrow.addEventListener) narrow.addEventListener('change', relayout);
  }

  /* 纯函数层暴露给 Node 测试（不启动界面）：node -e "require('./diagnose/app.js')" 无 window，直接跳过 */
  if (typeof window !== 'undefined') init();
  else if (typeof module !== 'undefined' && module.exports) {
    /* Node 侧先让 app-flow.js 能拿到 CORE：require('./app-flow.js') 时 factory(global.DiagCore)。 */
    global.DiagCore = CORE;
    /* askable：P0 回归守卫用的纯判据（tests/test_data_split.js 直测它：
     * lite + 无题库 + 全量未到货 的图上必须返回 false，否则就会开出 0 题空会话）。
     * 其余几个是本题库拆分 / 退化的守卫（tests/test_questions_split.js）：
     *   loadBundle          —— bundle 404 时 warn + 回退全量（真跑，配合注入的 fetch 计数）；
     *   diagnosticOnlyRound —— 「这一轮只有 diagnostic_question 兜底题」的判据；
     *   resultHeadline      —— 结果页头条文案（只有兜底题时不许说「已掌握」）；
     *   resetQuestionsCache —— 用例之间清掉缓存/在途 Promise。 */
    module.exports = {
      routeReturnHref: routeReturnHref,
      askable: askable,
      loadBundle: loadBundle,
      diagnosticOnlyRound: diagnosticOnlyRound,
      resultHeadline: resultHeadline,
      resetQuestionsCache: function () {
        S.questionsIndex = null; S.questionsIndexPromise = null; S.fullBankPromise = null; questionsPromise = null;
        Object.keys(S.bundlePromises).forEach(function (k) { delete S.bundlePromises[k]; });
        Object.keys(S.bundleLoaded).forEach(function (k) { delete S.bundleLoaded[k]; });
        Object.keys(S.bankByTopic).forEach(function (k) { delete S.bankByTopic[k]; });
        S.graphQuestions = null;
      }
    };
  }
})();
