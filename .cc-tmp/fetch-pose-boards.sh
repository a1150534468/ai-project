#!/bin/sh
# Read-only: copy every pose_board PNG for the 老鼠猫 run out of MinIO so the
# new extractor can be re-run against the exact bytes that were already paid for.
P="workflow/codex-pets/cmrg7sx3w0002c3lsyza7tqci/cms4ont3b000mc3ykbcy3rqor/cpr_13c964c03d2965b49b5e33cc1c9a9c1b"
mc alias set local http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1
mkdir -p /tmp/pose-boards
mc find "local/yunclaude/$P" --name "*姿势板*" 2>/dev/null | while read -r key; do
  base=$(basename "$key")
  case "$base" in
    *running-right*) state=running-right ;;
    *idle*) state=idle ;;
    *) state=other ;;
  esac
  rest=${base##*第 }
  attempt=${rest%% 次*}
  mc cp --quiet "$key" "/tmp/pose-boards/${state}-${attempt}.png" >/dev/null 2>&1
  echo "${state}-${attempt}.png"
done
