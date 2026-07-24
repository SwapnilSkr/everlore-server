/**
 * Player-confirmed world actions. These arrive over the socket as structured data,
 * never as prose the server has to guess at. They are deliberately small: every
 * field is either a bounded choice or player-visible text that is validated here.
 */
export const WORLD_ACTION_TIME_ADVANCES = ['hours', 'day', 'days', 'season'] as const
export type WorldActionTimeAdvance = (typeof WORLD_ACTION_TIME_ADVANCES)[number]

export const WORLD_ACTION_RELATIONS = [
  // Legacy generic terms remain accepted for older clients and historical
  // actions. The current UI deliberately presents concrete labels instead.
  'mother', 'father', 'parent', 'sister', 'brother', 'sibling',
  'daughter', 'son', 'child', 'spouse', 'partner', 'cousin',
  'aunt', 'uncle', 'grandmother', 'grandfather',
  'niece', 'nephew', 'wife', 'husband', 'fiance', 'fiancee',
] as const
export type WorldActionRelation = (typeof WORLD_ACTION_RELATIONS)[number]

export type PlayerWorldAction =
  | {
      kind: 'travel'
      destination: string
      companions: string[]
      timeAdvance?: WorldActionTimeAdvance
    }
  | {
      kind: 'relationship'
      character: string
      relation: WorldActionRelation
      correction: boolean
      /** The existing relation the player explicitly wants to replace. */
      replacesRelation?: WorldActionRelation
    }

function cleanName(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const text = value.replace(/\s+/g, ' ').trim()
  if (text.length < 2 || text.length > max) return null
  // Control syntax belongs to the protocol, never the display name.
  if (/[<>\[\]{}\n\r]/.test(text)) return null
  return text
}

/** Parse an untrusted WebSocket payload into a safe, player-confirmed action. */
export function parsePlayerWorldAction(value: unknown): PlayerWorldAction | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (raw.kind === 'travel') {
    const destination = cleanName(raw.destination, 80)
    if (!destination) return null
    const companions = Array.isArray(raw.companions)
      ? [...new Set(raw.companions.map((name) => cleanName(name, 80)).filter((name): name is string => !!name))].slice(0, 6)
      : []
    const timeAdvance = typeof raw.time_advance === 'string' &&
      (WORLD_ACTION_TIME_ADVANCES as readonly string[]).includes(raw.time_advance)
      ? raw.time_advance as WorldActionTimeAdvance
      : undefined
    return { kind: 'travel', destination, companions, timeAdvance }
  }
  if (raw.kind === 'relationship') {
    const character = cleanName(raw.character, 80)
    const relation = typeof raw.relation === 'string' &&
      (WORLD_ACTION_RELATIONS as readonly string[]).includes(raw.relation)
      ? raw.relation as WorldActionRelation
      : null
    if (!character || !relation) return null
    const replacesRelation = typeof raw.replaces_relation === 'string' &&
      (WORLD_ACTION_RELATIONS as readonly string[]).includes(raw.replaces_relation)
      ? raw.replaces_relation as WorldActionRelation
      : undefined
    // A correction is destructive only when its target is explicit. Refuse a
    // bare correction rather than leaving two conflicting facts alive.
    if (raw.correction === true && !replacesRelation) return null
    return {
      kind: 'relationship',
      character,
      relation,
      correction: raw.correction === true,
      ...(raw.correction === true && replacesRelation ? { replacesRelation } : {}),
    }
  }
  return null
}
