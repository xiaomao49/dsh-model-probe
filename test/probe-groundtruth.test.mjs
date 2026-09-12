/**
 * 探针图自检：用连通域计数证明"图上的图形数量 == ground truth"。
 *
 * 这不是可有可无的测试。第一版布局有 bug：图形重叠糊成一片，肉眼只有 3 个
 * 黄方块，答案却写 5。这种错误会让模型答对反被判成"不支持视觉"——方向正好
 * 反了，比崩溃更危险。所以每次生成都必须验证一次。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeVisionProbe } from '../lib/png.js'
import { extractDeclaredCount, probeVision } from '../lib/probe.js'

/**
 * 对原始 RGB 缓冲做连通域计数：统计"非背景且颜色接近指定色"的独立斑块数量。
 * 四邻域 flood fill，颜色匹配用容差比较（PNG 无损，容差仅防御未来改动）。
 */
export function countBlobs(width, height, rgb, target, tolerance = 40) {
  const near = (i) =>
    Math.abs(rgb[i] - target[0]) <= tolerance &&
    Math.abs(rgb[i + 1] - target[1]) <= tolerance &&
    Math.abs(rgb[i + 2] - target[2]) <= tolerance

  const seen = new Uint8Array(width * height)
  let blobs = 0
  const stack = []
  for (let start = 0; start < width * height; start++) {
    if (seen[start]) continue
    if (!near(start * 3)) continue
    blobs++
    stack.push(start)
    seen[start] = 1
    while (stack.length > 0) {
      const p = stack.pop()
      const px = p % width
      const py = (p - px) / width
      const neighbours = [
        px > 0 ? p - 1 : -1,
        px < width - 1 ? p + 1 : -1,
        py > 0 ? p - width : -1,
        py < height - 1 ? p + width : -1,
      ]
      for (const n of neighbours) {
        if (n < 0 || seen[n]) continue
        if (!near(n * 3)) continue
        seen[n] = 1
        stack.push(n)
      }
    }
  }
  return blobs
}

test('探针图的图形数量必须等于 ground truth（连通域计数）', () => {
  const PALETTE = {
    red: [220, 40, 40],
    green: [30, 160, 70],
    blue: [40, 80, 220],
    yellow: [240, 200, 30],
    purple: [150, 60, 200],
    orange: [240, 130, 30],
  }

  // 遍历多种随机种子，覆盖不同数量/颜色/形状组合。
  let seed = 1
  const rng = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }

  for (let i = 0; i < 60; i++) {
    const probe = makeVisionProbe(rng)
    const { width, height, rgb } = probe.canvas
    const target = PALETTE[probe.answer.color]
    const found = countBlobs(width, height, rgb, target)

    assert.equal(
      found,
      probe.answer.count,
      `第 ${i} 轮：图上 ${probe.answer.color} 图形实际 ${found} 个，ground truth 写的是 ${probe.answer.count} 个`,
    )

    // 反向检查：另一种颜色也必须自洽，否则干扰项会污染答案。
    const others = Object.keys(PALETTE).filter((c) => c !== probe.answer.color)
    const matching = others.filter((c) => {
      const n = countBlobs(width, height, rgb, PALETTE[c])
      return n > 0
    })
    assert.equal(matching.length, 1, `第 ${i} 轮：应恰好有一种干扰色，实际 ${matching.join(',')}`)
  }
})

// ── "看不到图"识别：这是过度声明能力最危险的形态 ─────────────────────────────
//
// 实测 deepseek-v4-pro 收到图片后回答 "I can't see the image, so I can't count
// the yellow circles." —— HTTP 200、finish=stop、无任何报错。若把这种回答当成
// "读不出数字"的无结论，就漏掉了真实问题：声明了图像能力，图片却被静默忽略。

/** 构造一个只返回指定文本的假端点。 */
function stubEndpoint(text, { finish = 'stop' } = {}) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: text }, finish_reason: finish }],
        usage: { completion_tokens: 10, completion_tokens_details: { reasoning_tokens: 5 } },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

test('模型回答"看不到图片"→ 判定为不支持图像，而不是无结论', async () => {
  const stub = stubEndpoint("I can't see the image, so I can't count the yellow circles.")
  try {
    const r = await probeVision({
      baseURL: 'https://x.invalid/v1',
      api: 'openai-completions',
      apiKey: 'k',
      model: 'm',
      budget: { spend() {}, addTokens() {} },
    })
    assert.equal(r.ok, true, `应给出结论，实际：${JSON.stringify(r)}`)
    assert.equal(r.supportsImage, false)
  } finally {
    stub.restore()
  }
})

test('中文"看不到图片"同样识别', async () => {
  const stub = stubEndpoint('抱歉，我无法查看图片，因此无法数出黄色圆形的数量。')
  try {
    const r = await probeVision({
      baseURL: 'https://x.invalid/v1',
      api: 'openai-completions',
      apiKey: 'k',
      model: 'm',
      budget: { spend() {}, addTokens() {} },
    })
    assert.equal(r.ok, true)
    assert.equal(r.supportsImage, false)
  } finally {
    stub.restore()
  }
})

test('正文被推理占满时自动加大额度重试一次', async () => {
  // 每次尝试都会生成一张**新图**，所以第二张图的正确答案与第一张不同。
  // 用两个相同种子的 rng：一个预先推算答案，一个交给被测代码使用。
  const rngFor = (seed0) => {
    let s = seed0
    return () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff
      return s / 0x7fffffff
    }
  }
  const predict = rngFor(7)
  makeVisionProbe(predict) // 第一次尝试的图（其回答是空的，答案用不到）
  const secondExpected = makeVisionProbe(predict).answer.count

  let attempt = 0
  const original = globalThis.fetch
  const seen = []
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    seen.push(body.max_tokens)
    attempt += 1
    // 第一次：额度被思考吃光，正文为空且被截断；之后：正常答对。
    if (attempt === 1) {
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'length' }], usage: {} }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: String(secondExpected) }, finish_reason: 'stop' }],
        usage: { completion_tokens: 20 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  try {
    const r = await probeVision({
      baseURL: 'https://x.invalid/v1',
      api: 'openai-completions',
      apiKey: 'k',
      model: 'm',
      budget: { spend() {}, addTokens() {} },
      rng: rngFor(7),
    })
    assert.equal(seen.length, 2, `应当恰好重试一次，实际 ${seen.length} 次`)
    assert.ok(seen[1] > seen[0], `重试的额度应更大：${seen.join(' → ')}`)
    assert.equal(r.ok, true, `应给出结论：${JSON.stringify(r)}`)
    assert.equal(r.supportsImage, true)
  } finally {
    globalThis.fetch = original
  }
})

test('读不出数字不重发同一张图，而是交给差异探针（避免无谓请求）', async () => {
  // 该 stub 的输出形状对两个阶段都不合格式：计数阶段读不出数字、交叉核对阶段
  // 读不出 IMAGE_n 标注。因此只应产生计数 3 次 + 交叉核对 1 次，绝不原地重试。
  const stub = stubEndpoint('这是一段没有数字的回答')
  try {
    const r = await probeVision({
      baseURL: 'https://x.invalid/v1',
      api: 'openai-completions',
      apiKey: 'k',
      model: 'm',
      budget: { spend() {}, addTokens() {} },
    })
    assert.equal(r.ok, false)
    assert.match(r.reason, /交叉核对未读出两个 IMAGE_n 标注/)
    assert.equal(stub.calls.length, 4, `计数 3 次 + 差异探针 1 次，实际 ${stub.calls.length}`)
  } finally {
    stub.restore()
  }
})

test('答 0 是结构性强证据：直接判不支持，不重试', async () => {
  // 探针图的目标图形数恒为 2..5，答 0 在结构上不可能 —— 这是"看不到"的证据，
  // 不是数错。因此不应浪费一次重试。
  const stub = stubEndpoint('0')
  try {
    const r = await probeVision({
      baseURL: 'https://x.invalid/v1',
      api: 'openai-completions',
      apiKey: 'k',
      model: 'm',
      budget: { spend() {}, addTokens() {} },
    })
    assert.equal(r.ok, true)
    assert.equal(r.supportsImage, false)
    assert.match(r.raw, /答 0/)
    assert.equal(stub.calls.length, 1, '答 0 无需重试')
  } finally {
    stub.restore()
  }
})

test('答对一个非零错数：换图复核，第二次答对则判支持', async () => {
  // 这是关键的不对称保护：有视觉但偶尔数错的模型不应被判成"不支持"，
  // 否则 DSH 会在该模型上永久拒收图片。
  //
  // 每次尝试用的是新图，因此必须分别推算两次的正确数 —— 用两个相同种子的 rng。
  const rngFor = (seed0) => {
    let s = seed0
    return () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff
      return s / 0x7fffffff
    }
  }
  const predict = rngFor(99)
  const firstExpected = makeVisionProbe(predict).answer.count
  const secondExpected = makeVisionProbe(predict).answer.count

  // 第一次故意给一个非零错数（数量恒为 2..5，所以挑一个不等于正确答案且非 0 的值）
  const wrong = [1, 2, 3, 4, 5, 6].find((n) => n !== firstExpected && n !== 0) ?? 6
  assert.notEqual(wrong, 0)
  assert.notEqual(wrong, firstExpected)

  let n = 0
  const original = globalThis.fetch
  globalThis.fetch = async () => {
    n += 1
    const text = n === 1 ? String(wrong) : String(secondExpected)
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: text }, finish_reason: 'stop' }],
        usage: { completion_tokens: 5 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  try {
    const r = await probeVision({
      baseURL: 'https://x.invalid/v1',
      api: 'openai-completions',
      apiKey: 'k',
      model: 'm',
      budget: { spend() {}, addTokens() {} },
      rng: rngFor(99),
    })
    assert.equal(n, 2, '应换图复核一次')
    assert.equal(r.ok, true, `应给出结论：${JSON.stringify(r)}`)
    assert.equal(r.supportsImage, true, '第二次答对应判为支持')
  } finally {
    globalThis.fetch = original
  }
})

test('两次都答错非零值：交叉核对也证明不了"看得见"，则不下"支持图像"的结论', async () => {
  // 确保"保护真有视觉的模型"不会滑向"把瞎猜当视觉"。恒定给一个非零错数
  // （1 永远不可能是正确答案，因为数量是 2..5）—— 计数三次都错，接着的差异
  // 探针两次读数也相同，说明读数没有跟着图像内容变化。此时仍不得声称支持图像。
  const original = globalThis.fetch
  let n = 0
  globalThis.fetch = async () => {
    n += 1
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: '1' }, finish_reason: 'stop' }],
        usage: { completion_tokens: 5 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  try {
    const r = await probeVision({
      baseURL: 'https://x.invalid/v1',
      api: 'openai-completions',
      apiKey: 'k',
      model: 'm',
      budget: { spend() {}, addTokens() {} },
    })
    assert.equal(n, 4, '计数三次 + 差异探针一次')
    assert.equal(r.ok, false, `不得凭瞎猜判支持：${JSON.stringify(r)}`)
    assert.match(r.reason, /交叉核对未读出两个 IMAGE_n 标注/)
  } finally {
    globalThis.fetch = original
  }
})

test('回归 0.1.10：枚举式叙述不得把列表序号当答案', async () => {
  // 实测 deepseek/deepseek-v4.1-flash 会对探针图按序描述：
  //   "… 1. A yellow circle 2. A blue square … Therefore, the answer is **3**."
  // 旧解析取"第一个数字"，读到列表序号 1，把正确答案读成错答；两次误读之后
  // 插件报出"实测 text"，把该模型的图像能力判反了。答案只认显式声明。
  const enumerated =
    'Looking at the image from left to right, I see four shapes:\n\n' +
    '1. A yellow circle\n2. A blue square\n3. A yellow circle\n4. A blue square\n\n' +
    'Ignoring the blue squares, the yellow circles number 2.\n\n' +
    'Therefore, the answer is **2**.'
  assert.equal(extractDeclaredCount(enumerated), 2, '取声明值，不取列表序号')
})

test('回归 0.1.10：探针末行格式 TOTAL=<digit> 必须被优先识别', async () => {
  assert.equal(extractDeclaredCount('Counting them: 1, 2, 3.\nTOTAL=3'), 3)
  assert.equal(extractDeclaredCount('TOTAL = 4'), 4)
  assert.equal(extractDeclaredCount('答案：5'), 5)
  // 没有声明标记时退化为"最后一个独立数字"，仍不得取到列表序号。
  assert.equal(extractDeclaredCount('1. red circle\n2. blue square\n3. red circle\n总共有 2 个'), 2)
})

test('交叉核对：读数随图像变化即判定支持图像（即使数不准）', async () => {
  // 计数三次都读不出正确答案，但差异探针两次读数不同 —— 说明回答确实来自像素。
  const original = globalThis.fetch
  let n = 0
  globalThis.fetch = async () => {
    n += 1
    const body =
      n <= 3
        ? '1' // 计数三次均答错（数量恒为 2..5）
        : 'IMAGE_1=2\nIMAGE_2=5'
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: body }, finish_reason: 'stop' }],
        usage: { completion_tokens: 5 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  try {
    const r = await probeVision({
      baseURL: 'https://x.invalid/v1',
      api: 'openai-completions',
      apiKey: 'k',
      model: 'm',
      budget: { spend() {}, addTokens() {} },
    })
    assert.equal(n, 4, '计数三次 + 差异探针一次')
    assert.equal(r.ok, true, `应给出结论：${JSON.stringify(r)}`)
    assert.equal(r.supportsImage, true)
    assert.match(r.raw, /读数随图像变化/)
  } finally {
    globalThis.fetch = original
  }
})

test('读不出数字只是"无结论"，不得被当成"看不到图"', async () => {
  // 模型答了一段叙述却没有数字：这是无结论，必须继续换图复核，绝不能据此判
  // "不支持图像"（代价不对称：判错会让 DSH 永久拒收图片）。
  const original = globalThis.fetch
  let n = 0
  globalThis.fetch = async () => {
    n += 1
    const body = n <= 3 ? '我看不清这张图里有什么。' : 'IMAGE_1=3\nIMAGE_2=2'
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: body }, finish_reason: 'stop' }],
        usage: { completion_tokens: 5 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  try {
    const r = await probeVision({
      baseURL: 'https://x.invalid/v1',
      api: 'openai-completions',
      apiKey: 'k',
      model: 'm',
      budget: { spend() {}, addTokens() {} },
    })
    assert.equal(n, 4, '读不出数字应换图复核，而不是直接下结论')
    assert.equal(r.ok, true)
    assert.equal(r.supportsImage, true, '差异探针读数不同即可确认支持')
  } finally {
    globalThis.fetch = original
  }
})
