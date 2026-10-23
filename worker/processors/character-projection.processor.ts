import { ObjectId } from 'mongodb'
import { Job } from 'bullmq'
import { mongoColl } from '../../src/config/mongo'
import { parseObjectId, idString } from '../../src/utils/mongo-id'
import { liveInstanceExists } from '../../src/utils/live-instance'
import { instanceService } from '../../src/services/instance.service'
import { characterCodexService, type RelationAssertion } from '../../src/services/character-codex.service'
import { entityGraphService, normalizeEntityName } from '../../src/services/entity-graph.service'
import { kinshipGraphService } from '../../src/services/kinship-graph.service'
import { relationCandidateService } from '../../src/services/relation-candidate.service'
import { memorySupersessionService } from '../../src/services/memory-supersession.service'
import { parsePlayerInput } from '../../src/utils/player-input-parser'
import { surfaceToKind } from '../../src/utils/kinship-ontology'
import { extractKinshipAssertions, mergeRelationAssertions } from '../lib/kinship-pattern-extractor'
import { extractLifecycleTransitions } from '../lib/kinship-transition-extractor'
import { detectNarratedRelationCandidates } from '../lib/relation-candidate-detector'
import { detectCanonRevisionCandidates } from '../lib/canon-revision-detector'
import { detectProjectionAnomalies } from '../lib/projection-anomaly-detector'
import { buildSignalLedger } from '../lib/signal-ledger'
import { compactImmutableFacts } from '../lib/codex-compactor'
import { extractCharacterCodexDeltas, extractCharacterCodexBatch, looksLikeUnnamedLabel } from '../lib/character-codex-extractor'
import { getRedisClient } from '../../src/config/redis'
import { CharacterProjectionTiming, withCharacterProjection } from '../lib/character-projection-lease'
import { recordAnomaly } from '../../src/utils/record-anomaly'
import { log } from '../../src/utils/logger'
import type { WorldEventDoc } from '../../src/models/world-event.model'
import type { CharacterProfileDoc } from '../../src/models/character-profile.model'

export { CHARACTER_PROJECTION_MAX_ATTEMPTS } from '../lib/character-projection-lease'

export async function characterProjectionProcessor(job: Job) {
  const result = await projectCharacterEvent(job.data as { instanceId: string; playerId: string; eventId: string })
  if ('skipped' in result && result.skipped === 'claimed_by_active_worker') {
    throw new Error('Character projection still claimed; retry after lease expiry')
  }
  return result
}

function normalizePersonaName(value: string): string {
  return (value || '').toLowerCase().replace(/[^a-z0-9\s'-]+/g, ' ').replace(/\s+/g, ' ').trim()
}

async function extractionInputs(instanceId: string, characterCodex: CharacterProfileDoc[], timing: CharacterProjectionTiming) {
  const instanceOid = parseObjectId(instanceId)
  const knownPlaces = await timing.step('known_locations_read', () => entityGraphService.listKnownLocations(instanceId, 30))
  // Repeated figures the entity/memory graph already corroborates may earn a
  // codex card on recurrence — off-screen, and named or not. This is
  // intentionally a small, proven set, not a free pass for every mention.
  //
  // Unnamed figures are held to a HIGHER bar than named ones. A name is a
  // signal a person matters, so a label carries none and must show its own
  // evidence: the story has to have recorded them DOING or RECEIVING
  // something (a memory naming them as subject or object) more than once,
  // not merely mentioned them in passing. So a rider the player duels across
  // three turns earns a card, while "the crowd" said three times does not.
  const promotableCandidates = (await timing.step('promotable_candidates_read', () => mongoColl
    .entities()
    .find(
      {
        instance_id: instanceOid,
        type: 'character',
        mention_count: { $gte: 3 },
        character_id: { $exists: false },
      },
      { projection: { _id: 1, canonical_name: 1 } },
    )
    .toArray())) as Array<{ _id: ObjectId; canonical_name?: string }>

  const unnamedIds = new Set(
    promotableCandidates
      .filter((e) => looksLikeUnnamedLabel(String(e.canonical_name || '')))
      .map((e) => idString(e._id)),
  )
  const unnamedCandidates = promotableCandidates.filter((e) => unnamedIds.has(idString(e._id)))
  // One scoped count for the unnamed ones only; the named path is unchanged
  // and costs nothing extra.
  const involvedEntityIds = new Set<string>()
  if (unnamedCandidates.length) {
    const ids = unnamedCandidates.map((e) => e._id)
    const involvementByEntity = new Map<string, number>()
    const memRefs = await timing.step('memory_involvement_read', () => mongoColl
      .memories()
      .find(
        {
          instance_id: instanceOid,
          $or: [{ subject_entity_ids: { $in: ids } }, { object_entity_ids: { $in: ids } }],
        },
        { projection: { subject_entity_ids: 1, object_entity_ids: 1 } },
      )
      .limit(200)
      .toArray())
    for (const m of memRefs) {
      for (const id of [...(m.subject_entity_ids || []), ...(m.object_entity_ids || [])]) {
        const key = idString(id)
        involvementByEntity.set(key, (involvementByEntity.get(key) || 0) + 1)
      }
    }
    for (const [key, count] of involvementByEntity) {
      if (count >= 2) involvedEntityIds.add(key)
    }
  }

  const promotableRecurringPeople = promotableCandidates
    .filter((e) =>
      unnamedIds.has(idString(e._id)) ? involvedEntityIds.has(idString(e._id)) : true,
    )
    .map((entity) => String(entity.canonical_name || '').trim())
    .filter(Boolean)
    .slice(0, 12)
  return { existing: characterCodex, knownLocations: knownPlaces, promotableRecurringPeople }
}

/** Generation and recovery run the identical per-turn tail, under one batch's
 * leases. Inputs and graph/canon writes always carry their OWN event sequence. */
export async function projectCharacterEvent(params: { instanceId: string; playerId: string; eventId: string }) {
  const { instanceId, playerId } = params
  const instanceOid = parseObjectId(instanceId)
  const timing = new CharacterProjectionTiming()
  if (!(await timing.step('instance_exists_read', () => liveInstanceExists(instanceOid)))) return { skipped: 'instance_deleted' }
  const loadSession = () => timing.step('session_read', () => instanceService.loadSession(instanceId, playerId))
  const readCards = () => timing.step('cards_read', () => mongoColl.characters().find({ instance_id: instanceOid }).toArray())
  const turnInputs = (event: WorldEventDoc) => ({ sequence: event.sequence,
    playerInput: event.data.player_input || (event.data.world_action ? event.data.codex_projection_context?.player_input || '' : ''),
    aiResponse: event.data.ai_response, presentCast: event.data.present_characters || [] })
  return withCharacterProjection(params, projectCharacterEvent, async (projectionEvent, assertOwned, timing, prepared) => {
    const event = projectionEvent
    const nextSequence = event.sequence
    const rawNarrative = event.data.ai_response
    const parsedPlayerInput = parsePlayerInput(turnInputs(event).playerInput)
    const confirmedWorldAction = event.data.world_action
    const session = await loadSession()
    const characterCodex = await readCards()
    const knownCardNames = new Set(characterCodex.flatMap((c) => [c.canonical_name, ...(c.aliases || [])].map(normalizeEntityName).filter(Boolean)))
    if (session.is_sentient) {
      for (const name of [session.persona_snapshot?.name, event.data.codex_projection_context?.player_self_name]) {
        if (name) knownCardNames.add(normalizeEntityName(name))
      }
    }
    const inputs = event.data.codex_deltas || prepared ? undefined : await extractionInputs(instanceId, characterCodex, timing)
    const deltas = event.data.codex_deltas ?? prepared ?? await timing.extract((onRaw) => extractCharacterCodexDeltas({
      onRaw, ...inputs!, ...turnInputs(event),
      seedPrompt: session.seed_prompt, isSentient: session.is_sentient,
      protagonistName: characterCodex.find((c) => c.is_protagonist)?.canonical_name || session.protagonist?.name,
      playerPersonaName: session.persona_snapshot?.name,
    }))
    // Sentient worlds: the player is the persona TALKING TO the world's main
    // character — they are not part of the cast. Drop any delta that would
    // card them, no matter what the extractor produced. The player's identity
    // is the UNION of: the authored persona name, the existing player entity's
    // canonical name + aliases (learned on prior turns), and any name the
    // player introduces for THEMSELVES THIS turn ("I'm Kael", "call me Alex").
    // The last one is the gap that minted Alex/Swapnil/Kael cards: sentient
    // worlds often start with no persona name, so the only signal that "Kael"
    // is the player is their own self-introduction — which must card nothing.
    if (session.is_sentient) {
      const playerNames = new Set<string>()
      const addName = (n: string | null | undefined) => {
        const norm = normalizePersonaName(n || '')
        if (norm) playerNames.add(norm)
      }
      addName(session.persona_snapshot?.name)
      let selfIntroName: string | null = null
      try {
        const playerEntity = await timing.step('player_identity_read', () => mongoColl
          .entities()
          .findOne({ instance_id: instanceOid, type: 'player' }, { projection: { canonical_name: 1, aliases: 1 } }))
        if (playerEntity) {
          // "The Player" / "player" are generic sentinels, not a real name a
          // card could collide with — skip them so they don't over-match.
          for (const n of [playerEntity.canonical_name, ...(playerEntity.aliases || [])]) {
            const norm = normalizePersonaName(n || '')
            if (norm && norm !== 'the player' && norm !== 'player') playerNames.add(norm)
          }
        }
        selfIntroName = event.data.codex_projection_context?.player_self_name || null
        if (selfIntroName) addName(selfIntroName)
      } catch (err) {
        console.warn('player self-name resolution skipped:', (err as Error).message)
      }

      if (playerNames.size > 0) {
        const refersToPlayer = (d: (typeof deltas)[number]) =>
          [d.name, d.resolved_name, ...(d.aliases || [])]
            .map((n) => normalizePersonaName(n || ''))
            .some((n) => n && playerNames.has(n))
        for (let i = deltas.length - 1; i >= 0; i--) {
          if (refersToPlayer(deltas[i])) deltas.splice(i, 1)
        }
      }

      // Persist a freshly-introduced player name onto the player entity so the
      // guard still catches it on later turns where the player doesn't restate
      // it (the extractor would otherwise re-mint the card the moment the main
      // character addresses them by name).
      if (selfIntroName) {
        const norm = normalizePersonaName(selfIntroName)
        if (norm && norm !== 'the player' && norm !== 'player') {
          // Finish this alias write before releasing the projection barrier,
          // so the next extraction sees the player's introduced identity.
          try {
            await timing.step('player_alias_write', () => mongoColl.entities().updateOne(
              { instance_id: instanceOid, type: 'player' },
              {
                $addToSet: { aliases: norm },
                $set: { updated_at: new Date() },
              },
            ))
          } catch (err) {
            console.warn('player self-name persist skipped:', (err as Error).message)
          }
        }
      }

    }

    // GM-world protagonist is the player's OWN character; relationship meters
    // toward the player are nonsense there (a character has no stance toward
    // themself). Enforce what the extractor prompt asks for. Sentient worlds
    // keep protagonist meters — the persona genuinely has a stance.
    if (!session.is_sentient) {
      for (const d of deltas) {
        if (d.is_protagonist) delete d.relationship_deltas
      }
    }

    // A reveal candidate must still surface if the smaller extraction model
    // returned no codex delta. In that case the existing roster is enough to
    // validate a proposal; no candidate can mint an identity by itself.
    await assertOwned()
    const codex = !projectionEvent.data.codex_deltas && deltas.length > 0
      ? await timing.step('apply_deltas', () => characterCodexService.applyDeltas({
          instanceId,
          playerId,
          sequence: nextSequence,
          deltas,
          // Post-stream only: the lasting-look evidence check reads the turn
          // prose here, never before or during the narrator stream.
          prose: rawNarrative,
        }))
      : characterCodex

    // Ledger the applied deltas on the event so the codex is an exact
    // rebuildable projection (rewind replays these — no stale facts).
    if (!projectionEvent.data.codex_deltas) {
      await timing.step('deltas_ledger_write', () => mongoColl.events().updateOne({ _id: event._id }, { $set: { 'data.codex_deltas': deltas } }))
    }

    // Structural kinship is too consequential to infer from narration. A line
    // such as "my sister in spirit" or a story-within-a-story must never create
    // a family edge. Only an explicit player-authored fact or correction can
    // establish/retcon one; narrator and character claims stay prose until the
    // player confirms them through an authored narration/correction.
    const deterministicAssertions = extractKinshipAssertions({
      corrections: parsedPlayerInput.corrections,
      narrationFacts: parsedPlayerInput.narrationFacts,
      claims: [],
      prose: undefined,
    })
    const explicitRelationship =
      confirmedWorldAction?.kind === 'relationship'
        ? (() => {
            const mapped = surfaceToKind(confirmedWorldAction.relation)
            if (!mapped) return []
            const source = confirmedWorldAction.correction
              ? ('player_correction' as const)
              : ('player_narration' as const)
            const assertions: RelationAssertion[] = [
              {
                from: confirmedWorldAction.character,
                to: 'player',
                kind: mapped.kind,
                label: confirmedWorldAction.relation,
                gender: mapped.gender,
                modifier: mapped.modifier,
                polarity: 'assert' as const,
                source,
              },
            ]
            // A correction must name what it replaces. Close that prior kind
            // first, preserving historical provenance. Sibling labels share one
            // structural kind, so "sister" → "brother" is a label correction on
            // the same edge and intentionally needs no sever.
            const replacesRelation = confirmedWorldAction.replacesRelation
            const replaced = replacesRelation ? surfaceToKind(replacesRelation) : null
            if (replaced && replaced.kind !== mapped.kind) {
              assertions.unshift({
                from: confirmedWorldAction.character,
                to: 'player',
                kind: replaced.kind,
                label: replacesRelation,
                gender: replaced.gender,
                modifier: replaced.modifier,
                polarity: 'sever' as const,
                source,
              })
            }
            return assertions
          })()
        : []
    const relationAssertions = mergeRelationAssertions([], [...deterministicAssertions, ...explicitRelationship])
    // Committed kinship edge count, hoisted for the FP/FN signal ledger below.
    let kinWritten = 0

    // Entity graph: keep card↔entity links 1:1 and project this turn's
    // relationship meters onto typed edges. Best-effort — graph failures
    // never break the codex pipeline.
    try {
      const entityMap = await timing.step('entity_graph_sync', () => entityGraphService.syncCodexEntities({
        instanceId,
        playerId,
        sequence: nextSequence,
        cards: codex,
      }))
      const touchedCards = codex.filter((c) => c.last_seen_sequence === nextSequence && c.relationship)
      if (touchedCards.length > 0) {
        await timing.step('relationship_sync', () => entityGraphService.syncRelationshipEdges({
          instanceId,
          playerId,
          sequence: nextSequence,
          eventId: event._id,
          cards: touchedCards,
          entitiesByCardName: entityMap,
          playerName: session.persona_snapshot?.name,
        }))
      }

      // Kinship graph: typed relation ties asserted this turn → graph edges
      // (extract → Stage-1 hygiene → Stage-2 epithet resolver → persist). Post
      // stream, off TTFT. Self anchor = protagonist card (GM) or player (sentient).
      // Narrator prose may suggest a literal family tie, but never establishes
      // one. Store a quarantined, evidence-backed review candidate instead.
      // This is intentionally after the stream and outside relationAssertions:
      // candidates affect neither canon nor the next prompt until the player
      // explicitly accepts one.
      try {
        const proposals = detectNarratedRelationCandidates(rawNarrative)
        if (proposals.length > 0) {
          const protagCard = codex.find((c) => c.is_protagonist)
          let playerEntityId: string | null = null
          if (!session.is_sentient && protagCard) {
            const protagEntity = entityMap.get(protagCard.name_normalized)
            playerEntityId = protagEntity?._id ? idString(protagEntity._id) : null
          } else {
            const player = await timing.step('kinship_player_entity', () => entityGraphService.ensurePlayerEntity({
              instanceId,
              playerId,
              name: session.persona_snapshot?.name,
              sequence: nextSequence,
            }))
            playerEntityId = idString(player._id)
          }
          if (playerEntityId) {
            for (const proposal of proposals) {
              // A review candidate is only useful for an identity the world
              // already knows. Never mint an entity from prose that merely
              // *resembles* a relationship assertion; that turned ordinary
              // narration into garbage candidates such as "on the far".
              const known = entityMap.get(normalizeEntityName(proposal.characterName))
              if (!known?._id) continue
              const characterEntityId = idString(known._id)
              await timing.step('kinship_candidate_write', () => relationCandidateService.propose({
                instanceId,
                playerId,
                characterName: proposal.characterName,
                characterEntityId,
                playerEntityId,
                relation: proposal.relation,
                relationKind: proposal.relationKind,
                evidence: proposal.evidence,
                sourceEventId: event._id,
                sequence: nextSequence,
              }))
            }
          }
        }
      } catch (err) {
        console.warn('relation candidate proposal skipped:', (err as Error).message)
      }

      // Identity/twist review lane. The detector is intentionally only a
      // candidate producer: it must resolve every endpoint to the existing
      // card/entity roster, quote narration evidence, and never changes canon
      // without an explicit player confirmation in the Chronicle controls.
      try {
        const revisions = detectCanonRevisionCandidates(rawNarrative, codex)
        if (revisions.length > 0) {
          const protagCard = codex.find((card) => card.is_protagonist)
          let playerEntityId: string | null = null
          if (!session.is_sentient && protagCard) {
            const protagEntity = entityMap.get(protagCard.name_normalized)
            playerEntityId = protagEntity?._id ? idString(protagEntity._id) : null
          } else {
            const player = await timing.step('kinship_player_entity', () => entityGraphService.ensurePlayerEntity({
              instanceId,
              playerId,
              name: session.persona_snapshot?.name,
              sequence: nextSequence,
            }))
            playerEntityId = idString(player._id)
          }
          if (playerEntityId) {
            for (const revision of revisions) {
              const primary = codex.find((card) => card.canonical_name === revision.characterName)
              const primaryEntity = primary ? entityMap.get(primary.name_normalized) : null
              if (!primary || !primaryEntity?._id) continue
              const counterpart = revision.kind === 'identity_merge'
                ? codex.find((card) => card.canonical_name === revision.counterpartCharacterName)
                : undefined
              const counterpartEntity = counterpart ? entityMap.get(counterpart.name_normalized) : undefined
              if (revision.kind === 'identity_merge' && !counterpartEntity?._id) continue
              await timing.step('kinship_candidate_write', () => relationCandidateService.propose({
                instanceId,
                playerId,
                characterName: primary.canonical_name,
                characterEntityId: idString(primaryEntity._id),
                playerEntityId,
                kind: revision.kind,
                relation: revision.kind === 'kinship_revision' ? revision.relation : 'identity',
                evidence: revision.evidence,
                sourceEventId: event._id,
                sequence: nextSequence,
                ...(revision.kind === 'kinship_revision'
                  ? { replacesRelation: revision.relation }
                  : { proposedName: revision.proposedName }),
                ...(counterpartEntity?._id
                  ? {
                      counterpartEntityId: idString(counterpartEntity._id),
                      counterpartCharacterName: counterpart?.canonical_name,
                    }
                  : {}),
              }))
            }
          }
        }
      } catch (err) {
        console.warn('canon revision candidate proposal skipped:', (err as Error).message)
      }
      // STEP 0, SELF-HEALING. Premise kinship ("Your sister Neva Vale") is seeded
      // once, from the authored premise — but the only two callers were instance
      // creation for SENTIENT worlds and the protagonist-onboarding endpoint. A GM
      // world whose player never completes that onboarding (the app treats the call
      // as best-effort and lets the protagonist card "seed emergently on the next
      // turn") therefore never seeded kinship at all, and nothing ever retried.
      //
      // That is why a 15-turn playthrough of a world whose premise literally says
      // "their sister Neva Vale" produced zero kinship edges: the extractor is told
      // not to re-list ties that already exist, and the tie was established before
      // turn 1 — so no turn ever claimed it and no seed ever ran. Retry here, the
      // moment a protagonist card exists. Idempotent (`meta.kinship_seeded`) and
      // off the TTFT path.
      if (codex.some((c) => c.is_protagonist)) {
        await timing.step('kinship_premise_seed', () => kinshipGraphService
          .seedPremiseKinship({ instanceId, playerId })
          .then((res) => {
            if (res.seeded > 0) {
              log.info('kinship.premise_seeded_late', {
                instanceId: idString(instanceId),
                sequence: nextSequence,
                seeded: res.seeded,
                notes: res.notes.slice(0, 4),
              })
            }
          })
          .catch(() => undefined))
      }
      // TRANSITION channel — death/disownment/divorce/reveal evolving an EXISTING
      // tie. Deterministic, off TTFT. Applied even when no new tie is asserted
      // (e.g. "my father died" carries no assertion, only a transition).
      const lifecycleTransitions = extractLifecycleTransitions({
        corrections: parsedPlayerInput.corrections,
        narrationFacts: parsedPlayerInput.narrationFacts,
        claims: [],
        prose: undefined,
      })
      if (relationAssertions.length > 0 || lifecycleTransitions.length > 0) {
        const protagCard = codex.find((c) => c.is_protagonist)
        let selfAnchorId: string | null = null
        if (!session.is_sentient && protagCard) {
          const ent = entityMap.get(protagCard.name_normalized)
          selfAnchorId = ent?._id ? idString(ent._id) : null
        } else {
          const player = await timing.step('kinship_player_entity', () => entityGraphService.ensurePlayerEntity({
            instanceId,
            playerId,
            name: session.persona_snapshot?.name,
            sequence: nextSequence,
          }))
          selfAnchorId = idString(player._id)
        }
        const kin = await timing.step('kinship_apply', () => kinshipGraphService.applyRelationAssertions({
          instanceId,
          sequence: nextSequence,
          eventId: event._id,
          assertions: relationAssertions,
          cards: codex,
          entitiesByCardName: entityMap,
          selfAnchorId,
          sceneText: rawNarrative,
          // Stub uncarded endpoints (e.g. a just-named "Mara" the codex didn't
          // card yet) so the typed tie is written against a stub entity now;
          // it promotes when the card lands. Closes the "edge disappears
          // because the endpoint has no card" gap.
          ensureStub: (name: string) =>
            entityGraphService
              .ensureStubEntity({
                instanceId,
                playerId,
                sequence: nextSequence,
                name,
              })
              .then((id) => id),
          transitions: lifecycleTransitions,
        }))
        kinWritten = kin.written
        if (kin.written > 0) {
          log.info('kinship.graph.updated', {
            instanceId: idString(instanceId),
            sequence: nextSequence,
            edges: kin.written,
            notes: kin.notes.slice(0, 6),
          })
        }
      }

    } catch (err) {
      console.warn('entity graph sync failed:', (err as Error).message)
    }

    try {
      const context = event.data.codex_projection_context
      let missCandidates = 0
      if (context) {
        const findings = detectProjectionAnomalies({
          ...context.anomalies, prose: rawNarrative, presentNames: event.data.present_characters || [],
          codexNames: [...knownCardNames], hadRelationAssertion: relationAssertions.length > 0,
          newCardNames: deltas.map((d) => d.resolved_name || d.name).filter((n) => !knownCardNames.has(normalizeEntityName(n))),
        })
        missCandidates = findings.filter((f) => ['prose_person_untracked', 'kinship_phrase_no_edge', 'location_phrase_no_anchor'].includes(f.type)).length
        for (const finding of findings) await timing.step('projection_anomalies_write', () => recordAnomaly({
          instanceId, playerId, eventId: event._id, sequence: nextSequence, ...finding,
        }))
        const ledger = buildSignalLedger({ ...context.signals, kinship: { detected: relationAssertions.length, committed: kinWritten }, missCandidates })
        await timing.step('signal_ledger_write', () => mongoColl.signalLedger().updateOne(
          { event_id: event._id }, { $set: { instance_id: instanceOid, player_id: parseObjectId(playerId),
            event_id: event._id, sequence: nextSequence, ...ledger, created_at: new Date() } }, { upsert: true },
        ))
      }
    } catch (err) {
      console.warn('projection anomaly/signal logging failed:', (err as Error).message)
    }

    // Memory-vector supersession: when a status was retired this turn, evict
    // the stale memory vectors so RAG can't resurface the now-false fact.
    const retiredFacts = deltas.flatMap((d) => d.retire_state || [])
    if (retiredFacts.length > 0) {
      memorySupersessionService
        .supersedeMemories({
          instanceId,
          retiredFacts,
          beforeDate: event.created_at,
          eventId: idString(event._id),
        })
        .catch((err) => console.warn('memory supersession failed:', (err as Error).message))
    }

    // Compaction mutates cards, so finish it before releasing the sequence barrier.
    for (const c of codex) {
      if ((c.immutable_facts?.length || 0) >= 24) {
        try {
          const compacted = await timing.step('fact_compaction_model', () =>
            compactImmutableFacts(c.canonical_name, c.immutable_facts, 16))
          if (compacted?.length) {
            await timing.step('fact_compaction_write', () =>
              characterCodexService.setImmutableFacts(idString(c._id), compacted))
          }
        } catch {}
      }
    }

    // RE-APPLY the turn's lifecycle deltas now that the codex has minted this
    // turn's cards.
    //
    // Cards are created LAZILY, by this projection, when someone first acts in
    // prose — the authored seed cast sits in the template snapshot until then.
    // So a death on an early turn was written to the ledger and then applied
    // to a `characters` row that did not exist yet, and quietly matched
    // nothing. `applyLifecycleDeltas` is a `$set` keyed on the name, so running
    // it twice costs one no-op update and closes the window.
    const lifecycleForTurn = projectionEvent.data.character_lifecycle_deltas
    if (Array.isArray(lifecycleForTurn) && lifecycleForTurn.length) {
      await timing.step('lifecycle_reprojection', () => characterCodexService
        .applyLifecycleDeltas({ instanceId, deltas: lifecycleForTurn })
        .catch((err) => {
          log.warn('character.lifecycle_reprojection_failed', { instanceId, error: (err as Error).message })
        }))
    }

    await timing.step('codex_publish', () => getRedisClient().publish(
      `user:${playerId}:events`,
      JSON.stringify({
        type: 'character_codex_updated',
        instanceId,
        focused_character_id: session.focus_character_id || null,
        characters: codex.map((c) => ({
          id: idString(c._id),
          canonical_name: c.canonical_name,
          aliases: c.aliases,
          role: c.role,
          appearance: c.appearance,
          persona: c.persona,
          immutable_facts: c.immutable_facts,
          mutable_state: c.mutable_state,
          interaction_hints: c.interaction_hints || [],
          disposition_to_player: c.disposition_to_player,
          hidden_thought: c.hidden_thought,
          relationship: c.relationship || null,
          relationship_state: c.relationship_state || null,
          mention_count: c.mention_count,
          is_protagonist: c.is_protagonist === true,
        })),
      }),
    ))
    return { projected: true, deltas: deltas.length }
  }, timing, async (events, timing) => {
    const session = await loadSession()
    const cards = await readCards()
    const inputs = await extractionInputs(instanceId, cards, timing)
    try {
      const batch = await timing.extract((onRaw) => extractCharacterCodexBatch({
        onRaw, ...inputs, turns: events.map(turnInputs),
        seedPrompt: session.seed_prompt, isSentient: session.is_sentient,
        protagonistName: cards.find((c) => c.is_protagonist)?.canonical_name || session.protagonist?.name,
        playerPersonaName: session.persona_snapshot?.name,
      }))
      if (batch.droppedUnattributable) {
        log.warn('projection.batch_unattributable', { instanceId, sequence: events[0].sequence, count: batch.droppedUnattributable })
      }
      for (const event of events) await timing.step('batch_attribution_write', () => mongoColl.events().updateOne(
        { _id: event._id }, { $set: { 'data.codex_projection_dropped_unattributable': batch.droppedUnattributable } },
      ))
      return batch.deltas
    } catch (err) {
      log.warn('projection.batch_fallback', { instanceId, sequence: events[0].sequence, reason: String(err) })
      return undefined // Each work callback re-reads cards and extracts its own turn under the SAME claims.
    }
  })
}
