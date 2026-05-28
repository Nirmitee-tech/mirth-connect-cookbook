# Recipe #48 — Mirth Connect on AWS — ECS Fargate + RDS Multi-AZ + ALB + NLB
# Tested on Mirth Connect 4.5.2
# Author: Nirmitee.io | License: MIT

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.40"
    }
    random = {
      source  = "hashicorp/random"
      version = ">= 3.5"
    }
  }
}

locals {
  common_tags = merge(var.tags, {
    Name        = var.name
    Environment = var.environment
  })

  name_prefix = "${var.name}-${var.environment}"
}

# -----------------------------------------------------------------------------
# KMS — encrypt RDS, S3, secrets, CloudWatch Logs with a customer-managed key
# -----------------------------------------------------------------------------
resource "aws_kms_key" "mirth" {
  description             = "${local.name_prefix} encryption key (HIPAA — encrypt PHI at rest)"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  tags                    = local.common_tags
}

resource "aws_kms_alias" "mirth" {
  name          = "alias/${local.name_prefix}"
  target_key_id = aws_kms_key.mirth.id
}

# -----------------------------------------------------------------------------
# Secrets Manager — DB credentials (auto-rotated by RDS)
# -----------------------------------------------------------------------------
resource "random_password" "db" {
  length  = 32
  special = false
}

resource "aws_secretsmanager_secret" "db" {
  name                    = "${local.name_prefix}/db-credentials"
  kms_key_id              = aws_kms_key.mirth.arn
  recovery_window_in_days = 7
  tags                    = local.common_tags
}

resource "aws_secretsmanager_secret_version" "db" {
  secret_id = aws_secretsmanager_secret.db.id
  secret_string = jsonencode({
    username = "mirthadmin"
    password = random_password.db.result
  })
}

# -----------------------------------------------------------------------------
# S3 — attachments bucket (Mirth attachment storage redirect target)
# -----------------------------------------------------------------------------
resource "aws_s3_bucket" "attachments" {
  bucket        = "${local.name_prefix}-attachments-${data.aws_caller_identity.current.account_id}"
  force_destroy = false
  tags          = local.common_tags
}

resource "aws_s3_bucket_server_side_encryption_configuration" "attachments" {
  bucket = aws_s3_bucket.attachments.id
  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.mirth.arn
      sse_algorithm     = "aws:kms"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_versioning" "attachments" {
  bucket = aws_s3_bucket.attachments.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "attachments" {
  bucket                  = aws_s3_bucket.attachments.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "attachments" {
  bucket = aws_s3_bucket.attachments.id
  rule {
    id     = "abort-incomplete-multipart"
    status = "Enabled"
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

data "aws_caller_identity" "current" {}

# -----------------------------------------------------------------------------
# Security groups (least-privilege)
# -----------------------------------------------------------------------------
resource "aws_security_group" "alb" {
  name        = "${local.name_prefix}-alb"
  description = "Mirth admin ALB"
  vpc_id      = var.vpc_id
  tags        = local.common_tags
}

resource "aws_security_group_rule" "alb_ingress" {
  type              = "ingress"
  security_group_id = aws_security_group.alb.id
  from_port         = 443
  to_port           = 443
  protocol          = "tcp"
  cidr_blocks       = var.ingress_allowed_cidrs
  description       = "Admin HTTPS"
}

resource "aws_security_group_rule" "alb_egress" {
  type              = "egress"
  security_group_id = aws_security_group.alb.id
  from_port         = 0
  to_port           = 0
  protocol          = "-1"
  cidr_blocks       = ["0.0.0.0/0"]
}

resource "aws_security_group" "ecs" {
  name        = "${local.name_prefix}-ecs"
  description = "Mirth ECS tasks"
  vpc_id      = var.vpc_id
  tags        = local.common_tags
}

resource "aws_security_group_rule" "ecs_admin_from_alb" {
  type                     = "ingress"
  security_group_id        = aws_security_group.ecs.id
  source_security_group_id = aws_security_group.alb.id
  from_port                = 8443
  to_port                  = 8443
  protocol                 = "tcp"
  description              = "Admin HTTPS from ALB"
}

resource "aws_security_group_rule" "ecs_mllp_ingress" {
  for_each          = toset([for p in var.mllp_ports : tostring(p)])
  type              = "ingress"
  security_group_id = aws_security_group.ecs.id
  from_port         = tonumber(each.value)
  to_port           = tonumber(each.value)
  protocol          = "tcp"
  cidr_blocks       = length(var.mllp_allowed_cidrs) > 0 ? var.mllp_allowed_cidrs : var.ingress_allowed_cidrs
  description       = "MLLP ${each.value} from EHR networks"
}

resource "aws_security_group_rule" "ecs_egress" {
  type              = "egress"
  security_group_id = aws_security_group.ecs.id
  from_port         = 0
  to_port           = 0
  protocol          = "-1"
  cidr_blocks       = ["0.0.0.0/0"]
}

resource "aws_security_group" "rds" {
  name        = "${local.name_prefix}-rds"
  description = "Mirth RDS PostgreSQL"
  vpc_id      = var.vpc_id
  tags        = local.common_tags
}

resource "aws_security_group_rule" "rds_from_ecs" {
  type                     = "ingress"
  security_group_id        = aws_security_group.rds.id
  source_security_group_id = aws_security_group.ecs.id
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
  description              = "PostgreSQL from Mirth tasks"
}

# -----------------------------------------------------------------------------
# RDS PostgreSQL Multi-AZ
# -----------------------------------------------------------------------------
resource "aws_db_subnet_group" "this" {
  name       = "${local.name_prefix}-rds"
  subnet_ids = var.private_subnet_ids
  tags       = local.common_tags
}

resource "aws_db_parameter_group" "this" {
  name   = "${local.name_prefix}-pg"
  family = "postgres16"

  parameter {
    name  = "log_statement"
    value = "ddl"
  }
  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }
  tags = local.common_tags
}

resource "aws_db_instance" "this" {
  identifier                          = "${local.name_prefix}-pg"
  engine                              = "postgres"
  engine_version                      = var.db_engine_version
  instance_class                      = var.db_instance_class
  allocated_storage                   = var.db_allocated_storage_gb
  max_allocated_storage               = var.db_allocated_storage_gb * 4
  storage_type                        = "gp3"
  storage_encrypted                   = true
  kms_key_id                          = aws_kms_key.mirth.arn
  multi_az                            = true
  db_name                             = "mirthdb"
  username                            = "mirthadmin"
  password                            = random_password.db.result
  db_subnet_group_name                = aws_db_subnet_group.this.name
  vpc_security_group_ids              = [aws_security_group.rds.id]
  parameter_group_name                = aws_db_parameter_group.this.name
  backup_retention_period             = var.db_backup_retention_days
  backup_window                       = "03:00-04:00"
  maintenance_window                  = "sun:04:30-sun:05:30"
  deletion_protection                 = var.environment == "prod"
  skip_final_snapshot                 = var.environment != "prod"
  final_snapshot_identifier           = var.environment == "prod" ? "${local.name_prefix}-pg-final-${formatdate("YYYYMMDDhhmm", timestamp())}" : null
  performance_insights_enabled        = true
  performance_insights_kms_key_id     = aws_kms_key.mirth.arn
  performance_insights_retention_period = 7
  enabled_cloudwatch_logs_exports     = ["postgresql", "upgrade"]
  iam_database_authentication_enabled = true
  copy_tags_to_snapshot               = true
  tags                                = local.common_tags

  lifecycle {
    ignore_changes = [final_snapshot_identifier, password]
  }
}

# -----------------------------------------------------------------------------
# CloudWatch Logs
# -----------------------------------------------------------------------------
resource "aws_cloudwatch_log_group" "mirth" {
  name              = "/ecs/${local.name_prefix}"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.mirth.arn
  tags              = local.common_tags
}

# -----------------------------------------------------------------------------
# IAM — ECS task execution + task roles
# -----------------------------------------------------------------------------
data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${local.name_prefix}-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
  tags               = local.common_tags
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution_extras" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.db.arn]
  }
  statement {
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.mirth.arn]
  }
}

resource "aws_iam_role_policy" "execution_extras" {
  name   = "${local.name_prefix}-execution-extras"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_extras.json
}

resource "aws_iam_role" "task" {
  name               = "${local.name_prefix}-ecs-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
  tags               = local.common_tags
}

data "aws_iam_policy_document" "task_extras" {
  statement {
    actions = [
      "s3:PutObject",
      "s3:GetObject",
      "s3:DeleteObject",
      "s3:ListBucket"
    ]
    resources = [
      aws_s3_bucket.attachments.arn,
      "${aws_s3_bucket.attachments.arn}/*"
    ]
  }
  statement {
    actions   = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.mirth.arn]
  }
  statement {
    actions   = ["rds-db:connect"]
    resources = ["arn:aws:rds-db:*:*:dbuser:${aws_db_instance.this.resource_id}/mirthadmin"]
  }
}

resource "aws_iam_role_policy" "task_extras" {
  name   = "${local.name_prefix}-task-extras"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task_extras.json
}

# -----------------------------------------------------------------------------
# ECS Cluster + Service + Task Definition
# -----------------------------------------------------------------------------
resource "aws_ecs_cluster" "this" {
  name = "${local.name_prefix}-cluster"
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
  tags = local.common_tags
}

resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name       = aws_ecs_cluster.this.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
    base              = var.desired_count
  }
}

resource "aws_ecs_task_definition" "mirth" {
  family                   = "${local.name_prefix}-task"
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  tags                     = local.common_tags

  container_definitions = jsonencode([
    {
      name      = "mirth"
      image     = "${var.mirth_image}:${var.mirth_image_tag}"
      essential = true
      portMappings = concat(
        [{ containerPort = 8443, protocol = "tcp" }],
        [for p in var.mllp_ports : { containerPort = p, protocol = "tcp" }]
      )
      environment = [
        { name = "DATABASE", value = "postgres" },
        { name = "DATABASE_URL", value = "jdbc:postgresql://${aws_db_instance.this.endpoint}/mirthdb" },
        { name = "VMOPTIONS", value = "-Xms1024m -Xmx${var.jvm_heap_mb}m -XX:+UseG1GC" },
        { name = "S3_ATTACHMENT_BUCKET", value = aws_s3_bucket.attachments.bucket }
      ]
      secrets = [
        { name = "DATABASE_USERNAME", valueFrom = "${aws_secretsmanager_secret.db.arn}:username::" },
        { name = "DATABASE_PASSWORD", valueFrom = "${aws_secretsmanager_secret.db.arn}:password::" }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.mirth.name
          awslogs-region        = data.aws_region.current.name
          awslogs-stream-prefix = "mirth"
        }
      }
      healthCheck = {
        command     = ["CMD-SHELL", "curl -skf https://localhost:8443/api/server/version || exit 1"]
        interval    = 30
        timeout     = 10
        retries     = 3
        startPeriod = 120
      }
    }
  ])
}

data "aws_region" "current" {}

resource "aws_ecs_service" "mirth" {
  name                              = "${local.name_prefix}-svc"
  cluster                           = aws_ecs_cluster.this.id
  task_definition                   = aws_ecs_task_definition.mirth.arn
  desired_count                     = var.desired_count
  launch_type                       = "FARGATE"
  health_check_grace_period_seconds = 180
  enable_execute_command            = true

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.ecs.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.admin.arn
    container_name   = "mirth"
    container_port   = 8443
  }

  dynamic "load_balancer" {
    for_each = aws_lb_target_group.mllp
    content {
      target_group_arn = load_balancer.value.arn
      container_name   = "mirth"
      container_port   = tonumber(load_balancer.key)
    }
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  depends_on = [aws_lb_listener.admin_https, aws_lb_listener.mllp]
  tags       = local.common_tags
}

# -----------------------------------------------------------------------------
# ALB — admin HTTPS
# -----------------------------------------------------------------------------
resource "aws_lb" "admin" {
  name               = "${local.name_prefix}-alb"
  load_balancer_type = "application"
  internal           = true
  security_groups    = [aws_security_group.alb.id]
  subnets            = var.private_subnet_ids
  tags               = local.common_tags

  drop_invalid_header_fields = true
  enable_deletion_protection = var.environment == "prod"
}

resource "aws_lb_target_group" "admin" {
  name        = "${local.name_prefix}-admin-tg"
  port        = 8443
  protocol    = "HTTPS"
  target_type = "ip"
  vpc_id      = var.vpc_id

  health_check {
    path                = "/api/server/version"
    protocol            = "HTTPS"
    matcher             = "200"
    interval            = 30
    timeout             = 10
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
  tags = local.common_tags
}

resource "aws_lb_listener" "admin_https" {
  load_balancer_arn = aws_lb.admin.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.admin_acm_certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.admin.arn
  }
}

# -----------------------------------------------------------------------------
# NLB — MLLP TCP listeners
# -----------------------------------------------------------------------------
resource "aws_lb" "mllp" {
  name               = "${local.name_prefix}-nlb"
  load_balancer_type = "network"
  internal           = true
  subnets            = var.private_subnet_ids
  tags               = local.common_tags

  enable_deletion_protection       = var.environment == "prod"
  enable_cross_zone_load_balancing = true
}

resource "aws_lb_target_group" "mllp" {
  for_each    = toset([for p in var.mllp_ports : tostring(p)])
  name        = "${local.name_prefix}-mllp-${each.value}"
  port        = tonumber(each.value)
  protocol    = "TCP"
  target_type = "ip"
  vpc_id      = var.vpc_id

  health_check {
    protocol            = "TCP"
    port                = "8443"
    interval            = 30
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
  tags = local.common_tags
}

resource "aws_lb_listener" "mllp" {
  for_each          = aws_lb_target_group.mllp
  load_balancer_arn = aws_lb.mllp.arn
  port              = tonumber(each.key)
  protocol          = "TCP"

  default_action {
    type             = "forward"
    target_group_arn = each.value.arn
  }
}

# -----------------------------------------------------------------------------
# CloudWatch Alarms
# -----------------------------------------------------------------------------
resource "aws_cloudwatch_metric_alarm" "task_cpu" {
  alarm_name          = "${local.name_prefix}-task-cpu-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "CPUUtilization"
  namespace           = "AWS/ECS"
  period              = 60
  statistic           = "Average"
  threshold           = 80
  alarm_description   = "Mirth ECS task CPU above 80%"
  dimensions = {
    ClusterName = aws_ecs_cluster.this.name
    ServiceName = aws_ecs_service.mirth.name
  }
  tags = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "rds_cpu" {
  alarm_name          = "${local.name_prefix}-rds-cpu-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "CPUUtilization"
  namespace           = "AWS/RDS"
  period              = 60
  statistic           = "Average"
  threshold           = 80
  alarm_description   = "Mirth RDS CPU above 80%"
  dimensions = {
    DBInstanceIdentifier = aws_db_instance.this.id
  }
  tags = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "rds_storage" {
  alarm_name          = "${local.name_prefix}-rds-storage-low"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  metric_name         = "FreeStorageSpace"
  namespace           = "AWS/RDS"
  period              = 300
  statistic           = "Average"
  threshold           = 10737418240 # 10 GB
  alarm_description   = "Mirth RDS free storage below 10 GB"
  dimensions = {
    DBInstanceIdentifier = aws_db_instance.this.id
  }
  tags = local.common_tags
}
