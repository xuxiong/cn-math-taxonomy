#!/usr/bin/env node
/* 练习入口在浏览器脚本作用域里真的能开：node tests/test_practice_entry_scope.js
 *
 * 回归对象（kanban t_50c5ddb9，线上 2026-11-07 必现）：
 *   diagnose/app.js 有 `function variantsMod() { return Browser.DiagVariants; }`，但 CORE 导出
 *   对象里漏了这一项，diagnose/app-flow.js 顶部 `var X = CORE.X` 那串也漏了对应一行，
 *   而 startPractice 里两处裸用 `variantsMod()`。浏览器里三个文件共享同一个全局作用域，
 *   于是线上点「练习这 N 题」抛 ReferenceError: variantsMod is not defined —— 而且它是在
 *   withStage2Data 的 .then 里抛的，异常落进 promise rejection：不 alert、不重绘，
 *   用户看到的就是「按钮点了没反应」。
 *
 * 为什么既有测试全绿：唯一相关的断言是 `assert.ok(/variantsMod\(\)/.test(body))`，
 * 源码里有这串字符就算过 —— 它恰好在断言坏形态。本文件改成行为断言：
 *   按 index.html 的脚本顺序 + 按需段 app-flow.js 真加载（tests/lib/diagnose-browser.js），
 *   再调用按钮背后那个入口函数，断言不抛错、练习态真被触发（pracLoading 置位、
 *   Lazy.load(LAZY_VARIANTS) 发出、root 渲染出练习加载面板）。
 * 删掉 CORE 里那一行导出时，本文件必须重新变红。
 */
'use strict';

const path = require('path');
const { loadDiagnose } = require('./lib/diagnose-browser.js');

const ROOT = path.join(__dirname, '..');
/* 与线上复现同一个知识点（卡面给的是 diagnose/?target=cnm_p006）。 */
const TID = 'cnm_p006';

let passed = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { passed++; return true; }
  failures.push(msg);
  return false;
}

function short(e) {
  if (!e) return String(e);
  const head = (e.name || 'Error') + ': ' + (e.message || String(e));
  const at = (e.stack || '').split('\n').slice(1, 4).map(function (s) { return s.trim(); }).join(' <- ');
  return at ? head + '  @ ' + at : head;
}

async function main() {
  console.log('== 练习入口（浏览器脚本作用域） ==');
  const env = loadDiagnose(ROOT);
  const ctx = env.ctx;
  console.log('浏览器方式加载：' + env.loaded.join(' → '));

  /* 基线：两个脚本都真跑起来了（它们没跑起来，后面所有断言都会因为「入口不存在」而失去意义）。 */
  if (!ok(ctx.DiagCore && typeof ctx.DiagCore === 'object', 'window.DiagCore 未定义：app.js 没按浏览器方式执行成功')) return;
  if (!ok(ctx.DiagFlow && typeof ctx.DiagFlow.startPractice === 'function',
    'window.DiagFlow.startPractice 不可调用：app-flow.js 没有经 registerFlow 注册进 CORE（练习入口整条链断在第一环）')) return;

  /* 断言 1：练习入口要用的模块取用口必须由 CORE 导出。
   * app-flow.js 里的 `variantsMod()` 是裸标识符，它只能来自顶部 `var variantsMod = CORE.variantsMod`；
   * CORE 漏这一项时，浏览器作用域里就没有这个名字 —— 这就是线上 ReferenceError 的根。 */
  ok(typeof ctx.DiagCore.variantsMod === 'function',
    'CORE 未导出 variantsMod（typeof=' + typeof ctx.DiagCore.variantsMod + '）：app-flow.js 里裸用的 ' +
    'variantsMod 在浏览器脚本作用域解析不到，练习入口必抛 ReferenceError: variantsMod is not defined');

  /* 最小图：一个非外部知识点 + 它的题库有一道题。
   * 题库为空会走「先取题库」的分支（pracLoading.bank=true），那是另一条路径，本测试要测的是
   * 「变式模块按需加载」这条 —— 线上点「练习这 N 题」时题库已到货，走的正是这条。 */
  const S = ctx.DiagState;
  if (!ok(S && typeof S === 'object', 'window.DiagState 未定义：app.js 的状态单例没暴露出来')) return;
  const byId = Object.create(null);
  byId[TID] = { id: TID, name: '测试知识点', external: false };
  const bank = Object.create(null);
  bank[TID] = [{ id: TID + '_q1', type: 'numeric', prompt: '1+1=?', answer: '2' }];
  S.D = { graph: { byId: byId, bank: bank } };
  S.pracLoading = null;
  S.prac = null;

  /* 断言 2：真的走到练习入口且不抛错。
   * 生产链路是 `button onclick → withStage2Data(fn) → ensureStage2Data().then(fn)`，
   * 也就是入口函数一定在 promise 的 .then 里被调用（线上异常因此落进 unhandledrejection）。
   * 这里保持同一形状：把入口放进 .then 里跑，同步抛与异步抛都算下来。 */
  let thrown = null;
  await Promise.resolve().then(function () { ctx.DiagFlow.startPractice(TID); })
    .catch(function (e) { thrown = e; });
  ok(thrown === null, '练习入口抛错（线上表现为「点了没反应」）：' + short(thrown));

  /* 断言 3：练习态被真正触发。pracLoading 置位 + 走的是变式模块分支（不是「先取题库」分支）。 */
  ok(S.pracLoading && S.pracLoading.topicId === TID,
    'S.pracLoading 没有被置成 {' + TID + '}（实际 ' + JSON.stringify(S.pracLoading) + '）：练习态没进');
  ok(!(S.pracLoading && S.pracLoading.bank === true),
    'S.pracLoading.bank=true：走进了「先取题库」分支，没测到变式模块按需加载');

  /* 断言 4：确实按 LAZY_VARIANTS 去取模块了（顺序与内容都由 app.js 的清单决定）。 */
  const calls = env.lazyCalls.map(function (c) { return c.join(','); });
  ok(env.lazyCalls.some(function (c) { return c.indexOf('variants.js') >= 0; }),
    '没有发出 Lazy.load(LAZY_VARIANTS)：实际 Lazy.load 调用 = ' + JSON.stringify(calls) +
    '（变式模块永远不到货，练习面板就永远出不来）');

  /* 断言 5：练习加载面板真渲染到了 root 上（render() → renderPracticeLoading()）。
   * 这条把「函数被调用」升级成「界面上真发生了变化」—— 线上正是这一步什么都没发生。 */
  const txt = env.textOf(env.root);
  ok(env.root.childNodes.length > 0 && txt.indexOf('正在准备题目') >= 0,
    'root 上没有渲染出练习加载面板（root 文本 = ' + JSON.stringify(txt.slice(0, 160)) + '）');

  /* 断言 6：不许靠 alert 兜底（那条分支对用户是「弹窗骂一句」，不是练习入口正常工作）。 */
  ok(env.alerts.length === 0, '练习入口不该弹 alert（实际：' + JSON.stringify(env.alerts) + '）');
}

main().then(function () {
  if (failures.length) {
    console.error('\n失败 ' + failures.length + ' 项（通过 ' + passed + ' 项）：');
    failures.forEach(function (f, i) { console.error('  ' + (i + 1) + ') ' + f); });
    process.exitCode = 1;
  } else {
    console.log('\n全部通过：' + passed + ' 项断言');
    process.exitCode = 0;
  }
}, function (e) {
  console.error('测试自身异常（不是断言失败）：' + short(e));
  process.exitCode = 1;
});
