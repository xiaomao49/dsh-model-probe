/**
 * 无损 JSON 边界的回归测试 —— 本文件存在的唯一理由，是拦住"工具返回值过不了闸门"这类 bug。
 *
 * 背景（真实故障，GitHub issue #1）：DSH 的取值边界（`dsh-util-values` 的
 * `isJsonValue` / `snapshotJsonValue`）把 `undefined` 与非有限数字判为**非法**，
 * 任何携带它们的对象都过不了闸门，工具通道直接抛
 * `tool "model_probe_status" returned invalid output: value is not lossless JSON`。
 *
 * 而 `JSON.stringify` 会静默丢掉 `undefined`、把 `NaN` 写成 `null` —— 两者语义不一致。
 * 插件原先照"JSON 会丢"的直觉写（可选字段直接写进对象），于是症状极其反直觉：
 *
 *   | 扫描结果                              | 工具是否可用 |
 *   |---------------------------------------|--------------|
 *   | 请求全失败，8 字段全 unknown           | ✅ 正常       |
 *   | 取证到 3 个字段、产生 2 处待修正        | ❌ 报错       |
 *
 * 探针坏着的时候工具能用，修好了反而挂。当时的 108 项测试全绿也没拦住它，原因就和
 * write-path.test.mjs 当初一样：**没有任何测试断言过返回值的"形状"本身**——测的都是
 * 业务语义（阈值、容差、写入路径），而取值边界是另一层契约。
 *
 * 所以这里做三件事：
 *   1. 用插件**自己导出的** `describeOps` 造出真实产物（不是手写的假对象），
 *      断言它未经收口时确实过不了判据；
 *   2. 断言收口后的工具返回值形状（status / scan / apply）全部合格；
 *   3. 逐条钉住 `compact` 的语义边界：`null` 保留、`NaN` 丢弃、`-0` 归一为 `0`、
 *      数组不留空洞、`__proto__` 不当成键。
 *
 * 判定器优先用宿主真实的 `isJsonValue`；拿不到时（CI 里插件是独立 checkout，
 * 没有 DSH 运行时）回退到下面这份逐条对应的复刻实现，并在测试输出里标注来源。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeOps, compact } from '../lib/scan.js'

// ── 判定器 ───────────────────────────────────────────────────────────────────

/** 复刻 `dsh-util-values` 的判据（源码：walkJsonValue，`true` 表示合格）。 */
async function loadJudge() {
  for (const spec of ['@deepseek-ai/dsh-util-values', '@deepseek-ai/dsh-tools']) {
    try {
      const mod = await import(spec)
      if (typeof mod.isJsonValue === 'function') {
        return { judge: mod.isJsonValue, source: `host ${spec}` }
      }
    } catch {
      // 继续尝试下一个来源；都不行时走下面的复刻实现。
    }
  }
  return { judge: referenceIsJsonValue, source: 'reference replica' }
}

/**
 * 与 walkJsonValue 逐条对应的复刻：null / boolean / string / 有限 number 合格；
 * `-0` 不合格；其余类型不合格；对象必须是普通对象（原型为 Object.prototype 或
 * null）、且所有自有属性可枚举、键都是字符串。
 */
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

const { judge, source } = await loadJudge()

// ── 真实产物：用插件自己的 describeOps 造出来的一行 ──────────────────────────

/**
 * 造一份"有东西可报"的扫描事实与 op，交给插件自己的 `describeOps` 展开。
 *
 * 关键点：`from` 在这里**必然不存在**——`reasoningEfforts` 是新增字段，旧条目里
 * 没有它。`describeOps` 直接写 `from: prev[key]`，于是产出的对象带一个 undefined
 * 属性。这不是我构造的假象，是插件真实的取值路径（issue #1 的 `$.plan[1].from`）。
 *
 * 另一个模型（index 1）的 finding 故意缺 `limit` 与 `note`，对应 issue 里的
 * `$.models[1].issues[0].limit = undefined`。
 */
function realPlanRows() {
  const scan = {
    rawModels: [
      { id: 'deepseek-v4.1-flash', contextWindow: 1000000, maxTokens: 384000 },
      { id: 'z-ai/glm-5.3-flash', contextWindow: 1048576, maxTokens: 384000 },
    ],
    models: [
      {
        index: 0,
        findings: [
          { field: 'maxTokens', verdict: 'ok', current: 384000, measured: 384000, evidence: '端点约束取证', confidence: 'high' },
        ],
      },
      {
        index: 1,
        findings: [
          // 缺 limit / note：这两条正是 issue 里 `$-models[1].issues[0]` 的那两个 undefined。
          { field: 'maxTokens', verdict: 'mismatch', current: 384000, measured: 131072, evidence: '端点约束取证', confidence: 'high' },
        ],
      },
    ],
  }
  const ops = [
    {
      op: 'set',
      path: ['providers', 'cc-goat', 'models'],
      value: [
        { id: 'deepseek-v4.1-flash', contextWindow: 1000000, maxTokens: 384000 },
        // reasoningEfforts 是新增字段 → 该行的 `from` 不存在。
        { id: 'z-ai/glm-5.3-flash', contextWindow: 1048576, maxTokens: 131072, reasoningEfforts: { low: 'low', high: 'high' } },
      ],
    },
  ]
  return describeOps(ops, scan)
}

// ── 工具返回值的三份形状 ─────────────────────────────────────────────────────
//
// 与 lib/index.js 各出口逐字对应：status 是 `buildStatus`（:186）、scan 是
// `model_probe_scan` 的 execute（:579）、apply 是 `runApply` 的返回（:376）。
// 这里刻意不 import 它们 —— lib/index.js 顶层 import 了 @deepseek-ai/dsh-tools，
// 独立 checkout 里加载不了；形状改动时下面的断言会失效，正好提醒同步。

/** 对应 `buildStatus` 的 providers 段：模型条目未声明 input 时那个键就是 undefined。 */
function statusPayload() {
  return {
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
          // 没有声明 input → `input: undefined`
          { index: 1, id: 'z-ai/glm-5.3-flash', contextWindow: 1048576, maxTokens: 131072, hasEfforts: true, input: undefined },
        ],
        probeEnabled: true,
        hasKey: true,
      },
    ],
    policy: { enabledProviders: ['cc-goat'], visionProbe: false, probeHeaderProviders: [] },
    scanning: false,
    revision: 12,
    policyPersisted: true,
    writable: true,
    writeBlockedReason: undefined,
  }
}

/** 对应 `model_probe_scan` 的返回值：issues 与 plan 直接来自扫描事实。 */
function scanPayload() {
  const plan = realPlanRows()
  return {
    ok: true,
    provider: 'cc-goat',
    budget: { requests: 24, limit: 60 },
    verification: { verifiedFields: 3, unknownFields: 5 },
    models: [
      {
        model: 'z-ai/glm-5.3-flash',
        summary: '越界 1 处',
        // findings 里 limit / note 缺值 → 这些 finding 带着 undefined 进入 issues
        issues: [
          { field: 'maxTokens', verdict: 'mismatch', current: 384000, measured: 131072, evidence: '端点约束取证', confidence: 'high', limit: undefined, note: undefined },
        ],
        notes: [],
      },
    ],
    plan,
    hint: `发现 ${plan.length} 处待修正。`,
  }
}

/** 对应 `runApply` 的返回：`from` 在字段新增时不存在，`verdict` 无 finding 时不存在。 */
function applyPayload() {
  return {
    ok: true,
    applied: realPlanRows().length,
    backup: '/home/u/.dsh/settings.yaml.bak-probe-1',
    changes: realPlanRows(),
    evidence: 'reviewed-scan',
  }
}

// ── 测试 ─────────────────────────────────────────────────────────────────────

test(`判据可用（来源：${source}）`, () => {
  assert.equal(judge({ a: 1, b: [true, null, 'x'] }), true)
  assert.equal(judge({ a: undefined }), false, 'undefined 属性必须被判为不合格')
  assert.equal(judge(Number.NaN), false)
  assert.equal(judge(-0), false)
})

test('describeOps 的真实产物未收口时确实过不了判据（故障复现）', () => {
  const plan = realPlanRows()
  // 模型 1 有两处改动：maxTokens 越界，reasoningEfforts 是新增字段。
  assert.equal(plan.length, 2, '应产出两行改动')
  const added = plan[1]
  assert.equal(added.field, 'reasoningEfforts', '第二行应是新增字段')
  // `from` 是**值为 undefined 的自有属性**：JSON.stringify 会把它连带键一起丢掉，
  // 所以报文里看不到，判据却看得见 —— 这正是当初工具挂掉的原因。
  assert.equal(Object.hasOwn(added, 'from'), true)
  assert.equal(added.from, undefined)
  assert.equal(Object.hasOwn(added, 'verdict'), true)
  assert.equal(added.verdict, undefined)
  assert.equal(judge(plan), false)
})

test('三份工具返回值收口后全部合格', () => {
  for (const [label, payload] of [
    ['model_probe_status', statusPayload()],
    ['model_probe_scan', scanPayload()],
    ['model_probe_apply', applyPayload()],
  ]) {
    assert.equal(judge(compact(payload)), true, `${label} 的返回值必须可无损 JSON 化`)
  }
})

test('compact 逐条钉住语义边界', () => {
  const input = {
    kept: 'x',
    nullStays: null,
    dropped: undefined,
    nan: Number.NaN,
    inf: Number.POSITIVE_INFINITY,
    negZero: -0,
    zero: 0,
    nested: { deep: { alsoDropped: undefined, ok: 1 } },
    list: [1, Number.NaN, 2, undefined, 3],
    objects: [{ a: undefined, b: 2 }],
  }
  const out = compact(input)

  assert.deepEqual(
    Object.keys(out).sort(),
    ['kept', 'list', 'negZero', 'nested', 'nullStays', 'objects', 'zero'],
    'undefined / NaN / Infinity 的键应消失，null 与 0 保留',
  )
  assert.equal(out.nullStays, null, 'null 是合法 JSON 值，必须保留')
  assert.equal(Object.hasOwn(out, 'dropped'), false)
  assert.equal(Object.hasOwn(out, 'nan'), false)
  assert.equal(Object.hasOwn(out, 'inf'), false)
  assert.equal(Object.is(out.negZero, 0), true, '-0 归一为 0（JSON 里无法区分）')
  assert.equal(Object.is(out.zero, 0), true)
  assert.deepEqual(out.nested, { deep: { ok: 1 } })
  assert.deepEqual(out.list, [1, 2, 3], '数组项被丢弃时不留空洞')
  assert.equal(out.list.length, 3)
  assert.deepEqual(out.objects, [{ b: 2 }])
  assert.equal(judge(out), true)
})

test('compact 不把 __proto__ 当成可写键（原型链安全）', () => {
  // JSON.parse 产出的 `__proto__` 是自有数据属性，普通赋值 `out[key] =` 会走
  // Object.prototype 的 setter 改写原型——这条断言就是拦它的。
  const hostile = JSON.parse('{"__proto__": {"polluted": true}, "safe": 1}')
  const out = compact(hostile)
  assert.equal(Object.getPrototypeOf(out), Object.prototype, '原型不应被改写')
  assert.equal({}.polluted, undefined, '不得污染 Object.prototype')
  assert.equal(out.safe, 1)
  // 原样保留为自有键：判据接受它，丢掉反而会让往返丢数据。
  assert.equal(Object.hasOwn(out, '__proto__'), true)
  assert.equal(Object.getOwnPropertyDescriptor(out, '__proto__').value.polluted, true)
  assert.equal(judge(out), true)
  assert.equal(JSON.parse(JSON.stringify(out)).safe, 1)
})

test('compact 不改动入参（返回值是新结构）', () => {
  const input = { a: undefined, b: { c: 1 } }
  const out = compact(input)
  assert.equal(Object.hasOwn(input, 'a'), true, '原对象应保持原样')
  assert.notEqual(out.b, input.b, '嵌套对象也应是新引用')
  assert.equal(out.b.c, 1)
})
