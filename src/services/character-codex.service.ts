import { ObjectId } from 'mongodb'
import { mongoColl } from '../config/mongo'
import type { CharacterProfileDoc, RelationshipMeters } from '../models/character-profile.model'
import { idString, parseObjectId } from '../utils/mongo-id'
import { HttpError } from '../utils/http-error'

const characters = () => mongoColl.characters()

export type RelationshipDeltas = Partial<RelationshipMeters>

export type CharacterCodexDelta = {
  name: string
  aliases?: string[]
  resolved_name?: string
  role?: string
  appearance?: string
  persona?: string
  immutable_facts?: string[]
  mutable_state?: string[]
  /** Existing current-state items this turn made false/obsolete; removed on merge. */
  retire_state?: string[]
  disposition_to_player?: string
  hidden_thought?: string
  /** Per-turn meter shifts toward the player (already clamped to ±10 on parse). */
  relationship_deltas?: RelationshipDeltas
  is_protagonist?: boolean
  /** Typed kinship/relation ties asserted THIS turn between two people (or the
   *  player). Consumed by the kinship graph (KINSHIP_GRAPH.md), not the codex
   *  fold itself. `from`/`to` are names the extractor already resolves; "player"
   *  / "me" / the protagonist's name anchor to the player's character. */
  relation_assertions?: RelationAssertion[]
}

export type RelationAssertion = {
  /** One endpoint, by name/alias (or "player"/"me" for the player's character). */
  from: string
  /** The other endpoint, by name/alias. */
  to: string
  /** CLOSED structural kind read FROM `from`'s perspective ("from is to's <kind>"). */
  kind: string
  /** World-native term ("twin sister", "clone-brother", "my sire"). */
  label?: string
  /** 'm' | 'f' | 'n' gender hint implied by the label. */
  gender?: string
  /** assert (default) | sever (the tie ended this turn — divorce, death). */
  polarity?: 'assert' | 'sever'
  /** Did the NARRATOR establish it, or did a CHARACTER merely claim it (maybe a lie)? */
  source?: 'narrator' | 'character_claim'
}

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s'-]+/g, '')
    .replace(/\s+/g, ' ')
}

function uniqStrings(values: string[], max: number): string[] {
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

/**
 * Dedupe (order-preserving) then keep the MOST RECENT `max` items. Unlike
 * uniqStrings (which keeps the oldest and drops new on overflow), this never
 * silently drops a fact/state the latest turn just added — important over very
 * long playthroughs. An async LLM compaction pass distills the list back down
 * when it grows large, preserving identity/important history.
 */
function uniqKeepRecent(values: string[], max: number): string[] {
  const deduped = uniqStrings(values, Number.MAX_SAFE_INTEGER)
  return deduped.length <= max ? deduped : deduped.slice(deduped.length - max)
}

/** Stored fact ceiling (a safety bound; async compaction keeps it well under this). */
const IMMUTABLE_STORE_MAX = 40
const MUTABLE_STATE_MAX = 12

/** Relationship meter guardrails: LLM noise must not whipsaw the numbers. */
const RELATIONSHIP_BASELINES: RelationshipMeters = { trust: 50, affection: 50, fear: 0, rivalry: 0 }
const RELATIONSHIP_DELTA_CAP = 10
const METER_MIN = 0
const METER_MAX = 100

/**
 * Apply clamped per-turn deltas to a character's relationship meters. Meters
 * initialize from baselines on the first meter-moving turn; each delta is
 * capped at ±RELATIONSHIP_DELTA_CAP and the result bounded to [0, 100].
 */
export function applyRelationshipDeltas(
  current: RelationshipMeters | undefined,
  deltas: RelationshipDeltas,
): RelationshipMeters {
  const base = current ?? { ...RELATIONSHIP_BASELINES }
  const next: RelationshipMeters = { ...base }
  for (const key of ['trust', 'affection', 'fear', 'rivalry'] as const) {
    const raw = deltas[key]
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw === 0) continue
    const capped = Math.max(-RELATIONSHIP_DELTA_CAP, Math.min(RELATIONSHIP_DELTA_CAP, Math.round(raw)))
    next[key] = Math.max(METER_MIN, Math.min(METER_MAX, (base[key] ?? RELATIONSHIP_BASELINES[key]) + capped))
  }
  return next
}

function hasRelationshipDeltas(deltas?: RelationshipDeltas): deltas is RelationshipDeltas {
  if (!deltas) return false
  return (['trust', 'affection', 'fear', 'rivalry'] as const).some(
    (k) => typeof deltas[k] === 'number' && Number.isFinite(deltas[k]) && deltas[k] !== 0,
  )
}

/** Recency half-life (turns) for codex injection ranking. */
const RANK_HALF_LIFE = 80

/**
 * Recency-weighted importance: a character mentioned often AND recently ranks
 * high; one that was central long ago but dormant for many turns decays out, so
 * the injected top-K tracks the CURRENT cast instead of lifetime frequency.
 */
export function rankCodexForInjection<
  T extends { is_protagonist?: boolean; mention_count: number; last_seen_sequence: number },
>(chars: T[], currentSequence: number, limit: number): T[] {
  const protagonists = chars.filter((c) => c.is_protagonist)
  const scored = chars
    .filter((c) => !c.is_protagonist)
    .map((c) => {
      const age = Math.max(0, currentSequence - (c.last_seen_sequence || 0))
      const score = (c.mention_count || 1) * Math.pow(0.5, age / RANK_HALF_LIFE)
      return { c, score }
    })
    .sort((a, b) => b.score - a.score)
    .map((x) => x.c)
  return [...protagonists, ...scored].slice(0, limit)
}

function shouldSetText(value?: string): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function normalizeState(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Reconcile a character's CURRENT status snapshot: drop items the latest turn
 * marked obsolete (`retire`), then add the new ones. This is what stops stale
 * status (e.g. "engaged to Lord X") from lingering after the story moves on —
 * the previous behaviour merely appended, so contradictions coexisted forever.
 */
function reconcileMutableState(
  existing: string[],
  retire: string[],
  add: string[],
  max: number,
): string[] {
  const retireNorm = (retire || [])
    .map(normalizeState)
    .filter((r) => r.length >= 3)
  const kept = (existing || []).filter((item) => {
    const n = normalizeState(item)
    return !retireNorm.some((r) => n === r || n.includes(r) || r.includes(n))
  })
  return uniqKeepRecent([...kept, ...(add || [])], max)
}

function buildAliasSet(delta: CharacterCodexDelta): string[] {
  return uniqStrings([
    delta.name,
    ...(delta.aliases || []),
  ], 20)
}

/**
 * In-memory working set for folding codex deltas. Cards are mutated in place;
 * `created` holds brand-new cards (to insert), `dirty` holds existing cards that
 * changed (to update). `byName` maps every name + alias → its card so referents
 * resolve, and `protagonist` enforces the single-protagonist invariant.
 */
interface FoldState {
  byName: Map<string, CharacterProfileDoc>
  created: Set<CharacterProfileDoc>
  dirty: Set<CharacterProfileDoc>
  protagonist?: CharacterProfileDoc
}

function newFoldState(existing: CharacterProfileDoc[]): FoldState {
  const byName = new Map<string, CharacterProfileDoc>()
  for (const c of existing) {
    byName.set(c.name_normalized, c)
    for (const a of c.aliases || []) byName.set(normalizeName(a), c)
  }
  return {
    byName,
    created: new Set(),
    dirty: new Set(),
    protagonist: existing.find((c) => c.is_protagonist),
  }
}

/**
 * Fold one codex delta into the working set — the SINGLE source of truth for
 * how a turn shapes a character card. Shared by per-turn application
 * ({@link applyDeltas}) and the exact rewind rebuild
 * ({@link rebuildCodexFromLedger}) so the two can never diverge. Pure (no I/O):
 * mutates the in-memory state only.
 */
function foldDelta(
  state: FoldState,
  delta: CharacterCodexDelta,
  sequence: number,
  ctx: { iid: ObjectId; pid: ObjectId; now: Date },
): void {
  if (!shouldSetText(delta.name)) return

  const candidateNames = uniqStrings([
    delta.resolved_name || '',
    delta.name,
    ...(delta.aliases || []),
  ], 10).map(normalizeName)

  let target: CharacterProfileDoc | undefined
  for (const n of candidateNames) {
    if (!n) continue
    target = state.byName.get(n)
    if (target) break
  }

  // A NEW name claiming to be the protagonist is a referent of the protagonist
  // (a role title/epithet — "the neglected son"), never a second person. Merge
  // into the canonical card; the alias merge below makes it permanent.
  if (!target && delta.is_protagonist === true && state.protagonist) {
    target = state.protagonist
  }

  const aliases = buildAliasSet(delta)
  const name = (delta.resolved_name || delta.name).trim()
  const normalized = normalizeName(name)

  if (!target) {
    // Fresh card captures everything THIS delta carries (mention_count = 1).
    const doc: CharacterProfileDoc = {
      _id: new ObjectId(),
      instance_id: ctx.iid,
      player_id: ctx.pid,
      canonical_name: name,
      name_normalized: normalized,
      aliases,
      role: shouldSetText(delta.role) ? delta.role.trim() : undefined,
      appearance: shouldSetText(delta.appearance) ? delta.appearance.trim() : undefined,
      persona: shouldSetText(delta.persona) ? delta.persona.trim() : undefined,
      immutable_facts: uniqKeepRecent(delta.immutable_facts || [], IMMUTABLE_STORE_MAX),
      mutable_state: uniqKeepRecent(delta.mutable_state || [], MUTABLE_STATE_MAX),
      disposition_to_player: shouldSetText(delta.disposition_to_player) ? delta.disposition_to_player.trim() : '',
      hidden_thought: shouldSetText(delta.hidden_thought) ? delta.hidden_thought.trim() : '',
      relationship: hasRelationshipDeltas(delta.relationship_deltas)
        ? applyRelationshipDeltas(undefined, delta.relationship_deltas)
        : undefined,
      // Only ever the FIRST protagonist claim can mint the canonical card.
      is_protagonist: delta.is_protagonist === true && !state.protagonist,
      first_seen_sequence: sequence,
      last_seen_sequence: sequence,
      mention_count: 1,
      created_at: ctx.now,
      updated_at: ctx.now,
    }
    state.created.add(doc)
    state.byName.set(doc.name_normalized, doc)
    for (const a of doc.aliases) state.byName.set(normalizeName(a), doc)
    if (doc.is_protagonist) state.protagonist = doc
    return
  }

  // Merge into the existing card (mutate in place).
  target.aliases = uniqStrings([...(target.aliases || []), ...aliases], 20)
  target.immutable_facts = uniqKeepRecent(
    [...(target.immutable_facts || []), ...(delta.immutable_facts || [])],
    IMMUTABLE_STORE_MAX,
  )
  target.mutable_state = reconcileMutableState(
    target.mutable_state || [],
    delta.retire_state || [],
    delta.mutable_state || [],
    MUTABLE_STATE_MAX,
  )
  target.last_seen_sequence = sequence
  target.updated_at = ctx.now
  if (!target.role && shouldSetText(delta.role)) target.role = delta.role.trim()
  if (!target.appearance && shouldSetText(delta.appearance)) target.appearance = delta.appearance.trim()
  if (!target.persona && shouldSetText(delta.persona)) target.persona = delta.persona.trim()
  if (shouldSetText(delta.disposition_to_player)) target.disposition_to_player = delta.disposition_to_player.trim()
  if (shouldSetText(delta.hidden_thought)) target.hidden_thought = delta.hidden_thought.trim()
  if (hasRelationshipDeltas(delta.relationship_deltas)) {
    target.relationship = applyRelationshipDeltas(target.relationship, delta.relationship_deltas)
  }
  // Explicit rename/correction: the extractor may resolve a newly supplied name
  // to an existing card ("Mira" resolved to old "Mara"). Promote the new proper
  // name to canonical while retaining the old canonical as an alias, so rewind's
  // ledger replay does not re-mint the stale name.
  if (
    !target.is_protagonist &&
    shouldSetText(delta.resolved_name) &&
    shouldSetText(delta.name) &&
    normalizeName(delta.resolved_name) === normalizeName(target.canonical_name) &&
    normalizeName(delta.name) !== normalizeName(target.canonical_name)
  ) {
    const oldName = target.canonical_name
    target.canonical_name = delta.name.trim().slice(0, 120)
    target.name_normalized = normalizeName(target.canonical_name)
    target.aliases = uniqStrings([oldName, ...(target.aliases || []), ...aliases], 20)
  }
  // Sticky protagonist promote — only while NO canonical protagonist exists
  // (promoting a second card would split one person into two).
  if (delta.is_protagonist === true && !target.is_protagonist && !state.protagonist) {
    target.is_protagonist = true
    state.protagonist = target
  }
  target.mention_count = (target.mention_count || 0) + 1
  // Newly-learned referents resolve to this card for the rest of the fold.
  state.byName.set(target.name_normalized, target)
  for (const a of target.aliases) state.byName.set(normalizeName(a), target)
  if (!state.created.has(target)) state.dirty.add(target)
}

/**
 * Fold a sequence of delta batches into `existing`, then persist: insert the
 * new cards (one bulk write) and update only the changed existing ones. One DB
 * read of the existing cards + one insertMany + a handful of updates, no matter
 * how many turns are folded — so a deep rewind costs the same as a shallow one.
 */
async function foldAndPersist(
  iid: ObjectId,
  pid: ObjectId,
  existing: CharacterProfileDoc[],
  batches: Array<{ sequence: number; deltas: CharacterCodexDelta[] }>,
): Promise<void> {
  const now = new Date()
  const state = newFoldState(existing)
  for (const batch of batches) {
    for (const delta of batch.deltas) foldDelta(state, delta, batch.sequence, { iid, pid, now })
  }
  if (state.created.size > 0) {
    try {
      await characters().insertMany([...state.created], { ordered: false })
    } catch {
      // Concurrent duplicate on the (instance_id, name_normalized) unique index:
      // the existing row wins. The codex extractor re-emits active characters
      // every turn, so a dropped first-mention self-heals on the next turn.
    }
  }
  for (const card of state.dirty) {
    const { _id, ...rest } = card
    await characters().updateOne({ _id }, { $set: rest })
  }
}

export const characterCodexService = {
  async listForInstance(instanceId: string, limit: number = 30): Promise<CharacterProfileDoc[]> {
    return characters()
      .find({ instance_id: parseObjectId(instanceId) })
      .sort({ is_protagonist: -1, mention_count: -1, updated_at: -1 })
      .limit(limit)
      .toArray()
  },

  /**
   * Characters DIRECTLY NAMED in `text` (the player's turn) that aren't already
   * in `excludeIds`. The codex prompt is recency-ranked, so a long-dormant
   * character decays out of the injected set — yet the player can still ask
   * about them by name. Pinning their canonical card back in means asking about
   * an old character surfaces their structured canon (facts, current state,
   * relationship meters), not just loose retrieved memories. Whole-word match on
   * normalized names/aliases (≥3 chars) so "Vex" hits but "vexed" doesn't.
   */
  async findMentionedCharacters(
    instanceId: string,
    text: string,
    excludeIds: string[],
    limit = 5,
  ): Promise<CharacterProfileDoc[]> {
    const clean = (text || '').trim()
    if (clean.length < 3) return []
    const iid = parseObjectId(instanceId)
    const exclude = new Set(excludeIds.map(String))

    // Identity-only projection of the whole cast (cheap) to scan for mentions;
    // full cards are fetched only for the handful that actually match.
    const roster = await characters()
      .find(
        { instance_id: iid, is_protagonist: { $ne: true } },
        { projection: { canonical_name: 1, name_normalized: 1, aliases: 1 } },
      )
      .toArray()
    if (roster.length === 0) return []

    const haystack = ` ${normalizeName(clean)} `
    const matchedIds: ObjectId[] = []
    for (const c of roster) {
      if (exclude.has(idString(c._id))) continue
      const names = uniqStrings([c.canonical_name, ...(c.aliases || [])], 20)
        .map(normalizeName)
        .filter((n) => n.length >= 3)
      if (names.some((n) => haystack.includes(` ${n} `))) {
        matchedIds.push(c._id)
        if (matchedIds.length >= limit) break
      }
    }
    if (matchedIds.length === 0) return []
    return characters().find({ _id: { $in: matchedIds } }).toArray()
  },

  /**
   * Deterministically create the locked protagonist card for an instance if one
   * doesn't already exist. Used for sentient worlds (the AI persona, from the
   * template) and GM worlds (the player's own character, from onboarding).
   * `isPlayer` distinguishes the GM player-protagonist for roster rendering.
   */
  async seedProtagonist(params: {
    instanceId: string
    playerId: string
    name: string
    persona?: string
    appearance?: string
    isPlayer?: boolean
    sequence?: number
    /** Restore known referents (e.g. role epithets) so identity resolution
     *  survives a rewind — see the protagonist/player drift guard. */
    aliases?: string[]
  }): Promise<CharacterProfileDoc | null> {
    const { instanceId, playerId, name, persona, appearance, isPlayer, sequence = 0, aliases } = params
    const trimmed = (name || '').trim()
    if (!trimmed) return null

    const iid = parseObjectId(instanceId)
    const pid = parseObjectId(playerId)

    const existing = await characters().findOne({ instance_id: iid, is_protagonist: true })
    if (existing) return existing

    const now = new Date()
    const doc: CharacterProfileDoc = {
      _id: new ObjectId(),
      instance_id: iid,
      player_id: pid,
      canonical_name: trimmed.slice(0, 120),
      name_normalized: normalizeName(trimmed),
      // Drop any alias equal to the canonical name; keep the rest as referents.
      aliases: uniqStrings(aliases || [], 20).filter(
        (a) => normalizeName(a) !== normalizeName(trimmed),
      ),
      role: isPlayer ? 'protagonist (the player)' : 'protagonist',
      appearance: shouldSetText(appearance) ? appearance.trim() : undefined,
      persona: shouldSetText(persona) ? persona.trim() : undefined,
      immutable_facts: [],
      mutable_state: [],
      disposition_to_player: '',
      hidden_thought: '',
      is_protagonist: true,
      first_seen_sequence: sequence,
      last_seen_sequence: sequence,
      mention_count: 1,
      created_at: now,
      updated_at: now,
    }
    try {
      await characters().insertOne(doc)
      return doc
    } catch {
      return characters().findOne({ instance_id: iid, name_normalized: doc.name_normalized })
    }
  },

  async applyDeltas(params: {
    instanceId: string
    playerId: string
    sequence: number
    deltas: CharacterCodexDelta[]
  }): Promise<CharacterProfileDoc[]> {
    const { instanceId, playerId, sequence, deltas } = params
    if (!deltas.length) {
      return this.listForInstance(instanceId, 30)
    }

    const iid = parseObjectId(instanceId)
    const pid = parseObjectId(playerId)

    const existing = await characters().find({ instance_id: iid }).toArray()
    await foldAndPersist(iid, pid, existing, [{ sequence, deltas }])
    return this.listForInstance(instanceId, 30)
  },

  /**
   * Rebuild the entire emergent codex as an exact projection of the ledger by
   * folding the supplied per-turn deltas (oldest first) over the current cards.
   * Used by rewind: after the codex is cleared and the protagonist re-seeded,
   * the surviving turns' stored `codex_deltas` are replayed deterministically —
   * the whole replay folds in memory and persists with a single bulk insert
   * (+ a couple of updates), so cost is independent of how deep the rewind is.
   */
  async rebuildCodexFromLedger(params: {
    instanceId: string
    playerId: string
    batches: Array<{ sequence: number; deltas: CharacterCodexDelta[] }>
  }): Promise<void> {
    const { instanceId, playerId, batches } = params
    if (!batches.length) return
    const iid = parseObjectId(instanceId)
    const pid = parseObjectId(playerId)
    // Existing = the just-reseeded protagonist, so protagonist deltas merge into
    // it (and rebuild its facts/state) rather than minting a duplicate.
    const existing = await characters().find({ instance_id: iid }).toArray()
    await foldAndPersist(iid, pid, existing, batches)
  },

  /** Overwrite a character's immutable_facts (used by async compaction to
   *  distill an overgrown list back down without losing identity/history). */
  async setImmutableFacts(characterId: string, facts: string[]): Promise<void> {
    await characters().updateOne(
      { _id: parseObjectId(characterId) },
      { $set: { immutable_facts: facts, updated_at: new Date() } },
    )
  },

  /**
   * Player-driven edit of a character/protagonist card. Returns the updated doc
   * plus the facts the edit REMOVED — those are handed to memory supersession so
   * stale memories about the old facts can't resurface and fight the edit.
   */
  async editCharacter(params: {
    playerId: string
    characterId: string
    updates: {
      canonical_name?: string
      role?: string
      appearance?: string
      persona?: string
      immutable_facts?: string[]
      mutable_state?: string[]
      disposition_to_player?: string
      hidden_thought?: string
    }
  }): Promise<{ character: CharacterProfileDoc; instanceId: string; retiredFacts: string[] }> {
    const { playerId, characterId, updates } = params
    const cid = parseObjectId(characterId)
    const pid = parseObjectId(playerId)

    const target = await characters().findOne({ _id: cid, player_id: pid })
    if (!target) throw new HttpError(404, 'Character not found')

    // Protagonist edit policy: in a SENTIENT world (incl. character worlds, which
    // are sentient) the protagonist is the creator's main character — an authored
    // creative choice players must not rewrite. In a GM (non-sentient) world the
    // protagonist IS the player's own character, so editing is allowed. Side
    // characters are always editable.
    if (target.is_protagonist) {
      const instance = await mongoColl.worldInstances().findOne({ _id: target.instance_id })
      const template = instance
        ? await mongoColl.worldTemplates().findOne({ _id: instance.template_id })
        : null
      if (template?.is_sentient) {
        throw new HttpError(
          403,
          'The main character is set by the creator and cannot be edited.',
        )
      }
    }

    const setFields: Record<string, unknown> = { updated_at: new Date() }
    const retiredFacts: string[] = []

    if (shouldSetText(updates.canonical_name) && updates.canonical_name.trim() !== target.canonical_name) {
      const newName = updates.canonical_name.trim().slice(0, 120)
      setFields.canonical_name = newName
      setFields.name_normalized = normalizeName(newName)
      // Preserve the old name as an alias so existing references still resolve.
      setFields.aliases = uniqStrings([target.canonical_name, ...(target.aliases || [])], 20)
    }
    if (updates.role !== undefined) setFields.role = updates.role.trim() || undefined
    if (updates.appearance !== undefined) setFields.appearance = updates.appearance.trim() || undefined
    if (updates.persona !== undefined) setFields.persona = updates.persona.trim() || undefined
    if (updates.disposition_to_player !== undefined) {
      setFields.disposition_to_player = updates.disposition_to_player.trim()
    }
    if (updates.hidden_thought !== undefined) {
      setFields.hidden_thought = updates.hidden_thought.trim()
    }

    if (Array.isArray(updates.immutable_facts)) {
      const next = uniqKeepRecent(
        updates.immutable_facts.map((s) => String(s).trim()).filter(Boolean),
        IMMUTABLE_STORE_MAX,
      )
      const keep = new Set(next.map((f) => f.toLowerCase()))
      for (const old of target.immutable_facts || []) {
        if (!keep.has(old.toLowerCase())) retiredFacts.push(old)
      }
      setFields.immutable_facts = next
    }
    if (Array.isArray(updates.mutable_state)) {
      const next = uniqKeepRecent(
        updates.mutable_state.map((s) => String(s).trim()).filter(Boolean),
        MUTABLE_STATE_MAX,
      )
      const keep = new Set(next.map((f) => f.toLowerCase()))
      for (const old of target.mutable_state || []) {
        if (!keep.has(old.toLowerCase())) retiredFacts.push(old)
      }
      setFields.mutable_state = next
    }

    await characters().updateOne({ _id: cid }, { $set: setFields })
    const character = (await characters().findOne({ _id: cid }))!
    return { character, instanceId: idString(target.instance_id), retiredFacts }
  },

  /**
   * Relationship Ledger (Phase 10 product surface): every non-protagonist in
   * the cast, their standing toward the player (meters + disposition), and the
   * narrative moments that shifted the bond (free-text `relationship` edges
   * between the player/protagonist entity and the character). Read-only.
   * `hidden_thought` is intentionally NOT surfaced — it stays the model's
   * private knowledge so the ledger reflects what the player can observe.
   */
  async listRelationships(instanceId: string, playerId: string) {
    const iid = parseObjectId(instanceId)
    const pid = parseObjectId(playerId)
    const instance = await mongoColl.worldInstances().findOne({ _id: iid, player_id: pid })
    if (!instance) throw new HttpError(404, 'Instance not found')

    const template = await mongoColl.worldTemplates().findOne(
      { _id: instance.template_id },
      { projection: { kind: 1, is_sentient: 1 } },
    )
    const includeProtagonistBond = template?.kind === 'character' || template?.is_sentient === true
    const cardFilter = includeProtagonistBond
      ? { instance_id: iid }
      : { instance_id: iid, is_protagonist: { $ne: true } }

    const cards = await characters()
      .find(cardFilter)
      .sort({ mention_count: -1, updated_at: -1 })
      .limit(40)
      .toArray()

    // The "you" side of the bond. In sentient/character worlds the protagonist
    // card is the companion, so do not also treat the protagonist entity as
    // "self" or its moments can collapse onto itself. GM worlds keep the old
    // protagonist fallback because the player is the protagonist there.
    const selfTypes: Array<'player' | 'protagonist'> = includeProtagonistBond
      ? ['player']
      : ['player', 'protagonist']
    const selfEntities = await mongoColl
      .entities()
      .find({ instance_id: iid, type: { $in: selfTypes } })
      .project({ _id: 1 })
      .toArray()
    const selfIds = selfEntities.map((e) => e._id as ObjectId)

    const charEntityIds = cards
      .map((c) => c.entity_id)
      .filter((id): id is ObjectId => !!id)

    // Narrative bond moments — relationship-type edges between the player and
    // each character, newest first.
    const edges =
      charEntityIds.length && selfIds.length
        ? await mongoColl
            .entityEdges()
            .find({
              instance_id: iid,
              type: 'relationship',
              status: 'active',
              $or: [
                { source_entity_id: { $in: charEntityIds }, target_entity_id: { $in: selfIds } },
                { source_entity_id: { $in: selfIds }, target_entity_id: { $in: charEntityIds } },
              ],
            })
            .sort({ last_event_sequence: -1 })
            .toArray()
        : []

    const momentsByChar = new Map<string, { label: string; sequence: number }[]>()
    const charIdSet = new Set(charEntityIds.map((id) => idString(id)))
    for (const edge of edges) {
      if (!edge.label) continue
      const srcKey = idString(edge.source_entity_id)
      const tgtKey = idString(edge.target_entity_id)
      const charKey = charIdSet.has(srcKey) ? srcKey : tgtKey
      const list = momentsByChar.get(charKey) || []
      if (list.length < 5) {
        list.push({ label: edge.label, sequence: edge.last_event_sequence })
        momentsByChar.set(charKey, list)
      }
    }

    return {
      characters: cards.map((c) => {
        const m = c.relationship as RelationshipMeters | undefined
        return {
          id: idString(c._id),
          name: c.canonical_name,
          role: c.role || null,
          disposition: c.disposition_to_player || null,
          meters: m
            ? { trust: m.trust, affection: m.affection, fear: m.fear, rivalry: m.rivalry }
            : null,
          mention_count: c.mention_count,
          moments: c.entity_id ? momentsByChar.get(idString(c.entity_id)) || [] : [],
        }
      }),
    }
  },

  /**
   * "What this character remembers about you" (Phase 10): the memories this
   * character is part of, found via the entity subject/object links from
   * Phase 3. Falls back to matching the canonical name against the string
   * `subjects`/`objects` for pre-graph rows that were never entity-resolved.
   * Read-only; ranked by importance then recency.
   */
  async characterMemories(instanceId: string, playerId: string, characterId: string) {
    const iid = parseObjectId(instanceId)
    const pid = parseObjectId(playerId)
    const card = await characters().findOne({
      _id: parseObjectId(characterId),
      instance_id: iid,
    })
    if (!card) throw new HttpError(404, 'Character not found')

    const ownsInstance = await mongoColl
      .worldInstances()
      .findOne({ _id: iid, player_id: pid }, { projection: { _id: 1 } })
    if (!ownsInstance) throw new HttpError(404, 'Instance not found')

    const or: Record<string, unknown>[] = []
    if (card.entity_id) {
      or.push({ subject_entity_ids: card.entity_id })
      or.push({ object_entity_ids: card.entity_id })
    }
    // Back-compat for memories that predate entity resolution.
    or.push({ subjects: card.canonical_name })
    or.push({ objects: card.canonical_name })

    const mems = await mongoColl
      .memories()
      .find({ instance_id: iid, is_archived: false, $or: or })
      .sort({ importance: -1, updated_at: -1 })
      .limit(50)
      .toArray()

    return {
      character: {
        id: idString(card._id),
        name: card.canonical_name,
        role: card.role || null,
      },
      memories: mems.map((m) => ({
        id: idString(m._id),
        text: m.text,
        type: m.type,
        importance: m.importance,
        emotional_valence: m.emotional_valence || null,
        relationship_delta: m.relationship_delta || null,
        unresolved_thread: m.unresolved_thread === true,
        time_anchor: m.time_anchor || null,
      })),
    }
  },
}
