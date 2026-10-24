# 开发环境容器化方案（评审稿）

- 日期：2026-10-22（2026-10-23 完成评审，修订已并入正文，记录见 §11）
- 状态：已评审，待执行
- 目标读者：项目负责人

---

## 1. 目标与范围

### 1.1 唯一目标

把当前跑在宿主机的 **5 个 node 进程**放进 Docker，让 `docker compose up` 一套命令起完整开发环境：

| 服务 | 宿主现状 | 容器化后 |
|---|---|---|
| API（Fastify） | `tsx watch src/server.ts`，端口 8090 | 容器 `api` |
| Novel Worker | `tsx watch src/workers/novel-worker.ts`，端口 8091 | 容器 `novel-worker` |
| Codex Pet Worker | `tsx watch src/workers/codex-pet-worker.ts`，端口 8092 | 容器 `codex-pet-worker` |
| Web（Vite） | `vite`，端口 5174 | 容器 `web` |
| Admin（Vite） | `vite`，端口 5175 | 容器 `admin` |
| postgres | 已在容器 | **不动** |
| redis | 已在容器 | **不动** |

### 1.2 明确不改的东西

- **不改 compose 项目名**（保持默认 `aiproject`）
- **不迁移、不拷贝、不重建数据卷**
- 不动 `pnpm dev` 与 `scripts/dev-local.sh`（宿主模式原样保留，作为退路）
- 不动 `turbo.json`
- 不动生产链（`docker-compose.prod.yml`、`infra/docker/api/Dockerfile`、CI、部署脚本）

---

## 2. 现状实测

| 项 | 值 | 来源 |
|---|---|---|
| compose 项目名 | `aiproject` | `docker ps` 标签 |
| 数据卷 | `aiproject_ai_assistant_pg` | `docker volume ls` |
| 开发库大小 | **806 MB** | `pg_database_size` |
| 主要数据 | `CodexPetEvent` 8772 行、`CodexPetJob` 2131 行、`NovelRunEvent` 1748 行、`AdminAudit` 1375 行 | `pg_stat_user_tables` |
| 当前运行容器 | `aiproject-postgres-1`、`aiproject-redis-1` | `docker ps` |
| 宿主 node | 当前 shell 为 **v22.22.2**，`engines` 要求 **≥24** | `node -v` / `package.json` |
| pnpm | 10.26.2 | `pnpm -v` |
| Docker / Compose | 29.2.0 / v5.0.2 | `docker info` / `compose version` |
| 源码规模 | api 464、web 304、admin 23、packages 57 个源文件 | `find` |
| 根 node_modules | 756 MB（子包仅 16~60 KB 软链） | `du` |

> 评审注（2026-10-23）：上表"宿主 node v22.22.2"为撰写时某 shell 的实测；评审当日另一 shell 实测为 v24.18.0（engines 已满足）。宿主版本随 shell/nvm 漂移，恰说明把版本固定进容器的价值；§6 对应风险行已按此更新。

### 2.1 已完成的可行性验证

用 `node:24-bookworm-slim` 起隔离容器，bind mount 目录后测 `fs.watch`：

| 操作 | 延迟 |
|---|---|
| 宿主新建文件 | **16 ms** |
| 宿主追加内容 | **17 ms** |
| 深层子目录新建 | **18 ms** |
| 删除文件 | 189 ms |

**结论**：VirtioFS 的 inotify 事件完整可用，不需要 `CHOKIDAR_USEPOLLING`，也不需要 `compose watch` 同步。容器内 `max_user_watches` 为 1,048,576，源码仅 848 个文件，无压力。

---

## 3. 核心决策

### 决策 1：改现有 `docker-compose.dev.yml`，不新建文件

| 方案 | 评价 |
|---|---|
| **A. 在现有文件加服务 + `profiles`（采纳）** | 项目名不变 → 卷不变 → 数据完全不受影响；`pnpm dev:infra` 语义不变 |
| B. 新建 `docker-compose.dev-full.yml` | 同一项目名下服务名重复，两文件不能同时 `up`，容易误操作 |
| C. 新建文件 + 独立项目名 | 会挂到新卷，看起来像数据丢失。**否决** |

用 `profiles: ["app"]` 隔离，保证现有命令行为不变：

```bash
pnpm dev:infra                                                # 不带 profile → 只起 pg/redis（同现在）
docker compose -f docker-compose.dev.yml --profile app up -d  # 起全部 7 个服务
```

> **评审更正（2026-10-23）**：原示例第二行漏了 `-f docker-compose.dev.yml`。compose 默认只发现 `compose.yaml` / `docker-compose.yml`，本仓库根目录没有这两个文件（只有 `docker-compose.dev.yml` / `docker-compose.prod.yml`），不带 `-f` 必报 *no configuration file provided*。任何手动命令一律带 `-f`（§5.3 脚本、§5.4 命令原本就带）。

### 决策 2：依赖烤进镜像，不挂 node_modules 卷

| 方案 | 评价 |
|---|---|
| **A. Dockerfile 内 `pnpm install`，运行时只挂源码目录（采纳）** | 零个 node_modules 卷；软链问题不存在；启动快 |
| B. blog 的指纹卷（`dev-entrypoint.sh` 按 hash 装依赖） | aiproject 有 5 个 node 容器共享同一个卷，并发 `pnpm install` 会互踩，需额外 `deps` 服务串行化。**第一版不做** |

代价：改 `package.json` 要 `docker compose --profile app up -d --build`。lockfile 不变时 install 层命中缓存，实际很快。

### 决策 3：只挂源码子目录，不挂 `apps` 整棵

理由：`apps/*/node_modules` 是 pnpm 生成的相对软链，指向 `.pnpm/<pkg>@<ver>_<peerhash>/`。挂整棵会把宿主的（darwin 安装的）软链带进容器，与容器内安装结果混用，典型症状是 `Cannot find module` 但依赖明明装了。

挂载清单：

| 宿主 | 容器 |
|---|---|
| `./apps/api/src` | `/repo/apps/api/src` |
| `./apps/web/src` | `/repo/apps/web/src` |
| `./apps/web/index.html` | `/repo/apps/web/index.html` |
| `./apps/web/vite.config.ts` | 同路径 |
| `./apps/web/tailwind.config.js` | 同路径 |
| `./apps/web/postcss.config.js` | 同路径 |
| `./apps/admin/src` | `/repo/apps/admin/src` |
| `./apps/admin/index.html` | 同路径 |
| `./apps/admin/vite.config.ts` | 同路径 |
| `./packages/article-workflow/src` | 同路径 |
| `./packages/codex-pet-pipeline/src` | 同路径 |
| `./packages/db/src` | 同路径 |
| `./packages/llm/src` | 同路径 |
| `./packages/novel-workflow/src` | 同路径 |

`node_modules` 全部来自镜像，不参与挂载。

### 决策 4：5 个服务共用一个镜像

`api`、`novel-worker`、`codex-pet-worker`、`web`、`admin` 用同一个 `infra/docker/dev/Dockerfile` 构建产物，只是 `command` 不同。只构建一次，共享层缓存。

### 决策 5：数据库迁移用独立的一次性服务

不改 api 的启动命令，避免迁移失败时 api 静默起不来：

```yaml
migrate:
  profiles: ["app"]
  command: pnpm --filter @ai-assistant/db exec prisma migrate deploy
  depends_on: { postgres: { condition: service_healthy } }
  restart: "no"

api:
  depends_on:
    migrate: { condition: service_completed_successfully }
```

---

## 4. 数据安全说明

### 4.1 为什么这次改动不会丢数据

**容器和卷的生命周期是分开的。** 卷 `aiproject_ai_assistant_pg` 是独立存储实体，删容器、重建容器都不影响它。

本次方案：
- 项目名保持 `aiproject` → 卷名仍是 `aiproject_ai_assistant_pg`
- postgres 服务定义只加 `healthcheck` 和端口绑定 IP → `up -d` 时**会重建 postgres 容器**（配置变了）
- 新容器挂载同一个卷 → 打开就是原来那 806 MB

**唯一会丢数据的操作是 `docker compose down -v` 或 `docker volume rm`**，本方案两处都不使用。

### 4.2 自证方法（评审时可要求执行）

```bash
docker compose -f docker-compose.dev.yml up -d --force-recreate postgres
docker exec aiproject-postgres-1 psql -U ai-assistant -d ai-assistant -tAc 'select count(*) from "CodexPetEvent";'
```

预期输出仍为 `8772`。

### 4.3 仍然建议做一次备份（非方案前提）

```bash
mkdir -p .data/backups
docker exec aiproject-postgres-1 pg_dump -U ai-assistant -d ai-assistant -Fc -f /tmp/dev-backup.dump
docker cp aiproject-postgres-1:/tmp/dev-backup.dump .data/backups/dev-20261022.dump
```

这不是方案的前置条件，只是"改环境前先留底"的常规习惯。806 MB 库约需 30~60 秒。

---

## 5. 实施细节

### 5.1 新增 `infra/docker/dev/Dockerfile`

```dockerfile
# 开发镜像：只服务本地 compose，不进生产链路。
# 与生产 infra/docker/api/Dockerfile 共用同一个基础镜像，避免 dev/prod node 版本漂移。
FROM node:24-bookworm-slim

ARG NPM_CONFIG_REGISTRY=https://registry.npmmirror.com
ARG PRISMA_ENGINES_MIRROR=https://registry.npmmirror.com/-/binary/prisma
ENV npm_config_registry=${NPM_CONFIG_REGISTRY}
ENV PRISMA_ENGINES_MIRROR=${PRISMA_ENGINES_MIRROR}

# argon2 在 pnpm-workspace.yaml 的 allowBuilds 里，没有工具链装不上。
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@10.26.2 --no-audit --no-fund

WORKDIR /repo

# 依赖层：只有 package.json / lockfile 变化才重跑
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/admin/package.json apps/admin/package.json
COPY packages/article-workflow/package.json packages/article-workflow/package.json
COPY packages/codex-pet-pipeline/package.json packages/codex-pet-pipeline/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/llm/package.json packages/llm/package.json
COPY packages/novel-workflow/package.json packages/novel-workflow/package.json
RUN pnpm install --frozen-lockfile

# Prisma Client 层：只有 schema 变化才重跑
COPY packages/db/prisma packages/db/prisma
RUN pnpm --filter @ai-assistant/db generate

COPY tsconfig.base.json ./
COPY apps apps
COPY packages packages

ENV NODE_ENV=development
```

`.dockerignore` 已排除 `.env`、`.env.*`、`docs`、`**/*.test.ts`、`node_modules`，无需改动。

**注意**：`.env` 必须排除在镜像之外——理由是**密钥卫生**：镜像层会被缓存、复用，密钥一旦进层就无法回收。

> **评审更正（2026-10-23）**：原文以"`process.loadEnvFile` 会覆盖 `process.env`，镜像内若有 `.env` 会把 `DATABASE_URL` 打回 `localhost:5433`"为由论证"必须排除"。该机制**经实测不成立**：node v24.18.0（与容器 node:24 同大版本）实测 `process.loadEnvFile` **不覆盖**已存在的进程环境变量；仓库自身也依赖这一语义——`env-file.ts` 先加载 `.env.local` 再加载 `.env`（先加载者优先），`dev-local.sh` 的注释明言两层按同序层叠。且 compose 的 `environment:` 本就优先于 `env_file:`，`DATABASE_URL` 是双保险。结论（排除 `.env`）保留，论证更正如上，避免后续按错误机制排查环境问题。

### 5.2 `docker-compose.dev.yml` 改造

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg17
    environment:
      POSTGRES_USER: ai-assistant
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-postgres-password-placeholder}
      POSTGRES_DB: ai-assistant
    ports: ["127.0.0.1:5433:5432"]     # 原为 0.0.0.0，顺手收紧
    volumes: ["ai_assistant_pg:/var/lib/postgresql/data"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ai-assistant -d ai-assistant"]
      interval: 3s
      timeout: 5s
      retries: 20

  redis:
    image: redis:7
    ports: ["127.0.0.1:6380:6379"]     # 同上
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 3s
      timeout: 3s
      retries: 20

  migrate:
    profiles: ["app"]
    build: { context: ., dockerfile: infra/docker/dev/Dockerfile }
    image: ai-assistant-dev:local
    working_dir: /repo
    env_file: [.env]
    environment:
      DATABASE_URL: postgresql://ai-assistant:${POSTGRES_PASSWORD:-postgres-password-placeholder}@postgres:5432/ai-assistant
      REDIS_URL: redis://redis:6379
    command: pnpm --filter @ai-assistant/db exec prisma migrate deploy
    depends_on: { postgres: { condition: service_healthy } }
    restart: "no"

  api:
    profiles: ["app"]
    image: ai-assistant-dev:local
    working_dir: /repo
    init: true
    command: pnpm --filter @ai-assistant/api dev
    ports: ["127.0.0.1:8090:8090"]
    env_file: [.env]
    environment:
      DATABASE_URL: postgresql://ai-assistant:${POSTGRES_PASSWORD:-postgres-password-placeholder}@postgres:5432/ai-assistant
      REDIS_URL: redis://redis:6379
      PORT: "8090"
    volumes:
      - ./apps/api/src:/repo/apps/api/src
      - ./packages/db/src:/repo/packages/db/src
      - ./packages/llm/src:/repo/packages/llm/src
      - ./packages/novel-workflow/src:/repo/packages/novel-workflow/src
      - ./packages/article-workflow/src:/repo/packages/article-workflow/src
      - ./packages/codex-pet-pipeline/src:/repo/packages/codex-pet-pipeline/src
    depends_on:
      migrate: { condition: service_completed_successfully }
      redis: { condition: service_healthy }

  novel-worker:
    profiles: ["app"]
    image: ai-assistant-dev:local
    working_dir: /repo
    init: true
    command: pnpm --filter @ai-assistant/api worker:novel:dev
    env_file: [.env]
    environment: *app-env          # 同上
    volumes: *app-src
    depends_on:
      migrate: { condition: service_completed_successfully }
      redis: { condition: service_healthy }

  # codex-pet-worker 同上，command: worker:codex-pet:dev
  # web / admin 见下

  web:
    profiles: ["app"]
    image: ai-assistant-dev:local
    working_dir: /repo
    init: true
    command: sh -c "pnpm --filter @ai-assistant/web dev -- --host 0.0.0.0 --port 5174"
    ports: ["127.0.0.1:5174:5174"]
    environment:
      PORT: "5174"
      API_PROXY_TARGET: http://api:8090     # 容器内直连，不走宿主
    volumes:
      - ./apps/web/src:/repo/apps/web/src
      - ./apps/web/index.html:/repo/apps/web/index.html
      - ./apps/web/vite.config.ts:/repo/apps/web/vite.config.ts
      - ./apps/web/tailwind.config.js:/repo/apps/web/tailwind.config.js
      - ./apps/web/postcss.config.js:/repo/apps/web/postcss.config.js
      - ./packages/novel-workflow/src:/repo/packages/novel-workflow/src
      - ./packages/article-workflow/src:/repo/packages/article-workflow/src
    depends_on: { api: { condition: service_started } }

  admin:
    profiles: ["app"]
    image: ai-assistant-dev:local
    working_dir: /repo
    init: true
    command: sh -c "pnpm --filter @ai-assistant/admin dev -- --host 0.0.0.0 --port 5175"
    ports: ["127.0.0.1:5175:5175"]
    environment:
      PORT: "5175"
      API_PROXY_TARGET: http://api:8090
    volumes:
      - ./apps/admin/src:/repo/apps/admin/src
      - ./apps/admin/index.html:/repo/apps/admin/index.html
      - ./apps/admin/vite.config.ts:/repo/apps/admin/vite.config.ts
    depends_on: { api: { condition: service_started } }

volumes:
  ai_assistant_pg:
```

（`*app-env` / `*app-src` 用 YAML anchor 复用，正式实现时补齐。`migrate`、`api` 等 5 个服务都带 `build`/`image` 同一份，`up --build` 只构建一次。）

**评审补充（2026-10-23）——三点**：

1. **`.env.local` 层叠**：宿主模式 `dev-local.sh` 按 `.env` → `.env.local` 层叠，`.env.local` 只覆盖写到的键（QA 覆盖常用）。上方 compose 只写了 `env_file: [.env]`，会让 `.env.local` 在 docker 模式被**静默忽略**，两种模式配置分叉。带 app profile 且需要环境变量的服务（migrate / api / 两个 worker）改用：

   ```yaml
   env_file:
     - path: .env
     - path: .env.local
       required: false   # 不存在不报错；存在则加载，期望后者覆盖同名键，顺序与宿主模式一致
   ```

   compose 2.24+ 支持长写法 `required`，本机 compose v5.0.2 满足。**覆盖方向以 §7 验收 #11 实测为准**（此为 compose 文档行为，不实测不放心）。

2. **worker 端口不发布**：`novel-worker` / `codex-pet-worker` 不映射端口。8091/8092 只是各自的健康端口（`NOVEL_WORKER_HEALTH_PORT` / `CODEX_PET_WORKER_HEALTH_PORT` 可改），全仓库无外部引用，不发布不影响功能；代价是宿主探不了 worker 健康 endpoint，排查用 `pnpm dev:docker:logs`，确需探活再临时加 `127.0.0.1:8091:8091` 之类的映射。

3. **pg/redis 端口收紧的影响面**：`127.0.0.1:5433/6380` 绑定后，从宿主以外的机器（或 VM）连宿主 5433/6380 的场景会断。默认收紧是对的，此处留档说明，有此需求者自行开洞。

### 5.3 新增 `scripts/dev-docker.sh`

顺序：
1. 检查 `docker` 命令与 daemon 可用（`docker info` 超时则提示「先启动 Docker Desktop」）
2. 检查 `.env` 存在，不存在则从 `.env.example` 复制并提示补密钥；同时检测 `.env.local`，存在则打印一行「已层叠加载 .env.local」（见 §5.2 评审补充 1）
3. 检查 8090 / 5174 / 5175 是否被占。**被占就明确报错**而不是自动换端口 —— 这三个端口被 Vite 代理和前端地址硬编码，换端口会断。（评审补充：**不**检查 5433/6380 —— pg/redis 与 `pnpm dev:infra` 是同一 compose 项目的同一批服务，不存在自冲突；写明这一点，防止后人"补全"端口列表反而引入混乱）
4. `docker compose -f docker-compose.dev.yml --profile app up -d --build`
5. 轮询 `http://127.0.0.1:8090/ready` 直到 200，超时 90 秒
6. 打印地址表

### 5.4 `package.json` 新增

```json
"dev:docker": "bash scripts/dev-docker.sh",
"dev:docker:down": "docker compose -f docker-compose.dev.yml --profile app down",
"dev:docker:logs": "docker compose -f docker-compose.dev.yml logs -f api novel-worker codex-pet-worker web admin"
```

`dev:docker:down` **不带 `-v`**，这是硬约束；**带 `--profile app`**（评审补充）：现代 compose 的 `down` 通常也会停掉运行中的 profile 容器，显式写出消除版本差异，由验收 #10 一并确认。

---

## 6. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 首次构建 4~8 分钟 | 等待 | 属一次性成本；之后 `up` 秒级 |
| 镜像约 2.0~2.3 GB | 磁盘 | 当前剩余 373 GB，无压力 |
| 加 healthcheck 会重建 postgres 容器 | 一次短暂中断 | 数据在卷里，不受影响；§4.2 可自证 |
| 改 `package.json` 要重建镜像 | 2~4 分钟 | lockfile 未变时 install 层命中缓存 |
| 与 `pnpm dev` 抢端口 | 起不来 | 脚本启动前检查并明确报错 |
| 容器 node 版本（24.x）与宿主实测值漂移（§2 记 v22.22.2，评审当日另一 shell 为 v24.18.0） | 潜在行为差异 | 这是个**改进**：容器固定 24，与生产同基础镜像，"本地能跑线上不能"的风险下降；宿主版本以执行时实测为准 |
| 改 `packages/db/prisma/schema.prisma` 后 Client 是旧的 | 类型/运行时不符 | 第一版：改 schema 时 `--build`；后续加 `dev:docker:generate` |
| HMR WebSocket 不通 | 页面不自动刷新 | 容器内端口与宿主相同（5174/5175），Vite 默认 `clientPort` 即可；`--host 0.0.0.0` 必须加 |
| `.env.local` 在 docker 模式未加载 | 宿主/docker 模式配置静默分叉 | 评审新增：compose env_file 长写法层叠（§5.2 评审补充 1），覆盖方向由验收 #11 实测 |
| worker 健康 endpoint 宿主不可达（8091/8092 未发布） | 排查 worker 状态不便 | 评审新增：排查用 `dev:docker:logs`；确需探活再临时加 127.0.0.1 端口映射 |
| pg/redis 改绑 127.0.0.1 后，宿主外机器连不上 5433/6380 | 影响从 VM/其他设备直连的场景 | 评审新增：默认收紧正确，留档说明（§5.2 评审补充 3）；有此需求者单独开洞 |

---

## 7. 验收标准

| # | 检查项 | 通过条件 |
|---|---|---|
| 1 | `pnpm dev:infra` 行为 | 只起 pg/redis，与改动前一致 |
| 2 | `pnpm dev` 行为 | 宿主模式照常，不受影响 |
| 3 | `pnpm dev:docker`（前置：镜像已构建） | 90 秒内 7 个容器 ready，打印地址。评审修订：首次运行含 4~8 分钟构建，单独计时，不计入本条（原文与 §6 首建时长自相矛盾） |
| 4 | 数据完整性 | `select count(*) from "CodexPetEvent"` = 8772 |
| 5 | Web 可访问 | `http://localhost:5174` 打开落地页，无 502 |
| 6 | Admin 可访问 | `http://localhost:5175` 可登录 |
| 7 | API 热重载 | 改 `apps/api/src/server.ts` 里一个字符串，2 秒内日志出现重启 |
| 8 | 前端 HMR | 改 `apps/web/src/App.tsx` 里文案，浏览器无需手动刷新 |
| 9 | Worker 消费 | 触发一次 novel 任务，`novel-worker` 日志有消费记录 |
| 10 | 停止不删数据 | `pnpm dev:docker:down` 后 `docker volume ls` 仍有 `aiproject_ai_assistant_pg`，且 app profile 的 7 个容器全部移除（评审补充：顺带验证 `--profile app` 生效） |
| 11 | `.env.local` 层叠方向（评审新增，若实现 §5.2 评审补充 1） | 同名键分别写入 `.env`（值 base）与 `.env.local`（值 local），`docker compose -f docker-compose.dev.yml exec api printenv 该键` 得 `local`；仅存在于 `.env` 的键仍生效 |

---

## 8. 不做的事

- 不做 `deps` 指纹自动重装（第二版）
- 不迁移调试工具进容器（Vitest、tsc 仍在宿主跑）
- 不改生产链路
- 不改 `dev-local.sh` 的进程管理
- 不引入 `compose watch`（实测 inotify 已够快）
- 不处理 COS 的 `S3_KEY_PREFIX=dev` 与生产桶共享这一既有风险（超出本次范围）

---

## 9. 工作量与顺序

| 步骤 | 产出 | 预计 |
|---|---|---|
| 1 | `pg_dump` 备份 | 5 分钟 |
| 2 | `infra/docker/dev/Dockerfile` | 30 分钟 |
| 3 | `docker-compose.dev.yml` 加 5 服务 + healthcheck | 1 小时 |
| 4 | `scripts/dev-docker.sh` | 1 小时 |
| 5 | 首次构建 + 调试 | 1~2 小时 |
| 6 | 逐条跑 §7 验收 | 1 小时 |
| 7 | 更新 `docs/deploy-compose.md` 与 `README.md` | 30 分钟 |

合计约 **1 个工作日**。

---

## 10. 回滚

任何一步出问题，回滚成本接近零：

```bash
docker compose -f docker-compose.dev.yml down
pnpm dev
```

`down` 不删卷、不删数据。宿主模式一行命令即可恢复原状。

---

## 11. 评审记录（2026-10-23）

评审方式：对照仓库现状逐项核实计划引用的事实（脚本、配置、lockfile、路由、监听地址），并对关键机制实测验证。**结论：方向正确、事实核对总体扎实；发现 2 个必改错误、2 个建议项、5 个小项，均已就地并入正文（标注「评审更正 / 评审补充 / 评审修订」）。修订后可执行。**

### 11.1 已核实为正确的关键点

执行时可放心依赖，无需复查：

- **包名与脚本名全部存在**：`@ai-assistant/api|web|admin|db`；`dev` = `tsx watch src/server.ts`、`worker:novel:dev`、`worker:codex-pet:dev`、db 的 `generate`（apps/api/package.json:8-16、packages/db/package.json:8）。
- **vite 代理真实读取计划注入的变量**：web/admin 的 vite.config 均读 `process.env.PORT` 与 `process.env.API_PROXY_TARGET`（apps/web/vite.config.ts:31-34、apps/admin/vite.config.ts:11-14）。注入 `API_PROXY_TARGET: http://api:8090` 是必要的——缺省回落 `localhost:8090`，容器内必挂。
- **`/ready` 存在**（apps/api/src/server-health.ts:25）；API 绑定 `0.0.0.0`、端口 `PORT ?? 8090`（apps/api/src/server-lifecycle.ts:47、apps/api/src/server.ts:29），端口映射可通。
- **Dockerfile 的 package.json COPY 清单与 `pnpm-lock.yaml` importers 完全一致**（root + api/web/admin + 5 个 packages，共 9 个 importer）。工作区里的 `apps/desktop`（仅 node_modules 与 768 KB 的 out）与 `packages/connector-protocol`（仅 node_modules）不是 workspace 成员、不在 lockfile，不影响 `--frozen-lockfile`。
- **Prisma client 无自定义 output**（`prisma-client-js` 默认生成位置），生成物在 node_modules，不会被 bind mount 的 `src` 遮蔽——决策 3 的隐含前提成立。
- **worker 8091/8092 仅为健康端口**（`NOVEL_WORKER_HEALTH_PORT` / `CODEX_PET_WORKER_HEALTH_PORT`），全仓库无外部引用，不发布无碍。
- **文件存在性**：`.dockerignore` 各条目、`apps/web/tailwind.config.js` / `postcss.config.js`、`packages/db/prisma/schema.prisma`、`.env.example`、`docs/deploy-compose.md` 均与计划描述一致。
- **数据安全推理正确**：卷独立于容器生命周期；`down` 不带 `-v` 不删卷；项目名不变 → 卷名 `aiproject_ai_assistant_pg` 不变。
- **web/admin 源码无 `import.meta.env.VITE_*` 依赖**，两容器不挂 `env_file` 没问题。
- **挂载清单与依赖关系逐项对得上**：api 挂的 5 个 packages src 恰为其全部 workspace 依赖；web 挂 novel-workflow + article-workflow 正确；admin 无工作区依赖。

### 11.2 问题清单与处置

| 级别 | 问题 | 处置（均已并入正文） |
|---|---|---|
| P1 | §3 示例命令漏 `-f docker-compose.dev.yml`：compose 默认发现规则只找 `compose.yaml`/`docker-compose.yml`，仓库根目录两者皆无，命令必报 no configuration file | §3 已更正并加说明 |
| P1 | §5.1 以「`process.loadEnvFile` 覆盖 `process.env`」论证排除 `.env` 的必要性——node v24.18.0 实测**不覆盖**（仓库 env-file.ts 的加载顺序与 dev-local.sh 注释依赖的正是不覆盖语义；compose `environment` 亦优先于 `env_file`）。原失败模式不存在 | §5.1 已更正：结论保留，理由改为密钥卫生 |
| P2 | `.env.local` 在 docker 模式被静默忽略，与宿主模式（dev-local.sh 按 .env → .env.local 层叠）配置分叉 | §5.2 评审补充 1（env_file 长写法 `required: false` 层叠）、§5.3 步骤 2 提示、验收 #11 |
| P2 | 验收 #3「90 秒内 ready」与 §6「首建 4~8 分钟」自相矛盾，首跑必超时 | 验收 #3 已改为「镜像已构建」前置、首建单独计时 |
| P3 | worker 健康 endpoint 宿主不可达（8091/8092 未发布） | §5.2 评审补充 2 留档：排查用 logs，需探活再临时映射 |
| P3 | `dev:docker:down` 不带 `--profile app`，依赖 compose 版本行为 | §5.4 已加参数，验收 #10 一并确认 |
| P3 | pg/redis 改绑 `127.0.0.1` 后，宿主外机器连 5433/6380 会断，影响面未留档 | §5.2 评审补充 3、§6 新增风险行 |
| P3 | `dev-docker.sh` 为何不检查 5433/6380 未说明，恐被后人误「补全」 | §5.3 步骤 3 加注释说明 |
| P3 | §2 宿主 node v22.22.2 与评审当日实测 v24.18.0 不一致（shell/nvm 口径差异） | §2 表后评审注、§6 风险行更新；不影响方案本身 |
