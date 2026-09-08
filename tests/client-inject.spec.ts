/**
 * What the market's client declares it needs, against what it touches.
 *
 * `dsh.client.inject` is a HARD gate: the host holds the client entry back
 * until every listed seam exists. A seam that is listed but never used is
 * therefore not free — it is a version of the host the market refuses to
 * run on, bought for nothing.
 *
 * That is not hypothetical. @MarchLiu found (#554) that on dsh 0.1.2-rc.1
 * the market's presence silently stopped `dsh-context` from registering its
 * commands, and traced it by binary search to the market's entry alone. The
 * market listed `@deepseek-ai/dsh-client-runtime` — a seam that release
 * ships incompletely, and that had already hard-failed another plugin's
 * boot — and `@deepseek-ai/dsh-client-connection`, and used NEITHER. Both
 * had been in the manifest since 0.1.0 and never removed when the code that
 * might have needed them was not written.
 *
 * This test is the thing that was missing: a declaration and its use, kept
 * next to each other. It reads the client source rather than a hand-written
 * list, so adding `ctx.something` without declaring its seam fails too.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** The host services the client entry actually reaches for. */
function servicesUsed(): Set<string> {
  const source = readFileSync(resolve('src/client/index.ts'), 'utf8')
  const used = new Set<string>()
  // `ctx.locale`, `ctx.theme`, `ctx.slots`, … — the property access IS the
  // dependency, which is why this is read from the source and not declared.
  for (const match of source.matchAll(/\bctx\.([a-zA-Z][a-zA-Z0-9]*)/g)) used.add(match[1]!)
  // Nested injects name their service as a string instead.
  for (const match of source.matchAll(/\.inject\(\[([^\]]*)\]/g)) {
    for (const name of match[1]!.split(',')) {
      const clean = name.trim().replace(/^['"`]|['"`]$/g, '')
      if (clean !== '') used.add(clean)
    }
  }
  return used
}

/**
 * Which service each declared seam provides.
 *
 * Only the seams the market has ever listed need an entry; an unknown one
 * fails the test below, which is the point — a new inject has to be
 * justified by naming what it provides.
 */
const SEAM_PROVIDES: Record<string, string> = {
  '@deepseek-ai/dsh-client-locale': 'locale',
  '@deepseek-ai/dsh-client-ui-settings': 'slots',
  '@deepseek-ai/dsh-client-ui-theme': 'theme',
  '@deepseek-ai/dsh-client-connection': 'connection',
  '@deepseek-ai/dsh-client-runtime': 'runtime',
}

const declared: string[] = (JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
  dsh: { client: { inject: string[] } }
}).dsh.client.inject

describe('dsh.client.inject', () => {
  it('declares only seams the client entry actually uses (#554)', () => {
    const used = servicesUsed()
    const unused = declared.filter(seam => {
      const service = SEAM_PROVIDES[seam]
      expect(service, `unknown seam ${seam}: add what it provides to SEAM_PROVIDES`).toBeDefined()
      return !used.has(service!)
    })
    // Every entry here is a host version the market will not start on, in
    // exchange for nothing.
    expect(unused).toEqual([])
  })

  it('declares every seam the client entry depends on at module level', () => {
    // The other direction: reaching for `ctx.locale` without declaring the
    // locale seam means the entry runs before the service exists.
    const used = servicesUsed()
    const provided = new Set(declared.map(seam => SEAM_PROVIDES[seam]))
    // `effect` and `on` are cordis's own, not seams; `settingsScope` is
    // injected nested precisely so its absence does not gate the entry.
    const ownedByCordis = new Set(['effect', 'on', 'settingsScope'])
    const missing = [...used].filter(service => !provided.has(service) && !ownedByCordis.has(service))
    expect(missing).toEqual([])
  })

  it('does not gate the whole entry on a service that is optional in practice', () => {
    // settingsScope is the standing example: it exists only on rc.7+, and a
    // module-level inject would have taken the market's own page away on
    // rc.6 to gain a card rc.6 cannot render. It stays nested.
    expect(declared).not.toContain('@deepseek-ai/dsh-client-ui-settings-scope')
    expect(readFileSync(resolve('src/client/index.ts'), 'utf8')).toContain("inject(['settingsScope']")
  })
})
