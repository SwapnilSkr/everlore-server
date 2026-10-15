/** Each mutation is applied alone to our own new code, run, then restored in finally. */
import { readFile, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
type Mutation = { name: string; check: string; file: string; changes: Array<[string, string]> }
const root = 'src/services/media/'
const mutations: Mutation[] = [
  { name: 'apostrophe guard', check: 'apostrophes', file: 'detection.ts', changes: [["if (!double && letter(prose[i - 1]) && letter(prose[i + 1])) continue", "if (false && !double && letter(prose[i - 1]) && letter(prose[i + 1])) continue"]] },
  { name: 'unclosed quote rejected', check: 'unclosed', file: 'detection.ts', changes: [["  if (!double && (unmatched || stack.length)) return []", "  if (double && stack.length) spans.push({ start, end: prose.length })\n  if (!double && (unmatched || stack.length)) return []"]] },
  { name: 'outer nested span', check: 'nested', file: 'detection.ts', changes: [["if (!stack.length) start = i", "start = i"]] },
  { name: 'two-word minimum', check: 'bounds', file: 'detection.ts', changes: [["words.length >= 2", "words.length >= 1"]] },
  { name: '400-character maximum', check: 'bounds', file: 'detection.ts', changes: [["text.length <= 400", "text.length <= 500"]] },
  { name: 'paragraph fence', check: 'paragraph', file: 'detection.ts', changes: [["if (/^\\r?\\n[\\t ]*\\r?\\n/u.test(prose.slice(i)))", "if (false && /^\\r?\\n[\\t ]*\\r?\\n/u.test(prose.slice(i)))"], ["&& !/\\r?\\n[\\t ]*\\r?\\n/u.test(text)", "&& true"]] },
  { name: 'all single quotes pair', check: 'single_only', file: 'detection.ts', changes: [["if (!double && (unmatched || stack.length)) return []", "if (false && !double && (unmatched || stack.length)) return []"]] },
  { name: 'player echo removed', check: 'player_echo', file: 'detection.ts', changes: [["!(echo && echo.includes", "!(false && echo.includes"]] },
  { name: 'verbatim evidence gate', check: 'verbatim', file: 'policy.ts', changes: [["compactWhitespace(span).includes(compactWhitespace(spoken))", "true"]] },
  { name: 'player speaker rejected', check: 'speaker', file: 'attribution.ts', changes: [["if (!isSentient && newFoldState(cards.filter((c) => c.is_protagonist)).byName.has(identityKey(name))) return undefined", "// removed player identity guard"], ["if (!card || (!isSentient && card.is_protagonist)) return undefined", "if (!card) return undefined"]] },
  { name: 'one performed tag', check: 'tags', file: 'policy.ts', changes: [[".slice(0, 1) : []", ".slice(0, 2) : []"]] },
  { name: 'allowlisted tags', check: 'tags', file: 'policy.ts', changes: [["(ALLOWED_VOICE_TAGS as readonly string[]).includes(tag)", "true"]] },
  { name: 'atomic attribution claim', check: 'attribution_once', file: 'attribution.ts', changes: [["{ ...filter, 'data.voice_attribution': { $exists: false } }", "{ ...filter }"]] },
  { name: 'prefer unused voice', check: 'casting', file: 'policy.ts', changes: [["!holders.some((holder) => holder.voice_id === voice.id)", "holders.some((holder) => holder.voice_id === voice.id)"]] },
  { name: 'least-recent reuse', check: 'reuse', file: 'policy.ts', changes: [["last(voice.id) < last(winner.id)", "last(voice.id) > last(winner.id)"]] },
  { name: 'shared-holder recency', check: 'reuse', file: 'policy.ts', changes: [["Math.max(0, ...holders.filter", "Math.min(Infinity, ...holders.filter"]] },
  { name: 'persist assigned card voice', check: 'cast_persistence', file: 'casting.ts', changes: [["await mongoColl.characters().updateOne({ _id: fresh._id, instance_id: live._id }, { $set: { voice: existing } })", "// omitted persistence"]] },
  { name: 'fresh mature gate', check: 'mature', file: 'policy.ts', changes: [["=> !intent || optedIn", "=> true"]] },
  { name: 'cache hit reserves nothing', check: 'cache_free', file: 'service.ts', changes: [["    return readyReply(asset) || { status: 'queued', media_id: asset._id.toHexString() }", "    await reserveMedia({ ...asset, _id: new ObjectId() })\n    return readyReply(asset) || { status: 'queued', media_id: asset._id.toHexString() }"]] },
  { name: 'failure frees live slot', check: 'release', file: 'usage.ts', changes: [["$unset: { slot: '' }", "$unset: {}"]] },
  { name: 'hard daily limit', check: 'limit_reset', file: 'usage.ts', changes: [["slot < ceiling", "slot <= ceiling"]] },
  { name: 'UTC midnight reset', check: 'limit_reset', file: 'policy.ts', changes: [["+ 86400000", "+ 172800000"]] },
  { name: '429 when resting', check: 'http_limit', file: 'service.ts', changes: [["if (!await reserveMedia(asset))", "if (false && !await reserveMedia(asset))"]] },
  { name: 'ownership 404', check: 'auth_switch', file: 'service.ts', changes: [["if (!instance) throw new HttpError(404", "if (false && !instance) throw new HttpError(404"]] },
  { name: 'disabled endpoint 404', check: 'auth_switch', file: 'service.ts', changes: [["if (!mediaEnabled('voice')) throw", "if (false && !mediaEnabled('voice')) throw"]] },
  { name: 'delivered reservation settles', check: 'delivery', file: 'service.ts', changes: [["    await settleMedia(_id)", "    await releaseMedia(_id)"]] },
  { name: 'provider failure releases', check: 'provider_failure', file: 'service.ts', changes: [["    await failMedia(asset)\n  }\n}", "    // omitted release\n  }\n}"]] },
  { name: 'late result deletes uploaded object', check: 'late_result', file: 'service.ts', changes: [["if (!saved.modifiedCount) throw new Error('Voice removed')", "// omitted completion fence"]] },
  { name: 'abandoned reservation recovery', check: 'repair', file: 'service.ts', changes: [["for (const asset of abandoned) await failMedia(asset)", "for (const asset of abandoned) { /* no recovery */ }"]] },
  { name: 'object deletion', check: 'deletion', file: 'deletion.ts', changes: [["for (const asset of assets) if (asset.asset_key) await storageService.deleteStrict(asset.asset_key)", "// omitted object deletion"]] },
  { name: 'shared save purge integration', check: 'deletion', file: '../deletion.service.ts', changes: [["await purgeMedia({ instance_id: instanceId })", "// omitted shared media purge"]] },
  { name: 'attribution stays private', check: 'revisions_payload', file: 'policy.ts', changes: [["...(voice?.status === 'unvoiceable' ? { voice } : {})", "...(voice ? { voice } : {})"]] },
  { name: 'replay recomputes offsets', check: 'revisions_payload', file: '../memory.service.ts', changes: [["...spokenLineUpdate(nextAi,", "...({}), // spokenLineUpdate(nextAi,"]] },
]
for (const mutation of mutations) {
  const file = root + mutation.file
  const original = await readFile(file, 'utf8')
  let tampered = original
  for (const [from, to] of mutation.changes) {
    assert.ok(tampered.includes(from), `Missing mutation anchor: ${mutation.name}`)
    tampered = tampered.replace(from, to)
  }
  try {
    await writeFile(file, tampered)
    const child = Bun.spawn(['bun', 'run', 'scripts/media-audit.ts', '--check', mutation.check], { stdout: 'pipe', stderr: 'pipe' })
    const [out, err, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    assert.notEqual(status, 0, `DID NOT BITE: ${mutation.name}\n${out}\n${err}`)
    assert.ok(err.includes(`FAIL ${mutation.check}:`), `Must fail the named assertion, not syntax/typechecking: ${mutation.name}\n${err}`)
    console.log(`BITE ${mutation.name}: exit ${status}; ${err.split('\n').find((line) => line.startsWith('FAIL '))}`)
  } finally {
    await writeFile(file, original)
  }
}
console.log(`All ${mutations.length} mutations failed their named check; every source restored.`)
