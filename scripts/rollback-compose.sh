#!/usr/bin/env bash
set -euo pipefail

target_tag="${1:?usage: rollback-compose.sh IMAGE_TAG}"
deploy_root="${DEPLOY_ROOT:?DEPLOY_ROOT is required}"
env_file="${ENV_FILE:-$deploy_root/.env.production}"
compose_file="$deploy_root/docker-compose.prod.yml"
project_name="${COMPOSE_PROJECT_NAME:-ai-assistant}"
export IMAGE_TAG="$target_tag"
export ENV_FILE="$env_file"

if [ ! -f "$env_file" ] || [ ! -f "$compose_file" ]; then
  echo "missing production environment or compose file under $deploy_root" >&2
  exit 2
fi

compose=(docker compose -p "$project_name" --env-file "$env_file" -f "$compose_file")
services=(postgres redis api worker gateway)

wait_for_services() {
  local deadline=$((SECONDS + 240))
  while [ "$SECONDS" -lt "$deadline" ]; do
    local all_healthy=1
    for service in "${services[@]}"; do
      local container_id status
      container_id=$("${compose[@]}" ps -q "$service")
      if [ -z "$container_id" ]; then all_healthy=0; continue; fi
      status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id")
      if [ "$status" != "healthy" ] && [ "$status" != "running" ]; then all_healthy=0; fi
    done
    if [ "$all_healthy" -eq 1 ]; then return 0; fi
    sleep 5
  done
  return 1
}

"${compose[@]}" pull
"${compose[@]}" up -d --remove-orphans
if ! wait_for_services; then
  "${compose[@]}" ps >&2 || true
  echo "rollback health check failed for image tag $target_tag" >&2
  exit 1
fi
printf '%s\n' "$target_tag" > "$deploy_root/.deployed-image-tag"
"${compose[@]}" ps
