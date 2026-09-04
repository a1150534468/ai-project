#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

for command_name in docker pnpm; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "缺少命令：$command_name" >&2
    exit 1
  fi
done

if [[ ! -f .env && ! -f .env.local ]]; then
  cp .env.example .env.local
  echo "已从 .env.example 创建 .env.local；LLM 等可选能力需要补充真实密钥。"
fi

# Both files are layered in the same order as apps/api/src/env.ts: .env carries
# the full base config and .env.local overrides only the keys it names. Sourcing
# just one file meant a partial .env.local (e.g. a single QA override) hid every
# required key in .env, and startup then failed on a missing required variable.
env_files=()
if [[ -f .env ]]; then
  env_files+=(".env")
fi
if [[ -f .env.local ]]; then
  env_files+=(".env.local")
fi

# bash 3.2 treats "${empty[@]}" as an unbound variable under `set -u`, so the
# emptiness is reported here rather than as a cryptic expansion error.
if (( ${#env_files[@]} == 0 )); then
  echo "未找到 .env 或 .env.local，且无法从 .env.example 创建。" >&2
  exit 1
fi

set -a
for env_file in "${env_files[@]}"; do
  # shellcheck disable=SC1090
  source "$env_file"
done
set +a

echo "已加载环境变量文件（后者覆盖前者）：${env_files[*]}"

export NODE_ENV="development"
export PORT="${PORT:-8090}"
export API_PROXY_TARGET="${API_PROXY_TARGET:-http://localhost:${PORT}}"
export NOVEL_WORKER_HEALTH_PORT="${NOVEL_WORKER_HEALTH_PORT:-8091}"
export CODEX_PET_WORKER_HEALTH_PORT="${CODEX_PET_WORKER_HEALTH_PORT:-8092}"
# Local development may use HTTP so the signed-artifact route can be exercised
# without a TLS proxy. Production validation in codex-pet-routes still requires
# an explicit HTTPS CODEX_PET_PUBLIC_BASE_URL.
export CODEX_PET_PUBLIC_BASE_URL="${CODEX_PET_PUBLIC_BASE_URL:-http://localhost:${PORT}}"

echo "[1/4] 启动 Docker 数据层（不重建已有容器和数据卷）..."
docker compose -f docker-compose.dev.yml up -d --no-recreate postgres redis minio
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

echo "[2/4] 生成 Prisma Client 并应用数据库迁移..."
pnpm --filter @ai-assistant/db generate
if [[ "${DEV_SKIP_MIGRATIONS:-0}" != "1" ]]; then
  if ! pnpm --filter @ai-assistant/db exec prisma migrate deploy; then
    echo "警告：本地数据库迁移未完全应用；常见原因是已有数据库结构与迁移记录不一致。" >&2
    echo "开发服务将继续启动。可设置 DEV_SKIP_MIGRATIONS=1 跳过后续迁移尝试。" >&2
  fi
fi

pids=()
pgids=()
process_names=()
stuck_counts=()
cleanup_started=0

cleanup() {
  if (( cleanup_started )); then
    return
  fi
  cleanup_started=1

  if (( ${#pgids[@]} == 0 )); then
    return
  fi

  echo "正在停止本机服务..."

  # Each service is started in its own process group. Signalling the whole
  # group also reaches grandchildren created by pnpm, tsx, Vite and esbuild.
  for pgid in "${pgids[@]}"; do
    kill -TERM -- "-$pgid" >/dev/null 2>&1 || true
  done

  local deadline=$((SECONDS + 10))
  local any_alive
  while (( SECONDS < deadline )); do
    any_alive=0
    for pgid in "${pgids[@]}"; do
      if kill -0 -- "-$pgid" >/dev/null 2>&1; then
        any_alive=1
        break
      fi
    done
    if (( any_alive == 0 )); then
      break
    fi
    sleep 0.2
  done

  # A process stuck in macOS's E (exiting) state may ignore TERM indefinitely.
  # KILL is only used after the grace period, and only for tracked groups.
  for pgid in "${pgids[@]}"; do
    if kill -0 -- "-$pgid" >/dev/null 2>&1; then
      kill -KILL -- "-$pgid" >/dev/null 2>&1 || true
    fi
  done

  for pid in "${pids[@]}"; do
    wait "$pid" >/dev/null 2>&1 || true
  done
}

handle_exit() {
  local status="$1"
  trap - EXIT INT TERM HUP
  cleanup
  exit "$status"
}

handle_signal() {
  local signal_name="$1"
  local status="$2"
  trap - EXIT INT TERM HUP
  echo "收到 ${signal_name}，准备停止本机服务..." >&2
  cleanup
  exit "$status"
}

trap 'handle_exit $?' EXIT
trap 'handle_signal INT 130' INT
trap 'handle_signal TERM 143' TERM
trap 'handle_signal HUP 129' HUP

# Monitor mode gives every background job a separate process group whose PGID
# is the PID returned in $!. This remains reliable even after a child is
# re-parented to launchd because an intermediate watcher exits unexpectedly.
set -m

run_background() {
  local process_name="$1"
  shift

  "$@" &
  local pid="$!"
  pids+=("$pid")
  pgids+=("$pid")
  process_names+=("$process_name")
  stuck_counts+=(0)
}

group_has_stuck_process() {
  local pgid="$1"
  local states
  states="$(ps -o state= -g "$pgid" 2>/dev/null || true)"
  [[ "$states" == *E* || "$states" == *Z* ]]
}

echo "[3/4] 启动本机服务..."
run_background "API" pnpm --filter @ai-assistant/api dev
run_background "Novel Worker" pnpm --filter @ai-assistant/api worker:novel:dev
run_background "Codex Pet Worker" pnpm --filter @ai-assistant/api worker:codex-pet:dev
run_background "Web" env PORT=5174 API_PROXY_TARGET="$API_PROXY_TARGET" pnpm --filter @ai-assistant/web dev
run_background "Admin" env PORT=5175 API_PROXY_TARGET="$API_PROXY_TARGET" pnpm --filter @ai-assistant/admin dev

echo "[4/4] 混合开发环境已启动："
echo "  Web:     http://localhost:5174"
echo "  Admin:   http://localhost:5175"
echo "  API:     http://localhost:${PORT}"
echo "  Novel Worker health: http://localhost:${NOVEL_WORKER_HEALTH_PORT}"
echo "  Codex Pet Worker health: http://localhost:${CODEX_PET_WORKER_HEALTH_PORT}"
echo "按 Ctrl+C 停止本机服务；Docker 数据层会继续运行。"

while true; do
  for index in "${!pids[@]}"; do
    pid="${pids[$index]}"
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      set +e
      wait "$pid"
      status=$?
      set -e
      # The braces are required: under a UTF-8 locale, bash 3.2 (macOS /bin/bash)
      # folds the leading byte of a following multibyte character into an
      # unbraced name, so "$pid，" expanded as the unset variable "pid<0xef>"
      # and `set -u` aborted the loop instead of reporting the real failure.
      echo "${process_names[$index]} 已退出（PID ${pid}，状态 ${status}），正在停止其余服务。" >&2
      exit "$status"
    fi

    # E/Z normally lasts for only an instant. Five consecutive observations
    # indicate a wedged watcher or an unreaped child rather than a normal exit.
    if group_has_stuck_process "${pgids[$index]}"; then
      stuck_counts[$index]=$((stuck_counts[$index] + 1))
      if (( stuck_counts[$index] >= 5 )); then
        echo "${process_names[$index]} 的进程组持续处于 E/Z 状态，正在停止全部本机服务。" >&2
        exit 1
      fi
    else
      stuck_counts[$index]=0
    fi
  done
  sleep 1
done
