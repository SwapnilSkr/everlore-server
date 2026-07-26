import { ObjectId } from 'mongodb'
import { mongoColl } from '../config/mongo'
import { idString, parseObjectId } from '../utils/mongo-id'
import type { RelationKind } from '../utils/kinship-ontology'
import type { RelationCandidateDoc } from '../models/relation-candidate.model'
import type { CanonRevisionKind } from '../models/relation-candidate.model'

const candidates = () => mongoColl.relationCandidates()

export const relationCandidateService = {
  async propose(params: {
    instanceId: string
    playerId: string
    characterName: string
    characterEntityId: string
    playerEntityId: string
    relation: string
    relationKind?: RelationKind
    evidence: string
    sourceEventId: ObjectId
    sequence: number
    kind?: CanonRevisionKind
    counterpartEntityId?: string
    counterpartCharacterName?: string
    proposedName?: string
    replacesRelation?: string
  }): Promise<void> {
    const now = new Date()
    const iid = parseObjectId(params.instanceId)
    const characterEntityId = parseObjectId(params.characterEntityId)
    const playerEntityId = parseObjectId(params.playerEntityId)
    const counterpartEntityId = params.counterpartEntityId
      ? parseObjectId(params.counterpartEntityId)
      : undefined
    // A confirmed tie (in either direction) means an ordinary kinship proposal
    // is redundant. Identity revisions are different: a father can have a
    // perfectly valid established tie and still later be named John.
    if ((params.kind || 'kinship') === 'kinship') {
      const existing = await mongoColl.entityEdges().findOne({
        instance_id: iid,
        type: 'kinship',
        status: 'active',
        $or: [
          { source_entity_id: characterEntityId, target_entity_id: playerEntityId },
          { source_entity_id: playerEntityId, target_entity_id: characterEntityId },
        ],
      })
      if (existing) return
    }
    await candidates().updateOne(
      {
        source_event_id: params.sourceEventId,
        character_entity_id: characterEntityId,
        kind: params.kind || 'kinship',
        relation: params.relation,
      },
      {
        $setOnInsert: {
          _id: new ObjectId(),
          instance_id: iid,
          player_id: parseObjectId(params.playerId),
          character_entity_id: characterEntityId,
          player_entity_id: playerEntityId,
          character_name: params.characterName,
          kind: params.kind || 'kinship',
          ...(counterpartEntityId ? { counterpart_entity_id: counterpartEntityId } : {}),
          ...(params.counterpartCharacterName ? { counterpart_character_name: params.counterpartCharacterName.slice(0, 120) } : {}),
          ...(params.proposedName ? { proposed_name: params.proposedName.slice(0, 120) } : {}),
          ...(params.replacesRelation ? { replaces_relation: params.replacesRelation.slice(0, 40) } : {}),
          relation: params.relation,
          ...(params.relationKind ? { relation_kind: params.relationKind } : {}),
          evidence: params.evidence,
          source_event_id: params.sourceEventId,
          sequence: params.sequence,
          status: 'open',
          created_at: now,
          updated_at: now,
        },
      },
      { upsert: true },
    )
  },

  async listOpen(instanceId: string, playerId: string) {
    return candidates()
      .find({
        instance_id: parseObjectId(instanceId),
        player_id: parseObjectId(playerId),
        status: 'open',
      })
      .sort({ updated_at: -1 })
      .limit(12)
      .toArray()
  },

  async getOpen(candidateId: string, playerId: string) {
    return candidates().findOne({
      _id: parseObjectId(candidateId),
      player_id: parseObjectId(playerId),
      status: 'open',
    })
  },

  async resolve(params: {
    candidateId: string
    playerId: string
    status: 'accepted' | 'rejected' | 'deferred'
    relation?: string
  }): Promise<boolean> {
    const result = await candidates().updateOne(
      {
        _id: parseObjectId(params.candidateId),
        player_id: parseObjectId(params.playerId),
        status: 'open',
      },
      {
        $set: {
          status: params.status,
          ...(params.relation ? { resolved_relation: params.relation } : {}),
          resolved_at: new Date(),
          updated_at: new Date(),
        },
      },
    )
    return result.modifiedCount === 1
  },

  toClient(candidate: RelationCandidateDoc) {
    return {
      id: idString(candidate._id),
      kind: candidate.kind || 'kinship',
      character_name: candidate.character_name,
      counterpart_character_name: candidate.counterpart_character_name,
      proposed_name: candidate.proposed_name,
      replaces_relation: candidate.replaces_relation,
      relation: candidate.relation,
      evidence: candidate.evidence,
      sequence: candidate.sequence,
    }
  },
}
