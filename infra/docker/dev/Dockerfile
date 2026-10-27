# 开发镜像：只服务本地 compose，不进生产链路。
# 与生产 infra/docker/api/Dockerfile 共用同一个基础镜像，避免 dev/prod node 版本漂移。
FROM node:24-bookworm-slim

ARG NPM_CONFIG_REGISTRY=https://registry.npmmirror.com
ARG PRISMA_ENGINES_MIRROR=https://registry.npmmirror.com/-/binary/prisma
ENV npm_config_registry=${NPM_CONFIG_REGISTRY}
ENV PRISMA_ENGINES_MIRROR=${PRISMA_ENGINES_MIRROR}

# argon2 在 pnpm-workspace.yaml 的 allowBuilds 里，没有工具链装不上。
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@10.26.2 --no-audit --no-fund

WORKDIR /repo

# 依赖层：只有 package.json / lockfile 变化才重跑。
# COPY 清单与 pnpm-lock.yaml 的 importers 一一对应（root + api/web/admin + 5 个 packages）。
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/admin/package.json apps/admin/package.json
COPY packages/article-workflow/package.json packages/article-workflow/package.json
COPY packages/codex-pet-pipeline/package.json packages/codex-pet-pipeline/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/llm/package.json packages/llm/package.json
COPY packages/novel-workflow/package.json packages/novel-workflow/package.json
RUN pnpm install --frozen-lockfile

# Prisma Client 层：只有 schema 变化才重跑。
# 生成物在 node_modules（prisma-client-js 默认位置），不会被运行时 bind mount 的 src 遮蔽。
COPY packages/db/prisma packages/db/prisma
RUN pnpm --filter @ai-assistant/db generate

# 源码层：.dockerignore 已排除 node_modules / .env* / *.test.ts / dist 等。
COPY tsconfig.base.json ./
COPY apps apps
COPY packages packages

ENV NODE_ENV=development
