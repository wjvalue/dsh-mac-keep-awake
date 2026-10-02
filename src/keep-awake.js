/**
 * dsh-mac-keep-awake — the assertion controller (pure logic, no cordis, no Electron).
 *
 * One job: while at least one DSH session is *running*, hold exactly one macOS
 * power assertion so the machine does not idle-sleep; the moment the last one
 * stops, drop it.
 *
 * The assertion is a child `caffeinate -i -w <host pid>`:
 *
 *   - `-i` prevents *idle system sleep* only. The display is still allowed to
 *     turn off, so a long session never lights up the room — which is exactly
 *     the requested behaviour ("don't let 息屏 break my session").
 *   - `-w <pid>` makes caffeinate exit by itself when the host process dies.
 *     That is the crash-safety net: a leaked caffeinate can never pin the
 *     machine awake forever, because the process it watches is gone.
 *
 * Reference counting is by session id, in a Set, so repeated/duplicated signals
 * for the same session (the host emits both `agent/status` and
 * `api-session/status`) can never inflate the count.
 *
 * ## Two ladders, and why neither is terminal
 *
 * A child can end in three ways, and they mean different things:
 *
 *   - `error`, or an exit with a non-zero code → the attempt *failed*.
 *   - a clean exit (code 0) → the attempt *succeeded and ended*. That is
 *     normal when `maxHours` is set: `caffeinate -t N` is designed to exit 0
 *     when the cap expires. Counting that as a failure used to walk the
 *     give-up ladder to its end while a session was still running, and
 *     `reconcile` could not recover because the held set had not changed.
 *   - a clean exit that happens *immediately*, every time → pathological
 *     (e.g. `executable: /usr/bin/true`). Treating that as normal would spin.
 *
 * So: clean exits re-acquire on a short fixed delay and are counted
 * separately; repeated immediate clean exits escalate onto the failure ladder,
 * which is what stops the spin. Both ladders back off exponentially and are
 * capped at {@link RETRY_MAX_MS}, and neither is ever permanently terminal —
 * a broken executable keeps being retried at a slow cadence, so the plugin
 * heals itself if the cause goes away. The loud error is logged once.
 *
 * ## Why a generation counter
 *
 * `spawn` can fail synchronously (throw), asynchronously (`error` event), or
 * after we deliberately killed the child (`exit` event). Only the first two are
 * failures. A monotonically increasing `generation` marks which attempt owns
 * the current assertion, so a stale callback can never resurrect a handle that
 * has already been released or replaced.
 *
 * @module src/keep-awake.js
 */

import { spawn } from 'node:child_process'

/** The macOS tool that publishes `PreventUserIdleSystemSleep`. */
export const DEFAULT_EXECUTABLE = '/usr/bin/caffeinate'

/** How many failures before the "still failing" line is logged as an error. */
const MAX_CONSECUTIVE_FAILURES = 3

/** First rung of the failure ladder. */
const RETRY_BASE_MS = 1000

/** Ceiling for both ladders: slow enough to be harmless, fast enough to heal. */
const RETRY_MAX_MS = 60_000

/** Delay before re-acquiring after a normal (clean) end of the assertion. */
const LOSS_RETRY_MS = 1000

/** Consecutive immediate clean exits before they are treated as a failure. */
const MAX_LOSSES = 3

/**
 * How long a clean-exiting child must have lived to count as *useful work*.
 *
 * This is what distinguishes the two kinds of clean exit. A child that held the
 * assertion for a while and then ended on purpose (a `-t` cap expiring) did its
 * job; the streak resets. A child that ends in milliseconds held nothing, and a
 * run of those is a broken executable rather than a cap doing its work.
 *
 * Without the lifetime check, repeated short-but-real expiries would accumulate
 * `losses` and eventually escalate a perfectly healthy configuration.
 */
const MIN_USEFUL_MS = 1000

/** How long to wait for SIGTERM to land before escalating to SIGKILL. */
const KILL_GRACE_MS = 2000

/**
 * How long a child must survive to be considered *working*.
 *
 * This is what separates "the executable is fine" from "the executable exits
 * instantly": a healthy caffeinate outlives this easily, while `/usr/bin/true`
 * never reaches it. Once a child passes it, the ladders reset — so a transient
 * outage that heals does not leave the plugin stuck in a "still failing" state
 * where it would stay silent if it broke again.
 */
const PROVEN_MS = 5000

/**
 * Spawn the real caffeinate. Kept separate so tests can inject a fake.
 *
 * `unref()` is deliberate: the assertion must never be a reason for the host
 * process to stay alive. Its lifetime is bounded by `-w <host pid>` instead.
 *
 * @param {string[]} argv - argv[0] is the executable.
 * @param {{ onError?: (error: Error) => void, onExit?: (outcome: { code: number|null, signal: string|null }) => void }} hooks
 * @returns {{ pid: number|undefined, kill: (signal?: string) => void, exited: () => boolean }}
 */
export function spawnCaffeinate(argv, hooks = {}) {
  const child = spawn(argv[0], argv.slice(1), { stdio: 'ignore', detached: false })
  let gone = false
  child.on('error', (error) => {
    gone = true
    hooks.onError?.(error)
  })
  child.on('exit', (code, signal) => {
    gone = true
    hooks.onExit?.({ code, signal })
  })
  child.unref?.()
  return {
    pid: child.pid,
    kill: (signal = 'SIGTERM') => {
      try {
        child.kill(signal)
      } catch {
        /* already gone */
      }
    },
    exited: () => gone,
  }
}

/**
 * Create the refcounted assertion controller.
 *
 * @param {object} [options]
 * @param {string}   [options.executable]          caffeinate path
 * @param {boolean}  [options.preventDisplaySleep] also pass `-d` (display stays on)
 * @param {number}   [options.maxHours]            safety cap via `-t`; 0 = uncapped
 * @param {boolean}  [options.enabled]             master switch
 * @param {number}   [options.watchPid]            the process caffeinate watches (`-w`)
 * @param {string}   [options.platform]            injected for tests
 * @param {Function} [options.spawnImpl]           injected for tests
 * @param {object}   [options.logger]              anything with info/warn/error
 * @param {Function} [options.setTimer]
 * @param {Function} [options.clearTimer]
 * @param {Function} [options.now]
 */
export function createKeepAwakeController(options = {}) {
  const {
    executable = DEFAULT_EXECUTABLE,
    preventDisplaySleep = false,
    maxHours = 0,
    enabled = true,
    watchPid = typeof process === 'undefined' ? 0 : process.pid,
    platform = typeof process === 'undefined' ? 'unknown' : process.platform,
    spawnImpl = spawnCaffeinate,
    logger = null,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    now = Date.now,
  } = options

  const supported = platform === 'darwin'

  /** Session ids currently believed to be running. */
  const held = new Set()
  /** The live caffeinate handle, or null when no assertion is held. */
  let child = null
  /** Identifies the attempt that owns `child`; bumped on every acquire/release. */
  let generation = 0
  /** Consecutive genuine failures (spawn error / non-zero exit). */
  let failures = 0
  /** Consecutive normal-but-immediate ends, which escalate into failures. */
  let losses = 0
  /** Whether the loud "still failing" line has been logged for this streak. */
  let gaveUpLogged = false
  let retryTimer = null
  /**
   * SIGKILL escalation timers for children that have NOT yet confirmed exit.
   *
   * A set, not a single slot: a stubborn child released earlier can still be
   * awaiting its escalation when a later child is released, and both must be
   * tracked.
   *
   * Both obvious teardown policies are wrong, which is why `dispose()` neither
   * cancels nor force-runs these — see `settleEscalations()`:
   *
   *   - cancelling them strands a SIGTERM-ignoring child alive, holding the
   *     assertion, while the controller reports everything released;
   *   - force-running them SIGKILLs a polite child that is merely mid-exit,
   *     because `exited()` lags the asynchronous `exit` event.
   *
   * Leaving each timer to fire on its own schedule is correct for both: it
   * re-checks `exited()` when it fires.
   */
  const escalations = new Set()
  /** Timer that marks the current child as proven-working. */
  let provenTimer = null
  let disposed = false
  let acquiredAt = 0
  let acquisitions = 0
  let warnedUnsupported = false

  const needed = () => enabled && !disposed && held.size > 0

  /** The exact argv for one assertion. */
  function assertionArgv() {
    const argv = [executable, '-i']
    if (preventDisplaySleep) argv.push('-d')
    if (maxHours > 0) argv.push('-t', String(Math.round(maxHours * 3600)))
    // `-w` last and always present: it is what makes an orphan impossible.
    argv.push('-w', String(watchPid))
    return argv
  }

  function clearRetry() {
    if (retryTimer !== null) {
      clearTimer(retryTimer)
      retryTimer = null
    }
  }

  function clearProven() {
    if (provenTimer !== null) {
      clearTimer(provenTimer)
      provenTimer = null
    }
  }

  /**
   * Mark the current child as working once it has outlived {@link PROVEN_MS}.
   *
   * Without this, a transient outage that heals leaves `failures` at its old
   * value and `gaveUpLogged` set — so if the tool broke again the plugin would
   * stay silent instead of saying so.
   */
  function armProven(gen) {
    clearProven()
    provenTimer = setTimer(() => {
      provenTimer = null
      if (gen !== generation || child === null) return
      if (failures > 0 || losses > 0 || gaveUpLogged) {
        logger?.info?.(
          `[keep-awake] the assertion has been healthy for ${PROVEN_MS}ms; resetting the retry ladders`,
        )
      }
      failures = 0
      losses = 0
      gaveUpLogged = false
    }, PROVEN_MS)
    provenTimer?.unref?.()
  }

  function scheduleRetry(delayMs, reason) {
    clearRetry()
    retryTimer = setTimer(() => {
      retryTimer = null
      if (needed() && child === null) acquire(reason)
    }, delayMs)
    retryTimer?.unref?.()
  }

  /** The failure ladder: exponential, capped, never terminal. */
  function failureDelay() {
    return Math.min(RETRY_BASE_MS * 2 ** (failures - 1), RETRY_MAX_MS)
  }

  function acquire(reason) {
    if (child !== null || disposed || !supported) return
    // Bumping here is belt-and-braces: `onEnd` and `release` already bump on
    // every path that ends an attempt, so removing this line is not observable
    // (verified by mutation — every scenario behaves identically). It stays
    // because it makes the invariant local and obvious: each attempt owns a
    // generation no other attempt can match.
    const gen = ++generation
    const argv = assertionArgv()

    /**
     * Handle the end of *this* attempt. Stale attempts return immediately.
     *
     * `kind` separates the two meanings of a child ending:
     *   - 'failure' — spawn error, or a non-zero exit.
     *   - 'clean'   — exit code 0 with no signal, which is how a `-t` cap
     *                 expires on purpose. Not a failure; re-acquire shortly.
     */
    const onEnd = (kind, detail) => {
      if (gen !== generation) return
      generation += 1
      clearProven()
      // Capture the lifetime BEFORE clearing it: a clean exit is judged by how
      // long the child actually served.
      const livedMs = acquiredAt === 0 ? 0 : now() - acquiredAt
      child = null
      acquiredAt = 0
      if (!needed()) return

      if (kind === 'clean') {
        // Did this child actually hold anything, or did it vanish instantly?
        // A short-but-real life means the cap did its job; reset the streak.
        if (livedMs >= MIN_USEFUL_MS) {
          losses = 0
          logger?.info?.(
            `[keep-awake] assertion ended on its own after ${Math.round(livedMs / 1000)}s of ` +
              `service (a -t cap expiring); re-acquiring in ${LOSS_RETRY_MS}ms`,
            detail,
          )
          scheduleRetry(LOSS_RETRY_MS, 're-acquire')
          return
        }
        losses += 1
        if (losses <= MAX_LOSSES) {
          // Ended instantly, but not yet a pattern — could be a very short cap.
          logger?.info?.(
            `[keep-awake] assertion ended on its own after ${livedMs}ms; ` +
              `re-acquiring in ${LOSS_RETRY_MS}ms`,
            detail,
          )
          scheduleRetry(LOSS_RETRY_MS, 're-acquire')
          return
        }
        // Ending instantly, over and over: that is a broken executable, not a
        // cap expiring. Escalate onto the failure ladder to stop the spin.
        losses = 0
        logger?.warn?.(
          `[keep-awake] executable exits immediately and cleanly ${MAX_LOSSES} times in a row; ` +
            `treating it as a failure`,
          detail,
        )
      }

      failures += 1
      const delay = failureDelay()
      if (failures > MAX_CONSECUTIVE_FAILURES) {
        if (!gaveUpLogged) {
          gaveUpLogged = true
          logger?.error?.(
            `[keep-awake] ${MAX_CONSECUTIVE_FAILURES}+ failed attempts; the machine may ` +
              `idle-sleep during running sessions. Still retrying, backing off to ` +
              `${Math.round(RETRY_MAX_MS / 1000)}s.`,
            detail,
          )
        }
      } else {
        logger?.warn?.(`[keep-awake] assertion attempt ${failures} failed; retrying in ${delay}ms`, detail)
      }
      scheduleRetry(delay, 'retry')
    }

    let handle
    try {
      handle = spawnImpl(argv, {
        onError: (error) => onEnd('failure', error),
        onExit: ({ code, signal }) =>
          code === 0 && !signal ? onEnd('clean', { code, signal }) : onEnd('failure', { code, signal }),
      })
    } catch (error) {
      onEnd('failure', error)
      return
    }
    // A synchronous failure already bumped the generation: do not adopt it.
    if (gen !== generation) return
    child = handle
    acquiredAt = now()
    acquisitions += 1
    armProven(gen)
    logger?.info?.(
      `[keep-awake] holding PreventUserIdleSystemSleep (${reason}); ` +
        `argv=${JSON.stringify(argv)} sessions=${held.size}`,
    )
  }

  /**
   * Stop one child, escalating to SIGKILL if it does not confirm exit.
   *
   * The handle is tracked until it reports exit, so a later `dispose()` can
   * still escalate it. Cancelling a pending escalation instead of running it
   * would strand the child alive holding the assertion — exactly the state this
   * whole mechanism exists to prevent.
   */
  function terminate(handle, reason) {
    try {
      handle.kill('SIGTERM')
    } catch (error) {
      logger?.warn?.('[keep-awake] could not stop caffeinate', error)
    }
    if (typeof handle.exited !== 'function' || handle.exited()) {
      logger?.info?.(`[keep-awake] released the sleep assertion (${reason})`)
      return
    }
    const pending = { handle, timer: null }
    pending.timer = setTimer(() => {
      escalations.delete(pending)
      if (!handle.exited()) {
        logger?.warn?.('[keep-awake] caffeinate ignored SIGTERM; sending SIGKILL')
        try {
          handle.kill('SIGKILL')
        } catch {
          /* gone between the check and the signal */
        }
      }
    }, KILL_GRACE_MS)
    pending.timer?.unref?.()
    escalations.add(pending)
    logger?.info?.(`[keep-awake] released the sleep assertion (${reason})`)
  }

  function release(reason) {
    const handle = child
    if (handle === null) return
    // Invalidate first, so the exit this causes is never read as a failure.
    generation += 1
    clearProven()
    child = null
    acquiredAt = 0
    terminate(handle, reason)
  }

  /**
   * Leave every pending escalation armed so it fires on its own schedule.
   *
   * Called by `dispose()`. This is deliberately a no-op beyond clearing the
   * current child, because both of the "obvious" alternatives are wrong:
   *
   *   - **Cancelling** the pending escalations strands a SIGTERM-ignoring child
   *     alive, holding the assertion, while the controller reports everything
   *     released. That was a real bug found in verification.
   *   - **Force-killing immediately** sends a spurious SIGKILL to a
   *     well-behaved child that is merely mid-exit: `exited()` only turns true
   *     once the asynchronous `exit` event lands, so a polite child still reads
   *     as alive during its own grace window. Also found in verification.
   *
   * Letting the armed timers run is correct for both: each one re-checks
   * `exited()` when it fires, so a child that died on SIGTERM is left alone and
   * a stubborn one is still SIGKILLed. The timers are unref'd, so they never
   * hold the process open, and `caffeinate -w <host pid>` remains the backstop
   * if the host exits before they fire.
   */
  function settleEscalations() {
    // Intentionally empty: see the note above. Kept as a named seam so the
    // decision is documented where dispose() reads it, and so the reasoning is
    // not silently "cleaned up" into the buggy alternatives later.
  }

  /** Bring the live assertion in line with the running-session set. */
  function sync(reason = 'sync') {
    if (!supported) {
      if (needed() && !warnedUnsupported) {
        warnedUnsupported = true
        logger?.warn?.(
          `[keep-awake] platform "${platform}" is not supported; sessions keep running, ` +
            `but no sleep assertion is held`,
        )
      }
      return
    }
    if (needed() && child === null) acquire(reason)
    else if (!needed() && child !== null) release(reason)
  }

  /**
   * Reset both ladders — a real state change deserves a fresh budget.
   *
   * Deliberately does NOT touch the proven-timer: that timer only zeroes these
   * same fields, so cancelling it here would just lose the health tracking for
   * a still-live child. A stale timer from a replaced child returns early on
   * its generation check.
   */
  function resetLadders() {
    failures = 0
    losses = 0
    gaveUpLogged = false
    clearRetry()
  }

  return {
    /**
     * A session entered the running state. Idempotent per id.
     *
     * The `disposed` check here is redundant with `needed()` inside `sync`, and
     * mutation testing confirms it: removing it changes nothing observable,
     * because a disposed controller can never spawn. It is kept for a different
     * reason — a disposed controller should not accumulate session ids it will
     * never act on, and reading `enter` alone should make the "no work after
     * dispose" contract obvious without tracing into `sync`.
     *
     * The `held.has` check is likewise an *equivalent mutant* for the count:
     * `Set.add` dedupes, so repeated `enter` for one session still yields one
     * held id and one spawn either way. What it actually prevents is
     * `resetLadders()` running on every duplicate signal — the host can emit
     * several `running` notifications for one session, and each would otherwise
     * wipe a live child's retry backoff.
     */
    enter(sessionId) {
      if (disposed || typeof sessionId !== 'string' || sessionId === '') return
      if (held.has(sessionId)) return
      held.add(sessionId)
      resetLadders()
      sync('session running')
    },

    /**
     * A session left the running state. Idempotent per id.
     *
     * `Set.delete` is already idempotent, so the membership check is not what
     * makes a repeated `leave` safe — it is what keeps `resetLadders()` from
     * running on a no-op. That matters: a spurious `leave` for an unknown id
     * would otherwise clear the retry ladder of a live, struggling child.
     */
    leave(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return
      if (!held.delete(sessionId)) return
      resetLadders()
      sync('session idle')
    },

    /**
     * Replace the whole held set — the periodic reconciliation with the live
     * agent registry. Authoritative, so a missed event cannot leak an
     * assertion and a stale one cannot survive.
     *
     * @param {Iterable<string>} sessionIds
     */
    reconcile(sessionIds) {
      if (disposed) return
      const next = new Set()
      for (const id of sessionIds) {
        if (typeof id === 'string' && id !== '') next.add(id)
      }
      let changed = next.size !== held.size
      if (!changed) {
        for (const id of next) {
          if (!held.has(id)) {
            changed = true
            break
          }
        }
      }
      if (!changed) return
      held.clear()
      for (const id of next) held.add(id)
      resetLadders()
      sync('reconciled with the live registry')
    },

    sync,

    snapshot() {
      return {
        supported,
        enabled,
        active: child !== null,
        caffeinatePid: child?.pid ?? null,
        watchPid,
        heldCount: held.size,
        held: [...held],
        acquiredAt,
        acquisitions,
        failures,
        losses,
        retryPending: retryTimer !== null,
      }
    },

    dispose() {
      if (disposed) return
      disposed = true
      clearRetry()
      clearProven()
      held.clear()
      // Releases the current child, which arms its SIGKILL escalation if it
      // does not confirm exit. Escalations armed by EARLIER releases are left
      // running on purpose — see `settleEscalations` for why cancelling them
      // leaks a stubborn child and why force-killing them is spurious.
      release('plugin disposed')
      settleEscalations()
    },
  }
}
