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
      homeScreen: !!document.getElementById('homeScreen'),
      gridApps: document.querySelectorAll('#homeIconGrid .home-app').length,
      dockApps: document.querySelectorAll('#homeDock .home-app').length,
      search: !!document.getElementById('homeSearchInput'),
      stageHidden: document.getElementById('appStage').hidden,
      loadLists: typeof window.loadLists,
      themeAttr: document.body.getAttribute('data-theme') || '(auto/默认)',
      wallpapers: document.querySelectorAll('.swatch').length,
      gestureLayer: !!document.getElementById('gestureLayer'),
    }))
    console.log('📊 ios 静态断言:', JSON.stringify(checks))

    // 登录（隔离实例 seed 默认用户）
    await page.fill('#loginUser', 'wilsonwen')
    await page.fill('#loginPass', 'Wenq5201314')
    await page.click('#loginBtn')
    await page.waitForFunction(() => !document.getElementById('loginScreen') || getComputedStyle(document.getElementById('loginScreen')).display === 'none', null, { timeout: 8000 })
    console.log('📊 ios 登录成功，loginScreen 已隐藏')
    errors.length = 0 // 清空登录前预期 401，登录后必须零错误

    // 交互：点主屏「设置」图标启动 App（iOS 缩放动画）
    await page.click('#homeIconGrid .home-app[data-app="settings"]')
    await page.waitForTimeout(700)
    const appOpen = await page.evaluate(() => ({
      stageHidden: document.getElementById('appStage').hidden,
      settingsActive: document.getElementById('page-settings').classList.contains('active'),
      navTitle: document.getElementById('navTitle')?.textContent || '',
    }))
    console.log('📊 ios App 启动:', JSON.stringify(appOpen))

    await page.screenshot({ path: join(OUT_DIR, 'ios-app-settings.png') })
    console.log('📸 ios-app-settings.png 已保存')

    // 交互：壁纸切换（设置 App 内点 ocean 色板）
    await page.click('.swatch.s-ocean')
    await page.waitForTimeout(400)
    const wall = await page.evaluate(() => ({ cls: document.body.className, saved: localStorage.getItem('vd.settings.v2')?.includes('ocean') }))
    console.log('📊 ios 壁纸切换:', JSON.stringify(wall))

    // 交互：navBack 返回桌面
    await page.click('#navBack')
    await page.waitForTimeout(600)
    const backHome = await page.evaluate(() => ({
      stageHidden: document.getElementById('appStage').hidden,
      homeVisible: !!document.getElementById('homeScreen') && getComputedStyle(document.getElementById('homeScreen')).display !== 'none',
    }))
    console.log('📊 ios 返回桌面:', JSON.stringify(backHome))

    // 交互：搜索过滤（输入「服务器」→ 其余图标淡出）
    await page.fill('#homeSearchInput', '服务器')
    await page.waitForTimeout(300)
    const filter = await page.evaluate(() => {
      const apps = [...document.querySelectorAll('#homeIconGrid .home-app')]
      return apps.map(b => ({ app: b.dataset.app, opacity: b.style.opacity || '1' }))
    })
    console.log('📊 ios 搜索过滤:', JSON.stringify(filter))
    await page.fill('#homeSearchInput', '')
    await page.waitForTimeout(200)

    // 交互：打开「服务器」状态 App
    await page.click('#homeIconGrid .home-app[data-app="status"]')
    await page.waitForTimeout(800)
    const statusApp = await page.evaluate(() => ({
      stageHidden: document.getElementById('appStage').hidden,
      statusActive: document.getElementById('page-status').classList.contains('active'),
      version: document.getElementById('healthVersion')?.textContent || '',
      conn: document.getElementById('statusConnText')?.textContent || '',
    }))
    console.log('📊 ios 状态 App:', JSON.stringify(statusApp))
    await page.screenshot({ path: join(OUT_DIR, 'ios-app-status.png') })
    console.log('📸 ios-app-status.png 已保存')
    await page.click('#navBack')
    await page.waitForTimeout(600)

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
