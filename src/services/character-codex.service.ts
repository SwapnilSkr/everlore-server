import { ObjectId } from 'mongodb'
import { mongoColl } from '../config/mongo'
import type { CharacterProfileDoc } from '../models/character-profile.model'
import { parseObjectId } from '../utils/mongo-id'

const characters = () => mongoColl.characters()

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
  return uniqStrings([...kept, ...(add || [])], max)
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
          immutable_facts: uniqStrings(delta.immutable_facts || [], 20),
          mutable_state: uniqStrings(delta.mutable_state || [], 12),
          disposition_to_player: shouldSetText(delta.disposition_to_player)
            ? delta.disposition_to_player.trim()
            : '',
          hidden_thought: shouldSetText(delta.hidden_thought)
            ? delta.hidden_thought.trim()
            : '',
          is_protagonist: delta.is_protagonist === true,
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
        } catch {
          // Concurrent duplicate on unique index: fallback to existing row.
          target = await characters().findOne({ instance_id: iid, name_normalized: normalized }) || undefined
        }
      }

      if (!target) continue

      const mergedAliases = uniqStrings([...(target.aliases || []), ...aliases], 20)
      const mergedImmutableFacts = uniqStrings(
        [...(target.immutable_facts || []), ...(delta.immutable_facts || [])],
        20,
      )
      const mergedMutableState = reconcileMutableState(
        target.mutable_state || [],
        delta.retire_state || [],
        delta.mutable_state || [],
        12,
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
      // Protagonist is a sticky flag: once a turn identifies this card as the
      // main persona, keep it set even if a later turn omits the hint.
      if (delta.is_protagonist === true && !target.is_protagonist) {
        setFields.is_protagonist = true
      }

      await characters().updateOne(
        { _id: target._id },
        {
          $set: setFields,
          $inc: { mention_count: 1 },
        },
      )
    }

    return this.listForInstance(instanceId, 30)
  },
}
