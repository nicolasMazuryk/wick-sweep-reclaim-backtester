locals {
  data_device_path = "/dev/oracleoci/oraclevdb"
}

resource "oci_core_volume" "data" {
  compartment_id      = local.compartment_id
  availability_domain = local.availability_domain
  display_name        = "wsr-data"
  size_in_gbs         = var.data_volume_gbs
  vpus_per_gb         = var.data_volume_vpus_per_gb

  lifecycle {
    prevent_destroy = true
  }
}

resource "oci_core_volume_attachment" "data" {
  attachment_type = "paravirtualized"
  instance_id     = oci_core_instance.vm.id
  volume_id       = oci_core_volume.data.id
  device          = local.data_device_path
  display_name    = "wsr-data"
}

resource "oci_objectstorage_bucket" "results" {
  compartment_id = local.compartment_id
  namespace      = local.namespace
  name           = var.results_bucket_name
  access_type    = "NoPublicAccess"
  versioning     = "Enabled"
}
