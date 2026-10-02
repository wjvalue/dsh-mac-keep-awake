/**
 * Tests for the plugin wiring in `index.js`.
 *
 * The controller's own logic is covered elsewhere; what is under test here is
 * the *wiring*, which is where the real bugs live:
 *
 *   - an agent-scoped event registered without `{ global: true }` silently
 *     never fires from a non-agent fiber. That is not a hypothetical: it is
 *     the exact bug this file was written to catch, and it produces a plugin
 *     that loads cleanly, logs nothing, and does nothing.
 *   - a hot reload while a session is already running must acquire immediately
 *     rather than waiting for the next turn boundary.
 *
 * A fake cordis context stands in for the harness: it records registrations and
 * lets the test dispatch events by hand.
 *
 * Because `apply()` builds its own controller internally, the tests observe the
 * result the only way that actually matters: through the operating system, by
 * reading `pmset -g assertions` for a caffeinate watching THIS test process.
 * Every test disposes its fiber, so no caffeinate outlives the suite.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import { apply, Config } from '../index.js'

const isDarwin = process.platform === 'darwin'

/** A fake cordis ctx that records what the plugin registered. */
function fakeCtx({ agents = [], logger = null } = {}) {
  const listeners = new Map()
  const effects = []
  const ctx = {
    logger: logger ?? { info() {}, warn() {}, error() {} },
    on(name, handler, options) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push({ handler, options })
      return () => {}
    },
    effect(factory, label) {
      const disposer = factory()
      effects.push({ label, disposer })
      return () => {}
    },
    get(name) {
      return name === 'agents' ? { list: () => agents } : undefined
    },
    /** Fire every listener registered for `name`, passing all args through. */
    dispatch(name, ...args) {
      for (const { handler } of listeners.get(name) ?? []) handler(...args)
    },
    listenerOptions(name) {
      return (listeners.get(name) ?? []).map((l) => l.options)
    },
    disposeAll() {
      for (const { disposer } of effects) if (typeof disposer === 'function') disposer()
    },
  }
  return ctx
}

/** Collect log lines so tests can assert on the narration. */
function recordingLogger() {
  const lines = []
  const push = (level) => (...args) => lines.push({ level, text: args.map(String).join(' ') })
  return { lines, info: push('info'), warn: push('warn'), error: push('error') }
}

/**
 * The caffeinate assertions currently held on behalf of this test process.
 * Reading the kernel's ledger is the point: it proves the wiring produced a
 * real effect rather than merely calling a mock.
 */
function heldForSelf() {
  if (!isDarwin) return []
  const out = execFileSync('/usr/bin/pmset', ['-g', 'assertions'], { encoding: 'utf8' })
  return out
    .split(/^(?=\s*pid \d+\()/m)
    .filter((b) => b.includes('(caffeinate)') && b.includes(`Process ID ${process.pid}`))
}

/** Run `body` with a fiber that is always disposed, then wait for release. */
async function withPlugin(options, body) {
  const ctx = options.ctx ?? fakeCtx(options)
  apply(ctx, options.config ?? {})
  try {
    await body(ctx)
  } finally {
    ctx.disposeAll()
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
}

test('the Config schema has working defaults', () => {
  const parsed = new Config({})
  assert.equal(parsed.enabled, true)
  assert.equal(parsed.preventDisplaySleep, false, 'the display may still sleep by default')
  assert.equal(parsed.maxHours, 0)
  assert.equal(parsed.reconcileSeconds, 60)
  assert.equal(parsed.executable, '/usr/bin/caffeinate')
})

test('every agent-scoped listener is registered globally', () => {
  // The regression guard. Without `{ global: true }` these never fire, and the
  // plugin is silently inert — the failure mode has no error and no log line.
  const ctx = fakeCtx()
  apply(ctx, {})
  try {
    for (const name of ['agent/status', 'agent/disposed', 'session/event']) {
      const options = ctx.listenerOptions(name)
      assert.equal(options.length, 1, `${name} is registered exactly once`)
      assert.equal(
        options[0]?.global,
        true,
        `${name} must be registered with { global: true } or it never fires`,
      )
    }
  } finally {
    ctx.disposeAll()
  }
})

test('a running session acquires, an idle one releases', { skip: !isDarwin }, async () => {
  await withPlugin({}, async (ctx) => {
    assert.equal(heldForSelf().length, 0, 'nothing held before')

    ctx.dispatch('agent/status', { agent: { id: 'session-a' }, status: 'running' })
    await new Promise((resolve) => setTimeout(resolve, 250))
    assert.equal(heldForSelf().length, 1, 'an assertion is held while a session runs')

    ctx.dispatch('agent/status', { agent: { id: 'session-a' }, status: 'idle' })
    await new Promise((resolve) => setTimeout(resolve, 250))
    assert.equal(heldForSelf().length, 0, 'the assertion is released when it goes idle')
  })
})

test('two sessions still hold exactly one assertion', { skip: !isDarwin }, async () => {
  await withPlugin({}, async (ctx) => {
    ctx.dispatch('agent/status', { agent: { id: 'a' }, status: 'running' })
    ctx.dispatch('agent/status', { agent: { id: 'b' }, status: 'running' })
    await new Promise((resolve) => setTimeout(resolve, 250))
    assert.equal(heldForSelf().length, 1, 'refcounted, not one per session')

    // The duplicate broadcast for the same session must not inflate anything.
    ctx.dispatch('agent/status', { agent: { id: 'a' }, status: 'running' })
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(heldForSelf().length, 1)

    ctx.dispatch('agent/status', { agent: { id: 'a' }, status: 'idle' })
    await new Promise((resolve) => setTimeout(resolve, 250))
    assert.equal(heldForSelf().length, 1, 'still held while b runs')

    ctx.dispatch('agent/status', { agent: { id: 'b' }, status: 'idle' })
    await new Promise((resolve) => setTimeout(resolve, 250))
    assert.equal(heldForSelf().length, 0, 'released with the last one')
  })
})

test('a malformed event payload is ignored rather than throwing', () => {
  const ctx = fakeCtx()
  apply(ctx, {})
  try {
    // A registry shape change must degrade, not take the plugin down.
    for (const payload of [
      {},
      { agent: null, status: 'running' },
      { agent: { id: 42 }, status: 'running' },
      { agent: {}, status: 'running' },
      { agent: { id: 'x' } },
    ]) {
      ctx.dispatch('agent/status', payload)
      ctx.dispatch('agent/disposed', payload)
    }
    assert.ok(true, 'no throw')
  } finally {
    ctx.disposeAll()
  }
})

test('a hot reload while a session is already running acquires immediately', { skip: !isDarwin }, async () => {
  // This is the case a live-reloaded plugin is always in: the session started
  // before the plugin existed, so no event will ever arrive for it.
  await withPlugin({ agents: [{ id: 'already-running', status: 'running' }] }, async () => {
    assert.equal(
      heldForSelf().length,
      1,
      'the initial reconcile must pick up an already-running session',
    )
  })
})

test('the initial reconcile ignores idle agents', { skip: !isDarwin }, async () => {
  const agents = [
    { id: 'idle-1', status: 'idle' },
    { id: 'running-1', status: 'running' },
    { id: 'idle-2', status: 'idle' },
  ]
  await withPlugin({ agents }, async () => {
    assert.equal(heldForSelf().length, 1, 'exactly one assertion for the one running session')
  })
})

test('a non-darwin platform loads, warns once, and registers no listeners', () => {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
  try {
    const logger = recordingLogger()
    const ctx = fakeCtx({ logger })
    apply(ctx, {})
    try {
      assert.equal(logger.lines.filter((l) => l.level === 'warn').length, 1)
      assert.equal(
        ctx.listenerOptions('agent/status').length,
        0,
        'no listeners on a foreign platform',
      )
    } finally {
      ctx.disposeAll()
    }
  } finally {
    if (original) Object.defineProperty(process, 'platform', original)
  }
})

test('disposing the fiber releases the assertion', { skip: !isDarwin }, async () => {
  const ctx = fakeCtx()
  apply(ctx, {})
  ctx.dispatch('agent/status', { agent: { id: 'session-a' }, status: 'running' })
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.equal(heldForSelf().length, 1)

  ctx.disposeAll()
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.equal(heldForSelf().length, 0, 'dispose released it')
})

test('the plugin never leaves a caffeinate behind', { skip: !isDarwin }, async () => {
  // Guards the suite itself as much as the plugin: a wiring test that leaks a
  // caffeinate would quietly pin the machine awake.
  await withPlugin({}, async (ctx) => {
    ctx.dispatch('agent/status', { agent: { id: 'a' }, status: 'running' })
    ctx.dispatch('agent/status', { agent: { id: 'b' }, status: 'running' })
    await new Promise((resolve) => setTimeout(resolve, 250))
    assert.equal(heldForSelf().length, 1)
  })
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(heldForSelf().length, 0, 'no assertion survives the fiber')
})

test('a manual /compact holds the assertion even though status says idle', { skip: !isDarwin }, async () => {
  // The `maintenance` blind spot. `Agent.status` is 'idle' for both the idle and
  // the maintenance phase, and manual compaction runs inside maintenance. On
  // battery this machine sleeps after 60s, so without the bracket a long
  // /compact would be a real sleep window.
  const agents = [{ id: 'session-a', status: 'idle' }]
  await withPlugin({ agents }, async (ctx) => {
    assert.equal(heldForSelf().length, 0, 'an idle session holds nothing')

    ctx.dispatch('session/event', { id: 'session-a' }, { type: 'compaction/start' })
    await new Promise((resolve) => setTimeout(resolve, 250))
    assert.equal(
      heldForSelf().length,
      1,
      'compaction holds the assertion even while status reads idle',
    )

    ctx.dispatch('session/event', { id: 'session-a' }, { type: 'compaction/end' })
    await new Promise((resolve) => setTimeout(resolve, 250))
    assert.equal(heldForSelf().length, 0, 'released when the bracket closes')
  })
})

test('closing a compaction bracket does not release a genuinely running session', { skip: !isDarwin }, async () => {
  const agents = [{ id: 'session-a', status: 'running' }]
  await withPlugin({ agents }, async (ctx) => {
    ctx.dispatch('session/event', { id: 'session-a' }, { type: 'compaction/start' })
    ctx.dispatch('session/event', { id: 'session-a' }, { type: 'compaction/end' })
    await new Promise((resolve) => setTimeout(resolve, 250))
    assert.equal(heldForSelf().length, 1, 'the running session keeps it held')

    ctx.dispatch('agent/status', { agent: { id: 'session-a' }, status: 'idle' })
    await new Promise((resolve) => setTimeout(resolve, 250))
    assert.equal(heldForSelf().length, 0, 'and releases when it really goes idle')
  })
})

test('the periodic reconcile keeps an open compaction bracket held', { skip: !isDarwin }, async () => {
  // The bracket lives in a Set the registry cannot see. A reconcile that
  // replaced the held set with registry-only ids would drop it mid-compaction.
  const agents = [{ id: 'session-a', status: 'idle' }]
  await withPlugin({ agents, config: { reconcileSeconds: 0.05 } }, async (ctx) => {
    ctx.dispatch('session/event', { id: 'session-a' }, { type: 'compaction/start' })
    await new Promise((resolve) => setTimeout(resolve, 400)) // several reconciles
    assert.equal(
      heldForSelf().length,
      1,
      'the reconcile must union in the open bracket, not drop it',
    )
  })
})

test('a session disposed mid-compaction does not pin the machine awake', { skip: !isDarwin }, async () => {
  // The leak this guards: the bracket Set is the one piece of state the live
  // registry cannot correct by itself. If the session vanishes while its
  // bracket is open, an unpruned entry would be unioned back in on every
  // reconcile and hold the assertion forever.
  const agents = [{ id: 'session-a', status: 'idle' }]
  await withPlugin({ agents, config: { reconcileSeconds: 0.05 } }, async (ctx) => {
    ctx.dispatch('session/event', { id: 'session-a' }, { type: 'compaction/start' })
    await new Promise((resolve) => setTimeout(resolve, 250))
    assert.equal(heldForSelf().length, 1, 'held while compacting')

    // The session disappears WITHOUT a compaction/end — a crash, or a kill.
    agents.length = 0
    await new Promise((resolve) => setTimeout(resolve, 400)) // several reconciles
    assert.equal(
      heldForSelf().length,
      0,
      'the stale bracket must be pruned, not resurrected on every reconcile',
    )
  })
})

test('an explicit agent/disposed clears the bracket immediately', { skip: !isDarwin }, async () => {
  const agents = [{ id: 'session-a', status: 'idle' }]
  await withPlugin({ agents, config: { reconcileSeconds: 0 } }, async (ctx) => {
    ctx.dispatch('session/event', { id: 'session-a' }, { type: 'compaction/start' })
    await new Promise((resolve) => setTimeout(resolve, 250))
    assert.equal(heldForSelf().length, 1)

    // With reconcile disabled, only the disposed handler can release this.
    ctx.dispatch('agent/disposed', { agent: { id: 'session-a' } })
    await new Promise((resolve) => setTimeout(resolve, 250))
    assert.equal(heldForSelf().length, 0, 'disposed released it without any reconcile')
  })
})
