# Instance principal for the VM: write access to the results bucket only.
# Instance metadata (IMDS) needs no policy.

resource "oci_identity_dynamic_group" "vm" {
  compartment_id = var.tenancy_ocid
  name           = "${local.name}-vm"
  description    = "The WSR research VM"
  matching_rule  = "instance.id = '${oci_core_instance.vm.id}'"
}

resource "oci_identity_policy" "vm" {
  compartment_id = local.compartment_id
  name           = "${local.name}-vm"
  description    = "WSR research VM syncs runs/ to ${var.results_bucket_name}"
  statements = [
    "Allow dynamic-group ${oci_identity_dynamic_group.vm.name} to read buckets in compartment ${var.compartment_name} where target.bucket.name = '${var.results_bucket_name}'",
    "Allow dynamic-group ${oci_identity_dynamic_group.vm.name} to manage objects in compartment ${var.compartment_name} where target.bucket.name = '${var.results_bucket_name}'",
  ]
}
