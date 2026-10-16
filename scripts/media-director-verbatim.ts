/** Sol re-run on the VERBATIM director prompt (fix-1 item 7): the bake-off ran
 * on the truncated prompt (rules 1–8 only). Re-runs ONLY openai/gpt-6.1-sol on
 * the same three turns (fight, tense, intimate), within a hard $0.06 cap
 * enforced by pre-submit catalogue-priced reservations. No repair calls here.
 * Saves plans as director-plans/sol-verbatim-<turn>.json for the owner's read.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { env } from '../src/config/env'
import { DIRECTOR_SCHEMA, DIRECTOR_SYSTEM_PROMPT, validateDirectorPlan, type DirectorInput } from '../src/services/media/director'

const CAP_USD = 0.06
const MODEL = 'openai/gpt-6.1-sol'
const OUT = resolve(import.meta.dir, '../../.agents/reports/media-server-2/director-plans')
const API = 'https://openrouter.ai/api/v1/'

// Same three turns as scripts/media-director-bakeoff.ts, byte for byte.
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

async function main() {
  if (!env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is not configured')
  await mkdir(OUT, { recursive: true })
  const catalogue = await fetch(`${API}models`, { signal: AbortSignal.timeout(30000) })
  if (!catalogue.ok) throw new Error(`Catalogue HTTP ${catalogue.status}`)
  const models = await catalogue.json() as { data: Array<{ id: string; pricing: { prompt: number; completion: number } }> }
  const price = models.data.find((m) => m.id === MODEL)
  if (!price) throw new Error(`Model not in catalogue: ${MODEL}`)
  const promptRate = Number(price.pricing.prompt), completionRate = Number(price.pricing.completion)
  let exposure = 0
  for (const turn of TURNS) {
    const reserve = 4000 * promptRate + 2000 * completionRate
    if (exposure + reserve > CAP_USD) throw new Error(`Cap exceeded before ${turn.id}: $${exposure.toFixed(4)} + $${reserve.toFixed(4)} > $${CAP_USD}`)
    exposure += reserve
    const started = Date.now()
    let status = 'completed', plan: unknown = null, errors: string[] = [], realCost: number | undefined
    try {
      const res = await fetch(`${API}chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json', 'X-Title': 'Everlore director verbatim re-run' },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            { role: 'system', content: DIRECTOR_SYSTEM_PROMPT },
            { role: 'user', content: JSON.stringify(turn.input) },
          ],
          response_format: { type: 'json_schema', json_schema: { name: 'director_plan', strict: false, schema: DIRECTOR_SCHEMA } },
          temperature: 0.2,
          max_tokens: 2048,
        }),
        signal: AbortSignal.timeout(120000),
      })
      const data = await res.json() as {
        choices?: Array<{ message?: { content?: string } }>
        usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number }
        error?: unknown
      }
      realCost = typeof data.usage?.cost === 'number'
        ? data.usage.cost
        : (data.usage?.prompt_tokens ?? 0) * promptRate + (data.usage?.completion_tokens ?? 0) * completionRate
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(data.error ?? data).slice(0, 300)}`)
      const content = data.choices?.[0]?.message?.content ?? ''
      try {
        plan = JSON.parse(content)
      } catch {
        throw new Error(`not JSON: ${content.slice(0, 200)}`)
      }
      errors = validateDirectorPlan(plan, turn.input)
    } catch (error) {
      status = 'error'
      plan = { error: (error as Error).message.slice(0, 500) }
      errors = ['no plan to validate']
    }
    const latencyMs = Date.now() - started
    exposure = exposure - reserve + (realCost ?? reserve)
    await writeFile(join(OUT, `sol-verbatim-${turn.id}.json`),
      JSON.stringify({ model: MODEL, turn: turn.id, prompt: 'verbatim', latency_ms: latencyMs, cost_usd: realCost, errors, plan }, null, 2) + '\n')
    console.log(`${MODEL} ${turn.id}: ${status} errors=${errors.length} latency=${latencyMs}ms cost=${realCost === undefined ? 'unreconciled' : '$' + realCost.toFixed(5)}`)
    for (const e of errors.slice(0, 4)) console.log(`  - ${e}`)
  }
  console.log(`VERBATIM SPEND: exposure $${exposure.toFixed(5)} / $${CAP_USD}`)
  if (exposure > CAP_USD) throw new Error('Cap exceeded')
}

main().catch((error) => { console.error('Verbatim re-run failed:', (error as Error).message); process.exit(1) })
