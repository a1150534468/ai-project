# migrate: 独立小镜像跑 prisma migrate deploy。构建上下文 = 仓库根。
# 主库初始迁移已含 CREATE EXTENSION IF NOT EXISTS vector（应用侧 20260626061702_memory_pgvector）。
FROM node:24-bookworm-slim
# apt 走阿里云源（deb.debian.org 国际线在国内极慢/卡死）
RUN printf 'deb http://mirrors.aliyun.com/debian bookworm main contrib non-free non-free-firmware\ndeb http://mirrors.aliyun.com/debian bookworm-updates main contrib non-free non-free-firmware\ndeb http://mirrors.aliyun.com/debian-security bookworm-security main contrib non-free non-free-firmware\n' > /etc/apt/sources.list \
 && rm -f /etc/apt/sources.list.d/debian.sources \
 && apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /m
ENV PRISMA_ENGINES_MIRROR=https://registry.npmmirror.com/-/binary/prisma
RUN npm config set registry https://registry.npmmirror.com \
 && npm i prisma@6.19.3 @prisma/client@6.19.3 --no-audit --no-fund
COPY packages/db/prisma /m/prisma
CMD ["npx", "prisma", "migrate", "deploy", "--schema", "/m/prisma/schema.prisma"]
