import { Elysia, t } from 'elysia'
import { requireAdmin } from '../middleware/admin-auth'
import { adminPersonaService } from '../services/admin-persona.service'
import { accountFilter } from '../services/reviewer-accounts'

const AdminPersonaQuery = t.Object({
  page: t.Optional(t.Numeric({ minimum: 1 })),
  limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100 })),
  search: t.Optional(t.String({ maxLength: 120 })),
  player_id: t.Optional(t.String()),
  // Validated in the service, not here: the contract wants a plain 400 sentence
  // for a bad date, and a schema rejection would answer 422 instead.
  created_from: t.Optional(t.String()),
  created_to: t.Optional(t.String()),
  in_use: t.Optional(t.Union([t.Literal('true'), t.Literal('false')])),
  min_saves: t.Optional(t.Integer({ minimum: 1 })),
  sort: t.Optional(t.Union([t.Literal('created'), t.Literal('updated'), t.Literal('saves')])),
  // The account choice, as on every player list. Validated in the service so a
  // bad value is a plain 400 sentence.
  show: t.Optional(t.String()),
  only: t.Optional(t.String()),
  reviewers: t.Optional(t.String()),
})

/**
 * Read-only persona pages for the console.
 *
 * The routes are declared on this instance, after `requireAdmin`, because its
 * hooks are scoped: a route on another instance would not be guarded, which is
 * how the whole admin API was public once.
 */
export const adminPersonaRoutes = new Elysia({ prefix: '/admin/personas' })
  .use(requireAdmin)
  .get('/', (ctx) => adminPersonaService.list({
    ...ctx.query,
    accounts: accountFilter(ctx.query.show, ctx.query.only, ctx.query.reviewers),
  }), { query: AdminPersonaQuery })
  .get('/:personaId', (ctx) => adminPersonaService.get(ctx.params.personaId))
