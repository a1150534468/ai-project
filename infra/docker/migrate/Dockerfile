# migrate: 独立小镜像跑 prisma migrate deploy。构建上下文 = 仓库根。
# 主库初始迁移已含 CREATE EXTENSION IF NOT EXISTS vector（应用侧 20260626061702_memory_pgvector）。
FROM gcr.io/distroless/static-debian12:nonroot AS certs

FROM node:24-bookworm-slim
ARG USE_CHINA_APT_MIRROR=true
ARG NPM_CONFIG_REGISTRY=https://registry.npmmirror.com
ARG PRISMA_ENGINES_MIRROR=https://registry.npmmirror.com/-/binary/prisma
COPY --from=certs /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
RUN if [ "$USE_CHINA_APT_MIRROR" = true ]; then \
      printf 'deb https://repo.huaweicloud.com/debian bookworm main contrib non-free non-free-firmware\ndeb https://repo.huaweicloud.com/debian bookworm-updates main contrib non-free non-free-firmware\ndeb https://repo.huaweicloud.com/debian-security bookworm-security main contrib non-free non-free-firmware\n' > /etc/apt/sources.list; \
      rm -f /etc/apt/sources.list.d/debian.sources; \
    fi; \
    for attempt in 1 2 3; do \
      if apt-get -o Acquire::Retries=5 update \
        && apt-get -o Acquire::Retries=5 install -y --no-install-recommends openssl ca-certificates; then \
        break; \
      fi; \
      if [ "$attempt" -eq 3 ]; then exit 1; fi; \
      rm -rf /var/lib/apt/lists/*; \
      sleep $((attempt * 10)); \
    done; \
    rm -rf /var/lib/apt/lists/*
WORKDIR /m
ENV PRISMA_ENGINES_MIRROR=${PRISMA_ENGINES_MIRROR}
RUN npm config set registry "$NPM_CONFIG_REGISTRY" \
 && npm config set fetch-retries 5 \
 && npm config set fetch-retry-maxtimeout 120000 \
 && for attempt in 1 2 3; do \
      npm i prisma@6.19.3 --no-audit --no-fund && break; \
      if [ "$attempt" -eq 3 ]; then exit 1; fi; \
      sleep $((attempt * 10)); \
    done \
 && npm cache clean --force
COPY packages/db/prisma /m/prisma
CMD ["/m/node_modules/.bin/prisma", "migrate", "deploy", "--schema", "/m/prisma/schema.prisma"]
