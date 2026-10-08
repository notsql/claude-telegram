import { expect, test } from 'bun:test'
import { resumeView, SESSIONS_CALLBACK, sessionsView } from '../sessions/commands'

const data = (v: { keyboard: { inline_keyboard: { callback_data?: string }[][] } }) =>
  v.keyboard.inline_keyboard.flat().map(b => b.callback_data)

test('/sessions shows the status with New, Resume and Compact', () => {
  const v = sessionsView('Session: infra')
  expect(v.text).toBe('Session: infra')
  expect(data(v)).toEqual(['ssn:', 'ssl:0', 'ssc:'])
  for (const d of data(v)) expect(SESSIONS_CALLBACK.test(d!)).toBe(true)
})

test('Resume lists earlier sessions numbered for resume, paged, with Back', () => {
  const past = Array.from({ length: 10 }, (_, i) => ({ sessionId: `s${i}`, startedAt: 0, title: i ? `t${i}` : '' }))
  const p0 = resumeView(past)
  expect(p0.text).toBe('⏪ Earlier sessions (10), page 1/2. Tap one to resume it.')
  expect(p0.keyboard.inline_keyboard[0]![0]!.text).toBe('(untitled) · 1970-01-01')
  expect(data(p0)).toEqual(['ssr:1', 'ssr:2', 'ssr:3', 'ssr:4', 'ssr:5', 'ssr:6', 'ssr:7', 'ssr:8', 'ssl:1', 'ssb:'])
  expect(data(resumeView(past, 5))).toEqual(['ssr:9', 'ssr:10', 'ssl:0', 'ssb:'])
  for (const d of data(p0)) expect(SESSIONS_CALLBACK.test(d!)).toBe(true)
  expect(resumeView([]).text).toBe('No earlier sessions here.')
  expect(data(resumeView([]))).toEqual(['ssb:'])
})
