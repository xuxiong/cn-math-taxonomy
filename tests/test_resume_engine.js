#!/usr/bin/env node
/* 回归：点 banner「继续」/ 阻塞卡「重新试试」必须先 ensureFlowEngine，不能裸 withStage2
 *
 * 背景（kanban t_5d6eb0d9）：
 *   diagnose/app.js 的 goFlow 是「进流程按钮」的统一入口：先 ensureFlowEngine() 等引擎/按需段，
 *   再 withStage2() 过题源门。但 banner「继续」(app.js:1645) 和阻塞卡 renderFlowBlocked 的
 *   「重新试试」(app.js:1633) 两条路径绕过了它，直接 withStage2 —— 而 withStage2 只等题源门，
 *   不等引擎。/diagnose/ 首屏不加载 engine.js / app-flow.js（首屏请求数上限守卫要求），
 *   所以这两条路径在引擎未到货时：
 *     - flow('restoreFromSave') 是空实现（FLOW 为 null），啥也不干，页面停在选题页；
 *     - 重试永远拿不到引擎，永远失败。
 *   表现：点「继续」0.4s 内毫无反应，或永远「数据没下来」。
 *
 * 修复：抽 enterWithEngine(targets, mode, fn) 供 goFlow / banner 继续助手 / renderFlowBlocked 重试共用；
 *   ensureFlowEngine 失败时清 flowEnginePromise，让重试能真正重新发起补载。
 *
 * 用例 A：banner「继续」立刻点（MutationObserver 同步 click），断言出题/报告 + 引擎到货 + 零报错。
 * 用例 B：engine.js 首次 404 → 点继续 → #flow-blocked 出现 → 开关放行 → 点「重新试试」→ 出题/报告
 *   + 零报错 + engine.js 请求次数 ≥2（证明重试重新触发了补载，而非空转同一个 rejected Promise）。
 *
 * 照抄 tests/test_result_deadend.js 的结构与工具（零依赖、真 Chrome headless、CDP 直连、
 * 自建 http 静态服务、openBrowser/CDP/until 那套原样复用，测试服务器监听 127.0.0.1）。
 *
 * 需要 Node 22+（全局 WebSocket / fetch）和 Chrome/Chromium，可用 CHROME 指定浏览器路径。
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

/* 共用小模块：
 *   chrome-guard —— Chrome 进程级兜底回收（抛错 / SIGKILL / 外部超时都不留进程、不留临时目录）
 *   wait         —— until 统一超时口径（超时=失败上限，不是性能断言） */
const guard = require('./lib/chrome-guard');
const { until, chromePort, devtoolsJson } = require('./lib/wait');

const ROOT = path.resolve(__dirname, '..');

const tests = [];
let passed = 0;
let failed = 0;
function test(name, fn) { tests.push({ name: name, fn: fn }); }

/* ------------------------------------------------------------ 测试服务器 */
/* engine.js 失败开关（用例 B）：>0 时让前 N 次 /diagnose/engine.js 返回 404，
 * 模拟弱网/部署竞态下按需段补载失败。Lazy.load 失败会清缓存（lazyload.js），
 * 所以下一次调用又能真的发出请求 —— 配合修复后的 ensureFlowEngine 失败清 flowEnginePromise，
 * 重试可以真正重新补载。改前 ensureFlowEngine 不清缓存，重试拿到同一个 rejected Promise，
 * 永远不会重新发 engine.js 请求（这正是用例 B 守的红）。 */
let engineFailCount = 0;
const out = guard.tempDir('cnm-resume-engine-');
const server = http.createServer(function (req, res) {
  let file = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (file.endsWith('/')) file += 'index.html';
  if (file === '/assets/stats-config.js') { res.setHeader('Content-Type', 'text/javascript'); res.end('window.CNM_STATS = {};'); return; }
  if (file === '/diagnose/engine.js' && engineFailCount > 0) {
    engineFailCount--;
    res.writeHead(404); res.end(); return;
  }
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
    /* 连接断开（页面崩了 / 浏览器被杀）时把未完成的请求全部 reject：
     * 否则 await 一个永远不回来的响应，测试进程既不失败也不退出，Chrome 就一直留在机器上。 */
    ws.addEventListener('close', () => {
      for (const p of this.pending.values()) p.reject(new Error(p.method + ': CDP 连接已关闭'));
      this.pending.clear();
    });
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
  /* 每个请求 25s 上限：这是「无响应」的失败上限，不是性能断言（页面正常时一次 eval 是毫秒级）。
   * 旧写法没有上限，浏览器一旦不响应，整个测试文件就永久挂住 —— 假红之外的另一种不可诊断状态。 */
  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error('CDP 无响应（25s 上限）: ' + method));
      }, 25000);
      this.pending.set(id, {
        method: method,
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); }
      });
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
  /* guard.launch：spawn 之后立刻登记 pid —— 后面等 DevToolsActivePort 超时抛错时，
   * 收尾照样杀得掉（旧写法要等 `chrome = spawn(...)` 赋值成功，抛错时 chrome 还是 null）。 */
  chrome = guard.launch(chromePath, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-sync', '--disable-extensions', '--disable-component-update',
    '--remote-debugging-port=0', '--user-data-dir=' + profileDir, 'about:blank'
  ], { logFile: path.join(out, 'chrome.log') });
  const activePort = path.join(profileDir, 'DevToolsActivePort');
  /* 等端口「写完整」（文件刚创建时内容可能还是 0 字节），再等 HTTP 端点能应答：见 wait.chromePort。 */
  const port = await chromePort(activePort);
  const tabs = await devtoolsJson(port);
  const tab = tabs.find(function (t) { return t.type === 'page'; });
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise(function (resolve, reject) { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  const cdp = new CDP(ws);
  /* 页面内所有报错都收上来（与 test_result_deadend.js 同款 9 行钩子 + CDP 侧 exceptionThrown/consoleAPICalled），
   * 再加 Network.requestWillBeSent 收 engine.js 请求次数（用例 B 守「重试真的重新补载」的硬证据）。 */
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
    if (m.method === 'Network.requestWillBeSent') {
      const u = m.params.request && m.params.request.url;
      if (u && /\/diagnose\/engine\.js/.test(u)) cdp.engineRequests.push(u);
    }
  });
  cdp.pageErrors = [];
  cdp.engineRequests = [];
  cdp.base = 'http://127.0.0.1:' + server.address().port;
  return cdp;
}

async function pageErrors(cdp) {
  const inner = JSON.parse(await cdp.eval('JSON.stringify(window.__errs || [])'));
  return inner.concat(cdp.pageErrors);
}

const DEEP = '/diagnose/?target=cnm_221&seed=sg450mxq';
const HOME = '/diagnose/';

/* 注入「banner 一出现就同步 click 继续」的 MutationObserver：
 * 任务要求「页面刚 interactive 就点、不等任何等待」。observer 监听 documentElement 子树，
 * .banner 一出现就找文本为「继续」的按钮 click。脚本在页面任何产品代码之前注入
 * （Page.addScriptToEvaluateOnNewDocument），保证 banner 渲染那一刻就点，不靠 sleep 等待。 */
const BANNER_CLICKER = [
  '(function () {',
  '  if (window.__resumeClicker) return;',
  '  window.__resumeClicker = true;',
  '  function clickContinue() {',
  '    var banner = document.querySelector(".banner");',
  '    if (!banner) return;',
  '    var btns = banner.querySelectorAll("button");',
  '    for (var i = 0; i < btns.length; i++) {',
  '      if (btns[i].textContent === "继续" && !btns[i].__clicked) {',
  '        btns[i].__clicked = true;',
  '        btns[i].click();',
  '        return;',
  '      }',
  '    }',
  '  }',
  '  var mo = new MutationObserver(clickContinue);',
  '  function setup() {',
  '    if (document.documentElement) {',
  '      mo.observe(document.documentElement, { childList: true, subtree: true });',
  '      clickContinue();',
  '    } else {',
  '      setTimeout(setup, 0);',
  '    }',
  '  }',
  '  setup();',
  '})();'
].join('\n');

/* 造存档：进深链答 1 题，localStorage 自然写入 cnmDiagnose.session.v2。
 * 不手搓存档对象 —— 字段名跟 save()/restoreSession() 完全一致才稳（参考 app.js:1407 save 与
 * app-flow.js:103 restoreFromSave）。答 1 题后 applyAnswerAndRender → save() 已写入。
 * 流程照抄 test_result_deadend.js 的 freshDeepLink：先回首页 clear localStorage 再进深链，
 * 避免上个用例残留的存档/状态干扰本题。 */
async function seedSession(cdp) {
  await cdp.send('Page.navigate', { url: cdp.base + '/' });
  await until(function () { return cdp.eval('document.readyState === "complete"'); }, '首页加载');
  await cdp.eval('localStorage.clear()');
  await cdp.send('Page.navigate', { url: cdp.base + DEEP });
  await until(function () { return cdp.eval('!!document.getElementById("q-text")'); }, '深链出第一题');
  const item = await cdp.eval([
    '(() => { const it = window.DiagCore.E.nextItem(window.DiagCore.S.D.graph, window.DiagCore.S.session);',
    '  return it ? { type: it.question.type, answer: it.question.answer } : null; })()'
  ].join('\n'));
  assert.ok(item, '深链第 1 题必须存在');
  if (item.type === 'choice') {
    await cdp.eval('document.querySelector("[id=\\"choice-' + item.answer + '\\"]").click()');
  } else {
    await cdp.eval('(() => { const el = document.getElementById("ans"); el.value = ' + JSON.stringify(item.answer) +
      '; el.dispatchEvent(new Event("input", { bubbles: true })); })()');
  }
  await cdp.eval('document.getElementById("btn-submit").click()');
  await until(function () { return cdp.eval('!!document.getElementById("btn-next")'); }, '第 1 题的「下一题」按钮');
  /* 点「下一题」才触发 commit → applyAnswer → save()：btn-submit 只判题+渲染反馈态（judgeAndGo），
   * 不写存档；btn-next 的 onclick 调 finishAnswer → commit → applyAnswerAndRender → save()。 */
  await cdp.eval('document.getElementById("btn-next").click()');
  /* 不点「下一题」——只要 localStorage 里有存档就行。答 1 题后 save() 已写入。 */
  const saved0 = JSON.parse(await cdp.eval('localStorage.getItem("cnmDiagnose.session.v2")') || 'null');
  assert.ok(saved0 && saved0.targets && saved0.targets[0] === 'cnm_221', '存档目标必须是 cnm_221');
  assert.ok(saved0.answers && saved0.answers.length === 1, '答 1 题后存档 answers 必须有 1 条记录');
}

/* ------------------------------------------------------------ 用例 A：banner「继续」 */
test('banner「继续」必须先 ensureFlowEngine（立刻点，出题/报告 + 引擎到货 + 零报错）', async function () {
  const cdp = await openBrowser();
  try {
    await seedSession(cdp);
    /* 全新加载普通首屏（不带 ?target），注入 banner clicker */
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: BANNER_CLICKER });
    await cdp.send('Page.navigate', { url: cdp.base + HOME });
    /* banner 出现 → clicker 同步 click「继续」→ enterWithEngine → 引擎补载 → 出题。
     * 改前：裸 withStage2 不等引擎，flow('restoreFromSave') 是空实现（FLOW 为 null）→ 啥也没干
     *      → #q-text 永远不出现 → until 超时（红）。 */
    await until(function () { return cdp.eval('!!document.getElementById("q-text") || !!document.getElementById("summary")'); },
      '点继续后出现题目或报告');
    assert.strictEqual(await cdp.eval('!!document.getElementById("flow-blocked")'), false,
      '引擎到货后不许出现 #flow-blocked');
    assert.strictEqual(await cdp.eval('typeof window.DiagCore.E !== "undefined"'), true,
      '点继续后引擎必须已到货（window.DiagCore.E 已赋值）');
    const errs = await pageErrors(cdp);
    assert.deepStrictEqual(errs, [], '点继续 → 出题过程零报错');
  } finally {
    guard.kill(chrome);
    chrome = null;
  }
});

/* ------------------------------------------------------------ 用例 B：阻塞卡「重新试试」必须重新触发引擎补载 */
test('阻塞卡「重新试试」重新触发 engine.js 补载（首次 404 → 重试 → 出题/报告 + 零报错）', async function () {
  const cdp = await openBrowser();
  try {
    await seedSession(cdp);
    /* 开关：让 engine.js 第一次 404 */
    engineFailCount = 1;
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: BANNER_CLICKER });
    await cdp.send('Page.navigate', { url: cdp.base + HOME });
    /* banner → click 继续助手 → enterWithEngine → ensureFlowEngine → engine.js 404 → renderFlowBlocked。
     * 改前：裸 withStage2 不调 ensureFlowEngine，engine.js 404 对它无影响 → #flow-blocked 永远不出现
     *      → until 超时（红）。 */
    await until(function () { return cdp.eval('!!document.getElementById("flow-blocked")'); },
      'engine.js 404 时点继续后必须出现 #flow-blocked');
    const blockedText = await cdp.eval('document.querySelector("#flow-blocked h1").textContent');
    assert.ok(blockedText.indexOf('数据没下来') >= 0, '阻塞卡标题：' + blockedText);
    /* 第一次 engine.js 请求已发出（404）。记下当前请求数。 */
    const reqsBeforeRetry = cdp.engineRequests.length;
    assert.ok(reqsBeforeRetry >= 1, '点继续应当触发至少 1 次 engine.js 请求（实际 ' + reqsBeforeRetry + '）');

    /* 关掉 404 开关，点「重新试试」→ enterWithEngine → 重新 ensureFlowEngine → engine.js 200 → 出题。
     * 关键：ensureFlowEngine 失败时必须清 flowEnginePromise（修复点），否则重试拿到同一个 rejected
     * Promise，永远不会重新发 engine.js 请求 —— 用 engine.js 请求次数 ≥2 守这一条。 */
    engineFailCount = 0;
    await cdp.eval('document.getElementById("btn-flow-retry").click()');
    await until(function () { return cdp.eval('!!document.getElementById("q-text") || !!document.getElementById("summary")'); },
      '点重新试试后出现题目或报告');
    assert.strictEqual(await cdp.eval('!!document.getElementById("flow-blocked")'), false,
      '重试成功后 #flow-blocked 必须消失');
    assert.strictEqual(await cdp.eval('typeof window.DiagCore.E !== "undefined"'), true,
      '重试后引擎必须已到货');
    /* 重试必须重新触发 engine.js 请求（≥2 次：首次 404 + 重试 200）。
     * 这是「重试不空转、真的重新补载」的硬证据。 */
    assert.ok(cdp.engineRequests.length >= 2,
      '重试必须重新发起 engine.js 请求（总请求数应 ≥2，实际 ' + cdp.engineRequests.length + '）');
    const errs = await pageErrors(cdp);
    assert.deepStrictEqual(errs, [], '重试 → 出题过程零报错');
  } finally {
    engineFailCount = 0;
    guard.kill(chrome);
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
  if (chrome) guard.kill(chrome);
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exitCode = 1;
})();
