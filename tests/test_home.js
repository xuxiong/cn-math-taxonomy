#!/usr/bin/env node
/* 首页首屏数据：异步到货 / 失败降级 / 重试 / inflight 去重（上游 tests/test_home.js 按本 fork 结构改写）。
 *
 * 上游版用假 fetch 逼 assets/home.js 去取 data/topics.json、data/dependencies.json、
 * data/cn-curriculum-standards.json 和 data/questions.json；本 fork 走 payload-split，
 * 首屏只取 data/stats.json + data/topics-lite/<subject>.json，且 tests/test_payload_budget.js
 * 的 FORBIDDEN 明令 home.js 整文件不许出现那四个串。两边映射同一批行为：
 *   到货前占位「…」、404/非数组降级成「—」不白屏、网络错误重试且第二次成功、
 *   inflight 去重、学科过滤计数、年级卡与册次渲染。
 * 所以只换断言的对象（URL 与数据文件），行为强度一条不降；逐条对照见
 * docs/fork-divergences.md「上游首页测试按 payload-split 改写」。
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../assets/home.js'), 'utf8');
let passed = 0;

async function test(name, fn) {
  await fn();
  passed++;
  console.log('  ok   ' + name);
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

/* 与 data/stats.json 同形：subjects.<学科> 下 topics/edges/questions/standards + total。 */
const stats = {
  subjects: {
    math: { topics: 2, edges: 1, questions: 3, standards: 4 },
    english: { topics: 1, edges: 0, questions: 1, standards: 1 }
  },
  total: { topics: 3, edges: 1, questions: 4, standards: 5 }
};
/* 与 data/topics-lite/<subject>.json 同形：id/name/grade/semester 的扁平数组。 */
const mathLite = [
  { id: 'cnm_a', name: '数一数', grade: 1, semester: '上' },
  { id: 'cnm_b', name: '有理数', grade: 7, semester: '下' }
];
const englishLite = [{ id: 'cne_a', name: 'Hello', grade: 3, semester: '上' }];

function load(search) {
  const ids = {};
  ['n-topics', 'n-edges', 'n-questions', 'n-standards', 'load-error', 'grades'].forEach(id => { ids[id] = element(); });
  /* 与 index.html 一致：三格计数器初值是「…」，年级区挂 aria-busy 等数据。 */
  ['n-topics', 'n-edges', 'n-questions'].forEach(id => { ids[id].textContent = '…'; });
  ids.grades.setAttribute('aria-busy', 'true');
  const calls = [];
  function fetch(url) {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    calls.push({ url, resolve, reject, promise });
    return promise;
  }
  const context = {
    window: {},
    location: { hash: '', search: search || '' },
    URLSearchParams,
    fetch,
    document: {
      title: '',
      body: { classList: { toggle() {} } },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      getElementById(id) { return ids[id] || null; },
      createElement() { return element(); }
    }
  };
  vm.runInNewContext(source, context, { filename: 'assets/home.js' });
  const all = url => calls.filter(c => c.url === url);
  const call = url => all(url)[0];
  const respond = (url, data, status) => {
    const c = call(url);
    assert.ok(c, 'expected fetch of ' + url);
    const ok = status === undefined || (status >= 200 && status < 300);
    c.resolve({ ok, status: status || 200, json: () => Promise.resolve(data) });
  };
  const failNet = (url) => {
    const c = call(url);
    assert.ok(c, 'expected fetch of ' + url);
    c.reject(new Error('network'));
  };
  async function baseMeta(subject) {
    respond('data/stats.json', stats);
    respond('data/topics-lite/' + (subject || 'math') + '.json', subject === 'english' ? englishLite : mathLite);
    await flush();
  }
  return { ids, calls, all, call, respond, failNet, baseMeta };
}

(async () => {
  await test('首屏数据到货前计数器保持 …，到货后渲染计数与年级卡', async () => {
    const { ids, calls, baseMeta } = load('');
    /* 数据还在路上：三格仍是 index.html 的占位「…」，年级区还挂着 aria-busy。 */
    assert.strictEqual(ids['n-topics'].textContent, '…');
    assert.strictEqual(ids['n-questions'].textContent, '…');
    assert.ok(ids.grades.hasAttribute('aria-busy'), '年级卡等数据');
    assert.strictEqual(ids.grades.children.length, 0);
    await baseMeta();
    assert.strictEqual(ids['n-topics'].textContent, '2');
    assert.strictEqual(ids['n-edges'].textContent, '1');
    assert.strictEqual(ids['n-questions'].textContent, '3');
    assert.ok(ids.grades.children.length > 0, 'grade cards rendered');
    assert.ok(!ids.grades.hasAttribute('aria-busy'), '到货后摘掉 aria-busy');
    /* 首屏只取两份：题库计数与统计同源，不再单独拉题库文件或整包 topics / 课标。 */
    assert.deepStrictEqual(calls.map(c => c.url).sort(), ['data/stats.json', 'data/topics-lite/math.json']);
  });

  await test('stats 404 → 三格显示 —、年级卡清空，错误条给出重试路径', async () => {
    const { ids, respond } = load('');
    respond('data/stats.json', null, 404);
    respond('data/topics-lite/math.json', mathLite);
    await flush();
    assert.strictEqual(ids['n-topics'].textContent, '—');
    assert.strictEqual(ids['n-edges'].textContent, '—');
    assert.strictEqual(ids['n-questions'].textContent, '—');
    assert.strictEqual(ids.grades.children.length, 0, '年级卡不留半截');
    assert.ok(!ids.grades.hasAttribute('aria-busy'));
    assert.strictEqual(ids['load-error'].hidden, false, '要有错误条');
    assert.ok(ids['load-error'].textContent.indexOf('刷新重试') >= 0, '要给出重试路径');
    assert.ok(ids['load-error'].textContent.indexOf('http.server') >= 0, '要给出本地起服务的路径');
  });

  await test('lite 非数组 → 三格 — 且报「数据格式无法识别」', async () => {
    const { ids, respond } = load('');
    respond('data/stats.json', stats);
    respond('data/topics-lite/math.json', { nope: true });
    await flush();
    assert.strictEqual(ids['n-topics'].textContent, '—');
    assert.strictEqual(ids['n-questions'].textContent, '—');
    assert.strictEqual(ids['load-error'].hidden, false);
    assert.ok(ids['load-error'].textContent.indexOf('数据格式无法识别') >= 0);
  });

  await test('网络错误会重试至多 2 次，第二次成功照常渲染', async () => {
    const { ids, all, failNet, respond } = load('');
    assert.strictEqual(all('data/stats.json').length, 1, '首发一次');
    failNet('data/stats.json');
    await flush();
    assert.strictEqual(all('data/stats.json').length, 2, '断网后重试一次');
    /* 第二次尝试才成功：拿第二发的 promise 兑现。 */
    all('data/stats.json')[1].resolve({ ok: true, status: 200, json: () => Promise.resolve(stats) });
    respond('data/topics-lite/math.json', mathLite);
    await flush();
    assert.strictEqual(ids['n-questions'].textContent, '3');
    assert.strictEqual(ids['load-error'].hidden, true, '重试成功不该报错');
  });

  await test('进行中 Promise 去重（fetchInflight / fetchJsonWithRetry）', async () => {
    assert.ok(source.indexOf('fetchInflight') >= 0, 'inflight map present');
    assert.ok(source.indexOf('function fetchJsonWithRetry') >= 0, 'retry helper present');
    /* 每个首屏 URL 只发一次：同 url 的并发请求共用一条 promise，不重复下载。 */
    const { all } = load('');
    assert.strictEqual(all('data/stats.json').length, 1);
    assert.strictEqual(all('data/topics-lite/math.json').length, 1);
  });

  await test('lite 404 也走失败分支（对应上游「topics 无效仍 fail」）', async () => {
    const { ids, respond } = load('');
    respond('data/stats.json', stats);
    respond('data/topics-lite/math.json', null, 404);
    await flush();
    assert.strictEqual(ids['load-error'].hidden, false);
    assert.strictEqual(ids['n-topics'].textContent, '—', '坏的 lite 不许拿 stats 顶上');
  });

  await test('英语学科过滤计数：只取本学科 lite，计数取 stats.subjects.english', async () => {
    const { ids, calls, baseMeta } = load('?subject=english');
    assert.deepStrictEqual(calls.map(c => c.url).sort(), ['data/stats.json', 'data/topics-lite/english.json']);
    await baseMeta('english');
    assert.strictEqual(ids['n-topics'].textContent, '1');
    assert.strictEqual(ids['n-edges'].textContent, '0');
    assert.strictEqual(ids['n-questions'].textContent, '1');
    /* 年级卡：英语从三年级起；本学科 lite 只到三年级，高中册次卡跟在后面。 */
    const cards = ids.grades.children;
    assert.strictEqual(cards[0].children[1].textContent, '三年级');
    assert.strictEqual(cards[0].children[2].textContent, '1 个知识点');
    assert.strictEqual(cards[0].children[3].textContent, '上 1 · 下 0');
    assert.ok(cards[0].className.indexOf('is-primary') >= 0, '小学卡带 is-primary');
    const titles = cards.map(card => card.children[1].textContent);
    assert.ok(titles.indexOf('必修一') >= 0, '高中必修卡在');
    assert.ok(cards.some(card => card.className.indexOf('is-senior') >= 0), '高中卡带 is-senior');
  });

  console.log(passed + ' passed');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
