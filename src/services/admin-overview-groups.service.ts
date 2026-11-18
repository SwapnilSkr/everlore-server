import { ObjectId } from 'mongodb'
import { mongoColl } from '../config/mongo'
import { idString } from '../utils/mongo-id'
import { ACCOUNTS_HIDDEN, type AccountFilter } from './reviewer-accounts'
import {
  calls,
  coverUrl,
  dayExpression,
  daySeries,
  events,
  insightDays,
  money,
  playerScope,
  storyTurnMatch,
  windowStart,
} from './admin-insights'

/**
 * `GET /admin/overview/groups` (`everlore-docs/phases/admin-insights.md`,
 * "Contract, part 2").
 *
 * A group save is a `world_instances` row with `group_template_id`; its turns are
 * story `events` and its cost is `llm_calls`, exactly as everywhere after "Sources,
 * corrected". `groups_active` counts distinct group templates with a turn in the
 * window, so a template played by ten people is one active group.
 *
 * Bounded: the window's group saves (`players`, `turns`) are one `$group` over
 * `events` per save, then the saves themselves are read by id; cost is one
 * `$group` over `llm_calls` per save.
 */

const worldInstances = () => mongoColl.worldInstances()
const worldTemplates = () => mongoColl.worldTemplates()

export type GroupTotals = {
  groups_active: number
  players: number
  turns: number
  cost_usd: number
}

type GroupSave = { _id: ObjectId; template_id: ObjectId; player_id: ObjectId }

export const groupInsights = {
  async groups(daysValue?: string, accounts: AccountFilter = ACCOUNTS_HIDDEN, now = new Date()) {
    const days = insightDays(daysValue)
    const from = windowStart(days, now)
    const scope = await playerScope(accounts)

    const groupSaves = await worldInstances()
      .find(
        { group_template_id: { $exists: true }, ...scope },
        { projection: { template_id: 1, player_id: 1 } },
      )
      .toArray() as unknown as GroupSave[]
    const saveIds = groupSaves.map((save) => save._id)
    const saveTemplate = new Map(groupSaves.map((save) => [idString(save._id), idString(save.template_id)]))
    const savePlayer = new Map(groupSaves.map((save) => [idString(save._id), idString(save.player_id)]))

    const [turnRows, costRows] = saveIds.length === 0 ? [[], []] : await Promise.all([
      events().aggregate<{ _id: { instance: ObjectId; day: string; player: ObjectId }; turns: number }>([
        { $match: { instance_id: { $in: saveIds }, created_at: { $gte: from, $lte: now }, ...storyTurnMatch() } },
        { $group: { _id: { instance: '$instance_id', day: dayExpression, player: '$player_id' }, turns: { $sum: 1 } } },
      ]).toArray(),
      calls().aggregate<{ _id: { instance: ObjectId; day: string }; cost_usd: number }>([
        { $match: { instance_id: { $in: saveIds }, created_at: { $gte: from, $lte: now } } },
        { $group: { _id: { instance: '$instance_id', day: dayExpression }, cost_usd: { $sum: { $ifNull: ['$cost_usd', 0] } } } },
      ]).toArray(),
    ])

    const turnsByDay = new Map<string, { groups: Set<string>; players: Set<string>; turns: number }>()
    const perGroup = new Map<string, { players: Set<string>; turns: number; cost: number; last: Date | null }>()
    const groupEntry = (template: string) => {
      const entry = perGroup.get(template) ?? { players: new Set<string>(), turns: 0, cost: 0, last: null }
      perGroup.set(template, entry)
      return entry
    }

    // `groups_active` is "distinct group templates with a turn", so a group that
    // only holds background calls in the window is not an active group even
    // though its cost still belongs to the totals.
    const turnedGroups = new Set<string>()
    for (const row of turnRows) {
      const save = idString(row._id.instance)
      const template = saveTemplate.get(save)
      if (!template) continue
      const turns = Number(row.turns ?? 0)
      const day = turnsByDay.get(row._id.day) ?? { groups: new Set<string>(), players: new Set<string>(), turns: 0 }
      day.groups.add(template)
      day.turns += turns
      const player = idString(row._id.player ?? savePlayer.get(save))
      if (player) day.players.add(player)
      turnsByDay.set(row._id.day, day)

      const group = groupEntry(template)
      group.turns += turns
      if (player) group.players.add(player)
      if (turns > 0) turnedGroups.add(template)
    }
    for (const row of costRows) {
      const template = saveTemplate.get(idString(row._id.instance))
      if (!template) continue
      groupEntry(template).cost += Number(row.cost_usd ?? 0)
    }

    // Last played comes from the saves themselves, which is where a group's
    // latest activity is kept even on a day with no turn today.
    const lastRows = saveIds.length === 0 ? [] : await worldInstances()
      .find({ _id: { $in: saveIds } }, { projection: { template_id: 1, 'meta.last_active_at': 1 } })
      .toArray()
    for (const row of lastRows) {
      const template = idString(row.template_id)
      const at = row.meta?.last_active_at
      if (!(at instanceof Date)) continue
      const group = groupEntry(template)
      if (!group.last || at > group.last) group.last = at
    }

    const templates = perGroup.size === 0
      ? []
      : await worldTemplates()
        .find({ _id: { $in: [...perGroup.keys()].map((id) => new ObjectId(id)) } }, { projection: { title: 1, image_url: 1, image_thumb_url: 1 } })
        .toArray()
    const templateById = new Map(templates.map((row) => [idString(row._id), row]))

    const totals: GroupTotals = {
      groups_active: turnedGroups.size,
      players: new Set([...perGroup.values()].flatMap((group) => [...group.players])).size,
      turns: [...perGroup.values()].reduce((sum, group) => sum + group.turns, 0),
      cost_usd: money([...perGroup.values()].reduce((sum, group) => sum + group.cost, 0)),
    }

    const daily = daySeries(days, now).map((date) => {
      const row = turnsByDay.get(date)
      return {
        date,
        groups_active: row?.groups.size ?? 0,
        players: row?.players.size ?? 0,
        turns: row?.turns ?? 0,
      }
    })

    const top_groups = [...perGroup.entries()]
      .sort((left, right) => right[1].turns - left[1].turns || (right[1].last?.getTime() ?? 0) - (left[1].last?.getTime() ?? 0))
      .slice(0, 10)
      .map(([id, group]) => {
        const template = templateById.get(id)
        return {
          id,
          // The world may be gone; the id still links, and the title says so.
          title: template?.title ?? 'Deleted group',
          cover_url: template ? coverUrl(template) : null,
          players: group.players.size,
          turns: group.turns,
          cost_usd: money(group.cost),
          last_played_at: group.last ? group.last.toISOString() : null,
        }
      })

    return { days, totals, daily, top_groups }
  },
}
