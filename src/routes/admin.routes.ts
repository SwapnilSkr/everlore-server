/**
 * Unauthenticated admin helpers — for local/dev tier management only.
 * Add proper admin auth (or network isolation) before any public deployment.
 */
import { Elysia } from 'elysia'
import { AdminSetTierBody, AdminUserListQuery } from '../schemas/user.schema'
import { adminController } from '../controllers/admin.controller'

export const adminRoutes = new Elysia({ prefix: '/admin' })

  .get('/users', (ctx) => adminController.listUsers(ctx), { query: AdminUserListQuery })

  .get('/users/:userId', (ctx) => adminController.getUser(ctx))

  .patch('/users/:userId/tier', (ctx) => adminController.patchUserTier(ctx), {
    body: AdminSetTierBody,
  })
