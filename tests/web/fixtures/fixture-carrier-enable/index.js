import { writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'dshm-e2e-fixture-carrier-enable'
export function apply(ctx) {
  const path = join(process.env.DSH_HOME, 'e2e-carrier-enable-native.alive')
  ctx.effect(() => {
    writeFileSync(path, JSON.stringify({ pid: process.pid }))
    return () => rmSync(path, { force: true })
  }, 'carrier-enable native lifecycle')
}
