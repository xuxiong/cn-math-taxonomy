#!/usr/bin/env node
/* 卡 t_dc7163ea：AI 文本「受控微型标记」渲染测试 —— node tests/test_textfmt_markup.js
 *
 * 守的是六条不变量（卡面「必须写进测试的不变量」逐条对应）：
 *   1. 无损：data/questions.json 全部题面 + 选项 + 解析 + 答案逐条
 *      flatten(segments(x)) === normalize(x)。渲染器不许吞字、不许漏字。
 *   2. 幂等：flatten(segments(normalize(x))) === flatten(segments(x))。
 *   3. fail-closed：残缺 / 未闭合 / 未知命令一律当普通字符输出，不抛异常、不吞后续文本。
 *   4. XSS 行为：<img onerror>、<script>、</span><b>、裸引号只会以文本出现，
 *      生成的 DOM 里不存在 img / script 元素（断言行为，不读源码）。
 *   5. 体积：diagnose/textfmt.js gzip 增量 ≤ 5120B（zlib 现算，不信手写常量）。
 *   6. 结构快照：\frac / \sqrt / ** / x² 的元素层面形状。
 *
 * 外加一条漂移守卫：纯文本（片段树里只有文本节点）渲染出来的正文必须等于 normalize(x)
 * —— 渲染路径与 normalize 是同一套清洗规则的两个用法，规则漂了这里就红。
 *
 * 假 DOM 不引 jsdom：形状照抄仓内既有做法（tests/test_funclab*.js 的 makeDom()：
 * createElement / createTextNode / appendChild / textContent），够用且零依赖。
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

let passed = 0;
let failed = 0;
let skipped = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e).split('\n').slice(0, 5).join('\n       ')); }
}
function skip(name, why) { skipped++; console.log('  skip ' + name + ' — ' + why); }

const ROOT = path.join(__dirname, '..');
const T = require('../diagnose/textfmt.js');

/* ================================================================
 * 假 DOM（零依赖）
 * ================================================================ */

/* 卡面白名单：只许造这些标签 / class。渲染后逐节点核对（不在 createElement 里 assert ——
 * render() 有 try/catch 降级，断在里面的异常会被吞成纯文本，测不出来）。 */
const OK_TAGS = ['span', 'br', 'b', 'sup', 'sub', 'ul', 'li'];
const OK_CLASSES = ['tf-frac', 'tf-num', 'tf-den', 'tf-sqrt', 'tf-radicand', 'tf-root-index', 'tf-b', 'tf-list'];

function makeTextNode(v) {
  return {
    nodeType: 3,
    nodeValue: String(v),
    parentNode: null,
    get textContent() { return this.nodeValue; },
    set textContent(x) { this.nodeValue = String(x); }
  };
}

function makeElNode(tag, doc) {
  const n = {
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    className: '',
    childNodes: [],
    parentNode: null,
    ownerDocument: doc || null,
    appendChild: function (c) { c.parentNode = n; n.childNodes.push(c); return c; },
    get textContent() {
      return n.childNodes.map(function (c) { return c.textContent; }).join('');
    },
    set textContent(v) {
      n.childNodes = [];
      if (v !== '' && v !== null && v !== undefined) n.appendChild(makeTextNode(v));
    }
  };
  return n;
}

function makeDom() {
  const created = [];
  const doc = {
    createElement: function (tag) {
      const n = makeElNode(tag, doc);
      created.push(n);
      return n;
    },
    createTextNode: function (v) { return makeTextNode(v); }
  };
  const host = makeElNode('div', doc);
  return { doc: doc, host: host, created: created };
}

function walk(node, fn) {
  fn(node);
  (node.childNodes || []).forEach(function (c) { walk(c, fn); });
}

/** 上屏：渲染进假 DOM，返回 { host, created, text } */
function render(str) {
  const dom = makeDom();
  T.render(dom.host, str);
  dom.text = dom.host.textContent;
  return dom;
}

/** 片段树里有没有结构节点（只有文本节点 = 纯文本输入） */
function hasStructure(segs) {
  return segs.some(function (s) { return s.t !== 'text'; });
}

/* ================================================================
 * 语料：data/questions.json 全量（题面 + 选项 + 解析 + 答案）
 * ================================================================ */

const QS = require('../data/questions.json');
const CORPUS = [];
for (const q of QS) {
  if (q.prompt != null) CORPUS.push({ where: q.id + '.prompt', x: q.prompt });
  if (q.explanation != null) CORPUS.push({ where: q.id + '.explanation', x: q.explanation });
  if (Array.isArray(q.choices)) {
    for (let k = 0; k < q.choices.length; k++) {
      const c = q.choices[k];
      if (c && c.text != null) CORPUS.push({ where: q.id + '.choices[' + k + '].text', x: c.text });
    }
  }
  if (q.answer != null) CORPUS.push({ where: q.id + '.answer', x: String(q.answer) });
}

/* ================================================================
 * 1. 无损（最重要）
 * ================================================================ */

console.log('\n--- 1. 无损：flatten(segments(x)) === normalize(x) ---');

test('题库 ' + QS.length + ' 题 / ' + CORPUS.length + ' 条字符串逐条无损', () => {
  /* 地板写 8 万：题库现有 13335 题 → 81532 条；掉到 8 万以下说明数据塌了，断言不能空转 */
  assert.ok(CORPUS.length > 80000, '语料条数异常：' + CORPUS.length);
  const bad = [];
  for (const it of CORPUS) {
    let got;
    try { got = T.flatten(T.segments(it.x)); }
    catch (e) { bad.push([it.where, 'THROW ' + e.message, '', String(it.x).slice(0, 60)]); continue; }
    const want = T.normalize(it.x);
    if (got !== want) bad.push([it.where, want.slice(0, 80), got.slice(0, 80), String(it.x).slice(0, 80)]);
    if (bad.length >= 5) break;
  }
  assert.deepStrictEqual(bad, [], '渲染器吞字 / 漏字 / 改了顺序：\n' + JSON.stringify(bad, null, 1));
});

test('无损的另一半：片段树里只有文本节点时，上屏正文 === normalize(x)', () => {
  /* 纯文本输入不产生结构节点，渲染正文必须与 normalize 逐字一致 ——
   * 这是 cleanRun（渲染路径的清洗）与 normalize 之间的漂移守卫。 */
  const bad = [];
  let n = 0;
  for (const it of CORPUS) {
    const segs = T.segments(it.x);
    if (hasStructure(segs)) continue;
    n++;
    const got = render(it.x).text.trim();
    const want = T.normalize(it.x);
    if (got !== want) bad.push([it.where, want.slice(0, 80), got.slice(0, 80)]);
    if (bad.length >= 5) break;
  }
  assert.ok(n > 80000, '纯文本语料条数异常：' + n);
  assert.deepStrictEqual(bad, [], '渲染清洗与 normalize 漂移：\n' + JSON.stringify(bad, null, 1));
});

/* ================================================================
 * 2. 幂等
 * ================================================================ */

console.log('\n--- 2. 幂等 ---');

test('flatten(segments(normalize(x))) === flatten(segments(x))（全量）', () => {
  const bad = [];
  for (const it of CORPUS) {
    const a = T.flatten(T.segments(it.x));
    const b = T.flatten(T.segments(T.normalize(it.x)));
    if (a !== b) bad.push([it.where, a.slice(0, 80), b.slice(0, 80)]);
    if (bad.length >= 5) break;
  }
  assert.deepStrictEqual(bad, [], '二次规范化后又变了：\n' + JSON.stringify(bad, null, 1));
});

test('典型句子的幂等（结构节点参与的那几条路径）', () => {
  const cases = [
    '已知分式 \\frac{x+a}{x-b}，当 x=2 时值为多少？',
    '求 \\sqrt{3} 的近似值',
    '求 \\sqrt[3]{8} 的值',
    '**重点**：先移项',
    'x²-6x+9=0',
    '- 第一步移项\n- 第二步配方',
    'x^2+2x+1'
  ];
  for (const x of cases) {
    assert.strictEqual(
      T.flatten(T.segments(T.normalize(x))),
      T.flatten(T.segments(x)),
      '幂等失败：' + x
    );
  }
});

/* ================================================================
 * 3. fail-closed：残缺输入一律当普通字符，不抛异常、不吞后文
 * ================================================================ */

console.log('\n--- 3. fail-closed ---');

/* 每条都带尾巴「后续文本」：渲染正文必须仍以它结尾 —— 吞掉后文是这类解析器最典型的坏法 */
const TAIL = '后续文本';
const FAIL_CLOSED = [
  '\\frac{a' + TAIL,
  '\\frac{a}{b' + TAIL,
  '\\frac{}{}' + TAIL,
  '\\frac{}{b}' + TAIL,
  '\\frac{a}{}' + TAIL,
  '\\frac {a' + TAIL,
  '\\sqrt{' + TAIL,
  '\\sqrt[3]{' + TAIL,
  '\\sqrt[]{9}' + TAIL,
  '\\sqrt[3{8}' + TAIL,
  '\\sqrt' + TAIL,
  '**未闭合' + TAIL,
  'a ** b' + TAIL,
  '**x*' + TAIL,
  '**a*b**' + TAIL,
  '`未闭合代码' + TAIL,
  '^{2' + TAIL,
  'x^{' + TAIL,
  '^^' + TAIL,
  'x^^2' + TAIL,
  '\\' + TAIL,
  '\\x 未知命令' + TAIL,
  '\\frac{a{b}{c}' + TAIL,
  '\\frac{x}{' + TAIL,
  '`未闭合代码' + TAIL,
  '^{2' + TAIL,
  'x^{' + TAIL,
  '^^' + TAIL,
  'x^^2' + TAIL,
  '\\' + TAIL,
  '\\x 未知命令' + TAIL,
  '\\sum_{i=1} i' + TAIL,
  '# 标题不该变结构' + TAIL,
  'x^' + TAIL,
  '^2' + TAIL
];

test('fail-closed 表驱动（' + FAIL_CLOSED.length + ' 条，≥20）：不抛异常、不吞后文', () => {
  assert.ok(FAIL_CLOSED.length >= 20, '表太短：' + FAIL_CLOSED.length);
  for (const x of FAIL_CLOSED) {
    /* segments / flatten / render 三步都不许抛 */
    let segs, flat, dom;
    try {
      segs = T.segments(x);
      flat = T.flatten(segs);
      dom = render(x);
    } catch (e) {
      assert.fail('畸形输入抛异常了：' + JSON.stringify(x) + ' → ' + e.message);
    }
    /* 不吞字：原文每个字都还在片段树里（还原回原文，除首尾空白） */
    assert.strictEqual(
      flat, T.normalize(x),
      '畸形输入改写了文本：' + JSON.stringify(x)
    );
    /* 不上屏结构：这些写法一个都不该被认成标记 */
    assert.strictEqual(hasStructure(segs), false,
      '畸形输入被认成了结构：' + JSON.stringify(x) + ' → ' + JSON.stringify(segs.map(function (s) { return s.t; })));
    /* 不吞后文 */
    assert.ok(dom.text.trim().endsWith(TAIL),
      '吞掉了后续文本：' + JSON.stringify(x) + ' → ' + JSON.stringify(dom.text));
  }
});

test('fail-closed：未知命令 / 裸反斜杠只剥符号，正文照旧', () => {
  assert.strictEqual(render('\\alpha' + TAIL).text, 'alpha' + TAIL);
  assert.strictEqual(render('\\' + TAIL).text, '\\' + TAIL);
  assert.strictEqual(render('a\\b' + TAIL).text, 'ab' + TAIL);
});

test('fail-closed：render 遇到坏 el 也不炸', () => {
  assert.doesNotThrow(function () { T.render(null, 'x'); });
  assert.doesNotThrow(function () { T.render({}, 'x'); });
});

/* ================================================================
 * 4. XSS 行为断言（只断言行为，不读源码）
 * ================================================================ */

console.log('\n--- 4. XSS：模型文本只会变成文本 ---');

const XSS_INPUTS = [
  '<img src=x onerror=alert(1)>',
  '<script>alert(1)</script>',
  '</span><b>',
  '"onerror="',
  '<svg/onload=alert(1)>',
  '<a href="javascript:alert(1)">点我</a>',
  '**<img src=x onerror=alert(1)>**',
  '\\frac{<script>alert(1)</script>}{1}'
];

test('渲染后 DOM 里不存在 img / script 元素（' + XSS_INPUTS.length + ' 条注入串）', () => {
  for (const x of XSS_INPUTS) {
    const dom = render(x);
    const tags = [];
    walk(dom.host, function (n) { if (n.nodeType === 1) tags.push(n.tagName); });
    assert.strictEqual(tags.indexOf('IMG'), -1, '造出了 <img>：' + x);
    assert.strictEqual(tags.indexOf('SCRIPT'), -1, '造出了 <script>：' + x);
    assert.strictEqual(tags.indexOf('SVG'), -1, '造出了 <svg>：' + x);
    assert.strictEqual(tags.indexOf('A'), -1, '造出了 <a>：' + x);
  }
});

test('注入串的字符以文本形式可见（没有被当成标签吃掉）', () => {
  for (const x of XSS_INPUTS) {
    const dom = render(x);
    assert.ok(dom.text.indexOf('<img') >= 0 || dom.text.indexOf('<script') >= 0
      || dom.text.indexOf('<svg') >= 0 || dom.text.indexOf('<a ') >= 0
      || dom.text.indexOf('</span>') >= 0 || dom.text.indexOf('"onerror="') >= 0,
      '注入串的字面量没上屏：' + x + ' → ' + JSON.stringify(dom.text));
    /* 文本节点里不许夹带元素：渲染出来的每个节点只有白名单标签 + 文本节点
     * （host 本身是调用方给的容器，不在白名单约束内，所以从它的子节点开始走） */
    dom.host.childNodes.forEach(function (n) {
      walk(n, function (m) {
        if (m.nodeType === 1) {
          assert.ok(OK_TAGS.indexOf(m.tagName.toLowerCase()) >= 0, '白名单外标签：' + m.tagName);
          if (m.className) assert.ok(OK_CLASSES.indexOf(m.className) >= 0, '白名单外 class：' + m.className);
        } else {
          assert.strictEqual(m.nodeType, 3, '出现了非元素非文本节点');
        }
      });
    });
  }
});

test('注入串若被结构包裹（**…** 里 / \\frac 里），仍然只是文本', () => {
  const a = render('**<img src=x onerror=alert(1)>**');
  assert.deepStrictEqual(a.created.map(function (n) { return n.tagName; }), ['B']);
  assert.strictEqual(a.text, '<img src=x onerror=alert(1)>');
  const b = render('\\frac{<script>alert(1)</script>}{1}');
  assert.deepStrictEqual(b.created.map(function (n) { return n.tagName; }), ['SPAN', 'SPAN', 'SPAN']);
  assert.strictEqual(b.text, '<script>alert(1)</script>1');
});

/* ================================================================
 * 5. 体积：gzip 增量 ≤ 5120B
 * ================================================================ */

console.log('\n--- 5. 体积 ---');

test('diagnose/textfmt.js gzip 增量 ≤ 5120B', () => {
  /* 基线 = 卡前（HEAD）同一个 zlib.gzipSync 的读数，实测 3698B；预算 = 基线 + 5120B */
  const BASE_GZ = 3698;
  const LIMIT = BASE_GZ + 5120;
  const sz = zlib.gzipSync(fs.readFileSync(path.join(ROOT, 'diagnose', 'textfmt.js'))).length;
  console.log('       textfmt.js gzip = ' + sz + 'B（基线 ' + BASE_GZ + 'B，增量 ' + (sz - BASE_GZ) + 'B，上限 ' + LIMIT + 'B）');
  assert.ok(sz <= LIMIT, 'gzip 超预算：' + sz + 'B > ' + LIMIT + 'B');
  assert.ok(sz > BASE_GZ, 'gzip 比卡前还小：' + sz + 'B —— 说明基线常量已过期，请重新测');
});

/* ================================================================
 * 6. 结构快照（元素层面，不是像素）
 * ================================================================ */

console.log('\n--- 6. 结构快照 ---');

test('\\frac{x+a}{x-b} → span.tf-frac > span.tf-num「x+a」+ span.tf-den「x-b」', () => {
  const dom = render('\\frac{x+a}{x-b}');
  assert.deepStrictEqual(dom.created.map(function (n) { return n.tagName + '.' + n.className; }),
    ['SPAN.tf-frac', 'SPAN.tf-num', 'SPAN.tf-den']);
  assert.strictEqual(dom.host.childNodes.length, 1, '应恰好一个分式节点');
  const frac = dom.host.childNodes[0];
  assert.strictEqual(frac.className, 'tf-frac');
  assert.strictEqual(frac.childNodes.length, 2);
  assert.strictEqual(frac.childNodes[0].className, 'tf-num');
  assert.strictEqual(frac.childNodes[0].textContent, 'x+a');
  assert.strictEqual(frac.childNodes[1].className, 'tf-den');
  assert.strictEqual(frac.childNodes[1].textContent, 'x-b');
});

test('\\sqrt{3} → span.tf-sqrt > span.tf-radicand「3」', () => {
  const dom = render('\\sqrt{3}');
  assert.deepStrictEqual(dom.created.map(function (n) { return n.tagName + '.' + n.className; }),
    ['SPAN.tf-sqrt', 'SPAN.tf-radicand']);
  const q = dom.host.childNodes[0];
  assert.strictEqual(q.className, 'tf-sqrt');
  assert.strictEqual(q.childNodes.length, 1);
  assert.strictEqual(q.childNodes[0].className, 'tf-radicand');
  assert.strictEqual(q.childNodes[0].textContent, '3');
});

test('\\sqrt[3]{8} → tf-sqrt > (tf-root-index「3」, tf-radicand「8」)', () => {
  const dom = render('\\sqrt[3]{8}');
  const q = dom.host.childNodes[0];
  assert.strictEqual(q.className, 'tf-sqrt');
  assert.strictEqual(q.childNodes[0].className, 'tf-root-index');
  assert.strictEqual(q.childNodes[0].textContent, '3');
  assert.strictEqual(q.childNodes[1].className, 'tf-radicand');
  assert.strictEqual(q.childNodes[1].textContent, '8');
});

test('**重点** → b.tf-b「重点」', () => {
  const dom = render('**重点**');
  assert.deepStrictEqual(dom.created.map(function (n) { return n.tagName + '.' + n.className; }), ['B.tf-b']);
  assert.strictEqual(dom.host.childNodes[0].textContent, '重点');
});

test('x² → 文本「x」+ sup「2」', () => {
  const dom = render('x²');
  assert.strictEqual(dom.host.childNodes.length, 2);
  assert.strictEqual(dom.host.childNodes[0].nodeType, 3);
  assert.strictEqual(dom.host.childNodes[0].textContent, 'x');
  assert.strictEqual(dom.host.childNodes[1].tagName, 'SUP');
  assert.strictEqual(dom.host.childNodes[1].textContent, '2');
});

test('x^2 → 文本「x」+ sup「2」（^ 写法与 ² 写法同形）', () => {
  const dom = render('x^2');
  assert.strictEqual(dom.host.childNodes[0].textContent, 'x');
  assert.strictEqual(dom.host.childNodes[1].tagName, 'SUP');
  assert.strictEqual(dom.host.childNodes[1].textContent, '2');
});

test('行首「- 」→ ul.tf-list > li（连续两项并进同一个 ul）', () => {
  const dom = render('- 第一步\n- 第二步');
  const tags = dom.created.map(function (n) { return n.tagName + (n.className ? '.' + n.className : ''); });
  assert.deepStrictEqual(tags, ['UL.tf-list', 'LI', 'LI']);
  const ul = dom.host.childNodes[0];
  assert.strictEqual(ul.className, 'tf-list');
  assert.strictEqual(ul.childNodes.length, 2);
  assert.strictEqual(ul.childNodes[0].textContent, '第一步');
});

test('渲染是追加：不清 el 既有子节点（讲解面板先写「老师：」再渲染正文）', () => {
  const dom = makeDom();
  T.render(dom.host, '老师：');
  T.render(dom.host, '\\frac{1}{2}');
  assert.strictEqual(dom.host.childNodes[0].textContent, '老师：');
  assert.strictEqual(dom.host.childNodes[1].className, 'tf-frac');
  assert.strictEqual(dom.host.textContent, '老师：12');
});

test('非 DOM 环境降级：没有 ownerDocument 时只写纯文本，不抛', () => {
  const fake = { textContent: '', appendChild: function () { throw new Error('不该造节点'); } };
  const out = T.render(fake, '\\frac{a}{b}');
  assert.strictEqual(out.textContent, '(a)/(b)');
});

/* ================================================================
 * 7. 新增出口不许动 normalize 的对外形状
 * ================================================================ */

console.log('\n--- 7. 出口形状 ---');

test('normalize / cleanMarkdown 仍是同一个函数，且新增出口不替换它', () => {
  assert.strictEqual(T.cleanMarkdown, T.normalize);
  assert.strictEqual(typeof T.segments, 'function');
  assert.strictEqual(typeof T.render, 'function');
  assert.strictEqual(typeof T.flatten, 'function');
  assert.strictEqual(T.normalize('\\frac{3}{4}'), '(3)/(4)');
});

/* ================================================================
 * 汇总
 * ================================================================ */

console.log('\n' + passed + ' passed, ' + failed + ' failed' + (skipped ? ', ' + skipped + ' skipped' : ''));
process.exit(failed ? 1 : 0);
