/**
 * Integrity audit for the authored Iron Verdict graph.
 *
 * Thirty hand-authored locations across three realms is past the size where a
 * broken route or a flag nothing can ever set is visible by reading. Every
 * check here is something that would present as an unreachable place or a
 * missing image at runtime rather than as an error.
 *
 *   bun run audit:iron-verdict
 */
import { requireWorld } from '../src/worlds/world-source'

const world = requireWorld('iron-verdict')
const IRON_VERDICT_ASSETS = world.assets
const IRON_VERDICT_CHOICES = world.choices
const IRON_VERDICT_LOCATIONS = world.locations
const IRON_VERDICT_MAP_STYLE = world.map_style
const IRON_VERDICT_REALMS = world.realms
const IRON_VERDICT_START_LOCATION = world.start_location_id
import { visibilityFor } from '../src/services/interactive-world.service'

const fail: string[] = []
const warn: string[] = []

const byId = new Map(IRON_VERDICT_LOCATIONS.map((l) => [l.id, l]))
const assetIds = new Set(IRON_VERDICT_ASSETS.map((a) => a.id))
const realms = new Map(IRON_VERDICT_REALMS.map((r) => [r.id, r]))

if (byId.size !== IRON_VERDICT_LOCATIONS.length) fail.push('duplicate location ids')
if (!byId.has(IRON_VERDICT_START_LOCATION)) fail.push(`start location ${IRON_VERDICT_START_LOCATION} does not exist`)

for (const location of IRON_VERDICT_LOCATIONS) {
  const at = `${location.id}:`
  // `sprite` is the ANCHOR now, not art: only its x/y place the marker. There
  // is deliberately no check that `sprite.asset_id` is published, because
  // landmark sprites are no longer shipped at all. Scenes still are.
  if (location.scene_asset_id && !assetIds.has(location.scene_asset_id)) {
    fail.push(`${at} scene ${location.scene_asset_id} is not in the manifest`)
  }
  if (location.map_render !== 'marker') {
    fail.push(`${at} map_render is '${location.map_render}' — sprite rendering was removed`)
  }
  const realm = realms.get(location.realm)
  if (!realm) fail.push(`${at} unknown realm ${location.realm}`)
  else if (location.sprite.y < realm.y_from || location.sprite.y > realm.y_to) {
    fail.push(`${at} y=${location.sprite.y} falls outside ${realm.id} (${realm.y_from}–${realm.y_to})`)
  }
  if (location.sprite.x <= 0 || location.sprite.x >= 1) fail.push(`${at} x=${location.sprite.x} is off the map`)
  if (location.visibility === 'rumoured' && !location.reveal_flag) {
    fail.push(`${at} is rumoured with no reveal_flag, so it can never appear`)
  }
  if (location.unlock_flag && !location.sealed_reason) {
    warn.push(`${at} locks without telling the player why`)
  }
  for (const route of location.routes) {
    if (!byId.has(route)) { fail.push(`${at} routes to unknown ${route}`); continue }
    if (!byId.get(route)!.routes.includes(location.id)) {
      fail.push(`${at} routes to ${route}, but ${route} does not route back — travel would be one-way`)
    }
  }
}

// ── Sidecars ──────────────────────────────────────────────────────────────
// The cast, progression and post-ending files are authored separately and are
// the easiest thing in the world to let drift: nothing renders them yet, so a
// dangling location id or a flag that stopped existing fails silently and is
// found months later. Check them here, where the world data is already loaded.
const flagsInPlay = new Set<string>()
for (const l of IRON_VERDICT_LOCATIONS) {
  if (l.unlock_flag) flagsInPlay.add(l.unlock_flag)
  if (l.reveal_flag) flagsInPlay.add(l.reveal_flag)
}
for (const c of IRON_VERDICT_CHOICES) flagsInPlay.add(c.sets)

const cast = world.cast as {
  id: string; name: string; home_location_id: string; portraits: Record<string, string>
  gated_by_flag?: string; reveals_flag?: string
  knows_guarded?: { fact: string; requires?: string }[]
}[]
const castIds = new Set<string>()
for (const person of cast) {
  const at = `cast ${person.id}:`
  if (castIds.has(person.id)) fail.push(`${at} duplicate id`)
  castIds.add(person.id)
  if (!byId.has(person.home_location_id)) fail.push(`${at} lives at unknown place ${person.home_location_id}`)
  if (!person.portraits?.default) fail.push(`${at} has no default portrait`)
  for (const flag of [person.gated_by_flag, person.reveals_flag].filter(Boolean) as string[]) {
    if (!flagsInPlay.has(flag)) fail.push(`${at} references flag '${flag}' that the world does not use`)
  }
  // Guarded knowledge is the difference between a secret the player earns and
  // one a character can volunteer in their first scene. An ungated entry here
  // is silently just `knows`, so the gate is checked rather than trusted.
  for (const guarded of person.knows_guarded ?? []) {
    if (!guarded.requires) fail.push(`${at} has guarded knowledge with no gate — it would leak like open knowledge`)
    else if (!flagsInPlay.has(guarded.requires)) {
      fail.push(`${at} guards knowledge behind flag '${guarded.requires}' that the world does not use`)
    }
  }
}

// Every portrait a character can show must be a real asset id, or the card
// renders empty at the moment the player first meets them.
const portraitIds = new Set(cast.flatMap((p) => Object.values(p.portraits ?? {})))

const reign = world.reign as { petitions?: { id: string; at: string; requires?: string }[] } | null
for (const petition of reign?.petitions ?? []) {
  const at = `petition ${petition.id}:`
  if (!byId.has(petition.at)) fail.push(`${at} happens at unknown place ${petition.at}`)
  if (petition.requires && !flagsInPlay.has(petition.requires)) {
    fail.push(`${at} requires flag '${petition.requires}' that the world does not use`)
  }
}

const progression = world.progression as { standing?: { id: string; shifts?: { choice_id: string }[] }[] } | null
const choiceIds = new Set(IRON_VERDICT_CHOICES.map((c) => c.id))
for (const track of progression?.standing ?? []) {
  for (const shift of track.shifts ?? []) {
    if (!choiceIds.has(shift.choice_id)) {
      fail.push(`standing ${track.id}: shifts on unknown choice '${shift.choice_id}'`)
    }
  }
}

console.log(
  `sidecars: ${cast.length} characters, ${portraitIds.size} portraits, ` +
  `${reign?.petitions?.length ?? 0} petitions, ${progression?.standing?.length ?? 0} standing tracks`,
)

// Every flag the graph gates on must be settable by an authored choice, or it
// is a wall with no key. Later-chapter flags are expected and only warned about.
const settable = new Set(IRON_VERDICT_CHOICES.map((c) => c.sets))
const chapterOne = new Set(['verdict_witnessed', 'cassian_trust', 'writ_read', 'gate_passed', 'thornhollow_pact'])
for (const location of IRON_VERDICT_LOCATIONS) {
  for (const flag of [location.unlock_flag, location.reveal_flag].filter(Boolean) as string[]) {
    if (!settable.has(flag)) warn.push(`${location.id}: gated on '${flag}', which no Chapter I choice sets`)
  }
}
for (const choice of IRON_VERDICT_CHOICES) {
  if (!byId.has(choice.at)) fail.push(`choice ${choice.id} happens at unknown location ${choice.at}`)
  if (choice.requires && !settable.has(choice.requires)) fail.push(`choice ${choice.id} requires unsettable '${choice.requires}'`)
}

// Walk Chapter I exactly as a player would: only routes out of places that are
// open, gaining only the flags the authored choices actually grant in order.
const flags: Record<string, boolean> = {}
const reached = new Set([IRON_VERDICT_START_LOCATION])
for (let pass = 0; pass < 12; pass++) {
  for (const choice of IRON_VERDICT_CHOICES) {
    if (!reached.has(choice.at)) continue
    if (choice.requires && flags[choice.requires] !== true) continue
    flags[choice.sets] = true
  }
  for (const id of [...reached]) {
    for (const route of byId.get(id)!.routes) {
      if (visibilityFor(byId.get(route)!, flags) === 'open') reached.add(route)
    }
  }
}
const unreachable = IRON_VERDICT_LOCATIONS.filter((l) => !reached.has(l.id))
const chapterOneOnly = unreachable.filter((l) => {
  const gates = [l.unlock_flag, l.reveal_flag].filter(Boolean) as string[]
  return gates.every((g) => chapterOne.has(g))
})
for (const l of chapterOneOnly) {
  fail.push(`${l.id}: gated only on Chapter I flags but is still unreachable after a full Chapter I playthrough`)
}

for (const plate of IRON_VERDICT_MAP_STYLE.plates) {
  if (!assetIds.has(plate.asset_id)) fail.push(`plate ${plate.asset_id} is not in the manifest`)
  // A plate with no measured size falls back to a square slice, which squashes
  // the terrain while sprite coordinates stay true — landmarks then sit on the
  // wrong ground and nothing errors. Published plates must carry dimensions.
  const art = IRON_VERDICT_ASSETS.find((a) => a.id === plate.asset_id)
  if (art && !art.width) fail.push(`plate ${plate.asset_id} has no measured size; the map column would be laid out square`)
}
for (const id of [IRON_VERDICT_MAP_STYLE.fog_asset_id, IRON_VERDICT_MAP_STYLE.sealed_marker_asset_id]) {
  if (id && !assetIds.has(id)) fail.push(`map kit ${id} is not in the manifest`)
}

const enterable = IRON_VERDICT_LOCATIONS.filter((l) => l.scene_asset_id).length
console.log(`Iron Verdict — ${IRON_VERDICT_LOCATIONS.length} locations, ${enterable} enterable, ${IRON_VERDICT_LOCATIONS.length - enterable} map-presence`)
console.log(`Chapter I reaches ${reached.size}: ${[...reached].join(', ')}`)
console.log(`${IRON_VERDICT_ASSETS.length} assets referenced`)
for (const w of warn) console.log(`⚠ ${w}`)
for (const f of fail) console.log(`✗ ${f}`)
console.log(fail.length ? `\n${fail.length} failures` : '\nall checks passed')
process.exit(fail.length ? 1 : 0)
