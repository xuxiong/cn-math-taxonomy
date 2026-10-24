/* 初中几何画板（geomlab）：把几何题的图形按「配置驱动」画出来，可拖拽、实时标注。
 *
 * 与 funclab.js 的分工：funclab 画函数图象（坐标平面 + 曲线），geomlab 画欧氏几何图形
 * （三角形 / 圆 / 相似）。两者接口形态对齐，都挂在讲解面板第 3 步：
 *   app.js: try { funclab 能挂就挂 funclab } 否则 { geomlab 能挂就挂 geomlab }
 *
 * ★ 本模块的硬约束（改代码前先读这几条）★
 * 1. **LLM 零参与**。图形永远由本文件里的骨架 + 题面解析出的参数生成。理由与 funclab 一致：
 *    LLM 画错一个图比不给图更糟，而且无法测试。
 * 2. **图上的每个数值都是算出来的**。边长走余弦定理/勾股/弦长公式，角度走圆周角定理/
 *    切线⊥半径/三角形内角和。没有任何一处把答案当常量填进去（solve() 是唯一数据源，
 *    测试直接断言 solve() 的输出等于题库答案）。
 * 3. **解析不出就不挂**。labFor() 返回 null 时整块面板消失，绝不留一个「大概的图」。
 *
 * ---------------------------------------------------------------- 答案语义边界
 * 挂图的前提是：**这张图能承载这道题的推理**，而不是把答案摆在图上。具体分两层。
 *
 * (A) 门禁层 gate()：与 F 卡（scripts/measure_geomlab_coverage.js）的 finalVerdict 同源，
 *     命中任一即不挂 —— 测试用「全库几何题逐题对拍」保证两边不漂移：
 *       · 纯证明 / 求证（证明过程无图可依）
 *       · 判断对错 / 命题辨析（答案在文字里，图上没有对应物）
 *       · 动点 / 轨迹 / 翻折（静态图讲不清）
 *       · 纯算式伪装成几何题（计算: 3+3）
 *       · 问个数 / 取值范围 / 最值 / 有几个公共点（图上数不出来）
 *       · 实景应用（影长/旗杆/镜子，图是示意且比例失真）
 *       · 答案即图上已有数值（全等/相似对应量相等这类，标完图答案就在脸上）
 *       · 位似坐标题（答案就是一个点坐标，画出对应点等于给答案）
 *
 * (B) 解析层 labFor()：只认下面 6 个骨架，认不出就 null。所以「条件不足只能画示意图」
 *     的题天然不挂 —— 例如只给一个角、其余全凭文字描述的题。
 *     每个骨架的适用条件写在对应 parse* 函数头注释里。
 *
 * 说明：第 3 步是「完整解析」步，答案文字已经印在面板上（funclab 同样会在这一步标出
 * 方程的根）。因此图上标注「派生量」（由已知量算出来的边长/角度）不违反上面的边界 ——
 * 那正是要让学生看见的关系。禁止的是「答案就是某个已知量的复制」或「答案是坐标」。
 *
 * ---------------------------------------------------------------- 六个骨架
 *   circle-chord       ⊙O + 弦 + 弦心距        垂径定理：r² = d² + (AB/2)²
 *   circle-inscribed   ⊙O + 圆心角/圆周角      圆周角定理：同弧圆周角 = 圆心角的一半
 *   circle-tangent     ⊙O + 切线               切线⊥半径；切线长定理
 *   similar-parallel   △ABC + DE∥BC            平行截线成比例（A 型）
 *   similar-pair       两个相似三角形           相似比 / 位似
 *   triangle-right     Rt△（+斜边高）          勾股、面积、射影定理
 *
 * UMD：浏览器暴露 window.Geomlab；Node require() 可单测（纯函数 + solve，无 DOM）。
 */
(function (root, factory) {
  'use strict';
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.Geomlab = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ============================================================ 0. 文本归一化 */

  /** 全角标点/各种横线 → 半角；撇号统一，便于 A'B' 与 A′B′ 等价 */
  function plain(prompt) {
    return String(prompt == null ? '' : prompt)
      .replace(/[，]/g, ',')
      .replace(/[（]/g, '(')
      .replace(/[）]/g, ')')
      .replace(/[−－—–]/g, '-')
      .replace(/[：]/g, ':')
      .replace(/[；]/g, ';')
      .replace(/[　]/g, ' ')
      .replace(/[′’‘']/g, "'");
  }

  /** 取第一个捕获组的数字，取不到返回 null */
  function pick(s, re) {
    const m = re.exec(s);
    if (!m) return null;
    const v = parseFloat(m[1]);
    return isFinite(v) ? v : null;
  }

  /** 依次尝试多条正则，返回第一个能取到的数 */
  function pickAny(s, res) {
    for (let i = 0; i < res.length; i++) {
      const v = pick(s, res[i]);
      if (v != null) return v;
    }
    return null;
  }

  /* ============================================================ 1. 几何计算（纯函数）
   *
   * 全部是出口函数：测试逐条断言数值，前端只调用这里，不在别处另写一遍公式。
   */

  const D2R = Math.PI / 180;
  const R2D = 180 / Math.PI;

  /** 余弦定理求第三边：a² = b² + c² − 2bc·cosA（A 为 b、c 的夹角，单位度） */
  function lawCosSide(b, c, Adeg) {
    return Math.sqrt(Math.max(0, b * b + c * c - 2 * b * c * Math.cos(Adeg * D2R)));
  }

  /** 余弦定理求角：返回「side 边的对角」的度数（即夹在 b、c 之间的那个角） */
  function lawCosAngle(side, b, c) {
    const cos = (b * b + c * c - side * side) / (2 * b * c);
    return Math.acos(Math.max(-1, Math.min(1, cos))) * R2D;
  }

  /** 两边夹角求面积：S = ½·b·c·sinA */
  function areaSAS(b, c, Adeg) {
    return 0.5 * b * c * Math.sin(Adeg * D2R);
  }

  /** 三边求面积（海伦公式） */
  function areaSides(a, b, c) {
    const p = (a + b + c) / 2;
    return Math.sqrt(Math.max(0, p * (p - a) * (p - b) * (p - c)));
  }

  /** 勾股求斜边 */
  function rightHypot(leg1, leg2) {
    return Math.sqrt(leg1 * leg1 + leg2 * leg2);
  }

  /** 勾股求直角边（已知斜边与另一条直角边） */
  function rightLeg(hyp, leg) {
    return Math.sqrt(Math.max(0, hyp * hyp - leg * leg));
  }

  /** 斜边上的高：h = 两直角边之积 / 斜边（等面积法，射影定理的推论） */
  function altitudeToHypotenuse(leg1, leg2, hyp) {
    if (!hyp) return 0;
    return leg1 * leg2 / hyp;
  }

  /** 垂径定理：半径 + 弦长 → 弦心距 */
  function chordDistance(r, chord) {
    return Math.sqrt(Math.max(0, r * r - (chord / 2) * (chord / 2)));
  }

  /** 垂径定理：半径 + 弦心距 → 弦长 */
  function chordLength(r, dist) {
    return 2 * Math.sqrt(Math.max(0, r * r - dist * dist));
  }

  /** 垂径定理反解：弦长 + 弦心距 → 半径 */
  function radiusFromChordDist(chord, dist) {
    return Math.sqrt(dist * dist + (chord / 2) * (chord / 2));
  }

  /** 圆周角定理：同弧所对圆周角 = 圆心角的一半 */
  function inscribedFromCentral(centralDeg) {
    return centralDeg / 2;
  }

  /** 圆周角定理（劣弧一侧）：点落在劣弧上时，圆周角 = 180° − 圆心角/2 */
  function inscribedOnMinorArc(centralDeg) {
    return 180 - centralDeg / 2;
  }

  /** 圆周角定理反解：圆周角 → 圆心角 */
  function centralFromInscribed(inscribedDeg) {
    return inscribedDeg * 2;
  }

  /** 切线长：PT = √(OP² − r²)（切线⊥半径 → 直角三角形） */
  function tangentLength(OP, r) {
    return Math.sqrt(Math.max(0, OP * OP - r * r));
  }

  /** 圆外一点到圆上各点的最短距离（OP − r） */
  function secantNear(OP, r) {
    return OP - r;
  }

  /** 圆外一点到圆上各点（过该点直径的另一端）的最远距离（OP + r） */
  function secantFar(OP, r) {
    return OP + r;
  }

  /** 相似：由一条边与相似比求对应边 */
  function similarSide(side, ratio) {
    return side * ratio;
  }

  /** 相似：面积比 = 相似比的平方 */
  function similarAreaRatio(ratio) {
    return ratio * ratio;
  }

  const MATH = {
    lawCosSide: lawCosSide, lawCosAngle: lawCosAngle, areaSAS: areaSAS, areaSides: areaSides,
    rightHypot: rightHypot, rightLeg: rightLeg, altitudeToHypotenuse: altitudeToHypotenuse,
    chordDistance: chordDistance, chordLength: chordLength, radiusFromChordDist: radiusFromChordDist,
    inscribedFromCentral: inscribedFromCentral, inscribedOnMinorArc: inscribedOnMinorArc,
    centralFromInscribed: centralFromInscribed,
    tangentLength: tangentLength, secantNear: secantNear, secantFar: secantFar,
    similarSide: similarSide, similarAreaRatio: similarAreaRatio
  };

  /* ============================================================ 2. 门禁（与 F 卡同源）
   *
   * 这里的每条正则都必须与 scripts/measure_geomlab_coverage.js 中同名常量逐字一致。
   * 之所以抄一份而不是 require：浏览器里没有 require，且那个脚本要读 data/questions.json。
   * 防漂移的办法是测试：tests/test_geomlab.js 拿全库几何题「逐题对拍」
   * geoGate(prompt, answer) 与 measure 脚本的 finalVerdict(...) === 'no'，
   * 任何一边改了规则而另一边没跟上，测试立刻红。
   */

  const RE_PROOF = /证明|求证|试证|说明理由|推导/;
  const RE_JUDGE = /正确的是|错误的是|正确的有|下列(?:说法|命题|结论|判断)|说法(?:中)?正确|命题(?:中)?正确|判断.*(?:对错|正误)|是否(?:正确|成立)|(?:是|能|会|可以|一定|都)[^？?]{0,12}吗[？?]/;
  const RE_LOCUS = /动点|运动|轨迹|扫过|平移|旋转|翻折|折叠|滚动/;
  const RE_PURE_CALC = /计算[:：]/;
  const RE_COUNT_ASK = /有几种|有几个|有(?:多少|几)条|最多|至少|整数|取值范围|最大值|最小值/;
  const RE_APPLIED = /影长|影子|旗杆|竹竿|平面镜|镜子|树高|测(?:得|量)|梯子|靠在墙|水位|斜坡/;

  /* 「答案即图上已有数值」用的约束抽取（与 measure 脚本 constraints() 的口径一致，
   * 只保留 answerEchoesGiven 用得到的那几类：线段、角、量词值、数值列表、半径） */
  const RE_SEG_ASSIGN = /(?:^|[^A-Za-z])([A-Z]{1,2}'?)\s*=\s*(\d+(?:\.\d+)?)(?![a-zA-Z.])/g;
  const RE_ANG_ASSIGN = /∠\s*([A-Z]{1,3}'?)\s*=\s*(\d+(?:\.\d+)?)\s*°?/g;
  const RE_RADIUS = /(半径|直径)\s*(?:为|是|=)?\s*(\d+(?:\.\d+)?)/;
  const RE_QTY_VALUE = /(弦长|弦|弧长|弧|底边|底|高|宽为|长为|腰|上底|下底|边长|周长为|面积为|面积|体积|距离|影长)\s*(?:为|是|=)?\s*(\d+(?:\.\d+)?)/g;
  const RE_NUM_LIST = new RegExp(
    '(?:三边|两边|各边|边长|直角边|斜边|腰|内角|外角|顶角|底角|圆心角|圆周角|分针|时针)' +
    '(?:长|长度|度数)?\\s*(?:分别为|分别是|分别|为|是|都是|都|=|:)?\\s*' +
    '(\\d+(?:\\.\\d+)?(?:\\s*(?:,|、|和|及|与)\\s*\\d+(?:\\.\\d+)?)*)', 'g');
  const RE_COORD = /\(\s*[+-]?\d+(?:\.\d+)?\s*,\s*[+-]?\d+(?:\.\d+)?\s*\)/g;

  /** 从题面抽出「已给的几何量」，用于判定答案是否只是复制题面数值 */
  function givenQuantities(s) {
    const out = new Set();
    let m;
    const sNoAngle = s.replace(RE_ANG_ASSIGN, function (m0) { return ' '.repeat(m0.length); });
    RE_SEG_ASSIGN.lastIndex = 0;
    while ((m = RE_SEG_ASSIGN.exec(sNoAngle))) out.add(parseFloat(m[2]));
    RE_ANG_ASSIGN.lastIndex = 0;
    while ((m = RE_ANG_ASSIGN.exec(s))) out.add(parseFloat(m[2]));
    /* 裸度数（"两个角分别为 50°、60°"） */
    const degRe = /(\d+(?:\.\d+)?)\s*(?:°|度)/g;
    while ((m = degRe.exec(s))) out.add(parseFloat(m[1]));
    RE_QTY_VALUE.lastIndex = 0;
    while ((m = RE_QTY_VALUE.exec(s))) out.add(parseFloat(m[2]));
    RE_NUM_LIST.lastIndex = 0;
    while ((m = RE_NUM_LIST.exec(s))) {
      (m[1].match(/\d+(?:\.\d+)?/g) || []).forEach(function (v) { out.add(parseFloat(v)); });
    }
    const rad = RE_RADIUS.exec(s);
    if (rad) out.add(parseFloat(rad[2]));
    return out;
  }

  /** 答案文本：选择题把选项字母换成选项原文（与 measure 的 answerText 同口径） */
  function answerTextOf(answer, choices) {
    const a = String(answer == null ? '' : answer).trim();
    if (/^[A-Z]$/.test(a) && Array.isArray(choices)) {
      const c = choices.filter(function (x) { return String(x.key).toUpperCase() === a; })[0];
      if (c) return String(c.text);
    }
    return a;
  }

  /** 答案里每个数都已经是题面给的几何量 → 标完图答案就在脸上（几何版「送分」） */
  function answerEchoesGiven(prompt, answer, choices) {
    const s = plain(prompt).replace(/圆周率[^。；,]*/g, '').replace(/π/g, '');
    /* kπ 系数题：答案是 π 的系数，不是图上能量出来的长度 */
    if (/求\s*k\s*的值|只填\s*k|kπ/.test(s)) return null;
    const given = givenQuantities(s);
    if (!given.size) return null;
    const ansVals = (answerTextOf(answer, choices).match(/\d+(?:\.\d+)?/g) || []).map(parseFloat);
    if (!ansVals.length) return null;
    const hit = ansVals.filter(function (v) { return given.has(v); });
    return hit.length === ansVals.length ? hit : null;
  }

  /* 人工定档：与 measure 脚本 MANUAL_REVIEW 中 verdict='misleading' 的三道位似坐标题一致。
   * 这里只收「必须挡」的，不重复收「抬档」的 —— 抬档题（271_q1 等）本就解析不出骨架，自然 null。 */
  const MANUAL_NO = {
    'cnm_275_q2': '答案 A\' 的坐标就是图上的点，画出来等于直接给答案',
    'cnm_275_q3': '同上，异侧位似的对应点即答案',
    'cnm_275_q5': '同上，位似中心不在原点时对应点仍是答案本身'
  };

  /**
   * 答案语义门禁。命中即「不许挂」。
   * @param {string} prompt 题面
   * @param {object} opts   {answer, choices, itemId}
   * @return {{blocked:boolean, reason:?string}}
   *
   * 注意：opts.answer 缺失时按「无法校验答案语义」处理 → 直接 block（fail-closed）。
   * 送分判定是这套画板最危险的一条，宁可少挂也不能漏挡。
   */
  function gate(prompt, opts) {
    const o = opts || {};
    const s = plain(prompt);
    if (RE_PROOF.test(s)) return { blocked: true, reason: 'proof' };
    if (RE_JUDGE.test(s)) return { blocked: true, reason: 'judge-statement' };
    if (RE_LOCUS.test(s)) return { blocked: true, reason: 'locus-motion' };
    if (RE_PURE_CALC.test(s)) return { blocked: true, reason: 'pure-arithmetic' };
    if (RE_COUNT_ASK.test(s)) return { blocked: true, reason: 'asks-count' };
    if (RE_APPLIED.test(s)) return { blocked: true, reason: 'applied-model' };
    if (o.itemId && MANUAL_NO[o.itemId]) return { blocked: true, reason: 'manual:' + o.itemId };
    if (o.answer == null) return { blocked: true, reason: 'answer-unknown' };
    const echo = answerEchoesGiven(prompt, o.answer, o.choices);
    if (echo) return { blocked: true, reason: 'answer-echoes-given' };
    return { blocked: false, reason: null };
  }

  /* ============================================================ 3. 知识点 → 题类
   *
   * 白名单，只覆盖 F 卡测算过的三类章（九上圆 / 九下相似 / 八上三角形 + 勾股）。
   * 优先用调用方传进来的 topic 对象（app.js 有 t.chapter / t.name）判断，
   * 没有 topic 时退回 id 段判断 —— 两者都不认得就返回 null（不挂）。
   */

  /** id 段：cnm_250..268 = 圆；cnm_269..275 = 相似位似；cnm_110..130 + cnm_174..179 = 三角形 */
  function classOfId(topicId) {
    const m = /^cnm_(\d+)$/.exec(String(topicId || ''));
    if (!m) return null;
    const n = parseInt(m[1], 10);
    if (n >= 250 && n <= 268) return 'circle';
    if (n >= 269 && n <= 275) return 'similar';
    if ((n >= 110 && n <= 130) || (n >= 174 && n <= 179)) return 'triangle';
    return null;
  }

  /** 由 topic 对象判断题类（章名口径与 F 卡 classify() 一致） */
  function classOfTopic(topic) {
    if (!topic) return null;
    const ch = String(topic.chapter || '');
    const name = String(topic.name || '');
    /* 三维体不是二维画板的事（圆锥/圆柱/球/展开图） */
    if (/圆锥|圆柱|球|棱柱|棱锥|棱台|圆台|立体|旋转体|展开图/.test(name)) return null;
    /* 解析几何（直线和圆的方程）有自己的画板，不归本卡 */
    if (/直线和圆的方程|圆锥曲线|空间向量|立体几何|平面向量/.test(ch)) return null;
    if (/相似|位似/.test(ch)) return 'similar';
    if (/圆/.test(ch)) return 'circle';
    if (/三角形|勾股|全等/.test(ch)) return 'triangle';
    return null;
  }

  function classOf(topicId, opts) {
    return classOfTopic(opts && opts.topic) || classOfId(topicId);
  }

  /* ============================================================ 4. 题面 → 骨架 + 参数
   *
   * 每个 parse* 都返回 null 或一个 lab 对象：
   *   { skel, title, prompt, state, given, note, ... }
   * state 是画板的可调状态；given 记录「哪些量是题面给的」。
   */

  /** 弦长：弦 AB=8 / 弦长 8 / 弦 AB 的长为 8 */
  const RE_CHORD = /弦\s*[A-Z]{1,2}\s*=\s*(\d+(?:\.\d+)?)/;
  const RE_CHORD_ALT = [
    /弦长\s*(?:为|是|=)?\s*(\d+(?:\.\d+)?)/,
    /弦\s*[A-Z]{1,2}\s*的?长(?:度)?\s*(?:为|是|=)?\s*(\d+(?:\.\d+)?)/
  ];
  /** 弦心距：圆心到 AB 的距离为 6 / 弦心距 5 */
  const RE_CHORD_DIST = [
    /圆心\s*(?:O)?\s*(?:到|距)\s*(?:弦)?\s*[A-Z]{0,2}\s*的?\s*(?:距离|弦心距)\s*(?:为|是|=)?\s*(\d+(?:\.\d+)?)/,
    /弦心距\s*(?:为|是|=)?\s*(\d+(?:\.\d+)?)/
  ];

  /**
   * 骨架 1：⊙O + 弦 + 弦心距（垂径定理）
   * 适用：题面同时给出 {半径|直径, 弦长, 弦心距} 中至少两个，且不是双弦题。
   * 图上由 r、d 定弦；拖动弦端点改变弦长，弦心距/半径按垂径定理跟着算。
   */
  function parseCircleChord(S) {
    /* 双平行弦（"弦 AB∥弦 CD ... 两弦之间的距离"）：一个骨架画不出两段距离之和，不挂 */
    if (/弦\s*[A-Z]{1,2}[^。]{0,4}∥[^。]{0,6}弦/.test(S) || /两弦/.test(S)) return null;
    const radiusDirect = pick(S, /半径\s*(?:为|是|=)?\s*(\d+(?:\.\d+)?)/);
    const diameter = pick(S, /直径\s*(?:为|是|=)?\s*(\d+(?:\.\d+)?)/);
    const r0 = radiusDirect != null ? radiusDirect : (diameter != null ? diameter / 2 : null);
    const chord = pickAny(S, [RE_CHORD].concat(RE_CHORD_ALT));
    const dist = pickAny(S, RE_CHORD_DIST);
    const known = [r0, chord, dist].filter(function (v) { return v != null; }).length;
    if (known < 2) return null;
    /* 三量都给时校验自洽，对不上说明题面读错了或题本身矛盾 → 不挂 */
    if (r0 != null && chord != null && dist != null) {
      const expect = chordDistance(r0, chord);
      if (Math.abs(expect - dist) > Math.max(0.08, 0.02 * Math.max(r0, dist))) return null;
    }
    if (r0 != null && chord != null && chord > 2 * r0 + 1e-9) return null;   // 弦长超过直径：题面必有问题

    /* 三个量在题面里补齐（缺的那个由垂径定理算出）。注意：补出来的那个是**派生量**，
     * 画板上不标数值（只标题面给了的那两个），否则等于把答案印在图上。 */
    const st = { r: r0, d: dist, chord: chord };
    if (st.chord == null) st.chord = chordLength(st.r, st.d);
    if (st.d == null) st.d = chordDistance(st.r, st.chord);
    if (st.r == null) st.r = radiusFromChordDist(st.chord, st.d);
    return {
      skel: 'circle-chord',
      title: '⊙O 中的弦与弦心距',
      prompt: '',
      state: st,
      /* 拖动时谁不动：题面给了半径就锁半径（弦长可动）；只给弦+弦心距时锁弦心距（半径跟着变） */
      fixed: (r0 != null || diameter != null) ? 'r' : 'd',
      given: { r: r0 != null || diameter != null, d: dist != null, chord: chord != null },
      free: 'chord',
      /* note 只描述「怎么操作」和「看什么在变」，不许写出 r²=d²+(AB/2)² 这种结论式 */
      note: (r0 != null || diameter != null)
        ? '拖动弦的端点 B：半径 OA 不变，弦长 AB 与圆心到弦的距离 OH 一起变。'
        : '拖动弦的端点 B：弦长 AB 与圆心到弦的距离 OH 一起变，半径 OA 随之变化。'
    };
  }

  /**
   * 骨架 2：⊙O + 圆心角/圆周角（圆周角定理）
   * 适用：题面给出圆心角或圆周角（含"劣弧"情形），且只涉及一条弧。
   * 注：直径所对的圆周角是 90°（泰勒斯定理）属于另一个骨架，这里不接。
   */
  function parseCircleInscribed(S) {
    /* 等弧/等弦的连锁推理（"劣弧 AB 与劣弧 AC 相等"）要两条弧，单弧骨架画不出来 */
    if (/弧[^。]{0,10}相等/.test(S) || /等弧/.test(S)) return null;
    /* 同弧上有第四个点（"点 C、D 在优弧 AB 上"）时要画两条圆周角，单弧骨架只能画一条 */
    if (/点\s*C\s*[、,和]\s*D|∠\s*ADB|∠\s*BDC/.test(S)) return null;
    /* 弧长 / 扇形 / 弓形面积是另一套公式（l = nπr/180、S = nπr²/360），
     * 本骨架只演示圆周角与圆心角的关系，挂上去图与答案没有因果关系 → 不挂 */
    if (/弧长|扇形|弓形|周长|面积/.test(S)) return null;
    const hasWord = /圆周角|圆心角|所对的弧|同弧|一条弧|优弧|劣弧|∠\s*AOB|∠\s*ACB/.test(S);
    if (!hasWord) return null;
    const central = pickAny(S, [
      /圆心角\s*(?:为|是|=)?\s*(\d+(?:\.\d+)?)\s*°?/,
      /∠\s*AOB\s*=\s*(\d+(?:\.\d+)?)/
    ]);
    const inscribed = pickAny(S, [
      /圆周角\s*(?:为|是|=)?\s*(\d+(?:\.\d+)?)\s*°?/,
      /∠\s*ACB\s*=\s*(\d+(?:\.\d+)?)/
    ]);
    let th = central;
    let fromInscribed = false;
    if (th == null && inscribed != null) { th = centralFromInscribed(inscribed); fromInscribed = true; }
    if (th == null) return null;
    if (!(th > 0 && th < 180)) return null;
    /* 点落在劣弧上 → 圆周角取 180° − θ/2（同弧定理的反面） */
    const onMinor = /劣弧/.test(S);
    return {
      skel: 'circle-inscribed',
      title: '⊙O 中的圆心角与圆周角',
      prompt: '',
      /* cAng：C 在圆上的角度（度）。拖动 C 时只改它 —— 角度不变，正是定理要说明的事 */
      state: { central: th, onMinor: onMinor, cAng: onMinor ? 90 : 270 },
      given: { central: central != null, inscribed: fromInscribed },
      free: 'central',
      note: onMinor
        ? '拖动 B 改变圆心角，拖动 C 沿弧移动：C 在劣弧上，请自己比较 ∠AOB 与 ∠ACB 的度数。'
        : '拖动 B 改变圆心角，拖动 C 沿弧移动：C 在优弧上，请自己比较 ∠AOB 与 ∠ACB 的度数。'
    };
  }

  /**
   * 骨架 3：⊙O + 切线（切线⊥半径 / 切线长定理）
   * 适用：
   *   单切线 —— 给出半径（或 OA）**并且**再给一条线段（PA/OP）或一个角（∠P/∠AOP）；
   *   双切线 —— 给出半径 + OP，或只给 ∠APB（只标角度，长度按归一化尺寸不显示）。
   * 只给一个量、其余全靠文字的不挂（画不出可校验的图）。
   */
  function parseCircleTangent(S) {
    if (!/切线|相切|切点|切\s*⊙|切于/.test(S)) return null;
    if (!/⊙|圆/.test(S)) return null;
    const r0 = pickAny(S, [
      /半径\s*(?:为|是|=)?\s*(\d+(?:\.\d+)?)/,
      /OA\s*=\s*(\d+(?:\.\d+)?)/
    ]);
    const PA = pick(S, /PA\s*=\s*(\d+(?:\.\d+)?)/);
    const OP = pick(S, /OP\s*=\s*(\d+(?:\.\d+)?)/);
    const angP = pickAny(S, [
      /∠\s*APB\s*=\s*(\d+(?:\.\d+)?)/,
      /∠\s*P\s*=\s*(\d+(?:\.\d+)?)/
    ]);
    const angAOP = pick(S, /∠\s*AOP\s*=\s*(\d+(?:\.\d+)?)/);
    /* 双切线："PA、PB 是⊙O 的两条切线" / "PA、PB 切⊙O 于 A、B" */
    const both = /PA\s*[、,和与]\s*PB/.test(S) || /切线长定理/.test(S);

    if (both) {
      /* 双切线：只给 ∠APB 也能画（角度全定，只是尺寸不定 → scaleFree，图上不标长度） */
      const known = [r0, OP, angP].filter(function (v) { return v != null; }).length;
      const scaleFree = (r0 == null && OP == null && angP != null);
      if (known < 2 && !scaleFree) return null;
      const st = { r: r0, OP: OP, angleAPB: angP };
      if (scaleFree) {
        /* 归一化：半径取 1（只为画图，不显示）→ OP 由 sin(∠APB/2) = r/OP 算出 */
        st.r = 1;
        st.OP = 1 / Math.sin((angP / 2) * D2R);
      } else if (st.OP == null && st.r != null && st.angleAPB != null) {
        st.OP = st.r / Math.sin((st.angleAPB / 2) * D2R);
      } else if (st.r == null && st.OP != null && st.angleAPB != null) {
        st.r = st.OP * Math.sin((st.angleAPB / 2) * D2R);
      } else if (st.angleAPB == null && st.r != null && st.OP != null) {
        st.angleAPB = 2 * Math.asin(st.r / st.OP) * R2D;
      }
      if (!(st.OP > st.r)) return null;   // OP 必须大于 r，否则点 P 在圆内、没有切线
      return {
        skel: 'circle-tangent',
        title: '⊙O 的两条切线与切线长',
        prompt: '',
        state: st,
        given: { r: r0 != null, OP: OP != null, angleAPB: angP != null },
        free: 'OP',
        both: true,
        /* 尺寸是归一化的，不能当真值显示（只有角度是题面给定的） */
        scaleFree: scaleFree,
        note: '拖动点 P 沿轴移动：两条切线 PA、PB 与 ∠APB 都在变，请比较两条切线长的关系。'
      };
    }

    /* 单切线：必须有一条长度（r/PA/OP）再加第二个条件 */
    const lens = [r0, PA, OP].filter(function (v) { return v != null; }).length;
    const hasAngle = angP != null || angAOP != null;
    if (lens < 2 && !(lens >= 1 && hasAngle)) return null;
    if (r0 == null) return null;    // 单切线没有半径就没法定位切点，不挂
    const st = { r: r0, PA: PA, OP: OP, angleP: angP, angleAOP: angAOP };
    if (st.OP == null && st.PA != null) st.OP = rightHypot(st.r, st.PA);
    if (st.PA == null && st.OP != null) st.PA = tangentLength(st.OP, st.r);
    if (st.PA == null && st.angleP != null) st.PA = st.r / Math.tan(st.angleP * D2R);
    if (st.PA == null && st.angleAOP != null) st.PA = st.r * Math.tan(st.angleAOP * D2R);
    if (st.OP == null && st.angleP != null) st.OP = st.r / Math.sin(st.angleP * D2R);
    if (st.OP == null && st.angleAOP != null) st.OP = st.r / Math.cos(st.angleAOP * D2R);
    if (st.OP == null || st.PA == null) return null;
    if (!(st.OP > st.r)) return null;
    return {
      skel: 'circle-tangent',
      title: '⊙O 的切线与过切点的半径',
      prompt: '',
      state: st,
      given: { r: r0 != null, PA: PA != null, OP: OP != null, angleP: angP != null, angleAOP: angAOP != null },
      free: 'PA',
      both: false,
      note: '拖动点 P 沿切线移动：切线长 PA 与 OP 一起变，请观察 △OAP 里哪两条边始终垂直。'
    };
  }

  /**
   * 骨架 4：△ABC + DE∥BC（平行截线成比例，A 型）
   * 适用：给出 AD、DB，再给 AE 或 EC 之一。
   */
  function parseSimilarParallel(S) {
    if (!/平行|∥/.test(S)) return null;
    if (!/△|三角形/.test(S)) return null;
    const AD = pick(S, /AD\s*=\s*(\d+(?:\.\d+)?)/);
    const DB = pick(S, /DB\s*=\s*(\d+(?:\.\d+)?)/);
    const AE = pick(S, /AE\s*=\s*(\d+(?:\.\d+)?)/);
    const EC = pick(S, /EC\s*=\s*(\d+(?:\.\d+)?)/);
    if (AD == null || DB == null) return null;
    if (AE == null && EC == null) return null;
    if (AD <= 0 || DB <= 0) return null;
    const AB = AD + DB;
    let ae = AE;
    let ec = EC;
    if (ae == null) ae = AD * ec / DB;          // AD/DB = AE/EC
    if (ec == null) ec = ae * DB / AD;
    const AC = ae + ec;
    return {
      skel: 'similar-parallel',
      title: '△ABC 中 DE∥BC',
      prompt: '',
      state: { AB: AB, AC: AC, AD: AD },
      given: { AD: true, DB: true, AE: AE != null, EC: EC != null },
      free: 'AD',
      note: '拖动点 D 沿 AB 移动：AD、DB、AE、EC 四段都在变，DE 始终平行于 BC。请自己算 AD/DB 与 AE/EC 并比较。'
    };
  }

  /**
   * 骨架 5：两个相似三角形（相似比 / 位似）
   * 适用：给出相似比 a:b 和较小图形的一条边长。只给面积比/周长比的题不挂
   *      （画两个三角形标不出面积，无法在图上校验）。
   */
  function parseSimilarPair(S) {
    const ratio = /(?:相似比|位似比|放缩比)?\s*(?:为|是|=)?\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)/.exec(S);
    if (!ratio) return null;
    if (!/相似|位似/.test(S)) return null;
    const a = parseFloat(ratio[1]);
    const b = parseFloat(ratio[2]);
    if (!(a > 0) || !(b > 0)) return null;
    const side = pickAny(S, [
      /边长\s*(?:为|是|=)?\s*(\d+(?:\.\d+)?)/,
      /一边长(?:为|是|=)?\s*(\d+(?:\.\d+)?)/,
      /对应边(?:长)?\s*(?:为|是|=)?\s*(\d+(?:\.\d+)?)/
    ]);
    if (side == null) return null;
    /* "较小/较大" 定向：没写就按 a<b 当作 a 对应较小图形 */
    const biggerFirst = /较大[^。]{0,10}的?边长/.test(S) && a > b;
    const k = biggerFirst ? b / a : (a < b ? b / a : a / b);
    return {
      skel: 'similar-pair',
      title: '两个相似三角形',
      prompt: '',
      state: { side: side, k: k },
      given: { side: true, k: true },
      givenRatio: a + ':' + b,
      free: 'k',
      note: '拖动滑块改变相似比：对应边同比变化、形状不变。请自己算对应边的比与面积的比。'
    };
  }

  /**
   * 骨架 6：Rt△（+ 斜边上的高）
   * 适用：题面是直角三角形且给了两条边（斜边/直角边任意两条）。
   * 只给一条边的 Rt△ 不挂（勾股定理无法在图上校验）。
   */
  function parseTriangleRight(S) {
    if (!/Rt△|直角/.test(S)) return null;
    if (!/△|三角形/.test(S)) return null;
    /* 三边命名必须是 ABC 且直角在 C：其他命名的图形本骨架画不出来 */
    const AB = pick(S, /AB\s*=\s*(\d+(?:\.\d+)?)/);
    const AC = pick(S, /AC\s*=\s*(\d+(?:\.\d+)?)/);
    const BC = pick(S, /BC\s*=\s*(\d+(?:\.\d+)?)/);
    if (AC == null && BC == null) return null;
    let a = AC;
    let b = BC;
    let c = AB;
    if (c == null && a != null && b != null) c = rightHypot(a, b);
    if (a == null && c != null && b != null) a = rightLeg(c, b);
    if (b == null && c != null && a != null) b = rightLeg(c, a);
    if (a == null || b == null || c == null) return null;
    if (!(a > 0) || !(b > 0) || !(c > a) || !(c > b)) return null;
    const wantsAltitude = /高|CD\s*⊥|⊥\s*AB/.test(S) && /CD/.test(S);
    return {
      skel: 'triangle-right',
      title: wantsAltitude ? 'Rt△ 与斜边上的高' : 'Rt△ABC（∠C=90°）',
      prompt: '',
      state: { a: a, b: b },
      given: { a: AC != null, b: BC != null, c: AB != null },
      free: 'b',
      altitude: wantsAltitude,
      note: wantsAltitude
        ? '拖动 A、B 改变两条直角边：斜边 AB 与斜边上的高 CD 都在变，请自己算 CD。'
        : '拖动 A、B 改变两条直角边：斜边 AB 与面积也随之变化，请自己算。'
    };
  }

  const PARSERS = [
    { cls: 'circle', fn: parseCircleChord },
    { cls: 'circle', fn: parseCircleInscribed },
    { cls: 'circle', fn: parseCircleTangent },
    { cls: 'similar', fn: parseSimilarParallel },
    { cls: 'similar', fn: parseSimilarPair },
    { cls: 'triangle', fn: parseTriangleRight }
  ];

  /**
   * 组合入口（对外契约）：知识点 + 题面 → 画板配置对象，或 null。
   * @param {string} topicId  知识点 id（如 cnm_251）
   * @param {string} prompt   题面原文
   * @param {object} opts     { itemId, topic, answer, choices }
   *
   * 顺序：题类白名单 → 答案语义门禁 → 骨架解析。任一步不通过返回 null（静默降级）。
   */
  function labFor(topicId, prompt, opts) {
    const o = opts || {};
    const cls = classOf(topicId, o);
    if (!cls) return null;
    const g = gate(prompt, { itemId: o.itemId, answer: o.answer, choices: o.choices });
    if (g.blocked) return null;
    const S = plain(prompt);
    for (let i = 0; i < PARSERS.length; i++) {
      const p = PARSERS[i];
      if (p.cls !== cls) continue;
      const lab = p.fn(S);
      if (!lab) continue;
      lab.prompt = prompt;
      lab.cls = cls;
      lab.topicId = topicId;
      return lab;
    }
    return null;
  }

  /* ============================================================ 5. solve（纯函数，唯一数值来源）
   *
   * 画图与测试都只读 solve() 的返回值：图上标的数 = 测试断言的数 = 题库答案。
   * 改任何公式都从这里改，不许在 draw 里另算一遍。
   */

  /** 数字美化：最多 2 位小数，去掉尾零 */
  function fmt(n) {
    if (n == null || !isFinite(n)) return '?';
    const r = Math.round(n * 100) / 100;
    return String(r);
  }

  function solve(lab) {
    if (!lab) return null;
    const st = lab.state;
    /* 题面给出的已知量（画板只许标这些，其余一律 '?'）—— 由各骨架解析时记入 lab.given */
    const gv = givenValues(lab);
    switch (lab.skel) {
      case 'circle-chord': {
        /* 谁不动由 lab.fixed 决定（题面给了半径就锁半径），另一个按垂径定理跟着算 */
        let r = st.r;
        let d = st.d;
        let chord = st.chord;
        if (chord == null) chord = chordLength(r, d);
        if (lab.fixed === 'r') {
          r = st.r;
          chord = Math.min(chord, 2 * r);
          d = chordDistance(r, chord);
        } else {
          d = st.d;
          if (d == null) d = chordDistance(r, chord);
          r = radiusFromChordDist(chord, d);
        }
        if (!(chord > 0) || !(r > 0) || chord > 2 * r + 1e-9) return null;
        return {
          r: r, d: d, chord: chord, halfChord: chord / 2,
          central: 2 * Math.asin(Math.min(1, chord / (2 * r))) * R2D,
          given: gv
        };
      }
      case 'circle-inscribed': {
        const central = st.central;
        const inscribed = st.onMinor ? inscribedOnMinorArc(central) : inscribedFromCentral(central);
        return { central: central, inscribed: inscribed, onMinor: !!st.onMinor, given: gv };
      }
      case 'circle-tangent': {
        const r = st.r;
        let OP = st.OP;
        if (lab.both) {
          if (!(OP > r)) return null;
        } else {
          /* 单切线以 PA 为自由量：拖动 P 改 PA，OP 由勾股算出（题目参数下与题面一致） */
          if (st.PA != null) OP = rightHypot(r, st.PA);
          if (OP == null || !(OP > r)) return null;
        }
        const PA = tangentLength(OP, r);
        const angleAPO = Math.asin(r / OP) * R2D;      // 切点半径⊥切线 → sin∠P = r/OP
        const angleAOP = 90 - angleAPO;
        const apex = lab.both ? 2 * angleAPO : angleAPO;
        const areaPAOB = lab.both ? r * PA : 0.5 * r * PA;
        /* 四边形 PAOB：A、B 处各一个直角 → ∠AOB = 180° − ∠APB（内角和 360°） */
        const angleAOB = lab.both ? 180 - apex : null;
        return {
          r: r, OP: OP, PA: PA, angleP: apex, angleAPO: angleAPO, angleAOP: angleAOP,
          angleAOB: angleAOB, areaPAOB: areaPAOB, both: !!lab.both, scaleFree: !!lab.scaleFree,
          given: gv
        };
      }
      case 'similar-parallel': {
        const AB = st.AB;
        const AC = st.AC;
        const AD = st.AD;
        const DB = AB - AD;
        if (!(AD > 0) || !(DB > 0)) return null;
        const AE = AEof(AD, AB, AC);              // 由相似：AD/AB = AE/AC
        const EC = AC - AE;
        if (!(EC > 0)) return null;
        return {
          AB: AB, AC: AC, AD: AD, DB: DB, AE: AE, EC: EC,
          ratio: AD / DB, AEoverEC: AE / EC, scale: AD / AB, given: gv
        };
      }
      case 'similar-pair': {
        const s = st.side;
        const k = st.k;
        if (!(s > 0) || !(k > 0)) return null;
        return {
          side: s, k: k, big: similarSide(s, k), areaK: similarAreaRatio(k),
          ratioText: lab.givenRatio || ('1:' + fmt(k)), given: gv
        };
      }
      case 'triangle-right': {
        const a = st.a;
        const b = st.b;
        if (!(a > 0) || !(b > 0)) return null;
        const c = rightHypot(a, b);
        const area = 0.5 * a * b;
        const alt = lab.altitude ? altitudeToHypotenuse(a, b, c) : null;
        /* 射影定理：直角边在斜边上的射影 = 直角边² / 斜边 */
        const projA = a * a / c;
        const projB = b * b / c;
        return {
          a: a, b: b, c: c, area: area, altitude: alt,
          /* ∠A 是 BC 边的对角（a=AC、b=BC、c=AB） */
          angleA: lawCosAngle(b, a, c), angleB: lawCosAngle(a, b, c),
          projA: projA, projB: projB, given: gv
        };
      }
      default:
        return null;
    }
  }

  /** 平行截线：AE = AC · AD / AB
   *  拆成函数是因为 draw 与 solve 都要用，避免两处各写一遍公式。 */
  function AEof(AD, AB, AC) {
    return AC * AD / AB;
  }

  /* ============================================================ 5b. 已知量 vs 派生量
   *
   * ★ 教学硬规则（用户判据）★
   * 画板的目的是让学生看懂**问题怎么解决**，所以画板上只许出现「题面给出的已知量」。
   * 由已知量推出来的东西（第三边、面积、比值、弦心距、定理等式）一律不得静态标注 ——
   * 那等于图替学生把题算完了，学生只会照抄结论。可推导量只能以 '?' 占位，
   * 学生自己算完点「我算好了」之后，才在空白处显示对比结果。
   *
   * 所以渲染层读数值必须走下面两个函数，不许直接 fmt(v.xxx)：
   *   knownText(lab, sol, key, v)  → 题面给了这个量就返回已知值，否则 '?'
   *   deriveText(...)              → 永远是 '?'（派生量，等学生填）
   */

  /* 骨架 → 该骨架「可被题面给定」的量（与 parse* 里 lab.given 的键一一对应） */
  const GIVEN_KEYS = {
    'circle-chord': ['r', 'd', 'chord'],
    'circle-inscribed': ['central', 'inscribed'],
    'circle-tangent': ['r', 'PA', 'OP', 'angleP', 'angleAOP', 'angleAPB'],
    'similar-parallel': ['AD', 'DB', 'AE', 'EC'],
    'similar-pair': ['side', 'k'],
    'triangle-right': ['a', 'b', 'c']
  };

  /**
   * 取题面已知量的判定表（lab.given 的拷贝）。
   * similar-pair 的 k 与 side 在解析时恒为 true，但学生拖滑块后画布上的尺寸已经不是
   * 题面那个数了 —— 所以只在「没有拖动过」时算已知，否则会让标出来的数和题面对不上。
   */
  function givenValues(lab) {
    if (!lab) return {};
    const g = lab.given ? Object.assign({}, lab.given) : {};
    if (lab.skel === 'similar-pair') {
      const s0 = lab._start && lab._start.side;
      if (s0 != null && Math.abs(lab.state.side - s0) > 1e-9) g.side = false;
      const k0 = lab._start && lab._start.k;
      if (k0 != null && Math.abs(lab.state.k - k0) > 1e-9) g.k = false;
    }
    return g;
  }

  /** 题面给了 → 数值；没给 → '?'。用于边长、半径、角度这类标量 */
  function knownText(lab, sol, key) {
    const g = (sol && sol.given) || givenValues(lab);
    const v = sol ? sol[key] : null;
    return g[key] ? fmt(v) : '?';
  }

  /** 派生量：题面从没给过，只能等学生自己算 —— 永远是 '?' */
  function deriveText() {
    return '?';
  }

  /**
   * 自检面板要核对的结果行（学生点「我算好了」之后才显示）。
   * 这里才允许出现真实值 —— 静态标注一律不许，见上面 5b 的规则。
   * 只列这道题真正要求 / 真正在图上留了问号的量，不把内部中间量全倒出来。
   */
  function checkRows(lab, sol) {
    if (!lab || !sol) return [];
    const g = sol.given || givenValues(lab);
    const rows = [];
    const add = function (name, real, unit) {
      rows.push({ name: name, yours: '', real: real, unit: unit || '' });
    };
    switch (lab.skel) {
      case 'circle-chord':
        if (!g.d) add('弦心距 OH', sol.d);
        if (!g.chord) add('弦长 AB', sol.chord);
        if (!g.r) add('半径 OA', sol.r);
        break;
      case 'circle-inscribed':
        if (!g.central) add('圆心角 ∠AOB', sol.central, '°');
        if (!g.inscribed) add(sol.onMinor ? '圆周角 ∠ACB（劣弧侧）' : '圆周角 ∠ACB', sol.inscribed, '°');
        break;
      case 'circle-tangent':
        if (!lab.scaleFree) {
          if (!g.PA) add('切线长 PA', sol.PA);
          if (!g.OP) add('OP', sol.OP);
          if (lab.both) add('PB（切线长定理）', sol.PA);
        }
        if (!g.angleP && !g.angleAPB) add(lab.both ? '∠APB' : '∠P', sol.angleP, '°');
        break;
      case 'similar-parallel':
        if (!g.EC) add('EC', sol.EC);
        if (!g.AE) add('AE', sol.AE);
        add('AD/DB', sol.ratio);
        add('AE/EC', sol.AEoverEC);
        break;
      case 'similar-pair':
        add("A'B'（对应边）", sol.big);
        add("A'B'/AB 即相似比 k", sol.k);
        add('面积比 S大:S小 = k²', sol.areaK);
        break;
      case 'triangle-right':
        if (!g.c) add('斜边 AB', sol.c);
        if (!g.b) add('直角边 BC', sol.b);
        if (!g.a) add('直角边 AC', sol.a);
        add('面积 S', sol.area);
        if (lab.altitude) add('斜边上的高 CD', sol.altitude);
        break;
      default:
        break;
    }
    return rows;
  }

  /* 画布顶部「题面已知」行用的量名（带单位符号），顺序即展示顺序 */
  const GIVEN_LABEL = {
    'circle-chord': { r: 'OA', d: 'OH', chord: 'AB' },
    'circle-inscribed': { central: '∠AOB', inscribed: '∠ACB' },
    'circle-tangent': { r: 'OA', PA: 'PA', OP: 'OP', angleP: '∠P', angleAPB: '∠APB', angleAOP: '∠AOP' },
    'similar-parallel': { AD: 'AD', DB: 'DB', AE: 'AE', EC: 'EC' },
    'similar-pair': { side: 'AB', k: '相似比' },
    'triangle-right': { a: 'AC', b: 'BC', c: 'AB' }
  };

  /** 题面已知量 → 「OA = 5、AB = 8」这样的短句；一个都没给就返回「（无）」 */
  function knownList(lab, sol) {
    const keys = GIVEN_KEYS[lab.skel] || [];
    const labels = GIVEN_LABEL[lab.skel] || {};
    const g = (sol && sol.given) || givenValues(lab);
    const parts = [];
    keys.forEach(function (k) {
      if (!g[k]) return;
      const name = labels[k] || k;
      /* 相似比是「2:3」这种字符串，不是标量 */
      const text = (k === 'k' && lab.givenRatio) ? lab.givenRatio : fmt(sol ? sol[k] : null);
      parts.push(name + ' = ' + text);
    });
    return parts.length ? parts.join('、') : '（题面未给数值）';
  }

  /* ============================================================ 6. 渲染
   *
   * 画布一律按「数学比例」等比映射（不许拉伸），否则图形会失真、标注会误导。
   * 每个骨架一个 draw 函数 + 一组拖拽手柄；手柄只改 state，改完重算 solve 再重画。
   */

  let ACTIVE = null;         // 当前挂着的画板实例（面板重建时先销毁上一块）
  const COLOR = {
    line: '#2a7de1',
    aux: 'rgba(120,120,120,.75)',
    mark: '#c0392b',
    angle: '#e67e22',
    fill: 'rgba(42,125,225,.08)',
    text: '#1f2933',
    handle: '#2ecc71',
    auxText: '#6b7c93'
  };

  function destroy() {
    if (!ACTIVE) return;
    try {
      if (ACTIVE._ro) ACTIVE._ro.disconnect();
      if (ACTIVE.el && ACTIVE.el.parentNode) ACTIVE.el.parentNode.removeChild(ACTIVE.el);
    } catch (e) { /* 销毁失败不影响讲解 */ }
    ACTIVE = null;
  }

  /** 把角度规约到 [0,360) */
  function norm360(a) {
    let x = a % 360;
    if (x < 0) x += 360;
    return x;
  }

  /** 把 C 点限制在正确的弧上（优弧或劣弧），保证圆周角公式始终成立 */
  function clampArc(angDeg, centralDeg, onMinor) {
    const half = centralDeg / 2;
    const lo = onMinor ? 90 - half : 90 + half;
    const hi = onMinor ? 90 + half : 450 - half;
    let a = norm360(angDeg);
    if (!onMinor && a < lo) a += 360;
    const margin = Math.min(12, Math.max(0.5, (hi - lo) / 2 - 1));
    return Math.min(hi - margin, Math.max(lo + margin, a));
  }

  /**
   * 挂载画板。lab 为 labFor() 的返回值。
   * @return {{el: Element, state: function, clear: function}}
   */
  function mount(lab) {
    if (!lab) return null;
    destroy();     // 面板重建时旧画板必须先销毁（与 C 卡 cytoscape 同一待遇）

    const wrap = document.createElement('div');
    wrap.className = 'funclab geomlab geomlab-' + lab.skel;
    const info = document.createElement('div');
    info.className = 'funclab-formula';
    info.textContent = lab.title;
    const note = document.createElement('div');
    note.className = 'funclab-note';
    note.textContent = lab.note || '';
    const canvas = document.createElement('canvas');
    canvas.className = 'funclab-canvas geomlab-canvas';
    const ctrl = document.createElement('div');
    ctrl.className = 'funclab-sliders';
    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'small';
    resetBtn.textContent = '回到题目参数';

    wrap.appendChild(info);
    wrap.appendChild(note);
    wrap.appendChild(canvas);
    wrap.appendChild(ctrl);

    const dpr = (typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1) || 1;
    const ctx = canvas.getContext('2d');
    const startState = JSON.parse(JSON.stringify(lab.state));
    let sol = solve(lab);
    let handles = [];       // [{x, y, onDrag}]，每次 draw 重算
    const sliders = [];     // [{input, key}]，供「回到题目参数」复位

    /* ---------------- 世界坐标 → 屏幕（等比，居中） ---------------- */
    const view = { s: 1, ox: 0, oy: 0, W: 0, H: 0, xMin: 0, yMin: 0 };
    function fit(bounds) {
      const W = canvas.clientWidth || 560;
      const H = canvas.clientHeight || 320;
      if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
        canvas.width = Math.round(W * dpr);
        canvas.height = Math.round(H * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const pad = 46;
      const spanX = Math.max(1e-6, bounds.xMax - bounds.xMin);
      const spanY = Math.max(1e-6, bounds.yMax - bounds.yMin);
      const s = Math.min((W - pad * 2) / spanX, (H - pad * 2) / spanY);
      view.s = s;
      view.W = W; view.H = H;
      view.xMin = bounds.xMin;
      view.yMin = bounds.yMin;
      view.ox = (W - spanX * s) / 2;
      view.oy = (H - spanY * s) / 2;
      return view;
    }
    function X(wx) { return view.ox + (wx - view.xMin) * view.s; }
    function Y(wy) { return view.oy + (wy - view.yMin) * view.s; }
    function unX(px) { return view.xMin + (px - view.ox) / view.s; }
    function unY(py) { return view.yMin + (py - view.oy) / view.s; }

    /* ---------------- 绘图小工具 ---------------- */
    function bgLabel(x, y, text, color) {
      ctx.save();
      ctx.font = 'bold 12px sans-serif';
      const tw = ctx.measureText(text).width;
      ctx.fillStyle = 'rgba(255,255,255,.9)';
      ctx.fillRect(x - 3, y - 12, tw + 6, 16);
      ctx.fillStyle = color || COLOR.text;
      ctx.fillText(text, x, y);
      ctx.restore();
    }
    function seg(p, q, color, width, dash) {
      ctx.save();
      ctx.strokeStyle = color || COLOR.line;
      ctx.lineWidth = width == null ? 2 : width;
      ctx.setLineDash(dash || []);
      ctx.beginPath();
      ctx.moveTo(X(p.x), Y(p.y));
      ctx.lineTo(X(q.x), Y(q.y));
      ctx.stroke();
      ctx.restore();
    }
    function circleLine(cx, cy, r, color, dash) {
      ctx.save();
      ctx.strokeStyle = color || COLOR.line;
      ctx.lineWidth = 2;
      ctx.setLineDash(dash || []);
      ctx.beginPath();
      ctx.arc(X(cx), Y(cy), Math.abs(r * view.s), 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    /** 顶点名 */
    function name(p, text, dx, dy, color) {
      bgLabel(X(p.x) + (dx == null ? 6 : dx), Y(p.y) + (dy == null ? -8 : dy), text, color);
    }
    /** 直角符号：在顶点 p，沿 d1/d2 两个世界坐标单位方向 */
    function rightAngle(p, d1, d2) {
      const L = 11;
      const a = { x: X(p.x) + d1.x * L, y: Y(p.y) + d1.y * L };
      const b = { x: X(p.x) + d2.x * L, y: Y(p.y) + d2.y * L };
      const c = { x: a.x + d2.x * L, y: a.y + d2.y * L };
      ctx.save();
      ctx.strokeStyle = COLOR.mark;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(c.x, c.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.restore();
    }
    /** 角弧 + 角度标注。p 顶点，q1/q2 为两条边上的点 */
    function angleArc(p, q1, q2, radiusWorld, text, color) {
      const cx = X(p.x), cy = Y(p.y);
      const a1 = Math.atan2(Y(q1.y) - cy, X(q1.x) - cx);
      const a2 = Math.atan2(Y(q2.y) - cy, X(q2.x) - cx);
      const r = Math.max(16, radiusWorld * view.s);
      let d = a2 - a1;
      while (d <= -Math.PI) d += Math.PI * 2;
      while (d > Math.PI) d -= Math.PI * 2;
      ctx.save();
      ctx.strokeStyle = color || COLOR.angle;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.arc(cx, cy, r, a1, a1 + d, d < 0);
      ctx.stroke();
      if (text) {
        const mid = a1 + d / 2;
        bgLabel(cx + Math.cos(mid) * (r + 10) - 14, cy + Math.sin(mid) * (r + 10) + 4, text, color || COLOR.angle);
      }
      ctx.restore();
    }
    function addHandle(wx, wy, onDrag) {
      handles.push({ x: wx, y: wy, onDrag: onDrag });
    }
    function drawHandles() {
      handles.forEach(function (h) {
        ctx.save();
        ctx.fillStyle = 'rgba(46,204,113,.9)';
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(X(h.x), Y(h.y), 5.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      });
    }

    /* ---------------- 各骨架的绘制 ---------------- */
    const DRAW = {
      /* 垂径定理：圆心 O、弦 AB 水平、弦心距 OH 竖直、半径 OA */
      'circle-chord': function () {
        const v = sol;
        const r = v.r;
        const d = v.d;
        const half = v.halfChord;
        fit({ xMin: -r * 1.06, xMax: r * 1.06, yMin: -r * 1.06, yMax: r * 1.06 });
        circleLine(0, 0, r);
        const A = { x: -half, y: d };
        const B = { x: half, y: d };
        const O = { x: 0, y: 0 };
        const H = { x: 0, y: d };
        seg(A, B, COLOR.line, 2.6);
        seg(O, A, COLOR.aux, 1.6, [5, 4]);
        seg(O, H, COLOR.aux, 1.6, [5, 4]);
        if (Math.abs(d) > 1e-6) rightAngle(H, { x: 0, y: -(d > 0 ? 1 : -1) }, { x: 1, y: 0 });
        name(A, 'A', -18, 16);
        name(B, 'B', 8, 16);
        name(O, 'O', 6, 18);
        name(H, 'H', -6, 16);
        /* 只标题面给了的量：半径与弦长给过就标数，弦心距是推出来的（或反过来）就留 '?' */
        bgLabel(X(0) + 8, Y(d) - 8, 'OH = ' + knownText(lab, v, 'd'));
        bgLabel(X(-half / 2) - 24, Y(d) - 4, 'AB = ' + knownText(lab, v, 'chord'), COLOR.text);
        bgLabel(X(-r * 0.28), Y(d * 0.7), 'OA = ' + knownText(lab, v, 'r'), COLOR.text);
        bgLabel(6, 18, '题面已知：' + knownList(lab, v) + '；其余问号处请自己算', COLOR.auxText);
        addHandle(B.x, B.y, function (w) {
          /* 弦端点水平拖动 → 改弦长；半径固定时弦心距按垂径定理跟着变。
           * 下限取 8% 半径（不是 35%）：弦要能从"几乎直径"拖到"几乎是一条点"，
           * 弦心距 OH 才会从 ≈0 明显涨到 ≈r，学生才看得见「弦越短、离圆心越远」。 */
          const half2 = Math.abs(w.x);
          let chord = 2 * half2;
          const rNow = lab.state.r || r;
          if (lab.fixed === 'r') chord = Math.min(chord, 2 * rNow * 0.999);
          lab.state.chord = Math.max(0.08 * 2 * rNow, chord);
        });
      },

      /* 圆周角定理：A、B 在圆上，C 在另一段弧上 */
      'circle-inscribed': function () {
        const th = sol.central;
        const R = 1;
        fit({ xMin: -R * 1.2, xMax: R * 1.2, yMin: -R * 1.2, yMax: R * 1.2 });
        circleLine(0, 0, R);
        const aA = (90 + th / 2) * D2R;
        const aB = (90 - th / 2) * D2R;
        const A = { x: Math.cos(aA) * R, y: Math.sin(aA) * R };
        const B = { x: Math.cos(aB) * R, y: Math.sin(aB) * R };
        const O = { x: 0, y: 0 };
        const aC = clampArc(lab.state.cAng, th, sol.onMinor) * D2R;
        const C = { x: Math.cos(aC) * R, y: Math.sin(aC) * R };
        seg(O, A, COLOR.aux, 1.6);
        seg(O, B, COLOR.aux, 1.6);
        seg(C, A, COLOR.line, 2.2);
        seg(C, B, COLOR.line, 2.2);
        seg(A, B, COLOR.aux, 1.4, [5, 4]);
        name(A, 'A', -18, -8);
        name(B, 'B', 8, -8);
        name(O, 'O', 2, 18);
        name(C, 'C', 8, 16);
        /* 两个角的数值都标（题面给哪个就标哪个，另一个留 '?'），但不写「圆周角=圆心角的一半」 */
        angleArc(O, A, B, 0.34, '∠AOB = ' + knownText(lab, sol, 'central') + '°', COLOR.mark);
        angleArc(C, A, B, 0.34, '∠ACB = ' + knownText(lab, sol, 'inscribed') + '°', COLOR.angle);
        bgLabel(6, 18, '题面已知：' + knownList(lab, sol) + '；两角关系请自己看', COLOR.auxText);
        addHandle(B.x, B.y, function (w) {
          /* 拖 B：按对称位置反解圆心角（A、B 关于竖轴对称）。
           * 上限从 170° 提到 176°：圆周角要能拖到 88° 附近，学生才看得出「圆心角一缩，
           * 圆周角同步缩」的大幅度变化；下限 6° 让圆周角退到 3° 附近。 */
          let ang = Math.atan2(w.y, w.x) * R2D;
          let delta = Math.abs(norm360(ang) - 90);
          if (delta > 180) delta = 360 - delta;
          lab.state.central = Math.max(6, Math.min(176, 2 * delta));
        });
        addHandle(C.x, C.y, function (w) {
          /* 拖 C：只能沿弧滑动 —— ∠ACB 的值不变，这正是「同弧圆周角相等」 */
          lab.state.cAng = Math.atan2(w.y, w.x) * R2D;
        });
      },

      /* 切线：单切线（A 在右侧，切线竖直）或双切线（A、B 对称） */
      'circle-tangent': function () {
        const v = sol;
        const r = v.r;
        const OP = v.OP;
        const PA = v.PA;
        if (v.both) {
          const span = Math.max(r * 1.15, OP * 1.1);
          fit({ xMin: -r * 1.15, xMax: span, yMin: -span * 0.72, yMax: span * 0.72 });
          circleLine(0, 0, r);
          const sina = r / OP;
          const cosa = PA / OP;
          const A = { x: r * cosa, y: r * sina };
          const B = { x: r * cosa, y: -r * sina };
          const P = { x: OP, y: 0 };
          const O = { x: 0, y: 0 };
          seg(O, A, COLOR.aux, 1.6);
          seg(O, B, COLOR.aux, 1.6);
          seg(O, P, COLOR.aux, 1.4, [5, 4]);
          seg(P, A, COLOR.line, 2.4);
          seg(P, B, COLOR.line, 2.4);
          rightAngle(A, { x: -sina, y: cosa }, { x: 0, y: -1 });
          rightAngle(B, { x: -sina, y: -cosa }, { x: 0, y: 1 });
          name(A, 'A', 8, -10);
          name(B, 'B', 8, 20);
          name(P, 'P', 8, -10);
          name(O, 'O', 6, 20);
          angleArc(P, A, B, 0.42, '∠APB = ' + knownText(lab, v, 'angleAPB') + '°', COLOR.angle);
          /* 归一化尺寸的图（只给 ∠APB）不能标长度，否则标出来的是假数 */
          if (!v.scaleFree) {
            bgLabel(X((P.x + A.x) / 2) + 6, Y((P.y + A.y) / 2), 'PA = ' + knownText(lab, v, 'PA'));
            bgLabel(X((P.x + B.x) / 2) + 6, Y((P.y + B.y) / 2) + 14, 'PB = ' + deriveText());
            bgLabel(X(OP / 2), Y(0) - 8, 'OP = ' + knownText(lab, v, 'OP'), COLOR.text);
          }
          bgLabel(6, 18, '题面已知：' + knownList(lab, v) +
            (v.scaleFree ? '（题面未给尺寸，图上不标长度）' : '；PA 与 PB 的关系请自己看'), COLOR.auxText);
          addHandle(P.x, P.y, function (w) {
            lab.state.OP = Math.max(r * 1.02, Math.min(r * 6, Math.abs(w.x) || OP));
          });
          return;
        }
        /* 单切线：O 在原点，A 在 (r,0)，切线 x = r，P 在 (r, PA) */
        const top = Math.max(PA, r) * 1.15;
        fit({ xMin: -r * 1.2, xMax: r * 1.2, yMin: -r * 1.2, yMax: top });
        circleLine(0, 0, r);
        const O = { x: 0, y: 0 };
        const A = { x: r, y: 0 };
        const P = { x: r, y: PA };
        seg(O, A, COLOR.aux, 1.6);
        seg(A, P, COLOR.line, 2.6);
        seg(O, P, COLOR.aux, 1.6, [5, 4]);
        rightAngle(A, { x: 0, y: 1 }, { x: -1, y: 0 });
        name(A, 'A', 8, 20);
        name(P, 'P', 8, -10);
        name(O, 'O', -20, 18);
        angleArc(P, O, A, 0.36, '∠P = ' + knownText(lab, v, 'angleP') + '°', COLOR.angle);
        bgLabel(X(-r * 0.62), Y(0) - 8, 'OA = ' + knownText(lab, v, 'r'), COLOR.text);
        bgLabel(X(r + 6), Y(PA / 2), 'PA = ' + knownText(lab, v, 'PA'));
        bgLabel(6, 18, '题面已知：' + knownList(lab, v) + '；求 OP 请自己算', COLOR.auxText);
        addHandle(P.x, P.y, function (w) {
          lab.state.PA = Math.max(0.35 * r, Math.min(r * 4, Math.abs(w.y) || PA));
        });
      },

      /* 平行截线：A 上，B 左下，C 右下；D 在 AB 上，E 在 AC 上，DE∥BC */
      'similar-parallel': function () {
        const v = sol;
        const AB = v.AB;
        const AC = v.AC;
        /* 固定顶角摆图（不影响成比例的结论；只为画面好看） */
        const apex = 44 * D2R;
        const A = { x: 0, y: 0 };
        const B = { x: -AB * Math.sin(apex / 2), y: -AB * Math.cos(apex / 2) };
        const C = { x: AC * Math.sin(apex / 2), y: -AC * Math.cos(apex / 2) };
        const t = v.scale;
        const D = { x: A.x + (B.x - A.x) * t, y: A.y + (B.y - A.y) * t };
        const E = { x: A.x + (C.x - A.x) * t, y: A.y + (C.y - A.y) * t };
        fit({
          xMin: Math.min(B.x, C.x), xMax: Math.max(B.x, C.x),
          yMin: Math.min(B.y, C.y), yMax: 0
        });
        seg(A, B, COLOR.line, 2.4);
        seg(A, C, COLOR.line, 2.4);
        seg(B, C, COLOR.line, 2.4);
        seg(D, E, COLOR.mark, 2.6);
        name(A, 'A', -6, -12);
        name(B, 'B', -20, 16);
        name(C, 'C', 8, 16);
        name(D, 'D', -24, 2);
        name(E, 'E', 10, 2);
        /* 四段长度：题面给了就标数，没给（要学生求的那条）就留 '?' —— 不许标比值 */
        bgLabel(X((A.x + D.x) / 2) - 22, Y((A.y + D.y) / 2), 'AD = ' + knownText(lab, v, 'AD'));
        bgLabel(X((D.x + B.x) / 2) - 22, Y((D.y + B.y) / 2) - 8, 'DB = ' + knownText(lab, v, 'DB'));
        bgLabel(X((A.x + E.x) / 2) + 8, Y((A.y + E.y) / 2), 'AE = ' + knownText(lab, v, 'AE'));
        bgLabel(X((E.x + C.x) / 2) + 8, Y((E.y + C.y) / 2) - 8, 'EC = ' + knownText(lab, v, 'EC'));
        bgLabel(X((D.x + E.x) / 2) - 26, Y(D.y) + 18, 'AD/DB = ' + deriveText() + '　AE/EC = ' + deriveText(), COLOR.auxText);
        bgLabel(6, 18, '题面已知：' + knownList(lab, v) + '；两个比值请自己算后比较', COLOR.auxText);
        addHandle(D.x, D.y, function (w) {
          /* D 沿 AB 滑动：AD 变，AE/EC 跟着变，但两段之比始终相等。
           * 范围放宽到 8%–92%：AD/DB 能从 ≈0.09 变到 ≈11，两个比值的同步变化才肉眼可辨
           * （原来 12%–88% 在题面参数附近只从 0.46 变到 1.6，学生看不出规律）。 */
          const dx = B.x - A.x;
          const dy = B.y - A.y;
          const proj = ((w.x - A.x) * dx + (w.y - A.y) * dy) / (dx * dx + dy * dy);
          lab.state.AD = Math.max(0.08 * AB, Math.min(0.92 * AB, proj * AB));
        });
      },

      /* 两个相似（位似）三角形：以 O 为位似中心 */
      'similar-pair': function () {
        const v = sol;
        const s = v.side;
        const k = v.k;
        const O = { x: -s * 0.75, y: -s * 0.4 };
        const A = { x: 0, y: 0 };
        const B = { x: s, y: 0 };
        const C = { x: s * 0.42, y: s * 0.72 };
        function homo(p, kk) {
          return { x: O.x + (p.x - O.x) * kk, y: O.y + (p.y - O.y) * kk };
        }
        const A2 = homo(A, k);
        const B2 = homo(B, k);
        const C2 = homo(C, k);
        const all = [O, A, B, C, A2, B2, C2];
        fit({
          xMin: Math.min.apply(null, all.map(function (p) { return p.x; })),
          xMax: Math.max.apply(null, all.map(function (p) { return p.x; })),
          yMin: Math.min.apply(null, all.map(function (p) { return p.y; })),
          yMax: Math.max.apply(null, all.map(function (p) { return p.y; }))
        });
        [[A, A2], [B, B2], [C, C2]].forEach(function (pair) {
          seg(O, pair[1], COLOR.aux, 1.2, [4, 4]);
        });
        seg(A, B, COLOR.line, 2.4); seg(B, C, COLOR.line, 2.4); seg(C, A, COLOR.line, 2.4);
        seg(A2, B2, COLOR.mark, 2.6); seg(B2, C2, COLOR.mark, 2.6); seg(C2, A2, COLOR.mark, 2.6);
        name(O, 'O', -18, 16);
        name(A, 'A', -18, 14); name(B, 'B', 6, 14); name(C, 'C', 6, -8);
        name(A2, "A'", -22, 14); name(B2, "B'", 6, 14); name(C2, "C'", 6, -8);
        bgLabel(X((A.x + B.x) / 2) - 12, Y(0) + 20, 'AB = ' + knownText(lab, v, 'side'), COLOR.text);
        bgLabel(X((A2.x + B2.x) / 2) - 14, Y(0) + 20, "A'B' = " + deriveText());
        bgLabel(6, 18, '题面已知：' + knownList(lab, v) + '；对应边的比与面积比请自己算', COLOR.auxText);
      },

      /* 直角三角形（可带斜边上的高） */
      'triangle-right': function () {
        const v = sol;
        const a = v.a;            // 直角边 CA（竖直）
        const b = v.b;            // 直角边 CB（水平）
        const C = { x: 0, y: 0 };
        const A = { x: 0, y: a };
        const B = { x: b, y: 0 };
        const m = Math.max(a, b);
        fit({ xMin: -m * 0.12, xMax: b * 1.08, yMin: -m * 0.12, yMax: a * 1.08 });
        seg(C, A, COLOR.line, 2.4);
        seg(C, B, COLOR.line, 2.4);
        seg(A, B, COLOR.aux, 2.4);
        rightAngle(C, { x: 1, y: 0 }, { x: 0, y: 1 });
        name(A, 'A', -18, -6);
        name(B, 'B', 8, 18);
        name(C, 'C', -18, 18);
        bgLabel(X(0) - 52, Y(a / 2), 'AC = ' + knownText(lab, v, 'a'), COLOR.text);
        bgLabel(X(b / 2) - 14, Y(0) + 20, 'BC = ' + knownText(lab, v, 'b'), COLOR.text);
        bgLabel(X(b / 2) + 10, Y(a / 2) - 4, 'AB = ' + knownText(lab, v, 'c'));
        if (lab.altitude && v.altitude) {
          /* 垂足 D：AD = AC²/AB（射影定理） */
          const t = v.projA / v.c;
          const D = { x: A.x + (B.x - A.x) * t, y: A.y + (B.y - A.y) * t };
          seg(C, D, COLOR.angle, 2.2, [6, 4]);
          const u = { x: (B.x - A.x) / v.c, y: (B.y - A.y) / v.c };
          const w = { x: (C.x - D.x) / (v.altitude || 1), y: (C.y - D.y) / (v.altitude || 1) };
          rightAngle(D, u, w);
          name(D, 'D', 8, 18);
          bgLabel(X((C.x + D.x) / 2) + 6, Y((C.y + D.y) / 2) - 8, 'CD = ' + deriveText());
        }
        bgLabel(6, 18, '题面已知：' + knownList(lab, v) + '；面积 S = ' + deriveText() +
          (lab.altitude ? '，CD = ' + deriveText() : '') + ' 请自己算', COLOR.auxText);
        addHandle(A.x, A.y, function (w) {
          /* 直角边 AC 可拖到 0.35×~2.2×：面积 S = ab/2 随之从 ~0.37S₀ 变到 ~2.2S₀，
           * 斜边 c 也明显变化（原来的 3a+1 上限太大，拖动会冲出画布）。 */
          lab.state.a = Math.max(0.35 * a, Math.min(2.2 * a, Math.abs(w.y) || a));
        });
        addHandle(B.x, B.y, function (w) {
          lab.state.b = Math.max(0.35 * b, Math.min(2.2 * b, Math.abs(w.x) || b));
        });
      }
    };

    function redraw() {
      handles = [];
      sol = solve(lab);
      const W = canvas.clientWidth || 560;
      const H = canvas.clientHeight || 320;
      if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
        canvas.width = Math.round(W * dpr);
        canvas.height = Math.round(H * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      if (!sol) return;
      const fn = DRAW[lab.skel];
      if (!fn) return;
      fn();
      drawHandles();
    }

    /* ---------------- 控件（每个骨架只建一次，不放进 draw 里，避免重复插入） ---------------- */
    function buildControls() {
      if (lab.skel === 'similar-pair') {
        const row = document.createElement('label');
        row.className = 'funclab-slider';
        row.appendChild(document.createTextNode('相似比 k = '));
        const val = document.createElement('span');
        val.textContent = fmt(lab.state.k);
        const input = document.createElement('input');
        input.type = 'range';
        input.min = '0.4';
        input.max = '3';
        input.step = '0.05';
        input.value = String(lab.state.k);
        input.addEventListener('input', function () {
          lab.state.k = parseFloat(input.value);
          val.textContent = fmt(lab.state.k);
          redraw();
        });
        row.appendChild(val);
        row.appendChild(input);
        ctrl.appendChild(row);
        sliders.push({ input: input, key: 'k', show: val });
      }
      ctrl.appendChild(resetBtn);
    }

    /* ---------------- 自检面板（「我算好了」才显形） ----------------
     * 静态标注不许写结论，但学生需要一个对答案的地方，否则不知道自己对错。
     * 折中：默认什么都不显示，学生自己算完点按钮，才把「你算的」和真实值并排列出来。
     * 抄不到（要先动手），也不用替他算（只是核对）。
     */
    function buildCheck() {
      const box = document.createElement('div');
      box.className = 'geomlab-check';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'small geomlab-check-btn';
      btn.textContent = '我算好了';
      const out = document.createElement('div');
      out.className = 'geomlab-check-out';
      out.hidden = true;
      btn.addEventListener('click', function () {
        const rows = checkRows(lab, solve(lab));
        out.textContent = '';
        rows.forEach(function (r) {
          const line = document.createElement('div');
          line.className = 'geomlab-check-row';
          const you = document.createElement('span');
          you.className = 'geomlab-check-you';
          you.textContent = '你算的：' + (r.yours || '____');
          const real = document.createElement('span');
          real.className = 'geomlab-check-real';
          real.textContent = '实际值：' + (r.real == null ? '—' : fmt(r.real) + (r.unit || ''));
          line.appendChild(you);
          line.appendChild(real);
          out.appendChild(line);
        });
        if (!rows.length) out.textContent = '这类图没有可核对的计算结果。';
        out.hidden = false;
        btn.textContent = '重新核对';
      });
      box.appendChild(btn);
      box.appendChild(out);
      return box;
    }

    resetBtn.addEventListener('click', function () {
      lab.state = JSON.parse(JSON.stringify(startState));
      sliders.forEach(function (s) {
        s.input.value = String(lab.state[s.key]);
        if (s.show) s.show.textContent = fmt(lab.state[s.key]);
      });
      redraw();
    });

    /* ---------------- 拖拽 ---------------- */
    let dragging = null;
    function pointerPos(ev) {
      const rect = canvas.getBoundingClientRect();
      const src = ev.clientX != null ? ev : (ev.touches && ev.touches[0]) || { clientX: 0, clientY: 0 };
      return { px: src.clientX - rect.left, py: src.clientY - rect.top };
    }
    function hitTest(px, py) {
      let best = null;
      let bestD = 24;
      handles.forEach(function (h) {
        const d = Math.sqrt(Math.pow(X(h.x) - px, 2) + Math.pow(Y(h.y) - py, 2));
        if (d < bestD) { bestD = d; best = h; }
      });
      return best;
    }
    canvas.addEventListener('pointerdown', function (ev) {
      const pt = pointerPos(ev);
      dragging = hitTest(pt.px, pt.py);
      if (dragging) {
        if (canvas.setPointerCapture) { try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* 忽略 */ } }
        ev.preventDefault();
      }
    });
    canvas.addEventListener('pointermove', function (ev) {
      if (!dragging) return;
      const pt = pointerPos(ev);
      dragging.onDrag({ x: unX(pt.px), y: unY(pt.py) });
      redraw();
    });
    function endDrag() { dragging = null; }
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    canvas.addEventListener('pointerleave', endDrag);

    buildControls();
    ctrl.appendChild(buildCheck());
    lab._start = JSON.parse(JSON.stringify(startState));
    redraw();
    const ro = (typeof ResizeObserver !== 'undefined') ? new ResizeObserver(function () { redraw(); }) : null;
    if (ro) ro.observe(canvas);

    const inst = {
      el: wrap,
      /** 供浏览器验收/排查读取当前画板状态（纯数据） */
      state: function () {
        return {
          skel: lab.skel,
          title: lab.title,
          params: JSON.parse(JSON.stringify(lab.state)),
          values: solve(lab),
          handles: handles.length
        };
      },
      clear: function () {
        if (ro) ro.disconnect();
        if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
        if (ACTIVE === inst) ACTIVE = null;
      },
      /** 世界坐标 → 画布内像素（验收脚本用它把拖拽事件打在准确的手柄上） */
      worldToScreen: function (wx, wy) {
        return { x: X(wx), y: Y(wy) };
      },
      /** 第 idx 个拖拽手柄当前的画布内像素位置 */
      handleScreen: function (idx) {
        const h = handles[idx];
        return h ? { x: X(h.x), y: Y(h.y) } : null;
      },
      /** 当前溶液（验收读取不变量用，不参与渲染） */
      values: function () { return solve(lab); }
    };
    wrap._geomlab = inst;
    ACTIVE = inst;
    ACTIVE._ro = ro;
    return inst;
  }

  return {
    /* 对外契约（与 funclab 对齐） */
    labFor: labFor,
    mount: mount,
    destroy: destroy,
    solve: solve,
    fmt: fmt,
    /* 渲染层「已知量 / 派生量」判据（单测用：保证图上不会出现推导结论） */
    checkRows: checkRows,
    knownText: knownText,
    deriveText: deriveText,
    knownList: knownList,
    givenValues: givenValues,
    GIVEN_KEYS: GIVEN_KEYS,
    /* 单测/排查用 */
    gate: gate,
    answerEchoesGiven: answerEchoesGiven,
    givenQuantities: givenQuantities,
    classOf: classOf,
    classOfTopic: classOfTopic,
    clampArc: clampArc,
    plain: plain,
    math: MATH,
    COLORS: COLOR
  };
});
