# 项目总览（overview）

> 快速了解这个项目是什么、怎么跑起来、技术选型为什么这么定。详细内容请进入各模块文档。

## 一句话概括

**React 多端前端 + Fastify 单体 API + 独立 Worker 进程 + Go 计费微服务**。数据层 PostgreSQL（pgvector）+ Redis + MinIO；所有对话类模型统一走 Anthropic Messages 协议，接入阿里云百炼与 AI Pixel 网关。

## 运行时拓扑

| 进程 | 端口 | 入口 |
| --- | --- | --- |
| Web（用户工作台） | 5174 | `apps/web` |
| Admin（运营后台） | 5175 | `apps/admin` |
| API（Fastify 单体） | 8090 | `apps/api/src/server.ts` |
| Novel Worker | 8091 | `apps/api/src/workers/novel-worker.ts` |
| Codex Pet Worker | 8092 | `apps/api/src/workers/codex-pet-worker.ts` |
| Desktop（Electron） | 本机 | `apps/desktop` |

数据层：PostgreSQL 17 + pgvector（主库，90 个模型）+ Billing 独立 PG + Redis + MinIO/S3。
外部模型：百炼 Anthropic 兼容（qwen 对话/embedding/生图）+ AI Pixel 网关（gpt-5.x 对话/gpt-image-2）。

## 怎么跑起来

```bash
cp .env.example .env.local   # 首次使用
pnpm install
pnpm dev                     # 数据层进 Docker、业务进程热更新
```

`pnpm dev` 启动全部服务：Docker 承载 pgvector(5433)/Redis(6380)/Billing PG(5434)/MinIO(9000)，本机拉起 API(8090)/Workers/Web/Admin。`Ctrl+C` 只停业务进程；`pnpm dev:infra:stop` 停数据层。详见 [setup.md](./overview.md)。

## 仓库布局

```
apps/       api（Fastify + workers）、web、admin、desktop
packages/   db（Prisma）、llm（模型路由）、
            novel-workflow / article-workflow / codex-pet-pipeline（纯逻辑流水线）、
            connector-protocol（桌面连接协议 zod）
infra/      Dockerfile + K8s Kustomize
docs/       本文档体系
```

## 技术选型速览

| 选择 | 为什么 |
| --- | --- |
| pnpm workspace + Turborepo | 多应用共享包，统一编排 |
| Fastify 5 + TS ESM + tsx | 单体承载全部路由，开发热更新 |
| Prisma + pgvector | 单一 schema 90 模型；向量检索不引入额外组件 |
| Postgres 即任务队列（租约模式）| 任务状态本来就要落库，事务认领免去双写一致性 |
| Go + Gin 独立计费 | 账本与业务库物理隔离 |
| React 19 + Vite + Tailwind + motion | Studio + Model 分层，刻意少依赖 |
| Electron + 自定义 WS 协议 | 用户本机成为 agent 执行节点 |

## 项目血统与时间线

三段代码血统 + 一个外部蓝本：

1. **fqxs（04-03~05-31）**：番茄小说原型（Python/FastAPI），贡献了产品形态。
2. **yun-claude 底座（06-26~07-09，721 commits）**：聊天/知识库/记忆/计费/桌面/大部分工作流在此成型。
3. **本仓库（07-10 起）**：导入底座 → 接入百炼 → 小说 PlotPilot 重写 → Codex 桌宠上线。
4. **PlotPilot 墨枢（外部蓝本）**：开源叙事引擎内核，小说模块参考其概念用 TS 重写。

完整时间线与 ADR 决策记录见 [decisions.md](./decisions.md)。

## 模块导航

| 模块 | 文件 | 一句话 |
| --- | --- | --- |
| 对话助手 | [chat.md](./chat.md) | SSE 流式多轮对话 + Agent 工具循环 + 记忆/知识库 |
| 小说引擎 | [novel.md](./novel.md) | 最重的业务线：PlotPilot 叙事状态机 + 独立 Worker |
| Codex 桌宠 | [codex-pet.md](./codex-pet.md) | 像素动画角色生成：模型合同 + 确定性流水线 + 签名交付 |
| AI 生图 | [image.md](./image.md) | 双轨模型（百炼 Qwen + GPT Image）的底层图片能力 |
