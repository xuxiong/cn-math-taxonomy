#!/usr/bin/env node
/* O3-8 拆分后纯函数层测试：node tests/test_llm_eval.js（无依赖，仅用 assert）
 *
 * 直测 diagnose/llm-eval.js —— 零依赖、无网络、无 DOM、无 localStorage。
 * 覆盖拆分出的求值/解析/验证门，并断言「纯」这一结构约束本身。
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e).split('\n').slice(0, 4).join('\n       ')); }
}

const E = require('../diagnose/llm-eval.js');
const EVAL_SRC = fs.readFileSync(path.join(__dirname, '..', 'diagnose', 'llm-eval.js'), 'utf8');
/* 剥掉注释后的源码：结构约束只看真实代码，说明性注释里提到 localStorage/Date.now 不算命中 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}
const EVAL_CODE = stripComments(EVAL_SRC);

/* ================================================================
 * 1. 结构约束：本模块必须真正「纯」
 * ================================================================ */

console.log('\n--- 结构约束：纯函数层零副作用 ---');

test('llm-eval.js 不含 fetch（无网络）', () => {
  assert.ok(!/\bfetch\s*\(/.test(EVAL_CODE), '发现 fetch 调用');
});

test('llm-eval.js 不含 localStorage（无持久化）', () => {
  assert.ok(!/localStorage/.test(EVAL_CODE), '发现 localStorage');
});

test('llm-eval.js 不含 Date.now（无时钟依赖）', () => {
  assert.ok(!/Date\.now/.test(EVAL_CODE), '发现 Date.now');
});

test('llm-eval.js 不含 setTimeout（无异步/定时）', () => {
  assert.ok(!/setTimeout/.test(EVAL_CODE), '发现 setTimeout');
});

test('llm-eval.js 不 require 任何模块（零依赖）', () => {
  assert.ok(!/require\s*\(/.test(EVAL_CODE), '发现 require 调用');
});

test('UMD：工厂函数无参数（不依赖外部注入）', () => {
  assert.ok(/function\s*\(\s*\)\s*\{\s*\n\s*'use strict'/.test(EVAL_SRC), '工厂函数不应有参数');
});

test('导出面包含约定的全部纯函数', () => {
  const want = ['evaluateExpression', 'solveCheck', 'normalizeSet', 'verifyEquationRoots',
    'verifyCompletingSquare', 'verifyFormParam', 'validateLLMQuestion',
    'parseEquation', 'parseQuadraticCoeffs', 'parseRootValue', 'parseRoots',
    'expandPlusMinus', 'splitTop', 'EPS'];
  for (const k of want) assert.ok(k in E, '缺少导出: ' + k);
});

test('不含基线配置（FAMILY/_methodWordMatches 属管线层，不应在 eval 层）', () => {
  assert.ok(!('_methodWordMatches' in E), '_methodWordMatches 应在 llm-variants.js');
  assert.ok(!/var\s+FAMILY\s*=/.test(EVAL_SRC), 'FAMILY 应在 llm-variants.js');
});

/* ================================================================
 * 2. evaluateExpression：白名单与转换
 * ================================================================ */

console.log('\n--- evaluateExpression ---');

test('evaluateExpression：x^2+6x-7 在 x=1 处为 0', () => {
  assert.deepStrictEqual(E.evaluateExpression('x^2+6x-7', [1]), [0]);
});

test('evaluateExpression：x^2+6x-7 在 x=-7 处为 0', () => {
  assert.deepStrictEqual(E.evaluateExpression('x^2+6x-7', [-7]), [0]);
});

test('evaluateExpression：支持 ²（NFKC 前先转幂）', () => {
  assert.deepStrictEqual(E.evaluateExpression('x²-4', [2]), [0]);
});

test('evaluateExpression：省略乘号 2x 与括号相乘', () => {
  assert.deepStrictEqual(E.evaluateExpression('2x', [3]), [6]);
  assert.deepStrictEqual(E.evaluateExpression('(x+1)(x-2)', [2]), [0]);
});

test('evaluateExpression：多值一次求值', () => {
  assert.deepStrictEqual(E.evaluateExpression('x^2', [0, 2, -3]), [0, 4, 9]);
});

test('evaluateExpression：非法输入一律返回 null（不抛错）', () => {
  assert.strictEqual(E.evaluateExpression(null, [1]), null);
  assert.strictEqual(E.evaluateExpression(undefined, [1]), null);
  assert.strictEqual(E.evaluateExpression(123, [1]), null);
  assert.strictEqual(E.evaluateExpression('', [1]), null);
  assert.strictEqual(E.evaluateExpression('   ', [1]), null);
});

test('evaluateExpression：含字母/危险字符被白名单拦下', () => {
  assert.strictEqual(E.evaluateExpression('alert(1)', [1]), null);
  assert.strictEqual(E.evaluateExpression('|x|', [1]), null);
  assert.strictEqual(E.evaluateExpression('x^', [1]), null);
});

/* ================================================================
 * 3. solveCheck / normalizeSet
 * ================================================================ */

console.log('\n--- solveCheck / normalizeSet ---');

test('solveCheck：x-1=0 @ 1 -> true，@ 2 -> false', () => {
  assert.strictEqual(E.solveCheck('x-1=0', '1'), true);
  assert.strictEqual(E.solveCheck('x-1=0', '2'), false);
});

test('solveCheck：无等号的表达式 -> false（不是方程）', () => {
  assert.strictEqual(E.solveCheck('x-1', '1'), false);
});

test('solveCheck：x^2+6x-7=0 @ 1 与 @ -7 -> true', () => {
  assert.strictEqual(E.solveCheck('x^2+6x-7=0', '1'), true);
  assert.strictEqual(E.solveCheck('x^2+6x-7=0', '-7'), true);
});

test('normalizeSet：中文逗号与英文逗号归一（入参是字符串，返回 Set）', () => {
  const cn = E.normalizeSet('1，-7');
  assert.ok(cn instanceof Set, '应返回 Set');
  assert.deepStrictEqual(Array.from(cn).sort((a, b) => a - b), [-7, 1]);
  assert.deepStrictEqual(Array.from(cn), Array.from(E.normalizeSet('1,-7')));
});

test('normalizeSet：空输入返回空 Set（不抛错）', () => {
  const empty = E.normalizeSet('');
  assert.ok(empty instanceof Set);
  assert.strictEqual(empty.size, 0);
});

/* ================================================================
 * 4. 验证门三件套
 * ================================================================ */

console.log('\n--- 验证门 ---');

test('verifyEquationRoots：正确根 -> ok:true', () => {
  const r = E.verifyEquationRoots('用配方法解方程 x²+6x-7=0', '1，-7');
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.reason, 'all-roots-verified');
});

test('verifyEquationRoots：错根 -> ok:false', () => {
  const r = E.verifyEquationRoots('用配方法解方程 x²+6x-7=0', '2，-7');
  assert.strictEqual(r.ok, false, JSON.stringify(r));
});

test('verifyEquationRoots：根式 2±√5 -> ok:true', () => {
  const r = E.verifyEquationRoots('用配方法解 x²-4x-1=0', '2±√5');
  assert.strictEqual(r.ok, true, JSON.stringify(r));
});

test('verifyEquationRoots：题面解析不出方程 -> parse-equation-failed', () => {
  const r = E.verifyEquationRoots('随机文字没有方程', '1');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'parse-equation-failed');
});

test('verifyCompletingSquare：x²+6x 加常数 9 -> verified', () => {
  const r = E.verifyCompletingSquare('要把 x²+6x 配成完全平方式，需要加上的常数是多少？', '9');
  assert.strictEqual(r.ok, true, JSON.stringify(r));
});

test('verifyCompletingSquare：错答案 -> mismatch', () => {
  const r = E.verifyCompletingSquare('要把 x²+6x 配成完全平方式，需要加上的常数是多少？', '12');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'mismatch');
});

test('verifyCompletingSquare：b=1 的 x²+x -> 0.25', () => {
  const r = E.verifyCompletingSquare('要把 x²+x 配成完全平方式，需要加上的常数是多少？', '0.25');
  assert.strictEqual(r.ok, true, JSON.stringify(r));
});

test('verifyFormParam：2x²-8x+1 -> m=2,n=7 verified', () => {
  const r = E.verifyFormParam('把 2x²-8x+1=0 配方成 2(x-m)²=n，依次求 m 与 n', '2，7');
  assert.strictEqual(r.ok, true, JSON.stringify(r));
});

test('verifyFormParam：n 错 -> n-mismatch', () => {
  const r = E.verifyFormParam('把 2x²-8x+1=0 配方成 2(x-m)²=n，依次求 m 与 n', '2，8');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'n-mismatch');
});

test('validateLLMQuestion：按 verifyType 路由到三个验证门', () => {
  assert.strictEqual(E.validateLLMQuestion({ prompt: '用配方法解方程 x²+6x-7=0', answer: '1，-7', verifyType: 'equation' }).ok, true);
  assert.strictEqual(E.validateLLMQuestion({ prompt: '要把 x²+6x 配成完全平方式，需要加上的常数是多少？', answer: '9', verifyType: 'completeSquare' }).ok, true);
  assert.strictEqual(E.validateLLMQuestion({ prompt: '把 2x²-8x+1=0 配方成 2(x-m)²=n，依次求 m 与 n', answer: '2，7', verifyType: 'formParam' }).ok, true);
});

test('validateLLMQuestion：无 verifyType / 未知 type -> ok:null（不误杀）', () => {
  assert.strictEqual(E.validateLLMQuestion({ prompt: 'x', answer: '1' }).ok, null);
  assert.strictEqual(E.validateLLMQuestion(null).ok, null);
  const r = E.validateLLMQuestion({ prompt: 'x', answer: '1', verifyType: 'bogus' });
  assert.strictEqual(r.ok, null);
  assert.ok(/unknown-type/.test(r.reason));
});

/* ================================================================
 * 5. 解析工具
 * ================================================================ */

console.log('\n--- 解析工具 ---');

test('parseEquation：提取 lhs/rhs', () => {
  const eq = E.parseEquation('用配方法解方程 x²+6x-7=0');
  assert.ok(eq, '应解析出方程');
  assert.ok(eq.lhs && eq.rhs, JSON.stringify(eq));
});

test('parseQuadraticCoeffs：2x²-8x+1 -> a=2,b=-8,c=1', () => {
  const c = E.parseQuadraticCoeffs('把 2x²-8x+1=0 配方成 2(x-m)²=n，依次求 m 与 n');
  assert.strictEqual(c.a, 2);
  assert.strictEqual(c.b, -8);
  assert.strictEqual(c.c, 1);
});

test('parseRootValue：分数与整数', () => {
  assert.strictEqual(E.parseRootValue('1/2'), 0.5);
  assert.strictEqual(E.parseRootValue('-3'), -3);
});

test('parseRoots：多解与「或」分隔', () => {
  assert.deepStrictEqual(E.parseRoots('1，-7'), [1, -7]);
  assert.deepStrictEqual(E.parseRoots('1或-7'), [1, -7]);
});

test('expandPlusMinus：2±√5 -> 展开为逗号分隔两式（返回字符串，供 splitTop 切割）', () => {
  const r = E.expandPlusMinus('2±√5');
  assert.strictEqual(typeof r, 'string');
  assert.strictEqual(r, '2+√5,2-√5');
  // 展开后经 splitTop 应得到两个顶层项
  assert.deepStrictEqual(E.splitTop(r, ',;，；、'), ['2+√5', '2-√5']);
});

test('splitTop：只切顶层逗号（括号内不切）', () => {
  assert.deepStrictEqual(E.splitTop('1，-7', ',;，；、'), ['1', '-7']);
});

test('EPS 导出为 1e-9', () => {
  assert.strictEqual(E.EPS, 1e-9);
});

/* ================================================================
 * 6. 与管线层一致性：同一函数不得两份实现
 * ================================================================ */

console.log('\n--- 与管线层一致性 ---');

test('llm-variants 导出的验证函数与 llm-eval 是同一份实现', () => {
  const V = require('../diagnose/llm-variants.js');
  assert.strictEqual(V.validateLLMQuestion, E.validateLLMQuestion, 'validateLLMQuestion 应为同一函数引用');
  assert.strictEqual(V.verifyEquationRoots, E.verifyEquationRoots);
  assert.strictEqual(V.evaluateExpression, E.evaluateExpression);
  assert.strictEqual(V.solveCheck, E.solveCheck);
  assert.strictEqual(V.normalizeSet, E.normalizeSet);
});

test('管线层不再自带验证门实现（源码内无 function verifyEquationRoots 定义）', () => {
  const vsrc = fs.readFileSync(path.join(__dirname, '..', 'diagnose', 'llm-variants.js'), 'utf8');
  assert.ok(!/function\s+verifyEquationRoots\s*\(/.test(vsrc), 'llm-variants.js 不应重复定义 verifyEquationRoots');
  assert.ok(!/function\s+evaluateExpression\s*\(/.test(vsrc), 'llm-variants.js 不应重复定义 evaluateExpression');
  assert.ok(!/function\s+validateLLMQuestion\s*\(/.test(vsrc), 'llm-variants.js 不应重复定义 validateLLMQuestion');
});

test('网关层不再自带求值实现', () => {
  const gsrc = fs.readFileSync(path.join(__dirname, '..', 'diagnose', 'llm-gateway.js'), 'utf8');
  assert.ok(!/function\s+evaluateExpression\s*\(/.test(gsrc), 'llm-gateway.js 不应定义 evaluateExpression');
  assert.ok(!/var\s+WHITELIST\s*=/.test(gsrc), 'llm-gateway.js 不应定义 WHITELIST');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);
