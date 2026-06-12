import { ObjectId } from 'mongodb'
import { mongoColl } from '../config/mongo'
import { callLLM, AI_MODELS } from '../ai'
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

// Real-world calendar — the deterministic fallback AND what a modern/contemporary/
// historical/realistic-sci-fi world should use, so a noir or startup world never
// shows fantasy month names. (Leap years ignored; the date math is day-level.)
const GREGORIAN_MONTHS = [
  { name: 'January', days: 31 }, { name: 'February', days: 28 },
  { name: 'March', days: 31 }, { name: 'April', days: 30 },
  { name: 'May', days: 31 }, { name: 'June', days: 30 },
  { name: 'July', days: 31 }, { name: 'August', days: 31 },
  { name: 'September', days: 30 }, { name: 'October', days: 31 },
  { name: 'November', days: 30 }, { name: 'December', days: 31 },
]
const GREGORIAN_WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

interface CalendarSpec {
  name: string
  eras: string[]
  months: { name: string; days: number }[]
  weekdays: string[]
}

// The model is a WITNESS that only CLASSIFIES the setting; the server owns the
// structure. This is deliberate: the small model happily invents atmospheric
// month names for a "modern" cyberpunk/noir world (observed: Neon Divide got
// "Neonrise/Surveillance/Flicker"), so we never let it author the months for a
// real-world setting — modern always gets the deterministic Gregorian calendar.
const CALENDAR_DERIVE_PROMPT = `You classify the SETTING of an interactive-story world and, only for non-Earth worlds, design its calendar.

First decide "setting":
- "modern" — the world uses the REAL human/Earth calendar. This includes present-day, contemporary, historical Earth, near-future, CYBERPUNK, noir, dystopian, post-apocalyptic Earth, and human space colonies. If real human months (January, etc.) would make sense, it is "modern".
- "fantasy" — a genuinely non-Earth world with its OWN reckoning of time: high/epic fantasy, mythic, alien planets, other planes/realms (e.g. a shadow realm), other-world sci-fi.

If "modern": return setting only (the server supplies the real calendar). You may still give a "name".
If "fantasy": INVENT a calendar fitting THIS world's specific tone — themed month names, weekday names, a fitting era. Derive names from the world's own flavour (an alien world feels alien; a shadow realm shadowy); do NOT reuse generic boilerplate. 8-14 months, each "days" 20-40, 5-10 weekdays, names <= 20 chars, 0-2 eras.

Respond ONLY with JSON: {"setting":"modern|fantasy","name":"<calendar name>","eras":["..."],"months":[{"name":"...","days":30}],"weekdays":["..."]}`

function buildCalendarSpec(parsed: unknown): CalendarSpec | null {
  if (!parsed || typeof parsed !== 'object') return null
  const p = parsed as Record<string, unknown>
  const name = cleanLabel(p.name as string)?.slice(0, 60) || DEFAULT_CALENDAR_NAME
  // Modern / real-Earth → the REAL calendar, server-owned + deterministic, so a
  // stylized-but-modern world (cyberpunk, noir) can never get invented months.
  if (String(p.setting || '').toLowerCase() !== 'fantasy') {
    return { name, eras: [], months: GREGORIAN_MONTHS, weekdays: GREGORIAN_WEEKDAYS }
  }
  // Fantasy / alien / otherworldly → use the model's themed calendar (validated).
  const months = (Array.isArray(p.months) ? p.months : [])
    .map((m) => {
      const mm = (m || {}) as Record<string, unknown>
      const monthName = cleanLabel(mm.name as string)?.slice(0, 24)
      const days = Math.round(Number(mm.days))
      return monthName && Number.isFinite(days) && days >= 1 && days <= 100
        ? { name: monthName, days }
        : null
    })
    .filter((m): m is { name: string; days: number } => m !== null)
    .slice(0, 24)
  // Too few months to be a usable themed calendar → fall back to Gregorian.
  if (months.length < 4) return null
  const weekdays = (Array.isArray(p.weekdays) ? p.weekdays : [])
    .map((w) => cleanLabel(w as string)?.slice(0, 24))
    .filter((w): w is string => !!w)
    .slice(0, 14)
  const eras = (Array.isArray(p.eras) ? p.eras : [])
    .map((e) => cleanLabel(e as string)?.slice(0, 40))
    .filter((e): e is string => !!e)
    .slice(0, 4)
  return { name, eras, months, weekdays: weekdays.length ? weekdays : GREGORIAN_WEEKDAYS }
}

/**
 * Derive a world-appropriate calendar from the template's premise via the cheap
 * model: a modern/realistic world gets the real Gregorian calendar; a fantasy/
 * alien/shadow realm gets a themed calendar generated to fit its tone. Returns
 * null on any failure or junk output so the caller falls back to Gregorian — the
 * seed must never break instance creation.
 */
async function deriveCalendarSpec(template: {
  title?: string
  description?: string
  seed_prompt?: string
  global_lore?: string
}): Promise<CalendarSpec | null> {
  try {
    const premise = [template.title, template.description, template.seed_prompt, template.global_lore]
      .filter(Boolean)
      .join('\n')
      .slice(0, 1500)
      .trim()
    if (!premise) return null
    const raw = await callLLM({
      model: AI_MODELS.metadata,
      temperature: 0.4,
      maxTokens: 500,
      responseFormat: { type: 'json_object' },
      messages: [
        { role: 'system', content: CALENDAR_DERIVE_PROMPT },
        { role: 'user', content: `World premise:\n${premise}` },
      ],
    })
    return buildCalendarSpec(JSON.parse(raw))
  } catch (err) {
    console.warn('Calendar derivation failed, using Gregorian:', (err as Error).message)
    return null
  }
}

function cleanLabel(value?: string | null): string | undefined {
  const v = String(value || '').replace(/\s+/g, ' ').trim()
  return v ? v.slice(0, 160) : undefined
}

function asObjectId(value: ObjectId | string): ObjectId {
  return value instanceof ObjectId ? value : parseObjectId(String(value))
}

const WORD_NUMBERS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, couple: 2, few: 3,
  several: 3,
}

const UNIT_DAYS: Record<string, number> = {
  day: 1, week: 7, month: 30, season: 90, year: 365,
}

/**
 * Days the day-level calendar should advance for a narrated time label. Parses
 * an explicit "<amount> <unit>" (digits or small worded numbers — "three days",
 * "2 weeks", "a month", "several days") across day/week/month/season/year, then
 * falls back to coarse keyword detection. Hours/minutes resolve to 0 (the
 * calendar has day precision) so a "few hours later" beat keeps the same date.
 */
function advanceDays(label?: string | null): number {
  const t = String(label || '').toLowerCase()
  if (!t) return 0
  const m = t.match(
    /\b(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|couple|few|several)\s+(day|week|month|season|year)s?\b/,
  )
  if (m) {
    const amount = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : (WORD_NUMBERS[m[1]] ?? 1)
    return Math.max(0, Math.min(amount, 999)) * (UNIT_DAYS[m[2]] || 1)
  }
  if (/\byears?\b/.test(t)) return 365
  if (/\bseasons?\b/.test(t)) return 90
  if (/\bmonths?\b/.test(t)) return 30
  if (/\bweeks?\b/.test(t)) return 7
  if (/\bseveral\s+days\b|\bdays\b/.test(t)) return 3
  if (/\bday\b|\bnext\s+morning\b|\bovernight\b|\btomorrow\b/.test(t)) return 1
  // Hours/minutes matter for prose, but the calendar has day precision.
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

    // Derive a world-appropriate calendar from the template (modern/realistic →
    // Gregorian; fantasy/alien/shadow → a themed calendar generated to fit the
    // world's tone). One-time per instance — every later call hits the early
    // return above, so this LLM cost never touches the turn hot path. Falls back
    // to the real Gregorian calendar on any failure, NEVER the old generic
    // fantasy default that mismatched modern worlds.
    let spec: CalendarSpec | null = null
    if (templateId) {
      const template = (await mongoColl.worldTemplates().findOne(
        { _id: parseObjectId(templateId) },
        { projection: { title: 1, description: 1, seed_prompt: 1, global_lore: 1 } },
      )) as { title?: string; description?: string; seed_prompt?: string; global_lore?: string } | null
      if (template) spec = await deriveCalendarSpec(template)
    }

    const now = new Date()
    const doc: StoryCalendarDoc = {
      _id: new ObjectId(),
      ...(templateId ? { template_id: parseObjectId(templateId) } : {}),
      instance_id: iid,
      name: spec?.name || DEFAULT_CALENDAR_NAME,
      eras: spec?.eras ?? [],
      months: spec?.months ?? GREGORIAN_MONTHS,
      weekdays: spec?.weekdays ?? GREGORIAN_WEEKDAYS,
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

  /**
   * Re-derive an EXISTING instance's default calendar from its template and
   * update it IN PLACE (keeps the calendar `_id`, so every stored time anchor
   * still resolves — only the month/era/weekday NAMES change). Repairs worlds
   * seeded before genre-aware calendars existed (the old hardcoded fantasy
   * default on a modern world). Also rewrites the denormalized `era` on the
   * instance cursor + event anchors so historical dates render consistently.
   * Caller must bust the `session:<iid>` cache after (out-of-band instance write).
   */
  async rederiveDefaultCalendar(
    instanceId: string,
  ): Promise<{ updated: boolean; name?: string; months?: number; era?: string | null }> {
    const iid = parseObjectId(instanceId)
    const instance = await mongoColl.worldInstances().findOne({ _id: iid })
    if (!instance) return { updated: false }
    const calendar = (await mongoColl.storyCalendars().findOne({
      instance_id: iid,
      is_default: true,
    })) as StoryCalendarDoc | null
    if (!calendar) return { updated: false }

    let spec: CalendarSpec | null = null
    if (instance.template_id) {
      const template = (await mongoColl.worldTemplates().findOne(
        { _id: instance.template_id },
        { projection: { title: 1, description: 1, seed_prompt: 1, global_lore: 1 } },
      )) as { title?: string; description?: string; seed_prompt?: string; global_lore?: string } | null
      if (template) spec = await deriveCalendarSpec(template)
    }
    // No template / failed derivation → the real Gregorian calendar (never leave
    // a modern world on the old fantasy default).
    const resolved: CalendarSpec =
      spec ?? { name: DEFAULT_CALENDAR_NAME, eras: [], months: GREGORIAN_MONTHS, weekdays: GREGORIAN_WEEKDAYS }
    const newEra = resolved.eras[0] ?? null

    await mongoColl.storyCalendars().updateOne(
      { _id: calendar._id },
      {
        $set: {
          name: resolved.name,
          eras: resolved.eras,
          months: resolved.months,
          weekdays: resolved.weekdays,
          updated_at: new Date(),
        },
      },
    )
    if ((instance as { current_time_anchor?: TimeAnchorDoc }).current_time_anchor?.story_calendar) {
      await mongoColl.worldInstances().updateOne(
        { _id: iid },
        { $set: { 'current_time_anchor.story_calendar.era': newEra } },
      )
    }
    await mongoColl.events().updateMany(
      { instance_id: iid, 'time_anchor.story_calendar': { $exists: true } },
      { $set: { 'time_anchor.story_calendar.era': newEra } },
    )
    return { updated: true, name: resolved.name, months: resolved.months.length, era: newEra }
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
              'data.travel': 1,
              created_at: 1,
            },
          },
        )
        .sort({ 'time_anchor.timeline_id': 1, 'time_anchor.story_calendar.year': 1, 'time_anchor.story_calendar.month': 1, 'time_anchor.story_calendar.day': 1, sequence: 1 })
        .toArray(),
    ])
    const serializedCalendars = calendars.map((c) => ({
        id: idString(c._id),
        name: c.name,
        eras: c.eras,
        months: c.months,
        month_names: (c.months || []).map((m) => m.name),
        season_names: [],
        year_count: null,
        weekdays: c.weekdays || [],
        is_default: c.is_default === true,
      }))
    const primaryCalendar = serializedCalendars.find((c) => c.is_default) || serializedCalendars[0] || null
    return {
      calendars: serializedCalendars,
      month_names: primaryCalendar?.month_names || [],
      season_names: primaryCalendar?.season_names || [],
      year_count: primaryCalendar?.year_count || null,
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
        travel: e.data?.travel || null,
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
