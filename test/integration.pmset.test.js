/**
 * Integration test — the real thing, on real macOS power assertions.
 *
 * Unit tests prove the counting; this proves the *effect*. It spawns the real
 * `/usr/bin/caffeinate` and reads the kernel's own ledger with
 * `pmset -g assertions`, so a passing run means macOS really is being held
 * awake — not that a mock was called.
 *
 * Skipped automatically on anything that is not darwin.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync, spawn } from 'node:child_process'
import { createKeepAwakeController } from '../src/keep-awake.js'

const isDarwin = process.platform === 'darwin'

/**
 * Parse `pmset -g assertions` into the caffeinate assertions it currently lists.
 *
 * A block looks like:
 *   pid 88960(caffeinate): [0x...] 00:00:00 PreventUserIdleSystemSleep named: "..."
 *       Details: caffeinate asserting on behalf of Process ID 88954
 *       Created for PID: 88954.
 *
 * @returns {{ pid: number, type: string, behalfOf: number|undefined }[]}
 */
function caffeinateAssertions() {
  const out = execFileSync('/usr/bin/pmset', ['-g', 'assertions'], { encoding: 'utf8' })
  const blocks = out.split(/^(?=\s*pid \d+\()/m)
  const found = []
  for (const block of blocks) {
    const head = /pid (\d+)\(caffeinate\):.*?\s(\w+)\s+named:/.exec(block)
    if (!head) continue
    const behalf = /Process ID (\d+)/.exec(block)
    found.push({
      pid: Number(head[1]),
      type: head[2],
      behalfOf: behalf ? Number(behalf[1]) : undefined,
    })
  }
  return found
}

/** Assertions held on behalf of one process, by type. */
function heldFor(pid) {
  return caffeinateAssertions().filter((a) => a.behalfOf === pid)
}

/** Poll until `check()` is truthy, or fail with a useful message. */
async function eventually(check, description, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = check()
    if (last) return last
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.fail(`timed out after ${timeoutMs}ms waiting for: ${description}`)
}

test('macOS really publishes and drops the assertion (pmset)', { skip: !isDarwin }, async (t) => {
  const pid = process.pid
  const controller = createKeepAwakeController({ watchPid: pid, platform: 'darwin' })

  t.after(() => {
    controller.dispose()
  })

  // Nothing held before we start.
  assert.deepEqual(heldFor(pid), [], 'no assertion before any session runs')

  // ── 1. A running session holds exactly PreventUserIdleSystemSleep ────────
  controller.enter('session-1')
  const first = await eventually(
    () => (heldFor(pid).length > 0 ? heldFor(pid) : null),
    'an assertion for a running session',
  )
  assert.equal(first.length, 1, 'exactly one assertion')
  assert.equal(
    first[0].type,
    'PreventUserIdleSystemSleep',
    'the system is held awake; the display is NOT (that is the -i contract)',
  )
  assert.ok(
    !first.some((a) => a.type === 'PreventUserIdleDisplaySleep'),
    'no display assertion, so the screen may still turn off',
  )

  const snapshot = controller.snapshot()
  assert.equal(snapshot.active, true)
  assert.equal(snapshot.caffeinatePid, first[0].pid, 'the plugin knows the real child pid')

  // ── 2. A second session does not double up ──────────────────────────────
  controller.enter('session-2')
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(heldFor(pid).length, 1, 'still exactly one assertion for two sessions')

  // ── 3. The assertion outlives the first session ─────────────────────────
  controller.leave('session-1')
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(heldFor(pid).length, 1, 'held while one session still runs')

  // ── 4. …and is dropped with the last one ────────────────────────────────
  controller.leave('session-2')
  await eventually(() => heldFor(pid).length === 0, 'the assertion to be released')
  assert.equal(controller.snapshot().active, false)
})

test('a crashed host cannot leave the machine pinned awake', { skip: !isDarwin }, async () => {
  // `caffeinate -w <pid>` is the crash-safety net. Prove it by watching a
  // process we deliberately kill: caffeinate must exit on its own, without
  // anyone signalling it.
  const host = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' })
  await new Promise((resolve) => setTimeout(resolve, 200))

  const controller = createKeepAwakeController({ watchPid: host.pid, platform: 'darwin' })
  controller.enter('session-1')
  await eventually(() => heldFor(host.pid).length === 1, 'the assertion to appear')
  const caffeinatePid = heldFor(host.pid)[0].pid

  // The "host" dies without releasing anything.
  host.kill('SIGKILL')
  await new Promise((resolve) => setTimeout(resolve, 100))

  await eventually(
    () => heldFor(host.pid).length === 0,
    'caffeinate to exit by itself once the watched process is gone',
  )

  // And the process is genuinely gone, not merely unlisted.
  assert.throws(
    () => process.kill(caffeinatePid, 0),
    /ESRCH/,
    'the caffeinate process exited rather than lingering',
  )

  controller.dispose()
})
