/* 苏格拉底讲解的“闸门”测试（kanban t_6bfdf8c2，RED 阶段）。
 *
 * 目标行为（实现完成后应全部通过）：
 *   1. 没配置 LLM 时，错题反馈只给“对错 + 参考答案 + 解析原文”，不再出现静态苏格拉底三步模板；
 *   2. 配了 LLM 且调用成功时，三步讲解全部来自模型 JSON，标签是「AI 讲解」；
 *   3. 配了 LLM 但调用失败（HTTP 500）时，直达解析原文，并给出 Explain._noticeFor 的失败文案和「再问一次」；
 *   4. 等待模型返回期间，只显示中性的“AI 正在看你的答案”，既不能先闪静态模板，也不能提前泄露模型首句；
 *   5. 全库守卫：任何静态引导文本都不能包含对应题目的答案，且静态模板函数必须已经删除。
 *
 * 为什么现在会红：app-flow.js 在 Explain 加载前/失败后都会 fallback 到 engine.socraticSteps，
 * 而 socraticSteps 的 hint 就是解析第一句，答案经常直接写在里面。第 5 条在基线上能稳定复现。
 *
 * 运行：node tests/test_socratic_gate.js
 * 依赖：Node 22+（内置 fetch/WebSocket）与本机 Chrome；CHROME 环境变量可覆盖 Chrome 路径。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BANK = require(path.join(ROOT, 'data', 'questions.json'));
const TOPICS = require(path.join(ROOT, 'data', 'topics.json'));
const TOPIC_BY_ID = new Map(TOPICS.map((t) => [t.id, t]));
const E = require(path.join(ROOT, 'diagnose', 'engine.js'));

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function norm(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function findQuestion(topicId, prompt) {
  const want = norm(prompt);
  const pool = BANK.filter((q) => q.topicId === topicId);
  return pool.find((q) => norm(q.prompt) === want)
    || pool.find((q) => norm(q.prompt).indexOf(want) >= 0 || want.indexOf(norm(q.prompt)) >= 0)
    || null;
}

/* ------------------------------------------------------------------ 测试基座 */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.woff2': 'font/woff2'
};

let staticPort = 0;
let mockPort = 0;
let mockHandler = () => ({ status: 500, body: { error: 'mock not configured' } });
let mockHits = 0;
let mockReceived = 0;

function startStaticServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/index.html';
    if (pathname.slice(-1) === '/') pathname += 'index.html';
    if (pathname === '/assets/stats-config.js') {
      res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-store' });
      res.end('window.CNM_STATS = {};');
      return;
    }
    const file = path.join(ROOT, pathname);
    if (file.indexOf(ROOT + path.sep) !== 0 && file !== ROOT) {
      res.writeHead(403); res.end('forbidden'); return;
    }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store'
      });
      res.end(buf);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      staticPort = server.address().port;
      resolve(server);
    });
  });
}

function startMockLLM() {
  const server = http.createServer((req, res) => {
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type, authorization',
      'Cache-Control': 'no-store'
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, headers);
      res.end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(404, headers); res.end('not found'); return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      mockHits++;
      mockReceived++;
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (e) { /* ignore */ }
      const out = mockHandler(req, body) || { status: 500, body: { error: 'no mock' } };
      const delay = out.delay == null ? 0 : out.delay;
      setTimeout(() => {
        const payload = typeof out.body === 'string' ? out.body : JSON.stringify(out.body || {});
        res.writeHead(out.status || 200, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers));
        res.end(payload);
      }, delay);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      mockPort = server.address().port;
      resolve(server);
    });
  });
}

function setMock(fn) {
  mockHandler = fn;
  mockHits = 0;
}

function llmBody(text) {
  return {
    id: 'mock',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  };
}

function explainBody(obj) {
  return llmBody('```json\n' + JSON.stringify(obj) + '\n```');
}

function defaultExplainBody() {
  return explainBody({
    prompt: 'MOCK_PROMPT_7f3a 先想想这道题在问什么。',
    hint: 'MOCK_HINT_7f3a 把条件逐个列出来。',
    reveal: 'MOCK_REVEAL_7f3a 先看标准解法，再对照自己的步骤。'
  });
}

function until(fn, label, timeout, interval) {
  const limit = timeout || 15000;
  const step = interval || 100;
  const start = Date.now();
  let lastErr = null;
  return (async () => {
    while (Date.now() - start < limit) {
      try {
        const v = await fn();
        if (v) return v;
      } catch (e) { lastErr = e; }
      await sleep(step);
    }
    throw new Error('等待超时：' + label + (lastErr ? '（最后一次错误：' + lastErr.message + '）' : ''));
  })();
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      (async () => {
        let text;
        if (typeof ev.data === 'string') text = ev.data;
        else if (ev.data && typeof ev.data.text === 'function') text = await ev.data.text();
        else text = Buffer.from(ev.data).toString('utf8');
        let msg;
        try { msg = JSON.parse(text); } catch (e) { return; }
        if (!msg.id || !this.pending.has(msg.id)) return;
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else p.resolve(msg.result || {});
      })();
    });
    ws.addEventListener('close', () => {
      for (const p of this.pending.values()) p.reject(new Error('DevTools 连接已关闭'));
      this.pending.clear();
    });
  }

  send(method, params) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      } catch (e) {
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('页面脚本异常：' + ((d.exception && (d.exception.description || d.exception.value)) || d.text));
    }
    return r.result ? r.result.value : undefined;
  }
}

function readDevToolsPort(profile, timeout) {
  const file = path.join(profile, 'DevToolsActivePort');
  return until(() => {
    if (!fs.existsSync(file)) return false;
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    return lines[0] ? { port: Number(lines[0]), path: lines[1] || '' } : false;
  }, 'Chrome DevToolsActivePort', timeout || 20000).catch((e) => { throw e; });
}

async function openBrowser(opts) {
  const options = opts || {};
  if (!fs.existsSync(CHROME)) {
    throw new Error('找不到 Chrome：' + CHROME + '（可用 CHROME=/path/to/chrome 指定）');
  }
  if (typeof WebSocket === 'undefined') {
    throw new Error('当前 Node 没有内置 WebSocket，请使用 Node 22+');
  }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cnm-socratic-'));
  const proc = spawn(CHROME, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=0',
    '--user-data-dir=' + profile,
    'about:blank'
  ], { stdio: 'ignore' });
  let cdp = null;
  try {
    const info = await readDevToolsPort(profile, 20000);
    const base = 'http://127.0.0.1:' + info.port;
    const targets = await until(async () => {
      const r = await fetch(base + '/json/list');
      const list = await r.json();
      return list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) || false;
    }, 'Chrome 页面 target', 10000);
    const ws = new WebSocket(targets.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('DevTools WebSocket 连接失败')), { once: true });
    });
    cdp = new Cdp(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Network.setBypassServiceWorker', { bypass: true }).catch(() => {});
    const cfgScript = options.configured
      ? 'try{localStorage.setItem("cnmDiagnose.llm",JSON.stringify({base:' + JSON.stringify('http://127.0.0.1:' + mockPort + '/v1') + ',model:"mock-model",key:"mock-key"}));}catch(e){}'
      : 'try{localStorage.removeItem("cnmDiagnose.llm");localStorage.removeItem("cnmDiagnose.llmBase");}catch(e){}';
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: 'window.__socraticErrors=[];'
        + 'addEventListener("error",function(e){window.__socraticErrors.push(String((e&&e.message)||(e&&e.error)||"error"));});'
        + 'addEventListener("unhandledrejection",function(e){window.__socraticErrors.push("unhandledrejection: "+String((e&&e.reason&&e.reason.message)||(e&&e.reason)||"unknown"));});'
        + cfgScript
    });
    cdp.proc = proc;
    cdp.profile = profile;
    cdp.base = 'http://127.0.0.1:' + staticPort;
    return cdp;
  } catch (e) {
    if (cdp && cdp.ws) cdp.ws.close();
    proc.kill('SIGKILL');
    fs.rmSync(profile, { recursive: true, force: true });
    throw e;
  }
}

async function closeBrowser(cdp) {
  if (!cdp) return;
  try { cdp.ws.close(); } catch (e) { /* ignore */ }
  try { cdp.proc.kill('SIGKILL'); } catch (e) { /* ignore */ }
  await sleep(100);
  try { fs.rmSync(cdp.profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

async function ensureLLMConfig(cdp) {
  const exists = await cdp.eval('!!window.LLMConfig');
  if (!exists) {
    await cdp.eval('new Promise(function(resolve,reject){'
      + 'var s=document.createElement("script");s.src="llm-config.js";'
      + 's.onload=function(){resolve(true);};s.onerror=function(){reject(new Error("llm-config.js 加载失败"));};'
      + 'document.head.appendChild(s);})');
  }
  await until(() => cdp.eval('!!window.LLMConfig'), 'LLMConfig 可用', 10000);
}

async function gotoQuestion(cdp, topicId) {
  const url = cdp.base + '/diagnose/?target=' + encodeURIComponent(topicId) + '&seed=socratic-gate';
  await cdp.send('Page.navigate', { url });
  try {
    await until(() => cdp.eval('!!document.getElementById("q-text")'), '题目渲染', 20000);
  } catch (e) {
    const diag = await cdp.eval('({href:location.href,ready:document.readyState,'
      + 'text:((document.body&&document.body.innerText)||"").slice(0,600),'
      + 'errors:(window.__socraticErrors||[]).slice(0,5),'
      + 'scripts:Array.prototype.map.call(document.scripts,function(s){return s.src||"(inline)";})})').catch(() => null);
    throw new Error(e.message + ' 页面诊断=' + JSON.stringify(diag));
  }
  await ensureLLMConfig(cdp);
  const prompt = await cdp.eval('(document.getElementById("q-text").textContent||"").trim()');
  const q = findQuestion(topicId, prompt);
  if (!q) throw new Error('题库里找不到当前题目：topic=' + topicId + ' prompt=' + JSON.stringify(prompt));
  return q;
}

async function clickId(cdp, id) {
  const ok = await cdp.eval('(function(){var b=document.getElementById(' + JSON.stringify(id) + ');'
    + 'if(!b)return false;b.click();return true;})()');
  if (!ok) throw new Error('找不到按钮 #' + id);
}

async function clickByText(cdp, frag) {
  const ok = await cdp.eval('(function(){var b=Array.prototype.slice.call(document.querySelectorAll("button"))'
    + '.filter(function(x){return (x.textContent||"").indexOf(' + JSON.stringify(frag) + ')>=0;})[0];'
    + 'if(!b)return false;b.click();return true;})()');
  if (!ok) throw new Error('找不到文本含「' + frag + '」的按钮');
}

function pageState(cdp, q) {
  return cdp.eval('(function(){'
    + 'var text=document.body.innerText||"";'
    + 'var raw=document.body.textContent||"";'
    + 'return {'
    + '  text:text,'
    + '  hasExplanation:text.indexOf(' + JSON.stringify(q ? q.explanation : '') + ')>=0,'
    + '  hasRefAnswer:text.indexOf("参考答案")>=0,'
    + '  socraticNodes:document.querySelectorAll(".socratic, .soc-step, #btn-soc-hint, #btn-soc-got").length,'
    + '  hasAction:Array.prototype.slice.call(document.querySelectorAll("button")).some(function(b){'
    + '    return /(再做一遍|重新做一遍|重新开始|下一题|继续)/.test(b.textContent||"");'
    + '  }),'
    + '  hasRetry:Array.prototype.slice.call(document.querySelectorAll("button")).some(function(b){'
    + '    return (b.textContent||"").indexOf("再问一次")>=0;'
    + '  }),'
    + '  hasAiTag:(function(){var e=document.querySelector(".ai-tag");return !!e&&(e.textContent||"").indexOf("AI 讲解")>=0;})()'
    + '};})()');
}

/* ------------------------------------------------------------------ 全库守卫的纯函数 */

function splitAnswerParts(raw) {
  const s = String(raw == null ? '' : raw);
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(' || ch === '（') depth++;
    else if (ch === ')' || ch === '）') depth = Math.max(0, depth - 1);
    if (depth === 0 && /[,;，；、]/.test(ch)) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out
    .reduce((acc, x) => acc.concat(String(x).split(/或者|或|和|与|及/)), [])
    .map((x) => x.trim())
    .filter(Boolean);
}

function numericTokens(raw) {
  const text = String(raw == null ? '' : raw).normalize('NFKC');
  const keys = new Set();
  const re = /(?<![0-9A-Za-z_.\/])[-+]?\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?(?![0-9A-Za-z_.\/])/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const k = E.numericKey(m[0]);
    if (k) keys.add(k);
  }
  return keys;
}

function choiceKeyLeak(text, key) {
  const k = String(key == null ? '' : key).trim().toUpperCase();
  if (!/^[A-D]$/.test(k)) return false;
  const re = new RegExp('(?:选|答案是|正确答案是|应选|故选|答案)\\s*[：:为是]?\\s*' + k + '(?![A-Za-z])', 'i');
  return re.test(String(text || ''));
}

function leaksAnswer(q, texts) {
  const answer = String(q.answer == null ? '' : q.answer).trim();
  if (!answer) return false;

  if (q.type === 'choice') {
    const chosen = (q.choices || []).find((c) => String(c.key) === answer);
    const option = chosen ? E.normalizeText(chosen.text) : '';
    for (const text of texts) {
      if (option.length >= 2 && E.normalizeText(text).indexOf(option) >= 0) return true;
      if (choiceKeyLeak(text, answer)) return true;
    }
    return false;
  }

  const parts = splitAnswerParts(answer);
  const keys = parts.map((p) => E.numericKey(p));
  const allNumeric = parts.length > 0 && keys.every((k) => !!k);
  if (allNumeric) {
    for (const text of texts) {
      const toks = numericTokens(text);
      if (keys.every((k) => toks.has(k))) return true;
    }
    return false;
  }

  const plain = E.normalizeText(answer);
  if (plain.length < 2) return false;
  return texts.some((text) => E.normalizeText(text).indexOf(plain) >= 0);
}

function loadExplain() {
  const hadWindow = Object.prototype.hasOwnProperty.call(global, 'window');
  const prevWindow = global.window;
  global.window = globalThis;
  try {
    const mod = require(path.join(ROOT, 'diagnose', 'explain.js'));
    return globalThis.Explain || mod;
  } finally {
    if (hadWindow) global.window = prevWindow;
    else delete global.window;
  }
}

/* ------------------------------------------------------------------ 测试用例 */

const TOPIC_ID = 'cnm_p014'; // 4 道题全是选择题：reveal 不会因数值校验失败而回退

test('1. 无配置时只给参考答案和解析原文，不出现静态苏格拉底模板', async () => {
  setMock(() => ({ status: 500, body: { error: '不应被调用' } }));
  const cdp = await openBrowser({ configured: false });
  try {
    const q = await gotoQuestion(cdp, TOPIC_ID);
    const configured = await cdp.eval('!!(window.LLMConfig && window.LLMConfig.isConfigured && window.LLMConfig.isConfigured())');
    assert.strictEqual(configured, false, '无配置场景下 window.LLMConfig.isConfigured() 应为 false');

    await clickId(cdp, 'btn-skip');
    await until(() => pageState(cdp, q).then((s) => s.hasExplanation || s.socraticNodes > 0), '反馈面板出现', 15000);
    await sleep(400);

    const st = await pageState(cdp, q);
    const raw = await cdp.eval('document.body.innerText || ""');
    const forbidden = ['苏格拉底', '第 1 步', '基础讲解', '先别急着看答案——你回想一下'];
    const seen = forbidden.filter((w) => raw.indexOf(w) >= 0);
    assert.deepStrictEqual(seen, [], '无配置时不应出现静态讲解字样：' + seen.join('、'));
    assert.strictEqual(st.socraticNodes, 0, '无配置时不应渲染 .socratic/.soc-step/苏格拉底按钮，实际节点数=' + st.socraticNodes);
    assert.ok(st.hasExplanation, '无配置时应直接展示解析原文');
    assert.ok(st.hasRefAnswer, '无配置时应展示参考答案');
    assert.ok(st.hasAction, '无配置时应保留“再做一遍 / 重新开始 / 下一题”等继续动作');
  } finally {
    await closeBrowser(cdp);
  }
});

test('2. 有配置且 LLM 成功时，三步全部来自模型 JSON 且标注「AI 讲解」', async () => {
  setMock(() => ({ status: 200, body: defaultExplainBody() }));
  const cdp = await openBrowser({ configured: true });
  try {
    const q = await gotoQuestion(cdp, TOPIC_ID);
    await clickId(cdp, 'btn-skip');
    await until(() => cdp.eval('(document.body.innerText||"").indexOf("MOCK_PROMPT_7f3a")>=0'), '模型第一步', 20000);

    const first = await pageState(cdp, q);
    assert.ok(first.socraticNodes > 0, 'AI 讲解应渲染苏格拉底面板容器');
    assert.ok(first.hasAiTag, 'AI 讲解成功时标签应为「AI 讲解」');
    const step1 = await cdp.eval('document.body.textContent || ""');
    assert.ok(step1.indexOf('MOCK_PROMPT_7f3a') >= 0, '第一步应来自模型 prompt');
    assert.ok(step1.indexOf('先别急着看答案——你回想一下') < 0, '第一步不应是静态模板');

    await clickByText(cdp, '提示');
    await until(() => cdp.eval('(document.body.innerText||"").indexOf("MOCK_HINT_7f3a")>=0'), '模型第二步', 10000);
    const step2 = await cdp.eval('document.body.textContent || ""');
    assert.ok(step2.indexOf('MOCK_HINT_7f3a') >= 0, '第二步应来自模型 hint');
    assert.ok(step2.indexOf('想想这一步做对了吗') < 0, '第二步不应是静态提示');

    await clickByText(cdp, '完整解析');
    await until(() => cdp.eval('(document.body.textContent||"").indexOf("MOCK_REVEAL_7f3a")>=0'), '模型第三步', 10000);
    const step3 = await cdp.eval('document.body.textContent || ""');
    assert.ok(step3.indexOf('MOCK_REVEAL_7f3a') >= 0, '第三步应来自模型 reveal');
    assert.ok(step3.indexOf('参考答案：' + q.answer) < 0, '第三步不应是静态 reveal（内含答案拼装）');
    assert.strictEqual(mockReceived > 0, true, 'LLM 成功场景应真的请求 mock 服务');
  } finally {
    await closeBrowser(cdp);
  }
});

test('3. 有配置但 LLM 失败时，解析直达并给出失败文案与「再问一次」', async () => {
  setMock(() => ({ status: 500, body: { error: 'mock upstream failed' } }));
  const cdp = await openBrowser({ configured: true });
  try {
    const q = await gotoQuestion(cdp, TOPIC_ID);
    await clickId(cdp, 'btn-skip');
    await until(() => mockHits > 0, 'mock LLM 收到请求', 15000);
    await until(() => cdp.eval('!!(window.Explain && typeof window.Explain._noticeFor === "function")'), 'Explain 可用', 15000);
    await sleep(700);

    const notice = await cdp.eval('window.Explain._noticeFor("http", 500)');
    const st = await pageState(cdp, q);
    const raw = st.text;
    assert.ok(notice, 'Explain._noticeFor("http", 500) 应有文案');
    assert.ok(raw.indexOf(notice) >= 0, 'LLM 失败时应显示 Explain._noticeFor 的失败文案：' + notice);
    assert.ok(st.hasRetry, 'LLM 失败时应提供「再问一次」按钮');
    assert.ok(st.hasExplanation, 'LLM 失败时应直接展示解析原文');
    assert.ok(raw.indexOf('先别急着看答案——你回想一下') < 0, 'LLM 失败时不应退回静态模板首句');
    assert.ok(raw.indexOf('想想这一步做对了吗') < 0, 'LLM 失败时不应退回静态模板提示句');
  } finally {
    await closeBrowser(cdp);
  }
});

test('4. 等待 LLM 返回期间只显示中性 pending，不闪静态模板也不泄露模型首句', async () => {
  setMock(() => ({
    status: 200,
    delay: 800,
    body: explainBody({
      prompt: 'MOCK_PROMPT_7f3a 这是延迟返回的模型首句。',
      hint: 'MOCK_HINT_7f3a 延迟提示。',
      reveal: 'MOCK_REVEAL_7f3a 延迟解析。'
    })
  }));
  const cdp = await openBrowser({ configured: true });
  try {
    const q = await gotoQuestion(cdp, TOPIC_ID);
    await clickId(cdp, 'btn-skip');
    const started = Date.now();
    await until(() => cdp.eval('(function(){var t=document.body.innerText||"";'
      + 'return t.indexOf("AI 正在看你的答案")>=0 || t.indexOf("先别急着看答案")>=0'
      + ' || t.indexOf("MOCK_PROMPT_7f3a")>=0 || !!document.querySelector(".socratic");})()'), '讲解等待态', 5000);
    const elapsed = Date.now() - started;
    if (elapsed < 300) await sleep(300 - elapsed);

    const raw = await cdp.eval('document.body.innerText || ""');
    assert.ok(raw.indexOf('AI 正在看你的答案') >= 0, '等待期应显示中性 pending「AI 正在看你的答案」');
    assert.ok(raw.indexOf('先别急着看答案') < 0, '等待期不应先闪静态模板');
    assert.ok(raw.indexOf('MOCK_PROMPT_7f3a') < 0, '等待期不应提前显示模型首句');
  } finally {
    await closeBrowser(cdp);
  }
});

test('5. 全库守卫：静态引导文本不含答案，且静态模板函数已删除', () => {
  const legacy = [];
  if (typeof E.socraticSteps === 'function') legacy.push('DiagEngine.socraticSteps');
  let Explain = null;
  let explainLoadError = null;
  try { Explain = loadExplain(); } catch (e) { explainLoadError = e; }
  if (!Explain) legacy.push('Explain 模块无法加载' + (explainLoadError ? '（' + explainLoadError.message + '）' : ''));
  else if (typeof Explain.staticSteps === 'function') legacy.push('Explain.staticSteps');

  const leaks = [];
  if (typeof E.socraticSteps === 'function') {
    for (const q of BANK) {
      const topic = TOPIC_BY_ID.get(q.topicId) || { name: '' };
      let steps;
      try { steps = E.socraticSteps(topic, q); } catch (e) { continue; }
      if (!Array.isArray(steps) || steps.length < 2) continue;
      // prompt 里的「知识点名称」会把“6～10”这类范围带进来，先剥掉再查；reveal 本身含答案，不参与判定。
      const prompt = String(steps[0].text || '').replace(/「[^」]*」/g, '「」');
      const hint = String(steps[1].text || '');
      if (leaksAnswer(q, [prompt, hint])) {
        leaks.push(q.id + '(' + q.type + ', 答案=' + q.answer + ')');
      }
    }
  }

  const detail = []
    .concat(legacy.length ? ['仍存在静态模板函数：' + legacy.join('、')] : [])
    .concat(leaks.length ? ['静态引导文本泄露答案 ' + leaks.length + ' 题，例如：' + leaks.slice(0, 6).join(' | ')] : []);
  assert.ok(detail.length === 0, detail.join('；'));
});

/* ------------------------------------------------------------------ 运行 */

(async () => {
  const staticServer = await startStaticServer();
  const mockServer = await startMockLLM();
  let passed = 0;
  let failed = 0;
  try {
    for (const t of tests) {
      try {
        await t.fn();
        passed++;
        console.log('ok - ' + t.name);
      } catch (e) {
        failed++;
        console.error('not ok - ' + t.name);
        console.error('  ' + String((e && e.stack) || e).split('\n').join('\n  '));
      }
    }
  } finally {
    await new Promise((r) => staticServer.close(r));
    await new Promise((r) => mockServer.close(r));
  }
  console.log('passed=' + passed + ' failed=' + failed);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});
