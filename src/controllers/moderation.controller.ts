import type { AuthUser } from '../middleware/auth'
import { moderationService } from '../services/moderation.service'
import { rateLimit } from '../middleware/rate-limit'
import { HttpError } from '../utils/http-error'
import type { ReportReason, ReportTargetType } from '../models/content-report.model'

function requireUser(user: AuthUser | null): AuthUser {
  if (!user) throw new HttpError(401, 'Unauthorized')
  return user
}

export const moderationController = {
  createReport: async ({
    user,
    body,
  }: {
    user: AuthUser | null
    body: { target_type: ReportTargetType; target_id: string; reason: ReportReason; details?: string }
  }) => {
    const actor = requireUser(user)

    // Reporting is free and unauthenticated-adjacent by design, so it is the
    // one write a bad actor could use to bury the queue. Capped per account.
    const rl = await rateLimit(actor.id, 'content_report')
    if (!rl.allowed) {
      throw new HttpError(429, 'You have filed a lot of reports recently. Try again later.')
    }

    return moderationService.report({
      reporterId: actor.id,
      targetType: body.target_type,
      targetId: body.target_id,
      reason: body.reason,
      details: body.details,
    })
  },

  listBlocks: async ({ user }: { user: AuthUser | null }) =>
    moderationService.listBlocks(requireUser(user).id),

  createBlock: async ({
    user,
    body,
  }: {
    user: AuthUser | null
    body: { target_type: ReportTargetType; target_id: string }
  }) => {
    const actor = requireUser(user)
    return body.target_type === 'user'
      ? moderationService.blockUser(actor.id, body.target_id)
      : moderationService.blockTemplate(actor.id, body.target_id)
  },

  removeBlock: async ({
    user,
    params,
  }: {
    user: AuthUser | null
    params: { targetType: string; targetId: string }
  }) => {
    const actor = requireUser(user)
    if (params.targetType !== 'user' && params.targetType !== 'world') {
      throw new HttpError(400, 'Unknown block type')
    }
    return params.targetType === 'user'
      ? moderationService.unblockUser(actor.id, params.targetId)
      : moderationService.unblockTemplate(actor.id, params.targetId)
  },
}
