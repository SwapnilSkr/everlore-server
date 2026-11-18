import { Elysia } from 'elysia'
import { publicRelease } from '../services/app-release.service'
import { publicReleaseNote } from '../services/release-notes.service'

/**
 * What the app asks before it decides anything
 * (`everlore-docs/phases/update-nudge.md`, "Server contract" and part 2 B).
 *
 * Public on purpose: the must-update screen comes before sign-in, so a guest
 * asks this too. `GET /app/release` is exactly the five agreed fields — Play is
 * what decides whether an update exists, so there is nothing else to say.
 * `GET /app/whats-new/:build` is a published note or a 404; a draft never
 * reaches a player.
 *
 * Five minutes of caching is the contract's own number: a release changes about
 * once a week, and the app checks at start, after sign-in and on a long resume.
 */
export const appReleaseRoutes = new Elysia({ prefix: '/app' })
  .get('/release', async ({ set }) => {
    set.headers['cache-control'] = 'max-age=300'
    return publicRelease()
  })

  .get('/whats-new/:build', ({ params }: { params: { build: string } }) => publicReleaseNote(params.build))
