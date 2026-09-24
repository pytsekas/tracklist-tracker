data "google_project" "this" {}

locals {
  # Everything this stack needs. Enabling an already-enabled API is a no-op.
  required_apis = [
    "artifactregistry.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "firestore.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "iap.googleapis.com",
    "run.googleapis.com",
    "sts.googleapis.com",
  ]

  registry_host = "${var.region}-docker.pkg.dev"
  image_base    = "${local.registry_host}/${var.project_id}/${var.repository_id}/${var.service_name}"

  # IAP's Cloud Run audience form. NOT the App Engine (/projects/N/apps/ID) or
  # backend-service (/projects/N/global/backendServices/ID) form that most IAP
  # sample code uses; a wrong audience is a check that passes for the wrong
  # service. See docs/superpowers/specs/2026-09-22-show-annotations-design.md.
  iap_audience = "/projects/${data.google_project.this.number}/locations/${var.region}/services/${var.service_name}"
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

# ---- the annotation store ---------------------------------------------------

resource "google_firestore_database" "annotations" {
  project     = var.project_id
  name        = "(default)"
  location_id = var.firestore_location
  type        = "FIRESTORE_NATIVE"

  # The archive is rebuildable from the CSVs; annotations are not.
  delete_protection_state = "DELETE_PROTECTION_ENABLED"

  depends_on = [google_project_service.required]
}

# The runtime identity stops being role-less: it now reads and writes its own
# annotations. Still nothing else.
resource "google_project_iam_member" "runtime_firestore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.runtime.email}"
}

# ---- IAP --------------------------------------------------------------------

# IAP calls the service on the user's behalf, so it needs its own invoker grant.
#
# Enabling iap.googleapis.com does not provision the IAP service agent this
# grant targets; Google only creates it via `gcloud beta services identity
# create --service=iap.googleapis.com --project=<project>` (or implicitly from
# the console), which is not a resource this provider exposes without adding
# google-beta. That one-time command belongs to the rollout, not here — see
# the rollout section of infra/README.md. Resource-level IAM on Cloud Run is
# served by the Cloud Run Admin API, which does not validate that a member
# exists, so a green apply proves nothing: if the agent was never created,
# this binding is recorded against an address nobody occupies and every
# request fails to reach the backend once IAP is enabled.
resource "google_cloud_run_v2_service_iam_member" "iap_invoker" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.app.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:service-${data.google_project.this.number}@gcp-sa-iap.iam.gserviceaccount.com"

  depends_on = [google_project_service.required]
}

# Who is allowed through the front door.
resource "google_iap_web_cloud_run_service_iam_member" "owner" {
  project                = var.project_id
  location               = var.region
  cloud_run_service_name = google_cloud_run_v2_service.app.name
  role                   = "roles/iap.httpsResourceAccessor"
  member                 = "user:${var.owner_email}"
}

# The deploy identity needs it too, or the post-deploy healthcheck 403s.
resource "google_iap_web_cloud_run_service_iam_member" "deployer" {
  project                = var.project_id
  location               = var.region
  cloud_run_service_name = google_cloud_run_v2_service.app.name
  role                   = "roles/iap.httpsResourceAccessor"
  member                 = "serviceAccount:${google_service_account.deployer.email}"
}
