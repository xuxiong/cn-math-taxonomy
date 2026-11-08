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

const RAW_DIR = path.join(ROOT, 'tmp/o4-live-raw');
const DOC_PATH = path.join(ROOT, 'docs/o4-live-acceptance.md');

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

/* ---------- 4. 主流程 ---------- */

function fmtMs(ms) { return `${ms}ms`; }

async function main() {
  const points = sample();
  fs.mkdirSync(RAW_DIR, { recursive: true });

  const runs = [];
  const stdoutLines = [];
  const say = (s) => { stdoutLines.push(s); console.log(s); };

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

    /* --- 讲解 --- */
    const explainReq = await post({
      model: CFG.model,
      messages: TX.explainMessages(inputs),
      max_tokens: CFG.maxTokens.explain,
      temperature: 0
    }, CFG.timeouts.chat);

    if (!explainReq.r && explainReq.attempts.every((a) => a.http === 0)) {
      /* 连不上网关：直接停，不许伪造 */
      const l = `FATAL 网关不可用：${CFG.chatUrl()} ${JSON.stringify(explainReq.attempts)}`;
      say(l);
      throw new Error(l);
    }

    if (!explainReq.r) {
      rec.explain = {
        kind: 'explain', http: explainReq.attempts.map((a) => a.http).join('/'),
        ms: explainReq.attempts.reduce((s, a) => s + a.ms, 0),
        ok: false, failed: true, reasons: [{ gate: 'request_failed', why: '讲解请求失败（重试 1 次仍失败）' }],
        raw: '', content: '', finish: '', usage: null
      };
      say(`  explain   http=${rec.explain.http}  ${fmtMs(rec.explain.ms)}  attempt=${explainReq.attempts.length}  -> request_failed`);
    } else {
      const j = explainReq.r.json;
      const content = contentOf(j);
      const verdict = judgeExplain(content);
      rec.explain = {
        kind: 'explain', http: explainReq.r.http, ms: explainReq.r.ms, attempts: explainReq.attempts.length,
        ok: verdict.ok, failed: false, reasons: verdict.reasons,
        raw: explainReq.r.text, content,
        finish: (j.choices && j.choices[0] && j.choices[0].finish_reason) || '',
        usage: j.usage || null
      };
      say(`  explain   http=${rec.explain.http}  ${fmtMs(rec.explain.ms)}  attempt=${rec.explain.attempts}  ` +
          `finish=${rec.explain.finish}  segs=${verdict.segs ? 5 : 0}  ok=${verdict.ok}` +
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

  const http200 = explainItems.concat(followItems).filter((x) => Number(String(x.http).split('/')[0]) === 200).length;
  const totalRequests = explainItems.length + followItems.length;
  const retried = explainItems.concat(followItems).filter((x) => (x.attempts || 1) > 1).length;

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
  md.push(`- 请求次数：${totalRequests}（其中重试过的请求 ${retried} 次），HTTP 200：${http200}`);
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
  md.push('## 7. 原始返回');
  md.push('');
  md.push(`- 目录：\`tmp/o4-live-raw/\`（${runs.length} 个文件，文件名 \`<topicId>.json\`，含每条请求的 messages 判定结果、HTTP 码、耗时、模型原始返回文本）`);
  md.push('- `tmp/` 在 `.gitignore` 内，不入库。');
  md.push('');

  fs.mkdirSync(path.dirname(DOC_PATH), { recursive: true });
  fs.writeFileSync(DOC_PATH, md.join('\n'), 'utf8');
  say(`\n报告已写入 ${path.relative(ROOT, DOC_PATH)}`);
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
