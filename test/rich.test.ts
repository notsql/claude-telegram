import { expect, test } from 'bun:test'
import { bold, capped, italic, joined, markdown, rich } from '../telegram/rich.ts'

test('parts join with entities at the right offsets', () => {
  const r = rich('🔴 ', bold('Geri'), ' · ', italic('Sun'))
  expect(r.text).toBe('🔴 Geri · Sun')
  expect(r.entities).toEqual([{ type: 'bold', offset: 3, length: 4 }, { type: 'italic', offset: 10, length: 3 }])
  expect(joined(['a', bold('b')], '\n').entities).toEqual([{ type: 'bold', offset: 2, length: 1 }])
})

test('third-party text stays literal unless styled', () => {
  const r = rich('<b>x</b> **y**')
  expect(r.text).toBe('<b>x</b> **y**')
  expect(r.entities).toEqual([])
})

test('capping clips entities with the text', () => {
  const r = capped(rich('ab', bold('cdefgh')), 5)
  expect(r.text).toBe('abcd…')
  expect(r.entities).toEqual([{ type: 'bold', offset: 2, length: 2 }])
  expect(capped(rich(bold('abcd'), 'efgh', italic('ij')), 6).entities).toEqual([{ type: 'bold', offset: 0, length: 4 }])
})

test('markdown renders bold, italics, code, links, bullets and headings', () => {
  const r = markdown('# Plan\n- **pay** the *bill* by `Fri`\n[form](https://a.co/x)')
  expect(r.text).toBe('Plan\n• pay the bill by Fri\nform')
  expect(r.entities.map(e => e.type)).toEqual(['bold', 'bold', 'italic', 'code', 'text_link'])
  expect(r.entities.at(-1)).toMatchObject({ url: 'https://a.co/x' })
})

test('fenced code is a pre block and its contents are left alone', () => {
  const r = markdown('run:\n```\nls **x**\n```\ndone')
  expect(r.text).toBe('run:\nls **x**\ndone')
  expect(r.entities).toEqual([{ type: 'pre', offset: 5, length: 8 }])
})

test('ordinary text with stray marks is not formatted', () => {
  for (const s of ['snake_case_name and other_name', '2*3*4 = 24', 'a * b * c', 'unfinished **bold', '```\nunclosed'])
    expect(markdown(s).entities).toEqual([])
})
