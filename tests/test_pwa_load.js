#!/usr/bin/env node
/* PWA 首屏加载链路守卫：node tests/test_pwa_load.js
 *
 * 背景（手机弱网实测，50KB/s 量级）：
 *   - sw.js 原来在 install 里 cache.addAll(SHELL) —— 30 个壳 + 5 份数据约 1.75MB
 *     全有才装得上，装不完就永远 active=false、缓存 0 项，每次打开都全量重下；
 *   - diagnose/app.js 的 loadData() 把「可选」的题库串在首屏阻塞链上，
 *     首屏必须等 1.27MB（gzip）/ 7.5MB 原文的 questions.json 下完并解析。
 * 本文件守这两条不再退化。
 *
 * 覆盖：
 *   sw.js
 *     1. VERSION 已是 v6（旧缓存靠它自动清掉）
 *     2. install 段内不再出现 cache.addAll(SHELL / cache.addAll(DATA
 *     3. 存在 CORE 极小核心列表且条目 ≤ 6
 *     4. fetch 事件里三条策略分支仍都在（navigate / json-png-svg / 其它）
 *   app.js
 *     5. loadData 的首屏链里不出现题库请求（源码级守卫）
 *     6. 题库加载失败时首屏仍可渲染的回退路径仍在（questions = null 分支 + buildGraph(…, null)）
 *
 * 注意：测试目录没有 DOM 基座、不引 jsdom（整个仓库的测试都是纯 node），
 * 所以第 5、6 条只能做源码级守卫 —— 跟 test_engine.js 里已有的源码级守卫同风格：
 * 用 brace 配对取出函数体文本再断言，不做运行期 DOM 断言。
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SW = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'diagnose', 'app.js'), 'utf8');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e).split('\n').slice(0, 8).join('\n       ')); }
}

/* 从 fromIndex 处 startToken 之后的花括号开始做配对，返回 {…} 内部的文本。
 * 只处理本仓库这两种源码形状，够用：字符串里出现括号不会干扰（先抹掉字符串字面量）。 */
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

/* 取某段（install / activate / fetch 的监听器）的源码 */
function section(src, kind) {
  const start = src.indexOf("addEventListener('" + kind + "'");
  assert.ok(start >= 0, 'sw.js 里找不到 ' + kind + ' 监听器');
  const rest = src.slice(start);
  const next = rest.indexOf('\nself.addEventListener(', 10);
  return next < 0 ? rest : rest.slice(0, next);
}

/* ---------------------------------------------------------------- sw.js */
test('sw.js：VERSION 已是 v6（旧 cnm-pwa-v5 缓存靠它清掉）', function () {
  assert.ok(/var VERSION = 'v6';/.test(SW), 'VERSION 应该是 v6');
  assert.strictEqual(SW.indexOf("VERSION = 'v5'"), -1, 'VERSION 不应再是 v5');
});

test('sw.js：install 段内不再出现 cache.addAll(SHELL / cache.addAll(DATA', function () {
  const inst = section(SW, 'install');
  assert.strictEqual(inst.indexOf('cache.addAll(SHELL'), -1, 'install 不许用 addAll(SHELL)（全或无会让慢链路废掉整个离线能力）');
  assert.strictEqual(inst.indexOf('cache.addAll(DATA'), -1, 'install 不许用 addAll(DATA)');
  assert.ok(/cache\.add\(/.test(inst), 'install 应逐项 cache.add');
});

test('sw.js：存在 CORE 极小核心列表且条目 ≤ 6', function () {
  const m = /var CORE = \[([\s\S]*?)\];/.exec(SW);
  assert.ok(m, 'sw.js 里应有 var CORE = [...]');
  const items = m[1].match(/'(?:[^'\\]|\\.)*'/g) || [];
  assert.ok(items.length >= 1, 'CORE 不应为空');
  assert.ok(items.length <= 6, 'CORE 条目必须 ≤ 6，实际 ' + items.length);
  assert.ok(items.indexOf("'./'") >= 0, 'CORE 应含首页 ./');
  assert.ok(items.indexOf("'assets/pwa.js'") >= 0, 'CORE 应含 assets/pwa.js');
  // 不要把大文件塞回安装路径
  assert.strictEqual(items.indexOf("'assets/vendor/cytoscape.min.js'"), -1, 'CORE 不应含 cytoscape（首屏不必等它）');
});

test('sw.js：install 只预缓存 CORE，SHELL 其余与 DATA 放到不阻塞的预热里', function () {
  const inst = section(SW, 'install');
  assert.ok(inst.indexOf('CORE') >= 0, 'install 必须只预缓存 CORE');
  assert.strictEqual(inst.indexOf('SHELL'), -1, 'install 里不应再出现 SHELL');
  // 预热：在 activate 里调用，但不在 waitUntil 里 await
  const act = section(SW, 'activate');
  assert.ok(/warm\(\)/.test(act), 'activate 之后应触发后台预热 warm()');
  assert.ok(!/await\s+warm\(/.test(act), '预热不能被 await');
  // warm() 必须在 waitUntil 的 Promise 结束之后调用（那之后就是激活已完成）
  const afterWait = act.slice(act.indexOf('}));'));
  assert.ok(afterWait.indexOf('warm()') >= 0, '预热不能塞进 waitUntil（会拖慢激活）');
  const warmBody = bodyAfter(SW, 'function warm()');
  assert.ok(warmBody.indexOf('SHELL') >= 0 && warmBody.indexOf('DATA') >= 0, '预热要补 SHELL 剩余项与 DATA');
  assert.ok(/\.catch\(/.test(warmBody), '预热每一项都要独立 catch，失败只丢该项');
});

test('sw.js：fetch 事件里三条策略分支仍都在', function () {
  const f = section(SW, 'fetch');
  // ① 导航：networkFirst + 5s 超时兜底
  assert.ok(/req\.mode === 'navigate'/.test(f), '缺 navigate 分支');
  assert.ok(/networkFirst\(req, true, abs\('\.\/'\)\)/.test(f), 'navigate 应走 networkFirst(…, true, 首页兜底)');
  assert.ok(/timeout\(5000\)/.test(SW), 'networkFirst 应有 5s 超时');
  // ② 数据与图标：staleWhileRevalidate
  assert.ok(/json\|png\|svg\|ico\|webmanifest/.test(f), '缺 json/png/svg/ico/webmanifest 分支');
  assert.ok(/staleWhileRevalidate\(req\)/.test(f), '数据与图标应走 staleWhileRevalidate');
  // ③ 其余：networkFirst
  assert.ok(/event\.respondWith\(networkFirst\(req, false, null\)\)/.test(f), '缺「其余资源 → networkFirst」分支');
});

/* ------------------------------------------------------------ app.js */
test('app.js：loadData 的首屏链里不出现题库（源码级守卫，无 DOM 基座）', function () {
  const body = bodyAfter(APP, 'async function loadData()');
  assert.strictEqual(body.indexOf('questions.json'), -1, 'loadData 里不许再出现 questions.json');
  assert.ok(!/await[^\n]*questions/.test(body), 'loadData 里不许 await 题库');
  assert.ok(/loadQuestions\(\);/.test(body), 'loadData 末尾应调用 loadQuestions()（不 await）');
  assert.ok(/E\.buildGraph\(topics, deps, null\)/.test(body), '首屏图应先用 buildGraph(topics, deps, null) 回退到 diagnostic_question');
});

test('app.js：题库后台到货后重建 D.graph，用户进了流程就不重绘', function () {
  const loadBody = bodyAfter(APP, 'async function loadData()');
  assert.ok(/loadQuestions\(\);/.test(loadBody), 'loadData 末尾应调用 loadQuestions()');
  assert.ok(!/await\s+loadQuestions\(/.test(loadBody), 'loadData 不许 await loadQuestions()');
  const body = bodyAfter(APP, 'async function loadQuestions()');
  assert.ok(/await fetch\('\.\.\/data\/questions\.json'\)/.test(body), 'loadQuestions 才去取题库');
  assert.ok(/D\.graph = E\.buildGraph\(D\.topics, D\.deps, questions\)/.test(body), '到货后要用 buildGraph 重建 D.graph');
  assert.ok(/if \(session \|\| prac \|\| pracLoading\) return;/.test(body), '已进入诊断/讲解/自评时不许重绘');
  assert.ok(/renderStart\(startErr\)/.test(body), '未进入流程时应静默重绘一次当前视图（并保住开始页错误提示）');
});

test('app.js：题库失败的回退路径仍在（questions = null + 首屏照常渲染）', function () {
  const body = bodyAfter(APP, 'async function loadQuestions()');
  assert.ok(/questions = null;/.test(body), '题库缺失/损坏时必须静默回落成 questions = null');
  assert.ok(/catch \(e\)/.test(body), '题库请求要有 catch，绝不把错误抛到首屏');
  assert.ok(APP.indexOf("diagnostic_question") >= 0, 'topics.json 的 diagnostic_question 回退路径应还在');
  // init 仍在 loadData 失败时报错，而不是静默空白
  assert.ok(/await loadData\(\)/.test(APP), 'init 仍然 await loadData()（阶段 1 失败要报错）');
});

console.log('\n' + (failed === 0 ? '全部通过' : '存在失败') + '：' + passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);
