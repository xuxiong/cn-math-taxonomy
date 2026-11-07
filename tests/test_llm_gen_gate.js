#!/usr/bin/env node
/* 卡 C（t_faca95d0）：LLM 出题管线「参数化 + 七道门禁」测试。
 *
 *   node tests/test_llm_gen_gate.js
 *
 * 全部离线：网关用 fake transport 注入（不碰 127.0.0.1:3000），断言不依赖真实网络。
 * 风格同 tests/test_llm_variants.js：同步 test() + asyncTests 队列，末尾汇总 passed/failed。
 *
 * 覆盖面
 *   1) 参数化：plan 条目 → 三字段配方；prompt 由 description / mastery_criteria / 现有题 id 与题面 /
 *      课标条目注入；construct / human-only / 未知 verifier 一律不出配方；现有题答案不得进 prompt。
 *   2) 确定性：同 (recipe, ctx, seed) → 请求体 JSON 字节相同；换 seed → 只有种子行变。
 *   3) 七道门：每门至少一条「必须拒绝」的构造用例（含 ok:null、漏根、换数、泄露、超纲、重复）。
 *   4) 管线：重试直到通过 / 3 次全废返回 null / 缓存池上限 / 拒因统计 / 落盘只许 tmp/。
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

const ROOT = path.resolve(__dirname, '..');
const R = require(path.join(ROOT, 'diagnose', 'llm-recipes.js'));
const G = require(path.join(ROOT, 'diagnose', 'llm-gates.js'));
const GEN = require(path.join(ROOT, 'diagnose', 'llm-gen.js'));
const EV = require(path.join(ROOT, 'diagnose', 'llm-eval.js'));

/* ================================================================
 * fixtures：一个 5 个知识点的迷你图（2 个 verify 目标 + 1 个后继 + 1 个先修 + 1 个同班同学）
 * ================================================================ */

const TOPICS = [
  { id: 'cnm_900', name: '一元一次方程的解法', subject: 'math', grade: 7,
    chapter: '七年级上册 第3章 一元一次方程', description: '会移项、合并同类项，解 ax+b=c 形式的方程。',
    mastery_criteria: ['能把含未知数的项移到一边', '能解 2x+3=11 这样的方程'] },
  { id: 'cnm_901', name: '配方法', subject: 'math', grade: 9,
    chapter: '九年级上册 第21章 一元二次方程', description: '把 x²+bx 配成完全平方式，需要加上的常数是 (b/2)²。',
    mastery_criteria: ['能求出配方所需常数', '能把一般式化为顶点式'] },
  { id: 'cnm_902', name: '一元二次方程的判别式', subject: 'math', grade: 9,
    chapter: '九年级上册 第21章 一元二次方程', description: '用 Δ=b²-4ac 判断根的个数。',
    mastery_criteria: ['能算出判别式', '能由 Δ 判断根的情况'] },
  { id: 'cnm_903', name: '二元一次方程组', subject: 'math', grade: 7,
    chapter: '七年级下册 第8章 二元一次方程组', description: '用代入消元法解方程组。',
    mastery_criteria: ['能消元', '能回代求另一个未知数'] },
  { id: 'cnm_904', name: '完全平方公式', subject: 'math', grade: 8,
    chapter: '八年级上册 第14章 整式的乘法与因式分解', description: '记住 (a+b)²=a²+2ab+b²。',
    mastery_criteria: ['能展开完全平方', '能识别完全平方式'] }
];

const QUESTIONS = [
  { id: 'cnm_900_q1', topicId: 'cnm_900', prompt: '解方程 2x+3=11' },
  { id: 'cnm_900_q2', topicId: 'cnm_900', prompt: '解方程 5x-4=16' },
  { id: 'cnm_901_q1', topicId: 'cnm_901', prompt: '要把 x²+6x 配成完全平方式，需要加上的常数是多少？' }
];

const VOCAB = TOPICS.map((t) => ({ topicId: t.id, name: t.name, subject: t.subject, grade: t.grade, chapter: t.chapter }));

/** plan 条目：verify + numeric-compare，descendants 只有 1 个（走黑名单路线） */
function planEntry(over) {
  return Object.assign({
    topicId: 'cnm_900',
    subject: 'math',
    strategy: 'verify',
    verifier: 'numeric-compare',
    gaps: ['no-numeric'],
    prereqClosure: [],
    descendants: ['cnm_903'],
    existing: ['cnm_900_q1', 'cnm_900_q2']
  }, over || {});
}

function ctxFor(entry, over) {
  const topic = TOPICS.find((t) => t.id === entry.topicId) || TOPICS[0];
  const existing = (entry.existing || []).map((id) => {
    const q = QUESTIONS.find((x) => x.id === id);
    return q ? { id: q.id, prompt: q.prompt } : null;
  }).filter(Boolean);
  return Object.assign({
    topic: topic,
    existing: existing,
    standards: [{ id: 'cms-2022:7.NA.03', confidence: 'exact', text: '能解一元一次方程' }],
    nameOf: (id) => (TOPICS.find((t) => t.id === id) || {}).name || '',
    vocabulary: VOCAB,
    corpus: { prompts: new Set(), skeletons: new Set() }
  }, over || {});
}

function recipeOf(entry) {
  const r = R.recipeFromPlanEntry(entry);
  assert.ok(r, 'recipe must exist for ' + entry.topicId);
  return r;
}

/** 合法候选（配 cnm_900 的 numeric 配方）：2x+3=11 → x=4 */
function goodCandidate(over) {
  return Object.assign({
    prompt: '解方程 2x+3=11（只填数值）',
    answer: '4',
    explanation: '先把 3 移到右边，再两边同除以 2。',
    verify: '(11-3)/2',
    verifyType: 'numeric',
    difficulty: 'standard'
  }, over || {});
}

/* ================================================================
 * 1. 参数化：plan 条目 → 三字段配方
 * ================================================================ */

console.log('\n--- 1. 参数化配方：plan 条目 → {答案形态, 验证函数, 约束} ---');

test('numeric-compare → 答案形态 number / 验证函数 numeric', () => {
  const r = recipeOf(planEntry());
  assert.strictEqual(r.answerShape, R.ANSWER_SHAPE.NUMBER);
  assert.strictEqual(r.verifyType, 'numeric');
  assert.ok(r.constraints.rubric.basic && r.constraints.rubric.advanced, 'rubric 三档必须齐');
});

test('equation → 答案形态 rootSet / 验证函数 equation', () => {
  const r = recipeOf(planEntry({ topicId: 'cnm_902', verifier: 'equation' }));
  assert.strictEqual(r.answerShape, R.ANSWER_SHAPE.ROOT_SET);
  assert.strictEqual(r.verifyType, 'equation');
});

test('completeSquare → 答案形态 number / 验证函数 completeSquare', () => {
  const r = recipeOf(planEntry({ topicId: 'cnm_901', verifier: 'completeSquare' }));
  assert.strictEqual(r.answerShape, R.ANSWER_SHAPE.NUMBER);
  assert.strictEqual(r.verifyType, 'completeSquare');
});

test('formParam → 答案形态 paramPair / 验证函数 formParam', () => {
  const r = recipeOf(planEntry({ verifier: 'formParam' }));
  assert.strictEqual(r.answerShape, R.ANSWER_SHAPE.PARAM_PAIR);
  assert.strictEqual(r.verifyType, 'formParam');
});

test('strategy=construct 不出配方（归卡 B）', () => {
  assert.strictEqual(R.recipeFromPlanEntry(planEntry({ strategy: 'construct', verifier: 'equation' })), null);
});

test('strategy=human-only 不出配方（choice 类不喂 LLM，O3 D9）', () => {
  assert.strictEqual(R.recipeFromPlanEntry(planEntry({ strategy: 'human-only' })), null);
});

test('未知 verifier 不出配方（fail-closed，不猜验证器）', () => {
  assert.strictEqual(R.recipeFromPlanEntry(planEntry({ verifier: 'some-magic-verifier' })), null);
});

test('gaps 含 no-challenge → 第一档难度是 advanced', () => {
  const r = recipeOf(planEntry({ gaps: ['no-challenge'] }));
  assert.strictEqual(r.constraints.difficulties[0], 'advanced');
});

test('descendants < 50 → 门 7 走黑名单路线', () => {
  const r = recipeOf(planEntry({ descendants: ['cnm_903'] }));
  assert.strictEqual(r.constraints.syllabus.route, 'desc-blacklist');
  assert.deepStrictEqual(r.constraints.syllabus.denied, ['cnm_903']);
});

test('descendants ≥ 50 → 门 7 改走同年级同章节白名单', () => {
  const many = Array.from({ length: 50 }, (_, i) => 'cnm_9' + (100 + i));
  const r = recipeOf(planEntry({ descendants: many }));
  assert.strictEqual(r.constraints.syllabus.route, 'grade-chapter-whitelist');
});

/* ================================================================
 * 2. 参数化 prompt：字段注入，零手写族文案
 * ================================================================ */

console.log('\n--- 2. 参数化 prompt：description / mastery / 现有题 id 与题面 / 课标注入 ---');

test('prompt 含 topic.description', () => {
  const entry = planEntry();
  const p = R.buildPrompt(recipeOf(entry), ctxFor(entry));
  const desc = TOPICS[0].description;
  assert.ok(p.system.indexOf(desc) >= 0, 'system 缺 description');
});

test('prompt 含 mastery_criteria 每一条', () => {
  const entry = planEntry();
  const p = R.buildPrompt(recipeOf(entry), ctxFor(entry));
  for (const c of TOPICS[0].mastery_criteria) assert.ok(p.system.indexOf(c) >= 0, '缺掌握标准: ' + c);
});

test('prompt 含现有题 id 与题面（防撞车）', () => {
  const entry = planEntry();
  const p = R.buildPrompt(recipeOf(entry), ctxFor(entry));
  for (const id of entry.existing) assert.ok(p.user.indexOf(id) >= 0, 'user 缺现有题 id: ' + id);
  assert.ok(p.user.indexOf('2x+3=11') >= 0, 'user 缺现有题题面');
});

test('prompt 不含任何现有题答案字段', () => {
  const entry = planEntry();
  const ctx = ctxFor(entry);
  ctx.existing = ctx.existing.map((q) => ({ id: q.id, prompt: q.prompt, answer: 'SECRET-ANSWER' }));
  const p = R.buildPrompt(recipeOf(entry), ctx);
  assert.ok(p.user.indexOf('SECRET-ANSWER') < 0 && p.system.indexOf('SECRET-ANSWER') < 0);
});

test('prompt 含课标条目 id 与原文', () => {
  const entry = planEntry();
  const p = R.buildPrompt(recipeOf(entry), ctxFor(entry));
  assert.ok(p.system.indexOf('cms-2022:7.NA.03') >= 0);
  assert.ok(p.system.indexOf('能解一元一次方程') >= 0);
});

test('黑名单路线：prompt 点名后继知识点，且不列禁止清单以外的点', () => {
  const entry = planEntry({ descendants: ['cnm_903'] });
  const p = R.buildPrompt(recipeOf(entry), ctxFor(entry));
  assert.ok(p.system.indexOf('二元一次方程组') >= 0, '应点名后继点');
  assert.ok(p.system.indexOf('完全平方公式') < 0, '不该点名闭包外的无关点');
});

test('白名单路线：prompt 只约束「同年级同章节」，不罗列 descendants', () => {
  const many = Array.from({ length: 60 }, (_, i) => 'cnm_9' + (100 + i));
  const entry = planEntry({ descendants: many });
  const p = R.buildPrompt(recipeOf(entry), ctxFor(entry));
  assert.ok(p.system.indexOf('同年级同章节') >= 0);
  assert.ok(p.system.indexOf('cnm_9100') < 0, '白名单路线不该把 descendants 塞进 prompt');
});

test('prompt 要求唯一数值答案与 verify 算式（数值题格式）', () => {
  const entry = planEntry();
  const p = R.buildPrompt(recipeOf(entry), ctxFor(entry));
  assert.ok(p.user.indexOf('只由题面中出现过的数字') >= 0);
  assert.ok(p.system.indexOf('不出带图题') >= 0);
});

test('prompt 里没有任何模型型号 / 网关地址 / key（fork 守卫口径）', () => {
  const entry = planEntry();
  const p = R.buildPrompt(recipeOf(entry), ctxFor(entry));
  const text = p.system + '\n' + p.user;
  assert.ok(!/https?:\/\//.test(text), 'prompt 不许出现 URL');
  assert.ok(!/sk-[A-Za-z0-9]{8,}/.test(text), 'prompt 不许出现 key');
  assert.ok(text.indexOf('127.0.0.1') < 0);
});

test('不同知识点 → 不同 prompt（参数化真的按字段变，不是同一段文案）', () => {
  const e1 = planEntry();
  const e2 = planEntry({ topicId: 'cnm_901', verifier: 'completeSquare' });
  const p1 = R.buildPrompt(recipeOf(e1), ctxFor(e1));
  const p2 = R.buildPrompt(recipeOf(e2), ctxFor(e2));
  assert.notStrictEqual(p1.system, p2.system);
  assert.ok(p2.system.indexOf('配方法') >= 0);
});

/* ================================================================
 * 3. 确定性：同 seed 同输入 → 字节相同
 * ================================================================ */

console.log('\n--- 3. 确定性：请求体可回放 ---');

test('同 (recipe, ctx, seed) → 请求体 JSON 字节相同', () => {
  const entry = planEntry();
  const recipe = recipeOf(entry);
  const ctx = ctxFor(entry);
  const a = JSON.stringify(GEN.buildRequestBody(recipe, ctx, { seed: 's-1', model: 'm', maxTokens: 1 }));
  const b = JSON.stringify(GEN.buildRequestBody(recipe, ctx, { seed: 's-1', model: 'm', maxTokens: 1 }));
  assert.strictEqual(a, b);
});

test('换 seed → 只有种子行变化，其余 prompt 不变', () => {
  const entry = planEntry();
  const recipe = recipeOf(entry);
  const ctx = ctxFor(entry);
  const a = GEN.buildRequestBody(recipe, ctx, { seed: 's-1', model: 'm' });
  const b = GEN.buildRequestBody(recipe, ctx, { seed: 's-2', model: 'm' });
  assert.notStrictEqual(JSON.stringify(a), JSON.stringify(b));
  assert.strictEqual(a.messages[0].content, b.messages[0].content);
  assert.ok(a.messages[1].content.indexOf('s-1') >= 0);
  assert.ok(b.messages[1].content.indexOf('s-2') >= 0);
});

test('默认 seed 由 (topic, difficulty, attempt) 派生，不含时间戳', () => {
  const s1 = GEN.defaultSeed('cnm_900', 'standard', 0);
  const s2 = GEN.defaultSeed('cnm_900', 'standard', 0);
  assert.strictEqual(s1, s2);
  assert.ok(/\d{10,}/.test(s1) === false, 'seed 不许是时间戳');
  assert.ok(s1.indexOf('cnm_900') === 0);
});

test('请求体 max_tokens 来自 llm-config（不是裸数字）', () => {
  const CFG = require(path.join(ROOT, 'diagnose', 'llm-config.js'));
  const body = GEN.buildRequestBody(recipeOf(planEntry()), ctxFor(planEntry()), { seed: 'x' });
  assert.strictEqual(body.max_tokens, CFG.maxTokens.variants);
});

/* ================================================================
 * 4. 门 1 schema
 * ================================================================ */

console.log('\n--- 4. 门 1 schema ---');

test('拒：多余字段（LLM 常把 id/type 塞回来）', () => {
  const r = G.gateSchema(goodCandidate({ id: 'x1' }));
  assert.strictEqual(r.ok, false);
  assert.ok(/unknown-field/.test(r.reason), r.reason);
});

test('拒：verifyType 不在枚举内', () => {
  const r = G.gateSchema(goodCandidate({ verifyType: 'magic' }));
  assert.strictEqual(r.ok, false);
  assert.ok(/unknown-verify-type/.test(r.reason), r.reason);
});

test('拒：answer 空白', () => {
  const r = G.gateSchema(goodCandidate({ answer: '   ' }));
  assert.strictEqual(r.ok, false);
  assert.ok(/missing-field:answer/.test(r.reason), r.reason);
});

test('拒：difficulty 不在三档内', () => {
  const r = G.gateSchema(goodCandidate({ difficulty: 'hardcore' }));
  assert.strictEqual(r.ok, false);
});

test('拒：题面超长（>400 字符）', () => {
  const r = G.gateSchema(goodCandidate({ prompt: 'x'.repeat(401) }));
  assert.strictEqual(r.ok, false);
  assert.ok(/too-long:prompt/.test(r.reason), r.reason);
});

/* ================================================================
 * 5. 门 2 代回验证
 * ================================================================ */

console.log('\n--- 5. 门 2 代回验证 ---');

test('通过：numeric 答案与 verify 算式一致', () => {
  const r = G.gateSubstitute(goodCandidate(), recipeOf(planEntry()));
  assert.strictEqual(r.ok, true, r.reason);
});

test('拒：numeric 答案与算式不符', () => {
  const r = G.gateSubstitute(goodCandidate({ verify: '(11-3)*2' }), recipeOf(planEntry()));
  assert.strictEqual(r.ok, false);
  assert.ok(/answer-mismatch/.test(r.reason), r.reason);
});

test('拒：verify 是纯字面量（自证 answer）', () => {
  const r = G.gateSubstitute(goodCandidate({ answer: '4', verify: '4' }), recipeOf(planEntry()));
  assert.strictEqual(r.ok, false);
  assert.ok(/not-an-expression/.test(r.reason), r.reason);
});

test('拒：verify 用了题面没有的数字', () => {
  const r = G.gateSubstitute(goodCandidate({ verify: '(12-4)/2' }), recipeOf(planEntry()));
  assert.strictEqual(r.ok, false);
  assert.ok(/verify-number-not-in-prompt:12/.test(r.reason), r.reason);
});

test('拒：verifyType 与配方不一致（配方数值题，交方程题）', () => {
  const r = G.gateSubstitute(goodCandidate({ verifyType: 'equation' }), recipeOf(planEntry()));
  assert.strictEqual(r.ok, false);
  assert.ok(/verify-type-mismatch/.test(r.reason), r.reason);
});

test('拒：ok === null 一律按拒处理（拦截器打桩到 validateLLMQuestion）', () => {
  const entry = planEntry({ verifier: 'equation', topicId: 'cnm_902' });
  const recipe = recipeOf(entry);
  const orig = EV.validateLLMQuestion;
  EV.validateLLMQuestion = () => ({ ok: null, reason: 'no-verify-type' });
  try {
    const r = G.gateSubstitute({ prompt: 'x²=4', answer: '2，-2', verifyType: 'equation', explanation: 'e' }, recipe);
    assert.strictEqual(r.ok, false);
    assert.ok(/substitute-failed/.test(r.reason), r.reason);
  } finally {
    EV.validateLLMQuestion = orig;
  }
});

test('拒：equation 根代回不成立', () => {
  const entry = planEntry({ verifier: 'equation', topicId: 'cnm_902' });
  const r = G.gateSubstitute({ prompt: '解方程 x²+6x-7=0', answer: '2，-8', verifyType: 'equation', explanation: 'e' }, recipeOf(entry));
  assert.strictEqual(r.ok, false);
});

/* ================================================================
 * 6. 门 3 解集完整
 * ================================================================ */

console.log('\n--- 6. 门 3 解集完整（补 verifyEquationRoots 不校验根数） ---');

const eqRecipe = () => recipeOf(planEntry({ verifier: 'equation', topicId: 'cnm_902' }));
const eqCand = (over) => Object.assign({
  prompt: '解方程 x²+6x-7=0', answer: '1，-7', explanation: '用因式分解可得。',
  verifyType: 'equation', difficulty: 'standard'
}, over || {});

test('通过：二次方程两根齐全且互异', () => {
  const r = G.gateRootSet(eqCand());
  assert.strictEqual(r.ok, true, r.reason);
});

test('拒：漏根（单根通过代回，但次数要求 2 根）', () => {
  const sub = G.gateSubstitute(eqCand({ answer: '1' }), eqRecipe());
  assert.strictEqual(sub.ok, true, ' ★ 代回门本身放行单根 —— 这正是缺口');
  const r = G.gateRootSet(eqCand({ answer: '1' }));
  assert.strictEqual(r.ok, false);
  assert.ok(/root-count:1!=2/.test(r.reason), r.reason);
});

test('拒：重根写成两次（1，1）', () => {
  const r = G.gateRootSet(eqCand({ prompt: '解方程 x²-2x+1=0', answer: '1，1' }));
  assert.strictEqual(r.ok, false);
  assert.ok(/repeated-root/.test(r.reason), r.reason);
});

test('通过：Δ=0 的方程给 1 个重根', () => {
  const r = G.gateRootSet(eqCand({ prompt: '解方程 x²-2x+1=0', answer: '1' }));
  assert.strictEqual(r.ok, true, r.reason);
});

test('拒：非方程类不适用（野 verifyType 混进方程门即拒）', () => {
  const r = G.gateRootSet({ verifyType: 'numeric', prompt: '1+1', answer: '2' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.reason, 'not-equation');
});

/* ================================================================
 * 7. 门 4 去重 / 门 5 换数
 * ================================================================ */

console.log('\n--- 7. 门 4 去重（全库/同批/缓存池） ---');

function ctxWith(sources) {
  const ctx = ctxFor(planEntry());
  for (const k of Object.keys(sources || {})) {
    ctx[k] = { prompts: new Set(sources[k].map(G.normText)), skeletons: new Set(sources[k].map(G.skeleton)) };
  }
  return ctx;
}

test('拒：与全库某题归一化后完全相同', () => {
  const ctx = ctxWith({ corpus: ['解方程 2x + 3 = 11（只填数值）'] });
  const r = G.gateDuplicate(goodCandidate(), ctx);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'duplicate:corpus');
});

test('拒：与同批已生成题相同', () => {
  const ctx = ctxWith({ batch: ['解方程2x+3=11(只填数值)'] });
  const r = G.gateDuplicate(goodCandidate(), ctx);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'duplicate:batch');
});

test('拒：与缓存池相同', () => {
  const ctx = ctxWith({ pool: ['解方程 2x+3=11（只填数值）'] });
  const r = G.gateDuplicate(goodCandidate(), ctx);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'duplicate:pool');
});

test('通过：三处都没有 → unique', () => {
  const r = G.gateDuplicate(goodCandidate(), ctxWith({ corpus: ['别的题'] }));
  assert.strictEqual(r.ok, true);
});

console.log('\n--- 8. 门 5 换数检测（抽掉数字后骨架相同即判重） ---');

test('skeleton：只有数字不同的两道题骨架相同', () => {
  assert.strictEqual(G.skeleton('解方程 2x+3=11'), G.skeleton('解方程 7x-9=33'));
});

test('拒：换数（题面只换了数字）', () => {
  const ctx = ctxWith({ corpus: ['解方程 9x+5=41'] });
  const r = G.gateRenumber(goodCandidate({ prompt: '解方程 4x-7=9（只填数值）' }), ctx);
  assert.strictEqual(r.ok, false);
  assert.ok(/renumber:corpus/.test(r.reason), r.reason);
});

test('拒：同批内换数', () => {
  const ctx = ctxWith({ batch: ['解方程 3x-1=8'] });
  const r = G.gateRenumber(goodCandidate({ prompt: '解方程 6x+2=20（只填数值）' }), ctx);
  assert.strictEqual(r.ok, false);
  assert.ok(/renumber:batch/.test(r.reason), r.reason);
});

test('通过：骨架不同（换了情境，不只是换数字）', () => {
  const ctx = ctxWith({ corpus: ['解方程 9x+5=41'] });
  const r = G.gateRenumber(goodCandidate({ prompt: '某数的 4 倍减去 7 等于 9，求这个数（只填数值）' }), ctx);
  assert.strictEqual(r.ok, true, r.reason);
});

/* ================================================================
 * 9. 门 6 泄露
 * ================================================================ */

console.log('\n--- 9. 门 6 泄露（checkLeak 口径） ---');

test('拒：解析首句直接写出 x=<根>', () => {
  const r = G.gateLeak(eqCand({ explanation: '所以 x=1，原方程成立。' }));
  assert.strictEqual(r.ok, false);
  assert.ok(/answer-in-first-clause/.test(r.reason), r.reason);
});

test('拒：解析出现「系数化为」', () => {
  const r = G.gateLeak(goodCandidate({ explanation: '先把系数化为 1，再求解。' }));
  assert.strictEqual(r.ok, false);
  assert.ok(/系数化为/.test(r.reason), r.reason);
});

test('通过：首句不含答案，讲解在后面才出现', () => {
  const r = G.gateLeak(goodCandidate({ explanation: '先把常数项移到右边。第二步两边同除以 2，得到 4。' }));
  assert.strictEqual(r.ok, true, r.reason);
});

/* ================================================================
 * 10. 门 7 超纲（复合判据）
 * ================================================================ */

console.log('\n--- 10. 门 7 超纲：黑名单 / 白名单 / fail-closed ---');

test('拒：黑名单路线命中后继知识点概念词', () => {
  const entry = planEntry({ descendants: ['cnm_903'] });
  const ctx = ctxFor(entry);
  const r = G.gateSyllabus(goodCandidate({ prompt: '用二元一次方程组的方法解 2x+3=11' }), recipeOf(entry), ctx);
  assert.strictEqual(r.ok, false);
  assert.ok(/descendant-term:二元一次方程组/.test(r.reason), r.reason);
  assert.strictEqual(r.route, 'desc-blacklist');
});

test('通过：黑名单路线没命中后继点', () => {
  const entry = planEntry({ descendants: ['cnm_903'] });
  const r = G.gateSyllabus(goodCandidate(), recipeOf(entry), ctxFor(entry));
  assert.strictEqual(r.ok, true, r.reason);
});

test('拒：白名单路线命中同年级但其它章节的概念', () => {
  const many = Array.from({ length: 60 }, (_, i) => 'cnm_9' + (100 + i));
  const entry = planEntry({ topicId: 'cnm_902', verifier: 'equation', descendants: many });
  const r = G.gateSyllabus(eqCand({ prompt: '先用完全平方公式展开，再解方程 x²+6x-7=0' }), recipeOf(entry), ctxFor(entry));
  assert.strictEqual(r.ok, false);
  assert.ok(/out-of-scope-term:完全平方公式/.test(r.reason), r.reason);
});

test('通过：白名单路线只碰同年级同章节', () => {
  const many = Array.from({ length: 60 }, (_, i) => 'cnm_9' + (100 + i));
  const entry = planEntry({ topicId: 'cnm_902', verifier: 'equation', descendants: many });
  const r = G.gateSyllabus(eqCand({ prompt: '用配方法解方程 x²+6x-7=0' }), recipeOf(entry), ctxFor(entry));
  assert.strictEqual(r.ok, true, r.reason);
});

test('拒：白名单算不出来（topic 缺 chapter）→ fail-closed', () => {
  const many = Array.from({ length: 60 }, (_, i) => 'cnm_9' + (100 + i));
  const entry = planEntry({ topicId: 'cnm_902', verifier: 'equation', descendants: many });
  const ctx = ctxFor(entry);
  ctx.topic = Object.assign({}, ctx.topic, { chapter: undefined });
  const r = G.gateSyllabus(eqCand(), recipeOf(entry), ctx);
  assert.strictEqual(r.ok, false);
  assert.ok(/fail-closed:no-chapter-data/.test(r.reason), r.reason);
});

test('2 字知识点名不进白名单匹配（避免「面积/比例」误报）', () => {
  const many = Array.from({ length: 60 }, (_, i) => 'cnm_9' + (100 + i));
  const entry = planEntry({ topicId: 'cnm_902', verifier: 'equation', descendants: many });
  const ctx = ctxFor(entry);
  ctx.vocabulary = ctx.vocabulary.concat([{ topicId: 'cnm_905', name: '面积', subject: 'math', grade: 9, chapter: '别的章节' }]);
  const r = G.gateSyllabus(eqCand({ prompt: '求这个图形的面积，已知 x²+6x-7=0' }), recipeOf(entry), ctx);
  assert.strictEqual(r.ok, true, r.reason);
});

/* ================================================================
 * 11. runGates：顺序 + 首个失败即停
 * ================================================================ */

console.log('\n--- 11. runGates：七门顺序执行 ---');

test('全通过 → 7 条 check，顺序固定', () => {
  const entry = planEntry();
  const r = G.runGates(goodCandidate(), { recipe: recipeOf(entry), topic: TOPICS[0], vocabulary: VOCAB, corpus: { prompts: new Set(), skeletons: new Set() } });
  assert.strictEqual(r.ok, true, r.reason);
  assert.deepStrictEqual(r.checks.map((c) => c.gate), G.GATE_NAMES);
});

test('首个失败的 gate 即停（schema 挂了不跑到 substitute）', () => {
  const entry = planEntry();
  const r = G.runGates(goodCandidate({ bogus: 1 }), { recipe: recipeOf(entry), topic: TOPICS[0], vocabulary: VOCAB });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.gate, 'schema');
  assert.strictEqual(r.checks.length, 1);
});

test('门 4 在门 2 之后：代回不成立时不会报 duplicate', () => {
  const entry = planEntry();
  const ctx = { recipe: recipeOf(entry), topic: TOPICS[0], vocabulary: VOCAB, corpus: { prompts: new Set([G.normText('解方程 2x+3=11（只填数值）')]), skeletons: new Set() } };
  const r = G.runGates(goodCandidate({ answer: '5', verify: '(11-3)/2' }), ctx);
  assert.strictEqual(r.gate, 'substitute');
});

/* ================================================================
 * 12. 管线：重试 / 全废 / 缓存池 / 统计 / 落盘
 * ================================================================ */

console.log('\n--- 12. 管线（fake transport，不出网） ---');

function pipelineWith(responses, opts) {
  let i = 0;
  const seen = [];
  const pipeline = GEN.createPipeline(Object.assign({
    now: () => 'T0',
    transport: (body, meta) => {
      seen.push(body);
      const r = responses[Math.min(i, responses.length - 1)];
      i++;
      return Promise.resolve(typeof r === 'function' ? r(body, meta) : r);
    }
  }, opts || {}));
  pipeline.seen = seen;
  return pipeline;
}

const entry900 = planEntry();

testAsync('第一次被门 5 拒、第二次通过 → attempts=2，拒因入统计', async () => {
  const first = goodCandidate({ prompt: '小明有 2 个苹果，又买了 3 个（只填数值）', answer: '5', verify: '2+3' });
  const p = pipelineWith([JSON.stringify(first), JSON.stringify(goodCandidate())]);
  const ctx = ctxFor(entry900);
  ctx.corpus = {
    prompts: new Set([G.normText(first.prompt)]),
    skeletons: new Set([G.skeleton(first.prompt)])
  };
  const r = await p.gen(recipeOf(entry900), ctx, { difficulty: 'standard' });
  assert.strictEqual(r.ok, true, r.reason);
  assert.strictEqual(r.attempts, 2);
  assert.strictEqual(p.getStats().byGate.duplicate, 1, JSON.stringify(p.getStats().byGate));
  assert.strictEqual(p.getStats().produced, 1);
});

testAsync('第一次被门 5（换数）拒、第二次通过：骨架门也会单独计数', async () => {
  const ctxBase = ctxFor(entry900);
  const ctx = Object.assign({}, ctxBase, {
    corpus: { prompts: new Set(), skeletons: new Set([G.skeleton('解方程 9x+5=41（只填数值）')]) }
  });
  const p = pipelineWith([
    JSON.stringify(goodCandidate({ prompt: '解方程 4x-7=9（只填数值）', answer: '4', verify: '(9+7)/4' })),
    JSON.stringify(goodCandidate({ prompt: '某数的 4 倍减去 7 等于 9，求这个数（只填数值）', answer: '4', verify: '(9+7)/4' }))
  ]);
  const r = await p.gen(recipeOf(entry900), ctx, { difficulty: 'standard' });
  assert.strictEqual(r.ok, true, r.reason);
  assert.strictEqual(r.attempts, 2);
  assert.strictEqual(p.getStats().byGate.renumber, 1, JSON.stringify(p.getStats().byGate));
});

testAsync('3 次全废 → 返回 null（降级题库），exhausted=1', async () => {
  const bad = JSON.stringify(goodCandidate({ answer: '999', verify: '(11-3)/2' }));
  const p = pipelineWith([bad]);
  const r = await p.gen(recipeOf(entry900), ctxFor(entry900), { difficulty: 'standard' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.question, null);
  assert.strictEqual(r.attempts, 3);
  assert.strictEqual(p.getStats().attempts, 3);
  assert.strictEqual(p.getStats().exhausted, 1);
  assert.strictEqual(p.getStats().byGate.substitute, 3);
});

testAsync('非 JSON 响应按 transport 拒，且不炸', async () => {
  const p = pipelineWith(['抱歉我不能出题']);
  const r = await p.gen(recipeOf(entry900), ctxFor(entry900), {});
  assert.strictEqual(r.ok, false);
  assert.strictEqual(p.getStats().byGate.transport, 3);
});

testAsync('产物标 variantSource=llm，且带七门结论', async () => {
  const p = pipelineWith([JSON.stringify(goodCandidate())]);
  const r = await p.gen(recipeOf(entry900), ctxFor(entry900), { difficulty: 'standard' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.question.variantSource, 'llm');
  assert.strictEqual(r.question.variant, true);
  assert.strictEqual(r.question.type, 'numeric');
  assert.deepStrictEqual(r.question.gates.map((c) => c.gate), G.GATE_NAMES);
});

testAsync('缓存池有上限（poolMax=2 时只留最近 2 道）', async () => {
  const cands = [
    ['A', 2, 5], ['B', 3, 6], ['C', 4, 7]
  ].map(([tag, a, b]) => JSON.stringify(goodCandidate({
    prompt: '情境' + tag + '：把 ' + a + ' 与 ' + b + ' 相加（只填数值）',
    answer: String(a + b), verify: a + '+' + b
  })));
  const p = pipelineWith(cands, { poolMax: 2 });
  for (let i = 0; i < 3; i++) {
    await p.gen(recipeOf(entry900), ctxFor(entry900), { difficulty: 'standard', seed: 'p' + i });
  }
  const pool = p.getPool('cnm_900');
  assert.ok(pool.length <= 2, 'pool 超上限: ' + pool.length);
  assert.strictEqual(p.getBatch().length, 3);
});

testAsync('同批第二道若与第一道换数 → 被门 5 挡下', async () => {
  const mk = (a) => JSON.stringify(goodCandidate({
    prompt: '小明有' + a + '个苹果，又买了3个（只填数值）',
    answer: String(a + 3), verify: a + '+3'
  }));
  const p = pipelineWith([mk(2), mk(7), mk(9)]);
  const ctx = ctxFor(entry900);
  const first = await p.gen(recipeOf(entry900), ctx, { difficulty: 'standard', seed: 'a' });
  assert.strictEqual(first.ok, true, first.reason);
  const second = await p.gen(recipeOf(entry900), ctx, { difficulty: 'standard', seed: 'b' });
  assert.strictEqual(second.ok, false, '第二道只换数，应被挡');
  assert.strictEqual(p.getStats().renumberHits.batch, 3);
});

testAsync('统计：按知识点/难度/学科/答案形态都有计数', async () => {
  const p = pipelineWith([JSON.stringify(goodCandidate())]);
  await p.gen(recipeOf(entry900), ctxFor(entry900), { difficulty: 'standard' });
  const s = p.getStats();
  assert.strictEqual(s.byTopic.cnm_900.produced, 1);
  assert.strictEqual(s.byDifficulty.standard.produced, 1);
  assert.strictEqual(s.bySubject.math.produced, 1);
  assert.strictEqual(s.byAnswerShape.number.produced, 1);
  assert.strictEqual(s.producedByAttempt[0], 1);
});

test('导出批次带 schema 与 variantSource，题目数一致', async () => {
  const p = pipelineWith([JSON.stringify(goodCandidate())]);
  await p.gen(recipeOf(entry900), ctxFor(entry900), { difficulty: 'standard' });
  const out = p.exportBatch({ plan: 'tmp/gap-plan.json' });
  assert.strictEqual(out.schema, GEN.BATCH_SCHEMA);
  assert.strictEqual(out.variantSource, 'llm');
  assert.strictEqual(out.count, 1);
  assert.strictEqual(out.questions.length, 1);
});

test('落盘守卫：拒绝 data/ 路径，接受 tmp/ 路径', () => {
  assert.throws(() => GEN.assertSafeOutPath('data/llm-batch.json'), /refusing to write/);
  assert.throws(() => GEN.assertSafeOutPath('questions.json'), /only be written under tmp/);
  assert.strictEqual(GEN.assertSafeOutPath('tmp/llm-batch.json'), 'tmp/llm-batch.json');
  assert.strictEqual(GEN.assertSafeOutPath('tmp/x/y.json'), 'tmp/x/y.json');
});

test('管线 constants：MAX_RETRIES=3 / POOL_MAX=50', () => {
  assert.strictEqual(GEN.MAX_RETRIES, 3);
  assert.strictEqual(GEN.POOL_MAX, 50);
});

/* ================================================================
 * 13. 索引
 * ================================================================ */

console.log('\n--- 13. 索引（全库 13335 题一次性预计算） ---');

test('buildIndex：题面与骨架都入索引，知识点词表可查', () => {
  const idx = G.buildIndex({ questions: QUESTIONS, topics: TOPICS });
  assert.strictEqual(idx.prompts.size, QUESTIONS.length);
  assert.ok(idx.skeletons.size >= 1);
  assert.strictEqual(idx.vocabulary.length, TOPICS.length);
  assert.ok(idx.prompts.has(G.normText(QUESTIONS[0].prompt)));
});

test('addToIndex：新题立刻参与同批去重', () => {
  const idx = G.emptyCorpus();
  G.addToIndex(idx, '解方程 2x+3=11（只填数值）');
  assert.ok(idx.prompts.has(G.normText('解方程2x+3=11(只填数值)')));
});

/* ================================================================
 * 汇总
 * ================================================================ */

(async () => {
  console.log('\n--- 12b. 异步断言 ---');
  for (const t of asyncTests) {
    try { await t.fn(); passed++; console.log('  ok   ' + t.name); }
    catch (e) { failed++; console.log('  FAIL ' + t.name + '\n       ' + (e && e.stack || e).split('\n').slice(0, 4).join('\n       ')); }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
