# api + worker: 同一镜像、tsx 直跑源码。编译工具只留在 builder。
FROM gcr.io/distroless/static-debian12:nonroot AS certs

FROM node:24-bookworm-slim AS builder
WORKDIR /repo
COPY --from=certs /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
RUN printf 'deb https://repo.huaweicloud.com/debian bookworm main contrib non-free non-free-firmware\ndeb https://repo.huaweicloud.com/debian bookworm-updates main contrib non-free non-free-firmware\ndeb https://repo.huaweicloud.com/debian-security bookworm-security main contrib non-free non-free-firmware\n' > /etc/apt/sources.list \
 && rm -f /etc/apt/sources.list.d/debian.sources \
 && apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable
ENV npm_config_registry=https://registry.npmmirror.com
ENV PRISMA_ENGINES_MIRROR=https://registry.npmmirror.com/-/binary/prisma
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/article-workflow/package.json packages/article-workflow/package.json
COPY packages/billing/package.json packages/billing/package.json
COPY packages/codex-pet-pipeline/package.json packages/codex-pet-pipeline/package.json
COPY packages/connector-protocol/package.json packages/connector-protocol/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/llm/package.json packages/llm/package.json
COPY packages/novel-workflow/package.json packages/novel-workflow/package.json
RUN --mount=type=cache,id=ai-assistant-pnpm,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store \
 && pnpm install --frozen-lockfile --filter @ai-assistant/api...
COPY tsconfig.base.json ./
COPY apps/api apps/api
COPY packages packages
RUN pnpm --filter @ai-assistant/db exec prisma generate
RUN cd apps/api && CI=true pnpm prune --prod
RUN --mount=type=cache,id=ai-assistant-pnpm,target=/pnpm/store \
    pnpm install --prod --offline --frozen-lockfile --filter @ai-assistant/api...

FROM node:24-bookworm-slim
WORKDIR /repo
COPY --from=certs /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
RUN printf 'deb https://repo.huaweicloud.com/debian bookworm main contrib non-free non-free-firmware\ndeb https://repo.huaweicloud.com/debian bookworm-updates main contrib non-free non-free-firmware\ndeb https://repo.huaweicloud.com/debian-security bookworm-security main contrib non-free non-free-firmware\n' > /etc/apt/sources.list \
 && rm -f /etc/apt/sources.list.d/debian.sources \
 && apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates ffmpeg fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/*
COPY --from=builder /repo /repo
ENV NODE_ENV=production
EXPOSE 8090
CMD ["/repo/apps/api/node_modules/.bin/tsx", "/repo/apps/api/src/server.ts"]
