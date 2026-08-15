/**
 * pnpm --reporter=ndjson parsing (P1-6). Fixture lines are real pnpm 11.16
 * output captured 2026-08-15 (bole stream on stdout, one JSON object per
 * line); unknown events and malformed/human lines must be tolerated.
 */

import { describe, expect, it } from 'vitest'
import { createProgressTracker } from '../src/ndjson.ts'

function feed(lines: string[]): ReturnType<typeof createProgressTracker>['snapshot'] {
  const tracker = createProgressTracker()
  for (const line of lines) tracker.feed(line)
  return tracker.snapshot
}

describe('pnpm ndjson progress parser', () => {
  it('tracks stage → phase transitions', () => {
    const snap = feed([
      '{"time":1,"name":"pnpm:stage","prefix":"p","stage":"resolution_started"}',
      '{"time":2,"name":"pnpm:stage","prefix":"p","stage":"resolution_done"}',
      '{"time":3,"name":"pnpm:stage","prefix":"p","stage":"importing_started"}',
      '{"time":4,"name":"pnpm:stage","prefix":"p","stage":"importing_done"}',
    ])
    expect(snap.seen).toBe(true)
    // The last stage wins; importing_* both mean linking.
    expect(snap.phase).toBe('linking')
  })

  it('counts distinct packages from progress events, resolved before fetched', () => {
    const snap = feed([
      '{"time":1,"name":"pnpm:progress","packageId":"file:../pkg","status":"resolved"}',
      '{"time":2,"name":"pnpm:progress","packageId":"is-odd@3.0.1","status":"resolved"}',
      '{"time":3,"name":"pnpm:progress","packageId":"is-odd@3.0.1","status":"fetched"}',
    ])
    expect(snap.phase).toBe('downloading')
    expect(snap.done).toBe(2)
    expect(snap.currentPackage).toBe('is-odd@3.0.1')
  })

  it('surfaces byte progress from fetching-progress events', () => {
    const snap = feed([
      '{"time":1,"name":"pnpm:fetching-progress","packageId":"esbuild@0.25.0","status":"started","size":10123456,"attempt":1}',
      '{"time":2,"name":"pnpm:fetching-progress","packageId":"esbuild@0.25.0","status":"in_progress","downloaded":5000000}',
    ])
    expect(snap.phase).toBe('downloading')
    expect(snap.currentPackage).toBe('esbuild@0.25.0')
    expect(snap.size).toBe(10123456)
    expect(snap.downloaded).toBe(5000000)
    expect(snap.done).toBe(1)
  })

  it('switches to the building phase and names the package from lifecycle events', () => {
    const snap = feed([
      JSON.stringify({
        time: 1, name: 'pnpm:lifecycle', depPath: 'esbuild@0.25.0', stage: 'postinstall',
        wd: 'C:\\app\\node_modules\\.pnpm\\esbuild@0.25.0\\node_modules\\esbuild',
        script: 'node install.js',
      }),
    ])
    expect(snap.phase).toBe('building')
    expect(snap.currentPackage).toContain('esbuild')
  })

  it('merges ignored-scripts package names', () => {
    const snap = feed([
      '{"time":1,"name":"pnpm:ignored-scripts","packageNames":["esbuild","koffi"]}',
    ])
    expect(snap.ignoredBuilds).toEqual(['esbuild', 'koffi'])
  })

  it('strips @version suffixes from ignored-scripts names (pnpm 11 ndjson)', () => {
    // pnpm 11's `pnpm:ignored-scripts` event reports version-qualified names
    // (cloudflared@0.7.3), but the approve-builds allowlist keys and
    // node_modules lookups use bare package names.
    const snap = feed([
      '{"time":1,"name":"pnpm:ignored-scripts","packageNames":["cloudflared@0.7.3","cpu-features@0.0.10","ssh2@1.17.0","@scope/pkg@1.2.3"]}',
    ])
    expect(snap.ignoredBuilds).toEqual(['cloudflared', 'cpu-features', 'ssh2', '@scope/pkg'])
    // scoped bare names and duplicates stay untouched
    const snap2 = feed([
      '{"time":1,"name":"pnpm:ignored-scripts","packageNames":["@scope/pkg","cloudflared@0.7.3","cloudflared@0.7.3"]}',
    ])
    expect(snap2.ignoredBuilds).toEqual(['@scope/pkg', 'cloudflared'])
  })

  it('captures the fatal error message from the stream', () => {
    const snap = feed([
      '{"time":1,"name":"pnpm","level":"error","prefix":"p","err":{"name":"pnpm","message":"Unexpected token \\"{\\" is not valid JSON","stack":"at JSON.parse"}}',
    ])
    expect(snap.error).toContain('is not valid JSON')
  })

  it('ignores unknown events, malformed JSON and human fallback lines', () => {
    const tracker = createProgressTracker()
    tracker.feed('Progress: resolved 10, reused 2, downloaded 3, added 1')
    tracker.feed('WARN Ignored build scripts: esbuild')
    tracker.feed('{not json')
    tracker.feed('{"time":1,"name":"pnpm:unknown","whatever":true}')
    expect(tracker.snapshot.seen).toBe(false)
    expect(tracker.snapshot.phase).toBeNull()
    expect(tracker.snapshot.done).toBe(0)
  })

  it('reset clears the snapshot for the next run', () => {
    const tracker = createProgressTracker()
    tracker.feed('{"time":1,"name":"pnpm:stage","prefix":"p","stage":"resolution_started"}')
    expect(tracker.snapshot.phase).toBe('resolving')
    tracker.reset()
    expect(tracker.snapshot).toEqual({
      phase: null, done: 0, total: null, currentPackage: null,
      downloaded: null, size: null, seen: false, error: null, ignoredBuilds: [],
    })
  })
})
