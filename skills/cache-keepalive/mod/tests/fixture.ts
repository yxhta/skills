import { mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { CommandSpec, ModelUsage, On, TurnStepResult } from 'claude-code'

export const minute = 60_000
export const hour = 60 * minute
export const cached = { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 1200, cache_creation_input_tokens: 20 }

type World = {
  env: Record<string, string | undefined>
  settings: Record<string, unknown>
  model: string
  session: string
  stepUsage: ModelUsage | null
  stepDelay: number
  stepStop: TurnStepResult['stopReason']
  forkReply: unknown
  forkDelay: number
  denyFork: boolean
  settingsDelay: number
}

export function fixture(on: On) {
  const clock = mock.clock(on)
  const world: World = {
    env: {}, settings: { promptCacheTtl: '1h', subagentPromptCacheTtl: '1h' },
    model: 'claude-sonnet-test', session: 'session-1', stepUsage: cached, stepDelay: 0,
    stepStop: 'end_turn', forkReply: { isAnswered: true, text: 'OK', usage: cached }, forkDelay: 0,
    denyFork: false, settingsDelay: 0,
  }
  const logs: string[] = []
  const statuses: string[] = []
  const calls: { at: number; request: unknown }[] = []
  const commands: CommandSpec[] = []
  on('env.get', (_, e) => ({ value: world.env[e.name] }))
  on('settings.read', async () => {
    const value = { ...world.settings }
    if (world.settingsDelay) await clock.sleep(world.settingsDelay)
    return { value }
  })
  on('session.model', () => ({ value: world.model }))
  on('session.id', () => ({ value: world.session }))
  on('ui.log', (_, e) => { logs.push(e.text); return { value: undefined } })
  on('ui.status', (_, e) => { statuses.push(e.text ?? ''); return { value: undefined } })
  on('command.register', (_, e) => { commands.push(e); return { value: { command: e.name } } })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('session.compact', () => ({ messages: [{ role: 'assistant', text: 'summary', toolUses: [] }] }))
  on('classic.PostModelSwitch', () => ({}))
  on('config.set', (_, e) => ({ value: e.value }))
  on('command.run', () => ({}))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'main result' }))
  on('turn.step', async function* (_, e) {
    const usage = world.stepUsage && { ...world.stepUsage, model: world.model }
    if (world.stepDelay) await clock.sleep(world.stepDelay)
    yield { kind: 'text', index: 0, text: 'main result' }
    return { turnId: e.turnId, index: e.index, answer: 'main result', toolUses: [], stopReason: world.stepStop, usage }
  })
  on('model.fork', async (_, e) => {
    calls.push({ at: clock.now(), request: e })
    const reply = world.forkReply
    if (world.forkDelay) await clock.sleep(world.forkDelay)
    return world.denyFork ? { deny: 'simulated refusal' } : { value: reply as never }
  })
  return { clock, world, logs, statuses, calls, commands }
}

export async function command($: Engine, args: string) {
  return $.command.run({ command: 'cache-ping', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
}

export async function step($: Engine, turnId = 'turn-1', agentId?: string) {
  const stream = $.turn.step({ turnId, index: 0, model: 'claude-sonnet-test', messageCount: 2, ...(agentId ? { agentId } : {}) })
  const chunks = []
  let item = await stream.next()
  while (!item.done) {
    chunks.push(item.value)
    item = await stream.next()
  }
  return { chunks, result: item.value }
}

export async function complete($: Engine, turnId = 'turn-1', reason: 'answer' | 'error' | 'aborted' = 'answer', agentId?: string) {
  return $.turn.complete({ turnId, answer: 'main result', durationMs: 1, isAborted: reason === 'aborted', reason,
    ...(agentId ? { agentId } : {}) })
}

export async function mainTurn($: Engine, turnId = 'turn-1') {
  await $.turn.start({ turnId, text: 'ordinary user work' })
  const result = await step($, turnId)
  await complete($, turnId)
  return result
}
