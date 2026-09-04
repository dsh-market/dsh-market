/**
 * E2E fixture: proves its own liveness, INCLUDING its death.
 *
 * The market's `activation[name].state` is an inference drawn from the
 * profile's bundle list and patch layers — the exact reasoning that was
 * wrong in #103, #135 and #147 — so a spec that asserts on it checks the
 * market against itself. This marker is ground truth instead.
 *
 * It is written from inside the webServer injection, so its presence means
 * cordis resolved the package, loaded this module, ran `apply()` AND
 * satisfied the injection. It is removed on dispose, so it also goes false
 * when the plugin is unloaded — an HTTP route cannot do that job: routes
 * registered here outlive the plugin's disposal, and a probe built on one
 * reports a disabled plugin as still alive.
 */
import { writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dshm-e2e-fixture-a'

/**
 * The version of the build that is actually RUNNING, read from the copy of
 * package.json this module was loaded beside.
 *
 * Written into the marker so an update can be observed from outside: after
 * the market replaces this package on disk under a running host, a marker
 * still naming the old version proves the old module is what the process is
 * serving, and one naming the new version proves the host reloaded (#491).
 * `activation[name].state` is the market's own inference and cannot settle
 * that question about itself.
 */
const version = JSON.parse(
  readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), 'package.json'), 'utf8'),
).version

const marker = () => join(process.env.DSH_HOME ?? '.', `e2e-${name}.alive`)

export function apply(ctx) {
  ctx.inject(['webServer'], (host) => {
    // ctx.effect is how this host models a disposable side effect: the
    // returned function runs when the plugin is unloaded.
    host.effect(() => {
      writeFileSync(marker(), version)
      return () => { rmSync(marker(), { force: true }) }
    }, `${name}: e2e liveness marker`)
  })
}
