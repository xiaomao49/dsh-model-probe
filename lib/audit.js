/**
 * 审计：把"实测事实"与"当前配置"逐字段比对，产出可解释的差异清单。
 *
 * 这是本插件与所有"配置填充器"的根本区别。填充器只关心"缺什么就补什么"，
 * 而这里要先回答一个更重要的问题：**现在写的东西是不是错的？**
 *
 * 你遇到的 GLM maxTokens=384000 就是这么一类问题——它不缺值，它有一个
 * 越界的值，每次请求都会 400。填充器永远不会告诉你这件事，因为它看到字段
 * "有值"就跳过了。审计器会判成 out-of-range 并说明依据。
 *
 * 全文件是纯函数：不读文件、不发请求、不碰 settings。所有副作用都在调用方，
 * 这样判定逻辑才能被完整单测覆盖。
 */

/** 置信度：high = 端点亲口所述或实证；medium = 端点披露但可能过时；low = 推断。 */
export const CONFIDENCE_ORDER = { low: 0, medium: 1, high: 2 }

/**
 * 数值字段的比较容差。
 *
 * 含义：当前值已有值、且与实测值的相对差距在此比例以内时，视为可接受，不做
 * 改动；只有差距超过它才覆盖。存在的意义是避免无谓的配置扰动——同样的能力
 * 常因单位约定（1M vs 1MiB）或厂商微调产生微小差异，为这种差异改写用户配置
 * 只会制造噪音。
 *
 * 重要：容差只影响"要不要改"，绝不影响"什么算越界"。超出端点硬约束的值无论
 * 差距多小都必须修，因为那会让请求被直接拒绝（400）。
 */
export const DEFAULT_TOLERANCE_RATIO = 0.05

/**
 * 判断两个数值的相对差距是否落在容差内。
 *
 * @param {unknown} current - 当前配置值。
 * @param {unknown} measured - 实测值。
 * @param {number} ratio - 容差比例，默认 5%。
 * @returns {boolean} true 表示差距可接受，应保持不动。
 */
export function withinTolerance(current, measured, ratio = DEFAULT_TOLERANCE_RATIO) {
  if (typeof current !== 'number' || typeof measured !== 'number') return false
  if (!Number.isFinite(current) || !Number.isFinite(measured)) return false
  if (measured === 0) return current === 0
  const gap = Math.abs(current - measured) / Math.abs(measured)
  // 恰好落在边界上视为可接受（"差距在 5% 以内就不管"）。加一个极小量抵消
  // 浮点表示误差，避免算出来正好 0.05 却被判成超出。
  return gap <= ratio + Number.EPSILON
}

/** 审计判定。out-of-range 是唯一"当前配置必然导致请求失败"的等级。 */
export const VERDICT = {
  OUT_OF_RANGE: 'out-of-range', // 当前值越过实测约束 —— 危险，必须修
  MISMATCH: 'mismatch', // 与实测不符，但不会立刻失败
  MISSING: 'missing', // 实测有值，配置缺失
  OK: 'ok', // 一致
  UNKNOWN: 'unknown', // 没有实测证据，不动
}

/**
 * 从 llm-pi-ai section 里取某个模型的配置条目。
 * @returns {{entry: object|undefined, index: number}} index 为 -1 表示不存在。
 */
export function readModelEntry(section, provider, modelId) {
  const models = section?.providers?.[provider]?.models
  if (!Array.isArray(models)) return { entry: undefined, index: -1 }
  const index = models.findIndex((m) => m !== null && typeof m === 'object' && m.id === modelId)
  return { entry: index >= 0 ? models[index] : undefined, index }
}

/**
 * 把 reasoningEfforts 声明归一化成"可选档位列表"，便于比较。
 * DSH 语义：键为档位，值为线上传值；off 无值 = 支持但不发送该参数。
 */
export function declaredLevels(entry) {
  const efforts = entry?.reasoningEfforts
  if (efforts === false) return []
  if (efforts === null || typeof efforts !== 'object' || Array.isArray(efforts)) return undefined
  return Object.keys(efforts)
}

/**
 * 审计单个模型的全部字段。
 *
 * @param {object} input
 * @param {object|undefined} input.current - 当前配置条目。
 * @param {object} input.measured - 实测事实，形如：
 *   { contextWindow: {value, confidence, evidence}, maxTokens: {...}, ... }
 * @returns {Array<{field, verdict, current, measured, evidence, note}>}
 */
export function auditModel({ current, measured, tolerance = DEFAULT_TOLERANCE_RATIO }) {
  const findings = []
  const push = (field, verdict, extra = {}) => {
    const fact = measured?.[field]
    findings.push({
      field,
      verdict,
      current: current?.[field],
      measured: fact?.value,
      evidence: fact?.evidence,
      confidence: fact?.confidence,
      ...extra,
    })
  }

  // ── contextWindow ────────────────────────────────────────────────────
  // 同样适用容差：1M 与 1MiB 这类单位差异不该引发改写。
  const ctx = measured?.contextWindow
  if (ctx !== undefined && ctx.value !== undefined) {
    const cur = current?.contextWindow
    if (cur === undefined) push('contextWindow', VERDICT.MISSING)
    else if (withinTolerance(cur, ctx.value, tolerance)) push('contextWindow', VERDICT.OK)
    else push('contextWindow', VERDICT.MISMATCH)
  } else {
    push('contextWindow', VERDICT.UNKNOWN)
  }

  // ── maxTokens ────────────────────────────────────────────────────────
  // 这是唯一能做"越界"判定的字段，因为端点会告诉我们合法区间上界。
  //
  // 判定优先级（顺序不可调换）：
  //   1. 越过端点硬约束 → 越界。这与容差无关：值再接近边界，只要越界，
  //      请求就会被 400 拒绝，必须修。
  //   2. 已有值且与实测差距在容差内 → 可接受，不动，避免无谓扰动。
  //   3. 其余 → 不符，改写为实测值。
  const mt = measured?.maxTokens
  if (mt !== undefined && mt.value !== undefined) {
    const cur = current?.maxTokens
    if (cur === undefined) {
      push('maxTokens', VERDICT.MISSING)
    } else if (typeof cur !== 'number' || !Number.isFinite(cur)) {
      push('maxTokens', VERDICT.OUT_OF_RANGE, { note: '当前值不是有效数字' })
    } else if (mt.constraintMax !== undefined && cur > mt.constraintMax) {
      // 第一优先级：请求会带上这个值并被端点拒绝，与差距大小无关。
      push('maxTokens', VERDICT.OUT_OF_RANGE, {
        note: `当前值 ${cur} 超过端点合法上界 ${mt.constraintMax}，请求会被拒绝`,
        limit: mt.constraintMax,
      })
    } else if (mt.constraintMin !== undefined && cur < mt.constraintMin) {
      push('maxTokens', VERDICT.OUT_OF_RANGE, {
        note: `当前值 ${cur} 低于端点合法下界 ${mt.constraintMin}`,
        limit: mt.constraintMin,
      })
    } else if (withinTolerance(cur, mt.value, tolerance)) {
      push('maxTokens', VERDICT.OK, { gapRatio: relativeGap(cur, mt.value) })
    } else {
      push('maxTokens', VERDICT.MISMATCH, {
        note: `当前值 ${cur} 与实测 ${mt.value} 相差 ${formatGap(cur, mt.value)}，超出 ${
          Math.round(tolerance * 100)
        }% 容差`,
        gapRatio: relativeGap(cur, mt.value),
      })
    }
  } else {
    push('maxTokens', VERDICT.UNKNOWN)
  }

  // ── reasoningEfforts ─────────────────────────────────────────────────
  const re = measured?.reasoningEfforts
  if (re !== undefined && Array.isArray(re.value)) {
    const cur = declaredLevels(current)
    if (cur === undefined) {
      push('reasoningEfforts', VERDICT.MISSING)
    } else {
      const missing = re.value.filter((l) => !cur.includes(l))
      const extra = cur.filter((l) => !re.value.includes(l))
      if (missing.length > 0 || extra.length > 0) {
        push('reasoningEfforts', VERDICT.MISMATCH, {
          note:
            (missing.length > 0 ? `缺少端点支持的档位 ${missing.join('/')}；` : '') +
            (extra.length > 0 ? `声明了端点未列出的档位 ${extra.join('/')}（选中可能导致请求失败）` : ''),
          missing,
          extra,
        })
      } else {
        push('reasoningEfforts', VERDICT.OK)
      }
    }
  } else {
    push('reasoningEfforts', VERDICT.UNKNOWN)
  }

  // ── input 模态 ───────────────────────────────────────────────────────
  const input = measured?.input
  if (input !== undefined && Array.isArray(input.value)) {
    const cur = Array.isArray(current?.input) ? current.input : undefined
    if (cur === undefined) {
      push('input', VERDICT.MISSING)
    } else {
      const same = cur.length === input.value.length && input.value.every((m) => cur.includes(m))
      push('input', same ? VERDICT.OK : VERDICT.MISMATCH)
    }
  } else {
    push('input', VERDICT.UNKNOWN)
  }

  return findings
}

/**
 * 判断两个 JSON 值是否等价（对象键顺序无关）。
 *
 * 为什么需要：写入是"整体替换 models 数组"，只要有一个字段被标记为待处理，
 * 整个数组就会被重写。若算出来的值与现值相同，这次重写（连同写入前的备份）
 * 就是纯粹的无用功 —— 用户会看到一个莫名其妙的备份文件，却没有任何变化。
 */
export function jsonEqual(a, b) {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
}

/** 递归排序对象键，让序列化结果与键顺序无关。 */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key])
    return out
  }
  return value
}

/**
 * 把单个模型的审计结论折算成"该模型条目的新版本"。
 *
 * 只处理两种安全情形：
 *   - MISSING：实测有值而配置缺失 → 补上；
 *   - OUT_OF_RANGE / MISMATCH：当前值有据可依地不正确 → 改成实测值。
 *
 * UNKNOWN 一律不动：没有证据就不改别人的配置。这是本插件最硬的纪律。
 *
 * 返回新对象而不是就地修改：settings 里的值是深度冻结的，而且调用方需要
 * 用它构造完整的数组写入。
 *
 * `changed` 只在值**确实发生变化**时为 true —— 见 jsonEqual 的说明。
 *
 * @param {object} entry - 当前模型条目。
 * @param {Array} findings - auditModel 的输出。
 * @param {object} [opts]
 * @param {string[]} [opts.only] - 限定只处理这些字段。
 * @returns {{entry: object, changed: boolean, fields: string[]}}
 */
export function applyFindings(entry, findings, { only } = {}) {
  const next = { ...(entry ?? {}) }
  const fields = []

  for (const f of findings) {
    if (only !== undefined && !only.includes(f.field)) continue
    if (f.verdict === VERDICT.UNKNOWN || f.verdict === VERDICT.OK) continue
    if (f.measured === undefined) continue

    let value
    if (f.field === 'reasoningEfforts') {
      // 按端点给出的档位重建声明。
      const levels = Array.isArray(f.measured) ? f.measured : []
      const efforts = {}
      for (const level of levels) {
        if (level === 'off') continue
        efforts[level] = level
      }
      // 端点若明确接受 off，声明为无值 = "支持该档位，选中时不发送参数"。
      // 若端点拒绝 off（例如强制思考的模型），则不声明 off —— 免得界面上出现
      // 一个选了也没用的选项。
      if (levels.includes('off')) efforts.off = null
      value = efforts
    } else {
      value = f.measured
    }

    // 值没变就不算改动：避免整数组重写与随之而来的无用备份。
    if (jsonEqual(next[f.field], value)) continue
    next[f.field] = value
    fields.push(f.field)
  }

  return { entry: next, changed: fields.length > 0, fields }
}

/**
 * 为整个 provider 生成写入操作。
 *
 * **为什么必须整体写数组**：settings 的路径操作只在普通对象上遍历，遇到数组
 * 会把它当成"不存在的子对象"并用 `{...}` 重建 —— 也就是 `models.0.maxTokens`
 * 这样的路径会把整个 models 数组替换成 `{ '0': {...} }`，随后 schema 校验报
 * "expected array but got [object Object]"，写入整体失败。
 *
 * 所以正确做法是：把要改的模型条目在内存里改好，然后一次性写回整个 models
 * 数组。参考实现（dsh-model-info-fill）也是这么做的。
 *
 * 这个设计还有一个附带好处：写回的是完整数组，未涉及的模型条目原样保留，
 * 不会被"部分更新"弄丢字段。
 *
 * @param {object} input
 * @param {string} input.provider
 * @param {Array} input.models - 当前 models 数组（来自 settings 的实际值）。
 * @param {Array<{index: number, findings: Array}>} input.perModel - 每个模型的审计结论。
 * @param {string[]} [input.only]
 * @returns {Array<{op: 'set', path: string[], value: unknown}>} 至多一个操作。
 */
export function buildProviderOps({ provider, models, perModel, only }) {
  if (!Array.isArray(models) || models.length === 0) return []

  let changed = false
  const nextModels = models.map((entry, index) => {
    const hit = perModel.find((m) => m.index === index)
    if (hit === undefined) {
      // 未参与本次审计的模型原样保留（深拷贝，避免把冻结引用写回去）。
      return cloneJson(entry)
    }
    const result = applyFindings(entry, hit.findings, { only })
    if (result.changed) changed = true
    return cloneJson(result.entry)
  })

  if (!changed) return []

  return [{ op: 'set', path: ['providers', provider, 'models'], value: nextModels }]
}

/** 深拷贝为纯 JSON 结构，确保写回的值不携带冻结引用或原型链。 */
function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

/** 相对差距，供界面显示"差了多少"。零值安全。 */
export function relativeGap(current, measured) {
  if (typeof current !== 'number' || typeof measured !== 'number') return undefined
  if (!Number.isFinite(current) || !Number.isFinite(measured) || measured === 0) return undefined
  return Math.abs(current - measured) / Math.abs(measured)
}

/** 把差距格式化成百分比文本，例如 "2.3%"。 */
export function formatGap(current, measured) {
  const gap = relativeGap(current, measured)
  return gap === undefined ? '未知比例' : `${(gap * 100).toFixed(1)}%`
}

/** 统计结论，供界面显示概览。 */
export function summarize(findings) {
  const counts = {}
  for (const f of findings) counts[f.verdict] = (counts[f.verdict] ?? 0) + 1
  return {
    counts,
    dangerous: findings.filter((f) => f.verdict === VERDICT.OUT_OF_RANGE).length,
    actionable: findings.filter(
      (f) => f.verdict === VERDICT.MISSING || f.verdict === VERDICT.MISMATCH || f.verdict === VERDICT.OUT_OF_RANGE,
    ).length,
  }
}
