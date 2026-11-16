import { writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'dshm-e2e-fixture-carrier-enable-gate'
export function apply(ctx) {
  ctx.provide('e2eCarrierEnablePolicy', { fixture: true })
  const path = join(process.env.DSH_HOME, 'e2e-carrier-enable-gate.alive')
  ctx.effect(() => {
    writeFileSync(path, JSON.stringify({ pid: process.pid }))
    return () => rmSync(path, { force: true })
  }, 'carrier-enable gate lifecycle')
}
