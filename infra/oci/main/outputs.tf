output "public_ip" {
  value = oci_core_instance.vm.public_ip
}

output "ssh" {
  value = "ssh -i ${trimsuffix(pathexpand(var.ssh_public_key_path), ".pub")} ubuntu@${oci_core_instance.vm.public_ip}"
}

output "instance_id" {
  value = oci_core_instance.vm.id
}

output "shape" {
  value = "${var.shape} ${var.ocpus} OCPU / ${var.memory_gbs} GB"
}

output "image" {
  value = data.oci_core_images.ubuntu.images[0].display_name
}

output "data_volume_id" {
  value = oci_core_volume.data.id
}

output "results_bucket" {
  value = "${local.namespace}/${oci_objectstorage_bucket.results.name}"
}

output "nsg_id" {
  value = oci_core_network_security_group.vm.id
}
