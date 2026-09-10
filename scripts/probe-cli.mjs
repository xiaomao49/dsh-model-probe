/**
 * 命令式探测 CLI：不打开设置页，直接对真实端点跑一遍探测并打印结论。
 *
 * 存在意义：设置页适合日常审计，但这个脚本适合脚本化与排障——把一个 provider
 * 的每个模型的能力结论一次性打到终端上，可直接与厂商文档对照。
 *
 * 用法：
 *   node scripts/probe-cli.mjs --provider <name> [--models a,b] [--no-vision]
 *                              [--settings <path>] [--credentials <path>]
 *
 * DSH 主目录默认取 $DSH_HOME 或 ~/.dsh，可用参数覆盖以便在别处运行。
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Budget, listModels, elicitMaxTokens, elicitEfforts, probeVision } from '../lib/probe.js'

/**
 * 解析 yaml 包。
 *
 * 这个脚本不是插件产物，运行环境未必有 yaml 依赖，所以按几条路径依次尝试：
 * 自身依赖 → DSH profile 的 node_modules。全都不可用时给出明确指引，
 * 而不是抛一个难懂的 ERR_MODULE_NOT_FOUND。
 */
async function loadYaml() {
  try {
    return (await import('yaml')).parse
  } catch {
    /* 继续尝试 DSH 目录 */
  }
  const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  for (const candidate of ['web', 'default']) {
    try {
      const req = createRequire(join(dshHome, 'profiles', candidate, 'package.json'))
      const resolved = req.resolve('yaml')
      return (await import(pathToFileURL(resolved).href)).parse
    } catch {
      /* 换下一个候选 */
    }
  }
  throw new Error(
    '需要 yaml 包来读取 settings.yaml。请在插件目录执行 `npm install yaml`，或在装有 DSH 的机器上运行。',
  )
}

const parseYaml = await loadYaml()

const DSH_HOME = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
let SETTINGS = join(DSH_HOME, 'settings.yaml')
let CREDENTIALS = join(DSH_HOME, '.credentials.yaml')

/** 极简参数解析，避免为一个小脚本引入依赖。 */
function parseArgs(argv) {
  const out = { vision: true }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--provider') out.provider = argv[++i]
    else if (a === '--models') out.models = argv[++i].split(',').map((s) => s.trim()).filter(Boolean)
    else if (a === '--no-vision') out.vision = false
    else if (a === '--budget') out.budget = Number(argv[++i])
    else if (a === '--settings') out.settings = argv[++i]
    else if (a === '--credentials') out.credentials = argv[++i]
    else if (a === '--help' || a === '-h') out.help = true
  }
  return out
}

/** 从 settings.yaml 里取出某个 provider 的路由定义。 */
function loadRoute(provider) {
  const doc = parseYaml(readFileSync(SETTINGS, 'utf8'))
  const profiles = doc?.['llm-pi-ai']?.providers
  const profile = profiles?.[provider]
  if (profile === undefined) {
    throw new Error(`settings.yaml 里没有 llm-pi-ai.providers.${provider}`)
  }
  return profile
}

/** 从凭据库解析 apiKeyEnv 指向的密钥。绝不打印密钥本身。 */
function loadKey(profile) {
  const ref = profile.apiKeyEnv
  if (typeof ref !== 'string' || ref.length === 0) return undefined
  if (process.env[ref] !== undefined && process.env[ref].length > 0) return process.env[ref]
  try {
    const creds = parseYaml(readFileSync(CREDENTIALS, 'utf8'))
    const v = creds?.refs?.[ref]
    if (typeof v === 'string' && v.length > 0) return v
  } catch {
    /* 凭据库缺失时降级为无鉴权 */
  }
  return undefined
}

const MARK = { high: '高', medium: '中', low: '低' }

async function main() {
  const args = parseArgs(process.argv.slice(2))

  if (args.help === true) {
    console.log(
      [
        '用法: node scripts/probe-cli.mjs --provider <名称> [选项]',
        '',
        '选项:',
        '  --provider <名称>       llm-pi-ai 里的 provider 路由名（必填）',
        '  --models a,b            只探测这些模型（默认全部）',
        '  --no-vision             跳过图像能力实证（该层是唯一产生输出 token 的）',
        '  --budget <n>            单次运行的请求数上限（默认 200）',
        '  --settings <路径>       settings.yaml 路径（默认 $DSH_HOME/settings.yaml）',
        '  --credentials <路径>    凭据文件路径（默认 $DSH_HOME/.credentials.yaml）',
        '',
        '凭据也可通过环境变量提供：apiKeyEnv 指向的变量名存在时优先使用。',
      ].join('\n'),
    )
    return
  }

  if (typeof args.provider !== 'string' || args.provider.length === 0) {
    throw new Error('缺少 --provider。用 --help 查看用法。')
  }
  // 允许覆盖路径，便于在非默认位置运行。
  if (typeof args.settings === 'string') SETTINGS = args.settings
  if (typeof args.credentials === 'string') CREDENTIALS = args.credentials

  const provider = args.provider
  const profile = loadRoute(provider)
  const apiKey = loadKey(profile)

  const baseURL = profile.baseURL
  const api = profile.api ?? 'openai-completions'
  const models = args.models ?? (profile.models ?? []).map((m) => m.id)

  console.log('═'.repeat(78))
  console.log(`探测 provider: ${provider}`)
  console.log(`  baseURL : ${baseURL}`)
  console.log(`  api     : ${api}`)
  console.log(`  凭据    : ${apiKey === undefined ? '未解析到（将尝试无鉴权）' : `已解析（长度 ${apiKey.length}）`}`)
  console.log(`  模型    : ${models.join(', ')}`)
  console.log('═'.repeat(78))

  const budget = new Budget(args.budget ?? 200)
  const rng = Math.random

  // ── ① 端点自述 ─────────────────────────────────────────────────────────
  console.log('\n① 端点自述 GET /models')
  const listing = await listModels({ baseURL, api, apiKey, budget })
  if (listing.ok) {
    console.log(`   收到 ${listing.models.length} 个模型`)
    for (const m of listing.models) {
      if (!models.includes(m.id)) continue
      console.log(
        `   · ${m.id}\n       ctx=${m.contextWindow ?? '未披露'}  out=${m.maxTokens ?? '未披露'}  input=${m.input?.join('+') ?? '未披露'}`,
      )
    }
  } else {
    console.log(`   失败：${listing.reason}`)
  }

  // ── ②③ 逐模型取证 ──────────────────────────────────────────────────────
  for (const model of models) {
    console.log('\n' + '─'.repeat(78))
    console.log(`模型 ${model}`)

    // ② max_tokens 约束
    if (budget.canContinue()) {
      const r = await elicitMaxTokens({ baseURL, api, apiKey, model, budget })
      if (r.ok) {
        console.log(`   ② maxTokens 上限 = ${r.max}   [证据: 端点约束 · 置信度 ${MARK.high}]`)
      } else {
        console.log(`   ② maxTokens    未知  (${r.reason})`)
      }
    }

    // ② reasoning_effort 档位
    if (budget.canContinue()) {
      const r = await elicitEfforts({ baseURL, api, apiKey, model, budget })
      if (r.ok) {
        const levels = r.levels.length > 0 ? r.levels.join('/') : '（端点接受 off，档位集合未披露）'
        console.log(`   ② 推理档位      = ${levels}   [证据: 端点约束 · 置信度 ${MARK.high}]`)
        console.log(`      可否关闭思考  = ${r.offAccepted ? '可以（端点接受 off）' : '不可（端点拒绝 off）'}`)
      } else {
        console.log(`   ② 推理档位      未知  (${r.reason})`)
      }
    }

    // ③ 视觉能力实证
    if (args.vision && budget.canContinue()) {
      const r = await probeVision({ baseURL, api, apiKey, model, budget, rng })
      if (r.ok) {
        console.log(
          `   ③ 图像输入      = ${r.supportsImage ? '支持' : '不支持'}   [证据: 图形计数实证 · 置信度 ${MARK.high}]`,
        )
        console.log(`      ${r.raw}`)
      } else {
        console.log(`   ③ 图像输入      未知  (${r.reason})`)
      }
    }
  }

  console.log('\n' + '═'.repeat(78))
  console.log(`预算消耗：${budget.requests} 次请求，输出约 ${budget.outputTokens} token`)
  console.log(`  （取证请求被端点拒绝，通常不计费；视觉探针是唯一产生输出的部分）`)
  if (budget.exhausted) console.log('  ⚠ 已触及请求预算上限，部分探测被跳过')
}

main().catch((e) => {
  console.error('探测失败：', e?.message ?? e)
  process.exitCode = 1
})
