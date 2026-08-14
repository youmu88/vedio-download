/**
 * gestures-verify.mjs — iOS 左缘右滑返回手势端到端验证
 * 真实路径：隔离实例 → iPhone 视口 → 登录 → 设置私密 PIN → 私密 App 全屏
 *          → 左缘 5px 起手右滑 280px → 断言跟手位移 + 松手返回主界面
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = '/Users/wilsonwen/code/video-download'
const PORT = 3200
const DATA_DIR = '/tmp/vd-gesture-verify'
const BASE = `http://localhost:${PORT}`

let server = null
let browser = null
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`  ${ok ? '✅' : '❌'} ${name}${ok ? '' : ' ' + detail}`) }

async function waitReady() {
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(BASE + '/api/health')).ok) return true } catch {}
    await new Promise(r => setTimeout(r, 300))
  }
  return false
}

try {
  mkdirSync('/tmp/vd-verify-shots', { recursive: true })
  fs.rmSync(DATA_DIR, { recursive: true, force: true })
  const { chromium, devices } = await import('playwright-core')
  server = spawn(process.execPath, ['src/index.js'], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), VD_DATA_DIR: DATA_DIR }, stdio: 'ignore',
  })
  if (!(await waitReady())) throw new Error('隔离实例未就绪')

  browser = await chromium.launch()
  const ctx = await browser.newContext({ ...devices['iPhone 14'] })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()) })

  await page.goto(BASE + '/ios.html', { waitUntil: 'networkidle' })
  await page.fill('#loginUser', 'wilsonwen')
  await page.fill('#loginPass', 'Wenq5201314')
  await page.click('#loginBtn')
  await page.waitForFunction(() => !document.getElementById('loginScreen') || getComputedStyle(document.getElementById('loginScreen')).display === 'none', null, { timeout: 8000 })
  check('iOS 登录成功', true)

  // ── 桌面主屏幕断言 ──
  const home = await page.evaluate(() => ({
    homeScreen: !!document.getElementById('homeScreen'),
    apps: document.querySelectorAll('.home-app').length,
    stageHidden: document.getElementById('appStage').hidden,
  }))
  check('桌面主屏幕渲染（图标网格 4 + Dock 4）', home.homeScreen && home.apps === 8 && home.stageHidden, JSON.stringify(home))

  // ── 点主屏「设置」图标 → App 启动 ──
  await page.click('#homeIconGrid .home-app[data-app="settings"]')
  await page.waitForTimeout(700)
  const appOpen = await page.evaluate(() => ({
    stageHidden: document.getElementById('appStage').hidden,
    settingsActive: document.getElementById('page-settings').classList.contains('active'),
  }))
  check('设置 App 从图标全屏启动', !appOpen.stageHidden && appOpen.settingsActive, JSON.stringify(appOpen))

  // ── 设置 App → 私密入口 → 首次设置 PIN 1234（自动转确认）──
  await page.waitForTimeout(300)
  await page.click('div[onclick*="openPrivateEntry"]')
  await page.waitForSelector('#pinScreen .pin-numpad', { timeout: 5000 })
  check('PIN 设置界面弹出（首次）', true)

  for (let round = 0; round < 2; round++) {
    for (const d of ['1', '2', '3', '4']) {
      await page.click(`.pin-numpad button:has-text("${d}")`)
      await page.waitForTimeout(120)
    }
    await page.waitForTimeout(500) // 等待自动转确认 / 提交
  }
  await page.waitForTimeout(800)
  const fullApp = await page.evaluate(() => ({
    privateActive: document.getElementById('page-private').classList.contains('active'),
    navTitle: document.getElementById('navTitle').textContent,
  }))
  check('私密 App 全屏打开（私密页 active + 标题切换）', fullApp.privateActive && fullApp.navTitle.includes('私密'), JSON.stringify(fullApp))

  // ── 左缘右滑返回（CDP 真实触摸事件）──
  const cdp = await ctx.newCDPSession(page)
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', {
    type, touchPoints: [{ x, y, radiusX: 3, radiusY: 3, force: 1 }],
  })
  await touch('touchStart', 5, 420)
  await page.waitForTimeout(60)
  let maxFrontX = 0
  for (let x = 40; x <= 280; x += 40) {
    await touch('touchMove', x, 420)
    await page.waitForTimeout(24)
    const tx = await page.evaluate(() => {
      const el = document.getElementById('gestureFront')
      if (!el) return -1
      const m = getComputedStyle(el).transform.match(/matrix\(([^)]+)\)/)
      return m ? parseFloat(m[1].split(',')[4]) : 0
    }).catch(() => -1)
    if (tx > maxFrontX) maxFrontX = tx
  }
  check('手势跟手：gestureFront 实时位移 > 150px', maxFrontX > 150, `maxFrontX=${maxFrontX}`)

  const backScale = await page.evaluate(() => {
    const el = document.getElementById('gestureBack')
    const m = getComputedStyle(el).transform.match(/matrix\(([^)]+)\)/)
    return m ? parseFloat(m[1].split(',')[0]) : null
  }).catch(() => null)
  check('前页缩放效果生效（gestureBack scale ≠ 1）', backScale !== null && backScale !== 1, `scale=${backScale}`)

  await touch('touchEnd', 300, 420)
  await page.waitForTimeout(700) // 等待 340ms 滑出动画 + 清理

  const after = await page.evaluate(() => ({
    settingsActive: document.getElementById('page-settings').classList.contains('active'),
    privateActive: document.getElementById('page-private').classList.contains('active'),
    gestureHidden: document.getElementById('gestureLayer').hidden,
  }))
  check('松手后返回设置 App（私密页退出）', after.settingsActive && !after.privateActive, JSON.stringify(after))
  check('克隆手势层清理完毕', after.gestureHidden === true, JSON.stringify(after))

  // ── 第二层手势：设置 App 根页左缘右滑 → 返回桌面（拖动 appStage）──
  await touch('touchStart', 5, 420)
  await page.waitForTimeout(60)
  let maxStageX = 0
  for (let x = 40; x <= 280; x += 40) {
    await touch('touchMove', x, 420)
    await page.waitForTimeout(24)
    const tx = await page.evaluate(() => {
      const el = document.getElementById('appStage')
      const m = getComputedStyle(el).transform.match(/matrix\(([^)]+)\)/)
      return m ? parseFloat(m[1].split(',')[4]) : 0
    }).catch(() => 0)
    if (tx > maxStageX) maxStageX = tx
  }
  check('返回桌面手势跟手：appStage 实时位移 > 150px', maxStageX > 150, `maxStageX=${maxStageX}`)

  const homeScale = await page.evaluate(() => {
    const el = document.getElementById('homeScreen')
    const m = getComputedStyle(el).transform.match(/matrix\(([^)]+)\)/)
    return m ? parseFloat(m[1].split(',')[0]) : null
  }).catch(() => null)
  check('桌面缩放浮现（homeScreen scale < 1）', homeScale !== null && homeScale < 1, `scale=${homeScale}`)

  await touch('touchEnd', 300, 420)
  await page.waitForTimeout(700)

  const homeAfter = await page.evaluate(() => ({
    stageHidden: document.getElementById('appStage').hidden,
    homeScale: (() => { const m = getComputedStyle(document.getElementById('homeScreen')).transform.match(/matrix\(([^)]+)\)/); return m ? parseFloat(m[1].split(',')[0]) : null; })(),
  }))
  check('松手后回到主屏幕（appStage 隐藏 + 桌面 scale 恢复 1）', homeAfter.stageHidden && (homeAfter.homeScale === null || homeAfter.homeScale === 1), JSON.stringify(homeAfter))
  check('全程无 JS 错误', errors.length === 0, errors.join(' | '))

  await page.screenshot({ path: '/tmp/vd-verify-shots/ios-private-app.png' })
  const failed = results.filter(r => !r.ok)
  console.log(failed.length === 0 ? '🎉 iOS 手势返回验证全部通过' : `❌ ${failed.length} 项失败`)
  process.exitCode = failed.length ? 1 : 0
} catch (e) {
  console.error('❌ 验证异常:', e.message)
  process.exitCode = 1
} finally {
  try { await browser?.close() } catch {}
  try { server?.kill('SIGKILL') } catch {}
}
