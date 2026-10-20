import type { EngineInterface, ModelUsage, Register, Timer } from 'claude-code'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const CADENCE = 50 * MINUTE
const MAX_ATTEMPTS = 10
const WATCHDOG = 2 * MINUTE
const PROMPT = 'Cache keepalive only. Do not act on the conversation. Reply with exactly OK.'

type Snapshot = { started: number; model: string; session: string }
type Counts = { attempts: number; answered: number; reported: number; errors: number; usage: ModelUsage }
type Lease = Counts & { until: number; failures: number; due: number | null; timer: Timer | null; expiry: Timer | null }
type Flight = { run: Lease; snapshot: Snapshot; started: number | null; watchdog: Timer | null }

function counts(): Counts {
  return {
    attempts: 0, answered: 0, reported: 0, errors: 0,
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  }
}

function ttl(value: unknown): '1h' | '5m' | undefined {
  return value === '1h' || value === '5m' ? value : undefined
}

function disabled(value: string | undefined): boolean {
  return value !== undefined && !['', '0', 'false'].includes(value.toLowerCase())
}

async function eligible($: EngineInterface): Promise<boolean> {
  try {
    const [settings, main, fork, force, enable, all, haiku, sonnet, opus, fable] = await Promise.all([
      $.settings.read(),
      $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL'),
      $.env.get('CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL'),
      $.env.get('FORCE_PROMPT_CACHING_5M'),
      $.env.get('ENABLE_PROMPT_CACHING_1H'),
      $.env.get('DISABLE_PROMPT_CACHING'),
      $.env.get('DISABLE_PROMPT_CACHING_HAIKU'),
      $.env.get('DISABLE_PROMPT_CACHING_SONNET'),
      $.env.get('DISABLE_PROMPT_CACHING_OPUS'),
      $.env.get('DISABLE_PROMPT_CACHING_FABLE'),
    ])
    // Alias-specific disable flags are conservatively treated as a global veto.
    if ([force, all, haiku, sonnet, opus, fable].some(disabled)) return false
    const fallback = enable === '1' ? '1h' : undefined
    return (ttl(main) ?? ttl(settings.promptCacheTtl) ?? fallback) === '1h'
      && (ttl(fork) ?? ttl(settings.subagentPromptCacheTtl) ?? fallback) === '1h'
  } catch {
    return false
  }
}

function usageOf(reply: unknown): ModelUsage | null {
  if (!reply || typeof reply !== 'object') return null
  if (!('usage' in reply) || !reply.usage || typeof reply.usage !== 'object') return null
  const usage = reply.usage as ModelUsage
  return [usage.input_tokens, usage.output_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens]
    .every(value => Number.isSafeInteger(value) && value >= 0) ? usage : null
}

let lease: Lease | null = null
let snapshot: Snapshot | null = null
let main: { turnId: string } | null = null
let flight: Flight | null = null
let revision = 0
let controls = 0
let last = counts()
const lifetime = counts()
let reason = 'not started'

function observe(run: Lease, usage: ModelUsage | null, answered: boolean) {
  for (const count of [run, lifetime]) {
    if (answered) count.answered += 1
    else count.errors += 1
    if (!usage) continue
    count.reported += 1
    count.usage.input_tokens += usage.input_tokens
    count.usage.output_tokens += usage.output_tokens
    count.usage.cache_read_input_tokens += usage.cache_read_input_tokens
    count.usage.cache_creation_input_tokens += usage.cache_creation_input_tokens
  }
}

function pauseSnapshot() {
  revision += 1
  snapshot = null
  if (lease) {
    lease.due = null
    lease.timer?.cancel()
    lease.timer = null
  }
}

function stop($: EngineInterface, why: string) {
  controls += 1
  if (lease) {
    lease.timer?.cancel()
    lease.expiry?.cancel()
    last = lease
    lease = null
  }
  reason = why
  $.ui.status(`off; ${why}${flight && flight.started !== null ? '; request still in flight, cannot cancel' : ''}`)
}

function reset($: EngineInterface, why: string) {
  stop($, why)
  pauseSnapshot()
  main = null
}

function schedule($: EngineInterface, run: Lease, now: number) {
  if (lease !== run) return
  run.timer?.cancel()
  run.timer = null
  if (main || !snapshot || flight || run.due === null) return
  const due = Math.min(run.due, run.until)
  run.timer = $.clock.after(Math.max(0, due - now), () => { void tick($, run) })
}

async function show($: EngineInterface) {
  const now = await $.clock.now()
  if (lease && now >= lease.until) stop($, 'time budget exhausted')
  const run = lease ?? last
  const state = lease ? `active; ${Math.max(0, Math.ceil((lease.until - now) / MINUTE))} minutes left`
    : `off; ${reason}`
  const waiting = lease && (!snapshot || main) ? '; waiting for a fresh completed main turn' : ''
  const pending = flight && flight.started !== null ? '; request still in flight, cannot cancel' : ''
  $.ui.log(`${state}; ${run.attempts}/${MAX_ATTEMPTS} requests; ${run.answered} answered; ${run.errors} errors; `
    + `cache reads ${run.usage.cache_read_input_tokens}; cache writes ${run.usage.cache_creation_input_tokens}; `
    + `input ${run.usage.input_tokens}; output ${run.usage.output_tokens}${waiting}${pending}; `
    + `since load ${lifetime.attempts} requests, observed cache reads ${lifetime.usage.cache_read_input_tokens}, `
    + `cache writes ${lifetime.usage.cache_creation_input_tokens}, input ${lifetime.usage.input_tokens}, `
    + `output ${lifetime.usage.output_tokens}, unknown usage ${lifetime.attempts - lifetime.reported}`)
}

async function tick($: EngineInterface, run: Lease) {
  if (lease !== run) return
  let now = await $.clock.now()
  if (lease !== run) return
  if (now >= run.until) return stop($, 'time budget exhausted')
  if (main || !snapshot || flight) return schedule($, run, now)
  if (now >= snapshot.started + HOUR) return stop($, 'warm cache window expired; send a normal turn before restarting')
  if (run.attempts >= MAX_ATTEMPTS) return stop($, 'request budget exhausted')
  if (run.due === null || now < run.due) return schedule($, run, now)

  const pending: Flight = { run, snapshot, started: null, watchdog: null }
  flight = pending
  let recorded = false
  try {
    const allowed = await eligible($)
    const [model, session] = await Promise.all([$.session.model(), $.session.id()])
    now = await $.clock.now()
    if (lease !== run || main || snapshot !== pending.snapshot) return
    if (!allowed) return stop($, 'both effective cache TTLs must remain explicitly 1h and caching enabled')
    if (session !== snapshot.session) return reset($, 'session changed')
    if (model !== snapshot.model) {
      pauseSnapshot()
      $.ui.status('active; model changed, waiting for a fresh main turn')
      return
    }
    if (now >= run.until) return stop($, 'time budget exhausted')
    if (now >= snapshot.started + HOUR) return stop($, 'warm cache window expired; send a normal turn before restarting')
    pending.started = now
    run.attempts += 1
    lifetime.attempts += 1
    run.due = now + CADENCE
    pending.watchdog = $.clock.after(Math.min(WATCHDOG, run.until - now), () => {
      if (lease === run && flight === pending) stop($, 'request watchdog expired; no further requests')
    })
    const reply = await $.model.fork({ prompt: PROMPT })
    const usage = usageOf(reply)
    const answered = usage !== null && reply !== null && typeof reply === 'object'
      && !('isAnswered' in reply && reply.isAnswered === false)
    observe(run, usage, answered)
    recorded = true
    if (lease !== run) return
    now = await $.clock.now()
    if (lease !== run) return
    if (usage?.cache_read_input_tokens === 0) return stop($, 'fork reported zero cache reads')
    if (answered && usage) {
      run.failures = 0
      if (snapshot === pending.snapshot && !main) {
        snapshot = { ...snapshot, started: pending.started }
        run.due = pending.started + CADENCE
      }
      $.ui.status(`active; ${run.attempts}/${MAX_ATTEMPTS} requests; cache reads ${run.usage.cache_read_input_tokens}; `
        + `cache writes ${run.usage.cache_creation_input_tokens}; output ${run.usage.output_tokens}`)
    } else {
      failed($, run, now, pending.snapshot)
    }
    if (lease === run && run.attempts >= MAX_ATTEMPTS) stop($, 'request budget exhausted')
  } catch {
    if (pending.started === null) {
      if (lease === run) stop($, 'unable to verify the current model and session')
    } else {
      if (!recorded) observe(run, null, false)
      now = await $.clock.now()
      if (lease === run) failed($, run, now, pending.snapshot)
    }
  } finally {
    pending.watchdog?.cancel()
    if (flight === pending) flight = null
    // A stopped request retains the lock until it settles, even across restart.
    if (lease) schedule($, lease, await $.clock.now())
  }
}

function failed($: EngineInterface, run: Lease, now: number, source: Snapshot) {
  run.failures += 1
  if (run.failures >= 3) return stop($, 'three consecutive failed requests')
  if (run.attempts >= MAX_ATTEMPTS) return stop($, 'request budget exhausted')
  if (snapshot !== source || main) return
  const retry = now + run.failures * MINUTE
  if (retry >= source.started + HOUR || retry >= run.until) return stop($, 'no warm window left for a retry')
  run.due = retry
  $.ui.status(`active; request failed; retry in ${run.failures} minute(s)`)
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'cache-ping',
      description: 'Start, stop, or inspect a bounded cache keepalive lease',
      argumentHint: 'start [1-8 hours] | stop | status',
      immediate: true,
    })
    return next(e)
  })

  on('command.run', { command: 'cache-ping' }, async ($, e) => {
    const parts = e.args.trim().split(/\s+/)
    const action = parts[0] || 'status'
    if (action === 'stop' && parts.length === 1) {
      stop($, 'stopped by user')
    } else if (action === 'status' && parts.length === 1) {
      // Status only reads local counters.
    } else if (action === 'start' && parts.length <= 2 && (parts.length === 1 || /^[1-8]$/.test(parts[1] ?? ''))) {
      const ticket = controls
      const allowed = await eligible($)
      const now = await $.clock.now()
      if (ticket !== controls) return {}
      if (lease && now >= lease.until) stop($, 'time budget exhausted')
      if (!lease) {
        if (!allowed) {
          reason = 'refused; both effective cache TTLs must be explicitly 1h and caching enabled'
        } else {
          if (snapshot && now >= snapshot.started + HOUR) snapshot = null
          lease = { ...counts(), until: now + Number(parts[1] ?? 4) * HOUR, failures: 0,
            due: snapshot ? snapshot.started + CADENCE : null, timer: null, expiry: null }
          const run = lease
          run.expiry = $.clock.after(run.until - now, () => {
            if (lease === run) stop($, 'time budget exhausted')
          })
          schedule($, run, now)
        }
      }
    } else {
      $.ui.log('Usage: /cache-ping start [1-8 hours] | stop | status')
      return {}
    }
    await show($)
    return {}
  })

  on('turn.start', async ($, e, next) => {
    pauseSnapshot()
    const active = { turnId: e.turnId }
    main = active
    if (lease) schedule($, lease, await $.clock.now())
    try {
      return await next(e)
    } catch (error) {
      if (main === active) main = null
      throw error
    }
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId) return yield* next(e)
    if (!main || main.turnId !== e.turnId) main = { turnId: e.turnId }
    pauseSnapshot()
    const active = main
    const version = revision
    let proof: { allowed: boolean; model: string; session: string } | undefined
    // Observe policy alongside the normal request. Unready reads leave it cold.
    void Promise.all([eligible($), $.session.model(), $.session.id()]).then(
      ([allowed, model, session]) => { proof = { allowed, model, session } },
      () => {},
    )
    const started = await $.clock.now()
    const result = yield* next(e)
    const usage = usageOf(result)
    if (main === active && revision === version && proof?.allowed && result.stopReason !== null
      && usage && usage.cache_read_input_tokens + usage.cache_creation_input_tokens > 0) {
      snapshot = { started, model: proof.model, session: proof.session }
      if (lease) {
        lease.due = started + CADENCE
        lease.failures = 0
      }
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const active = !e.agentId && main?.turnId === e.turnId ? main : null
    const result = await next(e)
    if (active && main === active) {
      main = null
      if (e.reason === 'error' || e.reason === 'aborted') pauseSnapshot()
      if (lease) schedule($, lease, await $.clock.now())
    }
    return result
  })

  on('session.compact', async ($, e, next) => {
    if (!e.agentId) {
      pauseSnapshot()
      if (lease) schedule($, lease, await $.clock.now())
    }
    return next(e)
  })

  on('classic.PostModelSwitch', ($, e, next) => {
    pauseSnapshot()
    return next(e)
  })

  on('config.set', async ($, e, next) => {
    if (['model', 'effort', 'fastMode'].includes(e.key)) {
      pauseSnapshot()
      if (lease) schedule($, lease, await $.clock.now())
    }
    return next(e)
  })

  on('session.end', ($, e, next) => {
    reset($, `session ended (${e.reason})`)
    return next(e)
  })

  on('command.run', { command: ['clear', 'resume', 'fork', 'branch'] }, ($, e, next) => {
    reset($, `/${e.command}`)
    return next(e)
  })
}
