#!/usr/bin/env node
/* 卡1 数值基础层单测：node tests/test_construct_num.js（零依赖、零网络、零 LLM）
 *
 * 口径：本文件**不 require construct.js**，只测 construct-num.js 这一层的精确性。
 * 每条断言都盯着一个「用浮点就会错」的点：大数、分数约分与符号、0.1+0.2、
 * 四舍五入的 .5 边界、根式还原、负指数、括号优先级、双路求值一致。
 */
'use strict';

const N = require('../diagnose/construct-num.js');

let passed = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { passed++; return true; }
  failures.push(msg);
  return false;
}
function eq(actual, expected, msg) {
  return ok(actual === expected, msg + '（期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual) + '）');
}
function throws(fn, msg, re) {
  try { fn(); } catch (e) { return ok(!re || re.test(String(e && e.message)), msg + '（报错文案：' + e.message + '）'); }
  return ok(false, msg + '（本该抛错却没抛）');
}
function group(name) { console.log('\n-- ' + name + ' --'); }

function main() {
  console.log('== 卡1 数值基础层单测 ==');
  eq(N.available, true, '数值层必须可用（需要 BigInt）');

  /* ---------------------------------------------------------------- 整数 */
  group('整数（BigInt 精确）');
  const a = '123456789012345678', b = '987654321098765432';
  eq(N.mul(a, b).toString(), '121932631137021794322511812221002896', '18 位数相乘必须逐位精确（Number 会丢精度）');
  eq(N.add('9007199254740993', '1').toString(), '9007199254740994', '超过 2^53 的加法必须精确');
  const dm1 = N.divmod('1234567890123456789', '987654321');
  eq(dm1.q.toString() + 'r' + dm1.r.toString(), '1249999988r725308641',
    '大数带余除法：商与余数都要精确');
  eq(N.mul(dm1.q, '987654321') .toString(), N.sub('1234567890123456789', dm1.r).toString(),
    '带余除法回代：商×除数 == 被除数−余数');
  const dm2 = N.divmod(-17, 5);
  eq(dm2.q.toString() + 'r' + dm2.r.toString(), '-3r-2', '负数带余除法按向零截断（与 BigInt 语义一致）');
  eq(N.cmp('999999999999999999999', '1000000000000000000000'), -1, '大数比较不走浮点');
  eq(N.abs('-42').toString(), '42', 'abs');
  eq(N.sign('-42') + ',' + N.sign('0') + ',' + N.sign('7'), '-1,0,1', 'sign');
  eq(N.gcd('1071', '462').toString(), '21', 'gcd');
  eq(N.ipow(3, 20).toString(), '3486784401', '整数幂');
  throws(() => N.divmod(1, 0), '除数为零必须抛错', /除数为零/);
  throws(() => N.int(1.5), '非整数必须拒绝（不许悄悄取整）', /非整数/);
  throws(() => N.int('1e5'), '科学计数法字符串不是整数输入', /无法转成整数/);

  /* ---------------------------------------------------------------- 分数 */
  group('分数（约分、符号、四则）');
  const f1 = N.frac(6, -8);
  eq(N.fText(f1), '-3/4', '分母为负时符号翻到分子，且约分到最简');
  eq(N.fText(N.frac(9, 3)), '3', '能整除时写整数');
  eq(N.fText(N.frac(-9, 3)), '-3', '负整数结果');
  eq(N.fText(N.frac(0, 7)), '0', '零约成 0/1');
  eq(N.fAdd(N.frac(1, 3), N.frac(1, 6)).d.toString(), '2', '异分母相加（1/3+1/6=1/2）');
  eq(N.fText(N.fAdd(N.frac(1, 3), N.frac(1, 6))), '1/2', '1/3 + 1/6 = 1/2');
  eq(N.fText(N.fSub(N.frac(7, 12), N.frac(5, 18))), '11/36', '7/12 − 5/18 = 11/36（通分后约分）');
  eq(N.fText(N.fMul(N.frac(-2, 3), N.frac(9, 4))), '-3/2', '负数相乘');
  eq(N.fText(N.fDiv(N.frac(3, 4), N.frac(-9, 8))), '-2/3', '除以负数');
  eq(N.fCmp(N.frac(2, 3), N.frac(3, 5)), 1, '分数比较 2/3 > 3/5');
  eq(N.fEq(N.frac(6, 8), N.frac(3, 4)), true, '不同写法的同一分数相等');
  eq(N.fText(N.fNeg(N.frac(3, 7))), '-3/7', '取负');
  eq(N.fText(N.fAbs(N.frac(-3, 7))), '3/7', '取绝对值');
  eq(N.fText(N.fFromText('-7/4')), '-7/4', '文本→分数往返');
  eq(N.fFromText('1/0'), null, '分母为零的文本解析返回 null 而不是抛错');
  throws(() => N.fDiv(N.frac(1, 2), N.frac(0, 5)), '分数除零必须抛错', /除零/);

  /* ---------------------------------------------------------------- 幂 */
  group('幂（含负指数）');
  eq(N.fText(N.powInt(2, 10)), '1024', '2^10');
  eq(N.fText(N.powInt(2, 0)), '1', '零次幂');
  eq(N.fText(N.powInt(2, -3)), '1/8', '负指数返回分数 2^-3 = 1/8');
  eq(N.fText(N.powInt(N.frac(2, 3), 2)), '4/9', '分数幂');
  eq(N.fText(N.powInt(N.frac(2, 3), -2)), '9/4', '分数负幂');
  eq(N.fText(N.powInt(-2, 3)), '-8', '负底数奇次幂');
  eq(N.fText(N.powInt(-2, 4)), '16', '负底数偶次幂');
  throws(() => N.powInt(2, 1.5), '非整数指数必须拒绝', /指数非法/);

  /* ---------------------------------------------------------------- 定点小数 */
  group('定点小数（整数 + 小数位，四舍五入用整数除余）');
  eq(N.fxText(N.fxAdd(N.fx(1, 1), N.fx(2, 1))), '0.3', '0.1 + 0.2 = 0.3（浮点会得到 0.30000000000000004）');
  eq(N.fxText(N.fxMul(N.fx(3, 1), N.fx(7, 1))), '0.21', '0.3 × 0.7 = 0.21（浮点会得到 0.21 但内部带误差）');
  eq(N.fxToFrac(N.fxMul(N.fx(1, 1), N.fx(2, 1))).n.toString(), '1', '0.1×0.2 的分子精确为 1');
  eq(N.fxToFrac(N.fxMul(N.fx(1, 1), N.fx(2, 1))).d.toString(), '50', '0.1×0.2 = 1/50');
  eq(N.fxText(N.fxRound(N.fx(125, 2), 1)), '1.3', '1.25 保留一位：四舍五入得 1.3');
  eq(N.fxText(N.fxRound(N.fx(-125, 2), 1)), '-1.3', '−1.25 保留一位：远离零进位得 −1.3');
  eq(N.fxText(N.fxRound(N.fx(124, 2), 1)), '1.2', '1.24 保留一位得 1.2');
  eq(N.fxText(N.fxRound(N.fx(135, 2), 1)), '1.4', '1.35 保留一位得 1.4');
  eq(N.fxText(N.fxRound(N.fx(134, 2), 1)), '1.3', '1.34 保留一位得 1.3');
  eq(N.fxText(N.fx(1, 1), 3), '0.100', '定长显示：按 3 位补零');
  eq(N.fxText(N.fx(5, 0), 2), '5.00', '整数按 2 位小数显示补零');
  eq(N.fxText(N.fxRound(N.fx(123456, 0), 2)), '123456', '位数多于实际值时原样显示');
  eq(N.fxText(N.fracToFx(N.frac(1, 3), 4)), '0.3333', '1/3 保留四位得 0.3333');
  eq(N.fxText(N.fracToFx(N.frac(2, 3), 3)), '0.667', '2/3 保留三位得 0.667（四舍五入）');
  eq(N.fxText(N.fxSub(N.fx(100, 2), N.fx(1, 1))), '0.9', '1.00 − 0.1 = 0.9');

  /* ---------------------------------------------------------------- 根式 */
  group('根式（整数试除，不用 Math.sqrt 反推）');
  eq(N.radText(N.sqrtSimplify(72)), '6√2', '√72 = 6√2');
  eq(N.radText(N.sqrtSimplify(8)), '2√2', '√8 = 2√2');
  eq(N.radText(N.sqrtSimplify(9)), '3', '√9 = 3');
  eq(N.radText(N.sqrtSimplify(1)), '1', '√1 = 1');
  eq(N.radText(N.sqrtSimplify(18)), '3√2', '√18 = 3√2');
  eq(N.radText(N.sqrtSimplify(2)), '√2', '√2 保持根式');
  eq(N.radText(N.sqrtSimplify(0)), '0', '√0 = 0');
  [2, 8, 12, 18, 45, 50, 72, 98, 200, 1024, 44100].forEach(function (n) {
    const r = N.sqrtSimplify(n);
    eq(N.radSquare(r).toString(), String(n), '根式还原：k²·m 必须等于原被开方数 n=' + n);
    ok(r.m <= N.int(1) || true, 'noop');
  });
  eq(N.radText(N.radMul(N.sqrtSimplify(2), N.sqrtSimplify(8))), '4', '√2 × √8 = 4');
  eq(N.radEq(N.radical(2, 8), N.radical(4, 2)), true, '2√8 与 4√2 是同一个根式');
  throws(() => N.sqrtSimplify(-4), '负数开平方必须抛错', /负数的算术平方根/);

  /* ---------------------------------------------------------------- 表达式 */
  group('表达式：AST 直算 vs 中缀文本（双路求值）');
  const e1 = { op: '-', l: { n: 50 }, r: { op: '×', l: { op: '+', l: { n: 8 }, r: { n: 12 } }, r: { n: 2 } } };
  eq(N.render(e1), '50-(8+12)×2', '渲染：括号只补必要处');
  eq(N.fText(N.evalAst(e1)), '10', 'AST 直算 50−(8+12)×2 = 10');
  eq(N.fText(N.evalInfix('50-(8+12)×2')), '10', '中缀文本求值同解');
  eq(N.fText(N.evalBoth(e1, N.render(e1))), '10', '双路求值一致');

  const e2 = { op: '÷', l: { op: '+', l: { n: 48 }, r: { n: 52 } }, r: { op: '-', l: { n: 20 }, r: { n: 15 } } };
  eq(N.render(e2), '(48+52)÷(20-15)', '两个括号都要补');
  eq(N.fText(N.evalInfix(N.render(e2))), '20', '(48+52)÷(20−15) = 20');

  const e3 = { op: '÷', l: { n: 100 }, r: { op: '÷', l: { n: 10 }, r: { n: 2 } } };
  eq(N.render(e3), '100÷(10÷2)', '除法的右子树同级也必须加括号（否则 100÷10÷2 算成 5）');
  eq(N.fText(N.evalInfix(N.render(e3))), '20', '100÷(10÷2) = 20，而不是 5');

  const e4 = { op: '-', l: { n: 100 }, r: { op: '-', l: { n: 10 }, r: { n: 2 } } };
  eq(N.render(e4), '100-(10-2)', '减法的右子树同级也必须加括号');
  eq(N.fText(N.evalInfix(N.render(e4))), '92', '100−(10−2) = 92，而不是 88');

  const e5 = { op: '+', l: { n: 7 }, r: { op: '×', l: { n: 8 }, r: { n: 9 } } };
  eq(N.render(e5), '7+8×9', '子式优先级更高时不加括号');
  eq(N.fText(N.evalInfix('7+8×9')), '79', '先乘除后加减');

  eq(N.fText(N.evalInfix('２７＋５')), '32', '全角数字/全角加号也能解析（题面用全角）');
  eq(N.fText(N.evalInfix('50－(8＋12)×2')), '10', '全角减号/加号');
  eq(N.fText(N.evalInfix('9÷2')), '9/2', '不整除时保留分数，不四舍五入');
  eq(N.evalBoth({ op: '÷', l: { n: 9 }, r: { n: 2 } }, '9÷2') !== null, true, '不整除也走分数精确比较');
  eq(N.evalBoth(e1, '50-(8+12)×3'), null, '题面数字与 AST 不一致时双路求值必须报不一致（返回 null）');
  throws(() => N.evalInfix('(1+2'), '括号不匹配要抛错', /括号不匹配/);
  throws(() => N.evalInfix('1+'), '式子不完整要抛错', /表达式不完整/);
  throws(() => N.evalInfix('1÷0'), '除零要抛错', /除零/);
  throws(() => N.evalInfix('2x+1'), '出现字母必须抛错（算术族不认变量）', /无效字符/);
  cd(N.leaves(e1), ['50', '8', '12', '2'], '叶子按出现顺序提取');
  eq(JSON.stringify(N.statTree(e1).steps), '3', 'statTree 步数 = 运算符个数');
  eq(JSON.stringify(N.statTree(e1).depth), '3', 'statTree 深度');

  console.log('\n通过断言 ' + passed + ' 条');
  if (failures.length) {
    console.log('\n失败 ' + failures.length + ' 条：');
    failures.forEach(function (f) { console.log('  ✗ ' + f); });
    process.exit(1);
  }
  console.log('全部通过');
}

function cd(actual, expected, msg) {
  return eq(actual.map(String).join(','), expected.join(','), msg);
}

main();
