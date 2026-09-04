import { narrationTemperature } from '../src/ai/narration-profile'
import { buildPrompt } from '../src/utils/prompt-builder'
import {
  detectRelationshipInitialization,
  relationshipBaseline,
  relationshipEvidenceBindsToCharacter,
  relationshipInitializationFromEvidence,
  relationshipStateFromEvidence,
} from '../src/utils/relationship-baseline'
import { templateCastDeltas } from '../src/services/template-cast.service'
import { mergeRelationshipFacts, relationshipStateFromFacts } from '../src/services/character-codex.service'
import { buildPlayerInteractionSignalRequest, candidateTargetsForPlayerInput } from '../worker/lib/player-interaction-signal'

let pass = 0
let fail = 0
function check(label: string, condition: boolean) {
  if (condition) pass++
  else { fail++; console.log(`FAIL ${label}`) }
}

const prompt = buildPrompt({
  seedPrompt: 'A contemporary story in Milan.',
  isSentient: false,
  worldState: {},
  activeFlags: {},
  globalLore: '',
  retrievedLore: [],
  retrievedMemories: [],
  sceneSummary: null,
  recentEvents: [],
  userMessage: '*I check into a hotel.*',
  userNarrationFacts: ['The protagonist checks into a hotel.'],
  maxTokens: 7000,
  proseOnly: true,
  narrationPov: 'first',
  chatMode: 'slow_burn',
  narrativeStyle: 'modern_casual',
  narrationTone: 'warm',
  messageLength: 'short',
  locationContext: 'Hotel — active location',
  characterCodex: [
    { canonical_name: 'Haise', is_protagonist: true },
    {
      canonical_name: 'Francesca',
      role: 'hotel receptionist',
      disposition_to_player: 'professional, but cautiously curious',
      relationship: { trust: 63, affection: 56, fear: 0, rivalry: 0 },
      relationship_moments: [
        { meter: 'trust', delta: 3, sequence: 12 },
        { meter: 'affection', delta: 2, sequence: 12 },
      ],
      relationship_state: {
        summary: 'Professional but increasingly curious after the player treated her with care.',
        evidence: 'treated her with care',
        tags: ['professional', 'curious'],
      },
    },
  ],
})
const finalSystem = prompt.messages.at(-2)?.content || ''
check('has final narrator contract', finalSystem.includes('FINAL NARRATOR CONTRACT'))
check('locks short shape', finalSystem.includes('exactly 1 compact paragraph, 2–4 sentences, about 40–100 words'))
check('locks first-person POV', finalSystem.includes('first person as Haise (I/me/my)'))
check('preserves tone', finalSystem.includes('Warm tone'))
check('preserves mode', finalSystem.includes('Slow Burn mode'))
check('bans player-turn echo', finalSystem.includes('never echo or paraphrase the player'))
check('locks canonical scene facts', finalSystem.includes('current location, scene presence, and relationship history'))
const systemContext = prompt.messages
  .filter((message) => message.role === 'system')
  .map((message) => message.content)
  .join('\n')
check('injects cumulative bond state', systemContext.includes('trust 63/100, affection 56/100, fear 0/100, rivalry 0/100'))
check('injects only bounded bond trajectory', systemContext.includes('trust +3 at turn 12; affection +2 at turn 12'))
check('keeps bond numbers out of story prose', systemContext.includes('never mention numbers in-story'))
check('injects nuanced bond context', systemContext.includes('Professional but increasingly curious after the player treated her with care.'))
const memoryPrompt = buildPrompt({
  seedPrompt: 'A contemporary story in Milan.',
  isSentient: false,
  worldState: {}, activeFlags: {}, globalLore: '', retrievedLore: [],
  retrievedMemories: ['Meet the steward at the yard at first light.'],
  sceneSummary: null, recentEvents: [], userMessage: '*I sit down.*',
  maxTokens: 7000, proseOnly: true,
})
const memoryContext = memoryPrompt.messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n')
check('retrieved memories are labeled as past facts', memoryContext.includes('PAST facts for continuity'))
check('retrieved memories must not be restaged', memoryContext.includes('never restage them as current events'))
const placeholderPrompt = buildPrompt({
  seedPrompt: 'A family drama.',
  isSentient: false,
  worldState: {}, activeFlags: {}, globalLore: '', retrievedLore: [], retrievedMemories: [],
  sceneSummary: null, recentEvents: [], userMessage: '[The player waits.]', maxTokens: 7000,
  proseOnly: true, narrationPov: 'third', characterCodex: [
    { canonical_name: 'Haise', is_protagonist: true, identity_kind: 'proper_name' },
    { canonical_name: 'Sister', identity_kind: 'kinship_label', role: 'twin sibling' },
    { canonical_name: 'The Mysterious Man', identity_kind: 'epithet' },
  ],
})
const placeholderContext = placeholderPrompt.messages
  .filter((message) => message.role === 'system').map((message) => message.content).join('\n')
check('uses persisted identity metadata for placeholder addressing', placeholderContext.includes('Sister is explicitly classified placeholder codex label'))
check('does not treat a fixed epithet as a placeholder', !placeholderContext.includes('The Mysterious Man is explicitly classified placeholder codex label'))
const signalPrompt = buildPrompt({
  seedPrompt: 'A family drama.', isSentient: false, worldState: {}, activeFlags: {}, globalLore: '',
  retrievedLore: [], retrievedMemories: [], sceneSummary: null, recentEvents: [],
  userMessage: 'Of course, Mother. You have always been so supportive.', maxTokens: 7000,
  proseOnly: true, currentInteractionSignals: [{
    source: 'player', target_character_id: 'mother-id', target_name: 'Mother', kind: 'pointed_deflection',
    evidence: 'You have always been so supportive', confidence: 0.72, expires_after_sequence: 2,
  }],
})
const signalContext = signalPrompt.messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n')
check('interaction signal is private behavioral continuity', signalContext.includes('PRIVATE INTERACTION CONTINUITY') && signalContext.includes('Mother: the player may have deflected pointedly'))
check('interaction signal tells narrator not to diagnose tone', signalContext.includes('Do not name the category, quote its evidence, diagnose the player'))
check('interaction gate accepts one explicit active target', candidateTargetsForPlayerInput('Mother, please listen.', [{ id: 'mother', name: 'Mother' }]).length === 1)
check('interaction gate abstains on ambiguous direct address', candidateTargetsForPlayerInput('Mother and Father, please listen.', [{ id: 'mother', name: 'Mother' }, { id: 'father', name: 'Father' }]).length === 2)
const interactionRequest = buildPlayerInteractionSignalRequest({
  playerInput: 'Mother, of course you have always been so supportive.', sequence: 9,
  candidates: [{ id: 'mother', name: 'Mother', behavioralContext: ['Disposition toward player: guarded after a tense exchange'] }],
  recentTurns: [{ sequence: 8, playerInput: 'I needed you to stand up for me.', narration: 'Mother refuses to take the player’s side.' }],
})
const interactionProbeText = interactionRequest?.messages.map((message) => message.content).join('\n') || ''
check('interaction sidecar receives target canon and immediate prior exchange', interactionProbeText.includes('guarded after a tense exchange') && interactionProbeText.includes('Mother refuses to take the player’s side'))
check('interaction sidecar explicitly requires pragmatic mismatch for sarcasm', interactionProbeText.includes('Irony/sarcasm requires a pragmatic mismatch'))
const deathPrompt = buildPrompt({
  seedPrompt: 'A gothic mystery.', isSentient: false, worldState: {}, activeFlags: {}, globalLore: '',
  retrievedLore: [], retrievedMemories: [], sceneSummary: null, recentEvents: [],
  userMessage: 'I visit the graveyard.', maxTokens: 7000, proseOnly: true,
  deceasedCharacterNames: ['Mara'],
})
const deathContext = deathPrompt.messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n')
check('deceased character receives a hard lifecycle prompt lock', deathContext.includes('Mara is deceased') && deathContext.includes('Do not portray this character alive, physically present, speaking, acting, selectable'))
check('llama profile is conservative', narrationTemperature('meta-llama/llama-3.1-8b-instruct') === 0.55)
check('cydonia profile preserves controlled variety', narrationTemperature('thedrummer/cydonia-24b-v4.1') === 0.62)
const closeFriend = relationshipInitializationFromEvidence(
  { kind: 'close_friend', evidence: 'my close friend' },
  'Haise says, "This is my close friend, Otto."',
)
check('accepts literal close-friend initialization', closeFriend?.kind === 'close_friend')
check('maps close friend to a meaningful profile', relationshipBaseline('close_friend').trust === 75 && relationshipBaseline('close_friend').affection === 60)
check('supports a distinct sworn-enemy profile', relationshipBaseline('sworn_enemy').rivalry === 90)
check('rejects ungrounded initialization evidence', relationshipInitializationFromEvidence(
  { kind: 'enemy', evidence: 'my sworn enemy' },
  'Otto enters the room.',
) === undefined)
check('accepts explicit neglect as a strained-family baseline', relationshipInitializationFromEvidence(
  { kind: 'family_strained', evidence: 'treats you like a stranger' },
  'Your father treats you like a stranger.',
)?.kind === 'family_strained')
check('accepts grounded open-ended bond context', relationshipStateFromEvidence(
  { summary: 'A resentful sibling who feels overshadowed by the player.', evidence: 'resentful sibling', tags: ['resentful', 'family'] },
  'The resentful sibling refuses to meet your eyes.',
)?.tags?.includes('resentful') === true)
check('requires relationship evidence to be locally bound to its character', relationshipEvidenceBindsToCharacter({
  name: 'Father',
  evidence: 'Father treats you like a stranger',
  sourceText: 'Father treats you like a stranger. Sister laughs from the hall.',
}) === true)
check('rejects a true quote belonging only to another character', relationshipEvidenceBindsToCharacter({
  name: 'Father',
  evidence: 'Sister laughs from the hall',
  sourceText: 'Father treats you like a stranger. Sister laughs from the hall.',
}) === false)
check('backfill detector ignores ambiguous strangers', detectRelationshipInitialization('A man waits by the window.') === undefined)
const templateDeltas = templateCastDeltas({
  protagonist: { name: 'Haise' },
  seed_cast: [{
    name: 'Otto',
    identity_kind: 'proper_name',
    relationship_initialization: { kind: 'close_friend', evidence: 'my close friend' },
    relationship_state: { summary: 'A loyal friend who worries about the player.', evidence: 'my close friend', tags: ['loyal'] },
  }],
})
check('template cast carries its starting bond into sequence-zero codex delta',
  templateDeltas[0]?.relationship_initialization?.kind === 'close_friend')
check('template cast carries open-ended bond context into sequence-zero codex delta',
  templateDeltas[0]?.relationship_state?.summary.startsWith('A loyal friend') === true)
check('template cast carries durable identity metadata into sequence-zero codex delta',
  templateDeltas[0]?.identity_kind === 'proper_name')
const bondFacts = mergeRelationshipFacts([], {
  name: 'Father',
  relationship_fact_additions: [
    { statement: 'He is emotionally distant from the player.', evidence: 'Father turns away.', tags: ['distant'] },
    { statement: 'He is privately guilty about past neglect.', evidence: 'Father admits he failed you.', tags: ['guilty'] },
  ],
}, 4)
const evolvedBondFacts = mergeRelationshipFacts(bondFacts, {
  name: 'Father',
  relationship_fact_retire: ['He is emotionally distant from the player.'],
}, 5)
check('bond journal preserves separate emotional truths', bondFacts.length === 2)
check('bond journal retires only the exact superseded truth',
  evolvedBondFacts.filter((fact) => fact.status === 'active').length === 1 &&
  relationshipStateFromFacts(evolvedBondFacts)?.summary.includes('privately guilty') === true)

console.log(`${fail === 0 ? 'ALL GREEN' : 'FAILURES'}: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
