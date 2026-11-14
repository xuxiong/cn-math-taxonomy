#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
/* 我们的题面渲染在 diagnose/app-flow.js（renderQuestion/feedbackBlock），
 * 不在 diagnose/app.js —— 两文件拼起来读，与上游单文件口径等价，断言不变。 */
const appSrc = ['diagnose/app.js', 'diagnose/app-flow.js']
  .map((f) => fs.readFileSync(path.join(root, f), 'utf8')).join('\n');
const cssSrc = fs.readFileSync(path.join(root, 'diagnose/style.css'), 'utf8');
assert.ok(appSrc.includes('ISSUE_NEW_URL'));
assert.ok(appSrc.includes('function reportUrl(q)'));
assert.ok(appSrc.includes('这道题有错？报错'));
assert.ok(appSrc.includes('report-link no-print'));
assert.ok(appSrc.includes("encodeURIComponent('[题目] ' + q.id)"));
assert.ok(appSrc.includes('encodeURIComponent(q.id)'));
assert.ok(appSrc.includes("q.id ? h('div', { class: 'report-link no-print' }"));
function reportUrl(q) {
  return 'https://github.com/xiaoyang111222/cn-math-taxonomy/issues/new?template=question-fix.yml&title=' +
    encodeURIComponent('[题目] ' + q.id) + '&question_id=' + encodeURIComponent(q.id);
}
const weird = 'cnm_1_q1 &x# y';
const href = reportUrl({ id: weird });
const u = new URL(href);
assert.strictEqual(u.searchParams.get('template'), 'question-fix.yml');
assert.strictEqual(u.searchParams.get('question_id'), weird);
assert.strictEqual(u.searchParams.get('title'), '[题目] ' + weird);
assert.strictEqual(u.searchParams.get('answer'), null);
assert.strictEqual(u.searchParams.get('explanation'), null);
assert.strictEqual(u.searchParams.get('session'), null);
assert.strictEqual(u.searchParams.get('child'), null);
const body = appSrc.slice(appSrc.indexOf('function reportUrl(q)'), appSrc.indexOf('function feedbackBlock'));
assert.ok(!/answer|explanation|session|child|档案/.test(body));
assert.ok(cssSrc.includes('.report-link'));
console.log('test_report_link: ok');
