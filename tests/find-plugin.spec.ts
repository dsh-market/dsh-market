import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildPickPrompt, extractTerms, findPlugins, forgetResults, parsePickReply, recall, recommendCandidates, recommendPlugins, registerFindPlugin, resultFor, runFindPlugin, setUserPluginsReader, setUsesMyPlugins, userSeeds, usesMyPlugins, type LlmLike } from '../src/find-plugin.ts'
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
  it('preserves the selected repository when two candidates share a name (#1290)', async () => {
    const first = { ...plugin('dsh-prompt-polish', '润色提示词', 'Polish prompts', 'docs', 200), owner: 'alice', url: 'https://github.com/alice/dsh-prompt-polish', npm: '@alice/dsh-prompt-polish', install: 'dsh plugin add @alice/dsh-prompt-polish' }
    const second = { ...first, owner: 'bob', url: 'https://github.com/bob/dsh-prompt-polish', npm: '@bob/dsh-prompt-polish', install: 'dsh plugin add @bob/dsh-prompt-polish', downloads: 50 }
    const llm = fakeModel(JSON.stringify({ picks: [{ id: 'p1', name: first.name, why: "Alice's npm package" }, { id: 'p2', name: second.name, why: "Bob's npm package" }] }))
    const result = await findPlugins({ request: first.name, registry: { ...registry, count: 2, plugins: [first, second] }, llm, selection: SELECTION })
    expect(result.picks).toEqual([
      expect.objectContaining({ url: first.url, npm: first.npm, owner: first.owner, why: "Alice's npm package" }),
      expect.objectContaining({ url: second.url, npm: second.npm, owner: second.owner, why: "Bob's npm package" }),
    ])
    const prompt = JSON.stringify(llm.calls[0].messages)
    expect(prompt).toContain('[p1] (alice / @alice/dsh-prompt-polish)')
    expect(prompt).toContain('[p2] (bob / @bob/dsh-prompt-polish)')
  })

  it('keeps offered IDs in model order, skipping unknown IDs, duplicates and bare names', () => {
    const allowed = new Set(['p1', 'p2', 'p3'])
    const parsed = parsePickReply('```json\n{"intro":"ok","picks":[{"id":"p2","why":"fits"},{"id":"p99","why":"made up"},{"name":"dsh-prompt-polish","why":"ambiguous"},{"id":"p1","why":"also"},{"id":"p2","why":"dup"}]}\n```', allowed)
    expect(parsed).toEqual({ intro: 'ok', picks: [{ id: 'p2', why: 'fits' }, { id: 'p1', why: 'also' }] })
  })

  it('asks the user\'s model with the request and candidates, and returns card-ready picks', async () => {
    const llm = fakeModel('{"intro":"找到 1 个","picks":[{"id":"p1","why":"专门做 SEO 写作"}]}')
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

  it('asks again once, with the whole instruction in the user message, when the first answer is prose (#1331)', async () => {
    const answers = ['你没提具体问题，我先给个判断……**p1** 不错', '{"intro":"这个合适","picks":[{"id":"p1","why":"做 SEO"}]}']
    const calls: Array<{ system?: string; messages: unknown[] }> = []
    const llm: LlmLike = {
      stream(options) {
        calls.push(options)
        const reply = answers[calls.length - 1] ?? ''
        return (async function* () { yield { type: 'text-delta', text: reply } })()
      },
    }
    const result = await findPlugins({ request: 'seo', registry, llm, selection: SELECTION })
    expect(result.picks).toHaveLength(1)
    expect(calls).toHaveLength(2)
    const userText = (call: { messages: unknown[] }): string => (call.messages[0] as { content: Array<{ text: string }> }).content[0]!.text
    // Even the first call repeats the format rule beside the lists…
    expect(userText(calls[0]!)).toMatch(/ONLY the JSON object/)
    // …and the retry carries the full system instruction in the message itself.
    expect(userText(calls[1]!)).toContain('Answer ONLY with one JSON object')
  })

  it('names what went wrong: nothing said, or said in the wrong shape', async () => {
    await expect(findPlugins({ request: 'seo', registry, llm: fakeModel(''), selection: SELECTION })).rejects.toMatchObject({ message: expect.stringMatching(/没有给出回答/) })
    await expect(findPlugins({ request: 'seo', registry, llm: fakeModel('just prose, twice'), selection: SELECTION })).rejects.toMatchObject({ message: expect.stringMatching(/没有按要求的格式/) })
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
    const llm = fakeModel('{"intro":"这个最合适","picks":[{"id":"p2","why":"任务完成就提醒"}]}')
    const result = await runFindPlugin(invocation('通知类型的插件'), async () => registry, { llm: () => llm, defaultSelection: () => undefined })
    expect(result).toEqual({ kind: 'success', text: expect.stringContaining('dsh-notify-me — 任务完成就提醒') })
    expect(resultFor('cmd-1')).toMatchObject({ selectionVersion: 2, picks: [{ name: 'dsh-notify-me' }] })
    expect(llm.calls).toHaveLength(1)
    expect(llm.calls[0]).not.toHaveProperty('temperature')
    expect(llm.calls[0]).not.toHaveProperty('reasoningEffort')
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

describe('AI recommendations from what the user has', () => {
  it('finds the user\'s plugins by package name and by favorited URL, never the market itself', () => {
    const seeds = userSeeds(registry, { installed: ['dsh-notify-me', 'dshmarket'], favorites: ['https://github.com/someone/dsh-novel/'] })
    expect(seeds.installed.map(p => p.name)).toEqual(['dsh-notify-me'])
    expect(seeds.favorited.map(p => p.name)).toEqual(['dsh-novel'])
  })

  it('offers neither what the user has, nor what was just shown, nor a deprecated entry; leans to their categories', () => {
    const seeds = userSeeds(registry, { installed: ['dsh-notify-me'], favorites: [] })
    const names = recommendCandidates(registry, seeds.installed, ['memory-eternal'], 3).map(c => c.plugin.name)
    expect(names).not.toContain('dsh-notify-me')
    expect(names).not.toContain('memory-eternal')
    expect(names).not.toContain('dsh-old-notify')
    expect(names[0]).toBe('dsh-qqbot')
  })

  it('does not call the model when there is nothing to go on', async () => {
    const llm = fakeModel('{}')
    await expect(recommendPlugins({ registry, installed: [], favorites: [], preferZh: true, llm, selection: SELECTION })).rejects.toMatchObject({ code: 'no-seeds' })
    expect(llm.calls).toHaveLength(0)
  })

  it('sends the user\'s plugins with the candidates, and keeps up to ten offered picks', async () => {
    const llm = fakeModel('{"intro":"你常用通知","picks":[{"id":"p1","why":"同类"},{"id":"p99","why":"不在候选里"}]}')
    const result = await recommendPlugins({ registry, installed: ['dsh-notify-me'], favorites: [], preferZh: true, llm, selection: SELECTION })
    expect(JSON.stringify(llm.calls[0].messages)).toMatch(/Installed:[\s\S]*dsh-notify-me[\s\S]*Candidates:/)
    expect(result.picks.map(p => p.name)).toEqual(['dsh-qqbot'])
  })
})

describe('/find-plugin and AI search with the user\'s plugins', () => {
  beforeEach(() => {
    forgetResults()
    vi.stubEnv('DSH_HOME', mkdtempSync(join(tmpdir(), 'dshm-consent-')))
    setUserPluginsReader(() => ({ installed: ['dsh-notify-me'], favorites: [] }))
  })
  afterEach(() => { vi.unstubAllEnvs(); forgetResults(); setUserPluginsReader(() => ({ installed: [], favorites: [] })) })

  const run = async (llm: ReturnType<typeof fakeModel>) => runFindPlugin(
    { commandId: 'c', agent: { options: SELECTION }, rawInput: '通知', signal: new AbortController().signal },
    async () => registry, { llm: () => llm, defaultSelection: () => undefined })

  it('reads nothing of the user\'s until they allow it, and says so on the result', async () => {
    expect(usesMyPlugins()).toBe(false)
    const llm = fakeModel('{"intro":"","picks":[{"id":"p2","why":"x"}]}')
    await run(llm)
    expect(JSON.stringify(llm.calls[0].messages)).not.toContain('Already installed')
    expect(resultFor('c')?.personalized).toBe(false)
  })

  it('once allowed, leaves installed plugins out and tells the model what the user has', async () => {
    setUsesMyPlugins(true)
    expect(usesMyPlugins()).toBe(true)
    const llm = fakeModel('{"intro":"","picks":[{"id":"p1","why":"x"}]}')
    await run(llm)
    const sent = JSON.stringify(llm.calls[0].messages)
    expect(sent).toMatch(/Already installed:[\s\S]*dsh-notify-me/)
    expect(sent.split('Candidates:')[1]).not.toContain('dsh-notify-me')
    expect(resultFor('c')?.personalized).toBe(true)
    setUsesMyPlugins(false)
    expect(usesMyPlugins()).toBe(false)
  })
})

describe('/find-plugin: a reply cut off mid-way', () => {
  it('keeps the complete picks before the cut', () => {
    const cut = '{"intro":"ok","picks":[{"id":"p1","why":"one"},{"id":"p2","why":"two"},{"id":"p3","wh'
    expect(parsePickReply(cut, new Set(['p1', 'p2', 'p3']), 10)).toEqual({ intro: 'ok', picks: [{ id: 'p1', why: 'one' }, { id: 'p2', why: 'two' }, { id: 'p3', why: '' }] })
  })
})

describe('/find-plugin: failures the host reports inside the stream', () => {
  it('reads a missing key reported as an error chunk as "set up a model"', async () => {
    const llm: LlmLike = { stream: () => (async function* () { yield { type: 'error', error: { code: 'MISSING_CREDENTIAL', message: 'no key' } } })() }
    await expect(findPlugins({ request: 'seo', registry, llm, selection: SELECTION })).rejects.toMatchObject({ code: 'no-model' })
  })
})

describe('/find-plugin: a call the host ends with an error finish', () => {
  it('reads a missing key as "set up a model"', async () => {
    const llm: LlmLike = { stream: () => (async function* () { yield { type: 'finish', reason: { kind: 'error', failure: { message: 'no API key', code: 'MISSING_CREDENTIAL' } } } })() }
    await expect(findPlugins({ request: 'seo', registry, llm, selection: SELECTION })).rejects.toMatchObject({ code: 'no-model' })
  })
})

describe('/find-plugin: a thinking model', () => {
  it.each([
    { provider: 'openai', model: 'gpt-6.1-sol', reasoningEffort: 'medium' },
    { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'off' },
    { provider: 'custom-gateway', model: 'model-alias' },
  ])('lets DSH apply model defaults for $provider', async selection => {
    // Picks are made by candidate ID: answer with the ID the prompt gave callai-seo-mcp.
    const calls: Array<Record<string, unknown>> = []
    const llm: LlmLike & { calls: Array<Record<string, unknown>> } = {
      calls,
      stream(options) {
        calls.push(options)
        const content = JSON.stringify(options.messages)
        const id = /\[(p\d+)\][^\n]*?callai-seo-mcp/u.exec(content.replace(/\\n/g, '\n'))?.[1] ?? 'p0'
        return (async function* () { yield { type: 'text-delta', text: JSON.stringify({ intro: '', picks: [{ id, why: 'fits' }] }) } })()
      },
    }
    const search = await findPlugins({ request: 'seo', registry, llm, selection })
    const recommendations = await recommendPlugins({
      registry, llm, selection, installed: ['dsh-notify-me'], favorites: [], preferZh: false,
    })
    expect(search.picks.map(pick => pick.name)).toEqual(['callai-seo-mcp'])
    expect(recommendations.picks.map(pick => pick.name)).toEqual(['callai-seo-mcp'])
    expect(llm.calls).toHaveLength(2)
    const { provider, model } = selection
    expect(llm.calls[0]).toMatchObject({ provider, model, maxTokens: 6000 })
    expect(llm.calls[1]).toMatchObject({ provider, model, maxTokens: 8000 })
    for (const call of llm.calls) {
      expect(call).not.toHaveProperty('temperature')
      expect(call).not.toHaveProperty('reasoningEffort')
    }
  })

  it('takes the answer from the thinking when the budget ran out before the reply', async () => {
    const llm: LlmLike = { stream: () => (async function* () { yield { type: 'reasoning-delta', text: 'so: {"intro":"","picks":[{"id":"p1","why":"fits"}]}' } })() }
    const result = await findPlugins({ request: 'seo', registry, llm, selection: SELECTION })
    expect(result.picks.map(p => p.name)).toEqual(['callai-seo-mcp'])
  })
})

describe('entries from an added catalog', () => {
  // No downloads, no stars, no owner, a link that is not on the public host, and a source tag.
  const priv = (name: string, zh: string, en: string, category: string, npm: string | null = name): RegistryPlugin => ({
    name, owner: '', url: `https://repo.acme.internal/tools/${name}`, category, description: { zh, en }, npm,
    install: npm ?? name, added: '2026-11-01', source: { id: 'acme', label: { en: 'Acme internal' } },
  })
  const merged: Registry = {
    ...registry,
    categories: { ...registry.categories, hr: { zh: '人事', en: 'People' } },
    plugins: [priv('acme-badge', '打印员工工牌', 'Print employee badges', 'hr', '@acme/badge'), ...registry.plugins],
  }

  it('recalls them by name, description and category without choking on missing numbers', () => {
    const byWord = recall(merged, extractTerms('员工工牌'), 3).candidates
    expect(byWord[0]!.plugin.name).toBe('acme-badge')
    expect(recall(merged, extractTerms('人事'), 3).candidates[0]!.plugin.name).toBe('acme-badge')
    // and they still fill a vague request instead of throwing on a missing count
    expect(() => recall(merged, [], 10)).not.toThrow()
  })

  it('finds them among the user\'s own by npm name and by favorited link', () => {
    const installed = userSeeds(merged, { installed: ['@acme/badge'], favorites: [] })
    expect(installed.installed.map(p => p.name)).toEqual(['acme-badge'])
    const favorited = userSeeds(merged, { installed: [], favorites: ['https://repo.acme.internal/tools/acme-badge/'] })
    expect(favorited.favorited.map(p => p.name)).toEqual(['acme-badge'])
  })

  it('offers them as recommendations, and learns taste from one', () => {
    const fromPublic = recommendCandidates(merged, [merged.plugins.find(p => p.name === 'dsh-notify-me')!])
    expect(fromPublic.map(c => c.plugin.name)).toContain('acme-badge')
    const fromPrivate = recommendCandidates(merged, [merged.plugins[0]!])
    expect(fromPrivate.map(c => c.plugin.name)).not.toContain('acme-badge')
    expect(fromPrivate.length).toBeGreaterThan(0)
  })
})
