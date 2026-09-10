/**
 * 宿主侧配置读写：读取路由定义、解析凭据、安全写入 settings。
 *
 * 安全纪律在这里落地（不是"尽量"，是硬约束）：
 *   - 凭据按次解析，绝不缓存、绝不写入日志、绝不出现在任何返回值里；
 *   - 每次写入前先备份 settings.yaml；
 *   - 写前重读 revision 做乐观锁，他人改动则拒绝；
 *   - settings.mutate 是路径寻址，不可能删掉调用者没看见的字段。
 */

import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { copyFile, readFile, unlink, writeFile } from 'node:fs/promises'

/** 本插件操作的目标命名空间。 */
export const LLM_PI_AI_NS = 'llm-pi-ai'

/** DSH 主目录，遵循 DSH_HOME 覆盖。 */
export function dshHome() {
  const configured = process.env.DSH_HOME?.trim()
  return configured !== undefined && configured.length > 0 ? configured : join(homedir(), '.dsh')
}

export function settingsPath() {
  return join(dshHome(), 'settings.yaml')
}

/**
 * 从 llm-pi-ai section 里取出一个 provider 的可用信息。
 * 只读，不做任何校验——校验由审计层负责。
 */
export function readProvider(section, provider) {
  const profile = section?.providers?.[provider]
  if (profile === null || typeof profile !== 'object') return undefined
  return {
    baseURL: typeof profile.baseURL === 'string' ? profile.baseURL : undefined,
    api: typeof profile.api === 'string' ? profile.api : 'openai-completions',
    apiKeyEnv: typeof profile.apiKeyEnv === 'string' ? profile.apiKeyEnv : undefined,
    displayName: typeof profile.displayName === 'string' ? profile.displayName : provider,
    headers: profile.headers !== null && typeof profile.headers === 'object' ? profile.headers : undefined,
    models: Array.isArray(profile.models) ? profile.models : [],
  }
}

/** 列出所有已配置的 provider 名称。 */
export function listProviders(section) {
  const providers = section?.providers
  if (providers === null || typeof providers !== 'object') return []
  return Object.keys(providers)
}

/**
 * 解析 provider 的凭据。
 *
 * 严格按次解析、不缓存。返回值只用于当次请求，调用方不得持久化或记录。
 * 环境变量优先（与 DSH 凭据链一致），其次读托管凭据库。
 *
 * @returns {Promise<string|undefined>} 凭据值；解析不到返回 undefined。
 */
export async function resolveApiKey(ctx, provider, apiKeyEnv) {
  if (typeof apiKeyEnv !== 'string' || apiKeyEnv.length === 0) return undefined

  // 凭据服务优先：它知道 DSH 的完整解析链（环境、托管库、项目 .env）。
  try {
    const credentials = ctx.get?.('credentials')
    if (credentials !== undefined && typeof credentials.resolve === 'function') {
      const hit = await credentials.resolve(apiKeyEnv)
      const value = hit?.value
      if (typeof value === 'string' && value.length > 0) return value
    }
  } catch {
    // 凭据服务不可用或解析失败时降级到环境变量，不中断流程。
  }

  const fromEnv = process.env[apiKeyEnv]
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv

  // 最后尝试托管凭据库文件。仅在凭据服务缺失时走到这里。
  try {
    const raw = await readFile(join(dshHome(), '.credentials.yaml'), 'utf8')
    const match = new RegExp(`^\\s*${escapeRegExp(apiKeyEnv)}\\s*:\\s*(.+)$`, 'm').exec(raw)
    if (match !== null) {
      const value = match[1].trim().replace(/^["']|["']$/g, '')
      if (value.length > 0) return value
    }
  } catch {
    /* 凭据文件不存在属于正常情况 */
  }

  return undefined
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 生成人类可读的本地时间戳，形如 `20260911-015333`。
 *
 * 用本地时间而非 UTC：用户看备份文件名时想对应自己刚才的操作时刻。
 * 早期版本用 `toISOString().replace(...).slice(0,15)`，结果末尾会带一个
 * 秒的小数点（`...175333.`），文件名很难看。
 */
function timestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

/**
 * 备份 settings.yaml，返回备份路径。
 *
 * 每次写入前必做。用户的配置是长期资产，一次错误的写入可能损失大量手工调整。
 */
export async function backupSettings() {
  const source = settingsPath()
  const target = `${source}.bak-probe-${timestamp()}`
  try {
    await copyFile(source, target)
    return target
  } catch {
    return undefined
  }
}

/**
 * 删除一个备份文件。
 *
 * 写入失败时调用：此时配置一字未改，备份只是无用噪音，留着会让用户以为
 * 发生过多次改动。
 */
async function discardBackup(path) {
  if (typeof path !== 'string' || path.length === 0) return
  try {
    await unlink(path)
  } catch {
    /* 删除失败无妨，只是个多余的备份文件 */
  }
}

/**
 * 读取当前命名空间的 revision，供乐观锁使用。
 *
 * @returns {number|undefined} 描述符里的 revision；命名空间未注册时 undefined。
 */
export function readRevision(ctx, ns = LLM_PI_AI_NS) {
  try {
    const rows = ctx.settings.describe({ redactSecrets: true })
    const row = rows.find((item) => String(item.ns) === ns)
    return row?.revision
  } catch {
    return undefined
  }
}

/**
 * 应用路径操作到 settings。
 *
 * 流程刻意保守：
 *   1. 读当前 section 与 revision；
 *   2. 备份；
 *   3. 带 revision 写入（若期间他人改动，写入会被拒绝而不是覆盖）。
 *
 * @param {object} ctx
 * @param {Array} ops - settings.mutate 的路径操作。
 * @returns {Promise<{ok: true, backup?: string, count: number}|{ok: false, error: string}>}
 */
export async function applyOps(ctx, ops) {
  if (!Array.isArray(ops) || ops.length === 0) {
    return { ok: true, count: 0 }
  }

  const backup = await backupSettings()
  const revision = readRevision(ctx)

  try {
    await ctx.settings.mutate(LLM_PI_AI_NS, ops, revision)
    return { ok: true, backup, count: ops.length }
  } catch (error) {
    // 写入被拒时配置一字未改，备份是多余噪音 —— 删掉，免得用户以为改动发生过。
    // 真实的 settings 写入是"先校验再落盘"的原子操作，不存在半成功状态。
    await discardBackup(backup)
    const message = error instanceof Error ? error.message : String(error)
    // 乐观锁冲突是可预期的正常情形（用户同时在编辑），给出可操作的提示。
    const conflict = /conflict|revision/i.test(message)
    return {
      ok: false,
      error: conflict
        ? '配置在你扫描期间被改动，已放弃写入以免覆盖。请重新扫描后再试。'
        : message,
    }
  }
}

/**
 * 读取 llm-pi-ai 的**原始用户层** section。
 *
 * 这里有一个必须绕开的陷阱：`ctx.settings.get()` 返回的是**解析后的值** ——
 * schemastery 会把 schema 的默认值 materialize 进去。例如模型条目的 `compat`
 * 是 `z.object(...)`，解析后必然出现 `compat: {chatTemplateKwargs: {}, chatTemplateArgs: {}}`
 * 这样的空壳。若把这个值写回去（写入落在用户层），就会把一堆 schema 默认值
 * 永久固化进用户的 settings.yaml —— 配置被污染，还会在 diff 里制造噪音。
 *
 * 所以读取必须走 `describe()` 的 `user` 字段，它按文档是
 * "Raw user section from the stored document"。
 *
 * @returns {{section: object, raw: boolean, reason?: string}}
 *   `raw === false` 表示拿不到原始层，此时写入是不安全的（会固化默认值），
 *   调用方应当拒绝写入而不是冒险。
 */
export function readPiSection(ctx) {
  try {
    const rows = ctx.settings.describe()
    const row = rows.find((item) => String(item.ns) === LLM_PI_AI_NS)
    if (row !== undefined && row.user !== null && typeof row.user === 'object' && !Array.isArray(row.user)) {
      return { section: row.user, raw: true }
    }
    // 用户层不存在（配置完全来自组合层）时无从写入 —— 如实报告。
    if (row !== undefined) {
      return {
        section: { providers: {} },
        raw: false,
        reason: '配置不来自用户设置层（settings.yaml），插件只改写用户层，因此不写入',
      }
    }
  } catch {
    /* describe 不可用，落到下方回退 */
  }

  // 回退：解析值仅供**读取展示**，形状兼容但含 schema 默认值。
  // 标记 raw=false，让写路径拒绝执行。
  try {
    const value = ctx.settings.get(LLM_PI_AI_NS)
    if (value !== null && typeof value === 'object') {
      return {
        section: value,
        raw: false,
        reason: '无法读取原始用户层（settings.describe 不可用），为避免把 schema 默认值写进配置，已停用写入',
      }
    }
  } catch {
    /* 命名空间未注册 */
  }
  return { section: { providers: {} }, raw: false, reason: 'llm-pi-ai 命名空间未注册' }
}

export { readFile, writeFile, dirname }
