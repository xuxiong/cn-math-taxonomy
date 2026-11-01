/* 诊断小工具界面。核心逻辑全部在 engine.js，这里只负责数据加载、渲染与本地存储。 */
(function () {
  'use strict';
  /* Node 直测纯函数时会没有 window（测试只 require 本文件取 routeReturnHref，不跑界面） */
  const Browser = typeof window !== 'undefined' ? window : {};
  const Lazy = Browser.Lazy;   // 首屏脚本链保证 lazyload.js 先于 app.js，故这里一定可用

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
  let E = Browser.DiagEngine;   // 引擎不在首屏：ensureFlowEngine 补载后再赋（见 init / goFlow）
  /* 首屏纯函数层 chapter.js（parseChapter / subjectOf / buildGraph / gradeTargets / 题量常量）。
   * WHY：骨架 → 学科外壳 → 可搜索知识点列表 → 年级卡片这一段只用到这些纯函数，
   * 首屏不许为了它们去等 23KB 的 engine.gz（engine 只在真正出题/出图时才懒加载）。 */
  const Ch = Browser.CnmChapter || (typeof require !== 'undefined' ? require('./chapter.js') : null);
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
    S: S, Browser: Browser, Lazy: Browser.Lazy,
    get E() { return E; },   // 引擎不在首屏 <script> 链上（见 index.html），进流程时才由 ensureFlowEngine 补载
    h: h, append: append, figureEl: figureEl, show: show,
    theme: theme, nameOf: nameOf, labelLimit: labelLimit, clipLabel: clipLabel,
    lazyFail: lazyFail, LAZY_PATH: LAZY_PATH, PATH_FOLD_AT: PATH_FOLD_AT, STATUS_LABEL: STATUS_LABEL,
    /* 按需段要的常量（都是本对象定义之前就声明的 const/let，直接引用无 TDZ） */
    DIFF_LABEL: DIFF_LABEL, LAZY_EXPLAIN: LAZY_EXPLAIN, LAZY_LAB: LAZY_LAB,
    LAZY_SHARE: LAZY_SHARE, LAZY_VARIANTS: LAZY_VARIANTS, LS_PRAC: LS_PRAC, LS_VSEQ: LS_VSEQ,
    PRACTICE_N: PRACTICE_N, RESULT_LABEL: RESULT_LABEL, TYPE_LABEL: TYPE_LABEL, VOLUMES: VOLUMES,
    root: root,
    /* 按需段要调的核心工具（function 声明已提升，引用安全） */
    flow: flow, getSettings: getSettings, newSeed: newSeed, seenList: seenList, markSeen: markSeen,
    lsGet: lsGet, lsSet: lsSet, lsDel: lsDel, save: save, saveToChild: saveToChild, sessionKey: sessionKey,
    resetUi: resetUi, renderStart: renderStart, renderQuestionsPending: renderQuestionsPending,
    renderNoQuestions: renderNoQuestions, questionSourcesSettled: questionSourcesSettled,
    ensureFullTopics: ensureFullTopics, ensureStandards: ensureStandards,
    ensureQuestionsForOne: ensureQuestionsForOne, ensureQuestionsForTopics: ensureQuestionsForTopics,
    ensureQuestionsForAnswers: ensureQuestionsForAnswers,
    withStage2: withStage2, withStage2Data: withStage2Data, stage2Status: stage2Status,
    childBar: childBar, diagnoseHrefFor: diagnoseHrefFor, routeReturnHref: routeReturnHref,
    routeBackBar: routeBackBar, isPrereqKnowledge: isPrereqKnowledge, reasonFor: reasonFor,
    noteBlind: noteBlind, blindResultCard: blindResultCard, llmVariantsMod: llmVariantsMod
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

  /* 引擎与按需段不在首屏 <script> 链上（见 index.html）：首次进流程 / 深链 / 恢复前补载。
   * 幂等：同一次页面只 Lazy.load 一次，后续调用复用同一个 Promise（同 src 去重）。 */
  let flowEnginePromise = null;
  function ensureFlowEngine() {
    if (!flowEnginePromise) {
      flowEnginePromise = Lazy.load(['engine.js', 'app-flow.js']).then(function () {
        if (!E) E = Browser.DiagEngine;   // E 是 let：按需段注册前先拿到引擎（app-flow 的 CORE.E 走 getter 能读到）
      });
    }
    return flowEnginePromise;
  }

  /* 所有「进流程」的按钮统一入口：先确保引擎/按需段就绪，再走 withStage2 门。
   * latest-click-wins 在 withStage2 里：等待期间再点别的，门开时按最后一次点击重过（见 flowSeq）。
   * enter 是 app-flow.js 里唯一的会话开入口，统一了按钮 / 深链 / 续练三种路径。 */
  function goFlow(targets, label, limit, mode) {
    ensureFlowEngine().then(function () {
      withStage2(targets, mode, function () {
        const f = flow('enter'); if (f) f(targets, label, limit, mode);
      });
    }, function () {
      /* 引擎/按需段补载失败：给一张可操作的重试卡，别让用户点了没反应 */
      renderFlowBlocked(targets, mode, function () { goFlow(targets, label, limit, mode); });
    });
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
    if (!(limit >= LIMIT_MIN && limit <= LIMIT_MAX)) limit = Ch.DEFAULT_LIMIT;
    let screenLimit = parseInt(st.screenLimit, 10);
    if (!(screenLimit >= SCREEN_MIN && screenLimit <= SCREEN_MAX)) screenLimit = Ch.SCREEN_LIMIT;
    const confirm = Ch.clampConfirm(st.confirm);
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
  function show(node) { teardownPath(); const cs = flow('closeShare'); if (cs) cs(); clearRoot(); root.append(node); window.scrollTo(0, 0); }
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
   * 题库不在首屏链上，见 loadQuestions()。
   * BOOT_FILES 里的 {subject} 由 loadData 按 S.subject 换成学科名：首屏只取本学科一份，
   * 单文件远小于全量（math 16KB gzip）；文件缺失时兜底整份 topics-lite.json（老部署降级）。 */
  var BOOT_FILES = ['../data/topics-lite/{subject}.json', '../data/id-aliases.json'];
  async function loadData() {
    const urls = BOOT_FILES.map(function (u) { return u.replace('{subject}', S.subject); });
    const rs = await Promise.all(urls.map(function (u) { return fetch(u); }));
    if (!rs[0].ok) {
      // 学科拆分文件不存在：回退整份 topics-lite.json，下面统一按学科过滤
      const full = await fetch('../data/topics-lite.json');
      if (!full.ok) throw new Error('../data/topics-lite.json → HTTP ' + full.status);
      rs[0] = full;
    }
    rs.forEach(function (r, i) { if (!r.ok) throw new Error(urls[i] + ' → HTTP ' + r.status); });
    const js = await Promise.all(rs.map(function (r) { return r.json(); }));
    const topics = js[0].filter(function (t) { return Ch.subjectOf(t) === S.subject; });
    // 先修关系先留空：图照样能用（只是暂时不回溯），选中知识点后由 ensureDeps() 补齐再重建
    const deps = [];
    // 题库还没有：buildGraph 会为每个知识点回退到 topics.json 的 diagnostic_question
    const graph = Ch.buildGraph(topics, deps, null);
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
    S.D.graph = Ch.buildGraph(S.D.topics, S.D.deps, S.graphQuestions);
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
        const rs1 = flow('refreshStdText'); if (rs1) rs1();
        return true;
      } catch (e) {
        S.standardsFailed = true;
        const rs2 = flow('refreshStdText'); if (rs2) rs2();
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
    const subj = Ch.subjectOf(t);   // 首屏层纯函数：不必等 engine
    const grade = (t.grade == null || t.grade === '') ? '' : String(t.grade);
    return subj + '|' + grade + '|' + String(t.chapter || '');
  }

  /* data/questions-index.json 实测 ≈77KB 原文 / ≈19KB gzip（整份题库的 1/60），用到时才取，取一次记住。
   * 首选按学科拆分份 questions-index/{subject}.json（更小）；缺失时兜底整份 questions-index.json。 */
  function ensureQuestionsIndex() {
    if (S.questionsIndex) return Promise.resolve(S.questionsIndex);
    if (S.questionsIndexPromise) return S.questionsIndexPromise;
    S.questionsIndexPromise = (async function () {
      try {
        let r = await fetch('../data/questions-index/' + S.subject + '.json');
        if (!r.ok) r = await fetch('../data/questions-index.json');   // 学科拆分份缺失：回退整份索引
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
      const ss = flow('startSession'); if (ss) ss(p.targets, p.label, p.limit, p.mode);
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
      const real = flow('masteryNode');
      if (real) { const el2 = real(t); if (el2) el.replaceWith(el2); else el.remove(); } else el.remove();
    });
    Array.prototype.forEach.call(document.querySelectorAll('.std-block-pending'), function (el) {
      const id = el.getAttribute('data-topic-id');
      if (!S.D.graph.byId[id]) return;
      const sb = flow('standardsBlock'); if (sb) el.replaceWith(sb(id));
    });
    /* 课标对照卡的结构（哪几条、对应哪些知识点）也依赖全量 standards 引用，到货后整卡换一次 */
    const card = document.getElementById('standards');
    if (card && S.session && S.D.graph) {
      try { const sc = flow('standardsCard'); if (sc) card.replaceWith(sc(E.summarize(S.D.graph, S.session))); } catch (e) { /* 结构没变好就留旧的 */ }
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
        S.D.graph = Ch.buildGraph(S.D.topics, S.D.deps, questions);
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
      const c = Ch.parseChapter(t.chapter);
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
  /* children.js 不再在首屏链上（见 index.html）：app.js 加载时它可能还没到，故用 let + 到货后刷新引用 */
  let CC = Browser.CnmChildren;
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
    if (!CC) return null;   // children.js 还没到货：首屏先不画孩子档案栏，到货后由 init 重绘补上
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
            const rr = flow('renderResult'); if (rr) rr();
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

  

  /* 阶段 2 的等待只发生在这里：点了目标之后、出题之前。先修关系没到就等一下
   * （弱网下 114KB 约 2s），并在开始页留一行状态文字；全量字段在后台同时开取。 */
  function stage2Status(msg) {
    if (typeof document === 'undefined') return;
    const el = document.getElementById('stage2-status');
    if (el) el.textContent = msg || '';
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
  

  

  

  

  /* 落定一次作答并按新图重绘（commit 的两条分支共用）。 */
  

  

  /* ------------------------------------------------------------ 演示模式 */
  // 演示用的“学生”：目标不会（错、错 -> 薄弱）；它的第一个可测先修也不会；再往前（或另一个先修）答错一次、第二题答对 -> 不稳；其余都会
  

  

  /* ------------------------------------------------------------ 渲染入口 */
  

  /* 来自 route 的 session：页面顶上加一行「← 回到作业分析」。只动这一行，不动流程。 */
  

  /* ------------------------------------------------------------ T3 练习模式 */
  
  
  
  

  /* ------------------------------------------------------------ 路径练习：关卡队列
   * 练习这一层自己筛：引擎的 path 里「未测」也在（学习路径本来就该包含它们），
   * 但没测过的点不知道会不会，练了是浪费，所以练习队列只取 status==='weak'。
   * 顺序沿用 path 的既有顺序（年级低→高、同年级先修在前）。纯函数，不读 DOM。 */
  
  /* 关卡切换时的不变量：pracPath 只在「全部练完」和「学生主动退出」时置空；
   * 它不能跟着 resetUi() 一起被清（resetUi 只重置单题作答状态）。 */
  

  
  
  
  

  /* ------------------------------------------------------------ 路径练习：一关一关
   * 每关内部完全复用 startPractice（题库新鲜题 → O1 变式 → LLM 变式 → 兜底）。
   * 一关练完只**显示**「过关」和「下一关」按钮，学生点了才进下一关——不自动跳。
   * 练习不改变诊断结论（status 不动），markPracticed 仍只记时间戳。 */
  
  
  
  
  
  
  
  
  
  

  /* ------------------------------------------------------------ 学习小结卡 */
  
  
  

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
          h('button', { class: 'primary', id: 'btn-noq-retry', onclick: function () { goFlow(targets, label, limit, mode); } }, '重新试试'),
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
        h('button', { class: 'primary', onclick: function () { withStage2(saved.targets, saved.mode, function () { const rf = flow('restoreFromSave'); if (rf) rf(saved); }); } }, '继续'),
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
      Ch.CONFIRM_CHOICES.map(function (n) {
        return h('option', { value: String(n), selected: st.confirm === n }, String(n) + ' 题');
      }));
    confirmSelect.addEventListener('change', function () {
      const v = Ch.clampConfirm(confirmSelect.value);
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
      const g = Ch.gradeTargets(S.D.graph, gradeScope(), S.subject);
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
            onclick: function () { if (g) goFlow(g.ids, g.label + '（整体筛查）', null, 'screen'); }
          }, '开始整体诊断')),
        h('p', { class: 'muted small' }, '知识点多、题量有限，到上限后没测到的标为「未测」；结果页可以再加题。默认 ' + Ch.SCREEN_LIMIT + ' 题。'));
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
              onclick: function () { goFlow(ch.topics.map(function (x) { return x.t.id; }), ch.volume + ' ' + ch.label + '（整章）'); }
            }, '以整章为目标')),
          c.rows.map(function (x) {
            return h('div', { class: 'topic-row', title: x.t.description },
              h('span', { class: 'nm', text: x.t.name }),
              h('span', { class: 'sec', text: x.section }),
              h('button', { onclick: function () { goFlow([x.t.id], x.t.name); } }, '选为目标'));
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

  

  

  

  /* 正确答案的 key。题库统计（全量 3854 道选择题）：answer 100% 是单字母且必在 choices[].key 内，
   * 所以平常原样返回；只有 answer 不是字符串（历史脏数据 / 别的题型混进来）才做首字母兜底，
   * 兜底也落不到任何选项时返回 null —— 调用方据此不做高亮，绝不猜。 */
  

  /* 选项块。ask 态可点（button + onclick）；其余 phase 一律只读：
   *   - 用 div 而不是 disabled button —— 键盘 Tab 不会停在讲解态的选项上，读屏仍能读到文字
   *   - 正确项加 .choice-correct（绿），学生选错的项加 .choice-picked-wrong（红）
   *   - 学生答对时只标 .choice-picked（与 ask 态同一个 picked 蓝框，配上绿底＝「选对了」）
   * opts: { item, readonly, correctKey, pickedKey } */
  

  /* 非选择题在讲解/判定后的答案回显：一行文字，不重建输入框。
   * 学生没答过（「不会」跳过）时不显示「你的答案」那半句。
   * showRef=false 用于讲解阶段（explain）：那时答案还在折叠块里，这里印出来
   * 等于把 G 卡的折叠意义整个架空（学生不用点开就知道答案）。 */
  

  

  /* ------------------------------------------------------------ 苏格拉底讲解面板（T2：静态即时 + LLM 渐进增强） */
  

  

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

  

  

  

  /* ------------------------------------------------------------ 分享图 */
  
  
  
  
  
  

  /* ------------------------------------------------------------ 结果页 */
  /* 详情面板的说明正文：lite 里没有 description，全量 topics.json 到货后原地补上。
   * 没到货时给一行「正在载入说明…」，不是空白也不是报错（ensureFullTopics 到货后 refreshPending 换掉）。 */
  

  /* 课标条目正文：阶段 3 才取（ensureStandards），没到货时同样给占位文字。
   * 到货后 refreshStdText 按 data-std-id 原地换掉，不重绘整页。 */
  
  

  

  /* 掌握标准同理：lite 里没有 mastery_criteria，全量到货前给占位而不是静默省略。 */
  

  

  

  
  

  /* T3：练习按钮（结果页每个知识点条目旁）。题库按章节懒取还没到货时也给按钮：
   * 文案退成「练习」，点下去由 startPractice 先取该章节的题库（取不到会明说，不会静默空练习）。 */
  

  /* 路径练习入口（结果页次级入口）。只有弱节点 ≥1 时出现；
   * 与每行「练习这 N 题」并存——那个是「专门练这一个」，这里是「按顺序一关一关练」。 */
  

  /* 这一轮是不是「只有 diagnostic_question 兜底题」？
   * 判据不能是「D.graph.bank 里为空」：engine.buildGraph 会给没有真题的点塞一道 type 'legacy'
   * 的兜底题（diagnostic_question），bank 里永远有题（复核卡 t_588d8341 实测）。所以判据是
   * 「目标点在图里的题全是 legacy 兜底题」——只看图，不动引擎判分。
   * graph/session 作为参数传入是为了 Node 直测（tests/test_questions_split.js）。 */
  

  /* 结果页头条（纯函数，Node 直测）。只有诊断题的一轮必须先说「不作数」，
   * 绝不能出现「目标知识点已掌握」——那是答完 1 道兜底题就给出的假结论。 */
  

  /* 题库没取到时的结果卡：替掉「接下来练什么」小结（那句「都掌握啦，真棒！」在这一轮是假的）。 */
  

  

  

  

  

  

  

  /* ------------------------------------------------------------ 路径图已搬去 app-flow.js（DiagFlow） */

  /* ------------------------------------------------------------ 导出 / 打印 */
  

  
  if (typeof window !== 'undefined') window.addEventListener('beforeprint', function () {
    document.querySelectorAll('details:not([open])').forEach(function (d) { d.setAttribute('open', ''); d.dataset.autoOpen = '1'; });
    if (S.pathCy) { S.pathCy.resize(); S.pathCy.fit(undefined, 20); }
  });
  if (typeof window !== 'undefined') window.addEventListener('afterprint', function () {
    document.querySelectorAll('details[data-auto-open]').forEach(function (d) { d.removeAttribute('open'); delete d.dataset.autoOpen; });
  });

  /* ------------------------------------------------------------ 启动 */
  

  async function init() {
    S.subject = detectSubject();
    applySubjectChrome();
    renderSkeleton();                       // 阶段 0：0ms，不等任何 fetch，先给出可看的界面
    /* 引擎与按需段（engine.js + app-flow.js）不在首屏 <script> 链上，也不再阻挡首屏：
     * 首屏列表/年级卡片只用 chapter.js 的纯函数与 topics-lite，所以这里只「开始」补载，
     * 不 await。真正要出题/出图（深链、点目标、点年级）时再等它（见下面 resolved 分支与 goFlow）。 */
    const engineReady = ensureFlowEngine().catch(function () { /* Lazy 已记 lazyFailed；调用点会走 renderFlowBlocked */ });
    try { await loadData(); } catch (e) {
      clearRoot();
      root.append(h('div', { class: 'card' }, h('h2', { class: 'err', text: '数据加载失败' }),
        h('p', null, String(e.message || e)),
        h('p', null, '请在项目根目录运行 ', h('code', { text: 'python3 -m http.server 8000' }), '，再访问 http://localhost:8000/diagnose/ （不能直接用 file:// 打开）。')));
      return;
    }
    renderStart();                          // 阶段 1：知识库清单（topics-lite）到货，选题界面可用
    const params = new URLSearchParams(location.search);
    /* 深链（?target= / ?chapter= / ?grade=）要先出题，而 resolveTargets / 出题都在按需段里，
     * 所以只有这几种 URL 才等 engineReady；普通访问不等（首屏因此可以比 engine.gz 先到）。 */
    if (params.get('target') || params.get('chapter') || params.get('grade') || params.get('volume') || params.get('demo')) {
      await engineReady;
    }
    let resolved = null;
    const rTargets = flow('resolveTargets');
    try { resolved = rTargets ? rTargets(params) : null; } catch (e) { renderStart(e.message); return; }
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
      const mkO = flow('makeOracle');
      S.demo = { oracle: mkO ? mkO(resolved.ids, resolved.mode) : null };
      S.session = E.createSession(S.D.graph, resolved.ids, {
        mode: resolved.mode, limit: limit || (resolved.mode === 'screen' ? getSettings().screenLimit : getSettings().limit),
        confirm: getSettings().confirm, seed: S.seedParam == null ? 'demo' : S.seedParam
      });
      S.sessionMeta = { label: resolved.label };
      const step = parseInt(params.get('step'), 10);
      const rd = flow('runDemo'); if (rd) rd(step >= 0 ? step : Infinity);
      const rr = flow('render'); if (rr) rr();
      return;
    }
    if (resolved) {
      const en = flow('enter'); if (en) en(resolved.ids, resolved.label, limit, resolved.mode);
      return;
    }
    /* 其余辅助模块不在首屏链上（见 index.html）：首屏列表画完 / 深链处理完后按依赖顺序补载。
     * children.js 提供 CC（孩子档案）、blindspots.js 提供 CnmBlind（薄弱点）、
     * llm-config.js 提供 LLMConfig（讲解/画板网关）、stats/stats-config/pwa 提供统计与安装。
     * 到货后若无进行中的会话就重绘首页，把 childBar / 薄弱点卡补上（CC 是 let，到货后刷新引用）。 */
    Lazy.load(['../assets/children.js', '../assets/blindspots.js', 'llm-config.js', '../assets/stats-config.js', '../assets/stats.js', '../assets/pwa.js']).then(function () {
      CC = Browser.CnmChildren;   // children.js 到货后刷新缓存引用
      if (!S.session && !S.prac && !S.pracLoading) renderStart();
      maybeLLMBanner();
    }, function () { /* 辅助模块缺失/加载失败不影响主流程 */ });
    /* 没有深链参数：上面的 renderStart() 已经把选题界面画好了，不再重绘一次（避免闪一下） */
  }

  /* 原 index.html 内联的「未配置模型」引导横幅：llm-config.js 不再在首屏链上，到货后再触发。 */
  function maybeLLMBanner() {
    if (typeof window === 'undefined' || !window.LLMConfig || !location) return;
    try {
      if (window.LLMConfig.isConfigured && window.LLMConfig.isConfigured()) return;
      if (location.hostname === '127.0.0.1' || location.hostname === 'localhost') return;
      const main = document.getElementById('root');
      if (!main || !main.parentNode) return;
      const bar = document.createElement('div');
      bar.className = 'banner llm-banner no-print';
      bar.setAttribute('role', 'status');
      const a = document.createElement('a');
      a.href = 'settings.html';
      a.textContent = '还没设置模型 → 点这里设置';
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'llm-banner-close';
      close.setAttribute('aria-label', '关闭提示');
      close.textContent = '×';
      close.onclick = function () { if (bar.parentNode) bar.parentNode.removeChild(bar); };
      bar.appendChild(a);
      bar.appendChild(close);
      main.parentNode.insertBefore(bar, main);
    } catch (e) { /* 引导横幅失败不影响主流程 */ }
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
     *   resetQuestionsCache —— 用例之间清掉缓存/在途 Promise。
     * diagnosticOnlyRound / resultHeadline 已搬进 app-flow.js：Node 侧 require 转发（app-flow 也要 DiagCore）。 */
    var FLOW_MOD = require('./app-flow.js');
    module.exports = {
      routeReturnHref: routeReturnHref,
      askable: askable,
      loadBundle: loadBundle,
      diagnosticOnlyRound: FLOW_MOD.diagnosticOnlyRound,
      resultHeadline: FLOW_MOD.resultHeadline,
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
