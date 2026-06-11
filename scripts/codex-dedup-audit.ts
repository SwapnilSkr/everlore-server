/**
 * Live audit for the codex-extractor duplicate-card fix: a generic kin/role
 * epithet ("his sister"/"Sister") must resolve to the existing card for that
 * person ("Twin Sister"), never mint a second card. Calls the REAL
 * extractCharacterCodexDeltas (gpt-4o-mini). LLM-only — needs OPENAI_API_KEY.
 *
 *   bun run scripts/codex-dedup-audit.ts [samples]
 */
import { extractCharacterCodexDeltas } from '../worker/lib/character-codex-extractor'

const SAMPLES = Number(process.argv[2] || 4)
let failures = 0
const norm = (s: string) => s.trim().toLowerCase()
function ok(label: string, cond: boolean, detail = '') {
  console.log(`  ${cond ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

const existing = [
  { canonical_name: 'Twin Sister', aliases: ['Twin Sister'], role: 'side character', mutable_state: [] },
  { canonical_name: 'Father', aliases: ['Father'], role: 'family member', mutable_state: [] },
  { canonical_name: 'Swapnil Sarkar', aliases: ['Neglected Son', 'The Unseen Child'], role: 'protagonist (the player)', mutable_state: [] },
]

// A turn that refers to the existing twin only by the vaguer epithet "sister".
const playerInput = '*I glance at my sister, trying to read her expression.*'
const aiResponse = `*His sister did not look up. She traced the rim of her glass with one idle finger, the picture of bored contentment.* "Must you stare?" *the sister murmured, a thread of disdain in her voice. The father, at the head of the table, ignored them both.*`

async function main() {
  console.log(`codex-dedup-audit — ${SAMPLES} samples, model=${process.env.MODEL_METADATA || 'gpt-4o-mini'}`)
  for (let s = 1; s <= SAMPLES; s++) {
    const deltas = await extractCharacterCodexDeltas({
      playerInput,
      aiResponse,
      existing,
      isSentient: false,
      protagonistName: 'Swapnil Sarkar',
    })
    const summary = deltas.map((d: any) => `${d.name}${d.resolved_name ? `→${d.resolved_name}` : ''}`).join(', ')
    console.log(`\n  — #${s}: [${summary}]`)

    // The sister must resolve to the existing "Twin Sister" card, not a new one.
    const sisterDelta = deltas.find((d: any) =>
      /sister/.test(norm(d.name)) || /sister/.test(norm(d.resolved_name || '')),
    )
    ok(`#${s} the sister was extracted`, !!sisterDelta, summary)
    if (sisterDelta) {
      const resolvesToTwin =
        norm(sisterDelta.resolved_name || sisterDelta.name) === 'twin sister'
      ok(`#${s} resolves to existing "Twin Sister"`, resolvesToTwin,
        `name="${sisterDelta.name}" resolved_name="${(sisterDelta as any).resolved_name || ''}"`)
    }
    // No standalone bare "Sister" card may be created.
    const bareSister = deltas.find(
      (d: any) => norm(d.name) === 'sister' && norm((d as any).resolved_name || '') !== 'twin sister',
    )
    ok(`#${s} no standalone "Sister" card minted`, !bareSister)
  }
  console.log(`\n${failures === 0 ? '✅ ALL INVARIANTS HELD' : `❌ ${failures} invariant failure(s)`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(2)
})
