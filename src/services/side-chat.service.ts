import { mongoColl } from '../config/mongo'
import { idString, parseObjectId } from '../utils/mongo-id'
import type { WorldEventDoc } from '../models/world-event.model'
import type { CharacterProfileDoc } from '../models/character-profile.model'
import { resolveSideChatReachability } from '../../worker/lib/side-chat-reachability'

const THREAD_PAGE_SIZE = 30

async function assertOwnership(instanceId: string, playerId: string) {
  const instance = await mongoColl.worldInstances().findOne({
    _id: parseObjectId(instanceId),
    player_id: parseObjectId(playerId),
  })
  if (!instance) throw new Error('Instance not found')
  return instance
}

/** Read surface for private side-character conversations (Phase 7). */
export const sideChatService = {
  /**
   * Pre-gate for the UI: can the player side-chat this character right now, and on
   * what footing (present / nearby / reachable_remote / seek_required / blocked)?
   * Mirrors the worker's gate (same resolver) so the app can disable / annotate the
   * affordance before sending. Read-only.
   */
  async checkReachability(instanceId: string, playerId: string, characterId: string) {
    const instance = await assertOwnership(instanceId, playerId)
    const iid = parseObjectId(instanceId)
    const card = (await mongoColl.characters().findOne({
      _id: parseObjectId(characterId),
      instance_id: iid,
    })) as CharacterProfileDoc | null
    if (!card) throw new Error('Character not found')
    if (card.is_protagonist) {
      return { allowed: false, mode: 'blocked' as const, reason: 'This is the main character — talk to them in the story.' }
    }
    const template = await mongoColl
      .worldTemplates()
      .findOne({ _id: instance.template_id }, { projection: { seed_prompt: 1, global_lore: 1 } })
    const recentMain = (await mongoColl
      .events()
      .find(
        { instance_id: iid, type: { $ne: 'side_chat' } },
        { projection: { sequence: 1, 'data.present_characters': 1 } },
      )
      .sort({ sequence: -1 })
      .limit(6)
      .toArray()) as WorldEventDoc[]
    const currentSequence = recentMain[0]?.sequence ?? 0
    return resolveSideChatReachability({
      characterNames: [card.canonical_name, ...(card.aliases || [])],
      latestPresent: recentMain[0]?.data?.present_characters || [],
      recentPresent: recentMain.flatMap((e) => e.data?.present_characters || []),
      cardState: card.mutable_state || [],
      worldText: [template?.seed_prompt, template?.global_lore].filter(Boolean).join('\n'),
      lastSeenSequence: card.last_seen_sequence,
      currentSequence,
    })
  },

  /** One row per character the player has side-chatted with, latest first. */
  async listThreads(instanceId: string, playerId: string) {
    await assertOwnership(instanceId, playerId)
    const iid = parseObjectId(instanceId)
    const rows = await mongoColl
      .events()
      .aggregate([
        { $match: { instance_id: iid, type: 'side_chat' } },
        { $sort: { sequence: -1 } },
        {
          $group: {
            _id: '$side_chat.character_id',
            character_name: { $first: '$side_chat.character_name' },
            last_message: { $first: '$data.ai_response' },
            last_at: { $first: '$created_at' },
            turn_count: { $sum: 1 },
          },
        },
        { $sort: { last_at: -1 } },
      ])
      .toArray()
    return {
      threads: rows.map((r: any) => ({
        character_id: idString(r._id),
        character_name: r.character_name,
        last_message: r.last_message,
        last_at: r.last_at,
        turn_count: r.turn_count,
      })),
    }
  },

  /** Paginated turns of one character's thread, oldest first within the page. */
  async getThread(
    instanceId: string,
    playerId: string,
    characterId: string,
    opts: { page?: number; limit?: number } = {},
  ) {
    await assertOwnership(instanceId, playerId)
    const iid = parseObjectId(instanceId)
    const cid = parseObjectId(characterId)
    const limit = Math.min(opts.limit || THREAD_PAGE_SIZE, 100)
    const page = opts.page || 1
    const filter = { instance_id: iid, type: 'side_chat', 'side_chat.character_id': cid }

    const [events, total, card] = await Promise.all([
      mongoColl
        .events()
        .find(filter)
        .sort({ sequence: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .toArray() as Promise<WorldEventDoc[]>,
      mongoColl.events().countDocuments(filter),
      mongoColl.characters().findOne(
        { _id: cid, instance_id: iid },
        { projection: { canonical_name: 1, appearance: 1, role: 1, relationship: 1 } },
      ),
    ])

    return {
      character: card
        ? {
            id: idString(card._id),
            canonical_name: card.canonical_name,
            role: card.role || null,
            appearance: card.appearance || null,
            relationship: card.relationship || null,
          }
        : null,
      events: events.reverse().map((e) => ({
        id: idString(e._id),
        sequence: e.sequence,
        player_input: e.data.player_input,
        narrative: e.data.ai_response,
        created_at: e.created_at,
      })),
      total,
      page,
    }
  },
}
