import { mongoColl } from '../../config/mongo'
import type { CharacterProfileDoc } from '../../models/character-profile.model'
import type { WorldInstanceDoc } from '../../models/world-instance.model'
import type { WorldTemplateDoc } from '../../models/world-template.model'
import { identityKey, newFoldState } from '../character-codex.service'
import { authoredCast } from './casting'

/** Read existing looks before bounded narration; personality never supplies a face. */
export async function portraitLookEvidence(
  instance: WorldInstanceDoc, card: CharacterProfileDoc, template: WorldTemplateDoc | null,
): Promise<{ appearance: string; prose: string; persona: string }> {
  const roster = newFoldState([card])
  const authored = authoredCast(template).find((entry) => roster.byName.get(identityKey(entry.name)) === card)
  const appearance = card.appearance?.trim() || authored?.appearance?.trim() || ''
  const persona = authored?.persona?.trim() || ''
  if (appearance) return { appearance, prose: '', persona }

  const turns = await mongoColl.events().find({ instance_id: instance._id, player_id: instance.player_id }, {
    projection: { 'data.ai_response': 1, 'data.present_characters': 1 },
  }).sort({ sequence: -1, _id: -1 }).limit(30).toArray()
  const names = [card.canonical_name, ...(card.aliases || [])].map((name) => identityKey(name)).filter(Boolean)
  const parts: string[] = []
  let remaining = 6000
  for (const turn of turns) {
    const prose = turn.data.ai_response || ''
    const present = turn.data.present_characters?.some((name) => roster.byName.get(identityKey(name)) === card)
    const narrator = template?.is_sentient && !!card.is_protagonist
    if (!present && !narrator && !names.some((name) => identityKey(prose).includes(name))) continue
    const text = prose.trim().slice(0, remaining)
    if (!text) continue
    parts.push(text)
    remaining -= text.length + 2
    if (remaining <= 0) break
  }
  return { appearance: '', prose: parts.join('\n\n'), persona }
}
