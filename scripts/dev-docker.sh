#!/usr/bin/env bash

# 开发环境容器化一键启动：把 api / 两个 worker / web / admin 全部放进 Docker。
# 方案与决策见 docs/plans/2026-10-22-dev-container.md；宿主模式（pnpm dev /
# scripts/dev-local.sh）原样保留，两条路互为退路。

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v docker >/dev/null 2>&1; then
  echo "缺少命令：docker" >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker daemon 不可用：请先启动 Docker Desktop。" >&2
  exit 1
fi

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "已从 .env.example 创建 .env；LLM 等可选能力需要补充真实密钥。"
fi
if [[ -f .env.local ]]; then
  echo "已层叠加载 .env.local（后者覆盖 .env 同名键，顺序与宿主模式 dev-local.sh 一致）。"
fi

# 只检查业务端口：8090/5174/5175 被 Vite 代理与前端地址硬编码，被占必须明确
# 报错而不是自动换端口。不检查 5433/6380：pg/redis 与 pnpm dev:infra 是同一
# compose 项目的同一批服务，不存在自冲突——不要"补全"这个端口列表。
for port in 8090 5174 5175; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "端口 $port 已被占用（可能是宿主模式 pnpm dev 还在运行）。" >&2
    echo "请先停止占用进程（宿主模式在终端 Ctrl+C），再重试本脚本。" >&2
    exit 1
  fi
done

echo "[1/2] 构建镜像并启动全部服务（首次构建约 4~8 分钟，之后秒级）..."
docker compose -f docker-compose.dev.yml --profile app up -d --build

echo "[2/2] 等待 API 就绪（最长 90 秒）..."
ready=0
for _ in $(seq 1 90); do
  status="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8090/ready || true)"
  if [[ "$status" == "200" ]]; then
    ready=1
    break
  fi
  sleep 1
done
if (( ready == 0 )); then
  echo "API 在 90 秒内未就绪。查看日志：pnpm dev:docker:logs" >&2
  exit 1
fi

echo "开发环境已就绪："
echo "  Web:   http://localhost:5174"
echo "  Admin: http://localhost:5175"
echo "  API:   http://localhost:8090"
echo "  日志:  pnpm dev:docker:logs"
echo "  停止:  pnpm dev:docker:down（不删数据卷）"
