import { Elysia } from 'elysia'
import { publicRelease } from '../services/app-release.service'

/**
 * `GET /app/release` — what the app asks before it decides anything
 * (`everlore-docs/phases/update-nudge.md`, "Server contract").
 *
 * Public on purpose: the must-update screen comes before sign-in, so a guest
 * asks this too. The payload is exactly the five agreed fields — Play is what
 * decides whether an update exists, so there is nothing else to say.
 *
 * Five minutes of caching is the contract's own number: a release changes about
 * once a week, and the app checks at start, after sign-in and on a long resume.
 */
export const appReleaseRoutes = new Elysia({ prefix: '/app' })
  .get('/release', async ({ set }) => {
    set.headers['cache-control'] = 'max-age=300'
    return publicRelease()
  })
