import { ObjectId, type Filter } from 'mongodb'
import { mongoColl } from '../../config/mongo'
import { HttpError } from '../../utils/http-error'
import { parseObjectId } from '../../utils/mongo-id'
import type { MediaAssetDoc, PortraitRef } from '../../models/media.model'
import { portraitUrl } from './portraits'

/**
 * Keepsakes (contract everlore-docs/phases/keepsakes.md §4): everything the
 * player has made, across all their saves. Read-only listing of the player's
 * own rows plus a hide flag. Faces are card portraits and the player's own
 * faces; passing faces are never canon and voice clips live on their lines.
 *
 * Nothing internal reaches the client: no prompts, inputs, models, costs,
 * cache keys, asset keys, plans, rejection data or generation ids. The audit
 * walks every key of the real JSON against KEEPSAKE_FORBIDDEN_KEYS.
 */

export type KeepsakeKindFilter = 'all' | 'picture' | 'video' | 'portrait'

export interface KeepsakeItem {
  media_id: string
  kind: 'picture' | 'video' | 'portrait'
  url: string
  poster_url?: string
  duration_ms?: number
  width?: number
  height?: number
  created_at: string
  instance_id?: string
  event_id?: string
  world: { title: string; cover_url?: string } | null
  save_label?: string
  excerpt?: string
  speaker_name?: string
  character?: { id: string; name: string }
}

export interface KeepsakePage {
  items: KeepsakeItem[]
  next_before?: string
}

/** Row keys that must never appear in a keepsakes payload, at any depth. */
export const KEEPSAKE_FORBIDDEN_KEYS = [
  'input',
  'model',
  'voice_id',
  'cost_usd',
  'cost_source',
  'cache_key',
  'asset_key',
  'reference_asset_key',
  'still_keys',
  'plan',
  'error',
  'generation_id',
  'passing_key',
  'appearance',
  'notified_at',
  'status',
  'player_id',
]

const EXCERPT_MAX = 280

/** ≤280 chars of prose, cut at a word boundary. One builder so the audit and
 *  the service agree on the same string. */
export function keepsakeExcerpt(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  if (flat.length <= EXCERPT_MAX) return flat
  const cut = flat.lastIndexOf(' ', EXCERPT_MAX)
  return (cut > 0 ? flat.slice(0, cut) : flat.slice(0, EXCERPT_MAX)).trimEnd()
}

const CALM_PAGE_MESSAGE = 'Unknown keepsake page.'
const PAGE_BATCHES_MAX = 10

/** Opaque paging cursor: base64url of `<iso>|<objectId hex>`. */
function encodeKeepsakeCursor(t: Date, id: ObjectId): string {
  return Buffer.from(`${t.toISOString()}|${id.toHexString()}`, 'utf8').toString('base64url')
}

function parseKeepsakeCursor(raw: string): { t: Date; id: ObjectId } {
  let text = ''
  try {
    if (!raw) throw new Error('empty keepsake cursor')
    text = Buffer.from(raw, 'base64url').toString('utf8')
  } catch {
    throw new HttpError(422, CALM_PAGE_MESSAGE)
  }
  const sep = text.indexOf('|')
  const iso = sep < 0 ? '' : text.slice(0, sep)
  const hex = sep < 0 ? '' : text.slice(sep + 1)
  const t = new Date(iso)
  if (!iso || Number.isNaN(t.getTime()) || !/^[0-9a-fA-F]{24}$/.test(hex)) {
    throw new HttpError(422, CALM_PAGE_MESSAGE)
  }
  return { t, id: new ObjectId(hex) }
}

/** A persona's current face for a portrait row: the style's map entry, or the
 *  legacy single portrait for a row painted before styles existed. */
function currentPersonaFace(
  persona: { portrait?: PortraitRef; portraits?: Record<string, PortraitRef> },
  artStyle?: string,
): PortraitRef | undefined {
  if (artStyle) return persona.portraits?.[artStyle]
  return persona.portrait
}

/** A portrait row is current only if it is the face its card or persona shows
 *  now: the stored key matches, or the public url when the row keeps no key. */
function isCurrentPortraitRow(row: MediaAssetDoc, current?: PortraitRef): boolean {
  if (!current) return false
  if (row.asset_key) return row.asset_key === current.asset_key
  if (!row.url) return false
  return row.url === portraitUrl(current.asset_key)
}

/** Distinct ids in first-seen order, for one `$in` query per collection. */
const distinctIds = (ids: Array<ObjectId | undefined>): ObjectId[] =>
  [...new Set(ids.flatMap((id) => id ? [id.toHexString()] : []))].map((hex) => new ObjectId(hex))

function parseListQuery(query: { kind?: string; before?: string; limit?: string }): {
  kinds: Array<'picture' | 'video' | 'portrait'>
  cursor?: { t: Date; id: ObjectId }
  limit: number
} {
  const kind = query.kind ?? 'all'
  if (kind !== 'all' && kind !== 'picture' && kind !== 'video' && kind !== 'portrait') {
    throw new HttpError(422, 'Unknown keepsake kind.')
  }
  const kinds: Array<'picture' | 'video' | 'portrait'> =
    kind === 'all' ? ['picture', 'video'] : [kind]
  let cursor: { t: Date; id: ObjectId } | undefined
  if (query.before !== undefined) {
    cursor = parseKeepsakeCursor(query.before)
  }
  const limit = query.limit === undefined ? 20 : Number(query.limit)
  if (!Number.isInteger(limit) || limit < 1 || limit > 40) {
    throw new HttpError(422, CALM_PAGE_MESSAGE)
  }
  return { kinds, ...(cursor ? { cursor } : {}), limit }
}

export async function listKeepsakes(
  playerId: string,
  query: { kind?: string; before?: string; limit?: string } = {},
): Promise<KeepsakePage> {
  const pid = parseObjectId(playerId)
  const { kinds, cursor, limit } = parseListQuery(query)
  // Own rows only, ready only, never removed. passing_face and voice are
  // separate kind values so the kind filter excludes them structurally.
  const base: Filter<MediaAssetDoc> = {
    player_id: pid,
    status: 'ready',
    kind: { $in: kinds },
    hidden_from_keepsakes: { $ne: true },
  }
  const items: KeepsakeItem[] = []
  let resume: { t: Date; id: ObjectId } | undefined = cursor
  let lastKept: { t: Date; id: ObjectId } | undefined
  let lastExamined: { t: Date; id: ObjectId } | undefined
  let moreBeyondKept = false
  let exhausted = false
  // A page is filled past rows the player never sees (a repainted-over face, a
  // piece whose save is gone), so it never comes back short or empty while
  // rows remain. At most ten fetches: the page then ends with what was kept
  // and a cursor. Newest first, _id breaking created_at ties.
  for (let batch = 0; batch < PAGE_BATCHES_MAX && items.length < limit; batch++) {
    const found = await mongoColl.mediaAssets().find({
      ...base,
      ...(resume
        ? { $or: [{ created_at: { $lt: resume.t } }, { created_at: resume.t, _id: { $lt: resume.id } }] }
        : {}),
    }).sort({ created_at: -1, _id: -1 }).limit(limit + 1).toArray()
    const peeked = found.length > limit
    const fetched = (peeked ? found.slice(0, limit) : found) as MediaAssetDoc[]
    if (!fetched.length) { exhausted = true; break }

    // Batched lookups: one query per collection, never one per row.
    const instanceIds = distinctIds(fetched.map((r) => r.instance_id))
    const eventIds = distinctIds(fetched.map((r) => r.event_id))
    const characterIds = distinctIds(fetched.map((r) => r.character_id))
    const personaIds = distinctIds(fetched.map((r) => r.persona_id))
    const [instances, events, characters, personas] = await Promise.all([
      instanceIds.length ? mongoColl.worldInstances().find({ _id: { $in: instanceIds } }).toArray() : [],
      eventIds.length ? mongoColl.events().find({ _id: { $in: eventIds } }).toArray() : [],
      characterIds.length ? mongoColl.characters().find({ _id: { $in: characterIds } }).toArray() : [],
      personaIds.length ? mongoColl.personas().find({ _id: { $in: personaIds } }).toArray() : [],
    ])
    const instanceById = new Map(instances.map((i) => [i._id.toHexString(), i]))
    const eventById = new Map(events.map((e) => [e._id.toHexString(), e]))
    const characterById = new Map(characters.map((c) => [c._id.toHexString(), c]))
    const personaById = new Map(personas.map((p) => [p._id.toHexString(), p]))
    const templateIds = distinctIds(instances.map((i) => i.template_id))
    const templates = templateIds.length
      ? await mongoColl.worldTemplates().find({ _id: { $in: templateIds } }).toArray()
      : []
    const templateById = new Map(templates.map((t) => [t._id.toHexString(), t]))
    const leads = instanceIds.length
      ? await mongoColl.characters().find({ instance_id: { $in: instanceIds }, is_protagonist: true }).toArray()
      : []
    const leadByInstance = new Map(leads.map((c) => [c.instance_id.toHexString(), c]))

    // A portrait row is a Face only while it is the face its card or persona
    // shows now. A repainted-over face doesn't appear, whatever page it sits
    // on: currency is structural, never newest-per-page.
    let examined = 0
    for (const row of fetched) {
      examined++
      lastExamined = { t: row.created_at, id: row._id }
      if (row.kind !== 'picture' && row.kind !== 'video' && row.kind !== 'portrait') continue
      if (!row.url) continue
      // A piece whose save was deleted is gone with it. A persona face has no
      // save and survives.
      if (row.instance_id && !instanceById.has(row.instance_id.toHexString())) continue
      const instance = row.instance_id ? instanceById.get(row.instance_id.toHexString()) : undefined
      const template = instance ? templateById.get(instance.template_id.toHexString()) : undefined
      const event = row.event_id ? eventById.get(row.event_id.toHexString()) : undefined

      let character: KeepsakeItem['character']
      if (row.kind === 'portrait') {
        if (row.character_id) {
          const card = characterById.get(row.character_id.toHexString())
          if (!card) continue
          character = { id: card._id.toHexString(), name: card.canonical_name }
          if (!isCurrentPortraitRow(row, card.portrait)) continue
        } else if (row.persona_id) {
          const persona = personaById.get(row.persona_id.toHexString())
          if (!persona) continue
          character = { id: persona._id.toHexString(), name: persona.name }
          if (!isCurrentPortraitRow(row, currentPersonaFace(persona, row.art_style))) continue
        } else {
          continue
        }
      }

      const item: KeepsakeItem = {
        media_id: row._id.toHexString(),
        kind: row.kind,
        url: row.url,
        ...(row.poster_url ? { poster_url: row.poster_url } : {}),
        ...(row.kind === 'video' && row.duration_ms !== undefined ? { duration_ms: row.duration_ms } : {}),
        ...(row.width !== undefined ? { width: row.width } : {}),
        ...(row.height !== undefined ? { height: row.height } : {}),
        created_at: row.created_at.toISOString(),
        ...(row.instance_id ? { instance_id: row.instance_id.toHexString() } : {}),
        ...(row.event_id ? { event_id: row.event_id.toHexString() } : {}),
        world: template
          ? { title: template.title, ...(template.image_url ? { cover_url: template.image_url } : {}) }
          : null,
      }
      if (instance) {
        const lead = leadByInstance.get(instance._id.toHexString())
        const label = instance.persona_snapshot?.name?.trim() || lead?.canonical_name
        if (label) item.save_label = label
      }
      if (event && row.kind !== 'portrait') {
        if (row.line_id && row.kind === 'video') {
          // A line film's caption is the spoken line itself.
          const line = event.data.spoken_lines?.find((l) => l.line_id === row.line_id)
          if (line?.voice?.status === 'voiceable') {
            item.excerpt = keepsakeExcerpt(line.voice.spoken_text)
            item.speaker_name = line.voice.speaker_name
          } else {
            item.excerpt = keepsakeExcerpt(event.data.ai_response)
          }
        } else {
          item.excerpt = keepsakeExcerpt(event.data.ai_response)
        }
      }
      if (character) item.character = character
      items.push(item)
      lastKept = { t: row.created_at, id: row._id }
      if (items.length >= limit) {
        moreBeyondKept = examined < fetched.length || peeked
        break
      }
    }
    resume = lastExamined
    if (items.length >= limit) break
    if (!peeked) { exhausted = true; break }
  }
  if (items.length >= limit) {
    // A cursor is present exactly when more rows may follow: a page that ends
    // on an exact fit at the last row carries none.
    if (moreBeyondKept && lastKept) {
      return { items, next_before: encodeKeepsakeCursor(lastKept.t, lastKept.id) }
    }
    return { items }
  }
  // The batch bound, not the rows, ended the fill: what was kept still pages
  // on with a cursor.
  if (!exhausted && lastExamined) {
    return { items, next_before: encodeKeepsakeCursor(lastExamined.t, lastExamined.id) }
  }
  return { items }
}

/** Removes a piece from Keepsakes; it stays under its turn in chat.
 *  Own media only, otherwise 404. Idempotent. */
export async function hideKeepsake(playerId: string, mediaId: string): Promise<void> {
  const pid = parseObjectId(playerId)
  const mid = parseObjectId(mediaId)
  const row = await mongoColl.mediaAssets().findOne({ _id: mid, player_id: pid })
  if (!row) throw new HttpError(404, 'That keepsake could not be found.')
  await mongoColl.mediaAssets().updateOne(
    { _id: mid, player_id: pid },
    { $set: { hidden_from_keepsakes: true } },
  )
}
