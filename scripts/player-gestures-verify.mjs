#!/usr/bin/env node
/**
 * player-gestures-verify.mjs — 播放器手势端到端验证
 *
 * 能力：双指捏合等比缩放（撑满全屏）+ 横滑快进/快退 15 秒
 * 真实路径：隔离实例（ffmpeg 生成 90s 测试视频）→ iPhone 14 视口 → 登录 → 浏览 App
 *          → 点击播放 → CDP Input.dispatchTouchEvent 派发真实触摸序列 → DOM 几何/transform/currentTime 断言
 *
 * 覆盖：
 *   A. 双指外扩 → 播放器进入全屏浮层（.fs 迁移 body）+ 逐级吸附：轻扩中途松手也必到铺满档
 *      （scaleX==scaleY、内容矩形四边真满屏、全屏标题栏隐藏）；已铺满后继续外扩不放大；铺满档轻收拢 → 回 1x 默认态
 *   B. 全屏中双指收拢 → 退出全屏回卡片、scale 复位 1；内联卡片捏合收拢松手无缩放残留
 *   C. 双击切换全屏（进/出）；切换视频后手势状态复位
 *   D. 横滑 +80px → +15s；-80px → -15s（暂停态精确断言）+ 拖动中指示条文案
 *   E. 竖滑不 seek；起手 x<28 让位系统左缘返回手势（不 seek、页面不被导航）
 *   F. 桌面端（macos.html）：鼠标横滑 seek + ctrl+滚轮缩放进/出全屏 + gesture 连续手势不复合放大
 *   G. 放大态（scale>1）单指横滑仍可快进/快退（缩放态不平移，快进全档位可用）
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

/** 页面内状态采样：全屏/档位(object-fit) / 元素盒与内容矩形 / 顶部栏可见性 / 指示条 / currentTime */
function stateEval(page, boxId, videoId) {
  return page.evaluate(([boxId, videoId]) => {
    const box = document.getElementById(boxId);
    const v = document.getElementById(videoId);
    if (!box || !v) return null;
    const r = v.getBoundingClientRect();
    const tr = getComputedStyle(v).transform;
    let sx = 1, sy = 1, tx = 0, ty = 0;
    if (tr && tr !== 'none') { const m = new DOMMatrixReadOnly(tr); sx = m.a; sy = m.d; tx = m.e; ty = m.f; }
    const vw = v.videoWidth || 16, vh = v.videoHeight || 9;
    const fit = getComputedStyle(v).objectFit;
    // 内容矩形：cover 取放大方向、其余按 contain（两档的真实画面区域）
    const s = fit === 'cover' ? Math.max(r.width / vw, r.height / vh) : Math.min(r.width / vw, r.height / vh);
    const cW = vw * s, cH = vh * s;
    const cl = r.left + (r.width - cW) / 2, ct = r.top + (r.height - cH) / 2;
    const pill = box.querySelector('.pg-pill');
    const bar = box.querySelector('.inline-player-bar');
    const barCs = bar ? getComputedStyle(bar) : null;
    const barRect = bar ? bar.getBoundingClientRect() : null;
    return {
      fs: box.classList.contains('fs'),
      fill: box.classList.contains('fill'),
      objectFit: fit,
      parentIsBody: box.parentElement === document.body,
      boxVisible: !box.hidden,
      sx, sy, tx, ty,
      equalRatio: Math.abs(sx - sy) < 1e-6,
      // 元素盒完全在视口内（不再用 transform 放大 → 原生控件不会被推出屏幕）
      elFitsViewport: r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1,
      coversViewport: r.left <= 1 && r.top <= 1 && r.right >= innerWidth - 1 && r.bottom >= innerHeight - 1,
      content: { left: cl, top: ct, right: cl + cW, bottom: ct + cH },
      coversContent: cl <= 1 && ct <= 1 && cl + cW >= innerWidth - 1 && ct + cH >= innerHeight - 1,
      barDisplay: barCs ? barCs.display : 'missing',
      barVisible: !!(barCs && barCs.display !== 'none' && barRect && barRect.height > 0 && barRect.top < innerHeight && barRect.bottom > 0),
      barRect: barRect ? { top: barRect.top, bottom: barRect.bottom, height: barRect.height } : null,
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
  // 已登录（token 在 localStorage）时不再显示登录层，直接进 App
  const needLogin = await page.evaluate(() => {
    const el = document.getElementById('loginScreen')
    return !!el && getComputedStyle(el).display !== 'none'
  })
  if (needLogin) {
    await page.fill('#loginUser', 'wilsonwen')
    await page.fill('#loginPass', 'Wenq5201314')
    await page.click('#loginBtn')
    await page.waitForFunction(() => !document.getElementById('loginScreen') || getComputedStyle(document.getElementById('loginScreen')).display === 'none', null, { timeout: 8000 })
  }
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

    let vc = await page.evaluate(() => { const r = document.getElementById('inlinePlayerVideo').getBoundingClientRect(); return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 } })
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

    // 内联状态下的左缘返回是产品预期（会把浏览页导航走）→ 重载回干净起点，供全屏段使用
    await loginAndOpen(page, 'ios')
    vc = await page.evaluate(() => { const r = document.getElementById('inlinePlayerVideo').getBoundingClientRect(); return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 } })
    await page.evaluate(() => { const v = document.getElementById('inlinePlayerVideo'); v.pause(); v.currentTime = 30 })

    // ── A1. 双击进入全屏（默认「全屏」档：contain，上下黑边）──
    await doubleTap(cdp, vc.x, vc.y)
    await sleep(150)
    st = await stateEval(page, 'inlinePlayer', 'inlinePlayerVideo')
    check('双击 → 进入全屏（默认全屏档 contain）', st.fs && st.parentIsBody && st.objectFit === 'contain' && !st.fill, JSON.stringify({ fs: st.fs, fit: st.objectFit, fill: st.fill }))
    check('全屏档 video 元素盒等于视口（控件在屏内）', st.elFitsViewport && st.coversViewport, JSON.stringify({ fits: st.elFitsViewport }))
    check('全屏时顶部按钮栏可见（退出图标可达）', st.barVisible, JSON.stringify(st.barRect))

    // ── A2. 双指外扩 → 铺满全屏档（object-fit: cover，零黑边）──
    await pinch(cdp, vc.x, vc.y, 40, 90)
    st = await stateEval(page, 'inlinePlayer', 'inlinePlayerVideo')
    check('双指外扩 → 铺满档（cover + fill class）', st.fs && st.fill && st.objectFit === 'cover', JSON.stringify({ fs: st.fs, fit: st.objectFit, fill: st.fill }))
    check('铺满档内容覆盖视口四边（顶部无黑边）', st.coversContent, JSON.stringify(st.content))
    check('铺满档仍无 transform 缩放（sx==sy==1）', Math.abs(st.sx - 1) < 0.01 && Math.abs(st.sy - 1) < 0.01, `sx=${st.sx.toFixed(3)} sy=${st.sy.toFixed(3)}`)
    await page.waitForFunction(() => { const p = document.querySelector('#inlinePlayer .pg-pill'); return p && p.classList.contains('on') && p.textContent.includes('铺满全屏') }, null, { timeout: 1500 }).then(() => check('指示条显示档位名「铺满全屏」', true)).catch(() => check('指示条显示档位名「铺满全屏」', false, '未捕获到'))
    await page.screenshot({ path: SHOTS + '/pg-fill.png' })

    // ── A3. 铺满档单指横滑 → 快进/快退（缩放后横滑快进必须可用）──
    await page.evaluate(() => { const v = document.getElementById('inlinePlayerVideo'); v.pause(); v.currentTime = 30 })
    await drag(cdp, vc.x, vc.y, 80, 0)
    st = await stateEval(page, 'inlinePlayer', 'inlinePlayerVideo')
    check('铺满档单指横滑 +80px → 快进 15s（不被吞掉）', Math.abs(st.t - 45) < 0.5 && st.tx === 0 && st.ty === 0, `t=${st.t.toFixed(2)} tx=${st.tx} ty=${st.ty}`)
    await drag(cdp, vc.x, vc.y, -80, 0)
    st = await stateEval(page, 'inlinePlayer', 'inlinePlayerVideo')
    check('铺满档单指横滑 -80px → 快退 15s', Math.abs(st.t - 30) < 0.5, `t=${st.t.toFixed(2)}`)

    // ── A3b. 全屏时左缘起手横滑：由播放器接管（快进），不导航、不退出全屏 ──
    await drag(cdp, 10, vc.y, 80, 0, { steps: 8, stepMs: 42 })
    st = await stateEval(page, 'inlinePlayer', 'inlinePlayerVideo')
    const fsStill = await page.evaluate(() => !!document.querySelector('.inline-player.fs') && !document.getElementById('appStage').hidden)
    check('全屏左缘起手横滑 → 快进 15s（手势被播放器接管）', Math.abs(st.t - 45) < 0.5, `t=${st.t.toFixed(2)}`)
    check('全屏左缘手势不导航（页面仍在、播放器仍全屏）', fsStill, '被导航走了')

    // ── A4. 双指收拢 → 只降回「全屏」档，不退出全屏 ──
    await pinch(cdp, vc.x, vc.y, 90, 55)
    st = await stateEval(page, 'inlinePlayer', 'inlinePlayerVideo')
    check('双指收拢 → 回全屏档（contain）且仍全屏', st.fs && !st.fill && st.objectFit === 'contain', JSON.stringify({ fs: st.fs, fit: st.objectFit, fill: st.fill }))

    // ── A5. 继续大幅收拢 → 仍保持全屏（缩放手势不退出全屏）──
    await pinch(cdp, vc.x, vc.y, 150, 30)
    st = await stateEval(page, 'inlinePlayer', 'inlinePlayerVideo')
    check('继续大幅收拢仍保持全屏（手势不退出全屏）', st.fs === true && st.parentIsBody, JSON.stringify({ fs: st.fs, body: st.parentIsBody }))

    // ── A6. 全屏点顶部 close 图标 → 退出全屏回内联（播放器不关闭）──
    const closePt = await page.evaluate(() => { const b = document.querySelector('#inlinePlayer .inline-player-close'); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })
    await page.mouse.click(closePt.x, closePt.y)
    await sleep(250)
    st = await stateEval(page, 'inlinePlayer', 'inlinePlayerVideo')
    check('全屏点 close 图标 → 退出全屏且播放器仍打开', !st.fs && !st.parentIsBody && st.boxVisible, JSON.stringify({ fs: st.fs, visible: st.boxVisible }))
    check('退出全屏后档位复位（无 fill/cover 残留）', !st.fill && st.objectFit !== 'cover', `fill=${st.fill} fit=${st.objectFit}`)

    // ── B. 内联（非全屏）双指手势：不进入全屏、无缩放残留（全屏切换走图标/双击）──
    await pinch(cdp, vc.x, vc.y, 40, 120)
    st = await stateEval(page, 'inlinePlayer', 'inlinePlayerVideo')
    check('内联双指外扩不进入全屏（手势不做全屏切换）', !st.fs && !st.parentIsBody && !st.fill, JSON.stringify({ fs: st.fs, fill: st.fill }))
    check('内联捏合后无缩放残留（transform 恒 1）', Math.abs(st.sx - 1) < 0.02 && Math.abs(st.sy - 1) < 0.02, `sx=${st.sx.toFixed(3)} sy=${st.sy.toFixed(3)}`)

    // ── C. 双击切换全屏 ──
    await doubleTap(cdp, vc.x, vc.y)
    st = await stateEval(page, 'inlinePlayer', 'inlinePlayerVideo')
    check('双击 → 进入全屏', st.fs && st.parentIsBody, JSON.stringify({ fs: st.fs }))
    await doubleTap(cdp, vc.x, vc.y)
    st = await stateEval(page, 'inlinePlayer', 'inlinePlayerVideo')
    check('再次双击 → 退出全屏', !st.fs && !st.parentIsBody && Math.abs(st.sx - 1) < 0.05, JSON.stringify({ fs: st.fs, sx: st.sx.toFixed(3) }))

    // ── C2. 切换视频后手势状态复位（全屏 + 铺满 → 切视频后回内联、无 fill 残留）──
    await doubleTap(cdp, vc.x, vc.y)
    await sleep(120)
    await pinch(cdp, vc.x, vc.y, 40, 90)
    await page.evaluate((name) => window.playLibrary(name), VIDEO)
    await page.waitForFunction(() => {
      const v = document.getElementById('inlinePlayerVideo'); return v.readyState >= 1 && isFinite(v.duration) && v.duration > 0
    }, null, { timeout: 15000 })
    st = await stateEval(page, 'inlinePlayer', 'inlinePlayerVideo')
    check('切换视频后退出全屏且档位复位', !st.fs && !st.parentIsBody && !st.fill && Math.abs(st.sx - 1) < 0.05, JSON.stringify({ fs: st.fs, fill: st.fill, sx: st.sx.toFixed(3), body: st.parentIsBody }))

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

    // ctrl+滚轮（触控板捏合语义）：非全屏不响应——全屏切换只走图标/双击
    await page.evaluate(() => {
      const v = document.getElementById('inlinePlayerVideo')
      for (let i = 0; i < 4; i++) v.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -120, bubbles: true, cancelable: true }))
    })
    await sleep(150)
    st = await stateEval(page, 'inlinePlayer', 'inlinePlayerVideo')
    check('桌面非全屏 ctrl+滚轮不进入全屏（手势不做全屏切换）', !st.fs, JSON.stringify({ fs: st.fs }))

    // 双击进全屏（默认「全屏」档 contain）
    await page.mouse.dblclick(vc.x, vc.y)
    await sleep(220)
    st = await stateEval(page, 'inlinePlayer', 'inlinePlayerVideo')
    check('桌面双击 → 进入全屏（全屏档 contain）', st.fs && st.objectFit === 'contain' && !st.fill, JSON.stringify({ fs: st.fs, fit: st.objectFit, fill: st.fill }))

    // 全屏后 ctrl+滚轮外扩 → 铺满档
    await page.evaluate(() => {
      const v = document.getElementById('inlinePlayerVideo')
      for (let i = 0; i < 2; i++) v.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -120, bubbles: true, cancelable: true }))
    })
    await sleep(150)
    st = await stateEval(page, 'inlinePlayer', 'inlinePlayerVideo')
    check('桌面 ctrl+滚轮外扩 → 铺满档（cover）', st.fs && st.fill && st.objectFit === 'cover', JSON.stringify({ fs: st.fs, fill: st.fill, fit: st.objectFit }))

    // 回缩 → 回全屏档（仍全屏）
    await page.evaluate(() => {
      const v = document.getElementById('inlinePlayerVideo')
      for (let i = 0; i < 2; i++) v.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: 120, bubbles: true, cancelable: true }))
    })
    await sleep(150)
    st = await stateEval(page, 'inlinePlayer', 'inlinePlayerVideo')
    check('桌面 ctrl+滚轮回缩 → 回全屏档（仍全屏）', st.fs && !st.fill && st.objectFit === 'contain', JSON.stringify({ fs: st.fs, fill: st.fill }))

    // 继续回缩 → 仍保持全屏（手势不退出全屏）
    await page.evaluate(() => {
      const v = document.getElementById('inlinePlayerVideo')
      for (let i = 0; i < 8; i++) v.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: 120, bubbles: true, cancelable: true }))
    })
    await sleep(150)
    st = await stateEval(page, 'inlinePlayer', 'inlinePlayerVideo')
    check('桌面持续回缩仍保持全屏（缩放手势不退出全屏）', st.fs === true && st.parentIsBody, JSON.stringify({ fs: st.fs }))

    // Safari 桌面触控板 gesture（按方向切档，不做连续缩放）
    await page.evaluate(() => {
      const v = document.getElementById('inlinePlayerVideo')
      const mk = (type, sc) => { const ev = new Event(type, { cancelable: true, bubbles: true }); ev.scale = sc; v.dispatchEvent(ev) }
      mk('gesturestart', 1)
      mk('gesturechange', 1.3)
    })
    await sleep(120)
    st = await stateEval(page, 'inlinePlayer', 'inlinePlayerVideo')
    check('桌面 gesture 外扩 → 铺满档（cover）', st.fs && st.fill && st.objectFit === 'cover', JSON.stringify({ fill: st.fill, fit: st.objectFit }))
    await page.evaluate(() => {
      const v = document.getElementById('inlinePlayerVideo')
      const mk = (type, sc) => { const ev = new Event(type, { cancelable: true, bubbles: true }); ev.scale = sc; v.dispatchEvent(ev) }
      mk('gesturechange', 0.8)
      mk('gestureend', 0.8)
    })
    await sleep(150)
    st = await stateEval(page, 'inlinePlayer', 'inlinePlayerVideo')
    check('桌面 gesture 收拢 → 回全屏档且仍全屏', st.fs && !st.fill && st.objectFit === 'contain', JSON.stringify({ fs: st.fs, fill: st.fill }))

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
