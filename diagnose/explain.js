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
   * 讲解输出实测 300-800 token 足够 —— 2048 留足余量且不放大计费（追问的预算见下，另行说明）；
   * 不写裸数字，避免「改一处漏一处」（O3-4 探测漏改 max_tokens:100 即此类事故）。
   * 改这两个值之前先看 tests/test_engine.js 的 max_tokens 契约断言。 */
  const EXPLAIN_MAX_TOKENS = 2048;    // 三步讲解（prompt/hint/reveal 的 JSON）
  /* 讲解中追问：单轮，但输出是 JSON 对象 {text, graph|null}（不是纯文本）。
   * JSON 比纯文本多吃 token（键名、引号、转义 + graph 结构化参数），且推理模型的
   * reasoning 会先吃预算 —— 正文可能一个字都吐不出来（finish_reason=length、content 空串
   * → 学生看到「AI 老师暂时离线」）。实测同一 prompt 反复打网关：
   *   max_tokens=1024：稳定 finish=length、content 空（本卡根因）
   *   max_tokens=2048：仍有 3/10 次被 reasoning 吃光（completion=2048、content 空）
   *   max_tokens=4096：37/37 次 finish=stop、JSON 完整（completion 448–3342）
   * 取 4096：reasoning 长度有长尾，2048 不够稳；max_tokens 只是上限、按实际用量计费，
   * 抬高上限不额外花钱，且 <= 4096 是 test_engine.js 既有的防过度放大红线。 */
  const FOLLOWUP_MAX_TOKENS = 4096;

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

  /* 画板能力清单：运行时从 Funclab.CAPABILITIES 生成（禁止在 prompt 里另抄一份）。
   * Funclab 未加载 / 能力清单为空时返回空串，由调用方降级为「无可用画板 → graph 填 null」。 */
  function capabilityListText() {
    const F = global.Funclab;
    if (!F || !F.CAPABILITIES) return '';
    return Object.keys(F.CAPABILITIES).map(function (name) {
      const cap = F.CAPABILITIES[name] || {};
      const type = (F.CAP_TYPE && F.CAP_TYPE[name]) || cap.type || '';
      const can = (cap.canAnswer || []).join(' / ');
      const params = (cap.params || []).join(',');
      return '- ' + name + '（type=' + type + '）：能回答 ' + can + '；参数 ' + params;
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
      + '9) graph.params 必须是学生这次问的那个函数的真实系数，不许为了「凑一个能画的参数」改动函数本身。'
      + '10) 你自己指定要画的新图，它的顶点坐标、最大值/最小值同样不许在 text 里说出具体数值——和题面画板同一条纪律；学生问「x 是多少」，引导他去看图上的落点或自己算，不代他读出。也不要用「a=…、h=…、k=…」这种列出顶点式系数的方式把数值报出来（h 就是顶点横坐标、k 就是最值）；函数本身照学生问的原样写即可。'
      + '11) lab 只能从下面给定的能力清单里选；清单里没有合适的就填 null，不许自创。\n' + capBlock + '\n'
      + '12) user 消息里的「画板：」段落（ui.labDesc）是题面画板的描述，和这次追问要画的新图不是一回事；学生问的是题面之外的函数时，照样要给 graph，不要因为「题面画板已经画了」就不给。';
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

  function llmAsk(topic, q, userAnswer, steps, question, labDesc) {
    const body = {
      model: MODEL,
      messages: [
        { role: 'system', content: askSystemPrompt() },
        { role: 'user', content: askUserPrompt(topic, q, userAnswer, steps, question, labDesc) }
      ],
      max_tokens: FOLLOWUP_MAX_TOKENS,
      temperature: 0.5,
      response_format: { type: 'json_object' }
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
      if (!cleaned) throw new Error('llm empty');
      return { text: cleaned, graph: graph };
    });
  }

  /** 讲解中追问（单轮）。返回 Promise<{text, graph, from: 'llm'|'offline'}>，永不 reject：
   *   llm    —— AI 老师正常回答（graph 为校验前的原始对象，由 ChatGraph 校验后再挂图）
   *   offline—— 网关不可用，text/graph 均为 null（UI 显示引导语） */
  function ask(topic, q, userAnswer, steps, question, labDesc) {
    return llmAsk(topic, q, userAnswer, steps, question, labDesc)
      .then(function (res) { return { text: res.text, graph: res.graph, from: 'llm' }; })
      .catch(function () { return { text: null, graph: null, from: 'offline' }; });
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