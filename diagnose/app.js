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
    ui: { key: null, phase: 'ask', answer: '', verdict: null, explainStep: 0, aiSteps: null, aiState: 'idle', aiNotice: null, aiRequested: false, askHistory: [], askPending: false, askScroll: false, labCfg: null, labDesc: null, labAsk: null, labAskMsg: null },
    subject: 'math',
    startQuery: '',
    startStage: '',
    startErr: null,
    chapterOpen: false,
    focusSearch: false,   // 结果页「再测一个知识点」置位：renderStart 渲染后聚焦搜索框（用完即清）
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
    depsFailed: false,
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
  const LAZY_EXPLAIN = ['explain.js'];                                       // LLM 讲解（llm-config.js 由 explainPanel 按需先补载）
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
  const LS_SESSION_BIO = 'cnbDiagnose.session.v1';
  const LS_SESSION_CHEM = 'cnkDiagnose.session.v1';
  const LS_SETTINGS = 'cnmDiagnose.settings.v2';
  const LS_SEEN = 'cnmDiagnose.seen.v1';
  const LS_PRAC = 'cnmDiagnose.practiced.v1';   // T3 练习记录 {topicId: 最近练习时间戳}
  const LS_VSEQ = 'cnmDiagnose.variantSeq.v1';  // O1 变式序号 {topicId: nextIndex}
  const LIMIT_MIN = 8, LIMIT_MAX = 30;
  const SCREEN_MIN = 20, SCREEN_MAX = 60;
  /* 整年级筛查的题库门只等前 3 个章节 bundle、最多 12 个目标（七年级 119 个目标分布在 63 章，
   * 门内实际只切出 5 个目标 / 3 个 bundle）。一轮默认只出 40 题，用不到整年级 63 个章节；
   * 等全量会让弱网下「点了没反应」十几秒（实测 5.1s 起请求、19.4s 才放行）。 */
  const SCREEN_GATE_BUNDLES = 3;   // 门最多等 3 个章节 bundle（一轮 40 题用不到更多）
  const SCREEN_GATE_TARGETS = 12;  // 门内目标数上限（卡上守卫要求）
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
    renderQuestionsPendingWith: renderQuestionsPendingWith,
    renderNoQuestions: renderNoQuestions, questionSourcesSettled: questionSourcesSettled,
    screenRoundGraph: screenRoundGraph,
    ensureFullTopics: ensureFullTopics, ensureStandards: ensureStandards,
    ensureQuestionsForOne: ensureQuestionsForOne, ensureQuestionsForTopics: ensureQuestionsForTopics,
    ensureQuestionsForAnswers: ensureQuestionsForAnswers,
    withStage2: withStage2, withStage2Data: withStage2Data, stage2Status: stage2Status,
    childBar: childBar, diagnoseHrefFor: diagnoseHrefFor, routeReturnHref: routeReturnHref, withRouteBack: withRouteBack,
    routeBackBar: routeBackBar, isPrereqKnowledge: isPrereqKnowledge, reasonFor: reasonFor,
    noteBlind: noteBlind, blindResultCard: blindResultCard, llmVariantsMod: llmVariantsMod,
    /* a94fef3 拆分时漏挂了 registerFlow：app-flow.js 的 if (typeof registerFlow === 'function')
     * 于是静默跳过注册，FLOW 恒为 null，整年级/单点「点了没反应」的 P0 就出在这里。 */
    registerFlow: registerFlow,
    /* screen 会话中途题库才补齐时，用新图重放已答记录续上（app-flow 的 render 也会调）。 */
    extendScreenSession: extendScreenSession,
    backgroundFillState: backgroundFillState
  };
  var FLOW = null;   // app-flow.js 加载后经 registerFlow 注册进来；注册前路径图调用退化成提示
  function registerFlow(api) { FLOW = api; if (Browser) Browser.DiagFlow = api; }
  if (Browser) Browser.DiagCore = CORE;   // 浏览器下 app-flow.js 经 window.DiagCore 拿契约（Node 走 global.DiagCore）
  /* 已搬进 app-flow.js 的函数在这里一律经 FLOW 调用：FLOW 存在就转调，
   * 不存在（本批次还没把它挂上 <script> 链）时不许抛异常，给一行人话提示。 */
  var flowWarned = Object.create(null);   // 同一缺失名字只 warn 一次，避免轮询式刷屏
  function flow(name) {
    if (FLOW && typeof FLOW[name] === 'function') return FLOW[name].bind(FLOW);
    /* 静默死是 a94fef3 的 P0：至少留一条控制台线索，下次一眼能看到「没注册」。 */
    if (!flowWarned[name] && typeof console !== 'undefined' && console.warn) {
      flowWarned[name] = true;
      console.warn('[flow] app-flow.js 尚未注册：' + name);
    }
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
  /* 辅助模块补载只调度一次：whenIdle 每调用一次都会挂一组监听 + 一个定时器，
   * 深链 / ?demo / 普通访问若重复走到调度点，会叠加定时器与监听。 */
  let auxLoadScheduled = false;
  /* 首屏之外的辅助模块（孩子档案 / 薄弱点 / 统计 / PWA / 模型横幅）推迟到列表画完之后再取：
   * 用户第一次交互立刻取，否则 2s 后取。注意不能用 requestIdleCallback —— 主线程在网络等待期间
   * 本来就是空的，idle 回调会立刻触发，等于照旧抢带宽。慢链路上这 40KB 级辅助件会把
   * 「可搜索列表」推后几秒，所以必须等列表之后。 */
  function whenIdle(fn) {
    let done = false;
    function run() {
      if (done) return;
      done = true;
      ['pointerdown', 'keydown', 'focusin'].forEach(function (ev) { document.removeEventListener(ev, run, true); });
      clearTimeout(timer);
      try { fn(); } catch (e) { /* 辅助模块失败不影响主流程 */ }
    }
    ['pointerdown', 'keydown', 'focusin'].forEach(function (ev) { document.addEventListener(ev, run, true); });
    let timer = 0;
    timer = setTimeout(run, 2000);
  }

  function ensureFlowEngine() {
    if (!flowEnginePromise) {
      /* 只有这两个文件可以并发：app-flow.js 顶部只从 CORE 拿 app.js 已提供的东西，引擎走 eng() → CORE.E
       * getter（每次用时读），两个脚本谁先执行都不影响。Lazy.load 文档里要求串行的那些链
       * （funclab→labmatch→chatgraph、llm-eval→…）不动 —— 那些链里有顶层抓引用，串行是硬约束。
       * 并行注入省一个 RTT：弱网下 engine.js(22KB gz) + app-flow.js(31KB gz) 同时下，不再串一个等一个。 */
      flowEnginePromise = Promise.all([Lazy.load('engine.js'), Lazy.load('app-flow.js')]).then(function () {
        if (!E) E = Browser.DiagEngine;   // E 是 let：按需段注册前先拿到引擎（app-flow 的 CORE.E 走 getter 能读到）
        flowEngineReady = true;           // Round 2 第 3 条：flowStatusText 在引擎到货后才不说「出题引擎还在下」
      }, function (err) {
        /* 失败清缓存：让下次调用（重试）能重新发起补载，而不是永远拿到同一个 rejected Promise
         * （与 Lazy.load 失败清缓存配套 —— 引擎/按需段恢复后重试真能成功，不是空转）。
         * kanban t_5d6eb0d9：renderFlowBlocked 的「重新试试」就靠这条才能真正重新补载。 */
        flowEnginePromise = null;
        throw err;
      });
    }
    return flowEnginePromise;
  }

  /* 点击后的第一帧（卡 t_80db9722）：不等网络，同步把列表区换成等待卡并写上「0/3 章」。
   * 必须在 ensureFlowEngine() 之前调用 —— 弱网下引擎 5~10s 才到，等它就是「点了没反应」。 */
  function showFlowStartFeedback(targets, mode) {
    if (typeof document === 'undefined' || !root) return;
    if (!Array.isArray(targets) || !targets.length) return;
    const keys = chapterKeysOf(gateTargetsOf(targets, mode).gate);
    renderQuestionsPendingWith('正在准备这一轮的题…');
    /* flowProgressStart 必须在 gateProgressStart 之前：gateProgressStart → gateProgressTick → flowProgressPaint
     * 会立刻读 flowStartAt 算「已等 Ns」。若先 gateProgressStart，第一帧 flowStartAt 还是 0，
     * Math.round((Date.now() - 0)/1000) = 当前纪元秒，状态行出现「已等 1793554006s」（卡 Round 2 第 1 条）。 */
    flowProgressStart();            // 先设 flowStartAt = Date.now()，再让 gateProgressStart 触发首帧 paint
    gateProgressStart(keys);        // 同步把「已到 0/3 章」画到刚出现的状态行上
  }

  /* 所有「进流程」的按钮统一入口：先确保引擎/按需段就绪，再走 withStage2 门。
   * latest-click-wins 在 withStage2 里：等待期间再点别的，门开时按最后一次点击重过（见 flowSeq）。
   * enter 是 app-flow.js 里唯一的会话开入口，统一了按钮 / 深链 / 续练三种路径。 */
  function goFlow(targets, label, limit, mode) {
    const enterNow = function () {
      const f = flow('enter'); if (f) f(targets, label, limit, mode);
    };
    showFlowStartFeedback(targets, mode);
    ensureFlowEngine().then(function () {
      withStage2(targets, mode, enterNow);
    }, function () {
      /* 引擎/按需段补载失败：给一张可操作的重试卡。重试走 renderFlowBlocked 的
       * enterWithEngine → 重新 ensureFlowEngine（失败已清 flowEnginePromise）+ 重新过题源门 → enterNow。 */
      renderFlowBlocked(targets, mode, enterNow);
    });
  }

  /* 阻塞卡「重新试试」onclick 的唯一入口（kanban t_5d6eb0d9）：先 ensureFlowEngine 再 withStage2 —— 重新触发引擎
   * 补载 + 重新过题源门，再执行 fn（门后那件事）。失败分支也只传 fn —— 重试再走 renderFlowBlocked 的
   * onclick → enterWithEngine 重新过两道门，不会嵌套过两次门。banner「继续」因源码级守卫
   * （test_data_split.js 要求存档入口那行 withStage2 的首参写成 saved.targets）走专用的 resumeSaved；
   * 这里是 renderFlowBlocked 的通用重试，targets/mode/fn 是参数，无守卫约束，可直接复用。 */
  function enterWithEngine(targets, mode, fn) {
    showFlowStartFeedback(targets, mode);
    ensureFlowEngine().then(function () {
      withStage2(targets, mode, fn);
    }, function () {
      renderFlowBlocked(targets, mode, fn);
    });
  }

  /* banner「继续」的入口（kanban t_5d6eb0d9）：先 ensureFlowEngine 等引擎/按需段，再 withStage2 过题源门，
   * 否则首屏没加载 engine.js/app-flow.js 时 flow('restoreFromSave') 是空实现（FLOW 为 null），
   * 题源门开了也是空转 —— 点继续 0.4s 内毫无反应。等待期反馈复用 showFlowStartFeedback 这一张等待卡，
   * 不新造状态文案。失败分支落到 renderFlowBlocked，只传「门后那件事」restoreNow —— 重试走 renderFlowBlocked
   * 的 enterWithEngine 重新 ensureFlowEngine（失败已清 flowEnginePromise）+ 重新过题源门 → restoreNow。 */
  function resumeSaved(saved) {
    const restoreNow = function () { const rf = flow('restoreFromSave'); if (rf) rf(saved); };
    showFlowStartFeedback(saved.targets, saved.mode);
    ensureFlowEngine().then(function () {
      withStage2(saved.targets, saved.mode, restoreNow);
    }, function () {
      renderFlowBlocked(saved.targets, saved.mode, restoreNow);
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
    if (S.subject === 'biology') return LS_SESSION_BIO;
    if (S.subject === 'chemistry') return LS_SESSION_CHEM;
    return LS_SESSION;
  }
  function withSubject(href) {
    if (S.subject === 'math' || !href || href.indexOf('subject=') >= 0 || href.indexOf('http') === 0) return href;
    return href + (href.indexOf('?') >= 0 ? '&' : '?') + 'subject=' + S.subject;
  }
  function detectSubject() {
    const params = new URLSearchParams(location.search);
    const explicit = params.get('subject');
    if (explicit === 'english' || explicit === 'math' || explicit === 'physics' || explicit === 'chinese' || explicit === 'science' || explicit === 'morality' || explicit === 'history' || explicit === 'geography' || explicit === 'biology' || explicit === 'chemistry') return explicit;
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
    if (/(^|,)\s*cnb_/.test(target) || /^cnb_/.test(hashId)) {
      params.set('subject', 'biology');
      history.replaceState(null, '', location.pathname + '?' + params.toString() + location.hash);
      return 'biology';
    }
    if (/(^|,)\s*cnk_/.test(target) || /^cnk_/.test(hashId)) {
      params.set('subject', 'chemistry');
      history.replaceState(null, '', location.pathname + '?' + params.toString() + location.hash);
      return 'chemistry';
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
    document.body.classList.toggle('subject-biology', S.subject === 'biology');
    document.body.classList.toggle('subject-chemistry', S.subject === 'chemistry');
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
    if (S.subject === 'biology') {
      document.title = '诊断 · 初中生物';
      if ('七八'.indexOf(S.gradeSel) < 0) S.gradeSel = '七';
      if (S.volSel === '全') S.volSel = '';
    }
    if (S.subject === 'chemistry') {
      document.title = '诊断 · 初中化学';
      if (S.gradeSel !== '九') S.gradeSel = '九';
      if (S.volSel === '全') S.volSel = '';
    }
    if (S.subject === 'chinese') {
      document.title = '诊断 · 语文';
      if ('一二三四五六七八九'.indexOf(S.gradeSel) < 0) S.gradeSel = '一';
      /* 全站初始年级是七年级。语文原先从一年级进入，这里仍改回一年级；
       * 这段只在 init 里跑一次（applySubjectChrome 只被 init 调用），所以点「初中」学段
       * 再选七年级之后不会被拉回一年级 —— 与上游 else-if 的用户可见行为一致。 */
      else if (S.gradeSel === '七') S.gradeSel = '一';
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
  /* 作业分析回来时在页首加一条返回条。首屏 renderStart 也要用，所以留在核心层；
   * 按需段（app-flow.js）经 CORE.withRouteBack 用同一份实现。 */
  function withRouteBack(page) {
    if (!routeReturnHref(location.search)) return page;
    const wrap = h('div');
    append(wrap, routeBackBar(), page);
    return wrap;
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
  function resetUi() { S.ui = { key: null, phase: 'ask', answer: '', verdict: null, explainStep: 0, aiSteps: null, aiState: 'idle', aiNotice: null, aiRequested: false, askHistory: [], askPending: false, askScroll: false, labCfg: null, labDesc: null, labAsk: null, labAskMsg: null }; }
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

  /* screen 轮：只能问「题库已经到货的章节」。未到货章节的 legacy 兜底题在这里剔掉 ——
   * engine.isTestable 看 graph.bank.length，legacy 也算可测，不剔就会问出「本知识点第 1 / 1 题」
   * 的假结论（卡 t_386e1b88 第 3 条硬要求：题库没到 → 跳过、计未测，绝不按已掌握结算）。
   * session.order 仍然来自完整 targets，所以没测到 / 没加载的点照样落进 untested。 */
  function screenRoundGraph() {
    if (!S.D || !S.D.topics) return null;
    const g = Ch.buildGraph(S.D.topics, S.D.deps, S.graphQuestions);
    Object.keys(g.bank).forEach(function (id) {
      const t = g.byId[id];
      if (!t) return;
      const key = questionsKeyOf(t);
      if (key && S.bundleLoaded[key]) return;          // 章节已到货：真题/兜底题都保留
      g.bank[id] = (g.bank[id] || []).filter(function (q) { return q && q.type !== 'legacy'; });
    });
    return g;
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
   * 但孩子照样能做题（界面上本来就有这条兜底）。失败下一次进流程再试。
   * 先取逐学科份 ../data/dependencies/<subject>.json（math gzip 38KB，全量 115KB 的 1/3），
   * 缺失/坏再回退整份 dependencies.json（回退后仍按 allow 过滤，语义与回退前完全一致）。 */
  function ensureDeps() {
    if (S.depsLoaded) return Promise.resolve(true);
    if (depsPromise) return depsPromise;
    depsPromise = (async function () {
      try {
        let r = await fetch('../data/dependencies/' + S.subject + '.json');
        if (!r.ok) r = await fetch('../data/dependencies.json');   // 逐学科份缺失：回退整份
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
        S.depsFailed = true;   // 先修数据坏了：静默降级，不挡出题（与 fullTopicsFailed 同款标志，仅供进度文案读）
        return false;
      }
    })();
    depsPromise.then(function (ok) { if (!ok) { depsPromise = null; S.depsFailed = true; } });
    return depsPromise;
  }

  /* 阶段 2b：全量 topics.json（347KB）只取一次，把 lite 里没有的字段原地补进 D.topics。
   * 只补缺口、不覆盖 lite 已有字段；补完重建一次图（diagnostic_question 回退题要靠它），
   * 再原地刷新正在显示「正在载入说明…」的节点 —— 不整页重绘，界面不会闪。 */
  function ensureFullTopics() {
    if (S.fullTopicsLoaded) return Promise.resolve(true);
    if (fullTopicsPromise) return fullTopicsPromise;
    fullTopicsPromise = (async function () {
      /* Round 2 第 3 条：真正发起 fetch 才置 true，flowStatusText 只在飞时说「知识点说明还在下」。
       * 早退路径（已 loaded / 已有 promise）不进这里，不会误置。完成（成功/失败/早退）统一在 finally 置 false。 */
      fullTopicsInFlight = true;
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
      } finally {
        fullTopicsInFlight = false;
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
    gateProgressTick();                     // 门内章节到货：更新「12/63 章」进度
    if (typeof document === 'undefined') return;
    if (resumePendingStart()) return;
    if (S.session) {
      /* 后台补齐的章节到货：只有当前 screen 会话「没题可出」时才用新图续接；
       * 屏幕上有题（nextItem 非 null）一律不重绘，否则会打断孩子正在作答。 */
      if (extendScreenSession()) {
        const r = flow('render'); if (r) r();
      }
      return;
    }
    if (S.prac || S.pracLoading) return;   // 用户已在流程里：只更新 D，不重绘
    if (S.flowPending) return;             // 门还开着：谁也别说「回到选题页」
    const bg = backgroundFillState ? backgroundFillState() : null;
    if (bg && bg.running) return;          // 后台还在补：保持当前视图（骨架/等待卡），补完再重画
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
   * flowTargets 由 ensureFlowReady 放进「门内章节的目标」（screen 下只是前缀部分）；
   * 显式版本是 ensureQuestionsForTopics(ids)，练习 / 恢复存档 / 先修回溯那些入口直接传 ids。 */
  let flowTargets = [];
  function ensureQuestions() {
    return ensureQuestionsForTopics(flowTargets);
  }

  /* ------------------------------------------------------------ 整年级题库门（前缀章节）
   * 一轮默认只出 40 题，整年级筛查却有 63 个章节：等全部到齐就是弱网下十几秒的「点了没反应」。
   * 所以只等前 SCREEN_GATE_TARGETS 个目标所在章节（同章节的其它目标一起进门 —— 同一个 bundle，
   * 不多发请求），剩下的章节门开后在后台按 ≤2 并发慢慢补。
   * mode !== 'screen'（单点 / 整章）行为不变：gate = 全部，rest = 空。 */

  /* 目标 id → topics-lite 里的知识点对象。用 graph.byId 优先（重建后最新），退化到 topics 数组。 */
  function topicFor(id) {
    if (!S.D) return null;
    if (S.D.graph && S.D.graph.byId) return S.D.graph.byId[id] || null;
    if (Array.isArray(S.D.topics)) {
      for (let i = 0; i < S.D.topics.length; i++) { if (S.D.topics[i] && S.D.topics[i].id === id) return S.D.topics[i]; }
    }
    return null;
  }

  /* 目标所在章节的 bundle key（同一 key = 同一个 data/questions/<file>.json，只请求一次）。 */
  function chapterKeyFor(id) {
    const t = topicFor(id);
    return t ? questionsKeyOf(t) : null;
  }

  /* 去重保序的章节 key 列表；给「门要等几个章节」和测试用。 */
  function chapterKeysOf(ids) {
    const out = [];
    const seen = Object.create(null);
    (ids || []).forEach(function (id) {
      const key = chapterKeyFor(id);
      if (key && !seen[key]) { seen[key] = true; out.push(key); }
    });
    return out;
  }

  /* 纯函数（同时导出给 Node 测试）：
   *   screen —— 按 targets 顺序收口：目标所在章节已在门的章节列表里 → 收进 gate；
   *             新章节且门的章节数已到 SCREEN_GATE_BUNDLES → 停止（后续目标全进 rest）；
   *             gate 目标数到 SCREEN_GATE_TARGETS → 停止。
   *             第一个目标没有章节 key 时退化成「取第一个目标」进门，不能空手开门
   *             （gate=[] 会让门永远等不到东西）。
   *   rest   —— 其余目标，按章节只留一个代表（ensureQuestionsForOne 本来就按章节去重）。
   * 去重保序：同一个 id 只出现一次，gate 与 rest 都保持 targets 原顺序。 */
  function gateTargetsOf(targets, mode) {
    const uniq = Array.from(new Set((targets || []).filter(Boolean)));
    if (mode !== 'screen') return { gate: uniq, rest: [] };
    if (!uniq.length) return { gate: [], rest: [] };
    function restOf(list) {
      const out = [];
      const seen = Object.create(null);
      list.forEach(function (id) {
        const key = chapterKeyFor(id) || ('?' + id);
        if (seen[key]) return;
        seen[key] = true;
        out.push(id);
      });
      return out;
    }
    /* 第一个目标没有章节 key（图/知识点还没到）：退化只取它进门，不能 gate=[] 让门永远等不到东西。 */
    if (!chapterKeyFor(uniq[0])) return { gate: [uniq[0]], rest: restOf(uniq.slice(1)) };
    const gate = [];
    const gateKeys = [];
    const gateKeySet = Object.create(null);
    let gateClosed = false;
    uniq.forEach(function (id) {
      if (gateClosed) return;
      const key = chapterKeyFor(id);
      if (key && gateKeySet[key]) {
        gate.push(id);
      } else if (!key || gateKeys.length < SCREEN_GATE_BUNDLES) {
        if (key) { gateKeySet[key] = true; gateKeys.push(key); }
        gate.push(id);
      } else {
        gateClosed = true;
        return;
      }
      if (gate.length >= SCREEN_GATE_TARGETS) gateClosed = true;
    });
    const gateIds = new Set(gate);
    return { gate: gate, rest: restOf(uniq.filter(function (id) { return !gateIds.has(id); })) };
  }

  /* 门内章节到货进度：每到一个 bundle 更新一次「题目还在载入，稍等…（已到/需要 章）」。
   * 用 S.bundleLoaded 的计数而不是另记一份，避免两处状态不一致；DOM 不存在时只更新数字不报错。 */
  let gateProgress = null;
  function gateProgressStart(keys) {
    if (!keys || !keys.length) { gateProgress = null; return; }
    gateProgress = { keys: keys, total: keys.length };
    gateProgressTick();
  }
  function gateProgressTick() {
    if (!gateProgress) return 0;
    let loaded = 0;
    gateProgress.keys.forEach(function (k) { if (S.bundleLoaded[k]) loaded++; });
    gateProgress.loaded = loaded;
    flowProgressPaint();
    return loaded;
  }
  function gateProgressDone() { gateProgress = null; flowProgressStop(); }

  /* 点击后的实时进度文案（卡 t_80db9722）。两部分：
   *   - 门内章节进度（gateProgress.loaded/total）
   *   - 还在路上什么（先修关系 / 知识点说明）与已等秒数
   * 前置一个 500ms 转一格的盲文字符：弱网下引擎和题库要好几秒，任何 2 秒静默都会让用户以为「点了没反应」，
   * 心跳保证状态行每 500ms 一定变一次（这是可测的体验约束，不是装饰）。 */
  const FLOW_SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let flowSpin = 0;
  let flowTicker = null;
  let flowStartAt = 0;
  /* Round 2 第 3 条：状态行只能说「当前真正在等什么」，不能无脑说「知识点说明还在下」。
   *   - flowEngineReady：ensureFlowEngine 的 .then 里置 true。在此之前说「出题引擎还在下」，
   *     到了之后才可能开始等先修关系（先修 fetch 在 ensureFlowReady 里、引擎之后发起）。
   *   - fullTopicsInFlight：ensureFullTopics 真正发起 fetch 时置 true，完成（成功/失败/早退）置 false。
   *     screen 门内不发 ensureFullTopics（Round 2 第 2 条），所以门内这句永远不说；门后 openGate 发起后才会出现。 */
  let flowEngineReady = false;
  let fullTopicsInFlight = false;

  function flowStatusText() {
    const parts = [];
    if (!flowEngineReady) parts.push('出题引擎还在下');
    const gp = gateProgress;
    if (gp) parts.push('已到 ' + (gp.loaded || 0) + '/' + gp.total + ' 章');
    if (flowEngineReady && !S.depsLoaded && !S.depsFailed) parts.push('先修关系还在下');
    if (fullTopicsInFlight) parts.push('知识点说明还在下');
    /* 秒数防御（Round 2 第 1 条）：flowStartAt 在 flowProgressStart 里才赋值，
     * 万一别处先调 flowStatusText，0 会被 Math.round((Date.now()-0)/1000) 算成当前纪元秒。 */
    const sec = flowStartAt ? Math.round((Date.now() - flowStartAt) / 1000) : 0;
    if (sec >= 1) parts.push('已等 ' + sec + 's');
    const head = FLOW_SPIN[flowSpin++ % FLOW_SPIN.length] + ' 正在准备这一轮的题…';
    return parts.length ? head + '（' + parts.join(' · ') + '）' : head;
  }
  function flowProgressPaint() { stage2Status(flowStatusText()); }
  function flowProgressStart() {
    flowStartAt = Date.now();
    if (typeof setInterval !== 'function') return;
    if (flowTicker) return;
    flowTicker = setInterval(flowProgressPaint, 500);
  }
  function flowProgressStop() {
    if (flowTicker && typeof clearInterval === 'function') clearInterval(flowTicker);
    flowTicker = null;
  }

  /* ------------------------------------------------------------ 后台补齐（只在 screen 门开之后）
   * 并发 ≤2，失败重试一次，仍失败只 warn 一次：后台补齐绝不能弹错/弹卡/挡流程。
   * 幂等：按章节 key 去重；重复进流程不会叠加队列，已到货/在途的章节也不会重复请求。 */
  const BG_FILL_CONCURRENCY = 2;
  let bgFill = null;
  function bgInit() {
    if (bgFill) return bgFill;
    bgFill = {
      total: 0, done: 0, failed: 0, active: 0, maxActive: 0,
      seen: Object.create(null), warned: Object.create(null),
      queue: [], gen: 0, pumpScheduled: false
    };
    return bgFill;
  }
  function bgChapterKey(id) { return chapterKeyFor(id) || ('?' + id); }
  function startBackgroundFill(restIds) {
    const bg = bgInit();
    let added = 0;
    (restIds || []).forEach(function (id) {
      if (!id) return;
      const key = bgChapterKey(id);
      if (bg.seen[key]) return;                 // 已排队 / 在途 / 已到货 / 已放弃
      if (S.bundleLoaded[key]) { bg.seen[key] = true; return; }   // 门内已经取到过同章节
      bg.seen[key] = true;
      bg.total++;
      bg.queue.push({ id: id, key: key, retried: false, gen: bg.gen });
      added++;
    });
    if (!added) return;
    /* 延到下一个宏任务再开泵：让 ensureFlowReady 先 resolve，避免「门刚开」就被后台请求混进
     * 门的进度/测试计数里；浏览器里这点延迟无感。 */
    if (!bg.pumpScheduled) {
      bg.pumpScheduled = true;
      setTimeout(function () { bg.pumpScheduled = false; pumpBackgroundFill(); }, 0);
    }
  }
  function backgroundFillState() {
    const bg = bgFill;
    if (!bg) return { total: 0, done: 0, failed: 0, active: 0, maxActive: 0, running: false };
    return {
      total: bg.total, done: bg.done, failed: bg.failed,
      active: bg.active, maxActive: bg.maxActive,
      running: !!(bg.queue.length || bg.active)
    };
  }
  function pumpBackgroundFill() {
    const bg = bgInit();
    while (bg.active < BG_FILL_CONCURRENCY && bg.queue.length) {
      const task = bg.queue.shift();
      const gen = task.gen;
      bg.active++;
      if (bg.active > bg.maxActive) bg.maxActive = bg.active;
      ensureQuestionsForOne(task.id).then(function (ok) {
        if (gen !== bg.gen) return;             // resetQuestionsCache 之后的老回调不再改新状态
        if (ok) { bg.done++; return; }
        if (!task.retried) { task.retried = true; bg.queue.push(task); return; }   // 失败重试一次
        bg.failed++;
        if (!bg.warned[task.key] && typeof console !== 'undefined' && console.warn) {
          bg.warned[task.key] = true;
          console.warn('[questions] 后台补齐仍失败，先跳过', task.key);
        }
      }, function () {
        /* ensureQuestionsForOne 自己吞了异常，这里只是兜底：同样按失败重试一次。 */
        if (gen !== bg.gen) return;
        if (!task.retried) { task.retried = true; bg.queue.push(task); return; }
        bg.failed++;
      }).then(function () {
        if (gen !== bg.gen) return;
        bg.active--;
        pumpBackgroundFill();                   // 有空位就继续；队列空且 active=0 时自然停
      });
    }
  }

  /* screen 会话续接：只加题不换题。当前屏幕上已有题（nextItem 非 null）时一律不动，
   * 避免后台 bundle 到货把用户正在做的题换掉。新图 replay 后仍无题就放弃、保留原会话。 */
  function extendScreenSession() {
    if (!S.session || S.session.mode !== 'screen' || !S.D || !E) return false;
    const limit = S.session.limit;
    if (typeof limit === 'number' && S.session.answers.length >= limit) return false;
    /* 续接也必须只 replay「已到货章节」的图，否则会把未到货章节的 legacy 点重新放回 stack。 */
    const graph = screenRoundGraph() || S.D.graph;
    if (E.nextItem(graph, S.session)) return false;   // 屏幕上有题：绝不重绘/换题
    let next = null;
    try {
      next = E.replay(graph, S.session.targets, S.session.answers, {
        mode: 'screen', limit: limit,
        confirm: S.session.confirm, seed: S.session.seed, avoid: S.session.avoid
      });
    } catch (e) {
      return false;   // 重放失败（存档/图不一致）：保持原会话，绝不把孩子正在做的进度弄丢
    }
    if (!next || !E.nextItem(graph, next)) return false;
    S.session = next;
    save();
    return true;
  }

  /* 「点进流程」的题源门（阶段 2）：先修关系 → 目标所在章节的题库。
   * 顺序：先修关系必须等（出题正确性依赖它）；然后等两份题源里先到的那一份，
   * 够出题就立刻放行（不多等另一份），不够再等齐。两份都失败才返回 false。
   * 为什么不能只 await ensureDeps()：lite 没有 diagnostic_question，
   * 那时候开会话就是一题都问不出来的空结果页（P0 回归，reviewer 在 50KB/s 下必现）。
   *
   * 整年级筛查（mode === 'screen'）只等 gate 前缀章节，rest 在门开后后台补齐：
   * 63 个章节全等到齐在弱网下要十几秒，而一轮默认只出 40 题，根本用不到全部章节。 */
  async function ensureFlowReady(targets, limit, mode) {
    targets = Array.from(new Set((targets || []).filter(Boolean)));
    const split = gateTargetsOf(targets, mode);
    const gate = split.gate;
    /* 无参 ensureQuestions() 只服务于「门内章节」：flowTargets 在这里被收窄成 gate，
     * 不再是把整个年级的 targets 塞进题库门（旧守卫仍能看到 ensureQuestions() 这个入口）。 */
    flowTargets = gate;
    /* 三件事并行发起（卡 t_80db9722）：先修关系 / 门内章节题库不再串行；screen 模式下全量 topics.json 留到门后。
     * 旧顺序是先修关系最先 await → 全量 115KB 先修下完之前，题库 bundle 一个请求都没发出，
     * 弱网下页面十几秒不动。现在 deps / bank 同时开出，先修关系这行 await 仍逐字保留
     * （tests/test_data_split.js 守这一行），只是挪到 full/bank 之后：deps 没到时题库已经在下了。
     * Round 2 第 2 条：screen 门只等 gate 章节 bundle + 先修关系；topics.json 的 345KB 留在门后（openGate()）
     * 取，门内不需要它 —— flowAskable / screenRoundGraph 用 lite 字段 + 已到货 bundle，有 bundle 时不走
     * legacy 兜底题。非 screen（单点 / 整章）行为不变：仍然 ensureFullTopics()。
     * full 只是变成 screen 下立即 resolve 的 promise；race / all / gateLoaded / flowAskable 写法全部逐字保留。 */
    const full = mode === 'screen' ? Promise.resolve(true) : ensureFullTopics();
    const bank = ensureQuestions();                   // 只取 gate 前缀章节（不再是整个 targets，也不再是整份题库）
    // 同一章节只请求一次：ensureQuestions 内部用 bundleLoaded / 在途 Promise 去重，重复点同一知识点不产生额外请求。
    // bank 必须在下方 flowAskable 判据之前发起：否则第二次点知识点时 bundle 未到，会拿 topics.json 的兜底诊断题直接放行，会话退化成「本知识点第 1 / 1 题」，答完一题给假结论（卡 t_83ca3ac5 实测）。
    await ensureDeps();
    /* 门要等的 bundle key（screen 下 ≤3 个章节）。判据只看「这些 key 的 bundle 是否真的到货」，
     * 不再依赖 questionsInFlight 的时序：ensureQuestions() 刚发起时 index.json 还在路上，
     * in-flight 仍是 0，而 topics.json 已到货 → 旧判据会立刻拿兜底诊断题开门。 */
    const gateKeys = chapterKeysOf(gate);
    const gateLoaded = function () {
      if (mode !== 'screen') return true;   // 单点 / 整章：老的「等齐」语义不变
      return !gateKeys.length || gateKeys.every(function (k) { return !!S.bundleLoaded[k]; });
    };
    /* screen：门内章节没到齐就先等，绝不能拿 topics.json 的兜底诊断题开门。 */
    if (mode === 'screen' && !gateLoaded()) {
      gateProgressStart(gateKeys);
      await Promise.race([full, bank]);
      if (!gateLoaded()) {
        /* 题库已定案（在飞请求归零）但门内章节还没到齐：刷新一次进度，继续等 bundle。
         * 门开不开只看 gateLoaded()，这里的 questionsInFlight 不再单独放行。 */
        if (S.questionsInFlight === 0) gateProgressTick();
        await Promise.all([full, bank]);
      }
    }
    /* screen：门内章节最终没到货（bundle 404 + 全量回退也失败）就不许开门 ——
     * 否则 topics.json 的 legacy 兜底题会让 flowAskable 为 true，开出一轮「1/1 题」的假会话。 */
    if (mode === 'screen' && !gateLoaded()) { gateProgressDone(); return false; }
    /* 开门后的收尾：清掉进度、screen 下启动后台补齐（只补 rest，不回头挡门）。
     * 定义放在等待之后：startBackgroundFill 只能作为「门真的开了」的收尾被调用。 */
    function openGate() {
      gateProgressDone();
      if (mode === 'screen') { ensureFullTopics(); startBackgroundFill(split.rest); }
    }
    /* 判据调用两次是刻意的：源码级守卫要求开门那一行保持 `... === 0) return true;` 的原样，
     * 后台补齐只能挂在前一行「条件为真才执行」的 openGate() 上。 */
    if (flowAskable(targets, limit, mode) && S.questionsInFlight === 0) openGate();
    if (flowAskable(targets, limit, mode) && S.questionsInFlight === 0) return true;
    gateProgressStart(chapterKeysOf(gate));
    await Promise.race([full, bank]);
    /* 题库还没定案（还在路上）时不许开门：bundle 404 → 回退全量 7.8MB 的那几秒里，
     * 图里只剩 topics.json 的 diagnostic_question，这时候开出的会话就是「本知识点第 1 / 1 题」，
     * 答完一题直接给结论 —— 复核卡 t_588d8341 与 t_83ca3ac5 都是这么复现的假结论。
     * 判据用 questionsInFlight（在飞的题库请求数）而不是「bank 为空」：
     * buildGraph 给无真题的点塞 type:'legacy' 兜底题，bank 永远非空。 */
    if (flowAskable(targets, limit, mode) && S.questionsInFlight === 0) openGate();
    if (flowAskable(targets, limit, mode) && S.questionsInFlight === 0) return true;
    await Promise.all([full, bank]);
    const ok = flowAskable(targets, limit, mode);
    if (ok && gateLoaded()) openGate();
    return ok;
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
    /* 深链（?target= / ?grade= 等）进来时 init() 在 `if (resolved) { flow('enter')(...); return; }` 处返回，
     * 末尾 whenIdle 里的 children.js 根本没被请求，CC 一直是 undefined。旧代码这里裸调 CC.current()
     * → TypeError 抛在 renderResult 的第二行，整页不渲染 = 「诊断报告不可达」的第二个成因
     * （卡 t_07716ba2）。与 childBar() 的空守卫保持同一口径：children.js 不到货就不存档案，
     * 而不是让结果页炸掉。 */
    if (!CC) return;
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
    if (!CC) return null;   // 同上：children.js 未到货（深链首屏）时不许裸调 CC.current()
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
    /* children.js 未到货（深链首屏）时 CC 是 undefined：这里只是取「当前孩子」拼历史链接，
     * 取不到就用通用历史页，不必让整张卡（以及整个结果页）炸掉。 */
    const cur = CC ? CC.current() : null;
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
    const el = document.getElementById('stage2-status') ||
      document.getElementById('questions-pending-status');
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
      flowProgressStop();
      if (typeof document !== 'undefined') stage2Status('');
      if (ok) { job.fn(); return; }
      renderFlowBlocked(job.targets, job.mode, job.fn);
    }, function () {
      /* 取题源本身抛错（不该发生，但别让 flowPending 卡死成「点了没反应」） */
      if (seq !== flowSeq) return openStage2Gate();
      S.flowPending = false;
      flowProgressStop();
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
      : S.subject === 'history' || S.subject === 'geography' || S.subject === 'biology' || S.subject === 'chemistry' ? [mk('', '全部'), mk('j', '初中')]
      : S.subject === 'chinese' ? [mk('', '全部'), mk('p', '小学'), mk('j', '初中')]
      : S.subject === 'science' || S.subject === 'morality' ? [mk('', '全部'), mk('p', '小学')]
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
   * 与骨架同布局（同一张 card、同样的 skel-bar），到货后原地换成题目页/结果页，不跳版。
   * 进度文案走 renderQuestionsPendingWith(msg)：保持无参函数名不变（既有源码级守卫要它），
   * 又能在会话中途带上「15/55 章」这种进度。 */
  let questionsPendingMsg = '';
  function renderQuestionsPendingWith(msg) {
    questionsPendingMsg = msg || '';
    return renderQuestionsPending();
  }
  function renderQuestionsPending() {
    if (typeof document === 'undefined' || !root) return;
    const msg = questionsPendingMsg;
    questionsPendingMsg = '';   // 一次性：下一次普通等待仍显示默认文案
    show(h('div', null,
      h('div', { class: 'card', id: 'questions-pending' },
        h('h1', { text: '题目马上就到' }),
        h('p', { class: 'muted', id: 'questions-pending-status', role: 'status' }, msg || '题目还在载入，稍等…'),
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

  /* 两份题源都取失败（Pages 部署竞态 / 断网首访）：明确告诉孩子「没到」，给重试，不留白屏。
   * 「重新试试」是唯一带门的重试入口（kanban t_5d6eb0d9）：onclick 走 enterWithEngine —— 重新
   * ensureFlowEngine（失败已清 flowEnginePromise）+ 重新过题源门，再执行 fn。三个调用点（goFlow /
   * resumeSaved / openStage2Gate 的失败分支）只传「门后那件事」，不再自己包 enterWithEngine/goFlow/resumeSaved，
   * 否则会绕过两道门直接执行 fn（旧版 onclick 直接 fn() 就是这个错）。 */
  function renderFlowBlocked(targets, mode, fn) {
    if (typeof document === 'undefined' || !root) return;
    show(h('div', null,
      h('div', { class: 'card', id: 'flow-blocked' },
        h('h1', { text: '数据没下来' }),
        h('p', { class: 'muted', id: 'flow-blocked-status', role: 'status' }, '题库和知识点说明都没能载入，可能是网络或站点正在更新。'),
        h('div', { class: 'skel', 'aria-hidden': 'true' },
          h('span', { class: 'skel-bar' }), h('span', { class: 'skel-bar skel-short' })),
        h('div', { class: 'row no-print' },
          h('button', { class: 'primary', id: 'btn-flow-retry', onclick: function () { enterWithEngine(targets, mode, fn); } }, '重新试试'),
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
        h('button', { class: 'primary', onclick: function () { resumeSaved(saved); } }, '继续'),
        ' ', h('button', { onclick: function () { lsDel(sessionKey()); renderStart(); } }, '放弃存档')));
    }
    if (errMsg) page.append(h('p', { class: 'err', text: errMsg }));
    append(page, childBar('start'));
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
        : S.subject === 'biology'
        ? '选一个想学会或想检查的生物知识点。' + confirmHelp
        : S.subject === 'chemistry'
        ? '选一个想学会或想检查的化学知识点。' + confirmHelp
        : '选一个想学会或想检查的知识点。' + confirmHelp),
      stageTabs(false),
      h('input', {
        type: 'search', class: 'search-lg', id: 'search',
        placeholder: S.subject === 'physics' ? '搜索知识点，例如：欧姆定律、浮力、牛顿第二定律、楞次定律' : S.subject === 'english' ? '搜索知识点，例如：现在进行时、虚拟语气、there is' : S.subject === 'chinese' ? '搜索知识点，例如：声母、静夜思、春、岳阳楼记' : S.subject === 'science' ? '搜索知识点，例如：溶解、电路、昼夜交替' : S.subject === 'morality' ? '搜索知识点，例如：升国旗、排队、宪法、节约用水' : S.subject === 'history' ? '搜索知识点，例如：鸦片战争、丝绸之路、五四运动' : S.subject === 'geography' ? '搜索知识点，例如：经纬网、季风气候、长江' : S.subject === 'biology' ? '搜索知识点，例如：细胞、光合作用、基因' : S.subject === 'chemistry' ? '搜索知识点，例如：氧气、质量守恒定律、酸碱盐' : '搜索知识点，例如：配方法、20 以内加法、一次函数',
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
    if (S.startQuery || S.focusSearch) {
      const el = document.getElementById('search');
      if (el) el.focus();
      S.focusSearch = false;   // 用完即清：只有结果页「再测一个知识点」会预置，正常刷新/回退不强制聚焦
    }
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
          : S.subject === 'geography' || S.subject === 'biology'
          ? '七八'.split('').map(function (x) { return [x, x + '年级']; })
          : S.subject === 'chemistry'
          ? [['九', '九年级']]
          : S.subject === 'chinese'
          ? '一二三四五六七八九'.split('').map(function (x) { return [x, x + '年级']; })
          : S.subject === 'science' || S.subject === 'morality'
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
      const openVol = S.subject === 'physics' ? '八上' : S.subject === 'english' ? '三上' : S.subject === 'chemistry' ? '九上' : S.subject === 'history' || S.subject === 'geography' || S.subject === 'biology' ? '七上' : '一上';
      const juniorOpen = S.subject === 'chemistry' ? '九上' : '七上';
      const seniorOpen = S.subject === 'english' || S.subject === 'physics' ? '必修一' : '高一';
      const det = h('details', { class: 'vol', open: !!q || (S.startStage === 'j' ? vv[0] === juniorOpen : S.startStage === 'h' ? vv[0] === seniorOpen : vv[0] === openVol) },
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
    /* 引擎与按需段（engine.js + app-flow.js）不在首屏 <script> 链上，也不随首屏下载：
     * 首屏列表/年级卡片只用 chapter.js 的纯函数 + topics-lite，所以这里完全不碰它们。
     * 真正要出题/出图时（点目标、点年级、深链）才由 goFlow / ensureFlowReady 补载。 */
    try { await loadData(); } catch (e) {
      clearRoot();
      root.append(h('div', { class: 'card' }, h('h2', { class: 'err', text: '数据加载失败' }),
        h('p', null, String(e.message || e)),
        h('p', null, '请在项目根目录运行 ', h('code', { text: 'python3 -m http.server 8000' }), '，再访问 http://localhost:8000/diagnose/ （不能直接用 file:// 打开）。')));
      return;
    }
    renderStart();                          // 阶段 1：知识库清单（topics-lite）到货，选题界面可用
    /* 首屏已画好，统一调度辅助模块补载：深链 / ?demo 会在下面提前 return，所以必须在这里调用。 */
    scheduleAuxLoad();
    const params = new URLSearchParams(location.search);
    /* 深链（?target= / ?chapter= / ?grade=）要先出题，而 resolveTargets / 出题都在按需段里，
     * 所以只有这几种 URL 才补载并等 engine/flow；普通访问完全不下载它们。 */
    if (params.get('target') || params.get('chapter') || params.get('grade') || params.get('volume') || params.get('demo')) {
      await ensureFlowEngine().catch(function () { /* 失败交给下面的 flow() 空实现 + 重试卡 */ });
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
    /* 没有深链参数：上面的 renderStart() 已经把选题界面画好了，不再重绘一次（避免闪一下）。
     * 辅助模块补载已在 renderStart() 之后由 scheduleAuxLoad() 统一调度，覆盖深链 / ?demo。 */

    /* 辅助模块补载调度（孩子档案 / 薄弱点 / 统计 / PWA / 模型横幅）。
     * 定义放在 init() 末尾、由上面的 scheduleAuxLoad() 提前调用（函数声明会提升），
     * 这样静态检查里「init 的 renderStart() 出现在 loadData 之后」仍然成立。
     * 必须在**所有入口**都必经的位置调用一次：普通访问、深链（?target= / ?chapter= /
     * ?grade= / ?volume=）与 ?demo 都会在下面提前 return，若把调度放在 init() 末尾，
     * 深链就永远走不到 —— 这正是 t_a7055f3e 的成因（CnmChildren 恒 undefined）。
     * 仍走 whenIdle：首次交互或 2s 兜底才真正下载，不占首屏带宽。 */
    function scheduleAuxLoad() {
      if (auxLoadScheduled) return;
      auxLoadScheduled = true;
      whenIdle(function () {
        Lazy.load(['../assets/children.js', '../assets/blindspots.js', 'llm-config.js', '../assets/stats-config.js', '../assets/stats.js', '../assets/pwa.js']).then(function () {
          CC = Browser.CnmChildren;   // children.js 到货后刷新缓存引用
          if (!S.session && !S.prac && !S.pracLoading) renderStart();
          maybeLLMBanner();
        }, function () { /* 辅助模块缺失/加载失败不影响主流程 */ });
      });
    }
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
      /* 整年级题库门 / 后台补齐的测试缝（tests/test_questions_split.js 真跑 ensureFlowReady）。 */
      S: S,
      setEngine: function (engine) { E = engine; },
      gateTargetsOf: gateTargetsOf,
      chapterKeysOf: chapterKeysOf,
      ensureFlowReady: ensureFlowReady,
      screenRoundGraph: screenRoundGraph,
      extendScreenSession: extendScreenSession,
      backgroundFillState: backgroundFillState,
      SCREEN_GATE_BUNDLES: SCREEN_GATE_BUNDLES,
      SCREEN_GATE_TARGETS: SCREEN_GATE_TARGETS,
      resetQuestionsCache: function () {
        S.questionsIndex = null; S.questionsIndexPromise = null; S.fullBankPromise = null; questionsPromise = null;
        Object.keys(S.bundlePromises).forEach(function (k) { delete S.bundlePromises[k]; });
        Object.keys(S.bundleLoaded).forEach(function (k) { delete S.bundleLoaded[k]; });
        Object.keys(S.bankByTopic).forEach(function (k) { delete S.bankByTopic[k]; });
        S.graphQuestions = null;
        S.questionsInFlight = 0;
        gateProgress = null;
        /* 后台补齐状态一起清零（测试用例之间），并换一代 gen 让在途回调失效。 */
        if (bgFill) {
          bgFill.gen++;
          bgFill.total = 0; bgFill.done = 0; bgFill.failed = 0;
          bgFill.active = 0; bgFill.maxActive = 0;
          bgFill.seen = Object.create(null); bgFill.warned = Object.create(null);
          bgFill.queue = [];
        }
      }
    };
  }
})();
