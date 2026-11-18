import { adminMetricsService } from '../services/admin-metrics.service'
import { adminService } from '../services/admin.service'
import { webEventService } from '../services/web-event.service'
import { cloudflareAnalyticsService } from '../services/cloudflare-analytics.service'
import { webTrafficRollupService } from '../services/web-traffic-rollup.service'
import { continuityAuditService } from '../services/continuity-audit.service'
import { billingService } from '../services/billing.service'
import {
  BILLING_DEFAULTS,
  effectiveBilling,
  saveBillingConfig,
} from '../services/billing-config.service'
import { moderationService } from '../services/moderation.service'
import { accountFilter, type AccountFilter } from '../services/reviewer-accounts'
import { billingInsights } from '../services/admin-insights-billing'
import { audienceInsights } from '../services/admin-audience'
import { groupInsights } from '../services/admin-overview-groups.service'
import { retentionInsights } from '../services/admin-overview-retention.service'
import { pathInsights } from '../services/telemetry/paths.service'
import { playerHabitInsights } from '../services/admin-insights-top'
import type { WorldKind, WorldSort, WorldSource } from '../services/admin-insights-worlds'
import type { ReportAction, ReportReason, ReportStatus, ReportTargetType } from '../models/content-report.model'

function boolQuery(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  return undefined
}

/** The account choice every player read takes, parsed once by `reviewer-accounts`. */
type AccountQuery = { show?: string; only?: string; reviewers?: string }

function accountsOf(query: AccountQuery): AccountFilter {
  return accountFilter(query.show, query.only, query.reviewers)
}

function pageQuery(query: { page?: number; limit?: number }) {
  return {
    page: query.page ?? 1,
    limit: query.limit ?? 50,
  }
}

export const adminController = {
  metrics: async ({ query }: { query: { days?: string } & AccountQuery }) =>
    adminMetricsService.metrics(query.days, accountsOf(query)),
  overview: async ({ query }: { query: AccountQuery }) => ({
    ...(await adminService.overview(accountsOf(query))),
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

  listWorldReview: async () => adminService.listWorldReview(),
  approveWorld: async ({ params, adminUser }: { params: { worldId: string }; adminUser: string }) =>
    adminService.reviewWorld(params.worldId, 'approved', adminUser),
  requestWorldChanges: async ({
    params, body, adminUser,
  }: {
    params: { worldId: string }
    body: { note: string }
    adminUser: string
  }) => adminService.reviewWorld(params.worldId, 'changes_requested', adminUser, body.note),

  listUsers: async ({ query }: { query: {
    page?: number
    limit?: number
    search?: string
    sort?: string
    since?: string
  } & AccountQuery }) =>
    adminService.listUsers({
      ...pageQuery(query),
      search: query.search,
      sort: query.sort,
      since: query.since,
      accounts: accountsOf(query),
    }),

  getUser: async ({ params }: { params: { userId: string } }) => adminService.getUser(params.userId),

  /**
   * The team flag, by hand ("Contract, part 2b"). Admin-guarded like every
   * `/admin` route; on records `manual` unless a rule already set a reason.
   */
  setUserInternal: async ({ params, body }: { params: { userId: string }; body: { internal: boolean } }) =>
    adminService.setUserInternal(params.userId, body.internal),

  /** Part 2b/2c: the most active players, and the habit aggregates. */
  getTopPlayers: async ({ query }: { query: { days?: string } & AccountQuery }) =>
    playerHabitInsights.top(query.days, accountsOf(query)),

  getPlayerFrequency: async ({ query }: { query: { days?: string } & AccountQuery }) =>
    playerHabitInsights.frequency(query.days, accountsOf(query)),

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

  patchUserLimits: async ({
    params,
    body,
  }: {
    params: { userId: string }
    body: { monthly_ink?: number | null; daily_story_safety_cap?: number | null }
  }) => adminService.setUserBillingLimits(params.userId, body),

  /**
   * The marketing site on one screen.
   *
   * Two sources that must not be added together: Cloudflare counts page views
   * from its own beacon, we count interactions from ours. They are blocked by
   * different lists and served from different domains, so they measure two
   * overlapping populations — a ratio between them would be fiction.
   */
  getWebEvents: async ({ query }: { query: { days?: string } }) => {
    const days = Math.min(Math.max(Number(query.days) || 30, 1), 365)

    // Today is only as accurate as its last rollup, and someone opening the
    // console is exactly when it should be current. Cheap: the Cloudflare call
    // behind it is cached, and yesterday is included because a late visit can
    // land after that day was first written.
    await webTrafficRollupService.rollupRecent(2)
    await webTrafficRollupService.backfillMissing()

    const [summary, daily, traffic, series, totals] = await Promise.all([
      webEventService.summary(days),
      webEventService.daily('page_view', days),
      cloudflareAnalyticsService.traffic(days),
      webTrafficRollupService.series(days),
      webTrafficRollupService.totals(days),
    ])
    return { ...summary, daily, cloudflare: traffic, series, totals }
  },

  getBillingConfig: async () => {
    const config = await effectiveBilling()
    return { config, defaults: BILLING_DEFAULTS, promo: config.promo }
  },

  putBillingConfig: async ({
    body,
    adminUser,
  }: {
    body: Record<string, unknown>
    adminUser: string
  }) => {
    const config = await saveBillingConfig(body as never, adminUser)
    return { config, defaults: BILLING_DEFAULTS, promo: config.promo }
  },

  getUserBilling: async ({ params }: { params: { userId: string } }) =>
    billingService.adminAccountSnapshot(params.userId),

  /**
   * Cost and Ink across the server, over 7/30/90 days.
   *
   * `days` is validated in the service so a bad value is a plain 400 sentence
   * rather than the framework's validation report.
   */
  getBillingSummary: async ({ query }: { query: { days?: string } & AccountQuery }) =>
    billingInsights.summary(query.days, accountsOf(query)),

  /**
   * Part 2's read-only aggregates. Each validates its own parameters in the
   * service, so a bad value is a plain 400 sentence rather than a schema report.
   */
  getAudience: async ({ query }: { query: { days?: string } & AccountQuery }) =>
    audienceInsights.audience(query.days, accountsOf(query)),

  getSessionPaths: async ({ query }: { query: { days?: string; version?: string } & AccountQuery }) =>
    pathInsights.paths(query.days, query.version || undefined, accountsOf(query)),

  getRetention: async ({ query }: { query: { weeks?: string } & AccountQuery }) =>
    retentionInsights.retention(query.weeks, new Date(), accountsOf(query)),

  getGroupActivity: async ({ query }: { query: { days?: string } & AccountQuery }) =>
    groupInsights.groups(query.days, accountsOf(query)),

  deleteUser: async ({ params }: { params: { userId: string } }) => adminService.deleteUser(params.userId),

  listWorlds: async ({
    query,
  }: {
    query: {
      page?: number
      limit?: number
      search?: string
      creator_id?: string
      published?: boolean | string
      creator?: string
      kind?: WorldKind
      source?: WorldSource
      sort?: WorldSort
    } & AccountQuery
  }) =>
    adminService.listWorlds({
      ...pageQuery(query),
      search: query.search,
      creator_id: query.creator_id,
      published: boolQuery(query.published),
      creator: query.creator,
      kind: query.kind,
      source: query.source,
      sort: query.sort,
      accounts: accountsOf(query),
    }),

  getWorld: async ({ params }: { params: { worldId: string } }) => adminService.getWorld(params.worldId),

  patchWorld: async ({ params, body }: { params: { worldId: string }; body: Record<string, unknown> }) =>
    adminService.updateWorld(params.worldId, body),

  deleteWorld: async ({ params }: { params: { worldId: string } }) => adminService.deleteWorld(params.worldId),

  listInstances: async ({
    query,
  }: {
    query: {
      page?: number
      limit?: number
      player_id?: string
      template_id?: string
      archived?: boolean | string
    } & AccountQuery
  }) =>
    adminService.listInstances({
      ...pageQuery(query),
      player_id: query.player_id,
      template_id: query.template_id,
      archived: boolQuery(query.archived),
      accounts: accountsOf(query),
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
