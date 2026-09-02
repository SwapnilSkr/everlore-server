// Auto-play a sequence of turns over the real WebSocket as a player, dumping the
// structured tail of every turn so flaws are visible. See
// everlore-docs/memory/AUTOCHAT_PLAYBOOK.md.
//
// Usage: bun run scripts/agent-chat.ts <INSTANCE_ID> "<step>" "<step>" ...
//   With TOKEN env set, that bearer is reused; else it logs in as the dev owner.
//
// Each <step> is one of:
//   "plain text"            -> chat turn
//   "/continue [span]"      -> continue (span = hours|day|days|season for a time skip)
//   "/replay <eventId>"     -> regenerate an existing turn
//
// The server URL comes from AGENT_CHAT_BASE_URL, else http://localhost:$PORT,
// else :3000. Bun loads .env from the server root, so running this from
// everlore-server picks up that PORT automatically.
//
// CRITICAL for PARALLEL agents: all agents share ONE account, and the server fans
// every frame out to ALL of that user's sockets. This harness therefore IGNORES
// any frame whose instanceId is not ours — so N agents on N instances don't
// cross-talk. Give each parallel agent its OWN instance.
// The API's port is configurable (`.env` sets PORT=8081), so a hardcoded 3000
// here meant the harness silently pointed at nothing whenever the server was
// started normally — surfacing only as `ws error [object ErrorEvent]`, which
// names neither the port nor the cause. Take the URL from the environment,
// defaulting to the port the server would actually bind.
const BASE = (process.env.AGENT_CHAT_BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '')
const WS = `${BASE.replace(/^http/, 'ws')}/ws/play`
const PHONE = '+919474877175'

const [instanceId, ...steps] = process.argv.slice(2)
if (!instanceId || steps.length === 0) {
  console.error('usage: bun run scripts/agent-chat.ts <instanceId> "<step>" ...')
  process.exit(1)
}

let token = process.env.TOKEN
if (!token) {
  // An unreachable API throws here, before the socket is ever opened, and a bare
  // ConnectionRefused stack says nothing about which port was tried.
  try {
    await fetch(`${BASE}/auth/otp/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: PHONE }) })
    token = (await (await fetch(`${BASE}/auth/otp/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: PHONE, code: '123456' }) })).json()).token
  } catch (err) {
    console.error(`\ncannot reach the API at ${BASE} — ${(err as Error).message}`)
    console.error('  • start it:  PORT=%s bun run src/index.ts', process.env.PORT || '3000')
    console.error('  • or point this harness elsewhere with AGENT_CHAT_BASE_URL')
    process.exit(1)
  }
  if (!token) {
    console.error(`\nlogin at ${BASE} returned no token — is this an Everlore API?`)
    process.exit(1)
  }
}

const ws = new WebSocket(`${WS}?token=${token}`)
const queue = [...steps]
let buf = ''
let watchdog: ReturnType<typeof setTimeout>
const arm = () => { clearTimeout(watchdog); watchdog = setTimeout(() => { console.error('\nTIMEOUT — no completion in 120s'); try { ws.close() } catch {}; process.exit(2) }, 120_000) }
const mine = (f: any) => f.instanceId === undefined || f.instanceId === instanceId

function dispatch(step: string) {
  arm()
  if (step.startsWith('/continue')) {
    const span = step.split(/\s+/)[1]
    const payload = span ? { advance: span } : {}
    console.log(`\n>>> CONTINUE${span ? ' ' + span : ''}`)
    ws.send(JSON.stringify({ action: 'continue', instance_id: instanceId, payload }))
  } else if (step.startsWith('/replay')) {
    const eventId = step.split(/\s+/)[1]
    console.log(`\n>>> REPLAY ${eventId}`)
    ws.send(JSON.stringify({ action: 'replay', instance_id: instanceId, event_id: eventId }))
  } else {
    console.log(`\n>>> PLAYER: ${step}`)
    ws.send(JSON.stringify({ action: 'chat', instance_id: instanceId, payload: { message: step } }))
  }
}

const nextOrClose = () => {
  if (queue.length) setTimeout(() => dispatch(queue.shift()!), 1500) // gap lets async projections land
  else { clearTimeout(watchdog); console.log('\n--- done ---'); try { ws.close() } catch {}; process.exit(0) }
}

ws.onmessage = (ev) => {
  const f = JSON.parse(ev.data.toString())
  if (!mine(f)) return // another agent's instance — ignore
  switch (f.type) {
    case 'connected': nextOrClose(); break
    case 'ack': break
    case 'generation_delta': buf += f.delta ?? ''; break
    case 'generation_stream_end': console.log(`\nNARRATIVE:\n${buf}`); buf = ''; break
    case 'generation_retrying': console.error(`  [retrying ${f.attempt}/${f.maxAttempts}]`); break
    case 'generation_complete': {
      const e = f.event ?? {}
      console.log(`\n[seq ${e.sequence}] event=${e.id} scene=${e.scene_tag} tone=${e.emotional_tone} time=${e.time_advanced ?? '-'}`)
      console.log(`  location: ${e.location_anchor?.name ?? f.location_anchor?.name ?? '-'}`)
      console.log(`  present : ${(e.present_characters ?? []).map((c: any) => c.name ?? c).join(', ') || '-'}`)
      console.log(`  choices : ${(e.choices ?? []).map((c: any) => c.label ?? c).join(' | ') || '-'}`)
      nextOrClose(); break
    }
    case 'replay_complete': console.log(`\n[replay] event=${f.eventId} selected=${f.selected_index}\nNARRATIVE:\n${f.narrative ?? ''}`); nextOrClose(); break
    case 'character_codex_updated': console.log(`  [codex] ${f.characterId ?? ''} updated`); break
    case 'memories_curated': console.log(`  [memory] ${f.count ?? ''} atoms curated`); break
    case 'milestone_unlocked': console.log(`  [milestone] ${f.label ?? ''}`); break
    case 'generation_failed': console.log(`  !! GENERATION FAILED: ${f.message ?? ''}`); nextOrClose(); break
    case 'error': console.log(`  !! ERROR ${f.code ?? ''} ${f.message ?? ''}`); break
  }
}
ws.onerror = () => {
  // A WebSocket ErrorEvent stringifies to "[object ErrorEvent]" and carries no
  // usable detail, so say what we tried to reach and what usually explains it.
  console.error(`\nws error — could not reach ${WS}`)
  console.error('  • is the API running, and on this port? (.env sets PORT; override with AGENT_CHAT_BASE_URL)')
  console.error('  • the worker must be running too, or turns only ack and never generate')
  process.exit(1)
}
