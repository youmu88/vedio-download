#!/usr/bin/env node
/**
 * smoke-frontend.mjs — 前端渲染冒烟（Playwright）
 *
 * 起真实服务 → 打开 iOS/macOS 两页 → 断言：
 *   1. 页面无 JS 解析错误（pageerror / console error）
 *   2. 页面正文不出现 `${...}` 字面量（模板占位符泄漏）
 *   3. iOS 页面脚本真正执行（window.loadLists 已定义）
 *
 * 浏览器不可用时自动 SKIP（退出码 0），避免 CI 因缺浏览器误报。
 */
import { spawn } from 'node:child_process'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const PORT = Number(process.env.SMOKE_PORT || 3199)

let server = null
let browser = null

async function waitReady(url, timeoutMs = 20000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url)
      if (r.ok) return true
    } catch { /* not ready */ }
    await new Promise(r => setTimeout(r, 300))
  }
  return false
}

try {
  const { chromium } = await import('playwright-core')
  server = spawn(process.execPath, [join(ROOT, 'src/index.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  })
  const ready = await waitReady(`http://127.0.0.1:${PORT}/api/health`)
  if (!ready) throw new Error(`服务未在 ${PORT} 端口就绪`)

  try {
    browser = await chromium.launch({
      headless: true,
      channel: 'chrome',
    })
  } catch {
    browser = await chromium.launch({
      headless: true,
      executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    })
  }

  const failures = []
  for (const pageName of ['ios.html', 'macos.html']) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
    const errors = []
    page.on('pageerror', e => errors.push(`pageerror: ${e.message}`))
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`console.error: ${m.text()}`) })
    await page.goto(`http://127.0.0.1:${PORT}/${pageName}`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(800)
    const bodyText = await page.evaluate(() => document.body.innerText)
    if (bodyText.includes('${')) failures.push(`${pageName}: 页面正文出现 ${'${'} 字面量`)
    if (errors.length > 0) failures.push(`${pageName}: ${errors.slice(0, 3).join(' | ')}`)
    if (pageName === 'ios.html') {
      const hasLoadLists = await page.evaluate(() => typeof window.loadLists === 'function')
      if (!hasLoadLists) failures.push('ios.html: 内联脚本未执行（window.loadLists 未定义）')
    }
    await page.close()
  }

  if (failures.length > 0) {
    console.error('❌ 前端冒烟未通过:')
    for (const f of failures) console.error('  - ' + f)
    process.exit(1)
  }
  console.log(`✅ 前端冒烟通过：ios.html / macos.html 渲染无 ${'${'} 泄漏、无 JS 错误`)
} catch (err) {
  const msg = String(err?.message || err)
  if (/browser|executable|chromium|playwright/i.test(msg) && !/服务未在/.test(msg)) {
    console.log(`SKIP 前端冒烟：浏览器不可用（${msg.slice(0, 120)}）`)
    process.exit(0)
  }
  console.error(`❌ 前端冒烟异常: ${msg}`)
  process.exit(1)
} finally {
  try { await browser?.close() } catch { /* ignore */ }
  if (server) server.kill('SIGTERM')
}
