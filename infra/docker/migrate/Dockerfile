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
    # 跟 infra/docker/api/Dockerfile 同一个理由，那边有完整的实测记录：这四个路径把
    # 「本次构建的墙钟时间」和「.so 的 mtime」写进了文件内容，rewrite-timestamp 只改
    # mtime 管不着，留着这一层每次重建都是新 digest，TCR 就不认 Layer already exists。
    rm -rf /var/lib/apt/lists/* /var/log/apt /var/log/dpkg.log /var/log/alternatives.log \
      /var/cache/ldconfig/aux-cache
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
 && npm cache clean --force \
 # 这两个删掉才让 53 MB 的 npm 层可复现（实测：连着 --no-cache 构建两次，只有这一层不同）。
 # /root/.npm/_logs：npm 每次调用都写一个 <ISO 时间戳>-debug-0.log，时间戳在**文件名**里；
 # /tmp/node-compile-cache：node 24 给 npm 自己开的 V8 code cache，539 个 blob 两次构建
 # 内容都不一样。rewrite-timestamp 只管 mtime，这两样它都管不着。
 # 必须排在 cache clean 后面：那一句自己也会写一个 log。
 && rm -rf /root/.npm/_logs /tmp/node-compile-cache
COPY packages/db/prisma /m/prisma
CMD ["/m/node_modules/.bin/prisma", "migrate", "deploy", "--schema", "/m/prisma/schema.prisma"]
