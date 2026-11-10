import { expect, test } from 'claude-code/testing'
import { cached, command, complete, fixture, hour, mainTurn, minute, step } from './fixture'

test('recent main activity refreshes the anchor while a busy turn suppresses requests', async ($, on) => {
  const f = fixture(on)
  await mainTurn($)
  await command($, 'start')
  await f.clock.advance(40 * minute)
  await $.turn.start({ turnId: 'busy', text: 'keep working' })
  await step($, 'busy')
  await f.clock.advance(15 * minute)
  expect(f.calls).toEqual([])
  await complete($, 'busy')
  await f.clock.advance(35 * minute)
  expect(f.calls.map(x => x.at)).toEqual([90 * minute])
})

test('a newer main snapshot wins over a previously submitted fork', async ($, on) => {
  const f = fixture(on)
  f.world.forkDelay = minute
  await mainTurn($)
  await command($, 'start')
  await f.clock.advance(50 * minute)
  await f.clock.advance(30_000)
  await mainTurn($, 'new-main')
  await f.clock.advance(30_000)
  await f.clock.advance(49 * minute)
  expect(f.calls.map(x => x.at)).toEqual([50 * minute])
  f.world.forkDelay = 0
  await f.clock.advance(30_000)
  expect(f.calls.map(x => x.at)).toEqual([50 * minute, 100.5 * minute])
})

for (const reason of ['clear', 'resume', 'other'] as const) {
  test(`session end ${reason} resets and allows manual restart without session.start`, async ($, on) => {
    const f = fixture(on)
    await mainTurn($)
    await command($, 'start')
    await $.session.end({ reason, sessionId: 'session-1', resume: { id: 'session-1' } })
    f.world.session = 'session-2'
    await command($, 'start')
    expect(f.logs.at(-1)).toContain('active; 240 minutes left')
    expect(f.logs.at(-1)).toContain('waiting for a fresh completed main turn')
    await f.clock.advance(50 * minute)
    expect(f.calls).toEqual([])
    await mainTurn($, 'new-session')
    await f.clock.advance(50 * minute)
    expect(f.calls.map(x => x.at)).toEqual([100 * minute])
  })
}

test('branch command disables and resets before any subsequent main activity', async ($, on) => {
  const f = fixture(on)
  await mainTurn($)
  await command($, 'start')
  expect(await $.command.run({ command: 'branch', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })).toEqual({})
  await command($, 'status')
  expect(f.logs.at(-1)).toContain('off; /branch')
  await mainTurn($, 'branch-main')
  await command($, 'start')
  await f.clock.advance(50 * minute)
  expect(f.calls.length).toBe(1)
})

test('compaction pauses until a successful fresh main request', async ($, on) => {
  const f = fixture(on)
  await mainTurn($)
  await command($, 'start')
  await f.clock.advance(40 * minute)
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'work to summarize', toolUses: [] }] })
  await f.clock.advance(20 * minute)
  await command($, 'status')
  expect(f.logs.at(-1)).toContain('active; 180 minutes left')
  expect(f.logs.at(-1)).toContain('waiting for a fresh completed main turn')
  expect(f.calls).toEqual([])
  await mainTurn($, 'post-compact')
  await f.clock.advance(50 * minute)
  expect(f.calls.map(x => x.at)).toEqual([110 * minute])
})

test('compaction during a main request invalidates its late snapshot', async ($, on) => {
  const f = fixture(on)
  await command($, 'start')
  f.world.stepDelay = minute
  const turn = mainTurn($)
  await f.clock.settle()
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'work to summarize', toolUses: [] }] })
  await f.clock.advance(minute)
  await turn
  await f.clock.advance(50 * minute)
  expect(f.calls).toEqual([])
  f.world.stepDelay = 0
  await mainTurn($, 'valid')
  await f.clock.advance(50 * minute)
  expect(f.calls.map(x => x.at)).toEqual([101 * minute])
})

test('model selection changes need a new snapshot and preserve lease expiry', async ($, on) => {
  const f = fixture(on)
  await mainTurn($)
  await command($, 'start 1')
  f.world.model = 'claude-opus-test'
  await f.clock.advance(50 * minute)
  expect(f.calls).toEqual([])
  await command($, 'status')
  expect(f.logs.at(-1)).toContain('waiting for a fresh completed main turn')
  await f.clock.advance(10 * minute)
  await command($, 'status')
  expect(f.logs.at(-1)).toContain('off; time budget exhausted')
  await mainTurn($, 'new-model')
  await command($, 'start')
  await f.clock.advance(50 * minute)
  expect(f.calls.map(x => x.at)).toEqual([110 * minute])
})

for (const error of ['no-usage', 'zero-cached-tokens', 'null-stop', 'failed-turn'] as const) {
  test(`main ${error} does not fake cache freshness`, async ($, on) => {
    const f = fixture(on)
    await mainTurn($)
    await command($, 'start')
    await f.clock.advance(40 * minute)
    if (error === 'no-usage') f.world.stepUsage = null
    if (error === 'zero-cached-tokens') f.world.stepUsage = { ...cached, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    if (error === 'null-stop') f.world.stepStop = null
    await $.turn.start({ turnId: 'bad', text: 'normal work' })
    await step($, 'bad')
    await complete($, 'bad', error === 'failed-turn' ? 'error' : 'answer')
    await f.clock.advance(50 * minute)
    await command($, 'status')
    expect(f.calls).toEqual([])
    expect(f.logs.at(-1)).toContain('waiting for a fresh completed main turn')
    f.world.stepUsage = cached
    f.world.stepStop = 'end_turn'
    await mainTurn($, 'good')
    await f.clock.advance(50 * minute)
    expect(f.calls.map(x => x.at)).toEqual([140 * minute])
  })
}

test('a main request older than one hour cannot warm the cache on late completion', async ($, on) => {
  const f = fixture(on)
  f.world.stepDelay = 61 * minute
  await command($, 'start')
  const turn = mainTurn($)
  await f.clock.settle()
  await f.clock.advance(61 * minute)
  await turn
  await f.clock.settle()
  await command($, 'status')
  expect(f.calls).toEqual([])
  expect(f.logs.at(-1)).toContain('off; warm cache window expired')
  f.world.stepDelay = 0
  await mainTurn($, 'fresh')
  await command($, 'start')
  await f.clock.advance(50 * minute)
  expect(f.calls.map(x => x.at)).toEqual([111 * minute])
})

test('stop wins over a start whose policy read has not completed', async ($, on) => {
  const f = fixture(on)
  await mainTurn($)
  f.world.settingsDelay = minute
  const starting = command($, 'start')
  await f.clock.settle()
  await command($, 'stop')
  await f.clock.advance(minute)
  await starting
  await f.clock.advance(50 * minute)
  await command($, 'status')
  expect(f.calls).toEqual([])
  expect(f.logs.at(-1)).toContain('off; stopped by user; 0/10 requests')
})

test('stop wins over a delayed tick preflight before any request is sent', async ($, on) => {
  const f = fixture(on)
  await mainTurn($)
  await command($, 'start')
  f.world.settingsDelay = minute
  await f.clock.advance(50 * minute)
  await command($, 'stop')
  await f.clock.advance(minute)
  await command($, 'status')
  expect(f.calls).toEqual([])
  expect(f.logs.at(-1)).toContain('off; stopped by user; 0/10 requests')
  f.world.settingsDelay = 0
  await mainTurn($, 'fresh')
  await command($, 'start')
  await f.clock.advance(50 * minute)
  expect(f.calls.map(x => x.at)).toEqual([101 * minute])
})

test('a main turn invalidates a delayed tick preflight', async ($, on) => {
  const f = fixture(on)
  await mainTurn($)
  await command($, 'start')
  f.world.settingsDelay = minute
  await f.clock.advance(50 * minute)
  f.world.settingsDelay = 0
  await mainTurn($, 'new-main')
  await f.clock.advance(minute)
  await command($, 'status')
  expect(f.calls).toEqual([])
  expect(f.logs.at(-1)).toContain('active; 189 minutes left; 0/10 requests')
  await f.clock.advance(49 * minute)
  expect(f.calls.map(x => x.at)).toEqual([100 * minute])
})

test('a preflight stalled past the TTL refuses an expired snapshot', async ($, on) => {
  const f = fixture(on)
  await mainTurn($)
  await command($, 'start')
  f.world.settingsDelay = 11 * minute
  await f.clock.advance(61 * minute)
  await command($, 'status')
  expect(f.calls).toEqual([])
  expect(f.logs.at(-1)).toContain('off; warm cache window expired; send a normal turn before restarting; 0/10 requests')
  f.world.settingsDelay = 0
  await mainTurn($, 'fresh-after-delay')
  await command($, 'start')
  await f.clock.advance(50 * minute)
  expect(f.calls.map(x => x.at)).toEqual([111 * minute])
})
