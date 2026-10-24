# 轻量生产部署与服务器资源验收

本文档对应 `docker-compose.prod.yml`。API 和统一 Worker 通过 `tsx` 运行 TypeScript 源码；Web/Admin 编译后由 Gateway 容器提供。宿主机现有 Caddy 负责 DSH 和三个生产域名的 HTTPS，Gateway 只监听本机 `18080`。生产不运行 Kubernetes、MinIO、Vite 或 watch 进程，也不再有计费服务（见 ADR-012）。

> 边界说明（2026-10-23）：`docker-compose.dev.yml` 是**本地开发专用**文件——除 pg/redis 外，它通过 `--profile app` 提供把 API / 两个 Worker / Web / Admin 也放进容器的开发模式（用法见 README「全容器模式」）。它与本文档的生产链路（`docker-compose.prod.yml`、`infra/docker/api` 等）完全独立：dev 侧新增的 `infra/docker/dev/Dockerfile` 只在本地构建（`ai-assistant-dev:local`），不进 CI、不推镜像仓库、不影响发版。

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

发布由 `.github/workflows/production.yml` 负责，**手动触发，且只允许从 `main` 触发**，并会先校验该提交有一次成功的 `CI` 记录。校验通过后在 `ubuntu-latest` 上构建 `api`/`migrate`/`gateway` 三个镜像，用 `docker/build-push-action` 直接 `push` 到 TCR，最后 SSH 到服务器执行 `remote-deploy.sh`。**这个形状和同服务器的 blog 项目（`.github/workflows/deploy.yml`）完全一致。**

> **为什么是这个形状**（2026-10-14 定稿，此前在托管 runner 与自建 Mac runner 之间反复过两轮）：
>
> 关键不是 runner 快慢，而是**每轮真正要出境的字节数**。api 镜像逐层实测（本机 `docker save` 后按每层 gzip blob 量）：
>
> | 层 | blob（压缩后） | 每轮会不会变 |
> |---|---|---|
> | Debian base | 26.9 MiB | 否 |
> | node 24 | 48.0 MiB | 否 |
> | apt + 中文字体 | 18.3 MiB | 只在改 Dockerfile 时 |
> | `node_modules` | **77.1 MiB** | 改依赖 / `schema.prisma` / `packages/*` 任何源码时 |
> | 应用源码 | **0.56 MiB** | **每轮都变** |
> | 合计 | 172.6 MiB | |
>
> - 只改 `apps/api` 的一轮，真正会变的只有 **0.56 MiB** 那层应用源码。
> - **2026-10-14 换回托管 runner 后的第一轮真发版实况**（run `38496624858`）：校验 4s ｜ api 10m08s（推送 576s）｜ migrate 11m02s（推送 638s）｜ gateway 51s（推送 **5s**）｜ deploy 1m56s ｜ **合计 13m06s**，比自建 Mac runner 那一轮的 15m13s 还快。
> - 三个镜像差这么多，原因都能对上：**gateway 终帧是 `FROM caddy:2.10-alpine`**，基础层在 TCR 里早就有，只推了几 MB 的前端产物；api / migrate 都基于 `node:24-bookworm-slim`，那一轮把**整份镜像**重推了一遍（api ≈181 MB）。
> - ❗**api 为什么要整份重推：换了构建机。** BuildKit 会把目录的 mtime 写进层的 tar，所以「同一份内容在不同机器上构建」得到的层 digest 不同 —— TCR 认的是 digest，不是「内容差不多」。Dockerfile 里那串 `touch -h -d @0` 与删 apt 日志只能保证**同一台机器上**两次构建逐字相同。**换构建机 ⇒ 第一轮必然整镜像重推。**
> - ❗**速率要更正一个此前的误判**：换回托管 runner 后实测 **181 MB / 576s ≈ 0.3 MB/s**，与 Mac→TCR 的 0.44~0.84 MB/s 同一量级。此前记的「托管 runner 只有 17 KB/s」是 **regctl `--req-concurrent 1` 把 4 MiB 分块串行 PATCH 造出来的假象**，不是这条链路的能力；裸 `push: true` 快约 18 倍。
> - 构建本身几乎不花时间：那一轮所有步骤都是 `CACHED`（10-13 那次 ubuntu 尝试已把 BuildKit 缓存写进 gha，7 天内可命中），构建约 25 秒。**gha 缓存还有个隐性作用**：它把层内容钉住，层 digest 才跨轮次稳定，TCR 才会认 `Layer already exists`。缓存过期（7 天不访问）后重建会让整镜像重推一轮（约 20~25 分钟）—— 是「慢」不是「失败」，120 分钟上限容得下。
> - 2026-10-13 那次 `ubuntu-latest` 发布红掉，是因为那个提交**同时改了 Dockerfile**（字体剪枝 + `node_modules` 剪枝），逼着 77.1 MiB 与 18.3 MiB 两层一起重推 ≈95 MiB > 当时的 60 分钟上限。**那是特例，不是规律** —— 所以现在 `timeout-minutes` 是 120。
> - 参照物：同一天 blog（`ubuntu-latest` + 裸 `push: true`，同一个 TCR）的 backend 光 `pushing layers` 就要 **988 秒（16.5 分钟）**。**blog 不是「推得动」，是它每一轮要传的新字节少到能忍。**
> - 换回托管 runner 之后不再要求那台 Mac 醒着，也不必再跑 Rosetta 模拟 `amd64`。原先那套 `regctl` 4 MiB 分块推送是 Mac 专有的绕行手段，一并删除。
> - **仍未拆的雷**：`node_modules` 那 77.1 MiB 里第三方依赖占 99.8%，而**一层就是一个 blob** ⇒ 改 `packages/` 一行代码也会整层重推。打包（esbuild 把 api 打成单文件）实测 6.6 MiB，代价是把最常见的轮次从 0.56 MiB 抬到 ~7 MiB，**净亏**，所以不做。

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
