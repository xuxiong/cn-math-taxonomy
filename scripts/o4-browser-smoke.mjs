#!/usr/bin/env node
/* O4 卡G：真浏览器端到端冒烟（真页面 + 真 serve.js + 本机 3000 网关真模型）。
 *
 *   node scripts/o4-browser-smoke.mjs
 *
 * 做三件事：
 *   1) 起一个空闲端口的 `scripts/serve.js`（/v1 同源反代到本机 127.0.0.1:3000 网关）；
 *   2) 用 tests/lib/chrome-guard.js 起自己的无头 Chrome（remote-debugging-port=0 + 自己的
 *      --user-data-dir），绝不连、不读、不杀 9222 上用户本人的 Chrome；
 *   3) 在 explore 知识点页走真实用户路径：点「让 AI 讲一遍」→ 5 段上屏 → 追问 2 轮 →
 *      切走再切回（不该再发请求），把事实写进 docs/o4-browser-smoke.md。
 *
 * 采样（低年级算术点，见卡面）：cnm_p006 5以内的加法（完整流程）、cnm_p019 凑十法 /
 * 20以内进位加法、cnm_p031 口算加法（后两个只验「点按钮 → 5 段出齐 + demo 有问句 +
 * 有『答案』行」）。
 *
 * 红线（脚本自己守住）：
 *   - 不写任何真实密钥：localStorage 里的 key 固定 'local-smoke'（本机网关不校验）；
 *   - 不碰 9222：本脚本从不读 9222、不按端口找进程，只操作自己 guard.launch() 起来的 pid；
 *   - 不 pkill：收尾只用 guard.kill(chrome) 与 serve 子进程的 pid；
 *   - 只读仓内文件，产物只写 tmp/o4-smoke/（gitignored）与 docs/o4-browser-smoke.md。
 *
 * 计数口径（卡面 §3.6 二选一）：页面内包 window.fetch，记录每次请求的 url/method/body，
 * 并把 /v1/chat/completions 的响应 body 抄一份（clone()，不改原响应）。所以下面所有
 * 「请求数」都是 window.fetch 计数，不是 CDP Network 计数。
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const guard = require('../tests/lib/chrome-guard.js');
const { until, chromePort, devtoolsJson } = require('../tests/lib/wait.js');

/* SEG_TITLES / SEG_KEYS 一律从模块读，脚本里不写死中文段标题（卡面 §3.1）。 */
const T = require('../diagnose/topic-explain.js');

/* 卡面 §3.4 固定文案：每条 AI 回复都必须带这一行（不许写成「已审核 / 已验证」）。 */
const BADGE = 'AI 生成 · 未经人工审核';
/* 卡面 §2 规定的配置注入值：key 只是占位（本机网关不校验），绝不放真实密钥。 */
const SMOKE_KEY = 'local-smoke';
const MODEL = 'default';

/* 低年级算术点，见卡面。full = 走完整七条取证；其余只验「点按钮 → 5 段 / 问句 / 答案行」。 */
const TOPICS = [
  { id: 'cnm_p006', note: '5以内的加法（grade 1）', full: true },
  { id: 'cnm_p019', note: '凑十法 / 20以内进位加法（grade 1）', full: false },
  { id: 'cnm_p031', note: '口算加法（grade 1）', full: false }
];

/* 失败上限，不是性能断言：真模型的讲解 + 2 轮追问在这台机器上通常 10–40s，
 * 推理长尾偶尔到 1 分钟以上；超时只用来「彻底没反应时尽快失败退出」。 */
const EXPLAIN_TIMEOUT_MS = 180000;
const CHAT_TIMEOUT_MS = 120000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();
const runId = nowIso().replace(/[-:.TZ]/g, '').slice(0, 14);

/* ================================================================
 * 0. 落地目录（tmp/ 已 gitignore，不入库）
 * ================================================================ */

const OUT = path.join(ROOT, 'tmp', 'o4-smoke');
const RAW = path.join(OUT, 'raw');
fs.mkdirSync(RAW, { recursive: true });

/* ================================================================
 * 0b. 文档落点与「卡 H 只 upsert 本节」的约定
 *    §1–§8 是卡 G 那一批的原始读数，脚本当年是整份覆盖写的；从卡 H 起只维护 §9。
 * ================================================================ */

const DOC_SMOKE = path.join(ROOT, 'docs', 'o4-browser-smoke.md');
const CARD_H_HEADING = '## 9. 卡 H 修后重跑：作答纪律 + 截断重发升档';

/** 有则整段替换、无则追加到文末（与 scripts/o4-live-acceptance.mjs 的同名函数同款）。 */
function upsertSection(docPath, heading, sectionText) {
  let cur = '';
  try { cur = fs.readFileSync(docPath, 'utf8'); } catch (e) { cur = ''; }
  const block = sectionText.replace(/\s*$/, '\n\n');
  const at = cur.indexOf(heading);
  if (at >= 0) {
    const rest = cur.slice(at + heading.length);
    const m = /\n## /.exec(rest);
    const end = m ? at + heading.length + m.index + 1 : cur.length;
    fs.writeFileSync(docPath, cur.slice(0, at) + block + cur.slice(end));
    return 'replaced';
  }
  fs.mkdirSync(path.dirname(docPath), { recursive: true });
  fs.writeFileSync(docPath, cur.replace(/\s*$/, '\n\n') + block);
  return 'appended';
}

/** 卡 H 一节：只写本次运行的事实与计数（3 个一年级点 + 请求数 + 耗时），不做质量判断。 */
function cardHSection(f) {
  const sec = [];
  const rows = f.topics || [];
  const msAvg = rows.length ? Math.round(rows.reduce((s, t) => s + t.ms, 0) / rows.length) : 0;
  const explainReqs = rows.reduce((s, t) => s + (t.requests ? t.requests.explainChat : 0), 0);
  sec.push(CARD_H_HEADING);
  sec.push('');
  sec.push('> 本节由 `scripts/o4-browser-smoke.mjs` 在**改完卡 H（讲解作答纪律 + 截断重发升档 `explainRetry` + `timeouts.chat` 45s）之后**重跑写入。§1–§8 是卡 G 那一批的历史读数，原样保留、未被覆盖。');
  sec.push('');
  sec.push('- 本次运行：`' + f.runId + '`（' + f.at + '）');
  sec.push('- 运行环境：node `' + f.node + '`；Chrome `' + f.chromePath + '`');
  sec.push('- 页面：`' + f.pageBase + '/explore/?t=<n>#<topicId>`（serve.js 端口 ' + f.servePort + '），模型配置注入与 §1 相同');
  sec.push('- 请求计数口径与 §1 相同：页面内包 `window.fetch`，只数「点按钮 → 5 段上屏」期间的增量');
  sec.push('');
  sec.push('### 9.1 三个知识点结果（对照 §1 卡 G 那一批）');
  sec.push('');
  sec.push('| topicId | 名称 | 5 段出齐 | demo 有问句 | demo 有答案行 | 请求数（讲解 / 全部 fetch） | 耗时 | 面板状态 |');
  sec.push('|---|---|---|---|---|---|---|---|');
  for (const t of rows) {
    sec.push('| `' + t.topicId + '` | ' + (t.note || '') + ' | ' + (t.allFive ? '是（' + t.segCount + ' 段）' : '否（' + t.segCount + ' 段）') +
      ' | ' + (t.demoHasQuestion ? '是' : '否') + ' | ' + (t.demoHasAnswerLine ? '是' : '否') +
      ' | ' + (t.requests ? t.requests.explainChat : '?') + ' / ' + (t.requests ? t.requests.allTotal : '?') +
      ' | ' + (t.ms / 1000).toFixed(1) + 's | `' + t.status + '` |');
  }
  sec.push('');
  sec.push('- 三个点讲解耗时合计 ' + (rows.reduce((s, t) => s + t.ms, 0) / 1000).toFixed(1) + 's，**平均 ' + (msAvg / 1000).toFixed(1) + 's**');
  sec.push('- 讲解请求合计 ' + explainReqs + ' 次（3 个点各 1 次为下限；多出来的那次就是页面按 `needsRefetch` 重发，重发那一次 `max_tokens` 用 `explainRetry`）');
  sec.push('- 卡 G 那一批（§1，runId `20261108024031`）：`cnm_p006` 16.0s / `cnm_p019` 10.2s / `cnm_p031` 55.3s（2 次请求、0 段、面板 `gate`）—— 两批数字可直接对照。');
  sec.push('');
  sec.push('### 9.2 逐点请求数（重发发生点）');
  sec.push('');
  sec.push('| topicId | 讲解请求数 | 是否发生重发 | 全部 fetch | 耗时 |');
  sec.push('|---|---|---|---|---|');
  for (const t of rows) {
    const n = t.requests ? t.requests.explainChat : 0;
    sec.push('| `' + t.topicId + '` | ' + n + ' | ' + (n > 1 ? '是（首答命中 `needsRefetch`）' : '否') + ' | ' + (t.requests ? t.requests.allTotal : '?') + ' | ' + (t.ms / 1000).toFixed(1) + 's |');
  }
  sec.push('');
  sec.push('### 9.3 其他取证（同一脚本，口径与 §2 / §5 相同）');
  sec.push('');
  if (f.p006 && f.p006.checks) {
    sec.push('- `cnm_p006` 七条取证：' + f.p006.checks.filter((c) => c.pass).length + '/' + f.p006.checks.length + ' 通过' +
      (f.p006.checks.filter((c) => !c.pass).length ? '（不通过：' + f.p006.checks.filter((c) => !c.pass).map((c) => '第 ' + c.no + ' 条').join('、') + '）' : ''));
  }
  sec.push('- 页面 console.error / uncaught exception：' + f.errors.consoleError.length + ' / ' + f.errors.exception.length);
  if (f.cleanup) {
    sec.push('- 收尾：本次自己的 Chrome 进程 ' + f.cleanup.ourProcsAfter + ' 个、主 pid 存活=' + f.cleanup.mainPidAliveAfter + '、serve 端口已释放=' + f.cleanup.servePortReleased);
  }
  sec.push('- 截图与原始报文：`tmp/o4-smoke/`（`tmp/` 在 `.gitignore` 内，不入库）');
  sec.push('');
  sec.push('本节同样不含任何「孩子能听懂 / 讲得清楚 / 质量好」类判断；只有 DOM 读数、布尔结论与请求计数。');
  sec.push('');
  return sec.join('\n');
}

/* ================================================================
 * 1. 极小 CDP 客户端（与 tests/test_children_browser.js 同款，无依赖）
 * ================================================================ */

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = [];
    ws.addEventListener('close', () => {
      for (const p of this.pending.values()) p.reject(new Error(p.method + ': CDP 连接已关闭'));
      this.pending.clear();
    });
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (!p) return;
        if (m.error) p.reject(new Error(p.method + ': ' + m.error.message));
        else p.resolve(m.result);
      } else {
        this.handlers.forEach((fn) => fn(m));
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error('CDP 无响应（25s 上限）: ' + method));
      }, 25000);
      this.pending.set(id, {
        method,
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); }
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('页面求值异常：' + JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
}

/* ================================================================
 * 2. 进程计数 / 端口 / 服务
 * ================================================================ */

/* 本机 Chrome 进程数（含 helpers）。只为报「退出前后一致」，不做任何 kill。 */
function chromeCount() {
  try {
    const out = execFileSync('ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    return out.split('\n').filter((line) => line.includes('Google Chrome')).length;
  } catch (e) {
    return -1;
  }
}

/* 命令行里提到本次临时 profile 目录的进程数（退出后必须为 0）。 */
function profileProcCount(dir) {
  try {
    const out = execFileSync('ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    return out.split('\n').filter((line) => line.includes(dir)).length;
  } catch (e) {
    return -1;
  }
}

/* 进程是否还活着（只 kill(pid,0) 探测，不发信号）。 */
function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

function findChrome() {
  const candidates = [
    process.env.CHROME,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ].filter(Boolean);
  for (const p of candidates) if (fs.existsSync(p)) return p;
  throw new Error('找不到 Chrome/Chromium，请设置 CHROME 环境变量');
}

/* ================================================================
 * 3. 页面内取证（全部只读 DOM，不改页面状态；唯一例外是点开 demo 的折叠与点按钮/发问）
 * ================================================================ */

const SEG_SNAPSHOT_EXPR = `(() => {
  var d = document.getElementById('detail');
  if (!d) return null;
  var segs = Array.prototype.slice.call(d.querySelectorAll('.tai-seg'));
  return segs.map(function (s) {
    var titleEl = s.querySelector('.tai-seg-title');
    var title = titleEl ? titleEl.textContent : '';
    var kids = Array.prototype.slice.call(s.children);
    var body = kids.filter(function (k) { return k !== titleEl; });
    var list = s.querySelector('ul,ol');
    var q = s.querySelector('.tai-q');
    var ans = s.querySelector('details.tai-ans');
    /* 行 = 段标题之后的每个子节点的渲染文本逐行拆开（不含段标题本身，
     * 也不含关闭状态下 details 里的内容 —— innerText 天然不返回折叠内容）。 */
    var rows = [];
    body.forEach(function (k) {
      String(k.innerText || '').replace(/\\r/g, '').split('\\n').forEach(function (x) {
        x = x.trim();
        if (x) rows.push(x);
      });
    });
    var isDemo = String(s.className).indexOf('tai-seg-demo') >= 0;
    return {
      cls: s.className,
      title: title,
      childTags: kids.map(function (k) { return k.tagName.toLowerCase(); }),
      listTag: list ? list.tagName.toLowerCase() : '',
      liCount: list ? list.querySelectorAll('li').length : 0,
      firstRow: isDemo && q ? q.textContent : (rows.length ? rows[0] : ''),
      rows: rows,
      qText: q ? q.textContent : '',
      /* 「题面是第一行」按段标题之后的第一个子节点算（段标题 h3 不算内容行）。 */
      qIsFirstChild: body.length > 0 && body[0] === q,
      answer: ans ? {
        summary: ans.querySelector('summary') ? ans.querySelector('summary').textContent : '',
        closedText: ans.innerText,
        answerLine: ans.querySelector('p') ? ans.querySelector('p').textContent : ''
      } : null
    };
  });
})()`;

const PANEL_SNAPSHOT_EXPR = `(() => {
  var d = document.getElementById('detail');
  if (!d) return null;
  var badges = Array.prototype.slice.call(d.querySelectorAll('.tai-badge')).map(function (b) { return b.textContent; });
  var bubbles = Array.prototype.slice.call(d.querySelectorAll('.tai-bubble'));
  var wrap = d.querySelector('.tai-bubbles');
  var wrapRect = wrap ? wrap.getBoundingClientRect() : null;
  var input = d.querySelector('.tai-input');
  var send = d.querySelector('.tai-send');
  return {
    segCount: d.querySelectorAll('.tai-seg').length,
    badges: badges,
    status: d.querySelector('.tai-gate') ? 'gate'
      : d.querySelector('.tai-error') ? 'error'
      : d.querySelector('.tai-noconfig') ? 'noconfig'
      : d.querySelector('.tai-line') ? 'loading'
      : d.querySelectorAll('.tai-seg').length === 5 ? 'ready'
      : d.querySelector('.tai-btn') ? 'idle' : 'unknown',
    statusText: (function () {
      var el = d.querySelector('.tai-gate') || d.querySelector('.tai-error') || d.querySelector('.tai-noconfig') || d.querySelector('.tai-line');
      return el ? el.textContent : '';
    })(),
    bubbles: bubbles.map(function (b) {
      var r = b.getBoundingClientRect();
      return {
        cls: b.className,
        text: b.textContent,
        left: Math.round(r.left * 100) / 100,
        right: Math.round(r.right * 100) / 100,
        hasBadge: b.textContent.indexOf(${JSON.stringify(BADGE)}) >= 0
      };
    }),
    wrap: wrapRect ? { left: Math.round(wrapRect.left * 100) / 100, right: Math.round(wrapRect.right * 100) / 100 } : null,
    input: input ? { disabled: !!input.disabled, value: input.value, placeholder: input.placeholder } : null,
    send: send ? { disabled: !!send.disabled } : null,
    chatError: d.querySelector('.tai-chat-error') ? d.querySelector('.tai-chat-error').textContent : ''
  };
})()`;

/* ================================================================
 * 4. 主流程
 * ================================================================ */

const facts = {
  runId,
  at: nowIso(),
  node: process.version,
  chromePath: '',
  servePort: 0,
  pageBase: '',
  segKeys: T.SEG_KEYS.slice(),
  segTitles: T.SEG_KEYS.map((k) => T.SEG_TITLES[k]),
  badge: BADGE,
  topics: [],
  p006: null,
  errors: { consoleError: [], exception: [], logNetwork: [] },
  cleanup: null,
  notes: []
};

let chrome = null;
let cdp = null;
let server = null;
let serveLog = '';

async function main() {
  const chromeBefore = chromeCount();

  /* --- 4.1 本地服务：空闲端口，避开 8920 / 3000 / 8791 --- */
  let port = await freePort();
  for (let i = 0; i < 20 && [8920, 3000, 8791].includes(port); i++) port = await freePort();
  facts.servePort = port;
  facts.pageBase = 'http://127.0.0.1:' + port;
  server = spawn(process.execPath, [path.join(ROOT, 'scripts', 'serve.js'), String(port)], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', (b) => { serveLog += String(b); });
  server.stderr.on('data', (b) => { serveLog += String(b); });
  await until(async () => {
    try {
      const r = await fetch(facts.pageBase + '/explore/');
      return r.ok;
    } catch (e) {
      return false;
    }
  }, 'serve.js 就绪（GET /explore/ 200）', 30000);

  /* --- 4.2 自己的无头 Chrome：port=0 + 自己的 user-data-dir --- */
  facts.chromePath = findChrome();
  const out = guard.tempDir('cnm-o4-smoke-');
  const profile = path.join(out, 'profile');
  const profileArg = '--user-data-dir=' + profile;
  chrome = guard.launch(facts.chromePath, [
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=0',
    profileArg,
    '--no-sandbox',
    '--disable-gpu',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-extensions',
    '--disable-component-update',
    'about:blank'
  ], { logFile: path.join(out, 'chrome.log') });
  const dbgPort = await chromePort(path.join(profile, 'DevToolsActivePort'), 'Chrome debugger');
  const tabs = await devtoolsJson(dbgPort);
  const tab = tabs.find((t) => t.type === 'page');
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  cdp = new CDP(ws);

  cdp.handlers.push((m) => {
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      facts.errors.consoleError.push(m.params.args.map((a) => a.value !== undefined ? String(a.value) : (a.description || a.type)).join(' '));
    } else if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      facts.errors.exception.push((d.exception && (d.exception.description || d.exception.value)) || d.text);
    } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      facts.errors.logNetwork.push(m.params.entry.source + ': ' + m.params.entry.text);
    }
  });
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  await cdp.send('Log.enable');
  /* 不绕 Service Worker：本机 serve.js 的 sw 会把 .json 缓存住，重复跑读数会变。
   * 这是「重复跑一致」的必要条件，不是放宽判据。 */
  await cdp.send('Network.setBypassServiceWorker', { bypass: true });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1200, deviceScaleFactor: 1, mobile: false });

  /* --- 4.3 页面加载前注入：模型配置 + fetch 计数 + 错误钩子 --- */
  const inject = `(function () {
  try {
    localStorage.setItem('cnmDiagnose.llm', JSON.stringify(${JSON.stringify({ base: facts.pageBase + '/v1', model: MODEL, key: SMOKE_KEY })}));
  } catch (e) {}
  var S = window.__o4smoke = { fetch: [], errors: [], rejections: [] };
  var orig = window.fetch;
  if (typeof orig === 'function') {
    window.fetch = function (input, init) {
      var url = '';
      try { url = (typeof input === 'string') ? input : (input && input.url) ? input.url : String(input); } catch (e) {}
      var rec = { url: String(url), method: (init && init.method) || (input && input.method) || 'GET', at: Date.now() };
      if (init && typeof init.body === 'string') rec.body = init.body;
      S.fetch.push(rec);
      var p = orig.apply(this, arguments);
      return p.then(function (res) {
        rec.status = res.status;
        try {
          if (rec.url.indexOf('/v1/chat/completions') >= 0) {
            res.clone().text().then(function (t) { rec.resp = t; }, function () {});
          }
        } catch (e) {}
        return res;
      });
    };
  }
  window.addEventListener('error', function (e) { try { S.errors.push(String(e.message || e.error)); } catch (err) {} }, true);
  window.addEventListener('unhandledrejection', function (e) { try { S.rejections.push(String((e.reason && e.reason.message) || e.reason)); } catch (err) {} });
})();`;
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: inject });

  try {
    /* --- 4.4 cnm_p006 完整流程先跑：必须从空 localStorage 起。
     * 讲解有 localStorage 缓存（readCache），若先跑别的点再整页重进来，p006 会直接命中缓存、
     * 一个网关请求都不发 —— 那样这张卡就白测了。所以 p006 排在最前，且不带任何预热点。 --- */
    facts.p006 = await runFullFlow();
    facts.topics.push(facts.p006.row);
    await heartbeat('cnm_p006 完整流程完成');
    /* --- 4.5 另外两个点：各自整页加载，缓存键不同 → 仍走真网关 --- */
    for (const topic of TOPICS.filter((t) => !t.full)) {
      facts.topics.push(await runTopic(topic));
      await heartbeat(topic.id + ' 完成');
    }
    /* --- 4.6 首点竞态探针：只记录事实（源码不归本卡改） --- */
    facts.mountRace = await probeMountRace();
    await heartbeat('首点竞态探针完成');
    /* --- 4.6b 失败点的旁证：Node 侧重放同一份请求体（无页面 30s 超时） --- */
    facts.replay = await replayFailedTopics();
    await heartbeat('失败点旁证重放完成');
  } finally {
    /* --- 4.7 收尾：只杀自己起的 pid，先 Chrome 再 serve ---
     * 判据不用「本机 Chrome 进程总数前后相等」——本机还开着用户自己的浏览器，它在我们跑
     * 这几分钟里会自己开关标签/渲染进程（实测两次跑基线从 40 掉到 36）。可判的是：
     * ①命令行里提到本次临时 profile 的进程数归零；②本次 Chrome 主 pid 不再存活。 */
    const chromeAliveBefore = chromeCount();
    const ourProcsAtCleanup = profileProcCount(profile);
    const mainPid = chrome && chrome.pid;
    if (cdp) { try { cdp.ws.close(); } catch (e) { /* 已断 */ } }
    if (chrome) guard.kill(chrome);
    const waitStart = Date.now();
    let ours = profileProcCount(profile);
    while ((ours !== 0 || pidAlive(mainPid)) && Date.now() - waitStart < 20000) {
      await sleep(250);
      ours = profileProcCount(profile);
    }
    const after = chromeCount();
    if (server) {
      server.kill('SIGTERM');
      await Promise.race([
        new Promise((r) => server.once('exit', r)),
        sleep(5000).then(() => { try { server.kill('SIGKILL'); } catch (e) { /* 已退 */ } })
      ]);
    }
    const released = await portFree(port);
    facts.cleanup = {
      chromeBefore,
      chromeAliveBefore,
      chromeAfter: after,
      totalDelta: after - chromeBefore,
      chromeSame: after === chromeBefore,
      ourProcsAtCleanup,
      ourProcsAfter: ours,
      profileProcLeft: ours,
      mainPid,
      mainPidAliveAfter: pidAlive(mainPid),
      servePort: port,
      servePortReleased: released,
      serveLogTail: serveLog.trim().split('\n').slice(-6).join('\n')
    };
  }

  writeRawAndDoc();
}

async function heartbeat(label) {
  process.stdout.write('[o4-smoke] ' + label + ' @ ' + new Date().toTimeString().slice(0, 8) + '\n');
}

/* 打开一个知识点页：每次都用带唯一 query 的完整 URL，保证是真「首次进页面」（新文档、模块重新加载），
 * 而不是同文档改 hash —— 后者会复用已加载的模块与 STATE，测不到「第一次点按钮」那条路径。 */
let navSeq = 0;
async function openTopic(topicId, opts) {
  navSeq++;
  const url = facts.pageBase + '/explore/?t=' + navSeq + '#' + encodeURIComponent(topicId);
  await cdp.send('Page.navigate', { url });
  await until(() => cdp.eval('!!document.getElementById("detail") && !!document.querySelector("#detail .tai-btn, #detail .tai-seg")'), '知识点页渲染（detail + AI 入口）', 30000);
  if (!opts || opts.settled !== false) await waitPanelIdle(topicId);
}

/* 等详情面板「落定」再点按钮。
 *
 * 为什么必须等：renderDetail 在详情 bundle 回来（ensureDetail）与样题 bundle 回来
 * （loadQuestionsFor）之后各重绘一次，每次都会 replaceChildren 换掉 .tai 盒子。
 * 按钮一出现就点，mountTopicAI 拿到的是马上要被换掉的旧盒子，讲解画进脱离文档的节点里，
 * 面板看起来「点了没反应」（实测见 tmp/o4-smoke 首跑 + docs 的未成立项）。
 * 判据：课标条目块已渲染（详情合并完成）+ 页面内所有 fetch 都有 status（无在飞）
 * + 连续 3 次采样节点数不变。这是等状态，不是等固定时长。 */
async function waitPanelIdle(topicId) {
  let last = -1;
  let stable = 0;
  await until(async () => {
    const s = await cdp.eval(`(() => {
      var f = (window.__o4smoke && window.__o4smoke.fetch) || [];
      var inflight = f.filter(function (x) { return !x.status; }).length;
      var d = document.getElementById('detail');
      var hasStd = !!d && Array.prototype.slice.call(d.querySelectorAll('h2')).some(function (h) { return h.textContent.indexOf('课标条目') >= 0; });
      return { inflight: inflight, hasStd: hasStd, nodes: d ? d.querySelectorAll('*').length : 0 };
    })()`);
    if (s.hasStd && s.inflight === 0 && s.nodes === last) stable++; else stable = 0;
    last = s.nodes;
    return stable >= 3;
  }, topicId + ' 详情面板落定（课标条目已渲染 + 无在飞请求 + 节点数稳定）', 45000);
}

/* 点「让 AI 讲一遍」，等到 5 段出齐 / 或页面给出 gate/error/noconfig。 */
async function clickAndWaitExplain() {
  const t0 = Date.now();
  /* 已在 loading / ready 时不再点（点了也没用：loading 态按钮是 disabled）。 */
  const clicked = await cdp.eval(`(() => {
    var d = document.getElementById('detail');
    if (!d) return 'no-detail';
    if (d.querySelectorAll('.tai-seg').length === 5) return 'already-ready';
    var hint = d.querySelector('.tai-gate, .tai-error, .tai-noconfig');
    if (hint) return 'already-' + hint.className;
    var b = d.querySelector('.tai-btn');
    if (!b) return 'no-btn';
    if (b.disabled) return 'already-loading';
    b.click();
    return 'clicked';
  })()`);
  if (clicked === 'no-btn' || clicked === 'no-detail') throw new Error('没找到「让 AI 讲一遍」按钮（' + clicked + '）');
  const state = await until(async () => {
    const s = await cdp.eval(PANEL_SNAPSHOT_EXPR);
    if (s.status === 'ready' || s.status === 'gate' || s.status === 'error' || s.status === 'noconfig') return s;
    return false;
  }, 'AI 讲解上屏（5 段 / gate / error / noconfig）', EXPLAIN_TIMEOUT_MS);
  return { state, ms: Date.now() - t0 };
}

async function fetchStats() {
  return cdp.eval(`(() => {
    var s = window.__o4smoke || { fetch: [] };
    var list = s.fetch || [];
    var chat = list.filter(function (f) { return String(f.url).indexOf('/v1/chat/completions') >= 0; });
    return {
      total: list.length,
      chat: chat.length,
      chatUrls: chat.map(function (f) { return f.url; }),
      all: list.map(function (f) { return f.method + ' ' + f.url + (f.status ? ' → ' + f.status : ''); })
    };
  })()`);
}

async function dumpRaw(tag) {
  const recs = await cdp.eval(`(() => {
    var s = window.__o4smoke || { fetch: [] };
    return (s.fetch || []).filter(function (f) { return String(f.url).indexOf('/v1/chat/completions') >= 0; });
  })()`);
  const dir = path.join(RAW, runId);
  fs.mkdirSync(dir, { recursive: true });
  recs.forEach((r, i) => {
    const file = path.join(dir, tag + '-' + String(i + 1).padStart(2, '0') + '.json');
    let body = null;
    try { body = r.body ? JSON.parse(r.body) : null; } catch (e) { body = r.body; }
    let resp = null;
    try { resp = r.resp ? JSON.parse(r.resp) : null; } catch (e) { resp = r.resp; }
    fs.writeFileSync(file, JSON.stringify({
      url: r.url, method: r.method, status: r.status,
      request: body, response: resp
    }, null, 2));
  });
  return { dir, count: recs.length, records: recs };
}

async function shot(name) {
  const rect = await cdp.eval(`(() => {
    var box = document.querySelector('#detail .tai');
    if (!box) return null;
    var r = box.getBoundingClientRect();
    return {
      x: Math.max(0, r.left + window.scrollX - 8),
      y: Math.max(0, r.top + window.scrollY - 8),
      width: Math.min(1280, r.width + 16),
      height: Math.min(6000, r.height + 16)
    };
  })()`);
  const params = { format: 'png', captureBeyondViewport: true };
  if (rect) params.clip = { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 };
  const data = (await cdp.send('Page.captureScreenshot', params)).data;
  const file = path.join(OUT, name + '.png');
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
}

/* 只验「点按钮 → 5 段出齐 + demo 有问句 + 有『答案』行」的三个点。 */
async function runTopic(topic) {
  await openTopic(topic.id);
  /* 基数在「点按钮之前」取：表的「请求数」= 点按钮 → 5 段上屏期间新增的 fetch，
   * 不含进页面时的数据请求（那些与 AI 无关）。 */
  const before = await fetchStats();
  const res = await clickAndWaitExplain();
  const snap = await cdp.eval(SEG_SNAPSHOT_EXPR);
  const after = await fetchStats();
  const raw = await dumpRaw(topic.id);
  const png = await shot(topic.id);
  const segs = snap || [];
  const demo = segs.find((s) => /tai-seg-demo/.test(s.cls)) || null;
  const row = {
    topicId: topic.id,
    note: topic.note,
    status: res.state.status,
    statusText: res.state.statusText,
    ms: res.ms,
    segCount: segs.length,
    titles: segs.map((s) => s.title),
    allFive: segs.length === 5,
    demoHasQuestion: !!(demo && /[？?]/.test(demo.qText || '')),
    demoQuestionText: demo ? demo.qText : '',
    demoHasAnswerLine: !!(demo && demo.answer && /^答案/.test((demo.answer.answerLine || '').trim())),
    requests: { explainTotal: after.total - before.total, explainChat: after.chat - before.chat, allTotal: after.total, allChat: after.chat },
    segs: segs.map((s) => ({ key: (s.cls.match(/tai-seg-(\w+)/) || [])[1] || '', title: s.title, listTag: s.listTag, liCount: s.liCount, firstRow: s.firstRow })),
    screenshot: path.relative(ROOT, png),
    rawDir: path.relative(ROOT, raw.dir),
    rawCount: raw.count
  };
  return row;
}

/* 「按钮一出现就点」的探针：显式复现首点竞态，只记录事实，不改源码。 */
async function probeMountRace() {
  const out = { steps: [], firstClick: '', segsAfterFirst: 0, secondClick: '', segsAfterSecond: 0 };
  navSeq++;
  await cdp.send('Page.navigate', { url: facts.pageBase + '/explore/?t=' + navSeq + '#cnm_p006' });
  await until(() => cdp.eval('!!document.querySelector("#detail .tai-btn")'), '竞态探针：按钮出现', 30000);
  const s0 = await fetchStats();
  out.firstClick = await cdp.eval(`(() => {
    var b = document.querySelector('#detail .tai-btn');
    if (!b) return 'no-btn';
    if (b.disabled) return 'disabled';
    b.click();
    return 'clicked';
  })()`);

  const t1 = Date.now();
  let best = 0;
  while (Date.now() - t1 < 15000) {
    const n = await cdp.eval(`document.querySelectorAll('#detail .tai-seg').length`);
    if (n > best) best = n;
    if (n === 5) break;
    await sleep(250);
  }
  out.segsAfterFirst = best;
  out.msAfterFirst = Date.now() - t1;
  out.waitAfterFirst = '15s 内轮询可见面板 .tai-seg 数';
  out.visibleAfterFirst = await cdp.eval(`(() => { var b = document.getElementById('detail').querySelector('.tai'); return b ? b.innerHTML.slice(0, 200) : null; })()`);
  const s1 = await fetchStats();
  out.phase1 = { total: s1.total - s0.total, chat: s1.chat - s0.chat };

  if (best < 5) {
    out.secondClick = await cdp.eval(`(() => {
      var b = document.querySelector('#detail .tai-btn');
      if (!b) return 'no-btn';
      if (b.disabled) return 'disabled';
      b.click();
      return 'clicked';
    })()`);
    const t2 = Date.now();
    let best2 = 0;
    while (Date.now() - t2 < 60000) {
      const n = await cdp.eval(`document.querySelectorAll('#detail .tai-seg').length`);
      if (n > best2) best2 = n;
      if (n === 5) break;
      await sleep(250);
    }
    out.segsAfterSecond = best2;
    out.msAfterSecond = Date.now() - t2;
    const s2 = await fetchStats();
    out.phase2 = { total: s2.total - s1.total, chat: s2.chat - s1.chat };
  }
  out.verdict = out.segsAfterFirst === 5
    ? '按钮一出现就点也能上屏（本次未复现竞态）'
    : '按钮一出现就点 → 可见面板 ' + out.segsAfterFirst + ' 段（15s 内没上屏）；再点一次 → ' + out.segsAfterSecond + ' 段' +
      (out.phase2 ? '，且第二轮讲解请求增量 = ' + out.phase2.chat : '');
  return out;
}

/* 失败点的旁证：把页面当时发出的同一份请求体（落盘在 raw/<runId>/<topic>-NN.json 的 request 字段）
 * 由脚本在 Node 侧重放一次 —— Node 侧没有页面那个 30s 客户端超时，用来区分
 * 「网关真的不给正文」与「页面等不到」。只重放 status !== ready 的点。 */
async function replayFailedTopics() {
  const out = [];
  for (const t of facts.topics) {
    if (t.status === 'ready') continue;
    const dir = path.join(ROOT, t.rawDir);
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter((f) => f.indexOf(t.topicId + '-') === 0).sort();
    const runs = [];
    for (const f of files) {
      const rec = { file: f };
      let j = null;
      try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { runs.push({ file: f, error: '读不出落盘记录' }); continue; }
      rec.pageStatus = (j.status === undefined) ? '（页面侧已 abort，未拿到响应）' : j.status;
      if (!j.request) { rec.error = '落盘里没有 request body'; runs.push(rec); continue; }
      const t0 = Date.now();
      try {
        const res = await fetch(facts.pageBase + '/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(j.request)
        });
        const text = await res.text();
        let body = null;
        try { body = JSON.parse(text); } catch (e) { body = null; }
        const ch = body && body.choices && body.choices[0];
        const content = ch && ch.message ? String(ch.message.content || '') : '';
        rec.http = res.status;
        rec.finish = ch ? ch.finish_reason : null;
        rec.contentLen = content.length;
        rec.contentHead = content.slice(0, 200);
        rec.usage = body && body.usage ? body.usage : null;
        rec.rawHead = text.slice(0, 200);
      } catch (e) {
        rec.error = String((e && e.message) || e);
      }
      rec.ms = Date.now() - t0;
      runs.push(rec);
    }
    out.push({ topicId: t.topicId, note: t.note, panelStatus: t.status, runs });
  }
  return out;
}

/* cnm_p006 完整流程：七条逐条取证。 */
async function runFullFlow() {
  const topic = TOPICS[0];
  const out = { topicId: topic.id, checks: [] };

  /* 从干净的一次整页加载开始（空 localStorage → 讲解不会命中页面缓存）。 */
  await openTopic(topic.id);
  const before = await fetchStats();
  const explainT0 = Date.now();
  const res = await clickAndWaitExplain();
  const explainMs = Date.now() - explainT0;
  const afterExplain = await fetchStats();

  const snap = (await cdp.eval(SEG_SNAPSHOT_EXPR)) || [];
  const panel = await cdp.eval(PANEL_SNAPSHOT_EXPR);

  /* --- 第 1 条：5 个段标题，顺序取自 SEG_TITLES --- */
  const titles = snap.map((s) => s.title);
  const expected = T.SEG_KEYS.map((k) => T.SEG_TITLES[k]);
  out.checks.push({
    no: 1,
    name: '点「让 AI 讲一遍」后出现 5 个段标题，顺序与 topic-explain.js 的 SEG_TITLES 一致',
    pass: titles.length === 5 && JSON.stringify(titles) === JSON.stringify(expected),
    detail: '实际 = ' + JSON.stringify(titles) + '；期望 = ' + JSON.stringify(expected),
    dom: snap.map((s) => '<section class="' + s.cls + '"><h3 class="tai-seg-title">' + s.title + '</h3>').join(' ')
  });

  /* --- 第 2 条：how 是 <ol> 且 ≥2 li；what/why/trap 是 <ul> --- */
  const byKey = (k) => snap.find((s) => s.cls.indexOf('tai-seg-' + k) >= 0) || null;
  const how = byKey('how');
  const listChecks = ['what', 'why', 'trap'].map((k) => ({ k, ok: !!(byKey(k) && byKey(k).listTag === 'ul') }));
  out.checks.push({
    no: 2,
    name: 'how 段是 <ol> 且至少 2 个 <li>；what/why/trap 是 <ul>',
    pass: !!(how && how.listTag === 'ol' && how.liCount >= 2) && listChecks.every((x) => x.ok),
    detail: 'how=' + (how ? how.listTag + '/' + how.liCount + ' li' : '缺失') + '；' +
      listChecks.map((x) => x.k + '=' + (byKey(x.k) ? byKey(x.k).listTag || '(无列表)' : '缺失')).join('，'),
    dom: snap.map((s) => '<' + (s.listTag || 'none') + ' class="' + (s.listTag === 'ol' ? 'tai-steps' : 'tai-list') + '"> × ' + s.liCount + '</' + (s.listTag || '') + '>').join(' ')
  });

  /* --- 第 3 条：demo 第一行是题面且含问句；末行「答案」是可点开的折叠 --- */
  const demo = byKey('demo');
  let answerToggle = null;
  if (demo && demo.answer) {
    const beforeText = demo.answer.closedText || '';
    await cdp.eval(`(() => { var s = document.querySelector('#detail .tai-seg-demo details.tai-ans summary'); if (s) s.click(); })()`);
    await sleep(120);
    const opened = await cdp.eval(`(() => {
      var d = document.querySelector('#detail .tai-seg-demo details.tai-ans');
      if (!d) return null;
      return { open: d.open, text: d.innerText };
    })()`);
    answerToggle = { beforeText, afterText: opened.text, open: opened.open, changed: (opened.text || '') !== beforeText };
  }
  out.checks.push({
    no: 3,
    name: 'demo 段：第一行是题面且含问句；末行「答案」被渲染成可点开的折叠（点开后文本变化）',
    pass: !!(demo && /[？?]/.test(demo.qText || '') && demo.qIsFirstChild && demo.answer && /^答案/.test((demo.answer.answerLine || '').trim()) && answerToggle && answerToggle.changed),
    detail: '首个子节点是题面=' + !!(demo && demo.qIsFirstChild) + '；题面含问句=' + !!(demo && /[？?]/.test(demo.qText || '')) +
      '；答案行="' + ((demo && demo.answer && demo.answer.answerLine) || '').slice(0, 30) + '"；折叠 summary="' + ((demo && demo.answer && demo.answer.summary) || '') + '"' +
      '；点开后文本变化=' + !!(answerToggle && answerToggle.changed),
    dom: '<p class="tai-q">' + ((demo && demo.qText) || '') + '</p> … <details class="tai-ans"><summary>' + ((demo && demo.answer && demo.answer.summary) || '') + '</summary>'
  });

  /* --- 第 4 条：每条 AI 回复都含 BADGE --- */
  const footBadge = panel.badges.filter((b) => b === BADGE).length;
  out.checks.push({
    no: 4,
    name: '每条 AI 回复都含「' + BADGE + '」',
    pass: footBadge >= 1 && panel.bubbles.filter((b) => /tai-bubble-teacher/.test(b.cls)).every((b) => b.hasBadge),
    detail: '讲解面板 .tai-badge 命中 ' + footBadge + ' 处；老师气泡 ' + panel.bubbles.filter((b) => /tai-bubble-teacher/.test(b.cls)).length + ' 条，全部带标=' + panel.bubbles.filter((b) => /tai-bubble-teacher/.test(b.cls)).every((b) => b.hasBadge),
    dom: '<div class="tai-foot"><span class="tai-badge">' + BADGE + '</span>'
  });

  /* --- 第 5 条：追问 2 轮，气泡左右，第二轮输入框仍可用 --- */
  const chatT0 = Date.now();
  const q1 = '为什么是这样？';
  const q2 = '我算的是 9，对吧？';
  const chat1 = await ask(q1, 1);
  const chat2 = await ask(q2, 2);
  const afterChat = await fetchStats();
  const finalPanel = await cdp.eval(PANEL_SNAPSHOT_EXPR);
  const students = finalPanel.bubbles.filter((b) => /tai-bubble-student/.test(b.cls));
  const teachers = finalPanel.bubbles.filter((b) => /tai-bubble-teacher/.test(b.cls));
  const wrap = finalPanel.wrap || { left: 0, right: 0 };
  const studentRight = students.every((b) => Math.abs(b.right - wrap.right) <= 2);
  const teacherLeft = teachers.every((b) => Math.abs(b.left - wrap.left) <= 2);
  const inputUsable = finalPanel.input && finalPanel.input.disabled === false && finalPanel.send && finalPanel.send.disabled === false;
  out.checks.push({
    no: 5,
    name: '追问 2 轮（「' + q1 + '」+「' + q2 + '」）→ 学生气泡在右、老师气泡在左，第二轮后输入框仍可用',
    pass: chat1.ok && chat2.ok && students.length === 2 && teachers.length === 2 && studentRight && teacherLeft && inputUsable,
    detail: '学生气泡 ' + students.length + ' 条（右边缘对齐容器右=' + studentRight + '）；老师气泡 ' + teachers.length + ' 条（左边缘对齐容器左=' + teacherLeft + '）；输入框可用=' + inputUsable + '；两轮失败提示=' + JSON.stringify([chat1.errorText, chat2.errorText]),
    dom: students.map((b) => '<div class="tai-bubble tai-bubble-student" style="right=' + b.right + '">' + q1.slice(0, 6) + '…</div>').join(' ') + ' ' + teachers.map((b) => '<div class="tai-bubble tai-bubble-teacher" style="left=' + b.left + '">…</div>').join(' '),
    chatMs: Date.now() - chatT0,
    wrap: wrap,
    students: students.map((b) => ({ left: b.left, right: b.right })),
    teachers: teachers.map((b) => ({ left: b.left, right: b.right }))
  });

  const pngChat = await shot('cnm_p006-chat');

  /* --- 第 6 条：切到 cnm_p002 再切回 cnm_p006，请求数不增加 ---
   * 口径说明（写进报告）：切到 cnm_p002 时页面会去取它自己的详情/题目数据（与 AI 无关），
   * 所以先做一次「预热往返」把 p002 的数据装进页面，再测第二次往返 —— 计的是第二次，
   * 这样「请求数不增加」才是在测 AI 讲解有没有被重发，而不是被数据请求掩盖或误判。 */
  const warmBefore = await fetchStats();
  await cdp.eval(`location.hash = 'cnm_p002'`);
  await until(() => cdp.eval(`(() => { var h = document.querySelector('#detail h1'); return !!h && h.textContent.indexOf('5以内数的大小') >= 0; })()`), '切到 cnm_p002（预热）', 30000);
  await until(() => cdp.eval(`!!document.querySelector('#detail .tai')`), 'cnm_p002 的 AI 入口挂上', 30000);
  await cdp.eval(`location.hash = 'cnm_p006'`);
  await until(() => cdp.eval(`document.querySelectorAll('#detail .tai-seg').length === 5`), '切回 cnm_p006 后 5 段仍在（预热往返）', 30000);
  const warmAfter = await fetchStats();
  const p002Status = '已挂载（预热完成）';

  const beforeSwitch = await fetchStats();
  const beforeText = await cdp.eval(`(() => Array.prototype.slice.call(document.querySelectorAll('#detail .tai-seg')).map(function (s) { return s.innerText; }).join('\\n'))()`);
  await cdp.eval(`location.hash = 'cnm_p002'`);
  await until(() => cdp.eval(`(() => { var h = document.querySelector('#detail h1'); return !!h && h.textContent.indexOf('5以内数的大小') >= 0; })()`), '切到 cnm_p002（计入的这一趟）', 30000);
  const p002Box = await cdp.eval(PANEL_SNAPSHOT_EXPR);
  await cdp.eval(`location.hash = 'cnm_p006'`);
  await until(() => cdp.eval(`document.querySelectorAll('#detail .tai-seg').length === 5`), '切回 cnm_p006 后 5 段仍在', 30000);
  const afterSwitch = await fetchStats();
  const afterText = await cdp.eval(`(() => Array.prototype.slice.call(document.querySelectorAll('#detail .tai-seg')).map(function (s) { return s.innerText; }).join('\\n'))()`);
  out.checks.push({
    no: 6,
    name: '切到 cnm_p002 再切回 cnm_p006 → 网络请求数不增加',
    pass: (afterSwitch.chat - beforeSwitch.chat) === 0 && (afterSwitch.total - beforeSwitch.total) === 0,
    detail: '计数口径 = 页面内包 window.fetch（不是 CDP Network）。计入的是「p002 数据已预热」后的第二次往返：切走前总/讲解 = ' + beforeSwitch.total + '/' + beforeSwitch.chat +
      '；切回后总/讲解 = ' + afterSwitch.total + '/' + afterSwitch.chat +
      '；增量 = ' + (afterSwitch.total - beforeSwitch.total) + '/' + (afterSwitch.chat - beforeSwitch.chat) +
      '；预热往返（装 p002 自身数据）增量 = ' + (warmAfter.total - warmBefore.total) + '/' + (warmAfter.chat - warmBefore.chat) +
      '；切回后 5 段文本与切走前一致=' + (beforeText === afterText),
    dom: '<div class="tai"><section class="tai-seg tai-seg-what">…×5</section></div>（复用模块内 STATE，未重发）',
    beforeSwitch: { total: beforeSwitch.total, chat: beforeSwitch.chat },
    afterSwitch: { total: afterSwitch.total, chat: afterSwitch.chat },
    warmup: { before: { total: warmBefore.total, chat: warmBefore.chat }, after: { total: warmAfter.total, chat: warmAfter.chat }, delta: { total: warmAfter.total - warmBefore.total, chat: warmAfter.chat - warmBefore.chat } },
    sameText: beforeText === afterText,
    p002Status: '面板状态 ' + p002Box.status
  });

  /* --- 第 7 条：全程 console.error / uncaught exception 为 0 --- */
  const pageErrors = await cdp.eval(`(() => { var s = window.__o4smoke || {}; return { errors: s.errors || [], rejections: s.rejections || [] }; })()`);
  out.checks.push({
    no: 7,
    name: '全程 console.error / uncaught exception 为 0',
    pass: facts.errors.consoleError.length === 0 && facts.errors.exception.length === 0 && pageErrors.errors.length === 0 && pageErrors.rejections.length === 0,
    detail: 'CDP console.error=' + facts.errors.consoleError.length + '；CDP exceptionThrown=' + facts.errors.exception.length +
      '；页面 window.onerror=' + pageErrors.errors.length + '；unhandledrejection=' + pageErrors.rejections.length +
      '；Log 域 error（含网络资源失败，单列不计入本条）=' + facts.errors.logNetwork.length,
    dom: '(无)'
  });

  const raw = await dumpRaw('cnm_p006');
  const png = await shot('cnm_p006');

  out.ms = explainMs;
  out.chatMs = Date.now() - chatT0;
  out.segs = snap.map((s) => ({ key: (s.cls.match(/tai-seg-(\w+)/) || [])[1] || '', title: s.title, firstRow: s.firstRow, rows: s.rows.slice(0, 6), listTag: s.listTag, liCount: s.liCount }));
  out.requests = {
    explainTotal: afterExplain.total - before.total,
    explainChat: afterExplain.chat - before.chat,
    afterChatTotal: afterChat.total,
    afterChatChat: afterChat.chat,
    finalTotal: afterSwitch.total,
    finalChat: afterSwitch.chat
  };
  out.status = res.state.status;
  out.screenshot = path.relative(ROOT, png);
  out.screenshotChat = path.relative(ROOT, pngChat);
  out.rawDir = path.relative(ROOT, raw.dir);
  out.rawCount = raw.count;
  out.answerToggle = answerToggle;
  out.chat = { q1, q2, r1: chat1, r2: chat2 };
  /* 同一份读数也作为 §1 结果表里 cnm_p006 的那一行（表与七条取证同源，避免两处不一致）。 */
  const demoSnap = snap.find((s) => /tai-seg-demo/.test(s.cls)) || null;
  out.row = {
    topicId: topic.id,
    note: topic.note,
    status: res.state.status,
    statusText: res.state.statusText,
    ms: explainMs,
    segCount: snap.length,
    titles: snap.map((s) => s.title),
    allFive: snap.length === 5,
    demoHasQuestion: !!(demoSnap && /[？?]/.test(demoSnap.qText || '')),
    demoQuestionText: demoSnap ? demoSnap.qText : '',
    demoHasAnswerLine: !!(demoSnap && demoSnap.answer && /^答案/.test((demoSnap.answer.answerLine || '').trim())),
    requests: { explainTotal: afterExplain.total - before.total, explainChat: afterExplain.chat - before.chat, allTotal: afterExplain.total, allChat: afterExplain.chat },
    segs: out.segs,
    screenshot: path.relative(ROOT, png),
    rawDir: path.relative(ROOT, raw.dir),
    rawCount: raw.count
  };
  return out;
}

/* 发一条追问，等老师气泡数到 n（或页面给出失败提示）。 */
async function ask(question, n) {
  await cdp.eval(`(() => {
    var inp = document.querySelector('#detail .tai-input');
    var send = document.querySelector('#detail .tai-send');
    if (!inp || !send) return false;
    inp.value = ${JSON.stringify(question)};
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    send.click();
    return true;
  })()`);
  const t0 = Date.now();
  const done = await until(async () => {
    const s = await cdp.eval(PANEL_SNAPSHOT_EXPR);
    const teachers = s.bubbles.filter((b) => /tai-bubble-teacher/.test(b.cls)).length;
    if (teachers >= n) return { ok: true, panel: s };
    if (s.chatError) return { ok: false, panel: s };
    return false;
  }, '第 ' + n + ' 轮追问回包', CHAT_TIMEOUT_MS);
  return {
    ok: done.ok,
    ms: Date.now() - t0,
    errorText: done.panel.chatError || '',
    teacherText: (done.panel.bubbles.filter((b) => /tai-bubble-teacher/.test(b.cls)).slice(-1)[0] || {}).text || ''
  };
}

/* ================================================================
 * 5. 落盘：原始请求/响应 + 报告
 * ================================================================ */

function clip(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return Array.from(t).length > n ? Array.from(t).slice(0, n).join('') + '…' : t;
}

function writeRawAndDoc() {
  const dir = path.join(RAW, runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'facts.json'), JSON.stringify(facts, null, 2));

  const runs = [];
  for (const name of fs.readdirSync(RAW)) {
    const f = path.join(RAW, name, 'facts.json');
    if (fs.existsSync(f)) {
      try { runs.push(JSON.parse(fs.readFileSync(f, 'utf8'))); } catch (e) { /* 忽略 */ }
    }
  }
  runs.sort((a, b) => String(a.runId).localeCompare(String(b.runId)));

  const pass = (b) => (b ? '是' : '否');
  const L = [];
  L.push('# O4 卡G：真浏览器端到端冒烟（脚本产出的事实）');
  L.push('');
  L.push('> 本文件由 `scripts/o4-browser-smoke.mjs` 生成，内容全部取自该脚本的真实运行：真页面（`explore/` 知识点页）+ 真 `scripts/serve.js` 同源反代 `/v1` + 本机 `127.0.0.1:3000` 网关真模型。**只写事实与计数，不写任何质量判断。**');
  L.push('');
  L.push('- 本次运行：`' + facts.runId + '`（' + facts.at + '）');
  L.push('- 运行环境：node `' + facts.node + '`；Chrome `' + facts.chromePath + '`');
  L.push('- 页面：`' + facts.pageBase + '/explore/?t=<n>#<topicId>`（`t` 只是唯一化查询串，保证每次都是真「首次进页面」的新文档；页面本身忽略它）；serve.js 端口 `' + facts.servePort + '`');
  L.push('- 模型配置注入：`localStorage["cnmDiagnose.llm"] = ' + JSON.stringify({ base: facts.pageBase + '/v1', model: MODEL, key: SMOKE_KEY }) + '`（key 为占位串，本机网关不校验）');
  L.push('- 段标题来源：`diagnose/topic-explain.js` 的 `SEG_TITLES`（脚本 `require` 模块读取，不写死中文）→ ' + JSON.stringify(facts.segTitles));
  L.push('- 请求计数口径：**页面内包 `window.fetch`** 记录 url/method/body 与 `/v1/chat/completions` 的响应 body（`clone()` 抄一份，不改原响应）。不用 CDP Network 计数。');
  L.push('');
  L.push('## 1. 三个知识点结果表');
  L.push('');
  L.push('| topicId | 名称 | 5 段出齐 | demo 有问句 | demo 有答案行 | 请求数（讲解 / 全部 fetch） | 耗时 |');
  L.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const t of facts.topics) {
    L.push('| `' + t.topicId + '` | ' + t.note + ' | ' + pass(t.allFive) + '（' + t.segCount + ' 段）' +
      ' | ' + pass(t.demoHasQuestion) + ' | ' + pass(t.demoHasAnswerLine) +
      ' | ' + t.requests.explainChat + ' / ' + t.requests.allTotal + ' | ' + (t.ms / 1000).toFixed(1) + 's |');
  }
  L.push('');
  L.push('> 「请求数」= **点按钮 → 5 段上屏期间新增的 fetch**（按点各自起算，不含进页面时的知识点数据请求）。「讲解」= URL 含 `/v1/chat/completions` 的请求；「全部」= 该区间内页面内所有 fetch。');
  L.push('');
  L.push('### 各点段标题（按 DOM 顺序）');
  L.push('');
  for (const t of facts.topics) {
    L.push('- `' + t.topicId + '`：' + t.titles.map((x) => '「' + x + '」').join(' → ') + '；面板状态 `' + t.status + '`' + (t.statusText ? '（' + clip(t.statusText, 40) + '）' : ''));
  }
  L.push('');

  L.push('## 2. cnm_p006 七条取证');
  L.push('');
  if (!facts.p006) {
    L.push('本次运行未走到 cnm_p006 完整流程（见 §7）。');
  } else {
    L.push('| # | 判据 | 结论 | 关键事实 / DOM 片段 |');
    L.push('| --- | --- | --- | --- |');
    for (const c of facts.p006.checks) {
      L.push('| ' + c.no + ' | ' + c.name + ' | ' + pass(c.pass) + ' | ' + clip(c.detail, 300).replace(/\|/g, '\\|') + '<br>`' + clip(c.dom, 80).replace(/\|/g, '\\|') + '` |');
    }
    L.push('');
    L.push('第 3 条折叠实测：点开前 `details` 内文 `' + clip(facts.p006.answerToggle ? facts.p006.answerToggle.beforeText : '', 60).replace(/\|/g, '\\|') + '`，点开后 `' +
      clip(facts.p006.answerToggle ? facts.p006.answerToggle.afterText : '', 60).replace(/\|/g, '\\|') + '`（`details.open` = ' + (facts.p006.answerToggle ? facts.p006.answerToggle.open : '?') + '）。');
    L.push('');
    L.push('第 5 条气泡几何（`.tai-bubbles` 容器 left=`' + facts.p006.checks[4].wrap.left + '`, right=`' + facts.p006.checks[4].wrap.right + '`）：');
    L.push('- 学生气泡：' + facts.p006.checks[4].students.map((b) => 'left=' + b.left + ' / right=' + b.right).join('，'));
    L.push('- 老师气泡：' + facts.p006.checks[4].teachers.map((b) => 'left=' + b.left + ' / right=' + b.right).join('，'));
    L.push('');
    L.push('第 6 条请求数（切走前 / 切回后）：总 `' + facts.p006.checks[5].beforeSwitch.total + '` → `' + facts.p006.checks[5].afterSwitch.total + '`；讲解 `' +
      facts.p006.checks[5].beforeSwitch.chat + '` → `' + facts.p006.checks[5].afterSwitch.chat + '`；切回后 5 段文本与切走前一致=' + (facts.p006.checks[5].sameText ? '是' : '否') + '。');
    L.push('');
    L.push('cnm_p006 时间：讲解点击→5 段上屏 `' + (facts.p006.ms / 1000).toFixed(1) + 's`；两轮追问 `' + (facts.p006.chatMs / 1000).toFixed(1) + 's`。');
  }
  L.push('');

  L.push('## 3. 每段第一行原文摘录（各 ≤60 字）');
  L.push('');
  L.push('「第一行」取该段渲染后的第一行文本（列表段 = 第一个 `<li>`；demo = 题面那一行），用来核对「一点一行、不是一大段」。');
  L.push('');
  L.push('| 点 | 段 | 首行原文 |');
  L.push('| --- | --- | --- |');
  const withSegs = facts.topics.filter((t) => t.segs && t.segs.length);
  for (const t of withSegs) {
    for (const s of t.segs) L.push('| `' + t.topicId + '` | ' + s.title + '（`' + s.key + '`，' + (s.listTag || 'p') + ' × ' + s.liCount + '） | ' + clip(s.firstRow, 60).replace(/\|/g, '\\|') + ' |');
  }
  if (facts.p006 && facts.p006.segs) {
    L.push('');
    L.push('cnm_p006 各段完整行数（用于核对分段粒度）：' + facts.p006.segs.map((s) => '`' + s.key + '`=' + s.rows.length + ' 行').join('，') + '。');
  }
  L.push('');

  L.push('## 4. 证据落盘');
  L.push('');
  L.push('- 截图：');
  for (const t of facts.topics) L.push('  - `' + t.screenshot + '`（' + t.topicId + ' 面板，' + (t.topicId === 'cnm_p006' ? '七条取证全部跑完后' : '5 段上屏后') + '拍的）');
  if (facts.p006 && facts.p006.screenshotChat) L.push('  - `' + facts.p006.screenshotChat + '`（cnm_p006 两轮追问后）');
  L.push('- 原始请求/响应（逐次一个 JSON，含 request body 与 response body）：');
  L.push('  - `' + path.relative(ROOT, path.join(RAW, runId)) + '/`（本次运行）');
  for (const t of facts.topics) L.push('  - `' + t.rawDir + '/' + t.topicId + '-*.json`：' + t.rawCount + ' 次 `/v1/chat/completions`' + (t.topicId === 'cnm_p006' ? '（讲解 1 + 两轮追问 2）' : '（讲解 1）'));
  L.push('');
  L.push('> `tmp/` 在 `.gitignore` 里，截图与原始报文不入库；本文件只写路径。');
  L.push('');

  L.push('## 5. 退出后进程清理实测');
  L.push('');
  const c = facts.cleanup || {};
  L.push('| 项 | 实测 |');
  L.push('| --- | --- |');
  L.push('| 本机 Chrome 进程数（含 helpers，`ps` 命令含 `Google Chrome` 的行数）— 启动前 | ' + c.chromeBefore + ' |');
  L.push('| 同上 — 收尾前（本次 Chrome 仍在） | ' + c.chromeAliveBefore + ' |');
  L.push('| 同上 — `guard.kill` 之后 | ' + c.chromeAfter + ' |');
  L.push('| 差值（收尾后 − 启动前） | ' + (c.totalDelta >= 0 ? '+' : '') + c.totalDelta + ' |');
  L.push('| 本次自己起的 Chrome：命令行提到本次临时 profile 的进程数（收尾前） | ' + c.ourProcsAtCleanup + ' |');
  L.push('| 同上 — `guard.kill` 之后 | ' + c.ourProcsAfter + ' |');
  L.push('| 本次 Chrome 主 pid `' + c.mainPid + '` 收尾后是否还活着 | ' + pass(c.mainPidAliveAfter) + ' |');
  L.push('| serve.js 端口 `' + c.servePort + '` 是否已释放 | ' + pass(c.servePortReleased) + ' |');
  L.push('');
  const deltas = runs.map((r) => (r.cleanup ? r.cleanup.totalDelta : null)).filter((v) => typeof v === 'number');
  L.push('判据说明：本机同时开着用户自己的浏览器，它在这几分钟里会自己开关标签/渲染进程，所以「本机 Chrome 进程总数前后相等」**不作为判据**（已记录的 ' + deltas.length + ' 次实跑总数差值：' + deltas.map((d) => (d >= 0 ? '+' : '') + d).join('、') + '，方向与幅度都由别人的浏览器决定）。本卡判据：**本次自己起的进程全部消失**（临时 profile 进程数 = 0、主 pid 不再存活）+ serve 端口释放。');
  L.push('');
  L.push('');
  L.push('收尾只用 `guard.kill(chrome)`（杀自己 `guard.launch` 起来的进程组）与 serve 子进程 pid；**没有** `pkill chrome`、**没有**连/读/杀 9222 上的 Chrome。');
  if (c.serveLogTail) {
    L.push('');
    L.push('serve.js 尾部日志：');
    L.push('```');
    L.push(c.serveLogTail);
    L.push('```');
  }
  L.push('');

  L.push('## 6. 重复运行（同一脚本连跑）');
  L.push('');
  if (runs.length <= 1) {
    L.push('本次是第一次记录（`tmp/o4-smoke/raw/*/facts.json` 里只有本次）。重复跑一次后本表会出现两行。');
  } else {
    L.push('| runId | 各点 5 段出齐 | 讲解请求数（p006 / p019 / p031） | 全部 fetch（p006 / p019 / p031） | 七条取证 |');
    L.push('| --- | --- | --- | --- | --- |');
    for (const r of runs) {
      const ok = r.topics.map((t) => (t.allFive ? '是' : '否')).join(' / ');
      const chat = r.topics.map((t) => t.requests.explainChat).join(' / ');
      const all = r.topics.map((t) => t.requests.allTotal).join(' / ');
      const seven = r.p006 ? r.p006.checks.filter((x) => x.pass).length + '/7' : '未跑完';
      L.push('| `' + r.runId + '` | ' + ok + ' | ' + chat + ' | ' + all + ' | ' + seven + ' |');
    }
    L.push('');
    L.push('> 每次运行都用新目录 `--user-data-dir`（空 localStorage），所以后续运行不会命中讲解缓存、请求数不会变成 0；下表是各次真实读数，不是靠缓存凑出来的。');
    L.push('');
    // 一致性判定：逐点逐项比较（不含耗时、不含讲解正文）
    const cmpFields = [
      ['5 段出齐', (t) => t.allFive, (t) => t.segCount + ' 段'],
      ['demo 有问句', (t) => t.demoHasQuestion, null],
      ['demo 有答案行', (t) => t.demoHasAnswerLine, null],
      ['讲解请求数', (t) => t.requests.explainChat, null],
      ['全部 fetch', (t) => t.requests.allTotal, null],
    ];
    const base = runs[0];
    const diffs = [];
    for (const r of runs.slice(1)) {
      for (const t of r.topics) {
        const b = base.topics.find((x) => x.topicId === t.topicId) || {};
        for (const [name, get, fmt] of cmpFields) {
          if (get(t) !== get(b)) diffs.push('`' + t.topicId + '` 的' + name + '：`' + base.runId + '`=' + (fmt ? fmt(b) : get(b)) + '，`' + r.runId + '`=' + (fmt ? fmt(t) : get(t)));
        }
      }
      if (r.p006 && base.p006) {
        const a = base.p006.checks.filter((x) => x.pass).length;
        const z = r.p006.checks.filter((x) => x.pass).length;
        if (a !== z) diffs.push('`cnm_p006` 七条取证通过数：`' + base.runId + '`=' + a + '/7，`' + r.runId + '`=' + z + '/7');
      }
    }
    L.push('**一致性判定（逐点比较 5 段是否出齐 / demo 有问句 / demo 有答案行 / 讲解请求数 / 全部 fetch，不含耗时与正文）**：' +
      (diffs.length ? '**否**（' + runs.length + ' 次运行存在读数不同的项，见下）' : '**是**（' + runs.length + ' 次运行逐项相同）'));
    if (diffs.length) {
      L.push('');
      for (const d of diffs) L.push('- 不一致：' + d);
      L.push('');
      L.push('> 不一致只出现在真实模型返回上（同一请求体可能 `finish_reason=length` 且正文为空，见 §7 的旁证）；页面侧没有报错，见第 7 条与 §7。本卡不据此判源码对错，也不在本卡改源码。');
    }
  }
  L.push('');

  L.push('## 7. 未成立 / 异常项（如实记录）');
  L.push('');
  const failed = [];
  const anomalies = [];
  if (facts.p006) for (const chk of facts.p006.checks) if (!chk.pass) failed.push('cnm_p006 第 ' + chk.no + ' 条：' + chk.name + ' —— ' + chk.detail);
  if (facts.mountRace && facts.mountRace.segsAfterFirst !== 5) anomalies.push('首点竞态（详见 §8）：' + facts.mountRace.verdict);
  for (const t of facts.topics) {
    if (!t.allFive) failed.push('`' + t.topicId + '`：5 段未出齐（实际 ' + t.segCount + ' 段），面板状态 `' + t.status + '`，页面文案：' + clip(t.statusText, 80));
    if (!t.demoHasQuestion) failed.push('`' + t.topicId + '`：demo 没有问句（题面文本：' + clip(t.demoQuestionText, 60) + '）');
    if (!t.demoHasAnswerLine) failed.push('`' + t.topicId + '`：demo 没有以「答案」开头的行');
  }
  if (facts.errors.consoleError.length) failed.push('console.error：' + facts.errors.consoleError.join(' | '));
  if (facts.errors.exception.length) failed.push('exceptionThrown：' + facts.errors.exception.join(' | '));
  if (failed.length) {
    for (const f of failed) L.push('- ' + f);
    L.push('');
    L.push('原始返回见 §4 的 `raw/` 目录（每条的 request/response body 都原样落盘）。本节只记录，不在本卡改源码去凑。');
  } else {
    L.push('本次运行没有不成立的条目。');
  }
  // 更早运行的失败项：避免「本次没有」被读成「从来没有」
  const histFailed = [];
  for (const r of runs) {
    if (r.runId === facts.runId) continue;
    const items = [];
    if (r.p006) for (const chk of r.p006.checks) if (!chk.pass) items.push('cnm_p006 第 ' + chk.no + ' 条：' + chk.name);
    for (const t of r.topics) {
      if (!t.allFive) items.push('`' + t.topicId + '`：5 段未出齐（实际 ' + t.segCount + ' 段），面板状态 `' + t.status + '`，页面文案：' + clip(t.statusText, 80));
      if (!t.demoHasQuestion) items.push('`' + t.topicId + '`：demo 没有问句（题面文本：' + clip(t.demoQuestionText, 60) + '）');
      if (!t.demoHasAnswerLine) items.push('`' + t.topicId + '`：demo 没有以「答案」开头的行');
    }
    if (r.errors) {
      if (r.errors.consoleError && r.errors.consoleError.length) items.push('console.error：' + r.errors.consoleError.join(' | '));
      if (r.errors.exception && r.errors.exception.length) items.push('exceptionThrown：' + r.errors.exception.join(' | '));
    }
    if (items.length) histFailed.push({ runId: r.runId, items });
  }
  if (histFailed.length) {
    L.push('');
    L.push('### 更早运行（同一脚本）里的不成立项：原样记录，不改源码去凑');
    L.push('');
    for (const h of histFailed) {
      L.push('- `' + h.runId + '`（原始报文：`tmp/o4-smoke/raw/' + h.runId + '/`）：');
      for (const it of h.items) L.push('  - ' + it);
    }
  }
  if (facts.replay && facts.replay.length) {
    L.push('');
    L.push('### 失败点旁证：脚本在 Node 侧把同一份请求体重放一次（无页面的 30s 客户端超时）');
    L.push('');
    L.push('页面侧 `postOnce` 的 abort 上限是 `diagnose/llm-config.js` 里的 `timeouts.chat = 30000`（30s）；Node 侧重放没有这个上限，用来区分「网关不给正文」与「页面等不到」。');
    L.push('');
    for (const r of facts.replay) {
      L.push('- `' + r.topicId + '`（' + r.note + '，面板状态 `' + r.panelStatus + '`）：');
      for (const run of r.runs) {
        L.push('  - `' + run.file + '`：页面那次 `' + run.pageStatus + '`；重放 http=`' + run.http + '`，`finish_reason`=`' + run.finish +
          '`，正文长度=`' + run.contentLen + '`，耗时 ' + (run.ms / 1000).toFixed(1) + 's' + (run.error ? '，错误：' + clip(run.error, 60) : '') +
          (run.usage ? '，usage=`' + JSON.stringify(run.usage) + '`' : ''));
      }
    }
    L.push('');
    L.push('> 这一节只陈述「同一份请求体在网关侧得到什么」。是否因此判失败、要不要改预算/超时/重试，属于另一张卡的范围。');
  }
  if (facts.errors.logNetwork.length) {
    L.push('');
    L.push('单列（不计入第 7 条判据）：Log 域 error ' + facts.errors.logNetwork.length + ' 条 —— ' + facts.errors.logNetwork.map((x) => clip(x, 120)).slice(0, 6).join(' | '));
  }
  if (anomalies.length) {
    L.push('');
    L.push('另记（不属卡面七条判据；本卡禁改源码，故只记录）：');
    for (const a of anomalies) L.push('- ' + a);
  }
  L.push('');

  L.push('## 8. 首点竞态探针（只记录事实，源码不属本卡改动范围）');
  L.push('');
  if (!facts.mountRace) {
    L.push('本次运行未执行（见 §7）。');
  } else {
    const r = facts.mountRace;
    L.push('- 做法：整页加载 `#cnm_p006`，**按钮一出现就点**（不等 §1 用的「详情面板落定」判据），然后在 15s 内轮询可见面板 `.tai-seg` 数；不足 5 段再点一次，轮询 60s。');
    L.push('- 首点返回值：`' + r.firstClick + '`；第二轮点击返回值：`' + (r.secondClick || '（未执行：首点已上屏）') + '`');
    L.push('- 结论（事实）：' + r.verdict);
    L.push('- 首点后可见面板 HTML 片段（≤200 字）：`' + clip(r.visibleAfterFirst, 200).replace(/\|/g, '\\|') + '`');
    L.push('- 请求增量：首点后（15s 内）总 `' + (r.phase1 ? r.phase1.total : '?') + '` / 讲解 `' + (r.phase1 ? r.phase1.chat : '?') + '`' +
      (r.phase2 ? '；第二轮点击后 总 `' + r.phase2.total + '` / 讲解 `' + r.phase2.chat + '`' : ''));
    L.push('- 判读（**推断，未改源码验证**）：首点后讲解请求已经发出并 200 返回，说明模块确实跑了、讲解也算出来了；但内容画进的是 `explore/app.js` `mountTopicAI(box)` 持有的那个 `.tai` 盒子，而 `ensureDetail` / `loadQuestionsFor` 回包后的 `renderDetail()` 会 `replaceChildren` 把盒子换掉 —— 旧盒子脱离文档，可见面板于是停在原始按钮上；第二次点击时模块已加载、STATE 已是 ready，所以 5 段立刻出现且不再发请求。');
    L.push('- 卡面 §3 的七条取证按**真实用户路径**执行（人滚到面板底部再点，此时详情数据早已落定），因此 §2 不受这条竞态影响；这条单独列出来，是因为「按钮一出现就点」时可见面板确实 0 段。');
  }
  L.push('');
  L.push('---');
  L.push('');
  L.push('本文件不含任何「孩子能听懂 / 讲得清楚 / 质量好」类判断；只有 DOM 读数、布尔结论与请求计数。');
  L.push('');

  const fullText = L.join('\n');
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'report-' + facts.runId + '.md'), fullText);
  /* 卡 H：docs/o4-browser-smoke.md 里 §1–§8 是卡 G 的原始读数（本脚本当年是整份写），
   * 重跑不许整份覆盖 —— 从卡 H 起只 upsert 本节，整份报告落 tmp/ 留底。 */
  const mode = upsertSection(DOC_SMOKE, CARD_H_HEADING, cardHSection(facts));
  console.log('[o4-smoke] 报告：docs/o4-browser-smoke.md（' + (mode === 'replaced' ? '§9 已整段替换，§1–§8 未动' : '§9 已追加，§1–§8 未动') + '）');
  console.log('[o4-smoke] 整份报告留底：' + path.relative(ROOT, path.join(OUT, 'report-' + facts.runId + '.md')));
  console.log('[o4-smoke] 截图与原始报文：' + path.relative(ROOT, OUT));
}

/* ================================================================
 * 6. 入口
 * ================================================================ */

main().then(() => {
  const failed = [];
  if (facts.p006) for (const c of facts.p006.checks) if (!c.pass) failed.push('p006 第 ' + c.no + ' 条');
  for (const t of facts.topics) if (!t.allFive || !t.demoHasQuestion || !t.demoHasAnswerLine) failed.push(t.topicId);
  if (facts.errors.consoleError.length || facts.errors.exception.length) failed.push('页面报错');
  if (facts.cleanup && (facts.cleanup.ourProcsAfter !== 0 || facts.cleanup.mainPidAliveAfter || !facts.cleanup.servePortReleased)) failed.push('收尾不干净');
  if (failed.length) {
    console.error('[o4-smoke] 不成立：' + failed.join('、') + '（详见 docs/o4-browser-smoke.md §7）');
    process.exitCode = 1;
  } else {
    console.log('[o4-smoke] 全部通过：3 个点 5 段出齐 + cnm_p006 七条取证 + 进程收尾干净');
  }
}).catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exitCode = 1;
}).finally(async () => {
  if (cdp) { try { cdp.ws.close(); } catch (e) { /* 已断 */ } }
  if (chrome) guard.kill(chrome);
  if (server && !server.killed) { try { server.kill('SIGKILL'); } catch (e) { /* 已退 */ } }
});
