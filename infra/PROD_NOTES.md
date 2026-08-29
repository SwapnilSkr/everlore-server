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
#
# ── Production environment invariants (/etc/everlore/env) ────────────────
#
# NODE_ENV=production
#   Not optional. billingService.enforcementEnabled() only auto-arms when
#   NODE_ENV is production AND Play credentials are configured, and
#   simulationEnabled() refuses a simulated checkout on the same signal. With
#   NODE_ENV unset, a public build could keep serving free entitlements after
#   Play products go live, and the simulation kill-switch is inert.
#
# CLIENT_ORIGINS
#   https://everloreapp.com,https://www.everloreapp.com,https://api.everloreapp.com
#   No localhost entries in production — CORS is the only thing standing
#   between a hostile page and an authenticated browser session.
#
# TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_VERIFY_SERVICE_SID
#   Must be the real Verify credentials. providers/auth.provider.ts falls into
#   mock mode when any of the three is blank or the SID is AC_MOCK_SID, and in
#   mock mode `123456` is accepted as the OTP for ANY phone number. A
#   production deploy that loses these variables silently becomes an open
#   account-takeover endpoint, so treat them as a required, not optional, set.
#
# DISABLE_OTP_RATE_LIMIT=false, BILLING_SIMULATION_ENABLED=false
#   Both are local-development affordances. Neither belongs on in production.
#
# ── Release app builds ──────────────────────────────────────────────────
#
# The bundled Flutter .env carries localhost dev URLs, and AppConfig throws on
# a plaintext endpoint in release mode, so a release build MUST override both:
#
#   flutter build appbundle --release \
#     --dart-define=API_BASE_URL=https://api.everloreapp.com \
#     --dart-define=WS_BASE_URL=wss://api.everloreapp.com
#
# GUIDE_REHEARSAL needs no override: AppConfig.guideRehearsal returns false
# unconditionally under kReleaseMode.
#
# REVIEW_DEMO_PHONE / REVIEW_DEMO_OTP
#   The Google Play reviewer's sign-in. Play will not review an app it cannot
#   get into, reviewers cannot receive our OTP SMS, and Everlore has no other
#   credential to hand them — so this is a deliberate, fenced bypass for one
#   number (see providers/auth.provider.ts and `bun run audit:review-access`).
#   Rotate REVIEW_DEMO_OTP like a password, keep it out of git, and unset both
#   variables once there is a sign-in path a reviewer can use unaided.
