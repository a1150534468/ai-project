# AI 助手

多业务 AI 工作台 monorepo：Web / Admin 前端 + Fastify 单体 API + 多个独立 Worker。文档导航见 [docs/README.md](docs/README.md)（一个模块一个文档）。

## 环境要求

| 依赖 | 说明 |
| --- | --- |
| Node.js | ≥ 24（`engines` 锁定；全容器模式下业务进程跑在镜像里，不受宿主版本影响） |
| pnpm | 10.26.2（`packageManager` 字段锁定，`corepack enable` 即用） |
| Docker Desktop | 数据层（pg/redis）必需；全容器模式还用于构建开发镜像 |
| 腾讯云 COS 密钥 | 对象存储不本地起服务：dev 与 prod 共用一个桶，按 `S3_KEY_PREFIX`（dev/prod）分文件夹 |

密钥与模型网关（百炼 / AI Pixel / 生图 / 向量）的全部配置项见 [.env.example](.env.example)；模型选型与踩坑见 [docs/image.md](docs/image.md) 与 [docs/pitfalls.md](docs/pitfalls.md)。

## 本地开发

两种模式**二选一，不能同时跑**（占用同一批端口）；入口地址相同。方案细节与决策见 [docs/plans/2026-10-22-dev-container.md](docs/plans/2026-10-22-dev-container.md)。

| | 混合模式（默认） | 全容器模式 |
| --- | --- | --- |
| 启动 | `pnpm dev` | `pnpm dev:docker` |
| 业务进程 | 宿主机热更新（tsx watch / Vite），调试器、tsc、vitest 都在宿主跑 | API、两个 Worker、Web、Admin 全部进容器（node:24，与生产同基础镜像） |
| 数据层 | Docker 里的 pg（5433）/ redis（6380） | 同左——同一个 compose 项目、同一套数据卷 |
| 适合 | 日常开发 | 环境隔离；宿主 node 版本随 shell 漂移时 |

### 混合模式（默认）

```bash
cp .env.example .env.local   # 首次使用；已有 .env 可跳过
pnpm install
pnpm dev
```

- Web：<http://localhost:5174>
- Admin：<http://localhost:5175>
- API：<http://localhost:8090>（Swagger 见 <http://localhost:8090/docs>，架构与端点总览见 [docs/overview.md](docs/overview.md)）
- Novel Worker 健康检查：<http://localhost:8091/health>
- Codex 桌宠 Worker 健康检查：<http://localhost:8092/health>

`Ctrl+C` 只停止本机业务服务，Docker 数据层保留；停止数据层用 `pnpm dev:infra:stop`。

若本地数据库结构与迁移记录漂移，可临时 `DEV_SKIP_MIGRATIONS=1 pnpm dev` 跳过启动迁移（详见 [docs/pitfalls.md](docs/pitfalls.md#prisma-迁移记录漂移本地)）。

### 全容器模式（可选）

```bash
pnpm dev:docker        # 构建镜像（首建约 4~8 分钟）并起全部 7 个服务，等 /ready 就绪
pnpm dev:docker:logs   # 跟随 api / workers / web / admin 日志
pnpm dev:docker:down   # 停止全部服务（不带 -v，数据卷保留）
```

注意：

- `dev:docker` 启动前会检查 8090/5174/5175 是否被占（例如混合模式还在跑），被占直接报错，不自动换端口；
- 改 `package.json` 或 prisma schema 后要重建镜像：`docker compose -f docker-compose.dev.yml --profile app up -d --build`（lockfile 没变时命中缓存，很快）；只改源码即时热更新，无需重建；
- worker 健康端口 8091/8092 不发布到宿主，排查用 `pnpm dev:docker:logs`；
- 任何情况下都不要对这个 compose 项目用 `down -v`——那会删掉数据库卷。

## 常用命令

```bash
pnpm dev             # 启动混合开发环境（宿主进程 + Docker 数据层）
pnpm dev:docker      # 启动全容器开发环境（见「本地开发」）
pnpm test            # turbo 全仓测试
pnpm typecheck       # 生成 Prisma Client 并全仓类型检查
pnpm build           # 全仓构建
pnpm k8s:validate    # 校验 k8s kustomize 配置
```

## 仓库布局

```
apps/       api（Fastify 单体 + workers）、web、admin
packages/   db（Prisma）、llm、novel/article/codex-pet 流水线、connector-protocol
infra/      Docker 镜像与 Caddy（生产部署见 docs/deploy-compose.md；开发镜像在 infra/docker/dev/）
docs/       项目文档（扁平结构，一个模块一个文档 + superpowers/plans 计划归档，导航见 docs/README.md）
docs/legacy/ 保留但**不在部署链路上**的旧配置（K8s/Kustomize 清单）
```

## Codex 桌宠调用合同

新项目仅使用 `GPT Image 2` 经 Pixel 路由生成和编辑；AI 视觉质检默认关闭（关闭时不调视觉模型，仍做本地兼容性验证和 v2 打包）。一次正常运行最多预留 14 次计划内生图调用，按实际发出结算、退回未使用预留；第 15 次及任何修复/重生调用必须由用户单次明确授权并单独计费。网络、超时、429、5xx 和本地/质检失败均不会静默重试 provider 请求。完整合同见 [docs/codex-pet.md](docs/codex-pet.md)。

## 发布到生产

发布是**手动触发**的（`.github/workflows/production.yml`），并且**只允许从 `main` 触发** —— `verify-release` job 会强制校验这一点，外加「该提交必须有一次成功的 CI 记录」，不通过直接拒绝发布。

去仓库 **Actions → Release to production → Run workflow**，分支选 `main`，点运行。命令行等价写法：

```bash
gh workflow run production.yml --ref main
```

跑起来后流水线做三件事：

1. **校验发布是否合法**（ref 是 `main` + 该提交的 `CI` 曾经跑绿）
2. **构建并推送镜像** —— api / migrate / gateway 三个镜像，在 `ubuntu-latest` 上用 `docker/build-push-action` 直接 `push` 到腾讯云 TCR（和 blog 的 build job 同形），镜像 tag 是 commit SHA
3. **部署** —— SSH 到生产机执行 `remote-deploy.sh`：拉镜像 → 跑 Prisma 迁移 → 起容器 → 等 5 个服务健康，**失败自动回滚到上一版**

版本号照旧用 git tag 记，但**打 tag 本身不再触发发布**（2026-10-13 从 tag 触发改成手动触发，原因见工作流顶部注释）。想让 tag 与线上版本对齐，就先打 tag、再点发布，中间别往 `main` 合东西。

运维入口：

- 回滚：`DEPLOY_ROOT=/opt/ai-assistant bash /opt/ai-assistant/rollback-compose.sh <上一个 commit sha>`
- 线上巡检（只读，不改变任何东西）：手动触发 `.github/workflows/production-diagnostics.yml`
- 想知道线上跑的是哪一版：读生产机上的 `.deployed-image-tag`

目标服务器使用 Docker Compose、腾讯 COS 和统一 Worker，完整步骤与资源验收标准见 [轻量生产部署](docs/deploy-compose.md)。
