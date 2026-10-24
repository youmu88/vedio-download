#!/usr/bin/env node
/**
 * repro-round2.mjs — 第 2 轮反馈缺陷复现（取证脚本）
 *
 * 复现：
 *   R1 全屏铺满档「底部满、顶部黑边」：测量视频【内容矩形】（object-fit contain 后）四边覆盖情况，
 *      以及标题栏在全屏态是否仍占文档流高度
 *   R2 单指误触发缩放：静态审查 onDown 的指针簿记（幽灵指针残留 → pointers.size 假性为 2 → 误入 pinch）
 *
 * 输出几何数据供修复前后对照。
 */
import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 3203
const DATA_DIR = '/tmp/vd-repro-r2'
const DL_DIR = path.join(DATA_DIR, 'downloads', 'wilsonwen')
const BASE = `http://localhost:${PORT}`
const VIDEO = 'gesture-test.mp4'
const SHOTS = '/tmp/vd-r2-shots'

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

/** 全屏几何：元素盒 rect / 内容矩形（object-fit contain）/ 标题栏 */
function geometryEval(page) {
  return page.evaluate(() => {
    const box = document.getElementById('inlinePlayer');
    const v = document.getElementById('inlinePlayerVideo');
    const bar = box.querySelector('.inline-player-bar');
    const br = bar ? bar.getBoundingClientRect() : null;
    const r = v.getBoundingClientRect();
    const tr = getComputedStyle(v).transform;
    let sx = 1;
    if (tr && tr !== 'none') sx = new DOMMatrixReadOnly(tr).a;
    const vw = v.videoWidth || 16, vh = v.videoHeight || 9;
    // 内容矩形：object-fit contain 后的实际画面区域（元素盒矩形内居中）
    const contentW = Math.min(r.width, r.height * vw / vh);
    const contentH = Math.min(r.height, r.width * vh / vw);
    const contentLeft = r.left + (r.width - contentW) / 2;
    const contentTop = r.top + (r.height - contentH) / 2;
    return {
      fs: box.classList.contains('fs'),
      sx,
      boxRect: { top: box.getBoundingClientRect().top, height: box.getBoundingClientRect().height },
      barHeight: br ? br.height : 0,
      barDisplay: bar ? getComputedStyle(bar).display : 'none',
      videoRect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height },
      content: { left: contentLeft, top: contentTop, right: contentLeft + contentW, bottom: contentTop + contentH, width: contentW, height: contentH },
      vw: innerWidth, vh: innerHeight,
      videoOffset: { w: v.offsetWidth, h: v.offsetHeight },
      videoNat: { w: v.videoWidth, h: v.videoHeight },
    };
  });
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

async function main() {
  try {
    rmSync(DATA_DIR, { recursive: true, force: true })
    mkdirSync(DL_DIR, { recursive: true })
    mkdirSync(SHOTS, { recursive: true })
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

    // 进入全屏铺满档
    await pinch(cdp, vc.x, vc.y, 40, 130)
    await page.waitForFunction(() => {
      const v = document.getElementById('inlinePlayerVideo')
      const tr = getComputedStyle(v).transform
      return tr && tr !== 'none' && !v.style.transition
    }, null, { timeout: 2500 }).catch(() => {})
    await sleep(400)

    const g = await geometryEval(page)
    await page.screenshot({ path: SHOTS + '/r2-fullscreen-cover-fixed.png' })
    const r1Repro = g.fs && g.content.top > 1 // 内容顶部未到视口顶 = 顶部黑边
    console.log('══ R1 全屏铺满档几何 ══')
    console.log(`  fs=${g.fs} sx=${g.sx.toFixed(3)} 视口=${g.vw}x${g.vh}`)
    console.log(`  标题栏: display=${g.barDisplay} height=${g.barHeight.toFixed(1)}px`)
    console.log(`  video 元素盒: top=${g.videoRect.top.toFixed(1)} height=${g.videoRect.height.toFixed(1)} offset=${g.videoOffset.w}x${g.videoOffset.h}`)
    console.log(`  内容矩形: left=${g.content.left.toFixed(1)} top=${g.content.top.toFixed(1)} right=${g.content.right.toFixed(1)} bottom=${g.content.bottom.toFixed(1)}`)
    console.log(`  内容覆盖: 上=${g.content.top <= 1 ? '满' : '黑边' + g.content.top.toFixed(0) + 'px'} 下=${g.content.bottom >= g.vh - 1 ? '满' : '缺'} 左=${g.content.left <= 1 ? '满' : '缺'} 右=${g.content.right >= g.vw - 1 ? '满' : '缺'}`)
    console.log(`  → 缺陷 R1 复现: ${r1Repro ? '是（顶部黑边 ' + g.content.top.toFixed(0) + 'px）' : '否'}`)

    // 继续外扩：检查是否还会继续放大（用户期望固定两档）
    await page.evaluate(() => { document.getElementById('inlinePlayerVideo').style.transition = '' })
    await pinch(cdp, vc.x, vc.y, 40, 190)
    await sleep(400)
    const g2 = await geometryEval(page)
    await page.screenshot({ path: SHOTS + '/r2-overexpand-fixed.png' })
    const r2Repro = g2.sx > g.sx + 0.05 // 超过铺满档继续放大 = 三档行为
    console.log('══ R2 已铺满后继续外扩 ══')
    console.log(`  外扩前 sx=${g.sx.toFixed(3)} → 外扩后 sx=${g2.sx.toFixed(3)}`)
    console.log(`  → 缺陷 R2 复现: ${r2Repro ? '是（仍有放大档，继续放大）' : '否（固定两档）'}`)

    // R3 幽灵指针：静态审查（onDown 是否有 isPrimary 清理）
    const hasGhostFix = await page.evaluate(async () => {
      const txt = await fetch('/js/player-gestures.js').then(r => r.text())
      return { isPrimaryCleanup: /e\.isPrimary\s*&&\s*st\.pointers\.size/.test(txt) }
    })
    console.log('══ R3 幽灵指针清理 ══')
    console.log(`  onDown 含 isPrimary 残留清理: ${hasGhostFix.isPrimaryCleanup ? '有' : '无'}`)
    console.log(`  → 缺陷 R3 复现: ${hasGhostFix.isPrimaryCleanup ? '否' : '是（旧触摸序列残留指针可致单指误入 pinch 缩放）'}`)

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
