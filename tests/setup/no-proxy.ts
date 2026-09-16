// The unit lane never reaches the network: every request a spec cares about
// is answered by a stub on the global fetch. A proxy in the developer's
// environment defeats that — `marketFetch` (src/net.ts) goes through undici
// with a proxy agent whenever http(s)_proxy is set, and the stub never sees
// the request — so on a machine with HTTPS_PROXY exported 63 of the suite's
// tests failed for reasons that had nothing to do with the code under test,
// and the #148 proxy spec read the machine's lowercase `https_proxy` in place
// of the value it had set. Drop the variables before any spec runs; a spec
// that wants a proxy sets one itself (tests/dsh-cli.spec.ts does).
//
// Only the unit lane: the compat and web lanes drive real pnpm and a real
// browser, which may need the proxy to reach anything at all.
for (const key of ['http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'npm_config_proxy', 'npm_config_https_proxy']) {
  delete process.env[key]
  delete process.env[key.toUpperCase()]
}
