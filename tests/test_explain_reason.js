#!/usr/bin/env node
/* 追问离线气泡按 reason 区分文案 + 「再问一次」按钮 + 4xx 降级重试：node tests/test_explain_reason.js
 *
 * 背景（卡 t_6df579b6）：
 *   学生在「讲解 → AI 老师答疑（追问）」里频繁看到固定一句
 *   「AI 老师暂时离线，没回答上。稍后再问一次试试。」，但查不出原因。
 *   现在代码把 4 种完全不同的故障（timeout / network / http / llm）合并成同一句文案，
 *   追问路径连 console 日志都没有，HTTP 响应体也被丢弃。
 *
 * 本文件覆盖（spec 要求至少 5 条，前 4 条浏览器级，第 5 条纯函数级）：
 *   1. mock 对追问一律 500 → 离线气泡文案含 500、含 ask-retry 按钮、不含栈/URL，页面零报错
 *   2. 4xx 降级重试：第一次追问带 response_format 回 400，第二次不带回 200 → 正常回答
 *   3. 200 但 content 空 → 离线气泡必须是 llm 档文案
 *   4. 先 500 后 200 + 点「再问一次」→ 重试期间 pending、成功后正常回答、请求次数 +1
 *   5. noticeFor 对 timeout/network/http/llm/未知 各返回不同文案
 *
 * 需要 Node 22+（全局 WebSocket / fetch）和 Chrome/Chromium，可用 CHROME 指定浏览器路径。
 * 零 npm 依赖；测试服务器与浏览器资料写在系统临时目录。
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
const { until, sleep, chromePort, devtoolsJson } = require('./lib/wait');

const ROOT = path.resolve(__dirname, '..');

const tests = [];
let passed = 0;
let failed = 0;
function test(name, fn) { tests.push({ name: name, fn: fn }); }

/* ------------------------------------------------------------ 静态站 + mock LLM */
const out = guard.tempDir('cnm-ask-reason-');

/* 静态站：把仓库当静态根，/assets/stats-config.js 特判（同 test_result_deadend.js 套路） */
const staticServer = http.createServer(function (req, res) {
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

/* mock LLM 端点：不同源（另一个端口），带 CORS（spec 第 95 行要求处理 OPTIONS 预检）。
 * mock 策略由每个 test 用 setMock(fn) 注入；fn(body, askSeq) → {status, body, delay}。
 * 讲解请求（user 消息不含「学生的问题：」）一律回合法三步 JSON，让面板正常渲染。
 * 追问请求（user 消息含「学生的问题：」）走 mock 策略。 */
let mockFn = null;
const mockBodies = [];   // 记录每个收到的请求体，供断言「第几次请求」「有没有 response_format」
let askSeq = 0;          // 当前是第几次追问请求（1-based；讲解请求不计入）
function setMock(fn) { mockFn = fn; mockBodies.length = 0; askSeq = 0; }

function defaultExplainBody() {
  return { choices: [{ message: { content: JSON.stringify({
    prompt: '先想想怎么去括号？',
    hint: '注意符号要变号。',
    reveal: '去括号得2x-6=4-x-1，移项合并得3x=9，所以x=3。答案：x = 3'
  }) } }] };
}

function isAskBody(body) {
  return !!(body && body.messages && body.messages.some(function (m) {
    return m.role === 'user' && typeof m.content === 'string' && m.content.indexOf('学生的问题：') >= 0;
  }));
}

const llmServer = http.createServer(function (req, res) {
  const u = new URL(req.url, 'http://localhost');
  /* CORS 预检（spec 第 95 行） */
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'content-type, authorization',
      'Access-Control-Allow-Methods': 'POST, OPTIONS'
    });
    res.end();
    return;
  }
  if (req.method !== 'POST' || u.pathname !== '/v1/chat/completions') {
    res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
    res.end();
    return;
  }
  let raw = '';
  req.on('data', function (c) { raw += c; });
  req.on('end', function () {
    let body = null;
    try { body = JSON.parse(raw); } catch (e) { /* 落到空 */ }
    mockBodies.push(body);
    let resp;
    if (isAskBody(body)) {
      askSeq++;
      resp = mockFn ? mockFn(body, askSeq) : null;
      if (!resp) resp = { status: 200, body: { choices: [{ message: { content: '' } }] }, delay: 0 };
    } else {
      resp = { status: 200, body: defaultExplainBody(), delay: 0 };
    }
    setTimeout(function () {
      res.writeHead(resp.status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify(resp.body));
    }, resp.delay || 0);
  });
});

function askBodies() {
  return mockBodies.filter(isAskBody);
}

/* ------------------------------------------------------------ CDP（裸 CDP，同 test_result_deadend.js 套路） */
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
async function openBrowser() {
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
  return cdp;
}

async function pageErrors(cdp) {
  const inner = JSON.parse(await cdp.eval('JSON.stringify(window.__errs || [])'));
  return inner.concat(cdp.pageErrors);
}

/* ------------------------------------------------------------ 进入追问区的 UI 路径（spec 第 99-101 行） */
async function gotoAsk(cdp) {
  const staticBase = 'http://127.0.0.1:' + staticServer.address().port;
  const llmBase = 'http://127.0.0.1:' + llmServer.address().port + '/v1';
  await cdp.send('Page.navigate', { url: staticBase + '/' });
  await until(function () { return cdp.eval('document.readyState === "complete"'); }, '首页加载');
  await cdp.eval('localStorage.clear()');
  await cdp.send('Page.navigate', { url: staticBase + '/diagnose/?target=cnm_221&seed=sg450mxq&llm=' + encodeURIComponent(llmBase) });
  await until(function () { return cdp.eval('!!document.getElementById("q-text")'); }, '深链出第一题');
  /* 深链路径会跳过 whenIdle（app.js line 2116 if(resolved) return），导致 llm-config.js
   * 永远不被 Lazy.load。手动注入它，让 explain.js 加载时 PROXY 有值。
   * 注入后等 LLMConfig 到货，再点 skip 触发讲解面板 → explain.js 懒加载。 */
  await cdp.eval([
    '(function () {',
    '  var s = document.createElement("script");',
    '  s.src = ' + JSON.stringify('llm-config.js') + ';',
    '  document.head.appendChild(s);',
    '})()'
  ].join('\n'));
  await until(function () { return cdp.eval('!!window.LLMConfig'); }, 'LLMConfig 加载（手动注入）');
  await cdp.eval('document.getElementById("btn-skip").click()');
  await until(function () { return cdp.eval('!!document.getElementById("ask-input")'); }, '进讲解面板出追问输入框');
  await until(function () { return cdp.eval('!!window.Explain'); }, 'Explain 模块加载');
}

/* 输入 + 点问 AI 老师，合成一次 eval 防止中间重渲染丢值 */
async function typeAndAsk(cdp, text) {
  await cdp.eval([
    '(() => { const el = document.getElementById("ask-input");',
    '  el.value = ' + JSON.stringify(text) + ';',
    '  el.dispatchEvent(new Event("input", { bubbles: true }));',
    '  document.getElementById("btn-ask").click(); })()'
  ].join(''));
}

/* 取最后一条追问气泡的文本与结构 */
async function lastBubble(cdp) {
  return cdp.eval([
    '(() => { const items = document.querySelectorAll(".ask-item");',
    '  if (!items.length) return null;',
    '  const last = items[items.length - 1];',
    '  const a = last.querySelector(".ask-a");',
    '  return {',
    '    text: a ? a.innerText : null,',
    '    cls: a ? a.className : null,',
    '    offline: a ? a.classList.contains("offline") : false,',
    '    pending: a ? a.classList.contains("pending") : false,',
    '    hasRetry: a ? !!a.querySelector(".ask-retry") : false,',
    '    retryText: a && a.querySelector(".ask-retry") ? a.querySelector(".ask-retry").textContent : null',
    '  }; })()'
  ].join('\n'));
}

/* ------------------------------------------------------------ 1. 追问 500 → 离线气泡含 500 + ask-retry */
test('追问 500：离线气泡文案含 500、含 ask-retry 按钮、不含栈/URL，页面零报错', async function () {
  setMock(function () {
    return { status: 500, body: { error: 'upstream down' }, delay: 0 };
  });
  const cdp = await openBrowser();
  try {
    await gotoAsk(cdp);
    await typeAndAsk(cdp, '什么叫移项？');
    await until(function () { return cdp.eval('!!document.querySelector(".ask-a.offline")'); }, '离线气泡出现');
    const v = await lastBubble(cdp);
    assert.ok(v && v.text, '离线气泡应有文案');
    assert.ok(v.text.indexOf('500') >= 0, '文案应含 500：' + v.text);
    assert.ok(v.hasRetry, '离线气泡应含 ask-retry 按钮');
    assert.ok(v.retryText && v.retryText.indexOf('再问一次') >= 0, '按钮文字应为「再问一次」');
    assert.ok(!/Error|stack|http:\/\/|127\.0\.0\.1|base/.test(v.text), '文案不得含栈/URL/base：' + v.text);
    const errs = await pageErrors(cdp);
    assert.deepStrictEqual(errs, [], '页面零报错');
  } finally {
    guard.kill(chrome); chrome = null;
  }
});

/* ------------------------------------------------------------ 2. 4xx 降级重试 */
test('追问 4xx 降级：第一次带 response_format 回 400，第二次不带回 200 → 正常回答', async function () {
  setMock(function (body, n) {
    /* n 是追问序号（讲解请求不计入）：1=第一次追问（带 response_format）→ 400；2=降级重试（不带）→ 200 */
    if (n === 1) return { status: 400, body: { error: 'bad request' }, delay: 0 };
    return { status: 200, body: { choices: [{ message: { content: JSON.stringify({ text: '移项就是把项从一边挪到另一边，注意变号。', graph: null }) } }] }, delay: 0 };
  });
  const cdp = await openBrowser();
  try {
    await gotoAsk(cdp);
    await typeAndAsk(cdp, '什么叫移项？');
    await until(function () {
      return cdp.eval('(() => { const a = document.querySelector(".ask-item:last-child .ask-a"); return a && !a.classList.contains("offline") && !a.classList.contains("pending") && a.textContent.indexOf("老师：") >= 0; })()');
    }, '降级重试成功后应显示正常回答');
    const ab = askBodies();
    assert.ok(ab.length >= 2, '应至少收到 2 次追问请求，实际 ' + ab.length);
    assert.ok(ab[0].response_format, '第 1 次追问请求应带 response_format');
    assert.ok(!ab[1].response_format, '第 2 次追问请求不应带 response_format（降级去掉）');
  } finally {
    guard.kill(chrome); chrome = null;
  }
});

/* ------------------------------------------------------------ 3. 200 但 content 空 → llm 档文案 */
test('追问 200 但 content 空：离线气泡必须是 llm 档文案（含「空」、不等通用文案）', async function () {
  setMock(function () {
    return { status: 200, body: { choices: [{ message: { content: '' } }] }, delay: 0 };
  });
  const cdp = await openBrowser();
  try {
    await gotoAsk(cdp);
    await typeAndAsk(cdp, '什么叫移项？');
    await until(function () { return cdp.eval('!!document.querySelector(".ask-a.offline")'); }, '离线气泡出现');
    const v = await lastBubble(cdp);
    assert.ok(v && v.text, '离线气泡应有文案');
    assert.ok(v.text.indexOf('空') >= 0, 'llm 档文案应含「空」：' + v.text);
    assert.ok(v.text !== 'AI 老师暂时离线，没回答上。稍后再问一次试试。', '不得等于通用文案');
    assert.ok(!/Error|http:\/\/|127\.0\.0\.1/.test(v.text), '文案不得含 Error/URL：' + v.text);
  } finally {
    guard.kill(chrome); chrome = null;
  }
});

/* ------------------------------------------------------------ 4. 先 500 后 200 + 点「再问一次」 */
test('再问一次：先 500 后 200 → 重试期间 pending、成功后正常回答、请求次数 +1', async function () {
  setMock(function (body, n) {
    /* n=1 第一次追问 → 500；n=2 重试 → 延迟 400ms 回 200，确保 pending 能被观察到 */
    if (n === 1) return { status: 500, body: { error: 'down' }, delay: 0 };
    return { status: 200, body: { choices: [{ message: { content: JSON.stringify({ text: '移项就是把项从一边挪到另一边，注意变号。', graph: null }) } }] }, delay: 400 };
  });
  const cdp = await openBrowser();
  try {
    await gotoAsk(cdp);
    await typeAndAsk(cdp, '什么叫移项？');
    await until(function () { return cdp.eval('!!document.querySelector(".ask-a.offline")'); }, '第一次追问离线气泡出现');
    const before = askBodies().length;
    /* 点「再问一次」 */
    await cdp.eval('document.querySelector(".ask-retry").click()');
    /* 重试期间应出现 pending（200ms 内 poll） */
    let sawPending = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 3000) {
      if (await cdp.eval('!!document.querySelector(".ask-a.pending")')) { sawPending = true; break; }
      await sleep(100);
    }
    assert.ok(sawPending, '重试期间应出现 .ask-a.pending');
    /* 重试成功后应替换成正常回答 */
    await until(function () {
      return cdp.eval('(() => { const a = document.querySelector(".ask-item:last-child .ask-a"); return a && !a.classList.contains("offline") && !a.classList.contains("pending") && a.textContent.indexOf("老师：") >= 0; })()');
    }, '重试成功后应显示正常回答');
    const after = askBodies().length;
    assert.ok(after >= before + 1, '重试后追问请求次数应 +1：before=' + before + ' after=' + after);
  } finally {
    guard.kill(chrome); chrome = null;
  }
});

/* ------------------------------------------------------------ 5. 纯函数级：noticeFor 各 reason 文案不同 */
const E = require('../diagnose/engine.js');
const F = require('../diagnose/funclab.js');
function loadExplain() {
  const g = globalThis;
  g.window = g;
  g.DiagEngine = E;
  g.Funclab = F;
  delete require.cache[require.resolve('../diagnose/explain.js')];
  require('../diagnose/explain.js');
  return g.Explain;
}

test('noticeFor：timeout/network/http/llm/未知 各返回不同文案，http 含 500，都不含 Error/URL', function () {
  const X = loadExplain();
  assert.strictEqual(typeof X._noticeFor, 'function', '应导出 _noticeFor');
  const notices = {
    timeout: X._noticeFor('timeout'),
    network: X._noticeFor('network'),
    http: X._noticeFor('http', 500),
    llm: X._noticeFor('llm'),
    unknown: X._noticeFor('whatever-unknown')
  };
  /* 两两不同 */
  const vals = Object.values(notices);
  for (let i = 0; i < vals.length; i++) {
    for (let j = i + 1; j < vals.length; j++) {
      assert.notStrictEqual(vals[i], vals[j], '文案应两两不同：' + vals[i] + ' vs ' + vals[j]);
    }
  }
  /* http 含 500 */
  assert.ok(notices.http.indexOf('500') >= 0, 'http 文案应含 500：' + notices.http);
  /* 未知逐字保留通用文案（spec 第 38 行） */
  assert.strictEqual(notices.unknown, 'AI 老师暂时离线，没回答上。稍后再问一次试试。', '未知应逐字保留通用文案');
  /* 都不含 Error/URL */
  Object.keys(notices).forEach(function (k) {
    assert.ok(!/Error|http:\/\/|127\.0\.0\.1/.test(notices[k]), k + ' 文案不得含 Error/URL：' + notices[k]);
  });
  /* timeout/network/http/llm 都含「重试」二字（spec 表格要求） */
  ['timeout', 'network', 'http', 'llm'].forEach(function (k) {
    assert.ok(notices[k].indexOf('重试') >= 0, k + ' 文案应含「重试」：' + notices[k]);
  });
  /* http 状态码非三位数字时不带错误码（spec 第 36 行：/^\d{3}$/ 校验，不合法就不写） */
  assert.ok(X._noticeFor('http', 'abc').indexOf('abc') < 0, 'http 状态码非三位数字不得拼进文案');
  assert.ok(X._noticeFor('http', 12).indexOf('12') < 0, 'http 状态码 12 不是三位数字，不得拼进文案');
  assert.ok(X._noticeFor('http', 9999).indexOf('9999') < 0, 'http 状态码 9999 不是三位数字，不得拼进文案');
  /* http 不传状态码时不带错误码，但仍含「重试」 */
  const httpNoStatus = X._noticeFor('http');
  assert.ok(httpNoStatus.indexOf('重试') >= 0, 'http 不传状态码也应含「重试」：' + httpNoStatus);
  assert.ok(!/\d{3}/.test(httpNoStatus), 'http 不传状态码不应出现三位数字：' + httpNoStatus);
});

/* ------------------------------------------------------------ 跑 */
(async function main() {
  await new Promise(function (resolve, reject) { staticServer.once('error', reject); staticServer.listen(0, '127.0.0.1', resolve); });
  await new Promise(function (resolve, reject) { llmServer.once('error', reject); llmServer.listen(0, '127.0.0.1', resolve); });
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
  try { staticServer.close(); } catch (e) { /* 未监听 */ }
  try { llmServer.close(); } catch (e) { /* 未监听 */ }
  if (chrome) guard.kill(chrome);
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exitCode = 1;
})();
