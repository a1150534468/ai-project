# legacy（保留但不在部署链路上）

这个目录放**仍然有参考价值、但已经不在任何自动化链路上**的配置。改动它们不会触发任何构建、
测试或发布，也因此不会有人替你验证——真要启用，先把它搬回自己的位置并补上校验。

- `k8s/` —— Kustomize 清单。生产部署走 Docker Compose（`docs/deploy-compose.md` + `scripts/remote-deploy.sh`），这套清单没有被任何 workflow 引用。
