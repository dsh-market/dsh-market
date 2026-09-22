// @vitest-environment jsdom
/**
 * The host rename behind #670. DSH 0.1.7-alpha.1 made product icon names
 * size-neutral and weight-suffixed and dropped the size-suffixed names this
 * plugin imported, so every glyph resolved to `undefined` and the first
 * `<Icon…>` in the tree threw React #130 — the market rendered nothing.
 * `latest` is still 0.1.5-rc.2, which exports only the old names, so neither
 * name is importable statically. src/client/icons.ts resolves each glyph from
 * the host's injected module table at call time; these tests pin every host
 * shape it has to survive.
 */
import { cleanup, render } from '@testing-library/react'
import { createElement as h, type ReactElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => {
  cleanup()
  vi.doUnmock('@deepseek-ai/dsh-client-ui-primitives')
  vi.resetModules()
})

/** Every glyph, and the name each generation of the host exports it as. */
const GLYPHS = [
  ['IconChevronDown', 'IconChevronDownOutlineRegular', 'IconChevronDownOutline14'],
  ['IconChevronUp', 'IconChevronUpOutlineRegular', 'IconChevronUpOutline14'],
  ['IconChevronLeft', 'IconChevronLeftOutlineRegular', 'IconChevronLeftOutline14'],
  ['IconChevronRight', 'IconChevronRightOutlineRegular', 'IconChevronRightOutline14'],
  ['IconCheck', 'IconCheckOutlineRegular', 'IconCheckOutline16'],
  ['IconClose', 'IconCloseOutlineRegular', 'IconCloseOutline16'],
  ['IconSearch', 'IconSearchOutlineRegular', 'IconSearchOutline16'],
  ['IconRefresh', 'IconRefreshOutlineRegular', 'IconRefreshOutline14'],
  ['IconWarning', 'IconWarningOutlineRegular', 'IconWarningOutline16'],
  ['IconQuestion', 'IconQuestionOutlineRegular', 'IconQuestionOutline14'],
  ['IconSparkle', 'IconSparkleRegular', 'IconSparkle16'],
  ['IconCode', 'IconCodeOutlineRegular', 'IconCodeOutline16'],
  ['IconCordisPlugin', 'IconCordisPluginOutlineRegular', 'IconCordisPluginOutline14'],
  ['IconLoading', 'IconLoadingOutlineRegular', 'IconLoadingOutline16'],
  ['IconLink', 'IconLinkOutlineRegular', 'IconLinkOutline14'],
  ['IconDownload', 'IconDownloadOutlineRegular', 'IconDownloadOutline16'],
  ['IconFullscreen', 'IconFullscreenOutlineRegular', 'IconFullscreenOutline16'],
  ['IconFolderOpen', 'IconFolderOpenRegular', 'IconFolderOpen16'],
] as const

type ResolvedIcons = Record<string, (props: { size?: number }) => ReactElement | null>

/** A stand-in host glyph that names the export it was resolved from. */
const hostGlyph = (from: string) => (props: { size?: number }) =>
  h('svg', { 'data-from': from, width: props.size })

/** Import icons.ts against a host table exporting exactly `host`. */
async function iconsOn(host: Record<string, unknown>): Promise<ResolvedIcons> {
  vi.resetModules()
  vi.doMock('@deepseek-ai/dsh-client-ui-primitives', () => host)
  return await import('../../src/client/icons.ts') as unknown as ResolvedIcons
}

const renderedFrom = (component: ResolvedIcons[string]): string | null => {
  const { container } = render(h(component, { size: 14 }))
  return container.querySelector('svg')?.getAttribute('data-from') ?? null
}

it('resolves every glyph from the size-neutral names a 0.1.7 host exports', async () => {
  const icons = await iconsOn(Object.fromEntries(GLYPHS.map(([, modern]) => [modern, hostGlyph(modern)])))
  for (const [local, modern] of GLYPHS) {
    expect(renderedFrom(icons[local]), local).toBe(modern)
  }
})

it('falls back to the size-suffixed names a pre-0.1.7 host exports', async () => {
  const icons = await iconsOn(Object.fromEntries(GLYPHS.map(([, , legacy]) => [legacy, hostGlyph(legacy)])))
  for (const [local, , legacy] of GLYPHS) {
    expect(renderedFrom(icons[local]), local).toBe(legacy)
  }
})

it('renders nothing, rather than throwing, on a host that exports neither name', async () => {
  const icons = await iconsOn({ Button: () => null })
  for (const [local] of GLYPHS) {
    const { container } = render(h(icons[local]))
    expect(container.innerHTML, local).toBe('')
  }
})
