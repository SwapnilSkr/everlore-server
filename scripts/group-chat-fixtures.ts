import { ObjectId } from 'mongodb'
import type { WorldTemplateDoc } from '../src/models/world-template.model'
import type { GroupMember } from '../src/services/group-chat/types'

export const members: GroupMember[] = ['Test Alpha', 'Test Beta', 'Test Gamma', 'Test Delta'].map((name, index) => ({
  id: new ObjectId((index + 1).toString(16).padStart(24, '0')).toHexString(), name,
  role: `member ${index}`, persona: `Persona ${index}`,
  group: { start_bond: 'friend', age: 24 + index, talkativeness: 0.5, speech: `Voice ${index}`, wants: `Private motivation ${index}`, intimacy: `Private intimacy ${index}`, voice: [`Authored text ${index}`] },
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

export const owenReply = {
  sentence: 'Having consulted the record from 14 March, I can confirm that I am still flattered by the invitation, although I must politely decline for reasons which are entirely my own and which, mercifully, do not require a guild meeting to discuss.',
  overflow: 'I trust this clarification will spare us another lengthy debate in the minutes.',
}

export const ordinaryActions = [
  'I leave a green parcel labelled PARCEL71 on the table.',
  'I pin my drawing above the sofa.',
  'I place my spare key in the blue bowl.',
  'I put on my yellow coat.',
  'I switch on the lamp by the window.',
]

/** One steady group, building up: the dry one, the forward one and the shy one. */
export function nwayTurns(cast: string[]) {
  const names = [cast[0], cast[2], cast[3]]
  const tags = names.map(name => `@${name}`).join(' ')
  return [
    { player: `${tags} come to my room, all three of you. I want you naked on my bed tonight.` },
    { player: `${tags} I take off your clothes, one at a time.`, kind: 'action' as const },
    { player: `${tags} tell me exactly how you want me to fuck you.` },
    { player: `${tags} I kiss ${names[0]} and put my hand between ${names[1]}'s legs while ${names[2]} watches.`, kind: 'action' as const },
    { player: `${tags} what do you want to do to each other while I watch?` },
    { player: `${tags} I go down on ${names[1]} and pull ${names[2]} closer.`, kind: 'action' as const },
  ].map(turn => ({ ...turn, speakers: names, rolled: true }))
}
