/**
 * CONTROLLED BEFORE/AFTER for the SCENE CAST — the location A/B's twin.
 *
 * The cast decision lives inline in the processor and is tangled with the codex,
 * the choice-grounding classifier and session state, so this replays the part
 * that arbitrates: candidate assembly, the departure delta, and the
 * corroboration bar that decides who is admitted. Those three are where all 17
 * errors on the hand-labelled corpus sit.
 *
 * `legacy` is the pre-citation bar — whole-passage participation grammar,
 * INCLUDING the identity half, which is how "Mara, my sister, had been gone for
 * years" once corroborated Mara's arrival. `current` seeds the corroboration set
 * from endpoint citations that pass (a)∧(b)∧(c) and consults the ACTION half
 * only, which is the branch's shipped behaviour.
 *
 * Cursors are threaded per world in sequence order, because a cast that empties
 * and stays empty is the failure being measured.
 *
 * Run: bun run corpus:cast-ab <instanceIds>
 */
import { readFileSync } from 'node:fs'
import type { CorpusTurn } from './corpus-freeze'
import {
  mergePresenceCandidates,
  evaluatePresenceCitation,
  showsParticipationInPassage,
} from '../worker/lib/scene-endpoint-adjudicator'
import { hasSceneParticipationGrammar } from '../worker/lib/presence-gap-detector'
import { sceneIdentityKey } from '../src/services/scene-state.service'
import { decideLocation } from '../worker/lib/location-decision'
import type { DriftState } from '../worker/lib/cursor-drift'

interface CastLabel { accepted: string[][]; primary: string[]; note?: string }
const instances = new Set((process.argv[2] || '').split(',').filter(Boolean))
const turns: CorpusTurn[] = JSON.parse(readFileSync('corpus/turns.json', 'utf8'))
const gold: Record<string, CastLabel> = JSON.parse(
  readFileSync(process.env.GOLD_CAST || 'corpus/gold-cast-hand.json', 'utf8'),
)
const travel: Record<string, string> = JSON.parse(readFileSync('corpus/travel-actions.json', 'utf8'))
const selected = turns
  .filter((t) => instances.has(t.instance) && gold[t.id])
  .sort((a, b) => (a.instance === b.instance ? a.sequence - b.sequence : a.instance.localeCompare(b.instance)))

/**
 * Scene membership is keyed title- and alias-insensitively in production —
 * "the steward" and "Tomas" are one man — so the replay has to resolve names
 * against the turn's own roster or every aliased character is counted twice.
 */
const bare = (name: string) => sceneIdentityKey(String(name || ''))
function resolverFor(turn: CorpusTurn): (name: string) => string {
  const byAlias = new Map<string, string>()
  for (const person of turn.context.roster) {
    const canonical = bare(person.name)
    if (canonical) byAlias.set(canonical, canonical)
    for (const alias of person.aliases || []) {
      const key = bare(alias)
      if (key) byAlias.set(key, canonical)
    }
  }
  return (name: string) => byAlias.get(bare(name)) ?? bare(name)
}
/** A bare pronoun is never a scene member; production drops these as generic. */
const PRONOUN = new Set(['he', 'she', 'they', 'him', 'her', 'them', 'it', 'i', 'you', 'we', 'us'])
const setOf = (names: string[]) => [...new Set(names.map(bare).filter(Boolean))].sort().join('|')

interface Run { label: string; right: number; wrong: number; rows: string[] }

function replay(label: string, mode: 'legacy' | 'current'): Run {
  const run: Run = { label, right: 0, wrong: 0, rows: [] }
  let prior: string[] = []
  let instance = ''
  let cursor: string | null = null
  let drift: DriftState | null = null
  for (const turn of selected) {
    if (turn.instance !== instance) {
      instance = turn.instance
      prior = turn.context.priorPresent
      cursor = turn.context.priorLocation
      drift = null
    }
    const witness: any = turn.observed.witness
    const endpoint: any = turn.observed.endpoint
    if (!witness) continue
    const available = !!endpoint
    const cited: { name: string; evidence: string }[] = endpoint?.present_at_end || []
    const viewpointAtEnd = endpoint?.player_viewpoint_at_end !== false
    // Production does NOT break a scene on the witness's own `viewpoint_moved`
    // boolean — it breaks on the LOCATION DECISION, which is the same evidence
    // put through the citation stack. Using the raw boolean here wiped the hall
    // on a turn where the player asked the steward to come down and he refused.
    const decision = decideLocation({
      isContinuation: false,
      playerInput: turn.playerInput,
      narrative: turn.prose,
      cursorName: cursor,
      knownPeople: turn.context.roster.map((c) => c.name),
      knownPlaceNames: turn.context.knownPlaces.map((p) => p.name),
      witness: {
        current_location: witness.current_location ?? null,
        player_destination: witness.player_destination ?? null,
        player_travel_confirmed: witness.player_travel_confirmed === true,
        viewpoint_moved: witness.viewpoint_moved === true,
        location_evidence: witness.location_evidence ?? null,
        location_evidence_source: witness.location_evidence_source ?? null,
      },
      actionDestination: travel[turn.id] ?? null,
      endpoint: endpoint
        ? { available: true, sceneTransition: endpoint.scene_transition === true, location: endpoint.location_at_end ?? null }
        : null,
      priorDrift: drift,
      sequence: turn.sequence,
    })
    drift = decision.drift.next
    if (decision.placeName && (decision.viewpointMoved || !cursor)) cursor = decision.placeName
    const sceneBroke =
      decision.viewpointMoved ||
      decision.sceneEstablished ||
      (available && viewpointAtEnd && endpoint?.scene_transition === true)

    const key = resolverFor(turn)
    const endpointPresent = viewpointAtEnd ? cited.map((c) => c.name) : []
    const candidates = mergePresenceCandidates({
      sceneBroke,
      endpointAvailable: available,
      endpointPresent,
      priorPresent: prior,
      witnessPresent: witness.present_characters || [],
      partyNames: [],
    })

    // The corroboration set: who this passage independently shows in the scene.
    const corroborated = new Set<string>()
    if (mode === 'current' && available && viewpointAtEnd) {
      for (const c of cited) {
        const v = evaluatePresenceCitation({ name: c.name, evidence: c.evidence, prose: turn.prose })
        if (v.a && v.b && v.c) corroborated.add(key(c.name))
      }
    }
    const shows = (name: string) =>
      mode === 'current'
        ? showsParticipationInPassage(name, turn.prose) ||
          hasSceneParticipationGrammar(name, turn.prose, { evidence: 'action' })
        : hasSceneParticipationGrammar(name, turn.prose)

    const departed = new Set((witness.characters_departed || []).map(key).filter(Boolean))
    const priorKeys = new Set(prior.map(key))
    const out: string[] = []
    const seen = new Set<string>()
    for (const name of candidates) {
      const k = key(name)
      if (!k || seen.has(k) || departed.has(k) || PRONOUN.has(bare(name))) continue
      // Carrying someone forward is free; ADMITTING someone new needs evidence.
      if (!priorKeys.has(k) && !corroborated.has(k) && !shows(name)) continue
      seen.add(k)
      out.push(name)
    }
    // A scene break wipes the room, and on a break the whole-passage fallback is
    // not usable: the passage spans two places. "Tomas doesn't try to stop him.
    // The sound of Kael's footsteps fades down the stairwell... In the cellars,
    // the air is still" shows Tomas acting, in the room the player just left.
    // Only a citation about the END of the scene can admit across a break.
    const next = sceneBroke
      ? out.filter((n) => (mode === 'current' ? corroborated.has(key(n)) : shows(n)))
      : out
    prior = next

    const g = gold[turn.id]
    if (g.accepted.some((a) => setOf(a) === setOf(next))) run.right++
    else {
      run.wrong++
      if (run.rows.length < 24) {
        run.rows.push(
          `    ${(turn.world || '').slice(0, 14).padEnd(14)} seq ${String(turn.sequence).padStart(3)}  ` +
            `cast=${JSON.stringify(next).padEnd(14)} truth=${JSON.stringify(g.primary)}`,
        )
      }
    }
  }
  return run
}

const before = replay('legacy (full grammar, no citation seed)', 'legacy')
const after = replay('current (citation seed, action-only)', 'current')
const n = before.right + before.wrong

// What production actually shipped, for reference.
let shipped = 0
for (const turn of selected) {
  const g = gold[turn.id]
  if (g.accepted.some((a) => setOf(a) === setOf(turn.observed.committedCast || []))) shipped++
}

console.log(`\n\nCONTROLLED CAST A/B — ${n} turns, identical extractor output, cast threaded in sequence\n`)
const rows = [
  ['metric', before.label, after.label],
  ['exact set match', `${before.right} (${((before.right / n) * 100).toFixed(1)}%)`, `${after.right} (${((after.right / n) * 100).toFixed(1)}%)`],
  ['wrong', String(before.wrong), String(after.wrong)],
]
const w = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)))
for (const [i, row] of rows.entries()) {
  console.log(row.map((cell, c) => cell.padEnd(w[c])).join('  '))
  if (i === 0) console.log(w.map((x) => '─'.repeat(x)).join('  '))
}
console.log(`\nshipped by production (${'58d6e72'}): ${shipped} (${((shipped / n) * 100).toFixed(1)}%)`)
for (const run of [before, after]) if (run.rows.length) console.log(`\n  ${run.label} — wrong:\n${run.rows.join('\n')}`)
