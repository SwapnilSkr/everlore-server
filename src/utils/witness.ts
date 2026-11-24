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
 * A replay variant keeps the prose and its choices (§7); its player text is the
 * event's own, so a variant witness is not a full TurnWitness.
 */
export type ReplayWitness = Pick<TurnWitness, 'lang' | 'ai_response' | 'choices'>

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
 * The witness's values when it is present and well formed, otherwise the
 * event's own values exactly — same references, same `undefined`s. Never
 * throws; a missing row, a partial projection or a failed witness all fall back
 * to native.
 */
export function witnessOf(event: unknown): WitnessView {
  const data = dataOf(event)
  const witness = objectOf(data.witness)
  if (witness && data.witness_status !== 'failed' && wellFormed(witness)) {
    return {
      ai_response: witness.ai_response as string,
      player_input: witness.player_input as string,
      player_spoken_input: witness.player_spoken_input as string | undefined,
      player_narration_facts: witness.player_narration_facts as string[] | undefined,
    }
  }
  return {
    ai_response: data.ai_response as string | undefined,
    player_input: data.player_input as string | undefined,
    player_spoken_input: data.player_spoken_input as string | undefined,
    player_narration_facts: data.player_narration_facts as string[] | undefined,
  }
}
