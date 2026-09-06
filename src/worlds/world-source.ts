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

/** Open-ended play after an ending. Petitions are the renewable unit of it. */
export interface WorldPetition {
  id: string
  at: string
  kind: string
  requires?: string
  title?: string
  summary?: string
}

export interface WorldReign {
  reign?: Record<string, { verb: string; premise: string; what_changes?: string[] }>
  petitions?: WorldPetition[]
  escalation?: unknown
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

/** Load or fail loudly. For callers that cannot continue without the world. */
export function requireWorld(key: string): LoadedWorld {
  const world = loadWorld(key)
  if (!world) throw new Error(`No authored world "${key}" in ${DATA}`)
  return world
}
