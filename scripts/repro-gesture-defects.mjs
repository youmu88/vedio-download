#!/usr/bin/env node
/**
 * repro-gesture-defects.mjs — 用户反馈缺陷的真实复现（取证脚本）
 *
 * 复现 4 个缺陷（均以 CDP Input.dispatchTouchEvent 派发真实触摸序列）：
 *   S1 双指外扩中途松手 → 期望「自动按屏幕比例铺满」，实际吸附回 1x（放大没反应）
 *   S2 全屏放大态（铺满档）单指横滑 → 期望快进 ±15s，实际被平移模式吞掉（快进失灵）
 *   S3 铺满档双指轻收拢 → 期望回 1x 默认态，实际最近档吸附留在铺满档（缩小没反应）
 *   S4 Safari 桌面 gesturechange 绝对倍数被当相对倍率 → 复合放大 2.4x（应为 1.6x）
 *
 * 判定：每项输出「缺陷复现: 是/否」，缺陷复现=是 即当前实现存在问题。
 */
import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 3202
const DATA_DIR = '/tmp/vd-repro-gd'
const DL_DIR = path.join(DATA_DIR, 'downloads', 'wilsonwen')
const BASE = `http://localhost:${PORT}`
const VIDEO = 'gesture-test.mp4'

let server = null
let browser = null
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function waitReady() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + '/api/health')).ok) return true } catch {}
    await sleep(300)
  }
  return false
}

function stateEval(page) {
  return page.evaluate(() => {
    const box = document.getElementById('inlinePlayer');
    const v = document.getElementById('inlinePlayerVideo');
    if (!box || !v) return null;
    const r = v.getBoundingClientRect();
    const tr = getComputedStyle(v).transform;
    let sx = 1, sy = 1, tx = 0, ty = 0;
    if (tr && tr !== 'none') { const m = new DOMMatrixReadOnly(tr); sx = m.a; sy = m.d; tx = m.e; ty = m.f; }
    const W = r.width / sx, H = r.height / sy;
    const vw = v.videoWidth || 16, vh = v.videoHeight || 9;
    const cw = Math.min(W, vw * H / vh), ch = Math.min(H, vh * W / vw);
    return {
      fs: box.classList.contains('fs'),
      sx, sy, tx, ty,
      coverScale: Math.max(innerWidth / cw, innerHeight / ch),
      t: v.currentTime,
    };
  });
}

/** 等吸附动画结束（transition 清除后采样稳定 scale） */
async function settled(page) {
  await page.waitForFunction(() => {
    const v = document.getElementById('inlinePlayerVideo')
    return !v.style.transition
  }, null, { timeout: 1500 }).catch(() => {})
  await sleep(320)
}

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
  await sleep(150)
}

async function drag(cdp, x, y, dx, dy, { steps = 8, stepMs = 16 } = {}) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx * i / steps, y: y + dy * i / steps }] })
    await sleep(stepMs)
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await sleep(60)
}

async function doubleTap(cdp, x, y) {
  for (let i = 0; i < 2; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await sleep(90)
  }
}

async function main() {
  try {
    rmSync(DATA_DIR, { recursive: true, force: true })
    mkdirSync(DL_DIR, { recursive: true })
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=90:size=640x360:rate=30',
      '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', '-movflags', '+faststart', path.join(DL_DIR, VIDEO)])

    server = spawn(process.execPath, ['src/index.js'], {
      cwd: ROOT, env: { ...process.env, PORT: String(PORT), VD_DATA_DIR: DATA_DIR, VD_DOWNLOADS_DIR: path.join(DATA_DIR, 'downloads') }, stdio: 'ignore',
    })
    if (!(await waitReady())) throw new Error('隔离实例未就绪')

    const { chromium, devices } = await import('playwright-core')
    browser = await chromium.launch()
    const ctx = await browser.newContext({ ...devices['iPhone 14'] })
    const page = await ctx.newPage()
    const cdp = await ctx.newCDPSession(page)

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

    const vc = await page.evaluate(() => { const r = document.getElementById('inlinePlayerVideo').getBoundingClientRect(); return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 } })

    // ═══ S1: 双指外扩中途松手（scale≈1.3，明确外扩意图但未到铺满）═══
    await pinch(cdp, vc.x, vc.y, 40, 52) // 起距80 → 终距104：scale≈1.3，过全屏阈值
    await settled(page)
    let st = await stateEval(page)
    const s1Repro = st.fs && st.sx < st.coverScale * 0.55 // 卡在/回到 1x 附近 = 放大没反应（期望 sx≈coverScale）
    console.log(`S1 外扩中途松手: fs=${st.fs} sx=${st.sx.toFixed(3)} cover=${st.coverScale.toFixed(3)} → 缺陷复现: ${s1Repro ? '是（吸回1x，未铺满）' : '否'}`)
    await doubleTap(cdp, vc.x, vc.y) // 退出全屏复位
    await sleep(150)

    // ═══ S2: 全屏铺满档单指横滑 → 快进失灵 ═══
    await pinch(cdp, vc.x, vc.y, 40, 130) // 外扩进全屏，松手吸附铺满档
    await settled(page)
    st = await stateEval(page)
    const atCover = st.fs && Math.abs(st.sx - st.coverScale) < 0.06
    await page.evaluate(() => { const v = document.getElementById('inlinePlayerVideo'); v.pause(); v.currentTime = 30 })
    await drag(cdp, vc.x, vc.y, 80, 0)
    st = await stateEval(page)
    const s2Repro = atCover && Math.abs(st.t - 30) < 1 // t 没动 = 快进被平移模式吞掉
    console.log(`S2 铺满档横滑快进: atCover=${atCover} t=${st.t.toFixed(2)}（期望45） → 缺陷复现: ${s2Repro ? '是（快进失灵）' : '否'}`)

    // ═══ S3: 铺满档双指轻收拢（scale≈cover×0.9）→ 期望回 1x 默认态 ═══
    await pinch(cdp, vc.x, vc.y, 165, 148) // 起距330→终距296：scale≈cover×0.897
    await settled(page)
    st = await stateEval(page)
    const s3Repro = st.fs && Math.abs(st.sx - st.coverScale) < 0.06 // 留在铺满档 = 缩小没反应（期望 sx≈1）
    console.log(`S3 铺满档轻收拢: sx=${st.sx.toFixed(3)} cover=${st.coverScale.toFixed(3)} tx=${st.tx.toFixed(1)} ty=${st.ty.toFixed(1)} → 缺陷复现: ${s3Repro ? '是（停在铺满档未回1x）' : '否'}`)
    await doubleTap(cdp, vc.x, vc.y) // 退出全屏复位
    await sleep(150)

    // ═══ S4: Safari 桌面 gesturechange 倍率复合放大 ═══
    await page.evaluate(() => {
      const v = document.getElementById('inlinePlayerVideo')
      const mk = (type, scale) => { const e = new Event(type, { cancelable: true, bubbles: true }); e.scale = scale; v.dispatchEvent(e) }
      mk('gesturestart', 1)
      mk('gesturechange', 1.5)
      mk('gesturechange', 1.6) // 连续手势：绝对倍数应始终相对起手（期望 scale=1.6）
    })
    await sleep(120)
    st = await stateEval(page)
    const s4Repro = Math.abs(st.sx - 1.6) > 0.08 // 偏离 1.6 即复合放大缺陷
    console.log(`S4 gesture连续手势: sx=${st.sx.toFixed(3)}（期望1.6） → 缺陷复现: ${s4Repro ? '是（倍率复合放大）' : '否'}`)

    // ═══ S5: 捏合中途抬一指，剩余指继续横滑 ═══
    await page.evaluate(() => { document.getElementById('inlinePlayerVideo').pause(); document.getElementById('inlinePlayerVideo').currentTime = 30 })
    // 双指落下半距40，微扩到44后抬一指，剩余指右移100px
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: vc.x - 40, y: vc.y }, { x: vc.x + 40, y: vc.y }] })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: vc.x - 44, y: vc.y }, { x: vc.x + 44, y: vc.y }] })
    await sleep(60)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [{ x: vc.x + 44, y: vc.y }] })
    await sleep(60)
    for (let i = 1; i <= 6; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: vc.x + 44 + 100 * i / 6, y: vc.y }] })
      await sleep(20)
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await sleep(120)
    st = await stateEval(page)
    const delta = st.t - 30
    const s5Info = `Δt=${delta.toFixed(2)}s（抬指后横滑位移从旧基准起算，可能误多步跳秒）`
    console.log(`S5 捏合中途抬指剩余指横滑: ${s5Info} → ${Math.abs(delta) > 15.5 ? '缺陷复现: 是（误多步跳秒）' : '观察项: 跳秒在单步内'}`)

    await ctx.close()
  } catch (err) {
    console.error('💥 复现执行失败：', err)
    process.exitCode = 1
  } finally {
    try { if (browser) await browser.close() } catch {}
    try { if (server) server.kill() } catch {}
  }
}

main()
