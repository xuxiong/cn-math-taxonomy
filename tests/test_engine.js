#!/usr/bin/env node
/* 诊断引擎测试：node tests/test_engine.js （无依赖，仅用 assert） */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const E = require('../diagnose/engine.js');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e).split('\n').slice(0, 4).join('\n       ')); }
}
const sorted = (it) => Array.from(it).sort();

/* ------------------------------------------------------------ 手造小图
 *   X(外部) <- F <- E <- C <---hard--- T
 *              F <- D <---hard--- T
 *              F <- B <---soft--- T
 *   Z 与 T 无关
 * topics 顺序：X F E C D B T Z（同级先修按此顺序出题）
 */
function mk(id, extra) {
  return Object.assign({
    id: id, name: id, external: false,
    diagnostic_question: { question: id + '?', answer: '1' }
  }, extra || {});
}
const smallTopics = [
  mk('X', { external: true, diagnostic_question: undefined }),
  mk('F'), mk('E'), mk('C'), mk('D'), mk('B'), mk('T'), mk('Z')
];
const smallDeps = [
  { topicId: 'F', prerequisiteId: 'X', strength: 'hard' },
  { topicId: 'E', prerequisiteId: 'F', strength: 'hard' },
  { topicId: 'C', prerequisiteId: 'E', strength: 'hard' },
  { topicId: 'D', prerequisiteId: 'F', strength: 'hard' },
  { topicId: 'B', prerequisiteId: 'F', strength: 'hard' },
  { topicId: 'T', prerequisiteId: 'B', strength: 'soft' },   // 故意把 soft 写在 hard 前面
  { topicId: 'T', prerequisiteId: 'D', strength: 'hard' },
  { topicId: 'T', prerequisiteId: 'C', strength: 'hard' }
];
const G = E.buildGraph(smallTopics, smallDeps);

function run(session, script) {
  // script: {id: 'correct'|'wrong'|'skip'} —— 按引擎的出题顺序作答，返回 [会话, 出题顺序]
  const asked = [];
  let s = session;
  for (let guard = 0; guard < 100; guard++) {
    const q = E.nextQuestion(G, s);
    if (!q) break;
    asked.push(q);
    assert.ok(script[q], '脚本里没有 ' + q + ' 的答案');
    s = E.applyAnswer(G, s, q, script[q]);
  }
  return [s, asked];
}

function assertTopological(order, graph) {
  const pos = new Map(order.map((id, i) => [id, i]));
  order.forEach((id) => {
    graph.prereqs[id].forEach((p) => {
      if (pos.has(p.id)) assert.ok(pos.get(p.id) < pos.get(id), p.id + ' 应排在 ' + id + ' 之前');
    });
  });
}

console.log('小型手造图（每个知识点只有一道题——回退模式：答错即薄弱）');

test('祖先子图：目标 + 全部祖先（含外部节点），不含无关点', () => {
  assert.deepStrictEqual(sorted(E.ancestors(G, 'T')), ['B', 'C', 'D', 'E', 'F', 'X']);
  assert.deepStrictEqual(sorted(E.ancestors(G, 'E')), ['F', 'X']);
  assert.deepStrictEqual(sorted(E.ancestors(G, 'X')), []);
  const sub = E.subgraph(G, ['T']);
  assert.deepStrictEqual(sorted(sub.nodes), ['B', 'C', 'D', 'E', 'F', 'T', 'X']);
});

test('拓扑序：每个先修都排在依赖它的点之前', () => {
  const sub = E.subgraph(G, ['T']);
  assertTopological(sub.nodes, G);
  assert.strictEqual(sub.nodes[0], 'X');
  assert.strictEqual(sub.nodes[sub.nodes.length - 1], 'T');
  const multi = E.subgraph(G, ['C', 'D']);
  assertTopological(multi.nodes, G);
  assert.deepStrictEqual(sorted(multi.nodes), ['C', 'D', 'E', 'F', 'X']);
});

test('先修按 hard 优先、再 soft', () => {
  assert.deepStrictEqual(G.prereqs.T.map((p) => p.id + ':' + p.strength), ['C:hard', 'D:hard', 'B:soft']);
});

test('第一题问目标本身', () => {
  const s = E.createSession(G, ['T']);
  assert.strictEqual(E.nextQuestion(G, s), 'T');
});

test('答对：该点及所有祖先（含外部）视为掌握并跳过', () => {
  let s = E.createSession(G, ['T']);
  s = E.applyAnswer(G, s, 'T', 'correct');
  assert.strictEqual(E.nextQuestion(G, s), null);
  ['B', 'C', 'D', 'E', 'F', 'X', 'T'].forEach((id) => assert.strictEqual(E.statusOf(s, id), 'mastered', id));
  assert.strictEqual(s.status.T.src, 'direct');
  assert.strictEqual(s.status.F.src, 'inferred');
  assert.strictEqual(E.statusOf(s, 'Z'), 'unknown');
  const sum = E.summarize(G, s);
  assert.deepStrictEqual(sum.weak, []);
  assert.deepStrictEqual(sum.roots, []);
  assert.deepStrictEqual(sum.path, []);
  assert.strictEqual(sum.asked, 1);
});

test('答错：回溯先修，hard 先于 soft，深度优先', () => {
  const s0 = E.createSession(G, ['T']);
  const [s, asked] = run(s0, { T: 'wrong', C: 'wrong', E: 'correct', D: 'correct', B: 'correct' });
  // T 错 -> 先修 C,D（hard，按文件顺序）再 B（soft）；C 错 -> 先问 C 的先修 E，再回到 D、B
  assert.deepStrictEqual(asked, ['T', 'C', 'E', 'D', 'B']);
  assert.strictEqual(E.nextQuestion(G, s), null);
});

test('答错后首个追问是 hard 先修，soft 排最后', () => {
  let s = E.createSession(G, ['T']);
  s = E.applyAnswer(G, s, 'T', 'wrong');
  assert.strictEqual(E.nextQuestion(G, s), 'C');
  s = E.applyAnswer(G, s, 'C', 'correct'); // C 对 -> E、F、X 掌握
  assert.strictEqual(E.nextQuestion(G, s), 'D');
  s = E.applyAnswer(G, s, 'D', 'correct');
  assert.strictEqual(E.nextQuestion(G, s), 'B');
});

test('「不会」(skip) 与答错等效', () => {
  const [a] = run(E.createSession(G, ['T']), { T: 'skip', C: 'skip', E: 'correct', D: 'correct', B: 'correct' });
  const [b] = run(E.createSession(G, ['T']), { T: 'wrong', C: 'wrong', E: 'correct', D: 'correct', B: 'correct' });
  assert.deepStrictEqual(a.status, b.status);
});

test('已判定的点不重复问；共享先修只问一次', () => {
  const [, asked] = run(E.createSession(G, ['T']), { T: 'wrong', C: 'wrong', E: 'wrong', F: 'correct', D: 'wrong', B: 'wrong' });
  assert.strictEqual(new Set(asked).size, asked.length);
  assert.deepStrictEqual(asked, ['T', 'C', 'E', 'F', 'D', 'B']);
});

test('题量上限生效，剩余标为未测', () => {
  const s0 = E.createSession(G, ['T'], { limit: 2 });
  const [s, asked] = run(s0, { T: 'wrong', C: 'wrong' });
  assert.deepStrictEqual(asked, ['T', 'C']);
  assert.strictEqual(E.nextQuestion(G, s), null);
  const sum = E.summarize(G, s);
  assert.strictEqual(sum.asked, 2);
  assert.strictEqual(sum.limitReached, true);
  assert.deepStrictEqual(sorted(sum.untested), ['B', 'D', 'E', 'F', 'X']);
  assert.deepStrictEqual(sorted(sum.weak), ['C', 'T']);
  // 根因 C：它的先修 E 还没测到，要标出来
  assert.deepStrictEqual(sum.roots.map((r) => r.id), ['C']);
  assert.deepStrictEqual(sum.roots[0].pendingPrereqs, ['E']);
});

test('limit 默认 16，limit=1 只问目标', () => {
  assert.strictEqual(E.DEFAULT_LIMIT, 16);
  assert.strictEqual(E.createSession(G, ['T']).limit, 16);
  const s0 = E.createSession(G, ['T'], { limit: 1 });
  const [, asked] = run(s0, { T: 'wrong' });
  assert.deepStrictEqual(asked, ['T']);
});

test('根因：薄弱且先修中没有薄弱点；路径为拓扑序且不含已掌握', () => {
  const [s] = run(E.createSession(G, ['T']), { T: 'wrong', C: 'wrong', E: 'correct', D: 'correct', B: 'correct' });
  const sum = E.summarize(G, s);
  assert.deepStrictEqual(sorted(sum.weak), ['C', 'T']);
  assert.deepStrictEqual(sum.roots.map((r) => r.id), ['C']);
  assert.deepStrictEqual(sum.path.map((p) => p.id), ['C', 'T']);
  assert.strictEqual(sum.path[0].isRoot, true);
  assert.strictEqual(sum.path[1].isTarget, true);
  assert.deepStrictEqual(sorted(sum.mastered), ['B', 'D', 'E', 'F', 'X']);
  assert.strictEqual(sum.finished, true);
  assert.strictEqual(sum.limitReached, false);
});

test('多个根因：路径含根因到目标之间所有未掌握点，拓扑序', () => {
  // T、C、E、D 薄弱；F 掌握 -> E、D 都是根因；B 掌握
  const [s] = run(E.createSession(G, ['T']), { T: 'wrong', C: 'wrong', E: 'wrong', F: 'correct', D: 'wrong', B: 'correct' });
  const sum = E.summarize(G, s);
  assert.deepStrictEqual(sorted(sum.roots.map((r) => r.id)), ['D', 'E']);
  assert.deepStrictEqual(sorted(sum.path.map((p) => p.id)), ['C', 'D', 'E', 'T']);
  assertTopological(sum.path.map((p) => p.id), G);
  sum.path.forEach((p) => assert.notStrictEqual(p.status, 'mastered'));
  assert.deepStrictEqual(sum.path.filter((p) => p.isRoot).map((p) => p.id).sort(), ['D', 'E']);
});

test('外部（小学）节点不出题；根因的外部先修单独标出', () => {
  const [s, asked] = run(E.createSession(G, ['T']), { T: 'wrong', C: 'wrong', E: 'wrong', F: 'wrong', D: 'wrong', B: 'wrong' });
  assert.ok(!asked.includes('X'));
  const sum = E.summarize(G, s);
  assert.deepStrictEqual(sum.roots.map((r) => r.id), ['F']);
  assert.deepStrictEqual(sum.roots[0].externalPrereqs, ['X']);
  assert.deepStrictEqual(sum.roots[0].pendingPrereqs, []);
  assert.deepStrictEqual(sum.untested, ['X']);
});

test('多目标：离目标最近的先问；答对一个即覆盖其余祖先目标', () => {
  const s0 = E.createSession(G, ['C', 'T', 'D']);
  assert.strictEqual(E.nextQuestion(G, s0), 'T');
  const s1 = E.applyAnswer(G, s0, 'T', 'correct');
  assert.strictEqual(E.nextQuestion(G, s1), null);
  assert.deepStrictEqual(E.summarize(G, s1).path, []);
});

test('多目标：互不相关的目标都会被问到', () => {
  const s0 = E.createSession(G, ['T', 'Z']);
  const [, asked] = run(s0, { T: 'correct', Z: 'correct' });
  assert.deepStrictEqual(sorted(asked), ['T', 'Z']);
});

test('直接作答的判定不会被推断覆盖', () => {
  let s = E.createSession(G, ['T']);
  s = E.applyAnswer(G, s, 'E', 'wrong');
  s = E.applyAnswer(G, s, 'T', 'correct');
  assert.strictEqual(E.statusOf(s, 'E'), 'weak');
  assert.strictEqual(E.statusOf(s, 'C'), 'mastered');
});

test('applyAnswer 不修改入参；replay 与逐步作答一致', () => {
  const s0 = E.createSession(G, ['T']);
  const snap = JSON.stringify(s0);
  const s1 = E.applyAnswer(G, s0, 'T', 'wrong');
  assert.strictEqual(JSON.stringify(s0), snap);
  const s2 = E.applyAnswer(G, s1, 'C', 'correct');
  const r = E.replay(G, ['T'], [{ id: 'T', result: 'wrong' }, { id: 'C', result: 'correct' }]);
  assert.deepStrictEqual(r, s2);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(s2)), s2); // 可序列化
  assert.throws(() => E.applyAnswer(G, s0, 'T', 'maybe'));
  assert.throws(() => E.createSession(G, ['nope']));
});

test('路径图布局：先修在上层，边不跨回', () => {
  const [s] = run(E.createSession(G, ['T']), { T: 'wrong', C: 'wrong', E: 'wrong', F: 'correct', D: 'wrong', B: 'correct' });
  const sum = E.summarize(G, s);
  const lay = E.layout(G, s, sum);
  const layer = Object.fromEntries(lay.nodes.map((n) => [n.id, n.layer]));
  lay.edges.forEach((e) => assert.ok(layer[e.from] < layer[e.to], e.from + '->' + e.to));
  assert.ok(lay.nodes.some((n) => n.id === 'T' && n.isTarget));
  assert.ok(lay.nodes.some((n) => n.id === 'E' && n.isRoot));
});


/* ------------------------------------------------------------ 两题判定（手造题库） */
console.log('两题判定');

const DIFFS = { b: 'basic', s: 'standard', a: 'advanced' };
function mq(topicId, n, diff, extra) {
  return Object.assign({
    id: topicId + '_q' + n, topicId: topicId, difficulty: DIFFS[diff] || diff, type: 'numeric',
    prompt: topicId + ' 第 ' + n + ' 题', answer: '1', explanation: '解析'
  }, extra || {});
}
// T 的先修：P1(hard) <- R，P2(hard)；每个知识点 4 题：q1 标准、q2 标准、q3 基础、q4 提高
const bankTopics = ['R', 'P1', 'P2', 'T'].map((id) => mk(id, { diagnostic_question: undefined }));
const bankDeps = [
  { topicId: 'P1', prerequisiteId: 'R', strength: 'hard' },
  { topicId: 'T', prerequisiteId: 'P1', strength: 'hard' },
  { topicId: 'T', prerequisiteId: 'P2', strength: 'hard' }
];
const bankQs = [];
['R', 'P1', 'P2', 'T'].forEach((id) => {
  bankQs.push(mq(id, 1, 's'), mq(id, 2, 's'), mq(id, 3, 'b'), mq(id, 4, 'a'));
});
const G2 = E.buildGraph(bankTopics, bankDeps, bankQs);

/** 按脚本作答：script[id] = [第一题结果, 第二题结果]；返回 [会话, 出过的 (知识点#第几题) 序列]。 */
function run2(session, script) {
  const seq = [];
  let s = session;
  for (let guard = 0; guard < 100; guard++) {
    const it = E.nextItem(G2, s);
    if (!it) break;
    seq.push(it.topicId + '#' + it.attempt);
    const r = script[it.topicId][it.attempt - 1];
    assert.ok(r, '脚本缺少 ' + it.topicId + ' 第 ' + it.attempt + ' 题');
    s = E.applyAnswer(G2, s, it.topicId, r);
  }
  return [s, seq];
}

test('题库：isTestable 看题库；有题库时 hasBank 为 true，回退模式为 false', () => {
  assert.strictEqual(G2.hasBank, true);
  assert.strictEqual(G.hasBank, false);
  assert.strictEqual(G2.bank.T.length, 4);
  assert.strictEqual(G.bank.T[0].type, 'legacy');
});

test('第一题答对 → 掌握，并推断祖先掌握；只问 1 题', () => {
  const [s, seq] = run2(E.createSession(G2, ['T']), { T: ['correct'] });
  assert.deepStrictEqual(seq, ['T#1']);
  ['T', 'P1', 'P2', 'R'].forEach((id) => assert.strictEqual(E.statusOf(s, id), 'mastered', id));
  assert.strictEqual(s.status.T.src, 'direct');
  assert.strictEqual(s.status.R.src, 'inferred');
});

test('第一题错 → 再出第二题（同一知识点），此时还没有结论、不回溯', () => {
  let s = E.createSession(G2, ['T']);
  s = E.applyAnswer(G2, s, 'T', 'wrong');
  assert.strictEqual(E.nextQuestion(G2, s), 'T');
  const it = E.nextItem(G2, s);
  assert.strictEqual(it.attempt, 2);
  assert.notStrictEqual(it.question.id, s.answers[0].qid);
  assert.strictEqual(s.status.T, undefined);
  assert.strictEqual(E.isUnconfirmed(s, 'T'), true);
});

test('错 + 错 → 薄弱，并向先修回溯（P1、P2 依次，再深入 R）', () => {
  const [s, seq] = run2(E.createSession(G2, ['T']), {
    T: ['wrong', 'skip'], P1: ['wrong', 'wrong'], R: ['correct'], P2: ['correct']
  });
  assert.deepStrictEqual(seq, ['T#1', 'T#2', 'P1#1', 'P1#2', 'R#1', 'P2#1']);
  assert.strictEqual(E.statusOf(s, 'T'), 'weak');
  assert.strictEqual(E.statusOf(s, 'P1'), 'weak');
  assert.strictEqual(E.statusOf(s, 'R'), 'mastered');
  const sum = E.summarize(G2, s);
  assert.deepStrictEqual(sum.roots.map((r) => r.id), ['P1']);
  assert.deepStrictEqual(sum.shaky, []);
});

test('错 + 对 → 不稳（shaky），且不向先修回溯', () => {
  const [s, seq] = run2(E.createSession(G2, ['T']), { T: ['wrong', 'correct'] });
  assert.deepStrictEqual(seq, ['T#1', 'T#2']);
  assert.strictEqual(E.statusOf(s, 'T'), 'shaky');
  assert.strictEqual(E.nextQuestion(G2, s), null);
  ['P1', 'P2', 'R'].forEach((id) => assert.strictEqual(E.statusOf(s, id), 'unknown', id));
  const sum = E.summarize(G2, s);
  assert.deepStrictEqual(sum.shaky, ['T']);
  assert.deepStrictEqual(sum.weak, []);
  assert.deepStrictEqual(sum.roots, []);
  assert.deepStrictEqual(sorted(sum.untested), ['P1', 'P2', 'R']);
  // 不稳的点要进学习路径
  assert.deepStrictEqual(sum.path.map((p) => [p.id, p.status]), [['T', 'shaky']]);
});

test('不稳的先修若同时被别处判为薄弱，路径含它及其后代', () => {
  const [s] = run2(E.createSession(G2, ['T']), {
    T: ['wrong', 'wrong'], P1: ['wrong', 'correct'], P2: ['wrong', 'wrong'], R: ['correct']
  });
  assert.strictEqual(E.statusOf(s, 'P1'), 'shaky');
  assert.strictEqual(E.statusOf(s, 'P2'), 'weak');
  const sum = E.summarize(G2, s);
  assert.deepStrictEqual(sum.roots.map((r) => r.id), ['P2']);
  assert.deepStrictEqual(sorted(sum.path.map((p) => p.id)), ['P1', 'P2', 'T']);
  assert.strictEqual(sum.path.find((p) => p.id === 'P1').status, 'shaky');
  assertTopological(sum.path.map((p) => p.id), G2);
});

test('第二题优先 basic；第一题已是 basic 时取同难度，没有就取最容易的剩余题', () => {
  const firstDiffs = new Set();
  for (let i = 0; i < 60; i++) {
    const s1 = E.applyAnswer(G2, E.createSession(G2, ['P2'], { seed: 'k' + i }), 'P2', 'wrong');
    const first = E.questionById(G2, s1.answers[0].qid);
    firstDiffs.add(first.difficulty);
    assert.notStrictEqual(first.difficulty, 'advanced', '有非 advanced 题时第一题不出 advanced');
    const second = E.nextItem(G2, s1).question;
    if (first.difficulty === 'standard') assert.strictEqual(second.id, 'P2_q3', '第二题应是唯一的 basic');
    else assert.strictEqual(second.difficulty, 'standard', '第一题是 basic 时没有别的 basic，取同级以上最容易的');
  }
  assert.ok(firstDiffs.has('standard') && firstDiffs.has('basic'), '随机应能抽到不同难度');
  // 没有 basic 时取同难度：标准×3 + 提高×1
  const topics3 = [mk('M', { diagnostic_question: undefined })];
  const qs3 = [mq('M', 1, 's'), mq('M', 2, 's'), mq('M', 3, 's'), mq('M', 4, 'a')];
  const G3 = E.buildGraph(topics3, [], qs3);
  for (let i = 0; i < 20; i++) {
    const s1 = E.applyAnswer(G3, E.createSession(G3, ['M'], { seed: i }), 'M', 'wrong');
    assert.strictEqual(E.nextItem(G3, s1).question.difficulty, 'standard');
  }
  // 第一题是 standard 且存在更容易的非 basic 题不可能（只有 3 档）；提高题只在没有其它选择时才出
  const qs4 = [mq('M', 1, 'a'), mq('M', 2, 'a')];
  const G4 = E.buildGraph(topics3, [], qs4);
  const s4 = E.applyAnswer(G4, E.createSession(G4, ['M'], { seed: 1 }), 'M', 'wrong');
  assert.strictEqual(E.nextItem(G4, s4).question.difficulty, 'advanced');
});

test('种子固定时选题确定；不同种子能得到不同选题', () => {
  const trace = (seed) => {
    const [s] = run2(E.createSession(G2, ['T'], { seed: seed }), {
      T: ['wrong', 'wrong'], P1: ['wrong', 'wrong'], R: ['wrong', 'wrong'], P2: ['wrong', 'wrong']
    });
    return s.answers.map((a) => a.qid).join(',');
  };
  assert.strictEqual(trace('abc'), trace('abc'));
  assert.strictEqual(trace(42), trace('42'));
  const variants = new Set();
  for (let i = 0; i < 40; i++) variants.add(trace('s' + i));
  assert.ok(variants.size > 5, '不同种子应产生不同的题目序列（得到 ' + variants.size + ' 种）');
  // 重放与逐步作答一致，题号也一致
  const [s2] = run2(E.createSession(G2, ['T'], { seed: 9 }), { T: ['wrong', 'correct'] });
  const r = E.replay(G2, ['T'], s2.answers, { seed: 9 });
  assert.deepStrictEqual(r, s2);
});

test('已出题避让：优先出没出过的题，全出过也不会卡住', () => {
  const avoid = ['T_q1', 'T_q2'];
  for (let i = 0; i < 40; i++) {
    const s0 = E.createSession(G2, ['T'], { seed: i, avoid: avoid });
    const first = E.nextItem(G2, s0).question;
    assert.ok(!avoid.includes(first.id), '第一题应避开出过的题：' + first.id);
  }
  const all = G2.bank.T.map((q) => q.id);
  const s1 = E.createSession(G2, ['T'], { seed: 1, avoid: all });
  const it = E.nextItem(G2, s1);
  assert.ok(it && all.includes(it.question.id));
  // 第二题：basic 优先于“没出过”——q3 是唯一 basic，即使它出过也还是 q3
  let hit = 0;
  for (let i = 0; i < 40; i++) {
    const s0 = E.createSession(G2, ['T'], { seed: i, avoid: ['T_q3'] });
    const a1 = E.nextItem(G2, s0).question;
    if (a1.difficulty !== 'standard') continue;
    const s2 = E.applyAnswer(G2, s0, 'T', 'wrong');
    assert.strictEqual(E.nextItem(G2, s2).question.id, 'T_q3');
    hit++;
  }
  assert.ok(hit > 5);
  // 同一次会话里不会重复出同一道题
  const [s3] = run2(E.createSession(G2, ['T']), { T: ['wrong', 'wrong'], P1: ['wrong', 'wrong'], P2: ['wrong', 'wrong'], R: ['wrong', 'wrong'] });
  const qids = s3.answers.map((a) => a.qid);
  assert.strictEqual(new Set(qids).size, qids.length);
});

test('题量上限按“题”计：2 题一个知识点；只答错第一题就到上限 → 暂按薄弱，标为未复测', () => {
  const [s, seq] = run2(E.createSession(G2, ['T'], { limit: 3 }), {
    T: ['wrong', 'wrong'], P1: ['wrong', 'wrong'], R: ['wrong', 'wrong'], P2: ['wrong', 'wrong']
  });
  assert.deepStrictEqual(seq, ['T#1', 'T#2', 'P1#1']);
  assert.strictEqual(s.answers.length, 3);
  assert.strictEqual(E.nextQuestion(G2, s), null);
  assert.strictEqual(E.statusOf(s, 'P1'), 'weak');
  const sum = E.summarize(G2, s);
  assert.deepStrictEqual(sum.unconfirmed, ['P1']);
  assert.strictEqual(sum.limitReached, true);
  assert.deepStrictEqual(sorted(sum.untested), ['P2', 'R']);
});

test('同一知识点只有一道题时：答错直接薄弱（无第二题）', () => {
  const G5 = E.buildGraph(bankTopics, bankDeps, [mq('T', 1, 's'), mq('P1', 1, 's'), mq('P2', 1, 's'), mq('R', 1, 's')]);
  let s = E.applyAnswer(G5, E.createSession(G5, ['T']), 'T', 'wrong');
  assert.strictEqual(E.statusOf(s, 'T'), 'weak');
  assert.strictEqual(E.nextQuestion(G5, s), 'P1');
});

test('applyAnswer 不修改入参（含 attempts）；答题记录带 qid 与用户答案', () => {
  const s0 = E.createSession(G2, ['T'], { seed: 5 });
  const snap = JSON.stringify(s0);
  const s1 = E.applyAnswer(G2, s0, 'T', 'wrong', { text: '42' });
  assert.strictEqual(JSON.stringify(s0), snap);
  assert.strictEqual(s1.answers[0].text, '42');
  assert.ok(/^T_q\d$/.test(s1.answers[0].qid));
  const snap1 = JSON.stringify(s1);
  E.applyAnswer(G2, s1, 'T', 'correct');
  assert.strictEqual(JSON.stringify(s1), snap1);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(s1)), s1);
});

test('判题（按题型）：choice 比字母，也接受选项文字；numeric 数值等价；short 精确匹配 + accept；self 自评', () => {
  const ch = { type: 'choice', answer: 'B', choices: [{ key: 'A', text: '1/2' }, { key: 'B', text: '-3' }, { key: 'C', text: '相切' }] };
  const j = (q, u) => E.judgeQuestion(q, u).verdict;
  assert.strictEqual(j(ch, 'B'), 'correct');
  assert.strictEqual(j(ch, ' b '), 'correct');
  assert.strictEqual(j(ch, '(B)'), 'correct');
  assert.strictEqual(j(ch, 'B.'), 'correct');
  assert.strictEqual(j(ch, 'A'), 'wrong');
  assert.strictEqual(j(ch, '-3'), 'correct');
  assert.strictEqual(j(ch, '－３'), 'correct');
  assert.strictEqual(j(ch, '1/2'), 'wrong');
  assert.strictEqual(j(ch, '相切'), 'wrong');
  assert.strictEqual(j(ch, 'E'), 'manual');
  assert.strictEqual(j(ch, '随便写'), 'manual');
  assert.strictEqual(j(ch, ''), 'manual');
  const num = { type: 'numeric', answer: '-1/2' };
  assert.strictEqual(j(num, '-0.5'), 'correct');
  assert.strictEqual(j(num, '－１/２'), 'correct');
  assert.strictEqual(j(num, '1/2'), 'wrong');
  const ord = { type: 'numeric', answer: '3，-2' };
  assert.strictEqual(j(ord, '3，-2'), 'correct');
  assert.strictEqual(j(ord, '3, -2'), 'correct');
  assert.strictEqual(j(ord, '-2，3'), 'wrong');       // 有序：顺序错
  assert.strictEqual(j(ord, '3'), 'wrong');
  const unord = { type: 'numeric', answer: '3，-2', unordered: true };
  assert.strictEqual(j(unord, '-2，3'), 'correct');
  assert.strictEqual(j(unord, '-2 和 3'), 'correct');
  assert.strictEqual(j(unord, '-2，4'), 'wrong');
  const sh = { type: 'short', answer: 'y=2x+1', accept: ['2x+1', 'f(x)=2x+1'] };
  assert.strictEqual(j(sh, 'y = 2x + 1'), 'correct');
  assert.strictEqual(j(sh, 'Y＝2X+1'), 'correct');
  assert.strictEqual(j(sh, 'f(x)=2x+1'), 'correct');
  assert.strictEqual(j(sh, 'y=1+2x'), 'manual');       // 等价写法无法可靠判断，交给自评
  const quad = { type: 'short', answer: '第三象限' };
  assert.strictEqual(j(quad, '第三象限'), 'correct');
  assert.strictEqual(j(quad, '第二象限'), 'manual');
  assert.strictEqual(j({ type: 'self', answer: '略' }, '略'), 'manual');
  assert.strictEqual(j({ type: 'legacy', answer: '3' }, '3.0'), 'correct');
});

test('PRNG：mulberry32 相同种子相同序列，输出在 [0,1)', () => {
  const a = E.mulberry32(123), b = E.mulberry32(123);
  for (let i = 0; i < 100; i++) { const x = a(); assert.strictEqual(x, b()); assert.ok(x >= 0 && x < 1); }
});

/* ------------------------------------------------------------ 答案规范化与判题 */
console.log('答案规范化与判题');

function verdict(user, ref) { return E.judgeAnswer(user, ref).verdict; }

test('规范化：全角转半角、去空格、中文标点、度', () => {
  assert.strictEqual(E.normalizeText('　１／２ '), '1/2');
  assert.strictEqual(E.normalizeText('90 度'), '90°');
  assert.strictEqual(E.normalizeText('－３，（２）'), '-3,(2)');
  assert.strictEqual(E.normalizeText('x²'), 'x^2');
  assert.strictEqual(E.normalizeText('A、B；C'), 'a,b;c');
  assert.strictEqual(E.normalizeText('答：60°。'), '60°');
});

test('分数与小数等价："１/２" vs "0.5"', () => {
  assert.strictEqual(verdict('１/２', '0.5'), 'correct');
  assert.strictEqual(verdict('0.5', '1/2'), 'correct');
  assert.strictEqual(verdict('2/4', '1/2'), 'correct');
  assert.strictEqual(verdict('-1/2', '-0.5'), 'correct');
  assert.strictEqual(verdict('－１／２', '-(1/2)'), 'correct');
  assert.strictEqual(verdict('1/3', '0.333'), 'wrong');
  assert.strictEqual(verdict('1又1/2', '3/2'), 'correct');
  assert.strictEqual(verdict('1 1/2', '1.5'), 'correct');
  assert.strictEqual(verdict('50%', '1/2'), 'correct');
  assert.strictEqual(verdict('3/5', '3/5'), 'correct');
  assert.strictEqual(verdict('3/5', '5/3'), 'wrong');
});

test('角度："90 度" vs "90°"', () => {
  assert.strictEqual(verdict('90 度', '90°'), 'correct');
  assert.strictEqual(verdict('90', '90°'), 'correct');
  assert.strictEqual(verdict('６０°', '60度'), 'correct');
  assert.strictEqual(verdict('50°', '60°'), 'wrong');
});

test('多个答案顺序无关："-3 和 -1/2" vs "-1/2，-3"', () => {
  assert.strictEqual(verdict('-3 和 -1/2', '-1/2，-3'), 'correct');
  assert.strictEqual(verdict('-1/2、-3', '-3 和 -1/2'), 'correct');
  assert.strictEqual(verdict('-3', '-3 和 -1/2'), 'wrong');
  assert.strictEqual(verdict('-3，-1/2，0', '-3 和 -1/2'), 'wrong');
  assert.strictEqual(verdict('x=3 或 x=2', 'x=2 或 x=3'), 'correct');
  assert.strictEqual(verdict('2,3', 'x=2 或 x=3'), 'correct');
  assert.strictEqual(verdict('3；3', '3；3'), 'correct');
});

test('带变量名的答案：x=… 可省略变量名，但 x、y 不能互换', () => {
  assert.strictEqual(verdict('3', 'x=3'), 'correct');
  assert.strictEqual(verdict('x=3', '3'), 'correct');
  assert.strictEqual(verdict('y=2，x=3', 'x=3，y=2'), 'correct');
  assert.strictEqual(verdict('3，2', 'x=3，y=2'), 'correct');
  assert.strictEqual(verdict('x=2，y=3', 'x=3，y=2'), 'wrong');
  assert.strictEqual(verdict('2，3', 'x=3，y=2'), 'wrong');
});

test('单位：别名等价，缺省单位放行，不同单位判错', () => {
  assert.strictEqual(verdict('12米', '12 m'), 'correct');
  assert.strictEqual(verdict('12', '12 m'), 'correct');
  assert.strictEqual(verdict('12 cm', '12 m'), 'wrong');
  assert.strictEqual(verdict('25 平方米', '25 m²'), 'correct');
  assert.strictEqual(verdict('1,000', '1000'), 'correct');
});

test('坐标等有括号的多值答案', () => {
  assert.strictEqual(verdict('（１，２）', '(1,2)'), 'correct');
  assert.strictEqual(verdict('(1, 2)', '(1,2)'), 'correct');
  assert.strictEqual(verdict('(2,1)', '(1,2)'), 'wrong');
  assert.strictEqual(verdict('(0.5,2)', '(1/2,2)'), 'correct');
});

test('无法可靠解析的答案（文字、代数式）：只在完全相同时判对，否则交给用户自评', () => {
  assert.strictEqual(verdict('相切', '相切'), 'correct');
  assert.strictEqual(verdict('相离', '相切'), 'manual');
  assert.strictEqual(verdict('y=2x+3', 'y=2x+3'), 'correct');
  assert.strictEqual(verdict('2x+3', 'y=2x+3'), 'correct');
  assert.strictEqual(verdict('y=3x+2', 'y=2x+3'), 'manual');
  assert.strictEqual(verdict('(x-2)^2-1', 'y=(x-2)²-1'), 'correct');
  assert.strictEqual(verdict('共 11 种', '共 11 种，每种有 6 个正方形'), 'manual');
  assert.strictEqual(verdict('', '3'), 'manual');
  assert.strictEqual(verdict('不知道', '3'), 'manual');
});

test('判题不抛异常：奇怪输入', () => {
  ['', ' ', '(', ')))', '1/0', '/', '--1', '1/2/3', '％', '😀', null, undefined, '１２３４５６７８９０１２３４５６７８９０/３'].forEach((u) => {
    ['3', '1/2', '相切', 'x=2 或 x=3', '', '(1,2)'].forEach((r) => {
      const v = E.judgeAnswer(u, r).verdict;
      assert.ok(['correct', 'wrong', 'manual'].includes(v));
    });
  });
});

/* ------------------------------------------------------------ 真实数据 */
console.log('真实数据');

const dataDir = path.join(__dirname, '..', 'data');
const topics = JSON.parse(fs.readFileSync(path.join(dataDir, 'topics.json'), 'utf8'));
const deps = JSON.parse(fs.readFileSync(path.join(dataDir, 'dependencies.json'), 'utf8'));
const stdFile = JSON.parse(fs.readFileSync(path.join(dataDir, 'cn-curriculum-standards.json'), 'utf8'));
const RG = E.buildGraph(topics, deps);
const formal = topics.filter((t) => !t.external);

function bfsAncestors(id) {
  const pre = new Map();
  deps.forEach((d) => { (pre.get(d.topicId) || pre.set(d.topicId, []).get(d.topicId)).push(d.prerequisiteId); });
  const seen = new Set();
  const q = [id];
  while (q.length) { (pre.get(q.shift()) || []).forEach((p) => { if (!seen.has(p)) { seen.add(p); q.push(p); } }); }
  return seen;
}

test('数据可加载：小学 216 + 初中 315 + 高中必修 143 + 选择性必修 128，没有外部节点；课标含第一学段', () => {
  const mathTopics = topics.filter((t) => String(t.id).startsWith('cnm_'));
  const mathDeps = deps.filter((d) => String(d.topicId).startsWith('cnm_'));
  assert.strictEqual(mathTopics.length, 802);
  assert.strictEqual(mathDeps.length, 1299);
  assert.strictEqual(topics.filter((t) => t.external).length, 0);
  assert.strictEqual(mathTopics.filter((t) => t.grade <= 6).length, 216);
  assert.strictEqual(mathTopics.filter((t) => t.grade >= 7 && t.grade <= 9).length, 315);
  assert.strictEqual(mathTopics.filter((t) => t.grade === 10 || t.grade === 11).length, 143);
  assert.strictEqual(mathTopics.filter((t) => t.grade >= 12).length, 128);
  assert.strictEqual(mathTopics.filter((t) => t.grade >= 10).length, 271);
  assert.ok(mathTopics.filter((t) => t.grade >= 10).every((t) => /^cnm_h\d{3,}$/.test(t.id)));
  assert.ok(formal.every((t) => E.isTestable(RG, t.id)));
  assert.ok(stdFile.items.length > 200);
  assert.ok(stdFile.items[0].id.indexOf('cms-2022:1.') === 0);
  assert.deepStrictEqual(mathTopics.map((t) => t.id + '\t' + t.name), topics.filter((t) => String(t.id).startsWith('cnm_')).map((t) => t.id + '\t' + t.name));
});

test('英语：小学 197、初中 180–260、高中 220–320，不与数学连边，非起点都有先修；整册按学科分开', () => {
  const enTopics = topics.filter((t) => String(t.id).startsWith('cne_'));
  const primary = enTopics.filter((t) => String(t.id).startsWith('cne_p'));
  const junior = enTopics.filter((t) => String(t.id).startsWith('cne_j'));
  const seniorEn = enTopics.filter((t) => String(t.id).startsWith('cne_h'));
  assert.strictEqual(primary.length, 197);
  assert.ok(junior.length >= 180 && junior.length <= 260, '初中英语知识点 ' + junior.length);
  assert.ok(seniorEn.length >= 220 && seniorEn.length <= 320, '高中英语知识点 ' + seniorEn.length);
  assert.strictEqual(enTopics.length, primary.length + junior.length + seniorEn.length);
  assert.ok(primary.every((t) => t.subject === 'english' && t.grade >= 3 && t.grade <= 6 && !t.external && (t.semester === '上' || t.semester === '下')));
  assert.ok(junior.every((t) => t.subject === 'english' && t.grade >= 7 && t.grade <= 9 && !t.external));
  assert.ok(junior.every((t) => (t.grade === 9 ? t.semester === '全' : t.semester === '上' || t.semester === '下')));
  assert.ok(seniorEn.every((t) => t.subject === 'english' && t.grade >= 10 && t.grade <= 16 && t.semester === '上' && !t.external));
  assert.ok(seniorEn.some((t) => t.name === '虚拟语气'));
  assert.ok(enTopics.every((t) => ['语音', '词汇', '语法', '日常表达', '读写'].includes(t.domain)));
  const enDeps = deps.filter((d) => String(d.topicId).startsWith('cne_'));
  assert.ok(deps.every((d) => String(d.topicId).startsWith('cne_') === String(d.prerequisiteId).startsWith('cne_')));
  const cross = enDeps.filter((d) => String(d.topicId).startsWith('cne_j') && String(d.prerequisiteId).startsWith('cne_p'));
  assert.ok(cross.length >= 1, '初中英语应链到小学英语');
  assert.ok(!cross.some((d) => String(d.prerequisiteId).startsWith('cnm_')));
  const crossH = enDeps.filter((d) => String(d.topicId).startsWith('cne_h') && String(d.prerequisiteId).startsWith('cne_j'));
  assert.ok(crossH.length >= 8, '高中英语应链到初中英语');
  assert.ok(enDeps.filter((d) => String(d.topicId).startsWith('cne_h')).every((d) => String(d.prerequisiteId).startsWith('cne_')));
  const pre = new Map();
  enDeps.forEach((d) => { (pre.get(d.topicId) || pre.set(d.topicId, []).get(d.topicId)).push(d); });
  enTopics.forEach((t) => {
    if (t.id === 'cne_p001') {
      assert.ok(t.root_reason);
      return;
    }
    assert.ok(pre.get(t.id) && pre.get(t.id).length >= 1, t.id + ' 没有先修');
    pre.get(t.id).forEach((d) => {
      const src = RG.byId[t.id];
      const dst = RG.byId[d.prerequisiteId];
      const ra = src.grade * 2 + (src.semester === '下' ? 1 : 0);
      const rb = dst.grade * 2 + (dst.semester === '下' ? 1 : 0);
      assert.ok(rb <= ra, t.id + ' 的先修更晚 ' + d.prerequisiteId);
    });
  });
  const math4 = E.gradeTargets(RG, '四上');
  const en4 = E.gradeTargets(RG, '四上', 'english');
  assert.ok(math4.ids.length > 0 && math4.ids.every((id) => id.startsWith('cnm_') && RG.byId[id].grade === 4 && RG.byId[id].semester === '上'));
  assert.ok(en4.ids.length > 0 && en4.ids.every((id) => id.startsWith('cne_p') && RG.byId[id].grade === 4 && RG.byId[id].semester === '上'));
  assert.deepStrictEqual(E.gradeTargets(RG, '四上').ids, E.gradeTargets(RG, '四上', 'math').ids);
  const en8 = E.gradeTargets(RG, '八上', 'english');
  assert.strictEqual(en8.label, '八年级上册');
  assert.ok(en8.ids.length > 0 && en8.ids.every((id) => id.startsWith('cne_j') && RG.byId[id].grade === 8 && RG.byId[id].semester === '上'));
  assert.ok(E.gradeTargets(RG, '八上').ids.every((id) => id.startsWith('cnm_')));
  const en9 = E.gradeTargets(RG, '九全', 'english');
  assert.strictEqual(en9.label, '九年级全一册');
  assert.ok(en9.ids.length > 0 && en9.ids.every((id) => id.startsWith('cne_j') && RG.byId[id].grade === 9 && RG.byId[id].semester === '全'));
  const enGrade9 = E.gradeTargets(RG, '九年级', 'english');
  assert.ok(enGrade9.volumes.indexOf('九全') >= 0 && enGrade9.ids.every((id) => id.startsWith('cne_')));
  const mathGrade9 = E.gradeTargets(RG, '九年级');
  assert.ok(mathGrade9.ids.length > 0 && mathGrade9.ids.every((id) => id.startsWith('cnm_') && RG.byId[id].semester !== '全'));
  assert.deepStrictEqual(
    E.parseChapter('八年级下册 第8单元 Have you read Treasure Island yet'),
    { volume: '八下', chapterNo: '第8单元', chapterName: 'Have you read Treasure Island yet', section: '' }
  );
  assert.deepStrictEqual(
    E.parseChapter('必修第一册 欢迎单元 Welcome Unit'),
    { volume: '必修一', chapterNo: '欢迎单元', chapterName: 'Welcome Unit', section: '' }
  );
  assert.deepStrictEqual(
    E.parseChapter('必修第一册 第1单元 Teenage Life'),
    { volume: '必修一', chapterNo: '第1单元', chapterName: 'Teenage Life', section: '' }
  );
  assert.deepStrictEqual(
    E.parseChapter('选择性必修第一册 第1单元 People of Achievement'),
    { volume: '选必一', chapterNo: '第1单元', chapterName: 'People of Achievement', section: '' }
  );
  assert.strictEqual(E.gradeTargets(RG, '必修一'), null);
  assert.strictEqual(E.gradeTargets(RG, '选择性必修第四册'), null);
  const enB1 = E.gradeTargets(RG, '必修一', 'english');
  assert.strictEqual(enB1.label, '必修一（必修第一册）');
  assert.ok(enB1.ids.length > 0 && enB1.ids.every((id) => id.startsWith('cne_h') && RG.byId[id].grade === 10));
  const enS1 = E.gradeTargets(RG, '选必一', 'english');
  assert.strictEqual(enS1.label, '选必一（选择性必修第一册）');
  assert.ok(enS1.ids.length > 0 && enS1.ids.every((id) => id.startsWith('cne_h') && RG.byId[id].grade === 13));
  assert.ok(E.gradeTargets(RG, '选必一').ids.every((id) => id.startsWith('cnm_')));
  assert.ok(E.gradeTargets(RG, '选择性必修第一册').ids.every((id) => id.startsWith('cnm_')));
  const enS4 = E.gradeTargets(RG, '选必四', 'english');
  assert.strictEqual(enS4.label, '选必四（选择性必修第四册）');
  assert.ok(enS4.ids.every((id) => id.startsWith('cne_h') && RG.byId[id].grade === 16));
  assert.strictEqual(E.subjectOf(enTopics[0]), 'english');
  assert.strictEqual(E.subjectOf(topics.find((t) => t.id === 'cnm_p001')), 'math');
  const ces = stdFile.items.filter((it) => String(it.id).startsWith('ces-2022:'));
  const ces3 = ces.filter((it) => String(it.id).indexOf('ces-2022:3.') === 0);
  assert.ok(ces.length >= 20 && ces3.length >= 20, '三级课标 ' + ces3.length);
  assert.ok(ces.every((it) => it.verbatim === false && it.page_or_ref === '待核'));
  const cesH = stdFile.items.filter((it) => String(it.id).startsWith('ces-2017:H.'));
  assert.ok(cesH.length >= 20, '高中英语课标 ' + cesH.length);
  assert.ok(cesH.every((it) => it.verbatim === false && it.page_or_ref === '待核'));
  assert.ok(cesH.some((it) => String(it.id).indexOf('ces-2017:H.B.') === 0));
  assert.ok(cesH.some((it) => String(it.id).indexOf('ces-2017:H.S.') === 0));
  assert.strictEqual(stdFile.english.senior.year, 2020);
});

test('真实数据：祖先集合与独立 BFS 一致（全部知识点）', () => {
  topics.forEach((t) => {
    assert.deepStrictEqual(sorted(E.ancestors(RG, t.id)), sorted(bfsAncestors(t.id)), t.id);
  });
});

test('真实数据：先修子图不含外部节点，初中目标能回到小学，拓扑序合法', () => {
  let sawPrimary = false;
  formal.forEach((t) => {
    const sub = E.subgraph(RG, [t.id]);
    assert.strictEqual(sub.nodes[sub.nodes.length - 1], t.id);
    assertTopological(sub.nodes, RG);
    assert.ok(sub.nodes.every((id) => !RG.byId[id].external));
    if (t.grade >= 7 && sub.nodes.some((id) => RG.byId[id].grade <= 6)) sawPrimary = true;
  });
  assert.ok(sawPrimary, '至少有一个初中或高中知识点的祖先里有小学知识点');
  const senior = formal.filter((t) => t.grade >= 10 && String(t.id).startsWith('cnm_'));
  assert.ok(senior.length === 271);
  assert.ok(senior.every((t) => E.subgraph(RG, [t.id]).nodes.length > 1), '高中知识点都有先修');
  assert.ok(senior.some((t) => E.subgraph(RG, [t.id]).nodes.some((id) => RG.byId[id].grade >= 7 && RG.byId[id].grade <= 9)),
    '至少有一个高中知识点的祖先里有初中知识点');
});

test('旧 id 别名：cnm_ext_* 已不在图中，resolveTargets 跳到小学正式知识点', () => {
  const aliases = JSON.parse(fs.readFileSync(path.join(dataDir, 'id-aliases.json'), 'utf8')).aliases;
  assert.strictEqual(Object.keys(aliases).length, 18);
  for (let i = 1; i <= 18; i++) {
    const key = 'cnm_ext_' + String(i).padStart(3, '0');
    assert.ok(!RG.byId[key], key + ' 不应再作为知识点');
    assert.ok(aliases[key] && aliases[key].name && aliases[key].targets.length);
    const ids = E.resolveTargets([key], aliases);
    assert.ok(ids.length >= 1 && ids.length === new Set(ids).size, key);
    ids.forEach((id) => {
      const t = RG.byId[id];
      assert.ok(t && t.grade <= 6 && !t.external, key + ' -> ' + id);
    });
    const s = E.createSession(RG, ids, { limit: 2 });
    assert.ok(ids.indexOf(E.nextQuestion(RG, s)) >= 0, key);
  }
  const mixed = E.resolveTargets(['cnm_ext_002', 'cnm_001'], aliases);
  assert.ok(mixed.indexOf('cnm_001') >= 0);
  assert.ok(mixed.some((id) => RG.byId[id].grade <= 6));
  assert.deepStrictEqual(E.resolveTargets(['nope'], aliases), ['nope']);
  assert.deepStrictEqual(E.resolveTargets(['cnm_221'], null), ['cnm_221']);
});

test('真实数据：cnm_221（配方法）——首问目标；答错后 hard 先修在前', () => {
  let s = E.createSession(RG, ['cnm_221']);
  assert.strictEqual(E.nextQuestion(RG, s), 'cnm_221');
  s = E.applyAnswer(RG, s, 'cnm_221', 'wrong');
  const prereqs = RG.prereqs.cnm_221;
  const firstHard = prereqs.find((p) => p.strength === 'hard').id;
  assert.strictEqual(E.nextQuestion(RG, s), firstHard);
});

test('真实数据：答对目标即跳过全部祖先', () => {
  const s = E.applyAnswer(RG, E.createSession(RG, ['cnm_221']), 'cnm_221', 'correct');
  assert.strictEqual(E.nextQuestion(RG, s), null);
  const anc = bfsAncestors('cnm_221');
  assert.ok(anc.size > 30);
  anc.forEach((id) => assert.strictEqual(E.statusOf(s, id), 'mastered', id));
});

// 简单可复现的伪随机数
function rng(seed) { let x = seed >>> 0; return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; }; }

/** 一致的“学生”：已掌握集合对祖先封闭。 */
function makeStudent(rand, p) {
  const known = new Set();
  topics.forEach((t) => {
    if (rand() < p) { known.add(t.id); bfsAncestorsCached(t.id).forEach((a) => known.add(a)); }
  });
  return known;
}
const ancCache = new Map();
function bfsAncestorsCached(id) { if (!ancCache.has(id)) ancCache.set(id, bfsAncestors(id)); return ancCache.get(id); }

function simulate(targets, known, limit) {
  let s = E.createSession(RG, targets, { limit: limit });
  const asked = [];
  for (let guard = 0; guard < 500; guard++) {
    const q = E.nextQuestion(RG, s);
    if (!q) break;
    asked.push(q);
    s = E.applyAnswer(RG, s, q, known.has(q) ? 'correct' : 'wrong');
  }
  return { s: s, asked: asked };
}

test('真实数据：一致的学生 + 无限题量 => 薄弱集合与根因精确还原', () => {
  const rand = rng(20261017);
  let cases = 0;
  for (let round = 0; round < 3; round++) {
    const known = makeStudent(rand, [0.04, 0.12, 0.3][round]);
    formal.forEach((t) => {
      const { s, asked } = simulate([t.id], known, 9999);
      cases++;
      assert.strictEqual(new Set(asked).size, asked.length, '不应重复出题 ' + t.id);
      assert.ok(asked.every((id) => !RG.byId[id].external));
      const sum = E.summarize(RG, s);
      const sub = E.subgraph(RG, [t.id]);
      const unknown = sub.nodes.filter((id) => E.isTestable(RG, id) && !known.has(id));
      assert.deepStrictEqual(sorted(sum.weak), sorted(unknown), '薄弱集合 ' + t.id);
      sum.mastered.forEach((id) => assert.ok(known.has(id), id + ' 被判掌握但学生不会'));
      const expectRoots = unknown.filter((id) => RG.prereqs[id].every((p) => !unknown.includes(p.id)));
      assert.deepStrictEqual(sorted(sum.roots.map((r) => r.id)), sorted(expectRoots), '根因 ' + t.id);
      // 路径：拓扑序、不含已掌握、覆盖所有薄弱点、含全部根因
      const pathIds = sum.path.map((p) => p.id);
      assertTopological(pathIds, RG);
      sum.path.forEach((p) => assert.notStrictEqual(p.status, 'mastered'));
      sum.weak.forEach((id) => assert.ok(pathIds.includes(id), '薄弱点应在路径中 ' + id));
      sum.roots.forEach((r) => assert.ok(pathIds.includes(r.id)));
      if (unknown.length) assert.strictEqual(pathIds[pathIds.length - 1], t.id);
      // 要么全对（1 题），要么 hard/soft 回溯
      if (known.has(t.id)) assert.strictEqual(asked.length, 1);
      assert.strictEqual(sum.finished, true);
      assert.strictEqual(sum.limitReached, false);
    });
  }
  assert.ok(cases >= 900);
});

test('真实数据：题量上限（8/12/20）永远不被突破，且仍满足根因/路径定义', () => {
  const rand = rng(7);
  [8, 12, 20].forEach((limit) => {
    const known = makeStudent(rand, 0.02);
    let capped = 0;
    formal.forEach((t) => {
      const { s, asked } = simulate([t.id], known, limit);
      assert.ok(asked.length <= limit);
      if (asked.length === limit) capped++;
      const sum = E.summarize(RG, s);
      assert.strictEqual(sum.asked, asked.length);
      sum.roots.forEach((r) => {
        assert.strictEqual(E.statusOf(s, r.id), 'weak');
        RG.prereqs[r.id].forEach((p) => assert.notStrictEqual(E.statusOf(s, p.id), 'weak'));
      });
      const pathIds = sum.path.map((p) => p.id);
      assertTopological(pathIds, RG);
      sum.path.forEach((p) => assert.notStrictEqual(p.status, 'mastered'));
      if (sum.limitReached) assert.ok(sum.untested.length > 0);
      const all = new Set(sum.mastered.concat(sum.weak, sum.untested));
      assert.strictEqual(all.size, s.order.length);
    });
    if (limit === 8) assert.ok(capped > 0, '应有触发上限的目标');
  });
});

test('真实数据：什么都不会的学生，在上限处停下，未测节点被标出', () => {
  const none = new Set();
  const { s, asked } = simulate(['cnm_221'], none, 12);
  assert.strictEqual(asked.length, 12);
  const sum = E.summarize(RG, s);
  assert.strictEqual(sum.limitReached, true);
  assert.ok(sum.untested.length > 0);
  assert.ok(sum.roots.length >= 1);
});

test('真实数据：整章作为目标——会的学生只需问“最末端”的目标', () => {
  const chapter = formal.filter((t) => t.chapter.startsWith('七上 第一章 '));
  const ids = chapter.map((t) => t.id);
  assert.ok(ids.length >= 5);
  const known = new Set(topics.map((t) => t.id));
  const { s, asked } = simulate(ids, known, 12);
  const idSet = new Set(ids);
  const maximal = ids.filter((id) => !ids.some((o) => o !== id && bfsAncestorsCached(o).has(id) && idSet.has(o)));
  assert.strictEqual(asked.length, maximal.length);
  ids.forEach((id) => assert.strictEqual(E.statusOf(s, id), 'mastered'));
  // 什么都不会：每个目标都会被问到或被标未测，不会漏
  const r = simulate(ids, new Set(), 20);
  const sum = E.summarize(RG, r.s);
  ids.forEach((id) => assert.ok(sum.weak.includes(id) || sum.untested.includes(id), id));
});

test('真实数据：replay 与 JSON 往返得到相同会话', () => {
  const known = makeStudent(rng(3), 0.1);
  const { s } = simulate(['cnm_232'], known, 12);
  const r = E.replay(RG, ['cnm_232'], s.answers, { limit: 12 });
  assert.deepStrictEqual(r, s);
  assert.deepStrictEqual(E.replay(RG, JSON.parse(JSON.stringify(s.targets)), JSON.parse(JSON.stringify(s.answers)), { limit: 12 }), s);
});

test('真实数据：路径图布局——所有边方向一致，节点不丢', () => {
  const { s } = simulate(['cnm_232'], new Set(), 12);
  const sum = E.summarize(RG, s);
  const lay = E.layout(RG, s, sum);
  const layer = Object.fromEntries(lay.nodes.map((n) => [n.id, n.layer]));
  lay.edges.forEach((e) => assert.ok(layer[e.from] < layer[e.to]));
  sum.path.forEach((p) => assert.ok(layer[p.id] !== undefined));
  assert.ok(layer.cnm_232 === lay.layers - 1);
});

test('真实数据：诊断题答案能被自己的判题器接受（判对率检查）', () => {
  let bad = [];
  formal.forEach((t) => {
    const a = t.diagnostic_question.answer;
    if (E.judgeAnswer(a, a).verdict !== 'correct') bad.push(t.id);
  });
  assert.deepStrictEqual(bad, []);
});

test('真实数据：章节名可解析', () => {
  formal.forEach((t) => {
    const c = E.parseChapter(t.chapter);
    assert.ok(c.volume && c.chapterNo && c.chapterName, t.chapter);
  });
});

/* ------------------------------------------------------------ 题库数据（data/questions.json） */
console.log('题库数据');

const questions = JSON.parse(fs.readFileSync(path.join(dataDir, 'questions.json'), 'utf8'));
const RGQ = E.buildGraph(topics, deps, questions);
const qByTopic = {};
questions.forEach((q) => { (qByTopic[q.topicId] = qByTopic[q.topicId] || []).push(q); });
const NUM_RE = /^-?\d+(\.\d+)?(\/\d+(\.\d+)?)?$/;

test('题库：每个正式知识点至少 3 题；id 唯一且格式正确；外部节点无题；含 basic 与 standard', () => {
  const ids = new Set();
  questions.forEach((q) => {
    assert.ok(!ids.has(q.id), '重复 id ' + q.id);
    ids.add(q.id);
    assert.ok(new RegExp('^' + q.topicId + '_q[1-9]\\d*$').test(q.id), q.id);
    assert.ok(RG.byId[q.topicId] && !RG.byId[q.topicId].external, q.id + ' 的 topicId 无效');
  });
  formal.forEach((t) => {
    const qs = qByTopic[t.id] || [];
    assert.ok(qs.length >= 3, t.id + ' 只有 ' + qs.length + ' 题');
    const ds = new Set(qs.map((q) => q.difficulty));
    assert.ok(ds.has('basic') && ds.has('standard'), t.id + ' 缺少 basic 或 standard');
    assert.ok(qs.some((q) => q.id === t.id + '_q1'), t.id + ' 缺 q1');
    assert.ok(qs.filter((q) => q.id !== t.id + '_q1').some((q) => q.difficulty === 'basic'), t.id + ' 除 q1 外没有 basic');
  });
});

test('题库：type / difficulty 合法；必填字段非空；numeric + choice 占 60% 以上', () => {
  let auto = 0;
  questions.forEach((q) => {
    assert.ok(['numeric', 'choice', 'short', 'self'].includes(q.type), q.id);
    assert.ok(['basic', 'standard', 'advanced'].includes(q.difficulty), q.id);
    ['prompt', 'answer', 'explanation'].forEach((f) => assert.ok(typeof q[f] === 'string' && q[f].trim(), q.id + ' ' + f));
    if (q.type === 'numeric' || q.type === 'choice') auto++;
  });
  assert.ok(auto / questions.length >= 0.6, 'numeric+choice 占比 ' + (auto / questions.length));
});

test('题库：带 figure 的题是可解析的内联 SVG，不引用外网；图形选项不把名称写进图', () => {
  let n = 0;
  questions.forEach((q) => {
    const blobs = [];
    if (q.figure != null) blobs.push(['题干', q.figure]);
    (q.choices || []).forEach((c) => { if (c.figure != null) blobs.push(['选项' + c.key, c.figure]); });
    if (!blobs.length && q.hideChoiceText == null) return;
    n++;
    if (q.hideChoiceText != null) {
      assert.strictEqual(q.hideChoiceText, true, q.id);
      assert.strictEqual(q.type, 'choice', q.id);
      q.choices.forEach((c) => {
        assert.ok(c.figure, q.id + ' 选项 ' + c.key + ' 缺少图');
        assert.ok(!c.text || c.figure.indexOf(c.text) < 0, q.id + ' 图中写出了名称 ' + c.text);
      });
    }
    blobs.forEach((pair) => {
      const svg = pair[1];
      assert.strictEqual(typeof svg, 'string', q.id + pair[0]);
      assert.ok(svg.indexOf('<svg') === 0 && svg.indexOf('viewBox=') > 0, q.id + ' ' + pair[0] + ' 不是带 viewBox 的 svg');
      assert.ok(!/<\s*script|foreignObject|<\s*image\b/i.test(svg), q.id + ' 图含不允许的标签');
      const probe = svg.replace('xmlns="http://www.w3.org/2000/svg"', '');
      assert.ok(!/https?:\/\//i.test(probe), q.id + ' 图引用了外网');
      assert.ok(!/url\(\s*(?!#)/i.test(svg), q.id + ' 图有外部 url()');
    });
  });
  assert.ok(n >= 80, '带图的题太少：' + n);
});

test('题库：choice 题有 3–4 个选项、key 不重复、answer 是某个选项的 key', () => {
  let n = 0;
  questions.filter((q) => q.type === 'choice').forEach((q) => {
    n++;
    assert.ok(Array.isArray(q.choices) && q.choices.length >= 3 && q.choices.length <= 4, q.id);
    const keys = q.choices.map((c) => c.key);
    assert.strictEqual(new Set(keys).size, keys.length, q.id + ' key 重复');
    assert.ok(keys.includes(q.answer), q.id + ' answer 不在选项里');
    assert.strictEqual(new Set(q.choices.map((c) => c.text.trim())).size, keys.length, q.id + ' 选项文字重复');
  });
  assert.ok(n > 100);
});

test('题库：numeric 题的 answer 能被解析为数（整数/小数/分数/负数，多个答案用「，」分隔）', () => {
  let n = 0;
  questions.filter((q) => q.type === 'numeric').forEach((q) => {
    n++;
    const parts = q.answer.split(/[，,]/).map((x) => x.replace(/\s/g, ''));
    parts.forEach((x) => assert.ok(NUM_RE.test(x), q.id + ' answer=' + q.answer));
    if (q.unordered) assert.ok(parts.length > 1, q.id + ' unordered 但只有一个答案');
  });
  assert.ok(n > 500);
});

test('英语题：自包含、不引用课标或上一题，答案能被判对', () => {
  const enQs = questions.filter((q) => String(q.topicId).startsWith('cne_'));
  const juniorTopics = topics.filter((t) => String(t.id).startsWith('cne_j')).length;
  assert.ok(enQs.length >= 197 * 4 + juniorTopics * 3, '英语题 ' + enQs.length);
  enQs.forEach((q) => {
    assert.ok(!/^(同一|上题|该题|同上)/.test(String(q.prompt).trim()), q.id);
    assert.ok(!/本知识点|课标|是否要求/.test(q.prompt), q.id);
    assert.ok(q.type === 'numeric' || q.type === 'choice', q.id);
    const verdict = E.judgeQuestion(q, q.type === 'choice' ? q.answer : q.answer).verdict;
    assert.strictEqual(verdict, 'correct', q.id);
  });
});

test('题库：q1 由 diagnostic_question 迁移（题干以原题开头，或标注了 fixed_from_source）', () => {
  formal.forEach((t) => {
    const q1 = qByTopic[t.id].find((q) => q.id === t.id + '_q1');
    assert.ok(q1.prompt.startsWith(t.diagnostic_question.question) || q1.fixed_from_source, t.id);
  });
});

test('题库：判题器接受每道题自己的参考答案（self 一律自评）', () => {
  const bad = [];
  questions.forEach((q) => {
    const v = E.judgeQuestion(q, q.type === 'choice' ? q.answer : q.answer).verdict;
    const want = q.type === 'self' ? 'manual' : 'correct';
    if (v !== want) bad.push(q.id + ':' + v);
    if (q.type === 'choice') {
      const text = q.choices.find((c) => c.key === q.answer).text;
      // 选项文字本身是单个字母（如 x、D）时和选项字母无法区分，按字母处理；界面里选择题是点选项，不受影响
      if (!/^[A-Za-z]$/.test(text.trim()) && E.judgeQuestion(q, text).verdict !== 'correct') bad.push(q.id + ':text');
      q.choices.filter((c) => c.key !== q.answer).forEach((c) => {
        if (E.judgeQuestion(q, c.key).verdict !== 'wrong') bad.push(q.id + ':wrong-' + c.key);
      });
    }
    if (q.type === 'numeric' && !q.unordered && E.judgeQuestion(q, '999999').verdict === 'correct') bad.push(q.id + ':999999');
  });
  assert.deepStrictEqual(bad.slice(0, 20), []);
});

test('带题库的图：每个正式知识点可测、外部节点不可测；hasBank 为 true', () => {
  assert.strictEqual(RGQ.hasBank, true);
  assert.ok(formal.every((t) => E.isTestable(RGQ, t.id)));
  assert.ok(topics.filter((t) => t.external).every((t) => !E.isTestable(RGQ, t.id)));
});

console.log('带题库的真实诊断');

/** 学生：known 一次答对；flaky 第一题错第二题对；其余两题都错 */
function simulateBank(targets, known, flaky, limit, seed) {
  let s = E.createSession(RGQ, targets, { limit: limit, seed: seed == null ? 'sim' : seed });
  const asked = [];
  for (let guard = 0; guard < 2000; guard++) {
    const it = E.nextItem(RGQ, s);
    if (!it) break;
    asked.push(it.topicId + '#' + it.attempt);
    let r = 'wrong';
    if (known.has(it.topicId)) r = 'correct';
    else if (flaky.has(it.topicId)) r = it.attempt === 1 ? 'wrong' : 'correct';
    s = E.applyAnswer(RGQ, s, it.topicId, r);
  }
  return { s: s, asked: asked };
}

test('小学回溯：答错初中「正数与负数」会问到小学，学习路径按年级从低到高', () => {
  const { s, asked } = simulateBank(['cnm_001'], new Set(), new Set(), 80, 'primary');
  const ids = asked.map((x) => x.split('#')[0]);
  assert.ok(ids.indexOf('cnm_001') >= 0);
  assert.ok(ids.filter((id) => id === 'cnm_001').length <= 2);
  assert.ok(ids.some((id) => RGQ.byId[id].grade === 6), '应问到六年级');
  assert.ok(ids.some((id) => RGQ.byId[id].grade === 1), '应继续问到一年级');
  const per = {};
  ids.forEach((id) => { per[id] = (per[id] || 0) + 1; });
  Object.keys(per).forEach((id) => assert.ok(per[id] <= 2, id + ' 超过 2 题'));
  const sum = E.summarize(RGQ, s);
  const ranks = sum.path.map((p) => E.gradeRank(RGQ, p.id));
  for (let i = 1; i < ranks.length; i++) {
    assert.ok(ranks[i] >= ranks[i - 1], '路径应按年级从低到高：' + sum.path[i - 1].id + ' -> ' + sum.path[i].id);
  }
  assert.ok(sum.path.some((p) => RGQ.byId[p.id].grade <= 6));
  assert.strictEqual(sum.path[sum.path.length - 1].id, 'cnm_001');
  assertTopological(sum.path.map((p) => p.id), RGQ);
});

test('带题库：一致的学生 + 无限题量 => 薄弱集合与根因精确还原；会的 1 题、不会的 2 题', () => {
  const rand = rng(20261018);
  let cases = 0;
  for (let round = 0; round < 3; round++) {
    const known = makeStudent(rand, [0.04, 0.12, 0.3][round]);
    formal.forEach((t) => {
      const { s, asked } = simulateBank([t.id], known, new Set(), 9999);
      cases++;
      const sum = E.summarize(RGQ, s);
      const sub = E.subgraph(RGQ, [t.id]);
      const unknown = sub.nodes.filter((id) => E.isTestable(RGQ, id) && !known.has(id));
      assert.deepStrictEqual(sorted(sum.weak), sorted(unknown), '薄弱集合 ' + t.id);
      assert.deepStrictEqual(sum.shaky, []);
      assert.deepStrictEqual(sum.unconfirmed, []);
      sum.mastered.forEach((id) => assert.ok(known.has(id), id + ' 被判掌握但学生不会'));
      const expectRoots = unknown.filter((id) => RGQ.prereqs[id].every((p) => !unknown.includes(p.id)));
      assert.deepStrictEqual(sorted(sum.roots.map((r) => r.id)), sorted(expectRoots), '根因 ' + t.id);
      const perTopic = {};
      asked.forEach((a) => { const id = a.split('#')[0]; perTopic[id] = (perTopic[id] || 0) + 1; });
      Object.keys(perTopic).forEach((id) => assert.strictEqual(perTopic[id], known.has(id) ? 1 : 2, id));
      const pathIds = sum.path.map((p) => p.id);
      assertTopological(pathIds, RGQ);
      sum.weak.forEach((id) => assert.ok(pathIds.includes(id), '薄弱点应在路径中 ' + id));
      assert.strictEqual(sum.finished, true);
    });
  }
  assert.ok(cases >= 900);
});

test('带题库：任何一个知识点“第一题错、第二题对” => 不稳、只问 2 题、不回溯先修、进学习路径', () => {
  let withPrereq = 0;
  formal.forEach((t) => {
    const { s, asked } = simulateBank([t.id], new Set(), new Set([t.id]), 9999);
    assert.deepStrictEqual(asked, [t.id + '#1', t.id + '#2'], t.id);
    assert.strictEqual(E.statusOf(s, t.id), 'shaky');
    const sum = E.summarize(RGQ, s);
    assert.deepStrictEqual(sum.shaky, [t.id]);
    assert.deepStrictEqual(sum.weak, []);
    assert.deepStrictEqual(sum.roots, []);
    assert.deepStrictEqual(sum.path.map((p) => p.id), [t.id]);
    assert.strictEqual(sum.path[0].status, 'shaky');
    if (RGQ.prereqs[t.id].length) withPrereq++;
  });
  assert.ok(withPrereq > 200);
});

test('带题库：混合学生（会 / 不稳 / 不会）——每个点最多 2 题，记录的状态与学生一致', () => {
  const rand = rng(99);
  const known = makeStudent(rand, 0.1);
  const flaky = new Set(topics.filter((t) => !t.external && !known.has(t.id) && rand() < 0.3).map((t) => t.id));
  formal.forEach((t) => {
    const { s, asked } = simulateBank([t.id], known, flaky, 9999);
    const cnt = {};
    asked.forEach((a) => { const id = a.split('#')[0]; cnt[id] = (cnt[id] || 0) + 1; });
    Object.keys(cnt).forEach((id) => assert.ok(cnt[id] <= 2, id));
    Object.keys(s.status).forEach((id) => {
      const st = s.status[id];
      if (st.src !== 'direct') { assert.strictEqual(st.s, 'mastered'); return; }
      const want = known.has(id) ? 'mastered' : flaky.has(id) ? 'shaky' : 'weak';
      assert.strictEqual(st.s, want, id);
    });
    const sum = E.summarize(RGQ, s);
    sum.shaky.forEach((id) => assert.ok(sum.path.some((p) => p.id === id), '不稳的点应在路径里 ' + id));
    const all = new Set(sum.mastered.concat(sum.shaky, sum.weak, sum.untested));
    assert.strictEqual(all.size, s.order.length);
    assert.strictEqual(sum.mastered.length + sum.shaky.length + sum.weak.length + sum.untested.length, s.order.length);
  });
});

test('带题库：题量上限（8/16/30）按题计、永不突破；未复测的点标出', () => {
  const rand = rng(11);
  [8, 16, 30].forEach((limit) => {
    const known = makeStudent(rand, 0.02);
    let capped = 0;
    formal.forEach((t) => {
      const { s, asked } = simulateBank([t.id], known, new Set(), limit);
      assert.ok(asked.length <= limit, t.id);
      if (asked.length === limit) capped++;
      const sum = E.summarize(RGQ, s);
      assert.strictEqual(sum.asked, asked.length);
      sum.unconfirmed.forEach((id) => assert.ok(sum.weak.includes(id)));
      const all = new Set(sum.mastered.concat(sum.shaky, sum.weak, sum.untested));
      assert.strictEqual(all.size, s.order.length);
    });
    if (limit === 8) assert.ok(capped > 0, '应有触发上限的目标');
  });
});

test('带题库：种子固定 => 整个诊断的出题序列确定；换种子序列会变；重放一致', () => {
  const known = new Set(); // 什么都不会：两题都错，序列最长，选题的随机性最明显
  const a = simulateBank(['cnm_232'], known, new Set(), 16, 'fixed');
  const b = simulateBank(['cnm_232'], known, new Set(), 16, 'fixed');
  assert.deepStrictEqual(a.s.answers.map((x) => x.qid), b.s.answers.map((x) => x.qid));
  const qs = new Set();
  for (let i = 0; i < 30; i++) qs.add(simulateBank(['cnm_232'], known, new Set(), 16, 'seed' + i).s.answers.map((x) => x.qid).join());
  assert.ok(qs.size > 3);
  const r = E.replay(RGQ, ['cnm_232'], a.s.answers, { limit: 16, seed: 'fixed' });
  assert.deepStrictEqual(r, a.s);
});

test('带题库：重测时避开已出过的题（avoid 里的题尽量不再出）', () => {
  const known = makeStudent(rng(8), 0.1);
  const first = simulateBank(['cnm_232'], known, new Set(), 16, 'one');
  const seen = first.s.answers.map((x) => x.qid);
  let s = E.createSession(RGQ, ['cnm_232'], { limit: 16, seed: 'two', avoid: seen });
  let repeats = 0, total = 0;
  for (let guard = 0; guard < 100; guard++) {
    const it = E.nextItem(RGQ, s);
    if (!it) break;
    total++;
    if (it.attempt === 1 && seen.includes(it.question.id)) {
      // 只有当该知识点的非 advanced 题全都出过时才可能重复
      const fresh = RGQ.bank[it.topicId].filter((q) => !seen.includes(q.id) && q.difficulty !== 'advanced');
      assert.strictEqual(fresh.length, 0, it.topicId + ' 还有没出过的题却重复了');
      repeats++;
    }
    s = E.applyAnswer(RGQ, s, it.topicId, known.has(it.topicId) ? 'correct' : 'wrong');
  }
  assert.ok(total > 0);
});

console.log('整年级 / 整册筛查');

function screenRun(spec, student, limit, seed) {
  let s = E.createSession(RGQ, spec.ids, { mode: 'screen', limit: limit, seed: seed == null ? 'scr' : seed });
  for (let guard = 0; guard < 2000; guard++) {
    const it = E.nextItem(RGQ, s);
    if (!it) break;
    s = E.applyAnswer(RGQ, s, it.topicId, student(it.topicId, it.attempt));
  }
  return s;
}
const allWrong = () => 'wrong';
const allRight = () => 'correct';
const indexStudent = (id, attempt) => {
  const i = RGQ.index[id];
  if (i % 6 === 0) return 'wrong';
  if (i % 6 === 3) return attempt === 1 ? 'wrong' : 'correct';
  return 'correct';
};

test('gradeTargets：一年级 = 一上 + 一下，七上只含七上；写法不对返回 null', () => {
  const g1 = E.gradeTargets(RGQ, '一年级');
  const up = E.gradeTargets(RGQ, '一上');
  const down = E.gradeTargets(RGQ, '一下');
  assert.deepStrictEqual(g1.volumes, ['一上', '一下']);
  assert.strictEqual(g1.ids.length, up.ids.length + down.ids.length);
  assert.deepStrictEqual(sorted(g1.ids), sorted(up.ids.concat(down.ids)));
  const want = formal.filter((t) => t.grade === 1).length;
  assert.strictEqual(g1.ids.length, want);
  const g7 = E.gradeTargets(RGQ, '七年级');
  assert.strictEqual(g7.ids.length, formal.filter((t) => t.grade === 7 && String(t.id).startsWith('cnm_')).length);
  assert.ok(g7.ids.every((id) => id.startsWith('cnm_')));
  E.gradeTargets(RGQ, '七上').ids.forEach((id) => {
    const t = RGQ.byId[id];
    assert.ok(id.startsWith('cnm_') && t.grade === 7 && t.semester === '上' && !t.external, id);
  });
  assert.strictEqual(E.gradeTargets(RGQ, '十年级'), null);
  assert.strictEqual(E.gradeTargets(RGQ, '七'), null);
  assert.strictEqual(E.gradeTargets(RGQ, ''), null);
  const g10 = E.gradeTargets(RGQ, '高一');
  assert.strictEqual(g10.label, '高一（必修第一册）');
  assert.deepStrictEqual(g10.volumes, ['高一']);
  assert.strictEqual(g10.ids.length, 78);
  g10.ids.forEach((id) => assert.strictEqual(RGQ.byId[id].grade, 10));
  const g11 = E.gradeTargets(RGQ, '高二必修');
  assert.strictEqual(g11.label, '高二（必修第二册）');
  assert.strictEqual(g11.ids.length, 65);
  g11.ids.forEach((id) => assert.strictEqual(RGQ.byId[id].grade, 11));
  assert.deepStrictEqual(E.parseChapter('高一 第一章 集合与常用逻辑用语 1.1'), {
    volume: '高一', chapterNo: '第一章', chapterName: '集合与常用逻辑用语', section: '1.1'
  });
  assert.deepStrictEqual(E.parseChapter('高二 数学探究 用向量研究三角形'), {
    volume: '高二', chapterNo: '数学探究', chapterName: '用向量研究三角形', section: ''
  });
  const g12 = E.gradeTargets(RGQ, '选必一');
  assert.strictEqual(g12.label, '选必一（选择性必修第一册）');
  assert.deepStrictEqual(g12.volumes, ['选必一']);
  assert.strictEqual(g12.ids.length, 53);
  g12.ids.forEach((id) => assert.strictEqual(RGQ.byId[id].grade, 12));
  const g13 = E.gradeTargets(RGQ, '选择性必修第二册');
  assert.strictEqual(g13.label, '选必二（选择性必修第二册）');
  assert.strictEqual(g13.ids.length, 33);
  g13.ids.forEach((id) => assert.strictEqual(RGQ.byId[id].grade, 13));
  const g14 = E.gradeTargets(RGQ, '选必三');
  assert.strictEqual(g14.label, '选必三（选择性必修第三册）');
  assert.strictEqual(g14.ids.length, 42);
  g14.ids.forEach((id) => assert.strictEqual(RGQ.byId[id].grade, 14));
  assert.deepStrictEqual(E.parseChapter('选必二 第五章 一元函数的导数及其应用 5.1'), {
    volume: '选必二', chapterNo: '第五章', chapterName: '一元函数的导数及其应用', section: '5.1'
  });
  assert.deepStrictEqual(E.parseChapter('选必三 数学探究 杨辉三角的性质与应用'), {
    volume: '选必三', chapterNo: '数学探究', chapterName: '杨辉三角的性质与应用', section: ''
  });
  assert.deepStrictEqual(E.parseChapter('选必三 数学建模 建立统计模型进行预测'), {
    volume: '选必三', chapterNo: '数学建模', chapterName: '建立统计模型进行预测', section: ''
  });
  const pre = new Map();
  deps.forEach((d) => { (pre.get(d.topicId) || pre.set(d.topicId, []).get(d.topicId)).push(d.prerequisiteId); });
  topics.filter((t) => /^cnm_h(\d+)$/.test(t.id) && Number(t.id.slice(5)) >= 144).forEach((t) => {
    assert.ok(pre.get(t.id) && pre.get(t.id).length >= 1, t.id + ' 应至少有一条先修');
  });
  assert.strictEqual(RGQ.byId.cnm_h001.name, '集合的含义');
  assert.strictEqual(RGQ.byId.cnm_h143.name, '用频率估计概率');
  assert.strictEqual(RGQ.byId.cnm_h217.name, '导数的概念');
});

test('筛查会话：范围 = 目标本身，默认题量上限 SCREEN_LIMIT；普通会话不受影响', () => {
  const g = E.gradeTargets(RGQ, '七年级');
  const s = E.createSession(RGQ, g.ids, { mode: 'screen' });
  assert.strictEqual(s.limit, E.SCREEN_LIMIT);
  assert.ok(E.SCREEN_LIMIT > E.DEFAULT_LIMIT);
  assert.deepStrictEqual(sorted(s.order), sorted(g.ids));
  assert.strictEqual(s.mode, 'screen');
  const n = E.createSession(RGQ, g.ids);
  assert.strictEqual(n.limit, E.DEFAULT_LIMIT);
  assert.strictEqual(n.mode, 'target');
  assert.strictEqual(n.scope, null);
  assert.ok(n.order.length > s.order.length, '普通会话的子图包含更早年级的先修');
  assert.strictEqual(E.createSession(RGQ, g.ids, { mode: 'screen', limit: 60 }).limit, 60);
});

test('筛查：题量不超过上限（一年级 / 七年级 / 七上；全错、全对、混合的学生）', () => {
  ['一年级', '七年级', '七上'].forEach((scope) => {
    const g = E.gradeTargets(RGQ, scope);
    [[allWrong, 40], [allRight, 40], [indexStudent, 40], [indexStudent, 25], [indexStudent, 60]].forEach(([stu, limit]) => {
      const s = screenRun(g, stu, limit);
      assert.ok(s.answers.length <= limit, scope + ' ' + s.answers.length + ' > ' + limit);
      const ids = new Set(g.ids);
      s.answers.forEach((a) => assert.ok(ids.has(a.id), '问到了范围之外的知识点 ' + a.id));
      const sum = E.summarize(RGQ, s);
      assert.strictEqual(sum.mastered.length + sum.shaky.length + sum.weak.length + sum.untested.length, g.ids.length);
      assert.strictEqual(sum.asked, s.answers.length);
    });
  });
});

test('筛查：全对的学生只需很少几题（答对即推断先修）；一年级默认上限内能问完', () => {
  const g7 = E.gradeTargets(RGQ, '七年级');
  const s = screenRun(g7, allRight, 40);
  const sum = E.summarize(RGQ, s);
  assert.ok(sum.asked < g7.ids.length / 2, '全对却问了 ' + sum.asked);
  assert.strictEqual(sum.mastered.length, g7.ids.length);
  const g1 = E.gradeTargets(RGQ, '一年级');
  const s1 = screenRun(g1, indexStudent, E.SCREEN_LIMIT);
  assert.strictEqual(E.summarize(RGQ, s1).finished, true);
  assert.strictEqual(E.summarize(RGQ, s1).untested.length, 0);
});

test('筛查：到上限没测到的点标「未测」，且题量 = 上限', () => {
  const g = E.gradeTargets(RGQ, '七年级');
  const s = screenRun(g, allWrong, 20);
  const sum = E.summarize(RGQ, s);
  assert.strictEqual(sum.asked, 20);
  assert.strictEqual(sum.limitReached, true);
  assert.ok(sum.untested.length > 0);
});

test('筛查：回溯只在本范围内——薄弱点范围外的先修不被问，且列在 outOfScopePrereqs', () => {
  const g = E.gradeTargets(RGQ, '七上');
  const s = screenRun(g, allWrong, 60);
  const inScope = new Set(g.ids);
  assert.ok(s.answers.every((a) => inScope.has(a.id)));
  const sum = E.summarize(RGQ, s);
  assert.ok(sum.roots.length > 0);
  const outside = new Set();
  sum.roots.forEach((r) => {
    r.pendingPrereqs.forEach((p) => assert.ok(inScope.has(p)));
    r.outOfScopePrereqs.forEach((p) => { assert.ok(!inScope.has(p)); outside.add(p); });
  });
  assert.ok(outside.size > 0, '七上的根因应该有七年级之前的先修');
  // 范围外的点不会出现在汇总里
  sum.mastered.concat(sum.shaky, sum.weak, sum.untested).forEach((id) => assert.ok(inScope.has(id)));
  assert.ok(sum.path.every((p) => inScope.has(p.id) && p.isTarget === false));
});

test('筛查：一致的学生、题量不限 => 薄弱集合恰好等于他不会的点（范围内）', () => {
  const g = E.gradeTargets(RGQ, '七上');
  const inScope = new Set(g.ids);
  [0.3, 0.6, 0.9].forEach((p, k) => {
    const known = makeStudent(rng(100 + k), p);
    const s = screenRun(g, (id) => (known.has(id) ? 'correct' : 'wrong'), 1000);
    const sum = E.summarize(RGQ, s);
    assert.deepStrictEqual(sorted(sum.weak), sorted(g.ids.filter((id) => !known.has(id))));
    assert.strictEqual(sum.untested.length, 0);
    // 根因 = 自己不会、范围内先修都会（范围外的先修不判）
    const wantRoots = g.ids.filter((id) => !known.has(id) &&
      !RGQ.prereqs[id].some((x) => inScope.has(x.id) && !known.has(x.id)));
    assert.deepStrictEqual(sorted(sum.roots.map((r) => r.id)), sorted(wantRoots));
  });
});

test('筛查：同一种子 => 出题序列完全相同；replay 重建一致；换种子序列会变', () => {
  const g = E.gradeTargets(RGQ, '七年级');
  const a = screenRun(g, indexStudent, 40, 'fixed');
  const b = screenRun(g, indexStudent, 40, 'fixed');
  assert.deepStrictEqual(a.answers.map((x) => x.qid), b.answers.map((x) => x.qid));
  const r = E.replay(RGQ, g.ids, a.answers, { mode: 'screen', limit: 40, seed: 'fixed' });
  assert.deepStrictEqual(r, a);
  const c = screenRun(g, indexStudent, 40, 'other');
  assert.notDeepStrictEqual(a.answers.map((x) => x.qid), c.answers.map((x) => x.qid));
  // 会话可 JSON 往返
  assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), a);
});

test('按章汇总：分组正确、数量与汇总一致、薄弱章在前、可复现', () => {
  ['一年级', '七年级', '八上'].forEach((scope) => {
    const g = E.gradeTargets(RGQ, scope);
    const s = screenRun(g, indexStudent, 40);
    const sum = E.summarize(RGQ, s);
    const chs = E.chapterSummary(RGQ, s);
    // 每个知识点恰好在一章里，章总数 = 范围内知识点数
    assert.strictEqual(chs.reduce((n, c) => n + c.total, 0), g.ids.length);
    const seen = new Set();
    chs.forEach((c) => {
      assert.strictEqual(c.mastered + c.shaky + c.weak + c.untested, c.total, c.label);
      assert.strictEqual(c.weakIds.length, c.weak);
      assert.strictEqual(c.shakyIds.length, c.shaky);
      c.weakIds.concat(c.shakyIds, c.untestedIds).forEach((id) => {
        assert.ok(!seen.has(id)); seen.add(id);
        const p = E.parseChapter(RGQ.byId[id].chapter);
        assert.strictEqual(c.volume + ' ' + c.chapterNo + ' ' + c.chapterName, p.volume + ' ' + p.chapterNo + ' ' + p.chapterName);
        assert.ok(g.volumes.includes(p.volume));
      });
      c.weakIds.forEach((id) => assert.strictEqual(E.statusOf(s, id), 'weak'));
      c.shakyIds.forEach((id) => assert.strictEqual(E.statusOf(s, id), 'shaky'));
    });
    assert.strictEqual(chs.reduce((n, c) => n + c.weak, 0), sum.weak.length);
    assert.strictEqual(chs.reduce((n, c) => n + c.shaky, 0), sum.shaky.length);
    assert.strictEqual(chs.reduce((n, c) => n + c.mastered, 0), sum.mastered.length);
    assert.strictEqual(chs.reduce((n, c) => n + c.untested, 0), sum.untested.length);
    for (let i = 1; i < chs.length; i++) {
      const a = chs[i - 1], b = chs[i];
      assert.ok(a.weak > b.weak || (a.weak === b.weak && a.shaky >= b.shaky), '排序：' + a.label + ' / ' + b.label);
    }
    assert.ok(chs[0].weak >= 1, scope + ' 最前面的章应有薄弱点');
    assert.deepStrictEqual(chs, E.chapterSummary(RGQ, screenRun(g, indexStudent, 40)));
  });
});

test('按章汇总：七上共 6 章；还没作答的会话所有点都算未测，章按教材顺序', () => {
  const g = E.gradeTargets(RGQ, '七上');
  const s = screenRun(g, allWrong, 60);
  const chs = E.chapterSummary(RGQ, s);
  assert.strictEqual(chs.length, 6);
  const tiny = E.chapterSummary(RGQ, E.createSession(RGQ, g.ids, { mode: 'screen' }));
  assert.ok(tiny.every((c) => c.untested === c.total && c.weak === 0));
  assert.deepStrictEqual(tiny.map((c) => c.label).slice(0, 2), ['七上 第一章 有理数', '七上 第二章 有理数的运算']);
});

test('筛查：路径图只画有问题的点（不把整个年级都画上）', () => {
  const g = E.gradeTargets(RGQ, '七年级');
  const s = screenRun(g, indexStudent, 40);
  const sum = E.summarize(RGQ, s);
  const lay = E.layout(RGQ, s, sum);
  assert.ok(lay.nodes.length < g.ids.length);
  assert.ok(lay.nodes.every((n) => n.isTarget === false));
  const allOk = E.summarize(RGQ, screenRun(g, allRight, 40));
  assert.strictEqual(allOk.path.length, 0);
});

test('普通整章 / 单点诊断不受影响：不带 mode 的会话仍回溯到小学', () => {
  const s = E.createSession(RGQ, ['cnm_232'], { limit: 16 });
  assert.strictEqual(s.mode, 'target');
  assert.ok(s.order.length > 1);
  const sum = E.summarize(RGQ, s);
  assert.strictEqual(sum.mode, 'target');
  sum.roots.forEach((r) => assert.deepStrictEqual(r.outOfScopePrereqs, []));
});

/* ------------------------------------------------------------ 苏格拉底讲解引导
 * socraticSteps(topic, q) -> [{kind:'prompt'|'hint'|'reveal', text}]
 * 静态骨架版：不接 LLM，用题目数据生成三步引导；T2 再把文本换成模型生成。
 * 原则：prompt 不给答案、hint 只给线索、reveal 才揭晓完整解析。
 */

const Q_A = { id: 'q1', type: 'numeric', prompt: '解方程 2(x-3)=4-(x+1)。', answer: '3', explanation: '去括号得 2x-6=4-x-1，移项合并得 3x=9，所以 x=3。', difficulty: 'standard' };
const T_A = { id: 'cnm_043', name: '含括号的一元一次方程', chapter: '七上 第五章 5.2', type: 'procedural' };

test('socraticSteps：返回三步，kind 顺序为 prompt→hint→reveal', () => {
  const steps = E.socraticSteps(T_A, Q_A);
  assert.strictEqual(steps.length, 3);
  assert.deepStrictEqual(steps.map((s) => s.kind), ['prompt', 'hint', 'reveal']);
});

test('socraticSteps：prompt 是提问且不泄露参考答案', () => {
  const steps = E.socraticSteps(T_A, Q_A);
  assert.ok(steps[0].text.length > 0);
  assert.ok(steps[0].text.indexOf(Q_A.answer) < 0, 'prompt 不能包含答案');
  assert.ok(steps[0].text.indexOf(Q_A.explanation) < 0, 'prompt 不能包含完整解析');
  assert.ok(steps[0].text.indexOf(T_A.name) >= 0, 'prompt 应提及知识点名');
});

test('socraticSteps：hint 只给线索，不揭晓最终答案', () => {
  const steps = E.socraticSteps(T_A, Q_A);
  assert.ok(steps[1].text.length > 0);
  assert.ok(steps[1].text.indexOf(Q_A.answer) < 0, 'hint 不能包含最终答案');
  assert.ok(steps[1].text.length < steps[2].text.length, 'hint 应短于 reveal');
});

test('socraticSteps：reveal 揭晓参考答案与解析', () => {
  const steps = E.socraticSteps(T_A, Q_A);
  assert.ok(steps[2].text.indexOf(Q_A.answer) >= 0, 'reveal 必须包含参考答案');
  assert.ok(steps[2].text.indexOf(Q_A.explanation) >= 0, 'reveal 必须包含解析');
});

test('socraticSteps：选择题 hint 引导到判断依据而非答案文本', () => {
  const qc = { id: 'q2', type: 'choice', prompt: '移项正确的是？', answer: 'B', choices: [{ key: 'A', text: '2x-5x=6-3' }, { key: 'B', text: '2x-5x=6+3' }], explanation: '移项要变号：5x 移到左边变 -5x，-3 移到右边变 +3。', difficulty: 'standard' };
  const steps = E.socraticSteps(T_A, qc);
  assert.strictEqual(steps[0].kind, 'prompt');
  assert.ok(steps[2].text.indexOf('B') >= 0);
});

test('socraticSteps：缺解析时也能生成三步', () => {
  const qNo = { id: 'q3', type: 'numeric', prompt: 'x+2=5', answer: '3' };
  const steps = E.socraticSteps(T_A, qNo);
  assert.strictEqual(steps.length, 3);
  assert.ok(steps[2].text.indexOf('x+2=5') < 0 || steps[2].text.indexOf('3') >= 0, 'reveal 应至少给出答案');
});

/* ---------------- T3：pickPracticeQuestions(graph, topicId, n, doneIds) ---------------- */

const G_PRAC = {
  bank: {
    t1: [
      { id: 'a', difficulty: 'basic' },
      { id: 'b', difficulty: 'advanced' },
      { id: 'c', difficulty: 'standard' },
      { id: 'd', difficulty: 'basic' },
    ],
    t2: [{ id: 'e', difficulty: 'basic' }],
    t3: [],
  },
};

test('pickPracticeQuestions：抽 n 道且基础优先（basic→standard→advanced）', () => {
  const qs = E.pickPracticeQuestions(G_PRAC, 't1', 3, []);
  assert.strictEqual(qs.length, 3);
  assert.deepStrictEqual(qs.map((q) => q.id), ['a', 'd', 'c'], 'basic 两道在前，standard 其次');
});

test('pickPracticeQuestions：避开已做过的题（诊断/练习）', () => {
  const qs = E.pickPracticeQuestions(G_PRAC, 't1', 3, ['a', 'd', 'c']);
  assert.deepStrictEqual(qs.map((q) => q.id), ['b'], '只剩 advanced 的 b');
});

test('pickPracticeQuestions：全做过后仍能复用简单题（练习不能没题可出）', () => {
  const qs = E.pickPracticeQuestions(G_PRAC, 't1', 2, ['a', 'b', 'c', 'd']);
  assert.strictEqual(qs.length, 2);
  assert.strictEqual(qs[0].difficulty, 'basic', '复用也从基础开始');
});

test('pickPracticeQuestions：题目少于 n 时全给；无题返回空数组', () => {
  assert.strictEqual(E.pickPracticeQuestions(G_PRAC, 't2', 3, []).length, 1);
  assert.deepStrictEqual(E.pickPracticeQuestions(G_PRAC, 't3', 3, []), []);
});

test('pickPracticeQuestions：n 至少为 1（不会返回空列表给练习）', () => {
  assert.strictEqual(E.pickPracticeQuestions(G_PRAC, 't1', 0, []).length, 1);
});

/* ------------------------------------------------------------ studentAdvice（学习小结） */
function mkSum(extra) {
  return Object.assign({
    mode: 'target', targets: ['T'], asked: 3, limit: 10, finished: true, limitReached: false,
    mastered: [], shaky: [], weak: [], unconfirmed: [], untested: [], roots: [], path: []
  }, extra || {});
}
const sumName = (id) => ({ T: '目标', A: '移项', B: '去括号', C: '合并同类项' }[id] || id);

test('studentAdvice：2 个根因给前两个名字并给补学建议', () => {
  const s = mkSum({ roots: [{ id: 'A' }, { id: 'B' }], weak: ['A', 'B'] });
  const text = E.studentAdvice(s, sumName);
  assert.ok(text.indexOf('卡点在：移项、去括号') >= 0, text);
  assert.ok(text.indexOf('【移项】') >= 0 && text.indexOf('【去括号】') >= 0, text);
  assert.ok(text.indexOf('再测一次') >= 0, text);
});

test('studentAdvice：只有 1 个根因不强加第二个', () => {
  const s = mkSum({ roots: [{ id: 'A' }], weak: ['A'] });
  const text = E.studentAdvice(s, sumName);
  assert.ok(text.indexOf('卡点在：移项') >= 0, text);
  assert.ok(text.indexOf('【去括号】') < 0, text);
});

test('studentAdvice：无根因有不稳时给巩固建议', () => {
  const s = mkSum({ shaky: ['C'] });
  const text = E.studentAdvice(s, sumName);
  assert.ok(text.indexOf('不太稳') >= 0 && text.indexOf('练习这 3 题') >= 0, text);
});

test('studentAdvice：有答错但没判出根因时提示再测', () => {
  const s = mkSum({ weak: ['A'], roots: [] });
  const text = E.studentAdvice(s, sumName);
  assert.ok(text.indexOf('卡点还没找出来') >= 0 && text.indexOf('多答几题') >= 0, text);
});

test('studentAdvice：全部掌握时无需复习', () => {
  const s = mkSum({ mastered: ['T'], untested: [] });
  const text = E.studentAdvice(s, sumName);
  assert.ok(text.indexOf('都掌握啦') >= 0, text);
});

test('studentAdvice：没测完时提示继续作答', () => {
  const s = mkSum({ untested: ['C'] });
  const text = E.studentAdvice(s, sumName);
  assert.ok(text.indexOf('没测完') >= 0, text);
});

test('studentAdvice：文案不含"家长/陪孩子/建议："等监督感措辞', () => {
  const withRoots = E.studentAdvice(mkSum({ roots: [{ id: 'A' }], weak: ['A'] }), sumName);
  const allDone = E.studentAdvice(mkSum({ mastered: ['T'] }), sumName);
  ['家长', '陪孩子', '建议：'].forEach(function (w) {
    assert.ok(withRoots.indexOf(w) < 0, '有根因文案不应含 ' + w + ': ' + withRoots);
    assert.ok(allDone.indexOf(w) < 0, '全掌握文案不应含 ' + w + ': ' + allDone);
  });
});

/* ============================================================ O1 变式生成器测试
 * 设计文档：docs/o1-random-variants.md
 * 实现模块：diagnose/variants.js
 * 测试要点 20 条（§9），含独立求解器（不共享被测代码逻辑）
 */
const V = (function () {
  try { return require('../diagnose/variants.js'); }
  catch (e) { return null; }
})();

// 测试内独立求解器：从 prompt 正则解析 → 展开 → 有理数解方程 → 与 answer 比对
function gcd(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) { [a, b] = [b, a % b]; } return a || 1; }
function reduceFrac(p, q) {
  if (q < 0) { p = -p; q = -q; }
  const g = gcd(p, q);
  return { p: p / g, q: q / g };
}
// 从 prompt 解析四个模板的参数，返回 {recipe, a, b, c, d, e, m}
function parsePrompt(prompt) {
  // T1: 解方程 {a}(x{b})={c}。（只填 x 的值）
  let m = /^解方程 (-?\d+)\(x([+-]\d+)\)=(-?\d+)。/.exec(prompt);
  if (m) return { recipe: 'T1', a: +m[1], b: +m[2], c: +m[3] };
  // T2: 解方程 {a}(x{b})={c}(x{d})。
  m = /^解方程 (-?\d+)\(x([+-]\d+)\)=(-?\d+)\(x([+-]\d+)\)。/.exec(prompt);
  if (m) return { recipe: 'T2', a: +m[1], b: +m[2], c: +m[3], d: +m[4] };
  // T3: 解方程 {a}(x{b}){-|+}{c}(x{d})={e}。（c<0 时显示为 +|c|）
  m = /^解方程 (-?\d+)\(x([+-]\d+)\)([+-])(\d+)\(x([+-]\d+)\)=(-?\d+)。/.exec(prompt);
  if (m) return { recipe: 'T3', a: +m[1], b: +m[2], c: m[3] === '-' ? +m[4] : -m[4], d: +m[5], e: +m[6] };
  // T4: 解方程 {a}(x{b})={m}-(x{d})。
  m = /^解方程 (-?\d+)\(x([+-]\d+)\)=(-?\d+)-\(x([+-]\d+)\)。/.exec(prompt);
  if (m) return { recipe: 'T4', a: +m[1], b: +m[2], m: +m[3], d: +m[4] };
  return null;
}
// 展开成 Ax+B=Cx+D，返回 {A,B,C,D}
function expandToLinear(p) {
  if (p.recipe === 'T1') return { A: p.a, B: p.a * p.b, C: 0, D: p.c };
  if (p.recipe === 'T2') return { A: p.a, B: p.a * p.b, C: p.c, D: p.c * p.d };
  if (p.recipe === 'T3') return { A: p.a - p.c, B: p.a * p.b - p.c * p.d, C: 0, D: p.e };
  if (p.recipe === 'T4') return { A: p.a, B: p.a * p.b, C: -1, D: p.m - p.d };
  return null;
}
// 独立解方程 r=(D-B)/(A-C)，返回 {p,q}
function solveLinear(L) {
  return reduceFrac(L.D - L.B, L.A - L.C);
}
// 解析 answer 字符串为 {p,q}
function parseAnswerStr(s) {
  const m = /^(-?\d+)\/(\d+)$/.exec(s);
  if (m) return reduceFrac(+m[1], +m[2]);
  return reduceFrac(parseInt(s, 10), 1);
}

console.log('\nO1 变式生成器（diagnose/variants.js）');

// 如果模块不存在，所有测试都应 FAIL（RED 阶段）
if (V) {

test('1 确定性：同(topic,index)两次生成深相等', () => {
  const a = V.genVariant('cnm_043', 0);
  const b = V.genVariant('cnm_043', 0);
  assert.ok(a && b, 'genVariant 应返回非 null');
  assert.deepStrictEqual(a, b);
});

test('2 不同 index 得到不同题', () => {
  const ids = new Set(), prompts = new Set();
  for (let i = 0; i < 10; i++) {
    const q = V.genVariant('cnm_043', i);
    assert.ok(q, 'index=' + i + ' 应返回非 null');
    ids.add(q.id);
    prompts.add(q.prompt);
  }
  assert.ok(ids.size === 10, '10 个 index 应有 10 个不同 id');
  assert.ok(prompts.size >= 8, '应有 ≥8 种不同题面，实际 ' + prompts.size);
});

test('3 id 形状正则 + index=i → _v{i+1}', () => {
  for (let i = 0; i < 5; i++) {
    const q = V.genVariant('cnm_043', i);
    assert.ok(/^cnm_043_v\d+$/.test(q.id), 'id 应匹配 ^cnm_043_v\\d+$: ' + q.id);
    assert.ok(q.id === 'cnm_043_v' + (i + 1), 'index=' + i + ' → id=' + q.id + ' 应为 _v' + (i + 1));
  }
});

test('4 数值正确性（独立求解器，index 0..199）', () => {
  let bad = 0;
  for (let i = 0; i < 200; i++) {
    const q = V.genVariant('cnm_043', i);
    assert.ok(q, 'index=' + i + ' 不应返回 null');
    const parsed = parsePrompt(q.prompt);
    assert.ok(parsed, '无法解析题面: ' + q.prompt);
    const L = expandToLinear(parsed);
    const expected = solveLinear(L);
    const actual = parseAnswerStr(q.answer);
    if (expected.p !== actual.p || expected.q !== actual.q) {
      bad++;
      if (bad <= 3) console.log('    MISMATCH idx=' + i + ' prompt=' + q.prompt + ' expected=' + expected.p + '/' + expected.q + ' actual=' + q.answer);
    }
  }
  assert.ok(bad === 0, '独立求解器应全部匹配，bad=' + bad);
});

test('5 题面与内部展开一致（系数范围 + A≠C）', () => {
  for (let i = 0; i < 200; i++) {
    const q = V.genVariant('cnm_043', i);
    const p = parsePrompt(q.prompt);
    assert.ok(p, '无法解析: ' + q.prompt);
    // 系数范围检查
    assert.ok(Math.abs(p.a) >= 2 && Math.abs(p.a) <= 6, 'a 范围: ' + p.a + ' idx=' + i);
    if (p.recipe === 'T2' || p.recipe === 'T3') {
      assert.ok(Math.abs(p.c) >= 2 && Math.abs(p.c) <= 6, 'c 范围: ' + p.c + ' idx=' + i);
    }
    assert.ok(Math.abs(p.b) >= 1 && Math.abs(p.b) <= 9, 'b 范围: ' + p.b + ' idx=' + i);
    if (p.d != null) {
      assert.ok(Math.abs(p.d) >= 1 && Math.abs(p.d) <= 9, 'd 范围: ' + p.d + ' idx=' + i);
    }
    const L = expandToLinear(p);
    assert.ok(L.A !== L.C, 'A≠C: A=' + L.A + ' C=' + L.C + ' idx=' + i);
  }
});

test('6 单一解不变量（classifyLinear 全部为 unique）', () => {
  for (let i = 0; i < 200; i++) {
    const q = V.genVariant('cnm_043', i);
    const p = parsePrompt(q.prompt);
    const L = expandToLinear(p);
    assert.strictEqual(V.classifyLinear(L), 'unique', 'idx=' + i + ' 应为 unique');
  }
});

test('7 三分类工具（contradiction/identity/unique）', () => {
  assert.strictEqual(V.classifyLinear({ A: 2, B: 3, C: 2, D: 5 }), 'contradiction');
  assert.strictEqual(V.classifyLinear({ A: 2, B: 3, C: 2, D: 3 }), 'identity');
  assert.strictEqual(V.classifyLinear({ A: 2, B: 3, C: 1, D: 4 }), 'unique');
});

test('8 答案规整（整数或最简分数，无小数点无空格）', () => {
  for (let i = 0; i < 200; i++) {
    const q = V.genVariant('cnm_043', i);
    assert.ok(/^-?\d+$/.test(q.answer) || /^-?\d+\/[234]$/.test(q.answer), 'answer 格式: ' + q.answer + ' idx=' + i);
    assert.ok(q.answer.indexOf('.') < 0, 'answer 不含小数点: ' + q.answer);
    assert.ok(q.answer.indexOf(' ') < 0, 'answer 不含空格: ' + q.answer);
    // 分数必最简
    const m = /^(-?\d+)\/(\d+)$/.exec(q.answer);
    if (m) {
      const p = parseInt(m[1], 10), qq = parseInt(m[2], 10);
      assert.strictEqual(gcd(p, qq), 1, '分数应最简: ' + q.answer);
      assert.ok(qq > 0, '分母为正: ' + qq);
    }
  }
});

test('9 无分数/小数系数（prompt 只含整数与运算符）', () => {
  const allowed = /^解方程 [-+0-9()x=。]+（只填 x 的值）$/;
  for (let i = 0; i < 200; i++) {
    const q = V.genVariant('cnm_043', i);
    assert.ok(allowed.test(q.prompt), 'prompt 只含允许字符: ' + q.prompt + ' idx=' + i);
    assert.ok(q.prompt.indexOf('.') < 0, 'prompt 不含小数点: ' + q.prompt);
    assert.ok(q.prompt.indexOf('√') < 0, 'prompt 不含根号');
  }
});

test('10 难度分布与 recipe 归档', () => {
  const counts = { basic: 0, standard: 0, advanced: 0 };
  const recipes = {};
  for (let i = 0; i < 300; i++) {
    const q = V.genVariant('cnm_043', i);
    counts[q.difficulty]++;
    recipes[q.variantRecipe] = (recipes[q.variantRecipe] || 0) + 1;
    if (q.difficulty === 'basic') {
      assert.strictEqual(q.variantRecipe, 'T1', 'basic 应全为 T1: idx=' + i + ' recipe=' + q.variantRecipe);
      assert.ok(!/\//.test(q.answer), 'basic answer 全整数: ' + q.answer);
    }
    if (q.difficulty === 'advanced') {
      // advanced 中 T3 占绝大多数，剩余兜底必须标 basic
      assert.ok(q.variantRecipe === 'T3' || q.difficulty === 'basic', 'advanced 中应为 T3: idx=' + i);
    }
  }
  // 三档各占 80-120（1/3 均衡）
  ['basic', 'standard', 'advanced'].forEach(function (d) {
    assert.ok(counts[d] >= 80 && counts[d] <= 120, d + ' 档应在 80-120: ' + counts[d]);
  });
});

test('11 分数根与整数根都出现', () => {
  let fracAdv = 0, fracBasic = 0;
  for (let i = 0; i < 200; i++) {
    const q = V.genVariant('cnm_043', i);
    if (/\//.test(q.answer)) {
      if (q.difficulty === 'advanced') fracAdv++;
      if (q.difficulty === 'basic') fracBasic++;
    }
  }
  assert.ok(fracAdv >= 5, 'advanced 应有 ≥5 个分数根: ' + fracAdv);
  assert.ok(fracBasic === 0, 'basic 应 0 个分数根: ' + fracBasic);
});

test('12 accept 语义（存在时 judgeQuestion 判 correct 且 reason=identical）', () => {
  let found = false;
  for (let i = 0; i < 300 && !found; i++) {
    const q = V.genVariant('cnm_043', i);
    if (q.accept && q.accept.length) {
      found = true;
      assert.ok(q.accept[0].indexOf('.') >= 0, 'accept 应含小数点: ' + q.accept[0]);
      const r = E.judgeQuestion(q, q.accept[0]);
      assert.strictEqual(r.verdict, 'correct', 'accept 应判 correct');
      assert.strictEqual(r.reason, 'identical', 'accept reason 应为 identical: ' + r.reason);
    }
  }
  assert.ok(found, '200 个序号中应至少有一个带 accept 的分数根变式');
});

test('13 判题链兼容（answer / x=answer / 等价小数 / 错值）', () => {
  const q = V.genVariant('cnm_043', 0);
  assert.ok(q);
  // answer 本身
  assert.strictEqual(E.judgeQuestion(q, q.answer).verdict, 'correct');
  // x=answer
  assert.strictEqual(E.judgeQuestion(q, 'x=' + q.answer).verdict, 'correct');
  // 等价小数（分数根时）
  if (/\//.test(q.answer) && q.accept && q.accept.length) {
    assert.strictEqual(E.judgeQuestion(q, q.accept[0]).verdict, 'correct');
  }
  // 错值
  const wrong = q.answer === '0' ? '1' : '0';
  assert.strictEqual(E.judgeQuestion(q, wrong).verdict, 'wrong');
});

test('14 解析结构（步骤关键词 + 末句 x={answer}）', () => {
  for (let i = 0; i < 50; i++) {
    const q = V.genVariant('cnm_043', i);
    assert.ok(q.explanation.indexOf('去括号') >= 0, '解析含"去括号": idx=' + i);
    assert.ok(q.explanation.indexOf('系数化为 1 得 x=' + q.answer + '。') >= 0,
      '解析末句 x=' + q.answer + ' idx=' + i + ' expl=' + q.explanation);
    // T2/T3/T4 应含"合并同类项"
    if (q.variantRecipe !== 'T1') {
      assert.ok(q.explanation.indexOf('合并同类项') >= 0, '非T1含"合并同类项": idx=' + i + ' recipe=' + q.variantRecipe);
    }
    // T1 应含"移项"
    if (q.variantRecipe === 'T1') {
      assert.ok(q.explanation.indexOf('移项') >= 0, 'T1含"移项": idx=' + i);
    }
  }
});

test('15 首句不泄露（socraticSteps hint 不含 x=answer 且不含"系数化为"）', () => {
  const topic = { id: 'cnm_043', name: '含括号的一元一次方程' };
  for (let i = 0; i < 50; i++) {
    const q = V.genVariant('cnm_043', i);
    const steps = E.socraticSteps(topic, q);
    const hint = steps[1].text;
    // 不含 x=<answer>
    const ansRe = new RegExp('x\\s*=\\s*' + q.answer.replace('/', '\\/'));
    assert.ok(!ansRe.test(hint), 'hint 不含 x=' + q.answer + ': idx=' + i + ' hint=' + hint);
    assert.ok(hint.indexOf('系数化为') < 0, 'hint 不含"系数化为": idx=' + i);
  }
});

test('16 撞题去重 + 确定性', () => {
  // ① avoidPrompts 含自己的 prompt 时，生成不同 prompt
  const q1 = V.genVariant('cnm_043', 0);
  const q2 = V.genVariant('cnm_043', 0, { avoidPrompts: [q1.prompt] });
  assert.ok(q2, '撞题去重后仍应返回题');
  assert.ok(q2.prompt !== q1.prompt, '应生成不同 prompt');
  // ② 非撞题场景下，传 [] 与传题库 prompts 结果深相等
  const bankPrompts = [
    '解方程 2(x-3)=4-(x+1)。（只填 x 的值）',
    '解方程 3(x-1)=9。（只填 x 的值）',
    '解方程 5(x+2)-3(2x-1)=4。（只填 x 的值）',
    '解方程 2x-3(x-1)=-2(x+1)+7。（只填 x 的值）'
  ];
  const q3 = V.genVariant('cnm_043', 5, { avoidPrompts: [] });
  const q4 = V.genVariant('cnm_043', 5, { avoidPrompts: bankPrompts });
  assert.deepStrictEqual(q3, q4, '非撞题时 avoidPrompts 不影响结果');
});

test('17 未支持 topic 的失败语义', () => {
  assert.strictEqual(V.genVariant('cnm_045', 0), null);
  assert.deepStrictEqual(V.variantSet('cnm_045', 0, 3), []);
  // fillPractice 不抛错
  const r = V.fillPractice([], 'cnm_045', 3, {});
  assert.ok(r && r.list && r.list.length === 0);
});

test('18 共存策略：充足时不混变式', () => {
  // bankPicks 已由 pickPracticeQuestions 排好序（basic→standard→advanced）
  const bankPicks = [
    { id: 'cnm_043_q2', topicId: 'cnm_043', difficulty: 'basic', type: 'numeric', prompt: 'q2', answer: '4' },
    { id: 'cnm_043_q1', topicId: 'cnm_043', difficulty: 'standard', type: 'numeric', prompt: 'q1', answer: '3' },
    { id: 'cnm_043_q3', topicId: 'cnm_043', difficulty: 'standard', type: 'numeric', prompt: 'q3', answer: '9' },
    { id: 'cnm_043_q4', topicId: 'cnm_043', difficulty: 'advanced', type: 'numeric', prompt: 'q4', answer: '2' }
  ];
  const r = V.fillPractice(bankPicks, 'cnm_043', 3, { doneIds: [] });
  assert.strictEqual(r.list.length, 3, '应返回 3 题');
  assert.strictEqual(r.usedVariants, 0, '不应用变式');
  // 全是题库题
  r.list.forEach(function (q) { assert.ok(!q.variant, '应为题库题: ' + q.id); });
  // 顺序与传入一致（basic 先）
  assert.strictEqual(r.list[0].id, 'cnm_043_q2'); // basic 先
});

test('19 共存策略：耗尽后补位', () => {
  const bankPicks = [
    { id: 'cnm_043_q1', topicId: 'cnm_043', difficulty: 'standard', type: 'numeric', prompt: 'q1', answer: '3' },
    { id: 'cnm_043_q2', topicId: 'cnm_043', difficulty: 'basic', type: 'numeric', prompt: 'q2', answer: '4' },
    { id: 'cnm_043_q3', topicId: 'cnm_043', difficulty: 'standard', type: 'numeric', prompt: 'q3', answer: '9' },
    { id: 'cnm_043_q4', topicId: 'cnm_043', difficulty: 'advanced', type: 'numeric', prompt: 'q4', answer: '2' }
  ];
  const allDone = ['cnm_043_q1', 'cnm_043_q2', 'cnm_043_q3', 'cnm_043_q4'];
  const r = V.fillPractice(bankPicks, 'cnm_043', 3, { doneIds: allDone });
  assert.strictEqual(r.list.length, 3, '应返回 3 题');
  assert.strictEqual(r.usedVariants, 3, '应用 3 道变式');
  r.list.forEach(function (q) { assert.ok(q.variant === true, '应全为变式: ' + q.id); });
  const ids = new Set(r.list.map(function (q) { return q.id; }));
  assert.strictEqual(ids.size, 3, 'id 互不相同');
  assert.strictEqual(r.nextIndex, 3, 'nextIndex 应为 3');
});

test('20 无副作用 / 性能护栏', () => {
  const beforeKeys = new Set(Object.keys(globalThis));
  const t0 = Date.now();
  for (let i = 0; i < 200; i++) {
    V.genVariant('cnm_043', i);
  }
  const dt = Date.now() - t0;
  assert.ok(dt < 500, '200 次生成应 < 500ms: ' + dt + 'ms');
  const afterKeys = new Set(Object.keys(globalThis));
  // 不应新增全局键（UMD 注册的除外）
  const newKeys = Array.from(afterKeys).filter(function (k) { return !beforeKeys.has(k); });
  assert.ok(newKeys.length === 0, '不应新增全局键: ' + JSON.stringify(newKeys));
});

} // end if (V)

/* ------------------------------------------------------------ O2：讲解 reveal 数值校验
 * 讲解文本由 LLM 全文生成，偶发算错会直接教错。校验只做一件事：
 * 把 reveal 里“明确声明的最终解值”抽出来，与标准答案做数值等价比较。
 * 拿不准（无可比对声明 / 答案不是数值）时返回 ok:null，绝不误杀正常讲解。
 */

test('numericEqual：分数与小数互认（1/3 ≈ 0.333、0.5 = 1/2）', () => {
  assert.strictEqual(E.numericEqual('1/3', '0.333'), true);
  assert.strictEqual(E.numericEqual('0.5', '1/2'), true);
  assert.strictEqual(E.numericEqual('2', '4/2'), true);
});

test('numericEqual：0.33 与 1/3 不算等价（误差超出舍入容差）', () => {
  assert.strictEqual(E.numericEqual('0.33', '1/3'), false);
});

test('numericEqual：符号与括号归一（-3、−3、（-3）同一值）', () => {
  assert.strictEqual(E.numericKey('-3'), E.numericKey('−3'));
  assert.strictEqual(E.numericKey('（-3）'), E.numericKey('-3'));
  assert.strictEqual(E.numericEqual('-3', '−3'), true);
  assert.strictEqual(E.numericEqual('-3', '3'), false);
});

test('numericEqual：无法解析的文本返回 null（不做判断）', () => {
  assert.strictEqual(E.numericKey('x=3'), null);
  assert.strictEqual(E.numericEqual('三', '3'), null);
});

test('verifyReveal：reveal 给出正确解值 -> ok', () => {
  const v = E.verifyReveal('去括号得2x-6=4-x-1，移项合并得3x=9，所以x=3。', '3');
  assert.strictEqual(v.ok, true, JSON.stringify(v));
});

test('verifyReveal：方程中间步骤不算解值（2x=6 不等于 x=6）', () => {
  const v = E.verifyReveal('由2x=6，两边同除以2，所以x=3。', '3');
  assert.strictEqual(v.ok, true, JSON.stringify(v));
});

test('verifyReveal：中途一步的赋值不算解值（得x=6 不代表答案是错的）', () => {
  const v = E.verifyReveal('解析：17-5=12，2x=12，得x=6。', '12');
  assert.strictEqual(v.ok, true, JSON.stringify(v));   // 12 作为算式的右边出现 -> 判对，不误杀
});

test('verifyReveal：待解的方程右边不当成答案（3x=3 里的 3 不能替 x=1 顶罪）', () => {
  const v = E.verifyReveal('移项合并得3x=3，所以x=1。', '3');
  assert.strictEqual(v.ok, false, JSON.stringify(v));
});

test('verifyReveal：reveal 给出错值 -> 判为不一致', () => {
  const v = E.verifyReveal('移项合并得3x=3，所以x=1。', '3');
  assert.strictEqual(v.ok, false, JSON.stringify(v));
  assert.ok(v.expected.indexOf('3/1') >= 0, JSON.stringify(v));
});

test('verifyReveal：负号不能漏（参考 -3，写 x=3 判错）', () => {
  assert.strictEqual(E.verifyReveal('所以x=-3。', '-3').ok, true);
  assert.strictEqual(E.verifyReveal('所以x=3。', '-3').ok, false);
});

test('verifyReveal：± 参考答案接受正负两解，其他值仍判错', () => {
  assert.strictEqual(E.verifyReveal('所以x=3或x=-3。', '±3').ok, true);
  assert.strictEqual(E.verifyReveal('所以x=3。', '±3').ok, true);
  assert.strictEqual(E.verifyReveal('所以x=5。', '±3').ok, false);
  assert.strictEqual(E.verifyReveal('所以x=3。', 'x=±3').ok, true);
  assert.strictEqual(E.verifyReveal('所以x=2。', 'x=±3').ok, false);
});

test('verifyReveal：无序多解按集合比较（顺序无关，集合外判错）', () => {
  assert.strictEqual(E.verifyReveal('所以x=3或x=2。', '2，3').ok, true);
  assert.strictEqual(E.verifyReveal('所以x=2或x=5。', '2，3').ok, false);
});

test('verifyReveal：分数与小数写法不同但等价', () => {
  assert.strictEqual(E.verifyReveal('所以x=0.5。', '1/2').ok, true);
  assert.strictEqual(E.verifyReveal('所以x=1/2。', '0.5').ok, true);
});

test('verifyReveal：不同变量各对各（x=3，y=2）', () => {
  assert.strictEqual(E.verifyReveal('所以x=3，y=2。', 'x=3，y=2').ok, true);
  assert.strictEqual(E.verifyReveal('所以x=2，y=3。', 'x=3，y=2').ok, false);
});

test('verifyReveal：单位冲突判错，单位一致判对', () => {
  assert.strictEqual(E.verifyReveal('答案是3cm。', '3cm').ok, true);
  assert.strictEqual(E.verifyReveal('答案是3m。', '3cm').ok, false);
});

test('verifyReveal：reveal 没有明确解值 -> ok:null（不误判）', () => {
  const v = E.verifyReveal('先想想移项要变号，再合并同类项。', '3');
  assert.strictEqual(v.ok, null, JSON.stringify(v));
});

test('verifyReveal：参考答案不是数值（字母/文字）-> ok:null', () => {
  assert.strictEqual(E.verifyReveal('选B，因为移项要变号。', 'B').ok, null);
});

/* ---------- O2-3：代入验证段误杀修复 ---------- */

test('verifyReveal：reveal 含代入验证段 2×(5-3)=4 时不误杀正确解 x=3', () => {
  // LLM 用算出的 x=3 代回原方程 2×(5-x) 验证：2×(5-3)=4
  // computedValues 会提取验证段右值 4 作为候选，但正确解值是 3
  // "得x=3" 里的"得"不在 CONCLUSION 正则 → solutionClaims 不会提取
  // 修复前：candidates[0]=4 ≠ 3 → ok:false 误杀
  // 修复后：代入验证段被排除，无候选 → ok:null（不误杀）
  var v = E.verifyReveal('移项得2×(5-x)=4，解得x=3。验证：2×(5-3)=4，成立。', '3');
  assert.ok(v.ok !== false, '代入验证段不应导致误杀: ' + JSON.stringify(v));
});

test('verifyReveal：代入验证段 2(5-3)=4 不误杀（无结论词，解值在验证段前）', () => {
  // 变体：验证段用 2(5-3)=4 写法（省略乘号），正确解 x=3 用"得"引出
  var v = E.verifyReveal('2(5-x)=4，得x=3。验证2(5-3)=4。', '3');
  assert.ok(v.ok !== false, '代入验证段不应导致误杀: ' + JSON.stringify(v));
});

test('verifyReveal：代入验证段排除后仍能正确判错（真错值不被放过）', () => {
  // x=5 是错的（答案 3），验证段 2×(5-5)=0 的右值 0 也不该当候选
  // solutionClaims 不收"得x=5" → 排除验证段后无候选 → ok:null（不误杀，也不误判对）
  var v = E.verifyReveal('2(5-x)=4，得x=5。验证2(5-5)=0。', '3');
  assert.ok(v.ok !== false, '验证段右值不应误杀: ' + JSON.stringify(v));
});

/* ---------------- 与 explain.js 的集成：reveal 校验失败整轮回退静态讲解 ---------------- */

function loadExplain() {
  const g = globalThis;
  g.window = g;
  g.DiagEngine = E;
  delete require.cache[require.resolve('../diagnose/explain.js')];
  require('../diagnose/explain.js');
  return g.Explain;
}

function mockLLM(revealText) {
  const body = { choices: [{ message: { content: JSON.stringify({ prompt: '先想想第一步？', hint: '移项要变号。', reveal: revealText }) } }] };
  const real = globalThis.fetch;
  globalThis.fetch = function () { return Promise.resolve({ ok: true, json: function () { return Promise.resolve(body); } }); };
  return function () { globalThis.fetch = real; };
}

const asyncTests = [];
function testAsync(name, fn) { asyncTests.push({ name: name, fn: fn }); }

testAsync('Explain.generate：reveal 数值正确 -> from=llm', async () => {
  const X = loadExplain();
  X._cache.clear();
  const q = { id: 'o2-ok', type: 'numeric', prompt: '解方程 2(x-3)=4-(x+1)。', answer: '3' };
  const restore = mockLLM('去括号得2x-6=4-x-1，移项合并得3x=9，所以x=3。');
  try {
    const r = await X.generate(T_A, q, '1');
    assert.strictEqual(r.from, 'llm');
    assert.strictEqual(r.steps.length, 3);
    assert.ok(r.steps[2].text.indexOf('x=3') >= 0);
  } finally { restore(); }
});

testAsync('Explain.generate：reveal 数值算错 -> 整轮回退静态讲解（from=static）', async () => {
  const X = loadExplain();
  X._cache.clear();
  const q = { id: 'o2-bad', type: 'numeric', prompt: '解方程 2(x-3)=4-(x+1)。', answer: '3' };
  const wrong = '去括号得2x-6=4-x-1，移项合并得3x=3，所以x=1。';
  const restore = mockLLM(wrong);
  try {
    const r = await X.generate(T_A, q, '1');
    assert.strictEqual(r.from, 'static');
    assert.deepStrictEqual(r.steps, E.socraticSteps(T_A, q));
    assert.ok(r.steps[2].text.indexOf(wrong.slice(-4)) < 0, '错值讲解不能留在 steps 里');
  } finally { restore(); }
});

testAsync('Explain.generate：网关异常仍回退静态（契约不变：永不 reject）', async () => {
  const X = loadExplain();
  X._cache.clear();
  const q = { id: 'o2-offline', type: 'numeric', prompt: 'x+2=5', answer: '3' };
  const real = globalThis.fetch;
  globalThis.fetch = function () { return Promise.reject(new Error('econnrefused')); };
  try {
    const r = await X.generate(T_A, q, '1');
    assert.strictEqual(r.from, 'static');
  } finally { globalThis.fetch = real; }
});

testAsync('Explain.generate：reveal 无可比对数值 -> 保留 llm（不误杀）', async () => {
  const X = loadExplain();
  X._cache.clear();
  const q = { id: 'o2-noclaim', type: 'numeric', prompt: 'x+2=5', answer: '3' };
  const restore = mockLLM('先看未知数在哪一边，再想要不要移项。');
  try {
    const r = await X.generate(T_A, q, '1');
    assert.strictEqual(r.from, 'llm');
  } finally { restore(); }
});

testAsync('Explain._userPrompt：含标准答案声明（单解）', async () => {
  const X = loadExplain();
  const q = { id: 'o2-feed', type: 'numeric', prompt: '解方程 2(x-3)=4-(x+1)。', answer: '3' };
  const p = X._userPrompt(T_A, q, '1');
  assert.ok(p.indexOf('本题目标准答案：3') >= 0, 'userPrompt 应含标准答案声明: ' + p);
  assert.ok(p.indexOf('你的 reveal 最终解值必须与此一致') >= 0, 'userPrompt 应含一致性约束提示: ' + p);
});

testAsync('Explain._userPrompt：多解答案原样拼入（全角逗号分隔）', async () => {
  const X = loadExplain();
  const q = { id: 'o2-feed2', type: 'numeric', prompt: '解方程 x²-x-6=0。', answer: '-2，3' };
  const p = X._userPrompt(T_A, q, '1');
  assert.ok(p.indexOf('本题目标准答案：-2，3') >= 0, '多解答案应原样拼入: ' + p);
});

testAsync('Explain._userPrompt：无 answer 字段时不添加答案声明', async () => {
  const X = loadExplain();
  const q = { id: 'o2-feed3', type: 'short', prompt: '简答题', answer: '' };
  const p = X._userPrompt(T_A, q, '');
  assert.ok(p.indexOf('本题目标准答案') < 0, '无 answer 时不应有答案声明: ' + p);
});

/* ============================================ 表达式判题（O4：思路式子安全求值） */
test('表达式判题：思路式子等价 → correct(expr-eval)', () => {
  const q = { id: 'x1', type: 'numeric', prompt: '某商品进价30元…求最大利润。', answer: '1125' };
  const r = E.judgeQuestion(q, '(10+5)*(100-5*5)');
  assert.strictEqual(r.verdict, 'correct');
  assert.strictEqual(r.reason, 'expr-eval');
});

test('表达式判题：思路式子算错 → wrong(expr-mismatch)', () => {
  const q = { id: 'x2', type: 'numeric', prompt: '某商品进价30元…求最大利润。', answer: '1125' };
  const r = E.judgeQuestion(q, '(100-(40-30)*5)*(40-30)');   // =500
  assert.strictEqual(r.verdict, 'wrong');
  assert.strictEqual(r.reason, 'expr-mismatch');
});

test('表达式判题：全角符号与乘号被归一（×→*、全角括号）', () => {
  const q = { id: 'x3', type: 'numeric', prompt: '计算', answer: '15' };
  assert.strictEqual(E.judgeQuestion(q, '（10＋5）').verdict, 'correct');
  assert.strictEqual(E.judgeQuestion(q, '10+5×1').verdict, 'correct');
});

test('表达式判题：分数/小数等价在容差内 → correct', () => {
  const q = { id: 'x4', type: 'numeric', prompt: '计算', answer: '1/3' };
  assert.strictEqual(E.judgeQuestion(q, '1÷3').verdict, 'correct');
  const q2 = { id: 'x5', type: 'numeric', prompt: '计算', answer: '2' };
  assert.strictEqual(E.judgeQuestion(q2, '4/2').verdict, 'correct');
});

test('表达式判题：含字母/危险输入 → 拒绝求值，回 manual（不误判）', () => {
  const q = { id: 'x6', type: 'numeric', prompt: '计算', answer: '3' };
  assert.strictEqual(E.judgeQuestion(q, 'globalThis.process').verdict, 'manual');
  assert.strictEqual(E.judgeQuestion(q, 'x+1').verdict, 'manual');
  assert.strictEqual(E.judgeQuestion(q, 'constructor.constructor("return 1")()').verdict, 'manual');
});

test('表达式判题：调试用 evalExpr 导出存在', () => {
  assert.strictEqual(typeof E.evalExpr, 'function');
  assert.strictEqual(E.evalExpr('(100-(40-30)*5)*(40-30)'), 500);
  assert.strictEqual(E.evalExpr('x+1'), null);
});

/* ============================================ Markdown 残留清理（孩子看不懂 **、`、#） */
testAsync('Explain.generate：reveal 里的 ** 加粗标记被剥掉', async () => {
  const X = loadExplain();
  X._cache.clear();
  const q = { id: 'md-1', type: 'numeric', prompt: '用配方法说明二次式的最值。', answer: '3' };
  const restore = mockLLM('配方法就是**配成完全平方**的意思，目标是变成`a(x-h)²+k`的样子。');
  try {
    const r = await X.generate(T_A, q, '1');
    assert.strictEqual(r.from, 'llm');
    assert.ok(r.steps[2].text.indexOf('**') < 0, '不应有 **: ' + r.steps[2].text);
    assert.ok(r.steps[2].text.indexOf('配成完全平方') >= 0, '加粗内容应保留: ' + r.steps[2].text);
    assert.ok(r.steps[2].text.indexOf('`') < 0, '不应有反引号: ' + r.steps[2].text);
    assert.ok(r.steps[2].text.indexOf('a(x-h)²+k') >= 0, '公式应保留: ' + r.steps[2].text);
  } finally { restore(); }
});

testAsync('Explain.generate：`#` 标题与行首列表符被剥掉', async () => {
  const X = loadExplain();
  X._cache.clear();
  const q = { id: 'md-2', type: 'numeric', prompt: '解方程 x+2=5', answer: '3' };
  const restore = mockLLM('# 完整解析\n- 第一步移项\n> 注意变号\n所以 x=3。');
  try {
    const r = await X.generate(T_A, q, '1');
    assert.strictEqual(r.from, 'llm');
    assert.ok(r.steps[2].text.indexOf('#') < 0, '不应有 #: ' + r.steps[2].text);
    assert.ok(r.steps[2].text.indexOf('- 第一步') < 0, '列表符应剥掉: ' + r.steps[2].text);
    assert.ok(r.steps[2].text.indexOf('>') < 0, '不应有 >: ' + r.steps[2].text);
    assert.ok(r.steps[2].text.indexOf('第一步移项') >= 0, '正文应保留: ' + r.steps[2].text);
  } finally { restore(); }
});

testAsync('Explain.ask：追问回答里的 ** 也被剥掉', async () => {
  const X = loadExplain();
  const q = { id: 'md-3', type: 'numeric', prompt: 'x+2=5', answer: '3' };
  const body = { choices: [{ message: { content: '移项就是**把数挪到另一边**，注意`变号`。' } }] };
  const real = globalThis.fetch;
  globalThis.fetch = function () { return Promise.resolve({ ok: true, json: function () { return Promise.resolve(body); } }); };
  try {
    const r = await X.ask(T_A, q, '1', [], '什么叫移项？');
    assert.strictEqual(r.from, 'llm');
    assert.ok(r.text.indexOf('**') < 0, '追问回答不应有 **: ' + r.text);
    assert.ok(r.text.indexOf('把数挪到另一边') >= 0, '内容应保留: ' + r.text);
  } finally { globalThis.fetch = real; }
});

/* ============================================ LaTeX 残留清理（\sqrt、\frac 等转纯文本） */
testAsync('Explain.generate：\\sqrt{5} → √5', async () => {
  const X = loadExplain();
  X._cache.clear();
  const q = { id: 'ltx-1', type: 'numeric', prompt: '用配方法解 x²-4x-1=0', answer: '2±√5' };
  const restore = mockLLM('两边开平方得 x-2=\\pm\\sqrt{5}，所以 x=2\\pm\\sqrt{5}。');
  try {
    const r = await X.generate(T_A, q, '1');
    assert.strictEqual(r.from, 'llm');
    assert.ok(r.steps[2].text.indexOf('\\sqrt') < 0, '不应有 \\sqrt: ' + r.steps[2].text);
    assert.ok(r.steps[2].text.indexOf('\\pm') < 0, '不应有 \\pm: ' + r.steps[2].text);
    assert.ok(r.steps[2].text.indexOf('√5') >= 0, '应为 √5: ' + r.steps[2].text);
    assert.ok(r.steps[2].text.indexOf('±') >= 0, '应为 ±: ' + r.steps[2].text);
  } finally { restore(); }
});

testAsync('Explain.generate：\\frac{1}{2} → (1)/(2)', async () => {
  const X = loadExplain();
  X._cache.clear();
  const q = { id: 'ltx-2', type: 'numeric', prompt: '解方程 2x²-3x-2=0', answer: '2，-1/2' };
  const restore = mockLLM('由求根公式 x=\\frac{3\\pm5}{4}，得 x=2 或 x=-\\frac{1}{2}。');
  try {
    const r = await X.generate(T_A, q, '1');
    assert.strictEqual(r.from, 'llm');
    assert.ok(r.steps[2].text.indexOf('\\frac') < 0, '不应有 \\frac: ' + r.steps[2].text);
    assert.ok(r.steps[2].text.indexOf('(3±5)/(4)') >= 0, '分式应转成斜杠: ' + r.steps[2].text);
  } finally { restore(); }
});

testAsync('Explain.ask：LaTeX 命令在追问里也被转换', async () => {
  const X = loadExplain();
  const q = { id: 'ltx-3', type: 'numeric', prompt: 'x²=5', answer: '±√5' };
  const body = { choices: [{ message: { content: '开平方得 x=\\pm\\sqrt{5}。' } }] };
  const real = globalThis.fetch;
  globalThis.fetch = function () { return Promise.resolve({ ok: true, json: function () { return Promise.resolve(body); } }); };
  try {
    const r = await X.ask(T_A, q, '1', [], '怎么开方？');
    assert.strictEqual(r.from, 'llm');
    assert.ok(r.text.indexOf('\\') < 0, '不应有反斜杠: ' + r.text);
    assert.ok(r.text.indexOf('±√5') >= 0, '应为 ±√5: ' + r.text);
  } finally { globalThis.fetch = real; }
});

/* ============================================ 函数实验室 fromPrompt 解析 */
const Funclab = require('../diagnose/funclab.js');

test('Funclab.顶点式 y=(x-1)²+2', function () {
  assert.deepStrictEqual(Funclab.fromPrompt('y=(x-1)²+2 的顶点、对称轴及平移？'), { type: 'quadratic', a: 1, h: 1, k: 2 });
});
test('Funclab.顶点式 y=2(x+3)²-5', function () {
  assert.deepStrictEqual(Funclab.fromPrompt('求抛物线 y=2(x+3)²-5 的顶点坐标'), { type: 'quadratic', a: 2, h: -3, k: -5 });
});
test('Funclab.一般式 y=x²-4x+3 -> 顶点 (2,-1)', function () {
  assert.deepStrictEqual(Funclab.fromPrompt('把 y=x²-4x+3 化为顶点式'), { type: 'quadratic', a: 1, h: 2, k: -1 });
});
test('Funclab.一般式 y=-2x²+8x-3 -> 顶点 (2,5)', function () {
  assert.deepStrictEqual(Funclab.fromPrompt('求抛物线 y=-2x²+8x-3 的顶点坐标'), { type: 'quadratic', a: -2, h: 2, k: 5 });
});
test('Funclab.方程 x²-4x-1=0 -> 顶点 (2,-5)', function () {
  assert.deepStrictEqual(Funclab.fromPrompt('用配方法解 x²-4x-1=0。'), { type: 'quadratic', a: 1, h: 2, k: -5 });
});
test('Funclab.方程 2x²-8x+1=0 -> 顶点 (2,-7)', function () {
  assert.deepStrictEqual(Funclab.fromPrompt('把 2x²-8x+1=0 配方成 2(x-m)²=n 的形式，依次求 m 与 n 的值（用逗号隔开）。'), { type: 'quadratic', a: 2, h: 2, k: -7 });
});
test('Funclab.一次函数 y=-2x+4', function () {
  assert.deepStrictEqual(Funclab.fromPrompt('求 y=-2x+4 与坐标轴的交点。'), { type: 'linear', k: -2, b: 4 });
});
test('Funclab.一次函数 y=3x-6', function () {
  assert.deepStrictEqual(Funclab.fromPrompt('直线 y=3x-6 与 x 轴交点的横坐标是多少？'), { type: 'linear', k: 3, b: -6 });
});
test('Funclab.一次函数 y=x+1 系数省略', function () {
  assert.deepStrictEqual(Funclab.fromPrompt('直线 y=x+1 与 y=-x+3 的交点坐标？'), { type: 'linear', k: 1, b: 1 });
});
test('Funclab.反比例 y=6/x', function () {
  assert.deepStrictEqual(Funclab.fromPrompt('点 P 在 y=6/x 上，PA⊥x 轴于 A，△POA 面积是多少？'), { type: 'inverse', k: 6 });
});
test('Funclab.反比例 y=-8/x', function () {
  assert.deepStrictEqual(Funclab.fromPrompt('点 P 在反比例函数 y=-8/x 的图象上'), { type: 'inverse', k: -8 });
});
test('Funclab.参数字母不解析（y=kx+b 概念题）', function () {
  assert.strictEqual(Funclab.fromPrompt('一次函数 y=kx+b 的图象经过一、二、四象限，则（ ）'), null);
  assert.strictEqual(Funclab.fromPrompt('y=k/x 的图象过点 (2,3)，k 是多少？'), null);
  assert.strictEqual(Funclab.fromPrompt('y=(m-2)x²+3x-1 是二次函数'), null);
});
test('Funclab.解析不出返回 null', function () {
  assert.strictEqual(Funclab.fromPrompt('下列函数中，是二次函数的是哪一个？'), null);
  assert.strictEqual(Funclab.fromPrompt(''), null);
  assert.strictEqual(Funclab.fromPrompt('设一边长为 x cm，面积为 y cm²'), null);
});
test('Funclab.白名单与类型匹配', function () {
  assert.strictEqual(Funclab.topicKind('cnm_202'), 'linear');
  assert.strictEqual(Funclab.topicKind('cnm_221'), 'quadratic');
  assert.strictEqual(Funclab.topicKind('cnm_238'), 'inverse');
  assert.strictEqual(Funclab.topicKind('cnm_101'), null);
  assert.strictEqual(Funclab.topicSupported('cnm_221'), true);
  // 知识点函数类型与题面解析类型必须一致才挂
  assert.strictEqual(Funclab.labFor('cnm_202', '把 y=-2x²+8x-3 化为顶点式'), null);   // 题面是二次，知识点是一次 → 错配
  assert.strictEqual(Funclab.labFor('cnm_221', '用配方法解 x²-4x-1=0。').type, 'quadratic');
  assert.deepStrictEqual(Funclab.labFor('cnm_202', '求 y=-2x+4 与坐标轴的交点。'), { type: 'linear', k: -2, b: 4 });
  assert.deepStrictEqual(Funclab.labFor('cnm_238', '点 P 在 y=-8/x 的图象上'), { type: 'inverse', k: -8 });
});
test('Funclab.公式美化', function () {
  assert.strictEqual(Funclab.formatFormula({ type: 'quadratic', a: 1, h: 2, k: -5 }), 'y = (x - 2)² - 5');
  assert.strictEqual(Funclab.formatFormula({ type: 'quadratic', a: -2, h: 0, k: 3 }), 'y = -2x² + 3');
  assert.strictEqual(Funclab.formatFormula({ type: 'linear', k: 2, b: -3 }), 'y = 2x - 3');
  assert.strictEqual(Funclab.formatFormula({ type: 'linear', k: -1, b: 0 }), 'y = -x');
  assert.strictEqual(Funclab.formatFormula({ type: 'inverse', k: 6 }), 'y = 6 / x');
  assert.strictEqual(Funclab.formatFormula({ type: 'inverse', k: -8 }), 'y = -8 / x');
  assert.strictEqual(Funclab.formatFormula({ type: 'inverse', k: -1 }), 'y = -1 / x');
  assert.strictEqual(Funclab.formatFormula({ type: 'inverse', k: 1 }), 'y = 1 / x');
});

(async function () {
  for (const t of asyncTests) {
    try { await t.fn(); passed++; console.log('  ok   ' + t.name); }
    catch (e) { failed++; console.log('  FAIL ' + t.name + '\n       ' + (e && e.stack || e).split('\n').slice(0, 4).join('\n       ')); }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
