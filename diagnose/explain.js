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

  const cache = new Map();   // qid -> {ts, steps, from}

  function staticSteps(topic, q) {
    // 依赖 engine.js 已加载（index.html 顺序：engine.js → explain.js → app.js）
    return global.DiagEngine.socraticSteps(topic, q);
  }

  function systemPrompt() {
    return '你是人教版初中数学的一对一辅导老师，学生基础薄弱，需要你耐心引导。'
      + '学生答错了一道题。请用苏格拉底式三步引导帮助他，按 JSON 输出，不要任何多余文字，格式严格为：'
      + '{"prompt":"第一步：只提问引导，让学生自己发现错误，绝不能给出答案或关键数值","hint":"第二步：给出方向性线索，提示关键步骤，但不能直接写出最终答案","reveal":"第三步：完整解析，先给正确解答，再分步解释为什么"}'
      + '要求：语言简短口语化、贴合初中生；prompt 和 hint 绝不写正确答案，hint 最多给一半思路；reveal 详细但不啰嗦。';
  }

  function userPrompt(topic, q, userAnswer) {
    const typeLabel = ({ choice: '选择题', numeric: '填数字', short: '简答' })[q.type] || '题';
    const topicName = (topic && topic.name) || '';
    return '题目（' + typeLabel + '）：' + q.prompt
      + '\n知识点：' + topicName
      + '\n学生答案：' + (userAnswer === '' ? '（没填）' : userAnswer)
      + (q.explanation ? '\n可参考的标准解析（reveal 里可以展开它，但不要照抄）：' + q.explanation : '');
  }

  function parseSteps(content) {
    let m = String(content || '').match(/\{[\s\S]*\}/);
    if (!m) return null;
    const j = JSON.parse(m[0]);
    const kinds = ['prompt', 'hint', 'reveal'];
    const steps = [];
    for (const k of kinds) {
      const text = (j[k] || '').trim();
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
      + '4) 不要输出 JSON 或任何标记，只输出回答文本。';
  }

  function askUserPrompt(topic, q, userAnswer, steps, question) {
    const typeLabel = ({ choice: '选择题', numeric: '填数字', short: '简答' })[q.type] || '题';
    const topicName = (topic && topic.name) || '';
    const stepsText = (steps || []).map(function (s) {
      return '  [' + (STEP_LABEL[s.kind] || s.kind) + '] ' + s.text;
    }).join('\n');
    return '题目（' + typeLabel + '）：' + q.prompt
      + '\n知识点：' + topicName
      + '\n学生答案：' + (userAnswer === '' ? '（没填）' : userAnswer)
      + (q.explanation ? '\n标准解析（参考，不要照抄）：' + q.explanation : '')
      + '\n当前讲解进度（学生已看到的引导）：\n' + (stepsText || '（无）')
      + '\n\n学生的问题：' + question;
  }

  function llmAsk(topic, q, userAnswer, steps, question) {
    const body = {
      model: MODEL,
      messages: [
        { role: 'system', content: askSystemPrompt() },
        { role: 'user', content: askUserPrompt(topic, q, userAnswer, steps, question) }
      ],
      max_tokens: 600,
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
      const text = String(c || '').trim();
      if (!text) throw new Error('llm empty');
      return text;
    });
  }

  /** 讲解中追问（单轮）。返回 Promise<{text, from: 'llm'|'offline'}>，永不 reject：
   *   llm    —— AI 老师正常回答
   *   offline—— 网关不可用，text 为 null（UI 显示引导语） */
  function ask(topic, q, userAnswer, steps, question) {
    return llmAsk(topic, q, userAnswer, steps, question)
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

  async function llmSteps(topic, q, userAnswer) {
    const body = {
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt() },
        { role: 'user', content: userPrompt(topic, q, userAnswer) }
      ],
      max_tokens: 900,
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
   * 同题 5 分钟内存缓存（key = q.id）；缓存命中按 llm 计。 */
  function generate(topic, q, userAnswer) {
    const qid = q && q.id;
    const hit = qid && cache.get(qid);
    if (hit && Date.now() - hit.ts < TTL) return Promise.resolve({ steps: hit.steps, from: hit.from || 'llm' });
    const fallback = staticSteps(topic, q);
    if (qid) cache.set(qid, { ts: Date.now(), steps: fallback, from: 'static' });   // 先占位，防并发重复调
    return llmSteps(topic, q, userAnswer)
      .then((steps) => {
        if (qid) cache.set(qid, { ts: Date.now(), steps: steps, from: 'llm' });
        return { steps: steps, from: 'llm' };
      })
      .catch(() => ({ steps: fallback, from: 'static' }));   // 网关挂了 / reveal 数值校验没过，都用静态版
  }

  global.Explain = {
    generate: generate,
    ask: ask,
    staticSteps: staticSteps,
    _cache: cache,
    _ttl: TTL
  };
})(window);