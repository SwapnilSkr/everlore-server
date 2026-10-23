/** Read-only, paid comparison. Written for the orchestrator; never run by audits.
 * bun --no-env-file run scripts/projection-batch-ab.ts --save ID --from 10 --to 14 --max-usd 0.10
 * Credentials must already be in the process environment. No dotenv or index setup.
 * --baseline-json may supply an Extended JSON card array EXACTLY before --from
 * when old saves have neither usable checkpoints nor reconstructible seed data.
 */
import { MongoClient, ObjectId, BSON } from 'mongodb'
import { readFile } from 'node:fs/promises'
import { callLLM, AI_MODELS } from '../src/ai'
import { foldDelta, newFoldState, type CharacterCodexDelta } from '../src/services/character-codex.service'
import { templateCastDeltas } from '../src/services/template-cast.service'
import { extractCharacterCodexDeltas, extractCharacterCodexBatch, type CodexBatchTurn } from '../worker/lib/character-codex-extractor'
import { COLLECTIONS } from '../src/models/collections'
import type { CharacterProfileDoc } from '../src/models/character-profile.model'
import type { WorldEventDoc } from '../src/models/world-event.model'
import type { WorldInstanceDoc } from '../src/models/world-instance.model'
import type { WorldTemplateDoc } from '../src/models/world-template.model'
import type { ProjectionCheckpointDoc, ProjectionCheckpointChunkDoc } from '../src/models/projection-checkpoint.model'

const args = process.argv.slice(2)
function option(name: string, fallback?: string): string | undefined {
  const index = args.indexOf(name)
  if (index < 0) return fallback
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing ${name}`)
  return args[index + 1]
}
const save = option('--save'), from = Number(option('--from')), to = Number(option('--to'))
const cap = Number(option('--max-usd', '0.10'))
if (!save || !ObjectId.isValid(save) || !Number.isInteger(from) || from < 1 || !Number.isInteger(to) || to < from ||
  !Number.isFinite(cap) || cap <= 0) throw new Error('Required: --save ID --from N --to N [--max-usd 0.10]')
if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI must be supplied through the process environment')

// Reserve a worst-case charge BEFORE each request, including adjudication. No
// reservation is released, even when usage is missing or the provider fails.
// timeoutMs disables SDK retries. Model/reasoning settings stay unchanged.
type Price = { prompt: number; completion: number; request: number }
async function priceFor(model: string): Promise<Price> {
  const id = /^(?:gpt-|o\d)/i.test(model) ? `openai/${model}` : model
  const response = await fetch(`https://openrouter.ai/api/v1/models/${id}/endpoints`, { signal: AbortSignal.timeout(15000) })
  if (!response.ok) throw new Error(`Cannot bound pricing for ${id}: HTTP ${response.status}`)
  const result = await response.json() as { data?: { endpoints?: Array<{ pricing?: Record<string, string | number> }> } }
  const endpoints = result.data?.endpoints
  if (!endpoints?.length) throw new Error(`No priced endpoints for ${id}`)
  const rates = endpoints.map((endpoint) => {
    const price = endpoint.pricing
    if (!price || price.prompt === undefined || price.completion === undefined) throw new Error(`Incomplete pricing for ${id}`)
    // Unknown billable dimensions fail closed; token/request prices suffice for text JSON calls.
    // web_search bills only when search is enabled (never here); overrides apply above 272k
    // prompt tokens; discount is not a charge.
    for (const [key, value] of Object.entries(price)) {
      if (['web_search', 'overrides', 'discount'].includes(key)) continue
      if (!['prompt', 'completion', 'request', 'input_cache_read', 'input_cache_write'].includes(key) && Number(value) !== 0) {
        throw new Error(`Unbounded pricing dimension ${key} for ${id}`)
      }
    }
    const prompt = Number(price.prompt) + Number(price.input_cache_read || 0) + Number(price.input_cache_write || 0)
    const completion = Number(price.completion), request = Number(price.request || 0)
    if (![prompt, completion, request].every((v) => Number.isFinite(v) && v >= 0)) throw new Error(`Invalid pricing for ${id}`)
    return { prompt, completion, request }
  })
  return { prompt: Math.max(...rates.map((r) => r.prompt)), completion: Math.max(...rates.map((r) => r.completion)),
    request: Math.max(...rates.map((r) => r.request)) }
}
let reserved = 0, stopped = false, providerCalls = 0
const prices = new Map<string, Price>()
const budgetedCall: typeof callLLM = async (request) => {
  if (stopped) throw new Error('A/B budget exhausted')
  if (!request.maxTokens || request.maxTokens < 1) throw new Error('Unbounded comparison completion')
  const price = prices.get(request.model)
  if (!price) throw new Error('Unpriced comparison model')
  // Byte count is an upper bound for text BPE tokens. Additional 8192 tokens
  // cover protocol/schema overhead; completion includes the client's 1200
  // reasoning headroom. Use the most expensive eligible provider's rates.
  const input = Buffer.byteLength(JSON.stringify(request.messages), 'utf8') + 8192
  const output = (request.maxTokens || 0) + 1200
  const reserve = input * price.prompt + output * price.completion + price.request
  if (!Number.isFinite(reserve) || reserved + reserve > cap) {
    stopped = true
    throw new Error(`STOP before call ${providerCalls + 1}: reserved $${reserved.toFixed(6)} + $${reserve.toFixed(6)} exceeds --max-usd $${cap}`)
  }
  reserved += reserve; providerCalls++
  return callLLM({ ...request, timeoutMs: 90_000 })
}
const checkBudget = () => { if (stopped) throw new Error(`STOP: budget reservation reached $${reserved.toFixed(6)} / $${cap}; partial results only`) }
const client = new MongoClient(process.env.MONGODB_URI)
try {
  await client.connect() // Deliberately no connectMongo(): that path ensures indexes.
  const db = client.db()
  // Only find/findOne are used on these collections. No projection services or
  // mutations are called; all folds below affect independent memory snapshots.
  const iid = new ObjectId(save)
  const instance = await db.collection<WorldInstanceDoc>(COLLECTIONS.world_instances).findOne({ _id: iid })
  if (!instance) throw new Error('Save not found')
  const template = await db.collection<WorldTemplateDoc>(COLLECTIONS.world_templates).findOne({ _id: instance.template_id })
  if (!template) throw new Error('Template not found')
  const allEvents = await db.collection<WorldEventDoc>(COLLECTIONS.events).find({ instance_id: iid, type: { $ne: 'side_chat' } }).sort({ sequence: 1 }).toArray()
  const selected = allEvents.filter((e) => e.sequence >= from && e.sequence <= to && e.data.model_used !== 'seed')
  if (selected.length !== to - from + 1 || selected.some((e) => !Array.isArray(e.data.present_characters))) throw new Error('Range contains missing or not-ready turns')
  if (instance.manual_identity_revisions?.length) throw new Error('Manual identity revisions need an exact --baseline-json snapshot')
  const now = new Date(0), pid = instance.player_id
  const cloneCards = (cards: CharacterProfileDoc[]) => BSON.EJSON.deserialize(BSON.EJSON.serialize(cards)) as CharacterProfileDoc[]
  const rows = (state: ReturnType<typeof newFoldState>) => [...new Set(state.byName.values())]
  const foldEvent = (state: ReturnType<typeof newFoldState>, event: WorldEventDoc, deltas: CharacterCodexDelta[]) => {
    for (const delta of deltas) foldDelta(state, delta, event.sequence, { iid, pid, now, prose: event.data.ai_response })
    for (const life of event.data.character_lifecycle_deltas || []) {
      const card = rows(state).find((c) => c.name_normalized === life.name_normalized && !c.is_protagonist)
      if (card) Object.assign(card, { life_state: life.state, life_state_sequence: life.sequence, life_state_evidence: life.evidence, life_state_source: life.source || 'narration' })
    }
  }
  let baseline: CharacterProfileDoc[], after = -1
  const baselinePath = option('--baseline-json')
  if (baselinePath) {
    baseline = BSON.EJSON.parse(await readFile(baselinePath, 'utf8')) as CharacterProfileDoc[]
    if (!Array.isArray(baseline) || baseline.some((c) => String(c.instance_id) !== save || !c.canonical_name)) throw new Error('Invalid baseline card array')
    after = from - 1
    console.log(`Baseline: supplied snapshot before ${from}`)
  } else {
    const checkpoint = await db.collection<ProjectionCheckpointDoc>(COLLECTIONS.projection_checkpoints).findOne({
      instance_id: iid, status: 'active', kind: 'world_projection', sequence: { $lt: from },
    }, { sort: { sequence: -1 } })
    if (checkpoint) {
      const chunks = await db.collection<ProjectionCheckpointChunkDoc>(COLLECTIONS.projection_checkpoint_chunks).find({
        checkpoint_id: checkpoint._id, kind: 'characters',
      }).sort({ index: 1 }).toArray()
      baseline = chunks.flatMap((c) => c.docs) as CharacterProfileDoc[]
      if (baseline.length !== checkpoint.counts.characters) throw new Error('Incomplete checkpoint cards')
      after = checkpoint.sequence
      console.log(`Baseline: checkpoint ${after} plus surviving ledger prefix`)
    } else {
      // Mirror the rewind seed and fold, but refuse histories whose initial
      // protagonist identity cannot be recovered from immutable data.
      if (instance.template_version !== template.version) throw new Error('Template changed: provide --baseline-json or an earlier checkpoint')
      const seed = newFoldState([])
      const protagonist = await db.collection<CharacterProfileDoc>(COLLECTIONS.characters).findOne({ instance_id: iid, is_protagonist: true })
      if (protagonist) {
        const name = template.is_sentient ? template.protagonist?.name : protagonist.canonical_name
        if (!name) throw new Error('Missing protagonist seed')
        if (!template.is_sentient && allEvents.some((e) => (e.data.codex_deltas || []).some((d) =>
          (d.is_protagonist || d.name === name || d.resolved_name === name) &&
          (d.appearance || d.persona || (d.resolved_name && d.name !== d.resolved_name))))) {
          throw new Error('Historical protagonist seed is ambiguous: provide --baseline-json or an earlier checkpoint')
        }
        foldDelta(seed, { name, is_protagonist: true, role: template.is_sentient ? 'protagonist' : 'protagonist (the player)',
          appearance: template.is_sentient ? template.protagonist?.appearance : protagonist.appearance,
          persona: template.is_sentient ? template.protagonist?.persona : protagonist.persona }, 0, { iid, pid, now })
      }
      for (const delta of templateCastDeltas({ seed_cast: instance.seed_cast_snapshot ?? template.seed_cast, protagonist: template.protagonist })) {
        foldDelta(seed, delta, 0, { iid, pid, now })
      }
      baseline = rows(seed); after = 0
      console.log('Baseline: immutable cast seed plus full surviving ledger prefix')
    }
  }
  const prefix = newFoldState(cloneCards(baseline))
  for (const event of allEvents.filter((e) => e.sequence > after && e.sequence < from && e.data.model_used !== 'seed')) {
    if (!Array.isArray(event.data.codex_deltas)) throw new Error(`Missing ledger at ${event.sequence}: cannot reconstruct baseline`)
    foldEvent(prefix, event, event.data.codex_deltas)
  }
  baseline = rows(prefix)
  for (const model of new Set([AI_MODELS.codexExtraction, AI_MODELS.metadata])) prices.set(model, await priceFor(model))
  const separate = newFoldState(cloneCards(baseline)), batched = newFoldState(cloneCards(baseline))
  const perTurn = new Map<number, CharacterCodexDelta[]>()
  const newlyCreated = new Map<number, string[]>()
  const input = (event: WorldEventDoc): CodexBatchTurn => ({ sequence: event.sequence,
    playerInput: event.data.player_input || (event.data.world_action ? event.data.codex_projection_context?.player_input || '' : ''),
    aiResponse: event.data.ai_response, presentCast: event.data.present_characters! })
  const params = (state: ReturnType<typeof newFoldState>) => ({ existing: rows(state), seedPrompt: template.seed_prompt,
    isSentient: template.is_sentient, protagonistName: rows(state).find((c) => c.is_protagonist)?.canonical_name,
    playerPersonaName: instance.persona_snapshot?.name, call: budgetedCall })
  const project = (deltas: CharacterCodexDelta[], newNames: string[]) => deltas.map((d) => ({ name: d.resolved_name || d.name,
    meters: d.relationship_deltas, state: d.mutable_state, retire_state: d.retire_state,
    new_card: newNames.includes(d.resolved_name || d.name) }))
  // Interleave arms by groups so a small budget still yields completed pairs.
  for (let index = 0; index < selected.length; index += 4) {
    const group = selected.slice(index, index + 4)
    for (const event of group) {
      const deltas = await extractCharacterCodexDeltas({ ...params(separate), ...input(event) })
      checkBudget(); perTurn.set(event.sequence, deltas)
      const before = new Set(rows(separate).map((c) => String(c._id)))
      foldEvent(separate, event, deltas)
      newlyCreated.set(event.sequence, rows(separate).filter((c) => !before.has(String(c._id))).map((c) => c.canonical_name))
    }
    const result = await extractCharacterCodexBatch({ ...params(batched), turns: group.map(input) })
    checkBudget()
    for (const event of group) {
      const deltas = result.deltas.get(event.sequence)!
      const before = new Set(rows(batched).map((c) => String(c._id)))
      foldEvent(batched, event, deltas)
      const newNames = rows(batched).filter((c) => !before.has(String(c._id))).map((c) => c.canonical_name)
      console.table([{ sequence: event.sequence, one_by_one: JSON.stringify(project(perTurn.get(event.sequence)!, newlyCreated.get(event.sequence)!)), batched: JSON.stringify(project(deltas, newNames)) }])
    }
    console.log(`Dropped unattributable: ${result.droppedUnattributable}; calls ${providerCalls}; reserved $${reserved.toFixed(6)} / $${cap}`)
  }
  console.log(JSON.stringify({ final_cards: { one_by_one: rows(separate), batched: rows(batched) }, reserved_usd: reserved, max_usd: cap }, null, 2))
} catch (error) {
  // Avoid printing driver/provider messages that might contain credentials.
  if (stopped) console.error(`STOP: budget cap; reserved $${reserved.toFixed(6)} / $${cap}`)
  else console.error(error instanceof Error && !/mongo|connect|auth|key|token/i.test(error.message) ? error.message : 'A/B stopped; check supplied connection, credentials and baseline')
  process.exitCode = 1
} finally {
  await client.close()
}
