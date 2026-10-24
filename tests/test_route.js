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

/* ================================================================
 * 12. 接线 engine：候选 → 确认 → 出题测（kanban t_40c26d7d）
 * ================================================================
 * 只测纯函数：入口有没有资格出现（canStartDiagnosis / diagnosisCandidates）、
 * 跳转地址怎么拼（diagnosisUrl）、第 ⑥ 段的措辞（structureNote）。
 * 不测 DOM —— 页面层只是把这些结果贴进 HTML，DOM 行为交给浏览器实测。
 */

console.log('\n--- 12. 候选 → 确认 → 出题测 ---');

const DIAG_APP = require('../diagnose/app.js');

test('校验通过 → 候选带「开始诊断」入口，地址指向该 topicId', () => {
  const res = { stage: 'verified', verify: { ok: true, kept: [{ id: idOf('配方法'), name: '配方法', grade: 9, confidence: 0.86 }] } };
  assert.strictEqual(R.canStartDiagnosis(res), true);
  const list = R.diagnosisCandidates(res);
  assert.strictEqual(list.length, 1, '只有一个候选也要给，但不能替学生选');
  assert.strictEqual(list[0].id, idOf('配方法'));
  assert.ok(list[0].url.includes('target=' + idOf('配方法')), '入口地址必须带这个 topicId：' + list[0].url);
});

test('校验没通过（拒绝定位 / 信息不足 / 网关挂）→ 一律没有入口', () => {
  const keptOne = { ok: true, kept: [{ id: idOf('配方法'), name: '配方法', grade: 9, confidence: 0.9 }] };
  const cases = [
    { why: '拒绝定位', res: { stage: 'rejected', verify: { ok: false, kept: [], rejected: [{ rule: '规则3' }] } } },
    { why: '信息不足', res: { stage: 'insufficient', verify: null } },
    { why: '网关挂', res: { stage: 'offline', verify: null } },
    { why: '非数学', res: { stage: 'not-math', verify: null } },
    { why: 'stage 说 verified 但 verify 不 ok', res: { stage: 'verified', verify: { ok: false, kept: [] } } },
    { why: 'verify ok 但 kept 为空', res: { stage: 'verified', verify: { ok: true, kept: [] } } },
    { why: '空结果', res: null }
  ];
  cases.forEach((c) => {
    assert.strictEqual(R.canStartDiagnosis(c.res), false, c.why + ' 不该有资格开始诊断');
    assert.deepStrictEqual(R.diagnosisCandidates(c.res), [], c.why + ' 不该给出任何入口');
  });
  assert.strictEqual(R.canStartDiagnosis({ stage: 'verified', verify: keptOne }), true, '对照：通过的有入口');
});

test('多候选 → 每个候选都有自己的入口，各指自己的 topicId', () => {
  const ids = ['配方法', '一元二次方程的概念', '完全平方公式'].map(idOf);
  const res = {
    stage: 'verified',
    verify: {
      ok: true,
      kept: ids.map((id, i) => ({ id: id, name: TOPICS.find((t) => t.id === id).name, grade: 9, confidence: 0.9 - i * 0.1 }))
    }
  };
  const list = R.diagnosisCandidates(res);
  assert.strictEqual(list.length, 3);
  assert.strictEqual(new Set(ids).size, 3, '对照：三个名字要对应三个不同 id');
  assert.deepStrictEqual(list.map((c) => c.id), ids, '顺序与学生看到的顺序一致');
  const urls = new Set(list.map((c) => c.url));
  assert.strictEqual(urls.size, 3, '3 个候选不能指向同一个地址（不许默认选第一个）');
  list.forEach((c) => {
    assert.ok(c.url.includes('target=' + c.id), '入口 ' + c.id + ' 指错了：' + c.url);
  });
});

test('跳转地址：diagnose/index.html?target=<id>&from=route（复用现有 ?target=，不新造参数）', () => {
  const id = idOf('配方法');
  const url = R.diagnosisUrl(id);
  assert.ok(url.startsWith('index.html?'), 'redirect 到 diagnose 主页面：' + url);
  const q = new URLSearchParams(url.slice(url.indexOf('?')));
  assert.strictEqual(q.get('target'), id, 'target 参数必须是这个 topicId');
  assert.strictEqual(q.get('from'), 'route', '要带 from=route，diagnose 才能回升');
  assert.ok(!/chapter=|grade=|volume=/.test(url), '不该混入别的定位参数：' + url);
  assert.deepStrictEqual(Array.from(q.keys()).sort(), ['from', 'target'], '不许新造参数');
  assert.throws(() => R.diagnosisUrl(''), /topicId/);
});

test('diagnose 的 ?target= 确实能开 session：resolveTargets 认得这个参数（读源码断言，不测 DOM）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'diagnose', 'app.js'), 'utf8');
  assert.ok(/params\.get\('target'\)/.test(src), 'app.js 必须读 ?target=');
  assert.ok(/startSession\(resolved\.ids/.test(src), 'resolved 出来的 ids 要进 startSession');
  assert.ok(/function startSession\(targets, label, limit, mode\)/.test(src));
});

test('diagnose 页面：带 from=route 才出现「← 回到作业分析」，链回 route.html', () => {
  assert.strictEqual(DIAG_APP.routeReturnHref('?target=' + idOf('配方法') + '&from=route'), 'route.html');
  assert.strictEqual(DIAG_APP.routeReturnHref('target=x&from=route'), 'route.html', '没有前导 ? 也认');
  assert.strictEqual(DIAG_APP.routeReturnHref('?target=' + idOf('配方法')), null, '不是从 route 来的不出现');
  assert.strictEqual(DIAG_APP.routeReturnHref('?from=other'), null);
  assert.strictEqual(DIAG_APP.routeReturnHref(''), null);
  assert.strictEqual(DIAG_APP.routeReturnHref(null), null);
  const src = fs.readFileSync(path.join(ROOT, 'diagnose', 'app.js'), 'utf8');
  assert.ok(src.includes('← 回到作业分析'), '返回入口的文案');
  assert.ok(/show\(withRouteBack\(page\)\)/.test(src), '三个主视图都要挂返回入口');
});

test('第 ⑥ 段：标题是「接下来需要确认的知识点」，说明含「不是诊断结论」', () => {
  const note = R.structureNote();
  assert.strictEqual(note.title, '接下来需要确认的知识点');
  assert.ok(note.text.includes('不是诊断结论'), '说明文字必须写清不是诊断结论');
  assert.ok(note.text.includes('依赖图'), '要说明这些节点来自依赖图');
  assert.ok(/开始诊断/.test(note.text), '要指路到诊断入口');
  const html = fs.readFileSync(path.join(ROOT, 'diagnose', 'route.html'), 'utf8');
  const m = /<section class="card" id="sec-path"[\s\S]*?<h2[^>]*>([\s\S]*?)<\/h2>/.exec(html);
  assert.ok(m, 'route.html 里找不到第 ⑥ 段');
  assert.ok(m[1].includes('接下来需要确认的知识点'), '⑥ 段标题：' + m[1].replace(/<[^>]+>/g, ''));
  assert.ok(!/学习路径/.test(m[1]), '⑥ 段不许再叫「学习路径」');
});

test('页面层：入口按钮只在 ④ 校验通过的分支里渲染（拒绝/信息不足/网关挂都不渲染）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'diagnose', 'route-page.js'), 'utf8');
  const code = stripComments(src);
  const startBtn = code.indexOf('从这儿开始诊断');
  assert.ok(startBtn > 0, '页面层没有「从这儿开始诊断」');
  /* 按钮只出现在 renderVerify 的 v.ok 分支 */
  const verify = code.slice(code.indexOf('function renderVerify'), code.indexOf('function nodeHtml'));
  const okBranch = verify.slice(verify.indexOf('if (v.ok)'), verify.indexOf('} else {'));
  const badBranch = verify.slice(verify.indexOf('} else {'), verify.indexOf('if (v.rejected'));
  assert.ok(okBranch.includes('从这儿开始诊断'), '校验通过分支里要有入口');
  assert.ok(!badBranch.includes('从这儿开始诊断'), '拒绝分支里不许有入口');
  /* 整段页面层代码里只有 startButton 这一处拼按钮：拒绝 / 信息不足 / 网关挂三条路径都到不了它 */
  assert.strictEqual((code.match(/<a class="start-diag"/g) || []).length, 1, '按钮只应有一个渲染点');
  ['stage: \'offline\'', '!v.ok', 'rejected'].forEach((marker) => {
    assert.ok(code.includes(marker), '这三条失败路径仍要显式渲染提示：' + marker);
  });
});

test('route.html 的跳转地址由 route.js 生成（页面层不自己拼 ?target=）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'diagnose', 'route-page.js'), 'utf8');
  const code = stripComments(src);
  assert.ok(/R\.diagnosisUrl\(/.test(code), '页面层必须调 route.js 的 diagnosisUrl()');
  assert.ok(!/\?target=/.test(code), '页面层不许自己拼 ?target=');
  /* 回归：renderVerify 拿到的是 verifyPick 的结果，其 kept 里没有 url 字段 */
  const kept = R.verifyPick([{ id: idOf('配方法'), name: '配方法', confidence: 0.9 }], { pool: exPool.topics, fields: exFields }).kept;
  assert.ok(!('url' in kept[0]), 'verifyPick 的 kept 本来就不带 url，页面层不能读 k.url');
  assert.ok(!/esc\(k\.url\)/.test(code), '页面层不许读 k.url（undefined → href 为空）');
});


/* ================================================================
 * 13. 诊断结果写回 route：候选换成真结论（kanban t_d623773c）
 * ================================================================
 * 全部针对纯函数 buildResultView(session, sum, currentTopicId)，不测 DOM。
 * session / sum 都是手造的：这里验的是「什么情况下敢说结论」，不是 engine 的判题逻辑。
 */

console.log('\n--- 13. 诊断结果写回 route ---');

const PID = idOf('配方法');            /* 本页定位到的知识点 */
const FULL_SQ = idOf('完全平方公式');   /* 期待判出来的根因 */

/** 造一份与 app.js:239 同构的 session；answers 只填长度，内容按用例需要 */
const mkSession = (over) => Object.assign({
  v: 2, mode: 'target', targets: [PID], limit: 16, label: '配方法',
  answers: [{ id: PID, attempt: 1, result: 'wrong' }], seed: 'x', avoid: [],
  savedAt: '2026-10-25T00:00:00.000Z'
}, over || {});

/** 造一份 summarize() 同构的结果；roots 每项 {id, pendingPrereqs, outOfScopePrereqs, externalPrereqs} */
const mkSum = (over) => Object.assign({
  mode: 'target', targets: [PID], asked: 3, limit: 16,
  finished: true, limitReached: false,
  mastered: [], shaky: [], weak: [FULL_SQ], unconfirmed: [], untested: [],
  roots: [{ id: FULL_SQ, pendingPrereqs: [], outOfScopePrereqs: [], externalPrereqs: [] }],
  path: []
}, over || {});

test('① 目标匹配 + 已完成 + 有根因 → 显示根因（名字、依据、建议顺序）', () => {
  const v = R.buildResultView(mkSession(), mkSum(), PID);
  assert.strictEqual(v.ok, true, '这份 session 就是本页跳过去的，必须显示');
  assert.strictEqual(v.stage, 'roots');
  assert.deepStrictEqual(v.roots.map((r) => r.name), ['完全平方公式'], '根因要显示知识点名，不只是 id');
  assert.strictEqual(v.roots[0].id, FULL_SQ);
  assert.ok(v.detail.includes('你卡在：完全平方公式（初二）'), '文案：' + v.detail);
  assert.ok(v.detail.includes('依据：该知识点答错'), '要写依据');
  assert.ok(v.detail.includes('建议顺序：完全平方公式 → 配方法'), '建议顺序：根因在前，定位点在后');
  assert.deepStrictEqual(v.order.map((o) => o.id), [FULL_SQ, PID]);
  assert.strictEqual(v.roots[0].unreliable, false, 'pendingPrereqs 为空 → 根因可靠');
});

test('② 目标不匹配（换了题重新定位）→ 不显示任何诊断结果', () => {
  const other = idOf('一元二次方程的概念');
  const v = R.buildResultView(mkSession(), mkSum(), other);
  assert.strictEqual(v.ok, false, '旧 session 不能串到新定位上');
  assert.strictEqual(v.why, 'target-mismatch');
  assert.deepStrictEqual(v.roots, []);
  assert.strictEqual(v.detail, '');
  /* 反过来：session 含多个 target 时，只要含当前定位就算本页跳过去的 */
  const multi = R.buildResultView(mkSession({ targets: [other, PID] }), mkSum(), PID);
  assert.strictEqual(multi.ok, true, 'targets 是数组，包含当前定位即可');
});

test('③ 有 session 但一题没答 → 不显示（没有结论可讲）', () => {
  const v = R.buildResultView(mkSession({ answers: [] }), mkSum({ asked: 0, roots: [] }), PID);
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.why, 'no-answers');
  /* 一题没答却带着 roots 的脏数据也不许显示 */
  const dirty = R.buildResultView(mkSession({ answers: [] }), mkSum(), PID);
  assert.strictEqual(dirty.ok, false, '零答案时哪怕 sum 有根因也不显示');
  assert.deepStrictEqual(dirty.roots, []);
});

test('④ finished=false → 只说「没做完」，一个字都不提根因', () => {
  const v = R.buildResultView(
    mkSession({ answers: [{ id: PID, result: 'wrong' }, { id: FULL_SQ, result: 'wrong' }] }),
    mkSum({ finished: false, asked: 2, roots: [{ id: FULL_SQ, pendingPrereqs: [idOf('直接开平方法')] }], untested: ['a', 'b', 'c'] }),
    PID
  );
  assert.strictEqual(v.ok, true, '「没做完」本身是要显示的提示');
  assert.strictEqual(v.stage, 'unfinished');
  assert.deepStrictEqual(v.roots, [], '没做完就不许给根因');
  assert.ok(v.detail.includes('诊断还没做完'), v.detail);
  assert.ok(v.detail.includes('已答 2 题'), '要报已答几题：' + v.detail);
  assert.ok(v.detail.includes('还有 3 个知识点没测到'), '要报还有几个没测到：' + v.detail);
  /* 文案本身就带「现在还不说『你卡在哪』」——只匹配肯定式断言，避免误伤这句否定 */
  assert.ok(!/你卡在：/.test(v.detail), '没做完绝不能说「你卡在哪」：' + v.detail);
  assert.ok(v.detail.includes('现在还不说「你卡在哪」'), '要明确告诉学生结论还没定：' + v.detail);
  assert.ok(!v.detail.includes('完全平方公式'), '没做完不许出现任何根因名字：' + v.detail);
  assert.strictEqual(v.sectionTitle, undefined, '没做完时第 ⑥ 段维持原样，不换标题');
});

test('⑤ limitReached=true → 按「没做完」处理（即使 finished 也为 true）', () => {
  const v = R.buildResultView(mkSession(), mkSum({ limitReached: true, asked: 16 }), PID);
  assert.strictEqual(v.stage, 'unfinished', '题量用完但还有前置没测到 → 不能说卡在哪');
  assert.deepStrictEqual(v.roots, []);
  assert.ok(!v.detail.includes('完全平方公式'));
  /* 题量用完时说清是「题量上限」，别让学生以为是自己没继续答（浏览器实测 16 题的结果） */
  assert.ok(v.detail.includes('题量上限'), '要说明是题量用完了：' + v.detail);
  /* 两个字段都真、但 limitReached 为真 → 仍按没做完（坑 6） */
  const both = R.buildResultView(mkSession(), mkSum({ finished: true, limitReached: true }), PID);
  assert.strictEqual(both.stage, 'unfinished');
  assert.deepStrictEqual(both.roots, [], '哪怕 sum.roots 非空，limitReached 也不许显示根因');
});

test('⑥ 已完成有根因 → 第 ⑥ 段标题「你的薄弱点」，候选列表不再出现', () => {
  const v = R.buildResultView(mkSession(), mkSum(), PID);
  assert.strictEqual(v.sectionTitle, '你的薄弱点');
  assert.ok(v.sectionNote.includes('没测到的仍然未知'), '要保留一行小字说明范围：' + v.sectionNote);
  /* 与候选列表的措辞互斥：结果里不许出现「候选，待测确认」这类候选话术 */
  assert.ok(!/候选/.test(v.detail), '真结论里不许再出现候选话术：' + v.detail);
  /* 页面层：有根因时直接 return，不走候选列表那条分支 */
  const src = stripComments(fs.readFileSync(path.join(ROOT, 'diagnose', 'route-page.js'), 'utf8'));
  const fn = src.slice(src.indexOf('function renderPath'), src.indexOf('function renderStage6'));
  const hasRootsBranch = fn.slice(fn.indexOf('if (hasRoots) {'), fn.indexOf('if (!path'));
  assert.ok(hasRootsBranch.includes('return;'), 'hasRoots 分支必须先 return，候选列表才不会跟着渲染');
  assert.ok(!hasRootsBranch.includes('候选，待测确认'), '真结论分支不许拼候选节点');
  assert.ok(fn.includes('R.WEAK_TITLE'), '标题取自 route.js 的常量');
  /* 没做完时标题不变 */
  const un = R.buildResultView(mkSession(), mkSum({ finished: false }), PID);
  assert.strictEqual(un.sectionTitle, undefined);
  assert.ok(fs.readFileSync(path.join(ROOT, 'diagnose', 'route.html'), 'utf8').includes('接下来需要确认的知识点'));
});

test('⑦ 根因超过 2 个只取前 2 个（与 engine 小结规则一致）', () => {
  const three = mkSum({
    roots: [
      { id: FULL_SQ, pendingPrereqs: [] },
      { id: PID, pendingPrereqs: [] },
      { id: idOf('直接开平方法'), pendingPrereqs: [] }
    ]
  });
  const v = R.buildResultView(mkSession(), three, PID);
  assert.strictEqual(v.roots.length, 2, '只取前 2 个');
  assert.deepStrictEqual(v.roots.map((r) => r.id), [FULL_SQ, PID], '按 sum.roots 的原顺序取前 2');
  assert.ok(!v.detail.includes('直接开平方法'), '第 3 个根因不许出现：' + v.detail);
  assert.strictEqual(R.ROOT_LIMIT, 2);
});

test('⑧ 根因 pendingPrereqs 非空 → 标注「可能不准，还有前置没测」', () => {
  const v = R.buildResultView(mkSession(), mkSum({
    roots: [{ id: FULL_SQ, pendingPrereqs: [idOf('直接开平方法'), idOf('一元二次方程的概念')], outOfScopePrereqs: [], externalPrereqs: [] }]
  }), PID);
  assert.strictEqual(v.roots[0].unreliable, true, '还有前置没测到 → 根因不可靠');
  assert.deepStrictEqual(v.roots[0].pendingPrereqs, [idOf('直接开平方法'), idOf('一元二次方程的概念')]);
  assert.ok(R.rootCaveat(v.roots[0]).includes('可能不准'), '页面标注文案');
  assert.ok(R.rootCaveat(v.roots[0]).includes('还有前置没测'));
  assert.strictEqual(R.rootCaveat({ unreliable: false }), '', '可靠的根因不标任何东西');
});

test('⑨ 已完成但没根因：有 shaky 说「答得不稳」，什么都没有就不显示', () => {
  const shaky = R.buildResultView(mkSession(), mkSum({ roots: [], weak: [], shaky: [FULL_SQ] }), PID);
  assert.strictEqual(shaky.ok, true);
  assert.strictEqual(shaky.stage, 'no-root');
  assert.deepStrictEqual(shaky.roots, []);
  assert.ok(shaky.detail.includes('没有明确的断点'), shaky.detail);
  assert.ok(shaky.detail.includes('完全平方公式'), '要说出哪个知识点不稳：' + shaky.detail);
  assert.ok(shaky.detail.includes('再练几道'));
  const clean = R.buildResultView(mkSession(), mkSum({ roots: [], weak: [], shaky: [] }), PID);
  assert.strictEqual(clean.ok, false, '做完了、没根因、没不稳 → 不显示');
  assert.strictEqual(clean.why, 'no-finding');
});

test('⑩ 纯函数契约：不改入参、坏输入不抛异常、sum 缺失按没做完', () => {
  const sess = mkSession();
  const sum = mkSum();
  const before = JSON.stringify({ sess, sum });
  R.buildResultView(sess, sum, PID);
  assert.strictEqual(JSON.stringify({ sess, sum }), before, 'buildResultView 不许改 session/sum');
  [null, undefined, {}, { targets: 'x' }, { targets: [PID] }].forEach((s) => {
    assert.doesNotThrow(() => R.buildResultView(s, null, PID), '坏 session 不许抛：' + JSON.stringify(s));
  });
  const noSum = R.buildResultView(mkSession(), null, PID);
  assert.strictEqual(noSum.stage, 'unfinished', 'sum 算不出来时宁可说没做完，也不猜结论');
  assert.deepStrictEqual(noSum.roots, []);
  assert.strictEqual(R.buildResultView(mkSession(), mkSum(), '').ok, false, '没有当前定位 id 就不显示');
});

test('⑪ 页面层只读 session、不删 localStorage、复用 engine（读源码断言，不测 DOM）', () => {
  const src = stripComments(fs.readFileSync(path.join(ROOT, 'diagnose', 'route-page.js'), 'utf8'));
  assert.ok(src.includes("'cnmDiagnose.session.v2'"), '键名必须是 app.js:9 的那个');
  assert.ok(/localStorage\.getItem/.test(src), '要读 session');
  ['removeItem', 'clear()', 'setItem'].forEach((bad) => {
    assert.ok(!src.includes(bad), 'route 不许删/写 localStorage（那是 app.js 的数据）：' + bad);
  });
  assert.ok(/DiagEngine\.replay/.test(src) && /DiagEngine\.summarize/.test(src), '必须复用 engine，不自己实现 statusOf');
  const html = fs.readFileSync(path.join(ROOT, 'diagnose', 'route.html'), 'utf8');
  assert.ok(/<script src="engine\.js"><\/script>/.test(html), 'route.html 要加载 engine.js');
  assert.ok(html.indexOf('engine.js') < html.indexOf('route.js'), 'engine 要先于 route 加载');
});

/* ================================================================ */

Promise.all(ASYNC).then(() => {
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
});
