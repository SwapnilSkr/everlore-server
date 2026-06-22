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
/** Player-led: "I take/bring Mara with me", "I set off with Mara". */
const JOIN_PLAYER = new RegExp(
  `\\b(?:I|[Ww]e)\\s+(?:take|bring|set off with|set out with|leave with|head out with|travel with|ride with|depart with|go with)\\s+(${NAME})\\b`,
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
  for (const re of [JOIN_SUBJECT, JOIN_PLAYER, JOIN_TOGETHER]) {
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
