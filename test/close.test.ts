import { expect, test } from 'bun:test'
import { CLOSE_CALLBACK, withClose } from '../telegram/close.ts'

const cb = (kb: ReturnType<typeof withClose>) => kb.inline_keyboard.map(r => r.map(b => 'callback_data' in b ? b.callback_data : ''))

test('withClose adds a Close row, or sits beside a lone Back', () => {
  expect(cb(withClose())).toEqual([['ui:close']])
  expect(cb(withClose({ inline_keyboard: [[{ text: 'A', callback_data: 'a' }]] }))).toEqual([['a'], ['ui:close']])
  const back = { inline_keyboard: [[{ text: 'A', callback_data: 'a' }], [{ text: '« Back', callback_data: 'b' }]] }
  expect(cb(withClose(back))).toEqual([['a'], ['b', 'ui:close']])
  expect(back.inline_keyboard[1]).toHaveLength(1)
  expect(CLOSE_CALLBACK.test('ui:close')).toBe(true)
})
