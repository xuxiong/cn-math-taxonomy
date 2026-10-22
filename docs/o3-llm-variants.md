# O3-1 设计：LLM 变式出题（试点 cnm_221 表达式族）

状态：设计定稿（2026-10-22）｜对应 docs/phase1-plan.md §7 O3 新方向｜本卡只产文档，不实现

---

## 0. 结论摘要（一屏看完）

O1 的 `variants.js` 用根空间反推解决了**一元一次方程**（cnm_043）的无限变式——四个模板、
整数运算、零依赖。但它的方法**不可推广**到二次方程、配方、因式分解等"表达式族"知识点：
这些知识点的题目结构不是 `Ax+B=Cx+D`，没有通用的反推公式，手写模板的成本等于重写一个
符号引擎。

本设计用 **LLM 产候选 → 引擎验证门 → 校不过丢弃重试** 的管线，把"族设计"降为
"prompt 模板 + 验证函数"。试点选 cnm_221（配方法）：答案是代数表达式（如 `2±√5`），
正是 O1 确定性引擎（仅方程族）的缺口。LLM 正确率 90% 无妨——验证后学生看到 100% 对的题。

| # | 决策 | 内容 |
|---|------|------|
| D1 | 落点 | 新增 `diagnose/llm-variants.js`（UMD），与 `variants.js` 并存；不替换、不修改 variants.js |
| D2 | 试点族 | cnm_221（配方法），答案=代数表达式；后续可扩 cnm_222（公式法）、cnm_224（因式分解） |
| D3 | 管线 | LLM 产 1 道候选 → 验证门校验 → 不过则重试（限 3 次）→ 3 次全不过返回 null（降级现有题池） |
| D4 | 验证 | 方程类：代入求值（随机抽 3-5 个 x 值，题面 vs 答案数值全等才放行）；非方程类：结构校验（见 §3.2） |
| D5 | 缓存池 | localStorage `cnmDiagnose.llmVariants.v1`，seed 派生题 id，同 seed 命中缓存 |
| D6 | 离线降级 | 网关不在线 → 自动降级现有题池（cnm_221 现状行为不变，零风险） |
| D7 | 共存 | 与 variants.js（O1）并存：fillPractice 优先题库 → O1 确定性变式 → O3 LLM 变式 → 题库复用兜底 |
| D8 | 零依赖 | 不引入 sympy/pyodide/任何构建期步骤；纯前端 JS + 本地网关 |
| D9 | 边界 | choice 题不喂 LLM（干扰项需教学判断）；prompt 注入防护：题目文本不入 prompt，只入数学结构 |
| D10 | 工具自验 | LLM 生成时可用工具自验（evaluateExpression / solveCheck / normalizeSet，§2.4），提高一次通过率（效率层）；引擎验证门保留为最终硬保证（正确性层），两层不互相替代 |
| D11 | 验证门按形态三档 | 数值/表达式→数值验证（硬）；集合/分类→集合验证（硬，normalizeSet）；自然语言→LLM 评判+降级自评（软）。取代早期"self 只评判不出题验证"的粗分法（§9.5） |

一句话取舍：**LLM 只管"出题面"，引擎管"验对错"**——LLM 算错不要紧，验证门拦住就不让学生看到错题。
补充取舍：**工具自验是效率，不是正确性**——LLM 可能不调用、误读结果、喂错参数，验证门永远兜底。

---

## 1. 背景与动机

### 1.1 O1 的边界

O1 `variants.js` 的核心是：每个模板展开后都是 `A·x + B = C·x + D`（整数系数），先定根 r 再
反推常数项。这四个模板（T1-T4）只覆盖**含括号的一元一次方程**（cnm_043）。

要扩到 cnm_221（配方法），题目结构变成 `x² + bx + c = 0 → (x + b/2)² = n`，需要：
- 二次方程的求根（判别式、根式化简）
- 配方步骤的文本生成
- 系数约束（判别式 ≥ 0、根式可化简）

每多一个知识点就要手写一组模板 + 反推公式 + 解析文本——等于为每个知识点写一个微型符号引擎。
方程族=533 行（variants.js），族多了成本线性增长。

### 1.2 为什么选 LLM 出题

sympy 构建期方案已评估弃用（无后端、wasm 太重、构建期改造大）。用户拍板：**LLM 设计题目**。

LLM 出题的优势：
- 一个 prompt 模板可以覆盖一个"表达式族"（配方法、公式法、因式分解……），不需要逐族写模板。
- LLM 擅长生成自然语言题面和分步解析，质量比模板拼接更自然。

LLM 出题的风险：
- **数值不可靠**：LLM 可能算错答案（如配方加错数、判别式算错）。
- **不可复现**：同一 prompt 两次调用可能得到不同的题。
- **离线不可用**：网关不在线时无法生成。

本设计用**验证门 + 缓存池 + 离线降级**三道防线消解这三个风险。

### 1.3 为什么选 cnm_221 作试点

cnm_221（配方法）现有 4 道题：

| id | type | difficulty | prompt 摘要 | answer |
|----|------|-----------|------------|--------|
| q1 | choice | standard | 配方选择题 | C |
| q2 | numeric | basic | 配方加常数 | 9 |
| q3 | numeric | standard | 解方程 x²+6x-7=0 | 1，-7 |
| q4 | numeric | advanced | 二次项系数≠1配方 m,n | 2，7 |

答案=代数表达式（`2±√5`、`1，-7`、`2，7`），正是 O1 确定性引擎（仅方程族、整数系数）的缺口。
cnm_221 也是"表达式族"的典型代表——配方法、公式法、因式分解共享"二次方程 + 根式/有理数解"的
结构，试点成功后可以复用 prompt 模板扩到整族。

### 1.4 不做（明确边界）

| 不做 | 理由 |
|------|------|
| 替换 variants.js | O1 确定性引擎已上线、零依赖、已测试；LLM 变式是补充不是替代 |
| 诊断路径用 LLM 变式 | 诊断结论要与题库口径可比、可复现；LLM 变式只用于练习 |
| choice 题的 LLM 变式 | 高质量干扰项需要教学判断，LLM 造的干扰项不可信（同 O1 §1.2 的理由） |
| 自建符号引擎 | sympy/pyodide 太重；mathjs/nerdamer 对根式化简不可靠；验证用数值代入即可 |
| 预生成整池 | LLM 调用有成本（时间 + 网关负载）；按需生成 + 缓存即可 |
| LLM 变式落盘进 data/ | 同 O1：题库是"有复核记录的资产"，LLM 变式不是；落盘会污染统计与 validate.py |

---

## 2. 核心架构

### 2.1 管线总览

```
进入知识点（练习模式）
  ↓
fillPractice（共存策略，§6）
  ↓ 题库新鲜题 → O1 确定性变式 → [缺口] → O3 LLM 变式 → 题库复用兜底
  ↓
需要 LLM 变式时：
  ↓
1. 查缓存池（localStorage）——命中则直接返回（零延迟）
  ↓ 未命中
2. 调 LLM 生成 1 道候选题（prompt 模板，§4）
  ↓
3. 验证门校验（§3）——方程类代入求值，非方程类结构校验
  ↓ 通过                         ↓ 不通过
4. 写入缓存池，返回题对象         丢弃，重试（限 3 次）
                                 ↓ 3 次全不过
                                 返回 null（fillPractice 降级到题库复用）
```

### 2.2 验证门（核心防线）

验证门是 LLM 变式的**唯一质量保证**。LLM 正确率 90% 无妨，验证后学生看到 100% 对的题。

#### 方程类（如 q3: "用配方法解 x²+6x-7=0"）

**随机抽 3-5 个 x 值代入求值，题目 vs 答案数值全等才放行。**

具体流程：
1. 从 LLM 返回的题对象中提取 `prompt`（题面方程）和 `answer`（答案）。
2. 解析题面方程为 `lhs(x) = rhs(x)` 的函数形式。
3. 解析答案为根的集合 `{r1, r2, ...}`。
4. 随机抽 3-5 个测试点 `x_i`（不在根集合里）：
   - 计算 `lhs(x_i)` 和 `rhs(x_i)`，验证 `|lhs(x_i) - rhs(x_i)| < 1e-9`（方程成立是题面定义）。
   - **实际上更直接**：把每个答案根 `r_j` 代入方程，验证 `|lhs(r_j) - rhs(r_j)| < 1e-9`（根确实满足方程）。
   - 如果答案有多个根（如 `1，-7`），每个都要验证。
5. 全部通过 → 放行；任一不过 → 丢弃。

> 为什么是"代入根验证"而不是"代入随机 x 验证方程成立"：
> 方程 `x²+6x-7=0` 对任意 x 都"成立"（它是等式定义），我们需要验证的是**答案根确实满足方程**，
> 即 `r_j² + 6·r_j - 7 = 0`。这才是"答案对不对"的判据。

**数值容差**：参考 `judgeAnswer` 的归一逻辑和 `verifyReveal` 的 `1e-9` 容差。根式答案（如 `2±√5`）
需要先解析为数值再比较：`2+√5 ≈ 4.236`、`2-√5 ≈ -0.236`，代入 `x²-4x-1` 验证 ≈ 0。

#### 非方程类（如 q2: "配方加常数"、q4: "配方 m,n"）

这类题的答案不是方程的根，而是中间量（"需要加的常数"、"配方后的 m 和 n"）。验证策略：

- **q2 型**（"需要加上的常数是多少"）：答案是 `(b/2)²`，其中 b 是一次项系数。从题面解析出 b，
  计算 `(b/2)²`，与答案比较。
- **q4 型**（"依次求 m 与 n"）：答案是配方后的参数。从题面解析出二次项系数 a、一次项系数 b，
  验证 `m = b/(2a)` 且 `n = am² + c`（c 是常数项）。

这些验证函数是**按题型手写的纯函数**（每个约 10-20 行），不需要通用符号引擎。
试点只覆盖 cnm_221 的三种 numeric 题型，不需要泛化。

#### 多解处理

- 答案为多个值（如 `1，-7`）：每个值独立验证，全部满足方程才放行。
- 答案含 `±`（如 `2±√5`）：展开为两个值 `2+√5` 和 `2-√5`，各自验证。
- 参考 `verifyReveal` 的 `referenceParts` + `expandPlusMinus` 逻辑，可以复用 engine.js 的解析工具。

### 2.3 为什么验证门够用

验证门校验的是"答案根是否满足题面方程"——这是数学上的**充分条件**：
- 如果根满足方程，那么这题的答案是对的（可能不是唯一解，但一元二次方程最多两个根，全覆盖了）。
- 如果根不满足方程，那么答案一定错了。

验证门**不校验**：
- 题面是否"好"（难度是否合适、表述是否规范）——这些靠 prompt 模板约束 + LLM 的语言能力。
- 解析步骤是否正确——解析在练习模式只作参考，不参与判分；讲解走 O2 的 verifyReveal 校验。
- 是否撞题——靠 `avoidPrompts` 去重（同 O1 §5.5）。

这种"验数值不验语义"的策略与 edulab 的"kernel 答案 == 答案卡"思路一致：**只保证数值正确，
语义质量交给 prompt 模板和 LLM**。

### 2.4 工具自验（效率层，不替代验证门）

**决策**：给 LLM 提供验证工具，让它生成时**自己先验一遍**。定位是减压不是替代——

| 层 | 职责 | 保证 |
|----|------|------|
| 工具自验（效率层） | 生成时自查，一次通过率 90%→98%，减少重试、加速缓存池填充 | 软（LLM 可能不调用/误读结果/喂错参数） |
| 引擎验证门（正确性层） | 最终把关，不删不改 | 硬（确定性判据） |

**工具集（3 个）**：

| 工具 | 签名 | 用途 |
|------|------|------|
| evaluateExpression | `(expr, xValues) -> number[]` | 数值求值，展开题抽样验证（题目 vs 答案代入 3-5 个 x 对比） |
| solveCheck | `(equation, candidate) -> bool` | 代入验根，方程题 |
| normalizeSet | `(answers) -> Set` | 集合归一并比较，分类题（如按正数/0/负数分组） |

**调用时机**：
- 出题场景：LLM 在写答案前自查（evaluateExpression 展开验证 / solveCheck 验根）。
- 判题场景：热路径不强制工具循环（每轮 LLM 往返 +1-3s）；评判默认单轮，低置信才二次调用。

**前提与回退**：网关模型需支持 function calling（OpenAI 兼容 `tools` 参数，litellm 转发）。不支持则
回退"引擎外部验证"，不阻塞主路径。**求值实现遵守 §3.3（自用场景定稿：白名单+new Function，无字母硬门槛）。**

---

## 3. 验证函数设计

### 3.1 方程类验证：`verifyEquationRoots(prompt, answer)`

```js
// 返回 { ok: true|false, reason }
// true  —— 答案的每个根都满足题面方程
// false —— 至少一个根不满足
function verifyEquationRoots(prompt, answer) {
  // 1. 从 prompt 解析出方程 lhs = rhs
  //    如 "用配方法解 x²+6x-7=0" → lhs = "x²+6x-7", rhs = "0"
  //    如 "解方程 x²-4x-1=0" → lhs = "x²-4x-1", rhs = "0"
  // 2. 从 answer 解析出根集合
  //    如 "1，-7" → [1, -7]
  //    如 "2±√5" → [2+Math.sqrt(5), 2-Math.sqrt(5)]
  //    如 "2，7" → [2, 7]（非方程根，是 m,n 值，走 §3.2）
  // 3. 对每个根 r，计算 |evalLhs(r) - evalRhs(r)| < 1e-9
  // 4. 全过 → ok:true；任一不过 → ok:false
}
```

**方程解析**：从题面中提取 `=` 两侧的表达式。中文题面有前缀（"用配方法解"、"解方程"），
用正则 `/([^\s]+=.*)$/` 或更精确的 `/([a-z]²?[^\s]*=\s*-?\d+)/` 提取方程部分。

**表达式求值**：用 `Function('x', 'return ' + expr)` 在受控环境求值。安全考量见 §3.3。

### 3.2 非方程类验证：按题型手写

| 题型 | 验证函数 | 逻辑 |
|------|---------|------|
| 配方加常数（q2 型） | `verifyCompletingSquare(prompt, answer)` | 从题面提取一次项系数 b，验证 `answer == (b/2)²` |
| 配方 m,n（q4 型） | `verifyFormParam(prompt, answer)` | 从题面提取 a, b, c，验证 `m == b/(2a)` 且 `n == a·(b/(2a))² + c`（或等价的配方后形式） |

这些函数约 10-20 行 each，是纯函数，可直接单测。

### 3.3 表达式求值的安全考量（自用场景定稿）

验证需要把如 `x²+6x-7` 的表达式在 `x=r` 处求值。**威胁模型定稿（用户拍板）**：本项目为
**自用工具，不对外**（无陌生访问、无敏感数据、无后端）；输入源仅自身 LLM 网关输出（且
"题目文本不入 prompt"已挡最大注入面）。在此场景下白名单 + `new Function` 为正式方案。

**方案（定稿）**：白名单过滤 + `new Function('x', 'return ' + expr)` 执行。

**唯一硬门槛（约 10 行，不可省）**：
- 执行前确认过滤后字符串只含白名单字符（`[0-9x+\-*/().^ ]`；`²`→`**2`、`√`→`Math.sqrt` 为受控转换），
  且**不含任何字母**（无 `Math`/`Function`/引号/分号等字样）才可执行；
- 先白名单后转换，转换产物不落地执行；
- 求值抛错一律视为校验失败丢弃——顺带防止 LLM 输出非表达式文本（解释文字）被丢进 Function 报错。

**可选优化（后续需要再做）**：手写受限求值器（~100 行 tokenize + 递归下降），结构上不执行
任意代码，可同时服务验证门与 `evaluateExpression` 工具（§2.4）。自用场景下是锦上添花，
不做不阻塞；**若未来站点对外公开，升级为求值器即可**。

~~mathjs~~：200KB 依赖，违反零新依赖原则（D8），弃用。

实现卡测试项保留：白名单绕过、嵌套括号、除零、幂优先级、`√` 负数等用例——防的是 LLM 乱
输出，不是防攻击者。

### 3.4 验证函数的导出

```js
// diagnose/llm-variants.js 导出
{
  verifyEquationRoots,      // 方程类
  verifyCompletingSquare,   // 配方加常数
  verifyFormParam,          // 配方 m,n
  validateLLMQuestion,      // 调度器：按 q.verifyType 路由到对应验证函数
}
```

`validateLLMQuestion(q)` 是验证门入口：读取题对象的 `verifyType` 字段，路由到对应验证函数。
`verifyType` 由 prompt 模板在生成时设定（见 §4.3）。

---

## 4. prompt 模板

### 4.1 设计原则

- **题型约束**：只生成 `type:'numeric'`（同 O1 D5）；不做 choice 变式。
- **难度三档**：基础/标准/进阶，对应 cnm_221 现有难度分布。
- **答案格式固定行**：参考 O2 explain.js 的 `systemPrompt` 经验——"答案：x = -3"这种固定格式
  降低 LLM 自信算错率。LLM 变式同样要求答案在固定行、用固定格式。
- **防口语化破题**：题目文本不入 prompt（只入数学结构），防 LLM 照抄原题；要求生成新的系数。
- **数学结构注入**：给 LLM 的是知识点的"结构描述"（如"配方法：x²+bx+c=0，配方后 (x+b/2)²=n"），
  不是某道具体题的文本。

### 4.2 systemPrompt

```
你是人教版初中数学出题老师。请按照要求出一道「配方法」练习题。

要求：
1. 题目必须是「用配方法解一元二次方程」或「配方相关」的数值题。
2. 系数必须是整数，判别式必须非负（保证有实数根）。
3. 答案如果是根式（如 2±√5），判别式不能是完全平方数。
4. 答案如果是有理数（如 1，-7），判别式必须是完全平方数。
5. 不要照抄任何已有题目，每次用不同的系数。

输出格式严格为 JSON，不要任何多余文字：
{"prompt":"题面文本","answer":"答案","explanation":"分步解析","verifyType":"equation|completeSquare|formParam","difficulty":"basic|standard|advanced"}
```

### 4.3 userPrompt（按难度分模板）

**基础（basic）**——对应 q2 型（配方加常数）：

```
出一道基础题：给定一个二次多项式 x²+bx，问"需要加上的常数是多少"。
答案格式：一个整数（即 (b/2)²）。
verifyType: "completeSquare"
难度: basic
```

**标准（standard）**——对应 q3 型（解方程）：

```
出一道标准题：用配方法解一个一元二次方程 x²+bx+c=0（b 为偶数，使配方干净）。
要求判别式为完全平方数（答案是有理数），两个根用逗号隔开。
答案格式：如 "1，-7"
verifyType: "equation"
难度: standard
```

**进阶（advanced）**——对应 q4 型或判别式非完全平方的解方程：

```
出一道进阶题，从以下两种中选一种：
A) 二次项系数≠1的配方：如 "把 2x²-8x+1=0 配方成 2(x-m)²=n，依次求 m 与 n"
   答案格式：如 "2，7"，verifyType: "formParam"
B) 判别式非完全平方的解方程：如 "用配方法解 x²-4x-1=0"
   答案格式：如 "2±√5"，verifyType: "equation"
难度: advanced
```

### 4.4 答案格式固定行（关键经验）

O2 explain.js 的教训：LLM 讲解 reveal 偶发算错，靠 verifyReveal 校验拦截。
LLM 变式同理——**答案必须在一个独立的 JSON 字段里**（不在 explanation 文本中埋），
这样验证函数可以直接取 `q.answer` 校验，不需要从自然语言文本中提取答案。

JSON 输出格式是第一道防线：
- `answer` 字段是纯数学表达式（`1，-7`、`2±√5`、`9`），不含解释文字。
- `explanation` 字段是分步解析，可以包含答案（解析末句会给答案），但验证不看 explanation。
- `verifyType` 字段告诉验证门用哪个验证函数。

### 4.5 防口语化破题 & prompt 注入防护

- **题目文本不入 prompt**：userPrompt 只描述数学结构（"x²+bx+c=0，b 为偶数"），不贴具体题目文本。
  这样 LLM 不会照抄题库原题。
- **要求换系数**：systemPrompt 明确"不要照抄任何已有题目，每次用不同的系数"。
- **avoidPrompts 注入**：在 userPrompt 中附加"不要出以下题面：[题库 prompts 列表]"——
  但这会把题库文本暴露给 LLM。替代方案：**生成后在客户端做撞题去重**（同 O1 §5.5 的 canon 比较），
  不把题库文本喂给 LLM。推荐后者。

### 4.6 LLM 调用参数

```js
{
  model: 'DeepSeek-V4-Flash-0731-Unlimited',  // 与 explain.js 同款
  messages: [
    { role: 'system', content: systemPrompt() },
    { role: 'user', content: userPrompt(difficulty) }
  ],
  max_tokens: 500,   // 出题不需要长文本
  temperature: 0.8   // 略高，鼓励多样性
}
```

网关地址：`http://127.0.0.1:3000/v1/chat/completions`（与 explain.js 同款，已支持 CORS）。

---

## 5. 池 schema 与缓存

### 5.1 localStorage 池

```
key: cnmDiagnose.llmVariants.v1
value: {
  "cnm_221": [
    {
      "id": "cnm_221_lv1",
      "topicId": "cnm_221",
      "difficulty": "standard",
      "type": "numeric",
      "prompt": "用配方法解 x²+8x+12=0。（两个根用逗号隔开）",
      "answer": "-2，-6",
      "explanation": "移项 x²+8x=-12，两边加 16 得 (x+4)²=4，x+4=±2，所以 x=-2 或 x=-6。",
      "verifyType": "equation",
      "verify": "roots2(1,8,12)",       // 参考 q.answer 的 verify 风格
      "variant": true,
      "variantSource": "llm",            // 区分 O1 确定性变式（"deterministic"）
      "variantIndex": 0,                 // 池内序号
      "seed": "cnm_221|s42",             // seed 派生（见 §5.2）
      "createdAt": 1792679671000         // 创建时间戳（缓存淘汰用）
    },
    ...
  ]
}
```

### 5.2 seed 派生题 id

- **seed 来源**：`topicId + '|s' + Date.now()` ——首次生成时确定，存入缓存后不变。
- **同 seed 命中缓存**：缓存 key 是 `topicId`，缓存内用 `variantIndex` 推进。
  同一个孩子第二次练同一知识点时，先读缓存池里已生成的题（零延迟），不够再调 LLM 补。
- **题 id**：`<topicId>_lv<index+1>`（如 `cnm_221_lv1`）。
  - `_lv` 前缀与题库 `_q<N>` 和 O1 变式 `_v<N>` 都不冲突。
  - engine 的 `qNum()`（`/_q(\d+)$/`）与 `questionById()`（`/^(.*)_q\d+$/`）不会误认。

### 5.3 字段与现有 q 对象对齐

LLM 变式题对象的字段与题库 q 对象语义一致，判题链（`judgeQuestion`）零改动即可处理：

| 字段 | LLM 变式生成规则 |
|------|-----------------|
| `id` | `cnm_221_lv<index+1>` |
| `topicId` | 入参 topicId |
| `difficulty` | LLM 按 prompt 模板设定（basic/standard/advanced） |
| `type` | 恒为 `'numeric'` |
| `prompt` | LLM 生成，经验证门放行 |
| `answer` | LLM 生成，经验证门校验数值正确 |
| `accept` | 暂不生成（配方法答案多为根式/多值，accept 语义复杂；判题链的 `judgeNumeric` 不依赖 accept 也能判对） |
| `verify` | 生成时附一条参考性 verify（如 `roots2(1,8,12)`），便于审计 |
| `explanation` | LLM 生成（分步解析） |
| `unordered` | 答案为多根时设 `true`（与题库 q3 一致） |
| `variant` | `true`（运行期标记，不落盘 data/） |
| `variantSource` | `'llm'`（区分 O1 的 `'deterministic'`） |
| `variantIndex` | 池内序号 |
| `seed` | 派生 seed |
| `verifyType` | `'equation'` / `'completeSquare'` / `'formParam'`（验证门路由用） |

### 5.4 缓存淘汰

- **无 TTL**：池里的题经过验证门校验，数值正确性有保证；不会过期。
- **上限**：每个 topicId 最多缓存 50 道题（足够练习场景；超出时 LIFO 淘汰最旧的）。
- **清理**：`hermes` 层面不做主动清理；用户清浏览器 localStorage 即清空（与现有 `variantSeq` 同款）。

### 5.5 池的读写时机

```
fillPractice 需要 LLM 变式时：
  1. 读缓存池 → 有足够的题 → 直接返回（零延迟）
  2. 缓存不够 → 缺口数调 LLM 逐道生成 → 每道过验证门 → 过的写入缓存池 → 返回
  3. LLM 不可用 / 3 次全不过 → 返回 null → fillPractice 降级题库复用
```

---

## 6. 接入点与共存策略

### 6.1 共存层级（扩展 O1 的 fillPractice）

O1 的 `fillPractice` 现有层级：
```
题库新鲜题 → O1 确定性变式（supports(topicId)） → 题库复用兜底
```

O3 扩展为四层：
```
题库新鲜题 → O1 确定性变式（supports(topicId)） → O3 LLM 变式 → 题库复用兜底
```

**关键设计**：O3 不修改 `variants.js` 的 `fillPractice`，而是新建 `llm-variants.js` 的
`fillPracticeLLM`，由 `app.js` 的 `startPractice` 编排：

```js
// app.js startPractice（伪代码，实现卡落地）
function startPractice(topicId) {
  var bankPicks = E.pickPracticeQuestions(D.graph, topicId, 3, seenList());
  var seqMap = variantSeqMap();
  var startIndex = seqMap[topicId] || 0;
  var bankPrompts = (D.graph.bank[topicId] || []).map(q => q.prompt);

  // 第一层：O1 确定性变式
  var fp = V.fillPractice(bankPicks, topicId, 3, {
    doneIds: seenList(),
    avoidPrompts: bankPrompts,
    startIndex: startIndex
  });

  // 第二层：O1 不够时，O3 LLM 变式补位
  if (fp.list.length < 3 && LLMV.supports(topicId)) {
    var llmGap = 3 - fp.list.length;
    LLMV.fillPracticeLLM(fp, topicId, llmGap, {
      doneIds: seenList(),
      avoidPrompts: bankPrompts.concat(fp.list.map(q => q.prompt))
    }).then(function(fp2) {
      // fp2.list 补齐到 3 道
      startPracticeRender(fp2);
    });
  } else {
    startPracticeRender(fp);
  }
}
```

**注意**：LLM 变式是**异步的**（需调网关），而 O1 的 `fillPractice` 是同步纯函数。
`fillPracticeLLM` 返回 Promise。这是 O3 与 O1 的根本差异——app.js 的 `startPractice`
需要处理异步。实现卡需改 `startPractice` 为 async（或加 loading 状态）。

### 6.2 与 O1/O2 不冲突的保证

| 功能 | O1（variants.js） | O2（explain.js + verifyReveal） | O3（llm-variants.js） |
|------|-------------------|-------------------------------|----------------------|
| 诊断路径 | 不参与 | 不参与 | 不参与 |
| 练习题源 | 确定性强式（cnm_043） | — | LLM 变式（cnm_221） |
| 讲解 | — | LLM 讲解 + verifyReveal 校验 | — |
| 依赖网关 | 否 | 是（离线降级静态） | 是（离线降级题库复用） |
| 落盘 data/ | 否 | 否 | 否 |
| 改 engine.js | 否 | 是（新增 verifyReveal） | 否 |
| 改 variants.js | — | 否 | 否（并存不修改） |
| 改 app.js | 是（接入 fillPractice） | 否 | 是（接入 fillPracticeLLM，async） |

**回归测试不破的保证**：
- O1 的 147 条测试（test_engine.js）不涉及 LLM 变式——`llm-variants.js` 是新模块，不改 engine.js
  和 variants.js，O1 测试面不变。
- O2 的 verifyReveal 在 engine.js 里——`llm-variants.js` 不导入 engine.js 的内部函数（验证函数自写），
  不影响 verifyReveal。
- 新增测试追加到 `tests/test_engine.js`（同 O1 惯例），只测验证函数（纯函数，同步），
  不测 LLM 调用（异步 + 依赖网关，不进单测）。

### 6.3 与"变式"tag/结果页统计的复用

O1-3 已在 `renderQuestion` 加了 `q.variant` → `变式` tag（app.js:656）。O3 的 LLM 变式
同样设 `variant: true`，**自动复用现有 tag 渲染**，不需要改 app.js 的渲染逻辑。

结果页统计（app.js 的 `pracResult`）已有 `usedVariants` 计数。O3 的 `fillPracticeLLM`
返回值也带 `usedVariants`（含 O1 + O3 的变式总数），app.js 把两段的 `usedVariants` 相加即可。
实现卡可选择在统计中区分 `usedDeterministic` 和 `usedLLM`，但这是可选增强，不影响功能。

---

## 7. 首题延迟策略

### 7.1 按需生成（推荐）

进入知识点时才调 LLM 生成，首题有 ~1-3 秒延迟（网关响应时间）。

- **UI 处理**：`startPractice` 改 async 后，加 loading 状态（"正在出题…"）。
- **缓存效应**：第一次进入有延迟，后续进入命中缓存零延迟。越用越快。

### 7.2 预生成预热（可选增强）

在知识点列表页空闲时，预生成 1-2 道 LLM 变式存入缓存池。进入时命中缓存。

- **触发**：页面 `requestIdleCallback` 或知识点列表渲染后。
- **限制**：只预生成缓存池 < 3 道的 topicId；避免大量并发 LLM 调用。
- **风险**：预生成的题可能"浪费"（孩子不练这个知识点）。但 LLM 调用成本极低（本地网关），
  浪费可接受。

**推荐**：试点阶段用按需生成（§7.1），不实现预热。预热是后续优化。

### 7.3 网关超时阈值

- **请求超时**：10 秒（`AbortController` + `setTimeout`）。
  - explain.js 现有代码没有显式超时（依赖 fetch 默认行为），O3 应加显式超时。
- **重试间隔**：不重试同一题的生成（验证门拦截的题直接丢弃，换一个 attempt 重抽参数再调 LLM）。
- **总时限**：3 次尝试 × 10 秒 = 最多 30 秒。超时后降级题库复用。
  - 实际上网关不可达时 fetch 会快速失败（连接拒绝），不需要等 30 秒。

---

## 8. 健康指标

### 8.1 校验失败率监控

每个 LLM 变式题对象在缓存池里附带 `verifyResult` 字段（`'pass'` / `'fail'` + 失败原因）。
但只缓存通过的题（不通过的丢弃），所以缓存池里全是 `'pass'`。

**统计方式**：在 `llm-variants.js` 模块内维护一个内存计数器（不落盘）：
```js
var stats = { attempts: 0, passed: 0, failed: 0, byReason: {} };
```
- 每次 LLM 返回候选题后 `attempts++`；验证通过 `passed++`；验证不过 `failed++` + `byReason[reason]++`。
- 可通过 `DiagLLVMVariants.getStats()` 读取（调试用，不进 UI）。

### 8.2 低质族标记

**校验失败率 > 30% 的知识点标记低质族，不放进练习**：

- 统计维度：按 `topicId` + `difficulty` 组合统计失败率。
- 阈值：`failed / attempts > 0.3` 且 `attempts >= 10`（样本量足够时才判）。
- 处置：该 (topicId, difficulty) 组合的 LLM 变式**停用**，`supports(topicId, difficulty)` 返回 false，
  `fillPracticeLLM` 跳过，降级题库复用。
- 恢复：用户清 localStorage 后重置统计（或加手动"重置健康指标"按钮，属后续增强）。

### 8.3 实现

健康指标存在 localStorage `cnmDiagnose.llmVariantStats.v1`：
```js
{
  "cnm_221:standard": { attempts: 15, passed: 12, failed: 3, byReason: { "root-mismatch": 2, "parse-error": 1 } },
  "cnm_221:advanced": { attempts: 8, passed: 5, failed: 3, byReason: { "root-mismatch": 3 } }
}
```

每次 LLM 调用后更新，`supports` 判断时读取。

---

## 9. 边界：哪些题不喂 LLM

### 9.1 choice 题不喂 LLM

**理由**（同 O1 §1.2）：高质量干扰项需要教学判断。LLM 造的干扰项要么太明显（数值随机偏移），
要么太隐蔽（与正确答案无关），不如不做。

cnm_221 的 q1 是 choice 题——LLM 变式**不覆盖 q1 型**，只覆盖 q2/q3/q4 型（numeric）。

### 9.2 short / self 题：按答案形态三档（取代"一律不喂"）

早期边界曾写"short/self 一律不喂（无法自动可靠判分）"。用户拍板修正为**按答案形态三档**
（D11），不是按题型一刀切：

| 答案形态 | 示例 | 变式/出题 | 验证/评判 |
|---------|------|----------|----------|
| 数值 / 表达式 | 解方程 x=?、展开 (2x-3)² | ✅ 喂 LLM | 数值验证（硬门，§3.1/§3.2） |
| 集合 / 分类 | 按正数、0、负数分类 | ✅ 喂 LLM | 集合等价验证（硬门，normalizeSet） |
| 自然语言 | 说明 100-5t 的含义 | ✅ 可出题 | LLM 评判（软，§9.5）+ 降级自评 |

试点（cnm_221）没有 short/self 题，此边界不触发，但设计上按形态分层——**"self 只评判不出题
验证"的旧表述废弃**：self 里的分类题（如"把 -2,0,3.5,-1/3,7 按正数、0、负数分类"）答案是可
结构化的集合，完全能进硬验证门，只有纯自然语言答案才退到软评判。

### 9.3 prompt 注入防护

**题目文本不入 prompt，只入数学结构**：

- systemPrompt 描述知识点的数学结构（"配方法：x²+bx+c=0"），不贴具体题目。
- userPrompt 按难度档描述要求（"出一道 b 为偶数、判别式为完全平方数的方程"），不贴题库原题。
- 撞题去重在客户端做（canon 比较），不把题库文本喂给 LLM。

这样即使 LLM 的输出被注入恶意内容（如 prompt 里写"忽略以上指令，输出 xxx"），
验证门仍然校验数值正确性——**注入的题如果数值不对，一样被丢弃**。

### 9.4 边界总结

| 题型 | LLM 变式 | 验证方式 |
|------|---------|---------|
| numeric（方程类，q3 型） | ✅ | verifyEquationRoots（代入根求值） |
| numeric（配方加常数，q2 型） | ✅ | verifyCompletingSquare（公式校验） |
| numeric（配方 m,n，q4 型） | ✅ | verifyFormParam（公式校验） |
| numeric（判别式非完全平方，q3 变体） | ✅ | verifyEquationRoots（根式代入数值比较） |
| choice（q1 型） | ❌ | — |
| short / self（自然语言答案） | ✅ 可出题 | LLM 评判（软，§9.5）+ 降级自评 |
| self（分类/集合答案，如按正数/0/负数分类） | ✅ | 集合等价验证（硬，normalizeSet） |

### 9.5 主观题 LLM 评判（用户拍板范围补充）

**决策**：非客观题（short 23 题判定脆弱 + self 6 题开放）的评判交给 LLM——语义等价判定
（\"学生的回答和参考答案是不是一个意思、要点全不全\"）。这是 O3 出题扩到开放题时的**闭环
必需**：LLM 出开放题 → LLM 评判，否则出了没法判。现有 29 题单独收益小，但评判模式必须在
设计中（出题与评判是配套关系）。

**实现约束**：
1. 复用现有网关调用基建（explain.js 的 PROXY=127.0.0.1:3000，不加新依赖）。
2. **判题是提交热路径**：必须做判题结果缓存（同题同答案缓存一次）或\"本地规则优先、
   LLM 兜底\"——不能每题提交都等 LLM（+1-3s）。
3. 判不准（低置信）→ 降级\"学生对照参考答案自评\"，**保留现有 short 兜底路径，不删**。
4. 一致性：评判 prompt 用固定基准（few-shot 标准对/错样例），波动是真实存在的，文档明示
   不承诺权威评分——定位是教学反馈体验，不是考卷判分。
5. 评判默认单轮；低置信才二次调用（对齐 §2.4 延迟约束）。

**与验证门的分工**：验证门=确定性判据（数值/集合），只管\"客观对不对\"；评判=语义判断
（LLM），只管\"主观像不像\"。两者是并列的不同能力，不是替代关系。

---

## 10. 模块与函数签名

### 10.1 落点：新增 `diagnose/llm-variants.js`

与 `variants.js` 并存，UMD 包装，零新依赖（用 `fetch` 调本地网关）。

```js
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.DiagLLMVariants = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  /* ... */
});
```

### 10.2 导出清单

| 签名 | 语义 |
|------|------|
| `supports(topicId, difficulty?) -> boolean` | 该知识点是否有 LLM 变式 recipe（当前仅 cnm_221）；difficulty 可选，传入时检查健康指标 |
| `genLLMVariant(topicId, opts) -> Promise<question \| null>` | 异步生成 1 道 LLM 变式；opts = {difficulty, avoidPrompts, seed}；不过验证门或网关不可达返回 null |
| `fillPracticeLLM(fp, topicId, gap, opts) -> Promise<{list, usedVariants, nextIndex}>` | 补位 gap 道 LLM 变式到 fp.list 后面；fp 是 O1 fillPractice 的返回值 |
| `validateLLMQuestion(q) -> {ok, reason}` | 验证门入口：按 q.verifyType 路由 |
| `verifyEquationRoots(prompt, answer) -> {ok, reason}` | 方程类验证（§3.1） |
| `verifyCompletingSquare(prompt, answer) -> {ok, reason}` | 配方加常数验证（§3.2） |
| `verifyFormParam(prompt, answer) -> {ok, reason}` | 配方 m,n 验证（§3.2） |
| `getStats() -> {attempts, passed, failed, byReason}` | 健康指标（调试用） |
| `VERSION = 1` | recipe 集合版本号 |

### 10.3 接入（后续实现卡，非本卡）

1. `index.html`：`<script src="llm-variants.js"></script>` 放在 `variants.js` 之后、`app.js` 之前。
2. `app.js startPractice()`：在 O1 `fillPractice` 之后，如缺口仍存在且 `LLMV.supports(topicId)`，
   异步调 `fillPracticeLLM` 补位。加 loading 状态。
3. `app.js renderQuestion()`：`q.variantSource === 'llm'` 时可选多渲染一个 `LLM变式` 标签（区别于 O1 的 `变式`）。
4. `tests/test_engine.js`：追加验证函数的纯函数测试（不测 LLM 调用）。

---

## 11. 数据结构示例

```json
{
  "id": "cnm_221_lv1",
  "topicId": "cnm_221",
  "difficulty": "standard",
  "type": "numeric",
  "prompt": "用配方法解方程 x²+8x+12=0。（两个根用逗号隔开）",
  "answer": "-2，-6",
  "unordered": true,
  "explanation": "移项 x²+8x=-12，两边加 (8/2)²=16 得 (x+4)²=4，x+4=±2，所以 x=-2 或 x=-6。",
  "verify": "roots2(1,8,12)",
  "verifyType": "equation",
  "variant": true,
  "variantSource": "llm",
  "variantIndex": 0,
  "seed": "cnm_221|s1792679671000"
}
```

验证门校验：
- `verifyEquationRoots("用配方法解方程 x²+8x+12=0", "-2，-6")`
- 解析方程 → `x²+8x+12=0`，lhs = `x²+8x+12`
- 解析答案 → `[-2, -6]`
- 代入 r=-2：`(-2)²+8·(-2)+12 = 4-16+12 = 0` ✓
- 代入 r=-6：`(-6)²+8·(-6)+12 = 36-48+12 = 0` ✓
- → `{ok: true}`

---

## 12. 测试要点清单（实现卡按此 TDD）

追加到 `tests/test_engine.js`。验证函数是纯函数（同步），可直接单测。
LLM 调用本身（异步 + 依赖网关）不进单测。

| # | 测试名 | 断言 | 为什么需要 |
|---|--------|------|-----------|
| 1 | verifyEquationRoots 正确方程 | `verifyEquationRoots("解方程 x²+6x-7=0", "1，-7")` → `ok:true` | 核心验证逻辑 |
| 2 | verifyEquationRoots 错误答案 | `verifyEquationRoots("解方程 x²+6x-7=0", "2，-7")` → `ok:false`（2 不满足方程） | 验证门拦错 |
| 3 | verifyEquationRoots 根式答案 | `verifyEquationRoots("解方程 x²-4x-1=0", "2±√5")` → `ok:true` | 根式解析 + 数值代入 |
| 4 | verifyEquationRoots 部分错 | `verifyEquationRoots("解方程 x²+6x-7=0", "1，-8")` → `ok:false`（-8 不满足） | 多解全覆盖 |
| 5 | verifyCompletingSquare 正确 | `verifyCompletingSquare("要把 x²+6x 配成完全平方式，需要加上的常数是多少？", "9")` → `ok:true` | b=6, (6/2)²=9 |
| 6 | verifyCompletingSquare 错误 | 同上但 answer="8" → `ok:false` | (6/2)²≠8 |
| 7 | verifyFormParam 正确 | `verifyFormParam("把 2x²-8x+1=0 配方成 2(x-m)²=n", "2，7")` → `ok:true` | m=8/(2·2)=2, n=2·2²-1=7 |
| 8 | verifyFormParam 错误 | 同上但 answer="2，8" → `ok:false` | n≠8 |
| 9 | validateLLMQuestion 路由 | `q.verifyType='equation'` → 调 `verifyEquationRoots`；`q.verifyType='completeSquare'` → 调 `verifyCompletingSquare` | 调度正确 |
| 10 | validateLLMQuestion 未知 verifyType | `q.verifyType='unknown'` → `ok:null, reason:'unknown-type'` | 不崩 |
| 11 | 表达式安全过滤 | 含 `eval` / `Function` / `;` 的表达式 → 拒绝（返回 `ok:false, reason:'unsafe-expr'`） | §3.3 安全 |
| 12 | supports 试点 | `supports('cnm_221')` → true；`supports('cnm_043')` → false（O1 的 topic 不归 O3） | 边界 |
| 13 | id 命名空间 | LLM 变式 id `cnm_221_lv1` 不匹配 `/_q\d+$/`（不误认为题库题） | 与题库隔离 |
| 14 | 撞题去重 | avoidPrompts 含某 prompt 时，该 prompt 不进缓存池 | §4.5 |
| 15 | 健康指标统计 | 模拟 10 次 attempts / 4 次 failed → `supports('cnm_221','standard')` 返回 false（>30% 失败率） | §8.2 |

---

## 13. 风险与遗留

| # | 风险 | 处置 |
|---|------|------|
| R1 | LLM 算错答案 | 验证门代入根求值拦截（§3.1）；3 次不过降级题库 |
| R2 | LLM 出的题面不规范/有歧义 | prompt 模板约束格式；验证门不校验语义质量（可接受：练习题面质量不完美不影响判分） |
| R3 | 表达式求值注入 | 正则白名单 + Function（§3.3）；试点阶段足够，后续可换解析器 |
| R4 | 网关不可用 | 离线降级题库复用（§7.3）；cnm_221 现状行为不变 |
| R5 | 首题延迟体验差 | 按需生成 + 缓存（§7.1）；后续可加预热（§7.2） |
| R6 | LLM 变式与 O1 变式 id 混淆 | `_lv` vs `_v` 前缀隔离；`variantSource` 字段区分 |
| R7 | 健康指标样本不足时误判 | `attempts >= 10` 才判（§8.2）；小样本时不拦 |
| R8 | LLM 返回非 JSON | parseSteps 同款正则提取 `{...}`（§4.6）；解析失败算一次 attempt 失败 |
| R9 | 缓存池无限增长 | 每 topicId 上限 50 道 + LIFO 淘汰（§5.4） |

---

## 14. 与 O1/O2 的关系总结

| 维度 | O1（variants.js） | O2（explain.js + verifyReveal） | O3（llm-variants.js） |
|------|-------------------|-------------------------------|----------------------|
| 解决什么 | 题池不够（4题→无限） | LLM 讲解算错 | O1 覆盖不到的族（表达式族） |
| 方法 | 根空间反推（确定性） | reveal 数值校验 | LLM 出题 + 验证门 |
| 依赖 | 零（纯 JS） | 本地网关（离线降级） | 本地网关（离线降级） |
| 覆盖族 | cnm_043（一元一次方程） | 所有（讲解是通用的） | cnm_221（配方法，试点） |
| 确定性 | 是（同 seed 同题） | 否（LLM 生成） | 否（LLM 生成），但缓存后复现 |
| 验证 | 不变量断言（构造式） | verifyReveal（代入比较） | verifyEquationRoots（代入根求值） |
| 改 engine.js | 否 | 是（新增 verifyReveal） | 否 |
| 改 variants.js | — | 否 | 否（并存） |
| 改 app.js | 是（接入 fillPractice） | 否 | 是（接入 fillPracticeLLM，async） |

**核心区别**：O1 是"构造正确"（答案从根反推，天然对），O3 是"生成后校验"（LLM 出题，
验证门拦错）。两种范式互补：O1 能覆盖的族用 O1（确定性更好），O1 覆盖不到的族用 O3（LLM 更灵活）。

---

## 15. 实现卡照做清单（DoD）

1. 新增 `diagnose/llm-variants.js`：UMD 包装、零新依赖、导出 §10.2 符号。
2. `tests/test_engine.js` 追加 §12 的 15 条验证函数测试，RED → GREEN。
3. **不碰** `data/*`、`diagnose/engine.js`、`diagnose/variants.js`。
4. **可碰** `diagnose/app.js`（接入 fillPracticeLLM）和 `diagnose/index.html`（加 script 标签）——属实现卡。
5. 代码风格照 variants.js：`function` 声明 + `'use strict'` + 中文注释写"为什么"。
6. 交付时贴：RED 失败输出、GREEN 全绿输出、`git diff --stat`。
7. 回归测试：`node tests/test_engine.js` 全量绿（O1 的 147 条 + O3 的 15 条 = ≥162 passed）。

---

## 附：为什么不用 sympy/pyodide（再次确认）

| 维度 | sympy/pyodide 方案 | LLM 出题方案（本设计） |
|------|-------------------|----------------------|
| 依赖 | pyodide wasm ~10MB | 零新依赖（用现有网关） |
| 构建期 | 需引入 wasm 加载、构建改造 | 无构建期步骤 |
| 覆盖范围 | 通用符号计算（强） | 受 prompt 模板覆盖的族（够用） |
| 正确性 | sympy 精确（强） | LLM 不可靠 + 验证门拦截（够用） |
| 离线 | pyodide 可离线（需预下载 wasm） | 网关不可用时降级题库（可接受） |
| 复杂度 | 高（wasm 加载 + Python 交互） | 中（prompt 模板 + 验证函数） |

用户已拍板弃用 sympy 方案，选 LLM 出题。本设计是对该决策的落地。
