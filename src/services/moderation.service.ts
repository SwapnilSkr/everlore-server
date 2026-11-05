import { createHash } from 'node:crypto'
import { ObjectId, type UpdateFilter, type WithoutId } from 'mongodb'
import { mongoColl } from '../config/mongo'
import { HttpError } from '../utils/http-error'
import { idString, parseObjectId } from '../utils/mongo-id'
import {
  CRITICAL_REPORT_REASONS,
  REPORT_REASON_LABELS,
  type ContentReportDoc,
  type ReportAction,
  type ReportReason,
  type ReportStatus,
  type ReportTargetType,
} from '../models/content-report.model'
import type { WorldTemplateDoc } from '../models/world-template.model'
import { deletionService } from './deletion.service'
import { loadGroupMembers } from './group-chat/instance'
import { groupMessages, groupThreadFilter, validGroupThread } from './group-chat/memory'
import { discoveryReviewFilter } from '../utils/world-review'

const users = () => mongoColl.users()
const worldTemplates = () => mongoColl.worldTemplates()
const contentReports = () => mongoColl.contentReports()

/** A player may not block themselves out of their own library. */
function assertNotSelf(actorId: ObjectId, targetId: ObjectId, what: string) {
  if (actorId.equals(targetId)) {
    throw new HttpError(400, `You cannot ${what} yourself.`)
  }
}

/**
 * Blocks a player has in force, as raw ObjectIds.
 *
 * Returned even for an unknown user id so callers can treat "signed out" and
 * "blocks nothing" identically instead of branching.
 */
export interface BlockSets {
  users: ObjectId[]
  templates: ObjectId[]
}

const EMPTY_BLOCKS: BlockSets = { users: [], templates: [] }

export const moderationService = {
  /**
   * The block lists for one player. Cheap enough to call per discovery request:
   * it is a covered read of two arrays on a document that is already indexed by
   * `_id`.
   */
  async blocksFor(userId?: string | null): Promise<BlockSets> {
    if (!userId) return EMPTY_BLOCKS
    let uid: ObjectId
    try {
      uid = parseObjectId(userId)
    } catch {
      return EMPTY_BLOCKS
    }
    const user = await users().findOne(
      { _id: uid },
      { projection: { blocked_user_ids: 1, blocked_template_ids: 1 } },
    )
    return {
      users: Array.isArray(user?.blocked_user_ids) ? user.blocked_user_ids : [],
      templates: Array.isArray(user?.blocked_template_ids) ? user.blocked_template_ids : [],
    }
  },

  /**
   * The Mongo filter fragment that hides moderated and blocked worlds from a
   * discovery query.
   *
   * Admin-hidden worlds are excluded for everyone; blocks are per-player. Both
   * are expressed as one `$and`-able object so callers merge it into whatever
   * filter they already had.
   */
  async discoveryFilter(userId?: string | null): Promise<Record<string, unknown>> {
    const blocks = await this.blocksFor(userId)
    const filter: Record<string, unknown> = {
      // Absent means never moderated. `$ne` matches missing fields, so legacy
      // rows written before moderation existed still pass.
      moderation_status: { $ne: 'hidden' },
      ...discoveryReviewFilter(),
    }
    if (blocks.templates.length > 0) filter._id = { $nin: blocks.templates }
    if (blocks.users.length > 0) filter.creator_id = { $nin: blocks.users }
    return filter
  },

  /** True when this player has blocked the world or its creator. */
  async isHiddenFor(userId: string | null | undefined, template: { _id: ObjectId; creator_id: ObjectId }) {
    const blocks = await this.blocksFor(userId)
    return (
      blocks.templates.some((id) => id.equals(template._id)) ||
      blocks.users.some((id) => id.equals(template.creator_id))
    )
  },

  async listBlocks(userId: string) {
    const blocks = await this.blocksFor(userId)
    const [blockedUsers, blockedTemplates] = await Promise.all([
      blocks.users.length
        ? users()
            .find({ _id: { $in: blocks.users } }, { projection: { username: 1 } })
            .toArray()
        : Promise.resolve([]),
      blocks.templates.length
        ? worldTemplates()
            .find(
              { _id: { $in: blocks.templates } },
              { projection: { title: 1, image_url: 1, creator_id: 1 } },
            )
            .toArray()
        : Promise.resolve([]),
    ])

    return {
      users: blockedUsers.map((user) => ({
        id: idString(user._id),
        username: user.username,
      })),
      worlds: blockedTemplates.map((template) => ({
        id: idString(template._id),
        title: template.title,
        image_url: template.image_url || '',
        creator_id: idString(template.creator_id),
      })),
    }
  },

  /**
   * Blocks a creator for one player. Idempotent — `$addToSet` means a repeated
   * block is a no-op rather than an error, which is what a client retrying a
   * dropped request needs.
   */
  async blockUser(userId: string, targetUserId: string) {
    const uid = parseObjectId(userId)
    const target = parseObjectId(targetUserId)
    assertNotSelf(uid, target, 'block')

    const exists = await users().countDocuments({ _id: target }, { limit: 1 })
    if (exists === 0) throw new HttpError(404, 'Account not found')

    await users().updateOne(
      { _id: uid },
      { $addToSet: { blocked_user_ids: target }, $set: { updated_at: new Date() } },
    )
    return { blocked: true, target_type: 'user' as const, target_id: targetUserId }
  },

  async unblockUser(userId: string, targetUserId: string) {
    await users().updateOne(
      { _id: parseObjectId(userId) },
      { $pull: { blocked_user_ids: parseObjectId(targetUserId) }, $set: { updated_at: new Date() } },
    )
    return { blocked: false, target_type: 'user' as const, target_id: targetUserId }
  },

  /** Hides a single world for one player without touching its creator. */
  async blockTemplate(userId: string, templateId: string) {
    const uid = parseObjectId(userId)
    const target = parseObjectId(templateId)

    const template = await worldTemplates().findOne(
      { _id: target },
      { projection: { creator_id: 1 } },
    )
    if (!template) throw new HttpError(404, 'World not found')
    assertNotSelf(uid, template.creator_id, 'hide a world you created from')

    await users().updateOne(
      { _id: uid },
      { $addToSet: { blocked_template_ids: target }, $set: { updated_at: new Date() } },
    )
    return { blocked: true, target_type: 'world' as const, target_id: templateId }
  },

  async unblockTemplate(userId: string, templateId: string) {
    await users().updateOne(
      { _id: parseObjectId(userId) },
      { $pull: { blocked_template_ids: parseObjectId(templateId) }, $set: { updated_at: new Date() } },
    )
    return { blocked: false, target_type: 'world' as const, target_id: templateId }
  },

  /**
   * Files a report.
   *
   * The reported content is snapshotted at report time: a creator who deletes
   * or renames a world after being reported must not be able to empty the
   * moderation queue by doing so.
   *
   * A second open report on the same target by the same reporter resolves to
   * the existing one (unique partial index) rather than erroring, so a
   * double-tap in the app is harmless.
   */
  async report(input: {
    reporterId: string
    targetType: ReportTargetType
    targetId: string
    reason: ReportReason
    details?: string
    characterId?: string
    text?: string
  }) {
    const reporter = parseObjectId(input.reporterId)
    const target = parseObjectId(input.targetId)
    if (input.details !== undefined && (typeof input.details !== 'string' || input.details.length > 1000)) {
      throw new HttpError(400, 'Report details must be at most 1000 characters.')
    }
    if (input.targetType === 'group_line') {
      if (typeof input.characterId !== 'string' || !input.characterId.length || input.characterId.length > 64 ||
          typeof input.text !== 'string' || !input.text.length || input.text.length > 4000) {
        throw new HttpError(400, 'Choose a saved character line to report.')
      }
    } else if (input.characterId !== undefined || input.text !== undefined) {
      throw new HttpError(400, 'Character and text apply to line reports only.')
    }
    const details = String(input.details || '').trim()

    if (input.reason === 'other' && details.length === 0) {
      throw new HttpError(400, 'Tell us what is wrong so we can act on this report.')
    }

    const snapshot: ContentReportDoc['target_snapshot'] = {}
    let creatorId: ObjectId | undefined
    let targetLine: string | undefined
    let evidence: { key: string; url: string } | undefined

    if (input.targetType === 'group_selfie') {
      const notFound = () => new HttpError(404, 'That line could not be found.')
      const asset = await mongoColl.mediaAssets().findOne({ _id: target, player_id: reporter, group_selfie: true, kind: 'picture', status: 'ready' })
      if (!asset?.event_id || !asset.url) throw notFound()
      const event = await mongoColl.events().findOne({ _id: asset.event_id, player_id: reporter, instance_id: asset.instance_id })
      const instance = await mongoColl.worldInstances().findOne({ _id: asset.instance_id, player_id: reporter })
      if (!event || !instance?.group_state || !instance.group_context || !validGroupThread(event.data.dm_with) || event.data.dm_with !== asset.direct_with) throw notFound()
      const template = await worldTemplates().findOne({ _id: instance.template_id })
      const { groupLineId } = await import('./group-chat/public')
      const lineIndex = (event.data.lines || []).findIndex(line => groupLineId(line) === asset.line_id && line.character_id === String(asset.character_id))
      if (template?.kind !== 'group' || lineIndex < 0 || event.data.group_selfies?.[asset.line_id]?.media_id !== String(asset._id)) throw notFound()
      const line = event.data.lines![lineIndex]
      const members = await loadGroupMembers(instance)
      const speaker = members.find(member => member.id === line.character_id)
      if (!speaker) throw notFound()
      const thread = event.data.dm_with
      const before = await mongoColl.events().find({ instance_id: instance._id, player_id: reporter, ...groupThreadFilter(thread), sequence: { $lt: event.sequence } })
        .sort({ sequence: -1 }).limit(6).toArray()
      const preceding = { ...event, data: { ...event.data, lines: event.data.lines!.slice(0, lineIndex) } }
      snapshot.title = template.title
      snapshot.speaker = speaker.name
      snapshot.description = line.text
      snapshot.context = groupMessages([...before.reverse(), preceding], instance.group_context.player, members, thread)
        .slice(-6).map(line => `${line.name}: ${line.text}`).join('\n')
      snapshot.thread = thread === undefined ? 'group' : 'direct'
      snapshot.is_nsfw_capable = Boolean(template.is_nsfw_capable)
      const existing = await contentReports().findOne({ reporter_id: reporter, target_type: 'group_selfie', target_id: target, status: { $in: ['open', 'reviewing'] } })
      if (existing) return { reported: true, report_id: idString(existing._id), duplicate: true }
      evidence = await (await import('./media/selfie-evidence')).snapshotSelfieImage(asset.url)
      snapshot.image_url = evidence.url
    } else if (input.targetType === 'chat_line') {
      const notFound = () => new HttpError(404, 'That line could not be found.')
      const event = await mongoColl.events().findOne({ _id: target })
      if (!event) throw notFound()
      const instance = await mongoColl.worldInstances().findOne({ _id: event.instance_id, player_id: reporter })
      if (!instance || instance.group_template_id || instance.group_state) throw notFound()
      const template = await worldTemplates().findOne({ _id: instance.template_id })
      if (!template || template.kind === 'group') throw notFound()
      if (typeof event.data.ai_response !== 'string' || !event.data.ai_response.trim()) throw notFound()
      const before = await mongoColl.events().find({ instance_id: instance._id, sequence: { $lt: event.sequence } })
        .sort({ sequence: -1 }).limit(3).toArray()
      snapshot.title = template.title
      snapshot.description = event.data.ai_response
      snapshot.context = before.reverse().map(turn =>
        `Player: ${(turn.data.player_input || '').slice(0, 1000)}\nResponse: ${(turn.data.ai_response || '').slice(0, 1000)}`,
      ).join('\n')
      snapshot.is_user_edited = Boolean(event.is_user_edited)
      snapshot.is_nsfw_capable = Boolean(template.is_nsfw_capable)
    } else if (input.targetType === 'group_line') {
      const notFound = () => new HttpError(404, 'That line could not be found.')
      const event = await mongoColl.events().findOne({ _id: target })
      if (!event) throw notFound()
      const instance = await mongoColl.worldInstances().findOne({ _id: event.instance_id, player_id: reporter })
      if (!instance?.group_state || !instance.group_context || !validGroupThread(event.data.dm_with)) throw notFound()
      const template = await worldTemplates().findOne({ _id: instance.template_id })
      if (template?.kind !== 'group') throw notFound()
      const lineIndex = (event.data.lines || []).findIndex(line => line.character_id === input.characterId && line.text === input.text)
      if (lineIndex < 0) throw notFound()
      const line = event.data.lines![lineIndex]
      const members = await loadGroupMembers(instance)
      const speaker = members.find(member => member.id === line.character_id)
      if (!speaker) throw notFound()
      const thread = event.data.dm_with
      const before = await mongoColl.events().find({ instance_id: instance._id, ...groupThreadFilter(thread), sequence: { $lt: event.sequence } })
        .sort({ sequence: -1 }).limit(6).toArray()
      const preceding = { ...event, data: { ...event.data, lines: event.data.lines!.slice(0, lineIndex) } }
      snapshot.title = template.title
      snapshot.speaker = speaker.name
      snapshot.description = line.text
      snapshot.context = groupMessages([...before.reverse(), preceding], instance.group_context.player, members, thread)
        .slice(-6).map(line => `${line.name}: ${line.text}`).join('\n')
      snapshot.thread = thread === undefined ? 'group' : 'direct'
      snapshot.is_nsfw_capable = Boolean(template.is_nsfw_capable)
      targetLine = createHash('sha256').update(JSON.stringify([line.character_id, line.text])).digest('hex')
    } else if (input.targetType === 'world') {
      const template = await worldTemplates().findOne({ _id: target })
      if (!template) throw new HttpError(404, 'World not found')
      assertNotSelf(reporter, template.creator_id, 'report a world you created from')
      creatorId = template.creator_id
      snapshot.title = template.title
      snapshot.description = String(template.description || '').slice(0, 2000)
      snapshot.image_url = template.image_url || ''
      snapshot.is_nsfw_capable = Boolean(template.is_nsfw_capable)
    } else {
      const user = await users().findOne({ _id: target }, { projection: { username: 1 } })
      if (!user) throw new HttpError(404, 'Account not found')
      assertNotSelf(reporter, target, 'report')
      creatorId = target
      snapshot.creator_username = user.username
    }

    if (creatorId && !snapshot.creator_username) {
      const creator = await users().findOne(
        { _id: creatorId },
        { projection: { username: 1 } },
      )
      if (creator) snapshot.creator_username = creator.username
    }

    const now = new Date()
    try {
      const inserted = await contentReports().insertOne({
        reporter_id: reporter,
        target_type: input.targetType,
        target_id: target,
        ...(creatorId === undefined ? {} : { target_creator_id: creatorId }),
        ...(targetLine === undefined ? {} : { target_line: targetLine }),
        target_snapshot: snapshot,
        reason: input.reason,
        details: details || undefined,
        status: 'open',
        is_critical: CRITICAL_REPORT_REASONS.has(input.reason),
        created_at: now,
        updated_at: now,
      })
      return { reported: true, report_id: idString(inserted.insertedId), duplicate: false }
    } catch (error) {
      if (evidence) await (await import('./media/service')).mediaEffects.remove(evidence.key)
      // 11000 = the unique partial index above: this reporter already has an
      // unresolved report open on this target.
      if ((error as { code?: number }).code === 11000) {
        const existing = await contentReports().findOne({
          reporter_id: reporter,
          target_type: input.targetType,
          target_id: target,
          target_line: targetLine === undefined ? { $exists: false } : targetLine,
          status: { $in: ['open', 'reviewing'] },
        })
        return {
          reported: true,
          report_id: existing ? idString(existing._id) : null,
          duplicate: true,
        }
      }
      throw error
    }
  },

  // ---------------------------------------------------------------------------
  // Admin surface
  // ---------------------------------------------------------------------------

  /**
   * The moderation queue. Default ordering is triage order: unresolved first,
   * critical reasons above the rest, then oldest first so nothing starves.
   */
  async listReports(opts: {
    page?: number
    limit?: number
    status?: ReportStatus | 'all' | 'unresolved'
    reason?: ReportReason
    target_type?: ReportTargetType
    critical?: boolean
  }) {
    const limit = Math.min(Math.max(Number(opts.limit || 50), 1), 200)
    const page = Math.max(Number(opts.page || 1), 1)
    const skip = (page - 1) * limit

    const filter: Record<string, unknown> = {}
    const status = opts.status || 'unresolved'
    if (status === 'unresolved') filter.status = { $in: ['open', 'reviewing'] }
    else if (status !== 'all') filter.status = status
    if (opts.reason) filter.reason = opts.reason
    if (opts.target_type) filter.target_type = opts.target_type
    if (opts.critical !== undefined) filter.is_critical = opts.critical

    const [total, rows] = await Promise.all([
      contentReports().countDocuments(filter),
      contentReports()
        .find(filter)
        .sort({ status: 1, is_critical: -1, created_at: 1 })
        .skip(skip)
        .limit(limit)
        .toArray(),
    ])

    return { total, page, limit, items: rows.map(serializeReport) }
  },

  /**
   * One report with everything a moderator needs to decide: the reporter, the
   * live target (which may be gone), and how many other reports that same
   * target has drawn.
   */
  async getReport(reportId: string) {
    const report = await contentReports().findOne({ _id: parseObjectId(reportId) })
    if (!report) throw new HttpError(404, 'Report not found')

    const [reporter, creator, related] = await Promise.all([
      users().findOne({ _id: report.reporter_id }, { projection: { username: 1, email: 1, account_status: 1 } }),
      report.target_type !== 'group_selfie' && report.target_type !== 'chat_line' && report.target_creator_id
        ? users().findOne(
            { _id: report.target_creator_id },
            { projection: { username: 1, email: 1, account_status: 1, tier: 1 } },
          )
        : Promise.resolve(null),
      contentReports().countDocuments({
        target_type: report.target_type,
        target_id: report.target_id,
        ...(report.target_line === undefined ? {} : { target_line: report.target_line }),
      }),
    ])

    let target: Record<string, unknown> | null = null
    if (report.target_type === 'world') {
      const template = await worldTemplates().findOne({ _id: report.target_id })
      target = template
        ? {
            id: idString(template._id),
            title: template.title,
            description: template.description,
            image_url: template.image_url || '',
            is_published: template.is_published,
            is_nsfw_capable: template.is_nsfw_capable,
            moderation_status: template.moderation_status || 'active',
            moderation_reason: template.moderation_reason || '',
            seed_prompt: template.seed_prompt,
            global_lore: template.global_lore,
            opening_line: template.opening_line || '',
            created_at: template.created_at,
          }
        : null
    }

    return {
      report: serializeReport(report),
      reporter: reporter
        ? {
            id: idString(reporter._id),
            username: reporter.username,
            email: reporter.email || '',
            account_status: reporter.account_status || 'active',
          }
        : null,
      creator: creator
        ? {
            id: idString(creator._id),
            username: creator.username,
            email: creator.email || '',
            account_status: creator.account_status || 'active',
            tier: creator.tier,
          }
        : null,
      /** Null when the reported world has since been deleted. */
      target,
      reports_against_target: related,
    }
  },

  /**
   * Records a moderator decision and carries it out.
   *
   * The report is always closed; the `action` decides what else happens to the
   * content. Every action other than `none` is applied before the report is
   * marked resolved, so a failure leaves the report open rather than claiming
   * an action that did not land.
   */
  async resolveReport(
    reportId: string,
    input: { action: ReportAction; note?: string; resolved_by?: string; status?: 'actioned' | 'dismissed' },
  ) {
    const report = await contentReports().findOne({ _id: parseObjectId(reportId) })
    if (!report) throw new HttpError(404, 'Report not found')

    const note = String(input.note || '').trim().slice(0, 500)
    const by = String(input.resolved_by || 'admin').slice(0, 120)
    const now = new Date()
    const effects: string[] = []

    if (report.target_type === 'group_selfie' && input.action !== 'none') {
      throw new HttpError(400, 'Picture reports can only be resolved without a content action.')
    }
    if (report.target_type === 'group_line' && input.action !== 'none') {
      throw new HttpError(400, 'Line reports can only be resolved without a content action.')
    }
    if (report.target_type === 'chat_line' && input.action !== 'none') {
      throw new HttpError(400, 'Line reports can only be resolved without a content action.')
    }

    if (input.action !== 'none' && report.target_type !== 'world' && input.action !== 'creator_banned') {
      throw new HttpError(400, 'Content actions apply to reported worlds only.')
    }

    switch (input.action) {
      case 'content_hidden':
        await setTemplateModeration(report.target_id, 'hidden', note || 'Hidden after a player report', by)
        effects.push('World hidden from discovery and blocked from new playthroughs.')
        break
      case 'content_unpublished':
        await worldTemplates().updateOne(
          { _id: report.target_id },
          { $set: { is_published: false, updated_at: now } },
        )
        effects.push('World unpublished; the creator can still edit it.')
        break
      case 'content_deleted':
        await deletionService.deleteTemplateById(idString(report.target_id))
        effects.push('World and its playthroughs deleted permanently.')
        break
      case 'creator_banned': {
        if (!report.target_creator_id) throw new HttpError(400, 'This report has no creator to ban.')
        await users().updateOne(
          { _id: report.target_creator_id },
          {
            $set: {
              account_status: 'banned',
              banned_at: now,
              ban_reason: note || 'Banned after a content report',
              updated_at: now,
            },
          },
        )
        // A banned creator's catalogue must leave discovery too, or the ban
        // only stops them signing in while their worlds keep circulating.
        const hidden = await worldTemplates().updateMany(
          { creator_id: report.target_creator_id, moderation_status: { $ne: 'hidden' } },
          {
            $set: {
              moderation_status: 'hidden',
              moderation_reason: note || 'Creator banned',
              moderated_at: now,
              moderated_by: by,
              updated_at: now,
            },
          },
        )
        effects.push(
          `Creator banned and ${hidden.modifiedCount} world${hidden.modifiedCount === 1 ? '' : 's'} hidden.`,
        )
        break
      }
      case 'none':
      default:
        break
    }

    const status: ReportStatus =
      input.status || (input.action === 'none' ? 'dismissed' : 'actioned')

    const updated = await contentReports().findOneAndUpdate(
      { _id: report._id },
      {
        $set: {
          status,
          action_taken: input.action,
          resolution_note: note || undefined,
          resolved_by: by,
          resolved_at: now,
          updated_at: now,
        },
      },
      { returnDocument: 'after' },
    )

    return {
      report: updated ? serializeReport(updated) : null,
      effects,
    }
  },

  /** Reopens a resolved report for a second look. */
  async reopenReport(reportId: string) {
    const updated = await contentReports().findOneAndUpdate(
      { _id: parseObjectId(reportId) },
      {
        $set: { status: 'open', updated_at: new Date() },
        $unset: { resolved_at: '', resolved_by: '', action_taken: '', resolution_note: '' },
      },
      { returnDocument: 'after' },
    )
    if (!updated) throw new HttpError(404, 'Report not found')
    return { report: serializeReport(updated) }
  },

  /** Directly set a world's moderation state, outside of any one report. */
  async setWorldModeration(
    templateId: string,
    status: 'active' | 'hidden',
    reason?: string,
    by?: string,
  ) {
    const template = await setTemplateModeration(
      parseObjectId(templateId),
      status,
      String(reason || '').trim().slice(0, 500),
      String(by || 'admin').slice(0, 120),
    )
    return { world: { id: idString(template._id), moderation_status: template.moderation_status } }
  },

  /** Queue counters for the admin overview. */
  async queueStats() {
    const [open, critical, reviewing] = await Promise.all([
      contentReports().countDocuments({ status: 'open' }),
      contentReports().countDocuments({ status: { $in: ['open', 'reviewing'] }, is_critical: true }),
      contentReports().countDocuments({ status: 'reviewing' }),
    ])
    return { open_reports: open, critical_reports: critical, reviewing_reports: reviewing }
  },
}

async function setTemplateModeration(
  templateId: ObjectId,
  status: 'active' | 'hidden',
  reason: string,
  by: string,
) {
  const now = new Date()
  const update: UpdateFilter<WithoutId<WorldTemplateDoc>> =
    status === 'hidden'
      ? {
          $set: {
            moderation_status: 'hidden',
            moderation_reason: reason || 'Hidden by a moderator',
            moderated_at: now,
            moderated_by: by,
            updated_at: now,
          },
        }
      : {
          $set: { moderation_status: 'active', moderated_at: now, moderated_by: by, updated_at: now },
          $unset: { moderation_reason: '' },
        }

  const updated = await worldTemplates().findOneAndUpdate({ _id: templateId }, update, {
    returnDocument: 'after',
  })
  if (!updated) throw new HttpError(404, 'World not found')
  return updated
}

function serializeReport(report: ContentReportDoc) {
  return {
    id: idString(report._id),
    reporter_id: idString(report.reporter_id),
    target_type: report.target_type,
    target_id: idString(report.target_id),
    ...(report.target_line === undefined ? {} : { target_line: report.target_line }),
    ...(report.target_type === 'group_selfie' || report.target_type === 'group_line' || report.target_type === 'chat_line' ? {} : {
      target_creator_id: report.target_creator_id ? idString(report.target_creator_id) : null,
    }),
    target_title: report.target_snapshot?.title || report.target_snapshot?.creator_username || '',
    target_snapshot: report.target_snapshot || {},
    reason: report.reason,
    reason_label: REPORT_REASON_LABELS[report.reason] || report.reason,
    /** Pre-rendered priority so a queue row is readable without a lookup table. */
    priority: report.is_critical ? 'CRITICAL' : 'normal',
    details: report.details || '',
    status: report.status,
    is_critical: report.is_critical,
    action_taken: report.action_taken || null,
    resolution_note: report.resolution_note || '',
    resolved_by: report.resolved_by || '',
    resolved_at: report.resolved_at ? report.resolved_at.toISOString() : null,
    created_at: report.created_at ? report.created_at.toISOString() : null,
    updated_at: report.updated_at ? report.updated_at.toISOString() : null,
  }
}
