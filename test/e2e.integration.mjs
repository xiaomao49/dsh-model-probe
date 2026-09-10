/**
 * 端到端集成测试：真实 ctx 形状 + 真端点 + 真 settings 读取。
 *
 * 与单测的区别：这里不打桩任何一层，验证的是"装进 DSH 后到底能不能用"。
 * 会发真实计费请求，因此**默认跳过**；需要显式开启：
 *
 *   PROBE_E2E=1 node --test test/e2e.integration.mjs
 *
 * 注意：这个测试只读配置、只发探测请求，**绝不写入 settings**。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

const require = createRequire(join(homedir(), '.dsh', 'profiles', 'web', 'package.json'))
const { parse: parseYaml } = require('yaml')

const SETTINGS = join(homedir(), '.dsh', 'settings.yaml')
const CREDENTIALS = join(homedir(), '.dsh', '.credentials.yaml')
const PROVIDER = process.env.PROBE_E2E_PROVIDER ?? 'cc-goat'

const enabled = process.env.PROBE_E2E === '1'

/** 从真实文件读出 provider 配置，喂给插件当作 settings.get 的返回值。 */
function loadRealSection() {
  const doc = parseYaml(readFileSync(SETTINGS, 'utf8'))
  return doc['llm-pi-ai']
}

/** 复刻 DSH 的凭据解析：环境变量优先，其次托管凭据库。 */
function realCredentials() {
  return {
    async resolve(ref) {
      const fromEnv = process.env[ref]
      if (typeof fromEnv === 'string' && fromEnv.length > 0) return { value: fromEnv }
      try {
        const creds = parseYaml(readFileSync(CREDENTIALS, 'utf8'))
        const v = creds?.refs?.[ref]
        if (typeof v === 'string' && v.length > 0) return { value: v }
      } catch {
        /* 凭据库缺失 */
      }
      return undefined
    },
  }
}

function makeRealCtx(section) {
  const tools = []
  const mutations = []
  return {
    ctx: {
      settings: {
        get: (ns) => (ns === 'llm-pi-ai' ? section : undefined),
        describe: () => [{ ns: 'llm-pi-ai', revision: 12345 }],
        // 记录写入意图但绝不真的落盘 —— 集成测试不应改动用户配置。
        mutate: async (ns, ops) => {
          mutations.push({ ns, ops })
          throw new Error('集成测试拒绝真实写入（这是刻意的）')
        },
      },
      tools: { register: (d) => tools.push(d) },
      get: (key) => (key === 'credentials' ? realCredentials() : undefined),
      effect: (fn) => fn(),
      logger: { info: () => {}, debug: () => {}, warn: () => {} },
    },
    tools,
    mutations,
  }
}

test('端到端：对真实端点扫描并产出可解释的审计结论', { skip: !enabled }, async () => {
  const section = loadRealSection()
  assert.ok(section?.providers?.[PROVIDER], `settings.yaml 里应有 provider ${PROVIDER}`)

  const { ctx, tools } = makeRealCtx(section)
  apply(ctx, { probeProviders: [PROVIDER] })

  const scanTool = tools.find((t) => t.name === 'model_probe_scan')
  const result = await scanTool.execute({ provider: PROVIDER }, {})

  assert.equal(result.ok, true, `扫描应成功：${JSON.stringify(result).slice(0, 300)}`)
  assert.ok(result.models.length > 0, '至少应扫描到一个模型')
  assert.ok(result.budget.requests > 0, '应确实发出了请求')

  // 打印完整结论，供人工复核。
  console.log('\n' + '═'.repeat(76))
  console.log(`端到端扫描 ${PROVIDER}：${result.budget.requests} 次请求，约 ${result.budget.outputTokens} token`)
  console.log('═'.repeat(76))
  for (const m of result.models) {
    console.log(`\n模型 ${m.model}   [${JSON.stringify(m.summary.counts)}]`)
    // 工具输出只带"需要关注"的字段（ok/unknown 已在 summary 里计数），
    // 这是刻意的：给模型看的载荷不该塞满正常项。
    for (const f of m.issues) {
      const mark = { 'out-of-range': '✘越界', mismatch: '△不符', missing: '＋缺失' }[f.verdict] ?? '?'
      console.log(
        `  ${mark.padEnd(7)} ${f.field.padEnd(18)} 当前=${JSON.stringify(f.current) ?? '-'}  实测=${JSON.stringify(f.measured) ?? '-'}`,
      )
      if (f.note !== undefined) console.log(`          ↳ ${f.note}`)
      if (f.evidence !== undefined) console.log(`          ↳ 证据: ${f.evidence}（置信度 ${f.confidence}）`)
    }
    for (const n of m.notes) console.log(`  注: ${n}`)
  }
  console.log(`\n计划写入 ${result.plan.length} 处修正：`)
  for (const p of result.plan) console.log(`  ${p.kind} ${p.path} = ${JSON.stringify(p.value)}`)
  console.log('═'.repeat(76) + '\n')
})

test('端到端：真实配置读出的每个模型都能定位到写入下标', { skip: !enabled }, async () => {
  const section = loadRealSection()
  const { ctx, tools } = makeRealCtx(section)
  apply(ctx, { probeProviders: [PROVIDER] })

  const status = await tools.find((t) => t.name === 'model_probe_status').execute({}, {})
  const p = status.providers.find((x) => x.id === PROVIDER)
  assert.ok(p, 'status 应包含目标 provider')
  // 下标必须与 models 数组一致，否则写入会改错条目。
  p.models.forEach((m, i) => assert.equal(m.index, i))
})
