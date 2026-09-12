/**
 * 扫描编排：把探测结果组装成"实测事实"，交给审计层比对。
 *
 * 这一层负责把三件事缝在一起：探测（发请求）→ 事实（带证据与置信度）→
 * 审计（与当前配置比对）。它是唯一同时了解三者形状的地方。
 *
 * 关键决策：**探测默认关闭**。扫描一个 provider 会向它的端点发真实请求，
 * 属于会花钱、会留痕的操作，必须由人显式开启。开启状态持久化在插件自己的
 * settings 命名空间里，而不是藏进 llm-pi-ai。
 */

import { Budget, listModels, elicitMaxTokens, elicitEfforts, probeVision } from './probe.js'
import { auditModel, buildProviderOps, readModelEntry, summarize, DEFAULT_TOLERANCE_RATIO } from './audit.js'
import { readProvider, resolveApiKey } from './store.js'

/** 默认探测策略：全部关闭，逐 provider 开启。 */
export const DEFAULT_POLICY = {
  /** 允许对这些 provider 发探测请求；未列出的一律不探测。 */
  enabledProviders: [],
  /** 每次扫描的请求数上限，防止误开导致大量请求。 */
  maxRequestsPerScan: 60,
  /** 是否做视觉探针（唯一产生输出 token 的环节）。 */
  visionProbe: true,
  /**
   * 数值比较容差：当前值已有值且与实测差距在此比例以内时不改动，超过才覆盖。
   *
   * 这不是"写入留余量"，而是"别为微小差异改配置"。它只影响要不要改，
   * 不影响越界判定——越过端点硬约束的值照修不误。
   */
  toleranceRatio: DEFAULT_TOLERANCE_RATIO,
}

/** 事实构造器：统一形状，避免各处手写对象时漏字段。 */
const fact = (value, confidence, evidence, extra = {}) => ({ value, confidence, evidence, ...extra })

/**
 * 扫描单个 provider。
 *
 * @param {object} input
 * @param {string} input.provider
 * @param {object} input.section - 当前 llm-pi-ai section。
 * @param {string|undefined} input.apiKey - 已解析的凭据（仅本次调用有效）。
 * @param {object} input.policy
 * @param {AbortSignal} [input.signal]
 * @param {(msg: string) => void} [input.onProgress]
 * @returns {Promise<{ok: boolean, error?: string, models?: Array, budget?: object}>}
 */
export async function scanProvider({ provider, section, apiKey, policy, signal, onProgress }) {
  const profile = readProvider(section, provider)
  if (profile === undefined) {
    return { ok: false, error: `llm-pi-ai 里没有 provider "${provider}"` }
  }
  if (typeof profile.baseURL !== 'string' || profile.baseURL.length === 0) {
    return { ok: false, error: `provider "${provider}" 没有 baseURL，无法探测` }
  }

  const budget = new Budget(policy.maxRequestsPerScan ?? DEFAULT_POLICY.maxRequestsPerScan)
  const report = (msg) => onProgress?.(msg)

  // provider 级自定义头（profile.headers）必须一路带到每个探测请求：
  // 有的网关除 API key 外还强制要求别的头，缺它时三个取证层次会全部返回错误，
  // 所有字段只能报 unknown —— 看起来像"这个端点测不出来"，实际只是少了一个头。
  // DSH 的 llm-pi-ai 本身就会照发这些头，探测侧不照发就是与真实运行不一致。

  // ① 端点自述：一次 GET，拿到所有模型的 contextWindow 与部分模态。
  report('读取端点模型列表…')
  const listing = await listModels({
    baseURL: profile.baseURL,
    api: profile.api,
    apiKey,
    headers: profile.headers,
    signal,
    budget,
  })
  const listingById = new Map()
  if (listing.ok) {
    for (const m of listing.models) listingById.set(m.id, m)
    report(`端点自述 ${listing.models.length} 个模型`)
  } else {
    // 列表失败不是致命错误：后续逐模型取证仍可能成功。
    report(`端点列表不可用（${listing.reason}），继续逐模型取证`)
  }

  const results = []
  for (const entry of profile.models) {
    const modelId = entry?.id
    if (typeof modelId !== 'string' || modelId.length === 0) continue

    const measured = {}
    const notes = []

    // ── contextWindow：来自端点自述 ──────────────────────────────────
    const listed = listingById.get(modelId)
    if (listed?.contextWindow !== undefined) {
      measured.contextWindow = fact(listed.contextWindow, 'high', '端点自述 /models')
    }
    if (listed?.input !== undefined) {
      measured.input = fact(listed.input, 'medium', '端点自述 /models（可能不完整）')
    }

    if (signal?.aborted === true) break
    if (!budget.canContinue()) {
      notes.push('已达请求预算上限，部分探测被跳过')
      break
    }

    // ── maxTokens：约束取证 ─────────────────────────────────────────
    report(`${modelId}: 取证输出上限…`)
    const mt = await elicitMaxTokens({
      baseURL: profile.baseURL,
      api: profile.api,
      apiKey,
      headers: profile.headers,
      model: modelId,
      signal,
      budget,
    })
    if (mt.ok) {
      // 实测值就是端点给出的硬上界本身，不打折。是否要改配置由审计层按容差
      // 判断：已有值差距在容差内就保持不动，超出才写这个值。
      measured.maxTokens = fact(mt.max, 'high', '端点约束取证（非法值探测）', {
        constraintMin: mt.min,
        constraintMax: mt.max,
      })
    } else {
      notes.push(`输出上限未知：${mt.reason}`)
    }

    if (!budget.canContinue()) break

    // ── reasoningEfforts：约束取证 ──────────────────────────────────
    report(`${modelId}: 取证推理档位…`)
    const re = await elicitEfforts({
      baseURL: profile.baseURL,
      api: profile.api,
      apiKey,
      headers: profile.headers,
      model: modelId,
      signal,
      budget,
    })
    if (re.ok) {
      if (re.levels.length > 0) {
        measured.reasoningEfforts = fact(re.levels, 'high', '端点约束取证（非法值探测）', {
          offAccepted: re.offAccepted,
        })
        if (!re.offAccepted) {
          notes.push('端点拒绝 off：该模型无法关闭思考，界面上不应提供关闭选项')
        } else if (re.offWire !== undefined) {
          // 端点用别的线上取值表示"关闭"时把话说明白：只说"支持 off"会让用户按
          // 字面写 off，而那样发出去的请求正是被端点拒绝的那一个。
          notes.push(`该端点的"关闭思考"线上取值是 "${re.offWire}"：声明 reasoningEfforts 时要写成 off: ${re.offWire}`)
        }
      } else if (re.offAccepted) {
        notes.push('端点接受 off 但未披露档位集合，推理档位保持未知')
      }
    } else {
      notes.push(`推理档位未知：${re.reason}`)
    }

    // ── input 图像能力：视觉实证 ────────────────────────────────────
    // 仅在没有端点自述、或自述未含图片信息时才做（省一次计费请求）。
    const needVision = measured.input === undefined || !measured.input.value.includes('image')
    if (policy.visionProbe === true && needVision && budget.canContinue() && signal?.aborted !== true) {
      report(`${modelId}: 视觉能力实证…`)
      const vis = await probeVision({
        baseURL: profile.baseURL,
        api: profile.api,
        apiKey,
        headers: profile.headers,
        model: modelId,
        signal,
        budget,
      })
      if (vis.ok) {
        // 实证优先级高于端点自述：自述可能过时或缺失。
        measured.input = fact(
          vis.supportsImage ? ['text', 'image'] : ['text'],
          'high',
          '图形计数实证',
        )
      } else {
        notes.push(`图像能力未确认：${vis.reason}`)
      }
    }

    // ── 审计比对 ─────────────────────────────────────────────────────
    const { entry: currentEntry, index } = readModelEntry(section, provider, modelId)
    const findings = auditModel({
      current: currentEntry,
      measured,
      tolerance: policy.toleranceRatio ?? DEFAULT_TOLERANCE_RATIO,
    })

    results.push({
      model: modelId,
      index,
      findings,
      summary: summarize(findings),
      notes,
      // 端点接受了超范围值等情形会影响建议的可信度，如实带出。
      listing: listed ?? undefined,
    })
  }

  // 本次扫描究竟验到了多少东西。这个汇总决定了上层能说"配置正确"，还是只能
  // 说"没测出来" —— 两者的区别至关重要，混为一谈会把一次彻底失败的扫描显示成
  // 绿色的"无需改动"（这正是实际发生过的 bug）。
  const verifiedFields = results.reduce((n, r) => n + r.summary.verified, 0)
  const unknownFields = results.reduce((n, r) => n + r.summary.unknown, 0)
  const anyRequestSucceeded = listing.ok === true || verifiedFields > 0

  return {
    ok: true,
    provider,
    api: profile.api,
    baseURL: profile.baseURL,
    models: results,
    budget: { requests: budget.requests, outputTokens: budget.outputTokens, exhausted: budget.exhausted },
    listingOk: listing.ok,
    listingReason: listing.ok ? undefined : listing.reason,
    verification: {
      verifiedFields,
      unknownFields,
      anyRequestSucceeded,
      // 连端点列表都没读到、且没有任何字段取证成功 → 基本可断定是连通性问题，
      // 而不是"配置恰好正确"。
      transportFailure: anyRequestSucceeded === false,
    },
    // 当前 models 数组的原始值。写入必须整体替换这个数组（路径操作无法穿过
    // 数组），预览也需要它来计算"改前 → 改后"。
    rawModels: profile.models.map((m) => JSON.parse(JSON.stringify(m))),
  }
}

/**
 * 从扫描结果生成待写入操作（预览用，不落盘）。
 *
 * 只包含可操作的字段；unknown 与 ok 不产生任何操作。
 *
 * 注意产生的是"整体写 models 数组"的操作，而不是逐个字段的路径写入 ——
 * settings 的路径操作无法穿过数组。详见 buildProviderOps 的说明。
 */
export function planOps(scan, { only, models } = {}) {
  if (scan?.ok !== true) return []
  const perModel = scan.models
    .filter((row) => row.index >= 0)
    .filter((row) => !Array.isArray(models) || models.includes(row.model))
    .map((row) => ({ index: row.index, findings: row.findings, model: row.model }))

  if (perModel.length === 0) return []

  return buildProviderOps({
    provider: scan.provider,
    models: scan.rawModels,
    perModel,
    only,
  })
}

/**
 * 把操作转成人类可读的差异预览行，供界面与工具输出使用。
 *
 * 因为写入是整体替换 models 数组，这里必须展开成"每个模型、每个字段改了什么"，
 * 否则界面上只会看到一行 `set providers.x.models = [object]`，用户无从判断。
 */
export function describeOps(ops, scan) {
  const rows = []
  for (const op of ops) {
    const provider = op.path[1]
    const nextModels = Array.isArray(op.value) ? op.value : []
    const before = Array.isArray(scan?.rawModels) ? scan.rawModels : []
    const findingsByIndex = new Map((scan?.models ?? []).map((m) => [m.index, m]))

    nextModels.forEach((entry, index) => {
      const prev = before[index]
      if (prev === undefined) return
      // 只报告真正变化的字段，避免把整个条目铺满界面。
      for (const key of Object.keys(entry)) {
        const a = JSON.stringify(prev[key])
        const b = JSON.stringify(entry[key])
        if (a === b) continue
        const finding = findingsByIndex.get(index)?.findings?.find((f) => f.field === key)
        rows.push({
          kind: 'set',
          provider,
          modelIndex: index,
          model: entry.id,
          field: key,
          from: prev[key],
          value: entry[key],
          verdict: finding?.verdict,
          evidence: finding?.evidence,
          path: `providers.${provider}.models[${index}].${key}`,
        })
      }
    })
  }
  return rows
}
