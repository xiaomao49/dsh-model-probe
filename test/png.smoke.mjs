import { makeVisionProbe } from '../lib/png.js'
import { writeFileSync } from 'node:fs'

// 固定随机源，保证可复现
let seed = 42
const rng = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed / 0x7fffffff
}
for (let i = 0; i < 3; i++) {
  const p = makeVisionProbe(rng)
  writeFileSync(`/tmp/probe_${i}.png`, p.png)
  console.log(`图${i}: ${p.png.length}B  answer=${JSON.stringify(p.answer)}`)
  console.log(`     ${p.question.slice(0, 90)}`)
}
