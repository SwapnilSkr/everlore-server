/**
 * Two-phase travel: intent vs arrival vs owned-room leave.
 *
 * bun run scripts/travel-intent-audit.ts
 */
import { classifyPlayerTravel, decideTravelIntent, lastPlacesFromPresence, mergeSceneHistoryIntoPlaces, occupancyVenueAliases, viewpointOwnerName, type TravelIntentInput } from '../worker/lib/travel-intent'

let pass = 0
let fail = 0
function check(label: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++
  else {
    fail++
    console.log(`  FAIL ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`)
  }
}

const PLACES = [
  { name: 'the muddy yard', entityId: 'yard1', aliases: [] as string[] },
  { name: 'Stumbling Boar', entityId: 'inn1', aliases: [] as string[] },
  { name: 'hunting lodge', entityId: 'lodge1', aliases: [] as string[] },
  { name: "the steward's yard", entityId: 'syard1', aliases: [] as string[] },
  { name: 'Royal Council Chamber', entityId: 'council1', aliases: [] as string[] },
  { name: 'Falkreath', entityId: 'town1', aliases: [] as string[] },
]

const PEOPLE = [
  { name: 'Elara', aliases: [], placeName: 'Stumbling Boar', placeEntityId: 'inn1' },
  { name: 'Cedric', aliases: [], placeName: 'Royal Council Chamber', placeEntityId: 'council1' },
]

function decide(over: Partial<TravelIntentInput> & { playerInput: string }) {
  return decideTravelIntent({
    isContinuation: false,
    cursorName: 'the muddy yard',
    cursorEntityId: 'yard1',
    knownPlaces: PLACES,
    personPlaces: PEOPLE,
    pending: null,
    playerName: 'Aurelius Valemont',
    ...over,
  })
}

console.log('person last place from the scene they were in:')
{
  const presence = lastPlacesFromPresence(
    [{ name: 'Elara', aliases: [] }],
    [
      { locationName: 'Stumbling Boar', locationEntityId: 'inn1', present: ['Roland', 'Elara'] },
      { locationName: "steward's yard", present: [] },
    ],
  )
  check('Elara\'s last place is the tavern scene, not the empty yard', presence[0]?.placeEntityId, 'inn1')
}

console.log('intent is not arrival:')
{
  const t = decide({ playerInput: "*Let's head to the tavern in Falkreath.*" })
  check('let\'s stores pending, does not arrive', t.kind, 'intent')
  check('...and resolves to Elara\'s tavern when she is named later? unnamed let\'s still pending', t.pendingNext?.name != null, true)
}
{
  const t = decide({
    playerInput: '*the one where Elara works*',
    pending: { name: 'the tavern', aliases: ['tavern', 'the tavern'] },
  })
  check('where Elara works resolves to the Stumbling Boar', t.pendingNext?.entityId, 'inn1')
  check('...without moving', t.kind, 'intent')
}
{
  const t = decide({ playerInput: "*Let's head out for the inn.*" })
  check('let\'s head out stays intent without a local map edge', t.kind, 'intent')
}
{
  const t = decide({
    playerInput: '*I gather my things and prepare to leave for Falkreath.*',
    cursorName: 'Royal Council Chamber',
    cursorEntityId: 'council1',
  })
  check('prepare to leave does not arrive', t.kind === 'intent' || t.kind === 'none', true)
  check('...does not name a map move', t.kind === 'arrival', false)
}

console.log('arrival completes pending against namers holding:')
{
  const t = decide({
    playerInput: '*We return to the inn*',
    pending: {
      name: 'Stumbling Boar',
      entityId: 'inn1',
      aliases: ['the tavern', 'tavern', 'the inn', 'inn'],
    },
  })
  check('return to the inn arrives at the pending tavern', [t.kind, t.destination?.entityId], ['arrival', 'inn1'])
  check('...and clears pending', t.pendingNext, null)
}
{
  const t = decide({
    playerInput: '*We return to the inn*',
    knownPlaces: [
      { name: 'the muddy yard', entityId: 'yard1', aliases: [] },
      { name: 'the inn', entityId: 'inn1', aliases: [] },
    ],
    personPlaces: [],
  })
  check('unique known inn arrives without pending', [t.kind, t.destination?.entityId], ['arrival', 'inn1'])
}

console.log('false positives stay put:')
{
  const t = decide({
    playerInput: '*I reach the yard*',
    cursorName: 'hunting lodge',
    cursorEntityId: 'lodge1',
  })
  check('bare yard is not travel', t.kind, 'none')
}
{
  const t = decide({
    playerInput: '*I nod and leave*',
    cursorName: "the king's study",
    cursorEntityId: 'study1',
  })
  check('leave without a dest is not a destination', t.kind, 'none')
}
{
  const t = decide({
    playerInput: '*I nod and leave*',
    cursorName: "the king's study",
    cursorEntityId: 'study1',
    playerName: null,
  })
  check('leave without a dest is not a destination even when unnamed', t.kind, 'none')
}
{
  const t = decide({
    playerInput: '*We return to the inn*',
    knownPlaces: [
      { name: 'the muddy yard', entityId: 'yard1', aliases: [] },
      { name: 'Red Lion', entityId: 'inn1', aliases: ['the inn'] },
      { name: 'Stumbling Boar', entityId: 'inn2', aliases: ['the inn'] },
    ],
    personPlaces: [],
  })
  check('two inns with the same alias abstain', t.kind !== 'arrival', true)
}
{
  const t = decide({
    playerInput: "*Let's head out for the inn*",
    cursorName: "steward's yard",
    cursorEntityId: 'syard1',
    knownPlaces: mergeSceneHistoryIntoPlaces(
      [
        { name: "steward's yard", entityId: 'syard1', aliases: [] },
        { name: 'Red Lion', entityId: 'inn1', aliases: [] },
        { name: 'Stumbling Boar', entityId: 'inn2', aliases: [] },
      ],
      [
        { name: 'Red Lion', entityId: 'inn1', sequence: 10, playerInput: 'Does this tavern have spare rooms?' },
        { name: 'the Stumbling Boar', entityId: 'inn2', sequence: 16, playerInput: 'Does this tavern have spare rooms?' },
      ],
    ),
    personPlaces: [],
  })
  check('two occupied inns pick the more recently stayed', [t.kind, t.destination?.entityId], ['arrival', 'inn2'])
}
{
  const t = decide({
    playerInput: "*Let's head out for the inn*",
    cursorName: "steward's yard",
    cursorEntityId: 'syard1',
    knownPlaces: mergeSceneHistoryIntoPlaces(
      [
        { name: "steward's yard", entityId: 'syard1', aliases: [] },
        { name: 'Red Lion', entityId: 'inn1', aliases: [] },
        { name: 'Stumbling Boar', entityId: 'inn2', aliases: [] },
      ],
      [
        { name: 'Red Lion', entityId: 'inn1', sequence: 16, playerInput: 'Does this tavern have spare rooms?' },
        { name: 'the Stumbling Boar', entityId: 'inn2', sequence: 16, playerInput: 'Does this tavern have spare rooms?' },
      ],
    ),
    personPlaces: [],
  })
  check('two occupied inns with the same recency still abstain', t.kind !== 'arrival', true)
}
{
  const t = decide({
    playerInput: '',
    isContinuation: true,
    pending: { name: 'Stumbling Boar', entityId: 'inn1', aliases: ['the inn'] },
  })
  check('continue does not complete travel', t.kind, 'none')
  check('...and keeps pending', t.pendingNext?.entityId, 'inn1')
}
{
  const c = classifyPlayerTravel('I will meet you in the war room at dawn.')
  check('an appointment is not an arrival', c.kind !== 'arrival' && c.kind !== 'owned_leave', true)
}

console.log('owned-room leave:')
{
  const t = decide({
    playerInput: '*I leave for my room*',
    cursorName: 'Royal Council Chamber',
    cursorEntityId: 'council1',
  })
  check('leave for my room moves this turn', t.kind, 'owned_leave')
  check('...to a specific owned name', t.destination?.name, "Aurelius Valemont's room")
}
{
  const t = decide({
    playerInput: '*I leave for my room in order to be prepared*',
    cursorName: 'Royal Council Chamber',
    cursorEntityId: 'council1',
  })
  check('leave for my room in order to be prepared still moves', t.kind, 'owned_leave')
}
{
  const t = decide({
    playerInput: '*I go to my room*',
    cursorName: 'Royal Council Chamber',
    cursorEntityId: 'council1',
    knownPlaces: [
      ...PLACES,
      { name: "Aurelius Valemont's room", entityId: 'room1', aliases: ['my room'] },
    ],
  })
  check('return to an existing owned room reuses it', t.destination?.entityId, 'room1')
}
{
  const t = decide({
    playerInput: '*I leave for my room in order to be prepared*',
    cursorName: 'Royal Council Chamber',
    cursorEntityId: 'council1',
    playerName: null,
  })
  check('owned leave without a session name still moves', t.kind, 'owned_leave')
  check('...to the player-entity room, not a vague my-room node', t.destination?.name, "The Player's room")
  check('...and does not stay on the council', t.destination?.name === 'Royal Council Chamber', false)
}
{
  const t = decide({
    playerInput: '*I leave for my room*',
    cursorName: 'Royal Council Chamber',
    cursorEntityId: 'council1',
    playerName: null,
    knownPlaces: [
      ...PLACES,
      { name: "Aurelius Valemont's room", entityId: 'room1', aliases: ['my room'] },
    ],
  })
  check('unnamed owned leave reuses the room already aliased my room', t.destination?.entityId, 'room1')
}
{
  const t = decide({
    playerInput: '*I leave for my room*',
    cursorName: 'the hall',
    playerName: 'Aurelius Valemont',
    knownPlaces: [
      ...PLACES,
      { name: "The Player's room", entityId: 'roomP', aliases: ['my room'] },
    ],
  })
  check('a later named leave reuses the unnamed room instead of splitting', t.destination?.entityId, 'roomP')
}
{
  const t = decide({
    playerInput: '*I leave for my room*',
    cursorName: 'the hall',
    playerName: null,
    knownPlaces: [
      ...PLACES,
      { name: "Aurelius Valemont's room", entityId: 'room1', aliases: ['my room'] },
      { name: "Isolde's room", entityId: 'room2', aliases: ['my room'] },
    ],
  })
  check('two my-room aliases without an owner name stay put', t.kind, 'none')
}
{
  const t = decide({
    playerInput: '*I leave my room*',
    cursorName: "Aurelius Valemont's room",
    cursorEntityId: 'room1',
    knownPlaces: [
      ...PLACES,
      { name: "Aurelius Valemont's room", entityId: 'room1', aliases: ['my room'] },
    ],
  })
  check('leaving my room is not arriving at my room', t.kind !== 'owned_leave', true)
}

console.log('tavern-in-Falkreath is not the town:')
{
  const t = decide({
    playerInput: "*Let's head to the tavern in Falkreath. The one where Elara works.*",
  })
  check('Elara+tavern pending is the Boar, not the settlement', t.pendingNext?.entityId, 'inn1')
}

console.log('let\'s + locomotion + local known dest arrives now:')
{
  const localPlaces = [
    { name: 'the muddy yard', entityId: 'yard1', parentId: 'outpost1', aliases: [] as string[] },
    { name: 'Stumbling Boar', entityId: 'inn1', parentId: 'outpost1', aliases: ['the inn', 'the tavern'] },
    { name: 'the outpost', entityId: 'outpost1', parentId: null, placeKind: 'settlement', aliases: [] as string[] },
  ]
  const t = decide({
    playerInput: "*Let's head out for the inn.*",
    knownPlaces: localPlaces,
    pending: { name: 'Stumbling Boar', entityId: 'inn1', aliases: ['the inn', 'inn'] },
  })
  check('let\'s to a sibling inn arrives this turn', [t.kind, t.destination?.entityId], ['arrival', 'inn1'])
  check('...and does not leave pending', t.pendingNext, null)
}
{
  const t = decide({
    playerInput: "*Let's head to Falkreath.*",
    cursorName: 'Royal Council Chamber',
    cursorEntityId: 'council1',
    knownPlaces: [
      { name: 'Royal Council Chamber', entityId: 'council1', parentId: 'keep1', aliases: [] },
      { name: 'the keep', entityId: 'keep1', parentId: 'capital1', placeKind: 'building', aliases: [] },
      { name: 'the capital', entityId: 'capital1', parentId: null, placeKind: 'settlement', aliases: [] },
      { name: 'Falkreath', entityId: 'town1', parentId: null, placeKind: 'settlement', aliases: [] },
    ],
    personPlaces: [],
  })
  check('let\'s to a different settlement stays a journey', t.kind, 'intent')
  check('...pending the town, not arriving', t.pendingNext?.entityId, 'town1')
}
{
  const t = decide({
    playerInput: '*I will go to the inn at dawn.*',
    knownPlaces: [
      { name: 'the muddy yard', entityId: 'yard1', parentId: 'outpost1', aliases: [] },
      { name: 'Stumbling Boar', entityId: 'inn1', parentId: 'outpost1', aliases: ['the inn'] },
    ],
  })
  check('an appointment with will is still not an arrival', t.kind !== 'arrival', true)
}
{
  const t = decide({
    playerInput: "*Let's head out for the inn.*",
    knownPlaces: [
      { name: 'the muddy yard', entityId: 'yard1', parentId: 'inn1', aliases: [] },
      { name: 'Stumbling Boar', entityId: 'inn1', parentId: null, aliases: ['the inn'] },
    ],
    pending: { name: 'Stumbling Boar', entityId: 'inn1', aliases: ['the inn', 'inn'] },
  })
  check('let\'s back up the containment spine arrives', [t.kind, t.destination?.entityId], ['arrival', 'inn1'])
}
{
  const t = decide({
    playerInput: "*Let's head out for the inn.*",
    knownPlaces: [
      { name: 'the muddy yard', entityId: 'yard1', aliases: [] },
      { name: 'Stumbling Boar', aliases: [] },
    ],
    personPlaces: [],
    pending: { name: 'Stumbling Boar', aliases: ['where Elara works'] },
  })
  check('let\'s does not replace a resolved pending with a generic inn', t.pendingNext?.name, 'Stumbling Boar')
  check('...and still waits for arrival without a containment edge', t.kind, 'intent')
}
{
  const t = decide({
    playerInput: '*We return to the inn*',
    knownPlaces: [
      { name: 'the muddy yard', entityId: 'yard1', aliases: [] },
      { name: 'Stumbling Boar', aliases: [] },
    ],
    personPlaces: [],
    pending: { name: 'Stumbling Boar', aliases: ['the inn', 'inn', 'the tavern'] },
  })
  check('return completes that pending tavern, not a new generic inn', [t.kind, t.destination?.name], ['arrival', 'Stumbling Boar'])
}
{
  const t = decide({
    playerInput: '*the one where Elara works*',
    personPlaces: [],
  })
  check('Elara with no last place does not invent a tavern', t.pendingNext?.entityId == null, true)
}

console.log('finish travel: occupancy, pending, named arrival:')
{
  const t = decide({ playerInput: "*Let's stop at a bar...our men must be tired*" })
  check('let\'s stop at a bar is intent, not a move', t.kind, 'intent')
  check('...and names a venue pending', /bar|inn|tavern/.test(String(t.pendingNext?.name || '').toLocaleLowerCase()), true)
}
{
  const t = decide({
    playerInput: '*I follow Roland toward the Stumbling Boar.*',
    cursorName: 'the city streets',
    cursorEntityId: 'street1',
  })
  check('follow toward a named inn arrives this turn', [t.kind, t.destination?.entityId], ['arrival', 'inn1'])
}
{
  const t = decide({
    playerInput: '*I follow Roland toward the Stumbling Boar.*',
    cursorName: 'the city streets',
    knownPlaces: [{ name: 'the city streets', entityId: 'street1', aliases: [] }],
    personPlaces: [],
  })
  check('follow toward a named inn still arrives before the map has minted it', t.kind, 'arrival')
  check('...and does not mint a venue generic', t.destination?.name, 'the Stumbling Boar')
}
{
  const stayed = mergeSceneHistoryIntoPlaces(
    [{ name: 'steward\'s yard', entityId: 'syard1', aliases: [] }],
    [
      {
        name: 'the Stumbling Boar',
        entityId: 'inn1',
        sequence: 16,
        playerInput: 'Does this tavern have spare rooms?',
      },
      { name: "steward's yard", entityId: 'syard1', sequence: 20, playerInput: '*I head toward the steward\'s yard.*' },
    ],
  )
  const boar = stayed.find((place) => place.entityId === 'inn1')
  check('this-tavern occupancy aliases the stay, not the later yard', (boar?.aliases || []).some((alias) => /tavern|inn|bar/.test(alias.toLocaleLowerCase())), true)
  check('...and does not alias the steward\'s yard as an inn', (stayed.find((place) => place.entityId === 'syard1')?.aliases || []).length, 0)
  const t = decide({
    playerInput: '*We return to the inn*',
    cursorName: "steward's yard",
    cursorEntityId: 'syard1',
    knownPlaces: stayed,
    personPlaces: [],
  })
  check('return to the inn after occupying it arrives at that stay', [t.kind, t.destination?.entityId], ['arrival', 'inn1'])
}
{
  const stayed = mergeSceneHistoryIntoPlaces(
    PLACES,
    [
      {
        name: 'the Stumbling Boar',
        entityId: 'inn1',
        sequence: 16,
        playerInput: 'Does this tavern have spare rooms?',
      },
    ],
  )
  const t = decide({
    playerInput: 'I meant the tavern in Falkreath where we stayed....the one where Elara works...not the one you are implying',
    cursorName: "steward's yard",
    cursorEntityId: 'syard1',
    knownPlaces: stayed,
    personPlaces: [],
    pending: { name: 'the tavern', aliases: ['tavern', 'the tavern'] },
  })
  check('where-Elara with no Elara card still keeps/resolves the occupied tavern', t.kind, 'intent')
  check('...as the Boar, not an unresolved where-label', t.pendingNext?.entityId, 'inn1')
}
{
  const t = decide({
    playerInput: 'I meant the tavern where Elara works',
    pending: { name: 'the tavern', aliases: ['tavern', 'the tavern'] },
    personPlaces: [],
    knownPlaces: PLACES,
  })
  check('an unresolved where-label does not replace pending', t.pendingNext?.name, 'the tavern')
}
{
  check(
    'this tavern is occupancy, not a destination by itself',
    occupancyVenueAliases('Does this tavern have spare rooms?', 'the Stumbling Boar').length > 0,
    true,
  )
  check(
    '...and is refused on a vague yard',
    occupancyVenueAliases('Does this tavern have spare rooms?', 'the yard').length,
    0,
  )
}
{
  const t = decide({
    playerInput: "*Let's head out for the inn*",
    cursorName: "steward's yard",
    cursorEntityId: 'syard1',
    knownPlaces: mergeSceneHistoryIntoPlaces(PLACES, [
      {
        name: 'the Stumbling Boar',
        entityId: 'inn1',
        sequence: 16,
        playerInput: 'Does this tavern have spare rooms?',
      },
    ]),
    pending: { name: 'Stumbling Boar', entityId: 'inn1', aliases: ['the inn', 'inn'] },
  })
  check('let\'s to the occupied inn arrives at that stay', [t.kind, t.destination?.entityId], ['arrival', 'inn1'])
  check('...and does not leave pending', t.pendingNext, null)
}
{
  const t = decide({
    playerInput: '*We return to the inn*',
    cursorName: 'the Stumbling Boar',
    cursorEntityId: 'inn1',
    knownPlaces: mergeSceneHistoryIntoPlaces(PLACES, [
      {
        name: 'the Stumbling Boar',
        entityId: 'inn1',
        sequence: 16,
        playerInput: 'Does this tavern have spare rooms?',
      },
    ]),
    personPlaces: [],
  })
  check('return to the inn while already there stays put', t.kind, 'none')
}

console.log('viewpoint owner for my-room:')
{
  check(
    'GM uses the onboarded protagonist card',
    viewpointOwnerName({
      isSentient: false,
      protagonistCardName: 'Aurelius Valemont',
      personaName: 'Visitor',
      templateProtagonistName: 'Template Hero',
    }),
    'Aurelius Valemont',
  )
  check(
    'GM without a card uses the authored template name',
    viewpointOwnerName({
      isSentient: false,
      protagonistCardName: null,
      personaName: null,
      templateProtagonistName: 'Aurelius Valemont',
    }),
    'Aurelius Valemont',
  )
  check(
    'sentient uses the human persona, not the locked AI',
    viewpointOwnerName({
      isSentient: true,
      protagonistCardName: 'Isolde',
      personaName: 'Alice',
      templateProtagonistName: 'Isolde',
    }),
    'Alice',
  )
  check(
    'sentient without a persona stays unnamed',
    viewpointOwnerName({
      isSentient: true,
      protagonistCardName: 'Isolde',
      personaName: null,
      templateProtagonistName: 'Isolde',
    }),
    null,
  )
}

console.log(`\ntravel intent audit: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
