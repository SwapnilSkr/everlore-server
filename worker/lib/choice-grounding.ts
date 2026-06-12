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

/**
 * Supernatural / non-human BEING nouns. The metaphor-reification class: a narrator
 * calls the overlooked protagonist "the ghost in the doorway" and the choice model
 * builds "Ask her about the ghost" as if a literal spirit. A prompt instruction
 * alone is too weak on the small metadata model (~80% miss), so this is the
 * deterministic backstop: in a GROUNDED world a choice referencing one of these is
 * dropped UNLESS the being is real here — established in the WORLD premise/lore, or
 * an actual carded entity. So real ghosts in a horror world survive (their premise
 * names them / they get carded), while a metaphor in a realist drama is dropped.
 * Deliberately TIGHT — only nouns almost never used for a literal present human
 * (excludes "monster", "beast", "shadow", "god", "angel", "witch", "devil" — all
 * commonly applied to real people). Grouped so synonyms share grounding.
 */
const SUPERNATURAL_GROUPS: Record<string, string> = {
  ghost: 'ghost', spirit: 'ghost', specter: 'ghost', spectre: 'ghost', wraith: 'ghost',
  phantom: 'ghost', apparition: 'ghost', poltergeist: 'ghost', revenant: 'ghost', banshee: 'ghost',
  demon: 'demon',
  vampire: 'vampire', nosferatu: 'vampire',
  werewolf: 'werewolf', lycan: 'werewolf', lycanthrope: 'werewolf',
  zombie: 'undead', undead: 'undead', lich: 'undead', ghoul: 'undead',
  dragon: 'dragon', wyrm: 'dragon', wyvern: 'dragon',
  goblin: 'fae', ogre: 'fae', troll: 'fae', fairy: 'fae', fae: 'fae', pixie: 'fae', sprite: 'fae', gnome: 'fae',
  alien: 'alien', extraterrestrial: 'alien', martian: 'alien',
  wendigo: 'cryptid', kraken: 'cryptid', basilisk: 'cryptid',
}
const SUPERNATURAL_TERMS = Object.keys(SUPERNATURAL_GROUPS)

/**
 * Markers that a WORLD is supernatural-capable (fantasy / horror / sci-fi / myth)
 * — found in the premise/lore. When ANY appears, the world plausibly contains
 * such beings, so we DON'T police being-nouns at all: a ghost (or dragon, or
 * alien) may legitimately come up even if THIS turn's prose is the first mention
 * and the premise didn't enumerate that exact being. Only a world with NONE of
 * these markers (a grounded realist drama) gets the metaphor guard, where a being
 * is allowed solely as an explicitly-carded entity.
 *
 * Deliberately UNAMBIGUOUS terms (magic, dragon, vampire, alien, starship…) that
 * essentially never appear in realist prose. Excludes the metaphor-prone ones
 * (ghost, spirit, haunt, monster, beast, curse) — those are handled per-being by
 * the premise/cast grounding so a realist drama saying "haunted by his past"
 * isn't misread as a supernatural world.
 */
const SUPERNATURAL_WORLD_MARKERS = new RegExp(
  '\\b(' +
  [
    // magic & practitioners
    'magic', 'magical', 'mage', 'wizard', 'witch', 'witchcraft', 'sorcer\\w*', 'spell',
    'spellcast\\w*', 'spellbook', 'grimoire', 'incantation', 'conjur\\w*', 'enchant\\w*',
    'arcane', 'rune', 'runic', 'warlock', 'druid', 'paladin', 'alchem\\w*', 'potion',
    'elixir', 'talisman', 'mana', 'coven', 'hex', 'thaumaturg\\w*',
    // undead & horror
    'undead', 'undeath', 'necroman\\w*', 'lich', 'zombie', 'wight', 'draugr', 'revenant',
    'ghoul', 'vampir\\w*', 'werewolf', 'werewolves', 'lycan\\w*', 'lycanthrop\\w*',
    'demon\\w*', 'incubus', 'succubus', 'fiend', 'eldritch', 'lovecraft\\w*', 'occult',
    'exorcis\\w*', 'seance', 'séance', 'ouija', 'wendigo',
    // psi / powers
    'supernatural', 'paranormal', 'psychic', 'psionic', 'telepath\\w*', 'telekine\\w*',
    'clairvoyan\\w*', 'precognit\\w*', 'shapeshift\\w*', 'levitat\\w*', 'metahuman',
    'superhuman', 'superpower\\w*',
    // mythic creatures
    'dragon\\w*', 'wyrm', 'wyvern', 'griffin', 'gryphon', 'phoenix', 'basilisk',
    'chimera', 'hydra', 'minotaur', 'centaur', 'satyr', 'nymph', 'dryad', 'golem',
    'gargoyle', 'kraken', 'leviathan', 'behemoth', 'manticore', 'gorgon', 'mermaid\\w*',
    'merfolk', 'selkie', 'kelpie', 'kobold', 'djinn', 'genie', 'demigod', 'valkyrie',
    // fae & folk
    'fae', 'fairy', 'faerie', 'fairies', 'feywild', 'elf', 'elves', 'elven', 'elvish',
    'dwarv\\w*', 'orc\\w*', 'goblin\\w*', 'troll', 'ogre\\w*', 'halfling', 'hobbit', 'treant',
    // myth / cosmology / realms
    'mythical', 'mytholog\\w*', 'mythos', 'fantasy', 'portal', 'otherworld\\w*',
    'netherworld', 'underworld', 'afterlife', 'astral', 'planar', 'multiverse',
    'valhalla', 'asgard', 'olympus', 'olympian', 'pantheon',
    // divine
    'deity', 'deities', 'divine', 'celestial', 'seraph\\w*', 'archangel', 'nephilim',
    // sci-fi
    'alien\\w*', 'extraterrestrial', 'martian', 'xeno\\w*', 'android\\w*', 'cyborg\\w*',
    'cybernetic\\w*', 'mutant\\w*', 'kaiju', 'mech', 'mecha', 'starship', 'spacecraft',
    'spaceship', 'interstellar', 'intergalactic', 'galactic', 'hyperspace', 'warp\\s?drive',
    'wormhole', 'teleport\\w*', 'terraform\\w*', 'exoplanet', 'nanobot\\w*', 'replicant',
    'post-?apocalyp\\w*', 'dystopia\\w*',
    // spectral beings
    'apparition\\w*', 'wraith\\w*', 'phantom\\w*', 'spectre\\w*', 'specter\\w*',
    'banshee\\w*', 'poltergeist\\w*',
    // tropes
    'reincarnat\\w*', 'prophec\\w*', 'prophes\\w*', 'chosen\\sone',
  ].join('|') +
  ')\\b',
  'i',
)

/** True when the world's premise/lore marks it as supernatural-capable. Negation-
 *  aware: a premise that DENIES the supernatural ("no magic", "nothing
 *  supernatural", "without monsters") is NOT flagged capable, so it still gets the
 *  metaphor guard. */
function worldAllowsSupernatural(worldText?: string): boolean {
  if (!worldText) return false
  const re = new RegExp(SUPERNATURAL_WORLD_MARKERS.source, 'gi')
  let m: RegExpExecArray | null
  while ((m = re.exec(worldText)) !== null) {
    const before = worldText.slice(Math.max(0, m.index - 24), m.index).toLowerCase()
    // A negation cue within a few words before the marker negates it.
    if (/\b(no|not|never|without|nothing|none|devoid|lacks?|free|absent|sans)\b[\s\w,'-]{0,16}$/.test(before)) continue
    return true
  }
  return false
}

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
  graphLabels?: string[],
  worldText?: string,
): ChoiceGroundingResult<T> {
  const knownGroups = new Set<string>()
  // Supernatural beings the world actually establishes — from the WORLD premise/
  // lore and the carded cast/entities (NOT the prose, which may use the word as a
  // metaphor). If a being's group is here, choices may reference it; otherwise a
  // reference is a reified metaphor and is dropped.
  // A supernatural-capable WORLD (fantasy/horror/sci-fi/myth, per its premise/lore)
  // is never policed — beings may freely come up. Only a grounded realist world
  // gets the metaphor guard.
  const worldCapable = worldAllowsSupernatural(worldText)
  const knownSupernatural = new Set<string>()
  for (const v of [...(castVocab || []), worldText || '']) {
    if (!v) continue
    for (const tok of tokenize(v)) {
      // Match singular or plural ("ghosts"/"spirits" in a premise → ghost group).
      const group = SUPERNATURAL_GROUPS[tok] || SUPERNATURAL_GROUPS[tok.replace(/s$/, '')]
      if (group) knownSupernatural.add(group)
    }
  }
  // (1) Cast role text — the legacy heuristic (perspective-imperfect but permissive).
  for (const v of castVocab) {
    if (!v) continue
    for (const tok of tokenize(v)) {
      const group = KIN_GROUPS[tok]
      if (group) knownGroups.add(group)
    }
  }
  // (2) The kinship GRAPH — the player's ACTUAL relatives' surface labels, the
  // authoritative perspective-correct source ("sister" → sister group, distinct
  // from "brother"). Durable across turns even when this passage's role text is
  // silent. See kinship-graph.service relativesOf / kinSummary.
  for (const v of graphLabels || []) {
    if (!v) continue
    for (const tok of tokenize(v)) {
      const group = KIN_GROUPS[tok]
      if (group) knownGroups.add(group)
    }
  }
  // (3) The grounded narrator: any kin term it uses this turn is real even if the
  // (pre-turn) codex/graph hasn't carded the relative yet.
  if (groundingText) {
    for (const term of KIN_TERMS) {
      if (mentionsTerm(groundingText, term)) knownGroups.add(KIN_GROUPS[term])
    }
  }

  const kept: T[] = []
  const dropped: { choice: T; term: string }[] = []
  for (const c of choices || []) {
    const text = `${c?.label || ''} ${c?.send || ''}`
    // Fabricated kinship: a kin relation the cast/graph/prose doesn't support.
    const fabricated = KIN_TERMS.find(
      (term) => !knownGroups.has(KIN_GROUPS[term]) && mentionsTerm(text, term),
    )
    // Reified metaphor: in a GROUNDED world only, a supernatural being not
    // established as real (premise/lore or a carded entity). Supernatural-capable
    // worlds are never policed — a ghost/dragon/alien may freely come up.
    const ungroundedBeing = worldCapable
      ? undefined
      : SUPERNATURAL_TERMS.find(
          (term) => !knownSupernatural.has(SUPERNATURAL_GROUPS[term]) && mentionsTerm(text, term),
        )
    const reason = fabricated || ungroundedBeing
    if (reason) dropped.push({ choice: c, term: reason })
    else kept.push(c)
  }
  return { choices: kept, dropped }
}
