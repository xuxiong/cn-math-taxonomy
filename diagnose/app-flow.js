/* 先修路径图（Cytoscape + dagre）：只在结果页「看路径」时用，搬出首屏。
 * 本文件是对按需段 app-flow.js 的一部分（本批次只搬路径图这组，出题/结果/练习留待后续批次）。
 * 通过 DiagCore（app.js 顶部的 CORE）拿唯一的一份状态 S 与工具函数，不复制状态。
 * 拆分的唯一目的是首屏字节：cytoscape+dagre 约 186KB、结果页渲染等都不该在首屏 <script> 链上。 */
(function (global, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(global);
  else global.DiagFlow = factory(global);
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (global) {
  'use strict';
  /* Node（CommonJS）下模块顶层 this 是 module.exports，不是全局，故上面用 globalThis 兜底；
   * CORE 由 app.js 挂到全局（浏览器 window.DiagCore / Node global.DiagCore），这里现取。 */
  var CORE = global.DiagCore;
  if (!CORE) throw new Error('app-flow.js 需要先加载 app.js（DiagCore）');
  var S = CORE.S, E = CORE.E, h = CORE.h, Lazy = CORE.Lazy;
  var nameOf = CORE.nameOf, clipLabel = CORE.clipLabel, labelLimit = CORE.labelLimit, theme = CORE.theme;
  var lazyFail = CORE.lazyFail, LAZY_PATH = CORE.LAZY_PATH, PATH_FOLD_AT = CORE.PATH_FOLD_AT, STATUS_LABEL = CORE.STATUS_LABEL;

  /* 以下函数逐字从 app.js 搬来，仅把核心工具引用换成上面的别名（S.xxx 是对象字段，无需改）。 */

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
    const lay = E.layout(S.D.graph, S.session, sum);
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

  /* 对外只暴露结果页/事件要调用的入口；内部辅助（pathNodeElement 等）留在这层闭包里。
   * app.js 经 FLOW.xxx 调用它们；FLOW 由 registerFlow 注入。 */
  return { mountPathGraph: mountPathGraph, ensureDagre: ensureDagre, pathFit: pathFit, pathZoom: pathZoom };
});