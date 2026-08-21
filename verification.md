# 资源优化与生产部署验证记录

验证日期：2026-08-21

## 结论

- Billing 保持完整启用，接口、Schema、页面和对账任务未增加关闭开关。
- API 与统一 Worker 均在生产镜像内使用 `tsx` 直接运行 TypeScript 源码，未启用 watch。
- 三个业务 Worker 已合并为一个 Node 进程，默认队列并发和进程内重任务并发均为 `1`。
- 生产 Compose 不包含 Kubernetes、MinIO、Vite 或额外前端 Node 进程；Web/Admin 由 Gateway 提供静态文件。
- 本地发布门槛与隔离生产拓扑均已通过，可以进入 Commit、推送和目标服务器部署阶段。
- 本地资源数据只能证明拓扑与优化方向有效，不能替代目标 `4C4G` 服务器验收。

## 发布门槛

| 项目 | 结果 |
| --- | --- |
| 全仓类型检查 | 11/11 包通过 |
| 全仓测试 | 10/10 测试任务通过；API 1815 通过、18 跳过 |
| 全仓构建 | 通过；Web 有既有约 1.72 MB 大 chunk 警告 |
| Billing Go 测试 | 全部通过 |
| 改动文件 `noUnusedImports` 检查 | 63 个文件通过 |
| Workflow YAML、Compose、Shell 语法 | 通过 |
| 敏感信息扫描 | 待提交改动未发现私钥、COS SecretId 或常见 API Key |
| API、Gateway、Migration、Billing 镜像构建 | 全部通过 |
| 主库全新环境迁移 | 73 个 Prisma 迁移全部成功 |
| Billing 全新环境迁移 | 通过 |
| 隔离生产拓扑冷启动 | 7 个常驻服务全部健康 |
| App/Admin/API/Billing Host 路由 | 全部通过 |

完整测试最初因本机 Billing 占用 `8093` 而使 13 个“Billing 不可达应返回 502”的用例失败。生产工作流已调整为先运行 Node 测试与构建，再启动真实 Billing 做独立健康冒烟；测试 URL 仍保留 OpenAPI 契约要求的 `8093`。复测后 Billing 相关失败已清零。

全仓并行测试还发现 `RippleButton` 卸载后遗留定时器。组件现会在卸载时清理自身 timeout，并新增回归用例；修复后全仓测试连续完整结束，没有测试环境销毁后的异步 React 错误。

首次生产工作流的 Node 验证全部通过，但 Billing 的会员周期测试曾隐式使用 Runner 本地时区，因 GitHub 使用 UTC 而失败。生产实现始终固定使用北京时区，本次仅将测试输入和预期显式锚定 `BeijingLoc`；Billing 全量 Go 测试已在 `TZ=UTC` 下复测通过。

最新镜像大小（Docker 报告的十进制字节换算）：

| 镜像 | 大小 |
| --- | ---: |
| API/Worker | 约 497 MB |
| Gateway | 约 22 MB |
| Billing | 约 5.6 MB |
| Migration（仅迁移时运行） | 约 249 MB |

## 本地资源数据

历史同一轮资源优化采样结果：

| 场景 | 结果 |
| --- | ---: |
| API 延迟加载 sharp 前 | 约 330 MiB |
| API 延迟加载 sharp 后的稳定样本 | 约 184 MiB |
| 三个独立 Worker | 约 373 MiB |
| 合并 Worker | 约 166 MiB |
| Worker 合并收益 | 约 207 MiB |
| 延迟加载后的完整空闲拓扑（含 Gateway） | 约 472 MiB |

最新镜像使用全新空数据卷完成迁移和冷启动后的瞬时样本：

| 服务 | RSS |
| --- | ---: |
| API | 约 265 MiB |
| 合并 Worker | 约 185 MiB |
| Gateway | 约 49 MiB |
| 主 PostgreSQL | 约 69 MiB |
| Billing PostgreSQL | 约 52 MiB |
| Redis | 约 13 MiB |
| Billing | 约 10 MiB |
| 合计 | 约 644 MiB |

该数据处于冷启动阶段，只用于确认当前镜像没有异常增长或 OOM，不作为 30 分钟空闲基线。先前 Redis 故障注入中，API 在 `2064 ms`、Worker 在 `2033 ms` 返回 `503`；Redis 恢复后两者重新返回 `200`，没有容器重启或 OOM。

## 目标服务器待验收

服务器、域名、COS、TCR、GitHub Actions Secrets 和生产环境文件已准备完成。剩余步骤：

1. 创建本地 Commit，经用户确认后推送 `main`，触发镜像构建和自动部署。
2. 容器全部健康后安装宿主机 Caddy 站点片段，不停止或替换现有 DSH Caddy。
3. 验证四个生产域名、登录、对话、知识库、完整 Billing 和 COS 上传下载。
4. 保持服务器上的另一应用运行，执行 30 分钟空闲和最多五用户普通场景。
5. 小说、商家宣传视频、Codex Pet 三类重任务逐类至少执行三次，检查峰值和 RSS 回落。
6. 完成不少于 2 小时稳定性采样，检查 CPU、Swap、OOM、队列积压和接口延迟。
7. 逐个重启服务并执行一次上一 Commit SHA 回滚，再发布当前版本。

目标区间不是 cgroup 硬限制：空闲约 `1.1-1.4 GiB`，普通五用户约 `1.4-1.8 GiB`，单个重任务尽量接近 `2 GiB`。不得出现 OOM、持续增长的 Swap、任务完成后内存不回落或另一应用明显变慢。

## 清理状态

隔离验证使用的 `ai-assistant-final-verify` 容器、网络和数据卷已全部删除。本地开发 PostgreSQL、Redis、MinIO、Billing 以及其他应用未停止或修改。四个 `:verify` 镜像标签保留在本机，未推送远程仓库。
