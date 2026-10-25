/* 诊断引擎：纯函数、无 DOM、无依赖。浏览器中暴露为 window.DiagEngine，Node 中 require() 即可。
 *
 * 数据流：buildGraph(topics, deps, questions?) -> graph      （questions 缺失时用 topics 的 diagnostic_question）
 *         createSession(graph, targets, {limit, seed, avoid}) -> session   （会话是可 JSON 序列化的纯数据）
 *         nextQuestion(graph, session) -> topicId | null     （下一个要考的知识点）
 *         nextItem(graph, session) -> {topicId, question, attempt} | null   （要出的具体题目；attempt 为 1 或 2）
 *         applyAnswer(graph, session, id, 'correct'|'wrong'|'skip', {text}) -> 新 session（不修改入参）
 *         summarize(graph, session) -> 结果（根因、学习路径、掌握/不稳/薄弱/未测）
 *         gradeTargets(graph, '一年级'|'七上'|'高一'|'选必二', subject?) -> {ids, volumes, label} | null
 *           默认 subject 为 math，不把英语卷进数学的整册；'english' 只取英语（含九全），'all' 不限学科
 *         createSession(graph, ids, {mode:'screen'}) -> 筛查会话：范围 = 目标本身，回溯不出范围，默认题量上限 SCREEN_LIMIT
 *         chapterSummary(graph, session) -> 按章汇总（薄弱章节在前）
 *         layout(graph, session, summary) -> 路径图的分层布局
 *         judgeQuestion(question, userText) -> {verdict:'correct'|'wrong'|'manual', reason}
 *         judgeAnswer(user, reference) -> 同上（只按参考答案文本判，旧接口）
 *
 * 每个知识点最多 2 题：第一题对 -> 掌握（并推断祖先掌握）；第一题错 / 不会 -> 再出一道同级或更容易的题：
 *   第二题对 -> 不稳（shaky，不向先修回溯）；第二题也错 -> 薄弱（weak，向先修回溯，hard 先于 soft）。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.DiagEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ 图 */

  const DIFF_RANK = { basic: 0, standard: 1, advanced: 2 };

  function qNum(q) { const m = /_q(\d+)$/.exec(q.id); return m ? parseInt(m[1], 10) : 0; }

  function buildGraph(topics, deps, questions) {
    const byId = Object.create(null);
    const index = Object.create(null);
    topics.forEach(function (t, i) { byId[t.id] = t; index[t.id] = i; });
    const prereqs = Object.create(null);
    const dependents = Object.create(null);
    topics.forEach(function (t) { prereqs[t.id] = []; dependents[t.id] = []; });
    const seen = Object.create(null);
    deps.forEach(function (d) {
      if (!byId[d.topicId] || !byId[d.prerequisiteId]) return;
      const k = d.topicId + '<' + d.prerequisiteId;
      if (seen[k]) return;
      seen[k] = true;
      const strength = d.strength === 'soft' ? 'soft' : 'hard';
      prereqs[d.topicId].push({ id: d.prerequisiteId, strength: strength, reason: d.reason });
      dependents[d.prerequisiteId].push({ id: d.topicId, strength: strength });
    });
    // 先修按 hard 优先、再 soft，同级按 topics 文件顺序，保证出题次序确定
    const rank = function (e) { return (e.strength === 'hard' ? 0 : 1) * 1e6 + index[e.id]; };
    Object.keys(prereqs).forEach(function (id) {
      prereqs[id].sort(function (a, b) { return rank(a) - rank(b); });
      dependents[id].sort(function (a, b) { return index[a.id] - index[b.id]; });
    });
    // 题库：每个知识点的题目，按题号排序；没有题库（或某知识点没有题）时回退到 diagnostic_question
    const bank = Object.create(null);
    topics.forEach(function (t) { bank[t.id] = []; });
    let fromFile = 0;
    (Array.isArray(questions) ? questions : []).forEach(function (q) {
      if (q && bank[q.topicId] && !byId[q.topicId].external) { bank[q.topicId].push(q); fromFile++; }
    });
    topics.forEach(function (t) {
      const dq = t.diagnostic_question;
      if (!t.external && !bank[t.id].length && dq && dq.question) {
        bank[t.id].push({ id: t.id + '_q1', topicId: t.id, difficulty: 'standard', type: 'legacy', prompt: dq.question, answer: dq.answer, explanation: '' });
      }
    });
    Object.keys(bank).forEach(function (id) { bank[id].sort(function (a, b) { return qNum(a) - qNum(b); }); });
    return {
      topics: topics, byId: byId, index: index, prereqs: prereqs, dependents: dependents, bank: bank,
      hasBank: fromFile > 0, _anc: Object.create(null)
    };
  }

  /** 严格祖先集合（不含自身），带缓存。 */
  function ancestorSet(graph, id) {
    const memo = graph._anc;
    if (memo[id]) return memo[id];
    const visiting = graph._visiting || (graph._visiting = Object.create(null));
    if (visiting[id]) throw new Error('先修图存在环：' + id);
    visiting[id] = true;
    const out = new Set();
    graph.prereqs[id].forEach(function (p) {
      out.add(p.id);
      ancestorSet(graph, p.id).forEach(function (a) { out.add(a); });
    });
    visiting[id] = false;
    memo[id] = out;
    return out;
  }

  function ancestors(graph, ids) {
    const list = Array.isArray(ids) ? ids : [ids];
    const out = new Set();
    list.forEach(function (id) { ancestorSet(graph, id).forEach(function (a) { out.add(a); }); });
    return out;
  }

  /** 对节点子集做拓扑排序（先修在前）；同层按 topics 文件顺序，确定性。 */
  function topoSort(graph, ids) {
    const set = new Set(ids);
    const indeg = Object.create(null);
    set.forEach(function (id) {
      indeg[id] = graph.prereqs[id].filter(function (p) { return set.has(p.id); }).length;
    });
    const ready = [];
    set.forEach(function (id) { if (indeg[id] === 0) ready.push(id); });
    const byIndex = function (a, b) { return graph.index[a] - graph.index[b]; };
    const order = [];
    while (ready.length) {
      ready.sort(byIndex);
      const id = ready.shift();
      order.push(id);
      graph.dependents[id].forEach(function (d) {
        if (!set.has(d.id)) return;
        indeg[d.id] -= 1;
        if (indeg[d.id] === 0) ready.push(d.id);
      });
    }
    if (order.length !== set.size) throw new Error('拓扑排序失败：子图存在环');
    return order;
  }

  /** 目标集合的先修子图：目标 + 所有祖先（含小学外部节点），拓扑序。 */
  function subgraph(graph, targets) {
    const set = new Set(targets);
    ancestors(graph, targets).forEach(function (a) { set.add(a); });
    return { nodes: topoSort(graph, set), set: set };
  }

  function isTestable(graph, id) {
    const t = graph.byId[id];
    return !!(t && !t.external && graph.bank[id] && graph.bank[id].length);
  }

  function questionById(graph, qid) {
    const m = /^(.*)_q\d+$/.exec(qid || '');
    const list = m ? graph.bank[m[1]] : null;
    return (list || []).find(function (q) { return q.id === qid; }) || null;
  }

  /* ------------------------------------------------- 前置选择：年级截断 + 同章优先
   * 实测问题：route 定位「配方法」(初三) → 诊断一路往早的先修追，16 题里最后几题问到
   * 三年级「长方形和正方形的面积 / 面积的意义」，答满上限仍给不出结论。
   * 两条规则只改「测哪些点、先问哪个点」，判定逻辑（applyAnswer / statusOf / summarize）一概不动：
   *   ① 年级截断（过滤，硬规则）：只测离某个目标不超过 GRADE_GAP 个年级的先修。
   *      每个目标各算各的基准；共同先修只要对其中一个目标够近就保留。
   *      被截掉的记在 session.suppressed，界面显示「已略过」，不能静默消失。
   *   ② 优先级排序（只改顺序，不增删）：同章 > 同领域且年级相邻 > 同领域 > 其他。
   *      题量够就全测；撞上限时先测高优先级的，中断了结论也更可能是真原因。
   */

  /**
   * 只测不低于「目标年级 - GRADE_GAP」的先修。单个常量，改这一个数字就能调阈值。
   * 取 6 而不是 4（orchestrator 实测后定）：GAP=4 会把「初一的先修里带小学三年级」一刀切掉，
   * 而引擎的设计意图是「小学先修一路回溯到一年级」（既有测试「小学回溯」就是这条）。
   * GAP=6 下：初一(7) → 不低于一年级(1)，小学内部不受影响；初三(9) → 不低于三年级(3)，
   * 三年级「面积的意义」仍在范围内（原诉求是砍掉它，见下方 retainedOnly 的说明）；
   * 高三(12) → 不低于六年级(6)。
   */
  var GRADE_GAP = 6;

  /** 没有 grade / chapter 的图（手造图）不做截断，行为与改造前一致。 */
  function hasGrade(graph, id) {
    const t = graph.byId[id];
    return !!(t && typeof t.grade === 'number' && isFinite(t.grade));
  }

  /**
   * 目标集合里有年级可算才算得出截断线；一个都没有就不截断。
   * 手造图（无 grade）走这条路，既有行为的测试因此不受影响。
   */
  function gradeBenchmark(graph, targets) {
    return targets.some(function (id) { return hasGrade(graph, id); });
  }

  /**
   * 年级截断：candidates 里保留「对某个目标而言年级够近」的点，其余进 suppressed。
   * - 目标本身永远保留；没有年级的节点保留（无法判断就按原样）。
   * - 每个目标各算各的基准，避免浅目标把深目标的先修全砍掉。
   * @returns {{kept: string[], suppressed: string[]}}
   */
  function cutByGrade(graph, candidates, targets) {
    if (!gradeBenchmark(graph, targets)) return { kept: candidates.slice(), suppressed: [] };
    const tset = new Set(targets);
    const kept = [];
    const suppressed = [];
    candidates.forEach(function (id) {
      const t = graph.byId[id];
      if (!t) return;
      const keep = tset.has(id) || !hasGrade(graph, id) ||
        targets.some(function (tid) {
          return !hasGrade(graph, tid) || t.grade >= graph.byId[tid].grade - GRADE_GAP;
        });
      (keep ? kept : suppressed).push(id);
    });
    return { kept: kept, suppressed: suppressed };
  }

  /**
   * 候选先修的优先级分（1 最高，6 兜底）：
   *   1 同 chapter（完整章节名全等，不做前缀匹配——「25.1」和「25.2」是两章）
   *   2 同 domain 且年级相邻（差 1）/ 3 同 domain 且年级差 2 / 4 同 domain 其他
   *   5 同学科（数学内部跨领域）/ 6 其他
   * 没有 chapter/domain 的节点落 6，保持原顺序。
   */
  function prereqPriority(topic, target) {
    if (!topic || !target) return 6;
    if (topic.chapter && target.chapter && topic.chapter === target.chapter) return 1;
    const sameDomain = !!(topic.domain && target.domain && topic.domain === target.domain);
    if (!sameDomain) return topic.subject && target.subject && topic.subject === target.subject ? 5 : 6;
    if (!hasGrade({ byId: { a: topic } }, 'a') || !hasGrade({ byId: { b: target } }, 'b')) return 4;
    const diff = Math.abs(target.grade - topic.grade);
    if (diff <= 1) return 2;
    if (diff === 2) return 3;
    return 4;
  }

  /**
   * 按优先级稳定排序（同优先级保持入参顺序）。多目标时取「对任一目标最优」的分。
   * 这是顺序不是过滤：全测时只影响先后，撞上限时高优先级的先被问到。
   */
  function orderByPriority(graph, ids, targets) {
    const rankOf = function (id) {
      const t = graph.byId[id];
      let best = 6;
      targets.forEach(function (tid) {
        const r = prereqPriority(t, graph.byId[tid]);
        if (r < best) best = r;
      });
      return best;
    };
    return ids.map(function (id, i) { return { id: id, i: i, r: rankOf(id) }; })
      .sort(function (a, b) { return a.r - b.r || a.i - b.i; })
      .map(function (x) { return x.id; });
  }

  /* ------------------------------------------------------------------ 会话 */

  const RESULTS = { correct: 1, wrong: 1, skip: 1 };
  const DEFAULT_LIMIT = 16;
  const SCREEN_LIMIT = 40;

  function createSession(graph, targets, opts) {
    opts = opts || {};
    const ts = Array.from(new Set(targets));
    if (!ts.length) throw new Error('至少需要一个目标知识点');
    ts.forEach(function (id) { if (!graph.byId[id]) throw new Error('未知知识点：' + id); });
    const screen = opts.mode === 'screen';
    const limit = Math.max(1, Math.floor(opts.limit == null ? (screen ? SCREEN_LIMIT : DEFAULT_LIMIT) : opts.limit));
    // 筛查模式：诊断范围就是目标集合本身（不把先修祖先并进来），回溯只在范围内进行
    // 普通模式：先取目标 + 全部祖先的子图，再按年级截断（规则①）——
    // 截断只发生在会话的候选集里，图本身与数据不动。
    const cuts = screen
      ? { kept: topoSort(graph, ts), suppressed: [] }
      : cutByGrade(graph, subgraph(graph, ts).nodes, ts);
    const nodes = cuts.kept;
    const pos = Object.create(null);
    nodes.forEach(function (id, i) { pos[id] = i; });
    // 离目标最近（拓扑序最靠后）的目标先问；其余目标作为后备留在栈里
    const stack = ts.filter(function (id) { return isTestable(graph, id); })
      .sort(function (a, b) { return pos[b] - pos[a]; });
    return {
      targets: ts, limit: limit, order: nodes, status: {}, stack: stack, answers: [], attempts: {},
      mode: screen ? 'screen' : 'target', scope: screen ? ts.slice() : null,
      // 因年级跨度被略过的先修（不测、不在 order 里，但界面要显示「已略过」，不能静默丢弃）
      suppressed: cuts.suppressed,
      seed: opts.seed == null ? 'default' : String(opts.seed),
      avoid: Array.from(new Set(opts.avoid || []))
    };
  }

  function cloneSession(s) {
    const attempts = {};
    Object.keys(s.attempts).forEach(function (k) { attempts[k] = s.attempts[k].slice(); });
    return {
      targets: s.targets.slice(), limit: s.limit, order: s.order, stack: s.stack.slice(),
      status: Object.assign({}, s.status), answers: s.answers.slice(), attempts: attempts,
      suppressed: (s.suppressed || []).slice(),
      seed: s.seed, avoid: s.avoid, mode: s.mode, scope: s.scope ? s.scope.slice() : null
    };
  }

  /* ---- 可种子化的伪随机：同一 (seed, 知识点, 第几题) 永远得到同一个数，所以会话可以重放 ---- */
  function hashStr(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  }

  function mulberry32(a) {
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function rand01(seed, key) {
    const f = mulberry32(hashStr(String(seed) + '|' + key));
    f();
    return f();
  }

  const rankOf = function (q) { return DIFF_RANK[q.difficulty] == null ? 1 : DIFF_RANK[q.difficulty]; };

  /**
   * 给知识点 id 选第 attempt 题（1 或 2）。
   *  - 已在本次会话里出过的题不再出；
   *  - 第一题：优先没出过（session.avoid 之外）的题，并尽量避开 advanced；
   *  - 第二题：同级或更容易——优先 basic，其次与第一题同难度，再其次其它更容易的，最后才是更难的（取最容易的）；
   *    难度优先于“没出过”，同档里仍优先没出过的；
   *  - 档内用 seed 决定的伪随机数选一道。
   */
  function pickQuestion(graph, session, id, attempt) {
    const all = graph.bank[id] || [];
    const tried = (session.attempts[id] || []).map(function (a) { return a.qid; });
    const pool = all.filter(function (q) { return tried.indexOf(q.id) < 0; });
    if (!pool.length) return null;
    const avoid = new Set(session.avoid || []);
    const freshFirst = function (list) {
      const f = list.filter(function (q) { return !avoid.has(q.id); });
      return f.length ? f : list;
    };
    let cand;
    if (attempt <= 1) {
      cand = freshFirst(pool);
      const nonAdv = cand.filter(function (q) { return rankOf(q) < 2; });
      if (nonAdv.length) cand = nonAdv;
    } else {
      const first = all.find(function (q) { return q.id === tried[0]; });
      const r0 = first ? rankOf(first) : 1;
      const tiers = [
        pool.filter(function (q) { return rankOf(q) === 0; }),
        pool.filter(function (q) { return rankOf(q) === r0; }),
        pool.filter(function (q) { return rankOf(q) < r0; })
      ];
      const hit = tiers.find(function (t) { return t.length; });
      if (hit) cand = freshFirst(hit);
      else {
        const lo = Math.min.apply(null, pool.map(rankOf));
        cand = freshFirst(pool.filter(function (q) { return rankOf(q) === lo; }));
      }
    }
    const idx = Math.min(cand.length - 1, Math.floor(rand01(session.seed, id + '|' + attempt) * cand.length));
    return cand[idx];
  }

  /**
   * 记录一次作答（针对 nextItem 给出的那道题）。
   *  - 第一题 correct：该点及其所有尚未判定的祖先记为掌握（祖先为 inferred）；
   *  - 第一题 wrong/skip：还没有结论，该点仍排在最前面，下一题给它出第二题（没有第二题可出就直接判薄弱）；
   *  - 第二题 correct：不稳（shaky），不向先修回溯；
   *  - 第二题 wrong/skip：薄弱，并把其先修（hard 先、soft 后）压到出题栈顶。
   * 直接作答（direct）的判定不会被推断（inferred）覆盖。extra.text 是用户输入的答案（只用于记录）。
   */
  function applyAnswer(graph, session, id, result, extra) {
    if (!RESULTS[result]) throw new Error('作答结果必须是 correct / wrong / skip');
    if (!graph.byId[id]) throw new Error('未知知识点：' + id);
    const s = cloneSession(session);
    if (s.status[id]) { delete s.status[id]; s.attempts[id] = []; } // 对已有结论的点重新作答 = 重新开始
    const prev = s.attempts[id] || [];
    const q = pickQuestion(graph, s, id, prev.length + 1);
    const rec = { id: id, qid: q ? q.id : null, result: result };
    if (extra && extra.text != null && extra.text !== '') rec.text = String(extra.text);
    s.answers.push(rec);
    s.attempts[id] = prev.concat([{ qid: rec.qid, result: result }]);
    const nth = s.attempts[id].length;
    if (result === 'correct') {
      if (nth === 1) {
        s.status[id] = { s: 'mastered', src: 'direct' };
        ancestorSet(graph, id).forEach(function (a) {
          if (!s.status[a]) s.status[a] = { s: 'mastered', src: 'inferred' };
        });
      } else {
        s.status[id] = { s: 'shaky', src: 'direct' };
      }
    } else if (nth === 1 && pickQuestion(graph, s, id, 2)) {
      // 第一题没过：等第二题再下结论
    } else {
      s.status[id] = { s: 'weak', src: 'direct' };
      const scope = s.scope ? new Set(s.scope) : null;
      const suppressed = new Set(s.suppressed || []);
      // 回溯时按同章/同领域优先排序（规则②）；被年级截断的先修（suppressed）不再压栈，
      // 也不参与下面的「再往下追」判断——它本来就不在本次诊断范围内。
      const push = orderByPriority(graph, graph.prereqs[id]
        .map(function (p) { return p.id; })
        .filter(function (p) {
          return isTestable(graph, p) && !s.status[p] && !suppressed.has(p) && (!scope || scope.has(p));
        }), s.targets);
      const pushed = new Set(push);
      s.stack = push.concat(s.stack.filter(function (x) { return !pushed.has(x); }));
    }
    return s;
  }

  function nextQuestion(graph, session) {
    if (session.answers.length >= session.limit) return null;
    for (let i = 0; i < session.stack.length; i++) {
      const id = session.stack[i];
      if (!session.status[id] && isTestable(graph, id)) return id;
    }
    return null;
  }

  function nextItem(graph, session) {
    const id = nextQuestion(graph, session);
    if (!id) return null;
    const attempt = (session.attempts[id] || []).length + 1;
    const q = pickQuestion(graph, session, id, attempt);
    return q ? { topicId: id, question: q, attempt: attempt } : null;
  }

  /** 由作答记录重建会话（用于刷新恢复、撤销、更正）。 */
  function replay(graph, targets, answers, opts) {
    let s = createSession(graph, targets, opts);
    answers.forEach(function (a) { s = applyAnswer(graph, s, a.id, a.result, { text: a.text }); });
    return s;
  }

  /** 状态：mastered / shaky / weak / unknown。只答错一题就遇到题量上限的点按 weak 算（见 isUnconfirmed）。 */
  function statusOf(session, id) {
    const st = session.status[id];
    if (st) return st.s;
    return isUnconfirmed(session, id) ? 'weak' : 'unknown';
  }

  /** 第一题答错、但没来得及出第二题（题量用完）的点。 */
  function isUnconfirmed(session, id) {
    const a = session.attempts[id];
    return !session.status[id] && !!a && a.length === 1 && a[0].result !== 'correct';
  }

  /* ------------------------------------------------------------------ 结果 */

  function summarize(graph, session) {
    const nodes = session.order;
    const st = function (id) { return statusOf(session, id); };
    const mastered = nodes.filter(function (id) { return st(id) === 'mastered'; });
    const shaky = nodes.filter(function (id) { return st(id) === 'shaky'; });
    const weak = nodes.filter(function (id) { return st(id) === 'weak'; });
    const unconfirmed = weak.filter(function (id) { return isUnconfirmed(session, id); });
    const untested = nodes.filter(function (id) { return st(id) === 'unknown'; });
    const scope = session.scope ? new Set(session.scope) : null;
    // 被年级截断的先修（session.suppressed）与筛查模式的范围外先修同性质：不在本次诊断范围内。
    // 它们既不进 untested，也不算「还没测到」，否则根因会被误标为 pending。
    const suppressed = new Set(session.suppressed || []);
    const inScope = function (id) { return (!scope || scope.has(id)) && !suppressed.has(id); };

    const roots = weak.filter(function (id) {
      return !graph.prereqs[id].some(function (p) { return st(p.id) === 'weak'; });
    }).map(function (id) {
      const unk = graph.prereqs[id].filter(function (p) { return st(p.id) === 'unknown'; });
      const testableUnk = unk.filter(function (p) { return isTestable(graph, p.id); });
      return {
        id: id,
        // 先修里还没测到的（题量用完）——此时它未必是真正的根因
        pendingPrereqs: testableUnk.filter(function (p) { return inScope(p.id); }).map(function (p) { return p.id; }),
        // 筛查模式下范围之外的先修（不在本次范围内，没有检查）
        outOfScopePrereqs: testableUnk.filter(function (p) { return !inScope(p.id); }).map(function (p) { return p.id; }),
        // 小学外部节点（无诊断题，不测）
        externalPrereqs: unk.filter(function (p) { return !isTestable(graph, p.id); }).map(function (p) { return p.id; })
      };
    });

    // 学习路径：（根因 ∪ 不稳的点）的所有后代（子图内）∪ 它们自己，去掉已掌握，按拓扑序
    const inSub = new Set(nodes);
    const reach = new Set();
    const queue = roots.map(function (r) { return r.id; }).concat(shaky);
    queue.forEach(function (id) { reach.add(id); });
    while (queue.length) {
      const id = queue.shift();
      graph.dependents[id].forEach(function (d) {
        if (inSub.has(d.id) && !reach.has(d.id)) { reach.add(d.id); queue.push(d.id); }
      });
    }
    const rootSet = new Set(roots.map(function (r) { return r.id; }));
    const targetSet = new Set(scope ? [] : session.targets); // 筛查模式下“全部知识点都是目标”没有意义，不标目标
    const topoPos = Object.create(null);
    nodes.forEach(function (id, i) { topoPos[id] = i; });
    const path = nodes.filter(function (id) { return reach.has(id) && st(id) !== 'mastered'; })
      .map(function (id) {
        return { id: id, status: st(id), isRoot: rootSet.has(id), isTarget: targetSet.has(id) };
      });
    // 学习路径按年级从低到高；同一年级内保持拓扑序（先修在前）。没有 grade 的手造图保持原顺序。
    path.sort(function (a, b) {
      return gradeRank(graph, a.id) - gradeRank(graph, b.id) || topoPos[a.id] - topoPos[b.id];
    });

    const pending = session.stack.filter(function (id) { return !session.status[id] && isTestable(graph, id); });
    const next = nextQuestion(graph, session);
    return {
      mode: session.mode || 'target',
      targets: session.targets.slice(),
      asked: session.answers.length,
      limit: session.limit,
      finished: next === null,
      limitReached: session.answers.length >= session.limit && pending.length > 0,
      mastered: mastered, shaky: shaky, weak: weak, unconfirmed: unconfirmed, untested: untested,
      roots: roots, path: path
    };
  }

  /* ------------------------------------------------------------------ 学习小结 */

  /**
   * 把诊断结论压缩成几行可复制的纯文本（孩子视角，不进练习轮）。
   * sum: summarize() 的返回；nameOf(id) -> 知识点名。
   * 规则：根因取前 2 个；无根因时看「不稳」；只有答错没判出根因时提示再测；
   * 都没有时区分「已掌握」和「没测完」（前者要求 untested 为空，不能让答错过的点混进来）。
   * 措辞对孩子说话，不出现"家长/陪孩子"等监督感内容。
   */
  function studentAdvice(sum, nameOf) {
    const rootIds = sum.roots.slice(0, 2).map(function (r) { return r.id; });
    const roots = rootIds.map(nameOf);
    const lines = [];
    if (roots.length) {
      lines.push('卡点在：' + roots.join('、'));
      lines.push('先练【' + roots[0] + '】' + (roots.length > 1 ? '，再练【' + roots[1] + '】' : '') +
        '。练熟后回来再测一次，就能过关啦！');
    } else if (sum.shaky.length) {
      lines.push('有几个点还不太稳：' + sum.shaky.slice(0, 3).map(nameOf).join('、'));
      lines.push('点「练习」按钮把题练熟，再测一次。');
    } else if (sum.weak.length) {
      lines.push('有几题答错了，卡点还没找出来。');
      lines.push('多答几题找找卡点，或点「为什么错了」再讲一遍。');
    } else if (!sum.untested.length) {
      lines.push('都掌握啦，真棒！');
      lines.push('可以进入下一个知识点，继续加油～');
    } else {
      lines.push('还有没测完的点。');
      lines.push('继续作答，测完就能看到结果啦。');
    }
    return lines.join('\n');
  }

  /* ------------------------------------------------------------------ 路径图布局 */

  /**
   * 选出要画的节点：学习路径 ∪ 目标 ∪ 根因 ∪ 实际问过的点；
   * 边取这些节点上的“可达关系的传递约简”，非直接先修的边标 direct:false（画虚线）。
   * 分层：纵向，先修在上、目标在下。
   */
  function layout(graph, session, summary) {
    const S = new Set();
    const screen = !!session.scope;
    summary.path.forEach(function (p) { S.add(p.id); });
    if (!screen) session.targets.forEach(function (id) { S.add(id); });
    summary.roots.forEach(function (r) { S.add(r.id); });
    session.answers.forEach(function (a) { S.add(a.id); });
    if (S.size < 3 && !screen) {
      session.targets.forEach(function (id) {
        graph.prereqs[id].slice(0, 6).forEach(function (p) { S.add(p.id); });
      });
    }
    const ids = topoSort(graph, S);
    const edges = [];
    ids.forEach(function (b) {
      const anc = ancestorSet(graph, b);
      ids.forEach(function (a) {
        if (a === b || !anc.has(a)) return;
        const between = ids.some(function (c) {
          return c !== a && c !== b && anc.has(c) && ancestorSet(graph, c).has(a);
        });
        if (between) return;
        const direct = graph.prereqs[b].find(function (p) { return p.id === a; });
        edges.push({ from: a, to: b, direct: !!direct, strength: direct ? direct.strength : 'hard' });
      });
    });
    const layer = Object.create(null);
    ids.forEach(function (id) {
      let l = 0;
      edges.forEach(function (e) { if (e.to === id) l = Math.max(l, layer[e.from] + 1); });
      layer[id] = l;
    });
    const nLayers = ids.reduce(function (m, id) { return Math.max(m, layer[id] + 1); }, 1);
    const rows = [];
    for (let i = 0; i < nLayers; i++) rows.push([]);
    ids.forEach(function (id) { rows[layer[id]].push(id); });
    // 重心法减少交叉
    const slot = Object.create(null);
    rows.forEach(function (r) { r.forEach(function (id, i) { slot[id] = i; }); });
    const bary = function (id, nbrs) {
      if (!nbrs.length) return slot[id];
      return nbrs.reduce(function (s, n) { return s + slot[n]; }, 0) / nbrs.length;
    };
    for (let it = 0; it < 4; it++) {
      for (let l = 1; l < nLayers; l++) {
        rows[l].sort(function (a, b) {
          return bary(a, edges.filter(function (e) { return e.to === a; }).map(function (e) { return e.from; })) -
                 bary(b, edges.filter(function (e) { return e.to === b; }).map(function (e) { return e.from; }));
        });
        rows[l].forEach(function (id, i) { slot[id] = i; });
      }
      for (let l = nLayers - 2; l >= 0; l--) {
        rows[l].sort(function (a, b) {
          return bary(a, edges.filter(function (e) { return e.from === a; }).map(function (e) { return e.to; })) -
                 bary(b, edges.filter(function (e) { return e.from === b; }).map(function (e) { return e.to; }));
        });
        rows[l].forEach(function (id, i) { slot[id] = i; });
      }
    }
    const rootSet = new Set(summary.roots.map(function (r) { return r.id; }));
    const targetSet = new Set(screen ? [] : session.targets);
    const nodes = [];
    rows.forEach(function (r, l) {
      r.forEach(function (id, i) {
        nodes.push({
          id: id, layer: l, col: i, cols: r.length,
          status: statusOf(session, id), isTarget: targetSet.has(id), isRoot: rootSet.has(id)
        });
      });
    });
    return { nodes: nodes, edges: edges, layers: nLayers, maxCols: rows.reduce(function (m, r) { return Math.max(m, r.length); }, 1) };
  }

  /* ------------------------------------------------------------------ 章节解析 */

  /** 年级数字 ×2 + 学期，用于学习路径排序。没有 grade 时返回 0。 */
  function gradeRank(graph, id) {
    const t = graph.byId[id];
    if (!t || typeof t.grade !== 'number') return 0;
    return t.grade * 2 + (t.semester === '下' ? 1 : 0);
  }

  /**
   * 初中："七上 第一章 有理数 1.1" -> {volume:'七上', chapterNo:'第一章', chapterName:'有理数', section:'1.1'}
   * 小学："一年级上册 第1单元 单元名" 或 "一年级上册 综合与实践 活动名"
   */
  function parseChapter(chapter) {
    const s = chapter || '';
    const pm = /^([一二三四五六七八九])年级([上下全])册 (第\d+单元) (.+)$/.exec(s);
    if (pm) return { volume: pm[1] + pm[2], chapterNo: pm[3], chapterName: pm[4], section: '' };
    const pi = /^([一二三四五六])年级([上下])册 (综合与实践) (.+)$/.exec(s);
    if (pi) return { volume: pi[1] + pi[2], chapterNo: pi[3], chapterName: pi[4], section: '' };
    // 高中英语按册名解析，避免「第1单元 Teenage Life」被空格拆成章名和节。
    const enHs = /^(必修第([一二三])册|选择性必修第([一二三四])册) (欢迎单元|第\d+单元) (.+)$/.exec(s);
    if (enHs) {
      return {
        volume: enHs[2] ? ('必修' + enHs[2]) : ('选必' + enHs[3]),
        chapterNo: enHs[4],
        chapterName: enHs[5],
        section: ''
      };
    }
    // 高中数学不拆上下册。高一/高二是必修两册，选必一/二/三是选择性必修三册。
    const hs = /^(高[一二]|选必[一二三]) (数学建模|数学探究) (\S+)$/.exec(s);
    if (hs) return { volume: hs[1], chapterNo: hs[2], chapterName: hs[3], section: '' };
    const m = /^(\S+) (第\S+章) (\S+?)(?: (\S+))?$/.exec(s);
    if (!m) return { volume: '', chapterNo: '', chapterName: s, section: '' };
    return { volume: m[1], chapterNo: m[2], chapterName: m[3], section: m[4] || '' };
  }

  /** 学科：显式 subject 优先，否则 cne_ 前缀是英语，其余算数学。 */
  function subjectOf(topic) {
    if (!topic) return 'math';
    if (topic.subject === 'english' || topic.subject === 'math') return topic.subject;
    if (String(topic.id || '').indexOf('cne_') === 0) return 'english';
    return 'math';
  }

  /**
   * 整年级 / 整册的知识点：'一年级' = 一上 + 一下，'七上' = 七年级上册。
   * 高中不拆上下册：'高一' / '高一必修' = 必修第一册，'高二' / '高二必修' = 必修第二册。
   * '选必一' / '选择性必修第一册'、选必二、选必三 = 选择性必修三册。
   * 高中英语用「必修一」「必修二」「必修三」「选必四」，不占用数学的「高一」「高二」。
   * subject 默认 math，避免三上、四上和选必一把英语和数学混在一起。
   * 不带 subject 时「必修一」没有数学知识点，返回 null。
   * 返回 {ids, volumes, label}（ids 按 topics 文件顺序，只含正式知识点）；不认识的写法返回 null。
   */
  function gradeTargets(graph, scope, subject) {
    const subj = subject == null || subject === '' ? 'math' : subject;
    const key = String(scope == null ? '' : scope).trim();
    const books = {
      '高一': ['高一', '高一（必修第一册）'],
      '高一必修': ['高一', '高一（必修第一册）'],
      '高二': ['高二', '高二（必修第二册）'],
      '高二必修': ['高二', '高二（必修第二册）'],
      '选必一': ['选必一', '选必一（选择性必修第一册）'],
      '选择性必修第一册': ['选必一', '选必一（选择性必修第一册）'],
      '选必二': ['选必二', '选必二（选择性必修第二册）'],
      '选择性必修第二册': ['选必二', '选必二（选择性必修第二册）'],
      '选必三': ['选必三', '选必三（选择性必修第三册）'],
      '选择性必修第三册': ['选必三', '选必三（选择性必修第三册）'],
      '必修一': ['必修一', '必修一（必修第一册）'],
      '必修第一册': ['必修一', '必修一（必修第一册）'],
      '必修二': ['必修二', '必修二（必修第二册）'],
      '必修第二册': ['必修二', '必修二（必修第二册）'],
      '必修三': ['必修三', '必修三（必修第三册）'],
      '必修第三册': ['必修三', '必修三（必修第三册）'],
      '选必四': ['选必四', '选必四（选择性必修第四册）'],
      '选择性必修第四册': ['选必四', '选必四（选择性必修第四册）']
    };
    let volumes = null;
    let label = '';
    if (books[key]) {
      volumes = [books[key][0]];
      label = books[key][1];
    } else {
      const g = /^([一二三四五六七八九])年级$/.exec(key);
      const v = /^([一二三四五六七八九])([上下])$/.exec(key);
      const whole = /^([一二三四五六七八九])全$/.exec(key);
      if (g) {
        volumes = [g[1] + '上', g[1] + '下'];
        if (g[1] === '九') volumes.push('九全');
        label = g[1] + '年级';
      } else if (whole) {
        volumes = [whole[1] + '全'];
        label = whole[1] + '年级全一册';
      } else if (v) { volumes = [key]; label = v[1] + '年级' + (v[2] === '上' ? '上册' : '下册'); }
    }
    if (!volumes) return null;
    const ids = graph.topics.filter(function (t) {
      if (t.external) return false;
      if (subj !== 'all' && subjectOf(t) !== subj) return false;
      return volumes.indexOf(parseChapter(t.chapter).volume) >= 0;
    }).map(function (t) { return t.id; });
    return ids.length ? { ids: ids, volumes: volumes, label: label } : null;
  }

  /**
   * 按章汇总：范围内每章的 掌握 / 不稳 / 薄弱 / 未测 数量和薄弱、不稳的知识点 id。
   * 章按教材顺序给出，再按「薄弱数多、不稳数多」稳定排序，薄弱的章排前面。
   */
  function chapterSummary(graph, session) {
    const inOrder = new Set(session.order);
    const byKey = Object.create(null);
    const list = [];
    graph.topics.forEach(function (t) {
      if (t.external || !inOrder.has(t.id)) return;
      const c = parseChapter(t.chapter);
      const key = c.volume + ' ' + c.chapterNo + ' ' + c.chapterName;
      let ch = byKey[key];
      if (!ch) {
        ch = byKey[key] = {
          key: key, volume: c.volume, chapterNo: c.chapterNo, chapterName: c.chapterName,
          label: (c.volume ? c.volume + ' ' : '') + c.chapterNo + ' ' + c.chapterName,
          total: 0, mastered: 0, shaky: 0, weak: 0, untested: 0, weakIds: [], shakyIds: [], untestedIds: [], _i: list.length
        };
        list.push(ch);
      }
      const st = statusOf(session, t.id);
      ch.total++;
      if (st === 'mastered') ch.mastered++;
      else if (st === 'shaky') { ch.shaky++; ch.shakyIds.push(t.id); }
      else if (st === 'weak') { ch.weak++; ch.weakIds.push(t.id); }
      else { ch.untested++; ch.untestedIds.push(t.id); }
    });
    list.sort(function (a, b) { return b.weak - a.weak || b.shaky - a.shaky || a._i - b._i; });
    list.forEach(function (ch) { delete ch._i; });
    return list;
  }

  /**
   * 把 URL / 选择器里的 id 展开成图中的知识点。
   * aliases 形如 { "cnm_ext_002": { targets: ["cnm_p010", ...] } } 或 { id: ["cnm_p010"] }。
   * 未知 id 原样保留，交给 createSession 报错。
   */
  function resolveTargets(rawIds, aliases) {
    const map = aliases || {};
    const out = [];
    const seen = Object.create(null);
    (Array.isArray(rawIds) ? rawIds : [rawIds]).forEach(function (id) {
      if (!id) return;
      let targets = null;
      const spec = map[id];
      if (spec && Array.isArray(spec.targets)) targets = spec.targets;
      else if (Array.isArray(spec)) targets = spec;
      const list = targets && targets.length ? targets : [id];
      list.forEach(function (tid) {
        if (!seen[tid]) { seen[tid] = true; out.push(tid); }
      });
    });
    return out;
  }

  /* ------------------------------------------------------------------ 判题 */

  function normalizeText(input) {
    let s = String(input == null ? '' : input);
    s = s.replace(/²/g, '^2').replace(/³/g, '^3').replace(/[º˚∘゜]/g, '°');
    s = s.normalize('NFKC'); // 全角 -> 半角（数字、字母、，；：（）＝－ 等）
    s = s.replace(/[−‐-―﹣]/g, '-')
      .replace(/[、]/g, ',')
      .replace(/[。]/g, '.')
      .replace(/[“”‘’]/g, '"')
      .replace(/[×·⋅∙]/g, '*')
      .replace(/÷/g, '/')
      .replace(/[≦⩽]/g, '≤').replace(/[≧⩾]/g, '≥')
      .replace(/<=/g, '≤').replace(/>=/g, '≥')
      .replace(/[\[\]{}]/g, function (c) { return c === '[' || c === '{' ? '(' : ')'; });
    s = s.replace(/(\d)\s*度/g, '$1°');
    s = s.replace(/(\d)\s+(\d+\s*\/\s*\d+)/g, '$1又$2'); // 带分数 "1 1/2"
    s = s.replace(/\s+/g, '').toLowerCase();
    s = s.replace(/^(答案|答)[:=]/, '').replace(/或者/g, '或');
    s = s.replace(/[.!]+$/, '');
    if (/^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, ''); // 千分位
    return s;
  }

  function splitTop(s, seps) {
    const parts = [];
    let depth = 0;
    let cur = '';
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '(') depth++;
      else if (c === ')') depth = Math.max(0, depth - 1);
      if (depth === 0 && seps.indexOf(c) >= 0) { parts.push(cur); cur = ''; } else cur += c;
    }
    parts.push(cur);
    return parts.filter(function (p) { return p !== ''; });
  }

  function gcd(a, b) { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) { const t = a % b; a = b; b = t; } return a; }

  function ratio(n, d) {
    if (d === 0n) return null;
    if (d < 0n) { n = -n; d = -d; }
    const g = gcd(n, d) || 1n;
    return [n / g, d / g];
  }

  function decToRatio(str) {
    const i = str.indexOf('.');
    if (i < 0) return ratio(BigInt(str), 1n);
    const frac = str.slice(i + 1);
    const whole = str.slice(0, i) || '0';
    return ratio(BigInt(whole + frac), 10n ** BigInt(frac.length));
  }

  function isWrapped(t) {
    if (t[0] !== '(' || t[t.length - 1] !== ')') return false;
    let depth = 0;
    for (let i = 0; i < t.length; i++) {
      if (t[i] === '(') depth++;
      else if (t[i] === ')') { depth--; if (depth === 0 && i < t.length - 1) return false; }
    }
    return depth === 0;
  }

  const UNIT_ALIASES = {
    '米': 'm', 'm': 'm', '厘米': 'cm', 'cm': 'cm', '毫米': 'mm', 'mm': 'mm', '千米': 'km', '公里': 'km', 'km': 'km',
    '千克': 'kg', '公斤': 'kg', 'kg': 'kg', '克': 'g', 'g': 'g', '秒': 's', 's': 's', '分钟': 'min', 'min': 'min',
    '小时': 'h', 'h': 'h', '平方米': 'm^2', 'm^2': 'm^2', '平方厘米': 'cm^2', 'cm^2': 'cm^2',
    '立方米': 'm^3', 'm^3': 'm^3', '立方厘米': 'cm^3', 'cm^3': 'cm^3', '元': '元', '度': '°', '°': '°'
  };

  function canonUnit(u) {
    if (!u) return { name: '', known: true };
    if (UNIT_ALIASES[u]) return { name: UNIT_ALIASES[u], known: true };
    if (/^[一-龥]{1,4}$/.test(u)) return { name: u, known: false };
    return null; // 不像单位，说明这不是“数+单位”
  }

  /** 解析数值：整数、小数、分数 a/b、带分数、百分数、带符号/括号；末尾可带单位。失败返回 null。 */
  function parseNumeric(str) {
    let t = str;
    let neg = false;
    for (let guard = 0; guard < 4; guard++) {
      if (isWrapped(t)) { t = t.slice(1, -1); continue; }
      if ((t[0] === '-' || t[0] === '+') && isWrapped(t.slice(1))) { if (t[0] === '-') neg = !neg; t = t.slice(2, -1); continue; }
      break;
    }
    const m = /^([+-]?)(?:(\d+)又)?(\d+(?:\.\d+)?|\.\d+)(?:\/(\d+(?:\.\d+)?|\.\d+))?(%|°)?(.*)$/.exec(t);
    if (!m) return null;
    const whole = m[2], numS = m[3], denS = m[4], mark = m[5];
    let rest = m[6];
    if (whole && !denS) return null;
    let val;
    if (whole) {
      const n = decToRatio(numS), d = decToRatio(denS);
      if (!n || !d || d[0] === 0n) return null;
      const f = ratio(n[0] * d[1], n[1] * d[0]);
      const w = ratio(BigInt(whole), 1n);
      val = ratio(w[0] * f[1] + f[0], f[1]);
    } else if (denS) {
      const n = decToRatio(numS), d = decToRatio(denS);
      if (!n || !d || d[0] === 0n) return null;
      val = ratio(n[0] * d[1], n[1] * d[0]);
    } else {
      val = decToRatio(numS);
    }
    if (!val) return null;
    if (m[1] === '-') neg = !neg;
    let n = neg ? -val[0] : val[0];
    let d = val[1];
    let unit = { name: '', known: true };
    if (mark === '%') {
      const r = ratio(n, d * 100n);
      n = r[0]; d = r[1];
      if (rest) return null;
    } else if (mark === '°') {
      unit = { name: '°', known: true };
      if (!/^[一-龥]{0,2}$/.test(rest)) return null;
    } else if (rest) {
      unit = canonUnit(rest);
      if (!unit) return null;
    }
    return { key: n + '/' + d, unit: unit };
  }

  function analyzePart(p) {
    let variable = '';
    let body = p;
    const m = /^([a-z](?:\([a-z]\))?)=(.+)$/.exec(p);
    if (m) { variable = m[1]; body = m[2]; }
    const num = parseNumeric(body);
    if (num) return { raw: p, variable: variable, kind: 'num', key: num.key, unit: num.unit };
    const tm = /^\((.+)\)$/.exec(body);
    if (tm) {
      const items = splitTop(tm[1], ',');
      const nums = items.map(parseNumeric);
      if (items.length > 1 && nums.every(Boolean)) {
        return { raw: p, variable: variable, kind: 'tuple', key: 't:' + nums.map(function (x) { return x.key; }).join(','), unit: { name: '', known: true } };
      }
    }
    return { raw: p, variable: variable, kind: 'text', key: body, unit: { name: '', known: true } };
  }

  function parseAnswer(input) {
    const norm = normalizeText(input);
    const parts = splitTop(norm.replace(/[和或与及]/g, ','), ',;').map(analyzePart);
    return { norm: norm, parts: parts };
  }

  // 'eq' | 'ne' | 'unsure'
  function partCompare(a, b) {
    if (a.kind !== b.kind || a.key !== b.key) return 'ne';
    const ua = a.unit, ub = b.unit;
    if (!ua.name || !ub.name || ua.name === ub.name) return 'eq';
    return ua.known && ub.known ? 'ne' : 'unsure';
  }

  function sameMultiset(as, bs, ignoreVar) {
    if (as.length !== bs.length) return null;
    const left = bs.slice();
    let fuzzy = false;
    for (let i = 0; i < as.length; i++) {
      let hit = -1;
      for (let j = 0; j < left.length; j++) {
        if (!ignoreVar && as[i].variable !== left[j].variable) continue;
        const c = partCompare(as[i], left[j]);
        if (c === 'ne') continue;
        if (c === 'unsure') fuzzy = true;
        hit = j;
        break;
      }
      if (hit < 0) return null;
      left.splice(hit, 1);
    }
    return fuzzy ? 'unsure' : 'eq';
  }

  function allNumeric(parts) { return parts.every(function (p) { return p.kind === 'num' || p.kind === 'tuple'; }); }

  function compareParsed(u, r) {
    let res = null;
    if (u.parts.length === r.parts.length) {
      const refVars = r.parts.map(function (p) { return p.variable; });
      const refVarsDistinct = r.parts.length > 1 && refVars.every(Boolean) && new Set(refVars).size === refVars.length;
      if (refVarsDistinct) {
        if (u.parts.every(function (p) { return p.variable; })) res = sameMultiset(u.parts, r.parts, false);
        else if (u.parts.every(function (p) { return !p.variable; })) {
          // 未写变量名时按参考答案的出现顺序对应（x 在前 y 在后）
          res = 'eq';
          for (let i = 0; i < u.parts.length; i++) {
            const c = partCompare(u.parts[i], r.parts[i]);
            if (c === 'ne') { res = null; break; }
            if (c === 'unsure') res = 'unsure';
          }
        } else return { relation: 'unsure' };
      } else {
        res = sameMultiset(u.parts, r.parts, true);
      }
    }
    if (res === 'eq') return { relation: 'equal' };
    if (res === 'unsure') return { relation: 'unsure' };
    return { relation: allNumeric(u.parts) && allNumeric(r.parts) ? 'different' : 'unsure' };
  }

  /**
   * 判题：只在“可靠”时给 correct/wrong，其余返回 manual（让用户对照参考答案自评）。
   *  - 规范化后完全相同、或数值/多答案集合等价 -> correct
   *  - 双方都能解析为数值（含坐标）但不等价 -> wrong
   *  - 其余（代数式、文字、多种写法）-> manual
   */
  function judgeAnswer(user, reference) {
    const u = parseAnswer(user);
    const r = parseAnswer(reference);
    if (!u.norm) return { verdict: 'manual', reason: 'empty' };
    if (u.norm === r.norm) return { verdict: 'correct', reason: 'identical' };
    if (!r.parts.length) return { verdict: 'manual', reason: 'no-reference' };
    const c = compareParsed(u, r);
    if (c.relation === 'equal') return { verdict: 'correct', reason: 'equivalent' };
    if (c.relation === 'different') return { verdict: 'wrong', reason: 'numeric-mismatch' };
    return { verdict: 'manual', reason: 'unsure' };
  }

  /* ------------------------------------------------------------------ 按题型判题 */

  const MANUAL_EMPTY = { verdict: 'manual', reason: 'empty' };

  /** 算术表达式安全求值（O3 定稿 §3.3：白名单 + new Function，自用场景）。
   *  - normalizeText 先转全角/×÷/² 等，白名单再拦一切字母（未知数、函数名、原型链构造）
   *  - 求值结果必须是有穷 number；任何不安全/抛错/非数值 → null（保持 manual，不误判）
   *  - 供判题用：学生写 (100-(40-30)×5)×(40-30) 这类思路式子时能跟参考答案数值比较 */
  function evalExpr(input) {
    if (input == null) return null;
    let s = normalizeText(input);
    if (!/^[0-9+\-*/().^%, ]+$/.test(s)) return null;   // 无字母白名单
    s = s.replace(/\^/g, '**').replace(/,/g, '.');
    try {
      const v = Function('"use strict";return (' + s + ');')();
      return (typeof v === 'number' && isFinite(v)) ? v : null;
    } catch (e) { return null; }
  }

  function judgeChoice(user, q) {
    const raw = String(user == null ? '' : user).trim();
    if (!raw) return MANUAL_EMPTY;
    const choices = q.choices || [];
    const keys = choices.map(function (c) { return c.key; });
    let letter = null;
    const m = /^[(（]?([A-Za-z])[)）.．、:：]?$/.exec(raw);
    if (m) letter = m[1].toUpperCase();
    else {
      const n = normalizeText(raw);
      const hit = choices.find(function (c) { return normalizeText(c.text) === n; });
      if (hit) letter = hit.key;
    }
    if (!letter || keys.indexOf(letter) < 0) return { verdict: 'manual', reason: 'unrecognized' };
    return letter === q.answer ? { verdict: 'correct', reason: 'choice' } : { verdict: 'wrong', reason: 'choice' };
  }

  function judgeNumeric(user, q) {
    const u = parseAnswer(user);
    if (!u.norm) return MANUAL_EMPTY;
    const refs = [q.answer].concat(q.accept || []);
    for (let i = 0; i < refs.length; i++) {
      if (parseAnswer(refs[i]).norm === u.norm) return { verdict: 'correct', reason: 'identical' };
    }
    const main = parseAnswer(q.answer);
    if (!q.unordered && main.parts.length > 1) {
      // 多个答案且顺序有关：逐项按顺序比较（变量名忽略）
      if (u.parts.length !== main.parts.length) {
        return allNumeric(u.parts) ? { verdict: 'wrong', reason: 'count-mismatch' } : { verdict: 'manual', reason: 'unsure' };
      }
      let res = 'eq';
      for (let i = 0; i < u.parts.length; i++) {
        const c = partCompare(u.parts[i], main.parts[i]);
        if (c === 'ne') { res = 'ne'; break; }
        if (c === 'unsure') res = 'unsure';
      }
      if (res === 'eq') return { verdict: 'correct', reason: 'equivalent' };
      if (res === 'ne' && allNumeric(u.parts) && allNumeric(main.parts)) return { verdict: 'wrong', reason: 'numeric-mismatch' };
      return { verdict: 'manual', reason: 'unsure' };
    }
    const r = judgeAnswer(user, q.answer);
    if (r.verdict === 'correct') return r;
    for (let i = 1; i < refs.length; i++) {
      if (judgeAnswer(user, refs[i]).verdict === 'correct') return { verdict: 'correct', reason: 'accept' };
    }
    /* 学生写的是思路式子（如 (100-(40-30)×5)×(40-30)），标准解析判不了 → 安全求值比较。
     * 只在参考答案是单个数值时做；求值失败返回 manual（保持原行为，不误判）。 */
    if (r.verdict === 'manual' && main.parts.length === 1 && main.parts[0].kind === 'num') {
      const uv = evalExpr(user);
      if (uv !== null) {
        const rv = keyValue(main.parts[0].key);
        if (Math.abs(uv - rv) <= EQ_TOL) return { verdict: 'correct', reason: 'expr-eval' };
        return { verdict: 'wrong', reason: 'expr-mismatch' };
      }
    }
    return r;
  }

  function judgeShort(user, q) {
    const u = normalizeText(user);
    if (!u) return MANUAL_EMPTY;
    const refs = [q.answer].concat(q.accept || []);
    for (let i = 0; i < refs.length; i++) {
      if (normalizeText(refs[i]) === u) return { verdict: 'correct', reason: i ? 'accept' : 'identical' };
    }
    for (let i = 0; i < refs.length; i++) {
      if (judgeAnswer(user, refs[i]).verdict === 'correct') return { verdict: 'correct', reason: 'equivalent' };
    }
    return { verdict: 'manual', reason: 'unsure' }; // 文字 / 代数式写法太多，不可靠时让用户对照参考答案自评
  }

  /** 按题型判题：choice 比字母（或选项文字）；numeric 数值等价；short 规范化精确匹配 + accept；self 永远自评。 */
  function judgeQuestion(q, user) {
    switch (q.type) {
      case 'choice': return judgeChoice(user, q);
      case 'numeric': return judgeNumeric(user, q);
      case 'short': return judgeShort(user, q);
      case 'self': return { verdict: 'manual', reason: 'self' };
      default: return judgeAnswer(user, q.answer); // legacy：来自 diagnostic_question
    }
  }

  /* -------------------------------------------------- 讲解 reveal 数值校验（O2）
   * 讲解由 LLM 全文生成，偶发算错会直接教错。这里只做一件事：把 reveal 里
   * “明确声明的最终解值”抽出来，跟标准答案做数值等价比较。
   * 判不准（没有明确声明 / 答案不是数值）一律 ok:null —— 宁可放过，不可误杀正常讲解。
   */

  const EQ_TOL = 1e-3;   // 1/3 与 0.333 这类三位小数舍入视为同一值；绝对容差，避免 1000/1001 判等

  function keyValue(key) {
    const i = key.indexOf('/');
    return Number(key.slice(0, i)) / Number(key.slice(i + 1));
  }

  /** 两个已归一的数值键是否等值（精确相同，或在舍入容差内）。 */
  function keyEqual(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    const x = keyValue(a), y = keyValue(b);
    if (!isFinite(x) || !isFinite(y)) return false;
    return Math.abs(x - y) <= EQ_TOL;
  }

  /** 分数/小数/整数/带符号/带括号 -> 最简分数键 "n/d"；解析失败返回 null。 */
  function numericKey(text) {
    const n = parseNumeric(normalizeText(text));
    return n ? n.key : null;
  }

  /** 两个数值文本是否等价；任一侧不可解析返回 null（不做判断）。 */
  function numericEqual(a, b) {
    const ka = numericKey(a), kb = numericKey(b);
    if (!ka || !kb) return null;
    return keyEqual(ka, kb);
  }

  function negateKey(key) {
    const i = key.indexOf('/');
    const num = key.slice(0, i);
    return (num.charAt(0) === '-' ? num.slice(1) : '-' + num) + key.slice(i);
  }

  // 解值声明的结束符：遇到这些就认为这个值写完了
  const VALUE_STOP = /[，。；、,;:：\n\t或和与及()（）\[\]【】]/;
  // 只认"强结论位置"的赋值：中间步骤（17-5=12、2x=12、得x=6）里的赋值不算解值声明。
  // 弱标记（得/得到/得出/解得）故意不收：分不清是中途一步还是最终解，宁可放过不误杀。
  const CONCLUSION = /(?:所以|因此|故|即|最后|综上|答案|最终|结果)/;

  function claimValueKeys(raw) {
    if (!raw) return null;
    let t = raw;
    let both = false;
    if (t.charAt(0) === '±') { both = true; t = t.slice(1); }
    const n = parseNumeric(t);
    if (!n) return null;
    const keys = [n.key];
    if (both) keys.push(negateKey(n.key));
    return { keys: keys, unit: n.unit };
  }

  /**
   * 从自由文本里抽取“解值声明”：
   *   x=3 / 所以x=-1/2 / 所以 x=±3      -> 带变量的声明（要落在结论位置）
   *   答案：3 / 正确答案是 2 或 -2      -> 不带变量的声明
   * 方程形态（2x=6、4-x=1）不算声明——那里的 x 前面紧挨着系数或负号。
   */
  function solutionClaims(text) {
    const raw = String(text == null ? '' : text);
    if (!raw) return [];
    const claims = [];
    raw.split(/[。；;\n]/).forEach(function (rawSeg) {
      if (!rawSeg) return;
      const seg = normalizeText(rawSeg);
      const re = /([a-z])=/g;
      let m;
      while ((m = re.exec(seg)) !== null) {
        const before = m.index > 0 ? seg.charAt(m.index - 1) : '';
        if (/[0-9a-z*\/^+\-.=]/.test(before)) { re.lastIndex = m.index + 1; continue; }
        const concluding = CONCLUSION.test(seg.slice(0, m.index));
        let i = m.index + 2;
        let raw = '';
        while (i < seg.length && !VALUE_STOP.test(seg.charAt(i)) && raw.length < 24) { raw += seg.charAt(i); i++; }
        const cv = claimValueKeys(raw);
        if (cv && concluding) claims.push({ variable: m[1], raw: m[1] + '=' + raw, keys: cv.keys, unit: cv.unit });
        re.lastIndex = i;
      }
      // 在原文里找标记：normalizeText 会剥掉段首「答案:」，所以在原文上定位、只归一化值本身
      const am = /(?:参考答案|正确答案|答案)/.exec(rawSeg);
      if (am) {
        const rest = normalizeText(rawSeg.slice(am.index + am[0].length)).replace(/^[是为等于:：]+/, '');
        rest.split(/[或,]/).forEach(function (tok) {
          const cv = claimValueKeys(tok.trim());
          if (cv) claims.push({ variable: '', raw: tok.trim(), keys: cv.keys, unit: cv.unit });
        });
      }
    });
    return claims;
  }

  /** ±3 展开成 3或-3（x=±3 展开成 x=3或x=-3），好让两侧都当两个解处理。 */
  function expandPlusMinus(text) {
    return String(text == null ? '' : text)
      .replace(/([a-z])=±\s*([^，,;；或和与及]+)/g, '$1=$2或$1=-$2')
      .replace(/±\s*([^，,;；或和与及]+)/g, '$1或-$1');
  }

  // 等号左边是"算式"（含运算符）时的右边值：a+b=3、17-5=12 这类真正的计算结果。
  // 左边是 3x、x 这种单项式时不算——那多半是"待解的方程"，不是最终答案。
  // O2-3 修复：左式含变量字母（如 2(5-x)）时也不算——那是方程本身或代入验证段，
  //   不是纯算术计算；验证段（含 验证/检验/代入/代回 关键词）整段跳过。
  const LHS_OP = /[+\-*\/×÷·±]/;
  const LHS_VAR = /[a-z]/;
  const VERIFY_KW = /(?:验证|检验|代入|代回)/;
  const SEG_SEP = /[，。；、,;:：\n\t]/;

  function computedValues(text) {
    const raw = String(text == null ? '' : text);
    if (!raw) return [];
    const out = [];
    raw.split(/[。；;\n]/).forEach(function (rawSeg) {
      if (VERIFY_KW.test(rawSeg)) return;  // 代入验证段整段跳过
      const seg = normalizeText(rawSeg);
      const re = /=/g;
      let m;
      while ((m = re.exec(seg)) !== null) {
        // 左式只回看到上一个分隔符为止，别把上一句的算式算进来
        let k = m.index - 1;
        while (k >= 0 && !SEG_SEP.test(seg.charAt(k))) k--;
        const lhs = seg.slice(k + 1, m.index);
        let j = m.index + 1;
        let token = '';
        while (j < seg.length && !VALUE_STOP.test(seg.charAt(j)) && token.length < 24) { token += seg.charAt(j); j++; }
        // 左式有运算符（算式）且不含变量字母（不是方程）时才算计算结果
        const cv = (LHS_OP.test(lhs) && !LHS_VAR.test(lhs)) ? claimValueKeys(token) : null;
        if (cv) out.push({ variable: '', raw: token, keys: cv.keys, unit: cv.unit });
        re.lastIndex = j;
      }
    });
    return out;
  }

  function claimMatches(claim, key, target) {
    if (!keyEqual(key, target.key)) return false;
    return !(claim.unit.name && target.unit.name && claim.unit.name !== target.unit.name);
  }

  function claimHits(c, refParts, byVar) {
    const targets = (c.variable && byVar[c.variable]) ? byVar[c.variable] : refParts;
    return c.keys.some(function (k) {
      return targets.some(function (t) { return claimMatches(c, k, t); });
    });
  }

  /**
   * 参考答案切分：先按顶层分隔符切（保住坐标 (1,2) 里的逗号），再各自归一化解析。
   * 不走 parseAnswer：normalizeText 的千分位归一会把「40，130」这样的多解答案并成 40130。
   */
  function referenceParts(rawAnswer) {
    const parts = [];
    splitTop(expandPlusMinus(rawAnswer), ',;，；、').forEach(function (chunk) {
      String(chunk).split(/或者|或|和|与|及/).forEach(function (tok) {
        const n = normalizeText(tok).trim();
        if (n) parts.push(analyzePart(n));
      });
    });
    return parts;
  }

  /**
   * 校验讲解 reveal 的最终解值与标准答案是否一致。
   * 返回 {ok: true|false|null, reason, claim?, expected?}：
   *   true  —— 说明里给出的解值与答案等值
   *   false —— 给出的解值都对不上答案（调用方应整轮回退静态讲解）
   *   null  —— 无法判断（无答案 / 答案非数值 / reveal 没给明确解值），照用 llm
   * 单解答案用"任一命中即对"（同一步里常先写中途参数再写结果，不能因为参数对不上就枪毙）；
   * 多解答案按集合比，声明值必须全部落在答案集合里，不要求写全、不要求顺序。
   */
  function verifyReveal(revealText, referenceAnswer) {
    const parts = referenceParts(referenceAnswer);
    if (!parts.length) return { ok: null, reason: 'no-reference' };
    const refParts = parts.filter(function (p) { return p.kind === 'num' || p.kind === 'tuple'; });
    if (refParts.length !== parts.length) return { ok: null, reason: 'non-numeric' };
    const claims = solutionClaims(revealText);
    const byVar = Object.create(null);   // 同一变量可能有多个解（x=3 或 x=-3）
    refParts.forEach(function (p) {
      if (!p.variable) return;
      if (!byVar[p.variable]) byVar[p.variable] = [];
      byVar[p.variable].push(p);
    });
    const expected = refParts.map(function (p) { return p.variable ? p.variable + '=' + p.key : p.key; });

    if (refParts.length === 1) {
      const candidates = claims.concat(computedValues(revealText));
      if (!candidates.length) return { ok: null, reason: 'no-claim' };
      for (let i = 0; i < candidates.length; i++) {
        if (claimHits(candidates[i], refParts, byVar)) return { ok: true, reason: 'match', claims: candidates.length };
      }
      return { ok: false, reason: 'mismatch', claim: candidates[0].raw, expected: expected };
    }

    if (!claims.length) return { ok: null, reason: 'no-claim' };
    for (let i = 0; i < claims.length; i++) {
      if (!claimHits(claims[i], refParts, byVar)) {
        return { ok: false, reason: 'mismatch', claim: claims[i].raw, expected: expected };
      }
    }
    return { ok: true, reason: 'match', claims: claims.length };
  }

  /** 取解析的一个安全线索：第一句里到第一个逗号为止（不含后续步骤，避免 hint 泄露答案）。 */
  function firstClueOf(expl) {
    const str = String(expl || '').trim();
    if (!str) return '';
    const i = str.search(/[，。；;,]/);
    if (i < 0) return '';                       // 无标点：整句都可能是关键信息，宁可退回通用引导
    return str.slice(0, i + 1);
  }

  /**
   * 苏格拉底三步引导（T1 静态骨架版）。
   * 输入知识点 + 题目对象，输出三步 [{kind: 'prompt'|'hint'|'reveal', text}]：
   *   prompt —— 启发提问，不泄露答案/解析
   *   hint   —— 只给第一句线索，不揭晓最终答案
   *   reveal —— 完整参考答案 + 解析
   * T1 用题目现有字段模板化生成；T2 将改为 LLM 生成（接口不变，进入 diagnose/explain.js）。
   */
  function socraticSteps(topic, q) {
    const name = (topic && topic.name) || '这个知识点';
    const expl = (q && q.explanation) || '';
    const ans = (q && q.answer) || '';
    const firstClue = firstClueOf(expl);
    let answerText = ans;
    if (q && q.type === 'choice') {
      const chosen = (q.choices || []).filter((c) => c.key === ans)[0];
      answerText = ans + (chosen ? '. ' + chosen.text : '');
    }
    const steps = [];
    steps.push({
      kind: 'prompt',
      text: '这道题考的是「' + name + '」。先别急着看答案——你回想一下，解这类题的第一步应该先做什么？'
    });
    if (q && q.type === 'choice') {
      steps.push({
        kind: 'hint',
        text: '这是选择题。逐个选项对照判断依据：哪个选项符合这类题目的规则？' + (firstClue ? ' 提示：' + firstClue : '')
      });
    } else {
      steps.push({
        kind: 'hint',
        text: firstClue
          ? firstClue + ' 想想这一步做对了吗？'
          : '先回忆这个知识点「' + name + '」的核心步骤，再从头做一遍。'
      });
    }
    steps.push({
      kind: 'reveal',
      text: '参考答案：' + answerText + (expl ? '。\n解析：' + expl : '')
    });
    return steps;
  }

  /**
   * 练习抽题（T3）：给指定知识点抽 n 道"还没做过"的题。
   *  - doneIds：已做过的题（诊断/练习）集合，优先避开；题不足时允许复用简单的
   *  - 排序：basic → standard → advanced（基础薄弱孩子先练基础），同难度按原顺序
   * 返回 [{...question}]，最多 n 道；知识点无题返回 []。
   */
  function pickPracticeQuestions(graph, topicId, n, doneIds) {
    const all = (graph.bank[topicId] || []).slice();
    if (!all.length) return [];
    const done = doneIds || [];
    const rank = { basic: 0, standard: 1, advanced: 2 };
    const diff = function (q) { return rank[q.difficulty] != null ? rank[q.difficulty] : 1; };
    const fresh = all.filter(function (q) { return done.indexOf(q.id) < 0; });
    const pool = fresh.length ? fresh : all;   // 都练过了就复用，别让练习没题可出
    pool.sort(function (a, b) { return diff(a) - diff(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); });
    return pool.slice(0, Math.max(1, n));
  }

  return {
    DEFAULT_LIMIT: DEFAULT_LIMIT,
    SCREEN_LIMIT: SCREEN_LIMIT,
    /* 前置选择的两个新规则（kanban t_be33ff76）：截断阈值、截断、优先级排序 */
    GRADE_GAP: GRADE_GAP,
    cutByGrade: cutByGrade,
    prereqPriority: prereqPriority,
    orderByPriority: orderByPriority,
    gradeTargets: gradeTargets,
    subjectOf: subjectOf,
    chapterSummary: chapterSummary,
    buildGraph: buildGraph,
    questionById: questionById,
    pickQuestion: pickQuestion,
    pickPracticeQuestions: pickPracticeQuestions,
    nextItem: nextItem,
    isUnconfirmed: isUnconfirmed,
    mulberry32: mulberry32,
    judgeQuestion: judgeQuestion,
    evalExpr: evalExpr,
    socraticSteps: socraticSteps,
    ancestors: ancestors,
    topoSort: topoSort,
    subgraph: subgraph,
    isTestable: isTestable,
    createSession: createSession,
    applyAnswer: applyAnswer,
    nextQuestion: nextQuestion,
    replay: replay,
    statusOf: statusOf,
    summarize: summarize,
    studentAdvice: studentAdvice,
    layout: layout,
    parseChapter: parseChapter,
    gradeRank: gradeRank,
    resolveTargets: resolveTargets,
    normalizeText: normalizeText,
    numericKey: numericKey,
    numericEqual: numericEqual,
    solutionClaims: solutionClaims,
    verifyReveal: verifyReveal,
    judgeAnswer: judgeAnswer
  };
});
