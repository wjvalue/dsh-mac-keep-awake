/**
 * dsh-mac-keep-awake — plugin entry (Host half).
 *
 * Keeps macOS from idle-sleeping while a DSH session is working, so a long
 * agent turn is never interrupted by the machine going to sleep. The display
 * is still allowed to turn off (that is `caffeinate -i`, not `-i -d`).
 *
 * ## How it decides
 *
 * Two signals feed one refcounted controller:
 *
 *  1. `agent/status` — the authoritative per-session running/idle transition,
 *     emitted by the agent loop itself. The listener passes `{ global: true }`
 *     as cheap insurance: on cordis 4.0.4 a root-loaded (untagged) plugin
 *     receives agent-scoped events either way, but the option keeps this
 *     working if the loader ever starts hosting plugins inside agent scopes.
 *     The same applies to `agent/disposed`, which releases a session that is
 *     torn down while still marked running.
 *  2. A periodic reconciliation against `ctx.agents.list()` — the safety net
 *     for everything the events cannot cover: a session that was already
 *     running when this plugin hot-reloaded, or an `idle` transition missed
 *     while the fiber was being replaced. Reconciliation is authoritative and
 *     replaces the whole set, so it can both acquire and release.
 *
 * The Host's `api-session/status` broadcast is deliberately NOT subscribed: it
 * is derived from `agent/status` in the same dispatch (`ctx.emit('api-session/status',
 * agent.id, status === 'running')`), so it would add a second code path for
 * zero extra information. The controller keys on session id in a Set, so even
 * a duplicate signal is harmless — but redundancy that cannot ever differ is
 * just another thing to keep correct.
 *
 * Without signal 3 a plugin loaded mid-session would sit idle until the next
 * turn boundary, which is precisely the case a hot-reloaded plugin is in.
 *
 * ## Why a child process instead of an in-process API
 *
 * Electron's `powerSaveBlocker` would need the Electron main process, and a
 * DSH Host plugin runs in the host Node process, not in Electron. `caffeinate`
 * is the documented macOS command-line spelling of the same assertion, and
 * `pmset -g assertions` makes it externally observable — which is what makes
 * this testable at all.
 *
 * @module index.js
 */

import z from '@deepseek-ai/schemastery'
import { createKeepAwakeController, DEFAULT_EXECUTABLE } from './src/keep-awake.js'

export const name = 'dsh-mac-keep-awake'

/**
 * `agents` is the only hard dependency: it is both the source of truth for
 * reconciliation and the thing that makes "is any session running?" answerable
 * at load time. Everything else is reached opportunistically.
 */
export const inject = ['agents']

export const Config = z.object({
  enabled: z.boolean().default(true).description('Master switch for the whole plugin.'),
  preventDisplaySleep: z
    .boolean()
    .default(false)
    .description('Also keep the display on (adds `-d`). Off by default: the screen may still turn off.'),
  maxHours: z
    .number()
    .default(0)
    .description('Safety cap in hours after which the assertion self-expires. 0 disables the cap.'),
  reconcileSeconds: z
    .number()
    .default(60)
    .description('How often to reconcile the held set against the live agent registry. 0 disables it.'),
  executable: z.string().default(DEFAULT_EXECUTABLE).description('Path to the caffeinate binary.'),
})

/**
 * Every session id the live registry currently knows about, running or not.
 *
 * Defensive on purpose: a registry shape change must degrade to "no sessions"
 * rather than throw inside a timer and take the plugin down.
 *
 * @param {object} agentsService - `ctx.agents`
 * @returns {string[]}
 */
function liveSessionIds(agentsService) {
  try {
    const agents = agentsService?.list?.() ?? []
    const ids = []
    for (const agent of agents) {
      if (agent && typeof agent.id === 'string' && agent.id !== '') ids.push(agent.id)
    }
    return ids
  } catch {
    return []
  }
}

/**
 * The subset of live sessions that are genuinely `running`.
 *
 * ## The `maintenance` blind spot
 *
 * `Agent.status` is `'idle'` for BOTH the `idle` and the `maintenance` phase
 * (`this.phase.kind === 'idle' || this.phase.kind === 'maintenance' ? 'idle' :
 * 'running'`). `maintenance` is what `runMaintenance` holds while it runs a job
 * on an otherwise idle agent — and manual `/compact` is exactly such a job.
 *
 * That matters here: on battery this machine sleeps after 1 minute of idle, so
 * a long compaction that reports `idle` would be a real sleep window. The
 * `agent/status` event cannot see the difference either — it only fires on a
 * status *change*, and idle→maintenance is not one.
 *
 * There is no public accessor for the phase, so this cannot be fixed by reading
 * a different property. The mitigation is the `compaction/start` /
 * `compaction/end` bracket observed through `session/event` in `apply()`: while
 * a compaction bracket is open, the session is held regardless of what its
 * status says. Automatic mid-turn compaction never needs this (the agent is
 * genuinely `running` inside `agent/pre-step`), so the bracket only ever adds
 * coverage for the manual case.
 *
 * @param {object} agentsService - `ctx.agents`
 * @returns {string[]}
 */
function runningSessionIds(agentsService) {
  try {
    const agents = agentsService?.list?.() ?? []
    const ids = []
    for (const agent of agents) {
      if (!agent || typeof agent.id !== 'string') continue
      if (agent.status === 'running') ids.push(agent.id)
    }
    return ids
  } catch {
    return []
  }
}

export function apply(ctx, config = {}) {
  const logger = ctx.logger ?? console
  const platform = process.platform

  const controller = createKeepAwakeController({
    executable: config.executable ?? DEFAULT_EXECUTABLE,
    preventDisplaySleep: config.preventDisplaySleep ?? false,
    maxHours: config.maxHours ?? 0,
    enabled: config.enabled ?? true,
    watchPid: process.pid,
    platform,
    logger,
  })

  ctx.effect(() => () => controller.dispose(), 'dsh-mac-keep-awake: assertion')

  if (platform !== 'darwin') {
    logger.warn?.(
      `[keep-awake] platform "${platform}" has no caffeinate; the plugin stays loaded but holds nothing`,
    )
    return
  }

  // 1: the authoritative per-session running/idle transition, plus the teardown
  // edge for a session disposed while still marked running.
  //
  // `compacting` is declared first because BOTH the teardown handler below and
  // the reconcile loop must be able to see it: a session disposed mid-compaction
  // would otherwise stay in the set, and the next reconcile — which unions the
  // set in — would resurrect the assertion for a session that no longer exists.
  const compacting = new Set()

  ctx.effect(
    () =>
      ctx.on(
        'agent/status',
        ({ agent, status }) => {
          if (!agent || typeof agent.id !== 'string') return
          if (status === 'running') controller.enter(agent.id)
          else controller.leave(agent.id)
        },
        { global: true },
      ),
    'dsh-mac-keep-awake: agent/status',
  )

  ctx.effect(
    () =>
      ctx.on(
        'agent/disposed',
        ({ agent }) => {
          if (!agent || typeof agent.id !== 'string') return
          // Hygiene, not correctness: `controller.leave` below already releases
          // the assertion, and the reconcile prune would drop the bracket too.
          // This just keeps the Set from growing stale ids without bound when
          // the reconcile loop is configured off (`reconcileSeconds: 0`).
          compacting.delete(agent.id)
          controller.leave(agent.id)
        },
        { global: true },
      ),
    'dsh-mac-keep-awake: agent/disposed',
  )

  // 2: cover the `maintenance` blind spot.
  //
  // A manual `/compact` runs inside `runMaintenance`, where `Agent.status`
  // reports `'idle'` even though real work is happening — and on battery this
  // machine sleeps after 60s. The durable `compaction/start` … `compaction/end`
  // bracket is the only observable edge for that window. A bracket that never
  // closes is bounded by `maxHours`, by `agent/disposed`, or by the next
  // reconcile once the session leaves the registry.
  ctx.effect(
    () =>
      ctx.on(
        'session/event',
        (session, event) => {
          const id = session?.id
          if (typeof id !== 'string') return
          if (event?.type === 'compaction/start') {
            compacting.add(id)
            controller.enter(id)
          } else if (event?.type === 'compaction/end') {
            compacting.delete(id)
            // Only release if the agent is not also genuinely running.
            if (!runningSessionIds(ctx.get('agents')).includes(id)) controller.leave(id)
          }
        },
        { global: true },
      ),
    'dsh-mac-keep-awake: compaction bracket',
  )

  // 3: reconcile now, then on an interval.
  //
  // The immediate pass is what covers "plugin loaded while a session is
  // already running" — including this plugin's own hot reload. Sessions with an
  // open compaction bracket are unioned in, because the registry cannot see them.
  const reconcile = (why) => {
    const live = liveSessionIds(ctx.get('agents'))

    // Prune brackets whose session no longer exists. `agent/disposed` normally
    // handles this, but the bracket set is the one piece of state the registry
    // cannot correct on its own — an unpruned entry would be unioned back in on
    // every pass and pin the assertion forever.
    for (const id of [...compacting]) {
      if (!live.includes(id)) compacting.delete(id)
    }

    const active = runningSessionIds(ctx.get('agents'))
    controller.reconcile([...new Set([...active, ...compacting])])

    const snap = controller.snapshot()
    if (snap.active) {
      logger.info?.(
        `[keep-awake] ${why}: holding the sleep assertion for ${snap.heldCount} active session(s)`,
      )
    }
  }

  reconcile('initial reconcile')

  const seconds = config.reconcileSeconds ?? 60
  if (seconds > 0) {
    ctx.effect(() => {
      // A plain unref'd timer, not `ctx.interval`: the `timer` mixin throws when
      // `timer` is not in `inject`, and this must never hold the process open.
      const handle = setInterval(() => reconcile('periodic reconcile'), seconds * 1000)
      handle.unref?.()
      return () => clearInterval(handle)
    }, 'dsh-mac-keep-awake: reconcile loop')
  }

  logger.info?.(
    `[keep-awake] active — caffeinate -i${config.preventDisplaySleep ? ' -d' : ''}` +
      `${config.maxHours > 0 ? ` -t ${Math.round(config.maxHours * 3600)}` : ''} -w ${process.pid}` +
      `, reconciling every ${seconds > 0 ? `${seconds}s` : 'never'}`,
  )
}
