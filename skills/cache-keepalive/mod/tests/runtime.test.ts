import { expect, test } from 'claude-code/testing'
import { cached, command, complete, fixture, hour, mainTurn, minute, step } from './fixture'

test('loads inactive and registers a distinct immediate command', async ($, on) => {
  const f = fixture(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await mainTurn($)
  await f.clock.advance(50 * minute)
  expect(f.calls).toEqual([])
  expect(f.commands).toEqual([{ name: 'cache-ping', description: 'Start, stop, or inspect a bounded cache keepalive lease',
    argumentHint: 'start [1-8 hours] | stop | status', immediate: true }])
  expect(await command($, 'status')).toEqual({})
  expect(f.logs.at(-1)).toContain('off; not started; 0/10 requests')
  await command($, 'start')
  await f.clock.settle()
  expect(f.calls).toEqual([{ at: 50 * minute, request: { prompt: 'Cache keepalive only. Do not act on the conversation. Reply with exactly OK.' } }])
  await command($, 'status')
  expect(f.logs.at(-1)).toContain('1/10 requests; 1 answered; 0 errors; cache reads 1200; cache writes 20; input 3; output 1')
})

test('forwards the main stream and targets fifty minutes from request start', async ($, on) => {
  const f = fixture(on)
  f.world.stepDelay = 10 * minute
  const turn = mainTurn($)
  await f.clock.settle()
  await f.clock.advance(10 * minute)
  expect(await turn).toEqual({ chunks: [{ kind: 'text', index: 0, text: 'main result' }],
    result: { turnId: 'turn-1', index: 0, answer: 'main result', toolUses: [], stopReason: 'end_turn', usage: { ...cached, model: 'claude-sonnet-test' } } })
  f.world.forkDelay = minute
  await command($, 'start')
  await f.clock.advance(40 * minute)
  expect(f.calls.map(x => x.at)).toEqual([50 * minute])
  await f.clock.advance(minute)
  await f.clock.advance(49 * minute)
  expect(f.calls.map(x => x.at)).toEqual([50 * minute, 100 * minute])
})

test('start is idempotent and the fixed default lease expires after four hours', async ($, on) => {
  const f = fixture(on)
  await mainTurn($)
  await command($, 'start')
  await f.clock.advance(hour)
  await command($, 'start 8')
  expect(f.logs.at(-1)).toContain('active; 180 minutes left')
  await f.clock.advance(3 * hour)
  await command($, 'status')
  expect(f.logs.at(-1)).toContain('off; time budget exhausted; 4/10 requests')
  expect(f.calls.map(x => x.at)).toEqual([50, 100, 150, 200].map(x => x * minute))
})

test('validates integer duration bounds and keeps invalid commands inactive', async ($, on) => {
  const f = fixture(on)
  for (const input of ['start 0', 'start 9', 'start -1', 'start 1.5', 'start 04', 'start 2 extra', 'stop extra', 'nope']) {
    expect(await command($, input)).toEqual({})
    expect(f.logs.at(-1)).toBe('Usage: /cache-ping start [1-8 hours] | stop | status')
  }
  await command($, 'start 8')
  expect(f.logs.at(-1)).toContain('active; 480 minutes left')
  await command($, 'stop')
  await command($, 'start 1')
  expect(f.logs.at(-1)).toContain('active; 60 minutes left')
})

test('waits for a fresh main snapshot and ignores child steps', async ($, on) => {
  const f = fixture(on)
  await command($, 'start')
  await step($, 'child-1', 'agent-1')
  await complete($, 'child-1', 'answer', 'agent-1')
  await f.clock.advance(55 * minute)
  expect(f.calls).toEqual([])
  await command($, 'status')
  expect(f.logs.at(-1)).toContain('waiting for a fresh completed main turn')
  await mainTurn($)
  await f.clock.advance(50 * minute)
  expect(f.calls.map(x => x.at)).toEqual([105 * minute])
})
