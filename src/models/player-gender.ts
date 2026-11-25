import type { PlayerGender } from './user.model'

/** What the narrator and the choice pass are told about the player's gender. */
export type EffectivePlayerGender = PlayerGender | 'unknown'

/**
 * One effective gender per turn: the persona's when the save uses a persona,
 * else the account's onboarding answer, else unknown. A persona without a
 * gender is UNKNOWN, never the onboarding answer — the player chose the
 * persona, so that choice owns every detail of who they are in this save.
 */
export function effectivePlayerGender(
  persona: { gender?: PlayerGender | null } | null | undefined,
  onboardingGender: PlayerGender | null | undefined,
): EffectivePlayerGender {
  if (persona) return persona.gender || 'unknown'
  return onboardingGender || 'unknown'
}

/**
 * Whether this save's protagonist is the character the player authored.
 *
 * Structural, from the world: in a GM world (not sentient) the protagonist card
 * IS the player's character; in a sentient world the player is the persona
 * talking to the locked character, so its protagonist card never is. A card's
 * `role` is editable by the player (`characterCodexService.editCharacter`), so
 * it is not consulted.
 */
export function isPlayerAuthoredProtagonist(
  card: { is_protagonist?: boolean | null } | null | undefined,
  isSentient: boolean | null | undefined,
): boolean {
  return !isSentient && card?.is_protagonist === true
}

/**
 * The gender a story turn is told about, or undefined for no line at all.
 *
 * When the player authored the protagonist, their own name and description
 * already decide who the character is, so the onboarding answer must not
 * override them and neither the narrator nor the choice pass gets a line —
 * exactly as before. A persona still owns every detail of who the player is
 * and keeps its line.
 */
export function storyPlayerGender(
  gender: EffectivePlayerGender | undefined,
  protagonist: { is_protagonist?: boolean | null } | null | undefined,
  hasPersona: boolean,
  isSentient: boolean | null | undefined,
): EffectivePlayerGender | undefined {
  if (!hasPersona && isPlayerAuthoredProtagonist(protagonist, isSentient)) return undefined
  return gender
}
