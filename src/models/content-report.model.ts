import type { ObjectId } from 'mongodb'

/**
 * What a player is reporting. Worlds are the only content one account can put
 * in front of another, so they are the primary target; `user` covers reporting
 * a creator for a pattern rather than for one world.
 */
export type ReportTargetType = 'world' | 'user'

/**
 * Report reasons, kept deliberately small and mapped to the categories Google
 * Play expects an in-app reporting flow to cover. `other` always carries free
 * text so a reason we did not anticipate is still actionable.
 */
export type ReportReason =
  | 'sexual_content_involving_minors'
  | 'non_consensual_sexual_content'
  | 'harassment_or_hate'
  | 'violence_or_threats'
  | 'self_harm'
  | 'illegal_content'
  | 'spam_or_misleading'
  | 'other'

/**
 * Reasons that must never sit in a queue behind ordinary spam. These jump the
 * triage order and are surfaced separately in the admin console.
 */
export const CRITICAL_REPORT_REASONS: ReadonlySet<ReportReason> = new Set([
  'sexual_content_involving_minors',
  'non_consensual_sexual_content',
  'self_harm',
])

export const REPORT_REASONS: readonly ReportReason[] = [
  'sexual_content_involving_minors',
  'non_consensual_sexual_content',
  'harassment_or_hate',
  'violence_or_threats',
  'self_harm',
  'illegal_content',
  'spam_or_misleading',
  'other',
]

/** Human-readable reason text, shared by the admin console and any report export. */
export const REPORT_REASON_LABELS: Record<ReportReason, string> = {
  sexual_content_involving_minors: 'Sexual content involving minors',
  non_consensual_sexual_content: 'Non-consensual sexual content',
  harassment_or_hate: 'Harassment or hate',
  violence_or_threats: 'Violence or threats',
  self_harm: 'Self-harm or suicide',
  illegal_content: 'Illegal content',
  spam_or_misleading: 'Spam or misleading',
  other: 'Something else',
}

export type ReportStatus = 'open' | 'reviewing' | 'actioned' | 'dismissed'

/**
 * The moderation decision an admin recorded. Stored on the report so the audit
 * trail survives even after the world itself is deleted.
 */
export type ReportAction =
  | 'none'
  | 'content_hidden'
  | 'content_unpublished'
  | 'content_deleted'
  | 'creator_banned'

/**
 * content_reports — one document per player report.
 *
 * Reports are never deleted by the reporting flow: a dismissed report still
 * proves the queue was worked, which is exactly what a policy review asks for.
 */
export interface ContentReportDoc {
  _id: ObjectId
  reporter_id: ObjectId
  target_type: ReportTargetType
  /** world_templates._id for 'world', users._id for 'user'. */
  target_id: ObjectId
  /** Owner of the reported content; denormalized so triage needs no join. */
  target_creator_id?: ObjectId
  /**
   * Title at report time. The world may later be renamed or deleted, and the
   * queue still has to show a moderator what was actually reported.
   */
  target_snapshot?: {
    title?: string
    description?: string
    image_url?: string
    is_nsfw_capable?: boolean
    creator_username?: string
  }
  reason: ReportReason
  /** Reporter's own words. Required for `other`, optional elsewhere. */
  details?: string
  status: ReportStatus
  /** True for reasons in {@link CRITICAL_REPORT_REASONS}; indexed for triage. */
  is_critical: boolean
  action_taken?: ReportAction
  resolution_note?: string
  /** Admin username from Basic auth; there are no admin user documents. */
  resolved_by?: string
  resolved_at?: Date
  created_at: Date
  updated_at: Date
}

export type ContentReportInsertDoc = Omit<ContentReportDoc, '_id'>
