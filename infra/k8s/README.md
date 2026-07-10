# aiproject Kubernetes 部署 runbook

此文档是从原项目迁移后的部署模板。所有域名、镜像仓库、证书名、
Kubernetes context、数据库与对象存储地址都需要按你的新环境重填。

## 一、数据层开通（新 HA RDS + 复用 DCS Redis）

### RDS PostgreSQL（新建，HA）
1. 同 VPC `subnet-data`，**仅内网 + 白名单**，HA 跨 AZ，**PG 15/16**（现有 PG12 不带新 pgvector）。
2. 控制台**扩展白名单启用 `pgvector`**（否则迁移 `CREATE EXTENSION vector` 被拒）。
3. 建两个 database：`yunclaude`（主，pgvector）、`yunclaude_billing`（billing）。
4. 迁移账号需有建扩展权限。记录内网 host:port。
5. 填入 `DATABASE_URL`（→yunclaude）与 `BILLING_DATABASE_URL`（→yunclaude_billing）。

### Redis
- `REDIS_URL=redis://:<redis-password>@<redis-host>:6379/1`（建议独立 db index）。
- connector key/频道已带 `yunclaude:` 前缀；如与其他服务共享 Redis，部署前确认前缀隔离。

## 二、集群前置（部署前一次性）

```bash
# 1) namespace
kubectl apply -f base/00-namespace.yaml
# 2) 镜像拉取凭据（按你的私有镜像仓库替换）
kubectl create secret docker-registry image-pull-secret-placeholder -n yunclaude \
  --docker-server=<registry.example.com> \
  --docker-username=<registry-user> --docker-password='<registry-password>'
# 3) 通配证书 Secret（按你的域名签发并写入 app-tls）
kubectl create secret tls app-tls -n yunclaude \
  --cert=<fullchain.pem> --key=<privkey.pem>
# 4) 业务 Secret
cp secrets.env.example secrets.env && vi secrets.env   # 填真实值（LLM_API_KEY 用新轮换值）
./create-secrets.sh
```

## 三、发版

```bash
REGISTRY_PASSWORD='<registry-password>' ../../scripts/release.sh 1.0.0
```

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
      `kubectl run nettest -n yunclaude --image=curlimages/curl --rm -it --restart=Never -- curl -s -o /dev/null -w '%{http_code}\n' https://llm-gateway.example.com/v1/models`
      预期返回上游认证错误或模型列表，代表网络可达。
- [ ] LLM 网关已放行集群 NAT 出口 IP。
- [ ] RDS 已启用 pgvector 扩展白名单；migrate Job `complete`。
- [ ] `app-tls` 在 yunclaude ns 可用。
- [ ] 从无代理外网验证：
      `curl -s https://api.example.com/health` → `{"ok":true}`
- [ ] 部署后立即给 API Server 6443 加运维 IP 白名单（集群级残留风险）。

## LLM_API_KEY 轮换流程

1. NewAPI 后台生成新 key
2. 编辑 secrets.env 设 LLM_API_KEY=<新key>
3. `KUBE_CONTEXT=<your-context> ./create-secrets.sh`（更新 yc-api-secrets）
4. kubectl rollout restart deploy/api -n yunclaude
5. kubectl rollout status deploy/api -n yunclaude 等全副本 ready
6. NewAPI 后台吊销旧 key
