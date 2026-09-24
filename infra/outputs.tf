output "service_url" {
  description = "Public URL of the Cloud Run service."
  value       = google_cloud_run_v2_service.app.uri
}

output "image_base" {
  description = "Image name the workflow pushes to, without a tag."
  value       = local.image_base
}

output "registry_host" {
  description = "Artifact Registry host to authenticate Docker against."
  value       = local.registry_host
}

output "workload_identity_provider" {
  description = "Full provider resource name for google-github-actions/auth."
  value       = google_iam_workload_identity_pool_provider.github.name
}

output "deploy_service_account" {
  description = "Service account GitHub Actions impersonates."
  value       = google_service_account.deployer.email
}

output "iap_audience" {
  description = "The aud claim the server verifies on every IAP assertion."
  value       = local.iap_audience
}

output "owner_email" {
  description = "The Google account allowed through IAP, and whose annotations the server loads."
  value       = var.owner_email
}

output "github_variables" {
  description = "Run these once to point the workflow at this project."
  value       = <<-EOT
    gh variable set GCP_PROJECT_ID     --body '${var.project_id}'
    gh variable set GCP_REGION         --body '${var.region}'
    gh variable set GCP_SERVICE        --body '${var.service_name}'
    gh variable set GCP_REPOSITORY     --body '${var.repository_id}'
    gh variable set GCP_WIF_PROVIDER   --body '${google_iam_workload_identity_pool_provider.github.name}'
    gh variable set GCP_DEPLOY_SA      --body '${google_service_account.deployer.email}'
  EOT
}
