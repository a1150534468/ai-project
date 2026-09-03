#!/usr/bin/env bash
# 统计 HEAD 上逐字节原样来自上游导入 commit 的行数。
#
# 判定标准：git blame（默认跟随重命名）把某一行归属给导入 commit 491de0f，
# 就算上游行。不能用「路径是否出现在 491de0f 的树里」来判断 —— 那会漏掉
# 改名/移动后文件里的上游代码。
#
# 用法：
#   scripts/count-upstream-lines.sh                 # 只打总数
#   scripts/count-upstream-lines.sh -v              # 顺带打出每个文件的上游行数（降序）
#   scripts/count-upstream-lines.sh -o out.tsv      # 每文件明细写到 out.tsv
set -uo pipefail

IMPORT_COMMIT="${IMPORT_COMMIT:-491de0f}"
JOBS="${JOBS:-8}"
VERBOSE=0
OUT=""

while [ $# -gt 0 ]; do
  case "$1" in
    -v) VERBOSE=1 ;;
    -o) shift; OUT="$1" ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
  shift
done

cd "$(git rev-parse --show-toplevel)" || exit 1

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

# 逐文件 blame。二进制文件 blame 会失败，计 0。
git ls-files -z | xargs -0 -P "$JOBS" -n 1 sh -c '
  n=$(git blame --line-porcelain HEAD -- "$1" 2>/dev/null | grep -c "^'"$IMPORT_COMMIT"'")
  [ -n "$n" ] || n=0
  printf "%s\t%s\n" "$n" "$1"
' sh > "$TMP"

TOTAL=$(awk -F'\t' '{s+=$1} END {print s+0}' "$TMP")
FILES=$(awk -F'\t' '$1>0 {c++} END {print c+0}' "$TMP")
ALL=$(wc -l < "$TMP" | tr -d ' ')

if [ -n "$OUT" ]; then
  sort -rn "$TMP" > "$OUT"
  echo "明细已写入 $OUT"
fi

if [ "$VERBOSE" = 1 ]; then
  sort -rn "$TMP" | awk -F'\t' '$1>0'
  echo "---"
fi

echo "上游行总数: $TOTAL"
echo "带上游行的文件: $FILES"
echo "受版本管理的文件总数: $ALL"
