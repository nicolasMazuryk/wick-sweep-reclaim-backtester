#!/usr/bin/env bash
# Mirror the small research outputs under runs/ (MEMO.md, report.md, JSON) to
# the results bucket. Parquet, per-cell and log files stay on the data volume.
# Installed as /usr/local/bin/wsr-sync-results; cron runs it hourly as ubuntu.
# Extra arguments pass through to `oci os object sync` (e.g. --dry-run).
set -euo pipefail

# shellcheck source=/dev/null
. /etc/wsr/wsr.env
src="${WSR_MOUNT:-/mnt/wsr}/runs"
[ -d "$src" ] || { echo "no $src; nothing to sync"; exit 0; }

exec 9>/tmp/wsr-sync-results.lock
flock -n 9 || { echo "another sync is running"; exit 0; }

echo "[$(date -u +%FT%TZ)] sync $src -> $WSR_NAMESPACE/$WSR_RESULTS_BUCKET/runs/"
oci os object sync \
  --auth "${OCI_CLI_AUTH:-instance_principal}" \
  --region "$WSR_REGION" \
  --namespace "$WSR_NAMESPACE" \
  --bucket-name "$WSR_RESULTS_BUCKET" \
  --src-dir "$src" \
  --prefix runs/ \
  --exclude '*.parquet' \
  --exclude 'cells/*' --exclude '*/cells/*' \
  --exclude 'logs/*' --exclude '*/logs/*' \
  "$@"
