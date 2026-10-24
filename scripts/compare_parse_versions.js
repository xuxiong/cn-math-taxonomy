#!/usr/bin/env node
/* 对比 fromPrompt 改动前后对全库每道题的解析结果（只读）。
 * 用法：node scripts/compare_parse_versions.js <旧版 funclab.js 路径>
 * 旧版可由 git 取出：git show HEAD:diagnose/funclab.js > /tmp/funclab.old.js
 */
'use strict';
const path = require('path');
const FNEW = require(path.join(__dirname, '..', 'diagnose', 'funclab.js'));
const FOLD = require(path.resolve(process.argv[2]));
const QUESTIONS = require(path.join(__dirname, '..', 'data', 'questions.json'));

const fmt = r => (r ? r.type + '(' + ['a', 'h', 'k', 'k', 'b'].filter((k, i, arr) => arr.indexOf(k) === i && k in r).map(k => k + '=' + r[k]).join(',') + ')' : 'null');

let changed = 0;
const news = [];
for (const q of QUESTIONS) {
  const o = FOLD.fromPrompt(q.prompt);
  const n = FNEW.fromPrompt(q.prompt);
  const so = JSON.stringify(o), sn = JSON.stringify(n);
  if (so === sn) continue;
  changed++;
  const oldLab = FOLD.labFor(q.topicId, q.prompt, { itemId: q.id });
  const newLab = FNEW.labFor(q.topicId, q.prompt, { itemId: q.id });
  console.log('· ' + q.id + ' [' + q.topicId + ' kind=' + FNEW.topicKind(q.topicId) + ']');
  console.log('  题面: ' + q.prompt.replace(/\s+/g, ' ').slice(0, 90));
  console.log('  答案: ' + JSON.stringify(q.answer));
  console.log('  fromPrompt: ' + fmt(o) + '  →  ' + fmt(n));
  console.log('  挂载: ' + (oldLab ? '有' : '无') + '  →  ' + (newLab ? '有' : '无'));
  if (!oldLab && newLab) news.push(q.id);
}
console.log('\n解析结果变化的题：' + changed + ' / ' + QUESTIONS.length);
console.log('新挂上的题：' + news.length + ' → ' + news.join(', '));
