import { createHash } from 'crypto'
import { mongoColl } from '../../config/mongo'
import { identityKey, newFoldState } from '../character-codex.service'
import type { CharacterProfileDoc } from '../../models/character-profile.model'
import type { WorldInstanceDoc } from '../../models/world-instance.model'
import type { ProtagonistDoc, TemplateCastCharacterDoc, WorldTemplateDoc } from '../../models/world-template.model'
import type { CharacterVoice, VoiceTraits } from '../../models/media.model'
import { chooseVoice, type VoiceHolder } from './policy'
import { voiceCatalogue, voiceModel } from './config'

export const castKey = (card: Pick<CharacterProfileDoc, 'canonical_name' | 'identity_scope'>) =>
  createHash('sha256').update(identityKey(card.canonical_name, card.identity_scope)).digest('hex')

/** The world's authored cast: seed cast, plus the protagonist of a sentient world. */
export function authoredCast(template: WorldTemplateDoc | null): Array<TemplateCastCharacterDoc | ProtagonistDoc> {
  return [...(template?.seed_cast || []), ...(template?.is_sentient && template.protagonist ? [template.protagonist] : [])]
}

/** A virtual world plan reserves future cast voices without assigning untapped cards. */
function planWorldVoices(original: WorldTemplateDoc): WorldTemplateDoc {
  const template: WorldTemplateDoc = { ...original, seed_cast: original.seed_cast?.map((entry) => ({ ...entry })),
    ...(original.protagonist ? { protagonist: { ...original.protagonist } } : {}),
  }
  const entries = authoredCast(template)
  if (entries.every((entry) => entry.voice)) return template
  const model = voiceModel(), catalogue = voiceCatalogue(model)
  const holders: VoiceHolder[] = entries.flatMap((entry) => entry.voice?.model === model ? [{ voice_id: entry.voice.voice_id }] : [])
  for (const entry of entries) {
    if (entry.voice) continue
    entry.voice = { model, voice_id: chooseVoice(entry.voice_traits || {}, holders, catalogue.voices) }
    holders.push({ voice_id: entry.voice.voice_id })
  }
  return template
}

export async function castCharacter(instance: WorldInstanceDoc, card: CharacterProfileDoc, traits: VoiceTraits = {}): Promise<CharacterVoice> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const [live, original, cards] = await Promise.all([
      mongoColl.worldInstances().findOne({ _id: instance._id }),
      mongoColl.worldTemplates().findOne({ _id: instance.template_id }),
      mongoColl.characters().find({ instance_id: instance._id }).toArray(),
    ])
    if (!live || !original) throw new Error('Story removed')
    const fresh = cards.find((c) => c._id.equals(card._id))
    if (!fresh) throw new Error('Speaker removed')
    const id = castKey(fresh), roster = newFoldState([fresh])
    const originalEntries = authoredCast(original)
    const identityKeys = new Set([fresh.canonical_name, ...(fresh.aliases || [])].map((name) => castKey({ canonical_name: name, identity_scope: fresh.identity_scope })))
    const existing = originalEntries.find((entry) => roster.byName.get(identityKey(entry.name)) === fresh)?.voice
      || Object.entries(live.media_voice_cast || {}).find(([key]) => identityKeys.has(key))?.[1].voice || fresh.voice
    if (existing) {
      await mongoColl.characters().updateOne({ _id: fresh._id, instance_id: live._id }, { $set: { voice: existing } })
      return existing
    }
    const template = planWorldVoices(original)
    const entries = authoredCast(template)
    const authored = entries.find((entry) => roster.byName.get(identityKey(entry.name)) === fresh)
    if (authored) {
      const index = (template.seed_cast || []).indexOf(authored)
      const prior = index >= 0 ? original.seed_cast?.[index]?.voice : original.protagonist?.voice
      if (!prior) {
        const path = index >= 0 ? `seed_cast.${index}.voice` : 'protagonist.voice'
        const assigned = await mongoColl.worldTemplates().updateOne({ _id: original._id,
          seed_cast: original.seed_cast || { $exists: false }, protagonist: original.protagonist || { $exists: false },
        }, { $set: { [path]: authored.voice } })
        if (!assigned.modifiedCount) continue
      }
      await mongoColl.characters().updateOne({ _id: fresh._id, instance_id: live._id }, { $set: { voice: authored.voice! } })
      return authored.voice!
    }
    const model = voiceModel(), catalogue = voiceCatalogue(model)
    const holders: VoiceHolder[] = [
      ...cards.flatMap((c) => c.voice?.model === model ? [{ voice_id: c.voice.voice_id, last_spoken_at: c.last_spoken_at }] : []),
      ...Object.entries(live.media_voice_cast || {}).filter(([key]) => cards.some((c) =>
        [c.canonical_name, ...(c.aliases || [])].some((name) => castKey({ canonical_name: name, identity_scope: c.identity_scope }) === key),
      )).flatMap(([, c]) => c.voice.model === model ? [{ voice_id: c.voice.voice_id, last_spoken_at: c.last_spoken_at }] : []),
      ...entries.flatMap((e) => e.voice?.model === model ? [{ voice_id: e.voice.voice_id }] : []),
    ]
    const recent = await mongoColl.mediaAssets().find({ instance_id: live._id, kind: 'voice', model, status: 'ready' }).sort({ created_at: -1 }).toArray()
    for (const holder of holders) holder.last_spoken_at = recent.find((a) => a.voice_id === holder.voice_id)?.created_at || holder.last_spoken_at
    const voice: CharacterVoice = { model, voice_id: chooseVoice(effectiveTraits(fresh, traits), holders, catalogue.voices) }
    const assigned = await mongoColl.worldInstances().updateOne({ _id: live._id,
      media_voice_cast: live.media_voice_cast || { $exists: false },
    }, { $set: { [`media_voice_cast.${id}.voice`]: voice } })
    if (!assigned.modifiedCount) continue
    // The first cast persists the traits it cast by; later casts never
    // overwrite them, so casting is stable once persisted.
    await mongoColl.characters().updateOne({ _id: fresh._id, instance_id: live._id }, { $set: {
      voice, ...(!hasTraits(fresh) && Object.keys(traits).length ? { voice_traits: traits } : {}),
    } })
    return voice
  }
  throw new Error('Cast changed repeatedly')
}

/** Traits already on the card, if any. */
function hasTraits(card: CharacterProfileDoc): boolean {
  return !!card.voice_traits && Object.keys(card.voice_traits).length > 0
}

/** The card's own traits win; the attribution call's traits fill a blank card. */
function effectiveTraits(card: CharacterProfileDoc, traits: VoiceTraits): VoiceTraits {
  return hasTraits(card) ? card.voice_traits! : traits
}
