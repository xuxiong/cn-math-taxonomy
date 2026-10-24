#!/usr/bin/env node
/* 列出「属 topicKind 白名单知识点 + fromPrompt 解析不出函数」的题（E 卡第 1 步）。
 *
 * 只读：node scripts/fromprompt_gaps.js [--json]
 * 输出 id / 知识点 / 题面 / 参考答案 / 选项，供 docs/fromprompt-gaps.md 逐条归类。
 */
'use strict';

const path = require('path');
const F = require(path.join(__dirname, '..', 'diagnose', 'funclab.js'));
const QUESTIONS = require(path.join(__dirname, '..', 'data', 'questions.json'));
const TOPICS = require(path.join(__dirname, '..', 'data', 'topics.json'));

const TOPIC = new Map(TOPICS.map(t => [t.id, t]));

const gaps = [];
for (const q of QUESTIONS) {
  const kind = F.topicKind(q.topicId);
  if (!kind) continue;
  if (F.fromPrompt(q.prompt)) continue;
  const t = TOPIC.get(q.topicId) || {};
  gaps.push({
    id: q.id,
    topicId: q.topicId,
    topicName: t.name || '',
    chapter: t.chapter || '',
    grade: t.grade == null ? null : t.grade,
    kind: kind,
    prompt: q.prompt,
    answer: q.answer,
    choices: q.choices || null,
    labFor: F.labFor(q.topicId, q.prompt, { itemId: q.id })
  });
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(gaps, null, 2));
} else {
  console.log('fromPrompt 解析不出函数的题：' + gaps.length);
  const byKind = {};
  gaps.forEach(g => { byKind[g.kind] = (byKind[g.kind] || 0) + 1; });
  console.log('按知识点类型：' + JSON.stringify(byKind));
  const byTopic = {};
  gaps.forEach(g => { byTopic[g.topicId] = (byTopic[g.topicId] || 0) + 1; });
  console.log('按知识点：' + JSON.stringify(byTopic));
  console.log('');
  gaps.forEach(g => {
    console.log('--- ' + g.id + ' | ' + g.topicId + ' ' + g.topicName + ' | ' + g.kind);
    console.log('Q: ' + String(g.prompt).replace(/\s+/g, ' '));
    if (g.choices) console.log('C: ' + g.choices.map(c => c.key + '.' + c.text).join(' | '));
    console.log('A: ' + String(g.answer).replace(/\s+/g, ' '));
  });
}

module.exports = { gaps: gaps };
