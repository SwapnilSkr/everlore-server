/**
 * Whether published art is actually fetchable, not merely named.
 *
 * Iron Verdict once referenced twenty scene paintings that had never been
 * uploaded. Every one of their CDN URLs returned 403. Nothing failed loudly —
 * the Flutter client's Image.network has an errorBuilder that falls back to a
 * flat dark colour, so each of those places rendered as a black screen and
 * looked like a styling choice. The world audit passed the whole time because
 * it only checked that the ids were referenced, never that the bytes were
 * reachable. A referenced-but-unpublished asset is invisible to every check
 * we had.
 *
 *   bun run audit:asset-reachability [world-key]
 */
import { isStorageConfigured, storageService } from '../src/services/storage.service'
import { assetKey } from '../src/worlds/world-source'
import { requireWorld } from '../src/worlds/world-fixture'
import type { InteractiveAssetDoc } from '../src/models/interactive-world.model'

const worldKey = process.argv[2] ?? 'iron-verdict'

if (!isStorageConfigured()) {
  console.log(
    'asset-reachability: skipped — S3_BUCKET / CDN_BASE_URL are not set. Nothing was checked.',
  )
  process.exit(0)
}

const world = requireWorld(worldKey)

type Probe = {
  id: string
  role: InteractiveAssetDoc['role']
  status: number | string
}

// CloudFront will serve these, but a release check that opens every asset at
// once is indistinguishable from a scrape, and gets throttled as one.
const CONCURRENCY = 8

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (true) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return out
}

async function probe(asset: InteractiveAssetDoc): Promise<Probe> {
  // The URL the client is given. Recomputed from the same two functions the
  // server uses — a second implementation that drifts is how unpublished art
  // survives this check.
  const key = assetKey(world.key, asset.role, asset.id, world.revision)
  const url = storageService.urlForKey(key)
  if (!url) return { id: asset.id, role: asset.role, status: 'no-url' }
  try {
    const res = await fetch(url, { method: 'HEAD' })
    return { id: asset.id, role: asset.role, status: res.status }
  } catch {
    return { id: asset.id, role: asset.role, status: 'error' }
  }
}

const results = await mapLimit(world.assets, CONCURRENCY, probe)
const reachable = (p: Probe) => p.status === 200

console.log(`asset-reachability — ${world.key} (${world.assets.length} assets)\n`)

const roles = [...new Set(world.assets.map((a) => a.role))]
for (const role of roles) {
  const ofRole = results.filter((p) => p.role === role)
  const ok = ofRole.filter(reachable).length
  console.log(`  ${role.padEnd(10)} ${ok}/${ofRole.length} reachable`)
}

const failed = results.filter((p) => !reachable(p))
if (failed.length === 0) {
  console.log(`\nAll ${results.length} assets reachable.`)
  process.exit(0)
}

console.log(`\n${failed.length} unreachable:`)
for (const p of failed) {
  console.log(`  ${String(p.status).padEnd(6)} ${p.id}`)
}
process.exit(1)
