resource "google_cloud_run_v2_service" "app" {
  name        = var.service_name
  location    = var.region
  ingress     = "INGRESS_TRAFFIC_ALL"
  iap_enabled = true

  # The archive is rebuildable from the CSVs. The annotations are not, but they
  # live in Firestore, which has its own delete protection.
  deletion_protection = false

  template {
    service_account = google_service_account.runtime.email

    scaling {
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }

    containers {
      # Replaced by every deploy; see the lifecycle block below.
      image = var.placeholder_image

      ports {
        container_port = var.container_port
      }

      env {
        name  = "IAP_AUDIENCE"
        value = local.iap_audience
      }

      env {
        name  = "OWNER_EMAIL"
        value = var.owner_email
      }

      # Cloud Run does not set this itself (that's App Engine/Cloud Functions);
      # without it the Firestore client falls back to metadata-server project
      # detection, which resolves lazily on the first RPC instead of at boot,
      # so a misconfiguration would surface as a 502 on the first annotation
      # write rather than failing fast like IAP_AUDIENCE does above.
      env {
        name  = "GOOGLE_CLOUD_PROJECT"
        value = var.project_id
      }

      resources {
        limits = {
          cpu    = var.cpu
          memory = var.memory
        }

        # Bill for CPU only while a request is in flight, but give the boot a
        # full core so the first visitor after a scale-to-zero is not punished.
        cpu_idle          = true
        startup_cpu_boost = true
      }

      # /healthz returns 503 while the archive is missing or empty, so a broken
      # image never takes traffic from the working revision.
      startup_probe {
        http_get {
          path = "/healthz"
          port = var.container_port
        }

        initial_delay_seconds = 3
        period_seconds        = 5
        timeout_seconds       = 3
        failure_threshold     = 6
      }

      liveness_probe {
        http_get {
          path = "/healthz"
          port = var.container_port
        }

        period_seconds  = 30
        timeout_seconds = 3
      }
    }
  }

  lifecycle {
    # GitHub Actions owns which image is deployed. Without this, every
    # `terraform apply` would roll the service back to the placeholder.
    ignore_changes = [
      template[0].containers[0].image,
      client,
      client_version,
    ]
  }

  depends_on = [google_project_service.required]
}

resource "google_cloud_run_v2_service_iam_member" "public" {
  count = var.allow_public_access ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.app.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
