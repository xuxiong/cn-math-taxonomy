#!/usr/bin/env node
/* 诊断页首屏脚本按需加载（A+B）守卫：node tests/test_lazy_load.js
 *
 * 背景（线上 50KB/s 手机实测，HEAD 0d74b5a 冷启动 25.4s）：
 *   首屏脚本 403KB 里绝大多数是「进讲解 / 画路径图 / 分享 / 练习」才用的模块，
 *   却被 index.html 无条件同步加载。本卡把它们移出首屏链，改成运行时 Lazy.load。
 *   首屏脚本降到 ≈85KB（目标 ≤110KB）。
 *
 * 本文件守四条不再退化：
 *   1. 那 14 个脚本不许再回到 index.html 的 <script src> 链上；
 *   2. lazyload.js 必须排在 app.js 之前，且加载器本身不引入 eval / 动态 import；
 *   3. app.js 里每个「真调用」点，上方 25 行内必须有对应 Lazy.load（守卫行不算调用点）；
 *   4. sw.js 的预热清单必须覆盖所有被移出的脚本（否则离线二次访问 404）。
 *
 * 测试目录没有 DOM 基座、不引 jsdom：第 5、6 条用最小假 DOM 跑真的加载器代码。
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'diagnose', 'index.html'), 'utf8');
const LAZY_SRC = fs.readFileSync(path.join(ROOT, 'diagnose', 'lazyload.js'), 'utf8');
const APP_RAW = fs.readFileSync(path.join(ROOT, 'diagnose', 'app.js'), 'utf8') + '\n' + fs.readFileSync(path.join(ROOT, 'diagnose', 'app-flow.js'), 'utf8');
const SW = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');

/* 15 个被移出首屏链的脚本（路径按 index.html 里的写法） */
const MOVED = [
  '../assets/vendor/cytoscape.min.js',
  '../assets/vendor/dagre.min.js',
  '../assets/vendor/cytoscape-dagre.js',
  'explain.js',
  /* 卡 t_42e5978b：文本规范化唯一实现，随讲解一起懒加载（explain.js 依赖它） */
  'textfmt.js',
  'funclab.js',
  'chatgraph.js',
  'labmatch.js',
  'geomlab.js',
  'variants.js',
  'llm-eval.js',
  'llm-gateway.js',
  'llm-variants.js',
  '../assets/vendor/qrcode.js',
  'share.js'
];

/* sw.js 里的缓存键不带 '../'：assets/* 是站点根路径，其余是 diagnose/ 下 */
function swPath(p) {
  if (p.indexOf('../') === 0) return p.slice(3);
  return 'diagnose/' + p;
}

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

/* 抹掉注释（保留换行，行号不变）：注释里出现文件名/Lazy.load 不算数 */
function stripComments(src) {
  let out = '';
  let i = 0;
  let mode = 'code';
  let quote = '';
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && n === '*') { mode = 'block'; out += '  '; i += 2; continue; }
      if (c === '/' && n === '/') { mode = 'line'; out += '  '; i += 2; continue; }
      if (c === '"' || c === "'" || c === '`') { mode = 'str'; quote = c; }
      out += c; i++; continue;
    }
    if (mode === 'block') {
      if (c === '*' && n === '/') { mode = 'code'; out += '  '; i += 2; continue; }
      out += c === '\n' ? '\n' : ' '; i++; continue;
    }
    if (mode === 'line') {
      if (c === '\n') { mode = 'code'; out += '\n'; i++; continue; }
      out += ' '; i++; continue;
    }
    /* 字符串：原样保留（里面的文件名不能被当成加载点，但也不该被抹掉） */
    if (c === '\\') { out += c + (n || ''); i += 2; continue; }
    if (c === quote) mode = 'code';
    out += c; i++;
  }
  return out;
}

const APP = stripComments(APP_RAW);
/* 浏览器脚本作用域基座：把 diagnose/ 下真会在浏览器里跑的文件按 index.html 顺序加载。
 * 用于「取用口到底解析不解析得到」这类 Node 侧 require 测不出来的接线缺陷。 */
const { loadDiagnose } = require('./lib/diagnose-browser.js');

/* 首屏 <script src="…"> 清单（注释里提到的文件名不算） */
function eagerScripts(html) {
  const list = [];
  const re = /<script\b[^>]*\bsrc\s*=\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) list.push(m[1]);
  return list;
}

function assertNoEager(html) {
  const eager = eagerScripts(html);
  MOVED.forEach(function (p) {
    assert.strictEqual(eager.indexOf(p), -1, 'index.html 不应再同步加载 ' + p + '（应改为 Lazy.load）');
  });
  return eager;
}

/* ---------------------------------------------------------------- 假 DOM 跑加载器 */

function makeLazy() {
  const created = [];
  const doc = {
    head: {
      appendChild: function (el) { created.push(el); }
    },
    createElement: function (tag) {
      assert.strictEqual(tag, 'script', '加载器只应插 <script>');
      return { tagName: 'SCRIPT', src: null, async: true, onload: null, onerror: null };
    }
  };
  const sandbox = { document: doc, Promise: Promise, Error: Error, Array: Array, Object: Object, console: console };
  sandbox.self = sandbox;
  vm.runInNewContext(LAZY_SRC, sandbox, { filename: 'lazyload.js' });
  assert.ok(sandbox.Lazy && typeof sandbox.Lazy.load === 'function', 'lazyload.js 应挂 window.Lazy.load');
  function find(src) { return created.filter(function (s) { return s.src === src; }); }
  function fire(src, kind) {
    const all = find(src);
    assert.ok(all.length, '还没插入 ' + src);
    /* 取最后一个：失败重试时同一个 src 会有多次插入，要触发的是最新那次 */
    all[all.length - 1][kind]();
  }
  return { Lazy: sandbox.Lazy, created: created, find: find, fire: fire };
}

/* 注入排在 Promise 链里（前一个 onload 之后才插下一个），所以要等微任务跑完再看 DOM */
function tick() { return new Promise(function (r) { setImmediate(r); }); }

/* ---------------------------------------------------------------- 1. index.html */

test('index.html 不再同步加载那 14 个脚本（首屏只剩 chapter/lazyload/app 三件）', function () {
  const eager = assertNoEager(HTML);
  /* 首屏（阶段 0/1 就要跑）只留三件，顺序：chapter.js → lazyload.js → app.js。
   * chapter.js 是首屏纯函数层（parseChapter/subjectOf/buildGraph/gradeTargets + 题量常量）；
   * engine.js / app-flow.js / children / blindspots / llm-config / stats / pwa 全都不许回来。 */
  const keep = ['chapter.js', 'lazyload.js', 'app.js'];
  let last = -1;
  keep.forEach(function (p) {
    const at = eager.indexOf(p);
    assert.ok(at >= 0, '首屏应保留 ' + p);
    assert.ok(at > last, '首屏脚本顺序被改动：' + p);
    last = at;
  });
  const MUST_BE_LAZY = ['engine.js', 'app-flow.js', 'llm-config.js', '../assets/children.js',
    '../assets/blindspots.js', '../assets/stats-config.js', '../assets/stats.js', '../assets/pwa.js'];
  MUST_BE_LAZY.forEach(function (p) {
    assert.strictEqual(eager.indexOf(p), -1, 'index.html 不应同步加载 ' + p + '（首屏字节预算 / 首屏不依赖引擎）');
    assert.ok(APP.indexOf(p) >= 0, p + ' 应由 app.js 用 Lazy.load 按需注入');
  });
  /* 首屏脚本总数上限：const 三件，多一件都要先过预算关 */
  assert.ok(eager.filter(function (x) { return x.indexOf('http') !== 0; }).length <= 4,
    '首屏同源脚本不许超过 4 件：' + eager.join(','));
});

test('index.html 里 lazyload.js 在 app.js 之前', function () {
  const at = HTML.indexOf('<script src="lazyload.js"></script>');
  const app = HTML.indexOf('<script src="app.js"></script>');
  assert.ok(at >= 0, '缺 lazyload.js 的 <script>');
  assert.ok(app >= 0, '缺 app.js 的 <script>');
  assert.ok(at < app, 'lazyload.js 必须排在 app.js 之前（app.js 的使用点靠 window.Lazy）');
});

test('首屏脚本总量 ≤ 110KB（gzip 后传输量，浏览器实际下载的量）', function () {
  const zlib = require('zlib');
  const eager = eagerScripts(HTML);
  let total = 0;
  eager.forEach(function (p) {
    if (/^https?:/.test(p)) return;   // Umami 外链不算首屏脚本预算
    const file = path.join(ROOT, 'diagnose', p);
    if (!fs.existsSync(file)) return;
    total += zlib.gzipSync(fs.readFileSync(file)).length;
  });
  assert.ok(total <= 110 * 1024, '首屏脚本 gzip ' + Math.round(total / 1024) + 'KB，超过 110KB 预算');
});

/* ---------------------------------------------------------------- 2. lazyload.js */

test('lazyload.js：不用 eval / 动态 import，按插入顺序执行，有去重表', function () {
  const code = stripComments(LAZY_SRC);
  assert.ok(!/\beval\s*\(/.test(code), '加载器不许用 eval');
  assert.ok(!/\bimport\s*\(/.test(code), '加载器不许用动态 import()');
  assert.ok(/async\s*=\s*false/.test(code), '插入前应设 s.async = false（保持执行顺序）');
  assert.ok(/if\s*\(!\s*cache\s*\[\s*src\s*\]\s*\)/.test(code), '应有按 src 的去重表');
  assert.ok(/document\.createElement\(\s*'script'\s*\)/.test(code), '应动态插 <script>');
});

test('加载器本身很小（首屏也要下它）', function () {
  const kb = fs.statSync(path.join(ROOT, 'diagnose', 'lazyload.js')).size / 1024;
  assert.ok(kb < 4, 'lazyload.js ' + kb.toFixed(1) + 'KB，偏大（预期 1~2KB）');
});

/* ---------------------------------------------------------------- 3/4. 运行期行为 */

test('同一个 src 调两次只插入一次，并发调用复用同一个 Promise', async function () {
  const env = makeLazy();
  const p1 = env.Lazy.load('a.js');
  const p2 = env.Lazy.load('a.js');
  await tick();
  assert.strictEqual(env.find('a.js').length, 1, '同一个 src 只应插入一次');
  env.fire('a.js', 'onload');
  await Promise.all([p1, p2]);
  const p3 = env.Lazy.load('a.js');
  await p3;
  assert.strictEqual(env.find('a.js').length, 1, '加载完成后再调也不应重复插入');
});

test('数组按给定顺序串行注入：前一个 load 之前不注入后一个', async function () {
  const env = makeLazy();
  const done = env.Lazy.load(['funclab.js', 'labmatch.js']);
  await tick();
  assert.strictEqual(env.find('funclab.js').length, 1, '第一个脚本应开始注入');
  assert.strictEqual(env.find('labmatch.js').length, 0, '第二个脚本必须等第一个 onload 之后');
  env.fire('funclab.js', 'onload');
  await tick();
  assert.strictEqual(env.find('labmatch.js').length, 1, '第一个到货后才注入第二个');
  env.fire('labmatch.js', 'onload');
  await done;
});

test('失败必须 reject，且错误信息带上 src（不许静默 resolve）', async function () {
  const env = makeLazy();
  const p = env.Lazy.load('missing.js');
  await tick();
  env.fire('missing.js', 'onerror');
  let err = null;
  try { await p; } catch (e) { err = e; }
  assert.ok(err, 'onerror 时 Promise 必须 reject');
  assert.ok(String(err.message || err).indexOf('missing.js') >= 0, '错误信息要带 src，便于定位');
  /* 失败后清掉缓存：网络恢复还能重试 */
  const p2 = env.Lazy.load('missing.js');
  await tick();
  assert.strictEqual(env.find('missing.js').length, 2, '失败后应允许重新注入一次');
  env.fire('missing.js', 'onload');
  await p2;
});

/* ---------------------------------------------------------------- 5. app.js 使用点 */

const MODULE_GLOBAL = {
  Explain: 'explain.js',
  Funclab: 'funclab.js',
  Geomlab: 'geomlab.js',
  Labmatch: 'labmatch.js',
  ChatGraph: 'chatgraph.js',
  ShareCard: 'share.js',
  cytoscape: '../assets/vendor/cytoscape.min.js'
};

/* 找出 window.X 的「真调用」点：守卫（!window.X / window.X &&）和 geomlab.destroy 这类清理调用不算。 */
function callSites(src) {
  const lines = src.split('\n');
  const out = [];
  const re = /window\.(Explain|Funclab|Geomlab|Labmatch|ChatGraph|ShareCard|cytoscape)\b/g;
  lines.forEach(function (line, i) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(line))) {
      const name = m[1];
      const before = line.slice(0, m.index);
      const after = line.slice(m.index + m[0].length);
      if (/!\s*$/.test(before)) continue;                       // 守卫：!window.X
      if (/^\s*(&&|\|\||\)|\?)/.test(after)) continue;          // 守卫/三元里的存在性判断
      if (name === 'Geomlab' && /^\s*\.\s*destroy\b/.test(after)) continue;  // 卸载旧画板，不需要库
      out.push({ line: i + 1, name: name, text: line.trim() });
    }
  });
  return out;
}

test('app.js：每个 window.Funclab/Explain/ChatGraph/ShareCard/cytoscape 调用点，上方 25 行内有 Lazy.load', function () {
  const sites = callSites(APP);
  assert.ok(sites.length >= 6, '应能找到多个懒加载使用点，实际 ' + sites.length);
  const lines = APP.split('\n');
  const missing = [];
  sites.forEach(function (s) {
    let hit = false;
    for (let i = Math.max(0, s.line - 26); i < s.line; i++) {
      if (/\bLazy\.load\(/.test(lines[i])) { hit = true; break; }
    }
    if (!hit) missing.push(s.line + ': ' + s.text);
  });
  assert.deepStrictEqual(missing, [], '这些调用点没先 Lazy.load：\n' + missing.join('\n'));
});

test('app.js：懒加载依赖顺序写在一处，且覆盖全部被移出的模块', function () {
  const groups = {
    LAZY_EXPLAIN: ['llm-config.js', 'textfmt.js', 'explain.js'],
    LAZY_LAB: ['funclab.js', 'geomlab.js', 'labmatch.js', 'chatgraph.js'],
    LAZY_SHARE: ['../assets/vendor/qrcode.js', 'share.js'],
    LAZY_PATH: ['../assets/vendor/cytoscape.min.js', '../assets/vendor/dagre.min.js', '../assets/vendor/cytoscape-dagre.js'],
    LAZY_VARIANTS: ['variants.js', 'llm-eval.js', 'llm-gateway.js', 'llm-variants.js']
  };
  const covered = [];
  Object.keys(groups).forEach(function (name) {
    const at = APP.indexOf('const ' + name + ' =');
    assert.ok(at >= 0, 'app.js 里应有 ' + name);
    const block = APP.slice(at, APP.indexOf(']', at) + 1);
    groups[name].forEach(function (p) {
      assert.ok(block.indexOf("'" + p + "'") >= 0, name + ' 应包含 ' + p);
      covered.push(p);
    });
    /* 组内依赖顺序：被依赖的先出现 */
    const pos = groups[name].map(function (p) { return block.indexOf("'" + p + "'"); });
    assert.deepStrictEqual(pos, pos.slice().sort(function (a, b) { return a - b; }), name + ' 里的顺序应满足依赖（被依赖的在前）');
  });
  MOVED.forEach(function (p) {
    assert.ok(covered.indexOf(p) >= 0, '被移出的 ' + p + ' 不在任何 Lazy 组里（会永远加载不到）');
  });
});

test('app.js：练习入口的变式模块取用口在浏览器作用域里真解析得到', function () {
  /* 原断言是 `assert.ok(/variantsMod\(\)/.test(body))`：源码里有这串字符就算过 ——
   * 正是它放过了「app.js 有 variantsMod 函数、CORE 却漏导出，app-flow.js 裸用」这个线上 P0
   * （t_50c5ddb9：点「练习这 N 题」抛 ReferenceError，异常落进 withStage2Data 的 .then，
   * 表现为「点了没反应」）。改成真加载：按 index.html 的脚本顺序 + 按需段 app-flow.js
   * 在 vm 里以浏览器方式执行，再断言 CORE 上真能取到那个取用口。
   * 行为面（点下去练习态真被触发、拿到 LAZY_VARIANTS）见 tests/test_practice_entry_scope.js。 */
  const env = loadDiagnose(ROOT);
  assert.strictEqual(typeof env.ctx.DiagCore.variantsMod, 'function',
    'CORE 未导出 variantsMod：app-flow.js 里裸用它在浏览器作用域解析不到（ReferenceError，练习入口点了没反应）');
  /* 下面两条仍是本文件的老口径：练习入口必须先按 LAZY_VARIANTS 取模块，且不许在模块顶层抓引用。 */
  const body = APP.slice(APP.indexOf('function startPractice'), APP.indexOf('function _startPracticeRender'));
  assert.ok(/Lazy\.load\(LAZY_VARIANTS\)/.test(body), 'startPractice 应先 Lazy.load(LAZY_VARIANTS)');
  assert.ok(!/^\s*const V = Browser\.DiagVariants/m.test(APP), '模块顶层不许再抓 Browser.DiagVariants（懒加载后是 undefined）');
});

/* ---------------------------------------------------------------- 6. sw.js 预热 */

test('sw.js：被移出的懒加载脚本一律不进预热清单，也绝不进 CORE', function () {
  const core = SW.slice(SW.indexOf('var CORE = ['), SW.indexOf('];', SW.indexOf('var CORE = [')) + 2);
  const rest = SW.replace(core, '');
  MOVED.forEach(function (p) {
    const key = swPath(p);
    assert.strictEqual(core.indexOf("'" + key + "'"), -1, key + ' 不许进 CORE（install 必须几秒内装完）');
    /* 卡 t_c84bc026：预热预算砍到 ≤150KB。这些脚本（funclab 41KB gz、geomlab 29KB gz、
     * cytoscape 117KB gz、dagre 65KB gz…）全部改成运行时按需取 —— 页面首次请求就会由
     * staleWhileRevalidate / networkFirst 写进缓存，所以「预热要覆盖它们」这条老断言
     * 被反过来守：不许再进预热清单（否则 1043KB 又回来了）。 */
    assert.strictEqual(rest.indexOf("'" + key + "'"), -1, key + ' 不许再进预热清单（预热预算 ≤150KB，见 test_sw_preheat.js）');
  });
  /* A+B 那张卡要求「不改 VERSION」；C1（首屏数据瘦身）与 t_c84bc026（预热预算）都把清单
   * 改了，按 sw.js 的约定必须升版本让老缓存失效，所以这里的字面量跟着 v6 → v7 → v8 → v9 → v10
   * （仍是一条有效断言，而不是删掉/skip）。当前版本由 test_sw_preheat.js 再守一遍。 */
  assert.ok(/var VERSION = 'v10';/.test(SW), 'VERSION 应已是 v10（预热清单变了，老缓存必须失效）');
});

/* ---------------------------------------------------------------- 7. 自检：测试真的会红 */

test('自检：把某个懒加载文件塞回 <script src>，断言必须报错', function () {
  const bad = HTML.replace('<script src="lazyload.js"></script>',
    '<script src="lazyload.js"></script>\n<script src="funclab.js"></script>');
  assert.notStrictEqual(bad, HTML, '自检改动没生效');
  assert.throws(function () { assertNoEager(bad); }, /不应再同步加载 funclab\.js/, '守卫没抓到回退的同步 <script>');
});

/* ---------------------------------------------------------------- run */

(async function () {
  let passed = 0;
  let failed = 0;
  /* 看门狗：等一个永不 settle 的 Promise 时 node 会静默 exit 0，这里必须报红 */
  const watchdog = setTimeout(function () {
    console.log('\n超时：有断言在等一个永远不会 settle 的 Promise');
    process.exit(1);
  }, 15000);
  for (const item of tests) {
    try {
      await item[1]();
      passed++;
      console.log('  ok   ' + item[0]);
    } catch (e) {
      failed++;
      console.log('  FAIL ' + item[0] + '\n       ' + String(e && e.stack || e).split('\n').slice(0, 8).join('\n       '));
    }
  }
  clearTimeout(watchdog);
  console.log('\n' + (failed === 0 ? '全部通过' : '存在失败') + '：' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed === 0 ? 0 : 1);
})();
