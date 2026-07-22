# 项目长期记忆（MEMORY.md）

## 生图 / 上游 API Key 配置约定
- 所有上游 key 都是**环境变量**，**没有 admin 后台 UI**。
- K8s 部署：编辑 `infra/k8s/secrets.env.example` → 复制为 `secrets.env` 填值 → `KUBE_CONTEXT=<ctx> ./infra/k8s/create-secrets.sh`，写入 `ai-assistant-api-secrets` / `ai-assistant-billing-secrets`。脚本是 merge patch，空值跳过。
- 本地开发（`pnpm dev` 跑 apps/api）：在仓库根目录放 `.env`（或 `.env.local`），apps/api 启动时通过 `src/env.ts` 自动 `loadEnvFile` 加载。
- `docker-compose.dev.yml` 只起 infra（pg/redis/minio），不注入 api env；api 需另跑并继承宿主 env 或根 `.env`。
- 生图模型 → key 映射：
  - 豆包 Seedream → `ARK_API_KEY`（可选 `ARK_IMAGE_ENDPOINT`，默认火山方舟 cn-beijing 生图端点）
  - Qwen Image 2.0 Pro（百炼）→ `IMAGE_API_KEY`，或留空自动复用 `BAILIAN_API_KEY`/`DASHSCOPE_API_KEY`
  - GPT Image 2（OpenAI 兼容）→ `GPT_IMAGE_API_KEY`
  - 读 key 位置：`apps/api/src/workflow/image-service.ts` `loadImageGenerationConfigForModel`

## 模型广场数据链路
- 广场列表 `billing` 的 `registry.ListMarketplace()` 只按 `enabled AND show_in_marketplace` 过滤（**不含** `output_price>0`）；零价格生图模型可进广场。`ListEnabled()` 才带 `output_price>0`，仅用于 chat 选择器。
- 生图模型需在 `services/billing/internal/registry/registry.go` 的 `SeedDefault` 里 seed `PriceRule`（视觉模型 分类 + `image-gen,vision` 标签 + `ShowInMarketplace:true`），重启 billing 生效（幂等）。
- 广场生图单价来自 `ResourcePrice` 表 `image_generation_1k/2k/4k`（单位=算力点），由 `vip_marketplace.go` 套 VIP 折扣后透出 `ImagePrice`。
- 前端按 `category` 分组 + 顶栏切换（`apps/web/src/pages/ModelMarketplace.tsx`，纯函数 `groupByCategory`/`selectVisibleGroups`）。
