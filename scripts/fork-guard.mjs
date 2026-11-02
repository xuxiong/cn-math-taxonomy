#!/usr/bin/env node
/* fork 上游回流清理：node scripts/fork-guard.mjs
 *
 * 合并上游后跑一次，把「我们故意删掉、又被合并带回来」的东西再清一遍。
 * 只清机械可判的那几类（HTML 元素 / CSS 规则 / 配置值 / 文件），需要人判断的
 * （*.md 文档、scripts/screenshot.js 的断言）不在本脚本范围内 —— 那些交给
 * tests/test_fork_guards.js 变红 + docs/fork-divergences.md 对照人工处理。
 *
 * 清完的东西：
 *   1. 5 个页面里的 <a class="top-banner" …> 整行（上游顶部横幅，外链广告）
 *   2. index.html 里「资源搜索」导航块（a.nav-link.resource-search-btn 到 </a>）
 *   3. assets/site.css 里 .resource-search-btn / .resource-search-ico 相关规则
 *   4. assets/stats-config.js 的 endpoint 置空（本 fork 不上报统计）
 *   5. scripts/deploy-cf.sh（上游自己的 Cloudflare Pages 部署脚本）
 *
 * 幂等：跑第二遍全部打印 clean:。
 * 自检：清完再跑 node tests/test_fork_guards.js，应当 0 failed。
 *
 * 无依赖，纯 node 标准库。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* 与 tests/test_fork_guards.js 顶部 ALLOWED_DOMAINS 保持一致 */
/* cloud.umami.is：5 个页面各一处的匿名统计脚本，口径由 tests/test_fork_guards.js (i) 兜住
 * （docs/fork-divergences.md 第 9 条）。本脚本只放行域名，不判断标签属性。 */
/* 使用手册（飞书文档）：index.html 导航「使用手册」外链，家长/学生查看操作说明。
 * 本 fork 自建的手册托管在飞书文档，不是上游回流的外链推广位（docs/fork-divergences.md 第 10 条）。 */
const ALLOWED_DOMAINS = ['github.com', 'xuxiong.github.io', '127.0.0.1', 'localhost', 'www.w3.org', 'cloud.umami.is',
  'bcntjxmosoi0.feishu.cn'];

/* 已知的推广外链域名：页面上任何指向它们的 <a> 元素都直接删掉（含主机名的子域）。
 * 白名单外、又不在这个名单里的域名不自动删 —— 那需要人判断。 */
const BLOCKED_LINK_DOMAINS = ['pansgo.com'];

const PAGES = [
  'index.html',
  'diagnose/index.html',
  'explore/index.html',
  'children/index.html',
  'children/history.html',
];
const HOME = 'index.html';
const SITE_CSS = 'assets/site.css';
const STATS_CONFIG = 'assets/stats-config.js';
const DEPLOY_SCRIPT = 'scripts/deploy-cf.sh';

const SKIP_DIR_NAMES = new Set(['node_modules', '.git', '.worktrees']);

let fixedCount = 0;
let cleanCount = 0;
const warnings = [];

function abs(rel) {
  return path.join(ROOT, rel);
}

function readIfExists(rel) {
  return fs.existsSync(abs(rel)) ? fs.readFileSync(abs(rel), 'utf8') : null;
}

function write(rel, text) {
  fs.writeFileSync(abs(rel), text);
}

function fixed(rel, what) {
  fixedCount++;
  console.log('fixed: ' + rel + ' ' + what);
}

function clean(rel) {
  cleanCount++;
  console.log('clean: ' + rel);
}

/* ------------------------------------------------------------------ *
 * 1. 顶部横幅：<a class="… top-banner …"> 整行
 * ------------------------------------------------------------------ */

const TOP_BANNER_LINE = /<a\b[^>]*\bclass="[^"]*\btop-banner\b[^"]*"/;

for (const rel of PAGES) {
  const text = readIfExists(rel);
  if (text === null) {
    warnings.push(rel + ' 不存在（页面清单要同步改本脚本与 tests/test_fork_guards.js）');
    continue;
  }
  const kept = [];
  let removed = 0;
  for (const line of text.split('\n')) {
    if (TOP_BANNER_LINE.test(line)) {
      removed++;
      continue;
    }
    kept.push(line);
  }
  if (removed > 0) {
    write(rel, kept.join('\n'));
    fixed(rel, '删除顶部横幅 a.top-banner 整行（外链广告回流，' + removed + ' 行）');
  } else {
    clean(rel);
  }
}

/* ------------------------------------------------------------------ *
 * 2. 「资源搜索」导航块（a.nav-link.resource-search-btn … </a>，可跨行）
 * ------------------------------------------------------------------ */

{
  const text = readIfExists(HOME);
  if (text === null) {
    warnings.push(HOME + ' 不存在');
  } else {
    const navBlock = /\n[ \t]*<a\b[^>]*\bclass="[^"]*\bresource-search-btn\b[^"]*"[^>]*>[\s\S]*?<\/a>/;
    const next = text.replace(navBlock, '');
    if (next !== text) {
      write(HOME, next);
      fixed(HOME, '删除导航「资源搜索」块 a.nav-link.resource-search-btn（外链回流）');
    }
    // 兜底：块被上游改了结构、正则没匹配到，但页面里还有痕迹
    const still = readIfExists(HOME) || '';
    if (/resource-search/.test(still)) {
      warnings.push(HOME + ' 里仍有 resource-search 痕迹，本脚本的块匹配没吃干净，需人工看一下');
    }
  }
}

/* ------------------------------------------------------------------ *
 * 2.5 兜底：页面上任何指向被禁推广域名的 <a> 元素（上游换了结构也能清掉）
 * ------------------------------------------------------------------ */

{
  const hostRe = new RegExp('(?:^|\\.)(?:'
    + BLOCKED_LINK_DOMAINS.map((d) => d.replace(/\./g, '\\.')).join('|') + ')$');
  const linkRe = /(?:\n[ \t]*)?<a\b[^>]*\bhref="(?:https?:)?\/\/([^"/]+)[^"]*"[^>]*>[\s\S]*?<\/a>/g;
  for (const rel of htmlFiles()) {
    const text = readIfExists(rel);
    if (text === null) continue;
    let removed = 0;
    const next = text.replace(linkRe, function (full, host) {
      if (!hostRe.test(String(host).toLowerCase())) return full;
      removed++;
      return '';
    });
    if (removed > 0) {
      write(rel, next);
      fixed(rel, '删除指向被禁推广域名的外链 <a> 元素（' + removed + ' 处，回流）');
    }
  }
}

/* ------------------------------------------------------------------ *
 * 3. assets/site.css 里 .resource-search-* 的规则
 * ------------------------------------------------------------------ */

{
  const text = readIfExists(SITE_CSS);
  if (text === null) {
    warnings.push(SITE_CSS + ' 不存在');
  } else {
    // 选择器行 + { … } 规则块（声明可能跨行），带前导缩进（@media 里也有）
    const rule = /^[ \t]*[^\n{}]*\.resource-search[^\n{}]*\{[\s\S]*?\}[ \t]*\n?/gm;
    const next = text.replace(rule, '');
    if (next !== text) {
      write(SITE_CSS, next);
      fixed(SITE_CSS, '删除 .resource-search-btn / .resource-search-ico 的规则');
    } else {
      clean(SITE_CSS);
    }
    const left = (readIfExists(SITE_CSS) || '')
      .split('\n')
      .map((line, i) => ({ line: i + 1, text: line }))
      .filter((row) => /\.resource-search/.test(row.text));
    for (const row of left) {
      warnings.push(SITE_CSS + ':' + row.line + ' 仍有 .resource-search 相关行，需人工确认：' + row.text.trim());
    }
  }
}

/* ------------------------------------------------------------------ *
 * 4. stats-config.js：endpoint 置空
 * ------------------------------------------------------------------ */

{
  const text = readIfExists(STATS_CONFIG);
  if (text === null) {
    warnings.push(STATS_CONFIG + ' 不存在（统计配置文件被删了？）');
  } else {
    const next = text.replace(/(endpoint\s*:\s*)(['"])[^'"]*\2/, "$1''");
    if (next !== text) {
      write(STATS_CONFIG, next);
      fixed(STATS_CONFIG, 'endpoint 置空（本 fork 不上报统计）');
    } else {
      clean(STATS_CONFIG);
    }
  }
}

/* ------------------------------------------------------------------ *
 * 5. scripts/deploy-cf.sh
 * ------------------------------------------------------------------ */

if (fs.existsSync(abs(DEPLOY_SCRIPT))) {
  fs.unlinkSync(abs(DEPLOY_SCRIPT));
  fixed(DEPLOY_SCRIPT, '删除上游 Cloudflare Pages 部署脚本（本 fork 走 GitHub Pages）');
} else {
  clean(DEPLOY_SCRIPT);
}

/* ------------------------------------------------------------------ *
 * 6. 提醒：页面上还有白名单外的外链域名（本脚本不自动删，要人判断）
 * ------------------------------------------------------------------ */

function htmlFiles() {
  const out = [];
  (function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIR_NAMES.has(ent.name)) continue;
        walk(full);
      } else if (ent.name.endsWith('.html')) {
        out.push(path.relative(ROOT, full).split(path.sep).join('/'));
      }
    }
  })(ROOT);
  return out.sort();
}

for (const rel of htmlFiles()) {
  const rows = fs.readFileSync(abs(rel), 'utf8').split('\n');
  rows.forEach((line, i) => {
    for (const m of line.matchAll(/https?:\/\/[^\s"'<>()]+/g)) {
      let host = '';
      try { host = new URL(m[0]).host.toLowerCase(); } catch (e) { host = m[0]; }
      const ok = ALLOWED_DOMAINS.some((d) => host === d || host === 'www.' + d);
      if (!ok) {
        warnings.push(rel + ':' + (i + 1) + ' 白名单外的外链域名 ' + host
          + '（本脚本不自动删页面里零散的外链，需人判断：要么删，要么加进两处白名单并写注释）');
      }
    }
  });
}

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */

if (warnings.length > 0) {
  console.log('');
  for (const w of warnings) console.log('warn: ' + w);
}

console.log('\n' + fixedCount + ' fixed, ' + cleanCount + ' clean, ' + warnings.length + ' warn');
process.exit(warnings.length === 0 ? 0 : 1);
