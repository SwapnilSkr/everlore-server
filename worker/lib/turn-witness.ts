import type { ChoiceEnglish, ReplayWitness, TurnWitness } from '../../src/utils/witness'
import { emptyPlayerParse } from './player-turn'
import { parsePlayerInput } from '../../src/utils/player-input-parser'
import {
  makeWitness,
  type NarrationPov,
  type WitnessCopyDeps,
  type WitnessProblemReason,
} from './witness-copy'

/**
 * The decision of §4: does this turn get a hidden English copy, was it accepted,
 * and what does the stored turn carry because of it.
 *
 * Pure and injected like `makeWitness`: the model call is a dependency, so the
 * audit drives accepted, rejected and aborted turns without a network. An
 * English turn returns `not_needed` and makes no call at all, which is what
 * keeps the English path byte-identical.
 */

export interface TurnWitnessLanguage {
  /** Registry code stored on the witness, e.g. `pt`. */
  code: string
  /** Model-facing name, e.g. "Brazilian Portuguese". */
  name: string
}

export interface TurnWitnessInput {
  /** The save's language. Absent/`null` is an English turn: nothing happens. */
  language?: TurnWitnessLanguage | null
  /** The player's own words, native. Empty on a continue or a world action. */
  playerNative: string
  /** The narration that streamed, native. */
  proseNative: string
  /** A tapped choice's stored English, when the turn is a tap. */
  knownPlayerEnglish?: string
  /** The turn before, in English, so a dropped subject is not guessed. */
  previous?: { player: string; prose: string }
  /** The world's authored words, so a new place keeps the world's name. */
  worldContext?: string
  people: string[]
  places: string[]
  pov: NarrationPov
  playerName?: string | null
  protagonistName?: string | null
  isSentient?: boolean
  signal?: AbortSignal
}

export type TurnWitnessOutcome =
  | { status: 'not_needed' }
  | { status: 'accepted'; player: string; prose: string; attempts: number; ms: number }
  | { status: 'rejected'; reason: WitnessProblemReason; attempts: number; ms: number }

export interface TurnWitnessDeps extends WitnessCopyDeps {
  /** Test seam for the elapsed-ms reading. */
  now?: () => number
}

/**
 * Make the copy for a non-English turn. Never throws except when
 * `input.signal` aborts (which `makeWitness` rethrows). An English turn never
 * calls the model.
 */
export async function runTurnWitness(
  input: TurnWitnessInput,
  deps: TurnWitnessDeps = {},
): Promise<TurnWitnessOutcome> {
  if (!input.language) return { status: 'not_needed' }
  const now = deps.now ?? Date.now
  const startedAt = now()
  const result = await makeWitness(
    {
      language: input.language.name,
      playerInput: String(input.playerNative ?? ''),
      prose: String(input.proseNative ?? ''),
      people: input.people,
      places: input.places,
      pov: input.pov,
      playerName: input.playerName ?? null,
      protagonistName: input.protagonistName ?? null,
      isSentient: input.isSentient,
      ...(input.knownPlayerEnglish !== undefined ? { knownPlayerEnglish: input.knownPlayerEnglish } : {}),
      ...(input.previous ? { previous: input.previous } : {}),
      ...(input.worldContext ? { worldContext: input.worldContext } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    },
    deps,
  )
  const ms = Math.max(0, now() - startedAt)
  if (result.ok) {
    return { status: 'accepted', player: result.player, prose: result.prose, attempts: result.attempts, ms }
  }
  return { status: 'rejected', reason: result.reason, attempts: result.attempts, ms }
}

export interface WitnessEventFieldsInput {
  /** The save's language. Absent/`null` is an English turn. */
  language?: TurnWitnessLanguage | null
  /** The accepted copy, or `null` when the copy was refused. */
  accepted: { player: string; prose: string } | null
  /** English choices, aligned by index with the turn's native `choices`. */
  choices?: ChoiceEnglish[]
}

/**
 * The witness portion of a stored turn (§5). All four text fields are always
 * present when a witness exists — empty string/array on a continue — and
 * `witness_status` appears only on failure. An English turn adds nothing.
 */
export function witnessEventFields(
  input: WitnessEventFieldsInput,
): { witness?: TurnWitness; witness_status?: 'failed' } {
  if (!input.language) return {}
  if (!input.accepted) return { witness_status: 'failed' }
  const english = input.accepted.player.trim() ? parsePlayerInput(input.accepted.player) : emptyPlayerParse()
  const choices = input.choices && input.choices.length ? { choices: input.choices } : {}
  return {
    witness: {
      lang: input.language.code,
      ai_response: input.accepted.prose,
      player_input: input.accepted.player,
      player_spoken_input: english.spoken,
      player_narration_facts: english.narrationFacts,
      ...choices,
    },
  }
}

/**
 * The witness portion of a replay variant (§5/§7): prose and its choices only;
 * the player text is the event's own. An accepted non-English copy stores the
 * witness; a refused one stores `witness_status: 'failed'`, so selecting the
 * variant knows it has to retry. An English variant adds nothing.
 */
export function replayWitnessFields(
  input: WitnessEventFieldsInput,
): { witness?: ReplayWitness; witness_status?: 'failed' } {
  if (!input.language) return {}
  if (!input.accepted) return { witness_status: 'failed' }
  const choices = input.choices && input.choices.length ? { choices: input.choices } : {}
  return {
    witness: {
      lang: input.language.code,
      ai_response: input.accepted.prose,
      player_input: input.accepted.player,
      ...choices,
    },
  }
}
