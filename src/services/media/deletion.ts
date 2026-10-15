import type { Filter } from 'mongodb'
import { mongoColl } from '../../config/mongo'
import type { MediaAssetDoc } from '../../models/media.model'
import { storageService } from '../storage.service'

/** Fence running completions first; retain object keys if storage cleanup fails. */
export async function purgeMedia(filter: Filter<Pick<MediaAssetDoc, 'player_id' | 'instance_id' | 'event_id'>>): Promise<void> {
  await mongoColl.mediaAssets().updateMany(filter, { $set: { status: 'failed' } })
  const assets = await mongoColl.mediaAssets().find(filter).toArray()
  for (const asset of assets) if (asset.asset_key) await storageService.deleteStrict(asset.asset_key)
  await mongoColl.mediaAssets().deleteMany(filter)
  await mongoColl.mediaUsage().deleteMany(filter)
}
