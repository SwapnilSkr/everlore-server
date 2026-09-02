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

/**
 * A compact, non-verbatim record of what the narrator just established.
 *
 * This is deliberately semantic rather than a quote or prose recap: it gives
 * the next turn enough emotional and conversational continuity to respond
 * naturally without providing an in-context completion the narrator can copy.
 */
export interface NarrativeBeatLedger {
  npc_beats: Array<{
    character: string
    intent: string
    reaction: string | null
  }>
  emotional_shift: string | null
  /** Concrete place/setting carried forward only when the prose establishes it. */
  setting: string | null
  consequence: string | null
  unresolved_hook: string | null
}

export interface GenerationOutput {
  narrative: string
  state_mutations: Record<string, Mutation>
  flag_mutations: Record<string, FlagMutation>
  scene_tag: string
  emotional_tone: string
  /** Semantic continuity only — never raw dialogue or prose from this turn. */
  beat_ledger: NarrativeBeatLedger
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
   * Sustained physical configurations that BEGAN this turn and are still true
   * at its end — a grip, an embrace, a held blade, a body position. These are
   * the story facts that used to exist only in prose and in accreted state
   * strings nothing ever closed, so a released grip stayed gripped for turns.
   */
  physical_state_opened?: Array<{
    kind: 'restraint' | 'contact' | 'posture' | 'held'
    statement: string
    actors: string[]
  }>
  /** Ongoing physical configurations that ENDED this turn, each with a verbatim
   *  excerpt proving it. The evidence is machine-checked: a small model asked
   *  "which of these ended?" will happily echo the whole list back, so an
   *  uncitable close is discarded and the configuration stays open. */
  physical_state_closed?: Array<{ statement: string; evidence: string }>
  /**
   * Named place where the viewpoint ends this turn. Null/empty means the
   * passage did not establish a place change or concrete current location.
   */
  current_location?: string | null
  /** AI-witnessed destination explicitly carried out in the player's current
   * turn. It is only a candidate; the server verifies it against player text. */
  player_destination?: string | null
  player_travel_confirmed?: boolean
  /**
   * Exact short excerpt the scene witness used to ground `current_location`.
   * It is verified against the player turn or narration before a graph node can
   * be created; it is never shown to players.
   */
  location_evidence?: string | null
  location_evidence_source?: 'player' | 'narrative' | 'prior' | null
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
  /** Verbatim excerpt from the narration proving the span passed. */
  time_evidence?: string | null
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

function compactBeatText(value: unknown, max = 180): string | null {
  if (typeof value !== 'string') return null
  const cleaned = value.replace(/\s+/g, ' ').trim()
  if (!cleaned || /^(none|null|n\/a)$/i.test(cleaned)) return null
  return cleaned.slice(0, max)
}

/** Keep the extracted beat factual, bounded, and safe to inject into prompts. */
export function sanitizeBeatLedger(raw: unknown): NarrativeBeatLedger {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {}
  const npcBeats = Array.isArray(source.npc_beats) ? source.npc_beats : []
  const seen = new Set<string>()
  const normalized = npcBeats.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const row = item as Record<string, unknown>
    const character = compactBeatText(row.character, 80)
    const intent = compactBeatText(row.intent)
    if (!character || !intent) return []
    const key = `${character.toLowerCase()}\u0000${intent.toLowerCase()}`
    if (seen.has(key)) return []
    seen.add(key)
    return [{ character, intent, reaction: compactBeatText(row.reaction) }]
  }).slice(0, 4)

  return {
    npc_beats: normalized,
    emotional_shift: compactBeatText(source.emotional_shift),
    setting: compactBeatText(source.setting),
    consequence: compactBeatText(source.consequence),
    unresolved_hook: compactBeatText(source.unresolved_hook),
  }
}

/**
 * Normalize a raw list of short place-fact clauses: tolerates a string or
 * array, trims/collapses/dedupes case-insensitively, drops the model's empty
 * sentinels, and bounds count and per-item length.
 */
/**
 * Bound and clean the physical-state facts a witness reports.
 *
 * Kept strict: an entry with no kind, no statement, or no actors is not a
 * physical configuration — it is a stray sentence, and admitting it would put
 * an unclosable claim into scene state.
 */
export function sanitizePhysicalFacts(
  raw: unknown,
  max = 4,
): Array<{ kind: 'restraint' | 'contact' | 'posture' | 'held'; statement: string; actors: string[] }> {
  const KINDS = new Set(['restraint', 'contact', 'posture', 'held'])
  const items = Array.isArray(raw) ? raw : []
  const out: Array<{ kind: 'restraint' | 'contact' | 'posture' | 'held'; statement: string; actors: string[] }> = []
  const seen = new Set<string>()
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const kind = String((item as any).kind || '').toLowerCase()
    if (!KINDS.has(kind)) continue
    const statement = String((item as any).statement || '').replace(/\s+/g, ' ').trim().slice(0, 200)
    if (statement.length < 6) continue
    const actors = sanitizePresentCharacters((item as any).actors).slice(0, 4)
    if (actors.length === 0) continue
    const key = statement.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ kind: kind as 'restraint' | 'contact' | 'posture' | 'held', statement, actors })
    if (out.length >= max) break
  }
  return out
}

/** Bound the physical-state closes. An entry with no citable evidence is
 *  meaningless — it is exactly the echo we are trying to reject. */
export function sanitizePhysicalCloses(
  raw: unknown,
  max = 4,
): Array<{ statement: string; evidence: string }> {
  const items = Array.isArray(raw) ? raw : []
  const out: Array<{ statement: string; evidence: string }> = []
  const seen = new Set<string>()
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const statement = String((item as any).statement || '').replace(/\s+/g, ' ').trim().slice(0, 200)
    const evidence = String((item as any).evidence || '').replace(/\s+/g, ' ').trim().slice(0, 200)
    if (statement.length < 6 || evidence.length < 4) continue
    const key = statement.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ statement, evidence })
    if (out.length >= max) break
  }
  return out
}

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

function sanitizeLocationEvidence(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const excerpt = raw.replace(/\s+/g, ' ').trim().slice(0, 220)
  if (!excerpt || /^(null|none|n\/?a|unknown)$/i.test(excerpt)) return null
  return excerpt
}

function sanitizeLocationEvidenceSource(raw: unknown): 'player' | 'narrative' | 'prior' | null {
  return raw === 'player' || raw === 'narrative' || raw === 'prior' ? raw : null
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

const QUOTE_MARKS = /["“”]/g

function choiceLabel(raw: string): string | null {
  const compact = raw.replace(/\s+/g, ' ').trim()
  // A label is UI chrome, never a piece of the player's actual input. Reject a
  // row rather than showing leaked dialogue, markdown, protocol, or a split
  // send-value inside the chip heading.
  if (!compact || /["“”*`|\[\]=]/.test(compact)) return null
  const label = compact.replace(/[.!?,;:]+$/, '').trim()
  const words = label.split(/\s+/).filter(Boolean)
  if (words.length < 1 || words.length > 8 || /^i\b/i.test(label)) return null
  return label.slice(0, 80)
}

function isBalancedNarration(value: string): boolean {
  return (value.match(/\*/g) || []).length % 2 === 0
}

function sentenceEnded(value: string): string {
  const trimmed = value.trim()
  return trimmed && /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`
}

function normalizeActionSend(raw: string): { kind: 'act' | 'say'; send: string } | null {
  let value = raw.replace(/\s+/g, ' ').trim()
  if (!value || !isBalancedNarration(value) || /===\s*choices|\[(?:act|say)\]/i.test(value)) return null

  // A quoted value on an [act] row is actually dialogue. Preserve it as a
  // speaking choice instead of wrapping it as a narrated action.
  if (/^["“].*["”]$/.test(value)) {
    const speech = sentenceEnded(value.replace(QUOTE_MARKS, '').trim())
    return speech ? { kind: 'say', send: speech } : null
  }

  const pureAction = /^\*([^*]+)\*$/.exec(value)
  if (pureAction) {
    const action = pureAction[1].trim()
    if (!/^I\b/i.test(action)) return null
    return { kind: 'act', send: `*${sentenceEnded(action)}*` }
  }

  // A correctly mixed value is necessarily a speaking move: its action is
  // marked and the spoken words sit outside the markers.
  if (value.includes('*')) {
    const spoken = value.replace(/\*[^*]*\*/g, '').replace(QUOTE_MARKS, '').trim()
    if (!spoken) return null
    value = value.replace(QUOTE_MARKS, '').trim()
    return { kind: 'say', send: sentenceEnded(value) }
  }

  // Bare actions are only safe if they are already in the player's first
  // person. Do not turn an imperative fragment such as "Turn my attention…"
  // into a bad prefilled action; the metadata fallback can provide a complete
  // alternative instead.
  if (!/^I\b/i.test(value)) return null
  return { kind: 'act', send: `*${sentenceEnded(value)}*` }
}

function normalizeSpeechSend(raw: string): { kind: 'act' | 'say'; send: string } | null {
  let value = raw.replace(/\s+/g, ' ').trim()
  if (!value || !isBalancedNarration(value) || /===\s*choices|\[(?:act|say)\]/i.test(value)) return null
  value = value.replace(QUOTE_MARKS, '').trim()
  if (!value) return null

  const pureAction = /^\*([^*]+)\*$/.exec(value)
  if (pureAction) {
    const action = pureAction[1].trim()
    if (!/^I\b/i.test(action)) return null
    return { kind: 'act', send: `*${sentenceEnded(action)}*` }
  }
  // A say choice may include a narrated gesture, but it must still contain
  // spoken content outside the asterisks.
  if (value.includes('*') && !value.replace(/\*[^*]*\*/g, '').trim()) return null
  return { kind: 'say', send: sentenceEnded(value) }
}

/**
 * Normalize only complete, separate label/send pairs into editable choices.
 * A malformed choice is discarded rather than exposed as a confusing chip or
 * an invalid composer value. Both narrator-tail and metadata choices pass
 * through this same boundary.
 */
export function sanitizeChoices(raw: unknown): ChoiceOption[] {
  if (!Array.isArray(raw)) return []
  const out: ChoiceOption[] = []
  const seen = new Set<string>()
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
    const normalizedLabel = choiceLabel(label)
    if (!normalizedLabel) continue
    const normalized = kind === 'act' ? normalizeActionSend(content) : normalizeSpeechSend(content)
    if (!normalized) continue
    const send = normalized.send.slice(0, 280)
    const labelKey = normalizedLabel.toLowerCase().replace(/[^a-z0-9]+/g, '')
    const sendKey = send.toLowerCase().replace(/[*"“”'’\s.!?,;:]+/g, '')
    // The heading may summarize the value, but must never BE the value.
    if (!labelKey || labelKey === sendKey || seen.has(`${normalized.kind}\u0000${labelKey}`)) continue
    seen.add(`${normalized.kind}\u0000${labelKey}`)
    out.push({ label: normalizedLabel, kind: normalized.kind, send })
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

    parsed.beat_ledger = sanitizeBeatLedger(parsed.beat_ledger)

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
    parsed.physical_state_opened = sanitizePhysicalFacts(parsed.physical_state_opened)
    parsed.physical_state_closed = sanitizePhysicalCloses(parsed.physical_state_closed)
    parsed.current_location = sanitizeLocationName(parsed.current_location)
    parsed.player_destination = sanitizeLocationName(parsed.player_destination)
    parsed.player_travel_confirmed = parsed.player_travel_confirmed === true
    parsed.location_evidence = sanitizeLocationEvidence(parsed.location_evidence)
    parsed.location_evidence_source = sanitizeLocationEvidenceSource(parsed.location_evidence_source)
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
    beat_ledger: {
      npc_beats: [],
      emotional_shift: null,
      setting: null,
      consequence: null,
      unresolved_hook: null,
    },
    choices: [],
    milestone: null,
    present_characters: [],
    characters_departed: [],
    physical_state_opened: [],
    physical_state_closed: [],
    current_location: null,
    player_destination: null,
    player_travel_confirmed: false,
    location_evidence: null,
    location_evidence_source: null,
    viewpoint_moved: false,
    time_elapsed: null,
    time_evidence: null,
    location_state_changes: [],
    location_permanent_facts: [],
  }
}
