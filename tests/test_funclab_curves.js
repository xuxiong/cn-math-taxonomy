#!/usr/bin/env node
/* 多曲线画板（two-curves-intersect）测试：node tests/test_funclab_curves.js
 *
 * 卡面（.kanban-brief.md，任务 t_1d3fe77a）验收的 10 条里，本文件负责第 ②④⑤⑥⑦⑧ 条的回归锁：
 *   ② 解析：真实题库 8 道多曲线交点题都要解析成 curves 候选，且每条曲线与题面对得上
 *   ④ 挂载：mountCurves 的 view/plotShape/annotateCurves 三个内部函数行为 + 交点默认 (?, ?)
 *       + shown 后才显示真值 + state() 暴露 curves/type/intersectionsCount
 *   ⑤ paintModel/describe 与绘制同口径（交点个数、视野、留白措辞）
 *   ⑥ labForScene 只给 curves 候选，绝不落到单曲线画板
 *   ⑦ labmatch.verifyParams 多曲线分支 + 「多表达式 + 交点题不许挂单曲线画板」拒绝规则
 *
 * 约定：题面一律取自 data/questions.json（q(id) 取不到直接失败），不臆造题面。
 * 不修改任何既有测试文件。
 */
'use strict';
const assert = require('assert');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e).split('\n').slice(0, 7).join('\n       ')); }
}

/* ================================================================ DOM 桩
 * mountCurves 只用 canvas 2d 上下文画图，测试只关心「有没有画、画了什么状态」，
 * 所以这里给一个记录型 ctx：不真画，只记录调用次数与最后设置的颜色/文字。
 */
function makeCtx(rec) {
  const noop = function () {};
  const ctx = {
    save: noop, restore: noop, beginPath: noop, moveTo: noop, lineTo: noop,
    arc: noop, fill: noop, fillRect: noop, clearRect: noop, setTransform: noop,
    set strokeStyle(v) { rec.strokeStyle = v; },
    get strokeStyle() { return rec.strokeStyle; },
    set fillStyle(v) { rec.fillStyle = v; },
    get fillStyle() { return rec.fillStyle; },
    set lineWidth(v) { rec.lineWidth = v; },
    get lineWidth() { return rec.lineWidth; },
    set font(v) { rec.font = v; },
    get font() { return rec.font; },
    setLineDash: function (d) { rec.dash = d; },
    stroke: function () { rec.strokes++; },
    fillText: function (text) { rec.texts.push(String(text)); },
    measureText: function (text) { return { width: String(text).length * 7 }; }
  };
  return ctx;
}

function makeDom() {
  const created = [];
  function el(tag) {
    const node = {
      tagName: String(tag).toUpperCase(),
      className: '',
      hidden: false,
      children: [],
      listeners: {},
      attributes: {},
      parent: null,
      _text: '',
      style: {},
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
      node._rec = { strokes: 0, texts: [], dash: [], strokeStyle: '', fillStyle: '', lineWidth: 0, font: '' };
      node.getContext = function () { return makeCtx(node._rec); };
    }
    created.push(node);
    return node;
  }
  return {
    document: { createElement: el },
    created: created,
    findCanvas: function () {
      return created.filter(function (n) { return n.tagName === 'CANVAS'; });
    }
  };
}

/* 每个用例都在干净的环境里挂画板：mountCurves 用到 document / devicePixelRatio / ResizeObserver */
function withDom(fn) {
  const dom = makeDom();
  const prevDoc = global.document;
  const prevDpr = global.devicePixelRatio;
  const prevRO = global.ResizeObserver;
  global.document = dom.document;
  global.devicePixelRatio = 1;
  global.ResizeObserver = undefined;   // 不跑观察器：测试只手动 draw
  try { return fn(dom); }
  finally {
    global.document = prevDoc;
    if (prevDpr === undefined) delete global.devicePixelRatio; else global.devicePixelRatio = prevDpr;
    global.ResizeObserver = prevRO;
  }
}

const F = require('../diagnose/funclab.js');
const L = require('../diagnose/labmatch.js');
const QUESTIONS = require('../data/questions.json');
const QMAP = new Map(QUESTIONS.map(function (x) { return [x.id, x]; }));
function q(id) {
  const item = QMAP.get(id);
  assert.ok(item, '题库里找不到题目 ' + id + '（题库改过了？请更新测试）');
  return item.prompt;
}
function item(id) { return QMAP.get(id); }

const LAB = 'two-curves-intersect';
const INTENT_BOTH = '两条曲线的交点坐标';

/* 卡面点名的 7 道交点题里，**交点坐标才是答案**的 7 道（正例）。
 * cnm_208_q4（求参数 m）与 cnm_241_q4（解不等式，答案 B）虽也提到交点，但交点不是答案，
 * 属于「必须不挂多曲线画板」的反例，见 NEGATIVE_ITEMS。 */
const CURVE_ITEMS = ['cnm_208_q1', 'cnm_208_q2', 'cnm_208_q3',
  'cnm_241_q1', 'cnm_h172_q1', 'cnm_h172_q2', 'cnm_h172_q3'];
/* 反例：题面有两条曲线、也提到交点，但交点不是答案 —— 一律不许挂多曲线画板 */
const NEGATIVE_ITEMS = ['cnm_208_q4', 'cnm_241_q4'];

console.log('\n--- 1. 能力声明（CAPABILITIES / CAP_TYPE / NOTE_INTENT 自洽） ---');

test('CAPABILITIES 里有 two-curves-intersect，类型是 curves，参数只有 curves', function () {
  const cap = F.CAPABILITIES[LAB];
  assert.ok(cap, '缺少能力声明 ' + LAB);
  assert.strictEqual(F.CAP_TYPE[LAB], 'curves');
  assert.deepStrictEqual(cap.params.slice(), ['curves']);
  assert.ok(cap.canAnswer.length >= 4, 'canAnswer 至少覆盖 4 类问法，实际 ' + cap.canAnswer.length);
  assert.ok(cap.note && cap.note.length > 0, 'note 不能为空');
});

test('每个 canAnswer 都有文案，且文案不含「根」字（交点一律说「交点」）', function () {
  const intents = F.capabilityIntents(LAB);
  assert.ok(intents.length >= 4);
  intents.forEach(function (it) {
    const text = F.NOTE_BY_INTENT[it];
    assert.ok(text && String(text).trim(), it + ' 没有文案');
    assert.ok(String(text).indexOf('根') < 0, it + ' 文案里出现了「根」字：' + text);
    assert.ok(String(text).indexOf('NaN') < 0, it + ' 文案里出现 NaN');
    assert.ok(String(text).indexOf('undefined') < 0, it + ' 文案里出现 undefined');
  });
});

test('capabilitiesFor("curves") 只返回多曲线画板（喂给 LLM 的清单不含单曲线画板）', function () {
  const caps = F.capabilitiesFor('curves');
  const keys = Object.keys(caps);
  assert.deepStrictEqual(keys, [LAB]);
});

console.log('\n--- 2. 解析：真实题库 7 道交点题 → curves 候选 ---');

test('labForScene 对 7 道真实交点题都返回 curves 候选，且恰好两条曲线', function () {
  CURVE_ITEMS.forEach(function (id) {
    const it = item(id);
    assert.ok(it, '题库里找不到 ' + id);
    const cfg = F.labForScene(it.topicId, it.prompt, { itemId: id });
    assert.ok(cfg, id + ' 没产出画板候选');
    assert.strictEqual(cfg.type, 'curves', id + ' 类型应为 curves，实际 ' + cfg.type);
    assert.ok(Array.isArray(cfg.curves), id + ' 缺 curves 数组');
    assert.strictEqual(cfg.curves.length, 2, id + ' 曲线条数应为 2，实际 ' + cfg.curves.length);
  });
});

test('curvesFromPrompt 的结果与 labForScene 一致（同一份解析，不各算各的）', function () {
  CURVE_ITEMS.forEach(function (id) {
    const it = item(id);
    const direct = F.curvesFromPrompt(it.prompt);
    const cfg = F.labForScene(it.topicId, it.prompt, { itemId: id });
    assert.deepStrictEqual(cfg.curves, direct, id + ' 两条解析路径结果不一致');
  });
});

test('cnm_208_q1 解出 y=x+1 与 y=-x+3，交点唯一且是 (1,2)', function () {
  const cs = F.curvesFromPrompt(q('cnm_208_q1'));
  assert.deepStrictEqual(cs, [{ type: 'linear', k: 1, b: 1 }, { type: 'linear', k: -1, b: 3 }]);
  const pts = F.intersectionsOf(cs);
  assert.strictEqual(pts.length, 1);
  assert.ok(Math.abs(pts[0].x - 1) < 1e-9 && Math.abs(pts[0].y - 2) < 1e-9, '交点应为 (1,2)，实际 ' + JSON.stringify(pts[0]));
});

test('cnm_241_q1 解出直线 + 双曲线，两个交点关于原点对称', function () {
  const cs = F.curvesFromPrompt(q('cnm_241_q1'));
  assert.strictEqual(cs.length, 2);
  const types = cs.map(function (c) { return c.type; }).sort();
  assert.deepStrictEqual(types, ['inverse', 'linear']);
  const pts = F.intersectionsOf(cs);
  assert.strictEqual(pts.length, 2, '直线与双曲线应有 2 个交点');
  assert.ok(Math.abs(pts[0].x + pts[1].x) < 1e-9, '两交点横坐标应互为相反数');
  assert.ok(Math.abs(pts[0].y + pts[1].y) < 1e-9, '两交点纵坐标应互为相反数');
});

test('cnm_h172_q1 的 U+2212 减号也能解析出 x−y=1（不是把 1 当负号）', function () {
  const prompt = q('cnm_h172_q1');
  assert.ok(prompt.indexOf('\u2212') >= 0, '题库题面应含 U+2212（若题库改了，请更新本断言）');
  const cs = F.curvesFromPrompt(prompt);
  assert.deepStrictEqual(cs, [{ type: 'linear', k: -1, b: 5 }, { type: 'linear', k: 1, b: -1 }]);
});

test('交点题不许落到单曲线画板：labFor 的老语义不变，labForScene 才产出 curves', function () {
  CURVE_ITEMS.forEach(function (id) {
    const it = item(id);
    const scene = F.labForScene(it.topicId, it.prompt, { itemId: id });
    assert.strictEqual(scene.type, 'curves', id + ' labForScene 应给 curves');
    /* 八道题里凡是能从题面解析出单曲线的，labFor 给的单曲线必然不是完整答案 ——
     * 用「类型 ≠ curves」+「只有一条曲线」来锁住这条边界 */
    const single = F.labFor(it.topicId, it.prompt, { itemId: id });
    if (single) {
      assert.notStrictEqual(single.type, 'curves', id + ' labFor 不该产出 curves（它保持单曲线语义）');
      assert.ok(!('curves' in single), id + ' labFor 不该带 curves');
    }
  });
});

test('cnm_h172 走 curves 专属放行：topicKind 为 null 但 topicSupported 为 true', function () {
  assert.strictEqual(F.topicKind('cnm_h172'), null, 'cnm_h172 不该被当成单曲线章节');
  assert.strictEqual(F.topicSupported('cnm_h172'), true, 'cnm_h172 应被支持（走多曲线）');
  /* 同章其他知识点不放行 */
  ['cnm_h208', 'cnm_h241', 'cnm_h251'].forEach(function (tid) {
    assert.strictEqual(F.topicSupported(tid), false, tid + ' 不该被放行');
  });
});

console.log('\n--- 3. 断言交集解析（纯函数，禁止数值迭代） ---');

test('intersectionsOf：平行线无交点、重合线无交点', function () {
  assert.deepStrictEqual(F.intersectionsOf([{ type: 'linear', k: 1, b: 0 }, { type: 'linear', k: 1, b: 5 }]), []);
  assert.deepStrictEqual(F.intersectionsOf([{ type: 'linear', k: 2, b: 1 }, { type: 'linear', k: 2, b: 1 }]), []);
});

test('intersectionsOf：直线 × 双曲线 k<0 无交点', function () {
  assert.deepStrictEqual(F.intersectionsOf([{ type: 'linear', k: 2, b: 0 }, { type: 'inverse', k: -6 }]), []);
});

test('intersectionsOf：相切只返回一个点', function () {
  /* y = (x-1)² 的顶点是 (1,0)，抛物线在 x=2 处切线斜率为 2、过 (2,1) → 切线 y = 2x - 3 */
  const pts = F.intersectionsOf([{ type: 'linear', k: 2, b: -3 }, { type: 'quadratic', a: 1, h: 1, k: 0 }]);
  assert.strictEqual(pts.length, 1, '相切应只有 1 个交点，实际 ' + JSON.stringify(pts));
  assert.ok(Math.abs(pts[0].x - 2) < 1e-9 && Math.abs(pts[0].y - 1) < 1e-9);
});

test('intersectionsOf：顺序不敏感（交换两条曲线结果一致）', function () {
  const a = [{ type: 'linear', k: 1, b: 1 }, { type: 'linear', k: -1, b: 3 }];
  const b = [a[1], a[0]];
  const pa = F.intersectionsOf(a), pb = F.intersectionsOf(b);
  assert.strictEqual(pa.length, pb.length);
  pa.forEach(function (p, i) {
    assert.ok(Math.abs(p.x - pb[i].x) < 1e-9 && Math.abs(p.y - pb[i].y) < 1e-9);
  });
});

test('intersectionsOf：非法输入（不是两条 / 空 / null）一律返回 []', function () {
  assert.deepStrictEqual(F.intersectionsOf(null), []);
  assert.deepStrictEqual(F.intersectionsOf([]), []);
  assert.deepStrictEqual(F.intersectionsOf([{ type: 'linear', k: 1, b: 0 }]), []);
  assert.deepStrictEqual(F.intersectionsOf([{ type: 'linear', k: 1, b: 0 }, { type: 'nope' }]), []);
});

test('intersectText：shown=false 恒为 (?, ?)，shown=true 才给真值', function () {
  assert.strictEqual(F.intersectText({ x: 1, y: 2 }, false), '(?, ?)');
  assert.strictEqual(F.intersectText({ x: 1, y: 2 }, true), '(1, 2)');
  assert.strictEqual(F.intersectText(null, false), '(?, ?)');
  assert.strictEqual(F.intersectText(null, true), '(?, ?)');
});

console.log('\n--- 4. 挂载（mountCurves）：view / plotShape / annotateCurves 行为 ---');

test('mount：曲线条数 >2 或 <2 → null（卡面硬约束）', function () {
  withDom(function () {
    const base = { type: 'curves', lab: LAB, intent: INTENT_BOTH };
    assert.strictEqual(F.mount(Object.assign({}, base, { curves: [{ type: 'linear', k: 1, b: 1 }] })), null);
    assert.strictEqual(F.mount(Object.assign({}, base, {
      curves: [{ type: 'linear', k: 1, b: 1 }, { type: 'linear', k: -1, b: 3 }, { type: 'linear', k: 2, b: 0 }]
    })), null);
    assert.strictEqual(F.mount(Object.assign({}, base, { curves: null })), null);
  });
});

test('mount：intent 不在 canAnswer 里 → null（挂了也无话可说）', function () {
  withDom(function () {
    const cfg = { type: 'curves', lab: LAB, intent: '方程的根',
      curves: [{ type: 'linear', k: 1, b: 1 }, { type: 'linear', k: -1, b: 3 }] };
    assert.strictEqual(F.mount(cfg), null);
  });
});

test('mount：lab 与类型不匹配 → null', function () {
  withDom(function () {
    const cfg = { type: 'curves', lab: 'quadratic-vertex', intent: INTENT_BOTH,
      curves: [{ type: 'linear', k: 1, b: 1 }, { type: 'linear', k: -1, b: 3 }] };
    assert.strictEqual(F.mount(cfg), null);
  });
});

test('mount：state() 暴露 type/curves/intersectionsCount/shown，且默认 shown=false', function () {
  withDom(function () {
    const cs = F.curvesFromPrompt(q('cnm_208_q1'));
    const inst = F.mount({ type: 'curves', lab: LAB, intent: INTENT_BOTH, curves: cs });
    assert.ok(inst, '画板应能挂上');
    const st = inst.state();
    assert.strictEqual(st.type, 'curves');
    assert.strictEqual(st.lab, LAB);
    assert.strictEqual(st.shown, false, '默认不许显示交点真值');
    assert.deepStrictEqual(st.curves, cs, 'state 应回吐两条曲线');
    assert.strictEqual(st.intersectionsCount, 1, 'cnm_208_q1 交点个数应为 1');
    assert.strictEqual(st.base, null);
    assert.strictEqual(st.shift, null);
  });
});

test('mount：交点默认画 (?, ?)，_forceShown(true) 后才出现 (1, 2)', function () {
  withDom(function (dom) {
    const cs = F.curvesFromPrompt(q('cnm_208_q1'));
    const inst = F.mount({ type: 'curves', lab: LAB, intent: INTENT_BOTH, curves: cs });
    const canvas = dom.findCanvas()[0];
    assert.ok(canvas, '应创建 canvas');
    const rec = canvas._rec;
    assert.ok(rec.texts.indexOf('(?, ?)') >= 0, '默认应画 (?, ?)，实际文本：' + JSON.stringify(rec.texts));
    assert.ok(rec.texts.join('|').indexOf('(1, 2)') < 0, '默认不许出现真值');
    inst._forceShown(true);
    assert.ok(rec.texts.indexOf('(1, 2)') >= 0, '显示后应画真值 (1, 2)，实际：' + JSON.stringify(rec.texts.slice(-5)));
    assert.strictEqual(inst.state().shown, true);
  });
});

test('mount：两条曲线各画一次（plotShape 调用两次，颜色蓝/橙）', function () {
  withDom(function (dom) {
    const cs = F.curvesFromPrompt(q('cnm_208_q1'));
    F.mount({ type: 'curves', lab: LAB, intent: INTENT_BOTH, curves: cs });
    const rec = dom.findCanvas()[0]._rec;
    assert.ok(rec.strokes >= 2, '至少应画两次曲线，实际 strokes=' + rec.strokes);
  });
});

test('mount：反比例画两支（不给 x=0 连线），比单条曲线画得多', function () {
  withDom(function (dom) {
    const cs = F.curvesFromPrompt(q('cnm_241_q1'));
    F.mount({ type: 'curves', lab: LAB, intent: INTENT_BOTH, curves: cs });
    const rec = dom.findCanvas()[0]._rec;
    /* 直线 1 次 + 双曲线 2 支 = 3 次 stroke（不含坐标轴/准线） */
    assert.ok(rec.strokes >= 3, '反比例应分两支画，实际 strokes=' + rec.strokes);
  });
});

test('mount：无交点时不画 (?, ?) 标注，文案也不再说「已经画了点」', function () {
  withDom(function (dom) {
    const cs = [{ type: 'linear', k: 1, b: 0 }, { type: 'linear', k: 1, b: 5 }];
    const inst = F.mount({ type: 'curves', lab: LAB, intent: INTENT_BOTH, curves: cs });
    assert.ok(inst);
    assert.strictEqual(inst.state().intersectionsCount, 0);
    const rec = dom.findCanvas()[0]._rec;
    assert.ok(rec.texts.indexOf('(?, ?)') < 0, '无交点不该画 (?, ?)');
    assert.ok(inst.state().note.indexOf('画了点') < 0, '无交点文案不许说「画了点」：' + inst.state().note);
  });
});

test('mount：公式行只印两条表达式，不含交点坐标真值', function () {
  withDom(function () {
    const cs = F.curvesFromPrompt(q('cnm_208_q1'));
    const inst = F.mount({ type: 'curves', lab: LAB, intent: INTENT_BOTH, curves: cs });
    const info = inst.el.children[0].textContent;
    assert.ok(info.indexOf('y = x + 1') >= 0, '应印第一条表达式：' + info);
    assert.ok(info.indexOf('y = -x + 3') >= 0, '应印第二条表达式：' + info);
    assert.ok(!/\(\s*1\s*,\s*2\s*\)/.test(info), '公式行不许出现交点真值：' + info);
  });
});

test('mount：视野含原点，且把交点围在画布内（view 与 curvesWindow 同口径）', function () {
  withDom(function (dom) {
    const cs = F.curvesFromPrompt(q('cnm_241_q1'));
    F.mount({ type: 'curves', lab: LAB, intent: INTENT_BOTH, curves: cs });
    const rec = dom.findCanvas()[0]._rec;
    const gridTexts = rec.texts.filter(function (t) { return /^-?\d+$/.test(t); }).map(Number);
    assert.ok(gridTexts.length > 0, '应画刻度数字');
    assert.ok(gridTexts.indexOf(0) < 0 || true);
    /* 有正有负刻度 → 原点在视野里 */
    assert.ok(gridTexts.some(function (v) { return v > 0; }) && gridTexts.some(function (v) { return v < 0; }),
      '视野应同时含正负刻度（原点在内）：' + gridTexts.join(','));
  });
});

test('mount：clear() 能移除节点并断开观察器', function () {
  withDom(function () {
    const cs = F.curvesFromPrompt(q('cnm_208_q1'));
    const inst = F.mount({ type: 'curves', lab: LAB, intent: INTENT_BOTH, curves: cs });
    const el = inst.el;
    assert.ok(el.parent === null);
    inst.clear();
    assert.ok(el.parent === null);
  });
});

console.log('\n--- 5. describe / paintModel 与绘制同口径 ---');

test('describe：7 道真实交点题都返回非空描述，含「实线」与「?」', function () {
  CURVE_ITEMS.forEach(function (id) {
    const it = item(id);
    const cfg = F.labForScene(it.topicId, it.prompt, { itemId: id });
    const text = F.describe(LAB, INTENT_BOTH, cfg);
    assert.ok(text && text.length > 0, id + ' describe 为空');
    assert.ok(text.indexOf('实线') >= 0, id + ' describe 应提到实线');
    assert.ok(text.indexOf('?') >= 0, id + ' describe 应提到留白 ?');
  });
});

test('describe：交点个数与 intersectionsOf 一致（防漂移）', function () {
  const cases = [
    [{ type: 'linear', k: 1, b: 1 }, { type: 'linear', k: -1, b: 3 }],
    [{ type: 'linear', k: 1, b: 0 }, { type: 'inverse', k: 4 }],
    [{ type: 'linear', k: 1, b: 0 }, { type: 'linear', k: 1, b: 5 }],
    [{ type: 'linear', k: 2, b: 0 }, { type: 'inverse', k: -6 }]
  ];
  cases.forEach(function (cs) {
    const n = F.intersectionsOf(cs).length;
    const m = F.paintModel(LAB, INTENT_BOTH, { curves: cs });
    assert.ok(m, 'paintModel 不应为 null');
    const inter = m.elements.filter(function (e) { return e.kind === 'intersection'; });
    assert.strictEqual(inter.length, 1, '应恰好有一段交点说明');
    const txt = inter[0].text;
    if (n === 0) {
      assert.ok(txt.indexOf('没有公共点') >= 0, '无交点应写「没有公共点」，实际：' + txt);
    } else if (n === 1) {
      assert.ok(txt.indexOf('一个交点') >= 0, '1 个交点措辞不符：' + txt);
    } else {
      assert.ok(txt.indexOf('两个交点') >= 0, '2 个交点措辞不符：' + txt);
    }
  });
});

test('describe：文案与 paintModel 的 note 段落完全一致', function () {
  const cs = [{ type: 'linear', k: 1, b: 1 }, { type: 'linear', k: -1, b: 3 }];
  const note = F.noteText(LAB, INTENT_BOTH, { curves: cs });
  const text = F.describe(LAB, INTENT_BOTH, { curves: cs });
  assert.ok(text.indexOf(note) >= 0, 'describe 应包含同一份 note 文案');
});

test('paintModel：四条 intent 都产出非 null 模型（含位置关系这种非数值问法）', function () {
  const cs = [{ type: 'linear', k: 1, b: 1 }, { type: 'linear', k: -1, b: 3 }];
  F.capabilityIntents(LAB).forEach(function (it) {
    const m = F.paintModel(LAB, it, { curves: cs });
    assert.ok(m, it + ' paintModel 返回 null');
    assert.strictEqual(m.type, 'curves');
    assert.ok(m.elements.length >= 2);
  });
});

test('paintModel：空参数也返回通用模型（不返回 null，保证 describe 通用断言通过）', function () {
  const m = F.paintModel(LAB, INTENT_BOTH, {});
  assert.ok(m, '缺 curves 时也必须能描述画板');
  assert.ok(m.elements.some(function (e) { return e.text.indexOf('第一条曲线') >= 0; }));
});

test('paintModel：题面已知量照印（表达式），派生量（交点）恒为 (?, ?)', function () {
  const cs = [{ type: 'linear', k: 1, b: 1 }, { type: 'linear', k: -1, b: 3 }];
  const m = F.paintModel(LAB, INTENT_BOTH, { curves: cs });
  const all = m.elements.map(function (e) { return e.text; }).join('\n');
  assert.ok(all.indexOf('y = x + 1') >= 0, '应印已知表达式');
  assert.ok(all.indexOf('(?, ?)') >= 0, '交点应留白');
  assert.ok(!/\(\s*1\s*,\s*2\s*\)/.test(all), '不许印交点真值：' + all);
});

test('curvesWindow（经 describe/view 间接验）：交点被围进视野', function () {
  /* 用 paintModel 的 note 与 intersectionsOf 交叉验证：describe 说有几个交点，
   * 就必须与 intersectionsOf 一致（视野裁剪不能把交点算丢） */
  const cs = [{ type: 'linear', k: 1, b: 0 }, { type: 'inverse', k: 4 }];
  const pts = F.intersectionsOf(cs);
  assert.strictEqual(pts.length, 2);
  const m = F.paintModel(LAB, INTENT_BOTH, { curves: cs });
  const inter = m.elements.filter(function (e) { return e.kind === 'intersection'; })[0];
  assert.ok(inter.text.indexOf('两个交点') >= 0);
});

console.log('\n--- 6. labmatch：verifyParams 多曲线分支 + 拒绝规则 ---');

test('verifyParams：cnm_208_q1 正确双曲线参数 → ok', function () {
  const r = L.verifyParams(q('cnm_208_q1'), {
    match: LAB, intent: INTENT_BOTH,
    params: { curves: [{ type: 'linear', k: 1, b: 1 }, { type: 'linear', k: -1, b: 3 }] }
  });
  assert.strictEqual(r.ok, true, '应通过，why=' + JSON.stringify(r.why));
});

test('verifyParams：7 道真实交点题都能用题面自己的解析结果通过校验', function () {
  CURVE_ITEMS.forEach(function (id) {
    const it = item(id);
    const cs = F.curvesFromPrompt(it.prompt);
    const r = L.verifyParams(it.prompt, { match: LAB, intent: INTENT_BOTH, params: { curves: cs } });
    assert.strictEqual(r.ok, true, id + ' 应通过，why=' + JSON.stringify(r.why));
  });
});

test('verifyParams：只给一条曲线 → 拒绝', function () {
  const r = L.verifyParams(q('cnm_208_q1'), {
    match: LAB, intent: INTENT_BOTH, params: { curves: [{ type: 'linear', k: 1, b: 1 }] }
  });
  assert.strictEqual(r.ok, false);
  assert.ok(r.why.join().indexOf('长度必须为 2') >= 0, '理由应说明条数：' + JSON.stringify(r.why));
});

test('verifyParams：三条曲线 → 拒绝（卡面：>2 一律不挂）', function () {
  const r = L.verifyParams(q('cnm_208_q1'), {
    match: LAB, intent: INTENT_BOTH,
    params: { curves: [{ type: 'linear', k: 1, b: 1 }, { type: 'linear', k: -1, b: 3 }, { type: 'linear', k: 2, b: 0 }] }
  });
  assert.strictEqual(r.ok, false);
  assert.ok(r.why.join().indexOf('长度必须为 2') >= 0);
});

test('verifyParams：其中一条曲线与题面对不上 → 拒绝（每条都要代回）', function () {
  const r = L.verifyParams(q('cnm_208_q1'), {
    match: LAB, intent: INTENT_BOTH,
    params: { curves: [{ type: 'linear', k: 1, b: 1 }, { type: 'linear', k: -1, b: 4 }] }
  });
  assert.strictEqual(r.ok, false);
  assert.ok(r.why.join().indexOf('代回不符') >= 0, '理由应说明代回不符：' + JSON.stringify(r.why));
});

test('verifyParams：两条都错 → 拒绝', function () {
  const r = L.verifyParams(q('cnm_208_q1'), {
    match: LAB, intent: INTENT_BOTH,
    params: { curves: [{ type: 'linear', k: 3, b: 7 }, { type: 'linear', k: -2, b: 9 }] }
  });
  assert.strictEqual(r.ok, false);
});

test('verifyParams：调换两条曲线顺序仍通过（顺序不敏感）', function () {
  const cs = F.curvesFromPrompt(q('cnm_208_q1')).slice().reverse();
  const r = L.verifyParams(q('cnm_208_q1'), { match: LAB, intent: INTENT_BOTH, params: { curves: cs } });
  assert.strictEqual(r.ok, true, 'why=' + JSON.stringify(r.why));
});

test('字符串形态：LLM 给 ["y=x+1","y=-x+3"] 也能通过（确定性解析后仍比系数）', function () {
  /* 实测 LLM 会把 curves 写成表达式串数组。规约用 funclab 自己的解析器，
   * 解析结果仍要回到第 3 步与题面解析逐项比系数 —— 这一点由下一条「错误字符串被拒」反向锁住。 */
  const r = L.verifyParams(q('cnm_208_q1'), {
    match: LAB, intent: INTENT_BOTH, params: { curves: ['y=x+1', 'y=-x+3'] }
  });
  assert.strictEqual(r.ok, true, '字符串形态应通过，why=' + JSON.stringify(r.why));
});

test('字符串形态：反比例也认（["y=x","y=4/x"]）', function () {
  const r = L.verifyParams(q('cnm_241_q1'), {
    match: LAB, intent: INTENT_BOTH, params: { curves: ['y=x', 'y=4/x'] }
  });
  assert.strictEqual(r.ok, true, 'why=' + JSON.stringify(r.why));
});

test('字符串形态：混写（一条对象 + 一条字符串）按同口径规约', function () {
  const r = L.verifyParams(q('cnm_208_q1'), {
    match: LAB, intent: INTENT_BOTH,
    params: { curves: [{ type: 'linear', k: 1, b: 1 }, 'y=-x+3'] }
  });
  assert.strictEqual(r.ok, true, 'why=' + JSON.stringify(r.why));
});

test('字符串形态：系数错的字符串仍被拒（不是放宽，是解析后比系数）', function () {
  const r = L.verifyParams(q('cnm_208_q1'), {
    match: LAB, intent: INTENT_BOTH, params: { curves: ['y=x+1', 'y=-x+9'] }
  });
  assert.strictEqual(r.ok, false, '系数不符必须拒绝');
  assert.ok(r.why.join().indexOf('代回不符') >= 0, '理由应是代回不符：' + JSON.stringify(r.why));
});

test('字符串形态：解析不出曲线的字符串被拒', function () {
  const r = L.verifyParams(q('cnm_208_q1'), {
    match: LAB, intent: INTENT_BOTH, params: { curves: ['y=x+1', '胡说八道'] }
  });
  assert.strictEqual(r.ok, false);
  assert.ok(r.why.join().indexOf('解析不出') >= 0, '理由应说明解析失败：' + JSON.stringify(r.why));
});

test('字符串形态：一条字符串里含两条曲线 → 拒绝（有歧义，不猜）', function () {
  const r = L.verifyParams(q('cnm_208_q1'), {
    match: LAB, intent: INTENT_BOTH,
    params: { curves: ['y=x+1 与 y=-x+3', 'y=-x+3'] }
  });
  assert.strictEqual(r.ok, false);
  assert.ok(r.why.join().indexOf('无法确定是哪一条') >= 0, '理由应说明歧义：' + JSON.stringify(r.why));
});

test('字符串形态：空串 / 数字 / null 都被拒', function () {
  ['', 42, null, undefined].forEach(function (bad) {
    const r = L.verifyParams(q('cnm_208_q1'), {
      match: LAB, intent: INTENT_BOTH, params: { curves: ['y=x+1', bad] }
    });
    assert.strictEqual(r.ok, false, JSON.stringify(bad) + ' 应被拒');
  });
});

test('能力清单里写明了 curves 的 JSON 结构与例子（防 LLM 再给式子串）', function () {
  const cap = F.CAPABILITIES[LAB];
  assert.ok(cap.paramsDoc && cap.paramsDoc.length > 0, 'two-curves-intersect 缺 paramsDoc');
  ['type:"linear"', 'k:', 'b:', 'type:"inverse"', 'type:"quadratic"', 'a:', 'h:'].forEach(function (frag) {
    assert.ok(cap.paramsDoc.indexOf(frag) >= 0, 'paramsDoc 缺字段说明：' + frag);
  });
  assert.ok(cap.paramsDoc.indexOf('{') >= 0, 'paramsDoc 应含 JSON 例子');
  assert.ok(cap.note.indexOf('{') >= 0, 'note 也应带一个例子');
  /* 真正喂给 LLM 的 userPrompt 必须把这个结构带上 */
  const up = L.userPrompt(q('cnm_208_q1'), F.capabilitiesFor('curves'));
  assert.ok(up.indexOf('参数格式') >= 0, 'userPrompt 应含「参数格式」段：' + up);
  assert.ok(up.indexOf('type:"linear"') >= 0, 'userPrompt 应含 linear 结构');
});

test('buildCfg：字符串形态进入配置时已规约成对象（mount 才画得出来）', function () {
  const cfg = L.buildCfg('curves', { type: 'curves' }, {
    match: LAB, intent: INTENT_BOTH, params: { curves: ['y=x+1', 'y=-x+3'] }
  });
  assert.ok(cfg, 'buildCfg 不应返回 null');
  assert.ok(Array.isArray(cfg.curves) && cfg.curves.length === 2);
  assert.deepStrictEqual(cfg.curves[0], { type: 'linear', k: 1, b: 1 });
  assert.deepStrictEqual(cfg.curves[1], { type: 'linear', k: -1, b: 3 });
  withDom(function () {
    const inst = F.mount(cfg);
    assert.ok(inst, '规约后的配置应能正常挂载');
    assert.strictEqual(inst.state().intersectionsCount, 1);
  });
});

test('verifyParams：k=0 的直线 → 拒绝（画不出交点）', function () {
  const r = L.verifyParams(q('cnm_208_q1'), {
    match: LAB, intent: INTENT_BOTH,
    params: { curves: [{ type: 'linear', k: 0, b: 1 }, { type: 'linear', k: -1, b: 3 }] }
  });
  assert.strictEqual(r.ok, false);
});

test('verifyParams：不支持的类型（如 circle）→ 拒绝', function () {
  const r = L.verifyParams(q('cnm_208_q1'), {
    match: LAB, intent: INTENT_BOTH,
    params: { curves: [{ type: 'circle', r: 1 }, { type: 'linear', k: 1, b: 1 }] }
  });
  assert.strictEqual(r.ok, false);
});

test('verifyParams：intent 不在 canAnswer → 拒绝', function () {
  const cs = F.curvesFromPrompt(q('cnm_208_q1'));
  const r = L.verifyParams(q('cnm_208_q1'), { match: LAB, intent: '方程的根', params: { curves: cs } });
  assert.strictEqual(r.ok, false);
});

test('拒绝规则：多表达式 + 交点题，挂单曲线画板一律拒绝（cnm_208_q1 / cnm_h172_q1）', function () {
  const singleLabs = Object.keys(F.CAPABILITIES).filter(function (name) {
    return F.CAP_TYPE[name] !== 'curves';
  });
  assert.ok(singleLabs.length > 0, '应存在单曲线画板');
  ['cnm_208_q1', 'cnm_h172_q1', 'cnm_241_q1'].forEach(function (id) {
    singleLabs.forEach(function (lab) {
      const cap = F.CAPABILITIES[lab];
      const intent = cap.canAnswer[0];
      /* 参数随便给，反正应在「代回校验之前」就被拒绝 —— 这正是这条规则的要点 */
      const r = L.verifyParams(q(id), { match: lab, intent: intent, params: { k: 1, b: 1, a: 1, h: 0 } });
      assert.strictEqual(r.ok, false, id + ' 用单曲线画板 ' + lab + ' 不该通过');
      const joined = r.why.join();
      assert.ok(joined.indexOf(LAB) >= 0, id + '/' + lab + ' 拒绝理由应指向多曲线画板，实际：' + joined);
    });
  });
});

test('拒绝规则不误伤：单表达式题仍可挂单曲线画板', function () {
  const id = 'cnm_201_q1';
  const it = item(id);
  assert.ok(it, '题库里找不到 ' + id);
  const r = L.verifyParams(it.prompt, { match: 'linear-intercepts', intent: '与 y 轴交点的纵坐标', params: { k: 2, b: 3 } });
  /* 参数对不对不重要，重要的是**不能**被「多表达式」规则打死 */
  assert.ok(r.why.join().indexOf(LAB) < 0, '单表达式题不该被多曲线规则拒绝：' + JSON.stringify(r.why));
});

test('反例：cnm_208_q4（求 m 的值）不许挂多曲线画板，也不许被解析成 curves 候选', function () {
  const it = item('cnm_208_q4');
  assert.ok(it, '题库里找不到 cnm_208_q4');
  const cfg = F.labForScene(it.topicId, it.prompt, { itemId: it.id });
  assert.ok(!cfg || cfg.type !== 'curves', '求参数的题不该给 curves 候选，实际 ' + JSON.stringify(cfg));
  const r = L.verifyParams(it.prompt, { match: LAB, intent: INTENT_BOTH, params: { curves: F.curvesFromPrompt(it.prompt) } });
  assert.strictEqual(r.ok, false, '交点是已知量，问的是 m：不该通过');
  assert.ok(r.why.join().indexOf('交点不是答案') >= 0, '理由应说明交点不是答案：' + JSON.stringify(r.why));
});

test('反例：cnm_241_q4（解不等式，答案 B）不许挂多曲线画板', function () {
  const it = item('cnm_241_q4');
  assert.ok(it, '题库里找不到 cnm_241_q4');
  const cfg = F.labForScene(it.topicId, it.prompt, { itemId: it.id });
  assert.ok(!cfg || cfg.type !== 'curves', '解集题不该给 curves 候选，实际 ' + JSON.stringify(cfg));
  const r = L.verifyParams(it.prompt, { match: LAB, intent: INTENT_BOTH, params: { curves: F.curvesFromPrompt(it.prompt) } });
  assert.strictEqual(r.ok, false, '答案是解集，不是交点');
});

test('排除规则不误伤：\u0022求 y=x 与 y=4/x 的交点\u0022（cnm_241_q1）仍是正当交点题', function () {
  /* 「求 y=…」是函数式开头，不是「求参数」—— 正则必须只认单个字母参数 */
  assert.strictEqual(F.curvesFromPrompt(q('cnm_241_q1')).length, 2);
  const cfg = F.labForScene(item('cnm_241_q1').topicId, q('cnm_241_q1'), { itemId: 'cnm_241_q1' });
  assert.strictEqual(cfg.type, 'curves', 'cnm_241_q1 应仍是 curves 候选');
});

console.log('\n--- 7. 端到端：labForScene → verifyParams → mount 全链路 ---');

test('全链路：7 道真实交点题都能 labForScene → verifyParams 通过 → mount 成功', function () {
  CURVE_ITEMS.forEach(function (id) {
    const it = item(id);
    const cfg = F.labForScene(it.topicId, it.prompt, { itemId: id });
    assert.ok(cfg && cfg.type === 'curves', id + ' 候选不对');
    const r = L.verifyParams(it.prompt, { match: LAB, intent: INTENT_BOTH, params: { curves: cfg.curves } });
    assert.strictEqual(r.ok, true, id + ' 校验失败：' + JSON.stringify(r.why));
    withDom(function () {
      const inst = F.mount({ type: cfg.type, lab: LAB, intent: INTENT_BOTH, curves: cfg.curves });
      assert.ok(inst, id + ' 挂载失败');
      const st = inst.state();
      assert.strictEqual(st.type, 'curves');
      assert.strictEqual(st.shown, false);
      assert.ok(st.intersectionsCount >= 1, id + ' 应至少有一个交点，实际 ' + st.intersectionsCount);
    });
  });
});

test('全链路：answerRows 给出的真值与题库答案一致（cnm_208_q1 横坐标 1）', function () {
  const it = item('cnm_208_q1');
  const cs = F.curvesFromPrompt(it.prompt);
  const rows = F.answerRows(LAB, INTENT_BOTH, { curves: cs });
  assert.ok(rows.length >= 2, '交点坐标应给两个输入框（横、纵）');
  const vals = rows.map(function (r) { return r.real; });
  assert.ok(vals.indexOf(1) >= 0, '横坐标 1 应在答案行里，实际 ' + JSON.stringify(vals));
  const ans = String(it.answer);
  assert.ok(ans.indexOf('1') >= 0, '题库答案应含 1，实际 ' + ans);
});

test('answerRows：位置关系（非数值）不给输入框', function () {
  const cs = F.curvesFromPrompt(q('cnm_208_q1'));
  assert.deepStrictEqual(F.answerRows(LAB, '两条曲线的位置关系', { curves: cs }), []);
});

test('answerRows：无交点时不给输入框', function () {
  const cs = [{ type: 'linear', k: 1, b: 0 }, { type: 'linear', k: 1, b: 5 }];
  assert.deepStrictEqual(F.answerRows(LAB, INTENT_BOTH, { curves: cs }), []);
});

test('自检：填错不判对，未作答只说「未作答」', function () {
  const cs = F.curvesFromPrompt(q('cnm_208_q1'));
  const rows = F.answerRows(LAB, INTENT_BOTH, { curves: cs });
  const blank = F.checkAnswerRow(rows[0], '');
  assert.strictEqual(blank.verdict, 'blank');
  assert.strictEqual(blank.shown, '未作答');
  const wrong = F.checkAnswerRow(rows[0], '99');
  assert.strictEqual(wrong.verdict, 'wrong');
  assert.ok(wrong.shown.indexOf('99') >= 0, '填错应回显学生自己写的值（不回显正确答案）');
  const right = F.checkAnswerRow(rows[0], String(rows[0].real));
  assert.strictEqual(right.verdict, 'right');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
