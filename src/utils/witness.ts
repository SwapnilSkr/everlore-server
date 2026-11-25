/**
 * The hidden English copy of a non-English turn (the *witness*).
 *
 * `data.ai_response` and `data.player_input` stay native: display, edit box,
 * media, moderation and admin read those. Everything that decides what HAPPENED
 * reads the witness instead (contract: `everlore-docs/phases/reply-language.md`
 * §4). English turns have no witness and this module hands back the event's own
 * values untouched.
 */

/** One choice's English `label`/`send`, aligned by index with `data.choices`. */
export interface ChoiceEnglish {
  label: string
  send: string
}

export interface TurnWitness {
  /** The save's language code (the registry code, e.g. `pt`). */
  lang?: string
  ai_response: string
  player_input: string
  player_spoken_input?: string
  player_narration_facts?: string[]
  /** English choices, aligned by index with `data.choices` (§5). */
  choices?: ChoiceEnglish[]
}

/**
 * A replay variant keeps the prose and its choices (§7) plus the English player
 * text, so a variant that is selected or re-run carries the same English the
 * live turn had (rl-4 reads it). Still not a full `TurnWitness`: the spoken
 * input and narration facts are the event's own.
 */
export type ReplayWitness = Pick<TurnWitness, 'lang' | 'ai_response' | 'player_input' | 'choices'>

/** What every post-stream reader should consume instead of the event's fields. */
export interface WitnessView {
  ai_response: string | undefined
  player_input: string | undefined
  player_spoken_input: string | undefined
  player_narration_facts: string[] | undefined
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

/**
 * A raw Mongo row carries the event under `data`; a partial projection IS the
 * data. Both shapes reach `witnessOf`, so accept either.
 */
function dataOf(event: unknown): Record<string, unknown> {
  const row = objectOf(event)
  if (!row) return {}
  return objectOf(row.data) ?? row
}

/**
 * A witness is usable only when it has a non-empty prose and a player text (an
 * empty player text is legitimate on a continue, where the native one is empty
 * too), and the turn did not mark the copy failed.
 */
function wellFormed(witness: Record<string, unknown>): boolean {
  return typeof witness.ai_response === 'string'
    && witness.ai_response.trim().length > 0
    && typeof witness.player_input === 'string'
}

/**
 * The raw stored witness when it is usable (present, well formed, not marked
 * failed), else `null`. A flow that must rewrite the witness in place — replay,
 * edit, select (§7) — needs the fields `witnessOf` does not expose (`lang`,
 * `choices`), and needs to know whether there is anything to preserve.
 */
export function storedWitness(event: unknown): TurnWitness | null {
  const data = dataOf(event)
  const witness = objectOf(data.witness)
  if (witness && data.witness_status !== 'failed' && wellFormed(witness)) {
    return witness as unknown as TurnWitness
  }
  return null
}

/**
 * The witness's values when it is present and well formed, otherwise the
 * event's own values exactly — same references, same `undefined`s. Never
 * throws; a missing row, a partial projection or a failed witness all fall back
 * to native.
 */
export function witnessOf(event: unknown): WitnessView {
  const data = dataOf(event)
  const witness = storedWitness(event)
  if (witness) {
    return {
      ai_response: witness.ai_response,
      player_input: witness.player_input,
      player_spoken_input: witness.player_spoken_input,
      player_narration_facts: witness.player_narration_facts,
    }
  }
  return {
    ai_response: data.ai_response as string | undefined,
    player_input: data.player_input as string | undefined,
    player_spoken_input: data.player_spoken_input as string | undefined,
    player_narration_facts: data.player_narration_facts as string[] | undefined,
  }
}

/**
 * Every projection that feeds a moved reader must ALSO fetch these two fields,
 * or `witnessOf` silently reads a native row that carries a hidden English copy
 * (§4, point 3). Exported so an audit can prove the projection has them.
 */
export const WITNESS_PROJECTION = { 'data.witness': 1, 'data.witness_status': 1 } as const

/**
 * The player's own words as the engine decided them: the English copy on a
 * non-English turn, else the event's native text. `fallback` covers a stored
 * row that keeps its text under another key (a replay's `userMessage`). A
 * continue and a world action legitimately have no player text, so '' is exact.
 */
export function playerTextOf(event: unknown, fallback?: string): string {
  return witnessOf(event).player_input || fallback || ''
}

/**
 * §9a keyword recall: the text the keyword (`$text`) search should take.
 *
 * Memories are written in English, so a tapped choice that carries stored
 * English searches with that English; a typed line or an edited chip has none
 * and searches with its own text. The EMBEDDING stays on the native text (the
 * prefetch already started it) — only the keyword half moves, so nothing
 * re-embeds and nothing waits.
 *
 * The chip's English is passed in (`offeredChipEnglish` in
 * `worker/lib/player-turn.ts`) rather than imported: this module is read by the
 * event model and every turn path, and it must stay free of the worker's turn
 * machinery. `null`/`undefined` means "no stored English".
 */
export function keywordQueryTextFor(nativeText: string, chipEnglish?: string | null): string {
  return chipEnglish && chipEnglish.trim() ? chipEnglish : nativeText
}

export interface WitnessGlossaryInput {
  /** Every character card of the save, aliases included. Never a truncated list:
   *  a name dropped here is a name the copy is allowed to mistranslate. */
  cards?: Array<{ canonical_name?: unknown; aliases?: unknown }>
  /** Whoever is in the scene now. */
  present?: string[]
  /** The player's persona in a sentient world. */
  personaName?: string | null
  /** The viewpoint character's name. */
  protagonistName?: string | null
  /** People the place graph already knows. */
  graphPeople?: string[]
  /** Known locations, aliases included. */
  places?: Array<{ name?: unknown; aliases?: unknown }>
  currentLocationName?: string | null
}

/**
 * The one glossary builder (§4): every known person and place, in the live
 * turn's order, so the live turn and the replay/edit/select flows all hand the
 * copy the same list. Empty and non-string entries are dropped; duplicates are
 * left to `makeWitness`, which de-dupes without moving the order.
 */
export function witnessGlossary(input: WitnessGlossaryInput): { people: string[]; places: string[] } {
  const people = [
    ...(input.cards || []).flatMap((card) => [
      card?.canonical_name,
      ...(Array.isArray(card?.aliases) ? (card.aliases as unknown[]) : []),
    ]),
    ...(input.present || []),
    input.personaName,
    input.protagonistName,
    ...(input.graphPeople || []),
  ].filter((name): name is string => typeof name === 'string' && !!name.trim())
  const places = [
    ...(input.places || []).flatMap((place) => [
      place?.name,
      ...(Array.isArray(place?.aliases) ? (place.aliases as unknown[]) : []),
    ]),
    input.currentLocationName,
  ].filter((name): name is string => typeof name === 'string' && !!name.trim())
  return { people, places }
}
