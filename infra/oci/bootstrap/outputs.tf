output "compartment_id" {
  value = oci_identity_compartment.wsr.id
}

output "namespace" {
  value = data.oci_objectstorage_namespace.ns.namespace
}

output "state_bucket" {
  value = oci_objectstorage_bucket.tfstate.name
}

output "backend_init" {
  description = "Command to initialise the main stack against the state bucket."
  value       = "terraform -chdir=../main init -backend-config=\"namespace=${data.oci_objectstorage_namespace.ns.namespace}\""
}
