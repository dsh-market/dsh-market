import { writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'dshm-e2e-fixture-carrier-enable-dependent'
export function apply(ctx) {
  const path = join(process.env.DSH_HOME, 'e2e-carrier-enable-dependent.alive')
  ctx.effect(() => {
    writeFileSync(path, JSON.stringify({ pid: process.pid, policyReady: ctx.get('e2eCarrierEnablePolicy')?.fixture === true }))
    return () => rmSync(path, { force: true })
  }, 'carrier-enable dependent lifecycle')
}
