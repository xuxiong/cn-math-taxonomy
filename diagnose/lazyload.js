/* 首屏脚本按需加载（A+B）：把「进讲解 / 画路径图 / 分享 / 练习」才用得到的模块
 * 从首屏 <script> 链里移出去，等真的要用时再注入（首屏脚本 403KB → ≈85KB）。
 *
 * 四条硬约束（改之前先读）：
 *   1. 串行。sources 里的脚本之间有依赖（funclab → labmatch → chatgraph、
 *      llm-eval → llm-gateway → llm-variants），必须按给定顺序一个下完再下一个。
 *      s.async = false 只保证「拿到后不打断解析」，不保证并发请求的到达顺序。
 *   2. 去重。同一个 src 反复调用只注入一次：内部 map 记住 Promise，并发调用复用同一个。
 *   3. 失败必须 reject 且带上 src。调用点靠 reject 走已有的降级分支
 *      （讲解退回纯文字、画板不显示、分享图给一行提示），绝不静默 resolve 成「加载成功」。
 *   4. 不用 eval、不用动态 import：只用 document.createElement('script')，
 *      静态部署与老 Safari 都能跑，也便于用假 DOM 单测。
 *
 * 用法：
 *   Lazy.load('explain.js').then(...)
 *   Lazy.load(['funclab.js', 'geomlab.js', 'labmatch.js']).then(...)
 */
(function (global) {
  'use strict';

  var cache = Object.create(null);   // src -> Promise（去重表）

  function inject(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.async = false;               // 保持插入顺序执行
      s.src = src;
      s.onload = function () { resolve(src); };
      s.onerror = function () { reject(new Error('脚本加载失败：' + src)); };
      (document.head || document.documentElement).appendChild(s);
    });
  }

  function load(sources) {
    var list = Array.isArray(sources) ? sources : [sources];
    var chain = Promise.resolve();
    list.forEach(function (src) {
      if (!src) return;
      /* 注入动作本身也排进链里：前一个脚本 onload 之后才插下一个，保证执行顺序 */
      chain = chain.then(function () {
        if (!cache[src]) {
          /* 失败后清掉缓存项：网络恢复后下一次调用还能重试，而不是永远拿到同一个 rejected Promise */
          cache[src] = inject(src).catch(function (err) {
            delete cache[src];
            throw err;
          });
        }
        return cache[src];
      });
    });
    return chain;
  }

  global.Lazy = { load: load };
})(typeof self !== 'undefined' ? self : this);
