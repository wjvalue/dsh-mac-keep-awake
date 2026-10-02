# dsh-mac-keep-awake

> 中文版见 [README.md](./README.md).

A DeepSeek Harness plugin that keeps the Mac from idle-sleeping while a session is running.

> While any DSH session is running, hold a macOS power assertion so the machine
> does not idle-sleep and interrupt the session.

## What it does

As long as **any one DSH session is running**, the plugin holds one macOS power
assertion (`PreventUserIdleSystemSleep`); **it is released the moment the last session
ends**.

- ✅ While a session runs a long task, the Mac does not idle-sleep and the task is not interrupted
- ✅ The screen **can still turn off as usual** (this uses `caffeinate -i`, not `-i -d`), so a long run does not keep the display lit
- ✅ Multiple sessions hold only one assertion (refcounted by session id)
- ✅ A DSH process crash cannot pin the machine awake forever (see the `-w` note below)

## How it works

The assertion is provided by the child process `caffeinate -i -w <DSH host process pid>`:

| Argument | Effect |
| --- | --- |
| `-i` | Prevents **idle system sleep** only; does **not** prevent the display from turning off |
| `-w <pid>` | When the watched process exits, caffeinate exits by itself — the crash safety net |
| `-d` | (Optional, off by default) also prevents the display from turning off |
| `-t <secs>` | (Optional, off by default) fallback timeout; releases automatically when it expires |

### What happens if the assertion breaks: two ladders, neither is terminal

A child process can end in three ways, and they mean completely different things:

| How it ends | Meaning | Handling |
| --- | --- | --- |
| `error` event / non-zero exit code | The attempt **failed** | Failure ladder |
| Exit code 0, no signal, and it **lived at least 1 second** | A normal end (this is what a `-t` expiry looks like); this round **really did its job** | Zero the counters, re-acquire after 1 second |
| Exit code 0 but it exits **instantly**, 3 times in a row | The executable is broken (for example it points at `/usr/bin/true`) | Escalate to the failure ladder, to avoid spinning |

> Why judge by "how long it lived" instead of the exit code alone: with a very short
> `maxHours`, the `-t` cap expires **repeatedly**. Every one of those is the feature
> working correctly; counting them by number would misjudge a **healthy configuration**
> as a fault after three of them — which is the same class of error as the original
> BUG 1. (I introduced this myself after fixing BUG 1, and then caught it myself.)

The failure ladder is exponential backoff, **capped at 60 seconds**, and **never
terminal**: after more than 3 failures it logs that one error line **once**, then keeps
retrying at the 60-second cadence. That way, even when the cause is temporary (the tool
is not installed yet, or a wrong path was later corrected), the plugin **recovers by
itself** — no state change is needed to trigger it.

> Why not make it "give up": a session still running while the assertion is permanently
> gone is the worst outcome — and in the old implementation `reconcile` was a no-op when
> the set had not changed, so once it gave up it could never come back.
> (This is exactly BUG 1 + BUG 2 as caught during independent verification.)

A child process that survives 5 seconds is recorded as "healthy" and both ladders are
zeroed — otherwise a fault that has already healed would make the plugin stay silent the
**next** time it genuinely breaks. That timer carries a generation check, so a stale
timer cannot mistakenly reset a child process that has already been replaced.

### Release: SIGTERM → 2 seconds → SIGKILL

On release it sends `SIGTERM` first; if exit is not confirmed within 2 seconds it
escalates to `SIGKILL`, avoiding the state where "the controller reports released while
the machine is still pinned awake".

**The handle awaiting escalation is tracked the whole time, not just the timer.**
`release()` nulls `child` immediately, so if only the timer were tracked, then the moment
`dispose()` cleared a pending timer that `SIGTERM`-ignoring child process would **never be
killed**, and the plugin would still afterwards report "everything released".
That is why `escalations` stores `{ handle, timer }`.

> This was the 4th real defect caught by independent verification (the BUG 3 patch did
> not cover the teardown path).

#### `dispose()` does **neither** to pending escalations

After the defect above was found, the first fix was `flushEscalations()`: on dispose,
send an **immediate** `SIGKILL` to any handle that has not confirmed exit. But independent
verification immediately caught a problem with that fix itself — `exited()` only becomes
true once the asynchronous `exit` event lands, so a **well-behaved** child process still
reads as "alive" inside its own grace window and gets a `SIGKILL` it did not deserve
(reproduced 10/10 on the real machine).

So `dispose()` now neither cancels nor force-runs these timers; it **lets them fire on
their own original schedule** (`settleEscalations()` is a deliberate empty
implementation):

- when it fires it **re-checks** `exited()`;
- a well-behaved child process has already exited → no extra signal;
- a `SIGTERM`-ignoring child process still has not exited → `SIGKILL` as usual.

The timers are all `unref()`'d, so they do not hold the process open; and even if the host
exits before they fire, `caffeinate -w <host pid>` is still the last line of defense.

> Both "obvious" implementations are wrong, and both were caught by independent
> verification — this is why the comment inside `settleEscalations()` exists: to stop
> someone from "cleaning it up" back to them later.

### Signals and reconciliation

1. **`agent/status`** — the authoritative per-session running/idle transition, emitted by
   the agent loop itself. The event is agent-scoped, but this plugin is loaded from the
   root level (its context carries no scope tag), and cordis's scope-carrier filter lets
   untagged listeners through, so it is received even without `{ global: true }`.
   The listener **still passes** that option, as cheap insurance: if a future loader ever
   hosts the plugin inside an agent scope, a plain listener would be filtered out while
   one with this option is unaffected. (Empirically verified: re-checked with cordis
   4.0.4 + dsh-scope inside the local app; the host's own api-session-controller /
   compaction-basic / agent-team / subagent listeners do not pass this option either when
   listening to the same events.)
2. **`agent/disposed`** — the fallback release for a session destroyed while still marked
   running (also passes `{ global: true }`, for the same reason as above).
3. **`compaction/start` … `compaction/end` inside `session/event`** — covers the
   `maintenance` blind spot, see below.
4. **Periodic reconciliation against `ctx.agents.list()`** — catches what the events
   cannot cover: a session that was **already running** when the plugin hot-reloaded, or
   an idle transition missed while the fiber was being replaced. Reconciliation is
   authoritative (it replaces the whole set), so it can both acquire and release; it also
   unions in sessions with an open compaction bracket (the registry cannot see those).

> Why reconciliation is mandatory: after a plugin hot reload (`patchReload: live`),
> without reconciliation it would sit idle until the next turn boundary before it could
> possibly acquire the assertion — and "the plugin was just installed" is precisely the
> moment it is needed most.

The count is kept in a `Set` keyed by session id, so repeated `running` for the same
session can never inflate it.

> The Host also broadcasts `api-session/status`, but it is **deliberately not subscribed**:
> it is derived from `agent/status` in the same dispatch, so subscribing would only add a
> code path that can never disagree.

#### The `maintenance` blind spot (covered)

`Agent.status` returns `'idle'` for **both the `idle` and the `maintenance` phase**:

```js
get status() { return this.phase.kind === 'idle' || this.phase.kind === 'maintenance' ? 'idle' : 'running' }
```

And a manual `/compact` is exactly what runs inside `runMaintenance`. **This machine
sleeps after 60 seconds on battery**, so a long compaction treated as idle is a real
sleep window; `agent/status` cannot see it either (it only fires on a status **change**,
and idle→maintenance is not one).

Since there is no public phase accessor, the plugin instead subscribes to the durable
`compaction/start` / `compaction/end` bracket: while the bracket is open it holds the
assertion continuously. Automatic compaction (which runs inside `agent/pre-step`) is
genuinely running already and does not need this; it only fills in for manual `/compact`.

> If a bracket never closes because of a crash: `maxHours` (if configured) or the next
> reconciliation converges it, because reconciliation is authoritative for "sessions that
> are not compacting".

## Configuration

Override the `config` of this row in the profile's `cordis.patch.yml`:

```yaml
- id: keep-awake
  name: 'dsh-mac-keep-awake'
  config:
    enabled: true            # master switch
    preventDisplaySleep: false  # true = the display stays on too (adds -d)
    maxHours: 0              # >0 = fallback timeout (hours); releases automatically when it expires
    reconcileSeconds: 60     # reconcile interval; 0 = reconciliation off
    executable: /usr/bin/caffeinate
```

## Installation

```bash
# 1. Pack and stage it into the profile's vendor/ directory
node scripts/install.mjs

# 2. Install it with the DSH plugin manager (the desktop profile can only be
#    managed by the Electron app)
#    spec: file:vendor/dsh-mac-keep-awake-1.4.1.tgz
```

After installation the bundle's own `cordis.patch.yml` inserts the Host half;
`patchReload: live` means that after editing `src/` you just reinstall for it to take
effect, with no app restart.

## Verification

```bash
node --test test/*.test.js
```

- `test/keep-awake.test.js` — 34 unit tests, with an injected fake spawn and a
  controllable clock, verifying the **counting and ladder logic**: duplicate events,
  interleaved enter/leave, reconcile racing with events, a stale callback cannot
  resurrect a handle, a clean exit (exit code 0) is not counted as a failure, an exit with
  a signal is still a failure, repeated normal expiries do not escalate, an instant clean
  exit does escalate, the failure ladder is not terminal and can heal itself, the health
  timer resets the ladders, a stale health timer does not reset by mistake, SIGTERM not
  working escalates to SIGKILL, **dispose does not miss a child process still inside its
  grace window**, and the non-darwin platform degradation.
- `test/wiring.test.js` — 15 wiring tests, using a fake cordis ctx to verify `index.js`:
  the `{ global: true }` regression guard (verifying every agent event is registered
  exactly once and with that option), immediate acquisition for an already-running session
  on hot reload, a malformed payload does not throw, the assertion is still held during a
  manual `/compact`, reconciliation does not drop an open compaction bracket, a session
  destroyed mid-compaction does not pin the machine awake forever, and "never leaves a
  caffeinate process behind".
- `test/integration.pmset.test.js` — 2 **real-machine** tests that read the kernel ledger
  `pmset -g assertions` directly: the assertion really appears, there really is only one,
  and it really disappears when the last session ends; plus caffeinate exiting by itself
  after the watched process is `SIGKILL`ed.

To confirm the real-machine state by hand:

```bash
pmset -g assertions | grep -A2 caffeinate
#   pid 89135(caffeinate): ... PreventUserIdleSystemSleep named: "caffeinate command-line tool"
#       Details: caffeinate asserting on behalf of Process ID 87704
pgrep -fl "caffeinate -i -w"
```

Run it again after the session finishes, and it should output **nothing at all**.

## Platform support

macOS only (`caffeinate` is a macOS-specific tool). On other platforms the plugin loads
normally but only logs one warning, holds no assertion, and raises no error — it will not
keep DSH from starting.

## Layout

```
index.js                      # Host half: event wiring, reconcile loop, Config
src/keep-awake.js             # Refcounted controller (pure logic, injectable)
test/keep-awake.test.js       # Controller unit tests (fake spawn)
test/wiring.test.js           # index.js wiring tests (fake cordis ctx + real pmset)
test/integration.pmset.test.js# Real-machine pmset integration tests
cordis.patch.yml              # Bundle patch: one insert row mounts the Host half
scripts/install.mjs           # Pack + stage into the profile vendor/
```

## License

MIT
