# Recipe #48 — Mirth Connect on AWS — variables
# Tested on Mirth Connect 4.5.2
# Author: Nirmitee.io | License: MIT

variable "name" {
  description = "Name prefix applied to all resources"
  type        = string
  default     = "mirth"
}

variable "environment" {
  description = "Environment tag (dev / staging / prod)"
  type        = string
  default     = "prod"
}

variable "vpc_id" {
  description = "VPC ID where Mirth runs"
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnet IDs for ECS tasks and RDS (>=2 across AZs)"
  type        = list(string)
}

variable "public_subnet_ids" {
  description = "Public subnet IDs for the ALB + NLB"
  type        = list(string)
}

variable "mirth_image" {
  description = "Mirth Connect container image"
  type        = string
  default     = "nextgenhealthcare/connect"
}

variable "mirth_image_tag" {
  description = "Mirth Connect image tag"
  type        = string
  default     = "4.5.2"
}

variable "task_cpu" {
  description = "Fargate task CPU units (1024 = 1 vCPU)"
  type        = number
  default     = 2048
}

variable "task_memory" {
  description = "Fargate task memory (MB)"
  type        = number
  default     = 4096
}

variable "desired_count" {
  description = "Number of Mirth tasks"
  type        = number
  default     = 2
}

variable "jvm_heap_mb" {
  description = "JVM max heap in MB (should leave ~25% of task_memory for native + metaspace)"
  type        = number
  default     = 3072
}

variable "mllp_ports" {
  description = "List of MLLP listener ports on the NLB"
  type        = list(number)
  default     = [6661, 6662, 6663]
}

variable "admin_acm_certificate_arn" {
  description = "ACM cert ARN for the ALB HTTPS listener (admin API)"
  type        = string
}

variable "ingress_allowed_cidrs" {
  description = "CIDRs permitted to reach the admin ALB"
  type        = list(string)
  default     = ["10.0.0.0/8"]
}

variable "mllp_allowed_cidrs" {
  description = "CIDRs permitted to reach the NLB MLLP listeners (EHR source IPs)"
  type        = list(string)
  default     = []
}

variable "db_instance_class" {
  description = "RDS instance class"
  type        = string
  default     = "db.t4g.large"
}

variable "db_allocated_storage_gb" {
  description = "RDS storage size in GB"
  type        = number
  default     = 100
}

variable "db_engine_version" {
  description = "PostgreSQL engine version"
  type        = string
  default     = "16.3"
}

variable "db_backup_retention_days" {
  description = "RDS automated backup retention"
  type        = number
  default     = 14
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention"
  type        = number
  default     = 90
}

variable "tags" {
  description = "Tags applied to every resource"
  type        = map(string)
  default = {
    "ManagedBy" = "Terraform"
    "Recipe"    = "mirth-connect-cookbook-48"
  }
}
