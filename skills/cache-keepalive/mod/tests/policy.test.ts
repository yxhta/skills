import { expect, test } from 'claude-code/testing'
import { command, fixture, mainTurn, minute } from './fixture'

const cases = [
  { name: 'unknown account defaults', settings: {}, env: {}, allowed: false },
  { name: 'main-only hour', settings: { promptCacheTtl: '1h' }, env: {}, allowed: false },
  { name: 'fork-only hour', settings: { subagentPromptCacheTtl: '1h' }, env: {}, allowed: false },
  { name: 'explicit settings', settings: { promptCacheTtl: '1h', subagentPromptCacheTtl: '1h' }, env: {}, allowed: true },
  { name: 'global hour fallback', settings: {}, env: { ENABLE_PROMPT_CACHING_1H: '1' }, allowed: true },
  { name: 'invalid global fallback', settings: {}, env: { ENABLE_PROMPT_CACHING_1H: 'true' }, allowed: false },
  { name: 'force five overrides everything', settings: { promptCacheTtl: '1h', subagentPromptCacheTtl: '1h' },
    env: { FORCE_PROMPT_CACHING_5M: '1', ENABLE_PROMPT_CACHING_1H: '1', CLAUDE_CODE_PROMPT_CACHE_TTL: '1h', CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '1h' }, allowed: false },
  { name: 'environment five overrides setting hour', settings: { promptCacheTtl: '1h', subagentPromptCacheTtl: '1h' },
    env: { CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '5m', ENABLE_PROMPT_CACHING_1H: '1' }, allowed: false },
  { name: 'environment hour overrides setting five', settings: { promptCacheTtl: '5m', subagentPromptCacheTtl: '5m' },
    env: { CLAUDE_CODE_PROMPT_CACHE_TTL: '1h', CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '1h' }, allowed: true },
  { name: 'setting five overrides global hour', settings: { promptCacheTtl: '5m' }, env: { ENABLE_PROMPT_CACHING_1H: '1' }, allowed: false },
  { name: 'invalid bucket values fall through', settings: { promptCacheTtl: '1h', subagentPromptCacheTtl: 'nonsense' },
    env: { CLAUDE_CODE_PROMPT_CACHE_TTL: 'garbage', ENABLE_PROMPT_CACHING_1H: '1' }, allowed: true },
]
for (const c of cases) {
  test(`TTL precedence respects ${c.name}`, async ($, on) => {
    const f = fixture(on)
    f.world.settings = c.settings
    f.world.env = c.env
    await mainTurn($)
    await command($, 'start')
    expect(f.logs.at(-1)).toContain(c.allowed ? 'active; 240 minutes left' : 'off; refused; both effective cache TTLs must be explicitly 1h')
    await f.clock.advance(50 * minute)
    expect(f.calls.length).toBe(c.allowed ? 1 : 0)
  })
}

for (const flag of ['DISABLE_PROMPT_CACHING', 'DISABLE_PROMPT_CACHING_HAIKU', 'DISABLE_PROMPT_CACHING_SONNET', 'DISABLE_PROMPT_CACHING_OPUS', 'DISABLE_PROMPT_CACHING_FABLE']) {
  test(`conservatively refuses ${flag}`, async ($, on) => {
    const f = fixture(on)
    f.world.env[flag] = '1'
    await command($, 'start')
    expect(f.logs.at(-1)).toContain('off; refused')
    f.world.env[flag] = '0'
    await mainTurn($)
    await command($, 'start')
    await f.clock.advance(50 * minute)
    expect(f.calls.length).toBe(1)
  })
}

test('rechecks effective policy immediately before a fork', async ($, on) => {
  const f = fixture(on)
  await mainTurn($)
  await command($, 'start')
  f.world.env.FORCE_PROMPT_CACHING_5M = '1'
  await f.clock.advance(50 * minute)
  await command($, 'status')
  expect(f.calls).toEqual([])
  expect(f.logs.at(-1)).toContain('off; both effective cache TTLs must remain explicitly 1h')
  delete f.world.env.FORCE_PROMPT_CACHING_5M
  await command($, 'start')
  await f.clock.settle()
  expect(f.calls.length).toBe(1)
})

test('changing to hour TTL after a five-minute main request does not prove a warm snapshot', async ($, on) => {
  const f = fixture(on)
  f.world.settings.promptCacheTtl = '5m'
  await mainTurn($)
  f.world.settings.promptCacheTtl = '1h'
  await command($, 'start')
  await f.clock.advance(50 * minute)
  await command($, 'status')
  expect(f.calls).toEqual([])
  expect(f.logs.at(-1)).toContain('waiting for a fresh completed main turn')
  await mainTurn($, 'new-policy')
  await f.clock.advance(50 * minute)
  expect(f.calls.map(x => x.at)).toEqual([100 * minute])
})
