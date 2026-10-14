#!/usr/bin/env node
/**
 * player-gestures-verify.mjs — 播放器手势端到端验证
 *
 * 能力：双指捏合等比缩放（撑满全屏）+ 横滑快进/快退 15 秒
 * 真实路径：隔离实例（ffmpeg 生成 90s 测试视频）→ iPhone 14 视口 → 登录 → 浏览 App
 *          → 点击播放 → CDP Input.dispatchTouchEvent 派发真实触摸序列 → DOM 几何/transform/currentTime 断言
 *
 * 覆盖：
 *   A. 双指外扩 → 播放器进入全屏浮层（.fs 迁移 body）+ 内容等比覆盖视口（scaleX==scaleY 且 ≥ coverScale）
 *   B. 全屏中双指收拢 → 退出全屏回卡片、scale 复位 1
 *   C. 双击切换全屏（进/出）；切换视频后手势状态复位
 *   D. 横滑 +80px → +15s；-80px → -15s（暂停态精确断言）+ 拖动中指示条文案
 *   E. 竖滑不 seek；起手 x<28 让位系统左缘返回手势（不 seek、页面不被导航）
 *   F. 桌面端（macos.html）：鼠标横滑 seek + ctrl+滚轮缩放进/出全屏
 */
import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 3201
const DATA_DIR = '/tmp/vd-pg-verify'
const DL_DIR = path.join(DATA_DIR, 'downloads', 'wilsonwen')
const BASE = `http://localhost:${PORT}`
const SHOTS = '/tmp/vd-verify-shots'
const VIDEO = 'gesture-test.mp4'

let server = null
let browser = null
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`  ${ok ? '✅' : '❌'} ${name}${ok ? '' : '  ← ' + detail}`) }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function waitReady() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + '/api/health')).ok) return true } catch {}
    await sleep(300)
  }
  return false
}

/** 页面内状态采样：播放器几何 / transform 矩阵 / 指示条 / currentTime */
function stateEval(page, boxId, videoId) {
  return page.evaluate(([boxId, videoId]) => {
    const box = document.getElementById(boxId);
    const v = document.getElementById(videoId);
    if (!box || !v) return null;
    const r = v.getBoundingClientRect();
    const tr = getComputedStyle(v).transform;
    let sx = 1, sy = 1, tx = 0, ty = 0;
    if (tr && tr !== 'none') { const m = new DOMMatrixReadOnly(tr); sx = m.a; sy = m.d; tx = m.e; ty = m.f; }
    const W = r.width / sx, H = r.height / sy;
    const vw = v.videoWidth || 16, vh = v.videoHeight || 9;
    const cw = Math.min(W, vw * H / vh), ch = Math.min(H, vh * W / vw);
    const pill = box.querySelector('.pg-pill');
    return {
      fs: box.classList.contains('fs'),
      parentIsBody: box.parentElement === document.body,
      boxVisible: !box.hidden,
      sx, sy, tx, ty,
      equalRatio: Math.abs(sx - sy) < 1e-6,
      coverScale: Math.max(innerWidth / cw, innerHeight / ch),
      coversViewport: r.left <= 1 && r.top <= 1 && r.right >= innerWidth - 1 && r.bottom >= innerHeight - 1,
      pillOn: !!(pill && pill.classList.contains('on')),
      pillText: pill ? pill.textContent : '',
      t: v.currentTime,
      vw: innerWidth, vh: innerHeight,
    };
  }, [boxId, videoId]);
}

/** CDP 双指捏合：从 spreadStart 张到 spreadEnd（px，半间距），圆心 (cx,cy) */
async function pinch(cdp, cx, cy, spreadStart, spreadEnd) {
  const pts = (d) => [{ x: cx - d, y: cy }, { x: cx + d, y: cy }]
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(spreadStart) })
  const steps = 14
  for (let i = 1; i <= steps; i++) {
    const d = spreadStart + (spreadEnd - spreadStart) * i / steps
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(d) })
    await sleep(16)
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await sleep(150) // CDP ack ≠ DOM 事件已派发，留出事件循环冲刷时间
}
async function drag(cdp, x, y, dx, dy, { steps = 8, stepMs = 16, mid } = {}) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx * i / steps, y: y + dy * i / steps }] })
    if (mid && i === steps - 1) { await sleep(50); await mid() }
    await sleep(stepMs)
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await sleep(60)
}

/** CDP 快速双击 */
async function doubleTap(cdp, x, y) {
  for (let i = 0; i < 2; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await sleep(90)
  }
}

async function loginAndOpen(page, shell) {
  await page.goto(BASE + (shell === 'macos' ? '/macos.html' : '/ios.html'), { waitUntil: 'networkidle' })
  await page.fill('#loginUser', 'wilsonwen')
  await page.fill('#loginPass', 'Wenq5201314')
  await page.click('#loginBtn')
  await page.waitForFunction(() => !document.getElementById('loginScreen') || getComputedStyle(document.getElementById('loginScreen')).display === 'none', null, { timeout: 8000 })
  if (shell === 'macos') {
    await page.click('.dock-icon.app-browse')
  } else {
    await page.click('.home-app[data-app="browse"]')
  }
  await page.waitForSelector('.video-card', { timeout: 10000 })
  await page.click('.video-card')
  await page.waitForFunction(() => {
    const box = document.getElementById('inlinePlayer'); const v = document.getElementById('inlinePlayerVideo')
    return box && !box.hidden && v && v.readyState >= 1 && isFinite(v.duration) && v.duration > 0
  }, null, { timeout: 15000 })
}

async function main() {
  try {
    mkdirSync(SHOTS, { recursive: true })
  rmSync(DATA_DIR, { recursive: true, force: true })
  mkdirSync(DL_DIR, { recursive: true })
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc=duration=90:size=640x360:rate=30`,
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', '-movflags', '+faststart', path.join(DL_DIR, VIDEO)])

  server = spawn(process.execPath, ['src/index.js'], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), VD_DATA_DIR: DATA_DIR, VD_DOWNLOADS_DIR: path.join(DATA_DIR, 'downloads') }, stdio: 'ignore',
  })
  if (!(await waitReady())) throw new Error('隔离实例未就绪')

  const { chromium, devices } = await import('playwright-core')
  browser = await chromium.launch()

  // ═══ 移动端（ios.html + iPhone 14 触摸）═══
  {
    const ctx = await browser.newContext({ ...devices['iPhone 14'] })
    const page = await ctx.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()) })
    const cdp = await ctx.newCDPSession(page)

    await loginAndOpen(page, 'ios')
    check('iOS 登录并播放测试视频', true)

    const vc = await page.evaluate(() => { const r = document.getElementById('inlinePlayerVideo').getBoundingClientRect(); return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 } })
    await page.screenshot({ path: SHOTS + '/pg-inline.png' })

    // ── D. 横滑 seek（暂停态精确断言）──
    await page.evaluate(() => { const v = document.getElementById('inlinePlayerVideo'); v.pause(); v.currentTime = 30 })
    let pillMid = null
    await drag(cdp, vc.x - 40, vc.y, 80, 0, { mid: async () => { pillMid = await stateEval(page, 'inlinePlayer', 'inlinePlayerVideo') } })
    let st = await stateEval(page, 'inlinePlayer', 'inlinePlayerVideo')
    check('右滑 +80px → 快进 15s（30→45）', Math.abs(st.t - 45) < 0.5, `t=${st.t.toFixed(2)}`)
    check('拖动中指示条可见且文案含「快进」', pillMid && pillMid.pillOn && pillMid.pillText.includes('快进'), JSON.stringify(pillMid && pillMid.pillText))
    await page.screenshot({ path: SHOTS + '/pg-seek.png' })

    await page.evaluate(() => { document.getElementById('inlinePlayerVideo').currentTime = 45 })
    await drag(cdp, vc.x + 40, vc.y, -80, 0)
    st = await stateEval(page, 'inlinePlayer', 'inlinePlayerVideo')
    check('左滑 -80px → 快退 15s（45→30）', Math.abs(st.t - 30) < 0.5, `t=${st.t.toFixed(2)}`)

    // ── E. 竖滑不 seek ──
    await drag(cdp, vc.x, vc.y, 8, 140)
    st = await stateEval(page, 'inlinePlayer', 'inlinePlayerVideo')
    check('竖向滑动不触发 seek', Math.abs(st.t - 30) < 0.01 && !st.fs, `t=${st.t.toFixed(2)} fs=${st.fs}`)

    // ── E. 起手 x<28 让位系统返回手势 ──
    await drag(cdp, 10, vc.y, 100, 0, { steps: 8, stepMs: 42 })
    st = await stateEval(page, 'inlinePlayer', 'inlinePlayerVideo')
    const appStill = await page.evaluate(() => !document.getElementById('appStage').hidden)
    check('左缘起手横滑不 seek（让位系统返回）', Math.abs(st.t - 30) < 0.01, `t=${st.t.toFixed(2)}`)
    check('左缘返回手势仍存活（慢速右滑回弹，未导航）', appStill, 'appStage 已隐藏')

    // ── A. 双指外扩 → 全屏 + 等比撑满 ──
    await pinch(cdp, vc.x, vc.y, 40, 190)
    st = await stateEval(page, 'inlinePlayer', 'inlinePlayerVideo')
    check('双指外扩 → 播放器进入全屏浮层', st.fs && st.parentIsBody, JSON.stringify({ fs: st.fs, body: st.parentIsBody }))
    check('全屏且视频元素覆盖视口', st.coversViewport, JSON.stringify(st))
    check('等比缩放（scaleX==scaleY）', st.equalRatio, `sx=${st.sx.toFixed(3)} sy=${st.sy.toFixed(3)}`)
    check('内容撑满视口（scale ≥ coverScale，去黑边）', st.sx >= st.coverScale - 0.02, `sx=${st.sx.toFixed(2)} cover=${st.coverScale.toFixed(2)}`)
    await page.screenshot({ path: SHOTS + '/pg-fullscreen.png' })

    // ── A2. 全屏中单指平移（scale>1）不破坏覆盖 ──
    await drag(cdp, vc.x, vc.y, 60, 0)
    st = await stateEval(page, 'inlinePlayer', 'inlinePlayerVideo')
    check('全屏放大后单指平移仍覆盖视口', st.fs && st.coversViewport && st.equalRatio, JSON.stringify({ tx: st.tx.toFixed(0) }))

    // ── B. 双指收拢 → 退出全屏（外扩被夹到 4x 后，收拢需覆盖 4 倍行程：150→25 ⇒ 0.67x 触发退出意图）──
    await pinch(cdp, vc.x, vc.y, 150, 25)
    await page.waitForFunction(() => {
      const box = document.getElementById('inlinePlayer')
      return box && !box.classList.contains('fs') && box.parentElement !== document.body
    }, null, { timeout: 2000 }).catch(() => {})
    st = await stateEval(page, 'inlinePlayer', 'inlinePlayerVideo')
    check('双指收拢 → 退出全屏回卡片', !st.fs && !st.parentIsBody, JSON.stringify({ fs: st.fs, body: st.parentIsBody }))
    check('退出后 scale 复位 1', Math.abs(st.sx - 1) < 0.05, `sx=${st.sx.toFixed(3)}`)

    // ── C. 双击切换全屏 ──
    await doubleTap(cdp, vc.x, vc.y)
    st = await stateEval(page, 'inlinePlayer', 'inlinePlayerVideo')
    check('双击 → 进入全屏', st.fs && st.parentIsBody, JSON.stringify({ fs: st.fs }))
    await doubleTap(cdp, vc.x, vc.y)
    st = await stateEval(page, 'inlinePlayer', 'inlinePlayerVideo')
    check('再次双击 → 退出全屏', !st.fs && !st.parentIsBody && Math.abs(st.sx - 1) < 0.05, JSON.stringify({ fs: st.fs, sx: st.sx.toFixed(3) }))

    // ── C2. 切换视频后手势状态复位 ──
    await pinch(cdp, vc.x, vc.y, 40, 190)
    await page.evaluate((name) => window.playLibrary(name), VIDEO)
    await page.waitForFunction(() => {
      const v = document.getElementById('inlinePlayerVideo'); return v.readyState >= 1 && isFinite(v.duration) && v.duration > 0
    }, null, { timeout: 15000 })
    st = await stateEval(page, 'inlinePlayer', 'inlinePlayerVideo')
    check('切换视频后退出全屏且 scale 复位', !st.fs && !st.parentIsBody && Math.abs(st.sx - 1) < 0.05, JSON.stringify({ fs: st.fs, sx: st.sx.toFixed(3), body: st.parentIsBody }))

    check('iOS 无页面错误', errors.length === 0, errors.join(' | '))
    await ctx.close()
  }

  // ═══ 桌面端（macos.html + 鼠标/滚轮）═══
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const page = await ctx.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()) })

    await loginAndOpen(page, 'macos')
    check('macOS 登录并播放测试视频', true)

    const vc = await page.evaluate(() => { const r = document.getElementById('inlinePlayerVideo').getBoundingClientRect(); return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 } })

    // 鼠标横滑 seek
    await page.evaluate(() => { const v = document.getElementById('inlinePlayerVideo'); v.pause(); v.currentTime = 20 })
    await page.mouse.move(vc.x - 40, vc.y)
    await page.mouse.down()
    for (let i = 1; i <= 8; i++) { await page.mouse.move(vc.x - 40 + 80 * i / 8, vc.y); await sleep(16) }
    await page.mouse.up()
    let st = await stateEval(page, 'inlinePlayer', 'inlinePlayerVideo')
    check('桌面鼠标横滑 +80px → 快进 15s', Math.abs(st.t - 35) < 0.5, `t=${st.t.toFixed(2)}`)

    // ctrl+滚轮缩放进全屏（触控板捏合在 Chrome 桌面即 ctrl+wheel）
    await page.evaluate(() => {
      const v = document.getElementById('inlinePlayerVideo')
      for (let i = 0; i < 4; i++) v.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -120, bubbles: true, cancelable: true }))
    })
    await sleep(120)
    st = await stateEval(page, 'inlinePlayer', 'inlinePlayerVideo')
    check('桌面 ctrl+滚轮放大 → 全屏且等比覆盖', st.fs && st.coversViewport && st.equalRatio && st.sx >= st.coverScale - 0.02, JSON.stringify({ fs: st.fs, sx: st.sx.toFixed(2), cover: st.coverScale.toFixed(2) }))

    // 滚轮回缩到 1 以下 → 退出全屏
    await page.evaluate(() => {
      const v = document.getElementById('inlinePlayerVideo')
      for (let i = 0; i < 12; i++) v.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: 120, bubbles: true, cancelable: true }))
    })
    await sleep(120)
    st = await stateEval(page, 'inlinePlayer', 'inlinePlayerVideo')
    check('桌面滚轮回缩 → 退出全屏复位', !st.fs && !st.parentIsBody && Math.abs(st.sx - 1) < 0.05, JSON.stringify({ fs: st.fs, sx: st.sx.toFixed(3) }))

    check('macOS 无页面错误', errors.length === 0, errors.join(' | '))
    await ctx.close()
  }

  const failed = results.filter(r => !r.ok)
  console.log(`\n══ 播放器手势验证：${results.length - failed.length}/${results.length} 通过 ══`)
  if (failed.length) { process.exitCode = 1; failed.forEach(f => console.log('  ❌ ' + f.name)) }
  } catch (err) {
    console.error('💥 验证执行失败：', err)
    process.exitCode = 1
  } finally {
    try { if (browser) await browser.close() } catch {}
    try { if (server) server.kill() } catch {}
  }
}

main()
