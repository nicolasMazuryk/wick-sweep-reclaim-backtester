#!/usr/bin/env bash
# Resize the research VM in place for the heavy phases (4–5) and back.
#   burst.sh up   [terraform apply args]   -> 16 OCPU / 64 GB (15 workers)
#   burst.sh down [terraform apply args]   ->  4 OCPU / 24 GB (Always Free)
# The resize reboots the VM; the data volume and environment are kept, and
# `wsr grid --run-id` resumes an interrupted grid. While burst is active,
# run every apply through this script: a plain `terraform apply` sizes down.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
tf_dir="$here/../main"

case "${1:-}" in
  up) ocpus=${BURST_OCPUS:-16} mem=${BURST_MEMORY_GBS:-64} ;;
  down) ocpus=${BASE_OCPUS:-4} mem=${BASE_MEMORY_GBS:-24} ;;
  *) echo "usage: $0 up|down [terraform apply args]" >&2; exit 2 ;;
esac
shift

terraform -chdir="$tf_dir" apply -var "ocpus=$ocpus" -var "memory_gbs=$mem" "$@"

read -r -a ssh_cmd <<<"$(terraform -chdir="$tf_dir" output -raw ssh)"
ssh_cmd+=(-o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new -o BatchMode=yes)

echo "waiting for ssh…"
for _ in $(seq 1 60); do
  "${ssh_cmd[@]}" true 2>/dev/null && break
  sleep 10
done

"${ssh_cmd[@]}" "echo \"nproc: \$(nproc) (expected $ocpus)\"; free -g | head -2; df -h /mnt/wsr; ls /mnt/wsr"
