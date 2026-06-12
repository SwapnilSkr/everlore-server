// Drive one chat turn over the real WebSocket as a player. See
// everlore-docs/memory/AGENT_PLAYTEST_RUNBOOK.md.
// Usage: bun run scripts/agent-chat.ts <TOKEN> <INSTANCE_ID> "your message"
const [token, iid, ...rest] = process.argv.slice(2)
const message = rest.join(" ") || "I look around and take stock of the situation."
const ws = new WebSocket(`ws://localhost:3000/ws/play?token=${token}`)
let prose = ""
const done = (code: number) => { try { ws.close() } catch {} process.exit(code) }
const timeout = setTimeout(() => { console.error("TIMEOUT — no completion in 90s"); done(2) }, 90_000)

ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data as string)
  switch (m.type) {
    case "connected": ws.send(JSON.stringify({ action: "chat", instance_id: iid, payload: { message } })); break
    case "ack": break
    case "generation_delta": prose += m.delta ?? ""; process.stdout.write(m.delta ?? ""); break
    case "generation_stream_end": break
    case "generation_retrying": console.error(`\n[retrying ${m.attempt}/${m.maxAttempts}]`); break
    case "generation_complete": {
      const e = m.event ?? {}
      console.log("\n\n— CHOICES:", JSON.stringify(e.choices ?? []))
      console.log("— PRESENT:", JSON.stringify(e.present_characters ?? []))
      console.log("— LOCATION:", JSON.stringify(m.location_anchor ?? e.location_anchor ?? null))
      console.log("— SEQ:", e.sequence)
      clearTimeout(timeout); done(0); break
    }
    case "generation_failed": console.error("\nFAILED:", m.message); clearTimeout(timeout); done(1); break
    case "error": console.error("\nERROR:", JSON.stringify(m)); clearTimeout(timeout); done(1); break
  }
}
ws.onerror = (e) => { console.error("WS error", String(e)); done(1) }
