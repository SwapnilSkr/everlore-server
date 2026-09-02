/**
 * Time citation stack (a)(b) — what the witness must quote before the story
 * calendar moves. Run: bun run audit:time-evidence
 */
import { excerptCarriesSpan, evaluateTimeCitation, citationAdmitsTimeSkip } from '../worker/lib/time-citation'

let failed = 0
function ok(label: string, pass: boolean) {
  console.log(`${pass ? '✅' : '❌'} ${label}`)
  if (!pass) failed++
}

console.log('(b) — the excerpt carries the span the label claims:')
ok('same unit', excerptCarriesSpan('two days', 'Two days later, the rain finally stopped.'))
ok('bare unit label', excerptCarriesSpan('weeks', 'The weeks wore on and the ledgers went unread.'))
ok('worded amount', excerptCarriesSpan('three days', 'three days of hard riding'))
ok('unit mismatch is refused', excerptCarriesSpan('three days', 'three hours later') === false)
ok('no span in the excerpt is refused', excerptCarriesSpan('a week', 'the rain finally stopped') === false)
ok('unitless label needs a day boundary', excerptCarriesSpan('the next morning', 'By morning the fires were out.'))
ok('unitless label with nothing is refused', excerptCarriesSpan('later', 'he set the glass down') === false)

const PROSE =
  'The ride took its toll. Two days later, the rain finally stopped and the low road firmed underfoot. ' +
  'He said he would be gone three hours at most.'

console.log('\nfull stack:')
const good = evaluateTimeCitation({ label: 'two days', evidence: 'Two days later, the rain finally stopped', source: PROSE })
ok('a real, unit-matching citation admits', citationAdmitsTimeSkip(good))

const wrongUnit = evaluateTimeCitation({ label: 'three days', evidence: 'gone three hours at most', source: PROSE })
ok('verbatim but wrong unit is refused by (b)', wrongUnit.a && !wrongUnit.b)

const invented = evaluateTimeCitation({ label: 'two days', evidence: 'Two days of hard riding passed', source: PROSE })
ok('a paraphrase is refused by (a)', !invented.a)

const noEvidence = evaluateTimeCitation({ label: 'a week', evidence: '', source: PROSE })
ok('no citation, no calendar move', !citationAdmitsTimeSkip(noEvidence))

console.log(`\ntime evidence audit: ${failed === 0 ? 'ALL GREEN' : `${failed} FAILED`}`)
process.exit(failed === 0 ? 0 : 1)
