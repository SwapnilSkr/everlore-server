/** Each mutation is applied alone to our own new code, run, then restored in finally. */
import { readFile, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
type Mutation = { name: string; check: string; file: string; path?: string; changes: Array<[string, string]> }
const root = 'src/services/media/'
const at = (m: Mutation) => m.path ?? root + m.file
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
  { name: 'provider failure releases', check: 'provider_failure', file: 'service.ts', changes: [["    await failMedia(asset, { stage, message: error instanceof Error ? error.message : String(error) })\n  }\n}", "    // omitted release\n  }\n}"]] },
  { name: 'late result deletes uploaded object', check: 'late_result', file: 'service.ts', changes: [["if (!saved.modifiedCount) throw new Error('Voice removed')", "// omitted completion fence"]] },
  { name: 'abandoned reservation recovery', check: 'repair', file: 'service.ts', changes: [["for (const asset of abandoned) await failMedia(asset, { stage: 'repair', message: 'abandoned reservation' })", "for (const asset of abandoned) { /* no recovery */ }"]] },
  { name: 'object deletion', check: 'deletion', file: 'deletion.ts', changes: [["if (asset.asset_key) await storageService.deleteStrict(asset.asset_key)", "// omitted object deletion"]] },
  { name: 'shared save purge integration', check: 'deletion', file: '../deletion.service.ts', changes: [["await purgeMedia({ instance_id: instanceId })", "// omitted shared media purge"]] },
  { name: 'attribution stays private', check: 'revisions_payload', file: 'policy.ts', changes: [["...(voice?.status === 'unvoiceable' ? { voice } : {})", "...(voice ? { voice } : {})"]] },
  { name: 'generated/authored references only', check: 'reference_gate', file: 'portraits.ts', changes: [["return source === 'generated' || source === 'authored'", "return true"]] },
  { name: 'portrait reference is the kept face', check: 'cover_never_face', file: 'visual.ts', changes: [["const bytes = await visualEffects.download(portraitUrl(holder.portrait.asset_key))", "const bytes = await visualEffects.download(template?.image_url || portraitUrl(holder.portrait.asset_key))"]] },
  { name: 'pre-gate blocks generation', check: 'pregate_blocks', file: 'visual.ts', changes: [["if (pre.verdict !== 'allow') throw new UnseenError('pre', pre.reason_code)", "if (false && pre.verdict !== 'allow') throw new UnseenError('pre', pre.reason_code)"]] },
  { name: 'post-gate rejects bad faces', check: 'postgate_deletes', file: 'visual.ts', changes: [["if (post.verdict !== 'allow' || post.people_count !== 1) {", "if (false) {"]] },
  { name: 'rejected shot takes its still', check: 'postgate_deletes', file: 'visual.ts', changes: [["await mediaEffects.remove(stillUp.key)", "/* still retained */"]] },
  { name: 'lasting change needs quoted evidence', check: 'lasting_evidence', file: '../character-codex.service.ts', changes: [["|| (ctx.prose !== undefined && isTurnEvidence(ctx.prose, delta.appearance_evidence))", "|| true"]] },
  { name: 'lasting change needs a whole sentence', check: 'lasting_evidence', file: 'detection.ts', changes: [["return spans.some(([s, e]) => at <= s && e <= end)", "return at >= 0"]] },
  { name: 'current portrait costs nothing', check: 'repaint_on_tap', file: 'visual.ts', changes: [["if (isPortraitCurrent(holder, style.key) && !opts.repaint) {", "if (false) {"]] },
  { name: 'world faces live on the world', check: 'placement', file: 'portraits.ts', changes: [["kind: 'world_cast',", "kind: 'save_card',"]] },
  { name: 'save portraits purged with the save', check: 'purge_portraits', file: 'deletion.ts', changes: [["for (const card of cards) {", "for (const card of []) {"]] },
  { name: 'director validator rejects bad plans', check: 'director_validates', file: 'director.ts', changes: [["if (!nonEmpty(p.ambient)) errors.push('ambient is empty')\n  return errors", "if (!nonEmpty(p.ambient)) errors.push('ambient is empty')\n  return []"]] },
  { name: 'director gets one repair', check: 'director_repair_once', file: 'director.ts', changes: [["let errors = plan ? validateDirectorPlan(plan, input) : ['director output was not JSON']", "let errors: string[] = []"]] },
  { name: 'cut joins overlap 6 frames', check: 'cut_graph', file: 'cut.ts', changes: [["offset = offset - 0.25 + durations[i + 1]", "offset = offset - 0.5 + durations[i + 1]"]] },
  { name: 'still carries continuity', check: 'compile_prompts', file: 'scene-templates.ts', changes: [["`Wardrobe: ${c.wardrobe} Hair: ${c.hair} Props: ${c.props}.`,", "`Hair: ${c.hair} Props: ${c.props}.`,"]] },
  { name: 'empty shots skip the wardrobe match', check: 'shot_judgement', file: 'safety.ts', changes: [["&& (expectedPeople === 0 || frames.every((f) => f.wardrobe_match !== false))", "&& (expectedPeople === 0 && frames.every((f) => f.wardrobe_match !== false))"]] },
  { name: 'pictures rest at the daily cap', check: 'picture_resting', file: 'visual.ts', changes: [["if (!await reserveMedia({ _id: asset._id, player_id: pid, instance_id: iid, event_id: asset.event_id, kind: 'picture' })) {", "if (false && !await reserveMedia({ _id: asset._id, player_id: pid, instance_id: iid, event_id: asset.event_id, kind: 'picture' })) {"]] },
  { name: 'videos rest at the daily cap', check: 'video_resting', file: 'visual.ts', changes: [["if (!await reserveMedia({ _id: asset._id, player_id: pid, instance_id: iid, event_id: asset.event_id, kind: 'video' })) {", "if (false && !await reserveMedia({ _id: asset._id, player_id: pid, instance_id: iid, event_id: asset.event_id, kind: 'video' })) {"]] },
  { name: 'mature lines stay quiet on video', check: 'video_unvoiceable', file: 'visual.ts', changes: [["if (!matureVoiceAllowed(event!.nsfw_intent, user?.preferences?.nsfw_enabled === true)) {\n    throw new HttpError(422, 'This line stays quiet.', { status: 'unvoiceable' })\n  }\n  if (!/^l\\d+$/u.test(lineId))", "if (!/^l\\d+$/u.test(lineId))"]] },
  { name: 'portraits rest at the daily cap', check: 'portrait_resting', file: 'visual.ts', changes: [["if (!await reserveMedia({ _id: row._id, player_id: pid, instance_id: iid, kind })) {", "if (false && !await reserveMedia({ _id: row._id, player_id: pid, instance_id: iid, kind })) {"]] },
  { name: 'replay recomputes offsets', check: 'revisions_payload', file: '../memory.service.ts', changes: [["...spokenLineUpdate(nextAi,", "...({}), // spokenLineUpdate(nextAi,"]] },
  // ── media-server-2-fix-1 ──
  { name: 'instance param name shared', check: 'route_boot', path: 'src/routes/media.routes.ts', changes: [[".post('/instances/:id/events/:eventId/picture'", ".post('/instances/:instanceId/events/:eventId/picture'"]] },
  { name: 'malformed pre verdict throws', check: 'pregate_malformed', file: 'safety.ts', changes: [["if (report.verdict !== 'allow' && report.verdict !== 'reject') throw new Error('Gate returned no verdict')", "if (report.verdict !== 'allow' && report.verdict !== 'reject') return { verdict: 'allow', reason_code: 'ok' }"]] },
  { name: 'malformed post report throws', check: 'postgate_malformed', file: 'safety.ts', changes: [["if (typeof r.people_count !== 'number' || !Number.isFinite(r.people_count)) {\n    throw new Error('Vision gate returned no people count')\n  }", ""]] },
  { name: 'line shot counts exactly one', check: 'line_postcheck', file: 'visual.ts', changes: [["&& linePeople.every((count) => count === 1)", "&& true"]] },
  { name: 'compiled still prompt moderated', check: 'prompt_moderated', file: 'visual.ts', changes: [["if (stillGate.verdict !== 'allow') {", "if (false) {"]] },
  { name: 'thrown still still drops', check: 'line_only_cut', file: 'visual.ts', changes: [["return dropped('shot_failed', [], 0)", "throw new Error('shot_failed')"]] },
  // Without the internal catch the allSettled defensive mapping still drops the
  // shot — the checks assertion above tells the two paths apart, so this one
  // mutation locks both in. A second mutation on the defensive branch itself
  // could never fire and therefore could never bite.
  { name: 'line shot starts with scenes', check: 'line_only_cut', file: 'visual.ts', changes: [["return (async () => {\n    const submitted = await visualEffects.submit({", "return (async () => {\n    await Bun.sleep(9000)\n    const submitted = await visualEffects.submit({"]] },
  { name: 'failed stills stay recorded', check: 'still_cleanup', file: 'visual.ts', changes: [["await mongoColl.mediaAssets().updateOne({ _id: asset._id }, { $set: { still_keys: keys } }).catch(() => {})", ""]] },
  { name: 'director prompt stays verbatim', check: 'director_verbatim', file: 'director.ts', changes: [["Return only JSON matching the schema you are given. Fill every field. Use the speaker's and others' names exactly as given in the input. Never invent ids.", ""]] },
  { name: 'persona face needs no save', check: 'persona_standalone', file: 'visual.ts', changes: [["if (!persona) throw new HttpError(404, 'That face could not be found.')", "if (!persona) throw new HttpError(404, 'That face could not be found.')\n  const needsSave = await mongoColl.worldInstances().findOne({ player_id: pid })\n  if (!needsSave) throw new HttpError(404, 'That face could not be found.')"]] },
  { name: 'reference stores the asset key', check: 'reference_key', file: 'visual.ts', changes: [["...(faces[0] ? { reference_asset_key: faces[0].assetKey } : {}),", "...(faces[0] ? { reference_asset_key: faces[0].name } : {}),"]] },
  { name: 'portraits rest silently', check: 'portrait_resting', file: 'visual.ts', changes: [["portrait: '',", "portrait: 'The requested media waits until tomorrow.',"]] },
  // ── media-server-2-fix-2 ──
  { name: 'portrait paints the moderated description', check: 'portrait_prompt_gated', file: 'visual.ts', changes: [["`${description}. ${render}. SFW head-and-shoulders portrait", "`${appearance}. ${render}. SFW head-and-shoulders portrait"]] },
  { name: 'picture paints the moderated description', check: 'picture_prompt_gated', file: 'visual.ts', changes: [["pictureImagePrompt(description, style.render, faces.length, playerFraming)", "pictureImagePrompt(event.data.ai_response.slice(0, 1500), style.render, faces.length, playerFraming)"]] },
  { name: 'refusal detection is structural', check: 'provider_refusal_detected', path: 'src/ai/image.ts', changes: [["if ((status === 400 || status === 422) && body", "if (false && (status === 400 || status === 422) && body"]] },
  { name: 'portrait refusal is unseen', check: 'provider_refusal_unseen', file: 'visual.ts', changes: [["if (error instanceof ProviderRefusalError) {\n        await unseeMedia(asset, 'provider', providerReason(error), undefined, { message: error.message, status: error.status })\n        return\n      }", "// refusal unseen disabled"]] },
  { name: 'refused face unseen the whole video', check: 'provider_refusal_video_face', file: 'visual.ts', changes: [["// A face the provider will not paint makes the whole video unseen.\n      if (error instanceof ProviderRefusalError) {", "if (false) {"]] },
  { name: 'failed rows carry the error', check: 'failed_row_error', file: 'service.ts', changes: [["error: { stage: cause.stage, message },", ""]] },
  { name: 'trait aliases map catalogue labels', check: 'casting_traits', file: 'policy.ts', changes: [["table[key]?.[value] ?? [value]", "[value]"]] },
  { name: 'invalid traits ignored', check: 'attribution_traits', file: 'policy.ts', changes: [["if (typeof value === 'string' && (list as readonly string[]).includes(value)) out[key] = value", "out[key] = value as string"]] },
  { name: 'child stays unvoiceable', check: 'attribution_traits', file: 'attribution.ts', changes: [["if (!traitsVoiceable(traits)) return no", "if (false) return no"]] },
  { name: 'first cast persists traits', check: 'casting_traits_persist', file: 'casting.ts', changes: [["voice, ...(!hasTraits(fresh) && Object.keys(traits).length ? { voice_traits: traits } : {}),", "voice,"]] },
  // ── media-server-2-fix-3 ──
  { name: 'refusal reason kept', check: 'provider_refusal_unseen', file: 'visual.ts', changes: [["await logRejection(asset, stage, reason, asset.model, message)", "await logRejection(asset, stage, reason, asset.model)"]] },
  { name: 'refused still still counts', check: 'shot_refusal_logged', file: 'visual.ts', changes: [["const message = await logShotRefusal('still_provider_refused', error.message, imageModel())", "const message: string | undefined = undefined"]] },
  // ── media-image-switch (Flux 3 Klein: JPEG by default, sniffed types) ──
  { name: 'jpeg key carries its own extension', check: 'jpeg_portrait_stored', path: 'src/ai/image.ts', changes: [["if (contentType === 'image/jpeg') return '.jpg'", "if (contentType === 'image/jpeg') return '.png'"]] },
  { name: 'downloaded face sniffed, never assumed', check: 'png_reference_sniffed', file: 'visual.ts', changes: [["reference = asMediaImageReference(bytes)", "reference = { data: bytes, contentType: 'image/jpeg' }"]] },
  { name: 'unknown bytes rejected, never guessed', check: 'unknown_image_rejected', path: 'src/ai/image.ts', changes: [["throw new Error('Image bytes are of an unknown type')", "return 'image/png' as const"]] },
  // ── media-world-style ──
  { name: 'cover stays byte-identical', check: 'cover_identical', path: 'src/services/image.service.ts', changes: [["romcom: { render: 'bright modern anime illustration', mood: 'warm and charming' },", "romcom: { render: 'bright modern anime illustration', mood: 'warm and cold' },"]] },
  { name: 'cover decorations strip for screening', check: 'cover_strip', path: 'src/services/image.service.ts', changes: [["[...Object.values(STYLE_HINT).map(hintText), hintText(DEFAULT_HINT), COMPOSITION]", "[...Object.values(STYLE_HINT).map((h) => h.render), hintText(DEFAULT_HINT), COMPOSITION]"]] },
  { name: 'no mood in any media prompt', check: 'no_mood_in_media', file: 'visual.ts', changes: [["return `${description}. ${render}. SFW head-and-shoulders portrait", "return `${description}. ${render}, warm intimate lighting. SFW head-and-shoulders portrait"]] },
  { name: 'anime worlds paint anime', check: 'anime_media_style', path: 'src/services/image.service.ts', changes: [["if (entry && narrativeStyle) return { key: narrativeStyle, render: entry.render }", "if (entry && narrativeStyle) return { key: narrativeStyle, render: PAINTED_RENDER }"]] },
  { name: 'save override never changes art style', check: 'override_ignored', file: 'visual.ts', changes: [["const style = templateMediaStyle(template)\n  if (isPortraitCurrent(holder, style.key) && !opts.repaint) {", "const style = resolveMediaStyle(instance.narrative_style_override || template.narrative_style)\n  if (isPortraitCurrent(holder, style.key) && !opts.repaint) {"]] },
  { name: 'style change makes a portrait out of date', check: 'style_repaint', file: 'portraits.ts', changes: [["&& styleOfPortrait(holder.portrait) === (styleKey || PAINTED_STYLE_KEY)", "&& true"]] },
  { name: 'legacy portrait stays current on painted worlds', check: 'legacy_painted_current', file: 'portraits.ts', changes: [["return portrait?.art_style || PAINTED_STYLE_KEY", "return portrait?.art_style || 'stale'"]] },
  { name: 'persona keeps separate faces per style', check: 'persona_per_style', file: 'portraits.ts', changes: [["if (key !== PAINTED_STYLE_KEY) return persona.portraits?.[key]", "if (key !== PAINTED_STYLE_KEY) return persona.portrait"]] },
  { name: 'picture paints the player face for its world', check: 'picture_persona_style', file: 'visual.ts', changes: [["? await ensurePersonaFaceReady(asset.player_id.toHexString(), instance.persona_id, style.key, style.render)", "? null"]] },
  { name: 'vision gate allows drawn styles', check: 'vision_drawn_styles', file: 'safety.ts', changes: [["painterly, anime, cartoon or semi-photographic", "painterly or semi-photographic"]] },
]
for (const mutation of mutations) {
  const file = at(mutation)
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
