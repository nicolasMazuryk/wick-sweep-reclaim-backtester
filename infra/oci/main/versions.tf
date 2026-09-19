terraform {
  required_version = ">= 1.12"

  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "~> 7.0"
    }
  }

  # State lives in the bucket created by ../bootstrap. The namespace is
  # tenancy-specific: terraform init -backend-config="namespace=<ns>".
  backend "oci" {
    bucket              = "wsr-tfstate"
    key                 = "main/terraform.tfstate"
    region              = "uk-london-1"
    config_file_profile = "DEFAULT"
  }
}
