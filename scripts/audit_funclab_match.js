#!/usr/bin/env node
/* 全库审计：函数画板该不该挂（LLM 语义匹配 + 确定性参数校验）。只读题库，不写回。
 *
 * 用法：
 *   node scripts/audit_funclab_match.js                # 全库（能挂候选 ≈ 60 题）
 *   node scripts/audit_funclab_match.js --limit 10     # 先跑 10 道
 *   node scripts/audit_funclab_match.js --no-cache     # 忽略缓存（重问 LLM）
 *   node scripts/audit_funclab_match.js --concurrency 4
 *
 * 缓存：默认写 <tmpdir>/cnm-labmatch-audit-cache.json（跨进程复用，避免重复花钱）。
 * 只缓存「参数校验通过」的结果，与浏览器端 localStorage 的约定一致。
 *
 * 输出：
 *   | 题目 id | 题面摘录 | LLM 匹配画板 | intent | 参数校验 | 备注 |
 *   末尾汇总：匹配成功 / LLM 拒绝 / 参数校验失败 / 调用失败
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const QUESTIONS = require(path.join(ROOT, 'data/questions.json'));
const Funclab = require(path.join(ROOT, 'diagnose/funclab.js'));
const Labmatch = require(path.join(ROOT, 'diagnose/labmatch.js'));

/* ------------------------------------------------------------ 参数 */

const argv = process.argv.slice(2);
function flag(name, dflt) {
  const i = argv.indexOf('--' + name);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  if (v == null || v.startsWith('--')) return true;
  return v;
}
const LIMIT = Number(flag('limit', 0)) || 0;
const NO_CACHE = !!flag('no-cache', false);
const CONCURRENCY = Math.max(1, Number(flag('concurrency', 4)) || 4);
const CACHE_FILE = path.join(os.tmpdir(), 'cnm-labmatch-audit-cache.json');

/* ------------------------------------------------------------ 文件缓存（复用 Labmatch 的条目结构） */

function fileStore() {
  let table = {};
  try {
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) table = obj;
  } catch (e) { table = {}; }                        // 没有 / 损坏 → 空表重建
  return {
    get: function (k) { return Object.prototype.hasOwnProperty.call(table, k) ? table[k] : null; },
    set: function (k, v) {
      table[k] = v;
      try { fs.writeFileSync(CACHE_FILE, JSON.stringify(table, null, 1)); } catch (e) { /* 忽略写盘失败 */ }
    },
    remove: function (k) { delete table[k]; }
  };
}
if (!NO_CACHE) Labmatch.setStore(fileStore());

/* ------------------------------------------------------------ 工具 */

function clip(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ');
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}
function pad(s, n) {
  let t = String(s);
  let w = 0;
  for (const ch of t) w += /[\u4e00-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1;
  while (w < n) { t += ' '; w++; }
  return t;
}

/* ------------------------------------------------------------ 主流程 */

(async function () {
  const candidates = [];
  for (const q of QUESTIONS) {
    const cand = Funclab.labForScene(q.topicId, q.prompt, { itemId: q.id });
    if (cand) candidates.push({ q: q, cand: cand });
  }
  const list = LIMIT > 0 ? candidates.slice(0, LIMIT) : candidates;

  console.log('候选题目：' + candidates.length + ' 道' + (LIMIT > 0 ? '（--limit ' + LIMIT + ' → 审计 ' + list.length + ' 道）' : ''));
  console.log('网关：' + Labmatch.PROXY + '  模型：' + Labmatch.MODEL + '  缓存：' + (NO_CACHE ? '关闭' : CACHE_FILE));
  console.log('');

  const rows = [];
  let done = 0;
  async function worker(queue) {
    while (queue.length) {
      const job = queue.shift();
      const q = job.q;
      let choice = null;
      let err = null;
      try {
        choice = await Labmatch.matchLab(q.prompt, Funclab.capabilitiesFor(job.cand.type), {
          itemId: q.id, noCache: NO_CACHE
        });
      } catch (e) { err = e; }
      rows.push({ q: q, cand: job.cand, choice: choice, err: err });
      done++;
      process.stdout.write('\r进度 ' + done + '/' + list.length + '   ');
    }
  }
  const queue = list.slice();
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length || 1) }, function () { return worker(queue); }));
  process.stdout.write('\r' + ' '.repeat(24) + '\r');

  rows.sort(function (a, b) { return list.findIndex(function (x) { return x.q.id === a.q.id; }) - list.findIndex(function (x) { return x.q.id === b.q.id; }); });

  const sum = { ok: 0, rejected: 0, badParams: 0, failed: 0 };
  console.log(pad('题目 id', 16) + pad('题面摘录', 44) + pad('LLM 匹配画板', 30) + pad('intent', 22) + pad('参数校验', 10) + '备注');
  console.log('-'.repeat(150));
  for (const r of rows) {
    const q = r.q;
    const c = r.choice;
    let matchCol = '-', intentCol = '-', verifyCol = '-', note = '';
    if (!c) {
      sum.failed++;
      matchCol = '(调用失败)';
      verifyCol = 'n/a';
      const le = Labmatch.getLastError();
      note = (r.err && (r.err.message || r.err)) || (le && (le.message || le)) || '网关不可达 / 非 200 / JSON 解析失败';
    } else if (!c.match) {
      sum.rejected++;
      matchCol = '(不挂图)';
      verifyCol = 'n/a';
      note = c.reason || '';
    } else if (!c.verified) {
      sum.badParams++;
      matchCol = c.match;
      intentCol = c.intent;
      verifyCol = '失败';
      note = (c.why && c.why.length ? c.why.join('; ') : '参数代回校验未通过');
    } else {
      sum.ok++;
      matchCol = c.match;
      intentCol = c.intent;
      verifyCol = '通过';
      note = (c.from === 'cache' ? '[缓存] ' : '') + (c.reason || '');
    }
    console.log(pad(q.id, 16) + pad(clip(q.prompt, 42), 44) + pad(clip(matchCol, 28), 30)
      + pad(clip(intentCol, 20), 22) + pad(verifyCol, 10) + clip(note, 60));
  }

  console.log('');
  console.log('汇总（候选 ' + list.length + ' 道）：匹配成功 ' + sum.ok
    + ' / LLM 拒绝 ' + sum.rejected
    + ' / 参数校验失败 ' + sum.badParams
    + ' / 调用失败 ' + sum.failed);
  const mounted = sum.ok;
  console.log('实际会挂图的题数：' + mounted + '（其余保持无画板 —— 诚实状态，不回退正则）');
})();
