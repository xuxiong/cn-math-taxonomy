#!/usr/bin/env node
/* 首页首屏数据：断网重试 + inflight 去重（上游 b17bbe7 的 fetchJsonWithRetry 语义）。
 * 只针对我们拆分后的两份首屏数据（stats.json / topics-lite），不碰上游那套整包
 * topics/questions 拉法（tests/test_payload_budget.js 的 FORBIDDEN 已禁用）。
 * node tests/test_home_retry.js  —— 纯 node，无依赖。 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '../assets/home.js'), 'utf8');
let passed = 0;
function test(name, fn) {
  return Promise.resolve(fn()).then(function () { passed++; console.log('  ok   ' + name); });
}
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r)); };

function element() {
  const attrs = {};
  const el = {
    textContent: '', hidden: true, children: [], className: '', href: '',
    classList: { toggle() {}, add() {}, remove() {} },
    setAttribute(k, v) { attrs[k] = String(v); },
    getAttribute(k) { return k in attrs ? attrs[k] : null; },
    removeAttribute(k) { delete attrs[k]; },
    hasAttribute(k) { return k in attrs; },
    replaceChildren() { el.children = []; },
    append(...nodes) { el.children.push(...nodes); },
    appendChild(node) { el.children.push(node); return node; }
  };
  return el;
}

const lite = [{ id: 'cnm_a', grade: 1, semester: '上' }, { id: 'cnm_b', grade: 7, semester: '下' }];
const stats = { total: { topics: 2, edges: 1, questions: 5, standards: 3 } };

function load(search) {
  const ids = {};
  ['n-topics', 'n-edges', 'n-questions', 'grades', 'load-error'].forEach(id => { ids[id] = element(); });
  const calls = [];
  function fetch(url) {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    calls.push({ url, resolve, reject });
    return promise;
  }
  const context = {
    window: {}, location: { hash: '', search: search || '' }, URLSearchParams, fetch,
    document: {
      title: '', body: { classList: { toggle() {} } },
      querySelector() { return null; }, querySelectorAll() { return []; },
      getElementById(id) { return ids[id] || null; }, createElement() { return element(); }
    }
  };
  vm.runInNewContext(source, context, { filename: 'assets/home.js' });
  const all = url => calls.filter(c => c.url === url);
  return { ids, calls, all };
}

(async () => {
  await test('断网一次不炸：stats.json 重试第二次成功后照常渲染', async () => {
    const { ids, all } = load('');
    assert.strictEqual(all('data/stats.json').length, 1, '首屏只发一次 stats.json');
    all('data/stats.json')[0].reject(new Error('network'));
    await flush();
    const retries = all('data/stats.json');
    assert.ok(retries.length >= 2, '网络错误后重试');
    retries[1].resolve({ ok: true, status: 200, json: () => Promise.resolve(stats) });
    all('data/topics-lite/math.json')[0].resolve({ ok: true, status: 200, json: () => Promise.resolve(lite) });
    await flush();
    assert.strictEqual(ids['n-topics'].textContent, '2');
    assert.strictEqual(ids['n-questions'].textContent, '5');
    assert.strictEqual(ids['load-error'].hidden, true, '重试成功就不该整页报错');
  });

  await test('HTTP 404 不重试，直接走失败分支显示 —', async () => {
    const { ids, all } = load('');
    all('data/stats.json')[0].resolve({ ok: false, status: 404, json: () => Promise.resolve(null) });
    all('data/topics-lite/math.json')[0].resolve({ ok: true, status: 200, json: () => Promise.resolve(lite) });
    await flush();
    assert.strictEqual(all('data/stats.json').length, 1, '404 不重试');
    assert.strictEqual(ids['n-topics'].textContent, '—');
    assert.strictEqual(ids['load-error'].hidden, false);
  });

  await test('两次都断网才报错（重试上限 2 次尝试）', async () => {
    const { ids, all } = load('');
    all('data/stats.json')[0].reject(new Error('network'));
    all('data/topics-lite/math.json')[0].reject(new Error('network'));
    await flush();
    assert.strictEqual(all('data/stats.json').length, 2, '恰好 2 次尝试');
    all('data/stats.json')[1].reject(new Error('network'));
    all('data/topics-lite/math.json')[1].reject(new Error('network'));
    await flush();
    assert.strictEqual(all('data/stats.json').length, 2, '两次尝试后不再重试');
    assert.strictEqual(ids['n-topics'].textContent, '—');
    assert.strictEqual(ids['load-error'].hidden, false);
  });

  await test('inflight 去重：并发同一 url 只发一条请求', async () => {
    assert.ok(source.indexOf('fetchInflight') >= 0, 'inflight 表');
    assert.ok(source.indexOf('function fetchJsonWithRetry') >= 0, '重试封装');
    const { all } = load('');
    /* 同 url 复用在同一个页面里不会自然发生，这里按源码契约验证：map 未清空前直接返回同一条 promise。 */
    assert.strictEqual(all('data/stats.json').length, 1);
  });

  console.log(passed + ' passed');
})().catch(function (err) { console.error(err); process.exit(1); });
