# 本 fork 与上游的分叉清单

本仓库 fork 自 [`xiaoyang111222/cn-math-taxonomy`](https://github.com/xiaoyang111222/cn-math-taxonomy)。

2026-10-31 合并上游 `dc764bd`（74 提交）时，这条规则写死成了「文档/页面类冲突以上游为准」，
结果此前**故意删掉**的上游外链推广位全部回流（15 处，已由 commit `c652a49` 再清一遍）。原因有两条：

1. 一刀切规则没有区分「我们只是没跟上」和「我们故意删了」；
2. **git 看不见删除意图** —— 我们删掉的块上游改过，冲突就解成上游；上游新加的同款内容
   （如 `5ca171d` 的「资源搜索」）在我们这边压根不存在，不冲突、直接进来。

所以合并上游时**先查这张表**，表里有的一律按表来；表里没有的，才按「上游优先」。
每条分叉都有对应的断言，回流就会在 `tests/test_fork_guards.js` 里变红。

## 分叉表

| # | 我们改了什么 | 为什么 | 对应 commit | 由哪条守卫覆盖 |
|---|---|---|---|---|
| 1 | 删除全站顶部横幅 `a.top-banner` → `test.pansgo.com`（5 个页面：`index.html`、`diagnose/index.html`、`explore/index.html`、`children/index.html`、`children/history.html`） | 外链广告，与学科无关 | `6c3becf`（2026-10-31 回流后由 `c652a49` 再删） | `tests/test_fork_guards.js` (a)(b)(e)；`scripts/fork-guard.mjs` 清整行 |
| 2 | 删除首页 `a.iq-card` 儿童智商测试卡片 | 同上 | `79f7454` | `tests/test_fork_guards.js` (e)（`iq-card` 关键词） |
| 3 | 删除首页导航「资源搜索」→ `pansgo.com`，以及 `assets/site.css` 里 `.resource-search-btn` / `.resource-search-ico` 的规则 | 上游 `5ca171d` 后加的外链，非本站功能 | `c652a49` | `tests/test_fork_guards.js` (a)(b)(e)；`scripts/fork-guard.mjs` 清导航块 + CSS |
| 4 | 删除 `scripts/deploy-cf.sh` | 上游部署到自己 Cloudflare Pages 项目的脚本；本 fork 走 GitHub Pages | `c652a49` | `tests/test_fork_guards.js` (d)；`scripts/fork-guard.mjs` 删文件 |
| 5 | `assets/stats-config.js` 的 `endpoint` 置空 | 上游自建统计采集 worker，本 fork 不上报 | `c652a49` | `tests/test_fork_guards.js` (c)；`scripts/fork-guard.mjs` 置空 |
| 6 | 分享图 / PWA 引导图文字 / 分享二维码链接改指 `xuxiong.github.io/cn-math-taxonomy` | 本站是 fork，不该导流到上游生产站 | `79f7454`、`c652a49` | `tests/test_fork_guards.js` (f) |
| 7 | 「关于」/「提交 Issue」链到 `github.com/xuxiong/cn-math-taxonomy` | 同上 | 早于 `79f7454` | `tests/test_fork_guards.js` (b) 只挡住「白名单外的域名」，**不校验仓库名**；见下面已知缺口 |
| 8 | 全站 LLM 型号统一为 `DeepSeek-V4.1-Flash-1017-Unlimited`，且**只写在 `diagnose/llm-config.js` 一处**（explain / labmatch / llm-gateway / route / llm-variants 都从它取值；网关地址同样只在那里，浏览器走 `scripts/serve.js` 的 `/v1` 同源反代，不再依赖网关 CORS） | 上游硬编码的型号在本机网关里已可下线（`DeepSeek-V4-Flash-0731-TokenPlan` 直接返回 `{"retCode":9}`）；型号一失效，画板语义匹配整层按设计 fail-closed，所有讲解页都不挂画板，而测试全绿——静默退化 | `t_053abd33`、`t_b6b76e3c` | `tests/test_fork_guards.js` (h)（型号正确 + 除 `llm-config.js` 外不得再出现网关地址/型号字面量） |
| 9 | 引入 Umami 匿名访问统计（`cloud.umami.is`，5 个页面各一个 script） | 孩子端上线后无法得知有没有人访问；Pages 与仓库 Insights 都不提供站点访问数据。统计口径刻意收窄：不带 cookie、不采集 URL 查询参数、只认 `xuxiong.github.io`、尊重 DNT；上游自建采集 worker（第 5 条）仍然关闭 | 本次提交 | `tests/test_fork_guards.js` (i) |

## 维护方式

- **新删掉任何上游的东西** → 同时在上面表里加一行，并给 `tests/test_fork_guards.js` 加一条断言
  （断言要写人话，讲清「回流了会怎样、看本文第几条」）。能机械清理的，顺手补进 `scripts/fork-guard.mjs`。
- **合并上游时先查这张表**：表里有的按表解冲突，表里没有的才按「上游优先」。
- **合并完跑两遍**：

  ```sh
  node scripts/fork-guard.mjs     # 第二遍必须全是 clean:
  node tests/test_fork_guards.js  # 必须 0 failed
  ```

- 加白名单（确有正当外链）要改 `tests/test_fork_guards.js` 顶部的 `ALLOWED_DOMAINS`
  和 `scripts/fork-guard.mjs` 顶部的同名数组，并写注释说明用途 —— 改代码、看得见、走 review。

## 第 9 条与第 5 条的关系

第 5 条关闭的是「上游自建 worker 上报」，本条引入的是「第三方匿名计数」，两者不冲突：
`assets/stats-config.js` 的 `endpoint` 依旧为空，本站不向任何自建地址发数据；
Umami 那条标签只发匿名页面/事件，不带 cookie、不带 URL 查询参数（`?target=cnm_…` 这类题目 ID 不外泄）、
只在 `xuxiong.github.io` 下生效、并尊重访客 DNT。

但若将来要彻底回到零统计，改这一条即可：删 5 个页面里的 Umami `<script>` 标签 + 删守卫 (i)。

## 已知缺口（需要人判断，脚本不自动处理）

1. **第 7 条的仓库名**：`children/index.html` 与 `children/history.html` 的「关于」「提交 Issue」
   仍指向上游 `github.com/xiaoyang111222/cn-math-taxonomy`（首页、诊断、图谱三页已改指 `xuxiong`）。
   域名白名单 (b) 放行 `github.com`，所以测不出来。若要收紧，得先决定是否把这两个页面也改指本站仓库 ——
   那是产品改动，不在「只加测试/脚本/文档」的范围内，故本次留作缺口。
2. **`scripts/screenshot.js`** 里与横幅/智商卡片相关的选择器断言、以及 `*.md` 文档里的说明文字，
   属于需要人读一遍才能判断的内容，`scripts/fork-guard.mjs` 明确不碰，回流了靠 review 发现。
