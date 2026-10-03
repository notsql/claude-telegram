import { describe, expect, test } from 'bun:test'
import { apiKeyRefusal, createUsageLimitWatcher } from '../agent/auth'
import { parseLine, type StreamEvent } from '../agent/stream'

const ev = (o: Record<string, unknown>) => parseLine(JSON.stringify(o))!
const NOW = 1_790_000_000_000
const usage = { input_tokens: 0, output_tokens: 0 }
const result = (is_error: boolean) => ev({
  type: 'result', subtype: is_error ? 'error_during_execution' : 'success', session_id: 's',
  is_error, num_turns: 1, duration_ms: 1, total_cost_usd: 0, usage,
})
const rateLimit = (status: string, resetsAt?: number) => ev({
  type: 'rate_limit_event', rate_limit_info: { status, ...(resetsAt ? { resetsAt } : {}) },
})
const retry = (error: string) => ev({ type: 'system', subtype: 'api_retry', error })

function pauseUntil(events: StreamEvent[]): number | null {
  const watch = createUsageLimitWatcher(() => NOW)
  let out: number | null = null
  for (const e of events) out = watch(e) ?? out
  return out
}

describe('auth guard (FR10, AC7)', () => {
  test('refuses when ANTHROPIC_API_KEY is set', () => {
    expect(apiKeyRefusal({ ANTHROPIC_API_KEY: 'sk-ant-x' })).toContain('ANTHROPIC_API_KEY')
    expect(apiKeyRefusal({})).toBeNull()
  })

  test('an ordinary turn does not pause', () => {
    expect(pauseUntil([rateLimit('allowed', NOW / 1000 + 60), result(false)])).toBeNull()
  })

  test('an error result without a limit signal does not pause', () => {
    expect(pauseUntil([rateLimit('allowed', NOW / 1000 + 60), result(true)])).toBeNull()
  })

  test('a rejected rate limit pauses until resetsAt', () => {
    const reset = NOW / 1000 + 3600
    expect(pauseUntil([rateLimit('rejected', reset), result(true)])).toBe(reset * 1000)
  })

  test('an api_retry limit error pauses, falling back to one hour', () => {
    expect(pauseUntil([retry('rate_limit'), result(true)])).toBe(NOW + 3600_000)
    expect(pauseUntil([retry('billing_error'), result(true)])).toBe(NOW + 3600_000)
    expect(pauseUntil([retry('server_error'), result(true)])).toBeNull()
  })
})
