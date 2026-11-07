import type { ObjectId } from 'mongodb'
import type { WorldTemplateDoc } from '../../models/world-template.model'
import { idString } from '../../utils/mongo-id'
import { portraitUrl } from '../media/portraits'

type AuthoringTemplate = Omit<Partial<WorldTemplateDoc>, '_id'> & { _id?: ObjectId | string }
type AuthoringMember = NonNullable<WorldTemplateDoc['seed_cast']>[number]

/**
 * The owner's own read of a saved group, for editing it. Every field the form
 * sends back is here; what the player must never be sent as an internal key —
 * a face's stored asset name — travels as a URL instead. Absent fields are
 * omitted, never written as an explicit null.
 */
export function groupAuthoringView(template: AuthoringTemplate): Record<string, unknown> {
  const view: Record<string, unknown> = {}
  const put = (key: string, value: unknown): void => {
    if (value !== undefined && value !== null) view[key] = value
  }
  put('_id', template._id === undefined ? undefined : idString(template._id))
  put('kind', template.kind)
  put('title', template.title)
  put('description', template.description)
  put('is_nsfw_capable', template.is_nsfw_capable)
  put('is_published', template.is_published)
  put('visibility', template.visibility)
  put('review_status', template.review_status)
  put('image_url', template.image_url)
  put('image_thumb_url', template.image_thumb_url)
  put('seed_prompt', template.seed_prompt)
  put('global_lore', template.global_lore)
  put('topics', template.topics)
  put('opening_lines', template.opening_lines)
  if (template.seed_cast !== undefined) view.seed_cast = template.seed_cast.map(authoringMember)
  return view
}

function authoringMember(member: AuthoringMember): Record<string, unknown> {
  const { portrait, ...person } = member
  const face = portrait as { asset_key?: string; thumb_key?: string } | undefined
  return {
    ...person,
    ...(typeof face?.asset_key === 'string' ? { portrait_url: portraitUrl(face.asset_key) } : {}),
    ...(typeof face?.thumb_key === 'string' ? { portrait_thumb_url: portraitUrl(face.thumb_key) } : {}),
  }
}
