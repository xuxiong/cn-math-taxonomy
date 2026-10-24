#!/usr/bin/env node
/* funclab 测算探针（只读）：调参/复核用，不参与线上逻辑。
 *
 * 用法：
 *   node scripts/funclab_relaxed_probe.js baseline   # 把答案语义门禁套到基线 58 题上（自校准）
 *   node scripts/funclab_relaxed_probe.js r2ok       # 全库解析命中里判 ok/suspect 的题
 *   node scripts/funclab_relaxed_probe.js r2suspect  # 只看 suspect
 *
 * 输出每行：题 id | 判定 | 风险标签 | 题面 | 答案 | 画板标注的 X/Y 集合 | 对不上的数值。
 * 用途是核 measure_funclab_coverage.js 里的判定有没有判错，尤其看「数值碰巧重合」的假通过。
 */
'use strict';
const M = require('./measure_funclab_coverage.js');
const F = require('../diagnose/funclab.js');
const Q = require('../data/questions.json');

const mode = process.argv[2] || 'baseline';
const rows = mode === 'baseline'
  ? Q.map(q => ({ q, p: F.labFor(q.topicId, q.prompt, { itemId: q.id }) })).filter(r => r.p)
  : Q.map(q => ({ q, p: F.fromPrompt(q.prompt) })).filter(r => r.p);

const want = mode === 'r2suspect' ? ['suspect'] : (mode === 'r2ok' ? ['ok', 'suspect'] : ['ok', 'suspect', 'misleading']);
const g = rows.map(r => ({ r, f: M.finalVerdict(r.q, r.p) }));
const c = {};
g.forEach(x => { if (want.includes(x.f.verdict)) c[x.f.verdict] = (c[x.f.verdict] || 0) + 1; });
console.log('# ' + mode + ' ' + JSON.stringify(c));

for (const x of g) {
  if (!want.includes(x.f.verdict)) continue;
  const a = x.f.ann;
  console.log([x.r.q.id, x.f.verdict, '|', x.f.flags.map(f => f.code).join('+') || '-',
    '|', x.r.q.prompt.replace(/\s+/g, ' ').slice(0, 50),
    '|| ans:', String(x.f.answerText).slice(0, 30),
    '|| X:', a.x.map(v => +v.toFixed(3)).join('/') || '—',
    'Y:', a.y.map(v => +v.toFixed(3)).join('/') || '—',
    '|| un:', x.f.unmatched.join(',') || '—'].join(' '));
}
