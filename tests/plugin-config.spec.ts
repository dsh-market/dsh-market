import z from '@deepseek-ai/schemastery'
import { describe, expect, it } from 'vitest'
import { Config } from '../src/index.ts'

/**
 * The plugin entry's runtime configuration schema (#1144).
 *
 * dsh 0.1.7 stopped serving third-party settings namespaces through
 * `register()` and derives the form from the plugin's own `Config` schema
 * instead, so a plugin that only exports a TYPE has no form at all on those
 * hosts. These assertions pin the three things the host generation needs and
 * the one thing it must not do: carry the editable fields, stay loose enough
 * that an existing cordis.yml still boots, and keep "allowRestart was never
 * configured" expressible (#229).
 */

type Node = { dict?: Record<string, { meta?: Record<string, unknown> }>; meta?: Record<string, unknown> }

/** The schema as the host sees it: serialized, then rebuilt from JSON. */
function rebuilt(): Node {
  return new z(Config.toJSON()) as unknown as Node
}

describe('the plugin Config schema (#1144)', () => {
  it('serializes the way the host reads a schema', () => {
    // dsh-settings accepts a Config only when `'toJSON' in schema`, then
    // rebuilds it before deciding which fields are editable.
    expect(typeof Config.toJSON).toBe('function')
    expect(Object.keys(rebuilt().dict ?? {}).sort()).toEqual(['allowRestart', 'buildEnv', 'channel', 'maxSnapshots', 'profile', 'region'])
  })

  it('marks exactly the two fields the form may edit as volatile', () => {
    // A field without this marker is left out of the form, and the write path
    // refuses it ("Config field ... is not volatile"), so the marker is what
    // decides whether the host shows a control at all.
    const dict = rebuilt().dict ?? {}
    const volatile = Object.entries(dict).filter(([, field]) => field.meta?.volatile === true).map(([key]) => key)
    expect(volatile.sort()).toEqual(['allowRestart', 'maxSnapshots'])
  })

  it('keeps an existing cordis.yml bootable, including keys it never heard of', () => {
    const composed = { profile: 'web', allowRestart: false, maxSnapshots: 3, buildEnv: { CC: 'clang' }, channel: 'beta', unknown: { kept: true } }
    // The host validates the entry against this schema while resolving the
    // composition, so a strict schema would refuse to start instead of
    // ignoring what it does not own.
    expect(() => Config(composed)).not.toThrow()
    expect(Config(composed)).toMatchObject(composed)
    expect(() => Config({ profile: 3, allowRestart: 'yes', maxSnapshots: '5' })).not.toThrow()
  })

  it('leaves allowRestart absent when nobody configured it (#229)', () => {
    const empty = Config({}) as Record<string, unknown>
    // Restart detection decides the effective value for an unset entry; a
    // default here would turn "nobody said" into an explicit "on".
    expect(Object.hasOwn(empty, 'allowRestart')).toBe(false)
    expect(Object.hasOwn(empty, 'buildEnv')).toBe(false)
    expect(Config.simplify({})).toBeNull()
  })

  it('writes what the operator set back instead of dropping it', () => {
    // The loader stores `Config.simplify(config)` as the entry's new options,
    // so a field missing from the schema is deleted from cordis.yml by the
    // first form save — silently, and only for the operator who had one.
    const composed = { buildEnv: { CC: 'clang' }, allowRestart: true, channel: 'beta', region: 'cn' }
    expect(Config.simplify(composed)).toEqual(composed)
  })
})
