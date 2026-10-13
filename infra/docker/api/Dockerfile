# api + worker: 同一镜像、tsx 直跑源码。编译工具只留在 builder。
FROM gcr.io/distroless/static-debian12:nonroot AS certs

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
#
# 下面的剪枝必须留在**这一条 RUN** 里，不能另开一条：另一条 RUN 删文件只会写一条
# whiteout，被删的数据照样留在上一层的 tar 里，镜像体积一分不减。剪枝要生效，就得在
# 内容被 COPY 走之前、在产生它的同一层里删。
#
# 删的四样约 150 MiB（解压）/ 约 55 MiB（压缩）：
#   prisma            66.4 MiB  generate / migrate 用的 CLI，运行时没有任何 import
#   @prisma/engines   35.5 MiB  schema-engine 18.7 MiB + 一份与 .prisma/client 重复的查询引擎
#   typescript        22.5 MiB  tsc；运行时走 tsx（esbuild），不加载它
#   effect            25.9 MiB  prisma.config 的加载器，只出现在 CLI 路径上
# 依据：全仓 grep 不到 `from "effect"`、`from "prisma"`、`prisma/config`、
# `@prisma/engines` 的运行时 import。@prisma/client 真正需要的查询引擎另有一份，在
# node_modules/.prisma/client/libquery_engine-debian-openssl-3.0.x.so.node。
#
# 还要注意 pnpm 的布局：node_modules/<name> 只是指向
# node_modules/.pnpm/<name>@<ver>/node_modules/<name> 的软链，只删软链不减体积，
# 必须删 .pnpm 下的实体目录，外加 .pnpm/node_modules 里那份 hoist 软链。
#
# 顺手删掉 @prisma/client 内部的死代码：15.1 MiB 的 *.map 调试映射，以及非 PostgreSQL 的
# wasm 引擎/编译器（cockroachdb / mysql / sqlserver / sqlite）——那些只有 edge runtime 路径
# 才会 require。项目连的是 PostgreSQL，query_engine_bg / query_compiler_bg 的 postgresql
# 两份保留。
#
# ── 让这层的字节可复现：mtime 归一化（2026-10-13 第二轮实测）────────────────────────
# 【已回退，别再试】上一轮曾把 Prisma 生成物从 node_modules 里搬出去，按「跟不跟 schema
# 变」拆成两层，指望改一次 schema 只重推约 1~2 MB。2026-10-13 逐 blob 实测**证伪**，已还原
# 成单层：改一次 schema 后，68.07 MB 的 node_modules 层与 8.50 MB 的引擎层**同时**换了
# digest（8.50 MB 那层逐条 diff 后内容零差异，纯粹是 mtime），净增出境 77.80 MB ——
# 比不拆时的 77.10 MB 还多。搬出去之所以救不了：schema.prisma 本来就在 node_modules 里 ——
# pnpm deploy 把工作区包 @ai-assistant/db 当 file: 依赖实体化成了
#   node_modules/.pnpm/@ai-assistant+db@file+packages+db/node_modules/@ai-assistant/db/prisma/schema.prisma
# 搬到哪儿都甩不掉这 79 字节，而一层就是一个 blob，改 79 字节也要整层重传。
#
# ── 层的字节到底由什么决定（2026-10-13 实测，别再靠推测）──────────────────────────
# ① `COPY --from=<stage>` 的缓存是**内容寻址**的：被拷的那棵树的**内容**不变，即使上游
#    这条 RUN 因为源码改动重跑了，COPY 依然报 CACHED、层 digest 不变。
#    实测：改 apps/api/src/server.ts 后构建，RUN 重跑 66.4s，而 node_modules 那个 COPY
#    是 CACHED；把下面两行 touch 注释掉、故意让 RUN 的命令也变一次，COPY 还是 CACHED。
#    ⇒ 「改业务源码」本来就不该重传 node_modules，这一条在加归一化之前就成立。
# ② 但 COPY **真的重跑**时（内容变了，或 BuildKit 那边没有这条内容记录），它生成的 tar 里
#    带的是**构建时刻的 mtime**。同一份内容隔 20 秒建两次，diffID 从 79ba7ec1 变成
#    46ce996a，镜像里 mtime 从 12:32:39 变成 12:33:51 —— mtime 实实在在进了 digest。
#    ⇒ 内容没变、但需要重新生成的那一次，会白白重传整层。
#
# 下面两行的作用就是把 ② 这块补上：把「层字节」与「构建时刻」解耦。
# 说清楚它**不**解决什么：内容真变了的层照样整层重传（一层 = 一个 blob，躲不掉）；
# 它能保证的是「同样的内容 ⇒ 同样的字节 ⇒ TCR 认 Layer already exists」。
# 文件先、目录后并非必需（touch 不增删目录项，不会反过来顶掉父目录），但单独再来一遍更保险。
# -h 是必需的：pnpm 布局里满是软链，不加 -h 会跟进去改真实文件的 mtime（甚至跟丢）。
# 另：镜像里所有文件的 mtime 会变成 1970-01-01。已确认 apps/ 与 packages/ 下没有任何代码
# 读 mtime/statSync/utimes，运行时也不受影响（真库往返探针 PROBE_OK）。
#
# 附一条仍然成立、但这里用不到的知识：不能用 `prisma generate --output <dir>` ——
# Prisma 6 的 generate 子命令根本没有 `--output` 这个 flag（生成路径只能写在 schema 的
# generator 块里），传了它会直接打用法帮助并以 1 退出。
RUN pnpm --filter @ai-assistant/api deploy --prod --legacy /runtime/repo/apps/api \
 && cd /runtime/repo/apps/api \
 && for attempt in 1 2 3; do \
      node_modules/.pnpm/node_modules/.bin/prisma generate \
        --schema node_modules/@ai-assistant/db/prisma/schema.prisma && break; \
      if [ "$attempt" -eq 3 ]; then exit 1; fi; \
      sleep $((attempt * 10)); \
    done \
 && mv /runtime/repo/apps/api/node_modules /runtime/node_modules \
 && rm -f /runtime/node_modules/.modules.yaml \
 && rm -rf /runtime/node_modules/.pnpm/prisma@* \
           /runtime/node_modules/.pnpm/@prisma+engines@* \
           /runtime/node_modules/.pnpm/typescript@* \
           /runtime/node_modules/.pnpm/effect@* \
           /runtime/node_modules/.pnpm/node_modules/prisma \
           /runtime/node_modules/.pnpm/node_modules/@prisma/engines \
           /runtime/node_modules/.pnpm/node_modules/typescript \
           /runtime/node_modules/.pnpm/node_modules/effect \
           /runtime/node_modules/prisma \
           /runtime/node_modules/@prisma/engines \
           /runtime/node_modules/typescript \
           /runtime/node_modules/effect \
           /runtime/node_modules/.bin/prisma \
 && find /runtime/node_modules/.pnpm/@prisma+client@* -name '*.map' -delete \
 && find /runtime/node_modules/.pnpm/@prisma+client@* \
      -name 'query_engine_bg.*.wasm-base64.*' -not -name 'query_engine_bg.postgresql.*' -delete \
 && find /runtime/node_modules/.pnpm/@prisma+client@* \
      -name 'query_compiler_bg.*.wasm-base64.*' -not -name 'query_compiler_bg.postgresql.*' -delete \
 && find /runtime -exec touch -h -d @0 {} + \
 && find /runtime -type d -exec touch -h -d @0 {} +

FROM node:24-bookworm-slim
ARG USE_CHINA_APT_MIRROR=true
WORKDIR /repo
COPY --from=certs /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
# 装 openssl + ca-certificates + 中文字体。字体这层 88.8 MiB 里只有一个文件是活的：
# fonts-noto-cjk 装进来 Serif 常规/粗体 + Sans 粗体 + Sans 常规 四个 .ttc，而
# apps/api/src/novel/export.ts 的 cjkFontPath() 只取**一个**路径交给 pdfkit 的
# document.font()（全仓只有 export.ts:114 这一处调用，也不切换粗体），实际命中的永远
# 是 NotoSansCJK-Regular.ttc（18.58 MiB）。下面在**同一层**删掉另外三个，省约 70 MiB
# 解压量。要换字体就设 NOVEL_EXPORT_CJK_FONT 指向别的文件。
#
# 保留 NotoSansCJK-Regular.ttc 而不是把四个都删掉，是因为它是唯一被引用到的那个
# （cjkFontPath() 的第二个候选，也是 Linux 上第一个存在的）。删了它 existsSync 会全部落空、
# 静默回落到内置 Helvetica，中文变方框 —— 那是**改变行为**，不属于瘦身。
#
# 附一条与本次瘦身无关、但 2026-10-13 顺手修掉的既有缺陷：
# 小说 PDF 导出在线上是坏的，报 `TypeError: this.font.createSubset is not a function`
# （瘦身前后镜像逐字相同，不是瘦身引入的）。根因是 pdfkit 0.17.2 的 PDFFontFactory.open →
# `fontkit.create(buffer, family)`：传 .ttc 这种**字体集合**且不带 postscriptName 时，
# fontkit 返回 TrueTypeCollection 对象，而嵌入式字体构造函数要调
# `this.font.createSubset()`，集合没有这个方法。
# 已修在 `apps/api/src/novel/export.ts`（候选表每条带上从字体文件里实测读出的
# postscriptName，并兜住异常降级到内置字体，不再让整个导出 500）。
# 与这层字体相关的一点：保留下来的 `NotoSansCJK-Regular.ttc` 里中文成员的名字是
# `NotoSansCJKsc-Regular`，改成别的名字会让导出静默退回 Helvetica。
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
    # 末尾这串 rm 不是为了瘦身（加起来几十 KB），是为了让这一层可复现。
    # 实测：同一条 apt RUN 连着 --no-cache 构建两次（SOURCE_DATE_EPOCH=0 与
    # rewrite-timestamp=true 都开着），整层 214 个文件里只有 4 个不一样——
    # /var/log/apt/history.log、term.log、/var/log/dpkg.log 里是本次构建的墙钟时间，
    # /var/cache/ldconfig/aux-cache 里是各个 .so 的 mtime。这四样都写在**文件内容**里，
    # 而 rewrite-timestamp 只改 mtime、改不了内容。删掉之后两次构建的 6 层 diffID 与
    # config digest 全部逐字相同；不删的话缓存一失效，这一层就要重新过那根
    # 0.15~0.40 MB/s 的出境管子（TCR 认的是 digest，不是「内容差不多」）。
    # alternatives.log 这次没变（装的三个包没触发 update-alternatives），一起删是保险：
    # 它的行同样带时间戳，哪天多装一个包就会变。
    rm -rf /var/lib/apt/lists/* /var/log/apt /var/log/dpkg.log /var/log/alternatives.log \
      /var/cache/ldconfig/aux-cache; \
    # 三个从不被加载的 .ttc，理由见上面那条 COPY 之前的注释。必须留在这一条 RUN 里：
    # 另开一条 RUN 删文件只会留下 whiteout，被删的数据照样在本层的 tar 里，体积不减。
    rm -f /usr/share/fonts/opentype/noto/NotoSerifCJK-Bold.ttc \
          /usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc \
          /usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc
# 源码每次提交都变，合成一层就等于每次发布重传全部（v0.1.2 实测那一层压缩后 195.88 MB，
# 而出境只有 0.15~0.40 MB/s）。顺序不能反：buildkit 的层缓存是链式的，把易变的源码放前面
# 会连带把后面那层顶掉。第二条 COPY 不会盖掉 node_modules——builder 里已经 mv 走了，
# 而 COPY 到已存在的目录是合并语义。
COPY --from=builder /runtime/node_modules /repo/apps/api/node_modules
COPY --from=builder /runtime/repo /repo
ENV NODE_ENV=production
EXPOSE 8090
CMD ["/repo/apps/api/node_modules/.bin/tsx", "/repo/apps/api/src/server.ts"]
