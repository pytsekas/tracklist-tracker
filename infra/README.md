# Infrastructure

Terraform for the GCP side of the deploy: an image registry, a Cloud Run
service, and a way for GitHub Actions to sign in without a stored key.

```
GitHub Actions ──OIDC──> Workload Identity Pool ──> deployer service account
                                                         │
                                  push image             │  deploy revision
                                     ▼                   ▼
                          Artifact Registry ──────> Cloud Run service
                                                    (runs as its own
                                                     role-less identity)
```

| Resource | Why |
| --- | --- |
| Artifact Registry repo | Holds the images. Keeps the last 10 versions, expires anything older than 30 days |
| Workload identity pool + provider | Lets the workflow sign in as GCP. Accepts only this repository, only on `main` |
| `tracklist-browser-deployer` SA | What CI acts as: push images, create revisions |
| `tracklist-browser-run` SA | What the container runs as. Holds no roles — it only reads a file inside its own image |
| Cloud Run service | The app. Scales to zero, `/healthz` gates every new revision |

## One-time bootstrap

Terraform does not create the project or attach billing — those are the two
steps that cost money, so they stay manual.

```bash
gcloud projects create tracklist-browser-prod --name="Tracklist browser"
gcloud billing accounts list
gcloud billing projects link tracklist-browser-prod --billing-account=XXXXXX-XXXXXX-XXXXXX
gcloud auth application-default login
```

Then apply:

```bash
cd infra
cp terraform.tfvars.example terraform.tfvars   # set project_id
terraform init
terraform apply
```

The first apply takes a few minutes, mostly waiting for APIs to enable. It
creates the Cloud Run service pointed at Google's `hello` placeholder image —
the real one does not exist until CI pushes it, and Terraform ignores the image
field from then on so an `apply` never rolls back a deploy.

## Point GitHub at it

The workflow reads repository variables, not secrets — none of these values are
sensitive. Terraform prints the exact commands:

```bash
terraform output -raw github_variables | sh
```

Or set them by hand under **Settings → Secrets and variables → Actions →
Variables**: `GCP_PROJECT_ID`, `GCP_REGION`, `GCP_SERVICE`, `GCP_REPOSITORY`,
`GCP_WIF_PROVIDER`, `GCP_DEPLOY_SA`.

Until `GCP_WIF_PROVIDER` exists, CI still runs — it tests, builds, and builds
the image, then logs a notice that it is not publishing. Nothing fails.

## After that

Every push to `main` builds, pushes `:<sha>` and `:latest`, deploys a revision,
and curls `/healthz` against the live URL. Pull requests do everything except
publish.

```bash
terraform output service_url          # where it lives
gcloud run services logs tail tracklist-browser --region=europe-north1
```

## Cost

Cloud Run scales to zero, so an idle month is free: no instances, no CPU, no
requests. What you pay for is Artifact Registry storage (a few hundred MB of
images, cents) and egress. `max_instances = 3` caps the worst case.

## Tearing it down

```bash
terraform destroy
```

Artifact Registry refuses to delete a repository that still holds images; empty
it first, or delete the project outright with
`gcloud projects delete tracklist-browser-prod`.

## Notes

* **Public access.** `allow_public_access = true` grants `roles/run.invoker` to
  `allUsers`. An organization with domain-restricted sharing will reject that
  binding; set the variable to `false` and reach the service with
  `gcloud run services proxy tracklist-browser --region=europe-north1`.
* **State is local.** `terraform.tfstate` sits in this directory and is
  gitignored. Uncomment the GCS backend in `versions.tf` before a second person
  needs to apply.
* **Deploys are branch-locked.** The provider's attribute condition refuses to
  sign in from any branch but `main`, so a pull request cannot deploy even if
  the workflow were changed to try.
