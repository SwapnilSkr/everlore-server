import { Elysia } from 'elysia'
import { authPlugin } from '../middleware/auth'
import { moderationController } from '../controllers/moderation.controller'
import { BlockBody, CreateReportBody } from '../schemas/moderation.schema'

/**
 * Player-facing moderation: report content, and block what you do not want to
 * see. Both are required of any app that shows one user's content to another.
 */
export const moderationRoutes = new Elysia({ prefix: '/moderation' })
  .use(authPlugin)

  .post('/reports', (ctx) => moderationController.createReport(ctx), { body: CreateReportBody })

  .get('/blocks', (ctx) => moderationController.listBlocks(ctx))
  .post('/blocks', (ctx) => moderationController.createBlock(ctx), { body: BlockBody })
  .delete('/blocks/:targetType/:targetId', (ctx) => moderationController.removeBlock(ctx))
