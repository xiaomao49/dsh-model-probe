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
