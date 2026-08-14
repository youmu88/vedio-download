import { spawn } from 'node:child_process'
const server = spawn(process.execPath, ['src/index.js'], { cwd: '/Users/wilsonwen/code/video-download', env: { ...process.env, PORT: '3213', VD_DATA_DIR: '/tmp/vd-r11' }, stdio: 'ignore' })
let browser = null
try {
  const { chromium, devices } = await import('playwright-core')
  for (let i = 0; i < 40; i++) { try { if ((await fetch('http://localhost:3213/api/health')).ok) break } catch {} await new Promise(r => setTimeout(r, 300)) }
  browser = await chromium.launch()
  const ctx = await browser.newContext({ ...devices['iPhone 14'] })
  const page = await ctx.newPage()
  await page.goto('http://localhost:3213/ios.html', { waitUntil: 'networkidle' })
  await page.fill('#loginUser', 'wilsonwen'); await page.fill('#loginPass', 'Wenq5201314'); await page.click('#loginBtn')
  await page.waitForFunction(() => getComputedStyle(document.getElementById('loginScreen')).display === 'none', null, { timeout: 8000 })
  await page.click('#homeIconGrid .home-app[data-app="settings"]')
  await page.waitForTimeout(600)
  const light = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('#themeSeg button')].find(b => b.dataset.themeOpt === 'dark')
    return { color: getComputedStyle(btn).color, htmlTheme: document.documentElement.getAttribute('data-theme') }
  })
  const ok1 = light.color === 'rgba(60, 60, 67, 0.6)' && light.htmlTheme === 'light'
  console.log('① 亮色「深色」按钮:', JSON.stringify(light), ok1 ? '✅' : 'FAIL')
  await page.click('#themeSeg button[data-theme-opt="dark"]')
  await page.waitForTimeout(300)
  const dark = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('#themeSeg button')].find(b => b.dataset.themeOpt === 'dark')
    const cs = getComputedStyle(btn)
    return { htmlTheme: document.documentElement.getAttribute('data-theme'), active: btn.classList.contains('active'), color: cs.color, bg: cs.backgroundColor }
  })
  const ok2 = dark.htmlTheme === 'dark' && dark.active
  console.log('② 深色主题:', JSON.stringify(dark), ok2 ? '✅' : 'FAIL')
  await page.screenshot({ path: '/tmp/vd-verify-shots/t11-dark.png' })
  await page.click('#navBack')
  await page.waitForTimeout(500)
  const home = await page.evaluate(() => {
    const label = getComputedStyle(document.querySelector('.home-label'))
    const search = getComputedStyle(document.querySelector('.home-search'))
    return { labelColor: label.color, searchColor: search.color, searchInput: getComputedStyle(document.querySelector('.home-search input')).color }
  })
  console.log('③ 桌面亮色文字:', JSON.stringify(home))
  const ok3 = home.labelColor === 'rgb(0, 0, 0)' && home.searchColor === 'rgba(60, 60, 67, 0.6)'
  console.log('③', ok3 ? '✅' : 'FAIL')
  await page.screenshot({ path: '/tmp/vd-verify-shots/t11-home.png' })
  console.log((ok1 && ok2 && ok3) ? '══ T11 验证全部通过 ══' : '══ FAIL ══')
  process.exitCode = (ok1 && ok2 && ok3) ? 0 : 1
} catch (e) { console.error('异常:', e.message); process.exitCode = 1 }
finally { try { await browser?.close() } catch {} try { server?.kill('SIGKILL') } catch {} }
