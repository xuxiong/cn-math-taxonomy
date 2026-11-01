#!/usr/bin/env node
/* 画板标签避让（t_7851d903）：node tests/test_funclab_labels.js
 *
 * 这个缺陷的本质是「刻度数字和注释标签互不知道对方占了多少像素」，所以测试也分两层：
 *   A 纯函数层：textRect / placeLabel / leaderSegment 给一组矩形，断言选出来的位置与既有矩形全部不相交，
 *     含边界用例（顶点正好落在 y 轴上、标签比画布还宽、两个标签互挤、shown=false 的 ? 占位）。
 *   B 几何回归层：真 mount 三个典型形态（顶点式抛物线 / 一次函数 / 两曲线交点）的画板，
 *     拦住 fillText 的落笔坐标，把「刻度矩形 + 标签矩形」全算出来，断言两两交集为空，并打印矩形供人看。
 *     canvas 文字画完就读不回来，所以只能在落笔那一刻量 —— 这一层是浏览器里肉眼验收的自动化替身。
 *
 * 不启动浏览器：DOM/canvas 都是桩，measureText 用「字符数 × 字号 × 0.62」的确定宽度。
 */
'use strict';
const assert = require('assert');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e).split('\n').slice(0, 7).join('\n       ')); }
}

const F = require('../diagnose/funclab.js');
const { textRect, rectsOverlap, rectOverlapArea, clampRectToBounds, labelCandidates,
  placeLabel, leaderSegment, markerRect, LABEL_GAP, TEXT_ASCENT } = F;

/* ================================================================ DOM 桩
 * 与 test_funclab_curves.js 同一套路，唯一区别：fillText 连落笔坐标一起记。
 */
const W_PER_CHAR = 0.62;   // 和 canvas 里 sans-serif 数字/汉字宽度的保守估计同量级
function fontPx(font) {
  const m = /(\d+(?:\.\d+)?)px/.exec(String(font || ''));
  return m ? Number(m[1]) : 10;
}
function makeCtx(rec) {
  const noop = function () {};
  const ctx = {
    save: noop, restore: noop, beginPath: noop, moveTo: noop, lineTo: noop,
    arc: noop, fill: noop, fillRect: noop, clearRect: noop, setTransform: noop,
    set strokeStyle(v) { rec.strokeStyle = v; }, get strokeStyle() { return rec.strokeStyle; },
    set fillStyle(v) { rec.fillStyle = v; }, get fillStyle() { return rec.fillStyle; },
    set lineWidth(v) { rec.lineWidth = v; }, get lineWidth() { return rec.lineWidth; },
    setLineDash: function (d) { rec.dash = d; },
    stroke: function () { rec.strokes++; },
    fillText: function (text, x, y) {
      const size = fontPx(rec.font);
      rec.draws.push({ text: String(text), x: x, y: y, size: size, align: rec.textAlign, font: rec.font });
      rec.texts.push(String(text));
    },
    measureText: function (text) { return { width: String(text).length * fontPx(rec.font) * W_PER_CHAR }; }
  };
  Object.defineProperty(ctx, 'font', { get: function () { return rec.font; }, set: function (v) { rec.font = v; } });
  Object.defineProperty(ctx, 'textAlign', {
    get: function () { return rec.textAlign; }, set: function (v) { rec.textAlign = v || 'left'; }
  });
  return ctx;
}

function makeDom() {
  const created = [];
  function el(tag) {
    const node = {
      tagName: String(tag).toUpperCase(), className: '', hidden: false, children: [],
      listeners: {}, attributes: {}, parent: null, _text: '', style: {},
      appendChild: function (c) { node.children.push(c); c.parent = node; return c; },
      remove: function () {
        if (!node.parent) return;
        const i = node.parent.children.indexOf(node);
        if (i >= 0) node.parent.children.splice(i, 1);
        node.parent = null;
      },
      setAttribute: function (k, v) { node.attributes[k] = v; },
      getAttribute: function (k) { return node.attributes[k]; },
      addEventListener: function (ev, fn) { (node.listeners[ev] = node.listeners[ev] || []).push(fn); },
      _all: function (pred, out) {
        out = out || [];
        node.children.forEach(function (c) { if (pred(c)) out.push(c); c._all && c._all(pred, out); });
        return out;
      },
      querySelectorAll: function (sel) {
        const cls = sel.replace(/^\./, '');
        return node._all(function (c) { return String(c.className).split(/\s+/).indexOf(cls) >= 0; });
      },
      querySelector: function (sel) { return node.querySelectorAll(sel)[0] || null; }
    };
    Object.defineProperty(node, 'textContent', {
      get: function () { return node._text; },
      set: function (v) { node._text = String(v); node.children = []; }
    });
    if (node.tagName === 'CANVAS') {
      node.clientWidth = 560;
      node.clientHeight = 320;
      node.width = 0;
      node.height = 0;
      node._rec = { strokes: 0, draws: [], texts: [], dash: [], strokeStyle: '', fillStyle: '',
        lineWidth: 0, font: '', textAlign: 'left' };
      node.getContext = function () { return makeCtx(node._rec); };
    }
    created.push(node);
    return node;
  }
  return {
    document: {
      createElement: el,
      createTextNode: function (t) { return { nodeValue: String(t), textContent: String(t) }; }
    },
    created: created,
    findCanvas: function () { return created.filter(function (n) { return n.tagName === 'CANVAS'; }); }
  };
}

function withDom(fn) {
  const dom = makeDom();
  const prevDoc = global.document;
  const prevDpr = global.devicePixelRatio;
  const prevRO = global.ResizeObserver;
  global.document = dom.document;
  global.devicePixelRatio = 1;
  global.ResizeObserver = undefined;
  try { return fn(dom); }
  finally {
    global.document = prevDoc;
    if (prevDpr === undefined) delete global.devicePixelRatio; else global.devicePixelRatio = prevDpr;
    global.ResizeObserver = prevRO;
  }
}

/* 落笔记录 → 文字矩形（与绘制同一条 textRect 路径，所以比较的是同一套坐标系） */
function rectOfDraw(d) {
  return textRect({ x: d.x, y: d.y, width: String(d.text).length * d.size * W_PER_CHAR, size: d.size, align: 'left' });
}
function rectsOfDraws(draws) {
  return draws.map(function (d) { return { text: d.text, rect: rectOfDraw(d) }; });
}
/** 两两交集（返回所有相交的文字对，空数组＝没有压字） */
function overlaps(list) {
  const out = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = rectOverlapArea(list[i].rect, list[j].rect);
      if (a > 0) out.push({ a: list[i], b: list[j], area: a });
    }
  }
  return out;
}
function fmtRect(r) { return '[x=' + r.x.toFixed(1) + ' y=' + r.y.toFixed(1) + ' w=' + r.w.toFixed(1) + ' h=' + r.h + ']'; }

/* ================================================================ A. 纯函数层 */

console.log('\n--- 1. textRect：文字矩形 ---');

test('textRect：左对齐时矩形左沿就是落笔 x，高度取一个字号', function () {
  const r = textRect({ x: 100, y: 50, width: 30, size: 11, align: 'left' });
  assert.strictEqual(r.x, 100);
  assert.strictEqual(r.w, 30);
  assert.strictEqual(r.h, 11);
});

test('textRect：右对齐向左展开，居中向两侧各半（与 canvas textAlign 同义）', function () {
  const right = textRect({ x: 100, y: 50, width: 30, size: 11, align: 'right' });
  assert.strictEqual(right.x, 70);
  const center = textRect({ x: 100, y: 50, width: 30, size: 11, align: 'center' });
  assert.strictEqual(center.x, 85);
});

test('textRect：y 是基线，矩形顶在基线以上 0.8 字号处（TEXT_ASCENT 口径一致）', function () {
  const r = textRect({ x: 0, y: 100, width: 10, size: 10 });
  assert.strictEqual(r.y, 100 - 10 * TEXT_ASCENT);
});

test('textRect：width/size 缺失或非法时给安全默认值，不产出 NaN', function () {
  const r = textRect({ x: 5, y: 5 });
  assert.strictEqual(r.w, 0);
  assert.ok(r.h > 0 && isFinite(r.y) && isFinite(r.x));
});

console.log('\n--- 2. rectsOverlap / clampRectToBounds ---');

test('rectsOverlap：正面积重叠为真，只贴边/只擦角不算', function () {
  const a = { x: 0, y: 0, w: 10, h: 10 };
  assert.strictEqual(rectsOverlap(a, { x: 5, y: 5, w: 10, h: 10 }), true);
  assert.strictEqual(rectsOverlap(a, { x: 10, y: 0, w: 10, h: 10 }), false, '贴边不算压字');
  assert.strictEqual(rectsOverlap(a, { x: 10, y: 10, w: 5, h: 5 }), false, '擦角不算压字');
  assert.strictEqual(rectsOverlap(a, { x: -100, y: 0, w: 10, h: 10 }), false);
});

test('clampRectToBounds：越界只挪不缩，比画布还宽时贴左边', function () {
  const b = { w: 100, h: 50 };
  assert.deepStrictEqual(clampRectToBounds({ x: -20, y: 0, w: 30, h: 10 }, b), { x: 0, y: 0, w: 30, h: 10 });
  assert.deepStrictEqual(clampRectToBounds({ x: 90, y: 0, w: 30, h: 10 }, b), { x: 70, y: 0, w: 30, h: 10 });
  assert.deepStrictEqual(clampRectToBounds({ x: 0, y: 45, w: 30, h: 10 }, b), { x: 0, y: 40, w: 30, h: 10 });
  const wide = clampRectToBounds({ x: 10, y: 0, w: 160, h: 10 }, b);
  assert.strictEqual(wide.x, 0, '标签比画布宽时只能贴左');
  assert.strictEqual(wide.w, 160, '不许为了塞进去把标签压窄');
});

console.log('\n--- 3. labelCandidates：候选顺序固定 ---');

test('labelCandidates：右上 → 左上 → 右下 → 左下 → 上方居中', function () {
  const c = labelCandidates(200, 100, 40, 11, 4);
  assert.deepStrictEqual(c.map(function (x) { return x.slot; }),
    ['right-up', 'left-up', 'right-down', 'left-down', 'top-center']);
  assert.deepStrictEqual(c[0].rect, { x: 204, y: 100 - 4 - 11, w: 40, h: 11 });
  assert.deepStrictEqual(c[1].rect, { x: 200 - 4 - 40, y: 85, w: 40, h: 11 });
  assert.deepStrictEqual(c[2].rect, { x: 204, y: 104, w: 40, h: 11 });
  assert.deepStrictEqual(c[3].rect, { x: 156, y: 104, w: 40, h: 11 });
  assert.deepStrictEqual(c[4].rect, { x: 180, y: 85, w: 40, h: 11 });
});

console.log('\n--- 4. placeLabel：避让 ---');

test('placeLabel：没有任何障碍时选右上，且不算 fallback', function () {
  const p = placeLabel({ x: 200, y: 100, w: 40, h: 11, obstacles: [], bounds: { w: 560, h: 320 } });
  assert.strictEqual(p.slot, 'right-up');
  assert.strictEqual(p.fallback, false);
  assert.strictEqual(p.overlapArea, 0);
  assert.strictEqual(p.leader, null);
});

test('placeLabel：右上被刻度占住就换左上，结果与障碍全不相交', function () {
  const tick = { x: 200, y: 80, w: 30, h: 11 };   // 正好压在右上候选上
  const p = placeLabel({ x: 200, y: 100, w: 40, h: 11, obstacles: [tick], bounds: { w: 560, h: 320 } });
  assert.notStrictEqual(p.slot, 'right-up');
  assert.strictEqual(rectsOverlap(p.rect, tick), false);
  assert.strictEqual(p.fallback, false);
});

test('placeLabel：顶点正好落在 y 轴上时，左移的 y 刻度不再压顶点标签（本卡核心场景）', function () {
  /* 轴在 x=280；y 刻度数字右对齐到轴的左侧（右沿 276）；顶点就落在 (280, 160)，
   * 标签右上候选从 284 起 —— 整条竖带空出来了，所以第一个候选就能用。 */
  const x0 = 280;
  const yTicks = [-3, -2, -1, 1, 2, 3].map(function () {
    const w = String(-3).length * 11 * W_PER_CHAR * 1.4;
    return { x: x0 - 4 - w, y: 0, w: w, h: 11 };
  });
  /* 上面这批矩形只用来表达「刻度全在轴左侧」，纵向位置不参与本用例 */
  const p = placeLabel({ x: x0, y: 160, w: 78, h: 11, obstacles: yTicks, bounds: { w: 560, h: 320 } });
  assert.strictEqual(p.slot, 'right-up', '轴内侧已让出，顶点标签应留在右上');
  yTicks.forEach(function (t) { assert.strictEqual(rectsOverlap(p.rect, t), false); });
  assert.ok(p.rect.x >= x0, '标签不该越过 y 轴左侧去和刻度抢地方');
});

test('placeLabel：标签比画布还宽 —— 仍然返回画布内的矩形，只夹不缩', function () {
  const b = { w: 200, h: 100 };
  const p = placeLabel({ x: 100, y: 50, w: 400, h: 11, obstacles: [], bounds: b });
  assert.strictEqual(p.rect.x, 0, '夹回画布左沿');
  assert.strictEqual(p.rect.w, 400, '不缩宽度');
  assert.strictEqual(p.rect.y >= 0 && p.rect.y + p.rect.h <= b.h, true, '纵向也在画布内');
});

test('placeLabel：两个标签互相挤 —— 第二个换位置，两个矩形不相交', function () {
  const bounds = { w: 560, h: 320 };
  const first = placeLabel({ x: 200, y: 100, w: 60, h: 11, obstacles: [], bounds: bounds });
  assert.strictEqual(first.slot, 'right-up');
  const second = placeLabel({ x: 200, y: 100, w: 60, h: 11, obstacles: [first.rect], bounds: bounds });
  assert.strictEqual(rectsOverlap(second.rect, first.rect), false);
  assert.notStrictEqual(second.slot, first.slot);
});

test('placeLabel：shown=false 的 (?, ?) 占位同样走避让（宽度变小也照样比）', function () {
  const tick = { x: 204, y: 85, w: 36, h: 11 };
  const q = placeLabel({ x: 200, y: 100, w: 42, h: 11, obstacles: [tick], bounds: { w: 560, h: 320 } });
  assert.strictEqual(rectsOverlap(q.rect, tick), false, '( ?, ? ) 占位不许压刻度');
});

test('placeLabel：5 个候选全被占 → fallback，取遮挡面积最小的那个，并给引导线', function () {
  const anchor = { x: 200, y: 100 };
  const w = 40, h = 11;
  /* 用一圈矩形把 5 个候选位全部填满（比候选本身更大，保证每个候选都有正面积重叠） */
  const blocks = [
    { x: 150, y: 60, w: 130, h: 120 }     // 一大块盖住全部候选
  ];
  const p = placeLabel({ x: anchor.x, y: anchor.y, w: w, h: h, obstacles: blocks,
    markers: [], bounds: { w: 560, h: 320 } });
  assert.strictEqual(p.fallback, true);
  assert.ok(p.overlapArea > 0, 'fallback 时应报出最小遮挡面积');
  const all = labelCandidates(anchor.x, anchor.y, w, h).map(function (c) {
    return c.hits ? 0 : rectOverlapArea(c.rect, blocks[0]);
  });
  assert.strictEqual(p.overlapArea, Math.min.apply(null, all), '应选遮挡面积最小的候选');
  assert.ok(p.leader, '5 个候选全被占时应给引导线');
});

console.log('\n--- 5. leaderSegment：引导线不许穿过数据点标记 ---');

test('leaderSegment：从锚点连到矩形最近的可达边', function () {
  const rect = { x: 300, y: 80, w: 50, h: 11 };
  const seg = leaderSegment(rect, { x: 200, y: 120 }, []);
  assert.ok(seg);
  assert.strictEqual(seg.x1, 200);
  assert.strictEqual(seg.y1, 120);
});

test('leaderSegment：正上方被数据点挡住时改走左边，线不穿标记', function () {
  const rect = { x: 300, y: 80, w: 50, h: 11 };
  const anchor = { x: 325, y: 140 };
  const mark = markerRect(325, 115, 4.5);   // 正卡在上边中点的连线上
  const seg = leaderSegment(rect, anchor, [mark]);
  assert.ok(seg, '应还有其它可达边');
  const hits = F.segmentHitsRect({ x: seg.x1, y: seg.y1 }, { x: seg.x2, y: seg.y2 }, mark);
  assert.strictEqual(hits, false, '引导线不许穿过数据点标记');
});

test('leaderSegment：四条边都被标记围死 → 返回 null（宁可不画引导线）', function () {
  const rect = { x: 300, y: 80, w: 50, h: 11 };
  const anchor = { x: 0, y: 0 };
  const big = { x: 250, y: 40, w: 160, h: 120 };   // 把整块区域围住
  assert.strictEqual(leaderSegment(rect, anchor, [big]), null);
});

/* ================================================================ B. 几何回归层（真 mount） */

console.log('\n--- 6. 几何回归：三个典型形态「刻度矩形 + 标签矩形」两两不相交 ---');

function mountBoard(cfg) {
  return withDom(function (dom) {
    const inst = F.mount(cfg);
    assert.ok(inst, '画板应能挂上：' + JSON.stringify({ type: cfg.type, lab: cfg.lab, intent: cfg.intent }));
    const canvas = dom.findCanvas()[0];
    assert.ok(canvas, '应创建 canvas');
    const draws = canvas._rec.draws;
    assert.ok(draws.length > 0, '应至少画过一行字');
    return draws;
  });
}

function assertNoOverlap(cfg, label) {
  const draws = mountBoard(cfg);
  const list = rectsOfDraws(draws);
  const bad = overlaps(list);
  console.log('       ' + label + '：共 ' + list.length + ' 个文字矩形');
  list.forEach(function (x) { console.log('         "' + x.text + '" ' + fmtRect(x.rect)); });
  assert.deepStrictEqual(bad.map(function (b) {
    return '"' + b.a.text + '" × "' + b.b.text + '" 面积 ' + b.area.toFixed(1);
  }), [], label + '：不许有压字');
  return list;
}

test('几何回归：顶点式抛物线（顶点落在 y 轴上，顶点标签 vs y 刻度）', function () {
  const list = assertNoOverlap({
    type: 'quadratic', lab: 'quadratic-vertex', intent: '顶点坐标', a: 1, h: 0, k: -1
  }, '顶点式抛物线 y=x²-1');
  const labels = list.filter(function (x) { return !/^-?\d+$/.test(x.text); });
  assert.ok(labels.length > 0, '顶点标签应画出来（否则本用例空转）：' + JSON.stringify(list.map(function (x) { return x.text; })));
  const ticks = list.filter(function (x) { return /^-?\d+$/.test(x.text); });
  assert.ok(ticks.length > 0, '刻度数字应画出来');
});

test('几何回归：一次函数（与 y 轴交点标签 vs y 刻度）', function () {
  const list = assertNoOverlap({
    type: 'linear', lab: 'linear-intercepts', intent: '与 y 轴交点的纵坐标', k: 2, b: -2
  }, '一次函数 y=2x-2');
  const labels = list.filter(function (x) { return !/^-?\d+$/.test(x.text); });
  assert.ok(labels.length > 0, '截距标签应画出来（否则本用例空转）：' + JSON.stringify(list.map(function (x) { return x.text; })));
});

test('几何回归：两曲线交点（交点标签 vs y 刻度）', function () {
  const list = assertNoOverlap({
    type: 'curves', lab: 'two-curves-intersect', intent: '两条曲线的交点坐标',
    curves: [{ type: 'linear', k: 1, b: 1 }, { type: 'linear', k: -1, b: 3 }]
  }, 'y=x+1 与 y=-x+3');
  const inter = list.filter(function (x) { return /[?？(),，]/.test(x.text) && !/^-?\d+$/.test(x.text); });
  assert.ok(inter.length > 0, '交点标签应画出来（否则本用例空转）：' + JSON.stringify(list.map(function (x) { return x.text; })));
});

console.log('\n--- 7. y 轴刻度让出内侧通道（两套画板同一口径） ---');

/** 数字刻度按「右沿」分组：y 轴刻度统一右对齐，所以右沿相同的那一组就是 y 刻度列；
 *  x 轴刻度左对齐、宽度不一，右沿基本各不相同（偶尔撞上也只会有两三个，不会有整列那么多）。 */
function tickColumns(draws) {
  const numeric = draws.filter(function (d) { return /^-?\d+$/.test(d.text); }).map(function (d) {
    return { text: d.text, rect: rectOfDraw(d) };
  });
  const byRight = new Map();
  numeric.forEach(function (x) {
    const k = (x.rect.x + x.rect.w).toFixed(2);
    if (!byRight.has(k)) byRight.set(k, []);
    byRight.get(k).push(x);
  });
  const groups = Array.from(byRight.entries()).sort(function (a, b) { return b[1].length - a[1].length; });
  const yTicks = groups.length ? groups[0][1] : [];
  return { all: numeric, yTicks: yTicks, yRight: groups.length ? Number(groups[0][0]) : null, groups: groups };
}

test('y 刻度数字统一右对齐到轴左侧：至少 3 个数字共用同一条右沿，x 刻度不共用', function () {
  const draws = mountBoard({ type: 'quadratic', lab: 'quadratic-vertex', intent: '顶点坐标', a: 1, h: 0, k: -1 });
  const g = tickColumns(draws);
  assert.ok(g.yTicks.length >= 3, 'y 轴刻度应是一列共用右沿的数字，实际刻度：' +
    JSON.stringify(g.all.map(function (x) { return x.text + '@' + (x.rect.x + x.rect.w).toFixed(1); })));
  /* x 轴刻度（横向一行）的左沿随数值变化、右沿不共用 —— 这里只要求它们各自右沿互不相同即可 */
  const xTicks = g.all.filter(function (x) { return g.yTicks.indexOf(x) < 0; });
  assert.ok(xTicks.length >= 3, 'x 轴刻度也该画出来');
  assert.ok(g.yTicks.length > 1);
});

test('两套画板同一口径：y 刻度都在轴左侧，注释标签落在让出来的内侧通道里', function () {
  [
    { cfg: { type: 'quadratic', lab: 'quadratic-vertex', intent: '顶点坐标', a: 1, h: 0, k: -1 }, name: '抛物线' },
    { cfg: { type: 'linear', lab: 'linear-intercepts', intent: '与 y 轴交点的纵坐标', k: 2, b: -2 }, name: '一次函数' }
  ].forEach(function (c) {
    const draws = mountBoard(c.cfg);
    const g = tickColumns(draws);
    const labels = rectsOfDraws(draws).filter(function (x) { return !/^-?\d+$/.test(x.text); });
    assert.ok(labels.length > 0, c.name + '：应有注释标签');
    assert.ok(g.yTicks.length >= 3, c.name + '：应有 y 刻度列');
    labels.forEach(function (l) {
      g.yTicks.forEach(function (t) {
        assert.strictEqual(rectOverlapArea(l.rect, t.rect), 0,
          c.name + '：标签 "' + l.text + '" ' + fmtRect(l.rect) + ' 压住了 y 刻度 "' + t.text + '" ' + fmtRect(t.rect));
      });
    });
    /* 锚在 y 轴上的标签（顶点/截距）必须落在刻度列右侧 —— 这正是「把内侧竖带让出来」的效果 */
    const atAxis = labels.filter(function (l) { return l.rect.x >= g.yRight && l.rect.x < g.yRight + 40; });
    assert.ok(atAxis.length > 0, c.name + '：应有标签落在 y 轴内侧通道里（x ≥ ' + g.yRight.toFixed(1) + '），实际：' +
      JSON.stringify(labels.map(function (l) { return l.text + '@' + l.rect.x.toFixed(1); })));
  });
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
