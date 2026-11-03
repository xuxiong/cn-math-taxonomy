#!/usr/bin/env node
/* 诊断「最后一题之后」死路守卫：node tests/test_result_deadend.js
 *
 * 背景（卡 t_07716ba2，P0）：
 *   单点诊断答完最后一题后点「下一题」毫无反应，诊断报告页永远出不来。两个独立成因：
 *   1) diagnose/app-flow.js 的 commit()：`const item = nextItem(...); if (!item) return;`
 *      —— 会话收敛后把点击静默吞掉，而结果页只有 render() 的收敛分支会调 renderResult()。
 *   2) 深链（?target=）进入时 init() 提前 return，children.js 根本不被请求 → CC 一直是 undefined，
 *      而 renderResult() 第二行的 saveToChild() 裸调 CC.current() 抛 TypeError，整页不渲染。
 *   两种成因都表现为「onerror 零报错 + 页面停在反馈态」，所以本文件两侧都测：
 *   - 表达层（真实 DOM，headless Chrome + 本机静态服务）：走真 UI，按钮文案 + 结果页根节点；
 *   - 收敛分支：把会话直接推到收敛态再调 commit()，确认它不再吞点击。
 *   不写「读源码找字符串」式的 change-detector —— 断言的都是运行结果。
 *
 * 需要 Node 22+（全局 WebSocket / fetch）和 Chrome/Chromium，可用 CHROME 指定浏览器路径。
 * 零 npm 依赖；测试服务器与浏览器资料写在系统临时目录。
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const E = require(path.join(ROOT, 'diagnose', 'engine.js'));

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

/* ------------------------------------------------------------ 1. 引擎层：收敛点在哪 */
const dataDir = path.join(ROOT, 'data');
const topics = JSON.parse(fs.readFileSync(path.join(dataDir, 'topics.json'), 'utf8'));
const deps = JSON.parse(fs.readFileSync(path.join(dataDir, 'dependencies.json'), 'utf8'));
const questions = JSON.parse(fs.readFileSync(path.join(dataDir, 'questions.json'), 'utf8'));
const G = E.buildGraph(topics, deps, questions);

test('引擎层：cnm_221 单点 + confirm=3，答对 3 题后 nextItem 为空且目标 mastered', function () {
  let s = E.createSession(G, ['cnm_221'], { confirm: 3 });
  const asked = [];
  for (let i = 0; i < 8; i++) {
    const it = E.nextItem(G, s);
    if (!it) break;
    asked.push(it.question.id);
    /* 前两题答完必须还有题（否则「最后一题」这个前提就不成立），第 3 题之后必须收敛 */
    s = E.applyAnswer(G, s, it.topicId, 'correct', { text: it.question.answer });
    if (s.answers.length < 3) assert.ok(E.nextItem(G, s), '第 ' + s.answers.length + ' 题答完不该收敛');
  }
  assert.strictEqual(asked.length, 3, 'confirm=3 应当正好 3 题，实际 ' + asked.join(','));
  assert.strictEqual(E.statusOf(s, 'cnm_221'), 'mastered');
  assert.strictEqual(E.nextItem(G, s), null, '第 3 题答对后 nextItem 必须为空 —— 正是 commit() 要接住的收敛点');
  /* 全对场景的结论：0 薄弱根因 / 0 路径。报告页「薄弱根因」显示的必须是这个 0，不是假数据。 */
  const sum = E.summarize(G, s);
  assert.strictEqual(sum.asked, 3);
  assert.deepStrictEqual(
    { weak: sum.weak.length, roots: sum.roots.length, shaky: sum.shaky.length, path: sum.path.length, untested: sum.untested.length },
    { weak: 0, roots: 0, shaky: 0, path: 0, untested: 0 }
  );
});

/* ------------------------------------------------------------ 2. 真实浏览器：整条路径 */
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cnm-result-deadend-'));
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
  /* 页面内所有报错都收上来：验收要求「onerror / unhandledrejection / console.error 零报错」。
   * 页面脚本运行前先装钩子（addScriptToEvaluateOnNewDocument），再加上 CDP 侧的
   * exceptionThrown / consoleAPICalled，三个来源合并成一份 errors。 */
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

const DEEP = '/diagnose/?target=cnm_221&seed=sg450mxq';

async function freshDeepLink(cdp, url) {
  await cdp.send('Page.navigate', { url: cdp.base + '/' });
  await until(function () { return cdp.eval('document.readyState === "complete"'); }, '首页加载');
  await cdp.eval('localStorage.clear()');
  await cdp.send('Page.navigate', { url: cdp.base + (url || DEEP) });
  await until(function () { return cdp.eval('!!document.getElementById("q-text")'); }, '深链出第一题');
}

async function pageErrors(cdp) {
  const inner = JSON.parse(await cdp.eval('JSON.stringify(window.__errs || [])'));
  return inner.concat(cdp.pageErrors);
}

/* 2a 收敛分支：会话已经收敛（nextItem 为 null）时点按钮/调 commit() 必须落到结果页 */
test('流程层：会话已收敛时 commit() 落到结果页（不再静默吞点击）', async function () {
  const cdp = await openBrowser();
  try {
    await freshDeepLink(cdp);
    /* 把会话推到「最后一题已答完」的收敛态：引擎层一样的脚本，只是跑在页面里，
     * 不经过 UI —— 模拟「答完最后一题之后那一次点击」。 */
    const conv = await cdp.eval([
      '(() => {',
      '  const D = window.DiagCore, E = D.E, S = D.S, G = S.D.graph;',
      '  for (let i = 0; i < 8; i++) {',
      '    const it = E.nextItem(G, S.session);',
      '    if (!it) break;',
      '    S.session = E.applyAnswer(G, S.session, it.topicId, "correct", { text: it.question.answer });',
      '  }',
      '  return { answers: S.session.answers.length, next: !!E.nextItem(G, S.session), status: E.statusOf(S.session, "cnm_221") };',
      '})()'
    ].join('\n'));
    assert.strictEqual(conv.next, false, '前置：会话应当已经收敛（nextItem 为空）');
    assert.strictEqual(conv.status, 'mastered');
    assert.strictEqual(conv.answers, 3);
    assert.strictEqual(await cdp.eval('typeof window.DiagFlow.commit'), 'function',
      'app-flow.js 必须导出 commit 供流程层测试直接调用（否则这条分支只能靠读源码假测）');
    assert.strictEqual(await cdp.eval('typeof window.CnmChildren'), 'undefined',
      '前置：深链进入时 children.js 不该被请求（首屏请求数上限守卫要求）');
    assert.strictEqual(await cdp.eval('!!document.getElementById("summary")'), false);

    await cdp.eval('window.DiagFlow.commit("correct")');
    await until(function () { return cdp.eval('!!document.getElementById("summary")'); }, '结果页根节点 #summary', 8000);
    const head = await cdp.eval('document.querySelector("#summary h2").textContent');
    assert.ok(head.indexOf('诊断结果') >= 0, '结果页标题应含「诊断结果」：' + head);
    const errs = await pageErrors(cdp);
    assert.deepStrictEqual(errs, [], '渲染结果页期间零报错（深链下 CC 未到货不许抛 TypeError）');
  } finally {
    chrome && chrome.kill('SIGKILL');
    chrome = null;
  }
});

/* 2b 真 UI：答满 3 题 → 按钮变「看结果」→ 点进去看到报告页 */
test('界面层：最后一题答对后按钮是「看结果」，点进去渲染诊断报告（四状态/薄弱根因/学习路径）', async function () {
  const cdp = await openBrowser();
  try {
    await freshDeepLink(cdp);
    const labels = [];
    for (let n = 0; n < 3; n++) {
      /* 正确答案从引擎取，不写死 —— 换题库/换 seed 也不假绿 */
      const item = await cdp.eval([
        '(() => { const it = window.DiagCore.E.nextItem(window.DiagCore.S.D.graph, window.DiagCore.S.session);',
        '  return it ? { type: it.question.type, answer: it.question.answer, qid: it.question.id } : null; })()'
      ].join('\n'));
      assert.ok(item, '第 ' + (n + 1) + ' 题必须存在');
      if (item.type === 'choice') {
        await cdp.eval('document.querySelector("[id=\\"choice-' + item.answer + '\\"]").click()');
      } else {
        await cdp.eval('(() => { const el = document.getElementById("ans"); el.value = ' + JSON.stringify(item.answer) +
          '; el.dispatchEvent(new Event("input", { bubbles: true })); })()');
      }
      await cdp.eval('document.getElementById("btn-submit").click()');
      await until(function () { return cdp.eval('!!document.getElementById("btn-next")'); }, '第 ' + (n + 1) + ' 题的「下一题」按钮');
      labels.push(await cdp.eval('document.getElementById("btn-next").textContent'));
      await cdp.eval('document.getElementById("btn-next").click()');
      if (n < 2) await until(function () { return cdp.eval('!!document.getElementById("q-text")'); }, '进入第 ' + (n + 2) + ' 题');
    }
    assert.deepStrictEqual(labels, ['下一题', '下一题', '看结果'],
      '前两题仍是「下一题」，最后一题必须改成「看结果」（旧版三题全是「下一题」，点下去毫无反应）');

    await until(function () { return cdp.eval('!!document.getElementById("summary")'); }, '点「看结果」后渲染出报告页', 8000);
    const view = await cdp.eval([
      '(() => ({',
      /* 口径诚实化（卡 t_54813ae7）：「已掌握」方块下面的小字，以及「接下来练什么」小结里的口径说明 */
      '  okSub: (function () { var e = document.querySelector("#summary .stat.ok .stat-sub"); return e ? e.textContent : null; })(),',
      '  advice: document.getElementById("advice-summary") ? document.getElementById("advice-summary").textContent : null,',
      '  title: document.querySelector("#summary h2").textContent,',
      '  stats: document.querySelector("#summary .stats").innerText.replace(/\\s+/g, " "),',
      '  roots: document.getElementById("roots") ? document.getElementById("roots").innerText.replace(/\\s+/g, " ").slice(0, 200) : null,',
      '  path: document.getElementById("path") ? document.getElementById("path").innerText.replace(/\\s+/g, " ").slice(0, 120) : null,',
      '  cards: Array.prototype.map.call(document.querySelectorAll("#root > .card, #root > details"), function (e) { return e.id || e.className; }),',
      '  cnmChildren: typeof window.CnmChildren',
      '}))()'
    ].join('\n'));
    assert.ok(view.title.indexOf('诊断结果') >= 0, '报告页标题：' + view.title);
    assert.ok(/已答题数/.test(view.stats) && /薄弱/.test(view.stats) && /已掌握/.test(view.stats) && /未测/.test(view.stats),
      '报告页要能看到四状态计数：' + view.stats);
    assert.ok(view.stats.indexOf('3 已答题数') === 0, '已答题数应为 3：' + view.stats);
    assert.ok(view.roots && view.roots.indexOf('没有。') >= 0,
      'cnm_221 全对场景下薄弱根因为 0 条，页面必须写「没有。」：' + view.roots);
    assert.ok(view.path && view.path.indexOf('不需要补课') >= 0, '全对时学习路径应写「不需要补课」：' + view.path);
    /* 口径诚实化（卡 t_54813ae7）：cnm_221 只答了 3 题、实测确认的只有 1 个点，其余 69 个是祖先闭包推断的。
     * 方块只写「70 已掌握」会被家长/学生读成「测了 70 个都掌握」，所以必须把两个数拆开。 */
    assert.strictEqual(view.okSub, '实测 1 / 推断 69', '「已掌握」方块要拆出实测/推断：' + view.okSub);
    assert.ok(view.stats.indexOf('实测 1 / 推断 69') >= 0, '拆分数要出现在统计行里：' + view.stats);
    assert.ok(view.advice && /已掌握」共 70 个/.test(view.advice) && /亲自答对测出来的 1 个/.test(view.advice) && /69 个是/.test(view.advice),
      '「接下来练什么」小结要说清 70 里 1 个实测、69 个推断：' + view.advice);
    assert.deepStrictEqual(view.cnmChildren, 'undefined', '深链页 CnmChildren 仍应是 undefined（没靠加载 children.js 绕过）');
    const errs = await pageErrors(cdp);
    assert.deepStrictEqual(errs, [], '整个答题 → 报告页过程零报错');
  } finally {
    chrome && chrome.kill('SIGKILL');
    chrome = null;
  }
});

/* 2c 未测节点：题量用满（?limit=1）后路径图上「没测过」的点必须能看出来 + 图例有这一项 */
const UNSET_DEEP = '/diagnose/?target=cnm_051&limit=1&seed=sg450mxq';

test('路径图：未测节点是灰虚线框（照旧画出来）且图例里有「未测」', async function () {
  const cdp = await openBrowser();
  try {
    await freshDeepLink(cdp, UNSET_DEEP);
    /* 答错一题就撞到题量上限（limit=1）：目标点判薄弱 → 它的先修进图，且都还是「未测」。
     * 用引擎推会话（等价于答完那一题），再走 commit() 的真实收敛分支到报告页。 */
    const conv = await cdp.eval([
      '(() => {',
      '  const D = window.DiagCore, E = D.E, S = D.S, G = S.D.graph;',
      '  const it = E.nextItem(G, S.session);',
      '  if (!it) return { err: "没有题" };',
      '  S.session = E.applyAnswer(G, S.session, it.topicId, "wrong", {});',
      '  const sum = E.summarize(G, S.session);',
      '  return { answers: S.session.answers.length, next: !!E.nextItem(G, S.session), untested: sum.untested.length };',
      '})()'
    ].join('\n'));
    assert.strictEqual(conv.next, false, '前置：limit=1 答一题就该收敛');
    assert.ok(conv.untested >= 1, '前置：这一轮必须有「未测」的知识点，否则这条断言测不到东西：' + JSON.stringify(conv));
    await cdp.eval('window.DiagFlow.commit("wrong")');
    await until(function () { return cdp.eval('!!document.getElementById("summary")'); }, '渲染报告页', 8000);
    await until(function () {
      return cdp.eval('!!window.__pathCy && document.getElementById("path-cy").dataset.ready === "1"');
    }, '路径图挂载完成', 20000);
    const g = await cdp.eval([
      '(() => {',
      '  const cy = window.__pathCy;',
      '  const unk = cy.nodes().filter(function (n) { return n.hasClass("unknown"); });',
      '  return {',
      '    nodes: cy.nodes().length,',
      '    unknown: unk.map(function (n) { return { id: n.id(), borderStyle: n.style("border-style"), borderColor: n.style("border-color"),',
      '      bgOpacity: n.style("background-opacity"), w: n.renderedWidth() }; }),',
      '    legend: document.querySelector("#graph .legend") ? document.querySelector("#graph .legend").textContent : null,',
      '    fold: document.getElementById("path-fold") ? !document.getElementById("path-fold").hidden : null',
      '  };',
      '})()'
    ].join('\n'));
    assert.ok(g.unknown.length >= 1, '路径图上必须有 class 含 unknown 的节点（照旧画出来，不许删）：' + JSON.stringify(g.unknown));
    assert.ok(g.nodes > g.unknown.length, '未测节点之外还要有其它节点，才谈得上「区分得开」：' + g.nodes);
    g.unknown.forEach(function (n) {
      assert.strictEqual(n.borderStyle, 'dashed', '未测节点必须是虚线边框：' + JSON.stringify(n));
      assert.ok(n.w > 0, '未测节点必须真的画在图上（renderedWidth > 0）：' + JSON.stringify(n));
    });
    assert.ok(g.unknown.some(function (n) { return Number(n.bgOpacity) < 1; }), '未测节点要半透明：' + JSON.stringify(g.unknown));
    assert.ok(g.legend && g.legend.indexOf('未测（灰虚线框）') >= 0, '图例必须有「未测」这一项：' + g.legend);
    const errs = await pageErrors(cdp);
    assert.deepStrictEqual(errs, [], '这一轮答题 → 报告页零报错');
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
