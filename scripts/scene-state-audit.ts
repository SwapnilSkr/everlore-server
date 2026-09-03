/**
 * Pure-function audit for the scene-state derivation (src/services/scene-state.service.ts).
 * No DB. Run: bun run audit:scene-state
 *
 * Every case here is a regression the live "Aurelius Valemont" playthrough
 * actually produced, plus the invariants that stop them recurring.
 */
import {
  deriveNextSceneState,
  renderSceneStateForPrompt,
} from '../src/services/scene-state.service'
import { hasSceneParticipationGrammar } from '../worker/lib/presence-gap-detector'
import type { SceneStateDoc } from '../src/models/scene-state.model'

let pass = 0
let fail = 0
function check(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) pass++
  else {
    fail++
    console.log(`  FAIL ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`)
  }
}

const scene = (
  cast: string[],
  physical: SceneStateDoc['physical'] = [],
  seq = 20,
): SceneStateDoc => ({
  as_of_sequence: seq,
  place: { name: 'council room' },
  cast: cast.map((name) => ({ name, since_sequence: seq, source: 'carried' as const })),
  physical,
  scene_broke: false,
})

const names = (s: SceneStateDoc) => s.cast.map((c) => c.name)

// ── CAST: carry-forward and departures ──────────────────────────────────────
console.log('cast carry-forward + departures:')
{
  const { state } = deriveNextSceneState({
    prior: scene(['Cedric']),
    sequence: 21,
    sceneBroke: false,
    place: { name: 'council room' },
    reportedPresent: [],
    departed: [],
    corroborated: new Set(),
  })
  check('a quiet character is carried, not dropped', names(state), ['Cedric'])
}
{
  const { state } = deriveNextSceneState({
    prior: scene(['Cedric']),
    sequence: 21,
    sceneBroke: false,
    place: { name: 'council room' },
    reportedPresent: [],
    departed: ['Cedric'],
    corroborated: new Set(['cedric']),
  })
  check('a narrated exit actually removes them', names(state), [])
}
{
  // seq 21 → 22 in the live run: Cedric left, then walked back in unannounced
  // and repeated a line he had already delivered four turns earlier.
  const { state } = deriveNextSceneState({
    prior: scene([]),
    sequence: 22,
    sceneBroke: false,
    place: { name: 'council room' },
    reportedPresent: [{ name: 'Cedric' }],
    departed: [],
    corroborated: new Set(),
  })
  check('someone who left cannot re-enter without corroboration', names(state), [])
}
{
  const { state } = deriveNextSceneState({
    prior: scene([]),
    sequence: 22,
    sceneBroke: false,
    place: { name: 'council room' },
    reportedPresent: [{ name: 'Cedric' }],
    departed: [],
    corroborated: new Set(['cedric']),
  })
  check('...but a corroborated return is admitted', names(state), ['Cedric'])
}

// ── CAST: the phantom-presence class ────────────────────────────────────────
console.log('phantom presence (the Isolde/Lyra class):')
{
  // The exact seq-25 failure: two CARDED characters left behind in the dining
  // hall nine turns earlier were reported present in the council room, admitted
  // without corroboration because they had codex cards, and then carried for
  // seven turns.
  const { state, contradictions } = deriveNextSceneState({
    prior: scene(['Cedric']),
    sequence: 25,
    sceneBroke: false,
    place: { name: 'council room' },
    reportedPresent: [{ name: 'Isolde' }, { name: 'Lyra' }],
    departed: ['Cedric'],
    corroborated: new Set(['cedric']),
  })
  check('uncorroborated carded characters are refused', names(state), [])
  check('...and the refusal is recorded', contradictions.length, 2)
  check('...as an uncorroborated arrival', contradictions[0]?.kind, 'uncorroborated_arrival')
}
{
  const { state } = deriveNextSceneState({
    prior: scene([]),
    sequence: 26,
    sceneBroke: true,
    place: { name: 'great hall' },
    reportedPresent: [{ name: 'Mara' }],
    departed: [],
    corroborated: new Set(),
    travelParty: ['Mara'],
  })
  check('a confirmed companion needs no corroboration', names(state), ['Mara'])
}
{
  const { state } = deriveNextSceneState({
    prior: scene(['Isolde', 'Lyra']),
    sequence: 17,
    sceneBroke: true,
    place: { name: 'council room' },
    reportedPresent: [],
    departed: [],
    corroborated: new Set(),
  })
  check('a scene break does not drag the old room along', names(state), [])
}
{
  // Live: Lyra / Isolde / Cedric were at the table. The player stepped into
  // the solar. Both extractors named only Aldric. A scene break must start
  // from who this passage shows, not from last turn's guest list.
  const { state } = deriveNextSceneState({
    prior: scene(['Lyra', 'Queen Isolde', 'Cedric']),
    sequence: 13,
    sceneBroke: true,
    place: { name: 'the solar' },
    reportedPresent: [{ name: 'King Aldric' }],
    departed: [],
    corroborated: new Set(['king aldric', 'aldric']),
  })
  check('a new room starts from who is actually there', names(state), ['King Aldric'])
}
{
  const { contradictions } = deriveNextSceneState({
    prior: scene(['Cedric']),
    sequence: 22,
    sceneBroke: false,
    place: { name: 'council room' },
    reportedPresent: [],
    departed: ['Isolde'],
    corroborated: new Set(),
  })
  check('a departure for an absent person is a contradiction', contradictions[0]?.kind, 'departure_of_absent')
}

// ── PHYSICAL: the collar class ──────────────────────────────────────────────
console.log('physical state (the collar class):')
const grip = {
  kind: 'restraint' as const,
  statement: 'Aurelius has Cedric by the collar against the wall',
  actors: ['Aurelius', 'Cedric'],
  since_sequence: 19,
}
{
  const { state } = deriveNextSceneState({
    prior: scene(['Cedric', 'Aurelius'], [grip]),
    sequence: 20,
    sceneBroke: false,
    place: { name: 'council room' },
    reportedPresent: [],
    departed: [],
    corroborated: new Set(),
  })
  check('an open grip persists while nothing ends it', state.physical.length, 1)
}
{
  // seq 21: the player released him. Before this, nothing closed the grip and
  // it was still being narrated on turn 24.
  const { state } = deriveNextSceneState({
    prior: scene(['Cedric', 'Aurelius'], [grip]),
    sequence: 21,
    sceneBroke: false,
    place: { name: 'council room' },
    reportedPresent: [],
    departed: [],
    corroborated: new Set(),
    physicalClosed: ['Aurelius has Cedric by the collar against the wall'],
  })
  check('an explicit release closes it', state.physical.length, 0)
}
{
  const { state } = deriveNextSceneState({
    prior: scene(['Cedric', 'Aurelius'], [grip]),
    sequence: 21,
    sceneBroke: false,
    place: { name: 'council room' },
    reportedPresent: [],
    departed: ['Cedric'],
    corroborated: new Set(['cedric']),
    physicalClosed: [],
  })
  check('a departing actor implicitly closes it', state.physical.length, 0)
}
{
  const { state } = deriveNextSceneState({
    prior: scene(['Cedric', 'Aurelius'], [grip]),
    sequence: 22,
    sceneBroke: true,
    place: { name: 'great hall' },
    reportedPresent: [],
    departed: [],
    corroborated: new Set(),
  })
  check('a scene break closes it', state.physical.length, 0)
}
{
  const { state, contradictions } = deriveNextSceneState({
    prior: scene(['Aurelius'], []),
    sequence: 23,
    sceneBroke: false,
    place: { name: 'council room' },
    reportedPresent: [],
    departed: [],
    corroborated: new Set(),
    physicalOpened: [
      { kind: 'restraint', statement: 'Aurelius grips Cedric', actors: ['Aurelius', 'Cedric'], since_sequence: 23 },
    ],
  })
  check('a fact naming an absent actor is refused', state.physical.length, 0)
  check('...and recorded', contradictions[0]?.kind, 'physical_actor_absent')
}

// ── PROMPT RENDERING ────────────────────────────────────────────────────────
console.log('prompt rendering:')
{
  const text = renderSceneStateForPrompt(scene(['Cedric'], [grip]))
  check('names who is here', text.includes('Cedric (since turn 20)'), true)
  check('forbids a second entrance', text.includes('Do not have them arrive'), true)
  check('states the ongoing physical fact', text.includes('by the collar'), true)
  check('closes the room', text.includes('Nobody else is present'), true)
}
{
  const text = renderSceneStateForPrompt(scene([]))
  check('an empty room says so', text.includes('alone in this space'), true)
}
check('no state renders nothing', renderSceneStateForPrompt(null), '')

// ── IDENTITY: title-insensitive keys ────────────────────────────────────────
// Found by a live playthrough, not by reasoning: the extractor returns the
// canonical "Crown Prince Doran" on one turn and the prose's bare "Doran" on
// the next, and a plain normalization put the same man in the room twice.
console.log('identity keys:')
{
  const { state } = deriveNextSceneState({
    prior: scene(['Crown Prince Doran']),
    sequence: 3,
    sceneBroke: false,
    place: { name: 'great hall' },
    reportedPresent: [{ name: 'Doran' }],
    departed: [],
    corroborated: new Set(['doran']),
  })
  check('a titled name and its bare form are one person', names(state), ['Crown Prince Doran'])
}
{
  const { state } = deriveNextSceneState({
    prior: scene(['Crown Prince Doran']),
    sequence: 3,
    sceneBroke: false,
    place: { name: 'great hall' },
    reportedPresent: [],
    departed: ['Doran'],
    corroborated: new Set(),
  })
  check('the bare form can depart the titled entry', names(state), [])
}
{
  const { state } = deriveNextSceneState({
    prior: scene(['the King']),
    sequence: 3,
    sceneBroke: false,
    place: { name: 'great hall' },
    reportedPresent: [],
    departed: [],
    corroborated: new Set(),
  })
  check('a purely titular label keeps its identity', names(state), ['the King'])
}

// ── PHYSICAL: the player is an actor but never a cast member ────────────────
// Found on the emulator, not in review: the witness correctly reported
// {actors: ["Aurelian Marek", "Crown Prince Doran"]} for a collar grab, and the
// fact was thrown away every single time because the player — who is deliberately
// never listed in their own scene — failed the "actors must be present" check.
console.log('player as physical actor:')
{
  const { state, contradictions } = deriveNextSceneState({
    prior: scene(['Crown Prince Doran']),
    sequence: 3,
    sceneBroke: false,
    place: { name: 'great hall' },
    reportedPresent: [],
    departed: [],
    corroborated: new Set(),
    protagonistNames: ['Aurelian Marek', 'aurelian', 'marek'],
    physicalOpened: [
      {
        kind: 'restraint',
        statement: 'Aurelian has Doran by the collar against the wall',
        actors: ['Aurelian Marek', 'Crown Prince Doran'],
        since_sequence: 3,
      },
    ],
  })
  check('a grip by the player is accepted', state.physical.length, 1)
  check('...with no contradiction', contradictions.length, 0)
}
{
  const { state } = deriveNextSceneState({
    prior: {
      ...scene(['Crown Prince Doran']),
      physical: [
        {
          kind: 'restraint',
          statement: 'Aurelian has Doran by the collar against the wall',
          actors: ['Aurelian Marek', 'Crown Prince Doran'],
          since_sequence: 3,
        },
      ],
    },
    sequence: 4,
    sceneBroke: false,
    place: { name: 'great hall' },
    reportedPresent: [],
    departed: [],
    corroborated: new Set(),
    protagonistNames: ['Aurelian Marek', 'aurelian', 'marek'],
  })
  check('and it survives into the next turn', state.physical.length, 1)
}

// ── PHYSICAL: postures supersede ────────────────────────────────────────────
// A live run left a man "settled into the chair across from Doran" while also
// pinned against a wall. The model opens postures readily and never closes
// them, so exclusivity has to be deterministic.
console.log('posture supersession:')
{
  const seated = {
    kind: 'posture' as const,
    statement: 'Doran is seated at the head of the table',
    actors: ['Crown Prince Doran'],
    since_sequence: 2,
  }
  const { state } = deriveNextSceneState({
    prior: { ...scene(['Crown Prince Doran']), physical: [seated] },
    sequence: 3,
    sceneBroke: false,
    place: { name: 'council room' },
    reportedPresent: [],
    departed: [],
    corroborated: new Set(),
    protagonistNames: ['Aurelian'],
    physicalOpened: [
      {
        kind: 'restraint',
        statement: 'Aurelian has Doran by the collar against the wall',
        actors: ['Aurelian', 'Crown Prince Doran'],
        since_sequence: 3,
      },
    ],
  })
  check('a restraint ends that person\'s posture', state.physical.map((f) => f.statement), [
    'Aurelian has Doran by the collar against the wall',
  ])
}
{
  const wrenSeated = {
    kind: 'posture' as const,
    statement: 'Wren is leaning back in her chair',
    actors: ['Princess Wren'],
    since_sequence: 2,
  }
  const { state } = deriveNextSceneState({
    prior: { ...scene(['Crown Prince Doran', 'Princess Wren']), physical: [wrenSeated] },
    sequence: 3,
    sceneBroke: false,
    place: { name: 'council room' },
    reportedPresent: [],
    departed: [],
    corroborated: new Set(),
    protagonistNames: ['Aurelian'],
    physicalOpened: [
      {
        kind: 'restraint',
        statement: 'Aurelian has Doran by the collar',
        actors: ['Aurelian', 'Crown Prince Doran'],
        since_sequence: 3,
      },
    ],
  })
  check('someone else\'s posture is untouched', state.physical.length, 2)
}

// ── ADMISSION: participation, not mention; and the authored opening ─────────
console.log('opening scene canon:')
{
  // The tighter admission gate (scene-participation grammar, not a bare name)
  // emptied the authored opening's room on turn one, because that opening is
  // hand-written canon with no present_characters of its own to inherit.
  const { state } = deriveNextSceneState({
    prior: null,
    sequence: 2,
    sceneBroke: false,
    place: { name: 'great hall' },
    reportedPresent: [{ name: 'Lord Ardren' }, { name: 'Bram Holt' }],
    departed: [],
    corroborated: new Set(),
    openingScene: true,
  })
  check('the authored opening furnishes its own room', names(state), ['Lord Ardren', 'Bram Holt'])
  check('...marked as opening cast', state.cast[0]?.source, 'opening')
}
{
  const { state } = deriveNextSceneState({
    prior: scene(['Bram Holt']),
    sequence: 9,
    sceneBroke: false,
    place: { name: 'great hall' },
    reportedPresent: [{ name: 'Lord Ardren' }],
    departed: [],
    corroborated: new Set(),
    openingScene: false,
  })
  check('but later turns still require justification', names(state), ['Bram Holt'])
}

// ── OPENING CAST, SEEDED FROM THE AUTHORED OPENING ─────────────────────────
// A live run had the narrator write the player's sister out of the hall she was
// standing in: the opening turn took its cast from the extractor's report, that
// one cheap pass omitted her, and the closed-set rule made it permanent while
// the prompt asserted "Nobody else is present". The opening prose is source
// canon, so the cast is read from it — under the SAME evidence bar, so someone
// the opening merely names in passing still does not get in.
{
  const authored =
    'The great hall is cold. Steward Halvard Renn stands at the ledger table with his hands folded. ' +
    'Your sister Neva leans against the hearth, still in riding leathers, and she will not look at you. ' +
    'Ilse Dorn is somewhere on the passes.'
  const admits = (canonical: string, surfaces: string[]) =>
    [canonical, ...surfaces].some((surface) => hasSceneParticipationGrammar(surface, authored))

  check('the opening admits a character it names in full', admits('Halvard Renn', ['Halvard']), true)
  check('...and one it names bare', admits('Neva Vale', ['Neva']), true)
  check('...but not one it only mentions as elsewhere', admits('Ilse Dorn', ['Ilse']), false)
}
{
  // The seeded opening cast reaches the derivation as reportedPresent, so the
  // room the author furnished is the room the narrator is told about.
  const { state } = deriveNextSceneState({
    prior: null,
    sequence: 2,
    sceneBroke: true,
    place: { name: 'the great hall' },
    reportedPresent: [{ name: 'Halvard Renn' }, { name: 'Neva Vale' }],
    departed: [],
    corroborated: new Set(),
    openingScene: true,
  })
  check('the authored opening cast stands in the room', names(state), ['Halvard Renn', 'Neva Vale'])
}

// ── A POSTURE DOES NOT TRAVEL ──────────────────────────────────────────────
// A companion stayed "swung up into her saddle" for six turns — through a ride,
// an arrival and a dismount — because supersession only fires when a NEW posture
// opens, and the model never closes one it stopped mentioning.
{
  const prior: SceneStateDoc = {
    as_of_sequence: 8,
    place: { name: 'low road' },
    cast: [{ name: 'Neva', since_sequence: 2, source: 'carried' }],
    physical: [
      { kind: 'posture', statement: 'Neva swings up into her saddle', actors: ['Neva'], since_sequence: 8 },
      { kind: 'held', statement: 'Neva carries the sealed writ', actors: ['Neva'], since_sequence: 8 },
    ],
    scene_broke: false,
  }
  const { state } = deriveNextSceneState({
    prior,
    sequence: 9,
    sceneBroke: false,
    place: { name: 'village square' },
    reportedPresent: [],
    departed: [],
    corroborated: new Set(),
  })
  check('a posture does not survive a change of place', state.physical.map((f) => f.statement), [
    'Neva carries the sealed writ',
  ])
}
{
  // ...but standing still keeps it. Only a real move ends a posture.
  const prior: SceneStateDoc = {
    as_of_sequence: 8,
    place: { name: 'low road' },
    cast: [{ name: 'Neva', since_sequence: 2, source: 'carried' }],
    physical: [{ kind: 'posture', statement: 'Neva sits her horse', actors: ['Neva'], since_sequence: 8 }],
    scene_broke: false,
  }
  const { state } = deriveNextSceneState({
    prior,
    sequence: 9,
    sceneBroke: false,
    place: { name: 'low road' },
    reportedPresent: [],
    departed: [],
    corroborated: new Set(),
  })
  check('...but staying put keeps it', state.physical.length, 1)
}

// A companion is present BY CANON. The travel party used to be only a
// justification for admitting someone the witness had ALREADY reported, so on
// the turn a scene broke and the witness returned an empty cast, the companion
// the player had just named vanished from the room she rode into.
{
  const { state } = deriveNextSceneState({
    prior: scene(['Mara']),
    sequence: 5,
    sceneBroke: true,
    place: { name: 'Marrow Ford' },
    reportedPresent: [],
    departed: [],
    corroborated: new Set(),
    travelParty: ['Mara'],
  })
  check('a companion survives a scene break the witness missed', names(state), ['Mara'])
  check('...as travel party', state.cast[0]?.source, 'travel_party')
}
{
  const { state } = deriveNextSceneState({
    prior: scene(['Mara']),
    sequence: 5,
    sceneBroke: true,
    place: { name: 'Marrow Ford' },
    reportedPresent: [],
    departed: ['Mara'],
    corroborated: new Set(),
    travelParty: ['Mara'],
  })
  check('...but a narrated departure still removes them', names(state), [])
}

// ── TRAVEL PRIVILEGE IS SCOPED TO THE BREAK ─────────────────────────────────
// Party membership was an unconditional bypass of the corroboration gate on
// every turn. A companion detected once was force-added into every subsequent
// scene, immune to what the prose said, until an explicit parting phrase fired.
{
  const { state, contradictions } = deriveNextSceneState({
    prior: scene(['Tomas']),
    sequence: 6,
    sceneBroke: false,
    place: { name: 'the hall' },
    reportedPresent: [{ name: 'Mara' }],
    departed: [],
    corroborated: new Set(),
    travelParty: ['Mara'],
  })
  check('a continuation does not force a companion in unproven', names(state), ['Tomas'])
  check('...it is recorded as uncorroborated', contradictions[0]?.kind, 'uncorroborated_arrival')
}
{
  const { state } = deriveNextSceneState({
    prior: scene(['Tomas', 'Mara']),
    sequence: 6,
    sceneBroke: false,
    place: { name: 'the hall' },
    reportedPresent: [],
    departed: [],
    corroborated: new Set(),
    travelParty: ['Mara'],
  })
  check('a companion already in the room still carries', names(state), ['Tomas', 'Mara'])
}
{
  const { state } = deriveNextSceneState({
    prior: scene(['Tomas']),
    sequence: 6,
    sceneBroke: false,
    place: { name: 'the hall' },
    reportedPresent: [{ name: 'Mara' }],
    departed: [],
    corroborated: new Set(['mara']),
    travelParty: ['Mara'],
  })
  check('a companion the prose shows acting is admitted like anyone else', names(state), ['Tomas', 'Mara'])
}

// ── THE EVIDENCE BAR MUST COVER ORDINARY ACTIONS ───────────────────────────
// The action-verb list was built from a few examples and missed most of them,
// so a brother who "gave a slow nod" and "lets out a low chuckle" was refused
// entry to his own scene for three straight turns while speaking in it — and
// the physical fact naming him was rejected as naming an absent actor.
{
  const acts = (name: string, prose: string) => hasSceneParticipationGrammar(name, prose)
  check('"gave a slow nod" is acting', acts('Tomas', 'Tomas gave a slow nod, his expression unreadable.'), true)
  check('"lets out a chuckle" is acting', acts('Tomas', 'Tomas lets out a low, humorless chuckle.'), true)
  check('"shrugs" is acting', acts('Mara', 'Mara shrugs and looks away.'), true)
  check('"waited by the door" is acting', acts('Bram', 'Bram waited by the door.'), true)
  // ...and the offstage cases the gate exists to reject stay rejected.
  check('a past reference is not presence', acts('Bram', 'the untouched rations Bram had noted a day ago.'), false)
  check('travelling elsewhere is not presence', acts('Mara', 'Mara went to the capital last spring.'), false)
  check('being talked about is not presence', acts('Halvard', 'They spoke of Halvard often.'), false)
  check('being reported elsewhere is not presence', acts('Ilse', 'Ilse is somewhere on the passes.'), false)
}

// TWO SURFACES, ONE SEAT.
//
// `sceneIdentityKey` strips honorifics, but only ones on a hardcoded global
// list, so "Harbourmaster Ollen" and "Ollen" keyed apart and both were admitted.
// The rendered cast then told the NARRATOR three people were in a room holding
// two, and the travel picker showed Ollen twice. The instance's own codex cards
// already knew they were one man.
{
  const cards = new Map([
    ['harbourmaster ollen', 'Ollen'],
    ['ollen', 'Ollen'],
  ])
  const derived = deriveNextSceneState({
    prior: null,
    sequence: 2,
    sceneBroke: true,
    place: { entity_id: null, name: 'The Counting House' },
    reportedPresent: [{ name: 'Harbourmaster Ollen' }, { name: 'Ollen' }, { name: 'Deshi' }],
    departed: [],
    corroborated: new Set(['harbourmaster ollen', 'ollen', 'deshi']),
    openingScene: true,
    resolveIdentity: (name: string) => cards.get(name.trim().toLowerCase()) || null,
  })
  check(
    'two surfaces of one card take one seat',
    derived.state.cast.map((m) => m.name).sort(),
    ['Deshi', 'Ollen'],
  )
  // …and without the resolver the old behaviour is unchanged, so this is an
  // added capability rather than a silent change to every other caller.
  const naive = deriveNextSceneState({
    prior: null,
    sequence: 2,
    sceneBroke: true,
    place: { entity_id: null, name: 'The Counting House' },
    reportedPresent: [{ name: 'Sela' }, { name: 'Bryn' }],
    departed: [],
    corroborated: new Set(['sela', 'bryn']),
    openingScene: true,
  })
  check('two different people keep two seats', naive.state.cast.length, 2)
}

console.log(`\nscene-state audit: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
