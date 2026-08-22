# api + worker: 同一镜像、tsx 直跑源码。编译工具只留在 builder。
FROM gcr.io/distroless/static-debian12:nonroot AS certs
FROM mwader/static-ffmpeg:7.1@sha256:a8090df5f5608daef387e1b2e93b98aaacb4d92153ad904e7d715c725724fca4 AS ffmpeg

FROM node:24-bookworm-slim AS builder
ARG USE_CHINA_APT_MIRROR=true
ARG NPM_CONFIG_REGISTRY=https://registry.npmmirror.com
ARG PRISMA_ENGINES_MIRROR=https://registry.npmmirror.com/-/binary/prisma
WORKDIR /repo
COPY --from=certs /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
RUN if [ "$USE_CHINA_APT_MIRROR" = true ]; then \
      printf 'deb https://repo.huaweicloud.com/debian bookworm main contrib non-free non-free-firmware\ndeb https://repo.huaweicloud.com/debian bookworm-updates main contrib non-free non-free-firmware\ndeb https://repo.huaweicloud.com/debian-security bookworm-security main contrib non-free non-free-firmware\n' > /etc/apt/sources.list; \
      rm -f /etc/apt/sources.list.d/debian.sources; \
    fi; \
    for attempt in 1 2 3; do \
      if apt-get -o Acquire::Retries=5 update \
        && apt-get -o Acquire::Retries=5 install -y --no-install-recommends openssl ca-certificates python3 make g++; then \
        break; \
      fi; \
      if [ "$attempt" -eq 3 ]; then exit 1; fi; \
      rm -rf /var/lib/apt/lists/*; \
      sleep $((attempt * 10)); \
    done; \
    rm -rf /var/lib/apt/lists/*
ENV npm_config_registry=${NPM_CONFIG_REGISTRY}
ENV npm_config_fetch_retries=5
ENV npm_config_fetch_retry_maxtimeout=120000
ENV PRISMA_ENGINES_MIRROR=${PRISMA_ENGINES_MIRROR}
RUN for attempt in 1 2 3; do \
      npm install -g pnpm@10.26.2 --no-audit --no-fund && break; \
      if [ "$attempt" -eq 3 ]; then exit 1; fi; \
      sleep $((attempt * 10)); \
    done
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
 && for attempt in 1 2 3; do \
      pnpm install --frozen-lockfile --filter @ai-assistant/api... && exit 0; \
      if [ "$attempt" -eq 3 ]; then exit 1; fi; \
      sleep $((attempt * 10)); \
    done
COPY tsconfig.base.json ./
COPY apps/api apps/api
COPY packages packages
RUN pnpm --filter @ai-assistant/api deploy --prod --legacy /runtime/repo/apps/api \
 && cd /runtime/repo/apps/api \
 && for attempt in 1 2 3; do \
      node_modules/.pnpm/node_modules/.bin/prisma generate \
        --schema node_modules/@ai-assistant/db/prisma/schema.prisma && exit 0; \
      if [ "$attempt" -eq 3 ]; then exit 1; fi; \
      sleep $((attempt * 10)); \
    done

FROM node:24-bookworm-slim
ARG USE_CHINA_APT_MIRROR=true
WORKDIR /repo
COPY --from=certs /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=ffmpeg /ffmpeg /usr/local/bin/ffmpeg
COPY --from=ffmpeg /ffprobe /usr/local/bin/ffprobe
RUN if [ "$USE_CHINA_APT_MIRROR" = true ]; then \
      printf 'deb https://repo.huaweicloud.com/debian bookworm main contrib non-free non-free-firmware\ndeb https://repo.huaweicloud.com/debian bookworm-updates main contrib non-free non-free-firmware\ndeb https://repo.huaweicloud.com/debian-security bookworm-security main contrib non-free non-free-firmware\n' > /etc/apt/sources.list; \
      rm -f /etc/apt/sources.list.d/debian.sources; \
    fi; \
    for attempt in 1 2 3; do \
      if apt-get -o Acquire::Retries=5 update \
        && apt-get -o Acquire::Retries=5 install -y --no-install-recommends openssl ca-certificates fonts-noto-cjk; then \
        break; \
      fi; \
      if [ "$attempt" -eq 3 ]; then exit 1; fi; \
      rm -rf /var/lib/apt/lists/*; \
      sleep $((attempt * 10)); \
    done; \
    rm -rf /var/lib/apt/lists/*
COPY --from=builder /runtime/repo /repo
ENV NODE_ENV=production
EXPOSE 8090
CMD ["/repo/apps/api/node_modules/.bin/tsx", "/repo/apps/api/src/server.ts"]
