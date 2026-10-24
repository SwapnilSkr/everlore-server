import { Elysia, t } from 'elysia'
import { analyticsService } from '../services/telemetry/analytics.service'
import { readPlayVitals } from '../services/play-vitals.service'

/**
 * `/admin/analytics` — the Product pages (`everlore-docs/phases/analytics.md` §4.6).
 *
 * Deliberately **without** the `/admin` prefix and **without** a guard: this
 * instance is mounted inside `adminRoutes`, which carries both. That is the
 * console's convention (`admin-overview.routes.ts`), and it is the one place a
 * missing guard would be invisible — Elysia hooks are local by default, so a
 * guard declared here would protect nothing. `scripts/telemetry-admin-audit.ts`
 * mounts this the same way the router does and proves every route refuses an
 * unauthenticated caller.
 */

const DaysQuery = t.Object({
  days: t.Optional(t.String()),
  version: t.Optional(t.String()),
})

const SessionQuery = t.Object({
  user_id: t.Optional(t.String()),
  install_id: t.Optional(t.String()),
  dropped_at: t.Optional(t.String()),
  limit: t.Optional(t.String()),
  before: t.Optional(t.String()),
})

const ErrorsQuery = t.Object({
  view: t.Optional(t.String()),
  days: t.Optional(t.String()),
})

/**
 * §4.6 PATCH body. Bounds are enforced here so an over-long sentence is a
 * validation refusal rather than something stored; "at least one field" is a
 * business rule and lives in the service, which answers 400 with a sentence.
 */
const ErrorPatchBody = t.Object({
  status: t.Optional(t.Union([
    t.Literal('new'),
    t.Literal('confirmed'),
    t.Literal('resolved'),
    t.Literal('ignored'),
  ])),
  explanation: t.Optional(t.String({ minLength: 1, maxLength: 300 })),
  note: t.Optional(t.String({ minLength: 1, maxLength: 500 })),
})

export const adminAnalyticsRoutes = new Elysia({ prefix: '/analytics' })
  .get('/funnel', (ctx: { query: { days?: string } }) => analyticsService.funnel(ctx.query.days), {
    query: t.Object({ days: t.Optional(t.String()) }),
  })

  .get('/sessions', (ctx: { query: {
    user_id?: string
    install_id?: string
    dropped_at?: string
    limit?: string
    before?: string
  } }) => analyticsService.sessions(ctx.query), { query: SessionQuery })

  .get('/sessions/:sessionId', (ctx: { params: { sessionId: string } }) =>
    analyticsService.session(ctx.params.sessionId))

  .get('/screens', (ctx: { query: { days?: string; version?: string } }) =>
    analyticsService.screens(ctx.query.days, ctx.query.version || undefined), { query: DaysQuery })

  .get('/actions', (ctx: { query: { days?: string } }) => analyticsService.actions(ctx.query.days), {
    query: t.Object({ days: t.Optional(t.String()) }),
  })

  .get('/errors', (ctx: { query: { view?: string; days?: string } }) =>
    analyticsService.errors(ctx.query.view, ctx.query.days), { query: ErrorsQuery })

  .get('/errors/:fp', (ctx: { params: { fp: string } }) => analyticsService.errorDetail(ctx.params.fp))

  .patch('/errors/:fp', (ctx: {
    params: { fp: string }
    body: { status?: 'new' | 'confirmed' | 'resolved' | 'ignored'; explanation?: string; note?: string }
    adminUser?: string
  }) => analyticsService.patchError(ctx.params.fp, ctx.body, ctx.adminUser), { body: ErrorPatchBody })

  .post('/errors/:fp/triage', (ctx: { params: { fp: string } }) =>
    analyticsService.retriage(ctx.params.fp))

  .get('/counters', (ctx: { query: { days?: string } }) => analyticsService.counters(ctx.query.days), {
    query: t.Object({ days: t.Optional(t.String()) }),
  })

  .get('/vitals', () => readPlayVitals())
