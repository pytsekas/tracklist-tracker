terraform {
  required_version = ">= 1.6"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 8.0"
    }
  }

  # State lives on disk by default, which is fine for a single operator. To
  # share it, create a bucket and uncomment:
  #
  # backend "gcs" {
  #   bucket = "tracklist-browser-tfstate"
  #   prefix = "infra"
  # }
}

provider "google" {
  project = var.project_id
  region  = var.region
}
