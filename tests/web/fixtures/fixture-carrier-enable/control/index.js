/** Calls the real official service without adding an HTTP control route.
 * All commands and evidence stay in the scaffold's throwaway DSH_HOME. */
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'dshm-e2e-fixture-carrier-enable-control'
const target = 'dshm-e2e-fixture-carrier-enable'
export function apply(ctx) {
  ctx.inject(['pluginManager'], host => {
    host.effect(() => {
      const base = process.env.DSH_HOME
      const request = join(base, 'carrier-enable-control.request.json')
      const response = join(base, 'carrier-enable-control.response.json')
      const ready = join(base, 'carrier-enable-control.ready.json')
      const manager = host.pluginManager
      const supported = ['listPlugins', 'setBundleEnabled', 'setPluginEnabled'].every(method => typeof manager[method] === 'function')
      writeFileSync(ready, JSON.stringify({ supported, pid: process.pid }))
      let busy = false
      let seen
      let executions = 0
      if (existsSync(response)) {
        const previous = JSON.parse(readFileSync(response, 'utf8'))
        seen = previous.id
        executions = previous.executions ?? 0
      }
      const timer = setInterval(async () => {
        if (busy || !existsSync(request)) return
        let command
        try { command = JSON.parse(readFileSync(request, 'utf8')) } catch { return }
        if (typeof command.id !== 'string' || command.id === seen) return
        seen = command.id
        busy = true
        executions += 1
        let result
        try {
          const bundle = await manager.setBundleEnabled(target, true)
          const rows = (await manager.listPlugins()).filter(row => row.moduleName === target || row.moduleName === `${target}/gate`)
          const components = []
          for (const row of rows) components.push(await manager.setPluginEnabled(row.entryId, true))
          result = { id: command.id, executions, ok: rows.length === 2 && bundle.application !== 'failed' && components.every(item => item.application !== 'failed'), rows: rows.map(({ moduleName, entryId }) => ({ moduleName, entryId })) }
        } catch (error) {
          result = { id: command.id, executions, ok: false, rows: [], error: String(error) }
        }
        // A later host must only observe the persisted result, never execute
        // the same enable again and conceal a boot-replay regression.
        if (existsSync(request) && JSON.parse(readFileSync(request, 'utf8')).id === command.id) rmSync(request)
        writeFileSync(response + '.tmp', JSON.stringify(result))
        renameSync(response + '.tmp', response)
        busy = false
      }, 100)
      return () => { clearInterval(timer); rmSync(ready, { force: true }) }
    }, 'official carrier re-enable test control')
  })
}
