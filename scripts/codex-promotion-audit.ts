/** Pure guard checks for repeated, named off-screen codex promotion. */
import { isEligibleOffscreenPromotion } from '../worker/lib/character-codex-extractor'

const checks: Array<[string, boolean, boolean]> = [
  ['repeated named figure qualifies', isEligibleOffscreenPromotion(['Vico Rossi'], ['Vico Rossi']), true],
  ['one-off name cannot self-promote', isEligibleOffscreenPromotion(['Vico Rossi'], []), false],
  ['partial name cannot promote a distinct figure', isEligibleOffscreenPromotion(['Vico'], ['Vico Rossi']), false],
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
