/**
 * A VERDICT FOUGHT ON THE SAND.
 *
 * In this duchy a fight makes law. The Ring is not a spectacle attached to the
 * story — it is where a legal question is settled, and once the carvers have
 * cut it into the inner wall there is no appeal anywhere in the world. The map
 * already had three choices that are fights, and all three resolved into a
 * single line of summary. This is what the player watches instead.
 *
 * THE OUTCOME IS ALREADY WRITTEN, AND THAT IS THE WHOLE DESIGN.
 *
 * `fight_succession` sets `succession_fought` and `succession_passed`.
 * `let_cassian_throw` sets `succession_passed` and `cassian_dead`. Every ending,
 * every reign, every petition and every line of narration downstream is written
 * against those flags. A duel that rolled for a winner would, perhaps one time
 * in three, produce a fight the player watched themselves lose and a story that
 * carries on as though they had won — and nothing on the screen would say so.
 *
 * So a duel here is a DRAMATISATION of a decided outcome. The winner, the
 * loser, the order of the exchanges, how many there are and what each costs are
 * all authored in `<world>.duels.json`, keyed to the choice that triggers them.
 * Nothing is rolled. Nothing is derived. The flags are still written by the
 * choice itself, exactly as they always were — the duel's own `sets` list
 * exists only so the audit can prove the staging and the story agree.
 *
 * WHAT THE MODEL IS TRUSTED WITH. The words of one beat, and nothing else. It
 * is given the beat plan and asked to write each exchange as a novel would; it
 * never chooses who acts, who wins, how long the fight runs, what an exchange
 * costs, or which face anyone is wearing. It is never shown an asset id, a flag
 * name or a location key, and it cannot return one.
 *
 * DEGRADED MODE. Every failure falls back to the authored `line` on each beat,
 * which is written to be read as-is. A player whose provider is down gets a
 * whole duel, in the world's own voice, and never learns anything was asked of
 * anyone.
 */
import { AI_MODELS, callLLM } from '../ai'
import type { InteractiveAssetDoc } from '../models/interactive-world.model'
import { portraitAssetId } from '../worlds/cast'
import type { LoadedWorld, WorldDuel, WorldDuelBeat, WorldDuelCombatant } from '../worlds/world-source'
import { log } from '../utils/logger'

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    beats: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { action: { type: 'string' }, said: { type: 'string' } },
        required: ['action'],
      },
    },
  },
  required: ['beats'],
}

/**
 * Take the payload out of a response that echoed the SCHEMA back instead of
 * filling it in. One extractor on this server did that on 27.65% of its calls
 * and returned nothing at all, silently, for months.
 */
function unwrapSchemaEcho(parsed: any): Record<string, unknown> {
  if (parsed && typeof parsed === 'object' && parsed.beats === undefined && parsed.properties && typeof parsed.properties === 'object') {
    return parsed.properties
  }
  return parsed || {}
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

export type DuelSide = 'challenger' | 'defender'

const other = (side: DuelSide): DuelSide => (side === 'challenger' ? 'defender' : 'challenger')

/** One fighter, resolved. Asset ids here; the wire mapping turns them into URLs. */
export interface StagedFighter {
  side: DuelSide
  /** Set only where the fighter is someone the player can also meet and talk to. */
  character_id: string | null
  name: string
  role: string
  is_player: boolean
  portrait_asset_id: string | null
  vigour: number
}

export interface StagedBeat {
  index: number
  actor: DuelSide
  actor_name: string
  action: string
  said: string | null
  /** What this exchange cost the other side. */
  toll: number
  portrait_asset_id: string | null
  challenger_vigour: number
  defender_vigour: number
  /** The exchange the Verdict turns on. Exactly one beat carries it. */
  decisive: boolean
}

export interface StagedDuel {
  id: string
  at: string
  question: string
  herald: string
  vigour: number
  challenger: StagedFighter
  defender: StagedFighter
  beats: StagedBeat[]
  outcome: {
    winner: DuelSide
    victor_name: string
    fallen_name: string
    verdict: string
    cost: string
    fatal: boolean
  }
}

/** The same duel with every asset id replaced by the URL the client can draw. */
export type OfferedDuel = Omit<StagedDuel, 'challenger' | 'defender' | 'beats'> & {
  challenger: Omit<StagedFighter, 'portrait_asset_id'> & { portrait_url: string | null }
  defender: Omit<StagedFighter, 'portrait_asset_id'> & { portrait_url: string | null }
  beats: (Omit<StagedBeat, 'portrait_asset_id'> & { portrait_url: string | null })[]
}

/** The duel a choice calls for, or null where taking it is not a fight. */
export function duelForChoice(world: LoadedWorld, choiceId: string): WorldDuel | null {
  return world.duels.find((duel) => duel.choice_id === choiceId) ?? null
}

/**
 * A combatant resolved against the cast.
 *
 * A `cast_id` that names nobody falls back to the authored name rather than
 * throwing: a duel with a mistyped id would otherwise take down the whole turn
 * the player was taking, and a fighter with no face is still a fight.
 */
function resolveFighter(combatant: WorldDuelCombatant, side: DuelSide, world: LoadedWorld): StagedFighter {
  const member = combatant.cast_id ? world.cast.find((c) => c.id === combatant.cast_id) : undefined
  return {
    side,
    character_id: member?.id ?? null,
    name: member?.name ?? combatant.name ?? '',
    role: member?.role ?? combatant.role ?? '',
    is_player: combatant.is_player === true,
    // The player has no painted face, and neither does a fighter authored for
    // one Verdict. Null renders a blank standard rather than a broken frame.
    portrait_asset_id: member ? portraitAssetId(member, undefined) : null,
    vigour: 0,
  }
}

/**
 * The face a fighter wears for one exchange.
 *
 * Resolved against that character's OWN authored portraits and nothing else, so
 * a bearing nobody painted falls back to their default face instead of to an id
 * the manifest has never heard of. An unpublished id does not error — it
 * renders an empty frame in the middle of the fight, which is why this is the
 * only place a duel is allowed to name a portrait.
 */
function bearingFor(fighter: StagedFighter, bearing: string | undefined, world: LoadedWorld): string | null {
  const member = fighter.character_id ? world.cast.find((c) => c.id === fighter.character_id) : undefined
  if (!member) return null
  return portraitAssetId(member, bearing && member.portraits[bearing] ? bearing : undefined)
}

/** What the flavour pass is allowed to have written. One rewritten beat. */
export interface WrittenBeat {
  action: string
  said: string | null
}

/**
 * The verification half, pure so the audit can exercise it without a model
 * call.
 *
 * The count is checked against the authored plan rather than merely bounded,
 * because the beats are matched to the plan BY INDEX. A response one beat short
 * would silently shift every exchange onto the wrong actor, the wrong toll and
 * the wrong face — a fight that plays perfectly smoothly and describes the
 * loser winning. Refusing the whole response and narrating the authored beats
 * is the only safe reading of it.
 */
export function verifyDuelProse(raw: unknown, expected: number): WrittenBeat[] | null {
  const body = unwrapSchemaEcho(raw)
  if (!Array.isArray(body.beats) || body.beats.length !== expected) return null
  const beats = body.beats.map((beat: any) => ({ action: text(beat?.action), said: text(beat?.said) || null }))
  if (beats.some((beat) => !beat.action)) return null
  return beats
}

/**
 * Everything about the duel that is NOT prose.
 *
 * Pure and separate for the same reason the speech composer is: the winner, the
 * order, the tolls, the bars and the portraits are the parts that decide
 * whether the fight agrees with the story, and they are exactly the parts a
 * model must not be trusted with. `written` is null in degraded mode and the
 * authored lines are used, which is a complete duel rather than a fallback.
 */
export function composeDuel(duel: WorldDuel, written: WrittenBeat[] | null, world: LoadedWorld): StagedDuel {
  const challenger = resolveFighter(duel.challenger, 'challenger', world)
  const defender = resolveFighter(duel.defender, 'defender', world)
  const vigour = duel.vigour > 0 ? duel.vigour : 100
  challenger.vigour = vigour
  defender.vigour = vigour

  const loser = other(duel.outcome.winner)
  const fighters: Record<DuelSide, StagedFighter> = { challenger, defender }
  const bars: Record<DuelSide, number> = { challenger: vigour, defender: vigour }
  // The decisive exchange is the LAST one struck against the side the authored
  // outcome says lost. Derived from the plan rather than flagged in the file so
  // it cannot be authored onto a beat that leaves the loser standing.
  const decisiveIndex = duel.beats.reduce(
    (last, beat, index) => (other(beat.actor) === loser && beat.toll > 0 ? index : last),
    duel.beats.length - 1,
  )

  const beats = duel.beats.map((beat: WorldDuelBeat, index) => {
    const actor = fighters[beat.actor]
    const receiving = other(beat.actor)
    const toll = Number.isFinite(beat.toll) && beat.toll > 0 ? beat.toll : 0
    bars[receiving] = Math.max(0, Math.min(vigour, bars[receiving] - toll))
    // The loser is put on the sand exactly when the Verdict says they went
    // down, whatever the tolls add up to. A mis-authored toll would otherwise
    // leave them standing at a third of their strength while the Herald reads
    // out that they fell, and the bars would be quietly telling the player a
    // different story than the words.
    if (index === decisiveIndex) bars[loser] = 0
    return {
      index,
      actor: beat.actor,
      actor_name: actor.name,
      action: written?.[index]?.action ?? beat.line,
      // A beat authored silent stays silent. Whether someone speaks in the
      // middle of a Verdict is staging, and letting the flavour pass add a line
      // where the author wrote none is letting it stage the fight.
      said: beat.said ? (written?.[index]?.said ?? beat.said) : null,
      toll,
      portrait_asset_id: bearingFor(actor, beat.bearing, world),
      challenger_vigour: bars.challenger,
      defender_vigour: bars.defender,
      decisive: index === decisiveIndex,
    }
  })

  return {
    id: duel.id,
    at: duel.at,
    question: duel.question,
    herald: duel.herald,
    vigour,
    challenger,
    defender,
    beats,
    outcome: {
      winner: duel.outcome.winner,
      victor_name: fighters[duel.outcome.winner].name,
      fallen_name: fighters[loser].name,
      verdict: duel.outcome.verdict,
      cost: duel.outcome.cost,
      fatal: duel.outcome.fatal === true,
    },
  }
}

/**
 * The single mapping onto the wire.
 *
 * Portraits are resolved to published URLs here and nowhere else, for the same
 * reason the cast's are: an id the client cannot turn into a URL renders an
 * empty frame, and a second mapping is a second place for that to happen.
 */
export function offerDuel(staged: StagedDuel, assets: (InteractiveAssetDoc & { url?: string | null })[]): OfferedDuel {
  const urls = new Map(assets.map((asset) => [asset.id, asset.url ?? null]))
  const url = (id: string | null) => (id ? urls.get(id) ?? null : null)
  const fighter = (f: StagedFighter) => {
    const { portrait_asset_id, ...rest } = f
    return { ...rest, portrait_url: url(portrait_asset_id) }
  }
  return {
    ...staged,
    challenger: fighter(staged.challenger),
    defender: fighter(staged.defender),
    beats: staged.beats.map(({ portrait_asset_id, ...rest }) => ({ ...rest, portrait_url: url(portrait_asset_id) })),
  }
}

/**
 * The brief the flavour pass writes against, kept pure so the audit can read
 * the REAL prompt.
 *
 * The outcome is stated up front, as a fact, because the model is writing
 * towards an ending that is already law — told nothing, it writes a fight that
 * builds towards whichever fighter it found more interesting, and the last beat
 * lands on the wrong person. It is given the plan and asked for the same
 * exchanges in better words, which is the only job it has here.
 */
export function briefForDuel(duel: WorldDuel, world: LoadedWorld): { role: 'system' | 'user'; content: string }[] {
  const challenger = resolveFighter(duel.challenger, 'challenger', world)
  const defender = resolveFighter(duel.defender, 'defender', world)
  const named: Record<DuelSide, StagedFighter> = { challenger, defender }
  const describe = (f: StagedFighter, c: WorldDuelCombatant) =>
    `${f.is_player ? `${f.name} — the person reading this, ${f.role}` : `${f.name}, ${f.role}`}. ${c.style ?? ''}`.trim()
  return [
    {
      role: 'system',
      content: [
        'You write fight scenes in a grim low-fantasy realm of feuding houses, written rolls and trial by combat. A fight in the Verdict Ring settles a question of law, and the answer cannot be appealed.',
        'You are given a fight that has already been staged, exchange by exchange, and its ending. Rewrite each exchange in one or two sentences, third person past tense, as a novel would render it.',
        'Keep every exchange to the same event, in the same order, done by the same person. Do not add exchanges, remove them, reorder them, or change who lands what. Do not change the ending or hint at a different one.',
        'Write what someone in the tiers would see and hear. No numbers, no scores, no talk of strength or damage or how much is left in anyone.',
        'Where an exchange is given words spoken aloud, you may rewrite those words in the same voice; where it is not, nobody speaks.',
        'Return exactly one beat for each exchange you are given, in the same order.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `The question on the sand: ${duel.question}`,
        `How it opened: ${duel.herald}`,
        `The challenger: ${describe(challenger, duel.challenger)}`,
        `The defender: ${describe(defender, duel.defender)}`,
        `How it ends, which is fixed: ${named[duel.outcome.winner].name} wins and ${named[other(duel.outcome.winner)].name} ${duel.outcome.fatal ? 'is killed' : 'is put down and lives'}. ${duel.outcome.verdict}`,
        '',
        'The exchanges, in order:',
        ...duel.beats.map(
          (beat, index) =>
            `${index + 1}. ${named[beat.actor].name} acts. ${beat.line}` +
            (beat.said ? ` They say aloud: "${beat.said}"` : ' Nobody speaks.'),
        ),
      ].join('\n'),
    },
  ]
}

/**
 * The duel the player watches. NEVER null.
 *
 * A conversation can end with nobody answering and that is a beat of fiction.
 * A Verdict cannot: the choice has already been taken, the flags are already
 * being written, and a player who is shown nothing has had the law of the
 * duchy changed off screen. So every failure here degrades to the authored
 * beats, which are written to be read.
 */
export async function stageDuel(duel: WorldDuel, world: LoadedWorld, instanceId?: string): Promise<StagedDuel> {
  try {
    const raw = await callLLM({
      model: AI_MODELS.metadata,
      purpose: 'duel_staging',
      temperature: 0.9,
      maxTokens: 900,
      responseSchema: SCHEMA,
      messages: briefForDuel(duel, world),
    })
    const written = verifyDuelProse(JSON.parse(raw), duel.beats.length)
    if (!written) log.info('duel_staging.refused', { instanceId, duel: duel.id })
    return composeDuel(duel, written, world)
  } catch (err) {
    log.info('duel_staging.failed', { instanceId, duel: duel.id, error: (err as Error).message })
    return composeDuel(duel, null, world)
  }
}
