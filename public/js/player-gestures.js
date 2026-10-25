/**
 * PlayerGestures — 播放器手势层（ios.js / macos.js 共用）
 *
 * 能力：
 *   1. 双指捏合切换「两档显示模式」（仅全屏时生效）：
 *      全屏（object-fit: contain，上下黑边） ↔ 铺满全屏（object-fit: cover，零黑边、长边裁切）。
 *      外扩 → 铺满；收拢 → 全屏；到全屏档后继续收拢仍保持全屏——手势永不退出全屏。
 *      非全屏（内联卡片）不响应缩放：全屏切换走顶部图标 / 双击。
 *   2. 横滑快进/快退：视频面单指横滑（|dx|>|dy| 激活），每 64px 一步 ±15 秒，
 *      拖动中指示条实时显示聚合秒数，松手生效并夹取 [0, duration]；两档显示模式下均可用。
 *   3. 双击切换全屏（桌面鼠标无捏合时的等价入口）；进入全屏默认「全屏」档。
 *
 * 为什么不用 transform: scale（第 6 轮根因）：
 *   原生 controls 属于 <video> 的 UA 影子 DOM，transform 缩放会连控件一起放大——
 *   640x360 视频在 390x844 屏上铺满需 3.0x，元素盒变 1170x2532，控件被推出视口，
 *   用户点击画布看不到进度条；且 scale 是连续量，跟手中出现 1.1~3.0 的中间档（用户感知「还有第三档」）。
 *   改用 object-fit: cover 让「画面内容」铺满、元素盒恒等于视口 → 控件始终在屏内且位置不变，
 *   状态天然只有 contain / cover 两档（class `fill`），没有中间态。
 *
 * 关键设计：
 *   - 全屏用 CSS 固定浮层（.fs）+ 播放器节点临时迁移到 body：iPhone Safari 无
 *     Element.requestFullscreen（仅 <video> 原生全屏会被系统 UI 接管、手势全部失效）；
 *     media 元素在文档内迁移不打断播放。退出时精确归位（parent + nextSibling）。
 *   - 全屏时顶部栏浮层化（absolute，不占文档流）：既消除「bar 占 53px 导致顶部黑边」，
 *     又保留可点图标；close 图标在全屏时语义 = 退出全屏（由播放器页调 exitFullscreen 接线）。
 *   - Pointer Events 统一触摸/鼠标/触控笔；另挂 Safari 桌面 gesturestart/change
 *     （触控板捏合原生事件）与 ctrl/cmd+wheel（Chrome/Edge 触控板捏合语义）双适配，按方向切档。
 *   - 起手 x<28px 的触摸不认领（仅非全屏）：让位 ios.js 全局左缘返回手势（系统级手势优先，iOS 惯例）；
 *     全屏时系统返回手势已被 canIosBack 拦住，播放器吃满屏（左缘横滑也是快退）。
 *   - 视频底部 56px 控制条保护区不认领手势：避免与原生 controls 的进度条拖动二次 seek。
 *   - 生命周期自管理：监听 'emptied'（PlayerCore 切换/关闭时 removeAttribute+load 必触发）
 *     → 退出全屏、清档位、节点归位。与 PlayerCore 零耦合，无需改动其任何代码。
 *   - 直播流（duration 无穷）禁用 seek，保留切档。
 */
window.PlayerGestures = (() => {
  const SEEK_STEP_PX = 64;       // 每步快进/快退的横滑距离
  const SEEK_STEP_SEC = 15;      // 每步秒数（需求：右滑快进 / 左滑快退 15 秒）
  const DRAG_ACTIVATE = 18;      // seek 激活位移阈值
  const TAP_SLOP = 10;           // 点按位移容差
  const DBL_TAP_MS = 320;        // 双击间隔
  const EDGE_YIELD_PX = 28;      // 与 ios.js 左缘返回手势的起手带宽一致，让位系统手势
  const CONTROL_GUARD = 56;      // 底部原生控制条保护区
  const PINCH_SWITCH_RATIO = 1.08;    // 双指间距相对起手 ±8% → 切档（切档后重设基准，天然防抖）
  const WHEEL_SWITCH_ACC = 120;       // 桌面触控板捏合累计 deltaY → 切档
  const GESTURE_SWITCH_RATIO = 1.06;  // Safari gesture e.scale 相对 gesturestart → 切档

  const ICON = {
    ff: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 5.5v13l7.5-6.5L4 5.5zm8.5 0v13L20 12l-7.5-6.5z" fill="currentColor"/></svg>',
    rew: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 5.5v13L12.5 12 20 5.5zm-8.5 0v13L4 12l7.5-6.5z" fill="currentColor"/></svg>',
  };

  const S = new WeakMap(); // video → state

  function isLoaded(st) { return st.video.readyState >= 1; }
  function canSeek(st) { const v = st.video; return isLoaded(st) && isFinite(v.duration) && v.duration > 0; }

  // ── 指示条 ──
  function showPill(st, icon, text) {
    st.pill.innerHTML = icon + '<span></span>';
    st.pill.querySelector('span').textContent = text;
    st.pill.classList.add('on');
    clearTimeout(st.pillTimer);
    st.pillTimer = setTimeout(() => st.pill.classList.remove('on'), 700);
  }
  function hidePill(st) { clearTimeout(st.pillTimer); st.pill.classList.remove('on'); }

  // ── 两档显示模式：全屏（contain，上下黑边） ↔ 铺满全屏（cover，零黑边）──
  // 只有 class 切换，无 transform/scale —— 元素盒恒等于视口，原生 controls 不受影响。
  function isFill(st) { return st.box.classList.contains('fill'); }
  function setFill(st, on) {
    const next = !!on;
    if (isFill(st) === next) return false;
    st.box.classList.toggle('fill', next);
    showPill(st, '', next ? '铺满全屏' : '全屏');
    return true;
  }

  // ── 全屏浮层 ──
  function enterFs(st) {
    if (st.fs) return;
    st.fsOrigin = { parent: st.box.parentNode, next: st.box.nextSibling };
    document.body.appendChild(st.box);
    st.box.classList.add('fs');
    st.box.classList.remove('fill'); // 进全屏默认「全屏」档（两档中的低档）
    st.fs = true;
  }
  function exitFs(st) {
    if (!st.fs) return;
    st.box.classList.remove('fs', 'fill');
    const o = st.fsOrigin;
    if (o && o.parent && o.parent.isConnected) {
      const next = (o.next && o.next.parentNode === o.parent) ? o.next : null;
      try { o.parent.insertBefore(st.box, next); } catch (_) { o.parent.appendChild(st.box); }
    }
    st.fsOrigin = null;
    st.fs = false;
    hidePill(st);
  }
  function toggleFs(st) {
    if (st.fs) { exitFs(st); return; }
    if (!isLoaded(st)) return;
    enterFs(st);
    showPill(st, '', '全屏');
  }

  /** 供播放器页顶部图标调用：全屏时退出全屏并返回 true（未全屏返回 false，调用方继续走关闭播放） */
  function exitFullscreen(video) {
    const st = S.get(video);
    if (!st || !st.fs) return false;
    exitFs(st);
    return true;
  }

  // ── 滚轮/触控板捏合（ctrl/cmd+wheel）：按累计方向切档，不做连续缩放 ──
  function onWheel(e) {
    if (!e.ctrlKey && !e.metaKey) return; // 仅捏合语义，普通滚动不劫持
    e.preventDefault();
    const st = S.get(e.currentTarget);
    if (!st || !st.fs) return; // 非全屏不响应缩放（全屏切换走图标/双击）
    st.wheelAcc += -e.deltaY;
    if (st.wheelAcc >= WHEEL_SWITCH_ACC) { st.wheelAcc = 0; setFill(st, true); }
    else if (st.wheelAcc <= -WHEEL_SWITCH_ACC) { st.wheelAcc = 0; setFill(st, false); }
  }
  // Safari 桌面触控板捏合：e.scale 是相对 gesturestart 的绝对倍数
  function onGestureStart(e) { e.preventDefault(); }
  function onGestureChange(e) {
    e.preventDefault();
    const st = S.get(e.currentTarget);
    if (!st || !st.fs) return;
    if (e.scale >= GESTURE_SWITCH_RATIO) setFill(st, true);
    else if (e.scale <= 1 / GESTURE_SWITCH_RATIO) setFill(st, false);
  }

  // ── 指针事件（触摸/鼠标/触控笔统一）──
  function onDown(e) {
    const st = S.get(e.currentTarget);
    if (!st || (e.pointerType === 'mouse' && e.button !== 0)) return;
    // 非全屏让位系统左缘返回手势；全屏时 canIosBack 已拦住系统手势，播放器自己吃满屏（左缘横滑也是快退）
    if (!st.fs && e.clientX < EDGE_YIELD_PX) return;
    const vr = st.video.getBoundingClientRect();
    if (e.clientY > vr.bottom - CONTROL_GUARD) return; // 原生控制条保护区
    // 新触摸序列（primary 首指落下）：清掉上一序列可能残留的幽灵指针——
    // iOS Safari 的 pointerup/pointercancel 丢失时 Map 会残留旧点，单指按下将假性凑成 2 指误入 pinch。
    if (e.isPrimary && st.pointers.size > 0) st.pointers.clear();
    st.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { st.video.setPointerCapture(e.pointerId); } catch (_) {}
    if (st.pointers.size === 2) {
      // 第二指落下 → 进入捏合，作废未提交的 seek/双击状态
      st.mode = 'pinch';
      st.seekActive = false;
      hidePill(st);
      const [a, b] = [...st.pointers.values()];
      st.pinchStartDist = Math.max(Math.hypot(a.x - b.x, a.y - b.y), 1);
      e.preventDefault();
    } else if (st.pointers.size === 1) {
      st.mode = null;
      st.moved = false;
      st.seekStartX = e.clientX;
      st.seekStartY = e.clientY;
      st.seekActive = false;
    }
  }

  function onMove(e) {
    const st = S.get(e.currentTarget);
    if (!st || !st.pointers.has(e.pointerId)) return;
    const prev = st.pointers.get(e.pointerId);
    st.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (st.mode === 'pinch' && st.pointers.size >= 2) {
      const [a, b] = [...st.pointers.values()];
      const d = Math.max(Math.hypot(a.x - b.x, a.y - b.y), 1);
      // 仅全屏时切档：外扩 → 铺满；收拢 → 全屏。切档后把基准重置为当前距离（滞回，防阈值抖动）
      if (st.fs) {
        const ratio = d / st.pinchStartDist;
        if (ratio > PINCH_SWITCH_RATIO && !isFill(st)) { setFill(st, true); st.pinchStartDist = d; }
        else if (ratio < 1 / PINCH_SWITCH_RATIO && isFill(st)) { setFill(st, false); st.pinchStartDist = d; }
      }
      e.preventDefault();
      return;
    }

    if (st.pointers.size !== 1) return;
    const dxs = e.clientX - st.seekStartX, dys = e.clientY - st.seekStartY;
    if (Math.hypot(e.clientX - prev.x, e.clientY - prev.y) > 1) st.moved = true;

    // 横滑 seek（两档显示模式下都可用；横向占优才激活，纵向让位页面滚动）
    if (!st.seekActive) {
      if (Math.abs(dxs) > DRAG_ACTIVATE && Math.abs(dxs) > Math.abs(dys) * 1.2 && canSeek(st)) {
        st.seekActive = true;
        st.mode = 'seek';
      }
    }
    if (st.seekActive) {
      const steps = Math.floor(Math.abs(dxs) / SEEK_STEP_PX);
      if (steps >= 1) showPill(st, dxs > 0 ? ICON.ff : ICON.rew, `${dxs > 0 ? '快进' : '快退'} ${steps * SEEK_STEP_SEC} 秒`);
      e.preventDefault();
    }
  }

  function onUp(e) {
    const st = S.get(e.currentTarget);
    if (!st || !st.pointers.has(e.pointerId)) return;
    st.pointers.delete(e.pointerId);

    if (st.mode === 'pinch') {
      if (st.pointers.size < 2) {
        st.mode = null;
        if (st.pointers.size === 1) {
          // 捏合中断（先抬一指）：剩余指从当前位置重新起算，不继承捏合位移（防误触 seek 多步跳秒/误判双击）
          const p = [...st.pointers.values()][0];
          st.moved = true;
          st.seekStartX = p.x; st.seekStartY = p.y;
          st.seekActive = false;
        }
        // 不主动 hidePill：切档提示由 showPill 的 700ms 计时器自然消失（否则松手瞬间吃掉「铺满全屏/全屏」反馈）
      }
      e.preventDefault();
      return;
    }

    if (st.seekActive) {
      const dxs = e.clientX - st.seekStartX;
      const steps = Math.floor(Math.abs(dxs) / SEEK_STEP_PX);
      if (steps >= 1 && canSeek(st)) {
        const v = st.video;
        v.currentTime = clamp(v.currentTime + (dxs > 0 ? 1 : -1) * steps * SEEK_STEP_SEC, 0, v.duration);
      }
      st.seekActive = false;
      st.mode = null;
      hidePill(st);
      e.preventDefault();
      return;
    }

    // 点按 → 双击切换全屏
    if (!st.moved && st.pointers.size === 0 && isLoaded(st)) {
      const now = Date.now();
      const isDbl = now - st.lastTapT < DBL_TAP_MS
        && Math.hypot(e.clientX - st.lastTapX, e.clientY - st.lastTapY) < TAP_SLOP * 2;
      if (isDbl) {
        st.lastTapT = 0;
        toggleFs(st);
      } else {
        st.lastTapT = now; st.lastTapX = e.clientX; st.lastTapY = e.clientY;
      }
    }
  }

  function onCancel(e) {
    const st = S.get(e.currentTarget);
    if (!st || !st.pointers.has(e.pointerId)) return;
    st.pointers.delete(e.pointerId);
    if (st.pointers.size === 0) {
      st.mode = null;
      st.seekActive = false;
      hidePill(st); // 档位已在切档瞬间生效，取消不回滚、不退出全屏
    }
  }

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  function attach(video) {
    if (!video || S.has(video)) return;
    const box = video.closest('.inline-player');
    if (!box) return;
    const st = {
      video, box,
      pointers: new Map(),
      mode: null,           // 'pinch' | 'seek' | null
      fs: false, fsOrigin: null,
      seekStartX: 0, seekStartY: 0, seekActive: false,
      moved: false,
      lastTapT: 0, lastTapX: 0, lastTapY: 0,
      pinchStartDist: 1,
      wheelAcc: 0,
      pillTimer: 0,
      pill: null,
    };
    S.set(video, st);

    const pill = document.createElement('div');
    pill.className = 'pg-pill';
    box.appendChild(pill);
    st.pill = pill;

    video.addEventListener('pointerdown', onDown);
    video.addEventListener('pointermove', onMove);
    video.addEventListener('pointerup', onUp);
    video.addEventListener('pointercancel', onCancel);
    video.addEventListener('wheel', onWheel, { passive: false });
    // Safari 桌面触控板捏合（gesture 事件为 Safari 专有，其他浏览器不触发）
    video.addEventListener('gesturestart', onGestureStart);
    video.addEventListener('gesturechange', onGestureChange);
    video.addEventListener('gestureend', (e) => { e.preventDefault(); });

    // 切换视频/关闭播放器（PlayerCore 会 removeAttribute('src')+load()）→ 自复位
    video.addEventListener('emptied', () => { exitFs(st); hidePill(st); });
  }

  function init() {
    document.querySelectorAll('.inline-player video').forEach(attach);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  return { attach, exitFullscreen };
})();
