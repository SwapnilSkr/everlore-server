import type { ObjectId } from 'mongodb'
import { mongoColl } from '../config/mongo'
import { normalizeEntityName } from './entity-graph.service'
import type {
  PhysicalFact,
  SceneCastMember,
  SceneContradiction,
  SceneStateDoc,
} from '../models/scene-state.model'

/**
 * The single writer for scene state.
 *
 * Two rules do all the work here, and both are the opposite of how presence
 * used to be handled:
 *
 *  1. The cast is a CLOSED set changed only by explicit, justified transitions.
 *     Previously any name the extractor emitted was folded in, and a name that
 *     belonged to an existing codex card skipped the corroboration check that
 *     unknown names had to pass — so a cheap model could put two characters in
 *     a room they had never entered, and carry-forward made it permanent.
 *
 *  2. Every physical fact is opened AND closed by a story event. Nothing here
 *     expires by falling off a cap, because "the buffer filled up" is not a
 *     reason for a man to let go of someone's collar.
 */

/** Honorifics and kin words that are not distinctive enough to identify anyone.
 *  Shared with the presence corroboration gate in the generation processor. */
export const PRESENCE_TITLE_WORDS = new Set([
  'the', 'lord', 'lady', 'king', 'queen', 'prince', 'princess', 'crown', 'duke', 'duchess',
  'baron', 'baroness', 'earl', 'count', 'countess', 'ser', 'sir', 'madam', 'madame', 'mister',
  'master', 'mistress', 'captain', 'commander', 'general', 'sergeant', 'doctor', 'father',
  'mother', 'brother', 'sister', 'son', 'daughter', 'uncle', 'aunt', 'cousin', 'high', 'grand',
  'saint', 'elder', 'chief', 'officer', 'agent', 'professor', 'reverend',
])

/**
 * Identity key for scene membership.
 *
 * Titles are stripped, because the extractor reports the CANONICAL "Crown
 * Prince Doran" on one turn and the prose's bare "Doran" on the next — and a
 * plain normalization makes those two different people, so the same man stands
 * in the room twice and neither copy can be departed by naming the other. The
 * codex alias registry cannot fix this on its own: a seeded card's aliases
 * often contain only its own full name.
 */
export function sceneIdentityKey(name: string): string {
  const normalized = normalizeEntityName(String(name || ''))
  if (!normalized) return ''
  const distinctive = normalized
    .split(' ')
    .filter((token) => token.length >= 3 && !PRESENCE_TITLE_WORDS.has(token))
  // A purely titular label ("the king") keeps its full form — stripping it
  // would erase the only identity it has.
  return distinctive.length > 0 ? distinctive.join(' ') : normalized
}

const key = sceneIdentityKey

/** True when a label is a bare honorific with no identity of its own ("Prince",
 *  "Captain"). The prose uses these as shorthand for someone already in the
 *  room; admitting one mints a second, nameless copy of that person. */
function isBareTitle(name: string): boolean {
  const normalized = normalizeEntityName(String(name || ''))
  if (!normalized) return true
  return normalized.split(' ').every((token) => PRESENCE_TITLE_WORDS.has(token))
}

/** Scene state as of the newest main-story turn. Reading it from the event
 *  ledger (rather than a mutable per-instance doc) is what makes rewind free:
 *  delete the turns and the previous snapshot is current again. */
export async function loadCurrentSceneState(
  instanceId: ObjectId,
): Promise<SceneStateDoc | null> {
  const tail = (await mongoColl
    .events()
    .find(
      { instance_id: instanceId, type: { $ne: 'side_chat' } },
      {
        projection: {
          'data.scene_state': 1,
          'data.present_characters': 1,
          'data.ai_response': 1,
          location_anchor: 1,
          sequence: 1,
        },
      },
    )
    .sort({ sequence: -1 })
    .limit(2)
    .toArray()) as any[]
  const latest = tail[0]
  if (!latest) return null
  const stored = latest.data?.scene_state as SceneStateDoc | undefined
  if (stored) return stored

  // BOOTSTRAP for a session that predates scene state. Seed the cast from the
  // last turn's presence rather than starting empty — an empty prior cast would
  // make every existing character a newcomer needing corroboration, and a quiet
  // one would silently drop out for a turn. Physical state starts empty because
  // there is no record of it anywhere; the first grip after this establishes it.
  const reported = Array.isArray(latest.data?.present_characters)
    ? (latest.data.present_characters as unknown[]).filter(
        (n): n is string => typeof n === 'string' && n.trim().length > 0,
      )
    : []

  // One-time cleanup at the migration boundary. A legacy presence list can carry
  // people who were never in the room — that is the bug this whole system exists
  // to stop — and seeding it verbatim would preserve those phantoms forever,
  // since carry-forward never questions an established cast member. With no
  // scene state to inherit, the only evidence available is the prose, so admit
  // the ones the recent narration actually names. A genuinely quiet character
  // drops for a single turn and returns the moment the story mentions them.
  const recentProse = ` ${tail
    .map((event) => String(event?.data?.ai_response || ''))
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]+/g, ' ')
    .replace(/\s+/g, ' ')} `
  const carried = recentProse.trim().length > 1
    ? reported.filter((name) => {
        const normalized = normalizeEntityName(name)
        if (!normalized) return false
        if (recentProse.includes(` ${normalized} `)) return true
        return normalized
          .split(' ')
          .some(
            (token) =>
              token.length >= 3 &&
              !PRESENCE_TITLE_WORDS.has(token) &&
              (recentProse.includes(` ${token} `) || recentProse.includes(` ${token}'s `)),
          )
      })
    : reported

  const sequence = Number(latest.sequence) || 0
  const anchor = latest.location_anchor
  return {
    as_of_sequence: sequence,
    place: anchor ? { entity_id: anchor.entity_id ?? null, name: anchor.name || '' } : null,
    cast: carried.map((name) => ({
      name,
      since_sequence: sequence,
      source: 'carried' as const,
    })),
    physical: [],
    scene_broke: false,
  }
}

/**
 * Fold one turn's signals into the previous scene state.
 *
 * `corroborated` is the set of names this turn's PROSE independently shows
 * doing something person-shaped. It is the gate for admitting anyone new, and
 * it applies to carded and uncarded people alike — that symmetry is the fix for
 * phantom presence.
 */
export function deriveNextSceneState(params: {
  prior: SceneStateDoc | null
  sequence: number
  sceneBroke: boolean
  place: { entity_id?: ObjectId | null; name: string } | null
  /** Everyone the extractor reports as visible in this passage. */
  reportedPresent: Array<{ name: string; entityId?: ObjectId | null }>
  /** People the extractor reports as having left this passage. */
  departed: string[]
  /** Names the prose independently corroborates as acting/speaking this turn. */
  corroborated: Set<string>
  /** Confirmed travelling companions — present by canon, no corroboration needed. */
  travelParty?: string[]
  /** Physical facts the extractor opened this turn. */
  physicalOpened?: PhysicalFact[]
  /** Statements the extractor says ended this turn. */
  physicalClosed?: string[]
  /** True on the first generated turn, when the only prior scene is the AUTHORED
   *  opening. That opening is source canon, not model output, and it has no
   *  `present_characters` of its own — so requiring newcomers to earn their way
   *  in would empty a room the author explicitly furnished. */
  openingScene?: boolean
  /** Names the PLAYER answers to. The player is never a member of their own
   *  scene cast, but they are the most common actor in a physical fact — a grip
   *  is almost always theirs. Without this the cast check rejects every fact the
   *  player is party to, which is very nearly all of them. */
  protagonistNames?: string[]
}): { state: SceneStateDoc; contradictions: SceneContradiction[] } {
  const {
    prior,
    sequence,
    sceneBroke,
    place,
    reportedPresent,
    departed,
    corroborated,
    travelParty = [],
    physicalOpened = [],
    physicalClosed = [],
    protagonistNames = [],
    openingScene = false,
  } = params

  const contradictions: SceneContradiction[] = []
  const priorCast = sceneBroke ? [] : prior?.cast || []
  const priorByKey = new Map(priorCast.map((m) => [key(m.name), m]))
  const departedKeys = new Set(departed.map(key).filter(Boolean))
  const travelKeys = new Set(travelParty.map(key).filter(Boolean))

  // A departure for someone who was never here is a claim about a fiction the
  // system does not share. Record it rather than acting on it.
  for (const name of departed) {
    const k = key(name)
    if (k && !priorByKey.has(k) && !sceneBroke) {
      contradictions.push({
        kind: 'departure_of_absent',
        details: `"${name}" left a scene they were not in`,
      })
    }
  }

  const cast: SceneCastMember[] = []
  const seen = new Set<string>()

  // 1. Carry everyone who was here and did not leave. Continuity is the default
  //    so a quiet character does not flicker out just because a passage didn't
  //    name them — that was always the right instinct, it just had no owner.
  for (const member of priorCast) {
    const k = key(member.name)
    if (!k || seen.has(k) || departedKeys.has(k)) continue
    seen.add(k)
    cast.push({ ...member, source: 'carried' })
  }

  // 2. Admit newcomers ONLY with justification. A travelling companion arrives
  //    by canon; anyone else needs the prose to show them acting here.
  for (const person of reportedPresent) {
    const k = key(person.name)
    if (!k || seen.has(k)) continue
    if (departedKeys.has(k)) continue
    // A bare honorific is not a person. It is how the prose refers to someone
    // who is already here, so admitting it duplicates them under a second name.
    if (isBareTitle(person.name)) continue
    const justified = openingScene || travelKeys.has(k) || corroborated.has(k)
    if (!justified) {
      contradictions.push({
        kind: 'uncorroborated_arrival',
        details: `"${person.name}" reported present with no supporting action in the prose`,
      })
      continue
    }
    seen.add(k)
    cast.push({
      entity_id: person.entityId ?? null,
      name: person.name,
      since_sequence: sequence,
      source: travelKeys.has(k) ? 'travel_party' : openingScene ? 'opening' : sceneBroke ? 'opening' : 'arrival',
    })
  }

  // 2b. A confirmed travelling companion is present BY CANON, so they must be
  //     admitted even when this turn's witness forgot to list them. The travel
  //     party was previously only a JUSTIFICATION for admitting someone the
  //     witness had already reported — which meant it did nothing at all on the
  //     turn it matters most. On a live run the player wrote "Neva and I ride
  //     down the low road to Marrow Ford", the scene broke on arrival, the
  //     witness returned an empty cast, and the companion the player had just
  //     named vanished from the room she had ridden into.
  for (const name of travelParty) {
    const k = key(name)
    if (!k || seen.has(k) || departedKeys.has(k)) continue
    if (isBareTitle(name)) continue
    if (cast.length >= 12) break
    seen.add(k)
    cast.push({ entity_id: null, name, since_sequence: sequence, source: 'travel_party' })
  }

  // 3. Physical facts. Close what ended, then drop anything whose actor is no
  //    longer in the room — you cannot hold someone who has walked out, and
  //    that implicit close is what the old string list could never express.
  const closedKeys = new Set(physicalClosed.map((s) => key(s)).filter(Boolean))
  const castKeys = new Set(cast.map((m) => key(m.name)))
  // The player is always in their own scene even though they are never listed
  // in it, so they count as a valid actor.
  const actorKeys = new Set([...castKeys, ...protagonistNames.map(key).filter(Boolean)])
  // A POSTURE is struck in a place and does not survive leaving it. A restraint,
  // a held object or sustained contact can cross a threshold — you can keep hold
  // of someone's arm while walking out, or carry a drawn blade down a road — but
  // "seated at the head of the table" and "swings up into her saddle" mean nothing
  // once the viewpoint is somewhere else.
  //
  // Without this, a posture that the narration simply STOPS mentioning never ends:
  // supersession only fires when a new posture is opened for the same actor, and
  // the model reliably opens one and never thinks to close it. On a live run a
  // companion stayed "swung up into her saddle" for six turns, through a ride, an
  // arrival and a dismount, while the prose had her standing beside the horse —
  // and the narrator was told she was mounted on every one of those turns.
  const priorPlaceKey = key(prior?.place?.name || '')
  const nextPlaceKey = key(place?.name || '')
  const placeChanged = !!priorPlaceKey && !!nextPlaceKey && priorPlaceKey !== nextPlaceKey

  const physical: PhysicalFact[] = []
  for (const fact of prior?.physical || []) {
    if (sceneBroke) continue
    if (placeChanged && fact.kind === 'posture') continue
    const factKey = key(fact.statement)
    const explicitlyClosed = [...closedKeys].some(
      (c) => factKey === c || factKey.includes(c) || c.includes(factKey),
    )
    if (explicitlyClosed) continue
    const actorsPresent = fact.actors.every((a) => actorKeys.has(key(a)))
    if (!actorsPresent) continue
    physical.push(fact)
  }
  // A body can only be in one position at a time. The model reliably opens a new
  // posture ("settles into the chair") and never thinks to close it, so a live
  // run had a man seated at the table and pinned against a wall in the same
  // breath. Superseding is deterministic and needs no model judgement: a new
  // posture or restraint involving someone ends whatever posture they held.
  for (const opened of physicalOpened) {
    if (opened.kind !== 'posture' && opened.kind !== 'restraint') continue
    const openedActors = new Set(opened.actors.map(key))
    for (let i = physical.length - 1; i >= 0; i--) {
      const existing = physical[i]
      if (existing.kind !== 'posture') continue
      if (key(existing.statement) === key(opened.statement)) continue
      if (existing.actors.some((a) => openedActors.has(key(a)))) physical.splice(i, 1)
    }
  }

  for (const fact of physicalOpened) {
    const absent = fact.actors.filter((a) => !actorKeys.has(key(a)))
    if (absent.length > 0) {
      contradictions.push({
        kind: 'physical_actor_absent',
        details: `"${fact.statement}" names ${absent.join(', ')}, not in the scene`,
      })
      continue
    }
    const factKey = key(fact.statement)
    if (physical.some((f) => key(f.statement) === factKey)) continue
    physical.push({ ...fact, since_sequence: sequence })
  }

  return {
    state: {
      as_of_sequence: sequence,
      place,
      cast: cast.slice(0, 12),
      physical: physical.slice(0, 8),
      scene_broke: sceneBroke,
    },
    contradictions,
  }
}

/**
 * Render scene state for the narrator.
 *
 * This is the half of the loop that never existed. Presence was computed,
 * stored, and shipped to the app's UI — and deliberately withheld from the
 * model writing the prose, while the extractor that READ the prose was told it.
 * The writer had no idea who was in the room; the reader did. Stating the room
 * positively is what makes a second entrance a contradiction instead of a
 * plausible next sentence.
 */
export function renderSceneStateForPrompt(state: SceneStateDoc | null): string {
  if (!state) return ''
  const lines: string[] = []
  if (state.cast.length > 0) {
    lines.push(
      `- Physically here with the player right now: ${state.cast
        .map((m) => `${m.name} (since turn ${m.since_sequence})`)
        .join(', ')}.`,
    )
    lines.push(
      `- These people are ALREADY in this space. Do not have them arrive, enter, walk in, appear in the doorway, or be announced again — they are already here.`,
    )
  } else {
    lines.push(`- The player is alone in this space. Anyone else must arrive on-screen to be here.`)
  }
  lines.push(
    `- Nobody else is present. A character not listed above is elsewhere; bringing one into this scene requires narrating their arrival.`,
  )
  for (const fact of state.physical) {
    lines.push(`- Ongoing physical state (still true unless this turn ends it): ${fact.statement}.`)
  }
  return lines.join('\n')
}
