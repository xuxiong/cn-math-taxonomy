#!/usr/bin/env node
/* O4 卡 C：真机验收（真模型 10 学科 × 2 点，1 次讲解 + 3 轮追问）。
 *
 * 本脚本只做三件事：
 *   1) 按可复现规则采样 20 个知识点；
 *   2) 走本机网关真发 80 次请求（20 讲解 + 60 追问），温度 0，max_tokens 与超时全部取自
 *      diagnose/llm-config.js（不在此文件里另写数字）；
 *   3) 只按两种判定记合规/拒因（checkExplain / checkReply 的 ok 与 reasons[].gate，
 *      以及 parseExplain 能否切出 5 段，切不出也记 G1），把计数写进 docs/o4-live-acceptance.md。
 *
 * 不修改任何既有文件；原始返回落 tmp/o4-live-raw/<topicId>.json（tmp/ 已在 .gitignore）。
 *
 * 卡 D 追加（2026-11-08）：讲解响应命中产品的截断判据（require 进来的
 *    diagnose/topic-explain.js 的 needsRefetch：finish_reason=length 或正文 trim 后为空）时，
 *    用**同样的 messages 与同样的 max_tokens** 原样再发一次，最多 1 次 —— 与页面 generate()
 *    同一条逻辑，脚本不另写一套判定。重发次数计入报告。
 *
 * 报告落点：docs/o4-live-acceptance.md 的 §0–§6 是卡 C 的原始读数（12/20 那一批），
 *    本脚本**不再覆盖**它们；每次运行只维护 §7「卡 D 修后重跑」（重跑则整段替换），
 *    完整报告另写 tmp/o4-live-report.md（不入库）。doc 不存在时（首次运行）才整份写 §0–§7。
 *
 * 采样规则（可复现）：学科顺序取 data/stats.json 的 subjects 键序；每个学科在其
 * data/topics-lite/<subject>.json 里按 id 字典序升序取前两个知识点，正好 10 × 2 = 20 点。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const TX = require(path.join(ROOT, 'diagnose/topic-explain.js'));
const CFG = require(path.join(ROOT, 'diagnose/llm-config.js'));

/* 卡 D：重发判定必须复用产品实现，脚本不另写一套 —— 缺了就立刻停，不许静默不重发。 */
if (typeof TX.needsRefetch !== 'function') {
  throw new Error('diagnose/topic-explain.js 未导出 needsRefetch：卡 D 的截断重发判定必须复用产品实现');
}

/* 卡 E：网关错误体判定同样复用产品实现。 */
if (typeof TX.gatewayErrorOf !== 'function') {
  throw new Error('diagnose/topic-explain.js 未导出 gatewayErrorOf：卡 E 的网关错误体判定必须复用产品实现');
}

const RAW_DIR = path.join(ROOT, 'tmp/o4-live-raw');
const DOC_PATH = path.join(ROOT, 'docs/o4-live-acceptance.md');
const FULL_REPORT_PATH = path.join(ROOT, 'tmp/o4-live-report.md');

/* 卡 E 章节（§9）。卡 C 的 §0–§6 与卡 D 的 §7–§8 是历史读数，脚本不再覆盖。 */
const CARD_D_HEADING = '## 7. 卡 D 修后重跑';
const CARD_E_HEADING = '## 9. 卡 E 修后重跑：网关错误体';

/* 固定追问三类（可复现） */
const FOLLOWUPS = [
  { kind: '概念', q: '为什么是这样？' },
  { kind: '故意问错', q: '我算的是 99，对吧？' },
  { kind: '直接要答案', q: '直接把答案告诉我。' }
];

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

const stats = readJson('data/stats.json');
const topicsAll = readJson('data/topics.json');
const questionsAll = readJson('data/questions.json');
const depsAll = readJson('data/dependencies.json');

const topicById = new Map(topicsAll.map((t) => [t.id, t]));
const questionsByTopic = new Map();
for (const q of questionsAll) {
  if (!q || !q.topicId) continue;
  const arr = questionsByTopic.get(q.topicId);
  if (arr) arr.push(q); else questionsByTopic.set(q.topicId, [q]);
}

/* ---------- 1. 采样 ---------- */

function sample() {
  const out = [];
  for (const subject of Object.keys(stats.subjects)) {
    const lite = readJson(`data/topics-lite/${subject}.json`);
    const ids = lite.map((t) => String(t.id)).sort();
    for (const id of ids.slice(0, 2)) {
      const topic = topicById.get(id);
      if (!topic) throw new Error(`topics.json 里找不到 ${id}`);
      out.push({ subject, topic });
    }
  }
  return out;
}

/* ---------- 2. 请求 ---------- */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* 单次 POST，返回 {http, ok, ms, json, text, error} */
async function postOnce(body, timeoutMs) {
  const t0 = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(CFG.chatUrl(), {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, CFG.authHeaders()),
      body: JSON.stringify(body),
      signal: ac.signal
    });
    const text = await res.text();
    const ms = Date.now() - t0;
    let json = null;
    try { json = JSON.parse(text); } catch (e) { json = null; }
    return { http: res.status, ok: res.ok && !!json, ms, json, text, error: json ? '' : 'not-json' };
  } catch (e) {
    return { http: 0, ok: false, ms: Date.now() - t0, json: null, text: '', error: String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

/* 失败重试 1 次；两次都失败 → null */
async function post(body, timeoutMs, log) {
  const attempts = [];
  for (let i = 1; i <= 2; i++) {
    const r = await postOnce(body, timeoutMs);
    attempts.push({ attempt: i, http: r.http, ms: r.ms, error: r.error || '' });
    if (r.ok) return { r, attempts };
    if (log) log.push(attempts[attempts.length - 1]);
    await sleep(500);
  }
  return { r: null, attempts };
}

function contentOf(json) {
  if (!json || !json.choices || !json.choices[0] || !json.choices[0].message) return '';
  const c = json.choices[0].message.content;
  return typeof c === 'string' ? c : '';
}

function finishOf(json) {
  return (json && json.choices && json.choices[0] && json.choices[0].finish_reason) || '';
}

/* ---------- 3. 判定（只此两种） ---------- */

function judgeExplain(rawContent) {
  const parsed = TX.parseExplain(rawContent);
  if (!parsed || !parsed.segs) {
    return {
      segs: null,
      ok: false,
      reasons: [{ gate: 'G1', why: 'parseExplain 无法切出 5 段：' + ((parsed && parsed.why) || '未知') }]
    };
  }
  const c = TX.checkExplain(parsed.segs);
  return { segs: parsed.segs, ok: c.ok, reasons: c.reasons };
}

function judgeReply(text) {
  const c = TX.checkReply(text);
  return { ok: c.ok, reasons: c.reasons };
}

/* 网关错误体的可读标签（报告用；技术串只出现在报告，不进页面） */
function gwCodeText(gw) {
  if (!gw) return '—';
  if (gw.code === 'no-choices') return 'no-choices';
  if (typeof gw.code === 'number') return 'retCode=' + gw.code;
  return String(gw.code);
}

function gwWhy(gw) {
  if (!gw) return '网关错误体';
  if (gw.code === 'no-choices') return '网关错误体（HTTP 200 但缺 choices）';
  if (typeof gw.code === 'number') return '网关错误体 retCode=' + gw.code;
  return '网关错误体 ' + String(gw.code);
}

/* 两次返回摘要：压平空白、截断、转义表格竖线 */
function gwBrief(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '(空)';
  return s.slice(0, 48).replace(/\|/g, '\\|');
}

/* ---------- 3b. 文档写入：只维护 §9，卡 C/卡 D 的 §0–§8 原样保留 ---------- */

/* 通用的二级标题整段 upsert：
 *  - 已有 heading → 整段替换到下一个 `## ` 之前（重跑幂等，不重复追加）
 *  - 没有 heading → 追加到文末
 * 返回 'replaced' | 'appended'。 */
function upsertSection(docPath, heading, sectionText) {
  const cur = fs.readFileSync(docPath, 'utf8');
  const block = sectionText.replace(/\s*$/, '\n\n');
  const at = cur.indexOf(heading);

  if (at >= 0) {
    const rest = cur.slice(at + heading.length);
    const m = /\n## /.exec(rest);
    const end = m ? at + heading.length + m.index + 1 : cur.length;
    fs.writeFileSync(docPath, cur.slice(0, at) + block + cur.slice(end), 'utf8');
    return 'replaced';
  }

  fs.writeFileSync(docPath, cur.replace(/\s*$/, '\n\n') + block, 'utf8');
  return 'appended';
}

/* ---------- 4. 主流程 ---------- */

function fmtMs(ms) { return `${ms}ms`; }

async function main() {
  const points = sample();
  fs.mkdirSync(RAW_DIR, { recursive: true });

  const runs = [];
  const stdoutLines = [];
  const say = (s) => { stdoutLines.push(s); console.log(s); };

  /* 卡 D：截断重发计数；卡 E：网关错误重发计数（每个点合计最多 1 次重发） */
  let refetches = 0;
  let gatewayRefetches = 0;
  let refetchHttp200 = 0;

  say(`# O4 真机验收 — ${new Date().toISOString()}`);
  say(`gateway=${CFG.chatUrl()}  model=${CFG.model}  temperature=0`);
  say(`max_tokens.explain=${CFG.maxTokens.explain}  max_tokens.tutor=${CFG.maxTokens.tutor}  ` +
      `timeouts.chat=${CFG.timeouts.chat}ms  timeouts.tutor=${CFG.timeouts.tutor}ms`);
  say(`采样 ${points.length} 点（每学科 id 字典序最小的两个）`);

  let seq = 0;
  for (const { subject, topic } of points) {
    seq += 1;
    const inputs = TX.buildInputs({
      topic,
      questions: questionsByTopic.get(topic.id) || [],
      deps: depsAll,
      topics: topicsAll,
      opts: { subject }
    });
    const rec = {
      seq,
      subject,
      topicId: topic.id,
      name: topic.name,
      grade: topic.grade,
      level: inputs.level,
      examples: inputs.examples.length,
      prereqs: inputs.prereqs.length,
      explain: null,
      followups: []
    };

    say(`\n[${String(seq).padStart(2, '0')}/${points.length}] ${subject} ${topic.id} ${topic.name} (grade ${topic.grade})`);

    /* --- 讲解（卡 E + 卡 D：先判网关错误体、再判截断，合计最多 2 次请求） --- */
    const explainBody = {
      model: CFG.model,
      messages: TX.explainMessages(inputs),
      max_tokens: CFG.maxTokens.explain,
      temperature: 0
    };

    let explainReq = await post(explainBody, CFG.timeouts.chat);

    if (!explainReq.r && explainReq.attempts.every((a) => a.http === 0)) {
      /* 连不上网关：直接停，不许伪造 */
      const l = `FATAL 网关不可用：${CFG.chatUrl()} ${JSON.stringify(explainReq.attempts)}`;
      say(l);
      throw new Error(l);
    }

    let explainRefetched = false;
    let refetchKind = '';
    let firstFinish = '';
    let firstEmpty = false;
    let firstNeedsRefetch = false;
    let firstGw = null;
    let secondGw = null;
    let firstRaw = '';
    let secondRaw = '';
    let explainMs = explainReq.r ? explainReq.r.ms : 0;

    if (explainReq.r) {
      firstFinish = finishOf(explainReq.r.json);
      firstEmpty = !contentOf(explainReq.r.json).trim();
      firstGw = TX.gatewayErrorOf(explainReq.r.json);
      firstNeedsRefetch = TX.needsRefetch(explainReq.r.json);
      firstRaw = String(explainReq.r.text || '').trim();

      if (firstGw) {
        /* 与页面一致：先判网关错误体 → 退避 800ms，同 messages / 同 max_tokens 重发 1 次。 */
        explainRefetched = true;
        refetchKind = 'gateway';
        gatewayRefetches += 1;
        say(`  explain   首次命中网关错误体 ${gwCodeText(firstGw)}（${firstRaw.slice(0, 40) || '空'}）→ sleep 800ms 原样重发 1 次`);
        await sleep(800);
        explainReq = await post(explainBody, CFG.timeouts.chat);
        if (explainReq.r) {
          explainMs += explainReq.r.ms;
          if (Number(explainReq.r.http) === 200) refetchHttp200 += 1;
          secondGw = TX.gatewayErrorOf(explainReq.r.json);
          secondRaw = String(explainReq.r.text || '').trim();
        }
      } else if (firstNeedsRefetch) {
        /* 与页面 generate() 一致：同 messages、同 max_tokens，最多重发 1 次。 */
        explainRefetched = true;
        refetchKind = 'refetch';
        refetches += 1;
        say(`  explain   首次 ${firstFinish || '(no finish)'} 正文${firstEmpty ? '空' : '有'} → needsRefetch，原样重发 1 次`);
        explainReq = await post(explainBody, CFG.timeouts.chat);
        if (explainReq.r) {
          explainMs += explainReq.r.ms;
          if (Number(explainReq.r.http) === 200) refetchHttp200 += 1;
          secondGw = TX.gatewayErrorOf(explainReq.r.json);
          secondRaw = String(explainReq.r.text || '').trim();
        }
      }
    }

    if (!explainReq.r) {
      rec.explain = {
        kind: 'explain', http: explainReq.attempts.map((a) => a.http).join('/'),
        ms: explainMs + explainReq.attempts.reduce((s, a) => s + a.ms, 0),
        ok: false, failed: true, refetched: explainRefetched, refetchKind,
        firstFinish, firstEmpty, firstNeedsRefetch,
        firstGw, secondGw, firstRaw, secondRaw,
        reasons: [{ gate: 'request_failed', why: '讲解请求失败（重试 1 次仍失败）' }],
        raw: '', content: '', finish: '', usage: null
      };
      say(`  explain   http=${rec.explain.http}  ${fmtMs(rec.explain.ms)}  attempt=${explainReq.attempts.length}  -> request_failed`);
    } else if (secondGw) {
      /* 第 2 次仍命中网关错误 → 记 gwerror（不是 G1，不写缓存 / history），继续下一点。 */
      const bx = secondGw || firstGw;
      rec.explain = {
        kind: 'gwerror', http: explainReq.r.http, ms: explainMs, attempts: explainReq.attempts.length,
        ok: false, failed: false, refetched: explainRefetched, refetchKind,
        firstFinish, firstEmpty, firstNeedsRefetch,
        firstGw, secondGw, firstRaw, secondRaw,
        reasons: [{ gate: 'gwerror', why: gwWhy(bx) }],
        raw: explainReq.r.text, content: contentOf(explainReq.r.json),
        finish: finishOf(explainReq.r.json),
        usage: explainReq.r.json.usage || null
      };
      say(`  explain   http=${rec.explain.http}  ${fmtMs(rec.explain.ms)}  attempt=${rec.explain.attempts}  重发=1  -> gwerror（${gwCodeText(bx)}）`);
    } else {
      const j = explainReq.r.json;
      const content = contentOf(j);
      const verdict = judgeExplain(content);
      rec.explain = {
        kind: 'explain', http: explainReq.r.http, ms: explainMs, attempts: explainReq.attempts.length,
        ok: verdict.ok, failed: false, refetched: explainRefetched, refetchKind,
        firstFinish, firstEmpty, firstNeedsRefetch,
        firstGw, secondGw, firstRaw, secondRaw,
        reasons: verdict.reasons,
        raw: explainReq.r.text, content,
        finish: finishOf(j),
        usage: j.usage || null
      };
      say(`  explain   http=${rec.explain.http}  ${fmtMs(rec.explain.ms)}  attempt=${rec.explain.attempts}` +
          (explainRefetched ? `  重发=${refetchKind}` : '') +
          `  finish=${rec.explain.finish}  segs=${verdict.segs ? 5 : 0}  ok=${verdict.ok}` +
          (verdict.ok ? '' : `  reasons=${JSON.stringify(verdict.reasons)}`));
    }

    /* 追问锚点：解析成功用 5 段文本；解析失败用原始返回文本（页面路径不允许追问，这里为保证 60 轮仍然发） */
    let anchorSegs;
    let anchorSource;
    if (rec.explain.failed) {
      anchorSegs = { what: '(讲解请求失败，无返回)' };
      anchorSource = 'placeholder';
    } else {
      const parsed = TX.parseExplain(rec.explain.content);
      if (parsed && parsed.segs) {
        anchorSegs = parsed.segs;
        anchorSource = 'segs';
      } else {
        anchorSegs = { what: String(rec.explain.content || '').trim() || '(讲解无内容)' };
        anchorSource = 'raw-text';
      }
    }
    rec.anchorSource = anchorSource;

    /* --- 3 轮追问 --- */
    const history = [];
    for (const fu of FOLLOWUPS) {
      const messages = TX.chatMessages(inputs, anchorSegs, history, fu.q);
      const req = await post({
        model: CFG.model,
        messages,
        max_tokens: CFG.maxTokens.tutor,
        temperature: 0
      }, CFG.timeouts.tutor);

      if (!req.r) {
        const ms = req.attempts.reduce((s, a) => s + a.ms, 0);
        rec.followups.push({
          kind: fu.kind, q: fu.q, http: req.attempts.map((a) => a.http).join('/'), ms,
          ok: false, failed: true, reasons: [{ gate: 'request_failed', why: '追问请求失败（重试 1 次仍失败）' }],
          text: '', finish: '', usage: null
        });
        say(`  followup#${rec.followups.length} ${fu.kind}  http=${req.attempts.map((a) => a.http).join('/')}  ${fmtMs(ms)}  attempt=${req.attempts.length}  -> request_failed`);
        continue;
      }

      const j = req.r.json;
      const text = contentOf(j).trim();
      const verdict = judgeReply(text);
      rec.followups.push({
        kind: fu.kind, q: fu.q, http: req.r.http, ms: req.r.ms, attempts: req.attempts.length,
        ok: verdict.ok, failed: false, reasons: verdict.reasons,
        text, finish: (j.choices && j.choices[0] && j.choices[0].finish_reason) || '',
        usage: j.usage || null
      });
      /* 与页面一致：不合规的回答不进 history */
      if (verdict.ok) history.push({ q: fu.q, a: text });
      say(`  followup#${rec.followups.length} ${fu.kind}  http=${req.r.http}  ${fmtMs(req.r.ms)}  attempt=${req.attempts.length}  ` +
          `finish=${(j.choices && j.choices[0] && j.choices[0].finish_reason) || ''}  len=${text.length}  ok=${verdict.ok}` +
          (verdict.ok ? '' : `  reasons=${JSON.stringify(verdict.reasons)}`));
    }

    runs.push(rec);
    fs.writeFileSync(path.join(RAW_DIR, `${topic.id}.json`), JSON.stringify(rec, null, 1), 'utf8');
  }

  /* ---------- 5. 汇总 ---------- */

  const explainItems = runs.map((r) => r.explain);
  const followItems = runs.flatMap((r) => r.followups);

  const explainOk = explainItems.filter((x) => x.ok).length;
  const followOk = followItems.filter((x) => x.ok).length;

  const reasonCount = new Map();
  for (const [scope, items] of [['讲解', explainItems], ['追问', followItems]]) {
    for (const it of items) {
      for (const rs of (it.reasons || [])) {
        const key = `${rs.gate}\u0000${rs.why}`;
        const cur = reasonCount.get(key) || { gate: rs.gate, why: rs.why, n: 0, scopes: new Set() };
        cur.n += 1;
        cur.scopes.add(scope);
        reasonCount.set(key, cur);
      }
    }
  }

  const http200 = explainItems.concat(followItems).filter((x) => Number(String(x.http).split('/')[0]) === 200).length + refetchHttp200;
  const totalRequests = explainItems.length + followItems.length + refetches + gatewayRefetches;
  const retried = explainItems.concat(followItems).filter((x) => (x.attempts || 1) > 1).length;

  /* 卡 D：截断与重发（判据一律是 product 的 needsRefetch 结果，脚本不自己判） */
  const explainFirstNeedsRefetch = explainItems.filter((x) => x.firstNeedsRefetch === true).length;
  const explainRefetchPoints = explainItems.filter((x) => x.refetched === true && x.refetchKind === 'refetch');
  const explainRefetchStillBad = explainRefetchPoints.filter((x) => x.failed ||
    x.finish === 'length' || !String(x.content || '').trim()).length;
  const explainRefetchRecovered = explainRefetchPoints.length - explainRefetchStillBad;

  /* 卡 E：网关错误体 vs G1（两者互不重复计入） */
  const gwFirstPoints = explainItems.filter((x) => x.firstGw);
  const gwRetryPoints = explainItems.filter((x) => x.refetchKind === 'gateway');
  const gwStillPoints = gwRetryPoints.filter((x) => x.secondGw);
  const gwRecovered = gwRetryPoints.filter((x) => !x.secondGw && !x.failed).length;
  const gwerrorPoints = explainItems.filter((x) => x.kind === 'gwerror');
  const g1Points = explainItems.filter((x) => !x.ok && (x.reasons || []).some((r) => r.gate === 'G1'));
  const gwCodeCounts = new Map();
  for (const it of gwFirstPoints) {
    const c = gwCodeText(it.firstGw);
    gwCodeCounts.set(c, (gwCodeCounts.get(c) || 0) + 1);
  }
  const gwCodeSummary = [...gwCodeCounts.entries()].map(([c, n]) => `${c} × ${n}`).join('；');

  const withSegs = runs.filter((r) => r.anchorSource === 'segs').length;
  const anchorRaw = runs.filter((r) => r.anchorSource === 'raw-text').length;
  const anchorPlaceholder = runs.filter((r) => r.anchorSource === 'placeholder').length;

  const demoSegs = runs.map((r) => {
    if (r.explain.failed) return null;
    const p = TX.parseExplain(r.explain.content);
    return p && p.segs ? p.segs : null;
  }).filter(Boolean);

  const demoQuestion = demoSegs.filter((s) => /[？?]/.test(String(s.demo))).length;
  const demoAnswerLine = demoSegs.filter((s) => String(s.demo).split('\n').some((l) => l.trim().indexOf('答案') === 0)).length;

  const wrongRounds = followItems.filter((f) => f.kind === '故意问错');
  const wrongWith99 = wrongRounds.filter((f) => /\b99\b|99/.test(f.text || '')).length;

  const mean = (arr) => (arr.length ? Math.round(arr.reduce((s, x) => s + x.ms, 0) / arr.length) : 0);
  const explainMean = mean(explainItems.filter((x) => !x.failed));
  const followMean = mean(followItems.filter((x) => !x.failed));
  const explainTotalMs = explainItems.reduce((s, x) => s + x.ms, 0);
  const followTotalMs = followItems.reduce((s, x) => s + x.ms, 0);

  /* 可数事实（不进判定，只用于报告 §4/§5） */
  const explainFinishLength = explainItems.filter((x) => !x.failed && x.finish === 'length').length;
  const explainEmpty = explainItems.filter((x) => !x.failed && !String(x.content || '').trim()).length;
  const explainTruncated = explainItems.filter((x) => !x.failed && x.finish === 'length' && String(x.content || '').trim()).length;
  const explainLengthAtCap = explainItems.filter((x) => !x.failed && x.finish === 'length' &&
    x.usage && Number(x.usage.completion_tokens) === CFG.maxTokens.explain).length;
  const followFinishLength = followItems.filter((x) => !x.failed && x.finish === 'length').length;
  const followEmpty = followItems.filter((x) => !x.failed && !String(x.text || '').trim()).length;

  say('\n=== 汇总 ===');
  say(`请求次数=${totalRequests}（重试过的请求 ${retried} 次）  HTTP 200=${http200}`);
  say(`讲解合规 ${explainOk}/${explainItems.length}`);
  say(`追问合规 ${followOk}/${followItems.length}`);
  say('拒因计数：');
  if (!reasonCount.size) say('  （无）');
  for (const row of [...reasonCount.values()].sort((a, b) => b.n - a.n)) {
    say(`  ${row.gate} ${row.why} × ${row.n}`);
  }
  say(`demo 段出现问句 ${demoQuestion}/${demoSegs.length}（分母=成功切出 5 段的讲解数）`);
  say(`demo 段出现「答案：」开头行 ${demoAnswerLine}/${demoSegs.length}`);
  say(`故意问错轮出现「99」 ${wrongWith99}/${wrongRounds.length}`);
  say(`讲解 finish_reason=length ${explainFinishLength}/${explainItems.length}（其中内容为空串 ${explainEmpty}、被截断 ${explainTruncated}、completion_tokens 等于 maxTokens.explain=${CFG.maxTokens.explain} 的 ${explainLengthAtCap}）`);
  say(`追问 finish_reason=length ${followFinishLength}/${followItems.length}（内容为空串 ${followEmpty}）`);
  say(`截断重发 ${refetches} 次（首答命中 needsRefetch ${explainFirstNeedsRefetch}/${explainItems.length}，重发后恢复 ${explainRefetchRecovered}、仍截断 ${explainRefetchStillBad}）`);
  say(`网关错误体 首答命中 ${gwFirstPoints.length}/${explainItems.length}（码分布 ${gwCodeSummary || '（无）'}），网关错误重发 ${gatewayRefetches} 次（恢复 ${gwRecovered}、仍为网关错误 ${gwStillPoints.length}）`);
  say(`gwerror ${gwerrorPoints.length} 点 / G1 结构拒 ${g1Points.length} 点（互不重复计入）`);
  say('（说明：needsRefetch 对缺 choices 返回 false 是设计 —— 它是截断判据；网关错误体由 gatewayErrorOf 单独识别。）');
  say(`平均耗时：讲解 ${explainMean}ms（${explainItems.length - explainItems.filter((x) => x.failed).length} 次成功请求，合计 ${explainTotalMs}ms）；` +
      `追问 ${followMean}ms（${followItems.length - followItems.filter((x) => x.failed).length} 次成功请求，合计 ${followTotalMs}ms）`);
  say(`追问锚点来源：5 段=${withSegs} 点 / 原始返回文本=${anchorRaw} 点 / 占位=${anchorPlaceholder} 点`);

  /* ---------- 6. 报告 ---------- */

  const md = [];
  md.push('# O4 真机验收：知识点讲解 + 追问（真模型 10 学科 × 2 点）');
  md.push('');
  md.push(`运行时间：${new Date().toISOString()}`);
  md.push('');
  md.push('## 0. 运行参数');
  md.push('');
  md.push(`- 网关：${CFG.chatUrl()}`);
  md.push(`- model：\`${CFG.model}\`，temperature：0`);
  md.push(`- max_tokens：讲解 ${CFG.maxTokens.explain}（llm-config.maxTokens.explain）/ 追问 ${CFG.maxTokens.tutor}（llm-config.maxTokens.tutor）`);
  md.push(`- 超时：讲解 ${CFG.timeouts.chat}ms（llm-config.timeouts.chat）/ 追问 ${CFG.timeouts.tutor}ms（llm-config.timeouts.tutor）`);
  md.push('- 失败重试：1 次，仍失败记 `request_failed` 并继续下一点');
  md.push(`- 截断重发：${refetches} 次（判据 = \`diagnose/topic-explain.js\` 的 \`needsRefetch\`：\`finish_reason=length\` 或正文 trim 后为空；同一 messages、同一 max_tokens，每点最多 1 次）`);
  md.push(`- 网关错误重发：${gatewayRefetches} 次（判据 = \`diagnose/topic-explain.js\` 的 \`gatewayErrorOf\`：\`retCode≠0\` / \`error\` / 无 \`choices\` 且无 \`message\`；退避 800ms，同一 messages、同一 max_tokens；与截断重发互斥，合计每点最多 1 次重发）`);
  md.push(`- 请求次数：${totalRequests}（讲解 ${explainItems.length} + 追问 ${followItems.length} + 截断重发 ${refetches} + 网关错误重发 ${gatewayRefetches}；其中 HTTP 失败重试过的请求 ${retried} 次），HTTP 200：${http200}`);
  md.push('- 采样规则：学科顺序取 `data/stats.json` 的 `subjects` 键序；每学科在 `data/topics-lite/<subject>.json` 中按 **id 字典序升序取前两个**（可复现）');
  md.push('');
  md.push('## 1. 采样表（20 点）');
  md.push('');
  md.push('| # | 学科 | topicId | 名称 | grade |');
  md.push('|---|---|---|---|---|');
  for (const r of runs) {
    md.push(`| ${r.seq} | ${r.subject} | ${r.topicId} | ${r.name} | ${r.grade} |`);
  }
  md.push('');
  md.push('## 2. 合规率');
  md.push('');
  md.push(`- 讲解：合规 **${explainOk}/${explainItems.length}**`);
  md.push(`- 追问：合规 **${followOk}/${followItems.length}**（${runs.length} 点 × 3 轮）`);
  md.push('');
  md.push('判定口径只有两种：`checkExplain(segs)` / `checkReply(text)` 的 `ok` 与 `reasons[].gate`；`parseExplain` 切不出 5 段也记 G1。');
  md.push('');
  md.push('## 3. 拒因计数（gate × why）');
  md.push('');
  if (reasonCount.size) {
    md.push('| gate | why | 出现次数 | 出现在 |');
    md.push('|---|---|---|---|');
    for (const row of [...reasonCount.values()].sort((a, b) => b.n - a.n || a.gate.localeCompare(b.gate))) {
      md.push(`| ${row.gate} | ${row.why} | ${row.n} | ${[...row.scopes].join('、')} |`);
    }
  } else {
    md.push('（无拒因）');
  }
  md.push('');
  md.push('## 4. 结构性观察（只记计数）');
  md.push('');
  md.push('| 项 | 计数 |');
  md.push('|---|---|');
  md.push(`| demo 段出现问句（？/?） | ${demoQuestion}/${demoSegs.length}（分母=成功切出 5 段的讲解数，共 ${demoSegs.length}） |`);
  md.push(`| demo 段出现「答案：」开头行 | ${demoAnswerLine}/${demoSegs.length} |`);
  md.push(`| 追问（故意问错类，共 ${wrongRounds.length} 轮）出现「99」 | ${wrongWith99}/${wrongRounds.length} |`);
  md.push(`| 讲解平均耗时 | ${explainMean}ms（${explainItems.length - explainItems.filter((x) => x.failed).length} 次成功请求，合计 ${explainTotalMs}ms） |`);
  md.push(`| 追问平均耗时 | ${followMean}ms（${followItems.length - followItems.filter((x) => x.failed).length} 次成功请求，合计 ${followTotalMs}ms） |`);
  md.push(`| 追问锚点来源 | 5 段 ${withSegs} 点 / 原始返回文本 ${anchorRaw} 点 / 占位 ${anchorPlaceholder} 点 |`);
  md.push(`| 讲解 finish_reason=length | ${explainFinishLength}/${explainItems.length} |`);
  md.push(`| 讲解响应内容为空串 | ${explainEmpty}/${explainItems.length} |`);
  md.push(`| 讲解首答命中 needsRefetch | ${explainFirstNeedsRefetch}/${explainItems.length} |`);
  md.push(`| 讲解截断重发 | ${refetches} 次（重发后恢复 ${explainRefetchRecovered}、仍截断 ${explainRefetchStillBad}） |`);
  md.push(`| 追问 finish_reason=length | ${followFinishLength}/${followItems.length} |`);
  md.push(`| 追问响应内容为空串 | ${followEmpty}/${followItems.length} |`);
  md.push('');
  md.push('## 5. 缺陷记录（只记录，不修；修另开卡）');
  md.push('');
  md.push(`- 讲解响应 \`finish_reason=length\`：${explainFinishLength}/${explainItems.length}，其中 \`completion_tokens\` 等于 \`maxTokens.explain\`（${CFG.maxTokens.explain}）的 ${explainLengthAtCap}/${explainFinishLength}。`);
  md.push(`- 上述 ${explainFinishLength} 条里：内容为空串 ${explainEmpty} 条，内容被截断（\`parseExplain\` 报缺 what/why/how/demo/trap）${explainTruncated} 条。`);
  md.push(`- 追问响应 \`finish_reason=length\`：${followFinishLength}/${followItems.length}；内容为空串：${followEmpty}/${followItems.length}。`);
  md.push(`- 逐条原始返回：\`tmp/o4-live-raw/<topicId>.json\`（字段 \`explain.finish\` / \`explain.usage\` / \`explain.content\`）。`);
  md.push('');
  md.push('## 6. 不可测声明');
  md.push('');
  md.push('本次验收只验证**格式是否成形**与**文本卫生**；概念正确性、可读性、是否适合该年级**未经验证**。');
  md.push('');
  md.push('## 8. 原始返回');
  md.push('');
  md.push(`- 目录：\`tmp/o4-live-raw/\`（${runs.length} 个文件，文件名 \`<topicId>.json\`，含每条请求的 messages 判定结果、HTTP 码、耗时、模型原始返回文本）`);
  md.push('- `tmp/` 在 `.gitignore` 内，不入库。');
  md.push('');

  fs.mkdirSync(path.dirname(DOC_PATH), { recursive: true });
  fs.mkdirSync(path.dirname(FULL_REPORT_PATH), { recursive: true });

  const fullReport = md.join('\n') + '\n';
  fs.writeFileSync(FULL_REPORT_PATH, fullReport, 'utf8');

  /* ---------- 7. 卡 D 一节（只维护本节，卡 C 的 §0–§6 原样不动） ---------- */

  /* 卡 C 原始读数：抄自本文件 §2 / §4（2026-11-08 提交 401ca72 那一批），不许改。 */
  const CARD_C = {
    explainOk: 12, explainN: 20, followOk: 60, followN: 60,
    finishLength: 8, empty: 5, explainMean: 9177, followMean: 3947
  };

  const d = [];
  d.push(CARD_D_HEADING);
  d.push('');
  d.push(`运行时间：${new Date().toISOString()}`);
  d.push('');
  d.push('本节是**卡 D**（`explain` 预算 2048→4096 + 截断自动重发一次）改完之后，用**同一个脚本、同一套采样规则**的重跑读数。');
  d.push('§0–§6 是卡 C 的原始读数（讲解 12/20 那一批），原样保留、未被本节覆盖；两节数字可直接对照。');
  d.push('');
  d.push('### 7.1 本次运行参数');
  d.push('');
  d.push(`- 网关：${CFG.chatUrl()}`);
  d.push(`- model：\`${CFG.model}\`，temperature：0`);
  d.push(`- max_tokens：讲解 **${CFG.maxTokens.explain}**（卡 C 为 2048，见 §0）/ 追问 ${CFG.maxTokens.tutor}（\`tutor\` 未动）`);
  d.push(`- 超时：讲解 ${CFG.timeouts.chat}ms / 追问 ${CFG.timeouts.tutor}ms（未动）`);
  d.push(`- 截断重发：**${refetches} 次**（判据 = \`diagnose/topic-explain.js\` 的 \`needsRefetch\`：\`finish_reason=length\` 或正文 trim 后为空；同一 messages、同一 max_tokens，每点最多重发 1 次）`);
  d.push(`- 请求次数：${totalRequests}（讲解 ${explainItems.length} + 追问 ${followItems.length} + 截断重发 ${refetches}），HTTP 200：${http200}；HTTP 失败重试：${retried} 次`);
  d.push('');
  d.push('### 7.2 合规率（对照卡 C §2）');
  d.push('');
  d.push('| 项 | 卡 C | 卡 D 修后 | 变化 |');
  d.push('|---|---|---|---|');
  d.push(`| 讲解合规 | ${CARD_C.explainOk}/${CARD_C.explainN} | **${explainOk}/${explainItems.length}** | ${explainOk - CARD_C.explainOk >= 0 ? '+' : ''}${explainOk - CARD_C.explainOk} |`);
  d.push(`| 追问合规 | ${CARD_C.followOk}/${CARD_C.followN} | **${followOk}/${followItems.length}** | ${followOk - CARD_C.followOk >= 0 ? '+' : ''}${followOk - CARD_C.followOk} |`);
  d.push('');
  d.push('判定口径与卡 C 完全相同：`checkExplain(segs)` / `checkReply(text)` 的 `ok` 与 `reasons[].gate`；`parseExplain` 切不出 5 段也记 G1。');
  d.push('');
  d.push('### 7.3 拒因计数（gate × why）');
  d.push('');
  if (reasonCount.size) {
    d.push('| gate | why | 出现次数 | 出现在 |');
    d.push('|---|---|---|---|');
    for (const row of [...reasonCount.values()].sort((a, b) => b.n - a.n || a.gate.localeCompare(b.gate))) {
      d.push(`| ${row.gate} | ${row.why} | ${row.n} | ${[...row.scopes].join('、')} |`);
    }
  } else {
    d.push('（无拒因：80 次请求全部通过各自闸门）');
  }
  d.push('');
  d.push('### 7.4 截断与耗时（对照卡 C §4 / §5）');
  d.push('');
  d.push('| 项 | 卡 C | 卡 D 修后 |');
  d.push('|---|---|---|');
  d.push(`| 讲解 \`finish_reason=length\` | ${CARD_C.finishLength}/${CARD_C.explainN} | ${explainFinishLength}/${explainItems.length} |`);
  d.push(`| 讲解响应内容为空串 | ${CARD_C.empty}/${CARD_C.explainN} | ${explainEmpty}/${explainItems.length} |`);
  d.push(`| 讲解 \`completion_tokens\` 撞满 \`maxTokens.explain\` | 8/8（length 条全撞满，上限 2048） | ${explainLengthAtCap}/${explainFinishLength}（上限 ${CFG.maxTokens.explain}${explainFinishLength ? '' : '；本批没有 length 条'}） |`);
  d.push(`| 讲解首答命中 \`needsRefetch\` | —（该机制卡 D 才有） | ${explainFirstNeedsRefetch}/${explainItems.length} |`);
  d.push(`| 截断重发 | — | ${refetches} 次 |`);
  d.push(`| 重发后恢复 / 重发后仍截断 | — | ${explainRefetchRecovered} / ${explainRefetchStillBad} |`);
  d.push(`| 讲解平均耗时 | ${CARD_C.explainMean}ms（单次响应） | ${explainMean}ms（含重发，共 ${explainItems.length - explainItems.filter((x) => x.failed).length} 点） |`);
  d.push(`| 追问平均耗时 | ${CARD_C.followMean}ms | ${followMean}ms（共 ${followItems.length - followItems.filter((x) => x.failed).length} 次） |`);
  d.push('');
  d.push('耗时口径：卡 C 记单次响应；卡 D 的讲解耗时把重发那一次也算进去（重发本身要等一次完整生成），因此两者不是严格同口径，重发次数见上一行。');
  d.push('');
  d.push('### 7.5 重发过的点');
  d.push('');
  if (explainRefetchPoints.length) {
    d.push('| # | 学科 | topicId | 首答 finish | 首答正文 | 重发后 finish | 重发后合规 |');
    d.push('|---|---|---|---|---|---|---|');
    for (const r of runs) {
      if (!r.explain || r.explain.refetched !== true) continue;
      d.push(`| ${r.seq} | ${r.subject} | ${r.topicId} | ${r.explain.firstFinish || '(空)'} | ${r.explain.firstEmpty ? '空' : '有（截断）'} | ${r.explain.finish || '(失败)'} | ${r.explain.ok ? '合规' : '不合规'} |`);
    }
  } else {
    d.push('本次没有任何点触发重发——20 条讲解首答全部 `finish_reason=stop` 且正文非空。');
  }
  d.push('');
  d.push('### 7.6 仍不合规的点（如实记录，不修饰）');
  d.push('');
  const explainBadPoints = runs.filter((r) => r.explain && !r.explain.ok);
  if (explainBadPoints.length) {
    d.push('| # | 学科 | topicId | http | attempts | finish | 首答需重发 | 原始返回片段 | 拒因 |');
    d.push('|---|---|---|---|---|---|---|---|---|');
    for (const r of explainBadPoints) {
      const rawHead = String(r.explain.raw || '').replace(/\s+/g, ' ').slice(0, 60).replace(/\|/g, '\\|');
      d.push(`| ${r.seq} | ${r.subject} | ${r.topicId} | ${r.explain.http} | ${r.explain.attempts || 1} | ${r.explain.finish || '(空)'} | ${r.explain.firstNeedsRefetch ? '是' : '否'} | \`${rawHead}\` | ${r.explain.reasons.map((x) => x.gate + ' ' + x.why).join('；')} |`);
    }
    d.push('');
    d.push('判读：`finish_reason` 为空、原始返回是网关自己的错误体（不是模型输出）时，**不属于**卡 D 的截断判据 —— `needsRefetch` 对缺 `choices` 的响应明确返回 false，交由既有的「网关失败 / 格式没成形」分支，因此不重发，如实记 G1。');
  } else {
    d.push('（无：20 条讲解全部合规）');
  }
  d.push('');
  d.push('### 7.7 原始返回');
  d.push('');
  d.push(`- 逐条：\`tmp/o4-live-raw/<topicId>.json\`（${runs.length} 个文件，新增字段 \`explain.firstFinish\` / \`explain.firstEmpty\` / \`explain.firstNeedsRefetch\` / \`explain.refetched\`）`);
  d.push('- `tmp/` 在 `.gitignore` 内，不入库。');
  d.push('');

  /* ---------- 8. 卡 E 一节（只维护 §9；§0–§8 原样保留） ---------- */

  const e = [];
  e.push(CARD_E_HEADING);
  e.push('');
  e.push(`运行时间：${new Date().toISOString()}`);
  e.push('');
  e.push('本节是**卡 E**（网关错误体单独识别 + 退避 800ms 重发一次）改完之后，用**同一个脚本、同一套采样规则**的重跑读数。');
  e.push('§0–§8 是卡 C / 卡 D 的历史读数，原样保留、未被本节覆盖。');
  e.push('');
  e.push('### 9.1 本次运行参数');
  e.push('');
  e.push(`- 网关：${CFG.chatUrl()}`);
  e.push(`- model：\`${CFG.model}\`，temperature：0`);
  e.push(`- max_tokens：讲解 ${CFG.maxTokens.explain} / 追问 ${CFG.maxTokens.tutor}`);
  e.push(`- 超时：讲解 ${CFG.timeouts.chat}ms / 追问 ${CFG.timeouts.tutor}ms`);
  e.push(`- 请求总数：${totalRequests}（讲解 ${explainItems.length} + 追问 ${followItems.length} + 截断重发 ${refetches} + 网关错误重发 ${gatewayRefetches}）`);
  e.push(`- 合规率：讲解 **${explainOk}/${explainItems.length}**；追问 **${followOk}/${followItems.length}**`);
  e.push('');
  e.push('### 9.2 网关错误体 vs G1 结构拒（分开计数，互不重复）');
  e.push('');
  e.push('| 项 | 计数 |');
  e.push('|---|---|');
  e.push(`| 讲解首答命中网关错误体 | ${gwFirstPoints.length}/${explainItems.length} |`);
  e.push(`| 网关错误体码分布 | ${gwCodeSummary || '（无）'} |`);
  e.push(`| 网关错误重发次数 | ${gatewayRefetches} |`);
  e.push(`| 重发后恢复（不再是网关错误） | ${gwRecovered} |`);
  e.push(`| 重发后仍为网关错误 | ${gwStillPoints.length} |`);
  e.push(`| \`gwerror\` 点数 | ${gwerrorPoints.length} |`);
  e.push(`| G1 结构拒点数 | ${g1Points.length} |`);
  e.push(`| gwerror + G1（两者之和，已互斥不重复） | ${gwerrorPoints.length + g1Points.length} |`);
  e.push('');
  e.push('### 9.3 逐条网关错误点');
  e.push('');
  const gwPoints = runs.filter((r) => r.explain && (r.explain.firstGw || r.explain.secondGw));
  if (gwPoints.length) {
    e.push('| # | 学科 | topicId | 首次返回摘要 | 重发后摘要 | 码 |');
    e.push('|---|---|---|---|---|---|');
    for (const r of gwPoints) {
      const x = r.explain;
      const code = x.secondGw || x.firstGw;
      e.push(`| ${r.seq} | ${r.subject} | ${r.topicId} | \`${gwBrief(x.firstRaw)}\` | \`${gwBrief(x.secondRaw)}\` | ${gwCodeText(code)} |`);
    }
  } else {
    e.push('（本轮没有网关错误体）');
  }
  e.push('');
  e.push('### 9.4 如实申报');
  e.push('');
  e.push(`本轮网关错误体 ${gwFirstPoints.length} 次（首答命中；其中重发后仍为网关错误 ${gwStillPoints.length} 次，重发后恢复 ${gwRecovered} 次）。`);
  e.push('');
  e.push('`needsRefetch` 对缺 `choices` 返回 `false` 是设计（它是截断判据），网关错误体由 `gatewayErrorOf` 单独识别。');
  e.push('');

  const cardEText = e.join('\n');
  let docsMode;
  let prev = '';
  try { prev = fs.readFileSync(DOC_PATH, 'utf8'); } catch (e2) { prev = ''; }

  if (!prev.trim()) {
    /* 首次运行：先落 §0–§8（卡 C 口径的完整报告），再追加 §9。 */
    fs.writeFileSync(DOC_PATH, fullReport, 'utf8');
  }
  docsMode = upsertSection(DOC_PATH, CARD_E_HEADING, cardEText);

  const DOCS_MSG = {
    replaced: '§9 已整段替换（§0–§8 未动）',
    appended: '§9 已追加到文末（§0–§8 未动）'
  };
  const docsMsg = DOCS_MSG[docsMode] || docsMode;
  say(`\n报告已写入 ${path.relative(ROOT, DOC_PATH)}：${docsMsg}`);
  say(`完整报告（含卡 C 口径的 §0–§8）已写入 ${path.relative(ROOT, FULL_REPORT_PATH)}（临时，不入库）`);
  say(`原始返回已写入 ${path.relative(ROOT, RAW_DIR)}/（${runs.length} 个文件）`);

  fs.writeFileSync(path.join(ROOT, 'tmp/o4-live-stdout.log'), stdoutLines.join('\n') + '\n', 'utf8');

  if (http200 === 0) {
    console.error('FATAL 全部请求都不是 HTTP 200，判为网关不可用');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('FATAL', e && e.stack || e);
  process.exit(1);
});
