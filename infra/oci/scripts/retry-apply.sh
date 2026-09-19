#!/usr/bin/env bash
# Retry `terraform apply -auto-approve` while OCI reports "Out of host capacity"
# for A1. Only use after the plan has been reviewed.
#   retry-apply.sh [max_attempts] [terraform apply args]
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
tf_dir="$here/../main"
max=${1:-20}
shift || true

delay=60
for attempt in $(seq 1 "$max"); do
  log=$(mktemp)
  if terraform -chdir="$tf_dir" apply -auto-approve "$@" 2>&1 | tee "$log"; then
    rm -f "$log"
    exit 0
  fi
  if ! grep -q "Out of host capacity" "$log"; then
    echo "apply failed for a reason other than capacity; see above" >&2
    exit 1
  fi
  rm -f "$log"
  echo "attempt $attempt/$max: out of A1 capacity, retrying in ${delay}s" >&2
  sleep "$delay"
  delay=$((delay * 2 > 900 ? 900 : delay * 2))
done
echo "gave up after $max attempts" >&2
exit 1
