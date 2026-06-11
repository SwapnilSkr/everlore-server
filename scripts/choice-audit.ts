/**
 * Live audit for the choice-POV + other-character-naming fixes.
 * Calls the REAL extractSceneMetadata (gpt-4o-mini) on representative prose and
 * asserts invariants over several samples (the model is nondeterministic; we
 * check shape, not exact strings). No DB — only needs OPENAI_API_KEY.
 *
 *   bun run scripts/choice-audit.ts [samplesPerCase]
 */
import { extractSceneMetadata } from '../worker/lib/metadata-extractor'

const SAMPLES = Number(process.argv[2] || 3)

let failures = 0
function ok(label: string, cond: boolean, detail = '') {
  console.log(`  ${cond ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

const FIRST_PERSON = /\b(I|I'm|I'll|I've|I'd|my|me|mine|myself)\b/i
/** The narrated action(s) inside *asterisks*, joined. */
function narratedAction(send: string): string {
  const m = [...send.matchAll(/\*([^*]+)\*/g)].map((x) => x[1])
  return m.join(' ').trim()
}
function containsPhrase(haystack: string, phrase: string): boolean {
  return new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(haystack)
}

interface Case {
  name: string
  isSentient: boolean
  prose: string
  protagonist: { name: string; aliases: string[] }
  roster: { name: string; aliases: string[] }[]
}

const CASES: Case[] = [
  {
    name: 'GM / "Unseen Child" (3rd-person, protagonist named by role)',
    isSentient: false,
    // Protagonist is "the son"/"the boy"; a favored brother + the mother share the scene.
    prose: `*The hall smelled of cold ash. The boy stood at the edge of the long table while his brother laughed at something their mother had said, the two of them bright in the candlelight, sealed off in a warmth that never quite reached the far end of the room. No one looked his way. He pressed his thumbnail into the soft wood of the table and watched the favored son refill their mother's cup, watched her hand settle fondly on the elder boy's wrist.*`,
    protagonist: { name: 'Caelum', aliases: ['the son', 'the neglected son', 'the unseen child', 'the boy'] },
    roster: [
      { name: 'Doran', aliases: ['the favored son', 'his brother', 'the elder boy'] },
      { name: 'Mother Vella', aliases: ['their mother', 'the matron'] },
    ],
  },
  {
    name: 'Sentient / persona player + AI character in roster',
    isSentient: true,
    prose: `*The vampire lord did not turn from the window. Rain traced the glass in long silver threads.* "You came back," *he said, the words quiet, almost disbelieving. His hand tightened on the sill.* "I told myself you wouldn't."`,
    protagonist: { name: 'Sasha', aliases: [] },
    roster: [{ name: 'Lord Aldric', aliases: ['the vampire lord', 'the lord'] }],
  },
]

async function runCase(c: Case) {
  console.log(`\n=== ${c.name} ===`)
  const protRefs = [c.protagonist.name, ...c.protagonist.aliases]
  const canonical = c.roster.map((r) => r.name.toLowerCase())
  const aliasOnly = c.roster.flatMap((r) => r.aliases.map((a) => a.toLowerCase()))

  for (let s = 1; s <= SAMPLES; s++) {
    const meta = await extractSceneMetadata(c.prose, [], [], {
      isSentient: c.isSentient,
      currentLocationName: null,
      protagonist: c.protagonist,
      roster: c.roster,
    })
    console.log(`\n  — sample ${s}: ${meta.choices.length} choices, present=[${meta.present_characters.join(', ')}]`)
    for (const ch of meta.choices) console.log(`     · [${ch.kind}] ${ch.label}  ⟶  ${ch.send}`)

    ok(`#${s} produced 2-4 choices`, meta.choices.length >= 2 && meta.choices.length <= 4, `${meta.choices.length}`)

    for (const ch of meta.choices) {
      const action = narratedAction(ch.send)
      // 1. A narrated action must be first-person (pure 'say' lines are exempt).
      if (action) {
        ok(`#${s} send action is first-person`, FIRST_PERSON.test(action), `"${ch.send}"`)
      }
      // 2. The player's own character is never named in 3rd person in label or send.
      const selfNamed = protRefs.find((r) => containsPhrase(ch.label, r) || containsPhrase(ch.send, r))
      ok(`#${s} no 3rd-person self-reference`, !selfNamed, selfNamed ? `found "${selfNamed}" in "${ch.label}" / "${ch.send}"` : '')
    }

    // 3. present_characters: canonical roster names only — no aliases, no player.
    for (const p of meta.present_characters) {
      const pl = p.toLowerCase()
      ok(`#${s} present "${p}" is canonical`, canonical.includes(pl) || !aliasOnly.includes(pl),
        aliasOnly.includes(pl) ? 'returned an ALIAS instead of canonical name' : '')
      ok(`#${s} present "${p}" is not the player`, !protRefs.some((r) => r.toLowerCase() === pl))
    }
  }
}

async function main() {
  console.log(`choice-audit — ${SAMPLES} samples/case, model=${process.env.MODEL_METADATA || 'gpt-4o-mini'}`)
  for (const c of CASES) await runCase(c)
  console.log(`\n${failures === 0 ? '✅ ALL INVARIANTS HELD' : `❌ ${failures} invariant failure(s)`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(2)
})
