#!/usr/bin/env node
/* 看门进程：由 tests/lib/chrome-guard.js 拉起，专门负责「测试进程非正常死亡」时的兜底清理。
 *
 * 为什么必须有它：process.on('exit' / 'SIGINT' / 'SIGTERM' / 'uncaughtException' /
 * 'unhandledRejection') 这五条路径在进程被 kill -9（或外部超时 SIGKILL）时一条都不会执行 ——
 * 内核直接收尸，JS 侧没有任何机会收尾。只有另一个独立进程能观察到「父进程没了」。
 *
 * 判据用 IPC 通道：测试进程通过 child_process 的 ipc 通道与本进程相连，父进程一死
 * （无论怎么死）内核关闭那条 socket，本进程收到 'disconnect' —— 这比轮询 pid 可靠，
 * 因为 kill(pid, 0) 对僵尸进程仍然返回成功。
 *
 * 收到 disconnect 后：杀掉所有登记的 Chrome 进程组（SIGKILL，整棵树，不按进程名匹配，
 * 绝不误伤用户自己的 Chrome），再删掉测试进程自己 mkdtemp 出来的临时目录（只删登记过的
 * 绝对路径，不做任何通配）。
 *
 * 用法（只由 chrome-guard.js 调用）：
 *   node chrome-reaper.js <parentPid> [临时目录...]
 *   之后接收消息 {type:'chrome', pid} / {type:'chrome-done', pid} / {type:'dir', path}
 */
'use strict';
const fs = require('fs');

const chromePids = new Set();   // Chrome 父进程 pid（detached 启动，也是进程组 id）
const dirs = new Set();         // 本次测试自己 mkdtemp 出来的目录（绝对路径）
let cleaned = false;

/* 只清自己登记的 pid 与目录：不按名字杀进程、不按通配删目录 */
function killGroup(pid) {
  try { process.kill(-pid, 'SIGKILL'); } catch (e) { /* 进程组已不存在 */ }
  try { process.kill(pid, 'SIGKILL'); } catch (e) { /* 进程已不存在 */ }
}

function cleanup() {
  if (cleaned) return;
  cleaned = true;
  for (const pid of chromePids) killGroup(pid);
  for (const dir of dirs) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch (e) { /* 尽力而为 */ }
  }
  chromePids.clear();
  dirs.clear();
}

process.on('message', function (m) {
  if (!m || !m.type) return;
  if (m.type === 'chrome' && m.pid) chromePids.add(m.pid);
  else if (m.type === 'chrome-done' && m.pid) chromePids.delete(m.pid);
  else if (m.type === 'dir' && m.path) dirs.add(m.path);
});

/* 父进程消失 = 通道断。清理后立刻退出（否则空转的看门进程自己就成了泄漏）。 */
process.on('disconnect', function () { cleanup(); process.exit(0); });

/* 启动瞬间父进程可能已经死了：通道没连上就立刻收尸。 */
if (!process.connected) { cleanup(); process.exit(0); }

/* 通道事件万一丢了，用轮询再兜一层（1s 一次，成本可忽略）。 */
setInterval(function () {
  if (!process.connected) { cleanup(); process.exit(0); }
}, 1000).unref();

/* 寿命上限：极端情况下（例如父进程把通道 fd 传给了别的进程）不留常驻孤儿。 */
setTimeout(function () { cleanup(); process.exit(0); }, 30 * 60 * 1000).unref();
