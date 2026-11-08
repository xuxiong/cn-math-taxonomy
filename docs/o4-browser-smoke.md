# O4 卡G：真浏览器端到端冒烟（脚本产出的事实）

> 本文件由 `scripts/o4-browser-smoke.mjs` 生成，内容全部取自该脚本的真实运行：真页面（`explore/` 知识点页）+ 真 `scripts/serve.js` 同源反代 `/v1` + 本机 `127.0.0.1:3000` 网关真模型。**只写事实与计数，不写任何质量判断。**

- 本次运行：`20261108024031`（2026-11-08T02:40:31.160Z）
- 运行环境：node `v23.11.1`；Chrome `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
- 页面：`http://127.0.0.1:51618/explore/?t=<n>#<topicId>`（`t` 只是唯一化查询串，保证每次都是真「首次进页面」的新文档；页面本身忽略它）；serve.js 端口 `51618`
- 模型配置注入：`localStorage["cnmDiagnose.llm"] = {"base":"http://127.0.0.1:51618/v1","model":"default","key":"local-smoke"}`（key 为占位串，本机网关不校验）
- 段标题来源：`diagnose/topic-explain.js` 的 `SEG_TITLES`（脚本 `require` 模块读取，不写死中文）→ ["这是什么","为什么要学","怎么做","看个例子","容易错的地方"]
- 请求计数口径：**页面内包 `window.fetch`** 记录 url/method/body 与 `/v1/chat/completions` 的响应 body（`clone()` 抄一份，不改原响应）。不用 CDP Network 计数。

## 1. 三个知识点结果表

| topicId | 名称 | 5 段出齐 | demo 有问句 | demo 有答案行 | 请求数（讲解 / 全部 fetch） | 耗时 |
| --- | --- | --- | --- | --- | --- | --- |
| `cnm_p006` | 5以内的加法（grade 1） | 是（5 段） | 是 | 是 | 1 / 8 | 16.0s |
| `cnm_p019` | 凑十法 / 20以内进位加法（grade 1） | 是（5 段） | 是 | 是 | 1 / 8 | 10.2s |
| `cnm_p031` | 口算加法（grade 1） | 否（0 段） | 否 | 否 | 2 / 9 | 55.3s |

> 「请求数」= **点按钮 → 5 段上屏期间新增的 fetch**（按点各自起算，不含进页面时的知识点数据请求）。「讲解」= URL 含 `/v1/chat/completions` 的请求；「全部」= 该区间内页面内所有 fetch。

### 各点段标题（按 DOM 顺序）

- `cnm_p006`：「这是什么」 → 「为什么要学」 → 「怎么做」 → 「看个例子」 → 「容易错的地方」；面板状态 `ready`
- `cnm_p019`：「这是什么」 → 「为什么要学」 → 「怎么做」 → 「看个例子」 → 「容易错的地方」；面板状态 `ready`
- `cnm_p031`：；面板状态 `gate`（这条没通过自动校验（格式没成形），换一次试试）

## 2. cnm_p006 七条取证

| # | 判据 | 结论 | 关键事实 / DOM 片段 |
| --- | --- | --- | --- |
| 1 | 点「让 AI 讲一遍」后出现 5 个段标题，顺序与 topic-explain.js 的 SEG_TITLES 一致 | 是 | 实际 = ["这是什么","为什么要学","怎么做","看个例子","容易错的地方"]；期望 = ["这是什么","为什么要学","怎么做","看个例子","容易错的地方"]<br>`<section class="tai-seg tai-seg-what"><h3 class="tai-seg-title">这是什么</h3> <secti…` |
| 2 | how 段是 <ol> 且至少 2 个 <li>；what/why/trap 是 <ul> | 是 | how=ol/3 li；what=ul，why=ul，trap=ul<br>`<ul class="tai-list"> × 3</ul> <ul class="tai-list"> × 3</ul> <ol class="tai-ste…` |
| 3 | demo 段：第一行是题面且含问句；末行「答案」被渲染成可点开的折叠（点开后文本变化） | 是 | 首个子节点是题面=true；题面含问句=true；答案行="答案：3朵。"；折叠 summary="查看答案"；点开后文本变化=true<br>`<p class="tai-q">有 2 朵花，又放进来 1 朵。一共有多少朵？</p> … <details class="tai-ans"><summary…` |
| 4 | 每条 AI 回复都含「AI 生成 · 未经人工审核」 | 是 | 讲解面板 .tai-badge 命中 1 处；老师气泡 0 条，全部带标=true<br>`<div class="tai-foot"><span class="tai-badge">AI 生成 · 未经人工审核</span>` |
| 5 | 追问 2 轮（「为什么是这样？」+「我算的是 9，对吧？」）→ 学生气泡在右、老师气泡在左，第二轮后输入框仍可用 | 是 | 学生气泡 2 条（右边缘对齐容器右=true）；老师气泡 2 条（左边缘对齐容器左=true）；输入框可用=true；两轮失败提示=["",""]<br>`<div class="tai-bubble tai-bubble-student" style="right=1264">为什么是这样…</div> <div…` |
| 6 | 切到 cnm_p002 再切回 cnm_p006 → 网络请求数不增加 | 是 | 计数口径 = 页面内包 window.fetch（不是 CDP Network）。计入的是「p002 数据已预热」后的第二次往返：切走前总/讲解 = 10/3；切回后总/讲解 = 10/3；增量 = 0/0；预热往返（装 p002 自身数据）增量 = 0/0；切回后 5 段文本与切走前一致=true<br>`<div class="tai"><section class="tai-seg tai-seg-what">…×5</section></div>（复用模块内…` |
| 7 | 全程 console.error / uncaught exception 为 0 | 是 | CDP console.error=0；CDP exceptionThrown=0；页面 window.onerror=0；unhandledrejection=0；Log 域 error（含网络资源失败，单列不计入本条）=0<br>`(无)` |

第 3 条折叠实测：点开前 `details` 内文 `查看答案`，点开后 `查看答案 答案：3朵。`（`details.open` = true）。

第 5 条气泡几何（`.tai-bubbles` 容器 left=`917`, right=`1264`）：
- 学生气泡：left=1126.88 / right=1264，left=1095.47 / right=1264
- 老师气泡：left=917 / right=1211.94，left=917 / right=1211.94

第 6 条请求数（切走前 / 切回后）：总 `10` → `10`；讲解 `3` → `3`；切回后 5 段文本与切走前一致=是。

cnm_p006 时间：讲解点击→5 段上屏 `16.0s`；两轮追问 `9.9s`。

## 3. 每段第一行原文摘录（各 ≤60 字）

「第一行」取该段渲染后的第一行文本（列表段 = 第一个 `<li>`；demo = 题面那一行），用来核对「一点一行、不是一大段」。

| 点 | 段 | 首行原文 |
| --- | --- | --- |
| `cnm_p006` | 这是什么（`what`，ul × 3） | 1. 5以内的加法，是把两部分合起来，算出一共有多少。 |
| `cnm_p006` | 为什么要学（`why`，ul × 3） | 1. 数花、数苹果、数鸟时，常要把两部分合起来数。 |
| `cnm_p006` | 怎么做（`how`，ol × 3） | 看清题里的两部分各是几个。 |
| `cnm_p006` | 看个例子（`demo`，ol × 4） | 有 2 朵花，又放进来 1 朵。一共有多少朵？ |
| `cnm_p006` | 容易错的地方（`trap`，ul × 3） | 1. 只看一部分，忘记把两部分合起来。 |
| `cnm_p019` | 这是什么（`what`，ul × 3） | 凑十法是把一个加数拆成两部分的算法。 |
| `cnm_p019` | 为什么要学（`why`，ul × 3） | 10 加几最好算，凑成 10 算起来又快又准。 |
| `cnm_p019` | 怎么做（`how`，ol × 3） | 先看第一个加数差几能凑成 10。 |
| `cnm_p019` | 看个例子（`demo`，ol × 3） | 9＋4 用凑十法怎么算？ |
| `cnm_p019` | 容易错的地方（`trap`，ul × 3） | 拆数要看着 9 来拆，9 差 1，就把 3 拆成 1 和 2。 |

cnm_p006 各段完整行数（用于核对分段粒度）：`what`=3 行，`why`=3 行，`how`=3 行，`demo`=6 行，`trap`=3 行。

## 4. 证据落盘

- 截图：
  - `tmp/o4-smoke/cnm_p006.png`（cnm_p006 面板，七条取证全部跑完后拍的）
  - `tmp/o4-smoke/cnm_p019.png`（cnm_p019 面板，5 段上屏后拍的）
  - `tmp/o4-smoke/cnm_p031.png`（cnm_p031 面板，5 段上屏后拍的）
  - `tmp/o4-smoke/cnm_p006-chat.png`（cnm_p006 两轮追问后）
- 原始请求/响应（逐次一个 JSON，含 request body 与 response body）：
  - `tmp/o4-smoke/raw/20261108024031/`（本次运行）
  - `tmp/o4-smoke/raw/20261108024031/cnm_p006-*.json`：3 次 `/v1/chat/completions`（讲解 1 + 两轮追问 2）
  - `tmp/o4-smoke/raw/20261108024031/cnm_p019-*.json`：1 次 `/v1/chat/completions`（讲解 1）
  - `tmp/o4-smoke/raw/20261108024031/cnm_p031-*.json`：2 次 `/v1/chat/completions`（讲解 1）

> `tmp/` 在 `.gitignore` 里，截图与原始报文不入库；本文件只写路径。

## 5. 退出后进程清理实测

| 项 | 实测 |
| --- | --- |
| 本机 Chrome 进程数（含 helpers，`ps` 命令含 `Google Chrome` 的行数）— 启动前 | 27 |
| 同上 — 收尾前（本次 Chrome 仍在） | 36 |
| 同上 — `guard.kill` 之后 | 27 |
| 差值（收尾后 − 启动前） | +0 |
| 本次自己起的 Chrome：命令行提到本次临时 profile 的进程数（收尾前） | 8 |
| 同上 — `guard.kill` 之后 | 0 |
| 本次 Chrome 主 pid `91704` 收尾后是否还活着 | 否 |
| serve.js 端口 `51618` 是否已释放 | 是 |

判据说明：本机同时开着用户自己的浏览器，它在这几分钟里会自己开关标签/渲染进程，所以「本机 Chrome 进程总数前后相等」**不作为判据**（已记录的 4 次实跑总数差值：+0、+0、+0、+0，方向与幅度都由别人的浏览器决定）。本卡判据：**本次自己起的进程全部消失**（临时 profile 进程数 = 0、主 pid 不再存活）+ serve 端口释放。


收尾只用 `guard.kill(chrome)`（杀自己 `guard.launch` 起来的进程组）与 serve 子进程 pid；**没有** `pkill chrome`、**没有**连/读/杀 9222 上的 Chrome。

serve.js 尾部日志：
```
静态服务已启动：http://127.0.0.1:51618/diagnose/
（只监听 IPv4：浏览器若把 localhost 解析成 ::1 会连不上，用 127.0.0.1 访问）
已禁缓存：.js/.css/.html/.json 等返回 Cache-Control: no-store（改完代码刷新即生效）
根目录：/Users/apple/github/cn-math-taxonomy/.worktrees/t_6bc47a17（监听 127.0.0.1:51618）
```

## 6. 重复运行（同一脚本连跑）

| runId | 各点 5 段出齐 | 讲解请求数（p006 / p019 / p031） | 全部 fetch（p006 / p019 / p031） | 七条取证 |
| --- | --- | --- | --- | --- |
| `20261108023149` | 是 / 是 / 是 | 1 / 1 / 2 | 8 / 8 / 9 | 7/7 |
| `20261108023341` | 是 / 否 / 是 | 1 / 1 / 1 | 8 / 8 / 8 | 7/7 |
| `20261108023834` | 是 / 是 / 是 | 1 / 1 / 2 | 8 / 8 / 9 | 7/7 |
| `20261108024031` | 是 / 是 / 否 | 1 / 1 / 2 | 8 / 8 / 9 | 7/7 |

> 每次运行都用新目录 `--user-data-dir`（空 localStorage），所以后续运行不会命中讲解缓存、请求数不会变成 0；下表是各次真实读数，不是靠缓存凑出来的。

**一致性判定（逐点比较 5 段是否出齐 / demo 有问句 / demo 有答案行 / 讲解请求数 / 全部 fetch，不含耗时与正文）**：**否**（4 次运行存在读数不同的项，见下）

- 不一致：`cnm_p019` 的5 段出齐：`20261108023149`=5 段，`20261108023341`=0 段
- 不一致：`cnm_p019` 的demo 有问句：`20261108023149`=true，`20261108023341`=false
- 不一致：`cnm_p019` 的demo 有答案行：`20261108023149`=true，`20261108023341`=false
- 不一致：`cnm_p031` 的讲解请求数：`20261108023149`=2，`20261108023341`=1
- 不一致：`cnm_p031` 的全部 fetch：`20261108023149`=9，`20261108023341`=8
- 不一致：`cnm_p031` 的5 段出齐：`20261108023149`=5 段，`20261108024031`=0 段
- 不一致：`cnm_p031` 的demo 有问句：`20261108023149`=true，`20261108024031`=false
- 不一致：`cnm_p031` 的demo 有答案行：`20261108023149`=true，`20261108024031`=false

> 不一致只出现在真实模型返回上（同一请求体可能 `finish_reason=length` 且正文为空，见 §7 的旁证）；页面侧没有报错，见第 7 条与 §7。本卡不据此判源码对错，也不在本卡改源码。

## 7. 未成立 / 异常项（如实记录）

- `cnm_p031`：5 段未出齐（实际 0 段），面板状态 `gate`，页面文案：这条没通过自动校验（格式没成形），换一次试试
- `cnm_p031`：demo 没有问句（题面文本：）
- `cnm_p031`：demo 没有以「答案」开头的行

原始返回见 §4 的 `raw/` 目录（每条的 request/response body 都原样落盘）。本节只记录，不在本卡改源码去凑。

### 更早运行（同一脚本）里的不成立项：原样记录，不改源码去凑

- `20261108023341`（原始报文：`tmp/o4-smoke/raw/20261108023341/`）：
  - `cnm_p019`：5 段未出齐（实际 0 段），面板状态 `error`，页面文案：这次没取到讲解，点重试再来一次
  - `cnm_p019`：demo 没有问句（题面文本：）
  - `cnm_p019`：demo 没有以「答案」开头的行

### 失败点旁证：脚本在 Node 侧把同一份请求体重放一次（无页面的 30s 客户端超时）

页面侧 `postOnce` 的 abort 上限是 `diagnose/llm-config.js` 里的 `timeouts.chat = 30000`（30s）；Node 侧重放没有这个上限，用来区分「网关不给正文」与「页面等不到」。

- `cnm_p031`（口算加法（grade 1），面板状态 `gate`）：
  - `cnm_p031-01.json`：页面那次 `200`；重放 http=`200`，`finish_reason`=`stop`，正文长度=`431`，耗时 21.1s，usage=`{"prompt_tokens":754,"completion_tokens":3191,"total_tokens":3945,"prompt_tokens_details":{"audio_tokens":0,"cached_tokens":512}}`
  - `cnm_p031-02.json`：页面那次 `200`；重放 http=`200`，`finish_reason`=`stop`，正文长度=`444`，耗时 20.2s，usage=`{"prompt_tokens":754,"completion_tokens":3679,"total_tokens":4433,"prompt_tokens_details":{"audio_tokens":0,"cached_tokens":512}}`

> 这一节只陈述「同一份请求体在网关侧得到什么」。是否因此判失败、要不要改预算/超时/重试，属于另一张卡的范围。

## 8. 首点竞态探针（只记录事实，源码不属本卡改动范围）

- 做法：整页加载 `#cnm_p006`，**按钮一出现就点**（不等 §1 用的「详情面板落定」判据），然后在 15s 内轮询可见面板 `.tai-seg` 数；不足 5 段再点一次，轮询 60s。
- 首点返回值：`clicked`；第二轮点击返回值：`（未执行：首点已上屏）`
- 结论（事实）：按钮一出现就点也能上屏（本次未复现竞态）
- 首点后可见面板 HTML 片段（≤200 字）：`<section class="tai-seg tai-seg-what"><h3 class="tai-seg-title">这是什么</h3><ul class="tai-list"><li>1. 5以内的加法，是把两部分合起来，算出一共有多少。</li><li>2. 得数不超过5，可以用5以内数的分与合来想。</li><li>3. 算式里的＋表示合起来，＝表示合起来的结果。</li></ul`
- 请求增量：首点后（15s 内）总 `0` / 讲解 `0`
- 判读（**推断，未改源码验证**）：首点后讲解请求已经发出并 200 返回，说明模块确实跑了、讲解也算出来了；但内容画进的是 `explore/app.js` `mountTopicAI(box)` 持有的那个 `.tai` 盒子，而 `ensureDetail` / `loadQuestionsFor` 回包后的 `renderDetail()` 会 `replaceChildren` 把盒子换掉 —— 旧盒子脱离文档，可见面板于是停在原始按钮上；第二次点击时模块已加载、STATE 已是 ready，所以 5 段立刻出现且不再发请求。
- 卡面 §3 的七条取证按**真实用户路径**执行（人滚到面板底部再点，此时详情数据早已落定），因此 §2 不受这条竞态影响；这条单独列出来，是因为「按钮一出现就点」时可见面板确实 0 段。

---

本文件不含任何「孩子能听懂 / 讲得清楚 / 质量好」类判断；只有 DOM 读数、布尔结论与请求计数。
