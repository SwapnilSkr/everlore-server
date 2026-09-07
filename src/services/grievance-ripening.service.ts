/**
 * THE OTHER HALF OF A RULING.
 *
 * The escalation rule the reign is authored against says a petition never ends,
 * it is only converted, and it names three seeds. Two of them already worked:
 * the principle travels, because the ledger carries it and the next petitioner
 * one route away quotes it back. The party made to pay did not. They were
 * written into the ledger, read by nobody, and the quarrel the player settled
 * stayed settled — which made the reign a list of sixteen one-off scenes with a
 * running total, rather than something the player is inside.
 *
 * This is that party coming back. The grievance keyed to the resolution ripens
 * rather than expires: a season later it returns as a petition of a HARDER KIND
 * at the same place or one route from it — boundary becomes killing, debt
 * becomes desertion, accusation becomes inheritance. The ladder is authored
 * data in the reign file, not a map in this file; which kinds this world has
 * and what each escalates into is a judgement about Aldermere, and a designer
 * must be able to retune it without a deploy.
 *
 * TERMINATION. A chain is one hop long, guaranteed twice over:
 *
 *   — Only a ruling on an AUTHORED petition seeds a grievance. Ruling on a
 *     ripened petition is ledgered, cited and summed exactly like any other,
 *     and seeds nothing. This is the hard stop, and it holds however the
 *     authored ladder is edited.
 *   — A kind with no successor in the ladder cannot ripen at all. killing,
 *     desertion and inheritance are deliberately absent from it: a grievance
 *     that has already become a killing has nowhere worse to go.
 *
 * So sixteen authored petitions can produce at most sixteen ripened ones, one
 * apiece, and the reign is finite by construction rather than by a counter
 * somebody has to remember to check.
 *
 * DEGRADED MODE. Every failure here is silent and total: no petition is stored,
 * the reign continues with authored petitions only, and the player never learns
 * a model was asked anything. This runs off the ruling's own latency path — it
 * is fired when the ruling is handed down and not read until a season later —
 * so a slow or dead provider costs the player nothing at all.
 */
import { AI_MODELS, callLLM } from '../ai'
import type { InteractiveLocationDoc, RipenedPetitionDoc } from '../models/interactive-world.model'
import type { WorldPetition, WorldPetitionResolution } from '../worlds/world-source'
import { log } from '../utils/logger'

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    the_truth: { type: 'string' },
    parties: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { name: { type: 'string' }, claim: { type: 'string' } },
        required: ['name', 'claim'],
      },
    },
    resolutions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          label: { type: 'string' },
          consequence: { type: 'string' },
          made_whole: { type: 'string' },
          made_to_pay: { type: 'string' },
          principle: { type: 'string' },
        },
        required: ['label', 'consequence', 'made_whole', 'made_to_pay', 'principle'],
      },
    },
  },
  required: ['title', 'the_truth', 'parties', 'resolutions'],
}

/**
 * Take the payload out of a response that echoed the SCHEMA back instead of
 * filling it in. One extractor on this server did that on 27.65% of its calls
 * and returned nothing at all, silently, for months.
 */
function unwrapSchemaEcho(parsed: any): Record<string, unknown> {
  if (parsed && typeof parsed === 'object' && parsed.title === undefined && parsed.properties && typeof parsed.properties === 'object') {
    return parsed.properties
  }
  return parsed || {}
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

/**
 * Where the grievance comes back to stand.
 *
 * Chosen HERE rather than by the model, because a petition sited at a place
 * that does not exist is never offered and never errors — it is authored
 * content that silently disappears, which is the failure this whole audit
 * exists to catch. The candidates are the ruling's own location and the places
 * one route from it that the player has already opened, so the site is a real,
 * reachable, painted place by construction.
 *
 * The pick is a stable function of the resolution id rather than random: the
 * petition is persisted, so this only has to be deterministic once, but a
 * deterministic siting also means the same ruling puts the grievance in the
 * same place every time the audit asks.
 */
export function siteForGrievance(
  ruledAt: string,
  locations: InteractiveLocationDoc[],
  openLocationIds: string[],
  seed: string,
): string | null {
  const here = locations.find((l) => l.id === ruledAt)
  if (!here) return null
  const open = new Set(openLocationIds)
  const nearby = here.routes.filter((id) => open.has(id) && locations.some((l) => l.id === id))
  const candidates = [here.id, ...nearby]
  let hash = 0
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) % 1_000_003
  return candidates[hash % candidates.length]!
}

/**
 * The verification half, kept pure so the audit can exercise it without a
 * model call.
 *
 * A petition the player cannot judge is worse than no petition: two parties
 * with something to say, a truth behind them that is neither party's account,
 * and at least two ways of ruling that each name who is made whole, who is made
 * to pay, and the principle it establishes. Those last three are what the next
 * ruling is argued against — a resolution missing them settles the day and
 * seeds nothing, which is the difference between a reign and a scene.
 */
export function verifyRipenedPetition(raw: unknown): {
  parties: WorldPetition['parties']
  the_truth: string
  title: string
  resolutions: Omit<WorldPetitionResolution, 'id'>[]
} | null {
  const body = unwrapSchemaEcho(raw)
  const title = text(body.title)
  const the_truth = text(body.the_truth)
  if (!title || !the_truth) return null

  const parties = (Array.isArray(body.parties) ? body.parties : [])
    .map((p: any) => ({ name: text(p?.name), claim: text(p?.claim) }))
    .filter((p) => p.name && p.claim)
  if (parties.length < 2) return null

  const resolutions = (Array.isArray(body.resolutions) ? body.resolutions : [])
    .map((r: any) => ({
      label: text(r?.label),
      consequence: text(r?.consequence),
      made_whole: text(r?.made_whole),
      made_to_pay: text(r?.made_to_pay),
      principle: text(r?.principle),
    }))
    .filter((r) => r.label && r.consequence && r.made_whole && r.made_to_pay && r.principle)
  if (resolutions.length < 2) return null

  return { title, the_truth, parties, resolutions: resolutions.slice(0, 3) }
}

/**
 * Everything about the returned petition that is NOT the model's words.
 *
 * Kept separate and pure so the kind, the ids and the siting can be audited
 * without a model call — those are the parts that decide whether the petition
 * can be found, ruled on and terminated, and they are exactly the parts a
 * model must not be trusted with.
 */
export function composeRipenedPetition(
  written: NonNullable<ReturnType<typeof verifyRipenedPetition>>,
  frame: {
    seed: { petition: WorldPetition; resolution: WorldPetitionResolution }
    ripensToKind: string
    at: string
    ripeAtLedgerLength: number
  },
): RipenedPetitionDoc {
  // Ids are minted here, never by the model. The seed resolution is unique and
  // a ruling seeds at most once, so this id is unique by construction and a
  // re-fire cannot seat a second petition for the same grievance.
  const id = `ripened_${frame.seed.resolution.id}`
  return {
    id,
    at: frame.at,
    kind: frame.ripensToKind,
    title: written.title,
    parties: written.parties,
    the_truth: written.the_truth,
    resolutions: written.resolutions.map((r, index) => ({ ...r, id: `${id}_r${index + 1}` })),
    seeded_by: { petition_id: frame.seed.petition.id, resolution_id: frame.seed.resolution.id },
    ripe_at_ledger_length: frame.ripeAtLedgerLength,
    generated_at: new Date(),
  }
}

/**
 * Write the petition a ruling made, or null if it cannot be written.
 *
 * No standing shift is invented. Standing is the authored cost of an authored
 * ruling, and a number this pass made up would move a track the designer tuned
 * by hand — so a ripened petition costs the player a decision and a principle,
 * and nothing that a designer did not write.
 */
export async function ripenGrievance(params: {
  seed: { petition: WorldPetition; resolution: WorldPetitionResolution }
  ripensToKind: string
  locations: InteractiveLocationDoc[]
  openLocationIds: string[]
  ripeAtLedgerLength: number
  instanceId?: string
}): Promise<RipenedPetitionDoc | null> {
  const { seed, ripensToKind } = params
  const at = siteForGrievance(seed.petition.at, params.locations, params.openLocationIds, seed.resolution.id)
  if (!at) return null
  const where = params.locations.find((l) => l.id === at)!

  try {
    const raw = await callLLM({
      model: AI_MODELS.metadata,
      purpose: 'grievance_ripening',
      temperature: 0.9,
      maxTokens: 900,
      responseSchema: SCHEMA,
      messages: [
        {
          role: 'system',
          content: [
            'You write petitions brought before a judge in a grim low-fantasy realm of feuding houses, written rolls and trial by combat.',
            'A quarrel was settled and one party was made to pay. A season has passed and that grievance has come back — not as an appeal, but as a worse quarrel of a different kind, brought by or through the same party.',
            'Write the new petition. Two parties, each stating their case as they themselves would state it, in their own interest, without conceding anything.',
            'the_truth is what is ACTUALLY the case, which must be something neither party has said, and which must make the ruling genuinely hard rather than obvious.',
            'Give three ways of ruling. Each names who is made whole, who is made to pay, and the principle the ruling establishes, and each consequence must cost the judge something real.',
            'Do not narrate the judge. Do not mention game mechanics, standing, points or scores. Return only the fields asked for.',
          ].join(' '),
        },
        {
          role: 'user',
          content: [
            `The settled quarrel — "${seed.petition.title}" (a matter of ${seed.petition.kind}):`,
            seed.petition.parties.map((p) => `  ${p.name}: ${p.claim}`).join('\n'),
            `What was actually the case: ${seed.petition.the_truth}`,
            `The judge ruled: ${seed.resolution.label}`,
            `${seed.resolution.made_whole} was made whole. ${seed.resolution.made_to_pay} was made to pay.`,
            `The principle established: ${seed.resolution.principle}`,
            '',
            `Write the grievance of ${seed.resolution.made_to_pay}, returned a season later as a matter of ${ripensToKind}.`,
            `It is heard at ${where.title}: ${where.description}`,
          ].join('\n'),
        },
      ],
    })
    const verified = verifyRipenedPetition(JSON.parse(raw))
    if (!verified) {
      log.info('grievance_ripening.refused', { instanceId: params.instanceId, seed: seed.resolution.id })
      return null
    }
    return composeRipenedPetition(verified, {
      seed,
      ripensToKind,
      at,
      ripeAtLedgerLength: params.ripeAtLedgerLength,
    })
  } catch (err) {
    // The reign must continue whether or not this works. A player whose
    // provider was down gets the sixteen authored petitions and no error.
    log.info('grievance_ripening.failed', { instanceId: params.instanceId, error: (err as Error).message })
    return null
  }
}
