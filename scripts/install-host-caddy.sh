#!/usr/bin/env bash
set -euo pipefail

main_config="${CADDY_MAIN_CONFIG:-/etc/caddy/Caddyfile}"
deploy_root="${DEPLOY_ROOT:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)}"
fragment_source="${CADDY_FRAGMENT_SOURCE:-$deploy_root/infra/caddy/ai-assistant.caddy}"
fragment_target="${CADDY_FRAGMENT_TARGET:-/etc/caddy/ai-assistant.caddy}"
import_line="import ${fragment_target}"

if [ ! -f "$main_config" ]; then
	printf 'missing Caddy config: %s\n' "$main_config" >&2
	exit 2
fi
if [ ! -f "$fragment_source" ]; then
	printf 'missing Caddy fragment: %s\n' "$fragment_source" >&2
	exit 2
fi

backup_dir="/root/ai-assistant-caddy-backup-$(date +%Y%m%d-%H%M%S)"
sudo install -d -m 700 "$backup_dir"
sudo cp -a "$main_config" "$backup_dir/Caddyfile"

sudo install -o root -g root -m 0644 "$fragment_source" "$fragment_target"
if ! sudo grep -Fqx "$import_line" "$main_config"; then
	sudo sh -c "printf '\\n%s\\n' '$import_line' >> '$main_config'"
fi

if ! sudo caddy validate --config "$main_config"; then
	sudo cp -a "$backup_dir/Caddyfile" "$main_config"
	exit 1
fi

if ! sudo systemctl reload caddy; then
	sudo cp -a "$backup_dir/Caddyfile" "$main_config"
	sudo systemctl reload caddy || true
	exit 1
fi
printf 'host Caddy updated; backup=%s\n' "$backup_dir"
