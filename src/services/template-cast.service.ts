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
  await characterCodexService.applyDeltas({ instanceId, playerId, sequence, deltas })
  return deltas.length
}
