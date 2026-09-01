/**
 * Pure guard checks for RECURRENCE-based codex promotion.
 *
 * A figure the story keeps returning to earns a card whether or not they have a
 * proper name — recurrence plus direct involvement is what proves a person
 * matters, and a name is only a proxy for it. Membership of the promotable list
 * is what this file checks; the higher evidence bar unnamed figures must clear
 * to reach that list lives in the promotable query in generation.processor.ts.
 */
import {
  isEligibleRecurringPromotion,
  looksLikeUnnamedLabel,
} from '../worker/lib/character-codex-extractor'

const checks: Array<[string, boolean, boolean]> = [
  ['repeated named figure qualifies', isEligibleRecurringPromotion(['Vico Rossi'], ['Vico Rossi']), true],
  ['one-off name cannot self-promote', isEligibleRecurringPromotion(['Vico Rossi'], []), false],
  ['partial name cannot promote a distinct figure', isEligibleRecurringPromotion(['Vico'], ['Vico Rossi']), false],
  // The rider case: unnamed, but the story kept coming back to him.
  ['repeated UNNAMED figure qualifies', isEligibleRecurringPromotion(['the rider'], ['the rider']), true],
  ['an alias of the promotable figure qualifies', isEligibleRecurringPromotion(['Aldric', 'the rider'], ['the rider']), true],
  ['a different unnamed label cannot ride along', isEligibleRecurringPromotion(['the guard'], ['the rider']), false],
  // The stored label and the extractor's output disagree about "the" constantly;
  // an article is never what makes two people different. Letting it decide
  // promotion made the whole path a coin flip (caught by the live probe).
  ['a determiner never decides promotion', isEligibleRecurringPromotion(['rider'], ['the rider']), true],
  ['...in either direction', isEligibleRecurringPromotion(['the rider'], ['rider']), true],
  // Which figures face the higher bar to reach that list at all.
  ['"the rider" is held to the unnamed bar', looksLikeUnnamedLabel('the rider'), true],
  ['"the Rider" reads as an authored epithet', looksLikeUnnamedLabel('the Rider'), false],
  ['a proper name is not held to the unnamed bar', looksLikeUnnamedLabel('Vico Rossi'), false],
]

let failed = 0
for (const [label, actual, expected] of checks) {
  if (actual !== expected) {
    failed++
    console.error(`FAIL ${label}: got ${actual}, want ${expected}`)
  }
}
console.log(failed ? `${failed} failures` : `${checks.length} checks passed`)
process.exit(failed ? 1 : 0)
