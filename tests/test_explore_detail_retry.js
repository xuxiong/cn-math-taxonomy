#!/usr/bin/env node
/* 知识图谱详情按需加载的可重试性守卫：node tests/test_explore_detail_retry.js（纯 node，无依赖）
 *
 * 背景（explore/app.js 的详情链路）：
 *   首屏只有 topics-lite（无 description）。点开知识点先渲染 lite 面板，再
 *   ensureDetailIndex() → fetchDetailBundle(slug) → 合并重字段 → 重绘。
 *   两个内存缓存原来存的是 fetch promise，失败时不清缓存：一次网络抖动，
 *   该学科 / 该章节在本次页面会话里就永远拿不到介绍，只能整页刷新。
 *
 * 本文件守四件事：
 *   1. 索引缓存失败后清掉，下一次调用会重新 fetch（HTTP 失败 / 网络错误两条分支）；
 *   2. bundle 缓存同样可重试；
 *   3. ensureDetail 失败时保留 lite（description 仍为空）、打失败标记、不置 __detail；
 *      重试成功后合并 description、清标记、重绘；
 *   4. 面板有克制的自救提示，且没有退回全量 topics/dependencies/questions 的 fetch。
 *
 * 做法与 tests/test_children.js 一致：从 explore/app.js 里按括号配平取出真实函数源码，
 * 塞进 vm.runInNewContext 的 sandbox 跑；只给 fetch / renderDetail / loadQuestionsFor 等
 * 依赖打桩。测试里不复制一份等价实现。
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const APP_PATH = path.join(ROOT, 'explore', 'app.js');
const APP = fs.readFileSync(APP_PATH, 'utf8');
const RETRY_TEXT = '介绍加载失败，再点一下这个知识点可重试';

let passed = 0;
let failed = 0;
const ASYNC = [];

function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e).split('\n').slice(0, 8).join('\n       ')); }
}
function testAsync(name, fn) {
  ASYNC.push(fn().then(
    function () { passed++; console.log('  ok   ' + name); },
    function (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e).split('\n').slice(0, 8).join('\n       ')); }
  ));
}

/* ------------------------------------------------ 源码提取（注释 / 字符串里的括号不算） */

/** 扫一遍源码：注释一律抹成空格；keepStrings=false 时把字符串内容也抹成空格。
 *  返回值与原文等长，便于用同一套下标做提取。 */
function scan(src, keepStrings) {
  let out = '';
  let i = 0;
  let state = 'code';
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (state === 'code') {
      if (c === '/' && n === '/') { out += '  '; i += 2; state = 'line'; continue; }
      if (c === '/' && n === '*') { out += '  '; i += 2; state = 'block'; continue; }
      if (c === "'" || c === '"' || c === '`') { out += c; i++; state = c; continue; }
      out += c; i++; continue;
    }
    if (state === 'line') {
      if (c === '\n') { out += c; state = 'code'; } else { out += ' '; }
      i++; continue;
    }
    if (state === 'block') {
      if (c === '*' && n === '/') { out += '  '; i += 2; state = 'code'; continue; }
      out += (c === '\n' ? c : ' ');
      i++; continue;
    }
    /* 字符串内部：转义整体跳过，保持长度 */
    if (c === '\\') { out += keepStrings ? c + (n || '') : '  '; i += 2; continue; }
    if (c === state) { out += c; i++; state = 'code'; continue; }
    out += keepStrings ? c : (c === '\n' ? c : ' ');
    i++;
  }
  return out;
}

const CODE_ONLY = scan(APP, false);

function extractFunction(name) {
  const re = new RegExp('function\\s+' + name + '\\s*\\(');
  const m = re.exec(CODE_ONLY);
  assert.ok(m, 'explore/app.js 里找不到函数 ' + name);
  const open = CODE_ONLY.indexOf('{', m.index + m[0].length - 1);
  assert.ok(open >= 0, '找不到 ' + name + ' 的起始花括号');
  let depth = 0;
  for (let i = open; i < CODE_ONLY.length; i++) {
    const c = CODE_ONLY[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return APP.slice(m.index, i + 1);
    }
  }
  throw new Error(name + ' 的花括号不配对');
}

/* ------------------------------------------------ sandbox 与 fetch 桩 */

function loadApp(overrides) {
  const source = [
    extractFunction('topicBundleKey'),
    extractFunction('ensureDetailIndex'),
    extractFunction('fetchDetailBundle'),
    extractFunction('ensureDetail')
  ].join('\n\n');
  const calls = { renderDetail: 0, loadQuestionsFor: 0, standards: 0 };
  const ctx = {
    subject: 'math',
    detailIndexCache: {},
    detailBundleCache: {},
    questionBundleCache: {},
    stdLoadPromise: null,
    stdById: new Map(),
    stdLoaded: false,
    fetch: overrides.fetch,
    renderDetail: function () { calls.renderDetail++; },
    loadQuestionsFor: function () { calls.loadQuestionsFor++; },
    ensureStandards: function () { calls.standards++; return Promise.resolve(); },
    Promise: Promise,
    Error: Error,
    console: console
  };
  vm.runInNewContext(source, ctx, { filename: 'explore/app.js#extracted' });
  return { ctx: ctx, calls: calls };
}

/** 可编程 fetch：按调用顺序消费 plan；用完后重复最后一步。
 *  步骤 {ok:false,status:503} / {reject:'offline'} / {ok:true,data:...} */
function fetchPlan(plan) {
  const calls = [];
  function fetch(url) {
    calls.push(url);
    const step = plan.length > 1 ? plan.shift() : plan[0];
    if (step.reject) return Promise.reject(new Error(step.reject));
    return Promise.resolve({
      ok: step.ok !== false,
      status: step.status || 200,
      json: function () { return Promise.resolve(step.data); }
    });
  }
  fetch.calls = calls;
  return fetch;
}

/** 等所有微任务 + 一个宏任务，让 ensureDetail 的 then/catch 链跑完。 */
function flush() {
  return new Promise(function (resolve) { setTimeout(resolve, 0); });
}

/* ------------------------------------------------ a–d：运行期守卫 */

testAsync('a. 索引缓存：503 失败后清缓存，下一次重试成功（fetch 共 2 次）', async function () {
  const index = { 'math|1|第一章': 'math__1__abc.json' };
  const fetch = fetchPlan([{ ok: false, status: 503 }, { ok: true, data: index }]);
  const app = loadApp({ fetch: fetch });
  const ctx = app.ctx;

  await assert.rejects(ctx.ensureDetailIndex(), /题库索引 503/);
  assert.ok(!ctx.detailIndexCache.math, '失败后 detailIndexCache[subject] 应被清掉，不能缓存 rejection');

  const got = await ctx.ensureDetailIndex();
  assert.strictEqual(got['math|1|第一章'], 'math__1__abc.json', '第二次应拿到真实索引内容');
  assert.strictEqual(fetch.calls.length, 2, '缓存没中毒：fetch 应被调用 2 次');
});

testAsync('b. 索引缓存：网络错误（fetch 直接 reject）后也能重试成功', async function () {
  const index = { 'math|1|第二章': 'math__1__def.json' };
  const fetch = fetchPlan([{ reject: 'offline' }, { ok: true, data: index }]);
  const app = loadApp({ fetch: fetch });
  const ctx = app.ctx;

  await assert.rejects(ctx.ensureDetailIndex(), /offline/);
  assert.ok(!ctx.detailIndexCache.math, '网络错误后同样应清缓存');
  const got = await ctx.ensureDetailIndex();
  assert.strictEqual(got['math|1|第二章'], 'math__1__def.json');
  assert.strictEqual(fetch.calls.length, 2, '网络恢复后应重新 fetch');
});

testAsync('c. bundle 缓存：500 失败后清缓存，下一次重试成功（fetch 共 2 次）', async function () {
  const slug = 'math__1__abc.json';
  const bundle = [{ id: 'cnm_t1', description: '第一次成功拿到的说明' }];
  const fetch = fetchPlan([{ ok: false, status: 500 }, { ok: true, data: bundle }]);
  const app = loadApp({ fetch: fetch });
  const ctx = app.ctx;

  await assert.rejects(ctx.fetchDetailBundle(slug), /详情 500/);
  assert.ok(!ctx.detailBundleCache[slug], '失败后 detailBundleCache[slug] 应被清掉');

  const got = await ctx.fetchDetailBundle(slug);
  assert.strictEqual(got[0].description, '第一次成功拿到的说明');
  assert.strictEqual(fetch.calls.length, 2, 'bundle 缓存也不能中毒');
});

testAsync('d. ensureDetail 端到端：失败保留 lite + 标记，重试成功后合并并重绘', async function () {
  const slug = 'math__1__abc.json';
  const index = { 'math|1|第一章': slug };
  const bundle = [{ id: 'cnm_t1', description: '完整介绍文字', mastery_criteria: ['能说清'] }];
  const fetch = fetchPlan([
    { ok: false, status: 503 },
    { ok: true, data: index },
    { ok: true, data: bundle }
  ]);
  const app = loadApp({ fetch: fetch });
  const ctx = app.ctx;
  const topic = { id: 'cnm_t1', grade: 1, chapter: '第一章' };

  ctx.ensureDetail(topic);
  await flush();

  assert.strictEqual(topic.description, undefined, '失败时保留 lite：description 仍为空');
  assert.strictEqual(topic.__detail, undefined, '失败时不能把 __detail 置位');
  assert.strictEqual(topic.__detailFailed, true, '失败时应留下 __detailFailed 标记供面板提示');
  assert.ok(app.calls.renderDetail >= 1, '失败后应重绘一次，让重试提示可见');

  const before = app.calls.renderDetail;
  const beforeQuestions = app.calls.loadQuestionsFor;
  ctx.ensureDetail(topic);
  await flush();

  assert.strictEqual(topic.description, '完整介绍文字', '重试成功后合并 bundle 里的 description');
  assert.strictEqual(topic.__detail, true, '重试成功后 __detail 置位');
  assert.ok(!topic.__detailFailed, '成功合并后应清掉 __detailFailed 标记');
  assert.ok(app.calls.renderDetail > before, '成功合并后应再次重绘');
  assert.ok(app.calls.loadQuestionsFor > beforeQuestions, '成功合并后应触发样题按需加载');
  assert.strictEqual(fetch.calls.length, 3, '索引失败 1 次 + 索引成功 1 次 + bundle 1 次');
});

/* ------------------------------------------------ e：静态守卫 */

test('e. app.js 含重试提示文案，renderDetail 引用失败标记，且不退回全量文件', function () {
  const clean = scan(APP, true);
  assert.ok(clean.indexOf(RETRY_TEXT) >= 0, '缺少重试提示文案：' + RETRY_TEXT);
  const renderBody = extractFunction('renderDetail');
  assert.ok(/__detailFailed/.test(renderBody), 'renderDetail 必须引用 __detailFailed 才会渲染失败提示');

  ['../data/topics.json', '../data/dependencies.json', '../data/questions.json'].forEach(function (bad) {
    assert.strictEqual(clean.indexOf(bad), -1, '详情链路不许退回全量文件：' + bad);
  });
});

Promise.all(ASYNC).then(function () {
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
});
