/* 诊断页的「浏览器脚本作用域」基座（测试专用）：把 diagnose/ 下真正会在浏览器里跑的那几个
 * 脚本文件，按 index.html 的 <script src> 顺序 + 按需段 app-flow.js，在 vm 沙箱里以
 * self=window=ctx 的方式 runInContext 执行一遍。
 *
 * WHY 必须有这一层：本次缺陷（CORE 漏导出 variantsMod）在 Node 侧永远测不出来 ——
 *   tests/*.js 里 require('../diagnose/app-flow.js') 走的是 module.exports 分支，
 *   裸标识符 `variantsMod` 在 Node 的模块作用域里同样不存在，但没人调用 startPractice；
 *   而 app-flow.js 顶部 `var X = CORE.X` 漏一行时，Node 侧只是拿到 undefined，
 *   浏览器侧（index.html 的 <script> 链，所有文件共享一个全局作用域）才是真正的一套
 *   作用域解析规则。要复现「按钮点了没反应」只能按浏览器的方式真加载、真调用。
 *
 * 口径：
 *   1. 加载清单来自 index.html（解析 <script src>，跳过 http(s) 外链），不写死；
 *   2. 不 require 被测脚本、不手动往 ctx 上补任何被测模块的全局（补了就等于替浏览器把
 *      接线接上，测不出漏挂）；
 *   3. 假 DOM 只实现被真实调用到的 API：root 元素、createElement/createTextNode、append、
 *      textContent。够跑 renderSkeleton / renderPracticeLoading 这类首屏与练习态渲染。
 *   4. fetch 返回永不 resolve 的 Promise：init() 会卡在 loadData 上，页面不会被测试
 *      擅自推进到需要真实数据的阶段（也不会去请求网络）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

/** 极简元素节点：只覆盖 app.js 的 h()/append()/clearRoot() 与 renderPracticeLoading 用到的面。 */
function makeNode(tag) {
  const el = {
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    childNodes: [],
    attrs: Object.create(null),
    className: '',
    id: '',
    style: {},
    dataset: {},
    parentNode: null,
    _text: '',
    appendChild(c) { this.childNodes.push(c); if (c && typeof c === 'object') c.parentNode = this; return c; },
    insertBefore(c) { return this.appendChild(c); },
    append() { for (let i = 0; i < arguments.length; i++) this.appendChild(arguments[i]); },
    removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); return c; },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    scrollIntoView() {},
    focus() {},
    blur() {},
    click() {},
    cloneNode() { return makeNode(tag); },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    get firstChild() { return this.childNodes[0] || null; },
    get children() { return this.childNodes.filter((n) => n && n.nodeType === 1); },
    get textContent() { return this._text; },
    /* 与浏览器一致：赋 textContent 会清空子节点。renderPracticeLoading 靠这条清 root。 */
    set textContent(v) { this._text = String(v); if (v === '') this.childNodes = []; },
    get innerHTML() { return this._text; },
    set innerHTML(v) { this._text = String(v); }
  };
  return el;
}

/** 递归取文本：元素节点的文字可能挂成子文本节点（h(el, attrs, '字')）或 text 属性（h(el, {text})）。 */
function textOf(node) {
  if (!node) return '';
  if (node.nodeType === 3) return String(node.textContent || '');
  const kids = node.childNodes || [];
  if (kids.length) return kids.map(textOf).join('');
  return String(node.textContent || '');
}

/** 从 index.html 解析首屏脚本链（相对 diagnose/ 的文件名，跳过外链）。 */
function scriptChainOf(indexHtml) {
  const chain = [];
  const re = /<script\b[^>]*\bsrc="([^"]+)"/g;
  let m;
  while ((m = re.exec(indexHtml)) !== null) {
    const src = m[1];
    if (/^(https?:)?\/\//.test(src) || src.charAt(0) === '/') continue;   // 外链 / 绝对路径不属于本仓
    chain.push(src);
  }
  return chain;
}

/**
 * 按浏览器的方式加载 diagnose/ 的诊断页脚本。
 * @param {string} rootDir 仓库根（测试用 path.join(__dirname, '..')）
 * @returns {{ctx:object, root:object, alerts:string[], lazyCalls:string[][],
 *            scriptChain:string[], loaded:string[], textOf:function}}
 */
function loadDiagnose(rootDir) {
  const diag = path.join(rootDir, 'diagnose');
  const rootEl = makeNode('main');
  rootEl.id = 'root';

  const doc = {
    documentElement: makeNode('html'),
    body: makeNode('body'),
    head: makeNode('head'),
    readyState: 'complete',
    createElement: (t) => makeNode(t),
    createTextNode: (t) => ({ nodeType: 3, textContent: String(t), parentNode: null }),
    createDocumentFragment: () => makeNode('#fragment'),
    getElementById: (id) => (id === 'root' ? rootEl : null),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {}
  };

  const store = Object.create(null);
  const alerts = [];
  const lazyCalls = [];
  const sandbox = {
    console: { log() {}, warn() {}, error() {}, info() {} },
    document: doc,
    location: { search: '', href: 'http://127.0.0.1/diagnose/', hash: '', pathname: '/diagnose/' },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; }
    },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {} }),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    scrollTo() {},
    /* 页面里的 alert 会中断流程；测试里记下来当作「走进了降级分支」的证据。 */
    alert: (msg) => { alerts.push(String(msg)); },
    setTimeout, clearTimeout, setInterval, clearInterval,
    URLSearchParams,
    navigator: { userAgent: 'diagnose-browser-env' },
    innerWidth: 1280, innerHeight: 900,
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    /* 永不 resolve：init() 停在首屏 loadData，不会自己往下推进（也就不会发真网络请求）。 */
    fetch: () => new Promise(() => {})
  };
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  const scriptChain = scriptChainOf(fs.readFileSync(path.join(diag, 'index.html'), 'utf8'));
  const loaded = [];
  const load = function (rel) {
    const full = path.join(diag, rel);
    vm.runInContext(fs.readFileSync(full, 'utf8'), sandbox, { filename: full });
    loaded.push(rel);
  };
  scriptChain.forEach(load);
  /* 按需段：index.html 里没有它，由 app.js 的 ensureFlowEngine() 与 engine.js 并发注入
   * （见 app.js 的 Lazy.load('app-flow.js')）。本基座只加载它，不加载 engine.js ——
   * 练习入口在「变式模块还没到货」这条分支上不需要引擎。 */
  load('app-flow.js');

  /* 真加载器会 document.createElement('script') 再等 onload，离线测里永远不会 resolve。
   * 换成记录入参的桩：只看到「按哪些文件、什么顺序去取」，不假装加载成功。 */
  sandbox.Lazy.load = function (names) {
    lazyCalls.push(Array.isArray(names) ? names.slice() : [names]);
    return new Promise(() => {});
  };

  return {
    ctx: sandbox,
    root: rootEl,
    alerts: alerts,
    lazyCalls: lazyCalls,
    scriptChain: scriptChain,
    loaded: loaded,
    textOf: textOf
  };
}

module.exports = { loadDiagnose: loadDiagnose, makeNode: makeNode, textOf: textOf, scriptChainOf: scriptChainOf };
