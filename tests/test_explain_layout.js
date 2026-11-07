#!/usr/bin/env node
/* 卡 t_93dad601：解析分行与列表（prompt 要求分段 + 上屏走结构）—— node tests/test_explain_layout.js
 *
 * 守的是卡面四条验收口径：
 *   1. prompt 层面要求分段：reveal 按步骤分行、最多 4 行、行首「- 」，最后一行「答案：x = …」；
 *      prompt / hint 仍单段（一句话，不许换行）；chip 的 judge_mine explain 两行（错在哪 / 怎么改）；
 *      换行必须写成 JSON 字符串里的 \n（给出 3 行示例）。
 *   2. mock LLM 返回带 \n 与行首「- 」的 reveal → 上屏 DOM 里出现 ul 与 ≥2 个 li，
 *      每个 li 的正文 === normalize(raw) 的对应分段（逐条对应，不丢行）。
 *   3. 反向：mock 返回单段（无 \n）→ DOM 里没有 ul/li，文本与改动前逐字一致（不多出空元素）。
 *   4. 一致性：任何输入下，显示文本（列表项之间补 \n、sup→Unicode 上标、frac→(a)/(b)、sqrt→√x）
 *      === normalize(raw) —— 与卡 H 的无损不变量同口径。
 *
 * 另外守两条「不许倒退」：
 *   · normalize() 仍是唯一拍平口径：steps[].text 与追问 r.text 必须严格等于 normalize(rich)。
 *   · 上屏不能绕开 renderStepText 另铺一套：app-flow 三处讲解正文都打这个口（读源码断言），
 *     免得以后有人把结构改回 richText(step.text) 而测试还绿。
 *
 * 假 DOM 不引 jsdom：形状照抄 tests/test_textfmt_markup.js 的 makeDom()（createElement /
 * createTextNode / appendChild / textContent），零依赖。
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e).split('\n').slice(0, 6).join('\n       ')); }
}
const asyncTests = [];
function testAsync(name, fn) { asyncTests.push({ name: name, fn: fn }); }

const ROOT = path.join(__dirname, '..');
const FLOW_SRC = fs.readFileSync(path.join(ROOT, 'diagnose', 'app-flow.js'), 'utf8');
const T = require('../diagnose/textfmt.js');
const E = require('../diagnose/engine.js');

/* ================================================================
 * 假 DOM（零依赖，形状与 tests/test_textfmt_markup.js 一致）
 * ================================================================ */

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

const DOC = {
  createElement: function (tag) { return makeElNode(tag, DOC); },
  createTextNode: function (v) { return makeTextNode(v); }
};

function host() { return DOC.createElement('div'); }

function tags(el, name) {
  return (el.childNodes || []).filter(function (c) { return c.nodeType === 1 && c.tagName === name.toUpperCase(); });
}
function walk(node, fn) {
  fn(node);
  (node.childNodes || []).forEach(function (c) { walk(c, fn); });
}
function countTag(el, name) {
  let n = 0;
  walk(el, function (x) { if (x.nodeType === 1 && x.tagName === name.toUpperCase()) n++; });
  return n;
}

/* 显示文本 → 与 normalize() 可比的串。
 * 列表是「结构」：li 之间原本的那一个换行由 ul/li 承载，取回文本时要补回来；
 * 上标 / 分式 / 根号在 normalize() 视角下的字符，按 textfmt.js 的 tailOf() 同一口径还原。 */
const SUP_UNI = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
  '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', 'n': 'ⁿ', 'i': 'ⁱ'
};

function domText(n) {
  if (n.nodeType === 3) return n.nodeValue;
  const tag = n.tagName;
  const kids = n.childNodes || [];
  if (tag === 'UL') return kids.map(domText).join('\n');
  if (tag === 'LI') return kids.map(domText).join('');
  if (tag === 'SUP') {
    return String(n.textContent || '').split('').map(function (c) { return SUP_UNI[c] || c; }).join('');
  }
  if (n.className === 'tf-frac') return '(' + domText(kids[0]) + ')/(' + domText(kids[1]) + ')';
  if (n.className === 'tf-sqrt') {
    let idx = '';
    let rad = '';
    kids.forEach(function (k) {
      if (k.className === 'tf-root-index') idx = domText(k);
      else if (k.className === 'tf-radicand') rad = domText(k);
    });
    return idx ? idx + ' 次根号 ' + rad : '√' + rad;
  }
  return kids.map(domText).join('');
}

/* ================================================================
 * 模块装载
 * ================================================================ */

function loadExplain() {
  const g = globalThis;
  g.window = g;
  g.DiagEngine = E;
  g.CnmTextFmt = T;
  require('../diagnose/llm-config.js');
  delete require.cache[require.resolve('../diagnose/explain.js')];
  require('../diagnose/explain.js');
  return g.Explain;
}

/* app-flow 只读 CORE 的字段；这里给最小 stub（进流程才会用到被省略的那些）。
 * h 也照抄一份——本测不调 renderQuestion，但拿着它才能确认 bubble 那条表达式的形状。 */
function loadFlow() {
  const g = globalThis;
  g.window = g;
  g.DiagCore = {
    S: {}, Lazy: {}, h: function (tag, opt, kids) { return { tag: tag, opt: opt, kids: kids }; },
    E: E, registerFlow: function () {},
    LAZY_PATH: [], PATH_FOLD_AT: 10, LAZY_EXPLAIN: [], LAZY_LAB: [], LAZY_SHARE: [], LAZY_VARIANTS: [],
    LAZY_GENROUTE: [], LAZY_CONSTRUCT: [], LS_PRAC: 'x.prac', LS_VSEQ: 'x.vseq',
    PRACTICE_N: 10, DIFF_LABEL: {}, STATUS_LABEL: {}, RESULT_LABEL: {}, TYPE_LABEL: {}, VOLUMES: []
  };
  delete require.cache[require.resolve('../diagnose/app-flow.js')];
  return require('../diagnose/app-flow.js');
}

/* 上屏唯一出口（app-flow 内部同名函数，经 _display 暴露给测试） */
function display(raw) {
  const AF = loadFlow();
  return AF._display.renderStepText(host(), { rich: raw, text: T.normalize(raw) });
}

function mockLLM(content) {
  const real = globalThis.fetch;
  const body = { choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] };
  globalThis.fetch = function () {
    return Promise.resolve({ ok: true, json: function () { return Promise.resolve(body); } });
  };
  return function restore() { globalThis.fetch = real; };
}

/* ================================================================
 * 1. prompt 层面要求分段
 * ================================================================ */

console.log('\n--- 1. prompt 要求分段 ---');

const REVEAL_LINES = [
  '- 先去括号：2(x-3) = 4 - x 得 2x - 6 = 4 - x',
  '- 再移项：把 -x 挪到左边、-6 挪到右边，得 3x = 10',
  '- 最后算除法：x = 10/3',
  '- 答案：x = 10/3'
];
const REVEAL = REVEAL_LINES.join('\n');
const PROMPT_STEP = '两边同时减去 3，等号还成立吗？你先说说看。';
const HINT_STEP = '先把含 x 的项挪到同一边，注意变号。';

const TOPIC = { id: 'cnm_p1', name: '一元一次方程' };
const Q = { id: 'layout-1', type: 'numeric', prompt: '解方程 2(x-3) = 4 - x', answer: '10/3' };

test('systemPrompt：reveal 按步骤分行、每行一个步骤、最多 4 行、行首「- 」', function () {
  const X = loadExplain();
  const p = X._systemPrompt();
  assert.ok(p.indexOf('按步骤分行写') >= 0, '应要求按步骤分行：' + p);
  assert.ok(p.indexOf('每行一个步骤') >= 0, '应要求每行一个步骤');
  assert.ok(p.indexOf('最多 4 行') >= 0, '应给出行数上限 4');
  assert.ok(p.indexOf('行首用「- 」起头') >= 0, '应要求行首「- 」');
});

test('systemPrompt：reveal 最后一行才是「答案：x = …」', function () {
  const p = loadExplain()._systemPrompt();
  assert.ok(p.indexOf('最后一行才是「答案：') >= 0, '应把答案钉在最后一行：' + p);
  assert.ok(/多解时写「答案：x1 = …，x2 = …」/.test(p), '多解写法不许丢');
});

test('systemPrompt：prompt / hint 仍要求单段（一句话，不许换行）', function () {
  const p = loadExplain()._systemPrompt();
  assert.ok(p.indexOf('prompt 和 hint 必须各是一整段') >= 0, 'prompt/hint 必须要求单段：' + p);
  assert.ok(p.indexOf('绝对不许换行') >= 0, 'prompt/hint 必须明说不许换行');
});

test('systemPrompt：换行写成 \\n，且给出正好 3 行的 JSON 示例', function () {
  const p = loadExplain()._systemPrompt();
  assert.ok(p.indexOf('用 \\n 表示') >= 0, '应说明换行写成 \\n：' + p);
  const m = p.match(/\{"reveal":"([^"]*)"\}/);
  assert.ok(m, '应有一个 {"reveal":"…"} 形状的示例');
  /* 示例里的换行是 JSON 字符串里的 \n（两个字符：反斜杠 + n），不是真换行 */
  assert.ok(m[1].indexOf('\\n') >= 0, '示例必须用 \\n 表达换行，不许真的敲回车：' + JSON.stringify(m[1]));
  const lines = m[1].split('\\n');
  assert.strictEqual(lines.length, 3, '示例应正好 3 行（卡面要求），实际 ' + lines.length);
  lines.forEach(function (l, i) {
    assert.ok(l.indexOf('- ') === 0, '示例第 ' + (i + 1) + ' 行应以「- 」起头：' + JSON.stringify(l));
  });
  assert.ok(lines[2].indexOf('答案：') >= 0, '示例最后一行应是答案：' + lines[2]);
});

test('systemPrompt：Markdown 禁令只给 reveal 行首「- 」开口子，别的标记仍禁', function () {
  const p = loadExplain()._systemPrompt();
  assert.ok(p.indexOf('禁止任何 Markdown 标记') >= 0, 'Markdown 禁令不许松：' + p);
  assert.ok(p.indexOf('只有 reveal 的行首「- 」') >= 0, '应显式限定「- 」只在 reveal 行首');
  assert.ok(p.indexOf('**') >= 0 && p.indexOf('#') >= 0, '被禁的标记仍要点名');
});

test('chipSystemPrompt：judge_mine 的 explain 要求两行（错在哪 / 怎么改）', function () {
  const X = loadExplain();
  const p = X._tutor.chipSystemPrompt({ action: 'judge_mine' }, {});
  assert.ok(p.indexOf('第一行说错在哪') >= 0, '应要求第一行说错在哪：' + p);
  assert.ok(p.indexOf('第二行说怎么改') >= 0, '应要求第二行说怎么改');
  assert.ok(p.indexOf('最多 2 行') >= 0, '应给出两行上限');
  assert.ok(p.indexOf('用 \\n') >= 0, '应说明换行写成 \\n');
});

test('chipSystemPrompt：别的 chip（why_step / hint_leveled）没被顺手改成分段', function () {
  const X = loadExplain();
  ['why_step', 'hint_leveled'].forEach(function (action) {
    const p = X._tutor.chipSystemPrompt({ action: action }, { level: 1 });
    assert.ok(p.indexOf('第一行说错在哪') < 0, action + ' 不该要求两行：' + p);
    assert.ok(p.indexOf('按步骤分行') < 0, action + ' 不该要求分行');
  });
});

/* ================================================================
 * 2. mock LLM → 三步讲解上屏走结构
 * ================================================================ */

console.log('\n--- 2. mock LLM 返回分行 reveal → 上屏结构 ---');

testAsync('generate：rich 保原文（行首「- 」还在），text 仍是 normalize 的拍平串', async function () {
  const X = loadExplain();
  X._cache.clear();
  const restore = mockLLM({ prompt: PROMPT_STEP, hint: HINT_STEP, reveal: REVEAL });
  let r;
  try { r = await X.generate(TOPIC, Q, '1'); } finally { restore(); }
  assert.strictEqual(r.from, 'llm');
  assert.strictEqual(r.steps[2].rich, REVEAL, 'reveal 的 rich 必须逐字等于模型原文（分段靠它）');
  assert.strictEqual(r.steps[2].text, T.normalize(REVEAL), 'text 必须仍是 normalize 的结果（门禁/缓存口径不变）');
  assert.ok(!/^- /m.test(r.steps[2].text), 'text 里不该再有任何行首列表符：' + r.steps[2].text);
  assert.strictEqual(r.steps[2].text.split('\n').length, REVEAL_LINES.length, '拍平后行数不变');
});

testAsync('上屏 reveal：一个 ul + 4 个 li，每个 li 正文 === normalize(raw) 的对应行', async function () {
  const X = loadExplain();
  X._cache.clear();
  const restore = mockLLM({ prompt: PROMPT_STEP, hint: HINT_STEP, reveal: REVEAL });
  let r;
  try { r = await X.generate(TOPIC, Q, '1'); } finally { restore(); }
  const el = display(r.steps[2].rich || r.steps[2].text);
  const uls = tags(el, 'ul');
  assert.strictEqual(uls.length, 1, '应恰好一个 ul，实际 ' + uls.length);
  const lis = tags(uls[0], 'li');
  assert.strictEqual(lis.length, 4, '4 行应给 4 个 li，实际 ' + lis.length);
  const want = T.normalize(REVEAL).split('\n');
  lis.forEach(function (li, i) {
    assert.strictEqual(domText(li), want[i], '第 ' + (i + 1) + ' 个 li 与 normalize 的第 ' + (i + 1) + ' 行不一致');
  });
  assert.strictEqual(domText(el), T.normalize(REVEAL), '整块显示文本必须等于 normalize(raw)');
});

testAsync('上屏 prompt / hint（单段）：没有 ul/li，正文与 normalize 逐字一致', async function () {
  const X = loadExplain();
  X._cache.clear();
  const restore = mockLLM({ prompt: PROMPT_STEP, hint: HINT_STEP, reveal: REVEAL });
  let r;
  try { r = await X.generate(TOPIC, Q, '1'); } finally { restore(); }
  [0, 1].forEach(function (i) {
    const el = display(r.steps[i].rich || r.steps[i].text);
    assert.strictEqual(countTag(el, 'ul'), 0, '第 ' + (i + 1) + ' 步不该有 ul（单段文本）');
    assert.strictEqual(countTag(el, 'li'), 0, '第 ' + (i + 1) + ' 步不该有 li');
    assert.strictEqual(el.childNodes.length, 1, '单段文本应只有一个文本节点，不多出空元素');
    assert.strictEqual(domText(el), T.normalize(r.steps[i].rich), '单段正文必须与 normalize 逐字一致');
  });
});

/* ================================================================
 * 3. 反向：单段 reveal（老产物）→ 与改动前逐字一致
 * ================================================================ */

console.log('\n--- 3. 反向：单段 reveal ---');

testAsync('单段 reveal：DOM 里没有 ul/li，文本与改动前逐字一致', async function () {
  const X = loadExplain();
  X._cache.clear();
  const single = '去括号得 2x-6=4-x，移项合并得 3x=10，所以 x=10/3。答案：x = 10/3';
  const restore = mockLLM({ prompt: PROMPT_STEP, hint: HINT_STEP, reveal: single });
  let r;
  try { r = await X.generate(TOPIC, Q, '1'); } finally { restore(); }
  assert.strictEqual(r.steps[2].rich, single, '单段 reveal 的 rich 就是原文');
  const el = display(r.steps[2].rich);
  assert.strictEqual(countTag(el, 'ul'), 0, '单段不许出 ul');
  assert.strictEqual(countTag(el, 'li'), 0, '单段不许出 li');
  assert.strictEqual(el.textContent, single, '单段文本必须逐字等于原文（含尾句「答案：」）');
  assert.strictEqual(el.textContent, T.normalize(single), '与 normalize 也必须逐字一致');
});

/* ================================================================
 * 4. 一致性：任何输入下显示文本 === normalize(raw)
 * ================================================================ */

console.log('\n--- 4. 一致性（显示文本 vs normalize） ---');

const CASES = [
  ['三行列表（卡面主场景）', REVEAL],
  ['单段一句话', '先想想为什么要移项？'],
  ['段落后接列表', '先想想为什么要移项。\n- 移项要变号\n- 最后再算除法\n- 答案：x = 2'],
  ['列表 + 加粗 + 乘方', '- 把 **两边** 同时除以 2\n- 得到 (x-1)² = 4\n- 答案：x = 3'],
  ['列表 + 分式', '- 通分：\\frac{1}{2} + \\frac{1}{3} = \\frac{5}{6}\n- 答案：x = 5/6'],
  ['列表 + 根号', '- 开方：\\sqrt{9} = 3，\\sqrt[3]{8} = 2\n- 答案：x = 3'],
  ['无列表的多段（模型没照 format 写）', '第一行\n第二行\n第三行'],
  ['fail-closed：未闭合 ** 落进列表项', '- 这里 **没闭合\n- 答案：x = 1'],
  ['列表带 * / + 行首符', '* 甲\n+ 乙\n- 丙']
];

test('一致性：显示文本（列表项之间补换行）=== normalize(raw)', function () {
  CASES.forEach(function (c) {
    const raw = c[1];
    const el = display(raw);
    assert.strictEqual(domText(el), T.normalize(raw), '[' + c[0] + '] 显示文本应与 normalize 一致');
  });
});

test('空行：结构承载空行（ul 之间不保留双换行），但行内容一行不丢', function () {
  const raw = '- 第一步：去括号\n\n- 第二步：移项\n- 答案：x = 1';
  const got = domText(display(raw));
  const want = T.normalize(raw);
  assert.strictEqual(got, want.replace('\n\n', '\n'),
    '空行由 ul 结构承担（去掉一个换行），别的字符不许动');
  assert.deepStrictEqual(got.split('\n'), want.split('\n').filter(function (l) { return l !== ''; }),
    '非空行必须逐条一致');
});

/* ================================================================
 * 5. 追问气泡：rich 不丢结构，text 仍是拍平口径
 * ================================================================ */

console.log('\n--- 5. 追问气泡 ---');

testAsync('Explain.ask：rich 是模型原文，text 仍是 normalize（会话历史读 text）', async function () {
  const X = loadExplain();
  const raw = '- 先把含 x 的项挪到同一边\n- 再合并同类项\n- 答案：x = 2';
  const restore = mockLLM({ text: raw, graph: null });
  let r;
  try { r = await X.ask(TOPIC, Q, '1', [], '移项到底为什么要变号？'); } finally { restore(); }
  assert.strictEqual(r.from, 'llm');
  assert.strictEqual(r.rich, raw, 'ask 必须把模型原文带出来，否则气泡永远出不了列表');
  assert.strictEqual(r.text, T.normalize(raw), 'ask 的 text 必须仍是 normalize 结果');
});

test('气泡：前缀单独一个文本节点 + 正文走 render()，行首「- 」仍成 ul/li', function () {
  const raw = '- 先把含 x 的项挪到同一边\n- 再合并同类项\n- 答案：x = 2';
  const el = host();
  const AF = loadFlow();
  /* 与 app-flow 的 answerEl 同一组合方式：先挂「老师：」，再让 richText 往同一个元素里渲染正文。
   * 拼成 '老师：' + raw 会把第一行的行首「- 」吃掉（不再是行首），这里就是为了钉住这一点。 */
  AF._display.richText(el, '老师：');
  AF._display.richText(el, raw);
  assert.strictEqual(el.childNodes[0].nodeType, 3, '前缀必须是单独的文本节点');
  assert.strictEqual(el.childNodes[0].nodeValue, '老师：');
  const uls = tags(el, 'ul');
  assert.strictEqual(uls.length, 1, '气泡里的列表应成一个 ul，实际 ' + uls.length);
  assert.strictEqual(tags(uls[0], 'li').length, 3, '三行应给三个 li');
  assert.strictEqual(domText(el), '老师：' + T.normalize(raw), '气泡文本 = 前缀 + normalize(raw)');
});

/* ================================================================
 * 6. 源码守卫：上屏不许绕开 renderStepText
 * ================================================================ */

console.log('\n--- 6. 源码守卫 ---');

test('三步讲解三处正文都走 renderStepText（没有一处退回 stepRich 直渲）', function () {
  const hits = FLOW_SRC.match(/renderStepText\(h\('div', \{ class: '(q-text|explain)' \}\), steps\[[012]\]\)/g) || [];
  assert.strictEqual(hits.length, 3, '三处上屏都要走 renderStepText，实际 ' + hits.length + ' 处');
  assert.ok(FLOW_SRC.indexOf("richText(h('div', { class: 'q-text' }), stepRich(steps[0]))") < 0,
    '不许保留旧写法（richText + stepRich 直渲）');
  assert.ok(FLOW_SRC.indexOf("richText(h('div', { class: 'explain' }), stepRich(steps[1]))") < 0,
    '不许保留旧写法');
  assert.ok(FLOW_SRC.indexOf("richText(h('div', { class: 'explain' }), stepRich(steps[2]))") < 0,
    '不许保留旧写法');
});

test('气泡正文取 rich（a 是拍平串，直接上屏就永远没有结构）', function () {
  assert.ok(/richText\(h\('div', \{ class: 'ask-a' \}, '老师：'\), entry\.rich \|\| entry\.a\)/.test(FLOW_SRC),
    '气泡必须用 entry.rich 优先、前缀单独成节点');
  assert.ok(/entries2\[idx\] = \{ q: text, a: res\.text, rich: res\.rich,/.test(FLOW_SRC),
    'runAsk 必须把 res.rich 落到气泡条目上');
});

/* ================================================================
 * 汇总
 * ================================================================ */

(async function main() {
  console.log('\n--- 汇总 ---');
  for (const t of asyncTests) {
    try { await t.fn(); passed++; console.log('  ok   ' + t.name); }
    catch (e) { failed++; console.log('  FAIL ' + t.name + '\n       ' + (e && e.stack || e).split('\n').slice(0, 6).join('\n       ')); }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
