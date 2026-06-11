import { ObjectId } from 'mongodb'
import { mongoColl } from '../config/mongo'
import type { EntityDoc, EntityType, LocationFactDoc } from '../models/entity.model'
import type { CharacterProfileDoc, RelationshipMeters } from '../models/character-profile.model'
import { characterCodexService } from './character-codex.service'
import { idString, parseObjectId } from '../utils/mongo-id'

const entities = () => mongoColl.entities()
const entityEdges = () => mongoColl.entityEdges()
const characters = () => mongoColl.characters()

/** Same normalization as the codex so the two registries resolve identically. */
export function normalizeEntityName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s'-]+/g, '')
    .replace(/\s+/g, ' ')
}

/**
 * Generic / relative place labels that must NEVER become a canonical location of
 * their own ("the room", "here", "outside", …). On a turn with no narrated
 * movement these mean "still where we were" — i.e. the current cursor, not a new
 * place. Matched as the WHOLE normalized label, so a QUALIFIED name stays
 * specific ("dining room" / "great room" / "throne hall" are NOT vague — only a
 * bare "room" / "the hall" is). This is the location analog of "a bare descriptor
 * is never a new character". See LOCATION_GRAPH.md (P0).
 */
const VAGUE_LOCATION_LABELS = new Set<string>([
  'here', 'there', 'this place', 'that place', 'the place', 'a place', 'someplace',
  'some place', 'somewhere', 'elsewhere', 'nearby', 'around', 'this area', 'the area',
  'the vicinity', 'this spot', 'the spot',
  'outside', 'inside', 'indoors', 'outdoors', 'out',
  'room', 'the room', 'a room', 'this room', 'that room', 'the hall', 'a hall',
  'the chamber', 'a chamber', 'the building', 'a building', 'the space', 'this space',
])

/** A possessive-pronoun + bare room/dwelling noun ("his room", "my chamber",
 *  "her quarters", "their house") is just as RELATIVE as "the room" — it names no
 *  specific place until the owner is resolved, so it must never become a canonical
 *  location of its own. A qualified possessive ("his throne room", "her war study")
 *  keeps its distinctive word and is NOT matched. The owner-scoped form a memory
 *  should actually carry ("Swapnil Sarkar's room") starts with a name, not a
 *  pronoun, so it stays specific. */
const POSSESSIVE_VAGUE_ROOM =
  /^(?:my|his|her|their|its|our|your)\s+(?:own\s+)?(?:room|bedroom|chamber|chambers|hall|study|quarters|den|cabin|cell|office|loft|suite|dorm|place|area|space|building|house|home|apartment|flat|cottage|hut|tent)$/

/** True when a place label is generic/relative (see {@link VAGUE_LOCATION_LABELS}
 *  and {@link POSSESSIVE_VAGUE_ROOM}). */
export function isVagueLocationLabel(name: string | null | undefined): boolean {
  const n = normalizeEntityName(String(name || ''))
  return VAGUE_LOCATION_LABELS.has(n) || POSSESSIVE_VAGUE_ROOM.test(n)
}

function uniqNames(values: string[], max = 20): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of values) {
    const v = String(raw || '').trim()
    if (!v) continue
    const k = v.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(v)
    if (out.length >= max) break
  }
  return out
}

const LOCATION_TOKEN_STOP = new Set(['the', 'a', 'an', 'of', 'in', 'at', 'to', 'and'])
/** Generic place nouns that are NOT distinctive on their own — "room", "hall",
 *  etc. A name made up only of these ("the room") must not fuzzy-match a specific
 *  place that merely shares the noun ("dining room", "great room"): a bedroom is
 *  not the dining room. The distinctive qualifier ("dining") has to match too. */
const GENERIC_PLACE_NOUNS = new Set([
  'room', 'rooms', 'hall', 'halls', 'chamber', 'chambers', 'place', 'area', 'areas',
  'spot', 'space', 'building', 'house', 'home', 'grounds', 'yard', 'quarters',
])
/** Minimum Jaccard score for a conservative fuzzy location match. */
const LOCATION_FUZZY_MIN_SCORE = 0.45

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Significant tokens for location similarity — strips articles/prepositions. */
export function significantLocationTokens(normalized: string): string[] {
  return normalized
    .split(' ')
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !LOCATION_TOKEN_STOP.has(t))
}

/** Normalized canonical + alias forms for one location entity. */
function normalizedLocationNames(entity: Pick<EntityDoc, 'canonical_name' | 'name_normalized' | 'aliases'>): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of [entity.canonical_name, entity.name_normalized, ...(entity.aliases || [])]) {
    const n = normalizeEntityName(String(raw || ''))
    if (!n || seen.has(n)) continue
    seen.add(n)
    out.push(n)
  }
  return out
}

/**
 * Conservative token-containment score between two normalized location names.
 * Returns 0 when names should not merge; 1 for identical strings.
 */
export function scoreLocationNameMatch(queryNorm: string, candidateNorm: string): number {
  if (!queryNorm || !candidateNorm) return 0
  if (queryNorm === candidateNorm) return 1

  const qt = significantLocationTokens(queryNorm)
  const ct = significantLocationTokens(candidateNorm)
  if (!qt.length || !ct.length) return 0

  const shorter = qt.length <= ct.length ? qt : ct
  const longer = qt.length <= ct.length ? ct : qt
  const longerSet = new Set(longer)
  if (!shorter.every((t) => longerSet.has(t))) return 0

  // A name made only of generic place-nouns ("the room", "the hall") is not a
  // confident match for a specific place that just shares the noun — the
  // distinctive qualifier is missing. "dining room" ≠ "the room".
  if (shorter.every((t) => GENERIC_PLACE_NOUNS.has(t))) return 0

  // Single-token shorthand ("garden" → "night garden") needs a strong token.
  if (shorter.length === 1 && shorter[0].length < 4) return 0

  const union = new Set([...qt, ...ct])
  return shorter.length / union.size
}

/** Pick the best fuzzy location match from candidates, or null if none pass threshold. */
export function pickBestLocationMatch(
  queryNorm: string,
  candidates: EntityDoc[],
  minScore = LOCATION_FUZZY_MIN_SCORE,
): EntityDoc | null {
  let best: { entity: EntityDoc; score: number } | null = null
  for (const entity of candidates) {
    for (const candidateNorm of normalizedLocationNames(entity)) {
      const score = scoreLocationNameMatch(queryNorm, candidateNorm)
      if (score < minScore) continue
      if (
        !best ||
        score > best.score ||
        (score === best.score &&
          ((entity.last_seen_sequence || 0) > (best.entity.last_seen_sequence || 0) ||
            ((entity.last_seen_sequence || 0) === (best.entity.last_seen_sequence || 0) &&
              (entity.mention_count || 0) > (best.entity.mention_count || 0))))
      ) {
        best = { entity, score }
      }
    }
  }
  return best?.entity ?? null
}

/** Bounded indexed candidate fetch for fuzzy location resolution (not full-registry).
 *  When `scope` is given, candidates are restricted to one world-root so a place in
 *  another realm can never be a fuzzy match (cross-world dedup safety). */
async function findLocationCandidates(
  iid: ObjectId,
  queryNorm: string,
  limit = 40,
  scope?: { rootId: ObjectId | null },
): Promise<EntityDoc[]> {
  const tokens = significantLocationTokens(queryNorm)
  if (!tokens.length) return []

  const or: Record<string, unknown>[] = []
  for (const token of tokens) {
    const re = escapeRegex(token)
    or.push({ name_normalized: { $regex: re } })
    or.push({ aliases: { $regex: re, $options: 'i' } })
  }

  return (await entities()
    .find({
      instance_id: iid,
      type: 'location',
      status: { $ne: 'archived' },
      ...(scope ? { world_root_id: scope.rootId } : {}),
      $or: or,
    })
    .sort({ last_seen_sequence: -1, mention_count: -1 })
    .limit(limit)
    .toArray()) as EntityDoc[]
}

/** Container place-kinds that define an "area" — the scope within which a place
 *  name dedups. A place's area is its nearest such ancestor (or the top of its
 *  chain). So "tavern" under settlement Ashford and "tavern" under settlement
 *  Riverton are DIFFERENT areas → distinct places; "dining room" and "hallway"
 *  under one mansion (a building) share an area → a return resolves, not duplicates.
 *  This is the "active area" of LOCATION_GRAPH Rule 1, made concrete. */
const AREA_KINDS = new Set(['world', 'region', 'settlement', 'building'])
const AREA_WALK_CAP = 8

function idEq(a: ObjectId | null | undefined, b: ObjectId | null | undefined): boolean {
  if (!a && !b) return true
  if (!a || !b) return false
  return idString(a) === idString(b)
}

/**
 * The AREA a place belongs to, given the id of its immediate container (parent).
 * Walks the parent chain (cheap, indexed, depth-capped) and returns the nearest
 * `AREA_KINDS` ancestor (including the parent itself), or the topmost ancestor if
 * none — or null when there is no container at all (a top-level place). Pass the
 * PARENT id (the same starting point for a candidate's parent and for an intended
 * placement's parent), so both sides are compared consistently.
 */
async function resolveAreaId(
  iid: ObjectId,
  parentId: ObjectId | null | undefined,
  cache?: Map<string, ObjectId | null>,
): Promise<ObjectId | null> {
  if (!parentId) return null
  const key = idString(parentId)
  if (cache?.has(key)) return cache.get(key) ?? null
  let currentId: ObjectId | null = parentId
  let area: ObjectId | null = parentId
  for (let i = 0; i < AREA_WALK_CAP && currentId; i++) {
    const node = (await entities().findOne(
      { _id: currentId, instance_id: iid, type: 'location' },
      { projection: { parent_id: 1, place_kind: 1 } },
    )) as EntityDoc | null
    if (!node) break
    area = currentId
    if (node.place_kind && AREA_KINDS.has(node.place_kind)) break
    if (!node.parent_id) break
    currentId = node.parent_id as ObjectId
  }
  cache?.set(key, area)
  return area
}

/** Provenance cap per edge: enough to survive partial rewinds without growing unbounded. */
const EDGE_SOURCE_EVENTS_MAX = 30
/** Relationship-meter baselines (mirrors the codex ledger). */
const METER_BASELINES: RelationshipMeters = { trust: 50, affection: 50, fear: 0, rivalry: 0 }
const METER_KEYS = ['trust', 'affection', 'fear', 'rivalry'] as const

export type EntityMention = { name: string; type?: EntityType }

/** Name/alias → entity lookup map for one instance. */
async function loadEntityRegistry(iid: ObjectId): Promise<Map<string, EntityDoc>> {
  const all = (await entities()
    .find({ instance_id: iid, status: { $ne: 'archived' } })
    .toArray()) as EntityDoc[]
  const byName = new Map<string, EntityDoc>()
  for (const e of all) {
    byName.set(e.name_normalized, e)
    for (const a of e.aliases || []) {
      const n = normalizeEntityName(a)
      if (n && !byName.has(n)) byName.set(n, e)
    }
  }
  return byName
}

export const entityGraphService = {
  normalizeEntityName,

  /**
   * Resolve mentions to entities, creating any first-mention entities (dedup by
   * normalized name/alias across the whole registry — a "Mira" location mention
   * never duplicates the "Mira" character entity). Matched entities get their
   * mention_count / last_seen bumped. Returns a normalized-name → entity map
   * that also covers aliases.
   */
  async resolveOrCreateEntities(params: {
    instanceId: string
    playerId: string
    sequence: number
    mentions: EntityMention[]
  }): Promise<Map<string, EntityDoc>> {
    const { instanceId, playerId, sequence, mentions } = params
    const iid = parseObjectId(instanceId)
    const pid = parseObjectId(playerId)
    const byName = await loadEntityRegistry(iid)
    if (!mentions.length) return byName

    const now = new Date()
    const toCreate: EntityDoc[] = []
    const touchedIds: ObjectId[] = []
    const seen = new Set<string>()

    for (const mention of mentions) {
      const name = String(mention.name || '').trim()
      const normalized = normalizeEntityName(name)
      if (!normalized || normalized.length < 2 || seen.has(normalized)) continue
      seen.add(normalized)

      // A vague/relative location label ("room", "outside", "here") must NOT mint a
      // standalone location entity from a memory mention — that fragments the place
      // graph into a ghost atlas node, exactly what the cursor path's vague guard
      // prevents. The memory already carries the real place via its location_anchor;
      // the redundant subject/object link is pure noise. (Found by a live turn:
      // "seeks refuge in his room" minted a bare "room" beside "<owner>'s room".)
      if (mention.type === 'location' && isVagueLocationLabel(normalized)) continue

      const existing = byName.get(normalized)
      if (existing) {
        touchedIds.push(existing._id)
        continue
      }

      const doc: EntityDoc = {
        _id: new ObjectId(),
        instance_id: iid,
        player_id: pid,
        type: mention.type || 'concept',
        canonical_name: name.slice(0, 120),
        name_normalized: normalized,
        aliases: [],
        status: 'active',
        first_seen_sequence: sequence,
        last_seen_sequence: sequence,
        mention_count: 1,
        created_at: now,
        updated_at: now,
      }
      toCreate.push(doc)
      byName.set(normalized, doc)
    }

    if (toCreate.length > 0) {
      try {
        await entities().insertMany(toCreate, { ordered: false })
      } catch {
        // Concurrent duplicate on the unique (instance_id, type, name_normalized)
        // index: the existing row wins; the next mention resolves to it.
      }
    }
    if (touchedIds.length > 0) {
      await entities().updateMany(
        { _id: { $in: touchedIds } },
        {
          $inc: { mention_count: 1 },
          $max: { last_seen_sequence: sequence },
          $set: { updated_at: now },
        },
      )
    }
    return byName
  },

  /**
   * Keep codex cards and character entities 1:1. For each card: link to its
   * entity (by stored entity_id, by character_id back-pointer, or by
   * name/alias), create the entity on first sight, sync names/aliases, and
   * backfill card.entity_id. Idempotent and cheap when nothing changed.
   */
  async syncCodexEntities(params: {
    instanceId: string
    playerId: string
    sequence: number
    cards: CharacterProfileDoc[]
  }): Promise<Map<string, EntityDoc>> {
    const { instanceId, playerId, sequence, cards } = params
    const iid = parseObjectId(instanceId)
    const pid = parseObjectId(playerId)
    const now = new Date()

    const existing = (await entities()
      .find({ instance_id: iid, type: { $in: ['protagonist', 'character'] } })
      .toArray()) as EntityDoc[]
    const byCharId = new Map<string, EntityDoc>()
    const byName = new Map<string, EntityDoc>()
    for (const e of existing) {
      if (e.character_id) byCharId.set(idString(e.character_id), e)
      byName.set(e.name_normalized, e)
      for (const a of e.aliases || []) {
        const n = normalizeEntityName(a)
        if (n && !byName.has(n)) byName.set(n, e)
      }
    }

    const result = new Map<string, EntityDoc>()
    const toCreate: EntityDoc[] = []
    // Card back-links are written only AFTER the entity rows verifiably exist
    // — writing them first could leave a card pointing at an entity whose
    // insert lost a duplicate race and never landed.
    const pendingLinks: Array<{ card: CharacterProfileDoc; entity: EntityDoc }> = []

    for (const card of cards) {
      if (!card?._id || !card.canonical_name) continue
      const wantType: EntityType = card.is_protagonist ? 'protagonist' : 'character'
      const cardNames = [card.name_normalized, ...(card.aliases || []).map(normalizeEntityName)]

      let entity =
        (card.entity_id && existing.find((e) => e._id.equals(card.entity_id!))) ||
        byCharId.get(idString(card._id)) ||
        cardNames.map((n) => byName.get(n)).find(Boolean)

      if (!entity) {
        entity = {
          _id: new ObjectId(),
          instance_id: iid,
          player_id: pid,
          type: wantType,
          canonical_name: card.canonical_name,
          name_normalized: card.name_normalized,
          aliases: uniqNames(card.aliases || []),
          character_id: card._id,
          status: 'active',
          first_seen_sequence: card.first_seen_sequence ?? sequence,
          last_seen_sequence: card.last_seen_sequence ?? sequence,
          mention_count: card.mention_count || 1,
          created_at: now,
          updated_at: now,
        }
        toCreate.push(entity)
        byName.set(entity.name_normalized, entity)
        byCharId.set(idString(card._id), entity)
      } else {
        // Sync identity drift: renamed card, new aliases, re-minted card _id
        // (rewind rebuilds cards with fresh ids), protagonist promotion.
        const mergedAliases = uniqNames([...(entity.aliases || []), ...(card.aliases || [])])
        const dirty =
          !entity.character_id?.equals(card._id) ||
          entity.canonical_name !== card.canonical_name ||
          entity.type !== wantType ||
          mergedAliases.length !== (entity.aliases || []).length ||
          (entity.last_seen_sequence || 0) < (card.last_seen_sequence || 0)
        if (dirty) {
          entity.character_id = card._id
          entity.canonical_name = card.canonical_name
          entity.name_normalized = card.name_normalized
          entity.type = wantType
          entity.aliases = mergedAliases
          entity.last_seen_sequence = Math.max(
            entity.last_seen_sequence || 0,
            card.last_seen_sequence || 0,
          )
          entity.updated_at = now
          const { _id, ...rest } = entity
          await entities().updateOne({ _id }, { $set: rest })
        }
      }
      result.set(card.name_normalized, entity)
      if (!card.entity_id || !card.entity_id.equals(entity._id)) {
        pendingLinks.push({ card, entity })
      }
    }

    if (toCreate.length > 0) {
      try {
        await entities().insertMany(toCreate, { ordered: false })
      } catch {
        // Duplicate race: some rows lost to a concurrent insert. Remapped below.
      }
      // Verify what actually landed; remap losers to the winner row so result
      // and card links never reference a phantom entity id.
      const present = new Set(
        (
          await entities()
            .find({ _id: { $in: toCreate.map((e) => e._id) } }, { projection: { _id: 1 } })
            .toArray()
        ).map((e) => idString(e._id)),
      )
      for (const lost of toCreate) {
        if (present.has(idString(lost._id))) continue
        const winner = (await entities().findOne({
          instance_id: iid,
          type: lost.type,
          name_normalized: lost.name_normalized,
        })) as EntityDoc | null
        for (const [key, value] of result) {
          if (value === lost) result.set(key, winner ?? value)
        }
        for (const link of pendingLinks) {
          if (link.entity === lost && winner) link.entity = winner
        }
        if (!winner) {
          // Neither our row nor a winner exists (transient failure): drop the
          // link rather than dangle it; the next turn's sync re-creates.
          const idx = pendingLinks.findIndex((l) => l.entity === lost)
          if (idx >= 0) pendingLinks.splice(idx, 1)
        } else if (!winner.character_id) {
          await entities().updateOne(
            { _id: winner._id },
            { $set: { character_id: lost.character_id, updated_at: now } },
          )
        }
      }
    }

    for (const { card, entity } of pendingLinks) {
      if (card.entity_id?.equals(entity._id)) continue
      await characters().updateOne(
        { _id: card._id },
        { $set: { entity_id: entity._id, updated_at: now } },
      )
      card.entity_id = entity._id
    }
    return result
  },

  /** The singleton player entity for an instance (created lazily). */
  async ensurePlayerEntity(params: {
    instanceId: string
    playerId: string
    name?: string
    sequence: number
  }): Promise<EntityDoc> {
    const { instanceId, playerId, name, sequence } = params
    const iid = parseObjectId(instanceId)
    const pid = parseObjectId(playerId)
    const found = (await entities().findOne({ instance_id: iid, type: 'player' })) as EntityDoc | null
    if (found) return found
    const trimmed = (name || '').trim() || 'The Player'
    const now = new Date()
    const doc: EntityDoc = {
      _id: new ObjectId(),
      instance_id: iid,
      player_id: pid,
      type: 'player',
      canonical_name: trimmed.slice(0, 120),
      name_normalized: normalizeEntityName(trimmed),
      // "player"/"the player" always resolve here — memory atoms use "player"
      // as the canonical subject for the human.
      aliases: ['player', 'the player'].filter((a) => a !== normalizeEntityName(trimmed)),
      status: 'active',
      first_seen_sequence: 0,
      last_seen_sequence: sequence,
      mention_count: 1,
      created_at: now,
      updated_at: now,
    }
    try {
      await entities().insertOne(doc)
      return doc
    } catch {
      return (await entities().findOne({ instance_id: iid, type: 'player' })) as EntityDoc
    }
  },

  /**
   * Project the codex relationship ledger onto player→character meter edges
   * (type = trust/affection/fear/rivalry, weight = the current 0-100 meter).
   * $set (not $inc) keeps this idempotent and lets the rewind repair simply
   * re-project the rebuilt cards — the meters themselves replay exactly.
   */
  async syncRelationshipEdges(params: {
    instanceId: string
    playerId: string
    sequence: number
    eventId: ObjectId | null
    cards: CharacterProfileDoc[]
    /** Card-name-normalized → entity map (from syncCodexEntities). */
    entitiesByCardName: Map<string, EntityDoc>
    playerName?: string
  }): Promise<void> {
    const { instanceId, playerId, sequence, eventId, cards, entitiesByCardName, playerName } = params
    const withMeters = cards.filter((c) => c.relationship && entitiesByCardName.get(c.name_normalized))
    if (withMeters.length === 0) return
    const iid = parseObjectId(instanceId)
    const player = await this.ensurePlayerEntity({ instanceId, playerId, name: playerName, sequence })
    const now = new Date()

    for (const card of withMeters) {
      const entity = entitiesByCardName.get(card.name_normalized)!
      for (const key of METER_KEYS) {
        const value = card.relationship![key]
        if (typeof value !== 'number' || value === METER_BASELINES[key]) continue
        const importance = Math.min(5, Math.max(1, Math.ceil(Math.abs(value - METER_BASELINES[key]) / 10)))
        await entityEdges().updateOne(
          {
            instance_id: iid,
            source_entity_id: entity._id,
            target_entity_id: player._id,
            type: key,
            // Meter edges are label-less; pinning null keeps them distinct
            // from any labeled assertion under the label-aware unique index.
            label: null,
          },
          {
            $set: {
              weight: value,
              importance,
              status: 'active',
              last_event_sequence: sequence,
              updated_at: now,
            },
            $setOnInsert: { created_at: now, ...(eventId ? {} : { source_event_ids: [] }) },
            ...(eventId
              ? { $push: { source_event_ids: { $each: [eventId], $slice: -EDGE_SOURCE_EVENTS_MAX } } }
              : {}),
          } as never,
          { upsert: true },
        )
      }
    }
  },

  /**
   * Free-form narrative edge between two entities ("betrayed", "forgave",
   * "traveled_to", or a generic "relationship" with a label). The label is
   * part of edge IDENTITY: each distinct assertion is its own edge with its
   * own provenance, so removing the turn that said "forgave" deletes the
   * forgiveness edge and leaves the earlier "betrayed" edge intact — a merged
   * edge would survive a rewind wearing whichever label came last.
   */
  async upsertNarrativeEdge(params: {
    instanceId: string
    sourceEntityId: ObjectId
    targetEntityId: ObjectId
    type: string
    label?: string
    importance?: number
    eventId: ObjectId
    sequence: number
  }): Promise<void> {
    const { instanceId, sourceEntityId, targetEntityId, type, label, importance, eventId, sequence } = params
    const iid = parseObjectId(instanceId)
    const now = new Date()
    await entityEdges().updateOne(
      {
        instance_id: iid,
        source_entity_id: sourceEntityId,
        target_entity_id: targetEntityId,
        type,
        label: label ? label.slice(0, 300) : null,
      },
      {
        $set: {
          status: 'active',
          last_event_sequence: sequence,
          updated_at: now,
        },
        $max: { importance: Math.min(5, Math.max(1, importance ?? 3)) },
        $setOnInsert: { created_at: now },
        $push: { source_event_ids: { $each: [eventId], $slice: -EDGE_SOURCE_EVENTS_MAX } },
      } as never,
      { upsert: true },
    )
  },

  /**
   * Entities DIRECTLY NAMED in `text` — the registry-backed generalization of
   * the codex-only mention scan. Whole-word match on normalized names/aliases
   * (≥3 chars) so "Vex" hits but "vexed" doesn't.
   */
  async findEntitiesMentioned(
    instanceId: string,
    text: string,
    opts: { types?: EntityType[]; limit?: number } = {},
  ): Promise<EntityDoc[]> {
    const clean = (text || '').trim()
    if (clean.length < 3) return []
    const iid = parseObjectId(instanceId)
    const limit = opts.limit ?? 8

    const filter: Record<string, unknown> = { instance_id: iid, status: { $ne: 'archived' } }
    if (opts.types?.length) filter.type = { $in: opts.types }
    const roster = (await entities()
      .find(filter, {
        projection: {
          canonical_name: 1,
          name_normalized: 1,
          aliases: 1,
          type: 1,
          character_id: 1,
        },
      })
      .toArray()) as EntityDoc[]
    if (roster.length === 0) return []

    const haystack = ` ${normalizeEntityName(clean)} `
    const matched: EntityDoc[] = []
    for (const e of roster) {
      const names = uniqNames([e.canonical_name, ...(e.aliases || [])])
        .map(normalizeEntityName)
        .filter((n) => n.length >= 3)
      if (names.some((n) => haystack.includes(` ${n} `))) {
        matched.push(e)
        if (matched.length >= limit) break
      }
    }
    return matched
  },

  /**
   * Codex cards + entity ids for everything the player named this turn. The
   * codex scan stays AUTHORITATIVE for card pinning: entity backfill is lazy
   * (sync only touches cards a turn hands it), so registry-only matching could
   * silently miss a dormant card that has no entity yet. The registry's job
   * here is the non-character mentions (locations, items, factions…) whose ids
   * drive neighborhood retrieval.
   */
  async findMentionedCharacterCards(
    instanceId: string,
    text: string,
    excludeIds: string[],
    limit = 5,
  ): Promise<{ cards: CharacterProfileDoc[]; mentionedEntityIds: string[] }> {
    const [mentioned, cards] = await Promise.all([
      this.findEntitiesMentioned(instanceId, text),
      characterCodexService.findMentionedCharacters(instanceId, text, excludeIds, limit),
    ])
    return { cards, mentionedEntityIds: mentioned.map((e) => idString(e._id)) }
  },

  /**
   * Resolve a location name to an existing entity or create one. Uses indexed
   * exact lookup first, then a bounded token-similarity pass over location
   * candidates — so long-tail returns ("the garden" → "Night Garden") dedupe
   * even when the place isn't in the 30-name extractor roster, without loading
   * the full entity registry every turn.
   */
  async resolveLocationAnchor(params: {
    instanceId: string
    playerId: string
    sequence: number
    name?: string | null
    /** Whether the model asserted the viewpoint physically moved this turn. A
     *  vague/relative label ("the room", "outside") on an UNMOVED turn means
     *  "still here" — we return null so the caller keeps the cursor instead of
     *  minting a generic place. A SPECIFIC place still resolves even when unmoved
     *  (a return the model under-flags must still update the cursor). */
    viewpointMoved?: boolean
    /** When set, restrict exact + fuzzy matching to ONE world-root (incl. the
     *  implicit `null` root) so a place in another realm can never match — the
     *  cartographer passes the active root for cross-world dedup safety. */
    scope?: { rootId: ObjectId | null }
    /** When set, a name match is valid only if the candidate shares this AREA (its
     *  nearest settlement/building ancestor; see {@link resolveAreaId}) — so the
     *  same name under a DIFFERENT settlement mints a distinct place instead of
     *  fusing (intra-world collision fix), while same-area returns still resolve.
     *  The cartographer passes the intended placement's area. Absent → name match
     *  is world-root-wide (the lenient default, correct when there is no reliable
     *  container signal). */
    areaScope?: { areaId: ObjectId | null }
    /** Containment fields stamped onto a NEWLY-minted location (the cartographer
     *  decides these from movement + hints). Ignored when an existing place is
     *  matched. */
    create?: { parentId?: ObjectId | null; worldRootId?: ObjectId | null; placeKind?: string }
  }): Promise<{ entity_id: ObjectId; name: string; name_normalized: string } | null> {
    const name = String(params.name || '').replace(/\s+/g, ' ').trim().slice(0, 120)
    const normalized = normalizeEntityName(name)
    if (!normalized || normalized.length < 3) return null

    // Vague-label guard (P0): a generic/relative label on a turn with no narrated
    // movement never mints or matches a new place — the cursor stays put.
    if (!params.viewpointMoved && isVagueLocationLabel(normalized)) return null

    const iid = parseObjectId(params.instanceId)
    const pid = parseObjectId(params.playerId)
    const now = new Date()
    const scopeFilter = params.scope ? { world_root_id: params.scope.rootId } : {}
    // Area gate: a candidate counts only if it shares the intended placement's area.
    const areaCache = new Map<string, ObjectId | null>()
    const inArea = async (e: EntityDoc): Promise<boolean> => {
      if (!params.areaScope) return true
      const a = await resolveAreaId(iid, e.parent_id ?? null, areaCache)
      return idEq(a, params.areaScope.areaId)
    }

    // 1. Indexed exact match on canonical name (within the world-root if scoped).
    //    With an areaScope, scan same-name rows and take the one in the same area
    //    (same name can now coexist across areas), else the lenient single match.
    let entity: EntityDoc | null = null
    if (params.areaScope) {
      const sameName = (await entities()
        .find({ instance_id: iid, type: 'location', name_normalized: normalized, status: { $ne: 'archived' }, ...scopeFilter })
        .toArray()) as EntityDoc[]
      for (const cand of sameName) {
        if (await inArea(cand)) { entity = cand; break }
      }
    } else {
      entity = (await entities().findOne({
        instance_id: iid,
        type: 'location',
        name_normalized: normalized,
        status: { $ne: 'archived' },
        ...scopeFilter,
      })) as EntityDoc | null
    }

    // 2. Bounded fuzzy match (canonical + aliases) when exact misses.
    if (!entity) {
      let candidates = await findLocationCandidates(iid, normalized, 40, params.scope)
      if (params.areaScope) {
        const kept: EntityDoc[] = []
        for (const c of candidates) if (await inArea(c)) kept.push(c)
        candidates = kept
      }
      entity = pickBestLocationMatch(normalized, candidates)
    }

    if (entity) {
      await entities().updateOne(
        { _id: entity._id },
        {
          $inc: { mention_count: 1 },
          $max: { last_seen_sequence: params.sequence },
          $set: { updated_at: now },
        },
      )
      return {
        entity_id: entity._id,
        name: entity.canonical_name,
        name_normalized: entity.name_normalized,
      }
    }

    // 3. Mint a new location entity (duplicate race → existing row wins). The
    // unique index is (instance, type, world_root_id, name) so the same name in a
    // different world is a distinct row, not a collision.
    const rootId = params.create?.worldRootId ?? params.scope?.rootId ?? null
    const doc: EntityDoc = {
      _id: new ObjectId(),
      instance_id: iid,
      player_id: pid,
      type: 'location',
      canonical_name: name,
      name_normalized: normalized,
      aliases: [],
      status: 'active',
      first_seen_sequence: params.sequence,
      last_seen_sequence: params.sequence,
      mention_count: 1,
      parent_id: params.create?.parentId ?? null,
      world_root_id: rootId,
      ...(params.create?.placeKind ? { place_kind: params.create.placeKind } : {}),
      created_at: now,
      updated_at: now,
    }
    try {
      await entities().insertOne(doc)
      entity = doc
    } catch {
      // Unique-index race: the colliding row is the one with the SAME parent + name
      // in this world-root (the new index includes parent_id), so target it exactly.
      entity = (await entities().findOne({
        instance_id: iid,
        type: 'location',
        name_normalized: normalized,
        parent_id: doc.parent_id ?? null,
        ...scopeFilter,
      })) as EntityDoc | null
    }
    if (!entity) return null
    return {
      entity_id: entity._id,
      name: entity.canonical_name,
      name_normalized: entity.name_normalized,
    }
  },

  /**
   * The CARTOGRAPHER (P1). Turns the scene extractor's WITNESS hints
   * (`current_place` + `containment_hint` + `movement`) into a placed location in
   * the containment graph — the server owns the map, the model only observes.
   * Resolves/mints the destination SCOPED to the active world-root (so a place in
   * another realm can never collide), stamping `parent_id` / `world_root_id`:
   *   - deeper  → parent = the place we were in
   *   - out     → parent = the place we were in's parent (one level up)
   *   - lateral → parent = same as the place we were in
   *   - world_shift → mint/reuse a world-root (the realm) and hang the place under it
   * An explicit `containment_hint` overrides the inferred parent. On an UNMOVED
   * turn whose prose newly reveals the current place's container, the cursor is
   * re-parented (fills an unknown parent only — never thrashes a known one).
   * Returns the destination anchor, or null to keep the current cursor.
   */
  async placeLocation(params: {
    instanceId: string
    playerId: string
    sequence: number
    name?: string | null
    containmentHint?: string | null
    movement?: 'none' | 'deeper' | 'out' | 'lateral' | 'world_shift'
    viewpointMoved?: boolean
    cursorEntityId?: ObjectId | string | null
  }): Promise<{ entity_id: ObjectId; name: string; name_normalized: string } | null> {
    const name = String(params.name || '').replace(/\s+/g, ' ').trim().slice(0, 120)
    const normalized = normalizeEntityName(name)
    const movement = params.movement || (params.viewpointMoved ? 'lateral' : 'none')
    const moved = params.viewpointMoved === true || movement !== 'none'
    const iid = parseObjectId(params.instanceId)

    // Load the current cursor entity for its place in the graph.
    const cursor = params.cursorEntityId
      ? ((await entities().findOne({
          _id: typeof params.cursorEntityId === 'string' ? parseObjectId(params.cursorEntityId) : params.cursorEntityId,
          instance_id: iid,
          type: 'location',
        })) as EntityDoc | null)
      : null
    const activeRoot: ObjectId | null = cursor?.world_root_id ?? null

    // Re-parent reveal: on an unmoved turn whose prose names the CURRENT place's
    // container for the first time, fill the cursor's unknown parent (only when
    // it is currently unknown — never override an established parent).
    if (!moved && cursor && (cursor.parent_id == null) && params.containmentHint && !isVagueLocationLabel(params.containmentHint)) {
      const container = await this.resolveLocationAnchor({
        instanceId: params.instanceId, playerId: params.playerId, sequence: params.sequence,
        name: params.containmentHint, viewpointMoved: true, scope: { rootId: activeRoot },
        create: { worldRootId: activeRoot },
      })
      if (container && idString(container.entity_id) !== idString(cursor._id)) {
        await entities().updateOne({ _id: cursor._id }, { $set: { parent_id: container.entity_id, updated_at: new Date() } })
        // Keep the moved subtree's denormalized root consistent with its new
        // parent. Same-root today (the container is scoped to activeRoot), so a
        // no-op here — but this makes "a re-parent keeps world_root_id correct" an
        // enforced invariant rather than a TODO, for when cross-root re-parents land.
        const parentNode = (await entities().findOne(
          { _id: container.entity_id, instance_id: iid, type: 'location' },
          { projection: { world_root_id: 1 } },
        )) as EntityDoc | null
        // The parent's root: its denormalized `world_root_id` (a real root is
        // self-referential, world_root_id == _id), or null for the implicit
        // single world — NEVER the parent's bare id (that would invent a root).
        const newRoot = parentNode?.world_root_id ?? null
        if (idString(newRoot) !== idString(cursor.world_root_id ?? null)) {
          await this.refreshSubtreeWorldRoot({ instanceId: params.instanceId, nodeId: cursor._id, newRootId: newRoot })
        }
      }
    }

    if (!normalized || normalized.length < 3) return null
    // Vague label on an unmoved turn → stay put (the cursor).
    if (!moved && isVagueLocationLabel(normalized)) return null

    // World shift: mint/reuse a world-root for the realm, hang the place under it.
    if (movement === 'world_shift') {
      const realmName = (params.containmentHint && !isVagueLocationLabel(params.containmentHint))
        ? params.containmentHint.replace(/\s+/g, ' ').trim().slice(0, 120)
        : name
      const realmNorm = normalizeEntityName(realmName)
      let root = (await entities().findOne({
        instance_id: iid, type: 'location', name_normalized: realmNorm,
        $expr: { $eq: ['$world_root_id', '$_id'] },
      })) as EntityDoc | null
      if (!root) {
        const rid = new ObjectId()
        const now = new Date()
        root = {
          _id: rid, instance_id: iid, player_id: parseObjectId(params.playerId), type: 'location',
          canonical_name: realmName, name_normalized: realmNorm, aliases: [], status: 'active',
          first_seen_sequence: params.sequence, last_seen_sequence: params.sequence, mention_count: 1,
          parent_id: null, world_root_id: rid, place_kind: 'world', created_at: now, updated_at: now,
        }
        try { await entities().insertOne(root) }
        catch { root = (await entities().findOne({ instance_id: iid, type: 'location', name_normalized: realmNorm, $expr: { $eq: ['$world_root_id', '$_id'] } })) as EntityDoc | null }
      }
      if (!root) return null
      // The realm itself is the destination when no distinct sub-place was named.
      if (realmNorm === normalized) {
        return { entity_id: root._id, name: root.canonical_name, name_normalized: root.name_normalized }
      }
      return this.resolveLocationAnchor({
        instanceId: params.instanceId, playerId: params.playerId, sequence: params.sequence,
        name, viewpointMoved: true, scope: { rootId: root._id },
        create: { parentId: root._id, worldRootId: root._id },
      })
    }

    // Same-world placement. Resolve an explicit container hint (scoped) to use as
    // the parent; otherwise infer the parent from the movement direction.
    let parentId: ObjectId | null = null
    if (params.containmentHint && !isVagueLocationLabel(params.containmentHint)) {
      const container = await this.resolveLocationAnchor({
        instanceId: params.instanceId, playerId: params.playerId, sequence: params.sequence,
        name: params.containmentHint, viewpointMoved: true, scope: { rootId: activeRoot },
        create: { worldRootId: activeRoot },
      })
      if (container) parentId = container.entity_id
    }
    if (!parentId) {
      if (movement === 'deeper') parentId = cursor?._id ?? null
      else if (movement === 'out' || movement === 'lateral') parentId = cursor?.parent_id ?? null
    }

    // Dedup within the intended placement's AREA (nearest settlement/building) so a
    // same-named place under a DIFFERENT settlement mints distinct instead of fusing,
    // while same-building returns still resolve. Only when we have a container to
    // anchor the area on — a parentless top-level placement keeps the lenient
    // world-root match (and the unique index already blocks a true top-level dupe).
    const areaScope = parentId ? { areaId: await resolveAreaId(iid, parentId) } : undefined

    return this.resolveLocationAnchor({
      instanceId: params.instanceId, playerId: params.playerId, sequence: params.sequence,
      name, viewpointMoved: moved, scope: { rootId: activeRoot }, areaScope,
      create: { parentId, worldRootId: activeRoot },
    })
  },

  /**
   * Refresh the denormalized `world_root_id` across a re-parented node's subtree
   * so it matches its new parent's world-root. `world_root_id` is a cached
   * top-of-chain (the spine truth is `parent_id`), so when a node moves under a
   * parent in a DIFFERENT root — a future multi-world re-parent — the node and
   * every descendant must adopt the new root or place-recall scoping reads a
   * stale realm. (No current path crosses roots; this keeps the invariant true by
   * construction the moment one does — closes the P1 KNOWN LIMIT.) Deterministic,
   * idempotent BFS down `parent_id`. A self-rooted DESCENDANT (a nested world that
   * anchors its own subtree) is never rerooted and stops the descent; only the
   * start node may shed its old root. Bounded depth guards cycles/bad data.
   */
  async refreshSubtreeWorldRoot(params: {
    instanceId: string
    /** The re-parented node whose subtree must adopt the new root. */
    nodeId: ObjectId
    /** The world-root the node now belongs to (its parent's `world_root_id`, or
     *  the parent's own `_id` when the parent IS a root). null = back under the
     *  implicit single world. */
    newRootId: ObjectId | null
  }): Promise<number> {
    const iid = parseObjectId(params.instanceId)
    const { nodeId, newRootId } = params
    const DEPTH_CAP = 12 // location graphs run ~5-6 deep; cap guards cycles
    const seen = new Set<string>()
    let frontier: ObjectId[] = [nodeId]
    let updated = 0

    for (let depth = 0; depth < DEPTH_CAP && frontier.length; depth++) {
      const fresh = frontier.filter((id) => !seen.has(idString(id)))
      fresh.forEach((id) => seen.add(idString(id)))
      if (!fresh.length) break

      // A node already at the target root is left untouched (idempotent, true
      // no-op re-runs). Descendants that ARE world-roots anchor their own subtree
      // → never rerooted; only the explicit start node sheds its root.
      const rootGuard = depth === 0 ? {} : { $expr: { $ne: ['$world_root_id', '$_id'] } }
      const res = await entities().updateMany(
        { instance_id: iid, type: 'location', _id: { $in: fresh }, world_root_id: { $ne: newRootId }, ...rootGuard },
        { $set: { world_root_id: newRootId, updated_at: new Date() } },
      )
      updated += res.modifiedCount || 0

      // Descend, but stop at any self-rooted node (its children belong to ITS root).
      const stopIds = depth === 0
        ? new Set<string>()
        : new Set(
            (await entities()
              .find(
                { instance_id: iid, type: 'location', _id: { $in: fresh }, $expr: { $eq: ['$world_root_id', '$_id'] } },
                { projection: { _id: 1 } },
              )
              .toArray()).map((d) => idString(d._id)),
          )
      const parents = fresh.filter((id) => !stopIds.has(idString(id)))
      frontier = parents.length
        ? (await entities()
            .find(
              { instance_id: iid, type: 'location', parent_id: { $in: parents } },
              { projection: { _id: 1 } },
            )
            .toArray()).map((d) => d._id as ObjectId)
        : []
    }
    return updated
  },

  /**
   * The places this world already knows, by canonical name + aliases, most
   * recently/often seen first. Fed to the scene extractor so a RETURN to a known
   * place reuses its canonical name instead of minting a near-duplicate location
   * entity ("the garden" vs "night garden") — which would split the Places
   * journal and break "go back to where I was".
   */
  async listKnownLocations(
    instanceId: string,
    limit = 30,
  ): Promise<{ name: string; aliases: string[] }[]> {
    const iid = parseObjectId(instanceId)
    const docs = await entities()
      .find(
        { instance_id: iid, type: 'location' },
        { projection: { canonical_name: 1, aliases: 1 } },
      )
      .sort({ last_seen_sequence: -1, mention_count: -1 })
      .limit(limit)
      .toArray()
    return (docs as any[])
      .filter((d) => d.canonical_name)
      .map((d) => ({ name: d.canonical_name as string, aliases: (d.aliases || []) as string[] }))
  },

  /**
   * Record what changed about a place this turn onto its location entity.
   * `state` is mutable condition (bounded ring — newest kept), `facts` is
   * enduring canon (append-only, bounded). Both carry event provenance so a
   * rewind or edit that removes the source turn can pull them back out
   * ({@link pruneLocationFactsByEvents}, rewind range-prune). Dedupes against
   * what the place already asserts so repeated beats don't pile up.
   */
  async applyLocationFacts(params: {
    instanceId: string
    locationEntityId: ObjectId
    sequence: number
    eventId: ObjectId
    state?: string[]
    facts?: string[]
  }): Promise<void> {
    const state = (params.state || []).map((s) => s.trim()).filter(Boolean)
    const facts = (params.facts || []).map((s) => s.trim()).filter(Boolean)
    if (!state.length && !facts.length) return
    const iid = parseObjectId(params.instanceId)
    const entity = (await entities().findOne(
      { _id: params.locationEntityId, instance_id: iid, type: 'location' },
      { projection: { location_state: 1, location_facts: 1 } },
    )) as Pick<EntityDoc, 'location_state' | 'location_facts'> | null
    if (!entity) return

    const now = new Date()
    const STATE_CAP = 12
    const FACTS_CAP = 30
    const seen = (list: LocationFactDoc[] | undefined) =>
      new Set((list || []).map((f) => f.text.toLowerCase()))

    const mkEntries = (texts: string[], existing: Set<string>): LocationFactDoc[] => {
      const out: LocationFactDoc[] = []
      for (const text of texts) {
        const key = text.toLowerCase()
        if (existing.has(key)) continue
        existing.add(key)
        out.push({ text, source_event_id: params.eventId, source_sequence: params.sequence, created_at: now })
      }
      return out
    }

    const newState = mkEntries(state, seen(entity.location_state))
    const newFacts = mkEntries(facts, seen(entity.location_facts))
    if (!newState.length && !newFacts.length) return

    const nextState = [...(entity.location_state || []), ...newState].slice(-STATE_CAP)
    const nextFacts = [...(entity.location_facts || []), ...newFacts].slice(-FACTS_CAP)
    await entities().updateOne(
      { _id: params.locationEntityId },
      {
        $set: {
          ...(newState.length ? { location_state: nextState } : {}),
          ...(newFacts.length ? { location_facts: nextFacts } : {}),
          updated_at: now,
        },
      },
    )
  },

  /**
   * Pull location state/facts sourced from removed or rewritten turns — used by
   * event edit/replay recuration and rewind so a place never asserts a fact
   * whose source turn no longer happened. Rewind also range-prunes inline.
   */
  async pruneLocationFactsByEvents(instanceId: string, eventIds: ObjectId[]): Promise<void> {
    if (!eventIds.length) return
    const iid = parseObjectId(instanceId)
    await entities().updateMany(
      {
        instance_id: iid,
        type: 'location',
        $or: [
          { 'location_state.source_event_id': { $in: eventIds } },
          { 'location_facts.source_event_id': { $in: eventIds } },
        ],
      },
      {
        $pull: {
          location_state: { source_event_id: { $in: eventIds } },
          location_facts: { source_event_id: { $in: eventIds } },
        },
        $set: { updated_at: new Date() },
      } as never,
    )
  },

  /**
   * Codex cards behind a set of entity ids — used for memory-driven pinning
   * AFTER RAG: when retrieval surfaces memories about a character the prompt
   * wasn't going to include, their structured card gets pinned too. Protagonist
   * cards are excluded (always injected separately).
   */
  async characterCardsForEntities(
    instanceId: string,
    entityIds: string[],
    excludeCardIds: string[],
    limit = 3,
  ): Promise<CharacterProfileDoc[]> {
    if (!entityIds.length || limit <= 0) return []
    const iid = parseObjectId(instanceId)
    const exclude = new Set(excludeCardIds.map(String))
    const linked = (await entities()
      .find(
        {
          instance_id: iid,
          _id: { $in: entityIds.map((id) => parseObjectId(id)) },
          type: { $in: ['character', 'protagonist'] },
          character_id: { $exists: true },
        },
        { projection: { character_id: 1 } },
      )
      .toArray()) as Array<{ character_id?: ObjectId }>
    const cardIds = [
      ...new Map(
        linked
          .map((e) => e.character_id)
          .filter((id): id is ObjectId => !!id && !exclude.has(idString(id)))
          .map((id) => [idString(id), id] as const),
      ).values(),
    ].slice(0, limit)
    if (!cardIds.length) return []
    return (await characters()
      .find({ _id: { $in: cardIds }, is_protagonist: { $ne: true } })
      .toArray()) as CharacterProfileDoc[]
  },

  /**
   * Pull removed events from edge provenance and delete edges with no
   * surviving source — used by event edit/replay recuration and rewind so the
   * graph never asserts something whose source turns no longer happened.
   */
  async removeEventProvenance(instanceId: string, eventIds: ObjectId[]): Promise<number> {
    if (!eventIds.length) return 0
    const iid = parseObjectId(instanceId)
    // Only edges that actually carried a removed event may be deleted on empty
    // provenance — meter edges re-projected during repair legitimately start
    // with [] and must survive.
    const affected = (await entityEdges()
      .find({ instance_id: iid, source_event_ids: { $in: eventIds } }, { projection: { _id: 1 } })
      .toArray()) as Array<{ _id: ObjectId }>
    if (affected.length === 0) return 0
    const affectedIds = affected.map((e) => e._id)
    await entityEdges().updateMany(
      { _id: { $in: affectedIds } },
      { $pull: { source_event_ids: { $in: eventIds } }, $set: { updated_at: new Date() } } as never,
    )
    const res = await entityEdges().deleteMany({
      _id: { $in: affectedIds },
      source_event_ids: { $size: 0 },
    })
    return res.deletedCount || 0
  },

  /**
   * Delete entities (from `candidateIds`) that nothing references anymore —
   * used after event edit/replay recuration, where the edited-out content may
   * have been an entity's ONLY mention (entities carry no event provenance;
   * rewind covers this case via first_seen_sequence, edits need this check).
   * Codex-governed entities (live card, player/protagonist) are never pruned
   * here; the codex decides their lifecycle.
   */
  async pruneOrphanEntities(instanceId: string, candidateIds: ObjectId[]): Promise<number> {
    if (!candidateIds.length) return 0
    const iid = parseObjectId(instanceId)
    const candidates = (await entities()
      .find({ _id: { $in: candidateIds }, instance_id: iid })
      .toArray()) as EntityDoc[]
    let deleted = 0
    for (const e of candidates) {
      if (e.type === 'player' || e.type === 'protagonist') continue
      if (e.character_id) {
        const card = await characters().findOne({ _id: e.character_id }, { projection: { _id: 1 } })
        if (card) continue
      }
      const memRef = await mongoColl.memories().findOne(
        {
          instance_id: iid,
          $or: [{ subject_entity_ids: e._id }, { object_entity_ids: e._id }],
        },
        { projection: { _id: 1 } },
      )
      if (memRef) continue
      const edgeRef = await entityEdges().findOne(
        {
          instance_id: iid,
          $or: [{ source_entity_id: e._id }, { target_entity_id: e._id }],
        },
        { projection: { _id: 1 } },
      )
      if (edgeRef) continue
      await entities().deleteOne({ _id: e._id })
      deleted++
    }
    return deleted
  },

  /**
   * Graph repair after a rewind (inline in rewindToSequence, after the codex
   * rebuild): entities born in removed turns are deleted, survivors' last_seen
   * clamps to the surviving range, edge provenance from removed events is
   * pruned, character entities re-link to the freshly re-minted codex cards,
   * and meter edges re-project from the rebuilt relationship ledger.
   */
  async repairAfterRewind(params: {
    instanceId: string
    playerId: string
    sequence: number
    doomedEventIds: ObjectId[]
    lastSurvivingEventId?: ObjectId | null
  }): Promise<{ deletedEntities: number; deletedEdges: number }> {
    const { instanceId, playerId, sequence, doomedEventIds, lastSurvivingEventId } = params
    const iid = parseObjectId(instanceId)

    // 1. Entities first mentioned in removed turns no longer exist; edges
    //    touching them go with them.
    const doomedEntities = (await entities()
      .find({ instance_id: iid, first_seen_sequence: { $gte: sequence } }, { projection: { _id: 1 } })
      .toArray()) as Array<{ _id: ObjectId }>
    let deletedEdges = 0
    if (doomedEntities.length > 0) {
      const ids = doomedEntities.map((e) => e._id)
      const edgeRes = await entityEdges().deleteMany({
        instance_id: iid,
        $or: [{ source_entity_id: { $in: ids } }, { target_entity_id: { $in: ids } }],
      })
      deletedEdges += edgeRes.deletedCount || 0
      await entities().deleteMany({ _id: { $in: ids } })
    }
    await entities().updateMany(
      { instance_id: iid, last_seen_sequence: { $gte: sequence } },
      { $set: { last_seen_sequence: Math.max(0, sequence - 1), updated_at: new Date() } },
    )

    // 1b. Location state/facts sourced from removed turns are pulled (cheap
    //     range prune by source_sequence — survivors keep their pre-rewind canon).
    await entities().updateMany(
      {
        instance_id: iid,
        type: 'location',
        $or: [
          { 'location_state.source_sequence': { $gte: sequence } },
          { 'location_facts.source_sequence': { $gte: sequence } },
        ],
      },
      {
        $pull: {
          location_state: { source_sequence: { $gte: sequence } },
          location_facts: { source_sequence: { $gte: sequence } },
        },
        $set: { updated_at: new Date() },
      } as never,
    )

    // 2. Edge provenance from removed events.
    deletedEdges += await this.removeEventProvenance(instanceId, doomedEventIds)

    // 3. Re-link character entities to the rebuilt cards (rewind re-mints card
    //    _ids) and re-project meter edges from the rebuilt ledger.
    const cards = (await characters().find({ instance_id: iid }).toArray()) as CharacterProfileDoc[]
    if (cards.length > 0) {
      const entityMap = await this.syncCodexEntities({
        instanceId,
        playerId,
        sequence: Math.max(0, sequence - 1),
        cards,
      })
      await this.syncRelationshipEdges({
        instanceId,
        playerId,
        sequence: Math.max(0, sequence - 1),
        eventId: lastSurvivingEventId ?? null,
        cards,
        entitiesByCardName: entityMap,
      })
    }

    return { deletedEntities: doomedEntities.length, deletedEdges }
  },
}
