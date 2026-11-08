/* O4 卡B：知识点 AI 讲解的页面侧全部逻辑（讲解 / 追问 / 渲染 / 缓存 / 状态）。
 *
 * 为什么单独一个文件：入口按钮与「点按钮 → 按序懒加载 5 个脚本」必须留在首屏（explore/app.js），
 * 否则 topic-ai.js 自己就是第 5 个被加载的脚本，没有东西能触发它。本文件负责其余全部逻辑，
 * 加载时不碰 DOM / 网络 / localStorage —— mount() 被调用后才开始干活。
 *
 * 依赖（全部在调用时从 root 取，加载时不缓存）：
 *   - root.CnmTopicExplain：buildInputs / explainMessages / parseExplain / checkExplain / chatMessages
 *     / checkReply / cacheKey / readCache / writeCache / pruneCache / SEG_KEYS / SEG_TITLES 等；
 *   - root.LLMConfig：isConfigured / model / maxTokens.explain / maxTokens.tutor；
 *   - root.DiagLLMGateway：postOnce（网只走它，本文件不拼 URL、不 fetch）。
 *
 * 红线：只用 document.createElement + textContent 建 DOM，不直接拼 HTML 串；不用 querySelector。
 */
(function (root) {
  'use strict';

  /* ================================================================
   * 0. 常量
   * ================================================================ */

  /* 对话记录键前缀（与讲解缓存同版本号，讲解换版即令旧对话失效）。 */
  var CHAT_PREFIX = 'cnmDiagnose.topicExplain.v1.chat.';

  /* 卡面 §4.4 规定的业务常量：单个 topic 的对话最多保留 12 轮；chat 键最多留 3 个 topic（按 at 做 LRU）。 */
  var CHAT_KEEP_ROUNDS = 12;
  var CHAT_KEEP_TOPICS = 3;

  /* 固定文案（卡面要求严格一致，不许写成「已审核 / 已验证」）。 */
  var BADGE = 'AI 生成 · 未经人工审核';
  var HINT = 'AI 生成，仅供参考';
  var LOADING = '正在准备讲解…';
  var GATE_TEXT = '这条没通过自动校验（格式没成形），换一次试试';
  var CHAT_FAIL = '这条没通过自动校验（格式没成形），再问一次试试';
  var ERROR_TEXT = '这次没取到讲解，点重试再来一次';
  var GW_TEXT = 'AI 老师那边暂时没接通，过一会儿再试一次';

  /* topicId → state。状态放模块里，切换知识点再切回来不重发请求。 */
  var STATE = new Map();

  /* ================================================================
   * 1. 基础工具（DOM 只用 createElement + textContent）
   * ================================================================ */

  function doc() { return root.document; }

  function el(tag, cls, text) {
    var node = doc().createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function textNode(text) { return String(text); }

  /* storage 由外部注入（浏览器 localStorage）；拿不到就返回 null，缓存静默降级。 */
  function storage() {
    try {
      var ls = root.localStorage;
      if (ls && typeof ls.getItem === 'function' && typeof ls.setItem === 'function') return ls;
    } catch (e) { /* 隐私模式 / 配额异常 */ }
    return null;
  }

  function T() { return root.CnmTopicExplain; }
  function CFG() { return root.LLMConfig; }
  function GW() { return root.DiagLLMGateway; }

  function trim(s) { return (s === null || s === undefined) ? '' : String(s).trim(); }

  /* 按行切开，去掉首尾空白与空行。 */
  function linesOf(text) {
    return String(text || '').split('\n').map(trim).filter(Boolean);
  }

  /* 去掉行首的手写序号（1. / 1、 / 1) / （1）），避免与 <ol> 叠成双序号。 */
  function stripOrder(line) {
    return String(line || '')
      .replace(/^\s*(?:\d+\s*[.、)．]|[（(]\s*\d+\s*[)）])\s*/, '')
      .trim();
  }

  /* ================================================================
   * 2. 状态
   * ================================================================ */

  function newState(ctx) {
    return {
      id: ctx.topic.id,
      box: null,
      ctx: ctx,
      status: 'idle',       /* idle | loading | ready | gate | gwerror | noconfig | error */
      inputs: null,
      explainKey: null,
      variant: 0,           /* 只用于「换个说法重讲」的缓存键后缀 */
      segs: null,
      history: [],          /* 只有成功轮 {q, a} */
      chatPending: false,
      pendingQuestion: null, /* 已发出、还没回包的提问（先渲染学生气泡） */
      chatError: null        /* 最近一条追问的失败提示（不写 history） */
    };
  }

  /* ================================================================
   * 3. 对话持久化（键 = cnmDiagnose.topicExplain.v1.chat.<topicId>）
   * ================================================================ */

  function chatKey(id) { return CHAT_PREFIX + id; }

  function loadChat(st) {
    var api = T();
    var ls = storage();
    if (!api || !ls) return;
    var raw = null;
    try { raw = ls.getItem(chatKey(st.id)); } catch (e) { return; }
    if (!raw) return;
    try {
      var v = JSON.parse(raw);
      if (!v || v.v !== api.CACHE_PREFIX || !Array.isArray(v.rounds)) return;  /* 讲解换版 → 旧对话丢弃 */
      st.history = v.rounds.filter(function (r) {
        return r && typeof r.q === 'string' && r.q.trim() && typeof r.a === 'string' && r.a.trim();
      }).map(function (r) { return { q: r.q, a: r.a }; });
    } catch (e) { /* 坏数据当没有 */ }
  }

  function pruneChat(ls, api) {
    var keys = [];
    var n = 0;
    try { n = Number(ls.length) || 0; } catch (e) { n = 0; }
    for (var i = 0; i < n; i++) {
      var k = null;
      try { k = ls.key(i); } catch (e) { k = null; }
      if (k && k.indexOf(CHAT_PREFIX) === 0) keys.push(k);
    }
    if (keys.length <= CHAT_KEEP_TOPICS) return;
    var rows = keys.map(function (key, order) {
      var v = null;
      try { v = JSON.parse(ls.getItem(key)); } catch (e) { v = null; }
      var at = (v && typeof v.at === 'number') ? v.at : -Infinity;
      return { key: key, at: at, order: order };
    });
    rows.sort(function (a, b) { return a.at !== b.at ? a.at - b.at : a.order - b.order; });
    var drop = rows.length - CHAT_KEEP_TOPICS;
    for (var j = 0; j < drop; j++) {
      try { ls.removeItem(rows[j].key); } catch (e) { /* 单条删失败不阻断淘汰 */ }
    }
  }

  function saveChat(st) {
    var api = T();
    var ls = storage();
    if (!api || !ls) return;
    var rounds = st.history.slice(-CHAT_KEEP_ROUNDS).map(function (r) { return { q: r.q, a: r.a }; });
    try {
      ls.setItem(chatKey(st.id), JSON.stringify({ v: api.CACHE_PREFIX, at: Date.now(), rounds: rounds }));
    } catch (e) { return; }
    pruneChat(ls, api);
  }

  function removeChat(st) {
    var ls = storage();
    if (!ls) return;
    try { ls.removeItem(chatKey(st.id)); } catch (e) { /* 忽略 */ }
  }

  /* ================================================================
   * 4. 挂载与生成
   * ================================================================ */

  function mount(box, ctx) {
    if (!box || !ctx || !ctx.topic) return;
    var st = STATE.get(ctx.topic.id);
    if (!st) { st = newState(ctx); STATE.set(ctx.topic.id, st); }
    st.box = box;
    st.ctx = ctx;
    if (!st.history.length) loadChat(st);
    render(st);
    if (ctx.autostart === true && st.status === 'idle') generate(st, false);
  }

  function apply(st, segs, key) {
    st.segs = segs;
    st.status = 'ready';
    st.explainKey = key;
    render(st);
  }

  function generate(st, force) {
    if (st.status === 'loading') return;
    var api = T();
    var cfg = CFG();
    if (!api) { st.status = 'error'; return render(st); }

    try {
      st.inputs = api.buildInputs({
        topic: st.ctx.topic,
        questions: st.ctx.questions,
        deps: st.ctx.deps,
        topics: st.ctx.topics
      });
    } catch (e) {
      st.status = 'error';
      return render(st);
    }

    if (!cfg || typeof cfg.isConfigured !== 'function' || !cfg.isConfigured()) {
      st.status = 'noconfig';   /* 零网络 */
      return render(st);
    }

    var model = cfg.model;
    var key = api.cacheKey(st.inputs, model);

    if (force) {
      /* 换个说法重讲：清空当前对话（state.history + storage 里的 chat 键）。 */
      st.history = [];
      st.pendingQuestion = null;
      st.chatError = null;
      removeChat(st);
    }

    if (!force) {
      var hit = api.readCache(storage(), key);
      if (hit && hit.segs && api.checkExplain(hit.segs).ok) {
        apply(st, hit.segs, key);   /* 零网络 */
        return;
      }
    }

    st.status = 'loading';
    st.explainKey = key;
    render(st);

    var gateway = GW();
    if (!gateway || typeof gateway.postOnce !== 'function') {
      st.status = 'error';
      return render(st);
    }

    var messages = api.explainMessages(st.inputs);
    var maxTokens = cfg.maxTokens.explain;

    /* 一次发送：重发复用同一份 messages 与同一个 max_tokens，不换请求通道、不改 URL。 */
    function send() {
      return gateway.postOnce({ model: model, messages: messages, max_tokens: maxTokens });
    }

    function fail() {
      st.status = 'error';
      render(st);
    }

    function finish(data) {
      if (!data) return fail();   /* 网关失败/超时 resolve null，不是格式问题 */
      var raw = data && data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content : '';
      var parsed = api.parseExplain(raw);
      if (!parsed || !parsed.segs || !api.checkExplain(parsed.segs).ok) {
        st.status = 'gate';   /* 不写缓存、不写 history */
        return render(st);
      }
      api.writeCache(storage(), force ? key + '@' + (++st.variant) : key, {
        segs: parsed.segs,
        at: Date.now(),
        model: model,
        topicId: st.id
      });
      api.pruneCache(storage(), api.MAX_ENTRIES);
      apply(st, parsed.segs, key);
    }

    /* 网关错误体（卡 E）：HTTP 200 里的业务错误包，不是模型输出 —— 不按「格式」处理，
     * 落独立的 gwerror 状态，不写缓存、不写 history。 */
    function gwError() {
      st.status = 'gwerror';
      render(st);
    }

    function isGwError(data) {
      return !!data && typeof api.gatewayErrorOf === 'function' && !!api.gatewayErrorOf(data);
    }

    function isTruncated(data) {
      return !!data && typeof api.needsRefetch === 'function' && !!api.needsRefetch(data);
    }

    /* 退避 800ms 后再发一次（保持 loading，别让错误闪烁一下）。 */
    function retryLater() {
      return new Promise(function (resolve) {
        if (typeof root.setTimeout !== 'function') { resolve(send()); return; }
        root.setTimeout(function () { resolve(send()); }, 800);
      });
    }

    /* 重发后的统一处理：第 2 次命中网关错误就停在 gwerror；否则按原 finish() 走
     * （第 2 次是截断也不再重发，交给 finish 判 gate）。 */
    function afterRetry(data2) {
      if (!data2) return fail();
      if (isGwError(data2)) return gwError();
      return finish(data2);
    }

    /* 判序（卡 E + 卡 D）：先网关错误、再截断，一次请求只可能有一条重发理由，
     * attempts 共享一个上限 2（不是 4）。缺依赖时按「没命中」退回卡 D 行为。 */
    send().then(function (data) {
      if (!data) return fail();
      if (isGwError(data)) return retryLater().then(afterRetry);
      if (isTruncated(data)) return send().then(afterRetry);
      return finish(data);
    }).catch(fail);
  }

  /* ================================================================
   * 5. 追问
   * ================================================================ */

  function sendQuestion(st, input) {
    var q = trim(input && input.value);
    if (!q || st.chatPending || st.status !== 'ready') return;
    var api = T();
    var cfg = CFG();
    var gateway = GW();
    if (!api || !cfg || !gateway || typeof gateway.postOnce !== 'function') return;
    if (st.history.length >= api.MAX_ROUNDS) return;   /* 第 11 轮直接拒 */

    st.chatPending = true;
    st.pendingQuestion = q;
    st.chatError = null;
    render(st);   /* 先渲染学生气泡 */

    var messages = api.chatMessages(st.inputs, st.segs, st.history, q);
    gateway.postOnce({
      model: cfg.model,
      messages: messages,
      max_tokens: cfg.maxTokens.tutor
    }).then(function (data) {
      st.chatPending = false;
      st.pendingQuestion = null;
      /* 网关错误体（卡 E）：先判它，命中就用同一句「没接通」文案，不写 history。 */
      if (data && typeof api.gatewayErrorOf === 'function' && api.gatewayErrorOf(data)) {
        st.chatError = GW_TEXT;
        return render(st);
      }
      var text = data && data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content : '';
      text = trim(text);
      if (!text || !api.checkReply(text).ok) {
        st.chatError = CHAT_FAIL;   /* 不写 history */
        return render(st);
      }
      st.history.push({ q: q, a: text });
      saveChat(st);
      render(st);
    }).catch(function () {
      st.chatPending = false;
      st.pendingQuestion = null;
      st.chatError = CHAT_FAIL;
      render(st);
    });
  }

  function clearChat(st) {
    st.history = [];
    st.pendingQuestion = null;
    st.chatError = null;
    st.chatPending = false;
    removeChat(st);
    render(st);
  }

  /* ================================================================
   * 6. 渲染（每段一个容器；所有节点用局部变量持有，不 querySelector）
   * ================================================================ */

  function render(st) {
    var box = st.box;
    if (!box) return;
    box.replaceChildren();
    if (st.status === 'idle') renderIdle(st, box);
    else if (st.status === 'loading') renderLoading(box);
    else if (st.status === 'noconfig') renderNoConfig(box);
    else if (st.status === 'ready') renderReady(st, box);
    else if (st.status === 'gate') renderGate(box, st);
    else if (st.status === 'gwerror') renderGwError(st, box);
    else renderError(box, st);
  }

  function renderIdle(st, box) {
    var btn = el('button', 'tai-btn', '让 AI 讲一遍');
    btn.setAttribute('type', 'button');
    btn.addEventListener('click', function () { generate(st, false); });
    box.append(btn, el('p', 'tai-hint', HINT));
  }

  function renderLoading(box) {
    var btn = el('button', 'tai-btn', '让 AI 讲一遍');
    btn.setAttribute('type', 'button');
    btn.disabled = true;
    box.append(btn, el('p', 'tai-line', LOADING));
  }

  function renderNoConfig(box) {
    var p = el('p', 'tai-noconfig');
    var a = el('a', 'tai-link', '设置');
    a.setAttribute('href', '../diagnose/settings.html');
    p.append(textNode('还没配置模型，先去 '), a, textNode(' 里填一个再回来。'));
    box.append(p);
  }

  function renderGate(box, st) {
    box.append(el('p', 'tai-gate', GATE_TEXT), retryButton(st, false));
  }

  /* 网关错误体：沿用 tai-error 样式，不新增 CSS；按钮文案「再试一次」。 */
  function renderGwError(st, box) {
    box.append(el('p', 'tai-error', GW_TEXT), retryButton(st, false, '再试一次'));
  }

  function renderError(box, st) {
    box.append(el('p', 'tai-error', ERROR_TEXT), retryButton(st, false));
  }

  function retryButton(st, force, label) {
    var btn = el('button', 'tai-retry', label || '重试');
    btn.setAttribute('type', 'button');
    btn.addEventListener('click', function () { generate(st, force); });
    return btn;
  }

  function renderReady(st, box) {
    var api = T();
    var keys = api.SEG_KEYS;
    keys.forEach(function (k) {
      box.append(renderSeg(k, api.SEG_TITLES[k], st.segs ? st.segs[k] : ''));
    });

    var foot = el('div', 'tai-foot');
    foot.append(el('span', 'tai-badge', BADGE));
    var again = el('button', 'tai-again', '换个说法重讲');
    again.setAttribute('type', 'button');
    again.addEventListener('click', function () { generate(st, true); });
    foot.append(again);
    box.append(foot);

    renderChat(st, box);
  }

  function renderSeg(key, title, text) {
    var section = el('section', 'tai-seg tai-seg-' + key);
    section.append(el('h3', 'tai-seg-title', title));
    if (key === 'how') {
      renderList(section, text, 'ol', 'tai-steps', true);
    } else if (key === 'demo') {
      renderDemo(section, text);
    } else {
      renderList(section, text, 'ul', 'tai-list', false);
    }
    return section;
  }

  function renderList(section, text, tag, cls, strip) {
    var rows = linesOf(text);
    if (!rows.length) return;
    var list = el(tag, cls);
    rows.forEach(function (row) {
      list.append(el('li', null, strip ? stripOrder(row) : row));
    });
    section.append(list);
  }

  function renderDemo(section, text) {
    var rows = linesOf(text);
    var qIndex = -1;
    for (var i = 0; i < rows.length; i++) {
      if (/[？?]/.test(rows[i])) { qIndex = i; break; }
    }
    if (qIndex >= 0) section.append(el('p', 'tai-q', rows[qIndex]));

    var steps = [];
    var answers = [];
    rows.forEach(function (row, index) {
      if (index === qIndex) return;
      if (row.indexOf('答案') === 0) answers.push(row);
      else steps.push(row);
    });

    if (steps.length) {
      var ol = el('ol', 'tai-steps');
      steps.forEach(function (row) { ol.append(el('li', null, row)); });
      section.append(ol);
    }

    if (answers.length) {
      var details = el('details', 'tai-ans');
      details.append(el('summary', null, '查看答案'), el('p', null, answers.join('\n')));
      section.append(details);
    }
  }

  function renderChat(st, box) {
    var api = T();
    var chat = el('div', 'tai-chat');
    var bubbles = el('div', 'tai-bubbles');

    st.history.forEach(function (round) {
      bubbles.append(studentBubble(round.q));
      bubbles.append(teacherBubble(round.a));
    });
    if (st.pendingQuestion) bubbles.append(studentBubble(st.pendingQuestion));
    if (st.chatError) bubbles.append(el('p', 'tai-line tai-chat-error', st.chatError));
    chat.append(bubbles);

    var full = st.history.length >= api.MAX_ROUNDS;
    var ask = el('div', 'tai-ask');
    var input = el('input', 'tai-input');
    input.setAttribute('type', 'text');
    input.setAttribute('placeholder', '还有什么想问的？');
    input.disabled = full;
    var send = el('button', 'tai-send', '发送');
    send.setAttribute('type', 'button');
    send.disabled = full;
    send.addEventListener('click', function () { sendQuestion(st, input); });
    ask.append(input, send);
    chat.append(ask);

    if (full) {
      var foot = el('div', 'tai-chat-foot');
      var clear = el('button', 'tai-clear', '清空对话');
      clear.setAttribute('type', 'button');
      clear.addEventListener('click', function () { clearChat(st); });
      foot.append(clear);
      chat.append(foot);
    }

    box.append(chat);
  }

  function studentBubble(text) {
    return el('div', 'tai-bubble tai-bubble-student', text);
  }

  function teacherBubble(text) {
    var bubble = el('div', 'tai-bubble tai-bubble-teacher');
    bubble.append(el('p', 'tai-bubble-text', text), el('p', 'tai-badge', BADGE));
    return bubble;
  }

  /* ================================================================
   * 7. 导出
   * ================================================================ */

  root.CnmTopicAI = { mount: mount };

})(typeof self !== 'undefined' ? self : this);
