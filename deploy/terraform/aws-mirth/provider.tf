# Recipe #48 — Mock provider for `terraform validate` / `tflint`
# In real usage, the calling module supplies the AWS provider.
# Author: Nirmitee.io | License: MIT

provider "aws" {
  region                      = "us-east-1"
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_region_validation      = true
  s3_use_path_style           = true

  default_tags {
    tags = {
      Project = "mirth-connect-cookbook"
      Recipe  = "48"
    }
  }
}
