# O4 真机验收：知识点讲解 + 追问（真模型 10 学科 × 2 点）

运行时间：2026-11-08T01:12:01.843Z

## 0. 运行参数

- 网关：http://127.0.0.1:3000/v1/chat/completions
- model：`default`，temperature：0
- max_tokens：讲解 2048（llm-config.maxTokens.explain）/ 追问 2048（llm-config.maxTokens.tutor）
- 超时：讲解 30000ms（llm-config.timeouts.chat）/ 追问 30000ms（llm-config.timeouts.tutor）
- 失败重试：1 次，仍失败记 `request_failed` 并继续下一点
- 请求次数：80（其中重试过的请求 0 次），HTTP 200：80
- 采样规则：学科顺序取 `data/stats.json` 的 `subjects` 键序；每学科在 `data/topics-lite/<subject>.json` 中按 **id 字典序升序取前两个**（可复现）

## 1. 采样表（20 点）

| # | 学科 | topicId | 名称 | grade |
|---|---|---|---|---|
| 1 | math | cnm_001 | 正数与负数的概念 | 7 |
| 2 | math | cnm_002 | 用正负数表示相反意义的量 | 7 |
| 3 | english | cne_h001 | 句子成分 | 10 |
| 4 | english | cne_h002 | 五种基本句型 | 10 |
| 5 | physics | cnp_001 | 长度和时间的测量 | 8 |
| 6 | physics | cnp_002 | 运动的描述 | 8 |
| 7 | chinese | cnc_j001 | 阅读《春》 | 7 |
| 8 | chinese | cnc_j002 | 阅读《济南的冬天》 | 7 |
| 9 | science | cns_p001 | 我们知道的植物 | 1 |
| 10 | science | cns_p002 | 观察植物 | 1 |
| 11 | morality | cnd_p001 | 开开心心上学去 | 1 |
| 12 | morality | cnd_p002 | 我向国旗敬个礼 | 1 |
| 13 | history | cnh_j001 | 远古时期的人类活动 | 7 |
| 14 | history | cnh_j002 | 原始农业与史前社会 | 7 |
| 15 | geography | cng_j001 | 地球的宇宙环境 | 7 |
| 16 | geography | cng_j002 | 地球与地球仪 | 7 |
| 17 | biology | cnb_j001 | 观察周边环境中的生物 | 7 |
| 18 | biology | cnb_j002 | 生物的特征 | 7 |
| 19 | chemistry | cnk_j001 | 化学使世界变得更加绚丽多彩 | 9 |
| 20 | chemistry | cnk_j002 | 物质的变化和性质 | 9 |

## 2. 合规率

- 讲解：合规 **12/20**
- 追问：合规 **60/60**（20 点 × 3 轮）

判定口径只有两种：`checkExplain(segs)` / `checkReply(text)` 的 `ok` 与 `reasons[].gate`；`parseExplain` 切不出 5 段也记 G1。

## 3. 拒因计数（gate × why）

| gate | why | 出现次数 | 出现在 |
|---|---|---|---|
| G1 | parseExplain 无法切出 5 段：空返回 | 5 | 讲解 |
| G1 | parseExplain 无法切出 5 段：解析失败：缺 how/demo/trap | 2 | 讲解 |
| G1 | parseExplain 无法切出 5 段：解析失败：缺 what/why/how/demo/trap | 1 | 讲解 |

## 4. 结构性观察（只记计数）

| 项 | 计数 |
|---|---|
| demo 段出现问句（？/?） | 12/12（分母=成功切出 5 段的讲解数，共 12） |
| demo 段出现「答案：」开头行 | 12/12 |
| 追问（故意问错类，共 20 轮）出现「99」 | 18/20 |
| 讲解平均耗时 | 9177ms（20 次成功请求，合计 183548ms） |
| 追问平均耗时 | 3947ms（60 次成功请求，合计 236841ms） |
| 追问锚点来源 | 5 段 12 点 / 原始返回文本 8 点 / 占位 0 点 |
| 讲解 finish_reason=length | 8/20 |
| 讲解响应内容为空串 | 5/20 |
| 追问 finish_reason=length | 0/60 |
| 追问响应内容为空串 | 0/60 |

## 5. 缺陷记录（只记录，不修；修另开卡）

- 讲解响应 `finish_reason=length`：8/20，其中 `completion_tokens` 等于 `maxTokens.explain`（2048）的 8/8。
- 上述 8 条里：内容为空串 5 条，内容被截断（`parseExplain` 报缺 what/why/how/demo/trap）3 条。
- 追问响应 `finish_reason=length`：0/60；内容为空串：0/60。
- 逐条原始返回：`tmp/o4-live-raw/<topicId>.json`（字段 `explain.finish` / `explain.usage` / `explain.content`）。

## 6. 不可测声明

本次验收只验证**格式是否成形**与**文本卫生**；概念正确性、可读性、是否适合该年级**未经验证**。

## 7. 卡 D 修后重跑

运行时间：2026-11-08T01:40:53.209Z

本节是**卡 D**（`explain` 预算 2048→4096 + 截断自动重发一次）改完之后，用**同一个脚本、同一套采样规则**的重跑读数。
§0–§6 是卡 C 的原始读数（讲解 12/20 那一批），原样保留、未被本节覆盖；两节数字可直接对照。

### 7.1 本次运行参数

- 网关：http://127.0.0.1:3000/v1/chat/completions
- model：`default`，temperature：0
- max_tokens：讲解 **4096**（卡 C 为 2048，见 §0）/ 追问 2048（`tutor` 未动）
- 超时：讲解 30000ms / 追问 30000ms（未动）
- 截断重发：**2 次**（判据 = `diagnose/topic-explain.js` 的 `needsRefetch`：`finish_reason=length` 或正文 trim 后为空；同一 messages、同一 max_tokens，每点最多重发 1 次）
- 请求次数：82（讲解 20 + 追问 60 + 截断重发 2），HTTP 200：82；HTTP 失败重试：1 次

### 7.2 合规率（对照卡 C §2）

| 项 | 卡 C | 卡 D 修后 | 变化 |
|---|---|---|---|
| 讲解合规 | 12/20 | **19/20** | +7 |
| 追问合规 | 60/60 | **60/60** | +0 |

判定口径与卡 C 完全相同：`checkExplain(segs)` / `checkReply(text)` 的 `ok` 与 `reasons[].gate`；`parseExplain` 切不出 5 段也记 G1。

### 7.3 拒因计数（gate × why）

| gate | why | 出现次数 | 出现在 |
|---|---|---|---|
| G1 | parseExplain 无法切出 5 段：空返回 | 1 | 讲解 |

### 7.4 截断与耗时（对照卡 C §4 / §5）

| 项 | 卡 C | 卡 D 修后 |
|---|---|---|
| 讲解 `finish_reason=length` | 8/20 | 0/20 |
| 讲解响应内容为空串 | 5/20 | 1/20 |
| 讲解 `completion_tokens` 撞满 `maxTokens.explain` | 8/8（length 条全撞满，上限 2048） | 0/0（上限 4096；本批没有 length 条） |
| 讲解首答命中 `needsRefetch` | —（该机制卡 D 才有） | 2/20 |
| 截断重发 | — | 2 次 |
| 重发后恢复 / 重发后仍截断 | — | 2 / 0 |
| 讲解平均耗时 | 9177ms（单次响应） | 12928ms（含重发，共 20 点） |
| 追问平均耗时 | 3947ms | 3830ms（共 60 次） |

耗时口径：卡 C 记单次响应；卡 D 的讲解耗时把重发那一次也算进去（重发本身要等一次完整生成），因此两者不是严格同口径，重发次数见上一行。

### 7.5 重发过的点

| # | 学科 | topicId | 首答 finish | 首答正文 | 重发后 finish | 重发后合规 |
|---|---|---|---|---|---|---|
| 1 | math | cnm_001 | length | 空 | stop | 合规 |
| 4 | english | cne_h002 | length | 有（截断） | stop | 合规 |

### 7.6 仍不合规的点（如实记录，不修饰）

| # | 学科 | topicId | http | attempts | finish | 首答需重发 | 原始返回片段 | 拒因 |
|---|---|---|---|---|---|---|---|---|
| 17 | biology | cnb_j001 | 200 | 2 | (空) | 否 | `{"retCode":9} ` | G1 parseExplain 无法切出 5 段：空返回 |

判读：`finish_reason` 为空、原始返回是网关自己的错误体（不是模型输出）时，**不属于**卡 D 的截断判据 —— `needsRefetch` 对缺 `choices` 的响应明确返回 false，交由既有的「网关失败 / 格式没成形」分支，因此不重发，如实记 G1。

### 7.7 原始返回

- 逐条：`tmp/o4-live-raw/<topicId>.json`（20 个文件，新增字段 `explain.firstFinish` / `explain.firstEmpty` / `explain.firstNeedsRefetch` / `explain.refetched`）
- `tmp/` 在 `.gitignore` 内，不入库。

## 8. 原始返回

- 目录：`tmp/o4-live-raw/`（20 个文件，文件名 `<topicId>.json`，含每条请求的 messages 判定结果、HTTP 码、耗时、模型原始返回文本）
- `tmp/` 在 `.gitignore` 内，不入库。

## 9. 卡 E 修后重跑：网关错误体

运行时间：2026-11-08T02:10:05.149Z

本节是**卡 E**（网关错误体单独识别 + 退避 800ms 重发一次）改完之后，用**同一个脚本、同一套采样规则**的重跑读数。
§0–§8 是卡 C / 卡 D 的历史读数，原样保留、未被本节覆盖。

### 9.1 本次运行参数

- 网关：http://127.0.0.1:3000/v1/chat/completions
- model：`default`，temperature：0
- max_tokens：讲解 4096 / 追问 2048
- 超时：讲解 30000ms / 追问 30000ms
- 请求总数：80（讲解 20 + 追问 60 + 截断重发 0 + 网关错误重发 0）
- 合规率：讲解 **20/20**；追问 **60/60**

### 9.2 网关错误体 vs G1 结构拒（分开计数，互不重复）

| 项 | 计数 |
|---|---|
| 讲解首答命中网关错误体 | 0/20 |
| 网关错误体码分布 | （无） |
| 网关错误重发次数 | 0 |
| 重发后恢复（不再是网关错误） | 0 |
| 重发后仍为网关错误 | 0 |
| `gwerror` 点数 | 0 |
| G1 结构拒点数 | 0 |
| gwerror + G1（两者之和，已互斥不重复） | 0 |

### 9.3 逐条网关错误点

（本轮没有网关错误体）

### 9.4 如实申报

本轮网关错误体 0 次（首答命中；其中重发后仍为网关错误 0 次，重发后恢复 0 次）。

`needsRefetch` 对缺 `choices` 返回 `false` 是设计（它是截断判据），网关错误体由 `gatewayErrorOf` 单独识别。

