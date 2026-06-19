/**
 * Projection checkpoint audit: create a checkpoint, corrupt the live codex/kinship
 * projection, restore the checkpoint, then replay only the suffix ledger.
 *
 * Run: bun run audit:projection-checkpoint
 */
import { ObjectId } from 'mongodb'
import { connectMongo, mongoColl } from '../src/config/mongo'
import { characterCodexService } from '../src/services/character-codex.service'
import { entityGraphService } from '../src/services/entity-graph.service'
import { kinshipGraphService } from '../src/services/kinship-graph.service'
import { projectionCheckpointService } from '../src/services/projection-checkpoint.service'
import { idString } from '../src/utils/mongo-id'

let pass = 0
let fail = 0
function ok(label: string, cond: boolean, detail = '') {
  if (cond) {
    pass++
    console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    fail++
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

async function main() {
  await connectMongo()
  const playerId = new ObjectId()
  const templateId = new ObjectId()
  const instanceId = new ObjectId()
  const seq1EventId = new ObjectId()
  const seq2EventId = new ObjectId()

  try {
    await mongoColl.worldTemplates().insertOne({
      _id: templateId,
      creator_id: playerId,
      title: 'Checkpoint Audit',
      seed_prompt: 'A grounded family drama.',
      global_lore: '',
      is_sentient: false,
      protagonist: { name: 'Player Hero' },
      base_stats_template: {},
      flag_definitions: {},
      max_lore_results: 10,
      max_context_memories: 25,
      created_at: new Date(),
      updated_at: new Date(),
    } as never)
    await mongoColl.worldInstances().insertOne({
      _id: instanceId,
      player_id: playerId,
      template_id: templateId,
      title: 'Checkpoint Audit Instance',
      mode: 'sfw',
      world_state: {},
      active_flags: {},
      meta: { total_events: 2, total_memories: 0, is_archived: false, last_active_at: new Date() },
      created_at: new Date(),
      updated_at: new Date(),
    } as never)

    await characterCodexService.seedProtagonist({
      instanceId: idString(instanceId),
      playerId: idString(playerId),
      name: 'Player Hero',
      isPlayer: true,
    })
    await characterCodexService.applyDeltas({
      instanceId: idString(instanceId),
      playerId: idString(playerId),
      sequence: 1,
      deltas: [{
        name: 'Mara',
        immutable_facts: ['Mara is the player hero sibling.'],
        relation_assertions: [{ from: 'Mara', to: 'player', kind: 'sibling_of', label: 'sister', gender: 'f', source: 'narrator' }],
      }],
    })
    const codex1 = await characterCodexService.listForInstance(idString(instanceId), 20)
    const entityMap1 = await entityGraphService.syncCodexEntities({
      instanceId: idString(instanceId),
      playerId: idString(playerId),
      sequence: 1,
      cards: codex1,
    })
    const player = await entityGraphService.ensurePlayerEntity({
      instanceId: idString(instanceId),
      playerId: idString(playerId),
      name: 'Player Hero',
      sequence: 1,
    })
    await kinshipGraphService.applyRelationAssertions({
      instanceId: idString(instanceId),
      sequence: 1,
      eventId: seq1EventId,
      assertions: [{ from: 'Mara', to: 'player', kind: 'sibling_of', label: 'sister', gender: 'f', source: 'narrator' }],
      cards: codex1,
      entitiesByCardName: entityMap1,
      selfAnchorId: idString(player._id),
      sceneText: 'Mara is your sister.',
    })

    await mongoColl.events().insertMany([
      {
        _id: seq1EventId,
        instance_id: instanceId,
        player_id: playerId,
        sequence: 1,
        type: 'narration',
        data: {
          player_input: '',
          ai_response: 'Mara is your sister.',
          codex_deltas: [{
            name: 'Mara',
            relation_assertions: [{ from: 'Mara', to: 'player', kind: 'sibling_of', label: 'sister', gender: 'f', source: 'narrator' }],
          }],
          state_mutations: {},
          flag_mutations: {},
          model_used: 'audit',
          tokens_in: 0,
          tokens_out: 0,
        },
        is_user_edited: false,
        edit_history: [],
        scene_tag: 'dialogue',
        created_at: new Date(),
      },
      {
        _id: seq2EventId,
        instance_id: instanceId,
        player_id: playerId,
        sequence: 2,
        type: 'narration',
        data: {
          player_input: '',
          ai_response: 'Bram is Mara’s brother.',
          codex_deltas: [{
            name: 'Bram',
            relation_assertions: [{ from: 'Bram', to: 'Mara', kind: 'sibling_of', label: 'brother', gender: 'm', source: 'narrator' }],
          }],
          state_mutations: {},
          flag_mutations: {},
          model_used: 'audit',
          tokens_in: 0,
          tokens_out: 0,
        },
        is_user_edited: false,
        edit_history: [],
        scene_tag: 'dialogue',
        created_at: new Date(),
      },
    ] as never[])

    const checkpoint = await projectionCheckpointService.create(idString(instanceId), { sequence: 1 })
    ok('checkpoint created at seq 1', checkpoint.created === true && checkpoint.sequence === 1)

    await mongoColl.characters().deleteMany({ instance_id: instanceId })
    await mongoColl.entityEdges().deleteMany({ instance_id: instanceId, type: 'kinship' })
    const latest = await projectionCheckpointService.latestBefore(idString(instanceId), 1)
    if (!latest) throw new Error('checkpoint missing')

    await projectionCheckpointService.restoreCodexAndKinship(latest._id)
    const restored = await characterCodexService.listForInstance(idString(instanceId), 20)
    ok('prefix codex restored', restored.some((c) => c.canonical_name === 'Mara'))
    ok('suffix card not restored yet', !restored.some((c) => c.canonical_name === 'Bram'))
    ok('prefix kinship restored', await mongoColl.entityEdges().countDocuments({ instance_id: instanceId, type: 'kinship' }) > 0)

    await characterCodexService.rebuildCodexFromLedger({
      instanceId: idString(instanceId),
      playerId: idString(playerId),
      batches: [{
        sequence: 2,
        deltas: [{
          name: 'Bram',
          relation_assertions: [{ from: 'Bram', to: 'Mara', kind: 'sibling_of', label: 'brother', gender: 'm', source: 'narrator' }],
        }],
      }],
    })
    await kinshipGraphService.applyLedgerSince({
      instanceId: idString(instanceId),
      playerId: idString(playerId),
      isSentient: false,
      playerName: 'Player Hero',
      fromSequence: 1,
    })
    const finalCodex = await characterCodexService.listForInstance(idString(instanceId), 20)
    ok('suffix codex replayed', finalCodex.some((c) => c.canonical_name === 'Bram'))
    ok('suffix kinship replayed', await mongoColl.entityEdges().countDocuments({ instance_id: instanceId, type: 'kinship' }) >= 2)
  } finally {
    await Promise.all([
      mongoColl.projectionCheckpointChunks().deleteMany({ instance_id: instanceId }),
      mongoColl.projectionCheckpoints().deleteMany({ instance_id: instanceId }),
      mongoColl.entityEdges().deleteMany({ instance_id: instanceId }),
      mongoColl.entities().deleteMany({ instance_id: instanceId }),
      mongoColl.characters().deleteMany({ instance_id: instanceId }),
      mongoColl.events().deleteMany({ instance_id: instanceId }),
      mongoColl.worldInstances().deleteMany({ _id: instanceId }),
      mongoColl.worldTemplates().deleteMany({ _id: templateId }),
    ])
  }

  console.log(`\nprojection checkpoint audit: ${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
