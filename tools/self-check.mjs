#!/usr/bin/env node
/**
 * End-to-end self-check for dsh-dock-attention.
 *
 * Verifies that the bundled native beacon app can be launched, that it registers
 * in the Dock, and that it disappears again on its own. It forces the beacon to
 * appear even while you are reading this, so watch the Dock while it runs.
 *
 * Usage: node tools/self-check.mjs
 */
import { existsSync, readFileSync } from 'node:fs'

import {
  BEACON_BUNDLE_ID,
  HELPER_APP,
  HELPER_EXECUTABLE,
  HELPER_LOG_PATH,
  ensureHelperInstalled,
  normalizeConfig,
  probe,
  launchBeacon,
  writeRequest,
} from '../lib/attention.js'

const CHECK_TIMEOUT_SECONDS = 8
const WAIT_LIMIT_MS = 25_000
const POLL_MS = 400

const config = normalizeConfig({
  mode: 'informational',
  repeatCount: 3,
  timeoutSeconds: CHECK_TIMEOUT_SECONDS,
  minIntervalSeconds: 0,
  // A bundle id that is not installed, so the beacon cannot self-quit on activation.
  targetBundleId: 'com.example.dsh-dock-attention-self-check',
})

function line(message) {
  process.stdout.write(`${message}\n`)
}

function fail(message) {
  process.stderr.write(`✗ ${message}\n`)
  process.exit(1)
}

async function main() {
  line('dsh-dock-attention self-check')
  line(`  shipped helper: ${HELPER_APP}`)
  if (!existsSync(HELPER_APP)) fail(`helper app not found: ${HELPER_APP}`)
  if (!existsSync(HELPER_EXECUTABLE)) fail(`helper executable not found: ${HELPER_EXECUTABLE}`)
  let launchedApp = HELPER_APP
  try {
    launchedApp = ensureHelperInstalled()
  } catch (error) {
    line(`  warning: could not install the helper copy (${error instanceof Error ? error.message : String(error)})`)
  }
  line(`  launches from: ${launchedApp}`)

  const before = await probe(config)
  line(`  frontmost app: ${before.frontBundleId || 'unknown'}`)
  if (before.running.includes(BEACON_BUNDLE_ID)) fail('another beacon instance is already running; wait for it to finish')

  writeRequest(config)
  await launchBeacon()
  line(`  beacon requested (informational ×${config.repeatCount}, ${CHECK_TIMEOUT_SECONDS}s)`)
  line('')
  line('  👀 Watch the Dock: a bouncing “DSH Attention” icon should appear now.')
  line('')

  const startedAt = Date.now()
  let seen = false
  let running = false
  while (Date.now() - startedAt < WAIT_LIMIT_MS) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    const snapshot = await probe(config)
    running = snapshot.running.includes(BEACON_BUNDLE_ID)
    if (running) seen = true
    if (seen && !running) break
  }

  if (!seen) fail('the beacon never appeared in the Dock (see runtime/helper.log)')
  if (running) fail('the beacon is still running after its timeout; see runtime/helper.log')

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
  line(`  ✓ beacon appeared in the Dock and exited after ${elapsed}s`)
  const logPath = HELPER_LOG_PATH
  if (existsSync(logPath)) {
    const lines = readFileSync(logPath, 'utf8').trim().split('\n')
    line(`  helper log tail: ${lines.slice(-2).join(' | ')}`)
  }
  line('')
  line('If you saw the icon bounce, the plugin is ready to use.')
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)))
