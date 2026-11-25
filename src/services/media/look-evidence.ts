import { mongoColl } from '../../config/mongo'
import type { CharacterProfileDoc } from '../../models/character-profile.model'
import type { WorldInstanceDoc } from '../../models/world-instance.model'
import type { WorldTemplateDoc } from '../../models/world-template.model'
import { identityKey, newFoldState } from '../character-codex.service'
import { authoredCast } from './casting'
import { witnessOf, WITNESS_PROJECTION } from '../../utils/witness'

/**
 * The prose a portrait's appearance is read from: the newest turns the card is
 * present in or named in, bounded to 6000 chars. Read through `witnessOf` — a
 * look decides what a face shows, so it reads the English copy the rest of the
 * engine decided on (§4); native prose is display only.
 */
export function lookEvidenceProse(
  turns: Array<{ data?: { present_characters?: string[]; ai_response?: string } }>,
  isRelevant: (prose: string, present: string[] | undefined) => boolean,
): string {
  const parts: string[] = []
  let remaining = 6000
  for (const turn of turns) {
    const prose = witnessOf(turn).ai_response || ''
    if (!isRelevant(prose, turn.data?.present_characters)) continue
    const text = prose.trim().slice(0, remaining)
    if (!text) continue
    parts.push(text)
    remaining -= text.length + 2
    if (remaining <= 0) break
  }
  return parts.join('\n\n')
}

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
    projection: { 'data.ai_response': 1, 'data.present_characters': 1, ...WITNESS_PROJECTION },
  }).sort({ sequence: -1, _id: -1 }).limit(30).toArray()
  const names = [card.canonical_name, ...(card.aliases || [])].map((name) => identityKey(name)).filter(Boolean)
  const narrator = template?.is_sentient && !!card.is_protagonist
  const prose = lookEvidenceProse(turns, (text, present) =>
    !!present?.some((name) => roster.byName.get(identityKey(name)) === card) ||
    !!narrator ||
    names.some((name) => identityKey(text).includes(name)))
  return { appearance: '', prose, persona }
}
