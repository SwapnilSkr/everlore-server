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
import { endingFor, PETITIONS_OPEN, progressionFor, ripensTo, seasonLength } from '../src/worlds/progression'
import { composeRipenedPetition, siteForGrievance, verifyRipenedPetition } from '../src/services/grievance-ripening.service'
import { knowledgeFor, offerCast, presentCast } from '../src/worlds/cast'
import { briefFor, composeSpokenReply, verifySpokenReply } from '../src/services/character-speech.service'
import { briefForDuel, composeDuel, duelForChoice, offerDuel, verifyDuelProse } from '../src/services/duel.service'
import { assertInstanceBoundToWorld, reasonInstanceNotBoundToWorld } from '../src/services/instance.service'
import { HttpError } from '../src/utils/http-error'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const world = requireWorld('iron-verdict')
const IRON_VERDICT_ASSETS = world.assets
const IRON_VERDICT_CHOICES = world.choices
const IRON_VERDICT_LOCATIONS = world.locations
const IRON_VERDICT_MAP_STYLE = world.map_style
const IRON_VERDICT_REALMS = world.realms
const IRON_VERDICT_START_LOCATION = world.start_location_id
import {
  definitionNeedsRefresh,
  quickTravelTargetsFor,
  travelTargetsFor,
  worldStateView,
} from '../src/services/interactive-world.service'
import { visibilityFor, witnessedHere } from '../src/worlds/world-play'

/** The four exclusive dispositions of the writ. One road may hold only one. */
const DISPOSALS = new Set(['writ_sold', 'writ_burned', 'writ_given_court', 'writ_given_thornhollow'])

const fail: string[] = []
const warn: string[] = []

const byId = new Map(IRON_VERDICT_LOCATIONS.map((l) => [l.id, l]))
const assetIds = new Set(IRON_VERDICT_ASSETS.map((a) => a.id))
const assetsById = new Map(IRON_VERDICT_ASSETS.map((a) => [a.id, a]))
const realms = new Map(IRON_VERDICT_REALMS.map((r) => [r.id, r]))

if (byId.size !== IRON_VERDICT_LOCATIONS.length) fail.push('duplicate location ids')
if (!byId.has(IRON_VERDICT_START_LOCATION)) fail.push(`start location ${IRON_VERDICT_START_LOCATION} does not exist`)
if (!Number.isInteger(world.definition_version) || world.definition_version < 1) {
  fail.push('definition_version must be a positive integer')
} else {
  if (!definitionNeedsRefresh(world.definition_version - 1, world.definition_version)) {
    fail.push('a stored definition one version behind would not be refreshed')
  }
  if (definitionNeedsRefresh(world.definition_version, world.definition_version)) {
    fail.push('a current stored definition would be rewritten on every read')
  }
  if (definitionNeedsRefresh(world.definition_version + 1, world.definition_version)) {
    fail.push('a newer stored definition would be downgraded by older authored data')
  }
}

// THE WIRE STATE IS EFFECTIVE; STORAGE IS NOT. Narration may open an authored
// gate, and the client must see the same truth used by cast/progression without
// that derived flag becoming a permanent interactive-world mutation.
const narratedGate = IRON_VERDICT_LOCATIONS.find(
  (location) => location.unlock_flag && byId.get(IRON_VERDICT_START_LOCATION)?.routes.includes(location.id),
)
if (!narratedGate?.unlock_flag) {
  fail.push('no adjacent authored gate exists to test effective wire state')
} else {
  const stored = {
    current_location_id: IRON_VERDICT_START_LOCATION,
    flags: { an_authored_fact: true },
  } as any
  const before = JSON.stringify(stored)
  const effective = effectiveFlags(world, stored.flags, { [narratedGate.unlock_flag]: true })
  const view = worldStateView(stored, effective, IRON_VERDICT_LOCATIONS)
  if (view.flags[narratedGate.unlock_flag] !== true) {
    fail.push('an effective narrated flag is absent from the state sent to the client')
  }
  if (view.flags.an_authored_fact !== true) {
    fail.push('the effective state view dropped an authored stored flag')
  }
  if (JSON.stringify(stored) !== before || stored.flags[narratedGate.unlock_flag] === true) {
    fail.push('building the effective wire state mutated the stored authored flags')
  }
}

// A known open location is not necessarily one step away. The server-derived
// targets must be exactly the current place's open authored neighbours.
const everyFlag = Object.fromEntries([...worldVocabulary(world)].map((flag) => [flag, true]))
const travelTargets = travelTargetsFor(IRON_VERDICT_LOCATIONS, IRON_VERDICT_START_LOCATION, everyFlag)
const start = byId.get(IRON_VERDICT_START_LOCATION)!
const openNonNeighbour = IRON_VERDICT_LOCATIONS.find(
  (location) => location.id !== start.id && !start.routes.includes(location.id) && visibilityFor(location, everyFlag) === 'open',
)
if (!start.routes.length || !start.routes.every((id) => travelTargets.includes(id))) {
  fail.push('an open authored neighbour is missing from the server-derived travel targets')
}
if (!openNonNeighbour) {
  fail.push('no open non-neighbour exists to test the travel-target boundary')
} else if (travelTargets.includes(openNonNeighbour.id)) {
  fail.push(`non-adjacent ${openNonNeighbour.id} is offered as a one-step travel target`)
}

const seenNeighbour = start.routes.find((id) => travelTargets.includes(id))
const hasteFromStart = quickTravelTargetsFor(
  IRON_VERDICT_LOCATIONS,
  IRON_VERDICT_START_LOCATION,
  everyFlag,
  seenNeighbour && openNonNeighbour ? [seenNeighbour, openNonNeighbour.id] : [],
  IRON_VERDICT_LOCATIONS.map((location) => location.id),
)
if (seenNeighbour && hasteFromStart.includes(seenNeighbour)) {
  fail.push('a neighbour is also offered as haste, so the walk and the known road are the same button')
}
if (openNonNeighbour && !hasteFromStart.includes(openNonNeighbour.id)) {
  fail.push('a walked non-neighbour is missing from haste travel')
}

const startWitness = witnessedHere(world, IRON_VERDICT_START_LOCATION, everyFlag, IRON_VERDICT_CHOICES.filter((c) => c.at === IRON_VERDICT_START_LOCATION).map((c) => c.id))
if (IRON_VERDICT_CHOICES.some((c) => c.at === IRON_VERDICT_START_LOCATION && c.summary) && !startWitness.some((fact) => fact.includes('You were present'))) {
  fail.push('a taken deed at the start is invisible to someone who stood there')
}

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
  if (location.visibility === 'rumoured' && asList(location.reveal_flag).length === 0) {
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

const drillIds = new Set<string>()
for (const drill of world.drills ?? []) {
  const at = `drill ${drill.id}:`
  if (drillIds.has(drill.id)) fail.push(`${at} duplicate id`)
  drillIds.add(drill.id)
  if (!byId.has(drill.at)) fail.push(`${at} is worked at unknown place ${drill.at}`)
  const raises = Object.values(drill.raises ?? {}).some((n) => typeof n === 'number' && n > 0)
  if (!raises) fail.push(`${at} raises nothing`)
}

if (!world.overture?.beats.length) {
  fail.push('the world has no overture, so a new walker is dropped into the lobby with no duchy')
} else {
  world.overture.beats.forEach((beat, index) => {
    const at = `overture beat ${index + 1}:`
    if (!beat.mark.trim() || !beat.title.trim() || !beat.body.trim()) fail.push(`${at} is missing copy`)
    if (!assetIds.has(beat.scene_asset_id)) fail.push(`${at} paints unknown '${beat.scene_asset_id}'`)
  })
}

// ── Sidecars ──────────────────────────────────────────────────────────────
// The cast, progression and post-ending files are authored separately and are
// the easiest thing in the world to let drift: nothing renders them yet, so a
// dangling location id or a flag that stopped existing fails silently and is
// found months later. Check them here, where the world data is already loaded.
const flagsInPlay = new Set<string>()
for (const l of IRON_VERDICT_LOCATIONS) {
  if (l.unlock_flag) flagsInPlay.add(l.unlock_flag)
  for (const flag of asList(l.reveal_flag)) flagsInPlay.add(flag)
}
for (const c of IRON_VERDICT_CHOICES) for (const f of asList(c.sets)) flagsInPlay.add(f)
for (const duel of world.duels) {
  for (const flag of duel.outcome.sets) flagsInPlay.add(flag)
  for (const flag of duel.loss?.sets ?? []) flagsInPlay.add(flag)
  for (const sets of Object.values(duel.loss?.sets_if_lead ?? {})) {
    for (const flag of sets) flagsInPlay.add(flag)
  }
}

const cast = world.cast
const castIds = new Set<string>()
for (const person of cast) {
  const at = `cast ${person.id}:`
  if (castIds.has(person.id)) fail.push(`${at} duplicate id`)
  castIds.add(person.id)
  if (!byId.has(person.home_location_id)) fail.push(`${at} lives at unknown place ${person.home_location_id}`)
  if (!person.portraits?.default) fail.push(`${at} has no default portrait`)
  if (person.playable === true) {
    const start = person.start_location_id ?? IRON_VERDICT_START_LOCATION
    if (!byId.has(start)) fail.push(`${at} starts at unknown place ${start}`)
  }
  for (const flag of [person.gated_by_flag, person.reveals_flag, person.hidden_if_flag].filter(Boolean) as string[]) {
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
    const gates = [location.unlock_flag, ...asList(location.reveal_flag)].filter(Boolean).join(' + ')
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

// ── The cast ──────────────────────────────────────────────────────────────
// Presence and conversation are the newest surface and the one with the most
// ways to fail silently. A character standing in an empty frame, a secret
// volunteered on turn one, a road opened by a flag nobody authored: all three
// render a scene that looks entirely correct.

// A portrait id with no published asset behind it is an empty card at the exact
// moment the player first meets someone.
for (const person of cast) {
  for (const [bearing, id] of Object.entries(person.portraits ?? {})) {
    if (!assetIds.has(id)) fail.push(`cast ${person.id}: portrait '${bearing}' (${id}) is not in the manifest`)
  }
}

// A character is only worth authoring if some playthrough can stand in front of
// them. Both halves: the place has to be reachable, and the gate has to be a
// flag something can actually set.
for (const person of cast) {
  if (byId.has(person.home_location_id) && !anywhere.has(person.home_location_id)) {
    fail.push(`cast ${person.id}: lives at ${person.home_location_id}, which no playthrough reaches`)
  }
  if (person.gated_by_flag && !allSettable.has(person.gated_by_flag)) {
    fail.push(`cast ${person.id}: gated on '${person.gated_by_flag}', which nothing sets — they can never be met`)
  }
  // What a character can grant has to be a flag the world reads. Otherwise the
  // conversation seam is decoration: they hand over the name and no door opens.
  if (person.reveals_flag && !vocabulary.has(person.reveals_flag)) {
    fail.push(`cast ${person.id}: reveals '${person.reveals_flag}', which the world does not gate anything on`)
  }
}

// PRESENCE IS DERIVED. Proved rather than asserted: with the gate off the
// character is not in the room, with the gate on they are, and the ONLY thing
// that changed is the flag. A hardcoded roster would pass the second check and
// fail the first.
const gatedPerson = cast.find((p) => p.gated_by_flag)
if (!gatedPerson) warn.push('no gated character to test presence against')
else {
  const shut = presentCast(world, gatedPerson.home_location_id, {})
  if (shut.some((p) => p.id === gatedPerson.id)) {
    fail.push(`cast ${gatedPerson.id}: present before '${gatedPerson.gated_by_flag}' has landed`)
  }
  const open = presentCast(world, gatedPerson.home_location_id, { [gatedPerson.gated_by_flag!]: true })
  if (!open.some((p) => p.id === gatedPerson.id)) {
    fail.push(`cast ${gatedPerson.id}: never appears even once '${gatedPerson.gated_by_flag}' has landed`)
  }
}

// The other half of the exposure rule, and the one that would cost a place on
// the map: `reveals_flag` is what a character GRANTS, not a gate. Reading it as
// one makes them unreachable — you would need the flag only they can give — and
// nothing errors, the room is simply always empty.
for (const person of cast) {
  if (!person.reveals_flag || person.gated_by_flag) continue
  if (!presentCast(world, person.home_location_id, {}).some((p) => p.id === person.id)) {
    fail.push(`cast ${person.id}: ungated, but absent with no flags set — reveals_flag is being read as a gate`)
  }
}

// GUARDED KNOWLEDGE, asserted on the REAL payload and the REAL prompt.
//
// This is the same class of invariant as `the_truth` on a petition and it fails
// the same invisible way: the Duke confessing his complicity in his first
// sentence is a perfectly good scene, and nothing on the screen says the
// chapter's answer was just given away. Each check is followed by proof that it
// BITES — the same needle found where it is supposed to be — because an
// assertion that can never fail is worse than none.
const guardian = cast.find((p) => (p.knows_guarded ?? []).length)
if (!guardian) warn.push('no guarded knowledge authored, so nothing tests the guard')
else {
  const secret = guardian.knows_guarded![0]!
  const needle = secret.fact.slice(0, 40)
  const somewhere = byId.get(guardian.home_location_id)!

  // 1. The client payload. Nothing a character knows, wants or fears is on it
  //    at all, guarded or not — the client renders a face and a name.
  const onTheWire = JSON.stringify(offerCast([guardian], IRON_VERDICT_ASSETS, () => false))
  // The entrance is authored for the player and is the one thing here that is
  // meant to be read. It goes out before the meeting and never after it.
  if (!onTheWire.includes(guardian.first_met.slice(0, 40))) {
    fail.push(`cast ${guardian.id}: their first meeting is never sent, so an unmet character is a card with a face on it`)
  }
  if (JSON.stringify(offerCast([guardian], IRON_VERDICT_ASSETS, () => true)).includes(guardian.first_met.slice(0, 40))) {
    fail.push(`cast ${guardian.id}: their arrival is sent again after they have been met`)
  }
  if (onTheWire.includes(needle)) fail.push(`cast ${guardian.id}: guarded knowledge is sent to the client`)
  for (const open of guardian.knows) {
    if (onTheWire.includes(open.slice(0, 40))) fail.push(`cast ${guardian.id}: what they know is sent to the client`)
  }
  for (const field of [guardian.wants, guardian.fears]) {
    if (onTheWire.includes(field.slice(0, 40))) fail.push(`cast ${guardian.id}: their motives are sent to the client`)
  }
  // The needle itself must be findable, or the three checks above prove nothing.
  if (!JSON.stringify(guardian).includes(needle)) fail.push('the guarded-knowledge check cannot detect a leak it is looking at')

  // 2. The prompt. Assembled by the same function the service calls, with the
  //    same filter, so this is what would actually be sent.
  const asked = (flags: Record<string, boolean>) =>
    JSON.stringify(
      briefFor({
        member: guardian,
        knowledge: knowledgeFor(guardian, flags),
        where: somewhere,
        disposition: guardian.disposition_start,
        met: false,
        history: [],
        said: 'What do you know about the writ?',
      }),
    )
  if (asked({}).includes(needle)) fail.push(`cast ${guardian.id}: guarded knowledge reaches the model before '${secret.requires}'`)
  // The bite: the identical assertion against the earned state must FIND it.
  // Without this, a filter that dropped guarded knowledge entirely would pass
  // and the secret would simply never exist.
  if (!asked({ [secret.requires]: true }).includes(needle)) {
    fail.push(`cast ${guardian.id}: guarded knowledge never reaches the model even once '${secret.requires}' has landed`)
  }
  // Open knowledge is in from the first word, or the character has nothing to
  // say and the whole seam is a stranger refusing to talk.
  if (!asked({}).includes(guardian.knows[0]!.slice(0, 40))) {
    fail.push(`cast ${guardian.id}: what they openly know never reaches the model`)
  }
}

// A MODEL IS NEVER TRUSTED WITH STRUCTURE. The reply carries words and two
// judgements; the portrait, the flag and the bounds are minted here. Each of
// these would be silent: an unpublished portrait id renders an empty frame, and
// an invented flag is a door in the map with no author behind it.
const speaker = cast.find((p) => p.reveals_flag)
if (!speaker) warn.push('no character can reveal anything, so conversation cannot move the map')
else {
  const WRITTEN = { line: 'He looked at the paper a long time before he answered.', bearing: 'default', turned: true, disposition_delta: 1 }
  const invented = composeSpokenReply(
    { ...WRITTEN, bearing: 'a face nobody painted' },
    { member: speaker, disposition: 0, canSet: () => true },
  )
  if (!assetIds.has(invented.portrait_asset_id)) {
    fail.push(`cast ${speaker.id}: a bearing the model invented resolves to an unpublished portrait`)
  }
  const refused = composeSpokenReply(WRITTEN, { member: speaker, disposition: 0, canSet: () => false })
  if (refused.sets_flag) fail.push(`cast ${speaker.id}: opens a road on a flag the world does not gate anything on`)
  const granted = composeSpokenReply(WRITTEN, { member: speaker, disposition: 0, canSet: (f) => vocabulary.has(f) })
  if (granted.sets_flag !== speaker.reveals_flag) {
    fail.push(`cast ${speaker.id}: being won over grants '${granted.sets_flag}' rather than the authored flag`)
  }
  // The flag a conversation mints has to be readable by the map, or something
  // learned in conversation opens nothing.
  const opened = effectiveFlags(world, { [granted.sets_flag!]: true }, undefined)
  if (opened[speaker.reveals_flag!] !== true) fail.push(`cast ${speaker.id}: what they grant does not survive the flag union`)
  const shoved = composeSpokenReply({ ...WRITTEN, disposition_delta: 99 }, { member: speaker, disposition: 0, canSet: () => true })
  if (Math.abs(shoved.disposition) > 3) fail.push(`cast ${speaker.id}: one sentence can move a character to ${shoved.disposition}`)
  const held = verifySpokenReply({ ...WRITTEN, disposition_delta: 99 })
  if (!held || Math.abs(held.disposition_delta) > 1) fail.push('a single exchange can move a character by more than a step')
}

// DEGRADED MODE. A refused or failed call returns null and the caller narrates
// the authored line — so the player gets a beat of fiction and can say
// something else. Without the authored line they would get an empty string,
// which is a character standing there having said nothing at all.
if (!world.cast_unanswered) fail.push('no authored line for a character who does not answer — a failed call would render nothing')
const MALFORMED_REPLY: Record<string, unknown> = {
  'an empty response': {},
  'the schema echoed back': { type: 'object', properties: { line: { type: 'string' } } },
  'a reply with no words in it': { line: '   ', bearing: 'default', turned: true, disposition_delta: 0 },
}
for (const [what, payload] of Object.entries(MALFORMED_REPLY)) {
  if (verifySpokenReply(payload)) fail.push(`speech accepts ${what}, which would render a character saying nothing`)
}
if (!verifySpokenReply({ line: 'He said nothing for a moment.', bearing: '', turned: false, disposition_delta: 0 })) {
  fail.push('speech refuses a well-formed reply, so nobody could ever answer')
}

console.log(
  `cast: ${cast.length} characters across ${new Set(cast.map((p) => p.home_location_id)).size} places, ` +
  `${cast.filter((p) => p.gated_by_flag).length} gated, ${cast.filter((p) => p.reveals_flag).length} can open a road, ` +
  `${cast.reduce((n, p) => n + (p.knows_guarded?.length ?? 0), 0)} guarded secrets`,
)

// A VERDICT FOUGHT ON THE SAND.
//
// The whole seam rests on one agreement: the fight the player watches and the
// story that follows it are settled by the SAME authored choice. Nothing here
// is rolled, so the only way the two can disagree is by drifting apart in the
// files — which presents as a fight the player watched themselves lose and a
// duchy that carries on as though they had won, with nothing on screen saying
// so and no error anywhere.
const duelIds = new Set<string>()
for (const duel of world.duels) {
  const at = `duel ${duel.id}:`
  if (duelIds.has(duel.id)) fail.push(`${at} duplicate id`)
  duelIds.add(duel.id)

  const trigger = IRON_VERDICT_CHOICES.find((c) => c.id === duel.choice_id)
  if (!trigger) {
    fail.push(`${at} is fought over '${duel.choice_id}', which no choice in this world offers`)
    continue
  }
  for (const extra of duel.choice_ids ?? []) {
    const other = IRON_VERDICT_CHOICES.find((c) => c.id === extra)
    if (!other) fail.push(`${at} also answers to '${extra}', which no choice in this world offers`)
    else if (asList(other.sets).sort().join() !== asList(trigger.sets).sort().join()) {
      fail.push(`${at} '${extra}' writes different flags than '${duel.choice_id}'`)
    }
  }
  if (duelForChoice(world, trigger.id)?.id !== duel.id) {
    fail.push(`${at} a second duel answers to '${trigger.id}', so which fight is staged depends on file order`)
  }
  // THE AGREEMENT. The choice writes the flags at runtime, exactly as it always
  // has; the duel restates them so this check can prove the staging is
  // dramatising the outcome the rest of the world was written against.
  const decided = asList(trigger.sets)
  const staged = duel.outcome.sets
  const disagree = [
    ...decided.filter((f) => !staged.includes(f)),
    ...staged.filter((f) => !decided.includes(f)),
  ]
  if (disagree.length) {
    fail.push(`${at} the fight and the choice disagree on ${disagree.join(', ')} — the player would watch one outcome and live in another`)
  }
  if (duel.at !== trigger.at) fail.push(`${at} is fought at ${duel.at} but taken at ${trigger.at}`)
  if (!byId.has(duel.at)) fail.push(`${at} is fought in a place that does not exist`)

  for (const [side, combatant] of [['challenger', duel.challenger], ['defender', duel.defender]] as const) {
    if (combatant.portrait_asset_id) {
      const portrait = assetsById.get(combatant.portrait_asset_id)
      if (!portrait) {
        fail.push(`${at} the ${side}'s face '${combatant.portrait_asset_id}' is not in the manifest`)
      } else if (portrait.role !== 'portrait') {
        fail.push(`${at} the ${side}'s face '${combatant.portrait_asset_id}' is a ${portrait.role}, not a portrait`)
      }
      if (combatant.cast_id) {
        fail.push(`${at} the ${side} has both a cast identity and a duel-local face, so which portrait owns them is ambiguous`)
      }
      if (combatant.is_player) {
        fail.push(`${at} the ${side} is the player but carries a fixed authored face`)
      }
    }
    if (combatant.cast_id) {
      const member = cast.find((c) => c.id === combatant.cast_id)
      if (!member) fail.push(`${at} the ${side} is ${combatant.cast_id}, who is in nobody's cast`)
    } else if (!combatant.is_player && !combatant.name) {
      fail.push(`${at} the ${side} is neither the player, nor in the cast, nor named — they would fight anonymously`)
    }
  }

  if (!duel.beats.length) fail.push(`${at} has no exchanges, so the fight is a title card`)
  for (const [index, beat] of duel.beats.entries()) {
    if (!beat.line.trim()) fail.push(`${at} exchange ${index + 1} has no authored words, so it is blank whenever the flavour pass is down`)
    if (beat.toll < 0) fail.push(`${at} exchange ${index + 1} costs less than nothing`)
    const combatant = beat.actor === 'challenger' ? duel.challenger : duel.defender
    const member = combatant.cast_id ? cast.find((c) => c.id === combatant.cast_id) : undefined
    // A bearing nobody painted falls back to the default face rather than to an
    // id the manifest has never heard of — but an author who meant a face and
    // mistyped it gets the wrong one silently, so it is caught here instead.
    if (beat.bearing && member && !member.portraits[beat.bearing]) {
      fail.push(`${at} exchange ${index + 1} wears '${beat.bearing}', which was never painted for ${member.id}`)
    }
  }

  // DEGRADED MODE IS THE BASELINE, not a fallback: this is the duel with no
  // model call at all, and it has to be a whole fight.
  const bare = composeDuel(duel, null, world)
  const loser = duel.outcome.winner === 'challenger' ? 'defender' : 'challenger'
  const last = bare.beats[bare.beats.length - 1]!
  if ((last[`${duel.outcome.winner}_vigour`] as number) <= 0) {
    fail.push(`${at} the fight ends with ${bare.outcome.victor_name} down as well, which is not a Verdict`)
  }
  // The staging puts the loser on the sand whatever the tolls add up to, so
  // this can never fail the fight — but a loser whose authored exchanges do not
  // actually cost them everything drops from whatever they had left straight to
  // nothing on the decisive blow, and the bar tells the player a different
  // story than the words did.
  const spent = duel.beats.filter((b) => b.actor !== loser).reduce((n, b) => n + b.toll, 0)
  if (spent < bare.vigour) {
    warn.push(`${at} the exchanges only take ${spent} of ${bare.vigour} from ${bare.outcome.fallen_name}, so they fall from ${bare.vigour - spent} in one blow`)
  }
  if (bare.beats.filter((b) => b.decisive).length !== 1) fail.push(`${at} the exchange the Verdict turns on is not exactly one`)
  if (!bare.outcome.victor_name || !bare.outcome.fallen_name) fail.push(`${at} someone in this fight has no name`)
  for (const beat of bare.beats) {
    if (!beat.action.trim()) fail.push(`${at} exchange ${beat.index + 1} renders nothing with no model call`)
    if (beat.portrait_asset_id && !assetIds.has(beat.portrait_asset_id)) {
      fail.push(`${at} exchange ${beat.index + 1} wears an unpublished face, which renders an empty frame mid-fight`)
    }
  }

  // A beat authored silent stays silent. Whether someone speaks in the middle
  // of a Verdict is staging, and a flavour pass that can add a line where the
  // author wrote none is staging the fight.
  const written = duel.beats.map(() => ({ action: 'He moved.', said: 'Something the author never wrote.' }))
  const loud = composeDuel(duel, written, world)
  for (const [index, beat] of duel.beats.entries()) {
    if (!beat.said && loud.beats[index]!.said) fail.push(`${at} exchange ${index + 1} was authored silent and speaks anyway`)
  }

  // Asked to rewrite an exchange whose actor speaks, the flavour pass folds the
  // speech into the prose — and the words are then read twice, once in the
  // panel and once in the bubble over his head. Seen in play.
  const doubled = composeDuel(
    duel,
    duel.beats.map((beat) => ({ action: `He moved, saying "${beat.said ?? 'nothing'}".`, said: beat.said })),
    world,
  )
  for (const [index, beat] of duel.beats.entries()) {
    if (beat.said && doubled.beats[index]!.said) {
      fail.push(`${at} exchange ${index + 1} speaks in the prose AND over his head, so the player reads it twice`)
    }
  }
  // The bite: an exchange whose prose does NOT speak must still carry its line,
  // or the whole authored half of the fight has gone silent.
  const spoken = duel.beats.filter((b) => b.said).length
  if (spoken && composeDuel(duel, null, world).beats.filter((b) => b.said).length !== spoken) {
    fail.push(`${at} the authored lines are dropped when nothing was rewritten`)
  }

  // NOTHING STRUCTURAL REACHES THE MODEL. It is given a plan and asked for the
  // same exchanges in better words; an id, a flag or a place key in the brief
  // is something it can echo back, and the one thing it is never trusted with.
  // Matched as a whole word rather than as a substring: an authored id may
  // legitimately be NAMED after the flag its fight decides, and `includes`
  // reads that as a leak of the flag itself.
  const names = (haystack: string, needle: string) => new RegExp(`\\b${needle}\\b`).test(haystack)
  const brief = JSON.stringify(briefForDuel(duel, world))
  for (const flag of vocabulary) {
    if (names(brief, flag)) fail.push(`${at} the flag '${flag}' is in the brief the model writes against`)
  }
  for (const asset of assetIds) if (brief.includes(asset)) fail.push(`${at} the asset id '${asset}' is in the brief`)
  for (const location of IRON_VERDICT_LOCATIONS) {
    if (brief.includes(`"${location.id}"`) || brief.includes(` ${location.id} `)) fail.push(`${at} the place key '${location.id}' is in the brief`)
  }
  // The bite: the brief has to actually carry the fight, or the checks above
  // are passing on an empty prompt.
  if (!brief.includes(duel.beats[0]!.line.slice(0, 40))) fail.push(`${at} the brief does not contain the fight it is meant to describe`)

  // WHAT THE PLAYER'S DEVICE RECEIVES. The flags are the answer to the whole
  // chapter; a duel that carries them has put the ending in the payload of the
  // turn before it, and the scene still plays perfectly.
  const wire = JSON.stringify(offerDuel(bare, IRON_VERDICT_ASSETS))
  for (const flag of staged) {
    if (names(wire, flag)) fail.push(`${at} '${flag}' is sent to the client with the fight`)
  }
  for (const asset of assetIds) if (wire.includes(`"${asset}"`)) fail.push(`${at} the asset id '${asset}' is sent instead of a URL`)
  for (const combatant of [duel.challenger, duel.defender]) {
    if (combatant.portrait_asset_id && wire.includes(combatant.portrait_asset_id)) {
      fail.push(`${at} the authored duel face '${combatant.portrait_asset_id}' is sent to the client instead of its URL`)
    }
  }
}

// The count is checked against the plan rather than merely bounded, because
// beats are matched to it BY INDEX: a response one short shifts every exchange
// onto the wrong actor, the wrong toll and the wrong face, and plays perfectly
// smoothly while describing the loser winning.
const PLAN = 4
const MALFORMED_DUEL: Record<string, unknown> = {
  'an empty response': {},
  'the schema echoed back': { type: 'object', properties: { beats: { type: 'array' } } },
  'one exchange short': { beats: [1, 2, 3].map(() => ({ action: 'He moved.' })) },
  'one exchange too many': { beats: [1, 2, 3, 4, 5].map(() => ({ action: 'He moved.' })) },
  'an exchange with nothing in it': { beats: [1, 2, 3, 4].map((n) => ({ action: n === 2 ? '  ' : 'He moved.' })) },
}
for (const [what, payload] of Object.entries(MALFORMED_DUEL)) {
  if (verifyDuelProse(payload, PLAN)) fail.push(`the fight accepts ${what}, which lands the exchanges on the wrong fighters`)
}
if (!verifyDuelProse({ beats: [1, 2, 3, 4].map(() => ({ action: 'He moved.' })) }, PLAN)) {
  fail.push('the fight refuses a well-formed staging, so no duel could ever be written')
}

if (world.duels.length) {
  console.log(
    `duels: ${world.duels.length} fought Verdicts over ${world.duels.reduce((n, d) => n + d.beats.length, 0)} exchanges, ` +
    `${world.duels.filter((d) => d.outcome.fatal).length} fatal`,
  )
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

// ── Grievance ripening ───────────────────────────────────────────────────
// The party made to pay comes back a season later with a worse quarrel. Three
// things about that are load-bearing and none of them are visible at runtime:
// the chain has to stop, the petition has to be sited somewhere that exists,
// and the generated text has to be as blind as the authored text is. A ripened
// petition that leaks its own truth still renders a perfectly good scene — it
// simply is not a judgement any more, and nothing about the screen says so.

const ladder = (reign?.escalation?.ripens_to ?? {}) as Record<string, string>
const authoredKinds = new Set((reign?.petitions ?? []).map((p) => p.kind))
if (!Object.keys(ladder).length) fail.push('escalation: no kind ladder is authored, so no grievance can ever ripen')
for (const [from, to] of Object.entries(ladder)) {
  if (!authoredKinds.has(from)) warn.push(`escalation: '${from}' ripens, but no authored petition is of that kind`)
  if (!to) fail.push(`escalation: '${from}' ripens into nothing`)
  // The ladder terminating is the whole safety argument for generating content
  // from a player's own ruling. A target that is itself a rung is a cycle, and
  // a cycle is an unbounded chain of model calls seeded by one decision.
  if (ladder[to]) fail.push(`escalation: '${from}' → '${to}' → '${ladder[to]}' — the ladder does not terminate`)
}
if (seasonLength(reign) < 1) fail.push('escalation: a season of no rulings would fire the grievance in the same breath as the ruling')

// Where a grievance comes back to stand. Sited in code rather than by the
// model precisely so this can be proved: at the ruling's own place, or one
// route from it, and never anywhere that is not on the map.
for (const petition of reign?.petitions ?? []) {
  const here = byId.get(petition.at)
  if (!here) continue
  const open = IRON_VERDICT_LOCATIONS.map((l) => l.id)
  for (const resolution of petition.resolutions ?? []) {
    const at = siteForGrievance(petition.at, IRON_VERDICT_LOCATIONS, open, resolution.id)
    if (!at || !byId.has(at)) {
      fail.push(`petition ${petition.id}: a grievance from ${resolution.id} would be sited at '${at}', which is not a place`)
    } else if (at !== petition.at && !here.routes.includes(at)) {
      fail.push(`petition ${petition.id}: a grievance from ${resolution.id} lands at ${at}, which is more than one route from ${petition.at}`)
    }
  }
}

// Malformed model output must be REFUSED, not repaired into half a petition.
// Every one of these degrades to the same thing: no petition is stored and the
// reign carries on with the authored sixteen.
const WELL_FORMED = {
  title: 'The Second Hedge',
  the_truth: 'The brook moved again and nobody has looked.',
  parties: [
    { name: 'Denny Ostler', claim: 'He was made to pay once and will not be made to pay twice.' },
    { name: 'Wenna Fell', claim: 'The ground is hers by the judge\'s own word.' },
  ],
  resolutions: [
    { label: 'Hold the line', consequence: 'It costs.', made_whole: 'Fell', made_to_pay: 'Ostler', principle: 'A ruling stands.' },
    { label: 'Reopen it', consequence: 'It costs more.', made_whole: 'Ostler', made_to_pay: 'the Ring', principle: 'A ruling may be re-read.' },
  ],
}
const MALFORMED: Record<string, unknown> = {
  'an empty response': {},
  'the schema echoed back': { type: 'object', properties: { title: { type: 'string' } } },
  'no truth behind it': { ...WELL_FORMED, the_truth: '   ' },
  'one party': { ...WELL_FORMED, parties: [WELL_FORMED.parties[0]] },
  'one way to rule': { ...WELL_FORMED, resolutions: [WELL_FORMED.resolutions[0]] },
  'a resolution that seeds nothing': {
    ...WELL_FORMED,
    resolutions: WELL_FORMED.resolutions.map((r) => ({ ...r, principle: '' })),
  },
}
for (const [what, payload] of Object.entries(MALFORMED)) {
  if (verifyRipenedPetition(payload)) fail.push(`ripening accepts ${what}, which would put an unjudgeable petition before the player`)
}
if (!verifyRipenedPetition(WELL_FORMED)) fail.push('ripening refuses a well-formed petition, so no grievance could ever return')

// The kind must actually escalate, and it must escalate to what the FILE says.
// The model is never asked for the kind; if it were, the ladder would be
// decoration.
const seedPetition = (reign?.petitions ?? []).find((p) => ripensTo(reign, p.kind))
if (!seedPetition) fail.push('no authored petition has a kind that ripens, so the mechanic is unreachable')
else {
  const seedResolution = seedPetition.resolutions[0]!
  const written = verifyRipenedPetition(WELL_FORMED)!
  const at = siteForGrievance(seedPetition.at, IRON_VERDICT_LOCATIONS, IRON_VERDICT_LOCATIONS.map((l) => l.id), seedResolution.id)!
  const ripened = composeRipenedPetition(written, {
    seed: { petition: seedPetition, resolution: seedResolution },
    ripensToKind: ripensTo(reign, seedPetition.kind)!,
    at,
    ripeAtLedgerLength: 1 + seasonLength(reign),
  })
  if (ripened.kind === seedPetition.kind) fail.push(`ripening ${seedPetition.id} returns the same kind, so nothing escalated`)
  if (ripened.kind !== ladder[seedPetition.kind]) fail.push(`ripening ${seedPetition.id} ignores the authored ladder`)
  // The end of the ladder is where the chain stops. If the harder kind could
  // itself ripen, one ruling would seed an unbounded run of model calls.
  if (ripensTo(reign, ripened.kind)) fail.push(`a ripened '${ripened.kind}' can ripen again — the chain does not terminate`)
  if (petitionIds.has(ripened.id)) fail.push(`ripened id ${ripened.id} collides with an authored petition`)
  if (ripened.resolutions.some((r, i) => ripened.resolutions.findIndex((o) => o.id === r.id) !== i)) {
    fail.push(`ripened ${ripened.id} has duplicate resolution ids, so a ruling would be ambiguous`)
  }

  // The same assertion the authored petitions get, on the REAL payload. A
  // generated petition goes through the same offer as an authored one for
  // exactly this reason — a second mapping is a second place to leak from.
  const ledgerLength = ripened.ripe_at_ledger_length
  const wire = JSON.stringify(
    progressionFor(world.progression, world.reign, IRON_VERDICT_LOCATIONS, {
      flags: { [PETITIONS_OPEN]: true },
      taken_choice_ids: [],
      revealed_location_ids: [],
      current_location_id: ripened.at,
      ledger: Array.from({ length: ledgerLength }, () => ({
        petition_id: 'ruled', resolution_id: 'r', at: ripened.at,
        made_whole: 'x', made_to_pay: 'y', principle: 'z', ruled_at: new Date(),
      })),
      ripened_petitions: [ripened],
    }).petitions,
  )
  if (!wire.includes(ripened.id)) fail.push(`ripened ${ripened.id} is not offered at ${ripened.at} once it is ripe`)
  if (wire.includes(ripened.the_truth.slice(0, 40))) fail.push(`ripened ${ripened.id}: the truth is sent to the client, which spoils it`)
  for (const resolution of ripened.resolutions) {
    if (wire.includes(resolution.consequence.slice(0, 20))) {
      fail.push(`ripened ${ripened.id}: ruling consequences are sent to the client, making it a menu with the answers on it`)
    }
  }

  // Not yet a season old. A grievance that arrives with the ruling reads as the
  // world arguing back rather than as consequence catching up.
  const early = progressionFor(world.progression, world.reign, IRON_VERDICT_LOCATIONS, {
    flags: { [PETITIONS_OPEN]: true },
    taken_choice_ids: [],
    revealed_location_ids: [],
    current_location_id: ripened.at,
    ledger: [],
    ripened_petitions: [ripened],
  }).petitions
  if (early.some((p) => p.id === ripened.id)) fail.push(`ripened ${ripened.id} is offered before its season has passed`)
}

// Degraded mode: generation unavailable. Nothing was stored, and the reign is
// exactly the authored one — no empty slot, no error, no missing petition.
const degraded = progressionFor(world.progression, world.reign, IRON_VERDICT_LOCATIONS, {
  flags: { [PETITIONS_OPEN]: true },
  taken_choice_ids: [],
  revealed_location_ids: [],
  current_location_id: (reign?.petitions ?? [])[0]?.at ?? IRON_VERDICT_START_LOCATION,
  ledger: [],
  ripened_petitions: [],
}).petitions
if (!degraded.length) fail.push('with no ripened petitions stored, the reign offers nothing at all')

console.log(
  `ripening: ${Object.keys(ladder).length} rungs, a season is ${seasonLength(reign)} rulings, ` +
  `${(reign?.petitions ?? []).filter((p) => ripensTo(reign, p.kind)).length}/${reign?.petitions?.length ?? 0} petitions seed one`,
)

// ── Cross-world binding ───────────────────────────────────────────────────
// Ownership is not the binding. An owned chat realm, or a save for a different
// map, named in this world's path would mint state / events / memories onto
// the wrong save. The rule lives in one place; state() and act() both have
// to go through it before any interactive write.

const asked = 'world-asked'
const player = 'player-own'
const ownSave = { player_id: player }
const boundHere = { interactive_world_key: asked }
const boundElsewhere = { interactive_world_key: 'world-other' }
const ordinaryRealm = { title: 'a chat realm' }
const blankKey = { interactive_world_key: '' }
const spacedKey = { interactive_world_key: '   ' }

if (reasonInstanceNotBoundToWorld(asked, ownSave, boundHere, player)) {
  fail.push('a save bound to the world in the URL is refused')
}

const mismatches: Array<[string, { player_id: unknown } | null, { interactive_world_key?: string; title?: string } | null]> = [
  ['another walkable world', ownSave, boundElsewhere],
  ['an ordinary realm', ownSave, ordinaryRealm],
  ['a template with an empty key', ownSave, blankKey],
  ['a template with a blank key', ownSave, spacedKey],
  ["someone else's save", { player_id: 'player-other' }, boundHere],
  ['a missing save', null, boundHere],
  ['a save whose template is gone', ownSave, null],
]

for (const [what, inst, tmpl] of mismatches) {
  let mutated = false
  try {
    assertInstanceBoundToWorld(asked, inst, tmpl, player)
    mutated = true
  } catch (err) {
    if (!(err instanceof HttpError) || err.statusCode !== 404 || err.message !== 'World instance not found') {
      fail.push(`a save for ${what} is not refused the way a missing save is`)
    }
  }
  if (mutated) fail.push(`interactive state would be written for ${what}`)
}

function between(src: string, from: string, to?: string): string {
  const start = src.indexOf(from)
  if (start < 0) return ''
  const end = to ? src.indexOf(to, start + from.length) : src.length
  return end < 0 ? src.slice(start) : src.slice(start, end)
}

const here = dirname(fileURLToPath(import.meta.url))
const worldServiceSrc = readFileSync(join(here, '../src/services/interactive-world.service.ts'), 'utf8')
const walkInstanceServiceSrc = readFileSync(join(here, '../src/services/interactive-world-instance.service.ts'), 'utf8')
const stateBody = between(worldServiceSrc, 'async state(', 'async act(')
const actBody = between(worldServiceSrc, 'async act(')
const requireBody = between(walkInstanceServiceSrc, 'async requireBound(', 'async create(')

if (!requireBody.includes('reasonWalkInstanceNotBound')) {
  fail.push('requireBound no longer uses the shared walk binding rule')
}
if (!stateBody.includes('requireBound')) {
  fail.push('state() no longer proves the instance is bound to the world in the URL')
} else {
  const bindAt = stateBody.indexOf('requireBound')
  const mutateAt = Math.min(
    ...['interactiveWorldStates', 'this.definition', 'updateOne'].map((needle) => {
      const at = stateBody.indexOf(needle)
      return at < 0 ? Infinity : at
    }),
  )
  if (bindAt > mutateAt) {
    fail.push('state() initialises interactive state before proving the instance belongs to this world')
  }
}
if (!actBody.includes('this.state(')) {
  fail.push('act() no longer goes through state(), so the binding guard can drift')
} else {
  const viaState = actBody.indexOf('this.state(')
  const writeAt = Math.min(
    ...['updateOne', 'insertOne'].map((needle) => {
      const at = actBody.indexOf(needle)
      return at < 0 ? Infinity : at
    }),
  )
  if (viaState > writeAt) {
    fail.push('act() writes before going through state(), so a mismatched save can mutate first')
  }
}
if (!actBody.includes('this.state(worldKey, instanceId, playerId, true)')) {
  fail.push('act() reads the rendered state, so narrated flags could be persisted as authored facts')
}
if (!stateBody.includes('forMutation ? state : worldStateView(state, flags, world.locations)')) {
  fail.push('state() no longer exposes effective flags and server-derived travel targets on the wire')
}
if (!actBody.includes('state: worldStateView(next, flags, world.locations)')) {
  fail.push('act() no longer returns effective flags and new travel targets after the turn')
}

console.log(`binding: ${mismatches.length} mismatched saves refused before a write`)

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
