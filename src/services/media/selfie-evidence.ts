import { ObjectId } from 'mongodb'
import { asMediaImageReference, imageExtensionFor } from '../../ai/image'
import { visualEffects } from './visual'
import { mediaEffects } from './service'

/** Evidence has its own object, outside every event/save/account media purge.
 * Reports retain it under the existing moderation retention policy. */
export async function snapshotSelfieImage(url: string): Promise<{ key: string; url: string }> {
  const image = asMediaImageReference(await visualEffects.download(url))
  const key = `moderation/selfies/${new ObjectId()}${imageExtensionFor(image.contentType)}`
  try { return await visualEffects.upload(image.data, image.contentType, { key }) }
  catch (error) { await mediaEffects.remove(key); throw error }
}
