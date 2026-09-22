data "google_project" "this" {}

locals {
  # Everything this stack needs. Enabling an already-enabled API is a no-op.
  required_apis = [
    "artifactregistry.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "run.googleapis.com",
    "sts.googleapis.com",
  ]

  registry_host = "${var.region}-docker.pkg.dev"
  image_base    = "${local.registry_host}/${var.project_id}/${var.repository_id}/${var.service_name}"
}

resource "google_project_service" "required" {
  for_each = toset(local.required_apis)

  service = each.value

  # Turning an API back off on destroy tends to break unrelated things that
  # quietly depend on it.
  disable_on_destroy = false
}

# ---- image registry ---------------------------------------------------------

resource "google_artifact_registry_repository" "containers" {
  location      = var.region
  repository_id = var.repository_id
  format        = "DOCKER"
  description   = "Container images for ${var.service_name}"

  # Keep the recent history browsable, let everything older expire so storage
  # does not grow forever.
  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"

    most_recent_versions {
      keep_count = 10
    }
  }

  cleanup_policies {
    id     = "delete-stale"
    action = "DELETE"

    condition {
      older_than = "2592000s" # 30 days
    }
  }

  depends_on = [google_project_service.required]
}

# ---- who GitHub Actions is allowed to be ------------------------------------

resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "github-actions"
  display_name              = "GitHub Actions"
  description               = "Short-lived sign-in for CI, so no service account keys exist."

  depends_on = [google_project_service.required]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  display_name                       = "GitHub OIDC"

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
  }

  # Without this, any GitHub repository in the world could sign in. Pull
  # requests from forks carry the fork's repository claim and are refused here.
  attribute_condition = <<-EOT
    assertion.repository == "${var.github_repository}" &&
    assertion.ref == "refs/heads/${var.deploy_branch}"
  EOT

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

# ---- the identity CI acts as ------------------------------------------------

resource "google_service_account" "deployer" {
  account_id   = "${var.service_name}-deployer"
  display_name = "GitHub Actions deployer for ${var.service_name}"
}

resource "google_project_iam_member" "deployer" {
  for_each = toset([
    "roles/artifactregistry.writer", # push images
    "roles/run.admin",               # create revisions
  ])

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.deployer.email}"
}

resource "google_service_account_iam_member" "deployer_from_github" {
  service_account_id = google_service_account.deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_repository}"
}

# ---- the identity the container runs as -------------------------------------

# Deliberately role-less: the app only reads a file baked into its own image.
resource "google_service_account" "runtime" {
  account_id   = "${var.service_name}-run"
  display_name = "Runtime identity for ${var.service_name}"
}

# Deploying a service that runs as another identity counts as using it.
resource "google_service_account_iam_member" "deployer_acts_as_runtime" {
  service_account_id = google_service_account.runtime.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deployer.email}"
}
