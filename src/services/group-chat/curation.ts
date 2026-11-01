const strings = { type: 'array', items: { type: 'string' } }
const nullableText = { type: ['string', 'null'] }

const atomProperties = {
  text: { type: 'string' },
  type: { type: 'string', enum: ['relationship', 'promise', 'lore', 'observation', 'emotion', 'secret'] },
  importance: { type: 'integer', minimum: 1, maximum: 5 },
  is_nsfw: { type: 'boolean' },
  subjects: strings,
  objects: strings,
  emotional_valence: nullableText,
  emotional_cause: nullableText,
  emotional_effect: nullableText,
  relationship_delta: nullableText,
  unresolved_thread: { type: 'boolean' },
  retrieval_terms: strings,
  source_messages: { type: 'array', minItems: 1, items: { type: 'integer', minimum: 1 } },
}

// Strict structured output requires every property and forbids additional keys at every object level.
export const GROUP_CURATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['memories', 'entities', 'resolved_threads', 'closed_thread_ids'],
  properties: {
    memories: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: Object.keys(atomProperties), properties: atomProperties },
    },
    entities: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['name', 'kind'],
        properties: {
          name: { type: 'string' },
          kind: { type: 'string', enum: ['character', 'location', 'faction', 'item', 'quest', 'other'] },
        },
      },
    },
    resolved_threads: strings,
    closed_thread_ids: strings,
  },
}
