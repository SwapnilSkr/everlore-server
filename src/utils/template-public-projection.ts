import type { AuthUser } from '../middleware/auth'
import type { WorldTemplateDoc, WorldTemplateSummaryDoc } from '../models/world-template.model'
import { idString } from './mongo-id'

const PUBLIC_TEMPLATE_KEYS = [
  '_id', 'slug', 'title', 'description', 'kind', 'genre', 'image_url', 'image_thumb_url',
  'global_lore', 'base_stats_template', 'opening_line', 'narrative_style', 'scene_tags',
  'is_nsfw_capable', 'is_sentient', 'is_published', 'creator_id', 'version',
  'created_at', 'updated_at', 'visibility', 'review_status',
] as const satisfies readonly (keyof WorldTemplateDoc)[]

type PublicTemplateKey = typeof PUBLIC_TEMPLATE_KEYS[number]
export type PublicTemplateDoc = Pick<WorldTemplateDoc, PublicTemplateKey>

/** New authoring fields stay private unless explicitly added to this list. */
export function publicTemplate<T extends Partial<WorldTemplateDoc>>(
  template: T,
): Pick<T, Extract<keyof T, PublicTemplateKey>> {
  return Object.fromEntries(
    PUBLIC_TEMPLATE_KEYS
      .filter((key) => Object.prototype.hasOwnProperty.call(template, key))
      .map((key) => [key, template[key]]),
  ) as Pick<T, Extract<keyof T, PublicTemplateKey>>
}

/**
 * The template summary carried on instance rows ("Your Realms", the realm's
 * stories, the home feed). `image_thumb_url` is the 540 px WebP stored beside
 * the cover, so a card never downloads the full image; it is absent on worlds
 * that published none.
 */
export type InstanceTemplateSummary = WorldTemplateSummaryDoc & { image_thumb_url?: string }

/** The fields every instance row's template summary is projected from. Mongo
 *  inclusion projections leave a missing field out entirely, which is how a
 *  world without a thumbnail arrives without the key rather than as null. */
export const TEMPLATE_SUMMARY_PROJECTION = {
  _id: 1,
  title: 1,
  is_sentient: 1,
  description: 1,
  kind: 1,
  image_url: 1,
  image_thumb_url: 1,
} as const

type TemplateSummarySource = Pick<
  WorldTemplateDoc,
  '_id' | 'title' | 'is_sentient' | 'description' | 'kind'
> & { image_url?: string; image_thumb_url?: string }

/** Shape a template row into the summary an instance row carries. A missing or
 *  empty thumbnail is left out, never sent as null or "". */
export function templateSummary(template: TemplateSummarySource): InstanceTemplateSummary {
  const { _id, title, is_sentient, description, kind, image_url, image_thumb_url } = template
  return {
    _id, title, is_sentient, description, kind, image_url,
    ...(image_thumb_url ? { image_thumb_url } : {}),
  }
}

/** isAdmin must come from verified admin authentication, never a player tier. */
export function canReadTemplateAuthoring(
  template: Pick<WorldTemplateDoc, 'creator_id'>,
  user: Pick<AuthUser, 'id'> | null,
  isAdmin = false,
): boolean {
  return isAdmin || Boolean(user && idString(template.creator_id) === user.id)
}
