#!/usr/bin/env node
/* 追问画板「身份校验 + 渲染隔离 + 未配图陈述」源码级守卫：node tests/test_ask_graph_isolation.js
 *
 * 背景（卡 chatlab identity）：
 *   - 追问的图必须和题面是同一个函数：verifyChatGraph 要带上本题画板配置（baseline），
 *     否则模型说画 cos、题面是 sin，画板却照样挂上去，文案和图形脱节。
 *   - 模型的文字只能进「老师：」气泡，绝不能混进 .ask-graph 卡片（学生看到的图必须只是图）。
 *   - 模型给了 graph:null 或被校验拒时，要有一句确定性的「本次回答没有配图」，
 *     这句文案只能来自 ChatGraph.absentNotice，公式只能来自 Funclab。
 *
 * 仓库测试无 DOM 基座、不引 jsdom：本文件照 test_flow_feedback.js 的写法，
 * 读源码 + 花括号配对取函数体做源码级断言。
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FLOW_SRC = fs.readFileSync(path.join(ROOT, 'diagnose', 'app-flow.js'), 'utf8');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e).split('\n').slice(0, 8).join('\n       ')); }
}

/* 花括号配对取函数体（先抹掉字符串字面量里的括号），与 test_flow_feedback.js 同法。 */
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

/* 花括号配对取「包住 token 的块」的块体：回退到 token 之前最近的一个 '{'
 * （即真正包住这条语句的块开括号），再从那里向前配对。
 * 为什么不沿用 bodyAfter：bodyAfter 从 token 往后找第一个 '{'，当 token 这条语句
 * 本身就带对象字面量（如 h('div', { class: 'ask-graph' })）时，锚到的会是下一条
 * 语句的对象字面量，取回的「块体」只是 " class: 'ask-graph-formula' " 这种空壳。
 * bodyAfter 的语义被其它 5 个测试文件原样复制，不能改，所以单加这个小助手。 */
function bodyAround(src, token) {
  const at = src.indexOf(token);
  assert.ok(at >= 0, '源码里找不到：' + token);
  /* 回退扫描只看 token 之前的前缀；抹串后与原文等长，下标对齐。 */
  const maskedPrefix = src.slice(0, at)
    .replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, function (s) { return s.replace(/[{}]/g, '_'); });
  const open = maskedPrefix.lastIndexOf('{');
  assert.ok(open >= 0, 'token 前面找不到包住它的块开括号：' + token);
  /* 向前配对与 bodyAfter 同法：从 open 起抹掉字符串字面量里的花括号再数深度。 */
  const masked = src.slice(0, open) + src.slice(open)
    .replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, function (s) { return s.replace(/[{}]/g, '_'); });
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    const c = masked[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(open + 1, i); }
  }
  throw new Error('花括号不配对：' + token);
}

/* 取某段源码所在的整行（用于「调用点同一语句里不许出现其它来源」）。 */
function lineAt(src, idx) {
  const from = src.lastIndexOf('\n', idx) + 1;
  const to = src.indexOf('\n', idx);
  return src.slice(from, to < 0 ? src.length : to);
}

/* ------------------------------------------------------------ 1. baseline 透传 */
test('app-flow.js：verifyChatGraph 必须带 baseline（res.graph, S.ui.labCfg），且不许留旧单参调用', function () {
  assert.ok(FLOW_SRC.indexOf('verifyChatGraph(res.graph, S.ui.labCfg)') >= 0,
    'runAsk 里必须调 verifyChatGraph(res.graph, S.ui.labCfg) —— 不带 baseline 就无法证明这张图和题面是同一个函数');
  assert.strictEqual(FLOW_SRC.indexOf('verifyChatGraph(res.graph)'), -1,
    '不许再出现 verifyChatGraph(res.graph) 旧单参调用 —— 身份校验必须 fail-closed');
});

/* ------------------------------------------------------------ 2. 未配图陈述只来自 ChatGraph */
test('app-flow.js：未配图陈述来自 ChatGraph.absentNotice，且调用点不手写公式', function () {
  const at = FLOW_SRC.indexOf('ChatGraph.absentNotice(');
  assert.ok(at >= 0, '缺 ChatGraph.absentNotice( 调用 —— 未配图陈述必须由 chatgraph 给出确定性文案');
  const line = lineAt(FLOW_SRC, at);
  assert.strictEqual(line.indexOf('formatFormula('), -1,
    'absentNotice 调用点同一行不许出现 formatFormula( —— 公式只能由 ChatGraph 内部取自 Funclab');
  assert.strictEqual(line.indexOf("'y ="), -1,
    "absentNotice 调用点同一行不许出现 'y = —— app-flow 里不许手写任何公式");
});

/* ------------------------------------------------------------ 3. 未配图陈述的挂载点 */
test('app-flow.js：存在 ask-graph-notice 渲染节点', function () {
  assert.ok(FLOW_SRC.indexOf('ask-graph-notice') >= 0,
    '缺 ask-graph-notice —— 模型没配图时要有确定性的系统陈述，不能静默留白');
});

/* ------------------------------------------------------------ 4. .ask-graph 卡片隔离 */
test('app-flow.js：真实 .ask-graph 卡片块体只放公式行 + 画板，不许混入模型文字', function () {
  /* 旧写法 bodyAfter(FLOW_SRC, "const box2 = h('div', { class: 'ask-graph' })") 是空转门禁：
   * 它从 token 往后找第一个 '{'，落点其实是下一条语句 box2.append(h('div', { class:
   * 'ask-graph-formula' }, ...)) 的对象字面量，body 只剩 " class: 'ask-graph-formula' "，
   * 三条否定断言不管 .ask-graph 卡片里实际塞了什么都过。改用 bodyAround 回退锚到真正
   * 包住 box2 的块（if (inst && inst.el) { ... }）取真实块体，并补正向断言钉死锚点：
   * 块体里必须有公式行和画板节点 —— 锚错块或取回空体时立刻 FAIL，不再可能静默通过。 */
  const body = bodyAround(FLOW_SRC, "const box2 = h('div', { class: 'ask-graph' })");
  console.log('[锚点验证] ' + JSON.stringify(body.slice(0, 120)));   // TODO 临时验证锚点，验证后删除
  assert.ok(body.indexOf('ask-graph-formula') >= 0,
    '.ask-graph 块体里必须有 ask-graph-formula 公式行 —— 缺了说明锚错了块，断言在空转');
  assert.ok(body.indexOf('Funclab.formatFormula') >= 0,
    '.ask-graph 块体里必须有 Funclab.formatFormula —— 公式文案只能由 Funclab 生成');
  assert.ok(body.indexOf('inst.el') >= 0,
    '.ask-graph 块体里必须有 inst.el —— 卡片里挂的必须是画板实例，不是模型文字');
  assert.strictEqual(body.indexOf('entry.a'), -1,
    '.ask-graph 里不许出现 entry.a —— 模型文字只能进「老师：」气泡');
  assert.strictEqual(body.indexOf("'老师：'"), -1,
    ".ask-graph 里不许出现 '老师：' —— 图卡内部只能是图，不能是聊天文案");
  assert.strictEqual(body.indexOf('res.text'), -1,
    '.ask-graph 里不许出现 res.text —— 模型原文不许进图卡');
});

/* ------------------------------------------------------------ 5. 模型文字只出现一次 */
test('app-flow.js：\'老师：\' + entry.a 全文只出现 1 次（唯一入口是老师气泡）', function () {
  const m = FLOW_SRC.match(/'老师：' \+ entry\.a/g) || [];
  assert.strictEqual(m.length, 1,
    "「'老师：' + entry.a」应只出现 1 次，实际 " + m.length + ' 次 —— 多出来的地方就是把模型文字混进别处');
});

/* ------------------------------------------------------------ 6. 历史作为第 7 参透传 */
test('app-flow.js：window.Explain.ask 调用点带第 7 参（最近两轮历史）', function () {
  assert.ok(FLOW_SRC.indexOf('window.Explain.ask(t, q, S.ui.answer, steps, text, S.ui.labDesc, ') >= 0,
    'window.Explain.ask(...) 必须追加第 7 参 —— 否则模型拿不到最近两轮上下文，追问会反复从零解释');
});

/* ------------------------------------------------------------ 7. 历史只取最后 2 轮 */
test('app-flow.js：askHistoryForPrompt 存在，且用 slice(-2) 限最近两轮', function () {
  const body = bodyAfter(FLOW_SRC, 'function askHistoryForPrompt(');
  assert.ok(body.indexOf('slice(-2)') >= 0,
    'askHistoryForPrompt 必须 slice(-2) —— 只取最近 2 轮，避免 prompt 无限膨胀');
  assert.ok(/e\.pending/.test(body),
    'askHistoryForPrompt 必须跳过 pending 轮次 —— 半截问答不是「问过且答过」');
  assert.ok(/typeof e\.q === 'string'/.test(body) && /typeof e\.a === 'string'/.test(body),
    'askHistoryForPrompt 必须校验 q / a 是字符串 —— 空轮次不能进 prompt');
});

console.log('\n' + (failed === 0 ? '全部通过' : '存在失败') + '：' + passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);
