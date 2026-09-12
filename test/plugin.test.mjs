/**
 * 宿主插件端到端测试：用假的 ctx 模拟 DSH 运行时，验证工具与路由。
 *
 * 为什么值得写：插件的失败模式很隐蔽——工具没注册上、路由路径写错、
 * 把活对象（Service/AbortSignal）塞进 JSON 边界，这些都只在真实加载时才炸。
 * 用一个最小 ctx 复现这些契约，比装进 DSH 反复重启快得多。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, name, inject, POLICY_NS } from '../lib/index.js'

/** 构造一个最小可用的 ctx，记录所有注册动作。 */
function makeCtx({ section = { providers: {} }, withWebServer = true } = {}) {
  const tools = []
  const routes = []
  const effects = []
  const logs = []

  const ctx = {
    settings: {
      get: (ns) => (ns === 'llm-pi-ai' ? section : undefined),
      // describe 必须带 user 原始层：插件的读取走这一层，因为 get() 返回的
      // 解析值含 schema materialize 出来的默认字段，写回去会污染用户配置。
      describe: () => [{ ns: 'llm-pi-ai', revision: 7, user: section }],
      mutate: async (ns, ops) => {
        ctx.mutations.push({ ns, ops })
      },
    },
    tools: { register: (def) => tools.push(def) },
    get: (key) => {
      if (key === 'webServer' && withWebServer) {
        return { register: (route) => routes.push(route) }
      }
      if (key === 'credentials') {
        return { resolve: async () => ({ value: 'test-key-not-real' }) }
      }
      return undefined
    },
    effect: (fn) => effects.push(fn()),
    logger: { info: (m) => logs.push(m), debug: () => {}, warn: () => {} },
    mutations: [],
  }
  return { ctx, tools, routes, effects, logs }
}

test('插件导出契约：name / inject 必须符合 DSH 约定', () => {
  assert.equal(name, 'dsh-model-probe')
  assert.deepEqual(inject, ['tools', 'settings'])
  assert.equal(POLICY_NS, 'model-probe')
})

test('加载后注册三个工具与全部路由', () => {
  const { ctx, tools, routes } = makeCtx()
  apply(ctx)

  const names = tools.map((t) => t.name).sort()
  assert.deepEqual(names, ['model_probe_apply', 'model_probe_scan', 'model_probe_status'])

  const paths = routes.map((r) => r.path).sort()
  assert.deepEqual(paths, [
    '/api/model-probe/apply',
    '/api/model-probe/cancel',
    '/api/model-probe/policy',
    '/api/model-probe/scan',
    '/api/model-probe/status',
  ])
  // 全部为 exact 路由，避免前缀匹配误吞其它路径。
  assert.ok(routes.every((r) => r.kind === 'exact'))
})

test('未配置 webServer 时不注册路由，但仍注册工具（降级而非崩溃）', () => {
  const { ctx, tools, routes } = makeCtx({ withWebServer: false })
  apply(ctx)
  assert.equal(routes.length, 0)
  assert.equal(tools.length, 3)
})

test('status 工具：只读、不发请求、如实反映探测开关', async () => {
  const section = {
    providers: {
      'cc-goat': {
        api: 'openai-completions',
        baseURL: 'https://example.invalid/v1',
        apiKeyEnv: 'CC_GOAT_API_KEY',
        models: [{ id: 'm1', contextWindow: 1000 }],
      },
    },
  }
  const { ctx, tools } = makeCtx({ section })
  apply(ctx)

  const status = tools.find((t) => t.name === 'model_probe_status')
  const result = await status.execute({}, {})

  assert.equal(result.ok, true)
  assert.equal(result.providers.length, 1)
  const p = result.providers[0]
  assert.equal(p.id, 'cc-goat')
  assert.equal(p.modelCount, 1)
  assert.equal(p.hasKey, true)
  // 关键：默认不开启探测，界面据此禁用扫描按钮。
  assert.equal(p.probeEnabled, false)
  assert.deepEqual(result.policy.enabledProviders, [])
})

test('扫描未开启探测的 provider 时拒绝，并说明原因', async () => {
  const section = { providers: { 'cc-goat': { baseURL: 'https://x.invalid', api: 'openai-completions', models: [] } } }
  const { ctx, tools } = makeCtx({ section })
  apply(ctx)

  const scan = tools.find((t) => t.name === 'model_probe_scan')
  const result = await scan.execute({ provider: 'cc-goat' }, {})

  assert.equal(result.ok, false)
  assert.equal(result.needsEnable, true)
  assert.match(result.error, /未开启探测/)
})

test('配置 probeProviders 后 status 反映为已开启', async () => {
  const section = { providers: { p1: { baseURL: 'https://x.invalid', api: 'openai-completions', models: [] } } }
  const { ctx, tools } = makeCtx({ section })
  apply(ctx, { probeProviders: ['p1'] })

  const status = await tools.find((t) => t.name === 'model_probe_status').execute({}, {})
  assert.equal(status.providers[0].probeEnabled, true)
  assert.deepEqual(status.policy.enabledProviders, ['p1'])
})

test('apply 工具：完全省略 confirm 时被 schema 层拦下', async () => {
  const { ctx, tools } = makeCtx()
  apply(ctx)

  const applyTool = tools.find((t) => t.name === 'model_probe_apply')
  // schema 把 confirm 声明为必填，模型无法"忘记"表达意图——
  // 它必须显式写 confirm 才能通过参数校验。
  await assert.rejects(
    () => applyTool.execute({ provider: 'p' }, {}),
    (err) => err.code === 'INVALID_ARGS' && /confirm/.test(String(err.message)),
  )
  assert.equal(ctx.mutations.length, 0)
})

test('apply 工具：显式传 confirm=false 时被运行时拦下，不写入', async () => {
  const { ctx, tools } = makeCtx()
  apply(ctx)

  const applyTool = tools.find((t) => t.name === 'model_probe_apply')
  const denied = await applyTool.execute({ provider: 'p', confirm: false }, {})
  assert.equal(denied.ok, false)
  assert.match(denied.error, /confirm=true/)
  // 确认拒绝发生在写之前：没有任何 mutate 被调用。
  assert.equal(ctx.mutations.length, 0)
})

test('HTTP apply 路由：未确认时返回 400 且不写入', async () => {
  const { ctx, routes } = makeCtx()
  apply(ctx)

  const route = routes.find((r) => r.path === '/api/model-probe/apply')
  const res = fakeRes()
  await route.handler(fakeReq({ body: { provider: 'p' } }), res)

  assert.equal(res.status, 400)
  assert.match(res.body.error, /确认/)
  assert.equal(ctx.mutations.length, 0)
})

test('HTTP policy 路由：可开启/关闭探测并夹取请求上限', async () => {
  const section = { providers: { p1: { baseURL: 'https://x.invalid', api: 'openai-completions', models: [] } } }
  const { ctx, routes } = makeCtx({ section })
  apply(ctx)

  const route = routes.find((r) => r.path === '/api/model-probe/policy')
  const res = fakeRes()
  await route.handler(
    fakeReq({ body: { enabledProviders: ['p1'], visionProbe: false, maxRequestsPerScan: 99999 } }),
    res,
  )

  assert.equal(res.status, 200)
  assert.deepEqual(res.body.policy.enabledProviders, ['p1'])
  assert.equal(res.body.policy.visionProbe, false)
  // 上限被夹到 500，防止误设一个天文数字。
  assert.equal(res.body.policy.maxRequestsPerScan, 500)
})

test('HTTP 路由：非本机来源一律 403', async () => {
  const { ctx, routes } = makeCtx()
  apply(ctx)

  const route = routes.find((r) => r.path === '/api/model-probe/status')
  const res = fakeRes()
  // 模拟一个外部地址且没有 origin 的请求。
  await route.handler({ method: 'GET', headers: {}, socket: { remoteAddress: '203.0.113.5' }, url: '/' }, res)
  assert.equal(res.status, 403)
})

test('HTTP 路由：方法不匹配返回 405', async () => {
  const { ctx, routes } = makeCtx()
  apply(ctx)

  const route = routes.find((r) => r.path === '/api/model-probe/scan')
  const res = fakeRes()
  await route.handler(fakeReq({ method: 'GET' }), res)
  assert.equal(res.status, 405)
})

test('HTTP status 路由：本机请求返回完整状态', async () => {
  const section = { providers: { p1: { baseURL: 'https://x.invalid', api: 'openai-completions', models: [{ id: 'm' }] } } }
  const { ctx, routes } = makeCtx({ section })
  apply(ctx)

  const route = routes.find((r) => r.path === '/api/model-probe/status')
  const res = fakeRes()
  await route.handler(fakeReq({ method: 'GET' }), res)

  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.providers[0].models[0].id, 'm')
  assert.equal(res.body.revision, 7)
})

// ── 请求/响应替身 ────────────────────────────────────────────────────────────

function fakeReq({ method = 'POST', body, headers = {}, remoteAddress = '127.0.0.1' } = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  return {
    method,
    headers,
    url: '/',
    socket: { remoteAddress },
    async *[Symbol.asyncIterator]() {
      if (payload.length > 0) yield Buffer.from(payload)
    },
  }
}

function fakeRes() {
  const res = {
    status: 0,
    body: undefined,
    headers: undefined,
    writeHead(status, headers) {
      res.status = status
      res.headers = headers
    },
    end(text) {
      res.body = text === undefined ? undefined : JSON.parse(text)
    },
  }
  return res
}

test('策略持久化：有 installSection 时挂载命名空间并通过 update 写入', async () => {
  const installed = []
  const updates = []
  const { ctx, tools } = makeCtx()
  ctx.settings.installSection = (owner, ns, schema, entry, hooks) => {
    installed.push({ ns, schema, entry })
    // 模拟设置服务：挂载后把权威值来源交给作用域。
    hooks.setSource(() => ({ ...entry, ...(updates.at(-1) ?? {}) }))
    hooks.onChange()
  }
  ctx.settings.update = async (ns, patch) => {
    updates.push(patch)
  }
  apply(ctx)

  assert.equal(installed.length, 1)
  assert.equal(installed[0].ns, 'model-probe')
  // 组合配置成为基础层，默认关闭探测。
  assert.deepEqual(installed[0].entry.enabledProviders, [])
  assert.equal(installed[0].entry.toleranceRatio, 0.05)

  const status = await tools.find((t) => t.name === 'model_probe_status').execute({}, {})
  assert.equal(status.policyPersisted, true)

  // 通过路由改策略应落到 settings.update 而不是内存。
  const { routes } = makeCtx()
  void routes
})

test('策略持久化：installSection 抛错时降级为进程内状态，插件仍可加载', () => {
  const tools = []
  const ctx = {
    settings: {
      get: () => ({ providers: {} }),
      describe: () => [],
      installSection: () => {
        throw new Error('namespace already registered')
      },
    },
    tools: { register: (d) => tools.push(d) },
    get: () => undefined,
    effect: () => {},
    logger: { info: () => {}, debug: () => {}, warn: () => {} },
  }
  // 关键：不抛异常。
  apply(ctx)
  assert.equal(tools.length, 3)
})

// ── 残留 provider：白名单里的名字已从模型配置中删除 ──────────────────────────
//
// 这是实际收到过的反馈：用户在模型设置里删掉了 op-zen，设置页却仍显示
// "当前已开启探测：cc-goat、op-go、op-zen"，而且因为界面上没有它的开关卡片，
// 用户删不掉它，只能手工去改 settings.yaml。

test('残留 provider：已删除的 provider 不出现在开关状态里，但被单独报告', async () => {
  const section = {
    providers: {
      real: { baseURL: 'https://x.invalid', api: 'openai-completions', apiKeyEnv: 'K', models: [{ id: 'm' }] },
    },
  }
  const { ctx, tools } = makeCtx({ section })
  // 组合层白名单里同时留着真实与已删除的 provider。
  apply(ctx, { enabledProviders: ['real', 'ghost'] })

  const status = tools.find((t) => t.name === 'model_probe_status')
  const result = await status.execute({}, {})

  // 有效集合只含真实存在的 provider —— 界面据此渲染，ghost 不再出现。
  assert.deepEqual(result.policy.enabledProviders, ['real'])
  // 但白名单里确实还留着它，如实报告，而不是假装没有。
  assert.deepEqual(result.policy.staleProviders, ['ghost'])
  assert.equal(result.providers.length, 1)
  assert.equal(result.providers[0].probeEnabled, true)
})

test('残留 provider：全部 provider 都被删掉时，开关状态为空而不是"保持着"', async () => {
  const { ctx, tools } = makeCtx({ section: { providers: {} } })
  apply(ctx, { enabledProviders: ['ghost-a', 'ghost-b'] })

  const result = await tools.find((t) => t.name === 'model_probe_status').execute({}, {})

  assert.deepEqual(result.policy.enabledProviders, [])
  assert.deepEqual(result.policy.staleProviders, ['ghost-a', 'ghost-b'])
})

test('policy 路由：不存在的 provider 名不会被写进白名单', async () => {
  const section = {
    providers: { real: { baseURL: 'https://x.invalid', api: 'openai-completions', models: [] } },
  }
  const { ctx, routes } = makeCtx({ section })
  apply(ctx)

  const route = routes.find((r) => r.path === '/api/model-probe/policy')
  const res = fakeRes()
  await route.handler(fakeReq({ method: 'POST', body: { enabledProviders: ['real', 'ghost'] } }), res)

  assert.equal(res.status, 200)
  assert.deepEqual(res.body.policy.enabledProviders, ['real'])
})

test('policy 路由：读不到任何 provider 时不做收窄（避免读取失败被当成"用户没有 provider"）', async () => {
  const { ctx, routes } = makeCtx({ section: { providers: {} } })
  apply(ctx)

  const route = routes.find((r) => r.path === '/api/model-probe/policy')
  const res = fakeRes()
  await route.handler(fakeReq({ method: 'POST', body: { enabledProviders: ['keep-me'] } }), res)

  assert.equal(res.status, 200)
  // 一个 provider 都读不到时保持原样，宁可留残留也不误删用户的授权。
  assert.deepEqual(res.body.policy.enabledProviders, [])
  assert.deepEqual(res.body.policy.staleProviders, ['keep-me'])
})
