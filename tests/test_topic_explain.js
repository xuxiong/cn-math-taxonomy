#!/usr/bin/env node
/* O4 卡 A：diagnose/topic-explain.js 纯模块测试（node tests/test_topic_explain.js）
 *
 * 硬约束：
 *   - 零网络：开头把 global.fetch 换成会抛错的计数桩，末尾断言调用次数为 0；
 *   - 零 DOM：不引 jsdom，模块本身也不许碰 document / localStorage / innerHTML；
 *   - 真 require 模块（不是复制一份实现）。
 * 口径来源：docs/o4-topic-explain.md（§4 语言四档 / §5 闸门 / §8 多轮）。
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

/* ------------------------------------------------ 零网络桩（必须在 require 模块之前装好） */

let fetchCalls = 0;
global.fetch = function () {
  fetchCalls++;
  throw new Error('测试禁止联网：fetch 被调用了');
};

const ROOT = path.join(__dirname, '..');
const T = require(path.join(ROOT, 'diagnose', 'topic-explain.js'));

const TOPICS = require(path.join(ROOT, 'data', 'topics.json'));
const DEPS = require(path.join(ROOT, 'data', 'dependencies.json'));
const STD = require(path.join(ROOT, 'data', 'cn-curriculum-standards.json'));
const QIDX = require(path.join(ROOT, 'data', 'questions-index.json'));

/* ------------------------------------------------ 数据访问小工具（测试侧，不是模块的一部分） */

const SUBJECT_BY_PREFIX = {
  cnm: 'math', cne: 'english', cnc: 'chinese', cnp: 'physics', cns: 'science',
  cnd: 'morality', cnh: 'history', cng: 'geography', cnb: 'biology', cnk: 'chemistry'
};

function topicById(id) {
  const t = TOPICS.find((x) => x.id === id);
  assert.ok(t, '测试数据里找不到知识点 ' + id);
  return t;
}

const QUESTIONS_CACHE = {};
function questionsFor(topic) {
  const key = SUBJECT_BY_PREFIX[String(topic.id).split('_')[0]] + '|' + topic.grade + '|' + topic.chapter;
  const file = QIDX[key];
  if (!file) return [];
  if (!QUESTIONS_CACHE[file]) {
    QUESTIONS_CACHE[file] = require(path.join(ROOT, 'data', 'questions', file));
  }
  return QUESTIONS_CACHE[file].filter((q) => q.topicId === topic.id);
}

function buildFor(topic, opts) {
  return T.buildInputs({
    topic,
    questions: questionsFor(topic),
    standardsById: STD,
    deps: DEPS,
    topics: TOPICS,
    opts
  });
}

/* 一份能过全部闸门的讲解（1-2 年级档：每句 ≤12 字，各段 ≤40/40/60/70/40）。
 * 卡 A′ 起 early 档禁用符号算式、demo 必须是生活场景，所以 demo 用生活句而不用 2+1=3
 * （算式类正例另用 P006_PRIMARY 隔离，见第 8 节）。
 * 卡 A″ 起 COMMON_SMALL_DIGITS 只剩 [0,1]，这份公共 fixture 因此只用 1：
 * 这样它在任何素材下都不依赖白名单放行，避免无关用例被数字闸连坐。 */
const GOOD = {
  what: '加法就是把两部分合起来。',
  why: '买东西算钱要用加法。',
  how: '先数第一堆。再数第二堆。从第一个数接着数。',
  demo: '妈妈买了 1 个苹果。一共 1 个。',
  trap: '别把两堆数丢了。'
};
function segsWith(patch) {
  return Object.assign({}, GOOD, patch);
}

/* 合成知识点：G1 边界在初中档（sentenceMax === null）上更好控制 */
const MID_TOPIC = {
  id: 'cnm_test_mid', name: '测试知识点乙', grade: 7, semester: '上', chapter: '测试章节',
  description: '用于测试的合成知识点。', mastery_criteria: ['测试标准一'], standards: [], type: 'conceptual'
};
const MID_INPUTS = T.buildInputs({
  topic: MID_TOPIC, questions: [], standardsById: {}, deps: [], topics: [MID_TOPIC]
});

/* 合成知识点：没有课标、题目没有解析（真实数据里 94.8% 有解析，那 5.2% 也要能组装） */
const PLAIN_TOPIC = {
  id: 'cnm_test_plain', name: '测试知识点丙', grade: 4, semester: '下', chapter: '测试章节二',
  description: '另一个用于测试的合成知识点。', mastery_criteria: ['测试标准二'], standards: [], type: 'conceptual'
};
const PLAIN_INPUTS = T.buildInputs({
  topic: PLAIN_TOPIC,
  questions: [
    { id: 'q1', topicId: PLAIN_TOPIC.id, difficulty: 'basic', type: 'numeric', prompt: '1 加 1 是几？', answer: '2' },
    { id: 'q2', topicId: PLAIN_TOPIC.id, difficulty: 'standard', type: 'numeric', prompt: '2 加 3 是几？', answer: '5' }
  ],
  standardsById: {},
  deps: [],
  topics: [PLAIN_TOPIC]
});

/* 合成知识点：带 1 条课标、初中档（无句长限制）——G4 正负例用，避免 early 档 12 字句长把编号本身判超 */
const STD_TOPIC = {
  id: 'cnm_test_std', name: '测试知识点戊', grade: 7, semester: '上', chapter: '测试章节三',
  description: '带课标的合成知识点。', mastery_criteria: ['测试标准三'], type: 'conceptual',
  standards: [{ id: 'cms-2022:1.NA.04', confidence: 'exact' }]
};
const STD_INPUTS = T.buildInputs({
  topic: STD_TOPIC, questions: [], standardsById: STD, deps: [], topics: [STD_TOPIC]
});

/* ------------------------------------------------ 内存版 localStorage-like */
function memStorage() {
  const m = new Map();
  return {
    get length() { return m.size; },
    key(i) { return Array.from(m.keys())[i] || null; },
    getItem(k) { return m.has(k) ? m.get(k) : null; },
    setItem(k, v) { m.set(k, String(v)); },
    removeItem(k) { m.delete(k); }
  };
}

/* ================================================================
 * 1. 结构约束：模块必须真「纯」（零网络 / 零 DOM / 零存储直连 / 无 Function 求值）
 * ================================================================ */

/* 剥掉注释后的源码：说明性注释里提到 localStorage / document 不算命中 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}
const MODULE_SRC = fs.readFileSync(path.join(ROOT, 'diagnose', 'topic-explain.js'), 'utf8');
const MODULE_CODE = stripComments(MODULE_SRC);

console.log('\n--- 结构约束：纯模块 ---');

test('topic-explain.js 不含 fetch 调用（零网络）', () => {
  assert.ok(!/\bfetch\s*\(/.test(MODULE_CODE), '发现 fetch 调用');
});

test('topic-explain.js 不直连 localStorage（storage 必须注入）', () => {
  assert.ok(!/localStorage/.test(MODULE_CODE), '发现 localStorage');
});

test('topic-explain.js 不碰 document / window（零 DOM）', () => {
  assert.ok(!/\bdocument\b/.test(MODULE_CODE), '发现 document');
  assert.ok(!/\bwindow\b/.test(MODULE_CODE), '发现 window');
});

test('topic-explain.js 无 innerHTML / insertAdjacentHTML / document.write', () => {
  assert.ok(!/innerHTML/.test(MODULE_CODE), '发现 innerHTML');
  assert.ok(!/insertAdjacentHTML/.test(MODULE_CODE), '发现 insertAdjacentHTML');
  assert.ok(!/document\.write/.test(MODULE_CODE), '发现 document.write');
});

test('topic-explain.js 无 Function 求值（求值只走 llm-eval 的出口）', () => {
  assert.ok(!/\bnew\s+Function\b/.test(MODULE_CODE), '发现 new Function');
  assert.ok(!/\bFunction\s*\(/.test(MODULE_CODE), '发现 Function(');
});

test('卡面 §3 的 API 名一个不少（卡 B 照着调）', () => {
  ['levelOf', 'limitsOf', 'subjectTone', 'prereqsOf', 'buildInputs', 'explainMessages',
    'parseExplain', 'checkExplain', 'chatMessages', 'checkReply', 'cacheKey',
    'readCache', 'writeCache', 'pruneCache'].forEach((name) => {
    assert.strictEqual(typeof T[name], 'function', '缺函数 ' + name);
  });
  assert.strictEqual(T.MAX_ROUNDS, 10);
  assert.strictEqual(T.WINDOW_ROUNDS, 6);
  assert.strictEqual(T.WINDOW_CHARS, 4000);
});

/* ================================================================
 * 2. levelOf / limitsOf（§4.2 语言四档）
 * ================================================================ */

console.log('\n--- levelOf / limitsOf ---');

test('levelOf：1、2 → early', () => {
  assert.strictEqual(T.levelOf(1), 'early');
  assert.strictEqual(T.levelOf(2), 'early');
});

test('levelOf：3、6 → primary', () => {
  assert.strictEqual(T.levelOf(3), 'primary');
  assert.strictEqual(T.levelOf(6), 'primary');
});

test('levelOf：7、9 → middle', () => {
  assert.strictEqual(T.levelOf(7), 'middle');
  assert.strictEqual(T.levelOf(9), 'middle');
});

test('levelOf：10、16 → high', () => {
  assert.strictEqual(T.levelOf(10), 'high');
  assert.strictEqual(T.levelOf(16), 'high');
});

test('limitsOf：幼儿级 40/40/60/70/40，追问 60，每句 12', () => {
  /* 卡 A′：多返回 forbidSymbols / requireRealLife 两键；这里仍用整对象 deepStrictEqual
   * （比只挑三键更强），只是把两键按 early=true 写进字面量。 */
  assert.deepStrictEqual(T.limitsOf('early'), {
    segMax: { what: 40, why: 40, how: 60, demo: 70, trap: 40 },
    replyMax: 60,
    sentenceMax: 12,
    forbidSymbols: true,
    requireRealLife: true
  });
});

test('limitsOf：小学高年级 60/60/90/110/60，追问 120，每句 20', () => {
  assert.deepStrictEqual(T.limitsOf('primary'), {
    segMax: { what: 60, why: 60, how: 90, demo: 110, trap: 60 },
    replyMax: 120,
    sentenceMax: 20,
    forbidSymbols: false,
    requireRealLife: false
  });
});

test('limitsOf：初中 80/80/120/150/80，追问 150，无句长限制', () => {
  assert.deepStrictEqual(T.limitsOf('middle'), {
    segMax: { what: 80, why: 80, how: 120, demo: 150, trap: 80 },
    replyMax: 150,
    sentenceMax: null,
    forbidSymbols: false,
    requireRealLife: false
  });
});

test('limitsOf：高中 100/80/140/160/100，追问 180，无句长限制', () => {
  assert.deepStrictEqual(T.limitsOf('high'), {
    segMax: { what: 100, why: 80, how: 140, demo: 160, trap: 100 },
    replyMax: 180,
    sentenceMax: null,
    forbidSymbols: false,
    requireRealLife: false
  });
});

test('limitsOf 返回副本：改返回值不污染常量', () => {
  const L = T.limitsOf('early');
  L.segMax.what = 999;
  assert.strictEqual(T.limitsOf('early').segMax.what, 40);
});

/* ================================================================
 * 3. subjectTone（§6：10 学科 + 未知兜底）
 * ================================================================ */

console.log('\n--- subjectTone ---');

test('subjectTone：10 学科都有 key / tone / forbid', () => {
  ['math', 'physics', 'chemistry', 'biology', 'science',
    'chinese', 'english', 'history', 'geography', 'morality'].forEach((key) => {
    const t = T.subjectTone(key);
    assert.strictEqual(t.key, key, key + ' 的 key 不对');
    assert.ok(typeof t.tone === 'string' && t.tone.length >= 6, key + ' 缺语气描述');
    assert.ok(Array.isArray(t.forbid) && t.forbid.length >= 1, key + ' 缺禁用项');
  });
});

test('subjectTone：历史/地理/道法的禁用项各自到位', () => {
  assert.ok(T.subjectTone('history').forbid.join().indexOf('年份') >= 0);
  assert.ok(T.subjectTone('geography').forbid.join().indexOf('数据') >= 0);
  assert.ok(T.subjectTone('morality').forbid.join().indexOf('法条') >= 0);
});

test('subjectTone：未知学科 / 空值走兜底，不抛错', () => {
  assert.strictEqual(T.subjectTone('astrology').key, 'general');
  assert.strictEqual(T.subjectTone('').key, 'general');
  assert.strictEqual(T.subjectTone(null).key, 'general');
  assert.ok(T.subjectTone('astrology').tone.length > 0);
});

test('subjectTone：中文学科名归一（数学 → math）', () => {
  assert.strictEqual(T.subjectTone('数学').key, 'math');
});

test('subjectTone 返回副本：改 forbid 不污染常量', () => {
  const t = T.subjectTone('math');
  t.forbid.push('污染');
  assert.ok(T.subjectTone('math').forbid.indexOf('污染') < 0);
});

/* ================================================================
 * 4. prereqsOf
 * ================================================================ */

console.log('\n--- prereqsOf ---');

test('prereqsOf：cnm_p006 的先修是 cnm_p004（hard）', () => {
  const rows = T.prereqsOf('cnm_p006', DEPS, TOPICS);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].id, 'cnm_p004');
  assert.strictEqual(rows[0].strength, 'hard');
  assert.ok(rows[0].name.length > 0, '先修名要解析出来');
});

test('prereqsOf：没有先修的点返回空数组', () => {
  assert.deepStrictEqual(T.prereqsOf('cnm_p001', DEPS, TOPICS), []);
});

test('prereqsOf：默认上限 6，hard 排在 soft 前面', () => {
  const deps = [
    { topicId: 's', prerequisiteId: 'a', strength: 'soft' },
    { topicId: 's', prerequisiteId: 'b', strength: 'hard' },
    { topicId: 's', prerequisiteId: 'c', strength: 'soft' },
    { topicId: 's', prerequisiteId: 'd', strength: 'hard' }
  ];
  const topics = [{ id: 'a', name: '甲甲甲甲' }, { id: 'b', name: '乙乙乙乙' },
    { id: 'c', name: '丙丙丙丙' }, { id: 'd', name: '丁丁丁丁' }];
  const rows = T.prereqsOf('s', deps, topics);
  assert.strictEqual(rows.length, 4);
  assert.deepStrictEqual(rows.map((r) => r.strength), ['hard', 'hard', 'soft', 'soft']);
  assert.deepStrictEqual(rows.map((r) => r.id), ['b', 'd', 'a', 'c']);
});

test('prereqsOf：max 生效且去重', () => {
  const deps = [
    { topicId: 's', prerequisiteId: 'a', strength: 'hard' },
    { topicId: 's', prerequisiteId: 'a', strength: 'soft' },
    { topicId: 's', prerequisiteId: 'b', strength: 'hard' },
    { topicId: 's', prerequisiteId: 'c', strength: 'hard' }
  ];
  const rows = T.prereqsOf('s', deps, [], 2);
  assert.strictEqual(rows.length, 2);
  assert.deepStrictEqual(rows.map((r) => r.id), ['a', 'b']);
  assert.strictEqual(T.prereqsOf('s', deps, [], 0).length, 0);
});

/* ================================================================
 * 5. buildInputs（§3 素材八项）
 * ================================================================ */

console.log('\n--- buildInputs ---');

const P006 = buildFor(topicById('cnm_p006'));

/* 卡 A′：early 档禁符号算式，而 G3（算式一致性）的正例必须带符号算式才可能成立 →
 * 用同一份素材把语言档抬到小学高年级来隔离早期档规则。题面/答案/白名单一个字不改。 */
const P006_PRIMARY = Object.assign({}, P006, { level: 'primary', limits: T.limitsOf('primary') });

test('buildInputs：基本字段与学段档（cnm_p006 / 1 年级 → early）', () => {
  assert.strictEqual(P006.topicId, 'cnm_p006');
  assert.strictEqual(P006.level, 'early');
  assert.deepStrictEqual(P006.limits, T.limitsOf('early'));
  assert.strictEqual(P006.tone.key, 'math');
  assert.ok(P006.desc.length > 0);
  assert.ok(P006.criteria.length >= 1 && P006.criteria.length <= 3);
});

test('buildInputs：课标原文按 id 解析出来（standardsById 传整份课标库）', () => {
  assert.ok(P006.standards.length >= 1);
  P006.standards.forEach((s) => {
    assert.ok(/^cms-2022:/.test(s.id), '课标 id 形态不对：' + s.id);
    assert.ok(s.text.length > 5, '课标原文没解析出来：' + s.id);
  });
  assert.strictEqual(P006.noStandard, false);
});

test('buildInputs：例题 ≤3 道，按难度升序，带题面/答案/解析', () => {
  assert.ok(P006.examples.length >= 2 && P006.examples.length <= 3);
  const rank = { basic: 0, standard: 1, challenge: 2, advanced: 3 };
  for (let i = 1; i < P006.examples.length; i++) {
    assert.ok(rank[P006.examples[i - 1].difficulty] <= rank[P006.examples[i].difficulty],
      '例题没有按难度升序：' + P006.examples.map((e) => e.difficulty).join(','));
  }
  P006.examples.forEach((e) => {
    assert.ok(e.prompt.length > 0);
    assert.ok(e.answer.length > 0);
  });
  assert.ok(P006.examples[0].explanation.length > 0, '有解析的题要带上解析');
});

test('buildInputs：先修名进 whitelist，白名单 = 本点 ∪ 直接先修', () => {
  assert.ok(P006.whitelist.indexOf(P006.name) >= 0);
  P006.prereqs.forEach((p) => assert.ok(P006.whitelist.indexOf(p.name) >= 0, '先修名没进白名单：' + p.name));
  assert.strictEqual(P006.whitelist.length, 1 + P006.prereqs.length);
});

test('buildInputs：题面拼接文本与题库答案集合可用于 G3', () => {
  assert.ok(P006.questionText.indexOf('2 朵花') >= 0);
  assert.deepStrictEqual(P006.answerValues.slice().sort(), [3, 4]);
});

test('buildInputs：cnm_130 无课标 → noStandard=true 且 standards 为空', () => {
  const inputs = buildFor(topicById('cnm_130'));
  assert.strictEqual(inputs.noStandard, true);
  assert.deepStrictEqual(inputs.standards, []);
});

test('buildInputs：cnm_192 无课标 → noStandard=true', () => {
  assert.strictEqual(buildFor(topicById('cnm_192')).noStandard, true);
});

test('buildInputs：无先修点 → prereqs 为空，白名单只有自己', () => {
  const inputs = buildFor(topicById('cnm_p001'));
  assert.deepStrictEqual(inputs.prereqs, []);
  assert.deepStrictEqual(inputs.whitelist, [inputs.name]);
});

test('buildInputs：无解析题只留题面与答案，不编造解析', () => {
  assert.strictEqual(PLAIN_INPUTS.examples.length, 2);
  PLAIN_INPUTS.examples.forEach((e) => {
    assert.ok(e.prompt.length > 0);
    assert.strictEqual(e.explanation, '');
  });
  assert.strictEqual(PLAIN_INPUTS.noStandard, true);
});

test('buildInputs：没有题也能组装（examples 空、answerValues 空）', () => {
  const inputs = T.buildInputs({
    topic: MID_TOPIC, questions: [], standardsById: {}, deps: [], topics: [MID_TOPIC]
  });
  assert.deepStrictEqual(inputs.examples, []);
  assert.deepStrictEqual(inputs.answerValues, []);
  assert.strictEqual(inputs.questionText, '');
});

test('buildInputs：缺 topic 直接抛错（不静默产出半份素材）', () => {
  assert.throws(() => T.buildInputs({}), /缺少 topic/);
});

/* ================================================================
 * 6. explainMessages（prompt）
 * ================================================================ */

console.log('\n--- explainMessages ---');

test('explainMessages：system + user 两条，角色固定', () => {
  const msgs = T.explainMessages(P006);
  assert.strictEqual(msgs.length, 2);
  assert.strictEqual(msgs[0].role, 'system');
  assert.strictEqual(msgs[1].role, 'user');
});

test('explainMessages：system 带学科语气 + 学段语言档 + 5 键要求', () => {
  const sys = T.explainMessages(P006)[0].content;
  assert.ok(sys.indexOf(P006.tone.tone) >= 0, '缺学科语气');
  assert.ok(sys.indexOf('12 字') >= 0, '缺句长档');
  assert.ok(sys.indexOf('40 字') >= 0, '缺段长档');
  ['what', 'why', 'how', 'demo', 'trap'].forEach((k) => {
    assert.ok(sys.indexOf(k) >= 0, 'system 没点名 JSON 键 ' + k);
  });
});

test('explainMessages：user 素材块含名称/介绍/掌握标准/课标原文/例题/先修', () => {
  const user = T.explainMessages(P006)[1].content;
  assert.ok(user.indexOf(P006.name) >= 0, '缺知识点名');
  assert.ok(user.indexOf(P006.desc) >= 0, '缺一句话介绍');
  assert.ok(user.indexOf(P006.criteria[0]) >= 0, '缺掌握标准');
  assert.ok(user.indexOf(P006.standards[0].id) >= 0, '缺课标编号');
  assert.ok(user.indexOf(P006.examples[0].prompt) >= 0, '缺例题题面');
  assert.ok(user.indexOf(P006.prereqs[0].name) >= 0, '缺先修名');
});

test('explainMessages：无课标点明说「暂无对应课标条目」', () => {
  const user = T.explainMessages(buildFor(topicById('cnm_130')))[1].content;
  assert.ok(user.indexOf('暂无对应课标条目') >= 0);
});

test('explainMessages：同样入参逐字节可复现（多轮锚点靠它稳定）', () => {
  assert.deepStrictEqual(T.explainMessages(P006), T.explainMessages(P006));
});

test('explainMessages：红线条目到位（只用素材数字 / 只用白名单知识点 / 示例必须算得对）', () => {
  const sys = T.explainMessages(P006)[0].content;
  assert.ok(sys.indexOf('数字只用素材里出现过的') >= 0, '缺数字红线');
  assert.ok(sys.indexOf('可以提到的知识点') >= 0, '缺白名单行');
  assert.ok(sys.indexOf('算出来的结果必须等于那道题的答案') >= 0, '缺示例一致性要求');
  assert.ok(sys.indexOf('人设') < 0 && sys.indexOf('人教版') < 0, '不许沿用 explain.js 的人设');
});

/* ================================================================
 * 7. parseExplain（半截 JSON 逐键抠）
 * ================================================================ */

console.log('\n--- parseExplain ---');

test('parseExplain：标准 JSON 5 键', () => {
  const r = T.parseExplain(JSON.stringify(GOOD));
  assert.ok(r.segs);
  assert.deepStrictEqual(Object.keys(r.segs).sort(), ['demo', 'how', 'trap', 'what', 'why']);
  assert.strictEqual(r.segs.what, GOOD.what);
});

test('parseExplain：带 ```json 围栏也能解析', () => {
  const r = T.parseExplain('```json\n' + JSON.stringify(GOOD) + '\n```');
  assert.ok(r.segs);
  assert.strictEqual(r.segs.trap, GOOD.trap);
});

test('parseExplain：半截 JSON（尾逗号 + 截断空白）逐键抠出来', () => {
  const raw = '{"what":"甲。","why":"乙。","how":"丙。","demo":"2+1=3。","trap":"丁。",}';
  const r = T.parseExplain(raw);
  assert.ok(r.segs, '应当逐键抠出来');
  assert.strictEqual(r.segs.how, '丙。');
});

test('parseExplain：少一个键 → segs=null 并说明缺哪个（不猜）', () => {
  const raw = '{"what":"甲。","why":"乙。","how":"丙。","demo":"2+1=3。"';
  const r = T.parseExplain(raw);
  assert.strictEqual(r.segs, null);
  assert.ok(/trap/.test(r.why), 'why 里要点名缺的键：' + r.why);
});

test('parseExplain：空返回 → segs=null', () => {
  assert.strictEqual(T.parseExplain('').segs, null);
  assert.strictEqual(T.parseExplain(null).segs, null);
});

test('parseExplain：转义字符还原（引号与换行）', () => {
  const raw = '{"what":"他说\\"好\\"","why":"两行\\n第二行","how":"丙。","demo":"2+1=3。","trap":"丁。"}';
  const r = T.parseExplain(raw);
  assert.strictEqual(r.segs.what, '他说"好"');
  assert.strictEqual(r.segs.why, '两行\n第二行');
});

/* ================================================================
 * 8. checkExplain（讲解 5 闸：每条正负例）
 * ================================================================ */

console.log('\n--- checkExplain ---');

function gates(result) { return result.reasons.map((r) => r.gate); }

test('G1 正例：5 段齐全、字数与句长都在 early 档内 → 全闸通过', () => {
  const r = T.checkExplain(GOOD, P006);
  assert.deepStrictEqual(r.reasons, []);
  assert.strictEqual(r.ok, true);
});

test('G1 负例：缺一段 → 拒', () => {
  const segs = segsWith({});
  delete segs.trap;
  const r = T.checkExplain(segs, P006);
  assert.strictEqual(r.ok, false);
  assert.ok(gates(r).indexOf('G1') >= 0);
});

test('G1 负例：某段只有空白 → 拒', () => {
  const r = T.checkExplain(segsWith({ why: '   \n ' }), P006);
  assert.strictEqual(r.ok, false);
  assert.ok(gates(r).indexOf('G1') >= 0);
});

test('G1 负例：单句超过 12 字（early 档）→ 拒', () => {
  const r = T.checkExplain(segsWith({ what: '加法就是把两部分合起来然后从第一个数开始往后数。' }), P006);
  assert.strictEqual(r.ok, false);
  assert.ok(gates(r).indexOf('G1') >= 0);
  assert.ok(r.reasons.some((x) => /超过 12 字/.test(x.why)), '要报句长超限');
});

test('G1 负例：段字数超过 40 字（early 档，句中仍合规）→ 拒', () => {
  const longWhat = '一二三四五六七八九十一。'.repeat(4); /* 48 字，每句 12 字 */
  const r = T.checkExplain(segsWith({ what: longWhat }), P006);
  assert.strictEqual(r.ok, false);
  assert.ok(r.reasons.some((x) => /太长/.test(x.why)), '要报段长超限');
});

test('G1 正例：正好 80 字（middle 档上限）→ 通过', () => {
  const r = T.checkExplain(segsWith({ what: '甲'.repeat(79) + '。' }), MID_INPUTS);
  assert.strictEqual(r.ok, true, JSON.stringify(r.reasons));
});

test('G1 负例：81 字（middle 档上限 +1）→ 拒', () => {
  const r = T.checkExplain(segsWith({ what: '甲'.repeat(80) + '。' }), MID_INPUTS);
  assert.strictEqual(r.ok, false);
  assert.ok(gates(r).indexOf('G1') >= 0);
});

test('G2 正例：只提本点与直接先修 → 通过', () => {
  const r = T.checkExplain(segsWith({ how: '先想5以内数的分与合。再数第一堆。' }), P006);
  assert.strictEqual(r.ok, true, JSON.stringify(r.reasons));
});

test('G2 负例：提到白名单外的知识点 → 拒', () => {
  const r = T.checkExplain(segsWith({ trap: '学完三角形的面积就懂了。' }), P006);
  assert.strictEqual(r.ok, false);
  assert.ok(gates(r).indexOf('G2') >= 0);
  assert.ok(/三角形的面积/.test(r.reasons.find((x) => x.gate === 'G2').why));
});

test('G2：长度 < 4 字的知识点名不参与匹配（不误伤）', () => {
  const topic = { id: 'cnm_test_short', name: '测试知识点丁', grade: 4, chapter: 'x', description: '描述', mastery_criteria: ['标准'], standards: [] };
  const other = { id: 'cnm_other', name: '比例' };
  const inputs = T.buildInputs({
    topic, questions: [], standardsById: {}, deps: [], topics: [topic, other]
  });
  const r = T.checkExplain(segsWith({ what: '比例是两数相除。' }), inputs);
  assert.strictEqual(r.ok, true, JSON.stringify(r.reasons));
});

test('G3 正例：算式操作数来自题面、结果等于题库答案 → 通过', () => {
  const r = T.checkExplain(segsWith({ demo: '2+1=3。一共 3 朵。' }), P006_PRIMARY);
  assert.strictEqual(r.ok, true, JSON.stringify(r.reasons));
});

test('G3 正例：讲解里完全没有算式 → 通过（卡面明写不是拒）', () => {
  const r = T.checkExplain(segsWith({ demo: '把两堆苹果合起来数一数。有几个？' }), P006);
  assert.strictEqual(r.ok, true, JSON.stringify(r.reasons));
});

test('G3 负例：算式操作数不在题面里 → 拒', () => {
  const r = T.checkExplain(segsWith({ demo: '9+1=10。一共 10 个。' }), P006);
  assert.strictEqual(r.ok, false);
  assert.ok(gates(r).indexOf('G3') >= 0);
  assert.ok(r.reasons.some((x) => /没出现在本点题面/.test(x.why)));
});

test('G3 负例：算式本身不成立（2+1=4）→ 拒', () => {
  const r = T.checkExplain(segsWith({ demo: '2+1=4。一共 4 朵。' }), P006);
  assert.strictEqual(r.ok, false);
  assert.ok(r.reasons.some((x) => /算式与结果对不上/.test(x.why)), JSON.stringify(r.reasons));
});

test('G3 负例：结果数字不是题库答案（2+1=7）→ 拒', () => {
  const r = T.checkExplain(segsWith({ demo: '2+1=7。' }), P006);
  assert.strictEqual(r.ok, false);
  assert.ok(gates(r).indexOf('G3') >= 0);
});

test('G4 正例：引用本点课标编号 → 通过', () => {
  const r = T.checkExplain(segsWith({ why: '课标 cms-2022:1.NA.04 要求这样。' }), STD_INPUTS);
  assert.strictEqual(r.ok, true, JSON.stringify(r.reasons));
});

test('G4 负例：引用本点没有的课标编号 → 拒', () => {
  const r = T.checkExplain(segsWith({ why: '课标 cms-2022:9.XX.99 要求这样。' }), STD_INPUTS);
  assert.strictEqual(r.ok, false);
  assert.ok(gates(r).indexOf('G4') >= 0);
});

test('G4：无课标点跳过本闸（乱写编号不报 G4）', () => {
  const inputs = buildFor(topicById('cnm_130'));
  const segs = segsWith({ why: '课标 cms-2022:9.XX.99 要求这样。', demo: '把两堆合起来数一遍。' });
  const r = T.checkExplain(segs, inputs);
  /* 卡 A′ 起 G7 会把这个编造编号里的 2022 / 99 另报一条（数字白名单独立生效）；
   * 本闸（G4）在无课标点必须沉默 —— 断言的就是这一条。 */
  assert.ok(gates(r).indexOf('G4') < 0, '无课标点不该报 G4：' + JSON.stringify(r.reasons));
  assert.ok(gates(r).indexOf('G7') >= 0, '编造编号里的数应当被 G7 拦住：' + JSON.stringify(r.reasons));
});

test('G5 负例：** 加粗 / 反引号 / 反斜杠命令 / 省略号 各自都拒', () => {
  [
    { how: '**先数第一堆**。' },
    { how: '先数第一堆，记作 `a`。' },
    { how: '先算 \\frac{1}{2}。' },
    { how: '先数 1、2、3…' }
  ].forEach((patch) => {
    const r = T.checkExplain(segsWith(patch), P006);
    assert.strictEqual(r.ok, false, JSON.stringify(patch) + ' 应当被拒');
    assert.ok(gates(r).indexOf('G5') >= 0, JSON.stringify(patch) + ' 应命中 G5');
  });
});

test('G5 正例：干净文本不被误伤', () => {
  const r = T.checkExplain(segsWith({ how: '先数第一堆。再数第二堆。' }), P006);
  assert.strictEqual(r.ok, true, JSON.stringify(r.reasons));
});

test('多因并列：G2 与 G5 同时命中时两条都要报（不许只报第一条）', () => {
  const r = T.checkExplain(segsWith({ trap: '**三角形的面积**要记住。' }), P006);
  assert.strictEqual(r.ok, false);
  assert.ok(gates(r).indexOf('G2') >= 0, '缺 G2');
  assert.ok(gates(r).indexOf('G5') >= 0, '缺 G5');
  assert.ok(r.reasons.length >= 2);
});

test('checkExplain：segs 为 null 时不炸，报 G1', () => {
  const r = T.checkExplain(null, P006);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reasons[0].gate, 'G1');
});

/* ================================================================
 * 9. checkReply（追问 5 闸：G2r / G3r / G4 / G5 / G6）
 * ================================================================ */

console.log('\n--- checkReply ---');

test('G6 正例：60 字以内（early 档）→ 通过', () => {
  const r = T.checkReply('把两堆合起来数一数就得到结果了。', P006);
  assert.strictEqual(r.ok, true, JSON.stringify(r.reasons));
});

test('G6 负例：超过 60 字（early 档）→ 拒', () => {
  const r = T.checkReply('数'.repeat(61), P006);
  assert.strictEqual(r.ok, false);
  assert.ok(gates(r).indexOf('G6') >= 0);
});

test('G6 负例：空回答 → 拒', () => {
  assert.strictEqual(T.checkReply('', P006).ok, false);
  assert.strictEqual(T.checkReply('   ', P006).ok, false);
});

test('G2r 负例：追问回答引入白名单外知识点 → 拒', () => {
  const r = T.checkReply('你先去学三角形的面积。', P006);
  assert.strictEqual(r.ok, false);
  assert.ok(gates(r).indexOf('G2r') >= 0);
});

test('G3r 正例：允许引用学生自己给的数，算式成立 → 通过', () => {
  /* 卡 A′ 起 G7r 只放行「本轮学生问题里出现过的数」，所以学生自己贴的数要在 question 里。 */
  const r = T.checkReply('你说的 4+5=9 是对的。', P006, '我算得 4 加 5 是 9，对吗？');
  assert.strictEqual(r.ok, true, JSON.stringify(r.reasons));
});

test('G3r 负例：算式与结果对不上 → 拒', () => {
  const r = T.checkReply('4+5=11，所以是 11。', P006);
  assert.strictEqual(r.ok, false);
  assert.ok(gates(r).indexOf('G3r') >= 0);
});

test('G3r：追问轮不做「操作数必须在题面」的检查（学生自带的数允许）', () => {
  const r = T.checkReply('9+1=10。', P006, '9 加 1 是几？');
  /* 本闸（G3r）不要求操作数在题面 —— 断言的就是这一条 */
  assert.ok(!gates(r).includes('G3r'), 'G3r 不该报：' + JSON.stringify(r.reasons));
  /* 卡 A″ 收窄后 10 不再被白名单放行（素材与问题里都没有 10）→ 由 G7r 拦，这是新契约 */
  assert.ok(r.reasons.some((x) => x.gate === 'G7r' && x.why.indexOf('10') >= 0),
    JSON.stringify(r.reasons));
});

test('G4 / G5 在追问轮同样生效', () => {
  const badStd = T.checkReply('课标 cms-2022:9.XX.99 这么说。', P006);
  assert.ok(gates(badStd).indexOf('G4') >= 0);
  const badFmt = T.checkReply('**就是这样**。', P006);
  assert.ok(gates(badFmt).indexOf('G5') >= 0);
});

test('checkReply：多因并列（太长 + 超纲）两条都报', () => {
  const r = T.checkReply('三角形的面积' + '数'.repeat(70), P006);
  assert.ok(gates(r).indexOf('G6') >= 0, '缺 G6');
  assert.ok(gates(r).indexOf('G2r') >= 0, '缺 G2r');
});

/* ================================================================
 * 10. chatMessages（多轮：锚点不裁 / 窗口 6 轮 / 字符预算 / 失败轮过滤）
 * ================================================================ */

console.log('\n--- chatMessages ---');

function history(n) {
  const out = [];
  for (let i = 1; i <= n; i++) out.push({ q: '问' + i, a: '答' + i });
  return out;
}

test('第 1 轮：system + 素材 + 5 段讲解 + 本轮提问 = 4 条，顺序固定', () => {
  const msgs = T.chatMessages(P006, GOOD, [], '第一问');
  assert.strictEqual(msgs.length, 4);
  assert.deepStrictEqual(msgs.map((m) => m.role), ['system', 'user', 'assistant', 'user']);
  assert.strictEqual(msgs[3].content, '第一问');
  assert.ok(msgs[2].content.indexOf(GOOD.what) >= 0, 'assistant 锚点要含 5 段正文');
  assert.ok(msgs[2].content.indexOf(GOOD.trap) >= 0);
});

test('追问轮 system：带回答长度档 + 只用白名单知识点 + 不直接给答案', () => {
  const sys = T.chatMessages(P006, GOOD, [], '问').at(0).content;
  assert.strictEqual(sys.role, undefined);
  assert.ok(sys.indexOf('不超过 60 字') >= 0, '缺追问长度档（early 60）');
  assert.ok(sys.indexOf('每句不超过 12 字') >= 0, '缺句长档');
  assert.ok(sys.indexOf('一次只答一个问题') >= 0);
  assert.ok(sys.indexOf('可以提到的知识点') >= 0);
});

test('追问轮 system 与讲解轮 system 不同一条（锚点 [0] 是讲解轮的人设）', () => {
  const chatSys = T.chatMessages(P006, GOOD, [], '问')[0].content;
  const explainSys = T.explainMessages(P006)[0].content;
  assert.notStrictEqual(chatSys, explainSys);
  assert.ok(chatSys.indexOf('学生刚听完你讲这个知识点') >= 0);
});

test('窗口：6 轮 → 16 条（3 锚点 + 12 条问答 + 1 本轮）', () => {
  const msgs = T.chatMessages(P006, GOOD, history(6), '第七问');
  assert.strictEqual(msgs.length, 16);
  assert.strictEqual(msgs[3].content, '问1');
});

test('窗口：7 轮 → 仍 16 条，最早的「问1」被裁掉', () => {
  const msgs = T.chatMessages(P006, GOOD, history(7), '第八问');
  assert.strictEqual(msgs.length, 16);
  assert.strictEqual(msgs[3].content, '问2');
});

test('窗口：8 轮 → 仍 16 条，从「问3」起', () => {
  const msgs = T.chatMessages(P006, GOOD, history(8), '第九问');
  assert.strictEqual(msgs.length, 16);
  assert.strictEqual(msgs[3].content, '问3');
});

test('窗口：10 轮历史（第 11 轮调用）→ 仍 16 条，从「问5」起', () => {
  const msgs = T.chatMessages(P006, GOOD, history(10), '第十一问');
  assert.strictEqual(msgs.length, 16);
  assert.strictEqual(msgs[3].content, '问5');
  assert.strictEqual(msgs[msgs.length - 1].content, '第十一问');
});

test('锚点不裁：第 11 轮 messages[0..2] 与第 1 轮深比完全相等', () => {
  const first = T.chatMessages(P006, GOOD, [], '第一问');
  const late = T.chatMessages(P006, GOOD, history(10), '第十一问');
  assert.deepStrictEqual(late.slice(0, 3), first.slice(0, 3));
});

test('失败轮过滤：pending / failed / 空答 / 缺答都不进 messages', () => {
  const hist = [
    { q: '好的问', a: '好的答' },
    { q: '挂起问', a: '', pending: true },
    { q: '失败问', a: '失败答', failed: true },
    { q: '空答问', a: '   ' },
    { q: '缺答问' }
  ];
  const msgs = T.chatMessages(P006, GOOD, hist, '下一问');
  assert.strictEqual(msgs.length, 6); /* 3 锚点 + 1 轮问答 + 本轮 */
  assert.strictEqual(msgs[3].content, '好的问');
  assert.strictEqual(msgs[4].content, '好的答');
});

test('字符预算：窗口总字数 > 4000 时从最早一轮成对丢，锚点不受影响', () => {
  const long = '答'.repeat(700);
  const hist = [];
  for (let i = 1; i <= 6; i++) hist.push({ q: '问' + i, a: long + i });
  const msgs = T.chatMessages(P006, GOOD, hist, '本轮');
  const total = msgs.reduce((n, m) => n + Array.from(m.content).length, 0);
  assert.ok(msgs.length < 16, '应当丢掉了最早的轮次');
  assert.ok(total <= 4000, '总字数应当压到 4000 以内，实际 ' + total);
  const first = T.chatMessages(P006, GOOD, [], 'x');
  assert.deepStrictEqual(msgs.slice(0, 3), first.slice(0, 3));
  assert.strictEqual(msgs[msgs.length - 1].content, '本轮');
});

test('字符预算：丢到只剩最近 1 轮就停（至少保留 1 轮）', () => {
  const huge = '答'.repeat(5000);
  const msgs = T.chatMessages(P006, GOOD, [{ q: '早问', a: huge }, { q: '晚问', a: huge }], '本轮');
  assert.strictEqual(msgs.length, 6, '应保留 1 轮问答');
  assert.strictEqual(msgs[3].content, '晚问');
});

test('本轮提问永远在最后，且不参与裁剪', () => {
  const msgs = T.chatMessages(P006, GOOD, history(10), '最后一问');
  assert.strictEqual(msgs[msgs.length - 1].role, 'user');
  assert.strictEqual(msgs[msgs.length - 1].content, '最后一问');
  assert.strictEqual(msgs[msgs.length - 2].role, 'assistant');
});

/* ================================================================
 * 11. 缓存（cacheKey / readCache / writeCache / pruneCache）
 * ================================================================ */

console.log('\n--- 缓存 ---');

test('cacheKey：以固定前缀 + topicId 开头', () => {
  const k = T.cacheKey(P006, 'gpt-x');
  assert.ok(k.indexOf('cnmDiagnose.topicExplain.v1:') === 0, k);
  assert.ok(k.indexOf('cnm_p006') >= 0, k);
});

test('cacheKey：同素材同模型 → 稳定', () => {
  assert.strictEqual(T.cacheKey(P006, 'm1'), T.cacheKey(P006, 'm1'));
});

test('cacheKey：换模型 → key 变', () => {
  assert.notStrictEqual(T.cacheKey(P006, 'm1'), T.cacheKey(P006, 'm2'));
});

test('cacheKey：素材变（介绍改一个字）→ key 变', () => {
  const changed = Object.assign({}, P006, { desc: P006.desc + '。' });
  assert.notStrictEqual(T.cacheKey(P006, 'm1'), T.cacheKey(changed, 'm1'));
});

test('cacheKey：题库变（例题换一道）→ key 变', () => {
  const changed = Object.assign({}, P006, { examples: P006.examples.slice(0, 1) });
  assert.notStrictEqual(T.cacheKey(P006, 'm1'), T.cacheKey(changed, 'm1'));
});

test('writeCache / readCache：写进去能读回来', () => {
  const s = memStorage();
  const k = T.cacheKey(P006, 'm1');
  assert.strictEqual(T.writeCache(s, k, { segs: GOOD, at: 1 }), true);
  assert.deepStrictEqual(T.readCache(s, k), { segs: GOOD, at: 1 });
});

test('readCache：没写过 → null；坏 JSON → null；storage 缺失 → null', () => {
  const s = memStorage();
  assert.strictEqual(T.readCache(s, 'nope'), null);
  s.setItem('bad', '{不是 json');
  assert.strictEqual(T.readCache(s, 'bad'), null);
  assert.strictEqual(T.readCache(null, 'x'), null);
  assert.strictEqual(T.readCache({}, 'x'), null);
});

test('writeCache：storage 不可用 → false（不伪造 window）', () => {
  assert.strictEqual(T.writeCache(null, 'k', {}), false);
  assert.strictEqual(T.writeCache({}, 'k', {}), false);
});

test('pruneCache：205 条裁到 200 条，留下 at 最新的', () => {
  const s = memStorage();
  for (let i = 1; i <= 205; i++) {
    T.writeCache(s, T.CACHE_PREFIX + 'cnm_x' + i + '|' + i, { at: i, segs: {} });
  }
  assert.strictEqual(s.length, 205);
  const dropped = T.pruneCache(s, 200);
  assert.strictEqual(dropped, 5);
  assert.strictEqual(s.length, 200);
  assert.strictEqual(T.readCache(s, T.CACHE_PREFIX + 'cnm_x1|1'), null, '最旧的应当被淘汰');
  assert.ok(T.readCache(s, T.CACHE_PREFIX + 'cnm_x205|205'), '最新的必须还在');
});

test('pruneCache：没到上限 → 一条不删', () => {
  const s = memStorage();
  for (let i = 1; i <= 3; i++) T.writeCache(s, T.CACHE_PREFIX + 'k' + i, { at: i });
  assert.strictEqual(T.pruneCache(s, 200), 0);
  assert.strictEqual(s.length, 3);
  assert.strictEqual(T.pruneCache(null, 200), 0);
});

/* ================================================================
 * 12. 卡 A′：早期档两条（禁符号 / 生活场景）+ G7 / G7r 数字白名单
 * ================================================================ */

console.log('\n--- 卡 A′：早期档两条 + G7 / G7r 数字白名单 ---');

/* 合成点：素材里只出现 1 与 9（小学高年级档 → 不受早期档规则干扰，单测 G7） */
const DIGIT_TOPIC = {
  id: 'cnm_test_digit', name: '测试数字知识点', grade: 5, semester: '上', chapter: '测试章节四',
  description: '素材里只出现 1 与 9 这两个数。', mastery_criteria: ['测试标准五'], standards: [], type: 'conceptual'
};
const DIGIT_INPUTS = T.buildInputs({
  topic: DIGIT_TOPIC, questions: [], standardsById: {}, deps: [], topics: [DIGIT_TOPIC]
});

test('limitsOf：forbidSymbols / requireRealLife 只在 early 档为 true（四档逐一取值）', () => {
  assert.strictEqual(T.limitsOf('early').forbidSymbols, true);
  assert.strictEqual(T.limitsOf('early').requireRealLife, true);
  ['primary', 'middle', 'high'].forEach((lv) => {
    assert.strictEqual(T.limitsOf(lv).forbidSymbols, false, lv + ' 不该禁符号');
    assert.strictEqual(T.limitsOf(lv).requireRealLife, false, lv + ' 不该要求生活场景');
  });
  /* 未知档走 primary 兜底，两键也必须 false */
  assert.strictEqual(T.limitsOf('unknown').forbidSymbols, false);
  assert.strictEqual(T.limitsOf(null).requireRealLife, false);
});

test('buildInputs：limits 带上两键（early 点 true），既有三键一个不改', () => {
  assert.strictEqual(P006.limits.forbidSymbols, true);
  assert.strictEqual(P006.limits.requireRealLife, true);
  assert.deepStrictEqual(P006.limits.segMax, { what: 40, why: 40, how: 60, demo: 70, trap: 40 });
  assert.strictEqual(P006.limits.replyMax, 60);
  assert.strictEqual(P006.limits.sentenceMax, 12);
  assert.strictEqual(MID_INPUTS.limits.forbidSymbols, false);
  assert.strictEqual(MID_INPUTS.limits.requireRealLife, false);
});

test('G1 早期档符号负例：讲解含 3 + 2 = 5 → 拒；同一段在 primary 档不因符号被拒', () => {
  const segs = segsWith({ demo: '3 + 2 = 5。一共 5 个。' });
  const early = T.checkExplain(segs, P006);
  assert.strictEqual(early.ok, false);
  const g1 = early.reasons.filter((x) => x.gate === 'G1' && /符号算式/.test(x.why));
  assert.strictEqual(g1.length, 1, JSON.stringify(early.reasons));
  assert.ok(g1[0].why.indexOf('+') >= 0 && g1[0].why.indexOf('=') >= 0, g1[0].why);

  const prim = T.checkExplain(segs, P006_PRIMARY);
  assert.ok(!prim.reasons.some((x) => /符号算式/.test(x.why)),
    'primary 档不许因符号被拒：' + JSON.stringify(prim.reasons));
});

test('G1 早期档符号：全角 ＋ － ＝ 与括号同样命中', () => {
  const r = T.checkExplain(segsWith({ demo: '３＋２＝５。' }), P006);
  const g1 = r.reasons.filter((x) => x.gate === 'G1' && /符号算式/.test(x.why));
  assert.strictEqual(g1.length, 1, JSON.stringify(r.reasons));
  /* 归一后提示语报半角，判据未变（全角 ＋ / ＝ 仍命中，只是 why 里显示为 + / =）。 */
  assert.ok(g1[0].why.indexOf('+') >= 0 && g1[0].why.indexOf('=') >= 0, g1[0].why);

  const paren = T.checkExplain(segsWith({ demo: '先算（１加２）。' }), P006);
  assert.ok(paren.reasons.some((x) => x.gate === 'G1' && /符号算式/.test(x.why)),
    JSON.stringify(paren.reasons));
});

test('G1 早期档符号：符号不在 demo 段也要拦（查 5 段全文）', () => {
  const r = T.checkExplain(segsWith({ how: '先数第一堆。再用 5-2 的办法。' }), P006);
  assert.ok(r.reasons.some((x) => x.gate === 'G1' && /符号算式/.test(x.why)), JSON.stringify(r.reasons));
});

test('G1 早期档生活场景负例：demo 纯抽象（三加二等于五）→ 拒', () => {
  const r = T.checkExplain(segsWith({ demo: '三加二等于五。' }), P006);
  assert.strictEqual(r.ok, false);
  assert.ok(r.reasons.some((x) => x.gate === 'G1' && /生活场景/.test(x.why)), JSON.stringify(r.reasons));
});

test('G1 早期档生活场景正例：demo 含「买 / 个」→ 通过', () => {
  const r = T.checkExplain(segsWith({ demo: '妈妈买了 3 个苹果。一共 3 个。' }), P006);
  assert.strictEqual(r.ok, true, JSON.stringify(r.reasons));
});

test('G7 正例：讲解只用素材里出现过的数 → 通过', () => {
  const r = T.checkExplain(segsWith({ demo: '2+1=3。一共 3 个。' }), P006_PRIMARY);
  assert.strictEqual(r.ok, true, JSON.stringify(r.reasons));
  assert.ok(!gates(r).includes('G7'));
});

test('G7 负例：讲解冒出素材没有的数（7）→ 拒，gate G7，why 含 7', () => {
  const r = T.checkExplain(segsWith({ what: '加法就是把两部分合起来。最多能数到 7。' }), P006);
  assert.strictEqual(r.ok, false);
  const hit = r.reasons.find((x) => x.gate === 'G7');
  assert.ok(hit, JSON.stringify(r.reasons));
  assert.ok(hit.why.indexOf('7') >= 0, hit.why);
  assert.ok(/素材里没有的数/.test(hit.why), hit.why);
});

test('G7 全文检查：数字只出现在 what / how 段（不在 demo）也拒', () => {
  const r = T.checkExplain(segsWith({ how: '先数第一堆。再数第二堆。最后数到 7。' }), P006);
  assert.ok(r.reasons.some((x) => x.gate === 'G7' && x.why.indexOf('7') >= 0), JSON.stringify(r.reasons));
});

test('G7 分数：9/7 拒 7；9/1 通过；1/2 因 2 不在素材而被拒（收窄后契约）', () => {
  const bad = T.checkExplain(segsWith({ demo: '写成 9/7 也可以。' }), DIGIT_INPUTS);
  const hit = bad.reasons.find((x) => x.gate === 'G7');
  assert.ok(hit && hit.why.indexOf('9') < 0 && hit.why.indexOf('7') >= 0, JSON.stringify(bad.reasons));
  /* 反证：两个 token 都在素材里（9 与 1）→ 不报 G7 */
  const okCase = T.checkExplain(segsWith({ demo: '一半写成 9/1。' }), DIGIT_INPUTS);
  assert.ok(!okCase.reasons.some((x) => x.gate === 'G7'), JSON.stringify(okCase.reasons));
  /* 卡 A″ 收窄：2 不再在 COMMON_SMALL_DIGITS 里，素材也没有 2 → 1/2 现在会被拒 */
  const narrowed = T.checkExplain(segsWith({ demo: '一半写成 1/2。' }), DIGIT_INPUTS);
  const narrowedHit = narrowed.reasons.find((x) => x.gate === 'G7');
  assert.ok(narrowedHit && narrowedHit.why.indexOf('2') >= 0, JSON.stringify(narrowed.reasons));
});

test('小整数收窄：第 2 步 / 一共 10 只不再放行（2 与 10 都不在素材）', () => {
  const r = T.checkExplain(segsWith({ how: '第 2 步先数第一堆。', demo: '一共 10 只。' }), DIGIT_INPUTS);
  const hit = r.reasons.find((x) => x.gate === 'G7');
  assert.ok(hit, '2 与 10 都不该再被白名单放行：' + JSON.stringify(r.reasons));
  assert.ok(hit.why.indexOf('2') >= 0 && hit.why.indexOf('10') >= 0, hit.why);
});

test('G7：inputs.allowedDigits 给 [2024] 后放行 2024（不给就拒）', () => {
  const segs = segsWith({ why: '2024 年是这样。' });
  const without = T.checkExplain(segs, DIGIT_INPUTS);
  assert.ok(without.reasons.some((x) => x.gate === 'G7' && x.why.indexOf('2024') >= 0),
    JSON.stringify(without.reasons));
  const withAllow = T.checkExplain(segs, Object.assign({}, DIGIT_INPUTS, { allowedDigits: [2024] }));
  assert.ok(!withAllow.reasons.some((x) => x.gate === 'G7'), JSON.stringify(withAllow.reasons));
});

test('G7 不做算术等价：3 与 4 都在素材里，写 7（=3+4）仍拒', () => {
  const r = T.checkExplain(segsWith({ demo: '左边 3 个，右边 4 个，一共 7 个。' }), P006_PRIMARY);
  assert.ok(r.reasons.some((x) => x.gate === 'G7' && x.why.indexOf('7') >= 0), JSON.stringify(r.reasons));
});

test('G7：多因并列（超纲 + 编数）两条都报，why 最多列 5 个数', () => {
  const r = T.checkExplain(segsWith({ trap: '三角形的面积加上 7、8、9、11、12、13。' }), P006_PRIMARY);
  assert.ok(gates(r).includes('G2'), '缺 G2：' + JSON.stringify(r.reasons));
  const g7 = r.reasons.find((x) => x.gate === 'G7');
  assert.ok(g7, '缺 G7：' + JSON.stringify(r.reasons));
  const listed = g7.why.split('：')[1].split('，').filter((s) => /^\d/.test(s));
  assert.strictEqual(listed.length, 5, g7.why);
  assert.ok(/共 6 个/.test(g7.why), g7.why);
});

test('G7r 正例：学生问题里写了 12，答复引用 12 → 通过', () => {
  const r = T.checkReply('你说的 12 对。再想想 12 是怎么来的。', P006, '是不是 12？');
  assert.strictEqual(r.ok, true, JSON.stringify(r.reasons));
});

test('G7r 负例：答复里有素材与学生问题都没有的数 → 拒（gate G7r）', () => {
  const r = T.checkReply('12 加 13 得 25。', P006, '12 加 13 是几？');
  const hit = r.reasons.find((x) => x.gate === 'G7r');
  assert.ok(hit && hit.why.indexOf('25') >= 0, JSON.stringify(r.reasons));
});

test('G7r：只放行本轮问题里的数，不放行别的轮次问过的数', () => {
  const okR = T.checkReply('8 就是你问的这个数。', P006, '那 8 呢？');
  assert.strictEqual(okR.ok, true, JSON.stringify(okR.reasons));
  const badR = T.checkReply('12 就是上次说的那个数。', P006, '那 8 呢？');
  assert.ok(badR.reasons.some((x) => x.gate === 'G7r' && x.why.indexOf('12') >= 0),
    JSON.stringify(badR.reasons));
});

/* 合成点：素材里只有 1 与 9（grade 6 → 素材里另有 6），3 / 4 / 5 / 10 一概没有。
 * 小学高年级档 → 不受早期档符号 / 生活场景规则干扰，单测 G7 收窄。 */
const SMALL_TOPIC = {
  id: 'cnm_test_small', name: '测试小整数知识点', grade: 6, semester: '上', chapter: '测试章节六',
  description: '素材里只出现 1 与 9 这两个数。', mastery_criteria: ['测试标准六'], standards: [], type: 'conceptual'
};
const SMALL_INPUTS = T.buildInputs({
  topic: SMALL_TOPIC, questions: [], standardsById: {}, deps: [], topics: [SMALL_TOPIC]
});

test('全角数字：素材里没有的 ７ 与半角 7 判定一致（都拒，why 指向同一个数）', () => {
  const half = T.checkExplain(segsWith({ demo: '比如有 7 个苹果。' }), DIGIT_INPUTS);
  const full = T.checkExplain(segsWith({ demo: '比如有 ７ 个苹果。' }), DIGIT_INPUTS);
  const halfHit = half.reasons.find((x) => x.gate === 'G7');
  const fullHit = full.reasons.find((x) => x.gate === 'G7');
  assert.ok(halfHit, '半角 7 应被 G7 拒：' + JSON.stringify(half.reasons));
  assert.ok(fullHit, '全角 ７ 必须与 7 同判（应被 G7 拒）：' + JSON.stringify(full.reasons));
  assert.ok(fullHit.why.indexOf('7') >= 0, fullHit.why);
  assert.strictEqual(full.ok, half.ok, '全角与半角的判定结果不一致');
});

test('全角数字：素材里有的数的全角形式必须放行（９ 与 9 一致）', () => {
  const half = T.checkExplain(segsWith({ demo: '桌上有 9 个苹果。' }), DIGIT_INPUTS);
  const full = T.checkExplain(segsWith({ demo: '桌上有 ９ 个苹果。' }), DIGIT_INPUTS);
  assert.ok(!half.reasons.some((x) => x.gate === 'G7'), JSON.stringify(half.reasons));
  assert.strictEqual(full.ok, true, '素材里有 9 → 全角 ９ 必须放行：' + JSON.stringify(full.reasons));
});

test('全角小数：３．５ 与 3.5 同判（素材有 3.5 两边都过，没有两边都拒）', () => {
  const FW_TOPIC = {
    id: 'cnm_test_fullwidth', name: '测试全角知识点', grade: 5, semester: '上', chapter: '测试章节八',
    description: '素材里有 3.5 这个数。', mastery_criteria: ['测试标准八'], standards: [], type: 'conceptual'
  };
  const FW_INPUTS = T.buildInputs({
    topic: FW_TOPIC, questions: [], standardsById: {}, deps: [], topics: [FW_TOPIC]
  });
  const passHalf = T.checkExplain(segsWith({ demo: '桌上有 3.5 个苹果。' }), FW_INPUTS);
  const passFull = T.checkExplain(segsWith({ demo: '桌上有 ３．５ 个苹果。' }), FW_INPUTS);
  assert.ok(!passHalf.reasons.some((x) => x.gate === 'G7'), JSON.stringify(passHalf.reasons));
  assert.strictEqual(passFull.ok, true, '素材里有 3.5 → 全角 ３．５ 必须放行：' + JSON.stringify(passFull.reasons));

  const rejectHalf = T.checkExplain(segsWith({ demo: '桌上有 3.5 个苹果。' }), DIGIT_INPUTS);
  const rejectFull = T.checkExplain(segsWith({ demo: '桌上有 ３．５ 个苹果。' }), DIGIT_INPUTS);
  const rh = rejectHalf.reasons.find((x) => x.gate === 'G7');
  const rf = rejectFull.reasons.find((x) => x.gate === 'G7');
  assert.ok(rh && rh.why.indexOf('3.5') >= 0, JSON.stringify(rejectHalf.reasons));
  assert.ok(rf && rf.why.indexOf('3.5') >= 0, '素材没有 3.5 → 全角 ３．５ 必须被拒：' + JSON.stringify(rejectFull.reasons));
});

test('小整数收窄：COMMON_SMALL_DIGITS 只剩 [0,1]；素材没有的 3 / 4 / 5 / 10 一律被 G7 拒', () => {
  assert.deepStrictEqual(T.COMMON_SMALL_DIGITS, [0, 1], '小整数白名单必须收窄到 [0,1]');
  [3, 4, 5, 10].forEach((n) => {
    const r = T.checkExplain(segsWith({ demo: '桌上有 ' + n + ' 个苹果。' }), SMALL_INPUTS);
    const hit = r.reasons.find((x) => x.gate === 'G7');
    assert.ok(hit, n + ' 不在素材里，必须被 G7 拒：' + JSON.stringify(r.reasons));
    assert.ok(hit.why.indexOf(String(n)) >= 0, hit.why);
  });
  const ok = T.checkExplain(segsWith({ demo: '桌上有 0 个苹果。只剩下 1 个。' }), SMALL_INPUTS);
  assert.strictEqual(ok.ok, true, '0 与 1 必须放行：' + JSON.stringify(ok.reasons));
});

test('生活场景词表：介词「把」不再让抽象例子通过（只留量词与动作动词）', () => {
  assert.strictEqual(T.LIFE_SCENE_WORDS.indexOf('把'), -1, '「把」必须从生活词表里删掉');
  ['被', '就', '了', '和', '也', '一共', '平均'].forEach((w) => {
    assert.strictEqual(T.LIFE_SCENE_WORDS.indexOf(w), -1, '纯语法词 / 副词 / 术语不该留在生活词表：' + w);
  });
  const r = T.checkExplain(segsWith({ demo: '把数字加起来就行了。' }), P006);
  assert.strictEqual(r.ok, false, '抽象例子不许靠「把」通过：' + JSON.stringify(r.reasons));
  assert.ok(r.reasons.some((x) => x.gate === 'G1' && /生活场景/.test(x.why)), JSON.stringify(r.reasons));

  /* 真生活场景不受影响 */
  const ok = T.checkExplain(segsWith({ demo: '妈妈买了 3 个苹果。' }), P006);
  assert.strictEqual(ok.ok, true, JSON.stringify(ok.reasons));
});

/* 卡 A‴：全角算式 / 生活场景判据回归（先写测试，确认红后再改实现） */

test('全角算式：３＋１＝２ 在 checkReply 被 G3r 拒', () => {
  const r = T.checkReply('３＋１＝２', P006);
  assert.strictEqual(r.ok, false, JSON.stringify(r.reasons));
  const hit = r.reasons.find((x) => x.gate === 'G3r' && /算式与结果对不上/.test(x.why));
  assert.ok(hit, JSON.stringify(r.reasons));
});

test('全角算式：３＋２＝４ 在 checkExplain 的 demo 段被 G3 拒', () => {
  const r = T.checkExplain(segsWith({ demo: '３＋２＝４。' }), P006);
  const hit = r.reasons.find((x) => x.gate === 'G3' && /算式与结果对不上/.test(x.why));
  assert.ok(hit, JSON.stringify(r.reasons));
});

test('半角对照不回归：3 + 1 = 2 仍被拒', () => {
  const r = T.checkReply('3 + 1 = 2', P006);
  const hit = r.reasons.find((x) => x.gate === 'G3r' && /算式与结果对不上/.test(x.why));
  assert.ok(hit, JSON.stringify(r.reasons));
});

test('全角正确算式放行：３＋１＝４ 不因归一而误拒', () => {
  const r = T.checkReply('３＋１＝４', P006);
  assert.strictEqual(r.ok, true, JSON.stringify(r.reasons));
});

test('早期档全角符号也触发禁符号：early 档 demo 含 ３＋２ 被 G1 拒', () => {
  const r = T.checkExplain(segsWith({ demo: '３＋２＝５。' }), P006);
  const hit = r.reasons.find((x) => x.gate === 'G1' && /符号算式/.test(x.why));
  assert.ok(hit, JSON.stringify(r.reasons));
});

test('生活场景：这个知识点就是这么回事。 被拒', () => {
  const r = T.checkExplain(segsWith({ demo: '这个知识点就是这么回事。' }), P006);
  assert.strictEqual(r.ok, false, JSON.stringify(r.reasons));
  const hit = r.reasons.find((x) => x.gate === 'G1' && /生活场景/.test(x.why));
  assert.ok(hit, JSON.stringify(r.reasons));
});

test('生活场景：桌上有 3 个苹果。 通过（量词紧跟数字）', () => {
  const r = T.checkExplain(segsWith({ demo: '桌上有 3 个苹果。' }), P006);
  assert.strictEqual(r.ok, true, JSON.stringify(r.reasons));
});

test('归一只有一处实现：toNarrow 在 topic-explain.js 里只定义一次', () => {
  const src = fs.readFileSync(path.join(ROOT, 'diagnose', 'topic-explain.js'), 'utf8');
  const toNarrowDefs = src.match(/function\s+toNarrow\s*\(/g) || [];
  const oldDefs = src.match(/function\s+toHalfWidthDigits\s*\(/g) || [];
  assert.strictEqual(toNarrowDefs.length, 1, 'toNarrow 必须只定义一次');
  assert.strictEqual(oldDefs.length, 0, '旧的 toHalfWidthDigits 实现必须消失');
});

/* ================================================================
 * 13. 零网络收尾
 * ================================================================ */

console.log('\n--- 零网络收尾 ---');

test('全程零网络：fetch 调用次数为 0', () => {
  assert.strictEqual(fetchCalls, 0, '有代码试图联网');
});

console.log('\n' + (failed === 0 ? '全部通过' : '有失败') + '：' + passed + ' 通过 / ' + failed + ' 失败');
if (failed > 0) process.exitCode = 1;
