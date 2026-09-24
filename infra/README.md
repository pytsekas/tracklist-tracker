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

## Rollout: turning on IAP

This is the one-time transition from the current public deployment to the
IAP-gated one this branch builds. Read it before running `terraform apply`
here — the moment that apply succeeds, the live site stops answering anyone
who isn't signed in as `owner_email`, including whoever's using the
currently-deployed (pre-annotations) code.

**This is not the three-step rollout the design brief describes**, where a
first apply adds Firestore and IAM while the site stays public, and a later,
separate apply flips `iap_enabled` on. That assumed `iap_enabled` was a
variable. It isn't: `iap_enabled = true` is a hardcoded literal in
`cloud_run.tf`, not conditioned on `allow_public_access` or anything else. One
`terraform apply` of this config turns on Firestore, the IAP IAM bindings,
*and* `iap_enabled` together — there's no way, with this code, to apply the
annotations infra while leaving the site reachable without signing in. Keep
`allow_public_access = false`; if a real (gitignored) `terraform.tfvars` sets
it `true` from before this change, drop that line — it no longer buys a public
window, only an inert `allUsers` grant that IAP prevents from ever being used.

What the brief's phasing was actually protecting against — not being able to
tell an IAP problem from a code problem — still matters, so the sequencing
below preserves it a different way: prove IAP itself works against Cloud Run's
*placeholder* image before your code is anywhere near it, so that if shipping
the code afterward breaks the smoke test, you know it's the code.

### 0. Before the first apply

- **Set `owner_email`.** It has no default; Terraform fails (or prompts) at
  plan time without it. Add it to your (gitignored) `terraform.tfvars`, and
  add a placeholder line to `terraform.tfvars.example` for the next person.
- **Provision the IAP service agent — this is the step a green `apply` cannot
  verify for you.** `main.tf` grants `roles/run.invoker` to
  `service-<PROJECT_NUMBER>@gcp-sa-iap.iam.gserviceaccount.com`, but nothing in
  this stack creates that identity, and enabling `iap.googleapis.com` does not
  create it either. Run this once, before applying:

  ```bash
  gcloud beta services identity create \
    --service=iap.googleapis.com \
    --project=<PROJECT_ID>
  ```

  It prints the identity it created or already found — confirm the email
  matches `service-<PROJECT_NUMBER>@...`; `terraform output -raw iap_audience`
  has the same project number embedded (`/projects/<NUMBER>/locations/...`) if
  you need it. The command is idempotent, so it's safe to re-run if unsure.

  Skip this and the failure is silent: `google_cloud_run_v2_service_iam_member`
  is served by the Cloud Run Admin API, which — unlike project-level IAM — does
  not validate that a member exists. Terraform records the grant either way.
  If the agent was never created, the apply still goes green, IAP still turns
  on, the old public grant is still gone, and the service is simply
  unreachable, with nothing in the Terraform output pointing at why.

### 1. Apply

```bash
cd infra
terraform apply
```

The plan should show: the Firestore database, the `roles/datastore.user` and
`roles/iap.httpsResourceAccessor` grants, `iap_enabled` turning on, and (if
`allow_public_access` was `true` before) the `allUsers` grant being destroyed.
The container is still whatever image was last deployed — nothing about your
code has shipped yet.

**Treat this apply as unverified until you check it yourself** — a green
`apply` proves the config was recorded, not that it works:

1. `gcloud run services get-iam-policy tracklist-browser --region=europe-north1`
   — confirm `roles/run.invoker` lists the IAP service agent. This confirms
   Terraform wrote what it meant to; it does not, by itself, prove the agent
   exists (the same non-validating API serves this read too), so treat it as a
   config check, not proof.
2. `curl -I "$(terraform output -raw service_url)"` from a machine with no
   Google session. Expect something that reads as IAP's own gate — a redirect
   toward Google sign-in, or a body that mentions IAP or signing in — not a
   flat, immediate error with no such indication. IAP's exact status code and
   wording for a bare `curl` aren't something this repo controls or something
   verifiable without a live service, so judge the response by its content,
   not by memorizing a status number.
3. **The check that actually proves the service agent works:** open the URL
   in a browser signed in as `owner_email`. Reaching Cloud Run's
   "Congratulations" placeholder page (or whatever was last deployed) after
   signing in means the whole chain — IAP, the service agent, the invoker
   grant — is working. Signing in successfully and then seeing an IAP or
   Cloud Run error page instead means the service agent is still missing;
   go back and re-run the `gcloud beta services identity create` command,
   then retry this check.

### 2. Ship the code

```bash
git push -u origin show-annotations
gh pr create --fill
# merge once CI is green
```

Set the smoke test's IAP variable before or shortly after merging — without
it, CI degrades to a notice instead of actually checking anything:

```bash
gh variable set GCP_IAP_CLIENT_ID --body '<from the IAP settings page>'
```

### 3. Verify, in this order

1. Opening the URL in a signed-out browser prompts for Google sign-in.
2. Signing in as `owner_email` works and the annotations are still there.
3. Signing in as any other account is refused.
4. `curl -fsS "$(terraform output -raw service_url)/healthz"` with no token
   returns 403 — IAP is on and gating a real route, not just the placeholder.
5. The next push to `main` goes green, including the authenticated smoke test.

**Rollback is not simply "the inverse apply."** Undoing `allow_public_access`
or the Firestore/IAM grants is a normal `terraform apply` with different
variables. Undoing `iap_enabled` is not — it's a hardcoded literal, so no
`terraform.tfvars` edit touches it; putting the site back to fully public
without IAP means editing `cloud_run.tf` and applying that code change. No
data migration either way: annotations live in Firestore independently of any
of this.

## Cost

Cloud Run scales to zero, so an idle month is free: no instances, no CPU, no
requests. What you pay for is Artifact Registry storage (a few hundred MB of
images, cents) and egress. `max_instances = 1` caps the worst case — and it is
load-bearing, not just a cost cap: the annotation temp table is in-process, so
a second concurrent instance would serve stale rows (see Annotations in the
[top-level README](../README.md#annotations)).

## Tearing it down

```bash
terraform destroy
```

Artifact Registry refuses to delete a repository that still holds images; empty
it first, or delete the project outright with
`gcloud projects delete tracklist-browser-prod`.

## Notes

* **Public access defaults to off, and no longer does much either way.**
  `allow_public_access` defaults to `false`. Setting it `true` grants
  `roles/run.invoker` to `allUsers` — but `iap_enabled = true` is now a
  hardcoded literal on the Cloud Run service in `cloud_run.tf`, not something
  this variable gates, so IAP intercepts every request regardless of what this
  flag is set to. Leave it `false`; see Rollout, above, for what that means for
  anyone still relying on the old public-preview behavior. An organization
  with domain-restricted sharing would reject the `allUsers` binding outright
  if it ever did take effect. To reach the service without going through IAP
  at all, use `gcloud run services proxy tracklist-browser --region=europe-north1`.
* **`owner_email` is required, with no default.** Terraform prompts for it (or
  fails non-interactively) until it's set in `terraform.tfvars`. It is both who
  IAP lets through and whose annotations the server loads at boot.
* **`firestore_location` is one-shot.** It can't be changed once
  `google_firestore_database.annotations` exists — the default (`eur3`) is a
  fine choice to leave alone, but pick deliberately if you override it, before
  the apply that creates the database.
* **State is local.** `terraform.tfstate` sits in this directory and is
  gitignored. Uncomment the GCS backend in `versions.tf` before a second person
  needs to apply.
* **Deploys are branch-locked.** The provider's attribute condition refuses to
  sign in from any branch but `main`, so a pull request cannot deploy even if
  the workflow were changed to try.
