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
- API：<http://localhost:8090>（Swagger 见 <http://localhost:8090/docs>，架构与端点总览见 [docs/overview.md](docs/overview.md)）
- Billing：<http://localhost:8093>
- Novel Worker 健康检查：<http://localhost:8091/health>
- Codex 桌宠 Worker 健康检查：<http://localhost:8092/health>

`Ctrl+C` 只停止本机业务服务，Docker 数据层会保留；停止数据层用 `pnpm dev:infra:stop`。桌面端按需另开终端 `pnpm dev:desktop`。

模型网关（百炼 / AI Pixel / 生图 / 向量）的配置项见 [.env.example](.env.example)，模型选型与踩坑见 [docs/image.md](docs/image.md) 与 [docs/pitfalls.md](docs/pitfalls.md#一模型网关与配额)；本地开发细节与常见问题见 [docs/overview.md](docs/overview.md) 与 [docs/pitfalls.md](docs/pitfalls.md)。

## Codex 桌宠调用合同

Codex 桌宠的新项目仅使用 `GPT Image 2` 经 Pixel 路由生成和编辑。AI 视觉质检默认关闭；关闭时不会调用视觉模型，仍执行本地兼容性验证和 v2 打包。

一次正常运行最多预留 14 次计划内生图调用，并按实际已发出的请求结算和退回未使用预留。任何第 15 次、修复或重生调用都必须由用户单次明确授权并单独计费。网络、超时、429、5xx 和本地/质检失败均不会静默重试 provider 请求。

## 仓库布局

```
apps/       api（Fastify 单体 + workers）、web、admin、desktop（Electron）
packages/   db（Prisma）、llm、billing 客户端、novel/article/codex-pet 流水线、connector-protocol
services/   billing（Go + Gin，独立数据库）
infra/      Docker 镜像、Caddy 与保留的 K8s 配置（轻量生产部署见 docs/deploy-compose.md）
docs/       项目文档（扁平结构，一个模块一个文档 + superpowers/plans 计划归档，导航见 docs/README.md）
```

## 常用命令

```bash
pnpm dev             # 启动混合开发环境
pnpm test            # turbo 全仓测试
pnpm typecheck       # 生成 Prisma Client 并全仓类型检查
pnpm build           # 全仓构建
pnpm k8s:validate    # 校验 k8s kustomize 配置
```

目标服务器使用 Docker Compose、腾讯 COS 和统一 Worker，完整步骤与资源验收标准见 [轻量生产部署](docs/deploy-compose.md)。

若本地数据库结构与迁移记录漂移，可临时 `DEV_SKIP_MIGRATIONS=1 pnpm dev` 跳过启动迁移（见 [docs/pitfalls.md](docs/pitfalls.md#prisma-迁移记录漂移本地)）。
