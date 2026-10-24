#!/usr/bin/env node
/* 全库审计：被正常匹配拒绝的题，用 lenient（学生主动要看图）能不能挂上。只读题库，不写回。
 *
 * 卡 t_f80f900e：学生在讲解页点「画图给我看」时走 Labmatch.resolve({lenient:true})。
 * 本脚本回答一个问题：正常匹配说「不挂」的那些题里，lenient 会挂上几道、挂的是什么图、
 * 有没有明显答非所问的（后者要人工复核，判断是不是 lenient 放宽过头）。
 *
 * 用法：
 *   node scripts/audit_funclab_lenient.js                # 全库（候选 ≈ 60 题）
 *   node scripts/audit_funclab_lenient.js --limit 10     # 只跑前 10 道候选
 *   node scripts/audit_funclab_lenient.js --no-cache     # 忽略缓存（重问 LLM）
 *   node scripts/audit_funclab_lenient.js --concurrency 4
 *
 * 筛选逻辑与 scripts/audit_funclab_match.js 完全一致：Funclab.labForScene 有候选的题。
 * 正常匹配的结果直接复用该脚本的缓存文件（同一份「严格判定」，不重复花钱）；
 * lenient 结果写自己的缓存文件，两边互不污染（与 diagnose/labmatch.js 的双缓存约定一致）。
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
/* 正常匹配：复用 audit_funclab_match.js 的缓存（同目录同格式），避免同一题问两遍 */
const STRICT_CACHE_FILE = path.join(os.tmpdir(), 'cnm-labmatch-audit-cache.json');
const LENIENT_CACHE_FILE = path.join(os.tmpdir(), 'cnm-labmatch-lenient-audit-cache.json');

/* ------------------------------------------------------------ 双表文件缓存
 * 一个 store 同时服务两个 key（cnmLabMatch.v1 / cnmLabMatchLenient.v1），各存各的文件：
 * 严格结果与 lenient 结果分开落盘，重跑时不会拿宽松判定当严格判定用。 */

function fileTable(file) {
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
  } catch (e) { /* 没有 / 损坏 → 空表重建 */ }
  return {};
}
function dualFileStore() {
  const files = {};
  files[Labmatch.CACHE_KEY] = STRICT_CACHE_FILE;
  files[Labmatch.LENIENT_CACHE_KEY] = LENIENT_CACHE_FILE;
  const tables = {};
  function fileOf(k) {
    if (!files[k]) files[k] = path.join(os.tmpdir(), 'cnm-labmatch-' + k + '.json');
    return files[k];
  }
  function tableOf(k) {
    if (!tables[k]) tables[k] = fileTable(fileOf(k));
    return tables[k];
  }
  return {
    get: function (k) { return tableOf(k); },
    set: function (k, v) {
      tables[k] = v;
      try { fs.writeFileSync(fileOf(k), JSON.stringify(v, null, 1)); }
      catch (e) { /* 忽略写盘失败 */ }
    },
    remove: function (k) { delete tables[k]; }
  };
}
if (!NO_CACHE) Labmatch.setStore(dualFileStore());

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
  console.log('网关：' + Labmatch.PROXY + '  模型：' + Labmatch.MODEL);
  console.log('缓存：' + (NO_CACHE ? '关闭' : '正常 ' + STRICT_CACHE_FILE + ' / lenient ' + LENIENT_CACHE_FILE));
  console.log('');

  /* 第一步：正常匹配（拿「被拒绝」的那批） */
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
      process.stdout.write('\r正常匹配 ' + done + '/' + list.length + '   ');
    }
  }
  const queue = list.slice();
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length || 1) }, function () { return worker(queue); }));
  process.stdout.write('\r' + ' '.repeat(30) + '\r');

  const byId = new Map(list.map(function (x, i) { return [x.q.id, i]; }));
  rows.sort(function (a, b) { return byId.get(a.q.id) - byId.get(b.q.id); });

  let strictOk = 0, strictRejected = 0, strictBad = 0, strictFailed = 0;
  const rejected = [];
  for (const r of rows) {
    const c = r.choice;
    if (!c) { strictFailed++; continue; }
    if (!c.match) { strictRejected++; rejected.push(r); }
    else if (!c.verified) strictBad++;
    else strictOk++;
  }

  /* 第二步：对「正常被拒」的题跑 lenient */
  const lrows = [];
  done = 0;
  async function lworker(q2) {
    while (q2.length) {
      const job = q2.shift();
      const q = job.q;
      let cfg = null;
      try {
        cfg = await Labmatch.resolve(
          { prompt: q.prompt, lab: job.cand, itemId: q.id, lenient: true },
          { noCache: NO_CACHE }
        );
      } catch (e) { cfg = null; }
      const fail = Labmatch.lastFailure();
      lrows.push({ q: q, cfg: cfg, failure: fail });
      done++;
      process.stdout.write('\rlenient 匹配 ' + done + '/' + rejected.length + '   ');
    }
  }
  const lq = rejected.slice();
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, lq.length || 1) }, function () { return lworker(lq); }));
  process.stdout.write('\r' + ' '.repeat(30) + '\r');

  const rejectedOrder = new Map(rejected.map(function (x, i) { return [x.q.id, i]; }));
  lrows.sort(function (a, b) { return rejectedOrder.get(a.q.id) - rejectedOrder.get(b.q.id); });

  const sum = { mounted: 0, rejectedAgain: 0, offline: 0 };
  console.log(pad('题目 id', 16) + pad('题面摘录', 40) + pad('lenient 画板', 30) + pad('intent', 26) + pad('结果', 10) + 'reason');
  console.log('-'.repeat(150));
  for (const r of lrows) {
    const q = r.q;
    const cfg = r.cfg;
    const f = r.failure;
    let labCol = '-', intentCol = '-', resCol = '-', note = '';
    if (cfg) {
      sum.mounted++;
      labCol = cfg.lab;
      intentCol = cfg.intent;
      resCol = '挂上';
      note = f ? '' : '';
    } else if (f && f.kind === 'offline') {
      sum.offline++;
      labCol = '(调用失败)';
      resCol = '网关失败';
      note = f.reason || '';
    } else {
      sum.rejectedAgain++;
      labCol = '(仍不挂)';
      resCol = '拒绝';
      note = (f && f.reason) || '';
    }
    console.log(pad(q.id, 16) + pad(clip(q.prompt, 38), 40) + pad(clip(labCol, 28), 30)
      + pad(clip(intentCol, 24), 26) + pad(resCol, 10) + clip(note, 60));
  }

  console.log('');
  console.log('正常匹配（候选 ' + list.length + ' 道）：挂图 ' + strictOk
    + ' / 拒绝 ' + strictRejected
    + ' / 参数校验失败 ' + strictBad
    + ' / 调用失败 ' + strictFailed);
  console.log('对其中 ' + rejected.length + ' 道「被拒绝」的题跑 lenient：');
  console.log('  lenient 挂上 ' + sum.mounted + ' 道'
    + ' / 仍拒绝 ' + sum.rejectedAgain + ' 道'
    + ' / 网关失败 ' + sum.offline + ' 道');
  console.log('');
  if (sum.mounted) {
    console.log('lenient 能挂上的题（需要人工看画板是否答非所问）：');
    lrows.filter(function (r) { return !!r.cfg; }).forEach(function (r) {
      console.log('  - ' + r.q.id + '  ' + r.cfg.lab + ' / ' + r.cfg.intent + '  ← ' + clip(r.q.prompt, 50));
    });
  }
})();
