/**
 * PlayerCore — 播放器核心（ios.js / macos.js 共用）
 *
 * 消除双端播放器复制漂移：此前 ios.js/macos.js 各维护一份 openPlayer/closePlayer，
 * 修复一处 bug 需同步改两份，极易漏改导致行为不一致（如曾出现 macos 独有 socketConnect 死调用）。
 * 现抽取为单份核心，双端仅通过 configure 注入页面导航/标题差异。
 *
 * 依赖（运行时全局，由页面脚本提供）：
 *   $, Hls, CachedFragmentLoader, mediaCache, preloadManager,
 *   history, upsertHistory, showToast, getAuthToken, loadLibrary
 */

window.PlayerCore = (() => {
  // ═══ 播放器状态（双端共享） ═══
  let hls = null;
  let currentPlay = null;
  let lastSaveTime = 0;
  let userPaused = false;
  let playSession = 0;      // 播放会话代际：异步回调代际不匹配时丢弃，防止切换竞态
  let activeBlobUrl = null;  // 当前播放的 blob URL（切换/关闭时 revoke 防泄漏）

  // ═══ 双端差异注入 ═══
  // navigateTo(target): 切换页面（'browse' | 'private'）
  //   ios: 私密页手动 DOM 切换 / switchAppTo('browse')
  //   macos: ensureOpen(target === 'private' ? 'private' : 'browse')
  // setTitle(titleEl, title, target): 设置标题
  //   ios: 无条件 titleEl.textContent = title
  //   macos: 仅非私密时设置（私密模式不重新渲染列表）
  let navigateTo = (target) => {};
  let setTitle = (titleEl, title, target) => { titleEl.textContent = title; };

  function configure(opts) {
    if (opts.navigateTo) navigateTo = opts.navigateTo;
    if (opts.setTitle) setTitle = opts.setTitle;
  }

  // ═══ 播放器核心 ═══
  function openPlayer(title, src, id, target = 'browse') {
    const pfx = target === 'private' ? 'private' : '';
    const box = $(pfx ? 'privateInlinePlayer' : 'inlinePlayer');
    const titleEl = $(pfx ? 'privateInlinePlayerTitle' : 'inlinePlayerTitle');
    const video = $(pfx ? 'privateInlinePlayerVideo' : 'inlinePlayerVideo');
    navigateTo(target);
    setTitle(titleEl, title, target);
    box.hidden = false;
    userPaused = false;
    if (currentPlay) upsertHistory({ ...currentPlay, updatedAt: Date.now() });
    currentPlay = { id, title, src, time: 0, duration: 0, updatedAt: Date.now() };

    if (hls) { hls.destroy(); hls = null; }
    video.pause();
    video.removeAttribute('src');
    video.load();
    // ⚠️ 会话代际：本次播放的唯一标识，异步回调（mediaCache.get / hls 事件）
    // 必须代际匹配才生效，防止快速切换视频时旧回调覆盖新视频状态
    const session = ++playSession;
    if (activeBlobUrl) { URL.revokeObjectURL(activeBlobUrl); activeBlobUrl = null; }

    const isHls = /\.m3u8($|\?)/i.test(src);
    if (isHls && window.Hls && Hls.isSupported()) {
      // ⚠️ 使用局部 hlsInst 引用（而非全局 hls）：快速切换后全局 hls 已指向新实例，
      // 旧实例的 ERROR 事件若引用全局 hls 会误操作新实例
      const hlsInst = new Hls({ enableWorker: true, maxBufferLength: 60, fLoader: CachedFragmentLoader });
      hls = hlsInst;
      let fatalNetErrors = 0;
      hlsInst.loadSource(src);
      hlsInst.attachMedia(video);
      hlsInst.on(Hls.Events.ERROR, (_e, data) => {
        if (session !== playSession) return; // 已切换到其他视频，忽略过期事件
        if (data.fatal) {
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            // 退避重试：连续网络错误超过 3 次则放弃，避免无限 startLoad 重试卡死
            fatalNetErrors++;
            if (fatalNetErrors >= 3) {
              showToast('播放失败：网络不稳定，请重试', true);
              if (hlsInst) { hlsInst.destroy(); if (hls === hlsInst) hls = null; }
              return;
            }
            setTimeout(() => {
              if (session === playSession && hls === hlsInst) hlsInst.startLoad();
            }, Math.min(500 * fatalNetErrors, 2000));
          } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            hlsInst.recoverMediaError();
          } else {
            showToast('播放失败：流地址不可用', true);
          }
        }
      });
      // 启动预加载
      preloadManager.start(hlsInst);
      // 缓存状态指示器：更新缓存按钮标题
      preloadManager.onStatusUpdate((status) => {
        const btn = $(pfx ? 'privateCacheMenuBtn' : 'cacheMenuBtn');
        if (!btn) return;
        if (status.cached >= status.total) {
          btn.title = '全部已缓存 ✓';
          btn.classList.add('cached');
        } else if (status.cached + status.preloaded >= status.total) {
          btn.title = '已预加载 ' + (status.cached + status.preloaded) + '/' + status.total;
        } else if (status.cached > 0 || status.preloaded > 0) {
          btn.title = '已缓存 ' + status.cached + '/' + status.total + ' · 预加载 ' + status.preloaded;
        }
      });
    } else {
      // 非 HLS 流（mp4 直链），检查缓存
      mediaCache.get(src).then(cached => {
        if (session !== playSession) return; // 已切换视频，丢弃过期回调
        if (cached && cached.data) {
          const blob = cached.data instanceof Blob ? cached.data : new Blob([cached.data]);
          activeBlobUrl = URL.createObjectURL(blob);
          video.src = activeBlobUrl;
        } else {
          video.src = src;
        }
      });
    }

    const prev = history.find(h => h.id === id);
    video.onloadedmetadata = () => {
      if (session !== playSession || !currentPlay) return;
      currentPlay.duration = video.duration || 0;
      if (prev && prev.time > 3 && prev.time < (video.duration || Infinity) - 5) {
        video.currentTime = prev.time;
      }
      if (!userPaused) video.play().catch(() => {});
    };
    video.ontimeupdate = () => {
      if (session !== playSession || !currentPlay) return;
      currentPlay.time = video.currentTime || 0;
      currentPlay.duration = video.duration || 0;
      const now = Date.now();
      if (now - lastSaveTime > 5000) {
        lastSaveTime = now;
        upsertHistory({ ...currentPlay, updatedAt: now });
      }
    };
    video.onpause = () => { if (session === playSession && currentPlay) upsertHistory({ ...currentPlay, updatedAt: Date.now() }); };
    video.onended = () => {
      if (session !== playSession || !currentPlay) return;
      currentPlay.time = currentPlay.duration;
      upsertHistory({ ...currentPlay, updatedAt: Date.now() });
    };
    video.onerror = () => { if (session === playSession) showToast('播放失败：请确认链接可访问且格式受支持', true); };
  }

  function closePlayer(target = 'browse') {
    const pfx = target === 'private' ? 'private' : '';
    const box = $(pfx ? 'privateInlinePlayer' : 'inlinePlayer');
    const video = $(pfx ? 'privateInlinePlayerVideo' : 'inlinePlayerVideo');
    playSession++; // 使所有在途异步回调失效
    if (currentPlay) upsertHistory({ ...currentPlay, updatedAt: Date.now() });
    currentPlay = null;
    if (hls) { hls.destroy(); hls = null; }
    preloadManager.stop();
    // 回收 blob URL 防泄漏
    if (activeBlobUrl) { URL.revokeObjectURL(activeBlobUrl); activeBlobUrl = null; }
    // 恢复缓存按钮默认标题
    const b = $(pfx ? 'privateCacheMenuBtn' : 'cacheMenuBtn');
    if (b) { b.title = '缓存视频'; b.classList.remove('cached'); }
    video.pause();
    video.removeAttribute('src');
    video.load();
    box.hidden = true;
    if (target === 'browse') loadLibrary();
  }

  function closePrivatePlayerOnly() { closePlayer('private'); }

  function playLibrary(name) {
    const tk = getAuthToken();
    const q = tk ? `?token=${encodeURIComponent(tk)}` : '';
    openPlayer(name, `/downloads/${encodeURIComponent(name)}${q}`, `file:${name}`);
  }

  /** 私密 App 内播放：保持私密上下文（私密播放器） */
  function playPrivateVideo(name) {
    const tk = getAuthToken();
    const q = tk ? `?token=${encodeURIComponent(tk)}` : '';
    openPlayer(name, `/downloads/${encodeURIComponent(name)}${q}`, `file:${name}`, 'private');
  }

  function playUrl() {
    const url = $('playUrlInput').value.trim();
    if (!/^https?:\/\//i.test(url)) { showToast('请输入有效的 http(s) 链接', true); return; }
    openPlayer(url, url, `url:${url}`);
  }

  // ═══ 供双端区外代码访问的状态访问器 ═══
  function getCurrentPlay() { return currentPlay; }
  function setUserPaused(v) { userPaused = v; }
  function getUserPaused() { return userPaused; }
  function isHlsActive() { return !!hls; }

  return {
    configure, openPlayer, closePlayer, closePrivatePlayerOnly,
    playLibrary, playPrivateVideo, playUrl,
    getCurrentPlay, setUserPaused, getUserPaused, isHlsActive,
  };
})();
