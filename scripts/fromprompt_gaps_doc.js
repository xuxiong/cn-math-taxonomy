#!/usr/bin/env node
/* 生成 docs/fromprompt-gaps.md（E 卡第 1–2 步）：node scripts/fromprompt_gaps_doc.js
 *
 * 题面/答案一律从 data/questions.json 直取（不手抄），分类结论手写在 CLASS 表里。
 * 分类口径（B 卡确立，沿用）：「答案必须是画板真会标出来的量」
 *   二次：顶点 h/k，或与 x 轴交点（根）    一次：y 轴截距 b，或与 x 轴交点
 *   反比例：象限位置，或 |k| 表达的远近
 *   (a) 应救回：题面给了可确定的函数（只是写法超出解析器），且答案是上述量
 *   (b) 不该挂：答案不是上述量（系数/参数/范围/计数/分类/函数值/表达式/几何量），
 *              或题面条件不足/需建模才能确定函数
 *   (c) 存疑：答案是上述量，但必须解方程组或文字建模才拿得到函数 → 需人工定档
 */
'use strict';

const fs = require('fs');
const path = require('path');
const F = require(path.join(__dirname, '..', 'diagnose', 'funclab.js'));
const QUESTIONS = require(path.join(__dirname, '..', 'data', 'questions.json'));
const TOPICS = require(path.join(__dirname, '..', 'data', 'topics.json'));

const QMAP = new Map(QUESTIONS.map(q => [q.id, q]));
const TOPIC = new Map(TOPICS.map(t => [t.id, t]));

/* ------------------------------------------------------------ 逐题定档 */
const CLASS = {
  /* (a) 应救回：本卡已实现（解析增强后挂载，零点/顶点就是答案） */
  cnm_222_q4: ['a', '乘积式方程：(2x-1)(x+1)=2 展开为 2x²+x-3，零点 1、-3/2 正是答案',
    'P1 乘积式展开'],
  cnm_224_q4: ['a', '两边都是表达式：(x-2)²=3(x-2) 移项展开为 x²-7x+10，零点 2、5 正是答案',
    'P2 两边表达式移项展开'],
  cnm_236_q2: ['a', '题面直接给出 h=-5t²+20t，顶点 (2,20) 的纵坐标 20 就是"最大高度"',
    'P3 变量名不是 x/y 的二次式'],

  /* (c) 存疑：答案确实是画板标注量，但函数要解方程组/建模才拿得到 */
  cnm_207_q4: ['c', '答案 a=2 就是所求直线的 x 轴交点横坐标（y=-2x+4 的绿点标 (2,0)），语义成立；但函数要由 (1,2)、(3,-2) 待定系数解出',
    '待定系数解方程组'],
  cnm_233_q4: ['c', '答案 4 就是抛物线顶点纵坐标（画板红点会标出来），但函数要由两个 x 轴交点 + 一个已知点解出',
    '待定系数解方程组'],
  cnm_236_q1: ['c', '答案 450 是日利润最大值＝利润函数顶点纵坐标；但利润函数须把"进价 20、日销量 100-2x"建模成 (x-20)(100-2x)',
    '文字条件建模成函数'],
  cnm_236_q3: ['c', '答案 112.5 是菜园面积最大值＝面积函数顶点纵坐标；面积函数须由"30 m 篱笆一面靠墙"建模成 x(30-2x)',
    '文字条件建模成函数'],

  /* (b) 不该挂 */
  cnm_200_q1: ['b', '答案 3 是解析式系数 k（题面只给 y=kx 与一个点），画板标的是截距/交点，不标 k', ''],
  cnm_200_q2: ['b', '选择题答"哪个是正比例函数"，是分类判断，画板不标选项', ''],
  cnm_200_q3: ['b', '求 x=5 时的函数值（-20），画板只标截距，不标任意点的函数值', ''],
  cnm_200_q4: ['b', '答案 -2 是参数 m 的值（由幂指数条件反推）', ''],
  cnm_201_q1: ['b', '答参数范围 m≠1', ''],
  cnm_201_q2: ['b', '选择题分类判断', ''],
  cnm_201_q3: ['b', '答案 2 是参数 m 的值', ''],
  cnm_201_q4: ['b', '答案 -1 是参数 a 的值', ''],
  cnm_203_q3: ['b', '答的是 k、b 的符号组合（象限判断），且题面未给具体 k、b，画板无从画起', ''],
  cnm_203_q5: ['b', '答整数 m 的最大值（增减性约束），是参数范围', ''],
  cnm_205_q1: ['b', '答案是解析式 y=2x+1：画板画曲线，不把解析式当"标注出来的量"；且函数未给出，需待定系数', ''],
  cnm_205_q2: ['b', '答案 3 是斜率 k；画板标的是 y 轴截距 (0,-2) 与 x 轴交点，不含 k', ''],
  cnm_205_q3: ['b', '答案 -2、5 含斜率 k=-2（非标注量），只有 b=5 是截距；且需待定系数', ''],
  cnm_205_q4: ['b', '选择题答解析式（选项），属表达式/分类答案', ''],
  cnm_206_q3: ['b', '只给一个 x 轴交点 (-2,0)、斜率未知，直线不唯一 —— 画板必须臆造 k 才能画', ''],
  cnm_206_q4: ['b', '答案 2 是斜率 k', ''],
  cnm_209_q1: ['b', '应用题：需先建模，且答案是解析式 y=2x+4', ''],
  cnm_209_q2: ['b', '答案 13 是函数值（弹簧长度），非标注量', ''],
  cnm_209_q3: ['b', '答案 300 是反解出的通话分钟数（函数值对应的自变量）', ''],
  cnm_209_q4: ['b', '答案是满足不等式的最小整数次数（计数）', ''],
  cnm_209_q5: ['b', '选择题答解析式（分段计费的化简结果）', ''],
  cnm_220_q4: ['b', '答 k 的取值范围（有两个不相等实根的条件）', ''],
  cnm_223_q4: ['b', '答整数 k 的最大值（判别式约束下的参数范围）', ''],
  cnm_229_q1: ['b', '答参数范围 m≠2（二次函数定义）', ''],
  cnm_229_q2: ['b', '选择题分类判断（哪个是二次函数）', ''],
  cnm_229_q3: ['b', '答二次项系数、一次项系数（-1、10），是形态参数', ''],
  cnm_229_q4: ['b', '答案 2 是参数 m 的值（幂指数条件）', ''],
  cnm_230_q3: ['b', '比较四条抛物线的开口大小，答案是对 |a| 的判断；画板不标 |a|，也不便四条同屏', ''],
  cnm_231_q4: ['b', '答案 2 是参数 a 的值（顶点式待定系数）', ''],
  cnm_233_q1: ['b', '答 a、b、c 三个系数（1、-2、-3），是形态参数', ''],
  cnm_233_q2: ['b', '答案 2 是参数 a 的值', ''],
  cnm_233_q3: ['b', '答 a、b、c 三个系数（-2、-4、0）', ''],
  cnm_236_q4: ['b', '顶点横坐标 55 落在 30≤x≤50 之外，画板会标顶点 (55,1250)，与答案 1200 数值对不上 → 挂上去反而误导', ''],
  cnm_236_q5: ['b', '答案 16 是"水面宽"（y=-8 处两交点间距），画板只标 y=0 处的交点；且 y=-x²/8 的系数不能近似成 -x²', ''],
  cnm_237_q1: ['b', '答案 6 是参数 k（由过点条件反推）', ''],
  cnm_237_q2: ['b', '选择题分类判断（哪个是反比例函数）', ''],
  cnm_237_q3: ['b', '答案 1 是参数 m 的值（幂指数条件）', ''],
  cnm_237_q4: ['b', '答案 3 是 x=-4 时的函数值', ''],
  cnm_238_q4: ['b', '答整数 m 的最大值（每象限内增减性约束）', ''],
  cnm_239_q3: ['b', '答案 -8 是参数 k 的数值；画板对反比例只标象限，不标 k', ''],
  cnm_240_q1: ['b', '选择题答解析式 y=-6/x（选项）', ''],
  cnm_240_q2: ['b', '答案 -8 是参数 k', ''],
  cnm_240_q3: ['b', '答"哪个点也在图象上"（分类判断）', ''],
  cnm_240_q4: ['b', '答案 -9 是参数 m 的值', ''],
  cnm_242_q1: ['b', '选择题答解析式 y=12/x（选项）', ''],
  cnm_242_q3: ['b', '答案 200 是 S=0.5 时的函数值（压强）', ''],
  cnm_242_q4: ['b', '答注水速度的下限（不等式参数范围 15）', '']
};

/* ------------------------------------------------------------ 收集 54 题 */
/* 基线 54 题：B 卡（commit cb57411，`node scripts/fromprompt_gaps.js`）在**本卡改动前**
 * 复跑得到的快照，冻结在这里，保证文档始终描述同一批题。
 * 当前解析器只用来核对状态（(a) 类应已解析、(b)(c) 类应仍未解析），不参与选集合。 */
const BASELINE_54 = [
  'cnm_200_q1', 'cnm_200_q2', 'cnm_200_q3', 'cnm_200_q4',
  'cnm_201_q1', 'cnm_201_q2', 'cnm_201_q3', 'cnm_201_q4',
  'cnm_203_q3', 'cnm_203_q5',
  'cnm_205_q1', 'cnm_205_q2', 'cnm_205_q3', 'cnm_205_q4',
  'cnm_206_q3', 'cnm_206_q4',
  'cnm_207_q4',
  'cnm_209_q1', 'cnm_209_q2', 'cnm_209_q3', 'cnm_209_q4', 'cnm_209_q5',
  'cnm_220_q4',
  'cnm_222_q4',
  'cnm_223_q4',
  'cnm_224_q4',
  'cnm_229_q1', 'cnm_229_q2', 'cnm_229_q3', 'cnm_229_q4',
  'cnm_230_q3',
  'cnm_231_q4',
  'cnm_233_q1', 'cnm_233_q2', 'cnm_233_q3', 'cnm_233_q4',
  'cnm_236_q1', 'cnm_236_q2', 'cnm_236_q3', 'cnm_236_q4', 'cnm_236_q5',
  'cnm_237_q1', 'cnm_237_q2', 'cnm_237_q3', 'cnm_237_q4',
  'cnm_238_q4',
  'cnm_239_q3',
  'cnm_240_q1', 'cnm_240_q2', 'cnm_240_q3', 'cnm_240_q4',
  'cnm_242_q1', 'cnm_242_q3', 'cnm_242_q4'
];

const gaps = [];
const missing = [];
BASELINE_54.forEach(id => {
  const q = QMAP.get(id);
  if (!q) { missing.push(id); return; }
  const t = TOPIC.get(q.topicId) || {};
  gaps.push({ q: q, topic: t, kind: F.topicKind(q.topicId) });
});
if (missing.length) {
  console.error('题库里找不到基线题：' + missing.join(', '));
  process.exit(1);
}

const cls = { a: [], b: [], c: [] };
const unclassified = [];
gaps.forEach(g => {
  const c = CLASS[g.q.id];
  if (!c) { unclassified.push(g.q.id); return; }
  cls[c[0]].push({ g: g, why: c[1], pattern: c[2] || '' });
});
if (unclassified.length) {
  console.error('未定档的题（必须先逐条归类）：' + unclassified.join(', '));
  process.exit(1);
}
const extra = Object.keys(CLASS).filter(id => !gaps.some(g => g.q.id === id));
if (extra.length) {
  console.error('CLASS 表里有、但不属于这 54 题的 id：' + extra.join(', '));
  process.exit(1);
}

/* 状态核对：(a) 类必须已解析且能挂载；(b)(c) 类必须仍未解析（否则定档与实现不一致） */
const stateErr = [];
cls.a.forEach(x => {
  if (!F.fromPrompt(x.g.q.prompt)) stateErr.push(x.g.q.id + ' 归为 (a) 但当前仍解析不出');
  if (!F.labFor(x.g.q.topicId, x.g.q.prompt, { itemId: x.g.q.id })) stateErr.push(x.g.q.id + ' 归为 (a) 但当前仍不挂载');
});
cls.b.concat(cls.c).forEach(x => {
  if (F.fromPrompt(x.g.q.prompt)) stateErr.push(x.g.q.id + ' 归为 (b)/(c) 但当前解析出了函数');
});
if (stateErr.length) {
  console.error('定档与实现不一致：\n  ' + stateErr.join('\n  '));
  process.exit(1);
}

/* ------------------------------------------------------------ 输出 markdown */
const clip = (s, n) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
const esc = s => String(s == null ? '' : s).replace(/\|/g, '\\|');
const row = arr => '| ' + arr.map(esc).join(' | ') + ' |';
const head = arr => [row(arr), '|' + arr.map(() => ' --- ').join('|') + '|'];

const out = [];
const say = s => out.push(s == null ? '' : s);

say('# fromPrompt 解析缺口清单（E 卡）');
say('');
say('> 本文由 `node scripts/fromprompt_gaps_doc.js` 生成，题面/答案直取 `data/questions.json`（不手抄）。');
say('> 收集口径：属 `topicKind()` 白名单的 29 个知识点、且 `labFor()` 返回 `null` 的题 —— 与 B 卡');
say('> （`docs/funclab-coverage.md`）的"支持章节内被挡下的 62 题里 54 题解析不出函数"同源。');
say('');
say('判定口径沿用 B 卡：**答案必须是画板真会标出来的量**。');
say('');
say('- 二次：顶点 (h, k) 的横/纵坐标，或与 x 轴交点（根）');
say('- 一次：y 轴截距 b，或与 x 轴交点');
say('- 反比例：象限位置，或 |k| 表达的离轴远近');
say('');
say('## 结论');
say('');
say('| 类别 | 题数 | 含义 | 本卡处理 |');
say('| --- | --- | --- | --- |');
say('| (a) 应救回 | ' + cls.a.length + ' | 题面给了可确定的函数（只是写法超出解析器），答案是画板标注量 | **已实现，全部救回** |');
say('| (b) 不该挂 | ' + cls.b.length + ' | 答案不是标注量（系数/参数/范围/计数/分类/函数值/表达式/几何量），或题面条件不足 | 不救，逐条给理由 |');
say('| (c) 存疑 | ' + cls.c.length + ' | 答案是标注量，但函数需解方程组或文字建模才拿得到 | **不自行放行**，等人工定档 |');
say('| 合计 | ' + gaps.length + ' | | |');
say('');
say('净效果：可挂画板题数 **58 → 60**（救回 ' + cls.a.length + ' 题，同时撤回 1 题存量误挂，见文末）。');
say('');
say('**这套清单推翻了卡面预期**：原以为 54 题里"语义上确实该挂"的是多数，实测只有 ' + cls.a.length +
  ' 题（' + (cls.a.length / gaps.length * 100).toFixed(1) + '%）。47 题（' +
  (cls.b.length / gaps.length * 100).toFixed(1) + '%）的答案与图像无关 —— 与 B 卡"R2 解析命中 195 题但 163 题答案与图像无关"是同一个现象：');
say('解析不是唯一瓶颈，**答案语义**才是。');
say('');

['a', 'b', 'c'].forEach(k => {
  const title = { a: '## (a) 应救回 —— 本卡已实现（' + cls.a.length + ' 题）',
    b: '## (b) 不该挂 —— 不救（' + cls.b.length + ' 题）',
    c: '## (c) 存疑 —— 不自行放行，等人工定档（' + cls.c.length + ' 题）' }[k];
  say(title);
  say('');
  const cols = k === 'a'
    ? ['题 id', '知识点', '题面', '参考答案', '新增解析路径', '画板标注对上的量']
    : ['题 id', '知识点', '题面', '参考答案', k === 'b' ? '不救的理由' : '存疑原因（需要人工定档的问题）'];
  say(head(cols).join('\n'));
  cls[k].forEach(x => {
    const g = x.g;
    const base = [g.q.id, g.q.topicId + ' ' + (g.topic.name || ''), clip(g.q.prompt, 60), clip(g.q.answer, 16)];
    if (k === 'a') say(row(base.concat([x.pattern, x.why])));
    else say(row(base.concat([x.why])));
  });
  say('');
});

say('## 附 1：(a) 类救回后画板与答案的对应关系');
say('');
say('| 题 id | 画板函数 | 画板标注 | 题库答案 |');
say('| --- | --- | --- | --- |');
cls.a.forEach(x => {
  const p = F.labFor(x.g.q.topicId, x.g.q.prompt, { itemId: x.g.q.id });
  const roots = Math.abs(p.a) > 0 && -p.k / p.a >= 0
    ? (Math.sqrt(-p.k / p.a) === 0 ? 'x=' + p.h : 'x=' + (p.h - Math.sqrt(-p.k / p.a)) + '、x=' + (p.h + Math.sqrt(-p.k / p.a)))
    : '与 x 轴无交点';
  const marked = x.g.q.id === 'cnm_236_q2'
    ? '顶点 (' + p.h + ', ' + p.k + ')'
    : '顶点 (' + p.h + ', ' + p.k + ')、交点 ' + roots;
  say(row([x.g.q.id, F.formatFormula(p), marked, String(x.g.q.answer)]));
});
say('');

say('## 附 2：解析增强的副作用（逐条核过，全部是收紧方向）');
say('');
say('| 题 id | 变化 | 说明 |');
say('| --- | --- | --- |');
say('| cnm_222_q4 | null → 挂载 | (a) 类救回 |');
say('| cnm_224_q4 | null → 挂载 | (a) 类救回 |');
say('| cnm_236_q2 | null → 挂载 | (a) 类救回 |');
say('| cnm_223_q1 | 解析出 a=1,h=2,k=-3 → null | 「x²-4x+k=0」里 k 未知，旧解析把悬空的 `+` 当常数项 1，画出 x²-4x+1 的错曲线；该章本就整章不挂（门禁未动），仅解析变干净 |');
say('| cnm_234_q4 | 挂载 → null（本次唯一减少的挂载） | 「y=x²-2x+m」里 m 未知，旧解析把悬空的 `+` 当常数项 1，画出的曲线（零点 0、2）与答案（m=-3、另一根 -1）无关，属**存量误挂**；本次新增的"多项式后挂字母项即不解析"守卫把它一起撤下 |');
say('| cnm_150_q4 等 31 题 | 旧版解析出乱值 → null | 高中圆方程 `x²+y²=25`、单项式 `-3x²y`、多项式 `x²-3xy+5` 等被旧解析误当抛物线（a/h/k 全是乱值），本次收紧后一律 null；这些知识点不在白名单内，从未挂载 |');
say('');
say('> 关于 cnm_234_q4：卡面要求"可挂题数只增不减"。这里总数是 58 → 60（+3 救回、-1 撤回存量误挂）。');
say('> 撤回的那题是**画错曲线**的（答案 m=-3、另一根 -1，画板标的是零点 0、2），保留它等于保留一个');
say('> 已知误导；如要求严格只增不减，把新增守卫里"多项式后挂字母项即不解析"那一行去掉即可复原。');
say('');

say('## 附 3：卡面点了但本卡没做的两个方向（附理由）');
say('');
say('1. **`y=x²` 平移描述**（题干只给原函数 + "向左 2 向下 3"）：29 个知识点内没有这种题落在解析缺口上。');
say('   `cnm_231_q3`（抛物线平移）与 `cnm_204_q1`（直线平移）目前解析的是**平移前**的式子并且已经挂载，');
say('   改解析会改变存量挂载点（`cnm_204_q1` 答案 y=2x+3 而画板画 y=2x，属 B 卡记录的存量误挂），');
say('   这已超出"解析增强"范围，应单独立卡按"平移也要解析"逐题定档，本卡不动。');
say('2. **中文系数描述**（"负二分之一 x 的平方"）：全库扫过，没有这种写法的函数题');
say('   （唯一命中的是中小学数学题 `cnm_016_q4`，与函数无关），无真实题面可写测试，按"题面必须取自题库"的约定不做。');
say('');

say('## 附 4：复跑方式');
say('');
say('```bash');
say('node scripts/fromprompt_gaps.js          # 列 54 题原始清单（id/题面/答案）');
say('node scripts/fromprompt_gaps_doc.js      # 生成本文（分类表在脚本的 CLASS 常量里）');
say('node scripts/measure_funclab_coverage.js # 覆盖率前后对比');
say('node scripts/compare_parse_versions.js <旧版 funclab.js>  # 解析行为逐题 diff');
say('```');

const text = out.join('\n') + '\n';
fs.writeFileSync(path.join(__dirname, '..', 'docs', 'fromprompt-gaps.md'), text);
console.log('写出 docs/fromprompt-gaps.md：' + text.length + ' 字符');
console.log('(a) ' + cls.a.length + ' 题：' + cls.a.map(x => x.g.q.id).join(', '));
console.log('(b) ' + cls.b.length + ' 题');
console.log('(c) ' + cls.c.length + ' 题：' + cls.c.map(x => x.g.q.id).join(', '));
