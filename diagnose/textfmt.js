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

  /* ============================================================================
   * 卡 t_dc7163ea：受控微型标记 → 真排版（分式上下堆叠 / 根号上划线 / 真上标）
   *
   * 只认 normalize() 今天已经认的那几种写法，一个不多：\frac{a}{b}、\sqrt{x}、\sqrt[n]{x}、
   * ^n / ^{n}、**粗体**、行首 "- "、Unicode 上标 ²³。prompt 已禁模型写 LaTeX，多认一种语法
   * 就是多一种失败面；认不出来的一律当普通字符走（不抛异常、不吞后文）。标题 / 表格 /
   * 链接 / $$ 块 / \sum 之类一概不做（卡面裁定 1）。
   *
   * 安全：render() 只用 createElement / createTextNode / textContent 造树，全流程没有
   * HTML 解析环节 —— 没有解析就没有 XSS 面，因此不需要任何 sanitizer（卡面裁定 2）。
   *
   * 无损：每个片段都存它吃掉的原文 src，所以 rawText(segments(x)) 逐字还原 x（首尾空白除外），
   * flatten(segments(x)) 因此恒等于 normalize(x)。normalize() 本身一个字节没动。
   * ============================================================================ */

  /* Unicode 上标 → ASCII：x² 上屏成 <sup>2</sup>（上标字形由标签给，不再靠字符堆） */
  var SUP_ASCII = {
    '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4',
    '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', 'ⁿ': 'n', 'ⁱ': 'i'
  };
  /* 幂底数字符类：与 powers() 里 ([A-Za-z0-9.)\]\u4e00-\u9fa5]) 完全一致（判「^ 前面有没有底数」） */
  var POWER_BASE = /[A-Za-z0-9.)\]\u4e00-\u9fa5]/;
  /* 嵌套上限：讲题文本不会有几十层嵌套；超了就当纯文本，避免畸形输入把调用栈打爆 */
  var MAX_DEPTH = 24;

  function asText(text) { return (text === null || text === undefined) ? '' : String(text); }

  function isWs(c) { return c !== '' && /\s/.test(c); }

  /**
   * 读一个配平的 {…}（允许前导空白，对应 cleanLatex 里的 \s*\{）。
   * @returns {{inner: string, end: number}|null} end 指向 '}' 之后；不配平返回 null
   */
  function readGroup(s, i) {
    var j = i;
    while (j < s.length && isWs(s.charAt(j))) j++;
    if (s.charAt(j) !== '{') return null;
    var depth = 0;
    for (var k = j; k < s.length; k++) {
      var ch = s.charAt(k);
      if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) return { inner: s.slice(j + 1, k), end: k + 1 };
    }
    return null;
  }

  /* 文本片段上屏用的清洗：规则与 normalize() 逐条相同，只差两点 ——
   *   (a) 不 trim 首尾（片段中间的空白是词边界，吞掉会把字粘在一起）；
   *   (b) 片段若不在真行首，首行不许剥行首标记（那不是行首，剥了就是改了原文）。
   * ⚠ 改 normalize() 的规则时这里必须同步（tests/test_textfmt_markup.js 有「纯文本渲染结果
   *   必须等于 normalize」的漂移断言，漏改会红）。 */
  function cleanRun(raw, atLineStart) {
    var s = cleanLatex(raw)
      .replace(/\*\*([^*]*)\*\*/g, '$1')
      .replace(/\*([^*]*)\*/g, '$1')
      .replace(/`([^`]*)`/g, '$1');
    if (atLineStart) return s.replace(/^[#>]+\s*/gm, '').replace(/^[-*+]\s+/gm, '');
    var nl = s.indexOf('\n');
    if (nl < 0) return s;
    return s.slice(0, nl) + s.slice(nl).replace(/^[#>]+\s*/gm, '').replace(/^[-*+]\s+/gm, '');
  }

  /** 上标片段在 normalize() 视角下的字符（判「下一个 ^ 还有没有底数」用） */
  function supUni(v) {
    var out = '';
    for (var i = 0; i < v.length; i++) out += (SUP_DIGIT[v.charAt(i)] || SUP_LETTER[v.charAt(i)] || v.charAt(i));
    return out;
  }

  /** 片段上屏正文（只用于取「上一个可见字符」） */
  function runText(seg) {
    return seg.d != null ? seg.d : cleanRun(seg.src, seg.ls);
  }

  function tailOf(seg) {
    var v;
    if (seg.t === 'text') v = runText(seg);
    else if (seg.t === 'sup') v = supUni(seg.v);          // normalize 输出的是 Unicode 上标
    else if (seg.t === 'frac') v = '()/()';               // normalize 视角：\frac{a}{b} -> (a)/(b)
    else if (seg.t === 'sqrt') v = '√' + tailOfSeq(seg.rad);
    else v = tailOfSeq(seg.c);                            // b / li
    return v ? v.charAt(v.length - 1) : '';
  }

  function tailOfSeq(segs) {
    for (var i = segs.length - 1; i >= 0; i--) {
      var t = tailOf(segs[i]);
      if (t) return t;
    }
    return '';
  }

  /**
   * 读一处 **粗体**：内容里不许再出现 *（与 normalize 的 \*\*([^*]*)\*\* 一致）。
   * @returns {{seg: object, end: number}|null}
   */
  function readBold(s, i, depth) {
    if (s.charAt(i + 1) !== '*') return null;
    var close = s.indexOf('**', i + 2);
    if (close < 0) return null;
    var inner = s.slice(i + 2, close);
    if (inner.indexOf('*') >= 0) return null;
    return { end: close + 2, seg: { t: 'b', src: s.slice(i, close + 2), c: parse(inner, depth + 1) } };
  }

  /** 行首列表项 "- xxx"（对应 normalize 的 ^[-*+]\s+）：吃到行尾，换行一并吃掉 ——
   *  换行留在片段外会把它切成两个 ul，列表就断了。 */
  function readItem(s, i, depth) {
    var m = /^([-*+])(\s+)/.exec(s.slice(i));
    if (!m) return null;
    var bodyStart = i + m[0].length;
    var nl = s.indexOf('\n', bodyStart);
    var bodyEnd = nl < 0 ? s.length : nl;
    return {
      end: nl < 0 ? s.length : nl + 1,
      seg: { t: 'li', src: s.slice(i, nl < 0 ? s.length : nl + 1), c: parse(s.slice(bodyStart, bodyEnd), depth + 1) }
    };
  }

  /** \frac{a}{b}：分子分母都非空才认（\frac{}{} 按普通字符走）；允许嵌套（\frac{\frac{1}{2}}{3}） */
  function readFrac(s, i, depth) {
    if (s.substr(i, 5) !== '\\frac') return null;
    var a = readGroup(s, i + 5);
    if (!a) return null;
    var b = readGroup(s, a.end);
    if (!b) return null;
    if (!a.inner || !b.inner) return null;
    return {
      end: b.end,
      seg: {
        t: 'frac', src: s.slice(i, b.end),
        num: parse(a.inner, depth + 1), den: parse(b.inner, depth + 1)
      }
    };
  }

  /** \sqrt{x} / \sqrt[n]{x}：根号内必须非空，否则按普通字符走 */
  function readSqrt(s, i, depth) {
    if (s.substr(i, 5) !== '\\sqrt') return null;
    var j = i + 5;
    while (j < s.length && isWs(s.charAt(j))) j++;
    var idx = null;
    if (s.charAt(j) === '[') {
      var rb = s.indexOf(']', j + 1);
      if (rb < 0) return null;
      idx = s.slice(j + 1, rb);
      if (!idx) return null;                 // \sqrt[]{x}：空根指数按普通字符走
      j = rb + 1;
    }
    var g = readGroup(s, j);
    if (!g || !g.inner) return null;
    return {
      end: g.end,
      seg: {
        t: 'sqrt', src: s.slice(i, g.end),
        idx: idx ? parse(idx, depth + 1) : null, rad: parse(g.inner, depth + 1)
      }
    };
  }

  /**
   * 读一处 ^ 幂，判定顺序与 powers() 的三条规则一一对应。
   * 不该当幂处理（没底数 / 数值底数多位指数 / ^{n+1} 之类）返回 null，由调用方当普通字符走。
   * @returns {{seg: object, end: number}|null}
   */
  function readPower(s, i, prev) {
    /* 规则 3a：x^(n+1) -> x 的 n+1 次方（括号形式，无底数要求，与 powers 一致）。
     * 括号里的幂还要再收口一遍：normalize 是「括号换掉后再让 powers 扫全文」，
     * 所以 x^(m^2-3) 会得到「 的 m²-3 次方」，这里必须同款（花括号已先被 normalise 剥掉）。 */
    var m = /^\^\(([^()]*)\)/.exec(s.slice(i));
    if (m) {
      var exp = m[1].replace(/[{}]/g, '').trim();
      return {
        end: i + m[0].length,
        seg: { t: 'text', src: m[0], ls: false, d: powers(' 的 ' + exp + ' 次方') }
      };
    }
    var body, end;
    var g = readGroup(s, i + 1);
    if (g) {
      body = g.inner;
      end = g.end;
    } else {
      var m2 = /^\^([0-9]+|[A-Za-z])/.exec(s.slice(i));
      if (!m2) return null;
      body = m2[1];
      end = i + m2[0].length;
    }
    /* 花括号剥掉后紧跟的字符：字母指数的 (?![A-Za-z0-9]) 要看它 */
    var next = s.charAt(end);
    if (/^[0-9]+$/.test(body)) {
      if (!prev || !POWER_BASE.test(prev)) return null;              // 没有底数：保留 ^ 原样
      if (body.length > 1 && /[0-9.]/.test(prev)) return null;       // 数值底数 + 多位指数：科学记数法，保留原样
      return { end: end, seg: { t: 'sup', src: s.slice(i, end), v: body } };
    }
    if (/^[A-Za-z]$/.test(body) && !/[A-Za-z0-9]/.test(next)) {
      if (SUP_LETTER[body]) return { end: end, seg: { t: 'sup', src: s.slice(i, end), v: body } };
      return { end: end, seg: { t: 'text', src: s.slice(i, end), ls: false, d: ' 的 ' + body + ' 次方' } };
    }
    return null;   // ^{n+1} 之类：不认，按普通字符走（花括号由 cleanRun 剥掉，与 normalize 同款）
  }

  /** 连续的 Unicode 上标并成一个 sup 片段（x²³ -> x + sup 23） */
  function readUniSup(s, i) {
    var u = '';
    while (i + u.length < s.length && SUP_ASCII[s.charAt(i + u.length)]) u += s.charAt(i + u.length);
    var v = '';
    for (var k = 0; k < u.length; k++) v += SUP_ASCII[u.charAt(k)];
    return { end: i + u.length, seg: { t: 'sup', src: u, v: v } };
  }

  /**
   * 行内解析：把原文切成受控片段树（纯数据，零 DOM）。
   * 每个片段 src = 它吃掉的原文切片，所以「无损」是结构性保证，不靠事后拼凑。
   * @param {string} s
   * @param {number} depth
   * @returns {Array}
   */
  function parse(s, depth) {
    var out = [];
    var buf = '';
    var bufStart = 0;
    var prev = '';            // normalize() 视角下上一个可见字符（判幂的底数用）
    var i = 0;

    function lineStartAt(pos) { return pos === 0 || s.charAt(pos - 1) === '\n'; }

    function flush() {
      if (!buf) return;
      out.push({ t: 'text', src: buf, ls: lineStartAt(bufStart) });
      prev = tailOf(out[out.length - 1]) || prev;
      buf = '';
    }

    while (i < s.length) {
      var c = s.charAt(i);
      var got = null;
      if (depth < MAX_DEPTH) {
        if (c === '*') {
          got = readBold(s, i, depth);
          if (!got && lineStartAt(i) && isWs(s.charAt(i + 1))) got = readItem(s, i, depth);
        } else if (c === '\\') {
          got = readFrac(s, i, depth) || readSqrt(s, i, depth);
        } else if (c === '^') {
          /* 底数可能还在缓冲区里，先冲出去再问「上一个可见字符」 */
          flush();
          got = readPower(s, i, prev);
        } else if (SUP_ASCII[c]) {
          got = readUniSup(s, i);
        } else if (lineStartAt(i) && /[-+]/.test(c) && isWs(s.charAt(i + 1))) {
          got = readItem(s, i, depth);
        }
      }
      if (got) {
        flush();
        out.push(got.seg);
        prev = tailOf(got.seg) || prev;
        i = got.end;
        continue;
      }
      if (!buf) bufStart = i;
      buf += c;
      i++;
    }
    flush();
    return out;
  }

  /**
   * 文本 → 受控片段树（纯数据，零 DOM）。
   * 首尾空白先去掉（normalize 最后一步是 trim，这里同一口径）。
   * @param {string} text
   * @returns {Array}
   */
  function segments(text) {
    var s = asText(text).replace(/^\s+/, '').replace(/\s+$/, '');
    return s ? parse(s, 0) : [];
  }

  /** 片段树 → 原文（每个片段都带着自己吃掉的原文切片） */
  function rawText(segs) {
    var out = '';
    for (var i = 0; i < (segs || []).length; i++) out += segs[i].src;
    return out;
  }

  /** 无损探针：片段树还原成原文再走 normalize，必须恒等于 normalize(原文) */
  function flatten(segs) {
    return normalize(rawText(segs));
  }

  /* ---------------------------- 渲染：只造节点，不拼 HTML ---------------------------- */

  function make(doc, tag, cls) {
    var node = doc.createElement(tag);
    if (cls) node.className = cls;
    return node;
  }

  function addAll(parent, nodes) {
    for (var i = 0; i < nodes.length; i++) parent.appendChild(nodes[i]);
    return parent;
  }

  /** 片段树 → 节点数组（先造完再挂，中途出错不会留下半截 DOM） */
  function build(doc, segs) {
    var out = [];
    var i = 0;
    while (i < segs.length) {
      var seg = segs[i];
      if (seg.t === 'li') {
        /* 连续的列表项并进一个 ul.tf-list（列表语义只在这里出现） */
        var ul = make(doc, 'ul', 'tf-list');
        while (i < segs.length && segs[i].t === 'li') {
          var li = make(doc, 'li');
          addAll(li, build(doc, segs[i].c));
          ul.appendChild(li);
          i++;
        }
        out.push(ul);
        continue;
      }
      if (seg.t === 'text') {
        out.push(doc.createTextNode(runText(seg)));
      } else if (seg.t === 'sup') {
        var sup = make(doc, 'sup');
        sup.textContent = seg.v;
        out.push(sup);
      } else if (seg.t === 'b') {
        var b = make(doc, 'b', 'tf-b');
        addAll(b, build(doc, seg.c));
        out.push(b);
      } else if (seg.t === 'frac') {
        var frac = make(doc, 'span', 'tf-frac');
        var num = make(doc, 'span', 'tf-num');
        var den = make(doc, 'span', 'tf-den');
        addAll(num, build(doc, seg.num));
        addAll(den, build(doc, seg.den));
        frac.appendChild(num);
        frac.appendChild(den);
        out.push(frac);
      } else if (seg.t === 'sqrt') {
        var sqrt = make(doc, 'span', 'tf-sqrt');
        if (seg.idx) {
          var ridx = make(doc, 'span', 'tf-root-index');
          addAll(ridx, build(doc, seg.idx));
          sqrt.appendChild(ridx);
        }
        var rad = make(doc, 'span', 'tf-radicand');
        addAll(rad, build(doc, seg.rad));
        sqrt.appendChild(rad);
        out.push(sqrt);
      }
      /* 不可达：segments() 只产出上面几种；真出现就跳过（fail-closed，不抛错） */
      i++;
    }
    return out;
  }

  /**
   * 上屏出口：把受控微型标记渲染进 el（追加，不清 el 既有子节点）。
   * 只造节点不拼 HTML；任何异常都降级成一段纯文本 —— 上屏不许因为标记古怪而整块空掉。
   * @param {Element} el
   * @param {string} text
   * @returns {Element}
   */
  function render(el, text) {
    if (!el || typeof el.appendChild !== 'function') return el;
    var doc = el.ownerDocument;
    if (!doc || typeof doc.createElement !== 'function' || typeof doc.createTextNode !== 'function') {
      /* 没有 document（非 DOM 环境）：直接给纯文本 */
      if (typeof el.textContent === 'string') el.textContent += normalize(text);
      return el;
    }
    var nodes;
    try {
      nodes = build(doc, segments(text));
    } catch (e) {
      nodes = [doc.createTextNode(normalize(text))];
    }
    return addAll(el, nodes);
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
    /* 卡 t_dc7163ea：上屏专用的第二个出口（normalize 的字节输出不受影响） */
    segments: segments,
    render: render,
    flatten: flatten,
    SUP_DIGIT: SUP_DIGIT
  };
});
