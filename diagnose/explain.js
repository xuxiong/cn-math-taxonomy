/* LLM 苏格拉底讲解（T2）。挂在 window.Explain 上。
 * 设计：渐进增强——explainPanel 先用 engine.socraticSteps 的静态版即时渲染，
 * 同时后台调本地网关（经 llm-proxy.js :8010 绕 CORS）生成个性化三步；
 * 成功后重渲染面板，失败/离线则保留静态版（自动降级，不阻塞学习）。
 *
 * window.Explain.generate(topic, q, userAnswer) -> Promise<[{kind,text}]>
 *   - 同题 5 分钟防刷（Map 缓存，key = q.id）
 *   - 网关不可达 / 解析失败 → resolve 静态版（永不 reject）
 */
(function (global) {
  'use strict';
  const PROXY = 'http://127.0.0.1:3000/v1/chat/completions';   // 网关已支持 CORS(2026-10-22),直连不需要 llm-proxy
  const MODEL = 'DeepSeek-V4-Flash-0731-Unlimited';
  const TTL = 5 * 60 * 1000;

  /* O3-6：max_tokens 单一出处。
   * 讲解/追问实测输出 300-800 token 足够 —— 2048/1024 留足余量且不放大计费；
   * 不写裸数字，避免「改一处漏一处」（O3-4 探测漏改 max_tokens:100 即此类事故）。
   * 改这两个值之前先看 tests/test_engine.js 的 max_tokens 契约断言。 */
  const EXPLAIN_MAX_TOKENS = 2048;    // 三步讲解（prompt/hint/reveal 的 JSON）
  const FOLLOWUP_MAX_TOKENS = 1024;   // 讲解中追问（单轮纯文本回答）

  const cache = new Map();   // qid -> {ts, steps, from}

  function staticSteps(topic, q) {
    // 依赖 engine.js 已加载（index.html 顺序：engine.js → explain.js → app.js）
    return global.DiagEngine.socraticSteps(topic, q);
  }

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

  function askSystemPrompt() {
    return '你是人教版初中数学的一对一辅导老师，学生基础薄弱，正盯着他做错的一道题看讲解。'
      + '学生在提问，你要：'
      + '1) 直接回答他问的那个点，讲清楚、口语化、简短，贴合初中生；'
      + '2) 如果问题本质是「这道题怎么做/答案是多少」，沿用苏格拉底法引导他自己算，不要直接给最终答案；'
      + '3) 如果问题是对概念的疑问（如「什么叫移项」「为什么去括号要变号」），直接解释，可以结合当前题目举例；'
      + '4) 不要输出 JSON 或任何标记，只输出回答文本；'
      + '5) 回答是纯文本，禁止 Markdown（不要用 **、*、`、#、> 等符号），公式直接用文字写；'
      + '6) 不要写任何反斜杠命令（如 \sqrt、\frac 都不要用），根号用 √（如 2±√5）、分数用斜杠（如 1/2）。'
      + '7) 回答时如果涉及图，必须以「画板」这段描述为准。描述里说图上有什么，你才能说有；描述里没提到的元素，不要说它存在或不存在。图上是虚线还是实线、有没有箭头，一律照描述说。'
      + '8) 画板上刻意留白的量（描述里标为「留白」或「?」）不许你直接说出数值——哪怕前面「标准解析」「讲解进度」里已经写了这个数，学生问起来也只能引导他去看图、自己算，不许代他读出。';
  }

  function askUserPrompt(topic, q, userAnswer, steps, question, labDesc) {
    const typeLabel = ({ choice: '选择题', numeric: '填数字', short: '简答' })[q.type] || '题';
    const topicName = (topic && topic.name) || '';
    const stepsText = (steps || []).map(function (s) {
      return '  [' + (STEP_LABEL[s.kind] || s.kind) + '] ' + s.text;
    }).join('\n');
    return '题目（' + typeLabel + '）：' + q.prompt
      + '\n知识点：' + topicName
      + (labDesc ? '\n画板：' + labDesc : '')
      + '\n学生答案：' + (userAnswer === '' ? '（没填）' : userAnswer)
      + (q.explanation ? '\n标准解析（参考，不要照抄）：' + q.explanation : '')
      + '\n当前讲解进度（学生已看到的引导）：\n' + (stepsText || '（无）')
      + '\n\n学生的问题：' + question;
  }

  function llmAsk(topic, q, userAnswer, steps, question, labDesc) {
    const body = {
      model: MODEL,
      messages: [
        { role: 'system', content: askSystemPrompt() },
        { role: 'user', content: askUserPrompt(topic, q, userAnswer, steps, question, labDesc) }
      ],
      max_tokens: FOLLOWUP_MAX_TOKENS,
      temperature: 0.5
    };
    return fetch(PROXY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (resp) {
      if (!resp.ok) throw new Error('llm http ' + resp.status);
      return resp.json();
    }).then(function (data) {
      const c = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      const text = cleanMarkdown(c);
      if (!text) throw new Error('llm empty');
      return text;
    });
  }

  /** 讲解中追问（单轮）。返回 Promise<{text, from: 'llm'|'offline'}>，永不 reject：
   *   llm    —— AI 老师正常回答
   *   offline—— 网关不可用，text 为 null（UI 显示引导语） */
  function ask(topic, q, userAnswer, steps, question, labDesc) {
    return llmAsk(topic, q, userAnswer, steps, question, labDesc)
      .then(function (text) { return { text: text, from: 'llm' }; })
      .catch(function () { return { text: null, from: 'offline' }; });
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
    const body = {
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt() },
        { role: 'user', content: userPrompt(topic, q, userAnswer, labDesc) }
      ],
      max_tokens: EXPLAIN_MAX_TOKENS,
      temperature: 0.6
    };
    const resp = await fetch(PROXY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!resp.ok) throw new Error('llm http ' + resp.status);
    const data = await resp.json();
    const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    const steps = parseSteps(content);
    if (!steps) throw new Error('llm bad json');
    // 数值校验：reveal 的最终解值与标准答案不一致就整轮作废（抛错 -> generate 回退静态讲解）
    if (checkReveal(q, steps).ok === false) throw new Error('llm reveal mismatch');
    return steps;
  }

  /** 苏格拉底讲解（渐进增强）。
   * 返回 Promise<{steps: [{kind,text}], from: 'llm'|'static'}>，永不 reject：
   *   llm    —— 网关成功返回个性化三步
   *   static —— 网关不可用/解析失败，退化为 engine 静态模板（不显示"AI 讲解"标签）
   * 同题 5 分钟内存缓存（key = q.id + '|' + 有无画板）；缓存命中按 llm 计。
   * 同一题有/无画板两次 generate 不得互相命中。 */
  function generate(topic, q, userAnswer, labDesc) {
    const qid = q && q.id;
    const ckey = qid ? (qid + '|' + (labDesc ? 1 : 0)) : null;
    const hit = ckey && cache.get(ckey);
    if (hit && Date.now() - hit.ts < TTL) return Promise.resolve({ steps: hit.steps, from: hit.from || 'llm' });
    const fallback = staticSteps(topic, q);
    if (ckey) cache.set(ckey, { ts: Date.now(), steps: fallback, from: 'static' });   // 先占位，防并发重复调
    return llmSteps(topic, q, userAnswer, labDesc)
      .then((steps) => {
        if (ckey) cache.set(ckey, { ts: Date.now(), steps: steps, from: 'llm' });
        return { steps: steps, from: 'llm' };
      })
      .catch(() => ({ steps: fallback, from: 'static' }));   // 网关挂了 / reveal 数值校验没过，都用静态版
  }

  global.Explain = {
    generate: generate,
    ask: ask,
    staticSteps: staticSteps,
    _cache: cache,
    _ttl: TTL,
    /* 内部 prompt（t_85395e07 起可带 labDesc）；导出供测试直接断言画板段落 */
    _userPrompt: userPrompt,
    _askUserPrompt: askUserPrompt,
    _systemPrompt: systemPrompt,
    _askSystemPrompt: askSystemPrompt
  };
})(window);