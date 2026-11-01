import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// Mutants live under scripts/, inside this task's writable paths. Only source
// and audit files are copied; no environment files or credentials are read.
const root = await mkdtemp(join(import.meta.dir, '.group-chat-bites-'))
const server = new URL('..', import.meta.url).pathname
const auditFiles = ['group-chat-audit.ts', 'group-chat-fixtures.ts', 'prompt-part-hash-audit.ts', 'codex-media-carryover-audit.ts', 'seed-catalog.ts']
type Edit = [file: string, from: string, to: string]
type Mutation = { name: string; check: string; edits: Edit[] }
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
  { name: 'per-person cap', check: 'two per person', edits: [[lines, '>= 2 ||', '>= 3 ||']] },
  { name: 'catchup cap', check: 'two per person', edits: [[lines, 'kept.length >= 4', 'kept.length >= 5']] },
  { name: 'normalized duplicate', check: 'duplicates from', edits: [[lines, 'text.toLowerCase().replace', 'text.replace']] },
  { name: 'last-five duplicate', check: 'duplicates from', edits: [[lines, '.slice(-5)', '.slice(-4)']] },
  { name: 'opening duplicate', check: 'duplicates from', edits: [[lines, '...options.openings.filter(other => other.name === line.name),', '']] },
  { name: 'unsafe output', check: 'generated unsafe', edits: [[lines, 'if (options.blocked(line.text))', 'if (false)']] },
  { name: 'typing spacing', check: 'reveal spacing', edits: [[lines, 'at += 1500', 'at += 500']] },
  { name: 'unstable static prefix', check: 'static prompt identical', edits: [[prompt, "return parts.join('\\n\\n')", "return parts.join('\\n\\n') + Math.random()"]] },
  { name: 'tag repair', check: 'tag repair merged', edits: [[reply, '...await attempt(missingTags())', '...[]']] },
  { name: 'adult validation', check: 'group validation rejects', edits: [['src/services/group-chat/validation.ts', 'traits.age < 18', 'traits.age < 16']] },
  { name: 'seed refuses minor', check: 'seed validation refuses', edits: [['scripts/seed-catalog.ts', '  validateGroup(data)', '  // validation removed'], ['src/schemas/template.schema.ts', 'age: t.Number({ minimum: 18 })', 'age: t.Number({ minimum: 16 })']] },
  { name: 'seed opening', check: 'creation seeds', edits: [['src/services/instance.service.ts', "      await seedGroupOpening(instance, template, player?.preferences?.player_name || 'Player')", '      // missing opening']] },
  { name: 'persist reply', check: 'fake-model player turn', edits: [[worker, 'await mongoColl.events().insertOne(event)', 'await mongoColl.events().insertOne({ ...event, data: { ...event.data, lines: [] } })']] },
  { name: 'real tag repair', check: 'real processor tagged', edits: [[worker, 'tags: roll.tags,', 'tags: [],']] },
  { name: 'last-five outside recent window', check: 'last-five duplicate history', edits: [[worker, 'previous: previousLines,', 'previous: history,']] },
  { name: 'input guard', check: 'input guard blocks', edits: [[worker, 'if (guard.blocked)', 'if (false)']] },
  { name: 'topic cursor', check: 'unprompted and catchup', edits: [[worker, "state.topics_used + (origin === 'player' ? 0 : 1)", 'state.topics_used']] },
  { name: 'adult consent gates', check: 'toggle off never', edits: [[worker, "enabled: fresh?.preferences?.nsfw_enabled === true", 'enabled: true'], [worker, "adult && consent?.preferences?.nsfw_enabled === true", 'adult']] },
  { name: 'curation cadence', check: 'twentieth writing', edits: [[worker, 'if (Math.floor(nextState.writing_calls', 'if (false && Math.floor(nextState.writing_calls']] },
  { name: 'loaded private state', check: 'twentieth writing', edits: [['src/services/group-chat/public.ts', "'group_state',", '']] },
  { name: 'loaded event snapshot', check: 'twentieth writing', edits: [['src/services/media/events.ts', '  delete data.group_state_after', '  // snapshot not stripped'], ['src/services/group-chat/public.ts', "'group_state_after',", '']] },
  { name: 'replay refusal', check: 'group replay is refused', edits: [['src/services/generation.service.ts', 'if (replayInstance?.group_state)', 'if (false)']] },
  { name: 'socket reservation', check: 'existing socket chat', edits: [['src/services/play-ws.service.ts', "await billingService.reserve(user.id, 'story_turn',", "await billingService.reserve(user.id, 'group_turn' as never,"]] },
  { name: 'save cascade', check: 'save and account deletion', edits: [['src/services/deletion.service.ts', '    await events().deleteMany({ instance_id: instanceId })', '    // events not deleted']] },
  { name: 'rewind snapshot', check: 'real rewind restores', edits: [['src/services/memory.service.ts', 'const groupSnapshot = last?.data.group_state_after', 'const groupSnapshot = instance.group_state']] },
  { name: 'group isolation in discovery', check: 'existing discovery', edits: [['src/services/template.service.ts', "if (!filters.kind) clauses.push({ kind: { $ne: 'group' } })", "if (false) clauses.push({ kind: { $ne: 'group' } })"]] },
  { name: 'group-only handoff', check: 'story prompt fixed', edits: [['worker/processors/generation.processor.ts', "if (dispatchedSession.kind === 'group')", "if (dispatchedSession.kind !== 'group')"]] },
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
      const child = Bun.spawn(['bun', '--no-env-file', 'run', 'scripts/group-chat-audit.ts'], {
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
