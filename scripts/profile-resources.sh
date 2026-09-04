#!/usr/bin/env bash
set -euo pipefail

project_name="${COMPOSE_PROJECT_NAME:-ai-assistant}"
duration_seconds="${PROFILE_DURATION_SECONDS:-7200}"
interval_seconds="${PROFILE_INTERVAL_SECONDS:-5}"
scenario="${PROFILE_SCENARIO:-unspecified}"
output_path="${1:-/tmp/ai-assistant-resource-$(date +%Y%m%d-%H%M%S).tsv}"
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
deploy_root="${DEPLOY_ROOT:-$script_dir}"
compose_file="${COMPOSE_FILE:-$deploy_root/docker-compose.prod.yml}"
env_file="${ENV_FILE:-$deploy_root/.env.production}"

case "$duration_seconds:$interval_seconds" in
  *[!0-9:]*|:*|*:) echo "PROFILE_DURATION_SECONDS and PROFILE_INTERVAL_SECONDS must be positive integers" >&2; exit 2 ;;
esac
if [ "$duration_seconds" -le 0 ] || [ "$interval_seconds" -le 0 ]; then
  echo "profile durations must be greater than zero" >&2
  exit 2
fi
if [ ! -f "$compose_file" ] || [ ! -f "$env_file" ]; then
  echo "missing compose or environment file: $compose_file / $env_file" >&2
  exit 2
fi

compose=(docker compose -p "$project_name" --env-file "$env_file" -f "$compose_file")

printf 'timestamp\ttype\tname\tcpu\tmemory_usage\tmemory_percent\tnet_io\tblock_io\tpids\textra\n' > "$output_path"
started_at=$(date +%s)
deadline=$((started_at + duration_seconds))

echo "profiling compose project '$project_name' scenario '$scenario' for ${duration_seconds}s -> $output_path"
while [ "$(date +%s)" -lt "$deadline" ]; do
  timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  container_ids=$(docker ps --filter "label=com.docker.compose.project=$project_name" --format '{{.ID}}')
  if [ -n "$container_ids" ]; then
    # shellcheck disable=SC2086
    docker stats --no-stream --format "${timestamp}\tcontainer\t{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.NetIO}}\t{{.BlockIO}}\t{{.PIDs}}\tscenario=${scenario}" $container_ids >> "$output_path"
  fi
  for service in api worker; do
    container_id=$("${compose[@]}" ps -q "$service" 2>/dev/null || true)
    if [ -n "$container_id" ]; then
      port=8090
      path=/health/resources
      if [ "$service" = "worker" ]; then port=8091; path=/health; fi
      resource_json=$(docker exec "$container_id" node -e "fetch('http://127.0.0.1:${port}${path}').then(r=>r.text()).then(v=>process.stdout.write(v)).catch(()=>process.exit(1))" 2>/dev/null || true)
      if [ -n "$resource_json" ]; then
        printf '%s\tnode\t%s\t-\t-\t-\t-\t-\t-\tscenario=%s %s\n' "$timestamp" "$service" "$scenario" "$resource_json" >> "$output_path"
      fi
    fi
  done
  if [ -r /proc/meminfo ]; then
    mem_available=$(awk '/^MemAvailable:/ { print $2 "kB" }' /proc/meminfo)
    swap_used=$(awk '/^SwapTotal:/ { total=$2 } /^SwapFree:/ { free=$2 } END { print total-free "kB" }' /proc/meminfo)
    load_average=$(cut -d' ' -f1-3 /proc/loadavg)
    printf '%s\tsystem\thost\t%s\t%s\t-\t-\t-\t-\tload=%s\n' "$timestamp" "$load_average" "$mem_available/$swap_used" "$load_average" >> "$output_path"
  fi
  sleep "$interval_seconds"
done

for service in postgres redis api worker gateway; do
  container_id=$("${compose[@]}" ps -q "$service" 2>/dev/null || true)
  if [ -n "$container_id" ]; then
    docker inspect --format '{{.Name}} oom_killed={{.State.OOMKilled}} restart_count={{.RestartCount}} status={{.State.Status}}' "$container_id" || true
  fi
done

echo "resource profile complete: $output_path"
