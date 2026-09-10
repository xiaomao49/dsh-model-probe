/**
 * 备份策略测试。
 *
 * 两个行为值得锁住：
 *   1. 备份文件名是人类可读的本地时间戳，不能带小数点之类的噪音；
 *   2. 写入失败时不留下备份 —— 配置一字未改，留个备份只会误导用户。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyOps } from '../lib/store.js'

/** 在临时目录里造一个 settings.yaml，并让 store 指向它。 */
async function withTempHome(run) {
  const dir = await mkdtemp(join(tmpdir(), 'probe-store-'))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  await writeFile(join(dir, 'settings.yaml'), 'llm-pi-ai:\n  providers: {}\n', 'utf8')
  try {
    return await run(dir)
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
    await rm(dir, { recursive: true, force: true })
  }
}

function makeCtx({ fail } = {}) {
  return {
    settings: {
      describe: () => [{ ns: 'llm-pi-ai', revision: 1 }],
      mutate: async () => {
        if (fail !== undefined) throw new Error(fail)
      },
    },
  }
}

test('写入成功时留下备份，文件名是干净的本地时间戳', async () => {
  await withTempHome(async (dir) => {
    const result = await applyOps(makeCtx(), [
      { op: 'set', path: ['providers', 'p', 'models'], value: [] },
    ])
    assert.equal(result.ok, true)
    assert.ok(result.backup, '应返回备份路径')

    const files = await readdir(dir)
    const backups = files.filter((f) => f.startsWith('settings.yaml.bak-probe-'))
    assert.equal(backups.length, 1)

    // 形如 settings.yaml.bak-probe-20260911-015333
    const stamp = backups[0].replace('settings.yaml.bak-probe-', '')
    assert.match(stamp, /^\d{8}-\d{6}$/, `时间戳格式不对：${stamp}`)
    assert.doesNotMatch(stamp, /\./, '时间戳不应含小数点')
  })
})

test('写入失败时不留下备份（配置未改动，备份是噪音）', async () => {
  await withTempHome(async (dir) => {
    const result = await applyOps(makeCtx({ fail: 'schema: expected array but got [object Object]' }), [
      { op: 'set', path: ['providers', 'p', 'models'], value: [] },
    ])
    assert.equal(result.ok, false)
    assert.match(result.error, /expected array/)

    const files = await readdir(dir)
    const backups = files.filter((f) => f.startsWith('settings.yaml.bak-probe-'))
    assert.deepEqual(backups, [], `失败写入不应留下备份，实际留下：${backups.join(',')}`)
  })
})

test('乐观锁冲突给出可操作的提示，且同样不留备份', async () => {
  await withTempHome(async (dir) => {
    const result = await applyOps(makeCtx({ fail: 'settings conflict for "llm-pi-ai": revision 1 != 2' }), [
      { op: 'set', path: ['providers', 'p', 'models'], value: [] },
    ])
    assert.equal(result.ok, false)
    assert.match(result.error, /被改动/)
    assert.deepEqual((await readdir(dir)).filter((f) => f.includes('bak-probe')), [])
  })
})

test('空操作列表直接返回，既不备份也不写入', async () => {
  await withTempHome(async (dir) => {
    const result = await applyOps(makeCtx(), [])
    assert.equal(result.ok, true)
    assert.equal(result.count, 0)
    assert.deepEqual((await readdir(dir)).filter((f) => f.includes('bak-probe')), [])
  })
})
