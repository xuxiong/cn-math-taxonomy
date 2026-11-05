#!/usr/bin/env node
/* 高中函数画板 批4：三次多项式族 + S= 窄门 —— 第 1 段（解析 + 答案门禁）
 *   node tests/test_funclab_hs_batch4.js
 *
 * 本文件当前只锁「解析层 + answer-gate 的 cubic 分支」：
 *   · 4 道实面题（h225_q1 / h228_q2 / h035_q2 / h229_q2）的 fromPrompt 结果，题面从
 *     data/questions.json 实取，不臆造；
 *   · 三次正例全表（含参数逐项 deepStrictEqual）；
 *   · 三次反例：x^4 仍归 power、/x 与字母系数一律 null；两道导数题面保持原 quadratic 解析；
 *   · S= 窄门：面积式展开 / 视同 y= 的别名 / 反例；无 S= 的同类式行为不变；
 *   · answer-gate cubic：y=x³−3x 的驻点 ±1 进入标注集合。
 *
 * ======================= TODO（第 2 段补的测试组） =======================
 *   5. 白名单组：HS_ITEMS 恰好 34 条，旧 30 条逐字不动（OLD30 表复用），4 条新增类型正确；
 *      族计数：二次 12 / 一次 3 / 反比例 1 / 三角 9 / 指数 3 / 对数 4 / 三次 2 = 34。
 *   6. 画板组：CAP_TYPE 两块都是 cubic；TYPE_DEF.cubic 的 params/sliders/defaults 逐字；
 *      cubic-parity / cubic-extremum 的 intentSupported；paintModel 双 intent 的元素用词；
 *      真 mount（batch3 的 fake DOM）两块非 null、canvas 正尺寸、note 文案在、
 *      state().focus.cubicParity / cubicExtremum 为 true。
 *   7. 文案审计：两块 note 与两条 NOTE_INTENT 零 `**`；`奇函数/偶函数/原点对称` 零出现；
 *      cubic-parity 的 note / NOTE_INTENT 零 `/奇|偶/`；h225_q1 / h228_q2 的
 *      quadratic-vertex noteText 不出独立数字 2 / 5；h229_q2 不出独立 1 / -1 / −1。
 *   8. 门禁组（补全）：31 条 misleading 仍全挡、h221_q2 仍挡（cubic 的 annotationValues
 *      断言已在本段写好）。
 *   9. 197 题零改动：git show d155a60:diagnose/funclab.js 取旧版，遍历全库比对
 *      「旧版非 null 的题，新版 JSON 逐字相同」，并打印 null→非 null 的新增清单。
 *   另：labmatch.verifyParams 的 cubic 分支（2.6）在本段之后单独补测。
 * ======================================================================
 */
'use strict';
const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e).split('\n').slice(0, 8).join('\n       ')); }
}

const F = require('../diagnose/funclab.js');
const GATE = require('./lib/answer-gate.js');
const L = require('../diagnose/labmatch.js');
const QUESTIONS = require('../data/questions.json');
const QMAP = new Map(QUESTIONS.map(function (x) { return [x.id, x]; }));
function q(id) {
  const item = QMAP.get(id);
  assert.ok(item, '题库里找不到题目 ' + id);
  return item;
}

/* ================================================================
 * 1. 4 题实面：fromPrompt 认得出、类型与参数对得上（题面运行时读，不复制）
 * ================================================================ */

console.log('\n--- 1. 4 题实面 fromPrompt ---');

test('4 题实面逐题解析，参数逐项对上', function () {
  assert.deepStrictEqual(F.fromPrompt(q('cnm_h225_q1').prompt),
    { type: 'quadratic', a: 1, h: 2, k: -4 });
  assert.deepStrictEqual(F.fromPrompt(q('cnm_h228_q2').prompt),
    { type: 'quadratic', a: -1, h: 5, k: 25 });
  assert.deepStrictEqual(F.fromPrompt(q('cnm_h035_q2').prompt),
    { type: 'cubic', a: 1, b: 0, c: 0, d: 0 });
  assert.deepStrictEqual(F.fromPrompt(q('cnm_h229_q2').prompt),
    { type: 'cubic', a: 1, b: 0, c: -3, d: 0 });
});

/* ================================================================
 * 2. 三次正例全表
 * ================================================================ */

console.log('\n--- 2. 三次正例 ---');

test('y=x³ / y=x^3：a=1，其余项补 0', function () {
  const want = { type: 'cubic', a: 1, b: 0, c: 0, d: 0 };
  assert.deepStrictEqual(F.fromPrompt('y=x³'), want);
  assert.deepStrictEqual(F.fromPrompt('y=x^3'), want);
});

test('缺项补 0 / 负号 / 单项：y=x³−3x / y=x³+1 / y=-x³+x / y=2x³', function () {
  assert.deepStrictEqual(F.fromPrompt('y=x³−3x'),
    { type: 'cubic', a: 1, b: 0, c: -3, d: 0 });
  assert.deepStrictEqual(F.fromPrompt('y=x³+1'),
    { type: 'cubic', a: 1, b: 0, c: 0, d: 1 });
  assert.deepStrictEqual(F.fromPrompt('y=-x³+x'),
    { type: 'cubic', a: -1, b: 0, c: 1, d: 0 });
  assert.deepStrictEqual(F.fromPrompt('y=2x³'),
    { type: 'cubic', a: 2, b: 0, c: 0, d: 0 });
});

test('四项齐全：y=2x^3-3x^2+1（不再被既有二次通道截走）', function () {
  assert.deepStrictEqual(F.fromPrompt('y=2x^3-3x^2+1'),
    { type: 'cubic', a: 2, b: -3, c: 0, d: 1 });
});

test('f(x)= 前缀：f(x)=x³−3x', function () {
  assert.deepStrictEqual(F.fromPrompt('f(x)=x³−3x'),
    { type: 'cubic', a: 1, b: 0, c: -3, d: 0 });
});

/* ================================================================
 * 3. 三次反例 + 既有行为兼容锁
 * ================================================================ */

console.log('\n--- 3. 三次反例 / 兼容锁 ---');

test('y=x^4 仍归 power（三次头只认 ^3）', function () {
  assert.deepStrictEqual(F.fromPrompt('y=x^4'), { type: 'power', a: 1, p: 4 });
});

test('/x 与字母系数：y=x³+1/x / y=ax³ 一律 null', function () {
  assert.strictEqual(F.fromPrompt('y=x³+1/x'), null);
  assert.strictEqual(F.fromPrompt('y=ax³'), null);
});

test('尾部中文说明不参与判型：y=x³−3x，x>0 时… 仍解析为 cubic', function () {
  /* 实际结果：仍为 cubic（是否挂载由 labmatch 的 intent/参数闸挡，不在解析层判）。 */
  assert.deepStrictEqual(F.fromPrompt('y=x³−3x，x>0 时 f(x) 的最小值是多少？'),
    { type: 'cubic', a: 1, b: 0, c: -3, d: 0 });
});

test('兼容锁：导数题面 cnm_h217_q2 仍必须解析成 quadratic', function () {
  assert.deepStrictEqual(F.fromPrompt(q('cnm_h217_q2').prompt),
    { type: 'quadratic', a: 3, h: 0, k: 0 });
});

test('兼容锁：导数题面 cnm_h220_q3 仍必须解析成 quadratic', function () {
  assert.deepStrictEqual(F.fromPrompt(q('cnm_h220_q3').prompt),
    { type: 'quadratic', a: 3, h: 0, k: 0 });
});

/* ================================================================
 * 4. S= 窄门
 * ================================================================ */

console.log('\n--- 4. S= 窄门 ---');

test('面积式展开：S=x(10-x) / S=x(10−x) → 顶点式 a=-1,h=5,k=25', function () {
  const want = { type: 'quadratic', a: -1, h: 5, k: 25 };
  assert.deepStrictEqual(F.fromPrompt('S=x(10-x)'), want);
  assert.deepStrictEqual(F.fromPrompt('S=x(10−x)'), want);
});

test('乘号与因子在后的写法：S=x*(10−x) / S=(10-x)x', function () {
  const want = { type: 'quadratic', a: -1, h: 5, k: 25 };
  assert.deepStrictEqual(F.fromPrompt('S=x*(10−x)'), want);
  assert.deepStrictEqual(F.fromPrompt('S=(10-x)x'), want);
});

test('视同 y= 的窄别名：S=2x+1 → linear；S=1/x → inverse', function () {
  assert.deepStrictEqual(F.fromPrompt('S=2x+1'), { type: 'linear', k: 2, b: 1 });
  assert.deepStrictEqual(F.fromPrompt('S=1/x'), { type: 'inverse', k: 1 });
});

test('反例：S=kx → null；S=x(10-x)/2 → null（不是面积式，别读成 y=x）', function () {
  assert.strictEqual(F.fromPrompt('S=kx'), null);
  assert.strictEqual(F.fromPrompt('S=x(10-x)/2'), null);
});

test('无 S= 的同类式不受影响：y=x(10-x) 仍是既有 linear 行为', function () {
  assert.deepStrictEqual(F.fromPrompt('y=x(10-x)'), { type: 'linear', k: 1, b: 0 });
});

/* ================================================================
 * 8（门禁部分）. answer-gate 的 cubic 分支
 * ================================================================ */

console.log('\n--- 8. 答案语义门禁（cubic 分支） ---');

test('annotationValues(cubic)：y=x³−3x 的驻点 1 与 -1 都在集合里', function () {
  const vals = GATE.annotationValues(F.fromPrompt('y=x³−3x'));
  assert.ok(vals.has('1'), '驻点 1 应在标注集合，实际 {' + Array.from(vals).join(',') + '}');
  assert.ok(vals.has('-1'), '驻点 -1 应在标注集合，实际 {' + Array.from(vals).join(',') + '}');
  assert.deepStrictEqual(Array.from(vals).sort(), ['-1', '1']);
});

test('annotationValues(cubic)：判别式 =0 的退化驻点不算极值（y=x³ → 空集）', function () {
  /* y=x³ 的 f'(x)=3x²=0 只有 x=0，且两侧不变号 —— 不是「转折点」，画板不标；
     这条同时保证 cnm_h035_q4（答案 0）不会被数值巧合放行。 */
  assert.deepStrictEqual(Array.from(GATE.annotationValues(F.fromPrompt('y=x³'))), []);
});

/* ================================================================
 * 5. 白名单：34 条；旧 30 条逐字不动（基线取 f535c15，本批之前）
 * ================================================================ */

console.log('\n--- 5. 白名单 34 条 ---');

const BATCH4 = {
  'cnm_h225_q1': 'quadratic',
  'cnm_h228_q2': 'quadratic',
  'cnm_h035_q2': 'cubic',
  'cnm_h229_q2': 'cubic'
};

/* 旧 30 条从本批开工前的提交实取（不是手抄），new 版逐条键值必须与基线相同。 */
function loadBaselineHs(rev) {
  const src = cp.execFileSync('git', ['show', rev + ':diagnose/funclab.js'], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024
  });
  const tmp = path.join(os.tmpdir(), 'funclab.' + rev + '.' + process.pid + '.js');
  fs.writeFileSync(tmp, src);
  delete require.cache[require.resolve(tmp)];
  const mod = require(tmp);
  fs.unlinkSync(tmp);
  return mod;
}

test('HS_ITEMS 恰好 34 条：旧 30 条逐条键值不动 + 4 条新增类型正确', function () {
  const base = loadBaselineHs('f535c15');
  const old = base.HS_ITEMS;
  assert.strictEqual(Object.keys(old).length, 30, '基线应恰好 30 条');
  Object.keys(old).forEach(function (id) {
    assert.strictEqual(F.HS_ITEMS[id], old[id], id + ' 的类型被改动（旧 30 条必须逐字不动）');
  });
  Object.keys(BATCH4).forEach(function (id) {
    assert.strictEqual(F.HS_ITEMS[id], BATCH4[id], id + ' 应以 ' + BATCH4[id] + ' 进白名单');
  });
  assert.strictEqual(Object.keys(F.HS_ITEMS).length, 34);
});

test('族配比 = 二次 12 / 一次 3 / 反比例 1 / 三角 9 / 指数 3 / 对数 4 / 三次 2', function () {
  const cnt = {};
  Object.keys(F.HS_ITEMS).forEach(function (id) { cnt[F.HS_ITEMS[id]] = (cnt[F.HS_ITEMS[id]] || 0) + 1; });
  assert.deepStrictEqual(cnt, { quadratic: 12, linear: 3, inverse: 1, trig: 9, exp: 3, log: 4, cubic: 2 });
});

test('4 条新增题都挂得上，且 labForScene 的 type 与白名单一致', function () {
  Object.keys(BATCH4).forEach(function (id) {
    const item = q(id);
    const scene = F.labForScene(item.topicId, item.prompt, { itemId: id });
    assert.ok(scene, id + ' labForScene 应挂上');
    assert.strictEqual(scene.type, BATCH4[id], id + ' 画板类型不对');
  });
});

/* ================================================================
 * 6. 两块三次画板：CAP_TYPE / TYPE_DEF / paintModel / 真 mount
 * ================================================================ */

console.log('\n--- 6. 三次画板 ---');

test('CAP_TYPE 两块都是 cubic；TYPE_DEF.cubic 的 params/sliders/defaults 逐字', function () {
  assert.strictEqual(F.CAP_TYPE['cubic-parity'], 'cubic');
  assert.strictEqual(F.CAP_TYPE['cubic-extremum'], 'cubic');
  const def = F.TYPE_DEF.cubic;
  assert.deepStrictEqual(def.params, ['a', 'b', 'c', 'd']);
  assert.deepStrictEqual(def.sliders.map(function (s) { return s.key; }), ['a', 'b', 'c']);
  assert.deepStrictEqual(def.defaults, { a: 1, b: 0, c: 0, d: 0 });
});

test('intentSupported：两块各认自己的 intent，互不串台', function () {
  assert.strictEqual(F.intentSupported('cubic-parity', '奇偶性'), true);
  assert.strictEqual(F.intentSupported('cubic-extremum', '极值点的横坐标'), true);
  assert.strictEqual(F.intentSupported('cubic-parity', '极值点的横坐标'), false);
  assert.strictEqual(F.intentSupported('cubic-extremum', '奇偶性'), false);
});

test('paintModel 两块：元素用词只有蓝线 / 黑粗 y 轴 / 红点，红点文字不印数值', function () {
  const cases = [
    ['cubic-parity', '奇偶性', { a: 1, b: 0, c: 0, d: 0 }],
    ['cubic-extremum', '极值点的横坐标', { a: 1, b: 0, c: -3, d: 0 }]
  ];
  cases.forEach(function (row) {
    const m = F.paintModel(row[0], row[1], row[2]);
    assert.ok(m, row[0] + ' paintModel 不应为 null');
    const styles = m.elements.map(function (e) { return e.style; });
    assert.ok(styles.indexOf('蓝色实线') >= 0, row[0] + ' 缺蓝色实线');
    assert.ok(styles.indexOf('黑色粗实线') >= 0, row[0] + ' 缺黑色粗实线 y 轴');
    assert.ok(styles.indexOf('红色圆点') >= 0, row[0] + ' 缺红色圆点');
    m.elements.forEach(function (e) {
      assert.ok(['坐标轴与网格', '蓝色实线', '黑色粗实线', '红色圆点', '说明文字'].indexOf(e.style) >= 0,
        row[0] + ' 出现契约外元素样式：' + e.style);
    });
    const dot = m.elements.filter(function (e) { return e.kind === 'fixed-point' || e.kind === 'extremum-point'; })[0];
    assert.ok(dot, row[0] + ' 缺红点元素');
    assert.ok(!/-?\d/.test(dot.text.replace(/x = 0/, '')), row[0] + ' 红点文字印了数值：' + dot.text);
  });
});

function makeCtx(rec) {
  const noop = function () {};
  const ctx = {
    save: noop, restore: noop, beginPath: noop, moveTo: noop, lineTo: noop,
    arc: noop, closePath: noop, fill: noop, fillRect: noop, clearRect: noop, setTransform: noop,
    set strokeStyle(v) { rec.strokeStyle = v; }, get strokeStyle() { return rec.strokeStyle; },
    set fillStyle(v) { rec.fillStyle = v; }, get fillStyle() { return rec.fillStyle; },
    set lineWidth(v) { rec.lineWidth = v; }, get lineWidth() { return rec.lineWidth; },
    set font(v) { rec.font = v; }, get font() { return rec.font; },
    set textAlign(v) { rec.textAlign = v || 'left'; }, get textAlign() { return rec.textAlign; },
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
      node._rec = { strokes: 0, texts: [], dash: [], strokeStyle: '', fillStyle: '',
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

test('两块三次画板真 mount：非 null、canvas 正尺寸、note 在、focus 标志对', function () {
  const bad = [];
  [['cnm_h035_q2', 'cubic-parity', '奇偶性', 'cubicParity'],
    ['cnm_h229_q2', 'cubic-extremum', '极值点的横坐标', 'cubicExtremum']].forEach(function (row) {
    const item = q(row[0]);
    const scene = F.labForScene(item.topicId, item.prompt, { itemId: row[0] });
    if (!scene) { bad.push(row[0] + ' labForScene=null'); return; }
    withDom(function (dom) {
      const inst = F.mount(Object.assign({}, scene, { lab: row[1], intent: row[2] }));
      if (!inst) { bad.push(row[0] + ' mount=null'); return; }
      const canvas = dom.findCanvas()[0];
      if (!canvas || inst.el.children.indexOf(canvas) < 0) { bad.push(row[0] + ' el 内没有 canvas'); return; }
      if (!(canvas.width > 0) || !(canvas.height > 0)) {
        bad.push(row[0] + ' canvas 尺寸非正：' + canvas.width + '×' + canvas.height);
      }
      const st = inst.state();
      if (!st.note || !String(st.note).trim()) bad.push(row[0] + ' note 文案为空');
      if (st.focus[row[3]] !== true) bad.push(row[0] + ' focus.' + row[3] + ' 应为 true');
    });
  });
  assert.deepStrictEqual(bad, [], bad.join(' / '));
});

test('mount 拒绝退化解：cubic a=0 / d 非有限', function () {
  withDom(function () {
    const bad = [];
    function mustNull(cfg, label) {
      const inst = F.mount(cfg);
      if (inst !== null) bad.push(label + ' 应返回 null');
    }
    mustNull({ type: 'cubic', a: 0, b: 0, c: 0, d: 0, lab: 'cubic-parity', intent: '奇偶性' }, 'a=0');
    mustNull({ type: 'cubic', a: 1, b: 0, c: 0, d: NaN, lab: 'cubic-parity', intent: '奇偶性' }, 'd=NaN');
    assert.deepStrictEqual(bad, [], bad.join(' / '));
  });
});

test('labmatch.verifyParams cubic：系数代回逐项 close、a=0 拒绝', function () {
  const item = q('cnm_h229_q2');
  const ok = L.verifyParams(item.prompt,
    { match: 'cubic-extremum', intent: '极值点的横坐标', params: { a: 1, b: 0, c: -3, d: 0 } },
    { itemId: item.id });
  assert.deepStrictEqual(ok, { ok: true, why: [] });

  const badB = L.verifyParams(item.prompt,
    { match: 'cubic-extremum', intent: '极值点的横坐标', params: { a: 1, b: 1, c: -3, d: 0 } },
    { itemId: item.id });
  assert.strictEqual(badB.ok, false);
  assert.ok(/参数代回不符/.test(badB.why.join(';')), 'b 不符应报参数代回：' + badB.why.join(';'));

  const badA = L.verifyParams(item.prompt,
    { match: 'cubic-extremum', intent: '极值点的横坐标', params: { a: 0, b: 0, c: -3, d: 0 } },
    { itemId: item.id });
  assert.strictEqual(badA.ok, false);
  assert.ok(/a=0 不是三次函数/.test(badA.why.join(';')), 'a=0 应拒绝：' + badA.why.join(';'));
});

/* ================================================================
 * 7. 文案审计：零 **、零答案词、noteText 不印答案数字
 * ================================================================ */

console.log('\n--- 7. 文案审计 ---');

function tokensOf(text) {
  return (String(text).match(/-?\d+(?:\.\d+)?/g) || []);
}

test('两块 note 与两条 NOTE_INTENT：零 **，零「奇函数/偶函数/原点对称」', function () {
  const notes = [
    F.CAPABILITIES['cubic-parity'].note,
    F.CAPABILITIES['cubic-extremum'].note,
    F.NOTE_INTENT['cubic-parity']['奇偶性'],
    F.NOTE_INTENT['cubic-extremum']['极值点的横坐标']
  ];
  notes.forEach(function (t) {
    assert.ok(String(t).indexOf('**') < 0, '文案出现 **：' + t);
    assert.ok(!/奇函数|偶函数|原点对称/.test(t), '文案出现答案词：' + t);
  });
});

test('cubic-parity 的 note / NOTE_INTENT 零「奇 / 偶」二字（不泄漏答案）', function () {
  const texts = [F.CAPABILITIES['cubic-parity'].note, F.NOTE_INTENT['cubic-parity']['奇偶性']];
  texts.forEach(function (t) {
    assert.ok(!/奇|偶/.test(t), 'cubic-parity 文案出现奇/偶：' + t);
  });
});

test('答案数字审计：h225_q1 不出 2、h228_q2 不出 5、h229_q2 不出 1/-1', function () {
  const h225 = F.noteText('quadratic-vertex', '顶点坐标',
    Object.assign({}, F.labForScene(q('cnm_h225_q1').topicId, q('cnm_h225_q1').prompt, { itemId: 'cnm_h225_q1' })));
  delete h225.type; delete h225.base;
  assert.ok(tokensOf(h225).indexOf('2') < 0, 'h225_q1 文案印了答案 2：' + h225);

  const h228 = F.noteText('quadratic-vertex', '顶点坐标',
    Object.assign({}, F.labForScene(q('cnm_h228_q2').topicId, q('cnm_h228_q2').prompt, { itemId: 'cnm_h228_q2' })));
  delete h228.type; delete h228.base;
  assert.ok(tokensOf(h228).indexOf('5') < 0, 'h228_q2 文案印了答案 5：' + h228);

  const h229 = F.noteText('cubic-extremum', '极值点的横坐标',
    Object.assign({}, F.labForScene(q('cnm_h229_q2').topicId, q('cnm_h229_q2').prompt, { itemId: 'cnm_h229_q2' })));
  delete h229.type;
  const toks = tokensOf(h229);
  assert.ok(toks.indexOf('1') < 0 && toks.indexOf('-1') < 0 && toks.indexOf('−1') < 0,
    'h229_q2 文案印了驻点 1/-1：' + h229);
});

/* ================================================================
 * 8. 门禁组：31 条 misleading 仍全挡、h221_q2 仍挡
 * ================================================================ */

console.log('\n--- 8. 门禁回归 ---');

const MISLEADING = [
  'cnm_h027_q4', 'cnm_h029_q3', 'cnm_h032_q3', 'cnm_h033_q1', 'cnm_h033_q2', 'cnm_h033_q3',
  'cnm_h035_q3', 'cnm_h035_q4', 'cnm_h049_q3', 'cnm_h069_q4',
  'cnm_h216_q2', 'cnm_h217_q1', 'cnm_h217_q2', 'cnm_h218_q3', 'cnm_h219_q1',
  'cnm_h220_q1', 'cnm_h220_q2', 'cnm_h220_q3', 'cnm_h221_q1', 'cnm_h221_q2',
  'cnm_h222_q1', 'cnm_h222_q2', 'cnm_h222_q3', 'cnm_h223_q1', 'cnm_h223_q2',
  'cnm_h223_q3', 'cnm_h224_q1', 'cnm_h225_q2', 'cnm_h225_q3', 'cnm_h229_q1', 'cnm_h229_q3'
];

test('31 条 misleading 仍一条都过不了门禁', function () {
  const leaked = [];
  MISLEADING.forEach(function (id) {
    const item = q(id);
    let p = F.fromPrompt(item.prompt);
    if (!p && F.hsItemKind(id)) p = F.fromPrompt(F.hsPromptAlias(item.prompt));
    if (!p) return;
    if (!GATE.misfitOf(item, p)) leaked.push(id);
  });
  assert.deepStrictEqual(leaked, [], '这些题被门禁放过了：' + leaked.join(','));
});

test('cnm_h221_q2 仍解析成 power、仍被门禁挡下', function () {
  const item = q('cnm_h221_q2');
  const p = F.fromPrompt(item.prompt);
  assert.deepStrictEqual(p, { type: 'power', a: 1, p: 4 });
  const why = GATE.misfitOf(item, p);
  assert.ok(why, 'h221_q2 必须被门禁挡下');
});

/* ================================================================
 * 9. 197 题零改动：旧版非 null 的题，新版 JSON 逐字相同；新增仅 4 条
 * ================================================================ */

console.log('\n--- 9. 197 题零改动 ---');

test('d155a60 基线非 null 的题逐字不变，并打印 null→非 null 清单', function () {
  const OLD = loadBaselineHs('d155a60');
  const added = [];
  const changed = [];
  QUESTIONS.forEach(function (item) {
    const oldP = OLD.fromPrompt(item.prompt);
    const newP = F.fromPrompt(item.prompt);
    if (oldP !== null) {
      try { assert.deepStrictEqual(newP, oldP); }
      catch (e) { changed.push(item.id); }
    } else if (newP !== null) {
      added.push(item.id);
    }
  });
  assert.deepStrictEqual(changed, [], '既有解析结果被改动：' + changed.join(','));
  /* null→非 null 的清单只打印、不当作失败：d155a60 基线早于批1~批3，
   * 那些后来接入白名单的题本来就该从 null 变成有解析（是否挂载由门禁另管）。 */
  console.log('       （197 题比对：旧版非 null 全部逐字相同；null→非 null ' + added.length + ' 条 = ' + added.join(', ') + '）');
});

/* ================================================================ */

console.log('\n== ' + passed + ' passed / ' + failed + ' failed ==');
process.exit(failed ? 1 : 0);
