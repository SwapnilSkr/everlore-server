import { ObjectId } from 'mongodb'
import type { WorldTemplateDoc } from '../src/models/world-template.model'
import type { GroupMember } from '../src/services/group-chat/types'

export const members: GroupMember[] = ['Test Alpha', 'Test Beta', 'Test Gamma', 'Test Delta'].map((name, index) => ({
  id: new ObjectId((index + 1).toString(16).padStart(24, '0')).toHexString(), name,
  role: `member ${index}`, persona: `Persona ${index}`,
  group: { interested: true, age: 24 + index, talkativeness: 0.5, speech: `Voice ${index}`, wants: `Private motivation ${index}`, intimacy: `Private intimacy ${index}`, voice: [`Authored text ${index}`] },
}))

export function groupTemplate(): WorldTemplateDoc {
  return {
    _id: new ObjectId('100000000000000000000001'), creator_id: new ObjectId('200000000000000000000001'),
    slug: 'test-group', title: 'Test Group', description: 'An authored group fixture.', kind: 'group', genre: 'modern',
    is_published: true, visibility: 'public', review_status: 'approved', is_sentient: false, is_nsfw_capable: true,
    version: 1, seed_prompt: 'Write the next short messages in an online group chat.', global_lore: 'These adults know each other.',
    narrative_style: 'cozy_comfort', seed_cast: members.map(({ id, ...member }) => structuredClone(member)),
    topics: ['First topic', 'Second topic'], opening_lines: [{ name: members[0].name, text: 'The authored opening.' }],
    base_stats_template: {}, flag_definitions: {}, scene_tags: [], model_preferences: {}, max_context_memories: 25,
    max_lore_results: 10, created_at: new Date('2026-01-01Z'), updated_at: new Date('2026-01-01Z'),
  }
}
