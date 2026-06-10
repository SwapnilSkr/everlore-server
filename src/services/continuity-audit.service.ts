import { mongoColl } from '../config/mongo'
import { parseObjectId, idString } from '../utils/mongo-id'
import { HttpError } from '../utils/http-error'

type CheckStatus = 'ok' | 'warn' | 'fail'

interface AuditCheck {
  name: string
  status: CheckStatus
  detail: string
  count?: number
  samples?: string[]
}

/**
 * Continuity audit (Phase 9): a read-only cross-projection consistency check.
 * The event ledger is the source of truth; every other store (codex, entities,
 * edges, memories, scene/chapter/arc summaries, time/location cursors) is a
 * projection of it. This compares them and flags drift — the kind that rewind,
 * edits, or a half-finished rebuild can leave behind. Purely diagnostic; it
 * never mutates. Reusable by an admin endpoint now and a background job later.
 */
export const continuityAuditService = {
  async audit(instanceId: string) {
    const iid = parseObjectId(instanceId)
    const instance = await mongoColl.worldInstances().findOne({ _id: iid })
    if (!instance) throw new HttpError(404, 'Instance not found')

    const [events, characters, entities, edges, scenes, chapters, arcs, memCount] =
      await Promise.all([
        mongoColl.events().find({ instance_id: iid }, { projection: { sequence: 1, type: 1 } }).sort({ sequence: 1 }).toArray(),
        mongoColl.characters().find({ instance_id: iid }).toArray(),
        mongoColl.entities().find({ instance_id: iid }).toArray(),
        mongoColl.entityEdges().find({ instance_id: iid }, { projection: { source_entity_id: 1, target_entity_id: 1, status: 1 } }).toArray(),
        mongoColl.sceneSummaries().find({ instance_id: iid }, { projection: { event_range: 1, status: 1 } }).toArray(),
        mongoColl.chapterSummaries().find({ instance_id: iid }, { projection: { event_range: 1, status: 1 } }).toArray(),
        mongoColl.arcSummaries().find({ instance_id: iid }, { projection: { event_range: 1, status: 1 } }).toArray(),
        mongoColl.memories().countDocuments({ instance_id: iid }),
      ])

    const maxSeq = events.length ? events[events.length - 1].sequence : 0
    const entityIdSet = new Set(entities.map((e) => idString(e._id)))
    const checks: AuditCheck[] = []

    // 1. Event sequence integrity — strictly increasing, contiguous, no dups.
    {
      const dups: number[] = []
      const gaps: string[] = []
      for (let i = 1; i < events.length; i++) {
        const prev = events[i - 1].sequence
        const cur = events[i].sequence
        if (cur === prev) dups.push(cur)
        else if (cur !== prev + 1) gaps.push(`${prev}->${cur}`)
      }
      checks.push(
        dups.length || gaps.length
          ? { name: 'event_sequence_integrity', status: 'fail', detail: `Sequence anomalies: ${dups.length} duplicate(s), ${gaps.length} gap(s).`, count: dups.length + gaps.length, samples: [...dups.map(String), ...gaps].slice(0, 8) }
          : { name: 'event_sequence_integrity', status: 'ok', detail: `${events.length} events, sequences contiguous.` },
      )
    }

    // 2. Single-protagonist invariant.
    {
      const protags = characters.filter((c) => c.is_protagonist)
      checks.push(
        protags.length === 1
          ? { name: 'single_protagonist', status: 'ok', detail: `Exactly one protagonist card (${protags[0].canonical_name}).` }
          : protags.length === 0
            ? { name: 'single_protagonist', status: events.length ? 'warn' : 'ok', detail: events.length ? 'No protagonist card despite existing events.' : 'No protagonist yet (fresh instance).' }
            : { name: 'single_protagonist', status: 'fail', detail: `${protags.length} protagonist cards — the player has been split.`, count: protags.length, samples: protags.map((p) => p.canonical_name).slice(0, 8) },
      )
    }

    // 3. Codex ↔ entity 1:1 linkage.
    {
      const danglingCardLinks = characters.filter((c) => c.entity_id && !entityIdSet.has(idString(c.entity_id)))
      const unlinkedCards = characters.filter((c) => !c.entity_id)
      const charEntityIds = new Set(characters.filter((c) => c.entity_id).map((c) => idString(c.entity_id!)))
      const danglingEntityLinks = entities.filter(
        (e) => e.character_id && !characters.some((c) => idString(c._id) === idString(e.character_id!)),
      )
      if (danglingCardLinks.length || danglingEntityLinks.length) {
        checks.push({ name: 'codex_entity_linkage', status: 'fail', detail: `${danglingCardLinks.length} card(s) point at a missing entity; ${danglingEntityLinks.length} entity link(s) point at a missing card.`, count: danglingCardLinks.length + danglingEntityLinks.length, samples: danglingCardLinks.map((c) => c.canonical_name).slice(0, 8) })
      } else if (unlinkedCards.length) {
        checks.push({ name: 'codex_entity_linkage', status: 'warn', detail: `${unlinkedCards.length} card(s) not yet linked to an entity (lazy backfill pending).`, count: unlinkedCards.length, samples: unlinkedCards.map((c) => c.canonical_name).slice(0, 8) })
      } else {
        checks.push({ name: 'codex_entity_linkage', status: 'ok', detail: `${charEntityIds.size} card(s) linked 1:1 to entities.` })
      }
    }

    // 4. Memory → entity references resolve.
    {
      const mems = await mongoColl.memories()
        .find({ instance_id: iid, is_archived: false }, { projection: { subject_entity_ids: 1, object_entity_ids: 1 } })
        .toArray()
      let dangling = 0
      const samples: string[] = []
      for (const m of mems) {
        const refs = [...(m.subject_entity_ids || []), ...(m.object_entity_ids || [])]
        for (const ref of refs) {
          if (!entityIdSet.has(idString(ref))) {
            dangling++
            if (samples.length < 8) samples.push(`mem ${idString(m._id)} → ${idString(ref)}`)
          }
        }
      }
      checks.push(
        dangling === 0
          ? { name: 'memory_entity_refs', status: 'ok', detail: `${mems.length} active memories; all entity refs resolve.` }
          : { name: 'memory_entity_refs', status: 'fail', detail: `${dangling} memory entity reference(s) point at a missing entity.`, count: dangling, samples },
      )
    }

    // 5. Entity edges reference existing entities.
    {
      const dangling = edges.filter(
        (e) => !entityIdSet.has(idString(e.source_entity_id)) || !entityIdSet.has(idString(e.target_entity_id)),
      )
      checks.push(
        dangling.length === 0
          ? { name: 'entity_edge_refs', status: 'ok', detail: `${edges.length} edges; all endpoints resolve.` }
          : { name: 'entity_edge_refs', status: 'fail', detail: `${dangling.length} edge(s) reference a missing entity.`, count: dangling.length },
      )
    }

    // 6. Summary bounds + lingering staleness (scenes, chapters, arcs).
    {
      type SummaryRow = { event_range?: { start_sequence: number; end_sequence: number }; status?: string }
      const tiers: Array<[string, SummaryRow[]]> = [
        ['scene', scenes as SummaryRow[]],
        ['chapter', chapters as SummaryRow[]],
        ['arc', arcs as SummaryRow[]],
      ]
      let pastEnd = 0
      let stale = 0
      const samples: string[] = []
      for (const [tier, rows] of tiers) {
        for (const r of rows) {
          if (r.event_range && r.event_range.end_sequence > maxSeq) {
            pastEnd++
            if (samples.length < 8) samples.push(`${tier} ${r.event_range.start_sequence}-${r.event_range.end_sequence} > max ${maxSeq}`)
          }
          if (r.status === 'stale') stale++
        }
      }
      if (pastEnd > 0) {
        checks.push({ name: 'summary_bounds', status: 'fail', detail: `${pastEnd} summary range(s) extend past the last event (seq ${maxSeq}) — rewind cleanup may have missed them.`, count: pastEnd, samples })
      } else if (stale > 0) {
        checks.push({ name: 'summary_bounds', status: 'warn', detail: `${stale} stale summary/summaries awaiting rebuild (transient if the queue is healthy).`, count: stale })
      } else {
        checks.push({ name: 'summary_bounds', status: 'ok', detail: `${scenes.length} scene / ${chapters.length} chapter / ${arcs.length} arc summaries, all within bounds.` })
      }
    }

    // 7. Story-time cursor sanity.
    {
      const cursorSeq = instance.current_time_anchor?.sequence
      checks.push(
        typeof cursorSeq === 'number' && cursorSeq > maxSeq
          ? { name: 'time_cursor', status: 'fail', detail: `Story-time cursor at seq ${cursorSeq} but the last event is ${maxSeq}.` }
          : { name: 'time_cursor', status: 'ok', detail: cursorSeq != null ? `Cursor at seq ${cursorSeq} (≤ ${maxSeq}).` : 'No story-time cursor set.' },
      )
    }

    // 8. Location cursor points at a real entity.
    {
      const locId = instance.current_location?.entity_id
      checks.push(
        locId && !entityIdSet.has(idString(locId))
          ? { name: 'location_cursor', status: 'warn', detail: `Current location "${instance.current_location?.name}" points at a missing entity.` }
          : { name: 'location_cursor', status: 'ok', detail: locId ? `Current place: ${instance.current_location?.name}.` : 'No location cursor set.' },
      )
    }

    const summary = {
      ok: checks.filter((c) => c.status === 'ok').length,
      warn: checks.filter((c) => c.status === 'warn').length,
      fail: checks.filter((c) => c.status === 'fail').length,
    }

    return {
      instanceId,
      generatedAt: new Date().toISOString(),
      maxSequence: maxSeq,
      healthy: summary.fail === 0,
      totals: {
        events: events.length,
        memories: memCount,
        characters: characters.length,
        entities: entities.length,
        edges: edges.length,
        sceneSummaries: scenes.length,
        chapterSummaries: chapters.length,
        arcSummaries: arcs.length,
      },
      summary,
      checks,
    }
  },
}
