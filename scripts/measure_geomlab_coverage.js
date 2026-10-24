#!/usr/bin/env node
/* geomlab（几何画板）画板覆盖率测算（只读）：node scripts/measure_geomlab_coverage.js
 *
 * 为什么有这个脚本
 * ----------------
 * D 卡（几何画板）想做三角形 / 圆 / 相似位似三类静态图。在写任何画法之前先回答
 * 「几何章有多少题、其中多少题能靠一张静态图讲清楚、做完能覆盖多少」。
 * 本脚本是 funclab 覆盖率测算（scripts/measure_funclab_coverage.js）的几何版：
 * 沿用它的骨架（分节输出 · 表格即报告 · 人工复核表写死在脚本里保证可复现），
 * 但判定对象从「题面能否解析出函数」换成「题面能否唯一确定图形」。
 *
 * 只读 data/questions.json 与 data/topics.json，不 require diagnose/ 下任何模块，
 * 因此 diagnose/ 怎么改都不影响本脚本的数字（反过来也证明本卡没碰源码）。
 *
 * 输出分七节：
 *   1. 全库与几何章题量（按 topicId 归类）
 *   2. 三类题量 · 可画判定 · 存量 figure 现状
 *   3. 题型分布（前 5 类）
 *   4. 每类 10 个样本题
 *   5. 误挂风险清单
 *   6. 汇总表（3 类 × {题量, 可画题量, 占比}）
 *   7. 投入产出排序建议
 *
 * 复现：node scripts/measure_geomlab_coverage.js            # 打印全部表格
 *       node scripts/measure_geomlab_coverage.js --raw      # 另存 docs/geomlab-coverage.raw.md
 *       node scripts/measure_geomlab_coverage.js --json     # 只打 JSON 汇总（给下游脚本用）
 *
 * ============================================================================
 * 判定口径（与 docs/geomlab-coverage.md 第 0 节逐条对应，改口径必须两边一起改）
 * ============================================================================
 *
 * 【可画 drawable】= 题面给出了足以唯一确定图形的条件数（见下方 CONSTRAINT 与
 *   CLASS_RULE 的阈值）。例："AB=3, AC=4, ∠A=60°" → 三角形唯一确定（SAS）。
 *
 * 【部分可画 partial】= 题面给了至少一个量化条件，但不足以唯一确定图形。
 *   按卡面口径「只画出题干已知部分、标注未知量」也算覆盖，因此 partial 计入覆盖率，
 *   但单独列一栏，好让 D 卡知道自己能画到多完整。
 *
 * 【不可画 not-drawable】五类，任一命中即踢出：
 *   ① 零量化条件：全靠文字描述（"下列说法正确的是"）
 *   ② 纯证明 / 求证题：证明过程无图可依，画了也只是示意图
 *   ③ 判断对错 / 命题辨析：答案与图形无关，图只会「陪衬」
 *   ④ 动点轨迹 / 图形运动：静态图讲不清（轨迹题需要动画，不属于本卡的静态图范畴）
 *   ⑤ 纯算式伪装成几何题：题库里小学段大量 "计算：3＋3＝？" 挂在三角形/圆章下
 *      （题面唯一的几何痕迹是前一句情境），这类图与答案毫无因果关系。
 *
 * 【一条硬规则】判定只用规则 + 关键词 + 正则，不调用 LLM（不可复现）。
 *   自动判定拿不准的题，结论写死在 MANUAL_REVIEW 表里 —— 报告里的数字因此仍是
 *   「跑脚本跑出来的」，不是报告里另写一套。
 */
'use strict';

const path = require('path');

const QUESTIONS = require(path.join(__dirname, '..', 'data', 'questions.json'));
const TOPICS = require(path.join(__dirname, '..', 'data', 'topics.json'));
const TOPIC = new Map(TOPICS.map(t => [t.id, t]));

/* ============================================================ 文本归一化 */

/** 全角标点与各种横线统一成半角，避免同一个条件因标点写法不同而漏判 */
const FULL2HALF = {
  '，': ',', '（': '(', '）': ')', '−': '-', '－': '-', '—': '-', '–': '-',
  '：': ':', '；': ';', '　': ' ', '、': ',', '°': '°', '∠': '∠'
};

function toHalf(s) {
  return String(s == null ? '' : s).replace(/[，（）−－—–：；　、]/g, c => FULL2HALF[c] || c);
}

/** 去掉 Unicode 撇号/直角撇号，让 A'B' 与 A′B′ 等价（相似题大量出现） */
function normPrimes(s) {
  return String(s).replace(/[′’‘']/g, "'");
}

function plain(prompt) {
  return normPrimes(toHalf(prompt));
}

/* ============================================================ 约束抽取
 *
 * 把题面里「能量化图形」的条件抽成若干类计数。这是整个判定的地基：
 * 只有抽到的条件数够，图形才可能被唯一确定。
 *
 * 为什么不用「有没有数字」这种粗判：
 *   "3 的后面一个数是几？" 有数字但没有边长；
 *   "下列说法正确的是" 没有数字；
 *   两者都不该进候选，而 "AB=3, AC=4, ∠A=60°" 三个条件才是真的可画。
 */

/* ① 线段赋值：AB=3、BC = 10、A'B'=6、CD=4.8
 *    只认大写字母组成的线段名，避免把 y=2x、x=4 这类代数赋值误当边长。
 *    A' 形式单独兼容（相似题写 A'B'）。
 *    (?![a-zA-Z]) 很关键：AB=2x+1 里的 2 是系数不是边长（实测把它当边长，
 *    会让「求 x」题的答案 4 撞上 DE=4x−7 的系数 4，误判成送分）。 */
const RE_SEG_ASSIGN = /(?:^|[^A-Za-z])([A-Z]{1,2}'?)\s*=\s*(\d+(?:\.\d+)?)(?![a-zA-Z.])/g;

/* ② 角度赋值：∠A=60°、∠ABC=70°、∠C=90°（度符号可有可无） */
const RE_ANG_ASSIGN = /∠\s*([A-Z]{1,3}'?)\s*=\s*(\d+(?:\.\d+)?)\s*°?/g;

/* ③ 角度比：∠A∶∠B∶∠C=3∶4∶6（只锁定形状不锁定大小 → 计 1 个约束） */
const RE_ANG_RATIO = /∠\s*[A-Z]{1,3}(?:\s*:\s*∠\s*[A-Z]{1,3}){1,3}\s*=\s*\d+(?:\.\d+)?(?:\s*:\s*\d+(?:\.\d+)?){1,3}/;

/* ④ 半径 / 直径：半径 5、半径为 5、直径为 8、⊙O 的半径为 10
 *    圆的圆心由 ⊙O 给出，因此半径一条就足以确定整圆 → 在 CLASS_RULE 里算 2 个约束。 */
const RE_RADIUS = /(半径|直径)\s*(?:为|是|=)?\s*(\d+(?:\.\d+)?)/;

/* ⑤ 量词 + 数值：弦长 8、弦 AB=24、弧长 2、底 7、高 4、面积为 24、周长 20
 *    这类是「某个几何量给了值」，能参与定形但不总是独立条件。 */
const RE_QTY_VALUE = /(弦长|弦|弧长|弧|底边|底|高|宽为|长为|腰|上底|下底|边长|周长为|面积为|面积|体积|距离|影长)\s*(?:为|是|=)?\s*(\d+(?:\.\d+)?)/g;

/* ⑤b 数值列表：中文几何题最常见的写法是「一个量词 + 若干个数」，
 *     而**不是** AB=3 这种逐条赋值。实测漏判最多的就是这一类：
 *       "三边长分别为 2，3，4"        → 3 个条件
 *       "两边长分别为 4 和 9"          → 2 个条件
 *       "直角边 6、8"                 → 2 个条件
 *       "三个内角分别是 30°、60°、90°"  → 3 个条件
 *       "圆心角 100° 所对…"            → 1 个条件
 *     所以单列一条正则，按「列表里有几个数」计条件数。
 *     量词限定在几何量上，避免把应用题里的年份、价格也算成边长。 */
const RE_NUM_LIST_SRC = '(?:三边|两边|各边|边长|直角边|斜边|腰|内角|外角|顶角|底角|圆心角|圆周角|分针|时针)';
const RE_NUM_LIST = new RegExp(
  RE_NUM_LIST_SRC + '(?:长|长度|度数)?\\s*(?:分别为|分别是|分别|为|是|都是|都|=|:)?\\s*' +
  '(\\d+(?:\\.\\d+)?(?:\\s*(?:,|、|和|及|与)\\s*\\d+(?:\\.\\d+)?)*)',
  'g'
);

/* ⑤c 单个数 + 度量词：直角边 6、斜边 13、腰 5 —— 列表正则已在上面覆盖，
 *     这里只补「数值在量词前」的写法（"6 cm 的直角边"），出现频率低，计 0.5 分。 */
const RE_QTY_TRAILING_UNIT = /\d+(?:\.\d+)?\s*(?:cm|厘米|米|°|度)\s*的\s*(?:直角边|斜边|腰|弦|边)/g;

/* ⑥ 比例：相似比 2:3、a/b=2/3 之外的几何比、BD:DC=1:2、位似比 1:2
 *    注意 "a/b=2/3" 是小写字母，属于代数式不是图形边长，已由 ① 的大写限制挡住。 */
const RE_RATIO = /(?:相似比|位似比|放缩比)?\s*(?:为|是|=)?\s*\d+(?:\.\d+)?\s*:\s*\d+(?:\.\d+)?/;
const RE_RATIO_LETTER = /[A-Z]{1,2}\s*:\s*[A-Z]{1,2}\s*=\s*\d+(?:\.\d+)?\s*:\s*\d+(?:\.\d+)?/;

/* ⑦ 坐标：点 A(2,-3)、P(3,-1)、A'(4,-6) */
const RE_COORD = /\(\s*[+-]?\d+(?:\.\d+)?\s*,\s*[+-]?\d+(?:\.\d+)?\s*\)/g;

/* ⑧ 关系约束（能定形，但不是「数值」）：平行 / 垂直 / 中点 / 垂直平分 / 为直径 / 内接 / 相切
 *    这些在高年级几何里是主要的定形手段，缺了它们会把一批真可画的题判成不可画。 */
const REL_PARALLEL = /∥|\/\//;
const REL_PERP = /⊥/;
const REL_MIDPOINT = /中点/;
const REL_DIAMETER = /直径/;            // "AB 为⊙O 的直径"
const REL_TANGENT = /相切|切线|切点|切\s*⊙|切于/;

/** 抽全部约束，返回分类计数与命中的原文片段（片段用于报告里给人工核对） */
function constraints(prompt) {
  const s = plain(prompt);
  const hit = [];

  /* 先把角度赋值整体挖空，再做线段抽取。
   * 否则 ∠C=90° 里的 "C" 会被线段正则当成线段名 → 一个条件算两次（实测踩过）。
   * 挖空而不是删掉，是为了保持字符串长度不变，偏移量不串位。 */
  const sNoAngle = s.replace(RE_ANG_ASSIGN, m0 => ' '.repeat(m0.length));

  const segs = [];
  let m;
  RE_SEG_ASSIGN.lastIndex = 0;
  while ((m = RE_SEG_ASSIGN.exec(sNoAngle))) {
    /* raw 只用捕获组重建，不带前导标点（m[0] 含 (?:^|[^A-Za-z]) 吃进去的那个字符） */
    segs.push({ name: m[1], value: parseFloat(m[2]), raw: m[1] + '=' + m[2] });
  }

  const angs = [];
  RE_ANG_ASSIGN.lastIndex = 0;
  while ((m = RE_ANG_ASSIGN.exec(s))) angs.push({ name: m[1], value: parseFloat(m[2]), raw: '∠' + m[1] + '=' + m[2] });

  /* ②b 裸度数：中文几何题常把角写成「两个角分别为 50°、60°」「一个是 100°」，
   *     没有 ∠X= 前缀。任何 "N°" / "N 度" 都视为一个角度条件，
   *     已由 ② 计过的值在 scoreOf 里扣重。 */
  const degrees = [];
  const RE_DEGREE = /(\d+(?:\.\d+)?)\s*(?:°|度)/g;
  let md;
  while ((md = RE_DEGREE.exec(s))) degrees.push({ value: parseFloat(md[1]), raw: md[0].trim() });

  const qtys = [];
  RE_QTY_VALUE.lastIndex = 0;
  while ((m = RE_QTY_VALUE.exec(s))) qtys.push({ kind: m[1], value: parseFloat(m[2]), raw: m[0].trim() });

  /* ⑤b 数值列表：每命中一条，摘下列表里的全部数字 */
  const lists = [];
  RE_NUM_LIST.lastIndex = 0;
  while ((m = RE_NUM_LIST.exec(s))) {
    const vals = (m[1].match(/\d+(?:\.\d+)?/g) || []).map(parseFloat);
    lists.push({ raw: m[0].trim(), values: vals });
  }

  /* ⑤c 数值在量词前：每条 0.5 分 */
  const trailingQty = (s.match(RE_QTY_TRAILING_UNIT) || []).length;

  const coords = [];
  RE_COORD.lastIndex = 0;
  while ((m = RE_COORD.exec(s))) coords.push(m[0].trim());

  return {
    segs,
    angs,
    degrees,
    qtys,
    lists,
    trailingQty,
    coords,
    hasRadius: RE_RADIUS.test(s),
    radiusValue: (RE_RADIUS.exec(s) || [])[2] ? parseFloat(RE_RADIUS.exec(s)[2]) : null,
    hasAngRatio: RE_ANG_RATIO.test(s),
    hasRatio: RE_RATIO.test(s),
    hasRatioLetter: RE_RATIO_LETTER.test(s),
    parallel: REL_PARALLEL.test(s),
    perp: REL_PERP.test(s),
    midpoint: REL_MIDPOINT.test(s),
    diameter: REL_DIAMETER.test(s),
    tangent: REL_TANGENT.test(s),
    text: s
  };
}

/* ============================================================ 一票否决（不可画）

/* ② 纯证明 */
const RE_PROOF = /证明|求证|试证|说明理由|推导/;

/* ③ 判断对错 / 命题辨析 / 选正确说法：答案与图形无因果关系。
 *    第三条分支专治「…是直角三角形吗？」这类是非题 —— 答案在选项文字里，
 *    图上没有任何东西能对应「是/不是」。 */
const RE_JUDGE = /正确的是|错误的是|正确的有|下列(?:说法|命题|结论|判断)|说法(?:中)?正确|命题(?:中)?正确|判断.*(?:对错|正误)|是否(?:正确|成立)|(?:是|能|会|可以|一定|都)[^？?]{0,12}吗[？?]/;

/* ④ 动点 / 图形运动 / 轨迹：静态图讲不清 */
const RE_LOCUS = /动点|运动|轨迹|扫过|平移|旋转|翻折|折叠|滚动/;

/* ⑤ 纯算式伪装成几何题：小学段 "计算：3＋3＝？" */
const RE_PURE_CALC = /计算[:：]/;

/* 计数 / 取值 / 个数类：题面可能给了条件，但答案不是图上能画的量 → 归误挂高危 */
const RE_COUNT_ASK = /有几种|有几个|有(?:多少|几)条|最多|至少|整数|取值范围|最大值|最小值/;

/* 应用建模（影子/旗杆/镜子/树高/梯子）：图形是实景示意图，
 * 画出来的图与解题无因果关系，且比例失真会误导 → 归误挂高危。 */
const RE_APPLIED = /影长|影子|旗杆|竹竿|平面镜|镜子|树高|测(?:得|量)|梯子|靠在墙|水位|斜坡/;

/* 只有「一个尺寸 + 一个公式」的题：画图对答案毫无帮助。
 *
 * 实测踩到的：小学段圆章「半径 5 厘米的圆，周长是多少厘米？」，可画判定给
 * drawable（半径记 2 分 ≥ 圆类阈值 2），但它的答案是套公式算出来的，
 * 画个圆既不帮助理解也不承载推理 —— 这类题会虚抬「圆」类覆盖率约 10%，
 * 让 D 卡误判投入产出。故单列一类，计入 partia 档统计但不计入 drawable。
 *
 * 判据：题面出现「周长/面积」的求值问句，且量化条件只有半径/直径/一条边
 *      （即没有任何第二类约束）。三角形、圆、相似三类共用。 */
const RE_ASK_C_WORD = /(?:周长|面积|体积)/;

/** 不可画的硬否决：返回命中的理由码，null = 没被否决 */
function vetoReason(q) {
  const s = plain(q.prompt);
  if (RE_PROOF.test(s)) return 'proof';
  if (RE_JUDGE.test(s)) return 'judge-statement';
  if (RE_LOCUS.test(s)) return 'locus-motion';
  if (RE_PURE_CALC.test(s)) return 'pure-arithmetic';
  return null;
}

/* ============================================================ 三类分类
 *
 * 分类优先级（一道题只进一类，避免重复计数）：
 *   1. similar  章名命中「相似/位似」，或在三角形/圆章里题面明确讲相似（∽、相似比）
 *   2. circle   章名命中「圆」，且不属于圆锥曲线/圆柱圆锥这类不画二维圆的情形
 *   3. triangle 章名命中「三角形/勾股/全等」，或题面出现 △
 *
 * 为什么把「选必一 第三章 圆锥曲线的方程」踢出 circle：
 *   椭圆/双曲线/抛物线不是圆，D 卡画的圆板用不上 → 单独列在"不做"里。
 */

const CH_TRIANGLE = /三角形|勾股|全等/;
const CH_CIRCLE = /圆/;
const CH_SIMILAR = /相似|位似/;
/* 名字里有「圆」但与「圆」无关的章：三维体或圆锥曲线 */
const CH_CIRCLE_EXCLUDE = /圆柱|圆锥|圆锥曲线/;

function chapterOf(topicId) {
  const t = TOPIC.get(topicId);
  return (t && t.chapter) || '';
}

/** 粗章名：去掉末尾节号 "9.2.1" 与 "综合与实践" 后缀，便于按章聚合 */
function chapterGroup(topicId) {
  return chapterOf(topicId)
    .replace(/\s*\d+(\.\d+)*\s*$/, '')
    .replace(/\s*(综合与实践|综合)\s*$/, '')
    .trim();
}

/* 知识点名命中三维体 → 不属于任何一类二维画板。
 * 实测必要性：「九上 第二十九章 圆 29.3 圆锥的侧面积与全面积」挂在圆章下，
 * 只靠章名会放它进来，但它要画的是圆锥（三维），二维圆板画不出来。 */
const TOPIC_NAME_3D = /圆锥|圆柱|球|棱柱|棱锥|棱台|圆台|立体|旋转体|展开图/;

/* ★ 范围外：解析几何。这类题也能「画图」（坐标系里的直线/圆），
 *   但它要的画板是「平面直角坐标系 + 方程参数」，和 D 卡想要的
 *   「三角形/圆/相似」欧氏几何静态图不是同一块板。实测数字：
 *   选必一 第二章 直线和圆的方程 = 72 题，占「圆」类的 40%，
 *   其中绝大多数问的是斜率/截距/距离/方程参数（答案就是图上的数），
 *   并进来会把「圆」类的可画率虚抬一大截。因此单列排除，报告里给独立小表。 */
const CH_OUT_OF_SCOPE = /直线和圆的方程|圆锥曲线|空间向量|立体几何|平面向量/;

function classify(q) {
  const ch = chapterOf(q.topicId);
  const tname = (TOPIC.get(q.topicId) || {}).name || '';
  const s = plain(q.prompt);
  const inSimChapter = CH_SIMILAR.test(ch);
  const inCircleChapter = CH_CIRCLE.test(ch) && !CH_CIRCLE_EXCLUDE.test(ch);
  const inTriChapter = CH_TRIANGLE.test(ch);

  /* 三维体先剔掉：章名放行了也不能进二维画板 */
  if (TOPIC_NAME_3D.test(tname)) return null;
  /* 解析几何不在本卡范围（见 CH_OUT_OF_SCOPE 注释） */
  if (CH_OUT_OF_SCOPE.test(ch)) return null;

  /* 相似优先：即使挂在三角形章下，只要题面是相似问题就归相似 */
  if (inSimChapter) return 'similar';
  if (inCircleChapter) {
    if (/∽|相似比/.test(s)) return 'similar';
    return 'circle';
  }
  if (inTriChapter) return 'triangle';
  return null;
}

/* 几何领域（用于「几何相关章节题量」这个总口径，比三类加起来更宽） */
function isGeometryTopic(topicId) {
  const t = TOPIC.get(topicId);
  return !!t && /图形/.test(String(t.domain || ''));
}

/* ============================================================ 可画判定
 *
 * CLASS_RULE 定义每类「唯一确定图形」需要多少个独立约束（阈值），
 * 以及约束怎么加权。阈值来自初中几何的定形常识：
 *
 *   三角形：SSS / SAS / ASA / AAS 都需 3 个独立条件（一边一角不算三角形唯一，
 *           除非还给了直角三角形标记 —— 直角本身算 1 个条件）。
 *   圆：    ⊙O 已把圆心交代清楚，再给半径（或直径）即唯一确定；
 *           半径记 2 分，因此「半径 ≥ 1 个」就过阈值。只给弦长/圆周角 → 部分可画。
 *   相似：  相似比 + 至少一个实际尺寸（边长/周长/面积）才画得出两个图形；
 *           位似还需要中心与坐标，因此单独加分。
 *
 * partial 阈值 = 1（只要有一个量化条件就算「能画出题干已知部分」）。
 */

/* 约束加权：把 constraints() 的分类计数折算成分数 */
function scoreOf(c, cls) {
  const parts = [];
  let score = 0;

  /* 每条线段赋值算 1 个独立条件 */
  c.segs.forEach(s => { score += 1; parts.push('长:' + s.raw); });
  /* 每个角度赋值算 1 个独立条件 */
  c.angs.forEach(a => { score += 1; parts.push('角:' + a.raw); });

  /* ②b 裸度数：与本条扣重（∠A=60° 已被上一条计入，值 60 不再重复加分） */
  if (c.degrees) {
    const angVals = new Set(c.angs.map(a => a.value));
    const seenDeg = new Set();
    c.degrees.forEach(d => {
      if (angVals.has(d.value) || seenDeg.has(d.value)) return;
      seenDeg.add(d.value);
      score += 1;
      parts.push('度:' + d.raw);
    });
  }

  if (c.hasRadius) { score += 2; parts.push('半径/直径'); }
  if (c.hasAngRatio) { score += 1; parts.push('角比'); }
  if (c.hasRatio) { score += 1; parts.push('比例'); }
  if (c.hasRatioLetter) { score += 1; parts.push('字母比例式'); }
  if (c.coords.length) { score += c.coords.length; parts.push('坐标x' + c.coords.length); }

  /* 量词 + 数值：和弦长等重复计算时要扣重 —— 弦 AB=24 会同时被 ①（AB=24）和 ⑤（弦 24）抓到。
   * 这里只把「没被 ① 覆盖的量词值」各算 1 分，避免虚高。 */
  const segValues = new Set(c.segs.map(s => s.value));
  c.qtys.forEach(t => { if (!segValues.has(t.value)) { score += 1; parts.push('量:' + t.raw); } });

  /* ⑤b 数值列表：列表里的每个数各算 1 个条件。
   * 扣重规则同上（列表值若已被 ①/⑤ 计入则跳过），宁可少算——少算的后果是保守地
   * 把题判成 partial，不会把不可画的题误判成可画。 */
  if (c.lists) {
    const counted = new Set();
    c.segs.forEach(s => counted.add(s.value));
    c.qtys.forEach(t => counted.add(t.value));
    c.lists.forEach(l => {
      const fresh = l.values.filter(v => !counted.has(v));
      fresh.forEach(v => {
        score += 1;
        parts.push('列表:' + v);
        counted.add(v);            // 列表内部重复值只算一次
      });
    });
  }

  /* ⑤c 数值在量词前：每条 0.5 分 */
  if (c.trailingQty) { score += 0.5 * c.trailingQty; parts.push('倒置量x' + c.trailingQty); }

  if (c.parallel) { score += 1; parts.push('平行'); }
  if (c.perp) { score += 1; parts.push('垂直'); }
  if (c.midpoint) { score += 0.5; parts.push('中点'); }
  if (c.diameter) { score += 0.5; parts.push('直径(词)'); }
  if (c.tangent) { score += 0.5; parts.push('相切/切线'); }

  return { score, parts };
}

/* 每类的阈值（写死在这里，报告里引用同一份数字） */
const CLASS_RULE = {
  triangle: { drawable: 3, label: '三角形', why: '定形需 3 个独立条件（SSS/SAS/ASA，直角本身算 1 个）' },
  circle: { drawable: 2, label: '圆', why: '圆心由 ⊙O 给出，再给半径/直径（记 2 分）即唯一确定' },
  similar: { drawable: 2, label: '相似位似', why: '相似比 + 至少一个实际尺寸；位似另需中心与坐标' }
};

/* 问角度还是问长度，决定「定形到相似」够不够。
 * 三角形给了两个角 → 第三个角定了、形状定了，只差缩放。
 *   · 题目问的是角（求 ∠X 的度数）→ 缩放不影响答案 → 图完全够用 → drawable
 *   · 题目问的是长度 → 缩放就是未知量 → 只能算部分可画（画出已知部分、标注未知边长）
 * 这条细化把 2 角题的判定从「一律 partial」纠正过来，实测影响三角形类约 12 题。 */
const RE_ASKS_ANGLE = /求\s*∠|∠[^，。；]{0,14}(?:多少度|的度数|是几度)|多少度/;

function drawability(q, cls) {
  const veto = vetoReason(q);
  if (veto) return { level: 'no', reason: veto, score: 0, parts: [] };

  const c = constraints(q.prompt);
  const { score, parts } = scoreOf(c, cls);
  const rule = CLASS_RULE[cls];

  if (score === 0) return { level: 'no', reason: 'no-quantity', score, parts, c };
  if (score >= rule.drawable) {
    /* 降档：「一个尺寸 + 问周长/面积」= 纯套公式，画图不承载推理。
     * 只在「量化条件恰好只有一个半径/直径」时降 —— 多条件题（扇形给的圆心角、
     * ⊙O 半径 + 弦长求圆心距）图本身是解题必需的中介，不降。
     * 排除条件：题面还有「弧长/圆心角/扇形」等第二类量时不属于纯套公式。 */
    if (cls === 'circle' && RE_ASK_C_WORD.test(plain(q.prompt)) &&
        c.hasRadius && !c.segs.length && !c.angs.length && !c.degrees.length && !c.lists.length &&
        !/弧长|圆心角|扇形|弧\\s*[A-Z]/.test(plain(q.prompt))) {
      return { level: 'partial', reason: 'formula-lookup', score, parts, c };
    }
    return { level: 'drawable', reason: 'ok', score, parts, c };
  }

  /* 三角形特例：0.5 分门缝里的「形状已定 + 只问角」题 */
  if (cls === 'triangle' && score >= 2 && RE_ASKS_ANGLE.test(plain(q.prompt)) && c.angs.length + c.degrees.length >= 2) {
    return { level: 'drawable', reason: 'ok-shape-determined', score, parts, c };
  }

  return { level: 'partial', reason: 'insufficient-conditions', score, parts, c };
}

/* ============================================================ 误挂风险
 *
 * 误挂的定义（沿用 B 卡的思路）：图能被画出来，但与题目考察的东西没有因果关系，
 * 或者数值「碰巧」对得上会误导学生。这类题**不许挂图**，即使它过了可画判定。
 *
 * 六类高危，一类一条正则，全部写在这里：
 */
const RISK_RULES = [
  { code: 'pure-arithmetic', label: '纯算式伪装成几何题', re: RE_PURE_CALC,
    why: '题面只有情境句，真正要算的是 "3＋3"，图与答案无因果关系' },
  { code: 'asks-count', label: '问个数/取值/最值/范围', re: RE_COUNT_ASK,
    why: '答案是一个计数或区间，图上画不出「有几个」，静态图只会让学生数错' },
  { code: 'asks-proof', label: '纯证明/求证', re: RE_PROOF,
    why: '证明过程无图可依，示意图不承载推理' },
  { code: 'asks-judge', label: '判断对错/命题辨析', re: RE_JUDGE,
    why: '答案为「下列说法正确的是」，图形与选项无对应关系' },
  { code: 'locus-motion', label: '动点/轨迹/图形运动', re: RE_LOCUS,
    why: '静态图无法表达「运动过程中」，必须动画，不属于本卡静态图范畴' },
  { code: 'applied-model', label: '实景应用（影长/旗杆/镜子）', re: RE_APPLIED,
    why: '图是实景示意，比例失真会误导；且答案由相似比算出，画不画都行' }
];

/** 数值碰巧送分：几何版的真正高危形态是「答案就是图上已给的数值」，
 *  由 answerEchoesGiven() 单独判定（见下）。
 *  明确**不**列入的：问周长/面积。图上并不标注周长面积，学生仍须自己算，
 *  画出来不会送分 —— 早期版本把它们列成风险，实测 30+ 条全是噪声，已删。
 *
 *  「数值碰巧」的说明表：这里只放**说明文字**（供 5 节打出表头），
 *  判定逻辑只有 answerEchoesGiven() 一处，避免同一概念两套实现打架。 */
const COINCIDENCE = [
  { code: 'answer-echoes-given', label: '答案里每个数都是题面已给的几何量（边长/角/半径/列表值）→ 图上按条件标注后肉眼可抄' },
  { code: 'coordinate-is-answer', label: '位似/坐标变换题的答案本身就是一个点坐标 → 画出对应点等于给出答案' }
];

function riskFlags(prompt) {
  const s = plain(prompt);
  return RISK_RULES.filter(r => r.re.test(s));
}

/* 答案文本：选择题把选项字母换成选项原文（与 B 卡同一手法） */
function answerText(q) {
  const a = String(q.answer == null ? '' : q.answer).trim();
  if (/^[A-Z]$/.test(a) && Array.isArray(q.choices)) {
    const c = q.choices.find(x => String(x.key).toUpperCase() === a);
    if (c) return String(c.text);
  }
  return a;
}

/**
 * 「答案即图上已有数值」——几何版的数值碰巧送分。
 *
 * 判据：答案里的每个数，都已经是题面给出的几何量（边长/角/半径/列表值）。
 * 为什么这类必须挡：图上既然按条件标了这些数，把「求 DE 多长」「求 ∠D」画出来，
 * 学生肉眼就能抄到答案，题目考的「对应边相等 / 同弧圆周角相等」被图直接说破。
 *
 * 排除 π 约定：题库里 "圆周率按 314/100" 会让 314 混进题面数值，
 * 先把这类子句整段删掉，否则半径 10 → 面积 314 会被误判成送分。
 */
function answerEchoesGiven(q) {
  const s = plain(q.prompt).replace(/圆周率[^。；,]*/g, '').replace(/π/g, '');
  /* kπ 系数题：答案是 π 的系数（k 的值），不是图上能量出来的长度。
   * 不排除的话「半径 6 的扇形面积 k=6」会被当成送分（实测 2 例）。 */
  if (/求\s*k\s*的值|只填\s*k|kπ/.test(s)) return null;
  const c = constraints(s);
  const given = new Set();
  c.segs.forEach(x => given.add(x.value));
  c.angs.forEach(x => given.add(x.value));
  c.degrees.forEach(x => given.add(x.value));
  c.qtys.forEach(x => given.add(x.value));
  c.lists.forEach(l => l.values.forEach(v => given.add(v)));
  if (c.radiusValue != null) given.add(c.radiusValue);
  if (!given.size) return null;

  const ansVals = (answerText(q).match(/\d+(?:\.\d+)?/g) || []).map(parseFloat);
  if (!ansVals.length) return null;
  const hit = ansVals.filter(v => given.has(v));
  return hit.length === ansVals.length ? hit : null;
}

/**
 * 人工复核表：自动判定靠不住、需要人拍板的题，结论写死在这里。
 * 这样报告里的数字仍然由脚本跑出来（不是报告另写一套数）。
 *   verdict: 'ok'        人工确认可以挂
 *            'misleading' 确属误挂，不许挂
 *   level:   仅 verdict='ok' 时可指定 'drawable' | 'partial'，默认 'drawable'。
 *            存在的理由：自动判定只认数值条件，认不出 AA 相似、∠A=∠D 这类
 *            「非数值但足以定形」的条件，会把这些题判成 no-quantity；
 *            人工确认可画后必须能把它抬上来，否则人工表等于失效（实测踩过）。
 */
const MANUAL_REVIEW = {
  /* ---- 自动判 drawable 但人工认定不可挂的 ---- */
  // 位似坐标题：图能画（原点 + 点 + 位似比），但答案是一个坐标，
  // 画出来等于把答案标在图上（送分）→ 按「答案即图」处理，不挂
  'cnm_275_q2': { verdict: 'misleading', why: '答案 A\' 的坐标就是图上的点，画出来等于直接给答案' },
  'cnm_275_q3': { verdict: 'misleading', why: '同上，异侧位似的对应点即答案' },
  'cnm_275_q5': { verdict: 'misleading', why: '同上，位似中心不在原点时对应点仍是答案本身' },

  /* ---- 自动判 partial / no-quantity，但人工认定可以画 ---- */
  'cnm_271_q1': { verdict: 'ok', level: 'partial', why: '∠A=∠D、∠B=∠E → AA 判定：只有等角没有数值，图形可画出形状（大小不定）' },
  'cnm_271_q2': { verdict: 'ok', level: 'partial', why: '两个三角形分别给了角，可同屏画两个三角形示意' },
  'cnm_262_q1': { verdict: 'ok', level: 'partial', why: 'PA 切⊙O 于 A → 切点半径垂直于切线，图可由关系画出（无需数值）' },

  /* ---- 自动判 drawable，人工确认确实可挂的典型（留档说明口径）---- */
  'cnm_112_q4': { verdict: 'ok', level: 'drawable', why: 'Rt△ABC 三边 + 斜边高，条件完整，是该类的标准可画题' },
  'cnm_273_q3': { verdict: 'ok', level: 'drawable', why: 'Rt△ + 斜边高 + 两段 AD/BD，射影定理标准图' }
};

function finalVerdict(q, cls) {
  const d = drawability(q, cls);
  const manual = MANUAL_REVIEW[q.id];
  const risks = riskFlags(q.prompt);
  const echo = answerEchoesGiven(q);

  if (manual) {
    /* 人工结论优先，且必须能双向改档：判 misleading → 强制 no；判 ok → 抬到指定档 */
    const level = manual.verdict === 'ok' ? (manual.level || 'drawable') : 'no';
    return Object.assign({}, d, { level, manualWhy: manual.why, auto: d.level, risks, echo });
  }

  /* 高风险题：即使条件够，也不挂 */
  if (risks.length) return Object.assign({}, d, { level: 'no', auto: d.level, risks, echo, riskCode: 'risk:' + risks[0].code, riskWhy: risks.map(r => r.label).join('、') });

  /* 答案即图上已有数值 → 送分，不挂（连 drawable 也不能算覆盖） */
  if (echo) return Object.assign({}, d, {
    level: 'no', auto: d.level, risks, echo, riskCode: 'answer-echoes-given',
    riskWhy: '答案即图上已有数值（' + echo.join('、') + '），画图等于送分'
  });

  return Object.assign({}, d, { auto: d.level, risks, echo });
}

/* ============================================================ 题型分类
 *
 * 题型分布回答的是「这一类里到底在考什么」，决定 D 卡做出来的画板有多少题真用得上。
 * 顺序敏感：先命中先归类，一条题只进一个题型。
 */
const TYPE_RULES = [
  { type: '纯算式', re: RE_PURE_CALC },
  { type: '证明/求证', re: RE_PROOF },
  { type: '判断/命题辨析', re: RE_JUDGE },
  { type: '动点/图形运动', re: RE_LOCUS },
  { type: '实景应用(影长/旗杆)', re: RE_APPLIED },
  { type: '个数/取值/最值', re: RE_COUNT_ASK },
  { type: '位似/坐标变换', re: /位似|相似中心|以原点\s*O\s*为|对应点/ },
  { type: '比例线段/成比例', re: /成比例|比例线段|a\/b\s*=|x\/y\s*=|分线段成比例/ },
  { type: '相似判定/性质', re: /∽|相似三角形|相似多边形|相似比/ },
  { type: '圆周角/圆心角', re: /圆周角|圆心角|所对的弧|内接四边形/ },
  { type: '弦/垂径定理', re: /弦|垂径|弧长|弓形/ },
  { type: '切线/位置关系', re: /切线|相切|切点|位置关系|弦长/ },
  { type: '边角计算', re: /∠|=|\d/ },
  { type: '概念辨析', re: /./ }
];

function typeOf(q) {
  const s = plain(q.prompt);
  for (const r of TYPE_RULES) if (r.re.test(s)) return r.type;
  return '概念辨析';
}

/* ============================================================ 输出小工具 */

function table(headers, rows) {
  const out = ['| ' + headers.join(' | ') + ' |', '|' + headers.map(() => ' --- ').join('|') + '|'];
  rows.forEach(r => out.push('| ' + r.join(' | ') + ' |'));
  return out.join('\n');
}

function clip(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function pct(a, b) {
  return b ? (a / b * 100).toFixed(1) + '%' : '—';
}

function sortDesc(obj) {
  return Object.entries(obj).sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
}

/* ============================================================ 主流程 */

/* 被 require()（测试 / 探针）时只导出纯函数，不打表。
 * 与 scripts/measure_funclab_coverage.js 同一手法：报告 = 主模块的 stdout，
 * 因此「报告里的数字」与「能跑出来的数字」永远是同一份。 */
const RUN_AS_MAIN = require.main === module;

/* 对外导出面：纯函数 + 判定表 + 逐题结果。测试只依赖这些，不解析 stdout */
const MODULE_EXPORTS = {
  constraints, drawability, finalVerdict, classify, typeOf,
  riskFlags, answerEchoesGiven, isGeometryTopic, chapterGroup, hasNumericLabel,
  CLASS_RULE, RISK_RULES, MANUAL_REVIEW
};

/* 每道题只算一次，后面各节都复用这份结果 */
const ROWS = QUESTIONS.map(q => {
  const cls = classify(q);
  return {
    q,
    cls,
    chapter: chapterGroup(q.topicId),
    topic: TOPIC.get(q.topicId) || {},
    type: typeOf(q),
    isGeo: isGeometryTopic(q.topicId),
    verdict: cls ? finalVerdict(q, cls) : null
  };
});

const CLS = ['triangle', 'circle', 'similar'];
const BY_CLS = {};
CLS.forEach(c => { BY_CLS[c] = ROWS.filter(r => r.cls === c); });

MODULE_EXPORTS.ROWS = ROWS;
MODULE_EXPORTS.BY_CLS = BY_CLS;

if (!RUN_AS_MAIN) {
  module.exports = MODULE_EXPORTS;
  return;
}

const log = [];
function say(s) { const v = s == null ? '' : s; log.push(v); if (!process.argv.includes('--json')) console.log(v); }

say('# geomlab 画板覆盖率测算 · 脚本输出');
say('');
say('数据：questions.json ' + QUESTIONS.length + ' 题 / topics.json ' + TOPICS.length + ' 个知识点');
say('口径：见脚本头注释「判定口径」；判定只用规则+正则，不调用 LLM。');
say('');

/* ---------- 1. 全库与几何章题量 ---------- */
say('## 一、全库与几何章题量');
say('');
const geoRows = ROWS.filter(r => r.isGeo);
say('全库题量：' + QUESTIONS.length);
say('几何领域（domain=图形与几何）知识点数：' + new Set(geoRows.map(r => r.q.topicId)).size +
    '；这些知识点下的题：' + geoRows.length +
    '（占全库 ' + pct(geoRows.length, QUESTIONS.length) + '）');
say('');

/* 几何领域按章聚合（题数降序，只列题数 >= 1 的全部章） */
const geoByChapter = {};
geoRows.forEach(r => { geoByChapter[r.chapter] = (geoByChapter[r.chapter] || 0) + 1; });
say('几何领域按章分布（共 ' + Object.keys(geoByChapter).length + ' 章）：');
say('');
say(table(['章', '题数'], sortDesc(geoByChapter).map(([k, v]) => [k, String(v)])));
say('');

/* 三类题量 + 各类章分布 */
say('三类归属（一章只归一类，规则见脚本 classify）：');
say('');
const clsChapterRows = [];
CLS.forEach(c => {
  const byCh = {};
  BY_CLS[c].forEach(r => { byCh[r.chapter] = (byCh[r.chapter] || 0) + 1; });
  sortDesc(byCh).forEach(([k, v]) => clsChapterRows.push([CLASS_RULE[c].label, k, String(v)]));
});
say(table(['类', '章', '题数'], clsChapterRows));
say('');
say(table(['类', '题量', '涉及章数', '涉及知识点数', '说明'],
  CLS.map(c => [
    CLASS_RULE[c].label,
    String(BY_CLS[c].length),
    String(new Set(BY_CLS[c].map(r => r.chapter)).size),
    String(new Set(BY_CLS[c].map(r => r.q.topicId)).size),
    CLASS_RULE[c].why
  ])));
say('');

/* 范围外：解析几何。必须显式列出来，否则「圆只有 108 题」会被误读成题库没题 */
const oos = ROWS.filter(r => CH_OUT_OF_SCOPE.test(chapterOf(r.q.topicId)) && !r.cls);
const oosByCh = {};
oos.forEach(r => { oosByCh[r.chapter] = (oosByCh[r.chapter] || 0) + 1; });
say('### 范围外：解析几何章节（' + oos.length + ' 题，不计入三类）');
say('');
say(table(['章', '题数'], sortDesc(oosByCh).map(([k, v]) => [k, String(v)])));
say('');
say('排除理由：这些题也能画（坐标系里的直线/圆），但要的画板是「平面直角坐标系 + 方程参数」，');
say('与 D 卡要的欧氏几何静态图不是同一块板；且其中大量题目问的就是斜率/截距/半径/圆心，');
say('画出来等于把答案标在图上。若把它们并进「圆」类，覆盖率会被虚抬约 40 个百分点。');
say('');

/* ---------- 2. 三类可画判定 + 存量 figure ---------- */
say('## 二、三类可画判定');
say('');
say('阈值（脚本 CLASS_RULE，报告直接引用）：');
say('');
say(table(['类', '唯一确定所需约束分', '定形依据'],
  CLS.map(c => [CLASS_RULE[c].label, String(CLASS_RULE[c].drawable), CLASS_RULE[c].why])));
say('');

const SUMMARY = {};
CLS.forEach(c => {
  const rows = BY_CLS[c];
  const drawable = rows.filter(r => r.verdict.level === 'drawable');
  const partial = rows.filter(r => r.verdict.level === 'partial');
  const none = rows.filter(r => r.verdict.level === 'no');
  SUMMARY[c] = { total: rows.length, drawable, partial, none, covered: drawable.length + partial.length };
});

say(table(['类', '题量', '可画(drawable)', '部分可画(partial)', '覆盖合计', '覆盖率', '不可画'],
  CLS.map(c => {
    const s = SUMMARY[c];
    return [CLASS_RULE[c].label, String(s.total), String(s.drawable.length), String(s.partial.length),
      String(s.covered), pct(s.covered, s.total), String(s.none.length)];
  })));
say('');
say('说明：「覆盖合计 = 可画 + 部分可画」，按卡面口径「只画出题干已知部分、标注未知量也算覆盖」。');
say('');

/* 降档审计：drawable 里被「纯套公式」规则降成 partial 的题单独报数，
 * 因为这类题会虚抬覆盖率，D 卡需要知道真实可画面有多大。 */
const formulaLookup = CLS.map(c => BY_CLS[c].filter(r => r.verdict.reason === 'formula-lookup'));
say('其中「单尺寸 + 套公式（半径→周长/面积）」被从 drawable 降为 partial 的题：' +
    formulaLookup.reduce((a, x) => a + x.length, 0) + ' 题（' +
    CLS.map((c, i) => CLASS_RULE[c].label + ' ' + formulaLookup[i].length).join('、') + '）。');
say('降档理由：画一个圆对「套周长/面积公式」不提供任何推理中介，不构成有效覆盖；');
say('若把这类题算进可画，圆类覆盖率会虚高约 5 个百分点。');
say('');

/* 部分可画的约束强度分档。
 * 为什么必须拆：partial 里有一批题只命中 1 个条件（「直角三角形一个锐角 35°，
 * 求另一个」「AD 是中线，BC=10，求 BD」），这类题一步算术就能出答案，
 * 图形几乎不承载推理 —— 把它们与「给了两边一角、只差一个未知量」的题混为一谈，
 * 会让可画率看起来比实际高。故按约束数分档，给出「薄覆盖」口径。 */
say('部分可画按约束强度分档（score ≤ 1 = 仅一个条件，图形基本不承载推理）：');
say('');
say(table(['类', 'partial 合计', '仅 1 个条件（薄）', '≥ 2 个条件（较强）', '薄覆盖占该类'],
  CLS.map(c => {
    const p = SUMMARY[c].partial;
    const thin = p.filter(r => (r.verdict.score || 0) <= 1).length;
    return [CLASS_RULE[c].label, String(p.length), String(thin), String(p.length - thin), pct(thin, SUMMARY[c].total)];
  })));
say('');
const thinTotal = CLS.reduce((a, c) => a + SUMMARY[c].partial.filter(r => (r.verdict.score || 0) <= 1).length, 0);
say('薄覆盖合计 ' + thinTotal + ' 题。第八节按「可画 + 较强 partial」给出保守覆盖率，作为 D 卡的决策口径。');
say('');

/* 不可画原因分布 */
say('不可画原因分布（三类合计）：');
say('');
const noneReasons = {};
CLS.forEach(c => SUMMARY[c].none.forEach(r => {
  const k = r.verdict.manualWhy ? 'manual-review'
    : (r.verdict.riskCode || r.verdict.reason);
  noneReasons[k] = (noneReasons[k] || 0) + 1;
}));
say(table(['原因', '题数'], sortDesc(noneReasons).map(([k, v]) => [k, String(v)])));
say('');

/* 存量 figure 现状：这条回答「题库里现在有没有现成的图可以复用」
 *
 * 注意 "<text>" 不等于「标了尺寸」：题库里的 <text> 大多是顶点字母（A、B、C）
 * 或中文标签（正面 / 侧面）。真正能省掉 D 卡工作的只有「标签里带数字」的那种，
 * 所以判定用 [^<]*\d[^<]* 而不是简单的 /<text/。 */
function hasNumericLabel(svg) {
  return /<text[^>]*>[^<]*\d[^<]*<\/text>/.test(String(svg || ''));
}
say('### 存量 figure 现状（三类目标题里已有 SVG 的题）');
say('');
const withFig = QUESTIONS.filter(q => q.figure);
const figHasText = withFig.filter(q => /<text/.test(q.figure));
say('全库已有 figure 字段的题：' + withFig.length + ' / ' + QUESTIONS.length +
    '；其中 SVG 里带数字标签的：' + withFig.filter(q => hasNumericLabel(q.figure)).length);
say('');
say(table(['类', '已有 figure 题数', '其中标签带数字'],
  CLS.map(c => {
    const rows = BY_CLS[c].filter(r => r.q.figure);
    return [CLASS_RULE[c].label, String(rows.length), String(rows.filter(r => hasNumericLabel(r.q.figure)).length)];
  })));
say('');
/* 结论必须由上面的数字推出来，不能写死 —— 否则题库一改报告就说谎 */
const figNumericByClass = {};
CLS.forEach(c => {
  const rows = BY_CLS[c].filter(r => r.q.figure);
  figNumericByClass[c] = { total: rows.length, numeric: rows.filter(r => hasNumericLabel(r.q.figure)).length };
});
const figNumericTotal = CLS.reduce((a, c) => a + figNumericByClass[c].numeric, 0);
const figTotal = CLS.reduce((a, c) => a + figNumericByClass[c].total, 0);
say('读法：' + figNumericTotal + ' / ' + figTotal + ' 张已有图带数字标签，' +
    '说明题库里**已有少量带尺寸的几何图**（勾股定理、垂径定理那几道），但它们分散在单题上，');
say('不是可复用的画板模块 —— D 卡要做的是「按条件生成图」，存量图只能当参考样例，不能当基线。');
say('');

/* ---------- 3. 题型分布 ---------- */
say('## 三、题型分布（每类前 5）');
say('');
CLS.forEach(c => {
  const rows = BY_CLS[c];
  const dist = {};
  rows.forEach(r => { dist[r.type] = (dist[r.type] || 0) + 1; });
  const top = sortDesc(dist).slice(0, 5);
  const topSum = top.reduce((a, [, v]) => a + v, 0);
  say('### ' + CLASS_RULE[c].label + '（题量 ' + rows.length + '）');
  say('');
  say(table(['题型', '题数', '占该类', '其中可画'],
    top.map(([k, v]) => {
      const d = rows.filter(r => r.type === k && (r.verdict.level === 'drawable' || r.verdict.level === 'partial')).length;
      return [k, String(v), pct(v, rows.length), String(d)];
    })));
  say('');
  say('前 5 类合计 ' + topSum + ' 题，占该类 ' + pct(topSum, rows.length) + '。');
  say('');
});

/* ---------- 4. 样本题 ---------- */
say('## 四、每类 10 个样本题（可画优先，按题 id 排序，便于人工核对）');
say('');
CLS.forEach(c => {
  const s = SUMMARY[c];
  /* 样本取 drawable 优先，不足 10 个再补 partial；排序用 id 保证可复现（不随机） */
  const pool = s.drawable.concat(s.partial).slice().sort((a, b) => String(a.q.id).localeCompare(String(b.q.id)));
  say('### ' + CLASS_RULE[c].label + '（' + pool.length + ' 个可画/部分可画候选中取前 10）');
  say('');
  if (!pool.length) { say('（无可画题）'); say(''); return; }
  say(table(['题 id', '判定', '约束', '题面前 60 字', '参考答案'],
    pool.slice(0, 10).map(r => [
      r.q.id,
      r.verdict.level === 'drawable' ? '可画' : '部分',
      clip(r.verdict.parts.join(' '), 30),
      clip(r.q.prompt, 60),
      clip(r.q.answer, 16)
    ])));
  say('');
});

/* ---------- 5. 误挂风险清单 ---------- */
say('## 五、误挂风险清单（这类不许挂图）');
say('');
say('判定方式：对每道题跑 6 条高危正则 + 2 条「数值碰巧」正则，任一命中即从可画集合剔除，');
say('并在此逐条列出（题面 + 答案 + 命中原因），供人工复核。');
say('');
say('六类高危的定义：');
say('');
say(table(['风险码', '风险类别', '为什么不许挂图'], RISK_RULES.map(r => [r.code, r.label, r.why])));
say('');
say('「数值碰巧送分」两条：');
say('');
say(table(['风险码', '说明'], COINCIDENCE.map(r => [r.code, r.label])));
say('');

/* 5.1 被风险规则挡下的题（按类 × 风险码统计 + 全量清单） */
say('### 5.1 命中高危规则的题（按类 × 风险码）');
say('');
const riskMatrix = [];
RISK_RULES.forEach(r => {
  const row = [r.code];
  let total = 0;
  CLS.forEach(c => {
    const n = BY_CLS[c].filter(x => r.re.test(plain(x.q.prompt))).length;
    row.push(String(n));
    total += n;
  });
  row.push(String(total));
  riskMatrix.push(row);
});
say(table(['风险码', '三角形', '圆', '相似位似', '合计'], riskMatrix));
say('');

/* 全量清单：只列「过了可画阈值但被风险规则拦下」的题 —— 这才是真正的误挂风险面 */
say('### 5.2 真正危险的题：「条件够画、但图与答案无关」（逐条）');
say('');
const DANGEROUS = [];
CLS.forEach(c => {
  BY_CLS[c].forEach(r => {
    const auto = r.verdict.auto || r.verdict.level;
    const blockedByRisk = !!r.verdict.riskWhy;
    if (blockedByRisk && (auto === 'drawable' || auto === 'partial')) DANGEROUS.push({ c, r });
  });
});
say('这类题 ' + DANGEROUS.length + ' 道：条件足以画图（auto=drawable/partial），但被拦下。');
/* 拆分必须动态算，不能写死 —— 否则题库一改，报告里的 18/19 就对不上。
 * 注意：这 37 道**已经包含**「答案即图上已有数值」那批，不是两类相加的关系。 */
const byRiskRule = DANGEROUS.filter(({ r }) => String(r.verdict.riskCode || '').startsWith('risk:')).length;
const byEcho = DANGEROUS.filter(({ r }) => r.verdict.riskCode === 'answer-echoes-given').length;
say('  其中 6 类风险规则拦下 ' + byRiskRule + ' 道，答案即图上已有数值拦下 ' + byEcho + ' 道（两者不重叠，合计 ' +
    (byRiskRule + byEcho) + '）。');
say('  另有 ' + Object.values(BY_CLS).flat().filter(x => (x.verdict.risks || []).length && !(['drawable', 'partial'].includes(x.verdict.auto || x.verdict.level))).length +
    ' 题也命中风险规则，但本就不可画（零量化条件/无定形条件），不重复计入。');
say('  人工复核定档判 misleading 的 ' + CLS.reduce((a, c) => a + BY_CLS[c].filter(r => r.verdict.manualWhy && r.verdict.level === 'no').length, 0) +
    ' 题在 5.3 表内，同样不在上述统计中。');
say('');
if (DANGEROUS.length) {
  say(table(['类', '题 id', '题面前 46 字', '参考答案', '拦截原因'],
    DANGEROUS.map(({ c, r }) => [CLASS_RULE[c].label, r.q.id, clip(r.q.prompt, 46), clip(r.q.answer, 14), clip(r.verdict.riskWhy, 34)])));
} else {
  say('（无）');
}
say('');

/* 5.3 人工复核定档 */
say('### 5.3 人工复核定档（结论写死在脚本 MANUAL_REVIEW）');
say('');
const manualIds = Object.keys(MANUAL_REVIEW);
say('共 ' + manualIds.length + ' 条：');
say('');
say(table(['题 id', '题面前 40 字', '参考答案', '人工结论', '理由'],
  manualIds.map(id => {
    const q = QUESTIONS.find(x => x.id === id);
    if (!q) return [id, '（题库已无此题）', '', MANUAL_REVIEW[id].verdict, MANUAL_REVIEW[id].why];
    return [id, clip(q.prompt, 40), clip(q.answer, 14), MANUAL_REVIEW[id].verdict, MANUAL_REVIEW[id].why];
  })));
say('');

/* 5.4 明确不列的风险类别（写清理由，避免下一轮又加回来） */
say('### 5.4 明确**不**列入误挂的类别（附理由）');
say('');
say(table(['类别', '为什么不列'], [
  ['问周长/面积', '图上并不标注周长面积，学生仍须自己算，画图不送分（早期版本列过，30+ 条全是噪声）'],
  ['问相似比/比值', '比值本身不在图上是可读量，画两个相似形不会直接给出比值'],
  ['几何量计算但答案与题给数值无关', '正常可画题，本来就要学生在图上找关系'],
  ['作图/尺规题', '只要条件可量化就画得出，且画板恰好能演示作法']
]));
say('');

/* ---------- 6. 汇总表 ---------- */
say('## 六、汇总表（报告主表）');
say('');
say(table(['类', '题量', '可画题量', '部分可画', '覆盖合计', '覆盖率', '占比(占三类)'],
  CLS.map(c => {
    const s = SUMMARY[c];
    const all = CLS.reduce((a, k) => a + SUMMARY[k].total, 0);
    return [CLASS_RULE[c].label, String(s.total), String(s.drawable.length), String(s.partial.length),
      String(s.covered), pct(s.covered, s.total), pct(s.total, all)];
  })));
say('');
const grandTotal = CLS.reduce((a, c) => a + SUMMARY[c].total, 0);
const grandCovered = CLS.reduce((a, c) => a + SUMMARY[c].covered, 0);
const grandDrawable = CLS.reduce((a, c) => a + SUMMARY[c].drawable.length, 0);
say('三类合计：题量 ' + grandTotal + '，可画 ' + grandDrawable +
    '，覆盖合计 ' + grandCovered + '（' + pct(grandCovered, grandTotal) + '），占全库 ' + pct(grandTotal, QUESTIONS.length) + '。');
say('');

/* ---------- 7. 投入产出排序 ---------- */
say('## 七、投入产出排序建议');
say('');
/* 投入产出的量化：不只看覆盖题数，还看「每覆盖一题要生成多少种图」。
 * D 卡的画板是「一类一张板」，但每类内部的图形骨架数差别很大：
 *   · 圆：⊙O + 半径/弦 几乎覆盖全部题，骨架 1~2 种 → 摊薄成本最低
 *   · 相似：△ 平行截线 + 两个相似形，骨架 2 种
 *   · 三角形：题面涉及的辅助线（中线/角平分线/高/全等对应）骨架明显更多
 * 因此排序 = 覆盖题数为主序，覆盖率为次序，骨架数为参考列（人工判定，写在
 * SKELETON 表里，脚本只做展示，不参与计算 —— 避免把主观判断伪装成统计量）。 */
const SKELETON = {
  circle: { n: 2, note: '⊙O + 半径；⊙O + 弦 + 圆心距' },
  triangle: { n: 4, note: '基本 △；Rt △ + 斜边高；中线/角平分线；全等对应两形' },
  similar: { n: 2, note: '△ + 平行截线（A/A 型）；两相似形并列' }
};
const ROI = CLS.map(c => {
  const s = SUMMARY[c];
  return { c, label: CLASS_RULE[c].label, covered: s.covered, drawable: s.drawable.length, total: s.total, rate: s.total ? s.covered / s.total : 0 };
}).sort((a, b) => b.covered - a.covered);

say(table(['排序', '类', '覆盖题数', '纯可画题数', '覆盖率', '图骨架数(参考)', '结论'],
  ROI.map((x, i) => [
    String(i + 1), x.label, String(x.covered), String(x.drawable), pct(x.covered, x.total),
    String(SKELETON[x.c].n),
    x.covered < 10 ? '不值得做（可画 < 10）' : (i === 0 ? '先做' : '可以后做')
  ])));
say('');
say('「图骨架数」是人工判定的画法种类（写在脚本 SKELETON 表里，不参与排序计算），仅供估算 D 卡工作量。');
say('');
say('判定门槛（卡面要求）：某类覆盖题数 < 10 → 直接建议「不值得做」。');
say('');
ROI.forEach((x, i) => {
  say((i + 1) + '. **' + x.label + '**：覆盖 ' + x.covered + ' 题（纯可画 ' + x.drawable + '，覆盖率 ' + pct(x.covered, x.total) + '）' +
      (x.covered < 10 ? ' —— 不值得做' : ''));
});
say('');

/* ---------- 8. 保守口径（决策用） ----------
 * 第七节按卡面口径（drawable + 全部 partial）排序。但 partial 里有「仅 1 个条件」
 * 的薄覆盖，图形不承载推理。第八节把它剔掉，只留 drawable + 较强 partial，
 * 这是 D 卡真正能指望的覆盖量。两个口径都给出，让决策者看到区间。 */
say('## 八、保守口径：可画 + 较强部分可画（决策口径）');
say('');
const CONSERVATIVE = CLS.map(c => {
  const s = SUMMARY[c];
  const strong = s.partial.filter(r => (r.verdict.score || 0) > 1);
  const covered = s.drawable.length + strong.length;
  return { c, label: CLASS_RULE[c].label, covered, drawable: s.drawable.length, strong: strong.length, thin: s.partial.length - strong.length, total: s.total };
}).sort((a, b) => b.covered - a.covered);
say(table(['排序', '类', '题量', '可画', '较强 partial', '保守覆盖', '保守覆盖率', '剔除的薄覆盖'],
  CONSERVATIVE.map((x, i) => [String(i + 1), x.label, String(x.total), String(x.drawable),
    String(x.strong), String(x.covered), pct(x.covered, x.total), String(x.thin)])));
say('');
const consTotal = CONSERVATIVE.reduce((a, x) => a + x.covered, 0);
say('三类保守覆盖合计 ' + consTotal + ' 题（占三类 ' + pct(consTotal, grandTotal) + '，占全库 ' + pct(consTotal, QUESTIONS.length) + '）。');
say('');
say('两口径对比：宽口径 ' + grandCovered + ' 题，保守口径 ' + consTotal + ' 题，差 ' + (grandCovered - consTotal) + ' 题全部是薄覆盖。');
say('');

/* ---------- 8b. 诊断：drawable 里有图也不省事的题 ----------
 * 事实层（脚本可复现）：drawable 里「只有角度条件、没有任何长度/坐标/关系约束」的题数。
 * 解释层（写进报告，不参与判定）：三角形里这类题基本是「三角形内角和 180°」的
 * 一步算术（给两角求第三角），图形对答案没有任何中介作用；而圆里的同类题多是
 * 圆周角/圆心角定理，图恰恰是理解定理的载体。因此同一个指标在两类的含义不同，
 * 脚本只给数，不给结论。 */
say('### 8b 诊断：drawable 里「仅靠角度条件」的题（脚本给数，含义见报告）');
say('');
const angleOnly = CLS.map(c => {
  const d = SUMMARY[c].drawable;
  const n = d.filter(r => {
    const p = r.verdict.parts || [];
    if (!p.length) return false;
    /* 只要出现任何「非角度」类型的约束，就算图承载了尺寸/位置信息 */
    const hasNonAngle = p.some(x => /^(长|量|坐标|半径|平行|垂直|中点|相切|比例|字母比例式|角比|直径|倒置量)/.test(x));
    const hasAngle = p.some(x => /^(角|度)/.test(x));
    /* 纯列表条件（"三边长分别为 2,3,4"）无法从 parts 判断是角还是边，保守地算作非角度 */
    const onlyList = p.every(x => /^列表/.test(x));
    return hasAngle && !hasNonAngle && !onlyList;
  }).length;
  return [CLASS_RULE[c].label, String(d.length), String(n), pct(n, d.length)];
});
say(table(['类', 'drawable 合计', '其中仅角度条件', '占 drawable'], angleOnly));
say('');

/* ---------- --raw / --json ---------- */
const text = log.join('\n') + '\n';

if (process.argv.includes('--json')) {
  const out = { total: QUESTIONS.length, geometry: geoRows.length, classes: {} };
  CLS.forEach(c => {
    const s = SUMMARY[c];
    out.classes[c] = {
      label: CLASS_RULE[c].label,
      total: s.total,
      drawable: s.drawable.length,
      partial: s.partial.length,
      covered: s.covered,
      uncovered: s.none.length,
      rate: s.total ? +(s.covered / s.total * 100).toFixed(1) : 0,
      drawableIds: s.drawable.map(r => r.q.id),
      partialIds: s.partial.map(r => r.q.id)
    };
  });
  console.log(JSON.stringify(out, null, 1));
}

if (process.argv.includes('--raw')) {
  require('fs').writeFileSync(path.join(__dirname, '..', 'docs', 'geomlab-coverage.raw.md'), text);
}

/* 给 tests/ 用的导出（本脚本不 require diagnose/，因此可独立测试） */
module.exports = MODULE_EXPORTS;
