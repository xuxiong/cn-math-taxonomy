# 第一阶段需求文档：一元一次方程学习闭环

状态：v3（T1 已完成并浏览器实测通过；D1=B 本地网关、D2=苏格拉底 已拍板）
日期：2026-10-22
仓库：xuxiong/cn-math-taxonomy（fork 自 xiaoyang111222/cn-math-taxonomy）

---

## 1. 北极星场景

孩子在做七上"一元一次方程"作业时卡住了。打开系统，选"含括号的一元一次方程"，
15 分钟内做完一轮诊断，明确知道自己卡在"移项变号"；系统接着给他 2-3 道针对性
练习 + 一次分步引导式讲解；答对后系统确认"已掌握"。家长在旁边看到一份诊断结论，
知道今晚要陪孩子补什么。

验收声明：**孩子能独立从"一元一次方程"诊断走到"拿到根因 + 做完针对性练习 +
获得一次讲解"，全程无需家长解释界面。**

## 2. 范围边界

### 做（第一阶段只做这些）

| # | 能力 | 说明 |
|---|------|------|
| F1 | 讲解层（答错后） | 判错后不再是"答案+一行解析"，而是三步：启发提问 → 分步引导 → 完整解析 |
| F2 | 针对性练习 | 结果页根因/不稳知识点旁，一键生成该点 2-3 道变式练习 |
| F3 | 诊断结论导出 | 一键导出/打印诊断结论（根因、不稳、学习路径），家长留存 |
| F4 | 精简入口 | 首页直达"一元一次方程"预设诊断（少点两下，孩子能独立操作） |

### 不做（明确拒绝，第二阶段）

- 跨会话历史/趋势图（F3 的导出文件就是第一阶段的历史）
- 间隔复习提醒
- 多孩子档案、账号体系
- 英语学科任何改动
- 家长周报、推送
- 高中/小学知识点链扩展（数据不动，只做七上链路的演示闭环）

## 3. 主链路与文件动线

```
选知识点 → 诊断答题 → 判错 → [F1 讲解层] → 诊断完成
              ↓                                   ↓
         engine.js 判定                              renderResult()
                                                   [F2 练习入口] [F3 导出]
```

| 文件 | 当前规模 | 本阶段改动 |
|------|---------|-----------|
| diagnose/engine.js | 962 行 | 极小（只加练习抽题函数，复用 pickQuestion） |
| diagnose/app.js | 1425 行 | 主战场（renderQuestion 加讲解层、renderResult 加练习区、导出按钮） |
| diagnose/share.js | 265 行 | 不动 |
| diagnose/engine.test.js（tests/test_engine.js） | 85 测试 | 讲解层无状态逻辑 + 练习抽题的可测部分 |
| index.html / assets/ | — | F4 入口链接（只加一个预设 URL 卡片） |

## 4. Ticket 拆分（tracer-bullet：每条都有 blocking edges）

### T1 讲解层骨架（✅ 已完成 2026-10-22）
- engine.js 新增 `socraticSteps(topic, q)` 纯函数：返回 [{kind:'prompt'|'hint'|'reveal', text}] 三步引导
  - prompt 不泄露答案；hint 只给解析第一句线索（firstClueOf 截到首个逗号，避免泄露）；reveal 才揭示完整答案+解析
  - 缺解析时自动退回通用引导
- app.js：判错后（auto phase 且非 correct）出现"为什么错了？一起想想"按钮 → explain phase 渲染三步面板
  - 第 1 步：想不出来可以点"给我一点提示"或"直接看答案"
  - 第 2 步：hint 后可"看完整解析"或"我明白了，重新做一遍"
  - 第 3 步：reveal 后"明白了，下一题"（commit wrong）或"我想再试一遍"（回 ask 清空重做）
- style.css：`.socratic` 面板样式（虚线边框 + brand 色）
- 测试：tests/test_engine.js 新增 6 个 socraticSteps 测试（91/91 全绿），覆盖长度/泄露/选择题/缺解析
- 浏览器实测（agent-browser + Chrome/155）：答错→讲解→hint→reveal→下一题、以及"重新做一遍"分支全部通过
- 交互约定：`ui.phase='explain'` + `ui.explainStep`(0/1/2)；renderQuestion 的 auto 分支加按钮、新增 explainPanel(item)

### T2 LLM 讲解服务（✅ 已完成 2026-10-22；blocking: T1 的交互约定，D1=B 本地网关已定）
- 新增 diagnose/explain.js：`window.Explain.generate(topic, q, userAnswer)` → Promise<{steps, from:'llm'|'static'}>
  - **渐进增强**：先用 engine.socraticSteps 静态版即时渲染，同时后台调 LLM 生成个性化三步，成功后重渲染替换
  - prompt 分 system（苏格拉底三步 JSON 输出约束）+ user（题目/知识点/学生答案/标准解析），temperature 0.6，max_tokens 900
  - 解析失败/网关挂了 → 回退静态版（from='static'，不显示"AI 讲解"标签），UI 永不阻塞
  - 同题 5 分钟内存缓存（key=q.id，占位防并发重复调）；已被浏览器实测验证
- 新增 diagnose/llm-proxy.js（node 零依赖 CORS 代理，端口 8010）： `node diagnose/llm-proxy.js`
  - **已停用可删**：网关 2026-10-22 已原生支持 CORS（api-server commit f6f8a246c7，OPTIONS 204 + Origin 回显 + Vary），explain.js 已直连 3000
  - 运行依赖（AI 讲解要工作必须都活着）：http.server:8000 + codefree 网关:3000
- app.js：explainPanel 接入（触发时序：先触发请求再算 aiTag，避免"AI 正在生成…"永不显示）；
  ui 状态新增 aiSteps/aiState('idle'|'loading'|'done'|'static')/aiRequested；explainTick 竞态令牌防串题
- index.html 引入 explain.js（engine.js 之后）；style.css 加 .ai-tag（AI 讲解/基础讲解标签）
- 浏览器实测（agent-browser）：生成中→AI 讲解替换（个性化 prompt 引用学生答案 7）、hint/reveal 全程、
  网关挂掉回退"基础讲解"不卡 UI，全部通过
- 模型：DeepSeek-V4-Flash-0731-Unlimited（思考模型，生成约 10-20 秒；测试要等足，别 8 秒就判失败）

### T3 针对性练习（blocking: 无）
- renderResult 的根因/不稳条目旁加"练习这 3 题"
- 复用 engine 的题池（questions.json 每点 4-5 题，练习模式 allowed），抽未做过的
- 练习模式不进诊断结果，只记 localStorage"练习过"
- 验收：结果页点练习 → 出 2-3 题 → 判对错 → 返回结果页
- 文件：engine.js（练习模式判定，极小）、app.js renderResult

### T4 诊断结论导出（blocking: 无）
- renderResult 已有"导出 JSON / 打印"按钮（官方已实现），补充：
  - 导出文件名带日期（diagnosis-2026-10-22.json）
  - 结果页顶部加"家长看这里"摘要卡（根因 1-2 个 + 建议）
  - input: 摘要卡内容可复制为纯文本
- 验收：一键得到带日期 JSON + 可复制的建议摘要
- 文件：app.js renderResult、share.js 的导出函数

### T5 首页精简入口（blocking: 无）
- 首页"开始诊断"区加预设卡片："七年级 一元一次方程（含括号）"
- 直链 /diagnose/?target=cnm_043&label=...
- 验收：首页一次点击直达诊断第一题
- 文件：index.html

## 5. Blocking 依赖图

```
T1（讲解交互骨架）
  └─→ T2（LLM 讲解，需 D1/D2 拍板）

T3 练习 ── 无依赖，可与 T1 并行
T4 导出 ── 无依赖，可与 T1 并行
T5 入口 ── 无依赖，可与 T1 并行
```

推荐顺序：T1 + T3 + T4 + T5 并行起手 → T2 等 D1/D2 决策后接入。

## 6. 决策点（已拍板 2026-10-22）

### D1：讲解用的模型 API —— **已定：B 本地网关**
本地 Ollama / vLLM 网关（127.0.0.1:3000）已可用；数据不出本机、无 key 泄露。
T1 静态骨架不依赖模型，T2 实现时经 explain.js 调本地网关（需一个小型代理绕 CORS）。

### D2：讲解风格 —— **已定：苏格拉底式**
T1 已实现：第 1 步启发提问（不给答案）→ 第 2 步线索提示 → 第 3 步才揭晓解析。
T2 的 LLM prompt 按此结构生成（prompt/hint/reveal 三段式，接口与 socraticSteps 对齐）。

## 7. 验收方式

1. 手工走查：北极星场景全流程（选点→诊断→错→讲解→练习→导出）
2. tests/test_engine.js 保持全绿（讲解层逻辑抽成纯函数可测）
3. 与上游 diff 保持可审（改动集中在 diagnose/，不碰 data/）