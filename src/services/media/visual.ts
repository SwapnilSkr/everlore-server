import { ObjectId } from 'mongodb'
import { mongoColl } from '../../config/mongo'
import { getMediaQueue, QUEUE_RETENTION } from '../../queues'
import { generateMediaImage, asMediaImageReference, imageExtensionFor, ProviderRefusalError } from '../../ai/image'
import { submitVideo, awaitVideo, downloadVideo } from '../../ai/video'
import { AI_MODELS } from '../../ai/models'
import { env } from '../../config/env'
import { HttpError } from '../../utils/http-error'
import { parseObjectId } from '../../utils/mongo-id'
import type { CharacterProfileDoc } from '../../models/character-profile.model'
import type { MediaAssetDoc, MediaKind, PortraitRef } from '../../models/media.model'
import type { WorldEventDoc } from '../../models/world-event.model'
import { storageService } from '../storage.service'
import { attributeEvent, mediaRevision, resolveVoiceSpeaker } from './attribution'
import { directorModel, imageModel, mediaEnabled, sceneFallbackModel, sceneModel, videoModel, voiceCatalogue } from './config'
import { detectSpokenLines } from './detection'
import { directScene, validateDirectorPlan, type DirectorInput, type DirectorPlan } from './director'
import { matureVoiceAllowed, utcMediaDay } from './policy'
import { isPortraitCurrent, isReferenceAllowed, portraitCacheKey, resolvePortraitHolder, storePortrait } from './portraits'
import { checkImage, checkVideoFrames, describeMoment, judgeShotFrames, logRejection, moderateDescription, safetyEffects } from './safety'
import { compileLinePrompt, compileMotionPrompt, compileStillPrompt } from './scene-templates'
import { assembleCut, cutEffects, normalizeShot } from './cut'
import { duplicateKey, releaseMedia, reserveMedia, settleMedia } from './usage'
import { mp3DurationMs } from './audio'
import { failMedia, mediaEffects, sanitizeMediaError } from './service'
import { log } from '../../utils/logger'

export type QueuedReply = { status: 'ready'; url: string; duration_ms?: number } | { status: 'queued'; media_id: string }

export const visualEffects = {
  image: generateMediaImage,
  submit: submitVideo,
  wait: awaitVideo,
  fetch: downloadVideo,
  fill: fillUnknownLook,
  enqueue: (kind: MediaKind, asset: MediaAssetDoc, instanceId: string) => {
    const priority = kind === 'portrait' ? 2 : kind === 'picture' ? 3 : 4
    return getMediaQueue().add(kind, { mediaId: asset._id.toHexString(), instanceId }, {
      jobId: asset._id.toHexString(), attempts: 1, priority, ...QUEUE_RETENTION.media,
    })
  },
  upload: storageService.upload.bind(storageService),
  download: async (url: string): Promise<Buffer> => {
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) })
    if (!res.ok) throw new Error(`Reference download failed (${res.status})`)
    return Buffer.from(await res.arrayBuffer())
  },
  prices: (() => {    let cached: { at: number; rates: Record<string, { prompt: number; completion: number }> } | null = null
    return async (model: string): Promise<{ prompt: number; completion: number }> => {
      if (cached && Date.now() - cached.at < 3600000 && cached.rates[model]) return cached.rates[model]
      try {
        const res = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(15000) })
        const data = await res.json() as { data: Array<{ id: string; pricing: { prompt: number; completion: number } }> }
        const rates: Record<string, { prompt: number; completion: number }> = {}
        for (const m of data.data || []) rates[m.id] = { prompt: Number(m.pricing.prompt), completion: Number(m.pricing.completion) }
        cached = { at: Date.now(), rates }
        if (rates[model]) return rates[model]
      } catch { /* fall through to the bake-off rate */ }
      return { prompt: 0.000002, completion: 0.00001 }
    }
  })(),
}

const RESTING_COPY: Record<string, string> = {
  picture: 'The painter rests until tomorrow.',
  video: 'The visions rest until tomorrow.',
  // Portraits rest silently (contract §8): no player-facing sentence, only the
  // resting details below. "Media" is technical copy a player never reads.
  portrait: '',
}

const portraitUrl = (assetKey: string) =>
  `${env.CDN_BASE_URL.replace(/\/+$/, '')}/${assetKey}`

/** A gate rejection inside a synchronous generation core. The caller turns
 * it into `media_unseen` (standalone job) or degrades (inline use). */
export class UnseenError extends Error {
  constructor(readonly stage: 'pre' | 'post', readonly reason: string) {
    super(`unseen:${stage}:${reason}`)
  }
}

/** The reason logged for a provider content refusal: the HTTP status only,
 * never words from the provider's message (which provider and model the row
 * already records). */
export const providerReason = (error: ProviderRefusalError): string => `provider_${error.status}`

interface PortraitBytes {
  data: Buffer
  contentType: string
  costUsd?: number
  generationId: string | null
}

/**
 * The exact portrait image prompt: the moderated description plus the fixed
 * style suffix. One builder so the audit and the live check assert on the
 * same string the job sends.
 */
export function portraitImagePrompt(description: string): string {
  return `${description}. SFW head-and-shoulders portrait, plain dark background, vertical 9:16. Stylized cinematic painting with visible painterly texture: clearly an illustration of a fictional person, never a photograph.`
}

/** The portrait generation core: gates then paint. Shared by the queued job
 * and inline use inside picture/video jobs (no queue deadlock, no double
 * charge: the caller's reservation covers it). Exported for the one-off live
 * audit check; the jobs call it internally. */
export async function generatePortraitBytes(
  appearance: string,
  name: string,
  place: string,
  model: string,
  reference?: { data: Buffer; contentType: string },
): Promise<PortraitBytes> {
  const description = await describeMoment({
    prose: appearance,
    present: [{ name, has_portrait: !!reference }],
    passing_look: '',
    framing: 'portrait',
    place,
  })
  const pre = await moderateDescription(description)
  if (pre.verdict !== 'allow') throw new UnseenError('pre', pre.reason_code)
  // What is gated is what is painted: the image prompt is the moderated
  // description plus the fixed style suffix. The raw look never reaches the
  // image model (a scar in the look once tripped the provider filter while
  // the gated description painted cleanly).
  const image = await visualEffects.image(
    portraitImagePrompt(description),
    { model, aspectRatio: '9:16', ...(reference ? { reference } : {}) },
  )
  const post = await checkImage(image.data, image.contentType)
  if (post.verdict !== 'allow' || post.people_count !== 1) {
    throw new UnseenError('post', post.verdict !== 'allow' ? post.reason_code : 'portrait_not_single_face')
  }
  return { data: image.data, contentType: image.contentType, generationId: image.generationId, ...(image.costUsd !== undefined ? { costUsd: image.costUsd } : {}) }
}

/**
 * The face a job needs, painted synchronously when missing. Reserves and
 * settles its own portrait slot and stores a ready portrait row, so later
 * taps hit the cache and cost nothing. Throws UnseenError when the gates
 * refuse the face; throws HttpError 429 when portraits rest.
 */
export async function ensurePortraitReady(
  playerId: string, instanceId: string, card: CharacterProfileDoc,
): Promise<{ url: string; version: number; assetKey: string }> {
  const pid = parseObjectId(playerId), iid = parseObjectId(instanceId)
  const instance = await mongoColl.worldInstances().findOne({ _id: iid, player_id: pid })
  if (!instance) throw new HttpError(404, 'That story could not be found.')
  const template = await mongoColl.worldTemplates().findOne({ _id: instance.template_id })
  const holder = await resolvePortraitHolder(instance, card, {
    isSentient: template?.is_sentient ?? false, personaName: instance.persona_snapshot?.name,
    ...(instance.persona_id ? { personaId: instance.persona_id } : {}),
  })
  if (isPortraitCurrent(holder)) {
    return {
      url: portraitUrl(holder.portrait!.asset_key),
      version: holder.portrait!.appearance_version,
      assetKey: holder.portrait!.asset_key,
    }
  }
  const id = new ObjectId()
  if (!await reserveMedia({ _id: id, player_id: pid, instance_id: iid, kind: 'portrait' })) {
    throw new HttpError(429, RESTING_COPY.portrait, { status: 'resting', kind: 'portrait', resets_at: utcMediaDay().resets_at })
  }
  try {
    const appearance = holder.appearance.trim() || await visualEffects.fill(card, '')
    let reference: { data: Buffer; contentType: string } | undefined
    if (holder.portrait) {
      reference = asMediaImageReference(await visualEffects.download(portraitUrl(holder.portrait.asset_key)))
    }
    const image = await generatePortraitBytes(appearance, card.canonical_name, template?.title || '', imageModel(), reference)
    const key = `media/portrait/${pid.toHexString()}/${iid.toHexString()}/${id.toHexString()}${imageExtensionFor(image.contentType)}`
    const result = await visualEffects.upload(image.data, image.contentType, { key })
    const version = (holder.portrait?.appearance_version ?? holder.appearanceVersion) + (holder.portrait ? 1 : 0) || 1
    const portrait: PortraitRef = { asset_key: result.key, source: 'generated', appearance_version: version, painted_at: new Date() }
    await storePortrait(instance, card, holder, portrait, appearance, {
      ...(instance.persona_id ? { personaId: instance.persona_id } : {}),
    })
    await mongoColl.mediaAssets().insertOne({
      _id: id, player_id: pid, instance_id: iid, kind: 'portrait', line_id: '', character_id: card._id,
      source: 'generated', model: imageModel(), cache_key: portraitCacheKey(card._id, version, imageModel()),
      revision: mediaRevision(appearance, String(version)), input: appearance.slice(0, 500),
      cost_usd: image.costUsd ?? 0.009, cost_source: image.costUsd !== undefined ? 'generation' as const : 'catalogue' as const,
      status: 'ready', asset_key: result.key, url: result.url, created_at: new Date(),
      ...(image.generationId ? { generation_id: image.generationId } : {}),
    })
    await settleMedia(id)
    return { url: result.url, version, assetKey: result.key }
  } catch (error) {
    if (error instanceof UnseenError) {
      await releaseMedia(id)
      await logRejection({ _id: id, player_id: pid, instance_id: iid, kind: 'portrait' }, error.stage, error.reason, imageModel())
    } else {
      await releaseMedia(id)
    }
    throw error
  }
}

async function loadContext(playerId: string, instanceId: string, eventId?: string) {
  const pid = parseObjectId(playerId), iid = parseObjectId(instanceId)
  const instance = await mongoColl.worldInstances().findOne({ _id: iid, player_id: pid })
  if (!instance) throw new HttpError(404, 'That story could not be found.')
  const [template, user] = await Promise.all([
    mongoColl.worldTemplates().findOne({ _id: instance.template_id }),
    mongoColl.users().findOne({ _id: pid }, { projection: { 'preferences.nsfw_enabled': 1 } }),
  ])
  if (!template) throw new HttpError(404, 'That moment could not be found.')
  let event: WorldEventDoc | null = null
  if (eventId) {
    event = await mongoColl.events().findOne({ _id: parseObjectId(eventId), instance_id: iid, player_id: pid })
    if (!event) throw new HttpError(404, 'That moment could not be found.')
  }
  return { pid, iid, instance, template, user, event }
}

function liveRevision(asset: MediaAssetDoc, event: WorldEventDoc): boolean {
  return mediaRevision(event.data.ai_response, event.data.player_input) === asset.revision
}

async function liveMedia(asset: MediaAssetDoc): Promise<WorldEventDoc | null> {
  if (!mediaEnabled(asset.kind)) return null
  const [instance, event] = await Promise.all([
    mongoColl.worldInstances().findOne({ _id: asset.instance_id, player_id: asset.player_id }),
    asset.event_id
      ? mongoColl.events().findOne({ _id: asset.event_id, instance_id: asset.instance_id, player_id: asset.player_id })
      : null,
  ])
  if (!instance) return null
  if (asset.event_id && (!event || !liveRevision(asset, event))) return null
  return event
}

async function notifyMedia(asset: MediaAssetDoc): Promise<void> {
  if (!await liveMedia(asset)) return
  const iid = asset.instance_id
  if (!iid) return // Standalone persona rows notify through their own path.
  if (!await mongoColl.mediaAssets().findOne({ _id: asset._id, status: 'ready' })) return
  await mediaEffects.publish(asset.player_id.toHexString(), {
    type: 'media_ready',
    instanceId: iid.toHexString(),
    eventId: asset.event_id?.toHexString(),
    media_id: asset._id.toHexString(),
    kind: asset.kind,
    url: asset.url,
    ...(asset.line_id ? { line_id: asset.line_id } : {}),
    ...(asset.character_id ? { character_id: asset.character_id.toHexString() } : {}),
  }).catch(() => {})
  await mongoColl.mediaAssets().updateOne({ _id: asset._id, status: 'ready' }, { $set: { notified_at: new Date() } })
}

/** A gate rejection: delete the file, release the slot, stay unseen, log it.
 * A provider refusal also keeps its reason: the sanitised provider message
 * lands on the unseen row (`error`), on the rejection row (`message`) and in
 * one `media.provider_refused` warn line — so a plain provider bug can never
 * go silent as a bare `provider_400`. */
export async function unseeMedia(
  asset: MediaAssetDoc,
  stage: 'pre' | 'post' | 'provider',
  reason: string,
  uploadedKey?: string,
  provider?: { message: string; status: number },
): Promise<void> {
  if (uploadedKey) {
    try {
      await mediaEffects.remove(uploadedKey)
    } catch { /* The unseen row retains its key; maintenance retries removal. */ }
  }
  // Sanitised once, stored in three places: URLs redacted, at most 300 chars.
  const message = provider ? sanitizeMediaError(provider.message) : undefined
  await mongoColl.mediaAssets().updateOne({ _id: asset._id, status: { $ne: 'ready' } }, {
    $set: {
      status: 'unseen',
      cache_key: `${asset.cache_key}:unseen:${asset._id.toHexString()}`,
      ...(message !== undefined ? { error: { stage: 'provider', message } } : {}),
    },
    ...(uploadedKey ? {} : { $unset: { asset_key: '' } }),
  })
  await releaseMedia(asset._id)
  await logRejection(asset, stage, reason, asset.model, message)
  if (message !== undefined && provider) {
    log.warn('media.provider_refused', { kind: asset.kind, media_id: asset._id.toHexString(), status: provider.status, message })
  }
  await mediaEffects.publish(asset.player_id.toHexString(), {
    type: 'media_unseen',
    ...(asset.instance_id ? { instanceId: asset.instance_id.toHexString() } : {}),
    eventId: asset.event_id?.toHexString(),
    media_id: asset._id.toHexString(),
    kind: asset.kind,
  }).catch(() => {})
}

async function insertAsset(row: Omit<MediaAssetDoc, '_id' | 'created_at'>): Promise<MediaAssetDoc | null> {
  const asset = { ...row, _id: new ObjectId(), created_at: new Date() } as MediaAssetDoc
  try {
    await mongoColl.mediaAssets().insertOne(asset)
    return asset
  } catch (error) {
    if (!duplicateKey(error)) throw error
    return mongoColl.mediaAssets().findOne({ cache_key: row.cache_key })
  }
}

/** Cards named in the prose, by name-appears-in-text grounding (structural). */
function presentCards(prose: string, cards: CharacterProfileDoc[], personaName?: string): CharacterProfileDoc[] {
  const flat = prose.toLowerCase()
  return cards.filter((c) => {
    const names = [c.canonical_name, ...(c.aliases || [])].filter((n) => n.trim().length >= 3)
    if (personaName && names.some((n) => n.toLowerCase() === personaName.toLowerCase())) return false
    return names.some((n) => flat.includes(n.toLowerCase()))
  }).slice(0, 4)
}

/** An unknown look is filled in at the first portrait and becomes canon. */
async function fillUnknownLook(card: CharacterProfileDoc, prose: string): Promise<string> {
  const raw = await safetyEffects.call({
    model: AI_MODELS.metadata,
    timeoutMs: 30000,
    maxTokens: 256,
    temperature: 0.3,
    purpose: 'media_portrait_look',
    messages: [{
      role: 'system',
      content: 'Write a concrete two-sentence look for this person, consistent with everything given (role, story hints, prose). Face, hair, build and lasting marks only — never clothes. Return the look only.',
    }, {
      role: 'user',
      content: JSON.stringify({ name: card.canonical_name, role: card.role, known: card.appearance, prose: prose.slice(0, 1200) }),
    }],
  })
  return raw.trim().slice(0, 500)
}

// ── Portraits ──

export async function requestPortrait(
  playerId: string, instanceId: string, characterId: string, opts: { repaint?: boolean; personaId?: string } = {},
): Promise<QueuedReply> {
  if (!mediaEnabled('portrait')) throw new HttpError(404, 'That moment could not be found.')
  const { iid, instance, template } = await loadContext(playerId, instanceId)
  const pid = parseObjectId(playerId)
  const card = await mongoColl.characters().findOne({ _id: parseObjectId(characterId), instance_id: iid, player_id: pid })
  if (!card) throw new HttpError(404, 'That face could not be found.')
  const personaId = opts.personaId ? parseObjectId(opts.personaId) : instance.persona_id
  const holder = await resolvePortraitHolder(instance, card, {
    isSentient: template.is_sentient, personaName: instance.persona_snapshot?.name, ...(personaId ? { personaId } : {}),
  })
  if (isPortraitCurrent(holder) && !opts.repaint) {
    const url = portraitUrl(holder.portrait!.asset_key)
    return { status: 'ready', url }
  }
  // A repaint the player asks for counts as one image; a first painting or a
  // story-caused (out-of-date) repaint draws from the free portrait allowance.
  // An explicit repaint paints the same look anew, so its cache key never
  // collides with the kept portrait: every tap repaints, every tap is charged.
  const kind: MediaKind = opts.repaint ? 'picture' : 'portrait'
  const current = holder.portrait?.appearance_version ?? 0
  const outdated = !!holder.portrait && current < holder.appearanceVersion
  const version = holder.portrait ? current + (outdated ? 1 : 0) : (holder.appearanceVersion || 1)
  const model = imageModel()
  const key = opts.repaint
    ? `${portraitCacheKey(card._id, version, model)}:repaint:${new ObjectId().toHexString()}`
    : portraitCacheKey(card._id, version, model)
  const cached = await mongoColl.mediaAssets().findOne({ cache_key: key, status: 'ready' })
  if (cached?.url) return { status: 'ready', url: cached.url }
  const asset = await insertAsset({
    player_id: pid, instance_id: iid, kind: 'portrait', line_id: '', character_id: card._id,
    source: 'generated', model, cache_key: key,
    revision: mediaRevision(holder.appearance, String(version || 1)), input: holder.appearance.slice(0, 500),
    cost_usd: 0.009, cost_source: 'catalogue', status: 'queued',
  })
  if (!asset || asset.status === 'ready') {
    if (asset?.url) return { status: 'ready', url: asset.url }
  }
  const row = asset!
  if (!await reserveMedia({ _id: row._id, player_id: pid, instance_id: iid, kind })) {
    await mongoColl.mediaAssets().deleteOne({ _id: row._id })
    throw new HttpError(429, RESTING_COPY[kind], { status: 'resting', kind, resets_at: utcMediaDay().resets_at })
  }
  await visualEffects.enqueue('portrait', row, instanceId)
  return { status: 'queued', media_id: row._id.toHexString() }
}

export async function processPortrait(mediaId: string): Promise<void> {
  const asset = await mongoColl.mediaAssets().findOneAndUpdate(
    { _id: parseObjectId(mediaId), status: 'queued' }, { $set: { status: 'processing', started_at: new Date() } }, { returnDocument: 'after' })
  if (!asset) return
  // Standalone persona faces ride the same portrait job and branch here: they
  // belong to no save and never resolve to a card.
  if (asset.persona_id && !asset.character_id) {
    await processPersonaPortrait(asset)
    return
  }
  if (!asset.instance_id) throw new Error('Portrait has no save')
  let uploaded = ''
  let stage = 'prepare'
  try {
    const reservation = await mongoColl.mediaUsage().findOne({ _id: asset._id, status: 'reserved' })
    if (!reservation) throw new Error('Portrait no longer reserved')
    if (!asset.character_id) throw new Error('Portrait subject missing')
    const [instance, card] = await Promise.all([
      mongoColl.worldInstances().findOne({ _id: asset.instance_id, player_id: asset.player_id }),
      mongoColl.characters().findOne({ _id: asset.character_id, instance_id: asset.instance_id }),
    ])
    if (!instance || !card) throw new Error('Portrait subject removed')
    const template = await mongoColl.worldTemplates().findOne({ _id: instance.template_id })
    const holder = await resolvePortraitHolder(instance, card, {
      isSentient: template?.is_sentient ?? false, personaName: instance.persona_snapshot?.name,
      ...(instance.persona_id ? { personaId: instance.persona_id } : {}),
    })
    const appearance = holder.appearance.trim() || await visualEffects.fill(card, '')
    let reference: { data: Buffer; contentType: string } | undefined
    if (holder.portrait) {
      const bytes = await visualEffects.download(portraitUrl(holder.portrait.asset_key))
      reference = asMediaImageReference(bytes)
    }
    stage = 'paint'
    let image: PortraitBytes
    try {
      image = await generatePortraitBytes(appearance, card.canonical_name, template?.title || '', asset.model, reference)
    } catch (error) {
      if (error instanceof UnseenError) {
        await unseeMedia(asset, error.stage, error.reason)
        return
      }
      if (error instanceof ProviderRefusalError) {
        await unseeMedia(asset, 'provider', providerReason(error), undefined, { message: error.message, status: error.status })
        return
      }
      throw error
    }
    const key = `media/portrait/${asset.player_id.toHexString()}/${asset.instance_id.toHexString()}/${asset._id.toHexString()}${imageExtensionFor(image.contentType)}`
    const staged = await mongoColl.mediaAssets().updateOne({ _id: asset._id, status: 'processing' }, { $set: { asset_key: key } })
    if (!staged.matchedCount) throw new Error('Portrait removed')
    stage = 'upload'
    uploaded = key
    const result = await visualEffects.upload(image.data, image.contentType, { key })
    uploaded = result.key
    const version = (holder.portrait?.appearance_version ?? holder.appearanceVersion) + (holder.portrait ? 1 : 0) || 1
    const portrait: PortraitRef = { asset_key: result.key, source: 'generated', appearance_version: version, painted_at: new Date() }
    // A player repaint of a world face overrides on that save's card only.
    const repaintOfWorld = holder.kind === 'world_cast' && asset.cache_key.includes(':repaint:')
    await storePortrait(instance, card, holder, portrait, appearance, {
      ...(instance.persona_id ? { personaId: instance.persona_id } : {}),
      ...(repaintOfWorld ? { repaintOfWorld: true } : {}),
    })
    const cost = image.costUsd ?? asset.cost_usd
    stage = 'save'
    const saved = await mongoColl.mediaAssets().updateOne({ _id: asset._id, status: 'processing' }, {
      $set: {
        status: 'ready', asset_key: result.key, url: result.url, cost_usd: cost,
        ...(image.generationId ? { generation_id: image.generationId } : {}),
      },
    })
    if (!saved.modifiedCount) throw new Error('Portrait removed')
    await settleMedia(asset._id)
    await notifyMedia({ ...asset, status: 'ready', url: result.url })
  } catch (error) {
    if (uploaded) {
      try { await mediaEffects.remove(uploaded) } catch { /* retained for maintenance */ }
    }
    await failMedia(asset, { stage, message: error instanceof Error ? error.message : String(error) })
  }
}

// ── Persona portraits ("Give yourself a face") ──

/**
 * Paints the player's own face from the persona's description and stores it
 * on the persona, with or without a save. It never resolves to a card: the
 * most-recent save's protagonist can belong to another world, or not exist
 * in a sentient-world save. Counted against the portrait allowance — the
 * reservation carries no save, because the allowance is per player, per kind,
 * per day, and a persona face belongs to no save (it must survive any one
 * save's purge; account deletion still purges it by player).
 */
export async function requestPersonaPortrait(playerId: string, personaId: string): Promise<QueuedReply> {
  if (!mediaEnabled('portrait')) throw new HttpError(404, 'That moment could not be found.')
  const pid = parseObjectId(playerId)
  const persona = await mongoColl.personas().findOne({ _id: parseObjectId(personaId), player_id: pid })
  if (!persona) throw new HttpError(404, 'That face could not be found.')
  const appearance = (persona.description || '').trim()
  if (!appearance) throw new HttpError(422, 'This moment stays unseen.')
  if (persona.portrait && isReferenceAllowed(persona.portrait.source)
    && persona.portrait.appearance_version >= (persona.appearance_version ?? 1)) {
    return { status: 'ready', url: portraitUrl(persona.portrait.asset_key) }
  }
  const version = persona.portrait
    ? persona.portrait.appearance_version + 1
    : (persona.appearance_version ?? 1)
  const model = imageModel()
  const key = `persona:${personaId}:v${version}:${model}`
  const cached = await mongoColl.mediaAssets().findOne({ cache_key: key, status: 'ready' })
  if (cached?.url && cached.persona_id?.equals(persona._id)
    && cached.revision === mediaRevision(appearance, String(version))) {
    return { status: 'ready', url: cached.url }
  }
  const asset = await insertAsset({
    player_id: pid, persona_id: persona._id, kind: 'portrait', line_id: '',
    source: 'generated', model, cache_key: key,
    revision: mediaRevision(appearance, String(version)), input: appearance.slice(0, 500),
    cost_usd: 0.009, cost_source: 'catalogue', status: 'queued',
  })
  if (!asset) throw new HttpError(422, 'This moment stays unseen.')
  if (asset.status === 'ready' && asset.url && asset.persona_id?.equals(persona._id)) {
    return { status: 'ready', url: asset.url }
  }
  if (!await reserveMedia({ _id: asset._id, player_id: pid, kind: 'portrait' })) {
    await mongoColl.mediaAssets().deleteOne({ _id: asset._id })
    throw new HttpError(429, RESTING_COPY.portrait, { status: 'resting', kind: 'portrait', resets_at: utcMediaDay().resets_at })
  }
  // The worker routes on the media id alone; the persona id rides along only
  // so the job can be traced back to its face.
  await visualEffects.enqueue('portrait', asset, persona._id.toHexString())
  return { status: 'queued', media_id: asset._id.toHexString() }
}

async function processPersonaPortrait(asset: MediaAssetDoc): Promise<void> {
  let uploaded = ''
  let stage = 'prepare'
  try {
    const reservation = await mongoColl.mediaUsage().findOne({ _id: asset._id, status: 'reserved' })
    if (!reservation) throw new Error('Portrait no longer reserved')
    if (!asset.persona_id) throw new Error('Portrait subject missing')
    const persona = await mongoColl.personas().findOne({ _id: asset.persona_id, player_id: asset.player_id })
    if (!persona) throw new Error('Persona removed')
    const appearance = (persona.description || '').trim()
    if (!appearance) throw new Error('Persona has no face to paint')
    let reference: { data: Buffer; contentType: string } | undefined
    if (persona.portrait && isReferenceAllowed(persona.portrait.source)) {
      reference = asMediaImageReference(await visualEffects.download(portraitUrl(persona.portrait.asset_key)))
    }
    stage = 'paint'
    let image: PortraitBytes
    try {
      image = await generatePortraitBytes(appearance, persona.name, '', asset.model, reference)
    } catch (error) {
      if (error instanceof UnseenError) {
        await unseeMedia(asset, error.stage, error.reason)
        return
      }
      if (error instanceof ProviderRefusalError) {
        await unseeMedia(asset, 'provider', providerReason(error), undefined, { message: error.message, status: error.status })
        return
      }
      throw error
    }
    const key = `media/persona/${asset.player_id.toHexString()}/${asset._id.toHexString()}${imageExtensionFor(image.contentType)}`
    const staged = await mongoColl.mediaAssets().updateOne({ _id: asset._id, status: 'processing' }, { $set: { asset_key: key } })
    if (!staged.matchedCount) throw new Error('Portrait removed')
    stage = 'upload'
    uploaded = key
    const result = await visualEffects.upload(image.data, image.contentType, { key })
    uploaded = result.key
    const version = persona.portrait && isReferenceAllowed(persona.portrait.source)
      ? persona.portrait.appearance_version + 1
      : (persona.appearance_version ?? 1)
    const portrait: PortraitRef = { asset_key: result.key, source: 'generated', appearance_version: version, painted_at: new Date() }
    await mongoColl.personas().updateOne({ _id: persona._id }, {
      $set: { portrait, appearance_version: portrait.appearance_version, updated_at: new Date() },
    })
    const cost = image.costUsd ?? asset.cost_usd
    stage = 'save'
    const saved = await mongoColl.mediaAssets().updateOne({ _id: asset._id, status: 'processing' }, {
      $set: {
        status: 'ready', asset_key: result.key, url: result.url, cost_usd: cost,
        ...(image.generationId ? { generation_id: image.generationId } : {}),
      },
    })
    if (!saved.modifiedCount) throw new Error('Portrait removed')
    await settleMedia(asset._id)
    await mediaEffects.publish(asset.player_id.toHexString(), {
      type: 'media_ready',
      media_id: asset._id.toHexString(),
      kind: asset.kind,
      url: result.url,
      persona_id: persona._id.toHexString(),
    }).catch(() => {})
  } catch (error) {
    if (uploaded) {
      try { await mediaEffects.remove(uploaded) } catch { /* retained for maintenance */ }
    }
    await failMedia(asset, { stage, message: error instanceof Error ? error.message : String(error) })
  }
}

// ── Pictures ──

export async function requestPicture(playerId: string, instanceId: string, eventId: string): Promise<QueuedReply> {
  if (!mediaEnabled('picture')) throw new HttpError(404, 'That moment could not be found.')
  const { pid, iid, event } = await loadContext(playerId, instanceId, eventId)
  const revision = mediaRevision(event!.data.ai_response, event!.data.player_input)
  const model = imageModel()
  const key = `${eventId}:picture:${revision}:${model}`
  const cached = await mongoColl.mediaAssets().findOne({ cache_key: key, status: 'ready' })
  if (cached?.url && await liveMedia(cached)) return { status: 'ready', url: cached.url }
  const asset = await insertAsset({
    player_id: pid, instance_id: iid, event_id: parseObjectId(eventId), kind: 'picture', line_id: '',
    source: 'generated', model, cache_key: key, revision,
    input: event!.data.ai_response.slice(0, 500), cost_usd: 0.009, cost_source: 'catalogue', status: 'queued',
  })
  if (!asset) throw new HttpError(422, 'This moment stays unseen.')
  if (asset.status === 'ready' && asset.url && await liveMedia(asset)) return { status: 'ready', url: asset.url }
  if (!await reserveMedia({ _id: asset._id, player_id: pid, instance_id: iid, event_id: asset.event_id, kind: 'picture' })) {
    await mongoColl.mediaAssets().deleteOne({ _id: asset._id })
    throw new HttpError(429, RESTING_COPY.picture, { status: 'resting', kind: 'picture', resets_at: utcMediaDay().resets_at })
  }
  await visualEffects.enqueue('picture', asset, instanceId)
  return { status: 'queued', media_id: asset._id.toHexString() }
}

export async function processPicture(mediaId: string): Promise<void> {
  const asset = await mongoColl.mediaAssets().findOneAndUpdate(
    { _id: parseObjectId(mediaId), status: 'queued' }, { $set: { status: 'processing', started_at: new Date() } }, { returnDocument: 'after' })
  if (!asset) return
  if (!asset.instance_id) throw new Error('Picture has no save')
  let uploaded = ''
  let stage = 'prepare'
  try {
    const reservation = await mongoColl.mediaUsage().findOne({ _id: asset._id, status: 'reserved' })
    if (!reservation) throw new Error('Picture no longer reserved')
    const [instance, event] = await Promise.all([
      mongoColl.worldInstances().findOne({ _id: asset.instance_id, player_id: asset.player_id }),
      asset.event_id ? mongoColl.events().findOne({ _id: asset.event_id }) : null,
    ])
    if (!instance || !event || !liveRevision(asset, event)) throw new Error('Picture moment passed')
    const template = await mongoColl.worldTemplates().findOne({ _id: instance.template_id })
    const personaName = instance.persona_snapshot?.name
    const cards = await mongoColl.characters().find({ instance_id: asset.instance_id, player_id: asset.player_id }).sort({ first_seen_sequence: 1 }).toArray()
    const present = presentCards(event.data.ai_response, cards, personaName)
    // Faces for everyone named, made on this tap within the portrait allowance.
    stage = 'faces'
    const faces: Array<{ name: string; bytes: Buffer; contentType: string; assetKey: string }> = []
    for (const card of present.slice(0, 3)) {
      try {
        const ready = await ensurePortraitReady(
          asset.player_id.toHexString(), asset.instance_id.toHexString(), card)
        const ref = asMediaImageReference(await visualEffects.download(ready.url))
        faces.push({ name: card.canonical_name, bytes: ref.data, contentType: ref.contentType, assetKey: ready.assetKey })
      } catch { /* A face we cannot paint this tap simply stays out of frame. */ }
    }
    const playerPresent = !!personaName && event.data.ai_response.toLowerCase().includes(personaName.toLowerCase())
    let playerFraming = ''
    if (playerPresent) {
      const persona = instance.persona_id ? await mongoColl.personas().findOne({ _id: instance.persona_id }) : null
      if (!persona?.portrait) {
        // Until the player has a face, pictures are framed through their eyes.
        playerFraming = 'The viewpoint character is never shown: frame through their eyes or over their shoulder, their face never visible.'
      } else {
        const ref = asMediaImageReference(await visualEffects.download(portraitUrl(persona.portrait.asset_key)))
        faces.push({ name: personaName!, bytes: ref.data, contentType: ref.contentType, assetKey: persona.portrait.asset_key })
      }
    }
    const description = await describeMoment({
      prose: event.data.ai_response.slice(0, 1500),
      present: present.map((c) => ({ name: c.canonical_name, has_portrait: faces.some((f) => f.name === c.canonical_name) })),
      passing_look: '',
      framing: 'scene',
      place: template?.title || '',
    })
    stage = 'generate'
    const pre = await moderateDescription(description)
    if (pre.verdict !== 'allow') {
      await unseeMedia(asset, 'pre', pre.reason_code)
      return
    }
    const prompt = `${description} ${faces.length ? `The same ${faces.length === 1 ? 'face' : 'faces'} as the reference portrait${faces.length === 1 ? '' : 's'}.` : ''} Fully clothed, SFW, vertical 9:16. ${playerFraming}`.trim()
    let image: Awaited<ReturnType<typeof visualEffects.image>>
    try {
      image = await visualEffects.image(prompt, {
        model: asset.model, aspectRatio: '9:16',
        ...(faces[0] ? { reference: { data: faces[0].bytes, contentType: faces[0].contentType } } : {}),
      })
    } catch (error) {
      if (error instanceof ProviderRefusalError) {
        await unseeMedia(asset, 'provider', providerReason(error), undefined, { message: error.message, status: error.status })
        return
      }
      throw error
    }
    const post = await checkImage(image.data, image.contentType)
    if (post.verdict !== 'allow' || post.text_visible) {
      await unseeMedia(asset, 'post', post.verdict !== 'allow' ? post.reason_code : 'picture_text_visible')
      return
    }
    const key = `media/picture/${asset.player_id.toHexString()}/${asset.instance_id.toHexString()}/${asset._id.toHexString()}${imageExtensionFor(image.contentType)}`
    const staged = await mongoColl.mediaAssets().updateOne({ _id: asset._id, status: 'processing' }, { $set: { asset_key: key } })
    if (!staged.matchedCount) throw new Error('Picture removed')
    stage = 'upload'
    uploaded = key
    const result = await visualEffects.upload(image.data, image.contentType, { key })
    uploaded = result.key
    stage = 'save'
    const saved = await mongoColl.mediaAssets().updateOne({ _id: asset._id, status: 'processing' }, {
      $set: {
        status: 'ready', asset_key: result.key, url: result.url, cost_usd: image.costUsd ?? asset.cost_usd,
        ...(image.generationId ? { generation_id: image.generationId } : {}),
        ...(faces[0] ? { reference_asset_key: faces[0].assetKey } : {}),
      },
    })
    if (!saved.modifiedCount) throw new Error('Picture removed')
    await settleMedia(asset._id)
    await notifyMedia({ ...asset, status: 'ready', url: result.url })
  } catch (error) {
    if (uploaded) {
      try { await mediaEffects.remove(uploaded) } catch { /* retained for maintenance */ }
    }
    await failMedia(asset, { stage, message: error instanceof Error ? error.message : String(error) })
  }
}

// ── Videos: the scene cut ──

/** Passing looks (clothes, dirt, blood) go into one picture's prompt only. */
async function extractPassing(prose: string, name: string): Promise<string> {
  try {
    const raw = await safetyEffects.call({
      model: AI_MODELS.metadata,
      timeoutMs: 30000,
      maxTokens: 128,
      temperature: 0,
      purpose: 'media_passing_look',
      messages: [{
        role: 'system',
        content: 'What is this person wearing right now, and what marks the moment left on them (dirt, blood, rain)? One short phrase from the prose, or "none". Never lasting features. Return the phrase only.',
      }, {
        role: 'user',
        content: JSON.stringify({ name, prose: prose.slice(0, 1200) }),
      }],
    })
    return raw.trim().slice(0, 300) || 'none'
  } catch {
    return 'none'
  }
}

interface VoiceClip {
  url: string
  bytes: Buffer
  durationS: number
  asset: MediaAssetDoc
}

/**
 * The exact voice clip the player heard, made synchronously when missing.
 * Voicing an unvoiced line first counts as a voice use (own reservation).
 */
export async function ensureVoiceReady(
  playerId: string, instanceId: string, eventId: string, lineId: string,
): Promise<VoiceClip> {
  const { pid, iid, instance, template, user, event } = await loadContext(playerId, instanceId, eventId)
  if (!matureVoiceAllowed(event!.nsfw_intent, user?.preferences?.nsfw_enabled === true)) {
    throw new HttpError(422, 'This line stays quiet.', { status: 'unvoiceable' })
  }
  const lines = await attributeEvent(event!, template.is_sentient, instance.persona_snapshot?.name)
  const line = lines.find((l) => l.line_id === lineId)
  if (line?.voice?.status !== 'voiceable') throw new HttpError(422, 'This line stays quiet.', { status: 'unvoiceable' })
  const cards = await mongoColl.characters().find({ instance_id: iid, player_id: pid }).sort({ first_seen_sequence: 1 }).toArray()
  const card = resolveVoiceSpeaker(line.voice.speaker_name, cards, template.is_sentient, instance.persona_snapshot?.name)
  if (!card) throw new HttpError(422, 'This line stays quiet.', { status: 'unvoiceable' })
  const voice = await mediaEffects.cast(instance, card, line.voice.voice_traits ?? {})
  const revision = mediaRevision(event!.data.ai_response, event!.data.player_input)
  const key = `${eventId}:${lineId}:${voice.voice_id}:${voice.model}`
  const cached = await mongoColl.mediaAssets().findOne({ cache_key: key, status: 'ready' })
  if (cached?.url && cached.revision === revision) {
    const bytes = await visualEffects.download(cached.url)
    return { url: cached.url, bytes, durationS: (cached.duration_ms ?? 3000) / 1000, asset: cached }
  }
  const id = new ObjectId()
  const input = [...line.voice.tags, line.voice.spoken_text].join(' ')
  if (!await reserveMedia({ _id: id, player_id: pid, instance_id: iid, event_id: parseObjectId(eventId), kind: 'voice' })) {
    throw new HttpError(429, 'Their voices rest until tomorrow.', { status: 'resting', kind: 'voice', resets_at: utcMediaDay().resets_at })
  }
  try {
    const audio = await mediaEffects.synthesize({ model: voice.model, voice: voice.voice_id, input, responseFormat: 'mp3', signal: AbortSignal.timeout(15000) })
    let cost = input.length * voiceCatalogue(voice.model).rate_usd_per_character
    let costSource: 'catalogue' | 'generation' = 'catalogue'
    let generationId: string | null = audio.generationId
    if (audio.generationId) {
      const actual = await mediaEffects.cost(audio.generationId)
      if (actual !== undefined) { cost = actual; costSource = 'generation' }
    }
    const duration_ms = mp3DurationMs(audio.data)
    const s3key = `media/voice/${pid.toHexString()}/${iid.toHexString()}/${id.toHexString()}.mp3`
    const result = await mediaEffects.upload(audio.data, 'audio/mpeg', { key: s3key })
    const row: MediaAssetDoc = {
      _id: id, player_id: pid, instance_id: iid, event_id: parseObjectId(eventId), kind: 'voice', line_id: lineId,
      character_id: card._id, source: 'generated', model: voice.model, voice_id: voice.voice_id,
      cache_key: key, revision, input, cost_usd: cost, cost_source: costSource, status: 'ready',
      asset_key: result.key, url: result.url, duration_ms, created_at: new Date(),
      ...(generationId ? { generation_id: generationId } : {}),
    }
    await mongoColl.mediaAssets().insertOne(row)
    await settleMedia(id)
    return { url: result.url, bytes: audio.data, durationS: duration_ms / 1000, asset: row }
  } catch (error) {
    await releaseMedia(id)
    await mongoColl.mediaAssets().deleteOne({ _id: id })
    throw error
  }
}

export async function requestVideo(playerId: string, instanceId: string, eventId: string, lineId: string): Promise<QueuedReply> {
  if (!mediaEnabled('video')) throw new HttpError(404, 'That moment could not be found.')
  const { pid, iid, instance, template, user, event } = await loadContext(playerId, instanceId, eventId)
  if (!matureVoiceAllowed(event!.nsfw_intent, user?.preferences?.nsfw_enabled === true)) {
    throw new HttpError(422, 'This line stays quiet.', { status: 'unvoiceable' })
  }
  if (!/^l\d+$/u.test(lineId)) throw new HttpError(422, 'This line stays quiet.', { status: 'unvoiceable' })
  if (!detectSpokenLines(event!.data.ai_response, event!.data.player_spoken_input ?? event!.data.player_input).some((l) => l.line_id === lineId)) {
    throw new HttpError(422, 'This line stays quiet.', { status: 'unvoiceable' })
  }
  const lines = await attributeEvent(event!, template.is_sentient, instance.persona_snapshot?.name)
  const line = lines.find((l) => l.line_id === lineId)
  if (line?.voice?.status !== 'voiceable') throw new HttpError(422, 'This line stays quiet.', { status: 'unvoiceable' })
  const cards = await mongoColl.characters().find({ instance_id: iid, player_id: pid }).sort({ first_seen_sequence: 1 }).toArray()
  const card = resolveVoiceSpeaker(line.voice.speaker_name, cards, template.is_sentient, instance.persona_snapshot?.name)
  if (!card) throw new HttpError(422, 'This line stays quiet.', { status: 'unvoiceable' })
  const voice = await mediaEffects.cast(instance, card, line.voice.voice_traits ?? {})
  const holder = await resolvePortraitHolder(instance, card, {
    isSentient: template.is_sentient, personaName: instance.persona_snapshot?.name,
    ...(instance.persona_id ? { personaId: instance.persona_id } : {}),
  })
  const revision = mediaRevision(event!.data.ai_response, event!.data.player_input)
  const key = `${eventId}:${lineId}:video:${revision}:${voice.voice_id}:${holder.portrait?.appearance_version ?? 0}:${videoModel()}:${sceneModel()}`
  const cached = await mongoColl.mediaAssets().findOne({ cache_key: key, status: 'ready' })
  if (cached?.url && await liveMedia(cached)) {
    return { status: 'ready', url: cached.url, ...(cached.duration_ms ? { duration_ms: cached.duration_ms } : {}) }
  }
  const asset = await insertAsset({
    player_id: pid, instance_id: iid, event_id: parseObjectId(eventId), kind: 'video', line_id: lineId,
    character_id: card._id, source: 'generated', model: videoModel(), voice_id: voice.voice_id,
    cache_key: key, revision, input: line.voice.spoken_text.slice(0, 400),
    cost_usd: 0.65, cost_source: 'catalogue', status: 'queued',
  })
  if (!asset) throw new HttpError(422, 'This moment stays unseen.')
  if (asset.status === 'ready' && asset.url && await liveMedia(asset)) {
    return { status: 'ready', url: asset.url, ...(asset.duration_ms ? { duration_ms: asset.duration_ms } : {}) }
  }
  if (!await reserveMedia({ _id: asset._id, player_id: pid, instance_id: iid, event_id: asset.event_id, kind: 'video' })) {
    await mongoColl.mediaAssets().deleteOne({ _id: asset._id })
    throw new HttpError(429, RESTING_COPY.video, { status: 'resting', kind: 'video', resets_at: utcMediaDay().resets_at })
  }
  await visualEffects.enqueue('video', asset, instanceId)
  return { status: 'queued', media_id: asset._id.toHexString() }
}

interface ShotOutcome {
  role: 'opening' | 'closing'
  status: 'ready' | 'dropped'
  model: string
  stillUrl: string
  /** The uploaded still while the caller still owns it (item 5): stills are
   * inputs, not deliverables. Present on a ready shot until the cut is
   * assembled, and on a dropped shot only when its own deletion failed. */
  stillKey?: string
  videoBytes?: Buffer
  durationS: number
  checks: unknown[]
  cost: number
  reason?: string
  /** The sanitised provider message on a provider-refused shot. */
  message?: string
}

export async function makeSceneShot(args: {
  role: 'opening' | 'closing'
  continuity: DirectorPlan['continuity']
  shot: DirectorPlan['shots'][number]
  speakerPortrait: Buffer
  playerId: ObjectId
  instanceId: ObjectId
}): Promise<ShotOutcome> {
  const primary = sceneModel(), fallback = sceneFallbackModel()
  const dropped = (reason: string, checks: unknown[], cost: number, stillUrl = '', stillKey?: string, message?: string): ShotOutcome =>
    ({ role: args.role, status: 'dropped', model: primary, stillUrl, durationS: 0, checks, cost, reason, ...(stillKey ? { stillKey } : {}), ...(message !== undefined ? { message } : {}) })
  // A refused scene shot counts like any provider refusal: a rejection row
  // with the sanitised message, which also rides home on the shot outcome so
  // the cut's telemetry keeps the reason.
  const logShotRefusal = async (reason: 'still_provider_refused' | 'shot_provider_refused', rawMessage: string, model: string): Promise<string> => {
    const message = sanitizeMediaError(rawMessage)
    await logRejection({ _id: new ObjectId(), player_id: args.playerId, instance_id: args.instanceId, kind: 'video' }, 'provider', reason, model, message)
    return message
  }
  try {
    // Before any paid generation, the COMPILED still and motion prompts are
    // moderated (§7 gate on what we actually send): a rejected shot prompt
    // drops that shot, before a cent is spent on it.
    const stillPrompt = compileStillPrompt({ continuity: args.continuity } as DirectorPlan, args.shot, primary)
    const motionPrompt = compileMotionPrompt({ continuity: args.continuity } as DirectorPlan, args.shot, primary)
    const stillGate = await moderateDescription(stillPrompt)
    if (stillGate.verdict !== 'allow') {
      return dropped('still_prompt_rejected', [{ prompt: 'still', reason: stillGate.reason_code }], 0)
    }
    const motionGate = await moderateDescription(motionPrompt)
    if (motionGate.verdict !== 'allow') {
      return dropped('motion_prompt_rejected', [{ prompt: 'motion', reason: motionGate.reason_code }], 0)
    }
    // Its own wide still, painted in the house style with no face close-up.
    // The people count is enforced here, at $0.009 a retry, so a $0.20 video
    // is never spent animating a still that is already off-plan.
    // The speaker face is an older PNG portrait or a new JPEG one: sniffed,
    // never assumed.
    const speakerReference = asMediaImageReference(args.speakerPortrait)
    let still: { data: Buffer; contentType: string; costUsd?: number } | null = null
    const stillChecks: unknown[] = []
    try {
      for (let attempt = 0; attempt < 2 && !still; attempt++) {
        const candidate = await visualEffects.image(
          stillPrompt,
          { model: imageModel(), aspectRatio: '9:16', reference: speakerReference },
        )
        const checks = await checkImage(candidate.data, candidate.contentType)
        stillChecks.push({ attempt, people_count: checks.people_count, face_close_up: checks.face_close_up, text_visible: checks.text_visible, verdict: checks.verdict })
        if (checks.verdict === 'allow' && !checks.text_visible && !checks.face_close_up
          && checks.people_count === args.shot.people_in_still.length) {
          still = candidate
        }
      }
    } catch (error) {
      // A provider content refusal drops the shot like a gate rejection, with
      // its own reason — never a failed cut and never a worker crash.
      if (error instanceof ProviderRefusalError) {
        const message = await logShotRefusal('still_provider_refused', error.message, imageModel())
        return dropped('still_provider_refused', [], 0, '', undefined, message)
      }
      throw error
    }
    if (!still) return dropped('still_rejected', stillChecks, 0.018)
    const stillBytes = still.data
    const stillContentType = still.contentType
    const stillKey = `media/still/${args.playerId.toHexString()}/${args.instanceId.toHexString()}/${args.role}-${Date.now()}${imageExtensionFor(stillContentType)}`
    const stillUp = await visualEffects.upload(stillBytes, stillContentType, { key: stillKey })
    const dropShot = async (reason: string, message?: string): Promise<ShotOutcome> => {
      // A rejected shot takes its still with it: nothing unseen stays stored.
      // When that deletion itself fails, the key rides home on the outcome so
      // the caller records it on the asset row for purgeMedia (item 5).
      try {
        await mediaEffects.remove(stillUp.key)
        return dropped(reason, stillChecks, 0.018 + 0.4, '', undefined, message)
      } catch {
        return dropped(reason, stillChecks, 0.018 + 0.4, '', stillUp.key, message)
      }
    }
    const expectedPeople = args.shot.people_in_still.length
    for (const [model, withAudio] of [[primary, undefined], [fallback, false]] as const) {
      try {
        const submitted = await visualEffects.submit({
          model, prompt: motionPrompt, firstFrameUrl: stillUp.url,
          duration: args.shot.duration_s, resolution: '480p', aspectRatio: '9:16',
          ...(withAudio === undefined ? {} : { generateAudio: withAudio }),
        })
        const status = await visualEffects.wait(submitted.jobId)
        const video = await visualEffects.fetch(submitted.jobId)
        const frames = await checkVideoFrames(video, { data: stillBytes, contentType: stillContentType })
        const ok = judgeShotFrames(frames, expectedPeople)
        const record = {
          model, job: submitted.jobId, cost: status.costUsd,
          frames: frames.map((f) => ({ verdict: f.verdict, people: f.people_count, face: f.face_close_up, text: f.text_visible, wardrobe: f.wardrobe_match })),
        }
        if (ok) {
          // The fallback's audio track is always dropped: it returned audio even
          // with generate_audio:false, and no voice may hide in ambience.
          return {
            role: args.role, status: 'ready', model, stillUrl: stillUp.url, stillKey: stillUp.key, videoBytes: video,
            durationS: args.shot.duration_s, checks: [...stillChecks, record],
            cost: (still.costUsd ?? 0.009) + (status.costUsd ?? 0.2),
          }
        }
        stillChecks.push({ ...record, retry: model === primary ? 'fallback' : 'dropped' })
      } catch (error) {
        // A refused prompt will not pass on the fallback either: drop the
        // shot instead of burning a second video on the same refusal.
        if (error instanceof ProviderRefusalError) {
          const message = await logShotRefusal('shot_provider_refused', error.message, model)
          return dropShot('shot_provider_refused', message)
        }
        stillChecks.push({ model, error: (error as Error).message.slice(0, 200), retry: model === primary ? 'fallback' : 'dropped' })
      }
    }
    return dropShot('shot_rejected')
  } catch {
    // A Flux filter 400, a failed upload, anything: a scene-shot failure is a
    // dropped shot, never a failed cut and never a worker crash.
    return dropped('shot_failed', [], 0)
  }
}

/** The HeyGen line shot, started in parallel with the scene shots: HeyGen
 * alone takes about 2 minutes, and render time is the player's wait. */
function startLineShot(args: {
  model: string
  speakerName: string
  spokenText: string
  portraitUrl: string
  audioUrl: string
}): Promise<{ video: Buffer; cost: number }> {
  return (async () => {
    const submitted = await visualEffects.submit({
      model: args.model,
      prompt: compileLinePrompt(args.speakerName, args.spokenText),
      inputReferences: [
        { type: 'image_url', url: args.portraitUrl },
        { type: 'audio_url', url: args.audioUrl },
      ],
    })
    const status = await visualEffects.wait(submitted.jobId)
    const video = await visualEffects.fetch(submitted.jobId)
    return { video, cost: status.costUsd ?? 0.3 }
  })()
}

/** Scene-still inputs are deleted once the cut is assembled or the video
 * fails (item 5). Keys are recorded on the asset row BEFORE deletion is
 * attempted, so a key that fails to delete stays purgeable by purgeMedia. */
async function deleteSceneStills(asset: MediaAssetDoc, keys: string[]): Promise<void> {
  if (!keys.length) return
  await mongoColl.mediaAssets().updateOne({ _id: asset._id }, { $set: { still_keys: keys } }).catch(() => {})
  try {
    for (const key of keys) await mediaEffects.remove(key)
  } catch {
    return // Recorded above; purgeMedia removes what survived.
  }
  await mongoColl.mediaAssets().updateOne({ _id: asset._id }, { $unset: { still_keys: '' } }).catch(() => {})
}

const sceneStillKeys = (shots: ShotOutcome[]): string[] =>
  shots.flatMap((s) => s.stillKey ? [s.stillKey] : [])

export async function processVideo(mediaId: string): Promise<void> {
  const asset = await mongoColl.mediaAssets().findOneAndUpdate(
    { _id: parseObjectId(mediaId), status: 'queued' }, { $set: { status: 'processing', started_at: new Date() } }, { returnDocument: 'after' })
  if (!asset) return
  if (!asset.instance_id) throw new Error('Video has no save')
  const saveId = asset.instance_id
  let uploaded = ''
  const renderStarted = Date.now()
  let planRecord: Record<string, unknown> = {}
  let stage = 'prepare'
  try {
    const reservation = await mongoColl.mediaUsage().findOne({ _id: asset._id, status: 'reserved' })
    if (!reservation) throw new Error('Video no longer reserved')
    if (!asset.event_id || !asset.character_id) throw new Error('Video subject missing')
    const [instance, event] = await Promise.all([
      mongoColl.worldInstances().findOne({ _id: asset.instance_id, player_id: asset.player_id }),
      mongoColl.events().findOne({ _id: asset.event_id }),
    ])
    if (!instance || !event || !liveRevision(asset, event)) throw new Error('Video moment passed')
    const template = await mongoColl.worldTemplates().findOne({ _id: instance.template_id })
    const personaName = instance.persona_snapshot?.name
    const lines = await attributeEvent(event, template?.is_sentient ?? false, personaName)
    const line = lines.find((l) => l.line_id === asset.line_id)
    if (line?.voice?.status !== 'voiceable') throw new Error('Line no longer voiceable')
    const cards = await mongoColl.characters().find({ instance_id: asset.instance_id, player_id: asset.player_id }).sort({ first_seen_sequence: 1 }).toArray()
    const card = cards.find((c) => c._id.equals(asset.character_id!))
    if (!card) throw new Error('Speaker removed')
    // The face and the exact clip the player heard, made first when missing.
    stage = 'face'
    let portraitUrlStr: string
    try {
      const ready = await ensurePortraitReady(
        asset.player_id.toHexString(), asset.instance_id.toHexString(), card)
      portraitUrlStr = ready.url
    } catch (error) {
      if (error instanceof UnseenError) {
        await unseeMedia(asset, error.stage, error.reason)
        return
      }
      // A face the provider will not paint makes the whole video unseen.
      if (error instanceof ProviderRefusalError) {
        await unseeMedia(asset, 'provider', providerReason(error), undefined, { message: error.message, status: error.status })
        return
      }
      throw error
    }
    stage = 'voice'
    const clip = await ensureVoiceReady(
      asset.player_id.toHexString(), asset.instance_id.toHexString(),
      asset.event_id.toHexString(), asset.line_id)
    const portraitBytes = await visualEffects.download(portraitUrlStr)
    // The director pass.
    const prose = event.data.ai_response
    const span = { start: line.start, end: line.end }
    const narrationBefore = prose.slice(0, span.start).slice(-1200)
    const narrationAfter = prose.slice(span.end, span.end + 1200)
    const others = presentCards(prose, cards.filter((c) => !c._id.equals(card._id)), personaName)
    const directorInput: DirectorInput = {
      art_style: 'semi-realistic cinematic digital painting, warm rim light',
      narration_before: narrationBefore,
      line: { speaker_name: line.voice.speaker_name, spoken_text: line.voice.spoken_text, duration_s: clip.durationS },
      narration_after: narrationAfter,
      speaker: { appearance: card.appearance || '', passing_look: await extractPassing(prose, card.canonical_name) },
      others_present: others.map((c) => ({ name: c.canonical_name, appearance: c.appearance || '' })),
      place: template?.title || '',
    }
    const gatedDescription = `${narrationBefore} ${narrationAfter}`.slice(0, 1500)
    const pre = await moderateDescription(gatedDescription)
    if (pre.verdict !== 'allow') {
      await unseeMedia(asset, 'pre', pre.reason_code)
      return
    }
    stage = 'direct'
    const model = directorModel()
    const directed = await directScene(model, directorInput)
    const planErrors = directed.plan ? validateDirectorPlan(directed.plan, directorInput) : directed.errors
    const plan: DirectorPlan | null = directed.plan && !planErrors.length ? directed.plan : null
    const price = await visualEffects.prices(model)
    const directorCost = (JSON.stringify(directorInput).length / 4) * price.prompt + 600 * price.completion
    let cost = directorCost
    // Telemetry first: a failed cut keeps its plan, prompts and per-shot
    // check results, so a bad cut can be diagnosed from the row alone.
    planRecord = {
      director_model: model,
      input: directorInput,
      plan,
      errors: directed.plan ? planErrors : directed.errors,
      repaired: directed.repaired,
      shots: [] as unknown[],
    }
    // Scene shots start together with the line shot and settle independently:
    // allSettled, so a sibling rejection is observed and never goes unhandled,
    // and every scene-shot failure is a dropped shot, never a failed cut. The
    // line shot runs in parallel because HeyGen alone takes about 2 minutes.
    const lineShot = startLineShot({
      model: asset.model,
      speakerName: line.voice.speaker_name,
      spokenText: line.voice.spoken_text,
      portraitUrl: portraitUrlStr,
      audioUrl: clip.url,
    })
    const shots: ShotOutcome[] = planRecord.shots as ShotOutcome[]
    stage = 'shoot'
    if (plan) {
      const settled = await Promise.allSettled(plan.shots.map((shot, index) => makeSceneShot({
        role: shot.role, continuity: plan.continuity, shot,
        speakerPortrait: portraitBytes, playerId: asset.player_id, instanceId: saveId,
      }).then((outcome) => ({ outcome, index }))))
      const ordered = settled.map((result, index) => {
        if (result.status === 'fulfilled') return result.value.outcome
        const role = plan.shots[index]?.role === 'closing' ? 'closing' as const : 'opening' as const
        return { role, status: 'dropped' as const, model: sceneModel(), stillUrl: '', durationS: 0, checks: [{ error: 'shot threw' }], cost: 0, reason: 'shot_failed' }
      })
      for (const shot of ordered.sort((a, b) => plan.shots.findIndex((s) => s.role === a.role) - plan.shots.findIndex((s) => s.role === b.role))) shots.push(shot)
      cost += shots.reduce((sum, s) => sum + s.cost, 0)
    }
    // The line shot: portrait plus the exact clip. A failed line shot fails
    // the whole video and releases the slot — after the scene stills are
    // deleted, since they are inputs, not deliverables.
    stage = 'line'
    let lineVideo: Buffer
    try {
      const done = await lineShot
      lineVideo = done.video
      cost += done.cost
    } catch (error) {
      await deleteSceneStills(asset, sceneStillKeys(shots))
      if (error instanceof ProviderRefusalError) {
        await unseeMedia(asset, 'provider', providerReason(error), undefined, { message: error.message, status: error.status })
        return
      }
      throw new Error('Line shot failed')
    }
    // The line shot gets the same first/middle/last-frame post-check (§7 says
    // every shot): SFW, no text, exactly one person. (No face rule: the face
    // belongs to the line shot.) A failure makes the whole video unseen.
    const lineFrames = await checkVideoFrames(lineVideo)
    const linePeople = lineFrames.map((f) => f.people_count)
    const lineOk = lineFrames.length > 0
      && lineFrames.every((f) => f.verdict === 'allow')
      && lineFrames.every((f) => !f.text_visible)
      && linePeople.every((count) => count === 1)
    if (!lineOk) {
      const bad = lineFrames.find((f) => f.verdict !== 'allow')
        || lineFrames.find((f) => f.text_visible)
        || lineFrames.find((f) => f.people_count !== 1)
      await unseeMedia(asset, 'post', bad ? bad.reason_code : 'line_shot_rejected')
      await deleteSceneStills(asset, sceneStillKeys(shots))
      return
    }
    // Assemble: scene shots that survived, then the line, degraded never broken.
    stage = 'assemble'
    const ready = shots.filter((s) => s.status === 'ready' && s.videoBytes)
    const opening = ready.find((s) => s.role === 'opening')
    const closing = ready.find((s) => s.role === 'closing')
    const normLine = await normalizeShot(lineVideo)
    const lineDur = await cutEffects.probeDuration(normLine)
    const voiceS = clip.durationS
    const lineSegS = Math.min(lineDur, voiceS + 0.3)
    const parts: Buffer[] = []
    const durations: number[] = []
    if (opening) { parts.push(await normalizeShot(opening.videoBytes!)); durations.push(opening.durationS) }
    parts.push(normLine); durations.push(lineSegS)
    if (closing && closing !== opening) { parts.push(await normalizeShot(closing.videoBytes!)); durations.push(closing.durationS) }
    const hasOpening = !!opening, hasClosing = !!closing && closing !== opening
    const leadIn = plan && hasOpening ? plan.line_shot.voice_lead_in_s : 0
    const voiceDelayS = hasOpening ? Math.max(0, opening!.durationS - leadIn) : 0
    const { bytes, totalS } = await assembleCut({
      shots: parts, durations, hasOpening, hasClosing,
      transitionIn: plan?.line_shot.transition_in as 'cut' | 'dissolve_short' || 'cut',
      transitionOut: plan?.ending.transition_out as 'cut' | 'dissolve_short' | 'dip_to_black' || 'dissolve_short',
      voiceMp3: clip.bytes, voiceDelayS, voiceS,
      ambienceFrom: opening ? 'opening' : closing ? 'closing' : null,
    })
    const key = `media/video/${asset.player_id.toHexString()}/${asset.instance_id.toHexString()}/${asset._id.toHexString()}.mp4`
    const staged = await mongoColl.mediaAssets().updateOne({ _id: asset._id, status: 'processing' }, { $set: { asset_key: key } })
    if (!staged.matchedCount) throw new Error('Video removed')
    stage = 'upload'
    uploaded = key
    const result = await visualEffects.upload(bytes, 'video/mp4', { key })
    uploaded = result.key
    stage = 'save'
    const saved = await mongoColl.mediaAssets().updateOne({ _id: asset._id, status: 'processing' }, {
      $set: {
        status: 'ready', asset_key: result.key, url: result.url, duration_ms: Math.round(totalS * 1000),
        cost_usd: cost, cost_source: 'generation',
        plan: {
          ...planRecord,
          compiled: {
            line: compileLinePrompt(line.voice.speaker_name, line.voice.spoken_text),
            shots: shots.map((s) => ({ role: s.role, model: s.model, status: s.status, reason: s.reason, ...(s.message !== undefined ? { message: s.message } : {}) })),
          },
          shots,
          render_ms: Date.now() - renderStarted,
        },
      },
    })
    if (!saved.modifiedCount) throw new Error('Video removed')
    // The cut is assembled: its still inputs are deleted (item 5). Their URLs
    // stay in the stored plan as telemetry, but the objects are gone.
    await deleteSceneStills(asset, sceneStillKeys(shots))
    await settleMedia(asset._id)
    await notifyMedia({ ...asset, status: 'ready', url: result.url, duration_ms: Math.round(totalS * 1000) })
  } catch (error) {
    if (error instanceof UnseenError) {
      await unseeMedia(asset, error.stage, error.reason, uploaded || undefined)
      return
    }
    if (uploaded) {
      try { await mediaEffects.remove(uploaded) } catch { /* retained for maintenance */ }
    }
    // A video that fails after its shots still deletes their stills (item 5).
    await deleteSceneStills(asset, sceneStillKeys((planRecord.shots as ShotOutcome[] | undefined) || []))
    // Keep the telemetry: plan, prompts and shot checks survive the failure.
    await mongoColl.mediaAssets().updateOne({ _id: asset._id }, {
      $set: { plan: { ...planRecord, render_ms: Date.now() - renderStarted } },
    }).catch(() => {})
    await failMedia(asset, { stage, message: error instanceof Error ? error.message : String(error) })
  }
}
