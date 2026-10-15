import { isDeepStrictEqual } from 'node:util'
import type { WorldTemplateDoc } from '../models/world-template.model'

export const MEANINGFUL_WORLD_FIELDS = [
  'title', 'description', 'image_url', 'seed_prompt', 'global_lore',
  'opening_line', 'protagonist', 'seed_cast', 'is_nsfw_capable', 'kind',
  'is_sentient',
] as const

/** Missing review fields on a published legacy world mean public and approved. */
export function isWorldListed(world: Pick<WorldTemplateDoc, 'is_published' | 'visibility' | 'review_status' | 'moderation_status'>): boolean {
  return world.is_published && world.moderation_status !== 'hidden' &&
    (world.visibility === undefined ||
      (world.visibility === 'public' && world.review_status === 'approved'))
}

export function discoveryReviewFilter(): Record<string, unknown> {
  return {
    $or: [
      { visibility: { $exists: false } },
      { visibility: 'public', review_status: 'approved' },
    ],
  }
}

export function hasMeaningfulWorldEdit(
  existing: WorldTemplateDoc,
  patch: Record<string, unknown>,
): boolean {
  return MEANINGFUL_WORLD_FIELDS.some((field) =>
    Object.prototype.hasOwnProperty.call(patch, field) &&
    !isDeepStrictEqual(patch[field], existing[field]),
  )
}

export function publishReviewUpdate(
  world: WorldTemplateDoc,
  visibility: 'private' | 'public' = 'private',
  now: Date = new Date(),
) {
  const alreadyApproved = world.is_published &&
    (world.visibility === undefined ||
      (world.visibility === 'public' && world.review_status === 'approved'))
  const everApproved = world.ever_approved === true || alreadyApproved
  if (visibility === 'private') {
    return {
      $set: { is_published: true, visibility, updated_at: now, ...(everApproved ? { ever_approved: true } : {}) },
      $unset: { review_status: '' as const, review_note: '' as const, submitted_at: '' as const, reviewed_at: '' as const, reviewed_by: '' as const },
      $inc: { version: 1 },
    }
  }
  return {
    $set: {
      is_published: true,
      visibility,
      review_status: alreadyApproved ? 'approved' as const : 'pending' as const,
      submitted_at: now,
      updated_at: now,
      ...(everApproved ? { ever_approved: true } : {}),
    },
    $unset: { review_note: '' as const },
    $inc: { version: 1 },
  }
}
