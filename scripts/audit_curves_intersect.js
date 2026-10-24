#!/usr/bin/env node
/* 多曲线交点题审计：对卡面点名的多曲线交点题跑 strict + lenient 两条路径，只读题库、不写回。
 *
 * 卡 t_1d3fe77a（two-curves-intersect 多曲线画板）。本脚本回答四个问题：
 *   1. 解析：题面能不能解析出恰好 2 条曲线（curvesFromPrompt）
 *   2. 解析：解出的曲线能不能对上题库答案（交点坐标与 item.answer 一致）
 *   3. strict：Labmatch 严格路径挂不挂得上、挂的是哪个画板、intent 对不对
 *   4. lenient：学生点「画图给我看」时同样能挂上（且不跑到单曲线画板上）
 *
 * 离线体检（--offline / 无网关）只跑 1、2 两步与 verifyParams（不走网络），
 * 用来在 CI / 无网环境确认「解析 + 代回校验」这条确定性链路没问题。
 *
 * 用法：
 *   node scripts/audit_curves_intersect.js              # 默认：先离线体检，再跑 strict+lenient
 *   node scripts/audit_curves_intersect.js --offline    # 只做离线体检（不联网）
 *   node scripts/audit_curves_intersect.js --no-cache   # 忽略缓存（重问 LLM）
 *   node scripts/audit_curves_intersect.js --concurrency 3
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const QUESTIONS = require(path.join(ROOT, 'data/questions.json'));
const Funclab = require(path.join(ROOT, 'diagnose/funclab.js'));
const Labmatch = require(path.join(ROOT, 'diagnose/labmatch.js'));

const LAB = 'two-curves-intersect';

/* 卡面点名的 9 道（cnm_208_q1~q4 / cnm_241_q1,q4 / cnm_h172_q1~q3）。
 * 题库里若新增同类题，用 --all 扫全库（按「两条曲线 + 问交点」自动筛）。
 *
 * 注意 cnm_208_q4 与 cnm_241_q4 虽然也提到交点，但**交点不是答案**：
 *   - cnm_208_q4：交点的横坐标为 1 是已知量，要问的是参数 m
 *   - cnm_241_q4：交点坐标题面已给，要问的是不等式解集（选项 B）
 * 这两道属于「必须不挂多曲线画板」的反例，脚本单列一节验证拒绝，不计入通过率。 */
const CARD_IDS = ['cnm_208_q1', 'cnm_208_q2', 'cnm_208_q3', 'cnm_208_q4',
  'cnm_241_q1', 'cnm_241_q4', 'cnm_h172_q1', 'cnm_h172_q2', 'cnm_h172_q3'];
const NEGATIVE_IDS = ['cnm_208_q4', 'cnm_241_q4'];

/* ------------------------------------------------------------ 参数 */

const argv = process.argv.slice(2);
function flag(name, dflt) {
  const i = argv.indexOf('--' + name);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  if (v == null || v.startsWith('--')) return true;
  return v;
}
const OFFLINE = !!flag('offline', false);
const NO_CACHE = !!flag('no-cache', false);
const ALL = !!flag('all', false);
const CONCURRENCY = Math.max(1, Number(flag('concurrency', 3)) || 3);

/* ------------------------------------------------------------ 缓存（两个 key 各存一个文件） */

const STRICT_CACHE_FILE = path.join(os.tmpdir(), 'cnm-labmatch-audit-cache.json');
const LENIENT_CACHE_FILE = path.join(os.tmpdir(), 'cnm-labmatch-lenient-audit-cache.json');

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
if (!OFFLINE && !NO_CACHE) Labmatch.setStore(dualFileStore());

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
function fmtPt(pt) { return '(' + roundPt(pt.x) + ', ' + roundPt(pt.y) + ')'; }
function roundPt(v) { return Math.round(v * 1e6) / 1e6; }
/** 交点集合 → 可比较的字符串（按 x 排序，去掉 -0） */
function ptKey(pts) {
  return pts.map(function (pt) { return roundPt(pt.x) + ',' + roundPt(pt.y); }).sort().join(' | ');
}

/** 从题库答案文字里抠出所有数（「1，2」「(1,2)」「x=1,y=2」都能抠） */
function answerNumbers(answer) {
  const s = String(answer == null ? '' : answer).replace(/[（）()]/g, '');
  const out = [];
  const re = /(-?\d+(?:\.\d+)?)(?:\s*\/\s*(\d+(?:\.\d+)?))?/g;
  let m;
  while ((m = re.exec(s))) {
    const v = m[2] ? Number(m[1]) / Number(m[2]) : Number(m[1]);
    if (isFinite(v)) out.push(v);
  }
  return out;
}

/* ------------------------------------------------------------ 选题目 */

function pickItems() {
  const map = new Map(QUESTIONS.map(function (x) { return [x.id, x]; }));
  if (ALL) {
    return QUESTIONS.filter(function (item) {
      if (!item.topicId) return false;
      return Funclab.curvesFromPrompt(item.prompt).length === 2;
    });
  }
  return CARD_IDS.map(function (id) {
    const it = map.get(id);
    if (!it) {
      console.error('题库里找不到 ' + id + '（题库改过了？请更新脚本里的 CARD_IDS）');
      process.exitCode = 1;
    }
    return it;
  }).filter(Boolean);
}

/* ------------------------------------------------------------ 主流程 */

(async function () {
  const items = pickItems();
  console.log('多曲线交点题：' + items.length + ' 道' + (ALL ? '（--all 全库扫描）' : '（卡面名单）'));
  console.log('');

  /* ---- 第一步：离线体检（解析 + 代回校验 + 答案对账），不联网 ---- */
  console.log('=== 1. 离线体检：解析 / 代回校验 / 与题库答案对账 ===');
  console.log(pad('题目 id', 16) + pad('曲线', 34) + pad('交点', 26) + pad('verifyParams', 14) + '题库答案');
  console.log('-'.repeat(120));

  const offline = [];
  for (const item of items) {
    const cs = Funclab.curvesFromPrompt(item.prompt);
    const pts = Funclab.intersectionsOf(cs);
    const cand = Funclab.labForScene(item.topicId, item.prompt, { itemId: item.id });
    const negative = NEGATIVE_IDS.indexOf(item.id) >= 0;
    let verify = 'no-candidate';
    if (!negative && cand && cand.type === 'curves') {
      const r = Labmatch.verifyParams(item.prompt, { match: LAB, intent: '两条曲线的交点坐标', params: { curves: cand.curves } });
      verify = r.ok ? 'ok' : 'FAIL';
    } else if (negative) {
      /* 反例题：任何参数都不许通过（交点是已知量 / 答案是解集） */
      const r = Labmatch.verifyParams(item.prompt, { match: LAB, intent: '两条曲线的交点坐标', params: { curves: cs } });
      verify = r.ok ? 'FAIL(误挂)' : 'rejected';
    }
    /* 答案对账：题库答案里的数字必须都在交点坐标里（「1，2」这种成对写法的两道都覆盖）。
     * 反例题的答案不是交点（m 的值 / 选项），跳过对账。 */
    const nums = answerNumbers(item.answer);
    const vals = [];
    pts.forEach(function (pt) { vals.push(roundPt(pt.x), roundPt(pt.y)); });
    const hit = nums.filter(function (n) { return vals.indexOf(roundPt(n)) >= 0; }).length;
    const ansOk = negative ? 'n/a' : (nums.length === 0 ? '?' : (hit === nums.length ? 'ok' : 'FAIL'));
    const curveDesc = cs.map(function (c) { return c.type + (c.k != null ? '(k=' + roundPt(c.k) + ')' : ''); }).join(' + ');
    console.log(pad(item.id, 16)
      + pad(clip(curveDesc, 32), 34)
      + pad(pts.length ? pts.map(fmtPt).join(' ') : '(无交点)', 26)
      + pad(verify + '/' + ansOk, 20)
      + clip(item.answer, 20));
    offline.push({
      item: item, cs: cs, pts: pts, cand: cand, negative: negative,
      verifyOk: negative ? verify === 'rejected' : verify === 'ok',
      ansOk: negative || ansOk === 'ok' || ansOk === '?'
    });
  }

  const positives = offline.filter(function (r) { return !r.negative; });
  const negatives = offline.filter(function (r) { return r.negative; });
  const okOffline = positives.filter(function (r) { return r.verifyOk && r.ansOk && r.pts.length > 0; });
  const badOffline = positives.filter(function (r) { return !(r.verifyOk && r.ansOk && r.pts.length > 0); });
  const badNegative = negatives.filter(function (r) { return !r.verifyOk; });
  console.log('');
  console.log('离线体检（交点题）：通过 ' + okOffline.length + ' / ' + positives.length
    + (badOffline.length ? '　未通过：' + badOffline.map(function (r) { return r.item.id; }).join('、') : '　全部通过'));
  console.log('离线体检（反例题，必须拒绝）：通过 ' + (negatives.length - badNegative.length) + ' / ' + negatives.length
    + (badNegative.length ? '　误挂：' + badNegative.map(function (r) { return r.item.id; }).join('、') : '　全部正确拒绝'));
  console.log('');

  /* ---- 第二步 + 第三步：strict / lenient（都要联网） ---- */
  if (OFFLINE) {
    console.log('（--offline：跳过 strict / lenient 联网审计）');
    if (badOffline.length || badNegative.length) process.exitCode = 1;
    return;
  }

  const cands = positives.map(function (r) { return { q: r.item, cand: r.cand }; })
    .filter(function (x) { return x.cand && x.cand.type === 'curves'; });
  console.log('=== 2. strict：Labmatch 严格路径（LLM 选画板 + verifyParams 代回） ===');
  console.log('网关：' + Labmatch.PROXY + '  模型：' + Labmatch.MODEL);
  console.log('缓存：' + (NO_CACHE ? '关闭' : '正常 ' + STRICT_CACHE_FILE + ' / lenient ' + LENIENT_CACHE_FILE));
  console.log('');

  const strictRows = [];
  let done = 0;
  async function worker(queue) {
    while (queue.length) {
      const job = queue.shift();
      const q = job.q;
      let choice = null, err = null;
      try {
        choice = await Labmatch.matchLab(q.prompt, Funclab.capabilitiesFor('curves'), { itemId: q.id, noCache: NO_CACHE });
      } catch (e) { err = e; }
      strictRows.push({ q: q, choice: choice, err: err });
      done++;
      process.stdout.write('\rstrict ' + done + '/' + cands.length + '   ');
    }
  }
  const queue = cands.slice();
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length || 1) }, function () { return worker(queue); }));
  process.stdout.write('\r' + ' '.repeat(30) + '\r');
  strictRows.sort(function (a, b) {
    return cands.findIndex(function (x) { return x.q.id === a.q.id; }) - cands.findIndex(function (x) { return x.q.id === b.q.id; });
  });

  console.log(pad('题目 id', 16) + pad('题面摘录', 38) + pad('画板', 24) + pad('intent', 26) + '结果');
  console.log('-'.repeat(120));
  let sMounted = 0, sRejected = 0, sBad = 0, sFailed = 0;
  for (const r of strictRows) {
    const c = r.choice;
    let labCol = '-', intentCol = '-', resCol = '-';
    if (!c) { sFailed++; labCol = '(调用失败)'; resCol = '网关失败'; if (r.err) labCol = '(err)'; }
    else if (!c.match) { sRejected++; labCol = '(不挂)'; resCol = '拒绝'; }
    else if (!c.verified) { sBad++; labCol = c.match; intentCol = c.intent || '-'; resCol = '参数校验失败'; }
    else { sMounted++; labCol = c.match; intentCol = c.intent; resCol = '挂上'; }
    console.log(pad(r.q.id, 16) + pad(clip(r.q.prompt, 36), 38)
      + pad(clip(labCol, 22), 24) + pad(clip(intentCol, 24), 26) + resCol);
  }
  console.log('');
  console.log('strict：挂上 ' + sMounted + ' / 拒绝 ' + sRejected + ' / 参数校验失败 ' + sBad + ' / 调用失败 ' + sFailed);
  console.log('');

  console.log('=== 3. lenient：学生主动「画图给我看」 ===');
  const lenRows = [];
  done = 0;
  async function lworker(q2) {
    while (q2.length) {
      const job = q2.shift();
      let cfg = null;
      try {
        cfg = await Labmatch.resolve({ prompt: job.q.prompt, lab: job.cand, itemId: job.q.id, lenient: true }, { noCache: NO_CACHE });
      } catch (e) { cfg = null; }
      lenRows.push({ q: job.q, cfg: cfg, failure: Labmatch.lastFailure() });
      done++;
      process.stdout.write('\rlenient ' + done + '/' + cands.length + '   ');
    }
  }
  const lq = cands.slice();
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, lq.length || 1) }, function () { return lworker(lq); }));
  process.stdout.write('\r' + ' '.repeat(30) + '\r');
  lenRows.sort(function (a, b) {
    return cands.findIndex(function (x) { return x.q.id === a.q.id; }) - cands.findIndex(function (x) { return x.q.id === b.q.id; });
  });

  console.log(pad('题目 id', 16) + pad('画板', 24) + pad('intent', 26) + '结果');
  console.log('-'.repeat(100));
  let lMounted = 0, lRejected = 0, lOffline = 0;
  for (const r of lenRows) {
    let labCol = '-', intentCol = '-', resCol = '-';
    if (r.cfg) { lMounted++; labCol = r.cfg.lab; intentCol = r.cfg.intent; resCol = '挂上'; }
    else if (r.failure && r.failure.kind === 'offline') { lOffline++; labCol = '(调用失败)'; resCol = '网关失败'; }
    else { lRejected++; labCol = '(仍不挂)'; resCol = '拒绝'; }
    console.log(pad(r.q.id, 16) + pad(clip(labCol, 22), 24) + pad(clip(intentCol, 24), 26) + resCol);
  }
  console.log('');
  console.log('lenient：挂上 ' + lMounted + ' / 仍拒绝 ' + lRejected + ' / 网关失败 ' + lOffline);
  console.log('');

  /* ---- 判定：离线体检不过 → 非 0；联网全失败（很可能没网关）→ 只警告 ---- */
  if (badOffline.length) {
    console.error('离线体检未通过：' + badOffline.map(function (r) { return r.item.id; }).join('、'));
    process.exitCode = 1;
  }
  if (sFailed + lOffline === (strictRows.length + lenRows.length) && strictRows.length + lenRows.length > 0) {
    console.log('提示：strict 与 lenient 全部调用失败，通常是本地网关（' + Labmatch.PROXY + '）没起来。');
    console.log('      离线体检（解析 / 代回校验 / 答案对账）不受影响。');
  }
})();
