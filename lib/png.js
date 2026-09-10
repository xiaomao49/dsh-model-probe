/**
 * 零依赖 PNG 编码器 —— 只为生成"视觉探针"图。
 *
 * 为什么需要它：判断一个模型是否真能看图，不能靠问"这是什么字"——很多网关
 * 会偷偷用 OCR 冒充视觉能力，照样答对。只有图形计数类问题（数几个圆、什么
 * 颜色）才必须真正解码像素。而图形计数要求图片每次随机，否则模型可以靠缓存
 * 或先验猜中。
 *
 * 所以这里在运行时合成 PNG：Node 自带 zlib 做 DEFLATE，CRC32 自己实现。
 */

import { deflateSync } from 'node:zlib'

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

/** 标准 PNG CRC32（多项式 0xEDB88320，初值全 1，结果取反）。 */
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

/**
 * 把 RGB 像素编码成 PNG Buffer。
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} rgb - 长度必须为 width*height*3，行优先。
 * @returns {Buffer} 完整 PNG 字节。
 */
export function encodePng(width, height, rgb) {
  if (rgb.length !== width * height * 3) {
    throw new Error(`encodePng: 期望 ${width * height * 3} 字节 RGB，实际 ${rgb.length}`)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor RGB
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // interlace

  // 每行前置一个 filter 字节（0 = None）。
  const raw = Buffer.alloc(height * (1 + width * 3))
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 3)] = 0
    rgb.subarray(y * width * 3, (y + 1) * width * 3).forEach((v, i) => {
      raw[y * (1 + width * 3) + 1 + i] = v
    })
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** 极简画布：只提供探针需要的填充图元。 */
class Canvas {
  constructor(width, height, bg = [255, 255, 255]) {
    this.width = width
    this.height = height
    this.buf = new Uint8Array(width * height * 3)
    this.fillRect(0, 0, width, height, bg)
  }

  fillRect(x0, y0, w, h, [r, g, b]) {
    for (let y = Math.max(0, y0); y < Math.min(this.height, y0 + h); y++) {
      for (let x = Math.max(0, x0); x < Math.min(this.width, x0 + w); x++) {
        const i = (y * this.width + x) * 3
        this.buf[i] = r
        this.buf[i + 1] = g
        this.buf[i + 2] = b
      }
    }
  }

  /** 实心圆（用距离平方判定，避免 sqrt）。 */
  fillCircle(cx, cy, radius, [r, g, b]) {
    const r2 = radius * radius
    for (let y = Math.max(0, cy - radius); y < Math.min(this.height, cy + radius); y++) {
      for (let x = Math.max(0, cx - radius); x < Math.min(this.width, cx + radius); x++) {
        const dx = x - cx
        const dy = y - cy
        if (dx * dx + dy * dy <= r2) {
          const i = (y * this.width + x) * 3
          this.buf[i] = r
          this.buf[i + 1] = g
          this.buf[i + 2] = b
        }
      }
    }
  }

  toPng() {
    return encodePng(this.width, this.height, this.buf)
  }
}

const PALETTE = {
  red: [220, 40, 40],
  green: [30, 160, 70],
  blue: [40, 80, 220],
  yellow: [240, 200, 30],
  purple: [150, 60, 200],
  orange: [240, 130, 30],
}

/**
 * 生成一张随机视觉探针图，并给出正确答案。
 *
 * 设计要点：只用"数量 + 颜色 + 形状"这类必须看像素才能答的问题，且每次随机，
 * 让模型无法靠 OCR 或先验蒙对。图片刻意不含任何文字。
 *
 * @param {() => number} [rng] - 注入的随机源（测试用，默认 Math.random）。
 * @returns {{ png: Buffer, base64: string, question: string, answer: object }}
 */
export function makeVisionProbe(rng = Math.random) {
  const pick = (arr) => arr[Math.floor(rng() * arr.length)]
  const colorNames = Object.keys(PALETTE)
  const chosenColor = pick(colorNames)
  const chosenShape = pick(['circle', 'square'])
  const count = 2 + Math.floor(rng() * 4) // 2..5

  // 干扰项：另一种颜色 + 另一种形状，数量也不同，避免"答案=总数"。
  const otherColor = pick(colorNames.filter((c) => c !== chosenColor))
  const otherShape = chosenShape === 'circle' ? 'square' : 'circle'
  const distractorCount = 1 + Math.floor(rng() * 3) // 1..3

  // 目标与干扰项交错排布，位置不泄露答案。
  const slots = []
  for (let i = 0; i < count; i++) slots.push({ kind: chosenShape, color: chosenColor })
  for (let i = 0; i < distractorCount; i++) slots.push({ kind: otherShape, color: otherColor })
  for (let i = slots.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[slots[i], slots[j]] = [slots[j], slots[i]]
  }

  // 布局必须保证图形互不接触：一旦重叠，同一颜色的两个图形会连成一片，
  // 图片上肉眼可数的数量就与 ground truth 不符，模型答对反被判错。
  // 画布尺寸按槽位数推导，而不是写死，否则图形一多就必然重叠。
  const size = 22 // 半径 / 半边长
  const gap = 18 // 图形之间的最小空隙
  const margin = 16
  const stride = size * 2 + gap
  const W = margin * 2 + stride * slots.length
  const H = size * 2 + margin * 2
  const canvas = new Canvas(W, H)

  const draw = (kind, colorName, index) => {
    const cx = margin + size + index * stride
    const cy = Math.round(H / 2)
    const rgb = PALETTE[colorName]
    if (kind === 'circle') canvas.fillCircle(cx, cy, size, rgb)
    else canvas.fillRect(cx - size, cy - size, size * 2, size * 2, rgb)
  }

  slots.forEach((s, i) => draw(s.kind, s.color, i))

  const png = canvas.toPng()
  const shapeWord = chosenShape === 'circle' ? 'circles' : 'squares'
  return {
    png,
    base64: png.toString('base64'),
    // 暴露原始像素供自检使用（连通域计数需要逐像素判定）。
    canvas: { width: canvas.width, height: canvas.height, rgb: canvas.buf },
    question:
      `Count exactly how many ${chosenColor} ${shapeWord} are in this image. ` +
      `Ignore every other shape and color. Answer with a single digit and nothing else.`,
    answer: { count, color: chosenColor, shape: chosenShape },
  }
}
