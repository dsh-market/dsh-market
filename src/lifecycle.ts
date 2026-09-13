/** Bound asynchronous loader work without pretending that timeout cancels it. */
export class LifecycleWaitError extends Error {}

const pending = new WeakMap<object, Promise<unknown>>()
const WAIT_MS = 10_000

/** Never start a second mutation on a loader object whose earlier work is pending. */
export async function waitForLifecycle<T>(key: object, start: () => T | Promise<T>, label: string): Promise<T> {
  if (pending.has(key)) throw new LifecycleWaitError(`${label}: previous operation is still pending`)
  const operation = Promise.resolve().then(start)
  pending.set(key, operation)
  // Both handlers remain attached after timeout, including for late rejection.
  void operation.then(
    () => { if (pending.get(key) === operation) pending.delete(key) },
    () => { if (pending.get(key) === operation) pending.delete(key) },
  )
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new LifecycleWaitError(`${label}: did not settle within ${WAIT_MS / 1000}s; runtime state is uncertain`)), WAIT_MS)
      }),
    ])
  } finally { clearTimeout(timer) }
}
