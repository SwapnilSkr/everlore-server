/**
 * First-party seed fixtures. Play does not read these.
 *
 * A walkable world is an InteractiveWorldDoc. These files exist so Iron Verdict
 * can be imported into Mongo on a fresh environment. Creator and generated
 * worlds never have a file here.
 */
import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import type { AuthoredWorld, LoadedWorld, WorldCastMember, WorldDuel, WorldProgression, WorldReign } from './world-source'
import { assetKey } from './world-source'

const DATA = join(import.meta.dir, '../../scripts/fixtures/walks')

const cache = new Map<string, LoadedWorld>()

function readJson<T>(path: string): T | null {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : null
}

/** Every first-party key that still has a seed fixture. */
export function worldKeys(): string[] {
  const index = readJson<string[]>(join(DATA, 'index.json'))
  if (index) return index
  if (!existsSync(DATA)) return []
  return readdirSync(DATA)
    .filter((name) => /^[a-z0-9-]+\.json$/.test(name))
    .map((name) => name.replace(/\.json$/, ''))
}

/**
 * Load a seed fixture, or null when this key is not first-party.
 *
 * Returning null rather than throwing lets the caller decide what a missing
 * fixture means — skip, or refuse a seed.
 */
export function loadWorld(key: string): LoadedWorld | null {
  const hit = cache.get(key)
  if (hit) return hit

  if (!/^[a-z0-9-]+$/.test(key)) return null

  const authored = readJson<AuthoredWorld>(join(DATA, `${key}.json`))
  if (!authored) return null

  const dims = readJson<Record<string, { width: number; height: number }>>(
    join(DATA, `${key}.dimensions.json`),
  ) ?? {}

  const cast = readJson<{ cast: WorldCastMember[]; unanswered?: string }>(join(DATA, `${key}.cast.json`))
  const progression = readJson<WorldProgression>(join(DATA, `${key}.progression.json`))
  const reign = readJson<WorldReign>(join(DATA, `${key}.reign.json`))
  const duels = readJson<{ duels: WorldDuel[] }>(join(DATA, `${key}.duels.json`))

  const world: LoadedWorld = {
    ...authored,
    cast: cast?.cast ?? [],
    cast_unanswered: cast?.unanswered ?? null,
    progression,
    reign,
    duels: duels?.duels ?? [],
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

export function requireWorld(key: string): LoadedWorld {
  const world = loadWorld(key)
  if (!world) throw new Error(`No seed fixture for "${key}" in ${DATA}`)
  return world
}
