#!/usr/bin/env node
/* 相似位似类形态审计（I 卡条件判定，只读探针）
 *
 * 目的：回答「为相似类补画板骨架值不值得做」。
 * 做法：对相似类每一题按 app.js 逐字调用 Geomlab.labFor()，并给出人工逐题定档的形态标签。
 * 不修改任何业务代码；输出两次运行逐字相同（不读时间、不随机）。
 */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..');
const G = require(path.join(ROOT, 'diagnose', 'geomlab.js'));
const QUESTIONS = require(path.join(ROOT, 'data', 'questions.json'));
const TOPICS = require(path.join(ROOT, 'data', 'topics.json'));
const TOPIC = new Map(TOPICS.map(t => [t.id, t]));

/* 逐题人工形态定档。key = 形态，value = 判据（写在报告里供复核）。 */
const FORM_LABEL = {
  RATIO_NUMERIC: '纯比例数值计算（只给比值/字母单调 + 数值，无图形位置关系）',
  RATIO_NAMED: '相似比数值计算但题面带 ∽ 与顶点对应（纯套公式）',
  POSITION_QUERY: '有位置关系，问的是关系识别（哪对相似/哪个比例式错/是否相似/依据）',
  POSITION_MEASURE: '有位置关系，答案是量（图承载推理）',
  PROOF_JUDGE: '概念辨析/判断对错',
  APPLIED: '实景应用（人影/镜面/竹竿，需实景骨架）'
};
const FORM = {
  cnm_268_q1: 'RATIO_NUMERIC', cnm_268_q3: 'RATIO_NUMERIC', cnm_268_q4: 'RATIO_NUMERIC',
  cnm_272_q1: 'RATIO_NUMERIC', cnm_272_q2: 'RATIO_NUMERIC', cnm_270_q2: 'RATIO_NUMERIC',
  cnm_275_q1: 'RATIO_NUMERIC', cnm_275_q2: 'RATIO_NUMERIC', cnm_275_q3: 'RATIO_NUMERIC', cnm_275_q5: 'RATIO_NUMERIC',
  cnm_270_q4: 'RATIO_NAMED', cnm_270_q5: 'RATIO_NAMED', cnm_271_q4: 'RATIO_NAMED',
  cnm_272_q3: 'RATIO_NAMED', cnm_272_q4: 'RATIO_NAMED', cnm_272_q5: 'RATIO_NAMED',
  cnm_268_q2: 'POSITION_QUERY', cnm_269_q2: 'POSITION_QUERY', cnm_271_q1: 'POSITION_QUERY',
  cnm_271_q2: 'POSITION_QUERY', cnm_271_q3: 'POSITION_QUERY', cnm_273_q1: 'POSITION_QUERY',
  cnm_269_q1: 'POSITION_MEASURE', cnm_269_q3: 'POSITION_MEASURE', cnm_269_q4: 'POSITION_MEASURE',
  cnm_271_q5: 'POSITION_MEASURE', cnm_273_q2: 'POSITION_MEASURE', cnm_273_q3: 'POSITION_MEASURE',
  cnm_273_q4: 'POSITION_MEASURE',
  cnm_270_q1: 'PROOF_JUDGE', cnm_270_q3: 'PROOF_JUDGE', cnm_275_q4: 'PROOF_JUDGE',
  cnm_274_q1: 'APPLIED', cnm_274_q2: 'APPLIED', cnm_274_q3: 'APPLIED', cnm_274_q4: 'APPLIED'
};

G.resetGateStats();
const rows = [];
QUESTIONS.forEach(function (q) {
  const t = TOPIC.get(q.topicId) || null;
  if (G.classOf(t && t.id, { topic: t }) !== 'similar') return;
  const lab = G.labFor(t && t.id, q && q.prompt, {
    itemId: q && q.id, topic: t, answer: q && q.answer, choices: q && q.choices
  });
  let reason = null;
  if (!lab) {
    const g = G.gate(q.prompt, { itemId: q.id, answer: q.answer, choices: q.choices });
    reason = g.blocked ? g.reason : null;
  }
  const form = FORM[q.id];
  if (!form) throw new Error('未定档：' + q.id);
  rows.push({ q: q, lab: lab || null, reason: reason, form: form });
});

function pad(s, n) { s = String(s); return s + ' '.repeat(Math.max(0, n - s.length)); }
const out = [];
const say = s => out.push(s == null ? '' : s);

say('# 相似位似类形态审计（I 卡）');
say('');
say('数据：`data/questions.json` 相似类 ' + rows.length + ' 题；判定只用画板自身 `classOf`/`labFor`/`gate`，人工形态定档见第三节。');
say('');
say('## 一、总表');
say('');
say('| 形态 | 题数 | 占比 | 已挂载 | 挂载骨架 |');
say('|---|---|---|---|---|');
const ORDER = ['RATIO_NUMERIC', 'RATIO_NAMED', 'POSITION_QUERY', 'POSITION_MEASURE', 'PROOF_JUDGE', 'APPLIED'];
let sumMounted = 0;
ORDER.forEach(function (k) {
  const g = rows.filter(r => r.form === k);
  const m = g.filter(r => r.lab);
  sumMounted += m.length;
  const skel = [...new Set(m.map(r => r.lab.skel))].join('、') || '—';
  say('| ' + k + ' | ' + g.length + ' | ' + (g.length / rows.length * 100).toFixed(1) + '% | ' + m.length + ' | ' + skel + ' |');
});
say('| **合计** | **' + rows.length + '** | 100% | **' + sumMounted + '** | |');
say('');
const nBlock = rows.filter(r => r.reason).length;
const nFail = rows.filter(r => !r.reason && !r.lab).length;
say('闭合：挂载 ' + sumMounted + ' + 门禁挡 ' + nBlock + ' + 解析失败 ' + nFail + ' = ' + (sumMounted + nBlock + nFail) +
  '（' + (sumMounted + nBlock + nFail === rows.length ? '与题池一致 ✓' : '不一致 ✗') + '）');
say('');
say('形态判据：');
ORDER.forEach(k => say('- `' + k + '`：' + FORM_LABEL[k] + '（' + rows.filter(r => r.form === k).length + ' 题）'));
say('');
say('## 二、结论判定用的两个比例');
say('');
const nGeo = rows.filter(r => r.form === 'POSITION_MEASURE').length;
const gate70 = ORDER.filter(k => k !== 'RATIO_NUMERIC').reduce((a, k) => a + rows.filter(r => r.form === k).length, 0);
say('- 严格「纯比例计算」(`RATIO_NUMERIC`，H 脚本 `isPureRatioForm` 的口径)：' +
  rows.filter(r => r.form === 'RATIO_NUMERIC').length + '/' + rows.length + ' = ' +
  (rows.filter(r => r.form === 'RATIO_NUMERIC').length / rows.length * 100).toFixed(1) + '%（**低于 70%**）');
say('- 把「不带 ∥/位似中心、只套相似比公式」的 `RATIO_NUMERIC` + `RATIO_NAMED` 合并：' +
  (rows.length - gate70) + '/' + rows.length + ' = ' + ((rows.length - gate70) / rows.length * 100).toFixed(1) + '%');
say('  —— F 卡预测的 14 题里，落在这两类的正是不需要图形的部分；真正图承载推理的 `POSITION_MEASURE` 只有 ' + nGeo + ' 题。');
say('');
say('## 三、POSITION_MEASURE 逐题（唯一值得画的形态）');
say('');
rows.filter(r => r.form === 'POSITION_MEASURE').forEach(function (r) {
  const st = r.lab ? '已挂 `' + r.lab.skel + '` ' + JSON.stringify(r.lab.state)
    : (r.reason ? '门禁 `' + r.reason + '`' : '解析失败（现有两骨架不含此模型）');
  say('- `' + r.q.id + '` ' + st);
  say('  - 题：' + String(r.q.prompt).replace(/\s+/g, ' ').trim());
  say('  - 答：' + String(r.q.answer).trim());
});
say('');
say('## 四、POSITION_QUERY 逐题（挂图即送答案，必须保持不挂）');
say('');
rows.filter(r => r.form === 'POSITION_QUERY').forEach(function (r) {
  say('- `' + r.q.id + '` ' + (r.lab ? '**已挂载**' : '未挂（' + (r.reason || '解析失败') + '）') +
    ' ｜ ' + String(r.q.prompt).replace(/\s+/g, ' ').trim().slice(0, 70) + ' ｜答 ' + String(r.q.answer).trim());
});
say('');
say('## 五、RATIO_NUMERIC / RATIO_NAMED 逐题');
say('');
ORDER.slice(0, 2).forEach(function (k) {
  say('### ' + k);
  say('');
  rows.filter(r => r.form === k).forEach(function (r) {
    say('- `' + r.q.id + '` ' + (r.lab ? '**已挂 `' + r.lab.skel + '` ' + JSON.stringify(r.lab.state) + '**' : '未挂（' + (r.reason || '解析失败') + '）') +
      ' ｜ ' + String(r.q.prompt).replace(/\s+/g, ' ').trim().slice(0, 70) + ' ｜答 ' + String(r.q.answer).trim());
  });
  say('');
});
say('## 六、门禁挡掉的题（原因逐题）');
say('');
rows.filter(r => r.reason).forEach(function (r) {
  say('- `' + r.q.id + '` `' + r.reason + '`（' + r.form + '）' + String(r.q.prompt).replace(/\s+/g, ' ').trim().slice(0, 60));
});
say('');
process.stdout.write(out.join('\n') + '\n');
