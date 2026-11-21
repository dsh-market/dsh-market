/**
 * `/find-plugin` on a blank session (the home screen, before any message).
 *
 * DSH keeps a session blank until a model turn runs, and a blank session
 * draws no conversation, so the command's row (and its cards) never appears
 * there. The client still announces every executed command
 * (`command/executed`); when the chat did not draw our row shortly after, the
 * market shows the same result in a frame-wide overlay instead.
 */
type Listener = () => void

export interface OverlayRequest { sessionId: string; error: string | null }

let request: OverlayRequest | null = null
let lastRowAt = 0
const listeners = new Set<Listener>()
const emit = (): void => { for (const listener of [...listeners]) listener() }

/** A find-plugin row just drew in the chat. */
export function noteFindRowShown(): void { lastRowAt = Date.now() }

/** How long to wait for the chat row before deciding it is not coming. */
const GRACE_MS = 1500
/** How far ahead of the returned call the chat may already have drawn the row. */
const ROW_LEAD_MS = 5000

export function onFindPluginExecuted(sessionId: string, result: { kind?: string; text?: string } | undefined): void {
  const executedAt = Date.now()
  setTimeout(() => {
    // The chat's own events can draw the row before the command call returns,
    // so a row drawn shortly before counts too.
    if (lastRowAt >= executedAt - ROW_LEAD_MS) return
    request = { sessionId, error: result?.kind === 'error' ? result.text ?? '' : null }
    emit()
  }, GRACE_MS)
}

export function overlayRequest(): OverlayRequest | null { return request }
export function closeOverlay(): void { request = null; emit() }
export function subscribeOverlay(listener: Listener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
