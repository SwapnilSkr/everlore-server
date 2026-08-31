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
  chapter_summaries: 'chapter_summaries',
  arc_summaries: 'arc_summaries',
  characters: 'characters',
  entities: 'entities',
  entity_edges: 'entity_edges',
  story_calendars: 'story_calendars',
  timeline_branches: 'timeline_branches',
  personas: 'personas',
  dead_letter_jobs: 'dead_letter_jobs',
  generation_logs: 'generation_logs',
  nsfw_lexicon: 'nsfw_lexicon',
  projection_anomalies: 'projection_anomalies',
  signal_ledger: 'signal_ledger',
  projection_checkpoints: 'projection_checkpoints',
  projection_checkpoint_chunks: 'projection_checkpoint_chunks',
  location_stats: 'location_stats',
  relation_candidates: 'relation_candidates',
  ink_ledger: 'ink_ledger',
  billing_config: 'billing_config',
  billing_entitlements: 'billing_entitlements',
  store_purchases: 'store_purchases',
  post_process_outbox: 'post_process_outbox',
  content_reports: 'content_reports',
  web_events: 'web_events',
} as const

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS]
