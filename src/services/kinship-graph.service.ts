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
import { confidenceTier } from '../utils/world-authority'
import { extractKinshipAssertions, mergeRelationAssertions } from '../../worker/lib/kinship-pattern-extractor'
import type { CharacterProfileDoc } from '../models/character-profile.model'
import type { EntityDoc } from '../models/entity.model'
import {
  type RelationKind, type GenderHint, type RelationModifier, type LifecycleState,
  RELATION_KINDS, isRelationKind, isRelationModifier, isStructuralModifier,
  isLifecycleState, surfaceToKind, composeSurface, isTerminalState, INVERSE_KIND,
} from '../utils/kinship-ontology'
import { hygieneStage1, type ResolvedAssertion, type KinshipEdgeSource } from '../../worker/lib/kinship-hygiene'
import { resolveEpithets } from '../../worker/lib/kinship-epithet-resolver'
import { type LifecycleTransition, extractLifecycleTransitions, TRANSITION_PLAYER, TRANSITION_PROTAGONIST } from '../../worker/lib/kinship-transition-extractor'
import { extractPremiseKinship } from '../../worker/lib/premise-kinship-extractor'
import type { RelationAssertion } from './character-codex.service'

const entityEdges = () => mongoColl.entityEdges()
const entities = () => mongoColl.entities()
const events = () => mongoColl.events()
const worldInstances = () => mongoColl.worldInstances()
const worldTemplates = () => mongoColl.worldTemplates()
const characters = () => mongoColl.characters()
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
  modifier?: RelationModifier
  state?: LifecycleState
}
export type RelativesByKind = Partial<Record<RelationKind, Relative[]>>

/** Fallback surface word when an edge carries no world-native label (e.g. the
 *  auto-closed inverse edge). Keeps the Canon Brief readable. */
const DEFAULT_KIN_LABEL: Record<RelationKind, string> = {
  parent_of: 'parent', child_of: 'child', sibling_of: 'sibling', partner_of: 'partner',
  progenitor_of: 'progenitor', descendant_of: 'descendant', superior_of: 'superior',
  subordinate_of: 'subordinate', kin_of: 'relative', bonded_of: 'bonded companion',
}

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
    /** TRANSITION channel — lifecycle state changes to evolve existing ties this
     *  turn (death/disownment/divorce/reveal). Applied after the assert edges land. */
    transitions?: LifecycleTransition[]
  }): Promise<{ written: number; notes: string[] }> {
    const { instanceId, sequence, eventId, assertions, cards, entitiesByCardName, selfAnchorId, sceneText, ensureStub, transitions } = params
    if (!assertions?.length && !transitions?.length) return { written: 0, notes: [] }

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
        modifier: isRelationModifier(a.modifier) ? a.modifier : undefined,
        polarity: a.polarity === 'sever' ? 'sever' : 'assert',
        // Preserve the assertion's authority (player_correction outranks narrator,
        // a player_claim is softer). Unknown/legacy values fall back to narrator.
        source: toKinshipEdgeSource(a.source),
      })
    }
    if (!resolved.length) {
      // No new ties this turn, but a transition (death/divorce/reveal) can still
      // evolve an EXISTING tie — apply those before bailing.
      if (transitions?.length) {
        const tr = await this.applyLifecycleTransitions({ instanceId, sequence, transitions, resolveName, selfAnchorId }).catch(() => ({ changed: 0, notes: [] as string[] }))
        return { written: tr.changed, notes: tr.notes }
      }
      return { written: 0, notes: ['no resolvable endpoints'] }
    }
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
          $setOnInsert: { created_at: now, since_event_sequence: sequence, importance: 3, source_event_ids: [], confidence: e.confidence, label: e.label, gender_hint: e.gender, relation_modifier: e.modifier ?? 'biological', inverse_kind: e.inverseKind, assertion_source: e.source },
        } as never, { upsert: true })
        written++
        continue
      }
      await entityEdges().updateOne(match, {
        $set: {
          status: 'active',
          label: e.label,
          gender_hint: e.gender,
          relation_modifier: e.modifier ?? 'biological',
          inverse_kind: e.inverseKind,
          assertion_source: e.source,
          confidence: e.confidence,
          until_event_sequence: null,
          last_event_sequence: sequence,
          updated_at: now,
        },
        $max: { importance: 3 },
        $setOnInsert: { created_at: now, since_event_sequence: sequence },
        $push: { source_event_ids: { $each: [eventId], $slice: -EDGE_SOURCE_EVENTS_MAX } },
      } as never, { upsert: true })
      written++
    }

    // STEP 1 — co-parent inference (DB-backed): the partner of a parent is a parent
    // too. Runs AFTER this turn's edges land so it sees both the freshly-asserted and
    // the prior graph (the common case: "her husband" arrives turns after the mother
    // was established). Gated + low-confidence + correctable; see deriveCoParents.
    const coParent = await this.deriveCoParents({ instanceId, sequence, eventId, touched: resolved }).catch(() => ({ written: 0, notes: [] as string[] }))
    written += coParent.written
    notes.push(...coParent.notes)

    // TRANSITION channel — evolve existing ties' lifecycle state (death/disownment/
    // divorce/reveal). NOT authority-gated by seed; see applyLifecycleTransitions.
    if (transitions?.length) {
      const tr = await this.applyLifecycleTransitions({
        instanceId, sequence, transitions, resolveName, selfAnchorId,
      }).catch(() => ({ changed: 0, notes: [] as string[] }))
      written += tr.changed
      notes.push(...tr.notes)
    }
    return { written, notes }
  },

  /**
   * STEP 1 — derive co-parent edges. For every `partner_of(X, P)` where `P` is a
   * `parent_of(C)`, infer `parent_of(X, C)`. Reads the live graph (so it spans turns,
   * unlike the pure batch sibling-closure in hygiene). STRICTLY gated for accuracy:
   *  - only fires when BOTH feeding edges are STRUCTURAL (biological/adoptive/foster);
   *    a step/half/in-law partner or parent yields NO biological inference.
   *  - the inferred edge is `source: 'inferred'` (confidence 0.4), so ANY explicit
   *    later statement ("X is C's stepfather", narrator 0.9) overrides it.
   *  - never overwrites an existing parent edge between X and C.
   * Best-effort; returns the count + notes. Off TTFT (post-stream).
   */
  async deriveCoParents(params: {
    instanceId: string
    sequence: number
    eventId: ObjectId
    touched: ResolvedAssertion[]
  }): Promise<{ written: number; notes: string[] }> {
    const { instanceId, sequence, eventId, touched } = params
    const iid = parseObjectId(instanceId)
    // Endpoints this turn touched a partner_of or parent_of on — the only places a
    // new co-parent could appear, so we don't rescan the whole graph each turn.
    const seeds = new Set<string>()
    for (const a of touched) {
      if (a.polarity !== 'assert') continue
      if (a.kind === 'partner_of' || a.kind === 'parent_of' || a.kind === 'child_of') {
        seeds.add(a.fromId); seeds.add(a.toId)
      }
    }
    if (seeds.size === 0) return { written: 0, notes: [] }
    const seedOids = [...seeds].map((s) => parseObjectId(s))
    const rows = await entityEdges().find({
      instance_id: iid, type: 'kinship', status: 'active',
      relation_kind: { $in: ['partner_of', 'parent_of'] },
      $or: [{ source_entity_id: { $in: seedOids } }, { target_entity_id: { $in: seedOids } }],
    }).toArray()
    const isStruct = (m: unknown) => isStructuralModifier(isRelationModifier(m) ? m : undefined)
    // partners[p] = set of structural partners of p ; parentsOf[c] = structural parents of c
    const partnersOf = new Map<string, Set<string>>()
    const parentEdges: { parent: string; child: string }[] = []
    for (const r of rows as any[]) {
      const from = idString(r.source_entity_id), to = idString(r.target_entity_id)
      if (!isStruct(r.relation_modifier)) continue
      if (r.relation_kind === 'partner_of') {
        if (!partnersOf.has(from)) partnersOf.set(from, new Set())
        partnersOf.get(from)!.add(to)
      } else if (r.relation_kind === 'parent_of') {
        parentEdges.push({ parent: from, child: to })
      }
    }
    // Existing parent_of(x→c) pairs, to never duplicate / override an explicit tie.
    const existingParent = new Set(parentEdges.map((e) => `${e.parent}|${e.child}`))
    const now = new Date()
    let written = 0
    const notes: string[] = []
    for (const { parent, child } of parentEdges) {
      for (const partner of partnersOf.get(parent) || []) {
        if (partner === child) continue
        const key = `${partner}|${child}`
        if (existingParent.has(key)) continue
        existingParent.add(key)
        // Write parent_of(partner→child) + inverse child_of, low-confidence inferred,
        // biological modifier (the partner is presented as a co-parent). Upsert only
        // on insert-or-weaker so a real assertion never gets clobbered by inference.
        for (const [f, t, kind, inv] of [
          [partner, child, 'parent_of', 'child_of'],
          [child, partner, 'child_of', 'parent_of'],
        ] as const) {
          const res = await entityEdges().updateOne(
            { instance_id: iid, source_entity_id: parseObjectId(f), target_entity_id: parseObjectId(t), type: 'kinship', relation_kind: kind },
            {
              $setOnInsert: {
                status: 'active', label: null, gender_hint: null, relation_modifier: 'biological',
                inverse_kind: inv, assertion_source: 'inferred', confidence: 0.4,
                until_event_sequence: null, importance: 2, source_event_ids: [eventId],
                created_at: now, since_event_sequence: sequence,
              },
              $set: { last_event_sequence: sequence, updated_at: now },
            } as never,
            { upsert: true },
          )
          if (res.upsertedCount) written++
        }
        notes.push(`inferred co-parent ${partner}→${child}`)
      }
    }
    return { written, notes }
  },

  /**
   * TRANSITION channel — apply lifecycle transitions to EXISTING ties. A transition
   * names an owner + a kin word ("my father died"); we find the owner's matching
   * relation edge(s) and set their `relation_state` (deceased/estranged/dissolved/
   * revealed_false) on BOTH directions. Death/estrangement keep the tie live (history
   * preserved — "your late father"); a divorce or a twist closes it. NOT blocked by
   * seed authority: the story is allowed to evolve a tie the premise established.
   */
  async applyLifecycleTransitions(params: {
    instanceId: string
    sequence: number
    transitions: LifecycleTransition[]
    resolveName: (raw: string) => string | null
    selfAnchorId: string | null
  }): Promise<{ changed: number; notes: string[] }> {
    const { instanceId, sequence, transitions, resolveName, selfAnchorId } = params
    const iid = parseObjectId(instanceId)
    const now = new Date()
    let changed = 0
    const notes: string[] = []
    for (const t of transitions) {
      const ownerId = t.owner === TRANSITION_PLAYER || t.owner === TRANSITION_PROTAGONIST
        ? selfAnchorId
        : resolveName(t.owner)
      if (!ownerId) continue
      const mapped = surfaceToKind(t.rel)
      if (!mapped) continue
      // "owner's <rel>" = an edge "X is owner's <rel>": source=X, target=owner, kind.
      const filter: any = {
        instance_id: iid, type: 'kinship', status: 'active',
        relation_kind: mapped.kind, target_entity_id: parseObjectId(ownerId),
      }
      if (mapped.gender) filter.gender_hint = mapped.gender
      const matches = await entityEdges().find(filter).toArray()
      const terminal = isTerminalState(t.state)
      for (const m of matches as any[]) {
        const x = idString(m.source_entity_id)
        for (const [f, to, kind] of [
          [x, ownerId, mapped.kind],
          [ownerId, x, INVERSE_KIND[mapped.kind as RelationKind]],
        ] as const) {
          await entityEdges().updateOne(
            { instance_id: iid, source_entity_id: parseObjectId(f), target_entity_id: parseObjectId(to), type: 'kinship', relation_kind: kind },
            {
              $set: {
                relation_state: t.state,
                ...(terminal ? { status: t.state === 'revealed_false' ? 'retconned' : 'ended', until_event_sequence: sequence } : {}),
                last_event_sequence: sequence, updated_at: now,
              },
            } as never,
          )
        }
        changed++
        notes.push(`transition ${mapped.kind} of ${t.owner} → ${t.state}`)
      }
    }
    return { changed, notes }
  },

  /**
   * STEP 0 — premise kinship seeding. ONE-TIME, off TTFT (instance setup, not a turn).
   * Extracts the family the authored premise + protagonist persona establish, anchors
   * the premise's "you" to the protagonist, and writes them as highest-authority
   * `system_seed` edges so every later turn (and the co-parent inference) builds on a
   * correct base. Idempotent via `meta.kinship_seeded`. The authored ties are also
   * stored on the instance (`seed_relation_assertions`) so a rebuild re-applies them
   * first — see rebuildFromLedger. Best-effort; never throws.
   */
  async seedPremiseKinship(params: { instanceId: string; playerId: string }): Promise<{ seeded: number; notes: string[] }> {
    const { instanceId, playerId } = params
    const iid = parseObjectId(instanceId)
    const instance = await worldInstances().findOne({ _id: iid })
    if (!instance) return { seeded: 0, notes: ['no instance'] }
    if ((instance as any).meta?.kinship_seeded) return { seeded: 0, notes: ['already seeded'] }
    const protag = await characters().findOne({ instance_id: iid, is_protagonist: true })
    if (!protag) return { seeded: 0, notes: ['no protagonist yet — seed deferred'] }

    // The premise lives on the TEMPLATE (not denormalized onto the instance).
    const template = await worldTemplates().findOne(
      { _id: (instance as any).template_id }, { projection: { seed_prompt: 1, global_lore: 1 } },
    )
    const premise = [String((template as any)?.seed_prompt || ''), String((template as any)?.global_lore || '')]
      .filter(Boolean).join('\n\n')
    const assertions = await extractPremiseKinship({
      premise, persona: (protag as any).persona, protagonistName: (protag as any).canonical_name,
    }).catch(() => [] as RelationAssertion[])
    // Anchor: any endpoint that names the protagonist becomes "player" so it resolves
    // to the single protagonist entity (never a duplicate stub).
    const protagNorm = normalizeEntityName((protag as any).canonical_name)
    const normed = assertions.map((a) => ({
      ...a,
      from: normalizeEntityName(a.from) === protagNorm ? 'player' : a.from,
      to: normalizeEntityName(a.to) === protagNorm ? 'player' : a.to,
    }))
    if (!normed.length) {
      await worldInstances().updateOne({ _id: iid }, { $set: { 'meta.kinship_seeded': true } })
      return { seeded: 0, notes: ['premise establishes no kinship'] }
    }
    const selfAnchorId = await entityGraphService
      .ensureStubEntity({ instanceId, playerId, sequence: 0, name: (protag as any).canonical_name })
      .catch(() => null)
    const entityMap = new Map<string, EntityDoc>()
    if (selfAnchorId) entityMap.set((protag as any).name_normalized, { _id: parseObjectId(selfAnchorId) } as EntityDoc)
    const res = await this.applyRelationAssertions({
      instanceId, sequence: 0, eventId: new ObjectId(),
      assertions: normed, cards: [protag as unknown as CharacterProfileDoc], entitiesByCardName: entityMap,
      selfAnchorId, sceneText: premise,
      ensureStub: (n) => entityGraphService.ensureStubEntity({ instanceId, playerId, sequence: 0, name: n }).then((id) => id),
    }).catch(() => ({ written: 0, notes: [] as string[] }))
    await worldInstances().updateOne(
      { _id: iid },
      { $set: { seed_relation_assertions: normed, 'meta.kinship_seeded': true } },
    )
    return { seeded: res.written, notes: res.notes }
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

    // 2b. Re-apply the authored premise seed FIRST (sequence 0), so a rebuild never
    // loses the system_seed canon. Stored on the instance by seedPremiseKinship.
    const seedAssertions = ((await worldInstances().findOne(
      { _id: iid }, { projection: { seed_relation_assertions: 1 } },
    )) as any)?.seed_relation_assertions as RelationAssertion[] | undefined
    if (seedAssertions?.length) {
      try {
        const res = await kinshipGraphService.applyRelationAssertions({
          instanceId, sequence: 0, eventId: new ObjectId(),
          assertions: seedAssertions, cards: codex, entitiesByCardName: entityMap,
          selfAnchorId, sceneText: '',
          ensureStub: (name: string) => entityGraphService.ensureStubEntity({ instanceId, playerId, sequence: 0, name }),
        })
        notes.push(`re-seeded ${res.written} premise edge(s)`)
      } catch (err) {
        notes.push(`seed re-apply failed — ${(err as Error).message}`)
      }
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
      const transitions = extractLifecycleTransitions({
        corrections: parsed.corrections,
        narrationFacts: parsed.narrationFacts,
        claims: parsed.claims,
        prose: ev.data?.ai_response || '',
      })
      if (!merged.length && !transitions.length) continue
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
          transitions,
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
   * Apply only the suffix of the kinship ledger after a restored checkpoint.
   * Unlike rebuildFromLedger, this does NOT clear existing kinship edges: the
   * checkpoint already restored the prefix projection, so this replays only
   * events with sequence > fromSequence.
   */
  async applyLedgerSince(params: {
    instanceId: string
    playerId: string
    isSentient: boolean
    fromSequence: number
    playerName?: string | null
    includeSideChat?: boolean
  }): Promise<{ written: number; events: number; notes: string[] }> {
    const { instanceId, playerId, isSentient, fromSequence, playerName, includeSideChat } = params
    const iid = parseObjectId(instanceId)
    const notes: string[] = []

    const codex = await characterCodexService.listForInstance(instanceId, 200)
    const latestSeq = await events()
      .find({ instance_id: iid }, { projection: { sequence: 1 } })
      .sort({ sequence: -1 })
      .limit(1)
      .toArray()
    const anchorSeq = latestSeq[0]?.sequence ?? fromSequence
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

    const typeFilter = includeSideChat ? {} : { type: { $ne: 'side_chat' } }
    const ledger = await events()
      .find(
        { instance_id: iid, sequence: { $gt: fromSequence }, ...typeFilter },
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
      const transitions = extractLifecycleTransitions({
        corrections: parsed.corrections,
        narrationFacts: parsed.narrationFacts,
        claims: parsed.claims,
        prose: ev.data?.ai_response || '',
      })
      if (!merged.length && !transitions.length) continue
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
          transitions,
        })
        written += res.written
      } catch (err) {
        notes.push(`seq ${ev.sequence}: apply failed — ${(err as Error).message}`)
      }
    }
    notes.push(`replayed suffix ${touched} event(s) with assertions`)
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
        modifier: isRelationModifier(e.relation_modifier) ? e.relation_modifier : undefined,
        state: isLifecycleState(e.relation_state) ? e.relation_state : undefined,
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

  /**
   * CANON BRIEF (relationships half) — compact, always-on relationship facts for the
   * turn's ACTIVE entities, so the NARRATOR (not just the choice guard) knows how the
   * people in play are related and their lifecycle state. This is the read-path that
   * makes the kinship graph visible to prose: "Aldric is your father (deceased — do
   * not portray as alive)", "Mara is your sister", "Bram is Mara's husband".
   *
   * One indexed query over edges touching any active entity (either endpoint, so a
   * relative who isn't on-screen still surfaces). Deterministic, no LLM, off TTFT
   * (runs concurrently with RAG in the context packet). Bounded: pairs touching the
   * protagonist rank first, then ties among active entities, capped at `limit` lines.
   */
  async kinshipBrief(
    instanceId: string,
    activeEntityIds: string[],
    selfEntityId: string | null,
    limit = 14,
  ): Promise<string[]> {
    const ids = [...new Set((activeEntityIds || []).filter(Boolean))]
    if (!ids.length) return []
    const iid = parseObjectId(instanceId)
    const oids = ids.map(parseObjectId)
    const edges = await entityEdges()
      .find({
        instance_id: iid, type: 'kinship', status: 'active',
        $or: [{ source_entity_id: { $in: oids } }, { target_entity_id: { $in: oids } }],
      })
      .toArray()
    if (!edges.length) return []
    const endpointIds = new Set<string>()
    for (const e of edges) {
      endpointIds.add(idString(e.source_entity_id))
      endpointIds.add(idString(e.target_entity_id))
    }
    const ents = await entities()
      .find({ _id: { $in: [...endpointIds].map(parseObjectId) } }, { projection: { canonical_name: 1 } })
      .toArray()
    const nameById = new Map(ents.map((e) => [idString(e._id), e.canonical_name as string]))
    const activeSet = new Set(ids)
    // Collapse each unordered pair to ONE edge — prefer the one carrying a label so
    // "Aldric is your father" wins over the unlabelled inverse "you are Aldric's child".
    const byPair = new Map<string, (typeof edges)[number]>()
    for (const e of edges) {
      const a = idString(e.source_entity_id), b = idString(e.target_entity_id)
      const key = [a, b].sort().join('|')
      const prev = byPair.get(key)
      if (!prev || (e.label && !prev.label)) byPair.set(key, e)
    }
    // Rank: pairs involving the protagonist first, then pairs wholly among active
    // entities, then the rest — so the most relevant relationships survive the cap.
    const rankOfEdge = (e: (typeof edges)[number]): number => {
      const a = idString(e.source_entity_id), b = idString(e.target_entity_id)
      if (selfEntityId && (a === selfEntityId || b === selfEntityId)) return 0
      if (activeSet.has(a) && activeSet.has(b)) return 1
      return 2
    }
    const ordered = [...byPair.values()].sort((x, y) => rankOfEdge(x) - rankOfEdge(y))
    const lines: string[] = []
    for (const e of ordered) {
      const kind = e.relation_kind
      if (!isRelationKind(kind)) continue
      // Consumption tiering: surface a low-confidence tie as a soft HINT (or drop
      // it) rather than asserting it as hard canon, so a wrong inferred edge (e.g.
      // a derived co-parent at 0.4) can't force the narrator's hand. An UNTAGGED
      // legacy edge (no confidence recorded) defaults to canon — trusted exactly
      // as the old untiered code treated it.
      const tier = confidenceTier(typeof e.confidence === 'number' ? e.confidence : null)
      if (tier === 'hidden') continue
      const fromId = idString(e.source_entity_id), toId = idString(e.target_entity_id)
      const label = (e.label as string) || DEFAULT_KIN_LABEL[kind] || 'relative'
      const surface = composeSurface(
        label,
        isRelationModifier(e.relation_modifier) ? e.relation_modifier : undefined,
        isLifecycleState(e.relation_state) ? e.relation_state : undefined,
      )
      const subj = fromId === selfEntityId ? 'You' : (nameById.get(fromId) || null)
      const objName = toId === selfEntityId ? 'your' : (nameById.get(toId) ? `${nameById.get(toId)}'s` : null)
      if (!subj || !objName) continue
      const verb = subj === 'You' ? 'are' : 'is'
      let line: string
      if (tier === 'hint') {
        // Hedged + no hard lifecycle directive — the whole tie is uncorroborated,
        // so its death/estrangement state is uncertain too.
        line = `Possibly: ${subj} ${verb} ${objName} ${surface}. (Unconfirmed — treat as a hunch, not established fact.)`
      } else {
        line = `${subj} ${verb} ${objName} ${surface}.`
        if (e.relation_state === 'deceased') line += ' (Deceased — do not portray as alive or present.)'
        else if (e.relation_state === 'estranged') line += ' (Estranged.)'
      }
      lines.push(line)
      if (lines.length >= limit) break
    }
    return lines
  },
}
