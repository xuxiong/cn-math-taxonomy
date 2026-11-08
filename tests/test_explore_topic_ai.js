#!/usr/bin/env node
/* O4 卡B：知识点 AI 讲解的页面接线守卫（零依赖、零真网络、vm 沙箱 + 假 DOM）。
 *
 * 覆盖卡面 §5 的 1–9 + 额外一条：
 *   1. 点击前零加载 / 点击后 5 个脚本按序懒加载；
 *   2. 未配模型：零网络、零 postOnce，给设置入口；
 *   3. 成功路径：5 段结构化渲染（how 去双序号、demo 题面 / 分步 / 折叠答案）；
 *   4. 被闸门拒：可见重试、失败轮不写缓存 / 对话；
 *   5. 追问：气泡、10 轮上限、清空对话、第 11 轮被拒；
 *   6. 切换 topic 再切回：不重发、状态还在；
 *   7. 缓存命中：新模块实例、同一 storage、零 postOnce；
 *   8. 红线：禁 innerHTML 一干、CSS 新增选择器带 .tai- 前缀；
 *   9. 首屏脚本恰好 5 个且不含 topic-ai.js；
 *   额外：topic-ai.js 里不出现 fetch(。
 *
 * 做法对齐 tests/test_explore_detail_retry.js：从 explore/app.js 按括号配平取真实函数源码，
 * 塞进 vm 沙箱跑；topic-ai.js 用 vm.runInContext 按浏览器方式加载。测试里不复制等价实现。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const APP_PATH = path.join(ROOT, 'explore', 'app.js');
const APP = fs.readFileSync(APP_PATH, 'utf8');
const MODULE_PATH = path.join(ROOT, 'explore', 'topic-ai.js');
const CSS_PATH = path.join(ROOT, 'assets', 'explore.css');
const INDEX_PATH = path.join(ROOT, 'explore', 'index.html');

const BADGE = 'AI 生成 · 未经人工审核';

let passed = 0;
let failed = 0;
const ASYNC = [];

function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e).split('\n').slice(0, 8).join('\n       ')); }
}
function testAsync(name, fn) {
  ASYNC.push(fn().then(
    function () { passed++; console.log('  ok   ' + name); },
    function (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e).split('\n').slice(0, 8).join('\n       ')); }
  ));
}

/* ================================================================ 假 DOM */

function makeNode(tag) {
  const node = {
    tagName: String(tag).toUpperCase(),
    className: '',
    textContent: '',
    hidden: false,
    disabled: false,
    value: '',
    children: [],
    parent: null,
    _attrs: {},
    _listeners: {},
    append: function () {
      for (let i = 0; i < arguments.length; i++) {
        const child = arguments[i];
        if (Array.isArray(child)) { child.forEach(function (c) { node.append(c); }); continue; }
        if (child === null || child === undefined) continue;
        if (typeof child === 'string' || typeof child === 'number') { node.children.push(String(child)); continue; }
        node.children.push(child);
        child.parent = node;
      }
    },
    appendChild: function (child) { node.append(child); return child; },
    replaceChildren: function () {
      node.children.forEach(function (c) { if (c && typeof c === 'object') c.parent = null; });
      node.children = [];
      node.append.apply(node, arguments);
    },
    remove: function () {
      if (!node.parent) return;
      const i = node.parent.children.indexOf(node);
      if (i >= 0) node.parent.children.splice(i, 1);
      node.parent = null;
    },
    addEventListener: function (type, fn) {
      if (!node._listeners[type]) node._listeners[type] = [];
      node._listeners[type].push(fn);
    },
    click: function () {
      if (node.disabled) return;
      const list = (node._listeners.click || []).slice();
      list.forEach(function (fn) { fn({ type: 'click', target: node }); });
    },
    setAttribute: function (k, v) { node._attrs[k] = String(v); },
    getAttribute: function (k) { return Object.prototype.hasOwnProperty.call(node._attrs, k) ? node._attrs[k] : null; }
  };
  return node;
}

function byClass(node, cls) {
  const out = [];
  (function walk(n) {
    if (!n || typeof n === 'string') return;
    const cn = n.className || '';
    if ((' ' + cn + ' ').indexOf(' ' + cls + ' ') >= 0) out.push(n);
    (n.children || []).forEach(walk);
  })(node);
  return out;
}

function byTag(node, tag) {
  const want = String(tag).toUpperCase();
  const out = [];
  (function walk(n) {
    if (!n || typeof n === 'string') return;
    if (n.tagName === want) out.push(n);
    (n.children || []).forEach(walk);
  })(node);
  return out;
}

function textOf(node) {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node;
  let s = typeof node.textContent === 'string' ? node.textContent : '';
  (node.children || []).forEach(function (c) { s += textOf(c); });
  return s;
}

/* ================================================================ 假 localStorage / 沙箱 */

function makeStorage() {
  const map = Object.create(null);
  return {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null; },
    setItem: function (k, v) { map[k] = String(v); },
    removeItem: function (k) { delete map[k]; },
    key: function (i) { return Object.keys(map)[i] === undefined ? null : Object.keys(map)[i]; },
    get length() { return Object.keys(map).length; }
  };
}

function makeConfig(on) {
  return {
    model: 'test-model',
    maxTokens: { explain: 111, explainRetry: 333, tutor: 222 },
    isConfigured: function () { return on !== false; }
  };
}

/** 可编程网关：postOnce(body) 立刻按 responder(body, index) 回包。 */
function makeGateway(responder) {
  const calls = [];
  return {
    calls: calls,
    postOnce: function (body) {
      calls.push(body);
      let value;
      try { value = responder(body, calls.length); } catch (e) { return Promise.reject(e); }
      return Promise.resolve(value);
    }
  };
}

/** 手动回包的网关：让请求停在飞行中，由测试决定何时回包（模拟慢网）。 */
function makeManualGateway() {
  const calls = [];
  let pending = [];
  return {
    calls: calls,
    postOnce: function (body) {
      calls.push(body);
      return new Promise(function (resolve) { pending.push(resolve); });
    },
    resolveAll: function (value) {
      const list = pending;
      pending = [];
      list.forEach(function (resolve) { resolve(value); });
    }
  };
}

function dataOf(text) {
  return { choices: [{ message: { content: text } }] };
}

function loadModule(storage, config, gateway, opts) {
  const o = opts || {};
  const sandbox = {
    console: console,
    setTimeout: typeof o.setTimeout === 'function' ? o.setTimeout : setTimeout,
    clearTimeout: typeof o.clearTimeout === 'function' ? o.clearTimeout : clearTimeout
  };
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  sandbox.document = { createElement: function (tag) { return makeNode(tag); } };
  sandbox.localStorage = storage;
  sandbox.CnmTopicExplain = require('../diagnose/topic-explain.js');
  sandbox.LLMConfig = config;
  sandbox.DiagLLMGateway = gateway;
  sandbox.fetch = function () { throw new Error('不许发真网络'); };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(MODULE_PATH, 'utf8'), sandbox, { filename: MODULE_PATH });
  return sandbox;
}

function flush() {
  return new Promise(function (resolve) { setTimeout(resolve, 0); });
}

/* 记录型假定时器：记下 ms 后异步（微任务）执行回调，用来验证退避延迟与调用次数。 */
function makeFakeTimers() {
  const delays = [];
  return {
    delays: delays,
    setTimeout: function (fn, ms) {
      delays.push(ms);
      Promise.resolve().then(fn);
      return delays.length;
    },
    clearTimeout: function () { /* 测试里不需要真正取消 */ }
  };
}

function topic(id, name, grade) {
  return { id: id, name: name || id, grade: grade || 3, subject: 'math' };
}

function ctxOf(t, questions, deps, topics) {
  return { topic: t, questions: questions || [], deps: deps || [], topics: topics || [t] };
}

function autoCtx(t, questions, deps, topics) {
  var ctx = ctxOf(t, questions, deps, topics);
  ctx.autostart = true;
  return ctx;
}

const SEG = { what: '甲\n乙', why: '丙', how: '1. 第一步\n2. 第二步', demo: '一共有几个苹果？\n先数一数。\n答案：3 个', trap: '丁' };
const SEG_JSON = JSON.stringify(SEG);
const REPLY = '好的，先说题意。';

/* ================================================================ 源码提取（注释 / 字符串里的括号不算） */

function scan(src, keepStrings) {
  let out = '';
  let i = 0;
  let state = 'code';
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (state === 'code') {
      if (c === '/' && n === '/') { out += '  '; i += 2; state = 'line'; continue; }
      if (c === '/' && n === '*') { out += '  '; i += 2; state = 'block'; continue; }
      if (c === "'" || c === '"' || c === '`') { out += c; i++; state = c; continue; }
      out += c; i++; continue;
    }
    if (state === 'line') {
      if (c === '\n') { out += c; state = 'code'; } else { out += ' '; }
      i++; continue;
    }
    if (state === 'block') {
      if (c === '*' && n === '/') { out += '  '; i += 2; state = 'code'; continue; }
      out += (c === '\n' ? c : ' ');
      i++; continue;
    }
    if (c === '\\') { out += keepStrings ? c + (n || '') : '  '; i += 2; continue; }
    if (c === state) { out += c; i++; state = 'code'; continue; }
    out += keepStrings ? c : (c === '\n' ? c : ' ');
    i++;
  }
  return out;
}

const CODE_ONLY = scan(APP, false);

function extractFunction(name) {
  const re = new RegExp('function\\s+' + name + '\\s*\\(');
  const m = re.exec(CODE_ONLY);
  assert.ok(m, 'explore/app.js 里找不到函数 ' + name);
  const open = CODE_ONLY.indexOf('{', m.index + m[0].length - 1);
  assert.ok(open >= 0, '找不到 ' + name + ' 的起始花括号');
  let depth = 0;
  for (let i = open; i < CODE_ONLY.length; i++) {
    const c = CODE_ONLY[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return APP.slice(m.index, i + 1);
    }
  }
  throw new Error(name + ' 的花括号不配对');
}

function aiScriptsFromSource() {
  const decl = /var\s+AI_SCRIPTS\s*=\s*\[([\s\S]*?)\]/.exec(APP);
  assert.ok(decl, 'explore/app.js 里找不到 AI_SCRIPTS 数组声明');
  const files = [];
  const lit = /['"]([^'"]+)['"]/g;
  let m;
  while ((m = lit.exec(decl[1])) !== null) files.push(m[1]);
  return files;
}

/* 卡I：mountTopicAI 依赖模块级登记表 taiHosts，沙箱里必须把它和函数一起装进去。 */
function mountTopicAISource() {
  const m = /var\s+taiHosts\s*=\s*\{\s*\}\s*;/.exec(CODE_ONLY);
  assert.ok(m, 'explore/app.js 里找不到 taiHosts 登记表声明');
  return m[0] + '\n' + extractFunction('mountTopicAI');
}

const EXPECTED_SCRIPTS = ['../diagnose/textfmt.js', '../diagnose/topic-explain.js',
  '../diagnose/llm-config.js', '../diagnose/llm-gateway.js', 'topic-ai.js'];

/* ================================================================ 1. 点击前零加载 / 点击后按序 */

testAsync('1. 点击前 Lazy.load 零调用；点击后恰好一次、参数严格等于 5 个路径；resolve 后 mount 且 autostart === true', async function () {
  const scripts = aiScriptsFromSource();
  assert.deepStrictEqual(scripts, EXPECTED_SCRIPTS, 'AI_SCRIPTS 必须严格等于卡面 §2 的 5 个路径且顺序一致');

  const sandbox = {
    questionsByTopic: new Map(),
    deps: [],
    topics: [],
    document: { createElement: function (tag) { return makeNode(tag); } },
    console: console,
    Promise: Promise
  };
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  function sandboxEl(tag, attrs) {
    const node = makeNode(tag);
    const a = attrs || {};
    Object.keys(a).forEach(function (k) {
      if (a[k] === null || a[k] === false) return;
      if (k === 'class') node.className = a[k];
      else if (k === 'text') node.textContent = a[k];
      else node.setAttribute(k, a[k]);
    });
    for (let i = 2; i < arguments.length; i++) node.append(arguments[i]);
    return node;
  }
  sandbox.el = sandboxEl;
  sandbox.Lazy = { load: function (list) { sandbox.__lazyCalls.push(list.slice()); return sandbox.__lazyPromise; } };
  sandbox.AI_SCRIPTS = scripts;
  sandbox.__lazyCalls = [];
  let resolveLazy;
  sandbox.__lazyPromise = new Promise(function (resolve) { resolveLazy = resolve; });
  const mountCalls = [];
  sandbox.CnmTopicAI = null;

  vm.createContext(sandbox);
  vm.runInContext(mountTopicAISource(), sandbox, { filename: 'explore/app.js#mountTopicAI' });

  const box = makeNode('div');
  const t = topic('cnm_sw', '甲');
  sandbox.mountTopicAI(box, t);

  assert.strictEqual(sandbox.__lazyCalls.length, 0, '点击前 Lazy.load 必须零调用（首屏不加载）');
  const btn = byClass(box, 'tai-btn')[0];
  assert.ok(btn, '点击前必须先出现「让 AI 讲一遍」按钮');
  assert.strictEqual(textOf(btn), '让 AI 讲一遍');

  sandbox.CnmTopicAI = { mount: function (b, ctx) { mountCalls.push({ box: b, ctx: ctx }); } };
  btn.click();

  assert.strictEqual(sandbox.__lazyCalls.length, 1, '点击后 Lazy.load 恰好调用一次');
  assert.deepStrictEqual(sandbox.__lazyCalls[0], EXPECTED_SCRIPTS, '懒加载顺序必须与卡面 §2 一致');
  assert.strictEqual(mountCalls.length, 0, '脚本还没 resolve，先不能 mount');

  resolveLazy();
  await flush();

  assert.strictEqual(mountCalls.length, 1, '加载 resolve 后应调用一次 CnmTopicAI.mount');
  assert.strictEqual(mountCalls[0].ctx.autostart, true, '自动开讲：mount 时 autostart 必须为 true');
});

/* ================================================================ 2. 未配模型 */

testAsync('2. isConfigured() === false：postOnce / fetch 零调用，渲染「还没配置模型」+ 设置链接', async function () {
  const storage = makeStorage();
  const gateway = makeGateway(function () { return dataOf(SEG_JSON); });
  const mod = loadModule(storage, makeConfig(false), gateway);
  let fetchCalls = 0;
  mod.fetch = function () { fetchCalls++; throw new Error('不许发真网络'); };

  const box = makeNode('div');
  mod.CnmTopicAI.mount(box, autoCtx(topic('cnm_nc', '未配')));
  await flush();

  assert.strictEqual(gateway.calls.length, 0, '未配模型时 postOnce 必须零调用');
  assert.strictEqual(fetchCalls, 0, '未配模型时 fetch 必须零调用');
  const p = byClass(box, 'tai-noconfig')[0];
  assert.ok(p, '应渲染 .tai-noconfig');
  assert.ok(textOf(p).indexOf('还没配置模型') >= 0, '整段文字应含「还没配置模型」');
  const a = byTag(p, 'a')[0];
  assert.ok(a, '应包含设置链接');
  assert.strictEqual(a.getAttribute('href'), '../diagnose/settings.html');
  assert.strictEqual(textOf(a), '设置');
});

/* ================================================================ 3. 成功路径 */

testAsync('3. 成功：5 段齐全；how 有 ol 且去双序号；demo 有题面 / 分步 / 折叠答案；badge 文案严格', async function () {
  const storage = makeStorage();
  const gateway = makeGateway(function () { return dataOf(SEG_JSON); });
  const mod = loadModule(storage, makeConfig(true), gateway);

  const box = makeNode('div');
  const t = topic('cnm_ok', '加法');
  mod.CnmTopicAI.mount(box, autoCtx(t));
  await flush();

  const segs = byClass(box, 'tai-seg');
  assert.strictEqual(segs.length, 5, '必须渲染 5 个 .tai-seg');
  assert.deepStrictEqual(segs.map(function (s) { return textOf(byClass(s, 'tai-seg-title')[0]); }),
    ['这是什么', '为什么要学', '怎么做', '看个例子', '容易错的地方'], '5 段标题顺序必须固定');

  const how = segs[2];
  const ols = byTag(how, 'ol');
  assert.strictEqual(ols.length, 1, 'how 段应有 ol');
  const lis = byTag(ols[0], 'li');
  assert.strictEqual(lis.length, 2, 'how 段 li 数应为 2');
  assert.strictEqual(textOf(lis[0]), '第一步', 'how 的 li 文本不能带「1.」前缀');
  assert.ok(textOf(lis[0]).indexOf('1.') < 0, 'how 的 li 文本不含 1.');

  const demo = segs[3];
  assert.strictEqual(textOf(byClass(demo, 'tai-q')[0]), '一共有几个苹果？', 'demo 题面应是含问号的那行');
  const details = byTag(demo, 'details')[0];
  assert.ok(details, 'demo 段应有 details 折叠答案');
  assert.strictEqual(textOf(byTag(details, 'summary')[0]), '查看答案', 'summary 文字应为「查看答案」');
  assert.ok(textOf(details).indexOf('答案：3 个') >= 0, '折叠块应含答案正文');

  const badge = byClass(box, 'tai-badge')[0];
  assert.strictEqual(textOf(badge), BADGE, 'badge 文案必须严格为「AI 生成 · 未经人工审核」');
  assert.ok(byClass(box, 'tai-again').length === 1, '应有「换个说法重讲」按钮');
});

/* ================================================================ 3b. demo 步骤列表：容器不出 marker / 模型序号原样保留
 *
 * 卡 t_ae6eeac0：真浏览器里 <ol class="tai-steps"> 自己画 1./2./3.，模型在 demo 段也写
 * 「1. 」，屏幕上成了「1. 1. 看清条件」。口径是「容器渲染不出序号、模型序号原样保留」，
 * 不是「砍模型序号」。textContent 看不到容器 marker（marker 不是文本节点），所以这里既断言
 * li 文本逐字等于原文，也断言步骤容器带了 tai-steps-plain（真机 list-style 在 §5 验）。 */

function mountDemo(segObj) {
  const storage = makeStorage();
  const gateway = makeGateway(function () { return dataOf(JSON.stringify(segObj)); });
  const mod = loadModule(storage, makeConfig(true), gateway);
  const box = makeNode('div');
  mod.CnmTopicAI.mount(box, autoCtx(topic('cnm_demo_plain', '示例')));
  return { box: box, flushIt: flush() };
}

function demoSegOf(box) {
  const demo = byClass(box, 'tai-seg-demo')[0];
  assert.ok(demo, '应有 .tai-seg-demo 段');
  return demo;
}

testAsync('3b-1. demo：step 原文带「1. 」→ li textContent 逐字等于原文（前缀保留，不被砍）', async function () {
  const STEP = '1. 看清条件：容器是密闭的，氧气也在容器内';
  const m = mountDemo({ what: '甲', why: '乙', how: '1. 第一步\n2. 第二步',
    demo: '盘子里一共有几个苹果？\n' + STEP + '\n答案：3 个', trap: '丁' });
  await m.flushIt;

  const demo = demoSegOf(m.box);
  const ol = byTag(demo, 'ol')[0];
  assert.ok(ol, 'demo 段应有 ol 步骤列表');
  const lis = byTag(ol, 'li');
  assert.strictEqual(lis.length, 1, 'demo 段应只有 1 个步骤 li（答案行不进步骤列表）');
  assert.strictEqual(textOf(lis[0]), STEP, '模型手写的「1. 」必须原样保留');
});

testAsync('3b-2. demo：`2、` / `3)` / `（4）` 三种写法各自逐字保留（证明没走 stripOrder）', async function () {
  const ROWS = ['2、先看总数', '3) 再减去用掉的', '（4）最后核对'];
  const m = mountDemo({ what: '甲', why: '乙', how: '1. 第一步',
    demo: '他有几支笔？\n' + ROWS.join('\n') + '\n答案：3 支', trap: '丁' });
  await m.flushIt;

  const lis = byTag(byTag(demoSegOf(m.box), 'ol')[0], 'li');
  assert.deepStrictEqual(lis.map(textOf), ROWS, '三种手写序号都逐字保留');
});

testAsync('3b-3. demo：步骤容器带 tai-steps-plain（且保留 tai-steps）；how 段不带这个类', async function () {
  const m = mountDemo({ what: '甲', why: '乙', how: '1. 第一步\n2. 第二步',
    demo: '一共有几个？\n先数一数\n答案：3 个', trap: '丁' });
  await m.flushIt;

  const demoOl = byTag(demoSegOf(m.box), 'ol')[0];
  const cls = ' ' + String(demoOl.className) + ' ';
  assert.ok(cls.indexOf(' tai-steps ') >= 0, 'demo 步骤容器仍须带 tai-steps（保住间距/行高）');
  assert.ok(cls.indexOf(' tai-steps-plain ') >= 0, 'demo 步骤容器须带 tai-steps-plain（容器不出 marker）');

  const howOl = byTag(byClass(m.box, 'tai-seg-how')[0], 'ol')[0];
  assert.ok(howOl, 'how 段应有 ol');
  assert.ok((' ' + String(howOl.className) + ' ').indexOf(' tai-steps-plain ') < 0,
    'how 段不许带 tai-steps-plain（它还要靠 <ol> 画 1./2./3.）');
});

testAsync('3b-4. demo：「查看答案」仍在 details 里，答案行不进步骤列表', async function () {
  const m = mountDemo({ what: '甲', why: '乙', how: '1. 第一步',
    demo: '一共有几个？\n1. 先数一数\n答案：3 个', trap: '丁' });
  await m.flushIt;

  const demo = demoSegOf(m.box);
  const details = byTag(demo, 'details')[0];
  assert.ok(details, 'demo 段应有 details 折叠答案');
  assert.strictEqual(textOf(byTag(details, 'summary')[0]), '查看答案');
  assert.ok(textOf(details).indexOf('答案：3 个') >= 0, '答案正文应在 details 里');
  const lis = byTag(byTag(demo, 'ol')[0], 'li');
  assert.deepStrictEqual(lis.map(textOf), ['1. 先数一数'], '答案行不许混进步骤列表');
});

testAsync('3b-5. 回归：how 段 4 行仍是 4 个 li，且 li 文本不带行首手写序号（stripOrder 未带偏）', async function () {
  const m = mountDemo({ what: '甲', why: '乙',
    how: '1. 先看题目\n2. 找到已知\n3. 列式计算\n4. 回头检查',
    demo: '一共有几个？\n先数一数\n答案：3 个', trap: '丁' });
  await m.flushIt;

  const lis = byTag(byTag(byClass(m.box, 'tai-seg-how')[0], 'ol')[0], 'li');
  assert.strictEqual(lis.length, 4, 'how 段 4 行应仍是 4 个 li');
  assert.deepStrictEqual(lis.map(textOf), ['先看题目', '找到已知', '列式计算', '回头检查'],
    'how 段的行首序号仍必须被 stripOrder 去掉');
});

/* ================================================================ 4. 闸门拒绝 + 重试 */

testAsync('4. 被闸门拒：可见失败文案 + 重试；失败轮不写讲解缓存 / 对话', async function () {
  const storage = makeStorage();
  const gateway = makeGateway(function (body, n) {
    return n === 1 ? dataOf('这不是 JSON') : dataOf(SEG_JSON);
  });
  const mod = loadModule(storage, makeConfig(true), gateway);

  const box = makeNode('div');
  mod.CnmTopicAI.mount(box, autoCtx(topic('cnm_gate', '闸门')));
  await flush();

  assert.strictEqual(byClass(box, 'tai-seg').length, 0, '被拒时不能出现 5 段');
  const gate = byClass(box, 'tai-gate')[0];
  assert.ok(gate, '应渲染 .tai-gate');
  assert.strictEqual(textOf(gate), '这条没通过自动校验（格式没成形），换一次试试', '闸门文案必须严格');
  const retry = byClass(box, 'tai-retry')[0];
  assert.ok(retry, '应有重试按钮');
  assert.strictEqual(gateway.calls.length, 1);

  let explainKeys = 0;
  let chatKeys = 0;
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k.indexOf('cnmDiagnose.topicExplain.v1.chat.') === 0) chatKeys++;
    else if (k.indexOf('cnmDiagnose.topicExplain.v1:') === 0) explainKeys++;
  }
  assert.strictEqual(explainKeys, 0, '失败轮不许写讲解缓存');
  assert.strictEqual(chatKeys, 0, '失败轮不许写对话');

  retry.click();
  await flush();
  assert.strictEqual(gateway.calls.length, 2, '点重试应再发一次');
  assert.strictEqual(byClass(box, 'tai-seg').length, 5, '重试成功后应出现 5 段');
});

/* ================================================================ 4b. 网关 resolve null（失败/超时） */

testAsync('网关 resolve null（失败/超时）→ 显示取不到讲解的错误行，不显示「格式没成形」，不写缓存', async function () {
  const storage = makeStorage();
  const gateway = makeGateway(function (body, n) {
    return n === 1 ? null : dataOf(SEG_JSON);
  });
  const mod = loadModule(storage, makeConfig(true), gateway);

  const box = makeNode('div');
  mod.CnmTopicAI.mount(box, ctxOf(topic('cnm_null', '超时')));
  byClass(box, 'tai-btn')[0].click();
  await flush();

  const err = byClass(box, 'tai-error')[0];
  assert.ok(err, '网关失败应渲染 .tai-error');
  assert.strictEqual(textOf(err), '这次没取到讲解，点重试再来一次', '错误行文案必须严格');
  assert.strictEqual(byClass(box, 'tai-gate').length, 0, '网关失败不该出现 .tai-gate');
  assert.ok(textOf(box).indexOf('没通过自动校验') < 0, '整段文字不应含「没通过自动校验」');
  assert.strictEqual(byClass(box, 'tai-seg').length, 0, '失败时不该出现 5 段');

  let explainKeys = 0;
  for (let i = 0; i < storage.length; i++) {
    if (storage.key(i).indexOf('cnmDiagnose.topicExplain.v1:') === 0) explainKeys++;
  }
  assert.strictEqual(explainKeys, 0, '网关失败不许写讲解缓存');

  byClass(box, 'tai-retry')[0].click();
  await flush();
  assert.strictEqual(gateway.calls.length, 2, '点重试应再发一次');
  assert.strictEqual(byClass(box, 'tai-seg').length, 5, '重试成功后应出现 5 段（可恢复）');
});

/* ================================================================ 5. 追问 */

testAsync('5. 追问：学生 / 老师气泡；10 轮后禁用 + 清空；第 11 轮不再发', async function () {
  const storage = makeStorage();
  const gateway = makeGateway(function (body, n) {
    return n === 1 ? dataOf(SEG_JSON) : dataOf(REPLY);
  });
  const mod = loadModule(storage, makeConfig(true), gateway);

  const box = makeNode('div');
  mod.CnmTopicAI.mount(box, autoCtx(topic('cnm_chat', '加法')));
  await flush();

  let input = byClass(box, 'tai-input')[0];
  let send = byClass(box, 'tai-send')[0];
  input.value = '为什么这样算？';
  send.click();
  await flush();

  assert.strictEqual(byClass(box, 'tai-bubble-student').length, 1, '应有一个学生气泡');
  assert.strictEqual(byClass(box, 'tai-bubble-teacher').length, 1, '应有一个老师气泡');
  assert.ok(byClass(byClass(box, 'tai-bubble-teacher')[0], 'tai-badge').length >= 1, '老师气泡底部应有 badge');

  for (let round = 2; round <= 10; round++) {
    input = byClass(box, 'tai-input')[0];
    send = byClass(box, 'tai-send')[0];
    input.value = '第 ' + round + ' 问？';
    send.click();
    await flush();
  }

  input = byClass(box, 'tai-input')[0];
  send = byClass(box, 'tai-send')[0];
  assert.strictEqual(input.disabled, true, '10 轮后输入框应 disabled');
  assert.strictEqual(send.disabled, true, '10 轮后发送按钮应 disabled');
  assert.ok(byClass(box, 'tai-clear').length === 1, '10 轮后应出现「清空对话」');

  const before = gateway.calls.length;
  const bubblesBefore = byClass(box, 'tai-bubble').length;
  input.value = '还想再问？';
  send.click();
  await flush();
  assert.strictEqual(gateway.calls.length, before, '第 11 轮不许再发请求');
  assert.strictEqual(byClass(box, 'tai-bubble').length, bubblesBefore, '第 11 轮气泡数不变');
});

/* ================================================================ 6. 切换 topic 再切回 */

testAsync('6. 切换 topic 再切回：各生成一次、切回不重发且 5 段还在', async function () {
  const storage = makeStorage();
  const gateway = makeGateway(function () { return dataOf(SEG_JSON); });
  const mod = loadModule(storage, makeConfig(true), gateway);

  const a = topic('cnm_a', 'A');
  const b = topic('cnm_b', 'B');
  const boxA = makeNode('div');
  const boxB = makeNode('div');

  mod.CnmTopicAI.mount(boxA, autoCtx(a, [], [], [a, b]));
  await flush();
  mod.CnmTopicAI.mount(boxB, autoCtx(b, [], [], [a, b]));
  await flush();
  assert.strictEqual(gateway.calls.length, 2, 'A、B 各生成一次');

  mod.CnmTopicAI.mount(boxA, autoCtx(a, [], [], [a, b]));
  await flush();
  assert.strictEqual(gateway.calls.length, 2, '切回 A 不许重发');
  assert.strictEqual(byClass(boxA, 'tai-seg').length, 5, '切回 A 后 5 段仍在');
});

/* ================================================================ 7. 缓存命中 */

testAsync('7. 缓存命中：新模块实例 + 同一 storage，点击后零 postOnce、直接出 5 段', async function () {
  const storage = makeStorage();

  const g1 = makeGateway(function () { return dataOf(SEG_JSON); });
  const m1 = loadModule(storage, makeConfig(true), g1);
  const t = topic('cnm_cache', '缓存');
  const box1 = makeNode('div');
  m1.CnmTopicAI.mount(box1, autoCtx(t));
  await flush();
  assert.strictEqual(g1.calls.length, 1, '首次生成应调用一次 postOnce');
  assert.strictEqual(byClass(box1, 'tai-seg').length, 5);

  const g2 = makeGateway(function () { return dataOf(SEG_JSON); });
  const m2 = loadModule(storage, makeConfig(true), g2);
  const box2 = makeNode('div');
  m2.CnmTopicAI.mount(box2, ctxOf(t));
  await flush();
  assert.strictEqual(byClass(box2, 'tai-seg').length, 0, '未点击时应是 idle 按钮，不直接渲染');
  byClass(box2, 'tai-btn')[0].click();
  await flush();
  assert.strictEqual(g2.calls.length, 0, '缓存命中时 postOnce 必须零调用');
  assert.strictEqual(byClass(box2, 'tai-seg').length, 5, '缓存命中应直接渲染 5 段');
});

/* ================================================================ 7b. 截断自动重发（卡 D） */

/* 截断响应：网关把 reasoning 计入 max_tokens，推理久的那些次正文一个字都没有。 */
const TRUNCATED = { choices: [{ finish_reason: 'length', message: { content: '' } }] };

function explainCacheKeys(storage) {
  let n = 0;
  for (let i = 0; i < storage.length; i++) {
    if (storage.key(i).indexOf('cnmDiagnose.topicExplain.v1:') === 0) n++;
  }
  return n;
}

testAsync('7b. 首次 finish=length、第二次合规 → 恰好 2 次请求（同 messages、首答 explain / 重发 explainRetry）、5 段上屏、缓存已写', async function () {
  const storage = makeStorage();
  const gateway = makeGateway(function (body, n) {
    return n === 1 ? TRUNCATED : dataOf(SEG_JSON);
  });
  const mod = loadModule(storage, makeConfig(true), gateway);

  const box = makeNode('div');
  mod.CnmTopicAI.mount(box, autoCtx(topic('cnm_refetch_ok', '截断重发')));
  await flush();

  assert.strictEqual(gateway.calls.length, 2, '首次被截断 → 只重发 1 次（共 2 次请求）');
  assert.deepStrictEqual(gateway.calls[1].messages, gateway.calls[0].messages, '重发必须用同样的 messages');
  assert.strictEqual(gateway.calls[0].max_tokens, 111, '首答 max_tokens 取自配置的 maxTokens.explain');
  assert.strictEqual(gateway.calls[1].max_tokens, 333, '截断重发必须升档到 maxTokens.explainRetry（卡 H）');
  assert.strictEqual(gateway.calls[1].model, gateway.calls[0].model, '重发沿用同一个 model');

  assert.strictEqual(byClass(box, 'tai-seg').length, 5, '重发成功后讲解应正常上屏');
  assert.strictEqual(byClass(box, 'tai-gate').length, 0, '重发成功不该出现「格式没成形」');
  assert.strictEqual(byClass(box, 'tai-error').length, 0, '重发成功不该出现取不到讲解');
  assert.strictEqual(explainCacheKeys(storage), 1, '拿到合规 5 段后应写入讲解缓存');
});

testAsync('7c. 两次都 finish=length → 恰好 2 次请求（不是 3 次）、显示「格式没成形」、缓存未写', async function () {
  const storage = makeStorage();
  const gateway = makeGateway(function () { return TRUNCATED; });
  const mod = loadModule(storage, makeConfig(true), gateway);

  const box = makeNode('div');
  mod.CnmTopicAI.mount(box, autoCtx(topic('cnm_refetch_bad', '两次都截断')));
  await flush();

  assert.strictEqual(gateway.calls.length, 2, '最多重发 1 次：两次都截断也只能是 2 次请求（不许 while 循环）');
  assert.strictEqual(gateway.calls[0].max_tokens, 111, '首答仍用 explain');
  assert.strictEqual(gateway.calls[1].max_tokens, 333, '截断重发仍升档到 explainRetry（卡 H）');
  assert.strictEqual(byClass(box, 'tai-seg').length, 0, '两次都截断不能出现 5 段');
  const gate = byClass(box, 'tai-gate')[0];
  assert.ok(gate, '应渲染 .tai-gate');
  assert.strictEqual(textOf(gate), '这条没通过自动校验（格式没成形），换一次试试', '页面文案不变');
  assert.ok(byClass(box, 'tai-retry').length === 1, '应给可见重试按钮');
  assert.strictEqual(textOf(box).indexOf('正在重试'), -1, '不许给用户加「正在重试」的技术噪音');
  assert.strictEqual(explainCacheKeys(storage), 0, '重发失败不写缓存');
});

/* 卡 H：配置里没有 explainRetry（老配置 / 外部注入）时，重发回落 explain，不许发 undefined。 */
testAsync('卡H-回落. 配置缺 explainRetry 时，截断重发回落 explain（仍恰好 2 次）', async function () {
  const storage = makeStorage();
  const gateway = makeGateway(function (body, n) {
    return n === 1 ? TRUNCATED : dataOf(SEG_JSON);
  });
  const cfg = makeConfig(true);
  delete cfg.maxTokens.explainRetry;
  const mod = loadModule(storage, cfg, gateway);

  const box = makeNode('div');
  mod.CnmTopicAI.mount(box, autoCtx(topic('cnm_refetch_nofallback', '缺档位回落')));
  await flush();

  assert.strictEqual(gateway.calls.length, 2, '仍然只重发 1 次');
  assert.strictEqual(gateway.calls[0].max_tokens, 111, '首答 explain');
  assert.strictEqual(gateway.calls[1].max_tokens, 111, '缺 explainRetry 时重发回落 explain（不发 undefined）');
  assert.strictEqual(byClass(box, 'tai-seg').length, 5, '回落也应能上屏');
});

/* ================================================================ 7d. 网关错误体（卡 E） */

const GW_ERR = { retCode: 9 };

testAsync('卡E-1. 首次网关错误体、第二次正常 → 2 次请求、800ms 退避恰好 1 次、5 段上屏、缓存已写', async function () {
  const storage = makeStorage();
  const timers = makeFakeTimers();
  const gateway = makeGateway(function (body, n) {
    return n === 1 ? GW_ERR : dataOf(SEG_JSON);
  });
  const mod = loadModule(storage, makeConfig(true), gateway, timers);

  const box = makeNode('div');
  mod.CnmTopicAI.mount(box, autoCtx(topic('cnm_gw_ok', '网关恢复')));
  await flush();
  await flush();

  assert.strictEqual(gateway.calls.length, 2, '网关错误只重发 1 次（共 2 次请求）');
  assert.deepStrictEqual(gateway.calls[1].messages, gateway.calls[0].messages, '重发必须用同样的 messages');
  assert.strictEqual(gateway.calls[0].max_tokens, 111, '网关错误那次的首次请求用 explain');
  assert.strictEqual(gateway.calls[1].max_tokens, 111, '网关错误的退避重发仍用 explain（跟预算无关，不升档）');
  assert.deepStrictEqual(timers.delays, [800], '退避延迟必须恰好 800ms 且只调用 1 次');
  assert.strictEqual(byClass(box, 'tai-seg').length, 5, '重发成功后讲解应正常上屏');
  assert.ok(byClass(box, 'tai-gate').length === 0, '不该出现「格式没成形」');
  assert.ok(explainCacheKeys(storage) >= 1, '拿到合规 5 段后应写入讲解缓存');
});

testAsync('卡E-2. 两次都网关错误 → 2 次请求（不是 3）、显示「暂时没接通」、缓存未写、无对话输入框', async function () {
  const storage = makeStorage();
  const timers = makeFakeTimers();
  const gateway = makeGateway(function () { return GW_ERR; });
  const mod = loadModule(storage, makeConfig(true), gateway, timers);

  const box = makeNode('div');
  mod.CnmTopicAI.mount(box, autoCtx(topic('cnm_gw_bad', '一直网关错误')));
  await flush();
  await flush();

  assert.strictEqual(gateway.calls.length, 2, '合计最多 2 次请求（不是 3 次）');
  assert.ok(textOf(box).indexOf('暂时没接通') >= 0, '应出现「AI 老师那边暂时没接通…」文案');
  assert.strictEqual(explainCacheKeys(storage), 0, '网关错误不许写讲解缓存');
  assert.strictEqual(storage.length, 0, '网关错误不许写任何 storage 键');
  assert.strictEqual(byClass(box, 'tai-input').length, 0, 'gwerror 下不出现对话输入框');
  assert.strictEqual(byClass(box, 'tai-error').length, 1, '应使用既有的 tai-error 样式');
  const retry = byClass(box, 'tai-retry')[0];
  assert.ok(retry, '应给「再试一次」按钮');
  assert.strictEqual(textOf(retry), '再试一次', 'gwerror 按钮文案应为「再试一次」');
});

testAsync('卡E-3. 两次都网关错误时，页面不出现 retCode 字样', async function () {
  const storage = makeStorage();
  const gateway = makeGateway(function () { return GW_ERR; });
  const mod = loadModule(storage, makeConfig(true), gateway, makeFakeTimers());

  const box = makeNode('div');
  mod.CnmTopicAI.mount(box, autoCtx(topic('cnm_gw_text', '技术串不外泄')));
  await flush();
  await flush();

  assert.ok(textOf(box).indexOf('retCode') < 0, '学生可见文本不许出现 retCode');
});

testAsync('卡E-4. 首次网关错误、第二次截断 → 仍 2 次请求、落 gate（不是 gwerror）、不写缓存', async function () {
  const storage = makeStorage();
  const gateway = makeGateway(function (body, n) {
    return n === 1 ? GW_ERR : TRUNCATED;
  });
  const mod = loadModule(storage, makeConfig(true), gateway, makeFakeTimers());

  const box = makeNode('div');
  mod.CnmTopicAI.mount(box, autoCtx(topic('cnm_gw_then_trunc', '网关后截断')));
  await flush();
  await flush();

  assert.strictEqual(gateway.calls.length, 2, '网关错误重发后不再因截断重发（合计 2 次）');
  assert.ok(byClass(box, 'tai-gate').length === 1, '第 2 次是截断应落 gate');
  assert.strictEqual(byClass(box, 'tai-error').length, 0, '不应落 gwerror');
  assert.strictEqual(textOf(box).indexOf('暂时没接通'), -1);
  assert.strictEqual(explainCacheKeys(storage), 0, '不写缓存');
});

testAsync('卡E-5. 追问收到网关错误体 → 显示同一句文案、history 不增长', async function () {
  const storage = makeStorage();
  const gateway = makeGateway(function (body, n) {
    return n === 1 ? dataOf(SEG_JSON) : GW_ERR;
  });
  const mod = loadModule(storage, makeConfig(true), gateway);

  const box = makeNode('div');
  mod.CnmTopicAI.mount(box, autoCtx(topic('cnm_gw_chat', '追问网关')));
  await flush();

  const input = byClass(box, 'tai-input')[0];
  input.value = '为什么这样算？';
  byClass(box, 'tai-send')[0].click();
  await flush();

  assert.ok(textOf(box).indexOf('暂时没接通') >= 0, '追问失败应显示同一句「没接通」文案');
  assert.strictEqual(byClass(box, 'tai-bubble-teacher').length, 0, '网关错误不进 history（无老师气泡）');
  let chatKeys = 0;
  for (let i = 0; i < storage.length; i++) {
    if (storage.key(i).indexOf('cnmDiagnose.topicExplain.v1.chat.') === 0) chatKeys++;
  }
  assert.strictEqual(chatKeys, 0, '网关错误不写 history（无 chat 键）');
});

/* ================================================================ 卡I：首点竞态 / 早挂载 */

testAsync('卡I-1. 模块级早挂载：请求飞行中换盒子，回包画到新盒子、旧盒子 0 段、只发 1 次', async function () {
  const gateway = makeManualGateway();
  const mod = loadModule(makeStorage(), makeConfig(true), gateway);
  const t = topic('cnm_early', '早挂载');
  const boxA = makeNode('div');
  const boxB = makeNode('div');

  mod.CnmTopicAI.mount(boxA, autoCtx(t));
  assert.strictEqual(gateway.calls.length, 1, '首挂载应发起一次讲解请求');

  mod.CnmTopicAI.mount(boxB, ctxOf(t));
  assert.strictEqual(gateway.calls.length, 1, '请求飞行中换盒子（模拟 renderDetail 重建）不许再发');

  gateway.resolveAll(dataOf(SEG_JSON));
  await flush();

  assert.strictEqual(byClass(boxB, 'tai-seg').length, 5, '回包应画到当前登记的盒子（boxB）');
  assert.strictEqual(byClass(boxA, 'tai-seg').length, 0, '旧盒子不许出现 5 段');
  assert.strictEqual(gateway.calls.length, 1, '全程只发一次讲解请求');
});

testAsync('卡I-2. 模块级幂等：ready 后同步 mount 新盒子立刻 5 段，且讲解请求数不增加', async function () {
  const gateway = makeGateway(function () { return dataOf(SEG_JSON); });
  const mod = loadModule(makeStorage(), makeConfig(true), gateway);
  const t = topic('cnm_idem', '幂等');
  const boxA = makeNode('div');
  mod.CnmTopicAI.mount(boxA, autoCtx(t));
  await flush();
  assert.strictEqual(byClass(boxA, 'tai-seg').length, 5);

  const before = gateway.calls.length;
  const boxC = makeNode('div');
  mod.CnmTopicAI.mount(boxC, ctxOf(t));
  assert.strictEqual(byClass(boxC, 'tai-seg').length, 5, 'ready 后 mount 应同步立刻出 5 段');
  assert.strictEqual(gateway.calls.length, before, 'ready 后再挂载不许增加讲解请求');
});

testAsync('卡I-3. 模块级不重复：ready 后同一盒子连挂 3 次，5 段 / 1 个对话 / 1 个 badge', async function () {
  const gateway = makeGateway(function () { return dataOf(SEG_JSON); });
  const mod = loadModule(makeStorage(), makeConfig(true), gateway);
  const t = topic('cnm_rep', '不重复');
  const box = makeNode('div');
  mod.CnmTopicAI.mount(box, autoCtx(t));
  await flush();

  mod.CnmTopicAI.mount(box, ctxOf(t));
  mod.CnmTopicAI.mount(box, ctxOf(t));
  mod.CnmTopicAI.mount(box, ctxOf(t));

  assert.strictEqual(byClass(box, 'tai-seg').length, 5, '连挂 3 次仍是 5 段');
  assert.strictEqual(byClass(box, 'tai-chat').length, 1, '对话区只有 1 个（不叠加）');
  assert.strictEqual(byClass(box, 'tai-badge').length, 1, 'badge 只有 1 个（不叠加）');
});

testAsync('卡I-4. 首点竞态（app.js 级）：点击后重绘换盒子，加载完回包画到新盒子且用最新 ctx', async function () {
  const sandbox = {
    questionsByTopic: new Map(),
    deps: [],
    topics: [],
    document: { createElement: function (tag) { return makeNode(tag); } },
    console: console,
    Promise: Promise
  };
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  function sandboxEl(tag, attrs) {
    const node = makeNode(tag);
    const a = attrs || {};
    Object.keys(a).forEach(function (k) {
      if (a[k] === null || a[k] === false) return;
      if (k === 'class') node.className = a[k];
      else if (k === 'text') node.textContent = a[k];
      else node.setAttribute(k, a[k]);
    });
    for (let i = 2; i < arguments.length; i++) node.append(arguments[i]);
    return node;
  }
  sandbox.el = sandboxEl;
  sandbox.Lazy = { load: function () { return sandbox.__lazyPromise; } };
  sandbox.AI_SCRIPTS = aiScriptsFromSource();
  let resolveLazy;
  sandbox.__lazyPromise = new Promise(function (resolve) { resolveLazy = resolve; });
  sandbox.CnmTopicAI = null;

  vm.createContext(sandbox);
  vm.runInContext(mountTopicAISource(), sandbox, { filename: 'explore/app.js#mountTopicAI' });

  const t = topic('cnm_race', '竞态');
  const boxA = makeNode('div');
  sandbox.mountTopicAI(boxA, t);
  const btn = byClass(boxA, 'tai-btn')[0];
  assert.ok(btn, '未加载模块时应先出现「让 AI 讲一遍」按钮');

  btn.click();

  const boxB = makeNode('div');
  sandbox.questionsByTopic.set(t.id, [{ question: '新补的题？', answer: '3' }]);
  sandbox.mountTopicAI(boxB, t);

  const mountCalls = [];
  sandbox.CnmTopicAI = { mount: function (b, ctx) { mountCalls.push({ box: b, ctx: ctx }); } };
  resolveLazy();
  await flush();

  assert.strictEqual(mountCalls.length, 1, '加载 resolve 后恰好 mount 一次');
  assert.strictEqual(mountCalls[0].box, boxB, '必须画到现在登记的盒子（boxB），不是点击时捕获的 boxA');
  assert.strictEqual(mountCalls[0].ctx.autostart, true, '自动开讲：autostart 必须为 true');
  assert.strictEqual(mountCalls[0].ctx.questions.length, 1, '必须用最新一次的 ctx（含补进来的题）');
});

/* ================================================================ 卡S（t_1ff271ac）：你可能想问 chips
 * 口径：suggests 与 5 段同一次响应（第 6 键）；软校验只决定「有没有 chips」，
 * 不许影响 5 段渲染 / 不许报错 / 不许补请求；点一条 = 走同一条追问链路。 */

const SUG3 = ['这是什么意思？', '第二步为什么要进位？', '如果减不够怎么办？'];

function segJsonWith(suggests) {
  const obj = Object.assign({}, SEG);
  obj.suggests = suggests;
  return JSON.stringify(obj);
}

function cacheEntryOf(storage) {
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k && k.indexOf('cnmDiagnose.topicExplain.v1:') === 0) {
      return { key: k, value: JSON.parse(storage.getItem(k)) };
    }
  }
  return null;
}

testAsync('卡S-1. 响应没有 suggests → 无 chips、5 段照常、零报错（软校验不连坐）', async function () {
  const storage = makeStorage();
  const gateway = makeGateway(function () { return dataOf(SEG_JSON); });
  const mod = loadModule(storage, makeConfig(true), gateway);
  const box = makeNode('div');
  mod.CnmTopicAI.mount(box, autoCtx(topic('cnm_s1', '加法')));

  assert.strictEqual(byClass(box, 'tai-suggests').length, 0, '返回前不该有 chips 行');
  await flush();

  assert.strictEqual(gateway.calls.length, 1, '只发一次讲解请求');
  assert.strictEqual(byClass(box, 'tai-seg').length, 5, '5 段照常');
  assert.strictEqual(byClass(box, 'tai-suggests').length, 0, '没有 suggests 就不出 chips 行');
  assert.strictEqual(byClass(box, 'tai-suggest').length, 0);
  assert.strictEqual(byClass(box, 'tai-gate').length, 0, 'chips 缺失不许落 gate');
  assert.strictEqual(byClass(box, 'tai-error').length, 0, 'chips 缺失不许报错');
});

testAsync('卡S-2. 3 条合格 → 3 个 chip、文案逐字一致、位置在输入框上方；并随讲解进缓存', async function () {
  const storage = makeStorage();
  const gateway = makeGateway(function () { return dataOf(segJsonWith(SUG3)); });
  const mod = loadModule(storage, makeConfig(true), gateway);
  const box = makeNode('div');
  mod.CnmTopicAI.mount(box, autoCtx(topic('cnm_s2', '加法')));
  await flush();

  const rows = byClass(box, 'tai-suggests');
  assert.strictEqual(rows.length, 1, '应有一行 chips');
  assert.strictEqual(byClass(rows[0], 'tai-suggests-label').length, 1, '行首应带「你可能想问：」标签');
  assert.strictEqual(textOf(byClass(rows[0], 'tai-suggests-label')[0]), '你可能想问：');

  const chips = byClass(box, 'tai-suggest');
  assert.strictEqual(chips.length, 3, '3 条合格就该 3 个 chip');
  assert.deepStrictEqual(chips.map(textOf), SUG3, 'chip 文案必须与响应逐字一致、原序');

  /* 位置：同一 .tai-chat 里，chips 行在 .tai-ask 之前、5 段之后 */
  const chat = byClass(box, 'tai-chat')[0];
  assert.ok(chat, '应有对话容器');
  assert.ok(chat.children.indexOf(rows[0]) < chat.children.indexOf(byClass(box, 'tai-ask')[0]),
    'chips 必须在追问输入框上方');

  const hit = cacheEntryOf(storage);
  assert.ok(hit, '讲解应已写缓存');
  assert.deepStrictEqual(hit.value.suggests, SUG3, 'chips 与讲解同份缓存一起落盘（cacheKey 未变）');
});

testAsync('卡S-3. 点 chip → 该问题作为一条追问发出、chip 置灰不可再点、飞行中连点不重发', async function () {
  const storage = makeStorage();
  const gateway = makeManualGateway();
  const mod = loadModule(storage, makeConfig(true), gateway);
  const box = makeNode('div');
  mod.CnmTopicAI.mount(box, autoCtx(topic('cnm_s3', '加法')));
  gateway.resolveAll(dataOf(segJsonWith(SUG3)));
  await flush();

  assert.strictEqual(byClass(box, 'tai-suggest').length, 3);

  const chips = byClass(box, 'tai-suggest');
  chips[0].click();
  await flush();

  assert.strictEqual(gateway.calls.length, 2, '点 chip 应恰好多发一次追问请求');
  const asked = gateway.calls[1];
  assert.strictEqual(asked.max_tokens, 222, 'chip 追问必须复用 cfg.maxTokens.tutor');
  const contents = asked.messages.map(function (m) { return m.content; });
  assert.strictEqual(contents[contents.length - 1], SUG3[0], '本轮提问必须是点的那条');
  assert.strictEqual(contents.filter(function (c) { return c === SUG3[0]; }).length, 1, '同一问题只许出现一条');

  const after = byClass(box, 'tai-suggest');
  assert.strictEqual(after[0].disabled, true, '点过的那条应置灰（disabled）');
  assert.ok(after[0].className.indexOf('tai-suggest-used') >= 0, '点过的那条应带 tai-suggest-used');
  assert.strictEqual(after[1].disabled, false, '没点的那条不该被连坐');

  after[0].click();
  after[1].click();
  await flush();
  assert.strictEqual(gateway.calls.length, 2, '发送中连点 / 连点另一条都不许重发');

  gateway.resolveAll(dataOf(REPLY));
  await flush();
  assert.strictEqual(byClass(box, 'tai-bubble-student').length, 1, '应有 1 个学生气泡');
  assert.strictEqual(byClass(box, 'tai-bubble-teacher').length, 1, '应有 1 个老师气泡');
  assert.strictEqual(textOf(byClass(box, 'tai-bubble-student')[0]), SUG3[0], '气泡里就是点的那条');
  assert.strictEqual(byClass(box, 'tai-suggest').length, 0, '聊过一轮后 chips 收起');
});

testAsync('卡S-4. 已有 1 轮历史 → chips 不显示（5 段照常）', async function () {
  const storage = makeStorage();
  const gateway = makeGateway(function (body, n) {
    return n === 1 ? dataOf(segJsonWith(SUG3)) : dataOf(REPLY);
  });
  const mod = loadModule(storage, makeConfig(true), gateway);
  const box = makeNode('div');
  mod.CnmTopicAI.mount(box, autoCtx(topic('cnm_s4', '加法')));
  await flush();
  assert.strictEqual(byClass(box, 'tai-suggest').length, 3, '开讲时先给 chips');

  const input = byClass(box, 'tai-input')[0];
  input.value = '我自己问的？';
  byClass(box, 'tai-send')[0].click();
  await flush();

  assert.strictEqual(byClass(box, 'tai-seg').length, 5, '聊过之后 5 段还在');
  assert.strictEqual(byClass(box, 'tai-suggests').length, 0, '有历史就不再给 chips 行');
  assert.strictEqual(byClass(box, 'tai-suggest').length, 0);
});

testAsync('卡S-5. 老缓存条目（无 suggests 字段）→ 5 段正常、零请求、无 chips', async function () {
  const storage = makeStorage();
  const m1 = loadModule(storage, makeConfig(true), makeGateway(function () { return dataOf(SEG_JSON); }));
  const t = topic('cnm_s5', '老缓存');
  m1.CnmTopicAI.mount(makeNode('div'), autoCtx(t));
  await flush();

  /* 手工抹掉 suggests，模拟「改版前写下的缓存条目」 */
  const hit = cacheEntryOf(storage);
  assert.ok(hit, '前提：缓存已写');
  delete hit.value.suggests;
  storage.setItem(hit.key, JSON.stringify(hit.value));
  assert.strictEqual(Object.prototype.hasOwnProperty.call(JSON.parse(storage.getItem(hit.key)), 'suggests'), false);

  const g2 = makeGateway(function () { return dataOf(SEG_JSON); });
  const m2 = loadModule(storage, makeConfig(true), g2);
  const box2 = makeNode('div');
  m2.CnmTopicAI.mount(box2, ctxOf(t));
  byClass(box2, 'tai-btn')[0].click();
  await flush();

  assert.strictEqual(g2.calls.length, 0, '老缓存命中：零请求、不补一次要 chips');
  assert.strictEqual(byClass(box2, 'tai-seg').length, 5, '5 段正常');
  assert.strictEqual(byClass(box2, 'tai-suggest').length, 0, '没有 suggests 就不出 chips');
  assert.strictEqual(byClass(box2, 'tai-gate').length, 0);
  assert.strictEqual(byClass(box2, 'tai-error').length, 0);
});

testAsync('卡S-5b. 新缓存条目带 suggests → 零请求直接出 chips（不重发讲解）', async function () {
  const storage = makeStorage();
  const m1 = loadModule(storage, makeConfig(true), makeGateway(function () { return dataOf(segJsonWith(SUG3)); }));
  const t = topic('cnm_s5b', '新缓存');
  m1.CnmTopicAI.mount(makeNode('div'), autoCtx(t));
  await flush();

  const g2 = makeGateway(function () { return dataOf(SEG_JSON); });
  const m2 = loadModule(storage, makeConfig(true), g2);
  const box2 = makeNode('div');
  m2.CnmTopicAI.mount(box2, ctxOf(t));
  byClass(box2, 'tai-btn')[0].click();
  await flush();

  assert.strictEqual(g2.calls.length, 0, '缓存命中不许重发');
  assert.strictEqual(byClass(box2, 'tai-seg').length, 5);
  assert.deepStrictEqual(byClass(box2, 'tai-suggest').map(textOf), SUG3, '缓存里的 chips 也要照原样出来');
});

testAsync('卡S-6. suggests 全是垃圾（非数组 / 空问 / 标题 / 超长）→ 无 chips、5 段照常、不落 gate', async function () {
  const bads = ['这不是数组', ['你想知道什么？'], ['这是什么'], ['一'.repeat(21)]];
  for (let i = 0; i < bads.length; i++) {
    const storage = makeStorage();
    const gateway = makeGateway(function () { return dataOf(segJsonWith(bads[i])); });
    const mod = loadModule(storage, makeConfig(true), gateway);
    const box = makeNode('div');
    mod.CnmTopicAI.mount(box, autoCtx(topic('cnm_s6_' + i, '垃圾 chips')));
    await flush();

    assert.strictEqual(byClass(box, 'tai-seg').length, 5, '第 ' + i + ' 组：5 段必须照常');
    assert.strictEqual(byClass(box, 'tai-suggest').length, 0, '第 ' + i + ' 组：垃圾条目不该出 chip');
    assert.strictEqual(byClass(box, 'tai-gate').length, 0, '第 ' + i + ' 组：软校验不许落 gate');
    assert.strictEqual(gateway.calls.length, 1, '第 ' + i + ' 组：不许为 chips 重发');
  }
});

/* ================================================================ 8. 红线 */

test('8. 红线：topic-ai.js 无 innerHTML 一干；CSS 的 .tai- 选择器成规模', function () {
  const src = fs.readFileSync(MODULE_PATH, 'utf8');
  ['innerHTML', 'insertAdjacentHTML', 'outerHTML', 'document.write', 'new Function', 'eval('].forEach(function (bad) {
    assert.strictEqual(src.indexOf(bad), -1, 'explore/topic-ai.js 不许出现 ' + bad);
  });
  const css = fs.readFileSync(CSS_PATH, 'utf8');
  const hits = css.split('.tai-').length - 1;
  assert.ok(hits >= 15, 'CSS 里 .tai- 至少出现 15 次（实际 ' + hits + '）');
});

/* ================================================================ 9. 首屏脚本不变 + 额外 fetch 守卫 */

test('9. explore/index.html 首屏脚本恰好 5 个且不含 topic-ai.js', function () {
  const html = fs.readFileSync(INDEX_PATH, 'utf8');
  const srcs = [];
  const re = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const src = m[1];
    if (/^https?:/i.test(src)) continue;
    srcs.push(src);
  }
  assert.deepStrictEqual(srcs, ['../diagnose/lazyload.js', 'app.js', '../assets/stats-config.js', '../assets/stats.js', '../assets/pwa.js'],
    '首屏脚本必须恰好是这 5 个且顺序一致');
  assert.strictEqual(srcs.indexOf('topic-ai.js'), -1, 'topic-ai.js 不许进首屏');
});

test('额外：explore/topic-ai.js 不许自己发网络（无 fetch( 调用）', function () {
  const src = fs.readFileSync(MODULE_PATH, 'utf8');
  /* 用词边界而不是裸 indexOf：卡 D 新增的 needsRefetch(...) 名字里含 "fetch(" 子串，
   * 纯字符串匹配会误报；这条正则反而更强（`fetch (` 带空格也算命中）。 */
  const hits = src.match(/(^|[^A-Za-z0-9_$])fetch\s*\(/g) || [];
  assert.strictEqual(hits.length, 0, '网只走 DiagLLMGateway，模块里不许出现 fetch( 调用：' + hits.join(','));
});

Promise.all(ASYNC).then(function () {
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
});
