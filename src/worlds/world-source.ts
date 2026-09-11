/**
 * Worlds are DATA, not code.
 *
 * The playable world is an `InteractiveWorldDoc` in Mongo. First-party walks,
 * creator walks, and generated walks share this shape and the same engine.
 * Nothing here reads a per-world file at request time — that would mean a
 * world that is not in this repository cannot be walked.
 *
 * What stays in code is MECHANISM only — how a CDN key is built, how a stored
 * document becomes the in-memory world the engine already speaks.
 */
import type {
  InteractiveAssetDoc,
  InteractiveLocationDoc,
  InteractiveMapStyleDoc,
  InteractiveRealmDoc,
  InteractiveWorldDoc,
} from '../models/interactive-world.model'

/**
 * A condition over the player's flags.
 *
 * The three clauses are what the authored endings were already written against,
 * so the shape is taken from the content rather than imposed on it. `none_of`
 * is the one that cannot be simulated by the other two, and it is what makes
 * branches mutually exclusive: The Verdict Upheld is not "you sold the writ",
 * it is "you sold the writ AND did not fight for it".
 */
export interface FlagPredicate {
  all_of?: string[]
  any_of?: string[]
  none_of?: string[]
}

const on = (flags: Record<string, boolean>, flag: string) => flags[flag] === true

/** An empty predicate is satisfied. "No conditions" means "always", not "never". */
export function satisfies(predicate: FlagPredicate | undefined, flags: Record<string, boolean>): boolean {
  if (!predicate) return true
  if (predicate.all_of?.some((f) => !on(flags, f))) return false
  if (predicate.any_of?.length && !predicate.any_of.some((f) => on(flags, f))) return false
  if (predicate.none_of?.some((f) => on(flags, f))) return false
  return true
}

/** Normalise the one-or-many fields authored data is allowed to use. */
export const asList = (value: string | string[] | undefined): string[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value]

/** An authored choice. The client submits an id; the server decides meaning. */
export interface WorldChoice {
  id: string
  at: string
  /** Every flag named must be set. A bare string is the common single-gate case. */
  requires?: string | string[]
  /**
   * Any flag named here withdraws the choice.
   *
   * Needed because the endgame roads are exclusive: once the writ has been
   * given to the Court it cannot also be burned. Without this the player can
   * take every road and satisfy several ending triggers at once.
   */
  forbids?: string | string[]
  sets: string | string[]
  label: string
  summary: string
  memory?: { text: string; subjects: string[]; objects: string[]; terms: string; valence: string }
  /** Offered only when the bound lead is one of these. */
  for_leads?: string | string[]
  /** Withdrawn when the bound lead is one of these. */
  not_for_leads?: string | string[]
  /** Shown, but the server refuses if the save's meters are short. */
  require_traits?: { strength?: number; charisma?: number; leadership?: number; level?: number }
  /** Where to put more weight in the arm if the meters are short. */
  train_hint?: string
  /**
   * A hinge the player may restore. Taking it snapshots the save *before* the
   * flags land, so a death or a regretted road can be taken again.
   */
  critical?: { id: string; title: string; hint: string }
}

/** A repeatable place action that raises a meter. Not a story choice. */
export interface WorldDrill {
  id: string
  at: string
  label: string
  raises: { strength?: number; charisma?: number; leadership?: number }
  for_leads?: string | string[]
  not_for_leads?: string | string[]
}

/** The condition a choice is offered under, in the same shape as everything else. */
export const choicePredicate = (choice: WorldChoice): FlagPredicate => ({
  all_of: asList(choice.requires),
  none_of: asList(choice.forbids),
})

/** Exactly the shape of a first-party seed fixture. Play never reads this. */
export interface AuthoredWorld {
  key: string
  title: string
  chapter_title: string
  /** One line of invitation, in the world's own voice. Read on its entrance. */
  blurb?: string
  /**
   * Version of the definition persisted in Mongo. Increment whenever the play
   * payload changes; independent of the CDN asset revision.
   */
  definition_version: number
  /** Revision embedded in published asset keys. */
  revision: number
  start_location_id: string
  overture?: WorldOverture
  map_style: InteractiveMapStyleDoc
  realms: InteractiveRealmDoc[]
  assets: { id: string; role: InteractiveAssetDoc['role'] }[]
  locations: InteractiveLocationDoc[]
  choices: WorldChoice[]
  drills?: WorldDrill[]
}

/** A permanent record of something the player did. Awarded once, never lost. */
export interface WorldMark {
  id: string
  title: string
  description: string
  hidden?: boolean
  awarded_when: { flag?: string; ending?: string; places_revealed?: number }
}

/** How one faction reads the player, summed from the choices they have taken. */
export interface WorldStanding {
  id: string
  title: string
  shifts?: { choice_id: string; delta: number }[]
}

/** A road out of the story. Triggers are evaluated in authored order. */
export interface WorldEnding {
  id: string
  title: string
  trigger: FlagPredicate
  cost: string
  reign_verb: string
  reign_description: string
}

export interface WorldProgression {
  marks?: WorldMark[]
  standing?: WorldStanding[]
  endings?: WorldEnding[]
  ledger?: unknown
}

/**
 * A fact a character has and will NOT volunteer.
 *
 * The gate is what makes it a secret rather than an opening line. Without one
 * the entry is silently just `knows` — see `knowledgeFor`, which is the only
 * place this is ever read.
 */
export interface WorldGuardedKnowledge {
  fact: string
  requires: string
  note?: string
}

export interface WorldPrologue {
  headline: string
  beats: string[]
  scene_asset_id?: string
}

/** A walk through the duchy before anyone is bound. */
export interface WorldOvertureBeat {
  scene_asset_id: string
  mark: string
  title: string
  body: string
}

export interface WorldOverture {
  headline: string
  kicker: string
  beats: WorldOvertureBeat[]
}

/** An authored character. Everything below `portraits` is for narration only. */
export interface WorldCastMember {
  id: string
  name: string
  role: string
  faction: string
  home_location_id: string
  /** Keyed by bearing. `default` is required; the rest are moods of the same face. */
  portraits: Record<string, string>
  wants: string
  fears: string
  knows: string[]
  knows_guarded?: WorldGuardedKnowledge[]
  first_met: string
  disposition_start: number
  /** What this character can tell the player that opens a road. NOT a gate. */
  reveals_flag?: string
  /** The flag that must be true before the player can see them at all. */
  gated_by_flag?: string
  /** Bound as the walk's lead. Default false — everyone else stays an NPC. */
  playable?: boolean
  start_location_id?: string
  start_flags?: Record<string, boolean>
  start_traits?: { strength?: number; charisma?: number; leadership?: number; level?: number }
  prologue?: WorldPrologue
  /** Hidden as an NPC once this flag is true — a dead champion is not in the Chainhouse. */
  hidden_if_flag?: string
}

/** One side of a petition. Both are stated as the party would state them. */
export interface WorldPetitionParty {
  name: string
  claim: string
}

/**
 * A way of ruling, and what ruling that way costs.
 *
 * The last three fields are the seeds the escalation rule turns: the party made
 * whole becomes an owner and owners get petitioned, the party made to pay
 * carries a dated grievance that ripens, and the principle is quoted back by
 * whoever comes next. The principle is the one that compounds, because it is
 * the only one that travels off the petition it came from.
 */
export interface WorldPetitionResolution {
  id: string
  label: string
  consequence: string
  standing_shift?: Record<string, number>
  costly_but_defensible?: boolean
  made_whole: string
  made_to_pay: string
  principle: string
}

/** Open-ended play after an ending. Petitions are the renewable unit of it. */
export interface WorldPetition {
  id: string
  at: string
  kind: string
  requires?: string
  title: string
  parties: WorldPetitionParty[]
  /**
   * What is actually the case, which is usually not what either party says.
   *
   * NEVER sent to the client. It is the brief for narration and the reason a
   * petition can be judged rather than merely picked; shipping it would spoil
   * every one of them on arrival.
   */
  the_truth: string
  resolutions: WorldPetitionResolution[]
}

/**
 * How a ruling turns into the next petition. Authored, not coded.
 *
 * `ripens_to` is the kind ladder — which harder quarrel a grievance of each
 * kind comes back as. It lives in the file because it is content: which kinds
 * exist and what each one escalates into is a judgement about this world, and a
 * literal map in TypeScript would mean a designer cannot retune the reign
 * without a deploy. A kind ABSENT from the ladder is the end of it.
 */
export interface WorldEscalation {
  ripens_to?: Record<string, string>
  /** Rulings that must pass before a grievance is ripe. A season, in this engine's clock. */
  ripens_after_rulings?: number
}

/**
 * One side of a Verdict fought on the sand.
 *
 * A combatant is named by `cast_id` when they are someone the player can also
 * meet, talk to and look at — Cassian on the sand and Cassian in the Chainhouse
 * have to be the same person, and duplicating his name and face here is how the
 * two quietly drift apart. `is_player` is the other case the world needs: the
 * player has no card in the cast and no painted face, and a duel they are in is
 * still a duel. Everyone else is a fighter authored for this one Verdict.
 */
export interface WorldDuelCombatant {
  cast_id?: string
  is_player?: boolean
  /** Required for a fighter who is neither the player nor in the cast. */
  name?: string
  role?: string
  /**
   * The painted face of a fighter who exists only in this duel. Cast members
   * derive their face from `cast_id`; the player ordinarily has no authored
   * face. The id must name a portrait in this world's asset manifest.
   */
  portrait_asset_id?: string
  /** How they fight, for narration only. Never read as a strength. */
  style?: string
  /** Authored rating for a contested Verdict. 1–10, same scale as walk traits. */
  strength?: number
}

/**
 * One exchange, authored in full.
 *
 * `line` is the beat as written, and it is what the player reads whenever the
 * flavour pass is unavailable — so a duel is playable with no model at all.
 * `toll` is what this beat costs the OTHER side, which is what drives the bars;
 * it is authored rather than rolled because the loser of a Verdict is decided
 * before the first blow (see `WorldDuel`).
 *
 * `said` is opt-in per beat. A beat authored silent stays silent even if the
 * flavour pass writes a line for it: whether someone speaks in the middle of a
 * fight is staging, and staging is authored.
 */
export interface WorldDuelBeat {
  actor: 'challenger' | 'defender'
  toll: number
  /** Which of the actor's own authored portraits they wear here. Never a model's string. */
  bearing?: string
  line: string
  said?: string
}

/**
 * How the Verdict ends. AUTHORED, and the reason this whole file exists.
 *
 * A Verdict is law the moment it is cut into the wall, and the story after it
 * is written against the flags the triggering choice sets — who inherits, who
 * is dead, which endings are still reachable. A duel that decided its own
 * winner would contradict all of it while looking, on screen, like a perfectly
 * good fight. So the outcome is read off the authored choice and dramatised;
 * nothing here is derived, rolled or asked for.
 *
 * `sets` restates the triggering choice's flags so the audit can prove the two
 * agree. It is NOT what writes them — the choice does, exactly as it always
 * has, so there is one place flags are set at runtime.
 */
export interface WorldDuelOutcome {
  winner: 'challenger' | 'defender'
  /** What the Ring now holds to be true. Read out when the fight ends. */
  verdict: string
  /** What winning it cost, in the same voice an ending's cost is written in. */
  cost: string
  fatal: boolean
  sets: string[]
}

/** The authored other ending of a contested Verdict. Traits pick this or `outcome`. */
export interface WorldDuelLoss {
  winner: 'challenger' | 'defender'
  verdict: string
  cost: string
  fatal: boolean
  sets: string[]
  sets_if_lead?: Record<string, string[]>
  beats?: WorldDuelBeat[]
}

/** A fight that makes law, keyed to the authored choice that calls for it. */
export interface WorldDuel {
  id: string
  choice_id: string
  /** Further choices that stage this same fight. */
  choice_ids?: string[]
  at: string
  /**
   * Traits pick between `outcome` and `loss`. Spectator Verdicts stay authored
   * exactly as written — only a fight the lead is in is contested.
   */
  contested?: boolean
  /** The legal question on the sand. Read to the crowd before the first blow. */
  question: string
  /** The opening, in the Ring's own voice. */
  herald: string
  /** How much punishment a side can take before it is over. Mechanism, not content. */
  vigour: number
  challenger: WorldDuelCombatant
  defender: WorldDuelCombatant
  beats: WorldDuelBeat[]
  outcome: WorldDuelOutcome
  loss?: WorldDuelLoss
}

export interface WorldReign {
  reign?: Record<string, { verb: string; premise: string; what_changes?: string[]; opening_beat?: string }>
  petitions?: WorldPetition[]
  escalation?: WorldEscalation
}

/**
 * Content that is authored ALONGSIDE the world rather than inside it.
 *
 * These live in their own files because they are edited independently and by
 * different hands — the cast grows, progression is tuned, the post-ending
 * material is written last — and merging them into one file would mean every
 * edit touches the thing the renderer depends on. Each is optional: a world
 * with no cast file is a world with no cast, not a broken world.
 */
export interface WorldSidecars {
  cast: WorldCastMember[]
  /**
   * What is narrated when a character does not answer.
   *
   * Authored rather than written in code, because it is prose a player reads
   * and the only alternative to it is an error message or a scene that goes
   * nowhere. It is the degraded path for every conversation in the world, so
   * it lives beside the cast where it can be rewritten without a deploy.
   */
  cast_unanswered: string | null
  progression: WorldProgression | null
  reign: WorldReign | null
  /**
   * The Verdicts that are fought rather than chosen.
   *
   * Its own file because a duel is staging — beats, tolls, who wears which face
   * — and it is retuned by whoever is tuning the fight, not by whoever is
   * tuning the map. A world with no duel file is a world where every choice
   * resolves in a line of summary, which is what this world was before.
   */
  duels: WorldDuel[]
}

export interface LoadedWorld extends Omit<AuthoredWorld, 'assets'>, WorldSidecars {
  assets: InteractiveAssetDoc[]
}

/**
 * Where an asset lives on the CDN.
 *
 * The revision is part of the key because CloudFront caches by URL for the
 * whole TTL, so a new key is the only reliable way to change published art.
 * Authored data therefore stores asset IDs only and never a key.
 */
export function assetKey(worldKey: string, role: InteractiveAssetDoc['role'], id: string, revision: number): string {
  const dir = { plate: 'maps', sprite: 'sprites', scene: 'scenes', portrait: 'characters', texture: 'kit' }[role]
  return `interactive-worlds/${worldKey}/${dir}/${id.replace(/_/g, '-')}-v${revision}.webp`
}

/**
 * The in-memory world the engine already speaks, taken from the stored doc.
 *
 * A creator world, a generated world, and Iron Verdict are the same object
 * here. Missing play fields are empty, not fatal — an unfinished walk has no
 * choices yet, not a missing file.
 */
export function worldFromDoc(doc: InteractiveWorldDoc): LoadedWorld {
  const start = doc.start_location_id || doc.locations?.[0]?.id
  if (!start) {
    throw new Error(`Interactive world "${doc.key}" has no start location`)
  }
  return {
    key: doc.key,
    title: doc.title,
    chapter_title: doc.chapter_title,
    blurb: doc.blurb,
    definition_version: doc.version,
    revision: doc.revision ?? 1,
    start_location_id: start,
    overture: doc.overture,
    map_style: doc.map_style,
    realms: doc.realms ?? [],
    assets: doc.assets ?? [],
    locations: doc.locations ?? [],
    choices: doc.choices ?? [],
    drills: doc.drills ?? [],
    cast: doc.cast ?? [],
    cast_unanswered: doc.cast_unanswered ?? null,
    progression: doc.progression ?? null,
    reign: doc.reign ?? null,
    duels: doc.duels ?? [],
  }
}

/**
 * Every flag this world actually gates something on.
 *
 * Derived from the authored data, never listed by hand — a new gate is in the
 * vocabulary the moment it is authored, and a retired one leaves it. This is
 * the guard on narrated flags: the story loop lets the narrator mint any flag
 * name it likes, and without a vocabulary an invented one could open a road by
 * coincidence. A flag the world does not gate on cannot move the map.
 */
export function worldVocabulary(world: LoadedWorld): Set<string> {
  const vocabulary = new Set<string>()
  for (const location of world.locations) {
    if (location.unlock_flag) vocabulary.add(location.unlock_flag)
    for (const flag of asList(location.reveal_flag)) vocabulary.add(flag)
  }
  for (const choice of world.choices) {
    for (const flag of [...asList(choice.requires), ...asList(choice.forbids), ...asList(choice.sets)]) {
      vocabulary.add(flag)
    }
  }
  for (const ending of world.progression?.endings ?? []) {
    for (const flag of [
      ...(ending.trigger.all_of ?? []),
      ...(ending.trigger.any_of ?? []),
      ...(ending.trigger.none_of ?? []),
    ]) vocabulary.add(flag)
  }
  for (const mark of world.progression?.marks ?? []) if (mark.awarded_when.flag) vocabulary.add(mark.awarded_when.flag)
  for (const petition of world.reign?.petitions ?? []) if (petition.requires) vocabulary.add(petition.requires)
  return vocabulary
}

/**
 * The flags the map should be read against.
 *
 * The story loop and the map keep separate flags, and until now they only met
 * in one direction: taking a map choice wrote into the event stream, so the
 * narrator learned about it, but nothing the narrator said could move the map.
 * A character could promise a way through a sealed door, in their own voice,
 * and the door stayed shut until the player found the authored button. That is
 * the whole reason the map read as a menu bolted onto a story.
 *
 * Narration is ADDITIVE here and never subtractive. It can open a place; it
 * cannot re-seal one, and it cannot clear a flag an authored choice set. So the
 * authored spine stays guaranteed — no amount of talking gets a player onto a
 * road the author did not build — while everything the fiction actually does is
 * allowed to count.
 *
 * Narrated flags are deliberately NOT persisted into world state. They are
 * recomputed from the instance every read, so an edited or replayed turn takes
 * its consequences back with it, exactly as it does everywhere else.
 */
export function effectiveFlags(
  world: LoadedWorld,
  stateFlags: Record<string, boolean>,
  narratedFlags: Record<string, unknown> | undefined,
): Record<string, boolean> {
  const merged: Record<string, boolean> = { ...stateFlags }
  if (!narratedFlags) return merged
  const vocabulary = worldVocabulary(world)
  for (const [flag, value] of Object.entries(narratedFlags)) {
    // Only a literal `true` counts. The story loop also increments counters
    // through this same field, and a tally of three is not an open gate.
    if (value === true && vocabulary.has(flag)) merged[flag] = true
  }
  return merged
}

