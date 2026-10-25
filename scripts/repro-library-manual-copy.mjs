#!/usr/bin/env node
/**
 * 复现：手工拷贝视频到 downloads/<账号>/ 后，浏览页（/api/library）是否可见
 *
 * 场景矩阵（模拟「手工拷贝，含文件夹下的视频」）：
 *   A 一层 .mp4                     预期：可见
 *   B 子目录一层 .mp4               预期：可见（用户诉求「文件夹下的视频」）
 *   C 子目录两层 .mkv               预期：可见
 *   D 一层 .avi（白名单外）          预期：按当前设计不可见（白名单仅 mp4/webm/mkv/mov/m3u8）
 *
 * 隔离：VD_DATA_DIR / VD_DOWNLOADS_DIR 指向临时目录，PORT 随机，结束后清理。
 * 用法：node scripts/repro-library-manual-copy.mjs
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const WORK = join(tmpdir(), `vd-repro-lib-${Date.now()}`)
const DATA = join(WORK, 'data')
const DOWNLOADS = join(WORK, 'downloads')
const PORT = 13456 + Math.floor(Math.random() * 800)
const USER = 'wilsonwen'
const USER_DIR = join(DOWNLOADS, USER)

mkdirSync(DATA, { recursive: true })
mkdirSync(join(USER_DIR, '手工拷贝子目录', '更深一层'), { recursive: true })
writeFileSync(join(USER_DIR, '一层视频.mp4'), randomBytes(2048))
writeFileSync(join(USER_DIR, '手工拷贝子目录', '子目录视频.mp4'), randomBytes(2048))
writeFileSync(join(USER_DIR, '手工拷贝子目录', '更深一层', '三级视频.mkv'), randomBytes(2048))
writeFileSync(join(USER_DIR, '其他格式.avi'), randomBytes(2048))

const child = spawn(process.execPath, ['src/index.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), VD_DATA_DIR: DATA, VD_DOWNLOADS_DIR: DOWNLOADS },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let logs = ''
child.stdout.on('data', (d) => { logs += d })
child.stderr.on('data', (d) => { logs += d })

const base = `http://127.0.0.1:${PORT}`

async function waitReady() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${base}/api/health`)
      if (r.ok) return
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`服务未就绪（${PORT}）:\n${logs.slice(-2000)}`)
}

async function main() {
  await waitReady()
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER, password: 'Wenq5201314' }),
  }).then((r) => r.json())
  if (!login.token) throw new Error(`登录失败: ${JSON.stringify(login)}`)

  const files = await fetch(`${base}/api/library`, {
    headers: { authorization: `Bearer ${login.token}` },
  }).then((r) => r.json())
  if (!Array.isArray(files)) throw new Error(`/api/library 返回异常: ${JSON.stringify(files)}`)

  const names = files.map((f) => f.name)
  console.log('== 磁盘上的文件（downloads/<账号>/ 下）==')
  console.log('  A 一层视频.mp4')
  console.log('  B 手工拷贝子目录/子目录视频.mp4')
  console.log('  C 手工拷贝子目录/更深一层/三级视频.mkv')
  console.log('  D 其他格式.avi')
  console.log('== /api/library 实际返回 ==')
  console.log(JSON.stringify(names, null, 2))

  const findings = {
    'A 一层 .mp4 可见': names.includes('一层视频.mp4'),
    'B 子目录 .mp4 可见': names.some((n) => String(n).includes('子目录视频')),
    'C 子目录两层 .mkv 可见': names.some((n) => String(n).includes('三级视频')),
    'D 一层 .avi 可见': names.some((n) => String(n).includes('其他格式')),
  }
  console.log('== 判定 ==')
  for (const [k, v] of Object.entries(findings)) console.log(`  ${v ? '✅' : '❌'} ${k}`)
  const defectReproduced = !findings['B 子目录 .mp4 可见'] || !findings['C 子目录两层 .mkv 可见']
  console.log(`缺陷复现: ${defectReproduced ? '是（子目录视频不在列表中）' : '否'}`)
  // 供脚本化断言的机器可读行
  console.log(`REPRO_RESULT=${JSON.stringify({ findings, defectReproduced })}`)
}

try {
  await main()
} catch (err) {
  console.error('复现脚本失败:', err?.message || err)
  process.exitCode = 1
} finally {
  try { child.kill('SIGKILL') } catch { /* ignore */ }
  rmSync(WORK, { recursive: true, force: true })
}
