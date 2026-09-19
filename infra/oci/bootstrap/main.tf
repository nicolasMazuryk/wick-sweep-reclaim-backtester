# Local-state stack: the compartment and the bucket that holds the main
# stack's remote state. Apply once; its terraform.tfstate stays local (gitignored).

resource "oci_identity_compartment" "wsr" {
  compartment_id = var.tenancy_ocid
  name           = var.compartment_name
  description    = "WSR research: VM, data volume, results, alarms, budget"
  enable_delete  = true
}

data "oci_objectstorage_namespace" "ns" {
  compartment_id = var.tenancy_ocid
}

resource "oci_objectstorage_bucket" "tfstate" {
  compartment_id = oci_identity_compartment.wsr.id
  namespace      = data.oci_objectstorage_namespace.ns.namespace
  name           = var.state_bucket_name
  access_type    = "NoPublicAccess"
  versioning     = "Enabled"

  lifecycle {
    prevent_destroy = true
  }
}
