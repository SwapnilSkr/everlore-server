import { Elysia } from 'elysia'
import { authPlugin } from '../middleware/auth'
import { rateLimit } from '../middleware/rate-limit'
import { telemetryService } from '../services/telemetry/ingest.service'
import { parseEnvelope } from '../services/telemetry/schema'

/**
 * §4.1 — `POST /app/telemetry`, the app's only telemetry route.
 *
 * Deliberately dull, like the marketing beacon: it answers with a count and
 * never explains a drop. The differences from the beacon are the ones the
 * contract needs:
 *
 *   - **Optional auth.** Most of what matters happens before there is an
 *     account, so a batch is accepted with no token; a valid one links the
 *     batch, and the install, to the player.
 *   - **A real body cap.** 64 KB, checked before parsing. The handler never
 *     touches Elysia's `body`, so the framework's lazy parser never runs and the
 *     raw stream is still ours to read — the same way `web-event.routes.ts`
 *     avoids a body schema.
 *   - **429 with `Retry-After`**, because unlike a beacon the app must keep its
 *     queue and come back.
 *
 * The address is used for the per-IP limit and is never stored.
 */
const MAX_BODY_BYTES = 64 * 1024

export const telemetryRoutes = new Elysia({ prefix: '/app' })
  .use(authPlugin)
  .post('/telemetry', async ({ request, headers, server, set, user }) => {
    set.status = 202

    const declared = Number(headers['content-length'] ?? Number.NaN)
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      set.status = 413
      return { error: 'Payload too large' }
    }

    let raw: string
    try {
      raw = await request.text()
    } catch {
      set.status = 400
      return { error: 'Bad request' }
    }

    // Bytes, not UTF-16 units: one emoji is four of these and one of those.
    if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
      set.status = 413
      return { error: 'Payload too large' }
    }

    let payload: unknown
    try {
      payload = JSON.parse(raw)
    } catch {
      set.status = 400
      return { error: 'Bad request' }
    }

    const batch = parseEnvelope(payload)
    if (!batch) {
      set.status = 400
      return { error: 'Bad request' }
    }

    // Spoofable, so a cost rather than a gate — the same standing as the beacon's.
    // Redis being down must not lose the batch, so a failure here is "allowed".
    const address =
      headers['x-forwarded-for']?.split(',')[0]?.trim() ||
      server?.requestIP?.(request)?.address ||
      'unknown'

    let retryAfter = 0
    try {
      const byAddress = await rateLimit(address, 'telemetry_ip')
      if (!byAddress.allowed) retryAfter = Math.max(retryAfter, byAddress.retryAfter ?? 0)
      const byInstall = await rateLimit(batch.install_id, 'telemetry_install')
      if (!byInstall.allowed) retryAfter = Math.max(retryAfter, byInstall.retryAfter ?? 0)
    } catch {
      // no limit service, no limit
    }

    if (retryAfter > 0) {
      set.status = 429
      set.headers['retry-after'] = String(retryAfter)
      return { error: 'Too many requests' }
    }

    const accepted = await telemetryService.ingest(batch, user?.id ?? null)
    return { accepted }
  })
