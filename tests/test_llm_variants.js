#!/usr/bin/env node
/* O3 LLM 变式出题管线测试：node tests/test_llm_variants.js （无依赖，仅用 assert）
 * 风格同 test_engine.js —— 全部 mock 网关，不依赖 127.0.0.1:3000 在线。
 * 验证函数是纯函数（同步），可直接单测；LLM 调用用 mock fetch。
 */
'use strict';
const assert = require('assert');
const path = require('path');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e).split('\n').slice(0, 4).join('\n       ')); }
}
const asyncTests = [];
function testAsync(name, fn) { asyncTests.push({ name: name, fn: fn }); }

/* ---- 加载被测模块（UMD，Node 中 require 即可） ---- */
const LLMV = require('../diagnose/llm-variants.js');

/* ================================================================
 * 1. 验证门 fixture：正确 / 错误 / 多解 / ± / 根式 2±√5 数值比较
 * ================================================================ */

console.log('\n--- 验证门：verifyEquationRoots ---');

test('verifyEquationRoots：正确方程 x²+6x-7=0, 答案 1，-7 -> ok:true', () => {
  const r = LLMV.verifyEquationRoots('用配方法解方程 x²+6x-7=0', '1，-7');
  assert.strictEqual(r.ok, true, JSON.stringify(r));
});

test('verifyEquationRoots：错误答案 x²+6x-7=0, 答案 2，-7 -> ok:false', () => {
  const r = LLMV.verifyEquationRoots('用配方法解方程 x²+6x-7=0', '2，-7');
  assert.strictEqual(r.ok, false, JSON.stringify(r));
});

test('verifyEquationRoots：根式答案 x²-4x-1=0, 答案 2±√5 -> ok:true', () => {
  const r = LLMV.verifyEquationRoots('用配方法解方程 x²-4x-1=0', '2±√5');
  assert.strictEqual(r.ok, true, JSON.stringify(r));
});

test('verifyEquationRoots：部分错 x²+6x-7=0, 答案 1，-8 -> ok:false', () => {
  const r = LLMV.verifyEquationRoots('用配方法解方程 x²+6x-7=0', '1，-8');
  assert.strictEqual(r.ok, false, JSON.stringify(r));
});

test('verifyEquationRoots：单根正确 x²-4=0, 答案 2 -> ok:true', () => {
  const r = LLMV.verifyEquationRoots('解方程 x²-4=0', '2');
  assert.strictEqual(r.ok, true, JSON.stringify(r));
});

test('verifyEquationRoots：单根错误 x²-4=0, 答案 3 -> ok:false', () => {
  const r = LLMV.verifyEquationRoots('解方程 x²-4=0', '3');
  assert.strictEqual(r.ok, false, JSON.stringify(r));
});

test('verifyEquationRoots：负根 x²+4x+3=0, 答案 -1，-3 -> ok:true', () => {
  const r = LLMV.verifyEquationRoots('解方程 x²+4x+3=0', '-1，-3');
  assert.strictEqual(r.ok, true, JSON.stringify(r));
});

test('verifyEquationRoots：根式负数 x²+4x+1=0, 答案 -2±√3 -> ok:true', () => {
  // -2+√3 ≈ -0.268, -2-√3 ≈ -3.732
  // 代入 x²+4x+1: (-0.268)² + 4(-0.268) + 1 ≈ 0
  const r = LLMV.verifyEquationRoots('解方程 x²+4x+1=0', '-2±√3');
  assert.strictEqual(r.ok, true, JSON.stringify(r));
});

/* ================================================================
 * 2. 验证门：verifyCompletingSquare（q2 型配方加常数）
 * ================================================================ */

console.log('\n--- 验证门：verifyCompletingSquare ---');

test('verifyCompletingSquare：正确 x²+6x, 常数 9 -> ok:true', () => {
  const r = LLMV.verifyCompletingSquare('要把 x²+6x 配成完全平方式，需要加上的常数是多少？', '9');
  assert.strictEqual(r.ok, true, JSON.stringify(r));
});

test('verifyCompletingSquare：错误 x²+6x, 常数 8 -> ok:false', () => {
  const r = LLMV.verifyCompletingSquare('要把 x²+6x 配成完全平方式，需要加上的常数是多少？', '8');
  assert.strictEqual(r.ok, false, JSON.stringify(r));
});

test('verifyCompletingSquare：正确 x²+8x, 常数 16 -> ok:true', () => {
  const r = LLMV.verifyCompletingSquare('把 x²+8x 配方，需要加上的常数是多少？', '16');
  assert.strictEqual(r.ok, true, JSON.stringify(r));
});

test('verifyCompletingSquare：负系数 x²-10x, 常数 25 -> ok:true', () => {
  const r = LLMV.verifyCompletingSquare('要把 x²-10x 配成完全平方式，需要加上的常数是多少？', '25');
  assert.strictEqual(r.ok, true, JSON.stringify(r));
});

/* ================================================================
 * 3. 验证门：verifyFormParam（q4 型配方 m,n）
 * ================================================================ */

console.log('\n--- 验证门：verifyFormParam ---');

test('verifyFormParam：正确 2x²-8x+1=0, m=2, n=7 -> ok:true', () => {
  // m = b/(2a) = -8/(2*2) = -2... 实际题面 "2(x-m)²=n" → m=b/(2a), n = a*m² + c
  // 但设计文档写 m=2, n=7：a=2, b=-8, c=1 → m = -8/(2*2) = -2?
  // 文档 §12 test 7 的断言是 verifyFormParam("把 2x²-8x+1=0 配方成 2(x-m)²=n", "2，7") → ok:true
  // 这里 m 和 n 是配方后的绝对值参数：2(x-2)²=7 → 2x²-8x+8=1 → 2x²-8x+1=0 ✓
  // 所以 m=b/(2a) 取绝对值 = 2, n = a*m² + c (c 移到右边变号... 实际 n = a*m² - c 移项)
  // 2*(2)² - 1 = 7 ✓
  const r = LLMV.verifyFormParam('把 2x²-8x+1=0 配方成 2(x-m)²=n', '2，7');
  assert.strictEqual(r.ok, true, JSON.stringify(r));
});

test('verifyFormParam：错误 2x²-8x+1=0, m=2, n=8 -> ok:false', () => {
  const r = LLMV.verifyFormParam('把 2x²-8x+1=0 配方成 2(x-m)²=n', '2，8');
  assert.strictEqual(r.ok, false, JSON.stringify(r));
});

/* ================================================================
 * 4. 验证门调度：validateLLMQuestion
 * ================================================================ */

console.log('\n--- 验证门调度：validateLLMQuestion ---');

test('validateLLMQuestion：verifyType=equation 路由到 verifyEquationRoots', () => {
  const q = {
    prompt: '解方程 x²+6x-7=0',
    answer: '1，-7',
    verifyType: 'equation'
  };
  const r = LLMV.validateLLMQuestion(q);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
});

test('validateLLMQuestion：verifyType=completeSquare 路由到 verifyCompletingSquare', () => {
  const q = {
    prompt: '要把 x²+6x 配成完全平方式，需要加上的常数是多少？',
    answer: '9',
    verifyType: 'completeSquare'
  };
  const r = LLMV.validateLLMQuestion(q);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
});

test('validateLLMQuestion：verifyType=formParam 路由到 verifyFormParam', () => {
  const q = {
    prompt: '把 2x²-8x+1=0 配方成 2(x-m)²=n',
    answer: '2，7',
    verifyType: 'formParam'
  };
  const r = LLMV.validateLLMQuestion(q);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
});

test('validateLLMQuestion：未知 verifyType -> ok:null, reason 含 unknown', () => {
  const q = {
    prompt: '某题',
    answer: '42',
    verifyType: 'unknown'
  };
  const r = LLMV.validateLLMQuestion(q);
  assert.strictEqual(r.ok, null, JSON.stringify(r));
  assert.ok(r.reason && r.reason.indexOf('unknown') >= 0, 'reason 应含 unknown: ' + JSON.stringify(r));
});

/* ================================================================
 * 5. 表达式求值安全（§3.3）
 * ================================================================ */

console.log('\n--- 表达式求值安全 ---');

test('表达式安全：含 eval 的表达式 -> 拒绝', () => {
  // evaluateExpression 内部应拒绝含字母的表达式
  const r = LLMV.evaluateExpression('eval("alert(1)")', [1]);
  assert.strictEqual(r, null, '含 eval 应返回 null');
});

test('表达式安全：含 Function 的表达式 -> 拒绝', () => {
  const r = LLMV.evaluateExpression('Function("return 1")()', [1]);
  assert.strictEqual(r, null, '含 Function 应返回 null');
});

test('表达式安全：含分号 -> 拒绝', () => {
  const r = LLMV.evaluateExpression('x; 1', [1]);
  assert.strictEqual(r, null, '含分号应返回 null');
});

test('表达式安全：含 Math -> 拒绝（白名单后无字母）', () => {
  const r = LLMV.evaluateExpression('Math.pow(x,2)', [2]);
  assert.strictEqual(r, null, '含 Math 应返回 null');
});

test('表达式安全：白名单正常表达式 x²+6x-7 -> 正确求值', () => {
  // x=1: 1+6-7=0
  const r = LLMV.evaluateExpression('x^2+6x-7', [1]);
  assert.ok(Array.isArray(r) && r.length === 1, '应返回数组: ' + JSON.stringify(r));
  assert.ok(Math.abs(r[0] - 0) < 1e-9, 'x=1 时 x²+6x-7=0: ' + r[0]);
});

test('表达式安全：² 转 **2 后求值', () => {
  // 用 ² 符号的表达式（白名单字符不含 ²，但内部转换 ²→**2）
  // 实际上 evaluateExpression 接收已清洗的表达式，这里测 ²→**2 转换
  const r = LLMV.evaluateExpression('x²-4', [2]);
  assert.ok(Array.isArray(r) && r.length === 1, '应返回数组: ' + JSON.stringify(r));
  assert.ok(Math.abs(r[0] - 0) < 1e-9, 'x=2 时 x²-4=0: ' + r[0]);
});

test('表达式安全：√ 转 Math.sqrt 后求值', () => {
  // √5 应转为 Math.sqrt(5) — 但 Math.sqrt 含字母...
  // 设计文档：先白名单后转换，转换产物不落地执行
  // 实际上 evaluateExpression 的白名单字符集是 [0-9x+\-*/().^ ]，不含 √
  // √ 的转换是在白名单检查之前完成的（²→**2, √→Math.sqrt），然后检查无字母
  // 但 Math.sqrt 含字母 → 所以 √ 的处理需要特殊路径
  // 这里测试 verifyEquationRoots 内部能处理根式（不走 evaluateExpression 白名单）
  // evaluateExpression 本身不接受 √
  const r = LLMV.evaluateExpression('x+√5', [0]);
  // √ 不在白名单 → 拒绝
  assert.strictEqual(r, null, '含 √ 且无法安全转换时应拒绝: ' + JSON.stringify(r));
});

test('表达式安全：嵌套括号 (x+1)*(x-1) 正常求值', () => {
  const r = LLMV.evaluateExpression('(x+1)*(x-1)', [3]);
  assert.ok(Array.isArray(r) && r.length === 1);
  assert.ok(Math.abs(r[0] - 8) < 1e-9, '(3+1)*(3-1)=8: ' + r[0]);
});

test('表达式安全：除零不抛异常 -> 返回 null 或 Infinity', () => {
  // 除零不应抛异常中断页面
  const r = LLMV.evaluateExpression('1/(x-1)', [1]);
  // 除零在 JS 中得到 Infinity，不抛异常——但设计说"求值抛错一律视为校验失败"
  // Infinity 不是抛错，所以这里可能返回 [Infinity] 或 null（取决于实现）
  // 关键是不抛异常
  assert.ok(r === null || (Array.isArray(r) && r.length === 1), '除零不应抛异常: ' + JSON.stringify(r));
});

test('表达式安全：幂优先级 x^2+1 正确', () => {
  const r = LLMV.evaluateExpression('x^2+1', [3]);
  assert.ok(Array.isArray(r) && r.length === 1);
  assert.ok(Math.abs(r[0] - 10) < 1e-9, '3^2+1=10: ' + r[0]);
});

test('表达式安全：LLM 输出解释文字（非表达式）-> 返回 null 不抛异常', () => {
  const r = LLMV.evaluateExpression('这是一段解释文字，不是表达式', [1]);
  assert.strictEqual(r, null, '非表达式应返回 null: ' + JSON.stringify(r));
});

/* ================================================================
 * 6. 管线：mock 网关返回候选 → 通过 / 重试 3 次 / 全失败 null
 * ================================================================ */

console.log('\n--- 管线：mock 网关 ---');

function mockGateway(questionObj) {
  const body = {
    choices: [{ message: { content: JSON.stringify(questionObj) } }]
  };
  const real = globalThis.fetch;
  globalThis.fetch = function () {
    return Promise.resolve({
      ok: true,
      json: function () { return Promise.resolve(body); }
    });
  };
  return function () { globalThis.fetch = real; };
}

function mockGatewayTimeout() {
  const real = globalThis.fetch;
  globalThis.fetch = function () {
    return new Promise(function (resolve, reject) {
      setTimeout(function () { reject(new Error('timeout')); }, 50);
    });
  };
  return function () { globalThis.fetch = real; };
}

function mockGatewaySequence(qList) {
  const real = globalThis.fetch;
  var idx = 0;
  globalThis.fetch = function () {
    var q = qList[idx++] || qList[qList.length - 1];
    var body = { choices: [{ message: { content: JSON.stringify(q) } }] };
    return Promise.resolve({
      ok: true,
      json: function () { return Promise.resolve(body); }
    });
  };
  return function () { globalThis.fetch = real; };
}

testAsync('管线：mock 网关返回正确候选 -> 通过验证门', async () => {
  LLMV._resetStats();
  LLMV._clearCache();
  const candidate = {
    prompt: '用配方法解方程 x²+8x+12=0',
    answer: '-2，-6',
    explanation: '移项后配方得 (x+4)²=4，所以 x=-2 或 x=-6。',
    verifyType: 'equation',
    difficulty: 'standard'
  };
  const restore = mockGateway(candidate);
  try {
    const q = await LLMV.genLLMVariant('cnm_221', { difficulty: 'standard' });
    assert.ok(q !== null, '应返回题对象，不是 null');
    assert.strictEqual(q.topicId, 'cnm_221');
    assert.strictEqual(q.type, 'numeric');
    assert.strictEqual(q.variantSource, 'llm');
    assert.strictEqual(q.verifyType, 'equation');
    assert.ok(q.id && q.id.indexOf('_lv') >= 0, 'id 应含 _lv: ' + q.id);
  } finally { restore(); }
});

testAsync('管线：mock 网关返回错误候选 3 次 -> 返回 null', async () => {
  LLMV._resetStats();
  LLMV._clearCache();
  // 每次都返回答案错误的题
  const badCandidate = {
    prompt: '用配方法解方程 x²+6x-7=0',
    answer: '2，-7',  // 2 不满足方程
    explanation: '错解',
    verifyType: 'equation',
    difficulty: 'standard'
  };
  const restore = mockGateway(badCandidate);
  try {
    const q = await LLMV.genLLMVariant('cnm_221', { difficulty: 'standard' });
    assert.strictEqual(q, null, '3 次全不过应返回 null');
    // 检查统计
    const stats = LLMV.getStats();
    assert.ok(stats.attempts >= 3, '应至少尝试 3 次: ' + JSON.stringify(stats));
    assert.ok(stats.failed >= 3, '应至少失败 3 次: ' + JSON.stringify(stats));
  } finally { restore(); }
});

testAsync('管线：mock 网关超时 -> 返回 null', async () => {
  LLMV._resetStats();
  LLMV._clearCache();
  const restore = mockGatewayTimeout();
  try {
    const q = await LLMV.genLLMVariant('cnm_221', { difficulty: 'standard' });
    assert.strictEqual(q, null, '网关超时应返回 null');
  } finally { restore(); }
});

testAsync('管线：前两次错第三次对 -> 返回正确题', async () => {
  LLMV._resetStats();
  LLMV._clearCache();
  const candidates = [
    { prompt: '用配方法解方程 x²+6x-7=0', answer: '2，-7', verifyType: 'equation', difficulty: 'standard' },  // 错
    { prompt: '用配方法解方程 x²+6x-7=0', answer: '3，-7', verifyType: 'equation', difficulty: 'standard' },  // 错
    { prompt: '用配方法解方程 x²+6x-7=0', answer: '1，-7', verifyType: 'equation', difficulty: 'standard' }   // 对
  ];
  const restore = mockGatewaySequence(candidates);
  try {
    const q = await LLMV.genLLMVariant('cnm_221', { difficulty: 'standard' });
    assert.ok(q !== null, '第三次应通过: ' + JSON.stringify(q));
    assert.ok(q.answer.indexOf('1') >= 0, '答案应含 1: ' + q.answer);
  } finally { restore(); }
});

testAsync('管线：网关不可达（fetch reject）-> 返回 null 不抛异常', async () => {
  LLMV._resetStats();
  LLMV._clearCache();
  const real = globalThis.fetch;
  globalThis.fetch = function () { return Promise.reject(new Error('ECONNREFUSED')); };
  try {
    const q = await LLMV.genLLMVariant('cnm_221', { difficulty: 'standard' });
    assert.strictEqual(q, null, '网关不可达应返回 null');
  } finally { globalThis.fetch = real; }
});

/* ================================================================
 * 7. 缓存池：命中 / 未命中 / 淘汰 / seed 跨等
 * ================================================================ */

console.log('\n--- 缓存池 ---');

testAsync('缓存池：生成后写入缓存，第二次命中', async () => {
  LLMV._resetStats();
  LLMV._clearCache();
  const candidate = {
    prompt: '用配方法解方程 x²+10x+16=0',
    answer: '-2，-8',
    verifyType: 'equation',
    difficulty: 'standard'
  };
  const restore = mockGateway(candidate);
  try {
    // 第一次：调网关生成
    const q1 = await LLMV.genLLMVariant('cnm_221', { difficulty: 'standard' });
    assert.ok(q1 !== null, '第一次应生成成功');
    // 第二次：应命中缓存（不调网关）
    var callCount = 0;
    const real = globalThis.fetch;
    globalThis.fetch = function () { callCount++; return real.apply(this, arguments); };
    const q2 = await LLMV.genLLMVariant('cnm_221', { difficulty: 'standard' });
    globalThis.fetch = real;
    assert.ok(q2 !== null, '第二次也应返回题');
    assert.strictEqual(callCount, 0, '第二次不应调网关（命中缓存）: ' + callCount);
  } finally { restore(); }
});

testAsync('缓存池：seed 派生题 id', async () => {
  LLMV._resetStats();
  LLMV._clearCache();
  const candidate = {
    prompt: '用配方法解方程 x²+2x-3=0',
    answer: '1，-3',
    verifyType: 'equation',
    difficulty: 'standard'
  };
  const restore = mockGateway(candidate);
  try {
    const q = await LLMV.genLLMVariant('cnm_221', { difficulty: 'standard', seed: 'cnm_221|test42' });
    assert.ok(q.seed, '应有 seed 字段');
    assert.ok(q.id && q.id.indexOf('cnm_221_lv') === 0, 'id 应以 cnm_221_lv 开头: ' + q.id);
  } finally { restore(); }
});

testAsync('缓存池：淘汰上限（超过 50 道时 LIFO 淘汰最旧）', async () => {
  LLMV._resetStats();
  LLMV._clearCache();
  // 直接操作缓存池测淘汰
  for (var i = 0; i < 55; i++) {
    LLMV._pushCache('cnm_221', {
      id: 'cnm_221_lv' + (i + 1),
      topicId: 'cnm_221',
      prompt: '题' + i,
      answer: '0',
      verifyType: 'equation',
      difficulty: 'standard',
      variant: true,
      variantSource: 'llm',
      variantIndex: i,
      seed: 'cnm_221|s' + i,
      createdAt: Date.now() + i
    });
  }
  var pool = LLMV._getCachePool('cnm_221');
  assert.ok(pool.length <= 50, '缓存池不应超过 50 道: ' + pool.length);
});

/* ================================================================
 * 8. 导出函数存在性与签名
 * ================================================================ */

console.log('\n--- 导出函数存在性 ---');

test('导出：evaluateExpression 存在且为函数', () => {
  assert.strictEqual(typeof LLMV.evaluateExpression, 'function');
});

test('导出：solveCheck 存在且为函数', () => {
  assert.strictEqual(typeof LLMV.solveCheck, 'function');
});

test('导出：normalizeSet 存在且为函数', () => {
  assert.strictEqual(typeof LLMV.normalizeSet, 'function');
});

test('导出：verifyEquationRoots 存在且为函数', () => {
  assert.strictEqual(typeof LLMV.verifyEquationRoots, 'function');
});

test('导出：verifyCompletingSquare 存在且为函数', () => {
  assert.strictEqual(typeof LLMV.verifyCompletingSquare, 'function');
});

test('导出：verifyFormParam 存在且为函数', () => {
  assert.strictEqual(typeof LLMV.verifyFormParam, 'function');
});

test('导出：validateLLMQuestion 存在且为函数', () => {
  assert.strictEqual(typeof LLMV.validateLLMQuestion, 'function');
});

test('导出：supports 存在且为函数', () => {
  assert.strictEqual(typeof LLMV.supports, 'function');
});

test('导出：genLLMVariant 存在且为函数', () => {
  assert.strictEqual(typeof LLMV.genLLMVariant, 'function');
});

test('导出：VERSION 存在', () => {
  assert.ok(LLMV.VERSION, 'VERSION 应有值');
});

test('导出：getStats 存在且为函数', () => {
  assert.strictEqual(typeof LLMV.getStats, 'function');
});

/* ================================================================
 * 9. supports 边界
 * ================================================================ */

console.log('\n--- supports 边界 ---');

test('supports：cnm_221 -> true（试点族）', () => {
  LLMV._resetStats();
  assert.strictEqual(LLMV.supports('cnm_221'), true);
});

test('supports：cnm_043 -> false（O1 的 topic 不归 O3）', () => {
  assert.strictEqual(LLMV.supports('cnm_043'), false);
});

test('supports：未知 topicId -> false', () => {
  assert.strictEqual(LLMV.supports('cnm_999'), false);
});

/* ================================================================
 * 10. solveCheck / normalizeSet 工具函数
 * ================================================================ */

console.log('\n--- 工具函数 ---');

test('solveCheck：正确根代入方程 -> true', () => {
  // x²+6x-7=0, candidate=1 → 1+6-7=0 → true
  assert.strictEqual(LLMV.solveCheck('x²+6x-7=0', '1'), true);
});

test('solveCheck：错误根代入方程 -> false', () => {
  // x²+6x-7=0, candidate=2 → 4+12-7=9 ≠ 0 → false
  assert.strictEqual(LLMV.solveCheck('x²+6x-7=0', '2'), false);
});

test('normalizeSet：多值答案归一为集合', () => {
  var s = LLMV.normalizeSet('1，-7');
  assert.ok(s.has(1) || s.has('1'), '集合应含 1');
  assert.ok(s.has(-7) || s.has('-7'), '集合应含 -7');
});

test('normalizeSet：± 展开后归一', () => {
  var s = LLMV.normalizeSet('2±√5');
  // 2+√5 ≈ 4.236, 2-√5 ≈ -0.236
  assert.ok(s.size >= 2, '± 应展开为 2 个元素: size=' + s.size);
});

/* ================================================================
 * 11. id 命名空间隔离
 * ================================================================ */

console.log('\n--- id 命名空间 ---');

test('id 命名空间：cnm_221_lv1 不匹配 /_q\\d+$/', () => {
  var id = 'cnm_221_lv1';
  assert.ok(!/_q\d+$/.test(id), '_lv 前缀不应误认为题库 _q 题号');
});

test('id 命名空间：cnm_221_lv1 不匹配 /^(.*)_q\\d+$/', () => {
  var id = 'cnm_221_lv1';
  assert.ok(!/^(.*)_q\d+$/.test(id), '_lv 前缀不应被 questionById 误认');
});

/* ================================================================
 * 12. 健康指标
 * ================================================================ */

console.log('\n--- 健康指标 ---');

test('健康指标：初始 stats 为零', () => {
  LLMV._resetStats();
  var stats = LLMV.getStats();
  assert.strictEqual(stats.attempts, 0, '初始 attempts 应为 0');
  assert.strictEqual(stats.passed, 0, '初始 passed 应为 0');
  assert.strictEqual(stats.failed, 0, '初始 failed 应为 0');
});

test('健康指标：10 次 attempts / 4 次 failed -> supports 返回 false（>30%）', () => {
  LLMV._resetStats();
  // 手动注入统计
  for (var i = 0; i < 6; i++) LLMV._recordStat('cnm_221:standard', true);
  for (var j = 0; j < 4; j++) LLMV._recordStat('cnm_221:standard', false);
  // 10 次 attempts, 4 failed → 40% > 30%
  assert.strictEqual(LLMV.supports('cnm_221', 'standard'), false, '40% 失败率应停用');
});

test('健康指标：10 次 attempts / 2 次 failed -> supports 返回 true（≤30%）', () => {
  LLMV._resetStats();
  for (var i = 0; i < 8; i++) LLMV._recordStat('cnm_221:standard', true);
  for (var j = 0; j < 2; j++) LLMV._recordStat('cnm_221:standard', false);
  // 10 次 attempts, 2 failed → 20% ≤ 30%
  assert.strictEqual(LLMV.supports('cnm_221', 'standard'), true, '20% 失败率不应停用');
});

test('健康指标：attempts < 10 时不判（小样本不拦）', () => {
  LLMV._resetStats();
  for (var i = 0; i < 3; i++) LLMV._recordStat('cnm_221:standard', false);
  // 3 次 attempts 全失败，但 < 10 → 不拦
  assert.strictEqual(LLMV.supports('cnm_221', 'standard'), true, '小样本不应停用');
});

/* ================================================================
 * 13. prompt 模板
 * ================================================================ */

console.log('\n--- prompt 模板 ---');

test('systemPrompt：含固定"答案："格式要求和 JSON 输出约束', () => {
  var sp = LLMV._systemPrompt();
  assert.ok(sp.indexOf('JSON') >= 0, 'systemPrompt 应要求 JSON 输出');
  assert.ok(sp.indexOf('verifyType') >= 0, 'systemPrompt 应提及 verifyType 字段');
});

test('userPrompt：基础难度含 completeSquare', () => {
  var up = LLMV._userPrompt('basic');
  assert.ok(up.indexOf('completeSquare') >= 0 || up.indexOf('配方') >= 0, 'basic 应含配方/completeSquare: ' + up);
});

test('userPrompt：标准难度含 equation', () => {
  var up = LLMV._userPrompt('standard');
  assert.ok(up.indexOf('equation') >= 0 || up.indexOf('解') >= 0, 'standard 应含解方程/equation: ' + up);
});

test('userPrompt：进阶难度含 formParam 或 equation', () => {
  var up = LLMV._userPrompt('advanced');
  assert.ok(up.indexOf('formParam') >= 0 || up.indexOf('equation') >= 0, 'advanced 应含 formParam 或 equation: ' + up);
});

test('userPrompt：题目文本不入 prompt（防注入）', () => {
  // userPrompt 不应包含任何题库的具体题目文本
  var up = LLMV._userPrompt('standard');
  assert.ok(up.indexOf('x²+6x-7') < 0, 'userPrompt 不应含具体题目 x²+6x-7: ' + up);
  assert.ok(up.indexOf('x²+8x+12') < 0, 'userPrompt 不应含具体题目 x²+8x+12: ' + up);
});

/* ================================================================
 * 运行异步测试
 * ================================================================ */

(async function () {
  for (const t of asyncTests) {
    try { await t.fn(); passed++; console.log('  ok   ' + t.name); }
    catch (e) { failed++; console.log('  FAIL ' + t.name + '\n       ' + (e && e.stack || e).split('\n').slice(0, 4).join('\n       ')); }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
