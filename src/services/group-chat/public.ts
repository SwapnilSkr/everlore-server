import { createHash } from 'node:crypto'
import { env } from '../../config/env'
import type { WorldTemplateDoc } from '../../models/world-template.model'
import { publicTemplate } from '../../utils/template-public-projection'
import { withMemberReadings } from './ideas'
import type { GroupLine, GroupSelfie, GroupState, GroupStatusLines } from './types'
import { DIRECT_PENDING_MS } from './notification-policy'

/** The one pending direct message this player has not read yet, if any. The
 *  same rule feeds the room snapshot and the Chats list. */
export function groupPendingFrom(state: GroupState | undefined, now = new Date()): string[] {
  const pending = state?.pending_direct
  if (!env.GROUP_NOTIFICATIONS_ENABLED || !pending) return []
  return now.getTime() - new Date(pending.scheduled_at).getTime() < DIRECT_PENDING_MS ? [pending.member_id] : []
}

/** A save's cast keeps its stored portrait internal — the room card carries the
 *  URL, and the template's cast still carries the portrait that names it. The
 *  written first texts and statuses only ever travel on the member's card. */
function withoutCastFields(value: unknown, keys: string[], now: Date): unknown {
  if (!Array.isArray(value)) return value
  return value.map(entry => {
    if (!entry || typeof entry !== 'object') return entry
    const rest = { ...(entry as Record<string, unknown>) }
    for (const key of keys) delete rest[key]
    return publicGroupData(rest, now)
  })
}

/** The same identity used by group-line reports; independent of display timing. */
export const groupLineId = (line: { character_id: string; text: string }): string =>
  createHash('sha256').update(JSON.stringify([line.character_id, line.text])).digest('hex')

/** Repeated projection (history then controller) preserves only the wire shape. */
function publicGroupLine(value: unknown, selfies: Record<string, GroupSelfie> | undefined, now: Date): unknown {
  if (!value || typeof value !== 'object' || !('character_id' in value) || !('text' in value) ||
      typeof value.character_id !== 'string' || typeof value.text !== 'string') return publicGroupData(value, now)
  const line = value as GroupLine
  const { selfie: prior, ...rest } = line
  const lineId = groupLineId(line)
  const selfie = selfies?.[lineId] ?? prior
  return { ...publicGroupData(rest, now), line_id: lineId, ...(selfie ? { selfie: {
    status: selfie.status, ...(selfie.media_id ? { media_id: selfie.media_id } : {}),
    ...(selfie.status === 'ready' && selfie.url ? { url: selfie.url } : {}),
    ...(selfie.status === 'resting' && selfie.resets_at ? { resets_at: selfie.resets_at } : {}),
  } } : {}) }
}

interface HistoryMember {
  name: string
  first_texts?: string[]
  statuses?: GroupStatusLines
}

interface HistoryRead {
  newestIdeas: string[] | undefined
  firstTexts: boolean
  members: HistoryMember[]
  offsetMinutes: number | undefined
}

/** A loaded history is the only payload that carries reply ideas and member
 *  readings. The newest event of the thread sends its ideas; an empty thread
 *  (which can only be a direct one, since a room opens seeded) offers the
 *  members' written first texts. */
function historyRead(value: Record<string, unknown>, now: Date): HistoryRead | undefined {
  const recent = value.recentEvents
  if (!Array.isArray(recent)) return undefined
  const instance = value.instance as { group_state?: GroupState; seed_cast_snapshot?: HistoryMember[] } | undefined
  const state = instance?.group_state
  const newest = recent.at(-1) as { data?: { reply_ideas?: unknown } } | undefined
  const ideas = newest?.data?.reply_ideas
  const hasLines = recent.some(event => {
    const data = (event as { data?: { lines?: unknown[]; player_input?: unknown } })?.data
    return (Array.isArray(data?.lines) && data.lines.length > 0) ||
      (typeof data?.player_input === 'string' && data.player_input.length > 0)
  })
  return {
    newestIdeas: Array.isArray(ideas) ? ideas.filter((idea): idea is string => typeof idea === 'string') : undefined,
    firstTexts: !hasLines && !!state && groupPendingFrom(state, now).length === 0,
    members: instance?.seed_cast_snapshot || [],
    offsetMinutes: state?.tz_offset_minutes,
  }
}

/** Only plain documents are copied; dates and database ids keep their encoding. */
export function publicGroupData<T>(value: T, now = new Date()): T {
  if (Array.isArray(value)) return value.map(entry => publicGroupData(entry, now)) as T
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return value
  const selfies = (value as { group_selfies?: Record<string, GroupSelfie> }).group_selfies
  const state = (value as { group_state?: GroupState }).group_state
  const extra = env.GROUP_NOTIFICATIONS_ENABLED && state ? { pending_from: groupPendingFrom(state, now) } : {}
  const history = historyRead(value as Record<string, unknown>, now)
  const output = { ...Object.fromEntries(Object.entries(value).filter(([key]) =>
    !['group_selfies', 'dm_with', 'private_to', 'start_bond', 'intimacy', 'voice', 'wants', 'talkativeness', 'topics', 'group_state', 'group_state_after', 'group_context', 'group_template_id', 'cost', 'cost_usd', 'tame', 'scene_members', 'tame_members', 'pending_direct', 'scheduled_at', 'notified_at', 'last_direct_notified_at', 'group_notification_usage', 'reply_ideas'].includes(key),
  ).map(([key, entry]) => [key, key === 'seed_cast_snapshot' ? withoutCastFields(entry, ['portrait', 'first_texts', 'statuses'], now)
    : key === 'seed_cast' ? withoutCastFields(entry, ['first_texts', 'statuses'], now)
    : key === 'lines' && Array.isArray(entry) ? entry.map(line => publicGroupLine(line, selfies, now)) : publicGroupData(entry, now)])), ...extra } as T
  if (history) {
    const row = output as Record<string, unknown>
    if (Array.isArray(row.characters)) row.characters = withMemberReadings(row.characters as Array<{ canonical_name?: string }>, history.members, {
      ...(history.offsetMinutes === undefined ? {} : { offsetMinutes: history.offsetMinutes }), firstTexts: history.firstTexts, now,
    })
    const events = row.recentEvents
    const newest = Array.isArray(events) ? events.at(-1) as { data?: Record<string, unknown> } | undefined : undefined
    if (history.newestIdeas?.length && newest?.data) newest.data = { ...newest.data, reply_ideas: history.newestIdeas }
  }
  return output
}

/** A face's absolute address. The same join as `portraitUrl()`, kept here
 *  because that module loads the image service and no read path needs it. */
const faceUrl = (assetKey: string) => `${env.CDN_BASE_URL.replace(/\/+$/, '')}/${assetKey}`

type FaceTemplate = Pick<WorldTemplateDoc, 'seed_cast'> | null | undefined

/** Authored faces by cast name. Read from the template on every request, so art
 *  published later reaches saves that already exist. */
export function groupFaces(template: FaceTemplate): Map<string, string> {
  const faces = new Map<string, string>()
  for (const entry of template?.seed_cast || []) {
    if (entry.portrait?.asset_key) faces.set(entry.name.trim().toLowerCase(), faceUrl(entry.portrait.asset_key))
  }
  return faces
}

export interface GroupPreviewMember {
  name: string
  role?: string
  portrait_url?: string
}

/** Who is in a group before joining: a name, a role and a face, never an
 *  authored trait or the cast itself. */
export function groupPreviewMembers(template: Partial<WorldTemplateDoc>): GroupPreviewMember[] {
  const faces = groupFaces(template as FaceTemplate)
  return (template.seed_cast || []).map(entry => {
    const portrait = faces.get(entry.name.trim().toLowerCase())
    return {
      name: entry.name,
      ...(entry.role ? { role: entry.role } : {}),
      ...(portrait ? { portrait_url: portrait } : {}),
    }
  })
}

/** The public template. Only a group also carries its members, so every other
 *  kind reads exactly as it did before. */
export function publicGroupTemplate<T extends Partial<WorldTemplateDoc>>(
  template: T,
): ReturnType<typeof publicTemplate<T>> & { members?: GroupPreviewMember[] } {
  const base = publicTemplate(template)
  if (template.kind !== 'group') return base
  return { ...base, members: groupPreviewMembers(template) }
}

/** A room card: its authored face as a URL, and never the stored portrait —
 *  its asset key is internal. A card with no authored face has no URL. */
export function withGroupFace<T extends { canonical_name?: string }>(
  card: T,
  faces: Map<string, string>,
): Omit<T, 'portrait'> & { portrait_url?: string } {
  const { portrait: _portrait, ...rest } = card as T & { portrait?: unknown }
  const face = faces.get(String(card.canonical_name || '').trim().toLowerCase())
  return { ...rest, ...(face ? { portrait_url: face } : {}) }
}

/** A group payload that carries the cast: add each authored face, drop the
 *  stored portrait, then strip everything private. */
export function publicGroupPayload<T extends object>(
  value: T,
  template: FaceTemplate,
  now = new Date(),
): T {
  const characters = (value as { characters?: unknown }).characters
  const faces = groupFaces(template)
  const faced = Array.isArray(characters)
    ? { ...value, characters: characters.map(card => withGroupFace(card as { canonical_name?: string }, faces)) }
    : value
  return publicGroupData(faced as T, now)
}
