import { t } from 'elysia'
import { REPORT_REASONS } from '../models/content-report.model'

const ReportReasonSchema = t.Union(REPORT_REASONS.map((reason) => t.Literal(reason)))

const TargetTypeSchema = t.Union([t.Literal('world'), t.Literal('user')])

export const CreateReportBody = t.Object({
  target_type: TargetTypeSchema,
  target_id: t.String({ minLength: 1, maxLength: 64 }),
  reason: ReportReasonSchema,
  details: t.Optional(t.String({ maxLength: 1000 })),
})

export const BlockBody = t.Object({
  target_type: TargetTypeSchema,
  target_id: t.String({ minLength: 1, maxLength: 64 }),
})

export const AdminReportQuery = t.Object({
  page: t.Optional(t.Numeric({ minimum: 1 })),
  limit: t.Optional(t.Numeric({ minimum: 1, maximum: 200 })),
  status: t.Optional(
    t.Union([
      t.Literal('all'),
      t.Literal('unresolved'),
      t.Literal('open'),
      t.Literal('reviewing'),
      t.Literal('actioned'),
      t.Literal('dismissed'),
    ]),
  ),
  reason: t.Optional(ReportReasonSchema),
  target_type: t.Optional(TargetTypeSchema),
  critical: t.Optional(t.Union([t.Boolean(), t.String()])),
})

export const AdminResolveReportBody = t.Object({
  action: t.Union([
    t.Literal('none'),
    t.Literal('content_hidden'),
    t.Literal('content_unpublished'),
    t.Literal('content_deleted'),
    t.Literal('creator_banned'),
  ]),
  note: t.Optional(t.String({ maxLength: 500 })),
  status: t.Optional(t.Union([t.Literal('actioned'), t.Literal('dismissed')])),
})

export const AdminWorldModerationBody = t.Object({
  moderation_status: t.Union([t.Literal('active'), t.Literal('hidden')]),
  reason: t.Optional(t.String({ maxLength: 500 })),
})
