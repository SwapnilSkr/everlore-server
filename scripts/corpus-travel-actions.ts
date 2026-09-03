/**
 * The player's TYPED TRAVEL DESTINATIONS, extracted read-only from the events.
 *
 * `corpus:location-ab` replayed every turn with `actionDestination: null`,
 * because `corpus/turns.json` never captured it. On worlds where the player
 * types their movement in prose that costs nothing — but a player who used the
 * product's travel control moved by a mechanism the replay could not represent,
 * and the A/B scored the resulting hold as a cursor failure. On Aurelius
 * Valemont that was four turns of pure harness artifact.
 *
 * A `type: 'travel'` event IS the product action: the player picked a
 * destination from a menu and the cursor took it by construction, so that
 * event's own `location_anchor` is the destination the control supplied. This
 * reads it back as an INPUT to the replay, which is what it was.
 *
 * Read-only. Run: bun run corpus:travel-actions
 */
import { MongoClient } from 'mongodb'
import { writeFileSync } from 'node:fs'

const uri = process.env.MONGODB_URI
if (!uri) {
  console.error('MONGODB_URI is required')
  process.exit(1)
}
const client = new MongoClient(uri)
await client.connect()
const db = client.db()

const rows = (await db
  .collection('events')
  .find({ type: 'travel' }, { projection: { instance_id: 1, sequence: 1, location_anchor: 1, travel: 1 } })
  .toArray()) as any[]

const out: Record<string, string> = {}
for (const row of rows) {
  const destination = row.travel?.to || row.location_anchor?.name
  if (typeof destination === 'string' && destination.trim()) {
    out[`${String(row.instance_id)}:${row.sequence}`] = destination.trim()
  }
}
writeFileSync('corpus/travel-actions.json', `${JSON.stringify(out, null, 2)}\n`)
console.log(`wrote ${Object.keys(out).length} typed travel destinations across ${rows.length} travel events`)
await client.close()
