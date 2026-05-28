# Recipe #48 — Mirth Connect on AWS — outputs
# Author: Nirmitee.io | License: MIT

output "alb_dns" {
  description = "Internal ALB DNS for Mirth admin API (HTTPS:443 -> 8443)"
  value       = aws_lb.admin.dns_name
}

output "nlb_dns" {
  description = "Internal NLB DNS for MLLP listeners"
  value       = aws_lb.mllp.dns_name
}

output "nlb_mllp_endpoints" {
  description = "Per-port MLLP endpoints"
  value       = { for p in var.mllp_ports : tostring(p) => "${aws_lb.mllp.dns_name}:${p}" }
}

output "rds_endpoint" {
  description = "RDS PostgreSQL endpoint"
  value       = aws_db_instance.this.endpoint
}

output "rds_resource_id" {
  description = "RDS resource ID (for IAM-based DB auth)"
  value       = aws_db_instance.this.resource_id
}

output "ecs_cluster_name" {
  description = "ECS cluster name"
  value       = aws_ecs_cluster.this.name
}

output "ecs_service_name" {
  description = "ECS service name"
  value       = aws_ecs_service.mirth.name
}

output "attachments_bucket" {
  description = "S3 bucket for Mirth attachments"
  value       = aws_s3_bucket.attachments.bucket
}

output "kms_key_arn" {
  description = "Customer-managed KMS key ARN"
  value       = aws_kms_key.mirth.arn
}

output "db_credentials_secret_arn" {
  description = "Secrets Manager ARN with DB credentials"
  value       = aws_secretsmanager_secret.db.arn
}

output "log_group_name" {
  description = "CloudWatch Logs group for Mirth tasks"
  value       = aws_cloudwatch_log_group.mirth.name
}
