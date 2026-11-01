/* 离线缓存：站点壳（页面、脚本、样式、图标）和图谱数据。
 * 页面和脚本：网络优先，断网时用缓存；数据和图标：先用缓存，同时后台更新。
 *
 * 安装分两步，关键是「装得完」：
 *   安装（install）只预缓存 CORE —— 首页要用的 5 项、几十 KB，几秒内完成 → SW 立刻 active；
 *   激活（activate）之后再用一条不阻塞的 Promise 链，逐项补 SHELL 剩下的项与 DATA 的 json。
 *
 * 为什么不用 cache.addAll 一把梭整个 SHELL 列表：addAll 是全或无 ——
 * 整个列表逐项都成功才算装完，任何一项慢或 404，整个 install 就 reject，
 * SW 永远停在 installing、active 一直是 false，缓存里 0 项，离线能力全废
 * （实测 50KB/s 的手机网络下，30 个壳 + 6 份数据约 1.8MB，必然装不完 = 永远没有缓存）。
 * 逐项 add + 逐项 catch，失败只丢该项，缺的下次访问时由 fetch 策略补上。
 *
 * 改了 SHELL 或 DATA 列表、或数据结构变了，就把 VERSION 加一。 */
'use strict';

var VERSION = 'v8';
var CACHE = 'cnm-pwa-' + VERSION;
var SCOPE = self.registration.scope;

/* 安装时必须成功的极小核心：首页 + 首页要用的样式、PWA 脚本。条目宁少勿多。 */
var CORE = [
  './',
  'index.html',
  'assets/site.css',
  'assets/pwa.css',
  'assets/pwa.js'
];

var SHELL = [
  './',
  'index.html',
  'explore/',
  'explore/app.js',
  'diagnose/',
  'diagnose/app.js',
  'diagnose/lazyload.js',
  'diagnose/engine.js',
  'diagnose/share.js',
  /* 以下 9 个是 diagnose 页运行时按需加载的（首屏链上不再有），必须预热进缓存，
   * 否则第二次离线访问一进讲解/路径图/练习就会 404。顺序与 app.js 里的 LAZY_* 一致。 */
  'diagnose/explain.js',
  'diagnose/funclab.js',
  'diagnose/geomlab.js',
  'diagnose/labmatch.js',
  'diagnose/chatgraph.js',
  'diagnose/variants.js',
  'diagnose/llm-eval.js',
  'diagnose/llm-gateway.js',
  'diagnose/llm-variants.js',
  'diagnose/style.css',
  'children/',
  'children/history.html',
  'children/children.css',
  'children/page.js',
  'children/history.js',
  'assets/site.css',
  'assets/explore.css',
  'assets/home.js',
  'assets/stats-config.js',
  'assets/stats.js',
  'assets/children.js',
  'assets/blindspots.js',
  'assets/pwa.js',
  'assets/pwa.css',
  'assets/vendor/cytoscape.min.js',
  'assets/vendor/cytoscape-dagre.js',
  'assets/vendor/dagre.min.js',
  'assets/vendor/qrcode.js',
  'assets/icons/icon-192.png',
  'assets/icons/icon-512.png',
  'assets/icons/apple-touch-icon.png',
  'manifest.webmanifest'
];

var DATA = [
  'data/topics-lite.json',
  'data/topics.json',
  'data/dependencies.json',
  'data/cn-curriculum-standards.json',
  'data/id-aliases.json'
];

/* 题库不再预热（卡 t_e855de2f）：
 *   data/questions.json 整份 1164KB gzip、data/questions/*.json 有 894 个 —— 预热哪一个都没意义，
 *   而且慢网下会跟首屏、跟正在做的题抢带宽。
 *   题库改走运行时缓存：后缀是 .json 的资源本来就走 staleWhileRevalidate（见下面 fetch 策略②），
 *   取到就写进 cnm-pwa-v8（put() 里 cache.put）。所以离线时「做过的章节」照样能做题，
 *   没做过的章节本来也没题可做（不会白屏，会明说题库没取到）。 */

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
  // 预热故意不塞进 waitUntil：那会让 activate 一直等到 1.75MB 下完，SW 迟迟不 active。
  warm();
});

/* 后台补缓存：SHELL 里 CORE 之外的部分 + DATA 全部 json。
 * 串行一条链（不用 Promise.all）—— 手机弱网下 30 个并发请求只会互相拖慢。
 * 每一项独立 catch：失败只丢弃该项，不中断后面的项，也不影响 SW 已激活的状态。 */
var warming = false;
function warm() {
  if (warming) return;
  warming = true;
  caches.open(CACHE).then(function (cache) {
    var inCore = {};
    CORE.forEach(function (p) { inCore[p] = true; });
    var rest = SHELL.filter(function (p) { return !inCore[p]; }).concat(DATA);
    return rest.reduce(function (chain, p) {
      return chain.then(function () {
        return cache.add(fresh(p)).catch(function () { /* 单项失败只丢该项 */ });
      });
    }, Promise.resolve());
  }).catch(function () { /* 缓存打不开就放弃预热，不影响已激活的 SW */ });
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
