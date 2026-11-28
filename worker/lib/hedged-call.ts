/**
 * One model call that cannot be held hostage by a single stuck answer.
 *
 * The first request goes out at once. If it has not answered after `hedgeMs`,
 * one identical backup goes out; if it fails before then, the backup goes out
 * at once instead. The first good answer wins and the other request is
 * cancelled through its signal. Never more than two requests. When every
 * request has failed, the last error is thrown, exactly as one call would.
 *
 * `hedgeMs <= 0` turns the backup off: one request, today's behaviour.
 */
export async function hedgedCall<T>(
  call: (signal: AbortSignal) => Promise<T>,
  opts: {
    hedgeMs: number
    /** Fired once, when the backup request goes out. */
    onHedge?: () => void
  },
): Promise<T> {
  const maxRequests = opts.hedgeMs > 0 ? 2 : 1
  const controllers: AbortController[] = []
  let started = 0
  let failed = 0
  let done = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastError: unknown

  return new Promise<T>((resolve, reject) => {
    const finish = () => {
      done = true
      if (timer) clearTimeout(timer)
    }
    const launch = () => {
      if (done || started >= maxRequests) return
      const isBackup = started > 0
      started++
      if (isBackup) opts.onHedge?.()
      const controller = new AbortController()
      controllers.push(controller)
      call(controller.signal).then(
        (value) => {
          if (done) return
          finish()
          for (const other of controllers) if (other !== controller) other.abort()
          resolve(value)
        },
        (error) => {
          if (done) return
          failed++
          lastError = error
          if (started < maxRequests) {
            // Failed before the backup was due: send it now instead of waiting.
            if (timer) clearTimeout(timer)
            launch()
          } else if (failed >= started) {
            finish()
            reject(lastError)
          }
        },
      )
    }
    launch()
    if (maxRequests > 1) timer = setTimeout(launch, opts.hedgeMs)
  })
}
