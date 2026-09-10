/**
 * 写入路径的集成测试 —— 本文件存在的唯一理由，是拦住"数组被路径操作摧毁"这类 bug。
 *
 * 背景（真实故障）：settings.mutate 的路径操作只在普通对象上遍历，
 * 遇到数组会把它当作"不存在的子对象"重建。于是 `providers.x.models.0.maxTokens`
 * 这样的路径会把整个 models 数组替换成 `{ '0': {...} }`，官方 schema 随即报
 * "expected array but got [object Object]"，写入整体失败，用户看到"写入失败"。
 *
 * 当时的测试之所以没拦住它：所有写入测试都替换掉了 settings.mutate，只断言
 * "ops 的形状符合我的预期"—— 而我的预期本身就是错的。桩测不出真实实现的语义。
 *
 * 所以这里做两件事：
 *   1. 复刻真实的 applyPathOp 语义（含那个 isPlainObject 判断），用它执行 ops；
 *   2. 把结果交给**官方 schema**（@deepseek-ai/dsh-llm-pi-ai 的 Config）校验。
 * 只要 ops 不能穿过数组，第 2 步必然抛错，测试立刻失败。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildProviderOps, applyFindings, auditModel, VERDICT } from '../lib/audit.js'
import { Config } from '@deepseek-ai/dsh-llm-pi-ai'

// ── 忠实复刻 dsh-settings 的路径操作语义 ─────────────────────────────────────
//
// 与 node_modules/@deepseek-ai/dsh-settings/lib/index.js 中 applyPathOp 的实现一致。
// 刻意保持逐行对应，包括那个导致故障的 isPlainObject 判断。

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function applyPathOp(section, op) {
  const [head, ...rest] = op.path
  if (head === undefined) {
    if (op.op === 'unset') return {}
    if (!isPlainObject(op.value)) throw new TypeError('settings mutate: setting the section root requires a plain object')
    return { ...op.value }
  }
  if (rest.length === 0) {
    if (op.op === 'set') return { ...section, [head]: op.value }
    const { [head]: _removed, ...kept } = section
    return kept
  }
  const child = section[head]
  if (!isPlainObject(child)) {
    if (op.op === 'unset') return section
    // 这一行就是故障源头：数组也被当成"非对象"，于是被整体重建为对象。
    return { ...section, [head]: applyPathOp({}, { ...op, path: rest }) }
  }
  return { ...section, [head]: applyPathOp(child, { ...op, path: rest }) }
}

/** 按真实实现依次应用 ops。 */
function applyOps(section, ops) {
  return ops.reduce(applyPathOp, section)
}

// ── 夹具 ─────────────────────────────────────────────────────────────────────

/** 贴近用户真实配置的 section。 */
function makeSection() {
  return {
    providers: {
      'cc-goat': {
        api: 'openai-completions',
        apiKeyEnv: 'CC_GOAT_API_KEY',
        baseURL: 'https://api.commandcode.ai/provider/v1',
        displayName: 'cc-goat',
        models: [
          {
            id: 'deepseek/deepseek-v4.1-flash',
            name: 'DeepSeek V4.1 Flash',
            contextWindow: 1000000,
            maxTokens: 384000,
            input: ['text', 'image'],
            // 端点拒绝 off，所以这一项应当被移除。
            reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
          },
          {
            id: 'z-ai/glm-5.3-flash',
            name: 'GLM-5.3 Flash',
            contextWindow: 1048576,
            maxTokens: 131072,
            input: ['text', 'image'],
            reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
          },
        ],
      },
    },
  }
}

/** 构造"端点只接受 low/medium/high/xhigh/max"的审计结论。 */
function perModelFromSection(section) {
  const models = section.providers['cc-goat'].models
  return models.map((entry, index) => ({
    index,
    model: entry.id,
    findings: auditModel({
      current: entry,
      measured: {
        reasoningEfforts: {
          value: ['low', 'medium', 'high', 'xhigh', 'max'],
          confidence: 'high',
          evidence: '端点约束取证',
        },
      },
    }),
  }))
}

// ── 测试 ─────────────────────────────────────────────────────────────────────

test('回归：写入操作必须能被真实路径语义执行且通过官方 schema 校验', () => {
  const section = makeSection()
  const ops = buildProviderOps({
    provider: 'cc-goat',
    models: section.providers['cc-goat'].models,
    perModel: perModelFromSection(section),
  })

  assert.equal(ops.length, 1, '应当只产生一个整体写数组的操作')

  // 第 1 步：用真实语义执行。若 ops 试图穿过数组，这步就会把 models 变成对象。
  const next = applyOps(section, ops)

  // 第 2 步：官方 schema 校验。这是决定性的断言。
  assert.doesNotThrow(
    () => Config(next),
    '写入结果未通过官方 schema 校验 —— 说明 ops 破坏了数组结构',
  )

  // 第 3 步：逐项确认结果正确。
  const models = next.providers['cc-goat'].models
  assert.ok(Array.isArray(models), 'models 必须仍是数组')
  assert.equal(models.length, 2)
  for (const m of models) {
    assert.equal('off' in m.reasoningEfforts, false, '被端点拒绝的 off 档必须移除')
    assert.deepEqual(Object.keys(m.reasoningEfforts), ['low', 'medium', 'high', 'xhigh', 'max'])
  }
})

test('回归：操作路径不得穿过数组（结构性约束）', () => {
  const section = makeSection()
  const ops = buildProviderOps({
    provider: 'cc-goat',
    models: section.providers['cc-goat'].models,
    perModel: perModelFromSection(section),
  })

  for (const op of ops) {
    const modelsAt = op.path.indexOf('models')
    assert.notEqual(modelsAt, -1)
    // 'models' 必须是路径的最后一段：再往下走就会进入数组元素，
    // 而路径操作不支持数组，会把数组摧毁。
    assert.equal(
      modelsAt,
      op.path.length - 1,
      `路径 ${op.path.join('.')} 试图穿过数组，这会把 models 替换成对象`,
    )
    assert.ok(Array.isArray(op.value), '写 models 的值必须是数组')
  }
})

/** 构造一个"必然要改"的审计结论：当前值越界（500000 > 393216）。 */
function outOfRangeFindings(entry) {
  return auditModel({
    current: entry,
    measured: {
      maxTokens: {
        value: 393216,
        confidence: 'high',
        evidence: '端点约束取证',
        constraintMin: 1,
        constraintMax: 393216,
      },
    },
  })
}

test('写入保留未参与审计的字段与模型条目', () => {
  const section = makeSection()
  // 把 0 号模型改成一个越界值，确保它必须被修正。
  section.providers['cc-goat'].models[0].maxTokens = 500000

  const perModel = [{ index: 0, findings: outOfRangeFindings(section.providers['cc-goat'].models[0]) }]
  const ops = buildProviderOps({ provider: 'cc-goat', models: section.providers['cc-goat'].models, perModel })
  const next = applyOps(section, ops)
  const models = next.providers['cc-goat'].models

  // 未涉及的模型一字未动。
  assert.deepEqual(models[1], section.providers['cc-goat'].models[1])
  // 涉及到的模型只改了目标字段，其它字段保留。
  assert.equal(models[0].maxTokens, 393216)
  assert.equal(models[0].name, 'DeepSeek V4.1 Flash')
  assert.equal(models[0].contextWindow, 1000000)
  assert.deepEqual(models[0].input, ['text', 'image'])
  assert.deepEqual(Object.keys(models[0].reasoningEfforts), ['off', 'low', 'medium', 'high', 'xhigh', 'max'])
})

test('无改动时不产生任何操作（不制造无意义的写入）', () => {
  const section = makeSection()
  const models = section.providers['cc-goat'].models
  // 配置已经与实测一致。
  const perModel = models.map((entry, index) => ({
    index,
    findings: auditModel({
      current: entry,
      measured: {
        reasoningEfforts: {
          value: ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
          confidence: 'high',
          evidence: 'x',
        },
      },
    }),
  }))
  assert.deepEqual(buildProviderOps({ provider: 'cc-goat', models, perModel }), [])
})

test('only 限定字段时只改指定字段', () => {
  const section = makeSection()
  const models = section.providers['cc-goat'].models
  models[0].maxTokens = 500000
  const perModel = [
    {
      index: 0,
      findings: auditModel({
        current: models[0],
        measured: {
          maxTokens: {
            value: 393216,
            confidence: 'high',
            evidence: 'x',
            constraintMin: 1,
            constraintMax: 393216,
          },
          reasoningEfforts: { value: ['low', 'high'], confidence: 'high', evidence: 'x' },
        },
      }),
    },
  ]
  const ops = buildProviderOps({ provider: 'cc-goat', models, perModel, only: ['maxTokens'] })
  const next = applyOps(section, ops)
  assert.equal(next.providers['cc-goat'].models[0].maxTokens, 393216)
  // reasoningEfforts 未在 only 内，保持原样。
  assert.equal('off' in next.providers['cc-goat'].models[0].reasoningEfforts, true)
})

test('写回的值是纯 JSON，不带冻结引用或原型（可被真实 persist 序列化）', () => {
  const section = makeSection()
  section.providers['cc-goat'].models[0].maxTokens = 500000
  // 模拟真实 settings 的行为：值被深度冻结。
  const deepFreeze = (v) => {
    if (v !== null && typeof v === 'object') {
      Object.values(v).forEach(deepFreeze)
      Object.freeze(v)
    }
    return v
  }
  deepFreeze(section)

  const models = section.providers['cc-goat'].models
  const perModel = [{ index: 0, findings: outOfRangeFindings(models[0]) }]
  const ops = buildProviderOps({ provider: 'cc-goat', models, perModel })
  // 必须能被 JSON 序列化，且不携带冻结状态 —— 真实实现会 cloneJsonShaped。
  const cloned = JSON.parse(JSON.stringify(ops[0].value))
  assert.equal(cloned[0].maxTokens, 393216)
  assert.equal(Object.isFrozen(cloned[0]), false)
  // 原始冻结对象未被改动。
  assert.equal(models[0].maxTokens, 500000)
})

test('applyFindings 不就地修改输入条目', () => {
  const entry = { id: 'm', maxTokens: 100, name: 'X' }
  const findings = [
    { field: 'maxTokens', verdict: VERDICT.MISMATCH, measured: 200, confidence: 'high', evidence: 'x' },
  ]
  const result = applyFindings(entry, findings)
  assert.equal(result.entry.maxTokens, 200)
  assert.equal(entry.maxTokens, 100, '输入必须保持不变')
  assert.deepEqual(result.fields, ['maxTokens'])
})

test('applyFindings：unknown / ok 一律不动', () => {
  const entry = { id: 'm', maxTokens: 100 }
  const findings = [
    { field: 'maxTokens', verdict: VERDICT.OK, measured: 100 },
    { field: 'contextWindow', verdict: VERDICT.UNKNOWN, measured: undefined },
  ]
  const result = applyFindings(entry, findings)
  assert.equal(result.changed, false)
  assert.deepEqual(result.entry, entry)
})

// ── 端到端：真实扫描结论 → 生成操作 → 真实语义执行 → 官方 schema 校验 ────────

test('端到端：用真实扫描夹具走完 planOps → 写入 → schema 校验', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const { dirname, join } = await import('node:path')
  const { planOps, describeOps } = await import('../lib/scan.js')

  const here = dirname(fileURLToPath(import.meta.url))
  const fixturePath = join(here, 'fixtures', 'scan-response.json')
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))

  // 夹具里的结论来自对 cc-goat 的真实探测（模型 id、档位集合都是真的）。
  const section = makeSection()
  const rawModels = section.providers['cc-goat'].models

  const scan = {
    ok: true,
    provider: 'cc-goat',
    models: fixture.scan.models,
    rawModels,
  }

  const ops = planOps(scan)
  assert.equal(ops.length, 1, '应产生一个整体写 models 的操作')
  assert.deepEqual(ops[0].path, ['providers', 'cc-goat', 'models'])

  // 真实路径语义执行 + 官方 schema 校验。
  const next = applyOps(section, ops)
  assert.doesNotThrow(() => Config(next), '端到端写入结果必须通过官方 schema')

  const models = next.providers['cc-goat'].models
  assert.equal(models.length, 2)
  for (const m of models) {
    assert.equal('off' in m.reasoningEfforts, false)
    assert.deepEqual(Object.keys(m.reasoningEfforts), ['low', 'medium', 'high', 'xhigh', 'max'])
    // 未被审计的字段必须原样保留。
    assert.ok(m.name && m.contextWindow && m.maxTokens && m.input)
  }

  // 预览行必须是字段级的，用户才能复核。
  const rows = describeOps(ops, scan)
  assert.ok(rows.length > 0)
  for (const row of rows) {
    assert.equal(row.field, 'reasoningEfforts')
    assert.equal(typeof row.model, 'string')
    assert.match(row.path, /^providers\.cc-goat\.models\[\d+\]\./)
  }
})

test('端到端：配置已一致时不产生任何操作', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const { dirname, join } = await import('node:path')
  const { planOps } = await import('../lib/scan.js')

  const here = dirname(fileURLToPath(import.meta.url))
  const fixture = JSON.parse(readFileSync(join(here, 'fixtures', 'scan-response.json'), 'utf8'))

  // 先把 off 去掉，模拟"已经修好"的状态。
  const section = makeSection()
  for (const m of section.providers['cc-goat'].models) {
    delete m.reasoningEfforts.off
  }

  const scan = {
    ok: true,
    provider: 'cc-goat',
    models: fixture.scan.models,
    rawModels: section.providers['cc-goat'].models,
  }
  assert.deepEqual(planOps(scan), [], '已一致的配置不应再产生写入')
})

test('值未真正变化时不产生写入（避免整数组重写与无用备份）', () => {
  // 结论说"要改"，但算出来的值与现值相同 —— 例如档位集合一致、只是键顺序不同。
  // 这种情况必须判为无改动，否则会产生一次无意义的整数组重写 + 备份文件。
  const entry = {
    id: 'm',
    reasoningEfforts: { low: 'low', medium: 'medium', high: 'high' },
  }
  const findings = [
    {
      field: 'reasoningEfforts',
      verdict: VERDICT.MISMATCH,
      // 同一集合，但顺序不同。
      measured: ['high', 'low', 'medium'],
      confidence: 'high',
      evidence: 'x',
    },
  ]
  const result = applyFindings(entry, findings)
  assert.equal(result.changed, false, '值等价就不该算改动')
  assert.deepEqual(buildProviderOps({ provider: 'p', models: [entry], perModel: [{ index: 0, findings }] }), [])
})

test('值确有变化时照常产生写入', () => {
  const entry = { id: 'm', reasoningEfforts: { low: 'low' } }
  const findings = [
    { field: 'reasoningEfforts', verdict: VERDICT.MISMATCH, measured: ['low', 'high'], confidence: 'high', evidence: 'x' },
  ]
  const ops = buildProviderOps({ provider: 'p', models: [entry], perModel: [{ index: 0, findings }] })
  assert.equal(ops.length, 1)
  assert.deepEqual(ops[0].value[0].reasoningEfforts, { low: 'low', high: 'high' })
})

test('端到端：写入结果不得包含 schema materialize 的默认字段', () => {
  // 这是"污染"事故的直接回归。真实流程里，读取若用 get() 解析值，
  // 模型条目会带上 compat:{chatTemplateKwargs:{},chatTemplateArgs:{}} 这类空壳，
  // 写回后就被永久固化进用户的 settings.yaml。
  //
  // 这里用官方 schema 亲自算出解析值，证明它确实带默认字段 —— 然后断言
  // 我们基于原始层构造的写入结果不含它们。
  const rawSection = makeSection()
  const resolved = Config(rawSection)

  // 前提确认：解析值确实被 materialize 了默认字段（否则这个测试没有意义）。
  const resolvedModel = resolved.providers['cc-goat'].models[0]
  assert.ok(
    resolvedModel.compat !== undefined,
    '前置条件：schema 应当为 compat 填充默认值，否则本测试失去意义',
  )

  // 用**原始层**（而非解析值）作为写入依据。
  const rawModels = rawSection.providers['cc-goat'].models
  assert.equal('compat' in rawModels[0], false, '原始层不应含 compat')

  const perModel = rawModels.map((entry, index) => ({
    index,
    findings: auditModel({
      current: entry,
      measured: {
        reasoningEfforts: { value: ['low', 'high'], confidence: 'high', evidence: 'x' },
      },
    }),
  }))

  const ops = buildProviderOps({ provider: 'cc-goat', models: rawModels, perModel })
  const next = applyOps(rawSection, ops)
  const written = next.providers['cc-goat'].models

  for (const m of written) {
    assert.equal('compat' in m, false, `写入结果不应含 schema 默认字段 compat：${JSON.stringify(m.compat)}`)
    // 只保留用户原本写过的字段 + 本次修改的字段。
    assert.deepEqual(
      Object.keys(m).sort(),
      ['contextWindow', 'id', 'input', 'maxTokens', 'name', 'reasoningEfforts'],
    )
  }
})

test('端到端：基于解析值写入会污染配置（记录这个陷阱本身）', () => {
  // 反向验证：故意用解析值走一遍，确认它确实会带出默认字段。
  // 这个测试不是"期望的行为"，而是把陷阱固化成可执行的证据，
  // 让后来者一眼看到为什么必须读原始层。
  const resolved = Config(makeSection())
  const polluted = resolved.providers['cc-goat'].models[0]

  assert.ok(polluted.compat, '解析值带 compat 默认字段 —— 这正是不能用它写回的原因')
  assert.deepEqual(polluted.compat.chatTemplateKwargs, {})
  assert.deepEqual(polluted.compat.chatTemplateArgs, {})
})
