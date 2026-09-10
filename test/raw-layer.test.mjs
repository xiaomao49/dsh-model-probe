/**
 * 原始层纪律测试 —— 拦住"把 schema 默认值固化进用户配置"这类污染。
 *
 * 背景（真实故障）：写入成功后，用户的 settings.yaml 里每个模型条目都多出了
 *   compat:
 *     chatTemplateKwargs: {}
 *     chatTemplateArgs: {}
 * 这些字段用户从未写过。根因是读取用了 ctx.settings.get()，它返回 **解析后的
 * 值** —— schemastery 会把 schema 默认值 materialize 进去，而写入落在用户层，
 * 于是默认值被永久固化。
 *
 * 正确的读取来源是 describe() 的 user 字段（原始用户层）。
 *
 * 这个 bug 比"写入失败"更隐蔽：它不报错、功能也正常，只是悄悄改写了用户的配置
 * 文件。唯一能发现它的方式是 diff 备份与当前文件。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readPiSection } from '../lib/store.js'

/** 构造一个提供 describe/get 的假 ctx。 */
function makeCtx({ user, resolved } = {}) {
  return {
    settings: {
      describe: () => (user === undefined ? [] : [{ ns: 'llm-pi-ai', revision: 1, user }]),
      get: () => resolved,
    },
  }
}

test('优先读取 describe().user 原始层，而不是 get() 解析值', () => {
  const raw = {
    providers: {
      p: { models: [{ id: 'm', maxTokens: 100 }] },
    },
  }
  // 解析值带 schema materialize 出来的空壳字段。
  const resolved = {
    providers: {
      p: { models: [{ id: 'm', maxTokens: 100, compat: { chatTemplateKwargs: {}, chatTemplateArgs: {} } }] },
    },
  }
  const result = readPiSection(makeCtx({ user: raw, resolved }))

  assert.equal(result.raw, true)
  assert.deepEqual(result.section, raw)
  // 决定性断言：结果里绝不能出现 schema 默认值。
  assert.equal('compat' in result.section.providers.p.models[0], false)
})

test('拿不到原始层时标记 raw=false，并说明原因', () => {
  const resolved = { providers: { p: { models: [] } } }
  // describe 返回空（命名空间无用户层）。
  const result = readPiSection(makeCtx({ user: undefined, resolved }))
  assert.equal(result.raw, false)
  assert.ok(result.reason, '必须给出不可写的原因')
})

test('describe 抛错时降级为 raw=false，且仍能读到解析值供展示', () => {
  const ctx = {
    settings: {
      describe: () => {
        throw new Error('describe unavailable')
      },
      get: () => ({ providers: { p: { models: [{ id: 'm' }] } } }),
    },
  }
  const result = readPiSection(ctx)
  assert.equal(result.raw, false)
  assert.match(result.reason, /无法读取原始用户层/)
  // 展示仍可用：解析值被保留。
  assert.ok(result.section.providers.p)
})

test('用户层存在但为空对象时不算可写（避免凭空造 section）', () => {
  // 空对象是合法用户层，raw 应为 true —— 它能安全承载新增内容。
  const result = readPiSection(makeCtx({ user: {}, resolved: { providers: {} } }))
  assert.equal(result.raw, true)
  assert.deepEqual(result.section, {})
})

test('用户层是数组等异常形状时拒绝，不当作有效原始层', () => {
  const ctx = {
    settings: {
      describe: () => [{ ns: 'llm-pi-ai', revision: 1, user: ['不合法的形状'] }],
      get: () => ({ providers: {} }),
    },
  }
  const result = readPiSection(ctx)
  assert.equal(result.raw, false, '非法形状的 user 层不能被当作可写')
})
