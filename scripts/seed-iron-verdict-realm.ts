/**
 * Give a developer a real Iron Verdict save they can open on a device.
 *
 * The world is reachable today only through a preview route, and a preview
 * has no instance behind it — close the app and the play is gone. A published
 * template plus one instance is what the deep link
 * `/interactive/iron-verdict/lab?instanceId=` actually loads.
 *
 * Idempotent on title / world key and on (player, template): a second run
 * reprints the ids it already wrote rather than minting a second world the
 * device cannot tell from the first.
 *
 *   bun run seed:iron-verdict --email=you@example.com
 *   bun run seed:iron-verdict --player=<objectid>
 */
import { ObjectId } from 'mongodb'
import { connectMongo, mongoColl } from '../src/config/mongo'
import type { WorldInstanceDoc } from '../src/models/world-instance.model'
import type { WorldTemplateDoc } from '../src/models/world-template.model'
import { interactiveWorldService } from '../src/services/interactive-world.service'
import { idString, parseObjectId } from '../src/utils/mongo-id'
import { requireWorld } from '../src/worlds/world-source'

const WORLD_KEY = 'iron-verdict'

function flag(name: string): string | undefined {
  const prefix = `--${name}=`
  for (const raw of process.argv.slice(2)) {
    if (raw.startsWith(prefix)) {
      const value = raw.slice(prefix.length).trim()
      return value.length > 0 ? value : undefined
    }
  }
  return undefined
}

async function resolvePlayer(): Promise<{ _id: ObjectId; email?: string }> {
  const email = flag('email')
  const player = flag('player')
  if (!email && !player) {
    console.error('Pass --email=<addr> or --player=<objectid> so the instance is owned by a real account.')
    process.exit(1)
  }

  // Player id wins when both are passed: email is a lookup, and two different
  // accounts must not silently receive the same seed.
  if (player) {
    const _id = parseObjectId(player)
    const user = await mongoColl.users().findOne({ _id })
    if (!user) {
      console.error(`No user found for --player=${player}`)
      process.exit(1)
    }
    return user
  }

  const user = await mongoColl.users().findOne({ email })
  if (!user) {
    console.error(`No user found for --email=${email}`)
    process.exit(1)
  }
  return user
}

async function ensureTemplate(playerId: ObjectId, authored: ReturnType<typeof requireWorld>): Promise<{
  template: WorldTemplateDoc
  created: boolean
}> {
  const templates = mongoColl.worldTemplates()
  // Title is the name the device shows. Slug is the unique index, and
  // must be the world key — slugifying the title would write `the-iron-verdict`
  // and a second run looking up `iron-verdict` would insert a duplicate.
  const existing =
    (await templates.findOne({ title: authored.title })) ??
    (await templates.findOne({ slug: authored.key }))

  if (existing) {
    const template = existing as WorldTemplateDoc
    console.log(`Reused existing template ${idString(template._id)} titled "${template.title}".`)
    return { template, created: false }
  }

  const now = new Date()
  const template: WorldTemplateDoc = {
    _id: new ObjectId(),
    creator_id: playerId,
    title: authored.title,
    slug: authored.key,
    // chapter_title is the only authored blurb that is not the title. A
    // synopsis written here would be lore the file does not contain.
    description: authored.chapter_title,
    kind: 'world',
    // DELIBERATELY UNPUBLISHED. `is_published` is what `listPublished` filters
    // discovery on, so setting it here would push this world into the Explore
    // feed of every account on the cluster this script is pointed at — and the
    // whole reason to seed a save is that the world has not been played yet.
    // The owner reaches it through My Worlds and through the instance link
    // printed below, neither of which needs the discovery flag.
    is_published: false,
    // A sentient template would seed a locked protagonist and flip chat POV.
    // This world is a map the player walks, not a character they talk to.
    is_sentient: false,
    is_nsfw_capable: false,
    version: 1,
    // Same two authored strings, so the story loop has a premise if this save
    // is later opened in chat — without a paraphrase that would drift from the file.
    seed_prompt: `${authored.title} — ${authored.chapter_title}`,
    // Empty on purpose: inventing a setting paragraph here would become canon
    // the interactive world does not own.
    global_lore: '',
    // Interactive play does not roll gauges. A dummy stat would be a mechanic
    // this world does not have, and instance create copies these into world_state.
    base_stats_template: {},
    // Map flags live on interactive world state. Putting them here would copy
    // them into active_flags, and effectiveFlags would treat them as narrated.
    flag_definitions: {},
    scene_tags: [],
    // Narration models default to env, same as template.service: leave empty
    // unless a world needs a specific override.
    model_preferences: {},
    // template.service defaults. The interactive path does not read these; they
    // only matter if this save is later opened in the story loop.
    max_context_memories: 25,
    max_lore_results: 10,
    created_at: now,
    updated_at: now,
  }

  await templates.insertOne(template)
  console.log(`Created template ${idString(template._id)} titled "${template.title}".`)
  return { template, created: true }
}

async function ensureInstance(playerId: ObjectId, template: WorldTemplateDoc): Promise<{
  instance: WorldInstanceDoc
  created: boolean
}> {
  const instances = mongoColl.worldInstances()
  // Most-recent first, including archived: a second run that minted a new save
  // because the first was archived would leave two Iron Verdicts on the account.
  const existing = await instances.findOne(
    { player_id: playerId, template_id: template._id },
    { sort: { 'meta.last_active_at': -1 } },
  )
  if (existing) {
    const instance = existing as WorldInstanceDoc
    console.log(`Reused existing instance ${idString(instance._id)} for this player.`)
    return { instance, created: false }
  }

  const now = new Date()
  const instance: WorldInstanceDoc = {
    _id: new ObjectId(),
    template_id: template._id,
    template_version: template.version,
    player_id: playerId,
    world_state: {},
    active_flags: {},
    // instance.service starts every world here. The interactive path overwrites
    // scene_tag on the first turn; leaving current_scene unset fails the model.
    current_scene: {
      tag: 'dialogue',
      turn_count: 0,
      summary_pending: false,
    },
    meta: {
      total_events: 0,
      total_memories: 0,
      total_tokens_consumed: 0,
      last_active_at: now,
      is_archived: false,
    },
    created_at: now,
    updated_at: now,
  }

  await instances.insertOne(instance)
  console.log(`Created world instance ${idString(instance._id)}.`)
  return { instance, created: true }
}

async function main() {
  const authored = requireWorld(WORLD_KEY)
  await connectMongo()
  const player = await resolvePlayer()

  // The map definition is a separate document from the template. Without it
  // the instance id prints and the deep link 404s on the first state fetch.
  await interactiveWorldService.ensureWorld(authored.key)

  const { template } = await ensureTemplate(player._id, authored)
  const { instance } = await ensureInstance(player._id, template)
  const instanceId = idString(instance._id)

  console.log('')
  console.log(`template id:  ${idString(template._id)}`)
  console.log(`instance id:  ${instanceId}`)
  console.log(`/interactive/${authored.key}/lab?instanceId=${instanceId}`)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('seed-iron-verdict-realm failed:', err)
    process.exit(1)
  })
