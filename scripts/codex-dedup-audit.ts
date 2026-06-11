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

  // === Scenario B: the "Mysterious Man" reproduction. ===
  // The father is in the scene, called only "the man" while being secretive about
  // his work. The extractor must resolve "the man" to the existing Father card and
  // must NEVER coin a "Mysterious Man" (a name found nowhere in the prose).
  console.log(`\n=== B. Secretive father called only "the man" (the Mysterious-Man bug) ===`)
  const inputB = `*I lean forward slightly, curiosity piqued.* What exactly do you do that's so important?`
  const proseB = `*A thin, mirthless smile curls the man's lips as he tilts the screen away, shielding the glow from view.* "Details that are far beyond your comprehension," *he replies, his voice a chilled whisper that dismisses the inquiry as a trifle.*`
  for (let s = 1; s <= SAMPLES; s++) {
    const deltas = await extractCharacterCodexDeltas({
      playerInput: inputB,
      aiResponse: proseB,
      existing,
      isSentient: false,
      protagonistName: 'Swapnil Sarkar',
      presentCast: ['Father', 'Mother', 'Swapnil Sarkar'],
    })
    const summary = deltas.map((d: any) => `${d.name}${d.resolved_name ? `→${d.resolved_name}` : ''}`).join(', ')
    console.log(`  — #${s}: [${summary}]`)
    // HARD invariant: no card whose identity is "mysterious"/"the man"/"stranger".
    const invented = deltas.find((d: any) => {
      const n = norm(d.resolved_name || d.name)
      return /myster|stranger|hooded|figure|the man|unknown man/.test(n) && !knownName(n)
    })
    ok(`#${s} did NOT mint an invented "Mysterious Man"-type card`, !invented,
      invented ? `minted "${invented.name}"` : summary)
    // If the man was extracted at all, he must be the Father.
    const manDelta = deltas.find((d: any) => /man|father/.test(norm(d.resolved_name || d.name)))
    if (manDelta) {
      ok(`#${s} the secretive man resolves to "Father"`,
        norm(manDelta.resolved_name || manDelta.name) === 'father',
        `name="${manDelta.name}" resolved_name="${(manDelta as any).resolved_name || ''}"`)
    }
  }

  // === Scenario C: a GENUINELY new, named character must still be created. ===
  // The guard must not block natural introductions — only mood-coined duplicates.
  // Here a never-before-seen person is NAMED in the prose, so a new card is right.
  console.log(`\n=== C. New named stranger walks in (natural flow must still mint a card) ===`)
  const inputC = `Who are you?`
  const proseC = `*The doors swept open and a tall woman strode in, rain still beading on her cloak.* "Forgive the intrusion," *she said, inclining her head.* "I am Seraphine Vance, sent by the magistrate." *The father's pen stilled at the name.*`
  for (let s = 1; s <= SAMPLES; s++) {
    const deltas = await extractCharacterCodexDeltas({
      playerInput: inputC,
      aiResponse: proseC,
      existing,
      isSentient: false,
      protagonistName: 'Swapnil Sarkar',
      presentCast: ['Father', 'Swapnil Sarkar'],
    })
    const summary = deltas.map((d: any) => `${d.name}${d.resolved_name ? `→${d.resolved_name}` : ''}`).join(', ')
    console.log(`  — #${s}: [${summary}]`)
    const seraphine = deltas.find((d: any) => /seraphine|vance/.test(norm(d.resolved_name || d.name)))
    ok(`#${s} the new named stranger WAS created as a card`, !!seraphine, summary)
    if (seraphine) {
      ok(`#${s} she is NOT resolved into an existing card`,
        !knownName(norm(seraphine.resolved_name || seraphine.name)),
        `name="${seraphine.name}" resolved_name="${(seraphine as any).resolved_name || ''}"`)
    }
  }

  console.log(`\n${failures === 0 ? '✅ ALL INVARIANTS HELD' : `❌ ${failures} invariant failure(s)`}`)
  process.exit(failures === 0 ? 0 : 1)
}

const knownName = (n: string) =>
  ['father', 'mother', 'twin sister', 'swapnil sarkar', 'neglected son', 'the unseen child'].includes(n)

main().catch((e) => {
  console.error(e)
  process.exit(2)
})
