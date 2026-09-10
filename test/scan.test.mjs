/**
 * 容差策略测试。
 *
 * 语义（用户定义）：当前值已有值、且与实测值的差距在 5% 以内 → 保持不动；
 * 超过 5% → 覆盖为实测值。
 *
 * 这个策略的目的是**避免无谓的配置扰动**。同样的能力常因单位约定（1M vs 1MiB）
 * 或厂商微调产生微小差异，为这种差异改写用户配置只会制造噪音，还会让"扫描"
 * 变成一件让人不敢跑的操作。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_POLICY } from '../lib/scan.js'
import {
  auditModel,
  buildProviderOps,
  withinTolerance,
  relativeGap,
  formatGap,
  VERDICT,
  DEFAULT_TOLERANCE_RATIO,
} from '../lib/audit.js'

/** 实测事实构造器。 */
const fact = (value, extra = {}) => ({
  value,
  confidence: 'high',
  evidence: 'endpoint-constraint',
  ...extra,
})

/**
 * 便捷包装：对单个模型求写入操作。
 *
 * 写入形态是"整体替换 models 数组"——settings 的路径操作无法穿过数组，
 * 逐字段路径会把数组摧毁成对象。测试关注点仍在字段判定上。
 */
function opsFor(findingList, opts = {}) {
  const entry = opts.entry ?? { id: 'x' }
  return buildProviderOps({
    provider: opts.provider ?? 'p',
    models: [entry],
    perModel: [{ index: 0, findings: findingList }],
  })
}

/** 取出写入后的模型条目；无可写内容时返回 undefined。 */
function written(findingList, opts = {}) {
  const ops = opsFor(findingList, opts)
  return ops.length === 0 ? undefined : ops[0].value[0]
}

test('默认容差为 5%', () => {
  assert.equal(DEFAULT_POLICY.toleranceRatio, 0.05)
  assert.equal(DEFAULT_TOLERANCE_RATIO, 0.05)
})

test('容差判定：边界内为真，边界外为假', () => {
  assert.equal(withinTolerance(100, 100, 0.05), true) // 完全相同
  assert.equal(withinTolerance(95, 100, 0.05), true) // 恰好 5% 差
  assert.equal(withinTolerance(105, 100, 0.05), true) // 恰好 5% 差（上方）
  assert.equal(withinTolerance(94, 100, 0.05), false) // 6% 差
  assert.equal(withinTolerance(106, 100, 0.05), false)
})

test('容差判定：非法输入一律为假，避免误判成功', () => {
  assert.equal(withinTolerance(undefined, 100), false)
  assert.equal(withinTolerance(100, undefined), false)
  assert.equal(withinTolerance(Number.NaN, 100), false)
  assert.equal(withinTolerance(100, Number.NaN), false)
  assert.equal(withinTolerance('100', 100), false)
  // measured 为 0 时只有 current 也是 0 才算在容差内。
  assert.equal(withinTolerance(0, 0), true)
  assert.equal(withinTolerance(5, 0), false)
})

test('用户真实场景：deepseek 的 384000 距实测 393216 只差 2.3%，保持不动', () => {
  // 这是用户配置里的实际值。它刻意为上限留了一点余量，不该被改写。
  const current = { id: 'deepseek/deepseek-v4.1-flash', maxTokens: 384000 }
  const measured = {
    maxTokens: fact(393216, { constraintMin: 1, constraintMax: 393216 }),
  }
  const findings = auditModel({ current, measured })
  const mt = findings.find((f) => f.field === 'maxTokens')

  assert.equal(mt.verdict, VERDICT.OK)
  assert.ok(Math.abs(mt.gapRatio - 0.0234) < 0.001)
  // 关键：不产生任何写入，配置保持原样。
  assert.deepEqual(opsFor(findings), [])
})

test('用户真实场景：GLM 的 131072 与实测完全一致，保持不动', () => {
  const current = { id: 'z-ai/glm-5.3-flash', maxTokens: 131072 }
  const measured = { maxTokens: fact(131072, { constraintMin: 1, constraintMax: 131072 }) }
  const mt = auditModel({ current, measured }).find((f) => f.field === 'maxTokens')
  assert.equal(mt.verdict, VERDICT.OK)
})

test('差距超过 5% 时覆盖为实测值', () => {
  const current = { id: 'x', maxTokens: 100000 } // 距 393216 差 74.6%
  const measured = { maxTokens: fact(393216, { constraintMin: 1, constraintMax: 393216 }) }
  const findings = auditModel({ current, measured })
  const mt = findings.find((f) => f.field === 'maxTokens')

  assert.equal(mt.verdict, VERDICT.MISMATCH)
  assert.match(mt.note, /超出 5% 容差/)

  assert.equal(written(findings).maxTokens, 393216)
})

test('越界优先于容差：差距再小，只要越过硬约束就必须修', () => {
  // 400000 距上限 393216 只差 1.7%，落在 5% 容差内——
  // 但它越界了，请求会被 400 拒绝，所以必须判为越界而非"可接受"。
  const current = { id: 'x', maxTokens: 400000 }
  const measured = { maxTokens: fact(393216, { constraintMin: 1, constraintMax: 393216 }) }
  const mt = auditModel({ current, measured }).find((f) => f.field === 'maxTokens')

  assert.equal(mt.verdict, VERDICT.OUT_OF_RANGE)
  assert.ok(relativeGap(400000, 393216) < 0.05, '前提：差距确实在容差内')
})

test('容差可配置：调大后更宽松，调零后要求完全一致', () => {
  const measured = { maxTokens: fact(100, { constraintMin: 1, constraintMax: 1000 }) }
  const at = (v, tol) =>
    auditModel({ current: { id: 'x', maxTokens: v }, measured, tolerance: tol }).find(
      (f) => f.field === 'maxTokens',
    ).verdict

  assert.equal(at(94, 0.05), VERDICT.MISMATCH) // 6% 差，默认容差下要改
  assert.equal(at(94, 0.1), VERDICT.OK) // 容差放到 10% 就不改
  assert.equal(at(99, 0), VERDICT.MISMATCH) // 容差为 0 时只接受完全相等
  assert.equal(at(100, 0), VERDICT.OK)
})

test('contextWindow 同样适用容差：1M 与 1MiB 的差异不该引发改写', () => {
  // 1000000 与 1048576 相差 4.6%，落在容差内 —— 这是单位约定差异，不是错误。
  const current = { id: 'x', contextWindow: 1000000 }
  const measured = { contextWindow: fact(1048576, { evidence: 'endpoint-listing' }) }
  const mt = auditModel({ current, measured }).find((f) => f.field === 'contextWindow')
  assert.equal(mt.verdict, VERDICT.OK)
})

test('contextWindow 差距过大时仍会覆盖', () => {
  const current = { id: 'x', contextWindow: 262144 } // 兜底默认值，远小于真实值
  const measured = { contextWindow: fact(1048576, { evidence: 'endpoint-listing' }) }
  const findings = auditModel({ current, measured })
  const mt = findings.find((f) => f.field === 'contextWindow')
  assert.equal(mt.verdict, VERDICT.MISMATCH)

  assert.equal(written(findings).contextWindow, 1048576)
})

test('缺失时补入实测值本身，不打折', () => {
  // 容差只用于比较，不改变写入值 —— 写入的就是端点承认的那个数。
  const measured = { maxTokens: fact(393216, { constraintMin: 1, constraintMax: 393216 }) }
  const findings = auditModel({ current: { id: 'x' }, measured })
  assert.equal(written(findings).maxTokens, 393216)
})

test('差距格式化：供界面显示"差了多少"', () => {
  assert.equal(formatGap(384000, 393216), '2.3%')
  assert.equal(formatGap(100, 100), '0.0%')
  assert.equal(formatGap(undefined, 100), '未知比例')
  assert.equal(formatGap(100, 0), '未知比例')
})
