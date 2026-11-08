#!/usr/bin/env node
/* O4 卡 A：diagnose/topic-explain.js 纯模块测试（node tests/test_topic_explain.js）
 *
 * 硬约束：
 *   - 零网络：开头把 global.fetch 换成会抛错的计数桩，末尾断言调用次数为 0；
 *   - 零 DOM：不引 jsdom，模块本身也不许碰 document / localStorage / innerHTML；
 *   - 真 require 模块（不是复制一份实现）。
 * 口径：闸门只剩 G1 结构 / G5 文本卫生。
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
    deps: DEPS,
    topics: TOPICS,
    opts
  });
}

/* 一份能过两道闸的讲解：demo 有问句、有以「答案」开头的行。 */
const GOOD = {
  what: '加法就是把两部分合起来。',
  why: '买东西算钱要用加法。',
  how: '1. 先数第一堆。\n2. 再数第二堆。\n3. 从第一个数接着数。',
  demo: '妈妈买了 2 个苹果，又买了 1 个，一共有几个？\n1. 先数 2 个。\n2. 再数 1 个。\n答案：3 个。',
  trap: '别把两堆数丢了。'
};
function segsWith(patch) {
  return Object.assign({}, GOOD, patch);
}

/* 合成知识点：无课标、无题 */
const MID_TOPIC = {
  id: 'cnm_test_mid', name: '测试知识点乙', grade: 7, semester: '上', chapter: '测试章节',
  description: '用于测试的合成知识点。', mastery_criteria: ['测试标准一'], standards: [], type: 'conceptual'
};
const MID_INPUTS = T.buildInputs({
  topic: MID_TOPIC, questions: [], deps: [], topics: [MID_TOPIC]
});

/* 合成知识点：题目没有解析（真实数据里也有这种题） */
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
  deps: [],
  topics: [PLAIN_TOPIC]
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
 * 1. 结构约束：模块必须真「纯」（零网络 / 零 DOM / 零存储直连 / 本模块不做求值）
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

test('topic-explain.js 不做求值（本模块不做求值）', () => {
  assert.ok(!/\bnew\s+Function\b/.test(MODULE_CODE), '发现 new Function');
  assert.ok(!/\bFunction\s*\(/.test(MODULE_CODE), '发现 Function(');
});

test('卡面 §3 的 API 名一个不少（卡 B 照着调）', () => {
  ['levelOf', 'subjectTone', 'prereqsOf', 'buildInputs', 'explainMessages',
    'parseExplain', 'checkExplain', 'chatMessages', 'checkReply', 'cacheKey',
    'readCache', 'writeCache', 'pruneCache', 'subjectOf', 'materialText', 'segsToText'].forEach((name) => {
    assert.strictEqual(typeof T[name], 'function', '缺函数 ' + name);
  });
  assert.strictEqual(T.MAX_ROUNDS, 10);
  assert.strictEqual(T.WINDOW_ROUNDS, 6);
  assert.strictEqual(T.WINDOW_CHARS, 4000);
  assert.strictEqual(T.MAX_ENTRIES, 200);
  assert.deepStrictEqual(T.SEG_KEYS, ['what', 'why', 'how', 'demo', 'trap']);
});

test('导出表已删干净（旧闸门的常量 / 函数一个不留）', () => {
  ['limitsOf', 'EARLY_FORBID_SYMBOLS', 'LIFE_SCENE_WORDS', 'LIFE_SCENE_MEASURES',
    'LIFE_SCENE_ACTIONS', 'COMMON_SMALL_DIGITS'].forEach((name) => {
    assert.strictEqual(T[name], undefined, '不该再导出 ' + name);
  });
});

test('源码不再引用 llm-eval / LLMEval', () => {
  assert.strictEqual(MODULE_SRC.indexOf('llm-eval'), -1, '仍出现 llm-eval');
  assert.strictEqual(MODULE_SRC.indexOf('LLMEval'), -1, '仍出现 LLMEval');
});

/* ================================================================
 * 2. levelOf（§4 语言四档）
 * ================================================================ */

console.log('\n--- levelOf ---');

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
 * 5. buildInputs（素材组装）
 * ================================================================ */

console.log('\n--- buildInputs ---');

const P006 = buildFor(topicById('cnm_p006'));

test('buildInputs：基本字段与学段档（cnm_p006 / 1 年级 → early）', () => {
  assert.strictEqual(P006.topicId, 'cnm_p006');
  assert.strictEqual(P006.level, 'early');
  assert.strictEqual(P006.tone.key, 'math');
  assert.strictEqual(P006.subject, 'math');
  assert.ok(P006.desc.length > 0);
  assert.ok(P006.criteria.length >= 1 && P006.criteria.length <= 3);
});

test('buildInputs：不再产出课标与已删闸门的产物', () => {
  ['standards', 'noStandard', 'limits', 'namePool', 'answerValues', 'questionText'].forEach((k) => {
    assert.strictEqual(P006[k], undefined, '不该再产出 ' + k);
    assert.ok(Object.keys(P006).indexOf(k) < 0, 'Object.keys 里不该有 ' + k);
  });
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
});

test('buildInputs：没有题也能组装（examples 空）', () => {
  assert.deepStrictEqual(MID_INPUTS.examples, []);
});

test('buildInputs：缺 topic 直接抛错（不静默产出半份素材）', () => {
  assert.throws(() => T.buildInputs({}), /缺少 topic/);
});

test('materialText：素材块零课标（无标题、无编号、无课标原文）', () => {
  const text = T.materialText(P006);
  assert.ok(text.indexOf('【课标') < 0, '仍有课标小节');
  assert.ok(text.indexOf('cms-2022') < 0, '仍有课标编号');
  const stdText = STD.items.find((s) => s.id === 'cms-2022:1.NA.04').text;
  assert.ok(stdText && stdText.length > 5);
  assert.ok(text.indexOf(stdText) < 0, '仍复述了课标原文');
  assert.ok(text.indexOf('【知识点】') >= 0);
  assert.ok(text.indexOf('【例题】') >= 0);
  assert.ok(text.indexOf('【直接先修】') >= 0);
  assert.ok(text.indexOf('【学科语气】') >= 0);
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

test('explainMessages：system 带学科语气 + 5 键要求', () => {
  const sys = T.explainMessages(P006)[0].content;
  assert.ok(sys.indexOf(P006.tone.tone) >= 0, '缺学科语气');
  ['what', 'why', 'how', 'demo', 'trap'].forEach((k) => {
    assert.ok(sys.indexOf(k) >= 0, 'system 没点名 JSON 键 ' + k);
  });
});

test('explainMessages：user 素材块含名称/介绍/掌握标准/例题/先修', () => {
  const user = T.explainMessages(P006)[1].content;
  assert.ok(user.indexOf(P006.name) >= 0, '缺知识点名');
  assert.ok(user.indexOf(P006.desc) >= 0, '缺一句话介绍');
  assert.ok(user.indexOf(P006.criteria[0]) >= 0, '缺掌握标准');
  assert.ok(user.indexOf(P006.examples[0].prompt) >= 0, '缺例题题面');
  assert.ok(user.indexOf(P006.prereqs[0].name) >= 0, '缺先修名');
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

test('prompt：含四句排版要求 + 不许引用课标，且不再出现旧课标编号说法', () => {
  const sys = T.explainMessages(P006)[0].content;
  assert.ok(sys.indexOf('每段用分点或分步写，一点一行；不要写成一大段；例子先出题面，再分步解答，最后一行写「答案：」；不要出现课标编号或课标原文。') >= 0,
    '缺四句排版要求');
  assert.ok(sys.indexOf('不许引用课标') >= 0, '缺【不许引用课标】');
  assert.strictEqual(sys.indexOf('cms-2022 编号'), -1, '旧课标编号说法还在');
  assert.ok(sys.indexOf('段内换行写成 \\n（JSON 转义）') >= 0, '缺「段内换行写成 \\n」说明：' + JSON.stringify(sys));
  assert.strictEqual(sys.indexOf('\\\\n'), -1, '不许让模型看到两个反斜杠的 \\\\n');
});

/* 卡 H：作答纪律那一句 —— 只验它这一条在里面，不断言字数/行数/format 要求。 */
test('卡H：system 末尾带作答纪律（直接给结论、别反复推演同一个点）', () => {
  const sys = T.explainMessages(P006)[0].content;
  assert.ok(sys.indexOf('答题要求：直接给出结论，不要在心里反复推演同一个点；想清楚一遍就写。') >= 0,
    '缺作答纪律那句（长推理会把 max_tokens 吃光 → finish_reason=length）');
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
  const raw = '{"what":"甲。","why":"乙。","how":"丙。","demo":"2+1=3？\\n答案：3。","trap":"丁。",}';
  const r = T.parseExplain(raw);
  assert.ok(r.segs, '应当逐键抠出来');
  assert.strictEqual(r.segs.how, '丙。');
});

test('parseExplain：少一个键 → segs=null 并说明缺哪个（不猜）', () => {
  const raw = '{"what":"甲。","why":"乙。","how":"丙。","demo":"2+1=3？"';
  const r = T.parseExplain(raw);
  assert.strictEqual(r.segs, null);
  assert.ok(/trap/.test(r.why), 'why 里要点名缺的键：' + r.why);
});

test('parseExplain：空返回 → segs=null', () => {
  assert.strictEqual(T.parseExplain('').segs, null);
  assert.strictEqual(T.parseExplain(null).segs, null);
});

test('parseExplain：转义字符还原（引号与换行）', () => {
  const raw = '{"what":"他说\\"好\\"","why":"两行\\n第二行","how":"丙。","demo":"2+1=3？\\n答案：3。","trap":"丁。"}';
  const r = T.parseExplain(raw);
  assert.strictEqual(r.segs.what, '他说"好"');
  assert.strictEqual(r.segs.why, '两行\n第二行');
});

/* ================================================================
 * 8. checkExplain（G1 结构 / G5 文本卫生）
 * ================================================================ */

console.log('\n--- checkExplain ---');

function gates(result) { return result.reasons.map((r) => r.gate); }

test('G1：5 段齐全 → 通过', () => {
  const r = T.checkExplain(GOOD);
  assert.deepStrictEqual(r.reasons, []);
  assert.strictEqual(r.ok, true);
});

test('G1：缺任一段 → 拒（5 个变体逐个跑）', () => {
  T.SEG_KEYS.forEach((k) => {
    const segs = Object.assign({}, GOOD);
    delete segs[k];
    const r = T.checkExplain(segs);
    assert.strictEqual(r.ok, false, '删掉 ' + k + ' 应当被拒');
    assert.ok(r.reasons.some((x) => x.gate === 'G1' && /缺少段落/.test(x.why)),
      '缺 ' + k + ' 要报「缺少段落」：' + JSON.stringify(r.reasons));
  });
});

test('G1：任一段只有空白 → 拒（5 个变体逐个跑）', () => {
  T.SEG_KEYS.forEach((k) => {
    const r = T.checkExplain(segsWith({ [k]: '   \n ' }));
    assert.strictEqual(r.ok, false, k + ' 只有空白应当被拒');
    assert.ok(gates(r).indexOf('G1') >= 0, JSON.stringify(r.reasons));
  });
});

test('G1：demo 无问号 → 拒，why 提到问句', () => {
  const r = T.checkExplain(segsWith({ demo: '妈妈买了 2 个苹果。\n1. 先数 2 个。\n答案：2 个。' }));
  assert.strictEqual(r.ok, false);
  assert.ok(r.reasons.some((x) => x.gate === 'G1' && x.why.indexOf('问句') >= 0),
    JSON.stringify(r.reasons));
});

test('G1：问句必须在 demo 段（what 里有问句不算）', () => {
  const r = T.checkExplain(segsWith({ what: '加法是什么？', demo: '妈妈买了 2 个苹果。\n答案：2 个。' }));
  assert.strictEqual(r.ok, false);
  assert.ok(r.reasons.some((x) => x.gate === 'G1' && x.why.indexOf('问句') >= 0),
    JSON.stringify(r.reasons));
});

test('G1：demo 无「答案」行 → 拒', () => {
  const r = T.checkExplain(segsWith({ demo: '妈妈买了 2 个苹果，一共有几个？\n1. 先数 2 个。' }));
  assert.strictEqual(r.ok, false);
  assert.ok(r.reasons.some((x) => x.gate === 'G1' && x.why.indexOf('答案') >= 0),
    JSON.stringify(r.reasons));
});

test('G1：合规样例（题面问句 + 1. 2. 分步 + 末行答案）→ 通过', () => {
  const segs = segsWith({
    how: '1. 先数第一堆。\n2. 再数第二堆。\n3. 接着数。',
    demo: '妈妈买了 2 个苹果，又买了 1 个，一共有几个？\n1. 先数 2 个。\n2. 再数 1 个。\n答案：3 个。'
  });
  assert.strictEqual(T.checkExplain(segs).ok, true, JSON.stringify(T.checkExplain(segs).reasons));
});

test('G1：「答案」行不在末行也通过（只查有没有，不查第几行）', () => {
  const r = T.checkExplain(segsWith({ demo: '一共有几个？\n答案：3 个。\n1. 先数 2 个。' }));
  assert.strictEqual(r.ok, true, JSON.stringify(r.reasons));
});

test('G5：** 加粗 / 反引号 / 反斜杠命令 / 井号标题 / 省略号 各自都拒', () => {
  [
    { how: '**先数第一堆**。' },
    { how: '先数第一堆，记作 `a`。' },
    { how: '先算 \\frac{1}{2}。' },
    { how: '# 第一步\n先数第一堆。' },
    { how: '先数 1、2、3…' }
  ].forEach((patch) => {
    const r = T.checkExplain(segsWith(patch));
    assert.strictEqual(r.ok, false, JSON.stringify(patch) + ' 应当被拒');
    assert.ok(gates(r).indexOf('G5') >= 0, JSON.stringify(patch) + ' 应命中 G5');
  });
});

test('G5 不误伤：1. 2. 分点、答案：行、全角问号 → 通过', () => {
  const segs = segsWith({ demo: '桌上有 2 个苹果，一共有几个？\n1. 先数 2 个。\n2. 再看一眼。\n答案：2 个。' });
  const r = T.checkExplain(segs);
  assert.strictEqual(r.ok, true, JSON.stringify(r.reasons));
  assert.ok(segs.demo.indexOf('？') >= 0);
  assert.ok(segs.demo.indexOf('答案：') >= 0);
});

test('多因并列：G1 与 G5 同时命中时两条都要报', () => {
  const segs = segsWith({ how: '**先数第一堆**。' });
  delete segs.trap;
  const r = T.checkExplain(segs);
  assert.strictEqual(r.ok, false);
  assert.ok(gates(r).indexOf('G1') >= 0, '缺 G1');
  assert.ok(gates(r).indexOf('G5') >= 0, '缺 G5');
  assert.ok(r.reasons.length >= 2);
});

test('checkExplain：segs 为 null 时不炸，报 G1', () => {
  const r = T.checkExplain(null);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reasons[0].gate, 'G1');
});

/* ================================================================
 * 9. 新契约：不计数、不看数字、不看符号、不看字数 —— 全部放行
 * ================================================================ */

console.log('\n--- 新契约：全部放行 ---');

test('新契约：算错也能过（3 + 1 = 2）', () => {
  const r = T.checkExplain(segsWith({ demo: '1 加 1 等于几？\n答案：3 + 1 = 2。' }));
  assert.strictEqual(r.ok, true, JSON.stringify(r.reasons));
});

test('新契约：全角算式也放行（３＋２＝５）', () => {
  const r = T.checkExplain(segsWith({ demo: '一加二等于几？\n答案：３＋２＝５。' }));
  assert.strictEqual(r.ok, true, JSON.stringify(r.reasons));
});

test('新契约：素材里没有的数字 9 也放行', () => {
  const r = T.checkExplain(segsWith({ demo: '桌上有 9 个苹果，一共有几个？\n答案：9 个。' }));
  assert.strictEqual(r.ok, true, JSON.stringify(r.reasons));
});

test('新契约：grade 1 正文写出 3 + 2 = 5 也放行', () => {
  const r = T.checkExplain(segsWith({ what: '加法就是把两部分合起来，比如 3 + 2 = 5。' }));
  assert.strictEqual(r.ok, true, JSON.stringify(r.reasons));
});

test('新契约：500 字长回答放行（没有字数上限）', () => {
  assert.strictEqual(T.checkReply('数'.repeat(500)).ok, true);
});

/* ================================================================
 * 10. checkReply（只剩 G5 文本卫生）
 * ================================================================ */

console.log('\n--- checkReply ---');

test('checkReply：空答 → ok === true（旧长度闸已删，如实钉住）', () => {
  assert.strictEqual(T.checkReply('').ok, true);
  assert.strictEqual(T.checkReply('   ').ok, true);
});

test('checkReply：普通回答通过', () => {
  const r = T.checkReply('把两堆合起来数一数就得到结果了。');
  assert.strictEqual(r.ok, true, JSON.stringify(r.reasons));
});

test('checkReply：G5 同样生效（** 加粗 / 反引号）', () => {
  assert.ok(gates(T.checkReply('**就是这样**。')).indexOf('G5') >= 0);
  assert.ok(gates(T.checkReply('记作 `a`。')).indexOf('G5') >= 0);
});

test('checkReply：算式与数字一律不管（3 + 1 = 2 通过）', () => {
  assert.strictEqual(T.checkReply('3 + 1 = 2').ok, true);
  assert.strictEqual(T.checkReply('３＋１＝２').ok, true);
});

/* ================================================================
 * 11. chatMessages（多轮：锚点不裁 / 窗口 6 轮 / 字符预算 / 失败轮过滤）
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

test('追问轮 system：只用白名单知识点 + 不直接给答案 + 无回答长度档', () => {
  const sys = T.chatMessages(P006, GOOD, [], '问')[0].content;
  assert.ok(sys.indexOf('一次只答一个问题') >= 0);
  assert.ok(sys.indexOf('可以提到的知识点') >= 0);
  assert.ok(sys.indexOf('不许引用课标') >= 0);
  assert.strictEqual(sys.indexOf('回答长度'), -1, '回答长度档应当已删除');
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
 * 12. 缓存（cacheKey / readCache / writeCache / pruneCache）
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
 * 13. 截断判定 needsRefetch（卡 D：只判「有没有拿到东西」，不判内容质量）
 * ================================================================ */

test('needsRefetch：finish_reason=length → true（哪怕正文有半截内容）', () => {
  assert.strictEqual(T.needsRefetch({ choices: [{ finish_reason: 'length', message: { content: '{"what":"半截' } }] }), true);
});

test('needsRefetch：正文空串 → true', () => {
  assert.strictEqual(T.needsRefetch({ choices: [{ finish_reason: 'stop', message: { content: '' } }] }), true);
});

test('needsRefetch：正文全空白 → true', () => {
  assert.strictEqual(T.needsRefetch({ choices: [{ finish_reason: 'stop', message: { content: ' \n\t  ' } }] }), true);
});

test('needsRefetch：finish=stop 且有内容 → false', () => {
  assert.strictEqual(T.needsRefetch({ choices: [{ finish_reason: 'stop', message: { content: '{"what":"甲"}' } }] }), false);
});

test('needsRefetch：body 为 null → false（走「网关失败」分支，不当截断）', () => {
  assert.strictEqual(T.needsRefetch(null), false);
  assert.strictEqual(T.needsRefetch(undefined), false);
});

test('needsRefetch：缺 choices / choices 空数组 → false', () => {
  assert.strictEqual(T.needsRefetch({}), false);
  assert.strictEqual(T.needsRefetch({ choices: [] }), false);
  assert.strictEqual(T.needsRefetch({ choices: null }), false);
});

test('needsRefetch：缺 message 或 content 不是字符串 → false（不猜，交给上层既有分支）', () => {
  assert.strictEqual(T.needsRefetch({ choices: [{ finish_reason: 'stop' }] }), false);
  assert.strictEqual(T.needsRefetch({ choices: [{ finish_reason: 'stop', message: { content: null } }] }), false);
  assert.strictEqual(T.needsRefetch({ choices: [{ finish_reason: 'stop', message: { content: 42 } }] }), false);
});

test('needsRefetch：纯函数，不改入参', () => {
  const body = { choices: [{ finish_reason: 'length', message: { content: '' } }] };
  const before = JSON.stringify(body);
  T.needsRefetch(body);
  assert.strictEqual(JSON.stringify(body), before, 'needsRefetch 不许改入参');
});

/* ================================================================
 * 13b. 网关错误体 gatewayErrorOf（卡 E：HTTP 200 里的业务错误包，不是模型输出）
 * ================================================================ */

console.log('\n--- 网关错误体 gatewayErrorOf（卡 E） ---');

test('gatewayErrorOf：{"retCode":9} → {code:9}', () => {
  assert.deepStrictEqual(T.gatewayErrorOf({ retCode: 9 }), { code: 9 });
});

test('gatewayErrorOf：retCode:0 且有正常 choices → null（拿到模型输出，0 不算错误）', () => {
  assert.strictEqual(T.gatewayErrorOf({ retCode: 0, choices: [{ message: { content: 'x' } }] }), null);
});

test('gatewayErrorOf：error.code / error.type / 空 error 各自取码', () => {
  assert.deepStrictEqual(T.gatewayErrorOf({ error: { code: 'x' } }), { code: 'x' });
  assert.deepStrictEqual(T.gatewayErrorOf({ error: { type: 'y' } }), { code: 'y' });
  assert.deepStrictEqual(T.gatewayErrorOf({ error: {} }), { code: 'error' });
});

test('gatewayErrorOf：{} 与 retCode:0（无 choices）→ no-choices', () => {
  assert.deepStrictEqual(T.gatewayErrorOf({}), { code: 'no-choices' });
  assert.deepStrictEqual(T.gatewayErrorOf({ retCode: 0 }), { code: 'no-choices' });
});

test('gatewayErrorOf：null / undefined / 字符串 / 数字 / 数组 → null', () => {
  assert.strictEqual(T.gatewayErrorOf(null), null);
  assert.strictEqual(T.gatewayErrorOf(undefined), null);
  assert.strictEqual(T.gatewayErrorOf('str'), null);
  assert.strictEqual(T.gatewayErrorOf(42), null);
  assert.strictEqual(T.gatewayErrorOf([]), null);
});

test('gatewayErrorOf：正常 choices → null，且有 choices 优先于 no-choices 兜底', () => {
  assert.strictEqual(T.gatewayErrorOf({ choices: [{ message: { content: '...' } }] }), null);
  assert.strictEqual(T.gatewayErrorOf({ choices: [] }), null);
});

test('gatewayErrorOf：纯函数，不改入参', () => {
  const body = { retCode: 9 };
  const before = JSON.stringify(body);
  T.gatewayErrorOf(body);
  assert.strictEqual(JSON.stringify(body), before, 'gatewayErrorOf 不许改入参');
});

/* ================================================================
 * 14. 零网络收尾
 * ================================================================ */

console.log('\n--- 零网络收尾 ---');

test('全程零网络：fetch 调用次数为 0', () => {
  assert.strictEqual(fetchCalls, 0, '有代码试图联网');
});

console.log('\n' + (failed === 0 ? '全部通过' : '有失败') + '：' + passed + ' 通过 / ' + failed + ' 失败');
if (failed > 0) process.exitCode = 1;
