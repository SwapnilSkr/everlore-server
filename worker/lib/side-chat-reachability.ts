/**
 * Side-chat REACHABILITY (§10). A side chat is a private one-on-one with a side
 * character — but the player should not be able to strike up a real-time
 * conversation with someone who is DEAD, nor have an "in-person" chat framed as if
 * they were in the room when they're across the world. This resolves, from the
 * world state, HOW a character is reachable so the processor can (a) hard-block the
 * impossible case and (b) FRAME the conversation correctly (in person vs. a remote
 * call/sending vs. reaching across distance).
 *
 * Deterministic + pure → safe to call on the request path (UI pre-gate) and on the
 * worker. Intentionally HIGH-PRECISION on `blocked`: a false "dead" would break the
 * feature for a living character, so only an unambiguous death / permanent-departure
 * clause on the character's OWN card state blocks them.
 */

export type SideChatMode = 'present' | 'nearby' | 'reachable_remote' | 'seek_required' | 'blocked'

export interface SideChatReachability {
  /** false only for `blocked`; the soft modes are allowed but framed differently. */
  allowed: boolean
  mode: SideChatMode
  /** Short human reason (shown to the player / logged). */
  reason?: string
}

function norm(s: string): string {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\s'-]+/g, '').replace(/\s+/g, ' ').trim()
}

/** Unambiguous death predicates about the clause's subject. */
const DEATH_RE =
  /\b(?:is|was|are|were|now|lies?|has been|been|got|fell|lay)\s+(?:\w+\s+){0,2}?(?:dead|deceased|killed|slain|murdered)\b|\b(?:died|perished|passed away|passed on)\b/i
/** Unambiguous PERMANENT departure (not "gone to the market"). */
const GONE_RE =
  /\b(?:gone for good|left for good|left forever|gone forever|never to return|never returned|departed for good|vanished without a trace|is no more|no longer alive|left and never (?:came|returned))\b/i
/** Cues that NEGATE / soften a death-or-gone clause so it does NOT block. */
const NEGATION_RE =
  /\b(?:not|isn'?t|wasn'?t|aren'?t|weren'?t|never|presumed|nearly|almost|feared|fears|thought|believed?|might|maybe|seemingly|appears?|presumably|as if|like)\b/i

/** True when a card-state clause unambiguously says the character is dead/gone. */
function isDeathOrGone(clause: string): boolean {
  const c = clause || ''
  if (!DEATH_RE.test(c) && !GONE_RE.test(c)) return false
  // Negation/softener anywhere in the short clause defuses it (precision over recall).
  if (NEGATION_RE.test(c)) return false
  return true
}

/** World supports reaching someone NOT physically present — modern comms or a
 *  magical/psychic link. Used to decide `reachable_remote`. */
const REMOTE_TECH_RE =
  /\b(?:phones?|telephones?|cell\s?phones?|cellphones?|mobiles?|smartphones?|call(?:s|ed|ing)?|text(?:s|ed|ing)?|radios?|walkies?|intercoms?|comm(?:s|link|unicator)?s?|video\s?calls?|messag\w*|e-?mails?|telegrams?|holograms?|holocalls?)\b/i
const REMOTE_MAGIC_RE =
  /\b(?:telepath\w*|mind[\s-]?link\w*|mind[\s-]?speak\w*|psychic|scry\w*|sending stone|farspeak\w*|dream[\s-]?walk\w*|dream[\s-]?link\w*|astral|soul[\s-]?bond\w*|bond(?:ed|mate)?\b|familiar|mental link|telthread)\b/i

export function worldHasRemoteComm(worldText?: string): boolean {
  const t = worldText || ''
  return REMOTE_TECH_RE.test(t) || REMOTE_MAGIC_RE.test(t)
}

export interface ReachabilityInput {
  /** The character's canonical name + aliases. */
  characterNames: string[]
  /** present_characters of the LATEST main turn. */
  latestPresent?: string[]
  /** Union of present_characters across the recent main-turn window. */
  recentPresent?: string[]
  /** The character card's mutable_state clauses (their current condition). */
  cardState?: string[]
  /** World premise/lore — judges whether remote contact is possible. */
  worldText?: string
  /** The character's last_seen_sequence and the current sequence — a small gap
   *  keeps them "nearby" even if this exact turn didn't name them. */
  lastSeenSequence?: number
  currentSequence?: number
  /** How many turns since last seen still counts as "nearby". */
  nearbyMaxGap?: number
}

/**
 * Resolve how (and whether) the player can side-chat this character right now.
 * Order: blocked (dead/gone) → present → nearby → reachable_remote → seek_required.
 */
export function resolveSideChatReachability(input: ReachabilityInput): SideChatReachability {
  const names = new Set((input.characterNames || []).map(norm).filter(Boolean))
  const display = (input.characterNames?.[0] || 'They').trim()

  // 1. BLOCKED — unambiguously dead or permanently gone (high precision).
  for (const clause of input.cardState || []) {
    if (isDeathOrGone(clause)) {
      return { allowed: false, mode: 'blocked', reason: `${display} is no longer reachable (${clause.trim()})` }
    }
  }

  const inSet = (list?: string[]) => (list || []).some((n) => names.has(norm(n)))

  // 2. PRESENT — named in the latest main scene.
  if (inSet(input.latestPresent)) {
    return { allowed: true, mode: 'present', reason: `${display} is here in the scene` }
  }

  // 3. NEARBY — in the recent scene window, or last seen very recently.
  const gap =
    typeof input.currentSequence === 'number' && typeof input.lastSeenSequence === 'number'
      ? input.currentSequence - input.lastSeenSequence
      : Infinity
  if (inSet(input.recentPresent) || gap <= (input.nearbyMaxGap ?? 6)) {
    return { allowed: true, mode: 'nearby', reason: `${display} is nearby` }
  }

  // 4. REACHABLE_REMOTE — the world supports contacting someone elsewhere.
  if (worldHasRemoteComm(input.worldText)) {
    return { allowed: true, mode: 'reachable_remote', reason: `${display} can be reached remotely` }
  }

  // 5. SEEK_REQUIRED — known but not here and not remotely reachable. Allowed as a
  //    soft mode (framed as reaching across distance / from memory), since the
  //    Bonds feature is a meta-conversation; the prompt acknowledges the distance.
  return { allowed: true, mode: 'seek_required', reason: `${display} is not here — you reach out across the distance` }
}

/** A short prompt fragment that frames the conversation per reachability mode, so
 *  the side character's reply matches WHERE they actually are. */
export function reachabilityFraming(mode: SideChatMode, characterName: string, place?: string | null): string {
  switch (mode) {
    case 'present':
      return `${characterName} is physically here${place ? ` in ${place}` : ''}; this is a face-to-face moment.`
    case 'nearby':
      return `${characterName} is close by${place ? ` near ${place}` : ''}; they can step over to talk in person.`
    case 'reachable_remote':
      return `${characterName} is NOT physically present — this conversation reaches them remotely (a call, message, or magical link). Do not describe them as in the room; speak as if across a distance.`
    case 'seek_required':
      return `${characterName} is NOT physically present and there is no clear means of contact — frame this as the player reaching out across distance or recalling them; ${characterName} is not in the room. Do not narrate them physically entering the scene.`
    default:
      return ''
  }
}
