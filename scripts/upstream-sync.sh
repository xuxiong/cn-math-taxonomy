#!/usr/bin/env bash
# upstream-sync.sh —— 上游同步「只读体检」：只报告差多少、干跑会不会冲突，不动任何东西。
#
# 用法：
#   scripts/upstream-sync.sh            不联网，只对本地已有的 upstream/main 出报告
#   scripts/upstream-sync.sh --fetch    先 git fetch upstream main（代理由调用者设环境变量：
#                                       HTTPS_PROXY=http://127.0.0.1:7890 scripts/upstream-sync.sh --fetch）
#
# 退出码：
#   0 = 无需同步（落后 0 个提交）
#   1 = 需同步，且干跑有冲突（冲突文件清单见输出）
#   2 = 需同步，但干跑无冲突（可自动合并）
#   3 = 前置不满足（不在 git 仓库里 / 没有 upstream remote / 没有 refs/remotes/upstream/main）
#
# 硬约束（改本脚本前先读）：
#   - 只读。不写工作区，不 checkout / merge / reset / stash，不改任何 ref。
#   - 不创建任何文件；唯一「写」是 git merge-tree --write-tree 在对象库里留下不可达对象
#     （不影响工作区、索引、ref，git status --porcelain 跑前跑后完全一致）。
#   - 联网只发生在 --fetch 时，且只有一条 git fetch。脚本不硬编码代理。
#
# 背景与后续步骤见 docs/upstream-sync.md。
set -uo pipefail

UPSTREAM_URL='https://github.com/xiaoyang111222/cn-math-taxonomy.git'

usage() {
  cat <<'EOF'
用法：scripts/upstream-sync.sh [--fetch]

  （无参数）  不联网，只对本地已 fetch 的 upstream/main 出报告
  --fetch     先 git fetch upstream main 再出报告
              （要走代理由调用者设环境变量：HTTPS_PROXY=http://127.0.0.1:7890 …）

退出码：0 无需同步 / 1 需同步且有冲突 / 2 需同步但干跑无冲突 / 3 前置不满足
EOF
}

DO_FETCH=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --fetch) DO_FETCH=1 ;;
    -h|--help) usage; exit 0 ;;
    *) printf '未知参数：%s\n\n' "$1" >&2; usage >&2; exit 3 ;;
  esac
  shift
done

ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || {
  printf '错误：当前目录不在 git 仓库里。\n' >&2
  exit 3
}
cd "$ROOT" || exit 3

# 工作区指纹：脚本跑完必须与这里一致（见文件头的硬约束）。
STATUS_BEFORE=$(git status --porcelain)

finish() {
  local code="$1" after
  after=$(git status --porcelain)
  if [ "$after" != "$STATUS_BEFORE" ]; then
    printf '\n警告：git status --porcelain 跑前跑后不一致 —— 本脚本不该写工作区，请检查。\n' >&2
  fi
  exit "$code"
}

# --- 前置 1：有 upstream remote -------------------------------------------------
if ! git remote get-url upstream >/dev/null 2>&1; then
  cat >&2 <<EOF
错误：当前仓库没有名为 upstream 的 remote。

  cd $(printf '%q' "$ROOT")
  git remote add upstream $UPSTREAM_URL
  git fetch upstream main
  scripts/upstream-sync.sh
EOF
  finish 3
fi

# --- 可选：联网 fetch -----------------------------------------------------------
if [ "$DO_FETCH" -eq 1 ]; then
  printf '== git -c http.version=HTTP/1.1 fetch upstream main ==\n'
  if ! git -c http.version=HTTP/1.1 fetch upstream main; then
    printf '警告：fetch 失败（网络 / 代理？）。以下基于本地已有的 upstream/main，可能陈旧。\n' >&2
  fi
  printf '\n'
fi

# --- 前置 2：有 upstream/main ---------------------------------------------------
if ! git rev-parse --verify --quiet refs/remotes/upstream/main >/dev/null; then
  printf '错误：本地还没有 refs/remotes/upstream/main。\n先拉一次：git fetch upstream main（或本脚本加 --fetch）\n' >&2
  finish 3
fi

# --- 基准分支 ------------------------------------------------------------------
BASE=main
if ! git rev-parse --verify --quiet refs/heads/main >/dev/null; then
  BASE=$(git rev-parse --abbrev-ref HEAD)
  printf '提示：本地没有 main 分支，按当前分支 %s 比较。\n\n' "$BASE"
fi

BEHIND=$(git rev-list --count "$BASE"..upstream/main)
AHEAD=$(git rev-list --count upstream/main.."$BASE")
FILES=$(git diff --name-only "$BASE...upstream/main" | wc -l | tr -d ' ')

printf '基准分支：%s  %s\n' "$BASE" "$(git log -1 --format='%h %s' "$BASE")"
printf '上游 HEAD：%s\n\n' "$(git log -1 --format='%h %s' upstream/main)"
printf '落后（%s..upstream/main）：%s 个提交\n' "$BASE" "$BEHIND"
printf '领先（upstream/main..%s）：%s 个提交\n' "$BASE" "$AHEAD"
printf '上游改动的文件：%s 个\n\n' "$FILES"

if [ "$BEHIND" -gt 0 ]; then
  printf '== 上游新提交（最多 20 行）==\n'
  git log -n 20 --no-decorate --oneline "$BASE"..upstream/main
  if [ "$BEHIND" -gt 20 ]; then
    printf '…（另有 %s 个未列出，完整列表：git log --oneline %s..upstream/main）\n' "$((BEHIND - 20))" "$BASE"
  fi
  printf '\n'
fi

# --- 干跑合并：只看冲突 ---------------------------------------------------------
# 只用 --write-tree 的干跑结果，不碰工作区。冲突行形如：
#   CONFLICT (content): Merge conflict in a/b.js
#   CONFLICT (modify/delete): a/x.js deleted in <oid> and modified in main. …
MERGE_RAW=$(git merge-tree --write-tree --name-only "$BASE" upstream/main 2>&1)
MERGE_RC=$?
CONFLICTS=$(printf '%s\n' "$MERGE_RAW" \
  | sed -n 's/^CONFLICT ([^)]*): //p' \
  | sed -e 's/^Merge conflict in //' \
        -e 's/ deleted in .*//' \
        -e 's/ renamed in .*//' \
        -e 's/ modified in .*//' \
  | sort -u)
COUNT=0
if [ -n "$CONFLICTS" ]; then
  COUNT=$(printf '%s\n' "$CONFLICTS" | grep -c .)
fi

printf '== merge-tree 干跑（不改工作区）==\n'
if [ "$COUNT" -eq 0 ]; then
  printf '冲突文件：0 个\n\n'
else
  printf '冲突文件：%s 个\n' "$COUNT"
  printf '%s\n' "$CONFLICTS" | sed 's/^/  - /'
  printf '\n'
fi

# --- 结论与退出码 ---------------------------------------------------------------
if [ "$BEHIND" -eq 0 ]; then
  printf '结论：无需同步\n'
  finish 0
fi

if [ "$MERGE_RC" -ne 0 ] && [ "$COUNT" -eq 0 ]; then
  printf '干跑退出码 %s 但没解析出冲突文件，原始输出：\n%s\n\n' "$MERGE_RC" "$MERGE_RAW"
  printf '结论：需同步：%s 个提交、干跑失败（需人工看）\n' "$BEHIND"
  finish 1
fi

if [ "$COUNT" -gt 0 ]; then
  printf '结论：需同步：%s 个提交、%s 个冲突文件\n' "$BEHIND" "$COUNT"
  printf '下一步：按 docs/upstream-sync.md 在一次性 worktree 里合，冲突先查 docs/fork-divergences.md。\n'
  finish 1
fi

printf '结论：需同步：%s 个提交、0 个冲突文件\n' "$BEHIND"
printf '下一步：按 docs/upstream-sync.md 在一次性 worktree 里合；无冲突也要走四级验收（自动合并的部分最易漏）。\n'
finish 2
