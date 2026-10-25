#!/usr/bin/env node
/**
 * repro-pinch-round3.mjs — 双指缩放三缺陷真实复现（修复前 / 修复后同一脚本）
 *
 * 用户反馈（第 6 轮）：
 *   R1 档位不清：要求两档（铺满全屏 / 全屏），实际有第三档（跟手中的连续百分比）。
 *   R2 从铺满档「缩一下」直接退出全屏（期望只回到全屏档，退出全屏走图标）。
 *   R3 撑满全屏后单指点击屏幕看不到进度条等控件（疑似随画面一起被放大撑出视口）。
 *
 * 真实路径：隔离实例（ffmpeg 生成 90s 视频）→ iPhone 14 视口 → 登录 → 播放
 *          → CDP Input.dispatchTouchEvent 派发双指捏合 → DOM 几何/class 采样断言。
 *
 * 输出：REPRO_RESULT={...} + 「缺陷复现: 是/否」
 */
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 3205
const DATA_DIR = '/tmp/vd-pg-repro3'
const DL_DIR = path.join(DATA_DIR, 'downloads', 'wilsonwen')
const BASE = `http://localhost:${PORT}`
const VIDEO = 'repro-pinch.mp4'
const SHOTS = '/tmp/vd-pg-repro3-shots'
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

/** 采样：全屏态 / 铺满态(class) / video 元素盒几何 / 内容矩形 / 控件可见性 / 指示条 */
function stateEval(page, boxId, videoId) {
  return page.evaluate(([boxId, videoId]) => {
    const box = document.getElementById(boxId)
    const v = document.getElementById(videoId)
    if (!box || !v) return null
    const r = v.getBoundingClientRect()
    const tr = getComputedStyle(v).transform
    let sx = 1
    if (tr && tr !== 'none') sx = new DOMMatrixReadOnly(tr).a
    const bar = box.querySelector('.inline-player-bar')
    const barCs = bar ? getComputedStyle(bar) : null
    const barRect = bar ? bar.getBoundingClientRect() : null
    const vw = v.videoWidth || 16, vh = v.videoHeight || 9
    // 内容矩形（含 object-fit）：contain/cover 下的实际画面区域
    const fit = getComputedStyle(v).objectFit
    let cW, cH
    if (fit === 'cover') {
      const s = Math.max(r.width / vw, r.height / vh)
      cW = vw * s; cH = vh * s
    } else {
      const s = Math.min(r.width / vw, r.height / vh)
      cW = vw * s; cH = vh * s
    }
    const cl = r.left + (r.width - cW) / 2, ct = r.top + (r.height - cH) / 2
    const pill = box.querySelector('.pg-pill')
    return {
      fs: box.classList.contains('fs'),
      fill: box.classList.contains('fill'),
      boxVisible: !box.hidden,
      parentIsBody: box.parentElement === document.body,
      objectFit: fit,
      sx,
      el: { top: r.top, bottom: r.bottom, height: r.height, left: r.left, right: r.right },
      content: { top: ct, bottom: ct + cH, left: cl, right: cl + cW },
      coversViewport: r.left <= 1 && r.top <= 1 && r.right >= innerWidth - 1 && r.bottom >= innerHeight - 1,
      contentCoversViewport: cl <= 1 && ct <= 1 && cl + cW >= innerWidth - 1 && ct + cH >= innerHeight - 1,
      // 控件可见性：bar 是否渲染 + 是否在视口内
      barDisplay: barCs ? barCs.display : 'missing',
      barVisible: !!(barCs && barCs.display !== 'none' && barRect && barRect.height > 0 && barRect.bottom > 0 && barRect.top < innerHeight),
      barRect: barRect ? { top: barRect.top, bottom: barRect.bottom, height: barRect.height } : null,
      // 元素盒是否溢出视口（溢出的部分包含 UA 原生控件 → 点不到）
      elOverflowTop: r.top < -1,
      elOverflowBottom: r.bottom > innerHeight + 1,
      pillText: pill ? pill.textContent : '',
      t: v.currentTime,
      vw: innerWidth, vh: innerHeight,
    }
  }, [boxId, videoId])
}

async function pinch(cdp, cx, cy, spreadStart, spreadEnd, onStep) {
  const pts = (d) => [{ x: cx - d, y: cy }, { x: cx + d, y: cy }]
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(spreadStart) })
  const steps = 14
  for (let i = 1; i <= steps; i++) {
    const d = spreadStart + (spreadEnd - spreadStart) * i / steps
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(d) })
    if (onStep) await onStep()
    await sleep(16)
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await sleep(180)
}

/** 单指点击：用真实鼠标事件（Chromium 的原生 controls 显隐由 mouse 交互驱动，CDP touch 不触发显示） */
async function tap(page, x, y) {
  await page.mouse.move(x, y)
  await sleep(100)
  await page.mouse.down()
  await sleep(60)
  await page.mouse.up()
  await sleep(600)
}

async function doubleTap(cdp, x, y) {
  for (let i = 0; i < 2; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await sleep(90)
  }
  await sleep(160)
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
    await loginAndOpen(page)

    const vc = () => page.evaluate(() => {
      const r = document.getElementById('inlinePlayerVideo').getBoundingClientRect()
      return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 }
    })
    const C = await vc()

    // ── 阶段 1：内联（非全屏）双指外扩 —— 旧行为进入全屏并跟手放大；新规格不响应缩放 ──
    const samplesInline = []
    await pinch(cdp, C.x, C.y, 60, 140, async () => { samplesInline.push((await stateEval(page, 'inlinePlayer', 'inlinePlayerVideo')).sx) })
    let st = await stateEval(page, 'inlinePlayer', 'inlinePlayerVideo')
    findings['内联双指外扩进入全屏（第 7 轮起允许：任何状态都能放大到满屏）'] = st.fs === true

    // 进入全屏：修复前双指外扩已进入；修复后走双击（与顶部图标等价的全屏入口）
    if (!st.fs) { await doubleTap(cdp, C.x, C.y); st = await stateEval(page, 'inlinePlayer', 'inlinePlayerVideo') }
    findings['可进入全屏（双击/顶部图标入口）'] = st.fs === true

    // ── 阶段 2：全屏下双指外扩 → 铺满档 ──
    const samplesFs = []
    await pinch(cdp, C.x, C.y, 60, 140, async () => { samplesFs.push((await stateEval(page, 'inlinePlayer', 'inlinePlayerVideo')).sx) })
    const afterExpand = await stateEval(page, 'inlinePlayer', 'inlinePlayerVideo')

    // ── R1：档位只有两态（contain ↔ cover），无连续缩放中间档 ──
    const samples = [...samplesInline, ...samplesFs]
    const mid = samples.filter((s) => s > 1.02 || s < 0.98)
    findings['存在连续缩放的中间档（缺陷）'] = mid.length > 0
    findings['铺满档实现方式'] = afterExpand.objectFit === 'cover' ? 'object-fit: cover' : `transform: scale(${afterExpand.sx.toFixed(2)})`
    findings['外扩后进入铺满档（cover）'] = afterExpand.objectFit === 'cover' && afterExpand.fill === true

    // ── R3：撑满后控件是否可见（原生控件随 video 元素盒放大溢出视口）──
    findings['R3 撑满后 video 元素盒溢出视口（控件被撑出）'] = afterExpand.elOverflowTop || afterExpand.elOverflowBottom
    findings['R3 撑满后顶部控件栏可见'] = afterExpand.barVisible
    await page.screenshot({ path: SHOTS + '/1-fill.png' })

    // ── 单指点击画面中央后，检查是否有可点的控件区域（底部控制条 / 顶部栏）──
    await tap(page, C.x, afterExpand.vh * 0.5)
    const afterTap = await page.evaluate(() => {
      const box = document.getElementById('inlinePlayer')
      const v = document.getElementById('inlinePlayerVideo')
      const vr = v.getBoundingClientRect()
      const bar = box.querySelector('.inline-player-bar')
      const br = bar ? bar.getBoundingClientRect() : null
      // 底部 30px 带是否还有 video 元素自身的可见区域（原生控件绘制在其内）
      const bottomInView = vr.bottom <= innerHeight + 1 && vr.top >= -1
      // 底部控制条带（video 底部 56px）命中的元素必须是 video 本身 —— 控件区没被放大/裁切出视口
      const hit = document.elementFromPoint(innerWidth / 2, innerHeight - 28)
      return {
        bottomInView,
        barHit: !!(br && br.height > 0 && br.bottom > 0),
        bottomHitsVideo: hit === v,
        videoRect: { top: vr.top, bottom: vr.bottom, h: vr.height },
      }
    })
    findings['R3 点击后底部控制条在视口内'] = afterTap.bottomInView
    findings['R3 点击后底部控制区命中 video（可点）'] = afterTap.bottomHitsVideo
    findings['R3 点击后顶部按钮栏命中'] = afterTap.barHit
    await page.screenshot({ path: SHOTS + '/2-after-tap.png' })

    // ── R2：全屏铺满档收拢 → 是否被缩放手势退出全屏（用户要求只降档，不退出）──
    await pinch(cdp, C.x, C.y, 120, 70) // 轻收拢（约 -42%）
    st = await stateEval(page, 'inlinePlayer', 'inlinePlayerVideo')
    findings['R2 轻收拢后回到全屏档（非铺满）且仍全屏'] = st.fs === true && st.objectFit === 'contain'

    await pinch(cdp, C.x, C.y, 120, 40) // 大幅收拢（约 -67%）→ 修复前会 collapsed → 退出全屏
    const st2 = await stateEval(page, 'inlinePlayer', 'inlinePlayerVideo')
    findings['R2 大幅收拢被缩放手势退出全屏（缺陷）'] = st2.fs === false
    await page.screenshot({ path: SHOTS + '/3-after-collapse.png' })

    // ── 全屏时图标可退出全屏（close 语义：全屏→回内联，非全屏→关闭播放）──
    findings['全屏时存在可点的退出/关闭图标'] = st.barVisible === true
    let exitByIcon = null
    if (st2.fs) {
      const pt = await page.evaluate(() => {
        const b = document.querySelector('#inlinePlayer .inline-player-close')
        const r = b.getBoundingClientRect()
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
      })
      await page.mouse.click(pt.x, pt.y)
      await sleep(200)
      exitByIcon = await stateEval(page, 'inlinePlayer', 'inlinePlayerVideo')
    }
    findings['全屏点 close 图标 → 退出全屏且播放器仍打开'] = !!(exitByIcon && exitByIcon.fs === false && exitByIcon.boxVisible === true)

    console.log('\n== 采样 scale 序列 ==')
    console.log('  ' + samples.map((s) => s.toFixed(2)).join(', '))
    console.log('\n== 判定 ==')
    for (const [k, v] of Object.entries(findings)) console.log(`  ${v ? '⚠️ 是' : '✅ 否'}  ${k}`)
    const defectReproduced = findings['存在连续缩放的中间档（缺陷）']
      || findings['R2 大幅收拢被缩放手势退出全屏（缺陷）'] === true
      || findings['R3 撑满后 video 元素盒溢出视口（控件被撑出）'] === true
      || findings['全屏时存在可点的退出/关闭图标'] === false
      || findings['全屏点 close 图标 → 退出全屏且播放器仍打开'] === false
    console.log(`\n缺陷复现: ${defectReproduced ? '是' : '否'}`)
    console.log('REPRO_RESULT=' + JSON.stringify({ findings, samples: samples.map((s) => +s.toFixed(3)), defectReproduced, shots: SHOTS }))
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
