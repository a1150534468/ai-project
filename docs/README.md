# 文档导航

一个模块 = 一个文档。打开文件名就知道讲什么。

## 模块文档（按业务线）

| 文件 | 模块 | 一句话 |
| --- | --- | --- |
| [chat.md](chat.md) | 对话助手 | SSE 流式多轮对话 + Agent 工具循环 + 记忆/知识库/本地设备 |
| [novel.md](novel.md) | 小说引擎 | 最重的业务线：PlotPilot 叙事状态机 + 独立 Worker + 35 张表 |
| [codex-pet.md](codex-pet.md) | Codex 桌宠 | 像素动画角色生成：模型合同 + 确定性流水线 + 签名交付 + 运维 |
| [image.md](image.md) | AI 生图 | 双轨模型（百炼 Qwen + GPT Image），所有图片类工作流的底层能力 |
| [ecom.md](ecom.md) | AI 电商图 | 复用生图能力的电商长图工作流 |
| [dub.md](dub.md) | 数字人口播 | 飞天数字人 + MiMo TTS 的配音成片流水线（设计 + P1-P4 计划） |
| [wechat.md](wechat.md) | 微信通道 | 个人微信 iLink 接入 + 多模态 + 团队电脑（设计 + P1-P3 计划） |
| [billing.md](billing.md) | 计费系统 | Go 独立服务：reserve/settle/refund + 学习模式运维 |
| [fanout.md](fanout.md) | 爆款文案裂变 | 一份原文 → 结构化提取 → 沿维度批量裂变去重（设计 + 实现计划） |

## 项目级参考

| 文件 | 内容 |
| --- | --- |
| [overview.md](overview.md) | 架构总览、运行时拓扑、怎么跑起来、技术选型、时间线精简版 |
| [decisions.md](decisions.md) | 9 条 ADR 关键决策记录 + 已知架构债 |
| [pitfalls.md](pitfalls.md) | 通用踩坑集（向量迁移、开发环境、部署回滚等横切问题） |
| [orchestration.md](orchestration.md) | 编排现状分析：自研编排 vs 引入 agent 框架的评估与建议路线 |
| [ai-collaboration.md](ai-collaboration.md) | 与 AI（Claude Code / Codex）协作的统一规范 |
| [deploy-compose.md](deploy-compose.md) | 轻量生产 Compose、Caddy、服务器资源实测与回滚 |

## 整治 / 计划

| 文件 | 内容 |
| --- | --- |
| [superpowers/plans/2026-08-03-architecture-remediation.md](superpowers/plans/2026-08-03-architecture-remediation.md) | 架构整治计划（P0/P1/P2，逐任务执行中） |
| [superpowers/plans/2026-07-28-multi-platform-article-workflow.md](superpowers/plans/2026-07-28-multi-platform-article-workflow.md) | 多平台文章工作流计划 |
| [superpowers/plans/2026-07-27-legacy-workflow-optimization.md](superpowers/plans/2026-07-27-legacy-workflow-optimization.md) | 遗留工作流优化计划 |

## 设计稿（不动）

- [design-system.md](design-system.md) — 前端设计系统规范
- [DESIGN-apple.md](DESIGN-apple.md) — 近期新增设计稿

## 注意事项

- **不出现任何真实密钥**，只有变量名与占位符。
- **运行时资产不在 docs 里**：`apps/api/src/agents/presets.md` 等是代码在运行时读取的提示词资产，不要移动。
