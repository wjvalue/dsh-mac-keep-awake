/**
 * Unit tests for the assertion controller — fake spawn, no real processes.
 *
 * The contract under test is the *counting*, not the sleeping: exactly one
 * assertion while ≥1 session runs, released on the last one, and never a
 * handle resurrected by a stale callback.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createKeepAwakeController } from '../src/keep-awake.js'

/** A fake caffeinate that records argv and lets the test fire callbacks. */
function fakeSpawn() {
  const calls = []
  const impl = (argv, hooks) => {
    const call = { argv, hooks, killed: false, pid: 1000 + calls.length, gone: false }
    call.handle = {
      pid: call.pid,
      kill: () => {
        call.killed = true
        call.gone = true
      },
      exited: () => call.gone,
    }
    calls.push(call)
    return call.handle
  }
  return { calls, impl }
}

/** A logger that records everything, so tests can assert on the narration. */
function recordingLogger() {
  const lines = []
  const push = (level) => (...args) => lines.push({ level, text: args.map(String).join(' ') })
  return { lines, info: push('info'), warn: push('warn'), error: push('error') }
}

function make(options = {}) {
  const spawn = fakeSpawn()
  const logger = recordingLogger()
  const timers = []
  // A controllable clock: tests advance it to simulate how long a child lived,
  // which is what decides whether a clean exit was useful work or a spin.
  const clock = { t: 1_000_000 }
  const controller = createKeepAwakeController({
    platform: 'darwin',
    watchPid: 4242,
    spawnImpl: spawn.impl,
    logger,
    setTimer: (fn, ms) => {
      const t = { fn, ms, unref() {} }
      timers.push(t)
      return t
    },
    clearTimer: (t) => {
      t.cleared = true
    },
    now: () => clock.t,
    ...options,
  })
  return { controller, spawn, logger, timers, clock }
}

test('holds one assertion for the first running session', () => {
  const { controller, spawn, clock } = make()
  assert.equal(controller.snapshot().active, false)

  controller.enter('session-a')

  assert.equal(spawn.calls.length, 1)
  const snap = controller.snapshot()
  assert.equal(snap.active, true)
  assert.equal(snap.heldCount, 1)
  assert.deepEqual(snap.held, ['session-a'])
  assert.equal(snap.acquiredAt, clock.t)
})

test('the argv is exactly caffeinate -i -w <host pid>', () => {
  const { controller, spawn } = make()
  controller.enter('a')
  assert.deepEqual(spawn.calls[0].argv, ['/usr/bin/caffeinate', '-i', '-w', '4242'])
})

test('preventDisplaySleep adds -d, maxHours adds -t', () => {
  const { controller, spawn } = make({ preventDisplaySleep: true, maxHours: 2 })
  controller.enter('a')
  assert.deepEqual(spawn.calls[0].argv, ['/usr/bin/caffeinate', '-i', '-d', '-t', '7200', '-w', '4242'])
})

test('a second session reuses the one assertion', () => {
  const { controller, spawn } = make()
  controller.enter('a')
  controller.enter('b')
  assert.equal(spawn.calls.length, 1)
  assert.equal(controller.snapshot().heldCount, 2)
})

test('repeating the same session id never inflates the count', () => {
  const { controller, spawn } = make()
  controller.enter('a')
  controller.enter('a')
  controller.enter('a')
  assert.equal(spawn.calls.length, 1)
  assert.equal(controller.snapshot().heldCount, 1)
})

test('the assertion survives until the LAST session stops', () => {
  const { controller, spawn } = make()
  controller.enter('a')
  controller.enter('b')

  controller.leave('a')
  assert.equal(controller.snapshot().active, true, 'still one session running')
  assert.equal(spawn.calls[0].killed, false)

  controller.leave('b')
  assert.equal(controller.snapshot().active, false)
  assert.equal(spawn.calls[0].killed, true, 'released on the last one')
})

test('leaving an unknown or empty id is a no-op', () => {
  const { controller, spawn } = make()
  controller.leave('never-seen')
  controller.leave('')
  controller.leave(undefined)
  assert.equal(spawn.calls.length, 0)
  assert.equal(controller.snapshot().active, false)
})

test('a spurious leave for an unknown id does not clear a struggling child ladder', () => {
  // `Set.delete` is idempotent, so a repeated `leave` is harmless for the
  // count. What it must NOT do is run `resetLadders()`: a stray leave for a
  // session that was never entered would otherwise erase the retry history of a
  // live child that is currently failing, resetting its backoff to 1s.
  const timers = []
  const handles = []
  const controller = createKeepAwakeController({
    platform: 'darwin',
    watchPid: 4242,
    logger: null,
    spawnImpl: (argv, hooks) => {
      const h = { pid: 900 + handles.length, kill() {}, exited: () => true, hooks }
      handles.push(h)
      return h
    },
    setTimer: (fn, ms) => {
      const t = { fn, ms, unref() {} }
      timers.push(t)
      return t
    },
    clearTimer: () => {},
  })

  controller.enter('a')
  // Drive the ladder up so the next delay is 2s (1000 * 2^(failures-1)).
  handles.at(-1).hooks.onError(new Error('boom 1'))
  timers.at(-1).fn()
  handles.at(-1).hooks.onError(new Error('boom 2'))
  assert.equal(controller.snapshot().failures, 2)
  const nextDelay = timers.at(-1).ms
  assert.equal(nextDelay, 2000, 'the ladder reached 2s')

  // A stray leave for a session that was never entered.
  controller.leave('never-entered')

  assert.equal(controller.snapshot().failures, 2, 'the ladder was NOT reset')
  assert.equal(timers.at(-1).ms, 2000, 'and the backoff is still 2s')
})

test('reconcile acquires for a session that was already running', () => {
  const { controller, spawn } = make()
  controller.reconcile(['running-1'])
  assert.equal(spawn.calls.length, 1)
  assert.deepEqual(controller.snapshot().held, ['running-1'])
})

test('reconcile releases a session that vanished without an idle event', () => {
  const { controller, spawn } = make()
  controller.enter('a')
  controller.reconcile([])
  assert.equal(spawn.calls[0].killed, true)
  assert.equal(controller.snapshot().active, false)
})

test('reconcile with an identical set changes nothing', () => {
  const { controller, spawn } = make()
  controller.enter('a')
  controller.reconcile(['a'])
  controller.reconcile(['a'])
  assert.equal(spawn.calls.length, 1)
  assert.equal(controller.snapshot().heldCount, 1)
})

test('dispose releases the assertion and stops responding', () => {
  const { controller, spawn } = make()
  controller.enter('a')
  controller.dispose()
  assert.equal(spawn.calls[0].killed, true)
  assert.equal(controller.snapshot().active, false)

  controller.enter('b')
  controller.reconcile(['b'])
  assert.equal(spawn.calls.length, 1, 'no assertion after dispose')
})

test('a stale exit callback cannot resurrect a released handle', () => {
  const { controller, spawn } = make()
  controller.enter('a')
  const staleHooks = spawn.calls[0].hooks
  controller.leave('a')
  assert.equal(controller.snapshot().active, false)

  // The SIGTERM we sent surfaces as an exit event *after* the release.
  staleHooks.onExit({ code: null, signal: 'SIGTERM' })

  assert.equal(controller.snapshot().active, false, 'must not re-acquire')
  assert.equal(spawn.calls.length, 1)
})

test('a synchronous spawn failure is not adopted and is retried', () => {
  const logger = recordingLogger()
  const timers = []
  let attempts = 0
  const controller = createKeepAwakeController({
    platform: 'darwin',
    watchPid: 4242,
    logger,
    spawnImpl: () => {
      attempts += 1
      throw new Error('ENOENT')
    },
    setTimer: (fn, ms) => {
      const t = { fn, ms, unref() {} }
      timers.push(t)
      return t
    },
    clearTimer: () => {},
  })

  controller.enter('a')

  assert.equal(attempts, 1)
  assert.equal(controller.snapshot().active, false, 'no phantom handle')
  assert.equal(controller.snapshot().caffeinatePid, null)
  assert.equal(timers.length, 1, 'a retry was scheduled')
  assert.equal(logger.lines.at(-1).level, 'warn')
})

test('an async spawn error is retried with growing backoff, then keeps trying', () => {
  const logger = recordingLogger()
  const timers = []
  const handles = []
  const controller = createKeepAwakeController({
    platform: 'darwin',
    watchPid: 4242,
    logger,
    spawnImpl: (argv, hooks) => {
      const h = { pid: 900 + handles.length, kill() {}, exited: () => true, hooks }
      handles.push(h)
      return h
    },
    setTimer: (fn, ms) => {
      const t = { fn, ms, unref() {} }
      timers.push(t)
      return t
    },
    clearTimer: () => {},
  })

  controller.enter('a')
  assert.equal(handles.length, 1)

  // Fail three times; each failure must schedule exactly one retry.
  for (let i = 0; i < 3; i += 1) {
    handles.at(-1).hooks.onError(new Error(`spawn failed ${i}`))
    assert.equal(controller.snapshot().active, false)
    const timer = timers.at(-1)
    assert.ok(timer, `retry ${i} scheduled`)
    timer.fn()
  }
  assert.equal(handles.length, 4, 'initial + 3 retries')

  // The fourth failure escalates to the loud error…
  handles.at(-1).hooks.onError(new Error('spawn failed final'))
  assert.equal(logger.lines.at(-1).level, 'error')

  // …but is NOT terminal: a retry is still scheduled, so the plugin heals
  // itself if the cause goes away. A permanently terminal ladder meant a
  // session could run with no assertion and no way back.
  assert.ok(controller.snapshot().retryPending, 'a retry is still pending after giving up')
  const delay = timers.at(-1).ms
  timers.at(-1).fn()
  assert.equal(handles.length, 5, 'it keeps retrying')
  assert.ok(delay >= 1000, `backoff is at least 1s, got ${delay}`)
  assert.ok(delay <= 60_000, `backoff is capped, got ${delay}`)
})

test('the loud give-up line is logged once, not on every retry', () => {
  const logger = recordingLogger()
  const timers = []
  const handles = []
  const controller = createKeepAwakeController({
    platform: 'darwin',
    watchPid: 4242,
    logger,
    spawnImpl: (argv, hooks) => {
      const h = { pid: 900 + handles.length, kill() {}, exited: () => true, hooks }
      handles.push(h)
      return h
    },
    setTimer: (fn, ms) => {
      const t = { fn, ms, unref() {} }
      timers.push(t)
      return t
    },
    clearTimer: () => {},
  })

  controller.enter('a')
  for (let i = 0; i < 8; i += 1) {
    handles.at(-1).hooks.onError(new Error(`boom ${i}`))
    timers.at(-1).fn()
  }
  const errors = logger.lines.filter((l) => l.level === 'error')
  assert.equal(errors.length, 1, 'exactly one give-up error across 8 failures')
})

test('a clean exit re-acquires instead of counting as a failure', () => {
  // This is the `maxHours` case: `caffeinate -t N` exits 0 on purpose when the
  // cap expires. Counting that as a failure walked the ladder to its end while
  // a session was still running, and reconcile could not recover.
  const logger = recordingLogger()
  const timers = []
  const handles = []
  let clock = 1_000_000
  const controller = createKeepAwakeController({
    platform: 'darwin',
    watchPid: 4242,
    maxHours: 1,
    logger,
    spawnImpl: (argv, hooks) => {
      const h = { pid: 900 + handles.length, kill() {}, exited: () => true, hooks }
      handles.push(h)
      return h
    },
    setTimer: (fn, ms) => {
      const t = { fn, ms, unref() {} }
      timers.push(t)
      return t
    },
    clearTimer: () => {},
    now: () => clock,
  })

  controller.enter('a')
  assert.equal(handles.length, 1)

  // A normal, on-purpose expiry: exit code 0, no signal, after real service.
  clock += 60_000
  handles.at(-1).hooks.onExit({ code: 0, signal: null })

  assert.equal(controller.snapshot().failures, 0, 'a clean exit is not a failure')
  assert.equal(controller.snapshot().losses, 0, 'a useful life resets the loss streak')
  assert.equal(logger.lines.at(-1).level, 'info', 'reported as normal, not as a warning')
  assert.ok(controller.snapshot().retryPending)

  // And it really does come back.
  timers.at(-1).fn()
  assert.equal(handles.length, 2, 're-acquired after the cap expired')
  assert.equal(controller.snapshot().active, true)
})

test('repeated useful clean exits never escalate', () => {
  // A short maxHours means the cap expires again and again. Every one of those
  // expiries is the feature working, so the ladder must stay clean no matter
  // how many times it happens.
  const logger = recordingLogger()
  const timers = []
  const handles = []
  let clock = 1_000_000
  const controller = createKeepAwakeController({
    platform: 'darwin',
    watchPid: 4242,
    maxHours: 0.001, // ~3.6s cap
    logger,
    spawnImpl: (argv, hooks) => {
      const h = { pid: 900 + handles.length, kill() {}, exited: () => true, hooks }
      handles.push(h)
      return h
    },
    setTimer: (fn, ms) => {
      const t = { fn, ms, unref() {} }
      timers.push(t)
      return t
    },
    clearTimer: () => {},
    now: () => clock,
  })

  controller.enter('a')
  for (let i = 0; i < 6; i += 1) {
    clock += 3600
    handles.at(-1).hooks.onExit({ code: 0, signal: null })
    assert.equal(controller.snapshot().failures, 0, `expiry ${i + 1} stayed clean`)
    timers.at(-1).fn() // re-acquire
  }

  assert.equal(controller.snapshot().active, true, 'still held after 6 expiries')
  assert.equal(
    logger.lines.filter((l) => l.level === 'warn' || l.level === 'error').length,
    0,
    'six useful expiries produced no warnings and no errors',
  )
})

test('a clean exit with a signal is still a failure', () => {
  // `code === 0` only means "on purpose" when nothing killed it.
  const handles = []
  const timers = []
  const controller = createKeepAwakeController({
    platform: 'darwin',
    watchPid: 4242,
    logger: null,
    spawnImpl: (argv, hooks) => {
      const h = { pid: 900 + handles.length, kill() {}, exited: () => true, hooks }
      handles.push(h)
      return h
    },
    setTimer: (fn, ms) => {
      const t = { fn, ms, unref() {} }
      timers.push(t)
      return t
    },
    clearTimer: () => {},
  })

  controller.enter('a')
  handles.at(-1).hooks.onExit({ code: 0, signal: 'SIGTERM' })
  assert.equal(controller.snapshot().failures, 1)
  assert.equal(controller.snapshot().losses, 0)
})

test('an executable that always exits cleanly escalates instead of spinning', () => {
  // `executable: /usr/bin/true` ends cleanly and instantly, forever. Treating
  // that as a normal cap expiry would re-acquire in a tight loop.
  const logger = recordingLogger()
  const timers = []
  const handles = []
  const controller = createKeepAwakeController({
    platform: 'darwin',
    watchPid: 4242,
    logger,
    // A frozen clock: the child "lives" 0ms, which is the pathological case.
    now: () => 1_000_000,
    spawnImpl: (argv, hooks) => {
      const h = { pid: 900 + handles.length, kill() {}, exited: () => true, hooks }
      handles.push(h)
      return h
    },
    setTimer: (fn, ms) => {
      const t = { fn, ms, unref() {} }
      timers.push(t)
      return t
    },
    clearTimer: () => {},
  })

  controller.enter('a')

  // Three instant clean ends are tolerated as "possibly a very short cap"…
  for (let i = 0; i < 3; i += 1) {
    handles.at(-1).hooks.onExit({ code: 0, signal: null })
    timers.at(-1).fn()
  }
  assert.equal(controller.snapshot().failures, 0, 'the first three are treated as normal')
  assert.equal(controller.snapshot().losses, 3)

  // …the fourth escalates, so the retry delay grows instead of staying tight.
  handles.at(-1).hooks.onExit({ code: 0, signal: null })
  assert.equal(controller.snapshot().failures, 1, 'escalated onto the failure ladder')
  assert.equal(controller.snapshot().losses, 0, 'the loss streak is consumed')
  assert.ok(
    logger.lines.some((l) => l.level === 'warn' && /exits immediately/.test(l.text)),
    'the escalation is explained in the log',
  )
  assert.ok(timers.at(-1).ms >= 1000, 'and the delay backed off')
})

test('a later real state change resets the failure budget', () => {
  const timers = []
  const handles = []
  const controller = createKeepAwakeController({
    platform: 'darwin',
    watchPid: 4242,
    logger: null,
    spawnImpl: (argv, hooks) => {
      const h = { pid: 900 + handles.length, kill() {}, exited: () => true, hooks }
      handles.push(h)
      return h
    },
    setTimer: (fn, ms) => {
      const t = { fn, ms, unref() {} }
      timers.push(t)
      return t
    },
    clearTimer: () => {},
  })

  controller.enter('a')
  handles.at(-1).hooks.onError(new Error('boom'))
  assert.equal(controller.snapshot().failures, 1)

  controller.enter('b') // a real state change
  assert.equal(controller.snapshot().failures, 0)
})

test('releasing an already-exited child arms no escalation', () => {
  // A child can exit on its own before we release it (its `exit` event has
  // already landed). Arming a SIGKILL escalation for a dead process would send
  // a signal to a recycled pid in the worst case, and at best leaves a stray
  // timer. The `exited()` check in `terminate` is what prevents that, and this
  // test fails if that check is removed.
  const timers = []
  const procs = []
  const controller = createKeepAwakeController({
    platform: 'darwin',
    watchPid: 4242,
    logger: null,
    spawnImpl: () => {
      const proc = { pid: 700 + procs.length, reported: false, signals: [] }
      procs.push(proc)
      return {
        pid: proc.pid,
        exited: () => proc.reported,
        kill: (signal = 'SIGTERM') => proc.signals.push(signal),
      }
    },
    setTimer: (fn, ms) => {
      const t = { fn, ms, unref() {} }
      timers.push(t)
      return t
    },
    clearTimer: (t) => {
      if (t) t.cleared = true
    },
  })

  controller.enter('a')
  procs[0].reported = true // the exit event already landed

  controller.leave('a')

  assert.deepEqual(procs[0].signals, ['SIGTERM'], 'the release still sent SIGTERM')
  assert.equal(
    timers.filter((t) => t.ms === 2000).length,
    0,
    'no escalation timer for a child that had already exited',
  )
})

test('the failure ladder is exponential and caps at 60s', () => {
  // Pins the exact sequence. Loose bounds (`>= 1000 && <= 60000`) pass even for
  // a constant delay, which is how a mutation removing the exponent or the cap
  // slipped through an earlier version of this suite.
  const timers = []
  const handles = []
  const controller = createKeepAwakeController({
    platform: 'darwin',
    watchPid: 4242,
    logger: null,
    spawnImpl: (argv, hooks) => {
      const h = { pid: 900 + handles.length, kill() {}, exited: () => true, hooks }
      handles.push(h)
      return h
    },
    setTimer: (fn, ms) => {
      const t = { fn, ms, unref() {} }
      timers.push(t)
      return t
    },
    clearTimer: () => {},
  })

  controller.enter('a')
  const delays = []
  for (let i = 0; i < 9; i += 1) {
    handles.at(-1).hooks.onError(new Error(`boom ${i}`))
    delays.push(timers.at(-1).ms)
    timers.at(-1).fn() // retry
  }

  assert.deepEqual(
    delays,
    [1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000, 60_000],
    'doubles each attempt and then holds at the 60s cap',
  )
})

test('a retry never spawns a second live child', () => {
  // The retry must be a no-op if a child is somehow already live, otherwise a
  // timer firing during a live assertion would double up.
  const timers = []
  const handles = []
  const controller = createKeepAwakeController({
    platform: 'darwin',
    watchPid: 4242,
    logger: null,
    spawnImpl: (argv, hooks) => {
      const h = { pid: 900 + handles.length, kill() {}, exited: () => true, hooks }
      handles.push(h)
      return h
    },
    setTimer: (fn, ms) => {
      const t = { fn, ms, unref() {} }
      timers.push(t)
      return t
    },
    clearTimer: () => {},
  })

  controller.enter('a')
  assert.equal(handles.length, 1)

  // Fire every scheduled timer while the first child is still live.
  for (const t of timers) t.fn()
  assert.equal(handles.length, 1, 'no second child while one is already held')
  assert.equal(controller.snapshot().active, true)
})

test('release escalates to SIGKILL when the child ignores SIGTERM', () => {
  // Otherwise a stubborn child keeps the assertion alive while snapshot()
  // cheerfully reports it released.
  const signals = []
  const timers = []
  let dead = false
  const controller = createKeepAwakeController({
    platform: 'darwin',
    watchPid: 4242,
    logger: null,
    spawnImpl: () => ({
      pid: 777,
      kill: (signal = 'SIGTERM') => {
        signals.push(signal)
        // Deliberately ignores SIGTERM.
        if (signal === 'SIGKILL') dead = true
      },
      exited: () => dead,
    }),
    setTimer: (fn, ms) => {
      const t = { fn, ms, unref() {} }
      timers.push(t)
      return t
    },
    clearTimer: () => {},
  })

  controller.enter('a')
  controller.leave('a')

  assert.deepEqual(signals, ['SIGTERM'], 'SIGTERM first')
  const escalation = timers.at(-1)
  assert.ok(escalation, 'an escalation timer was armed')

  escalation.fn()
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'], 'escalated to SIGKILL')
  assert.equal(dead, true)
})

test('release does not escalate when the child dies on SIGTERM', () => {
  const signals = []
  const timers = []
  const controller = createKeepAwakeController({
    platform: 'darwin',
    watchPid: 4242,
    logger: null,
    spawnImpl: (argv, hooks) => ({
      pid: 777,
      kill: (signal = 'SIGTERM') => {
        signals.push(signal)
        // A well-behaved child dies and reports its exit, like the real one.
        hooks.onExit({ code: null, signal: 'SIGTERM' })
      },
      exited: () => true,
    }),
    setTimer: (fn, ms) => {
      const t = { fn, ms, unref() {} }
      timers.push(t)
      return t
    },
    clearTimer: () => {},
  })

  controller.enter('a')
  controller.leave('a')

  assert.deepEqual(signals, ['SIGTERM'])
  // The escalation timer may be armed before the exit lands; firing it must
  // not send a second signal.
  timers.at(-1)?.fn()
  assert.deepEqual(signals, ['SIGTERM'], 'no SIGKILL for a child that already died')
})

test('dispose does not strand a child whose SIGKILL grace is still pending', () => {
  // The leak this guards: `release()` nulls the current child immediately, so
  // if it already ran and its escalation was still pending, a dispose that
  // merely CLEARED that escalation would leave a SIGTERM-ignoring child alive —
  // holding the assertion — while the controller reported everything released.
  //
  // The fix leaves the armed escalation alone so it fires on its own schedule
  // and SIGKILLs the stubborn child. `dispose()` therefore does not kill it
  // instantly; the grace timer still has to elapse. That is the point: killing
  // instantly would also signal a well-behaved child that is merely mid-exit
  // (see the next test).
  const signals = []
  const timers = []
  const procs = []
  const controller = createKeepAwakeController({
    platform: 'darwin',
    watchPid: 4242,
    logger: null,
    spawnImpl: () => {
      const proc = { pid: 700 + procs.length, dead: false, reported: false }
      procs.push(proc)
      return {
        pid: proc.pid,
        exited: () => proc.reported,
        kill: (signal = 'SIGTERM') => {
          signals.push({ pid: proc.pid, signal })
          if (proc.dead) return
          if (signal === 'SIGTERM') return // stubborn: ignores it
          proc.dead = true
          proc.reported = true
        },
      }
    },
    setTimer: (fn, ms) => {
      const t = { fn, ms, unref() {} }
      timers.push(t)
      return t
    },
    clearTimer: (t) => {
      if (t) t.cleared = true
    },
  })

  const live = () => procs.filter((p) => !p.dead).map((p) => p.pid)

  controller.enter('s1')
  controller.leave('s1') // stubborn child #1: SIGTERM ignored, escalation armed
  assert.deepEqual(live(), [700], 'child 1 is still alive awaiting its escalation')

  controller.enter('s2') // child #2 while child 1's escalation is pending
  controller.dispose()

  // The escalation armed for child 1 must still be live (not cancelled).
  const pending = timers.filter((t) => t.ms === 2000 && !t.cleared)
  assert.ok(pending.length > 0, 'child 1 still has an armed escalation after dispose')

  // Fire it, as the event loop would.
  for (const t of pending) t.fn()

  assert.deepEqual(live(), [], 'the stubborn child is killed by its own escalation')
  assert.ok(
    signals.some((s) => s.pid === 700 && s.signal === 'SIGKILL'),
    'child 1 received the SIGKILL that was pending when dispose ran',
  )
})

test('dispose does not send a spurious SIGKILL to a well-behaved child', () => {
  // `exited()` only turns true once the asynchronous `exit` event lands, so a
  // polite child that is mid-exit still reads as alive during its grace window.
  // Force-killing pending escalations at dispose would signal it needlessly.
  const signals = []
  const timers = []
  let reported = false
  const controller = createKeepAwakeController({
    platform: 'darwin',
    watchPid: 4242,
    logger: null,
    spawnImpl: () => ({
      pid: 777,
      exited: () => reported,
      kill: (signal = 'SIGTERM') => {
        signals.push(signal)
        // Well behaved: dies on SIGTERM, but the exit event is asynchronous.
        if (signal === 'SIGTERM') setTimeout(() => { reported = true }, 0)
      },
    }),
    setTimer: (fn, ms) => {
      const t = { fn, ms, unref() {} }
      timers.push(t)
      return t
    },
    clearTimer: (t) => {
      if (t) t.cleared = true
    },
  })

  controller.enter('a')
  controller.leave('a') // SIGTERM sent; child is dying, exit not yet observed
  controller.dispose()

  // The child's exit lands, then the grace timer fires and must see it.
  reported = true
  for (const t of timers.filter((x) => x.ms === 2000 && !x.cleared)) t.fn()

  assert.deepEqual(signals, ['SIGTERM'], 'no spurious SIGKILL for a child that exited')
})

test('an escalation that fires after dispose still kills a stubborn child', () => {
  // The escalation timer must remain functional (not cleared) across dispose,
  // and must be a no-op if the child already exited.
  const signals = []
  const timers = []
  let dead = false
  const controller = createKeepAwakeController({
    platform: 'darwin',
    watchPid: 4242,
    logger: null,
    spawnImpl: () => ({
      pid: 777,
      exited: () => dead,
      kill: (signal = 'SIGTERM') => {
        signals.push(signal)
        if (signal === 'SIGKILL') dead = true
      },
    }),
    setTimer: (fn, ms) => {
      const t = { fn, ms, unref() {} }
      timers.push(t)
      return t
    },
    clearTimer: (t) => {
      if (t) t.cleared = true
    },
  })

  controller.enter('a')
  controller.leave('a') // stubborn: escalation armed
  controller.dispose()

  assert.deepEqual(signals, ['SIGTERM'], 'nothing sent yet — the grace has not elapsed')

  const escalation = timers.find((t) => t.ms === 2000)
  assert.ok(escalation && !escalation.cleared, 'the escalation survived dispose')
  escalation.fn()

  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'], 'and it killed the child')
  assert.equal(dead, true, 'the child really died')

  // Firing it again must not double-signal.
  escalation.fn()
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'], 'no duplicate signal')
})

test('a child that outlives the proof window resets the ladders', () => {
  // Without this, an outage that heals leaves `failures` high and the
  // "still failing" line already logged — so a LATER breakage would be silent.
  const logger = recordingLogger()
  const timers = []
  const handles = []
  const controller = createKeepAwakeController({
    platform: 'darwin',
    watchPid: 4242,
    logger,
    spawnImpl: (argv, hooks) => {
      const h = { pid: 900 + handles.length, kill() {}, exited: () => true, hooks }
      handles.push(h)
      return h
    },
    setTimer: (fn, ms) => {
      const t = { fn, ms, unref() {} }
      timers.push(t)
      return t
    },
    clearTimer: () => {},
  })

  controller.enter('a')

  // Break it enough to log the give-up error.
  for (let i = 0; i < 4; i += 1) {
    handles.at(-1).hooks.onError(new Error(`boom ${i}`))
    timers.at(-1).fn()
  }
  assert.equal(logger.lines.filter((l) => l.level === 'error').length, 1)
  assert.equal(controller.snapshot().failures, 4)

  // Now the cause goes away and the child survives: the proof timer fires.
  // Use the CURRENT child's timer — earlier ones are stale by construction and
  // are correctly ignored (that guard is covered by the next test).
  const proof = timers.filter((t) => t.ms === 5000).at(-1)
  assert.ok(proof, 'a proof timer was armed for the live child')
  proof.fn()

  assert.equal(controller.snapshot().failures, 0, 'the ladder was reset')
  assert.ok(
    logger.lines.some((l) => l.level === 'info' && /healthy/.test(l.text)),
    'and it said so',
  )

  // A fresh breakage is reported again rather than swallowed.
  handles.at(-1).hooks.onError(new Error('broke again'))
  assert.equal(controller.snapshot().failures, 1)
  assert.equal(logger.lines.at(-1).level, 'warn', 'the new failure is visible again')
})

test('a stale proof timer cannot reset a replaced child', () => {
  // This test must FAIL if the generation guard is removed from `armProven`.
  //
  // Getting that right took three attempts, which is worth recording so the
  // test is not "simplified" back into uselessness:
  //
  //   1. Firing the old timer while the new child was LIVE and FAILING did not
  //      discriminate — after a failure the controller has no child, so the
  //      `child === null` early-return masked the missing guard.
  //   2. It also did not discriminate while the new child was live and healthy:
  //      the ladder was already clean, so resetting it changed nothing.
  //
  // What actually discriminates: child 1 fails (dirtying the ladder), child 2
  // spawns and is LIVE, and child 1's stale timer fires. Only the generation
  // guard prevents it from clearing the ladder of a child it does not own.
  const timers = []
  const handles = []
  const controller = createKeepAwakeController({
    platform: 'darwin',
    watchPid: 4242,
    logger: null,
    now: () => 1_000_000,
    spawnImpl: (argv, hooks) => {
      const h = { pid: 900 + handles.length, kill() {}, exited: () => true, hooks }
      handles.push(h)
      return h
    },
    setTimer: (fn, ms) => {
      const t = { fn, ms, unref() {} }
      timers.push(t)
      return t
    },
    clearTimer: (t) => {
      if (t) t.cleared = true
    },
  })

  controller.enter('a')
  const staleProof = timers.find((t) => t.ms === 5000)
  assert.ok(staleProof, 'the first child armed a proof timer')

  // Child 1 fails, dirtying the ladder.
  handles.at(-1).hooks.onError(new Error('child 1 failed'))
  assert.equal(controller.snapshot().failures, 1)

  // The retry brings child 2 up, and it is LIVE and healthy.
  timers.find((t) => t.ms === 1000 && !t.cleared).fn()
  assert.equal(handles.length, 2, 'child 2 is live')
  assert.equal(controller.snapshot().active, true, 'child 2 holds the assertion')

  // Child 1's stale timer fires. Only the generation guard stops it from
  // zeroing the ladder of a child it does not own.
  staleProof.fn()

  assert.equal(
    controller.snapshot().failures,
    1,
    "a stale proof timer must not reset the LIVE child's ladder",
  )
})

test('enabled:false holds nothing', () => {
  const { controller, spawn } = make({ enabled: false })
  controller.enter('a')
  assert.equal(spawn.calls.length, 0)
  assert.equal(controller.snapshot().active, false)
  assert.equal(controller.snapshot().heldCount, 1, 'still tracks the session')
})

test('a non-darwin platform never spawns and warns once', () => {
  const { controller, spawn, logger } = make({ platform: 'linux' })
  controller.enter('a')
  controller.enter('b')
  assert.equal(spawn.calls.length, 0)
  assert.equal(controller.snapshot().supported, false)
  assert.equal(logger.lines.filter((l) => l.level === 'warn').length, 1)
})

test('reconcile ignores non-string and empty ids', () => {
  const { controller } = make()
  controller.reconcile(['a', '', null, undefined, 42, {}])
  assert.deepEqual(controller.snapshot().held, ['a'])
})
