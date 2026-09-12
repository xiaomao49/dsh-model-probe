/**
 * provider 自定义头的转发测试。
 *
 * 背景（实测）：`https://opencode.ai/zen/go/v1`（opencode.ai 的 Console Go 网关）
 * 强制要求 `x-opencode-session` 头，缺它时任何请求都返回 HTTP 400
 *   MissingSessionID … Request is missing x-opencode-session and cannot be routed
 * 于是一次扫描的四个字段会全部落空，界面上看起来像"这个端点测不出来"，
 * 实际只是少了一个头。
 *
 * DSH 的 llm-pi-ai 本身就支持 provider 级 `headers` 字典并会照发，所以用户是能配
 * 的；插件侧不转发，这条路就是断的。这里把转发与覆盖顺序都钉住。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { listModels, elicitMaxTokens, Budget } from '../lib/probe.js'

function makeBudget(limit = 10) {
  return new Budget(limit)
}

/** 用一次性 fetch 替身记录发出的请求头。 */
async function capture(impl, fn) {
  const original = globalThis.fetch
  globalThis.fetch = impl
  try {
    return await fn()
  } finally {
    globalThis.fetch = original
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

test('listModels 转发 provider 自定义头', async () => {
  let seen = null
  const impl = (url, init) => {
    seen = { url, headers: init.headers }
    return Promise.resolve(jsonResponse({ data: [{ id: 'glm-5.3-flash' }] }))
  }

  const res = await capture(impl, () =>
    listModels({
      baseURL: 'https://opencode.ai/zen/go/v1',
      api: 'openai-completions',
      apiKey: 'k-not-real',
      headers: { 'x-opencode-session': 'dsh-model-probe-0001' },
      budget: makeBudget(),
    }),
  )

  assert.equal(res.ok, true)
  assert.equal(seen.url, 'https://opencode.ai/zen/go/v1/models')
  assert.equal(seen.headers['x-opencode-session'], 'dsh-model-probe-0001')
  // 鉴权头必须同时在，且由凭据推导，不来自配置。
  assert.equal(seen.headers.authorization, 'Bearer k-not-real')
})

test('鉴权头优先于同名的自定义头（凭据是当场解析的权威身份）', async () => {
  let seen = null
  const impl = (url, init) => {
    seen = init.headers
    return Promise.resolve(jsonResponse({ data: [] }))
  }

  await capture(impl, () =>
    listModels({
      baseURL: 'https://x.invalid/v1',
      api: 'openai-completions',
      apiKey: 'real-key',
      headers: { authorization: 'Bearer stale-key-from-config' },
      budget: makeBudget(),
    }),
  )

  assert.equal(seen.authorization, 'Bearer real-key')
})

test('凭据解析不到时，自定义头原样保留', async () => {
  let seen = null
  const impl = (url, init) => {
    seen = init.headers
    return Promise.resolve(jsonResponse({ data: [] }))
  }

  await capture(impl, () =>
    listModels({
      baseURL: 'https://x.invalid/v1',
      api: 'openai-completions',
      apiKey: undefined,
      headers: { 'x-opencode-session': 's1', 'x-tenant': 't1' },
      budget: makeBudget(),
    }),
  )

  assert.equal(seen['x-opencode-session'], 's1')
  assert.equal(seen['x-tenant'], 't1')
  assert.equal(seen.authorization, undefined)
})

test('elicitMaxTokens 也转发自定义头——约束取证同样需要它们', async () => {
  let seen = null
  const impl = (url, init) => {
    seen = init.headers
    return Promise.resolve(
      jsonResponse({ error: { message: 'Input should be less than or equal to 10000000', param: 'max_tokens' } }, 422),
    )
  }

  const res = await capture(impl, () =>
    elicitMaxTokens({
      baseURL: 'https://opencode.ai/zen/go/v1',
      api: 'openai-completions',
      apiKey: 'k-not-real',
      model: 'glm-5.3-flash',
      headers: { 'x-opencode-session': 'dsh-model-probe-0001' },
      budget: makeBudget(),
    }),
  )

  assert.equal(seen['x-opencode-session'], 'dsh-model-probe-0001')
  // 端到端：带着这个头，422 里的上界能被解析出来。
  assert.equal(res.ok, true)
  assert.equal(res.max, 10000000)
})

test('没有自定义头时不制造多余字段（保持既有请求形状）', async () => {
  let seen = null
  const impl = (url, init) => {
    seen = init.headers
    return Promise.resolve(jsonResponse({ data: [] }))
  }

  await capture(impl, () =>
    listModels({
      baseURL: 'https://x.invalid/v1',
      api: 'openai-completions',
      apiKey: 'k',
      budget: makeBudget(),
    }),
  )

  assert.deepEqual(Object.keys(seen).sort(), ['authorization'])
})

test('非对象形态的 headers 被忽略而不抛错', async () => {
  let seen = null
  const impl = (url, init) => {
    seen = init.headers
    return Promise.resolve(jsonResponse({ data: [] }))
  }

  for (const bad of [null, undefined, 'x-session: 1', 42, ['a', 'b']]) {
    await capture(impl, () =>
      listModels({ baseURL: 'https://x.invalid/v1', api: 'openai-completions', apiKey: 'k', headers: bad, budget: makeBudget() }),
    )
    assert.deepEqual(Object.keys(seen).sort(), ['authorization'], `headers=${JSON.stringify(bad)} 应被忽略`)
  }
})

// ── 探测专属请求头（model-probe.probeHeaders）────────────────────────────────
//
// 存在的理由：有些网关除 API key 外强制要求别的头，而给探测请求补这个头只有两条
// 路——写进 llm-pi-ai 的 provider headers，或写进本插件自己的 probeHeaders。
// 前者是错的：那份配置 DSH 的真实模型调用也会带上，会把"按会话动态发头"的机制
// 顶掉（配置值优先），让所有会话塌缩成一个缓存亲和桶。所以这些测试钉住的
// 就是"只影响探测、不碰 llm-pi-ai"这条边界。

import { scanProvider, DEFAULT_POLICY } from '../lib/scan.js'

/** 一个最小可用的 provider section（fetch 已被替身接管，不会真发请求）。 */
function section(headers) {
  return {
    providers: {
      'opencode-go': {
        api: 'openai-completions',
        baseURL: 'https://opencode.ai/zen/go/v1',
        apiKeyEnv: 'K',
        ...(headers === undefined ? {} : { headers }),
        models: [{ id: 'm1' }],
      },
    },
  }
}

/** 收集扫描期间所有请求的头。 */
async function collectScanHeaders(impl, { probeHeaders } = {}) {
  const seen = []
  const recording = (url, init) => {
    seen.push(init?.headers ?? {})
    return impl(url, init)
  }
  const original = globalThis.fetch
  globalThis.fetch = recording
  try {
    await scanProvider({
      provider: 'opencode-go',
      section: section(undefined),
      apiKey: 'k-not-real',
      policy: {
        ...DEFAULT_POLICY,
        visionProbe: false,
        probeHeaders: probeHeaders ?? {},
      },
    })
  } finally {
    globalThis.fetch = original
  }
  return seen
}

test('probeHeaders 会随探测请求发出——两个模型四次请求都带上', async () => {
  const seen = await collectScanHeaders(
    () => Promise.resolve(jsonResponse({ data: [{ id: 'm1' }] }, 200)),
    { probeHeaders: { 'opencode-go': { 'x-opencode-session': 'dsh-model-probe' } } },
  )

  assert.ok(seen.length >= 3, `应发出多次请求，实际 ${seen.length}`)
  for (const headers of seen) {
    assert.equal(headers['x-opencode-session'], 'dsh-model-probe')
  }
})

test('probeHeaders 只发给配置里点名的 provider', async () => {
  const seen = await collectScanHeaders(
    () => Promise.resolve(jsonResponse({ data: [{ id: 'm1' }] }, 200)),
    { probeHeaders: { 'some-other-provider': { 'x-opencode-session': 'wrong' } } },
  )

  for (const headers of seen) {
    assert.equal(headers['x-opencode-session'], undefined)
  }
})

test('同名时探测专属头胜过 provider 自己的 headers', async () => {
  const seen = []
  const original = globalThis.fetch
  globalThis.fetch = (url, init) => {
    seen.push(init?.headers ?? {})
    return Promise.resolve(jsonResponse({ data: [{ id: 'm1' }] }, 200))
  }
  try {
    await scanProvider({
      provider: 'opencode-go',
      // provider 自己配了一个静态值（DSH 真实调用会用它）
      section: section({ 'x-opencode-session': 'from-llm-pi-ai', 'x-tenant': 't1' }),
      apiKey: 'k',
      policy: {
        ...DEFAULT_POLICY,
        visionProbe: false,
        // 探测侧显式指定了另一个值，应当胜出
        probeHeaders: { 'opencode-go': { 'x-opencode-session': 'for-probe-only' } },
      },
    })
  } finally {
    globalThis.fetch = original
  }

  for (const headers of seen) {
    assert.equal(headers['x-opencode-session'], 'for-probe-only', '探测专属值应当胜出')
    assert.equal(headers['x-tenant'], 't1', 'provider 其它头仍然照发')
  }
})

test('没有 probeHeaders 时探测请求形状不变（向后兼容）', async () => {
  const seen = await collectScanHeaders(() => Promise.resolve(jsonResponse({ data: [{ id: 'm1' }] }, 200)))

  for (const headers of seen) {
    // 只应有鉴权头；带 body 的请求另加 content-type，这是既有行为。
    assert.deepEqual(
      Object.keys(headers).sort().filter((k) => k !== 'content-type'),
      ['authorization'],
    )
  }
})

test('DEFAULT_POLICY 自带空的 probeHeaders，空策略不会让扫描炸掉', async () => {
  assert.deepEqual(DEFAULT_POLICY.probeHeaders, {})
  const seen = await collectScanHeaders(() => Promise.resolve(jsonResponse({ data: [] }, 200)), {
    probeHeaders: {},
  })
  assert.ok(seen.length > 0)
})
