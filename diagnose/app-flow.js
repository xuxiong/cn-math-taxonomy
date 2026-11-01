/* 按需段 app-flow.js：出题 / 结果页 / 分享 / 练习 / 路径图等「进流程才运行」的函数。
 * 拆分的唯一目的是首屏字节：首屏 <script> 链上只留骨架 / 列表 / 课标（见 index.html）。
 * 经 DiagCore（app.js 顶部的 CORE）拿唯一的一份状态 S 与工具函数，不复制状态。
 * 加载时机：用户点进流程（goFlow）或深链 / 恢复时，由 app.js 的 ensureFlowEngine() 补载。
 * 全部代码注释用中文且说明 WHY。 */
(function (global, factory) {
  var api = factory(global);
  /* 注册失败必须出声：a94fef3 拆分时 CORE 漏挂 registerFlow，这里的 if 静默跳过，
   * FLOW 恒为 null → 点整年级/单点全都「没反应」。Node 直测也走这里，保证
   * require('../diagnose/app-flow.js') 后 DiagCore.flow('enter') 立刻可用。 */
  if (global.DiagCore && typeof global.DiagCore.registerFlow === 'function') global.DiagCore.registerFlow(api);
  else if (typeof console !== 'undefined' && console.warn) {
    console.warn('[flow] DiagCore.registerFlow 缺失，进流程会无反应', typeof (global.DiagCore && global.DiagCore.registerFlow));
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.DiagFlow = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (global) {
  'use strict';
  var CORE = global.DiagCore;
  if (!CORE) throw new Error('app-flow.js 需要先加载 app.js（DiagCore）');
  var S = CORE.S, Browser = CORE.Browser, h = CORE.h, Lazy = CORE.Lazy;
  /* 引擎不在首屏：app-flow 可能在 engine.js 之前加载，CORE.E 那时还是 undefined。
   * 抓成局部变量会永远 undefined（实测 "reading 'createSession'"：点了没反应的真身），
   * 所以每次用时再过一遍 getter。 */
  function eng() { return CORE.E; }
  var nameOf = CORE.nameOf, clipLabel = CORE.clipLabel, labelLimit = CORE.labelLimit, theme = CORE.theme;
  var lazyFail = CORE.lazyFail, LAZY_PATH = CORE.LAZY_PATH, PATH_FOLD_AT = CORE.PATH_FOLD_AT, STATUS_LABEL = CORE.STATUS_LABEL;
  var append = CORE.append, figureEl = CORE.figureEl, show = CORE.show, root = CORE.root;
  var flow = CORE.flow, withRouteBack = CORE.withRouteBack, getSettings = CORE.getSettings, newSeed = CORE.newSeed, seenList = CORE.seenList;
  var markSeen = CORE.markSeen, lsGet = CORE.lsGet, lsSet = CORE.lsSet, lsDel = CORE.lsDel;
  var save = CORE.save, saveToChild = CORE.saveToChild, sessionKey = CORE.sessionKey, resetUi = CORE.resetUi;
  var renderStart = CORE.renderStart, renderQuestionsPending = CORE.renderQuestionsPending, renderNoQuestions = CORE.renderNoQuestions;
  var renderQuestionsPendingWith = CORE.renderQuestionsPendingWith;
  var questionSourcesSettled = CORE.questionSourcesSettled, ensureFullTopics = CORE.ensureFullTopics, ensureStandards = CORE.ensureStandards;
  var ensureQuestionsForOne = CORE.ensureQuestionsForOne, ensureQuestionsForTopics = CORE.ensureQuestionsForTopics, ensureQuestionsForAnswers = CORE.ensureQuestionsForAnswers;
  var withStage2 = CORE.withStage2, withStage2Data = CORE.withStage2Data, stage2Status = CORE.stage2Status;
  var screenRoundGraph = CORE.screenRoundGraph;
  var childBar = CORE.childBar, diagnoseHrefFor = CORE.diagnoseHrefFor, routeReturnHref = CORE.routeReturnHref, routeBackBar = CORE.routeBackBar;
  var isPrereqKnowledge = CORE.isPrereqKnowledge, reasonFor = CORE.reasonFor, noteBlind = CORE.noteBlind, blindResultCard = CORE.blindResultCard;
  var llmVariantsMod = CORE.llmVariantsMod;
  /* screen 会话续接 + 后台补齐进度（都在 app.js，经 CORE 唯一一份状态）。 */
  var extendScreenSession = CORE.extendScreenSession, backgroundFillState = CORE.backgroundFillState;
  /* 常量（都在 app.js 的 CORE 定义之前，直接引用；与核心不共享、私有在这里）。 */
  var DIFF_LABEL = CORE.DIFF_LABEL, LAZY_EXPLAIN = CORE.LAZY_EXPLAIN, LAZY_LAB = CORE.LAZY_LAB;
  var LAZY_SHARE = CORE.LAZY_SHARE, LAZY_VARIANTS = CORE.LAZY_VARIANTS, LS_PRAC = CORE.LS_PRAC, LS_VSEQ = CORE.LS_VSEQ;
  var PRACTICE_N = CORE.PRACTICE_N, RESULT_LABEL = CORE.RESULT_LABEL, TYPE_LABEL = CORE.TYPE_LABEL, VOLUMES = CORE.VOLUMES;
  /* 模块级局部状态（从 app.js 一并搬来，私有在本层闭包，不进 S、不与核心共享）。 */
  let explainTick = 0;   // 竞态令牌：只接受最后一次请求的结果
  const LAB_ASK_TEXT = {
    none: '这题的图形我暂时画不出来，咱们按解析一步步来',
    offline: '画图功能暂时用不了'
  };

  /* 统一的会话开入口（按钮 goFlow / 深链 init 都走这）：
   * 目标与存档一致就续练（restoreFromSave），否则新开（startSession）。
   * 数据门（先修 + 题源）由 app.js 的 withStage2 / init 的 ensureFlowReady 在调用前过好。 */
  function enter(targets, label, limit, mode) {
    const saved = lsGet(sessionKey());
    const same = saved && JSON.stringify(saved.targets) === JSON.stringify(Array.from(new Set(targets))) &&
      (saved.mode || 'target') === (mode || 'target') && (S.seedParam == null || saved.seed === S.seedParam);
    if (same) { restoreFromSave(saved, function () { startSession(targets, label, limit, mode); }); return; }
    startSession(targets, label, limit, mode);
  }

  /* 以下函数逐字从 app.js 搬来，仅把核心工具引用换成上面的别名（S.xxx 是对象字段，无需改）。 */

function startSession(targets, label, limit, mode) {
    S.pathExpanded = false;
    const screen = mode === 'screen';
    const st = getSettings();
    /* screen 轮只给「题库已到货章节」的题，未到货章节的 legacy 兜底题必须剔掉；
     * 非 screen 完全走老路（S.D.graph）。 */
    const graph = (screen && screenRoundGraph && screenRoundGraph()) || S.D.graph;
    S.session = eng().createSession(graph, targets, {
      mode: mode, limit: limit || (screen ? st.screenLimit : st.limit), confirm: st.confirm, seed: newSeed(), avoid: seenList()
    });
    S.sessionMeta = { label: label };
    resetUi();
    save();
    /* 兜底：题源还在路上（lite 没有 diagnostic_question + 题库没到 + 全量没到）时开出的会话
     * 一题都问不出来，直接 render() 就会收敛成「0 已答题数 / 未测」的空结果页 ——
     * 孩子一题没答就被告知做完了，弱网 5–25s 窗口内点任何知识点都会踩到（P0 回归）。
     * 这里挂起会话参数、显示「题目还在载入，稍等…」，数据到货后由 resumePendingStart() 重开。 */
    if (!eng().nextItem(graph, S.session) && !S.session.answers.length) {
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

async function startSessionReady(targets, label, limit, mode) {
    await ensureFlowReady(targets, limit, mode);
    stage2Status('');
    startSession(targets, label, limit, mode);
  }

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
      S.session = eng().replay(S.D.graph, saved.targets, saved.answers, {
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
    const item = eng().nextItem(S.D.graph, S.session);
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
      applyAnswerAndRender(eng().nextItem(S.D.graph, S.session) || item, result);
    });
  }

function applyAnswerAndRender(item, result) {
    S.session = eng().applyAnswer(S.D.graph, S.session, item.topicId, result, { text: S.ui.answer });
    markSeen(item.question.id);
    resetUi();
    save();
    render();
  }

function rebuild(answers, limit) {
    S.session = eng().replay(S.D.graph, S.session.targets, answers, {
      mode: S.session.mode, limit: limit == null ? S.session.limit : limit, confirm: S.session.confirm,
      seed: S.session.seed, avoid: S.session.avoid
    });
    resetUi();
    save();
    render();
  }

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
    const t0 = eng().createSession(G, targets).stack[0];
    const testablePre = function (id) { return G.prereqs[id].filter(function (x) { return eng().isTestable(G, x.id); }).map(function (x) { return x.id; }); };
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
      const item = eng().nextItem(S.D.graph, S.session);
      if (!item) break;
      S.session = eng().applyAnswer(S.D.graph, S.session, item.topicId, S.demo.oracle(item.topicId, item.attempt));
      n++;
    }
  }

/* screen 会话中途等待文案：把后台补齐进度带上（DOM 不存在时只是字符串拼接，不报错）。 */
function screenPendingText(bg) {
    if (!bg || !bg.total) return '题目还在载入，稍等…';
    return '题目还在载入，稍等…（' + bg.done + '/' + bg.total + ' 章）';
  }

function render() {
    if (S.pracLoading) { renderPracticeLoading(); return; }   // O3 LLM 变式加载中
    if (S.prac) { renderQuestion(pracItem()); return; }   // T3 练习模式
    if (!S.session) return renderStart();
    const item = eng().nextItem(S.D.graph, S.session);
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
    /* screen 中途：后台还有章节在补齐，nextItem 恰好为空也不许收敛成结果页 ——
     * 那会把「题库没到」当成「已掌握/未测」，给孩子假结论。先尝试用新到货的图续接，
     * 续不上就继续显示「题目还在载入」，等下一章到货再由 questionsArrived 重绘。 */
    if (S.session.mode === 'screen') {
      const answers = S.session.answers.length;
      const limit = S.session.limit;
      const bg = backgroundFillState ? backgroundFillState() : null;
      if ((limit == null || answers < limit) && bg && bg.running) {
        if (extendScreenSession && extendScreenSession()) {
          const nextItem = eng().nextItem(S.D.graph, S.session);
          if (nextItem) return renderQuestion(nextItem);
        }
        return renderQuestionsPendingWith(screenPendingText(bg));
      }
    }
    renderResult();
  }

function pracItem() {
    return { topicId: S.prac.topicId, question: S.prac.list[S.prac.idx], attempt: S.prac.idx + 1 };
  }

function practicedMap() { const v = lsGet(LS_PRAC); return v && typeof v === 'object' ? v : {}; }

function markPracticed(topicId) { const o = practicedMap(); o[topicId] = Date.now(); lsSet(LS_PRAC, o); }

function variantSeqMap() { const v = lsGet(LS_VSEQ); return v && typeof v === 'object' ? v : {}; }

function pathQueueFrom(sum) {
    return ((sum && sum.path) || []).filter(function (p) { return p && p.status === 'weak'; }).map(function (p) { return p.id; });
  }

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
    var bankPicks = eng().pickPracticeQuestions(S.D.graph, topicId, PRACTICE_N, seenList());
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
    var queue = pathQueueFrom(eng().summarize(S.D.graph, S.session));
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

function adviceCard(sum) {
    const text = eng().studentAdvice(sum, nameOf);
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

function judgeAndGo(item) {
    const q = item.question;
    const val = S.ui.answer.trim();
    if (!val) { const el = document.getElementById('ans'); if (el) el.focus(); return; }
    const r = eng().judgeQuestion(q, val);
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

function answerKeys(q) {
    const raw = q && q.answer;
    if (typeof raw === 'string') return raw;
    if (raw == null) return null;
    const m = String(raw).trim().toUpperCase().match(/^[A-Z]/);
    return m ? m[0] : null;
  }

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
        h('span', { class: 'tag', text: pr ? '练习第 ' + (S.prac.idx + 1) + ' 题' : '本知识点第 ' + item.attempt + ' / ' + eng().needConfirm(S.D.graph, S.session, id) + ' 题' }),
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
        append(card, choicesBlock(q, { item: item, readonly: false, pickedKey: S.ui.picked }));
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
        append(card, choicesBlock(q, { item: item, readonly: true, correctKey: null, pickedKey: S.ui.answer }));
      } else {
        /* 用自定义 append：学生「不会」进来时 ui.answer 是空的，answerEcho(…, false) 会返回 null，
         * 原生 card.append(null) 会把 null 字符串化插成一个文本节点（讲解首屏题目下面那行 "null"）。 */
        append(card, answerEcho(q, S.ui.answer, false));
      }
      append(card, explainPanel(item));
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
    append(page, childBar('question'));
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

function explainPanel(item) {
    const id = item.topicId;
    const q = item.question;
    const t = S.D.graph.byId[id];
    const steps = (S.ui.aiSteps && S.ui.aiSteps.length === 3) ? S.ui.aiSteps : eng().socraticSteps(t, q);
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
        return { title: nameOf(id), detail: STATUS_LABEL[eng().statusOf(S.session, id)] || '' };
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
    var sum = eng().summarize(S.D.graph, S.session);
    var chapters = S.session.mode === 'screen' ? eng().chapterSummary(S.D.graph, S.session) : null;
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

function descNode(t) {
    if (t.description) return h('div', { class: 'topic-desc', text: t.description });
    if (!S.fullTopicsLoaded && !S.fullTopicsFailed) ensureFullTopics();
    if (S.fullTopicsLoaded) return h('div', { class: 'topic-desc' }, '暂无说明。');
    if (S.fullTopicsFailed) return h('div', { class: 'muted small desc-pending', 'data-topic-id': t.id }, '说明载入失败，可刷新重试。');
    return h('div', { class: 'muted small desc-pending', 'data-topic-id': t.id }, '正在载入说明…');
  }

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
    append(body, masteryNode(t));
    if (extra) body.append(extra);
    append(body, standardsBlock(id));
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
    const st = eng().statusOf(S.session, id);
    const out = [];
    if (targetSet.has(id)) out.push(tag('target', '目标'));
    if (rootSet.has(id)) out.push(tag('root', '根因'));
    if (isPrereqKnowledge(id)) out.push(tag('ext', '前置知识'));
    out.push(tag(st, STATUS_LABEL[st]));
    if (S.D.graph.byId[id].external) out.push(tag('ext', '小学'));
    return out;
  }

function practiceBtn(id) {
    const t = S.D.graph.byId[id];
    if (!t || t.external) return null;   // 小学 / 前置知识不练
    const bank = S.D.graph.bank[id] || [];
    const done = practicedMap()[id];
    let label;
    if (bank.length) {
      const n = (eng().pickPracticeQuestions(S.D.graph, id, PRACTICE_N, seenList()) || []).length;
      label = done ? '再练一遍' : (n > 1 ? '练习这 ' + n + ' 题' : '练习这道题');
    } else {
      label = '练习';
    }
    return h('button', { type: 'button', class: 'practice-btn no-print',
      onclick: function (e) { e.stopPropagation(); e.preventDefault(); withStage2Data(function () { startPractice(id); }); } },
      label);
  }

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

function noBankCard(sum) {
    return h('div', { class: 'card', id: 'advice-summary' },
      h('h2', { text: '题库没取到，这轮结果不作数' }),
      h('p', { style: 'margin:2px 0' }, '题库没取到，本轮只做了 ' + sum.asked + ' 道诊断题，结果不作数。'),
      h('p', { class: 'muted small', style: 'margin:2px 0' },
        '这一轮的结论既不能说明掌握，也不能说明薄弱。换个有网的网络后，回到开始页重新点一次这个知识点，工具会重新取整套题。'));
  }

function renderResult() {
    const sum = eng().summarize(S.D.graph, S.session);
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
    append(page, childBar('result'));
    const pracBanner = practiceResultBanner();
    if (pracBanner) page.append(pracBanner);
    else if (diagOnly) page.append(noBankCard(sum));
    else page.append(adviceCard(sum));

    const targetsMastered = S.session.targets.every(function (id) { return eng().statusOf(S.session, id) === 'mastered'; });
    const chapters = screen ? eng().chapterSummary(S.D.graph, S.session) : null;
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
      const q = eng().questionById(S.D.graph, a.qid) || { prompt: '', answer: '' };
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

function exportJson() {
    const sum = eng().summarize(S.D.graph, S.session);
    const stdIds = new Set();
    const brief = function (id) { return { id: id, name: nameOf(id) }; };
    sum.path.concat(S.session.mode === 'screen' ? [] : S.session.targets.map(function (id) { return { id: id }; })).forEach(function (p) {
      (S.D.graph.byId[p.id].standards || []).forEach(function (sd) { stdIds.add(sd.id); });
    });
    const chapters = S.session.mode === 'screen' ? eng().chapterSummary(S.D.graph, S.session) : null;
    const out = {
      tool: 'cn-math-taxonomy/diagnose', version: 2, mode: S.session.mode || 'target', generatedAt: new Date().toISOString(),
      note: '自动判题是近似的，以参考答案为准。',
      label: S.sessionMeta.label,
      targets: S.session.targets.map(brief),
      limit: S.session.limit, seed: S.session.seed, asked: sum.asked, finished: sum.finished, limitReached: sum.limitReached,
      answers: S.session.answers.map(function (a, i) {
        const q = eng().questionById(S.D.graph, a.qid) || {};
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

function resolveTargets(params) {
    const t = params.get('target');
    if (t) {
      const raw = t.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
      const ids = eng().resolveTargets(raw, S.D.aliases);
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
      const g = eng().gradeTargets(S.D.graph, scope, S.subject);
      if (!g) throw new Error('URL 参数 grade / volume 无法识别：' + (volume || grade) + '（写法如 grade=七年级、volume=七上）');
      return { ids: g.ids, label: g.label + '（整体筛查）', mode: 'screen' };
    }
    return null;
  }
  /* ------------------------------------------------------------ 路径图（Cytoscape + dagre） */
  function stageKind(grade) { return grade <= 6 ? 'primary' : grade <= 9 ? 'junior' : 'senior'; }
  function gradeWord(grade) {
    const cn = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
    if (S.subject === 'english') {
      if (grade >= 1 && grade <= 9) return cn[grade] + '年级';
      const en = { 10: '必修一', 11: '必修二', 12: '必修三', 13: '选必一', 14: '选必二', 15: '选必三', 16: '选必四' };
      return en[grade] || ('册' + grade);
    }
    if (grade >= 1 && grade <= 9) return cn[grade] + '年级';
    if (S.subject === 'physics') return { 10: '必修一', 11: '必修二', 12: '必修三', 13: '选必一', 14: '选必二', 15: '选必三' }[grade] || ('册' + grade);
    const math = { 10: '高一', 11: '高二', 12: '选必一', 13: '选必二', 14: '选必三' };
    return math[grade] || ('年级' + grade);
  }
  function toneOf(kind, colors) {
    if (kind === 'primary') return [colors.primaryBg, colors.primary];
    if (kind === 'junior') return [colors.juniorBg, colors.junior];
    return [colors.seniorBg, colors.senior];
  }
  function pathNodeElement(n, colors) {
    const topic = S.D.graph.byId[n.id];
    const grade = topic && typeof topic.grade === 'number' ? topic.grade : 7;
    const kind = stageKind(grade);
    const name = nameOf(n.id);
    const bits = [name];
    if (n.isRoot) bits.push('薄弱根因');
    if (n.isTarget) bits.push('目标');
    bits.push(STATUS_LABEL[n.status] || n.status);
    const tone = toneOf(kind, colors);
    let bg = tone[0];
    let border = tone[1];
    if (n.isTarget) { bg = colors.currentBg; border = colors.currentBorder; }
    if (n.isRoot) { bg = colors.badBg; border = colors.bad; }
    const classes = [kind];
    if (n.isRoot) classes.push('root');
    if (n.isTarget) classes.push('target', 'current');
    return {
      data: { id: n.id, name: name, full: bits.join(' · '), label: clipLabel(name), bg: bg, border: border, color: colors.text },
      classes: classes.join(' ')
    };
  }
  function buildPathElements(lay, colors, folded) {
    const elements = [];
    const bucket = new Map();
    const gradeMembers = new Map();
    lay.nodes.forEach(function (n) {
      if (!folded || n.isRoot || n.isTarget) {
        bucket.set(n.id, n.id);
        elements.push(pathNodeElement(n, colors));
        return;
      }
      const topic = S.D.graph.byId[n.id];
      const grade = topic && typeof topic.grade === 'number' ? topic.grade : 0;
      if (!gradeMembers.has(grade)) gradeMembers.set(grade, []);
      gradeMembers.get(grade).push(n.id);
    });
    gradeMembers.forEach(function (ids, grade) {
      const id = 'grade-' + grade;
      const kind = stageKind(grade);
      const tone = toneOf(kind, colors);
      const name = gradeWord(grade) + '·' + ids.length + '个';
      elements.push({
        data: {
          id: id, name: name, full: gradeWord(grade) + '的 ' + ids.length + ' 个知识点',
          label: clipLabel(name), bg: tone[0], border: tone[1], color: colors.text
        },
        classes: kind + ' grade'
      });
      ids.forEach(function (topicId) { bucket.set(topicId, id); });
    });
    const seen = new Map();
    lay.edges.forEach(function (e) {
      const a = bucket.get(e.from);
      const b = bucket.get(e.to);
      if (!a || !b || a === b) return;
      const key = a + '>' + b;
      const kind = !e.direct ? 'indirect' : (e.strength === 'soft' ? 'soft' : 'hard');
      const rank = kind === 'hard' ? 3 : kind === 'soft' ? 2 : 1;
      const prev = seen.get(key);
      if (!prev || rank > prev.rank) seen.set(key, { kind: kind, rank: rank });
    });
    let edgeIndex = 0;
    seen.forEach(function (info, key) {
      const parts = key.split('>');
      const color = info.kind === 'hard' ? colors.edge : colors.edgeSoft;
      elements.push({
        data: { id: 'e' + (edgeIndex++), source: parts[0], target: parts[1], color: color },
        classes: info.kind
      });
    });
    return elements;
  }
  function updatePathFold(total, folded) {
    const box = document.getElementById('path-fold');
    if (!box) return;
    if (total <= PATH_FOLD_AT) {
      box.hidden = true;
      box.replaceChildren();
      return;
    }
    box.hidden = false;
    if (folded) {
      box.replaceChildren(
        document.createTextNode('路径较长，已按年级收起中间知识点。根因和目标仍单独画出。'),
        h('button', { type: 'button', id: 'btn-path-expand', text: '展开全部 ' + total + ' 个' })
      );
    } else {
      box.replaceChildren(
        document.createTextNode('已展开全部 ' + total + ' 个知识点。'),
        h('button', { type: 'button', id: 'btn-path-collapse', text: '按年级收起' })
      );
    }
  }
  function pathZoom(factor) {
    if (!S.pathCy) return;
    const rect = S.pathCy.container().getBoundingClientRect();
    S.pathCy.zoom({
      level: Math.max(S.pathCy.minZoom(), Math.min(S.pathCy.maxZoom(), S.pathCy.zoom() * factor)),
      renderedPosition: { x: rect.width / 2, y: rect.height / 2 }
    });
  }
  function pathFit() {
    if (!S.pathCy) return;
    S.pathCy.resize();
    const many = S.pathCy.nodes().length > 48;
    if (many) S.pathCy.minZoom(0.45);
    S.pathCy.fit(undefined, 28);
    if (many && S.pathCy.zoom() < 0.45) {
      S.pathCy.zoom(0.55);
      S.pathCy.center();
    }
  }
  function hidePathTip() {
    const tip = document.getElementById('node-tip');
    if (tip) tip.hidden = true;
  }
  function showPathTip(node) {
    const tip = document.getElementById('node-tip');
    const stage = document.querySelector('.path-graph');
    if (!tip || !stage || !S.pathCy || !node || node.empty()) return;
    const text = node.data('full') || node.data('label') || '';
    if (!text) { tip.hidden = true; return; }
    tip.textContent = text;
    tip.hidden = false;
    const stageRect = stage.getBoundingClientRect();
    const cyRect = S.pathCy.container().getBoundingClientRect();
    const bb = node.renderedBoundingBox({ includeLabels: true });
    const tipW = tip.offsetWidth;
    const tipH = tip.offsetHeight;
    const cx = cyRect.left - stageRect.left + (bb.x1 + bb.x2) / 2;
    const top = cyRect.top - stageRect.top + bb.y1;
    let left = Math.max(8, Math.min(cx - tipW / 2, Math.max(8, stageRect.width - tipW - 8)));
    let y = top - tipH - 8;
    if (y < 4) y = cyRect.top - stageRect.top + bb.y2 + 8;
    if (y + tipH > stageRect.height - 4) y = Math.max(4, stageRect.height - tipH - 4);
    tip.style.left = left + 'px';
    tip.style.top = y + 'px';
  }
  function ensureDagre() {
    /* 图形库是懒加载的（首屏不带 186KB）：调用点先 Lazy.load(LAZY_PATH)；
     * 这里再 ensure 一次是幂等的（同 src 复用同一个 Promise，不会重复注入），
     * 万一还没到货就抛错，由 mountPathGraph 的 catch 降级成一行提示。 */
    Lazy.load(LAZY_PATH);
    if (!window.cytoscape || !window.dagre || !window.cytoscapeDagre) throw new Error('图形库没有加载');
    if (!ensureDagre.ready) { window.cytoscape.use(window.cytoscapeDagre); ensureDagre.ready = true; }
  }
  function mountPathGraph(sum) {
    const token = ++S.pathToken;
    if (S.pathCy) { S.pathCy.destroy(); S.pathCy = null; window.__pathCy = null; }
    const cyEl = document.getElementById('path-cy');
    if (!cyEl) return;
    cyEl.dataset.ready = '0';
    hidePathTip();
    const lay = eng().layout(S.D.graph, S.session, sum);
    requestAnimationFrame(function () {
      if (token !== S.pathToken || !document.body.contains(cyEl)) return;
      /* 首屏不带 cytoscape/dagre：临画前才注入（3 个文件按依赖顺序串行），
       * 注入完成后重新挂一次；失败就退到下面的「图形库没有加载」一行提示。 */
      if (!window.cytoscape && !S.lazyFailed.path) {
        Lazy.load(LAZY_PATH).then(function () {
          if (token !== S.pathToken || !document.body.contains(cyEl)) return;
          mountPathGraph(sum);
        }, lazyFail('path'));
        return;
      }
      try {
        ensureDagre();
        const colors = theme();
        const narrow = labelLimit() <= 8;
        const textMax = narrow ? 104 : 126;
        const boxW = narrow ? 118 : 142;
        const FONT = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Noto Sans SC", sans-serif';
        const total = lay.nodes.length;
        const folded = total > PATH_FOLD_AT && !S.pathExpanded;
        const heavy = !folded && total > 48;
        updatePathFold(total, folded);
        cyEl.dataset.mode = folded ? 'grade' : 'full';
        cyEl.dataset.total = String(total);
        const elements = buildPathElements(lay, colors, folded);
        S.pathCy = window.cytoscape({
          container: cyEl,
          elements: elements,
          minZoom: heavy ? 0.45 : 0.2,
          maxZoom: 2.8,
          wheelSensitivity: 0.28,
          boxSelectionEnabled: false,
          autoungrabify: true,
          userPanningEnabled: true,
          userZoomingEnabled: true,
          style: [
            { selector: 'node', style: {
              label: 'data(label)', 'text-wrap': 'ellipsis', 'text-max-width': textMax + 'px',
              'text-overflow-wrap': 'anywhere',
              'text-valign': 'center', 'text-halign': 'center',
              'font-size': 13, 'font-family': FONT, color: 'data(color)',
              'background-color': 'data(bg)', 'border-width': 2, 'border-color': 'data(border)',
              shape: 'round-rectangle', width: boxW, height: 34, padding: 0, 'corner-radius': 8
            } },
            { selector: 'node.current', style: { 'border-width': 4, 'z-index': 8 } },
            { selector: 'node.root', style: {
              'background-color': colors.badBg, 'border-color': colors.bad, 'border-width': 4, 'z-index': 11
            } },
            { selector: 'edge', style: {
              width: 1.6, 'line-color': 'data(color)', 'target-arrow-color': 'data(color)',
              'target-arrow-shape': 'triangle', 'curve-style': heavy ? 'straight' : 'bezier', 'arrow-scale': 0.8, 'line-style': 'solid'
            } },
            { selector: 'edge.soft', style: { 'line-style': 'dashed', width: 1.5 } },
            { selector: 'edge.indirect', style: { 'line-style': 'dotted', width: 1.4 } }
          ]
        });
        window.__pathCy = S.pathCy;
        S.pathCy.on('mouseover', 'node', function (event) { showPathTip(event.target); });
        S.pathCy.on('mouseout', 'node', function () { if (!S.pathTipLock) hidePathTip(); });
        S.pathCy.on('tap', 'node', function (event) { S.pathTipLock = true; showPathTip(event.target); });
        S.pathCy.on('tap', function (event) {
          if (event.target === S.pathCy) { S.pathTipLock = false; hidePathTip(); }
        });
        const layout = S.pathCy.layout({
          name: 'dagre', rankDir: 'TB',
          rankSep: heavy ? 46 : 64,
          nodeSep: heavy ? 16 : 22,
          edgeSep: heavy ? 8 : 10,
          ranker: heavy ? 'longest-path' : 'network-simplex',
          padding: 16, animate: false, fit: true, nodeDimensionsIncludeLabels: false, spacingFactor: heavy ? 1.02 : 1.05
        });
        layout.one('layoutstop', function () {
          if (token !== S.pathToken || !S.pathCy) return;
          requestAnimationFrame(function () {
            if (token !== S.pathToken || !S.pathCy) return;
            S.pathCy.resize();
            S.pathCy.fit(undefined, heavy ? 20 : 24);
            if (heavy && S.pathCy.zoom() < 0.7) {
              S.pathCy.zoom(0.8);
              const focusNode = lay.nodes.find(function (n) { return n.isRoot; }) || lay.nodes.find(function (n) { return n.isTarget; }) || lay.nodes[0];
              const focus = focusNode ? S.pathCy.getElementById(focusNode.id) : null;
              if (focus && !focus.empty()) S.pathCy.center(focus);
            }
            cyEl.dataset.ready = '1';
          });
        });
        layout.run();
      } catch (error) {
        cyEl.dataset.ready = 'err';
        cyEl.append(h('p', { class: 'muted', text: '图没有画出来：' + (error && error.message ? error.message : error) }));
      }
    });
  }


  /* 对外暴露：app.js（核心）经 flow('xxx') 转调这些入口；Node 测试直接 require（诊断判据/头条文案）。
   * 内部辅助（pathNodeElement 等）留在这层闭包里。 */
  return {
    enter: enter,
    closeShare: closeShare, startSession: startSession, restoreFromSave: restoreFromSave,
    render: render, resolveTargets: resolveTargets, makeOracle: makeOracle, runDemo: runDemo,
    renderResult: renderResult, masteryNode: masteryNode, standardsBlock: standardsBlock,
    standardsCard: standardsCard, refreshStdText: refreshStdText, restart: restart,
    diagnosticOnlyRound: diagnosticOnlyRound, resultHeadline: resultHeadline,
    startPractice: startPractice, startPathPractice: startPathPractice,
    mountPathGraph: mountPathGraph, ensureDagre: ensureDagre, pathFit: pathFit, pathZoom: pathZoom
  };
});
