import { api } from './market-data.ts'

export type OperationWait = 'wait' | 'ask'

const CHANGED = 'dshm-operation-wait-change'

/** Browser origins isolate hosts; the path also isolates reverse-proxy mounts. */
export function operationWaitKey(): string {
  return `dshm-operation-wait:${api('/dsh-market')}`
}

export function readOperationWait(): OperationWait {
  try { return localStorage.getItem(operationWaitKey()) === 'ask' ? 'ask' : 'wait' }
  catch { return 'wait' }
}

/** Notify other cards in this page only after the choice reaches storage. */
export function saveOperationWait(value: OperationWait): void {
  localStorage.setItem(operationWaitKey(), value)
  window.dispatchEvent(new Event(CHANGED))
}

export function subscribeOperationWait(listener: () => void): () => void {
  window.addEventListener(CHANGED, listener)
  window.addEventListener('storage', listener)
  return () => {
    window.removeEventListener(CHANGED, listener)
    window.removeEventListener('storage', listener)
  }
}
