/**
 * `/find-plugin <what you want>` in the DSH chat.
 *
 * A person asks for a thing, not for a keyword: "通知类型的插件", "找找 seo
 * 优化写作的插件". Keyword search alone cannot read that (no plugin lists every
 * word, and the filler words match nothing), so this is two steps:
 *
 *  1. Recall, here and cheap: drop the filler, expand synonyms, and keep every
 *     catalog entry that matches ANY remaining word, ranked by how many
 *     matched and where (name > category > description). About twenty.
 *  2. Judgement, by the user's own model (the one their chat uses, or the
 *     default one for the market's AI search): it picks the few that really
 *     fit and says why, as JSON. That is their model and their tokens, spent
 *     on getting the answer right.
 *
 * The pick runs as a one-shot model call, not as a chat turn: the result is a
 * command result (rendered as cards by the market's command-row renderer), so
 * it never enters the conversation the user is having with the model.
 *
 * Nothing here installs anything. The cards offer the market's own install
 * dialog (recommended), a direct install that still confirms first, or the
 * install command to copy.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveDshHome } from './home-paths.ts'
import { logEvent } from './log.ts'
import { SEARCH_SYNONYM_GROUPS } from './search-synonyms.ts'
import { pluginCategories, type Registry, type RegistryPlugin } from './registry.ts'

/** How many candidates go to the model. Enough to cover a vague request, few enough to read. */
export const CANDIDATE_LIMIT = 30

/** Words that frame a request without saying what it is about. */
const FILLER_ZH = [
  '帮我找找', '帮我找', '帮我', '给我找', '给我', '找一找', '找找', '找一下', '找个', '找', '搜索', '搜一下', '搜',
  '我想要', '我想', '想要', '需要', '有没有', '有什么', '有哪些', '推荐一下', '推荐', '一些', '一下', '请问',
  '插件市场里的', '插件市场', '插件', '类型', '种类', '相关的', '相关', '方面的', '方面', '用于', '用来', '可以', '能够', '能',
  '的', '了', '吗', '呢', '吧', '一个', '个',
]
const FILLER_EN = new Set([
  'find', 'search', 'show', 'give', 'recommend', 'looking', 'look', 'need', 'want', 'please', 'help', 'me', 'my', 'i', 'a', 'an', 'the',
  'some', 'any', 'for', 'to', 'of', 'that', 'which', 'with', 'can', 'could', 'would', 'is', 'are', 'there', 'plugin', 'plugins', 'dsh',
  'about', 'related', 'type', 'kind', 'and', 'or',
])

/** Pronouns and particles: a two-character piece containing one is a seam, not a word. */
const SEAM_CHARS = new Set([...'我你他她它们的了过着说让把被给能会要想在是和与或就都也还很'])

/** What was asked, minus the filler: the words worth matching. */
export function extractTerms(input: string): string[] {
  let text = input.toLowerCase().replace(/\s+/gu, ' ').trim()
  // Longest filler first, so "帮我找找" goes before "帮我" before "找".
  for (const word of [...FILLER_ZH].sort((a, b) => b.length - a.length)) text = text.split(word).join(' ')
  const terms: string[] = []
  const seen = new Set<string>()
  for (const raw of text.split(/[\s,，。.!！?？、;；:：()（）"'“”‘’/\\|]+/u)) {
    const token = raw.trim()
    if (token === '' || FILLER_EN.has(token)) continue
    // A run of Han characters without spaces ("优化写作") is several ideas
    // glued together: keep the run, and also every two-character piece, which
    // is the smallest unit that still means something. A piece that leans on
    // a pronoun or particle ("住我", "说过") is a seam between words, not a
    // word, and only adds noise.
    const han = token.match(/\p{Script=Han}+/gu) ?? []
    const latin = token.replace(/\p{Script=Han}+/gu, ' ').split(' ').filter(piece => piece.length >= 2)
    const pieces = [...latin]
    for (const run of han) {
      if (run.length >= 2) pieces.push(run)
      if (run.length > 2) for (let i = 0; i + 2 <= run.length; i += 1) {
        const piece = run.slice(i, i + 2)
        if (![...piece].some(char => SEAM_CHARS.has(char))) pieces.push(piece)
      }
    }
    for (const piece of pieces) if (!seen.has(piece)) { seen.add(piece); terms.push(piece) }
  }
  return terms
}

/** Words that mean the same as `term` to a user (the same table the market search uses). */
function synonymsOf(term: string): string[] {
  const out = new Set<string>()
  for (const group of SEARCH_SYNONYM_GROUPS) {
    const terms = group.terms.map(value => value.toLowerCase())
    if (!terms.includes(term)) continue
    for (const value of [...terms, ...(group.broad ?? []).map(word => word.toLowerCase())]) if (value !== term) out.add(value)
  }
  return [...out]
}

const containsWord = (text: string, word: string): boolean => {
  if (/\p{Script=Han}/u.test(word)) return text.includes(word)
  return new RegExp(`(^|[^a-z0-9])${word.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}s?($|[^a-z0-9])`, 'u').test(text)
}

const WEIGHT = { name: 8, category: 4, description: 3, owner: 1 } as const

function describe(plugin: RegistryPlugin, preferZh: boolean): string {
  const description = plugin.description ?? {}
  const first = preferZh ? description.zh ?? description.en : description.en ?? description.zh
  return (first ?? Object.values(description)[0] ?? '').replace(/\s+/gu, ' ').trim()
}

/**
 * One entry's score for these terms: each term counts once, at its best field,
 * scaled by how rare the term is (a word on every third plugin, like "ai",
 * says little; "记住" says a lot); synonyms count for half.
 */
function scoreFor(plugin: RegistryPlugin, terms: string[], categories: Registry['categories'], rarity: Map<string, number>): number {
  const name = `${plugin.name} ${plugin.npm ?? ''}`.toLowerCase()
  const owner = plugin.owner.toLowerCase()
  const texts = Object.values(plugin.description ?? {}).filter((value): value is string => typeof value === 'string').map(value => value.toLowerCase())
  const cats = pluginCategories(plugin).flatMap(id => [id, ...Object.values(categories[id] ?? {})]).map(value => value.toLowerCase())
  const best = (word: string): number => {
    if (containsWord(name, word)) return WEIGHT.name
    if (cats.some(value => containsWord(value, word))) return WEIGHT.category
    if (texts.some(value => containsWord(value, word))) return WEIGHT.description
    if (containsWord(owner, word)) return WEIGHT.owner
    return 0
  }
  let total = 0
  for (const term of terms) {
    const literal = best(term)
    const weight = rarity.get(term) ?? 1
    if (literal > 0) { total += literal * weight; continue }
    // Only through a synonym: worth half, so a plugin that says what the user
    // said still outranks one that says it another way.
    const viaSynonym = Math.max(0, ...synonymsOf(term).map(best))
    total += (viaSynonym / 2) * weight
  }
  return total
}

const downloadsOf = (plugin: RegistryPlugin): number => typeof plugin.downloads === 'number' ? plugin.downloads : -1
const starsOf = (plugin: RegistryPlugin): number => typeof plugin.stars === 'number' ? plugin.stars : -1

/** Inverse document frequency per term over the whole catalog text (literal matches only). */
function termRarity(plugins: RegistryPlugin[], terms: string[]): Map<string, number> {
  const texts = plugins.map(plugin => `${plugin.name} ${plugin.npm ?? ''} ${Object.values(plugin.description ?? {}).join(' ')}`.toLowerCase())
  const total = texts.length
  return new Map(terms.map(term => {
    const df = texts.reduce((n, text) => n + (containsWord(text, term) ? 1 : 0), 0)
    return [term, Math.log(1 + total / (1 + df))]
  }))
}

export interface Candidate {
  plugin: RegistryPlugin
  score: number
}

/**
 * The entries worth showing the model. Every entry matching any term, best
 * first; when fewer than the limit match (a vague or unmatched request), the
 * most downloaded of the rest fill the list, because a model can still pick
 * something sensible from popular plugins, and an empty list helps no one.
 */
export function recall(registry: Registry, terms: string[], limit = CANDIDATE_LIMIT): { candidates: Candidate[]; matched: number } {
  const usable = registry.plugins.filter(plugin => plugin.deprecated !== true && plugin.npm !== 'dshmarket' && plugin.name !== 'dsh-market')
  const rarity = termRarity(usable, terms)
  const scored = usable
    .map(plugin => ({ plugin, score: terms.length === 0 ? 0 : scoreFor(plugin, terms, registry.categories, rarity) }))
  const byPopularity = (a: Candidate, b: Candidate): number =>
    downloadsOf(b.plugin) - downloadsOf(a.plugin) || starsOf(b.plugin) - starsOf(a.plugin) || a.plugin.name.localeCompare(b.plugin.name)
  const hits = scored.filter(item => item.score > 0).sort((a, b) => b.score - a.score || byPopularity(a, b))
  const candidates = hits.slice(0, limit)
  if (candidates.length < limit) {
    const taken = new Set(candidates.map(item => item.plugin.name))
    const rest = scored.filter(item => !taken.has(item.plugin.name)).sort(byPopularity)
    candidates.push(...rest.slice(0, limit - candidates.length))
  }
  return { candidates, matched: hits.length }
}

/** One recommended plugin, with everything a card needs to draw it. */
export interface FindPick {
  name: string
  owner: string
  url: string
  npm: string | null
  install: string
  categories: string[]
  description: string
  downloads: number | null
  stars: number | null
  /** The model's one-sentence reason this fits the request. */
  why: string
}

export interface FindResult {
  request: string
  /** One short sentence from the model framing the picks (may be empty). */
  intro: string
  picks: FindPick[]
  /** Which model answered, for the card's footnote. */
  model: string
  at: string
}

export type FindErrorCode = 'empty' | 'catalog' | 'no-model' | 'model-failed'

export class FindPluginError extends Error {
  constructor(readonly code: FindErrorCode, message: string) {
    super(message)
    this.name = 'FindPluginError'
  }
}

/** The slice of the host's `llm` service this uses. */
export interface LlmLike {
  stream(options: {
    provider: string
    model: string
    reasoningEffort?: string
    messages: unknown[]
    system?: string
    maxTokens?: number
    temperature?: number
    signal?: AbortSignal
  }): AsyncIterable<{ type: string; text?: string }>
}

export interface ModelSelectionLike { provider: string; model: string; reasoningEffort?: string }

function catalogLine(plugin: RegistryPlugin, index: number, registry: Registry, preferZh: boolean): string {
  const cats = pluginCategories(plugin).map(id => registry.categories[id]?.[preferZh ? 'zh' : 'en'] ?? registry.categories[id]?.en ?? id).join('/')
  const stats = [typeof plugin.downloads === 'number' ? `downloads ${plugin.downloads}` : '', typeof plugin.stars === 'number' ? `stars ${plugin.stars}` : ''].filter(Boolean).join(', ')
  return `${index + 1}. ${plugin.name} [${cats}] ${stats}\n   ${describe(plugin, preferZh).slice(0, 400)}`
}

/** The instruction and the candidates, as the one message the model reads. */
export function buildPickPrompt(request: string, registry: Registry, found: { candidates: Candidate[]; matched: number }): { system: string; user: string } {
  const preferZh = /\p{Script=Han}/u.test(request)
  const weak = found.matched === 0
    ? 'None of the candidates matched the request\'s words; they are only the most-downloaded plugins. Return an empty list unless one genuinely fits.'
    : found.matched < found.candidates.length
      ? `Only the first ${found.matched} candidates matched the request\'s words; the rest are popular fillers.`
      : ''
  const system = [
    'You help a user pick plugins from the DSH plugin market. Answer ONLY with one JSON object, no prose around it:',
    '{"intro": string, "picks": [{"name": string, "why": string}]}',
    '- picks: the 1 to 5 candidates that best fit what the user actually wants, best first. Use names exactly as listed. Never include a name that is not in the list. Return [] if none fit.',
    '- why: one short sentence on why it fits THIS request (not a copy of its description).',
    '- intro: one short sentence framing the result, e.g. what you understood they want, or that nothing fits.',
    `- Write intro and why in ${preferZh ? 'Simplified Chinese' : 'the language of the request'}.`,
    weak,
  ].filter(Boolean).join('\n')
  const user = [`Request: ${request}`, '', 'Candidates:', ...found.candidates.map(({ plugin }, i) => catalogLine(plugin, i, registry, preferZh))].join('\n')
  return { system, user }
}

/** Pull the JSON object out of a model reply (it may wrap it in a code fence). */
export function parsePickReply(text: string, allowed: Set<string>): { intro: string; picks: Array<{ name: string; why: string }> } {
  const start = text.indexOf('{'), end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('the model did not return JSON')
  const value = JSON.parse(text.slice(start, end + 1)) as { intro?: unknown; picks?: unknown }
  const picks: Array<{ name: string; why: string }> = []
  const seen = new Set<string>()
  if (Array.isArray(value.picks)) {
    for (const item of value.picks) {
      const name = typeof item?.name === 'string' ? item.name.trim() : ''
      if (!allowed.has(name) || seen.has(name)) continue
      seen.add(name)
      picks.push({ name, why: typeof item?.why === 'string' ? item.why.trim().slice(0, 300) : '' })
      if (picks.length === 5) break
    }
  }
  return { intro: typeof value.intro === 'string' ? value.intro.trim().slice(0, 300) : '', picks }
}

const errorCode = (error: unknown): string => {
  for (let current: unknown = error, depth = 0; current !== undefined && current !== null && depth < 5; depth += 1) {
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string') return code
    current = (current as { cause?: unknown }).cause
  }
  return ''
}

const NO_MODEL = '还没有可用的模型：AI 找插件用的是你在 DSH 里配置的模型和 API Key，请先在「设置 → 模型」里配置一个。 / No model is set up yet: AI plugin search uses the model and API key you configured in DSH. Set one up under Settings → Models first.'

/** Recall, then let the model pick. Throws FindPluginError with a user-facing message. */
export async function findPlugins(options: {
  request: string
  registry: Registry
  llm: LlmLike | undefined
  selection: ModelSelectionLike | undefined
  signal?: AbortSignal
}): Promise<FindResult> {
  const request = options.request.trim()
  if (request === '') throw new FindPluginError('empty', USAGE)
  if (options.llm === undefined || options.selection === undefined || !options.selection.provider || !options.selection.model) {
    throw new FindPluginError('no-model', NO_MODEL)
  }
  const { registry, selection } = options
  const found = recall(registry, extractTerms(request))
  const prompt = buildPickPrompt(request, registry, found)
  let text = ''
  try {
    const stream = options.llm.stream({
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
      system: prompt.system,
      messages: [Object.freeze({
        id: randomUUID(), role: 'user',
        content: [{ type: 'text', text: prompt.user }],
        source: { kind: 'plugin:dshmarket' },
      })],
      maxTokens: 1200,
      temperature: 0.2,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    for await (const chunk of stream) if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
  } catch (error) {
    const code = errorCode(error)
    if (code === 'MISSING_CREDENTIAL' || code === 'INVALID_CREDENTIAL') throw new FindPluginError('no-model', NO_MODEL)
    const reason = error instanceof Error ? error.message : String(error)
    throw new FindPluginError('model-failed', `模型这次没有回答（${reason}）。请稍后重试，或换一个模型。 / The model did not answer (${reason}). Try again, or switch models.`)
  }
  let parsed: ReturnType<typeof parsePickReply>
  try {
    parsed = parsePickReply(text, new Set(found.candidates.map(item => item.plugin.name)))
  } catch {
    throw new FindPluginError('model-failed', '模型的回答格式不对，没法整理成结果。请重试一次。 / The model\'s answer was not in the expected shape. Try again.')
  }
  const byName = new Map(found.candidates.map(item => [item.plugin.name, item.plugin]))
  const preferZh = /\p{Script=Han}/u.test(request)
  const picks = parsed.picks.map(({ name, why }): FindPick => {
    const plugin = byName.get(name)!
    return {
      name: plugin.name, owner: plugin.owner, url: plugin.url, npm: plugin.npm ?? null, install: plugin.install,
      categories: pluginCategories(plugin).map(id => registry.categories[id]?.[preferZh ? 'zh' : 'en'] ?? registry.categories[id]?.en ?? id),
      description: describe(plugin, preferZh),
      downloads: typeof plugin.downloads === 'number' ? plugin.downloads : null,
      stars: typeof plugin.stars === 'number' ? plugin.stars : null,
      why,
    }
  })
  return { request, intro: parsed.intro, picks, model: selection.model, at: new Date().toISOString() }
}

/** Plain text of a result, for hosts that draw the command row as text. */
export function resultText(result: FindResult): string {
  if (result.picks.length === 0) return result.intro || '没有找到合适的插件。 / No plugin fits this request.'
  const lines = result.picks.map((pick, i) => `${i + 1}. ${pick.name} — ${pick.why}\n   ${pick.install}`)
  return [result.intro, ...lines].filter(Boolean).join('\n')
}

// ---------- results, kept so a card can be drawn again after a reload ----------

const RESULT_LIMIT = 200
let results: Map<string, FindResult> | null = null
export function resultsFile(home: string = resolveDshHome()): string {
  return join(home, 'dsh-market', 'find-plugin-results.json')
}
function loadResults(file: string): Map<string, FindResult> {
  if (results !== null) return results
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, FindResult>
    results = new Map(Object.entries(raw))
  } catch {
    results = new Map()
  }
  return results
}
export function rememberResult(id: string, result: FindResult, file: string = resultsFile()): void {
  const map = loadResults(file)
  map.delete(id)
  map.set(id, result)
  while (map.size > RESULT_LIMIT) map.delete(map.keys().next().value as string)
  try {
    mkdirSync(dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(Object.fromEntries(map)))
    renameSync(temp, file)
  } catch (error) {
    logEvent('warn', 'find-plugin', `result not saved: ${error instanceof Error ? error.message : String(error)}`)
  }
}
export function resultFor(id: string, file: string = resultsFile()): FindResult | undefined {
  return loadResults(file).get(id)
}
/** Tests only. */
export function forgetResults(): void { results = null }

// ---------- the command ----------

/** What the command handler needs from the host, structurally: no host package is imported. */
export interface FindPluginInvocation {
  commandId: string
  agent: { id?: string; options?: { provider?: string; model?: string } }
  rawInput: string
  signal: AbortSignal
}

export type FindPluginResult = { kind: 'success'; text?: string } | { kind: 'error'; text: string }

const USAGE = '用法：/find-plugin 你想要什么样的插件，例如「通知类型的插件」「找找 seo 优化写作的插件」 / Usage: /find-plugin what you are looking for, e.g. "plugins that send notifications"'

export interface ModelAccess {
  llm(): LlmLike | undefined
  defaultSelection(): ModelSelectionLike | undefined
}

const NO_ACCESS: ModelAccess = { llm: () => undefined, defaultSelection: () => undefined }
let access: ModelAccess = NO_ACCESS
/** Set once by the plugin entry; routes read it at request time. */
export function setModelAccess(next: ModelAccess): void { access = next }
export function modelAccess(): ModelAccess { return access }

/** The market page's AI search: the same recall and pick, with the default model. */
export async function aiSearch(request: string, loadRegistry: () => Promise<Registry>, signal?: AbortSignal): Promise<FindResult> {
  let registry: Registry
  try {
    registry = await loadRegistry()
  } catch (error) {
    throw new FindPluginError('catalog', `暂时拿不到插件目录（${error instanceof Error ? error.message : String(error)}）。 / Could not reach the plugin catalog.`)
  }
  return findPlugins({ request, registry, llm: access.llm(), selection: access.defaultSelection(), ...(signal === undefined ? {} : { signal }) })
}

/** Run one `/find-plugin`. The structured result is kept under the command id for the card renderer. */
export async function runFindPlugin(
  invocation: FindPluginInvocation,
  loadRegistry: () => Promise<Registry>,
  models: ModelAccess,
): Promise<FindPluginResult> {
  if (invocation.rawInput.trim() === '') return { kind: 'error', text: USAGE }
  let registry: Registry
  try {
    registry = await loadRegistry()
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { kind: 'error', text: `暂时拿不到插件目录（${reason}），所以没法搜索。请稍后再试，或直接打开「插件」页的「插件市场」。 / Could not reach the plugin catalog (${reason}), so there is nothing to search. Try again in a moment, or open Plugins → Plugin Market.` }
  }
  // The model this chat is using, so the answer costs what the user expects;
  // the default model when the agent does not say.
  const own = invocation.agent.options
  const selection = own?.provider && own?.model ? { provider: own.provider, model: own.model } : models.defaultSelection()
  try {
    const result = await findPlugins({ request: invocation.rawInput, registry, llm: models.llm(), selection, signal: invocation.signal })
    rememberResult(invocation.commandId, result)
    // Also as this session's latest: on a blank session the chat draws no
    // command row, and the client shows the result from here instead.
    if (typeof invocation.agent.id === 'string') rememberResult(`session:${invocation.agent.id}`, result)
    return { kind: 'success', text: resultText(result) }
  } catch (error) {
    return { kind: 'error', text: error instanceof FindPluginError ? error.message : String(error) }
  }
}

/** The slice of the host's `commands` service this uses. */
export interface CommandsServiceLike {
  register(definition: {
    name: string
    description: string
    input?: { hint: string }
    handler(invocation: FindPluginInvocation): FindPluginResult | Promise<FindPluginResult>
  }): () => void
}

/** Register `/find-plugin` on a host that has the command registry. */
export function registerFindPlugin(commands: CommandsServiceLike, loadRegistry: () => Promise<Registry>, models: ModelAccess): () => void {
  return commands.register({
    name: 'find-plugin',
    description: '用一句话在插件市场里找插件（用你的模型挑选） / Describe what you want; your model picks plugins from the market',
    input: { hint: '例如：通知类型的插件 · e.g. SEO writing' },
    handler: invocation => runFindPlugin(invocation, loadRegistry, models),
  })
}
