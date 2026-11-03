'use strict';
/* 浏览器测试的等待工具（统一口径）。
 *
 * until(fn, label, timeout) 的 timeout 是**失败上限**，不是性能断言：
 * 它只用来在「页面/浏览器彻底没反应」时让测试尽快失败退出，而不是用来判断功能快慢。
 * 所以默认值统一成 30s（原来是 8s / 12s / 15s / 20s 各写各的），高负载下不会再假红；
 * 真正的判定交给条件本身（等元素出现、等 dataset.ready 变化），不是等够多少毫秒。
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const DEFAULT_TIMEOUT = 30000;

async function until(fn, label, timeout) {
  const limit = typeof timeout === 'number' ? timeout : DEFAULT_TIMEOUT;
  const end = Date.now() + limit;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() >= end) break;
    await sleep(50);
  }
  throw new Error('Timeout(' + limit + 'ms): ' + label);
}

/*
 * 报告页「渲染完成」的判据（在页面里求值）：
 *   1. 根节点 #summary 出现；
 *   2. 标题已经是「诊断结果」（renderResult 挂上去了）；
 *   3. 四状态统计块 .stats 已经有内容（已答题数…四个计数都画完了）；
 *   4. 路径图容器 #path-cy 已「落定」：dataset.ready 由 mountPathGraph 写，
 *      '0' 表示还在挂载（含懒加载图形库后再挂一次），'1' 画完，'err' 表示画失败。
 *      '1' / 'err' 都算落定 —— 这里只判断「页面渲染结束」；图本身画得对不对，
 *      由专门的路径图用例（断言 dataset.ready === '1' 且节点真实存在）负责，
 *      不在这里用等待条件偷偷放宽。
 * 这样等待由状态驱动：慢机器上多久都等（上限 30s 防死等），快机器上立刻返回。
 */
const REPORT_READY_EXPR = [
  '(() => {',
  '  var s = document.getElementById("summary");',
  '  if (!s) return false;',
  '  var h = s.querySelector("h2");',
  '  if (!h || h.textContent.indexOf("诊断结果") < 0) return false;',
  '  var stats = s.querySelector(".stats");',
  '  if (!stats || !/已答题数/.test(stats.textContent)) return false;',
  '  var cy = document.getElementById("path-cy");',
  '  if (cy && cy.dataset.ready !== "1" && cy.dataset.ready !== "err") return false;',
  '  return true;',
  '})()'
].join('\n');

/* 等到报告页关键子块都渲染完（不是「等 8 秒看它来不来得及」） */
async function reportReady(cdp, label) {
  return until(
    function () { return cdp.eval(REPORT_READY_EXPR); },
    label || '报告页渲染完成（#summary + 四状态统计 + 路径图落定）'
  );
}

module.exports = { until: until, reportReady: reportReady, sleep: sleep, DEFAULT_TIMEOUT: DEFAULT_TIMEOUT, REPORT_READY_EXPR: REPORT_READY_EXPR };
