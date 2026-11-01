/* route.html 的页面层：DOM 渲染 + 数据加载 + 调网关。
 *
 * 分工（对应验收标准 7）：
 *   ①② 解析字段 / 候选池 —— 纯确定性，点「定位」后**立刻**渲染，不依赖网关；
 *   ③④ LLM 选择 / 校验 —— 需要网关，网关不可用时给明确提示，不白屏；
 *   ⑤ 前置链 —— 只在 ④ 通过后才算，本身就是确定性计算；
 *   ⑥ 接下来需要确认的知识点 —— 依赖图上的前置节点，不是诊断结论；
 *     「从这儿开始诊断」入口也只挂在这里，且只在 ④ 校验通过时出现。
 *
 * 算法都在 route.js（纯函数，Node 可直测），本文件只碰 DOM。
 */
(function () {
  'use strict';

  var R = window.DiagRoute;
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var FIELD_CN = { grade: '年级', stage: '学段', domain: '领域', chapter: '章节', topicHint: '考点描述' };

  function setStatus(txt, cls) {
    var el = $('status');
    el.className = 'small ' + (cls || 'muted');
    el.textContent = txt || '';
  }

  function show(id, on) { $(id).hidden = !on; }

  function clearSections() {
    ['sec-fields', 'sec-pool', 'sec-picks', 'sec-verify', 'sec-prereq', 'sec-path'].forEach(function (id) {
      show(id, false);
    });
    ['fields-body', 'pool-body', 'picks-body', 'verify-body', 'prereq-body', 'path-body'].forEach(function (id) {
      $(id).innerHTML = '';
    });
  }

  /* ------------------------------------------- 刷新后恢复（kanban t_70cabf77）
   * 存档只装原始数据（输入文字 + 各段 view 的原始结构），绝不装 HTML；
   * 组装/解析/版本闸门/清理全在 route.js 的纯函数里，本文件只把 sessionStorage 递过去。
   * 用 sessionStorage 而不是 localStorage：一次作业的临时材料，关标签页就该没。
   */
  var STORE = null;
  function store() {
    try { STORE = window.sessionStorage || null; } catch (e) { STORE = null; }
    return STORE;
  }

  var lastView = null;   /* 最近一次渲染出来的各段原始数据（进存档的那份，不含 HTML） */
  var viewText = '';     /* 这份 view 对应的输入文字 */

  function persist(text) {
    if (!R || typeof R.saveArchive !== 'function') return;   /* 旧版 route.js：不存也不报错 */
    var keep = (lastView && text === viewText) ? lastView : null;
    R.saveArchive(store(), Date.now(), text, keep);
  }

  function showRestoreBar(at, hasView) {
    var bar = $('restore-bar');
    if (!bar) return;
    $('restore-note').textContent = R.archiveNote(at, hasView);
    bar.hidden = false;
  }
  function hideRestoreBar() {
    var bar = $('restore-bar');
    if (bar) bar.hidden = true;
  }

  /* 存档版的 view：只留渲染真正要用的字段。候选池只留前 20 个（页面本来也只列 20 个），
   * 免得把几百个候选塞进 sessionStorage —— 恢复时反正不会再调 LLM。 */
  function slimView(st) {
    var pool = null;
    if (st.pool) {
      pool = {
        ok: st.pool.ok, reason: st.pool.reason, detail: st.pool.detail,
        levelLabel: st.pool.levelLabel, count: st.pool.count,
        chapterUsed: st.pool.chapterUsed, chapterNote: st.pool.chapterNote,
        topics: (st.pool.topics || []).slice(0, 20)
      };
    }
    return {
      fields: st.fields, skip: st.skip, subject: st.subject || null,
      pool: pool, picks: st.picks, verify: st.verify, prereq: st.prereq, path: st.path,
      status: st.status, level: st.level
    };
  }

  /* ---------------------------------------------------------------- ① 字段 */

  function fieldRow(label, f, extra) {
    if (!f || !f.parsed) {
      return '<tr><th>' + esc(label) + '</th><td><span class="pill fail">未解析出</span>' +
        (extra ? ' <span class="small muted">' + esc(extra) + '</span>' : '') + '</td></tr>';
    }
    var val;
    if (label === '年级') {
      val = esc(R.gradeLabel(f.value)) + ' <span class="small muted">（原文「' + esc(f.raw) + '」）</span>';
    } else if (label === '章节') {
      val = esc(f.value) + ' <span class="small muted">（章节全名：' + esc((f.chapters || [])[0] || f.value) + '）</span>';
    } else {
      val = esc(f.value);
    }
    return '<tr><th>' + esc(label) + '</th><td>' + val + '</td></tr>';
  }

  function renderFields(f) {
    var html = '<table class="kv">' +
      fieldRow('年级', f.grade) +
      fieldRow('学段', f.stage) +
      fieldRow('领域', f.domain) +
      fieldRow('章节', f.chapter) +
      fieldRow('考点描述', f.topicHint) +
      '</table>';
    if (f.missing && f.missing.length) {
      html += '<p class="small muted">未解析出的字段：' + f.missing.map(function (k) {
        return FIELD_CN[k] || k;
      }).join('、') + '。缺字段不影响降级——但如果连年级都没有，第 ② 步会直接说信息不足。</p>';
    }
    $('fields-body').innerHTML = html;
    show('sec-fields', true);
  }

  /* -------------------------------------------------------------- ② 候选池 */

  function renderPool(pool) {
    if (!pool.ok) {
      $('pool-body').innerHTML = '<div class="warnbox"><strong>' + esc(pool.reason) + '</strong>' +
        '<p class="small" style="margin:6px 0 0">' + esc(pool.detail || '') + '</p></div>';
      show('sec-pool', true);
      return;
    }
    var head = '<p class="small">降级阶梯：<code>' + esc(pool.levelLabel) + '</code>　共 <strong>' +
      pool.count + '</strong> 个候选' +
      (pool.chapterUsed ? '　章节筛子：<code>' + esc(pool.chapterUsed) + '</code>' : '') + '</p>';
    if (pool.chapterNote) head += '<p class="small muted">' + esc(pool.chapterNote) + '</p>';
    var list = pool.topics.slice(0, 20).map(function (t) {
      return '<li>' + esc(t.name) + ' <span class="small muted">' +
        esc(R.gradeLabel(t.grade)) + ' · ' + esc(t.domain) +
        (t.chapter ? ' · ' + esc(t.chapter) : '') + '</span></li>';
    }).join('');
    $('pool-body').innerHTML = head + '<ul class="plain">' + list + '</ul>' +
      (pool.count > 20 ? '<p class="small muted">（只列前 20 个）</p>' : '');
    show('sec-pool', true);
  }

  /* ----------------------------------------------------------- ③ LLM 选择 */

  function renderPicks(state) {
    var html = '';
    if (state.stage === 'offline') {
      html = '<div class="warnbox"><strong>网关不可用，第 ③ 步没能完成。</strong>' +
        '<p class="small" style="margin:6px 0 0">上面 ①② 是纯确定性结果，不受影响；' +
        '只有「LLM 在候选池里选知识点」这一步需要本地网关。原因：' + esc(state.message) + '</p></div>';
    } else if (!state.picks || !state.picks.length) {
      html = '<div class="warnbox">LLM 没有在候选池里选出任何知识点——按「定位不出就说定位不出」处理，不硬凑。</div>';
    } else {
      html = '<ul class="plain">' + state.picks.map(function (p) {
        return '<li><strong>' + esc(p.name || '(无名)') + '</strong> <code>' + esc(p.id) + '</code> ' +
          '<span class="conf">置信度 ' + (typeof p.confidence === 'number' ? p.confidence : '?') + '</span>' +
          '<br><span class="small muted">理由：' + esc(p.reason || '（没给）') + '</span></li>';
      }).join('') + '</ul>';
    }
    $('picks-body').innerHTML = html;
    show('sec-picks', true);
  }

  /* ------------------------------------------------------------- ④ 校验 */

  /* 「从这儿开始诊断」入口：只有 ④ 校验通过的候选才有。
   * 只有 1 个候选也要学生点，不自动跳转——起点错了，engine 会认真地把错的知识点测一遍。
   * 地址一律由 route.js 的 diagnosisUrl() 生成（跳转参数的唯一来源，Node 侧可直测）。 */
  function startButton(topicId) {
    return '<a class="start-diag" id="start-diag-' + esc(topicId) + '" href="' + esc(R.diagnosisUrl(topicId)) + '"' +
      ' data-topic="' + esc(topicId) + '">从这儿开始诊断</a>';
  }

  function renderVerify(v) {
    var html = '';
    if (v.ok) {
      html += '<p><span class="pill pass">通过</span> ' + v.kept.length + ' 个知识点通过了三条确定性校验' +
        '（id 在候选池内 / 名字与库一致 / 考点描述能对上）。</p>';
      html += '<ul class="plain">' + v.kept.map(function (k) {
        return '<li><strong>' + esc(k.name) + '</strong> <code>' + esc(k.id) + '</code> ' +
          '<span class="conf">置信度 ' + k.confidence + '</span>' +
          '<br><span class="small muted">考点覆盖 <strong>' +
          (k.coverage == null ? '无法核对' : Math.round(k.coverage * 100) + '%') + '</strong>' +
          '（LLM 原始置信度 ' + k.llmConfidence + '）' +
          (k.notes && k.notes.length ? '　' + esc(k.notes.join('；')) : '') + '</span>' +
          '<br>' + startButton(k.id) + '</li>';
      }).join('') + '</ul>';
      html += '<div class="okbox"><strong>上面还是候选，不是诊断结论。</strong>' +
        '<p class="small" style="margin:6px 0 0">点某个候选旁的「从这儿开始诊断」，' +
        '到诊断页做几道题，才能确定你实际卡在哪个知识点。' +
        (v.kept.length > 1 ? '这次有 ' + v.kept.length + ' 个候选，请点你认为对的那一个——系统不替你选。' : '') +
        '</p></div>';
    } else {
      html += '<div class="badbox"><strong>分析结果无法定位到知识点</strong>' +
        '<p class="small" style="margin:6px 0 0">按「定位错比不定位更糟」处理：不返回任何知识点。</p></div>';
      html += '<ul class="plain">' + (v.why || []).map(function (w) {
        return '<li>' + esc(w) + '</li>';
      }).join('') + '</ul>';
    }
    if (v.rejected && v.rejected.length && v.ok) {
      html += '<div class="warnbox"><strong>被拒绝的选择：</strong><ul class="plain">' +
        v.rejected.map(function (r) {
          return '<li>' + esc(r.rule) + '：' + esc(r.why) + '</li>';
        }).join('') + '</ul></div>';
    }
    $('verify-body').innerHTML = html;
    show('sec-verify', true);
  }

  /* ----------------------------------------------------------- ⑤ 前置链 */

  function nodeHtml(it, strengthLabel) {
    return '<div class="node"><span class="g">' + esc(R.gradeLabel(it.grade)) + '</span>' +
      '<span class="n">' + esc(it.name) + ' <span class="small muted">' + esc(it.id) + '</span></span>' +
      '<span class="pill">' + esc(strengthLabel) + '</span></div>';
  }

  function renderPrereq(pre) {
    if (!pre) { $('prereq-body').innerHTML = '<p class="skip">没有前置数据</p>'; show('sec-prereq', true); return; }
    var html = '<p class="small muted">目标：<strong>' + esc(pre.target.name) + '</strong> ' +
      esc(R.gradeLabel(pre.target.grade)) + '</p>';
    html += skippedHtml(pre.target.id);
    pre.levels.forEach(function (lv) {
      html += '<div class="depth-head">第 ' + lv.depth + ' 层 hard 前置（' + lv.items.length + ' 个）</div>';
      if (!lv.items.length) html += '<p class="skip">（这一层没有 hard 前置）</p>';
      lv.items.forEach(function (it) {
        html += nodeHtml(it, 'hard') +
          '<p class="small muted" style="margin:-2px 0 8px 10px">因为：' + esc(it.reason || '（无说明）') + '</p>';
      });
    });
    if (pre.soft && pre.soft.length) {
      html += '<div class="depth-head">可选补充（soft 边，不进主路径）</div><ul class="plain">' +
        pre.soft.map(function (it) {
          return '<li>' + esc(it.name) + ' <span class="small muted">' + esc(R.gradeLabel(it.grade)) +
            ' · soft · 来自「' + esc(it.fromName) + '」</span></li>';
        }).join('') + '</ul>';
    }
    if (pre.excluded && pre.excluded.length) {
      html += '<div class="depth-head">已过滤（噪音）</div><ul class="plain">' +
        pre.excluded.map(function (it) {
          return '<li class="small">' + esc(it.name) + ' <span class="muted">' +
            esc(R.gradeLabel(it.grade)) + ' · ' + esc(it.strength) + ' · ' + esc(it.excludedWhy) + '</span></li>';
        }).join('') + '</ul>';
    }
    $('prereq-body').innerHTML = html;
    show('sec-prereq', true);
  }

  /* ------------------------------------------ ⑥ 接下来需要确认的知识点 */

  /* 「已略过更早的前置」（kanban t_be33ff76）。
   * app.js 存盘时只留 answers（会话靠 replay 重建），suppressed 不落盘，
   * 所以这里拿 targets 现算一次：E.createSession → suppressed → 纯文案在 route.js。
   * 只挂在 ⑤⑥ 两段里，**不进「你的薄弱点」结论**——被排除的候选不是诊断结果。
   *
   * 何时显示：只在这个会话确实做过诊断时才说。判定复用 matchSession（它与 ⑥ 段写回同一口径：
   * target 不匹配、或一条答案都没有，就当没有这次诊断）。否则新贴一段文字也会冒出「已略过」，
   * 学生会以为系统已经替自己筛过题。 */
  function skippedHtml(currentTopicId) {
    var session = readSession();
    if (!R.matchSession(session, currentTopicId).ok) return '';
    if (!window.DiagEngine || !window.D.engineGraph) return '';
    var items = R.skippedByGrade(session.targets, function (ts) {
      return window.DiagEngine.createSession(window.D.engineGraph, ts);
    });
    var note = R.skippedNote(items, window.DiagEngine.GRADE_GAP);
    return note ? '<p class="skip-note small" id="skipped-note">' + esc(note) + '</p>' : '';
  }

  /* 诊断结果写回 route（kanban t_d623773c）。
   * 分工：读 localStorage 和调 E.summarize() 在这里，判断与文案在 route.js 的 buildResultView()。
   * 页面层只做两件事：拿到 session+sum 交上去、按结果决定 ⑥ 段显示候选还是真结论。 */

  var LS_SESSION = 'cnmDiagnose.session.v2';   /* 与 app.js:9 一致；只读，绝不删 */

  function readSession() {
    try {
      var raw = window.localStorage ? window.localStorage.getItem(LS_SESSION) : null;
      if (!raw) return null;
      var s = JSON.parse(raw);
      return (s && typeof s === 'object' && s.v === 2) ? s : null;
    } catch (e) { return null; }   /* 存储不可用/内容坏了：当作没有，不影响 ①② */
  }

  /* 用 engine 的 replay + summarize 复原出结论。answers 是唯一权威（app.js 也是这么恢复的），
   * 自己算 statusOf 会和 engine 不一致 —— 所以这里一定要复用 engine。 */
  function computeSummary(session) {
    if (!session || !window.DiagEngine || !window.D.engineGraph) return null;
    try {
      var sess = window.DiagEngine.replay(window.D.engineGraph, session.targets, session.answers || [], {
        mode: session.mode, limit: session.limit, seed: session.seed, avoid: session.avoid
      });
      return window.DiagEngine.summarize(window.D.engineGraph, sess);
    } catch (e) { return null; }
  }

  /** 当前定位结果（⑥ 段）对应的知识点 id：第 ④ 段第一个校验通过的候选 */
  function currentTopicId(verify) {
    return (verify && verify.ok && verify.kept && verify.kept.length) ? verify.kept[0].id : null;
  }

  function renderResult(view) {
    if (!view || !view.ok) return '';
    var html = '<div class="diag-result stage-' + esc(view.stage) + '">' +
      '<h3>' + esc(view.title || R.RESULT_TITLE) + '</h3>' +
      (view.detail || '').split('\n').map(function (line) {
        return '<p class="' + (view.stage === 'unfinished' ? 'warn-line' : '') + '">' + esc(line) + '</p>';
      }).join('');
    if (view.stage === 'roots') {
      html += '<ul class="plain roots">' + view.roots.map(function (r) {
        var cav = R.rootCaveat(r);
        return '<li><strong>' + esc(r.name) + '</strong>' +
          ' <span class="small muted">' + esc(R.gradeLabel(r.grade)) + '</span>' +
          (cav ? ' <span class="pill warn">' + esc(cav) + '</span>' : '') + '</li>';
      }).join('') + '</ul>';
    }
    html += '<p class="small muted">' + esc(R.RESULT_NOTE || '') + '</p>';
    return html + '</div>';
  }

  function renderPath(path, targetName, view) {
    var hasRoots = !!(view && view.ok && view.stage === 'roots');
    var skipped = skippedHtml();

    /* ⑥ 段的标题与开销：有真结论时整段换成「你的薄弱点」，候选列表不再出现 */
    var h2 = $('sec-path').querySelector('h2');
    h2.innerHTML = '<span class="num">6</span>' + esc(hasRoots ? R.WEAK_TITLE : R.STRUCTURE_TITLE);

    if (hasRoots) {
      /* 「已略过」放在结论之后：它解释的是范围，不是结论，不能挡在根因前面 */
      $('path-body').innerHTML = renderResult(view) +
        '<p class="small muted">' + esc(view.sectionNote || '') + '</p>' + skipped;
      show('sec-path', true);
      return;
    }

    if (!path || !path.nodes.length) {
      $('path-body').innerHTML = '<p class="skip">没有可给的路径</p>' +
        renderResult(view) + skipped;
      show('sec-path', true);
      return;
    }
    var note = R.structureNote();
    var html = '<div class="warnbox"><strong>' + esc(note.title) + '</strong>' +
      '<p class="small" style="margin:6px 0 0">' + esc(note.text) + '</p></div>';
    html += skipped;
    html += path.nodes.map(function (n) {
      return '<div class="node' + (n.isTarget ? ' target' : '') + '">' +
        '<span class="g">' + esc(R.gradeLabel(n.grade)) + '</span>' +
        '<span class="n">' + esc(n.name) + (n.isTarget ? ' <span class="small muted">（目标知识点）</span>' : '') + '</span>' +
        '<span class="pill pending">候选，待测确认</span></div>';
    }).join('');
    html += '<p class="small muted">' + esc(R.STRUCTURE_FOOTNOTE || '') +
      '（这些节点是「' + esc(targetName || '目标') + '」在图上的前置，不是学生实际断了的地方）。</p>';
    html += renderResult(view);
    $('path-body').innerHTML = html;
    show('sec-path', true);
  }

  /** ⑥ 段的唯一入口：没 result 就不显示；有 result 就合并诊断结论一起渲染 */
  function renderStage6(result, verify) {
    var session = readSession();
    var view = R.buildResultView(session, computeSummary(session), currentTopicId(verify));
    var path = result ? result.path : null;
    var name = (verify && verify.ok && verify.kept.length) ? verify.kept[0].name : null;
    if (!result && !(view && view.ok)) { show('sec-path', false); return; }
    renderPath(path, name, view);
  }

  /* ------------------------------------------------------------- 主流程 */

  /* 把「要显示什么」收成一份原始数据；渲染只是它的消费者。
   * 刷新恢复时喂同一份结构、走同一条渲染路径 —— 恢复出来的页面与刷新前一致，
   * 因为没有第二条渲染路径可以走偏。 */
  function renderState(st) {
    clearSections();
    if (!st) return;
    if (st.fields) renderFields(st.fields);

    if (st.skip === 'notMath') {
      /* 非数学文字（语文/英语/物理…）：先拒绝，不进入候选池流程，避免任何强行匹配 */
      $('pool-body').innerHTML = '<div class="badbox"><strong>拒绝定位：这段文字不是数学题' +
        '（识别到「' + esc(st.subject) + '」）。</strong>' +
        '<p class="small" style="margin:6px 0 0">本页只做数学知识点定位。' +
        '拿一段数学对不上的文字硬套一个数学知识点，学生就会照着复习一小时——宁可不给。</p></div>';
      show('sec-pool', true);
      return;
    }

    if (st.pool) renderPool(st.pool);
    /* ①② 已经渲染完了：后面即使网关挂掉，这两段也在 */
    if (st.skip === 'insufficient') return;

    if (st.picks) renderPicks(st.picks);
    if (st.verify) {
      renderVerify(st.verify);
    } else if (st.skip === 'offline') {
      $('verify-body').innerHTML = '<p class="skip">跳过：没有 LLM 的选择就无法校验。' +
        '（这不是「定位不到」，是这一层没跑起来。）</p>';
      show('sec-verify', true);
    }

    if (st.prereq) {
      renderPrereq(st.prereq);
    } else if (st.skip === 'offline' || st.skip === 'rejected') {
      $('prereq-body').innerHTML = '<p class="skip">' + esc(st.skip === 'offline'
        ? '跳过：定位没确定，不给前置链和路径。'
        : '跳过：校验拒绝，不给前置链。') + '</p>';
      show('sec-prereq', true);
    }

    if (st.picks || st.path) renderStage6(st.path ? { path: st.path } : null, st.verify || null);
  }

  /** 每一步的收尾：渲染 + 存盘 + 放开按钮。存档里是原始数据，view 里不含 HTML。 */
  function finish(st, text) {
    renderState(st);
    setStatus(st.status, st.level);
    hideRestoreBar();   /* 这一屏是刚跑出来的，不再是「恢复上次的分析」 */
    lastView = slimView(st);
    viewText = text;
    persist(text);
    $('btn-run').disabled = false;
  }

  function run() {
    if (!R || !window.__routeReady) {
      setStatus('数据还没加载完，请稍候', 'err');
      return;
    }
    var text = $('in-text').value || '';
    $('btn-run').disabled = true;
    setStatus('解析中……');

    var st = {
      fields: R.parseFields(text), skip: null, subject: null,
      pool: null, picks: null, verify: null, prereq: null, path: null,
      status: '', level: ''
    };

    if (st.fields.subject && st.fields.subject.parsed && !st.fields.subject.math) {
      st.skip = 'notMath';
      st.subject = st.fields.subject.value;
      st.status = '不是数学题，已拒绝定位';
      st.level = 'err';
      finish(st, text);
      return;
    }

    st.pool = R.candidates(st.fields);
    renderState(st);

    if (!st.pool.ok) {
      st.skip = 'insufficient';
      st.status = '信息不足，未做定位';
      st.level = 'err';
      finish(st, text);
      return;
    }

    setStatus('候选池 ' + st.pool.count + ' 个，正在调用网关选择……');
    R.askLLM(st.fields, st.pool.topics, {
      fetch: window.fetch ? window.fetch.bind(window) : null,
      proxy: window.__ROUTE_PROXY || undefined
    })
      .then(function (llm) {
        if (!llm.ok) {
          st.skip = 'offline';
          st.picks = { stage: 'offline', message: llm.why };
          st.status = '网关不可用：①② 已给出，③ 未完成';
          st.level = 'err';
          finish(st, text);
          return;
        }
        st.picks = { stage: 'ok', picks: llm.picks };
        var v = R.verifyPick(llm.picks, { pool: st.pool.topics, fields: st.fields });
        st.verify = v;
        if (!v.ok) {
          st.skip = 'rejected';
          st.status = '校验拒绝：分析结果无法定位到知识点';
          st.level = 'err';
          finish(st, text);
          return;
        }
        st.prereq = R.prerequisites(v.kept[0].id, 2);
        st.path = R.buildPath(st.prereq);
        st.status = '完成：' + v.kept.length + ' 个候选知识点，路径节点都待测确认';
        st.level = '';
        finish(st, text);
      })
      .catch(function (err) {
        st.skip = 'offline';
        st.picks = { stage: 'offline', message: String(err && err.message || err) };
        st.status = '出错了：' + (err && err.message || err);
        st.level = 'err';
        finish(st, text);
      });
  }

  /* --------------------------------------------------------- 恢复与清空 */

  var pendingView = null;   /* 已读到但还没渲染的存档视图（要等数据加载完） */

  function renderPendingView() {
    if (!pendingView || !window.__routeReady) return;
    var st = pendingView;
    pendingView = null;
    renderState(st);
    setStatus(st.status || '', st.level || '');
    lastView = st;
    viewText = $('in-text').value || '';
  }

  /** 页面加载：有存档就恢复输入框 + 顶部提示；各段等数据就绪后再渲染。 */
  function restoreArchive() {
    /* 旧版 route.js 被缓存住时没有这些函数：当作没有存档，绝不让恢复路径拖垮整页 */
    if (!R || typeof R.loadArchive !== 'function') return false;
    var got = R.loadArchive(store());
    if (!got.ok) return false;
    pendingView = got.data.view || null;
    $('in-text').value = got.data.text || '';
    showRestoreBar(got.data.at, !!pendingView);
    renderPendingView();
    return true;
  }

  /** 「清空」：输入、各段、提示条，以及 sessionStorage 里的存档一起清。 */
  function clearAll() {
    $('in-text').value = '';
    clearSections();
    setStatus('');
    lastView = null;
    viewText = '';
    pendingView = null;
    if (R && typeof R.clearArchive === 'function') R.clearArchive(store());
    hideRestoreBar();
  }

  /* ------------------------------------------------------------ 数据加载 */

  function loadData() {
    return Promise.all([
      fetch('../data/topics.json').then(function (r) {
        if (!r.ok) throw new Error('topics.json HTTP ' + r.status);
        return r.json();
      }),
      fetch('../data/dependencies.json').then(function (r) {
        if (!r.ok) throw new Error('dependencies.json HTTP ' + r.status);
        return r.json();
      }),
      /* 题库可选：缺了（404）也不影响 ①②，只是 engine 回退到 diagnostic_question */
      fetch('../data/questions.json').then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; })
    ]).then(function (rs) {
      var info = R.setData(rs[0], rs[1]);
      buildEngineGraph(rs[0], rs[1], rs[2]);
      window.__routeReady = true;
      setStatus('数据已加载：数学知识点 ' + info.topics + ' 个，依赖边 ' + info.dependencies + ' 条');
      renderPendingView();
    }).catch(function (err) {
      setStatus('数据加载失败：' + (err && err.message || err) + '（请用 node scripts/serve.js 起服务后访问）', 'err');
    });
  }

  /* 给 ⑥ 段的诊断结论准备 engine 图。必须在页面层**重建**，不能读 diagnose 页的 window.D：
   * 不同页面不共享 window。过滤口径与 app.js loadData 的数学分支一致（数学题、数学依赖边），
   * 否则 summarize 出来的 weak/roots 会和 diagnose 页里看到的对不上。 */
  function buildEngineGraph(topics, deps, questions) {
    if (!window.DiagEngine) return;   /* engine.js 没加载成功：⑥ 段退回纯候选，不报错 */
    var E = window.DiagEngine;
    var math = (topics || []).filter(function (t) { return E.subjectOf(t) === 'math'; });
    var allow = {};
    math.forEach(function (t) { allow[t.id] = true; });
    var edges = (deps || []).filter(function (d) { return allow[d.topicId] && allow[d.prerequisiteId]; });
    var qs = questions ? questions.filter(function (q) { return allow[q.topicId]; }) : null;
    window.D = window.D || {};
    window.D.engineGraph = E.buildGraph(math, edges, qs);
  }

  /* ---------------------------------------------------------------- 接线 */

  $('btn-run').addEventListener('click', run);
  $('btn-clear').addEventListener('click', clearAll);
  /* 提示条上的「清空」与 #btn-clear 同一个动作：清输入、清各段、清存档 */
  var barClear = $('btn-restore-clear');
  if (barClear) barClear.addEventListener('click', clearAll);

  /* Ctrl/⌘ + Enter 直接定位 */
  $('in-text').addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') run();
  });

  /* 打字就存（300ms 防抖）：刷新/切走回来输入框还在。
   * 文字一改，上次的结果就不再对应这段文字 —— 存档里丢掉旧 view，不拿旧结果冒充新文字的分析。 */
  var inputTimer = null;
  $('in-text').addEventListener('input', function () {
    if (inputTimer) clearTimeout(inputTimer);
    inputTimer = setTimeout(function () {
      inputTimer = null;
      persist($('in-text').value || '');
    }, 300);
  });

  /* 先恢复输入框和提示条（各段等数据就绪后再渲染），再拉数据 */
  if (R) restoreArchive();
  loadData();
})();
