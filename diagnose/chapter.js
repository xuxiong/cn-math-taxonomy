/* 章节解析纯函数层（首屏专用）：浏览器 window.CnmChapter，Node 下 require('./chapter.js')。
 *
 * WHY：diagnose 首屏（骨架 → 学科外壳 → 可搜索知识点列表）只用到 engine.js 里的
 * parseChapter / subjectOf 这两个纯函数，而 engine.js 全量 71KB / gz 23.9KB 且被懒加载
 * （进入诊断流程才拉）。把这两个纯函数连同年级确认题数常量拆成独立 ≤2KB 的小文件，
 * 与 lazyload.js 一起放进首屏脚本，首屏就不必等 23.9KB 的 engine.gz。
 *
 * UMD 沿用 engine.js 风格：浏览器挂 window.CnmChapter；Node 直测纯函数用 module.exports。
 * clampConfirm 依赖的 DEFAULT_CONFIRM / CONFIRM_CHOICES 一并随迁，保证 engine.js 侧
 * 用 CnmChapter.* 引用时语义完全一致（行为零变更）。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.CnmChapter = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* 年级确认题数常量：引擎内部判「掌握」需连续答对 confirm 题，界面只给 2 / 3 / 5 可选。 */
  const DEFAULT_CONFIRM = 3;
  const CONFIRM_CHOICES = [2, 3, 5];

  /** 界面可选值：只接受 2 / 3 / 5，其它回退默认。 */
  function clampConfirm(n) {
    const v = Math.floor(Number(n));
    return CONFIRM_CHOICES.indexOf(v) >= 0 ? v : DEFAULT_CONFIRM;
  }

  /**
   * 章节字符串 → {volume, chapterNo, chapterName, section}。
   * 各学段格式不同（WHY：topics 数据里 chapter 是「册名 章名」自由文本，
   * 列表分组 / 展开依赖这里统一切成结构化字段）：
   *   初中："七上 第一章 有理数 1.1" -> {volume:'七上', chapterNo:'第一章', chapterName:'有理数', section:'1.1'}
   *   小学："一年级上册 第1单元 单元名" 或 "一年级上册 综合与实践 活动名"
   */
  function parseChapter(chapter) {
    const s = chapter || '';
    const pm = /^([一二三四五六七八九])年级([上下全])册 (第\d+单元|预备单元\d) (.+)$/.exec(s);
    if (pm) return { volume: pm[1] + pm[2], chapterNo: pm[3], chapterName: pm[4], section: '' };
    const pi = /^([一二三四五六])年级([上下])册 (综合与实践) (.+)$/.exec(s);
    if (pi) return { volume: pi[1] + pi[2], chapterNo: pi[3], chapterName: pi[4], section: '' };
    // 小学英语复习 / Recycle（如「四年级上册 复习 Let's help!」）
    const prev = /^([一二三四五六])年级([上下])册 (复习) (.+)$/.exec(s);
    if (prev) return { volume: prev[1] + prev[2], chapterNo: prev[3], chapterName: prev[4], section: '' };
    // 高中英语按册名解析，避免「第1单元 Teenage Life」被空格拆成章名和节。
    const enHs = /^(必修第([一二三])册|选择性必修第([一二三四])册) (欢迎单元|第\d+单元) (.+)$/.exec(s);
    if (enHs) {
      return {
        volume: enHs[2] ? ('必修' + enHs[2]) : ('选必' + enHs[3]),
        chapterNo: enHs[4],
        chapterName: enHs[5],
        section: ''
      };
    }
    // 高中数学不拆上下册。高一/高二是必修两册，选必一/二/三是选择性必修三册。
    const hs = /^(高[一二]|选必[一二三]) (数学建模|数学探究) (\S+)$/.exec(s);
    if (hs) return { volume: hs[1], chapterNo: hs[2], chapterName: hs[3], section: '' };
    const m = /^(\S+) (第\S+章) (\S+?)(?: (\S+))?$/.exec(s);
    if (!m) return { volume: '', chapterNo: '', chapterName: s, section: '' };
    return { volume: m[1], chapterNo: m[2], chapterName: m[3], section: m[4] || '' };
  }

  /** 学科：显式 subject 优先，否则 cne_ 是英语、cnp_ 是物理、cnc_ 是语文、cns_ 是科学、cnd_ 是道德与法治、cnh_ 是历史、cng_ 是地理，其余算数学。 */
  function subjectOf(topic) {
    if (!topic) return 'math';
    if (topic.subject === 'english' || topic.subject === 'math' || topic.subject === 'physics' || topic.subject === 'chinese' || topic.subject === 'science' || topic.subject === 'morality' || topic.subject === 'history' || topic.subject === 'geography') return topic.subject;
    if (String(topic.id || '').indexOf('cne_') === 0) return 'english';
    if (String(topic.id || '').indexOf('cnp_') === 0) return 'physics';
    if (String(topic.id || '').indexOf('cnc_') === 0) return 'chinese';
    if (String(topic.id || '').indexOf('cns_') === 0) return 'science';
    if (String(topic.id || '').indexOf('cnd_') === 0) return 'morality';
    if (String(topic.id || '').indexOf('cnh_') === 0) return 'history';
    if (String(topic.id || '').indexOf('cng_') === 0) return 'geography';
    return 'math';
  }

  return {
    DEFAULT_CONFIRM: DEFAULT_CONFIRM,
    CONFIRM_CHOICES: CONFIRM_CHOICES.slice(),
    clampConfirm: clampConfirm,
    parseChapter: parseChapter,
    subjectOf: subjectOf
  };
});