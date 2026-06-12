// Auto-play a sequence of turns over the real WebSocket as a player, dumping the
// structured tail of every turn so flaws are visible. See
// everlore-docs/memory/AUTOCHAT_PLAYBOOK.md.
//
// Usage: bun run scripts/agent-chat.ts <INSTANCE_ID> "msg1" "msg2" ...
//   - With a TOKEN env var set, that bearer is reused; otherwise it logs in as the
//     dev owner via mocked OTP.
const BASE = 'http://localhost:3000'
const WS = 'ws://localhost:3000/ws/play'
const PHONE = '+19474877175'

const [instanceId, ...messages] = process.argv.slice(2)
if (!instanceId || messages.length === 0) {
  console.error('usage: bun run scripts/agent-chat.ts <instanceId> "msg1" "msg2" ...')
  process.exit(1)
}

let token = process.env.TOKEN
if (!token) {
  await fetch(`${BASE}/auth/otp/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: PHONE }) })
  token = (await (await fetch(`${BASE}/auth/otp/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: PHONE, code: '123456' }) })).json()).token
}

const ws = new WebSocket(`${WS}?token=${token}`)
const queue = [...messages]
let buf = ''
const timeout = () => setTimeout(() => { console.error('\nTIMEOUT — no completion in 90s'); try { ws.close() } catch {}; process.exit(2) }, 90_000)
let watchdog = timeout()

const send = (m: string) => ws.send(JSON.stringify({ action: 'chat', instance_id: instanceId, payload: { message: m } }))
const nextOrClose = () => {
  clearTimeout(watchdog)
  if (queue.length) { const m = queue.shift()!; console.log(`\n>>> PLAYER: ${m}`); watchdog = timeout(); send(m) }
  else { console.log('\n--- done ---'); try { ws.close() } catch {}; process.exit(0) }
}

ws.onmessage = (ev) => {
  const f = JSON.parse(ev.data.toString())
  switch (f.type) {
    case 'connected': nextOrClose(); break
    case 'ack': break
    case 'generation_delta': buf += f.delta ?? ''; break
    case 'generation_stream_end': console.log(`\nNARRATIVE:\n${buf}`); buf = ''; break
    case 'generation_retrying': console.error(`  [retrying ${f.attempt}/${f.maxAttempts}]`); break
    case 'generation_complete': {
      const e = f.event ?? {}
      console.log(`\n[seq ${e.sequence}] scene=${e.scene_tag} tone=${e.emotional_tone} time=${e.time_advanced ?? '-'}`)
      console.log(`  location: ${e.location_anchor?.name ?? f.location_anchor?.name ?? '-'}`)
      console.log(`  present : ${(e.present_characters ?? []).map((c: any) => c.name ?? c).join(', ') || '-'}`)
      console.log(`  choices : ${(e.choices ?? []).map((c: any) => c.label ?? c).join(' | ') || '-'}`)
      setTimeout(nextOrClose, 1500) // gap so async codex/memory projections can land
      break
    }
    case 'character_codex_updated': console.log(`  [codex] ${f.characterId ?? ''} updated`); break
    case 'memories_curated': console.log(`  [memory] ${f.count ?? ''} atoms curated`); break
    case 'generation_failed': console.log(`  !! GENERATION FAILED: ${f.message ?? ''}`); setTimeout(nextOrClose, 200); break
    case 'error': console.log(`  !! ERROR ${f.code ?? ''} ${f.message ?? ''}`); break
  }
}
ws.onerror = (e) => { console.error('ws error', String(e)); process.exit(1) }
