/**
 * PlayerGestures — 播放器手势层 + 全屏自绘控制条（ios.js / macos.js 共用）
 *
 * 能力：
 *   1. 双指捏合切换「两档显示模式」：
 *      全屏（object-fit: contain，上下黑边） ↔ 铺满全屏（object-fit: cover，零黑边、长边裁切）。
 *      · 全屏内：外扩 → 铺满；收拢 → 全屏；继续收拢仍保持全屏——手势永不退出全屏。
 *      · 内联（卡片）：外扩 → 直接进入全屏并落在铺满档（用户第 7 轮诉求：任何状态都能放大到满屏）；
 *        收拢不做任何事（退出全屏只走顶部图标，见第 6 轮规格）。
 *      缩放只改 object-fit，从不 transform，因此没有中间档、画面不会被放大出屏。
 *   2. 横滑快进/快退：视频面单指横滑（|dx|>|dy| 激活），每 64px 一步 ±15 秒。
 *   3. 双击切换全屏；单击切换全屏控制条显隐。
 *   4. 全屏自绘控制条（播放/暂停 + 进度条可拖动 + 时间）：见下方「为什么自绘」。
 *
 * 为什么自绘控制条（第 7 轮根因）：
 *   `<video controls>` 的原生控件层会吞掉落在控件带上的触摸——实测（CDP 真实双指 + 页面 pointer 探针）
 *   底部 56px 带内「控件显示时 0 指到达页面、控件隐藏时仅 1 指到达」，双指永远凑不齐 → 全屏双指失效。
 *   这是浏览器内部行为，页面侧无法绕过。全屏时关闭原生 controls、改用自绘控件后，同一位置 2 指全部到达。
 *   顺带解决第 6 轮的诉求：自绘进度条不随画面缩放，永不出屏、始终可点。
 *
 * 为什么不用 transform: scale：
 *   原生控件在 UA 影子 DOM 内，transform 会连控件一起放大（640x360 视频铺满 390x844 需 3.0x），
 *   控件被推出视口；scale 又是连续量，产生用户感知的「第三档」。object-fit 只有 contain / cover 两态。
 *
 * 关键设计：
 *   - 全屏用 CSS 固定浮层（.fs）+ 播放器节点临时迁移到 body：iPhone Safari 无 Element.requestFullscreen。
 *   - 手势监听挂在容器（box）的捕获阶段：即使事件目标是 video 或控制条，也先经过手势层判定；
 *     落在自绘控制条上的指针直接放行（按钮 click / 进度条拖动由控件自己处理）。
 *   - 底部 56px 保护区只约束「单指横滑 seek」（避免与进度条拖动抢），双指捏合不受任何落点限制。
 *   - Pointer Events 统一触摸/鼠标/触控笔；另挂 Safari 桌面 gesture 与 ctrl/cmd+wheel（触控板捏合语义）。
 *   - 起手 x<28px 的非全屏触摸不认领：让位 ios.js 全局左缘返回手势；全屏时系统返回已被 canIosBack 拦住。
 *   - 生命周期自管理：监听 'emptied'（PlayerCore 切换/关闭时 removeAttribute+load 必触发）
 *     → 退出全屏、清档位、节点归位、恢复原生控件。
 *   - 直播流（duration 无穷）禁用 seek 与进度条拖动，保留切档。
 */
window.PlayerGestures = (() => {
  const SEEK_STEP_PX = 64;       // 每步快进/快退的横滑距离
  const SEEK_STEP_SEC = 15;      // 每步秒数（需求：右滑快进 / 左滑快退 15 秒）
  const DRAG_ACTIVATE = 18;      // seek 激活位移阈值
  const TAP_SLOP = 10;           // 点按位移容差
  const DBL_TAP_MS = 320;        // 双击间隔
  const EDGE_YIELD_PX = 28;      // 与 ios.js 左缘返回手势的起手带宽一致，让位系统手势
  const CONTROL_GUARD = 56;      // 底部控制条保护区（只约束单指 seek，不约束双指）
  const PINCH_SWITCH_RATIO = 1.08;   // 全屏内双指间距相对基准 ±8% → 切档（切档后重设基准，天然防抖）
  const PINCH_ENTER_RATIO = 1.15;    // 内联双指外扩 15% → 进入全屏并铺满
  const WHEEL_SWITCH_ACC = 120;      // 桌面触控板捏合累计 deltaY → 切档
  const GESTURE_SWITCH_RATIO = 1.06; // Safari gesture e.scale 相对 gesturestart → 切档
  const CTL_HIDE_MS = 3500;          // 控制条自动隐藏延时

  const ICON = {
    ff: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 5.5v13l7.5-6.5L4 5.5zm8.5 0v13L20 12l-7.5-6.5z" fill="currentColor"/></svg>',
    rew: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 5.5v13L12.5 12 20 5.5zm-8.5 0v13L4 12l7.5-6.5z" fill="currentColor"/></svg>',
    play: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M8 5.5v13L19 12 8 5.5z" fill="currentColor"/></svg>',
    pause: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7.5 5.5h3.2v13H7.5zM13.3 5.5h3.2v13h-3.2z" fill="currentColor"/></svg>',
  };

  const STYLES = `
.pg-pill { position: absolute; left: 50%; top: 44%; transform: translate(-50%, -50%); z-index: 5; pointer-events: none; display: flex; align-items: center; gap: 7px; padding: 9px 16px; border-radius: 999px; background: rgba(20,20,22,0.72); color: #fff; font-size: 14px; font-weight: 600; letter-spacing: 0.02em; -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px); opacity: 0; transition: opacity 0.16s ease; white-space: nowrap; }
.pg-pill.on { opacity: 1; }
.pg-pill svg { display: block; }
.pg-ctl { position: absolute; left: 0; right: 0; bottom: 0; z-index: 7; display: flex; align-items: center; gap: 10px; height: 56px; padding: 0 14px; box-sizing: content-box; padding-bottom: env(safe-area-inset-bottom, 0px); background: linear-gradient(0deg, rgba(0,0,0,0.78), rgba(0,0,0,0)); opacity: 0; pointer-events: none; transition: opacity 0.18s ease; }
.pg-ctl.on { opacity: 1; pointer-events: auto; }
.pg-ctl-btn { flex: none; width: 34px; height: 34px; border: 0; border-radius: 50%; background: rgba(255,255,255,0.16); color: #fff; display: flex; align-items: center; justify-content: center; padding: 0; }
.pg-ctl-btn svg { display: block; }
.pg-ctl-t { flex: none; min-width: 34px; text-align: center; color: #fff; font-size: 12px; font-variant-numeric: tabular-nums; }
.pg-ctl-track { position: relative; flex: 1; height: 26px; display: flex; align-items: center; touch-action: none; }
.pg-ctl-buf, .pg-ctl-fill { position: absolute; left: 0; height: 4px; border-radius: 2px; }
.pg-ctl-buf { right: 0; background: rgba(255,255,255,0.22); }
.pg-ctl-fill { width: 0; background: #fff; }
.pg-ctl-knob { position: absolute; left: 0; width: 12px; height: 12px; margin-left: -6px; border-radius: 50%; background: #fff; }
`;

  const S = new WeakMap(); // video → state
  const BOX = new WeakMap(); // box → state（手势监听挂在 box，捕获阶段）

  function isLoaded(st) { return st.video.readyState >= 1; }
  function canSeek(st) { const v = st.video; return isLoaded(st) && isFinite(v.duration) && v.duration > 0; }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function fmt(sec) {
    if (!isFinite(sec) || sec < 0) return '0:00';
    const s = Math.floor(sec % 60)
    const m = Math.floor(sec / 60)
    return `${m}:${String(s).padStart(2, '0')}`
  }
  function injectStyles() {
    if (document.getElementById('pg-styles')) return
    const el = document.createElement('style')
    el.id = 'pg-styles'
    el.textContent = STYLES
    document.head.appendChild(el)
  }

  // ── 指示条 ──
  function showPill(st, icon, text) {
    if (!st.pill) return
    st.pill.innerHTML = icon + '<span></span>'
    st.pill.querySelector('span').textContent = text
    st.pill.classList.add('on')
    clearTimeout(st.pillTimer)
    st.pillTimer = setTimeout(() => st.pill.classList.remove('on'), 700)
  }
  function hidePill(st) { clearTimeout(st.pillTimer); if (st.pill) st.pill.classList.remove('on') }

  // ── 两档显示模式 ──
  function isFill(st) { return st.box.classList.contains('fill') }
  function setFill(st, on) {
    const next = !!on
    if (isFill(st) === next) return false
    st.box.classList.toggle('fill', next)
    showPill(st, '', next ? '铺满全屏' : '全屏')
    return true
  }

  // ── 全屏自绘控制条 ──
  function syncCtl(st) {
    const v = st.video
    const dur = isFinite(v.duration) && v.duration > 0 ? v.duration : 0
    const cur = v.currentTime || 0
    const ratio = dur ? clamp(cur / dur, 0, 1) : 0
    st.ctl.fillEl.style.width = (ratio * 100).toFixed(3) + '%'
    st.ctl.knob.style.left = (ratio * 100).toFixed(3) + '%'
    st.ctl.cur.textContent = fmt(cur)
    st.ctl.dur.textContent = fmt(dur)
    st.ctl.btn.innerHTML = v.paused ? ICON.play : ICON.pause
    const buf = v.buffered
    let bufferedEnd = 0
    for (let i = 0; i < buf.length; i++) if (buf.start(i) <= cur + 0.5) bufferedEnd = Math.max(bufferedEnd, buf.end(i))
    st.ctl.buf.style.width = dur ? (clamp(bufferedEnd / dur, 0, 1) * 100).toFixed(3) + '%' : '0%'
  }
  function showCtl(st, autoHide = true) {
    if (!st.fs) return
    st.ctl.root.classList.add('on')
    clearTimeout(st.ctlTimer)
    if (autoHide && !st.video.paused) st.ctlTimer = setTimeout(() => hideCtl(st), CTL_HIDE_MS)
  }
  function hideCtl(st) { clearTimeout(st.ctlTimer); if (st.ctl) st.ctl.root.classList.remove('on') }
  function toggleCtl(st) { if (st.ctl.root.classList.contains('on')) hideCtl(st); else showCtl(st) }

  function scrubTo(st, clientX) {
    const v = st.video
    if (!canSeek(st)) return
    const r = st.ctl.track.getBoundingClientRect()
    if (r.width <= 0) return
    const ratio = clamp((clientX - r.left) / r.width, 0, 1)
    v.currentTime = ratio * v.duration
    syncCtl(st)
  }

  // ── 全屏浮层 ──
  function enterFs(st) {
    if (st.fs) return
    st.fsOrigin = { parent: st.box.parentNode, next: st.box.nextSibling }
    // 自绘控件接管：原生 controls 的控件带会吞掉触摸（实测 0 指到达页面），全屏必须关掉
    st.nativeControls = st.video.controls
    st.video.controls = false
    document.body.appendChild(st.box)
    st.box.classList.add('fs')
    st.box.classList.remove('fill') // 进全屏默认「全屏」档（两档中的低档）
    st.fs = true
    syncCtl(st)
    showCtl(st)
  }
  function exitFs(st) {
    if (!st.fs) return
    st.box.classList.remove('fs', 'fill')
    const o = st.fsOrigin
    if (o && o.parent && o.parent.isConnected) {
      const next = (o.next && o.next.parentNode === o.parent) ? o.next : null
      try { o.parent.insertBefore(st.box, next) } catch (_) { o.parent.appendChild(st.box) }
    }
    st.fsOrigin = null
    st.fs = false
    hideCtl(st)
    hidePill(st)
    st.video.controls = st.nativeControls !== false
  }
  function toggleFs(st) {
    if (st.fs) { exitFs(st); return }
    if (!isLoaded(st)) return
    enterFs(st)
  }

  /** 供播放器页顶部图标调用：全屏时退出全屏并返回 true（未全屏返回 false，调用方继续走关闭播放） */
  function exitFullscreen(video) {
    const st = S.get(video)
    if (!st || !st.fs) return false
    exitFs(st)
    return true
  }

  // ── 滚轮/触控板捏合：按累计方向切档 ──
  function onWheel(e) {
    if (!e.ctrlKey && !e.metaKey) return
    e.preventDefault()
    const st = BOX.get(e.currentTarget)
    if (!st) return
    st.wheelAcc += -e.deltaY
    if (st.wheelAcc >= WHEEL_SWITCH_ACC) {
      st.wheelAcc = 0
      if (!st.fs) { enterFs(st); setFill(st, true) } else setFill(st, true)
    } else if (st.wheelAcc <= -WHEEL_SWITCH_ACC) {
      st.wheelAcc = 0
      if (st.fs) setFill(st, false)
    }
  }
  function onGestureStart(e) { e.preventDefault() }
  function onGestureChange(e) {
    e.preventDefault()
    const st = BOX.get(e.currentTarget)
    if (!st) return
    if (e.scale >= GESTURE_SWITCH_RATIO) {
      if (!st.fs) { enterFs(st); setFill(st, true) } else setFill(st, true)
    } else if (e.scale <= 1 / GESTURE_SWITCH_RATIO && st.fs) {
      setFill(st, false)
    }
  }

  // ── 指针事件（挂在容器捕获阶段）──
  function onDown(e) {
    const st = BOX.get(e.currentTarget)
    if (!st) return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    // 顶部栏按钮永远放行（close / 缓存菜单）
    if (e.target && e.target.closest && e.target.closest('.inline-player-bar')) return
    if (!st.fs && e.clientX < EDGE_YIELD_PX) return // 非全屏让位系统左缘返回手势
    const vr = st.video.getBoundingClientRect()
    const inGuard = e.clientY > vr.bottom - CONTROL_GUARD
    // 落在自绘控制条上：单指交给控件（进度条拖动 / 按钮），双指由手势层接管切档
    const ctlHit = !!(st.ctl && st.ctl.root.contains(e.target))
    if (e.isPrimary && st.pointers.size > 0) st.pointers.clear()
    st.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    // 落在控制条上的指针不捕获到容器，否则进度条的 pointermove 会被容器吃掉
    if (!ctlHit) { try { st.box.setPointerCapture(e.pointerId) } catch (_) {} }
    if (st.pointers.size === 2) {
      st.mode = 'pinch'
      st.seekActive = false
      if (st.scrubAbort) { st.scrubAbort(); st.scrubAbort = null } // 双指接管：取消进行中的进度条拖动
      hidePill(st)
      const [a, b] = [...st.pointers.values()]
      st.pinchStartDist = Math.max(Math.hypot(a.x - b.x, a.y - b.y), 1)
      e.preventDefault()
    } else if (st.pointers.size === 1) {
      st.mode = ctlHit ? 'ctl' : null
      st.moved = false
      st.downInGuard = inGuard   // 仅约束单指 seek，双指不受限
      st.seekStartX = e.clientX
      st.seekStartY = e.clientY
      st.seekActive = false
    }
  }

  function onMove(e) {
    const st = BOX.get(e.currentTarget)
    if (!st || !st.pointers.has(e.pointerId)) return
    const prev = st.pointers.get(e.pointerId)
    st.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })

    if (st.mode === 'pinch' && st.pointers.size >= 2) {
      const [a, b] = [...st.pointers.values()]
      const d = Math.max(Math.hypot(a.x - b.x, a.y - b.y), 1)
      const ratio = d / st.pinchStartDist
      if (!st.fs) {
        // 内联：外扩 → 进入全屏并直接落在铺满档（任何状态都能放大到满屏）
        if (ratio > PINCH_ENTER_RATIO) { enterFs(st); setFill(st, true); st.pinchStartDist = d }
      } else if (ratio > PINCH_SWITCH_RATIO && !isFill(st)) {
        setFill(st, true); st.pinchStartDist = d
      } else if (ratio < 1 / PINCH_SWITCH_RATIO && isFill(st)) {
        setFill(st, false); st.pinchStartDist = d
      }
      e.preventDefault()
      return
    }

    if (st.mode === 'ctl') return // 单指在控制条上：进度条拖动由控件自己处理
    if (st.pointers.size !== 1) return
    const dxs = e.clientX - st.seekStartX, dys = e.clientY - st.seekStartY
    if (Math.hypot(e.clientX - prev.x, e.clientY - prev.y) > 1) st.moved = true

    if (!st.seekActive) {
      // 底部控制条带只让位「单指」拖动进度条；双指已在上面处理，不受此限
      if (!st.downInGuard && Math.abs(dxs) > DRAG_ACTIVATE && Math.abs(dxs) > Math.abs(dys) * 1.2 && canSeek(st)) {
        st.seekActive = true
        st.mode = 'seek'
      }
    }
    if (st.seekActive) {
      const steps = Math.floor(Math.abs(dxs) / SEEK_STEP_PX)
      if (steps >= 1) showPill(st, dxs > 0 ? ICON.ff : ICON.rew, `${dxs > 0 ? '快进' : '快退'} ${steps * SEEK_STEP_SEC} 秒`)
      e.preventDefault()
    }
  }

  function onUp(e) {
    const st = BOX.get(e.currentTarget)
    if (!st || !st.pointers.has(e.pointerId)) return
    st.pointers.delete(e.pointerId)

    if (st.mode === 'ctl') { st.mode = null; return } // 控件交互（拖动/点按钮）由控件自己收尾
    if (st.mode === 'pinch') {
      if (st.pointers.size < 2) {
        st.mode = null
        if (st.pointers.size === 1) {
          const p = [...st.pointers.values()][0]
          st.moved = true
          st.seekStartX = p.x; st.seekStartY = p.y
          st.seekActive = false
        }
        // 不主动 hidePill：切档提示由 showPill 的 700ms 计时器自然消失
      }
      e.preventDefault()
      return
    }

    if (st.seekActive) {
      const dxs = e.clientX - st.seekStartX
      const steps = Math.floor(Math.abs(dxs) / SEEK_STEP_PX)
      if (steps >= 1 && canSeek(st)) {
        const v = st.video
        v.currentTime = clamp(v.currentTime + (dxs > 0 ? 1 : -1) * steps * SEEK_STEP_SEC, 0, v.duration)
      }
      st.seekActive = false
      st.mode = null
      hidePill(st)
      e.preventDefault()
      return
    }

    // 点按：全屏时切换控制条显隐；双击切换全屏
    if (!st.moved && st.pointers.size === 0 && isLoaded(st)) {
      const now = Date.now()
      const isDbl = now - st.lastTapT < DBL_TAP_MS
        && Math.hypot(e.clientX - st.lastTapX, e.clientY - st.lastTapY) < TAP_SLOP * 2
      if (isDbl) {
        st.lastTapT = 0
        toggleFs(st)
      } else {
        st.lastTapT = now; st.lastTapX = e.clientX; st.lastTapY = e.clientY
        if (st.fs) toggleCtl(st)
      }
    }
  }

  function onCancel(e) {
    const st = BOX.get(e.currentTarget)
    if (!st || !st.pointers.has(e.pointerId)) return
    st.pointers.delete(e.pointerId)
    if (st.pointers.size === 0) {
      st.mode = null
      st.seekActive = false
      hidePill(st)
    }
  }

  function buildCtl(st) {
    const ctl = document.createElement('div')
    ctl.className = 'pg-ctl'
    ctl.innerHTML =
      '<button class="pg-ctl-btn" type="button" aria-label="播放/暂停"></button>' +
      '<span class="pg-ctl-t pg-ctl-cur">0:00</span>' +
      '<div class="pg-ctl-track" role="slider" aria-label="播放进度">' +
      '<div class="pg-ctl-buf"></div><div class="pg-ctl-fill"></div><div class="pg-ctl-knob"></div></div>' +
      '<span class="pg-ctl-t pg-ctl-dur">0:00</span>'
    st.box.appendChild(ctl)
    const q = (sel) => ctl.querySelector(sel)
    st.ctl = {
      root: ctl,
      btn: q('.pg-ctl-btn'),
      cur: q('.pg-ctl-cur'),
      dur: q('.pg-ctl-dur'),
      track: q('.pg-ctl-track'),
      buf: q('.pg-ctl-buf'),
      fillEl: q('.pg-ctl-fill'),
      knob: q('.pg-ctl-knob'),
    }

    st.ctl.btn.addEventListener('click', () => {
      const v = st.video
      if (v.paused) { const p = v.play(); if (p && p.catch) p.catch(() => {}) } else v.pause()
      syncCtl(st)
      showCtl(st)
    })

    // 进度条拖动：按下不立即 seek（避免双指切档时误跳），首次移动或抬起时才定位；可被双指接管取消
    st.ctl.track.addEventListener('pointerdown', (e) => {
      if (!canSeek(st)) return
      e.preventDefault()
      const pid = e.pointerId
      let started = false
      try { st.ctl.track.setPointerCapture(pid) } catch (_) {}
      const move = (ev) => {
        if (ev.pointerId !== pid) return
        if (!started) { started = true; showCtl(st, false) }
        scrubTo(st, ev.clientX)
      }
      const cleanup = () => {
        st.ctl.track.removeEventListener('pointermove', move)
        st.ctl.track.removeEventListener('pointerup', up)
        st.ctl.track.removeEventListener('pointercancel', up)
        st.scrubAbort = null
      }
      const up = (ev) => {
        if (ev.pointerId !== pid) return
        cleanup()
        if (!started) scrubTo(st, ev.clientX)
        showCtl(st)
      }
      st.scrubAbort = () => { cleanup(); showCtl(st) }
      st.ctl.track.addEventListener('pointermove', move)
      st.ctl.track.addEventListener('pointerup', up)
      st.ctl.track.addEventListener('pointercancel', up)
    })

    const onTime = () => { if (st.fs) syncCtl(st) }
    st.video.addEventListener('timeupdate', onTime)
    st.video.addEventListener('durationchange', onTime)
    st.video.addEventListener('progress', onTime)
    st.video.addEventListener('play', () => { if (st.fs) { syncCtl(st); showCtl(st) } })
    st.video.addEventListener('pause', () => { if (st.fs) { syncCtl(st); showCtl(st, false) } })
  }

  function attach(video) {
    if (!video || S.has(video)) return
    const box = video.closest('.inline-player')
    if (!box) return
    injectStyles()
    const st = {
      video, box,
      pointers: new Map(),
      mode: null,           // 'pinch' | 'seek' | null
      fs: false, fsOrigin: null, nativeControls: true,
      seekStartX: 0, seekStartY: 0, seekActive: false,
      downInGuard: false,
      moved: false,
      lastTapT: 0, lastTapX: 0, lastTapY: 0,
      pinchStartDist: 1,
      wheelAcc: 0,
      pillTimer: 0, pill: null,
      ctlTimer: 0, ctl: null,
    }
    S.set(video, st)
    BOX.set(box, st)

    const pill = document.createElement('div')
    pill.className = 'pg-pill'
    box.appendChild(pill)
    st.pill = pill

    buildCtl(st)

    // 手势监听挂在容器捕获阶段：事件目标是 video / 控制条都能先经过手势层判定
    box.addEventListener('pointerdown', onDown, true)
    box.addEventListener('pointermove', onMove, true)
    box.addEventListener('pointerup', onUp, true)
    box.addEventListener('pointercancel', onCancel, true)
    box.addEventListener('wheel', onWheel, { passive: false })
    box.addEventListener('gesturestart', onGestureStart)
    box.addEventListener('gesturechange', onGestureChange)
    box.addEventListener('gestureend', (e) => { e.preventDefault() })

    // 切换视频/关闭播放器 → 自复位
    video.addEventListener('emptied', () => { exitFs(st); hidePill(st) })
    video.addEventListener('loadedmetadata', () => { if (st.fs) syncCtl(st) })
  }

  function init() {
    document.querySelectorAll('.inline-player video').forEach(attach)
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
  else init()

  return { attach, exitFullscreen }
})();
