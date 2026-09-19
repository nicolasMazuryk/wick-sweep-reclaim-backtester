data "oci_core_images" "ubuntu" {
  compartment_id           = local.compartment_id
  operating_system         = "Canonical Ubuntu"
  operating_system_version = "24.04"
  shape                    = var.shape
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"

  # Exclude the Minimal and GPU variants.
  filter {
    name   = "display_name"
    values = ["^Canonical-Ubuntu-24\\.04-(aarch64-)?\\d{4}\\.\\d{2}\\.\\d{2}-\\d+$"]
    regex  = true
  }
}

# Changing architecture (A1 <-> E5) cannot be done in place; this forces a
# replacement of the instance only. The data volume is untouched.
resource "terraform_data" "arch" {
  input = var.shape
}

resource "oci_core_instance" "vm" {
  compartment_id      = local.compartment_id
  availability_domain = local.availability_domain
  display_name        = local.name
  shape               = var.shape

  # In-place resize (baseline <-> burst) reboots the instance; the grid is
  # resumable with `wsr grid --run-id`.
  shape_config {
    ocpus         = var.ocpus
    memory_in_gbs = var.memory_gbs
  }

  source_details {
    source_type             = "image"
    source_id               = data.oci_core_images.ubuntu.images[0].id
    boot_volume_size_in_gbs = var.boot_volume_gbs
  }

  create_vnic_details {
    subnet_id        = oci_core_subnet.public.id
    assign_public_ip = true
    hostname_label   = "wsr"
    nsg_ids          = [oci_core_network_security_group.vm.id]
  }

  metadata = {
    ssh_authorized_keys = trimspace(file(pathexpand(var.ssh_public_key_path)))
    user_data = base64encode(templatefile("${path.module}/cloud-init.yaml.tftpl", {
      bootstrap_sh     = file("${path.module}/../scripts/bootstrap-vm.sh")
      sync_results_sh  = file("${path.module}/../scripts/sync-results.sh")
      region           = var.region
      namespace        = local.namespace
      results_bucket   = var.results_bucket_name
      repo_ssh_url     = var.repo_ssh_url
      data_device_path = local.data_device_path
    }))
  }

  agent_config {
    is_monitoring_disabled = false
    is_management_disabled = false

    plugins_config {
      name          = "Compute Instance Monitoring"
      desired_state = "ENABLED"
    }
  }

  lifecycle {
    # New Ubuntu builds and cloud-init edits must not recreate the VM.
    # Re-run scripts/bootstrap-vm.sh over ssh to apply bootstrap changes.
    ignore_changes       = [source_details[0].source_id, metadata["user_data"]]
    replace_triggered_by = [terraform_data.arch]
  }
}
