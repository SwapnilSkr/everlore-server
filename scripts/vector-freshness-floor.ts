import type { VectorLayout } from '../src/services/vector-store'

type FloorRuntime = {
  layout: VectorLayout
  namespace: string
  establish: () => Promise<string>
  log: (line: string) => void
}

export async function runFreshnessFloor(args: string[], runtime?: FloorRuntime) {
  for (const arg of args) if (!['--', '--execute'].includes(arg)) throw new Error(`Unknown argument: ${arg}`)
  const layout = runtime?.layout ?? process.env.VECTOR_LAYOUT ?? 'shared'
  const namespace = runtime?.namespace ?? process.env.PINECONE_SHARED_NAMESPACE ?? 'everlore'
  const log = runtime?.log ?? console.log
  if (layout !== 'shared') throw new Error('REFUSED: freshness floor requires VECTOR_LAYOUT=shared')
  if (!args.includes('--execute')) {
    log(`DRY RUN: would upsert then delete a tracked sentinel in shared namespace ${namespace}.`)
    log(`Would raise vecf:v1:${namespace}:floor to <Redis run_id>:<acknowledged LSN> (no TTL; monotonic within one Redis process).`)
    log('No connections or writes. Restart every API/worker writer on this code, then rerun with --execute; enable OVERLAP_PREFETCH=on after success.')
    return
  }
  if (!runtime) {
    const [{ env }, vectors, redis] = await Promise.all([
      import('../src/config/env'), import('../src/services/vector-store'), import('../src/config/redis'),
    ])
    try {
      await redis.connectRedis()
      if (!redis.getRedisProcess()) {
        await new Promise<void>((resolve, reject) => {
          const unsubscribe = redis.onRedisProcessReady(() => { clearTimeout(timer); unsubscribe(); resolve() })
          const timer = setTimeout(() => { unsubscribe(); reject(new Error('Redis process identity unavailable')) }, 1000)
        })
      }
      return await runFreshnessFloor(args, { layout: env.VECTOR_LAYOUT, namespace: env.PINECONE_SHARED_NAMESPACE,
        establish: vectors.establishVectorFreshnessFloor, log })
    } finally {
      // connectRedis creates three clients; close each even when the sentinel fails.
      for (const get of [redis.getRedisClient, redis.getRedisSubscriber, redis.getQueueRedisClient]) {
        try { get().disconnect() } catch { /* Connection may not have initialized. */ }
      }
    }
  }
  const floor = await runtime.establish()
  log(`Freshness floor vecf:v1:${namespace}:floor=${floor} (durable; sentinel deleted).`)
  return floor
}

if (import.meta.main) {
  try { await runFreshnessFloor(process.argv.slice(2)) }
  catch (error) { console.error((error as Error).message); process.exitCode = 1 }
}
