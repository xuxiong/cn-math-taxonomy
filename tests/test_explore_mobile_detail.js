#!/usr/bin/env node
/* 知识图谱：窄屏选中知识点后详情面板没有进入视口（kanban t_ed4530c7）
 *
 * 症状（真机 390×844 实测）：/explore/#cnm_021 深链下 scrollY = 0，
 *   #detail.getBoundingClientRect().top ≈ 815，.desc top ≈ 1186（首屏外 342px）。
 * 原因：@media (max-width:900px) 把 .explore 改成纵向 flex，#cy 固定 420px，
 *   详情排到图下方；而 app.js 选中知识点后没有任何「把详情带进视口」的逻辑。
 *
 * 用例（全部真 Chrome + CDP、真事件）：
 *   1（核心）：手机深链 → 详情面板贴到视口顶、介绍正文进首屏；500ms 后复测不回跳。
 *   2：手机点图里的另一个节点 → 走 app 自己的 tap 处理器，详情同样进视口。
 *   3：手机点侧栏目录项 → 抽屉关闭 + 详情进视口。
 *   4：手机重复点同一目录项 → scrollY 完全不动（不抖）。
 *   5（回归）：桌面 1280×800 三栏布局不变、页面不滚动、详情本来就在首屏。
 *
 * 零依赖、真 Chrome headless、CDP 直连，骨架照抄 tests/test_deeplink_aux.js /
 * tests/test_children_browser.js：每个用例单独开浏览器、单独 profile、绕开 sw 缓存。
 * 需要 Node 22+（全局 WebSocket / fetch）和 Chrome/Chromium，可用 CHROME 指定浏览器路径。
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

const guard = require('./lib/chrome-guard');
const { until, chromePort, devtoolsJson, sleep } = require('./lib/wait');

const ROOT = path.resolve(__dirname, '..');
const out = guard.tempDir('cnm-explore-mobile-');

const MOBILE = { width: 390, height: 844, deviceScaleFactor: 1, mobile: true };
const DESKTOP = { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false };

const tests = [];
let passed = 0;
let failed = 0;
function test(name, fn) { tests.push({ name: name, fn: fn }); }

/* ------------------------------------------------------------ 测试服务器 */
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
    /* 连接断开时把未完成请求全部 reject，避免 await 永远挂着（挂死会留下空转的 Chrome） */
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
  /* 25s 无响应上限：失败上限，不是性能断言 */
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

async function openBrowser(metrics) {
  await ensureServer();
  /* 每次启动用独立资料目录：避免 DevToolsActivePort 旧文件连到已死的端口。 */
  const profileDir = path.join(out, 'profile-' + (openBrowser.n = (openBrowser.n || 0) + 1));
  const chromePath = [
    process.env.CHROME,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'
  ].find(function (p) { return p && fs.existsSync(p); });
  if (!chromePath) throw new Error('找不到 Chrome/Chromium，请设置 CHROME 环境变量');
  chrome = guard.launch(chromePath, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-sync', '--disable-extensions', '--disable-component-update',
    '--remote-debugging-port=0', '--user-data-dir=' + profileDir, 'about:blank'
  ], { logFile: path.join(out, 'chrome.log') });
  const activePort = path.join(profileDir, 'DevToolsActivePort');
  const port = await chromePort(activePort);
  const tabs = await devtoolsJson(port);
  const tab = tabs.find(function (t) { return t.type === 'page'; });
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise(function (resolve, reject) { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  await cdp.send('Network.setBypassServiceWorker', { bypass: true });
  await cdp.send('Emulation.setDeviceMetricsOverride', metrics);
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
  cdp.pageErrors = [];
  cdp.handlers.push(function (m) {
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails || {};
      cdp.pageErrors.push('exception: ' + ((d.exception && (d.exception.description || d.exception.value)) || d.text));
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      cdp.pageErrors.push('console.error: ' + m.params.args.map(function (a) { return a.value || a.description || a.type; }).join(' '));
    }
  });
  cdp.base = 'http://127.0.0.1:' + server.address().port;
  return cdp;
}

async function pageErrors(cdp) {
  const inner = JSON.parse(await cdp.eval('JSON.stringify(window.__errs || [])'));
  return inner.concat(cdp.pageErrors);
}

/* ------------------------------------------------------------ 页面测量 */
const MEASURE = [
  '(() => {',
  '  var d = document.getElementById("detail");',
  '  var desc = document.querySelector("#detail .desc");',
  '  var h1 = document.querySelector("#detail h1");',
  '  var side = document.getElementById("side");',
  '  var r = d ? d.getBoundingClientRect() : null;',
  '  var ds = desc ? desc.getBoundingClientRect() : null;',
  '  return {',
  '    scrollY: window.scrollY,',
  '    innerWidth: window.innerWidth,',
  '    innerHeight: window.innerHeight,',
  '    scrollWidth: document.documentElement.scrollWidth,',
  '    detailTop: r ? r.top : null,',
  '    descTop: ds ? ds.top : null,',
  '    h1: h1 ? h1.textContent : null,',
  '    sideOpen: !!side && side.classList.contains("open"),',
  '    sideVisible: !!side && side.getBoundingClientRect().width > 0 && getComputedStyle(side).display !== "none"',
  '  };',
  '})()'
].join('\n');

async function measure(cdp) { return cdp.eval(MEASURE); }

function assertMobileRevealed(m, label) {
  assert.ok(m.scrollY > 0, label + '：页面必须已经滚下来（scrollY=' + m.scrollY + '）');
  /* 落点允许 ±1 行抖动：#graph-meta 文案在两次 renderGraph 之间会变长/变短一行（23px），
   * 实测同一台机器上 detailTop 在 0.22 与 -22.78 之间浮动（复测 1s 内不再变）。
   * 强约束是「真的滚下来了」+「介绍正文整个进首屏」，这里只守「面板顶在上半屏」。
   * 旧代码（未修复）实测 detailTop ≈ 815（innerHeight=844），这条依然会红。 */
  assert.ok(m.detailTop > -60 && m.detailTop < m.innerHeight / 2,
    label + '：详情面板顶必须落在视口上半屏（不能还留在图下面），实际 top=' + m.detailTop);
  assert.ok(m.descTop >= 0 && m.descTop < m.innerHeight,
    label + '：介绍正文必须进首屏，实际 .desc top=' + m.descTop + '，innerHeight=' + m.innerHeight);
  assert.ok(m.scrollWidth <= m.innerWidth,
    label + '：不能横向溢出，scrollWidth=' + m.scrollWidth + ' > innerWidth=' + m.innerWidth);
}

/* 打开深链，等详情重字段（.desc 出现说明 ensureDetail 已合并完） */
async function openDeepLink(cdp) {
  await cdp.send('Page.navigate', { url: cdp.base + '/explore/#cnm_021' });
  await until(function () { return cdp.eval('!!document.querySelector("#detail .desc")'); }, '深链详情正文 .desc 出现');
}

async function currentId(cdp) {
  return cdp.eval('(() => { var el = document.querySelector("#list .topic-item.sel"); return el ? el.getAttribute("data-jump") : null; })()');
}

/* ------------------------------------------------------------ 用例 1：手机深链 */
test('手机深链：#detail 贴视口顶、介绍进首屏，500ms 后不回跳', async function () {
  const cdp = await openBrowser(MOBILE);
  try {
    await openDeepLink(cdp);
    await until(function () { return cdp.eval('document.getElementById("cy").dataset.ready === "1"'); }, '局部图落定');
    const m = await measure(cdp);
    assertMobileRevealed(m, '手机深链');
    await sleep(500);
    const again = await measure(cdp);
    assertMobileRevealed(again, '手机深链 500ms 后复测');
    assert.strictEqual(again.scrollY, m.scrollY, '500ms 后 scrollY 不能变化（防「滚了又跳回去」）');
    const errs = await pageErrors(cdp);
    assert.deepStrictEqual(errs, [], '手机深链零报错');
    console.log('       [深链] ' + JSON.stringify(m));
  } finally {
    guard.kill(chrome); chrome = null;
  }
});

/* ------------------------------------------------------------ 用例 2：手机点图里的另一个节点 */
test('手机点图节点：走 app tap 处理器后详情同样进视口', async function () {
  const cdp = await openBrowser(MOBILE);
  try {
    await openDeepLink(cdp);
    await cdp.eval('window.scrollTo(0, 0)');
    await until(function () { return cdp.eval('window.scrollY === 0'); }, '回到页首');
    await until(function () { return cdp.eval('document.getElementById("cy").dataset.ready === "1"'); }, '局部图落定');
    const target = await cdp.eval([
      '(() => {',
      '  var cy = window.__cy; if (!cy) return null;',
      '  var cur = document.querySelector("#list .topic-item.sel");',
      '  var curId = cur ? cur.getAttribute("data-jump") : null;',
      '  var rect = document.getElementById("cy").getBoundingClientRect();',
      '  var candidates = cy.nodes().filter(function (n) {',
      '    var id = n.id();',
      '    if (id === curId || id.indexOf("grade-") === 0) return false;',
      '    var p = n.renderedPosition();',
      '    return p.x >= 8 && p.y >= 8 && p.x <= rect.width - 8 && p.y <= rect.height - 8;',
      '  });',
      '  if (!candidates.length) return null;',
      '  var best = candidates[0];',
      '  var bp = best.renderedPosition();',
      '  var bestD = Math.abs(bp.x - rect.width / 2) + Math.abs(bp.y - rect.height / 2);',
      '  candidates.forEach(function (n) {',
      '    var p = n.renderedPosition();',
      '    var d = Math.abs(p.x - rect.width / 2) + Math.abs(p.y - rect.height / 2);',
      '    if (d < bestD) { best = n; bestD = d; }',
      '  });',
      '  var p = best.renderedPosition();',
      '  return { id: best.id(), name: best.data("name"), x: rect.left + p.x, y: rect.top + p.y };',
      '})()'
    ].join('\n'));
    assert.ok(target, '图上必须存在一个可点的非 grade 节点');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 });
    const h1IsTarget = '(() => { var h = document.querySelector("#detail h1"); return !!h && h.textContent === ' + JSON.stringify(target.name) + '; })()';
    let realClickWorked = true;
    try {
      await until(function () { return cdp.eval(h1IsTarget); }, '真实点击后 #detail h1 变成节点名', 5000);
    } catch (e) {
      /* 这台机器的 headless 真点击偶尔落不到节点中心（节点框叠在一起时点到的是别的节点）。
       * 退回 cytoscape 的 emit('tap')，仍然以「#detail h1 变成该节点名字」为通过条件，
       * 保证走的是 app 自己的 tap 处理器（cy.on('tap','node')），不是直接调 select()。 */
      realClickWorked = false;
      await cdp.eval('window.__cy.getElementById(' + JSON.stringify(target.id) + ').emit("tap")');
      await until(function () { return cdp.eval(h1IsTarget); }, 'emit("tap") 后 #detail h1 变成节点名');
    }
    await until(function () {
      return cdp.eval('!!document.querySelector("#detail .desc") && (() => { var h = document.querySelector("#detail h1"); return !!h && h.textContent === ' + JSON.stringify(target.name) + '; })()');
    }, '目标节点详情正文到货');
    const m = await measure(cdp);
    assertMobileRevealed(m, '手机点图节点' + (realClickWorked ? '（真实鼠标点击）' : '（emit tap 兜底）'));
    const errs = await pageErrors(cdp);
    assert.deepStrictEqual(errs, [], '点图节点零报错');
    console.log('       [点节点] ' + JSON.stringify(m) + ' realClick=' + realClickWorked);
  } finally {
    guard.kill(chrome); chrome = null;
  }
});

/* 打开侧栏目录并挑一个不同于当前选中的可见目录项；返回它在 NodeList 里的下标与名字。 */
async function pickOtherListItem(cdp) {
  await cdp.eval('document.getElementById("list-toggle").click()');
  await until(function () { return cdp.eval('document.getElementById("side").classList.contains("open")'); }, '侧栏抽屉打开');
  return cdp.eval([
    '(() => {',
    '  var cur = document.querySelector("#list .topic-item.sel");',
    '  var curId = cur ? cur.getAttribute("data-jump") : null;',
    '  var items = Array.prototype.slice.call(document.querySelectorAll("#list .topic-item[data-jump]"));',
    '  var index = -1;',
    '  for (var i = 0; i < items.length; i++) {',
    '    if (items[i].getAttribute("data-jump") !== curId && items[i].offsetParent !== null) { index = i; break; }',
    '  }',
    '  if (index < 0) {',
    '    for (var j = 0; j < items.length; j++) {',
    '      if (items[j].getAttribute("data-jump") !== curId) { index = j; break; }',
    '    }',
    '  }',
    '  if (index < 0) return null;',
    '  return { index: index, name: items[index].querySelector(".nm").textContent };',
    '})()'
  ].join('\n'));
}

async function clickListItem(cdp, index, name) {
  await cdp.eval('document.querySelectorAll("#list .topic-item[data-jump]")[' + index + '].click()');
  await until(function () {
    return cdp.eval('!!document.querySelector("#detail .desc") && (() => { var h = document.querySelector("#detail h1"); return !!h && h.textContent === ' + JSON.stringify(name) + '; })()');
  }, '点目录项后 #detail h1 与正文更新');
}

/* ------------------------------------------------------------ 用例 3：手机点侧栏目录项 */
test('手机点侧栏目录项：抽屉关闭 + 详情进视口', async function () {
  const cdp = await openBrowser(MOBILE);
  try {
    await openDeepLink(cdp);
    const pick = await pickOtherListItem(cdp);
    assert.ok(pick, '侧栏里必须有另一个可点的知识点');
    await clickListItem(cdp, pick.index, pick.name);
    const m = await measure(cdp);
    assert.strictEqual(m.sideOpen, false, '选中后手机侧栏抽屉必须关闭');
    assertMobileRevealed(m, '手机点目录项');
    const errs = await pageErrors(cdp);
    assert.deepStrictEqual(errs, [], '点目录项零报错');
    console.log('       [列表点击] ' + JSON.stringify(m));
  } finally {
    guard.kill(chrome); chrome = null;
  }
});

/* ------------------------------------------------------------ 用例 4：重复点同一项不抖 */
test('手机重复点同一目录项：scrollY 完全不动', async function () {
  const cdp = await openBrowser(MOBILE);
  try {
    await openDeepLink(cdp);
    const pick = await pickOtherListItem(cdp);
    assert.ok(pick, '侧栏里必须有另一个可点的知识点');
    await clickListItem(cdp, pick.index, pick.name);
    const first = await measure(cdp);
    assert.ok(first.scrollY > 0, '第一次点击后页面必须已经滚动（scrollY=' + first.scrollY + '）');
    await clickListItem(cdp, pick.index, pick.name);
    await sleep(300);
    const again = await measure(cdp);
    assert.strictEqual(again.scrollY, first.scrollY,
      '重复选中同一节点 scrollY 必须完全相等，实际 ' + first.scrollY + ' → ' + again.scrollY);
    assert.ok(again.descTop >= 0 && again.descTop < again.innerHeight,
      '重复点击后介绍正文仍在首屏，实际 .desc top=' + again.descTop);
    const errs = await pageErrors(cdp);
    assert.deepStrictEqual(errs, [], '重复点击零报错');
    console.log('       [重复点击] ' + JSON.stringify(again));
  } finally {
    guard.kill(chrome); chrome = null;
  }
});

/* ------------------------------------------------------------ 用例 5：桌面回归 */
test('桌面 1280×800 深链：三栏布局与滚动行为不变', async function () {
  const cdp = await openBrowser(DESKTOP);
  try {
    await openDeepLink(cdp);
    await until(function () { return cdp.eval('document.getElementById("cy").dataset.ready === "1"'); }, '局部图落定');
    const layout = await cdp.eval([
      '(() => {',
      '  var ex = document.querySelector(".explore");',
      '  var cs = getComputedStyle(ex);',
      '  var side = document.getElementById("side");',
      '  var sideRect = side.getBoundingClientRect();',
      '  return {',
      '    display: cs.display,',
      '    columns: cs.gridTemplateColumns,',
      '    sideVisible: cs.display !== "none" && sideRect.width > 0 && sideRect.height > 0',
      '  };',
      '})()'
    ].join('\n'));
    assert.strictEqual(layout.display, 'grid', '.explore 桌面必须是 grid');
    assert.strictEqual(layout.columns.split(' ').filter(Boolean).length, 3,
      '桌面 grid 必须拆出 3 列，实际 ' + layout.columns);
    assert.strictEqual(layout.sideVisible, true, '桌面左侧目录必须可见');
    const m = await measure(cdp);
    assert.strictEqual(m.scrollY, 0, '桌面页面不滚动');
    assert.ok(m.descTop < m.innerHeight, '桌面详情正文本来就在首屏，实际 .desc top=' + m.descTop);
    assert.ok(m.scrollWidth <= m.innerWidth, '桌面不能横向溢出');

    const pick = await pickOtherListItem(cdp);
    assert.ok(pick, '桌面侧栏必须有另一个可点的知识点');
    await clickListItem(cdp, pick.index, pick.name);
    const after = await measure(cdp);
    assert.strictEqual(after.scrollY, 0, '桌面选中另一个知识点后页面仍不滚动');
    assert.ok(after.descTop < after.innerHeight, '桌面切换后详情正文仍在首屏，实际 .desc top=' + after.descTop);
    assert.ok(after.scrollWidth <= after.innerWidth, '桌面切换后仍不能横向溢出');
    const errs = await pageErrors(cdp);
    assert.deepStrictEqual(errs, [], '桌面回归零报错');
    console.log('       [桌面] ' + JSON.stringify(m) + ' columns=' + layout.columns);
  } finally {
    guard.kill(chrome); chrome = null;
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
