variable "tenancy_ocid" {
  description = "Tenancy OCID (the `tenancy` value in ~/.oci/config)."
  type        = string
}

variable "region" {
  description = "Home region."
  type        = string
  default     = "uk-london-1"
}

variable "oci_profile" {
  description = "Profile in ~/.oci/config used for API-key auth."
  type        = string
  default     = "DEFAULT"
}

variable "compartment_name" {
  description = "Compartment holding every WSR research resource."
  type        = string
  default     = "wsr-research"
}

variable "state_bucket_name" {
  description = "Object Storage bucket for the main stack's Terraform state."
  type        = string
  default     = "wsr-tfstate"
}
