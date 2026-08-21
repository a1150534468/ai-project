# 轻量生产部署与服务器资源验收

本文档对应 `docker-compose.prod.yml`。生产保留完整 Billing，API 和统一 Worker 通过 `tsx` 运行 TypeScript 源码；Web/Admin 编译后由 Gateway 容器提供。宿主机现有 Caddy 负责 DSH 和四个生产域名的 HTTPS，Gateway 只监听本机 `18080`。生产不运行 Kubernetes、MinIO、Vite 或 watch 进程。

## 1. 服务器准备

- 目标系统建议使用 64 位 Linux，安装 Docker Engine、Compose Plugin、`curl`、`awk`。
- 为 COS 临时下载、ffmpeg 输出和镜像更新预留至少 10 GiB 可用磁盘。
- 将 `80/tcp`、`443/tcp` 放行；保留 DSH 所需的 `18153/tcp`；PostgreSQL、Redis、API、Billing 和 Gateway 只绑定本机或 Compose 网络。
- 为 App、Admin、API、Billing 配置四个解析到服务器的域名。
- 在服务器创建部署目录，例如 `/opt/ai-assistant`，放置 `docker-compose.prod.yml`、`remote-deploy.sh` 和 `.env.production`。
- 从 `.env.production.example` 创建服务器环境文件，使用 URL 编码后的数据库密码填写连接串。
- 在服务器执行镜像仓库登录。`IMAGE_REGISTRY`、`IMAGE_NAMESPACE` 必须和 CI 的 `REGISTRY`、`IMAGE_NAMESPACE` 一致，四个仓库名固定为 `ai-assistant-api`、`ai-assistant-gateway`、`ai-assistant-migrate`、`ai-assistant-billing`。

生产数据从空环境初始化，不迁移旧 PostgreSQL 或 MinIO 数据。Billing 继续使用独立 PostgreSQL。

## 2. 首次生产部署

镜像应在本地或 CI Runner 构建并推送，服务器只拉取和运行。首次部署前确认 DSH 保持正常运行。

```bash
export DEPLOY_ROOT=/opt/ai-assistant
bash /opt/ai-assistant/remote-deploy.sh <commit-sha>
```

脚本依次拉取镜像、执行主库 Prisma 迁移和 Billing GORM 迁移、更新容器并等待所有服务健康。成功镜像标签写入 `.deployed-image-tag`；失败时自动恢复上一标签。

首次 Gateway 健康后，安装宿主机 Caddy 片段。该脚本会先备份主配置、校验配置，再重载 Caddy：

```bash
cd /opt/ai-assistant
bash /opt/ai-assistant/install-host-caddy.sh
```

检查运行拓扑：

```bash
docker compose --env-file /opt/ai-assistant/.env.production \
  -f /opt/ai-assistant/docker-compose.prod.yml ps
```

正常拓扑应只有 `gateway`、`api`、`worker`、`billing`、`postgres`、`billing-postgres`、`redis`，不能出现 MinIO 或三套独立 Worker。Gateway 的宿主机端口应显示为 `127.0.0.1:18080->80/tcp`。

## 3. 真实资源测试

在仓库目录或服务器部署目录运行采样脚本。默认每 5 秒采样并持续 2 小时，输出写到 `/tmp`。

```bash
PROFILE_DURATION_SECONDS=7200 PROFILE_INTERVAL_SECONDS=5 \
  PROFILE_SCENARIO=idle \
  COMPOSE_PROJECT_NAME=ai-assistant \
  DEPLOY_ROOT=/opt/ai-assistant \
  bash /opt/ai-assistant/profile-resources.sh
```

固定场景建议分别使用 `idle`、`normal-five-users`、`chat`、`knowledge`、`billing`、`media-single` 作为 `PROFILE_SCENARIO`，输出中会同时记录容器 RSS/CPU 与 API、Worker 的 Node Heap/External 数据。

按以下顺序测试，期间不要停止或限制服务器上的另一应用：

1. 冷启动并等待全部健康，随后空闲 30 分钟。
2. 模拟最多五名用户执行登录、对话流、模型选择和普通页面操作。
3. 完成知识库上传、索引、检索和额度校验。
4. 验证充值、会员、余额不足、预占、结算和退款。
5. 小说、商家宣传视频、Codex Pet 重任务逐类串行执行，每类至少三次。
6. 检查任务完成后 Worker RSS 是否回落，临时目录是否清理。
7. 依次重启 API、Worker、Billing、Redis 和两个 PostgreSQL，验证恢复与重试。
8. 执行一次上一镜像标签回滚，再部署当前标签。

目标区间不是 cgroup 硬限制：空闲约 `1.1-1.4 GiB`，普通五用户约 `1.4-1.8 GiB`，单个重任务尽量接近 `2 GiB`。不得出现 OOM、持续增长的 Swap、任务完成后内存不回落或另一应用明显变慢。

## 4. 手动回滚

```bash
export DEPLOY_ROOT=/opt/ai-assistant
bash /opt/ai-assistant/rollback-compose.sh <previous-commit-sha>
```

主库迁移必须保持向后兼容。破坏性迁移不能进入自动发布，需要单独备份、维护窗口和回滚方案。

## 5. CI/CD 配置

`.github/workflows/production.yml` 在 Pull Request 上执行验证，在 `main` 或手动触发时构建四个镜像并部署。仓库环境需要配置：

- `REGISTRY`、`REGISTRY_USERNAME`、`REGISTRY_PASSWORD`
- `IMAGE_NAMESPACE`
- `DEPLOY_HOST`、`DEPLOY_PORT`、`DEPLOY_USER`、`DEPLOY_PRIVATE_KEY`
- `DEPLOY_ROOT`

服务器上的 `.env.production` 和 Registry 登录凭据不由 CI 覆盖。正式上线前应为两个 PostgreSQL 数据卷建立独立备份，并定期验证恢复。
