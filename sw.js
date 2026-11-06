/* 离线缓存：只保首屏 —— 站点壳（页面、样式、小脚本）和首屏要用的三份数据。
 *
 * 预算（卡 t_c84bc026）：CORE + SHELL + DATA 合计 gzip ≤ 150KB。
 * 改之前是 46 项 / 1043KB —— 在 GitHub Pages 国内 8~10KB/s 的链路上等于一次 100 秒的
 * 连续下载，和首屏真正需要的 176KB 抢带宽（用户感觉「打开要几十秒」就是这么来的；
 * 实测那台 PC 上当页 DCL 只有 457ms、19 个请求全命中缓存，没有主线程阻塞，
 * 慢的全是冷启动这一次预热）。
 *
 * 所以大文件一律不再预热：题库、topics.json、dependencies.json、课标、
 * funclab/geomlab、cytoscape/dagre、图标 png。
 * 它们本来就会被页面自己请求，取到后由下面的 fetch 策略写进缓存 —— 预热再存一份
 * 纯属重复下载。也就是说「访问过一次」之后离线照样能用；离线只保首屏，是用户的明确选择。
 * 用户已确认放弃「断网也能打开知识图谱」。
 *
 * 安装分两步，关键是「装得完」：
 *   安装（install）只预缓存 CORE —— 首页要用的 5 项、几十 KB，几秒内完成 → SW 立刻 active；
 *   激活（activate）之后再把 SHELL 剩下的项与 DATA 交给一个不阻塞的预热控制器，
 *   且要等首屏就绪（rIC / 延时兜底）才开始，并发 ≤ 2。
 *
 * 为什么不用 cache.addAll 一把梭整个 SHELL 列表：addAll 是全或无 ——
 * 整个列表逐项都成功才算装完，任何一项慢或 404，整个 install 就 reject，
 * SW 永远停在 installing、active 一直是 false，缓存里 0 项，离线能力全废。
 * 逐项 add + 逐项 catch，失败只丢该项，缺的下次访问时由 fetch 策略补上。
 *
 * 改了 SHELL 或 DATA 列表、或数据结构变了，就把 VERSION 加一。 */
'use strict';

var VERSION = 'v10';
var CACHE = 'cnm-pwa-' + VERSION;
var SCOPE = self.registration.scope;

/* 安装时必须成功的极小核心：首页 + 首页要用的样式、PWA 脚本。条目宁少勿多。
 * 这 5 项一项都不许删：它们逐项 catch，是离线兜底的地基（测试会逐项核对）。 */
var CORE = [
  './',
  'index.html',
  'assets/site.css',
  'assets/pwa.css',
  'assets/pwa.js'
];

/* 首屏壳：首页与 diagnose 入口的 HTML / 样式 / 小脚本。
 * 故意不含（它们都是几十上百 KB，且页面自己的首屏请求就会把它们取到并进缓存）：
 *   diagnose/app.js (55KB gz)、diagnose/engine.js (24KB gz)、explore/app.js、
 *   assets/vendor/cytoscape.min.js (117KB gz)、dagre.min.js (65KB gz)、qrcode.js、
 *   diagnose/funclab.js (41KB gz)、diagnose/geomlab.js (29KB gz)、
 *   assets/icons/*.png（PNG 压不动，三张合计 26KB gz）。
 * explore/ 与 children/ 两个入口也不预热：离线只保首屏（用户选择），
 * 进了这两个页面就说明在线，脚本按需取即可。 */
var SHELL = [
  'diagnose/',
  'diagnose/llm-config.js',
  'diagnose/lazyload.js',
  'diagnose/style.css',
  'assets/home.js',
  'assets/stats-config.js',
  'assets/stats.js',
  'assets/children.js',
  'assets/blindspots.js',
  'manifest.webmanifest'
];

/* 首屏数据只有三份：
 *   data/topics-lite.json     首屏渲染知识点（gzip 58KB）
 *   data/id-aliases.json      知识点别名（1KB）
 *   data/questions-index.json 题库索引（18KB，选中知识点后按章节取 bundle）
 * 不在这里的（topics.json 337KB / dependencies.json 112KB / cn-curriculum-standards.json 45KB /
 * questions.json 1246KB）一律运行时按需取，走下面策略 ② 的 staleWhileRevalidate。
 * 题库 bundle（data/questions/*.json）同上，永远不预热。 */
var DATA = [
  'data/topics-lite.json',
  'data/id-aliases.json',
  'data/questions-index.json'
];

function abs(path) { return new URL(path, SCOPE).href; }

function fresh(path) { return new Request(abs(path), { cache: 'reload' }); }

self.addEventListener('install', function (event) {
  event.waitUntil((async function () {
    var cache = await caches.open(CACHE);
    // 只预缓存 CORE；逐项 add、逐项 catch —— 一项慢或失败绝不挡安装
    await Promise.all(CORE.map(function (p) {
      return cache.add(fresh(p)).catch(function () { /* 该项稍后预热时再补 */ });
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', function (event) {
  event.waitUntil((async function () {
    var names = await caches.keys();
    await Promise.all(names.filter(function (n) { return n.indexOf('cnm-pwa-') === 0 && n !== CACHE; }).map(function (n) { return caches.delete(n); }));
    await self.clients.claim();
  })());
  // 预热故意不塞进 waitUntil：那会让 activate 一直等预热下完，SW 迟迟不 active。
  // 这里只是「排队」——真正开始要等首屏就绪（见 scheduleWarm）。
  scheduleWarm();
});

/* 预热时机（卡 t_c84bc026）：等首屏就绪之后再开始。
 *   - 有 requestIdleCallback 就等浏览器空闲（首屏脚本跑完、主线程空下来才有空闲），
 *     同时给 deadline，闲不下来也不能无限等；
 *   - 没有 rIC（Safari、以及 SW 全局作用域在多数浏览器上都没有 rIC）就用 setTimeout 兜底，
 *     绝不「永不触发」。延时取 15s：首屏实测 DCL 0.5~3s（冷启动最差 ~20s），
 *     排在这个量级之后，才不至于和首屏那 176KB 抢同一条 8KB/s 的带宽。
 * 同时最多 WARM_CONCURRENCY 条在飞：弱网下开 8 个并发只会互相拖慢。 */
var WARM_CONCURRENCY = 2;
var WARM_DELAY_MS = 15000;
var WARM_IDLE_TIMEOUT_MS = 15000;

var warmState = 'idle'; /* idle → scheduled → running → done */

function scheduleWarm() {
  if (warmState !== 'idle') return;
  warmState = 'scheduled';
  var start = function () { warm(); };
  if (typeof self.requestIdleCallback === 'function') {
    self.requestIdleCallback(start, { timeout: WARM_IDLE_TIMEOUT_MS });
  } else {
    setTimeout(start, WARM_DELAY_MS);
  }
}

/* 后台补缓存：SHELL 里 CORE 之外的部分 + DATA 全部。
 * 序号池控制并发（不是 Promise.all 一把开）：每个 worker 装完一项再取下一样。
 * 每一项独立 catch：失败只丢弃该项，不中断后面的项，也不影响 SW 已激活的状态。 */
function warm() {
  if (warmState === 'running' || warmState === 'done') return;
  warmState = 'running';
  caches.open(CACHE).then(function (cache) {
    var inCore = {};
    CORE.forEach(function (p) { inCore[p] = true; });
    var queue = SHELL.filter(function (p) { return !inCore[p]; }).concat(DATA);
    var next = 0;
    function worker() {
      if (next >= queue.length) return Promise.resolve();
      var p = queue[next++];
      return cache.add(fresh(p)).catch(function () { /* 单项失败只丢该项 */ }).then(worker);
    }
    var pool = [];
    var lanes = Math.min(WARM_CONCURRENCY, queue.length);
    for (var i = 0; i < lanes; i++) pool.push(worker());
    return Promise.all(pool);
  }).then(function () {
    warmState = 'done';
  }, function () {
    warmState = 'idle'; /* 缓存打不开就放弃预热，不影响已激活的 SW */
  });
}

function cacheable(res) {
  return res && res.status === 200 && res.type === 'basic' && !res.redirected;
}

function put(req, res) {
  if (!cacheable(res)) return;
  var copy = res.clone();
  caches.open(CACHE).then(function (c) { return c.put(req, copy); }).catch(function () { /* 空间不足等 */ });
}

function timeout(ms) {
  return new Promise(function (_, reject) { setTimeout(function () { reject(new Error('timeout')); }, ms); });
}

async function networkFirst(req, ignoreSearch, fallbackUrl) {
  try {
    var res = await Promise.race([fetch(req), timeout(5000)]);
    put(req, res);
    return res;
  } catch (e) {
    var hit = await caches.match(req, { ignoreSearch: ignoreSearch });
    if (hit) return hit;
    if (fallbackUrl) {
      var fb = await caches.match(fallbackUrl);
      if (fb) return fb;
    }
    // 超时但没有缓存：再等网络
    return fetch(req);
  }
}

async function staleWhileRevalidate(req) {
  var hit = await caches.match(req);
  var update = fetch(req).then(function (res) { put(req, res); return res; });
  if (hit) { update.catch(function () { /* 断网 */ }); return hit; }
  return update;
}

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === '/sw.js') return;
  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req, true, abs('./')));
    return;
  }
  if (/\.(?:json|png|svg|ico|webmanifest)$/.test(url.pathname)) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }
  event.respondWith(networkFirst(req, false, null));
});
