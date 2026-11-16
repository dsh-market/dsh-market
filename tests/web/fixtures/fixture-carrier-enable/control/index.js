/** Calls the real official service without adding an HTTP control route.
 * All commands and evidence stay in the scaffold's throwaway DSH_HOME. */
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'dshm-e2e-fixture-carrier-enable-control'
const target = 'dshm-e2e-fixture-carrier-enable'
const isTarget = row => row.moduleName === target || row.moduleName === `${target}/gate`
const changeEvidence = result => ({
  application: result.application,
  changed: result.changed,
  ...(result.error === undefined ? {} : { error: {
    code: result.error.code,
    diagnostic: result.error.diagnostic?.slice(0, 2000),
  } }),
})
const rowEvidence = ({ moduleName, entryId, enabled, fiberPhase, readOnlyReason }) =>
  ({ moduleName, entryId, enabled, fiberPhase, readOnlyReason })
export function apply(ctx) {
  ctx.inject(['pluginManager'], host => {
    host.effect(() => {
      const base = process.env.DSH_HOME
      const request = join(base, 'carrier-enable-control.request.json')
      const response = join(base, 'carrier-enable-control.response.json')
      const ready = join(base, 'carrier-enable-control.ready.json')
      const manager = host.pluginManager
      const supported = ['listPlugins', 'listBundles', 'setBundleEnabled', 'setPluginEnabled'].every(method => typeof manager[method] === 'function')
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
          const requestedRows = (await manager.listPlugins()).filter(isTarget)
          const components = []
          for (const row of requestedRows) {
            components.push({
              entryId: row.entryId, moduleName: row.moduleName,
              result: changeEvidence(await manager.setPluginEnabled(row.entryId, true)),
            })
          }
          // On 0.2.0-rc.2, selecting the bundle can report a pending dependent
          // while its gate still has the market's disabled patch. Keep that
          // intermediate result, then judge the completed component switches
          // against the official manager's current selection and live rows.
          const selected = (await manager.listBundles()).find(item => item.name === target)
          const rows = (await manager.listPlugins()).filter(isTarget).map(rowEvidence)
          const bundleSelected = selected?.enabled === true && selected.error === undefined
          const componentsApplied = components.length === 2 && components.every(({ result }) =>
            result.error === undefined && (result.application === 'applied' || result.application === 'restart-required'))
          const live = rows.length === 2 && rows.every(row => row.enabled === true && row.fiberPhase === 'active')
          result = {
            id: command.id, executions, ok: bundleSelected && componentsApplied && live,
            bundle: changeEvidence(bundle), bundleSelected, components,
            requestedRows: requestedRows.map(rowEvidence), rows,
          }
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
