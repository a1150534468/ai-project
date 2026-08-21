FROM node:24-bookworm-slim AS builder
WORKDIR /repo
RUN corepack enable
ENV npm_config_registry=https://registry.npmmirror.com

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/admin/package.json apps/admin/package.json
COPY packages/article-workflow/package.json packages/article-workflow/package.json
COPY packages/novel-workflow/package.json packages/novel-workflow/package.json
RUN --mount=type=cache,id=ai-assistant-pnpm,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store \
 && pnpm install --frozen-lockfile --filter @ai-assistant/web... --filter @ai-assistant/admin...

COPY apps/web apps/web
COPY apps/admin apps/admin
COPY packages/article-workflow packages/article-workflow
COPY packages/novel-workflow packages/novel-workflow
COPY tsconfig.base.json turbo.json ./
RUN pnpm --filter @ai-assistant/web build && pnpm --filter @ai-assistant/admin build

FROM caddy:2.10-alpine
COPY infra/caddy/Caddyfile /etc/caddy/Caddyfile
COPY --from=builder /repo/apps/web/dist /srv/web
COPY --from=builder /repo/apps/admin/dist /srv/admin
EXPOSE 80 443
