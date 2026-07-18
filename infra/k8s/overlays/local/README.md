# 本地 Kubernetes 启动

此 overlay 保留生产 `base` 的 Deployment、Service、Ingress 和 migrate Job，
使用 kind 承载应用层，使用仓库根目录的 Docker Compose 承载 PostgreSQL、Redis 和 MinIO。

本地入口：

- Web: `http://app.localhost:8080`
- Admin: `http://admin.localhost:8080`
- API: `http://api.localhost:8080`

关键差异：

- 本地镜像统一使用 `:local` 标签并预载入 kind。
- Pod 通过 `host.docker.internal` 访问 Compose 数据层。
- Ingress 使用 HTTP 和 `*.localhost` 域名，宿主端口为 `8080`。
- API、Web、Admin 和 billing 均为单副本，不启用 HPA。
- billing 使用 `BILLING_PRICING_MODE=learning`，每个 operation 只扣 1 点。
- Codex 桌宠 Worker 随 base 一起运行；本地 HTTP ingress 只能验证工作流和签名路由，真实 Codex 安装仍需外网可达的 HTTPS `CODEX_PET_PUBLIC_BASE_URL`。

重新应用配置：

```bash
kubectl config use-context kind-ai-assistant
kubectl apply -k infra/k8s/overlays/local
```

重新构建并加载某个镜像后，需要重启对应 Deployment：

```bash
docker build -f infra/docker/api/Dockerfile -t ai-assistant-api:local .
kind load docker-image --name ai-assistant ai-assistant-api:local
kubectl rollout restart deployment/api deployment/local-business-promo-worker deployment/novel-worker deployment/codex-pet-worker -n ai-assistant
```

查看状态：

```bash
kubectl get pods -n ai-assistant
kubectl get ingress -n ai-assistant
```
