import { Elysia } from 'elysia'
import { requireAdmin } from '../middleware/admin-auth'
import { adminHealthService } from '../services/admin-health.service'
import { adminOverviewSummaryService } from '../services/admin-overview-summary.service'

/**
 * Overview and System pages. Both routes are declared on the same instance that
 * takes the guard: Elysia hooks are `local` unless declared `scoped`, and
 * `requireAdmin`'s scope reaches the router that mounts it — not routes put on
 * some other instance. One `local` slip here and the whole admin API is public.
 */
export const adminOverviewRoutes = new Elysia({ prefix: '/admin' })
  .use(requireAdmin)
  .get('/system/health', () => adminHealthService.health())
  .get('/overview/summary', () => adminOverviewSummaryService.summary())
