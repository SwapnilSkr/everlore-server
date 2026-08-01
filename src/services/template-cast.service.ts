import type { WorldTemplateDoc } from '../models/world-template.model'
import { characterCodexService, type CharacterCodexDelta } from './character-codex.service'

/** Convert immutable template definitions into sequence-zero Codex deltas. */
export function templateCastDeltas(
  template: Pick<WorldTemplateDoc, 'seed_cast' | 'protagonist'>,
): CharacterCodexDelta[] {
  const protagonist = String(template.protagonist?.name || '').trim().toLowerCase()
  return (template.seed_cast || [])
    .filter((character) => character.name.trim() && character.name.trim().toLowerCase() !== protagonist)
    .slice(0, 12)
    .map((character) => ({
      name: character.name,
      identity_kind: character.identity_kind,
      aliases: character.aliases || [],
      role: character.role,
      appearance: character.appearance,
      persona: character.persona,
      immutable_facts: character.immutable_facts || [],
      relationship_initialization: character.relationship_initialization,
      relationship_state: character.relationship_state,
    }))
}

/** Copy an authored template cast into one independent instance codex. */
export async function materializeTemplateCast(params: {
  template: Pick<WorldTemplateDoc, 'seed_cast' | 'protagonist'>
  instanceId: string
  playerId: string
  sequence?: number
}): Promise<number> {
  const { template, instanceId, playerId, sequence = 0 } = params
  const deltas = templateCastDeltas(template)
  if (!deltas.length) return 0
  // Materialization is a sequence-zero seed operation, never an ordinary
  // character encounter. Replaying it onto an existing card would reset that
  // card's last_seen sequence and inflate its mention count, which in turn
  // corrupts codex ranking/presence surfaces after a migration or checkpoint.
  const existing = await characterCodexService.listForInstance(instanceId, 200)
  const known = new Set(
    existing.flatMap((card) => [card.canonical_name, ...(card.aliases || [])])
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  )
  const missing = deltas.filter((delta) =>
    ![delta.name, ...(delta.aliases || [])].some((name) => known.has(name.trim().toLowerCase())),
  )
  if (!missing.length) return 0
  await characterCodexService.applyDeltas({ instanceId, playerId, sequence, deltas: missing })
  return missing.length
}
