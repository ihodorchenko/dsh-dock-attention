import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import {
  BEACON_BUNDLE_ID,
  BEACON_LAUNCH_FLAGS,
  HELPER_LOG_PATH,
  HELPER_INSTALL_DIR,
  INSTALLED_HELPER_APP,
  PACKAGE_ROOT,
  REQUEST_PATH,
} from '../lib/attention.js'

const SOURCE_PLIST = join(PACKAGE_ROOT, 'src', 'helper', 'Info.plist')
const BUNDLE_PLIST = join(PACKAGE_ROOT, 'bin', 'DSH Attention.app', 'Contents', 'Info.plist')

test('beacon launches in the background as a fresh instance', () => {
  assert.deepEqual([...BEACON_LAUNCH_FLAGS], ['-n', '-g'])
})

test('helper is a regular app, never a promoted background agent', () => {
  // A Dock tile created by promoting an LSUIElement app is not reopenable through
  // LaunchServices: clicking it makes macOS reveal the bundle in Finder instead of
  // activating the app, so the click never reaches the helper.
  for (const plist of [SOURCE_PLIST, BUNDLE_PLIST]) {
    const text = readFileSync(plist, 'utf8')
    assert.doesNotMatch(text, /<key>LSUIElement<\/key>/, `${plist} must not set LSUIElement`)
    assert.match(text, new RegExp(`<key>CFBundleIdentifier</key>\\s*<string>${BEACON_BUNDLE_ID.replaceAll('.', '\\.')}</string>`))
  }
})

test('the committed helper bundle uses the source Info.plist', () => {
  assert.equal(readFileSync(BUNDLE_PLIST, 'utf8'), readFileSync(SOURCE_PLIST, 'utf8'))
})

test('the beacon is installed at a stable Application Support location', () => {
  const home = process.env.HOME
  if (typeof home === 'string' && home.length > 0) {
    assert.equal(HELPER_INSTALL_DIR, join(home, 'Library', 'Application Support', 'dsh-dock-attention'))
  }
  assert.equal(INSTALLED_HELPER_APP, join(HELPER_INSTALL_DIR, 'DSH Attention.app'))
  assert.ok(!INSTALLED_HELPER_APP.includes('node_modules'))
})

test('request and log files live next to the installed helper', () => {
  assert.equal(REQUEST_PATH, join(HELPER_INSTALL_DIR, 'runtime', 'request.json'))
  assert.equal(HELPER_LOG_PATH, join(HELPER_INSTALL_DIR, 'runtime', 'helper.log'))
})
