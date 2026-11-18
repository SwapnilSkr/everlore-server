import { Elysia } from 'elysia'
import { adminRelease, announce, saveRelease } from '../services/app-release.service'
import {
  adminReleaseNote,
  listReleaseNotes,
  publishReleaseNote,
  saveReleaseNote,
} from '../services/release-notes.service'

/**
 * `/admin/app-release` and `/admin/release-notes` — the console's Releases page
 * (`everlore-docs/phases/update-nudge.md`, "Server contract" and part 2 A and B).
 *
 * Deliberately declared with full paths and **without** the `/admin` prefix and
 * **without** a guard: this instance is mounted inside `adminRoutes`, which
 * carries both. Elysia hooks are local by default, so a guard put here would
 * protect nothing. `scripts/update-nudge-audit.ts` and
 * `scripts/whats-new-audit.ts` mount it the way the router does and prove every
 * route refuses an unauthenticated caller.
 */
export const adminReleaseRoutes = new Elysia()
  .get('/app-release', () => adminRelease())

  .put('/app-release', ({ body }: { body: unknown }) => saveRelease(body))

  .post('/app-release/announce', ({ body, adminUser }: { body: unknown; adminUser?: string }) =>
    announce(body, adminUser || 'admin'))

  .get('/release-notes', () => listReleaseNotes())

  .get('/release-notes/:build', ({ params }: { params: { build: string } }) =>
    adminReleaseNote(params.build))

  .put('/release-notes/:build', ({ params, body }: { params: { build: string }; body: unknown }) =>
    saveReleaseNote(params.build, body))

  .post('/release-notes/:build/publish', ({ params, body }: { params: { build: string }; body: unknown }) =>
    publishReleaseNote(params.build, body))
