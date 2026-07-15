#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

for command_name in docker pnpm go; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "缺少命令：$command_name" >&2
    exit 1
  fi
done

ENV_FILE=""
if [[ -f .env.local ]]; then
  ENV_FILE=".env.local"
elif [[ -f .env ]]; then
  ENV_FILE=".env"
else
  cp .env.example .env.local
  ENV_FILE=".env.local"
  echo "已从 .env.example 创建 .env.local；LLM 等可选能力需要补充真实密钥。"
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

export NODE_ENV="development"
export PORT="${PORT:-8090}"
export BILLING_PORT="${BILLING_PORT:-8093}"
export BILLING_BASE_URL="${BILLING_BASE_URL:-http://localhost:${BILLING_PORT}}"
export API_PROXY_TARGET="${API_PROXY_TARGET:-http://localhost:${PORT}}"
export NOVEL_WORKER_HEALTH_PORT="${NOVEL_WORKER_HEALTH_PORT:-8091}"

echo "[1/4] 启动 Docker 数据层（不重建已有容器和数据卷）..."
docker compose -f docker-compose.dev.yml up -d --no-recreate postgres redis billing-postgres minio
echo "按 S3_BUCKET 初始化本地对象存储..."
docker compose -f docker-compose.dev.yml run --rm minio-init

wait_for_postgres() {
  local service="$1"
  local attempts=0
  until docker compose -f docker-compose.dev.yml exec -T "$service" sh -lc 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null 2>&1; do
    attempts=$((attempts + 1))
    if (( attempts >= 60 )); then
      echo "$service 在 60 秒内未就绪" >&2
      exit 1
    fi
    sleep 1
  done
}

wait_for_postgres postgres
wait_for_postgres billing-postgres

echo "[2/4] 生成 Prisma Client 并应用数据库迁移..."
pnpm --filter @ai-assistant/db generate
if [[ "${DEV_SKIP_MIGRATIONS:-0}" != "1" ]]; then
  if ! pnpm --filter @ai-assistant/db exec prisma migrate deploy; then
    echo "警告：本地数据库迁移未完全应用；常见原因是已有数据库结构与迁移记录不一致。" >&2
    echo "开发服务将继续启动。可设置 DEV_SKIP_MIGRATIONS=1 跳过后续迁移尝试。" >&2
  fi
fi

pids=()
cleanup() {
  trap - EXIT INT TERM
  if (( ${#pids[@]} > 0 )); then
    kill "${pids[@]}" >/dev/null 2>&1 || true
    wait "${pids[@]}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

run_background() {
  "$@" &
  pids+=("$!")
}

echo "[3/4] 启动本机服务..."
run_background bash -lc 'cd "$1/services/billing" && exec go run .' _ "$ROOT_DIR"
run_background pnpm --filter @ai-assistant/api dev
run_background pnpm --filter @ai-assistant/api worker:novel:dev
run_background env PORT=5174 API_PROXY_TARGET="$API_PROXY_TARGET" pnpm --filter @ai-assistant/web dev
run_background env PORT=5175 API_PROXY_TARGET="$API_PROXY_TARGET" pnpm --filter @ai-assistant/admin dev

echo "[4/4] 混合开发环境已启动："
echo "  Web:     http://localhost:5174"
echo "  Admin:   http://localhost:5175"
echo "  API:     http://localhost:${PORT}"
echo "  Billing: http://localhost:${BILLING_PORT}"
echo "  Novel Worker health: http://localhost:${NOVEL_WORKER_HEALTH_PORT}"
echo "按 Ctrl+C 停止本机服务；Docker 数据层会继续运行。"

while true; do
  for pid in "${pids[@]}"; do
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      set +e
      wait "$pid"
      status=$?
      set -e
      echo "本机服务进程已退出（PID $pid，状态 $status），正在停止其余服务。" >&2
      exit "$status"
    fi
  done
  sleep 1
done
