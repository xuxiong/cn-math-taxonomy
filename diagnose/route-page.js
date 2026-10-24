/* route.html 的页面层：DOM 渲染 + 数据加载 + 调网关。
 *
 * 分工（对应验收标准 7）：
 *   ①② 解析字段 / 候选池 —— 纯确定性，点「定位」后**立刻**渲染，不依赖网关；
 *   ③④ LLM 选择 / 校验 —— 需要网关，网关不可用时给明确提示，不白屏；
 *   ⑤⑥ 前置链 / 路径 —— 只在 ④ 通过后才算，本身就是确定性计算。
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
          (k.notes && k.notes.length ? '　' + esc(k.notes.join('；')) : '') + '</span></li>';
      }).join('') + '</ul>';
      if (v.kept.length > 1) {
        html += '<p class="small muted">给了 ' + v.kept.length + ' 个候选，请让学生点自己认的那一个——' +
          '不自作聪明只给一个。</p>';
      }
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

  /* ----------------------------------------------------------- ⑥ 学习路径 */

  function renderPath(path, targetName) {
    if (!path || !path.nodes.length) {
      $('path-body').innerHTML = '<p class="skip">没有可给的路径</p>';
      show('sec-path', true);
      return;
    }
    var html = '<div class="warnbox"><strong>路径不是诊断结论。</strong>' +
      '<p class="small" style="margin:6px 0 0">' + esc(path.note) + '</p></div>';
    html += path.nodes.map(function (n) {
      return '<div class="node' + (n.isTarget ? ' target' : '') + '">' +
        '<span class="g">' + esc(R.gradeLabel(n.grade)) + '</span>' +
        '<span class="n">' + esc(n.name) + (n.isTarget ? ' <span class="small muted">（目标知识点）</span>' : '') + '</span>' +
        '<span class="pill pending">候选，待测确认</span></div>';
    }).join('');
    html += '<p class="small muted">从低年级往上走：前面的节点是' +
      esc(targetName || '目标') + '的 hard 前置。每个节点都是<strong>候选薄弱点</strong>，' +
      '要学生做一道题确认，确认之前不要当成已诊断。</p>';
    $('path-body').innerHTML = html;
    show('sec-path', true);
  }

  /* ------------------------------------------------------------- 主流程 */

  function run() {
    if (!R || !window.__routeReady) {
      setStatus('数据还没加载完，请稍候', 'err');
      return;
    }
    clearSections();
    var text = $('in-text').value || '';
    $('btn-run').disabled = true;
    setStatus('解析中……');

    var fields = R.parseFields(text);
    renderFields(fields);

    /* 非数学文字（语文/英语/物理…）：先拒绝，不进入候选池流程，避免任何强行匹配 */
    if (fields.subject && fields.subject.parsed && !fields.subject.math) {
      $('pool-body').innerHTML = '<div class="badbox"><strong>拒绝定位：这段文字不是数学题' +
        '（识别到「' + esc(fields.subject.value) + '」）。</strong>' +
        '<p class="small" style="margin:6px 0 0">本页只做数学知识点定位。' +
        '拿一段数学对不上的文字硬套一个数学知识点，学生就会照着复习一小时——宁可不给。</p></div>';
      show('sec-pool', true);
      setStatus('不是数学题，已拒绝定位', 'err');
      $('btn-run').disabled = false;
      return;
    }

    var pool = R.candidates(fields);
    renderPool(pool);

    /* ① ② 已经渲染完了：后面即使网关挂掉，这两段也在 */
    if (!pool.ok) {
      setStatus('信息不足，未做定位', 'err');
      $('btn-run').disabled = false;
      return;
    }

    setStatus('候选池 ' + pool.count + ' 个，正在调用网关选择……');
    R.askLLM(fields, pool.topics, {
      fetch: window.fetch ? window.fetch.bind(window) : null,
      proxy: window.__ROUTE_PROXY || undefined
    })
      .then(function (llm) {
        if (!llm.ok) {
          renderPicks({ stage: 'offline', message: llm.why });
          $('verify-body').innerHTML = '<p class="skip">跳过：没有 LLM 的选择就无法校验。' +
            '（这不是「定位不到」，是这一层没跑起来。）</p>';
          show('sec-verify', true);
          $('prereq-body').innerHTML = '<p class="skip">跳过：定位没确定，不给前置链和路径。</p>';
          show('sec-prereq', true);
          $('path-body').innerHTML = '<p class="skip">跳过：定位没确定，不给路径。宁可空着，也不给一条可能全错的复习路线。</p>';
          show('sec-path', true);
          setStatus('网关不可用：①② 已给出，③ 未完成', 'err');
          $('btn-run').disabled = false;
          return;
        }
        renderPicks({ stage: 'ok', picks: llm.picks });
        var v = R.verifyPick(llm.picks, { pool: pool.topics, fields: fields });
        renderVerify(v);
        if (!v.ok) {
          $('prereq-body').innerHTML = '<p class="skip">跳过：校验拒绝，不给前置链。</p>';
          show('sec-prereq', true);
          $('path-body').innerHTML = '<p class="skip">跳过：校验拒绝，不给路径。</p>';
          show('sec-path', true);
          setStatus('校验拒绝：分析结果无法定位到知识点', 'err');
          $('btn-run').disabled = false;
          return;
        }
        var pre = R.prerequisites(v.kept[0].id, 2);
        renderPrereq(pre);
        renderPath(R.buildPath(pre), v.kept[0].name);
        setStatus('完成：' + v.kept.length + ' 个候选知识点，路径节点都待测确认', '');
        $('btn-run').disabled = false;
      })
      .catch(function (err) {
        renderPicks({ stage: 'offline', message: String(err && err.message || err) });
        setStatus('出错了：' + (err && err.message || err), 'err');
        $('btn-run').disabled = false;
      });
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
      })
    ]).then(function (rs) {
      var info = R.setData(rs[0], rs[1]);
      window.__routeReady = true;
      setStatus('数据已加载：数学知识点 ' + info.topics + ' 个，依赖边 ' + info.dependencies + ' 条');
    }).catch(function (err) {
      setStatus('数据加载失败：' + (err && err.message || err) + '（请用 node scripts/serve.js 起服务后访问）', 'err');
    });
  }

  $('btn-run').addEventListener('click', run);
  $('btn-clear').addEventListener('click', function () {
    $('in-text').value = '';
    clearSections();
    setStatus('');
  });
  /* Ctrl/⌘ + Enter 直接定位 */
  $('in-text').addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') run();
  });

  loadData();
})();
