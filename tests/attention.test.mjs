import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BEACON_BUNDLE_ID,
  DEFAULT_CONFIG,
  attentionKind,
  buildProbeScript,
  isKindEnabled,
  isRootSession,
  normalizeConfig,
  resolveSoundPath,
} from '../lib/attention.js'

test('normalizeConfig returns the defaults for missing or malformed input', () => {
  for (const raw of [undefined, null, 42, 'nope', [], {}]) {
    const config = normalizeConfig(raw)
    assert.equal(config.enabled, true)
    assert.equal(config.targetBundleId, 'com.deepseek.dsh')
    assert.deepEqual(config.activeBundleIds, ['com.deepseek.dsh'])
    assert.equal(config.mode, 'critical')
    assert.equal(config.timeoutSeconds, 30)
    assert.equal(config.minIntervalSeconds, 3)
    assert.equal(config.repeatCount, 3)
    assert.equal(config.sound, null)
    assert.equal(config.openUrl, 'dsh://open')
  }
})

test('normalizeConfig accepts valid overrides', () => {
  const config = normalizeConfig({
    enabled: false,
    targetBundleId: 'com.apple.Safari',
    activeBundleIds: ['com.apple.Safari', 'com.deepseek.dsh', 'com.apple.Safari', 'bad id'],
    skipWhenActive: false,
    bounceOnApproval: false,
    bounceOnQuestion: false,
    bounceOnTurnEnd: false,
    includeSubagents: true,
    mode: 'informational',
    repeatCount: 9,
    timeoutSeconds: 12,
    minIntervalSeconds: 0,
    sound: 'Ping',
    openUrl: 'dsh://open',
  })
  assert.equal(config.enabled, false)
  assert.equal(config.targetBundleId, 'com.apple.Safari')
  assert.deepEqual(config.activeBundleIds, ['com.apple.Safari', 'com.deepseek.dsh'])
  assert.equal(config.skipWhenActive, false)
  assert.equal(config.bounceOnApproval, false)
  assert.equal(config.mode, 'informational')
  assert.equal(config.repeatCount, 9)
  assert.equal(config.timeoutSeconds, 12)
  assert.equal(config.minIntervalSeconds, 0)
  assert.equal(config.sound, 'Ping')
})

test('normalizeConfig clamps out-of-range numbers and drops unknown modes', () => {
  const config = normalizeConfig({
    mode: 'screaming',
    repeatCount: 9000,
    timeoutSeconds: 0.1,
    minIntervalSeconds: -4,
  })
  assert.equal(config.mode, 'critical')
  assert.equal(config.repeatCount, 20)
  assert.equal(config.timeoutSeconds, 3)
  assert.equal(config.minIntervalSeconds, 0)
})

test('normalizeConfig accepts an absolute sound path and null', () => {
  assert.equal(normalizeConfig({ sound: '/tmp/ping.aiff' }).sound, '/tmp/ping.aiff')
  assert.equal(normalizeConfig({ sound: null }).sound, null)
  assert.equal(normalizeConfig({ sound: '   ' }).sound, null)
})

test('attentionKind maps approvals, questions and finished turns', () => {
  assert.equal(attentionKind({ type: 'approval/asked', data: { toolName: 'Bash' } }), 'approval')
  assert.equal(attentionKind({ type: 'tool/call', data: { name: 'ask_user_question' } }), 'question')
  assert.equal(attentionKind({ type: 'tool/call', data: { name: 'exit_plan_mode' } }), 'question')
  assert.equal(attentionKind({ type: 'tool/call', data: { name: 'Bash' } }), null)
  assert.equal(attentionKind({ type: 'turn/end', data: { reason: { kind: 'completed' } } }), 'turn')
  assert.equal(attentionKind({ type: 'turn/end', data: { reason: {} } }), 'turn')
  assert.equal(attentionKind({ type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'boom' } } } }), 'error')
  assert.equal(attentionKind({ type: 'turn/end', data: { reason: { kind: 'blocked' } } }), 'blocked')
  assert.equal(attentionKind({ type: 'turn/end', data: { reason: { kind: 'max-tokens' } } }), 'max-tokens')
})

test('attentionKind ignores turns the user caused or did not need to see', () => {
  for (const kind of ['aborted', 'forked', 'interrupted']) {
    assert.equal(attentionKind({ type: 'turn/end', data: { reason: { kind } } }), null)
  }
  assert.equal(attentionKind({ type: 'step/start' }), null)
  assert.equal(attentionKind({ type: 'assistant/message' }), null)
  assert.equal(attentionKind(null), null)
})

test('isKindEnabled follows the three switches', () => {
  const config = normalizeConfig({ bounceOnApproval: true, bounceOnQuestion: false, bounceOnTurnEnd: true })
  assert.equal(isKindEnabled('approval', config), true)
  assert.equal(isKindEnabled('question', config), false)
  for (const kind of ['turn', 'error', 'blocked', 'max-tokens']) {
    assert.equal(isKindEnabled(kind, config), true)
  }
  assert.equal(isKindEnabled('unknown', config), false)
})

test('isRootSession skips subagents unless asked', () => {
  const config = normalizeConfig({})
  assert.equal(isRootSession({ header: { cwd: '/tmp' } }, config), true)
  assert.equal(isRootSession({ header: { origin: 'subagent' } }, config), false)
  assert.equal(isRootSession({ header: { parentSession: 'parent' } }, config), false)
  assert.equal(isRootSession({}, config), false)
  const withSubagents = normalizeConfig({ includeSubagents: true })
  assert.equal(isRootSession({ header: { origin: 'subagent' } }, withSubagents), true)
})

test('resolveSoundPath resolves system sounds and absolute paths only', () => {
  assert.equal(resolveSoundPath('Glass'), '/System/Library/Sounds/Glass.aiff')
  assert.equal(resolveSoundPath('/tmp/ping.aiff'), '/tmp/ping.aiff')
  assert.equal(resolveSoundPath(null), null)
  assert.equal(resolveSoundPath('../../etc/passwd'), null)
  assert.equal(resolveSoundPath('with/slash'), null)
})

test('buildProbeScript embeds only validated bundle ids', () => {
  const script = buildProbeScript(normalizeConfig({
    targetBundleId: 'com.deepseek.dsh',
    activeBundleIds: ['com.apple.Safari', 'evil"); process.exit(1); //'],
  }))
  assert.match(script, /com\.deepseek\.dsh/)
  assert.match(script, /com\.apple\.Safari/)
  assert.match(script, new RegExp(BEACON_BUNDLE_ID))
  assert.doesNotMatch(script, /process\.exit/)
})

test('default config keeps the three attention switches on', () => {
  assert.equal(DEFAULT_CONFIG.bounceOnApproval, true)
  assert.equal(DEFAULT_CONFIG.bounceOnQuestion, true)
  assert.equal(DEFAULT_CONFIG.bounceOnTurnEnd, true)
  assert.equal(DEFAULT_CONFIG.skipWhenActive, true)
})
