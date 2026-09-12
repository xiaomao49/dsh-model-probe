/**
 * 受控 HTTP 层：所有对外请求都经这里，统一超时、取消、响应体截断。
 *
 * 为什么单独一层：探测会向真实端点发请求，属于会花钱、会失败、需要被取消的
 * 操作。把这些关切集中在这里，上层协议逻辑才能保持纯粹、可单测。
 */

/** 单次请求的默认超时。探测请求应快速失败，不拖住整个扫描。 */
export const DEFAULT_TIMEOUT_MS = 30_000

/** 响应体读取上限：错误信息通常很短，防御性截断避免异常大响应占内存。 */
const MAX_BODY_BYTES = 256 * 1024

/**
 * 发起一次请求并读取文本响应。
 *
 * 刻意不抛 HTTP 错误：4xx 正是我们要的信息（错误体里带着端点的合法区间），
 * 所以状态码作为返回值而非异常。
 *
 * @param {string} url
 * @param {object} options
 * @param {string} [options.method]
 * @param {Record<string,string>} [options.headers]
 * @param {unknown} [options.body] - 会被 JSON 序列化。
 * @param {number} [options.timeoutMs]
 * @param {AbortSignal} [options.signal] - 外部取消（用户点停止）。
 * @param {number} [options.retries] - 传输级故障的重试次数上限（默认 0，即不重试）。
 * @returns {Promise<{ok: boolean, status: number, text: string, json: unknown, error?: string}>}
 */
export async function request(url, options = {}) {
  const retries = Number.isInteger(options.retries) && options.retries > 0 ? options.retries : 0

  let attempt = 0
  for (;;) {
    const outcome = await attemptRequest(url, options)
    if (outcome.result.ok === true) return outcome.result
    // 外部取消是用户的意图，重试只会让"停止"看起来没生效。
    if (options.signal?.aborted === true) return outcome.result
    if (outcome.retryable !== true || attempt >= retries) return outcome.result
    attempt += 1
  }
}

/**
 * 单次请求尝试，并给出"这次失败是否值得重试"的判断。
 *
 * 关键区分：**连接根本没建立起来**的故障（对端重置、连接被拒、DNS 暂时失败）
 * 重试是安全的——请求要么没送到，要么响应在到达前就丢了。而"读到了响应、只是
 * 状态码不理想"不是故障，绝不重试：那正是我们想要的证据。
 *
 * 这条区分是实测逼出来的：某个网关会间歇性 ECONNRESET（同一分钟内连续请求，
 * 有的成功有的被重置）。没有重试时，一次抖动就让整个 provider 的 contextWindow
 * 取证失败，而它本可以第二次就成功。
 */
async function attemptRequest(url, options) {
  const { method = 'GET', headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = options

  // 内部超时与外部取消合并：任一触发都要中止请求。每次尝试都重新创建，否则
  // 上一次的计时器会把重试也一起掐掉。
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const combined = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal])

  const init = { method, headers: { ...headers }, signal: combined }
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body)
    init.headers['content-type'] = init.headers['content-type'] ?? 'application/json'
  }

  try {
    const res = await fetch(url, init)
    const text = await readCapped(res)
    let json
    try {
      json = JSON.parse(text)
    } catch {
      json = undefined
    }
    return { result: { ok: res.ok, status: res.status, text, json }, retryable: false }
  } catch (err) {
    // 区分"外部取消"与"超时"，上层要给出不同提示。
    const name = err?.name
    if (name === 'AbortError' || name === 'TimeoutError') {
      const cancelled = name === 'AbortError' && signal?.aborted === true
      return {
        result: { ok: false, status: 0, text: '', json: undefined, error: cancelled ? 'cancelled' : 'timeout' },
        retryable: false,
      }
    }

    // fetch 抛出的固定是 TypeError('fetch failed')，真正的原因在 `cause` 里
    // （ENOTFOUND / ECONNREFUSED / CERT_HAS_EXPIRED …）。只取 message 会让所有
    // 网络故障都显示成没有信息量的 "fetch failed"，无法排查 —— 这一点是实际
    // 踩过的坑：界面上只看到 "fetch failed"，完全不知道该改什么。
    const detail = describeCause(err)
    return {
      result: {
        ok: false,
        status: 0,
        text: '',
        json: undefined,
        error: detail === undefined ? String(err?.message ?? err) : `${err.message}: ${detail}`,
      },
      retryable: isRetryableTransport(err),
    }
  }
}

/**
 * 连接层故障的错误码——这些代表"对话根本没谈成"，重试有意义。
 *
 * 刻意不含 ETIMEDOUT：那通常是对端慢或链路拥塞，重试只会让扫描等更久，而
 * 上层已有明确的超时语义。也不含证书类错误：重试不会让证书变有效。
 */
const RETRYABLE_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EAI_AGAIN',
])

/** 取出错误链最内层的错误码；aggregate（多地址全失败）取第一条。 */
function transportCode(err) {
  let cause = err?.cause
  if (cause === undefined || cause === null) return undefined
  if (Array.isArray(cause.errors) && cause.errors.length > 0) cause = cause.errors[0]
  return typeof cause.code === 'string' ? cause.code : undefined
}

/** 该故障是否属于"连接没建立起来"这一类。 */
function isRetryableTransport(err) {
  const code = transportCode(err)
  return code !== undefined && RETRYABLE_CODES.has(code)
}

/**
 * 把错误链上的 cause 摊平成一句可读的原因。
 *
 * 只取第一层 cause：那通常是 socket 层的错误码（ECONNREFUSED 等），再往下多是
 * 重复信息。同时识别常见错误码，给出人话解释，因为 "ENOTFOUND" 对多数人并不直观。
 *
 * @param {unknown} err
 * @returns {string|undefined}
 */
function describeCause(err) {
  let cause = err?.cause
  if (cause === undefined || cause === null) return undefined

  // aggregate 错误（多地址全部失败）会带 errors 数组，取第一条代表原因。
  if (Array.isArray(cause.errors) && cause.errors.length > 0) cause = cause.errors[0]

  const code = typeof cause.code === 'string' ? cause.code : undefined
  const raw = code ?? (typeof cause.message === 'string' ? cause.message : undefined)
  if (raw === undefined) return undefined

  const explained = {
    ENOTFOUND: '域名解析失败（DNS 不可达或域名不存在）',
    EAI_AGAIN: 'DNS 暂时不可用',
    ECONNREFUSED: '连接被拒绝（端点未监听或端口不对）',
    ECONNRESET: '连接被重置',
    ETIMEDOUT: '连接超时',
    EHOSTUNREACH: '主机不可达',
    ENETUNREACH: '网络不可达',
    CERT_HAS_EXPIRED: 'TLS 证书已过期',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS 证书链无法验证',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'TLS 自签名证书',
  }[code]

  return explained === undefined ? raw : `${raw}（${explained}）`
}

/** 读取响应体文本，超过上限则截断。 */
async function readCapped(res) {
  if (res.body === null) return ''
  const reader = res.body.getReader()
  const chunks = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done === true) break
      total += value.byteLength
      chunks.push(value)
      if (total >= MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {})
        break
      }
    }
  } catch {
    // 读取中断时保留已有内容：错误体往往是流式返回。
  }
  const merged = Buffer.concat(chunks.map((c) => Buffer.from(c)))
  return merged.toString('utf8')
}

/** 把任意外层包装的错误对象摊平成可读文本，供模式匹配使用。 */
export function flattenError(payload) {
  if (payload === undefined || payload === null) return ''
  if (typeof payload === 'string') return payload
  try {
    return JSON.stringify(payload)
  } catch {
    return String(payload)
  }
}
