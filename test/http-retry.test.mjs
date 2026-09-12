/**
 * 传输层重试测试。
 *
 * 为什么值得写：重试的边界很窄——只有"连接根本没建立起来"才该重试。放宽一点
 * 就会变成"端点说的话不合我意就再问一遍"，那既浪费请求，也会把端点真实给出的
 * 拒绝证据重试掉。这里把两侧边界都钉住。
 *
 * 背景（实测）：某个网关会间歇性 ECONNRESET——同一分钟内连续发请求，有的成功
 * 有的被重置。没有重试时，一次抖动就让整个 provider 的 contextWindow 取证失败。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from '../lib/http.js'

/** 用一次性的 fetch 替身跑一段用例，结束后必定还原全局 fetch。 */
async function withFetch(impl, fn) {
  const original = globalThis.fetch
  globalThis.fetch = impl
  try {
    return await fn()
  } finally {
    globalThis.fetch = original
  }
}

/** 构造一个带 cause.code 的 fetch 失败，形状与 undici 一致。 */
function failWith(code) {
  return () => {
    const err = new TypeError('fetch failed')
    err.cause = Object.assign(new Error(code), { code })
    return Promise.reject(err)
  }
}

test('ECONNRESET 会重试，并在后续成功时返回成功结果', async () => {
  let calls = 0
  const impl = () => {
    calls += 1
    if (calls === 1) return failWith('ECONNRESET')()
    return Promise.resolve(new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }))
  }

  const res = await withFetch(impl, () => request('https://example.invalid/x', { retries: 2 }))

  assert.equal(calls, 2, '应当恰好重试一次')
  assert.equal(res.ok, true)
  assert.deepEqual(res.json, { ok: true })
})

test('重试次数用尽后如实返回最后一次的失败原因', async () => {
  let calls = 0
  const impl = () => {
    calls += 1
    return failWith('ECONNRESET')()
  }

  const res = await withFetch(impl, () => request('https://example.invalid/x', { retries: 2 }))

  assert.equal(calls, 3, '初次 + 两次重试')
  assert.equal(res.ok, false)
  assert.equal(res.status, 0)
  assert.match(res.error, /ECONNRESET/)
  assert.match(res.error, /连接被重置/, '错误文本必须是给人看的中文解释')
})

test('HTTP 错误状态不触发重试——那正是要读的证据', async () => {
  let calls = 0
  const impl = () => {
    calls += 1
    return Promise.resolve(new Response('{"error":"max_tokens too large"}', { status: 400 }))
  }

  const res = await withFetch(impl, () => request('https://example.invalid/x', { retries: 2, method: 'POST', body: {} }))

  assert.equal(calls, 1, '读到响应就不是故障，绝不重试')
  assert.equal(res.status, 400)
  assert.equal(res.ok, false)
})

test('不可重试的连接故障（证书错误）不浪费请求', async () => {
  let calls = 0
  const impl = () => {
    calls += 1
    return failWith('CERT_HAS_EXPIRED')()
  }

  const res = await withFetch(impl, () => request('https://example.invalid/x', { retries: 2 }))

  assert.equal(calls, 1, '证书过期重试多少次都一样')
  assert.match(res.error, /CERT_HAS_EXPIRED/)
})

test('外部取消后不再重试——「停止」必须立即生效', async () => {
  let calls = 0
  const controller = new AbortController()
  const impl = () => {
    calls += 1
    controller.abort()
    return failWith('ECONNRESET')()
  }

  const res = await withFetch(impl, () =>
    request('https://example.invalid/x', { retries: 3, signal: controller.signal }),
  )

  assert.equal(calls, 1)
  assert.equal(res.ok, false)
})

test('默认不重试：没显式要求就保持一次请求一次结果', async () => {
  let calls = 0
  const impl = () => {
    calls += 1
    return failWith('ECONNRESET')()
  }

  await withFetch(impl, () => request('https://example.invalid/x'))

  assert.equal(calls, 1)
})
