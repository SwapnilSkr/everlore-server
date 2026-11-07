import sharp from 'sharp'
import { ObjectId } from 'mongodb'
import { mongoColl } from '../../config/mongo'
import { HttpError } from '../../utils/http-error'
import { parseObjectId } from '../../utils/mongo-id'
import { imageExtensionFor, ProviderRefusalError } from '../../ai/image'
import { encodeGeneratedStill, encodeImageThumb, PORTRAIT_THUMB_WIDTH, thumbKey } from '../../utils/image-encoding'
import type { MediaAssetDoc, PortraitRef } from '../../models/media.model'
import { mediaRevision } from '../media/attribution'
import { imageModel, mediaEnabled } from '../media/config'
import { utcMediaDay } from '../media/policy'
import { portraitUrl } from '../media/portraits'
import { failMedia, mediaEffects } from '../media/service'
import { settleMedia, reserveMedia } from '../media/usage'
import {
  generatePortraitBytes, insertAsset, providerReason, RESTING_COPY, UnseenError, unseeMedia, visualEffects,
} from '../media/visual'
import { resolveMediaStyle } from '../image.service'

/**
 * A player-made group's faces. Every person is painted in the anime style the
 * catalog groups use, so the door, the card and the chat all show one look.
 */
export const GROUP_FACE_STYLE = resolveMediaStyle('anime')

/** The prose revision a face is fenced by: a changed look, a new repaint. */
const GROUP_FACE_REVISION_INPUT = 'group-face'

export type GroupFaceReply = { status: 'ready'; url: string } | { status: 'queued'; media_id: string }

/**
 * Paints one person of a player's group from their written look.
 *
 * A keeper of the group only: a stranger's group, a world and a missing one
 * all read as not found. A face is painted once per look; a repaint is a new
 * row under a fresh key, so it never meets the face it replaces.
 */
export async function requestGroupFace(
  playerId: string, templateId: string, index: number, opts: { repaint?: boolean } = {},
): Promise<GroupFaceReply> {
  if (!mediaEnabled('portrait')) throw new HttpError(404, 'That moment could not be found.')
  const pid = parseObjectId(playerId), tid = parseObjectId(templateId)
  const template = await mongoColl.worldTemplates().findOne({ _id: tid, creator_id: pid, kind: 'group' })
  if (!template) throw new HttpError(404, 'That group could not be found.')
  const entry = template.seed_cast?.[index]
  if (!entry) throw new HttpError(404, 'That person could not be found.')
  const appearance = (entry.appearance || '').trim()
  if (!appearance) throw new HttpError(422, 'This moment stays unseen.')
  const revision = mediaRevision(appearance, GROUP_FACE_REVISION_INPUT)
  // A face already painted from this look is kept: it costs nothing and takes
  // no slot. An explicit repaint never reads it.
  if (!opts.repaint && entry.portrait?.art_style === GROUP_FACE_STYLE.key && entry.portrait.asset_key) {
    const painted = await mongoColl.mediaAssets().findOne({
      asset_key: entry.portrait.asset_key, template_id: tid, revision, status: 'ready',
    })
    if (painted) return { status: 'ready', url: portraitUrl(entry.portrait.asset_key) }
  }
  const model = imageModel()
  const key = `groupface:${tid.toHexString()}:${entry.name.trim().toLowerCase()}:${revision}:${model}`
    + (opts.repaint ? `:r${new ObjectId().toHexString()}` : '')
  const cached = await mongoColl.mediaAssets().findOne({ cache_key: key, status: 'ready' })
  if (cached?.url && cached.template_id?.equals(tid) && cached.revision === revision) {
    return { status: 'ready', url: cached.url }
  }
  const asset = await insertAsset({
    player_id: pid, template_id: tid, cast_name: entry.name, kind: 'portrait', line_id: '',
    source: 'generated', model, cache_key: key, revision, input: appearance.slice(0, 500),
    cost_usd: 0.009, cost_source: 'catalogue', status: 'queued', art_style: GROUP_FACE_STYLE.key,
  })
  if (!asset) throw new HttpError(422, 'This moment stays unseen.')
  if (asset.status === 'ready' && asset.url && asset.template_id?.equals(tid)) {
    return { status: 'ready', url: asset.url }
  }
  if (!await reserveMedia({ _id: asset._id, player_id: pid, kind: 'portrait' })) {
    await mongoColl.mediaAssets().deleteOne({ _id: asset._id })
    throw new HttpError(429, RESTING_COPY.portrait, { status: 'resting', kind: 'portrait', resets_at: utcMediaDay().resets_at })
  }
  // The worker routes on the media id alone; the group rides along so the job
  // can be traced back to the template it belongs to.
  await visualEffects.enqueue('portrait', asset, tid.toHexString())
  return { status: 'queued', media_id: asset._id.toHexString() }
}

/**
 * The queued face job. It paints nothing unless the look it was queued for is
 * still on the group: a look edited, a person renamed or a group deleted while
 * the face waited fails the job and leaves the group untouched.
 *
 * A face written onto a public, approved group sends it back to review in the
 * same write, exactly as a meaningful edit does: the players who approved it
 * never saw this person.
 */
export async function processGroupFace(asset: MediaAssetDoc): Promise<void> {
  let uploaded: string[] = []
  let stage = 'prepare'
  try {
    const reservation = await mongoColl.mediaUsage().findOne({ _id: asset._id, status: 'reserved' })
    if (!reservation) throw new Error('Face no longer reserved')
    if (!asset.template_id || !asset.cast_name) throw new Error('Face subject missing')
    const template = await mongoColl.worldTemplates().findOne({
      _id: asset.template_id, creator_id: asset.player_id, kind: 'group',
    })
    if (!template) throw new Error('Group removed')
    const cast = template.seed_cast || []
    const index = cast.findIndex(entry => entry.name.trim().toLowerCase() === asset.cast_name!.trim().toLowerCase())
    if (index < 0) throw new Error('Person removed')
    const member = cast[index]!
    const appearance = (member.appearance || '').trim()
    if (mediaRevision(appearance, GROUP_FACE_REVISION_INPUT) !== asset.revision) {
      throw new Error('The group changed while this face was painted')
    }
    stage = 'paint'
    let image: Awaited<ReturnType<typeof generatePortraitBytes>>
    try {
      // No reference: nobody has painted this person before.
      image = await generatePortraitBytes(appearance, member.name, '', asset.model, GROUP_FACE_STYLE.render)
    } catch (error) {
      if (error instanceof UnseenError) {
        await unseeMedia(asset, error.stage, error.reason)
        return
      }
      if (error instanceof ProviderRefusalError) {
        await unseeMedia(asset, 'provider', providerReason(error), undefined, { message: error.message, status: error.status })
        return
      }
      throw error
    }
    const stored = await encodeGeneratedStill(image, 'portrait')
    const key = `media/portrait/player-group/${asset.player_id.toHexString()}/${asset.template_id.toHexString()}`
      + `/${asset._id.toHexString()}${imageExtensionFor(stored.contentType)}`
    const staged = await mongoColl.mediaAssets().updateOne({ _id: asset._id, status: 'processing' }, { $set: { asset_key: key } })
    if (!staged.matchedCount) throw new Error('Face removed')
    stage = 'upload'
    uploaded = [key]
    const result = await visualEffects.upload(stored.data, stored.contentType, { key })
    uploaded = [result.key]
    // The small copy is an avatar; a failed one leaves the face without one,
    // which costs the player nothing.
    let smallKey: string | undefined
    const small = thumbKey(result.key, PORTRAIT_THUMB_WIDTH)
    if (small) {
      uploaded.push(small)
      try {
        const thumb = await encodeImageThumb(sharp(stored.data), PORTRAIT_THUMB_WIDTH)
        smallKey = (await visualEffects.upload(thumb, 'image/webp', { key: small })).key
      } catch { smallKey = undefined }
    }
    const now = new Date()
    const portrait: PortraitRef = {
      asset_key: result.key, source: 'generated', appearance_version: 1,
      art_style: GROUP_FACE_STYLE.key, painted_at: now,
      ...(smallKey ? { thumb_key: smallKey } : {}),
    }
    // One write, fenced on the person and the look that were painted: a group
    // edited meanwhile keeps its newer version and this face is dropped.
    stage = 'save'
    const written = await mongoColl.worldTemplates().updateOne({
      _id: template._id,
      creator_id: asset.player_id,
      [`seed_cast.${index}.name`]: member.name,
      [`seed_cast.${index}.appearance`]: member.appearance,
    }, {
      $set: {
        [`seed_cast.${index}.portrait`]: portrait,
        updated_at: now,
        ...(template.visibility === 'public' && template.review_status === 'approved'
          ? { review_status: 'pending', submitted_at: now, ever_approved: true }
          : {}),
      },
    })
    if (!written.matchedCount) throw new Error('The group changed while this face was painted')
    // The group now shows these files: a later failure must not delete them.
    uploaded = []
    const cost = image.costUsd ?? asset.cost_usd
    const saved = await mongoColl.mediaAssets().updateOne({ _id: asset._id, status: 'processing' }, {
      $set: {
        status: 'ready', asset_key: result.key, url: result.url, cost_usd: cost,
        ...(image.generationId ? { generation_id: image.generationId } : {}),
      },
    })
    if (!saved.modifiedCount) throw new Error('Face removed')
    await settleMedia(asset._id)
    await mediaEffects.publish(asset.player_id.toHexString(), {
      type: 'media_ready',
      media_id: asset._id.toHexString(),
      kind: asset.kind,
      url: result.url,
      template_id: asset.template_id.toHexString(),
      cast_name: asset.cast_name,
    }).catch(() => {})
  } catch (error) {
    for (const key of uploaded) {
      try { await mediaEffects.remove(key) } catch { /* retained for maintenance */ }
    }
    await failMedia(asset, { stage, message: error instanceof Error ? error.message : String(error) })
  }
}
