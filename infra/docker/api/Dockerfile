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
COPY packages/codex-pet-pipeline/package.json packages/codex-pet-pipeline/package.json
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
# 末尾把 node_modules 挪出 deploy 目录，好让最终阶段分两层 COPY（见下面那两条）。
# mv 必须留在这条 RUN 里：node_modules 是本层自己创建的，同层内 rename 不产生 copy-up；
# 单独开一条 RUN 会让 overlayfs 把整个 node_modules（解压后 ~600 MB）复制进新层，
# 还会被 cache-to mode=max 原样塞进 gha 缓存。为此重试循环的 `exit 0` 改成 `break`
# ——`exit 0` 会直接结束整条 RUN，后面的 mv 根本走不到。
#
# 删 .modules.yaml 是分层能不能省下字节的前提：它里面有一行 `prunedAt: <构建时刻>`，
# 实测两次构建只差这一个文件。buildkit 给 COPY 算的缓存键是内容哈希（忽略 mtime，但看内容），
# 这一行会让 608 MB 那层每次发布都拿到新 digest，TCR 就不再认「Layer already exists」，
# 分层白分。最终镜像里没有 pnpm（只有 builder 装了），没人读这个文件。
RUN pnpm --filter @ai-assistant/api deploy --prod --legacy /runtime/repo/apps/api \
 && cd /runtime/repo/apps/api \
 && for attempt in 1 2 3; do \
      node_modules/.pnpm/node_modules/.bin/prisma generate \
        --schema node_modules/@ai-assistant/db/prisma/schema.prisma && break; \
      if [ "$attempt" -eq 3 ]; then exit 1; fi; \
      sleep $((attempt * 10)); \
    done \
 && mv /runtime/repo/apps/api/node_modules /runtime/node_modules \
 && rm -f /runtime/node_modules/.modules.yaml

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
    # 末尾这串 rm 不是为了瘦身（加起来几十 KB），是为了让这 79 MB 的一层可复现。
    # 实测：同一条 apt RUN 连着 --no-cache 构建两次（SOURCE_DATE_EPOCH=0 与
    # rewrite-timestamp=true 都开着），整层 214 个文件里只有 4 个不一样——
    # /var/log/apt/history.log、term.log、/var/log/dpkg.log 里是本次构建的墙钟时间，
    # /var/cache/ldconfig/aux-cache 里是各个 .so 的 mtime。这四样都写在**文件内容**里，
    # 而 rewrite-timestamp 只改 mtime、改不了内容。删掉之后两次构建的 6 层 diffID 与
    # config digest 全部逐字相同；不删的话缓存一失效，这 79 MB 就要重新过那根
    # 0.15~0.40 MB/s 的出境管子（TCR 认的是 digest，不是「内容差不多」）。
    # alternatives.log 这次没变（装的三个包没触发 update-alternatives），一起删是保险：
    # 它的行同样带时间戳，哪天多装一个包就会变。
    rm -rf /var/lib/apt/lists/* /var/log/apt /var/log/dpkg.log /var/log/alternatives.log \
      /var/cache/ldconfig/aux-cache
# 源码每次提交都变，合成一层就等于每次发布重传全部（v0.1.2 实测那一层压缩后 195.88 MB，
# 而出境只有 0.15~0.40 MB/s）。顺序不能反：buildkit 的层缓存是链式的，把易变的源码放前面
# 会连带把后面那层顶掉。第二条 COPY 不会盖掉 node_modules——builder 里已经 mv 走了，
# 而 COPY 到已存在的目录是合并语义。
COPY --from=builder /runtime/node_modules /repo/apps/api/node_modules
COPY --from=builder /runtime/repo /repo
ENV NODE_ENV=production
EXPOSE 8090
CMD ["/repo/apps/api/node_modules/.bin/tsx", "/repo/apps/api/src/server.ts"]
