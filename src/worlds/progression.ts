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
import type { InteractiveLocationDoc, WorldLedgerEntryDoc } from '../models/interactive-world.model'
import {
  satisfies,
  type WorldEnding,
  type WorldMark,
  type WorldPetition,
  type WorldPetitionResolution,
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

/**
 * A petition as the player receives it.
 *
 * `the_truth` is deliberately absent. It is the whole reason a petition can be
 * judged rather than guessed at, and it goes to narration only — a client that
 * has it has already lost the scene. `consequence` is absent from the offered
 * resolutions for the same reason: reading the outcomes turns a judgement into
 * a menu with the answers printed on it.
 */
export interface OfferedPetition {
  id: string
  title: string
  at: string
  kind: string
  parties: WorldPetition['parties']
  resolutions: { id: string; label: string }[]
  /**
   * Rulings the petitioner has come armed with.
   *
   * A principle established here, or one route away, travels: the next
   * claimant quotes it back and has shaped their claim to win under it. This is
   * what makes a long reign harder to judge than a short one.
   */
  cites: { principle: string; petition_id: string }[]
}

export interface ProgressionView {
  standing: { id: string; title: string; value: number }[]
  marks: { id: string; title: string; description: string; earned: boolean }[]
  ending: { id: string; title: string; cost: string; reign_verb: string; reign_description: string } | null
  /** Petitions offerable at the player's current location, once the reign has begun. */
  petitions: OfferedPetition[]
  /** What has already been ruled, newest first. The player's own record. */
  ledger: WorldLedgerEntryDoc[]
  /**
   * How the world stands after the ending, once there is one.
   *
   * The four reigns are not epilogue text — each one says what the map is now
   * for, which places have shut and which have become the working road. It is
   * carried alongside the ending so the player can read what they are holding.
   */
  reign: { verb: string; premise: string; what_changes: string[] } | null
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

/** Find a petition and one of its resolutions, or null if either is unknown. */
export function resolutionOf(
  reign: WorldReign | null,
  petitionId: string,
  resolutionId: string,
): { petition: WorldPetition; resolution: WorldPetitionResolution } | null {
  const petition = (reign?.petitions ?? []).find((p) => p.id === petitionId)
  const resolution = petition?.resolutions.find((r) => r.id === resolutionId)
  return petition && resolution ? { petition, resolution } : null
}

export function progressionFor(
  progression: WorldProgression | null,
  reign: WorldReign | null,
  locations: InteractiveLocationDoc[],
  state: {
    flags: Record<string, boolean>
    taken_choice_ids: string[]
    revealed_location_ids: string[]
    current_location_id: string
    ledger?: WorldLedgerEntryDoc[]
  },
): ProgressionView {
  const { flags } = state
  const ledger = state.ledger ?? []
  const ruled = new Set(ledger.map((e) => e.petition_id))
  const taken = new Set(state.taken_choice_ids)
  const ending = endingFor(progression?.endings ?? [], flags)

  // Standing is two sums: the road the player took through the story, and every
  // ruling they have handed down since. A reign can undo the reputation the
  // story earned, which is the point of having one.
  const ruledShift = (trackId: string) =>
    ledger.reduce((sum, entry) => {
      const found = resolutionOf(reign, entry.petition_id, entry.resolution_id)
      return sum + (found?.resolution.standing_shift?.[trackId] ?? 0)
    }, 0)

  const standing = (progression?.standing ?? []).map((track) => ({
    id: track.id,
    title: track.title,
    value:
      (track.shifts ?? []).reduce((sum, s) => (taken.has(s.choice_id) ? sum + s.delta : sum), 0) +
      ruledShift(track.id),
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

  // A principle travels one route from where it was established. Anything
  // further and every ruling would be quoted everywhere, which reads as noise
  // rather than as consequence.
  const here = locations.find((l) => l.id === state.current_location_id)
  const withinEarshot = new Set([state.current_location_id, ...(here?.routes ?? [])])
  const cites = ledger
    .filter((entry) => withinEarshot.has(entry.at))
    .map((entry) => ({ principle: entry.principle, petition_id: entry.petition_id }))

  const petitions: OfferedPetition[] =
    flags[PETITIONS_OPEN] === true
      ? (reign?.petitions ?? [])
          .filter(
            (p) =>
              p.at === state.current_location_id &&
              !ruled.has(p.id) &&
              (!p.requires || flags[p.requires] === true),
          )
          .map((p) => ({
            id: p.id,
            title: p.title,
            at: p.at,
            kind: p.kind,
            parties: p.parties,
            resolutions: p.resolutions.map(({ id, label }) => ({ id, label })),
            cites,
          }))
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
    ledger: [...ledger].reverse(),
    reign: ending && reign?.reign?.[ending.id]
      ? {
          verb: reign.reign[ending.id]!.verb,
          premise: reign.reign[ending.id]!.premise,
          what_changes: reign.reign[ending.id]!.what_changes ?? [],
        }
      : null,
  }
}
