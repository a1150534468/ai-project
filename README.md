# AI 助手

多业务 AI 工作台 monorepo：Web / Admin / 桌面端 + Fastify API + 多 Worker + Go 计费服务。完整文档见 [docs/README.md](docs/README.md)。

## 快速开始

混合开发模式：PostgreSQL、Redis、MinIO 跑在 Docker 里，API、Billing、Web、Admin 在本机热更新。

```bash
cp .env.example .env.local # 首次使用；已有 .env 可跳过
pnpm install
pnpm dev
```

开发入口：

- Web：<http://localhost:5174>
- Admin：<http://localhost:5175>
- API：<http://localhost:8090>（Swagger 见 <http://localhost:8090/docs>，[使用说明](docs/reference/api-reference.md)）
- Billing：<http://localhost:8093>
- Novel Worker 健康检查：<http://localhost:8091/health>
- Codex 桌宠 Worker 健康检查：<http://localhost:8092/health>

`Ctrl+C` 只停止本机业务服务，Docker 数据层会保留；停止数据层用 `pnpm dev:infra:stop`。桌面端按需另开终端 `pnpm dev:desktop`。

模型网关（百炼 / AI Pixel / 生图 / 向量）配置详见 [docs/setup/model-providers.md](docs/setup/model-providers.md)；本地开发细节与常见问题见 [docs/setup/local-dev.md](docs/setup/local-dev.md)。

## 仓库布局

```
apps/       api（Fastify 单体 + workers）、web、admin、desktop（Electron）
packages/   db（Prisma）、llm、billing 客户端、novel/article/codex-pet 流水线、connector-protocol
services/   billing（Go + Gin，独立数据库）
infra/      docker 镜像与 k8s 部署（部署文档见 docs/setup/deploy-k8s.md）
docs/       项目文档（架构 / 业务线 / 搭建 / 历史 / 踩坑 / 计划归档 / 参考）
```

## 常用命令

```bash
pnpm dev             # 启动混合开发环境
pnpm test            # turbo 全仓测试
pnpm typecheck       # 生成 Prisma Client 并全仓类型检查
pnpm build           # 全仓构建
pnpm k8s:validate    # 校验 k8s kustomize 配置
```

若本地数据库结构与迁移记录漂移，可临时 `DEV_SKIP_MIGRATIONS=1 pnpm dev` 跳过启动迁移（见 [docs/lessons/](docs/lessons/README.md)）。
