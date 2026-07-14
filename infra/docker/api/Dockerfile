# api: pnpm monorepo + tsx 运行时。构建上下文 = 仓库根。
# 单镜像即可（tsx 直跑需源码 + 全量 node_modules，多阶段无收益）。
FROM gcr.io/distroless/static-debian12:nonroot AS certs

FROM node:24-bookworm-slim
WORKDIR /repo
# apt 走华为云 HTTPS 镜像（deb 国际线慢）；openssl+ca-certificates: Prisma 查询引擎连 PG 必需；
# ffmpeg: 视频素材/生成结果时长探测；Noto CJK: 小说 PDF 导出中文字体
COPY --from=certs /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
RUN printf 'deb https://repo.huaweicloud.com/debian bookworm main contrib non-free non-free-firmware\ndeb https://repo.huaweicloud.com/debian bookworm-updates main contrib non-free non-free-firmware\ndeb https://repo.huaweicloud.com/debian-security bookworm-security main contrib non-free non-free-firmware\n' > /etc/apt/sources.list \
 && rm -f /etc/apt/sources.list.d/debian.sources \
 && apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates python3 make g++ ffmpeg fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable
ENV npm_config_registry=https://registry.npmmirror.com
# ① 仅依赖清单 → pnpm install 可缓存层（改业务代码不重装依赖）
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/article-workflow/package.json packages/article-workflow/package.json
COPY packages/billing/package.json packages/billing/package.json
COPY packages/connector-protocol/package.json packages/connector-protocol/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/llm/package.json packages/llm/package.json
COPY packages/novel-workflow/package.json packages/novel-workflow/package.json
RUN pnpm install --frozen-lockfile
# ② 源码（.dockerignore 已排除 node_modules/dist）
COPY . .
# ③ 生成 Prisma client（argon2 原生 addon 已在 pnpm install 阶段按 node24 预编译）
RUN pnpm --filter @ai-assistant/db exec prisma generate
ENV NODE_ENV=production
EXPOSE 8090
CMD ["pnpm", "--filter", "@ai-assistant/api", "exec", "tsx", "src/server.ts"]
