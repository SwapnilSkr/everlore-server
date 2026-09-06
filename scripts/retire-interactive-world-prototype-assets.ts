import { isStorageConfigured, storageService } from '../src/services/storage.service'

/**
 * Ashen Circuit is retired. The world was renamed and re-arted as The Iron
 * Verdict, and its prototype objects are removed rather than left paying
 * storage for art nothing references.
 *
 * Run this ONLY after the replacement art is published and verified — a key,
 * once deleted, is never reused; replacements always get new versioned keys.
 */
const retiredKeys = [
  'interactive-worlds/ashen-circuit/maps/cinder-ward-dusk-v1.png',
  'interactive-worlds/ashen-circuit/maps/cinder-ward-atlas-v2.png',
  'interactive-worlds/ashen-circuit/maps/cinder-ward/terrain-v1.png',
  'interactive-worlds/ashen-circuit/maps/cinder-ward/landmarks/cinder-arena/base-v1.png',
  'interactive-worlds/ashen-circuit/locations/cinder-arena/dusk-background-v1.png',
  'interactive-worlds/ashen-circuit/locations/ember-market/night-background-v1.png',
  'interactive-worlds/ashen-circuit/locations/fighters-barracks/night-background-v1.png',
  'interactive-worlds/ashen-circuit/locations/ash-gate/night-background-v1.png',
  // Cassian Vale and Nara Voss are KEPT — the portraits carry into the new
  // world and are the reference the rest of the art matches. Not listed here.
] as const

if (!isStorageConfigured()) {
  throw new Error('S3_BUCKET and CDN_BASE_URL must be configured before retiring assets')
}

for (const key of retiredKeys) {
  await storageService.delete(key)
  console.log(`Retired ${key}`)
}
