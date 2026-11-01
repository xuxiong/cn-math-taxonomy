#!/usr/bin/env node
/* 点击后 300ms 内必须有反馈 + 裸 null 文本消除 + 门内依赖瘦身 守卫：node tests/test_flow_feedback.js
 *
 * 背景（卡 t_80db9722 / t_588d8341）：
 *   - 点击「开始整体诊断」后 20 秒页面一个字不变：goFlow() 先 ensureFlowEngine() 再有任何 UI 反馈，
 *     弱网下引擎串行注入要好几秒，期间状态行/等待卡一个都没画。
 *   - 首屏 renderStart() 把 childBar('start') 的返回值交给原生 Element.append —— childBar 在
 *     children.js 未到货 / demo 模式下返回 null，原生 append(null) 会把 null 字符串化插成文本节点，
 *     innerText 里出现裸 "null"。
 *   - 门内先修关系串行等全量 dependencies.json(115KB gzip)，逐学科份只要 38KB，且与题库并行才不挡第一题。
 *
 * 本文件做源码级守卫（与 test_pwa_load.js / test_data_split.js 同风格：花括号配对取函数体再断言），
 * 不跑运行期 DOM —— 仓库测试无 DOM 基座、不引 jsdom。
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'diagnose', 'app.js'), 'utf8');
const FLOW_SRC = fs.readFileSync(path.join(ROOT, 'diagnose', 'app-flow.js'), 'utf8');
const APP = APP_SRC + '\n' + FLOW_SRC;

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e).split('\n').slice(0, 8).join('\n       ')); }
}

/* 花括号配对取函数体（先抹掉字符串字面量里的括号），与 test_pwa_load.js / test_data_split.js 同法。 */
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

/* ------------------------------------------------------------ 1. 裸 null 消除 */
test('app.js / app-flow.js：不许出现 .append(childBar|blindStartCard|routeBackBar)( 裸调用（null 会被字符串化成文本节点）', function () {
  /* 原生 Element.append(null) 把 null 插成 "null" 文本节点；守卫助手 append(el, c) 有 if (c == null) return。
   * 凡是可能返回 null 的 childBar / blindStartCard / routeBackBar 都必须走守卫 append(el, ...)。 */
  const bad = APP.match(/\.append\(\s*(childBar|blindStartCard|routeBackBar)\s*\(/g);
  assert.deepStrictEqual(bad || [], [], '还有裸 .append(childBar|blindStartCard|routeBackBar)( 调用：' + (bad || []).join(' | '));
});

test('app.js：renderStart 里 childBar(\'start\') 必须走守卫 append(page, childBar(\'start\'))', function () {
  const body = bodyAfter(APP_SRC, 'function renderStart(');
  assert.ok(body.indexOf('append(page, childBar(\'start\'))') >= 0,
    'renderStart 里必须是 append(page, childBar(\'start\')) —— 原生 page.append 会把 null 字符串化');
  assert.strictEqual(body.indexOf('page.append(childBar'), -1,
    'renderStart 里不许再出现 page.append(childBar…) 裸调用');
});

test('app.js：withRouteBack 里 routeBackBar 必须走守卫 append(wrap, routeBackBar(), page)', function () {
  const body = bodyAfter(APP_SRC, 'function withRouteBack(');
  assert.ok(body.indexOf('append(wrap, routeBackBar(), page)') >= 0,
    'withRouteBack 里必须是 append(wrap, routeBackBar(), page) —— 原生 wrap.append(routeBackBar(), page) 同样会把 null 字符串化');
});

test('app-flow.js：出题页 / 结果页 childBar 必须走守卫 append', function () {
  const render = bodyAfter(FLOW_SRC, 'function renderQuestion(');
  assert.ok(render.indexOf('append(page, childBar(\'question\'))') >= 0,
    '出题页（renderQuestion）必须是 append(page, childBar(\'question\'))');
  assert.strictEqual(render.indexOf('page.append(childBar'), -1,
    '出题页不许再出现 page.append(childBar…) 裸调用');
  const result = bodyAfter(FLOW_SRC, 'function renderResult(');
  assert.ok(result.indexOf('append(page, childBar(\'result\'))') >= 0,
    '结果页必须是 append(page, childBar(\'result\'))');
});

/* ------------------------------------------------------------ 2. null 守卫仍在 */
test('app.js：append() 与 h() 的 null 守卫仍在（if (c == null || c === false) return / if (v == null || v === false) return）', function () {
  const appendBody = bodyAfter(APP_SRC, 'function append(el, c)');
  assert.ok(/if \(c == null \|\| c === false\) return;/.test(appendBody),
    'append() 必须保留 if (c == null || c === false) return; 守卫 —— 这是消裸 null 的根本');
  const hBody = bodyAfter(APP_SRC, 'function h(tag, attrs)');
  assert.ok(/if \(v == null \|\| v === false\) return;/.test(hBody),
    'h() 必须保留 if (v == null || v === false) return; 守卫 —— attr 跳过 null/false');
});

/* ------------------------------------------------------------ 3. 点击即反馈（同步先画，不等网络） */
test('app.js：goFlow() 里 showFlowStartFeedback( 必须在 ensureFlowEngine( 之前（同步先画等待卡，不等引擎）', function () {
  const body = bodyAfter(APP_SRC, 'function goFlow(');
  const fbAt = body.indexOf('showFlowStartFeedback(');
  const engAt = body.indexOf('ensureFlowEngine(');
  assert.ok(fbAt >= 0, 'goFlow() 里缺 showFlowStartFeedback( 调用');
  assert.ok(engAt >= 0, 'goFlow() 里缺 ensureFlowEngine( 调用');
  assert.ok(fbAt < engAt,
    'showFlowStartFeedback( 必须在 ensureFlowEngine( 之前 —— 弱网下引擎 5~10s 才到，等它就是「点了没反应」');
});

test('app.js：showFlowStartFeedback 定义里先 renderQuestionsPendingWith( 再 gateProgressStart(', function () {
  const body = bodyAfter(APP_SRC, 'function showFlowStartFeedback(');
  const pendAt = body.indexOf('renderQuestionsPendingWith(');
  const gpAt = body.indexOf('gateProgressStart(');
  assert.ok(pendAt >= 0, 'showFlowStartFeedback 里缺 renderQuestionsPendingWith( —— 要先把列表区换成等待卡');
  assert.ok(gpAt >= 0, 'showFlowStartFeedback 里缺 gateProgressStart( —— 要同步把「0/N 章」画到状态行');
  assert.ok(pendAt < gpAt,
    '必须先 renderQuestionsPendingWith 画出状态行，gateProgressStart 才有地方写「0/N 章」');
  assert.ok(/flowProgressStart\(\)/.test(body), 'showFlowStartFeedback 里应启动 500ms 心跳（flowProgressStart）');
});

/* ------------------------------------------------------------ 4. 门内三件事并行发起 */
test('app.js：ensureFlowReady() 里 ensureQuestions() / ensureFullTopics() 必须在 await ensureDeps() 之前（并行发起，不再串行）', function () {
  const body = bodyAfter(APP_SRC, 'async function ensureFlowReady(');
  /* 用带分号的代码模式匹配，避免命中注释里的字面量（注释里可能提到这些函数名） */
  const fullDeclAt = body.indexOf('const full =');
  const fullAt = body.indexOf('ensureFullTopics();');
  const bankAt = body.indexOf('ensureQuestions();');
  const depsAt = body.indexOf('await ensureDeps();');
  assert.ok(fullDeclAt >= 0, 'ensureFlowReady 里缺 const full = … 声明（race/all 都靠 full 这个变量）');
  assert.ok(fullAt >= 0, 'ensureFlowReady 里缺 ensureFullTopics(); 代码调用（非 screen 分支仍要发起）');
  assert.ok(bankAt >= 0, 'ensureFlowReady 里缺 ensureQuestions(); 代码调用');
  assert.ok(depsAt >= 0, 'ensureFlowReady 里缺 await ensureDeps();（tests/test_data_split.js 守这一行）');
  assert.ok(fullDeclAt < depsAt,
    'const full = 必须在 await ensureDeps() 之前 —— 旧顺序 deps 串行挡住全量 topics 下载');
  assert.ok(fullAt < depsAt,
    'ensureFullTopics() 必须在 await ensureDeps() 之前发起 —— 非 screen 分支并行意图（Round 2 后 screen 分支立即 resolve，不抢带宽）');
  assert.ok(bankAt < depsAt,
    'ensureQuestions() 必须在 await ensureDeps() 之前发起 —— 旧顺序 deps 串行挡住题库 bundle 下载');
  /* Round 2 第 2 条：screen 门内不发起 ensureFullTopics（345KB 留到门后 openGate），
   * full 只是变成 screen 下立即 resolve 的 promise；非 screen 行为不变。 */
  assert.ok(/mode === 'screen' \? Promise\.resolve\(true\) : ensureFullTopics\(\)/.test(body),
    'ensureFlowReady 必须按 mode 分流：screen → Promise.resolve(true)（门内不抢带宽），非 screen → ensureFullTopics()');
  /* 旧守卫仍要求 race / all / gateLoaded / flowAskable 都在 */
  assert.ok(/Promise\.race\(\[full, bank\]\)/.test(body), '仍须保留 Promise.race([full, bank])');
  assert.ok(/Promise\.all\(\[full, bank\]\)/.test(body), '仍须保留 Promise.all([full, bank])');
  assert.ok(/gateKeys\.every\(/.test(body), 'gateLoaded 仍须逐 key 判据（gateKeys.every）');
  assert.ok(/flowAskable\(targets, limit, mode\) && (?:S\.)?questionsInFlight === 0\) return true;/.test(body),
    '开门判据仍须是 flowAskable(...) && questionsInFlight === 0）return true');
});

/* ------------------------------------------------------------ 5. 逐学科先修 + 整份回退 */
test('app.js：ensureDeps() 先取逐学科份 ../data/dependencies/<subject>.json，且保留 ../data/dependencies.json 回退', function () {
  const body = bodyAfter(APP_SRC, 'function ensureDeps(');
  assert.ok(body.indexOf("'../data/dependencies/' + S.subject + '.json'") >= 0,
    'ensureDeps 必须先取逐学科份 ../data/dependencies/<subject>.json（math gzip 38KB，全量 115KB 的 1/3）');
  assert.ok(body.indexOf("'../data/dependencies.json'") >= 0,
    'ensureDeps 必须保留 ../data/dependencies.json 回退（逐学科份缺失时）');
  /* 回退后仍按 allow 过滤（语义与回退前一致） */
  assert.ok(/allow\[d\.topicId\] && allow\[d\.prerequisiteId\]/.test(body),
    '回退后仍须按 allow 过滤（只保留本学科 topics 之间的边）');
  /* 失败标志：进度文案要靠它停说「先修关系还在下」 */
  assert.ok(/S\.depsFailed\s*=\s*true/.test(body),
    'ensureDeps 失败时须设 S.depsFailed = true（进度文案 flowStatusText 读它，别的逻辑不读）');
});

/* ------------------------------------------------------------ 6. 心跳间隔 500ms */
test('app.js：flowProgressStart 的心跳间隔必须是 500（不许 > 1000，否则撞上「连续 2 秒无变化」验收线）', function () {
  const body = bodyAfter(APP_SRC, 'function flowProgressStart(');
  const m = /setInterval\(\s*flowProgressPaint\s*,\s*(\d+)\s*\)/.exec(body);
  assert.ok(m, 'flowProgressStart 里缺 setInterval(flowProgressPaint, N) —— 心跳保证状态行每 N ms 一定变一次');
  const ms = parseInt(m[1], 10);
  assert.ok(ms === 500, '心跳间隔必须是 500ms，实际 ' + ms + '（> 1000 会撞上「连续 2 秒无变化」验收线）');
  /* stop 必须能清掉 ticker，否则门开了状态行还在跳 */
  const stop = bodyAfter(APP_SRC, 'function flowProgressStop(');
  assert.ok(/clearInterval\(/.test(stop), 'flowProgressStop 必须 clearInterval(flowTicker)');
});

/* ------------------------------------------------------------ 7. stage2Status 写任一状态行 */
test('app.js：stage2Status 必须能写 #stage2-status 或 #questions-pending-status（点击后等待卡里的状态行）', function () {
  const body = bodyAfter(APP_SRC, 'function stage2Status(');
  assert.ok(/getElementById\('stage2-status'\)/.test(body), 'stage2Status 仍要找 #stage2-status');
  assert.ok(/getElementById\('questions-pending-status'\)/.test(body),
    'stage2Status 还要找 #questions-pending-status —— 点击后 showFlowStartFeedback 画的是等待卡，状态行在这个 id 上');
});

/* ------------------------------------------------------------ 8. Round 2：状态行只能说当前真正在等什么
 * Round 2 第 3 条实测：0→20s 状态行写「先修关系还在下 · 知识点说明还在下（345KB 级）」，
 * 但这 20s 里实际在下的只有出题引擎（ensureFlowEngine 还没 resolve，deps/fullTopics 都没发起）。
 * 必须用真实状态位驱动文案，且秒数对 flowStartAt=0 做防御（第 1 条首帧「已等 1793554006s」）。 */
test('app.js：flowStatusText 必须读 flowEngineReady / fullTopicsInFlight，不许无条件写「知识点说明还在下」', function () {
  const body = bodyAfter(APP_SRC, 'function flowStatusText(');
  /* 引擎未到才说「出题引擎还在下」；先修关系只在引擎到货后才可能出现（deps 在 ensureFlowReady 里、引擎之后发起） */
  assert.ok(/if \(!flowEngineReady\)\s*parts\.push\('出题引擎还在下'\)/.test(body),
    'flowStatusText 必须用 if (!flowEngineReady) 判「出题引擎还在下」—— 引擎没到时不能说先修/知识点在飞');
  assert.ok(/if \(flowEngineReady && !S\.depsLoaded && !S\.depsFailed\)\s*parts\.push\('先修关系还在下'\)/.test(body),
    'flowStatusText 必须用 if (flowEngineReady && !S.depsLoaded && !S.depsFailed) 判「先修关系还在下」—— 引擎没到时 deps 根本没发起');
  /* 只在 fullTopicsInFlight 真在飞时说「知识点说明还在下」，不许再用 !fullTopicsLoaded && !fullTopicsFailed（没发起也命中） */
  assert.ok(/if \(fullTopicsInFlight\)\s*parts\.push\('知识点说明还在下'\)/.test(body),
    'flowStatusText 必须用 if (fullTopicsInFlight) 判「知识点说明还在下」—— 只在真在飞时才说');
  assert.strictEqual(body.indexOf('知识点说明还在下（345KB 级）'), -1,
    'flowStatusText 不许再带「（345KB 级）」后缀 —— Round 2 改成无后缀');
  assert.strictEqual(body.indexOf('!S.fullTopicsLoaded && !S.fullTopicsFailed'), -1,
    'flowStatusText 不许再用 !S.fullTopicsLoaded && !S.fullTopicsFailed 判「知识点说明还在下」—— 这个条件在「没发起过」时也为 true，正是 Round 2 要修的误报');
  /* 秒数防御（第 1 条）：flowStartAt=0 时不能算成当前纪元秒 */
  assert.ok(/flowStartAt \? Math\.round\(\(Date\.now\(\) - flowStartAt\) \/ 1000\) : 0/.test(body),
    'flowStatusText 秒数必须有 flowStartAt ? ... : 0 防御 —— 否则 flowStartAt=0 时算成当前纪元秒（首帧「已等 1793554006s」）');
});

test('app.js：ensureFlowEngine 的 .then 必须置 flowEngineReady = true（状态行靠它停说「出题引擎还在下」）', function () {
  const body = bodyAfter(APP_SRC, 'function ensureFlowEngine(');
  assert.ok(/flowEngineReady\s*=\s*true/.test(body),
    'ensureFlowEngine 的 .then 里必须置 flowEngineReady = true —— flowStatusText 靠它判断引擎是否到货');
  /* Round 2 第 4 条：engine.js / app-flow.js 并行注入（两个文件无顶层依赖，可并发） */
  assert.ok(/Promise\.all\(\[Lazy\.load\('engine\.js'\),\s*Lazy\.load\('app-flow\.js'\)\]\)/.test(body),
    `ensureFlowEngine 必须用 Promise.all([Lazy.load('engine.js'), Lazy.load('app-flow.js')]) 并行注入 —— 两个文件无顶层依赖，可并发`);
  assert.strictEqual(body.indexOf("Lazy.load(['engine.js', 'app-flow.js'])"), -1,
    `ensureFlowEngine 不许再用 Lazy.load(['engine.js', 'app-flow.js']) 串行写法 —— Round 2 第 4 条改成并行`);
});

test('app.js：ensureFullTopics 必须维护 fullTopicsInFlight（发起时 true，完成含失败/早退 false）', function () {
  const body = bodyAfter(APP_SRC, 'function ensureFullTopics(');
  /* 真正发起 fetch 才置 true；早退路径（已 loaded / 已有 promise）在 if 守卫之前，不进 async 函数体 */
  const trueAt = body.indexOf('fullTopicsInFlight = true');
  const falseAt = body.indexOf('fullTopicsInFlight = false');
  assert.ok(trueAt >= 0, 'ensureFullTopics 里缺 fullTopicsInFlight = true（发起 fetch 时置位）');
  assert.ok(falseAt >= 0, 'ensureFullTopics 里缺 fullTopicsInFlight = false（完成时复位）');
  assert.ok(trueAt < falseAt, 'fullTopicsInFlight = true 必须在 = false 之前');
  /* 用 finally 复位：成功 / 失败 / 早退（!r.ok / !Array.isArray）任一路径都要回到 false，
   * 否则 flowStatusText 会一直说「知识点说明还在下」。 */
  assert.ok(/finally\s*\{[\s\S]*fullTopicsInFlight\s*=\s*false/.test(body),
    'ensureFullTopics 必须用 finally 复位 fullTopicsInFlight —— 早退路径（!r.ok / !Array.isArray）也要置 false');
});

console.log('\n' + (failed === 0 ? '全部通过' : '存在失败') + '：' + passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);
