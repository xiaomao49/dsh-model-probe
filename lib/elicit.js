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

/**
 * 端点用来表示"关闭思考"的线上取值同义词。
 *
 * DSH 的档位叫 `off`，但不少网关线上认的是 `none`。实测 opencode.ai 的 Console Go
 * 明确拒绝 off、接受 none，并在报错里列出：
 *   expected one of `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`
 * 解析时若不认这个同义词，插件会得出"该模型无法关闭思考"的**错误结论**——而实际
 * 上把 DSH 的 off 声明成线格式 none 就能关（reasoningEfforts: { off: none }）。
 * 这是"取证到的东西被读错"，比取证不到更糟。
 */
export const OFF_WIRE_SYNONYMS = ['none']

/**
 * 把端点给出的线上取值换算成 DSH 档位，并记住 off 用的是哪个线格式。
 *
 * @param {string[]} wireLevels - 端点列出的线上取值。
 * @returns {{levels: string[], offWire?: string}} levels 为 DSH 档位名，
 *   offWire 仅在端点的关闭取值不是字面 off 时出现。
 */
export function normalizeWireLevels(wireLevels) {
  if (!Array.isArray(wireLevels)) return { levels: [] }
  const levels = []
  let offWire
  for (const value of wireLevels) {
    if (OFF_WIRE_SYNONYMS.includes(value)) {
      if (offWire === undefined) offWire = value
      if (!levels.includes('off')) levels.push('off')
      continue
    }
    if (!levels.includes(value)) levels.push(value)
  }
  return offWire === undefined ? { levels } : { levels, offWire }
}

/** 会被 DSH 写进请求的输出上限字段名。 */
export const MAX_TOKENS_FIELDS = ['max_tokens', 'max_completion_tokens']

/**
 * 从错误文本中解析数值区间上界。
 *
 * 已知真实文案（均来自实际抓包）：
 *   - 'Invalid max_tokens value, the valid range of max_tokens is [1, 393216]'
 *   - 'The max_tokens parameter is illegal.：限制数值范围[1,131072]'
 *   - 'max_tokens (current value: 100000000) must be between 0 and 1048576'
 *   - 'invalid params, model[MiniMax-M3] does not support max tokens > 524288 (2013)'
 *
 * 最后两种没有方括号，是真实网关（Moonshot / MiniMax）的文案。这类文案只能给出
 * 上界，因此 `min` 可能为 undefined —— 调用方必须把它当作"下界未知"而非 0。
 *
 * @param {string} text - 端点返回的错误文本（已摊平为可读形式）。
 * @param {string[]} [fieldNames] - 关注的字段名，默认 max_tokens 系列。
 * @returns {{min?: number, max: number} | undefined} 解析出的区间，失败为 undefined。
 */
export function parseNumericRange(text, fieldNames = MAX_TOKENS_FIELDS) {
  if (typeof text !== 'string' || text.length === 0) return undefined

  /** 收尾校验：上界必须是有限正数；有下界时不得倒置。 */
  const accept = (min, max) => {
    if (!Number.isFinite(max) || max <= 0) return undefined
    if (min !== undefined && (!Number.isFinite(min) || min > max)) return undefined
    return min === undefined ? { max } : { min, max }
  }

  // 模式 1：带字段名的 "range of X is [min, max]" / "X 的合法区间 [min, max]"
  for (const field of fieldNames) {
    const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const named = new RegExp(
      `${escaped}[^\\[\\]]{0,40}\\[\\s*(\\d+)\\s*,\\s*(\\d+)\\s*\\]`,
      'i',
    )
    const hit = named.exec(text)
    if (hit !== null) {
      const accepted = accept(Number(hit[1]), Number(hit[2]))
      if (accepted !== undefined) return accepted
    }
  }

  // 模式 2：中文/英文的"范围"提示词 + 区间，不要求出现字段名。
  const hint = /(?:valid range|range|区间|范围|限制数值)[^\d\[\]]{0,20}\[\s*(\d+)\s*,\s*(\d+)\s*\]/i.exec(text)
  if (hint !== null) {
    const accepted = accept(Number(hint[1]), Number(hint[2]))
    if (accepted !== undefined) return accepted
  }

  // 模式 3：字段名与区间之间存在较远的距离（部分网关会把说明放在后一句）。
  for (const field of fieldNames) {
    if (!text.includes(field)) continue
    const anywhere = /\[\s*(\d+)\s*,\s*(\d+)\s*\]/.exec(text)
    if (anywhere !== null) {
      const accepted = accept(Number(anywhere[1]), Number(anywhere[2]))
      if (accepted !== undefined) return accepted
    }
  }

  // 模式 4：无方括号的 "must be between A and B"。
  // 例：max_tokens (current value: 100000000) must be between 0 and 1048576
  const between = /must be between\s+(\d+)\s+and\s+(\d+)/i.exec(text)
  if (between !== null) {
    const accepted = accept(Number(between[1]), Number(between[2]))
    if (accepted !== undefined) return accepted
  }

  // 模式 5：只给上界的形式 —— "does not support max tokens > N"。
  // 这类文案不含下界，返回的对象因此只有 max 字段。
  const upperOnly = new RegExp(
    `(?:${fieldNames.join('|')}|max tokens)[^\\d]{0,40}(?:>|＞|exceed(?:s|ing)?|over|超过|大于)\\s*(\\d+)`,
    'i',
  )
  const upper = upperOnly.exec(text)
  if (upper !== null) {
    const accepted = accept(undefined, Number(upper[1]))
    if (accepted !== undefined) return accepted
  }

  // 模式 6：Pydantic / FastAPI 风格的措辞 —— "Input should be less than or equal
  // to N"。真实文案（opencode.ai 的 Console Go 网关，实际抓包）：
  //   {"error":{"param":"max_tokens","type":"invalid_request_error","message":
  //    "…Input should be less than or equal to 10000000"}}
  // 它没有方括号、没有 "must be between"、也没有 ">"，前五种模式全都读不出来，
  // 于是明明端点亲口说了上界，插件却只能报"未给出可解析的区间"。
  //
  // 这里刻意要求文本里出现被问的字段名：同一个网关对别的字段（消息长度、图片
  // 尺寸）也可能回同类措辞，把那些上界误当成 max_tokens 的上界，会写坏配置。
  // 读不出归属就报 unknown —— 这是本插件一以贯之的纪律。
  if (fieldNames.some((field) => text.includes(field))) {
    const le = /(?:less than or equal to|at most|no (?:more|greater) than|不超过|最多|不能超过)\s*(\d+)/i.exec(text)
    if (le !== null) {
      const ge = /(?:greater than or equal to|at least|no less than|不少于|至少)\s*(\d+)/i.exec(text)
      const accepted = accept(ge === null ? undefined : Number(ge[1]), Number(le[1]))
      if (accepted !== undefined) return accepted
    }
  }

  return undefined
}

/**
 * 判断错误是否表示"该模型在此网关上不可用"，而不是参数不合法。
 *
 * 真实案例：某网关对 `deepseek/deepseek-v4-flash-vision-exp` 返回
 *   "No available providers match the 'only' filter: deepseek.
 *    Available providers are: deepinfra, fireworks…"
 * 模型名被接受，但没有任何上游能服务它。这与"参数越界"是完全不同的结论：
 * 前者说明这个模型根本不能用，任何配置都修不好。
 *
 * @param {string} text
 * @returns {boolean}
 */
export function looksModelUnavailable(text) {
  if (typeof text !== 'string' || text.length === 0) return false
  return (
    /no available providers?/i.test(text) ||
    /no providers? (?:are )?available/i.test(text) ||
    /(?:model|模型)[^.]{0,30}(?:not available|is unavailable|已下线|不可用)/i.test(text)
  )
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
    /** 整段清洗：剥掉 JSON 转义反斜杠与首尾一切非字母数字字符。 */
    const cleanWhole = (t) =>
      t
        .trim()
        // 先去掉 JSON 转义反斜杠：真实响应体里是 \"low\" 而非 "low"，
        // 不先剥掉反斜杠，后面的清洗就匹配不上，整条都会被丢弃。
        .replace(/\\+/g, '')
        // 再剥掉首尾一切非字母数字字符。之所以用"非字母数字"而不是列举
        // 引号括号：真实文案末尾可能是 `max""}`，`}` 会漏网并污染取值。
        // 档位词汇本身全是字母数字，这样剥是安全的。
        .replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, '')
        .toLowerCase()

    /**
     * 取出开头的连续字母数字串——枚举列表后面经常跟着散文：Rust serde 的文案
     * 末尾是 "`max` at line 1 column 66"，整段清洗后得到
     * "max` at line 1 column 66"，不等于任何取值，最后一个档位就此丢掉。
     * 取开头那一段即可复原。词汇表里全是完整单词（max ≠ maximum），所以
     * 要求"完全相等"不会把 maximum / lowest 这类词误收进来。
     */
    const cleanHead = (t) => {
      const head = /^[^a-z0-9]*([a-z0-9]+)/i.exec(t.trim().replace(/\\+/g, ''))
      return head === null ? '' : head[1].toLowerCase()
    }

    const tokens = segment
      .split(/[|,]|\s+or\s+|\s*、\s*/)
      .map((t) => {
        const whole = cleanWhole(t)
        if (whole.length > 0 && vocabulary.includes(whole)) return whole
        const head = cleanHead(t)
        return vocabulary.includes(head) ? head : ''
      })
      .filter((t) => t.length > 0)
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
