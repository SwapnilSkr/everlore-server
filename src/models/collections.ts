/**
 * Canonical MongoDB collection names. Index definitions and all DAO access must use these
 * so collection strings never drift apart.
 */
export const COLLECTIONS = {
  users: 'users',
  world_templates: 'world_templates',
  world_instances: 'world_instances',
  events: 'events',
  memories: 'memories',
  scene_summaries: 'scene_summaries',
  characters: 'characters',
  personas: 'personas',
  dead_letter_jobs: 'dead_letter_jobs',
  generation_logs: 'generation_logs',
  nsfw_lexicon: 'nsfw_lexicon',
} as const

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS]
