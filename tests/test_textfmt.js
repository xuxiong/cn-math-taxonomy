#!/usr/bin/env node
/* 文本规范化统一出口测试（卡 t_42e5978b）：node tests/test_textfmt.js
 *
 * 覆盖四件事：
 *   1. 纯函数断言：LaTeX / Markdown / 幂写法 → 纯文本（含不误伤与幂等）
 *   2. 单一实现：清洗只有 diagnose/textfmt.js 一份，explain.js 是薄委托
 *   3. 与验证层同口径：规范化后的题面仍可被 llm-eval 求值（x^4 → x⁴ 不丢幂次）
 *   4. 卡 C 管线接上：模型文本先规范化、再进七道门；清洗后重跑泄露判定
 *   5. 口径回归：tmp/llm-batch-*.json 抽样，\frac / $ = 0、^ 出现率 ≤ 题库 1.1%
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;
let skipped = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e).split('\n').slice(0, 4).join('\n       ')); }
}
function skip(name, why) { skipped++; console.log('  skip ' + name + ' — ' + why); }

const ROOT = path.join(__dirname, '..');
const T = require('../diagnose/textfmt.js');
const E = require('../diagnose/llm-eval.js');
const G = require('../diagnose/llm-gates.js');
const GEN = require('../diagnose/llm-gen.js');

/* ================================================================
 * 1. 纯函数：LaTeX / Markdown / 幂写法
 * ================================================================ */

console.log('\n--- 纯函数：LaTeX 残留 ---');

test('\\frac{x+a}{x-b} -> (x+a)/(x-b)', () => {
  assert.strictEqual(T.normalize('已知分式 \\frac{x+a}{x-b}，当 x=2 时'), '已知分式 (x+a)/(x-b)，当 x=2 时');
});

test('\\sqrt{3} -> √3', () => {
  assert.strictEqual(T.normalize('\\sqrt{3} 约等于 1.73'), '√3 约等于 1.73');
});

test('\\sqrt[3]{8} -> 3 次根号 8', () => {
  assert.strictEqual(T.normalize('求 \\sqrt[3]{8}'), '求 3 次根号 8');
});

test('\\pm / \\times / \\div / \\le 转 Unicode 符号', () => {
  assert.strictEqual(T.normalize('x=2\\pm\\sqrt{5}'), 'x=2±√5');
  assert.strictEqual(T.normalize('3\\times4\\div2'), '3×4÷2');
  assert.strictEqual(T.normalize('x\\le5'), 'x≤5');
});

test('\\frac 嵌套多轮剥离（不残留花括号）', () => {
  const out = T.normalize('\\frac{\\frac{1}{2}}{3}');
  assert.ok(out.indexOf('{') < 0 && out.indexOf('}') < 0, '不应残留花括号: ' + out);
  assert.ok(out.indexOf('\\frac') < 0, '不应残留 \\frac: ' + out);
});

console.log('\n--- 纯函数：$ 与 Markdown ---');

test('$...$ 数学模式定界符剥净', () => {
  assert.strictEqual(T.normalize('已知 $x^2=4$，求 $x$'), '已知 x²=4，求 x');
  assert.strictEqual(T.normalize('$$\\frac{1}{2}$$').indexOf('$'), -1);
});

test('**加粗** / `代码` 剥净', () => {
  assert.strictEqual(T.normalize('**加粗**与`代码`'), '加粗与代码');
});

test('行首 # / > / 列表符剥净（多行也生效）', () => {
  const out = T.normalize('# 解析\n> 注意\n- 第一步\n* 第二步\n所以 x=3');
  assert.ok(out.indexOf('#') < 0 && out.indexOf('>') < 0, out);
  assert.ok(!/^[-*+]\s/.test(out), out);
  assert.ok(out.indexOf('第一步') >= 0 && out.indexOf('x=3') >= 0, out);
});

console.log('\n--- 纯函数：幂与根号（卡里点名的缺口） ---');

test('x^2 -> x²、^3 -> ³', () => {
  assert.strictEqual(T.normalize('x^2+2x+1'), 'x²+2x+1');
  assert.strictEqual(T.normalize('2^3'), '2³');
  assert.strictEqual(T.normalize('(x+3)^2'), '(x+3)²');
});

test('字母指数：n / i 用 Unicode 上标，其余转中文', () => {
  assert.strictEqual(T.normalize('a^n'), 'aⁿ');
  assert.strictEqual(T.normalize('a^i'), 'aⁱ');
  assert.strictEqual(T.normalize('7^a'), '7 的 a 次方');
});

test('x^(n+1) -> x 的 n+1 次方', () => {
  assert.strictEqual(T.normalize('a^(n+1)'), 'a 的 n+1 次方');
});

test('多位指数按位转上标，不拼错', () => {
  assert.strictEqual(T.normalize('x^10'), 'x¹⁰');
  assert.strictEqual(T.normalize('x^{10}'), 'x¹⁰');
});

console.log('\n--- 纯函数：不误伤（口径见 textfmt.js 文件头） ---');

test('数值乘方：多位指数保留原样（2^10），单位指数照常上标（10^6）', () => {
  /* 口径见 textfmt.js 文件头规则 2：数值底数 + 多位指数是科学记数法写法，保留 ^ 不拼字符；
   * 单位指数信息无损，与 2^3 -> 2³ 同一规则。 */
  assert.strictEqual(T.normalize('2^10'), '2^10');
  assert.strictEqual(T.normalize('10^6'), '10⁶');
});

test('已是上标的 ² 原样（幂等前提）', () => {
  assert.strictEqual(T.normalize('a²+b²'), 'a²+b²');
});

test('数字元组 / 不等式 / 负号原样', () => {
  assert.strictEqual(T.normalize('(3,4)'), '(3,4)');
  assert.strictEqual(T.normalize('x<5'), 'x<5');
  assert.strictEqual(T.normalize('-1/2'), '-1/2');
});

test('幂等：normalize(normalize(s)) === normalize(s)', () => {
  const cases = [
    'x^2+2x+1', '\\frac{x+a}{x-b}', '**加粗** $x^2$', 'a^(n+1)', 'x^10', '2^10',
    '7^a·7^b=7^6', '(2x^a)^b=32x^10', '\\sqrt[3]{8}', 'x=2\\pm\\sqrt{5}',
    '# 解析\n- 第一步移项\n所以 x=3。', '已知 $\\frac{1}{2}$ 与 3\\times4'
  ];
  for (const c of cases) {
    const once = T.normalize(c);
    assert.strictEqual(T.normalize(once), once, '非幂等: ' + JSON.stringify(c) + ' -> ' + JSON.stringify(once));
  }
});

test('空值安全：null / undefined / 数字 不抛错', () => {
  assert.strictEqual(T.normalize(null), '');
  assert.strictEqual(T.normalize(undefined), '');
  assert.strictEqual(T.normalize(0), '0');
});

/* ================================================================
 * 2. 单一实现（不许出现第二份）
 * ================================================================ */

console.log('\n--- 单一实现 ---');

test('CnmTextFmt.cleanMarkdown 与 normalize 是同一个函数', () => {
  assert.strictEqual(T.cleanMarkdown, T.normalize);
});

test('explain.js 是薄委托：源码内不再有清洗正则实现', () => {
  const src = fs.readFileSync(path.join(ROOT, 'diagnose', 'explain.js'), 'utf8');
  assert.ok(/T\.normalize\(text\)/.test(src), 'explain.js 应把 normalize 委托给 textfmt');
  assert.ok(src.indexOf('(pm|times|cdot|div') < 0, 'explain.js 不应保留 cleanLatex 的命令表实现');
  assert.ok(src.indexOf("'($1)/($2)'") < 0, 'explain.js 不应保留 \\frac 转换实现');
});

test('出题管线里没有第二份清洗实现', () => {
  for (const f of ['llm-gen.js', 'llm-gates.js', 'llm-variants.js', 'llm-recipes.js']) {
    const src = fs.readFileSync(path.join(ROOT, 'diagnose', f), 'utf8');
    assert.ok(!/function\s+cleanMarkdown\s*\(/.test(src), f + ' 不应定义 cleanMarkdown');
    assert.ok(!/function\s+cleanLatex\s*\(/.test(src), f + ' 不应定义 cleanLatex');
  }
});

test('懒加载顺序：textfmt.js 在 explain.js 之前', () => {
  const app = fs.readFileSync(path.join(ROOT, 'diagnose', 'app.js'), 'utf8');
  const m = /LAZY_EXPLAIN\s*=\s*\[([^\]]*)\]/.exec(app);
  assert.ok(m, '找不到 LAZY_EXPLAIN');
  const items = m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  assert.ok(items.indexOf('textfmt.js') >= 0, 'LAZY_EXPLAIN 应含 textfmt.js: ' + items.join(','));
  assert.ok(items.indexOf('textfmt.js') < items.indexOf('explain.js'), 'textfmt.js 必须排在 explain.js 前');
});

/* ================================================================
 * 3. 与验证层同口径：规范化后的题面仍可求值
 * ================================================================ */

console.log('\n--- 与验证层（llm-eval）同口径 ---');

test('x^4 规范化成 x⁴ 后，求值结果与 x^4 一致', () => {
  const caret = E.evaluateExpression('x^4-5x^2+4', [2]);
  const norm = E.evaluateExpression(T.normalize('x^4-5x^2+4'), [2]);
  assert.deepStrictEqual(norm, caret);
  assert.deepStrictEqual(norm, [0]);
});

test('x^10 → x¹⁰ 不丢幂次（NFKC 不会把它变成 x10）', () => {
  assert.deepStrictEqual(E.evaluateExpression(T.normalize('x^10'), [2]), [1024]);
});

test('方程根集验证：规范化前后同一判定', () => {
  const a = E.verifyEquationRoots('解方程 x^4-5x^2+4=0', '1，2');
  const b = E.verifyEquationRoots(T.normalize('解方程 x^4-5x^2+4=0'), '1，2');
  assert.deepStrictEqual(b, a);
  assert.strictEqual(b.ok, true, '规范化后仍应验证通过: ' + JSON.stringify(b));
});

test('门 2 能看见上标里的指数（x² 里的 2）', () => {
  /* numbersOf 未导出，用门 2 的行为间接断言：verify=17-15、答案 2，题面只有 x²里的 2 */
  const r = G.gateSubstitute(
    { prompt: '当 x=3 时，x²-6 的值是多少？', answer: '3', verify: '3*3-6', verifyType: 'numeric' },
    { verifyType: 'numeric', answerShape: 'number' }
  );
  assert.strictEqual(r.ok, true, '应通过: ' + JSON.stringify(r));
});

/* ================================================================
 * 4. 卡 C 管线：先规范化、再进七道门
 * ================================================================ */

console.log('\n--- 出题管线接上规范化 ---');

const RECIPE = {
  topicId: 'cnm_900',
  subject: 'math',
  answerShape: 'number',
  verifyType: 'numeric',
  description: '一元一次方程的解法',
  constraints: {
    difficulties: ['basic', 'standard'],
    syllabus: { route: 'desc-blacklist', denied: [], allowed: [] },
    noFigure: true
  }
};
const TOPIC = {
  id: 'cnm_900', name: '一元一次方程的解法', subject: 'math', grade: 7,
  chapter: '七年级上册 第3章 一元一次方程', description: '会移项、合并同类项',
  mastery_criteria: ['能把含未知数的项移到一边']
};
const CTX = {
  topic: TOPIC,
  vocabulary: [],
  existing: [],
  standards: [],
  corpus: G.buildIndex({ questions: [], topics: [] })
};

function cand(extra) {
  return JSON.stringify(Object.assign({
    prompt: '已知 x^2+11-3，当 x=3 时结果是多少？',
    answer: '17',
    explanation: '先算平方，再加 11 减 3。',
    verify: '3*3+11-3',
    verifyType: 'numeric',
    difficulty: 'basic'
  }, extra || {}));
}

function runOnce(content) {
  const pipe = GEN.createPipeline({ transport: () => Promise.resolve(content) });
  return pipe.gen(RECIPE, CTX, { seed: 'textfmt', difficulty: 'basic' });
}

(async function () {
  let r;
  try { r = await runOnce(cand()); } catch (e) { r = { ok: false, question: null, reason: 'throw:' + (e && e.message) }; }

  test('管线出的题：题面已规范化（无 ^、有 ²、无 LaTeX）', () => {
    assert.strictEqual(r.ok, true, '应出题成功: ' + JSON.stringify(r.reason));
    const q = r.question;
    assert.ok(q.prompt.indexOf('^') < 0, '题面不应残留 ^: ' + q.prompt);
    assert.ok(q.prompt.indexOf('x²') >= 0, '题面应是 x²: ' + q.prompt);
    assert.ok(q.prompt.indexOf('$') < 0 && q.prompt.indexOf('\\') < 0, '题面不应有 LaTeX: ' + q.prompt);
  });

  test('管线七道门仍在（规范化没有绕过门禁）', () => {
    assert.strictEqual(r.ok, true, JSON.stringify(r.reason));
    assert.deepStrictEqual(r.question.gates.map((c) => c.gate), G.GATE_NAMES);
  });

  /* 清洗会改文本 → 泄露判定必须按清洗后的文本重跑：
   * 原解析 "x=1**7**" 里没有连续的 "17"，剥掉 ** 之后才出现 → 必须被门 6 拦下。 */
  const leakPipe = GEN.createPipeline({
    transport: () => Promise.resolve(cand({ explanation: 'x=1**7**，所以答案是它。' }))
  });
  let lr;
  try { lr = await leakPipe.gen(RECIPE, CTX, { seed: 'textfmt-leak', difficulty: 'basic' }); }
  catch (e) { lr = { ok: true, question: {} }; }

  test('清洗后才泄露的答案会被门 6 拦下（规范化在门禁之前）', () => {
    assert.strictEqual(lr.ok, false, '** 剥离后答案 17 出现在解析里，应被拦下');
    const st = leakPipe.getStats();
    assert.ok((st.byGate.leak || 0) >= 1, '应记录到 leak 门拒绝: ' + JSON.stringify(st.byGate));
    assert.strictEqual(st.produced, 0);
  });

  test('源码顺序：先 normalizeCandidate 再 runGates', () => {
    const src = fs.readFileSync(path.join(ROOT, 'diagnose', 'llm-gen.js'), 'utf8');
    const a = src.indexOf('normalizeCandidate(parsed.candidate)');
    const b = src.indexOf('gates.runGates(cand, gateCtx)');
    assert.ok(a > 0, '找不到 normalizeCandidate(parsed.candidate)');
    assert.ok(b > 0, '找不到 gates.runGates(cand, gateCtx)');
    assert.ok(a < b, '规范化必须发生在门禁之前');
  });

  test('出题 prompt 里带回了纯文本约束', () => {
    const src = fs.readFileSync(path.join(ROOT, 'diagnose', 'llm-recipes.js'), 'utf8');
    assert.ok(/纯文本/.test(src), 'prompt 应有纯文本约束');
    assert.ok(/禁止 Markdown/.test(src), 'prompt 应禁 Markdown');
    assert.ok(/禁止 LaTeX/.test(src), 'prompt 应禁 LaTeX');
    assert.ok(/²/.test(src), 'prompt 应指明乘方写成上标');
  });

  /* ================================================================
   * 5. 口径回归：真实批次抽样（tmp/ 不在则 skip）
   * ================================================================ */

  console.log('\n--- 口径回归：真实批次 ---');
  const batchDir = findBatchDir();
  if (!batchDir) {
    skip('抽样规范化后 \\frac / $ = 0、^ 出现率 ≤ 1.1%', '找不到 tmp/llm-batch-*.json');
  } else {
    const qs = loadBatchQuestions(batchDir);
    test('抽样规范化后 \\frac / $ = 0、^ 出现率 ≤ 题库 1.1%（n=' + qs.length + '）', () => {
      assert.ok(qs.length > 0, '批次里没有题目');
      let caret = 0, frac = 0, dollar = 0;
      const bad = [];
      for (const q of qs) {
        const txt = T.normalize([q.prompt, q.explanation, q.answer].filter((x) => typeof x === 'string').join('\n'));
        if (txt.indexOf('\\frac') >= 0) frac++;
        if (txt.indexOf('$') >= 0) dollar++;
        if (/\^/.test(txt)) { caret++; bad.push(txt.match(/.{0,20}\^.{0,10}/)); }
      }
      assert.strictEqual(frac, 0, '仍有 \\frac 残留: ' + bad.join(' | '));
      assert.strictEqual(dollar, 0, '仍有 $ 残留');
      const rate = caret / qs.length;
      assert.ok(rate <= 0.011, '^ 出现率 ' + (rate * 100).toFixed(2) + '% 高于题库 1.1%: ' + bad.slice(0, 5).join(' | '));
    });
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed' + (skipped ? ', ' + skipped + ' skipped' : ''));
  process.exit(failed === 0 ? 0 : 1);
})();

/* ---------------- helpers ---------------- */

/** 找 llm-batch-*.json 所在目录：本 worktree 的 tmp/，或兄弟 worktree（卡 C）的 tmp/ */
function findBatchDir() {
  const cands = [path.join(ROOT, 'tmp')];
  try {
    const parent = path.dirname(ROOT);
    for (const d of fs.readdirSync(parent)) {
      if (d === path.basename(ROOT)) continue;
      cands.push(path.join(parent, d, 'tmp'));
    }
  } catch (e) { /* 忽略 */ }
  for (const d of cands) {
    try {
      const files = fs.readdirSync(d).filter((f) => /^llm-batch-.*\.json$/.test(f));
      if (files.length) return d;
    } catch (e) { /* 忽略 */ }
  }
  return null;
}

/** 读全部批次题，均分抽最多 50 道（确定性：不随机，同输入同样本） */
function loadBatchQuestions(dir) {
  const files = fs.readdirSync(dir).filter((f) => /^llm-batch-.*\.json$/.test(f)).sort();
  const all = [];
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      for (const q of (j.questions || [])) all.push(q);
    } catch (e) { /* 坏文件跳过 */ }
  }
  if (all.length <= 50) return all;
  const step = all.length / 50;
  const out = [];
  for (let i = 0; i < 50; i++) out.push(all[Math.floor(i * step)]);
  return out;
}
