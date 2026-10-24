import { ObjectId, type Document, type Filter, type WithoutId, type WithId } from 'mongodb'
import { mongoColl } from '../config/mongo'
import type { PersonaDoc, PersonaGender, PersonaSnapshotDoc } from '../models/persona.model'
import { HttpError } from '../utils/http-error'
import { idString, parseObjectId } from '../utils/mongo-id'
import { personaService } from './persona.service'

const personas = () => mongoColl.personas()
const worldInstances = () => mongoColl.worldInstances()
const users = () => mongoColl.users()
const worldTemplates = () => mongoColl.worldTemplates()

type PersonaRecord = WithId<WithoutId<PersonaDoc>>
type PersonaFilter = Filter<WithoutId<PersonaDoc>>

/** One console page at a time; the contract caps `limit` here. */
const LIST_LIMIT_MAX = 100
const DEFAULT_LIMIT = 25
/** A save list is for reading one persona, not for dumping a player's career. */
const SAVE_LIST_CAP = 100
const DAY_MS = 24 * 60 * 60 * 1000

export type AdminPersonaSort = 'created' | 'updated' | 'saves'

export type AdminPersonaListOptions = {
  page?: number
  limit?: number
  search?: string
  player_id?: string
  created_from?: string
  created_to?: string
  in_use?: 'true' | 'false'
  min_saves?: number
  sort?: AdminPersonaSort
}

export type AdminPersonaOwner = {
  id: string
  /** `preferences.player_name`, null when the player never chose one. */
  name: string | null
  username: string | null
}

export type AdminPersonaRow = {
  id: string
  name: string
  gender: PersonaGender
  age: number | null
  has_portrait: boolean
  owner: AdminPersonaOwner
  saves: number
  active_saves: number
  last_played_at: string | null
  created_at: string
  updated_at: string
}

export type AdminPersonaSave = {
  id: string
  world: { id: string; title: string | null }
  archived: boolean
  turns: number
  created_at: string
  last_played_at: string | null
  snapshot_matches: boolean
}

export type AdminPersonaDetail = AdminPersonaRow & {
  description: string
  other_info: string
  portrait_styles: string[]
  last_art_style: string | null
  appearance_version: number | null
  save_list: AdminPersonaSave[]
}

type SaveCount = {
  persona_id: ObjectId
  saves: number
  active_saves: number
  last_played_at: Date | null
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * A `YYYY-MM-DD` UTC day.
 *
 * The calendar check is not redundant with the format check: `new Date` accepts
 * `'2026-02-30'` and rolls it into March, so a typo would silently filter on a
 * day that does not exist.
 */
function utcDay(value: string, field: string): Date {
  const invalid = () => new HttpError(400, `${field} must be a real date, written like 2026-10-24.`)
  // Format first: a long enough garbage string should not be handed to `Date`.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw invalid()
  const date = new Date(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw invalid()
  return date
}

function paging(opts: AdminPersonaListOptions) {
  const limit = Math.min(
    Math.max(Math.trunc(Number(opts.limit ?? DEFAULT_LIMIT)) || DEFAULT_LIMIT, 1),
    LIST_LIMIT_MAX,
  )
  const page = Math.max(Math.trunc(Number(opts.page ?? 1)) || 1, 1)
  return { limit, page, skip: (page - 1) * limit }
}

/** Only `_id` for the owner is ever needed: the row carries no other account data. */
function ownerKey(playerId: ObjectId): string {
  return idString(playerId)
}

/**
 * Saves per persona: one grouped pass instead of one query per row.
 *
 * `world_instances` has no index on `persona_id`, so this scans the saves that
 * carry a persona. Asking for one owner's personas narrows that scan through
 * `player_id`, which is indexed; the unfiltered list is what the follow-up
 * partial `{ persona_id: 1 }` index in the phase doc would cover.
 */
async function saveCounts(ownerId?: ObjectId): Promise<Map<string, SaveCount>> {
  const match: Document = { persona_id: { $type: 'objectId' } }
  if (ownerId) match.player_id = ownerId

  const rows = await worldInstances()
    .aggregate<{ _id: ObjectId; saves: number; active_saves: number; last_played_at: Date | null }>([
      { $match: match },
      {
        $group: {
          _id: '$persona_id',
          saves: { $sum: 1 },
          // Archived saves still count as saves; only `active_saves` excludes them.
          active_saves: { $sum: { $cond: [{ $eq: ['$meta.is_archived', true] }, 0, 1] } },
          last_played_at: { $max: { $ifNull: ['$meta.last_active_at', '$updated_at'] } },
        },
      },
    ])
    .toArray()

  return new Map(
    rows.map((row) => [
      idString(row._id),
      {
        persona_id: row._id,
        saves: row.saves,
        active_saves: row.active_saves,
        last_played_at: row.last_played_at ?? null,
      },
    ]),
  )
}

/**
 * Owner names for a page of rows, in one query.
 *
 * `username` and `preferences.player_name` only: a persona row never carries an
 * email, a phone or any other account field, so the projection cannot leak one.
 */
async function owners(playerIds: ObjectId[]): Promise<Map<string, AdminPersonaOwner>> {
  const ids = [...new Map(playerIds.map((id) => [ownerKey(id), id])).values()]
  if (ids.length === 0) return new Map()

  const rows = await users()
    .find({ _id: { $in: ids } }, { projection: { username: 1, 'preferences.player_name': 1 } })
    .toArray()

  return new Map(
    rows.map((row) => {
      const owner = row as { _id: ObjectId; username?: string; preferences?: { player_name?: string } }
      return [
        ownerKey(owner._id),
        {
          id: ownerKey(owner._id),
          name: owner.preferences?.player_name || null,
          username: owner.username || null,
        },
      ]
    }),
  )
}

/**
 * The owner of a persona, with just the id when the account is gone.
 *
 * A deleted account leaves its personas behind (their saves are detached, not
 * the personas), so the row must still render and still link to the player id.
 */
function ownerOf(id: ObjectId, byId: Map<string, AdminPersonaOwner>): AdminPersonaOwner {
  return byId.get(ownerKey(id)) ?? { id: ownerKey(id), name: null, username: null }
}

function portraitStyles(persona: PersonaRecord): string[] {
  const styles = Object.keys(persona.portraits ?? {})
  // The legacy single `portrait` is the painted-default face, so it reads as
  // the `default` style rather than as a style of its own.
  return persona.portrait ? [...styles, 'default'] : styles
}

function hasPortrait(persona: PersonaRecord): boolean {
  return Boolean(persona.portrait) || Object.keys(persona.portraits ?? {}).length > 0
}

function toRow(persona: PersonaRecord, count: SaveCount | undefined, owner: AdminPersonaOwner): AdminPersonaRow {
  return {
    id: idString(persona._id),
    name: persona.name,
    gender: persona.gender,
    age: persona.age ?? null,
    has_portrait: hasPortrait(persona),
    owner,
    saves: count?.saves ?? 0,
    active_saves: count?.active_saves ?? 0,
    last_played_at: count?.last_played_at ? count.last_played_at.toISOString() : null,
    created_at: persona.created_at.toISOString(),
    updated_at: persona.updated_at.toISOString(),
  }
}

/**
 * A save's snapshot is rewritten whenever its persona is edited, so a mismatch
 * means a bug or a save older than the snapshot itself. Compared against the
 * same shape the player service writes, so the two definitions cannot drift.
 */
function snapshotMatches(snapshot: PersonaSnapshotDoc | null | undefined, current: PersonaSnapshotDoc): boolean {
  if (!snapshot) return false
  return (
    snapshot.name === current.name &&
    snapshot.gender === current.gender &&
    (snapshot.age ?? null) === current.age &&
    (snapshot.description ?? '') === current.description &&
    (snapshot.other_info ?? '') === current.other_info
  )
}

/**
 * One page ordered by save count.
 *
 * Mongo cannot sort by a count it does not store, so the ids that carry a save
 * are read (id and creation date only), ordered here, then the page is fetched.
 * Personas with no saves cannot be part of that ordering, so they follow,
 * newest first.
 */
async function pageBySaves(
  filter: PersonaFilter,
  counts: Map<string, SaveCount>,
  skip: number,
  limit: number,
): Promise<AdminPersonaRow[]> {
  const idScope = filter._id as { $in?: ObjectId[]; $nin?: ObjectId[] } | undefined
  const used = [...counts.values()]
  const usedSet = new Set(used.map((count) => idString(count.persona_id)))

  // `in_use=false` excludes every persona with a save, so none of them can be
  // counted; an explicit `$in` is already the candidate set, narrowed to those
  // that really carry a save.
  const candidates = idScope?.$in
    ? idScope.$in.filter((id) => usedSet.has(idString(id)))
    : idScope?.$nin
      ? []
      : used.map((count) => count.persona_id)

  const ordered = candidates.length
    ? await personas().find({ ...filter, _id: { $in: candidates } }, { projection: { _id: 1, created_at: 1 } }).toArray()
    : []

  const saves = (id: ObjectId) => counts.get(idString(id))?.saves ?? 0
  ordered.sort(
    (left, right) =>
      saves(right._id) - saves(left._id) ||
      new Date(right.created_at).getTime() - new Date(left.created_at).getTime() ||
      idString(right._id).localeCompare(idString(left._id)),
  )

  const pageIds = ordered.slice(skip, skip + limit).map((row) => row._id)
  const remaining = limit - pageIds.length

  // With an `$in` scope every candidate carries a save, so there is nothing to
  // fill from; only the unscoped or `$nin`-scoped list has save-less personas.
  if (remaining > 0 && !idScope?.$in) {
    const rest = await personas()
      .find({ ...filter, _id: { $nin: used.map((count) => count.persona_id) } }, { projection: { _id: 1 } })
      .sort({ created_at: -1, _id: -1 })
      .skip(Math.max(0, skip - ordered.length))
      .limit(remaining)
      .toArray()
    pageIds.push(...rest.map((row) => row._id))
  }

  if (pageIds.length === 0) return []
  const rows = await personas().find({ _id: { $in: pageIds } }).toArray()
  const byId = new Map(rows.map((row) => [idString(row._id), row]))
  const ownerById = await owners(rows.map((row) => row.player_id))

  return pageIds
    .map((id) => byId.get(idString(id)))
    .filter((row): row is PersonaRecord => Boolean(row))
    .map((row) => toRow(row, counts.get(idString(row._id)), ownerOf(row.player_id, ownerById)))
}

export const adminPersonaService = {
  async list(opts: AdminPersonaListOptions) {
    const { limit, page, skip } = paging(opts)
    const sort: AdminPersonaSort = opts.sort ?? 'created'
    const ownerId = opts.player_id ? parseObjectId(opts.player_id) : undefined

    const filter: PersonaFilter = {}
    if (ownerId) filter.player_id = ownerId

    const search = opts.search?.trim()
    if (search) {
      // Operator input, not a player's text: an unescaped `.` or `*` would match
      // everything, so the term is escaped before it becomes a pattern.
      const term = escapeRegex(search)
      filter.$or = [
        { name: { $regex: term, $options: 'i' } },
        { description: { $regex: term, $options: 'i' } },
        { other_info: { $regex: term, $options: 'i' } },
      ]
    }

    const from = opts.created_from ? utcDay(opts.created_from, 'Created from') : undefined
    const to = opts.created_to ? utcDay(opts.created_to, 'Created to') : undefined
    if (from || to) {
      // `created_to` is an inclusive day, so the range ends at the next midnight.
      filter.created_at = {
        ...(from ? { $gte: from } : {}),
        ...(to ? { $lt: new Date(to.getTime() + DAY_MS) } : {}),
      }
    }

    const counts = await saveCounts(ownerId)
    const usedIds = () => [...counts.values()].map((count) => count.persona_id)

    // The save-count filters can only be written on `_id`, because Mongo does not
    // know the counts. `in_use=false` is the one exclusion, so it is applied last.
    let included: ObjectId[] | null = null
    if (opts.in_use === 'true') included = usedIds()
    if (opts.min_saves !== undefined) {
      const min = Math.max(Math.trunc(Number(opts.min_saves)) || 1, 1)
      const enough = new Set(
        counts
          .values()
          .filter((count) => count.saves >= min)
          .map((count) => idString(count.persona_id)),
      )
      included = (included ?? usedIds()).filter((id) => enough.has(idString(id)))
    }

    if (opts.in_use === 'false') {
      if (included) {
        // "no saves" and "at least N saves" cannot both hold.
        return { total: 0, page, limit, items: [] }
      }
      filter._id = { $nin: usedIds() }
    } else if (included) {
      filter._id = { $in: included }
    }

    const total = await personas().countDocuments(filter)

    if (sort === 'saves') {
      return { total, page, limit, items: await pageBySaves(filter, counts, skip, limit) }
    }

    const rows = await personas()
      .find(filter)
      .sort(sort === 'updated' ? { updated_at: -1, _id: -1 } : { created_at: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .toArray()

    const byId = await owners(rows.map((row) => row.player_id))
    return {
      total,
      page,
      limit,
      items: rows.map((row) => toRow(row, counts.get(idString(row._id)), ownerOf(row.player_id, byId))),
    }
  },

  async get(personaId: string): Promise<AdminPersonaDetail> {
    const id = parseObjectId(personaId)
    const persona = await personas().findOne({ _id: id })
    if (!persona) throw new HttpError(404, 'Persona not found')

    // `persona_id` has no index, but `player_id` does, so the pair keeps the
    // query on the player index instead of scanning every save.
    const [counts, saves, ownerById] = await Promise.all([
      saveCounts(persona.player_id),
      worldInstances()
        .aggregate<{
          _id: ObjectId
          template_id: ObjectId
          archived: boolean
          turns: number
          created_at: Date
          last_played_at: Date | null
          persona_snapshot: PersonaSnapshotDoc | null
        }>([
          { $match: { player_id: persona.player_id, persona_id: persona._id } },
          // Newest played first, where "played" is the same pair of fields the
          // row advertises: a save with no activity falls back to its update.
          { $addFields: { last_played_at: { $ifNull: ['$meta.last_active_at', '$updated_at'] } } },
          { $sort: { last_played_at: -1, _id: -1 } },
          { $limit: SAVE_LIST_CAP },
          {
            $project: {
              template_id: 1,
              archived: { $eq: ['$meta.is_archived', true] },
              turns: { $ifNull: ['$meta.total_events', 0] },
              created_at: 1,
              last_played_at: 1,
              persona_snapshot: 1,
            },
          },
        ])
        .toArray(),
      owners([persona.player_id]),
    ])

    const templateIds = [...new Map(saves.map((save) => [idString(save.template_id), save.template_id])).values()]
    const titles = new Map(
      (
        templateIds.length
          ? await worldTemplates().find({ _id: { $in: templateIds } }, { projection: { title: 1 } }).toArray()
          : []
      ).map((template) => [idString(template._id), template.title ?? null]),
    )

    const current = personaService.snapshotFromPersona(persona)

    return {
      ...toRow(persona, counts.get(idString(persona._id)), ownerOf(persona.player_id, ownerById)),
      description: persona.description || '',
      other_info: persona.other_info || '',
      portrait_styles: portraitStyles(persona),
      last_art_style: persona.last_art_style ?? null,
      appearance_version: persona.appearance_version ?? null,
      save_list: saves.map((save) => ({
        id: idString(save._id),
        // A deleted world leaves the save pointing at nothing; the title says so
        // rather than the row disappearing.
        world: { id: idString(save.template_id), title: titles.get(idString(save.template_id)) ?? null },
        archived: save.archived === true,
        turns: Number(save.turns ?? 0),
        created_at: save.created_at.toISOString(),
        last_played_at: save.last_played_at ? save.last_played_at.toISOString() : null,
        snapshot_matches: snapshotMatches(save.persona_snapshot, current),
      })),
    }
  },
}
