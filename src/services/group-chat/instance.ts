import { ObjectId } from 'mongodb'
import { mongoColl } from '../../config/mongo'
import type { WorldInstanceDoc } from '../../models/world-instance.model'
import type { WorldTemplateDoc } from '../../models/world-template.model'
import type { WorldEventDoc } from '../../models/world-event.model'
import { buildGroupStatic } from './prompt'
import { timeLines } from './lines'
import type { GroupMember, NamedLine } from './types'
import { idString } from '../../utils/mongo-id'

export interface GroupContext {
  static_prompt: string
  player: string
  topics: string[]
  opening_lines: NamedLine[]
}

export async function loadGroupMembers(instance: WorldInstanceDoc): Promise<GroupMember[]> {
  const cards = await mongoColl.characters().find({ instance_id: instance._id }).toArray()
  return (instance.seed_cast_snapshot || []).map(member => {
    const card = cards.find(card => card.canonical_name.toLowerCase() === member.name.toLowerCase())
    if (!card || !member.group) throw new Error('The group is still getting ready. Try again in a moment.')
    return { id: idString(card._id), name: member.name, role: member.role, persona: member.persona, group: member.group }
  })
}

export async function seedGroupOpening(instance: WorldInstanceDoc, template: WorldTemplateDoc, player: string) {
  const members = await loadGroupMembers(instance)
  if (members.some(member => member.name.toLowerCase() === player.toLowerCase())) {
    let suffix = 0
    do { player = `Player${suffix ? ` ${suffix}` : ''}`; suffix++ }
    while (members.some(member => member.name.toLowerCase() === player.toLowerCase()))
  }
  const now = new Date()
  const group_state = { silent_for: Object.fromEntries(members.map(member => [member.id, 0])), unprompted_since_player: 0, topics_used: 0 }
  const group_context: GroupContext = instance.group_context || {
    static_prompt: buildGroupStatic({ ...template, members, player }), player,
    topics: [...template.topics!], opening_lines: template.opening_lines!.map(line => ({
      name: members.find(member => member.name.toLowerCase() === line.name.trim().toLowerCase())!.name, text: line.text,
    })),
  }
  const lines = timeLines(group_context.opening_lines, members, now)
  const event: WorldEventDoc = {
    _id: new ObjectId(), instance_id: instance._id, player_id: instance.player_id,
    sequence: 1, type: 'narration', scene_tag: 'dialogue', is_user_edited: false, edit_history: [], created_at: now,
    data: { player_input: '', ai_response: group_context.opening_lines.map(line => `${line.name}: ${line.text}`).join('\n'),
      lines, group_state_after: group_state, state_mutations: {}, flag_mutations: {}, model_used: 'seed', tokens_in: 0, tokens_out: 0 },
  }
  await mongoColl.events().updateOne({ instance_id: instance._id, sequence: 1 }, { $setOnInsert: event }, { upsert: true })
  await mongoColl.worldInstances().updateOne({ _id: instance._id }, { $set: { group_state, group_context, 'meta.total_events': 1 } })
  instance.group_state = group_state
  instance.group_context = group_context
  instance.meta.total_events = 1
}
