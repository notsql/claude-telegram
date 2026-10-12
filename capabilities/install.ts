// Runs a template argv without a shell, with a timeout; captures output for the card (012 FR6).
export type SpawnResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean }
export type Spawner = (argv: string[], timeoutMs: number) => Promise<SpawnResult>

export type InstallResult = { ok: boolean; code: number | null; timedOut: boolean; output: string }

const DEFAULT_TIMEOUT_MS = 10 * 60_000
const OUTPUT_CAP = 4000

export const bunSpawner: Spawner = async (argv, timeoutMs) => {
  const proc = Bun.spawn(argv, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs, killSignal: 'SIGKILL' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr, timedOut: proc.signalCode === 'SIGKILL' }
}

/** Run argv directly (argv[0] is the executable, no shell). Never throws; spawn errors become a failed result. */
export async function runArgv(
  argv: string[],
  opts: { timeoutMs?: number; spawn?: Spawner } = {},
): Promise<InstallResult> {
  const spawn = opts.spawn ?? bunSpawner
  try {
    const r = await spawn(argv, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    const all = [r.stdout.trim(), r.stderr.trim()].filter(Boolean).join('\n')
    const output = all.length > OUTPUT_CAP ? '…' + all.slice(-OUTPUT_CAP) : all
    return { ok: r.code === 0 && !r.timedOut, code: r.code, timedOut: r.timedOut, output }
  } catch (err) {
    return { ok: false, code: null, timedOut: false, output: err instanceof Error ? err.message : String(err) }
  }
}
