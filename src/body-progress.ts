/**
 * Reading a response body under a stall watchdog instead of a total budget.
 *
 * Lives on its own because two downloads need exactly this rule and they are
 * not the same file: the catalog served from its origin (#750/#766) and the
 * catalog carried by a published package (#1049). The npm source had kept a
 * fixed 20s ceiling, which is fine for a metadata answer and wrong for a
 * multi-megabyte tarball: at 3.2 MB it needs 158 KB/s sustained, and a China
 * mirror jittering to 17–40 KB/s cannot make that, so both attempts died at
 * the ceiling while the link was still delivering bytes.
 */

/**
 * How long to wait for the response to START answering.
 *
 * Headers arrive in one burst or not at all, so a fixed budget still fits
 * them. It fits nothing else: the body of a catalog download keeps trickling
 * long after any honest total budget, and a total timer cuts off a download
 * that was still moving — measured: killed at 15s on both attempts, 89.9s
 * end-to-end when allowed to run.
 */
export const HEADERS_TIMEOUT_MS = 15_000

/**
 * How long the body may stay SILENT before we give up on it.
 *
 * Deliberately not a total budget. As long as bytes keep arriving, however
 * slowly, the read continues; the watchdog only fires on a download that has
 * actually stopped, which is the one failure a slow link cannot fake.
 */
export const BODY_STALL_TIMEOUT_MS = 15_000

/**
 * How long the whole body may take, however much progress it keeps making.
 *
 * The stall watchdog can only act on a pause, so a mirror that sends one
 * byte inside every 15s window would hold the read open forever. 10 minutes
 * is ~7x the slowest measured full download (89.9s); a body still going
 * after that is broken, not slow, and the byte count in the message says
 * which of the two it was.
 */
export const BODY_TOTAL_CEILING_MS = 600_000

/**
 * The most body bytes to accept before declaring the response not a catalog.
 *
 * The catalog passed 5 MB in September 2026 (9.5 MB unpacked by October);
 * 256 MB is decades of headroom — and still a hard bound on memory, because
 * the whole body is buffered before parsing and a mirror streaming garbage
 * at line speed would otherwise grow that buffer until the process dies.
 * backup.ts and gist.ts cap their downloads for the same reason.
 */
export const MAX_BODY_BYTES = 256 * 1024 * 1024

/**
 * Read a body under a stall watchdog instead of a total budget.
 *
 * One timer for the whole fetch was the mistake both before and after #188:
 * at 4s it hid slowness behind a stale snapshot, at 15s it kills downloads
 * that are still moving. On a lossy proxied link the catalog body trickles
 * for far longer than 15s while never once going silent — measured 89.9s
 * end-to-end for a body the 15s cutoff had declared dead twice. This reader
 * lets a moving body run as long as it keeps moving, in either direction's
 * sense of "slow", and ends one that goes quiet for `stallMs` with a message
 * that says what actually happened and how much had arrived.
 *
 * The rejection comes from here, not from an abort: undici's abort message
 * ("This operation was aborted") cannot tell a user anything actionable, and
 * a bug report containing this string will contain the byte count too.
 *
 * Two backstops keep "still moving" from meaning "forever", because the
 * watchdog can only see pauses: a total ceiling for a body that trickles
 * without ever pausing, and a size cap for one that outruns any catalog.
 *
 * @param res - the response whose body to read.
 * @param stallMs - silence that ends the read, in milliseconds.
 * @param what - the download, for the rejection message ("the catalog").
 * @param maxBytes - maximum decoded response size.
 */
export function readBodyWhileProgressing(
  res: Response, stallMs: number, what = 'the catalog', maxBytes = MAX_BODY_BYTES,
): Promise<Uint8Array> {
  // The stand-in closes at once, so an absent body reads as "no body"
  // below instead of parking this reader on a stream that never ends.
  const reader = (res.body ?? new ReadableStream<Uint8Array>({ start(controller) { controller.close() } })).getReader()
  return new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Uint8Array[] = []
    let received = 0
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      clearTimeout(ceiling)
      // Tell the origin we are done with the socket; its refusal is not ours to report.
      reader.cancel().catch(() => {})
      if (error !== undefined) reject(error)
      // An empty body otherwise surfaces as a JSON parse error, which tells
      // the user nothing about the network that caused it.
      else if (received === 0) reject(new Error(`${what} response carried no body`))
      else resolve(concatBytes(chunks))
    }
    const ceiling = setTimeout(
      () => {
        finish(new DOMException(
          `${what} download did not finish within ${String(Math.round(BODY_TOTAL_CEILING_MS / 1000))}s (received ${String(received)} bytes)`,
          'TimeoutError',
        ))
      },
      BODY_TOTAL_CEILING_MS,
    )
    const arm = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(
        () => {
          finish(new DOMException(
            `no new data for ${String(Math.round(stallMs / 1000))}s while downloading ${what} (received ${String(received)} bytes)`,
            'TimeoutError',
          ))
        },
        stallMs,
      )
    }
    const step = (): void => {
      reader.read().then((r) => {
        if (settled) return
        if (r.done || r.value === undefined) {
          finish()
          return
        }
        chunks.push(r.value)
        received += r.value.byteLength
        if (received > maxBytes) {
          finish(new Error(
            `${what} response grew past ${String(maxBytes / 1024 / 1024)} MB without ending (received ${String(received)} bytes)`,
          ))
          return
        }
        arm()
        step()
      }, (error: unknown) => {
        finish(error instanceof Error ? error : new Error(String(error)))
      })
    }
    arm()
    step()
  })
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const all = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0))
  let at = 0
  for (const chunk of chunks) {
    all.set(chunk, at)
    at += chunk.byteLength
  }
  return all
}

/**
 * Fetch with a headers-only deadline, then hand the body to the watchdog.
 *
 * Two clocks, because they measure different things: how long the origin
 * takes to start answering, and how long it keeps answering. The abort signal
 * covers only the first — once headers are in, the watchdog owns the read,
 * which is what lets a slow-but-moving tarball finish.
 *
 * @param fetchImpl - the project's fetch (proxy-aware), injected for tests.
 * @param url - what to fetch.
 * @param what - the download, for messages.
 * @param init - extra request options.
 * @returns the body bytes.
 */
export async function fetchBodyWhileProgressing(
  fetchImpl: (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<Response>,
  url: string,
  what: string,
  init: { headers?: Record<string, string> } = {},
): Promise<Uint8Array> {
  const controller = new AbortController()
  const deadline = setTimeout(
    () => {
      controller.abort(new DOMException('the response did not start in time', 'TimeoutError'))
    },
    HEADERS_TIMEOUT_MS,
  )
  let res: Response
  try {
    res = await fetchImpl(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(deadline)
  }
  if (!res.ok) throw new Error(`HTTP ${String(res.status)} reading ${what}`)
  return readBodyWhileProgressing(res, BODY_STALL_TIMEOUT_MS, what)
}
