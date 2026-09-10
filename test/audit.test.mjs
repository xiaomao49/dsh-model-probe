/**
 * 审计逻辑测试。
 *
 * 最关键的用例是 "GLM 384000 越界"：那是真实发生过的配置错误，每次请求都会
 * 400。这条测试锁住的是本插件存在的理由——如果它不能抓出这个，就没有价值。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  auditModel,
  buildProviderOps,
  readModelEntry,
  declaredLevels,
  summarize,
  VERDICT,
} from '../lib/audit.js'

/**
 * 便捷包装：对单个模型求写入操作。
 *
 * 写入是"整体替换 models 数组"（路径操作无法穿过数组），所以这里把单模型
 * 包装成一次 provider 级写入，测试关注点仍在字段判定上。
 */
function opsFor(entry, findings, opts = {}) {
  return buildProviderOps({
    provider: opts.provider ?? 'p',
    models: [entry],
    perModel: [{ index: 0, findings }],
    only: opts.only,
  })
}

/** 取出写入后的该模型条目；无可写内容时返回 undefined。 */
function written(entry, findings, opts = {}) {
  const ops = opsFor(entry, findings, opts)
  return ops.length === 0 ? undefined : ops[0].value.find((m) => m.id === entry.id)
}

/** 构造实测事实的辅助函数。 */
const fact = (value, confidence = 'high', evidence = 'endpoint-constraint', extra = {}) => ({
  value,
  confidence,
  evidence,
  ...extra,
})

test('回归：GLM maxTokens=384000 必须判为越界（真实发生过的配置错误）', () => {
  // 现场：settings.yaml 里 glm-5.3-flash 写着 maxTokens: 384000，
  // 而端点合法上界是 131072 —— 每次请求都会 400。
  const current = { id: 'z-ai/glm-5.3-flash', maxTokens: 384000 }
  const measured = {
    maxTokens: fact(131072, 'high', 'endpoint-constraint', { constraintMax: 131072, constraintMin: 1 }),
  }
  const findings = auditModel({ current, measured })
  const mt = findings.find((f) => f.field === 'maxTokens')

  assert.equal(mt.verdict, VERDICT.OUT_OF_RANGE)
  assert.equal(mt.limit, 131072)
  assert.match(mt.note, /超过端点合法上界/)
})

test('审计：低于上限的合法值判为 ok，不做无谓改动（判定刻意不对称）', () => {
  // 384000 ≤ 393216，完全合法。很多人刻意留安全余量，不该为了"顶满上限"
  // 去改用户配置——那只是扰动。只有【超过】上界才会让请求失败。
  const current = { id: 'deepseek/deepseek-v4.1-flash', maxTokens: 384000 }
  const measured = {
    maxTokens: fact(393216, 'high', 'endpoint-constraint', { constraintMin: 1, constraintMax: 393216 }),
  }
  const findings = auditModel({ current, measured })
  const mt = findings.find((f) => f.field === 'maxTokens')

  assert.equal(mt.verdict, VERDICT.OK)
  // 且不产生任何写入。
  assert.deepEqual(opsFor(current, findings, { provider: 'p' }), [])
})

test('审计：越界判定严格以硬约束为准，容差不得放松它', () => {
  const measured = {
    maxTokens: fact(131072, 'high', 'endpoint-constraint', { constraintMin: 1, constraintMax: 131072 }),
  }
  const at = (v) => auditModel({ current: { id: 'x', maxTokens: v }, measured }).find((f) => f.field === 'maxTokens')

  assert.equal(at(131072).verdict, VERDICT.OK) // 正好顶到上限
  assert.equal(at(131071).verdict, VERDICT.OK) // 低一，差距远小于容差
  assert.equal(at(131073).verdict, VERDICT.OUT_OF_RANGE) // 超一即越界
  assert.equal(at(0).verdict, VERDICT.OUT_OF_RANGE) // 低于下界
  // 界内的值绝不会被判越界——它最多因差距过大被判"不符"（见下一条测试）。
  assert.notEqual(at(1).verdict, VERDICT.OUT_OF_RANGE)
})

test('审计：距实测值过远的合法值会被覆盖（容差的双向性）', () => {
  // 注意这与"越界"不同：131072 的下界是 1，所以 1 是合法的；
  // 但它距实测上限 131072 差了 99.99%，远超容差，因此会被判为不符并覆盖。
  // 这是用户明确要求的行为：有值但差距超 5% → 覆盖。
  const measured = {
    maxTokens: fact(131072, 'high', 'endpoint-constraint', { constraintMin: 1, constraintMax: 131072 }),
  }
  const mt = auditModel({ current: { id: 'x', maxTokens: 1 }, measured }).find((f) => f.field === 'maxTokens')
  assert.equal(mt.verdict, VERDICT.MISMATCH)
  assert.match(mt.note, /超出 5% 容差/)
})

test('审计：正确值判为 ok，不做无意义的改写', () => {
  const current = { id: 'x', maxTokens: 131072, contextWindow: 1048576 }
  const measured = {
    maxTokens: fact(131072, 'high', 'endpoint-constraint', { constraintMax: 131072 }),
    contextWindow: fact(1048576, 'high', 'endpoint-listing'),
  }
  const findings = auditModel({ current, measured })
  assert.equal(findings.find((f) => f.field === 'maxTokens').verdict, VERDICT.OK)
  assert.equal(findings.find((f) => f.field === 'contextWindow').verdict, VERDICT.OK)
  // ok 不产生任何写入操作。
  assert.deepEqual(opsFor(current, findings, { provider: 'p' }), [])
})

test('审计：缺失字段判为 missing 并补齐', () => {
  const current = { id: 'x' }
  const measured = { maxTokens: fact(65536, 'high', 'endpoint-constraint', { constraintMax: 65536 }) }
  const findings = auditModel({ current, measured })
  assert.equal(findings.find((f) => f.field === 'maxTokens').verdict, VERDICT.MISSING)

  const ops = opsFor(current, findings, { provider: 'cc-goat' })
  // 写入形态是"整体替换 models 数组"：路径操作无法穿过数组。
  assert.equal(ops.length, 1)
  assert.deepEqual(ops[0].path, ['providers', 'cc-goat', 'models'])
  assert.ok(Array.isArray(ops[0].value))
  assert.equal(ops[0].value[0].maxTokens, 65536)
})

test('审计：无证据的字段一律 unknown，且绝不写入', () => {
  const current = { id: 'x', maxTokens: 384000 }
  // 端点没给出任何约束（例如它接受超范围值，或网络失败）。
  const findings = auditModel({ current, measured: {} })
  assert.ok(findings.every((f) => f.verdict === VERDICT.UNKNOWN))
  assert.deepEqual(opsFor(current, findings, { provider: 'p' }), [])
})

test('审计：档位缺少端点支持的项 → 提示补齐', () => {
  const current = { id: 'x', reasoningEfforts: { off: null, low: 'low' } }
  const measured = { reasoningEfforts: fact(['low', 'medium', 'high', 'xhigh', 'max'], 'high', 'endpoint-constraint') }
  const f = auditModel({ current, measured }).find((x) => x.field === 'reasoningEfforts')

  assert.equal(f.verdict, VERDICT.MISMATCH)
  assert.deepEqual(f.missing, ['medium', 'high', 'xhigh', 'max'])
  assert.deepEqual(f.extra, ['off'])
  assert.match(f.note, /缺少端点支持的档位/)
})

test('审计：声明了端点未列出的档位要明确指出风险', () => {
  const current = { id: 'x', reasoningEfforts: { low: 'low', ultra: 'ultra' } }
  const measured = { reasoningEfforts: fact(['low', 'high'], 'high', 'endpoint-constraint') }
  const f = auditModel({ current, measured }).find((x) => x.field === 'reasoningEfforts')
  assert.deepEqual(f.extra, ['ultra'])
  assert.match(f.note, /可能导致请求失败/)
})

test('构建档位声明：端点拒绝 off 时不应声明 off 档', () => {
  // 这是实测发现的语义陷阱：cc-goat 拒绝 off，意味着无法关闭思考。
  // 若仍然声明 off，UI 会出现一个选了也没用的选项。
  const findings = [
    {
      field: 'reasoningEfforts',
      verdict: VERDICT.MISMATCH,
      measured: ['low', 'medium', 'high', 'xhigh', 'max'], // 注意：不含 off
    },
  ]
  const efforts = written({ id: 'x' }, findings, { provider: 'p' }).reasoningEfforts
  assert.equal('off' in efforts, false)
  assert.deepEqual(efforts, { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' })
})

test('构建档位声明：端点接受 off 时声明为空值（支持但不发送参数）', () => {
  const findings = [
    { field: 'reasoningEfforts', verdict: VERDICT.MISSING, measured: ['off', 'low', 'high'] },
  ]
  // off 的值为 null，对应 YAML 里的 `off:`（留空）。
  const efforts = written({ id: 'x' }, findings, { provider: 'p' }).reasoningEfforts
  assert.deepEqual(efforts, { low: 'low', high: 'high', off: null })
})

test('构建操作：only 参数可限定字段范围', () => {
  const findings = auditModel({
    current: { id: 'x' },
    measured: {
      maxTokens: fact(65536, 'high', 'endpoint-constraint', { constraintMax: 65536 }),
      contextWindow: fact(1000000, 'high', 'endpoint-listing'),
    },
  })
  const entry = written({ id: 'x' }, findings, { provider: 'p', only: ['maxTokens'] })
  assert.equal(entry.maxTokens, 65536)
  // contextWindow 不在 only 内，不应被写入。
  assert.equal('contextWindow' in entry, false)
})

test('读取模型条目：定位下标供路径写入使用', () => {
  const section = { providers: { p: { models: [{ id: 'a' }, { id: 'b' }] } } }
  assert.equal(readModelEntry(section, 'p', 'b').index, 1)
  assert.equal(readModelEntry(section, 'p', 'zzz').index, -1)
  assert.equal(readModelEntry(section, 'nope', 'a').index, -1)
  assert.equal(readModelEntry(undefined, 'p', 'a').index, -1)
})

test('档位归一化：false 表示明确不支持，undefined 表示未声明', () => {
  assert.deepEqual(declaredLevels({ reasoningEfforts: false }), [])
  assert.equal(declaredLevels({}), undefined)
  assert.deepEqual(declaredLevels({ reasoningEfforts: { off: null, high: 'high' } }), ['off', 'high'])
})

test('概览统计：危险项与可操作项分别计数', () => {
  const findings = [
    { verdict: VERDICT.OUT_OF_RANGE },
    { verdict: VERDICT.MISMATCH },
    { verdict: VERDICT.OK },
    { verdict: VERDICT.UNKNOWN },
  ]
  const s = summarize(findings)
  assert.equal(s.dangerous, 1)
  assert.equal(s.actionable, 2)
})
