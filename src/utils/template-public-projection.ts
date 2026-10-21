import type { AuthUser } from '../middleware/auth'
import type { WorldTemplateDoc } from '../models/world-template.model'
import { idString } from './mongo-id'

const PUBLIC_TEMPLATE_KEYS = [
  '_id', 'slug', 'title', 'description', 'kind', 'image_url', 'global_lore',
  'base_stats_template', 'opening_line', 'narrative_style', 'scene_tags',
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

/** isAdmin must come from verified admin authentication, never a player tier. */
export function canReadTemplateAuthoring(
  template: Pick<WorldTemplateDoc, 'creator_id'>,
  user: Pick<AuthUser, 'id'> | null,
  isAdmin = false,
): boolean {
  return isAdmin || Boolean(user && idString(template.creator_id) === user.id)
}
