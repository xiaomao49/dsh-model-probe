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
import { parseNumericRange, parseEnumOptions, classifyProbe, THINKING_LEVELS } from './elicit.js'
import { makeVisionProbe } from './png.js'

/** 探测用的荒谬大值：任何真实模型都不会有这么大的输出上限。 */
const ABSURD_MAX_TOKENS = 100_000_000

/** 各层默认超时。取证请求应当快速失败。 */
const TIMEOUT = { listing: 20_000, elicit: 25_000, vision: 60_000 }

/** 视觉探针的输出预算：推理模型的思考也吃这个额度，给足以免正文被挤空。 */
const VISION_MAX_TOKENS = 2000

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
export async function listModels({ baseURL, api, apiKey, signal, budget }) {
  const res = await request(listingUrl(baseURL, api), {
    headers: authHeaders(api, apiKey),
    timeoutMs: TIMEOUT.listing,
    signal,
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
export async function elicitMaxTokens({ baseURL, api, apiKey, model, signal, budget }) {
  const res = await request(chatUrl(baseURL, api), {
    method: 'POST',
    headers: authHeaders(api, apiKey),
    body: {
      model,
      max_tokens: ABSURD_MAX_TOKENS,
      // 极短提示：万一端点接受了大值，也不希望它真的长篇输出。
      messages: [{ role: 'user', content: 'ok' }],
    },
    timeoutMs: TIMEOUT.elicit,
    signal,
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
export async function elicitEfforts({ baseURL, api, apiKey, model, signal, budget }) {
  const res = await request(chatUrl(baseURL, api), {
    method: 'POST',
    headers: authHeaders(api, apiKey),
    body: {
      model,
      max_tokens: 16,
      reasoning_effort: 'off',
      messages: [{ role: 'user', content: 'ok' }],
    },
    timeoutMs: TIMEOUT.elicit,
    signal,
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

  const levels = parseEnumOptions(raw)
  if (levels === undefined) {
    return { ok: false, reason: '端点拒绝但未给出可解析的档位集合', raw }
  }
  return { ok: true, levels, offAccepted: levels.includes('off'), raw }
}

/**
 * ③ 能力实证：用随机图形计数探针判断模型是否真能看图。
 *
 * 为什么不用"图里写了什么字"：很多网关会偷偷用 OCR 顶替视觉能力，照样答对，
 * 于是把一个纯文本模型误判成支持图像。之后用户贴图，请求在真实会话中途失败。
 * 计数彩色几何图形必须真正解码像素，OCR 无法冒充。
 *
 * @returns {Promise<{ok: true, supportsImage: boolean, raw: string}|{ok: false, reason: string, raw?: string}>}
 */
export async function probeVision({ baseURL, api, apiKey, model, signal, budget, rng }) {
  const probe = makeVisionProbe(rng)
  const res = await request(chatUrl(baseURL, api), {
    method: 'POST',
    headers: authHeaders(api, apiKey),
    body: {
      model,
      max_tokens: VISION_MAX_TOKENS,
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
  const choice = res.json?.choices?.[0]
  const finish = choice?.finish_reason

  // 正文为空且被截断：额度被思考吃光了，这次探测无结论——绝不能据此判"不支持视觉"。
  if (text.trim().length === 0 && finish === 'length') {
    return { ok: false, reason: '输出额度被推理占满，正文为空，探测无结论' }
  }

  const got = firstInteger(text)
  if (got === undefined) {
    return { ok: false, reason: `无法从回答中读出数字：${text.trim().slice(0, 120)}` }
  }
  return {
    ok: true,
    supportsImage: got === probe.answer.count,
    raw: `期望 ${probe.answer.count}，回答 ${got}（${probe.answer.color} ${probe.answer.shape}）`,
  }
}

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

/** 判断端点是否因为"不支持图像输入"而拒绝。 */
function looksLikeModalityRejection(raw) {
  const t = String(raw).toLowerCase()
  const mentionsImage = /image|vision|multimodal|图片|图像|视觉|模态/.test(t)
  const mentionsReject = /not support|unsupported|does not support|invalid.*content|不支持|无法处理|仅支持/.test(t)
  return mentionsImage && mentionsReject
}

export { Budget, ABSURD_MAX_TOKENS }
