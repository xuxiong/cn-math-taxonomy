# 上游同步 SOP

写给下一个要把 `xiaoyang111222/cn-math-taxonomy` 的新提交并进本 fork 的人（或 agent）。
**不要凭本文推演，照着命令跑。** 每条命令的当前输出记在最后一节「实测记录」。

- 本仓库 = fork，本地 `main`（`b4167cd`，**尚未快进到本轮合入结果、未 push**）领先上游 **253 个提交**；
  merge-base 与上游 HEAD 同为 `cf73951`（2026-11-06）。按本轮合入结果（`wt/up-integ` 头 `2816bc6`）量是 **264 个提交**、落后上游 0。
- 上一轮合入的区间是上游 `dc764bd..cf73951`（**11 个提交**）。同一对父提交的 `merge-tree` 干跑冲突 5 个文件：
  `README.md`、`assets/home.js`、`diagnose/app.js`、`diagnose/engine.js`、`sw.js`。
- 上游 remote 已配好：`git remote get-url upstream` → `https://github.com/xiaoyang111222/cn-math-taxonomy.git`。
- 已有的基建，**只接入，不重写**：
  - `docs/fork-divergences.md` —— 10 条分叉表。合并时「**表里有的按表，表里没有的才上游优先**」。
  - `scripts/fork-guard.mjs` —— 幂等清理（跑第二遍必须全 `clean:`）。
  - `tests/test_fork_guards.js` —— 18 条回流守卫。
  - `scripts/upstream-sync.sh` —— 本 SOP 配的只读体检脚本。

---

## 0. 先跑只读体检（不写任何东西）

```sh
scripts/upstream-sync.sh            # 不联网，只报已 fetch 的 upstream/main
scripts/upstream-sync.sh --fetch    # 先 fetch 再报（代理自己设，脚本不硬编码）
HTTPS_PROXY=http://127.0.0.1:7890 scripts/upstream-sync.sh --fetch   # 外网走代理
```

退出码：`0` 无需同步 / `1` 需同步且有冲突 / `2` 需同步但干跑无冲突 / `3` 前置不满足（无 upstream remote 等）。
脚本只读：不 `checkout`/`merge`/`reset`/`stash`、不改 ref、不建文件，跑完 `git status --porcelain` 与跑前完全一致。
退出码 `0` 就可以收工，别再往下走。

---

## 1. 先量后动：四个数

```sh
# 1) 拉上游（外网需要代理 + HTTP/1.1，否则大仓库常卡死 / 断流）
HTTPS_PROXY=http://127.0.0.1:7890 git -c http.version=HTTP/1.1 fetch upstream main

# 2) 落后多少（上游有新、我们没有）
git rev-list --count main..upstream/main

# 3) 领先多少（我们有、上游没有）
git rev-list --count upstream/main..main

# 4) 上游改了哪些文件
git diff --name-only main...upstream/main | wc -l

# 5) 干跑合并，只数冲突行 —— 这个数才是工作量
git merge-tree --write-tree main upstream/main | grep -c '^CONFLICT'
```

**冲突行数才是工作量，ahead / behind 不是。** 落后 166 个提交可能 0 冲突，落后 3 个提交可能撞了 40 个文件。
`merge-tree --write-tree` 不碰工作区、不建 ref（只在对象库里留不可达对象，`git status` 不变），可以反复跑。

看冲突落在哪些文件（不进合并也能看）：

```sh
git merge-tree --write-tree --name-only main upstream/main | tail -n +2 | sed '/^$/,$d'
```

---

## 2. 在一次性 worktree 里试合并

`main` 保持可服务（它是 Pages 部署分支），所有合并动作在一次性 worktree 里做：

```sh
# 从主仓库根目录执行（在已有 worktree 里执行也可以）
git worktree add -b wt/sync .worktrees/sync main
cd .worktrees/sync

git merge --no-ff upstream/main
```

- **只用 `merge`，不 `rebase`。** 本地 166 个提交不重放：它们的 SHA 已经被看板卡片、review、`docs/` 引用，
  重放会全部改写，历史对不上账。
- **绝不 `git merge --abort` 重来。** 冲突解到一半推平重来 = 前面的判断全丢，第二次还是同样的冲突。
  往前解：解 → `git add` → `git commit`（或继续 `git merge --continue`）。
- 冲突没解完时，当前冲突清单：`git diff --name-only --diff-filter=U`。

---

## 3. 解冲突的唯一规则

```sh
grep -n '^| [0-9]' docs/fork-divergences.md    # 10 条分叉表，逐条对照
```

**规则：表里有的按表；表里没有的才「上游优先」。**

为什么不能一刀切「文档/页面类以上游为准」——2026-10-31 合 `dc764bd` 时就是这么干的，结果：

1. **git 看不见删除意图。** 我们**故意删掉**的块，只要上游改过它，冲突就会被解成上游版本；
2. 更隐蔽的是**上游新加的同款内容**（如 `5ca171d` 的「资源搜索」导航）——我们这边压根没有，
   不冲突、不提示，**直接进来**。

那次回流了 15 处外链推广位（顶部横幅 / 智商测试卡 / 资源搜索），事后靠 `c652a49` 再清一遍。
所以解冲突前先查表；解完还必须跑第 4 节的三条命令 —— 它们才是「回流了会红」的兜底。

表里 10 条速览（细节看 `docs/fork-divergences.md`）：①顶部横幅 ②首页智商测试卡 ③「资源搜索」导航 + CSS
④`scripts/deploy-cf.sh` ⑤统计 `endpoint` 置空 ⑥分享图/二维码指向本站 ⑦关于/Issue 链接 ⑧LLM 型号唯一真源
⑨Umami 匿名统计 ⑩首页「使用手册」飞书外链。

---

## 4. 合完三条命令必须全绿

```sh
# ① 幂等清理：跑两遍，第二遍必须全 clean:、0 fixed
node scripts/fork-guard.mjs
node scripts/fork-guard.mjs

# ② 回流守卫：必须 0 failed
node tests/test_fork_guards.js

# ③ 全量测试（每个文件独立进程，无测试框架）
for f in tests/test_*.js; do node "$f" >/dev/null 2>&1 && echo "ok   $f" || echo "FAIL $f"; done
for f in tests/test_*.js; do node "$f" 2>&1; done | grep -oE '[0-9]+ passed|[0-9]+ failed' \
  | awk '/passed/{p+=$1} /failed/{f+=$1} END{print "total passed:", p, "total failed:", f}'
```

当前基线：**39 个文件、1442 passed / 0 failed**（2026-11-07 实测；逐文件 `node --test` 39/39 退出码 0）。

**这个数字会变**（每次合上游、每次加功能都会变）。规矩是：

- 以**合并前**在同一台机器上实测的数字为准，合并后不许比它少；
- **不许为了让套件变绿而删断言、改输入范围、`skip`、放宽比较**。红了就查代码，不是查测试。

`tests/test_children_browser.js` 需要 Node 22+ 与 Chrome/Chromium，输出的是 `PASS: …` 而不是 `N passed`，
所以 1442 是其余 38 个文件的合计；它失败会以非 0 退出码体现，上面的 `ok/FAIL` 循环能抓到。

**另一处口径坑**：`tests/test_socratic_gate.js` 打印 `passed=5 failed=0`，上面那条 awk 聚合会把 `passed=5` 里的
`5 failed` 读成一次失败，于是打印 `total failed: 5`（2026-11-07 实测就是如此）——真实 failed 是 0。
判红一律以**逐文件退出码**为准，别信聚合行里的 failed 数。

---

## 5. 四级验收（停在第一级 = 放过去一个死功能）

### ① 套件绿，且无冲突残留

```sh
git diff --name-only --diff-filter=U          # 必须为空
grep -rn '^<<<<<<<' --exclude-dir=.git --exclude-dir=node_modules . | head   # 必须无输出
```

### ② 套件没缩水

```sh
# 合并前（在 main 上跑一次，存到仓库外）
grep -cE '^(test|testAsync)\(' tests/*.js > /tmp/tests-before.txt
# 合并后（在 wt/sync 里）
grep -cE '^(test|testAsync)\(' tests/*.js > /tmp/tests-after.txt
diff /tmp/tests-before.txt /tmp/tests-after.txt
```

**这个 grep 只是「断言块个数」的代理指标，与 passed 数不是同一口径**：`test_fork_guards.js` 报 18 passed 但 grep 只数到 12，
`test_route.js` 101 vs 76，`test_serve.js` 是 0（它用 `async function test(...)` 本地定义，行首不是 `test(`）。
所以**只能拿它跟合并前的同一条命令逐文件比**，别拿它跟 passed 数对。

计数不变还不够，还要**逐条读测试文件的改动**：

- **合法**：改了断言值，并在 commit message / 注释里写清为什么（例如上游把某接口返回结构改了）。
- **有害**：删断言、把输入收窄成必然通过的样本、把 `strictEqual` 换成 `ok`、把循环样本数变小。

看测试到底改了什么：

```sh
git diff --stat <合并前 main 的 SHA>..HEAD -- tests/
git diff <合并前 main 的 SHA>..HEAD -- tests/
```

### ③ 本地功能真跑（静态读代码不算）

```sh
node scripts/serve.js          # 端口 8920，服务仓库根目录；对代码/数据强制禁缓存
# 浏览器打开 http://127.0.0.1:8920/diagnose/
# （只监听 IPv4；浏览器把 localhost 解析成 ::1 会连不上，一定用 127.0.0.1）
```

逐项点一遍（这 4 项是「套件绿但功能死了」的高发区）：

| 检查 | 期望 | 为什么专门查 |
|---|---|---|
| 诊断页选整年级 → 点「开始整体诊断」 | 会话键出现；Network 里 `data/questions/` 只发 **3 个章节 bundle** | 题库门（`SCREEN_GATE_TARGETS`/`SCREEN_GATE_BUNDLES`）被上游覆盖就会退回「等全量题库」 |
| 单点出题（点任一知识点出题） | 出题、判分、讲解都出来 | bundle 取不到时的回退分支最容易被改坏 |
| 画板挂图 | 图形挂上，标签不压 y 轴刻度数字 | 标签避让是纯函数，退化了套件不一定红 |
| route 存档 | 刷新后存档仍在（localStorage） | 上游改存储键/结构会静默清空 |

### ④ 分叉删除项 0 命中

```sh
grep -rnE 'pans[g]o|iq-card|resource-search' --include=*.html --include=*.css .
```

必须无输出。

为什么要写成 `pans[g]o` 而不是原字面量：**`tests/test_fork_guards.js` 的禁用词扫描连 `*.md` 一起扫**
（只要 `SELF_REFERENTIAL` 里没列这个文件），文档里写下域名原字面量，守卫 (a) 会当场变红 ——
它分不清「说明文字」和「回流」。`pans[g]o` 是个正则，`grep` 语义完全等价，扫描器却认不出这个字面量。
真需要在某个 `.md` 里留下原字面量时，正路是把该文件加进 `tests/test_fork_guards.js` 顶部的
`SELF_REFERENTIAL`（改现有文件、走 review），别在文档里想别的花招。

**注意 `scripts/fork-guard.mjs` 不管 `*.md` 文档和 `scripts/screenshot.js` 里的选择器断言**，
那部分只能靠这条 grep + 人读。

---

## 6. 最易漏的一段：自动合并、无冲突、但双方都大改的文件

冲突会强迫你看；**自动合并的文件没人看**。双方都改过同一个文件、改动又不重叠时，git 会安静地把两边拼在一起，
拼出来的东西可能语义冲突（一边删了函数、另一边在调它）。

```sh
# 合并前先记下 main 的 SHA
git rev-parse main          # 记为 $BEFORE

# 合并后，看这段区间里 tests/ 到底动了多少
git diff --stat $BEFORE..HEAD -- tests/
git diff --stat $BEFORE..HEAD -- diagnose/ assets/ data/ sw.js index.html
```

把 `--stat` 里「上游也改过」（用 `git log --oneline $BEFORE..upstream/main -- <file>` 查）
且行数变动大的文件逐个读一遍。重点读 `tests/` —— 测试被自动合并成「两边断言都在、但互相矛盾」时，
只有人读得出来。

---

## 7. 上游动了数据集，就要重算守恒与阈值

当前数据集（2026-11-07 实测，`data/stats.json` + `data/questions.json`）：

```sh
node -e "const s=require('./data/stats.json');console.log('nodes',s.total.topics,'edges',s.total.edges)"
node -e "console.log('questions',require('./data/questions.json').length)"
```

→ **节点 3297 / 边 4868 / 题 13335**（课标 786 条）。

下面这些常量都是**照这批数据调出来的**，数据一变它们就该跟着变，但**套件不会叫**：

```sh
grep -n "var GRADE_GAP" diagnose/engine.js          # GRADE_GAP = 6   （跨年级截断 6 年）
grep -n "var PRIMARY_MAX" diagnose/route.js         # PRIMARY_MAX = 6 （小学先修最多回溯 6 个）
grep -n "SCREEN_GATE" diagnose/app.js               # SCREEN_GATE_TARGETS = 12 / SCREEN_GATE_BUNDLES = 3（题库门）
grep -n "REQ_CAP" tests/test_payload_budget.js      # home 13 / explore 14 / diagnose 17（每页首屏请求数上限）
```

上游动了数据（新增学科、新增年级、题目增删）时，按顺序做：

1. 重算上面四个数，确认守恒（题目总数 = 各 bundle 之和 = `questions-index.json` 覆盖的题数）；
2. **重生成拆分产物**，不要手改：

   ```sh
   node scripts/build-questions-split.mjs    # data/questions/*.json + data/questions-index.json
   node scripts/build-topics-lite.mjs        # data/topics-lite.json（首屏渲染）
   node scripts/build-payload-split.mjs      # 首屏 payload 拆分产物
   ```

3. 再跑 `node tests/test_data_split.js && node tests/test_questions_split.js`（守恒 / 抽样 / gzip 预算）；
4. 首屏请求数（13/14/17）如果变了，**先实算再改常量** —— 常量是上限，不是目标值；
   改之前先问「多出来这个请求是必要的吗」，能挪到门后 / 懒加载就挪。

---

## 8. 上游整段覆盖会「静默退化」的四处

这四处共同点：**上游整段覆盖后语法没错、套件可能还是绿的，功能悄悄没了**。合并后逐个 `git diff` 看。

### 8.1 `diagnose/llm-config.js` —— 型号唯一真源

型号 `DEFAULT_MODEL = 'DeepSeek-V4.1-Flash-1017-Unlimited'`（本文件第 52 行）、网关地址、超时都在这一处，
explain / labmatch / llm-gateway / route / llm-variants 全部从它取值。

守卫 `(h)` **只盯字面量**：它检查「这个文件里型号对不对」+「其它文件里不许再出现型号/网关字面量」。
所以上游如果把整段实现覆盖成自己的（比如换回它自己的 base 解析、或者把 fail-closed 改成静默吞掉），
字面量还在、守卫还是绿的，但**行为已经退化**。型号一失效，画板语义匹配整层 fail-closed ——
所有讲解页都不挂画板，测试全绿（`docs/fork-divergences.md` 第 8 条）。

```sh
git diff $BEFORE..HEAD -- diagnose/llm-config.js
node tests/test_llm_settings.js && node tests/test_labmatch.js
```

### 8.2 `sw.js` 的 `VERSION`

```sh
grep -n "var VERSION" sw.js        # 当前 v10
```

`SHELL` / `DATA` 列表变了、或数据结构变了，`VERSION` 必须加一。上游改了缓存列表却留着旧 `VERSION`，
**老客户端的缓存永远不刷新**：本地看着正常，线上用户看到的还是旧代码。`node tests/test_sw_preheat.js` 会查一致性，
但「该不该加一」还是要人判断。

### 8.3 诊断页首屏三个脚本的顺序

```sh
grep -n "<script" diagnose/index.html      # chapter.js → lazyload.js → app.js（85–87 行）
```

顺序有依赖：`app.js` 用到 `chapter.js` 的章节键与 `lazyload.js` 的懒加载入口。上游插入/重排 script 标签时，
页面不报错、控制台可能只有一条 warn，但章节取不到、题库门退回全量。合并后按第 5 节 ③ 真跑一遍整年级诊断。

### 8.4 `data/` 的拆分产物

`data/questions/*.json`（按 学科|年级|章节 切分的 bundle）、`data/questions-index.json`、`data/topics-lite.json`
都是 `data/questions.json` / `data/topics.json` 的**派生品**。上游只覆盖其中一部分（比如只提交了
`questions.json` 却带着旧的 bundle），就会出现「索引说有、bundle 里没有」——
单点出题静默回退到 `topics.json` 的兜底题，看起来像「题目质量下降」，查半天查不出。

```sh
node scripts/build-questions-split.mjs && node scripts/build-topics-lite.mjs
node tests/test_questions_split.js && node tests/test_data_split.js
```

---

## 9. 收尾

```sh
cd /Users/apple/github/cn-math-taxonomy      # 主仓库根目录
git merge --ff-only wt/sync                  # main 前进到合并结果
git worktree remove .worktrees/sync
git branch -d wt/sync
git status --porcelain                       # 应为空
```

`push` 需要人工确认（本仓库约定：commit 可以自己做，push 必须经人同意）。

---

## 实测记录（2026-11-02，落后 0 时）

| 命令 | 实际输出 |
|---|---|
| `git rev-list --count main..upstream/main` | `0` |
| `git rev-list --count upstream/main..main` | `166` |
| `git diff --name-only main...upstream/main \| wc -l` | `0` |
| `git merge-tree --write-tree main upstream/main` | 只打印一个 tree OID，无 `CONFLICT` 行（退出码 0） |
| `node scripts/fork-guard.mjs`（连跑两遍） | `0 fixed, 8 clean, 0 warn`，退出码 0 |
| `node tests/test_fork_guards.js` | `全部通过：18 passed, 0 failed` |
| 全量测试 | `total passed: 1131 total failed: 0`（24 个文件） |
| `bash scripts/upstream-sync.sh` | `结论：无需同步`，退出码 0 |
| `bash scripts/upstream-sync.sh`（上游提前 1 个提交、删除 `assets/stats-config.js`） | `结论：需同步：1 个提交、1 个冲突文件`，退出码 1 |
| `bash scripts/upstream-sync.sh`（上游只新增一个文件） | `结论：需同步：1 个提交、0 个冲突文件`，退出码 2 |
| `bash scripts/upstream-sync.sh`（在没有 upstream remote 的临时仓库里） | 打印 `git remote add upstream …` 三行，退出码 3 |
| `git worktree add -b wt/sync .worktrees/sync main` | 正常创建；`git worktree remove` + `git branch -d` 正常回收 |
| `node scripts/build-questions-split.mjs` | `894 个 bundle、12135 题`，幂等（跑完 `git status` 不变） |
| `node scripts/build-topics-lite.mjs` | `2997 条 → data/topics-lite.json（579292 字节）`，幂等 |
| `node scripts/build-payload-split.mjs` | `topics-detail 894 个文件`，清理陈旧文件 0，幂等 |
| `node scripts/serve.js` + `curl 127.0.0.1:8920/` | `HTTP 200`，`data/questions-index.json` 正常返回 |
| 第 5 节四条验收命令 | `--diff-filter=U` 空、`^<<<<<<<` 无命中、分叉删除项 grep 无命中 |

造「需同步」状态有个坑：**`git update-ref refs/remotes/upstream/main dc764bd~5` 不会变成「需同步」** ——
`dc764bd~5` 是 `main` 的祖先（`main` 已包含 `dc764bd`），落后照样是 0。要造就得让上游侧真有一笔 `main` 里没有的提交。
本轮的做法：用 `git commit-tree` 在 `dc764bd` 上造两笔一次性提交 —— 一笔删除 `assets/stats-config.js`
（与本地改动撞成 modify/delete 冲突），一笔只新增一个文件（不冲突），跑完 `git update-ref refs/remotes/upstream/main`
恢复成 `dc764bd`。

未在本轮实跑的：`git fetch`（联网项，只写不跑）、`git merge --ff-only wt/sync`
（落后 0，没有可合的内容；2026-11-07 那一轮也仍未跑 —— `main` 还没快进到合入结果）。
`git merge --no-ff upstream/main` 已在 2026-11-07 那次合入里真跑，输出见下一节的表。

---

## 实测记录（2026-11-07，合入上游 `dc764bd..cf73951`）

这一轮是上面 SOP 第一次**完整走通**（前面几轮都停在「落后 0」）。实际命令与输出：

| 命令 | 实际输出 |
|---|---|
| `bash scripts/upstream-sync.sh`（不 fetch，基准 `main` `b4167cd`） | `落后（main..upstream/main）：11 个提交` / `领先（upstream/main..main）：253 个提交` / `上游改动的文件：52 个`；`merge-tree` 干跑冲突 5 个文件：`README.md`、`assets/home.js`、`diagnose/app.js`、`diagnose/engine.js`、`sw.js`；结论「需同步：11 个提交、5 个冲突文件」，**退出码 1** |
| `git merge-base HEAD upstream/main` | `cf73951`（= 上游 HEAD；合入结果里上游已全含） |
| `git rev-list --count upstream/main..HEAD`（集成分支 `wt/up-integ` 头 `2816bc6`） | `264`；按 `main` 量是 `253` |
| `git log --oneline dc764bd..cf73951` | 11 行：`cf73951` 新增初中语文 / `972f9bb` 化学配图 / `3e07669` 重触发 Pages / `7dad0da` 新增初中化学 / `276b88c` 地理配图 / `faaf902` 生物配图 / `08959e4` 新增初中生物 / `63757ad` 删「AI 生成初稿」声明 / `d95bb9b` README 突出商业授权 / `c935017` #33 勘误 / `74de284` #32 教材对照 |
| `git merge --no-ff upstream/main` | 合并提交 `9f1d340`（父 `b4167cd` + `cf73951`），5 个冲突按 `docs/fork-divergences.md` 解；随后 `3b151ad` 重生成全部拆分产物、`b114b38` 上调测试的学科枚举与总数 |
| `node scripts/build-questions-split.mjs` | `948 个 bundle、13335 题`（合入前 894 / 12135；本轮实测 `data/questions/*.json` 有 948 个文件） |
| `node scripts/build-topics-lite.mjs` | `3297 条 → data/topics-lite.json`（640106 字节；合入前 2997 条） |
| `node scripts/build-payload-split.mjs` | `topics-detail 948 个文件`（合入前 894；本轮实测 948） |
| `node scripts/fork-guard.mjs`（连跑两遍） | 两遍都是 `0 fixed, 8 clean, 0 warn`，退出码 0 —— **本轮上游回流 0 处**，第一遍就没有需要清理的东西（前四张卡都按分叉表解的冲突） |
| `node tests/test_fork_guards.js` | `全部通过：18 passed, 0 failed` |
| 全量测试（39 个 `tests/test_*.js` 逐个 `node --test`） | `39/39 rc=0`；SOP 第 4 节那条 awk 聚合打印 `total passed: 1437 total failed: 5`，那 5 是 `tests/test_socratic_gate.js` 的 `passed=5 failed=0` 被误匹配（真实 failed 0） |
| `python3 scripts/validate.py` | `VALIDATION PASSED`，退出码 0（3297 点 / 13335 题 / 课标 items 786） |
| `node scripts/measure_funclab_coverage.js` 等三条 measure 脚本 | 三条都退出码 0；高中口径 stdout 576 行，与 `docs/highschool-funclab-coverage.md` 的 §0–§7 只差 3 处（§0 分母、§1 初中行、文末 `[timing]` 行） |
| 数据守恒（合入前后） | 点 2997 → **3297**；边 4456 → **4868**；题 12135 → **13335**；课标 734 → **786**；bundle / topics-detail 894 → **948** |
