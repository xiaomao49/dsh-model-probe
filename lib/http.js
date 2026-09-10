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
 * @returns {Promise<{ok: boolean, status: number, text: string, json: unknown, error?: string}>}
 */
export async function request(url, options = {}) {
  const { method = 'GET', headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = options

  // 内部超时与外部取消合并：任一触发都要中止请求。
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
    return { ok: res.ok, status: res.status, text, json }
  } catch (err) {
    // 区分"外部取消"与"超时"，上层要给出不同提示。
    const name = err?.name
    if (name === 'AbortError' || name === 'TimeoutError') {
      const cancelled = name === 'AbortError' && signal?.aborted === true
      return { ok: false, status: 0, text: '', json: undefined, error: cancelled ? 'cancelled' : 'timeout' }
    }

    // fetch 抛出的固定是 TypeError('fetch failed')，真正的原因在 `cause` 里
    // （ENOTFOUND / ECONNREFUSED / CERT_HAS_EXPIRED …）。只取 message 会让所有
    // 网络故障都显示成没有信息量的 "fetch failed"，无法排查 —— 这一点是实际
    // 踩过的坑：界面上只看到 "fetch failed"，完全不知道该改什么。
    const detail = describeCause(err)
    return {
      ok: false,
      status: 0,
      text: '',
      json: undefined,
      error: detail === undefined ? String(err?.message ?? err) : `${err.message}: ${detail}`,
    }
  }
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
