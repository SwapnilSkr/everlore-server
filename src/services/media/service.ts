import { requireIdentity } from '../guest-policy'
import { ObjectId } from 'mongodb'
import { mongoColl } from '../../config/mongo'
import { getRedisClient } from '../../config/redis'
import { getMediaQueue, QUEUE_RETENTION } from '../../queues'
import { synthesizeSpeech } from '../../ai/tts'
import { env } from '../../config/env'
import { HttpError } from '../../utils/http-error'
import { parseObjectId } from '../../utils/mongo-id'
import type { CharacterVoice, MediaAssetDoc, SpokenLine } from '../../models/media.model'
import type { CharacterProfileDoc } from '../../models/character-profile.model'
import type { WorldInstanceDoc } from '../../models/world-instance.model'
import type { WorldEventDoc } from '../../models/world-event.model'
import { storageService } from '../storage.service'
import { log } from '../../utils/logger'
import { attributeEvent, mediaRevision, resolveAttributedSpeaker } from './attribution'
import { castCharacter, castKey } from './casting'
import { mediaEnabled, voiceCatalogue } from './config'
import { matureVoiceAllowed, utcMediaDay } from './policy'
import { detectSpokenLines } from './detection'
import { duplicateKey, releaseMedia, reserveMedia, settleMedia } from './usage'
import { mp3DurationMs } from './audio'

export type VoiceReply = { status: 'ready'; url: string; duration_ms: number } | { status: 'queued'; media_id: string }
export const mediaEffects = {
  cast: castCharacter,
  enqueue: async (asset: MediaAssetDoc, instanceId: string) => {
    await getMediaQueue().add('voice', { mediaId: asset._id.toHexString(), instanceId }, {
      jobId: asset._id.toHexString(), attempts: 1, priority: 1, ...QUEUE_RETENTION.media,
    })
  },
  synthesize: synthesizeSpeech,
  upload: storageService.upload.bind(storageService),
  remove: storageService.deleteStrict.bind(storageService),
  publish: async (playerId: string, message: Record<string, unknown>) => { await getRedisClient().publish(`user:${playerId}:events`, JSON.stringify(message)) },
  cost: async (generationId: string): Promise<number | undefined> => {
    try {
      const response = await fetch(`https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(generationId)}`, {
        headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}` }, signal: AbortSignal.timeout(2000),
      })
      if (!response.ok) return undefined
      const body = await response.json() as { data?: { total_cost?: unknown } }
      const cost = body.data?.total_cost
      return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : undefined
    } catch { return undefined }
  },
}
export const readyReply = (asset: MediaAssetDoc): VoiceReply | undefined => asset.status === 'ready' && asset.url && asset.duration_ms
  ? { status: 'ready', url: asset.url, duration_ms: asset.duration_ms } : undefined

/** Pin a card's first voice on the line too, so merges cannot change its cache identity. */
export async function lineVoice(instance: WorldInstanceDoc, event: WorldEventDoc, line: SpokenLine, card?: CharacterProfileDoc): Promise<CharacterVoice> {
  if (line.voice?.status !== 'voiceable') throw new Error('Line is not speech')
  if (line.voice.voice_id && line.voice.model) return { voice_id: line.voice.voice_id, model: line.voice.model }
  if (!card) throw new Error('Speaker missing')
  const voice = await mediaEffects.cast(instance, card, line.voice.voice_traits ?? {})
  const index = event.data.spoken_lines?.findIndex((l) => l.line_id === line.line_id) ?? -1
  if (index < 0) throw new Error('Line removed')
  const path = `data.spoken_lines.${index}.voice`
  const filter = { _id: event._id, 'data.media_revision': mediaRevision(event.data.ai_response, event.data.player_input),
    'data.ai_response': event.data.ai_response, 'data.player_input': event.data.player_input }
  const saved = await mongoColl.events().findOneAndUpdate({ ...filter, [`${path}.model`]: { $exists: false } }, {
    $set: { [`${path}.model`]: voice.model, [`${path}.voice_id`]: voice.voice_id },
  }, { returnDocument: 'after' })
  const current = saved ?? await mongoColl.events().findOne(filter)
  const pinned = current?.data.spoken_lines?.[index].voice
  if (pinned?.status !== 'voiceable' || !pinned.model || !pinned.voice_id) throw new Error('Line removed')
  return { model: pinned.model, voice_id: pinned.voice_id }
}

export async function requestVoice(playerId: string, instanceId: string, eventId: string, lineId: string): Promise<VoiceReply> {
  await requireIdentity(playerId)
  if (!mediaEnabled('voice')) throw new HttpError(404, 'That moment could not be found.')
  const pid = parseObjectId(playerId), iid = parseObjectId(instanceId), eid = parseObjectId(eventId)
  const instance = await mongoColl.worldInstances().findOne({ _id: iid, player_id: pid })
  if (!instance) throw new HttpError(404, 'That story could not be found.')
  const [event, template, user] = await Promise.all([
    mongoColl.events().findOne({ _id: eid, instance_id: iid, player_id: pid }),
    mongoColl.worldTemplates().findOne({ _id: instance.template_id }),
    mongoColl.users().findOne({ _id: pid }, { projection: { 'preferences.nsfw_enabled': 1 } }),
  ])
  if (!event || !template) throw new HttpError(404, 'That moment could not be found.')
  if (!matureVoiceAllowed(event.nsfw_intent, user?.preferences?.nsfw_enabled === true)) throw new HttpError(422, 'This line stays quiet.', { status: 'unvoiceable' })
  if (!/^l\d+$/u.test(lineId)) throw new HttpError(422, 'This line stays quiet.', { status: 'unvoiceable' })
  if (!detectSpokenLines(event.data.ai_response, event.data.player_spoken_input ?? event.data.player_input).some((l) => l.line_id === lineId)) throw new HttpError(422, 'This line stays quiet.', { status: 'unvoiceable' })
  const lines = await attributeEvent(event, template.is_sentient, instance.persona_snapshot?.name)
  const line = lines.find((l) => l.line_id === lineId)
  if (line?.voice?.status !== 'voiceable') throw new HttpError(422, 'This line stays quiet.', { status: 'unvoiceable' })
  const cards = await mongoColl.characters().find({ instance_id: iid, player_id: pid }).sort({ first_seen_sequence: 1 }).toArray()
  const card = resolveAttributedSpeaker(line.voice, cards, template.is_sentient, instance.persona_snapshot?.name)
  let voice: Awaited<ReturnType<typeof castCharacter>>
  try {
    voice = await lineVoice(instance, { ...event, data: { ...event.data, spoken_lines: lines } }, line, card)
    voiceCatalogue(voice.model)
  } catch { throw new HttpError(422, 'This line stays quiet.', { status: 'unvoiceable' }) }
  const revision = mediaRevision(event.data.ai_response, event.data.player_input)
  const key = `${eid}:${lineId}:${voice.voice_id}:${voice.model}`
  let asset = await mongoColl.mediaAssets().findOne({ cache_key: key })
  if (asset && asset.revision !== revision) {
    // The edit path invalidates old rows; never serve one while its purge is in flight.
    throw new HttpError(422, 'This line stays quiet.', { status: 'unvoiceable' })
  }
  if (asset) {
    if (!await liveVoice(asset)) throw new HttpError(422, 'This line stays quiet.', { status: 'unvoiceable' })
    return readyReply(asset) || { status: 'queued', media_id: asset._id.toHexString() }
  }
  const input = [...line.voice.tags, line.voice.spoken_text].join(' ')
  asset = { _id: new ObjectId(), player_id: pid, instance_id: iid, event_id: eid, kind: 'voice', line_id: lineId,
    ...(card ? { character_id: card._id } : {}), source: 'generated', ...voice, cache_key: key, revision, input,
    cost_usd: input.length * voiceCatalogue(voice.model).rate_usd_per_character, cost_source: 'catalogue', status: 'queued', created_at: new Date() }
  try { await mongoColl.mediaAssets().insertOne(asset) } catch (error) {
    if (!duplicateKey(error)) throw error
    const winner = await mongoColl.mediaAssets().findOne({ cache_key: key })
    if (!winner || !await liveVoice(winner)) throw new HttpError(422, 'This line stays quiet.', { status: 'unvoiceable' })
    return readyReply(winner) || { status: 'queued', media_id: winner._id.toHexString() }
  }
  try {
    if (!await liveVoice(asset)) throw new HttpError(422, 'This line stays quiet.', { status: 'unvoiceable' })
    if (!await reserveMedia({ ...asset, kind: 'voice' })) {
      await mongoColl.mediaAssets().deleteOne({ _id: asset._id })
      throw new HttpError(429, 'Their voices rest until tomorrow.', { status: 'resting', kind: 'voice', resets_at: utcMediaDay().resets_at })
    }
    await mediaEffects.enqueue(asset, instanceId)
  } catch (error) {
    if (error instanceof HttpError && error.statusCode === 429) throw error
    await failMedia(asset, { stage: 'request', message: error instanceof Error ? error.message : String(error) })
    if (error instanceof HttpError) throw error
    return { status: 'queued', media_id: asset._id.toHexString() }
  }
  // 1.2s catches the probe's ~0.8s voice calls without tying up a long request.
  for (let i = 0; i < 12; i++) {
    await Bun.sleep(100)
    const current = await mongoColl.mediaAssets().findOne({ _id: asset._id })
    if (current && await liveVoice(current)) { const ready = readyReply(current); if (ready) return ready }
  }
  return { status: 'queued', media_id: asset._id.toHexString() }
}

async function liveVoice(asset: MediaAssetDoc): Promise<boolean> {
  if (!mediaEnabled('voice')) return false
  if (!asset.event_id || asset.kind === 'passing_face') return false
  const [instance, event, user] = await Promise.all([
    mongoColl.worldInstances().findOne({ _id: asset.instance_id, player_id: asset.player_id }),
    mongoColl.events().findOne({ _id: asset.event_id, instance_id: asset.instance_id, player_id: asset.player_id, 'data.media_revision': asset.revision }),
    mongoColl.users().findOne({ _id: asset.player_id }, { projection: { 'preferences.nsfw_enabled': 1 } }),
  ])
  return !!instance && !!event && mediaRevision(event.data.ai_response, event.data.player_input) === asset.revision && matureVoiceAllowed(event.nsfw_intent, user?.preferences?.nsfw_enabled === true)
}
export interface MediaFailure {
  stage: string
  message: string
}

/**
 * Cut to 300 characters with no URLs that carry tokens. Provider messages
 * echo request URLs (signed CDN/object URLs ride in them), so every URL is
 * redacted structurally — not only known hosts.
 */
export function sanitizeMediaError(message: string): string {
  return message.replace(/https?:\/\/\S+/gu, '[url]').slice(0, 300)
}

export async function failMedia(asset: MediaAssetDoc, cause: MediaFailure): Promise<void> {
  const message = sanitizeMediaError(cause.message)
  log.warn('media.process_failed', { kind: asset.kind, media_id: asset._id.toHexString(), stage: cause.stage, error: message })
  const [instance, event, player] = await Promise.all([
    mongoColl.worldInstances().findOne({ _id: asset.instance_id }),
    asset.event_id ? mongoColl.events().findOne({ _id: asset.event_id }) : null,
    mongoColl.users().findOne({ _id: asset.player_id }, { projection: { 'preferences.nsfw_enabled': 1 } }),
  ])
  if (!instance || (asset.event_id && !event) || !player) {
    const current = await mongoColl.mediaAssets().findOne({ _id: asset._id })
    if (current?.asset_key) await mediaEffects.remove(current.asset_key)
    await mongoColl.mediaAssets().deleteOne({ _id: asset._id })
    await mongoColl.mediaUsage().deleteOne({ _id: asset._id })
    return
  }
  await mongoColl.mediaAssets().updateOne({ _id: asset._id, status: { $ne: 'ready' } }, { $set: {
    status: 'failed', cache_key: `${asset.cache_key}:failed:${asset._id}`, error: { stage: cause.stage, message },
  } })
  await releaseMedia(asset._id)
  if (asset.kind === 'passing_face') return
  await mediaEffects.publish(asset.player_id.toHexString(), { type: 'media_failed', ...(asset.instance_id ? { instanceId: asset.instance_id.toHexString() } : {}), ...(asset.event_id ? { eventId: asset.event_id.toHexString() } : {}), media_id: asset._id.toHexString(), kind: asset.kind }).catch(() => {})
}
export async function processVoice(mediaId: string): Promise<void> {
  const _id = parseObjectId(mediaId)
  const asset = await mongoColl.mediaAssets().findOneAndUpdate({ _id, status: 'queued' }, { $set: { status: 'processing', started_at: new Date() } }, { returnDocument: 'after' })
  if (!asset) return // BullMQ stalled redelivery can never issue another paid call.
  let uploaded: string | undefined
  let delivered = false
  let stage = 'prepare'
  try {
    if (!asset.voice_id) throw new Error('Voice missing')
    const reservation = await mongoColl.mediaUsage().findOne({ _id, status: 'reserved' })
    if (!reservation || !await liveVoice(asset)) throw new Error('Voice no longer available')
    stage = 'synthesize'
    const audio = await mediaEffects.synthesize({ model: asset.model, voice: asset.voice_id, input: asset.input, responseFormat: 'mp3', signal: AbortSignal.timeout(15000) })
    if (audio.generationId) {
      const cost = await mediaEffects.cost(audio.generationId)
      await mongoColl.mediaAssets().updateOne({ _id }, { $set: { generation_id: audio.generationId, ...(cost !== undefined ? { cost_usd: cost, cost_source: 'generation' as const } : {}) } })
    }
    const duration_ms = mp3DurationMs(audio.data)
    if (!await liveVoice(asset)) throw new Error('Voice no longer available')
    stage = 'upload'
    const key = `media/voice/${asset.player_id}/${asset.instance_id}/${_id}.mp3`
    const staged = await mongoColl.mediaAssets().updateOne({ _id, status: 'processing' }, { $set: { asset_key: key } })
    if (!staged.matchedCount) throw new Error('Voice removed')
    uploaded = key // An ambiguous upload failure may still have written this object.
    const result = await mediaEffects.upload(audio.data, 'audio/mpeg', { key })
    uploaded = result.key
    if (!await liveVoice(asset)) throw new Error('Voice no longer available')
    stage = 'save'
    const saved = await mongoColl.mediaAssets().updateOne({ _id, status: 'processing' }, { $set: { status: 'ready', asset_key: result.key, url: result.url, duration_ms } })
    if (!saved.modifiedCount) throw new Error('Voice removed')
    delivered = true
    await settleMedia(_id)
    const now = new Date()
    const card = asset.character_id
      ? await mongoColl.characters().findOne({ _id: asset.character_id, instance_id: asset.instance_id })
      : null
    if (card) {
      await mongoColl.characters().updateOne({ _id: card._id }, { $set: { last_spoken_at: now } })
      await mongoColl.worldInstances().updateOne({ _id: asset.instance_id }, { $set: { [`media_voice_cast.${castKey(card)}.last_spoken_at`]: now } })
    }
    stage = 'notify'
    await notifyReady({ ...asset, status: 'ready', url: result.url })
  } catch (error) {
    // Delivery is durable before telemetry/notification. A later failure must never delete it.
    if (delivered) { await settleMedia(_id); return }
    if (uploaded) {
      try {
        await mediaEffects.remove(uploaded)
        await mongoColl.mediaAssets().updateOne({ _id }, { $unset: { asset_key: '' } })
      } catch { /* The failed row retains its key; maintenance retries object removal. */ }
    }
    await failMedia(asset, { stage, message: error instanceof Error ? error.message : String(error) })
  }
}

async function notifyReady(asset: MediaAssetDoc): Promise<void> {
  if (!await liveVoice(asset) || !await mongoColl.mediaAssets().findOne({ _id: asset._id, status: 'ready' })) return
  await mediaEffects.publish(asset.player_id.toHexString(), { type: 'media_ready', ...(asset.instance_id ? { instanceId: asset.instance_id.toHexString() } : {}), eventId: asset.event_id?.toHexString(), media_id: String(asset._id), kind: asset.kind, line_id: asset.line_id, url: asset.url })
  await mongoColl.mediaAssets().updateOne({ _id: asset._id, status: 'ready' }, { $set: { notified_at: new Date() } })
}

/** Repair abandoned reservations without retrying a provider submission. */
export async function repairMediaReservations(now = new Date()): Promise<void> {
  const abandoned = await mongoColl.mediaAssets().find({
    status: { $in: ['queued', 'processing'] }, created_at: { $lt: new Date(now.getTime() - 300000) },
  }).toArray()
  for (const asset of abandoned) await failMedia(asset, { stage: 'repair', message: 'abandoned reservation' })
  for (const asset of await mongoColl.mediaAssets().find({ status: 'ready', notified_at: { $exists: false } }).toArray()) await notifyReady(asset)
  for (const asset of await mongoColl.mediaAssets().find({ status: 'failed', asset_key: { $exists: true } }).toArray()) {
    await mediaEffects.remove(asset.asset_key!)
    await mongoColl.mediaAssets().updateOne({ _id: asset._id, status: 'failed' }, { $unset: { asset_key: '' } })
  }
  const ready = await mongoColl.mediaUsage().find({ status: 'reserved' }).toArray()
  for (const row of ready) {
    const asset = await mongoColl.mediaAssets().findOne({ _id: row._id })
    if (asset?.status === 'ready') await settleMedia(row._id)
    else if (!asset || asset.status === 'failed') await releaseMedia(row._id)
  }
}
