/** Director bake-off (brief media-server-2 req 4): text only, hard $0.30 cap.
 * Runs 4 premium models over the same 3 turns (fight, tense, intimate),
 * scores each plan with the §3A.2 validator, saves every plan for the owner.
 * Never loops paid calls: one attempt per model+turn, no repair calls here
 * (the repair path is unit-covered in audit:media).
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { env } from '../src/config/env'
import { DIRECTOR_SCHEMA, DIRECTOR_SYSTEM_PROMPT, validateDirectorPlan, type DirectorInput } from '../src/services/media/director'

const CAP_USD = 0.30
const OUT = resolve(import.meta.dir, '../../.agents/reports/media-server-2/director-plans')
const API = 'https://openrouter.ai/api/v1/'

const MODELS = [
  { id: 'openai/gpt-6.1-sol', note: 'GPT-6.1 Sol: strongest reasoning in the OpenAI GPT-6 line; the orchestrator lane for hard backend work' },
  { id: 'openai/gpt-6-luna', note: 'Luna 6 at high reasoning effort: our walkable-speech narrator; cheapest premium, tests whether cheap+thought beats dear' },
  { id: 'anthropic/claude-opus-5.5', note: 'Claude Opus: best at following long rule lists verbatim in our experience' },
  { id: 'google/gemini-2.5-pro', note: 'Gemini Pro: strongest Google reasoning model; a different provider family for the bake-off' },
]

const TURNS: Array<{ id: string; input: DirectorInput }> = [
  {
    id: 'fight',
    input: {
      art_style: 'semi-realistic cinematic digital painting, warm rim light',
      narration_before: 'Rain hammered the rusted gutter above the alley door. Seren pressed her back to the wet brick, knife low, listening to boots splash closer through the dark.',
      line: { speaker_name: 'Seren', spoken_text: 'Get behind me! I said move!', duration_s: 2.8 },
      narration_after: 'The door shuddered on its hinges as the first of them shouldered through, lantern light spilling across the cobbles.',
      speaker: { appearance: 'A woman in her late twenties, sharp grey eyes, dark braided hair, a thin scar through her left eyebrow, worn leather collar', passing_look: 'Soaked dark coat, mud on her boots' },
      others_present: [{ name: 'Tomas', appearance: 'A lanky boy of sixteen, frightened, clutching a lantern' }],
      place: 'A narrow rain-slicked alley at night, one warm-lit door',
    },
  },
  {
    id: 'tense',
    input: {
      art_style: 'semi-realistic cinematic digital painting, warm rim light',
      narration_before: 'The tavern had gone silent except for the fire settling in the grate. Seren did not turn her head. She watched the door in the polished brass of the lamp behind the bar.',
      line: { speaker_name: 'Seren', spoken_text: "Don't breathe. They're right outside the door.", duration_s: 3.4 },
      narration_after: 'Somewhere beyond the shutters, a floorboard sighed under a careful boot.',
      speaker: { appearance: 'A woman in her late twenties, sharp grey eyes, dark braided hair, a thin scar through her left eyebrow, worn leather collar', passing_look: 'Travel-worn cloak pulled close' },
      others_present: [{ name: 'Tomas', appearance: 'A lanky boy of sixteen, holding his breath beside her' }],
      place: 'A low-beamed tavern at night, one lamp burning',
    },
  },
  {
    id: 'intimate',
    input: {
      art_style: 'semi-realistic cinematic digital painting, warm rim light',
      narration_before: 'The storm had passed and the candle had burned to a stub. Seren sat close beside him on the window seat, her hand resting over his, neither of them speaking for a long while.',
      line: { speaker_name: 'Dain', spoken_text: 'Stay with me. Just until the candle goes out.', duration_s: 3.1 },
      narration_after: 'Outside the glass, rain slipped from the eaves one drop at a time, and the room held its warmth around them.',
      speaker: { appearance: 'A man in his early thirties, tired kind eyes, unshaven jaw, a plain wool shirt', passing_look: 'Damp shirt sleeves rolled to the elbow' },
      others_present: [{ name: 'Seren', appearance: 'A woman in her late twenties, dark braided hair, worn leather collar' }],
      place: 'A small lamplit room at night, rain on the window',
    },
  },
]

interface Priced { prompt: number; completion: number }
async function pricing(model: string): Promise<Priced> {
  const res = await fetch(`${API}models`, { signal: AbortSignal.timeout(30000) })
  if (!res.ok) throw new Error(`Catalogue HTTP ${res.status}`)
  const data = await res.json() as { data: Array<{ id: string; pricing: Priced }> }
  const found = data.data.find((m) => m.id === model)
  if (!found) throw new Error(`Model not in catalogue: ${model}`)
  return { prompt: Number(found.pricing.prompt), completion: Number(found.pricing.completion) }
}

const costOf = (usage: { prompt_tokens?: number; completion_tokens?: number } | undefined, price: Priced): number | undefined => {
  if (!usage || !Number.isFinite(usage.prompt_tokens) || !Number.isFinite(usage.completion_tokens)) return undefined
  return usage.prompt_tokens! * price.prompt + usage.completion_tokens! * price.completion
}

async function main() {
  if (!env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is not configured')
  await mkdir(OUT, { recursive: true })
  let exposure = 0
  const summary: Array<Record<string, unknown>> = []
  for (const model of MODELS) {
    const price = await pricing(model.id)
    for (const turn of TURNS) {
      // Worst-case reservation: full context window is absurd; reserve a generous
      // per-call ceiling from catalogue rates (4k in + 2k out) before submitting.
      const reserve = 4000 * price.prompt + 2000 * price.completion
      if (exposure + reserve > CAP_USD) {
        console.log(`STOP ${model.id} ${turn.id}: exposure $${exposure.toFixed(4)} + reserve $${reserve.toFixed(4)} exceeds $${CAP_USD}`)
        summary.push({ model: model.id, turn: turn.id, status: 'skipped_over_cap' })
        continue
      }
      exposure += reserve
      const started = Date.now()
      let status = 'completed', plan: unknown = null, errors: string[] = [], refusal = false, realCost: number | undefined
      try {
        const body = {
          model: model.id,
          messages: [
            { role: 'system', content: DIRECTOR_SYSTEM_PROMPT },
            { role: 'user', content: JSON.stringify(turn.input) },
          ],
          response_format: { type: 'json_schema', json_schema: { name: 'director_plan', strict: false, schema: DIRECTOR_SCHEMA } },
          temperature: 0.2,
          max_tokens: 2048,
          ...(model.id === 'openai/gpt-6-luna' ? { reasoning: { effort: 'high' } } : {}),
        }
        const res = await fetch(`${API}chat/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json', 'X-Title': 'Everlore director bake-off' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(120000),
        })
        const data = await res.json() as { choices?: Array<{ message?: { content?: string; refusal?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number }; error?: unknown }
        realCost = typeof data.usage?.cost === 'number' ? data.usage.cost : costOf(data.usage, price)
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(data.error ?? data).slice(0, 300)}`)
        const content = data.choices?.[0]?.message?.content ?? ''
        if (data.choices?.[0]?.message?.refusal) { refusal = true; throw new Error(`refused: ${data.choices[0].message.refusal}`) }
        try { plan = JSON.parse(content) } catch { throw new Error(`not JSON: ${content.slice(0, 200)}`) }
        errors = validateDirectorPlan(plan, turn.input)
      } catch (error) {
        status = 'error'
        plan = { error: (error as Error).message.slice(0, 500) }
        errors = ['no plan to validate']
      }
      const latencyMs = Date.now() - started
      exposure = exposure - reserve + (realCost ?? reserve)
      await writeFile(join(OUT, `${model.id.replace(/[^a-z0-9]+/gi, '_')}-${turn.id}.json`),
        JSON.stringify({ model: model.id, turn: turn.id, latency_ms: latencyMs, cost_usd: realCost, errors, plan }, null, 2) + '\n')
      summary.push({ model: model.id, turn: turn.id, status, errors: errors.length, refusal, latency_ms: latencyMs, cost_usd: realCost })
      console.log(`${model.id} ${turn.id}: ${status} errors=${errors.length} refusal=${refusal} latency=${latencyMs}ms cost=${realCost === undefined ? 'unreconciled' : '$' + realCost.toFixed(5)}`)
      if (errors.length) for (const e of errors.slice(0, 4)) console.log(`  - ${e}`)
    }
  }
  await writeFile(join(OUT, '_summary.json'), JSON.stringify({ cap_usd: CAP_USD, exposure_usd: exposure, models: MODELS, results: summary }, null, 2) + '\n')
  console.log(`BAKEOFF SPEND: exposure $${exposure.toFixed(5)} / $${CAP_USD}`)
  if (exposure > CAP_USD) throw new Error('Cap exceeded')
}

main().catch((error) => { console.error('Bakeoff failed:', (error as Error).message); process.exit(1) })
