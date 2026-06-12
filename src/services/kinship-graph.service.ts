/**
 * Kinship graph service — the WRITE and READ paths for typed relationships.
 * See KINSHIP_GRAPH.md. Edges live in `entity_edges` (type: 'kinship'). Writing
 * happens on the post-stream turn tail (best-effort, never blocks the codex);
 * reading is a cheap indexed query the choice guard / presence consult.
 */
import { ObjectId } from 'mongodb'
import { mongoColl } from '../config/mongo'
import { parseObjectId, idString } from '../utils/mongo-id'
import { normalizeEntityName } from './entity-graph.service'
import type { CharacterProfileDoc } from '../models/character-profile.model'
import type { EntityDoc } from '../models/entity.model'
import {
  type RelationKind, type GenderHint, RELATION_KINDS, isRelationKind,
} from '../utils/kinship-ontology'
import { hygieneStage1, type ResolvedAssertion } from '../../worker/lib/kinship-hygiene'
import { resolveEpithets } from '../../worker/lib/kinship-epithet-resolver'
import type { RelationAssertion } from './character-codex.service'

const entityEdges = () => mongoColl.entityEdges()
const entities = () => mongoColl.entities()
const EDGE_SOURCE_EVENTS_MAX = 30

/** Player self-references that resolve to the player's own character entity. */
const PLAYER_ALIASES = new Set(['player', 'the player', 'me', 'myself', 'i', 'self', 'you'])

export interface Relative {
  entityId: string
  name: string
  label: string | null
  confidence: number
}
export type RelativesByKind = Partial<Record<RelationKind, Relative[]>>

export const kinshipGraphService = {
  /**
   * Apply a turn's relation assertions: resolve endpoints → (Stage 2 epithets) →
   * Stage 1 hygiene → persist edges. Best-effort; throws are caught by the caller.
   */
  async applyRelationAssertions(params: {
    instanceId: string
    sequence: number
    eventId: ObjectId
    assertions: RelationAssertion[]
    cards: CharacterProfileDoc[]
    /** name_normalized → entity (from syncCodexEntities). */
    entitiesByCardName: Map<string, EntityDoc>
    /** The player's own character entity id (protagonist card in GM; player in sentient). */
    selfAnchorId: string | null
    sceneText: string
  }): Promise<{ written: number; notes: string[] }> {
    const { instanceId, sequence, eventId, assertions, cards, entitiesByCardName, selfAnchorId, sceneText } = params
    if (!assertions?.length) return { written: 0, notes: [] }

    // name → entity id, from the codex cards (canonical + aliases) and the player.
    const nameToId = new Map<string, string>()
    for (const c of cards) {
      const ent = entitiesByCardName.get(c.name_normalized)
      if (!ent?._id) continue
      const id = idString(ent._id)
      nameToId.set(normalizeEntityName(c.canonical_name), id)
      for (const a of c.aliases || []) nameToId.set(normalizeEntityName(a), id)
    }
    const resolveName = (raw: string): string | null => {
      const n = normalizeEntityName(raw)
      if (!n) return null
      if (PLAYER_ALIASES.has(n)) return selfAnchorId
      return nameToId.get(n) || null
    }

    // First pass: resolve endpoints; collect unresolved strings as epithet candidates.
    const unresolved = new Set<string>()
    for (const a of assertions) {
      if (!resolveName(a.from)) unresolved.add(a.from.trim())
      if (!resolveName(a.to)) unresolved.add(a.to.trim())
    }

    // Stage 2: resolve leftover person-epithets to a card (only when there's residue).
    if (unresolved.size > 0) {
      const roster = cards
        .map((c) => {
          const ent = entitiesByCardName.get(c.name_normalized)
          return ent?._id ? { id: idString(ent._id), name: c.canonical_name, role: c.role, aliases: c.aliases } : null
        })
        .filter(Boolean) as { id: string; name: string; role?: string; aliases?: string[] }[]
      const mappings = await resolveEpithets({ epithets: [...unresolved], roster, sceneText }).catch(() => [])
      for (const m of mappings) {
        if (m.resolvedId) nameToId.set(normalizeEntityName(m.epithet), m.resolvedId)
      }
    }

    // Build resolved assertions (drop any whose endpoints still don't resolve).
    const resolved: ResolvedAssertion[] = []
    for (const a of assertions) {
      const fromId = resolveName(a.from)
      const toId = resolveName(a.to)
      if (!fromId || !toId || !isRelationKind(a.kind)) continue
      resolved.push({
        fromId, toId, kind: a.kind as RelationKind,
        label: a.label, gender: (a.gender as GenderHint) || undefined,
        polarity: a.polarity === 'sever' ? 'sever' : 'assert',
        source: a.source === 'character_claim' ? 'character_claim' : 'narrator',
      })
    }
    if (!resolved.length) return { written: 0, notes: ['no resolvable endpoints'] }

    const { edges, notes } = hygieneStage1(resolved)
    const iid = parseObjectId(instanceId)
    const now = new Date()
    let written = 0
    for (const e of edges) {
      const match = {
        instance_id: iid,
        source_entity_id: parseObjectId(e.fromId),
        target_entity_id: parseObjectId(e.toId),
        type: 'kinship',
        relation_kind: e.kind,
      }
      if (e.polarity === 'sever') {
        // A severed tie is retained but closed (until_event_sequence) — history,
        // not deletion, so a later turn can reference "your late husband".
        await entityEdges().updateOne(match, {
          $set: { status: 'ended', until_event_sequence: sequence, last_event_sequence: sequence, updated_at: now },
          $setOnInsert: { created_at: now, since_event_sequence: sequence, importance: 3, source_event_ids: [], confidence: e.confidence, label: e.label, gender_hint: e.gender, inverse_kind: e.inverseKind, assertion_source: e.source },
        } as never, { upsert: true })
        written++
        continue
      }
      await entityEdges().updateOne(match, {
        $set: {
          status: 'active',
          label: e.label,
          gender_hint: e.gender,
          inverse_kind: e.inverseKind,
          assertion_source: e.source,
          confidence: e.confidence,
          until_event_sequence: null,
          last_event_sequence: sequence,
          updated_at: now,
        },
        $max: { importance: 3 },
        $setOnInsert: { created_at: now, since_event_sequence: sequence, source_event_ids: [] },
        $push: { source_event_ids: { $each: [eventId], $slice: -EDGE_SOURCE_EVENTS_MAX } },
      } as never, { upsert: true })
      written++
    }
    return { written, notes }
  },

  /**
   * Relatives of `selfEntityId`, grouped by structural kind, highest-confidence
   * first. One indexed read. Used by the choice guard + presence + UI.
   */
  async relativesOf(instanceId: string, selfEntityId: string): Promise<RelativesByKind> {
    if (!selfEntityId) return {}
    const iid = parseObjectId(instanceId)
    const edges = await entityEdges()
      .find({ instance_id: iid, source_entity_id: parseObjectId(selfEntityId), type: 'kinship', status: 'active' })
      .toArray()
    if (!edges.length) return {}
    const targetIds = [...new Set(edges.map((e) => idString(e.target_entity_id)))]
    const ents = await entities()
      .find({ _id: { $in: targetIds.map(parseObjectId) } }, { projection: { canonical_name: 1 } })
      .toArray()
    const nameById = new Map(ents.map((e) => [idString(e._id), e.canonical_name as string]))
    const out: RelativesByKind = {}
    for (const e of edges) {
      const kind = e.relation_kind
      if (!kind || !isRelationKind(kind)) continue
      const tid = idString(e.target_entity_id)
      ;(out[kind] ||= []).push({
        entityId: tid,
        name: nameById.get(tid) || tid,
        label: (e.label as string) ?? null,
        confidence: typeof e.confidence === 'number' ? e.confidence : 0.5,
      })
    }
    for (const kind of RELATION_KINDS) {
      if (out[kind]) out[kind]!.sort((a, b) => b.confidence - a.confidence)
    }
    return out
  },

  /**
   * Cheap summary for the choice guard: which structural kinds the player HAS,
   * and the surface labels seen per kind. Deterministic, no LLM.
   */
  async kinSummary(instanceId: string, selfEntityId: string): Promise<{
    kinds: Set<RelationKind>
    labelsByKind: Partial<Record<RelationKind, string[]>>
  }> {
    const rel = await this.relativesOf(instanceId, selfEntityId)
    const kinds = new Set<RelationKind>()
    const labelsByKind: Partial<Record<RelationKind, string[]>> = {}
    for (const kind of RELATION_KINDS) {
      const list = rel[kind]
      if (!list?.length) continue
      kinds.add(kind)
      labelsByKind[kind] = list.map((r) => r.label).filter(Boolean) as string[]
    }
    return { kinds, labelsByKind }
  },
}
