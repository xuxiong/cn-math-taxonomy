#!/usr/bin/env node
/* 禁缓存静态服务（scripts/serve.js）测试：node tests/test_serve.js
 *
 * 覆盖范围（与 J 卡验收标准 1–6 一一对应）：
 *   1. /diagnose/app.js 的 Cache-Control 含 no-store
 *   2. /diagnose/style.css 同样含 no-store
 *   3. /diagnose/ 返回 index.html 正文（不是 404、不是目录列表）
 *   4. /nope.js → 404 纯文本
 *   5. 目录穿越（明文 ../ 与 %2e%2e 两种写法）不得返回 200 或真实文件内容
 *   6. .js 的 Content-Type 是 text/javascript
 *
 * 额外断言（本卡实现细节的回归保护）：
 *   - Pragma / Expires 头也在
 *   - MIME 表覆盖 html/js/css/json/png/jpg/svg/ico/woff2/map
 *   - 目录不带斜杠时 301 到带斜杠
 *   - HEAD 与 GET 同头，且不发正文
 *   - 端口占用的错误提示含端口号（serve.js 以子进程方式验证，退码非 0）
 *
 * 起服务用 Node 内置 http 模块自建临时服务器（随机端口），测试要用到的文件在临时目录里现造，
 * 因此不依赖仓库里业务文件的具体内容（diagnose/app.js 怎么改都不会让本测试失效），
 * 也不依赖外网。
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');


const SERVE = require('../scripts/serve.js');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e).split('\n').slice(0, 8).join('\n       ')); }
}

/* ---------------- 临时站点：模拟仓库根目录 ---------------- */
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'serve-test-'));
const OUTSIDE = fs.mkdtempSync(path.join(os.tmpdir(), 'serve-outside-'));
const SECRET = 'TOP-SECRET-' + process.pid;

function mk(rel, body) {
  const p = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  return p;
}
mk('diagnose/index.html', '<!doctype html>\n<html><body><div id="app">诊断页</div></body></html>\n');
mk('diagnose/app.js', 'export const tag = "explain-fold";\n');
mk('diagnose/style.css', 'body { margin: 0; }\n');
mk('data/questions.json', '{"items":[1,2,3]}\n');
mk('assets/pixel.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
mk('assets/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
mk('assets/favicon.ico', Buffer.from([0x00, 0x00, 0x01, 0x00]));
mk('assets/font.woff2', Buffer.from([0x77, 0x4f, 0x46, 0x32]));
mk('assets/app.js.map', '{"version":3}\n');
mk('assets/photo.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
// 越界目标：临时目录的兄弟目录里的「机密」文件
fs.writeFileSync(path.join(OUTSIDE, 'passwd'), SECRET + '\n');

let server = null;
let base = '';

function start() {
  return new Promise(function (resolve, reject) {
    server = SERVE.createServer({ dir: ROOT, quiet: true });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', function () {
      base = 'http://127.0.0.1:' + server.address().port;
      resolve();
    });
  });
}
function stop() {
  return new Promise(function (resolve) {
    if (!server) return resolve();
    server.close(function () { resolve(); });
  });
}
/** 用裸 http 发请求，等价 curl -I（fetch 拿不到 HEAD 的完整头语义时的兜底） */
function raw(method, urlPath) {
  return new Promise(function (resolve, reject) {
    const req = http.request(base + urlPath, { method: method }, function (res) {
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/* ================================================================ */
(async function main() {
  await start();

  console.log('\n1. 代码文件禁缓存');
  await test('/diagnose/app.js 的 Cache-Control 含 no-store', async function () {
    const r = await raw('HEAD', '/diagnose/app.js');
    assert.strictEqual(r.status, 200);
    const cc = String(r.headers['cache-control'] || '');
    assert.ok(/no-store/.test(cc), 'Cache-Control 应含 no-store，实际 ' + JSON.stringify(cc));
    assert.ok(/no-cache/.test(cc) && /must-revalidate/.test(cc) && /max-age=0/.test(cc), 'Cache-Control 应含 no-cache/must-revalidate/max-age=0，实际 ' + cc);
  });
  await test('/diagnose/app.js 带 Pragma: no-cache 与 Expires: 0', async function () {
    const r = await raw('HEAD', '/diagnose/app.js');
    assert.strictEqual(r.headers['pragma'], 'no-cache');
    assert.strictEqual(r.headers['expires'], '0');
  });
  await test('/diagnose/style.css 的 Cache-Control 含 no-store', async function () {
    const r = await raw('HEAD', '/diagnose/style.css');
    assert.strictEqual(r.status, 200);
    assert.ok(/no-store/.test(String(r.headers['cache-control'] || '')), 'style.css 应禁缓存');
  });
  await test('/data/questions.json 的 Cache-Control 含 no-store', async function () {
    const r = await raw('HEAD', '/data/questions.json');
    assert.strictEqual(r.status, 200);
    assert.ok(/no-store/.test(String(r.headers['cache-control'] || '')), 'json 数据应禁缓存');
  });
  await test('GET 与 HEAD 的响应头一致（no-store 不是只有 HEAD 才有）', async function () {
    const h = await raw('HEAD', '/diagnose/app.js');
    const g = await raw('GET', '/diagnose/app.js');
    assert.strictEqual(h.headers['cache-control'], g.headers['cache-control']);
    assert.ok(/no-store/.test(String(g.headers['cache-control'])));
  });

  console.log('\n2. 目录索引 / 303 语义');
  await test('/diagnose/ 返回 index.html 正文', async function () {
    const r = await raw('GET', '/diagnose/');
    assert.strictEqual(r.status, 200);
    assert.ok(/<html/i.test(r.body), '应返回 HTML 正文，实际 ' + r.body.slice(0, 80));
    assert.ok(r.body.indexOf('诊断页') !== -1, '应返回 index.html 的内容');
    assert.ok(!/Index of \//.test(r.body), '不应是目录列表');
    assert.ok(/no-store/.test(String(r.headers['cache-control'])), 'html 也要禁缓存');
  });
  await test('/diagnose（不带斜杠）301 到 /diagnose/', async function () {
    const r = await raw('GET', '/diagnose');
    assert.strictEqual(r.status, 301);
    assert.strictEqual(r.headers.location, '/diagnose/');
  });

  console.log('\n3. 404 / Content-Type');
  await test('/nope.js → 404 纯文本', async function () {
    const r = await raw('GET', '/nope.js');
    assert.strictEqual(r.status, 404);
    assert.ok(/^text\/plain/.test(String(r.headers['content-type'] || '')), '404 应为纯文本，实际 ' + r.headers['content-type']);
  });
  await test('/diagnose/ 下的缺失文件 → 404', async function () {
    const r = await raw('GET', '/diagnose/missing.css');
    assert.strictEqual(r.status, 404);
  });
  await test('.js 的 Content-Type 是 text/javascript', async function () {
    const r = await raw('HEAD', '/diagnose/app.js');
    assert.ok(/^text\/javascript/.test(String(r.headers['content-type'] || '')), '实际 ' + r.headers['content-type']);
  });
  await test('MIME 覆盖 html/js/css/json/png/jpg/svg/ico/woff2/map', async function () {
    const cases = [
      ['/diagnose/index.html', /^text\/html/],
      ['/diagnose/app.js', /^text\/javascript/],
      ['/diagnose/style.css', /^text\/css/],
      ['/data/questions.json', /^application\/json/],
      ['/assets/pixel.png', /^image\/png/],
      ['/assets/photo.jpg', /^image\/jpeg/],
      ['/assets/logo.svg', /^image\/svg\+xml/],
      ['/assets/favicon.ico', /^image\/(x-icon|vnd\.microsoft\.icon)/],
      ['/assets/font.woff2', /^font\/woff2/],
      ['/assets/app.js.map', /^application\/json/],
    ];
    for (const [url, re] of cases) {
      const r = await raw('HEAD', url);
      assert.strictEqual(r.status, 200, url + ' 应 200');
      assert.ok(re.test(String(r.headers['content-type'] || '')), url + ' 的 Content-Type 期望 ' + re + '，实际 ' + r.headers['content-type']);
    }
  });

  console.log('\n4. 路径穿越');
  await test('明文 ../ 穿越到 root 之外 → 非 200', async function () {
    const r = await raw('GET', '/../../../../../../etc/passwd');
    assert.notStrictEqual(r.status, 200, '不应返回 200，实际 ' + r.status);
    assert.ok(r.body.indexOf('root:') === -1, '不得泄露 /etc/passwd 内容');
  });
  await test('%2e%2e 编码穿越 → 非 200，且不返回机密内容', async function () {
    const relToOutside = path.relative(ROOT, OUTSIDE).split(path.sep).map(function () { return '%2e%2e'; });
    const url = '/' + relToOutside.join('/') + '/passwd';
    const r = await raw('GET', url);
    assert.notStrictEqual(r.status, 200, url + ' 不应返回 200，实际 ' + r.status);
    assert.ok(r.body.indexOf(SECRET) === -1, '不得返回兄弟目录里的机密内容');
  });
  await test('明文 ../ 指向兄弟目录的机密文件 → 不返回内容', async function () {
    const relToOutside = path.relative(ROOT, OUTSIDE).split(path.sep);
    const url = '/' + relToOutside.join('/') + '/passwd';
    const r = await raw('GET', url);
    assert.notStrictEqual(r.status, 200);
    assert.ok(r.body.indexOf(SECRET) === -1, '不得返回兄弟目录里的机密内容');
  });
  await test('resolveRequestPath 直接判定：越界 403、根内正常', async function () {
    const root = path.resolve(ROOT);
    assert.strictEqual(SERVE.resolveRequestPath(root, '/diagnose/app.js').ok, true);
    const bad = SERVE.resolveRequestPath(root, '/%2e%2e/%2e%2e/etc/passwd');
    assert.strictEqual(bad.ok, false);
    assert.strictEqual(bad.status, 403);
    // 前缀相同但不是子目录（root=…/serve-test-xxx，兄弟 …/serve-test-xxx-evil）不能算在根内
    const sibling = SERVE.resolveRequestPath(root, '/../' + path.basename(root) + '-evil/x.js');
    assert.strictEqual(sibling.ok, false);
  });
  await test('非法 URL 编码 → 400 而不是让进程崩', async function () {
    const r = await raw('GET', '/%E0%A4%A');
    assert.strictEqual(r.status, 400);
  });

  console.log('\n5. 方法与健壮性');
  await test('POST → 405', async function () {
    const r = await raw('POST', '/diagnose/app.js');
    assert.strictEqual(r.status, 405);
  });
  await test('服务在错误请求之后仍可用（无未捕获异常）', async function () {
    await raw('GET', '/../../../../etc/passwd');
    const r = await raw('GET', '/diagnose/app.js');
    assert.strictEqual(r.status, 200);
  });

  await stop();

  console.log('\n6. 端口占用（子进程实测）');
  // 前一个测试挂住的话会拖死整轮，所以端口占用用 spawn + 超时杀进程，不用同步阻塞调用
  await test('端口被占时打印含端口号的错误并以非 0 退出', async function () {
    const blocker = http.createServer(function (req, res) { res.end('x'); });
    await new Promise(function (resolve) { blocker.listen(0, '127.0.0.1', resolve); });
    const busyPort = blocker.address().port;
    try {
      // 关键：用 127.0.0.1 去连，确认端口在同一地址族上真的被占。
      // macOS/Node 上 "localhost" 可能先落到 ::1，而占位服务只监听了 127.0.0.1，
      // 那样 serve.js 会成功启动（假阴性），所以先探测一次。
      const busy = await new Promise(function (resolve) {
        const probe = http.request({ host: '127.0.0.1', port: busyPort, path: '/', method: 'GET' }, function (res) {
          res.resume();
          res.on('end', function () { resolve(true); });
        });
        probe.on('error', function () { resolve(false); });
        probe.end();
      });
      assert.ok(busy, '前置条件不成立：127.0.0.1:' + busyPort + ' 未被占用');
      const r = await new Promise(function (resolve) {
        const cp = require('child_process').spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'serve.js'), String(busyPort)], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        cp.stdout.on('data', function (d) { out += d; });
        cp.stderr.on('data', function (d) { out += d; });
        const timer = setTimeout(function () { cp.kill('SIGKILL'); resolve({ status: 'timeout', out: out }); }, 8000);
        cp.on('close', function (code) { clearTimeout(timer); resolve({ status: code, out: out }); });
      });
      assert.notStrictEqual(r.status, 'timeout', '端口被占时应快速退出，实际挂住不退出');
      assert.notStrictEqual(r.status, 0, '端口被占时应非 0 退出');
      assert.ok(r.out.indexOf(String(busyPort)) !== -1, '错误信息里要有被占用的端口号，实际：' + r.out.trim());
      assert.ok(/占用/.test(r.out), '错误信息要明确说端口被占用，实际：' + r.out.trim());
      assert.ok(!/\n\s+at /.test(r.out), '不应打崩溃栈，实际：' + r.out.trim());
    } finally {
      await new Promise(function (resolve) { blocker.close(resolve); });
    }
  });

  console.log('\n7. 真实仓库（diagnose/ 下的 app.js 与 index.html）');
  await test('仓库根目录下 /diagnose/ 与 /diagnose/app.js 正常且禁缓存', async function () {
    const repoRoot = path.resolve(__dirname, '..');
    assert.ok(fs.existsSync(path.join(repoRoot, 'diagnose', 'app.js')), '仓库里应有 diagnose/app.js');
    const s = await new Promise(function (resolve) {
      const srv = SERVE.createServer({ dir: repoRoot, quiet: true });
      srv.listen(0, '127.0.0.1', function () { resolve(srv); });
    });
    const port = s.address().port;
    try {
      const js = await fetch('http://127.0.0.1:' + port + '/diagnose/app.js');
      assert.strictEqual(js.status, 200);
      assert.ok(/no-store/.test(String(js.headers.get('cache-control') || '')));
      assert.ok(/^text\/javascript/.test(String(js.headers.get('content-type') || '')));
      const html = await fetch('http://127.0.0.1:' + port + '/diagnose/');
      assert.strictEqual(html.status, 200);
      const text = await html.text();
      assert.ok(/<html/i.test(text) && !/Index of \//.test(text), '应是 index.html 正文');
    } finally {
      await new Promise(function (resolve) { s.close(resolve); });
    }
  });

  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.rmSync(OUTSIDE, { recursive: true, force: true });

  console.log('\n' + (failed === 0 ? '全部通过' : '存在失败') + '：' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed === 0 ? 0 : 1);
})().catch(function (e) {
  console.error('测试脚本自身出错：', e);
  process.exit(1);
});
