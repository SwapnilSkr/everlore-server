/** No-write replay of the real post-narration extraction fan-out. Edit only the
 * fixture. This script calls production extractors/builders and prints both raw
 * provider output (where the extractor exposes it) and validated would-be
 * projections. It never opens Mongo, Redis, BullMQ, or writes canon. */
import { callLLM } from '../src/ai'
import { extractSceneMetadata } from '../worker/lib/metadata-extractor'
import { extractCharacterCodexDeltas } from '../worker/lib/character-codex-extractor'
import { extractCharacterDeaths } from '../worker/lib/character-lifecycle-extractor'
import { extractPlayerInteractionSignals } from '../worker/lib/player-interaction-signal'
import { entityAdjudicationCandidates, adjudicateEntityCandidates } from '../worker/lib/entity-adjudicator'
import { adjudicateSceneEndpoint } from '../worker/lib/scene-endpoint-adjudicator'
import { buildMemoryCurationRequest } from '../worker/processors/memory.processor'
import { auditChoices } from '../worker/lib/choice-grounding-audit'
import { sanitizeChoices } from '../worker/lib/structured-output'

const model = process.env.NSFW_EXTRACTION_PROBE_MODEL || 'gpt-4o-mini'

// ── EDITABLE FIXTURE ──────────────────────────────────────────────────────
const WORLD_CONTEXT = 'A contemporary adult relationship drama. Supernatural resurrection, ghosts, and undeath are not established.'
const CURRENT_LOCATION = "Mara's apartment bedroom"
const PRIOR_PRESENT = ['Mara', 'Mother']
const RECENT_TURNS = [{ sequence: 14, playerInput: 'Mother, I needed you to stand up for me.', narration: "Mother turns away and says she has no intention of taking the player's side." }]
const CAST = [
  { id: 'mara-001', name: 'Mara', aliases: ['Ms. Vale'], role: 'gallery owner', disposition: 'cautiously affectionate toward the player' },
  { id: 'elena-001', name: 'Elena', aliases: ['Lena'], role: "Mara's sister", disposition: 'protective of Mara and distrustful of the player' },
  { id: 'mother-001', name: 'Mother', aliases: [], role: "the player's mother", disposition: 'guarded after a tense exchange with the player' },
]
const PLAYER_INPUT = 'Mother, of course you have always been so supportive.'
const INTERACTION_TARGET_ID = 'mother-001'
/** Fixture equivalent of the pre-turn kinship graph labels, if any. */
const GRAPH_RELATION_LABELS: string[] = []
const NARRATION_PROSE = `
Mother fucks Mara so hard that she moans loudly.
`
// ──────────────────────────────────────────────────────────────────────────

const prose = NARRATION_PROSE.trim()
if (!prose || prose === 'PASTE YOUR TEST NARRATION HERE.') throw new Error('Paste NARRATION_PROSE first; no request was sent.')
const raw = new Map<string, string>()
const record = (stage: string) => (text: string) => raw.set(stage, text)
const roster = CAST.map((c) => ({ canonical_name: c.name, aliases: c.aliases, role: c.role, disposition_to_player: c.disposition, mutable_state: [], immutable_facts: [] }))
const target = CAST.find((c) => c.id === INTERACTION_TARGET_ID)
if (!target || !PRIOR_PRESENT.includes(target.name)) throw new Error('INTERACTION_TARGET_ID must name a character in PRIOR_PRESENT.')

console.log(JSON.stringify({ probe: 'production-extraction-replay', model, writes: false, narrationCharacters: prose.length }, null, 2))

// This mirrors the real post-stream fan-out. Calls that production runs in
// parallel run in parallel here too; the only difference is persistence/queues.
const unfamiliar = entityAdjudicationCandidates({ prose, knownNames: CAST.flatMap((c) => [c.name, ...c.aliases]), exclude: [] })
const [metadata, codex, deaths, interaction, entityJudgement, endpoint] = await Promise.all([
  extractSceneMetadata(prose, [], [], {
    currentLocationName: CURRENT_LOCATION, priorPresent: PRIOR_PRESENT,
    roster: CAST.map((c) => ({ name: c.name, aliases: c.aliases })), worldContext: WORLD_CONTEXT,
    playerInput: PLAYER_INPUT, protagonist: { name: 'Player', aliases: [] }, isSentient: false,
    onRaw: (stage, value) => raw.set(stage, value),
  }),
  extractCharacterCodexDeltas({ playerInput: PLAYER_INPUT, aiResponse: prose, existing: roster, presentCast: PRIOR_PRESENT, knownLocations: [], onRaw: record('character_codex') }),
  extractCharacterDeaths({ prose, candidates: roster, sequence: RECENT_TURNS.at(-1)!.sequence + 1, onRaw: record('character_death') }),
  extractPlayerInteractionSignals({
    playerInput: PLAYER_INPUT, sequence: RECENT_TURNS.at(-1)!.sequence + 1, recentTurns: RECENT_TURNS,
    candidates: [{ id: target.id, name: target.name, aliases: target.aliases, behavioralContext: [`Disposition toward player: ${target.disposition}`] }],
    onRaw: record('interaction_signal'),
  }),
  adjudicateEntityCandidates({ prose, candidates: unfamiliar, knownCast: CAST.map((c) => c.name), knownPlaces: [], worldContext: WORLD_CONTEXT, onRaw: record('entity_adjudication') }),
  adjudicateSceneEndpoint({
    prose, playerInput: PLAYER_INPUT,
    candidates: [...PRIOR_PRESENT, ...CAST.map((c) => c.name), ...unfamiliar.map((c) => c.display)],
    onRaw: record('scene_endpoint'),
  }),
])

// Memory runs asynchronously from the event outbox in production. This invokes
// its exact shared request builder, but intentionally stops before DB writes.
const memoryRequest = buildMemoryCurationRequest({
  sceneTag: metadata.scene_tag, roster, isSentient: false, playerInput: PLAYER_INPUT,
  playerSpokenInput: PLAYER_INPUT, playerNarrationFacts: [], aiResponse: prose,
  precedingAiResponse: RECENT_TURNS.at(-1)?.narration || null,
})
let memory: unknown = null
try { const response = await callLLM({ ...memoryRequest, model }); raw.set('memory_curation', response); memory = JSON.parse(response) } catch (error) { memory = { error: (error as Error).message } }

// Exact final metadata-choice backstop used by generation.processor. Narrator
// choice-tail routing is absent because this fixture starts after narration.
const castVocab = CAST.flatMap((c) => [c.name, c.role, ...c.aliases])
const choiceAudit = auditChoices(sanitizeChoices(metadata.choices || []), castVocab, prose, GRAPH_RELATION_LABELS, WORLD_CONTEXT, {
  protagonist: { name: 'Player', aliases: [] }, isSentient: false, currentLocationName: CURRENT_LOCATION,
})

for (const [stage, value] of raw) console.log(`\n=== RAW ${stage.toUpperCase()} ===\n${value}`)
console.log('\n=== VALIDATED / WOULD-BE PROJECTIONS (NO WRITES) ===')
console.log(JSON.stringify({ metadata, choiceAudit, finalPublishedChoices: choiceAudit.choices, entityJudgement, endpointAdjudication: endpoint, codexDeltas: codex, lifecycleDeltas: deaths, interactionSignals: interaction, memoryExtraction: memory }, null, 2))
