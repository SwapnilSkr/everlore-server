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
import {
  asList,
  effectiveFlags,
  worldVocabulary,
  choicePredicate,
  requireWorld,
  satisfies,
  type WorldEnding,
} from '../src/worlds/world-source'
import { endingFor, PETITIONS_OPEN, progressionFor } from '../src/worlds/progression'

const world = requireWorld('iron-verdict')
const IRON_VERDICT_ASSETS = world.assets
const IRON_VERDICT_CHOICES = world.choices
const IRON_VERDICT_LOCATIONS = world.locations
const IRON_VERDICT_MAP_STYLE = world.map_style
const IRON_VERDICT_REALMS = world.realms
const IRON_VERDICT_START_LOCATION = world.start_location_id
import { visibilityFor } from '../src/services/interactive-world.service'

/** The four exclusive dispositions of the writ. One road may hold only one. */
const DISPOSALS = new Set(['writ_sold', 'writ_burned', 'writ_given_court', 'writ_given_thornhollow'])

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
for (const c of IRON_VERDICT_CHOICES) for (const f of asList(c.sets)) flagsInPlay.add(f)

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

const reign = world.reign
const trackIds = new Set((world.progression?.standing ?? []).map((t) => t.id))
const petitionIds = new Set<string>()
for (const petition of reign?.petitions ?? []) {
  const at = `petition ${petition.id}:`
  if (petitionIds.has(petition.id)) fail.push(`${at} duplicate id`)
  petitionIds.add(petition.id)
  if (!byId.has(petition.at)) fail.push(`${at} happens at unknown place ${petition.at}`)
  if (petition.requires && !flagsInPlay.has(petition.requires)) {
    fail.push(`${at} requires flag '${petition.requires}' that the world does not use`)
  }
  if (!petition.the_truth) fail.push(`${at} has no truth behind it, so there is nothing to judge against`)
  if ((petition.parties ?? []).length < 2) fail.push(`${at} has fewer than two parties`)
  if ((petition.resolutions ?? []).length < 2) fail.push(`${at} offers fewer than two ways to rule`)
  const resolutionIds = new Set<string>()
  for (const resolution of petition.resolutions ?? []) {
    const rat = `${at} ${resolution.id}:`
    if (resolutionIds.has(resolution.id)) fail.push(`${rat} duplicate resolution id`)
    resolutionIds.add(resolution.id)
    // These three are what the escalation rule turns. A resolution missing any
    // of them rules on the day and seeds nothing, which is the difference
    // between a reign and a list of one-off scenes.
    for (const field of ['made_whole', 'made_to_pay', 'principle'] as const) {
      if (!resolution[field]) fail.push(`${rat} has no ${field.replace(/_/g, ' ')}, so it seeds nothing`)
    }
    for (const track of Object.keys(resolution.standing_shift ?? {})) {
      if (!trackIds.has(track)) fail.push(`${rat} shifts unknown standing track '${track}'`)
    }
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

// ── Can the world actually be played? ─────────────────────────────────────
// The old check walked one authored corridor and reported how far it got. That
// passed for months while eighteen of thirty locations were gated on flags no
// choice set — it only ever measured the road it was told about. This walks the
// graph instead: every choice, every road, and it fails on what cannot be
// reached rather than reporting where it stopped.

/** Every flag any authored choice can set. A gate on anything else is a wall with no key. */
const allSettable = new Set(IRON_VERDICT_CHOICES.flatMap((c) => asList(c.sets)))

/** Play greedily to exhaustion, taking every choice that is open. */
function closure(banned: Set<string>) {
  const flags: Record<string, boolean> = {}
  const reached = new Set([IRON_VERDICT_START_LOCATION])
  const taken = new Set<string>()
  for (let pass = 0; pass < IRON_VERDICT_CHOICES.length + IRON_VERDICT_LOCATIONS.length; pass++) {
    for (const choice of IRON_VERDICT_CHOICES) {
      if (taken.has(choice.id) || banned.has(choice.id) || !reached.has(choice.at)) continue
      if (!satisfies(choicePredicate(choice), flags)) continue
      taken.add(choice.id)
      for (const flag of asList(choice.sets)) flags[flag] = true
    }
    for (const id of [...reached]) {
      for (const route of byId.get(id)!.routes) {
        if (visibilityFor(byId.get(route)!, flags) === 'open') reached.add(route)
      }
    }
  }
  return { flags, reached, taken }
}

// The roads out are mutually exclusive, so no single playthrough sees the whole
// world. A road is one DISPOSAL of the writ paired with one way of closing the
// succession; enumerating the compatible pairs is what makes each ending
// reachable in the simulation. Testing one road per ending is not enough — two
// roads land on The Verdict Upheld and only one of them ever visits Serevane.
const endings = (world.progression?.endings ?? []) as WorldEnding[]
const disposals = IRON_VERDICT_CHOICES.filter((c) => asList(c.sets).some((f) => DISPOSALS.has(f)))
const terminals = IRON_VERDICT_CHOICES.filter((c) => asList(c.sets).includes('succession_passed'))

const roads: { label: string; run: ReturnType<typeof closure> }[] = []
for (const disposal of disposals) {
  for (const terminal of terminals) {
    // A terminal that disposes of the writ some other way is a different road.
    if (terminal !== disposal && asList(terminal.sets).some((f) => DISPOSALS.has(f))) continue
    const banned = new Set(
      [...disposals, ...terminals].filter((c) => c !== disposal && c !== terminal).map((c) => c.id),
    )
    const run = closure(banned)
    if (run.taken.has(terminal.id)) roads.push({ label: `${disposal.id} → ${terminal.id}`, run })
  }
}
if (!roads.length) fail.push('no playable road closes the succession at all')

const anywhere = new Set<string>()
for (const road of roads) for (const id of road.run.reached) anywhere.add(id)

for (const location of IRON_VERDICT_LOCATIONS) {
  if (!anywhere.has(location.id)) {
    const gates = [location.unlock_flag, location.reveal_flag].filter(Boolean).join(' + ')
    fail.push(`${location.id}: no playthrough can reach it (gated on ${gates || 'nothing — check its routes'})`)
  }
}

// Every ending must be the ending its own road arrives at. A road that lands on
// a DIFFERENT ending is the failure that matters: it means an earlier trigger
// latched first and the later one is unreachable in play, which no reachability
// check would catch.
const landedOn = new Map<string, string>()
for (const { label, run } of roads) {
  const landed = endingFor(endings, run.flags)
  if (!landed) fail.push(`road ${label} reaches no ending at all — the player is left standing in a finished world`)
  else landedOn.set(landed.id, label)
}
for (const ending of endings) {
  if (!landedOn.has(ending.id)) fail.push(`ending ${ending.id} is unreachable: no road's flags satisfy it, or an earlier trigger latches first`)
}

// A choice nothing can ever offer is authored content the player never sees.
const everTaken = new Set(roads.flatMap((r) => [...r.run.taken]))
for (const choice of IRON_VERDICT_CHOICES) {
  if (!byId.has(choice.at)) fail.push(`choice ${choice.id} happens at unknown location ${choice.at}`)
  else if (!everTaken.has(choice.id)) fail.push(`choice ${choice.id} can never be offered on any road`)
  for (const flag of asList(choice.requires)) {
    if (!allSettable.has(flag)) fail.push(`choice ${choice.id} requires '${flag}', which nothing sets`)
  }
}

// A Mark whose condition nothing satisfies is a locked trophy.
const marks = (world.progression?.marks ?? []) as { id: string; awarded_when: Record<string, unknown> }[]
for (const mark of marks) {
  const when = mark.awarded_when as { flag?: string; ending?: string; places_revealed?: number }
  if (when.flag && !allSettable.has(when.flag)) fail.push(`mark ${mark.id}: awarded on '${when.flag}', which nothing sets`)
  else if (when.ending && !endings.some((e) => e.id === when.ending)) fail.push(`mark ${mark.id}: awards on unknown ending '${when.ending}'`)
  else if (when.places_revealed !== undefined) {
    const most = Math.max(...roads.map((r) => IRON_VERDICT_LOCATIONS.filter((l) => visibilityFor(l, r.run.flags) !== 'rumoured').length))
    if (most < when.places_revealed) fail.push(`mark ${mark.id}: needs ${when.places_revealed} places revealed; the best road reveals ${most}`)
  } else if (!when.flag && !when.ending && when.places_revealed === undefined) {
    fail.push(`mark ${mark.id}: has no award condition, so it can never be earned`)
  }
}

// Petitions are the post-ending loop. One sited where no road ever goes is a
// piece of the endgame the player cannot be handed.
for (const petition of reign?.petitions ?? []) {
  if (byId.has(petition.at) && !anywhere.has(petition.at)) {
    fail.push(`petition ${petition.id}: sited at ${petition.at}, which no playthrough reaches`)
  }
}

console.log(
  `playable: ${anywhere.size}/${IRON_VERDICT_LOCATIONS.length} locations, ` +
  `${everTaken.size}/${IRON_VERDICT_CHOICES.length} choices, ` +
  `${landedOn.size}/${endings.length} endings over ${roads.length} roads`,
)
for (const { label, run } of roads) {
  console.log(`  ${label.padEnd(42)} ${run.reached.size} places, ${run.taken.size} choices → ${endingFor(endings, run.flags)?.id ?? 'nowhere'}`)
}

// ── The narration seam ────────────────────────────────────────────────────
// The story loop can open the map. Prove both halves of that: a flag the world
// gates on gets through, and one it does not is ignored. The second half is the
// one worth guarding — the narrator mints flag names freely, and without the
// vocabulary check an invented name could unseal a place by coincidence.
const vocabulary = worldVocabulary(world)
for (const flag of allSettable) {
  if (!vocabulary.has(flag)) fail.push(`flag '${flag}' is set by a choice but is not in the world vocabulary`)
}

const sealedByNarration = IRON_VERDICT_LOCATIONS.find((l) => l.unlock_flag && l.visibility === 'sealed')
if (!sealedByNarration) warn.push('no sealed location to test the narration seam against')
else {
  const opened = effectiveFlags(world, {}, { [sealedByNarration.unlock_flag!]: true })
  if (visibilityFor(sealedByNarration, opened) !== 'open') {
    fail.push(`narration cannot open ${sealedByNarration.id}: the story loop and the map are not connected`)
  }
  const invented = effectiveFlags(world, {}, { a_flag_the_narrator_made_up: true })
  if (Object.keys(invented).length) fail.push('a flag outside the world vocabulary reached the map')
  const counted = effectiveFlags(world, {}, { [sealedByNarration.unlock_flag!]: 3 })
  if (Object.keys(counted).length) fail.push('a counter reached the map as though it were an open gate')
}

// A petition is only judgeable while the player does not know the answer. Two
// fields would give it away — what is actually the case, and what each ruling
// costs — and both live on the authored petition right next to what is sent.
// This asserts on the real payload rather than trusting the mapping to stay
// right, because the failure is invisible: the scene still works, it is just
// no longer a judgement.
const anyPetition = (reign?.petitions ?? [])[0]
if (anyPetition) {
  const openFlags = { [PETITIONS_OPEN]: true, ...(anyPetition.requires ? { [anyPetition.requires]: true } : {}) }
  const sent = progressionFor(world.progression, world.reign, IRON_VERDICT_LOCATIONS, {
    flags: openFlags,
    taken_choice_ids: [],
    revealed_location_ids: [],
    current_location_id: anyPetition.at,
    ledger: [],
  }).petitions
  const wire = JSON.stringify(sent)
  if (!sent.length) fail.push(`petition ${anyPetition.id} is not offered at its own location`)
  if (wire.includes(anyPetition.the_truth.slice(0, 60))) fail.push(`petition ${anyPetition.id}: the truth is sent to the client, which spoils it`)
  for (const resolution of anyPetition.resolutions) {
    if (wire.includes(resolution.consequence.slice(0, 60))) {
      fail.push(`petition ${anyPetition.id}: ruling consequences are sent to the client, making it a menu with the answers on it`)
    }
  }
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
console.log(`${IRON_VERDICT_ASSETS.length} assets referenced`)
for (const w of warn) console.log(`⚠ ${w}`)
for (const f of fail) console.log(`✗ ${f}`)
console.log(fail.length ? `\n${fail.length} failures` : '\nall checks passed')
process.exit(fail.length ? 1 : 0)
