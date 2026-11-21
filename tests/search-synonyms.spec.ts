import { describe, expect, it } from 'vitest'
import { visiblePlugins } from '../src/client/market-data.ts'
import type { RegistryPlugin } from '../src/client/market-data.ts'
import { SEARCH_SYNONYM_GROUPS } from '../src/search-synonyms.ts'

function plugin(partial: Partial<RegistryPlugin>): RegistryPlugin {
  return { name: 'x', owner: 'o', url: 'https://github.com/o/x', category: 'tool', ...partial }
}

const search = (rows: RegistryPlugin[], query: string, sort = 'downloads-desc', lang = 'zh') =>
  visiblePlugins(rows, { category: 'all', query, lang, sort }).map(p => p.name)

describe('search synonyms (#611)', () => {
  const rows = [
    plugin({ name: 'push-only', downloads: 9_000, description: { zh: '任务完成后提醒我' } }),
    plugin({ name: 'notice-literal', downloads: 10, description: { zh: '任务完成后发送通知' } }),
    plugin({ name: 'english-only', downloads: 5_000, description: { en: 'Desktop notification when a task ends' } }),
    plugin({ name: 'unrelated', downloads: 99_999, description: { zh: '主题皮肤' } }),
  ]

  it('finds plugins that only use another word for the same intent', () => {
    expect(search(rows, '通知')).toEqual(['notice-literal', 'push-only', 'english-only'])
    // 提醒 is a one-way neighbour: 通知 finds it, but it does not expand back.
    expect(search(rows, '提醒')).toEqual(['push-only'])
    // 推送 also means git push, so it is not part of the group.
    expect(search([plugin({ name: 'g', description: { zh: '推送到仓库' } })], '通知')).toEqual([])
    expect(search(rows, 'notification')).toEqual(expect.arrayContaining(['notice-literal', 'push-only', 'english-only']))
  })

  it('ranks literal matches above synonym-only matches, whatever the downloads', () => {
    const order = search(rows, '通知', 'downloads-desc')
    expect(order[0]).toBe('notice-literal')
    // Between synonym-only hits the selected sort still decides.
    expect(order.slice(1)).toEqual(['push-only', 'english-only'])
  })

  it('ranks a synonym found in the name above one found in a description', () => {
    const list = [
      plugin({ name: 'plain', downloads: 1_000, description: { en: 'Sends a notification' } }),
      plugin({ name: 'dsh-notify', downloads: 1, description: { en: 'Small helper' } }),
    ]
    expect(search(list, '通知')).toEqual(['dsh-notify', 'plain'])
  })

  it('matches Latin synonyms as whole words only', () => {
    const list = [
      plugin({ name: 'digital-art', description: { en: 'Digital painting' } }),
      plugin({ name: 'version-control-ui', description: { en: 'A version control panel' } }),
      plugin({ name: 'qq-ish', description: { en: 'Not a chat bot, just a quick queue' } }),
    ]
    // "版本控制" expands to git; "digital" contains "git" but is not the word.
    expect(search(list, '版本控制')).toEqual(['version-control-ui'])
    // Typing "git" itself keeps its literal substring behaviour, and the
    // whole-word hit still ranks first.
    expect(search([list[0]!, plugin({ name: 'git-panel' })], 'git')).toEqual(['git-panel', 'digital-art'])
    // "qq" expands to onebot; a name merely containing "qq" is not touched.
    expect(search([plugin({ name: 'dsh-onebot' }), plugin({ name: 'dsh-qqz' })], 'qq')).toEqual(['dsh-qqz', 'dsh-onebot'])
    expect(search([plugin({ name: 'xonebotx' })], 'qq')).toEqual([])
  })

  it('does not expand one-character or unlisted tokens', () => {
    const list = [
      plugin({ name: 'a-tool', description: { zh: '提醒' } }),
      plugin({ name: 'other', description: { en: 'notify' } }),
    ]
    expect(search(list, 'a')).toEqual(['a-tool'])
    expect(search(list, '通')).toEqual([])
    // A broad neighbour does not expand back: tts finds 朗读, 语音 finds tts, tts does not find stt.
    const voice = [plugin({ name: 'reader', description: { zh: '朗读' } }), plugin({ name: 'dictate', description: { en: 'stt engine' } })]
    expect(search(voice, 'tts')).toEqual(['reader'])
    expect(search(voice, '语音').sort()).toEqual(['dictate', 'reader'])
    expect(search(voice, '桌面通知')).toEqual([])
  })

  it('expands a multi-word phrase as one unit and each word of a mixed query', () => {
    const list = [
      plugin({ name: 'gen-a', description: { en: 'Image gen tool' } }),
      plugin({ name: 'gen-b', description: { zh: '文生图工具' } }),
    ]
    expect(search(list, 'image gen').sort()).toEqual(['gen-a', 'gen-b'])
    // Every typed word must be satisfied in the same field.
    const mixed = [plugin({ name: 'm', description: { zh: '飞书提醒' } }), plugin({ name: 'n', description: { zh: '飞书' } })]
    expect(search(mixed, 'lark 通知')).toEqual(['m'])
  })

  it('keeps the table well-formed', () => {
    for (const group of SEARCH_SYNONYM_GROUPS) {
      expect(group.terms.length).toBeGreaterThanOrEqual(2)
      for (const term of [...group.terms, ...(group.broad ?? [])]) expect(term.trim()).toBe(term)
    }
  })
})

describe('relevance tie-breaks (#611)', () => {
  it('ranks a whole-word hit above the word buried in a longer one', () => {
    const list = [
      plugin({ name: 'buried', downloads: 100_000, description: { en: 'Handles digital assets' } }),
      plugin({ name: 'whole', downloads: 10, description: { en: 'Uses git hooks' } }),
    ]
    expect(search(list, 'git')).toEqual(['whole', 'buried'])
  })

  it('lets the selected sort decide between equal tiers; repeating the word does not help', () => {
    const list = [
      plugin({ name: 'popular', downloads: 100_000, description: { en: 'Has a timer somewhere' } }),
      plugin({ name: 'stuffed', downloads: 10, description: { en: 'Timer for timer timer fans' } }),
    ]
    expect(search(list, 'timer')).toEqual(['popular', 'stuffed'])
  })

  it('never lets a tie-break lift a hit into a higher tier', () => {
    const list = [
      // Phrase hit with every bonus vs a plain exact-field hit.
      plugin({ name: 'phrase', description: { en: 'a git hook' }, owner: 'git' }),
      plugin({ name: 'exact', description: { en: 'git' } }),
    ]
    expect(search(list, 'git', 'x', 'en')[0]).toBe('phrase')
    expect(search([list[0]!, plugin({ name: 'dsh-other', description: { en: 'git' } })], 'git', 'x', 'en')[0]).toBe('phrase')
  })
})
