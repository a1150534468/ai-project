#!/usr/bin/env bash
set -euo pipefail

new_tag="${1:?usage: remote-deploy.sh IMAGE_TAG}"
deploy_root="${DEPLOY_ROOT:?DEPLOY_ROOT is required}"
env_file="${ENV_FILE:-$deploy_root/.env.production}"
compose_file="$deploy_root/docker-compose.prod.yml"
tag_file="$deploy_root/.deployed-image-tag"
project_name="${COMPOSE_PROJECT_NAME:-ai-assistant}"

if [ ! -f "$env_file" ]; then
  echo "missing production environment file: $env_file" >&2
  exit 2
fi
if [ ! -f "$compose_file" ]; then
  echo "missing production compose file: $compose_file" >&2
  exit 2
fi

previous_tag=""
if [ -f "$tag_file" ]; then previous_tag=$(tr -d '[:space:]' < "$tag_file"); fi

export IMAGE_TAG="$new_tag"
export ENV_FILE="$env_file"
compose=(docker compose -p "$project_name" --env-file "$env_file" -f "$compose_file")

wait_for_services() {
  local deadline=$((SECONDS + 240))
  local services=(postgres billing-postgres redis billing api worker gateway)
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

rollback() {
  if [ -z "$previous_tag" ]; then
    echo "deployment failed and no previous image tag is recorded" >&2
    return 1
  fi
  echo "rolling back to $previous_tag" >&2
  export IMAGE_TAG="$previous_tag"
  "${compose[@]}" up -d --remove-orphans
  wait_for_services
}

echo "pulling image tag $new_tag"
"${compose[@]}" --profile tools pull
"${compose[@]}" --profile tools run --rm migrate
"${compose[@]}" --profile tools run --rm billing-migrate
"${compose[@]}" up -d --remove-orphans

if ! wait_for_services; then
  "${compose[@]}" ps >&2 || true
  rollback
  exit 1
fi

printf '%s\n' "$new_tag" > "$tag_file"
"${compose[@]}" ps
echo "deployment healthy: $new_tag"
