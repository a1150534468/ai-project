# 本地 Kubernetes overlay

使用说明已并入 [docs/setup/deploy-k8s.md](../../../../docs/setup/deploy-k8s.md) 的「本地 overlay（kind 联调）」一节。

```bash
kubectl config use-context kind-ai-assistant
kubectl apply -k infra/k8s/overlays/local
```
