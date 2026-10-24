/* 独立复核 docs/i-similar-audit.md 的关键断言（不依赖探针脚本的内部常量）：
 * 只用 questions.json + geomlab.js 的公开接口，重新算一遍并断言。 */
const fs = require('fs');
const ROOT = '/Users/apple/github/cn-math-taxonomy/.worktrees/t_84c2faa7';
const G = require(ROOT + '/diagnose/geomlab.js');
const Q = require(ROOT + '/data/questions.json');
const T = require(ROOT + '/data/topics.json');
const TM = new Map(T.map(t => [t.id, t]));
const doc = fs.readFileSync(ROOT + '/docs/i-similar-audit.md', 'utf8');

G.resetGateStats();
let pool = 0, mounted = 0;
const byReason = {};
Q.forEach(q => {
  const t = TM.get(q.topicId) || null;
  if (G.classOf(t && t.id, { topic: t }) !== 'similar') return;
  pool++;
  const lab = G.labFor(t && t.id, q.prompt, { itemId: q.id, topic: t, answer: q.answer, choices: q.choices });
  if (lab) { mounted++; return; }
  const g = G.gate(q.prompt, { itemId: q.id, answer: q.answer, choices: q.choices });
  const r = g.blocked ? g.reason : 'parse-fail';
  byReason[r] = (byReason[r] || 0) + 1;
});
const fails = Object.keys(byReason).filter(k => k !== 'answer-unknown').sort()
  .map(k => k + '=' + byReason[k]).join('，');
console.log('池=' + pool + ' 挂载=' + mounted + ' 门禁+解析失败=' + (pool - mounted));
console.log('分类去向：' + fails);
console.log('');
const checks = [
  ['池 36', pool === 36],
  ['挂载 3', mounted === 3],
  ['门禁挡 10', (byReason['judge-statement'] || 0) + (byReason['applied-model'] || 0) +
    Object.keys(byReason).filter(k => /^manual:/.test(k)).reduce((a, k) => a + byReason[k], 0) === 10],
  ['解析失败 23', (byReason['parse-fail'] || 0) === 23],
  ['answer-echoes-given 挡 0 题', (byReason['answer-echoes-given'] || 0) === 0],
  ['文档写明 10/36 = 27.8%', doc.includes('10/36 = 27.8%')],
  ['文档写明 POSITION_MEASURE 7 题、2 已挂', doc.includes('**7 题**') && doc.includes('**2 题已挂**')],
  ['文档写明补解析增量 0', doc.includes('增量 = **0 题**')],
  ['文档写明上限 6/36 = 16.7%', doc.includes('6/36 = 16.7%')]
];
let bad = 0;
checks.forEach(([name, ok]) => { if (!ok) bad++; console.log((ok ? '✓ ' : '✗ ') + name); });
console.log('');
console.log(bad === 0 ? '全部断言通过' : bad + ' 条断言失败');
process.exit(bad === 0 ? 0 : 1);
