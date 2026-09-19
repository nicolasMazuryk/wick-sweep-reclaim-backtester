#!/usr/bin/env bash
# Provision the WSR research VM. Idempotent: cloud-init runs it on first boot
# (as /usr/local/sbin/wsr-bootstrap); re-run it over ssh after edits:
#   scp infra/oci/scripts/{bootstrap-vm,sync-results}.sh ubuntu@<ip>:
#   ssh ubuntu@<ip> sudo bash bootstrap-vm.sh
# Settings come from /etc/wsr/wsr.env, written by cloud-init.
set -euo pipefail

[ "$(id -u)" -eq 0 ] || exec sudo bash "$0" "$@"

# shellcheck source=/dev/null
. /etc/wsr/wsr.env
: "${WSR_MOUNT:=/mnt/wsr}"
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
USER_NAME=ubuntu
HOME_DIR=/home/$USER_NAME
REPO_DIR=$HOME_DIR/wick-sweep-reclaim
export DEBIAN_FRONTEND=noninteractive

log() { echo "[wsr-bootstrap $(date -u +%FT%TZ)] $*"; }
as_user() { sudo -u "$USER_NAME" -H bash -lc "$1"; }

# --- 1. data volume, mount, swap -------------------------------------------
log "waiting for data volume $WSR_DATA_DEVICE"
for _ in $(seq 1 120); do
  [ -e "$WSR_DATA_DEVICE" ] && break
  sleep 5
done
[ -e "$WSR_DATA_DEVICE" ] || { log "data volume not attached after 10 min"; exit 1; }
dev=$(readlink -f "$WSR_DATA_DEVICE")

# Format only a blank device: blkid exits 2 when it finds no filesystem.
if blkid -p "$dev" >/dev/null 2>&1; then
  log "$dev already has a filesystem"
else
  log "formatting $dev (ext4)"
  mkfs.ext4 -q -L wsr-data -m 1 "$dev"
fi

uuid=$(blkid -s UUID -o value "$dev")
mkdir -p "$WSR_MOUNT"
if ! grep -q "UUID=$uuid" /etc/fstab; then
  sed -i "\|[[:space:]]$WSR_MOUNT[[:space:]]|d" /etc/fstab
  echo "UUID=$uuid $WSR_MOUNT ext4 defaults,_netdev,nofail 0 2" >>/etc/fstab
  systemctl daemon-reload
fi
mountpoint -q "$WSR_MOUNT" || mount "$WSR_MOUNT"

install -d -o "$USER_NAME" -g "$USER_NAME" "$WSR_MOUNT"/{data,runs,cache,logs}

swapfile=$WSR_MOUNT/swapfile
if [ ! -f "$swapfile" ]; then
  log "creating 16G swapfile"
  fallocate -l 16G "$swapfile"
  chmod 600 "$swapfile"
  mkswap "$swapfile" >/dev/null
fi
grep -q "^$swapfile " /etc/fstab || echo "$swapfile none swap sw,nofail 0 0" >>/etc/fstab
swapon --show=NAME --noheadings | grep -qx "$swapfile" || swapon "$swapfile"

# --- 2. packages, Node 22, pnpm 10, OCI CLI, Claude Code --------------------
log "installing packages"
apt-get update -q
apt-get install -y -q build-essential git tmux htop jq zip unzip zstd curl ca-certificates \
  python3-pip python3-venv chrony unattended-upgrades

if ! node -v 2>/dev/null | grep -q '^v22\.'; then
  log "installing Node 22 (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -q nodejs
fi

if ! as_user 'pnpm -v 2>/dev/null' | grep -q '^10\.'; then
  log "installing pnpm 10"
  corepack enable
  as_user 'COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack prepare pnpm@10 --activate' \
    || { corepack disable pnpm; npm install -g pnpm@10; }
fi

if [ ! -x /opt/oci-cli/bin/oci ]; then
  log "installing OCI CLI"
  python3 -m venv /opt/oci-cli
  /opt/oci-cli/bin/pip install -q --upgrade pip oci-cli
fi
ln -sf /opt/oci-cli/bin/oci /usr/local/bin/oci

if [ ! -x "$HOME_DIR/.local/bin/claude" ]; then
  log "installing Claude Code"
  as_user 'curl -fsSL https://claude.ai/install.sh | bash'
fi

# --- 3. GitHub deploy key ----------------------------------------------------
as_user '
  install -d -m 700 ~/.ssh
  [ -f ~/.ssh/wsr_deploy ] || ssh-keygen -q -t ed25519 -N "" -C "wsr-research-vm" -f ~/.ssh/wsr_deploy
  grep -q "^Host github.com" ~/.ssh/config 2>/dev/null || printf "Host github.com\n  IdentityFile ~/.ssh/wsr_deploy\n  IdentitiesOnly yes\n" >>~/.ssh/config
  chmod 600 ~/.ssh/config
  grep -q "^github.com " ~/.ssh/known_hosts 2>/dev/null || ssh-keyscan -t ed25519 github.com >>~/.ssh/known_hosts 2>/dev/null
  git config --global user.name  >/dev/null || git config --global user.name  "wsr-research-vm"
  git config --global user.email >/dev/null || git config --global user.email "wsr-research-vm@users.noreply.github.com"
'

# Repo already cloned (step 5 of the README): point data/ and runs/ at the volume.
if [ -d "$REPO_DIR/.git" ]; then
  for d in data runs; do
    [ -e "$REPO_DIR/$d" ] || as_user "ln -s $WSR_MOUNT/$d $REPO_DIR/$d"
  done
fi

# --- 4. results sync cron, unattended upgrades, time sync --------------------
[ "$0" -ef /usr/local/sbin/wsr-bootstrap ] || install -m 755 "$0" /usr/local/sbin/wsr-bootstrap
[ -f "$SCRIPT_DIR/sync-results.sh" ] && install -m 755 "$SCRIPT_DIR/sync-results.sh" /usr/local/bin/wsr-sync-results
cat >/etc/cron.d/wsr-sync-results <<EOF
# runs/ -> ${WSR_RESULTS_BUCKET} (memos, reports, JSON), instance principal auth
17 * * * * $USER_NAME /usr/local/bin/wsr-sync-results >>$WSR_MOUNT/logs/sync-results.log 2>&1
EOF

# Ubuntu's 50unattended-upgrades already limits origins to -security; never reboot.
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
cat >/etc/apt/apt.conf.d/52wsr-unattended <<'EOF'
Unattended-Upgrade::Automatic-Reboot "false";
EOF

systemctl enable --now chrony

# --- 5. environment and motd -------------------------------------------------
cat >/etc/profile.d/wsr.sh <<EOF
export WSR_DATA_ROOT=$WSR_MOUNT/data
export NODE_OPTIONS=--max-old-space-size=4096
case ":\$PATH:" in *":\$HOME/.local/bin:"*) ;; *) export PATH="\$HOME/.local/bin:\$PATH" ;; esac
EOF

cat >/etc/motd <<EOF

  WSR research VM  —  data volume: $WSR_MOUNT (data/ runs/ cache/ logs/)

  First-time setup:
    1. Add ~/.ssh/wsr_deploy.pub as a GitHub deploy key (write access), then
         git clone $WSR_REPO_SSH_URL ~/wick-sweep-reclaim
         sudo /usr/local/sbin/wsr-bootstrap     # links data/ and runs/ to the volume
         cd ~/wick-sweep-reclaim && pnpm install --frozen-lockfile && pnpm build
    2. claude            # log in, then run the agent inside tmux:  tmux new -As wsr

  Results sync hourly to bucket ${WSR_RESULTS_BUCKET} (log: $WSR_MOUNT/logs/sync-results.log).

EOF

log "done"
