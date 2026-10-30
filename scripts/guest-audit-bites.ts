/** Mutate one invariant at a time, run the real isolated integration audit,
 * require its assertion to fail, then restore the exact pre-run source. */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, cpSync, symlinkSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const root = new URL('..', import.meta.url).pathname
const mutations = [
  { name: 'sixth turn admitted', file: 'src/services/guest-policy.ts',
    before: 'GUEST_TURN_LIMIT = 5', after: 'GUEST_TURN_LIMIT = 6', failure: /6 !== 5/ },
  { name: 'claim replaced by a new account', file: 'src/services/auth.service.ts',
    before: 'const claimed = await guestService.claim(guestId, identity, provider)', after: 'const claimed = null', failure: /assert.equal\(claimed.body.user.id/ },
  { name: 'persona omitted from merge', file: 'src/services/account-references.ts',
    before: "'characters', 'entities', 'personas',", after: "'characters', 'entities',", failure: /did not move personas/ },
  { name: 'existing interests overwritten', file: 'src/services/guest.service.ts',
    before: "{ _id: target._id, $or: [\n            { 'preferences.interests': { $exists: false } }, { 'preferences.interests': { $size: 0 } },\n          ] }",
    after: '{ _id: target._id }', failure: /existing-interest/ },
  { name: 'null identity on guest', file: 'src/services/guest.service.ts',
    before: 'guest: true, install_id: installId, guest_turns: 0,', after: 'guest: true, install_id: installId, guest_turns: 0, phone: null,', failure: /true !== false/ },
  { name: 'age gate bypassed', file: 'src/services/auth.service.ts',
    before: 'body.nsfw_enabled === true && !user.age_confirmed_at && body.age_confirmed !== true', after: 'false', failure: /age gate must refuse/ },
  { name: 'confirmation not persisted', file: 'src/services/auth.service.ts',
    before: 'if (body.age_confirmed === true)', after: 'if (false)', failure: /instanceof Date/ },
  { name: 'second confirmation moves timestamp', file: 'src/services/auth.service.ts',
    before: '{ _id: user._id, age_confirmed_at: { $exists: false } }', after: '{ _id: user._id }', failure: /second confirmation moved timestamp/ },
  { name: 'off wrongly requires confirmation', file: 'src/services/auth.service.ts',
    before: 'body.nsfw_enabled === true && !user.age_confirmed_at', after: 'body.nsfw_enabled === false && !user.age_confirmed_at', failure: /400 !== 200/ },
  { name: 'age omitted from user JSON', file: 'src/services/auth.service.ts',
    before: '...(user.age_confirmed_at ? { age_confirmed_at: user.age_confirmed_at.toISOString() } : {}),', after: '', failure: /age timestamp must serialize as ISO/ },
  { name: 'null age on guest creation', file: 'src/services/guest.service.ts',
    before: 'guest: true, install_id: installId, guest_turns: 0,', after: 'guest: true, install_id: installId, guest_turns: 0, age_confirmed_at: null,', failure: /true !== false/ },
  { name: 'guest mature forced off on write', file: 'src/services/auth.service.ts',
    before: 'updateFields.updated_at = new Date()', after: "if (user.guest) updateFields['preferences.nsfw_enabled'] = false; updateFields.updated_at = new Date()", failure: /guest mature must follow/ },
  { name: 'guest mature forced off in JSON', file: 'src/services/auth.service.ts',
    before: 'preferences: user.preferences,', after: 'preferences: user.guest ? { ...user.preferences, nsfw_enabled: false } : user.preferences,', failure: /guest mature must follow/ },
  { name: 'catalog world refused for guest', file: 'src/services/instance.service.ts',
    before: "if (!template) throw new HttpError(404, 'Template not found')", after: "if (!template) throw new HttpError(404, 'Template not found'); if (template.is_nsfw_capable) throw new HttpError(403, 'audit guest refusal')", failure: /audit guest refusal/ },
  { name: 'primary dispatch forces guest mature off', file: 'src/services/generation.service.ts',
    before: 'const userNsfwEnabled = player?.preferences?.nsfw_enabled === true', after: 'const userNsfwEnabled = false', failure: /primary dispatch forced guest mature off/ },
  { name: 'replay forces guest mature off', file: 'src/services/memory.service.ts',
    before: 'const userNsfwEnabled = player?.preferences?.nsfw_enabled === true', after: 'const userNsfwEnabled = false', failure: /replay forced guest mature off/ },
  { name: 'claim loses mature choice', file: 'src/services/guest.service.ts',
    before: '$set: { ...identity, providers: [provider], updated_at: new Date() }', after: "$set: { ...identity, providers: [provider], updated_at: new Date(), 'preferences.nsfw_enabled': false }", failure: /claim lost guest mature choice/ },
  { name: 'merge drops guest age', file: 'src/services/guest.service.ts',
    before: 'if (source.age_confirmed_at)', after: 'if (false)', failure: /merge lost guest age confirmation/ },
  { name: 'merge overwrites existing age', file: 'src/services/guest.service.ts',
    before: '{ _id: target._id, age_confirmed_at: { $exists: false } }', after: '{ _id: target._id }', failure: /merge overwrote existing age confirmation/ },
  { name: 'merge writes null age', file: 'src/services/guest.service.ts',
    before: 'if (source.age_confirmed_at)', after: 'if (true)', failure: /unconfirmed merge wrote an age value/ },
  { name: 'real deletion purges retained billing and reports', file: 'src/services/deletion.service.ts',
    before: 'purgeAccountReferences(pid, user.guest === true)', after: 'purgeAccountReferences(pid, true)', failure: /real deletion changed retained/ },
  { name: 'real deletion loses save-scoped media usage', file: 'src/services/media/deletion.ts',
    before: 'retainUsageFor ? { $and: [filter, { player_id: { $ne: retainUsageFor } }] } : filter', after: 'filter', failure: /real deletion changed retained media_usage/ },
  { name: 'guest purge retains billing and reports', file: 'src/services/deletion.service.ts',
    before: 'purgeAccountReferences(pid, user.guest === true)', after: 'purgeAccountReferences(pid, false)', failure: /retains deleted guest/ },
  { name: 'merge scans terminal BullMQ history', file: 'src/services/guest.service.ts',
    before: 'const transfer = await closeGuestRequests(from)', after: "await queues[0].getJobs(['completed', 'failed']); const transfer = await closeGuestRequests(from)", failure: /merge scanned terminal job history/ },
  { name: 'merge ignores active and waiting work', file: 'src/services/guest.service.ts',
    before: "const jobs = await queue.getJobs(['active', 'waiting', 'delayed', 'paused', 'prioritized', 'waiting-children'])", after: 'const jobs = []', failure: /Missing expected rejection/ },
  { name: 'expiry aborts on one failed merge', file: 'src/services/guest-expiry.service.ts',
    before: "} catch {\n      console.warn('Guest expiry merge failed'", after: "} catch (error) {\n      throw error; console.warn('Guest expiry merge failed'", failure: /expiry aborted after an individual failure/ },
  { name: 'expiry aborts on one failed purge', file: 'src/services/guest-expiry.service.ts',
    before: "} catch {\n      console.warn('Guest expiry purge failed'", after: "} catch (error) {\n      throw error; console.warn('Guest expiry purge failed'", failure: /expiry aborted after an individual failure/ },
]
const scratch = mkdtempSync(join(tmpdir(), 'everlore-guest-bites-'))
try {
  for (const dir of ['src', 'worker', 'scripts']) cpSync(join(root, dir), join(scratch, dir), { recursive: true,
    filter: path => !path.split('/').at(-1)!.startsWith('.env'),
  })
  cpSync(join(root, 'package.json'), join(scratch, 'package.json'))
  symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir')
  for (const mutation of mutations) {
    const file = join(scratch, mutation.file), original = readFileSync(file, 'utf8')
    assert.ok(original.includes(mutation.before), `mutation anchor missing: ${mutation.name}`)
    try {
      writeFileSync(file, original.replace(mutation.before, mutation.after))
      const process = Bun.spawn(['bun', '--no-env-file', 'run', join(scratch, 'scripts/guest-audit.ts'), '--no-fallback'], { cwd: scratch, stdout: 'pipe', stderr: 'pipe' })
      const [out, err, status] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited])
      assert.notEqual(status, 0, `${mutation.name}: the audit stayed green`)
      assert.match(out + err, /AssertionError/, `${mutation.name}: did not fail an assertion`)
      assert.match(out + err, mutation.failure, `${mutation.name}: wrong assertion failed\n${out}\n${err}`)
      console.log(`BITE ${mutation.name}: audit exited ${status}, expected assertion failed; scratch source restored`)
    } finally { writeFileSync(file, original) }
  }
  console.log(`guest bites: ${mutations.length}/${mutations.length} detected`)
} finally { rmSync(scratch, { recursive: true, force: true }) }
