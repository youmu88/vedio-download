/**
 * PlayerGestures — 播放器手势层（ios.js / macos.js 共用）
 *
 * 能力：
 *   1. 双指捏合等比缩放，档位化（主流播放器模式）：连续跟手，松手磁性吸附最近档——
 *      [原比例 1x, 铺满全屏（coverScale，按屏幕与视频比例实时计算，零黑框、长边裁切）, 放大档 min(2×铺满, 4x)]；
 *      内联卡片中双指外扩 → 播放器展开为全屏浮层继续跟手缩放 → 吸附档位；
 *      全屏中收拢到 1x 后继续收 → 退出全屏回内联卡片。缩放后单指可平移（夹取不露边）。
 *   2. 横滑快进/快退：视频面单指横滑（|dx|>|dy| 激活），每 64px 一步 ±15 秒，
 *      拖动中指示条实时显示聚合秒数，松手生效并夹取 [0, duration]。
 *   3. 双击切换全屏（桌面鼠标无捏合时的等价入口；重置缩放）。
 *
 * 关键设计（为什么这么做）：
 *   - 全屏用 CSS 固定浮层（.fs）+ 播放器节点临时迁移到 body：iPhone Safari 无
 *     Element.requestFullscreen（仅 <video> 原生全屏会被系统 UI 接管、手势全部失效）；
 *     media 元素在文档内迁移不打断播放。退出时精确归位（parent + nextSibling）。
 *   - Pointer Events 统一触摸/鼠标/触控笔；另挂 Safari 桌面 gesturestart/change
 *     （触控板捏合原生事件）与 ctrl/cmd+wheel（Chrome/Edge 触控板捏合语义）双适配。
 *   - 起手 x<28px 的触摸不认领：让位 ios.js 全局左缘返回手势（系统级手势优先，iOS 惯例）。
 *   - 视频底部 56px 控制条保护区不认领手势：避免与原生 controls 的进度条拖动二次 seek。
 *   - 生命周期自管理：监听 'emptied'（PlayerCore 切换/关闭时 removeAttribute+load 必触发）
 *     → 复位缩放、退出全屏、节点归位。与 PlayerCore 零耦合，无需改动其任何代码。
 *   - 直播流（duration 无穷）禁用 seek，保留缩放。
 */
window.PlayerGestures = (() => {
  const MAX_SCALE = 4;          // 缩放上限：覆盖 16:9 横屏视频撑满竖屏手机（≈3.85x）
  const SEEK_STEP_PX = 64;      // 每步快进/快退的横滑距离
  const SEEK_STEP_SEC = 15;     // 每步秒数（需求：右滑快进 / 左滑快退 15 秒）
  const DRAG_ACTIVATE = 18;     // seek 激活位移阈值
  const TAP_SLOP = 10;          // 点按位移容差
  const DBL_TAP_MS = 320;       // 双击间隔
  const EDGE_YIELD_PX = 28;     // 与 ios.js 左缘返回手势的起手带宽一致，让位系统手势
  const CONTROL_GUARD = 56;     // 底部原生控制条保护区
  const EXIT_RATIO = 0.8;       // scale==1 后继续收拢到捏合起距的 80% → 退出全屏
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

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

  // ── 缩放（指尖/光标锚点）与平移夹取 ──
  function apply(st) {
    st.video.style.transform = `translate3d(${st.tx}px, ${st.ty}px, 0) scale(${st.scale})`;
  }
  function clampPan(st) {
    // 平移范围：缩放后元素盒仍需完全覆盖布局盒（全屏时即视口），不露黑边
    const w = st.video.offsetWidth, h = st.video.offsetHeight;
    const mx = Math.max(0, w * (st.scale - 1) / 2), my = Math.max(0, h * (st.scale - 1) / 2);
    st.tx = clamp(st.tx, -mx, mx);
    st.ty = clamp(st.ty, -my, my);
  }
  function setScale(st, s, ax, ay) {
    const target = clamp(s, 1, maxLevel(st));
    const k = target / st.scale;
    if (k !== 1) {
      // 锚点不动：video 布局盒中心 = 视觉中心 - 位移（scale 绕中心，不改中心）
      const vr = st.video.getBoundingClientRect();
      const axOff = ax - (vr.left + vr.width / 2 - st.tx);
      const ayOff = ay - (vr.top + vr.height / 2 - st.ty);
      st.tx += axOff * (1 - k);
      st.ty += ayOff * (1 - k);
      st.scale = target;
    }
    clampPan(st);
    apply(st);
  }

  // ── 档位缩放（原比例 / 铺满全屏 / 放大档）──
  // coverScale：内容 contain 显示后等比放大到恰好铺满视口的倍数（零黑框、长边裁切）——
  // 即主流播放器「铺满全屏/适配屏幕比例」档；随屏幕尺寸与视频分辨率实时计算，旋转自动适配。
  function coverScale(st) {
    const w = st.video.offsetWidth || 1, h = st.video.offsetHeight || 1;
    const vw = st.video.videoWidth || 16, vh = st.video.videoHeight || 9;
    const cw = Math.min(w, vw * h / vh), ch = Math.min(h, vh * w / vw);
    return Math.max(w / cw, h / ch);
  }
  function levels(st) {
    const c = coverScale(st);
    const arr = [1, c];
    const zoom = Math.min(c * 2, MAX_SCALE);
    if (zoom > c + 0.2) arr.push(zoom); // 放大档与铺满档保持有意义的距离
    return arr;
  }
  function maxLevel(st) { return levels(st).slice(-1)[0]; }
  function levelName(st, L) {
    if (Math.abs(L - 1) < 0.02) return '原比例';
    if (Math.abs(L - coverScale(st)) < 0.02) return '铺满全屏';
    return '放大 ' + (Math.round(L * 10) / 10) + '×';
  }
  // 磁性吸附：缩放/捏合结束后归位到最近档位（平移归中 + 平滑过渡）
  function snapToLevel(st) {
    if (!st.fs || !isLoaded(st)) return;
    let best = null, bd = Infinity;
    for (const L of levels(st)) {
      const d = Math.abs(st.scale - L);
      if (d < bd) { bd = d; best = L; }
    }
    if (Math.abs(best - st.scale) < 0.01) { showPill(st, '', levelName(st, best)); return; }
    const v = st.video;
    v.style.transition = 'transform 0.26s cubic-bezier(0.32, 0.72, 0.35, 1)'; // 仅吸附动画期开启，不污染捏合跟手
    st.scale = best; st.tx = 0; st.ty = 0;
    apply(st);
    clearTimeout(st.snapT);
    st.snapT = setTimeout(() => { v.style.transition = ''; }, 300);
    showPill(st, '', levelName(st, best));
  }

  // ── 全屏浮层 ──
  function enterFs(st) {
    if (st.fs) return;
    st.fsOrigin = { parent: st.box.parentNode, next: st.box.nextSibling };
    document.body.appendChild(st.box);
    st.box.classList.add('fs');
    st.fs = true;
  }
  function exitFs(st) {
    if (!st.fs) return;
    st.box.classList.remove('fs');
    const o = st.fsOrigin;
    if (o && o.parent && o.parent.isConnected) {
      const next = (o.next && o.next.parentNode === o.parent) ? o.next : null;
      try { o.parent.insertBefore(st.box, next); } catch (_) { o.parent.appendChild(st.box); }
    }
    st.fsOrigin = null;
    st.fs = false;
    st.scale = 1; st.tx = 0; st.ty = 0;
    apply(st);
    hidePill(st);
  }
  function toggleFs(st) {
    if (st.fs) { exitFs(st); return; }
    if (!isLoaded(st)) return;
    enterFs(st);
    showPill(st, '', '全屏');
  }

  // ── 滚轮/触控板捏合（ctrl/cmd+wheel；Safari 桌面走 gesturechange）──
  function zoomAt(st, factor, ax, ay) {
    if (!isLoaded(st)) return;
    const target = st.scale * factor;
    if (!st.fs && target > st.scale) enterFs(st);
    // 缩到 1x 仍继续收 → 退出全屏（与双指收拢退出对称）
    if (st.fs && target <= 1.001 && factor < 1) { exitFs(st); hidePill(st); return; }
    setScale(st, target, ax, ay);
    showPill(st, '', Math.round(st.scale * 100) + '%');
  }
  function onWheel(e) {
    if (!e.ctrlKey && !e.metaKey) return; // 仅捏合语义，普通滚动不劫持
    e.preventDefault();
    const st = S.get(e.currentTarget);
    if (st) {
      zoomAt(st, Math.exp(-e.deltaY * 0.0022), e.clientX, e.clientY);
      // 连滚停止后吸附最近档位（滚轮无“松手”语义，用静默期判定）
      clearTimeout(st.wheelSnapT);
      st.wheelSnapT = setTimeout(() => snapToLevel(st), 350);
    }
  }
  function onGestureStart(e) { e.preventDefault(); const st = S.get(e.currentTarget); if (st) st.gestureScale0 = st.scale; }
  function onGestureChange(e) {
    e.preventDefault();
    const st = S.get(e.currentTarget);
    if (!st || st.gestureScale0 == null) return;
    const r = st.video.getBoundingClientRect();
    zoomAt(st, st.gestureScale0 * e.scale, e.clientX || r.left + r.width / 2, e.clientY || r.top + r.height / 2);
  }

  // ── 指针事件（触摸/鼠标/触控笔统一）──
  function onDown(e) {
    const st = S.get(e.currentTarget);
    if (!st || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if (e.clientX < EDGE_YIELD_PX) return; // 让位系统左缘返回手势
    const vr = st.video.getBoundingClientRect();
    if (e.clientY > vr.bottom - CONTROL_GUARD) return; // 原生控制条保护区
    st.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { st.video.setPointerCapture(e.pointerId); } catch (_) {}
    if (st.pointers.size === 2) {
      // 第二指落下 → 进入捏合，作废未提交的 seek/双击状态
      st.mode = 'pinch';
      st.seekActive = false;
      hidePill(st);
      const [a, b] = [...st.pointers.values()];
      st.pinchStartDist = Math.max(Math.hypot(a.x - b.x, a.y - b.y), 1);
      st.pinchStartScale = st.scale;
      st.collapsed = false;
      e.preventDefault();
    } else if (st.pointers.size === 1) {
      st.mode = null;
      st.moved = false;
      st.seekStartX = e.clientX;
      st.seekStartY = e.clientY;
      st.seekActive = false;
      // 新触摸立即接管：中断吸附过渡动画，避免 transform 跟手滞后
      clearTimeout(st.snapT);
      st.video.style.transition = '';
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
      if (!st.fs && d > st.pinchStartDist * 1.04) enterFs(st); // 外扩即展开全屏，同手势继续跟手缩放
      let s = st.pinchStartScale * d / st.pinchStartDist;
      if (st.fs) {
        s = clamp(s, 1, maxLevel(st));
        // 收拢到 1x 后继续内收 → 记退出意图（松手生效，回内联卡片）
        if (s <= 1.001 && d < st.pinchStartDist * EXIT_RATIO) st.collapsed = true;
      }
      setScale(st, s, (a.x + b.x) / 2, (a.y + b.y) / 2);
      showPill(st, '', Math.round(st.scale * 100) + '%');
      e.preventDefault();
      return;
    }

    if (st.pointers.size !== 1) return;
    const dxs = e.clientX - st.seekStartX, dys = e.clientY - st.seekStartY;
    if (Math.hypot(e.clientX - prev.x, e.clientY - prev.y) > 1) st.moved = true;

    if (st.fs && st.scale > 1.01) {
      // 放大态：单指平移
      st.mode = 'pan';
      st.tx += e.clientX - prev.x;
      st.ty += e.clientY - prev.y;
      clampPan(st);
      apply(st);
      e.preventDefault();
      return;
    }

    // 1x 态：横滑 seek（横向占优才激活，纵向让位页面滚动）
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
        const snapping = st.fs && !st.collapsed;
        if (st.fs && st.collapsed) exitFs(st);
        else if (st.fs) snapToLevel(st);
        if (st.pointers.size === 0) st.mode = null;
        if (!snapping) hidePill(st);
      }
      e.preventDefault();
      return;
    }
    if (st.mode === 'pan') { if (st.pointers.size === 0) st.mode = null; return; }

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
      const snapping = st.fs && !st.collapsed;
      if (st.fs && st.collapsed) exitFs(st);
      else if (st.fs) snapToLevel(st);
      if (!snapping) hidePill(st);
    }
  }

  function attach(video) {
    if (!video || S.has(video)) return;
    const box = video.closest('.inline-player');
    if (!box) return;
    const st = {
      video, box,
      pointers: new Map(),
      mode: null,           // 'pinch' | 'pan' | 'seek' | null
      scale: 1, tx: 0, ty: 0,
      fs: false, fsOrigin: null,
      seekStartX: 0, seekStartY: 0, seekActive: false,
      moved: false,
      lastTapT: 0, lastTapX: 0, lastTapY: 0,
      pinchStartDist: 1, pinchStartScale: 1, collapsed: false,
      gestureScale0: null,
      pillTimer: 0,
      snapT: 0, wheelSnapT: 0,
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
    video.addEventListener('gestureend', (e) => { e.preventDefault(); const s = S.get(e.currentTarget); if (s) { s.gestureScale0 = null; snapToLevel(s); } });

    // 切换视频/关闭播放器（PlayerCore 会 removeAttribute('src')+load()）→ 自复位
    video.addEventListener('emptied', () => { exitFs(st); hidePill(st); });
  }

  function init() {
    document.querySelectorAll('.inline-player video').forEach(attach);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  return { attach };
})();
