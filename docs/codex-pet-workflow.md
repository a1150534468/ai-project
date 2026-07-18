# Codex 桌宠工作流运维说明

`codex-pet` 菜单默认隐藏。只有下列生产门槛全部通过后，才应在客户端菜单配置中开启 `workflow.codex-pet`：

- PostgreSQL migrations 已应用；API、Redis、私有 S3 与 Billing 可用。
- `codex-pet-worker` 的 `/health` 返回 200，`/metrics` 可被监控系统采集。
- GPT Image edits 真实 POC 通过单参考图、多参考图和 `1536×1024` 任务。
- 文字、单参考图和不对称多参考图三类桌宠均通过 v2 验证。
- Codex 安装深链和 ZIP 手动导入均在目标 Codex 版本验证成功。
- 成功运行在用户的 `AI_ARTIFACTS` 知识库中只产生一个 `sourceModule=codex_pet` 文档。

## 必需配置

敏感值只放部署 Secret，不提交到仓库：

```text
GPT_IMAGE_API_KEY
GPT_IMAGE_EDIT_API_KEY        # 可选，留空复用 GPT_IMAGE_API_KEY
CODEX_PET_ARTIFACT_SIGNING_SECRET  # 可选，留空复用 >=32 字节的 SESSION_SECRET
```

非敏感配置及默认值见 [`.env.example`](../.env.example)。生产环境必须把 `CODEX_PET_PUBLIC_BASE_URL` 配置为可公开读取单个签名精灵图的 HTTPS API 域名。

## 部署验证

```bash
pnpm --filter @ai-assistant/db generate
pnpm --filter @ai-assistant/db exec prisma migrate status
pnpm --filter @ai-assistant/api typecheck
pnpm --filter @ai-assistant/codex-pet-pipeline test
RUN_GPT_IMAGE_EDIT_POC=1 pnpm --filter @ai-assistant/api exec vitest run src/workflow/gpt-image-edit.poc.test.ts
```

POC 只在部署、图片网关切换或模型升级时运行，不进入普通 CI。

## 本地开发

仓库根目录执行 `pnpm dev` 会同时启动 API、Codex 桌宠 Worker、Web、Admin 和 Billing；桌宠 Worker 健康检查默认位于 `http://localhost:8092/health`。脚本会为未配置的 `CODEX_PET_PUBLIC_BASE_URL` 使用 `http://localhost:8090`，仅用于本地验证签名资源和界面流程。目标 Codex 的真实安装验收仍必须使用外网可达的 HTTPS 地址。

## 运行与健康检查

```bash
pnpm --filter @ai-assistant/api worker:codex-pet
curl -fsS http://127.0.0.1:8092/health
curl -fsS http://127.0.0.1:8092/metrics
```

Worker 会周期性恢复 stale run、确认不确定扣费、重试退款、清理到期中间产物和执行项目删除任务。知识库归档失败的上限由 `CODEX_PET_ARCHIVE_MAX_ATTEMPTS` 控制（默认 10，最大 100）；达到上限后运行失败并进入全额退款收敛。不要通过手工删除数据库行跳过这些收敛流程。

项目删除会先把所有待删私有对象的所有权信息持久化到 BullMQ job，再在同一数据库事务中删除对应的 AI 产物 Document/Chunk 与桌宠项目，最后异步删除对象存储内容。对象存储暂时失败时，重试继续使用 job 中的清单，不会重新创建知识库文档或项目。

## 生产发布与回滚顺序

1. 保持 `workflow.codex-pet` 隐藏，并先部署已包含新迁移的 migrate 镜像。
2. 固定名 `migrate` Job 重跑前先删除旧 Job，由发布编排只应用 Kustomize 渲染结果中的迁移 Job，并等待 `job/migrate` Complete；此阶段不要对整套 overlay 执行 `kubectl apply -k`，避免 API 或 Worker 提前滚动。
3. 迁移成功后再应用整套 overlay。更新 API 镜像时同步滚动 `deployment/api` 及所有复用该镜像的 Worker，并确认 Codex 桌宠 Worker `/health`、`/metrics` 和真实 GPT edits POC。
4. 完成三类桌宠、知识库归档、HTTPS 深链和 ZIP 验收后，才在客户端菜单后台开启入口。

回滚旧 API 镜像前先隐藏入口、停止新运行并等待或取消存量运行，然后 scale/delete `codex-pet-worker`；旧应用镜像不包含该 Worker 入口文件，不能让新 Deployment 继续引用旧镜像。新增表和字段保持向后兼容，回滚应用时无需破坏性回退数据库迁移。

## 关键一致性告警

- `ready` 运行必须同时存在 `knowledgeDocumentId`、最终 spritesheet、ZIP 和通过的验证报告。
- 相同 `operationId=codex-pet:<runId>` 不得出现重复扣费。
- 相同 `sourceModule=codex_pet, sourceId=<runId>` 不得出现重复知识库文档。
- `archiving` 持续失败、stale run、退款重试、对象清理失败和上游模型/尺寸/质量偏差应告警。
- 日志和事件不得包含 API Key、base64、对象键、签名 URL、完整参考图或内部提示词。
