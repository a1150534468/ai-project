# API 接口文档

项目使用 OpenAPI 3.0.3 和 Swagger UI 管理接口文档。文档由运行中的 Fastify 路由自动生成，并合并 Billing 服务的内部接口，因此新增主 API 路由不会从文档中漏掉。

## 文档入口

本地执行 `pnpm dev` 后访问：

| 地址 | 用途 |
| --- | --- |
| <http://localhost:8090/docs> | Swagger UI，可搜索、查看并直接调试接口 |
| <http://localhost:8090/docs/json> | Swagger UI 提供的 OpenAPI JSON |
| <http://localhost:8090/docs/yaml> | Swagger UI 提供的 OpenAPI YAML |
| <http://localhost:8090/openapi.json> | 稳定的 OpenAPI JSON 导出地址 |
| <http://localhost:8090/openapi.yaml> | 稳定的 OpenAPI YAML 导出地址 |

主 API 默认使用 `http://localhost:8090`。合并文档中的 `Billing ·` 分组会按接口级 `servers` 配置调用 `http://localhost:8093`，不会错误地请求到主 API。

## 认证方式

打开 Swagger UI 后点击右上角 **Authorize**，按接口分组填写对应凭据：

| 名称 | 使用范围 | 填写内容 |
| --- | --- | --- |
| `bearerAuth` | 普通用户接口 | `/api/auth/login` 返回的用户 JWT，只填 Token 本身 |
| `adminBearerAuth` | `/api/admin/*` 管理接口 | `/api/admin/login` 返回的管理员 JWT |
| `resellerBearerAuth` | `/api/reseller/*` 渠道商接口 | 具备渠道商权限的管理员 JWT |
| `billingInternalToken` | Billing 内部接口 | `.env` 中的 `BILLING_INTERNAL_TOKEN` |
| `callbackSecret` | 数字人回调 | 回调查询参数 `secret`，通常只由上游平台使用 |

普通用户 API 也接受登录 Cookie，但 Swagger UI 推荐使用 Bearer JWT。WebSocket 连接器在建立连接后的注册消息中提交设备 Token，不能通过 Swagger UI 的 REST 调试器直接测试。

## 接口分组

主 API 已按业务域整理：

| 分组 | 主要路径 | 内容 |
| --- | --- | --- |
| 认证 | `/api/auth/*` | 注册、登录 |
| 对话 | `/api/chat`、`/api/sessions/*` | 对话及历史会话 |
| 智能体 / 智能体团队 | `/api/agents/*`、`/api/agent-teams/*` | 智能体配置、团队编排和运行 |
| 长期记忆 | `/api/memory/*` | 记忆查询、搜索、修改和开关 |
| 知识库 | `/api/kb/*` | 知识库及文档上传管理 |
| 工具市场 | `/api/tool-market/*`、`/api/tools/*` | 工具目录、安装和卸载 |
| 设备与微信 | `/api/device/*`、`/api/wechat/*`、`/ws/connector` | 设备配对、连接器、微信绑定 |
| 计费、会员、VIP | `/api/billing/*`、`/api/membership/*`、`/api/vip/*` | 充值、余额、兑换、会员和模型市场 |
| 定时任务 | `/api/scheduled-tasks/*` | 定时任务配置和运行历史 |
| 图片 / 视频 / 配音工作流 | `/api/workflow/images/*`、`videos/*`、`dub/*` | 多媒体生成与素材管理 |
| 电商 / 本地商家工作流 | `/api/workflow/ecom/*`、`local-business-promos/*` | 电商图片、本地商家宣传视频 |
| 小说 / 漫剧工作流 | `/api/workflow/novels/*`、`comics/*` | 长篇内容工程、资产、版本和渲染 |
| 文章 / 报告 / 批量生成 | `/api/workflow/article-workflow/*`、`report/*`、`fanout/*` | 文章、报告和批量内容生成 |
| 管理后台 | `/api/admin/*` | 用户、内容、计费、分析、渠道和管理员权限 |
| Billing 内部服务 | `/reserve`、`/resource/*`、`/internal/admin/*` 等 | 主 API 到 Billing 的内部计费调用 |

Swagger UI 中可以按分组折叠、关键词过滤，也会展示路径参数、常用查询参数、典型请求体、认证要求和响应类型。没有集中建模的复杂工作流请求体会标记为自由对象，避免文档 schema 改变现有运行时校验行为。

## 快速调用

先登录取得用户 JWT：

```bash
curl -sS http://localhost:8090/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"identifier":"你的用户名或UID","password":"你的密码"}'
```

携带 JWT 调用用户接口：

```bash
curl -sS http://localhost:8090/api/billing/balance \
  -H 'Authorization: Bearer <USER_JWT>'
```

导出 OpenAPI 文件供 Postman、Apifox、YApi 或代码生成工具导入：

```bash
curl -sS http://localhost:8090/openapi.json -o openapi.json
```

## 配置与生产安全

相关环境变量：

```dotenv
API_DOCS_ENABLED=true
API_DOCS_BASE_URL=http://localhost:8090
BILLING_DOCS_BASE_URL=http://localhost:8093
```

- `API_DOCS_ENABLED=false` 会完全关闭 Swagger/OpenAPI 路由。
- 容器或反向代理部署时，用 `API_DOCS_BASE_URL`、`BILLING_DOCS_BASE_URL` 填写浏览器可访问的外部地址。
- 生产环境建议关闭文档，或在网关层为 `/docs`、`/openapi.*` 增加访问控制。
- 不要在共享 Swagger 页面填写生产 JWT 或 `BILLING_INTERNAL_TOKEN`；Swagger UI 会在浏览器中保留授权信息。
