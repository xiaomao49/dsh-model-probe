/**
 * 客户端组件渲染测试。
 *
 * 为什么需要它：设置页白屏过一次，而客户端代码没有测试覆盖——这是个盲区。
 * 客户端跑在浏览器里、用 DSH 注入的模块加载器，看起来不好测；但实际上组件
 * 只是个函数，hooks 也可以用一个受控的替身执行。这样就能在 Node 里跑出真实
 * 渲染路径，把"白屏"这类问题变成有堆栈的失败。
 *
 * 夹具刻意使用从运行中的服务抓下来的**真实响应体**，而不是手写的假数据。
 * 手写夹具只能验证"我按自己的理解写的代码"，验证不了"真实形状对不对"——
 * 而形状不匹配恰恰是客户端 bug 最常见的原因。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(here, '..', 'lib', 'client.js')
const FIXTURE_DIR = join(here, 'fixtures')

// ── 受控 hooks 运行时 ────────────────────────────────────────────────────────
//
// 按调用顺序把预置值喂给每次 useState，从而直接渲染"已加载"状态，
// 而不需要 DOM、effect 或异步等待。

let hookIndex = 0
let hookValues = []
/** 模块缓存破坏计数器，见 loadComponent。 */
let importCounter = 0

const fakeReact = {
  createElement: (type, props, ...children) => {
    // React 会摊平嵌套数组，并把 children 也放进 props.children。
    // 夹具必须照做：类组件通过 this.props.children 取子元素，若只放在
    // 元素自己的 children 字段上，类组件就会读到 undefined。
    const flat = children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false)
    return {
      type,
      props: { ...(props ?? {}), children: flat.length === 1 ? flat[0] : flat },
      children: flat,
    }
  },
  useState: (init) => {
    const i = hookIndex++
    const value = i < hookValues.length ? hookValues[i] : typeof init === 'function' ? init() : init
    return [value, () => {}]
  },
  useCallback: (fn) => fn,
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }),
  // 类组件支持：错误边界需要它。
  Component: class {
    constructor(props) {
      this.props = props ?? {}
      this.state = {}
    }
    setState(patch) {
      Object.assign(this.state, typeof patch === 'function' ? patch(this.state) : patch)
    }
  },
}

/** 加载客户端包并取出注册到 settings.section 的组件。 */
async function loadComponent() {
  let definition
  globalThis.window = { __ModuleLoader__: { load: (def) => { definition = def } } }

  // 用单调递增的计数器破坏模块缓存。这里不能用 Date.now()：同一毫秒内连续
  // 调用会命中同一个 URL，第二次导入直接走缓存、不再触发 load()，导致测试
  // 随机失败。确定性比"看起来够随机"重要。
  importCounter += 1
  await import(`${CLIENT}?instance=${importCounter}`)

  assert.ok(definition, '客户端包应调用 window.__ModuleLoader__.load')
  assert.equal(definition.id, 'dsh-model-probe')

  const exports = definition.factory((name) => {
    if (name === 'react') return fakeReact
    throw new Error(`客户端意外 require 了未提供的模块：${name}`)
  })

  let component
  const slots = {
    inject: (_name, cb) => cb(),
    register: (_options, Component) => {
      component = Component
      return () => {}
    },
  }
  exports.apply({ get: (key) => (key === 'slots' ? slots : undefined) })
  assert.ok(component, '客户端应把组件注册进 settings.section')
  return component
}

/**
 * 用预置 hooks 渲染一次，返回完全展开的元素树。
 *
 * 必须展开函数组件：插槽注册的是包装组件 `() => React.createElement(Real)`，
 * 直接调用只能拿到一个"未渲染"的元素（其 type 才是真正的组件）。React 在
 * 渲染时会递归展开它，夹具也要照做，否则遍历不到任何文本，测试会假阳性通过。
 */
function render(Component, values) {
  hookIndex = 0
  hookValues = values
  return expand(Component({}))
}

/** 渲染但不展开最外层，便于取到错误边界这个类。 */
function renderRaw(Component, values) {
  hookIndex = 0
  hookValues = values
  return Component({})
}

/** 递归展开函数组件与类组件，直到只剩宿主元素（div/span/...）。 */
function expand(node) {
  if (node === null || node === undefined) return node
  if (typeof node === 'string' || typeof node === 'number') return node
  if (Array.isArray(node)) return node.map(expand)
  if (typeof node.type === 'function') {
    const proto = node.type.prototype
    // 类组件（错误边界）：实例化后调用 render。
    if (proto !== undefined && typeof proto.render === 'function') {
      const instance = new node.type(node.props ?? {})
      return expand(instance.render())
    }
    // 函数组件：调用它并把返回的元素继续展开。
    return expand(node.type(node.props ?? {}))
  }
  return { ...node, children: (node.children ?? []).map(expand) }
}

/** 深度遍历元素树，收集所有文本节点。 */
function collectText(node, out = []) {
  if (node === null || node === undefined) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out)
    return out
  }
  if (typeof node === 'object' && Array.isArray(node.children)) {
    for (const child of node.children) collectText(child, out)
  }
  return out
}

/** 统计元素节点数，用于确认确实渲染出了内容。 */
function countNodes(node) {
  if (node === null || node === undefined) return 0
  if (typeof node === 'string' || typeof node === 'number') return 0
  if (Array.isArray(node)) return node.reduce((n, c) => n + countNodes(c), 0)
  if (typeof node === 'object') return 1 + (node.children ?? []).reduce((n, c) => n + countNodes(c), 0)
  return 0
}

// ── 夹具 ─────────────────────────────────────────────────────────────────────

const STATUS_FIXTURE = {
  ok: true,
  providers: [
    {
      id: 'cc-goat',
      displayName: 'cc-goat',
      api: 'openai-completions',
      baseURL: 'https://api.commandcode.ai/provider/v1',
      modelCount: 2,
      models: [
        { index: 0, id: 'deepseek/deepseek-v4.1-flash', contextWindow: 1000000, maxTokens: 384000, hasEfforts: true, input: ['text', 'image'] },
        { index: 1, id: 'z-ai/glm-5.3-flash', contextWindow: 1048576, maxTokens: 131072, hasEfforts: true, input: ['text', 'image'] },
      ],
      probeEnabled: false,
      hasKey: true,
    },
  ],
  policy: { enabledProviders: [], maxRequestsPerScan: 60, visionProbe: true, toleranceRatio: 0.05 },
  scanning: false,
  revision: 7,
  policyPersisted: true,
}

/** 真实扫描响应；缺失时退回一个同形状的最小夹具。 */
function loadScanFixture() {
  const path = join(FIXTURE_DIR, 'scan-response.json')
  if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'))
  return {
    ok: true,
    scan: {
      provider: 'cc-goat',
      api: 'openai-completions',
      baseURL: 'https://example.invalid/v1',
      listingOk: true,
      budget: { requests: 7, outputTokens: 123, exhausted: false },
      models: [
        {
          model: 'deepseek/deepseek-v4.1-flash',
          index: 0,
          summary: { counts: { ok: 3, mismatch: 1 }, dangerous: 0, actionable: 1 },
          notes: ['端点拒绝 off：该模型无法关闭思考'],
          findings: [
            {
              field: 'reasoningEfforts',
              verdict: 'mismatch',
              current: { off: null, low: 'low' },
              measured: ['low', 'high'],
              evidence: '端点约束取证',
              confidence: 'high',
              note: '声明了端点未列出的档位 off',
            },
          ],
        },
      ],
    },
    plan: [{ kind: 'set', modelIndex: 0, field: 'reasoningEfforts', value: { low: 'low' }, path: 'providers.cc-goat.models.0.reasoningEfforts' }],
    opCount: 1,
  }
}

// ── 测试 ─────────────────────────────────────────────────────────────────────

test('客户端包导出 apply/inject 且注册到 settings.section', async () => {
  const Component = await loadComponent()
  assert.equal(typeof Component, 'function')
})

test('首屏（未加载）渲染出加载提示，不抛异常', async () => {
  const Component = await loadComponent()
  const tree = render(Component, [null])
  const text = collectText(tree).join(' ')
  assert.match(text, /加载中/)
})

test('已加载状态渲染出 provider 与模型，不抛异常', async () => {
  const Component = await loadComponent()
  const tree = render(Component, [STATUS_FIXTURE, '', null, {}])

  const text = collectText(tree).join(' ')
  assert.match(text, /模型配置实测/)
  assert.match(text, /cc-goat/)
  assert.match(text, /deepseek\/deepseek-v4\.1-flash/)
  assert.match(text, /z-ai\/glm-5\.3-flash/)
  // 必须真的渲染出内容——这正是白屏 bug 的反面。
  assert.ok(countNodes(tree) > 10, `渲染节点数过少：${countNodes(tree)}`)
})

test('带扫描结果的状态渲染出差异与写入计划，不抛异常', async () => {
  const Component = await loadComponent()
  const scan = loadScanFixture()
  const tree = render(Component, [STATUS_FIXTURE, '', null, { 'cc-goat': scan }])

  const text = collectText(tree).join(' ')
  assert.match(text, /次请求/)
  assert.match(text, /确认写入/)
  assert.ok(countNodes(tree) > 10)
})

test('空 provider 列表时给出可操作提示，而不是空白', async () => {
  const Component = await loadComponent()
  const empty = { ...STATUS_FIXTURE, providers: [] }
  const tree = render(Component, [empty, '', null, {}])
  const text = collectText(tree).join(' ')
  assert.match(text, /未发现 llm-pi-ai provider/)
  assert.ok(countNodes(tree) > 0)
})

test('缺少可选字段的状态不应导致崩溃（防御性渲染）', async () => {
  const Component = await loadComponent()
  // 模拟宿主侧字段缺失或版本差异：provider 缺 models、policy 缺字段。
  const sparse = {
    ok: true,
    providers: [{ id: 'p', modelCount: 0, models: [], probeEnabled: false }],
    policy: {},
  }
  const tree = render(Component, [sparse, '', null, {}])
  const text = collectText(tree).join(' ')
  assert.match(text, /p/)
})

test('扫描结果缺少可选字段时不应导致崩溃', async () => {
  const Component = await loadComponent()
  // 刻意给一个"骨架"扫描结果：notes/summary/findings 全缺。
  const skeleton = {
    ok: true,
    scan: {
      provider: 'p',
      budget: { requests: 1, outputTokens: 0 },
      models: [{ model: 'm', index: 0, summary: { counts: {} }, notes: [], findings: [] }],
    },
    plan: [],
    opCount: 0,
  }
  const tree = render(Component, [STATUS_FIXTURE, '', null, { 'cc-goat': skeleton }])
  assert.ok(countNodes(tree) > 0)
})

test('错误边界：渲染异常时降级为可读提示，而不是整片空白', async () => {
  const Component = await loadComponent()
  // 未展开的最外层就是错误边界类。
  const raw = renderRaw(Component, [STATUS_FIXTURE, '', null, {}])
  const Boundary = raw.type

  assert.equal(typeof Boundary.getDerivedStateFromError, 'function', '应实现 getDerivedStateFromError')

  // 模拟 React 在捕获异常后的行为：写入 error 状态再重新渲染。
  const instance = new Boundary({ children: null })
  Object.assign(instance.state, Boundary.getDerivedStateFromError(new Error('模拟渲染崩溃')))

  const text = collectText(expand(instance.render())).join(' ')
  assert.match(text, /渲染出错/)
  assert.match(text, /模拟渲染崩溃/)
  assert.match(text, /重试/)
})

test('错误边界：无错误时原样渲染子元素', async () => {
  const Component = await loadComponent()
  const Boundary = renderRaw(Component, [STATUS_FIXTURE, '', null, {}]).type
  const instance = new Boundary(renderRaw(Component, [STATUS_FIXTURE, '', null, {}]).props)

  assert.equal(instance.state.error, null)
  const tree = expand(instance.render())
  const text = collectText(tree).join(' ')
  assert.match(text, /模型配置实测/)
})

test('扫描进行中：按钮显示进度且禁用，不抛异常', async () => {
  const Component = await loadComponent()
  const scanning = { ...STATUS_FIXTURE, providers: [{ ...STATUS_FIXTURE.providers[0], probeEnabled: true }] }
  // busy 形如 "scan:<id>"，这是独立于静态渲染的一条路径。
  const tree = render(Component, [scanning, 'scan:cc-goat', null, {}])
  const text = collectText(tree).join(' ')
  assert.match(text, /扫描中/)
})

test('写入进行中：按钮显示进度文案，不抛异常', async () => {
  const Component = await loadComponent()
  const scan = loadScanFixture()
  const enabled = { ...STATUS_FIXTURE, providers: [{ ...STATUS_FIXTURE.providers[0], probeEnabled: true }] }
  const tree = render(Component, [enabled, 'apply:cc-goat', null, { 'cc-goat': scan }])
  const text = collectText(tree).join(' ')
  assert.match(text, /写入中/)
})

test('无待修正项时显示"无需改动"而不是空白的计划区', async () => {
  const Component = await loadComponent()
  const clean = {
    ok: true,
    scan: {
      provider: 'cc-goat',
      budget: { requests: 7, outputTokens: 120 },
      listingOk: true,
      models: [
        {
          model: 'm',
          index: 0,
          summary: { counts: { ok: 4 } },
          notes: [],
          findings: [{ field: 'maxTokens', verdict: 'ok', current: 100, measured: 100, confidence: 'high', evidence: 'x' }],
        },
      ],
    },
    plan: [],
    opCount: 0,
  }
  const tree = render(Component, [STATUS_FIXTURE, '', null, { 'cc-goat': clean }])
  const text = collectText(tree).join(' ')
  assert.match(text, /配置与实测一致/)
})

test('提示文案如实反映探测开关状态，不说"默认关闭"当已经开着', async () => {
  const Component = await loadComponent()

  // 已开启：应列出开启的 provider。
  const on = { ...STATUS_FIXTURE, policy: { ...STATUS_FIXTURE.policy, enabledProviders: ['cc-goat'] } }
  const onText = collectText(render(Component, [on, '', null, {}])).join(' ')
  assert.match(onText, /当前已开启探测：cc-goat/)
  assert.doesNotMatch(onText, /探测当前全部关闭/)

  // 全关：应明确说全部关闭。
  const offText = collectText(render(Component, [STATUS_FIXTURE, '', null, {}])).join(' ')
  assert.match(offText, /探测当前全部关闭/)
})

test('提示文案区分策略能否持久化', async () => {
  const Component = await loadComponent()

  const persisted = collectText(render(Component, [STATUS_FIXTURE, '', null, {}])).join(' ')
  assert.match(persisted, /会持久化到 settings\.yaml/)

  const volatile = { ...STATUS_FIXTURE, policyPersisted: false }
  const volatileText = collectText(render(Component, [volatile, '', null, {}])).join(' ')
  assert.match(volatileText, /重启后会重置为关闭/)
})
