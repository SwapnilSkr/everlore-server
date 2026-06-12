/**
 * Deterministic grounding for tap-to-play CHOICES.
 *
 * The narrator (prose) is grounded; the choices come from a separate, cheaper
 * metadata pass that is *told* "never invent new characters" but nothing enforces
 * it. When the small model ignores that instruction it fabricates a relationship
 * that doesn't exist — e.g. "Encourage my brother" in a world where the player
 * has only a sister — and the bad choice goes straight to the player.
 *
 * This is the closed-check backstop: AFTER the model writes the choices we drop
 * any choice that references a KINSHIP relation the cast does not actually
 * contain. It is pure string work (no model call), and it runs off the TTFT path
 * — the prose has already streamed by the time scene metadata is extracted — so
 * it adds zero latency to the token the player feels.
 *
 * Two safeguards keep the false-positive rate at ~0:
 *   1. Relations are matched by EQUIVALENCE GROUP, not literal word — "Dad" and
 *      "father" are the same relation, so a "Dad, do you see this?" choice is
 *      kept whenever a father exists, even though the card is named "Father".
 *   2. Only relations the cast genuinely lacks are dropped; every relation the
 *      cast DOES have (by canonical name, alias, or role word) is whitelisted, so
 *      a valid "confront my sister" survives when a sister exists.
 *
 * Crucially the whitelist also includes any relation the GROUNDED NARRATOR names
 * in THIS turn's prose. The codex is a PRE-turn snapshot — a relative the prose
 * introduces this turn ("your brother steps in") isn't carded yet — so without
 * this a freshly-introduced relative's choice would be wrongly dropped. The
 * narrator is grounded, so a kin term it actually uses is real even before the
 * codex catches up. The invented case ("Encourage my brother" when neither the
 * cast nor the prose ever mentions a brother) is exactly what remains caught.
 *
 * Deliberately out of scope: figurative phrases ("the golden child"), generic
 * nouns ("sibling", "child"), and fabricated PROPER NAMES — a name introduced in
 * this very passage may not be carded yet, so policing names would discard
 * legitimate choices. Specific, unambiguous kin terms are the safe class.
 */

/** Each entry maps a kinship word to its relation GROUP. A choice term is
 *  fabricated only when its entire group is absent from the cast — so synonyms
 *  ("dad"→father) never trip on a relative that exists under a different label.
 *  Intentionally excludes generic/figurative nouns ("child", "sibling", "twin")
 *  and ultra-short ambiguous tokens ("ma", "pa"). */
const KIN_GROUPS: Record<string, string> = {
  father: 'father', dad: 'father', daddy: 'father', papa: 'father', pop: 'father', pops: 'father',
  mother: 'mother', mom: 'mother', mommy: 'mother', mum: 'mother', mama: 'mother', momma: 'mother',
  brother: 'brother', bro: 'brother',
  sister: 'sister', sis: 'sister',
  son: 'son',
  daughter: 'daughter',
  husband: 'husband', hubby: 'husband',
  wife: 'wife',
  spouse: 'spouse',
  fiance: 'fiance', fiancee: 'fiance', 'fiancé': 'fiance', 'fiancée': 'fiance',
  boyfriend: 'boyfriend',
  girlfriend: 'girlfriend',
  uncle: 'uncle',
  aunt: 'aunt', auntie: 'aunt',
  cousin: 'cousin',
  nephew: 'nephew',
  niece: 'niece',
  grandmother: 'grandmother', grandma: 'grandmother', granny: 'grandmother', nana: 'grandmother', grandmom: 'grandmother',
  grandfather: 'grandfather', grandpa: 'grandfather', gramps: 'grandfather', granddad: 'grandfather', grandad: 'grandfather',
  stepmother: 'stepmother', stepmom: 'stepmother',
  stepfather: 'stepfather', stepdad: 'stepfather',
  stepbrother: 'stepbrother',
  stepsister: 'stepsister',
}

const KIN_TERMS = Object.keys(KIN_GROUPS)

/** Word-boundary, optional trailing plural ("sisters" still matches "sister"). */
function mentionsTerm(text: string, term: string): boolean {
  return new RegExp(`\\b${term}s?\\b`, 'i').test(text)
}

/** Split arbitrary cast strings (names, aliases, role labels) into bare tokens. */
function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-zà-ÿ]+/i).filter(Boolean)
}

export interface GroundableChoice {
  label: string
  kind: string
  send: string
}

export interface ChoiceGroundingResult<T extends GroundableChoice> {
  choices: T[]
  /** Choices removed, with the offending fabricated term — for logging/repair. */
  dropped: { choice: T; term: string }[]
}

/**
 * Filter `choices` to those whose kinship references the cast can actually
 * support. `castVocab` is every known name/alias/role string for every codex
 * card (including the player's) — any kinship word among those tokens marks its
 * whole relation group as "known", and choices may reference that group freely.
 * `groundingText` is THIS turn's narrator prose (optional): a relation the
 * grounded narrator names is treated as real even before the codex cards it, so
 * a freshly-introduced relative's choice is never dropped.
 */
export function groundChoices<T extends GroundableChoice>(
  choices: T[],
  castVocab: string[],
  groundingText?: string,
): ChoiceGroundingResult<T> {
  const knownGroups = new Set<string>()
  for (const v of castVocab) {
    if (!v) continue
    for (const tok of tokenize(v)) {
      const group = KIN_GROUPS[tok]
      if (group) knownGroups.add(group)
    }
  }
  // The grounded narrator: any kin term it uses this turn is real even if the
  // (pre-turn) codex hasn't carded the relative yet.
  if (groundingText) {
    for (const term of KIN_TERMS) {
      if (mentionsTerm(groundingText, term)) knownGroups.add(KIN_GROUPS[term])
    }
  }

  const kept: T[] = []
  const dropped: { choice: T; term: string }[] = []
  for (const c of choices || []) {
    const text = `${c?.label || ''} ${c?.send || ''}`
    const fabricated = KIN_TERMS.find(
      (term) => !knownGroups.has(KIN_GROUPS[term]) && mentionsTerm(text, term),
    )
    if (fabricated) dropped.push({ choice: c, term: fabricated })
    else kept.push(c)
  }
  return { choices: kept, dropped }
}
