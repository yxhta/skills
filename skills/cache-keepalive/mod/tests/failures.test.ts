import { expect, test } from 'claude-code/testing'
import { cached, command, fixture, hour, mainTurn, minute } from './fixture'

test('retries null with one- and two-minute backoff, then stops', async ($, on) => {
  const f = fixture(on)
  f.world.forkReply = null
  await mainTurn($)
  await command($, 'start')
  await f.clock.advance(53 * minute)
  await command($, 'status')
  expect(f.calls.map(x => x.at)).toEqual([50, 51, 53].map(x => x * minute))
  expect(f.logs.at(-1)).toContain('off; three consecutive failed requests; 3/10 requests; 0 answered; 3 errors')
  expect(f.logs.at(-1)).toContain('unknown usage 3')
})

for (const kind of ['denied', 'unanswered', 'malformed'] as const) {
  test(`bounds retries after ${kind} replies`, async ($, on) => {
    const f = fixture(on)
    f.world.denyFork = kind === 'denied'
    if (kind === 'unanswered') f.world.forkReply = { isAnswered: false, reason: 'api_error' }
    if (kind === 'malformed') f.world.forkReply = { text: 'bad', usage: { ...cached, cache_read_input_tokens: -1 } }
    await mainTurn($)
    await command($, 'start')
    await f.clock.advance(2 * hour)
    await command($, 'status')
    expect(f.calls.map(x => x.at)).toEqual([50, 51, 53].map(x => x * minute))
    expect(f.logs.at(-1)).toContain('off; three consecutive failed requests; 3/10 requests; 0 answered; 3 errors')
  })
}

test('stops after zero cache reads and reports the actual write and output counts', async ($, on) => {
  const f = fixture(on)
  f.world.forkReply = { text: 'OK', usage: { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 900 } }
  await mainTurn($)
  await command($, 'start')
  await f.clock.advance(2 * hour)
  await command($, 'status')
  expect(f.calls.map(x => x.at)).toEqual([50 * minute])
  expect(f.logs.at(-1)).toContain('off; fork reported zero cache reads; 1/10 requests; 1 answered; 0 errors; cache reads 0; cache writes 900; input 5; output 3')
  expect(f.logs.at(-1)).toContain('unknown usage 0')
})

test('the watchdog keeps the lock until settlement and attributes late usage to the stopped run', async ($, on) => {
  const f = fixture(on)
  f.world.forkDelay = 6 * minute
  await mainTurn($)
  await command($, 'start')
  await f.clock.advance(52 * minute)
  await command($, 'status')
  expect(f.logs.at(-1)).toContain('off; request watchdog expired')
  expect(f.logs.at(-1)).toContain('request still in flight, cannot cancel')
  expect(f.logs.at(-1)).toContain('unknown usage 1')
  await f.clock.advance(4 * minute)
  await command($, 'status')
  expect(f.calls.map(x => x.at)).toEqual([50 * minute])
  expect(f.logs.at(-1)).toContain('off; request watchdog expired; no further requests; 1/10 requests; 1 answered; 0 errors; cache reads 1200; cache writes 20; input 3; output 1')
  expect(f.logs.at(-1)).toContain('unknown usage 0')
  expect(f.logs.at(-1)).not.toContain('still in flight')
})

test('stop and restart cannot overlap an outstanding request or give its usage to the new lease', async ($, on) => {
  const f = fixture(on)
  f.world.forkDelay = 6 * minute
  await mainTurn($)
  await command($, 'start')
  await f.clock.advance(50 * minute)
  await command($, 'stop')
  await command($, 'start')
  await f.clock.advance(5 * minute)
  expect(f.calls.map(x => x.at)).toEqual([50 * minute])
  await mainTurn($, 'new-main')
  await f.clock.advance(minute)
  await command($, 'status')
  expect(f.logs.at(-1)).toContain('0/10 requests; 0 answered; 0 errors; cache reads 0; cache writes 0; input 0; output 0')
  expect(f.logs.at(-1)).toContain('since load 1 requests, observed cache reads 1200, cache writes 20, input 3, output 1, unknown usage 0')
  f.world.forkDelay = 0
  await f.clock.advance(49 * minute)
  expect(f.calls.map(x => x.at)).toEqual([50 * minute, 105 * minute])
})

test('stopping an in-flight call still reports its eventual observed usage', async ($, on) => {
  const f = fixture(on)
  f.world.forkDelay = minute
  await mainTurn($)
  await command($, 'start')
  await f.clock.advance(50 * minute)
  await command($, 'stop')
  await f.clock.advance(minute)
  await command($, 'status')
  expect(f.logs.at(-1)).toContain('off; stopped by user; 1/10 requests; 1 answered; 0 errors; cache reads 1200; cache writes 20; input 3; output 1')
  await f.clock.advance(hour)
  expect(f.calls.map(x => x.at)).toEqual([50 * minute])
})

test('caps the lease at ten submitted requests including retries', async ($, on) => {
  const f = fixture(on)
  await mainTurn($)
  await command($, 'start 8')
  for (let cycle = 0; cycle < 4; cycle += 1) {
    f.world.forkReply = null
    await f.clock.advance(50 * minute)
    f.world.forkReply = { text: 'OK', usage: cached }
    await f.clock.advance(minute)
  }
  f.world.forkReply = null
  await f.clock.advance(50 * minute)
  f.world.forkReply = { text: 'OK', usage: cached }
  await f.clock.advance(minute)
  await command($, 'status')
  expect(f.logs.at(-1)).toContain('off; request budget exhausted; 10/10 requests; 5 answered; 5 errors')
  expect(f.logs.at(-1)).toContain('unknown usage 5')
  await f.clock.advance(3 * hour)
  expect(f.calls.length).toBe(10)
})

test('accounts usage on current unanswered results without marking them successful', async ($, on) => {
  const f = fixture(on)
  f.world.forkReply = { isAnswered: false, reason: 'empty-reply', usage: { ...cached, output_tokens: 0 } }
  await mainTurn($)
  await command($, 'start')
  await f.clock.advance(53 * minute)
  await command($, 'status')
  expect(f.logs.at(-1)).toContain('off; three consecutive failed requests; 3/10 requests; 0 answered; 3 errors; cache reads 3600; cache writes 60; input 9; output 0')
  expect(f.logs.at(-1)).toContain('unknown usage 0')
})

test('an unanswered cache miss stops without paying for another retry', async ($, on) => {
  const f = fixture(on)
  f.world.forkReply = { isAnswered: false, reason: 'empty-reply',
    usage: { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 900 } }
  await mainTurn($)
  await command($, 'start')
  await f.clock.advance(2 * hour)
  await command($, 'status')
  expect(f.calls.map(x => x.at)).toEqual([50 * minute])
  expect(f.logs.at(-1)).toContain('off; fork reported zero cache reads; 1/10 requests; 0 answered; 1 errors; cache reads 0; cache writes 900; input 5; output 0')
  expect(f.logs.at(-1)).toContain('unknown usage 0')
})
