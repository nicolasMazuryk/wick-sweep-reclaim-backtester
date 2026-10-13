# OCI infrastructure for WSR research

One long-lived ARM VM in `uk-london-1` on which a Claude Code agent runs
`prompts/research-plan.md` against the `wsr` CLI, inside tmux.

| Resource | Spec | Cost |
|---|---|---|
| Compartment `wsr-research` | holds everything below | free |
| VCN `10.20.0.0/16`, public subnet `10.20.1.0/24`, IGW | default security list emptied; NSG allows 22/tcp from `ssh_allowed_cidrs` only, all egress | free |
| VM `wsr-research` | `VM.Standard.A1.Flex` 4 OCPU / 24 GB, Ubuntu 24.04 aarch64, 50 GB boot | Always Free |
| Burst | in-place resize to 16 OCPU / 64 GB for Phases 4–5 | ≈ $0.18/h |
| Block volume `wsr-data` | 170 GB Balanced (10 VPU), paravirtualized, ext4 at `/mnt/wsr`; `prevent_destroy` | ≈ $0.5/mo (with the 50 GB boot volume, 20 GB over the 200 GB free tier) |
| Bucket `wsr-tfstate` | versioned, private; state of `main/` | free |
| Bucket `wsr-results` | versioned, private; hourly sync of `runs/**` minus `*.parquet`, `cells/`, `logs/` | free |
| Dynamic group + policy | VM (instance principal) may manage objects in `wsr-results` only | free |
| Notifications topic + email | target of the alarms | free |
| Alarms | CPU idle (~2 h below 5 %), memory > 90 % for 15 min, no metrics for 15 min (not running) | free |
| Budget | $30/mo on the compartment; email at 50 % actual and 100 % forecast | free |

The idle alarm deviates from the 6 h in the plan: OCI caps `pending_duration`
at 1 h, so it fires after one hour whose max CPU stayed below 5 % plus one hour
pending.

## Layout

```
bootstrap/   local state: compartment + wsr-tfstate bucket (apply once)
main/        backend "oci" -> wsr-tfstate; everything else
scripts/
  bootstrap-vm.sh   VM provisioning (cloud-init runs it; idempotent, re-runnable)
  sync-results.sh   runs/ -> wsr-results (cron, hourly)
  burst.sh          up|down: resize 16/64 <-> 4/24 and check over ssh
  retry-apply.sh    apply loop with backoff while A1 is "Out of host capacity"
```

## Prerequisites

- Terraform ≥ 1.12 (native `oci` backend), OCI CLI configured (`~/.oci/config`, profile `DEFAULT`).
- An SSH key pair; the default is `~/.ssh/wsr_oci` (`ssh-keygen -t ed25519 -f ~/.ssh/wsr_oci`).
- **Free Trial accounts:** when the 30-day trial ends OCI stops/reclaims paid
  resources (the data volume, burst capacity) unless the account is upgraded to
  Pay-As-You-Go. Trial accounts also reclaim an A1 VM whose CPU p95 stays under
  20 % for 7 days. Upgrade before Phase 5 at the latest; Always Free usage
  remains $0 after upgrading.

## Apply

```sh
cd infra/oci/bootstrap
echo "tenancy_ocid = \"$(awk -F= '/^tenancy/{print $2}' ~/.oci/config)\"" > terraform.tfvars
terraform init && terraform apply

cd ../main
cp terraform.tfvars.example terraform.tfvars   # tenancy, ssh_allowed_cidrs (curl -4 -s https://ifconfig.me), alert_email
terraform init -backend-config="namespace=$(oci os ns get --query data --raw-output)"
terraform plan -out=main.tfplan && terraform apply main.tfplan
```

A freshly created compartment can answer `BucketNotFound` for a minute or two
after bootstrap; retry `init`/`plan`.

If the instance fails with `Out of host capacity`, set
`availability_domain_index = 1` (AD-2) and retry, or run
`scripts/retry-apply.sh` (backoff 60 s → 15 min, 20 attempts).

Then confirm the Notifications subscription from the email OCI sends.

## First login

```sh
$(terraform -chdir=infra/oci/main output -raw ssh)
cloud-init status --wait                 # log: /var/log/wsr-bootstrap.log
# from your machine: add the VM's key as a GitHub deploy key with write access
#   scp ubuntu@<ip>:.ssh/wsr_deploy.pub /tmp/ && gh repo deploy-key add /tmp/wsr_deploy.pub --allow-write --title wsr-research-vm
git clone git@github.com:nicolasMazuryk/wick-sweep-reclaim.git ~/wick-sweep-reclaim
sudo /usr/local/sbin/wsr-bootstrap       # links data/ and runs/ to /mnt/wsr
cd ~/wick-sweep-reclaim && pnpm install --frozen-lockfile && pnpm build
claude                                   # log in (or export ANTHROPIC_API_KEY)
tmux new -As wsr                         # run the agent here
```

The VM gets `WSR_DATA_ROOT=/mnt/wsr/data` and `NODE_OPTIONS=--max-old-space-size=4096`
from `/etc/profile.d/wsr.sh`, an 8 GB swapfile on the data volume, security-only
unattended upgrades (no auto-reboot) and chrony.

To re-apply provisioning changes (cloud-init edits do not recreate the VM):

```sh
scp infra/oci/scripts/{bootstrap-vm,sync-results}.sh ubuntu@<ip>:
ssh ubuntu@<ip> sudo bash bootstrap-vm.sh
```

## Burst for Phases 4–5

```sh
infra/oci/scripts/burst.sh up      # 16 OCPU / 64 GB -> pool of 15 workers; reboots the VM
# ... wsr grid ... (resume an interrupted grid with `wsr grid --run-id <id>`)
infra/oci/scripts/burst.sh down    # back to 4 OCPU / 24 GB (Always Free)
```

A resize takes ~2.5 min including the reboot. While burst is active, run applies through `burst.sh`; a plain
`terraform apply` resizes back to the tfvars values.

If A1 has no capacity for 16 OCPU, set `shape = "VM.Standard.E5.Flex"` and
`ocpus = 12` (`memory_gbs = 64`). This recreates only the instance (x86): the
data volume is re-attached as-is, and `bootstrap-vm.sh` reinstalls the tooling.
Rebuild `node_modules` after the switch. Not used by default.

## Results

`/usr/local/bin/wsr-sync-results` runs hourly at :17 as `ubuntu`
(log: `/mnt/wsr/logs/sync-results.log`). Run it by hand any time; extra
arguments go to `oci os object sync` (e.g. `--dry-run`).

```sh
oci os object list --bucket-name wsr-results --prefix runs/ --all
oci os object sync --bucket-name wsr-results --prefix runs/ --dest-dir ./runs-remote   # download
```

## Cost

- Base ≈ $0.5/mo (20 GB of billed block storage: 170 GB data + 50 GB boot, 200 GB free).
- Burst ≈ $0.18/h at 16 OCPU / 64 GB. The grid is ~4–5 h per survivor at 15
  workers (ASSUMPTION; re-bench on the VM), so 2–3 survivors plus variants ≈ $3–6.
- Budget $30/mo with email alerts.

A1 throughput (`node packages/cli/dist/main.js bench --synthetic`, 2026-09-19,
Node 22.23.2, Neoverse-N1): **0.71 M events/s per core**, 132 MB/s allocation,
p99 13 µs. That is ~3.1× slower per core than the M3 Pro baseline
(2.19 M events/s, `benchmarks/baseline.json`), so scale grid wall-clock
estimates made on a laptop accordingly. `pnpm test` (73 files, 728 tests)
takes ~2 min 40 s at 4 OCPU.

## Teardown

The data volume and state bucket have `prevent_destroy`. To destroy
everything, remove those lifecycle blocks first, then:

```sh
terraform -chdir=infra/oci/main destroy
terraform -chdir=infra/oci/bootstrap destroy   # empty wsr-tfstate first (versioned objects too)
```
