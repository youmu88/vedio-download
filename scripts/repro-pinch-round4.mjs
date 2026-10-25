#!/usr/bin/env node
/**
 * repro-pinch-round4.mjs — 「普通全屏下双指缩放不响应」真实复现（修复前 / 修复后同一脚本）
 *
 * 用户反馈（第 7 轮）：最新版本普通全屏下双指缩放手势已经不响应，应该支持缩放到满屏（最大档）。
 *
 * 真实路径：隔离实例（ffmpeg 生成视频）→ iPhone 14 视口 → 登录 → 播放 → 双击进全屏
 *          → 在 5 种落点（中心/偏下/底部控制带/顶部/竖直分布）派发真实双指捏合
 *          → 页面内 pointer 探针记录「每一指是否到达、target 是谁」+ DOM 采样 object-fit / fill class。
 *
 * 探针的意义：区分两类根因——
 *   · 事件未到达（probe.downs 少于 2，或 target 不是 video）：元素/保护区/UA 层拦截；
 *   · 逻辑未切档（probe.downs 为 2 且 target 正确，但 object-fit 未变）：手势状态机判定问题。
 *
 * 输出：REPRO_RESULT={...} + 「缺陷复现: 是/否」
 */
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 3206
const DATA_DIR = '/tmp/vd-pg-repro4'
const DL_DIR = path.join(DATA_DIR, 'downloads', 'wilsonwen')
const BASE = `http://localhost:${PORT}`
const VIDEO = 'repro-pinch.mp4'
const SHOTS = '/tmp/vd-pg-repro4-shots'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let server = null
let browser = null

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(BASE + '/api/health')).ok) return true } catch { /* retry */ }
    await sleep(300)
  }
  return false
}

/** 页面内 pointer 探针：记录捕获阶段到达 document 的每个 pointerdown/up（含 target 与 isPrimary） */
function installProbe(page) {
  return page.evaluate(() => {
    window.__probe = { downs: [], ups: [], moves: 0 }
    if (window.__probeBound) return
    window.__probeBound = true
    document.addEventListener('pointerdown', (e) => {
      const t = e.target || {}
      const cls = typeof t.className === 'string' ? t.className : ''
      window.__probe.downs.push({
        tag: t.tagName || '', id: t.id || '', cls,
        type: e.pointerType, primary: !!e.isPrimary,
        x: Math.round(e.clientX), y: Math.round(e.clientY),
      })
    }, true)
    document.addEventListener('pointermove', () => { window.__probe.moves++ }, true)
    document.addEventListener('pointerup', (e) => {
      window.__probe.ups.push({ x: Math.round(e.clientX), y: Math.round(e.clientY) })
    }, true)
  })
}

const resetProbe = (page) => page.evaluate(() => { window.__probe = { downs: [], ups: [], moves: 0 } })
const readProbe = (page) => page.evaluate(() => window.__probe)

/** 采样全屏态 / 铺满态 / 画面内容矩形 / 播放器节点归属与可见性 */
function stateEval(page) {
  return page.evaluate(() => {
    const box = document.getElementById('inlinePlayer')
    const v = document.getElementById('inlinePlayerVideo')
    if (!box || !v) return null
    const r = v.getBoundingClientRect()
    const fit = getComputedStyle(v).objectFit
    const vw = v.videoWidth || 16, vh = v.videoHeight || 9
    const s = fit === 'cover' ? Math.max(r.width / vw, r.height / vh) : Math.min(r.width / vw, r.height / vh)
    const cW = vw * s, cH = vh * s
    const cl = r.left + (r.width - cW) / 2, ct = r.top + (r.height - cH) / 2
    return {
      hidden: !!box.hidden,
      fs: box.classList.contains('fs'),
      fill: box.classList.contains('fill'),
      parent: box.parentElement ? (box.parentElement.id || box.parentElement.tagName) : null,
      cls: box.className,
      objectFit: fit,
      el: { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height), w: Math.round(r.width) },
      content: { top: Math.round(ct), bottom: Math.round(ct + cH), h: Math.round(cH) },
      vw: innerWidth, vh: innerHeight,
      pillText: (box.querySelector('.pg-pill') || {}).textContent || '',
    }
  })
}

async function pinch(cdp, center, spreadStart, spreadEnd, axis = 'h') {
  const pts = (d) => (axis === 'h'
    ? [{ x: center.x - d, y: center.y }, { x: center.x + d, y: center.y }]
    : [{ x: center.x, y: center.y - d }, { x: center.x, y: center.y + d }])
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(spreadStart) })
  const steps = 12
  for (let i = 1; i <= steps; i++) {
    const d = spreadStart + (spreadEnd - spreadStart) * i / steps
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(d) })
    await sleep(16)
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await sleep(220)
}

async function doubleTap(cdp, x, y) {
  for (let i = 0; i < 2; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await sleep(90)
  }
  await sleep(220)
}

/** 单指点击：Chromium 原生控件显隐由鼠标交互驱动 */
async function tap(page, x, y) {
  await page.mouse.move(x, y)
  await sleep(80)
  await page.mouse.down()
  await sleep(60)
  await page.mouse.up()
  await sleep(500)
}

async function loginAndOpen(page) {
  await page.goto(BASE + '/ios.html', { waitUntil: 'networkidle' })
  await page.fill('#loginUser', 'wilsonwen')
  await page.fill('#loginPass', 'Wenq5201314')
  await page.click('#loginBtn')
  await page.waitForFunction(() => !document.getElementById('loginScreen') || getComputedStyle(document.getElementById('loginScreen')).display === 'none', null, { timeout: 8000 })
  await page.click('.home-app[data-app="browse"]')
  await page.waitForSelector('.video-card', { timeout: 10000 })
  await page.click('.video-card')
  await page.waitForFunction(() => {
    const box = document.getElementById('inlinePlayer'); const v = document.getElementById('inlinePlayerVideo')
    return box && !box.hidden && v && v.readyState >= 1 && isFinite(v.duration) && v.duration > 0
  }, null, { timeout: 15000 })
}

async function main() {
  const findings = {}
  const trace = {}
  try {
    rmSync(DATA_DIR, { recursive: true, force: true })
    mkdirSync(DL_DIR, { recursive: true })
    mkdirSync(SHOTS, { recursive: true })
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=90:size=640x360:rate=30',
      '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', '-movflags', '+faststart', path.join(DL_DIR, VIDEO)])

    server = spawn(process.execPath, ['src/index.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT), VD_DATA_DIR: DATA_DIR, VD_DOWNLOADS_DIR: path.join(DATA_DIR, 'downloads') },
      stdio: 'ignore',
    })
    if (!(await waitReady())) throw new Error('隔离实例未就绪')

    const { chromium, devices } = await import('playwright-core')
    browser = await chromium.launch()
    const ctx = await browser.newContext({ ...devices['iPhone 14'] })
    const page = await ctx.newPage()
    const cdp = await ctx.newCDPSession(page)
    page.on('pageerror', (e) => { findings['页面错误'] = String((e && e.message) || e) })
    await loginAndOpen(page)
    await installProbe(page)

    let st = await stateEval(page)
    findings['开场处于内联态'] = st.fs === false && st.hidden === false

    // 双击点 = 视频元素中心（与用户实际点击画面一致）
    const vc = () => page.evaluate(() => {
      const r = document.getElementById('inlinePlayerVideo').getBoundingClientRect()
      return { x: Math.round((r.left + r.right) / 2), y: Math.round((r.top + r.bottom) / 2) }
    })
    const C0 = await vc()
    await doubleTap(cdp, C0.x, C0.y)
    st = await stateEval(page)
    trace.enterFs = { fs: st.fs, hidden: st.hidden, parent: st.parent, cls: st.cls, center: C0 }
    findings['可进入全屏（双击画面，fs class 且节点迁到 body）'] = st.fs === true && st.parent === 'BODY'
    findings['进全屏后为「全屏」档（contain）'] = st.fs === true && st.objectFit === 'contain'
    // 自绘控制条：全屏时必须关掉原生 controls（它的控件带会吞掉双指），改用自绘控件
    const ctlProbe = await page.evaluate(() => {
      const v = document.getElementById('inlinePlayerVideo')
      const ctl = document.querySelector('#inlinePlayer .pg-ctl')
      const track = document.querySelector('#inlinePlayer .pg-ctl-track')
      if (!ctl || !track) return { ok: false, why: 'no-ctl' }
      const r = track.getBoundingClientRect()
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return {
        nativeControls: v.controls,
        on: ctl.classList.contains('on'),
        opacity: Number(getComputedStyle(ctl).opacity),
        trackHits: !!(hit && track.contains(hit)),
        trackW: Math.round(r.width),
      }
    })
    findings['全屏时原生 controls 关闭（自绘控件接管）'] = ctlProbe.nativeControls === false
    findings['全屏自绘控制条可见且进度条可点'] = ctlProbe.on && ctlProbe.opacity > 0.5 && ctlProbe.trackHits && ctlProbe.trackW > 60
    trace.ctlProbe = ctlProbe
    if (!st.fs) {
      console.log('== 双击未能进入全屏，中止落点矩阵 ==')
      console.log('  state=' + JSON.stringify(trace.enterFs))
      console.log('REPRO_RESULT=' + JSON.stringify({ findings, trace, defectReproduced: true, shots: SHOTS }))
      process.exitCode = 0
      return
    }

    // ── 落点矩阵：全屏下双指外扩（每次先回 contain 档）──
    const C = { x: st.vw / 2, y: st.vh / 2 }
    const matrix = [
      { key: 'center', label: '中心', at: { x: st.vw / 2, y: st.vh / 2 }, axis: 'h' },
      { key: 'lower', label: '偏下', at: { x: st.vw / 2, y: st.vh * 0.78 }, axis: 'h' },
      { key: 'bottomBand', label: '底部控制带', at: { x: st.vw / 2, y: st.vh - 44 }, axis: 'h' },
      { key: 'top', label: '顶部', at: { x: st.vw / 2, y: 120 }, axis: 'h' },
      { key: 'vertical', label: '竖直分布', at: { x: st.vw / 2, y: st.vh / 2 }, axis: 'v' },
    ]
    for (const m of matrix) {
      let cur = await stateEval(page)
      if (cur.fill) { await pinch(cdp, C, 140, 60); cur = await stateEval(page) }
      await resetProbe(page)
      await pinch(cdp, m.at, 60, 150, m.axis)
      const after = await stateEval(page)
      const probe = await readProbe(page)
      trace[m.key] = {
        downs: probe.downs.length,
        ups: probe.ups.length,
        targets: probe.downs.map((d) => d.id || d.tag),
        ys: probe.downs.map((d) => d.y),
        moved: probe.moves,
        fill: after.fill,
        objectFit: after.objectFit,
      }
      findings[`全屏外扩生效：${m.label}`] = after.fill === true && after.objectFit === 'cover'
    }
    await page.screenshot({ path: SHOTS + '/1-after-matrix.png' })

    // ── 路径 6：单指点击唤出原生控件后再外扩（用户真实操作：先点屏幕）──
    let cur = await stateEval(page)
    if (cur.fill) { await pinch(cdp, C, 140, 60); cur = await stateEval(page) }
    await tap(page, C.x, C.y)
    await installProbe(page)
    await resetProbe(page)
    await pinch(cdp, C, 60, 150)
    const afterTapPinch = await stateEval(page)
    const tapProbe = await readProbe(page)
    trace.afterTap = { downs: tapProbe.downs.length, targets: tapProbe.downs.map((d) => d.id || d.tag), fill: afterTapPinch.fill }
    findings['点击唤出控件后外扩生效'] = afterTapPinch.fill === true

    // ── 收拢回全屏档（方向正确性）──
    await pinch(cdp, C, 140, 60)
    const afterCollapse = await stateEval(page)
    findings['收拢 → 回到全屏档且仍全屏'] = afterCollapse.fs === true && afterCollapse.objectFit === 'contain'
    await page.screenshot({ path: SHOTS + '/2-after-collapse.png' })

    // ── 退出全屏（close 图标），再测内联双指外扩（规格：内联不响应缩放）──
    const pt = await page.evaluate(() => {
      const b = document.querySelector('#inlinePlayer .inline-player-close')
      const r = b.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })
    await page.mouse.click(pt.x, pt.y)
    await sleep(260)
    const afterExit = await stateEval(page)
    const C1 = await vc()
    await resetProbe(page)
    await pinch(cdp, C1, 60, 150)
    const inlineAfter = await stateEval(page)
    const inlineProbe = await readProbe(page)
    trace.inline = { downs: inlineProbe.downs.length, targets: inlineProbe.downs.map((d) => d.id || d.tag), fs: inlineAfter.fs, fill: inlineAfter.fill }
    findings['内联双指外扩 → 进入全屏并落在铺满档'] = inlineAfter.fs === true && inlineAfter.fill === true && inlineAfter.objectFit === 'cover'
    findings['内联双指后播放器仍打开（未被手势误关）'] = inlineAfter.hidden === false
    await page.screenshot({ path: SHOTS + '/3-after-exit.png' })

    for (const [k, v] of Object.entries(findings)) console.log(`  ${v ? '✅ 是' : '⚠️ 否'}  ${k}`)
    console.log('\n== 探针 ==')
    for (const [k, v] of Object.entries(trace)) console.log(`  ${k.padEnd(11)} ${JSON.stringify(v)}`)
    const broken = Object.entries(findings).filter(([k, v]) => k.startsWith('全屏外扩生效：') && v === false).map(([k]) => k.replace('全屏外扩生效：', ''))
    const defectReproduced = broken.length > 0
      || findings['进全屏后为「全屏」档（contain）'] === false
      || findings['全屏时原生 controls 关闭（自绘控件接管）'] === false
      || findings['全屏自绘控制条可见且进度条可点'] === false
      || findings['收拢 → 回到全屏档且仍全屏'] === false
      || findings['点击唤出控件后外扩生效'] === false
      || findings['内联双指外扩 → 进入全屏并落在铺满档'] === false
    console.log(`\n未生效落点: ${broken.length ? broken.join('、') : '无'}`)
    console.log(`缺陷复现: ${defectReproduced ? '是' : '否'}`)
    console.log('REPRO_RESULT=' + JSON.stringify({ findings, trace, defectReproduced, shots: SHOTS }))
    process.exitCode = 0
  } finally {
    try { if (browser) await browser.close() } catch { /* noop */ }
    try { if (server) server.kill('SIGTERM') } catch { /* noop */ }
  }
}

main().catch((err) => {
  console.error('复现脚本失败：', err)
  process.exitCode = 1
})
