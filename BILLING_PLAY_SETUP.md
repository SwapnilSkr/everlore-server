# Google Play billing setup

> **Canonical product / API docs:** [everlore-docs/server/BILLING.md](../everlore-docs/server/BILLING.md)
> (ledger, catalog, reserve/settle, RTDN, env flags). This file is the Play Console
> + credentials checklist only.

The application code is intentionally safe-by-default: Story Ink enforcement
stays off until the Google Play products and verification credentials are live.
Set `BILLING_ENFORCEMENT_ENABLED=true` only after completing the setup below.

## Play Console catalog

Create these exact product IDs. The mobile app gets the localized, tax-inclusive
price directly from Google Play; never put a price in the app or API.

| Type | Product IDs |
| --- | --- |
| Subscription | `everlore_premium`, `everlore_creator` |
| Consumable one-time product | `everlore_ink_100`, `everlore_ink_350`, `everlore_ink_900` |

Give each subscription an active monthly base plan. Configure the USD anchor
price and use Play Console's country pricing override for India (INR). Google
will display the appropriate local currency elsewhere.

## Server verification

1. Enable **Google Play Android Developer API** in the Google Cloud project
   linked to the Play developer account.
2. Create a service account, grant it the minimum Play Console financial/order
   permissions needed to read and acknowledge purchases, then save its JSON as
   a deployment secret.
3. Set these server environment variables:

```text
GOOGLE_PLAY_PACKAGE_NAME=com.everloreapp
GOOGLE_PLAY_SERVICE_ACCOUNT_JSON={...service account JSON...}
BILLING_ENFORCEMENT_ENABLED=true
```

The API verifies every client purchase token with Google before it grants an
entitlement or Ink. Tokens are unique to one Everlore account; do not move the
service-account JSON into the Flutter client.

## Renewal and cancellation updates (RTDN)

Configure Real-time developer notifications in Play Console to publish to a
Pub/Sub topic, then create an authenticated push subscription to:

```text
POST https://<api-host>/billing/google/rtdn
```

Use a Google service account as the push identity and configure:

```text
GOOGLE_PLAY_RTDN_AUDIENCE=https://<api-host>/billing/google/rtdn
GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL=<push-service-account-email>
```

RTDN updates a purchase only after its first verified client claim has linked
the token to an Everlore account. This prevents an unauthenticated notification
from guessing account ownership.

## Test before launch

Use an internal testing track and license-test accounts. Confirm each path:

- first subscription grants its monthly Ink exactly once;
- renewal/cancellation/refund notification updates the active tier;
- a consumable is granted once and then consumed/acknowledged;
- a failed pre-token generation refunds its reservation;
- a successful or visible-stream generation settles its reservation once.
- a test refund/voided purchase reverses the granted consumable Ink once.

Keep enforcement disabled in non-production environments unless test products
and the matching package name are configured there.

## Local/internal simulated checkout

For a UI-to-ledger QA run before Play Console is live, set these only on a
local or internal environment:

```text
NODE_ENV=development
BILLING_ENFORCEMENT_ENABLED=true
BILLING_SIMULATION_ENABLED=true
```

The Membership screen will then label checkout as **Test checkout — no charge**.
Selecting a plan or Ink pack creates a simulated entitlement or ledger grant;
normal turns immediately deduct from that balance. This endpoint is hard-blocked
when `NODE_ENV=production`, even if the simulation flag is accidentally set.

## Support, QA, and promotional Ink

An authenticated administrator can issue an auditable, idempotent grant at any
time — before or after Play launches — without pretending that it came from a
store purchase:

```text
POST /admin/users/:userId/ink-grants
Authorization: Basic <admin credentials>

{
  "amount": 250000,
  "idempotency_key": "qa-creator-initial-grant-2026-07",
  "note": "Founder QA account"
}
```

The maximum is 1,000,000 Ink per grant. Reusing the same idempotency key for
the same player is safe and does not mint Ink twice. The player's **Membership
& Ink** screen reflects the new ledger balance immediately on refresh.
