/**
 * Audit for the pre-generation input guard (src/utils/input-guard.ts).
 *
 * Two halves, and the second matters more:
 *   BLOCKS  — the narrow themes that must never reach a model.
 *   ALLOWS  — explicit, dark, and violent content that MUST pass untouched,
 *             plus the specific false positives the lexicons are shaped to
 *             avoid. Ardent is a supported mode; a guard that quietly sands it
 *             down is a worse failure than one that misses a case.
 *
 * Pure function, no DB or network. Run: bun run audit:input-guard
 */
import { screenPlayerInput, screenImagePrompt, type GuardCategory } from '../src/utils/input-guard'
import { decorateImagePrompt, stripServerDecorations } from '../src/services/image.service'

let pass = 0
let fail = 0

function blocks(desc: string, text: string, category: GuardCategory) {
  const v = screenPlayerInput(text)
  if (v.blocked && v.category === category) {
    console.log(`  ok   ${desc}`)
    pass++
  } else {
    console.log(`  FAIL ${desc}\n       expected ${category}, got ${v.blocked ? v.category : 'allowed'}`)
    fail++
  }
}

function allows(desc: string, text: string) {
  const v = screenPlayerInput(text)
  if (!v.blocked) {
    console.log(`  ok   ${desc}`)
    pass++
  } else {
    console.log(`  FAIL ${desc}\n       blocked as ${v.category}`)
    fail++
  }
}

console.log('\nblocks — sexual content involving a minor')
blocks('explicit act with an explicit child noun', 'I have sex with the child', 'minor_sexual')
blocks('anatomy term alongside a minor noun', 'the teenager grabs his cock', 'minor_sexual')
blocks('stated age below majority', 'she is 15 years old and we make love', 'minor_sexual')
blocks('compact age form', 'a 9yo, naked in the room', 'minor_sexual')
blocks('under-18 phrasing', 'she is under 18 but we have sex anyway', 'minor_sexual')
blocks('coded term', 'loli, undressed', 'minor_sexual')
blocks('bare copula age with no other signal', 'she is 15 and we have sex', 'minor_sexual')
blocks('minor signal outranks a kin signal in the same sentence', 'my daughter is 12 and we have sex', 'minor_sexual')

console.log('\nblocks — sexual content between family')
blocks('parent', 'I have sex with my mother', 'incest')
blocks('possessed diminutive parent', 'my mommy makes me horny', 'incest')
blocks('sibling', 'my sister rides my cock', 'incest')
blocks('step relation', 'my stepmother is naked in the hall', 'incest')
blocks('extended family', 'my cousin and I make love by the fire', 'incest')
blocks('in-law', 'fucking my sister-in-law', 'incest')
blocks('kin term after the sexual term', 'the orgasm my father gave', 'incest')
blocks('parental diminutive UNDER a possessive is a real kinship claim', 'I fuck my daddy', 'incest')
blocks('possessive diminutive, other form', 'sex with my mom', 'incest')

console.log('\nallows — explicit content that must pass untouched')
allows('graphic consensual scene', 'I pull her close, undress her slowly, and fuck her against the wall')
allows('anatomy and climax', 'her nails rake my cock until I cum')
allows('explicit request to an adult NPC', 'Lyra, I want you naked on the furs tonight')
allows('crude profanity with no guarded theme', 'fuck this, the bastard took my horse')
allows('non-consent theme without endorsement (prompt bound handles portrayal)', 'the raiders threaten her but she refuses')

console.log('\nallows — violence and darkness are untouched')
allows('graphic violence', 'I gut him and his entrails spill across the flagstones')
allows('child present in a non-sexual scene', 'the child clings to my leg as the village burns')
allows('kin present in a non-sexual scene', 'my mother is dying and I hold her hand')
allows('a child dies in the story', 'the toddler did not survive the winter')

console.log('\nallows — false positives the lexicons are shaped to avoid')
allows('cleric title with a proper name', 'Father Aldric watches us fuck in the chapel')
allows('religious sister', 'Sister Mara sees me naked and says nothing')
allows('Mother Superior', 'the Mother Superior found us having sex')
allows('war idiom', 'my brothers in arms, we fucked up that ambush')
allows('adult endearment that reads as a minor noun', 'yes baby, just like that, harder')
allows('adult address that reads as a minor noun', 'good girl, take it all')
allows('kin and sex in DIFFERENT sentences', 'My mother waited outside. Then we had sex.')
allows('kin word far from any sexual signal', 'my brother rode ahead to scout the pass')
allows('sexual term with no guarded theme at all', 'she moans as I press into her')
// The single most common false positive in adult roleplay: parental
// diminutives are vocative address, not kinship, unless possessed.
allows('vocative daddy', 'fuck me daddy')
allows('vocative daddy, longer', 'yes daddy, make me cum')
allows('vocative daddy with anatomy', 'daddy, I need your cock')
allows('vocative mommy', 'fuck me mommy')
allows('idiom', "who's your daddy")

console.log('\nallows — non-sexual mentions of guarded vocabulary')
allows('sex as a field of study', 'the healer teaches anatomy to the village children')
// ACCEPTED OVER-BLOCK: "incest" is the single strongest signal for this
// category, so it stays in the sexual lexicon even though that also catches
// worldbuilding ABOUT a bloodline. The player is told the theme and can
// rephrase ("inbreeding"). Drop the term from SEXUAL_TERMS to trade this
// away — at the cost of missing "I want incest with my sister".
blocks('discussion of bloodline incest (known, accepted over-block)', 'my father warned me about the incest in that bloodline', 'incest')

function imgBlocks(desc: string, text: string, category: GuardCategory) {
  const v = screenImagePrompt(text)
  if (v.blocked && v.category === category) {
    console.log(`  ok   ${desc}`)
    pass++
  } else {
    console.log(`  FAIL ${desc}\n       expected ${category}, got ${v.blocked ? v.category : 'allowed'}`)
    fail++
  }
}

function imgAllows(desc: string, text: string) {
  const v = screenImagePrompt(text)
  if (!v.blocked) {
    console.log(`  ok   ${desc}`)
    pass++
  } else {
    console.log(`  FAIL ${desc}\n       blocked as ${v.category}`)
    fail++
  }
}

console.log('\nimage prompts — blocked')
imgBlocks('explicit act with a minor noun', 'a nude child on a bed', 'minor_sexual')
imgBlocks('sexualized appearance with a stated age', 'a 12 year old girl in a bikini', 'minor_sexual')
imgBlocks('no explicit word at all, appearance term only', 'teenager, lingerie, suggestive pose', 'minor_sexual')
imgBlocks('coded term', 'loli, ecchi, bedroom', 'minor_sexual')
imgBlocks('WHOLE-prompt scope: fragments describe one image', 'a young child. a nude woman.', 'minor_sexual')
imgBlocks('family sexual imagery', 'my mother and I having sex', 'incest')

console.log('\nimage prompts — allowed')
imgAllows('adult nude art', 'a nude woman reclining by firelight, oil painting')
imgAllows('adult sexualized art direction', 'a seductive sorceress in a corset, dramatic lighting')
imgAllows('adult in swimwear', 'a woman in a bikini on a beach at sunset')
imgAllows('appearance terms are NOT enough for the incest rule', 'my sister in a bikini')
imgAllows('a child in an ordinary scene', 'a child playing in a village square, watercolour')
imgAllows('a child in a grim scene', 'a frightened child watching the village burn')
imgAllows('family portrait', 'a mother holding her newborn, renaissance painting')
imgAllows('violence is untouched', 'a knight covered in blood standing over a corpse')

console.log('\nimage prompts — the service\'s own decorations must not trip the guard')
for (const style of ['flirty', 'dark_romance', 'epic_fantasy', 'horror']) {
  const decorated = decorateImagePrompt('a child watching from the tavern doorway', style)
  imgAllows(`${style} cover mentioning a child`, stripServerDecorations(decorated))
}
imgBlocks(
  'stripping decorations does not weaken the rule itself',
  stripServerDecorations(decorateImagePrompt('a nude child', 'flirty')),
  'minor_sexual',
)

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
