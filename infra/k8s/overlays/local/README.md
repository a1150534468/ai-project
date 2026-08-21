# 本地 Kubernetes overlay

kind 联调用的 overlay。上层说明见 [infra/k8s/README.md](../../README.md)。

```bash
kubectl config use-context kind-ai-assistant
kubectl apply -k infra/k8s/overlays/local
```
