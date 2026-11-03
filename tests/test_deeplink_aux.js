#!/usr/bin/env node
/* 深链辅助模块补载回归（kanban t_a7055f3e）
 *
 * 背景：从 /diagnose/?target=cnm_221 这类深链进入时，init() 在
 *   `if (resolved) { flow('enter')(...); return; }` 处提前返回，末尾 whenIdle 里的
 *   children.js / blindspots.js / llm-config.js / stats-config.js / stats.js / pwa.js
 *   一个都不会被请求。结果：window.CnmChildren 恒为 undefined，
 *   childBar() / saveToChild() 早退，薄弱点卡与 LLM 入口不出现，Umami 不上报，PWA 不注册。
 *   不带参数进 /diagnose/ 时一切正常。
 *
 * 修复：把补载调度抽成 init() 内的具名函数，在所有入口（普通访问 / 深链 / ?demo）
 *   必经的位置调用一次；仍走 whenIdle（首次交互或 2s 兜底），不提前到首屏。
 *
 * 用例：
 *   1（核心）：深链 → 答 1 题 → 六个辅助脚本中 children/blindspots/stats 均被请求、CnmChildren 到货。
 *   2：limit=1 深链 → 先建孩子 → 答完最后一题回报告页 → #child-bar 非空 + 孩子记录真的写入。
 *   3（回归）：不带参数进 /diagnose/ → 选题页正常 + 辅助模块照常到货。
 *
 * 零依赖、真 Chrome headless、CDP 直连，骨架照抄 tests/test_resume_engine.js。
 * 需要 Node 22+（全局 WebSocket / fetch）和 Chrome/Chromium，可用 CHROME 指定浏览器路径。
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

const tests = [];
let passed = 0;
let failed = 0;
function test(name, fn) { tests.push({ name: name, fn: fn }); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, timeout) {
  const end = Date.now() + (timeout || 20000);
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(100);
  }
  throw new Error('Timeout: ' + label);
}

/* ------------------------------------------------------------ 测试服务器 */
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cnm-deeplink-aux-'));
const server = http.createServer(function (req, res) {
  let file = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (file.endsWith('/')) file += 'index.html';
  if (file === '/assets/stats-config.js') { res.setHeader('Content-Type', 'text/javascript'); res.end('window.CNM_STATS = {};'); return; }
  const full = path.resolve(ROOT, '.' + file);
  if (!full.startsWith(ROOT + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.readFile(full, function (err, data) {
    if (err) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', ({
      '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html',
      '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json'
    })[path.extname(full)] || 'application/octet-stream');
    res.end(data);
  });
});

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = [];
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) p.reject(new Error(p.method + ': ' + m.error.message));
        else p.resolve(m.result);
      } else {
        this.handlers.forEach((fn) => fn(m));
      }
    });
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve, reject: reject, method: method });
      this.ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression: expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('页面内求值抛错：' + JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result.value;
  }
}

let chrome = null;
async function ensureServer() {
  if (server.listening) return;
  await new Promise(function (resolve, reject) { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
}
async function openBrowser() {
  await ensureServer();
  /* 每次启动用独立资料目录：DevToolsActivePort 是上次留下的旧文件，复用会连到已死的端口。 */
  const profileDir = path.join(out, 'profile-' + (openBrowser.n = (openBrowser.n || 0) + 1));
  const chromePath = [
    process.env.CHROME,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'
  ].find(function (p) { return p && fs.existsSync(p); });
  if (!chromePath) throw new Error('找不到 Chrome/Chromium，请设置 CHROME 环境变量');
  chrome = spawn(chromePath, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-sync', '--disable-extensions', '--disable-component-update',
    '--remote-debugging-port=0', '--user-data-dir=' + profileDir, 'about:blank'
  ], { stdio: ['ignore', 'ignore', fs.openSync(path.join(out, 'chrome.log'), 'w')] });
  const activePort = path.join(profileDir, 'DevToolsActivePort');
  await until(function () { return fs.existsSync(activePort); }, 'Chrome 调试端口');
  const port = fs.readFileSync(activePort, 'utf8').split('\n')[0];
  const tabs = await fetch('http://127.0.0.1:' + port + '/json').then(function (r) { return r.json(); });
  const tab = tabs.find(function (t) { return t.type === 'page'; });
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise(function (resolve, reject) { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  const cdp = new CDP(ws);
  /* 页面内所有报错都收上来（与 test_resume_engine.js 同款钩子）。 */
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  await cdp.send('Network.setBypassServiceWorker', { bypass: true });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1200, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: [
      'window.__errs = [];',
      'window.addEventListener("error", function (e) { window.__errs.push("onerror: " + (e && e.message)); });',
      'window.addEventListener("unhandledrejection", function (e) {',
      '  var r = e && e.reason; window.__errs.push("unhandledrejection: " + ((r && r.message) || r));',
      '});',
      'var __ce = console.error.bind(console);',
      'console.error = function () { window.__errs.push("console.error: " + Array.prototype.join.call(arguments, " ")); return __ce.apply(null, arguments); };'
    ].join('\n')
  });
  cdp.handlers.push(function (m) {
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails || {};
      cdp.pageErrors.push('exception: ' + ((d.exception && (d.exception.description || d.exception.value)) || d.text));
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      cdp.pageErrors.push('console.error: ' + m.params.args.map(function (a) { return a.value || a.description || a.type; }).join(' '));
    }
  });
  cdp.pageErrors = [];
  cdp.base = 'http://127.0.0.1:' + server.address().port;
  return cdp;
}

async function pageErrors(cdp) {
  const inner = JSON.parse(await cdp.eval('JSON.stringify(window.__errs || [])'));
  return inner.concat(cdp.pageErrors);
}

const DEEP = '/diagnose/?target=cnm_221&seed=sg450mxq';

/* 清 localStorage 再进深链，避免上一个用例残留的存档/状态干扰。 */
async function freshNavigate(cdp, url) {
  await cdp.send('Page.navigate', { url: cdp.base + '/' });
  await until(function () { return cdp.eval('document.readyState === "complete"'); }, '首页加载');
  await cdp.eval('localStorage.clear()');
  await cdp.send('Page.navigate', { url: cdp.base + url });
}

/* 照抄 test_resume_engine.js 的 seedSession：从引擎取正确答案，choice 点 #choice-<answer>，
 * 填空写 #ans 后派发 input，点 #btn-submit 判题，再点 #btn-next 落定（commit → save）。 */
async function answerOne(cdp) {
  await until(function () { return cdp.eval('!!document.getElementById("q-text")'); }, '出题', 12000);
  const item = await cdp.eval([
    '(() => { const it = window.DiagCore.E.nextItem(window.DiagCore.S.D.graph, window.DiagCore.S.session);',
    '  return it ? { type: it.question.type, answer: it.question.answer } : null; })()'
  ].join('\n'));
  assert.ok(item, '当前题目必须存在');
  if (item.type === 'choice') {
    await cdp.eval('document.querySelector("[id=\\"choice-' + item.answer + '\\"]").click()');
  } else {
    await cdp.eval('(() => { const el = document.getElementById("ans"); el.value = ' + JSON.stringify(item.answer) +
      '; el.dispatchEvent(new Event("input", { bubbles: true })); })()');
  }
  await cdp.eval('document.getElementById("btn-submit").click()');
  await until(function () { return cdp.eval('!!document.getElementById("btn-next")'); }, '「下一题」按钮', 12000);
  await cdp.eval('document.getElementById("btn-next").click()');
}

async function resourceUrls(cdp) {
  return await cdp.eval('performance.getEntriesByType("resource").map(function (e) { return e.name; })');
}

/* ------------------------------------------------------------ 用例 1：深链也必须补载辅助模块 */
test('深链答题后 children.js / blindspots.js / stats.js 被请求，CnmChildren 到货', async function () {
  const cdp = await openBrowser();
  try {
    await freshNavigate(cdp, DEEP);
    await answerOne(cdp);
    /* whenIdle 在测试里只能靠 2s 定时器触发（el.click() 不产生 pointerdown），
     * 2s + 串行补载 6 个脚本，10s 足够；改前这段永远不会执行 → 超时（红）。 */
    const urls = await until(async function () {
      const list = await resourceUrls(cdp);
      const has = function (name) { return list.some(function (u) { return u.indexOf('/' + name) >= 0; }); };
      return (has('assets/children.js') && has('assets/blindspots.js') && has('assets/stats.js')) ? list : null;
    }, '深链后 children.js / blindspots.js / stats.js 必须被请求', 10000);
    assert.ok(urls.some(function (u) { return u.indexOf('/assets/children.js') >= 0; }), 'children.js 必须被请求');
    assert.ok(urls.some(function (u) { return u.indexOf('/assets/blindspots.js') >= 0; }), 'blindspots.js 必须被请求');
    assert.ok(urls.some(function (u) { return u.indexOf('/assets/stats.js') >= 0; }), 'stats.js 必须被请求');
    assert.strictEqual(await cdp.eval('typeof window.CnmChildren'), 'object', '深链下 CnmChildren 必须到货');
    const errs = await pageErrors(cdp);
    assert.deepStrictEqual(errs, [], '深链补载过程零报错');
  } finally {
    chrome && chrome.kill('SIGKILL');
    chrome = null;
  }
});

/* ------------------------------------------------------------ 用例 2：到货后 childBar / saveToChild 真的生效 */
test('limit=1 深链答完后报告页出现 #child-bar 且孩子档案真的写入', async function () {
  const cdp = await openBrowser();
  try {
    await freshNavigate(cdp, '/diagnose/?target=cnm_221&limit=1&seed=sg450mxq');
    /* 先等辅助模块到货，再造孩子：saveToChild() 只在 CC 到货且有「当前孩子」时才写记录。 */
    await until(async function () { return (await cdp.eval('typeof window.CnmChildren')) === 'object'; },
      '深链下 CnmChildren 到货', 10000);
    const added = await cdp.eval([
      '(() => { const r = window.CnmChildren.add({ name: "测试娃", grade: "三年级" });',
      '  return r && r.ok ? r.child.id : null; })()'
    ].join('\n'));
    assert.ok(added, '必须在页面里成功建一个孩子');
    await answerOne(cdp);
    await until(function () { return cdp.eval('!!document.getElementById("summary")'); }, 'limit=1 答完后进入报告页', 12000);
    const bar = await cdp.eval([
      '(() => { const el = document.getElementById("child-bar");',
      '  return el ? { exists: true, text: el.innerText.replace(/\\s+/g, " ").trim() } : { exists: false, text: "" }; })()'
    ].join('\n'));
    assert.strictEqual(bar.exists, true, '报告页必须出现 #child-bar（childBar 的产出）');
    assert.ok(bar.text.length > 0, '#child-bar 内容不能为空');
    const rec = JSON.parse(await cdp.eval('localStorage.getItem("cnmChildren.records.v1")') || 'null');
    assert.ok(rec && Array.isArray(rec[added]) && rec[added].length >= 1,
      'saveToChild() 必须把这次结果写进 cnmChildren.records.v1（孩子 id=' + added + '）');
    const errs = await pageErrors(cdp);
    assert.deepStrictEqual(errs, [], '深链报告页与档案写入过程零报错');
  } finally {
    chrome && chrome.kill('SIGKILL');
    chrome = null;
  }
});

/* ------------------------------------------------------------ 用例 3：普通入口不回归 */
test('不带参数进 /diagnose/：选题页正常 + 辅助模块照常到货', async function () {
  const cdp = await openBrowser();
  try {
    await freshNavigate(cdp, '/diagnose/');
    await until(function () { return cdp.eval('!!document.getElementById("search") && !!document.getElementById("target-list")'); },
      '选题页（搜索框 + 目标列表）', 12000);
    const urls = await until(async function () {
      const list = await resourceUrls(cdp);
      return list.some(function (u) { return u.indexOf('/assets/children.js') >= 0; }) ? list : null;
    }, '普通入口 children.js 必须被请求', 10000);
    assert.ok(urls.some(function (u) { return u.indexOf('/assets/children.js') >= 0; }), 'children.js 必须被请求');
    assert.strictEqual(await cdp.eval('typeof window.CnmChildren'), 'object', '普通入口 CnmChildren 必须到货');
    const errs = await pageErrors(cdp);
    assert.deepStrictEqual(errs, [], '普通入口零报错');
  } finally {
    chrome && chrome.kill('SIGKILL');
    chrome = null;
  }
});

/* ------------------------------------------------------------ 跑 */
(async function main() {
  for (const t of tests) {
    try {
      await t.fn();
      passed++;
      console.log('  ok   ' + t.name);
    } catch (e) {
      failed++;
      console.log('  FAIL ' + t.name + '\n       ' + String((e && e.stack) || e).split('\n').slice(0, 8).join('\n       '));
    }
  }
  try { server.close(); } catch (e) { /* 未监听 */ }
  if (chrome) chrome.kill('SIGKILL');
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exitCode = 1;
})();
