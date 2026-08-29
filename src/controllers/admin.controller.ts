import { adminService } from '../services/admin.service'
import { continuityAuditService } from '../services/continuity-audit.service'
import { billingService } from '../services/billing.service'
import { moderationService } from '../services/moderation.service'
import type { ReportAction, ReportReason, ReportStatus, ReportTargetType } from '../models/content-report.model'

function boolQuery(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  return undefined
}

function pageQuery(query: { page?: number; limit?: number }) {
  return {
    page: query.page ?? 1,
    limit: query.limit ?? 50,
  }
}

export const adminController = {
  overview: async () => ({
    ...(await adminService.overview()),
    ...(await moderationService.queueStats()),
  }),

  listReports: async ({
    query,
  }: {
    query: {
      page?: number
      limit?: number
      status?: ReportStatus | 'all' | 'unresolved'
      reason?: ReportReason
      target_type?: ReportTargetType
      critical?: boolean | string
    }
  }) =>
    moderationService.listReports({
      ...pageQuery(query),
      status: query.status,
      reason: query.reason,
      target_type: query.target_type,
      critical: boolQuery(query.critical),
    }),

  getReport: async ({ params }: { params: { reportId: string } }) =>
    moderationService.getReport(params.reportId),

  resolveReport: async ({
    params,
    body,
    adminUser,
  }: {
    params: { reportId: string }
    body: { action: ReportAction; note?: string; status?: 'actioned' | 'dismissed' }
    adminUser?: string
  }) =>
    moderationService.resolveReport(params.reportId, {
      action: body.action,
      note: body.note,
      status: body.status,
      resolved_by: adminUser,
    }),

  reopenReport: async ({ params }: { params: { reportId: string } }) =>
    moderationService.reopenReport(params.reportId),

  patchWorldModeration: async ({
    params,
    body,
    adminUser,
  }: {
    params: { worldId: string }
    body: { moderation_status: 'active' | 'hidden'; reason?: string }
    adminUser?: string
  }) =>
    moderationService.setWorldModeration(
      params.worldId,
      body.moderation_status,
      body.reason,
      adminUser,
    ),

  listUsers: async ({ query }: { query: { page?: number; limit?: number; search?: string } }) =>
    adminService.listUsers({ ...pageQuery(query), search: query.search }),

  getUser: async ({ params }: { params: { userId: string } }) => adminService.getUser(params.userId),

  patchUser: async ({ params, body }: { params: { userId: string }; body: Record<string, unknown> }) =>
    adminService.updateUser(params.userId, body),

  patchUserTier: async ({
    params,
    body,
  }: {
    params: { userId: string }
    body: { tier: 'free' | 'premium' | 'creator' | 'inherit' }
  }) => ({
    ...(await adminService.setUserTier(params.userId, body.tier)),
    note: 'The tier override is applied on the next authenticated request, including existing JWTs and WebSocket frames.',
  }),

  patchUserStatus: async ({
    params,
    body,
  }: {
    params: { userId: string }
    body: { status: 'active' | 'banned'; reason?: string }
  }) => ({
    ...(await adminService.setUserStatus(params.userId, body.status, body.reason)),
    note: body.status === 'banned'
      ? 'The account is blocked on new HTTP and WebSocket authentication immediately.'
      : 'The account is active again; the user may sign in normally.',
  }),

  grantUserInk: async ({
    params,
    body,
  }: {
    params: { userId: string }
    body: { amount: number; idempotency_key: string; note?: string }
  }) =>
    billingService.grantAdminInk(params.userId, {
      amount: body.amount,
      idempotencyKey: body.idempotency_key,
      note: body.note,
    }),

  getUserBilling: async ({ params }: { params: { userId: string } }) =>
    billingService.adminAccountSnapshot(params.userId),

  deleteUser: async ({ params }: { params: { userId: string } }) => adminService.deleteUser(params.userId),

  listWorlds: async ({
    query,
  }: {
    query: { page?: number; limit?: number; search?: string; creator_id?: string; published?: boolean | string }
  }) =>
    adminService.listWorlds({
      ...pageQuery(query),
      search: query.search,
      creator_id: query.creator_id,
      published: boolQuery(query.published),
    }),

  getWorld: async ({ params }: { params: { worldId: string } }) => adminService.getWorld(params.worldId),

  patchWorld: async ({ params, body }: { params: { worldId: string }; body: Record<string, unknown> }) =>
    adminService.updateWorld(params.worldId, body),

  deleteWorld: async ({ params }: { params: { worldId: string } }) => adminService.deleteWorld(params.worldId),

  listInstances: async ({
    query,
  }: {
    query: { page?: number; limit?: number; player_id?: string; template_id?: string; archived?: boolean | string }
  }) =>
    adminService.listInstances({
      ...pageQuery(query),
      player_id: query.player_id,
      template_id: query.template_id,
      archived: boolQuery(query.archived),
    }),

  listContinuityAuditStatus: async ({
    query,
  }: {
    query: { page?: number; limit?: number; status?: string; stale_days?: number }
  }) =>
    adminService.listContinuityAuditStatus({
      ...pageQuery(query),
      status: ['all', 'healthy', 'unhealthy', 'missing', 'stale'].includes(query.status || '')
        ? query.status as 'all' | 'healthy' | 'unhealthy' | 'missing' | 'stale'
        : 'all',
      stale_days: query.stale_days,
    }),

  getContinuityAudit: async ({ params }: { params: { instanceId: string } }) =>
    continuityAuditService.audit(params.instanceId),

  getInstance: async ({ params }: { params: { instanceId: string } }) =>
    adminService.getInstance(params.instanceId),

  patchInstance: async ({ params, body }: { params: { instanceId: string }; body: Record<string, unknown> }) =>
    adminService.updateInstance(params.instanceId, body),

  deleteInstance: async ({ params }: { params: { instanceId: string } }) =>
    adminService.deleteInstance(params.instanceId),

  listEvents: async ({
    query,
  }: {
    query: { page?: number; limit?: number; instance_id?: string; player_id?: string }
  }) =>
    adminService.listEvents({
      ...pageQuery(query),
      instance_id: query.instance_id,
      player_id: query.player_id,
    }),

  getEventProjections: async ({ params }: { params: { eventId: string } }) =>
    adminService.getEventProjections(params.eventId),

  patchEvent: async ({ params, body }: { params: { eventId: string }; body: Record<string, unknown> }) =>
    adminService.updateEvent(params.eventId, body),

  deleteEvent: async ({ params }: { params: { eventId: string } }) => adminService.deleteEvent(params.eventId),

  listMemories: async ({
    query,
  }: {
    query: { page?: number; limit?: number; instance_id?: string; player_id?: string }
  }) =>
    adminService.listMemories({
      ...pageQuery(query),
      instance_id: query.instance_id,
      player_id: query.player_id,
    }),

  patchMemory: async ({ params, body }: { params: { memoryId: string }; body: Record<string, unknown> }) =>
    adminService.updateMemory(params.memoryId, body),

  deleteMemory: async ({ params }: { params: { memoryId: string } }) =>
    adminService.deleteMemory(params.memoryId),

  listCharacters: async ({ query }: { query: { page?: number; limit?: number; instance_id?: string } }) =>
    adminService.listCharacters({
      ...pageQuery(query),
      instance_id: query.instance_id,
    }),

  patchCharacter: async ({ params, body }: { params: { characterId: string }; body: Record<string, unknown> }) =>
    adminService.updateCharacter(params.characterId, body),

  deleteCharacter: async ({ params }: { params: { characterId: string } }) =>
    adminService.deleteCharacter(params.characterId),

  listGenerationLogs: async ({
    query,
  }: {
    query: { page?: number; limit?: number; instance_id?: string; player_id?: string }
  }) =>
    adminService.listGenerationLogs({
      ...pageQuery(query),
      instance_id: query.instance_id,
      player_id: query.player_id,
    }),
}
