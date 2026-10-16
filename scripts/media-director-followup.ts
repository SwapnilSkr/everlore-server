/** One-off bake-off follow-up: gemini-2.5-pro with a larger token budget and
 * gpt-6-luna WITHOUT the reasoning param, tense turn only. Distinguishes
 * "my params were wrong" from "the model cannot direct". Same $0.30 cap file.
 */
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { env } from '../src/config/env'
import { DIRECTOR_SCHEMA, DIRECTOR_SYSTEM_PROMPT, validateDirectorPlan } from '../src/services/media/director'

const OUT = resolve(import.meta.dir, '../../.agents/reports/media-server-2/director-plans')
const API = 'https://openrouter.ai/api/v1/'
const input = {
  art_style: 'semi-realistic cinematic digital painting, warm rim light',
  narration_before: 'The tavern had gone silent except for the fire settling in the grate. Seren did not turn her head. She watched the door in the polished brass of the lamp behind the bar.',
  line: { speaker_name: 'Seren', spoken_text: "Don't breathe. They're right outside the door.", duration_s: 3.4 },
  narration_after: 'Somewhere beyond the shutters, a floorboard sighed under a careful boot.',
  speaker: { appearance: 'A woman in her late twenties, sharp grey eyes, dark braided hair, a thin scar through her left eyebrow, worn leather collar', passing_look: 'Travel-worn cloak pulled close' },
  others_present: [{ name: 'Tomas', appearance: 'A lanky boy of sixteen, holding his breath beside her' }],
  place: 'A low-beamed tavern at night, one lamp burning',
}
async function run(model: string, maxTokens: number, extra: Record<string, unknown>, tag: string) {
  const started = Date.now()
  const res = await fetch(`${API}chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json', 'X-Title': 'Everlore director follow-up' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: DIRECTOR_SYSTEM_PROMPT }, { role: 'user', content: JSON.stringify(input) }],
      response_format: { type: 'json_schema', json_schema: { name: 'director_plan', strict: false, schema: DIRECTOR_SCHEMA } },
      temperature: 0.2,
      max_tokens: maxTokens,
      ...extra,
    }),
    signal: AbortSignal.timeout(120000),
  })
  const data = await res.json() as { choices?: Array<{ message?: { content?: string }, finish_reason?: string }>; usage?: { cost?: number; completion_tokens?: number }; error?: unknown }
  const content = data.choices?.[0]?.message?.content ?? ''
  let plan: unknown = null, errors: string[] = []
  try { plan = JSON.parse(content); errors = validateDirectorPlan(plan, input) }
  catch { errors = [`not JSON (finish=${data.choices?.[0]?.finish_reason}, chars=${content.length})`] }
  await writeFile(join(OUT, `${tag}.json`), JSON.stringify({
    model, max_tokens: maxTokens, extra, latency_ms: Date.now() - started,
    cost_usd: data.usage?.cost, finish_reason: data.choices?.[0]?.finish_reason,
    content_chars: content.length, errors, raw_tail: content.slice(-300), plan: errors.length ? undefined : plan,
  }, null, 2) + '\n')
  console.log(`${tag}: finish=${data.choices?.[0]?.finish_reason} chars=${content.length} errors=${errors.length} cost=${data.usage?.cost}`)
  for (const e of errors.slice(0, 5)) console.log(`  - ${e}`)
}
await run('google/gemini-2.5-pro', 4096, {}, 'google_gemini_2_5_pro-tense-retry')
await run('openai/gpt-6-luna', 2048, {}, 'openai_gpt_6_luna-tense-retry')
