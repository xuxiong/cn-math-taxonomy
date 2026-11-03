'use strict';
/* 浏览器测试的 Chrome 兜底回收（进程级）。
 *
 * 背景（卡 t_e87dcc8b）：旧写法只在 finally 里 `chrome && chrome.kill('SIGKILL')`，三类情况漏掉：
 *   1) openBrowser() 里 spawn 之后、`chrome = spawn(...)` 赋值之前抛错（等 DevToolsActivePort
 *      超时就是这条路径）→ chrome 还是 null，无进程可杀；
 *   2) 测试进程自己被 SIGKILL / 外部超时打断 → finally 根本不执行；
 *   3) main() 在 openBrowser() 之外抛错（server 起不来）→ 已起的 Chrome 没人收。
 * 真机表现：16 个 Chrome 进程空转到深夜风扇狂转，$TMPDIR 下 148 个 cnm-* 目录 / 3.3GB。
 *
 * 本模块的做法：
 *   - spawn 之后**立刻**登记 pid（不等任何 await，赋值失败也能杀）；Chrome 用 detached 起，
 *     自带进程组，收尾时 kill(-pid, SIGKILL) 连 helpers/renderers 一起带走；
 *   - 装 process.on('exit' / 'SIGINT' / 'SIGTERM' / 'uncaughtException' / 'unhandledRejection')
 *     五条路径的收尾（最后一条兜不住的 SIGKILL 交给 chrome-reaper.js 看门进程）；
 *   - 临时目录统一用 tempDir() 创建并登记，退出时只删自己 mkdtemp 出来的那几个绝对路径，
 *     **不做任何通配**（通配删 $TMPDIR/cnm-* 会误删并发跑的其它测试）。
 *
 * 用法：
 *   const guard = require('./lib/chrome-guard');       // require 即装好收尾钩子
 *   const out = guard.tempDir('cnm-xxx-');             // 代替 fs.mkdtempSync(...)
 *   const chrome = guard.launch(chromePath, args, { logFile: path.join(out, 'chrome.log') });
 *   ... await 端口 ...
 *   guard.kill(chrome);                                 // 代替 chrome.kill('SIGKILL')
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const REAPER = path.join(__dirname, 'chrome-reaper.js');

const live = new Set();        // 当前存活的 Chrome 子进程
const ownedDirs = new Set();   // 本进程自己 mkdtemp 出来的目录
let reaper = null;             // 看门进程（懒启动，一个测试进程一个）
let installed = false;

/* 进程组整棵树一起杀：Chrome 的 helpers/renderers 都在同一个组里 */
function killTree(child) {
  if (!child || !child.pid) return;
  try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { /* 组已不在 */ }
  try { child.kill('SIGKILL'); } catch (e) { /* 进程已不在 */ }
  live.delete(child);
  if (reaper && reaper.connected) {
    try { reaper.send({ type: 'chrome-done', pid: child.pid }); } catch (e) { /* 通道已断 */ }
  }
}

function killAll() {
  for (const child of Array.from(live)) killTree(child);
}

function removeOwnedDirs() {
  for (const dir of ownedDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch (e) { /* 尽力而为 */ }
  }
  ownedDirs.clear();
}

function release() {
  killAll();
  removeOwnedDirs();
}

function startReaper() {
  if (reaper) return reaper;
  const args = [REAPER, String(process.pid)].concat(Array.from(ownedDirs));
  let child;
  try {
    /* detached + ipc：父进程一死（含 kill -9）通道就断，看门进程据此收尸 */
    child = spawn(process.execPath, args, { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], detached: true });
  } catch (e) {
    return null;
  }
  child.on('error', function () { /* 看门进程起不来时不影响测试本身 */ });
  reaper = child;
  if (child.channel && child.channel.unref) child.channel.unref();
  child.unref();
  /* 启动时已存在的目录通过 argv 传了，这里补发一次给「之后新增」的目录用 */
  for (const dir of ownedDirs) {
    try { child.send({ type: 'dir', path: dir }); } catch (e) { /* 通道未就绪 */ }
  }
  return child;
}

/* 交给看门进程登记：SIGKILL 兜底时它才知道该杀谁、该删哪个目录 */
function tellReaper(msg) {
  const child = startReaper();
  if (!child) return;
  try { child.send(msg); } catch (e) { /* 通道已断：看门进程会按 argv 里的旧登记收尾 */ }
}

function install() {
  if (installed) return guard;
  installed = true;
  /* 1. 正常退出（含 process.exit） */
  process.on('exit', release);
  /* 2. Ctrl-C */
  process.on('SIGINT', function () { release(); process.exit(130); });
  /* 3. kill / 构建系统超时先 SIGTERM */
  process.on('SIGTERM', function () { release(); process.exit(143); });
  /* 4/5. 未捕获异常与未处理的 rejection：收尾后照旧以失败退出（不掩盖真实失败） */
  process.on('uncaughtException', function (err) {
    release();
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });
  process.on('unhandledRejection', function (err) {
    release();
    console.error('unhandledRejection: ' + (err && err.stack ? err.stack : err));
    process.exit(1);
  });
  return guard;
}

/* 本次测试自己的临时目录（退出/被打断时只删登记的这几个绝对路径） */
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  ownedDirs.add(dir);
  tellReaper({ type: 'dir', path: dir });
  return dir;
}

/*
 * 启动一个受兜底保护的子进程（浏览器测试只用来起 Chrome）。
 * spawn 之后立刻登记 —— 后面无论哪一步抛错，收尾都按 pid 杀得到。
 */
function launch(command, args, options) {
  const opts = Object.assign({ stdio: ['ignore', 'ignore', 'ignore'] }, options || {});
  if (opts.logFile) {
    opts.stdio = ['ignore', 'ignore', fs.openSync(opts.logFile, 'w')];
    delete opts.logFile;
  }
  opts.detached = true;   // 自成进程组：kill(-pid) 能把 helpers/renderers 一起带走
  const child = spawn(command, args, opts);
  if (child && child.pid) {
    live.add(child);
    child.once('exit', function () { live.delete(child); });
    tellReaper({ type: 'chrome', pid: child.pid });
    /* 不让 Chrome 反过来把测试进程吊住。
     * 为什么关键：openBrowser() 抛错发生在每个用例的 try 之外（`const cdp = await openBrowser()`），
     * 用例的 finally 根本不会执行；这时如果子进程句柄还让事件循环活着，进程就永远退不出去，
     * 而 'exit' 钩子只有在进程真要退出时才跑 —— 结果是 Chrome 一直活着（实测：把 CHROME 指向
     * 一个真 Chrome、但不写 DevToolsActivePort，node 打完「0 passed, 2 failed」后挂住不退出）。
     * unref 之后主流程跑完、其它句柄清空，进程就能正常退出，退出钩子再把 Chrome 收掉。 */
    if (typeof child.unref === 'function') child.unref();
  }
  child.on('error', function () { /* 交给调用方的 until 超时暴露；不要让 error 事件把进程打崩 */ });
  return child;
}

/* 兼容旧调用点：guard.kill(chrome) 等价于原来的 chrome.kill('SIGKILL')，但会连带整棵进程树 */
function kill(child) {
  if (!child) return;
  killTree(child);
}

const guard = {
  install: install,
  tempDir: tempDir,
  launch: launch,
  kill: kill,
  killAll: killAll,
  release: release
};

module.exports = install();
