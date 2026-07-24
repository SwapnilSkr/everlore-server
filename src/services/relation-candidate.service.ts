import { ObjectId } from 'mongodb'
import { mongoColl } from '../config/mongo'
import { idString, parseObjectId } from '../utils/mongo-id'
import type { RelationKind } from '../utils/kinship-ontology'
import type { RelationCandidateDoc } from '../models/relation-candidate.model'

const candidates = () => mongoColl.relationCandidates()

export const relationCandidateService = {
  async propose(params: {
    instanceId: string
    playerId: string
    characterName: string
    characterEntityId: string
    playerEntityId: string
    relation: string
    relationKind: RelationKind
    evidence: string
    sourceEventId: ObjectId
    sequence: number
  }): Promise<void> {
    const now = new Date()
    const iid = parseObjectId(params.instanceId)
    const characterEntityId = parseObjectId(params.characterEntityId)
    const playerEntityId = parseObjectId(params.playerEntityId)
    // A confirmed tie (in either direction) means this is not a review prompt;
    // candidates never compete with established canon.
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
    await candidates().updateOne(
      {
        source_event_id: params.sourceEventId,
        character_entity_id: characterEntityId,
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
          relation: params.relation,
          relation_kind: params.relationKind,
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
      character_name: candidate.character_name,
      relation: candidate.relation,
      evidence: candidate.evidence,
      sequence: candidate.sequence,
    }
  },
}
