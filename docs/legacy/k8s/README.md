# Kubernetes 部署（保留配置，**不在部署链路上**）

2026-10-20 从 `infra/k8s` 搬到 `docs/legacy/k8s`：它放在 `infra/` 下会让人（和 AI）以为改这里的
清单就能改生产，**实际生产走 Docker Compose**，见 [docs/deploy-compose.md](../../deploy-compose.md)。

此目录为 Kustomize 清单：`base/` 生产基线，`overlays/local` 本地 kind，`overlays/prod` 生产覆盖；`create-secrets.sh` + `secrets.env.example` 用于生成业务 Secret。校验用 `pnpm k8s:validate`（脚本里的路径已同步到新位置）。

> 早前这里指向的 `docs/setup/deploy-k8s.md`（数据层开通、发版契约、上线 checklist、Key 轮换）从未入库，已不存在；上线动作请以 compose 文档为准，需要 K8s runbook 时按本目录清单重写。
