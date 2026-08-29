import { Elysia, t } from 'elysia'
import { AdminSetTierBody, AdminSetUserStatusBody } from '../schemas/user.schema'
import { adminController } from '../controllers/admin.controller'
import { requireAdmin } from '../middleware/admin-auth'
import {
  AdminReportQuery,
  AdminResolveReportBody,
  AdminWorldModerationBody,
} from '../schemas/moderation.schema'

const PageQuery = t.Object({
  page: t.Optional(t.Numeric({ minimum: 1 })),
  limit: t.Optional(t.Numeric({ minimum: 1, maximum: 200 })),
})

const SearchPageQuery = t.Composite([
  PageQuery,
  t.Object({
    search: t.Optional(t.String({ maxLength: 120 })),
  }),
])

const AdminPatchBody = t.Record(t.String(), t.Any())
const AdminGrantInkBody = t.Object({
  amount: t.Numeric({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  idempotency_key: t.String({ minLength: 1, maxLength: 120 }),
  note: t.Optional(t.String({ maxLength: 240 })),
})

export const adminRoutes = new Elysia({ prefix: '/admin' })
  .use(requireAdmin)

  .get('/overview', () => adminController.overview())

  .get('/users', (ctx) => adminController.listUsers(ctx), { query: SearchPageQuery })
  .get('/users/:userId', (ctx) => adminController.getUser(ctx))
  .patch('/users/:userId', (ctx) => adminController.patchUser(ctx), { body: AdminPatchBody })
  .patch('/users/:userId/tier', (ctx) => adminController.patchUserTier(ctx), {
    body: AdminSetTierBody,
  })
  .patch('/users/:userId/status', (ctx) => adminController.patchUserStatus(ctx), {
    body: AdminSetUserStatusBody,
  })
  .post('/users/:userId/ink-grants', (ctx) => adminController.grantUserInk(ctx), {
    body: AdminGrantInkBody,
  })
  .get('/users/:userId/billing', (ctx) => adminController.getUserBilling(ctx))
  .delete('/users/:userId', (ctx) => adminController.deleteUser(ctx))

  // Moderation queue. Reports are listed in triage order by default
  // (unresolved, critical first, oldest first) so the console opens on the
  // work that matters rather than on the newest noise.
  .get('/reports', (ctx) => adminController.listReports(ctx), { query: AdminReportQuery })
  .get('/reports/:reportId', (ctx) => adminController.getReport(ctx))
  .patch('/reports/:reportId', (ctx) => adminController.resolveReport(ctx), {
    body: AdminResolveReportBody,
  })
  .post('/reports/:reportId/reopen', (ctx) => adminController.reopenReport(ctx))

  .patch('/worlds/:worldId/moderation', (ctx) => adminController.patchWorldModeration(ctx), {
    body: AdminWorldModerationBody,
  })

  .get('/worlds', (ctx) => adminController.listWorlds(ctx), {
    query: t.Composite([
      SearchPageQuery,
      t.Object({
        creator_id: t.Optional(t.String()),
        published: t.Optional(t.Union([t.Boolean(), t.String()])),
      }),
    ]),
  })
  .get('/worlds/:worldId', (ctx) => adminController.getWorld(ctx))
  .patch('/worlds/:worldId', (ctx) => adminController.patchWorld(ctx), { body: AdminPatchBody })
  .delete('/worlds/:worldId', (ctx) => adminController.deleteWorld(ctx))

  .get('/instances', (ctx) => adminController.listInstances(ctx), {
    query: t.Composite([
      PageQuery,
      t.Object({
        player_id: t.Optional(t.String()),
        template_id: t.Optional(t.String()),
        archived: t.Optional(t.Union([t.Boolean(), t.String()])),
      }),
    ]),
  })
  .get('/instances/continuity-audits', (ctx) => adminController.listContinuityAuditStatus(ctx), {
    query: t.Composite([
      PageQuery,
      t.Object({
        status: t.Optional(t.Union([
          t.Literal('all'),
          t.Literal('healthy'),
          t.Literal('unhealthy'),
          t.Literal('missing'),
          t.Literal('stale'),
        ])),
        stale_days: t.Optional(t.Numeric({ minimum: 1, maximum: 365 })),
      }),
    ]),
  })
  .get('/instances/:instanceId', (ctx) => adminController.getInstance(ctx))
  // Cross-projection continuity audit (codex/entities/memories/summaries/cursors).
  .get('/instances/:instanceId/continuity-audit', (ctx) => adminController.getContinuityAudit(ctx))
  .patch('/instances/:instanceId', (ctx) => adminController.patchInstance(ctx), { body: AdminPatchBody })
  .delete('/instances/:instanceId', (ctx) => adminController.deleteInstance(ctx))

  .get('/events', (ctx) => adminController.listEvents(ctx), {
    query: t.Composite([
      PageQuery,
      t.Object({
        instance_id: t.Optional(t.String()),
        player_id: t.Optional(t.String()),
      }),
    ]),
  })
  // Projection inspection: every derived projection traceable to this event
  // (memories, entity edges, covering summaries, codex deltas, entities).
  .get('/events/:eventId/projections', (ctx) => adminController.getEventProjections(ctx))
  .patch('/events/:eventId', (ctx) => adminController.patchEvent(ctx), { body: AdminPatchBody })
  .delete('/events/:eventId', (ctx) => adminController.deleteEvent(ctx))

  .get('/memories', (ctx) => adminController.listMemories(ctx), {
    query: t.Composite([
      PageQuery,
      t.Object({
        instance_id: t.Optional(t.String()),
        player_id: t.Optional(t.String()),
      }),
    ]),
  })
  .patch('/memories/:memoryId', (ctx) => adminController.patchMemory(ctx), { body: AdminPatchBody })
  .delete('/memories/:memoryId', (ctx) => adminController.deleteMemory(ctx))

  .get('/characters', (ctx) => adminController.listCharacters(ctx), {
    query: t.Composite([
      PageQuery,
      t.Object({
        instance_id: t.Optional(t.String()),
      }),
    ]),
  })
  .patch('/characters/:characterId', (ctx) => adminController.patchCharacter(ctx), { body: AdminPatchBody })
  .delete('/characters/:characterId', (ctx) => adminController.deleteCharacter(ctx))

  .get('/generation-logs', (ctx) => adminController.listGenerationLogs(ctx), {
    query: t.Composite([
      PageQuery,
      t.Object({
        instance_id: t.Optional(t.String()),
        player_id: t.Optional(t.String()),
      }),
    ]),
  })
