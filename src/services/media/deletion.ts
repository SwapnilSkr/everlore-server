import type { Filter, ObjectId } from 'mongodb'
import { mongoColl } from '../../config/mongo'
import type { MediaAssetDoc } from '../../models/media.model'
import { storageService } from '../storage.service'

/** Fence running completions first; retain object keys if storage cleanup fails.
 * All asset kinds, including passing_face claims and ready faces, share this
 * purge. Handle-keyed faces have no event_id so rewinds retain them until the
 * save is deleted; event/line-keyed faces are removed with their event. */
export async function purgeMedia(filter: Filter<Pick<MediaAssetDoc, 'player_id' | 'instance_id' | 'event_id'>>, retainUsageFor?: ObjectId): Promise<void> {
  await mongoColl.mediaAssets().updateMany(filter, { $set: { status: 'failed' } })
  const assets = await mongoColl.mediaAssets().find(filter).toArray()
  for (const asset of assets) {
    if (asset.asset_key) await storageService.deleteStrict(asset.asset_key)
    // Scene-still inputs a failed cut never got to delete (item 5).
    for (const key of asset.still_keys || []) await storageService.deleteStrict(key)
  }
  await mongoColl.mediaAssets().deleteMany(filter)
  await mongoColl.mediaUsage().deleteMany(retainUsageFor ? { $and: [filter, { player_id: { $ne: retainUsageFor } }] } : filter)
  await mongoColl.mediaRejections().deleteMany(filter)
}

/** Save-card portrait objects die with the save (cards go in the same purge). */
export async function purgeCardPortraits(instanceId: ObjectId): Promise<void> {
  const cards = await mongoColl.characters().find({ instance_id: instanceId }).project({ portrait: 1 }).toArray()
  for (const card of cards) {
    const key = (card as { portrait?: { asset_key?: string } }).portrait?.asset_key
    if (key) await storageService.delete(key)
  }
}

/** World cast faces die with the world (shared by every save, owned by none). */
export async function purgeTemplatePortraits(templateId: ObjectId): Promise<void> {
  const template = await mongoColl.worldTemplates().findOne({ _id: templateId })
  if (!template) return
  const keys: string[] = []
  for (const entry of template.seed_cast || []) {
    if (entry.portrait?.asset_key) keys.push(entry.portrait.asset_key)
  }
  if (template.protagonist?.portrait?.asset_key) keys.push(template.protagonist.portrait.asset_key)
  for (const key of keys) await storageService.delete(key)
}
