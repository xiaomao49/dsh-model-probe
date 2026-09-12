/**
 * 取证解析器测试 —— 夹具全部是实际抓包得到的真实错误串。
 *
 * 这一点很重要：解析器唯一的价值就是读懂真实端点的真实文案。用编造的字符串
 * 测试等于自欺。下面每条 `real:` 标注的来源都出自对 api.commandcode.ai 的实测。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseNumericRange,
  parseEnumOptions,
  classifyProbe,
  looksModelUnavailable,
  normalizeWireLevels,
  THINKING_LEVELS,
  OFF_WIRE_SYNONYMS,
} from '../lib/elicit.js'

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

// ── 以下三条夹具来自对同一网关其它模型的真实探测 ──────────────────────────────

test('解析 max_tokens 上界：Moonshot 的 between 文案（无方括号）', () => {
  // real: 对 moonshotai/Kimi-K3 发 max_tokens=100000000 时的响应体
  const real =
    '{"error":{"message":"{\\"code\\":400,\\"reason\\":\\"INVALID_REQUEST_BODY\\",\\"message\\":\\"max_tokens (current value: 100000000) must be between 0 and 1048576 \\",\\"metadata\\":{}}","type":"invalid_request_error"}}'
  assert.deepEqual(parseNumericRange(real), { min: 0, max: 1048576 })
})

test('解析 max_tokens 上界：MiniMax 的 "does not support >" 文案（只有上界）', () => {
  // real: 对 MiniMaxAI/MiniMax-M3 发 max_tokens=100000000 时的响应体
  const real =
    '{"error":{"message":"{\\"error\\":{\\"message\\":\\"invalid params, model[MiniMax-M3] does not support max tokens > 524288 (2013)\\",\\"type\\":\\"AI_APICallError\\"}}","type":"invalid_request_error"}}'
  const range = parseNumericRange(real)
  assert.equal(range.max, 524288)
  // 该文案不含下界，因此 min 必须是 undefined 而不是 0 —— 否则审计会把
  // 一个合法的小值误判成"低于下界"。
  assert.equal(range.min, undefined)
})

test('解析 max_tokens 上界：中文"超过"文案同样只给上界', () => {
  const range = parseNumericRange('max_tokens 超过 65536 会被拒绝')
  assert.equal(range.max, 65536)
  assert.equal(range.min, undefined)
})

test('不可用模型识别：No available providers', () => {
  // real: 某网关对 deepseek-v4-flash-vision-exp 的响应
  const real =
    '{"error":{"message":"No available providers match the \'only\' filter: deepseek. Available providers are: deepinfra, fireworks"}}'
  assert.equal(looksModelUnavailable(real), true)
  // 参数越界不应被误判成不可用
  assert.equal(looksModelUnavailable('max_tokens must be between 0 and 1048576'), false)
  assert.equal(looksModelUnavailable(''), false)
})

// ── Pydantic / FastAPI 风格的上界文案 ────────────────────────────────────────

test('解析 max_tokens 上界：Pydantic 的 "less than or equal to" 文案', () => {
  // real: opencode.ai 的 Console Go 网关（https://opencode.ai/zen/go/v1），
  // 对 max_tokens=100000000 返回 HTTP 422，报文体就是这一串。
  const real =
    '{"error":{"param":"max_tokens","type":"invalid_request_error","message":' +
    '"Error from provider (Console Go): Upstream request failed: [invalid_request_error] ' +
    'Input should be less than or equal to 10000000"}}'
  assert.deepEqual(parseNumericRange(real), { max: 10000000 })
})

test('解析上限：同时给出上下界的 Pydantic 文案', () => {
  const real = 'Field max_tokens: Input should be greater than or equal to 1; and less than or equal to 65536'
  assert.deepEqual(parseNumericRange(real), { min: 1, max: 65536 })
})

test('解析上限：at most / 不超过 等变体', () => {
  assert.deepEqual(parseNumericRange('max_tokens is at most 8192'), { max: 8192 })
  assert.deepEqual(parseNumericRange('参数 max_tokens 不能超过 32768'), { max: 32768 })
  assert.deepEqual(parseNumericRange('max_completion_tokens 最多 4096'), { max: 4096 })
})

test('不把别的字段的上界误当成 max_tokens 的上界', () => {
  // 同一个网关对消息长度、图片尺寸也会回同类措辞。读不出归属就必须报 unknown——
  // 把 4096 当成 max_tokens 的上界会直接写坏配置。
  const other = 'messages.0.content: Input should be less than or equal to 4096'
  assert.equal(parseNumericRange(other), undefined)
  // 但明确点名 max_tokens 时照常解析。
  assert.deepEqual(parseNumericRange('max_tokens: Input should be less than or equal to 4096'), { max: 4096 })
})

test('回归：新增模式不改变原有五种模式的判定', () => {
  assert.deepEqual(parseNumericRange('Invalid max_tokens value, the valid range of max_tokens is [1, 393216]'), {
    min: 1,
    max: 393216,
  })
  assert.deepEqual(parseNumericRange('max_tokens (current value: 100000000) must be between 0 and 1048576'), {
    min: 0,
    max: 1048576,
  })
  assert.deepEqual(parseNumericRange('invalid params, model[MiniMax-M3] does not support max tokens > 524288 (2013)'), {
    max: 524288,
  })
  // 没有上界的文本仍然读不出来。
  assert.equal(parseNumericRange('something went wrong'), undefined)
})

// ── 枚举列表的散文尾巴，以及 none / off 的线格式同义 ────────────────────────

test('解析档位：末尾跟散文时最后一个取值不再丢失', () => {
  // real: opencode.ai 的 Console Go（opencode.ai/zen/go/v1）对 reasoning_effort=off
  // 返回的 Rust serde 文案。注意末尾的 "at line 1 column 66"——整段清洗会让
  // `max` 变成 "max` at line 1 column 66"，旧实现把它整条丢掉，于是 max 档凭空消失。
  const real =
    '{"error":{"message":"Error from provider (Console Go): Upstream request failed: ' +
    '[invalid_request_error] Failed to deserialize the JSON body into the target type: ' +
    'reasoning_effort: unknown variant `off`, expected one of `none`, `minimal`, `low`, ' +
    '`medium`, `high`, `xhigh`, `max` at line 1 column 66"}}'
  const wire = parseEnumOptions(real, [...THINKING_LEVELS, ...OFF_WIRE_SYNONYMS])
  assert.deepEqual(wire, ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
})

test('把端点的 none 换算成 DSH 的 off，并记住线格式', () => {
  const { levels, offWire } = normalizeWireLevels(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  assert.deepEqual(levels, ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  assert.equal(offWire, 'none')
  // 语义关键：端点接受 none 就等于"可以关闭思考"，不能报成 offAccepted=false。
  assert.equal(levels.includes('off'), true)
})

test('端点字面接受 off 时不产生 offWire（避免多余的提示）', () => {
  const { levels, offWire } = normalizeWireLevels(['off', 'low', 'high'])
  assert.deepEqual(levels, ['off', 'low', 'high'])
  assert.equal(offWire, undefined)
})

test('normalizeWireLevels 对非数组输入不抛错', () => {
  assert.deepEqual(normalizeWireLevels(undefined), { levels: [] })
  assert.deepEqual(normalizeWireLevels('none'), { levels: [] })
})

test('回归：英式竖线枚举与方括号列表照常解析', () => {
  assert.deepEqual(parseEnumOptions('Invalid option: expected one of "low"|"medium"|"high"|"xhigh"|"max"'), [
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ])
  assert.deepEqual(parseEnumOptions('allowed values: ["low", "high"]'), ['low', 'high'])
  // maximum / lowest 之类的长词不得被当成 max / low。
  assert.equal(parseEnumOptions('the maximum allowed is 3'), undefined)
})
