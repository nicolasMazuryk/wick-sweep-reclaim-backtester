variable "tenancy_ocid" {
  description = "Tenancy OCID (the `tenancy` value in ~/.oci/config)."
  type        = string
}

variable "region" {
  description = "Home region. Must match the backend block in versions.tf."
  type        = string
  default     = "uk-london-1"
}

variable "oci_profile" {
  description = "Profile in ~/.oci/config used for API-key auth."
  type        = string
  default     = "DEFAULT"
}

variable "compartment_name" {
  description = "Compartment created by ../bootstrap."
  type        = string
  default     = "wsr-research"
}

variable "availability_domain_index" {
  description = "0 = AD-1, 1 = AD-2. AD-3 has no A1 quota in this tenancy."
  type        = number
  default     = 0

  validation {
    condition     = contains([0, 1], var.availability_domain_index)
    error_message = "A1 capacity exists only in AD-1 (0) and AD-2 (1)."
  }
}

variable "ssh_allowed_cidrs" {
  description = "IPv4 CIDRs allowed to reach port 22."
  type        = list(string)

  validation {
    condition     = length(var.ssh_allowed_cidrs) > 0 && alltrue([for c in var.ssh_allowed_cidrs : can(cidrnetmask(c)) && c != "0.0.0.0/0"])
    error_message = "Provide at least one IPv4 CIDR; 0.0.0.0/0 is not allowed."
  }
}

variable "ssh_public_key_path" {
  description = "Public key installed for the ubuntu user."
  type        = string
  default     = "~/.ssh/wsr_oci.pub"
}

variable "shape" {
  description = "VM.Standard.A1.Flex (default, Always Free baseline) or VM.Standard.E5.Flex (burst fallback when A1 is out of capacity; recreates the instance, keeps the data volume)."
  type        = string
  default     = "VM.Standard.A1.Flex"

  validation {
    condition     = contains(["VM.Standard.A1.Flex", "VM.Standard.E5.Flex"], var.shape)
    error_message = "Supported shapes: VM.Standard.A1.Flex, VM.Standard.E5.Flex."
  }
}

variable "ocpus" {
  description = "OCPUs. Baseline 4 (Always Free); burst 16 via scripts/burst.sh up."
  type        = number
  default     = 4
}

variable "memory_gbs" {
  description = "Memory in GB. Baseline 24 (Always Free); burst 64."
  type        = number
  default     = 24
}

variable "boot_volume_gbs" {
  description = "Boot volume size."
  type        = number
  default     = 50
}

variable "data_volume_gbs" {
  description = "Data volume size. Grow only: OCI cannot shrink a block volume."
  type        = number
  default     = 500

  validation {
    condition     = var.data_volume_gbs >= 500
    error_message = "The data volume is grow-only and was created at 500 GB."
  }
}

variable "data_volume_vpus_per_gb" {
  description = "Block volume performance: 10 = Balanced."
  type        = number
  default     = 10
}

variable "results_bucket_name" {
  description = "Bucket receiving the hourly sync of runs/ (memos, reports, JSON)."
  type        = string
  default     = "wsr-results"
}

variable "alert_email" {
  description = "Recipient of alarm and budget notifications."
  type        = string
}

variable "budget_monthly_usd" {
  description = "Monthly budget on the compartment."
  type        = number
  default     = 30
}

variable "repo_ssh_url" {
  description = "Repo cloned on the VM once the deploy key is added."
  type        = string
  default     = "git@github.com:nicolasMazuryk/wick-sweep-reclaim.git"
}
