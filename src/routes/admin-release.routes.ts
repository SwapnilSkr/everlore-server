import { Elysia } from 'elysia'
import { adminRelease, announce, saveRelease } from '../services/app-release.service'

/**
 * `/admin/app-release` — the console's Releases page
 * (`everlore-docs/phases/update-nudge.md`, "Server contract").
 *
 * Deliberately declared with full paths and **without** the `/admin` prefix and
 * **without** a guard: this instance is mounted inside `adminRoutes`, which
 * carries both. Elysia hooks are local by default, so a guard put here would
 * protect nothing. `scripts/update-nudge-audit.ts` mounts it the way the router
 * does and proves every route refuses an unauthenticated caller.
 */
export const adminReleaseRoutes = new Elysia()
  .get('/app-release', () => adminRelease())

  .put('/app-release', ({ body }: { body: unknown }) => saveRelease(body))

  .post('/app-release/announce', ({ body, adminUser }: { body: unknown; adminUser?: string }) =>
    announce(body, adminUser || 'admin'))
