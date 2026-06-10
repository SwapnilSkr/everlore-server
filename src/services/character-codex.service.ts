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

export const characterCodexService = {
  async listForInstance(instanceId: string, limit: number = 30): Promise<CharacterProfileDoc[]> {
    return characters()
      .find({ instance_id: parseObjectId(instanceId) })
      .sort({ is_protagonist: -1, mention_count: -1, updated_at: -1 })
      .limit(limit)
      .toArray()
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
  }): Promise<CharacterProfileDoc | null> {
    const { instanceId, playerId, name, persona, appearance, isPlayer, sequence = 0 } = params
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
      aliases: [],
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
    const now = new Date()

    const existing = await characters().find({ instance_id: iid }).toArray()
    const byName = new Map<string, CharacterProfileDoc>()
    for (const c of existing) {
      byName.set(c.name_normalized, c)
      for (const a of c.aliases || []) byName.set(normalizeName(a), c)
    }
    // Single-protagonist invariant: at most one canonical main-character card
    // per instance, seeded deterministically. Extractor output must never be
    // able to mint a second one.
    let protagonist = existing.find((c) => c.is_protagonist)

    for (const delta of deltas) {
      if (!shouldSetText(delta.name)) continue

      const candidateNames = uniqStrings([
        delta.resolved_name || '',
        delta.name,
        ...(delta.aliases || []),
      ], 10).map(normalizeName)

      let target: CharacterProfileDoc | undefined
      for (const n of candidateNames) {
        if (!n) continue
        target = byName.get(n)
        if (target) break
      }

      // A NEW name claiming to be the protagonist is a referent of the
      // protagonist (a role title or epithet — "the neglected son"), never a
      // second person. Merge into the canonical card; the alias merge below
      // makes the resolution permanent, so the split can't recur.
      if (!target && delta.is_protagonist === true && protagonist) {
        target = protagonist
      }

      const aliases = buildAliasSet(delta)
      const name = (delta.resolved_name || delta.name).trim()
      const normalized = normalizeName(name)

      if (!target) {
        const doc: CharacterProfileDoc = {
          _id: new ObjectId(),
          instance_id: iid,
          player_id: pid,
          canonical_name: name,
          name_normalized: normalized,
          aliases,
          role: shouldSetText(delta.role) ? delta.role.trim() : undefined,
          appearance: shouldSetText(delta.appearance) ? delta.appearance.trim() : undefined,
          persona: shouldSetText(delta.persona) ? delta.persona.trim() : undefined,
          immutable_facts: uniqKeepRecent(delta.immutable_facts || [], IMMUTABLE_STORE_MAX),
          mutable_state: uniqKeepRecent(delta.mutable_state || [], MUTABLE_STATE_MAX),
          disposition_to_player: shouldSetText(delta.disposition_to_player)
            ? delta.disposition_to_player.trim()
            : '',
          hidden_thought: shouldSetText(delta.hidden_thought)
            ? delta.hidden_thought.trim()
            : '',
          relationship: hasRelationshipDeltas(delta.relationship_deltas)
            ? applyRelationshipDeltas(undefined, delta.relationship_deltas)
            : undefined,
          // Only ever the FIRST protagonist claim can mint the canonical card.
          is_protagonist: delta.is_protagonist === true && !protagonist,
          first_seen_sequence: sequence,
          last_seen_sequence: sequence,
          mention_count: 1,
          created_at: now,
          updated_at: now,
        }
        try {
          await characters().insertOne(doc)
          target = doc
          byName.set(doc.name_normalized, doc)
          for (const a of doc.aliases) byName.set(normalizeName(a), doc)
          if (doc.is_protagonist) protagonist = doc
        } catch {
          // Concurrent duplicate on unique index: fallback to existing row.
          target = await characters().findOne({ instance_id: iid, name_normalized: normalized }) || undefined
        }
      }

      if (!target) continue

      const mergedAliases = uniqStrings([...(target.aliases || []), ...aliases], 20)
      // Keep the most recent facts on overflow (never silently drop this turn's
      // new permanent facts); async compaction distills the list back down.
      const mergedImmutableFacts = uniqKeepRecent(
        [...(target.immutable_facts || []), ...(delta.immutable_facts || [])],
        IMMUTABLE_STORE_MAX,
      )
      const mergedMutableState = reconcileMutableState(
        target.mutable_state || [],
        delta.retire_state || [],
        delta.mutable_state || [],
        MUTABLE_STATE_MAX,
      )

      const setFields: Record<string, unknown> = {
        aliases: mergedAliases,
        immutable_facts: mergedImmutableFacts,
        mutable_state: mergedMutableState,
        last_seen_sequence: sequence,
        updated_at: now,
      }

      if (!target.role && shouldSetText(delta.role)) setFields.role = delta.role.trim()
      if (!target.appearance && shouldSetText(delta.appearance)) setFields.appearance = delta.appearance.trim()
      if (!target.persona && shouldSetText(delta.persona)) setFields.persona = delta.persona.trim()
      if (shouldSetText(delta.disposition_to_player)) {
        setFields.disposition_to_player = delta.disposition_to_player.trim()
      }
      if (shouldSetText(delta.hidden_thought)) {
        setFields.hidden_thought = delta.hidden_thought.trim()
      }
      if (hasRelationshipDeltas(delta.relationship_deltas)) {
        setFields.relationship = applyRelationshipDeltas(
          target.relationship,
          delta.relationship_deltas,
        )
      }
      // Protagonist is a sticky flag: once a turn identifies this card as the
      // main persona, keep it set even if a later turn omits the hint — but
      // only while NO canonical protagonist exists. Promoting a second card
      // would split one person into two (the catastrophic-drift case).
      if (delta.is_protagonist === true && !target.is_protagonist && !protagonist) {
        setFields.is_protagonist = true
        protagonist = target
      }

      await characters().updateOne(
        { _id: target._id },
        {
          $set: setFields,
          $inc: { mention_count: 1 },
        },
      )
      // Newly-learned referents must resolve to this card for the REST of this
      // batch too, not only on the next turn.
      for (const a of mergedAliases) byName.set(normalizeName(a), target)
    }

    return this.listForInstance(instanceId, 30)
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
}
