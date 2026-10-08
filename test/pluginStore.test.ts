import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { catalog, type CatalogEntry } from '../skills/catalog.ts'
import { STORE_CALLBACK, categoriesView, confirmView, listView, pluginView } from '../telegram/storeUi.ts'

const data = (v: { keyboard: { inline_keyboard: { callback_data?: string }[][] } }) => v.keyboard.inline_keyboard.flat().map(b => b.callback_data!)

function claudeDir() {
  const dir = mkdtempSync(join(tmpdir(), 'catalog-'))
  const market = join(dir, 'markets', 'official')
  mkdirSync(join(market, '.claude-plugin'), { recursive: true })
  mkdirSync(join(dir, 'plugins'))
  writeFileSync(join(dir, 'plugins', 'known_marketplaces.json'), JSON.stringify({ official: { installLocation: market }, gone: { installLocation: join(dir, 'nope') } }))
  writeFileSync(join(market, '.claude-plugin', 'marketplace.json'), JSON.stringify({ plugins: [
    { name: 'code-review', description: 'Reviews diffs', category: 'development', author: { name: 'Anthropic' }, homepage: 'https://example.com' },
    { name: 'figma', description: 'Design files', category: 'design', author: 'Figma' },
    { name: 'misc' },
    { name: 'x'.repeat(60), category: 'development' },
  ] }))
  return dir
}

test('catalog reads every added marketplace; missing ones are skipped', () => {
  const c = catalog(claudeDir())
  expect(c.map(e => e.id)).toEqual(['code-review@official', 'figma@official', 'misc@official', `${'x'.repeat(60)}@official`])
  expect(c[0]).toEqual({ id: 'code-review@official', name: 'code-review', marketplace: 'official', description: 'Reviews diffs', category: 'development', author: 'Anthropic', homepage: 'https://example.com' })
  expect(c[1]!.author).toBe('Figma')
  expect(c[2]!.category).toBe('other')
  expect(catalog(mkdtempSync(join(tmpdir(), 'empty-'))) ).toEqual([])
})

test('categories, paged lists and plugin pages; callbacks round-trip', () => {
  const c = catalog(claudeDir())
  const cats = categoriesView(c)
  expect(cats.keyboard.inline_keyboard[0]!.map(b => b.text)).toEqual(['Design (1)', 'Development (1)'])
  expect(cats.keyboard.inline_keyboard[1]!.map(b => b.text)).toEqual(['Other (1)'])
  const many: CatalogEntry[] = Array.from({ length: 23 }, (_, i) => ({ id: `p${i}@m`, name: `p${i}`, marketplace: 'm', description: '', category: 'dev' }))
  const page = listView(many, 'dev', 2, new Set(['p9@m']))
  expect(page.text).toContain('page 3/3')
  expect(page.keyboard.inline_keyboard.at(-2)!.map(b => b.callback_data)).toEqual(['sto:l:dev:1'])
  expect(listView(many, 'dev', 0, new Set(['p9@m'])).keyboard.inline_keyboard.flat().some(b => b.text === '✓ P9')).toBe(true)
  const review = c[0]!
  expect(pluginView(review, false).text).toContain('🔌 Code review\n\nReviews diffs\n\nCategory: Development\nBy: Anthropic')
  expect(data(pluginView(review, false))).toEqual(['sto:i:code-review@official', 'sto:l:development:0'])
  expect(data(pluginView(review, true))).toEqual(['sto:u:code-review@official', 'sto:r:code-review@official', 'sto:l:development:0'])
  expect(confirmView(review, 'i').text).toContain('runs the plugin\'s code')
  const all = [...data(cats), ...data(page), ...data(pluginView(review, true)), ...data(confirmView(review, 'i')), ...data(confirmView(review, 'r'))].filter(d => d !== 'ext:p')
  expect(all).toContain('sto:I:code-review@official')
  expect(all).toContain('sto:R:code-review@official')
  for (const d of all) expect(STORE_CALLBACK.test(d)).toBe(true)
})
