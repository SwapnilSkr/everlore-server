import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// Mutants live under scripts/, inside this task's writable paths. Only source
// and audit files are copied; no environment files or credentials are read.
const root = await mkdtemp(join(import.meta.dir, '.group-chat-bites-'))
const server = new URL('..', import.meta.url).pathname
const auditFiles = ['group-chat-audit.ts', 'group-chat-fixtures.ts', 'prompt-part-hash-audit.ts', 'codex-media-carryover-audit.ts', 'seed-catalog.ts', 'narrator-harness-audit.ts']
type Edit = [file: string, from: string, to: string]
type Mutation = { name: string; check: string; edits: Edit[]; script?: string }
const roll = 'src/services/group-chat/roll.ts', lines = 'src/services/group-chat/lines.ts', reply = 'src/services/group-chat/reply.ts'
const worker = 'worker/processors/group-turn.processor.ts', prompt = 'src/services/group-chat/prompt.ts'
const mutations: Mutation[] = [
  { name: 'formula', check: 'roll formula', edits: [[roll, '* 0.6', '* 0.5']] },
  { name: 'mandatory tag', check: 'tags always', edits: [[roll, 'tags.includes(member.id) || ', '']] },
  { name: 'plain-name bonus', check: 'tags always', edits: [[roll, '? 0.5 : 0', '? 0.4 : 0']] },
  { name: 'player minimum', check: 'player minimum', edits: [[roll, "origin === 'player' ? 1 : 2", "origin === 'player' ? 0 : 2"]] },
  { name: 'autonomy minimum', check: 'player minimum', edits: [[roll, "origin === 'player' ? 1 : 2", "origin === 'player' ? 1 : 1"]] },
  { name: 'bar a member', check: 'no member is barred', edits: [[roll, 'members.filter(member => picked.includes(member.id)).map', 'members.slice(0, -1).filter(member => picked.includes(member.id)).map']] },
  { name: 'player line leak', check: 'parser prefixes', edits: [[lines, 'if (key === player.toLowerCase()) counts.player++', "if (key === player.toLowerCase()) { lines.push({ name: player, text: prefix[2] }); counts.player++ }"]] },
  { name: 'unknown continuation leak', check: 'parser prefixes', edits: [[lines, 'current = undefined', 'current = lines.at(-1)']] },
  { name: 'off-list speaker', check: 'off-list', edits: [[lines, '!options.speakers.includes(member.id)', 'false']] },
  { name: 'per-person cap', check: 'two per person', edits: [[lines, '? 3 : 2) ||', '? 3 : 3) ||']] },
  { name: 'catchup cap', check: 'two per person', edits: [[lines, 'kept.length >= 4', 'kept.length >= 5']] },
  { name: 'normalized duplicate', check: 'duplicates from', edits: [[lines, 'text.toLowerCase().replace', 'text.replace']] },
  { name: 'last-five duplicate', check: 'duplicates from', edits: [[lines, '.slice(-5)', '.slice(-4)']] },
  { name: 'opening duplicate', check: 'duplicates from', edits: [[lines, '...options.openings.filter(other => other.name === line.name),', '']] },
  { name: 'unsafe output', check: 'generated unsafe', edits: [[lines, 'if (options.blocked(line.text))', 'if (false)']] },
  { name: 'typing spacing', check: 'reveal spacing', edits: [[lines, 'at += 1500', 'at += 500']] },
  { name: 'unstable static prefix', check: 'static prompt identical', edits: [[prompt, "return parts.join('\\n\\n')", "return parts.join('\\n\\n') + Math.random()"]] },
  { name: 'tag repair', check: 'tag repair merged', edits: [[reply, "await attempt(missingTags(), 'tag_repair')", "await attempt(missingTags(), 'tag_repair', 1)"]] },
  { name: 'adult validation', check: 'group validation rejects', edits: [['src/services/group-chat/validation.ts', 'traits.age < 18', 'traits.age < 16']] },
  { name: 'seed refuses minor', check: 'seed validation refuses', edits: [['scripts/seed-catalog.ts', '  validateGroup(data)', '  // validation removed'], ['src/schemas/template.schema.ts', 'age: t.Number({ minimum: 18 })', 'age: t.Number({ minimum: 16 })']] },
  { name: 'seed opening', check: 'creation seeds', edits: [['src/services/instance.service.ts', "      await seedGroupOpening(instance, template, player?.preferences?.player_name || 'Player')", '      // missing opening']] },
  { name: 'persist reply', check: 'fake-model player turn', edits: [[worker, 'await mongoColl.events().insertOne(event)', 'await mongoColl.events().insertOne({ ...event, data: { ...event.data, lines: [] } })']] },
  { name: 'real tag repair', check: 'real processor tagged', edits: [[worker, 'tags: roll.tags,', 'tags: [],']] },
  { name: 'last-five outside recent window', check: 'last-five duplicate history', edits: [[worker, 'previous: previousLines,', 'previous: history,']] },
  { name: 'input guard', check: 'input guard blocks', edits: [[worker, 'if (guard.blocked)', 'if (false)']] },
  { name: 'topic cursor', check: 'unprompted and catchup', edits: [[worker, "state.topics_used + (origin === 'player' ? 0 : 1)", 'state.topics_used']] },
  { name: 'adult consent gates', check: 'toggle off never', edits: [[worker, "enabled: fresh?.preferences?.nsfw_enabled === true", 'enabled: true'], [worker, "adult && template.is_nsfw_capable && consent?.preferences?.nsfw_enabled === true", 'adult']] },
  { name: 'curation cadence', check: 'twentieth writing', edits: [[worker, 'if (Math.floor(nextState.writing_calls', 'if (false && Math.floor(nextState.writing_calls']] },
  { name: 'loaded private state', check: 'twentieth writing', edits: [['src/services/group-chat/public.ts', "'group_state',", '']] },
  { name: 'loaded event snapshot', check: 'twentieth writing', edits: [['src/services/media/events.ts', '  delete data.group_state_after', '  // snapshot not stripped'], ['src/services/group-chat/public.ts', "'group_state_after',", '']] },
  { name: 'replay refusal', check: 'group replay is refused', edits: [['src/services/generation.service.ts', 'if (replayInstance?.group_state)', 'if (false)']] },
  { name: 'socket reservation', check: 'existing socket chat', edits: [['src/services/play-ws.service.ts', "await billingService.reserve(user.id, 'story_turn',", "await billingService.reserve(user.id, 'group_turn' as never,"]] },
  { name: 'save cascade', check: 'save and account deletion', edits: [['src/services/deletion.service.ts', '    await events().deleteMany({ instance_id: instanceId })', '    // events not deleted']] },
  { name: 'rewind snapshot', check: 'real rewind restores', edits: [['src/services/memory.service.ts', 'const groupSnapshot = last?.data.group_state_after', 'const groupSnapshot = instance.group_state']] },
  { name: 'group isolation in discovery', check: 'existing discovery', edits: [['src/services/template.service.ts', "if (!filters.kind) clauses.push({ kind: { $ne: 'group' } })", "if (false) clauses.push({ kind: { $ne: 'group' } })"]] },
  { name: 'group-only handoff', check: 'story prompt fixed', edits: [['worker/processors/generation.processor.ts', "if (dispatchedSession.kind === 'group')", "if (dispatchedSession.kind !== 'group')"]] },
  { name: 'first chronological tag', check: 'addressed pick', edits: [[roll, '.sort((a, b) => a.at - b.at)', '.sort((a, b) => b.at - a.at)']] },
  { name: 'tag before named', check: 'addressed pick', edits: [[roll, 'first(true) ?? first(false)', 'first(false) ?? first(true)']] },
  { name: 'named before roll', check: 'addressed pick', edits: [[roll, 'first(false) ?? picked[0]', 'picked[0]']] },
  { name: 'addressed rolled fallback', check: 'addressed pick', edits: [[roll, '?? picked[0]', '?? picked[1]']] },
  { name: 'bystander half threshold', check: 'adult bystander roll', edits: [[roll, 'rng() < 0.5', 'rng() < 0.4']] },
  { name: 'bystander first rolled other', check: 'adult bystander roll', edits: [[roll, 'picked.find(id => id !== addressed)', 'picked.find(id => id === addressed)']] },
  { name: 'other tags skip coin', check: 'adult bystander roll', edits: [[roll, 'if (others.length) return others', 'if (false) return others']] },
  { name: 'strip stage before checks', check: 'adult line checks', edits: [[lines, 'const clean = stripStageDirections(line.text)', 'const clean = line.text']] },
  { name: 'strip unpaired stage', check: 'adult line checks', edits: [[lines, ".replace(/^\\*[^*]*$|[^*]*\\*$/g, '')", '']] },
  { name: 'copied voice gate', check: 'adult line checks', edits: [[lines, 'if (member.group.voice?.some', 'if (false && member.group.voice?.some']] },
  { name: 'adult third message cap', check: 'adult line checks', edits: [[lines, '? 3 : 2', '? 2 : 2']] },
  { name: 'bystander one message cap', check: 'adult line checks', edits: [[lines, 'options.oneMessage ? 1', 'options.oneMessage ? 2']] },
  { name: 'stage check counter', check: 'adult line checks', edits: [[lines, 'counts.stage_directions++', 'counts.stage_directions += 0']] },
  { name: 'voice check counter', check: 'adult line checks', edits: [[lines, 'counts.copied_example++', 'counts.copied_example += 0']] },
  { name: 'required intimacy', check: 'adult validation requires', edits: [['src/services/group-chat/validation.ts', "(data.is_nsfw_capable || traits!.intimacy !== undefined) && !text(traits!.intimacy)", "traits!.intimacy !== undefined && !text(traits!.intimacy)"]] },
  { name: 'required voice', check: 'adult validation requires', edits: [['src/services/group-chat/validation.ts', 'data.is_nsfw_capable || traits!.voice !== undefined', 'traits!.voice !== undefined']] },
  { name: 'voice size', check: 'adult validation requires', edits: [['src/services/group-chat/validation.ts', 'voice.length > 8', 'voice.length > 9']] },
  { name: 'voice single lines', check: 'adult validation requires', edits: [['src/services/group-chat/validation.ts', "!/[\\r\\n]/u.test(line)", 'true']] },
  { name: 'unknown group shape', check: 'adult validation requires', edits: [['src/services/group-chat/validation.ts', "if (Object.keys(traits!).some", "if (false && Object.keys(traits!).some"]] },
  { name: 'authored intimacy prompt', check: 'addressed prompt', edits: [[prompt, '${member.group.intimacy}', 'omitted']] },
  { name: 'authored voice prompt', check: 'addressed prompt', edits: [[prompt, '...(member.group.voice || [])', '...[]']] },
  { name: 'player gender sentence', check: 'addressed prompt', edits: [[prompt, "${input.player}'s gender isn't stated", "Someone's gender isn't stated"]] },
  { name: 'addressed only static cast', check: 'addressed prompt', edits: [[prompt, 'members: [member]', 'members: input.members']] },
  { name: 'default group adult writer', check: 'group adult model defaults', edits: [['src/ai/models.ts', "'sao10k/l3.1-euryale-70b'", "'wrong-adult'"]] },
  { name: 'group adult override', check: 'group adult model defaults', edits: [['src/ai/models.ts', 'process.env.GROUP_NSFW_MODEL || ', '']] },
  { name: 'group adult fallback override', check: 'group adult model defaults', edits: [['src/ai/models.ts', 'process.env.GROUP_NSFW_FALLBACK_MODELS ?? ', '']] },
  { name: 'group adult fallback order', check: 'group adult model defaults', edits: [['src/ai/models.ts', "cognitivecomputations/dolphin-mistral-24b-venice-edition,thedrummer/skyfall-36b-v2", "thedrummer/skyfall-36b-v2,cognitivecomputations/dolphin-mistral-24b-venice-edition"]] },
  { name: 'Euryale temperature', check: 'group adult model defaults', edits: [['src/ai/narration-profile.ts', "if (normalized === 'sao10k/l3.1-euryale-70b') return 0.62", "if (normalized === 'sao10k/l3.1-euryale-70b') return 0.68"]] },
  { name: 'narrator harness Euryale check', check: 'group adult writer keeps the measured temperature', script: 'narrator-harness-audit.ts', edits: [['src/ai/narration-profile.ts', "if (normalized === 'sao10k/l3.1-euryale-70b') return 0.62", "if (normalized === 'sao10k/l3.1-euryale-70b') return 0.68"]] },
  { name: 'schema unknown group field', check: 'seed adult schema', edits: [['src/schemas/template.schema.ts', '{ additionalProperties: false }', '{ additionalProperties: true }']] },
  { name: 'schema voice size', check: 'seed adult schema', edits: [['src/schemas/template.schema.ts', 'minItems: 1, maxItems: 8', 'minItems: 1, maxItems: 9']] },
  { name: 'split adult model', check: 'adult split order', edits: [[worker, '|| AI_MODELS.groupNsfw', '|| AI_MODELS.narrationNsfw']] },
  { name: 'split normal bystander model', check: 'adult split order', edits: [[reply, "await attempt(others, 'bystander')", "await attempt(others, 'bystander', 0, 'adult')"]] },
  { name: 'adult token budget', check: 'adult split order', edits: [[worker, '? 160 : 60', '? 400 : 60']] },
  { name: 'bystander token budget', check: 'adult split order', edits: [[worker, '60 * speakers.length', '100 * speakers.length']] },
  { name: 'adult history twelve', check: 'adult split order', edits: [[worker, '? 12 : 5', '? 30 : 5']] },
  { name: 'bystander history five', check: 'adult split order', edits: [[worker, '? 12 : 5', '? 12 : 12']] },
  { name: 'bystander sees reply', check: 'adult split order', edits: [[worker, '...(split ? request.history : [])', '...[]']] },
  { name: 'adult model used record', check: 'adult split order', edits: [[reply, 'model: adultModel || model', 'model']] },
  { name: 'each call records writer model purpose', check: 'adult split order', edits: [[worker, 'writing_calls: writing.length, writing,', 'writing_calls: writing.length, writing: [],']] },
  { name: 'writing call count', check: 'adult split order', edits: [[worker, 'Math.max(writing.length, usage.filter', 'Math.max(1, usage.filter']] },
  { name: 'retry next adult writer', check: 'adult retry advances', edits: [[reply, "'addressed_retry', next, 'adult'", "'addressed_retry', 0, 'adult'"]] },
  { name: 'adult chain never repeats a model', check: 'adult retry advances', edits: [[worker, 'const adultChain = [...new Set([primary, ...fallbacks].map(model => model.trim()).filter(Boolean))]', 'const adultChain = [primary, ...fallbacks].map(model => model.trim()).filter(Boolean)']] },
  { name: 'empty adult rescue', check: 'adult retry advances', edits: [[reply, "if (!lines.length) await attempt([input.adult.addressed], 'addressed_fallback')", "if (false) await attempt([input.adult.addressed], 'addressed_fallback')"]] },
  { name: 'template adult override', check: 'adult template preference', edits: [[worker, 'template.model_preferences?.narration_nsfw || ', '']] },
  { name: 'transport fallback call count', check: 'adult template preference', edits: [[worker, 'Math.max(writing.length, usage.filter', 'Math.max(reply.calls, usage.filter']] },
  { name: 'immediate consent reread', check: 'adult consent withdrawn', edits: [[worker, "? await mongoColl.users().findOne({ _id: pid }, { projection: { 'preferences.nsfw_enabled': 1 } }) : undefined", '? player : undefined']] },
  { name: 'adult call consent gate', check: 'adult consent withdrawn', edits: [[worker, '&& consent?.preferences?.nsfw_enabled === true', '']] },
  { name: 'noncapable route gate', check: 'adult consent withdrawn', edits: [[worker, 'router, capable: template.is_nsfw_capable', 'router, capable: true'], [worker, '&& template.is_nsfw_capable && consent', '&& consent']] },
  { name: 'failed optional speaker loses reply', check: 'adult optional failure', edits: [[reply, 'return index + 1\n    }', "throw new Error('failed optional speaker')\n    }"]] },
  { name: 'last chance tag backup', check: 'adult optional failure', edits: [[reply, "if (missingTags().length) await attempt(missingTags(), 'tag_backup', 1)", "if (false) await attempt(missingTags(), 'tag_backup', 1)"]] },
  { name: 'tag backup uses backup', check: 'adult optional failure', edits: [[reply, "'tag_backup', 1", "'tag_backup', 0"]] },
  { name: 'router player wait', check: 'group router waits', edits: [[worker, 'await router.wait(2000)', 'await router.wait(0)']] },
  { name: 'router maximum wait', check: 'group router waits', edits: [[worker, 'await router.wait(2000)', 'await router.wait(3000)']] },
  { name: 'router autonomy gate', check: 'group router waits', edits: [[worker, "origin === 'player' && template.is_nsfw_capable", 'template.is_nsfw_capable']] },
  { name: 'private intimacy leak', check: 'private adult traits', edits: [['src/services/group-chat/public.ts', "'intimacy', ", '']] },
  { name: 'private voice leak', check: 'private adult traits', edits: [['src/services/group-chat/public.ts', "'voice', ", '']] },

]
try {
  await cp(join(server, 'src'), join(root, 'src'), { recursive: true })
  await cp(join(server, 'worker'), join(root, 'worker'), { recursive: true })
  await cp(join(server, 'scripts', auditFiles[0]), join(root, 'scripts', auditFiles[0]), { recursive: true })
  for (const file of auditFiles.slice(1)) await cp(join(server, 'scripts', file), join(root, 'scripts', file))
  await symlink(join(server, 'node_modules'), join(root, 'node_modules'), 'dir')
  let rejected = 0
  for (const mutation of mutations) {
    const originals = new Map<string, string>()
    try {
      for (const [file, from, to] of mutation.edits) {
        const path = join(root, file), text = await readFile(path, 'utf8')
        if (!originals.has(path)) originals.set(path, text)
        assert(text.includes(from), `${mutation.name}: mutation target missing: ${from}`)
        await writeFile(path, text.replaceAll(from, to))
      }
      const child = Bun.spawn(['bun', '--no-env-file', 'run', `scripts/${mutation.script || 'group-chat-audit.ts'}`], {
        cwd: root, env: { ...process.env, GROUP_AUDIT_ONLY: mutation.check }, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
      })
      const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      assert.notEqual(code, 0, `${mutation.name}: audit accepted broken behavior\n${output}`)
      assert((output + errors).includes(`FAIL ${mutation.check}`), `${mutation.name}: failed outside intended check\n${output}\n${errors}`)
      rejected++; console.log(`BITE ${mutation.name}: exit ${code}; FAIL ${mutation.check}`)
    } finally { for (const [path, original] of originals) await writeFile(path, original) }
  }
  console.log(`group-chat bites: ${rejected}/${mutations.length} mutations rejected; scratch sources restored and removed`)
} finally { await rm(root, { recursive: true, force: true }) }
