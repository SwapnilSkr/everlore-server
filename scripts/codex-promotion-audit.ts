/**
 * Pure guard checks for recurrence and structurally corroborated codex promotion.
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
  newCardPromotionEvidence,
} from '../worker/lib/character-codex-extractor'

import { classifyPresenceCodexGaps, isActionableMention } from '../worker/lib/presence-gap-detector'

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

function promotes(name: string, prose: string, presentCast: string[] = [], knownCards: string[] = ['Tamsin']): boolean {
  const personEvidenceKeys = new Set(classifyPresenceCodexGaps(prose, { codex: knownCards })
    .filter(isActionableMention).map((candidate) => candidate.key))
  return newCardPromotionEvidence({ names: [name], prose, presentCast, knownCards, personEvidenceKeys }).admits
}

// Exact excerpts supplied in the brief, including its ellipses. These exercise
// the same gate as the extractor, with no metadata cast and no recurrence.
const lyssaTurns = [
  '*The old woman leans on her pole … She watches the new arrival …*\n\n“Lyssa,” *she says, her voice like dry reeds.* “And this bridge? It leads to the Spire of Echoes. …” *She gestures with her chin …* “You’re welcome to walk the path. …”',
  `Lyssa goes still, her gaze drifting past Tamsin … "I lost the sky," *she says, her voice softer than before.* "The first time I crossed …" *She looks back …* "But that's my story. …"`,
]
for (const [index, prose] of lyssaTurns.entries()) {
  checks.push([`speaker: Lyssa turn ${index + 2} cards despite empty metadata`, promotes('Lyssa', prose), true])
}
for (const [label, name, prose, expected] of [
  ['remembered name', 'Mara', '“Mara would have loved this,” she says.', false],
  ['addressed name', 'Mara', '“Mara!” he calls toward the ridge.', false],
  ['capitalised adverb', 'Quietly', 'Quietly she waits by the bridge.', false],
  ['quote addresses existing card', 'Lyssa', '“Mara, Lyssa,” she says.', false],
  ['named speaker before quote', 'Lyssa', '_Lyssa avers,_ “Wait.”', true],
  ['named speaker after quote', 'Lyssa', '“Wait,” _Lyssa avers._', true],
  ['single subject signal stays held', 'Lyssa', 'Lyssa goes still.', false],
] as const) {
  checks.push([`speaker: ${label}`, promotes(name, prose, [], ['Mara', 'Tamsin']), expected])
}
checks.push(['speaker: subject plus independent presence cards', promotes('Lyssa', 'Lyssa goes still.', ['Lyssa']), true])
checks.push(['speaker: a known card cannot supply a new naming identity', promotes('Mara', '“Mara,” she says.', [], ['Mara']), false])

for (const prose of ['Spire goes still.', '“Spire,” she says.']) {
  checks.push([`speaker: known place stays out in ${prose}`, newCardPromotionEvidence({
    names: ['Spire'], prose, presentCast: ['Spire'], knownCards: [], knownPlaces: ['Spire'],
    personEvidenceKeys: new Set(),
  }).admits, false])
}

let failed = 0
for (const [label, actual, expected] of checks) {
  if (actual !== expected) {
    failed++
    console.error(`FAIL ${label}: got ${actual}, want ${expected}`)
  }
}
console.log(failed ? `${failed} failures` : `${checks.length} checks passed`)
process.exit(failed ? 1 : 0)
