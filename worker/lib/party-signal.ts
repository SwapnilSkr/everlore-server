/**
 * Deterministic travelling-party signal detector (NO LLM) — the companion twin of
 * movement-signal.ts / time-skip-signal.ts. Reads the player's input + the turn's
 * prose for EXPLICIT "X is now travelling with you" / "X parts ways" statements.
 *
 * Conservative + opt-in by design (see LOCATION_GRAPH.md limit #2): it only fires on
 * an explicit join/part phrase tied to a NAMED character, and the caller further
 * gates every hit against the real entity registry (a join for a name with no
 * card/stub is dropped). So it can never invent a companion — alone stays alone.
 *
 * Pure → runs on the post-stream tail, off TTFT.
 */

function clean(text: string): string {
  return String(text || '')
    .replace(/[*_~`]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// NAME must stay CASE-SENSITIVE (a capitalized proper noun) — so the regexes use NO
// `i` flag, and any keyword that can be sentence-initial allows both cases explicitly.
const NAME = "[A-Z][a-zà-ÿ'’\\-]+(?:\\s+[A-Z][a-zà-ÿ'’\\-]+)?"
// First/second-person targets that mean "with the player/viewpoint".
const WITH_YOU = '(?:with\\s+)?(?:me|us|you|the party|my side|our group)'
const PLACE = "(?:the\\s+)?([A-Za-zà-ÿ'’\\- ]{2,40}?)"

/** "X joins/comes with you", "X decides to accompany you", "X travels with us". */
const JOIN_SUBJECT = new RegExp(
  `\\b(${NAME})\\s+(?:(?:decides?|agrees?|chooses?|offers?)\\s+to\\s+)?(?:joins?|comes? along|comes? with|accompan(?:y|ies)|travels? with|rides? with|sets? off with|leaves? with|comes? too|tags? along|falls? in beside|walks? with)\\s+${WITH_YOU}\\b`,
)
/** Player-led, where the verb itself carries the companionship: "I set off with
 *  Mara", "I ride with Mara". The "with" is what makes these unambiguous. */
const JOIN_PLAYER = new RegExp(
  `\\b(?:I|[Ww]e)\\s+(?:set off with|set out with|leave with|head out with|travel with|ride with|depart with|go with)\\s+(${NAME})\\b`,
)
/**
 * Player-led with a BARE verb: "I take Mara with me", "I bring Mara along".
 *
 * `take` and `bring` are the only join verbs that do not carry "with" themselves,
 * and without a trailing companionship phrase they are not joins at all — they are
 * the ordinary transitive verbs of grabbing someone. A live run enrolled a man in
 * the player's travelling party because the player wrote "I take Halvard by the
 * collar and pull him up out of his chair"; party membership then bypasses the
 * scene-state corroboration gate, so an assaulted steward silently followed the
 * player out of the room and everywhere after. Require the trailer.
 */
const JOIN_PLAYER_BARE = new RegExp(
  `\\b(?:I|[Ww]e)\\s+(?:take|bring)\\s+(${NAME})\\s+(?:with\\s+(?:me|us)|along|too)\\b`,
)
/**
 * The player ASKS a named character to come along: "Neva, walk with me",
 * "Come with me, Bram".
 *
 * Addressing someone and telling them to walk with you is the most natural way a
 * player recruits a companion, and it was not detected at all — so the pair moved
 * to a new place with the companion missing from the scene entirely, while the
 * person they had left behind stayed in the cast. The named address plus an
 * explicit "with me/along" is as unambiguous as the other join phrasings.
 */
const JOIN_IMPERATIVE = new RegExp(
  `\\b(${NAME}),\\s*(?:please\\s+)?(?:come|walk|ride|follow|travel)\\s+(?:with\\s+(?:me|us)|along)\\b` +
    `|\\b(?:[Cc]ome|[Ww]alk|[Rr]ide|[Ff]ollow|[Tt]ravel)\\s+(?:with\\s+(?:me|us)|along),\\s*(${NAME})\\b`,
)

/** "together with Mara …", "Mara and I set off". */
const JOIN_TOGETHER = new RegExp(
  `\\b(?:[Tt]ogether with|[Aa]longside)\\s+(${NAME})\\b|\\b(${NAME})\\s+and\\s+I\\s+(?:set off|set out|leave|depart|travel|ride|head out|head off|journey)\\b`,
)

/** "X stays behind", "X remains here", "X parts ways", "we part ways with X". */
const PART_SUBJECT = new RegExp(
  `\\b(${NAME})\\s+(?:stays?|remains?|stops?)\\s+(?:behind|here|back)\\b|\\b(?:[Pp]art ways with|say(?:s)? goodbye to|bid(?:s)? farewell to|leave(?:s)? behind|split(?:s)? from|part(?:s)? from)\\s+(${NAME})\\b`,
)
/** "X leaves/heads/departs [for <place>]" — a parting, optionally with a destination. */
const PART_DEPART = new RegExp(
  `\\b(${NAME})\\s+(?:leaves?|departs?|rides? off|sets? off|storms? off|walks? off|goes? off|heads?(?:\\s+(?:back|off))?|returns?|goes?(?:\\s+back)?)(?:\\s+(?:for|to|towards|home to|back to)\\s+${PLACE})?(?=[.!?,]|$)`,
)

/**
 * The player states they are travelling ALONE.
 *
 * Every other signal here is about a NAMED companion, so "I ride back alone to
 * Ashfall Hold" — which names nobody — dissolved the party in the fiction and
 * left it fully intact in the model. The companion stayed in the travelling
 * party, and because party membership bypasses the scene-state corroboration
 * gate, she stayed in every subsequent scene too: the player rode home by
 * himself with his sister still standing next to him.
 *
 * Requires the player to be the subject and an actual departure/movement, so
 * "she leaves me alone" and "I feel alone" do not empty the party.
 */
const SOLO_VERB =
  '(?:go|goes|going|went|head|heads|heading|headed|leave|leaves|leaving|left|ride|rides|riding|rode|walk|walks|walking|walked|travel|travels|travelling|traveling|travelled|traveled|return|returns|returning|returned|set off|sets off|set out|sets out|depart|departs|departing|departed|journey|journeys|journeyed|sail|sails|sailed|fly|flies|flew|drive|drives|drove|march|marches|marched|press on|push on|continue|continues|continued|move|moves|moved|climb|climbs|climbed|cross|crosses|crossed)'
const SOLO_TRAVEL = new RegExp(
  `\\b(?:i|we)\\b[^.!?]{0,60}?\\b${SOLO_VERB}\\b(?!\\s+(?:me|him|her|them|us|you)\\b)[^.!?]{0,60}?\\b(?:alone|by myself|by ourselves|on my own|on our own|unaccompanied)\\b`,
  'i',
)

/** True when the player's own text says this move is a solo one. The caller
 *  clears the whole travelling party — no name is needed, because the claim is
 *  precisely that nobody came. */
export function detectSoloTravel(text: string | null | undefined): boolean {
  return SOLO_TRAVEL.test(clean(text || ''))
}

export interface PartyDeparture {
  name: string
  /** Where they said they were going, if the prose stated it ("for the capital"). */
  destination?: string
}

/** Names that EXPLICITLY joined the viewpoint's travel this turn. Deduped, capped. */
export function detectCompanionJoins(text: string | null | undefined): string[] {
  const t = clean(text || '')
  if (!t) return []
  const out = new Set<string>()
  for (const re of [JOIN_SUBJECT, JOIN_PLAYER, JOIN_PLAYER_BARE, JOIN_IMPERATIVE, JOIN_TOGETHER]) {
    let m: RegExpExecArray | null
    const g = new RegExp(re.source, 'g')
    while ((m = g.exec(t))) {
      const name = (m[1] || m[2] || '').trim()
      if (name) out.add(name)
      if (out.size >= 8) break
    }
  }
  return [...out]
}

/** Names that EXPLICITLY parted from the viewpoint this turn (+ optional destination).
 *  This is a PARTING, distinct from a mere scene-exit (`characters_departed`): a
 *  companion stepping out of the room is NOT a parting and must keep party membership. */
export function detectCompanionDepartures(text: string | null | undefined): PartyDeparture[] {
  const t = clean(text || '')
  if (!t) return []
  const out = new Map<string, PartyDeparture>()
  const add = (name: string, destination?: string) => {
    const n = name.trim()
    if (!n) return
    const dest = (destination || '').trim() || undefined
    const prev = out.get(n.toLowerCase())
    if (!prev || (dest && !prev.destination)) out.set(n.toLowerCase(), { name: n, destination: dest })
  }
  // PART_SUBJECT: name is group 1 (subject form) OR group 2 (object form); no place.
  const ps = new RegExp(PART_SUBJECT.source, 'g')
  let m: RegExpExecArray | null
  while ((m = ps.exec(t)) && out.size < 8) add(m[1] || m[2] || '')
  // PART_DEPART: name is group 1, destination (when stated) is group 2.
  const pd = new RegExp(PART_DEPART.source, 'g')
  while ((m = pd.exec(t)) && out.size < 8) add(m[1] || '', m[2])
  return [...out.values()]
}
