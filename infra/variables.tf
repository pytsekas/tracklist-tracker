variable "project_id" {
  type        = string
  description = "GCP project the registry and Cloud Run service live in."
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
  default     = true
}

variable "min_instances" {
  type        = number
  description = "Idle instances to keep warm. 0 scales to zero and costs nothing between visits."
  default     = 0
}

variable "max_instances" {
  type        = number
  description = "Ceiling on concurrent instances; also the ceiling on a surprise bill."
  default     = 3
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
