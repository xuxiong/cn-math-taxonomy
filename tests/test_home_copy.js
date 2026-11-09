#!/usr/bin/env node
/* 首页文案与「AI 老师」一节的行为契约：node tests/test_home_copy.js（纯 node，无依赖）
 *
 * 这张卡的对外口径（用户明确要求，改首页文案前先读这里）：
 *   首页面向家长 / 学生，教材版本与课标细节移到 README「覆盖范围」一节；
 *   首屏必须让「AI 老师」出镜（讲知识点 / 陪做题两块能力），且不许 overclaim：
 *   只允许「未经人工审核」，不许写「已验证 / 已审核 / 保证」；
 *   「再来一道」的真实边界是「换一道同难度的题，出不了会直接告诉你」，
 *   不许写成「AI 给你出题」（19 个点程序构造、1065 个点按参数生成，其余明说支持不了）。
 *
 * 覆盖：
 *   1. .hero 之后、第一个 .section-title（三步）之前有 .ai-teacher，且含 2 个 .ai-card
 *   2. 两个 .ai-card 的 <a href> 按解析后的属性值逐字等于约定的两个示例链接
 *   3. 两个示例链接的目标文件真实存在（explore/index.html、diagnose/index.html），防死链
 *   4. .ai-teacher 有「AI 生成」「未经人工审核」，无「已验证」「已审核」「保证」
 *   5. 首屏正文（main.home）不含 统编版|人教版|教科版|必修|选择性必修|课标
 *   6. #stats 里没有 n-standards，仍保留 n-topics / n-edges / n-questions 三格
 *   7. 红线：首屏 id、首屏脚本集合、<link> 数量与基点一致（删格以外的结构不动）
 *   8. 联动：assets/home.js 与 scripts/screenshot.js 不再引用 n-standards
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const HOME_JS = fs.readFileSync(path.join(ROOT, 'assets', 'home.js'), 'utf8');
const SCREENSHOT_JS = fs.readFileSync(path.join(ROOT, 'scripts', 'screenshot.js'), 'utf8');

const LINK_CARD1 = 'explore/#cnm_p031';
const LINK_CARD2 = 'diagnose/?target=cnm_221&demo=1';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) {
    failed++;
    console.log('  FAIL ' + name);
    String((e && e.message) || e).split('\n').forEach(function (line) { console.log('       ' + line); });
  }
}

/* ------------------------------------------------ 极简 HTML 工具（不引依赖，只处理本页固定结构） */

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** 取某个开标签到其闭标签之间的原文；找不到返回 null。本页这几块都不嵌套同类标签。 */
function block(html, openNeedle, closeNeedle) {
  const start = html.indexOf(openNeedle);
  if (start < 0) return null;
  const end = html.indexOf(closeNeedle, start);
  if (end < 0) return null;
  return html.slice(start, end + closeNeedle.length);
}

function stripTags(html) {
  return decodeEntities(String(html).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

const AI_SECTION = block(INDEX, '<section class="ai-teacher">', '</section>');
const MAIN = block(INDEX, '<main class="home">', '</main>');

function aiCards() {
  if (!AI_SECTION) return [];
  const cards = [];
  let at = 0;
  for (;;) {
    const open = AI_SECTION.indexOf('<article class="ai-card">', at);
    if (open < 0) break;
    const close = AI_SECTION.indexOf('</article>', open);
    if (close < 0) break;
    cards.push(AI_SECTION.slice(open, close + '</article>'.length));
    at = close + 1;
  }
  return cards;
}

function hrefOf(cardHtml) {
  const m = /<a\s[^>]*href="([^"]*)"/.exec(cardHtml);
  return m ? decodeEntities(m[1]) : null;
}

/* ------------------------------------------------ 1–4. AI 老师一节 */

test('1. .hero 之后、第一个 .section-title（三步）之前有 .ai-teacher，且含 2 个 .ai-card', function () {
  assert.ok(AI_SECTION, 'index.html 里找不到 <section class="ai-teacher">');
  const heroAt = INDEX.indexOf('<section class="hero">');
  const aiAt = INDEX.indexOf('<section class="ai-teacher">');
  const firstTitleAt = INDEX.indexOf('class="section-title"');
  assert.ok(heroAt >= 0, '.hero 不见了（首屏结构被改）');
  assert.ok(firstTitleAt > heroAt, '第一个 .section-title 应在 .hero 之后');
  assert.ok(heroAt < aiAt, '.ai-teacher 必须排在 .hero 之后');
  assert.ok(aiAt < firstTitleAt, '.ai-teacher 必须排在三步（第一个 .section-title）之前：aiAt=' + aiAt + ' titleAt=' + firstTitleAt);
  assert.strictEqual(aiCards().length, 2, '.ai-card 数量应为 2，实际 ' + aiCards().length);
  assert.match(stripTags(AI_SECTION), /^AI 老师/, '节标题应是「AI 老师」');
  assert.match(stripTags(AI_SECTION), /知识点可以让它讲一遍，做题卡住了可以问它。/, '节导语缺失或被改写');
});

test('2. 两个 .ai-card 的 href 逐字等于 ' + LINK_CARD1 + ' / ' + LINK_CARD2, function () {
  const cards = aiCards();
  assert.strictEqual(hrefOf(cards[0]), LINK_CARD1, '第一张卡（讲一个知识点）的链接不对：' + hrefOf(cards[0]));
  assert.strictEqual(hrefOf(cards[1]), LINK_CARD2, '第二张卡（陪你把题做完）的链接不对：' + hrefOf(cards[1]));
});

test('3. 两个 href 指向的目标文件真实存在（防死链）', function () {
  [LINK_CARD1, LINK_CARD2].forEach(function (href) {
    const pathPart = href.split('#')[0].split('?')[0];
    const target = pathPart.endsWith('/') ? pathPart + 'index.html' : pathPart;
    assert.ok(fs.existsSync(path.join(ROOT, target)), href + ' 指向的 ' + target + ' 不存在');
  });
  /* 链接里写死的知识点 id 也要真在题库图里，否则点进去是空页 */
  const ids = new Set(require(path.join(ROOT, 'data', 'topics.json')).map(function (t) { return t.id; }));
  assert.ok(ids.has('cnm_p031'), 'cnm_p031（口算加法）不在 data/topics.json 里');
  assert.ok(ids.has('cnm_221'), 'cnm_221（配方法）不在 data/topics.json 里');
});

test('4. .ai-teacher 有「AI 生成」「未经人工审核」，无「已验证」「已审核」「保证」', function () {
  const text = stripTags(AI_SECTION);
  assert.ok(text.indexOf('AI 生成') >= 0, '缺少「AI 生成」标注');
  assert.ok(text.indexOf('未经人工审核') >= 0, '缺少「未经人工审核」');
  ['已验证', '已审核', '保证'].forEach(function (word) {
    assert.ok(text.indexOf(word) < 0, '.ai-teacher 里出现了 overclaim 用词「' + word + '」');
  });
  /* 「再来一道」的上限写法：只允许「换一道同难度的题…出不了会直接告诉你」 */
  assert.ok(text.indexOf('出不了会直接告诉你') >= 0, '缺少「出不了会直接告诉你」这一真实边界');
  assert.ok(text.indexOf('出题') < 0, '.ai-teacher 里出现了「出题」这类笼统说法（实际只有 19+1065 个点支持）');
});

/* ------------------------------------------------ 5–6. 首屏正文与统计格 */

test('5. 首屏正文（main.home）不含教材版本与课标用词', function () {
  assert.ok(MAIN, 'index.html 里找不到 <main class="home">');
  const text = stripTags(MAIN);
  const hit = text.match(/统编版|人教版|教科版|必修|选择性必修|课标/);
  assert.strictEqual(hit, null, 'main.home 里仍有「' + (hit && hit[0]) + '」：版本与课标细节应移到 README');
});

test('6. #stats 里没有 n-standards，仍保留 n-topics / n-edges / n-questions 三格', function () {
  /* 统计格内部还有 <div> 嵌套，不能按第一个 </div> 截；用紧跟其后的 .stat-note 作右边界 */
  const start = INDEX.indexOf('<div class="stat-grid" id="stats">');
  const end = INDEX.indexOf('<p class="stat-note"', start);
  assert.ok(start >= 0 && end > start, '找不到 #stats 块');
  const stats = INDEX.slice(start, end);
  assert.ok(stats.indexOf('n-standards') < 0, '#stats 里还留着 n-standards');
  ['n-topics', 'n-edges', 'n-questions'].forEach(function (id) {
    assert.ok(stats.indexOf('id="' + id + '"') >= 0, '#stats 里缺少 #' + id);
  });
  const cards = stats.match(/class="stat-card"/g) || [];
  assert.strictEqual(cards.length, 3, '统计格应为 3 个（课标条目整格已删），实际 ' + cards.length);
});

/* ------------------------------------------------ 7–8. 红线与联动 */

test('7. 首屏 id / 脚本集合 / <link> 与改前一致（只删了那一个统计格）', function () {
  ['n-topics', 'n-edges', 'n-questions', 'grades', 'blind-home', 'blind-home-lead',
    'blind-home-list', 'blind-home-actions', 'stats', 'load-error'].forEach(function (id) {
    assert.ok(INDEX.indexOf('id="' + id + '"') >= 0, '首屏依赖的 #' + id + ' 不见了（home.js / blindspots.js 会空指针）');
  });
  const scripts = (INDEX.match(/<script src="([^"]+)"/g) || []).map(function (tag) {
    return /src="([^"]+)"/.exec(tag)[1];
  });
  assert.deepStrictEqual(scripts, [
    'assets/children.js',
    'assets/blindspots.js',
    'assets/home.js',
    'assets/stats-config.js',
    'assets/stats.js',
    'assets/pwa.js'
  ], '首屏脚本集合被改：' + scripts.join(', '));
  const links = (INDEX.match(/<link\b[^>]*>/g) || []).length;
  assert.strictEqual(links, 5, '<link> 数量应为 5（favicon / site.css / manifest / apple-touch-icon / pwa.css），实际 ' + links);
});

test('8. 删格联动：home.js 与 screenshot.js 不再引用 n-standards', function () {
  assert.ok(HOME_JS.indexOf('n-standards') < 0, 'assets/home.js 还在写 #n-standards（节点已删，会静默空转或空指针）');
  assert.ok(SCREENSHOT_JS.indexOf('n-standards') < 0, 'scripts/screenshot.js 还在取 #n-standards.textContent（会排查到 null 崩掉截图）');
  assert.ok(HOME_JS.indexOf("setText('n-topics'") >= 0, 'home.js 的计数器渲染被误删');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
