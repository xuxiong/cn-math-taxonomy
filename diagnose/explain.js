/* LLM 苏格拉底讲解（T2）。挂在 window.Explain 上。
 * 口径（卡 t_6bfdf8c2）：没配置 LLM 时由 app-flow.js 直接走上游式「参考答案 + 解析原文」，
 * 本模块根本不参与；配置了 LLM 才向模型请求个性化三步，等待期由面板显示中性占位，
 * 失败也不回模板——直接把解析原文交给学生，另给一句失败原因和「再问一次」。
 *
 * window.Explain.generate(topic, q, userAnswer) -> Promise<{steps, from}>
 *   - 成功：{steps: [{kind,text}], from: 'llm'}
 *   - 失败：{steps: null, from: 'none', reason, notice}（永不 reject）
 *   - 只缓存成功结果（同题 5 分钟），失败不进缓存，避免「重试」命中空壳
 */
(function (global) {
  'use strict';

  /* 配置唯一真源：diagnose/llm-config.js（浏览器由 index.html 先加载，Node 直接 require） */
  function _loadLLMConfig() {
    if (typeof LLMConfig !== 'undefined' && LLMConfig) return LLMConfig;
    if (typeof require === 'function') {
      try { return require('./llm-config.js'); } catch (e) { /* 落到 fail-closed */ }
    }
    return null;
  }

  const CFG = _loadLLMConfig();
  const PROXY = CFG ? CFG.chatUrl() : null;
  const MODEL = CFG ? CFG.model : null;
  const TTL = 5 * 60 * 1000;

  /* 预算唯一真源见 llm-config.js；这里保留同名别名，请求体只引用常量、不写裸数字。
   * 实测依据（探索/追问的 token 长尾）也已搬到 llm-config.js 对应字段旁。 */
  const EXPLAIN_MAX_TOKENS = CFG ? CFG.maxTokens.explain : null;   // 三步讲解（prompt/hint/reveal 的 JSON）
  const FOLLOWUP_MAX_TOKENS = CFG ? CFG.maxTokens.followup : null;
  const TUTOR_MAX_TOKENS = CFG ? CFG.maxTokens.tutor : null;       // 追问 chip（固定 schema 的短 JSON，卡 D）

  /* ---------------- 超时（网络挂起不再永远等） ----------------
   * 讲解与追问都是 chat 类长请求，超时唯一真源是 llm-config.js 的 timeouts.chat；
   * 本文件不写任何超时数字（与 llm-gateway.js 的 TIMEOUT_MS 同一条纪律）。
   * 每次请求时读取，测试可把该键调小来验证，不必真等 30 秒。 */
  function chatTimeoutMs() {
    const t = CFG && CFG.timeouts && CFG.timeouts.chat;
    return (typeof t === 'number' && t > 0) ? t : null;
  }

  /* 卡 D：追问 chip 的超时单独成键（timeouts.tutor），读法与 chatTimeoutMs 相同。
   * 为什么不共用 chat：测试要能单独把 chip 的超时调小来验证超时路径，
   * 动 chat 会连累讲解 / 追问两条既有链路的口径。 */
  function tutorTimeoutMs() {
    const t = CFG && CFG.timeouts && CFG.timeouts.tutor;
    return (typeof t === 'number' && t > 0) ? t : null;
  }

  /* 失败原因标记：timeout / network / http / llm。
   * 学生可见文案只有 noticeFor() 一个来源（讲解与追问共用，按 reason 分档），
   * 因此同一类故障在两条链路上说法一致，也不会有一处改了文案另一处忘改。 */

  /* 按 reason 选文案：学生可见文案**只**从这里取，
   * 不拼 err.message / 栈 / URL / base —— 4 种故障各说各话，让孩子知道下一步能做什么。
   * 未知 reason 逐字保留旧通用文案（不破坏既有体验，也是 fail-closed 的兜底）。
   * timeout 的秒数从 LLMConfig.timeouts.chat 现算（chatTimeoutMs() 为 null 时不写秒数，不写死超时值）。 */
  function noticeFor(reason, status, degraded, detail) {
    if (reason === 'timeout') {
      const ms = chatTimeoutMs();
      const sec = ms ? Math.max(1, Math.round(ms / 1000)) : 0;
      return sec > 0
        ? 'AI 老师这次没赶上（等了 ' + sec + ' 秒），请点「再问一次」重试。'
        : 'AI 老师这次没赶上，请点「再问一次」重试。';
    }
    if (reason === 'network') {
      return '网络没通 / 没收到你的问题，请点「再问一次」重试。';
    }
    if (reason === 'http') {
      /* 401 / 429 重试无意义：key 失效或额度用尽，只能家长去设置页处理。
       * 文案里的错误码同样走 /^\d{3}$/ 校验（这里 status 由数字常量拼出，仍保留纪律）。 */
      if (String(status) === '401') {
        return 'AI 老师没拿到通行证（401），重试也没用 —— 请让家长点右上角「设置」重新填一次密钥。';
      }
      if (String(status) === '429') {
        return 'AI 老师的额度用完了（429），重试也没用 —— 请让家长点右上角「设置」看看用量或换一次密钥。';
      }
      if (String(status) === '403') {
        return 'AI 老师的这个模型用不了了（403），重试也没用 —— 请让家长点右上角「设置」看看免费额度、余额，或这个模型有没有开通。';
      }
      /* 错误码只允许三位数字（/^\d{3}$/），不合法就不写错误码 —— 不把任何字符串拼进去 */
      const code = /^\d{3}$/.test(String(status)) ? '（错误码 ' + status + '）' : '';
      return 'AI 服务这边出了点问题' + code + '，请点「再问一次」重试。';
    }
    if (reason === 'llm') {
      /* detail 来自 llmSteps / llmAsk 的具体失败形态；未传 / 'empty' 走原句。 */
      if (detail === 'truncated') return 'AI 老师话没说完就被打断了，点「再问一次」通常就好。';
      if (detail === 'badjson') return 'AI 老师的回答没按格式来，点「再问一次」再来一次。';
      if (detail === 'mismatch') return 'AI 老师的解析和标准答案对不上，先看下面的解析；想再试可以点「再问一次」。';
      return '答了但内容空了，请点「再问一次」重试。';
    }
    return 'AI 老师暂时离线，没回答上。稍后再问一次试试。';
  }

  function _isAbort(err) {
    const name = err && err.name;
    return name === 'AbortError' || name === 'TimeoutError' || (err && err.code === 'ABORT_ERR');
  }

  function _markFail(err, reason) {
    const e = (err instanceof Error) ? err : new Error(String(err));
    if (!e.reason) e.reason = reason;
    return e;
  }

  /** 发一次 chat 请求并解析 JSON。超时覆盖「连接 + 响应体」：
   *  超时即 abort（AbortError），错误统一打上 reason 标记后抛给调用方。
   *  AbortController 不可用（很老的浏览器）时退化为无超时，行为与改动前一致。
   *
   *  4xx 降级重试（spec 第 5 条）：reason==='http' 且 400≤status<500 且 status≠401 且
   *  本次请求体带过 response_format → 去掉该字段重发一次（宽松模式），最多重试一次。
   *  讲解请求不带 response_format，自然不会触发降级；5xx / 401 也不降级。
   *  第二次仍失败 → err.degraded=true，对外 reason 按第二次的实际失败类型。 */
  function postChat(body, timeoutMs) {
    if (typeof fetch !== 'function') return Promise.reject(_markFail(new Error('fetch 不可用'), 'network'));
    return _postChatOnce(body, timeoutMs).catch(function (err) {
      if (err && err.reason === 'http' && typeof err.httpStatus === 'number'
          && err.httpStatus >= 400 && err.httpStatus < 500 && err.httpStatus !== 401 && err.httpStatus !== 429 && err.httpStatus !== 403
          && body && body.response_format) {
        const relaxed = Object.assign({}, body);
        delete relaxed.response_format;
        return _postChatOnce(relaxed, timeoutMs).catch(function (err2) {
          if (err2) err2.degraded = true;
          throw err2;
        });
      }
      throw err;
    });
  }

  /* 单次发请求 + 解析。!resp.ok 时读一次 body（截断 ≤200 字符）装到 error 上，
   * 便于日志 / 文案区分原因；读不到也不改语义（仍抛 reason='http'）。
   * 卡 D：超时可由调用方注入（chip 走 timeouts.tutor）；不传 / 传非法值时沿用
   * timeouts.chat —— 既有讲解 / 追问 / 降级重试的单参调用行为一字不变。 */
  function _postChatOnce(body, timeoutMs) {
    const ms = (typeof timeoutMs === 'number' && timeoutMs > 0) ? timeoutMs : chatTimeoutMs();
    const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    const opts = {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, CFG ? CFG.authHeaders() : {}),
      body: JSON.stringify(body)
    };
    if (!controller || !ms) return fetch(PROXY, opts);

    opts.signal = controller.signal;
    let timer = setTimeout(function () { timer = null; try { controller.abort(); } catch (e) { /* 已 abort */ } }, ms);
    const done = function () { if (timer) { clearTimeout(timer); timer = null; } };
    return fetch(PROXY, opts).then(function (resp) {
      if (!resp.ok) {
        done();
        const err = _markFail(new Error('llm http ' + resp.status), 'http');
        err.httpStatus = resp.status;
        /* 保留错误详情：读一次 body（截断 ≤200 字符）。读失败 / resp.text 不存在 → 不设 httpBody，仍抛 reason='http'。
         * body 读取本身可能抛错 / 老 mock 只有 {ok:false,status} → try/catch + Promise 链兜住，失败语义不变。 */
        const readBody = (typeof resp.text === 'function')
          ? Promise.resolve().then(function () { return resp.text(); }).catch(function () { return ''; })
          : Promise.resolve('');
        return readBody.then(function (txt) {
          if (typeof txt === 'string' && txt.length) err.httpBody = txt.slice(0, 200);
          throw err;
        });
      }
      return Promise.resolve(resp.json()).then(function (data) { done(); return data; }, function (err) {
        done();
        throw _markFail(err, _isAbort(err) ? 'timeout' : 'network');
      });
    }, function (err) {
      done();
      throw _markFail(err, _isAbort(err) ? 'timeout' : 'network');
    });
  }

  /** 把失败错误收成 {reason, httpStatus, degraded}：调用方再交给 noticeFor 生成学生文案。
   *  httpStatus（数字）与 degraded（布尔）由 postChat 的 4xx 降级重试 / body 读取带出来。 */
  function failInfo(err) {
    const reason = (err && err.reason) || 'network';
    return {
      reason: reason,
      httpStatus: (err && typeof err.httpStatus === 'number') ? err.httpStatus : null,
      degraded: !!(err && err.degraded),
      /* 细节分档（llm 档文案用）：truncated / badjson / mismatch / empty；无则 null */
      detail: (err && typeof err.detail === 'string') ? err.detail : null
    };
  }

  const cache = new Map();   // qid|有无画板 -> {ts, steps}（只存成功结果）

  function systemPrompt() {
    return '你是人教版初中数学的一对一辅导老师，学生基础薄弱，需要你耐心引导。'
      + '学生答错了一道题。请用苏格拉底式三步引导帮助他，按 JSON 输出，不要任何多余文字，格式严格为：'
      + '{"prompt":"第一步：只提问引导，让学生自己发现错误，绝不能给出答案或关键数值","hint":"第二步：给出方向性线索，提示关键步骤，但不能直接写出最终答案","reveal":"第三步：完整解析，先给正确解答，再分步解释为什么"}'
      + '要求：语言简短口语化、贴合初中生；prompt 和 hint 绝不写正确答案，hint 最多给一半思路；reveal 详细但不啰嗦。'
      + 'reveal 的最后一行请写「答案：x = …」（多解时写「答案：x1 = …，x2 = …」），方便核对。'
      + '重要：输出必须是纯文本，禁止任何 Markdown 标记（不要用 **、*、`、#、> 等符号）；'
      + '公式用普通文字写，如 "a(x-h)²+k" 直接写，不要加粗、不要用代码块；'
      + '不要写任何反斜杠命令（如 \\sqrt、\\frac、\\times、\\pm 都不要用）；'
      + '根号直接用 √ 符号（如 2±√5），分数用斜杠（如 1/2），允许用 ² 表示平方。'
      + '画板上刻意留白的量（描述里标为「留白」或「?」）不许你在讲解里直接说出数值。可以引导学生去看图、自己去读，但不许代他读出。';
  }

  function userPrompt(topic, q, userAnswer, labDesc) {
    const typeLabel = ({ choice: '选择题', numeric: '填数字', short: '简答' })[q.type] || '题';
    const topicName = (topic && topic.name) || '';
    return '题目（' + typeLabel + '）：' + q.prompt
      + '\n知识点：' + topicName
      + (labDesc ? '\n画板：' + labDesc : '')
      + '\n学生答案：' + (userAnswer === '' ? '（没填）' : userAnswer)
      + (q.answer ? '\n本题目标准答案：' + q.answer + '（你的 reveal 最终解值必须与此一致）' : '')
      + (q.explanation ? '\n可参考的标准解析（reveal 里可以展开它，但不要照抄）：' + q.explanation : '');
  }

  /** LaTeX 残留转纯文本：\sqrt{5} -> √5、\frac{1}{2} -> 1/2、\pm -> ±。
   * 防模型不听话（prompt 已禁 LaTeX，这里是展示层兜底）。
   * @param {string} text
   * @returns {string}
   */
  function cleanLatex(text) {
    let s = String(text || '');
    // 先处理分式（嵌套在最外层，先转 \frac{a}{b} -> a/b）
    let prev = '';
    while (prev !== s) {
      prev = s;
      s = s.replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '($1)/($2)');
    }
    // 再处理根式 \sqrt[n]{x} / \sqrt{x} -> √x
    s = s.replace(/\\sqrt\s*\[([^\]]*)\]\s*\{([^{}]*)\}/g, '√[$1]($2)')
         .replace(/\\sqrt\s*\{([^{}]*)\}/g, '√$1');
    // 其余常见命令：\pm ±、\times ×、\cdot ·、\div ÷、\le ≤、\ge ≥、\neq ≠、\approx ≈、\infty ∞、\pi π
    // 注意不能只用 \b（\pm5 中 pm 后是数字 5，仍是单词字符，\b 不成立）；用 (?![a-zA-Z]) 兜住
    s = s.replace(/\\(pm|times|cdot|div|le|ge|neq|approx|infty|pi)(?![a-zA-Z])/g, function (m, name) {
      return { pm: '±', times: '×', cdot: '·', div: '÷', le: '≤', ge: '≥', neq: '≠', approx: '≈', infty: '∞', pi: 'π' }[name];
    });
    // 其余未知反斜杠命令直接剥掉反斜杠（\alpha -> alpha，\x -> x）
    s = s.replace(/\\([a-zA-Z]+)/g, '$1');
    // 去掉裸花括号（\sqrt 等的残留 { }）
    s = s.replace(/[{}]/g, '');
    return s;
  }

  /**
   * 清理 LLM 输出里的 Markdown 残留（模型即使被要求纯文本也可能输出 **、`、# 等）。
   * 孩子看不懂这些标记，展示层必须兜底剥掉：
   *   **xxx** / *xxx* -> xxx（去掉星号）；`xxx` -> xxx；行首 #、> 剥掉。
   * @param {string} text
   * @returns {string}
   */
  function cleanMarkdown(text) {
    return cleanLatex(String(text || ''))
      .replace(/\*\*([^*]*)\*\*/g, '$1')   // **加粗** -> 加粗
      .replace(/\*([^*]*)\*/g, '$1')        // *斜体* -> 斜体
      .replace(/`([^`]*)`/g, '$1')          // `代码` -> 代码
      .replace(/^[#>]+\s*/gm, '')           // 行首 # / >
      .replace(/^[-*+]\s+/gm, '')           // 行首列表符
      .trim();
  }

  function parseSteps(content) {
    let m = String(content || '').match(/\{[\s\S]*\}/);
    if (!m) return null;
    const j = JSON.parse(m[0]);
    const kinds = ['prompt', 'hint', 'reveal'];
    const steps = [];
    for (const k of kinds) {
      const text = cleanMarkdown(j[k] || '');
      if (!text) return null;
      steps.push({ kind: k, text: text });
    }
    return steps;
  }

  /* ---------------- T3.5 追问（讲解中提问，AI 老师单轮答疑） ---------------- */
  const STEP_LABEL = { prompt: '第 1 步 引导', hint: '第 2 步 提示', reveal: '第 3 步 解析' };

  /* 把画板说明压成一行并截到 60 字：清单是给模型看的索引，太长会挤掉真正的答题规则。
   * 截断处留「…」是为了让模型知道还有下文，不会把半句话当成完整约束。 */
  function clipNote(text) {
    const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    return s.length > 60 ? s.slice(0, 60) + '…' : s;
  }

  /* 画板能力清单：运行时从 Funclab.CAPABILITIES 生成（禁止在 prompt 里另抄一份）。
   * note 同样只从 Funclab 取 —— 画板说明改了，追问 prompt 自动跟着改，
   * 不会出现两份互相矛盾的能力描述。没有 note 就不加「适用：」段。
   * Funclab 未加载 / 能力清单为空时返回空串，由调用方降级为「无可用画板 → graph 填 null」。 */
  function capabilityListText() {
    const F = global.Funclab;
    if (!F || !F.CAPABILITIES) return '';
    return Object.keys(F.CAPABILITIES).map(function (name) {
      const cap = F.CAPABILITIES[name] || {};
      const type = (F.CAP_TYPE && F.CAP_TYPE[name]) || cap.type || '';
      const can = (cap.canAnswer || []).join(' / ');
      const params = (cap.params || []).join(',');
      const note = clipNote(cap.note);
      return '- ' + name + '（type=' + type + '）：能回答 ' + can + '；参数 ' + params
        + (note ? '；适用：' + note : '');
    }).join('\n');
  }

  function askSystemPrompt() {
    const caps = capabilityListText();
    const capBlock = caps
      ? '可用画板（lab 只能取下面这些名字）：\n' + caps
      : '当前没有可用画板：graph 一律填 null。';
    return '你是人教版初中数学的一对一辅导老师，学生基础薄弱，正盯着他做错的一道题看讲解。'
      + '学生在提问，你要：'
      + '1) 直接回答他问的那个点，讲清楚、口语化、简短，贴合初中生；'
      + '2) 如果问题本质是「这道题怎么做/答案是多少」，沿用苏格拉底法引导他自己算，不要直接给最终答案；'
      + '3) 如果问题是对概念的疑问（如「什么叫移项」「为什么去括号要变号」），直接解释，可以结合当前题目举例；'
      + '4) 输出一个 JSON 对象，只有 text 和 graph 两个字段，不要输出 JSON 以外的任何内容；text 是给学生看的正文。格式：{"text":"回答正文（纯文本）","graph":null}；'
      + '需要画图时 graph 为对象，例：{"text":"回答正文","graph":{"type":"quadratic","lab":"quadratic-vertex","intent":"最小值","params":{"a":1,"h":0,"k":3}}}；'
      + '5) 回答是纯文本，禁止 Markdown（不要用 **、*、`、#、> 等符号），公式直接用文字写；'
      + '6) 不要写任何反斜杠命令（如 \sqrt、\frac 都不要用），根号用 √（如 2±√5）、分数用斜杠（如 1/2）。'
      + '7) 回答时如果涉及图，必须以「画板」这段描述为准。描述里说图上有什么，你才能说有；描述里没提到的元素，不要说它存在或不存在。图上是虚线还是实线、有没有箭头，一律照描述说。'
      + '8) 画板上刻意留白的量（描述里标为「留白」或「?」）不许你直接说出数值——哪怕前面「标准解析」「讲解进度」里已经写了这个数，学生问起来也只能引导他去看图、自己算，不许代他读出。'
      + '9) graph.params 必须是本题这个函数的真实系数：函数本身（type 里的 fn）不许换，只允许改参数值；不许为了「凑一个能画的参数」把函数改掉。'
      + '10) 你画的图（如果画），它的顶点坐标、最大值/最小值同样不许在 text 里说出具体数值——和题面画板同一条纪律；学生问「x 是多少」，引导他去看图上的落点或自己算，不代他读出。也不要用「a=…、h=…、k=…」这种列出顶点式系数的方式把数值报出来（h 就是顶点横坐标、k 就是最值）；函数本身照学生问的原样写即可。'
      + '11) lab 只能从下面给定的能力清单里选；清单里没有合适的就填 null，不许自创。\n' + capBlock + '\n'
      + '12) user 消息里的「画板：」是本题画板的描述；你要画的图只能是本题这个函数，只允许改参数值。学生要换函数时，用文字讲清为什么不能换，并说明换过去会怎样，不许给 graph。';
  }

  /* 历史条目的单元格截到 200 字：一条长解析能把 token 预算吃满，
   * 而当前问题通常只依赖上一两轮的结论，不需要原文全量。 */
  function clipHistoryText(text) {
    const s = String(text == null ? '' : text).trim();
    return s.length > 200 ? s.slice(0, 200) + '…' : s;
  }

  /* 最近 2 轮问答的 prompt 段落。只回看 2 轮：更早的对话对当前追问基本没用，
   * 反而会把普通追问的上下文挤掉。没正文 / 还在 pending 的轮次不参与 ——
   * 那些是学生刚发出、老师还没答的占位，拼进去会让模型把问题当成已有答案。 */
  function askHistoryText(history) {
    if (!history || !history.length) return '';
    const rounds = [];
    for (let i = 0; i < history.length; i++) {
      const e = history[i];
      if (!e || e.pending) continue;
      const qs = typeof e.q === 'string' ? e.q : '';
      const as = typeof e.a === 'string' ? e.a : '';
      if (!as.trim()) continue;
      rounds.push({ q: qs, a: as });
    }
    const tail = rounds.slice(-2);
    if (!tail.length) return '';
    return '历史问答（最近 2 轮）：\n' + tail.map(function (r) {
      return '学生：' + clipHistoryText(r.q) + '\n老师：' + clipHistoryText(r.a);
    }).join('\n---\n');
  }

  function askUserPrompt(topic, q, userAnswer, steps, question, labDesc, history) {
    const typeLabel = ({ choice: '选择题', numeric: '填数字', short: '简答' })[q.type] || '题';
    const topicName = (topic && topic.name) || '';
    const stepsText = (steps || []).map(function (s) {
      return '  [' + (STEP_LABEL[s.kind] || s.kind) + '] ' + s.text;
    }).join('\n');
    const hist = askHistoryText(history);
    return '题目（' + typeLabel + '）：' + q.prompt
      + '\n知识点：' + topicName
      + (labDesc ? '\n画板：' + labDesc : '')
      + '\n学生答案：' + (userAnswer === '' ? '（没填）' : userAnswer)
      + (q.explanation ? '\n标准解析（参考，不要照抄）：' + q.explanation : '')
      + '\n当前讲解进度（学生已看到的引导）：\n' + (stepsText || '（无）')
      + (hist ? '\n\n' + hist : '')
      + '\n\n学生的问题：' + question;
  }

  /* 截断兜底：原因是推理模型把 token 预算花在 reasoning 上，网关会截断 JSON，
   * 半截内容如 {"text":"你问 丢掉闭合括号，JSON.parse 必然失败。
   * 这里只从 raw 里抠 text 字段已写出的那半句；扣不出东西返回空串，由调用方沿用原样。
   * 截断场景下 graph 一律为 null —— 绝不从半截 JSON 里猜图。 */
  function salvageText(raw) {
    const mm = String(raw || '').match(/"text"\s*:\s*"((?:[^"\\]|\\.)*)/);
    if (!mm) return '';
    return mm[1].replace(/\\(["\\n])/g, function (_m, ch) {
      return ch === 'n' ? '\n' : ch;   // \" -> "、\\ -> \、\n -> 换行
    });
  }

  function llmAsk(topic, q, userAnswer, steps, question, labDesc, history) {
    /* 配置没加载就按离线处理：不把 null 传给 fetch（那会变成 TypeError） */
    if (!CFG) return Promise.reject(new Error('LLMConfig 未加载（llm-config.js 没引入）'));
    const body = {
      model: MODEL,
      messages: [
        { role: 'system', content: askSystemPrompt() },
        { role: 'user', content: askUserPrompt(topic, q, userAnswer, steps, question, labDesc, history) }
      ],
      max_tokens: FOLLOWUP_MAX_TOKENS,
      temperature: 0.5,
      response_format: { type: 'json_object' }
    };
    return postChat(body).then(function (data) {
      const c = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      const raw = c == null ? '' : String(c);
      let text = raw;
      let graph = null;
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          const j = JSON.parse(m[0]);
          text = (j && j.text != null) ? String(j.text) : '';
          graph = (j && j.graph && typeof j.graph === 'object' && !Array.isArray(j.graph)) ? j.graph : null;
        } catch (e) {
          /* 宽松兜底：不是合法 JSON 就把整段 content 当正文，不 throw；
           * 但截断场景要先把 text 半句抠出来，别把 '"text":"你问' 当正文给学生看 */
          text = salvageText(raw) || raw;
          graph = null;
        }
      } else if (raw.trim().charAt(0) === '{') {
        /* 有 '{' 却没有闭合 '}' —— token 被截断，同样只展示 text 半句 */
        text = salvageText(raw) || raw;
        graph = null;
      }
      const cleaned = cleanMarkdown(text);
      if (!cleaned) {
        const err = _markFail(new Error('llm empty'), 'llm');
        err.detail = 'empty';
        throw err;
      }
      return { text: cleaned, graph: graph };
    });
  }

  /** 讲解中追问（单轮）。返回 Promise<{text, graph, from: 'llm'|'offline'}>，永不 reject：
   *   llm    —— AI 老师正常回答（graph 为校验前的原始对象，由 ChatGraph 校验后再挂图）
   *   offline—— 网关不可用，text/graph 均为 null（UI 显示引导语）
   *  失败时文案按 reason 区分（noticeFor），并补一条与 generate() 同款的 console.warn 日志 ——
   *  追问路径以前零日志，出问题查不出原因。日志只放 reason/状态码/文案，不打 body 全文 / Authorization。 */
  function ask(topic, q, userAnswer, steps, question, labDesc, history) {
    return llmAsk(topic, q, userAnswer, steps, question, labDesc, history)
      .then(function (res) { return { text: res.text, graph: res.graph, from: 'llm' }; })
      .catch(function (err) {
        const f = failInfo(err);   // reason/httpStatus/degraded/detail 带出来
        const notice = noticeFor(f.reason, f.httpStatus, f.degraded, f.detail);
        if (global.console && global.console.warn) {
          const tag = (f.reason === 'http' && f.httpStatus) ? ('http ' + f.httpStatus) : f.reason;
          const extra = f.degraded ? '（已降级重试）' : '';
          global.console.warn('Explain.ask 失败（' + tag + extra + '）：' + notice);
        }
        return { text: null, graph: null, from: 'offline', reason: f.reason, notice: notice, httpStatus: f.httpStatus, degraded: f.degraded };
      });
  }

  /** reveal 里声明的最终解值是否与标准答案一致（O2）。
   *  true/false 都是明确结论，null 表示无法判断（答案非数值 / reveal 没给明确解值）。 */
  function checkReveal(q, steps) {
    const ref = q && q.answer;
    const E = global.DiagEngine;
    if (!ref || !E || typeof E.verifyReveal !== 'function') return { ok: null, reason: 'no-verifier' };
    let reveal = '';
    for (let i = 0; i < steps.length; i++) if (steps[i].kind === 'reveal') { reveal = steps[i].text; break; }
    return E.verifyReveal(reveal, ref);
  }

  async function llmSteps(topic, q, userAnswer, labDesc) {
    /* 配置没加载就按失败处理：generate 把 from='none' 交回面板 */
    if (!CFG) throw new Error('LLMConfig 未加载（llm-config.js 没引入）');
    const body = {
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt() },
        { role: 'user', content: userPrompt(topic, q, userAnswer, labDesc) }
      ],
      max_tokens: EXPLAIN_MAX_TOKENS,
      temperature: 0.6
    };
    const data = await postChat(body);
    const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    /* 内容为空 / 解析不出三步：按 finish_reason 区分「被 max_tokens 截断」与「格式不对」，
     * 学生看到的文案才能与事实相符（截断≠空内容）。detail 只用于选文案，不进公开字段。 */
    const truncated = !!(data && data.choices && data.choices[0] && data.choices[0].finish_reason === 'length');
    const detail = truncated ? 'truncated' : 'badjson';
    let steps = null;
    try { steps = parseSteps(content); } catch (e) { steps = null; }   /* 残缺 JSON 同归「格式不对」 */
    if (!steps) {
      const err = _markFail(new Error('llm bad json'), 'llm');
      err.detail = detail;
      throw err;
    }
    // 数值校验：reveal 的最终解值与标准答案不一致就整轮作废（抛错 -> generate 返回 from='none'）
    if (checkReveal(q, steps).ok === false) {
      const err = _markFail(new Error('llm reveal mismatch'), 'llm');
      err.detail = 'mismatch';
      throw err;
    }
    return steps;
  }

  /** 苏格拉底讲解（只在配置了 LLM 时由面板调用）。
   * 返回 Promise<{steps, from}>，永不 reject：
   *   成功 —— {steps: [{kind,text}], from: 'llm'}
   *   失败 —— {steps: null, from: 'none', reason, notice}；notice 由 noticeFor 统一给
   * 只缓存成功结果（同题 5 分钟，key = q.id + '|' + 有无画板）；失败不缓存，
   * 否则学生点「再问一次」会命中一条没有内容的占位。同一题有/无画板不得互相命中。 */
  function generate(topic, q, userAnswer, labDesc) {
    const qid = q && q.id;
    const ckey = qid ? (qid + '|' + (labDesc ? 1 : 0)) : null;
    const hit = ckey && cache.get(ckey);
    if (hit && Date.now() - hit.ts < TTL) return Promise.resolve({ steps: hit.steps, from: 'llm' });
    return llmSteps(topic, q, userAnswer, labDesc)
      .then((steps) => {
        if (ckey) cache.set(ckey, { ts: Date.now(), steps: steps });
        return { steps: steps, from: 'llm' };
      })
      .catch(function (err) {
        const f = failInfo(err);
        const notice = noticeFor(f.reason, f.httpStatus, f.degraded, f.detail);
        /* 并发失败的清理：早先的实现会先写静态占位，这里已不写占位；
         * 仍删一次同名 key，防止「同题不同画板」等历史残留把重试挡在缓存里。 */
        if (ckey) cache.delete(ckey);
        if (global.console && global.console.warn) {
          global.console.warn('Explain.generate 失败（' + f.reason + '）：' + notice);
        }
        return { steps: null, from: 'none', reason: f.reason, notice: notice };
      });
  }

  /* ================================================================
   * 卡 D：追问 chip 化（Tutor 层）—— chip 白名单 / 会话锚定 / 本地判解 / 分级提示
   *
   * 与自由追问（ask）的区别：chip 走固定 schema 的短 JSON，输出只有文本/短字段；
   * 会话锚到题（qid + prompt_hash），题面一变即新会话；对错结论只认本地求值。
   * 导出：Explain.runChip（公开）+ Explain._tutor（测试用）。
   * ================================================================ */

  const MAX_ROUNDS = 10;   // 轮数上限：再长的问题是新的一题，上下文挤不下
  const KEEP_ROUNDS = 3;   // 超出后只保留最近 3 轮 + 摘要

  /* chip 定义（顺序即 UI 顺序，文案一字不改；UI 从这里取，不另写一份） */
  const TUTOR_CHIPS = [
    { action: 'why_step', label: '这一步为什么这么做' },
    { action: 'variant', label: '换个数字再来一道' },   // 不走 LLM，转 O3 管线（app-flow 接线）
    { action: 'judge_mine', label: '我这样算对不对' },
    { action: 'hint_leveled', label: '给我一点点提示' }
  ];

  /* 白名单：只认这 4 个 action 字符串。「不认识的 action 不发请求」的唯一判据 ——
   * 恶意 / 拼错的 action 在这里就挡下，永远碰不到 fetch。 */
  function resolveChip(action) {
    if (typeof action !== 'string') return null;
    for (let i = 0; i < TUTOR_CHIPS.length; i++) {
      if (TUTOR_CHIPS[i].action === action) return TUTOR_CHIPS[i];
    }
    return null;
  }

  /* ---------------- 会话锚定（键 = qid + prompt_hash） ---------------- */

  /* FNV-1a 32bit：哈希乘法必须用 Math.imul（直接乘会超 2^53 丢精度，
   * 相邻题面可能撞出同一个 hash，锚题就失效了）。输出 8 位小写 hex。 */
  function promptHash(prompt) {
    const s = String(prompt == null ? '' : prompt).replace(/\s+/g, ' ').trim();
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    const hex = (h >>> 0).toString(16);
    return '00000000'.slice(hex.length) + hex;   // padStart 手写：兼容老浏览器
  }

  function identify(q) {
    const prompt = (q && q.prompt) || '';
    const hash = promptHash(prompt);
    return {
      qid: String((q && q.id) || 'anon') + '@' + hash,
      promptHash: hash,
      prompt: prompt
    };
  }

  function sessionKeyOf(q) {
    const idn = identify(q);
    return idn.qid + '|' + idn.promptHash;
  }

  function newSession(q) {
    const idn = identify(q);
    return {
      key: idn.qid + '|' + idn.promptHash,
      qid: idn.qid,
      promptHash: idn.promptHash,
      prompt: idn.prompt,   // 题面快照：一经创建不再变，题面变了就开新会话
      rounds: [],
      summary: '',
      trimmed: false
    };
  }

  /* 摘要单元格截 24 字：摘要只要让模型知道「大致聊过什么」，不是全文复读 */
  function clip24(s) {
    const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return t.length > 24 ? t.slice(0, 24) + '…' : t;
  }

  /* 确定性文本摘要（无 LLM）：'更早的 N 轮：问「…」→答「…」；…'。
   * prevSummary 非空时接在前面；总长 ≤ 200（超长从尾部硬截，不加省略号——
   * 摘要本身就是要被截的，再叠一层「…」只是浪费预算）。 */
  function summarize(prevSummary, rounds) {
    const parts = (rounds || []).map(function (r) {
      return '问「' + clip24(r && r.q) + '」→答「' + clip24(r && r.a) + '」';
    });
    let text = (prevSummary ? String(prevSummary) : '')
      + (prevSummary && parts.length ? '；' : '')
      + '更早的 ' + parts.length + ' 轮：' + parts.join('；');
    return text.length > 200 ? text.slice(0, 200) : text;
  }

  /* 会话一律不可变风格：appendRound 返回新对象，不改传入的 session ——
   * app-flow 里 S.ui.askSession 直接换成返回值，出问题也好回退。 */
  function appendRound(session, round) {
    if (!session || !session.key) return { ok: false, reason: 'no-session' };
    if (round && round.promptHash != null && round.promptHash !== session.promptHash) {
      /* 题面变了就是新题，不许往旧会话里塞 */
      return { ok: false, reason: 'prompt-changed' };
    }
    const rounds = session.rounds.slice();
    let summary = session.summary;
    let trimmed = session.trimmed;
    if (rounds.length >= MAX_ROUNDS) {
      /* 超上限：把前面部分并入摘要，只留最近 KEEP_ROUNDS-1 轮再入新轮 */
      const cut = rounds.length - (KEEP_ROUNDS - 1);
      summary = summarize(summary, rounds.slice(0, cut));
      rounds.splice(0, cut);
      trimmed = true;
    }
    rounds.push({
      q: String((round && round.q) || ''),
      a: String((round && round.a) || ''),
      action: (round && round.action) || null,
      promptHash: (round && round.promptHash != null) ? round.promptHash : session.promptHash
    });
    return {
      ok: true,
      session: {
        key: session.key,
        qid: session.qid,
        promptHash: session.promptHash,
        prompt: session.prompt,
        rounds: rounds,
        summary: summary,
        trimmed: trimmed
      }
    };
  }

  /* 给 prompt 拼装用的会话上下文：返回拷贝，不把内部 rounds 引用交出去 */
  function contextFor(session) {
    if (!session) return { qid: '', promptHash: '', prompt: '', summary: '', rounds: [] };
    return {
      qid: session.qid,
      promptHash: session.promptHash,
      prompt: session.prompt,
      summary: session.summary,
      rounds: (session.rounds || []).map(function (r) {
        return { q: r.q, a: r.a, action: r.action, promptHash: r.promptHash };
      })
    };
  }

  /* ---------------- 本地判解（chip「我这样算对不对」） ----------------
   * 判「最终答案」只认本地求值，模型无权给结论 —— AI 说「你对了」不算数。 */

  function _diagEngine() {
    /* 浏览器挂 window.DiagEngine（index.html 先加载 engine.js）；
     * Node 测试直接 require —— 与 _loadLLMConfig 同款双端写法 */
    if (global.DiagEngine) return global.DiagEngine;
    if (typeof require === 'function') {
      try { return require('./engine.js'); } catch (e) { /* 落到 unverified */ }
    }
    return null;
  }

  /* 抽「最终答案」：只压空白不压换行（路径 3 的行首/行尾匹配依赖 \n）。
   * 三条路径按信号强度排序：显式前缀 > 结论词 > 整行赋值。无命中返回 null。 */
  function extractFinalAnswer(text) {
    const s = String(text == null ? '' : text).replace(/[^\S\n]+/g, ' ');
    if (!s.trim()) return null;
    let m = s.match(/(?:答案|答)\s*[:：]\s*([^\n。；;]{1,40})/);
    if (m) return m[1].trim();
    m = s.match(/(?:所以|因此|故|即|得)\s*([A-Za-z]?\s*[=＝]?\s*-?\d[^\n。；;，,]{0,20})/);
    if (m) return m[1].trim();
    m = s.match(/(?:^|\n)\s*([A-Za-z]\s*[=＝]\s*-?\d[^\n。；;]{0,20})\s*(?:\n|$)/m);
    if (m) return m[1].trim();
    return null;
  }

  /* 去变量前缀（x= / x1= / x ＝）与尾部句读，把声明压成 engine 能判的 claim */
  function normalizeClaim(candidate) {
    let s = String(candidate == null ? '' : candidate).trim();
    s = s.replace(/^[A-Za-z][0-9]*\s*[=＝]\s*/, '');
    return s.replace(/[。\.\s；;]+$/, '').trim();
  }

  function judgeSolution(q, text) {
    const ref = q && q.answer;
    if (!ref) return { conclusion: 'unverified', reason: 'no-reference', claim: null, reference: null };
    const raw = extractFinalAnswer(text);
    if (!raw) return { conclusion: 'unverified', reason: 'no-final-answer', claim: null, reference: String(ref) };
    const claim = normalizeClaim(raw);
    const E = _diagEngine();
    if (!E || typeof E.judgeQuestion !== 'function') {
      return { conclusion: 'unverified', reason: 'no-verifier', claim: claim, reference: String(ref) };
    }
    let verdict = null;
    try { verdict = E.judgeQuestion(q, claim).verdict; } catch (e) { verdict = null; }
    if (verdict === 'correct') return { conclusion: 'correct', reason: 'local-correct', claim: claim, reference: String(ref) };
    if (verdict === 'wrong') return { conclusion: 'wrong', reason: 'local-wrong', claim: claim, reference: String(ref) };
    return { conclusion: 'unverified', reason: 'unsure', claim: claim, reference: String(ref) };
  }

  /* 学生可见的判读文案：三档各说各话。unverified 绝不说「答对了/你做对了」——
   * 没核对过就不下结论，孩子照着错误结论走下去比没有结论更糟。 */
  function renderVerdict(res) {
    const c = res && res.conclusion;
    if (c === 'correct') {
      return { text: '本地核对：最后写的答案和标准答案一致。', cls: 'ask-verdict ok', badge: '已核对' };
    }
    if (c === 'wrong') {
      return { text: '本地核对：最后写的答案和标准答案不一致，先看第一处错在哪。', cls: 'ask-verdict no', badge: '已核对' };
    }
    return {
      text: '未验证：没看到明确的最终答案，不能替你判断对错 —— 先把最后结果写出来，或看下面的解析。',
      cls: 'ask-verdict unverified',
      badge: '未验证'
    };
  }

  /* ---------------- 分级提示（L1 方向 / L2 第一步 / L3 完整答案） ---------------- */

  /* 泄漏判据双路：engine 的解值声明口径（只读复用 verifyReveal，不改判分）
   * + 纯数字答案的边界包含。第二路必须有：verifyReveal 对口语化文本
   * （如「x=3 就对了」）常返回 no-claim（ok:null），单靠它会把泄漏放进 L1。 */
  function answerLeak(text, answer) {
    const t = String(text == null ? '' : text);
    const ref = String(answer == null ? '' : answer).trim();
    if (!t || !ref) return false;
    const E = _diagEngine();
    if (E && typeof E.verifyReveal === 'function') {
      try { if (E.verifyReveal(t, ref).ok === true) return true; } catch (e) { /* 落到边界判据 */ }
    }
    if (/^-?\d+(\.\d+)?$/.test(ref)) {
      /* 边界要求：数字前后不能再是数字/小数点 —— '13' 里的 3 不是答案 '3' */
      const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp('(^|[^0-9.])' + escaped + '([^0-9.]|$)').test(t);
    }
    /* 非纯数字答案：压掉空白做包含判断（宁严勿漏，fail-closed） */
    return t.replace(/\s+/g, '').indexOf(ref.replace(/\s+/g, '')) >= 0;
  }

  /* L1/L2 的固定安全文案：模型泄漏时整句换掉 —— 改写半句既费 token 又可能漏 */
  const SAFE_HINT = {
    1: '先别算：看清题目要你求什么，再想想这一步在等号两边各动了什么。',
    2: '第一步：把含未知数的项都移到等号左边，常数项移到右边（移项要变号）。'
  };

  function sanitizeHint(level, text, q) {
    /* level 归一为 1/2/3：非数字或越界一律按 1（提示永远从最保守档给起） */
    const lv = (typeof level === 'number' && isFinite(level) && level >= 1 && level <= 3) ? Math.floor(level) : 1;
    const raw = String(text == null ? '' : text);
    if (lv === 3) return { level: 3, text: raw, leaked: false, redacted: false, gate: 'reveal' };
    if (!q || !q.answer) return { level: lv, text: raw, leaked: false, redacted: false, gate: 'no-reference' };
    if (answerLeak(raw, q.answer)) {
      return { level: lv, text: SAFE_HINT[lv], leaked: true, redacted: true, gate: 'redacted' };
    }
    return { level: lv, text: raw, leaked: false, redacted: false, gate: 'ok' };
  }

  /* ---------------- chip 请求与执行 ---------------- */

  /* 每个 chip 的固定输出 schema：写进 system prompt，解析时按字段校验 */
  const CHIP_SCHEMA = {
    why_step: '只输出一个 JSON 对象，格式：{"text":"不超过 120 字的错因说明"}。'
      + 'text 必须引用题干里的具体数字或步骤（如「去括号时 2 要乘进去」），不许给出最终答案。',
    variant: '',   /* 管线动作，不发 LLM 请求，无 schema */
    judge_mine: '只输出一个 JSON 对象，格式：{"firstError":"第一处错的原文片段（没有就写空串）","explain":"为什么错、怎么改"}。'
      + '只解释第一处错；不要输出 conclusion/verdict 之类的对错结论字段 —— 对错由本地核对决定。',
    hint_leveled: '只输出一个 JSON 对象，格式：{"text":"分级提示正文"}。'
      + '分级规则（必须严格执行）：L1 只给方向，禁止写任何数值结果；'
      + 'L2 只给第一步，可写算式但不得写最终答案；L3 才给完整答案。'
  };

  const CHIP_COMMON_BAN = '输出必须是纯 JSON，禁止任何 Markdown 标记（不要 **、*、`、#、>）与反斜杠命令；'
    + '根号用 √、分数用斜杠；语言口语化、贴合初中生，不写废话。';

  function chipSystemPrompt(chip, ctx) {
    let lvRule = '';
    if (chip.action === 'hint_leveled') {
      /* level 由调用方给（不采信模型返回值）；本次档位写明，模型才好拿捏尺度 */
      const lv = (ctx && ctx.level) || 1;
      lvRule = ' 本次要 L' + lv + ' 档提示：'
        + (lv === 1 ? '只给方向，禁止写任何数值结果。'
          : lv === 2 ? '只给第一步，可写算式但不得写最终答案。'
            : '给完整答案与解析。');
    }
    return '你是人教版初中数学的一对一辅导老师，学生基础薄弱，正盯着他做错的一道题看讲解。'
      + (CHIP_SCHEMA[chip.action] || '')
      + lvRule + ' ' + CHIP_COMMON_BAN;
  }

  function chipUserPrompt(chip, ctx) {
    const q = (ctx && ctx.q) || {};
    const topic = (ctx && ctx.topic) || {};
    const steps = (ctx && ctx.steps) || [];
    const ua = (ctx && ctx.userAnswer) == null ? '' : ctx.userAnswer;
    const stepsText = steps.map(function (s) {
      return '  [' + (STEP_LABEL[s.kind] || s.kind) + '] ' + s.text;
    }).join('\n');
    /* 会话上下文：摘要 + 最近 3 轮（chip 有轮数上限与裁剪，带 3 轮足够 */
    const session = ctx && ctx.session;
    let histText = '';
    if (session && (session.summary || (session.rounds && session.rounds.length))) {
      const parts = [];
      if (session.summary) parts.push('更早的轮次摘要：' + session.summary);
      const tail = (session.rounds || []).slice(-3);
      if (tail.length) {
        parts.push('最近 ' + tail.length + ' 轮：\n' + tail.map(function (r) {
          return '学生：' + clipHistoryText(r.q) + '\n老师：' + clipHistoryText(r.a);
        }).join('\n---\n'));
      }
      histText = '\n' + parts.join('\n');
    }
    let extra = '';
    if (chip.action === 'judge_mine' && ctx && ctx.solution) {
      extra = '学生贴来的解法（判断第一处错在哪）：\n' + ctx.solution + '\n\n';
    }
    return '题目：' + (q.prompt || '')
      + '\n知识点：' + (topic.name || '')
      + '\n学生答案：' + (ua === '' ? '（没填）' : ua)
      + (q.answer ? '\n本题目标准答案：' + q.answer + '（除 L3 提示外，不得在给学生的正文里直接说出）' : '')
      + '\n当前讲解进度（学生已看到的引导）：\n' + (stepsText || '（无）')
      + histText
      + '\n\n' + extra + '学生的请求：' + chip.label;
  }

  /* 发一次 chat 请求并按固定 schema 解析出 JSON 对象。
   * chip 是严格解析（区别于 ask 的宽松兜底）：schema 固定、字段少，
   * 缺字段按 detail:'badjson' 走既有失败文案，学生点「再问一次」即可。 */
  function llmChip(chip, ctx) {
    if (!CFG) return Promise.reject(new Error('LLMConfig 未加载（llm-config.js 没引入）'));
    const body = {
      model: MODEL,
      messages: [
        { role: 'system', content: chipSystemPrompt(chip, ctx) },
        { role: 'user', content: chipUserPrompt(chip, ctx) }
      ],
      max_tokens: TUTOR_MAX_TOKENS,
      temperature: 0.4,
      response_format: { type: 'json_object' }
    };
    return postChat(body, tutorTimeoutMs()).then(function (data) {
      const c = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      const raw = c == null ? '' : String(c);
      const m = raw.match(/\{[\s\S]*\}/);
      let j = null;
      if (m) { try { j = JSON.parse(m[0]); } catch (e) { j = null; } }
      if (!j || typeof j !== 'object') {
        const err = _markFail(new Error('llm bad json'), 'llm');
        err.detail = 'badjson';
        throw err;
      }
      return j;
    });
  }

  /* why_step 正文截断：超 120 字截成 120 字 + '…'，截断尽量落在词尾空白前 */
  function clipChipText(text, max) {
    const s = String(text == null ? '' : text);
    if (s.length <= max) return s;
    let cut = s.slice(0, max);
    const lastWs = cut.lastIndexOf(' ');
    if (lastWs > max * 0.6) cut = cut.slice(0, lastWs);   // 半截词回退到上一个空白
    return cut.replace(/[^\S\n]+$/, '') + '…';
  }

  function _emptyErr() {
    const err = _markFail(new Error('llm empty'), 'llm');
    err.detail = 'empty';
    return err;
  }

  /* 按 chip 归一化输出。judge_mine 的结论由本地判解合成；模型只供解释文本。 */
  function normalizeChipPayload(chip, ctx, j) {
    if (chip.action === 'why_step') {
      const text = cleanMarkdown(j && j.text);
      if (!text) throw _emptyErr();
      return { text: clipChipText(text, 120) };
    }
    if (chip.action === 'judge_mine') {
      const firstError = cleanMarkdown(j && j.firstError);
      let explain = cleanMarkdown(j && j.explain);
      if (!explain) throw _emptyErr();
      /* 结论只认本地判解（app-flow 传入 ctx.localVerdict 避免重复判） */
      const verdict0 = (ctx && ctx.localVerdict) || judgeSolution(ctx && ctx.q, (ctx && ctx.solution) || '');
      const conclusion = verdict0.conclusion;
      if (conclusion === 'unverified') {
        /* unverified 时模型文本里的结论词一律替换 —— AI 不能替孩子下没核对过的结论 */
        explain = explain.replace(/答对了|做对了|完全正确|是对的/g, '这里先不下结论');
      }
      return {
        text: explain,
        firstError: firstError,
        conclusion: conclusion,
        verified: conclusion !== 'unverified',
        verdict: renderVerdict(verdict0)
      };
    }
    /* hint_leveled：level 由调用方给（不采信模型返回值）；返回后必过 sanitizeHint 兜底 */
    const rawText = cleanMarkdown(j && j.text);
    if (!rawText) throw _emptyErr();
    return sanitizeHint((ctx && ctx.level) || 1, rawText, ctx && ctx.q);
  }

  /** 执行一个 chip。返回 Promise，永不 reject（与 ask 一致）：
   *   成功  —— { ok: true, from: 'llm', action, payload }
   *   白名单不认 —— { ok: false, from: 'none', action, reason: 'unknown-action' }（绝不发请求）
   *   variant 是管线动作 —— { ok: false, from: 'pipeline', action: 'variant', reason: 'pipeline-action' }
   *   缺会话 —— { ok: false, from: 'none', action, reason: 'no-session' }
   *   失败（timeout/network/http/llm）—— 沿用 failInfo + noticeFor 文案 */
  function runChip(action, ctx) {
    return Promise.resolve().then(function () {
      const chip = resolveChip(action);
      if (!chip) return { ok: false, from: 'none', action: String(action), reason: 'unknown-action' };
      if (chip.action === 'variant') return { ok: false, from: 'pipeline', action: 'variant', reason: 'pipeline-action' };
      if (!ctx || !ctx.session || !ctx.session.key) return { ok: false, from: 'none', action: chip.action, reason: 'no-session' };
      return llmChip(chip, ctx).then(function (j) {
        return { ok: true, from: 'llm', action: chip.action, payload: normalizeChipPayload(chip, ctx, j) };
      });
    }).catch(function (err) {
      const f = failInfo(err);
      const notice = noticeFor(f.reason, f.httpStatus, f.degraded, f.detail);
      if (global.console && global.console.warn) {
        global.console.warn('Explain.runChip(' + action + ') 失败（' + f.reason + '）：' + notice);
      }
      return { ok: false, from: 'none', action: action, reason: f.reason, notice: notice, httpStatus: f.httpStatus, degraded: f.degraded };
    });
  }

  global.Explain = {
    generate: generate,
    ask: ask,
    /* 卡 D：追问 chip 化 —— 公开入口 + 测试用的内部层 */
    runChip: runChip,
    _tutor: {
      CHIPS: TUTOR_CHIPS.slice(),   // 浅拷贝：UI 顺序与文案单源，测试改不动内部表
      resolveChip: resolveChip,
      promptHash: promptHash,
      identify: identify,
      sessionKeyOf: sessionKeyOf,
      newSession: newSession,
      summarize: summarize,
      appendRound: appendRound,
      contextFor: contextFor,
      extractFinalAnswer: extractFinalAnswer,
      normalizeClaim: normalizeClaim,
      judgeSolution: judgeSolution,
      renderVerdict: renderVerdict,
      sanitizeHint: sanitizeHint,
      SAFE_HINT: SAFE_HINT,
      MAX_ROUNDS: MAX_ROUNDS,
      KEEP_ROUNDS: KEEP_ROUNDS,
      chipSystemPrompt: chipSystemPrompt,
      chipUserPrompt: chipUserPrompt,
      runChip: runChip
    },
    _cache: cache,
    _ttl: TTL,
    /* 内部 prompt（t_85395e07 起可带 labDesc）；导出供测试直接断言画板段落 */
    _userPrompt: userPrompt,
    _askUserPrompt: askUserPrompt,
    /* 历史段落单独导出：测试可以只断言「哪些轮次/怎么截断」，不必经过整个 prompt */
    _askHistoryText: askHistoryText,
    _systemPrompt: systemPrompt,
    _askSystemPrompt: askSystemPrompt,
    /* 追问离线气泡文案选择函数（t_6df579b6）：导出供纯函数级测试断言各 reason 文案两两不同 */
    _noticeFor: noticeFor
  };
})(window);