import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildPickPrompt, extractTerms, findPlugins, forgetResults, parsePickReply, recall, registerFindPlugin, resultFor, runFindPlugin, type LlmLike } from '../src/find-plugin.ts'
import type { Registry, RegistryPlugin } from '../src/registry.ts'

const plugin = (name: string, zh: string, en: string, category: string, downloads: number | null = null): RegistryPlugin => ({
  name, owner: 'someone', url: `https://github.com/someone/${name}`, category,
  description: { zh, en }, npm: name, downloads, install: `dsh plugin add ${name}`, added: '2026-11-01',
})

const registry: Registry = {
  updated: '2026-11-21', count: 6,
  categories: { notify: { zh: '通知与集成', en: 'Notifications' }, docs: { zh: '文档与渲染', en: 'Docs' }, memory: { zh: '记忆', en: 'Memory' } },
  plugins: [
    plugin('dsh-notify-me', '任务完成时发系统通知', 'Desktop notifications when a task finishes', 'notify', 500),
    plugin('dsh-qqbot', '把会话接到 QQ 机器人', 'Bridge sessions to a QQ bot', 'notify', 9000),
    plugin('callai-seo-mcp', 'SEO 关键词分析与文章优化', 'SEO keyword research and article optimization', 'docs', 40),
    plugin('dsh-novel', '长篇小说写作助手', 'Long-form novel writing assistant', 'docs', 300),
    plugin('memory-eternal', '让 AI 记住你说过的话', 'Long-term memory across sessions', 'memory', 80),
    { ...plugin('dsh-old-notify', '旧的通知插件', 'Old notifier', 'notify', 99999), deprecated: true },
  ],
}

describe('/find-plugin: reading the request', () => {
  it('drops the framing words and keeps what the request is about', () => {
    expect(extractTerms('dsh 通知类型的插件')).toEqual(['通知'])
    expect(extractTerms('find me a plugin for git commit messages')).toEqual(['git', 'commit', 'messages'])
  })

  it('splits glued Chinese into its words, without the seams between them', () => {
    const terms = extractTerms('找找 seo 优化写作的插件')
    expect(terms).toEqual(expect.arrayContaining(['seo', '优化', '写作']))
    expect(extractTerms('能让 AI 记住我说过的话')).not.toEqual(expect.arrayContaining(['住我', '说过']))
  })
})

describe('/find-plugin: recall', () => {
  it('ranks an entry that matches more of the request first, and never offers a deprecated one', () => {
    const { candidates, matched } = recall(registry, extractTerms('找找 seo 优化写作的插件'), 3)
    expect(candidates[0].plugin.name).toBe('callai-seo-mcp')
    expect(matched).toBeGreaterThan(0)
    const all = recall(registry, extractTerms('通知'), 10).candidates.map(c => c.plugin.name)
    expect(all).not.toContain('dsh-old-notify')
  })

  it('finds an entry through its category when the description uses another word', () => {
    const names = recall(registry, extractTerms('通知类型的插件'), 2).candidates.map(c => c.plugin.name)
    expect(names).toEqual(expect.arrayContaining(['dsh-notify-me', 'dsh-qqbot']))
  })

  it('still gives the model something to judge when no word matched, and says so in the prompt', () => {
    const found = recall(registry, extractTerms('量子纠缠'), 3)
    expect(found.matched).toBe(0)
    expect(found.candidates).toHaveLength(3)
    expect(buildPickPrompt('量子纠缠', registry, found).system).toMatch(/None of the candidates matched/)
  })
})

/** A model that answers with the given text, and records what it was asked. */
function fakeModel(reply: string | Error): LlmLike & { calls: Array<{ system?: string; messages: unknown[]; provider: string; model: string }> } {
  const calls: Array<{ system?: string; messages: unknown[]; provider: string; model: string }> = []
  return {
    calls,
    stream(options) {
      calls.push(options)
      return (async function* () {
        if (reply instanceof Error) throw reply
        yield { type: 'text-delta', text: reply.slice(0, 10) }
        yield { type: 'text-delta', text: reply.slice(10) }
      })()
    },
  }
}
const SELECTION = { provider: 'deepseek-official', model: 'deepseek-chat' }

describe('/find-plugin: the model picks', () => {
  it('keeps only names that were offered, in the model\'s order, at most five', () => {
    const allowed = new Set(['a', 'b', 'c'])
    const parsed = parsePickReply('```json\n{"intro":"ok","picks":[{"name":"b","why":"fits"},{"name":"zzz","why":"made up"},{"name":"a","why":"also"},{"name":"b","why":"dup"}]}\n```', allowed)
    expect(parsed).toEqual({ intro: 'ok', picks: [{ name: 'b', why: 'fits' }, { name: 'a', why: 'also' }] })
  })

  it('asks the user\'s model with the request and candidates, and returns card-ready picks', async () => {
    const llm = fakeModel('{"intro":"找到 1 个","picks":[{"name":"callai-seo-mcp","why":"专门做 SEO 写作"}]}')
    const result = await findPlugins({ request: '找找 seo 优化写作的插件', registry, llm, selection: SELECTION })
    expect(llm.calls[0]).toMatchObject(SELECTION)
    expect(JSON.stringify(llm.calls[0].messages)).toContain('callai-seo-mcp')
    expect(result.picks).toEqual([expect.objectContaining({ name: 'callai-seo-mcp', why: '专门做 SEO 写作', install: 'dsh plugin add callai-seo-mcp', categories: ['文档与渲染'] })])
    expect(result.model).toBe('deepseek-chat')
  })

  it('says to configure a model when there is none, or its key is missing', async () => {
    await expect(findPlugins({ request: 'seo', registry, llm: undefined, selection: undefined })).rejects.toMatchObject({ code: 'no-model' })
    const keyless = fakeModel(Object.assign(new Error('no API key'), { code: 'MISSING_CREDENTIAL' }))
    await expect(findPlugins({ request: 'seo', registry, llm: keyless, selection: SELECTION })).rejects.toMatchObject({ code: 'no-model', message: expect.stringMatching(/设置 → 模型/) })
  })

  it('reports a reply it cannot read as a retryable failure', async () => {
    await expect(findPlugins({ request: 'seo', registry, llm: fakeModel('sorry, I cannot help'), selection: SELECTION })).rejects.toMatchObject({ code: 'model-failed' })
  })
})

describe('/find-plugin: the command', () => {
  beforeEach(() => {
    forgetResults()
    vi.stubEnv('DSH_HOME', mkdtempSync(join(tmpdir(), 'dshm-find-')))
  })
  afterEach(() => { vi.unstubAllEnvs(); forgetResults() })

  const invocation = (rawInput: string, options?: { provider?: string; model?: string }) => ({
    commandId: 'cmd-1', agent: { options: options ?? SELECTION }, rawInput, signal: new AbortController().signal,
  })

  it('answers with readable text and keeps the structured picks for the card, under the command id', async () => {
    const llm = fakeModel('{"intro":"这个最合适","picks":[{"name":"dsh-notify-me","why":"任务完成就提醒"}]}')
    const result = await runFindPlugin(invocation('通知类型的插件'), async () => registry, { llm: () => llm, defaultSelection: () => undefined })
    expect(result).toEqual({ kind: 'success', text: expect.stringContaining('dsh-notify-me — 任务完成就提醒') })
    expect(resultFor('cmd-1')?.picks.map(pick => pick.name)).toEqual(['dsh-notify-me'])
  })

  it('uses the default model when the chat does not name one', async () => {
    const llm = fakeModel('{"intro":"","picks":[]}')
    await runFindPlugin(invocation('通知', {}), async () => registry, { llm: () => llm, defaultSelection: () => ({ provider: 'p', model: 'm' }) })
    expect(llm.calls[0]).toMatchObject({ provider: 'p', model: 'm' })
  })

  it('asks for a description instead of searching for nothing', async () => {
    const llm = fakeModel('{}')
    const result = await runFindPlugin(invocation('   '), async () => registry, { llm: () => llm, defaultSelection: () => undefined })
    expect(result.kind).toBe('error')
    expect(llm.calls).toHaveLength(0)
  })

  it('says the catalog is unreachable and what to do, without spending tokens', async () => {
    const llm = fakeModel('{}')
    const result = await runFindPlugin(invocation('notify'), async () => { throw new Error('fetch failed') }, { llm: () => llm, defaultSelection: () => undefined })
    expect(result).toMatchObject({ kind: 'error' })
    expect((result as { text: string }).text).toMatch(/fetch failed[\s\S]*Plugin Market/)
    expect(llm.calls).toHaveLength(0)
  })

  it('registers as find-plugin with a hint, and returns the registry\'s disposer', () => {
    const dispose = vi.fn()
    const register = vi.fn(() => dispose)
    expect(registerFindPlugin({ register }, async () => registry, { llm: () => undefined, defaultSelection: () => undefined })).toBe(dispose)
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ name: 'find-plugin', input: { hint: expect.any(String) } }))
  })
})
