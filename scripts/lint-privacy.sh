#!/bin/bash
# 公开仓库隐私门禁：把「内部项目名 / 家目录路径 / 内部域名 / 令牌 / 私钥」挡在提交之前。
#
# 为什么做成脚本：同一个错犯了三次（注释里的 home 路径、README 里的内部身份、
# 注释里的真实分支名），每次都是推送后才发现。人不靠谱，就交给门禁。
#
# 粒度是**新增行**，不是整个文件：门禁只该拦「你这次新写进去的东西」，
# 历史里已有的项目名不是密钥，全量替换风险高收益低。
#
# 用法：
#   bash scripts/lint-privacy.sh            # 门禁：README 全文 + 所有新增行（缺省）
#   bash scripts/lint-privacy.sh --all      # 全量审计（会有历史噪音，供人工判断）
#   bash scripts/lint-privacy.sh f1 f2      # 只查指定文件全文
# 退出码：0 = clean；1 = 有命中
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

PATTERNS=(
  '/Users/[A-Za-z]'          # 家目录绝对路径
  'zhe\.chen'                # 内部账号名
  'sgrl\.io'                 # 内部域名
  'shangri'                  # 内部组织名
  'ghp_[A-Za-z0-9]'          # GitHub PAT
  'github_pat_'              # 细粒度 PAT
  '-----BEGIN'               # 私钥/证书头
)
NAMES=(hs_config spms s360-mobile cxone)

MODE=gate
if [ "${1:-}" = "--all" ]; then MODE=all; shift; fi

check_text() { # $1=内容来源描述 $2=文本
  local where="$1" text="$2" pat
  for pat in "${PATTERNS[@]}" "${NAMES[@]}"; do
    if printf '%s\n' "$text" | grep -v 'allow-privacy' | grep -EI -- "$pat" >/dev/null 2>&1; then
      echo "隐私命中：$pat → $where" >&2
      printf '%s\n' "$text" | grep -v 'allow-privacy' | grep -EI -- "$pat" | head -3 >&2
      return 1
    fi
  done
  return 0
}

bad=0
if [ "$#" -gt 0 ]; then
  # 指定文件：查全文
  for f in "$@"; do
    [ -f "$f" ] || continue
    [ "$(basename "$f")" = 'lint-privacy.sh' ] && continue
    check_text "$f" "$(cat "$f")" || bad=1
  done
elif [ "$MODE" = "all" ]; then
  while IFS= read -r f; do
    [ -f "$f" ] || continue
    [ "$(basename "$f")" = 'lint-privacy.sh' ] && continue
    check_text "$f" "$(cat "$f")" || bad=1
  done < <(
    { find lib test scripts -type f \( -name '*.js' -o -name '*.mjs' -o -name '*.sh' \) 2>/dev/null; ls ./*.md 2>/dev/null; } | sort -u
  )
else
  # 门禁只看**新增行**：md 的历史内容里本来就有项目名，全文检查会永远红。
  # 想全量审计用 --all。
  # 新增行：暂存区与工作区都算，按文件分组只取 `+` 行
  ADDED=$( { git diff --cached -U0 2>/dev/null; git diff -U0 2>/dev/null; } \
            | grep -E '^\+' | grep -v '^+++' | sed 's/^+//' )
  if [ -n "$ADDED" ]; then
    check_text "本次新增行" "$ADDED" || bad=1
  fi
  # 未跟踪的新文件：查全文
  while IFS= read -r f; do
    [ -f "$f" ] || continue
    [ "$(basename "$f")" = 'lint-privacy.sh' ] && continue
    check_text "${f}（新文件）" "$(cat "$f")" || bad=1
  done < <(git ls-files --others --exclude-standard 2>/dev/null)
fi

if [ "$bad" != "0" ]; then
  echo "" >&2
  echo "隐私自检未通过：换中性示例后重跑；确实要保留的行加 \`allow-privacy\` 注释并说明理由。" >&2
  [ "$MODE" = "all" ] && echo "（全量模式的历史命中可人工判断，门禁只看新增。）" >&2
  exit 1
fi
echo "隐私自检通过（${MODE}）"
