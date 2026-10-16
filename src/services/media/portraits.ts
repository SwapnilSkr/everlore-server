import { ObjectId } from 'mongodb'
import { mongoColl } from '../../config/mongo'
import { identityKey, newFoldState } from '../character-codex.service'
import type { CharacterProfileDoc } from '../../models/character-profile.model'
import type { WorldInstanceDoc } from '../../models/world-instance.model'
import type { PortraitRef } from '../../models/media.model'

/**
 * Portrait placement and looks (contract §3). A portrait belongs where the
 * character belongs: world cast on the template, play-born characters on the
 * save's card, the player persona on `personas`. Made only on a tap, then kept.
 */

export type PortraitHolderKind = 'world_cast' | 'save_card' | 'persona'

export interface PortraitHolder {
  kind: PortraitHolderKind
  appearance: string
  appearanceVersion: number
  portrait?: PortraitRef
}

/** Only generated/authored faces may be animated or used as references.
 * A missing source counts as uploaded: older images have no record. */
export function isReferenceAllowed(source: string | undefined): boolean {
  return source === 'generated' || source === 'authored'
}

export function isPortraitCurrent(holder: PortraitHolder): boolean {
  return !!holder.portrait
    && isReferenceAllowed(holder.portrait.source)
    && holder.portrait.appearance_version >= holder.appearanceVersion
}

/**
 * Resolve whose face this is. A world character repainted in one save
 * overrides on that save's card only; the world's face is untouched.
 * The player's own card resolves to their persona ("give yourself a face").
 */
export async function resolvePortraitHolder(
  instance: WorldInstanceDoc,
  card: CharacterProfileDoc,
  opts: { isSentient: boolean; personaName?: string; personaId?: ObjectId },
): Promise<PortraitHolder> {
  const isPlayer = (!opts.isSentient && !!card.is_protagonist)
    || (!!opts.personaName && identityKey(card.canonical_name) === identityKey(opts.personaName))
  if (isPlayer && opts.personaId) {
    const persona = await mongoColl.personas().findOne({ _id: opts.personaId })
    if (persona) {
      return {
        kind: 'persona',
        appearance: persona.description || card.appearance || '',
        appearanceVersion: persona.appearance_version ?? 1,
        ...(persona.portrait ? { portrait: persona.portrait } : {}),
      }
    }
  }
  const template = await mongoColl.worldTemplates().findOne({ _id: instance.template_id })
  const entries = [
    ...(template?.seed_cast || []).map((e, i) => ({ name: e.name, path: `seed_cast.${i}` as const, entry: e })),
    ...(template?.is_sentient && template.protagonist
      ? [{ name: template.protagonist.name, path: 'protagonist' as const, entry: template.protagonist }]
      : []),
  ]
  const roster = newFoldState([card])
  const authored = entries.find((e) => roster.byName.get(identityKey(e.name)) === card)
  const authoredAppearance = authored?.entry.appearance || ''
  // A world face lives on the template from its first painting: the holder is
  // world_cast whether the portrait exists yet or not. A player's explicit
  // repaint still lands on that save's card only (storePortrait, repaintOfWorld).
  if (authored) {
    return {
      kind: 'world_cast',
      appearance: authored.entry.appearance || card.appearance || '',
      appearanceVersion: authored.entry.appearance_version ?? 1,
      ...(authored.entry.portrait && isReferenceAllowed(authored.entry.portrait.source)
        ? { portrait: authored.entry.portrait }
        : {}),
    }
  }
  return {
    kind: 'save_card',
    appearance: card.appearance || authoredAppearance,
    appearanceVersion: card.appearance_version ?? 1,
    ...(card.portrait && isReferenceAllowed(card.portrait.source) ? { portrait: card.portrait } : {}),
  }
}

/** Persist a fresh portrait and its look on the holder's home. A player
 * repaint of a world character lands on the save's card, never the world. */
export async function storePortrait(
  instance: WorldInstanceDoc,
  card: CharacterProfileDoc,
  holder: PortraitHolder,
  portrait: PortraitRef,
  appearance: string,
  opts: { personaId?: ObjectId; repaintOfWorld?: boolean },
): Promise<void> {
  const now = new Date()
  if (holder.kind === 'persona' && opts.personaId) {
    await mongoColl.personas().updateOne({ _id: opts.personaId }, {
      $set: { portrait, appearance_version: portrait.appearance_version, updated_at: now },
    })
    return
  }
  if (holder.kind === 'world_cast' && !opts.repaintOfWorld) {
    const template = await mongoColl.worldTemplates().findOne({ _id: instance.template_id })
    const roster = newFoldState([card])
    const index = (template?.seed_cast || []).findIndex((e) => roster.byName.get(identityKey(e.name)) === card)
    if (index >= 0) {
      await mongoColl.worldTemplates().updateOne({ _id: instance.template_id }, {
        $set: {
          [`seed_cast.${index}.portrait`]: portrait,
          [`seed_cast.${index}.appearance`]: appearance,
          [`seed_cast.${index}.appearance_version`]: portrait.appearance_version,
        },
      })
      return
    }
    if (template?.is_sentient && template.protagonist && roster.byName.get(identityKey(template.protagonist.name)) === card) {
      await mongoColl.worldTemplates().updateOne({ _id: instance.template_id }, {
        $set: {
          'protagonist.portrait': portrait,
          'protagonist.appearance': appearance,
          'protagonist.appearance_version': portrait.appearance_version,
        },
      })
      return
    }
  }
  await mongoColl.characters().updateOne({ _id: card._id, instance_id: instance._id }, {
    $set: { portrait, appearance, appearance_version: portrait.appearance_version, updated_at: now },
  })
}

/** Portrait cache identity: the look it was painted from. An out-of-date
 * portrait repaints on the next tap that needs it, using the old portrait
 * as the reference so it stays the same person. */
export function portraitCacheKey(cardId: ObjectId, version: number, model: string): string {
  return `portrait:${cardId.toHexString()}:v${version}:${model}`
}
