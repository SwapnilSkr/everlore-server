import { Elysia, t } from 'elysia'
import { requireAdmin } from '../middleware/admin-auth'
import { adminHealthService } from '../services/admin-health.service'
import { adminOverviewSummaryService } from '../services/admin-overview-summary.service'
import { accountFilter } from '../services/reviewer-accounts'

/**
 * Overview and System pages. Both routes are declared on the same instance that
 * takes the guard: Elysia hooks are `local` unless declared `scoped`, and
 * `requireAdmin`'s scope reaches the router that mounts it — not routes put on
 * some other instance. One `local` slip here and the whole admin API is public.
 */
export const adminOverviewRoutes = new Elysia({ prefix: '/admin' })
  .use(requireAdmin)
  .get('/system/health', () => adminHealthService.health())
  .get('/overview/summary', (ctx: { query: { show?: string; only?: string; reviewers?: string } }) =>
    adminOverviewSummaryService.summary(
      new Date(),
      undefined,
      accountFilter(ctx.query.show, ctx.query.only, ctx.query.reviewers),
    ), {
    query: t.Object({
      show: t.Optional(t.String()),
      only: t.Optional(t.String()),
      reviewers: t.Optional(t.String()),
    }),
  })
