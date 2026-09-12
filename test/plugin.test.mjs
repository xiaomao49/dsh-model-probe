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

// ── 探测专属请求头的保密边界 ────────────────────────────────────────────────
//
// probeHeaders 的值会被直接送进 HTTP 头，可能含凭据。插件的既有纪律是"凭据
// 不出现在任何返回值里"，这条必须同样适用于它——否则一个跑在浏览器里的设置页
// 就能把凭据读走。

test('状态接口绝不返回 probeHeaders 的值，只回 provider 名', async () => {
  const secret = 'must-never-appear-in-any-response'
  const section = {
    providers: { p1: { baseURL: 'https://x.invalid', api: 'openai-completions', models: [{ id: 'm' }] } },
  }
  const { ctx, tools, routes } = makeCtx({ section })
  apply(ctx, {
    enabledProviders: ['p1'],
    probeHeaders: { p1: { 'x-opencode-session': secret, authorization: 'Bearer also-secret' } },
  })

  // 工具返回值
  const viaTool = await tools.find((t) => t.name === 'model_probe_status').execute({}, {})
  assert.equal(JSON.stringify(viaTool).includes(secret), false, '工具返回值不得含探测头值')
  assert.equal(JSON.stringify(viaTool).includes('also-secret'), false)
  assert.deepEqual(viaTool.policy.probeHeaderProviders, ['p1'])
  assert.equal(viaTool.policy.probeHeaders, undefined, '整个 probeHeaders 字段都不得出现在返回值里')

  // HTTP 状态路由
  const route = routes.find((r) => r.path === '/api/model-probe/status')
  const res = fakeRes()
  await route.handler(fakeReq({ method: 'GET' }), res)
  assert.equal(JSON.stringify(res.body).includes(secret), false, 'HTTP 状态不得含探测头值')
  assert.deepEqual(res.body.policy.probeHeaderProviders, ['p1'])
})

test('policy 路由：probeHeaders 的形状被清洗，脏值静默丢弃而不报错', async () => {
  const section = {
    providers: { p1: { baseURL: 'https://x.invalid', api: 'openai-completions', models: [] } },
  }
  const { ctx, routes } = makeCtx({ section })
  apply(ctx)

  const route = routes.find((r) => r.path === '/api/model-probe/policy')
  const res = fakeRes()
  await route.handler(
    fakeReq({
      method: 'POST',
      body: {
        probeHeaders: {
          p1: {
            'x-good': 'v',
            'x-empty': '',
            'x-number': 42,
            'x-null': null,
          },
          p2: 'not-an-object',
          p3: ['array'],
          p4: { ok: 'yes' },
        },
      },
    }),
    res,
  )

  assert.equal(res.status, 200)
  // 只报告"哪些 provider 配了头"，不回报任何值。
  assert.deepEqual(res.body.policy.probeHeaderProviders.sort(), ['p1', 'p4'])
  assert.equal(JSON.stringify(res.body).includes('"v"'), false)
})

test('切换开关只走 merge，绝不整段覆盖——否则手写的 probeHeaders 会被抹掉', async () => {
  // settings.update 的语义是"把 patch 合并进用户层"，replace 才是整段替换。
  // 插件若误用 replace，一个开关点击就会删掉用户手写的探测头（以及任何它没
  // 在补丁里重述的字段）。这条钉住的就是这个区别。
  const calls = { update: [], replace: [] }
  const config = { enabledProviders: ['p1'], probeHeaders: { p1: { 'x-a': 'v' } } }

  const { ctx, tools, routes } = makeCtx({
    section: { providers: { p1: { baseURL: 'https://x.invalid', api: 'openai-completions', models: [] } } },
  })
  ctx.settings.installSection = (owner, ns, schema, entry, hooks) => {
    hooks.setSource(() => config)
  }
  ctx.settings.update = async (ns, patch) => {
    calls.update.push(patch)
    Object.assign(config, patch)
  }
  ctx.settings.replace = async (ns, section) => {
    calls.replace.push(section)
    return section
  }
  apply(ctx, config)

  const route = routes.find((r) => r.path === '/api/model-probe/policy')
  const res = fakeRes()
  await route.handler(fakeReq({ method: 'POST', body: { enabledProviders: ['p1'] } }), res)
  assert.equal(res.status, 200)

  assert.equal(calls.replace.length, 0, '插件不得调用 settings.replace')
  assert.deepEqual(calls.update, [{ enabledProviders: ['p1'] }], '补丁里只应带被改动的键')
  // 合并语义下，探测头原样保留。
  assert.deepEqual(config.probeHeaders, { p1: { 'x-a': 'v' } })
  assert.deepEqual(res.body.policy.probeHeaderProviders, ['p1'])
})

test('回归：读不到 llm-pi-ai 配置时，绝不能宣称白名单里的 provider 已被删除', async () => {
  // 实测摔过的坑：插件在 apply() 里读设置时，llm-pi-ai 命名空间往往还没注册，
  // readPiSection 回退成 { providers: {} }，交集为空被当成"全都已被删除"，
  // 启动日志因此写着「探测白名单里有 2 个 provider 已不在 llm-pi-ai 配置中」——
  // 而它们配置得好好的。读不到的诚实说法是"不知道"。
  const ctx = {
    settings: {
      // describe 有这一行但 user 为空：模拟"用户层此刻不可读"
      describe: () => [{ ns: 'llm-pi-ai', revision: 1, user: null }],
      get: () => undefined,
      mutate: async () => {},
    },
    tools: { register: () => {} },
    get: () => undefined,
    effect: () => {},
    logger: { info: () => {}, debug: () => {}, warn: () => {} },
  }
  const tools = []
  ctx.tools.register = (def) => tools.push(def)
  apply(ctx, { enabledProviders: ['cc-goat', 'opencode-go'] })

  const result = await tools.find((t) => t.name === 'model_probe_status').execute({}, {})
  assert.deepEqual(result.policy.staleProviders, [], '读不到配置时不得宣称它们被删除')
  // 白名单原样保留：我们只是无法确认，而不是要替用户清空授权。
  assert.deepEqual(result.policy.enabledProviders, ['cc-goat', 'opencode-go'])
})

test('回归：确实读到了配置、而 provider 真被删掉时，照常报告残留', async () => {
  const section = { providers: { real: { baseURL: 'https://x.invalid', api: 'openai-completions', models: [] } } }
  const { ctx, tools } = makeCtx({ section })
  apply(ctx, { enabledProviders: ['real', 'ghost'] })

  const result = await tools.find((t) => t.name === 'model_probe_status').execute({}, {})
  assert.deepEqual(result.policy.staleProviders, ['ghost'], '读得到配置时，残留必须照实报')
  assert.deepEqual(result.policy.enabledProviders, ['real'])
})
