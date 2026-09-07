/**
 * Worlds are DATA, not code.
 *
 * Every authored world lives as JSON under `data/` and is read at runtime. That
 * is the whole point: a world is content, and content that has to be compiled
 * cannot be authored by anyone who is not editing this repository. Adding a
 * world is dropping a file in `data/`; changing one is editing that file. When
 * creators arrive, the same shape comes out of a database or an editor and
 * nothing here changes.
 *
 * What stays in code is MECHANISM only — how a CDN key is built, where measured
 * pixel sizes are attached. None of that is per-world.
 *
 * The files are read with `readFileSync` rather than imported. A static import
 * would bake the content into the build and quietly reintroduce exactly the
 * problem this module exists to remove.
 */
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import type {
  InteractiveAssetDoc,
  InteractiveLocationDoc,
  InteractiveMapStyleDoc,
  InteractiveRealmDoc,
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
}

/** The condition a choice is offered under, in the same shape as everything else. */
export const choicePredicate = (choice: WorldChoice): FlagPredicate => ({
  all_of: asList(choice.requires),
  none_of: asList(choice.forbids),
})

/** Exactly the shape of a `data/<key>.json` file. */
interface AuthoredWorld {
  key: string
  title: string
  chapter_title: string
  revision: number
  start_location_id: string
  map_style: InteractiveMapStyleDoc
  realms: InteractiveRealmDoc[]
  assets: { id: string; role: InteractiveAssetDoc['role'] }[]
  locations: InteractiveLocationDoc[]
  choices: WorldChoice[]
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
  cast: unknown[]
  progression: WorldProgression | null
  reign: WorldReign | null
}

export interface LoadedWorld extends Omit<AuthoredWorld, 'assets'>, WorldSidecars {
  assets: InteractiveAssetDoc[]
}

const DATA = join(import.meta.dir, 'data')

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

const cache = new Map<string, LoadedWorld>()

function readJson<T>(path: string): T | null {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : null
}

/** Every world key with a data file, for callers that enumerate rather than ask. */
export function worldKeys(): string[] {
  const index = readJson<string[]>(join(DATA, 'index.json'))
  return index ?? []
}

/**
 * Load an authored world, or null when no such world exists.
 *
 * Returning null rather than throwing lets the caller decide what a missing
 * world means — a 404 to a player, a usage error to a script.
 */
export function loadWorld(key: string): LoadedWorld | null {
  const hit = cache.get(key)
  if (hit) return hit

  // A key is a filename here, so anything that could climb out of `data/` is
  // refused outright rather than sanitised.
  if (!/^[a-z0-9-]+$/.test(key)) return null

  const authored = readJson<AuthoredWorld>(join(DATA, `${key}.json`))
  if (!authored) return null

  // Measured on the published files by the asset pipeline. Absent for an asset
  // that has not been generated yet, and deliberately left absent rather than
  // defaulted — the client cannot lay out a plate it cannot measure, and a
  // plausible-looking square renders silently wrong.
  const dims = readJson<Record<string, { width: number; height: number }>>(
    join(DATA, `${key}.dimensions.json`),
  ) ?? {}

  // Sidecars are keyed off the same world key, so adding one is dropping a
  // file next to the world rather than registering it anywhere.
  const cast = readJson<{ cast: unknown[] }>(join(DATA, `${key}.cast.json`))
  const progression = readJson<WorldProgression>(join(DATA, `${key}.progression.json`))
  const reign = readJson<WorldReign>(join(DATA, `${key}.reign.json`))

  const world: LoadedWorld = {
    ...authored,
    cast: cast?.cast ?? [],
    progression,
    reign,
    assets: authored.assets.map(({ id, role }) => ({
      id,
      role,
      key: assetKey(key, role, id, authored.revision),
      revision: authored.revision,
      ...(dims[id] ?? {}),
    })),
  }
  cache.set(key, world)
  return world
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
    if (location.reveal_flag) vocabulary.add(location.reveal_flag)
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

/** Load or fail loudly. For callers that cannot continue without the world. */
export function requireWorld(key: string): LoadedWorld {
  const world = loadWorld(key)
  if (!world) throw new Error(`No authored world "${key}" in ${DATA}`)
  return world
}
