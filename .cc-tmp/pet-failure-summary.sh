#!/bin/sh
# Read-only: summarize deterministic errors per failed attempt for one project.
P="workflow/codex-pets/cmrg7sx3w0002c3lsyza7tqci/cms4ont3b000mc3ykbcy3rqor/cpr_13c964c03d2965b49b5e33cc1c9a9c1b"
mc alias set local http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1
mc find "local/yunclaude/$P" --name "*失败诊断*" 2>/dev/null | while read -r key; do
  echo "##### $(basename "$key")"
  mc cat "$key" 2>/dev/null
  echo
done
