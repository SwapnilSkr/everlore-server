import { ObjectId } from 'mongodb'
import { mongoColl } from '../config/mongo'
import type { EntityDoc, EntityType, LocationFactDoc } from '../models/entity.model'
import type { CharacterProfileDoc, RelationshipMeters } from '../models/character-profile.model'
import { characterCodexService } from './character-codex.service'
import { idString, parseObjectId } from '../utils/mongo-id'
import { type WorldFactSource, confidenceFor } from '../utils/world-authority'

const entities = () => mongoColl.entities()
const entityEdges = () => mongoColl.entityEdges()
const memories = () => mongoColl.memories()
const characters = () => mongoColl.characters()

/** Same normalization as the codex so the two registries resolve identically. */
export function normalizeEntityName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s'-]+/g, '')
    .replace(/\s+/g, ' ')
}

function normalizeLocationName(name: string): string {
  return normalizeEntityName(name).replace(/^(?:the|a|an)\s+/, '')
}

/** Min token length that participates in indexed mention matching — mirrors the
 *  ≥3-char whole-word rule in findEntitiesMentioned ("Vex" hits, "of"/"an" don't). */
const ENTITY_TOKEN_MIN = 3

/** Normalized lowercase WORD tokens (≥3 chars) of an entity's canonical name +
 *  aliases — the indexed `name_tokens` field used for bounded candidate lookup. */
export function entityNameTokens(canonicalName: string, aliases: string[] = []): string[] {
  const out = new Set<string>()
  for (const raw of [canonicalName, ...aliases]) {
    for (const tok of normalizeEntityName(String(raw || '')).split(' ')) {
      if (tok.length >= ENTITY_TOKEN_MIN) out.add(tok)
    }
  }
  return [...out]
}

/** Candidate tokens FROM the input text. Capitalization is the strongest cue for
 *  a proper noun, but we also keep all ≥3-char normalized words so a lowercased or
 *  mid-sentence name still matches — the indexed query is just a candidate FILTER;
 *  the exact whole-word check downstream preserves matching semantics. */
function inputCandidateTokens(text: string): string[] {
  const out = new Set<string>()
  // Capitalized runs ("Captain Vex") → their individual normalized tokens.
  for (const m of text.match(/\b[A-Z][a-zA-Z'’-]+/g) || []) {
    const n = normalizeEntityName(m)
    if (n.length >= ENTITY_TOKEN_MIN) out.add(n)
  }
  // All normalized words too (covers lowercased mentions + alias words).
  for (const tok of normalizeEntityName(text).split(' ')) {
    if (tok.length >= ENTITY_TOKEN_MIN) out.add(tok)
  }
  return [...out]
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
/** A close runner-up means the short name is ambiguous; never merge on a guess. */
const LOCATION_FUZZY_MIN_MARGIN = 0.2

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
  let runnerUp: { entity: EntityDoc; score: number } | null = null
  for (const entity of candidates) {
    for (const candidateNorm of normalizedLocationNames(entity)) {
      const score = scoreLocationNameMatch(queryNorm, candidateNorm)
      if (score < minScore) continue
      if (!best || score > best.score) {
        if (best && idString(best.entity._id) !== idString(entity._id)) runnerUp = best
        best = { entity, score }
      } else if (idString(best.entity._id) !== idString(entity._id) && (!runnerUp || score > runnerUp.score)) {
        runnerUp = { entity, score }
      }
    }
  }
  if (!best) return null
  // Recency is useful only as a deterministic ordering after identity is known;
  // it must never decide between two semantically plausible places. Abstaining
  // may mint a duplicate that can later be reviewed, whereas merging the wrong
  // locations silently corrupts the map.
  if (runnerUp && best.score - runnerUp.score < LOCATION_FUZZY_MIN_MARGIN) return null
  return best.entity
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
/** The witness-tier statuses — a node that exists for graph reference but has no
 *  codex card yet. All of these promote to 'active' when a card mints, and all
 *  bump provenance on re-witness. */
const STUB_STATUSES = ['stub', 'dormant_stub', 'anchored_stub'] as const
function isStubStatus(s: string | undefined): boolean {
  return s === 'stub' || s === 'dormant_stub' || s === 'anchored_stub'
}
/** Cap on per-entity witness provenance — enough to survive partial rewinds. */
const STUB_SOURCE_EVENTS_MAX = 30


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
      if (mention.type === 'location') {
        if (isVagueLocationLabel(normalized)) continue
        // Route memory-mention places through the SAME canonical resolver the
        // cursor uses (article-stripped + fuzzy + existing-atlas dedup) instead
        // of this naive byName path, which keyed on the article-kept form and so
        // fragmented "the Wildwood" / "Wildwood" / "Wildwood Forest" into 3 nodes
        // (run a–d cluster D). viewpointMoved:true so a SPECIFIC named place still
        // resolves/mints; vague labels are already filtered above.
        const anchor = await this.resolveLocationAnchor({
          instanceId,
          playerId,
          sequence,
          name,
          viewpointMoved: true,
        })
        if (anchor) {
          // Store under the article-kept key the caller looks up by
          // (entityMap.get(normalizeEntityName(name))). resolveLocationAnchor
          // already bumped mention_count/last_seen, so don't touch it again.
          const prior = byName.get(normalized)
          byName.set(normalized, {
            ...(prior || {}),
            _id: anchor.entity_id,
            instance_id: iid,
            type: 'location',
            canonical_name: anchor.name,
            name_normalized: anchor.name_normalized,
          } as EntityDoc)
        }
        continue
      }

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
        name_tokens: entityNameTokens(name.slice(0, 120)),
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
          name_tokens: entityNameTokens(card.canonical_name, uniqNames(card.aliases || [])),
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
        // (rewind rebuilds cards with fresh ids), protagonist promotion, and
        // STUB → ACTIVE promotion: a scene-participant / kinship stub entity
        // (status 'stub', no character_id) is upgraded to a full canonical
        // entity the moment a codex card mints for this name. The unique index
        // made the stub and the card-name match, so this is the same row.
        const mergedAliases = uniqNames([...(entity.aliases || []), ...(card.aliases || [])])
        const dirty =
          !entity.character_id?.equals(card._id) ||
          entity.canonical_name !== card.canonical_name ||
          entity.type !== wantType ||
          entity.status !== 'active' ||
          mergedAliases.length !== (entity.aliases || []).length ||
          (entity.last_seen_sequence || 0) < (card.last_seen_sequence || 0)
        if (dirty) {
          entity.character_id = card._id
          entity.canonical_name = card.canonical_name
          entity.name_normalized = card.name_normalized
          entity.type = wantType
          entity.status = 'active'
          entity.aliases = mergedAliases
          entity.name_tokens = entityNameTokens(card.canonical_name, mergedAliases)
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

  /**
   * Rewire graph and memory references after a player-confirmed duplicate
   * character merge. The caller has already chosen the surviving card/entity;
   * this method never guesses identity. Conflicting edges are folded by their
   * natural unique key before the obsolete entity is removed.
   */
  async mergeCharacterEntities(params: {
    instanceId: string
    playerId: string
    sourceEntityId: string
    targetEntityId: string
    targetCard: CharacterProfileDoc
  }): Promise<void> {
    const iid = parseObjectId(params.instanceId)
    const sourceId = parseObjectId(params.sourceEntityId)
    const targetId = parseObjectId(params.targetEntityId)
    if (sourceId.equals(targetId)) return
    const [source, target] = await Promise.all([
      entities().findOne({ _id: sourceId, instance_id: iid, player_id: parseObjectId(params.playerId) }),
      entities().findOne({ _id: targetId, instance_id: iid, player_id: parseObjectId(params.playerId) }),
    ])
    if (!source || !target) throw new Error('Identity merge entity no longer exists')
    const now = new Date()

    const impacted = await entityEdges().find({
      instance_id: iid,
      $or: [{ source_entity_id: sourceId }, { target_entity_id: sourceId }],
    }).toArray()
    for (const edge of impacted) {
      const nextSource = edge.source_entity_id.equals(sourceId) ? targetId : edge.source_entity_id
      const nextTarget = edge.target_entity_id.equals(sourceId) ? targetId : edge.target_entity_id
      // A duplicate's internal edge becomes a self-edge after coalescing and
      // carries no relationship between two distinct entities any more.
      if (nextSource.equals(nextTarget)) {
        await entityEdges().deleteOne({ _id: edge._id })
        continue
      }
      const duplicate = await entityEdges().findOne({
        instance_id: iid,
        source_entity_id: nextSource,
        target_entity_id: nextTarget,
        type: edge.type,
        label: edge.label ?? null,
        _id: { $ne: edge._id },
      })
      if (duplicate) {
        await entityEdges().updateOne(
          { _id: duplicate._id },
          {
            $set: {
              importance: Math.max(duplicate.importance || 1, edge.importance || 1),
              last_event_sequence: Math.max(duplicate.last_event_sequence || 0, edge.last_event_sequence || 0),
              updated_at: now,
            },
            $addToSet: { source_event_ids: { $each: edge.source_event_ids || [] } },
          } as never,
        )
        await entityEdges().deleteOne({ _id: edge._id })
      } else {
        await entityEdges().updateOne(
          { _id: edge._id },
          { $set: { source_entity_id: nextSource, target_entity_id: nextTarget, updated_at: now } },
        )
      }
    }

    // Preserve retrieval and knowledge scope. $setUnion removes a source/target
    // double-reference if a memory happened to mention both duplicate labels.
    const replaceArray = (field: string) => ({
      $setUnion: [{
        $map: {
          input: { $ifNull: [`$${field}`, []] },
          as: 'entityId',
          in: { $cond: [{ $eq: ['$$entityId', sourceId] }, targetId, '$$entityId'] },
        },
      }, []],
    })
    await memories().updateMany(
      { instance_id: iid, $or: [
        { subject_entity_ids: sourceId }, { object_entity_ids: sourceId }, { known_by_entity_ids: sourceId },
      ] },
      [{ $set: {
        subject_entity_ids: replaceArray('subject_entity_ids'),
        object_entity_ids: replaceArray('object_entity_ids'),
        known_by_entity_ids: replaceArray('known_by_entity_ids'),
        updated_at: now,
      } }] as never,
    )
    await mongoColl.events().updateMany(
      { instance_id: iid, 'side_chat.character_entity_id': sourceId },
      { $set: { 'side_chat.character_entity_id': targetId } },
    )
    await mongoColl.events().updateMany(
      { instance_id: iid, 'side_chat.participants': sourceId },
      [{ $set: { 'side_chat.participants': replaceArray('side_chat.participants') } }] as never,
    )
    await mongoColl.relationCandidates().updateMany(
      { instance_id: iid, character_entity_id: sourceId, status: 'open' },
      { $set: { character_entity_id: targetId, character_name: params.targetCard.canonical_name, updated_at: now } },
    )
    await entities().updateOne(
      { _id: targetId },
      {
        $set: {
          canonical_name: params.targetCard.canonical_name,
          name_normalized: params.targetCard.name_normalized,
          aliases: uniqNames([
            ...(target.aliases || []), target.canonical_name,
            ...(source.aliases || []), source.canonical_name,
            ...(params.targetCard.aliases || []),
          ]).filter((name) => normalizeEntityName(name) !== params.targetCard.name_normalized),
          name_tokens: entityNameTokens(params.targetCard.canonical_name, params.targetCard.aliases || []),
          character_id: params.targetCard._id,
          updated_at: now,
        },
      },
    )
    await entities().deleteOne({ _id: sourceId })
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
      name_tokens: entityNameTokens(trimmed.slice(0, 120), ['player', 'the player']),
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
   * Ensure a STUB entity exists for a witnessed-but-uncarded person name. This
   * is the WITNESS → ENTITY-STUB tier of the world model: a scene participant or
   * a kinship endpoint that has no codex card yet gets a lightweight graph node
   * (status 'stub', no character_id) so the graph — kinship edges, choice
   * grounding, presence, memory links — can reference it by id BEFORE a full
   * card exists. Stubs are high-recall/low-authority: they are NOT injected as
   * codex canon and NOT shown in the Bonds ledger (that reads cards). The moment
   * a codex card mints for this name, {@link syncCodexEntities} promotes the
   * stub to 'active' and links character_id — the same row, never a duplicate.
   *
   * Idempotent + race-safe: the (instance, type, world_root_id, parent_id, name)
   * unique index means a concurrent real character entity for the same name wins
   * the insert and is returned here (so a stub is never minted beside a card).
   * Returns the entity id (stub OR an existing real one) so callers can write
   * edges against it; null only on a transient failure.
   */
  async ensureStubEntity(params: {
    instanceId: string
    playerId: string
    sequence: number
    name: string
    /** A coarse role/descriptor for an unnamed witness ("the butler"). */
    roleLabel?: string
    /** 0-1 confidence this is a real trackable person (from the presence tier). */
    confidence?: number
    /** The event that witnessed this stub — kept as wakeable provenance. */
    sourceEventId?: ObjectId
    /** The place this stub was witnessed in — wakes the stub on return there. */
    locationEntityId?: ObjectId | null
  }): Promise<string | null> {
    const { instanceId, playerId, sequence, name, roleLabel, confidence, sourceEventId, locationEntityId } = params
    const trimmed = (name || '').trim().slice(0, 120)
    if (!trimmed) return null
    const iid = parseObjectId(instanceId)
    const pid = parseObjectId(playerId)
    const normalized = normalizeEntityName(trimmed)
    if (!normalized) return null

    // An existing character/protagonist entity (stub or active) for this name
    // already satisfies the call — return it rather than mint a duplicate.
    const existing = await entities().findOne({
      instance_id: iid,
      type: { $in: ['character', 'protagonist'] },
      name_normalized: normalized,
    })
    if (existing) {
      if (isStubStatus(existing.status) || existing.status === 'archived') {
        // Re-witnessing bumps provenance and WAKES a dormant/archived stub back to
        // active witnessing (it earned a fresh sighting). An anchored stub stays
        // anchored; an active (carded) entity is left to syncCodexEntities.
        const set: Record<string, unknown> = { updated_at: new Date() }
        if (existing.status === 'dormant_stub' || existing.status === 'archived') {
          set.status = 'anchored_stub'
          set.last_wake_reason = 're-witnessed'
        }
        if (locationEntityId) set.last_location_entity_id = locationEntityId
        if (roleLabel && !existing.role_label) set.role_label = roleLabel.slice(0, 80)
        if (typeof confidence === 'number') set.confidence = Math.max(existing.confidence ?? 0, confidence)
        await entities().updateOne(
          { _id: existing._id },
          {
            $inc: { mention_count: 1, witness_count: 1 },
            $max: { last_seen_sequence: sequence },
            $set: set,
            ...(sourceEventId
              ? { $push: { source_event_ids: { $each: [sourceEventId], $slice: -STUB_SOURCE_EVENTS_MAX } } }
              : {}),
          } as never,
        )
      }
      return idString(existing._id)
    }

    const now = new Date()
    const doc: EntityDoc = {
      _id: new ObjectId(),
      instance_id: iid,
      player_id: pid,
      type: 'character',
      canonical_name: trimmed,
      name_normalized: normalized,
      aliases: [],
      name_tokens: entityNameTokens(trimmed),
      status: 'stub',
      first_seen_sequence: sequence,
      last_seen_sequence: sequence,
      mention_count: 1,
      witness_count: 1,
      ...(roleLabel ? { role_label: roleLabel.slice(0, 80) } : {}),
      ...(typeof confidence === 'number' ? { confidence } : {}),
      ...(sourceEventId ? { source_event_ids: [sourceEventId] } : {}),
      ...(locationEntityId ? { first_location_entity_id: locationEntityId, last_location_entity_id: locationEntityId } : {}),
      created_at: now,
      updated_at: now,
    }
    try {
      await entities().insertOne(doc)
      return idString(doc._id)
    } catch {
      // Unique-index race with a concurrent stub/card for the same name: the
      // winner is the canonical row — return it so the caller still gets a id.
      const winner = await entities().findOne({
        instance_id: iid,
        type: { $in: ['character', 'protagonist'] },
        name_normalized: normalized,
      })
      return winner ? idString(winner._id) : null
    }
  },

  /**
   * CANON BRIEF (positions, WRITE) — record where the present cast is THIS turn.
   * Every character entity matching a present name (carded OR stub) gets its
   * `last_location_entity_id` + `last_location_sequence` set to the current place.
   * One bulk update, deterministic, off TTFT. This is what makes "where is X" /
   * "go find X" answerable — presence is "who is here now", this is "where everyone
   * was last seen". Best-effort: never throws into the turn pipeline.
   */
  async recordCharacterLocations(params: {
    instanceId: string
    names: string[]
    locationEntityId: string | null
    sequence: number
  }): Promise<number> {
    const { instanceId, names, locationEntityId, sequence } = params
    if (!locationEntityId || !names?.length) return 0
    const normalized = [...new Set(names.map((n) => normalizeEntityName(n)).filter(Boolean))]
    if (!normalized.length) return 0
    try {
      const res = await entities().updateMany(
        {
          instance_id: parseObjectId(instanceId),
          type: { $in: ['character', 'protagonist'] },
          name_normalized: { $in: normalized },
        },
        {
          $set: {
            last_location_entity_id: parseObjectId(locationEntityId),
            last_location_sequence: sequence,
            updated_at: new Date(),
          },
        } as never,
      )
      return res.modifiedCount || 0
    } catch {
      return 0
    }
  },

  /**
   * The containment chain of a location entity, immediate-parent first, bounded.
   * `[{ name: "Marcus's penthouse" }, { name: "Downtown" }]`. Used by the Canon
   * Brief to give the narrator owner-scoped, ancestry-aware place identity so it
   * never confuses two same-named places. Walks the `parent_id` spine (P1 graph).
   */
  async placeAncestry(instanceId: string, entityId: string, max = 5): Promise<string[]> {
    const iid = parseObjectId(instanceId)
    const out: string[] = []
    const seen = new Set<string>()
    let cursor: ObjectId | null = null
    try {
      let node = (await entities().findOne(
        { _id: parseObjectId(entityId), instance_id: iid, type: 'location' },
        { projection: { canonical_name: 1, parent_id: 1 } },
      )) as { canonical_name?: string; parent_id?: ObjectId | null } | null
      // Skip the node itself (the caller already has the current place name); walk up.
      cursor = node?.parent_id ?? null
      while (cursor && out.length < max) {
        const key = idString(cursor)
        if (seen.has(key)) break
        seen.add(key)
        node = (await entities().findOne(
          { _id: cursor, instance_id: iid, type: 'location' },
          { projection: { canonical_name: 1, parent_id: 1 } },
        )) as { canonical_name?: string; parent_id?: ObjectId | null } | null
        if (!node?.canonical_name) break
        out.push(node.canonical_name)
        cursor = node.parent_id ?? null
      }
    } catch {
      /* best-effort */
    }
    return out
  },

  /**
   * CANON BRIEF (positions, READ) — where the given characters were last seen, for
   * those NOT at `currentLocationId` (i.e. elsewhere). Returns compact rows the
   * brief renders as "Mara was last seen in the Ash Tavern". Bounded; one query.
   */
  async characterPositions(params: {
    instanceId: string
    entityIds: string[]
    currentLocationId: string | null
    limit?: number
  }): Promise<Array<{ name: string; place: string; sequence: number }>> {
    const { instanceId, entityIds, currentLocationId, limit = 6 } = params
    const ids = [...new Set((entityIds || []).filter(Boolean))]
    if (!ids.length) return []
    const iid = parseObjectId(instanceId)
    const rows = (await entities()
      .find(
        {
          instance_id: iid,
          _id: { $in: ids.map(parseObjectId) },
          type: { $in: ['character', 'protagonist'] },
          last_location_entity_id: { $ne: null },
        },
        { projection: { canonical_name: 1, last_location_entity_id: 1, last_location_sequence: 1 } },
      )
      .toArray()) as Array<{ canonical_name?: string; last_location_entity_id?: ObjectId | null; last_location_sequence?: number }>
    const elsewhere = rows.filter(
      (r) => r.last_location_entity_id && (!currentLocationId || idString(r.last_location_entity_id) !== currentLocationId),
    )
    if (!elsewhere.length) return []
    const placeIds = [...new Set(elsewhere.map((r) => idString(r.last_location_entity_id!)))]
    const places = (await entities()
      .find({ _id: { $in: placeIds.map(parseObjectId) }, instance_id: iid }, { projection: { canonical_name: 1 } })
      .toArray()) as Array<{ _id: ObjectId; canonical_name?: string }>
    const placeName = new Map(places.map((p) => [idString(p._id), p.canonical_name || '']))
    const out: Array<{ name: string; place: string; sequence: number }> = []
    for (const r of elsewhere) {
      const place = placeName.get(idString(r.last_location_entity_id!)) || ''
      if (!r.canonical_name || !place) continue
      out.push({ name: r.canonical_name, place, sequence: r.last_location_sequence || 0 })
    }
    // Most-recently-seen first; cap.
    out.sort((a, b) => b.sequence - a.sequence)
    return out.slice(0, limit)
  },

  /**
   * Promote the scene's witnessed-but-uncarded participants to stub entities
   * (the WITNESS → ENTITY-STUB tier). For every name in `presentNames` that is
   * NOT already a known codex card, ensure a stub entity exists with this turn's
   * provenance. `knownCardNames` is the set of normalized canonical+alias names
   * that already have a card, so we don't wastefully stub a name that's already
   * canon (the unique index would just return the real row anyway). Returns the
   * set of normalized names a stub was ensured for this turn (for logging /
   * audits). Best-effort: failures never break the turn pipeline.
   */
  async ensureSceneParticipantStubs(params: {
    instanceId: string
    playerId: string
    sequence: number
    presentNames: string[]
    knownCardNames: Set<string>
    /** The event witnessing these participants — kept as wakeable provenance. */
    sourceEventId?: ObjectId
    /** The place they were witnessed in — wakes the stub on return there. */
    locationEntityId?: ObjectId | null
    /** Per-name confidence (from the presence tier: confirmed=0.9, probable=0.6),
     *  keyed by NORMALIZED name. Low-confidence one-offs archive first. */
    confidenceByName?: Map<string, number>
  }): Promise<{ ensured: string[]; promoted: string[] }> {
    const { instanceId, playerId, sequence, presentNames, knownCardNames, sourceEventId, locationEntityId, confidenceByName } = params
    const ensured: string[] = []
    const promoted: string[] = []
    for (const raw of presentNames || []) {
      const normalized = normalizeEntityName(raw)
      if (!normalized || knownCardNames.has(normalized)) continue
      const id = await this.ensureStubEntity({
        instanceId,
        playerId,
        sequence,
        name: raw,
        sourceEventId,
        locationEntityId,
        confidence: confidenceByName?.get(normalized),
      })
      if (id) ensured.push(normalized)
    }
    return { ensured, promoted }
  },

  /**
   * Reconcile the witness-tier lifecycle for stubs that have fallen out of the
   * active window. Instead of the old binary stub→archived, each stale stub is
   * routed by PROVENANCE so a long-dormant uncarded character survives at turn 30k
   * without bloating context:
   *  - has a live kinship/relationship edge, a memory reference, or repeated
   *    witnessing → 'anchored_stub' (kept indefinitely, wakeable).
   *  - has SOME provenance (a source event, a role, a location, was once witnessed
   *    more than once) but is cold → 'dormant_stub' (preserved, woken by a cue).
   *  - unreferenced, low-confidence, single-witness noise → 'archived'.
   * Idempotent; bounded; best-effort. (Kept the name `archiveStaleStubs` for the
   * caller; it now does the full reconciliation.)
   */
  async archiveStaleStubs(params: {
    instanceId: string
    sequence: number
    maxAge?: number
  }): Promise<{ archived: number; anchored: number; dormant: number }> {
    const { instanceId, sequence, maxAge = 120 } = params
    const iid = parseObjectId(instanceId)
    const cutoff = Math.max(0, sequence - maxAge)
    const candidates = (await entities()
      .find(
        {
          instance_id: iid,
          type: 'character',
          status: { $in: ['stub', 'dormant_stub', 'anchored_stub'] },
          character_id: { $exists: false },
          last_seen_sequence: { $lt: cutoff },
        },
        { projection: { _id: 1, status: 1, confidence: 1, witness_count: 1, mention_count: 1, role_label: 1, source_event_ids: 1, last_location_entity_id: 1 } },
      )
      .limit(300)
      .toArray()) as Pick<EntityDoc, '_id' | 'status' | 'confidence' | 'witness_count' | 'mention_count' | 'role_label' | 'source_event_ids' | 'last_location_entity_id'>[]
    if (!candidates.length) return { archived: 0, anchored: 0, dormant: 0 }

    const ids = candidates.map((c) => c._id)
    // Anchor signal 1: a live graph edge (kinship/relationship) points at the stub.
    const activeEdges = await entityEdges()
      .find(
        {
          instance_id: iid,
          status: 'active',
          $or: [{ source_entity_id: { $in: ids } }, { target_entity_id: { $in: ids } }],
        },
        { projection: { source_entity_id: 1, target_entity_id: 1 } },
      )
      .toArray()
    const edged = new Set<string>()
    for (const edge of activeEdges) {
      if (edge.source_entity_id) edged.add(idString(edge.source_entity_id))
      if (edge.target_entity_id) edged.add(idString(edge.target_entity_id))
    }
    // Anchor signal 2: a memory references the stub (subject/object/known_by/place).
    const memEntityFilter = { $in: ids }
    const memRefs = await memories()
      .find(
        {
          instance_id: iid,
          $or: [
            { subject_entity_ids: memEntityFilter },
            { object_entity_ids: memEntityFilter },
          ],
        },
        { projection: { subject_entity_ids: 1, object_entity_ids: 1 } },
      )
      .toArray()
    const memoried = new Set<string>()
    for (const m of memRefs) {
      for (const id of [...(m.subject_entity_ids || []), ...(m.object_entity_ids || [])]) {
        memoried.add(idString(id))
      }
    }

    const toAnchor: ObjectId[] = []
    const toDormant: ObjectId[] = []
    const toArchive: ObjectId[] = []
    for (const c of candidates) {
      const id = idString(c._id)
      const witnessed = (c.witness_count ?? c.mention_count ?? 1)
      const hasAnchor = edged.has(id) || memoried.has(id) || witnessed >= 3
      const hasProvenance =
        witnessed >= 2 || !!c.role_label || (c.source_event_ids?.length ?? 0) > 0 || !!c.last_location_entity_id
      const lowConfidence = (c.confidence ?? 0) < 0.6
      if (hasAnchor) {
        if (c.status !== 'anchored_stub') toAnchor.push(c._id)
      } else if (hasProvenance && !lowConfidence) {
        if (c.status !== 'dormant_stub') toDormant.push(c._id)
      } else if (witnessed <= 1 && lowConfidence) {
        toArchive.push(c._id)
      } else if (c.status !== 'dormant_stub') {
        toDormant.push(c._id)
      }
    }

    const now = new Date()
    if (toAnchor.length) {
      await entities().updateMany(
        { instance_id: iid, _id: { $in: toAnchor } },
        { $set: { status: 'anchored_stub', updated_at: now } },
      )
    }
    if (toDormant.length) {
      await entities().updateMany(
        { instance_id: iid, _id: { $in: toDormant } },
        { $set: { status: 'dormant_stub', updated_at: now } },
      )
    }
    let archived = 0
    if (toArchive.length) {
      const res = await entities().updateMany(
        { instance_id: iid, _id: { $in: toArchive }, character_id: { $exists: false } },
        { $set: { status: 'archived', updated_at: now } },
      )
      archived = res.modifiedCount || 0
    }
    return { archived, anchored: toAnchor.length, dormant: toDormant.length }
  },

  /**
   * Wake dormant/anchored stubs that match a turn's CUES, so a long-uncarded
   * character resurfaces exactly when relevant rather than being injected wholesale.
   * Cues: an explicit name/alias in the player input, a kinship/relationship edge
   * to a present entity, or the current location. Marks `last_wake_reason` and
   * returns the woken entity ids (for the RAG entity neighbourhood / context). Read
   * + a light status flip; safe to call on the live path (bounded, indexed).
   */
  async wakeStubsByCues(params: {
    instanceId: string
    names?: string[]
    presentEntityIds?: string[]
    locationEntityId?: string | null
    limit?: number
  }): Promise<{ entityIds: string[]; reasons: Record<string, string> }> {
    const { instanceId, names = [], presentEntityIds = [], locationEntityId, limit = 12 } = params
    const iid = parseObjectId(instanceId)
    const woken = new Map<string, string>() // id → reason

    const dormantFilter = {
      instance_id: iid,
      type: 'character' as const,
      status: { $in: ['dormant_stub', 'anchored_stub'] as EntityDoc['status'][] },
      character_id: { $exists: false },
    }

    // Cue 1: named in the input (by canonical name or alias, normalized).
    const normNames = names.map((n) => normalizeEntityName(n)).filter(Boolean)
    if (normNames.length) {
      const byName = (await entities()
        .find({ ...dormantFilter, $or: [{ name_normalized: { $in: normNames } }, { aliases: { $in: normNames } }] }, { projection: { _id: 1 } })
        .limit(limit)
        .toArray()) as Pick<EntityDoc, '_id'>[]
      for (const e of byName) woken.set(idString(e._id), 'named in input')
    }
    // Cue 2: a kinship/relationship edge ties a dormant stub to a present entity.
    if (presentEntityIds.length && woken.size < limit) {
      const presentOids = presentEntityIds.map((id) => parseObjectId(id))
      const edges = await entityEdges()
        .find(
          { instance_id: iid, status: 'active', $or: [{ source_entity_id: { $in: presentOids } }, { target_entity_id: { $in: presentOids } }] },
          { projection: { source_entity_id: 1, target_entity_id: 1 } },
        )
        .toArray()
      const neighborIds = new Set<string>()
      const presentSet = new Set(presentEntityIds)
      for (const e of edges) {
        for (const side of [e.source_entity_id, e.target_entity_id]) {
          const s = side ? idString(side) : ''
          if (s && !presentSet.has(s)) neighborIds.add(s)
        }
      }
      if (neighborIds.size) {
        const neighbors = (await entities()
          .find({ ...dormantFilter, _id: { $in: [...neighborIds].map((id) => parseObjectId(id)) } }, { projection: { _id: 1 } })
          .limit(limit)
          .toArray()) as Pick<EntityDoc, '_id'>[]
        for (const e of neighbors) if (!woken.has(idString(e._id))) woken.set(idString(e._id), 'kin/relationship edge')
      }
    }
    // Cue 3: the current location is where this stub was last witnessed.
    if (locationEntityId && woken.size < limit) {
      const here = (await entities()
        .find({ ...dormantFilter, last_location_entity_id: parseObjectId(locationEntityId) }, { projection: { _id: 1 } })
        .limit(limit)
        .toArray()) as Pick<EntityDoc, '_id'>[]
      for (const e of here) if (!woken.has(idString(e._id))) woken.set(idString(e._id), 'same place')
    }

    if (woken.size) {
      const now = new Date()
      // Flip dormant → anchored (it just proved relevant) + record why.
      await Promise.all(
        [...woken.entries()].map(([id, reason]) =>
          entities().updateOne(
            { _id: parseObjectId(id) },
            { $set: { status: 'anchored_stub', last_wake_reason: reason, updated_at: now } },
          ),
        ),
      )
    }
    return { entityIds: [...woken.keys()], reasons: Object.fromEntries(woken) }
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

  entityNameTokens,

  /**
   * Entities DIRECTLY NAMED in `text` — the registry-backed generalization of
   * the codex-only mention scan. Whole-word match on normalized names/aliases
   * (≥3 chars) so "Vex" hits but "vexed" doesn't.
   *
   * SCALABILITY: instead of loading the WHOLE non-archived registry (O(registry);
   * dominated by dormant stubs over a long game), we first extract the candidate
   * name tokens from the input text, then query only the entities whose indexed
   * `name_tokens` share one of those tokens — a bounded candidate set. The exact
   * whole-word match is then applied in-process over just those candidates, so
   * the RESULTS are identical to the old full scan; only the rows examined shrink.
   * Legacy rows without `name_tokens` are healed by a one-time per-instance
   * backfill the first time this runs for an instance.
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

    const tokens = inputCandidateTokens(clean)
    if (!tokens.length) return []

    const baseFilter: Record<string, unknown> = { instance_id: iid, status: { $ne: 'archived' } }
    if (opts.types?.length) baseFilter.type = { $in: opts.types }

    const projection = { canonical_name: 1, name_normalized: 1, aliases: 1, type: 1, character_id: 1, name_tokens: 1 }
    const fetchCandidates = () =>
      entities()
        .find({ ...baseFilter, name_tokens: { $in: tokens } }, { projection })
        // Cap the candidate fan-out: a common token still bounds the scan, and the
        // exact match below is cheap. Generous vs. the small `limit` of true hits.
        .limit(Math.max(limit * 25, 100))
        .toArray() as Promise<EntityDoc[]>

    let candidates = await fetchCandidates()

    // Self-heal: if NOTHING matched the token index but the instance has entities,
    // legacy rows may predate `name_tokens` — backfill once, then retry the query.
    if (candidates.length === 0) {
      const hasUntokenized = await entities().countDocuments(
        { instance_id: iid, name_tokens: { $exists: false } },
        { limit: 1 },
      )
      if (hasUntokenized > 0) {
        await this.backfillEntityTokens(instanceId)
        candidates = await fetchCandidates()
      }
    }
    if (candidates.length === 0) return []

    const haystack = ` ${normalizeEntityName(clean)} `
    const matched: EntityDoc[] = []
    for (const e of candidates) {
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
   * One-time backfill of the indexed `name_tokens` field for an instance's
   * entities (legacy rows that predate the field). Idempotent; bounded by the
   * instance's entity count; safe to run live. Only writes rows whose tokens
   * actually changed.
   */
  async backfillEntityTokens(instanceId: string): Promise<{ updated: number }> {
    const iid = parseObjectId(instanceId)
    const rows = (await entities()
      .find({ instance_id: iid }, { projection: { canonical_name: 1, aliases: 1, name_tokens: 1 } })
      .toArray()) as EntityDoc[]
    const ops = rows
      .map((e) => {
        const tokens = entityNameTokens(e.canonical_name, e.aliases || [])
        const current = e.name_tokens || []
        const same = current.length === tokens.length && tokens.every((t) => current.includes(t))
        if (same) return null
        return {
          updateOne: {
            filter: { _id: e._id },
            update: { $set: { name_tokens: tokens } },
          },
        }
      })
      .filter(Boolean) as Array<{ updateOne: { filter: unknown; update: unknown } }>
    if (ops.length) await entities().bulkWrite(ops as never, { ordered: false })
    return { updated: ops.length }
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
    const normalized = normalizeLocationName(name)
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
      name_tokens: entityNameTokens(name),
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
    const normalized = normalizeLocationName(name)
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

    // World shift: mint/reuse a world-root for the realm, hang the place under it.
    if (movement === 'world_shift') {
      const realmName = (params.containmentHint && !isVagueLocationLabel(params.containmentHint))
        ? params.containmentHint.replace(/\s+/g, ' ').trim().slice(0, 120)
        : name
      const realmNorm = normalizeLocationName(realmName)
      if (!realmNorm || realmNorm.length < 3) return null
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
      if (!normalized || realmNorm === normalized) {
        return { entity_id: root._id, name: root.canonical_name, name_normalized: root.name_normalized }
      }
      return this.resolveLocationAnchor({
        instanceId: params.instanceId, playerId: params.playerId, sequence: params.sequence,
        name, viewpointMoved: true, scope: { rootId: root._id },
        create: { parentId: root._id, worldRootId: root._id },
      })
    }

    if (!normalized || normalized.length < 3) return null
    // Vague labels never mint real places. On an unmoved turn they mean "stay
    // put"; on an outward move, resolve to the known container when there is one
    // ("outside" from a room → the building/area), otherwise keep the cursor.
    if (isVagueLocationLabel(normalized)) {
      if (moved && movement === 'out' && cursor?.parent_id) {
        const parent = (await entities().findOne({
          _id: cursor.parent_id,
          instance_id: iid,
          type: 'location',
          status: { $ne: 'archived' },
        })) as EntityDoc | null
        if (parent) {
          await entities().updateOne(
            { _id: parent._id },
            {
              $inc: { mention_count: 1 },
              $max: { last_seen_sequence: params.sequence },
              $set: { updated_at: new Date() },
            },
          )
          return {
            entity_id: parent._id,
            name: parent.canonical_name,
            name_normalized: parent.name_normalized,
          }
        }
      }
      return null
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
        { instance_id: iid, type: 'location', status: { $ne: 'archived' } },
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
    /** Authority of these place-facts (narrator by default; a player narration of
     *  a place change outranks it). Stamped on each persisted entry. */
    source?: WorldFactSource
    confidence?: number
  }): Promise<void> {
    const state = (params.state || []).map((s) => s.trim()).filter(Boolean)
    const facts = (params.facts || []).map((s) => s.trim()).filter(Boolean)
    if (!state.length && !facts.length) return
    const source: WorldFactSource = params.source ?? 'narrator'
    const confidence = typeof params.confidence === 'number' ? params.confidence : confidenceFor(source)
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
        out.push({ text, source_event_id: params.eventId, source_sequence: params.sequence, created_at: now, source, confidence })
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
      // A memory that SURVIVES the rewind (its source turn predates the cut) may
      // still reference one of these now-deleted entities in its subject/object
      // refs — the entity was first seen in a removed turn but named earlier.
      // Pull the dangling ids so continuity-audit's memory_entity_refs check
      // stays clean (cluster N1: orphan memory → missing entity after rewind).
      await mongoColl.memories().updateMany(
        { instance_id: iid, $or: [{ subject_entity_ids: { $in: ids } }, { object_entity_ids: { $in: ids } }] },
        { $pull: { subject_entity_ids: { $in: ids }, object_entity_ids: { $in: ids } } } as never,
      )
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
