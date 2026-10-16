import type { ObjectId } from 'mongodb'
import { mongoColl } from '../config/mongo'
import type { CharacterProfileDoc } from '../models/character-profile.model'
import type { MediaAssetDoc } from '../models/media.model'
import { identityKey, newFoldState } from './character-codex.service'
import { storageService } from './storage.service'

export interface CodexMediaSnapshot {
  instanceId: ObjectId
  cards: CharacterProfileDoc[]
  portraits: MediaAssetDoc[]
  sharedPortraitKeys: Set<string>
}

/** Capture before the first destructive write, including checkpoint attempts:
 * a failed checkpoint may fall back to a full fold of the same ledger. */
export async function snapshotCodexMedia(instanceId: ObjectId): Promise<CodexMediaSnapshot> {
  const [cards, portraits, instance] = await Promise.all([
    mongoColl.characters().find({ instance_id: instanceId }).toArray(),
    mongoColl.mediaAssets().find({ instance_id: instanceId, kind: 'portrait' }).toArray(),
    mongoColl.worldInstances().findOne({ _id: instanceId }, { projection: { template_id: 1 } }),
  ])
  const template = instance ? await mongoColl.worldTemplates().findOne({ _id: instance.template_id }, {
    projection: { 'seed_cast.portrait': 1, 'protagonist.portrait': 1 },
  }) : null
  // Portrait rows can record the request that painted a template's shared face.
  // Removing that save-local row must never delete the template's object.
  const sharedPortraitKeys = new Set([
    ...(template?.seed_cast || []).flatMap((entry) => entry.portrait ? [entry.portrait.asset_key] : []),
    ...(template?.protagonist?.portrait ? [template.protagonist.portrait.asset_key] : []),
  ])
  return { instanceId, cards, portraits, sharedPortraitKeys }
}

/** The ledger owns facts; only these non-ledger fields cross the rebuild. */
export async function restoreCodexMedia(snapshot: CodexMediaSnapshot): Promise<void> {
  const { instanceId, cards: prior } = snapshot
  const rebuilt = await mongoColl.characters().find({ instance_id: instanceId }).toArray()
  const byName = newFoldState(prior).byName
  const matched = new Set<CharacterProfileDoc>()
  const matches = new Map<CharacterProfileDoc, CharacterProfileDoc>()

  // Resolve scoped keys before the fold's bare-name fallback, so a shared label
  // cannot steal the face belonging to another scope.
  for (const fallback of [false, true]) {
    for (const card of rebuilt) {
      if (matches.has(card)) continue
      for (const name of [card.canonical_name, ...(card.aliases || [])]) {
        const old = byName.get(identityKey(name, fallback ? undefined : card.identity_scope))
        if (!old || matched.has(old)) continue
        if (old.identity_scope && card.identity_scope && old.identity_scope !== card.identity_scope) continue
        matches.set(card, old)
        matched.add(old)
        break
      }
    }
  }

  // Learning a proper name releases the old label from resolvable aliases.
  // Rewinding before that reveal can still identify its original holder by
  // the ledger's birth sequence; ambiguous historical labels never claim a face.
  for (const card of rebuilt) {
    if (matches.has(card)) continue
    const candidates = prior.filter((old) => !matched.has(old)
      && old.first_seen_sequence === card.first_seen_sequence
      && (!old.identity_scope || !card.identity_scope || old.identity_scope === card.identity_scope)
      && ((old.former_labels || []).some((label) => identityKey(label) === identityKey(card.canonical_name))
        || (card.former_labels || []).some((label) => identityKey(label) === identityKey(old.canonical_name))))
    if (candidates.length === 1) {
      matches.set(card, candidates[0])
      matched.add(candidates[0])
    }
  }

  for (const [card, old] of matches) {
    const media = {
      ...(old.portrait != null ? { portrait: old.portrait } : {}),
      ...(old.voice != null ? { voice: old.voice } : {}),
      ...(old.voice_traits != null ? { voice_traits: old.voice_traits } : {}),
    }
    if (Object.keys(media).length) {
      await mongoColl.characters().updateOne({ _id: card._id, instance_id: instanceId }, { $set: media })
    }
    // Use stable asset ids: a partial carry-over may already have moved some
    // rows before a checkpoint failure triggers the full-ledger fallback.
    const assets = snapshot.portraits.filter((asset) => asset.character_id?.equals(old._id))
    const prefix = `portrait:${old._id.toHexString()}:`
    for (const asset of assets) {
      // Preserve version, style, model and any failed-job suffix byte for byte.
      const cacheKey = asset.cache_key.startsWith(prefix)
        ? `portrait:${card._id.toHexString()}:${asset.cache_key.slice(prefix.length)}`
        : asset.cache_key
      await mongoColl.mediaAssets().updateOne({ _id: asset._id }, {
        $set: { character_id: card._id, cache_key: cacheKey },
      })
    }
  }

  for (const old of prior) {
    if (matched.has(old)) continue
    const assets = snapshot.portraits.filter((asset) => asset.character_id?.equals(old._id))
    const keys = new Set(assets.flatMap((asset) => asset.asset_key ? [asset.asset_key] : []))
    if (old.portrait?.asset_key) keys.add(old.portrait.asset_key)
    // A failed delete must retain the asset rows as a cleanup receipt.
    for (const key of keys) {
      if (!snapshot.sharedPortraitKeys.has(key)) await storageService.deleteStrict(key)
    }
    await mongoColl.mediaAssets().deleteMany({ instance_id: instanceId, kind: 'portrait', _id: { $in: assets.map((asset) => asset._id) } })
  }

  // A previous failed cleanup may have left a receipt after its card was gone.
  const knownIds = new Set([...prior, ...rebuilt].map((card) => card._id.toHexString()))
  for (const asset of snapshot.portraits) {
    if (!asset.character_id || knownIds.has(asset.character_id.toHexString())) continue
    if (asset.asset_key && !snapshot.sharedPortraitKeys.has(asset.asset_key)) await storageService.deleteStrict(asset.asset_key)
    await mongoColl.mediaAssets().deleteMany({ instance_id: instanceId, kind: 'portrait', _id: asset._id })
  }
}
