#!/usr/bin/env node
/* 道德与法治初中入口：首页行为 + 图谱/诊断源码门槛。不读全仓。
 *
 * 上游版让首页去取 data/topics.json / dependencies.json / cn-curriculum-standards.json；
 * 本 fork 走 payload-split，首屏只取 data/stats.json + data/topics-lite/<subject>.json
 * （见 assets/home.js 与 tests/test_payload_budget.js 的 FORBIDDEN），且已删课标统计格；
 * 诊断/图谱的文案与学段代码也按模块拆到了 app-flow.js / explore/app.js。
 * 断言的**对象**随结构改动，行为强度不变。逐条对照见 docs/fork-divergences.md。
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
let passed = 0;

function test(name, fn) {
  return Promise.resolve(fn()).then(function () {
    passed++;
    console.log('  ok   ' + name);
  });
}

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

function loadHome(search) {
  const ids = {};
  ['n-topics', 'n-edges', 'n-questions', 'n-standards', 'load-error', 'grades'].forEach(function (id) {
    ids[id] = element();
  });
  const eyebrow = element();
  eyebrow.className = 'eyebrow';
  const calls = [];
  function fetch(url) {
    let resolve;
    let reject;
    const promise = new Promise(function (res, rej) { resolve = res; reject = rej; });
    calls.push({ url: url, resolve: resolve, reject: reject });
    return promise;
  }
  const context = {
    window: {},
    location: { hash: '', search: search || '' },
    URLSearchParams: URLSearchParams,
    fetch: fetch,
    document: {
      title: '',
      body: { classList: { toggle() {} } },
      querySelector(sel) { return sel === '.eyebrow' ? eyebrow : null; },
      querySelectorAll() { return []; },
      getElementById(id) { return ids[id] || null; },
      createElement() { return element(); }
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'assets/home.js'), 'utf8'), context, { filename: 'assets/home.js' });
  return { ids: ids, eyebrow: eyebrow, calls: calls, document: context.document };
}

/* 首屏两份数据的假响应：stats.json 提供各学科计数，topics-lite 提供该学科知识点。 */
async function deliver(home, lite, stats) {
  const byUrl = {};
  home.calls.forEach(function (call) { byUrl[call.url] = call; });
  assert.ok(byUrl['data/stats.json'], '首页取统计');
  assert.ok(byUrl['data/topics-lite/morality.json'], '首页取本学科 topics-lite');
  byUrl['data/stats.json'].resolve({ ok: true, status: 200, json: function () { return Promise.resolve(stats); } });
  byUrl['data/topics-lite/morality.json'].resolve({ ok: true, status: 200, json: function () { return Promise.resolve(lite); } });
  for (let i = 0; i < 12; i++) await new Promise(function (r) { setImmediate(r); });
}

const moralityStats = { subjects: { morality: { topics: 5, edges: 4, questions: 0, standards: 1 } }, total: {} };

(async function () {
  await test('首页道法画出已有初中年级，空年级不画高中卡', async function () {
    const home = loadHome('?subject=morality');
    const topics = [
      { id: 'cnd_p001', subject: 'morality', name: '我向国旗敬个礼', grade: 1, semester: '上' },
      { id: 'cnd_j701', subject: 'morality', name: '中学时代', grade: 7, semester: '上' },
      { id: 'cnd_j702', subject: 'morality', name: '学习新天地', grade: 7, semester: '下' },
      { id: 'cnd_j801', subject: 'morality', name: '责任与角色', grade: 8, semester: '上' },
      { id: 'cnd_j802', subject: 'morality', name: '社会生活', grade: 8, semester: '下' }
    ];
    await deliver(home, topics, moralityStats);
    const titles = home.ids.grades.children.map(function (card) {
      return card.children[1].textContent;
    });
    assert.deepStrictEqual(titles, ['一年级', '七年级', '八年级']);
    assert.ok(titles.indexOf('九年级') < 0, '空年级不画卡');
    const splits = home.ids.grades.children.map(function (card) {
      return card.children[3].textContent;
    });
    assert.deepStrictEqual(splits, ['上 1', '上 1 · 下 1', '上 1 · 下 1']);
    assert.ok(home.ids.grades.children[0].className.indexOf('is-primary') >= 0);
    assert.ok(home.ids.grades.children.every(function (card) { return card.className.indexOf('is-senior') < 0; }));
    assert.strictEqual(home.document.title, '道德与法治 · 中小学·高中知识图谱');
    assert.ok(home.eyebrow.textContent.indexOf('初中现含七上、七下、八上、八下') >= 0);
    assert.ok(home.eyebrow.textContent.indexOf('九年级未录入') >= 0);
    assert.ok(home.eyebrow.textContent.indexOf('全初中') < 0);
    assert.strictEqual(home.ids['n-topics'].textContent, '5');
    /* 课标统计格在本 fork 首屏已删（ddc83fb），不再写 n-standards：断言它保持 index.html 初值。 */
    assert.strictEqual(home.ids['n-standards'].textContent, '');
    assert.ok(fs.readFileSync(path.join(root, 'assets/home.js'), 'utf8').indexOf('n-standards') < 0,
      '首屏不许再引课标计数格');
  });

  await test('首页道法有九上时写出九上、九下未录入', async function () {
    const home = loadHome('?subject=morality');
    const topics = [
      { id: 'cnd_p001', subject: 'morality', name: '我向国旗敬个礼', grade: 1, semester: '上' },
      { id: 'cnd_j701', subject: 'morality', name: '中学时代', grade: 7, semester: '上' },
      { id: 'cnd_j702', subject: 'morality', name: '学习新天地', grade: 7, semester: '下' },
      { id: 'cnd_j801', subject: 'morality', name: '责任与角色', grade: 8, semester: '上' },
      { id: 'cnd_j802', subject: 'morality', name: '社会生活', grade: 8, semester: '下' },
      { id: 'cnd_j901', subject: 'morality', name: '富强与创新', grade: 9, semester: '上' }
    ];
    await deliver(home, topics, { subjects: { morality: { topics: 6, edges: 0, questions: 0, standards: 0 } }, total: {} });
    const titles = home.ids.grades.children.map(function (card) {
      return card.children[1].textContent;
    });
    assert.deepStrictEqual(titles, ['一年级', '七年级', '八年级', '九年级']);
    const g9 = home.ids.grades.children[3];
    assert.strictEqual(g9.children[3].textContent, '上 1');
    assert.ok(g9.children[3].textContent.indexOf('全') < 0);
    assert.ok(home.eyebrow.textContent.indexOf('初中现含七上、七下、八上、八下、九上') >= 0);
    assert.ok(home.eyebrow.textContent.indexOf('九下未录入') >= 0);
    assert.ok(home.eyebrow.textContent.indexOf('九年级未录入') < 0);
    assert.ok(home.eyebrow.textContent.indexOf('九全') < 0);
  });

  await test('图谱年级含七至九且无高中学段', function () {
    const source = fs.readFileSync(path.join(root, 'explore/app.js'), 'utf8');
    /* 上游把这段抽成 fillMoralityGrades()；本 fork 是学科配置函数里的内联分支，断言其判据不变。 */
    assert.ok(source.indexOf("subject === 'morality'") >= 0);
    assert.ok(source.indexOf('[1, 2, 3, 4, 5, 6, 7, 8, 9]') >= 0, '年级下拉到九年级');
    assert.ok(source.indexOf("subject === 'chinese' || subject === 'morality'") >= 0, '语文与道法共用 1–9 年级集');
    assert.ok(source.indexOf("hideStages(['h']);") >= 0, '道法只隐藏高中，不隐藏初中');
    assert.ok(source.indexOf("button.hidden = hide.indexOf(button.getAttribute('data-stage')) >= 0") >= 0,
      '学段按钮按 data-stage 命中集合隐藏');
    assert.ok(source.indexOf("document.title = '知识图谱 · 道德与法治'") >= 0, '道法分支已接线');
  });

  await test('诊断道法说明写明七至九年级上册已录入、九下未建', function () {
    /* 本 fork 把标准卡文案放在 app-flow.js（上游在单体 app.js）。 */
    const source = fs.readFileSync(path.join(root, 'diagnose/app-flow.js'), 'utf8');
    assert.ok(source.indexOf('七至九年级上册已按官方目录录入，九下未建') >= 0);
    assert.ok(source.indexOf('初中尚未全部覆盖') < 0);
    const app = fs.readFileSync(path.join(root, 'diagnose/app.js'), 'utf8');
    assert.ok(app.indexOf('全一册（旧版，九下暂用）') >= 0);
  });

  await test('诊断道法学段含小学和初中', function () {
    const source = fs.readFileSync(path.join(root, 'diagnose/app.js'), 'utf8');
    /* 上游用 stageButton(...)，本 fork 的学段按钮工厂叫 mk(...)；判据（三个学段项）不变。 */
    const gate = "S.subject === 'chinese' || S.subject === 'morality' ? [mk('', '全部'), mk('p', '小学'), mk('j', '初中')]";
    assert.ok(source.indexOf(gate) >= 0);
    assert.ok(source.indexOf("S.subject === 'morality'") >= 0);
    assert.ok(source.indexOf("'一二三四五六七八九'") >= 0);
  });

  console.log('test_jmor_frontend ok ' + passed);
})().catch(function (err) {
  console.error(err);
  process.exit(1);
});
