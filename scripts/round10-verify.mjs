import { spawn } from 'node:child_process'
const ROOT = '/Users/wilsonwen/code/video-download'
const BASE = 'http://localhost:3211'
const server = spawn(process.execPath, ['src/index.js'], { cwd: ROOT, env: { ...process.env, PORT: '3211', VD_DATA_DIR: '/tmp/vd-r10' }, stdio: 'ignore' })
let browser = null
try {
  const { chromium, devices } = await import('playwright-core')
  for (let i = 0; i < 40; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break } catch {} await new Promise(r => setTimeout(r, 300)) }
  browser = await chromium.launch()
  const ctx = await browser.newContext({ ...devices['iPhone 14'] })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(BASE + '/ios.html', { waitUntil: 'networkidle' })
  await page.fill('#loginUser', 'wilsonwen'); await page.fill('#loginPass', 'Wenq5201314'); await page.click('#loginBtn')
  await page.waitForFunction(() => getComputedStyle(document.getElementById('loginScreen')).display === 'none', null, { timeout: 8000 })
  await page.waitForTimeout(300)
  // ① 登录后（含 input blur 路径）：html 画布仍钉 844，内容在可视区
  const g = await page.evaluate(() => {
    const doc = document.documentElement
    const home = document.getElementById('homeScreen').getBoundingClientRect()
    const dock = document.querySelector('.home-dock').getBoundingClientRect()
    return { htmlMinH: doc.style.minHeight || '(空)', htmlH: Math.round(doc.getBoundingClientRect().height), clientH: doc.clientHeight, homeBottom: Math.round(home.bottom), dockVisible: dock.bottom > 0 && dock.bottom <= innerHeight + 1 }
  })
  const ok1 = g.htmlMinH === '844px' && g.htmlH === 844 && g.dockVisible
  console.log('① 画布+内容:', JSON.stringify(g), ok1 ? '✅' : 'FAIL')
  // ② 再走一次键盘 blur 路径后画布仍钉住
  await page.click('#homeIconGrid .home-app[data-app="settings"]')
  await page.waitForTimeout(500)
  const g2 = await page.evaluate(() => ({ htmlMinH: document.documentElement.style.minHeight || '(空)', scrollY: window.scrollY }))
  const ok2 = g2.htmlMinH === '844px' && g2.scrollY === 0
  console.log('② 键盘路径后:', JSON.stringify(g2), ok2 ? '✅' : 'FAIL')
  // ③ PIN 键盘在可视区内
  const pg = await page.evaluate(() => {
    const p = document.getElementById('pinScreen'); p.hidden = false
    const r = p.getBoundingClientRect()
    const kbd = document.querySelector('.pin-numpad').getBoundingClientRect()
    p.hidden = true
    return { pinBottom: Math.round(r.bottom), kbdBottom: Math.round(kbd.bottom), vh: innerHeight }
  })
  const ok3 = pg.pinBottom <= pg.vh + 1 && pg.kbdBottom <= pg.vh + 1
  console.log('③ PIN 内容:', JSON.stringify(pg), ok3 ? '✅' : 'FAIL')
  await page.screenshot({ path: '/tmp/vd-verify-shots/r10-final.png' })
  console.log('④ JS错误:', errors.length ? errors.join(' | ') : '无')
  const pass = ok1 && ok2 && ok3 && errors.length === 0
  console.log(pass ? '══ R10 验证通过 ══' : '══ FAIL ══')
  process.exitCode = pass ? 0 : 1
} catch (e) { console.error('异常:', e.message); process.exitCode = 1 }
finally { try { await browser?.close() } catch {} try { server?.kill('SIGKILL') } catch {} }
