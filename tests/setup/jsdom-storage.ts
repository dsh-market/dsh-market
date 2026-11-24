// Node 26 publishes `localStorage` / `sessionStorage` as globals of its own
// (behind `--localstorage-file`). Vitest installs jsdom's window over
// `globalThis`, but Node's accessors win: the spec sees `undefined`, and
// `localStorage.clear()` throws `Cannot read properties of undefined`. jsdom
// still built a real `Storage` for the window — it is reachable as
// `_localStorage` — so the repair is to put it back before any spec runs.
//
// Guarded on two counts, because this has to be a no-op everywhere else: the
// global must be missing (older Nodes, or Node 26 with the flag, already work)
// and the window's own storage must exist (the node-environment lane has no
// jsdom at all).
const scope = globalThis as unknown as Record<string, unknown>
for (const name of ['localStorage', 'sessionStorage']) {
  if (scope[name] !== undefined) continue
  const built = scope[`_${name}`]
  if (built === undefined) continue
  Object.defineProperty(scope, name, { value: built, configurable: true, writable: true })
}