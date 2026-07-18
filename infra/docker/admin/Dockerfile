# admin (apps/admin): React+Vite 运营后台 SPA → nginx 静态。构建上下文 = 仓库根。
# VITE_API_BASE 作 build arg：admin 跨子域调 api（admin.example.com → api.example.com）。
FROM node:24-bookworm-slim AS builder
WORKDIR /repo
RUN corepack enable
ENV npm_config_registry=https://registry.npmmirror.com
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/admin/package.json apps/admin/package.json
COPY packages/article-workflow/package.json packages/article-workflow/package.json
COPY packages/billing/package.json packages/billing/package.json
COPY packages/codex-pet-pipeline/package.json packages/codex-pet-pipeline/package.json
COPY packages/connector-protocol/package.json packages/connector-protocol/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/llm/package.json packages/llm/package.json
RUN pnpm install --frozen-lockfile
COPY . .
ARG VITE_API_BASE=https://api.example.com
ENV VITE_API_BASE=${VITE_API_BASE}
RUN pnpm --filter @ai-assistant/admin build

FROM nginx:alpine
COPY --from=builder /repo/apps/admin/dist /usr/share/nginx/html
COPY infra/docker/admin/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
