/**
 * Kinship graph service — the WRITE and READ paths for typed relationships.
 * See KINSHIP_GRAPH.md. Edges live in `entity_edges` (type: 'kinship'). Writing
 * happens on the post-stream turn tail (best-effort, never blocks the codex);
 * reading is a cheap indexed query the choice guard / presence consult.
 */
import { ObjectId } from 'mongodb'
import { mongoColl } from '../config/mongo'
import { parseObjectId, idString } from '../utils/mongo-id'
import { normalizeEntityName, entityGraphService } from './entity-graph.service'
import { characterCodexService } from './character-codex.service'
import { parsePlayerInput } from '../utils/player-input-parser'
import { extractKinshipAssertions, mergeRelationAssertions } from '../../worker/lib/kinship-pattern-extractor'
import type { CharacterProfileDoc } from '../models/character-profile.model'
import type { EntityDoc } from '../models/entity.model'
import {
  type RelationKind, type GenderHint, RELATION_KINDS, isRelationKind,
} from '../utils/kinship-ontology'
import { hygieneStage1, type ResolvedAssertion, type KinshipEdgeSource } from '../../worker/lib/kinship-hygiene'
import { resolveEpithets } from '../../worker/lib/kinship-epithet-resolver'
import type { RelationAssertion } from './character-codex.service'

const entityEdges = () => mongoColl.entityEdges()
const entities = () => mongoColl.entities()
const events = () => mongoColl.events()
const EDGE_SOURCE_EVENTS_MAX = 30

/** Player self-references that resolve to the player's own character entity. */
const PLAYER_ALIASES = new Set(['player', 'the player', 'me', 'myself', 'i', 'self', 'you'])

const KINSHIP_EDGE_SOURCES = new Set<KinshipEdgeSource>([
  'player_correction', 'player_narration', 'narrator', 'seed', 'player_claim', 'character_claim', 'inferred',
])
/** Coerce a RelationAssertion.source (WorldFactSource, possibly legacy/undefined)
 *  to a kinship edge source. Sources the edge layer doesn't model collapse to the
 *  nearest neighbour: side_chat/system_seed/inference → narrator/seed/inferred. */
function toKinshipEdgeSource(source: string | undefined): KinshipEdgeSource {
  if (source && KINSHIP_EDGE_SOURCES.has(source as KinshipEdgeSource)) return source as KinshipEdgeSource
  if (source === 'system_seed') return 'seed'
  if (source === 'inference') return 'inferred'
  if (source === 'side_chat') return 'narrator'
  return 'narrator'
}

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
    /** WITNESS → ENTITY-STUB fallback: when an assertion endpoint (e.g. "Mara")
     *  has no codex card, the caller may provide this to ensure a stub entity
     *  exists for the name so the typed edge is WRITTEN against it instead of
     *  being dropped. This is the fix for "Mara is sister but Mara has no card
     *  → the edge disappears": the tie is captured now against a stub, and when
     *  Mara later earns a card the stub promotes and the edge survives. Returns
     *  the entity id (stub OR an existing real one), or null to drop. */
    ensureStub?: (name: string) => Promise<string | null>
  }): Promise<{ written: number; notes: string[] }> {
    const { instanceId, sequence, eventId, assertions, cards, entitiesByCardName, selfAnchorId, sceneText, ensureStub } = params
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

    // Build resolved assertions. Endpoints resolve first to codex cards (and the
    // player), then — when an endpoint has no card — to a STUB entity via the
    // caller's ensureStub fallback, so a typed tie ("Mara is the player's sister")
    // is CAPTURED against a stub instead of being silently dropped. The stub
    // promotes to a full entity when Mara later earns a card, and this edge
    // survives. Only drop an endpoint that neither resolves nor stubs.
    const resolved: ResolvedAssertion[] = []
    const stubbedNames = new Set<string>()
    for (const a of assertions) {
      let fromId = resolveName(a.from)
      let toId = resolveName(a.to)
      if (!fromId && ensureStub) {
        const stub = await ensureStub(a.from).catch(() => null)
        if (stub) { fromId = stub; stubbedNames.add(a.from.trim()) }
      }
      if (!toId && ensureStub) {
        const stub = await ensureStub(a.to).catch(() => null)
        if (stub) { toId = stub; stubbedNames.add(a.to.trim()) }
      }
      if (!fromId || !toId || !isRelationKind(a.kind)) continue
      resolved.push({
        fromId, toId, kind: a.kind as RelationKind,
        label: a.label, gender: (a.gender as GenderHint) || undefined,
        polarity: a.polarity === 'sever' ? 'sever' : 'assert',
        // Preserve the assertion's authority (player_correction outranks narrator,
        // a player_claim is softer). Unknown/legacy values fall back to narrator.
        source: toKinshipEdgeSource(a.source),
      })
    }
    if (!resolved.length) return { written: 0, notes: ['no resolvable endpoints'] }
    const notes: string[] = []
    if (stubbedNames.size) notes.push(`stubbed ${stubbedNames.size} uncarded endpoint(s): ${[...stubbedNames].slice(0, 8).join(', ')}`)

    const { edges, notes: hygieneNotes } = hygieneStage1(resolved)
    notes.push(...hygieneNotes)
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
   * FULL kinship-graph rebuild from the event ledger — the canonical repair. Drops
   * every kinship edge for the instance, then replays EACH surviving event's
   * relation assertions in sequence order, merging the LLM-ledgered assertions with
   * a fresh deterministic pass over that turn's player input + prose (so authority
   * — a player_correction can retcon, a claim stays soft — is reconstructed exactly
   * as the live path produced it). Inverse edges + sever/retcon polarity are handled
   * by applyRelationAssertions/hygiene per turn, so replaying in order yields an
   * exact projection.
   *
   * Call after the CODEX has been rebuilt (rewind/replay-exact repair, admin
   * repair, projection audit) — it reads the current codex/entities to resolve
   * endpoints. Offline only (it may fire epithet-resolver LLM calls per turn); never
   * on the live TTFT path. Best-effort: per-turn failures are collected, not thrown.
   */
  async rebuildFromLedger(params: {
    instanceId: string
    playerId: string
    isSentient: boolean
    playerName?: string | null
    /** Include side-chat events' assertions (default false — main ledger only). */
    includeSideChat?: boolean
  }): Promise<{ written: number; events: number; notes: string[] }> {
    const { instanceId, playerId, isSentient, playerName, includeSideChat } = params
    const iid = parseObjectId(instanceId)
    const notes: string[] = []

    // 1. Drop existing kinship edges — the rebuild is the new source of truth.
    const del = await entityEdges().deleteMany({ instance_id: iid, type: 'kinship' })
    if (del.deletedCount) notes.push(`cleared ${del.deletedCount} kinship edge(s)`)

    // 2. Resolve the codex → entity map + self anchor once (stable across the loop).
    const codex = await characterCodexService.listForInstance(instanceId, 200)
    const latestSeq = await events()
      .find({ instance_id: iid }, { projection: { sequence: 1 } })
      .sort({ sequence: -1 })
      .limit(1)
      .toArray()
    const anchorSeq = latestSeq[0]?.sequence ?? 0
    const entityMap = await entityGraphService.syncCodexEntities({
      instanceId,
      playerId,
      sequence: anchorSeq,
      cards: codex,
    })
    let selfAnchorId: string | null = null
    const protagCard = codex.find((c) => c.is_protagonist)
    if (!isSentient && protagCard) {
      const ent = entityMap.get(protagCard.name_normalized)
      selfAnchorId = ent?._id ? idString(ent._id) : null
    } else {
      const player = await entityGraphService.ensurePlayerEntity({
        instanceId,
        playerId,
        name: playerName ?? undefined,
        sequence: anchorSeq,
      })
      selfAnchorId = idString(player._id)
    }

    // 3. Replay each event's assertions (LLM ledger ∪ deterministic) in order.
    const typeFilter = includeSideChat ? {} : { type: { $ne: 'side_chat' } }
    const ledger = await events()
      .find(
        { instance_id: iid, ...typeFilter },
        { projection: { sequence: 1, _id: 1, 'data.codex_deltas': 1, 'data.player_input': 1, 'data.ai_response': 1 } },
      )
      .sort({ sequence: 1 })
      .toArray()

    let written = 0
    let touched = 0
    for (const ev of ledger) {
      const llm = (ev.data?.codex_deltas || []).flatMap((d) => d.relation_assertions || [])
      const parsed = parsePlayerInput(ev.data?.player_input || '')
      const deterministic = extractKinshipAssertions({
        corrections: parsed.corrections,
        narrationFacts: parsed.narrationFacts,
        claims: parsed.claims,
        prose: ev.data?.ai_response || '',
      })
      const merged = mergeRelationAssertions(llm, deterministic)
      if (!merged.length) continue
      touched++
      try {
        const res = await kinshipGraphService.applyRelationAssertions({
          instanceId,
          sequence: ev.sequence,
          eventId: ev._id as ObjectId,
          assertions: merged,
          cards: codex,
          entitiesByCardName: entityMap,
          selfAnchorId,
          sceneText: ev.data?.ai_response || '',
          ensureStub: (name: string) =>
            entityGraphService.ensureStubEntity({ instanceId, playerId, sequence: ev.sequence, name }),
        })
        written += res.written
      } catch (err) {
        notes.push(`seq ${ev.sequence}: apply failed — ${(err as Error).message}`)
      }
    }
    notes.push(`replayed ${touched} event(s) with assertions`)
    return { written, events: touched, notes }
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
