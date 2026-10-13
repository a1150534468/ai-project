# 轻量生产部署与服务器资源验收

本文档对应 `docker-compose.prod.yml`。API 和统一 Worker 通过 `tsx` 运行 TypeScript 源码；Web/Admin 编译后由 Gateway 容器提供。宿主机现有 Caddy 负责 DSH 和三个生产域名的 HTTPS，Gateway 只监听本机 `18080`。生产不运行 Kubernetes、MinIO、Vite 或 watch 进程，也不再有计费服务（见 ADR-012）。

## 1. 服务器准备

- 目标系统建议使用 64 位 Linux，安装 Docker Engine、Compose Plugin、`curl`、`awk`。
- 为 COS 临时下载、ffmpeg 输出和镜像更新预留至少 10 GiB 可用磁盘。
- 将 `80/tcp`、`443/tcp` 放行；保留 DSH 所需的 `18153/tcp`；PostgreSQL、Redis、API 和 Gateway 只绑定本机或 Compose 网络。
- 为 App、Admin、API 配置三个解析到服务器的域名。
- 在服务器创建部署目录，例如 `/opt/ai-assistant`，放置 `docker-compose.prod.yml`、`remote-deploy.sh` 和 `.env.production`。
- 从 `.env.production.example` 创建服务器环境文件，使用 URL 编码后的数据库密码填写连接串。
- 在服务器执行镜像仓库登录。`IMAGE_REGISTRY`、`IMAGE_NAMESPACE` 必须和 CI 的 `REGISTRY`、`IMAGE_NAMESPACE` 一致，三个仓库名固定为 `ai-assistant-api`、`ai-assistant-gateway`、`ai-assistant-migrate`。

生产数据从空环境初始化，不迁移旧 PostgreSQL 或 MinIO 数据。

### 面试体验账号（可选）

如果要让面试官免注册试用，在服务器的 `.env.production` 中加入以下配置：

```dotenv
DEMO_ACCOUNT_ENABLED=true
DEMO_ACCOUNT_USERNAME=demo
DEMO_ACCOUNT_PASSWORD=<至少 8 位的独立密码>
```

登录页会显示该账号并提供“一键进入体验”。API 首次请求会自动创建用户，之后只复用这一个用户；体验数据与其他账号按 `userId` 隔离。不要把体验密码复用于管理员或个人账号。关闭演示时将 `DEMO_ACCOUNT_ENABLED=false` 并重启 API 即可，已有普通账号不受影响。

## 2. 首次生产部署

镜像应在本地或 CI Runner 构建并推送，服务器只拉取和运行。首次部署前确认 DSH 保持正常运行。

```bash
export DEPLOY_ROOT=/opt/ai-assistant
bash /opt/ai-assistant/remote-deploy.sh <commit-sha>
```

脚本依次拉取镜像、执行主库 Prisma 迁移、更新容器并等待所有服务健康。成功镜像标签写入 `.deployed-image-tag`；失败时自动恢复上一标签。

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

正常拓扑应只有 `gateway`、`api`、`worker`、`postgres`、`redis`（5 个容器），不能出现 MinIO 或三套独立 Worker。Gateway 的宿主机端口应显示为 `127.0.0.1:18080->80/tcp`。

## 3. 真实资源测试

在仓库目录或服务器部署目录运行采样脚本。默认每 5 秒采样并持续 2 小时，输出写到 `/tmp`。

```bash
PROFILE_DURATION_SECONDS=7200 PROFILE_INTERVAL_SECONDS=5 \
  PROFILE_SCENARIO=idle \
  COMPOSE_PROJECT_NAME=ai-assistant \
  DEPLOY_ROOT=/opt/ai-assistant \
  bash /opt/ai-assistant/profile-resources.sh
```

固定场景建议分别使用 `idle`、`normal-five-users`、`chat`、`knowledge`、`media-single` 作为 `PROFILE_SCENARIO`，输出中会同时记录容器 RSS/CPU 与 API、Worker 的 Node Heap/External 数据。

按以下顺序测试，期间不要停止或限制服务器上的另一应用：

1. 冷启动并等待全部健康，随后空闲 30 分钟。
2. 模拟最多五名用户执行登录、对话流、模型选择和普通页面操作。
3. 完成知识库上传、索引、检索和额度校验。
4. 验证充值、会员、余额不足、预占、结算和退款。
5. 小说、商家宣传视频、Codex Pet 重任务逐类串行执行，每类至少三次。
6. 检查任务完成后 Worker RSS 是否回落，临时目录是否清理。
7. 依次重启 API、Worker、Redis 和 PostgreSQL，验证恢复与重试。
8. 执行一次上一镜像标签回滚，再部署当前标签。

目标区间不是 cgroup 硬限制：空闲约 `1.1-1.4 GiB`，普通五用户约 `1.4-1.8 GiB`，单个重任务尽量接近 `2 GiB`。不得出现 OOM、持续增长的 Swap、任务完成后内存不回落或另一应用明显变慢。

## 4. 手动回滚

```bash
export DEPLOY_ROOT=/opt/ai-assistant
bash /opt/ai-assistant/rollback-compose.sh <previous-commit-sha>
```

主库迁移必须保持向后兼容。破坏性迁移不能进入自动发布，需要单独备份、维护窗口和回滚方案。

## 5. CI/CD 配置

发布由 `.github/workflows/production.yml` 负责，**手动触发，且只允许从 `main` 触发**，并会先校验该提交有一次成功的 `CI` 记录。校验通过后在**自建 Mac runner**（标签 `release-mac`）上构建 `api`/`migrate`/`gateway` 三个镜像，经 regctl 按 4 MiB 分块推到 TCR，最后 SSH 到服务器执行 `remote-deploy.sh`。

> **为什么镜像构建仍在自建 Mac runner 上**（2026-10-13 反复过一次，结论是不要换）：当天一度改成 `ubuntu-latest`，理由是缓存 scope 不再随发布 tag 漂移、原生 `linux/amd64` 免 Rosetta、不必要求那台 Mac 醒着。当晚一次真实发布的实测推翻了其中大部分收益 ——
>
> - GitHub 托管 runner 出境到 TCR 实测约 **17 KB/s**（regctl 每 4 MiB 分块耗时约 4 分钟）。api 的 522 MB 归档按此速率要几小时，三个镜像全部耗满 60 分钟上限被强杀，`deploy` 跳过。
> - 同一时刻 Mac→TCR 是 **0.44~0.84 MB/s**，用的是逐字相同的 regctl 参数，快约 50 倍。
> - 参照物：同一天 blog（`ubuntu-latest` + 裸 `push: true`，同一个 TCR）的 backend 光 `pushing layers` 就要 **988 秒**。**blog 不是「推得动」，是它的最终镜像只有 alpine + 一个 Go 静态二进制，量小到能忍。** 本项目 api 是长驻 Node 服务，必须带 node_modules。
>
> 所以这里保留自建 runner。代价照旧：发布时那台 Mac 必须醒着且 Docker Desktop 在跑，构建走 Rosetta 模拟 `amd64`。触发方式（`workflow_dispatch` on main）与缓存 scope 的改动则保留 —— 那部分是对的。

日常发布：在 Actions 里对着 `main` 手动跑一次 `Release to production`，或命令行：

```bash
gh workflow run production.yml --ref main
```

版本号照旧用 git tag 标在 `main` 上，但**tag 本身不再触发发布**（2026-10-13 从 tag 触发改为手动触发，详见工作流顶部注释）。

仓库环境需要配置：

- `REGISTRY`、`REGISTRY_USERNAME`、`REGISTRY_PASSWORD`
- `IMAGE_NAMESPACE`
- `DEPLOY_HOST`、`DEPLOY_PORT`、`DEPLOY_USER`、`DEPLOY_PRIVATE_KEY`
- `DEPLOY_ROOT`

服务器上的 `.env.production` 和 Registry 登录凭据不由 CI 覆盖。正式上线前应为 PostgreSQL 数据卷建立独立备份，并定期验证恢复。
