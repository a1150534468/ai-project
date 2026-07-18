# aiproject Kubernetes 部署 runbook

此文档是从原项目迁移后的部署模板。所有域名、镜像仓库、证书名、
Kubernetes context、数据库与对象存储地址都需要按你的新环境重填。

## 一、数据层开通（新 HA RDS + 复用 DCS Redis）

### RDS PostgreSQL（新建，HA）
1. 同 VPC `subnet-data`，**仅内网 + 白名单**，HA 跨 AZ，**PG 15/16**（现有 PG12 不带新 pgvector）。
2. 控制台**扩展白名单启用 `pgvector`**（否则迁移 `CREATE EXTENSION vector` 被拒）。
3. 建两个 database：`ai-assistant`（主，pgvector）、`ai-assistant_billing`（billing）。
4. 迁移账号需有建扩展权限。记录内网 host:port。
5. 填入 `DATABASE_URL`（→ai-assistant）与 `BILLING_DATABASE_URL`（→ai-assistant_billing）。

### Redis
- `REDIS_URL=redis://:<redis-password>@<redis-host>:6379/1`（建议独立 db index）。
- connector key/频道已带 `ai-assistant:` 前缀；如与其他服务共享 Redis，部署前确认前缀隔离。

## 二、集群前置（部署前一次性）

```bash
# 1) namespace
kubectl apply -f base/00-namespace.yaml
# 2) 镜像拉取凭据（按你的私有镜像仓库替换）
kubectl create secret docker-registry image-pull-secret-placeholder -n ai-assistant \
  --docker-server=<registry.example.com> \
  --docker-username=<registry-user> --docker-password='<registry-password>'
# 3) 通配证书 Secret（按你的域名签发并写入 app-tls）
kubectl create secret tls app-tls -n ai-assistant \
  --cert=<fullchain.pem> --key=<privkey.pem>
# 4) 业务 Secret
cp secrets.env.example secrets.env && vi secrets.env   # 填百炼业务空间 ID 与 BAILIAN_API_KEY
KUBE_CONTEXT=<your-context> ./create-secrets.sh
```

## 三、发版

`scripts/release.sh` 是运维环境持有、不会提交到仓库的编排脚本。它必须遵守以下契约：先构建并推送同一版本的镜像，删除固定名 `migrate` Job，单独应用迁移并等待 Complete，然后才滚动 API、各 Worker 和前端。不能用一次裸 `kubectl apply -k` 代替迁移门禁。

```bash
REGISTRY_PASSWORD='<registry-password>' ../../scripts/release.sh 1.0.0
```

回滚到不含 Codex 桌宠的旧 API 镜像前，先隐藏 `workflow.codex-pet`、停止新运行、等待或取消存量运行，并 scale/delete `deployment/codex-pet-worker`；普通 apply 不会自动删除新增 Deployment。

## 四、入口接线（云厂商控制台，一次性）

- DNS：`app.example.com`、`admin.example.com`、`api.example.com` A/CNAME 记录 → 你的入口地址。
- 负载均衡：443 监听器转 ingress-nginx NodePort 或 LoadBalancer Service，按 Host 路由。

## 前置依赖检查

- [ ] 集群已部署 ingress-nginx 控制器
- [ ] 负载均衡 443 监听器已指向 ingress-nginx
- [ ] DNS 已配 `app.example.com` / `admin.example.com` / `api.example.com`
- [ ] secrets.env 已 `chmod 600`

## 五、上线前硬阻塞 checklist

- [ ] VPC 内 debug pod 走 NAT 测连通：
      `kubectl run nettest -n ai-assistant --image=curlimages/curl --rm -it --restart=Never -- curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<WorkspaceId>.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages`
      未带认证时预期返回 `401`/`403`，代表 Anthropic Messages 端点网络可达；真实功能由仓库 POC 验证。
- [ ] 百炼 API Key 属于目标业务空间，且该空间已授权对话模型。
- [ ] 百炼 `text-embedding-v4` 实际调用返回 1024 维；迁移会清除旧派生向量并把原始知识库文档重新排队索引。
- [ ] RDS 已启用 pgvector 扩展白名单；migrate Job `complete`。
- [ ] `app-tls` 在 ai-assistant ns 可用。
- [ ] 从无代理外网验证：
      `curl -s https://api.example.com/health` → `{"ok":true}`
- [ ] 部署后立即给 API Server 6443 加运维 IP 白名单（集群级残留风险）。

## BAILIAN_API_KEY 轮换流程

1. 百炼目标业务空间的 API Key 页面创建新 Key
2. 编辑 secrets.env 设 BAILIAN_API_KEY=<新key>
3. `KUBE_CONTEXT=<your-context> ./create-secrets.sh`（更新 ai-assistant-api-secrets）
4. `kubectl rollout restart deploy/api deploy/local-business-promo-worker deploy/novel-worker deploy/codex-pet-worker -n ai-assistant`
5. 依次确认上述 Deployment 全部 rollout 完成且 Codex 桌宠 Worker `/health` 返回 200
6. 百炼控制台吊销旧 Key
