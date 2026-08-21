# Kubernetes 部署

此目录为 Kustomize 清单：`base/` 生产基线，`overlays/local` 本地 kind，`overlays/prod` 生产覆盖；`create-secrets.sh` + `secrets.env.example` 用于生成业务 Secret。校验用 `pnpm k8s:validate`。

**当前生产部署走 Docker Compose**，步骤与验收标准见 [docs/deploy-compose.md](../../docs/deploy-compose.md)。这套 K8s 清单是保留配置，不是主路径。

> 早前这里指向的 `docs/setup/deploy-k8s.md`（数据层开通、发版契约、上线 checklist、Key 轮换）从未入库，已不存在；上线动作请以 compose 文档为准，需要 K8s runbook 时按本目录清单重写。
