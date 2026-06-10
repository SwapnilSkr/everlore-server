import { ObjectId } from 'mongodb'
import { mongoColl } from '../config/mongo'
import type {
  StoryCalendarDateDoc,
  StoryCalendarDoc,
  TimeAnchorDoc,
  TimelineBranchDoc,
} from '../models/time.model'
import type { WorldEventDoc } from '../models/world-event.model'
import { idString, parseObjectId } from '../utils/mongo-id'

const DEFAULT_TIMELINE_ID = 'main'
const DEFAULT_CALENDAR_NAME = 'Story Calendar'
const DEFAULT_MONTHS = [
  'Dawnwane',
  'Emberwane',
  'Rainwane',
  'Bloomwane',
  'Highsun',
  'Goldwane',
  'Harvestwane',
  'Redwane',
  'Frostwane',
  'Darkwane',
  'Starwane',
  'Yearsend',
].map((name) => ({ name, days: 30 }))

function cleanLabel(value?: string | null): string | undefined {
  const v = String(value || '').replace(/\s+/g, ' ').trim()
  return v ? v.slice(0, 160) : undefined
}

function asObjectId(value: ObjectId | string): ObjectId {
  return value instanceof ObjectId ? value : parseObjectId(String(value))
}

function advanceDays(label?: string | null): number {
  const t = String(label || '').toLowerCase()
  if (!t) return 0
  if (/\bseason\b/.test(t)) return 90
  if (/\bseveral\s+days\b|\bdays\b/.test(t)) return 3
  if (/\bday\b/.test(t)) return 1
  // Hours matter for prose, but the current calendar has day precision.
  return 0
}

function normalizeDate(date: StoryCalendarDateDoc, calendar: StoryCalendarDoc): StoryCalendarDateDoc {
  const months = calendar.months.length ? calendar.months : DEFAULT_MONTHS
  let year = date.year || 1
  let month = Math.max(1, date.month || 1)
  let day = Math.max(1, date.day || 1)
  while (month > months.length) {
    month -= months.length
    year += 1
  }
  while (day > months[month - 1].days) {
    day -= months[month - 1].days
    month += 1
    if (month > months.length) {
      month = 1
      year += 1
    }
  }
  return {
    ...date,
    calendar_id: asObjectId(date.calendar_id as ObjectId | string),
    year,
    month,
    day,
    era: date.era || calendar.eras[0],
    label: date.label,
  }
}

function addDays(date: StoryCalendarDateDoc, calendar: StoryCalendarDoc, days: number): StoryCalendarDateDoc {
  if (days <= 0) return normalizeDate(date, calendar)
  return normalizeDate({ ...date, day: (date.day || 1) + days }, calendar)
}

function dateLabel(date?: StoryCalendarDateDoc, calendar?: StoryCalendarDoc | null): string | null {
  if (!date) return null
  if (date.label) return date.label
  const month = calendar?.months?.[(date.month || 1) - 1]?.name
  const parts = [
    date.era,
    typeof date.year === 'number' ? `Year ${date.year}` : null,
    month && typeof date.day === 'number' ? `${month} ${date.day}` : null,
  ].filter(Boolean)
  return parts.length ? parts.join(', ') : null
}

export const timeService = {
  defaultTimelineId: DEFAULT_TIMELINE_ID,

  async ensureDefaultCalendar(instanceId: string, templateId?: string): Promise<StoryCalendarDoc> {
    const iid = parseObjectId(instanceId)
    const existing = (await mongoColl.storyCalendars().findOne({
      instance_id: iid,
      is_default: true,
    })) as StoryCalendarDoc | null
    if (existing) return existing

    const now = new Date()
    const doc: StoryCalendarDoc = {
      _id: new ObjectId(),
      ...(templateId ? { template_id: parseObjectId(templateId) } : {}),
      instance_id: iid,
      name: DEFAULT_CALENDAR_NAME,
      eras: ['First Era'],
      months: DEFAULT_MONTHS,
      weekdays: ['Sunsday', 'Moonday', 'Starsday', 'Windsday', 'Earthday', 'Firesday', 'Watersday'],
      is_default: true,
      created_at: now,
      updated_at: now,
    }
    try {
      await mongoColl.storyCalendars().insertOne(doc)
      return doc
    } catch {
      return (await mongoColl.storyCalendars().findOne({
        instance_id: iid,
        is_default: true,
      })) as StoryCalendarDoc
    }
  },

  async ensureMainTimeline(instanceId: string, forkedAtSequence = 0): Promise<TimelineBranchDoc> {
    const iid = parseObjectId(instanceId)
    const existing = (await mongoColl.timelineBranches().findOne({
      instance_id: iid,
      timeline_id: DEFAULT_TIMELINE_ID,
    })) as TimelineBranchDoc | null
    if (existing) return existing
    const now = new Date()
    const doc: TimelineBranchDoc = {
      _id: new ObjectId(),
      instance_id: iid,
      name: 'Main Timeline',
      timeline_id: DEFAULT_TIMELINE_ID,
      forked_at_sequence: forkedAtSequence,
      status: 'active',
      created_at: now,
      updated_at: now,
    }
    try {
      await mongoColl.timelineBranches().insertOne(doc)
      return doc
    } catch {
      return (await mongoColl.timelineBranches().findOne({
        instance_id: iid,
        timeline_id: DEFAULT_TIMELINE_ID,
      })) as TimelineBranchDoc
    }
  },

  async initialAnchor(params: {
    instanceId: string
    templateId?: string
    sequence?: number
    realTime?: Date
    label?: string
  }): Promise<TimeAnchorDoc> {
    const calendar = await this.ensureDefaultCalendar(params.instanceId, params.templateId)
    await this.ensureMainTimeline(params.instanceId, params.sequence || 0)
    return {
      real_time: params.realTime || new Date(),
      sequence: params.sequence || 0,
      story_calendar: {
        calendar_id: calendar._id,
        year: 1,
        month: 1,
        day: 1,
        era: calendar.eras[0],
        label: cleanLabel(params.label) || 'The beginning',
      },
      event_time_label: cleanLabel(params.label) || 'The beginning',
      timeline_id: DEFAULT_TIMELINE_ID,
      causal_parent_event_ids: [],
    }
  },

  async anchorForNextEvent(params: {
    instanceId: string
    templateId?: string
    previous?: TimeAnchorDoc | null
    previousEventId?: ObjectId | null
    sequence: number
    realTime?: Date
    timeAdvancedLabel?: string | null
    eventTimeLabel?: string | null
    timelineId?: string | null
  }): Promise<TimeAnchorDoc> {
    const calendar = await this.ensureDefaultCalendar(params.instanceId, params.templateId)
    await this.ensureMainTimeline(params.instanceId)
    const prev =
      params.previous ||
      (await this.initialAnchor({
        instanceId: params.instanceId,
        templateId: params.templateId,
        sequence: 0,
      }))
  const baseDate =
      prev.story_calendar ||
      ({
        calendar_id: calendar._id,
        year: 1,
        month: 1,
        day: 1,
        era: calendar.eras[0],
      } satisfies StoryCalendarDateDoc)
    const advanced = addDays(
      { ...baseDate, calendar_id: baseDate.calendar_id ? asObjectId(baseDate.calendar_id as ObjectId | string) : calendar._id },
      calendar,
      advanceDays(params.timeAdvancedLabel),
    )
    const label = cleanLabel(params.eventTimeLabel || params.timeAdvancedLabel)
    return {
      real_time: params.realTime || new Date(),
      sequence: params.sequence,
      story_calendar: {
        ...advanced,
        ...(label ? { label } : {}),
      },
      event_time_label: label,
      timeline_id: cleanLabel(params.timelineId) || prev.timeline_id || DEFAULT_TIMELINE_ID,
      causal_parent_event_ids: params.previousEventId ? [params.previousEventId] : [],
    }
  },

  async timelineContext(instanceId: string, anchor?: TimeAnchorDoc | null): Promise<string | null> {
    const current = anchor || null
    if (!current) return null
    const calendarId = current.story_calendar?.calendar_id
    const calendar = calendarId
      ? ((await mongoColl.storyCalendars().findOne({ _id: asObjectId(calendarId as ObjectId | string) })) as StoryCalendarDoc | null)
      : null
    const branch = (await mongoColl.timelineBranches().findOne({
      instance_id: parseObjectId(instanceId),
      timeline_id: current.timeline_id || DEFAULT_TIMELINE_ID,
    })) as TimelineBranchDoc | null
    const lines = [
      `Timeline: ${branch?.name || current.timeline_id || DEFAULT_TIMELINE_ID}`,
      dateLabel(current.story_calendar, calendar) ? `Story date: ${dateLabel(current.story_calendar, calendar)}` : null,
      current.event_time_label ? `Current time label: ${current.event_time_label}` : null,
    ].filter(Boolean)
    return lines.length ? lines.join('\n') : null
  },

  async listCalendar(instanceId: string, playerId: string) {
    const iid = parseObjectId(instanceId)
    const pid = parseObjectId(playerId)
    const instance = await mongoColl.worldInstances().findOne({ _id: iid, player_id: pid })
    if (!instance) throw new Error('Instance not found')
    const [calendars, timelines, events] = await Promise.all([
      mongoColl.storyCalendars().find({ instance_id: iid }).toArray(),
      mongoColl.timelineBranches().find({ instance_id: iid }).sort({ created_at: 1 }).toArray(),
      mongoColl
        .events()
        .find(
          { instance_id: iid, type: { $ne: 'side_chat' }, time_anchor: { $exists: true } },
          {
            projection: {
              sequence: 1,
              type: 1,
              scene_tag: 1,
              time_anchor: 1,
              'data.milestone': 1,
              'data.time_advanced': 1,
              created_at: 1,
            },
          },
        )
        .sort({ 'time_anchor.timeline_id': 1, 'time_anchor.story_calendar.year': 1, 'time_anchor.story_calendar.month': 1, 'time_anchor.story_calendar.day': 1, sequence: 1 })
        .toArray(),
    ])
    return {
      calendars: calendars.map((c) => ({
        id: idString(c._id),
        name: c.name,
        eras: c.eras,
        months: c.months,
        weekdays: c.weekdays || [],
        is_default: c.is_default === true,
      })),
      timelines: timelines.map((t) => ({
        id: idString(t._id),
        timeline_id: t.timeline_id,
        name: t.name,
        parent_timeline_id: t.parent_timeline_id || null,
        forked_at_sequence: t.forked_at_sequence,
        status: t.status,
      })),
      current_time_anchor: instance.current_time_anchor || null,
      events: (events as WorldEventDoc[]).map((e) => ({
        id: idString(e._id),
        sequence: e.sequence,
        type: e.type,
        scene_tag: e.scene_tag,
        time_anchor: e.time_anchor,
        milestone: e.data?.milestone || null,
        time_advanced: e.data?.time_advanced || null,
        created_at: e.created_at,
      })),
    }
  },

  async forkTimeline(params: {
    instanceId: string
    playerId: string
    name: string
    timelineId?: string
    parentTimelineId?: string
    makeActive?: boolean
  }) {
    const iid = parseObjectId(params.instanceId)
    const pid = parseObjectId(params.playerId)
    const instance = await mongoColl.worldInstances().findOne({ _id: iid, player_id: pid })
    if (!instance) throw new Error('Instance not found')
    const current = instance.current_time_anchor || (await this.initialAnchor({ instanceId: params.instanceId }))
    const timelineId =
      cleanLabel(params.timelineId)?.toLowerCase().replace(/[^a-z0-9_-]+/g, '_') ||
      `branch_${Date.now()}`
    const now = new Date()
    const branch: TimelineBranchDoc = {
      _id: new ObjectId(),
      instance_id: iid,
      name: cleanLabel(params.name) || timelineId,
      timeline_id: timelineId,
      parent_timeline_id: params.parentTimelineId || current.timeline_id || DEFAULT_TIMELINE_ID,
      forked_at_sequence: current.sequence,
      forked_at_story_time: current,
      status: 'active',
      created_at: now,
      updated_at: now,
    }
    await mongoColl.timelineBranches().updateOne(
      { instance_id: iid, timeline_id: branch.timeline_id },
      { $setOnInsert: branch },
      { upsert: true },
    )
    if (params.makeActive !== false) {
      const nextAnchor = { ...current, timeline_id: branch.timeline_id }
      await mongoColl.worldInstances().updateOne(
        { _id: iid },
        { $set: { active_timeline_id: branch.timeline_id, current_time_anchor: nextAnchor, updated_at: now } },
      )
      await getRedisSessionBust(params.instanceId)
    }
    return { timeline_id: branch.timeline_id, name: branch.name }
  },

  async setActiveTimeline(instanceId: string, playerId: string, timelineId: string) {
    const iid = parseObjectId(instanceId)
    const pid = parseObjectId(playerId)
    const branch = await mongoColl.timelineBranches().findOne({ instance_id: iid, timeline_id: timelineId })
    if (!branch) throw new Error('Timeline not found')
    const instance = await mongoColl.worldInstances().findOne({ _id: iid, player_id: pid })
    if (!instance) throw new Error('Instance not found')
    const current = instance.current_time_anchor || (await this.initialAnchor({ instanceId }))
    const nextAnchor = { ...current, timeline_id: timelineId }
    await mongoColl.worldInstances().updateOne(
      { _id: iid },
      { $set: { active_timeline_id: timelineId, current_time_anchor: nextAnchor, updated_at: new Date() } },
    )
    await getRedisSessionBust(instanceId)
    return { timeline_id: branch.timeline_id, name: branch.name }
  },

  async updateEventTimeAnchor(params: {
    eventId: string
    playerId: string
    storyCalendar?: {
      year?: number
      month?: number
      day?: number
      era?: string
      label?: string
    }
    eventTimeLabel?: string
    timelineId?: string
  }) {
    const eid = parseObjectId(params.eventId)
    const pid = parseObjectId(params.playerId)
    const event = (await mongoColl.events().findOne({ _id: eid, player_id: pid })) as WorldEventDoc | null
    if (!event) throw new Error('Event not found')
    const instance = await mongoColl.worldInstances().findOne({ _id: event.instance_id, player_id: pid })
    if (!instance) throw new Error('Instance not found')
    const calendar = await this.ensureDefaultCalendar(idString(event.instance_id), idString(instance.template_id))
    const base = event.time_anchor || instance.current_time_anchor || (await this.initialAnchor({ instanceId: idString(event.instance_id) }))
    const story_calendar = normalizeDate(
      {
        ...(base.story_calendar || { calendar_id: calendar._id }),
        ...(params.storyCalendar || {}),
        calendar_id: base.story_calendar?.calendar_id
          ? asObjectId(base.story_calendar.calendar_id as ObjectId | string)
          : calendar._id,
      },
      calendar,
    )
    const next: TimeAnchorDoc = {
      ...base,
      sequence: event.sequence,
      real_time: base.real_time || event.created_at,
      story_calendar,
      event_time_label: cleanLabel(params.eventTimeLabel) || cleanLabel(params.storyCalendar?.label) || base.event_time_label,
      timeline_id: cleanLabel(params.timelineId) || base.timeline_id || DEFAULT_TIMELINE_ID,
    }
    await this.ensureMainTimeline(idString(event.instance_id))
    if (next.timeline_id !== DEFAULT_TIMELINE_ID) {
      await mongoColl.timelineBranches().updateOne(
        { instance_id: event.instance_id, timeline_id: next.timeline_id },
        {
          $setOnInsert: {
            _id: new ObjectId(),
            instance_id: event.instance_id,
            timeline_id: next.timeline_id,
            name: next.timeline_id,
            parent_timeline_id: DEFAULT_TIMELINE_ID,
            forked_at_sequence: event.sequence,
            forked_at_story_time: next,
            status: 'active',
            created_at: new Date(),
            updated_at: new Date(),
          },
        },
        { upsert: true },
      )
    }
    await mongoColl.events().updateOne({ _id: eid }, { $set: { time_anchor: next, updated_at: new Date() } })
    await mongoColl.memories().updateMany(
      { source_event_ids: eid },
      { $set: { time_anchor: next, timeline_id: next.timeline_id, updated_at: new Date() } },
    )
    return { time_anchor: next }
  },
}

async function getRedisSessionBust(instanceId: string) {
  const { getRedisClient } = await import('../config/redis')
  await getRedisClient().del(`session:${instanceId}`)
}
