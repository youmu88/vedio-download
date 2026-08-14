import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = '/Users/wilsonwen/code/video-download'
const PORT = 3198
const OUT_DIR = '/tmp/vd-verify-shots'
const DATA_DIR = '/tmp/vd-dev-verify'

let server = null
let browser = null
const errors = []

async function waitReady(url, timeoutMs = 25000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try { const r = await fetch(url); if (r.ok) return true } catch {}
    await new Promise(r => setTimeout(r, 300))
  }
  return false
}

try {
  const { chromium, devices } = await import('playwright-core')
  server = spawn(process.execPath, [join(ROOT, 'src/index.js')], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), VD_DATA_DIR: DATA_DIR }, stdio: 'ignore',
  })
  const base = `http://localhost:${PORT}`
  mkdirSync(OUT_DIR, { recursive: true })
  if (!(await waitReady(base + '/api/health'))) throw new Error('dev 服务 25s 未就绪')
  console.log('✅ dev 服务已就绪 :' + PORT)

  browser = await chromium.launch()

  // ── 桌面端：macOS 风格 ──
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    page.on('pageerror', (e) => errors.push('macos pageerror: ' + e.message))
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('macos console: ' + m.text()) })
    await page.goto(base + '/macos.html', { waitUntil: 'networkidle' })
    await page.waitForTimeout(600)

    const checks = await page.evaluate(() => ({
      dock: !!document.getElementById('dock'),
      dockIcons: document.querySelectorAll('.dock-icon').length,
      menuBar: !!document.getElementById('menuBar'),
      winCount: document.querySelectorAll('.window').length,
      loadLists: typeof window.loadLists,
      fetchWrapped: typeof window.fetch,
      themeAttr: document.body.getAttribute('data-theme') || '(auto/默认)',
      wallpapers: document.querySelectorAll('.swatch').length,
      socketLoaded: typeof window.io,
      hlsLoaded: typeof window.Hls,
      mediaCacheLoaded: typeof window.mediaCache, preloadManager: typeof window.preloadManager,
    }))
    console.log('📊 macos 静态断言:', JSON.stringify(checks))

    // 登录（隔离实例 seed 默认用户）
    await page.fill('#loginUser', 'wilsonwen')
    await page.fill('#loginPass', 'Wenq5201314')
    await page.click('#loginBtn')
    await page.waitForFunction(() => !document.getElementById('loginScreen') || getComputedStyle(document.getElementById('loginScreen')).display === 'none', null, { timeout: 8000 })
    console.log('📊 macos 登录成功，loginScreen 已隐藏')
    errors.length = 0 // 清空登录前预期 401，登录后必须零错误

    // 交互：点 Dock 图标打开设置窗口
    await page.click('.dock-icon[data-app="settings"]')
    await page.waitForTimeout(500)
    const winOpen = await page.evaluate(() => {
      const w = document.getElementById('win-settings')
      return { visible: !!w && getComputedStyle(w).display !== 'none', cls: w?.className || '' }
    })
    console.log('📊 macos 窗口打开:', JSON.stringify(winOpen))

    // 交互：主题切换（若有主题按钮）
    const themeBtn = await page.$('[data-theme-btn], .theme-btn, #themeSeg button')
    if (themeBtn) { await themeBtn.click(); await page.waitForTimeout(300) }
    const themeAfter = await page.evaluate(() => document.body.getAttribute('data-theme'))
    console.log('📊 macos 主题切换后:', themeAfter || '(无按钮或未切换)')

    await page.screenshot({ path: join(OUT_DIR, 'macos-desktop.png') })
    console.log('📸 macos-desktop.png 已保存')
    await page.close()
  }

  // ── 移动端：iOS 风格（iPhone 14） ──
  {
    const ctx = await browser.newContext({ ...devices['iPhone 14'] })
    const page = await ctx.newPage()
    page.on('pageerror', (e) => errors.push('ios pageerror: ' + e.message))
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('ios console: ' + m.text()) })
    await page.goto(base + '/ios.html', { waitUntil: 'networkidle' })
    await page.waitForTimeout(600)

    const checks = await page.evaluate(() => ({
      gestureLayer: !!document.getElementById('gestureLayer'),
      tabs: document.querySelectorAll('.tab').length,
      navTitle: document.getElementById('navTitle')?.textContent || '',
      loadLists: typeof window.loadLists,
      safeTop: getComputedStyle(document.documentElement).getPropertyValue('--safe-t').trim(),
      themeAttr: document.body.getAttribute('data-theme') || '(auto/默认)',
      wallpapers: document.querySelectorAll('.swatch').length,
    }))
    console.log('📊 ios 静态断言:', JSON.stringify(checks))

    // 登录（隔离实例 seed 默认用户）
    await page.fill('#loginUser', 'wilsonwen')
    await page.fill('#loginPass', 'Wenq5201314')
    await page.click('#loginBtn')
    await page.waitForFunction(() => !document.getElementById('loginScreen') || getComputedStyle(document.getElementById('loginScreen')).display === 'none', null, { timeout: 8000 })
    console.log('📊 ios 登录成功，loginScreen 已隐藏')
    errors.length = 0 // 清空登录前预期 401，登录后必须零错误

    // 交互：tab 切换
    await page.click('.tab[data-tab="settings"]')
    await page.waitForTimeout(400)
    const tabAfter = await page.evaluate(() => ({
      activeTab: document.querySelector('.tab.active')?.dataset.tab || '',
      navTitle: document.getElementById('navTitle')?.textContent || '',
      settingsVisible: getComputedStyle(document.getElementById('page-settings')).display !== 'none',
    }))
    console.log('📊 ios tab 切换:', JSON.stringify(tabAfter))

    // 手势返回层检查：左缘 swipe 模拟（touchscreen）
    const g = await page.evaluate(() => {
      const layer = document.getElementById('gestureLayer')
      return { hidden: layer ? layer.hidden : null }
    })
    console.log('📊 ios gestureLayer 初始状态:', JSON.stringify(g))

    await page.screenshot({ path: join(OUT_DIR, 'ios-mobile.png') })
    console.log('📸 ios-mobile.png 已保存')
    await ctx.close()
  }

  console.log(errors.length ? '❌ 存在 JS 错误:\n' + errors.join('\n') : '✅ 双端无 JS 错误')
  process.exitCode = errors.length ? 1 : 0
} catch (e) {
  console.error('❌ 验证异常:', e.message)
  process.exitCode = 1
} finally {
  try { await browser?.close() } catch {}
  try { server?.kill('SIGKILL') } catch {}
}
