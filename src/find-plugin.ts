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
export function recall(registry: Registry, terms: string[], limit = CANDIDATE_LIMIT, exclude: ReadonlySet<string> = new Set()): { candidates: Candidate[]; matched: number } {
  const usable = registry.plugins.filter(plugin => plugin.deprecated !== true && plugin.npm !== 'dshmarket' && plugin.name !== 'dsh-market' && !exclude.has(plugin.name))
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
  /** Older saved results lack an exact candidate selection. */
  selectionVersion?: 2
  /** Whether the user's installed and favorited plugins informed the picks (they allowed it). */
  personalized?: boolean
}

export type FindErrorCode = 'empty' | 'catalog' | 'no-model' | 'no-seeds' | 'model-failed'

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
    messages: unknown[]
    system?: string
    maxTokens?: number
    signal?: AbortSignal
  }): AsyncIterable<{ type: string; text?: string; error?: unknown; reason?: unknown }>
}

export interface ModelSelectionLike { provider: string; model: string; reasoningEffort?: string }

function catalogLine(plugin: RegistryPlugin, registry: Registry, preferZh: boolean): string {
  const cats = pluginCategories(plugin).map(id => registry.categories[id]?.[preferZh ? 'zh' : 'en'] ?? registry.categories[id]?.en ?? id).join('/')
  const stats = [typeof plugin.downloads === 'number' ? `downloads ${plugin.downloads}` : '', typeof plugin.stars === 'number' ? `stars ${plugin.stars}` : ''].filter(Boolean).join(', ')
  return `${plugin.name} [${cats}] ${stats}\n   ${describe(plugin, preferZh).slice(0, 400)}`
}

const candidateId = (index: number): string => `p${index + 1}`

function candidateLines(candidates: Candidate[], registry: Registry, preferZh: boolean): string[] {
  return candidates.map(({ plugin }, index) => {
    const source = [plugin.owner, plugin.npm].filter(Boolean).join(' / ')
    const label = source === '' ? '' : ` (${source})`
    return `[${candidateId(index)}]${label} ${catalogLine(plugin, registry, preferZh)}`
  })
}

/** The instruction and the candidates, as the one message the model reads. */
export function buildPickPrompt(request: string, registry: Registry, found: { candidates: Candidate[]; matched: number }, have?: UserSeeds): { system: string; user: string } {
  const preferZh = /\p{Script=Han}/u.test(request)
  const weak = found.matched === 0
    ? 'None of the candidates matched the request\'s words; they are only the most-downloaded plugins. Return an empty list unless one genuinely fits.'
    : found.matched < found.candidates.length
      ? `Only the first ${found.matched} candidates matched the request\'s words; the rest are popular fillers.`
      : ''
  const system = [
    'You help a user pick plugins from the DSH plugin market. Answer ONLY with one JSON object, no prose around it:',
    '{"intro": string, "picks": [{"id": string, "why": string}]}',
    '- picks: the 1 to 5 candidates that best fit what the user actually wants, best first. Use the candidate IDs (e.g. "p1") exactly as listed. Different entries may share a name. Return [] if none fit.',
    '- why: one short sentence on why it fits THIS request (not a copy of its description).',
    '- intro: one short sentence framing the result, e.g. what you understood they want, or that nothing fits.',
    `- Write intro and why in ${preferZh ? 'Simplified Chinese' : 'the language of the request'}.`,
    weak,
    have === undefined ? '' : '- The user\'s installed and favorited plugins are listed too (installed ones are already left out of the candidates). Use them to judge what suits this user; skip near-duplicates of what they have.',
  ].filter(Boolean).join('\n')
  const mine = have === undefined ? [] : [
    '', 'Already installed:', ...(have.installed.length === 0 ? ['(none)'] : have.installed.map(plugin => `- ${plugin.name}: ${describe(plugin, preferZh).slice(0, 160)}`)),
    'Favorited:', ...(have.favorited.length === 0 ? ['(none)'] : have.favorited.map(plugin => `- ${plugin.name}: ${describe(plugin, preferZh).slice(0, 160)}`)),
  ]
  const user = [`Request: ${request}`, ...mine, '', 'Candidates:', ...candidateLines(found.candidates, registry, preferZh)].join('\n')
  return { system, user }
}

/** Pull the JSON object out of a model reply (it may wrap it in a code fence). */
export function parsePickReply(text: string, allowed: ReadonlySet<string>, max = 5): { intro: string; picks: Array<{ id: string; why: string }> } {
  const start = text.indexOf('{'), end = text.lastIndexOf('}')
  let value: { intro?: unknown; picks?: unknown } | null = null
  if (start >= 0 && end > start) {
    try { value = JSON.parse(text.slice(start, end + 1)) as { intro?: unknown; picks?: unknown } } catch { value = null }
  }
  if (value === null) {
    // A reply cut off at the token limit (or with a stray character) still
    // identifies its picks: keep every complete candidate ID in order.
    const found = [...text.matchAll(/"id"\s*:\s*"(p\d+)"(?:\s*,\s*"why"\s*:\s*"((?:[^"\\]|\\.)*)")?/gu)]
    if (found.length === 0) throw new Error('the model did not return JSON')
    const intro = /"intro"\s*:\s*"((?:[^"\\]|\\.)*)"/u.exec(text)?.[1] ?? ''
    value = { intro, picks: found.map(match => ({ id: match[1], why: match[2] ?? '' })) }
  }
  const picks: Array<{ id: string; why: string }> = []
  const seen = new Set<string>()
  if (Array.isArray(value.picks)) {
    for (const item of value.picks) {
      const id = typeof item?.id === 'string' ? item.id.trim() : ''
      if (!allowed.has(id) || seen.has(id)) continue
      seen.add(id)
      picks.push({ id, why: typeof item?.why === 'string' ? item.why.trim().slice(0, 300) : '' })
      if (picks.length === max) break
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

/** A catalog entry as a card-ready pick. */
function toPick(plugin: RegistryPlugin, registry: Registry, preferZh: boolean, why: string): FindPick {
  return {
    name: plugin.name, owner: plugin.owner, url: plugin.url, npm: plugin.npm ?? null, install: plugin.install,
    categories: pluginCategories(plugin).map(id => registry.categories[id]?.[preferZh ? 'zh' : 'en'] ?? registry.categories[id]?.en ?? id),
    description: describe(plugin, preferZh),
    downloads: typeof plugin.downloads === 'number' ? plugin.downloads : null,
    stars: typeof plugin.stars === 'number' ? plugin.stars : null,
    why,
  }
}

const hasModel = (llm: LlmLike | undefined, selection: ModelSelectionLike | undefined): selection is ModelSelectionLike =>
  llm !== undefined && selection !== undefined && Boolean(selection.provider) && Boolean(selection.model)

const JSON_ONLY_REMINDER = 'Reply with ONLY the JSON object described in the instructions: no prose, no markdown, no questions back.'

/** One model call over the candidates; resolve picks only to the entries offered. */
async function askForPicks(options: {
  llm: LlmLike
  selection: ModelSelectionLike
  prompt: { system: string; user: string }
  candidates: Candidate[]
  max: number
  maxTokens: number
  signal?: AbortSignal
}): Promise<{ intro: string; picks: Array<{ plugin: RegistryPlugin; why: string }> }> {
  const { selection, prompt } = options
  let text = ''
  let reasoning = ''
  const seen: string[] = []
  // One call to the model. `userText` is what it reads as the user's message.
  const callModel = async (userText: string): Promise<void> => {
    text = ''
    reasoning = ''
    seen.length = 0
    const stream = options.llm.stream({
      provider: selection.provider,
      model: selection.model,
      // Leave sampling and reasoning at the selected model's DSH defaults.
      system: prompt.system,
      messages: [Object.freeze({
        id: randomUUID(), role: 'user',
        content: [{ type: 'text', text: userText }],
        source: { kind: 'plugin:dshmarket' },
      })],
      maxTokens: options.maxTokens,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    for await (const chunk of stream) {
      if (seen.length < 12) seen.push(JSON.stringify(chunk).slice(0, 300))
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') reasoning += chunk.text
      else if (chunk.type === 'finish') {
        // The host ends a failed call (no key, bad key, provider down) with a
        // finish whose reason is an error, rather than throwing.
        const reason = (chunk as { reason?: { kind?: unknown; failure?: { message?: unknown; code?: unknown } } }).reason
        if (reason?.kind === 'error') {
          const failure = reason.failure ?? {}
          throw Object.assign(new Error(typeof failure.message === 'string' ? failure.message : 'the model call failed'), typeof failure.code === 'string' ? { code: failure.code } : {})
        }
      } else if (chunk.type === 'error') {
        const failure = (chunk as { error?: unknown; message?: unknown }).error ?? (chunk as { message?: unknown }).message
        throw failure instanceof Error ? failure : Object.assign(new Error(typeof failure === 'string' ? failure : JSON.stringify(failure)), typeof failure === 'object' && failure !== null ? { cause: failure } : {})
      }
    }
  }
  const attempt = async (userText: string): Promise<void> => {
    try {
      await callModel(userText)
    } catch (error) {
      const code = errorCode(error)
      if (code === 'MISSING_CREDENTIAL' || code === 'INVALID_CREDENTIAL') throw new FindPluginError('no-model', NO_MODEL)
      const reason = error instanceof Error ? error.message : String(error)
      throw new FindPluginError('model-failed', `模型这次没有回答（${reason}）。请稍后重试，或换一个模型。 / The model did not answer (${reason}). Try again, or switch models.`)
    }
  }
  const byId = new Map(options.candidates.map(({ plugin }, index) => [candidateId(index), plugin]))
  const allowed = new Set(byId.keys())
  const read = (): ReturnType<typeof parsePickReply> =>
    // Out of budget before the answer: the thinking often already holds it.
    text.trim() === '' && reasoning !== '' ? parsePickReply(reasoning, allowed, options.max) : parsePickReply(text, allowed, options.max)
  // The instruction rides in the user's message too: a model that reasons
  // before it answers can take the lists for a chat and reply in prose, which
  // is how "AI picks for you" kept failing on thinking models (#1331).
  await attempt(`${prompt.user}\n\n${JSON_ONLY_REMINDER}`)
  let parsed: ReturnType<typeof parsePickReply>
  try {
    parsed = read()
  } catch {
    logEvent('warn', 'find-plugin', `unreadable model reply, asking once more with the full instruction (${String(text.length)} chars, ${String(reasoning.length)} thinking): ${text.slice(0, 300)} … ${text.slice(-200)} | chunks: ${seen.join(' ')}`)
    await attempt(`${prompt.system}\n\n---\n\n${prompt.user}\n\n${JSON_ONLY_REMINDER}`)
    try {
      parsed = read()
    } catch {
      logEvent('warn', 'find-plugin', `unreadable model reply (${String(text.length)} chars, ${String(reasoning.length)} thinking): ${text.slice(0, 300)} … ${text.slice(-200)} | chunks: ${seen.join(' ')}`)
      throw new FindPluginError('model-failed', text.trim() === ''
        ? '模型没有给出回答（可能把输出额度都用在了思考上）。请重试一次，或在 DSH 里换一个模型。 / The model gave no answer (it may have spent its whole output budget thinking). Try again, or switch to another model in DSH.'
        : '模型回答了，但没有按要求的格式，没法整理成结果。请重试一次，或在 DSH 里换一个模型。 / The model replied, but not in the format asked for, so it could not be turned into results. Try again, or switch to another model in DSH.')
    }
  }
  return { intro: parsed.intro, picks: parsed.picks.map(({ id, why }) => ({ plugin: byId.get(id)!, why })) }
}

/** Recall, then let the model pick. Throws FindPluginError with a user-facing message. */
export async function findPlugins(options: {
  request: string
  registry: Registry
  llm: LlmLike | undefined
  selection: ModelSelectionLike | undefined
  /** The user's own plugins, only when they allowed reading them. */
  have?: UserSeeds
  signal?: AbortSignal
}): Promise<FindResult> {
  const request = options.request.trim()
  if (request === '') throw new FindPluginError('empty', USAGE)
  const { llm, registry, selection } = options
  if (!hasModel(llm, selection)) throw new FindPluginError('no-model', NO_MODEL)
  const { have } = options
  const found = recall(registry, extractTerms(request), CANDIDATE_LIMIT, new Set((have?.installed ?? []).map(plugin => plugin.name)))
  const answer = await askForPicks({
    llm: llm!, selection, prompt: buildPickPrompt(request, registry, found, have), candidates: found.candidates,
    max: 5, maxTokens: 6000, ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  const preferZh = /\p{Script=Han}/u.test(request)
  const picks = answer.picks.map(({ plugin, why }) => toPick(plugin, registry, preferZh, why))
  return { request, intro: answer.intro, picks, model: selection.model, at: new Date().toISOString(), selectionVersion: 2, personalized: have !== undefined }
}

// ---------- recommendations from what the user already has ----------

/** How many candidates a recommendation offers the model. */
export const RECOMMEND_CANDIDATES = 40
/** How many plugins a recommendation shows. */
export const RECOMMEND_MAX = 10

const isMarket = (plugin: RegistryPlugin): boolean => plugin.npm === 'dshmarket' || plugin.name === 'dsh-market'

/**
 * The catalog entries the user already has: installed (by package name) or
 * favorited (by repository URL, as favorites are stored).
 */
export interface UserSeeds { installed: RegistryPlugin[]; favorited: RegistryPlugin[] }

export function userSeeds(registry: Registry, have: { installed: string[]; favorites: string[] }): UserSeeds {
  const names = new Set(have.installed.map(name => name.toLowerCase()))
  const urls = new Set(have.favorites.map(url => url.toLowerCase().replace(/\.git$|\/+$/u, '')))
  const installed: RegistryPlugin[] = []
  const favorited: RegistryPlugin[] = []
  for (const plugin of registry.plugins) {
    if (isMarket(plugin)) continue
    if ((plugin.npm !== undefined && plugin.npm !== null && names.has(plugin.npm.toLowerCase())) || names.has(plugin.name.toLowerCase())) installed.push(plugin)
    else if (urls.has(plugin.url.toLowerCase().replace(/\.git$|\/+$/u, ''))) favorited.push(plugin)
  }
  return { installed, favorited }
}

/**
 * What to offer the model: entries that share categories and words with what
 * the user has (their taste), plus some popular ones from categories they have
 * not touched (so a recommendation can open a new need, not only repeat one).
 * Never what they already have, what was shown last time, or a deprecated one.
 */
export function recommendCandidates(registry: Registry, seeds: RegistryPlugin[], exclude: string[] = [], limit = RECOMMEND_CANDIDATES): Candidate[] {
  const skip = new Set([...seeds.map(plugin => plugin.name), ...exclude])
  const usable = registry.plugins.filter(plugin => plugin.deprecated !== true && !isMarket(plugin) && !skip.has(plugin.name))
  const catWeight = new Map<string, number>()
  for (const plugin of seeds) for (const id of pluginCategories(plugin)) catWeight.set(id, (catWeight.get(id) ?? 0) + 1)
  const termCount = new Map<string, number>()
  for (const plugin of seeds) {
    for (const term of new Set(extractTerms(`${describe(plugin, true)} ${describe(plugin, false)}`))) termCount.set(term, (termCount.get(term) ?? 0) + 1)
  }
  const terms = [...termCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([term]) => term)
  const rarity = termRarity(usable, terms)
  const popularity = (plugin: RegistryPlugin): number => Math.log10(2 + Math.max(0, downloadsOf(plugin))) + Math.log10(2 + Math.max(0, starsOf(plugin)))
  const scored = usable.map(plugin => {
    const cats = pluginCategories(plugin).reduce((sum, id) => sum + (catWeight.get(id) ?? 0), 0)
    const words = terms.length === 0 ? 0 : scoreFor(plugin, terms, registry.categories, rarity)
    return { plugin, score: cats * 4 + words + popularity(plugin) }
  })
  const fresh = (candidate: Candidate): boolean => pluginCategories(candidate.plugin).every(id => !catWeight.has(id))
  const byScore = (a: Candidate, b: Candidate): number => b.score - a.score || a.plugin.name.localeCompare(b.plugin.name)
  const wider = Math.floor(limit / 4)
  const near = scored.filter(item => !fresh(item)).sort(byScore).slice(0, limit - wider)
  const far = scored.filter(fresh).sort((a, b) => popularity(b.plugin) - popularity(a.plugin) || byScore(a, b)).slice(0, limit - near.length)
  return [...near, ...far]
}

export function buildRecommendPrompt(registry: Registry, seeds: UserSeeds, candidates: Candidate[], preferZh: boolean): { system: string; user: string } {
  const system = [
    'You recommend plugins from the DSH plugin market to one user, based on the plugins they already installed and favorited. Answer ONLY with one JSON object, no prose around it:',
    '{"intro": string, "picks": [{"id": string, "why": string}]}',
    `- picks: ${String(RECOMMEND_MAX - 4)} to ${String(RECOMMEND_MAX)} candidates this user is most likely to want next, best first. Use the candidate IDs (e.g. "p1") exactly as listed. Different entries may share a name.`,
    '- Read what they have as a picture of how they use DSH. Prefer plugins that add something they do not have yet, or go well with what they have; skip near-duplicates of plugins they already have.',
    '- Spread the picks over different needs rather than many plugins for one need. A well-used, maintained plugin beats an obscure one when both fit.',
    '- why: one short sentence. intro: one short sentence on what you read from their plugins.',
    `- Write intro and why in ${preferZh ? 'Simplified Chinese' : 'English'}.`,
  ].join('\n')
  const list = (plugins: RegistryPlugin[]): string[] => plugins.length === 0 ? ['(none)'] : plugins.map((plugin, i) => `${i + 1}. ${catalogLine(plugin, registry, preferZh)}`)
  const user = [
    'Installed:', ...list(seeds.installed), '',
    'Favorited (not necessarily installed):', ...list(seeds.favorited), '',
    'Candidates:', ...candidateLines(candidates, registry, preferZh),
  ].join('\n')
  return { system, user }
}

const NO_SEEDS = '还没有装或收藏插件，AI 不知道你喜欢什么。先装或收藏几个插件再试试。 / Nothing installed or favorited yet, so there is nothing to go on. Install or favorite a few plugins first.'

/** Recommend plugins from what the user installed and favorited. Throws FindPluginError. */
export async function recommendPlugins(options: {
  registry: Registry
  installed: string[]
  favorites: string[]
  exclude?: string[]
  preferZh: boolean
  llm: LlmLike | undefined
  selection: ModelSelectionLike | undefined
  signal?: AbortSignal
}): Promise<FindResult> {
  const { llm, registry, selection, preferZh } = options
  const seeds = userSeeds(registry, options)
  if (seeds.installed.length + seeds.favorited.length === 0) throw new FindPluginError('no-seeds', NO_SEEDS)
  if (!hasModel(llm, selection)) throw new FindPluginError('no-model', NO_MODEL)
  let candidates = recommendCandidates(registry, [...seeds.installed, ...seeds.favorited], options.exclude ?? [])
  // "Show others" ran out of fresh entries: start over rather than show nothing.
  if (candidates.length < RECOMMEND_MAX && (options.exclude ?? []).length > 0) candidates = recommendCandidates(registry, [...seeds.installed, ...seeds.favorited])
  const answer = await askForPicks({
    llm: llm!, selection, prompt: buildRecommendPrompt(registry, seeds, candidates, preferZh), candidates,
    max: RECOMMEND_MAX, maxTokens: 8000, ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  const picks = answer.picks.map(({ plugin, why }) => toPick(plugin, registry, preferZh, why))
  return { request: '', intro: answer.intro, picks, model: selection.model, at: new Date().toISOString(), selectionVersion: 2 }
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

// ---------- "use my plugins": the user's say-so, and where the lists come from ----------

/**
 * Whether AI search and `/find-plugin` may read the user's installed and
 * favorited plugins. Off until the user allows it from a result; one switch
 * for the whole DSH home, kept beside the saved results.
 */
export function consentFile(home: string = resolveDshHome()): string {
  return join(home, 'dsh-market', 'ai-consent.json')
}

export function usesMyPlugins(file: string = consentFile()): boolean {
  try {
    return (JSON.parse(readFileSync(file, 'utf8')) as { useMyPlugins?: unknown }).useMyPlugins === true
  } catch {
    return false
  }
}

export function setUsesMyPlugins(on: boolean, file: string = consentFile()): void {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify({ useMyPlugins: on }))
  renameSync(temp, file)
}

export interface UserPluginLists { installed: string[]; favorites: string[] }
let readUserPlugins: () => UserPluginLists = () => ({ installed: [], favorites: [] })
/** Set by the routes, which know the active profile. */
export function setUserPluginsReader(next: () => UserPluginLists): void { readUserPlugins = next }

/** The user's own plugins for a search, or undefined when they have not allowed it. */
function allowedSeeds(registry: Registry): UserSeeds | undefined {
  if (!usesMyPlugins()) return undefined
  try {
    return userSeeds(registry, readUserPlugins())
  } catch (error) {
    logEvent('warn', 'find-plugin', `could not read the user's plugins: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

/** The market page's AI search: the same recall and pick, with the default model. */
export async function aiSearch(request: string, loadRegistry: () => Promise<Registry>, signal?: AbortSignal): Promise<FindResult> {
  let registry: Registry
  try {
    registry = await loadRegistry()
  } catch (error) {
    throw new FindPluginError('catalog', `暂时拿不到插件目录（${error instanceof Error ? error.message : String(error)}）。 / Could not reach the plugin catalog.`)
  }
  const have = allowedSeeds(registry)
  return findPlugins({ request, registry, llm: access.llm(), selection: access.defaultSelection(), ...(have === undefined ? {} : { have }), ...(signal === undefined ? {} : { signal }) })
}

/** The market page's "recommend for me": what the user has, judged by their default model. */
export async function aiRecommend(
  have: { installed: string[]; favorites: string[]; exclude?: string[]; preferZh: boolean },
  loadRegistry: () => Promise<Registry>,
  signal?: AbortSignal,
): Promise<FindResult> {
  let registry: Registry
  try {
    registry = await loadRegistry()
  } catch (error) {
    throw new FindPluginError('catalog', `暂时拿不到插件目录（${error instanceof Error ? error.message : String(error)}）。 / Could not reach the plugin catalog.`)
  }
  return recommendPlugins({ registry, ...have, llm: access.llm(), selection: access.defaultSelection(), ...(signal === undefined ? {} : { signal }) })
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
    const have = allowedSeeds(registry)
    const result = await findPlugins({ request: invocation.rawInput, registry, llm: models.llm(), selection, ...(have === undefined ? {} : { have }), signal: invocation.signal })
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
