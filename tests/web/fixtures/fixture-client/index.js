import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
const f = join(process.env.DSH_HOME ?? '.', 'client-fixture.log')
export function apply(ctx) {
  appendFileSync(f, 'apply\n')
  ctx.effect(() => () => appendFileSync(f, 'dispose\n'), 'client fixture')
}
