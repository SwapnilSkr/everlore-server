# Everlore AWS day-1 ops notes
#
# Elastic IP (stable across deploys — not Fargate/ECS):
#   52.66.17.198
#
# Porkbun A record:
#   Host: api
#   Type: A
#   Value: 52.66.17.198
#   Domain: everloreapp.com  →  api.everloreapp.com
#
# After DNS propagates:
#   ssh -i ~/.ssh/everlore-prod.pem ec2-user@52.66.17.198
#   sudo systemctl start caddy
#   # Caddy obtains Let's Encrypt cert for api.everloreapp.com
#
# Seed /etc/everlore/env (once), then:
#   sudo systemctl restart everlore-api everlore-worker
#
# GitHub Actions secrets (repo SwapnilSkr/everlore-server):
#   EC2_HOST = 52.66.17.198
#   EC2_SSH_KEY = contents of ~/.ssh/everlore-prod.pem
#
# Atlas Network Access: allowlist 52.66.17.198/32
#
# Stack: everlore-prod (CloudFormation, ap-south-1)
# Soft AWS ceiling: $12/mo (budget alarm email: swapnilmkab@gmail.com)
