import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { cronsOf, DEFAULT_PREFS, digestTitle, loadDigestPrefs, prefsOf, saveDigestPrefs, startDigestCrons, whenText } from '../watch/digestPrefs.ts'

const dir = () => mkdtempSync(join(tmpdir(), 'tg-digest-'))

test('missing or corrupt prefs mean not set up, with the 08:30/18:30 defaults', () => {
  const d = dir()
  expect(loadDigestPrefs(d)).toBeUndefined()
  writeFileSync(join(d, 'digest-prefs.json'), '{"times":["25:00"]}')
  expect(loadDigestPrefs(d)).toBeUndefined()
  expect(prefsOf(d)).toEqual(DEFAULT_PREFS)
})

test('saving sorts and dedupes times and rejects bad ones', () => {
  const d = dir()
  expect(saveDigestPrefs(d, { ...DEFAULT_PREFS, times: ['18:30', '07:15', '18:30'] }).times).toEqual(['07:15', '18:30'])
  expect(loadDigestPrefs(d)!.times).toEqual(['07:15', '18:30'])
  expect(() => saveDigestPrefs(d, { ...DEFAULT_PREFS, times: ['7am'] })).toThrow()
  expect(() => saveDigestPrefs(d, { ...DEFAULT_PREFS, times: ['06:00', '07:00', '08:00', '09:00', '10:00'] })).toThrow()
})

test('crons, titles and the when text follow the prefs', () => {
  expect(cronsOf(DEFAULT_PREFS)).toEqual(['30 8 * * *', '30 18 * * *'])
  expect(cronsOf({ ...DEFAULT_PREFS, times: ['07:05'], weekdays: true })).toEqual(['5 7 * * 1-5'])
  expect([digestTitle(8), digestTitle(13), digestTitle(18)]).toEqual(['Morning digest', 'Afternoon digest', 'Evening digest'])
  expect(whenText(DEFAULT_PREFS)).toBe('08:30 and 18:30, every day')
  expect(whenText({ ...DEFAULT_PREFS, times: ['07:00', '12:00', '18:00'], weekdays: true })).toBe('07:00, 12:00 and 18:00, weekdays only')
  expect(whenText({ ...DEFAULT_PREFS, times: [] })).toBe('Off')
})

test('the crons reload from the prefs and run in the given tz', () => {
  let p = DEFAULT_PREFS
  const c = startDigestCrons({ tz: 'Asia/Singapore', prefs: () => p, run: () => {} })
  const hm = (d: Date | null) => d!.toLocaleString('en-GB', { timeZone: 'Asia/Singapore', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  expect(['08:30', '18:30']).toContain(hm(c.nextRun()))
  p = { ...DEFAULT_PREFS, times: ['21:45'] }
  c.reload()
  expect(hm(c.nextRun())).toBe('21:45')
  p = { ...DEFAULT_PREFS, times: [] }
  c.reload()
  expect(c.nextRun()).toBeNull()
  c.stop()
})
