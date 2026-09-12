/**
 * dsh-model-probe — 宿主侧。
 *
 * 定位：模型配置「实测器」。向端点取证，审计并补全 llm-pi-ai 的模型能力声明。
 *
 * 与其它配置填充插件的根本区别：填充器只补缺失的字段，本插件先回答
 * "现在写的值是不是错的"。你遇到的 GLM maxTokens=384000 属于后者——它不缺值，
 * 它有一个越界的值，每次请求都会 400，而填充器看到字段"有值"就跳过了。
 *
 * 安全与成本纪律（硬约束，不是建议）：
 *   - 探测默认关闭，逐 provider 开启；未开启的 provider 绝不发请求；
 *   - 凭据按次解析，不缓存、不落盘、不进日志、不出现在任何返回值；
 *   - 写入前自动备份 settings.yaml；
 *   - 写入带 revision 乐观锁，他人改动则放弃而非覆盖；
 *   - 扫描只读，写配置必须显式确认。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import {
  LLM_PI_AI_NS,
  listProviders,
  readPiSection,
  readProvider,
  readRevision,
  resolveApiKey,
  applyOps,
} from './store.js'
import { scanProvider, planOps, describeOps, DEFAULT_POLICY } from './scan.js'
import { CONFIDENCE_ORDER } from './audit.js'

export const name = 'dsh-model-probe'

// tools 用于注册诊断工具；settings 是读写目标命名空间的前提。
export const inject = ['tools', 'settings']

/** 插件自己的配置命名空间，存探测策略（与 llm-pi-ai 分开，避免污染目标配置）。 */
export const POLICY_NS = 'model-probe'

/**
 * 探测策略的 schema。
 *
 * 每个字段都带默认值，因此一个空 section 也能解析成可用的策略——用户手动在
 * settings.yaml 里写 `model-probe: {}` 不会让插件失效。
 */
export const PolicySchema = z.object({
  /** 允许探测的 provider 名单。空数组 = 全部关闭，这是刻意的默认值。 */
  enabledProviders: z.array(z.string()).default([]),
  /** 单次扫描的请求数上限，防止误开导致大量请求。 */
  maxRequestsPerScan: z.number().step(1).min(1).max(500).default(DEFAULT_POLICY.maxRequestsPerScan),
  /** 是否做图像能力实证（唯一产生输出 token 的环节）。 */
  visionProbe: z.boolean().default(true),
  /** 数值比较容差：差距在此比例内不改配置，超过才覆盖。 */
  toleranceRatio: z.number().min(0).max(0.5).default(DEFAULT_POLICY.toleranceRatio),
})

const HTTP_PREFIX = '/api/model-probe'

/** 扫描并发保护：同一时刻只允许一个扫描在跑，避免重复计费。 */
const state = {
  scanning: false,
  controller: undefined,
  policy: { ...DEFAULT_POLICY },
  /** 策略是否已挂到 settings 命名空间（决定改动能否持久化）。 */
  persist: false,
}

// ── HTTP 辅助 ────────────────────────────────────────────────────────────────

function send(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

/**
 * 校验请求来自本机同源页面。
 *
 * 这个路由能读取 provider 配置并发起探测，必须确认调用方是本地界面，
 * 而不是某个恰好能访问 127.0.0.1 的外部页面。
 */
function isTrustedRequest(req) {
  const address = req.socket?.remoteAddress ?? ''
  if (address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1') return true
  const host = req.headers?.host ?? ''
  const origin = req.headers?.origin ?? ''
  if (origin === '') return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text.length === 0) return {}
  return JSON.parse(text)
}

// ── 核心操作 ─────────────────────────────────────────────────────────────────

/**
 * 探测开关的**有效集合**：持久化的白名单与当前真实存在的 provider 求交。
 *
 * 为什么要求交：`enabledProviders` 是一份持久化白名单，而 provider 列表来自
 * llm-pi-ai。用户在模型设置里删掉一个 provider 时，白名单里那条记录不会跟着
 * 消失——于是设置页会显示"当前已开启探测：cc-goat、op-go、op-zen"，而 op-zen
 * 早就不在模型配置里了；界面上又没有它的开关，用户删了却看它还在，只能手工去
 * 改 settings.yaml。这是实际收到过的反馈。
 *
 * 为什么不干脆在加载时自动清理白名单：那会在用户只是临时删掉一个 provider
 * （准备改完再加回来）时静默丢掉他的授权状态。保留原始值、只在展示与决策上
 * 用交集，是可预期的行为；多出来的部分单独报告，并在下一次写开关时自然收敛
 * （界面提交的本来就是交集）。
 *
 * @returns {{enabled: string[], stale: string[]}} enabled 为有效集合，stale 为
 *   白名单里已不存在于配置中的名字。
 */
function enabledIntersection(section) {
  const configured = new Set(listProviders(section))
  const stored = Array.isArray(state.policy.enabledProviders) ? state.policy.enabledProviders : []
  return {
    enabled: stored.filter((id) => configured.has(id)),
    stale: stored.filter((id) => !configured.has(id)),
  }
}

/** 汇总当前状态：有哪些 provider、探测开了哪些、以及一个粗略的配置健康概览。 */
function buildStatus(ctx) {
  const { section, raw, reason } = readPiSection(ctx)
  const { enabled, stale } = enabledIntersection(section)
  const providers = listProviders(section).map((id) => {
    const profile = readProvider(section, id)
    return {
      id,
      displayName: profile?.displayName ?? id,
      api: profile?.api,
      baseURL: profile?.baseURL,
      modelCount: profile?.models.length ?? 0,
      models: (profile?.models ?? []).map((m, index) => ({
        index,
        id: m?.id,
        contextWindow: m?.contextWindow,
        maxTokens: m?.maxTokens,
        hasEfforts: m?.reasoningEfforts !== undefined,
        input: Array.isArray(m?.input) ? m.input : undefined,
      })),
      probeEnabled: enabled.includes(id),
      hasKey: typeof profile?.apiKeyEnv === 'string' && profile.apiKeyEnv.length > 0,
    }
  })
  return {
    ok: true,
    providers,
    policy: { ...state.policy, enabledProviders: enabled, staleProviders: stale },
    scanning: state.scanning,
    revision: readRevision(ctx),
    // 告诉界面策略是否已持久化：未持久化时开关重启后会重置，用户应当知情。
    policyPersisted: state.persist === true,
    // 能否安全写入。拿不到原始用户层时必须如实告诉用户，而不是冒险写入
    // 把 schema 默认值固化进配置。
    writable: raw === true,
    writeBlockedReason: reason,
  }
}

/** 执行一次扫描（只读，不写配置）。 */
async function runScan(ctx, providerId, options = {}) {
  if (state.scanning) {
    return { ok: false, error: '已有扫描在进行中，请等它结束或先取消' }
  }
  if (!state.policy.enabledProviders.includes(providerId)) {
    return {
      ok: false,
      error: `provider "${providerId}" 未开启探测。探测会向端点发真实请求，需要显式开启。`,
      needsEnable: true,
    }
  }

  const { section, raw, reason } = readPiSection(ctx)
  const profile = readProvider(section, providerId)
  if (profile === undefined) return { ok: false, error: `没有 provider "${providerId}"` }

  state.scanning = true
  state.controller = new AbortController()
  try {
    const apiKey = await resolveApiKey(ctx, providerId, profile.apiKeyEnv)
    const scan = await scanProvider({
      provider: providerId,
      section,
      apiKey,
      policy: { ...state.policy, visionProbe: options.visionProbe ?? state.policy.visionProbe },
      signal: state.controller.signal,
      onProgress: (msg) => ctx.logger?.debug?.(`[model-probe] ${msg}`),
    })
    if (scan.ok !== true) return scan

    const ops = planOps(scan, { only: options.only, models: options.models })
    // describeOps 展开成字段级改动；opCount 用它的长度而非 ops.length ——
    // 写入是"整体替换 models 数组"，运行时的 op 数量恒为 0 或 1，对用户没有意义，
    // 用户关心的是"有几处字段要改"。
    const plan = describeOps(ops, scan)
    return {
      ok: true,
      scan: shapeScanForWire(scan),
      plan,
      opCount: plan.length,
      // 取证状态必须随结果一起带出：调用方要能区分"测过且一致"与"根本没测成"。
      verification: scan.verification,
      // 一个字段都没验到，说明这次扫描没有产生任何有效结论。这不是成功，
      // 上层必须如实报告，绝不能显示成"无需改动"。
      verifiedNothing: scan.verification.verifiedFields === 0,
      // 需要写回时由 apply 重新计算 ops，避免把可执行对象穿过网络边界。
      keyResolved: apiKey !== undefined,
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    state.scanning = false
    state.controller = undefined
  }
}

/**
 * 把扫描结果裁剪成适合过网络的形状。
 *
 * 只保留标量与原语数组：Service、AbortSignal 之类的活对象绝不能穿过 JSON 边界。
 */
function shapeScanForWire(scan) {
  return {
    provider: scan.provider,
    api: scan.api,
    baseURL: scan.baseURL,
    listingOk: scan.listingOk,
    listingReason: scan.listingReason,
    budget: scan.budget,
    models: scan.models.map((row) => ({
      model: row.model,
      index: row.index,
      summary: row.summary,
      notes: row.notes,
      findings: row.findings.map((f) => ({
        field: f.field,
        verdict: f.verdict,
        current: f.current,
        measured: f.measured,
        // 端点给出的硬上界与本次采用的冗余比例，供界面解释建议值从何而来。
        limit: f.limit,
        evidence: f.evidence,
        confidence: f.confidence,
        note: f.note,
      })),
    })),
  }
}

/**
 * 把扫描得出的修正写入配置。
 *
 * 刻意与扫描分开：扫描随时可跑，写入必须由人点确认。写入内部会重新计算 ops
 * （基于最新配置），以免使用过期的模型下标。
 */
async function runApply(ctx, providerId, options = {}) {
  const { section, raw, reason } = readPiSection(ctx)
  // 写入落在用户层，所以必须基于原始用户层来改写。拿不到就拒绝 —— 用解析值
  // 写回会把 schema 默认值（如空的 compat 壳）永久固化进用户的 settings.yaml。
  if (raw !== true) {
    return { ok: false, error: `已停用写入：${reason ?? '无法读取原始用户层'}` }
  }
  const profile = readProvider(section, providerId)
  if (profile === undefined) return { ok: false, error: `没有 provider "${providerId}"` }

  const apiKey = await resolveApiKey(ctx, providerId, profile.apiKeyEnv)
  const scan = await scanProvider({
    provider: providerId,
    section,
    apiKey,
    // 应用阶段不重复做视觉探针：结论已在上一次扫描得到，重跑只是白花钱。
    policy: { ...state.policy, visionProbe: false },
    onProgress: () => {},
  })
  if (scan.ok !== true) return scan

  const ops = planOps(scan, { only: options.only, models: options.models })
  if (ops.length === 0) {
    return { ok: true, applied: 0, message: '没有需要修正的字段' }
  }

  // 先算出字段级改动清单：写入在底层是"整体替换 models 数组"（恒为 1 个 op），
  // 但告诉用户"修正了 1 处"是误导 —— 用户关心的是改了几个字段。
  const changes = describeOps(ops, scan)
  if (changes.length === 0) {
    return { ok: true, applied: 0, message: '没有需要修正的字段' }
  }

  const result = await applyOps(ctx, ops)
  if (result.ok !== true) return result

  return {
    ok: true,
    applied: changes.length,
    backup: result.backup,
    changes,
  }
}

// ── 插件入口 ─────────────────────────────────────────────────────────────────

/**
 * 把组合配置归一化成策略对象。
 *
 * 兼容两种写法：`enabledProviders` 数组，或早期的单数简写 `probeProviders`。
 */
function normalizePolicy(config = {}) {
  const fromArray = Array.isArray(config.enabledProviders) ? [...config.enabledProviders] : undefined
  const fromShorthand = Array.isArray(config.probeProviders) ? [...config.probeProviders] : undefined
  return {
    enabledProviders: fromArray ?? fromShorthand ?? [],
    maxRequestsPerScan: Number.isFinite(config.maxRequestsPerScan)
      ? config.maxRequestsPerScan
      : DEFAULT_POLICY.maxRequestsPerScan,
    visionProbe: config.visionProbe !== false,
    // 数值比较容差：差距在此比例内不改配置，超过才覆盖。
    toleranceRatio: Number.isFinite(config.toleranceRatio)
      ? config.toleranceRatio
      : DEFAULT_POLICY.toleranceRatio,
  }
}

/**
 * 更新探测策略。
 *
 * 优先写进 settings 命名空间，使其持久化并能被用户直接编辑；只有设置服务
 * 不可用时才退回进程内状态。持久化很重要——否则每次重启都要重新开启探测，
 * 而这是个用户需要刻意授权的操作，反复丢失授权只会让人干脆一直开着它。
 */
async function setPolicy(ctx, patch) {
  if (state.persist === true) {
    try {
      await ctx.settings.update(POLICY_NS, patch)
      // onChange 钩子会把 state.policy 刷新为新的权威值，这里无需重复赋值。
      return { ok: true, persisted: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, error: `保存策略失败：${message}` }
    }
  }
  Object.assign(state.policy, patch)
  return { ok: true, persisted: false }
}

export function apply(ctx, config = {}) {
  const compositionPolicy = normalizePolicy(config)

  // 策略来源：优先是 settings 命名空间解析出的值，退回组合配置。
  // 先设为组合配置，保证在任何钩子触发前读到的都是有效值。
  let currentPolicy = () => compositionPolicy
  state.persist = false

  try {
    if (typeof ctx.settings?.installSection === 'function') {
      ctx.settings.installSection(ctx, POLICY_NS, PolicySchema, compositionPolicy, {
        setSource(current) {
          currentPolicy = current
        },
        onChange() {
          state.policy = currentPolicy()
        },
      })
      state.persist = true
    }
  } catch (error) {
    // 持久化失败不该让插件无法加载——探测功能本身仍然可用，只是开关重启后重置。
    const message = error instanceof Error ? error.message : String(error)
    console.log(`[dsh-model-probe] 策略持久化不可用（${message}），探测开关将只在本进程有效`)
  }

  state.policy = currentPolicy()

  registerTools(ctx)
  registerRoutes(ctx)

  // 用 console.log 而不是 ctx.logger：与生态内其它插件一致，且这两条信息对用户
  // 很重要——一条明确告知探测处于关闭状态，不会有人误以为插件在偷偷发请求；
  // 另一条说明开关能否持久化，避免重启后开关静默失效而无人察觉。
  const { enabled, stale } = enabledIntersection(readPiSection(ctx).section)
  console.log(
    `[dsh-model-probe] 已加载；工具 model_probe_status/scan/apply 已注册。` +
      `探测当前开启：${enabled.length > 0 ? enabled.join(', ') : '（无，需在设置页逐 provider 开启）'}` +
      `；策略持久化：${state.persist === true ? '已启用（写入 settings.yaml 的 model-probe 段）' : '不可用（开关仅本进程有效）'}`,
  )
  // 白名单里留着已删除的 provider 时明确说出来：否则用户只会在日志里看到探测
  // 开着，而设置页又不显示那一条，无从下手。
  if (stale.length > 0) {
    console.log(
      `[dsh-model-probe] 探测白名单里有 ${stale.length} 个 provider 已不在 llm-pi-ai 配置中：` +
        `${stale.join(', ')}（不是错误，已按不存在处理；下次在设置页改动任一开关时会自动清掉）`,
    )
  }
}

/** 注册模型可调用的诊断工具。 */
function registerTools(ctx) {
  const str = { type: 'string' }
  const num = { type: 'number' }
  const out = (schema) => ({ schema, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] })

  const statusSchema = out({
    type: 'object',
    additionalProperties: true,
    properties: { ok: { type: 'boolean' } },
  })

  ctx.tools.register(
    defineTool({
      name: 'model_probe_status',
      description:
        '列出 llm-pi-ai 里已配置的 provider 与模型，以及每个 provider 是否已开启实测探测。只读，不发任何请求。在决定是否扫描前先看它。',
      parameters: {},
      output: statusSchema,
      execute: async () => buildStatus(ctx),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'model_probe_scan',
      description:
        '对某个 provider 的模型做实测取证（只读，不改配置）：向端点发请求，测出每个模型的真实输出上限、推理档位集合与图像能力，并与当前 settings.yaml 里的声明逐字段比对，报告越界、不符与缺失。会发真实计费请求，因此该 provider 必须已在插件设置里开启探测。返回的 plan 是建议的修正清单。',
      parameters: {
        provider: { ...str, required: true, description: 'llm-pi-ai 里的 provider 名称，如 cc-goat' },
        models: {
          type: 'array',
          items: str,
          description: '只扫描这些模型 id（省略则扫描该 provider 的全部模型）',
        },
        visionProbe: { type: 'boolean', description: '是否做图像能力实证（唯一产生输出 token 的环节，默认按插件策略）' },
      },
      output: statusSchema,
      execute: async (args) => {
        const result = await runScan(ctx, args.provider, {
          models: args.models,
          visionProbe: args.visionProbe,
        })
        if (result.ok !== true) return result

        // 措辞必须区分三种情况：有差异 / 测过且一致 / 什么都没测到。
        // 把最后一种说成"未发现需要修正的字段"是误导 —— 它暗示配置是对的，
        // 而实际上这次扫描没有产生任何有效结论。
        let hint
        if (result.verifiedNothing === true) {
          const reason = result.scan.listingReason ?? '端点不可达'
          hint =
            `本次扫描【未能取证】：请求全部失败（${reason}），没有任何字段得到确认。` +
            '这不代表配置正确。请检查网络与端点可达性后重试。'
        } else if (result.opCount > 0) {
          hint = `发现 ${result.opCount} 处待修正。调用 model_probe_apply 并传 confirm=true 才会写入配置。`
        } else {
          hint = `已取证 ${result.verification.verifiedFields} 个字段，配置与实测一致，无需修正。`
        }

        return {
          ok: true,
          provider: result.scan.provider,
          budget: result.scan.budget,
          verification: result.verification,
          models: result.scan.models.map((m) => ({
            model: m.model,
            summary: m.summary,
            issues: m.findings.filter((f) => f.verdict !== 'ok' && f.verdict !== 'unknown'),
            notes: m.notes,
          })),
          plan: result.plan,
          hint,
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'model_probe_apply',
      description:
        '把实测结论写入 settings.yaml，修正越界或不符的模型配置（如某个模型的 maxTokens 超过端点合法上限导致请求全部失败）。会在写入前自动备份 settings.yaml，并带乐观锁——若配置在此期间被改动则放弃写入。必须先跑过 model_probe_scan，并显式传 confirm=true。',
      parameters: {
        provider: { ...str, required: true, description: '要修正的 provider 名称' },
        confirm: { type: 'boolean', required: true, description: '必须为 true 才执行写入；这是防止误改配置的最后一道闸' },
        models: { type: 'array', items: str, description: '只修正这些模型（省略则全部）' },
        only: {
          type: 'array',
          items: str,
          description: '只修正这些字段，可选 contextWindow / maxTokens / reasoningEfforts / input',
        },
      },
      output: statusSchema,
      execute: async (args) => {
        if (args.confirm !== true) {
          return { ok: false, error: '未确认：需要显式传 confirm=true 才会写入配置' }
        }
        return runApply(ctx, args.provider, { models: args.models, only: args.only })
      },
    }),
  )
}

/** 注册设置页使用的同源 HTTP 路由。 */
function registerRoutes(ctx) {
  const webServer = ctx.get?.('webServer')
  if (webServer === undefined) return

  const route = (pathname, handler) => {
    ctx.effect(
      () => webServer.register({ kind: 'exact', path: pathname, handler }),
      `model-probe: ${pathname}`,
    )
  }

  const guard = (handler) => async (req, res) => {
    if (!isTrustedRequest(req)) return send(res, 403, { ok: false, error: 'forbidden' })
    try {
      return await handler(req, res)
    } catch (error) {
      return send(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  route(
    `${HTTP_PREFIX}/status`,
    guard(async (_req, res) => send(res, 200, buildStatus(ctx))),
  )

  route(
    `${HTTP_PREFIX}/policy`,
    guard(async (req, res) => {
      if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method not allowed' })
      const body = await readJsonBody(req)

      // 只接受已知字段，并把数值夹到合法范围——避免界面被改坏或手写请求
      // 塞进一个天文数字导致意外的大量请求。
      const patch = {}
      if (Array.isArray(body.enabledProviders)) {
        const requested = body.enabledProviders
          .filter((x) => typeof x === 'string')
          .map((x) => x.trim())
          .filter((x) => x.length > 0)
        // 设置页提交的本来就是交集，所以这里的过滤主要是防手写请求把不存在的名字
        // 写进白名单（写进去只会变成"残留"，显示不出来也关不掉）。读不到任何
        // provider 时不过滤：那更可能是读取失败，而不是用户真的没有 provider，
        // 此时清空白名单是破坏性的。
        const known = new Set(listProviders(readPiSection(ctx).section))
        patch.enabledProviders = known.size === 0
          ? [...new Set(requested)]
          : [...new Set(requested.filter((id) => known.has(id)))]
      }
      if (typeof body.visionProbe === 'boolean') patch.visionProbe = body.visionProbe
      if (Number.isFinite(body.maxRequestsPerScan)) {
        patch.maxRequestsPerScan = Math.max(1, Math.min(500, Math.trunc(body.maxRequestsPerScan)))
      }
      if (Number.isFinite(body.toleranceRatio)) {
        patch.toleranceRatio = Math.max(0, Math.min(0.5, body.toleranceRatio))
      }

      const saved = await setPolicy(ctx, patch)
      if (saved.ok !== true) return send(res, 400, saved)
      return send(res, 200, buildStatus(ctx))
    }),
  )

  route(
    `${HTTP_PREFIX}/scan`,
    guard(async (req, res) => {
      if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method not allowed' })
      const body = await readJsonBody(req)
      const result = await runScan(ctx, String(body.provider ?? ''), {
        models: Array.isArray(body.models) ? body.models : undefined,
        visionProbe: typeof body.visionProbe === 'boolean' ? body.visionProbe : undefined,
      })
      return send(res, result.ok === true ? 200 : 400, result)
    }),
  )

  route(
    `${HTTP_PREFIX}/apply`,
    guard(async (req, res) => {
      if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method not allowed' })
      const body = await readJsonBody(req)
      // 与工具一致：必须显式确认，防止界面上的误点直接改配置。
      if (body.confirm !== true) {
        return send(res, 400, { ok: false, error: '需要显式确认才会写入配置' })
      }
      const result = await runApply(ctx, String(body.provider ?? ''), {
        models: Array.isArray(body.models) ? body.models : undefined,
        only: Array.isArray(body.only) ? body.only : undefined,
      })
      return send(res, result.ok === true ? 200 : 400, result)
    }),
  )

  route(
    `${HTTP_PREFIX}/cancel`,
    guard(async (req, res) => {
      if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method not allowed' })
      state.controller?.abort()
      return send(res, 200, { ok: true, cancelled: true })
    }),
  )
}

export { CONFIDENCE_ORDER, LLM_PI_AI_NS }
