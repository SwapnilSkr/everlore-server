import { Elysia } from 'elysia'
import { rateLimit } from '../middleware/rate-limit'
import { webEventService } from '../services/web-event.service'

/**
 * The marketing site's beacon.
 *
 * Unauthenticated on purpose — the sender is a stranger on a landing page — and
 * therefore deliberately dull: it accepts a small text body, answers 204 to
 * everything, and never says whether the event was kept. `navigator.sendBeacon`
 * cannot read a response anyway, so there is nothing to gain from a richer
 * reply and something to lose in telling a script how to get past the filter.
 *
 * Text/plain rather than JSON is what makes it a CORS "simple request": no
 * preflight, so a click that navigates away still lands.
 */
export const webEventRoutes = new Elysia({ prefix: '/events' }).post(
  '/web',
  async ({ request, server, headers, set }) => {
    set.status = 204

    // Throttled by address. Spoofable, so this is a cost, not a gate — and the
    // worst case is a padded count, not a leak.
    const caller =
      headers['x-forwarded-for']?.split(',')[0]?.trim() ||
      server?.requestIP?.(request)?.address ||
      'unknown'

    try {
      const { allowed } = await rateLimit(caller, 'web_event')
      if (!allowed) return
    } catch {
      // Redis down is not a reason to lose the page's events.
    }

    let payload: unknown
    try {
      const raw = await request.text()
      if (!raw || raw.length > 2048) return
      payload = JSON.parse(raw)
    } catch {
      return
    }

    await webEventService.record(payload)
  },
)
