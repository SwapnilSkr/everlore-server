/**
 * Live audit for the location-drift fixes (F1 tightened current_location, F2
 * explicit viewpoint_moved gating travel, F3 presence carry-forward). Calls the
 * REAL extractSceneMetadata (gpt-4o-mini) on hand-built scenarios and asserts
 * invariants over several samples. No DB — only needs OPENAI_API_KEY.
 *
 *   bun run scripts/location-audit.ts [samplesPerCase]
 */
import { extractSceneMetadata } from '../worker/lib/metadata-extractor'

const SAMPLES = Number(process.argv[2] || 3)
let failures = 0
function ok(label: string, cond: boolean, detail = '') {
  console.log(`  ${cond ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
const has = (s: string | null | undefined, re: RegExp) => !!s && re.test(s)

/** Mirrors the deterministic presence fold in generation.processor: a continuous
 *  scene keeps prior people minus those who departed; a scene break resets. */
function foldPresence(prior: string[], meta: any): string[] {
  const thisTurn: string[] = meta.present_characters || []
  const sceneBroke = meta.viewpoint_moved === true || !!meta.time_elapsed
  if (sceneBroke) return thisTurn.slice(0, 12)
  const departed = new Set((meta.characters_departed || []).map((n: string) => n.trim().toLowerCase()))
  const out: string[] = []
  const seen = new Set<string>()
  for (const name of [...prior, ...thisTurn]) {
    const key = (name || '').trim().toLowerCase()
    if (!key || seen.has(key) || departed.has(key)) continue
    seen.add(key)
    out.push(name)
  }
  return out
}

const protagonist = { name: 'Caelum', aliases: ['the son', 'the neglected son', 'the boy'] }
const roster = [
  { name: 'Mother Vella', aliases: ['the mother', 'their mother'] },
  { name: 'Lord Harlan', aliases: ['the father', 'his father'] },
  { name: 'Doran', aliases: ['the sister', 'his twin', 'her'] }, // sister, canonical "Doran" for the test
]

async function sampleCase(opts: Parameters<typeof extractSceneMetadata>[3], prose: string) {
  return extractSceneMetadata(prose, [], [], opts)
}

async function main() {
  console.log(`location-audit — ${SAMPLES} samples/case, model=${process.env.MODEL_METADATA || 'gpt-4o-mini'}`)

  // === A. The seq-10 reproduction: discussing a venue while seated elsewhere. ===
  // Prior cursor = dining room; the "great room" is only the topic of the party.
  console.log('\n=== A. Mentioned-not-moved (the original bug): dining room, talk of the great room ===')
  const proseA = `*The neglected son sat at the long dining table, the soup cooling untouched before him.* "What are you planning for the gathering?" *he asked. His father did not look up from his ledger.* "The usual excellence in the great room, of course," *the man said, as if the boy had asked something tedious. Candlelight pooled on the polished mahogany of the dining table between them.*`
  for (let s = 1; s <= SAMPLES; s++) {
    const m = await sampleCase(
      { isSentient: false, currentLocationName: 'dining room', priorPresent: ['Lord Harlan'], protagonist, roster },
      proseA,
    )
    console.log(`  — #${s}: viewpoint_moved=${m.viewpoint_moved}  current_location=${JSON.stringify(m.current_location)}`)
    ok(`#${s} did NOT claim movement`, m.viewpoint_moved === false)
    ok(`#${s} current_location is not the mentioned venue`, !has(m.current_location, /great\s*room/i), `${m.current_location}`)
    ok(`#${s} stays in dining room (or null)`, m.current_location === null || has(m.current_location, /dining/i), `${m.current_location}`)
  }

  // === B. A genuine move must still register. ===
  console.log('\n=== B. Genuine relocation: walks from the dining room out to the garden ===')
  const proseB = `*Unable to stand the silence a moment longer, the neglected son pushed back his chair and walked out of the dining room. He crossed the cold hall and stepped through the glass doors into the night garden, where the air smelled of wet stone and jasmine. The house and its dinner fell away behind him.*`
  for (let s = 1; s <= SAMPLES; s++) {
    const m = await sampleCase(
      { isSentient: false, currentLocationName: 'dining room', priorPresent: ['Lord Harlan', 'Mother Vella', 'Doran'], protagonist, roster },
      proseB,
    )
    console.log(`  — #${s}: viewpoint_moved=${m.viewpoint_moved}  current_location=${JSON.stringify(m.current_location)}`)
    ok(`#${s} registered movement`, m.viewpoint_moved === true)
    ok(`#${s} current_location is the garden`, has(m.current_location, /garden/i), `${m.current_location}`)
  }

  // === B2. Returning indoors must update the cursor (the "stuck outside" bug). ===
  console.log('\n=== B2. Return: walks back from the garden into the mansion (prior=outside) ===')
  const proseB2 = `*The heavy oak doors groan as the neglected son returns to the mansion, the transition from the cool night garden to the stifling interior feeling like a descent. The warmth of the entrance hall closes around him once more.*`
  for (let s = 1; s <= SAMPLES; s++) {
    const m = await sampleCase(
      { isSentient: false, currentLocationName: 'outside', priorPresent: [], protagonist, roster },
      proseB2,
    )
    console.log(`  — #${s}: viewpoint_moved=${m.viewpoint_moved}  current_location=${JSON.stringify(m.current_location)}`)
    // The cursor follows current_location server-side, so the key invariant is that
    // current_location reports the mansion/interior — NOT the stale "outside".
    ok(`#${s} current_location updated to the mansion interior`, has(m.current_location, /mansion|hall|interior/i) && !has(m.current_location, /^outside$|garden/i), `${m.current_location}`)
    ok(`#${s} did not report staying outside`, !has(m.current_location, /outside|garden/i), `${m.current_location}`)
  }

  // === E. Return to a KNOWN place by a variant name must reuse the canonical. ===
  console.log('\n=== E. Known-place reuse: prose says "the garden", world knows "Night Garden" ===')
  const proseE = `*The neglected son slipped out through the glass doors and back into the garden, the night air cool against his face. The familiar hedges loomed around him once more.*`
  for (let s = 1; s <= SAMPLES; s++) {
    const m = await extractSceneMetadata(proseE, [], [], {
      isSentient: false,
      currentLocationName: 'dining room',
      priorPresent: [],
      protagonist,
      roster,
      knownPlaces: [{ name: 'Night Garden', aliases: ['the garden'] }],
    })
    console.log(`  — #${s}: current_location=${JSON.stringify(m.current_location)}`)
    ok(`#${s} reused canonical "Night Garden" (not a variant)`, has(m.current_location, /night garden/i), `${m.current_location}`)
  }

  // === C. Presence carry-forward: a present character not named this turn. ===
  // The model reports only whom it sees; the SERVER fold keeps the rest.
  console.log('\n=== C. Carry-forward: only the father speaks, sister + mother still at the table ===')
  const proseC = `*The father set down his pen at last and regarded the neglected son with cool appraisal.* "You've been quiet," *Lord Harlan observed, swirling the wine in his glass. The fire cracked in the hearth.*`
  const priorC = ['Lord Harlan', 'Mother Vella', 'Doran']
  for (let s = 1; s <= SAMPLES; s++) {
    const m = await sampleCase(
      { isSentient: false, currentLocationName: 'dining room', priorPresent: priorC, protagonist, roster },
      proseC,
    )
    const folded = foldPresence(priorC, m)
    console.log(`  — #${s}: model=[${m.present_characters.join(', ')}] departed=[${(m.characters_departed||[]).join(', ')}] → folded=[${folded.join(', ')}]`)
    ok(`#${s} did not claim movement`, m.viewpoint_moved === false)
    ok(`#${s} did not falsely report a departure`, !(m.characters_departed || []).some((p: string) => /doran|vella|mother/i.test(p)), `departed=[${(m.characters_departed||[]).join(', ')}]`)
    ok(`#${s} folded presence keeps the sister (Doran)`, folded.some((p) => /doran/i.test(p)), `[${folded.join(', ')}]`)
    ok(`#${s} folded presence keeps the mother`, folded.some((p) => /vella|mother/i.test(p)), `[${folded.join(', ')}]`)
  }

  // === D. Leaving must drop a character (model flags departure → server removes). ===
  console.log('\n=== D. Departure: the sister rises and leaves the room ===')
  const proseD = `*The father set down his pen.* "You've been quiet," *he said. Doran, the sister, abruptly rose, her chair scraping the floor, and swept out of the dining room without a word, leaving only Caelum and his father in the heavy quiet.*`
  const priorD = ['Lord Harlan', 'Mother Vella', 'Doran']
  for (let s = 1; s <= SAMPLES; s++) {
    const m = await sampleCase(
      { isSentient: false, currentLocationName: 'dining room', priorPresent: priorD, protagonist, roster },
      proseD,
    )
    const folded = foldPresence(priorD, m)
    console.log(`  — #${s}: model=[${m.present_characters.join(', ')}] departed=[${(m.characters_departed||[]).join(', ')}] → folded=[${folded.join(', ')}]`)
    ok(`#${s} flagged the sister as departed`, (m.characters_departed || []).some((p: string) => /doran/i.test(p)), `departed=[${(m.characters_departed||[]).join(', ')}]`)
    ok(`#${s} folded presence dropped the departed sister`, !folded.some((p) => /doran/i.test(p)), `[${folded.join(', ')}]`)
    ok(`#${s} folded presence keeps the mother (did not leave)`, folded.some((p) => /vella|mother/i.test(p)), `[${folded.join(', ')}]`)
  }

  console.log(`\n${failures === 0 ? '✅ ALL INVARIANTS HELD' : `❌ ${failures} invariant failure(s)`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(2)
})
