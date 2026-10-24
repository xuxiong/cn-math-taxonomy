#!/usr/bin/env node
/* 作业分析文字 → 知识点定位 → 学习路径 的纯函数层测试：node tests/test_route.js
 *
 * 直测 diagnose/route.js —— 零依赖、无网络、无 DOM。LLM 用注入的假 fetch，不碰真网关。
 *
 * 覆盖（对应卡片的验收 1–8）：
 *   1. parseFields 各种年级写法 → 年级数字正确
 *   2. parseFields 解析不出时是明确的「未解析」标记，不是空字符串
 *   3. candidates 四级降级各自规模合理
 *   4. candidates 永远排除英语知识点（id 前缀 cne，701 个）
 *   5. LLM 返回不在候选池里的 id → 校验拒绝
 *   6. LLM 返回库里不存在的知识点名 → 校验拒绝
 *   7. prerequisites 只用 hard 边；soft 边出现在单独字段
 *   8. 低学段 soft 前置被过滤（配方法 ← 三年级「长方形和正方形的面积」；
 *      垂径定理 hard 链里四年级「轴对称」也不许进主路径）
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) {
    failed++;
    console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e).split('\n').slice(0, 4).join('\n       '));
  }
}
function testAsync(name, fn) {
  return fn().then(
    () => { passed++; console.log('  ok   ' + name); },
    (e) => {
      failed++;
      console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e).split('\n').slice(0, 4).join('\n       '));
    }
  );
}

const ROOT = path.join(__dirname, '..');
const R = require('../diagnose/route.js');
const TOPICS = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'topics.json'), 'utf8'));
const DEPS = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'dependencies.json'), 'utf8'));
const INFO = R.setData(TOPICS, DEPS);

const byName = (nm) => TOPICS.filter((t) => t.name === nm);
const idOf = (nm) => {
  const hit = byName(nm);
  assert.ok(hit.length >= 1, '库里没有知识点「' + nm + '」');
  return hit[0].id;
};

/* ================================================================
 * 0. 数据前提：这 8 个测试全部依赖下面的数据事实，先断死
 * ================================================================ */

console.log('\n--- 数据前提 ---');

test('topics.json 共 1503 个知识点，数学 802 / 英语 701', () => {
  assert.strictEqual(TOPICS.length, 1503);
  assert.strictEqual(TOPICS.filter((t) => t.id.startsWith('cnm')).length, 802);
  assert.strictEqual(TOPICS.filter((t) => t.id.startsWith('cne')).length, 701);
  assert.strictEqual(INFO.topics, 802, 'setData 只留数学');
});

test('依赖边 2176 条，hard 1323 / soft 853', () => {
  assert.strictEqual(DEPS.length, 2176);
  assert.strictEqual(INFO.dependencies, 2176);
  assert.strictEqual(DEPS.filter((d) => d.strength === 'hard').length, 1323);
  assert.strictEqual(DEPS.filter((d) => d.strength === 'soft').length, 853);
});

/* ================================================================
 * 1. parseFields：年级各种写法
 * ================================================================ */

console.log('\n--- 1. parseFields 年级识别 ---');

const GRADE_CASES = [
  ['这是一道初三数学题', 9],
  ['九年级上册的题', 9],
  ['七年级的整式加减', 7],
  ['八年级几何', 8],
  ['高中二年级 一元二次不等式', 11],
  ['高三模拟题', 12],
  ['高一 集合', 10],
  ['高二 数列', 11],
  ['初二 一次函数', 8],
  ['初一 有理数', 7],
  ['小学四年级 角的度量', 4],
  ['三年级 长方形和正方形的面积', 3],
  ['一年级 10以内的加法', 1],
  ['12年级 复习', 12],
  ['9年级 二次函数', 9],
  ['选必二 数列求和', 13],
  ['必修一 集合', 10]
];

GRADE_CASES.forEach(([text, want]) => {
  test('「' + text + '」→ 年级 ' + want, () => {
    const f = R.parseFields(text);
    assert.strictEqual(f.grade.parsed, true, '没解析出年级');
    assert.strictEqual(f.grade.value, want);
    assert.ok(f.grade.raw && f.grade.raw.length > 0, '要保留原文片段');
  });
});

test('学段由年级推出：初三 → 初中，高三 → 高中，三年级 → 小学', () => {
  assert.strictEqual(R.parseFields('初三 一元二次方程').stage.value, '初中');
  assert.strictEqual(R.parseFields('高三 导数').stage.value, '高中');
  assert.strictEqual(R.parseFields('三年级 面积').stage.value, '小学');
});

test('13-16 是高中，不是大学：12年级映射到 12（高三），不进 13-16', () => {
  const f = R.parseFields('12年级 数列');
  assert.strictEqual(f.grade.value, 12);
  assert.strictEqual(f.stage.value, '高中');
});

/* ================================================================
 * 2. parseFields：未解析出 ≠ 空字符串
 * ================================================================ */

console.log('\n--- 2. 未解析标记 ---');

test('「这道题不会」：每个字段都是 parsed:false 且 value === null', () => {
  const f = R.parseFields('这道题不会');
  ['grade', 'stage', 'domain', 'chapter', 'topicHint'].forEach((k) => {
    assert.strictEqual(f[k].parsed, false, k + ' 不该解析出');
    assert.strictEqual(f[k].value, null, k + ' 未解析出时 value 必须是 null，不是空字符串');
    assert.notStrictEqual(f[k].value, '', k + ' 空字符串会和「解析出空值」混淆');
  });
  assert.deepStrictEqual(f.missing.sort(), ['chapter', 'domain', 'grade', 'stage', 'topicHint'].sort());
});

test('「这是一道语文阅读理解题」：年级/领域都未解析出，但考点描述有内容', () => {
  const f = R.parseFields('这是一道语文阅读理解题');
  assert.strictEqual(f.grade.parsed, false);
  assert.strictEqual(f.domain.parsed, false);
  assert.strictEqual(f.topicHint.parsed, true);
  assert.ok(f.topicHint.value.includes('语文'));
  assert.strictEqual(f.subject.value, '语文');
  assert.strictEqual(f.subject.math, false);
});

test('提到别的学科且全文没提「数学」→ 不是数学题（领域关键词救不回来）', () => {
  /* 「面积」是图形与几何的关键词，但这是一道英语题——不能靠领域词把它拉回数学 */
  const f = R.parseFields('初三 英语 面积计算');
  assert.strictEqual(f.domain.parsed, true, '领域关键词确实会命中');
  assert.strictEqual(f.subject.math, false, '但有别的学科名、又没有「数学」，必须判成非数学');
  const f2 = R.parseFields('这是一道初三数学题，考英语描述的应用题');
  assert.strictEqual(f2.subject.math, true, '提到「数学」就不再拒绝');
});

test('「高一下」的册次不会被当成考点描述', () => {
  const f = R.parseFields('高一下 平面向量');
  assert.strictEqual(f.grade.value, 10);
  assert.strictEqual(f.topicHint.value, '平面向量');
});

test('空输入不抛异常，全部字段未解析出', () => {
  [ '', '   ', null, undefined ].forEach((t) => {
    const f = R.parseFields(t);
    assert.strictEqual(f.grade.parsed, false);
    assert.strictEqual(f.domain.parsed, false);
    assert.strictEqual(f.missing.length, 5);
  });
});

test('解析出与未解析出可以同时存在：有年级、没有章节', () => {
  const f = R.parseFields('初三 数与代数 用配方法解一元二次方程');
  assert.strictEqual(f.grade.parsed, true);
  assert.strictEqual(f.domain.parsed, true);
  assert.ok(f.chapter.parsed, '「一元二次方程」是章节标题，应解析出');
  const f2 = R.parseFields('初三 数与代数 这道题不会做');
  assert.strictEqual(f2.grade.parsed, true);
  assert.strictEqual(f2.chapter.parsed, false);
  assert.strictEqual(f2.chapter.value, null);
});

/* ================================================================
 * 3. candidates：四级降级
 * ================================================================ */

console.log('\n--- 3. candidates 降级阶梯 ---');

test('年级 + 领域 → 候选池约 10 个（初三 + 数与代数）', () => {
  const f = R.parseFields('这是一道初三数学题，考查用配方法解一元二次方程，学生算到一半卡住了。');
  const c = R.candidates(f);
  assert.strictEqual(c.ok, true);
  assert.strictEqual(c.level, 'grade+domain');
  assert.ok(c.count >= 3 && c.count <= 40, '候选池规模异常：' + c.count);
  assert.ok(c.topics.every((t) => t.grade === 9 && t.domain === '数与代数'));
});

test('学年+领域+章节 → 更窄（一元二次方程这一章）', () => {
  const f = R.parseFields('这是一道初三数学题，考查用配方法解一元二次方程，学生算到一半卡住了。');
  const c = R.candidates(f);
  assert.strictEqual(c.chapterUsed, '一元二次方程');
  assert.ok(c.count >= 3 && c.count < 20, '章节筛完应更窄：' + c.count);
  assert.ok(c.topics.some((t) => t.name === '配方法'), '候选池里必须有配方法');
});

test('学段 + 领域 → 候选池 50-160（初中 + 图形与几何）', () => {
  const f = R.parseFields('初中 图形与几何 的题');
  const c = R.candidates(f);
  assert.strictEqual(c.level, 'stage+domain');
  assert.ok(c.count >= 50 && c.count <= 160, '候选池规模异常：' + c.count);
  assert.ok(c.topics.every((t) => t.grade >= 7 && t.grade <= 9 && t.domain === '图形与几何'));
});

test('只有领域 → 候选池 150-450（数与代数）', () => {
  const f = R.parseFields('数学 数与代数 的题');
  const c = R.candidates(f);
  assert.strictEqual(c.level, 'domain');
  assert.strictEqual(c.chapterUsed, null, '只有领域时不许用章节当筛子（2 字章节名太容易撞）');
  assert.ok(c.count >= 150 && c.count <= 450, '候选池规模异常：' + c.count);
});

test('什么都解析不出 → 明确说信息不足，一个知识点都不给', () => {
  const f = R.parseFields('这道题不会');
  const c = R.candidates(f);
  assert.strictEqual(c.ok, false);
  assert.strictEqual(c.level, 'none');
  assert.strictEqual(c.count, 0);
  assert.deepStrictEqual(c.topics, []);
  assert.ok(c.reason.includes('信息不足'), '必须明说信息不足：' + c.reason);
  assert.ok(c.reason.includes('年级'), '必须引导学生补年级：' + c.reason);
});

test('非数学文字（语文阅读理解）也走「信息不足」，不硬匹配数学知识点', () => {
  const f = R.parseFields('这是一道语文阅读理解题');
  const c = R.candidates(f);
  assert.strictEqual(c.ok, false);
  assert.strictEqual(c.count, 0);
});

/* ================================================================
 * 4. candidates 排除英语
 * ================================================================ */

console.log('\n--- 4. 永远排除英语知识点（cne） ---');

const POOL_INPUTS = [
  '这是一道初三数学题，考查用配方法解一元二次方程',
  '三年级 长方形和正方形的面积',
  '高三 导数',
  '七年级 单词拼写',          /* 故意提英语需求，候选池仍然只能是数学 */
  '英语 语法 现在完成时',      /* 纯英语输入 */
  '数学 数与代数',
  '初中 图形与几何',
  '小学 统计与概率',
  '八年级 阅读理解',
  '这道题不会'
];

test('任何输入下候选池都没有 cne 前缀（数学 802 里挑）', () => {
  POOL_INPUTS.forEach((text) => {
    const c = R.candidates(R.parseFields(text));
    c.topics.forEach((t) => {
      assert.ok(t.id.indexOf('cne') !== 0, '候选池混进了英语知识点：' + t.id + ' / ' + t.name);
      assert.ok(t.id.startsWith('cnm'), '候选池只允许 cnm 前缀：' + t.id);
    });
  });
});

test('英语领域词不会把候选池带偏到英语知识点上', () => {
  const c = R.candidates(R.parseFields('英语 语法 现在完成时'));
  assert.ok(c.topics.every((t) => t.id.startsWith('cnm')));
});

/* ================================================================
 * 5-6. verifyPick：确定性校验
 * ================================================================ */

console.log('\n--- 5. LLM 返回候选池外的 id → 拒绝 ---');

const EXAMPLE = '这是一道初三数学题，考查用配方法解一元二次方程，学生算到一半卡住了。';
const exFields = R.parseFields(EXAMPLE);
const exPool = R.candidates(exFields);

test('选中 id 不在候选池内 → 规则1 拒绝', () => {
  const outside = TOPICS.find((t) => t.id.startsWith('cnm') && exPool.topics.every((p) => p.id !== t.id));
  assert.ok(outside, '需要构造一个池外的知识点');
  const v = R.verifyPick([{ id: outside.id, name: outside.name, confidence: 0.95, reason: 'x' }],
    { pool: exPool.topics, fields: exFields });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.kept.length, 0);
  assert.strictEqual(v.rejected[0].rule, '规则1');
  assert.ok(v.rejected[0].why.includes('不在本次候选池内'), v.rejected[0].why);
  assert.ok(v.why.length >= 1, '拒绝必须给具体理由');
});

test('池内合法选择 → 通过，置信度与覆盖率都回来', () => {
  const pid = idOf('配方法');
  const v = R.verifyPick([{ id: pid, name: '配方法', confidence: 0.82, reason: '题面说的就是用配方法解' }],
    { pool: exPool.topics, fields: exFields });
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.kept[0].id, pid);
  assert.strictEqual(v.kept[0].name, '配方法');
  assert.ok(v.kept[0].coverage > 0.2, '考点覆盖应能对上：' + v.kept[0].coverage);
  assert.strictEqual(v.kept[0].confidence, 0.82);
});

console.log('\n--- 6. LLM 编造知识点名 → 拒绝 ---');

test('id 真实但名字被改 → 规则2 拒绝（防编造）', () => {
  const pid = idOf('配方法');
  const v = R.verifyPick([{ id: pid, name: '配方法的九种技巧', confidence: 0.9, reason: 'x' }],
    { pool: exPool.topics, fields: exFields });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.rejected[0].rule, '规则2');
  assert.ok(v.rejected[0].why.includes('配方法'), '要说清库里真实的名字是什么');
});

test('id 和名字都不存在 → 拒绝', () => {
  const v = R.verifyPick([{ id: 'cnm_fake_999', name: '三角函数与二次函数的综合应用技巧', confidence: 0.9, reason: 'x' }],
    { pool: exPool.topics, fields: exFields });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.kept.length, 0);
});

test('池内但考点描述完全对不上 → 规则3 拒绝', () => {
  const pid = idOf('根的判别式');
  assert.ok(exPool.topics.some((t) => t.id === pid), '根的判别式应在候选池里');
  const v = R.verifyPick([{ id: pid, name: '根的判别式', confidence: 0.9, reason: 'x' }],
    { pool: exPool.topics, fields: exFields });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.rejected[0].rule, '规则3');
  assert.ok(v.rejected[0].why.includes('完全找不到对应'), v.rejected[0].why);
});

test('LLM 只给名字不给 id → 名字在池内唯一时补 id，仍要对得上考点', () => {
  const v = R.verifyPick([{ name: '配方法', confidence: 0.7, reason: '题面' }],
    { pool: exPool.topics, fields: exFields });
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.kept[0].id, idOf('配方法'));
});

test('LLM 什么都没选 → 不通过，理由说清', () => {
  const v = R.verifyPick([], { pool: exPool.topics, fields: exFields });
  assert.strictEqual(v.ok, false);
  assert.ok(v.why.join(' ').includes('没有返回'));
});

test('返回超过 3 个 → 只留置信度最高的 3 个', () => {
  const picks = exPool.topics.slice(0, 5).map((t, i) => ({ id: t.id, name: t.name, confidence: 0.9 - i * 0.1, reason: 'x' }));
  const v = R.verifyPick(picks, { pool: exPool.topics, fields: exFields });
  assert.ok(v.kept.length <= 3, '最多 3 个：' + v.kept.length);
  if (v.kept.length >= 2) assert.ok(v.kept[0].confidence >= v.kept[1].confidence, '按置信度降序');
});

/* ================================================================
 * 7. prerequisites：只用 hard 边
 * ================================================================ */

console.log('\n--- 7. prerequisites 只走 hard 边 ---');

test('配方法的前置：hard 层里全是 hard，soft 在单独字段', () => {
  const pre = R.prerequisites(idOf('配方法'), 2);
  assert.ok(pre, '配方法必须能回溯');
  const hardItems = [];
  pre.levels.forEach((lv) => {
    lv.items.forEach((it) => {
      assert.strictEqual(it.strength, 'hard', '主链里混进了 soft 边：' + it.name);
      hardItems.push(it);
    });
  });
  assert.ok(hardItems.length >= 2, 'hard 前置至少 2 个（直接开平方法 / 完全平方公式）');
  const names = hardItems.map((i) => i.name);
  assert.ok(names.includes('直接开平方法'), '缺直接开平方法：' + names.join(','));
  assert.ok(names.includes('完全平方公式'), '缺完全平方公式：' + names.join(','));
  assert.ok(Array.isArray(pre.soft), 'soft 必须单独在 soft 字段里');
  pre.soft.forEach((it) => assert.strictEqual(it.strength, 'soft'));
  assert.ok(pre.soft.length >= 1, '配方法周边应有 soft 边（平方差公式等）');
});

test('soft 边的节点一个都不在 hard 主链里', () => {
  const pre = R.prerequisites(idOf('配方法'), 3);
  const hardIds = new Set();
  pre.levels.forEach((lv) => lv.items.forEach((it) => hardIds.add(it.id)));
  pre.soft.forEach((it) => assert.ok(!hardIds.has(it.id), 'soft 节点出现在主链：' + it.name));
});

test('depth 默认为 2，可配置', () => {
  const d1 = R.prerequisites(idOf('配方法'));
  assert.strictEqual(d1.levels.length, 2, '默认深度 2');
  const d3 = R.prerequisites(idOf('配方法'), 3);
  assert.strictEqual(d3.levels.length, 3);
  const deep = R.prerequisites(idOf('配方法'), 3);
  const count3 = deep.levels.reduce((n, lv) => n + lv.items.length, 0);
  const count2 = d1.levels.reduce((n, lv) => n + lv.items.length, 0);
  assert.ok(count3 >= count2, '深一层不该更少');
});

test('未知 id → null', () => {
  assert.strictEqual(R.prerequisites('cnm_not_exist', 2), null);
});

/* ================================================================
 * 8. 低学段 soft 前置被过滤
 * ================================================================ */

console.log('\n--- 8. 低学段 / 跨学段噪音过滤 ---');

test('配方法：三年级「长方形和正方形的面积」被过滤，不在主链和 soft 里，只在 excluded', () => {
  const pre = R.prerequisites(idOf('配方法'), 2);
  const hardNames = [];
  pre.levels.forEach((lv) => lv.items.forEach((it) => hardNames.push(it.name)));
  const softNames = pre.soft.map((i) => i.name);
  const exNames = pre.excluded.map((i) => i.name);
  assert.ok(!hardNames.includes('长方形和正方形的面积'), '小学三年级节点进了主链');
  assert.ok(!softNames.includes('长方形和正方形的面积'), '小学三年级节点进了可选补充');
  assert.ok(exNames.includes('长方形和正方形的面积'), '应出现在 excluded 里并说明原因');
  const ex = pre.excluded.find((i) => i.name === '长方形和正方形的面积');
  assert.strictEqual(ex.grade, 3);
  assert.strictEqual(ex.strength, 'soft');
  assert.ok(/跨学段|噪音/.test(ex.excludedWhy), '过滤原因要写清：' + ex.excludedWhy);
});

test('垂径定理：路径里没有任何小学节点（目标本身就是初中）', () => {
  const pre = R.prerequisites(idOf('垂径定理'), 2);
  const nodes = R.buildPath(pre).nodes;
  nodes.forEach((n) => {
    assert.ok(n.grade > 6, '路径里出现了小学节点：' + n.name + '（' + n.grade + ' 年级）');
  });
  assert.ok(nodes.some((n) => n.isTarget), '目标节点必须在路径里');
});

test('垂径定理：四年级「轴对称」被过滤并说明是跨学段', () => {
  const pre = R.prerequisites(idOf('垂径定理'), 2);
  const hardNames = [];
  pre.levels.forEach((lv) => lv.items.forEach((it) => hardNames.push(it.name)));
  assert.ok(!hardNames.includes('轴对称'), '四年级轴对称进了 hard 主链');
  const ex = pre.excluded.find((i) => i.name === '轴对称');
  assert.ok(ex, '轴对称应在 excluded 里');
  assert.strictEqual(ex.grade, 4);
});

test('目标本身是小学时不过滤小学前置', () => {
  /* 小学知识点的前置大多是小学，规则不允许把它们全砍掉 */
  const t = TOPICS.find((x) => x.grade === 3 && x.id.startsWith('cnm'));
  const pre = R.prerequisites(t.id, 2);
  assert.ok(pre);
  const items = pre.levels.reduce((a, lv) => a.concat(lv.items), []);
  assert.ok(items.every((i) => i.grade <= 6), '小学目标的前置应都是小学：' +
    items.map((i) => i.name + '/' + i.grade).join(','));
});

/* ================================================================
 * 9. buildPath：节点全标「候选，待测确认」
 * ================================================================ */

console.log('\n--- 9. buildPath ---');

test('路径节点全部标 pending + 「候选，待测确认」，并按年级从低到高', () => {
  const pre = R.prerequisites(idOf('配方法'), 2);
  const p = R.buildPath(pre);
  assert.ok(p.nodes.length >= 3);
  p.nodes.forEach((n) => {
    assert.strictEqual(n.pending, true, '节点没标待测：' + n.name);
    assert.strictEqual(n.label, '候选，待测确认');
  });
  for (let i = 1; i < p.nodes.length; i++) {
    assert.ok(p.nodes[i - 1].grade <= p.nodes[i].grade, '路径必须按年级从低到高');
  }
  assert.ok(p.nodes[p.nodes.length - 1].isTarget, '目标知识点在最后');
  assert.ok(/依赖图不是诊断结果/.test(p.note), '必须写清图不是诊断结果');
});

test('配方法的路径里出现「完全平方公式」（验收 3 的判据）', () => {
  const p = R.buildPath(R.prerequisites(idOf('配方法'), 2));
  assert.ok(p.nodes.some((n) => n.name === '完全平方公式'), '路径缺完全平方公式');
});

/* ================================================================
 * 10. locate：端到端（注入假 fetch，不碰真网关）
 * ================================================================ */

console.log('\n--- 10. locate 端到端（假网关） ---');

function fakeFetch(reply) {
  return function () {
    return Promise.resolve({
      ok: true,
      status: 200,
      json: function () {
        return Promise.resolve({
          choices: [{ message: { content: typeof reply === 'string' ? reply : JSON.stringify(reply) } }]
        });
      }
    });
  };
}

const ASYNC = [];

ASYNC.push(testAsync('正常文字 → 定位到配方法 → 有前置链和路径', () => {
  const pid = idOf('配方法');
  return R.locate(EXAMPLE, {
    fetch: fakeFetch({ picks: [{ id: pid, name: '配方法', confidence: 0.86, reason: '题面就是用配方法解一元二次方程' }] })
  }).then((res) => {
    assert.strictEqual(res.stage, 'verified');
    assert.strictEqual(res.fields.grade.value, 9);
    assert.strictEqual(res.fields.domain.value, '数与代数');
    assert.strictEqual(res.verify.ok, true);
    assert.strictEqual(res.verify.kept[0].name, '配方法');
    assert.ok(res.path.nodes.some((n) => n.name === '完全平方公式'));
  });
}));

ASYNC.push(testAsync('信息不足 → 不调网关就能给出「信息不足，请补充年级」', () => {
  let called = false;
  const spy = function () { called = true; return Promise.resolve({ ok: false }); };
  return R.locate('这道题不会', { fetch: spy }).then((res) => {
    assert.strictEqual(called, false, '信息不足时不该调网关');
    assert.strictEqual(res.stage, 'insufficient');
    assert.ok(res.message.includes('信息不足'));
    assert.strictEqual(res.pool.count, 0);
  });
}));

ASYNC.push(testAsync('非数学文字 → not-math，拒绝定位', () => {
  return R.locate('这是一道语文阅读理解题', { fetch: fakeFetch({ picks: [] }) }).then((res) => {
    assert.strictEqual(res.stage, 'not-math');
    assert.ok(res.message.includes('语文'));
    assert.strictEqual(res.verify, null);
  });
}));

ASYNC.push(testAsync('英语题里出现「面积」这种数学领域词也不许定位（不调网关）', () => {
  let called = false;
  const spy = function () { called = true; return Promise.resolve({ ok: false }); };
  return R.locate('初三 英语 面积计算', { fetch: spy }).then((res) => {
    assert.strictEqual(called, false, '非数学文字不该调网关');
    assert.strictEqual(res.stage, 'not-math');
    assert.strictEqual(res.path, null);
  });
}));

ASYNC.push(testAsync('网关挂了 → stage=offline，但 ①② 仍然有值，不白屏', () => {
  const dead = function () { return Promise.reject(new Error('ECONNREFUSED')); };
  return R.locate(EXAMPLE, { fetch: dead }).then((res) => {
    assert.strictEqual(res.stage, 'offline');
    assert.strictEqual(res.fields.grade.value, 9, '字段解析不受网关影响');
    assert.ok(res.pool.count > 0, '候选池不受网关影响');
    assert.ok(res.message.includes('网关不可用'));
  });
}));

ASYNC.push(testAsync('LLM 越出候选池 → staged rejected，没有路径', () => {
  const outside = TOPICS.find((t) => t.id.startsWith('cnm') && !exPool.topics.some((p) => p.id === t.id));
  return R.locate(EXAMPLE, {
    fetch: fakeFetch({ picks: [{ id: outside.id, name: outside.name, confidence: 0.9, reason: 'x' }] })
  }).then((res) => {
    assert.strictEqual(res.stage, 'rejected');
    assert.strictEqual(res.path, null, '校验拒绝时不许给路径');
    assert.strictEqual(res.message, '分析结果无法定位到知识点');
  });
}));

ASYNC.push(testAsync('LLM 返回坏 JSON → 明确报错，不崩', () => {
  return R.locate(EXAMPLE, { fetch: fakeFetch('我觉得是配方法') }).then((res) => {
    assert.strictEqual(res.stage, 'offline');
    assert.ok(res.message.includes('JSON'));
  });
}));

ASYNC.push(testAsync('没注入 fetch → offline（Node 环境下不预装 fetch 依赖）', () => {
  return R.locate(EXAMPLE, {}).then((res) => {
    assert.strictEqual(res.stage, 'offline');
    assert.strictEqual(res.fields.grade.value, 9);
  });
}));

/* ================================================================
 * 11. 结构约束：纯函数层不碰 DOM / 存储 / 真网络
 * ================================================================ */

console.log('\n--- 11. 结构约束 ---');

const ROUTE_SRC = fs.readFileSync(path.join(ROOT, 'diagnose', 'route.js'), 'utf8');
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}
const ROUTE_CODE = stripComments(ROUTE_SRC);

test('route.js 不碰 DOM（无 document / window.）', () => {
  assert.ok(!/\bdocument\./.test(ROUTE_CODE), '发现 document 访问');
});

test('route.js 不碰 localStorage（无持久化）', () => {
  assert.ok(!/localStorage/.test(ROUTE_CODE), '发现 localStorage');
});

test('route.js 不自己发请求：fetch 只作为注入参数出现', () => {
  assert.ok(!/\bfetch\s*\(/.test(ROUTE_CODE), 'route.js 里出现了 fetch( 直接调用，应该由调用方注入');
});

test('max_tokens 常量 ≥ 1200（网关把 reasoning 算进预算）', () => {
  assert.ok(R.MAX_TOKENS >= 1200, 'MAX_TOKENS=' + R.MAX_TOKENS);
  assert.ok(/max_tokens/.test(ROUTE_SRC));
});

test('prompt 里禁止编造知识点的硬规则在（防幻觉不靠模型自觉）', () => {
  const prompt = R.buildPrompt(exFields, exPool.topics).map((m) => m.content).join('\n');
  assert.ok(prompt.includes('只能从给出的候选列表里选'));
  assert.ok(prompt.includes('绝对不许编造'));
  assert.ok(prompt.includes('{"picks": []}'), '要给模型「选不出就空数组」的出口');
  assert.ok(prompt.includes('配方法'), '候选池要真的喂进 prompt');
});

test('页面层存在且是独立入口（route.html / route.css / route-page.js）', () => {
  ['route.html', 'route.css', 'route-page.js'].forEach((f) => {
    assert.ok(fs.existsSync(path.join(ROOT, 'diagnose', f)), '缺 diagnose/' + f);
  });
  const html = fs.readFileSync(path.join(ROOT, 'diagnose', 'route.html'), 'utf8');
  assert.ok(html.includes('route.js'));
  assert.ok(html.includes('route-page.js'));
  assert.ok(html.includes('未解析出') === false, '文案在 JS 里拼，html 里不写死');
});

/* ================================================================ */

Promise.all(ASYNC).then(() => {
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
});
