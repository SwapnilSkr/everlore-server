/**
 * Walk play: who is walking, what they can see, which roads are theirs.
 *
 * Identity, discovery and contested Verdicts are mechanism. The authored files
 * still decide where a lead starts, which flags open a house, and what a fight
 * costs — this file only applies those rules the same way every time.
 */
import type { InteractiveLocationDoc, InteractiveVisibility } from '../models/interactive-world.model'
import type { LoadedWorld, WorldCastMember, WorldChoice, WorldDrill, WorldDuel, WorldDuelOutcome } from './world-source'
import { asList, choicePredicate, satisfies } from './world-source'

/**
 * What the player currently knows about a place.
 *
 * Authored visibility is the floor, and flags only ever open it further. A
 * `rumoured` place is not on the map at all until one of its reveal flags
 * lands, which is what makes the map grow during play instead of being laid
 * out up front.
 */
export function visibilityFor(
  location: InteractiveLocationDoc,
  flags: Record<string, boolean>,
): InteractiveVisibility {
  const revealFlags = asList(location.reveal_flag)
  if (location.visibility === 'rumoured' && !revealFlags.some((flag) => flags[flag] === true)) {
    return 'rumoured'
  }
  if (location.unlock_flag && flags[location.unlock_flag] !== true) return 'sealed'
  return 'open'
}

export interface WorldTraits {
  strength: number
  charisma: number
  leadership: number
  level: number
}

export const DEFAULT_TRAITS: WorldTraits = { strength: 4, charisma: 4, leadership: 4, level: 1 }

export function clampTrait(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : fallback
  if (!Number.isFinite(n)) return fallback
  return Math.max(1, Math.min(10, Math.round(n)))
}

export function traitsOf(raw: Partial<WorldTraits> | undefined): WorldTraits {
  return {
    strength: clampTrait(raw?.strength, DEFAULT_TRAITS.strength),
    charisma: clampTrait(raw?.charisma, DEFAULT_TRAITS.charisma),
    leadership: clampTrait(raw?.leadership, DEFAULT_TRAITS.leadership),
    level: clampTrait(raw?.level, DEFAULT_TRAITS.level),
  }
}

export function traitsMeet(required: Partial<WorldTraits> | undefined, have: WorldTraits | undefined): boolean {
  if (!required) return true
  if (!have) return false
  if (required.strength != null && have.strength < required.strength) return false
  if (required.charisma != null && have.charisma < required.charisma) return false
  if (required.leadership != null && have.leadership < required.leadership) return false
  if (required.level != null && have.level < required.level) return false
  return true
}

export interface SceneWhen {
  flag?: string
  lead?: string
  headline?: string
  body?: string
}

export interface LocationScene {
  headline: string
  body: string
}

/** First matching variant wins. Authored order is the priority. */
/**
 * What someone standing in this place has actually seen happen here.
 *
 * Talk used to receive only static `knows`. A deed that just landed in this
 * room — a fight, a hinge, a choice — was invisible to the person who watched
 * it, so they would deny it. These are summaries the author already wrote,
 * never flag names.
 */
export function witnessedHere(
  world: LoadedWorld,
  locationId: string,
  flags: Record<string, boolean>,
  takenChoiceIds: string[],
  leadId?: string,
): string[] {
  const facts: string[] = []
  const here = world.locations.find((location) => location.id === locationId)
  if (here) {
    const scene = sceneCopyFor(here, flags, leadId)
    if (scene.body.trim()) facts.push(`This is how this place stands now: ${scene.body.trim()}`)
  }
  const taken = new Set(takenChoiceIds)
  const recent = takenChoiceIds
    .map((id) => world.choices.find((choice) => choice.id === id && choice.at === locationId && taken.has(choice.id)))
    .filter((choice): choice is WorldChoice => choice !== undefined)
    .slice(-4)
  for (const choice of recent) {
    if (choice.summary.trim()) {
      facts.push(`You were present when this happened here: ${choice.summary.trim()}`)
    }
    const memory = choice.memory?.text?.trim()
    if (memory) facts.push(memory)
  }
  return facts
}

export type WayOnKind = 'choice' | 'talk' | 'train' | 'travel'

/** The next thing this walk still asks of the player. Derived, never authored as a quest id. */
export interface WayOn {
  kind: WayOnKind
  at: string
  label: string
  blurb: string
  character_id?: string
}

export function sceneCopyFor(
  location: InteractiveLocationDoc & { scene_when?: SceneWhen[] },
  flags: Record<string, boolean>,
  leadId?: string,
): LocationScene {
  for (const variant of location.scene_when ?? []) {
    if (variant.lead && variant.lead !== leadId) continue
    if (variant.flag && flags[variant.flag] !== true) continue
    return {
      headline: variant.headline || location.scene_headline || location.title,
      body: variant.body || location.scene_body || location.description,
    }
  }
  return {
    headline: location.scene_headline || location.title,
    body: location.scene_body || location.description,
  }
}

export function playableMembers(world: LoadedWorld): WorldCastMember[] {
  return world.cast.filter((member) => member.playable === true)
}

export function playableOf(world: LoadedWorld, characterId: string): WorldCastMember | undefined {
  return playableMembers(world).find((member) => member.id === characterId)
}

export function choiceOpenToLead(choice: WorldChoice, leadId: string | undefined): boolean {
  const forLeads = asList(choice.for_leads)
  const notFor = asList(choice.not_for_leads)
  if (forLeads.length && (!leadId || !forLeads.includes(leadId))) return false
  if (leadId && notFor.includes(leadId)) return false
  return true
}

export function choiceOffered(
  choice: WorldChoice,
  locationId: string,
  flags: Record<string, boolean>,
  taken: string[],
  leadId: string | undefined,
): boolean {
  if (choice.at !== locationId) return false
  if (taken.includes(choice.id)) return false
  if (!choiceOpenToLead(choice, leadId)) return false
  return satisfies(choicePredicate(choice), flags)
}

/**
 * Places whose fog has lifted at the first step.
 *
 * The start is always known — you are standing in it — and so are its open or
 * sealed neighbours. Rumoured neighbours stay off the map until their reveal
 * flag lands. Dumping every non-rumoured id here is what painted the continent
 * on turn one.
 */
export function seedRevealedIds(
  locations: InteractiveLocationDoc[],
  startId: string,
  flags: Record<string, boolean>,
): string[] {
  const byId = new Map(locations.map((location) => [location.id, location]))
  const start = byId.get(startId)
  const ids = new Set<string>([startId])
  if (!start) return [...ids]
  for (const route of start.routes) {
    const neighbour = byId.get(route)
    if (!neighbour) continue
    if (visibilityFor(neighbour, flags) !== 'rumoured') ids.add(neighbour.id)
  }
  return [...ids]
}

/** The start is always walkable, even if its unlock flag has not fired yet. */
export function seedUnlockedIds(
  locations: InteractiveLocationDoc[],
  startId: string,
  flags: Record<string, boolean>,
): string[] {
  const ids = new Set<string>([startId])
  for (const location of locations) {
    if (visibilityFor(location, flags) === 'open') ids.add(location.id)
  }
  return [...ids]
}

/**
 * Grow fog along the graph. A flag may unseal a distant place for travel, but
 * it does not draw the continent — only the room you are in and the neighbours
 * that are no longer rumoured join the revealed set.
 */
export function promoteDiscovery(
  locations: InteractiveLocationDoc[],
  currentId: string,
  flags: Record<string, boolean>,
  revealed: string[],
  unlocked: string[],
): { revealed: string[]; unlocked: string[] } {
  const byId = new Map(locations.map((location) => [location.id, location]))
  const nextRevealed = new Set(revealed)
  const nextUnlocked = new Set(unlocked)
  nextRevealed.add(currentId)
  const current = byId.get(currentId)
  if (current) {
    for (const route of current.routes) {
      const neighbour = byId.get(route)
      if (!neighbour) continue
      if (visibilityFor(neighbour, flags) !== 'rumoured') nextRevealed.add(neighbour.id)
    }
  }
  for (const location of locations) {
    if (visibilityFor(location, flags) === 'open') nextUnlocked.add(location.id)
  }
  return { revealed: [...nextRevealed], unlocked: [...nextUnlocked] }
}

/** Strength plus a little leadership. Level is a tie-break, not a stat dump. */
export function contestScore(traits: WorldTraits): number {
  return traits.strength + traits.leadership * 0.25 + traits.level * 0.1
}

function other(side: 'challenger' | 'defender'): 'challenger' | 'defender' {
  return side === 'challenger' ? 'defender' : 'challenger'
}

export const TRAIT_CEILING: WorldTraits = { strength: 10, charisma: 10, leadership: 10, level: 10 }

export interface DuelStakes {
  choice_id: string
  opponent: string
  have: number
  need: number
  winnable_now: boolean
  winnable_at_cap: boolean
  fatal: boolean
  warning: string
}

/**
 * Whether the lead can win a fight they are in, with the meters they have now.
 * Spectator Verdicts and fights the player already out-weighs are silent.
 */
export function stakesForDuel(
  duel: WorldDuel,
  traits: WorldTraits | undefined,
  protagonistId: string | undefined,
  trainHint?: string,
): DuelStakes | null {
  const side = playerSideOf(duel, protagonistId)
  if (!side) return null
  const opponent = side === 'challenger' ? duel.defender : duel.challenger
  const opponentName = opponent.name || 'the other'
  const fatal = duel.loss?.fatal === true || duel.outcome.fatal === true
  const have = contestScore(traits ?? DEFAULT_TRAITS)
  const cap = contestScore(TRAIT_CEILING)

  if (duel.contested === true) {
    const need = clampTrait(opponent.strength, 5)
    const winnableNow = have >= need
    const winnableAtCap = cap >= need
    if (winnableNow) return null
    return {
      choice_id: duel.choice_id,
      opponent: opponentName,
      have,
      need,
      winnable_now: false,
      winnable_at_cap: winnableAtCap,
      fatal,
      warning:
        trainHint ||
        (winnableAtCap
          ? `${opponentName} is heavier. This fight will take you. Put more weight in the arm, then take the sand again.`
          : 'This fight cannot be won on your feet. It is a hinge: take it to see it, or walk away.'),
    }
  }

  if (duel.outcome.winner === side) return null
  return {
    choice_id: duel.choice_id,
    opponent: opponentName,
    have,
    need: have + 1,
    winnable_now: false,
    winnable_at_cap: false,
    fatal,
    warning: trainHint || 'This fight is already written. You will not leave the sand.',
  }
}

function playerSideOf(duel: WorldDuel, protagonistId: string | undefined): 'challenger' | 'defender' | null {
  const on = (castId: string | undefined, isPlayer: boolean | undefined) =>
    isPlayer === true || (Boolean(protagonistId) && castId === protagonistId)
  if (on(duel.challenger.cast_id, duel.challenger.is_player)) return 'challenger'
  if (on(duel.defender.cast_id, duel.defender.is_player)) return 'defender'
  return null
}

/**
 * A contested Verdict is still authored — the loss road is written, not rolled.
 * Traits only pick which authored ending of the fight is the one that happened.
 */
export function resolveContestedDuel(
  duel: WorldDuel,
  traits: WorldTraits | undefined,
  protagonistId: string | undefined,
): WorldDuel {
  if (duel.contested !== true) return duel
  const side = playerSideOf(duel, protagonistId)
  if (!side) return duel
  const opponent = side === 'challenger' ? duel.defender : duel.challenger
  const rating = clampTrait(opponent.strength, 5)
  const have = traits ?? DEFAULT_TRAITS
  const playerWins = contestScore(have) >= rating
  const authoredPlayerWins = duel.outcome.winner === side
  if (playerWins === authoredPlayerWins) return duel
  const loss = duel.loss
  if (!loss) {
    return {
      ...duel,
      outcome: {
        ...duel.outcome,
        winner: other(duel.outcome.winner),
      },
    }
  }
  const sets =
    protagonistId && loss.sets_if_lead?.[protagonistId]
      ? loss.sets_if_lead[protagonistId]
      : loss.sets
  const outcome: WorldDuelOutcome = {
    winner: loss.winner,
    verdict: loss.verdict,
    cost: loss.cost,
    fatal: loss.fatal,
    sets,
  }
  return {
    ...duel,
    beats: loss.beats ?? duel.beats,
    outcome,
  }
}

export function drillOpenToLead(drill: WorldDrill, leadId: string | undefined): boolean {
  const forLeads = asList(drill.for_leads)
  const notFor = asList(drill.not_for_leads)
  if (forLeads.length && (!leadId || !forLeads.includes(leadId))) return false
  if (leadId && notFor.includes(leadId)) return false
  return true
}

export function applyDrill(
  traits: WorldTraits,
  raises: WorldDrill['raises'],
  drillsTaken: number,
): { traits: WorldTraits; drills_taken: number } {
  const next = { ...traits }
  if (raises.strength) next.strength = clampTrait(next.strength + raises.strength, next.strength)
  if (raises.charisma) next.charisma = clampTrait(next.charisma + raises.charisma, next.charisma)
  if (raises.leadership) next.leadership = clampTrait(next.leadership + raises.leadership, next.leadership)
  const taken = drillsTaken + 1
  if (taken % 2 === 0) next.level = clampTrait(next.level + 1, next.level)
  return { traits: next, drills_taken: taken }
}

/**
 * The lead's own death, not an NPC's. Cassian dying while you are Nara is
 * history. Cassian dying while you *are* Cassian is the fork.
 */
export function leadIsDead(leadId: string | undefined, flags: Record<string, boolean>): boolean {
  if (!leadId) return false
  if (flags.player_fallen === true) return true
  return leadId === 'cassian_vale' && flags.cassian_dead === true
}
