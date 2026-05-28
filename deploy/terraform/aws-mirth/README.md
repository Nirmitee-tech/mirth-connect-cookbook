# Recipe #48 — Mirth Connect on AWS (Terraform Module)

**Description:** Production Terraform module that lands Mirth Connect on AWS using ECS Fargate, RDS PostgreSQL Multi-AZ, an internal ALB for the admin API, an internal NLB for MLLP listeners, and an encrypted S3 bucket for attachment overflow. All data at rest is encrypted with a customer-managed KMS key, all secrets live in Secrets Manager, and IAM roles are scoped to least-privilege.

**Use case:** Hospital IT or HealthTech vendor that wants Mirth running on AWS with HIPAA-aligned defaults (BAA still required), Multi-AZ resilience, and managed PostgreSQL — without rolling their own EC2 fleet.

**Requirements:**
- Terraform `>= 1.6`
- AWS provider `>= 5.40`
- An existing VPC with `>=2` private subnets across AZs (for RDS + ECS) and `>=2` for the LBs
- An ACM certificate in the same region for the admin ALB

**Tested on:** Mirth Connect `4.5.2`, Terraform `1.7.5`, AWS provider `5.42`.
**Author:** Nirmitee.io | **License:** MIT

---

## Architecture

```
                  ┌─────────────────────────┐
   Clinical EHRs ─┤ NLB (TCP 6661/6662/...) ├──┐
                  └─────────────────────────┘  │
                                               │  awsvpc tasks
                  ┌─────────────────────────┐  │
        Ops ─────▶│ ALB (HTTPS 443)         ├──┤
                  └─────────────────────────┘  │
                                               ▼
                                ┌───────────────────────────┐
                                │  ECS Fargate (2× Mirth)   │
                                │  CW Logs + Container Insights
                                └──────────┬────────────────┘
                                           │ TLS to 5432
                                           ▼
                                ┌──────────────────────────┐
                                │ RDS PostgreSQL Multi-AZ  │
                                │ encrypted (CMK), backups │
                                └──────────────────────────┘

         S3 (attachments, SSE-KMS)   Secrets Manager (DB creds)
         CloudWatch Alarms (CPU, storage)   KMS CMK (rotated)
```

## Example usage

```hcl
module "mirth" {
  source = "github.com/Nirmitee-tech/mirth-connect-cookbook//deploy/terraform/aws-mirth?ref=v1.0.0"

  name                      = "acme-mirth"
  environment               = "prod"
  vpc_id                    = "vpc-0abc..."
  private_subnet_ids        = ["subnet-aaa", "subnet-bbb"]
  public_subnet_ids         = ["subnet-ccc", "subnet-ddd"]
  admin_acm_certificate_arn = "arn:aws:acm:us-east-1:1234:certificate/abcd-..."

  mirth_image_tag = "4.5.2"
  desired_count   = 2
  task_cpu        = 2048
  task_memory     = 4096
  jvm_heap_mb     = 3072

  mllp_ports = [6661, 6662, 6663]
  mllp_allowed_cidrs = ["10.10.0.0/16"]   # Epic interface engine subnet
  ingress_allowed_cidrs = ["10.0.0.0/8"]

  db_instance_class       = "db.r6g.xlarge"
  db_allocated_storage_gb = 200
}
```

## Validate locally

```bash
cd deploy/terraform/aws-mirth
terraform init -backend=false
terraform validate
tflint
```

A mock `provider.tf` is included so `terraform validate` works without AWS credentials. **Remove or override it** in production — the calling root module supplies the real provider.

## Outputs

| Output | Use |
|---|---|
| `alb_dns` | Point a Route 53 alias at this for the admin URL |
| `nlb_dns` | Tell upstream EHRs to send MLLP here |
| `nlb_mllp_endpoints` | Map of `port -> endpoint:port` |
| `rds_endpoint` | Backend DB endpoint (already wired into Mirth) |
| `attachments_bucket` | Configure Mirth attachment redirect handler against this |
| `db_credentials_secret_arn` | For rotation Lambdas / break-glass access |
| `kms_key_arn` | For cross-account snapshot sharing |

## Cost estimate (us-east-1, 2026 pricing)

| Component | Spec | Monthly |
|---|---|---:|
| Fargate tasks | 2 × (2 vCPU, 4 GB), 730h | ~$140 |
| RDS PostgreSQL | `db.t4g.large` Multi-AZ, 100 GB gp3 | ~$280 |
| RDS PostgreSQL (prod) | `db.r6g.xlarge` Multi-AZ, 200 GB | ~$680 |
| ALB | 1 internal ALB, ~10 GB processed | ~$25 |
| NLB | 1 internal NLB, 3 listeners, ~50 GB | ~$30 |
| CloudWatch Logs | 100 GB ingested + 90-day retention | ~$60 |
| Container Insights | per-task metrics | ~$15 |
| KMS | 1 CMK, ~10K requests/day | ~$8 |
| S3 attachments | 100 GB + SSE-KMS | ~$15 |
| Secrets Manager | 1 secret | ~$0.50 |
| Data transfer | intra-AZ free, ~50 GB cross-AZ | ~$45 |
| **Light prod (t4g.large RDS)** | | **~$1,800/mo** |
| **Heavy prod (r6g.xlarge RDS)** | | **~$3,500/mo** |

Numbers verified against AWS pricing calculator on 2026-05-28. Reserved Instances for RDS knock ~40% off the largest line item.

## HIPAA notes

- **BAA required.** Sign an AWS BAA before storing PHI in any of these resources.
- **Encryption at rest:** RDS, S3, EBS-backed Fargate ephemeral storage, CloudWatch Logs, and Secrets Manager all use the module's customer-managed KMS key.
- **Encryption in transit:** Admin uses ALB TLS 1.3. RDS connections use TLS (Mirth opens with `?ssl=true&sslmode=require` in your DB URL — add this to `database.url` in mirth.properties via task overrides). MLLP TLS is *not* covered here — pair with recipe #30 (`mllps-tls-mutual-auth`) for client cert auth, or terminate TLS at the NLB with an ACM cert.
- **Audit logs:** RDS exports `postgresql` log group with `log_statement = ddl`; CloudTrail must be enabled at the account level (out of scope here).
- **Least privilege:** Two distinct IAM roles — `execution` (only pull from Secrets Manager + KMS decrypt) and `task` (only S3 attachments + RDS IAM connect).
- **Backups:** RDS automated backups for 14 days (configurable). Snapshots are KMS-encrypted with the same CMK. Deletion protection is enabled when `environment == "prod"`.
- **Network isolation:** ALB + NLB + ECS + RDS all in private subnets. No public IPs. Outbound to the internet goes through your NAT GW (set up by the caller).

## Customize

- **Public ingress:** Set `aws_lb.admin.internal = false` and supply public subnets. **Don't** do this for MLLP without TLS + IP allowlist + WAF.
- **More MLLP ports:** Add to `mllp_ports`; the module generates target groups, listeners, and SG rules dynamically.
- **Spot for cost savings:** Adjust `aws_ecs_cluster_capacity_providers` weights to shift some replicas to `FARGATE_SPOT`. Keep `base = desired_count - 1` on regular Fargate to avoid total eviction.
- **IAM-based DB auth:** Already enabled (`iam_database_authentication_enabled = true`). Switch Mirth's DB URL to use an IAM auth token instead of the password secret if you want zero-password ops.

## File listing

| File | Purpose |
|---|---|
| `main.tf` | All resources (KMS, RDS, ECS, ALB, NLB, S3, IAM, alarms) |
| `variables.tf` | Inputs |
| `outputs.tf` | Outputs |
| `provider.tf` | Mock AWS provider for `terraform validate` |
