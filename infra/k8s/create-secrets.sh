#!/usr/bin/env bash
# 读 secrets.env（gitignore）幂等地【增量】写入 ai-assistant ns 的两个 Secret。
#
# ⚠️ 语义 = merge patch（只增改、绝不删）。历史教训：旧版用
#   `kubectl create secret --dry-run=client -o yaml | kubectl apply -f -`
# 是【整体替换】。线上 Secret 曾被手工加过 S3_BUCKET/S3_ENDPOINT/S3_REGION/
# S3_PUBLIC_BASE_URL/S3_FORCE_PATH_STYLE/TOAPIS_API_KEY 等 key，而脚本不写这些，
# 跑一次就会把它们连同 S3 AK/SK 一起抹掉 → 知识库/图片视频生成/数字人存储全崩。
# 现在改为 merge patch，且【空值一律跳过】（避免用空串覆盖线上真实值）。
#
# 用法: KUBE_CONTEXT=<your-context> ./create-secrets.sh [path-to-secrets.env]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${1:-$HERE/secrets.env}"
NS=ai-assistant
# context 陷阱：本机默认 context 可能是别的集群（如本地 kind），绝不能凭当前 context 写生产 Secret。
# 新仓库不绑定旧集群；部署时必须显式指定 KUBE_CONTEXT。
KCTX="${KUBE_CONTEXT:-}"
[ -n "$KCTX" ] || { echo "ERROR: 请先设置 KUBE_CONTEXT=<your-kube-context>" >&2; exit 1; }
kubectl config get-contexts -o name | grep -qx "$KCTX" || { echo "ERROR: kubectl context '$KCTX' 不存在" >&2; exit 1; }
echo "使用 context=$KCTX namespace=$NS"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE 不存在。先 cp secrets.env.example secrets.env 并填真实值（建议 chmod 600）。" >&2
  exit 1
fi
# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a

: "${SESSION_SECRET:?缺 SESSION_SECRET}"
: "${DATABASE_URL:?缺 DATABASE_URL}"
: "${REDIS_URL:?缺 REDIS_URL}"
: "${BAILIAN_WORKSPACE_ID:?缺 BAILIAN_WORKSPACE_ID}"
: "${BAILIAN_API_KEY:?缺 BAILIAN_API_KEY}"
: "${BILLING_INTERNAL_TOKEN:?缺 BILLING_INTERNAL_TOKEN}"
: "${BILLING_DATABASE_URL:?缺 BILLING_DATABASE_URL}"
: "${ADMIN_SESSION_SECRET:?缺 ADMIN_SESSION_SECRET}"
# 视频生成上游 key 无回退、缺则视频必挂：设为必填。
: "${VIDEO_API_KEY:?缺 VIDEO_API_KEY（视频生成上游 key，先填进 secrets.env）}"
# 其余（IMAGE_API_KEY / GPT_IMAGE_API_KEY / CHATGPT_API_KEY / S3_* / EPAY_* / SKYHUMAN_* / MIMO_*）可空；
# IMAGE_API_KEY 为空时生图复用 BAILIAN_API_KEY：
# 空 => 本次不写该 key，线上原值保持不变；对应功能按各自的降级路径处理。

TMP="$(mktemp -d)"   # mktemp -d 默认 0700
trap 'rm -rf "$TMP"' EXIT

API_KEYS=(
  SESSION_SECRET DATABASE_URL REDIS_URL BAILIAN_WORKSPACE_ID BAILIAN_API_KEY LLM_API_KEY
  IMAGE_API_KEY GPT_IMAGE_API_KEY GPT_IMAGE_EDIT_API_KEY CHATGPT_API_KEY VIDEO_API_KEY TOAPIS_API_KEY
  ARK_API_KEY ARK_IMAGE_ENDPOINT
  CODEX_PET_ARTIFACT_SIGNING_SECRET
  BILLING_INTERNAL_TOKEN ADMIN_SESSION_SECRET
  S3_ACCESS_KEY S3_SECRET_KEY
  SKYHUMAN_API_TOKEN SKYHUMAN_CALLBACK_SECRET MIMO_API_KEY
  DUB_PARSE_CLIENT_ID DUB_PARSE_SECRET_KEY
)
BILLING_KEYS=(
  BILLING_DATABASE_URL BILLING_INTERNAL_TOKEN EPAY_PID EPAY_KEY
)

# 用 --patch-file 而非 -p '<json>'，避免密钥出现在进程 argv（ps 可见）。
patch_secret() {
  local name="$1"; shift
  kubectl --context "$KCTX" get secret "$name" -n "$NS" >/dev/null 2>&1 \
    || kubectl --context "$KCTX" create secret generic "$name" -n "$NS" >/dev/null

  local file="$TMP/$name.json"
  if ! python3 - "$@" > "$file" <<'PY'
import os, sys, json
data = {k: os.environ[k] for k in sys.argv[1:] if os.environ.get(k, "").strip() != ""}
if not data:
    sys.exit(9)
json.dump({"stringData": data}, sys.stdout)
PY
  then
    echo "  $name: secrets.env 中无非空值可写，跳过"
    return 0
  fi

  kubectl --context "$KCTX" patch secret "$name" -n "$NS" --type=merge --patch-file "$file" >/dev/null
  # 只回显写入了哪些 key，绝不回显值
  python3 -c 'import json,sys; print("  " + sys.argv[2] + ": 已写入 " + ", ".join(sorted(json.load(open(sys.argv[1]))["stringData"])))' "$file" "$name"
}

patch_secret ai-assistant-api-secrets "${API_KEYS[@]}"
patch_secret ai-assistant-billing-secrets "${BILLING_KEYS[@]}"

echo "完成（merge patch：只增改，未删除任何既有 key）"
