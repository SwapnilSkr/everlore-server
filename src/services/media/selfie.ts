import { ObjectId } from 'mongodb'
import { createHash } from 'node:crypto'
import { mongoColl } from '../../config/mongo'
import type { MediaAssetDoc } from '../../models/media.model'
import type { WorldEventDoc } from '../../models/world-event.model'
import type { GroupSelfie } from '../group-chat/types'
import { groupLineId } from '../group-chat/public'
import { groupThreadFilter, validGroupThread } from '../group-chat/memory'
import { loadGroupMembers } from '../group-chat/instance'
import { requireIdentity } from '../guest-policy'
import { HttpError } from '../../utils/http-error'
import { parseObjectId } from '../../utils/mongo-id'
import { asMediaImageReference, imageExtensionFor, ProviderRefusalError } from '../../ai/image'
import { mediaRevision } from './attribution'
import { imageModel, mediaEnabled } from './config'
import { utcMediaDay } from './policy'
import { isReferenceAllowed, portraitUrl, resolvePortraitHolder } from './portraits'
import { describeSelfie, checkImage, moderateDescription } from './safety'
import { duplicateKey, releaseMedia, reserveMedia, settleMedia } from './usage'
import { failMedia, mediaEffects } from './service'
import { providerReason, unseeMedia, UnseenError, visualEffects } from './visual'

const notFound = () => new HttpError(404, 'That moment could not be found.')
export type SelfieReply = { status: 'ready'; media_id: string; url: string } | { status: 'queued'; media_id: string }

/** _id uniqueness is the per-player cap, independent of saves and failed jobs.
 * Released rows own no picture slot and survive event/save purges. */
async function reserveOwnAttempt(player_id: ObjectId, now: Date): Promise<ObjectId | undefined> {
  const { day } = utcMediaDay(now)
  for (let attempt = 0; attempt < 2; attempt++) {
    const _id = new ObjectId(createHash('sha256').update(`group-own-selfie:${player_id}:${day}:${attempt}`).digest('hex').slice(0, 24))
    try {
      await mongoColl.mediaUsage().insertOne({ _id, player_id, day, kind: 'picture', status: 'released', created_at: now })
      return _id
    } catch (error) { if (!duplicateKey(error)) throw error }
  }
  return undefined
}

/** Hold three guard slots until the real slot and daily attempt are reserved.
 * Counting then reserving would let concurrent turns spend the last pictures.
 * These are ordinary orphan-repairable reservations, never player-facing state. */
async function reserveOwnPicture(asset: MediaAssetDoc, now: Date): Promise<boolean> {
  const attempt = await reserveOwnAttempt(asset.player_id, now)
  if (!attempt) return false
  const guards = Array.from({ length: 3 }, () => new ObjectId())
  let started = false
  try {
    for (const _id of guards) if (!await reserveMedia({ _id, player_id: asset.player_id, kind: 'picture' }, now)) return false
    const reserved = await reserveMedia({ _id: asset._id, player_id: asset.player_id, instance_id: asset.instance_id, event_id: asset.event_id, kind: 'picture' }, now)
    if (!reserved || await mongoColl.mediaUsage().countDocuments({ _id: { $in: guards }, status: 'reserved' }) !== guards.length) return false
    started = true
    return true
  } finally {
    await mongoColl.mediaUsage().deleteMany({ _id: { $in: guards } })
    if (!started) await mongoColl.mediaUsage().deleteOne({ _id: attempt })
    // The caller removes the real reservation on an unsuccessful start.
  }
}

async function context(playerId: string, instanceId: string, eventId: string, line: { character_id: string; text: string }) {
  const pid = parseObjectId(playerId), iid = parseObjectId(instanceId), eid = parseObjectId(eventId)
  const instance = await mongoColl.worldInstances().findOne({ _id: iid, player_id: pid })
  const event = await mongoColl.events().findOne({ _id: eid, instance_id: iid, player_id: pid })
  if (!instance?.group_state || !instance.group_context || !event || !validGroupThread(event.data.dm_with)) throw notFound()
  const template = await mongoColl.worldTemplates().findOne({ _id: instance.template_id })
  if (template?.kind !== 'group') throw notFound()
  const index = (event.data.lines || []).findIndex(saved => saved.character_id === line.character_id && saved.text === line.text)
  const members = await loadGroupMembers(instance)
  const member = members.find(member => member.id === line.character_id)
  if (index < 0 || !member || (event.data.dm_with !== undefined && event.data.dm_with !== member.id)) throw notFound()
  const card = await mongoColl.characters().findOne({ _id: parseObjectId(member.id), instance_id: iid })
  if (!card || card.is_protagonist || card.canonical_name.toLowerCase() === instance.group_context.player.toLowerCase()) throw notFound()
  return { pid, iid, eid, instance, event, template, card, index }
}

function eventFence(event: WorldEventDoc) {
  return { _id: event._id, instance_id: event.instance_id, player_id: event.player_id,
    'data.ai_response': event.data.ai_response, 'data.player_input': event.data.player_input,
    ...groupThreadFilter(event.data.dm_with) }
}

/** Shared start for taps and after-reply agreements; resting is durable. */
export async function requestSelfie(playerId: string, instanceId: string, eventId: string, line: { character_id: string; text: string }): Promise<SelfieReply> {
  return (await startSelfie(playerId, instanceId, eventId, line))!
}

export async function requestOwnSelfie(playerId: string, instanceId: string, eventId: string, line: { character_id: string; text: string }, now = new Date()): Promise<SelfieReply | undefined> {
  return startSelfie(playerId, instanceId, eventId, line, now)
}

async function startSelfie(playerId: string, instanceId: string, eventId: string, line: { character_id: string; text: string }, ownAt?: Date): Promise<SelfieReply | undefined> {
  await requireIdentity(playerId)
  if (!mediaEnabled('picture')) throw notFound()
  const ctx = await context(playerId, instanceId, eventId, line)
  if (ownAt) {
    const holder = await resolvePortraitHolder(ctx.instance, ctx.card, { isSentient: false })
    const portrait = holder.portrait ?? ctx.card.portrait
    if (!portrait?.asset_key || !isReferenceAllowed(portrait.source)) return undefined
  }
  const lineId = groupLineId(line)
  const revision = mediaRevision(ctx.event.data.ai_response, ctx.event.data.player_input)
  // Model and toggle changes must not create a second live selfie for this line.
  const cacheKey = `${eventId}:selfie:${lineId}:${revision}`
  const existing = await mongoColl.mediaAssets().findOne({ cache_key: cacheKey })
  if (existing) return reply(existing)
  const asset: MediaAssetDoc = {
    _id: new ObjectId(), player_id: ctx.pid, instance_id: ctx.iid, event_id: ctx.eid,
    kind: 'picture', group_selfie: true, line_id: lineId, character_id: ctx.card._id,
    ...(ctx.event.data.dm_with === undefined ? {} : { direct_with: ctx.event.data.dm_with }),
    source: 'generated', model: imageModel(), cache_key: cacheKey, revision, input: '',
    cost_usd: 0.009, cost_source: 'catalogue', status: 'queued', created_at: new Date(),
  }
  try { await mongoColl.mediaAssets().insertOne(asset) }
  catch (error) {
    if (!duplicateKey(error)) throw error
    const winner = await mongoColl.mediaAssets().findOne({ cache_key: cacheKey })
    if (!winner) throw notFound()
    return reply(winner)
  }
  try {
    const reserved = ownAt ? await reserveOwnPicture(asset, ownAt)
      : await reserveMedia({ _id: asset._id, player_id: ctx.pid, instance_id: ctx.iid, event_id: ctx.eid, kind: 'picture' })
    if (ownAt && !reserved) {
      await mongoColl.mediaUsage().deleteOne({ _id: asset._id })
      await mongoColl.mediaAssets().deleteOne({ _id: asset._id })
      return undefined
    }
    const selfie: GroupSelfie = reserved ? { status: 'queued', media_id: String(asset._id) }
      : { status: 'resting', resets_at: utcMediaDay().resets_at }
    const saved = await mongoColl.events().updateOne(eventFence(ctx.event), { $set: { [`data.group_selfies.${lineId}`]: selfie } })
    if (!saved.matchedCount) throw notFound()
    await mediaEffects.publish(playerId, { type: 'selfie_started', instanceId, eventId, line_id: lineId,
      character_id: line.character_id, ...(asset.direct_with === undefined ? {} : { directWith: asset.direct_with }), selfie }).catch(() => {})
    if (!reserved) {
      await mongoColl.mediaAssets().deleteOne({ _id: asset._id })
      throw new HttpError(429, 'The painter rests until tomorrow.', { status: 'resting', kind: 'picture', resets_at: selfie.resets_at })
    }
    await visualEffects.enqueue('picture', asset, instanceId)
    return reply(asset)
  } catch (error) {
    if (!(error instanceof HttpError && error.statusCode === 429)) await failMedia(asset, { stage: 'enqueue', message: 'Picture could not be started' })
    throw error
  }
}

function reply(asset: MediaAssetDoc): SelfieReply {
  if (asset.status === 'ready' && asset.url) return { status: 'ready', media_id: String(asset._id), url: asset.url }
  return { status: 'queued', media_id: String(asset._id) }
}

/** Revalidate the source pair, audience, revision and line's current job. */
export async function liveSelfie(asset: MediaAssetDoc): Promise<WorldEventDoc | null> {
  if (!mediaEnabled('picture') || !asset.instance_id || !asset.event_id) return null
  const instance = await mongoColl.worldInstances().findOne({ _id: asset.instance_id, player_id: asset.player_id })
  const event = await mongoColl.events().findOne({ _id: asset.event_id, instance_id: asset.instance_id, player_id: asset.player_id })
  if (!instance?.group_state || !event || !validGroupThread(event.data.dm_with) || event.data.dm_with !== asset.direct_with ||
      mediaRevision(event.data.ai_response, event.data.player_input) !== asset.revision ||
      event.data.group_selfies?.[asset.line_id]?.media_id !== String(asset._id) ||
      !event.data.lines?.some(line => line.character_id === String(asset.character_id) && groupLineId(line) === asset.line_id)) return null
  return event
}

export function selfieFrame(asset: MediaAssetDoc) {
  return { line_id: asset.line_id, character_id: String(asset.character_id),
    ...(asset.direct_with === undefined ? {} : { directWith: asset.direct_with }) }
}

export async function storeSelfieState(asset: MediaAssetDoc, status: GroupSelfie['status'], url?: string): Promise<boolean> {
  const event = await liveSelfie(asset)
  if (!event) return false
  const result = await mongoColl.events().updateOne({ ...eventFence(event),
    [`data.group_selfies.${asset.line_id}.media_id`]: String(asset._id),
  }, { $set: { [`data.group_selfies.${asset.line_id}`]: { status, media_id: String(asset._id), ...(status === 'ready' && url ? { url } : {}) } } })
  return !!result.matchedCount
}

export async function discardSelfie(asset: MediaAssetDoc, uploadedKey?: string): Promise<void> {
  await releaseMedia(asset._id)
  const current = await mongoColl.mediaAssets().findOne({ _id: asset._id })
  const key = uploadedKey ?? current?.asset_key
  if (key) {
    try { await mediaEffects.remove(key) }
    catch {
      // A late upload may finish after purge deleted the row. Keep a cleanup
      // breadcrumb for the existing failed-object repair sweep in that case.
      const failed = { ...asset, status: 'failed' as const, asset_key: key, cache_key: `${asset.cache_key}:discarded:${asset._id}` }
      if (current) await mongoColl.mediaAssets().updateOne({ _id: asset._id }, { $set: { status: failed.status, asset_key: key, cache_key: failed.cache_key } })
      else {
        try { await mongoColl.mediaAssets().insertOne(failed) }
        catch (error) { if (!duplicateKey(error)) throw error }
      }
      return
    }
  }
  await mongoColl.mediaAssets().deleteOne({ _id: asset._id })
}

export async function notifySelfieReady(asset: MediaAssetDoc): Promise<void> {
  if (!await liveSelfie(asset) || !await mongoColl.mediaAssets().findOne({ _id: asset._id, status: 'ready' })) return
  if (!await storeSelfieState(asset, 'ready', asset.url)) return
  await mediaEffects.publish(String(asset.player_id), { type: 'media_ready', instanceId: String(asset.instance_id),
    eventId: String(asset.event_id), media_id: String(asset._id), kind: 'picture', url: asset.url, ...selfieFrame(asset) }).catch(() => {})
  await mongoColl.mediaAssets().updateOne({ _id: asset._id, status: 'ready' }, { $set: { notified_at: new Date() } })
}

export const selfieHeat = (mature: boolean) => mature
  ? 'Sensual and suggestive to the full allowed limit: revealing but covered clothing on adults, never nudity or a sexual act.'
  : 'Everyday, fully clothed, friendly, not flirty; no romantic, sensual or suggestive pose or clothing.'

export function selfieImagePrompt(description: string, mature: boolean): string {
  return `${description}. Semi-realistic glamorous digital painting, softly painted textures and cinematic light. Match the reference portrait exactly: the same fictional person, face, hair and illustrated look. A phone selfie at arm’s length, exactly one person, no other people and no player visible. ${selfieHeat(mature)} Vertical 9:16, clearly an illustration, never a photograph; no text, lettering, logos or signage.`
}

export async function processSelfie(mediaId: string): Promise<void> {
  const asset = await mongoColl.mediaAssets().findOneAndUpdate({ _id: parseObjectId(mediaId), status: 'queued', group_selfie: true },
    { $set: { status: 'processing', started_at: new Date() } }, { returnDocument: 'after' })
  if (!asset) return
  let uploaded: string | undefined
  let delivered = false
  let stage = 'prepare'
  try {
    const event = await liveSelfie(asset)
    if (!event || !await mongoColl.mediaUsage().findOne({ _id: asset._id, status: 'reserved' })) throw new Error('Picture moment passed')
    const line = event.data.lines!.find(line => groupLineId(line) === asset.line_id)!
    const ctx = await context(String(asset.player_id), String(asset.instance_id), String(asset.event_id), line)
    const user = await mongoColl.users().findOne({ _id: asset.player_id })
    const mature = user?.preferences?.nsfw_enabled === true && ctx.template.is_nsfw_capable === true
    const mayDeliver = async () => {
      const [currentUser, currentTemplate] = await Promise.all([
        mongoColl.users().findOne({ _id: asset.player_id }),
        mongoColl.worldTemplates().findOne({ _id: ctx.template._id }),
      ])
      return !!currentUser && currentTemplate?.kind === 'group' &&
        (!mature || (currentUser.preferences?.nsfw_enabled === true && currentTemplate.is_nsfw_capable === true)) && !!await liveSelfie(asset)
    }
    await storeSelfieState(asset, 'processing')
    const holder = await resolvePortraitHolder(ctx.instance, ctx.card, { isSentient: false })
    const portrait = holder.portrait ?? (ctx.card.portrait && isReferenceAllowed(ctx.card.portrait.source) ? ctx.card.portrait : undefined)
    if (!portrait || !isReferenceAllowed(portrait.source)) throw new Error('Picture has no reference portrait')
    const reference = asMediaImageReference(await visualEffects.download(portraitUrl(portrait.asset_key)))
    stage = 'description'
    const before = await mongoColl.events().find({ instance_id: ctx.iid, player_id: ctx.pid,
      ...groupThreadFilter(event.data.dm_with), sequence: { $lt: event.sequence } }).sort({ sequence: -1 }).limit(3).toArray()
    const moodLines = [...before.reverse().flatMap(turn => (turn.data.lines || []).map(line => line.text)),
      ...event.data.lines!.slice(0, ctx.index + 1).map(line => line.text)].slice(-4)
    const description = await describeSelfie({ look: holder.appearance, setting: ctx.template.global_lore,
      moodLines, heat: selfieHeat(mature) })
    const pre = await moderateDescription(description, !mature)
    if (pre.verdict !== 'allow') throw new UnseenError('pre', pre.reason_code)
    const prompt = selfieImagePrompt(description, mature)
    // The fixed framing and heat are part of what the image model receives, and gated too.
    const promptGate = await moderateDescription(prompt, !mature)
    if (promptGate.verdict !== 'allow') throw new UnseenError('pre', promptGate.reason_code)
    if (!await liveSelfie(asset)) throw new Error('Picture moment passed')
    stage = 'generate'
    const image = await visualEffects.image(prompt, { model: asset.model, aspectRatio: '9:16', reference })
    const post = await checkImage(image.data, image.contentType, !mature)
    if (post.verdict !== 'allow' || post.text_visible || post.people_count !== 1) {
      throw new UnseenError('post', post.verdict !== 'allow' ? post.reason_code : post.text_visible ? 'picture_text_visible' : 'selfie_not_single_person')
    }
    if (!await mayDeliver()) throw new Error('Picture moment passed')
    stage = 'upload'
    const key = `media/picture/${asset.player_id}/${asset.instance_id}/${asset._id}${imageExtensionFor(image.contentType)}`
    const staged = await mongoColl.mediaAssets().updateOne({ _id: asset._id, status: 'processing' }, { $set: { asset_key: key, input: description, reference_asset_key: portrait.asset_key } })
    if (!staged.matchedCount) throw new Error('Picture removed')
    uploaded = key
    const result = await visualEffects.upload(image.data, image.contentType, { key })
    uploaded = result.key
    if (!await mayDeliver()) throw new Error('Picture moment passed')
    const saved = await mongoColl.mediaAssets().updateOne({ _id: asset._id, status: 'processing' }, { $set: {
      status: 'ready', asset_key: result.key, url: result.url, cost_usd: image.costUsd ?? asset.cost_usd,
      ...(image.generationId ? { generation_id: image.generationId } : {}),
    } })
    if (!saved.matchedCount || !await storeSelfieState(asset, 'ready', result.url)) throw new Error('Picture removed')
    delivered = true
    await settleMedia(asset._id)
    await notifySelfieReady({ ...asset, url: result.url, status: 'ready' })
  } catch (error) {
    if (delivered) return
    if (!await liveSelfie(asset)) { await discardSelfie(asset, uploaded); return }
    if (uploaded) {
      try { await mediaEffects.remove(uploaded) } catch { /* The failed row retains its key for repair. */ }
    }
    if (error instanceof UnseenError) await unseeMedia(asset, error.stage, error.reason)
    else if (error instanceof ProviderRefusalError) await unseeMedia(asset, 'provider', providerReason(error), undefined, { message: error.message, status: error.status })
    else await failMedia(asset, { stage, message: error instanceof Error ? error.message : String(error) })
  }
}
