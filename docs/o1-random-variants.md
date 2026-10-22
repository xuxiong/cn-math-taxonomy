# O1 随机出题：先定根再反推系数的变式生成器（设计）

状态：设计定稿（2026-10-22）｜对应 docs/phase1-plan.md §7 O1｜实现卡：O1-2（TDD）
唯一交付物：本文档。本卡不改任何源码、data/、index.html。

---

## 0. 结论摘要（一屏看完）

题池每个知识点只有 4–5 题，练习两轮就没题了。本设计用**根空间反推**生成无限变式：
先在根空间定一个规整的根 r（整数或最简分数），再抽系数、**把常数项反解出来**，
使方程的解恰好是 r。因此"答案规整"是构造出来的，不需要"生成后再校验、不规整重抽"。

| # | 决策 | 内容 |
|---|------|------|
| D1 | 落点 | 新增 `diagnose/variants.js`（UMD，零依赖，与 engine.js 同款包装）；**不塞进 engine.js** |
| D2 | 诊断路径 | **零改动**。变式永不进入 `graph.bank`、永不参与 `pickQuestion/applyAnswer/summarize` |
| D3 | 启用时机 | **池优先、变式补位**：题库还有没做过的题就只出题库题（行为与现状逐项一致）；不足 n 道才用变式补齐 |
| D4 | 系数边界 | 只生成**整数系数**（含负）；**分数/小数系数不做**。答案可以是分数（分数解支持） |
| D5 | 题型 | 只生成 `type:'numeric'`；不做 choice / short / self 变式 |
| D6 | 字段 | `answer` 规范根；`accept` 仅在分数根可写成终止小数时附一条；`verify` 生成；`unordered` 不生成 |
| D7 | 确定性 | `seedKey = (opts.seed \|\| topicId) + '\|' + topicId + '\|v' + index + '#' + attempt`；同一份题库数据下同 (topicId,index) 永远同一题 |
| D8 | id | `<topicId>_v<index+1>`（如 `cnm_043_v7`），与题库 `_q<N>` 命名空间不冲突，不进 data/ |
| D9 | 兜底 | 60 次重抽按段降级（正常→强制整数根→同难度换 recipe→T1 兜底）；受支持 topic **永不返回 null**，未支持 topic 返回 null |
| D10 | 泄露 | 解析首句（`firstClueOf` 取到第一个逗号）结构上只写"去括号得…"，**不用"字符串包含答案"当判据**（见 §5.4） |
| D11 | 撞题 | 与题库 prompt 归一化后逐字比较去重（`avoidPrompts`） |
| D12 | 测试 | 追加到 `tests/test_engine.js`（现有 103 条基线），新增 ≥16 条 |

一句话取舍：**宁可少做题，不可让没有复核的题污染诊断结论**——所以变式只用于练习，
题池够用时一行行为都不变。

---

## 1. 目标与"不做"清单

### 1.1 目标

1. 给定知识点 id + 变式序号，确定性地产出一道**与题库同构、同字段**的方程题。
2. 答案天然规整：整数或最简分数，无根号、无循环小数、无浮点误差。
3. 复用现有判题链（`judgeQuestion`）、讲解链（`socraticSteps` / `explain.js`），**不改它们**。
4. 题池耗尽时练习不空转：题库 4 题 → 无限变式。

### 1.2 不做（明确边界，实现卡照此拒绝扩需求）

| 不做 | 理由 |
|------|------|
| 不等式、二元/方程组、几何、函数、应用题建模 | 各自的知识点与判题口径不同，一个 recipe 也不该跨类型 |
| 含分母的方程（cnm_044） | 去分母 + 最小公倍数是另一个知识点；混进来会破坏"本知识点考什么"的语义 |
| choice 变式 | 高质量干扰项需要教学判断（现有题库的干扰项也是人工按典型错误写的），生成器造不出可信干扰项 |
| short / self 变式 | 无法自动可靠判分，练习即时反馈会退化 |
| 小数系数、分数系数 | 见 §4.2。分数系数会让"口算负担"跳档到 cnm_044 的难点，且解析文本难写规范 |
| 无解 / 恒等方程题 | 不在 "含括号的一元一次方程" 的掌握标准内（`mastery_criteria` 是"能去括号、能解"）；只在内部用 `classifyLinear` 断言排除 |
| 多解 / 解集 | 一元一次方程解集至多 1 个元素，`unordered` 无意义 |
| 代数符号引擎（mathjs/nerdamer/sympy 移植） | 四个模板的恒等变形手写 30 行就够，引依赖得不偿失（plan §7 已定） |
| LLM 生成题目 | 数值不可靠、不可复现、离线不可用；LLM 只用在下游讲解（explain.js） |
| 把变式落盘进 `data/questions.json` | 题库是"有复核记录的资产"，变式不是；落盘会污染统计与 `validate.py` 口径 |
| 诊断路径用变式 | 诊断结论要与题库口径可比、可复现；变式改动会让历史结论漂移 |
| 按学生表现自适应难度 | 第一阶段不需要，难度由 recipe 固定 |

---

## 2. 生成算法：根空间 → 系数反推 → 题目

### 2.1 总原则

每个模板展开后都是一元一次方程 `A·x + B = C·x + D`（A,B,C,D 全是**整数**）。
解为 `r = (D − B) / (A − C)`，唯一解当且仅当 `A ≠ C`。

反推的关键：**A、B、C 由随机抽到的系数直接决定，D（或某个自由常数）不解方程、而是由 r 反解出来**：

```
自由常数 = B + r·(A − C) − （其余已定常数）
```

于是"答案是 r"是构造等式，不是求解结果——这一步天然规整，不需要事后校验答案。
**这个仓库做这件事的成本几乎为零**，因为一元一次方程不需要通用符号引擎（plan §7 的判断成立）。

### 2.2 四个模板（recipe）

| id | 题面形状 | 难度 | 步骤 | 自由量 | 反推公式 | 展开 (A,B,C,D) |
|----|---------|------|------|--------|----------|----------------|
| T1 | `a(x+b)=c` | basic | 去括号→移项→系数化 1 | c | `c = a(b + r)` | (a, a·b, 0, c) |
| T2 | `a(x+b)=c(x+d)` | standard | 四步 | d | `d = (a·b + r(a−c)) / c`，须整除 | (a, a·b, c, c·d) |
| T3 | `a(x+b)−c(x+d)=e` | advanced | 四步 | e | `e = a·b − c·d + r(a−c)` | (a−c, a·b−c·d, 0, e) |
| T4 | `a(x+b)=m−(x+d)` | standard | 四步 | m | `m = a·b + r(a+1) + d` | (a, a·b, −1, m−d) |

- "四步"= 去括号 → 合并同类项 → 移项 → 系数化为 1。
- T4 是题库 `cnm_043_q1`（`2(x-3)=4-(x+1)`）的形状，考"减去一个括号"的变号。
- T3 是 `cnm_043_q3`（`5(x+2)-3(2x-1)=4`）的形状，考两项各自的符号。
- T2 没有自由常数项，分数根需要 `c | (a·b + p·k)`（k=(a−c)/q）同时成立，
  命中率低但**不是不可能**（§2.4 有一例）；因此 T2 以整数根为主，分数根靠整除判断 + 重抽兜住。
- **形态约束（原型踩出来的两个坑，必须有）**：
  - 出现两个括号的模板（T2/T3/T4）要求 `d ≠ b`。否则会产出 `-2(x+5)=-5(x+5)` 这种
    两边括号完全相同的题——形式上合法，但学生能"两边同时除以 (x+5)"越过本知识点，且像生成器在偷懒。
  - T4 要求 `m ≥ 1`。否则会产出 `=-28-(x-5)` 这种"负数减去括号"的双负号开头，视觉上劝退。
  - T3 要求 `e ≠ 0`（`=0` 的题会让"移项"这一步失去意义）。

### 2.3 抽取顺序（先定根，这一点不能反）

```
1. 定难度与 recipe：difficulty = hashStr(base) % 3（basic/standard/advanced 各 1/3），
   recipe = 该难度档内 hashStr(base + '|r') % 档内数量 —— 两者都只由 index 决定，**不参与重抽**
2. 定根 root：先抽根空间 → 整数根或最简分数根（basic 只整数）
3. 抽受根约束的系数：T1 的 a、T3/T4 的 (a−c)/(a+1) 必须是根分母 q 的倍数
4. 抽其余系数：b, c, d（|a|,|c| ∈ [2..6]，b,d ∈ [−9..9]\{0}）
5. 用 §2.2 的反推公式解出自由常数（整数运算 + 整除判断，不出现浮点）
6. 展开成 (A,B,C,D)，跑不变量断言（§2.5）
7. 出题面 / 答案 / 解析 / verify（§3）
8. 撞题与泄露检查（§5.5、§5.4），不过就 `attempt++` 从第 2 步重来（index 与 recipe 都不变）
```

**为什么 recipe 也要锁死**：如果每次重抽都重新选 recipe，接受率高的模板（T1 几乎必成）
会挤掉接受率低的模板（T2 还要求整除），实测分布会偏成 T1 127 : T2 27 : T3 33（§12）。
锁死 recipe 后难度三档接近 1/3，且"某个 index 是哪个模板"可预测、可测。

**为什么第 3 步必须在第 2 步之后**：根是分数 `p/q` 时，`r(a−c)` 要是整数必须有 `q | (a−c)`。
先抽系数再定根就会出现"抽到的系数配不出规整常数项"，只能靠重抽硬凑，命中率低。

### 2.4 手算验算（每个模板两例，实现卡直接用这些当金标准）

| # | 模板 | 抽取 | 反推 | 题面 | 答案 |
|---|------|------|------|------|------|
| S1 | T1 | r=4, a=3, b=−1 | c = 3(−1+4) = 9 | `3(x-1)=9` | `4` |
| S2 | T1 | r=3/2, a=4, b=1 | c = 4(1+3/2) = 10 | `4(x+1)=10` | `3/2`（accept `1.5`） |
| S3 | T2 | r=5, a=3, b=1, c=2 | d = (3+5)/2 = 4 | `3(x+1)=2(x+4)` | `5` |
| S4 | T4 | r=2, a=4, b=2, d=−3 | m = 8 + 2·5 + (−3) = 15 | `4(x+2)=15-(x-3)` | `2` |
| S5 | T3 | r=2, a=5, b=2, c=3, d=−1 | e = 10 − (−3) + 2·2 = 17 | `5(x+2)-3(x-1)=17` | `2` |
| S6 | T3 | r=−7/3, a=5, b=1, c=2, d=4 | e = 5 − 8 + (−7) = −10 | `5(x+1)-2(x+4)=-10` | `-7/3` |

S4 的检验：4x+8 = 15 − x + 3 = 18 − x ⇒ 5x = 10 ⇒ x = 2 ✓
S6 的检验：5x+5 − 2x − 8 = 3x − 3 = −10 ⇒ 3x = −7 ⇒ x = −7/3 ✓

**被拒样例（说明去重的必要性）**：T4 取 a=2, b=−3, d=1, r=3 反推得 m=4，题面
`2(x-3)=4-(x+1)` ——与题库 `cnm_043_q1` 逐字相同。撞题则 `attempt+1` 重抽（序号不变），不返回。

**T2 分数根的整除重抽样例**：r=2/3, a=5, c=2 ⇒ d = (5+2)/2 = 7/2 不整除 → 重抽；
r=3/2, a=6, c=2 ⇒ d = (6+6)/2 = 6 ✓ → `6(x+1)=2(x+6)` → 6x+6 = 2x+12 ⇒ x = 3/2 ✓

### 2.5 不变量断言（生成时必过，全为整数运算）

1. `A ≠ C`（否则无解/恒等，不进变式）
2. 系数范围：`|a|,|c| ∈ [2..6]`、`|b|,|d| ∈ [1..9]`、`|e|,|m|,|c_T1| ≤ 60`、
   展开后 `|A|,|C| ≤ 12`、`|B|,|D| ≤ 60`（统一上界，避免"D ≤ 60 但 e ≤ 40"这种自相矛盾）
3. 形态：`d ≠ b`（T2/T3/T4）、`m ≥ 1`（T4）、`e ≠ 0`（T3）、`c_T1 ≠ 0`
4. 代入精确成立：`A·r + B = C·r + D`（r 用 {p,q} 有理数，通分后整数比较）
5. 答案最简：约分后的 `(p,q)` 必须与预定根一致，`gcd(|p|,q) = 1`、`q > 0`
6. 解析首句不含 `x=r` 形式（§5.4）
7. prompt 不在 `avoidPrompts` 里（§5.5）

任一不过 → `attempt++` 重抽，走 §2.6 的分级兜底。

### 2.6 分级兜底与失败语义（实测 0 失败）

重抽**共 60 次预算，按 attempt 分三段降级**（原型实测：2000 个序号里 96.5% 在第一段命中）：

| 段 | attempt | 策略 | 实测占比 |
|----|---------|------|---------|
| ① 正常 | 0–29 | 锁定的 recipe + 按比例抽整数/分数根 | 96.5% |
| ② 强制整数根 | 30–49 | 同 recipe，根只取整数（分数根的整除条件是小概率失败源） | 2.7% |
| ③ 降级 recipe | 50–59 | 同难度档内另一个 recipe + 整数根（standard: T2↔T4；advanced 只有 T3 时落 ④） | 0.8% |
| ④ 末级兜底 | — | T1 固定参数（`a=2..6`、`b≠0`、`r` 由 seed 取模），**必然成功**，难度如实标 `basic` | 0.05% |

- `supports(topicId) === false` → `genVariant` 返回 `null`，`variantSet` 返回 `[]`。
  调用方（`fillPractice`）退化为现状行为，**不报错、不弹窗**。
- ④ 落地时**如实**把 `difficulty` 标成 `basic`（不许把兜底题标成 advanced 去凑难度覆盖）。
- 不抛异常、不 `console.*`、不写 localStorage、不读 `Date.now()` / `Math.random()`。
- 输出题对象附带 `branch`（`normal|intOnly|downgrade|fallback`，运行期字段，便于埋点看生成健康度）。

---

## 3. 确定性、id 与题面语法

### 3.1 seed 从哪来

```
base    = (opts.seed || topicId) + '|' + topicId + '|v' + index
seedKey = base + '#' + attempt                       // attempt 从 0 起
rng     = mulberry32(hashStr(seedKey))               // 与 engine.js 内 rand01 同款算法
```

- **index = 变式序号（0 起）**，由调用方递增并持久化（app.js 用 `cnmDiagnose.variantSeq.v1`
  存 `{topicId: nextIndex}`）。所以"同一个孩子第 2 次练同一知识点"拿到的是第 4–6 号变式，
  不是重复第 1–3 号；而"同一个 index 永远同一题"保证可复现、可写测试、可贴链接复现。
- **attempt 是 index 内部的子种子**：约束不满足/撞题/泄露时 `attempt++` 重抽，**不动 index**。
  这样"一个 index 恰好对应一道题"，调用方的序号推进永远等于生成数量，不会出现"某个序号永远被跳过、
  每次进来都重撞一次"的死角。
- 确定性的精确表述：**同一份题库数据 + 同 (seed, topicId, index) → 同一题**。
  `avoidPrompts` 参与过滤，所以题库新增题目后同一 index 可能换题——这是有意的，
  去重优先于跨数据版本的逐字稳定（变式不落盘、不进结论，代价为零）。
- `opts.seed` 保留为覆盖入口（例如将来想把变式绑定到诊断会话 seed）。
- 顺序无关：seedKey 只依赖三个字符串与 attempt 计数，与调用顺序、进程、时区无关。
- **不用** `Math.random()`、`Date.now()`、全局计数器。

### 3.2 id 规则

```
id = topicId + '_v' + (index + 1)      // cnm_043_v1, cnm_043_v2, ...
```

理由：
- 题库 id 是 `<topicId>_q<N>`，`_v` 前缀天然不撞；engine 的 `qNum()`（`/_q(\d+)$/`）与
  `questionById()`（`/^(.*)_q\d+$/`）都不会把变式误认成题库题——变式只出现在练习模式，
  不进 `graph.bank`、不进 `session.attempts`。
- 不用 `_q6` 之类续号：那会让变式看起来像题库题，日后有人 `questions.json` 追加同号就撞车。

### 3.3 题面语法（实现卡与测试的正则契约）

统一前缀 `解方程 `，后缀 `。（只填 x 的值）`（与题库 q1 风格一致）；表达式内**不写空格**；
括号内常数非 0；首个系数不写正号、绝对值 ≥ 2；负号用 `-`（不出现 `+-`）。

| 模板 | 题面模板 | 例 |
|------|---------|-----|
| T1 | `解方程 {a}(x{b})={c}。（只填 x 的值）`（b 带符号渲染） | `解方程 3(x-1)=9。（只填 x 的值）` |
| T2 | `解方程 {a}(x{b})={c}(x{d})。（只填 x 的值）` | `解方程 3(x+1)=2(x+4)。（只填 x 的值）` |
| T3 | `解方程 {a}(x{b})-{c}(x{d})={e}。（只填 x 的值）` | `解方程 5(x+2)-3(x-1)=17。（只填 x 的值）` |
| T4 | `解方程 {a}(x{b})={m}-(x{d})。（只填 x 的值）` | `解方程 4(x+2)=15-(x-3)。（只填 x 的值）` |

渲染辅助（三个纯函数，`variants.js` 内部）：

- `signed(n)` → `+3` / `-3`（拼括号内常数用）
- `term(n, 'x')` → `5x` / `-3x` / `x` / `-x`（`|n|==1` 省数字；`n==0` 返回 `''`）
- `constTerm(n)` → `+13` / `-8`（首项为 0 时省略）

---

## 4. 适用边界与数值处理

### 4.1 根空间

| 类别 | 取值 | 说明 |
|------|------|------|
| 整数根 | `r ∈ [−6..6]`（含 0） | 含 0 是刻意保留：能测出"移项后系数化为 1"这一步是否真会 |
| 分数根 | `p/q`，`q ∈ {2,3,4}`，`gcd(abs(p),q)=1`，`abs(p/q) ≤ 3.5` | 预生成有限列表（约 20 个）后抽 |
| 抽取比例 | basic 100% 整数；standard 20/80；advanced 40/60（分数根概率）；**实测落地率** standard 11.9% / advanced 12.5% | 抽取 ≠ 落地：分数根还要过整除约束，见 §12。想提高就把抽取概率提到 60%，其余约束不动 |

### 4.2 系数：整数，且为什么拒绝分数/小数

- 允许：`a, c ∈ {±2..±6}`，`b, d ∈ [−9..9]\{0}`，自由常数 `|·| ≤ 40`。
- **不做小数系数**（如 `0.5(x+1)=3`）：小学/初一学生口算负担跳档，且解析文本出现小数会与
  "系数化为 1"的书写规范冲突。
- **不做分数系数**（如 `(2/3)(x+1)=4`）：那是 cnm_044「含分母的一元一次方程」的核心难点
  （去分母、最小公倍数、不漏乘）。放到本知识点会让诊断结论指向错误的根因。
- 答案仍可为分数（分数解）：分母 ≤ 4，最简，负号前置。

> 与实现卡措辞对齐：实现卡 RED 步骤里写"分数系数"，按本节口径理解为**分数解**。
> 测试应当**断言生成器永不产出小数/分数系数**（`prompt` 只含整数与运算符），而不是要求它生成。

### 4.3 解集大小 / 无解 / 恒等

一元一次方程 `A·x+B = C·x+D` 三分类：

| 条件 | 分类 | 变式是否生成 |
|------|------|------------|
| `A ≠ C` | 唯一解 `r = (D−B)/(A−C)` | ✅ 唯一生成的情形 |
| `A = C` 且 `B = D` | 恒等，解集为全体数 | ❌ |
| `A = C` 且 `B ≠ D` | 空集 | ❌ |

实现上导出 `classifyLinear({A,B,C,D}) -> 'unique'|'identity'|'contradiction'`：
生成器用它断言（`!== 'unique'` 就重抽），测试直接喂字面量覆盖三类
（对应实现卡"无解或恒等判别"的验证要求）。**不生成**这两类题，理由见 §1.2。

### 4.4 浮点

全程整数运算（`Number` 即可，所有量 `|·| ≤ 60`，远在 2^53 内）。分数根用 `{p, q}` 表示，
约分用整数 gcd；**任何地方都不出现 `/` 浮点除法结果参与判断**——`d 是否整除`用 `%` 判。

---

## 5. 判题适配与题对象字段

### 5.1 字段表（与 `data/questions.json` 语义一致）

| 字段 | 生成规则 |
|------|----------|
| `id` | `cnm_043_v<index+1>` |
| `topicId` | 入参 topicId |
| `difficulty` | recipe 决定（T1 basic / T2、T4 standard / T3 advanced） |
| `type` | 恒为 `'numeric'` |
| `prompt` | §3.3 语法 |
| `answer` | 规范根：整数 `"4"` / `"-4"`；分数 `"3/2"` / `"-7/3"`（最简、正分母、负号前置、无空格） |
| `accept` | **仅当**根为分数且分母能整除某个 10 的幂（规则按分母 ∈ {2,4,5,8,10} 判；当前根空间 `q∈{2,3,4}` 里只有 2 和 4 会命中）时，附 1 条终止小数串（`3/2 → "1.5"`、`-1/4 → "-0.25"`）；否则**不写该字段** |
| `verify` | `Fraction(<D−B>,<A−C>)`，用展开后的整数（分母为负则整体变号）；与 answer 必然一致，是可审计的数值凭证 |
| `unordered` | **不生成**（单根） |
| `explanation` | 模板生成，末句固定 `系数化为 1 得 x={<answer>}。`（见 §5.3） |
| `variant` | `true`（运行期标记，不落盘） |
| `variantIndex` | `index`（调试/统计用，不落盘） |
| `variantRecipe` | `'T1'..'T4'`（调试/统计用，不落盘） |
| `branch` | 兜底分支 `normal`/`intOnly`/`downgrade`/`fallback`（运行期埋点用，不落盘） |

> 若将来有人把变式落盘进 `data/questions.json`，必须剥掉 `variant*` / `branch` 字段——
> `scripts/validate.py` 不接受未知字段。本设计**不**提供落盘路径。

### 5.2 判题链：零改动

`judgeQuestion(q, user)` → `judgeNumeric` 已经把这几件事处理干净了，变式直接受益：

| 孩子输入 | 引擎行为 | 是否需要变式生成器配合 |
|---------|---------|---------------------|
| `4` | `identical` → correct | 否 |
| `x=4` | 变量前缀被 `analyzePart` 剥掉，数值等价 → correct | 否 |
| `3/2` 与 `1.5` | 都归一到 `3/2` 的 key 比较 → correct | 否（`accept` 只是让 reason 更准） |
| `-0.25` vs `-1/4` | `decToRatio` 精确转换 → correct | 否 |
| `5`（错） | 双方都是数值 → `different` → **wrong**（不会误判成 manual） | 否 |

因此**变式不需要动判题、也不需要 accept 才能判对**；`accept` 的价值是让"小数写法"走
`identical` 分支（reason 更准、与题库现有约定一致），而不是"不写就判错"。

### 5.3 解析文本（explanation）与讲解链

模板（首句=去括号，末句=答案；中间步骤按模板增减）：

- T1：`去括号得 {a·x}{+ab}={c}，移项得 {a·x}={c−ab}，系数化为 1 得 x={r}。`
- T2/T3/T4：`去括号得 {逐项展开}，合并同类项得 {A·x}{+B}={D}，移项得 {A·x}={D−B}，系数化为 1 得 x={r}。`

例（S5）：`去括号得 5x+10-3x+3=17，合并同类项得 2x+13=17，移项得 2x=4，系数化为 1 得 x=2。`

三个下游消费者天然兼容：

- `socraticSteps(topic, q)`：读 `q.type/answer/choices/explanation` → 变式字段齐全，
  reveal 自然带答案，hint 取解析首句（§5.4 保证安全）。
- `explain.js`（LLM 讲解）：读 `q.prompt/answer/explanation` + `topic` 对象；缓存 key 是 `q.id`，
  变式 id 唯一，不会串题。
- O2 的"reveal 数值校验"（另一张卡）：解析末句固定 `x={answer}`，正好是它的比对锚点。

### 5.4 泄露判据：结构保证，而不是"字符串包含答案"

`firstClueOf` 取解析里第一个 `，。；;,` 之前的内容作为 hint。首句结构上是
"去括号得 …"，**不可能**出现 `x=r` 这种直接给解的形式。因此判据定义为：

- hint **不得**匹配 `/x\s*=\s*<规范根>/`；
- hint **不得**包含 `系数化为`（最后一步的标志）。

**刻意不采用**"hint 不含答案字符串"当判据：答案常常是个位数（如 `2`），而首句
"去括号得 5x+10-3x+3=17，" 里的系数/常数很容易等于根——用子串匹配会把大量合法题目误判成泄露，
把生成器逼进重抽死循环。真正的泄露是"直接给出解"，不是"某个数字刚好等于解"。

### 5.5 撞题去重

`avoidPrompts`（调用方传 `graph.bank[topicId].map(q => q.prompt)`）与生成的 prompt
经 `canon`（去空白、全角/半角统一）后逐字比较。命中处理：**在同一 index 内 attempt+1 重抽**
（不是跳到下一个 index），直到拿到不撞题的题；`variantSet` 的序号推进因此恒等于生成的题数。
撞题上限与约束重抽共用同一份 60 次预算（§2.6），超限走分级兜底。

---

## 6. 与现有题池共存策略（含推荐与理由）

### 6.1 推荐：池优先、变式补位（策略 A）

```
练习列表 = 题库新鲜题（现有 pickPracticeQuestions 语义，最多 n 道）
         + 变式补足（缺口 = n − 新鲜题数，序号从该知识点下一个未用序号起）
         + 题库复用兜底（仅当变式不可用/未支持该 topic，保持现状行为）
```

判定"新鲜"用 `doneIds`（= `seenList()`）：`fresh = bankPicks.filter(q => !doneIds.includes(q.id))`。

### 6.2 为什么不是"练习轮就全变式"

1. **题库题有复核记录**（`verify` 自动核验 + A/B/C/D/E 轮独立复核，见 docs/questions.md），
   变式只有"构造式反推 + 不变量断言 + 独立求解器测试"，没有第二双眼睛。
   题池够用时没有任何理由先上有风险的题。
2. **行为可审**：新鲜题 ≥ n 时，返回列表与现状**逐项相同**，可写一条"行为不变"回归测试；
   若改成"练习轮全变式"，现有练习流程的回归面立刻扩大。
3. **风险被限制在缺口里**：孩子第一次点"练习这 3 题"时，只要题库还有 3 道没见过的题，就是
   100% 题库题（诊断刚消耗掉的那几道会被变式补上——这正是"补位"该有的表现）；
   混入比例随题池消耗线性上升，孩子/家长感知的是"题越练越多"，不是"换了个题库"。

### 6.3 具体行为（cnm_043，n=3）

| 点击次数 | 题库新鲜题 | 变式 | 结果 |
|---------|-----------|------|------|
| 第 1 次（诊断没做过本知识点） | 3 | 0 | 全题库（与现状一致） |
| 第 1 次（诊断已消耗 1–2 道） | 2 或 1 | 1 或 2 | 题库 + 变式 #1、#2 |
| 第 2 次 | 1 | 2 | 1 题库 + 变式 #3、#4 |
| 第 3 次 | 0 | 3 | 变式 #5–#7 |
| 第 N 次 | 0 | 3 | 每次 3 道全新变式 |

> 这张表成立的前提是 §6.4 的 `markSeen` 缺口已修（属接入卡）。**现状**下练习不记 seen，
> 所以"题库新鲜题"永远还是 4 道、每次仍是 3 道题库题——变式只在修复后才真正接上。
> 这也说明变式与 `markSeen` 修复应当同一个接入卡一起落地。

### 6.4 现状缺口（顺手记下，属接入卡，不在实现卡范围）

`diagnose/app.js` 的练习模式**没有调用 `markSeen`**（`markSeen` 只在诊断 `commit()` 里调用）。
后果：`"再练一遍"` 每次用同一个 `seenList()` 抽题，题库题几乎原样重复。
变式用独立的 `variantSeq` 序号绕开这个问题；但题库题仍需在接入卡里补一次
`practiceNext()` 中的 `markSeen(qid)`，否则"1 题库 + 2 变式"那一批的题库题会在下次重复。

### 6.5 诊断路径不动的证据

`pickQuestion/nextItem/applyAnswer/replay/summarize` 只读 `graph.bank`；变式不写入 `bank`
（`buildGraph` 未改），所以同一 `session.seed` 的诊断题序列与现状**逐项相同**——
现有 103 条测试就是这条不变量的回归网。

---

## 7. 模块与函数签名

### 7.1 落点：新增 `diagnose/variants.js`（不放 engine.js）

理由：

1. engine.js 已 1068 行、承载诊断主流程；仓库惯例是按主题分模块（`explain.js` 就是 T2 新增的兄弟模块），
   不是把新能力追加进大文件。
2. 生成器是"内容生产"，不是"判定"。混进 engine 会让 engine 的测试面从"判定逻辑"扩到"题目质量"，
   也让回滚变难（生成器出问题不应该动到诊断引擎）。
3. 实现卡硬约束是"只动 engine.js 或新增 diagnose/ 模块 + tests"，新模块天然满足。

`variants.js` 采用与 engine.js **完全相同的 UMD 包装**，零依赖：

```js
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.DiagVariants = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  /* ... */
});
```

**关于 RNG**：`hashStr`（6 行）+ `mulberry32`（9 行）在 variants.js 里**复制一份**，
刻意不做跨模块 require。理由：`hashStr` 目前没有从 engine.js 导出，且浏览器/Node 两种加载
方式下跨模块取依赖要写 root 探测，反而更绕；两份都是确定性的 15 行，代价最小。
（若实现者更倾向 DRY，唯一可接受的做法是 engine.js 导出 `hashStr` 并在 variants.js 里
`root.DiagEngine || require('./engine.js')` 二选一——但那属于改 engine.js 的导出面，本设计不推荐。）

### 7.2 导出清单

| 签名 | 语义 |
|------|------|
| `supports(topicId) -> boolean` | 该知识点是否有 recipe（当前仅 `cnm_043`） |
| `genVariant(topicId, index, opts) -> question \| null` | `index` 从 0 起；`opts = {seed, difficulty, avoidPrompts}` |
| `variantSet(topicId, startIndex, count, opts) -> question[]` | 连续生成 count 道（序号推进恒等于返回题数）；未支持 topic 返回 `[]` |
| `classifyLinear({A,B,C,D}) -> 'unique'\|'identity'\|'contradiction'` | 生成器的断言工具，同时供测试直接覆盖三分类 |
| `fillPractice(bankPicks, topicId, n, opts) -> {list, usedVariants, nextIndex}` | **纯函数**共存策略（§6.1）；`opts = {doneIds, avoidPrompts, startIndex, seed, difficulty}` |
| `VERSION = 1` | recipe 集合的版本号（见 §10 风险 R4） |

`fillPractice` 的参考实现（接入卡照抄即可，**不写 localStorage**）：

```js
function fillPractice(bankPicks, topicId, n, opts) {
  opts = opts || {};
  const done = new Set(opts.doneIds || []);
  const picks = (bankPicks || []).slice();
  const fresh = picks.filter(function (q) { return !done.has(q.id); });
  const out = fresh.slice(0, Math.max(1, n));
  let next = opts.startIndex || 0;
  let used = 0;
  if (out.length < n && supports(topicId)) {
    const vs = variantSet(topicId, next, n - out.length, {
      seed: opts.seed, difficulty: opts.difficulty, avoidPrompts: opts.avoidPrompts
    });
    used = vs.length; next += vs.length;
    for (let i = 0; i < vs.length; i++) out.push(vs[i]);
  }
  for (let i = 0; i < picks.length && out.length < n; i++) {   // 现状兜底：题库复用
    if (out.indexOf(picks[i]) < 0) out.push(picks[i]);
  }
  return { list: out, usedVariants: used, nextIndex: next };
}
```

### 7.3 接入（后续卡，非本卡实现）

1. `index.html`：`<script src="variants.js"></script>` 放在 `engine.js` 之后、`app.js` 之前。
2. `app.js startPractice()`：换成 `DiagVariants.fillPractice(E.pickPracticeQuestions(...), topicId, 3, {...})`，
   序号读写 `cnmDiagnose.variantSeq.v1`，练习结束把 `nextIndex` 存回。
3. `app.js renderQuestion()`：`q.variant` 为真时多渲染一个 `变式` 标签；练习横幅加"其中变式 M 道"。
4. `app.js practiceNext()`：补 `markSeen(q.id)`（§6.4）。

---

## 8. 数据结构示例

```json
{
  "id": "cnm_043_v7",
  "topicId": "cnm_043",
  "difficulty": "advanced",
  "type": "numeric",
  "prompt": "解方程 5(x+1)-2(x+4)=-10。（只填 x 的值）",
  "answer": "-7/3",
  "verify": "Fraction(-7,3)",
  "explanation": "去括号得 5x+5-2x-8=-10，合并同类项得 3x-3=-10，移项得 3x=-7，系数化为 1 得 x=-7/3。",
  "variant": true,
  "variantIndex": 6,
  "variantRecipe": "T3"
}
```

---

## 9. 测试要点清单（实现卡按此 TDD，≥16 条）

追加到 `tests/test_engine.js`（现有 harness：`test(name, fn)` + `assert`，103 条基线）。
**先写 RED 再实现**。测试里不许读源码文本（仓库规则），只调 API、只看行为。

**测试内独立求解器**（这是"真解一遍"的关键，与被测代码不共享任何逻辑，约 40 行）：
按 §3.3 的四个正则从 `q.prompt` 解析出 `a,b,c,d,e,m`，按 §2.2 表展开成 `A,B,C,D`，
再用测试内自带的 `{p,q}` 有理数（`gcd` + 整数乘加）解出 `r=(D−B)/(A−C)`，
与 `q.answer` 的解析值比较。**不要**从被测模块拿任何中间量。

| # | 测试名 | 断言 | 为什么需要 |
|---|--------|------|-----------|
| 1 | 确定性：同 (topic,index) 两次生成深相等 | `deepStrictEqual(genVariant('cnm_043',0), genVariant('cnm_043',0))` | 需求 D7 的核心承诺 |
| 2 | 不同 index 得到不同题 | `[0..9]` 的 `id` 互不相同，且 `prompt` 去重后 ≥ 8 种 | 序号真的在推进 |
| 3 | id 形状 | 正则 `^cnm_043_v\d+$`，且 `index=i` → `_v{i+1}` | 与题库 `_q<N>` 命名空间隔离 |
| 4 | **数值正确性（独立求解器）** | `index 0..199`：求解器算出的根 === `answer` 解析值 | 变式最致命的风险是"题面对、答案错" |
| 5 | **题面与内部展开一致** | 求解器从 prompt 解析出的 `a,b,c,d` 每个都满足 §2.5 取值范围；展开后 `A≠C` | 防"渲染时张冠李戴"（答案对但题面错） |
| 6 | 单一解不变量 | 全部变式 `classifyLinear(展开) === 'unique'` | 无解/恒等绝不产出 |
| 7 | 三分类工具 | `classifyLinear` 喂 `{2,3,2,5}`→contradiction、`{2,3,2,3}`→identity、`{2,3,1,4}`→unique | 对应实现卡的"无解或恒等判别" |
| 8 | 答案规整 | 每个 `answer` 匹配 `^-?\d+$` 或 `^-?\d+\/[234]$`；分数必最简；无小数点、无空格 | 判题链只吃这种形式 |
| 9 | 无分数/小数系数 | 每个 `prompt` 只由 `[0-9 + - ( ) x = 。（）、只填的值解方程]` 这些字符组成；显式断言不含 `.` 与 `√` | 边界 D4 |
| 10 | 难度分布与 recipe 归档 | ①`[0..299]` 三档各占 80–120 条（1/3 均衡）；②`difficulty:'basic'` 全为 T1 且 answer 全整数；③`difficulty:'advanced'` 中 T3 占 ≥99%，剩余条目必须 `difficulty==='basic'`（兜底如实降级，见 §2.6④） | recipe 由 index 决定（§2.3） |
| 11 | 分数根与整数根都出现 | `difficulty:'advanced'` 的 `[0..199]` 里 ≥5 条 `answer` 含 `/`（实测 12.5%）；`basic` 的 0 条 | 根空间真的覆盖两类 |
| 12 | `accept` 语义 | 若 `q.accept` 存在：`judgeQuestion(q, q.accept[0]).verdict==='correct'` 且 reason 为 `identical`；`q.accept[0]` 含小数点 | D6 |
| 13 | 判题链兼容（4 种输入） | `answer`、`x=`+`answer`、等价小数（分数根时）、错值 → `correct/correct/correct/wrong` | 变式必须能进现有判卷流程 |
| 14 | 解析结构 | 每个 `explanation` 含该模板规定的步骤关键词、并以 `系数化为 1 得 x={answer}。` 结尾 | 讲解链与 O2 校验锚点 |
| 15 | 首句不泄露 | `E.socraticSteps(topic, q)` 的 `steps[1].text` 不匹配 `/x\s*=\s*<answer>/` 且不含 `系数化为` | §5.4，且用公开 API 而非复制内部函数 |
| 16 | 撞题去重（并保持确定性） | ①`avoidPrompts:[该题自己的 prompt]` 时同 index 生成的 prompt ≠ 被避开的那个；②非撞题场景下，传 `[]` 与传题库 prompts 两个数组的生成结果**深相等**（attempt 未被消耗） | §5.5 + D7 |
| 17 | 未支持 topic 的失败语义 | `genVariant('cnm_045',0)===null`、`variantSet('cnm_045',0,3)===[]`、`fillPractice([],'cnm_045',3,{})` 不抛错 | 边界不报错、不弹窗 |
| 18 | 共存策略：充足时不混变式 | `fillPractice(bankPicks4, 'cnm_043', 3, {doneIds:[]})` → 3 题全是题库题、顺序与 `pickPracticeQuestions` 一致、`usedVariants===0` | "题池有题时行为不变"的可执行证明 |
| 19 | 共存策略：耗尽后补位 | `doneIds` = 全部 4 题 → `list` 3 题全 `variant===true`、`id` 互不相同、`usedVariants===3`、`nextIndex===3` | 无限题库生效 |
| 20 | 无副作用 / 性能护栏 | 200 次生成总耗时 < 500ms（防死循环）；生成前后 `globalThis` 无新增键、无 console 输出 | 兜底循环不能变成活锁 |

跑法：`node tests/test_engine.js` → 目标 `103 + ≥16 = ≥119 passed, 0 failed`。
（现有其它入口：`python3 scripts/verify_questions.py`、`python3 scripts/validate.py` 不涉及变式，
因为变式不落盘——但要保证这两个脚本的输出不变。）

---

## 10. 风险与遗留

| # | 风险 | 处置 |
|---|------|------|
| R1 | 变式无独立复核（生成器与答案同源） | ①构造式反推（答案不来自求解）；②测试用**独立求解器**从题面重新解（不同算法路径，能抓"题面/答案不一致"）；③只在练习用，不进诊断结论 |
| R2 | 生成器系统性 bug（如 T3 的 `−c·d` 写成 `+c·d`） | 测试 4/5 就是为它写的：任一模板的符号错都会让独立求解器与 `answer` 不一致 |
| R3 | 与题库"同构不同数"的题 | 教学上可接受，仅做逐字去重（§5.5） |
| R4 | 改 recipe 后，历史 index 生成的内容变了 | 不落盘、不参与结论 ⇒ 可接受；`VERSION` 常量留作将来需要严格复现时的钩子 |
| R5 | 难度标注无真实学生数据校准 | 与现有题库同一已知局限（docs/questions.md「局限」），不新增问题 |
| R6 | `variantSeq` 无限增长 | 只存一个整数，无实际上限 |

---

## 11. 实现卡照做清单（DoD）

1. 新增 `diagnose/variants.js`：UMD 包装、零依赖、无 `console`、无 `Math.random/Date.now`；
   导出 §7.2 六个符号。
2. `tests/test_engine.js` 追加 §9 的 20 条（至少 16 条），RED → GREEN，全量 `node tests/test_engine.js` 绿。
3. **不碰** `data/*`、`index.html`、`diagnose/app.js`、`diagnose/engine.js`（除非实现者选择在 engine.js
   导出 `hashStr` 做 DRY——本设计不建议）。
4. 代码风格照 engine.js：`function` 声明 + `'use strict'` + 中文注释写"为什么"；
   无 `if/elif` 长链（recipe 用表驱动）。
5. 交付时贴：RED 失败输出、GREEN 全绿输出（≥119）、`git diff --stat`。

---

## 12. 原型验证记录（设计可行性证据）

设计定稿前用一份**一次性原型**（`/tmp`，不入库；约 250 行）跑过四轮，暴露并修掉了 4 个问题。
实现卡不必复用这份代码，但它的结论可以直接当验收基线。

| 轮次 | 发现 | 处置（已写进上文） |
|------|------|------------------|
| v1 | 300/300 生成成功、独立求解全对，但 **recipe 分布被接受率带偏**：T1 127 / T4 113 / T2 27 / T3 33 | recipe 由 index 决定、重抽不换 recipe（§2.3） |
| v1 | 产出 `-2(x+5)=-5(x+5)` 这类两边括号相同的题 | 加 `d ≠ b`（§2.2 形态约束） |
| v1 | 产出 `=-28-(x-5)` 双负号开头 | 加 `m ≥ 1`（§2.2） |
| v2/v3 | 锁 recipe 后出现 **4/300 ≈ 1.3% 的 null**（分数根整除条件无解） | 分级兜底 ①②③④（§2.6），复测 0/2000 |
| v3 | `abs(e) ≤ 40` 与 `abs(D) ≤ 60` 上界打架 | 统一到 60（§2.5） |

**v4（定稿版）实测**（`node` 跑 2000 个序号）：

```
2000 indices → null 0 | byDifficulty { standard: 665, advanced: 664, basic: 671 }
byRecipe { T4: 344, T3: 664, T1: 671, T2: 321 }
byBranch { normal: 1930, intOnly: 53, downgrade: 16, fallback: 1 }
fraction answers 160 (8.0%) | distinct prompts 1740
determinism true
independent verified 2000 / 2000, bad 0
avoidPrompts(题库 4 题): generated 500, null 0, collisions 0
per-difficulty null: basic 0 / standard 0 / advanced 0
fraction-root rate: basic 0.0% / standard 11.9% / advanced 12.5%
200 gens: 2 ms
```

"独立求解"是文档 §9 要求的那套：从 `prompt` 正则解析 → 展开 → BigInt 有理数解方程 →
与 `answer` 比对，与被测构造没有共享逻辑。

顺带得到两个事实，供接入卡参考：

1. **变式空间约 1700+ 个不同题面**（2000 个序号里 1740 个互不相同），练习场景足够；
   若要求"同一孩子永不见重复"，把"本次会话已生成的 prompt"也塞进 `avoidPrompts` 即可。
2. 单题生成 ~0.01 ms，批量 200 题 2 ms，不需要缓存。

---

## 附：与 edulab（plan §7 来源）的差异

| 维度 | edulab（Python/sympy） | 本设计 |
|------|----------------------|--------|
| 思路 | 随机参数 → sympy 精确求解 → `is_clean` 检查 → 不规整重抽 | **先定根 → 反推系数**，答案天然规整 |
| 规整性校验 | 每道题都跑（成本在求解） | 退化为不变量断言（成本≈0），不靠"试错命中" |
| 依赖 | sympy | 无（纯前端 JS，约 250 行） |
| 上限 | 50 次重抽 + 兜底题 | 30 次重抽 + T1 兜底 |
| 适用范围 | 多题型内核 | 单知识点 4 模板，registry 可扩（加 cnm_042 等只需加 recipe 组） |
