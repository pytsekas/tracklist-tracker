variable "project_id" {
  type        = string
  description = "GCP project the registry and Cloud Run service live in."
}

variable "owner_email" {
  type        = string
  description = "The single Google account allowed through IAP, and the key annotations are stored under."
}

variable "region" {
  type        = string
  description = "Region for Artifact Registry and Cloud Run."
  default     = "europe-north1"
}

variable "service_name" {
  type        = string
  description = "Cloud Run service name; also the image name and the prefix for service accounts."
  default     = "tracklist-browser"
}

variable "repository_id" {
  type        = string
  description = "Artifact Registry Docker repository id."
  default     = "containers"
}

variable "github_repository" {
  type        = string
  description = "owner/name of the GitHub repository allowed to deploy."
  default     = "pytsekas/tracklist-tracker"
}

variable "deploy_branch" {
  type        = string
  description = "Only workflow runs on this branch may sign in to GCP."
  default     = "main"
}

variable "allow_public_access" {
  type        = bool
  description = "Grant roles/run.invoker to allUsers, making the site reachable without signing in."
  default     = false
}

variable "min_instances" {
  type        = number
  description = "Idle instances to keep warm. 0 scales to zero and costs nothing between visits."
  default     = 0
}

variable "max_instances" {
  type        = number
  description = "Ceiling on concurrent instances; also the ceiling on a surprise bill."
  # This caps instances per revision, so one instance keeps the in-process
  # annotation temp table authoritative only in steady state: during a deploy
  # the old and new revisions can briefly run one each, and a read landing on
  # the other can be a few seconds stale. It self-heals — the durable store is
  # always correct, and each instance rebuilds its temp table from it at boot.
  # A top-level `scaling { max_instance_count = 1 }` would target that gap by
  # capping both revisions combined, but risks blocking the new revision from
  # starting until the old one drains — and Cloud Run documents that it may
  # temporarily exceed the max-instance limit during traffic migration anyway,
  # so it's deliberately not used here.
  default = 1
}

variable "cpu" {
  type        = string
  description = "CPU limit per instance."
  default     = "1"
}

variable "memory" {
  type        = string
  description = "Memory limit per instance. The archive is ~4.4 MB and opened read-only."
  default     = "512Mi"
}

variable "container_port" {
  type        = number
  description = "Port the Express server listens on. Cloud Run injects it as PORT."
  default     = 3000
}

variable "placeholder_image" {
  type        = string
  description = <<-EOT
    Image used when Terraform first creates the service, before any real build
    exists. Later images come from GitHub Actions and Terraform ignores changes
    to the field.
  EOT
  default     = "us-docker.pkg.dev/cloudrun/container/hello"
}

variable "firestore_location" {
  type        = string
  description = "Firestore location. Cannot be changed after the database is created."
  # Regional, co-located with the Cloud Run service, rather than the eur3
  # multi-region: lower latency, cheaper storage, and regional Firestore is
  # already durable enough for one person's annotations. The multi-region's
  # extra guarantee is surviving the loss of a whole region, which is not worth
  # paying for here — though note these annotations are the one thing in this
  # system that cannot be rebuilt, since the archive regenerates from the CSVs.
  default = "europe-north1"
}
