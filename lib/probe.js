/**
 * 探测编排：按证据强度从高到低，逐层向端点取证。
 *
 * 设计原则（贯穿全文件）：
 *   1. 只写有证据的值。拿不到就标 unknown，绝不猜——错误的配置比缺失的配置
 *      更危险，因为它静默地破坏请求。
 *   2. 每个结论都带证据来源与置信度，让使用者知道哪些可以信、哪些要复核。
 *   3. 一次扫描的总请求数与 token 消耗可预算、可取消、可审计。
 *
 * 层次：
 *   ① 端点自述     GET /models                    → contextWindow（部分含模态）
 *   ② 约束取证     故意发非法值，读报错里的合法区间  → maxTokens / reasoningEfforts
 *   ③ 能力实证     随机图形计数探针                → input 模态
 *   ④ 未知         标 unknown，不写
 */

import { request, flattenError } from './http.js'
import {
  parseNumericRange,
  OFF_WIRE_SYNONYMS,
  normalizeWireLevels,
  parseEnumOptions,
  classifyProbe,
  looksModelUnavailable,
  THINKING_LEVELS,
} from './elicit.js'
import { makeDifferentialProbe, makeVisionProbe } from './png.js'

/** 探测用的荒谬大值：任何真实模型都不会有这么大的输出上限。 */
const ABSURD_MAX_TOKENS = 100_000_000

/** 各层默认超时。取证请求应当快速失败。 */
/**
 * 各层请求的超时。
 *
 * vision 给得比其它层宽：视觉探针是唯一让模型真正生成内容的环节，而重试时额度
 * 提到 8000 token，推理型模型（实测 deepseek-v4-pro 单次思考约 2000 token）可能
 * 需要一两分钟。探测是一次性操作，不在延迟敏感路径上，超时过紧只会白白丢掉结论。
 */
const TIMEOUT = { listing: 20_000, elicit: 25_000, vision: 150_000 }

/**
 * 视觉探针的输出预算。
 *
 * 推理模型的思考与正文共用这个额度。先在小额度上试（省 token），正文被思考挤空
 * 时再用 VISION_RETRY_MAX_TOKENS 重试一次 —— 实测 deepseek-v4-pro 需要约 2000
 * token 思考才会开口，只给小额度会得到一个没有结论的"未确认"。
 */
const VISION_MAX_TOKENS = 2000
const VISION_RETRY_MAX_TOKENS = 8000

/**
 * 差异探针（两张图、两个标注）的输出预算。
 *
 * 推理模型在这道题上要先分别描述两张图再各给一个数，实测思考量比单图探针更大；
 * 额度给紧会让它说不出结论，白白多花一次请求。
 */
const VISION_CROSSCHECK_MAX_TOKENS = 8000

/**
 * 组装端点鉴权头。
 *
 * 只支持 Bearer 与 x-api-key 两种最常见形式；其余情况显式返回错误，而不是
 * 发一个注定失败的请求。
 */
function authHeaders(api, apiKey) {
  if (typeof apiKey !== 'string' || apiKey.length === 0) return {}
  if (api === 'anthropic-messages') {
    return { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
  }
  return { authorization: `Bearer ${apiKey}` }
}

/**
 * 合并 provider 自定义头与插件推导出的鉴权头。
 *
 * 为什么必须转发 provider 自己的 headers：有些网关除 API key 之外还要求别的头，
 * 缺了它一律拒绝，三个取证层次会全部落空、所有字段只能报 unknown。实测案例：
 * `https://opencode.ai/zen/go/v1`（Console Go）强制要求 `x-opencode-session`，
 * 没有它任何请求都返回
 *   `MissingSessionID … Request is missing x-opencode-session and cannot be routed efficiently`
 * DSH 的 llm-pi-ai 本身就支持 provider 级 `headers` 字典并会照发，所以用户是能配
 * 的；插件侧不转发，这条路就是断的。
 *
 * 顺序：自定义头在前、鉴权头在后。鉴权头是当场从凭据链解析出来的，是本次请求的
 * 权威身份，应当覆盖同名的自定义头；apiKey 解析不到时 authHeaders 返回空对象，
 * 自定义头原样保留。
 */
function probeHeaders(api, apiKey, custom) {
  const extra = custom !== null && typeof custom === 'object' && !Array.isArray(custom) ? custom : {}
  return { ...extra, ...authHeaders(api, apiKey) }
}

/** 拼出模型列表端点。OpenAI 兼容与 Anthropic 的路径不同。 */
export function listingUrl(baseURL, api) {
  const base = String(baseURL).replace(/\/+$/, '')
  if (api === 'anthropic-messages') {
    // Anthropic 的列表面在根上，且两种写法都接受。
    return base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`
  }
  return `${base}/models`
}

/** 拼出对话补全端点。 */
export function chatUrl(baseURL, api) {
  const base = String(baseURL).replace(/\/+$/, '')
  if (api === 'anthropic-messages') {
    return base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`
  }
  if (api === 'openai-responses') return `${base}/responses`
  return `${base}/chat/completions`
}

/** 把解析出的取值集合转成 DSH 的 reasoningEfforts 声明。 */
export function toReasoningEfforts(levels) {
  const efforts = {}
  // DSH 语义：off 无值 = "支持，但不发送该参数"，这正是"关闭思考"的正确表达。
  // 但只有在端点确实不接受任何"关闭"取值时才这样做（见下方调用处的判断）。
  for (const level of THINKING_LEVELS) {
    if (level === 'off') continue
    if (levels.includes(level)) efforts[level] = level
  }
  return efforts
}

/** 累积请求与 token 消耗，供预算与审计。 */
class Budget {
  constructor(limit) {
    this.requests = 0
    this.outputTokens = 0
    this.limit = limit
    this.exhausted = false
  }

  spend(n = 1) {
    this.requests += n
  }

  addTokens(n) {
    if (Number.isFinite(n)) this.outputTokens += n
  }

  /** 是否还能继续发请求。超预算时置位，让扫描优雅收尾而非中断。 */
  canContinue() {
    if (this.requests >= this.limit) {
      this.exhausted = true
      return false
    }
    return true
  }
}

/**
 * ① 端点自述：读取模型列表。
 *
 * 这是唯一"端点主动告诉我们事实"的层次，零 token。缺点是披露字段少且各家不一，
 * 所以解析要宽容，拿不到就当没有。
 *
 * @returns {Promise<{ok: true, models: Array}|{ok: false, reason: string, status?: number}>}
 */
export async function listModels({ baseURL, api, apiKey, headers, signal, budget }) {
  const res = await request(listingUrl(baseURL, api), {
    headers: probeHeaders(api, apiKey, headers),
    timeoutMs: TIMEOUT.listing,
    signal,
    // 列表是零 token 的只读 GET，重试完全无副作用；而它一旦失败，所有模型的
    // contextWindow 就一起没了。实测网关会间歇性 ECONNRESET，所以这里重试两次。
    retries: 2,
  })
  budget.spend()

  if (res.status === 0) return { ok: false, reason: res.error ?? 'network', status: 0 }
  if (!res.ok) return { ok: false, reason: `HTTP ${res.status}`, status: res.status }
  if (res.json === undefined) return { ok: false, reason: 'endpoint 未返回 JSON' }

  return { ok: true, models: normalizeListing(res.json) }
}

/**
 * 把两种已知的列表响应形状归一化。
 *
 * 标准是 `{data: [{id, ...}]}`；部分网关给增强的 `{models: {id: {...}}}` 映射。
 * 字段名各家不同（context_length / context_window / max_input_tokens…），
 * 所以逐个候选名尝试，不做假设。
 */
export function normalizeListing(payload) {
  const rows = []
  const push = (id, entry) => {
    if (typeof id !== 'string' || id.length === 0) return
    const ctx = pickNumber(entry, [
      'context_length',
      'context_window',
      'contextWindow',
      'max_input_tokens',
      'input_token_limit',
      'max_context_tokens',
    ])
    const out = pickNumber(entry, ['max_output_tokens', 'max_tokens', 'maxTokens', 'output_token_limit'])
    const modalities = pickModalities(entry)
    rows.push({ id, contextWindow: ctx, maxTokens: out, input: modalities })
  }

  const container = payload?.data ?? payload?.models ?? payload
  if (Array.isArray(container)) {
    for (const entry of container) {
      if (entry === null || typeof entry !== 'object') continue
      push(entry.id ?? entry.name, entry)
    }
  } else if (container !== null && typeof container === 'object') {
    for (const [id, entry] of Object.entries(container)) {
      if (entry === null || typeof entry !== 'object') continue
      push(id, entry)
    }
  }
  return rows
}

function pickNumber(obj, names) {
  for (const name of names) {
    const v = obj?.[name]
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v
  }
  return undefined
}

/** 从各家五花八门的模态字段里读出图像能力。读不到返回 undefined（未知 ≠ 不支持）。 */
function pickModalities(entry) {
  if (entry === null || typeof entry !== 'object') return undefined
  const candidates = [
    entry?.architecture?.input_modalities,
    entry?.modalities?.input,
    entry?.input_modalities,
    entry?.supported_features,
    entry?.capabilities,
  ]
  for (const c of candidates) {
    if (Array.isArray(c) && c.length > 0) {
      const set = new Set(c.map((x) => String(x).toLowerCase()))
      // 有的网关用 vision / multimodal 之类的词表示图片能力。
      const hasImage = set.has('image') || set.has('vision') || set.has('multimodal') || set.has('image_url')
      const hasText = set.has('text') || hasImage
      if (hasText) return hasImage ? ['text', 'image'] : ['text']
    }
  }
  if (entry?.supports_vision === true) return ['text', 'image']
  if (entry?.supports_vision === false) return ['text']
  return undefined
}

/**
 * ② 约束取证：故意发非法 max_tokens，从端点报错里读出合法区间。
 *
 * 这是本插件最核心的手法。零输出 token，且端点亲口给出的区间没有解释空间。
 *
 * 若端点接受了这个荒谬值，说明它根本不做范围校验——那我们不能据此推断上限，
 * 必须如实标注为"无法确定"，而不是把荒谬值当成上限写进配置。
 *
 * @returns {Promise<{ok: true, min: number, max: number, raw: string}|{ok: false, reason: string, raw?: string}>}
 */
export async function elicitMaxTokens({ baseURL, api, apiKey, model, headers, signal, budget }) {
  const res = await request(chatUrl(baseURL, api), {
    method: 'POST',
    headers: probeHeaders(api, apiKey, headers),
    body: {
      model,
      max_tokens: ABSURD_MAX_TOKENS,
      // 极短提示：万一端点接受了大值，也不希望它真的长篇输出。
      messages: [{ role: 'user', content: 'ok' }],
    },
    timeoutMs: TIMEOUT.elicit,
    signal,
    // 连不上不算"端点拒绝了"——那是没有结论，不是结论。重试一次，避免一次
    // 传输抖动被误读成"端点不给区间"或"端点不接受这个档位"。
    retries: 1,
  })
  budget.spend()

  const verdict = classifyProbe(res)
  const raw = flattenError(res.json) || res.text

  if (verdict === 'inconclusive') return { ok: false, reason: res.error ?? 'network', raw }
  if (verdict === 'accepted') {
    budget.addTokens(res.json?.usage?.completion_tokens)
    return {
      ok: false,
      reason: '端点接受超范围值，不做上限校验（无法据此确定真实上限）',
      raw,
    }
  }

  const range = parseNumericRange(raw)
  if (range === undefined) {
    // 区分"参数被拒但读不出约束"与"模型在这个网关上根本不可用"。后者是结论性
    // 发现：该模型无法通过任何配置修复，应当直接告诉用户，而不是标成未知。
    if (looksModelUnavailable(raw)) {
      return { ok: false, reason: '该模型在此网关上没有可用上游，无法使用', unavailable: true, raw }
    }
    return { ok: false, reason: '端点拒绝但未给出可解析的区间', raw }
  }
  return { ok: true, min: range.min, max: range.max, raw }
}

/**
 * ② 约束取证：故意发非法 reasoning_effort，读出端点接受的档位集合。
 *
 * 探测值刻意选 "off"：这是 DSH 最关心的问题——"能不能关闭思考"。若 off 被拒
 * 且报错列出合法集合，我们同时得到两件事：合法档位有哪些，以及能不能关。
 *
 * @returns {Promise<{ok: true, levels: string[], offAccepted: boolean, raw: string}|{ok: false, reason: string, raw?: string}>}
 */
export async function elicitEfforts({ baseURL, api, apiKey, model, headers, signal, budget }) {
  const res = await request(chatUrl(baseURL, api), {
    method: 'POST',
    headers: probeHeaders(api, apiKey, headers),
    body: {
      model,
      max_tokens: 16,
      reasoning_effort: 'off',
      messages: [{ role: 'user', content: 'ok' }],
    },
    timeoutMs: TIMEOUT.elicit,
    signal,
    // 连不上不算"端点拒绝了"——那是没有结论，不是结论。重试一次，避免一次
    // 传输抖动被误读成"端点不给区间"或"端点不接受这个档位"。
    retries: 1,
  })
  budget.spend()

  const verdict = classifyProbe(res)
  const raw = flattenError(res.json) || res.text

  if (verdict === 'inconclusive') return { ok: false, reason: res.error ?? 'network', raw }
  if (verdict === 'accepted') {
    budget.addTokens(res.json?.usage?.completion_tokens)
    // 端点接受了 "off"：说明它可以被关闭，但档位集合仍未知。
    return { ok: true, levels: [], offAccepted: true, raw }
  }

  // 词汇表里额外带上"关闭思考"的同义线格式（如 none）：端点列的是**线上取值**，
  // 而 DSH 的档位叫 off。不换算就会读出"该模型无法关闭思考"这种错误结论。
  const wire = parseEnumOptions(raw, [...THINKING_LEVELS, ...OFF_WIRE_SYNONYMS])
  if (wire === undefined) {
    return { ok: false, reason: '端点拒绝但未给出可解析的档位集合', raw }
  }
  const { levels, offWire } = normalizeWireLevels(wire)
  return { ok: true, levels, offAccepted: levels.includes('off'), offWire, raw }
}

/**
 * ③ 能力实证：用随机图形计数探针判断模型是否真能看图。
 *
 * 为什么不用"图里写了什么字"：很多网关会偷偷用 OCR 顶替视觉能力，照样答对，
 * 于是把一个纯文本模型误判成支持图像。之后用户贴图，请求在真实会话中途失败。
 * 计数彩色几何图形必须真正解码像素，OCR 无法冒充。
 *
 * 为什么判定必须区分"数错"与"看不到"（0.1.10 的教训）：
 *   实测 deepseek/deepseek-v4.1-flash 对每张图都答得对，插件却报"实测 text"。
 *   真因是**答案解析**而不是端点：模型有时会用列表描述图片
 *   （"1. A yellow circle 2. A blue square …"），取"第一个数字"就取到了列表序号 1，
 *   一个正确的回答被读成错答；两次这样的误读就做出了"不支持图像"的结论。
 *   代价是不对称的：判成不支持会让 DSH 在该模型上永久拒收图片，把一个本来
 *   能用的模型废掉。所以答案只认模型显式声明的那个数，认不出就当作无结论。
 *
 * @param {object} opts
 * @param {() => number} [opts.rng]
 * @returns {Promise<{ok: true, supportsImage: boolean, raw: string}|{ok: false, reason: string, raw?: string}>}
 */
export async function probeVision({ baseURL, api, apiKey, model, headers, signal, budget, rng }) {
  // 视觉探测的额度与复核策略。每次尝试都生成一张**新图** —— 重复问同一张没有
  // 意义，模型的错误答案很可能一模一样。
  //
  // 为什么需要复核：
  //   1. 推理模型的思考与正文共用输出额度。额度给小了思考会把它吃光、正文为空
  //      （实测 deepseek-v4-pro 需要约 2000 token 思考），此时无结论而非"不支持"。
  //   2. 模型答了一个非零的错数时，"看不到而瞎猜"与"有视觉但数错了"无法区分。
  //      一次读不出数字的回答同样不足以定论（模型的叙述体裁随时在变）。
  //   3. 因此只要还有额度就多试几张不同的图，只要有一张数对就足以证明能看图；
  //      三次都读不出正确答案时，再用"差异探针"做一次是非题交叉核对。
  const MAX_COUNT_ATTEMPTS = 3
  let maxTokens = VISION_MAX_TOKENS
  let lastReason = '探测无结论'
  let lastRaw

  for (let attempt = 0; attempt < MAX_COUNT_ATTEMPTS; attempt++) {
    const probe = makeVisionProbe(rng)
    const outcome = await visionAttempt({
      baseURL,
      api,
      apiKey,
      model,
      headers,
      signal,
      budget,
      probe,
      maxTokens,
    })

    // 已有确定结论。
    if (outcome.ok === true) return outcome

    lastReason = outcome.reason
    lastRaw = outcome.raw

    // 额度被思考吃光：改用最大额度重试。
    if (outcome.retryable === true) {
      maxTokens = VISION_RETRY_MAX_TOKENS
      continue
    }

    // 否定性证据（端点拒绝图像、模型声明看不到图、答 0）一律由 visionAttempt
    // 直接给出结论；走到这里的都是"这一次没能得出结论"，换图再试。
  }

  // 计数这条路没能得出结论。用差异探针问一个是非题：只判断"两次读数是否
  // 跟着图像内容变化"，不要求它数准 —— 数不准但看得见，与看不见，在这里能分开。
  const budgetAllows = typeof budget.canContinue !== 'function' || budget.canContinue()
  if (budgetAllows && signal?.aborted !== true) {
    return await crossCheckVision({ baseURL, api, apiKey, model, headers, signal, budget })
  }

  return { ok: false, reason: lastReason, raw: lastRaw }
}

/**
 * 差异探针交叉核对：两张图，各自报一个数。
 *
 * 判据是"两个读数是否不同"（图像内容确实不同），而不是"是否数对"。这样即使
 * 模型对彩色图形的计数不稳定，只要它真的在看图，答案就会跟着图变。
 */
async function crossCheckVision({ baseURL, api, apiKey, model, headers, signal, budget }) {
  const probe = makeDifferentialProbe()
  const res = await request(chatUrl(baseURL, api), {
    method: 'POST',
    headers: probeHeaders(api, apiKey, headers),
    body: {
      model,
      max_tokens: VISION_CROSSCHECK_MAX_TOKENS,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: probe.question },
            ...probe.images.map((img) => ({
              type: 'image_url',
              image_url: { url: `data:image/png;base64,${img.base64}` },
            })),
          ],
        },
      ],
    },
    timeoutMs: TIMEOUT.vision,
    signal,
  })
  budget.spend()

  if (res.status === 0) return { ok: false, reason: res.error ?? 'network' }
  budget.addTokens(res.json?.usage?.completion_tokens)

  if (!res.ok) {
    const raw = flattenError(res.json) || res.text
    if (looksLikeModalityRejection(raw)) {
      return { ok: true, supportsImage: false, raw: raw.slice(0, 400) }
    }
    return { ok: false, reason: `交叉核对 HTTP ${res.status}`, raw: raw.slice(0, 400) }
  }

  const text = extractAnswerText(res.json, api)
  const finish = res.json?.choices?.[0]?.finish_reason

  if (text.trim().length === 0) {
    return {
      ok: false,
      reason: finish === 'length' ? '交叉核对的输出额度被推理占满，正文为空' : '交叉核对未返回正文',
    }
  }

  if (looksLikeCannotSee(text)) {
    return { ok: true, supportsImage: false, raw: `交叉核对中模型声明看不到图：${text.trim().slice(0, 200)}` }
  }

  const first = labelledInteger(text, 'IMAGE_1')
  const second = labelledInteger(text, 'IMAGE_2')
  if (first === undefined || second === undefined) {
    return { ok: false, reason: `交叉核对未读出两个 IMAGE_n 标注：${text.trim().slice(0, 160)}` }
  }

  // 两张图的区别就在数量上。读数不同 ⇒ 回答确实来自像素 ⇒ 能看图。
  if (first !== second) {
    return {
      ok: true,
      supportsImage: true,
      raw: `差异探针：两张图实测数量不同（IMAGE_1=${first}、IMAGE_2=${second}），读数随图像变化，判定支持图像输入`,
    }
  }

  return {
    ok: false,
    reason: `差异探针未能区分两张内容不同的图（两次都答 ${first}），图像能力仍不确定`,
  }
}

/**
 * 读取 `IMAGE_n=<数字>` 形式的标注值。
 *
 * 只认行内显式标注，避免把模型叙述里的其它数字当成答案。
 */
export function labelledInteger(text, label) {
  const re = new RegExp(`${label}\\s*[=:：]\\s*[^0-9-]{0,8}(-?\\d+)`, 'i')
  const m = re.exec(String(text))
  return m === null ? undefined : Number(m[1])
}

/** 单次视觉探测尝试。 */
async function visionAttempt({ baseURL, api, apiKey, model, headers, signal, budget, probe, maxTokens }) {
  const res = await request(chatUrl(baseURL, api), {
    method: 'POST',
    headers: probeHeaders(api, apiKey, headers),
    body: {
      model,
      max_tokens: maxTokens,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: probe.question },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${probe.base64}` } },
          ],
        },
      ],
    },
    timeoutMs: TIMEOUT.vision,
    signal,
  })
  budget.spend()

  if (res.status === 0) return { ok: false, reason: res.error ?? 'network' }
  budget.addTokens(res.json?.usage?.completion_tokens)

  if (!res.ok) {
    const raw = flattenError(res.json) || res.text
    // 明确因"不接受图像"而拒绝，本身就是结论——这是否定性证据，可以直接采信。
    if (looksLikeModalityRejection(raw)) {
      return { ok: true, supportsImage: false, raw: raw.slice(0, 400) }
    }
    return { ok: false, reason: `HTTP ${res.status}`, raw: raw.slice(0, 400) }
  }

  const text = extractAnswerText(res.json, api)
  const finish = res.json?.choices?.[0]?.finish_reason

  // 正文为空且被截断：额度被思考吃光了。这不是"无结论"，而是"该换更大额度"——
  // 标记为可重试，绝不能据此判"不支持视觉"。
  if (text.trim().length === 0 && finish === 'length') {
    return { ok: false, reason: '输出额度被推理占满，正文为空', retryable: true }
  }

  // 模型主动声明"看不到图"是决定性结论，而不是"读不出数字"。
  // 实测 deepseek-v4-pro 在收到图片时回答 "I can't see the image, so I can't
  // count the yellow circles." —— HTTP 200、finish=stop、没有报错。若把它当成
  // 无结论，就会漏掉一个真实问题：声明了图像能力，图片却被静默忽略。
  if (looksLikeCannotSee(text)) {
    return { ok: true, supportsImage: false, raw: text.trim().slice(0, 200) }
  }

  const got = extractDeclaredCount(text)
  if (got === undefined) {
    // 读不出数字不等于看不到图。这里必须是无结论，让它换图再试。
    return {
      ok: false,
      reason: `无法从回答中读出数字：${text.trim().slice(0, 120)}`,
      raw: text.trim().slice(0, 200),
    }
  }

  const expected = probe.answer.count

  // 答对：确定支持。
  if (got === expected) {
    return { ok: true, supportsImage: true, raw: `期望 ${expected}，回答 ${got}（答对）` }
  }

  // 答 0：探针图里目标图形数恒为 2..5，0 在结构上不可能，因此这是"看不到"的
  // 强证据，而不是数错。
  if (got === 0) {
    return {
      ok: true,
      supportsImage: false,
      raw: `期望 ${expected}，回答 0 —— 图中必有 2~5 个目标图形，答 0 说明未看到图像`,
    }
  }

  // 答成一个非零的错数：可能是"看不到而瞎猜"，也可能是"有视觉但数错了"。
  // 两者代价不对称，所以这里不下结论 —— 换一张新图再问，最后由差异探针定论。
  return {
    ok: false,
    reason: '答数不正确，需换图复核',
    raw: `期望 ${expected}，回答 ${got}`,
    ambiguous: true,
    answer: got,
    expected,
  }
}

/**
 * 从回答里读出模型**声明**的那个计数。
 *
 * 顺序即优先级：
 *   ① 显式声明（`TOTAL=3`、"the answer is 3"、"答案是 3"）—— 探针要求的格式；
 *   ② 最后给出的答案句（"there are 3 blue circles"）；
 *   ③ 整段里逗号/句号分隔的最后一个独立数字。
 *
 * 为什么要"最后"而不是"第一个"：模型常按序描述图片（"1. a red circle, 2. a
 * blue square, …"），第一个数字往往是列表序号。实测这一条把 4/14 的正确答案
 * 读成了错答，进而在两次后判定"不支持图像"。
 */
export function extractDeclaredCount(text) {
  const t = String(text ?? '')
  if (t.trim().length === 0) return undefined

  const MARKERS = [
    /TOTAL\s*[=:：]\s*\**\s*(\d+)/i,
    /(?:answer|result|count|total)\s*(?:is|:|=)\s*\**\s*(\d+)/i,
    /(?:there\s+(?:are|is))\s+\**\s*(\d+)/i,
    /(?:答案|总计|共|总共|一共)\s*(?:是|为|:|：)?\s*\**\s*(\d+)/,
  ]
  for (const re of MARKERS) {
    // 同一标记可能被模型重复写出（先想后答），取最后一次出现，那才是结论。
    let last
    for (const m of t.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`))) {
      last = Number(m[1])
    }
    if (last !== undefined && Number.isFinite(last)) return last
  }

  // 兜底：取一个"独立成词"的数字（两侧不是别的数字或小数点的数字），
  // 避免把 "2000"、"3.5" 里的片段当成答案。取最后一个，理由同上。
  const standalone = [...t.matchAll(/(?:^|[^\d.])(\d+)(?![\d])/g)].map((m) => Number(m[1]))
  const last = standalone[standalone.length - 1]
  return last !== undefined && Number.isFinite(last) ? last : undefined
}

/** 从各家响应形状里取出正文文本。 */

/** 从各家响应形状里取出正文文本。 */
function extractAnswerText(json, api) {
  if (api === 'anthropic-messages') {
    const blocks = json?.content
    if (Array.isArray(blocks)) {
      return blocks
        .filter((b) => b?.type === 'text')
        .map((b) => String(b.text ?? ''))
        .join('')
    }
    return ''
  }
  const content = json?.choices?.[0]?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : String(p?.text ?? '')))
      .join('')
  }
  return ''
}

/** 取回答里的第一个整数（模型爱加解释，所以只取数字本身）。 */
export function firstInteger(text) {
  const m = /-?\d+/.exec(String(text))
  if (m === null) return undefined
  const n = Number(m[0])
  return Number.isFinite(n) ? n : undefined
}

/**
 * 判断模型是否在回答里声明自己看不到图。
 *
 * 这与端点报错不同：请求成功、HTTP 200、模型正常作答，只是说看不到图片。
 * 该模型的图像输入被静默忽略——这正是"过度声明能力"最危险的形态，因为没有任何
 * 报错可循，用户在真实会话里贴图只会得到一句"我看不到图片"。
 *
 * @param {string} text
 * @returns {boolean}
 */
function looksLikeCannotSee(text) {
  const t = String(text).toLowerCase()
  return (
    /(?:can(?:no|')t|cannot|do(?:n't| not)|unable to|am not able to)\s+(?:see|view|access|read|perceive)/.test(t) ||
    /no image (?:was |is )?(?:provided|attached|received|visible)/.test(t) ||
    /(?:看不到|看不见|无法查看|无法查看图片|未能看到|没有收到图片|未收到图片|图片未|无法识别图片)/.test(t)
  )
}

/** 判断端点是否因为"不支持图像输入"而拒绝。 */
function looksLikeModalityRejection(raw) {
  const t = String(raw).toLowerCase()
  const mentionsImage = /image|vision|multimodal|图片|图像|视觉|模态/.test(t)
  const mentionsReject = /not support|unsupported|does not support|invalid.*content|不支持|无法处理|仅支持/.test(t)
  return mentionsImage && mentionsReject
}

export { Budget, ABSURD_MAX_TOKENS }
