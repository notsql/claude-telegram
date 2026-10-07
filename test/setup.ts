// Loaded before every test file (bunfig.toml): state-dir paths are fixed at
// import time, so this keeps any test from touching the real ~/.claude state.
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

process.env.TELEGRAM_STATE_DIR = mkdtempSync(join(tmpdir(), 'tg-test-state-'))
