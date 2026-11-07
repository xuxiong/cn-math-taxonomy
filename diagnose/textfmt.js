/* 文本规范化统一出口（卡 t_42e5978b）：AI 题面 / 解析「看着乱」的清洗层。
 *
 * 为什么要有这个文件
 * ------------------
 * 全前端没有 KaTeX / MathJax / Markdown 渲染器，题面与解析都是 white-space: pre-wrap 的
 * 纯文本容器 —— 上屏什么就长什么样。原先把 cleanLatex / cleanMarkdown 埋在 explain.js 里，
 * 只有老讲解链路调用；卡 C 的新出题管线（llm-gen → llm-gates）完全没清洗，且 `^` 从来没人管。
 * 实测（181 道 AI 生成题 vs 题库 13335 道）：`\frac` 残留 1 道 : 0 道，`^` 上标 13.8% : 1.1%。
 * 现在清洗只有一份实现，所有出口共用：
 *   - explain.js（三步讲解 + 追问气泡 + chip 追问）  → normalize()
 *   - llm-gen.js（卡 C 出题管线，七道门之前）        → normalizeCandidate()
 *   - 任何直接展示模型文本的新代码                   → normalize()
 *
 * 口径（改之前先读；写进卡 t_42e5978b 评论）
 * ----------------------------------------
 * 1. 上标：指数是数字 → 逐位 Unicode 上标。x^2→x²、2^3→2³、(x+3)^2→(x+3)²、x^10→x¹⁰。
 *    题库的人工风格就是 ²/³（13335 道里 619 道），这是「两套风格混在一页」的对齐点。
 * 2. 例外：数值底数 + 多位指数（2^10、10^6 这种科学记数法写法）→ 原样保留。理由有三：
 *    a) 题库本身就这么写（145 道 ^ 残留里绝大多数是 10^6 / a^2025 这类），保留不算「乱」；
 *    b) 逐字符替换才是拼错来源（2^10 → 2¹0），而「算出结果」会毁掉科学记数法语义
 *       （5.2×10^4 变成 5.2×10000）；
 *    c) 单位指数没有这个问题：2^3 → 2³、10^6 → 10⁶（信息无损，与 x^2 → x² 同一规则）。
 * 3. 指数字母 / 带括号（a^n、x^(n+1)、2^(-3)）→ 有 Unicode 上标字形的（n / i）用上标，
 *    其余转中文「x 的 n+1 次方」。理由：这些写法无法用单字符字形表达，保留 ^ 会让
 *    「规范化后 ^ 出现率 ≤ 题库 1.1%」这条口径永远不达标；中文读法与初中课本一致。
 * 4. $...$ 数学模式定界符一律剥掉（题库 0 个 $）。
 * 5. 幂等：normalize(normalize(s)) === normalize(s)（tests/test_textfmt.js 覆盖）。
 * 6. 只做「展示形态」转换，不动数值：正则不解析表达式，也不做任何计算。
 *
 * UMD：浏览器 window.CnmTextFmt / Node require('./textfmt.js')。零依赖、零 DOM。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.CnmTextFmt = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* 上标数字表（纯文本容器里上标只能写成 Unicode 字形） */
  var SUP_DIGIT = {
    '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
    '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹'
  };

  /* 有 Unicode 上标字形的字母：只有 n / i，其余字母走中文「的 x 次方」 */
  var SUP_LETTER = { n: 'ⁿ', i: 'ⁱ' };

  /** 数字串逐位转上标：'10' -> '¹⁰'（每一位都有字形，所以多位指数也不会拼错） */
  function supDigits(run) {
    var out = '';
    for (var i = 0; i < run.length; i++) out += (SUP_DIGIT[run[i]] || run[i]);
    return out;
  }

  var CMD = {
    pm: '±', times: '×', cdot: '·', div: '÷', le: '≤', ge: '≥',
    neq: '≠', approx: '≈', infty: '∞', pi: 'π'
  };

  /**
   * 幂写法 → 纯文本（规则 1–3 见文件头）。
   * 必须在「花括号已剥掉」之后调用：x^{2} 先变成 x^2 才有救。
   * @param {string} s
   * @returns {string}
   */
  function powers(s) {
    /* 3a. 指数是括号内容（不处理嵌套）：x^(n+1) -> x 的 n+1 次方 */
    s = s.replace(/\^\(([^()]*)\)/g, function (m, exp) {
      return ' 的 ' + String(exp).trim() + ' 次方';
    });
    /* 3b. 指数是单个字母：有上标字形就上标，没有就中文 */
    s = s.replace(/\^([A-Za-z])(?![A-Za-z0-9])/g, function (m, ch) {
      return SUP_LETTER[ch] || (' 的 ' + ch + ' 次方');
    });
    /* 1/2. 指数是数字串 */
    s = s.replace(/([A-Za-z0-9.)\]\u4e00-\u9fa5])\^([0-9]+)/g, function (m, base, exp) {
      /* 数值乘方 + 多位指数：2^10 保留原样（规则 2，见文件头）；其余逐位上标 */
      if (exp.length > 1 && /[0-9.]/.test(base)) return m;
      return base + supDigits(exp);
    });
    return s;
  }

  /**
   * LaTeX 残留转纯文本：\frac{a}{b} -> (a)/(b)、\sqrt{x} -> √x、\sqrt[n]{x} -> n 次根号 x、
   * \pm -> ±，$...$ 定界符剥掉，^ 幂写法收口（见 powers）。
   * 防模型不听话（prompt 已禁 LaTeX，这里是展示层兜底）。
   * @param {string} text
   * @returns {string}
   */
  function cleanLatex(text) {
    var s = (text === null || text === undefined) ? '' : String(text);
    /* $...$ / $$...$$ 数学模式定界符：只剥符号，不碰内容（题库 13335 道里 0 个 $） */
    s = s.replace(/\$/g, '');
    /* 先处理分式（嵌套在最外层，先转 \frac{a}{b} -> (a)/(b)） */
    var prev = '';
    while (prev !== s) {
      prev = s;
      s = s.replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '($1)/($2)');
    }
    /* 再处理根式：\sqrt[n]{x} -> n 次根号 x、\sqrt{x} -> √x */
    s = s.replace(/\\sqrt\s*\[([^\]]*)\]\s*\{([^{}]*)\}/g, function (m, n, x) {
      return String(n).trim() + ' 次根号 ' + x;
    }).replace(/\\sqrt\s*\{([^{}]*)\}/g, '√$1');
    /* 其余常见命令：\pm ±、\times ×、\cdot ·、\div ÷、\le ≤、\ge ≥、\neq ≠、\approx ≈、\infty ∞、\pi π
     * 注意不能只用 \b（\pm5 中 pm 后是数字 5，仍是单词字符，\b 不成立）；用 (?![a-zA-Z]) 兜住 */
    s = s.replace(/\\(pm|times|cdot|div|le|ge|neq|approx|infty|pi)(?![a-zA-Z])/g, function (m, name) {
      return CMD[name];
    });
    /* 其余未知反斜杠命令直接剥掉反斜杠（\alpha -> alpha，\x -> x） */
    s = s.replace(/\\([a-zA-Z]+)/g, '$1');
    /* 去掉裸花括号（\sqrt 等的残留 { }） */
    s = s.replace(/[{}]/g, '');
    /* 幂收口放在剥花括号之后：x^{2} 此时才变成 x^2 */
    s = powers(s);
    return s;
  }

  /**
   * 模型输出的唯一清洗出口：LaTeX 残留 + Markdown 标记 + 幂写法。
   * 孩子看不懂 ** / ` / # 这些标记，展示层必须兜底剥掉：
   *   **xxx** / *xxx* -> xxx；`xxx` -> xxx；行首 #、> 剥掉；行首列表符剥掉。
   * @param {string} text
   * @returns {string}
   */
  function normalize(text) {
    /* 不用 text || ''：0 / false 是合法输入（题面里的数字），不能被当成空串吃掉 */
    return cleanLatex((text === null || text === undefined) ? '' : String(text))
      .replace(/\*\*([^*]*)\*\*/g, '$1')   // **加粗** -> 加粗
      .replace(/\*([^*]*)\*/g, '$1')        // *斜体* -> 斜体
      .replace(/`([^`]*)`/g, '$1')          // `代码` -> 代码
      .replace(/^[#>]+\s*/gm, '')           // 行首 # / >
      .replace(/^[-*+]\s+/gm, '')           // 行首列表符
      .trim();
  }

  /* 兼容旧名：explain.js 历史上调用的是 cleanMarkdown，两者必须是同一个函数对象
   * （tests/test_textfmt.js 断言 CnmTextFmt.cleanMarkdown === CnmTextFmt.normalize）。 */
  var cleanMarkdown = normalize;

  return {
    normalize: normalize,
    cleanMarkdown: cleanMarkdown,
    cleanLatex: cleanLatex,
    powers: powers,
    supDigits: supDigits,
    SUP_DIGIT: SUP_DIGIT
  };
});
