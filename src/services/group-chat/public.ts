import { env } from '../../config/env'
import type { WorldTemplateDoc } from '../../models/world-template.model'
import { publicTemplate } from '../../utils/template-public-projection'
import type { GroupState } from './types'
import { DIRECT_PENDING_MS } from './notification-policy'

/** The one pending direct message this player has not read yet, if any. The
 *  same rule feeds the room snapshot and the Chats list. */
export function groupPendingFrom(state: GroupState | undefined, now = new Date()): string[] {
  const pending = state?.pending_direct
  if (!env.GROUP_NOTIFICATIONS_ENABLED || !pending) return []
  return now.getTime() - new Date(pending.scheduled_at).getTime() < DIRECT_PENDING_MS ? [pending.member_id] : []
}

/** A save carries a copy of the authored cast. Its stored portrait is internal —
 *  the room card carries the URL. The template's own cast keeps its portrait. */
function withoutPortraits(value: unknown, now: Date): unknown {
  if (!Array.isArray(value)) return value
  return value.map(entry => {
    if (!entry || typeof entry !== 'object') return entry
    const { portrait: _portrait, ...rest } = entry as Record<string, unknown>
    return publicGroupData(rest, now)
  })
}

/** Only plain documents are copied; dates and database ids keep their encoding. */
export function publicGroupData<T>(value: T, now = new Date()): T {
  if (Array.isArray(value)) return value.map(entry => publicGroupData(entry, now)) as T
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return value
  const state = (value as { group_state?: GroupState }).group_state
  const extra = env.GROUP_NOTIFICATIONS_ENABLED && state ? { pending_from: groupPendingFrom(state, now) } : {}
  return { ...Object.fromEntries(Object.entries(value).filter(([key]) =>
    !['dm_with', 'private_to', 'start_bond', 'intimacy', 'voice', 'wants', 'talkativeness', 'topics', 'group_state', 'group_state_after', 'group_context', 'group_template_id', 'cost', 'cost_usd', 'tame', 'scene_members', 'tame_members', 'pending_direct', 'scheduled_at', 'notified_at', 'last_direct_notified_at', 'group_notification_usage'].includes(key),
  ).map(([key, entry]) => [key, key === 'seed_cast_snapshot' ? withoutPortraits(entry, now) : publicGroupData(entry, now)])), ...extra } as T
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
