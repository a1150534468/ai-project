# Kubernetes 部署

部署 runbook 已迁移至 [docs/setup/deploy-k8s.md](../../docs/setup/deploy-k8s.md)（含数据层开通、集群前置、发版契约、上线 checklist、Key 轮换与本地 kind overlay）。

此目录为 Kustomize 清单：`base/` 生产基线，`overlays/local` 本地 kind，`overlays/prod` 生产覆盖；`create-secrets.sh` + `secrets.env.example` 用于生成业务 Secret。
