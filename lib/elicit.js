/**
 * 约束取证：从端点的报错里读出它真正接受的取值范围。
 *
 * 这是本插件区别于其它"配置填充器"的核心手法。别的插件靠知识库、models.dev
 * 或硬编码常量猜测参数；这里直接问端点本身——故意发一个非法值，让它把合法
 * 区间告诉我们。
 *
 * 好处很实在：
 *   - 零输出 token（请求被拒，模型没有生成任何东西）；
 *   - 精确到边界（"合法区间是 [1, 393216]"没有解释空间）；
 *   - 与厂商文档无关（网关自己说的话最权威）。
 *
 * 代价是依赖端点的报错文案。所以解析器写成多模式匹配，并保留原始错误文本：
 * 解析失败不等于"没有约束"，只等于"这次没问出来"。
 */

/** 支持的推理档位全集（DSH/pi-ai 的词汇表，用于校验解析结果）。 */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** 会被 DSH 写进请求的输出上限字段名。 */
export const MAX_TOKENS_FIELDS = ['max_tokens', 'max_completion_tokens']

/**
 * 从错误文本中解析数值区间上界。
 *
 * 已知真实文案（均来自实际抓包）：
 *   - 'Invalid max_tokens value, the valid range of max_tokens is [1, 393216]'
 *   - 'The max_tokens parameter is illegal.：限制数值范围[1,131072]'
 *
 * 额外兜底：任何形如 `[1, N]` 且紧邻字段名的片段。
 *
 * @param {string} text - 端点返回的错误文本（已摊平为可读形式）。
 * @param {string[]} [fieldNames] - 关注的字段名，默认 max_tokens 系列。
 * @returns {{min: number, max: number} | undefined} 解析出的区间，失败为 undefined。
 */
export function parseNumericRange(text, fieldNames = MAX_TOKENS_FIELDS) {
  if (typeof text !== 'string' || text.length === 0) return undefined

  // 模式 1：带字段名的 "range of X is [min, max]" / "X 的合法区间 [min, max]"
  for (const field of fieldNames) {
    const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const named = new RegExp(
      `${escaped}[^\\[\\]]{0,40}\\[\\s*(\\d+)\\s*,\\s*(\\d+)\\s*\\]`,
      'i',
    )
    const hit = named.exec(text)
    if (hit !== null) {
      const min = Number(hit[1])
      const max = Number(hit[2])
      if (Number.isFinite(min) && Number.isFinite(max) && max >= min) return { min, max }
    }
  }

  // 模式 2：中文/英文的"范围"提示词 + 区间，不要求出现字段名。
  const hint = /(?:valid range|range|区间|范围|限制数值)[^\d\[\]]{0,20}\[\s*(\d+)\s*,\s*(\d+)\s*\]/i.exec(text)
  if (hint !== null) {
    const min = Number(hint[1])
    const max = Number(hint[2])
    if (Number.isFinite(min) && Number.isFinite(max) && max >= min) return { min, max }
  }

  // 模式 3：字段名与区间之间存在较远的距离（部分网关会把说明放在后一句）。
  for (const field of fieldNames) {
    if (!text.includes(field)) continue
    const anywhere = /\[\s*(\d+)\s*,\s*(\d+)\s*\]/.exec(text)
    if (anywhere !== null) {
      const min = Number(anywhere[1])
      const max = Number(anywhere[2])
      if (Number.isFinite(min) && Number.isFinite(max) && max >= min) return { min, max }
    }
  }

  return undefined
}

/**
 * 从错误文本中解析枚举型参数的合法取值集合。
 *
 * 已知真实文案：
 *   - 'Invalid option: expected one of "low"|"medium"|"high"|"xhigh"|"max"'
 *
 * 同时支持逗号分隔与方括号列表等常见变体。
 *
 * @param {string} text
 * @param {string[]} [vocabulary] - 用于过滤结果、避免把字段名当成取值。
 * @returns {string[] | undefined} 解析出的取值集合（保持端点给出的顺序）。
 */
export function parseEnumOptions(text, vocabulary = THINKING_LEVELS) {
  if (typeof text !== 'string' || text.length === 0) return undefined

  /** 从一段候选文本里切出取值；只保留词汇表内的词，顺序去重。 */
  const harvest = (segment) => {
    const tokens = segment
      .split(/[|,]|\s+or\s+|\s*、\s*/)
      .map((t) =>
        t
          .trim()
          // 先去掉 JSON 转义反斜杠：真实响应体里是 \"low\" 而非 "low"，
          // 不先剥掉反斜杠，后面的清洗就匹配不上，整条都会被丢弃。
          .replace(/\\+/g, '')
          // 再剥掉首尾一切非字母数字字符。之所以用"非字母数字"而不是列举
          // 引号括号：真实文案末尾可能是 `max""}`，`}` 会漏网并污染取值。
          // 档位词汇本身全是字母数字，这样剥是安全的。
          .replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, '')
          .toLowerCase(),
      )
      .filter((t) => t.length > 0 && vocabulary.includes(t))
    const seen = new Set()
    const out = []
    for (const t of tokens) {
      if (!seen.has(t)) {
        seen.add(t)
        out.push(t)
      }
    }
    return out
  }

  // 模式 1：expected one of "a"|"b"|"c"（含 : 与 ： 两种冒号）
  const oneOf = /expected one of\s*[:：]?\s*([^\n。.]{0,240})/i.exec(text)
  if (oneOf !== null) {
    const values = harvest(oneOf[1])
    if (values.length > 0) return values
  }

  // 模式 2：must be one of / allowed values / 可选值
  const variants =
    /(?:must be one of|allowed values?|supported values?|valid options?|可选值|合法取值|支持的值)\s*[:：]?\s*([^\n。.]{0,240})/i.exec(
      text,
    )
  if (variants !== null) {
    const values = harvest(variants[1])
    if (values.length > 0) return values
  }

  // 模式 3：方括号列表 ["low", "high", "max"]
  const bracketed = /\[\s*([^\]]{0,240})\]/i.exec(text)
  if (bracketed !== null) {
    const values = harvest(bracketed[1])
    if (values.length > 0) return values
  }

  return undefined
}

/**
 * 判断一次"故意非法"的探测得到了什么结论。
 *
 * 三种结果语义完全不同，上层要区别对待：
 *   - rejected：端点拒绝了非法值并给出约束 → 最理想，约束可信；
 *   - rejected-silent：拒绝了但没给约束 → 约束未知；
 *   - accepted：端点接受了非法值 → 说明它不做范围校验，不能据此推断上限。
 *
 * @param {{ok: boolean, status: number, text: string, error?: string}} res
 * @returns {'rejected' | 'rejected-silent' | 'accepted' | 'inconclusive'}
 */
export function classifyProbe(res) {
  if (res.error !== undefined && res.status === 0) return 'inconclusive'
  if (res.status === 0) return 'inconclusive'
  if (res.ok) return 'accepted'
  // 4xx/5xx：能读到约束文本才算"明示拒绝"。
  return res.text.trim().length > 0 ? 'rejected' : 'rejected-silent'
}
