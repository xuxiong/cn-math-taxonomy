#!/usr/bin/env node
/* sw.js 预热预算守卫：node tests/test_sw_preheat.js
 *
 * 背景（卡 t_c84bc026，用户真实设备实测）：
 *   改之前 sw.js 的预热清单是 46 项 / 1043KB gzip。在 GitHub Pages 国内 8~10KB/s 的
 *   链路上等于一次 100 秒的持续下载，和首屏真正需要的 176KB 抢带宽。
 *   那台 PC 上当页 DCL 只有 457ms、19 个请求全命中缓存、没有主线程阻塞 ——
 *   慢的全是冷启动这一次预热。
 *   用户已明确选择：砍干净，离线只保首屏（放弃「断网也能打开知识图谱」）。
 *
 * 本文件守 7 条不再退化（每条都能独立报红）：
 *   1. CORE + SHELL + DATA 合计 gzip ≤ 150KB（超了打印逐项明细）；
 *   2. 黑名单里的东西一项都不许出现在清单里；
 *   3. 清单里的每一条都必须在仓库里读得到（防止写了不存在的路径）；
 *   4. CORE 那 5 项一项不少、内容不变；
 *   5. 预热不在 install 里跑 —— install 只装 CORE；
 *   6. 预热触发点必须在首屏就绪之后（requestIdleCallback，带 setTimeout 兜底）；
 *   7. 预热并发常量 ≤ 2。
 *
 * 另外守：VERSION 已抬到 v9、题库不预热、三条 fetch 策略没被新增分支。
 *
 * 写法与 test_pwa_load.js 一致：纯 node、无 DOM 基座，install/activate 段按监听器切片做
 * 源码级断言；gzip 用 zlib 现算（level 9），不信任任何手写常量。
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const SW = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');

const LIMIT = 150 * 1024;   /* 150KB = 153600 B */

/* 不许进预热清单的东西（卡里点名的九项 + 题库 bundle 目录） */
const BLACKLIST = [
  'questions.json',
  'topics.json',
  'dependencies.json',
  'cn-curriculum-standards.json',
  'funclab.js',
  'geomlab.js',
  'cytoscape',
  'dagre'
];

/* 改之前 CORE 就是这 5 项，逐字冻结 */
const CORE_FROZEN = ['./', 'index.html', 'assets/site.css', 'assets/pwa.css', 'assets/pwa.js'];

/* 首屏真正要用的数据，一项都不许少 */
const DATA_REQUIRED = ['data/topics-lite.json', 'data/id-aliases.json', 'data/questions-index.json'];

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e).split('\n').slice(0, 10).join('\n       ')); }
}

/* ------------------------------------------------------------------ 工具 */

/* 解析 sw.js 里的 var NAME = [ ... ]; 清单 */
function listOf(src, name) {
  const m = new RegExp('var ' + name + ' = \\[([\\s\\S]*?)\\];').exec(src);
  assert.ok(m, 'sw.js 里应有 var ' + name + ' = [...]');
  return (m[1].match(/'(?:[^'\\]|\\.)*'/g) || []).map(function (s) { return s.slice(1, -1); });
}

/* 从 fromIndex 处 startToken 之后的花括号开始做配对，返回 {…} 内部的文本。
 * 与 test_pwa_load.js 同一份实现（先抹掉字符串字面量，避免括号干扰）。 */
function bodyAfter(src, startToken) {
  const at = src.indexOf(startToken);
  assert.ok(at >= 0, '源码里找不到：' + startToken);
  const open = src.indexOf('{', at + startToken.length - 1);
  assert.ok(open >= 0, '找不到起始花括号：' + startToken);
  const masked = src.slice(0, open) + src.slice(open).replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, function (s) { return s.replace(/[{}]/g, '_'); });
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    const c = masked[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(open + 1, i); }
  }
  throw new Error('花括号不配对：' + startToken);
}

/* 取某段监听的源码 */
function section(src, kind) {
  const start = src.indexOf("addEventListener('" + kind + "'");
  assert.ok(start >= 0, 'sw.js 里找不到 ' + kind + ' 监听器');
  const rest = src.slice(start);
  const next = rest.indexOf('\nself.addEventListener(', 10);
  return next < 0 ? rest : rest.slice(0, next);
}

/* 只取监听器回调体 —— 用花括号配对，别把后面的 warm()/scheduleWarm() 定义一起切进来。
 * （test_pwa_load.js 里的 section() 是切到下一个监听器，对「函数定义在监听器之后」的
 * 源码形状会把定义也算进 activate 段，所以这里单独做精确版。） */
function listenerBody(src, kind) {
  return bodyAfter(src, "addEventListener('" + kind + "', function (event)");
}

/* 缓存键 → 仓库里的真实文件。'./' 与 'dir/' 都按 index.html 算。 */
function fileOf(p) {
  if (p === './') return path.join(ROOT, 'index.html');
  if (/\/$/.test(p)) return path.join(ROOT, p, 'index.html');
  return path.join(ROOT, p);
}

function gzOf(p) {
  const f = fileOf(p);
  if (!fs.existsSync(f) || !fs.statSync(f).isFile()) return null;
  return zlib.gzipSync(fs.readFileSync(f), { level: 9 }).length;
}

/* 三条清单合起来的总量报告：{ total, count, rows, missing } */
function budgetReport(lists, root) {
  const seen = {};
  const rows = [];
  const missing = [];
  let total = 0;
  ['CORE', 'SHELL', 'DATA'].forEach(function (name) {
    (lists[name] || []).forEach(function (p) {
      if (seen[p]) return;                       /* 与 CORE 重复的项只算一次（缓存键相同就是同一次下载） */
      seen[p] = true;
      const f = root ? path.join(root, p === './' ? 'index.html' : (/\/$/.test(p) ? p + 'index.html' : p)) : fileOf(p);
      if (!fs.existsSync(f) || !fs.statSync(f).isFile()) { missing.push(p); return; }
      const gz = zlib.gzipSync(fs.readFileSync(f), { level: 9 }).length;
      total += gz;
      rows.push({ list: name, path: p, gz: gz });
    });
  });
  return { total: total, count: rows.length, rows: rows, missing: missing };
}

function kb(n) { return (n / 1024).toFixed(1) + ' KB'; }

function detail(rows) {
  return rows.map(function (r) { return '    ' + String(r.gz).padStart(7) + ' B  ' + r.list + '  ' + r.path; }).join('\n');
}

/* 黑名单：任意一条命中即报错（纯函数，自检要复用） */
function assertNoBanned(lists) {
  ['CORE', 'SHELL', 'DATA'].forEach(function (name) {
    (lists[name] || []).forEach(function (p) {
      BLACKLIST.forEach(function (bad) {
        assert.strictEqual(p.indexOf(bad), -1, name + ' 里不许出现 ' + p + '（命中黑名单 ' + bad + '）');
      });
    });
  });
}

/* 并发常量：源码级断言（纯函数，自检要复用） */
function assertConcurrency(src) {
  const m = /var WARM_CONCURRENCY = (\d+);/.exec(src);
  assert.ok(m, 'sw.js 里应有 var WARM_CONCURRENCY = <n>;');
  const n = parseInt(m[1], 10);
  assert.ok(n >= 1, '预热并发至少 1，实际 ' + n);
  assert.ok(n <= 2, '预热并发必须 ≤ 2（弱网下开 8 个并发只会互相拖慢），实际 ' + n);
  return n;
}

const lists = { CORE: listOf(SW, 'CORE'), SHELL: listOf(SW, 'SHELL'), DATA: listOf(SW, 'DATA') };

/* ------------------------------------------------------ 1. 预热预算总量 */
test('预热清单 CORE+SHELL+DATA 合计 gzip ≤ 150KB', function () {
  const r = budgetReport(lists);
  console.log('       预热 ' + r.count + ' 项 / ' + r.total + ' B = ' + kb(r.total) + ' gzip（上限 ' + kb(LIMIT) + '）');
  console.log(detail(r.rows));
  if (r.total > LIMIT) {
    assert.fail('预热合计 ' + kb(r.total) + ' 超预算 ' + kb(LIMIT) + '，逐项明细见上');
  }
});

/* --------------------------------------------------------- 2. 黑名单 */
test('黑名单：questions/topics/dependencies/课标/funclab/geomlab/cytoscape/dagre 一项都不许预热', function () {
  assertNoBanned(lists);
});

/* ------------------------------------------------ 3. 清单路径必须真实存在 */
test('清单里的每一条都必须在仓库里读得到（没有写错的路径）', function () {
  const r = budgetReport(lists);
  assert.deepStrictEqual(r.missing, [], '这些路径在仓库里不存在：' + r.missing.join(', '));
  ['CORE', 'SHELL', 'DATA'].forEach(function (name) {
    assert.ok(lists[name].length > 0, name + ' 不应为空');
    lists[name].forEach(function (p) {
      assert.ok(gzOf(p) !== null, name + ' 里的 ' + p + ' 在仓库里读不到文件');
    });
  });
});

/* ------------------------------------------------------- 4. CORE 不许变 */
test('CORE 仍是那 5 项（数量、顺序、内容都与改动前一致）', function () {
  assert.strictEqual(lists.CORE.length, 5, 'CORE 必须正好 5 项，实际 ' + lists.CORE.length);
  assert.deepStrictEqual(lists.CORE, CORE_FROZEN, 'CORE 内容不许改（它是离线兜底的地基）');
});

/* --------------------------------------------- 5. 预热不在 install 里跑 */
test('install 只装 CORE：waitUntil 里不出现 SHELL / DATA', function () {
  const inst = section(SW, 'install');
  assert.ok(/CORE\.map\(/.test(inst), 'install 应逐项预缓存 CORE');
  assert.ok(/cache\.add\(fresh\(p\)\)/.test(inst), 'install 应逐项 cache.add(fresh(p))');
  assert.strictEqual(inst.indexOf('SHELL'), -1, 'install 里不许出现 SHELL（预热必须在首屏之后）');
  assert.strictEqual(inst.indexOf('DATA'), -1, 'install 里不许出现 DATA');
  assert.strictEqual(/cache\.addAll\(/.test(inst), false, 'install 不许用 addAll（全或无会让慢链路废掉离线能力）');
  assert.ok(/skipWaiting\(\)/.test(inst), 'install 装完 CORE 就 skipWaiting（不许等预热）');
});

/* -------------------------------- 6. 预热触发点：首屏就绪之后（rIC + 兜底） */
test('预热不在 activate 里直接开跑，而是排队到首屏就绪（rIC + setTimeout 兜底）', function () {
  const act = listenerBody(SW, 'activate');
  assert.ok(/scheduleWarm\(\)/.test(act), 'activate 之后应调用 scheduleWarm() 排队');
  assert.strictEqual(/\bwarm\(\)/.test(act), false, 'activate 里不许直接 warm()（会和首屏抢带宽）');
  assert.strictEqual(/await\s+scheduleWarm/.test(act), false, '预热不许被 await（会拖慢激活）');
  /* 预热调用也不许出现在 install 里 */
  assert.strictEqual(/\bwarm\(\)|scheduleWarm\(\)/.test(listenerBody(SW, 'install')), false, 'install 里不许出现任何预热调用');

  /* warm() 全文件只许在 scheduleWarm 的 start 里被调一次 —— 触发点唯一 */
  const calls = SW.match(/\bwarm\(\);/g) || [];
  assert.strictEqual(calls.length, 1, 'warm() 只许在 scheduleWarm 里被调用一次，实际 ' + calls.length + ' 处');

  const sched = bodyAfter(SW, 'function scheduleWarm()');
  assert.ok(/requestIdleCallback/.test(sched), 'scheduleWarm 应走 requestIdleCallback（等首屏空闲）');
  assert.ok(/setTimeout/.test(sched), 'scheduleWarm 必须有 setTimeout 兜底（没有 rIC 的浏览器不能永不触发）');
  assert.ok(/typeof self\.requestIdleCallback === 'function'/.test(sched), 'rIC 调用前要判存在');
  const delay = /var WARM_DELAY_MS = (\d+);/.exec(SW);
  assert.ok(delay, 'sw.js 里应有 var WARM_DELAY_MS = <ms>; 的兜底延时常量');
  assert.ok(parseInt(delay[1], 10) >= 3000, '兜底延时不能太小（会和首屏抢带宽），实际 ' + delay[1] + 'ms');
});

/* ---------------------------------------------------- 7. 并发常量 ≤ 2 */
test('预热并发常量 ≤ 2，且真的用序号池限流（不是 Promise.all 一把开）', function () {
  const n = assertConcurrency(SW);
  assert.ok(n <= 2, '并发应 ≤ 2');
  const body = bodyAfter(SW, 'function warm()');
  assert.ok(/WARM_CONCURRENCY/.test(body), 'warm() 应按 WARM_CONCURRENCY 开泳道');
  assert.ok(!/Promise\.all\(queue\.map/.test(body), 'warm() 不许对整条队列 Promise.all 一把开');
  assert.ok(/\.catch\(/.test(body), '每一项都要独立 catch（失败只丢该项）');
  assert.ok(/SHELL/.test(body) && /DATA/.test(body), '预热要补 SHELL 剩余项与 DATA');
});

/* ------------------------------------------------------------- 8. VERSION */
test('VERSION 已是 v10（旧的 cnm-pwa-v8 缓存靠它清掉）', function () {
  assert.ok(/var VERSION = 'v10';/.test(SW), 'VERSION 应该是 v10');
  assert.strictEqual(SW.indexOf("VERSION = 'v8'"), -1, 'VERSION 不应再是 v8');
  assert.strictEqual(SW.indexOf("VERSION = 'v9'"), -1, 'VERSION 不应再是 v9');
});

/* --------------------------------------------------- 9. 首屏数据必须都在 */
test('DATA 含首屏三份（topics-lite / id-aliases / questions-index）', function () {
  DATA_REQUIRED.forEach(function (p) {
    assert.ok(lists.DATA.indexOf(p) >= 0, 'DATA 里应含 ' + p);
  });
});

test('题库仍不预热（questions.json 与 data/questions/*.json 都不在清单里）', function () {
  lists.DATA.forEach(function (p) {
    assert.strictEqual(p.indexOf('data/questions/') >= 0, false, 'DATA 里不许预热题库 bundle：' + p);
  });
  assert.strictEqual(lists.DATA.indexOf('data/questions.json'), -1, 'DATA 里不许预热 data/questions.json');
});

/* ------------------------------------------- 10. 没新增 fetch 策略分支 */
test('fetch 仍然只有三条策略（没有为砍预热新增第四条）', function () {
  const f = section(SW, 'fetch');
  assert.strictEqual((f.match(/event\.respondWith\(/g) || []).length, 3, 'fetch 事件应恰好三条 respondWith 分支');
  assert.ok(/req\.mode === 'navigate'/.test(f), '缺 navigate 分支');
  assert.ok(/networkFirst\(req, true, abs\('\.\/'\)\)/.test(f), 'navigate 应走 networkFirst(…, true, 首页兜底)');
  assert.ok(/json\|png\|svg\|ico\|webmanifest/.test(f), '缺 json/png/svg/ico/webmanifest 分支');
  assert.ok(/staleWhileRevalidate\(req\)/.test(f), '数据与图标应走 staleWhileRevalidate（大文件靠它按需入缓存）');
  assert.ok(/event\.respondWith\(networkFirst\(req, false, null\)\)/.test(f), '缺「其余资源 → networkFirst」分支');
});

/* ------------------------------------------------- 11. 自检：断言真的会红 */
test('自检：把 data/questions.json 加回 DATA，黑名单断言必须报错', function () {
  const bad = { CORE: lists.CORE, SHELL: lists.SHELL, DATA: lists.DATA.concat(['data/questions.json']) };
  assert.throws(function () { assertNoBanned(bad); }, /黑名单/, '黑名单守卫没抓到回退的 questions.json');
});

test('自检：把 topics.json / dependencies.json / cytoscape 塞回清单，黑名单断言必须报错', function () {
  ['data/topics.json', 'data/dependencies.json', 'assets/vendor/cytoscape.min.js', 'diagnose/funclab.js'].forEach(function (p) {
    assert.throws(function () { assertNoBanned({ CORE: lists.CORE, SHELL: lists.SHELL.concat([p]), DATA: lists.DATA }); },
      /黑名单/, '黑名单守卫漏了 ' + p);
  });
});

test('自检：写一个不存在的路径，存在性断言必须报错', function () {
  const bad = { CORE: lists.CORE, SHELL: lists.SHELL.concat(['assets/vendor/not-here.js']), DATA: lists.DATA };
  assert.deepStrictEqual(budgetReport(bad).missing, ['assets/vendor/not-here.js'], '存在性守卫没抓到写错的路径');
});

test('自检：把大文件加回清单，总量守卫必须超限', function () {
  const bad = { CORE: lists.CORE, SHELL: lists.SHELL, DATA: lists.DATA.concat(['data/topics.json']) };
  assert.ok(budgetReport(bad).total > LIMIT, '总量守卫没算出来超限（改前 46 项 1043KB 必须被判红）');
});

test('自检：把并发常量改成 8，并发断言必须报错', function () {
  const bad = SW.replace('var WARM_CONCURRENCY = 2;', 'var WARM_CONCURRENCY = 8;');
  assert.notStrictEqual(bad, SW, '自检改动没生效');
  assert.throws(function () { assertConcurrency(bad); }, /≤ 2/, '并发守卫没抓到 8 并发');
});

test('自检：把预热挪回 activate 直接调用，触发点断言必须报错', function () {
  const bad = SW.replace('  scheduleWarm();', '  warm();');
  assert.notStrictEqual(bad, SW, '自检改动没生效');
  const act = listenerBody(bad, 'activate');
  assert.ok(/\bwarm\(\)/.test(act), '自检样本应已变成直接调用 warm()');
  assert.throws(function () { assert.strictEqual(/\bwarm\(\)/.test(act), false, 'activate 里不许直接 warm()'); },
    /activate 里不许直接 warm/, '触发点守卫没抓到「install/activate 里直接开跑」');
});

console.log('\n' + (failed === 0 ? '全部通过' : '存在失败') + '：' + passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);
