#!/usr/bin/env node
/* fork 上游回流守卫：node tests/test_fork_guards.js
 *
 * 本仓库 fork 自 xiaoyang111222/cn-math-taxonomy。合并上游时，
 * 「我们故意删掉的东西」会随着冲突解成上游、或上游新加的同款内容直接回流。
 * git 看不见删除意图，所以把每条分叉写成断言 —— 回归了就在这里变红。
 *
 * 分叉清单（为什么删、对应哪个 commit）：docs/fork-divergences.md
 *
 * 覆盖：
 *   (a) 禁用词扫描      —— 仓库里不得再出现上游外链的域名关键词（pansgo）
 *   (b) 外链域名白名单  —— 所有 *.html 里的 http(s) 外链域名必须在白名单内
 *                          （比黑名单重要：能挡住下一个没见过的推广位）
 *   (c) 统计上报已停用  —— assets/stats-config.js 的 endpoint 为空
 *   (d) 上游部署脚本    —— scripts/deploy-cf.sh 必须不存在
 *   (e) 顶部横幅/资源搜索 —— 5 个页面不得再出现 .top-banner 与 resource-search-btn，
 *                          assets/site.css 不得再出现 .resource-search-* 规则
 *   (f) 分享导流        —— PWA 图文字与分享二维码链接必须指向本站 GitHub Pages
 *   (g) 儿童智商测试卡  —— index.html 不得再出现 a.iq-card
 *   (h) LLM 配置唯一真源 —— diagnose/llm-config.js 能 require、型号正确；
 *                          diagnose/*.js（除它）与 scripts/*.js 不得再写死网关地址/型号
 *                          （写死会静默让整层功能 fail-closed，见 docs/fork-divergences.md）
 *   (i) 统计脚本只有 Umami 一处 —— 5 个页面各恰好 1 个 cloud.umami.is 标签，website-id 正确、
 *                          必带 data-exclude-search 与 data-domains；全站 .html 不得再出现其它统计域名
 *                          （少了 data-exclude-search 就等于把 ?target=cnm_235 这类题目 ID 报给第三方）
 *
 * 加白/加例外都要改本文件顶部的数组：改代码、看得见、走 review。
 *
 * 无依赖，不访问网络。跑法：node tests/test_fork_guards.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

/* ------------------------------------------------------------------ *
 * 配置：加白/加例外都改这里
 * ------------------------------------------------------------------ */

/** 禁用词：上游外链推广位留下的域名关键词（大小写不敏感）。 */
const FORBIDDEN_WORDS = [
  'pansgo', // test.pansgo.com / pansgo.com —— 顶部横幅、「资源搜索」导航（见分叉清单 1、3）
];

/** 外链域名白名单：*.html 里出现 http(s) 外链时，域名必须在这些里面。 */
const ALLOWED_DOMAINS = [
  'github.com',        // 源码仓库：「关于」「提交 Issue」指向 github.com/xuxiong/cn-math-taxonomy
  'xuxiong.github.io', // 本站 GitHub Pages 生产地址（分享二维码、PWA 引导图文案）
  '127.0.0.1',         // 本地起服务验证（scripts/serve.js）
  'localhost',         // 同上
  'www.w3.org',        // 内联 SVG 的 XML 命名空间（xmlns="http://www.w3.org/2000/svg"），不是外链
  'cloud.umami.is',    // 匿名访问统计脚本（5 个页面各一处，见分叉清单第 9 条、守卫 (i)）
];

/** 本文件/分叉清单必须写出被禁的字符串才能检测/说明它，扫描时跳过。 */
const SELF_REFERENTIAL = new Set([
  'tests/test_fork_guards.js',
  'docs/fork-divergences.md',
]);

/** 扫描时整个跳过的目录。 */
const SKIP_DIR_NAMES = new Set(['node_modules', '.git', '.worktrees']);

/** 扫描时跳过的路径前缀（反向用例文件放这儿，供人手工验证检测器有效）。 */
const SKIP_REL_PREFIXES = ['tests/fixtures/'];

/** 5 个带全站头部的页面（顶部横幅、导航块都在这几个里回流）。 */
const PAGES = [
  'index.html',
  'diagnose/index.html',
  'explore/index.html',
  'children/index.html',
  'children/history.html',
];

const STATS_CONFIG = 'assets/stats-config.js';
const SITE_CSS = 'assets/site.css';
const DEPLOY_SCRIPT = 'scripts/deploy-cf.sh';
const PWA_JS = 'assets/pwa.js';
const SHARE_JS = 'diagnose/share.js';
const SITE_HOST_TEXT = 'xuxiong.github.io/cn-math-taxonomy';

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (e) {
    failed++;
    const detail = String((e && e.message) || e).split('\n');
    console.log('  FAIL ' + name);
    detail.forEach(function (line) { console.log('       ' + line); });
  }
}

const fileCache = new Map();

function read(rel) {
  if (!fileCache.has(rel)) fileCache.set(rel, fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  return fileCache.get(rel);
}

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

/** 按扩展名遍历仓库，返回相对路径列表（已排除 SKIP_* 与 SELF_REFERENTIAL）。 */
function filesWithExt(exts) {
  const out = [];
  (function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      const rel = path.relative(ROOT, full).split(path.sep).join('/');
      if (ent.isDirectory()) {
        if (SKIP_DIR_NAMES.has(ent.name)) continue;
        if (SKIP_REL_PREFIXES.some(function (p) { return (rel + '/').startsWith(p); })) continue;
        walk(full);
      } else if (exts.some(function (x) { return ent.name.endsWith(x); })) {
        if (SELF_REFERENTIAL.has(rel)) continue;
        out.push(rel);
      }
    }
  })(ROOT);
  return out.sort();
}

/** 一行为一段，返回 [{ line, text }]，只保留非空行。 */
function lines(rel) {
  return read(rel).split('\n').map(function (text, i) {
    return { line: i + 1, text: text };
  });
}

/** 在文件里找禁用词，返回 ['README.md:12  「…pansgo…」', ...]（最多 10 条）。 */
function forbiddenHits(rel, words) {
  const hits = [];
  const lower = (words || FORBIDDEN_WORDS).map(function (w) { return w.toLowerCase(); });
  for (const row of lines(rel)) {
    const text = row.text.toLowerCase();
    for (const w of lower) {
      if (text.indexOf(w) !== -1) {
        hits.push(rel + ':' + row.line + '  「' + row.text.trim().slice(0, 160) + '」');
        break;
      }
    }
  }
  return hits;
}

/** 提取 HTML 里所有 http(s) 外链的域名，返回 [{ line, url, host }]。 */
function externalLinks(rel) {
  const out = [];
  for (const row of lines(rel)) {
    const re = /https?:\/\/[^\s"'<>()]+/g;
    let m;
    while ((m = re.exec(row.text)) !== null) {
      let host = '';
      try { host = new URL(m[0]).host; } catch (e) { host = m[0]; }
      // host 为空说明是畸形 URL，按违规处理（宁可红一次）
      out.push({ line: row.line, url: m[0], host: host });
    }
  }
  return out;
}

function isAllowedHost(host, allowed) {
  const list = allowed || ALLOWED_DOMAINS;
  const h = String(host || '').toLowerCase();
  return list.some(function (d) { return h === d || h === 'www.' + d; });
}

/* ------------------------------------------------------------------ *
 * (a) 禁用词扫描
 * ------------------------------------------------------------------ */

const WORD_HINT = '（这是上游外链推广位的域名，合并时回流了？见 docs/fork-divergences.md 第 1、3 条；'
  + '确要保留请改 tests/test_fork_guards.js 顶部的 FORBIDDEN_WORDS 并说明理由）';

[
  ['.html', ['.html']],
  ['.js', ['.js']],
  ['.css', ['.css']],
  ['.md', ['.md']],
  ['.sh', ['.sh']],
  ['.json', ['.json']],
].forEach(function (pair) {
  const label = pair[0];
  const exts = pair[1];
  test('(a) 仓库里 *.html *.js … 的 ' + label + ' 文件不含禁用词 ' + FORBIDDEN_WORDS.join('、'), function () {
    const offenders = [];
    for (const rel of filesWithExt(exts)) {
      offenders.push.apply(offenders, forbiddenHits(rel));
    }
    assert.ok(offenders.length === 0,
      offenders.length + ' 处出现禁用词' + WORD_HINT + '：\n' + offenders.slice(0, 10).join('\n'));
  });
});

/* ------------------------------------------------------------------ *
 * (b) 外链域名白名单
 * ------------------------------------------------------------------ */

test('(b) 所有 *.html 的外链域名都在白名单里（白名单见本文件顶部 ALLOWED_DOMAINS）', function () {
  const offenders = [];
  for (const rel of filesWithExt(['.html'])) {
    for (const link of externalLinks(rel)) {
      if (!isAllowedHost(link.host)) {
        offenders.push(rel + ':' + link.line + '  外链域名 ' + link.host + '（' + link.url + '）');
      }
    }
  }
  assert.ok(offenders.length === 0,
    '出现 ' + offenders.length + ' 个白名单外的外链域名（合上游时回流了？见 docs/fork-divergences.md 第 1 条；'
    + '若确属正当外链，加进 tests/test_fork_guards.js 顶部的 ALLOWED_DOMAINS 并写注释说明用途）：\n'
    + offenders.slice(0, 10).join('\n'));
});

test('(b) 外链扫描确实扫到了 5 个页面的 HTML（防止正则失效导致永远为绿）', function () {
  const scanned = filesWithExt(['.html']);
  for (const rel of PAGES) {
    assert.ok(scanned.indexOf(rel) !== -1, rel + ' 没被扫描到，扫描路径过滤写错了？');
  }
  // 自检：检测器认得一个不在白名单里的域名，也认得 github.com
  const synth = externalLinksIn('<a href="https://pansgo.example.com/x">x</a><a href="https://github.com/xuxiong/cn-math-taxonomy">y</a>');
  assert.ok(synth.length === 2, '外链提取器应提取出 2 条，实际 ' + synth.length + ' 条');
  assert.ok(!isAllowedHost(synth[0].host), '白名单不该放行 ' + synth[0].host);
  assert.ok(isAllowedHost(synth[1].host), '白名单应放行 github.com');
});

/** 对一段 HTML 文本做外链提取（供自检用，不读文件）。 */
function externalLinksIn(text) {
  const out = [];
  const re = /https?:\/\/[^\s"'<>()]+/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    let host = '';
    try { host = new URL(m[0]).host; } catch (e) { host = m[0]; }
    out.push({ url: m[0], host: host });
  }
  return out;
}

test('(a) 禁用词检测器确实认得禁用词（防止正则失效导致永远为绿）', function () {
  const hits = hitsIn('var a = "https://test.' + FORBIDDEN_WORDS[0] + '.com/?from=math-top";');
  assert.strictEqual(hits.length, 1, '禁用词检测器没认出 ' + FORBIDDEN_WORDS[0] + '，检测逻辑写错了');
  assert.strictEqual(hitsIn('var a = "https://github.com/xuxiong/cn-math-taxonomy";').length, 0,
    '禁用词检测器误报了不含禁用词的行');
});

/** 对一段文本做禁用词检测（供自检用，不读文件）。 */
function hitsIn(text) {
  const lower = text.toLowerCase();
  return FORBIDDEN_WORDS.filter(function (w) { return lower.indexOf(w.toLowerCase()) !== -1; });
}

/* ------------------------------------------------------------------ *
 * (c) 统计上报已停用
 * ------------------------------------------------------------------ */

test('(c) ' + STATS_CONFIG + ' 的 window.CNM_STATS.endpoint 为空（本 fork 不上报统计）', function () {
  assert.ok(exists(STATS_CONFIG), STATS_CONFIG + ' 不存在了？它是统计配置，被删要同步改本测试');
  const sandbox = { window: {} };
  vm.runInNewContext(read(STATS_CONFIG), sandbox, { filename: STATS_CONFIG });
  const cfg = sandbox.window.CNM_STATS;
  assert.ok(cfg && typeof cfg === 'object', STATS_CONFIG + ' 没设置 window.CNM_STATS 对象');
  assert.strictEqual(cfg.endpoint, '',
    STATS_CONFIG + ' 的 endpoint 又被填成 "' + String(cfg.endpoint) + '" 了 —— 上游自建采集地址回流？'
    + '本 fork 不上报统计，见 docs/fork-divergences.md 第 5 条');
});

/* ------------------------------------------------------------------ *
 * (d) 上游 Cloudflare Pages 部署脚本已删
 * ------------------------------------------------------------------ */

test('(d) ' + DEPLOY_SCRIPT + ' 必须不存在（上游部署脚本，本 fork 走 GitHub Pages）', function () {
  assert.ok(!exists(DEPLOY_SCRIPT),
    DEPLOY_SCRIPT + ' 回来了 —— 上游把它部署到自己 Cloudflare Pages 项目，'
    + '本 fork 走 GitHub Pages，见 docs/fork-divergences.md 第 4 条');
});

/* ------------------------------------------------------------------ *
 * (e) 顶部横幅 / 资源搜索导航
 * ------------------------------------------------------------------ */

test('(e) 5 个页面都没有 a.top-banner、也没有 resource-search-btn', function () {
  const problems = [];
  for (const rel of PAGES) {
    assert.ok(exists(rel), rel + ' 不存在了？页面清单要同步改本测试');
    const text = read(rel);
    if (/top-banner/.test(text)) {
      problems.push(rel + ' 出现了 .top-banner 顶部横幅（外链广告，合并上游时回流了？见 docs/fork-divergences.md 第 1 条）');
    }
    if (/resource-search/.test(text)) {
      problems.push(rel + ' 出现了 resource-search 导航（「资源搜索」外链，上游 5ca171d 后加的，见 docs/fork-divergences.md 第 3 条）');
    }
    if (/iq-card/.test(text)) {
      problems.push(rel + ' 出现了 a.iq-card 儿童智商测试卡片（外链广告，见 docs/fork-divergences.md 第 2 条）');
    }
  }
  assert.ok(problems.length === 0, problems.join('\n'));
});

test('(e) ' + SITE_CSS + ' 没有 .resource-search-btn / .resource-search-ico 的死规则', function () {
  assert.ok(exists(SITE_CSS), SITE_CSS + ' 不存在了？');
  const hits = lines(SITE_CSS)
    .filter(function (row) { return /\.resource-search/.test(row.text); })
    .map(function (row) { return SITE_CSS + ':' + row.line + '  「' + row.text.trim() + '」'; });
  assert.ok(hits.length === 0,
    '导航块删了但 CSS 规则回流了（死样式，见 docs/fork-divergences.md 第 3 条）：\n' + hits.slice(0, 10).join('\n'));
});

/* ------------------------------------------------------------------ *
 * (f) 分享图不许导流到上游生产站
 * ------------------------------------------------------------------ */

test('(f) ' + PWA_JS + ' 分享图文字指向 ' + SITE_HOST_TEXT, function () {
  assert.ok(exists(PWA_JS), PWA_JS + ' 不存在了？');
  const text = read(PWA_JS);
  assert.ok(text.indexOf('xiaoyang') === -1,
    PWA_JS + ' 里出现了上游账号名 xiaoyang（分享图/文案回流了？见 docs/fork-divergences.md 第 6 条）');
  const hosts = text.match(/[A-Za-z0-9.-]*github\.io\/[A-Za-z0-9./_-]*/g) || [];
  assert.ok(hosts.length > 0, PWA_JS + ' 里找不到 github.io 的站点地址，分享图文案被改没了？');
  const bad = hosts.filter(function (h) { return h !== SITE_HOST_TEXT; });
  assert.ok(bad.length === 0,
    PWA_JS + ' 的分享图文字应全部是 ' + SITE_HOST_TEXT + '，实际还有：' + bad.join('、')
    + '（本站是 fork，不该导流到上游生产站，见 docs/fork-divergences.md 第 6 条）');
});

test('(f) ' + SHARE_JS + ' 的 SHARE_URL 指向 ' + SITE_HOST_TEXT, function () {
  assert.ok(exists(SHARE_JS), SHARE_JS + ' 不存在了？');
  const text = read(SHARE_JS);
  assert.ok(text.indexOf('xiaoyang') === -1,
    SHARE_JS + ' 里出现了上游账号名 xiaoyang（分享二维码回流了？见 docs/fork-divergences.md 第 6 条）');
  const m = text.match(/SHARE_URL\s*=\s*['"]([^'"]*)['"]/);
  assert.ok(m, SHARE_JS + ' 里找不到 SHARE_URL 的定义，定义形式变了？本测试要跟着改');
  let url;
  try { url = new URL(m[1]); } catch (e) { assert.fail(SHARE_JS + ' 的 SHARE_URL 不是合法 URL：' + m[1]); }
  assert.strictEqual(url.host, 'xuxiong.github.io',
    SHARE_JS + ' 的 SHARE_URL 指向了 ' + url.host + '（分享二维码不该导流到上游生产站，见 docs/fork-divergences.md 第 6 条）');
  assert.ok(url.pathname.indexOf('/cn-math-taxonomy') === 0,
    SHARE_JS + ' 的 SHARE_URL 路径是 ' + url.pathname + '，应指向 /cn-math-taxonomy（本站 GitHub Pages 子路径）');
});

/* ------------------------------------------------------------------ *
 * (h) LLM 配置唯一真源（防漂移）
 * ------------------------------------------------------------------ */

/** 全站约定型号：只允许写在 diagnose/llm-config.js 里。 */
const SITE_MODEL = 'DeepSeek-V4.1-Flash-1017-Unlimited';

/** 只允许出现在 diagnose/llm-config.js 的字面量（网关地址 + 型号）。 */
const LLM_SOURCE_LITERALS = ['127.0.0.1:3000', SITE_MODEL];

/**
 * 扫描某个目录顶层的 *.js（可排除一个文件名），找出仍写死 LLM 字面量的行。
 * @param {string} dirRel 相对仓库根目录的目录名（'diagnose' / 'scripts'）
 * @param {string|null} allowName 该目录下允许保留字面量的文件名
 * @returns {string[]} 人话描述的违规项
 */
function llmLiteralOffenders(dirRel, allowName) {
  const out = [];
  const dir = path.join(ROOT, dirRel);
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith('.js')) continue;
    if (allowName && name === allowName) continue;
    const rel = dirRel + '/' + name;
    const text = read(rel);
    for (const lit of LLM_SOURCE_LITERALS) {
      let idx = text.indexOf(lit);
      while (idx !== -1) {
        const line = text.slice(0, idx).split('\n').length;
        out.push(rel + ':' + line + ' 仍写死了「' + lit + '」');
        idx = text.indexOf(lit, idx + lit.length);
      }
    }
  }
  return out;
}

test('(h) diagnose/llm-config.js 能 require，且型号为 ' + SITE_MODEL, function () {
  const cfg = require(path.join(ROOT, 'diagnose', 'llm-config.js'));
  assert.ok(cfg && typeof cfg === 'object', 'diagnose/llm-config.js 没有导出配置对象');
  assert.strictEqual(cfg.model, SITE_MODEL,
    'diagnose/llm-config.js 的 model 应为 ' + SITE_MODEL + '，实际是 ' + cfg.model);
});

test('(h) 网关地址/型号字面量只允许出现在 diagnose/llm-config.js', function () {
  const offenders = llmLiteralOffenders('diagnose', 'llm-config.js')
    .concat(llmLiteralOffenders('scripts', null));
  assert.deepStrictEqual(offenders, [],
    '以下文件仍写死了网关地址或型号：\n  ' + offenders.join('\n  ')
    + '\n请改 diagnose/llm-config.js（配置唯一真源），不要在调用方复制字面量。');
});

/* ------------------------------------------------------------------ *
 * (i) 统计脚本只有 Umami 一处，且口径收窄
 *
 * 别指望 (b) 兜住统计脚本：(b) 是逐行扫所有 http(s) URL 的（<script src> 也会被扫到），
 * 但它只判断「域名在不在白名单」—— 一个少了 data-exclude-search 的 Umami 标签域名照样合法、
 * (b) 照样为绿，而题目 ID 已经在往外发。所以统计口径必须由本条单独兜住。
 * ------------------------------------------------------------------ */

/** 唯一允许的统计脚本。 */
const STATS_SCRIPT_URL = 'cloud.umami.is/script.js';
/** Umami 站点的 website-id（真源就是 5 个页面里的标签，本测试只做比对）。 */
const STATS_WEBSITE_ID = '1ddb50a4-8c63-4e7a-b2fb-228a59943c5e';
/** 标签本体（属性跨行，[^>] 含换行）。 */
const STATS_SCRIPT_TAG = /<script\b[^>]*cloud\.umami\.is\/script\.js[^>]*>/;

/** 其它统计/分析脚本的域名关键词（除 cloud.umami.is 外，命中一律红）。 */
const OTHER_ANALYTICS_HINTS = [
  'analytics', 'gtag', 'googletagmanager', 'google-analytics', 'doubleclick',
  'baidu', 'busuanzi', 'plausible', 'umami', 'clarity', 'matomo',
  'statcounter', 'cnzz', '51.la', 'umeng', 'sensorsdata', 'tajs', 'hm.js',
];

/** 统计脚本标签必须带的口径属性（缺哪个都会让数据被污染/外泄）。 */
const STATS_REQUIRED_ATTRS = [
  ['data-website-id="' + STATS_WEBSITE_ID + '"', 'website-id 不对 → 收不到数据，或把数据发到别的站点'],
  ['data-exclude-search', '没关 URL 查询参数 → ?target=cnm_235 这类题目 ID 被上传给第三方（孩子做到哪题）'],
  ['data-domains="xuxiong.github.io"', '没限域名 → 本地 127.0.0.1 冒烟测试也计数，正式数据被污染'],
];

test('(i) 5 个页面各恰好 1 个 ' + STATS_SCRIPT_URL + ' 标签，且口径收窄（website-id / exclude-search / domains）', function () {
  const problems = [];
  for (const rel of PAGES) {
    assert.ok(exists(rel), rel + ' 不存在了？页面清单要同步改本测试');
    const text = read(rel);
    const occurrences = text.split(STATS_SCRIPT_URL).length - 1;
    if (occurrences !== 1) {
      problems.push(rel + ' 出现 ' + occurrences + ' 次 ' + STATS_SCRIPT_URL + '，应恰好 1 次'
        + '（见 docs/fork-divergences.md 第 9 条）');
      continue;
    }
    const tag = text.match(STATS_SCRIPT_TAG);
    assert.ok(tag, rel + ' 里 ' + STATS_SCRIPT_URL + ' 不在一个 <script> 标签里，标签结构被改了？');
    for (const pair of STATS_REQUIRED_ATTRS) {
      if (tag[0].indexOf(pair[0]) === -1) {
        problems.push(rel + ' 的统计标签缺 ' + pair[0] + '：' + pair[1]
          + '（见 docs/fork-divergences.md 第 9 条 / 守卫 (i)）');
      }
    }
  }

  // 全站：除 cloud.umami.is 外，不得再出现任何其它统计脚本域名
  for (const rel of filesWithExt(['.html'])) {
    for (const link of externalLinks(rel)) {
      const host = String(link.host || '').toLowerCase();
      if (host === 'cloud.umami.is') continue;
      const hit = OTHER_ANALYTICS_HINTS.some(function (h) { return host.indexOf(h) !== -1; });
      if (hit) {
        problems.push(rel + ':' + link.line + ' 出现了其它统计脚本域名 ' + host
          + '（本 fork 只允许 cloud.umami.is 一处，见 docs/fork-divergences.md 第 9 条）');
      }
    }
  }

  assert.ok(problems.length === 0, problems.join('\n'));

  // 自检：检测器确实认得「缺属性」和「其它统计域名」，否则上面永远为绿
  const bad = '<script src="https://' + STATS_SCRIPT_URL + '" data-website-id="' + STATS_WEBSITE_ID + '"></script>';
  const badTag = bad.match(STATS_SCRIPT_TAG);
  assert.ok(badTag, '标签提取器没认出 Umami 标签，检测逻辑写错了');
  assert.ok(badTag[0].indexOf('data-exclude-search') === -1 && badTag[0].indexOf('data-domains=') === -1,
    '缺属性的标签应被判为缺 data-exclude-search / data-domains');
  assert.strictEqual(externalLinksIn('<script src="https://cloud.umami.is/script.js"></script>')[0].host,
    'cloud.umami.is', '外链提取器应能取出 cloud.umami.is');
  const otherHost = externalLinksIn('<script src="https://www.googletagmanager.com/gtag/js"></script>')[0].host;
  assert.ok(OTHER_ANALYTICS_HINTS.some(function (h) { return otherHost.indexOf(h) !== -1; }),
    '其它统计域名关键词没命中 ' + otherHost + '，检测逻辑写错了');
});

/* ------------------------------------------------------------------ *
 * 收尾
 * ------------------------------------------------------------------ */

console.log('\n' + (failed === 0 ? '全部通过' : '存在失败') + '：' + passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);
