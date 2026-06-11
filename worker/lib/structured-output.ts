import type { FlagMutation, Mutation } from '../../src/utils/state-mutator'

/**
 * A tap-to-play suggestion. `label` is the short chip caption the player sees;
 * `send` is the editable, pre-formatted player input the chip drops into the
 * composer. It may mix a narrated action (inside *asterisks*) and spoken words
 * (bare), e.g. `*I step closer, lowering my voice.* What are you hiding?`. The
 * player can edit `send` before dispatching. `kind` is a presentation hint
 * (`say` when the move includes spoken words, otherwise `act`).
 */
export interface ChoiceOption {
  label: string
  kind: 'act' | 'say'
  send: string
}

export interface GenerationOutput {
  narrative: string
  state_mutations: Record<string, Mutation>
  flag_mutations: Record<string, FlagMutation>
  scene_tag: string
  emotional_tone: string
  /** 2-4 short suggested player moves for the next turn (tap-to-play chips). */
  choices: ChoiceOption[]
  /** Set only when this turn crossed a true story landmark; null otherwise. */
  milestone: string | null
  /**
   * Names of characters physically present in the scene at the END of this
   * turn — those the player could speak to or act on right now. Drives
   * scene-aware bond actions (approach vs. seek out). Empty when the
   * protagonist is alone or presence is unknown. NOTE: the model reports only
   * who it sees in THIS passage; the worker folds this with the prior turn's
   * presence (minus {@link characters_departed}) so a still-present but
   * unnamed character isn't dropped — see generation.processor.
   */
  present_characters: string[]
  /**
   * Names of characters who physically LEFT the scene during this turn (walked
   * out, were dismissed, died). The worker removes these from the carried-forward
   * presence set so departures actually take effect. Empty almost always.
   */
  characters_departed?: string[]
  /**
   * Named place where the viewpoint ends this turn. Null/empty means the
   * passage did not establish a place change or concrete current location.
   */
  current_location?: string | null
  /**
   * Witness fields for the location-graph cartographer (P1). `containment_hint`
   * is the immediate container of current_location, but ONLY when the passage
   * states it (else null) — never guessed. `movement` is how current_location
   * relates to the prior place: none | deeper (went into a sub-place) | out (left
   * to the surrounding area) | lateral (same level) | world_shift (crossed into a
   * different world/realm). The SERVER turns these into parent_id/world_root_id.
   */
  containment_hint?: string | null
  movement?: 'none' | 'deeper' | 'out' | 'lateral' | 'world_shift'
  /**
   * True ONLY when the passage narrates the viewpoint physically relocating to a
   * DIFFERENT place this turn (walking out, entering another room, a journey, a
   * scene-cut that moves them). The server requires this before moving the
   * location cursor or recording a travel event — a place merely mentioned,
   * planned, or discussed on an unmoved turn never relocates the protagonist.
   */
  viewpoint_moved?: boolean
  /**
   * In-world time the passage itself narrates elapsing this turn (e.g. "three
   * days", "a week later"). Null when the scene is continuous. Advances the
   * day-level calendar even on a normal turn — travel and other narrated time
   * skips, not only the explicit wait/continue button.
   */
  time_elapsed?: string | null
  /**
   * Things that became true about the CURRENT place this turn — mutable world
   * state of the location ("the gate now lies in ruins", "the market is
   * abandoned"). Short, self-contained clauses. Empty when nothing about the
   * place changed.
   */
  location_state_changes?: string[]
  /**
   * Enduring, canonical facts about the current place established this turn
   * ("the temple was built over a buried god", "the bridge is the only crossing
   * for fifty miles"). Append-only place canon. Empty almost always.
   */
  location_permanent_facts?: string[]
}

/**
 * Normalize a raw list of short place-fact clauses: tolerates a string or
 * array, trims/collapses/dedupes case-insensitively, drops the model's empty
 * sentinels, and bounds count and per-item length.
 */
export function sanitizeFactList(raw: unknown, max = 6): string[] {
  const items = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of items) {
    if (typeof item !== 'string') continue
    const text = item.replace(/\s+/g, ' ').trim().slice(0, 200)
    if (!text) continue
    if (/^(null|none|n\/?a|no change|unchanged|nothing)$/i.test(text)) continue
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(text)
    if (out.length >= max) break
  }
  return out
}

/**
 * Normalize a raw narrated-time-elapsed label. Rejects the model's "no time
 * passed" sentinels so a continuous scene never nudges the calendar; bounds
 * length. Returns null when nothing meaningful elapsed.
 */
export function sanitizeTimeElapsed(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const label = raw.replace(/\s+/g, ' ').trim().slice(0, 80)
  if (!label) return null
  if (/^(null|none|n\/?a|no time|moments?|instant|immediate|continuous|same (day|time)|unchanged|0)$/i.test(label)) {
    return null
  }
  return label
}

export function sanitizeLocationName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const name = raw.replace(/\s+/g, ' ').trim().slice(0, 120)
  if (!name || /^(null|none|unknown|same|unchanged|current location)$/i.test(name)) return null
  return name
}

const MOVEMENT_VALUES = new Set(['none', 'deeper', 'out', 'lateral', 'world_shift'])
/** Coerce the cartographer movement hint to a known value; default "none". */
export function sanitizeMovement(raw: unknown): 'none' | 'deeper' | 'out' | 'lateral' | 'world_shift' {
  return typeof raw === 'string' && MOVEMENT_VALUES.has(raw) ? (raw as never) : 'none'
}

/**
 * Normalize a raw present-characters list into clean, deduped display names.
 * Tolerates a single string or array; trims, collapses whitespace, drops blanks
 * and case-insensitive duplicates, and bounds the count/length.
 */
export function sanitizePresentCharacters(raw: unknown): string[] {
  const items = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of items) {
    if (typeof item !== 'string') continue
    const name = item.replace(/\s+/g, ' ').trim().slice(0, 60)
    if (!name) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(name)
    if (out.length >= 12) break
  }
  return out
}

/**
 * Normalize raw model choices into editable, well-formed {@link ChoiceOption}s.
 *
 * Intentional formatting is preserved: if `send` already marks narration with
 * *asterisks* — including a mix of narration and spoken words — it is trusted
 * as-is. Only a bare, unmarked ACTION is wrapped in asterisks, so that a tapped
 * action like "Take her hand" can never be dispatched as spoken words. A `say`
 * move with no markers is left bare (spoken aloud). Tolerates the legacy
 * `string[]` shape (treated as narrated actions).
 */
export function sanitizeChoices(raw: unknown): ChoiceOption[] {
  if (!Array.isArray(raw)) return []
  const out: ChoiceOption[] = []
  for (const item of raw) {
    let label = ''
    let kind: 'act' | 'say' = 'act'
    let content = ''
    if (typeof item === 'string') {
      label = item
      content = item
    } else if (item && typeof item === 'object') {
      const r = item as Record<string, unknown>
      label = typeof r.label === 'string' ? r.label : ''
      kind = r.kind === 'say' ? 'say' : 'act'
      content =
        typeof r.send === 'string' && r.send.trim()
          ? r.send
          : typeof r.text === 'string'
            ? r.text
            : label
    } else {
      continue
    }
    label = label.replace(/\s+/g, ' ').trim().slice(0, 80)
    if (!label) continue
    let send = content.replace(/\s+/g, ' ').trim().slice(0, 280)
    if (!send) continue
    // A bare action (no narration markers) must be wrapped, or the input parser
    // would treat it as spoken dialogue. Anything already containing asterisks
    // (pure narration or mixed narration + speech) is left exactly as authored.
    if (kind === 'act' && !send.includes('*')) {
      send = `*${send}*`
    }
    out.push({ label, kind, send })
    if (out.length >= 4) break
  }
  return out
}

const VALID_SCENE_TAGS = new Set([
  'dialogue', 'combat', 'romantic', 'intimate', 'exploration',
  'existential', 'cosmic', 'mundane',
])

export function enforceSchema(rawResponse: string): GenerationOutput {
  try {
    const parsed = JSON.parse(rawResponse)

    // Validate required fields
    if (!parsed.narrative || typeof parsed.narrative !== 'string') {
      throw new Error('Missing or invalid narrative')
    }

    // Ensure state_mutations is an object
    if (!parsed.state_mutations || typeof parsed.state_mutations !== 'object') {
      parsed.state_mutations = {}
    }

    // Validate each mutation
    const rawState = parsed.state_mutations as Record<string, unknown>
    const stateMutations: Record<string, Mutation> = {}
    for (const [key, val] of Object.entries(rawState)) {
      if (!val || typeof val !== 'object') continue
      const m = val as { op?: unknown; value?: unknown }
      if (m.op !== 'add' && m.op !== 'subtract' && m.op !== 'set') continue
      if (typeof m.value !== 'number') continue
      stateMutations[key] = { op: m.op, value: m.value }
    }
    parsed.state_mutations = stateMutations

    // Ensure flag_mutations is an object
    if (!parsed.flag_mutations || typeof parsed.flag_mutations !== 'object') {
      parsed.flag_mutations = {}
    }

    const rawFlags = parsed.flag_mutations as Record<string, unknown>
    const flagMutations: Record<string, FlagMutation> = {}
    for (const [key, val] of Object.entries(rawFlags)) {
      if (!val || typeof val !== 'object') continue
      const m = val as { op?: unknown; value?: unknown }
      if (m.op !== 'set' && m.op !== 'increment' && m.op !== 'decrement') continue
      flagMutations[key] = m.op === 'set' ? { op: 'set', value: m.value } : { op: m.op }
    }
    parsed.flag_mutations = flagMutations

    // Validate scene_tag
    if (!parsed.scene_tag || !VALID_SCENE_TAGS.has(parsed.scene_tag)) {
      parsed.scene_tag = 'dialogue'
    }

    // Ensure emotional_tone
    if (!parsed.emotional_tone || typeof parsed.emotional_tone !== 'string') {
      parsed.emotional_tone = 'neutral'
    }

    // Choices: up to 4 structured, correctly-formatted tap-to-play suggestions.
    parsed.choices = sanitizeChoices(parsed.choices)

    // Milestone: short label or null (empty/placeholder strings normalize to null).
    parsed.milestone =
      typeof parsed.milestone === 'string' && parsed.milestone.trim() && !/^(null|none)$/i.test(parsed.milestone.trim())
        ? parsed.milestone.replace(/\s+/g, ' ').trim().slice(0, 120)
        : null

    // Present characters: clean, bounded list driving scene-aware bond actions.
    parsed.present_characters = sanitizePresentCharacters(parsed.present_characters)
    parsed.characters_departed = sanitizePresentCharacters(parsed.characters_departed)
    parsed.current_location = sanitizeLocationName(parsed.current_location)
    parsed.containment_hint = sanitizeLocationName(parsed.containment_hint)
    parsed.movement = sanitizeMovement(parsed.movement)
    parsed.viewpoint_moved = parsed.viewpoint_moved === true
    parsed.time_elapsed = sanitizeTimeElapsed(parsed.time_elapsed)
    parsed.location_state_changes = sanitizeFactList(parsed.location_state_changes)
    parsed.location_permanent_facts = sanitizeFactList(parsed.location_permanent_facts)

    return parsed as GenerationOutput
  } catch (err) {
    // Attempt to extract narrative from malformed response
    return repairResponse(rawResponse)
  }
}

function repairResponse(raw: string): GenerationOutput {
  // Try to extract JSON from markdown code blocks
  const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (jsonMatch) {
    try {
      return enforceSchema(jsonMatch[1])
    } catch {
      // Fall through to text extraction
    }
  }

  // Try to find JSON object in the response
  const objectMatch = raw.match(/\{[\s\S]*\}/)
  if (objectMatch) {
    try {
      return enforceSchema(objectMatch[0])
    } catch {
      // Fall through
    }
  }

  // Last resort: use the raw text as narrative with neutral mutations
  return {
    narrative: raw.slice(0, 2000),
    state_mutations: {},
    flag_mutations: {},
    scene_tag: 'dialogue',
    emotional_tone: 'neutral',
    choices: [],
    milestone: null,
    present_characters: [],
    characters_departed: [],
    current_location: null,
    viewpoint_moved: false,
    time_elapsed: null,
    location_state_changes: [],
    location_permanent_facts: [],
  }
}
