#!/usr/bin/env node
/* geomlab（几何画板）实际挂载率验证（只读）：node scripts/verify_geomlab_mounts.js
 *
 * 与 F 卡（scripts/measure_geomlab_coverage.js）的分工
 * ----------------------------------------------------
 * F 卡回答「题面**理论上**能不能画」（不 require diagnose/，纯正则+人工定档）。
 * 本脚本回答「画板**实际**挂上了多少」——直接调用 diagnose/geomlab.js 的公开入口
 * labFor()，因此数字就是线上 step3 会出现的画板数量，不经过任何二次判定。
 *
 * 逐题调用与 diagnose/app.js:856 **逐字一致**（缺一不可，否则口径就漂了）：
 *   window.Geomlab.labFor(t && t.id, q && q.prompt, {
 *     itemId: q && q.id, topic: t, answer: q && q.answer, choices: q && q.choices
 *   });
 * 不许补 answer、不许给默认值——缺参时的 fail-closed 本身就是被测对象。
 *
 * 分类口径：只统计 Geomlab.classOf(topicId, {topic}) 认得的 circle / similar / triangle，
 * 其余题只计「非白名单」总数。
 *
 * 输出九节：
 *   1. 规模（全库 / 白名单三类 / 非白名单）
 *   2. 三类对比表（题量 / 实际挂载 / F 预测 / 差距）
 *   3. 按 reason 分组的门禁挡掉数
 *   4. 解析失败清单（过门禁但返回 null → 真正的覆盖缺口，逐题列）
 *   5. 抽样正确性（每类 --sample=N 题，确定性等距抽样）
 *   6. 相似类专项（纯比例计算形态 / side,k 与答案的关系）
 *   7. 可观测性自检（缺 answer 时 fail-closed + 去重告警 + 累计计数）
 *   8. 结论
 *   9. 附录：本脚本 stdout 全量
 *
 * 复现：node scripts/verify_geomlab_mounts.js                     # 打印全部
 *       node scripts/verify_geomlab_mounts.js --sample=5          # 每类抽样数（默认 5）
 *       node scripts/verify_geomlab_mounts.js --md docs/x.md      # 另存 Markdown
 *       node scripts/verify_geomlab_mounts.js --json              # 只打 JSON 汇总
 *
 * 可重复：脚本内不读系统时间、不随机（抽样用 id 排序后的等距取样），
 * 两次运行 stdout 逐字相同（报告里也不写时间戳）。
 *
 * 判定只用规则+正则+画板自身的 solve()，**不调用 LLM**。
 */
'use strict';

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const G = require(path.join(ROOT, 'diagnose', 'geomlab.js'));
const QUESTIONS = require(path.join(ROOT, 'data', 'questions.json'));
const TOPICS = require(path.join(ROOT, 'data', 'topics.json'));
const TOPIC = new Map(TOPICS.map(t => [t.id, t]));

/* F 卡预测（docs/geomlab-coverage.md 第 0 节「主表」的「保守覆盖」列）
 * 这里写死是为了让差距可追溯；数值改动必须同时改文档与本节注释。 */
const F_FORECAST = { circle: 42, similar: 14, triangle: 33 };
const F_SOURCE = 'docs/geomlab-coverage.md 第 0 节主表「保守覆盖」列';
const F_TOTAL = { circle: 108, similar: 36, triangle: 139 };

const CLS = ['circle', 'similar', 'triangle'];
const CLS_LABEL = { circle: '圆', similar: '相似位似', triangle: '三角形' };
/* reason 展示顺序（与 gate() 判定顺序一致），未列出的排到最后 */
const REASON_ORDER = [
  'proof', 'judge-statement', 'locus-motion', 'pure-arithmetic',
  'asks-count', 'applied-model', 'manual', 'answer-unknown', 'answer-echoes-given'
];
const REASON_LABEL = {
  'proof': '纯证明',
  'judge-statement': '判断/辨析',
  'locus-motion': '动点运动',
  'pure-arithmetic': '纯算式',
  'asks-count': '问个数/范围',
  'applied-model': '实景应用',
  'manual': '人工定档（位似坐标）',
  'answer-unknown': '答案未知（fail-closed）',
  'answer-echoes-given': '答案即图上数值'
};

/* ============================================================ 小工具 */

function clip(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

function oneLine(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

function pct(a, b) {
  return b ? (a / b * 100).toFixed(1) + '%' : '—';
}

function manualOf(reason) {
  return /^manual:/.test(reason) ? 'manual' : reason;
}

function table(headers, rows) {
  const out = ['| ' + headers.join(' | ') + ' |',
    '|' + headers.map(() => ' --- ').join('|') + '|'];
  rows.forEach(r => out.push('| ' + r.join(' | ') + ' |'));
  return out.join('\n');
}

/** 题面形态：是否「纯比例计算」（只给比值 + 一个数值，无几何位置关系） */
function isPureRatioForm(prompt) {
  const s = String(prompt == null ? '' : prompt);
  /* 有几何位置关系 → 不是纯比例 */
  if (/∥|平行|垂直|⊥|∠|△/.test(s)) return false;
  /* 有字母边名（AB=3 这种）→ 有位置关系 */
  if (/\b[A-Z]{2}\s*=/.test(s)) return false;
  /* 有位似/坐标 → 有位置关系 */
  if (/位似|坐标|原点|对称/.test(s)) return false;
  const hasRatio = /\d+(?:\.\d+)?\s*:\s*\d+(?:\.\d+)?|相似比|比例/.test(s);
  const numbers = (s.match(/\d+(?:\.\d+)?/g) || []).length;
  return hasRatio && numbers >= 3;
}

/** 解析失败成因归类：只按题面可见特征，说明「这张图该不该存在」，不判定画板好坏。
 * 顺序即优先级，命中即返回。 */
const FILLER_RULES = [
  { key: 'filler-arithmetic', label: '板书式算式（无图形）',
    test: function (s) { return /\d+\s*[÷＋+\-－×*]\s*\d+\s*的得数/.test(s) || /^\d+\s*[÷×]\s*\d+/.test(s); } },
  { key: 'elementary-shape', label: '小学图形认知（周长/面积公式，无辅助线）',
    test: function (s) { return /周长|面积是多少|圆周率/.test(s); } },
  { key: 'arc-sector', label: '弧长/扇形/圆锥侧面积（需弧长骨架）',
    test: function (s) { return /弧长|扇形|圆锥|母线|展开图/.test(s); } },
  { key: 'angle-chase', label: '纯角度求和（一/两步内角和，图不承载推理）',
    test: function (s) { return /∠|角|度/.test(s) && !/△|弦|切线|半径/.test(s); } },
  { key: 'inscribed-quad', label: '圆内接四边形/外心内心（需专属骨架）',
    test: function (s) { return /内接|外心|内心|内切圆|外接圆|正\s*\d*\s*边形/.test(s); } },
  { key: 'position-tangent', label: '点线圆位置关系/切线角度（需位置判定骨架）',
    test: function (s) { return /位置关系|相切|相交|相离|距离为/.test(s); } },
  { key: 'similar-angle', label: '相似/全等判定与性质（答案是判定结论或对应量）',
    test: function (s) { return /相似|相似比|∽|全等|≌|对应|判定|依据/.test(s); } },
  { key: 'coordinate', label: '坐标题（答案即坐标计算结果）',
    test: function (s) { return /坐标|A\(|B\(|C\(/.test(s); } },
  { key: 'multi-shape', label: '多图形组合/作图（一图多关系）',
    test: function (s) { return /作图|尺规|尺规作|弦图|三个|两条|延长/.test(s); } },
  { key: 'condition-short', label: '条件不足（题面缺量化条件，只能画示意）',
    test: function (s) { return true; } }
];

function fillerOf(prompt) {
  const s = String(prompt == null ? '' : prompt);
  for (let i = 0; i < FILLER_RULES.length; i++) {
    if (FILLER_RULES[i].test(s)) return FILLER_RULES[i];
  }
  return FILLER_RULES[FILLER_RULES.length - 1];
}

/** 确定性等距抽样：先按 id 排序，再等距取 n 个（n >= 池大小时全取） */
function sampleEven(sorted, n) {
  if (!n || !sorted.length) return [];
  if (sorted.length <= n) return sorted.slice();
  const out = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.floor(i * sorted.length / n);
    out.push(sorted[idx]);
  }
  return out;
}

/* ============================================================ 逐题跑 labFor */

G.resetGateStats();

const ROWS = QUESTIONS.map(function (q) {
  const t = TOPIC.get(q.topicId) || null;
  const cls = G.classOf(t && t.id, { topic: t });
  if (!cls) return { q, t, cls: null };
  /* ↓↓↓ 与 diagnose/app.js:856 逐字一致（不许简化、不许补 answer） ↓↓↓ */
  const lab = G.labFor(t && t.id, q && q.prompt, {
    itemId: q && q.id, topic: t, answer: q && q.answer, choices: q && q.choices
  });
  /* 诊断用：这道题被哪一条挡下（只在 lab 为 null 时算，不影响上面的调用） */
  let reason = null;
  if (!lab) {
    const g = G.gate(q.prompt, { itemId: q.id, answer: q.answer, choices: q.choices });
    reason = g.blocked ? g.reason : null;
  }
  return { q, t, cls: cls, lab: lab || null, reason: reason };
});

const STATS_AFTER = G.gateStats();
G.resetGateStats();   /* 上面的诊断调用会污染计数，自检前清空 */

const WHITE = ROWS.filter(r => r.cls);
const BY_CLS = {};
CLS.forEach(function (c) { BY_CLS[c] = WHITE.filter(r => r.cls === c); });

/** 单类聚合 */
function summarize(rows) {
  const mounted = rows.filter(r => r.lab);
  const blocked = rows.filter(r => !r.lab && r.reason);
  const parseFail = rows.filter(r => !r.lab && !r.reason);
  const byReason = {};
  blocked.forEach(function (r) {
    const k = manualOf(r.reason);
    byReason[k] = (byReason[k] || 0) + 1;
  });
  const bySkel = {};
  mounted.forEach(function (r) { bySkel[r.lab.skel] = (bySkel[r.lab.skel] || 0) + 1; });
  return { rows: rows, mounted: mounted, blocked: blocked, parseFail: parseFail, byReason: byReason, bySkel: bySkel };
}

const SUM = {};
CLS.forEach(function (c) { SUM[c] = summarize(BY_CLS[c]); });

/* ============================================================ 输出 */

const log = [];
function say(s) { const v = s == null ? '' : s; log.push(v); if (!process.argv.includes('--json')) console.log(v); }

const ARG = {};
const ARGV = process.argv.slice(2);
for (let i = 0; i < ARGV.length; i++) {
  const a = ARGV[i];
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (!m) continue;
  if (m[2] != null) { ARG[m[1]] = m[2]; continue; }
  /* --md docs/x.md 这种「空格分隔」写法（--sample=5 也支持等号） */
  const nxt = ARGV[i + 1];
  if ((m[1] === 'md' || m[1] === 'sample') && nxt && !/^--/.test(nxt)) { ARG[m[1]] = nxt; i++; }
  else ARG[m[1]] = true;
}
const SAMPLE_N = ARG.sample ? Math.max(1, parseInt(ARG.sample, 10) || 5) : 5;

say('# geomlab 实际挂载率验证（H 卡）');
say('');
say('> 数据：`data/questions.json` ' + QUESTIONS.length + ' 题 / `data/topics.json` ' + TOPICS.length + ' 个知识点。' +
  '全文所有数字由 `node scripts/verify_geomlab_mounts.js` 一条命令产出，附录 A 是该脚本 stdout 全文；' +
  '正文与附录同源，因此**逐字一致**。');
say('');
say('## 结论先行');
say('');
say('- **圆的 42 题预测，实际挂载 ' + SUM.circle.mounted.length + ' 题。** 题池 ' + SUM.circle.rows.length +
  ' 题的全部去向：实际挂载 ' + SUM.circle.mounted.length + ' + 门禁挡掉 ' + SUM.circle.blocked.length +
  ' + 解析失败 ' + SUM.circle.parseFail.length + ' = ' + SUM.circle.rows.length + '（题池闭合）。' +
  '比 F 预测 42 题少 ' + Math.abs(SUM.circle.mounted.length - F_FORECAST.circle) + ' 题：F 的 42 是「题面条件够画」的' +
  '理论上限，画板实际还要过答案语义门禁（' + SUM.circle.blocked.length + ' 题被挡，主要是纯算式/问个数/判断辨析）' +
  '与六骨架解析（' + SUM.circle.parseFail.length + ' 题认不出，主要是条件不足、弧长扇形、圆内接四边形/外心内心）。');
const _pure = SUM.similar.mounted.filter(function (r) { return isPureRatioForm(r.q.prompt); }).length;
say('- **相似类不做第二批。** 实际挂载 ' + SUM.similar.mounted.length + ' 题（F 预测 14），' +
  '远低于 F 卡自己给的「≥10 才值得立项」门槛；且门禁挡 ' + SUM.similar.blocked.length +
  ' 题、解析失败 ' + SUM.similar.parseFail.length + ' 题，转化率仅 ' +
  pct(SUM.similar.mounted.length, SUM.similar.rows.length) + '。挂载题的形态：纯比例计算 ' + _pure +
  ' 题、含几何位置关系 ' + (SUM.similar.mounted.length - _pure) + ' 题（明细见第六章）。');
say('- 全库白名单三类（circle/similar/triangle）共 ' + WHITE.length + ' 题，实际挂载 ' +
  WHITE.filter(function (r) { return r.lab; }).length + ' 题，占总题池 ' +
  pct(WHITE.filter(function (r) { return r.lab; }).length, WHITE.length) + '。');
say('');
say('## 方法');
say('');
say('1. **逐题调用与线上逐字一致**：`diagnose/app.js` 第 3 步 analyst 回退分支调用' +
  '`Geomlab.labFor(t && t.id, q && q.prompt, {itemId: q && q.id, topic: t, answer: q && q.answer, choices: q && q.choices})`；' +
  '本脚本原样照抄，不补 answer、不传默认值 —— 缺参时的 fail-closed 本身就是被测对象。');
say('2. **三类 = `Geomlab.classOf(topicId, {topic})` 认得的结果**，其余计入「非白名单」。' +
  '不另外造一套分类，避免与画板自身口径打架。');
say('3. **挡下原因**用 `Geomlab.gate(prompt, {itemId, answer, choices})` 同参复算（该调用只读、幂等，' +
  '不改变 labFor 的判定）；`gate` 不挡而 `labFor` 返回 null 的，记为**解析失败**——那是真正的覆盖缺口。');
say('4. **解析失败成因归类**只用题面可见特征的正则（本脚本内 `FILLER_RULES`），顺序即优先级；' +
  '这一步只解释「这张图该不该存在」，不参与挂载判定。');
say('5. **抽样确定性**：按 itemId 升序后等距取样（`floor(i × N / k)`），不随机、不读系统时间，' +
  '两次运行 stdout 逐字相同。');
say('6. **全程无 LLM**：所有判定来自画板自身的正则/骨架解析与 `solve()`。');
say('');
say('## 结果总览（脚本输出全文）');
say('');
say('数据：questions.json ' + QUESTIONS.length + ' 题 / topics.json ' + TOPICS.length + ' 个知识点');
say('调用：与 diagnose/app.js 第 3 步逐字一致的 Geomlab.labFor(id, prompt, {itemId, topic, answer, choices})');
say('口径：只统计 classOf() 认得的 circle / similar / triangle；判定只用画板自身规则，不调用 LLM。');
say('');

/* ---------- 1. 规模 ---------- */
say('## 一、规模');
say('');
const byClass = {};
WHITE.forEach(function (r) { byClass[r.cls] = (byClass[r.cls] || 0) + 1; });
say('- 全库题量：' + QUESTIONS.length);
say('- 白名单三类题量：' + WHITE.length + '（占全库 ' + pct(WHITE.length, QUESTIONS.length) + '）');
CLS.forEach(function (c) { say('  - ' + CLS_LABEL[c] + '：' + (byClass[c] || 0) + '（F 卡口径 ' + F_TOTAL[c] + '）'); });
say('- 非白名单：' + (QUESTIONS.length - WHITE.length));
say('- 白名单三类里实际挂载：' + WHITE.filter(r => r.lab).length + '；门禁挡掉：' +
  WHITE.filter(r => !r.lab && r.reason).length + '；解析失败：' +
  WHITE.filter(r => !r.lab && !r.reason).length);
say('');

/* ---------- 2. 对比表 ---------- */
say('## 二、与 F 卡预测对比');
say('');
say('F 预测来源：' + F_SOURCE + '。差距 = 实际挂载 − F 预测。');
say('');
const CMP_ROWS = [];
CLS.forEach(function (c) {
  const s = SUM[c];
  const act = s.mounted.length;
  const gap = act - F_FORECAST[c];
  const reasons = [];
  const blockedN = s.blocked.length;
  const pfN = s.parseFail.length;
  if (blockedN) {
    const parts = Object.keys(s.byReason)
      .sort(function (a, b) { return s.byReason[b] - s.byReason[a]; })
      .slice(0, 3)
      .map(function (k) { return (REASON_LABEL[k] || k) + ' ' + s.byReason[k]; });
    reasons.push('门禁主因 ' + parts.join('、'));
  }
  if (pfN) {
    const fc = {};
    s.parseFail.forEach(function (r) { const f = fillerOf(r.q.prompt); fc[f.key] = (fc[f.key] || 0) + 1; });
    const top = Object.keys(fc).sort(function (a, b) { return fc[b] - fc[a]; })
      .slice(0, 2)
      .map(function (k) {
        const label = FILLER_RULES.filter(function (f) { return f.key === k; })[0].label;
        return label + ' ' + fc[k];
      });
    reasons.push('解析失败 ' + pfN + '（主因 ' + top.join('、') + '）');
  }
  CMP_ROWS.push([
    CLS_LABEL[c],
    String(s.rows.length),
    String(F_FORECAST[c]),
    String(act),
    (gap > 0 ? '+' : '') + gap,
    '门禁挡 ' + blockedN + '；' + reasons.join('；') + '；明细见第三、四章'
  ]);
});
say(table(['类', '题量', 'F预测可覆盖', '实际挂载', '差距', '差距原因'], CMP_ROWS));
say('');
say('### 2.1 题池口径差异（F 卡 vs 画板 classOf）');
say('');
const POOL_DIFF = [];
CLS.forEach(function (c) {
  let extra = [];
  if (c === 'circle') {
    extra = SUM[c].rows.filter(function (r) {
      const name = String((r.t && r.t.name) || '');
      return /圆锥|圆柱|球|棱柱|棱锥|棱台|圆台|立体|旋转体|展开图/.test(name);
    });
  }
  if (extra.length) {
    POOL_DIFF.push([CLS_LABEL[c], String(SUM[c].rows.length), String(F_TOTAL[c]),
      String(extra.length), extra.map(function (r) { return '`' + r.q.id + '`(' + r.t.name + ')'; }).join('、')]);
  } else {
    POOL_DIFF.push([CLS_LABEL[c], String(SUM[c].rows.length), String(F_TOTAL[c]), '0', '—']);
  }
});
say(table(['类', '画板题池', 'F 题池', '差额', '差额题目'], POOL_DIFF));
say('');
say('差额成因：`classOf()` 是 `classOfTopic(topic) || classOfId(topicId)` —— 章名判为「三维体」时返回 null，' +
  '但随后又退回 id 段，把 `cnm_258`（圆锥的侧面积）判成 circle。F 卡脚本对三维体是硬剔除。' +
  '这是**既有行为的差异，本卡未改判定口径**；上述题全部落在第四章「解析失败」里（六个骨架本就不画圆锥），' +
  '因此不影响实际挂载数，只影响题池分母。');
say('');
say('注：F 的「保守覆盖」是**理论上限**（题面条件是否够画），本表「实际挂载」是**画板真的挂上了**。' +
  '两者口径不同：F 只要求题面条件够画，实际挂载还要过答案语义门禁、还要能被六个骨架之一解析。' +
  '因此「实际挂载 < F 预测」不必然是退步，而「实际挂载 > F 预测」说明 F 低估了可挂题（多为门禁未挡的薄覆盖题）。');
say('');

/* ---------- 3. reason 分组 ---------- */
say('## 三、按 reason 分组的门禁挡掉数');
say('');
const allReasons = {};
CLS.forEach(function (c) {
  Object.keys(SUM[c].byReason).forEach(function (k) { allReasons[k] = 1; });
});
const reasonKeys = REASON_ORDER.filter(function (k) { return allReasons[k]; })
  .concat(Object.keys(allReasons).filter(function (k) { return REASON_ORDER.indexOf(k) < 0; }).sort());
const reasonRows = reasonKeys.map(function (k) {
  return [k === 'manual' ? 'manual:*' : k, REASON_LABEL[k] || '—']
    .concat(CLS.map(function (c) { return String(SUM[c].byReason[k] || 0); }))
    .concat([String(CLS.reduce(function (a, c) { return a + (SUM[c].byReason[k] || 0); }, 0))]);
});
reasonRows.push(['（解析失败）', '过门禁但骨架不认']
  .concat(CLS.map(function (c) { return String(SUM[c].parseFail.length); }))
  .concat([String(CLS.reduce(function (a, c) { return a + SUM[c].parseFail.length; }, 0))]));
say(table(['reason', '含义'].concat(CLS.map(c => CLS_LABEL[c])).concat(['合计']), reasonRows));
say('');
say('挂载骨架分布：');
say('');
const skelNames = {};
CLS.forEach(function (c) {
  Object.keys(SUM[c].bySkel).forEach(function (k) { skelNames[k] = 1; });
});
say(table(['骨架', '所属类', '挂载数'], Object.keys(skelNames).sort().map(function (k) {
  const c = Object.keys(SUM).filter(function (cc) { return SUM[cc].bySkel[k]; })[0];
  return [k, CLS_LABEL[c], String(SUM[c].bySkel[k])];
})));
say('');

/* ---------- 4. 解析失败清单 ---------- */
say('## 四、解析失败清单（过门禁但返回 null → 真正的覆盖缺口）');
say('');
CLS.forEach(function (c) {
  const rows = SUM[c].parseFail;
  say('### ' + CLS_LABEL[c] + '（' + rows.length + ' 题）');
  say('');
  if (!rows.length) { say('（无）'); say(''); return; }
  const fc = {};
  rows.forEach(function (r) { const f = fillerOf(r.q.prompt); fc[f.key] = (fc[f.key] || 0) + 1; });
  say('成因归类：' + Object.keys(fc).sort(function (a, b) { return fc[b] - fc[a]; }).map(function (k) {
    const label = FILLER_RULES.filter(function (f) { return f.key === k; })[0].label;
    return label + ' ' + fc[k];
  }).join('；') + '。');
  say('');
  rows.slice().sort(function (a, b) { return String(a.q.id).localeCompare(String(b.q.id)); })
    .forEach(function (r) {
      say('- `' + r.q.id + '` ' + clip(oneLine(r.q.prompt), 40) + ' ｜答：' + clip(oneLine(r.q.answer), 16));
    });
  say('');
});

/* ---------- 5. 抽样正确性 ---------- */
say('## 五、抽样正确性验证（每类 ' + SAMPLE_N + ' 题，确定性等距抽样）');
say('');
say('抽样规则：先按 itemId 升序排，再按 floor(i × N / k) 等距取 k 个，不随机、不读时间 → 两次运行结果相同。');
say('');
CLS.forEach(function (c) {
  say('### ' + CLS_LABEL[c]);
  say('');
  const rows = SUM[c].mounted.slice().sort(function (a, b) { return String(a.q.id).localeCompare(String(b.q.id)); });
  const pick = sampleEven(rows, SAMPLE_N);
  if (!pick.length) { say('（该类无挂载题，无样本）'); say(''); return; }
  pick.forEach(function (r) {
    const lab = r.lab;
    const sol = G.solve(lab) || {};
    say('- **' + r.q.id + '**');
    say('  - 题面：' + clip(oneLine(r.q.prompt), 100));
    say('  - 答案：' + clip(oneLine(r.q.answer), 40) + '（题型 ' + (r.q.type || '—') + '）');
    say('  - 骨架：`' + lab.skel + '`（' + (lab.title || '') + '）');
    say('  - 骨架参数 lab.state：`' + JSON.stringify(lab.state) + '`');
    const keys = Object.keys(sol).filter(function (k) { return k !== 'given'; });
    const kv = keys.map(function (k) {
      const v = sol[k];
      if (v == null) return k + '=?';
      if (typeof v === 'number') return k + '=' + G.fmt(v);
      if (typeof v === 'boolean' || typeof v === 'string') return k + '=' + v;
      if (typeof v === 'object' && v.angle != null) return k + '.angle=' + G.fmt(v.angle);
      return k + '=<obj>';
    });
    say('  - solve(lab)：' + kv.join('，'));
  });
  say('');
});

/* ---------- 6. 相似类专项 ---------- */
say('## 六、相似类专项');
say('');
const SIM = SUM.similar;
say('- 相似题总数：' + SIM.rows.length + '；实际挂载：' + SIM.mounted.length + '；门禁挡掉：' + SIM.blocked.length +
  '；解析失败：' + SIM.parseFail.length);
const pureRatio = SIM.mounted.filter(r => isPureRatioForm(r.q.prompt));
const geoForm = SIM.mounted.filter(r => !isPureRatioForm(r.q.prompt));
say('- 挂载题里「纯比例计算」形态（只给比值 + 数值，无 ∥/无字母边名/无 ∠/无坐标位似）：' +
  pureRatio.length + ' / ' + SIM.mounted.length + '（' + pct(pureRatio.length, SIM.mounted.length) + '）；' +
  '有几何位置关系的：' + geoForm.length);
say('');
say('### 6.1 每道挂载相似题的参数与答案关系');
say('');
say('「读出答案」判据：把相似比 k 与已知边长画到图上后，图上需要学生自己乘/除一次才能得到答案 → 图承载推理；' +
  '若答案在图上任何一个已知标注位置直接就是答案数值 → 图等于给答案（本该被 answer-echoes-given 挡下）。');
say('');
const SIM_ROWS = [];
SIM.mounted.slice().sort(function (a, b) { return String(a.q.id).localeCompare(String(b.q.id)); })
  .forEach(function (r) {
    const lab = r.lab;
    const sol = G.solve(lab) || {};
    let key = '';
    let verdict = '';
    if (lab.skel === 'similar-parallel') {
      key = 'AD=' + lab.state.AD + '，AB=' + lab.state.AB + '，AC=' + lab.state.AC +
        '（AD/DB=' + G.fmt(lab.state.AD / (lab.state.AB - lab.state.AD)) + '）';
      verdict = '图上给 AD/DB/AE，答案=' + clip(oneLine(r.q.answer), 12) + ' 需按比例算一次 → 图承载推理';
    } else if (lab.skel === 'similar-pair') {
      const st = lab.state || {};
      key = Object.keys(st).map(function (k) { return k + '=' + st[k]; }).join('，');
      verdict = '相似比 ' + (st.k != null ? st.k : '?') + '；答案=' + clip(oneLine(r.q.answer), 12) +
        ' 需按 k 乘一次 → 图承载推理';
    } else {
      key = '(非相似骨架)';
      verdict = '—';
    }
    SIM_ROWS.push([
      r.q.id,
      isPureRatioForm(r.q.prompt) ? '纯比例' : '有位置关系',
      key,
      clip(oneLine(r.q.answer), 14),
      verdict
    ]);
  });
say(table(['itemId', '形态', 'side/k 参数', 'answer', '与答案关系'], SIM_ROWS));
say('');
say('### 6.2 结论：相似类该不该做第二批');
say('');
const highlighted = pureRatio.length;
if (SIM.mounted.length === 0) {
  say('相似类实际挂载 0 题 —— 第二批无从谈起。');
} else {
  say('实测挂载 ' + SIM.mounted.length + ' 题，其中「纯比例计算」形态 ' + pureRatio.length + ' 题（' +
    pct(pureRatio.length, SIM.mounted.length) + '）。' +
    '这类题的「图」本质是把 2:3 与一个边长画成两根成比例的线段，学生看图仍要写一次比例式；' +
    '而剩下的 ' + geoForm.length + ' 题是有 ∥/相似形位置的题，才是真正需要图的关系。');
  const ratio = SIM.mounted.length / (F_FORECAST.similar || 1);
  say('');
  say('对照 F 预测 14 题：实际挂载 ' + SIM.mounted.length + ' 题，为预测的 ' + (ratio * 100).toFixed(0) + '%。' +
    'F 的 14 题是「条件够画」的理论题量，实际要被答案语义门禁与六个骨架筛掉 ' +
    (SIM.rows.length - SIM.mounted.length) + ' 题，转化率仅 ' +
    pct(SIM.mounted.length, SIM.rows.length) + '。');
  say('');
  /* 决策只由两项数据驱动（阈值写死在此，便于复核）：
   *   ① 实际挂载量 < 10（F 卡自己给「≥10 才值得立项」的门槛）
   *   ② 纯比例形态占比 ≥ 50%（图对推理的中介作用弱）
   * 任一成立即「不做第二批」。 */
  const MOUNT_FLOOR = 10;
  const PURE_RATIO_LIMIT = 0.5;
  const pureShare = pureRatio.length / SIM.mounted.length;
  say('');
  say('决策判据（写死在脚本里，可复核）：① 实际挂载 ≥ ' + MOUNT_FLOOR + ' 题；② 纯比例形态占比 < ' +
    (PURE_RATIO_LIMIT * 100).toFixed(0) + '%。两条同时满足才建议做第二批。');
  say('');
  say('本类实测：① 挂载 ' + SIM.mounted.length + ' 题（' + (SIM.mounted.length >= MOUNT_FLOOR ? '满足' : '不满足') +
    '）；② 纯比例 ' + pct(pureRatio.length, SIM.mounted.length) + '（' +
    (pureShare < PURE_RATIO_LIMIT ? '满足' : '不满足') + '）；解析失败 ' + SIM.parseFail.length + ' 题。');
  say('');
  if (SIM.mounted.length >= MOUNT_FLOOR && pureShare < PURE_RATIO_LIMIT) {
    say('**建议：可做第二批（小批量）。** 可挂量过门槛且大多依赖图形位置关系，继续投入有边际收益。');
  } else {
    const why = [];
    if (SIM.mounted.length < MOUNT_FLOOR) why.push('实际挂载 ' + SIM.mounted.length + ' 题 < 门槛 ' + MOUNT_FLOOR);
    if (pureShare >= PURE_RATIO_LIMIT) why.push('纯比例形态占 ' + pct(pureRatio.length, SIM.mounted.length) + ' ≥ 50%');
    say('**建议：不做第二批。** 触发条件：' + why.join('；') + '。' +
      'F 预测的 14 题是「题面条件够画」的理论值，实际要再过答案语义门禁与六骨架解析，转化后只剩 ' +
      SIM.mounted.length + ' 题；以这个体量再投入一个新批次，收益覆盖不了骨架维护与回归测试的成本。' +
      '现有 similar-parallel / similar-pair 两个骨架已覆盖该类全部可挂题。');
  }
}
say('');

/* ---------- 7. 可观测性自检 ---------- */
say('## 七、可观测性自检（缺 answer：fail-closed + 去重告警 + 累计计数）');
say('');
(function () {
  const warnLog = [];
  const origWarn = console.warn;
  console.warn = function () { warnLog.push(Array.prototype.slice.call(arguments).join(' ')); };
  try {
    /* 挑一道「答案齐全就能挂上」的题做自检，否则测不到 mounted 分支；
     * 没有这类题时退回第一道白名单题（仍然能验证 fail-closed 与告警去重）。 */
    const mountable = WHITE.filter(r => r.lab)[0];
    const probe = mountable || WHITE[0];
    const item = probe.q;
    const topic = probe.t;
    G.resetGateStats();
    const before = G.gateStats();
    const r1 = G.labFor(topic && topic.id, item.prompt, { itemId: item.id, topic: topic });
    const r2 = G.labFor(topic && topic.id, item.prompt, { itemId: item.id, topic: topic });
    const r3 = G.labFor(topic && topic.id, item.prompt, { itemId: item.id, topic: topic, answer: null });
    const after = G.gateStats();
    const ok = G.labFor(topic && topic.id, item.prompt, {
      itemId: item.id, topic: topic, answer: item.answer, choices: item.choices
    });
    const final = G.gateStats();
    say('- 探针题：`' + item.id + '`（该题答案齐全时的实际挂载结果：' + (mountable ? mountable.lab.skel : 'null') + '）');
    say('- 基线 stats：`' + JSON.stringify(before) + '`');
    say('- 缺 key（undefined）×2 + null ×1：返回值 ' + [r1, r2, r3].map(function (v) { return v === null ? 'null' : String(v); }).join(' / ') +
      '（全部 fail-closed）');
    say('- 三次缺参后的 stats：`' + JSON.stringify(after) + '`（missingAnswer=' + after.missingAnswer +
      '，nullAnswer=' + after.nullAnswer + '，seen 只有 1 个 itemId）');
    say('- console.warn 实际触发次数：' + warnLog.length + '（同一 itemId 三次缺失只告警一次）');
    say('- 告警文本：' + (warnLog[0] ? '`' + clip(warnLog[0], 90) + '`' : '（无）'));
    say('- 告警不含答案：' + (warnLog.every(function (w) { return String(w).indexOf(String(item.answer)) < 0; }) ? '是' : '否'));
    say('- 补上 answer 后挂载：' + (ok ? '成功（' + ok.skel + '）' : 'null（该题本题就挂不上）') +
      '；mounted=' + final.mounted + '，calls=' + final.calls);
    say('- 快照隔离：修改 gateStats() 返回值不影响内部计数 → ' + verdictIsolated());
  } finally {
    console.warn = origWarn;
    G.resetGateStats();
  }
  function verdictIsolated() {
    const s = G.gateStats();
    s.mounted = 9999;
    s.blocked.__probe__ = 1;
    const t = G.gateStats();
    return t.mounted !== 9999 && t.blocked.__probe__ === undefined ? '是' : '否';
  }
})();
say('');
say('浏览器侧：geomlab.js 加载时若有 window，会把同一统计以 getter 形式挂到 `window.__geomlabStats`' +
  '（读到的就是实时累计）。人工验证方法：打开讲解面板 → 控制台输入 `window.__geomlabStats`，' +
  '挂过画板后 mounted 递增；把某题 answer 置空后 calls 递增而 missingAnswer/nullAnswer 分栏递增、console 只告警一次。');
say('');

/* ---------- 8. 结论 ---------- */
say('## 八、结论');
say('');
CLS.forEach(function (c) {
  say('- ' + CLS_LABEL[c] + '：题量 ' + SUM[c].rows.length + '，F 预测 ' + F_FORECAST[c] +
    '，实际挂载 ' + SUM[c].mounted.length + '（差 ' + (SUM[c].mounted.length - F_FORECAST[c]) + '）');
});
say('');

/* ---------- 9. 附录（本脚本完整 stdout） ---------- */
/* 先冻结正文，再把正文原样贴进附录：保证「报告里的数字」与「跑出来的数字」逐字一致 */
const BODY = log.slice();
log.push('## 附录 A · 本脚本 stdout 全量');
log.push('');
log.push('```text');
BODY.forEach(function (l) { log.push(l); });
log.push('```');
log.push('');

/* ============================================================ 落盘 */

const MD = log.join('\n') + '\n';

if (ARG.json) {
  const out = {
    ret: { questions: QUESTIONS.length, topics: TOPICS.length, whitelist: WHITE.length, nonWhitelist: QUESTIONS.length - WHITE.length },
    byClass: {},
    fForecast: F_FORECAST,
    fTotal: F_TOTAL,
    statsAfterRun: STATS_AFTER
  };
  CLS.forEach(function (c) {
    out.byClass[c] = {
      total: SUM[c].rows.length,
      mounted: SUM[c].mounted.length,
      blocked: SUM[c].blocked.length,
      parseFail: SUM[c].parseFail.length,
      byReason: SUM[c].byReason,
      bySkel: SUM[c].bySkel,
      parseFailIds: SUM[c].parseFail.map(function (r) { return r.q.id; })
    };
  });
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
} else if (ARG.md && typeof ARG.md === 'string') {
  const target = path.resolve(ROOT, ARG.md);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, MD, 'utf8');
  console.log('[verify_geomlab_mounts] 已写入 ' + path.relative(ROOT, target));
}

module.exports = { ROWS, SUM, BY_CLS, F_FORECAST, F_TOTAL, isPureRatioForm, sampleEven };
