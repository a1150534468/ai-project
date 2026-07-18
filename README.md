# AI 助手

## 本地开发（推荐）

项目默认采用混合开发模式：PostgreSQL、Redis、MinIO 运行在 Docker 中，API、Billing、Web 和 Admin 直接在本机运行并热更新。

```bash
cp .env.example .env.local # 首次使用；已有 .env 可跳过
pnpm install
pnpm dev
```

开发入口：

- Web：<http://localhost:5174>
- Admin：<http://localhost:5175>
- API：<http://localhost:8090>
- Billing：<http://localhost:8093>
- Codex 桌宠 Worker 健康检查：<http://localhost:8092/health>
- Swagger 接口文档：<http://localhost:8090/docs>（[使用与分组说明](docs/api-reference.md)）
- Codex 桌宠部署与验收：[docs/codex-pet-workflow.md](docs/codex-pet-workflow.md)

`Ctrl+C` 只停止本机业务服务，Docker 数据层会保留。需要停止数据层时运行：

```bash
pnpm dev:infra:stop
```

桌面端按需另开终端启动：

```bash
pnpm dev:desktop
```

## 阿里云百炼模型配置

对话助手直接使用 Anthropic SDK 调用百炼的 Anthropic Messages 兼容接口，不经过 OpenAI 协议转换。华北 2（北京）地域必须使用同一业务空间的 Workspace ID 和 API Key：

```dotenv
LLM_PROVIDER=bailian
BAILIAN_WORKSPACE_ID=你的业务空间ID
BAILIAN_REGION=cn-beijing
BAILIAN_API_KEY=该业务空间的API-Key
LLM_DEFAULT_MODEL=qwen3.7-plus
CHAT_MULTIMODAL_MODEL=qwen3.7-plus
```

服务会自动生成 `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/apps/anthropic`，Anthropic SDK 会向其 `/v1/messages` 发起请求。也可用 `BAILIAN_BASE_URL` 显式覆盖完整兼容地址。API Key、Workspace ID 与模型授权不属于同一业务空间时，百炼会返回 `Model.AccessDenied`。

长期记忆、知识库和小说向量记忆默认复用同一个 `BAILIAN_API_KEY`，通过 `https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings` 调用 `text-embedding-v4`，固定输出 1024 维向量。数据库迁移会清除旧 4096 维派生向量、保留原始文档，并为三张向量表建立 HNSW 余弦索引。

图片生成与编辑默认复用 `BAILIAN_WORKSPACE_ID`、`BAILIAN_REGION` 和 `BAILIAN_API_KEY`，直连百炼原生多模态接口，默认模型为 `qwen-image-2.0-pro-2026-04-22`。如图片使用独立百炼凭据，可设置 `IMAGE_API_KEY`，如需覆盖入口可设置 `IMAGE_BASE_URL` 或完整的 `IMAGE_GENERATION_ENDPOINT`。Qwen Image 2.0 的输出总像素范围为 `512*512` 至 `2048*2048`。

主生图工作台还可选择 `gpt-image-2`，通过 OpenAI Images API 兼容协议调用 `GPT_IMAGE_GENERATION_ENDPOINT`（默认 `https://api.ai-pixel.online/v1/images/generations`），凭据使用 `GPT_IMAGE_API_KEY`。带 1～3 张参考图时会复用同一生图模块，通过 multipart `image[]` 调用 `GPT_IMAGE_EDIT_ENDPOINT`；该地址未配置时会从 generations 地址推导 `/edits`，`GPT_IMAGE_EDIT_API_KEY` 未配置时复用 generation key。真实 edits POC 只在部署、网关切换或模型升级时通过 `RUN_GPT_IMAGE_EDIT_POC=1` 显式运行。

对话助手额外接入 AI Pixel 的 Anthropic Messages 兼容接口。当前只开放 `codex-auto-review`、`gpt-5.4`、`gpt-5.4-mini`、`gpt-5.5`、`gpt-5.6-luna`、`gpt-5.6-sol`、`gpt-5.6-terra`，不会把上游列表中的旧 GPT、音频、Realtime 或图片模型混入对话选项。默认地址为 `CHATGPT_BASE_URL=https://api.ai-pixel.online`；`CHATGPT_API_KEY` 未配置时复用 `GPT_IMAGE_API_KEY`。

真实向量链路可用仓库 POC 验证：

```bash
set -a; source .env; set +a
RUN_EMBEDDING_POC=1 pnpm --filter @ai-assistant/api exec vitest run src/memory/__tests__/embedding.poc.test.ts
```

旧 Anthropic/NewAPI 网关只作为兼容回退：设置 `LLM_PROVIDER=anthropic`，并填写 `LLM_BASE_URL`、`LLM_API_KEY`。

Kubernetes 下的 `http://app.localhost:8080` 是镜像联调环境，不用于日常热更新开发。

如果本地数据库已经手工同步过结构、Prisma 提示迁移记录漂移，可临时跳过启动时迁移：

```bash
DEV_SKIP_MIGRATIONS=1 pnpm dev
```
