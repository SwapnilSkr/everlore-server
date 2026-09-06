/**
 * What the player has become, derived from what they have done.
 *
 * None of this is stored. Standing, marks and the ending are recomputed from
 * the flags and the choices already recorded, every time they are asked for.
 * That is deliberate: derived state that is also persisted drifts the moment
 * authored content is retuned, and the retuning is the whole point of keeping
 * progression in a sidecar. A designer who changes a standing delta wants every
 * existing save to reflect it, not only saves made after the change.
 *
 * The one thing that IS persisted is the ending flag, because an ending is a
 * historical fact rather than a derivation — see `endingFlag` below.
 */
import {
  satisfies,
  type WorldEnding,
  type WorldMark,
  type WorldPetition,
  type WorldProgression,
  type WorldReign,
} from './world-source'

/**
 * Recorded when an ending's trigger first fires.
 *
 * An ending must persist even if the player later acquires a flag that would
 * make its trigger false — the succession happened, and a `none_of` clause
 * going stale afterwards cannot un-happen it. So the ending is latched into a
 * flag once and read back from there, and the trigger is only ever consulted
 * while no ending has been reached.
 */
export const endingFlag = (endingId: string) => `ending_${endingId}`

/** Set alongside the ending flag. Gates every petition, so none leak into Chapter I. */
export const PETITIONS_OPEN = 'petitions_open'

export interface ProgressionView {
  standing: { id: string; title: string; value: number }[]
  marks: { id: string; title: string; description: string; earned: boolean }[]
  ending: { id: string; title: string; cost: string; reign_verb: string; reign_description: string } | null
  /** Petitions offerable at the player's current location, once the reign has begun. */
  petitions: WorldPetition[]
}

const earned = (
  mark: WorldMark,
  flags: Record<string, boolean>,
  revealedCount: number,
  endingId: string | null,
): boolean => {
  const when = mark.awarded_when
  if (when.flag) return flags[when.flag] === true
  if (when.ending) return endingId === when.ending
  if (when.places_revealed !== undefined) return revealedCount >= when.places_revealed
  // A mark with no condition is unearnable rather than free. The audit catches
  // it; at runtime it simply never lights up, which is the safe direction.
  return false
}

/**
 * The ending the player has reached, or null.
 *
 * A latched ending wins over the triggers. Otherwise triggers are tested in
 * authored order and the FIRST match takes it — authored order is the tie-break
 * because two endings can legitimately both be satisfiable and the file is
 * where that priority belongs, not here.
 */
export function endingFor(
  endings: WorldEnding[],
  flags: Record<string, boolean>,
): WorldEnding | null {
  const latched = endings.find((e) => flags[endingFlag(e.id)] === true)
  if (latched) return latched
  return endings.find((e) => satisfies(e.trigger, flags)) ?? null
}

export function progressionFor(
  progression: WorldProgression | null,
  reign: WorldReign | null,
  state: {
    flags: Record<string, boolean>
    taken_choice_ids: string[]
    revealed_location_ids: string[]
    current_location_id: string
  },
): ProgressionView {
  const { flags } = state
  const taken = new Set(state.taken_choice_ids)
  const ending = endingFor(progression?.endings ?? [], flags)

  const standing = (progression?.standing ?? []).map((track) => ({
    id: track.id,
    title: track.title,
    value: (track.shifts ?? []).reduce((sum, s) => (taken.has(s.choice_id) ? sum + s.delta : sum), 0),
  }))

  const marks = (progression?.marks ?? [])
    .map((mark) => ({
      id: mark.id,
      title: mark.title,
      description: mark.description,
      earned: earned(mark, flags, state.revealed_location_ids.length, ending?.id ?? null),
      hidden: mark.hidden === true,
    }))
    // A hidden mark is a spoiler until it is earned: these name the endings.
    .filter((mark) => !mark.hidden || mark.earned)
    .map(({ hidden: _hidden, ...mark }) => mark)

  const petitions =
    flags[PETITIONS_OPEN] === true
      ? (reign?.petitions ?? []).filter(
          (p) => p.at === state.current_location_id && (!p.requires || flags[p.requires] === true),
        )
      : []

  return {
    standing,
    marks,
    ending: ending
      ? {
          id: ending.id,
          title: ending.title,
          cost: ending.cost,
          reign_verb: ending.reign_verb,
          reign_description: ending.reign_description,
        }
      : null,
    petitions,
  }
}
