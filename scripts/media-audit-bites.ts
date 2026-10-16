/** Each mutation is loaded in memory in an isolated child; working-tree files are never edited. */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
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
  { name: 'atomic attribution claim', check: 'attribution_once', file: 'attribution.ts', changes: [["{ ...filter, ...claimable }", "{ ...filter }"]] },
  { name: 'prefer unused voice', check: 'casting', file: 'policy.ts', changes: [["!holders.some((holder) => holder.voice_id === voice.id)", "holders.some((holder) => holder.voice_id === voice.id)"]] },
  { name: 'least-recent reuse', check: 'reuse', file: 'policy.ts', changes: [["last(voice.id) < last(winner.id)", "last(voice.id) > last(winner.id)"]] },
  { name: 'shared-holder recency', check: 'reuse', file: 'policy.ts', changes: [["Math.max(0, ...holders.filter", "Math.min(Infinity, ...holders.filter"]] },
  { name: 'persist assigned card voice', check: 'cast_persistence', file: 'casting.ts', changes: [["await mongoColl.characters().updateOne({ _id: fresh._id, instance_id: live._id }, { $set: { voice: existing } })", "// omitted persistence"]] },
  { name: 'fresh mature gate', check: 'mature', file: 'policy.ts', changes: [["=> !intent || optedIn", "=> true"]] },
  { name: 'cache hit reserves nothing', check: 'cache_free', file: 'service.ts', changes: [["    return readyReply(asset) || { status: 'queued', media_id: asset._id.toHexString() }", "    await reserveMedia({ ...asset, _id: new ObjectId() })\n    return readyReply(asset) || { status: 'queued', media_id: asset._id.toHexString() }"]] },
  { name: 'failure frees live slot', check: 'release', file: 'usage.ts', changes: [["$unset: { slot: '' }", "$unset: {}"]] },
  { name: 'hard daily limit', check: 'limit_reset', file: 'usage.ts', changes: [["slot < ceiling", "slot <= ceiling"]] },
  { name: 'UTC midnight reset', check: 'limit_reset', file: 'policy.ts', changes: [["+ 86400000", "+ 172800000"]] },
  { name: '429 when resting', check: 'http_limit', file: 'service.ts', changes: [["if (!await reserveMedia({ ...asset, kind: 'voice' }))", "if (false && !await reserveMedia({ ...asset, kind: 'voice' }))"]] },
  { name: 'ownership 404', check: 'auth_switch', file: 'service.ts', changes: [["if (!instance) throw new HttpError(404", "if (false && !instance) throw new HttpError(404"]] },
  { name: 'disabled endpoint 404', check: 'auth_switch', file: 'service.ts', changes: [["if (!mediaEnabled('voice')) throw", "if (false && !mediaEnabled('voice')) throw"]] },
  { name: 'delivered reservation settles', check: 'delivery', file: 'service.ts', changes: [["    await settleMedia(_id)", "    await releaseMedia(_id)"]] },
  { name: 'provider failure releases', check: 'provider_failure', file: 'service.ts', changes: [["    await failMedia(asset, { stage, message: error instanceof Error ? error.message : String(error) })\n  }\n}", "    // omitted release\n  }\n}"]] },
  { name: 'late result deletes uploaded object', check: 'late_result', file: 'service.ts', changes: [["if (!saved.modifiedCount) throw new Error('Voice removed')", "// omitted completion fence"]] },
  { name: 'abandoned reservation recovery', check: 'repair', file: 'service.ts', changes: [["for (const asset of abandoned) await failMedia(asset, { stage: 'repair', message: 'abandoned reservation' })", "for (const asset of abandoned) { /* no recovery */ }"]] },
  { name: 'object deletion', check: 'deletion', file: 'deletion.ts', changes: [["if (asset.asset_key) await storageService.deleteStrict(asset.asset_key)", "// omitted object deletion"]] },
  { name: 'shared save purge integration', check: 'deletion', file: '../deletion.service.ts', changes: [["await purgeMedia({ instance_id: instanceId })", "// omitted shared media purge"]] },
  { name: 'attribution stays private', check: 'revisions_payload', file: 'policy.ts', changes: [["...(attributionIsCurrent && voice?.status === 'unvoiceable' ? { voice } : {})", "...(voice ? { voice } : {})"]] },
  { name: 'generated/authored references only', check: 'reference_gate', file: 'portraits.ts', changes: [["return source === 'generated' || source === 'authored'", "return true"]] },
  { name: 'portrait reference is the kept face', check: 'cover_never_face', file: 'visual.ts', changes: [["const bytes = await visualEffects.download(portraitUrl(holder.portrait.asset_key))", "const bytes = await visualEffects.download(template?.image_url || portraitUrl(holder.portrait.asset_key))"]] },
  { name: 'pre-gate blocks generation', check: 'pregate_blocks', file: 'visual.ts', changes: [["if (pre.verdict !== 'allow') throw new UnseenError('pre', pre.reason_code)", "if (false && pre.verdict !== 'allow') throw new UnseenError('pre', pre.reason_code)"]] },
  { name: 'post-gate rejects bad faces', check: 'postgate_deletes', file: 'visual.ts', changes: [["if (post.verdict !== 'allow' || post.text_visible || post.people_count !== 1) {", "if (false) {"]] },
  { name: 'rejected shot takes its still', check: 'postgate_deletes', file: 'visual.ts', changes: [["await mediaEffects.remove(stillUp.key)", "/* still retained */"]] },
  { name: 'lasting change needs quoted evidence', check: 'lasting_evidence', file: '../character-codex.service.ts', changes: [["|| (ctx.prose !== undefined && isTurnEvidence(ctx.prose, delta.appearance_evidence))", "|| true"]] },
  { name: 'lasting change needs a whole sentence', check: 'lasting_evidence', file: 'detection.ts', changes: [["return spans.some(([s, e]) => at <= s && e <= end)", "return at >= 0"]] },
  { name: 'current portrait costs nothing', check: 'repaint_on_tap', file: 'visual.ts', changes: [["if (isPortraitCurrent(holder, style.key) && !opts.repaint) {", "if (false) {"]] },
  { name: 'world faces live on the world', check: 'placement', file: 'portraits.ts', changes: [["kind: 'world_cast',", "kind: 'save_card',"]] },
  { name: 'save portraits purged with the save', check: 'purge_portraits', file: 'deletion.ts', changes: [["for (const card of cards) {", "for (const card of []) {"]] },
  { name: 'director validator rejects bad plans', check: 'director_validates', file: 'director.ts', changes: [["if (!nonEmpty(p.ambient)) errors.push('ambient is empty')\n  return errors", "if (!nonEmpty(p.ambient)) errors.push('ambient is empty')\n  return []"]] },
  { name: 'director gets one repair', check: 'director_repair_once', file: 'director.ts', changes: [["let errors = plan ? validateDirectorPlan(plan, input) : ['director output was not JSON']", "let errors: string[] = []"]] },
  { name: 'cut joins overlap 6 frames', check: 'cut_graph', file: 'cut.ts', changes: [["offset = offset - 0.25 + durations[i + 1]", "offset = offset - 0.5 + durations[i + 1]"]] },
  { name: 'still carries continuity', check: 'compile_prompts', file: 'scene-templates.ts', changes: [["Wardrobe: ${c.wardrobe} Hair: ${c.hair}", "Hair: ${c.hair}"]] },
  { name: 'empty shots skip the wardrobe match', check: 'shot_judgement', file: 'safety.ts', changes: [["&& (expectedPeople === 0 || frames.every((f) => f.wardrobe_match !== false))", "&& (expectedPeople === 0 && frames.every((f) => f.wardrobe_match !== false))"]] },
  { name: 'pictures rest at the daily cap', check: 'picture_resting', file: 'visual.ts', changes: [["if (!await reserveMedia({ _id: asset._id, player_id: pid, instance_id: iid, event_id: asset.event_id, kind: 'picture' })) {", "if (false && !await reserveMedia({ _id: asset._id, player_id: pid, instance_id: iid, event_id: asset.event_id, kind: 'picture' })) {"]] },
  { name: 'videos rest at the daily cap', check: 'video_resting', file: 'visual.ts', changes: [["if (!await reserveMedia({ _id: asset._id, player_id: pid, instance_id: iid, event_id: asset.event_id, kind: 'video' })) {", "if (false && !await reserveMedia({ _id: asset._id, player_id: pid, instance_id: iid, event_id: asset.event_id, kind: 'video' })) {"]] },
  { name: 'mature lines stay quiet on video', check: 'video_unvoiceable', file: 'visual.ts', changes: [["if (!matureVoiceAllowed(event!.nsfw_intent, user?.preferences?.nsfw_enabled === true)) {\n    throw new HttpError(422, 'This line stays quiet.', { status: 'unvoiceable' })\n  }\n  if (!/^l\\d+$/u.test(lineId))", "if (!/^l\\d+$/u.test(lineId))"]] },
  { name: 'portraits rest at the daily cap', check: 'portrait_resting', file: 'visual.ts', changes: [["if (!await reserveMedia({ _id: row._id, player_id: pid, instance_id: iid, kind })) {", "if (false && !await reserveMedia({ _id: row._id, player_id: pid, instance_id: iid, kind })) {"]] },
  { name: 'replay recomputes offsets', check: 'revisions_payload', file: '../memory.service.ts', changes: [["...spokenLineUpdate(nextAi,", "...({}), // spokenLineUpdate(nextAi,"]] },
  // ── media-server-2-fix-1 ──
  { name: 'load path filters media', check: 'load_instance_filters_media', path: 'src/services/generation.service.ts', changes: [["const filtered = recentEvents.map(publicMediaEvent)", "const filtered = recentEvents"]] },
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
  { name: 'portrait paints the moderated description', check: 'portrait_prompt_gated', file: 'visual.ts', changes: [["`${description}. ${render}. head-and-shoulders portrait", "`${appearance}. ${render}. head-and-shoulders portrait"]] },
  { name: 'picture paints the moderated description', check: 'picture_prompt_gated', file: 'visual.ts', changes: [["pictureImagePrompt(description, style.render, faces.length, playerFraming)", "pictureImagePrompt(event.data.ai_response.slice(0, 1500), style.render, faces.length, playerFraming)"]] },
  { name: 'refusal detection is structural', check: 'provider_refusal_detected', path: 'src/ai/image.ts', changes: [["if ((status === 400 || status === 422) && body", "if (false && (status === 400 || status === 422) && body"]] },
  { name: 'portrait refusal is unseen', check: 'provider_refusal_unseen', file: 'visual.ts', changes: [["if (error instanceof ProviderRefusalError) {\n        await unseeMedia(asset, 'provider', providerReason(error), undefined, { message: error.message, status: error.status })\n        return\n      }", "// refusal unseen disabled"]] },
  { name: 'refused face unseen the whole video', check: 'provider_refusal_video_face', file: 'visual.ts', changes: [["// A face the provider will not paint makes the whole video unseen.\n      if (error instanceof ProviderRefusalError) {", "if (false) {"]] },
  { name: 'failed rows carry the error', check: 'failed_row_error', file: 'service.ts', changes: [["error: { stage: cause.stage, message },", ""]] },
  { name: 'trait aliases map catalogue labels', check: 'casting_traits', file: 'policy.ts', changes: [["table[key]?.[value] ?? [value]", "[value]"]] },
  { name: 'invalid traits ignored', check: 'attribution_traits', file: 'policy.ts', changes: [["if (typeof value === 'string' && (list as readonly string[]).includes(value)) out[key] = value", "out[key] = value as string"]] },

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
  { name: 'no mood in any media prompt', check: 'no_mood_in_media', file: 'visual.ts', changes: [["return `${description}. ${render}. head-and-shoulders portrait", "return `${description}. ${render}, warm intimate lighting. head-and-shoulders portrait"]] },
  { name: 'anime worlds paint anime', check: 'anime_media_style', path: 'src/services/image.service.ts', changes: [["if (entry && narrativeStyle) return { key: narrativeStyle, render: entry.media || entry.render }", "if (entry && narrativeStyle) return { key: narrativeStyle, render: PAINTED_RENDER }"]] },
  { name: 'save override never changes art style', check: 'override_ignored', file: 'visual.ts', changes: [["const style = templateMediaStyle(template)\n  if (isPortraitCurrent(holder, style.key) && !opts.repaint) {", "const style = resolveMediaStyle(instance.narrative_style_override || template.narrative_style)\n  if (isPortraitCurrent(holder, style.key) && !opts.repaint) {"]] },
  { name: 'style change makes a portrait out of date', check: 'style_repaint', file: 'portraits.ts', changes: [["&& styleOfPortrait(holder.portrait) === (styleKey || PAINTED_STYLE_KEY)", "&& true"]] },
  { name: 'legacy portrait stays current on painted worlds', check: 'legacy_painted_current', file: 'portraits.ts', changes: [["return portrait?.art_style || PAINTED_STYLE_KEY", "return portrait?.art_style || 'stale'"]] },
  { name: 'persona keeps separate faces per style', check: 'persona_per_style', file: 'portraits.ts', changes: [["if (key !== PAINTED_STYLE_KEY) return persona.portraits?.[key]", "if (key !== PAINTED_STYLE_KEY) return persona.portrait"]] },
  { name: 'picture paints the player face for its world', check: 'picture_persona_style', file: 'visual.ts', changes: [["? await ensurePersonaFaceReady(asset.player_id.toHexString(), instance.persona_id, style.key, style.render)", "? null"]] },
  { name: 'vision gate allows drawn styles', check: 'vision_drawn_styles', file: 'safety.ts', changes: [["painterly, anime, cartoon or semi-photographic", "painterly or semi-photographic"]] },
  // ── media-picture-parallel-faces ──
  { name: 'faces paint at the same time', check: 'picture_faces_parallel', file: 'visual.ts', changes: [["const settled = await Promise.allSettled(faceRuns.map((run) => run()))", "const settled: Array<{ status: 'fulfilled'; value: { name: string; bytes: Buffer; contentType: string; assetKey: string; painted: boolean } } | { status: 'rejected'; reason: unknown }> = []\n    for (const run of faceRuns) { try { settled.push({ status: 'fulfilled', value: await run() }) } catch (error) { settled.push({ status: 'rejected', reason: error }) } }"]] },
  { name: 'one paint per face', check: 'picture_faces_single_paint', file: 'visual.ts', changes: [["  const flight = portraitFlights.get(cacheKey)\n  if (flight) {", "  const flight = portraitFlights.get(cacheKey)\n  if (false && flight) {"], ["source: 'generated', model, cache_key: cacheKey,", "source: 'generated', model, cache_key: `${cacheKey}:${id.toHexString()}`,"]] },
  { name: 'refused face releases its claim', check: 'picture_face_failure_releases', file: 'visual.ts', changes: [["      } catch (error) {\n        await mongoColl.mediaAssets().deleteOne({ _id: id })", "      } catch (error) {\n        // claim retained"]] },
  { name: 'portrait allowance gates faces', check: 'picture_faces_allowance_edge', file: 'visual.ts', changes: [["if (!await reserveMedia({ _id: id, player_id: pid, instance_id: iid, kind: 'portrait' })) {", "if (false && !await reserveMedia({ _id: id, player_id: pid, instance_id: iid, kind: 'portrait' })) {"]] },
  // ── media-world-style-fix-1 ──
  { name: 'flirty media render has no mood word', check: 'no_mood_in_media', path: 'src/services/image.service.ts', changes: [["media: 'vibrant anime illustration, warm expressive'", "media: 'sensual anime illustration, warm expressive'"]] },
  { name: 'portrait prompt refuses text', check: 'portrait_no_text', file: 'visual.ts', changes: [["never a photograph, no text, no lettering, no signage.", "never a photograph."]] },
  { name: 'portrait post-gate rejects text', check: 'portrait_no_text', file: 'visual.ts', changes: [["if (post.verdict !== 'allow' || post.text_visible || post.people_count !== 1) {", "if (post.verdict !== 'allow' || post.people_count !== 1) {"]] },
  { name: 'persona portrait route takes the save', check: 'persona_route_takes_save', path: 'src/routes/media.routes.ts', changes: [["return queued(await requestPersonaPortrait(user.id, params.personaId,\n        { ...(query?.instance_id ? { instanceId: query.instance_id } : {}) }), set)", "return queued(await requestPersonaPortrait(user.id, params.personaId), set)"]] },
  { name: 'persona deletion removes face rows', check: 'persona_delete_cleans_faces', path: 'src/services/persona.service.ts', changes: [["await mongoColl.mediaAssets().deleteMany({ persona_id: personaOid, player_id: pid })", "// omitted face-row deletion"]] },
  { name: 'persona deletion removes face objects', check: 'persona_delete_cleans_faces', path: 'src/services/persona.service.ts', changes: [["for (const key of new Set(keys)) await storageService.delete(key)", "// omitted face-object deletion"]] },

  // ── media-every-line-fix-1 ──
  { name: 'uncarded description gets a line voice', check: 'every_description', file: 'attribution.ts', changes: [["if (!card && seed === undefined) return no", "if (!card) return no"]] },
  { name: 'uncarded speech writes no characters row', check: 'every_description', file: 'attribution.ts', changes: [["      lines[index] = accepted", "      await mongoColl.characters().insertOne({ _id: event._id }); lines[index] = accepted"]] },
  { name: 'handle seed includes the save', check: 'every_seed', file: 'attribution.ts', changes: [["[event.instance_id.toHexString(), identityKey(handle)]", "['all-saves', identityKey(handle)]"]] },
  { name: 'handle seed normalizes the handle', check: 'every_seed', file: 'attribution.ts', changes: [["[event.instance_id.toHexString(), identityKey(handle)]", "[event.instance_id.toHexString(), handle]"]] },
  { name: 'same handle keeps its voice across turns', check: 'every_later_description', file: 'attribution.ts', changes: [["[event.instance_id.toHexString(), identityKey(handle)]", "[event._id.toHexString(), identityKey(handle)]"]] },
  { name: 'no-handle seed includes event', check: 'every_no_handle', file: 'attribution.ts', changes: [["[event._id.toHexString(), line.line_id]", "['all-events', line.line_id]"]] },
  { name: 'no-handle seed includes line', check: 'every_no_handle', file: 'attribution.ts', changes: [["[event._id.toHexString(), line.line_id]", "[event._id.toHexString(), 'all-lines']"]] },
  { name: 'speech accepts voices stored on the line', check: 'every_description', file: 'service.ts', changes: [["  if (line.voice.voice_id && line.voice.model) return", "  if (!card) throw new Error('uncarded voice rejected'); if (line.voice.voice_id && line.voice.model) return"]] },
  { name: 'later cards supply new lines', check: 'every_later_card', file: 'attribution.ts', changes: [["const speaker = handle ? resolveVoiceSpeaker(handle, cards, isSentient, personaName) : undefined", "const speaker = undefined"]] },
  { name: 'old lines keep their voice after a card appears', check: 'every_later_card', file: 'service.ts', changes: [["  if (line.voice.voice_id && line.voice.model) return", "  if (!card) card = await mongoColl.characters().findOne({ instance_id: instance._id }); if (card) return mediaEffects.cast(instance, card); if (line.voice.voice_id && line.voice.model) return"]] },
  { name: 'unclear gender still voices', check: 'every_unclear', file: 'attribution.ts', changes: [["const traits = filterVoiceTraits(r)", "const traits = filterVoiceTraits(r); if (traits.gender_presentation === 'unclear') return no"]] },
  { name: 'unclear gender withholds its vote', check: 'every_unclear', file: 'voices/eleven-v4-turbo.json', changes: [['"unclear": [],', '"unclear": ["female"],']] },
  { name: 'child still voices', check: 'every_child', file: 'attribution.ts', changes: [["const traits = filterVoiceTraits(r)", "const traits = filterVoiceTraits(r); if (traits.age_band === 'child') return no"]] },
  { name: 'child catalogue selects light adults', check: 'every_child', file: 'voices/eleven-v4-turbo.json', changes: [['"child": ["young_light_adult"]', '"child": []']] },
  { name: 'sign stays refused', check: 'every_refusals', file: 'attribution.ts', changes: [["r.is_speech !== true || ", ""]] },
  { name: 'player stays refused', check: 'every_refusals', file: 'attribution.ts', changes: [["if (isPlayer || (playerWords && playerWords.includes(spoken))) continue", "if (playerWords && playerWords.includes(spoken)) continue"]] },
  { name: 'non-verbatim speech stays refused', check: 'every_refusals', file: 'attribution.ts', changes: [["if (!isVerbatim(prose.slice(line.start + 1, line.end - 1), r.spoken_text)) return undefined", "// omitted verbatim gate"]] },
  { name: 'invented handles fall back without card or invented seed', check: 'every_invented_fallback', file: 'attribution.ts', changes: [["if (handle !== null && !event.data.ai_response.toLowerCase().includes(handle.toLowerCase())) handle = null", "// omitted handle grounding"]] },
  { name: 'mature stays refused', check: 'every_mature', file: 'service.ts', changes: [["if (!matureVoiceAllowed(event.nsfw_intent, user?.preferences?.nsfw_enabled === true)) throw new HttpError(422, 'This line stays quiet.', { status: 'unvoiceable' })", "// omitted mature gate"]] },
  { name: 'rule version advances past v3', check: 'every_rule_version', file: 'attribution.ts', changes: [["ATTRIBUTION_RULE_VERSION = 4", "ATTRIBUTION_RULE_VERSION = 3"]] },
  { name: 'old done results run once', check: 'every_rule_version', file: 'attribution.ts', changes: [["  const revision = mediaRevision(event.data.ai_response, event.data.player_input)", "  if (event.data.voice_attribution?.status === 'done') return event.data.spoken_lines || [];\n  const revision = mediaRevision(event.data.ai_response, event.data.player_input)"]] },
  { name: 'current done results stay cached', check: 'every_rule_version', file: 'attribution.ts', changes: [["'data.voice_attribution.status': 'done', 'data.voice_attribution.rule_version': { $ne: ATTRIBUTION_RULE_VERSION }", "'data.voice_attribution.status': 'done'"]] },
  { name: 'upgrading preserves an already heard clip', check: 'every_upgrade_cache', file: 'attribution.ts', changes: [["if (previous?.voice_id && previous.model)", "if (false && previous?.voice_id && previous.model)"]] },
  ...['voice', 'portrait', 'appearance'].map((key): Mutation => ({ name: `merge carries ${key}`, check: 'every_merge_media', file: '../character-codex.service.ts', changes: [[key === 'voice' ? "...(!target.voice && source.voice ? { voice: source.voice } : {})," : key === 'portrait' ? "portrait: source.portrait," : "...(source.appearance ? { appearance: source.appearance } : {}),", ""]] })),
  { name: 'merge keeps the established voice', check: 'every_merge_media', file: '../character-codex.service.ts', changes: [["!target.voice && source.voice", "source.voice"]] },
  { name: 'live merge reassigns asset ownership', check: 'every_merge_media', file: '../character-codex.service.ts', changes: [["instance_id: target.instance_id, player_id: pid, character_id: source._id", "instance_id: target.instance_id, player_id: pid, character_id: target._id"]] },
  { name: 'replayed merge reassigns asset ownership', check: 'every_merge_media', file: '../character-codex.service.ts', changes: [["instance_id: target.instance_id, player_id: target.player_id, character_id: source._id", "instance_id: target.instance_id, player_id: target.player_id, character_id: target._id"]] },
  // ── media-every-line-fix-2 ──
  { name: 'uncarded video paints and lip-syncs a passing face', check: 'every_uncarded_video', file: 'visual.ts', changes: [["await ensurePassingFaceReady(asset, event, line.voice.speaker_name)", "await Promise.reject(new Error('uncarded speaker refused'))"]] },
  { name: 'passing face never writes a character', check: 'every_uncarded_video', file: 'visual.ts', changes: [["const appearance = old?.appearance || await visualEffects.fill", "await mongoColl.characters().insertOne({ _id: id }); const appearance = old?.appearance || await visualEffects.fill"]] },
  { name: 'passing face reuses the same handle across events', check: 'passing_face_reuse', file: 'visual.ts', changes: [["[instanceId.toHexString(), identityKey(handle)]", "[eventId.toHexString(), identityKey(handle)]"]] },
  { name: 'passing face repaints when the world style changes', check: 'passing_face_style', file: 'visual.ts', changes: [["${style.key}:${model}:v${PASSING_FACE_RULE_VERSION}`", "all-styles:${model}:v${PASSING_FACE_RULE_VERSION}`"]] },
  { name: 'passing face no-handle identity includes line', check: 'passing_face_keys', file: 'visual.ts', changes: [["[eventId.toHexString(), lineId]", "[eventId.toHexString(), 'all-lines']"]] },
  { name: 'passing face deletion removes the object', check: 'passing_face_delete', file: 'deletion.ts', changes: [["if (asset.asset_key) await storageService.deleteStrict(asset.asset_key)", "if (asset.kind !== 'passing_face' && asset.asset_key) await storageService.deleteStrict(asset.asset_key)"]] },
  { name: 'carded video still lip-syncs its card portrait', check: 'every_carded_video', file: 'visual.ts', changes: [["const ready = card\n        ? await ensurePortraitReady", "const ready = false\n        ? await ensurePortraitReady"]] },
  { name: 'dialogue-free route queues the cut', check: 'dialogue_free_route', path: 'src/routes/media.routes.ts', changes: [["'/instances/:id/events/:eventId/video'", "'/instances/:id/events/:eventId/missing-video'"]] },
  { name: 'dialogue-free cut dispatches without voice or line', check: 'dialogue_free_cut', file: 'visual.ts', changes: [["if (!asset.line_id) { await processDialogueFreeCut(asset); return }", "// missing dialogue-free dispatch"]] },
  { name: 'dialogue-free cut charges one video', check: 'dialogue_free_cut', file: 'visual.ts', changes: [["await settleMedia(asset._id)\n    await notifyMedia({ ...asset, status: 'ready', url: result.url })\n  } catch (error) {\n    if (uploaded) await mediaEffects.remove", "await releaseMedia(asset._id)\n    await notifyMedia({ ...asset, status: 'ready', url: result.url })\n  } catch (error) {\n    if (uploaded) await mediaEffects.remove"]] },
  { name: 'dialogue-free total failure refunds', check: 'dialogue_free_failure', file: 'usage.ts', changes: [["await mongoColl.mediaUsage().updateOne({ _id: id, status: 'reserved' }, { $set: { status: 'released' }, $unset: { slot: '' } })", "// no refund"]] },
  { name: 'dialogue-free one-shot failure degrades', check: 'dialogue_free_degrades', file: 'visual.ts', changes: [["if (!ready.length) throw new Error('No scene shot survived')", "if (ready.length < 2) throw new Error('No scene shot survived')"]] },
  { name: 'dialogue-free resting answer gates the request', check: 'dialogue_free_resting', file: 'visual.ts', changes: [["event_id: event!._id, kind: 'video' }))", "event_id: event!._id, kind: 'portrait' }))"]] },
  { name: 'dialogue-free foreign save is a 404', check: 'dialogue_free_owner', file: 'visual.ts', changes: [["const instance = await mongoColl.worldInstances().findOne({ _id: iid, player_id: pid })\n  if (!instance) throw new HttpError(404, 'That story could not be found.')\n  const [template, user]", "const instance = await mongoColl.worldInstances().findOne({ _id: iid })\n  if (!instance) throw new HttpError(404, 'That story could not be found.')\n  const [template, user]"], ["event = await mongoColl.events().findOne({ _id: parseObjectId(eventId), instance_id: iid, player_id: pid })", "event = await mongoColl.events().findOne({ _id: parseObjectId(eventId), instance_id: iid })"]] },
  { name: 'dialogue-free plans have no line shot', check: 'dialogue_free_validates', file: 'director.ts', changes: [["input.mode === 'dialogue_free' && p.line_shot !== null", "false"]] },
  { name: 'dialogue-free plans require both scene shots', check: 'dialogue_free_validates', file: 'director.ts', changes: [["if (shots.length !== 2 || shots[0]?.role !== 'opening' || shots[1]?.role !== 'closing')", "if (false)"]] },
  { name: 'dialogue-free plans run about 6–8 seconds', check: 'dialogue_free_validates', file: 'director.ts', changes: [["if (shots.some((s) => s?.duration_s !== 3 && s?.duration_s !== 4))", "if (false)"]] },

  { name: 'passing face pre-gate remains binding', check: 'passing_face_gates', file: 'visual.ts', changes: [["if (pre.verdict !== 'allow') throw new UnseenError('pre', pre.reason_code)", "// missing face pre-gate"]] },
  { name: 'passing face post-gate remains binding', check: 'passing_face_gates', file: 'visual.ts', changes: [["if (post.verdict !== 'allow' || post.text_visible || post.people_count !== 1) {", "if (false) {"]] },
  { name: 'passing face uses the portrait allowance', check: 'passing_face_gates', file: 'visual.ts', changes: [["instance_id: instance._id, kind: 'portrait' }))", "instance_id: instance._id, kind: 'picture' }))"]] },
  { name: 'a later card paints its own face', check: 'passing_face_later_card', file: 'visual.ts', changes: [["        let reference: { data: Buffer; contentType: string } | undefined", "        let reference: { data: Buffer; contentType: string } | undefined = asMediaImageReference(await visualEffects.download('https://example.test/passing-face.jpg'))"]] },
  { name: 'passing face never sends a ready socket', check: 'passing_face_hidden', file: 'service.ts', changes: [["if (!asset.event_id || asset.kind === 'passing_face') return false", "if (!asset.event_id) return false"]] },
  { name: 'passing face never sends a failure socket', check: 'passing_face_hidden', file: 'service.ts', changes: [["if (asset.kind === 'passing_face') return", "// passing face failure leaked"]] },
  { name: 'dialogue-free assembly duration matches its output', check: 'dialogue_free_assembly', file: 'cut.ts', changes: [["return { bytes: Buffer.from(await readFile(out)), totalS }", "return { bytes: Buffer.from(await readFile(out)), totalS: totalS + 1 }"]] },
  { name: 'dialogue-free fallback never retains provider audio', check: 'dialogue_free_cut', file: 'visual.ts', changes: [["s.model === sceneFallbackModel() ? await cutEffects.run", "false ? await cutEffects.run"]] },
  { name: 'dialogue-free motion asks for ambience without voices', check: 'dialogue_free_cut', file: 'scene-templates.ts', changes: [["No voices, no spoken words, no music with words.", ""]] },
  // ── media-suggestive-policy ──
  ...['kiss', 'nudity', 'sexual_act', 'underage', 'gore', 'real_person', 'boundary'].flatMap((key): Mutation[] => [
    { name: `text policy ${key}`, check: `visual_text_${key}`, file: 'visual.ts', changes: [["if (pre.verdict !== 'allow') throw new UnseenError('pre', pre.reason_code)", key === 'kiss' ? "throw new UnseenError('pre', 'over_refusal')" : "// omitted pre gate"]] },
    { name: `vision policy ${key}`, check: `visual_vision_${key}`, file: 'visual.ts', changes: [["if (post.verdict !== 'allow' || post.text_visible || post.people_count !== 1) {", key === 'kiss' ? "if (true) {" : "if (false) {"]] },
  ]),
  ...['moderation', 'vision', 'description'].map((part): Mutation => ({ name: `shared policy reaches ${part}`, check: 'visual_shared_policy', file: 'safety.ts', changes: [[part === 'moderation' ? "      line,\n      verdict," : part === 'vision' ? "      line,\n      'A fictional" : "      line,\n      'Preserve", part === 'moderation' ? "      '',\n      verdict," : part === 'vision' ? "      '',\n      'A fictional" : "      '',\n      'Preserve"]] })),
  { name: 'description preserves allowed suggestiveness', check: 'visual_shared_policy', file: 'safety.ts', changes: [["Preserve an allowed suggestive moment as suggestive", "Hide every intimate moment"]] },
  { name: 'missing reference preserves people', check: 'visual_shared_policy', file: 'safety.ts', changes: [["A person without a portrait is still present", "Omit people without portraits"]] },
  { name: 'description redirects blocked content', check: 'visual_shared_policy', file: 'safety.ts', changes: [["When the moment crosses the BLOCKED line, describe only what surrounds it", "Depict every moment directly"]] },
  { name: 'gate sees the entire description', check: 'visual_complete_description', file: 'safety.ts', changes: [["{ role: 'user', content: description }", "{ role: 'user', content: description.slice(0, 2000) }"]] },
  { name: 'portrait no SFW restriction', check: 'visual_prompt_line', file: 'visual.ts', changes: [["head-and-shoulders portrait, plain", "SFW head-and-shoulders portrait, plain"]] },
  { name: 'picture no fully clothed restriction', check: 'visual_prompt_line', file: 'visual.ts', changes: [["no nudity, no sexual act, vertical", "Fully clothed, SFW, vertical"]] },
  { name: 'scene content line', check: 'visual_prompt_line', file: 'scene-templates.ts', changes: [["No nudity, no sexual act, no suggestive depictions of anyone who looks underage", "No explicit content"]] },
  { name: 'director verbatim', check: 'director_verbatim', file: 'director.ts', changes: [["7. Suggestive, never explicit.", "7. Safe for everyone."]] },
  { name: 'dialogue-free addendum stays verbatim', check: 'director_verbatim', file: 'director.ts', changes: [["Keep the ambient bed, never voices.", "Keep the ambient bed."]] },
  { name: 'tolerance passthrough', check: 'image_safety_tolerance', file: 'image.ts', changes: [["body.safety_tolerance = tolerance", "// omitted tolerance"]] },
  { name: 'tolerance env override', check: 'image_safety_tolerance', file: 'config.ts', changes: [["const value = process.env.MEDIA_IMAGE_SAFETY_TOLERANCE", "const value = undefined"]] },
  { name: 'tolerance default', check: 'image_safety_tolerance', file: 'config.ts', changes: [["value.trim() === '' ? 2 : Number(value)", "value.trim() === '' ? 3 : Number(value)"]] },
  // ── keepsakes-server ──
  { name: 'keepsakes list owns rows', check: 'keepsakes_owner', file: 'keepsakes.ts', changes: [["player_id: pid,\n    status: 'ready',", "status: 'ready',"]] },
  { name: 'keepsakes hide param name', check: 'keepsakes_owner', path: 'src/routes/media.routes.ts', changes: [["/media/keepsakes/:mediaId/hide", "/media/keepsakes/:id/hide"]] },
  { name: 'keepsakes hidden stays hidden', check: 'keepsakes_exclusions', file: 'keepsakes.ts', changes: [["hidden_from_keepsakes: { $ne: true },", "hidden_from_keepsakes: { $ne: false },"]] },
  { name: 'keepsakes payload keeps no asset key', check: 'keepsakes_forbidden', file: 'keepsakes.ts', changes: [["        url: row.url,", "        url: row.url,\n        asset_key: row.asset_key || row.url,"]] },
  { name: 'keepsakes page walks newest first', check: 'keepsakes_paging', file: 'keepsakes.ts', changes: [[".sort({ created_at: -1, _id: -1 }).limit(limit + 1).toArray()", ".sort({ created_at: 1, _id: 1 }).limit(limit + 1).toArray()"]] },
  { name: 'keepsakes hide owns row', check: 'keepsakes_hide', file: 'keepsakes.ts', changes: [["const row = await mongoColl.mediaAssets().findOne({ _id: mid, player_id: pid })", "const row = await mongoColl.mediaAssets().findOne({ _id: mid })"]] },
  { name: 'keepsakes film carries poster', check: 'keepsakes_poster', file: 'visual.ts', changes: [["const poster = await attachPoster(asset, bytes)", "const poster = null"]] },
  // ── keepsakes-server-fix-1 ──
  { name: 'keepsakes superseded faces stay out', check: 'keepsakes_superseded_page_two', file: 'keepsakes.ts', changes: [["if (row.asset_key) return row.asset_key === current.asset_key", "if (row.asset_key) return true"]] },
  { name: 'keepsakes persona style map', check: 'keepsakes_persona_style_current', file: 'keepsakes.ts', changes: [["if (artStyle) return persona.portraits?.[artStyle]", "if (artStyle) return persona.portrait"]] },
  { name: 'keepsakes hidden rows skipped', check: 'keepsakes_dense_hidden', file: 'keepsakes.ts', changes: [["hidden_from_keepsakes: { $ne: true },", "hidden_from_keepsakes: { $ne: 'never' }"]] },
  { name: 'keepsakes cursor ends the list', check: 'keepsakes_cursor_last_page', file: 'keepsakes.ts', changes: [[".limit(limit + 1).toArray()", ".limit(limit).toArray()"]] },
  { name: 'keepsakes same-instant tiebreak', check: 'keepsakes_same_instant', file: 'keepsakes.ts', changes: [[".sort({ created_at: -1, _id: -1 }).limit(limit + 1).toArray()", ".sort({ created_at: -1 }).limit(limit + 1).toArray()"], ["? { $or: [{ created_at: { $lt: resume.t } }, { created_at: resume.t, _id: { $lt: resume.id } }] }", "? { created_at: { $lt: resume.t } }"]] },
  { name: 'keepsakes malformed cursor rejected', check: 'keepsakes_bad_cursor', file: 'keepsakes.ts', changes: [["if (!iso || Number.isNaN(t.getTime()) || !/^[0-9a-fA-F]{24}$/.test(hex)) {", "if (false) {"]] },
  // ── media-turn-media ──
  { name: 'turn media rides on load', check: 'turn_media_load_instance', path: 'src/services/generation.service.ts', changes: [["      recentEvents: await withTurnMedia(filtered),", "      recentEvents: filtered,"]] },
  { name: 'turn media queued covers processing', check: 'turn_media_load_instance', file: 'events.ts', changes: [["    status: row.status === 'ready' ? 'ready' : 'queued',", "    status: row.status as 'ready' | 'queued',"]] },
  { name: 'turn media owns rows', check: 'turn_media_owner', file: 'events.ts', changes: [["      if (!row.player_id.equals(event.player_id)) continue", "      if (false && !row.player_id.equals(event.player_id)) continue"]] },
  { name: 'turn media batched query', check: 'turn_media_batched', file: 'events.ts', changes: [[`  const rows = await mongoColl.mediaAssets().find({
    instance_id: { $in: iids },
    event_id: { $in: ids },
    player_id: { $in: pids },
    kind: { $in: ['picture', 'video'] },
    status: { $in: ['queued', 'processing', 'ready'] },
  }).sort({ created_at: 1, _id: 1 }).toArray() as MediaAssetDoc[]`, `  const rows: MediaAssetDoc[] = []
  for (const event of events) {
    rows.push(...(await mongoColl.mediaAssets().find({
      event_id: event._id,
      player_id: event.player_id,
      kind: { $in: ['picture', 'video'] },
      status: { $in: ['queued', 'processing', 'ready'] },
    }).sort({ created_at: 1, _id: 1 }).toArray() as MediaAssetDoc[]))
  }`]] },
  { name: 'turn media carries no internals', check: 'turn_media_shape', file: 'events.ts', changes: [["    media_id: row._id.toHexString(),", "    media_id: row._id.toHexString(),\n    cache_key: row.cache_key,"]] },
  { name: 'turn media ignores keepsake hiding', check: 'turn_media_hidden', file: 'events.ts', changes: [["    status: { $in: ['queued', 'processing', 'ready'] },", "    status: { $in: ['queued', 'processing', 'ready'] },\n    hidden_from_keepsakes: { $ne: true },"]] },
  { name: 'turn media rides on pages', check: 'turn_media_pages', path: 'src/services/memory.service.ts', changes: [["    return { events: await withTurnMedia(ordered), total, page: opts.page || 1, hasOlder }", "    return { events: ordered, total, page: opts.page || 1, hasOlder }"]] },
  { name: 'turn media rides on replay', check: 'turn_media_replay', path: 'src/services/memory.service.ts', changes: [["      event: updated ? (await withTurnMedia([publicMediaEvent(updated)]))[0] : updated,\n      replay_count: nextVariants.length,\n      selected_index: selectedIdx,", "      event: updated ? publicMediaEvent(updated) : updated,\n      replay_count: nextVariants.length,\n      selected_index: selectedIdx,"]] },
  { name: 'turn media rides on variant select', check: 'turn_media_replay', path: 'src/services/memory.service.ts', changes: [["      event: updated ? (await withTurnMedia([publicMediaEvent(updated)]))[0] : updated,\n      replay_count: nextVariants.length,\n      selected_index: variantIndex,", "      event: updated ? publicMediaEvent(updated) : updated,\n      replay_count: nextVariants.length,\n      selected_index: variantIndex,"]] },
  // ── media-film-fixes ──
  { name: 'peopleless still omits person continuity', check: 'peopleless_prompts', file: 'scene-templates.ts', changes: [["shot.people_in_still.length ? `Wardrobe:", "true ? `Wardrobe:"]] },
  { name: 'peopleless motion omits wardrobe', check: 'peopleless_prompts', file: 'scene-templates.ts', changes: [["...(shot.people_in_still.length ? [`Wardrobe stays exactly:", "...(true ? [`Wardrobe stays exactly:"]] },
  { name: 'populated still retains person continuity verbatim', check: 'peopleless_prompts', file: 'scene-templates.ts', changes: [["Wardrobe: ${c.wardrobe} Hair: ${c.hair}", "Wardrobe: changed Hair: changed"]] },
  { name: 'populated motion retains wardrobe verbatim', check: 'peopleless_prompts', file: 'scene-templates.ts', changes: [["Wardrobe stays exactly: ${plan.continuity.wardrobe}", "Wardrobe stays exactly: changed"]] },
  { name: 'peopleless still has no portrait reference', check: 'peopleless_references', file: 'visual.ts', changes: [["args.shot.people_in_still.length && args.speakerPortrait ?", "args.speakerPortrait ?"]] },
  { name: 'peopleless video asks for no wardrobe match', check: 'peopleless_references', file: 'visual.ts', changes: [["checkVideoFrames(video, expectedPeople ? { data: stillBytes, contentType: stillContentType } : undefined)", "checkVideoFrames(video, { data: stillBytes, contentType: stillContentType })"]] },
  { name: 'populated still retains portrait reference', check: 'peopleless_references', file: 'visual.ts', changes: [["args.shot.people_in_still.length && args.speakerPortrait ?", "false && args.speakerPortrait ?"]] },
  { name: 'populated video retains wardrobe check', check: 'peopleless_references', file: 'visual.ts', changes: [["checkVideoFrames(video, expectedPeople ? { data: stillBytes, contentType: stillContentType } : undefined)", "checkVideoFrames(video)"]] },
  { name: 'stale public lines clear unvoiceable', check: 'stale_line_payload', file: 'policy.ts', changes: [["attributionIsCurrent && voice?.status", "voice?.status"]] },
  { name: 'current public lines keep unvoiceable', check: 'stale_line_payload', file: 'policy.ts', changes: [["attributionIsCurrent && voice?.status", "false && voice?.status"]] },
  { name: 'wire compares the attribution rule version', check: 'stale_line_payload', file: 'events.ts', changes: [["attribution?.rule_version === ATTRIBUTION_RULE_VERSION", "true"]] },
  { name: 'event decides before deleting attribution', check: 'stale_line_payload', file: 'events.ts', changes: [["  if (mediaEnabled('voice')) {", "  delete event.data.voice_attribution\n  if (mediaEnabled('voice')) {"]] },
  { name: 'publisher carries event attribution', check: 'stale_line_payload', file: 'events.ts', changes: [["wireSpokenLines(event.data.spoken_lines, event.data.voice_attribution as VoiceAttribution | undefined)", "wireSpokenLines(event.data.spoken_lines)"]] },
  { name: 'payload omits attribution internals', check: 'stale_line_payload', file: 'events.ts', changes: [["  delete event.data.voice_attribution", "  // leaked attribution"]] },
  { name: 'payload omits media revision', check: 'stale_line_payload', file: 'events.ts', changes: [["  delete event.data.media_revision", "  // leaked revision"]] },
  { name: 'history omits attribution internals', check: 'stale_line_payload', file: 'events.ts', changes: [["    delete edit.previous_data.voice_attribution", "    // leaked old attribution"]] },
  { name: 'history omits media revision', check: 'stale_line_payload', file: 'events.ts', changes: [["    delete edit.previous_data.media_revision", "    // leaked old revision"]] },
  // ── media-place-not-title ──
  { name: 'inline card portrait has no place', check: 'portrait_places', file: 'visual.ts', changes: [["generatePortraitBytes(appearance, card.canonical_name, '', model, style.render, reference)", "generatePortraitBytes(appearance, card.canonical_name, template?.title || '', model, style.render, reference)"]] },
  { name: 'queued card repaint has no place', check: 'portrait_places', file: 'visual.ts', changes: [["generatePortraitBytes(appearance, card.canonical_name, '', asset.model, style.render, reference)", "generatePortraitBytes(appearance, card.canonical_name, template?.title || '', asset.model, style.render, reference)"]] },
  { name: 'passing face has no place', check: 'portrait_places', file: 'visual.ts', changes: [["generatePortraitBytes(appearance, handle, '', model, style.render)", "generatePortraitBytes(appearance, handle, template?.title || '', model, style.render)"]] },
  { name: 'inline persona portrait has no place', check: 'portrait_places', file: 'visual.ts', changes: [["generatePortraitBytes(appearance, persona.name, '', imageModel(), render, reference)", "generatePortraitBytes(appearance, persona.name, 'invented place', imageModel(), render, reference)"]] },
  { name: 'queued persona portrait has no place', check: 'portrait_places', file: 'visual.ts', changes: [["generatePortraitBytes(appearance, persona.name, '', asset.model, render, reference)", "generatePortraitBytes(appearance, persona.name, 'invented place', asset.model, render, reference)"]] },
  { name: 'picture uses the turn place instead of the title', check: 'picture_places', file: 'visual.ts', changes: [["place: await momentPlace(instance, event),", "place: template?.title || '',"]] },
  { name: 'line director uses the turn place instead of the title', check: 'director_places', file: 'visual.ts', changes: [["others_present: others.map((c) => ({ name: c.canonical_name, appearance: c.appearance || '' })),\n      place: await momentPlace(instance, event),", "others_present: others.map((c) => ({ name: c.canonical_name, appearance: c.appearance || '' })),\n      place: template?.title || '',"]] },
  { name: 'turn director uses the turn place instead of the title', check: 'director_places', file: 'visual.ts', changes: [["others_present: presentCards(prose, cards, instance.persona_snapshot?.name).map((c) => ({ name: c.canonical_name, appearance: c.appearance || '' })),\n      place: await momentPlace(instance, event),", "others_present: presentCards(prose, cards, instance.persona_snapshot?.name).map((c) => ({ name: c.canonical_name, appearance: c.appearance || '' })),\n      place: template?.title || '',"]] },
  { name: 'historical event anchor takes priority', check: 'picture_places', file: 'visual.ts', changes: [["if (recorded) return recorded", "if (false) return recorded!"]] },
  { name: 'current cursor applies only to the newest turn', check: 'picture_places', file: 'visual.ts', changes: [["return newest?._id.equals(event._id) ? current : ''", "return current"]] },
  { name: 'newest turn receives the current cursor', check: 'picture_places', file: 'visual.ts', changes: [["return newest?._id.equals(event._id) ? current : ''", "return ''"]] },
  { name: 'passing face cache includes prompt rule', check: 'passing_face_rule_version', file: 'visual.ts', changes: [["${style.key}:${model}:v${PASSING_FACE_RULE_VERSION}`", "${style.key}:${model}`"]] },
  { name: 'previous rule passing face repaints', check: 'passing_face_rule_version', file: 'visual.ts', changes: [["${style.key}:${model}:v${PASSING_FACE_RULE_VERSION}`", "${style.key}:${model}:v${PASSING_FACE_RULE_VERSION - 1}`"]] },
  { name: 'stale ready passing face is not reused', check: 'passing_face_rule_version', file: 'visual.ts', changes: [["const prior = await mongoColl.mediaAssets().findOne({ cache_key: cacheKey })", "const prior = await mongoColl.mediaAssets().findOne({ passing_key: passingKey, status: 'ready' })"]] },
  { name: 'current ready passing face is reused', check: 'passing_face_rule_version', file: 'visual.ts', changes: [["if (prior?.status === 'ready' && prior.url && prior.asset_key) {", "if (false) {"]] },
  { name: 'superseded passing face file is removed', check: 'passing_face_rule_version', file: 'visual.ts', changes: [["if (old.asset_key) await mediaEffects.remove(old.asset_key)", "// old file leaked"]] },
  { name: 'superseded passing face row is removed', check: 'passing_face_rule_version', file: 'visual.ts', changes: [["await mongoColl.mediaAssets().deleteOne({ _id: old._id, status: 'ready' })", "// old row leaked"]] },
  { name: 'prompt rule leaves kept card portrait alone', check: 'passing_rule_keeps_cards', file: 'visual.ts', changes: [["if (isPortraitCurrent(holder, style.key)) {", "if (false) {"]] },
]
// Bun's preload loader substitutes only the named module, including legacy
// checks on paths owned by other tasks. No temporary source mutation or restore.
const reportDir = resolve(tmpdir(), 'everlore-media-audit-bites')
await mkdir(reportDir, { recursive: true })
const preload = resolve(reportDir, 'mutation-loader.ts')
await writeFile(preload, `import { plugin } from 'bun'
const mutation = JSON.parse(process.env.MEDIA_AUDIT_MUTATION!)
plugin({ name: 'media-audit-mutation', setup(build) {
  build.onLoad({ filter: new RegExp('^' + mutation.path.replaceAll('.', '[.]') + '$') }, () => ({ contents: mutation.path.endsWith('.json') ? 'export default ' + mutation.contents : mutation.contents, loader: 'ts' }))
} })
`)
for (const mutation of mutations) {
  const file = at(mutation)
  const original = await readFile(file, 'utf8')
  let tampered = original
  for (const [from, to] of mutation.changes) {
    assert.ok(tampered.includes(from), `Missing mutation anchor: ${mutation.name}`)
    tampered = tampered.replace(from, to)
  }
  const child = Bun.spawn(['bun', '--preload', preload, './scripts/media-audit.ts', '--check', mutation.check], {
    stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, MEDIA_AUDIT_MUTATION: JSON.stringify({ path: resolve(file), contents: tampered }) },
  })
  const timer = setTimeout(() => child.kill(), 30000)
  const [out, err, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  clearTimeout(timer)
  assert.notEqual(status, 0, `DID NOT BITE: ${mutation.name}\n${out}\n${err}`)
  assert.ok(err.includes(`FAIL ${mutation.check}:`), `Must fail the named assertion, not syntax/typechecking: ${mutation.name}\n${err}`)
  console.log(`BITE ${mutation.name}: exit ${status}; ${err.split('\n').find((line) => line.startsWith('FAIL '))}`)
}
console.log(`All ${mutations.length} mutations failed their named check; working-tree sources unchanged.`)
