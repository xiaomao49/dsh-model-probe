/**
 * 工具通道的取值边界回归测试 —— 让工具**真的执行**，再把返回值交给宿主判据裁决。
 *
 * 与 lossless.test.mjs 的分工：那份测形状与 `compact` 语义（不加载 lib/index.js，
 * 因此在没有宿主依赖时也能跑）；这份用假 ctx 装上插件、调真工具，覆盖"出口有没有
 * 收口"这件事本身。
 *
 * 为什么必须单独测这层（真实故障，issue #1）：插件的三处出口都是把可选字段直接
 * 写进对象（`input: Array.isArray(...) ? ... : undefined`），而 DSH 的取值边界把
 * `undefined` 判为非法，工具通道直接抛
 * `tool "model_probe_status" returned invalid output: value is not lossless JSON`。
 *
 * 症状是反直觉的：`model_probe_status` **恒定失败**，而 `model_probe_scan` 只在
 * "真的取证到东西"时才失败——探针全坏时反而能用。原先 108 项测试全绿也没拦住，
 * 因为那些测试断言的是业务语义，没有一项断言过返回值的形状本身。
 *
 * 判定器优先用宿主真实实现，拿不到时回退到逐条对应的复刻（CI 里宿主包由
 * devDependencies 传递提供，但不赌它一定在）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

// ── 判定器 ───────────────────────────────────────────────────────────────────

function referenceIsJsonValue(value) {
  if (value === null) return true
  const type = typeof value
  if (type === 'boolean' || type === 'string') return true
  if (type === 'number') return Number.isFinite(value) && !Object.is(value, -0)
  if (type !== 'object') return false
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) return false
    for (let index = 0; index < value.length; index++) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) return false
      if (!referenceIsJsonValue(value[index])) return false
    }
    return true
  }
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return false
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return false
    if (!Object.prototype.propertyIsEnumerable.call(value, key)) return false
    if (!referenceIsJsonValue(value[key])) return false
  }
  return true
}

async function loadJudge() {
  for (const spec of ['@deepseek-ai/dsh-util-values', '@deepseek-ai/dsh-tools']) {
    try {
      const mod = await import(spec)
      if (typeof mod.isJsonValue === 'function') return { judge: mod.isJsonValue, source: `host ${spec}` }
    } catch {
      // 试下一个来源。
    }
  }
  return { judge: referenceIsJsonValue, source: 'reference replica' }
}

const { judge, source } = await loadJudge()

// ── 假 ctx（与 plugin.test.mjs 同款最小实现）─────────────────────────────────

function makeCtx({ section = { providers: {} }, withWebServer = true } = {}) {
  const tools = []
  const routes = []
  const ctx = {
    settings: {
      get: (ns) => (ns === 'llm-pi-ai' ? section : undefined),
      describe: () => [{ ns: 'llm-pi-ai', revision: 7, user: section }],
      mutate: async () => {},
    },
    tools: { register: (def) => tools.push(def) },
    get: (key) => (key === 'webServer' && withWebServer ? { register: (route) => routes.push(route) } : undefined),
    effect: (fn) => fn(),
    logger: { info: () => {}, debug: () => {}, warn: () => {} },
  }
  return { ctx, tools, routes }
}

function fakeReq({ method = 'POST', body } = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  return {
    method,
    headers: {},
    url: '/',
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      if (payload.length > 0) yield Buffer.from(payload)
    },
  }
}

/** 同时保留**原始文本**与解析结果：文本才是真正过线的报文。 */
function fakeRes() {
  const res = {
    status: 0,
    text: undefined,
    body: undefined,
    writeHead(status) {
      res.status = status
    },
    end(text) {
      res.text = text
      res.body = text === undefined ? undefined : JSON.parse(text)
    },
  }
  return res
}

/**
 * 一个"必然产生 undefined 属性"的配置：两个模型都没声明 `input`，而 `buildStatus`
 * 会无条件写 `input: Array.isArray(m?.input) ? m.input : undefined`。
 */
const sectionWithoutInput = {
  providers: {
    'cc-goat': {
      api: 'openai-completions',
      baseURL: 'https://api.commandcode.ai/provider/v1',
      apiKeyEnv: 'CC_GOAT_API_KEY',
      models: [
        { id: 'deepseek/deepseek-v4.1-flash', contextWindow: 1000000, maxTokens: 384000 },
        { id: 'z-ai/glm-5.3-flash', contextWindow: 1048576, maxTokens: 131072 },
      ],
    },
  },
}

/** 断言一个工具返回值可过取值边界，失败时把违规路径打出来。 */
function assertLossless(label, value) {
  if (judge(value)) return
  const bad = []
  const walk = (node, path) => {
    if (node === undefined) return void bad.push(`${path} = undefined`)
    if (typeof node === 'number' && !Number.isFinite(node)) return void bad.push(`${path} = ${node}`)
    if (Array.isArray(node)) return void node.forEach((item, index) => walk(item, `${path}[${index}]`))
    if (node !== null && typeof node === 'object') {
      for (const [key, item] of Object.entries(node)) walk(item, `${path}.${key}`)
    }
  }
  walk(value, '$')
  assert.fail(`${label} 的返回值过不了取值边界${bad.length > 0 ? `：${bad.slice(0, 5).join('、')}` : ''}`)
}

// ── 测试 ─────────────────────────────────────────────────────────────────────

test(`status 工具：模型未声明 input 时返回值仍合格（来源：${source}）`, async () => {
  const { ctx, tools } = makeCtx({ section: sectionWithoutInput })
  apply(ctx)

  const result = await tools.find((t) => t.name === 'model_probe_status').execute({}, {})

  // 先钉住"这份配置本来就会产生 undefined"，否则这个测试会退化成空转。
  assert.equal(result.ok, true)
  assert.equal(result.providers[0].models[0].id, 'deepseek/deepseek-v4.1-flash')
  assert.equal(Object.hasOwn(result.providers[0].models[0], 'input'), false, '未声明 input 的模型不应带 input 键')

  assertLossless('model_probe_status', result)
  // 其余字段一个都不能少：收口只丢非法值，不丢信息。
  assert.equal(result.providers[0].models[0].maxTokens, 384000)
  assert.equal(result.providers[0].modelCount, 2)
  assert.equal(result.writable, true)
  assert.equal(result.revision, 7)
})

test('status 工具：未声明 input 的模型在收口前后都保留 id 与数值字段', async () => {
  const { ctx, tools } = makeCtx({ section: sectionWithoutInput })
  apply(ctx)
  const result = await tools.find((t) => t.name === 'model_probe_status').execute({}, {})

  for (const model of result.providers[0].models) {
    assert.equal(typeof model.id, 'string')
    assert.equal(typeof model.index, 'number')
    assert.equal(typeof model.hasEfforts, 'boolean')
    assert.equal(Object.hasOwn(model, 'input'), false)
  }
  assertLossless('model_probe_status（双模型）', result)
})

test('scan 工具：被拒绝的返回值同样合格（带 needsEnable 的失败路径）', async () => {
  const { ctx, tools } = makeCtx({ section: sectionWithoutInput })
  apply(ctx)

  const result = await tools.find((t) => t.name === 'model_probe_scan').execute({ provider: 'cc-goat' }, {})
  assert.equal(result.ok, false)
  assert.equal(result.needsEnable, true)
  assertLossless('model_probe_scan（拒绝路径）', result)
})

test('apply 工具：未确认的返回值同样合格', async () => {
  const { ctx, tools } = makeCtx({ section: sectionWithoutInput })
  apply(ctx)

  const result = await tools.find((t) => t.name === 'model_probe_apply').execute({ provider: 'cc-goat', confirm: false }, {})
  assert.equal(result.ok, false)
  assertLossless('model_probe_apply（未确认）', result)
})

test('回归：未收口的同一份 payload 必然不合格（证明这道闸门真的在起作用）', async () => {
  // 直接手搓 buildStatus 的形状（对照 lib/index.js 的 providers 段）。若哪天有人把
  // 出口的 compact 去掉，上面的测试会失败，而这一条会继续通过 —— 两者一起说明
  // "失败不是因为判据太严，而是因为 payload 真的带了 undefined"。
  const raw = {
    ok: true,
    providers: [{
      id: 'cc-goat',
      models: [{ index: 0, id: 'm', input: Array.isArray(undefined) ? undefined : undefined }],
      probeEnabled: true,
    }],
  }
  assert.equal(judge(raw), false)
})

// ── HTTP 路由（设置页那条通道，issue #1 里只是"预计同样失败"）─────────────────
//
// 客户端边界的判据与工具通道是同一个（@deepseek-ai/dsh-api-gateway 用 isJsonValue），
// 所以设置页会以同样方式炸。这里把每条路由都真的调一遍。

test('HTTP 路由：/status 的报文合格（模型未声明 input）', async () => {
  const { ctx, routes } = makeCtx({ section: sectionWithoutInput })
  apply(ctx)

  const route = routes.find((r) => r.path === '/api/model-probe/status')
  const res = fakeRes()
  await route.handler(fakeReq({ method: 'GET' }), res)

  assert.equal(res.status, 200)
  // 过线的原始文本必须能无损还原：拿它直接喂判据。
  assert.equal(judge(JSON.parse(res.text)), true)
  assert.equal(Object.hasOwn(res.body.providers[0].models[0], 'input'), false)
  assert.equal(res.body.providers[0].models[0].maxTokens, 384000)
})

test('HTTP 路由：/policy 的报文合格', async () => {
  const { ctx, routes } = makeCtx({ section: sectionWithoutInput })
  apply(ctx)

  const policy = routes.find((r) => r.path === '/api/model-probe/policy')
  const policyRes = fakeRes()
  await policy.handler(fakeReq({ body: { enabledProviders: ['cc-goat'], visionProbe: false } }), policyRes)

  assert.equal(policyRes.status, 200)
  assert.equal(judge(JSON.parse(policyRes.text)), true)
  // /scan 的报文与 model_probe_scan 工具走同一份 runScan 结果，已在上面覆盖；
  // 这里不再调它——未被策略拦下时它会真的向端点发请求，测试会依赖网络。
})

test('HTTP 路由：/apply 的未确认报文合格', async () => {
  const { ctx, routes } = makeCtx({ section: sectionWithoutInput })
  apply(ctx)

  const route = routes.find((r) => r.path === '/api/model-probe/apply')
  const res = fakeRes()
  await route.handler(fakeReq({ body: { provider: 'cc-goat' } }), res)

  assert.equal(res.status, 400)
  assert.match(res.body.error, /确认/)
  assert.equal(judge(JSON.parse(res.text)), true)
})
