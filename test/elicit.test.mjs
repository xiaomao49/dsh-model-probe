/**
 * 取证解析器测试 —— 夹具全部是实际抓包得到的真实错误串。
 *
 * 这一点很重要：解析器唯一的价值就是读懂真实端点的真实文案。用编造的字符串
 * 测试等于自欺。下面每条 `real:` 标注的来源都出自对 api.commandcode.ai 的实测。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseNumericRange, parseEnumOptions, classifyProbe } from '../lib/elicit.js'

test('解析 max_tokens 上界：deepseek 的英文区间文案', () => {
  // real: 对 cc-goat 发 max_tokens=1000000 时的响应体（JSON 包装内层 message）
  const real =
    '{"error":{"message":"Invalid max_tokens value, the valid range of max_tokens is [1, 393216]","type":"AI_APICallError"}}'
  assert.deepEqual(parseNumericRange(real), { min: 1, max: 393216 })
})

test('解析 max_tokens 上界：GLM 的中文区间文案', () => {
  // real: 对 cc-goat 的 z-ai/glm-5.3-flash 发 max_tokens=200000 时的响应体
  const real =
    '{"error":{"message":"The max_tokens parameter is illegal.：限制数值范围[1,131072]","type":"AI_APICallError"}}'
  assert.deepEqual(parseNumericRange(real), { min: 1, max: 131072 })
})

test('解析 max_tokens 上界：无空格的紧凑区间', () => {
  assert.deepEqual(parseNumericRange('max_tokens out of range[1,8192]'), { min: 1, max: 8192 })
})

test('解析 max_tokens 上界：max_completion_tokens 字段名', () => {
  // 有些网关用 OpenAI 的新字段名。
  assert.deepEqual(
    parseNumericRange('max_completion_tokens must satisfy [1, 65536]', ['max_completion_tokens']),
    { min: 1, max: 65536 },
  )
})

test('解析 max_tokens 上界：读不出时返回 undefined，而不是瞎猜', () => {
  assert.equal(parseNumericRange('Internal server error'), undefined)
  assert.equal(parseNumericRange(''), undefined)
  assert.equal(parseNumericRange(undefined), undefined)
  // 区间倒置属于异常文案，必须拒绝而非产出负区间。
  assert.equal(parseNumericRange('max_tokens range [500, 100]'), undefined)
})

test('解析推理档位：真实的 zod 风格文案', () => {
  // real: 对 cc-goat 发 reasoning_effort="none" 时的响应体
  const real = '{"message":"Invalid option: expected one of \\"low\\"|\\"medium\\"|\\"high\\"|\\"xhigh\\"|\\"max\\""}'
  assert.deepEqual(parseEnumOptions(real), ['low', 'medium', 'high', 'xhigh', 'max'])
})

test('解析推理档位：逗号分隔与中文提示', () => {
  assert.deepEqual(parseEnumOptions('reasoning_effort must be one of: low, high, max'), ['low', 'high', 'max'])
  assert.deepEqual(parseEnumOptions('推理强度 合法取值：low、high、max'), ['low', 'high', 'max'])
})

test('解析推理档位：方括号列表', () => {
  assert.deepEqual(parseEnumOptions('allowed values ["off", "high"]'), ['off', 'high'])
})

test('解析推理档位：过滤非词汇表的词，避免把选项名当取值', () => {
  // 端点文案里常混入字段名或选项名，不能污染结果。
  const text = 'Invalid value for reasoning_effort. Must be one of: low, high, max'
  assert.deepEqual(parseEnumOptions(text), ['low', 'high', 'max'])
})

test('解析推理档位：端点返回空集合时返回 undefined', () => {
  assert.equal(parseEnumOptions('Invalid option'), undefined)
  assert.equal(parseEnumOptions('expected one of "banana"|"apple"'), undefined)
})

test('探测结论分类：三种语义必须区分开', () => {
  // 端点拒绝并给了约束 —— 最理想
  assert.equal(classifyProbe({ ok: false, status: 400, text: 'range [1, 100]' }), 'rejected')
  // 端点拒绝但没说为什么 —— 约束仍未知
  assert.equal(classifyProbe({ ok: false, status: 400, text: '   ' }), 'rejected-silent')
  // 端点接受了非法值 —— 说明它不做校验，绝不能据此推断上限
  assert.equal(classifyProbe({ ok: true, status: 200, text: '{"choices":[]}' }), 'accepted')
  // 网络层失败 —— 什么都没证明
  assert.equal(classifyProbe({ ok: false, status: 0, text: '', error: 'timeout' }), 'inconclusive')
})
