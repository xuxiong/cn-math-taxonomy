#!/usr/bin/env node
/* 「答案语义门禁」的共享实现（批1.5，t_f752c3df）
 *
 * 原来这段逻辑写在 tests/test_funclab.js 的 [E-语义1] 里，只作用于「实际挂载的题」。
 * 批1.5 第 3 件暴露了它的盲区：测算脚本判 misleading 的 31 题里，cnm_h220_q2 并不在
 * 挂载集合里（它挂不上），所以 [E-语义1] 永远不会检查它 —— 门禁的漏洞没人看见。
 * 把判定抽成纯函数后，两个测试文件都能对「同一批题」用同一套口径：
 *   · test_funclab.js      —— 对全库实际挂载的题（新误挂必须为 0）
 *   · test_funclab_hs_batch1.js —— 对测算判 misleading 的 31 题（一条都不许过门禁）
 *
 * 判定只看两样东西：item（题面/答案/选项）+ p（画板解析结果 {type,a,h,k,b}）。
 * 与画板渲染、LLM 都无关 —— 它是「这张图上的数字/性质能不能回答这道题」的确定性判断。
 */
'use strict';

/** 画板对该参数会标注出来的数值集合（字符串化，便于与答案数字比对） */
function annotationValues(p, topicId) {
  const vals = new Set();
  const push = function (x) { if (isFinite(x)) vals.add(String(Number(x.toFixed(6)))); };
  if (p.type === 'quadratic') {
    push(p.h); push(p.k);
    push(p.h - Math.sqrt(-p.k / p.a)); push(p.h + Math.sqrt(-p.k / p.a));
  } else if (p.type === 'linear') {
    push(p.b);                                    // y 轴截距红点 (0,b)
    /* x 轴交点绿点：linear 画板对**任何**知识点都画「与 x 轴交点」并标出横坐标
       （CAPABILITIES.linear-intercepts 的 canAnswer 里就写着这一条），原先只对初中方程章
       cnm_20x/22x 开放是按「要解的方程」判的，与画板实际画了什么不是一个口径。
       改成无条件加入：这是把门禁对齐绘制事实，不是放宽 —— 原口径下高中零点题
       （批1 的 cnm_h049_q2，答案 5 = 绿点横坐标）会被误判成误挂。 */
    if (p.k) push(-p.b / p.k);
  } else if (p.type === 'inverse') {
    push(p.k);                                    // |k| 本身就是答案对象
  } else if (p.type === 'trig') {
    /* 批2：trig 画板实际标注/可读出的派生量 —— 波峰波谷值 k±|A|、周期 T 与 T/π
     * （extremum 红点旁的「最大值 = ?」、period 虚线间的「T = 2π」）。
     * w=0 时 T 发散为 Infinity，isFinite 挡掉，与 mount/verifyParams 的拒绝口径一致。 */
    const A = Math.abs(p.A);
    const T = (p.fn === 'tan' ? Math.PI : 2 * Math.PI) / Math.abs(p.w);
    push(p.k + A);
    push(p.k - A);
    push(T);
    push(T / Math.PI);
  } else if (p.type === 'exp') {
    /* 批3：exp 画板标出的读数 —— 渐近线 y=k、y 轴交点纵坐标 a·b^φ+k、
       x=1 处的函数值 a·b^(w+φ)+k（题面已知量固定，不随滑块变）。 */
    push(p.k);
    push(p.a * Math.pow(p.base, p.phi) + p.k);
    push(p.a * Math.pow(p.base, p.w + p.phi) + p.k);
  } else if (p.type === 'log') {
    /* 批3：log 画板标出的读数 —— 渐近线 x=-shift、定点 (-shift+1, d)、
       定义域内侧另一点 (-shift+base, c+d)。 */
    push(-p.shift);
    push(-p.shift + 1);
    push(p.d);
    push(-p.shift + p.base);
    push(p.c + p.d);
  } else if (p.type === 'power') {
    if (p.root) {
      /* 根式形：起点横坐标 -c/b 与纵坐标 k（起点坐标两个分量都在集合里）。 */
      push(-p.root.c / p.root.b);
      push(p.k);
    } else {
      /* 多项式形：定点 (0,0) 与 (1,1) 的坐标分量。 */
      push(0);
      push(1);
    }
  }
  return vals;
}

/** 从答案里抠数字（支持 1，-3/2、-2，5、y=2x+1、112.5、m≠1 等） */
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

/** 答案解析不了数字时，允许通过的纯图像可读答案 */
const IMAGE_READABLE = /象限|增大而|减小而|交点个数|开口|无交点|没有交点/;

/** 答案不是数字、但**就是画板标出来的性质**（比 IMAGE_READABLE 更窄的一张白名单）：
 *  曲线走向（单调）、对称性（奇偶）、定义域边界（渐近线 / 非零实数）。
 *  逐条对应 CAPABILITIES 里的 canAnswer —— linear:『是否是增/减函数』；
 *  quadratic:『奇偶性』（对称轴即 y 轴或原点）；inverse:『定义域 / 渐近线』。
 *  批1（t_d3c2ba81）放行的高中题多数出成选择题，选项正文就是这类性质词。 */
const READABLE_PROPERTY = /^(增函数|减函数|偶函数|奇函数|非奇非偶|全体非零实数|全体实数|除\s*0\s*外的全体实数)$/;

/** 批3：答案不是数字、但按**画板类型**确实能从图上读出来的性质。
 *  按类型分档放行，**不**把 READABLE_PROPERTY 全局放宽：
 *    · exp 的「全体正实数」= 曲线全在渐近线 y=k 上方（看图得值域）；
 *    · log 的「全体正实数」= 曲线只画在渐近线 x=-shift 右侧（看图得定义域）；
 *    · power 暂不放行任何非数字答案。 */
const READABLE_BY_TYPE = { exp: [/^全体正实数$/], log: [/^全体正实数$/], power: [] };

/** 题面问的是「导数意义上的量」：切线斜率 / 瞬时变化率 / 导数 ——
 *  画板上标出的数（顶点 h/k、截距 b、交点横坐标）都是**函数值或坐标**，不是这个量。
 *  批1.5 第 3 件：cnm_h220_q2 问切线斜率（答案 0），画板读数里恰有 h=0，
 *  纯数值门禁看不出来 —— 数字碰巧相等不等于语义对上。 */
const DERIVATIVE_ASK = /切线|斜率|变化率|导数|f\s*['′’]\s*\(/;

/**
 * 答案语义门禁：能挂 = null；不该挂 = 一句人话说明原因。
 * 与 [E-语义1] 原实现逐条等价，另加「答案 0 撞上导数语义」这一条限定（批1.5 第 3 件）。
 */
function misfitOf(item, p) {
  const ansStr = String(item.answer == null ? '' : item.answer);
  /* 选择题：题库只存选项字母（A/B/C/D），学生看到的是选项正文 —— 按正文判。
     原先「答案字母即误挂」等于「凡出成选择题就永远挂不上」，而高中题绝大多数是选择题，
     按字母挡等于把判定权交给题型而不是答案语义。按正文判仍然严格：正文不是图上可读的
     数/性质，照样返回原因（下面「不是可读数字」那条分支）。 */
  const isLetter = /^[A-D]$/.test(ansStr.trim());
  const choice = isLetter ? (item.choices || []).filter(function (c) { return c.key === ansStr.trim(); })[0] : null;
  if (isLetter && !choice) return '选择题（答案 ' + ansStr + '，选项里找不到正文）';
  const ansText = choice ? String(choice.text == null ? '' : choice.text) : ansStr;
  const nums = answerNumbers(ansText);
  if (!nums.length) {
    if (IMAGE_READABLE.test(ansText)) return null;          // 象限/增减性/交点个数：图像可读
    if (READABLE_PROPERTY.test(ansText.trim())) return null; // 单调/奇偶/定义域：画板标得出这个结论
    /* 批3：按画板类型分档（exp 的值域 / log 的定义域），不做全局放宽。 */
    const byType = READABLE_BY_TYPE[p && p.type] || [];
    if (byType.some(function (re) { return re.test(ansText.trim()); })) return null;
    return '答案「' + ansText + '」不是可读数字';
  }
  /* 批1.5 第 3 件：语义限定必须排在数值比对**之前** —— 排在后面就永远轮不到它
     （h=0 已经先被数值巧合放行了）。 */
  if (DERIVATIVE_ASK.test(String(item.prompt || '')) && nums.indexOf(0) >= 0) {
    return '答案 0 撞上导数语义：题面问切线/斜率/变化率，画板上标的是函数值/坐标，'
      + '数值巧合不等于语义对上（' + ansText + '）';
  }
  const ann = annotationValues(p, item.topicId);
  const ok = nums.some(function (n) { return ann.has(String(Number(n.toFixed(6)))) || ann.has(String(n)); });
  if (!ok) return '答案 ' + ansText + ' ∉ 画板标注 {' + Array.from(ann).join(',') + '}';
  return null;
}

module.exports = {
  annotationValues: annotationValues,
  answerNumbers: answerNumbers,
  misfitOf: misfitOf,
  IMAGE_READABLE: IMAGE_READABLE,
  READABLE_PROPERTY: READABLE_PROPERTY,
  READABLE_BY_TYPE: READABLE_BY_TYPE,
  DERIVATIVE_ASK: DERIVATIVE_ASK
};
