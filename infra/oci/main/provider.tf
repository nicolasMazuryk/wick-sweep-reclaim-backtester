provider "oci" {
  region              = var.region
  config_file_profile = var.oci_profile
}

data "oci_identity_compartments" "wsr" {
  compartment_id = var.tenancy_ocid
  name           = var.compartment_name
  state          = "ACTIVE"
}

data "oci_identity_availability_domains" "ads" {
  compartment_id = var.tenancy_ocid
}

data "oci_objectstorage_namespace" "ns" {
  compartment_id = var.tenancy_ocid
}

locals {
  compartment_id      = data.oci_identity_compartments.wsr.compartments[0].id
  availability_domain = data.oci_identity_availability_domains.ads.availability_domains[var.availability_domain_index].name
  namespace           = data.oci_objectstorage_namespace.ns.namespace
  name                = "wsr-research"
}
