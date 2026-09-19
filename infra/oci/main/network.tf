resource "oci_core_vcn" "wsr" {
  compartment_id = local.compartment_id
  display_name   = local.name
  cidr_blocks    = ["10.20.0.0/16"]
  dns_label      = "wsr"
}

resource "oci_core_internet_gateway" "wsr" {
  compartment_id = local.compartment_id
  vcn_id         = oci_core_vcn.wsr.id
  display_name   = "${local.name}-igw"
  enabled        = true
}

resource "oci_core_route_table" "public" {
  compartment_id = local.compartment_id
  vcn_id         = oci_core_vcn.wsr.id
  display_name   = "${local.name}-public"

  route_rules {
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
    network_entity_id = oci_core_internet_gateway.wsr.id
  }
}

# The VCN's default security list opens 22/tcp to 0.0.0.0/0. Take it over with
# no rules so the NSG below is the only thing admitting traffic.
resource "oci_core_default_security_list" "empty" {
  manage_default_resource_id = oci_core_vcn.wsr.default_security_list_id
  display_name               = "${local.name}-default-empty"
}

resource "oci_core_subnet" "public" {
  compartment_id             = local.compartment_id
  vcn_id                     = oci_core_vcn.wsr.id
  display_name               = "${local.name}-public"
  cidr_block                 = "10.20.1.0/24"
  dns_label                  = "pub"
  route_table_id             = oci_core_route_table.public.id
  security_list_ids          = [oci_core_default_security_list.empty.id]
  prohibit_public_ip_on_vnic = false
}

resource "oci_core_network_security_group" "vm" {
  compartment_id = local.compartment_id
  vcn_id         = oci_core_vcn.wsr.id
  display_name   = "${local.name}-vm"
}

resource "oci_core_network_security_group_security_rule" "ssh_in" {
  for_each = toset(var.ssh_allowed_cidrs)

  network_security_group_id = oci_core_network_security_group.vm.id
  direction                 = "INGRESS"
  protocol                  = "6"
  source                    = each.value
  source_type               = "CIDR_BLOCK"
  stateless                 = false
  description               = "ssh from ${each.value}"

  tcp_options {
    destination_port_range {
      min = 22
      max = 22
    }
  }
}

# Path MTU discovery (ICMP type 3 code 4) from anywhere, as OCI's default list does.
resource "oci_core_network_security_group_security_rule" "icmp_frag" {
  network_security_group_id = oci_core_network_security_group.vm.id
  direction                 = "INGRESS"
  protocol                  = "1"
  source                    = "0.0.0.0/0"
  source_type               = "CIDR_BLOCK"
  stateless                 = false

  icmp_options {
    type = 3
    code = 4
  }
}

resource "oci_core_network_security_group_security_rule" "all_out" {
  network_security_group_id = oci_core_network_security_group.vm.id
  direction                 = "EGRESS"
  protocol                  = "all"
  destination               = "0.0.0.0/0"
  destination_type          = "CIDR_BLOCK"
  stateless                 = false
}
