import assert from 'node:assert/strict'
import test from 'node:test'

import { apply } from '../index.js'

const IS_MACOS = process.platform === 'darwin'
const skip = IS_MACOS ? false : 'the plugin only mounts on macOS'

/** Minimal Cordis context double: records listeners and lets a test fire events. */
function fakeContext() {
  const listeners = new Map()
  const logs = []
  const ctx = {
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
    },
    logger: {
      info: (message) => logs.push(['info', message]),
      warn: (message) => logs.push(['warn', message]),
    },
    emit(event, ...args) {
      for (const handler of listeners.get(event) ?? []) handler(...args)
    },
    logs,
  }
  return ctx
}

/** Collects raiseAttention() calls; resolves to a successful beacon by default. */
function stubRaise(result = { action: 'beacon', frontBundleId: 'com.apple.Safari' }) {
  const calls = []
  const raise = async (config, options) => {
    calls.push({ config, options })
    return result
  }
  return { raise, calls }
}

function rootSession(id = 'session-1') {
  return { id, header: { cwd: '/Users/someone/Project/demo' } }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

test('mounts two listeners and forwards approval/question/turn-end', { skip }, async () => {
  const ctx = fakeContext()
  const { raise, calls } = stubRaise()
  apply(ctx, { minIntervalSeconds: 0 }, { raiseAttention: raise })

  ctx.emit('session/event', rootSession(), { type: 'approval/asked', data: { toolName: 'Bash' } })
  ctx.emit('session/event', rootSession(), { type: 'tool/call', data: { name: 'ask_user_question' } })
  ctx.emit('session/event', rootSession(), { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await flush()

  assert.equal(calls.length, 3)
  assert.equal(ctx.logs.filter(([level]) => level === 'info').length, 3)
})

test('ignores events that are not attention moments', { skip }, async () => {
  const ctx = fakeContext()
  const { raise, calls } = stubRaise()
  apply(ctx, { minIntervalSeconds: 0 }, { raiseAttention: raise })

  const session = rootSession()
  ctx.emit('session/event', session, { type: 'tool/call', data: { name: 'Bash' } })
  ctx.emit('session/event', session, { type: 'turn/end', data: { reason: { kind: 'aborted' } } })
  ctx.emit('session/event', session, { type: 'turn/end', data: { reason: { kind: 'forked' } } })
  ctx.emit('session/event', session, { type: 'step/start' })
  await flush()

  assert.equal(calls.length, 0)
})

test('ignores subagent sessions by default', { skip }, async () => {
  const ctx = fakeContext()
  const { raise, calls } = stubRaise()
  apply(ctx, { minIntervalSeconds: 0 }, { raiseAttention: raise })

  ctx.emit('session/event', { id: 'sub', header: { origin: 'subagent' } }, { type: 'approval/asked', data: {} })
  ctx.emit('session/event', { id: 'child', header: { parentSession: 'session-1' } }, { type: 'approval/asked', data: {} })
  await flush()

  assert.equal(calls.length, 0)
})

test('respects the per-kind switches and the master switch', { skip }, async () => {
  const ctx = fakeContext()
  const { raise, calls } = stubRaise()
  apply(
    ctx,
    { minIntervalSeconds: 0, bounceOnApproval: false, bounceOnQuestion: false, bounceOnTurnEnd: false },
    { raiseAttention: raise },
  )
  const session = rootSession()
  ctx.emit('session/event', session, { type: 'approval/asked', data: {} })
  ctx.emit('session/event', session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await flush()
  assert.equal(calls.length, 0)

  const disabledCtx = fakeContext()
  const second = stubRaise()
  apply(disabledCtx, { enabled: false }, { raiseAttention: second.raise })
  disabledCtx.emit('session/event', session, { type: 'approval/asked', data: {} })
  await flush()
  assert.equal(second.calls.length, 0)
})

test('debounces attention events inside minIntervalSeconds', { skip }, async () => {
  const ctx = fakeContext()
  const { raise, calls } = stubRaise()
  apply(ctx, { minIntervalSeconds: 60 }, { raiseAttention: raise })
  const session = rootSession()

  ctx.emit('session/event', session, { type: 'approval/asked', data: {} })
  ctx.emit('session/event', session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await flush()

  assert.equal(calls.length, 1)
})

test('passes normalized options to raiseAttention', { skip }, async () => {
  const ctx = fakeContext()
  const { raise, calls } = stubRaise()
  apply(ctx, { mode: 'informational', timeoutSeconds: 9, repeatCount: 2 }, { raiseAttention: raise })

  ctx.emit('session/event', rootSession(), { type: 'approval/asked', data: {} })
  await flush()

  assert.equal(calls.length, 1)
  assert.equal(calls[0].config.mode, 'informational')
  assert.equal(calls[0].config.timeoutSeconds, 9)
  assert.equal(calls[0].config.repeatCount, 2)
  assert.equal(typeof calls[0].options.log, 'function')
})

test('a failing native attention primitive is logged, not thrown', { skip }, async () => {
  const ctx = fakeContext()
  const raise = async () => {
    throw new Error('beacon missing')
  }
  apply(ctx, { minIntervalSeconds: 0 }, { raiseAttention: raise })
  ctx.emit('session/event', rootSession(), { type: 'approval/asked', data: {} })
  await flush()

  const warnings = ctx.logs.filter(([level]) => level === 'warn')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0][1], /beacon missing/)
})
