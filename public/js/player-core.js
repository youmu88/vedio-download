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
  let currentStream = null;  // 当前边转边播会话 { streamId, name, pfx }（状态条/取消/seek 提示的依据）
  let streamConvertedSec = 0; // 会话已转换秒数（socket 推送更新；seek 提示与进度显示用）
  let lastSeekWarnAt = 0;     // seek 超界提示节流

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
    removeTranscodeNotice(pfx); // 新播放会话开始时清掉上一轮的转码提示条
    // 新播放会话开始时清掉上一轮的边转边播状态条；非流式播放则解除会话上下文
    // （会话本体不受影响：按「转完为止」策略后台继续转换，仅停止 UI 跟进）
    removeStreamStatus(pfx);
    if (!(typeof id === 'string' && id.startsWith('stream:'))) currentStream = null;
    detachSilentFailDetector(video); // 同理拆掉上一会话的静默弃轨检测
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
      // ⭐ 边转边播流（/api/stream/）：startPosition:0 从第 0 秒起播（EVENT 列表默认会跳到直播边缘）；
      //   initialLiveManifestSize:1 首个分片就绪即可起播（首屏约 5 秒）
      const streamCfg = /\/api\/stream\//.test(src)
        ? { startPosition: 0, initialLiveManifestSize: 1 }
        : {};
      const hlsInst = new Hls({ enableWorker: true, maxBufferLength: 60, fLoader: CachedFragmentLoader, ...streamCfg });
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
      // ⭐ 主动触发模型（替代旧「被动等 onerror」）：库内「需转码」文件点击即预判——
      // 服务端 ffprobe 编码 × 客户端 canPlayType，不可播直接给转码入口，不再让用户先看黑屏；
      // 同时挂上静默弃轨检测，覆盖探测判「可播」但实际零帧输出的浮动面
      if (typeof id === 'string' && id.startsWith('file:') && needsTranscode(title)) {
        probeLibraryPlayability(session, pfx, title);
        attachSilentFailDetector(session, pfx, title, video);
      }
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
    video.onseeking = () => {
      if (session !== playSession || !currentStream) return;
      // 边转边播会话：目标超出已转换范围 → 提示（内容尚不存在，播放会停在转换前沿）
      if (streamConvertedSec > 0 && video.currentTime > streamConvertedSec + 3) {
        const now = Date.now();
        if (now - lastSeekWarnAt > 4000) {
          lastSeekWarnAt = now;
          showToast(`该位置尚未转换完成（已转换到 ${fmtSec(streamConvertedSec)}）`);
        }
      }
    };
    video.onerror = () => {
      if (session !== playSession) return;
      // ⭐ 兜底信号（三信号之一）：主动预判/静默检测之外的显式失败（如 WebKit 拒收
      // matroska 容器、文件损坏）仍走 error 事件 → 触发边转边播而非裸报错
      if (currentPlay && typeof currentPlay.id === 'string' && currentPlay.id.startsWith('file:')
        && needsTranscode(currentPlay.title)) {
        startStreamAndPlay(pfx, currentPlay.title);
      } else {
        showToast('播放失败：请确认链接可访问且格式受支持', true);
      }
    };
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
    detachSilentFailDetector(video);
    removeTranscodeNotice(pfx);
    removeStreamStatus(pfx);
    box.hidden = true;
    if (target === 'browse') loadLibrary();
  }

  function closePrivatePlayerOnly() { closePlayer('private'); }

  /**
   * 库内相对路径（可能含子目录，如 `子目录/视频.mp4`）→ URL 路径。
   * 逐段 encodeURIComponent 而非整体编码：保留 `/` 作为路径分隔符，
   * 交给 express.static 正常映射到账号目录内的子路径。
   */
  function encodeLibraryPath(name) {
    return String(name || '').split('/').map(encodeURIComponent).join('/');
  }

  function playLibrary(name) {
    const tk = getAuthToken();
    const q = tk ? `?token=${encodeURIComponent(tk)}` : '';
    openPlayer(name, `/downloads/${encodeLibraryPath(name)}${q}`, `file:${name}`);
  }

  /** 私密 App 内播放：保持私密上下文（私密播放器） */
  function playPrivateVideo(name) {
    const tk = getAuthToken();
    const q = tk ? `?token=${encodeURIComponent(tk)}` : '';
    openPlayer(name, `/downloads/${encodeLibraryPath(name)}${q}`, `file:${name}`, 'private');
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

  // ═══ MKV 等不可直播格式的服务端转码 ═══
  // 浏览器 <video> 无法直接播放的容器/编码（.ts 容器 Chrome/Firefox 不支持；白名单已拦在库外）
  //
  // 转码入口触发模型（三信号，单一入口 showTranscodeNotice）：
  //   1. 主动预判（主）：点击「需转码」文件即 ffprobe 编码 × canPlayType 判定，不可播直接给入口；
  //   2. 静默弃轨检测：Chromium 对「容器可 demux + 编码不可解」是 canplaythrough 照发、
  //      videoWidth 恒 0、零帧输出且不抛 error —— loadeddata/canplaythrough 后仍无画面即给入口；
  //   3. onerror 兜底：显式失败（容器拒收/损坏文件）保留旧链路。
  // 旧「仅 onerror 驱动」模型已被上列替代删除（根因：Chromium 静默失败不抛 error，入口结构性不可达）。
  const TRANSCODE_EXTS = new Set(['.mkv', '.ts', '.avi', '.wmv', '.flv', '.mpg', '.mpeg', '.vob', '.3gp']);

  function extOf(name) {
    return (String(name || '').match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();
  }

  /** 该文件是否需要服务端转码才能播放（供浏览页渲染「需转码」标记复用） */
  function needsTranscode(name) {
    return TRANSCODE_EXTS.has(extOf(name));
  }

  // ── 主动可播性判定：容器/编码 → MIME，交浏览器 canPlayType ──
  // 只判视频轨：不支持的音轨浏览器会静默弃轨照常出画面（复现报告 C 形态实证），不构成「不可播」
  const CONTAINER_MIME = {
    '.mkv': 'video/x-matroska', '.mp4': 'video/mp4', '.webm': 'video/webm',
    '.mov': 'video/quicktime', '.ts': 'video/mp2t', '.avi': 'video/x-msvideo',
    '.wmv': 'video/x-ms-wmv', '.flv': 'video/x-flv', '.mpg': 'video/mpeg',
    '.mpeg': 'video/mpeg', '.vob': 'video/mpeg', '.3gp': 'video/3gpp',
  };
  const VIDEO_CODEC_MIME = {
    h264: 'avc1.42E01E', avc1: 'avc1.42E01E',
    hevc: 'hvc1.1.6.L93.B0', h265: 'hvc1.1.6.L93.B0',
    vp9: 'vp09.00.10.08', vp8: 'vp8', av1: 'av01.0.05M.08',
    mpeg4: 'mp4v.20.8',
  };

  /** 客户端能力判定：服务端探测到的编码 × 本浏览器 canPlayType（浮动面：同 HEVC 真机硬解可直解） */
  function clientCanPlay(ext, videoCodec) {
    const container = CONTAINER_MIME[ext];
    if (!container) return false;  // 未知容器：判不可播，交给转码
    if (!videoCodec) return false; // 无视频流（纯音频）：同样给转码入口
    const cs = VIDEO_CODEC_MIME[videoCodec];
    const type = cs ? `${container}; codecs="${cs}"` : container;
    const verdict = document.createElement('video').canPlayType(type);
    return verdict === 'probably' || verdict === 'maybe';
  }

  /** 点击「需转码」文件即预判：服务端 ffprobe 编码 × 客户端能力 → 不可播直接启动边转边播 */
  async function probeLibraryPlayability(session, pfx, title) {
    let info = null;
    try {
      const tk = getAuthToken();
      const res = await fetch(`/api/media-info?name=${encodeURIComponent(title)}${tk ? `&token=${encodeURIComponent(tk)}` : ''}`);
      if (res.ok) info = await res.json().catch(() => null);
    } catch { /* 探测失败不阻塞播放：交由静默检测 / onerror 兜底 */ }
    if (session !== playSession || !info) return;
    // ⭐ 点击即触发（替代旧「手动点按钮等全量转码」）：不可播直接启动边转边播会话
    if (!clientCanPlay(extOf(title), info.videoCodec)) startStreamAndPlay(pfx, title);
  }

  // ── 静默弃轨检测（信号 2）：videoWidth 恒 0 且无 error → 触发边转边播 ──
  // 处理器按 video 元素登记，openPlayer 重挂 / closePlayer 拆除，不累积
  const silentFailHandlers = new Map();

  function attachSilentFailDetector(session, pfx, title, video) {
    detachSilentFailDetector(video);
    const handler = () => {
      if (session !== playSession || video.error) return;
      if (video.readyState >= 3 && video.videoWidth === 0) startStreamAndPlay(pfx, title);
    };
    silentFailHandlers.set(video, handler);
    video.addEventListener('loadeddata', handler);
    video.addEventListener('canplaythrough', handler);
  }

  function detachSilentFailDetector(video) {
    const h = silentFailHandlers.get(video);
    if (!h) return;
    video.removeEventListener('loadeddata', h);
    video.removeEventListener('canplaythrough', h);
    silentFailHandlers.delete(video);
  }

  function removeTranscodeNotice(pfx) {
    const box = $(pfx ? 'privateInlinePlayer' : 'inlinePlayer');
    box?.querySelector('.transcode-notice')?.remove();
  }

  /** 边转边播启动失败时的兜底入口：播放器盒内提示条 + 「开始边转边播」按钮 */
  function showTranscodeNotice(pfx, name) {
    const box = $(pfx ? 'privateInlinePlayer' : 'inlinePlayer');
    if (!box || box.querySelector('.transcode-notice')) return;
    const bar = document.createElement('div');
    bar.className = 'transcode-notice';
    bar.setAttribute('style', 'display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 12px;'
      + 'background:rgba(255,204,0,.12);border-top:1px solid rgba(255,204,0,.35);font-size:13px;');
    const label = document.createElement('span');
    label.textContent = `${extOf(name).toUpperCase()} 格式浏览器无法直接播放，可边转边播观看`;
    const btn = document.createElement('button');
    btn.textContent = '开始边转边播';
    btn.setAttribute('style', 'flex-shrink:0;padding:4px 12px;border:none;border-radius:14px;'
      + 'background:var(--accent,#0a84ff);color:#fff;font-size:13px;cursor:pointer;');
    btn.addEventListener('click', () => { bar.remove(); startStreamAndPlay(pfx, name); });
    bar.appendChild(label);
    bar.appendChild(btn);
    box.appendChild(bar);
  }

  // ── 边转边播：会话启动 + 状态条（进度/停止） + socket 事件订阅 ──
  // （全面替代旧「全量转码完成才播」模型：点击不可播文件 → 启动流式会话 → 从第 0 秒起播，
  //   转换在后台限速进行且始终领先播放；完成后自动合封 MP4 入库）

  function fmtSec(sec) {
    const s = Math.max(0, Math.round(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  }

  function streamStatusEl(pfx) {
    const box = $(pfx ? 'privateInlinePlayer' : 'inlinePlayer');
    return box ? box.querySelector('.stream-status') : null;
  }

  /** 展示/更新边转边播状态条（含「停止转换」按钮；同一播放器盒内单实例） */
  function showStreamStatus(pfx, text) {
    const box = $(pfx ? 'privateInlinePlayer' : 'inlinePlayer');
    if (!box) return;
    let bar = box.querySelector('.stream-status');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'stream-status';
      bar.setAttribute('style', 'display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 12px;'
        + 'background:rgba(10,132,255,.12);border-top:1px solid rgba(10,132,255,.35);font-size:13px;');
      const label = document.createElement('span');
      label.className = 'stream-status-text';
      const btn = document.createElement('button');
      btn.className = 'stream-cancel';
      btn.textContent = '停止转换';
      btn.setAttribute('style', 'flex-shrink:0;padding:4px 12px;border:none;border-radius:14px;'
        + 'background:rgba(255,255,255,.18);color:inherit;font-size:13px;cursor:pointer;');
      btn.addEventListener('click', cancelCurrentStream);
      bar.appendChild(label);
      bar.appendChild(btn);
      box.appendChild(bar);
    }
    bar.querySelector('.stream-status-text').textContent = text;
  }

  function updateStreamStatus(pfx, text) {
    const el = streamStatusEl(pfx);
    if (el) el.querySelector('.stream-status-text').textContent = text;
  }

  function removeStreamStatus(pfx) {
    const box = $(pfx ? 'privateInlinePlayer' : 'inlinePlayer');
    if (box) box.querySelector('.stream-status')?.remove();
  }

  /** 停止后台转换（用户手动取消；会话终止、分片稍后由清理器回收，仅能观看已转换部分） */
  function cancelCurrentStream() {
    if (!currentStream) return;
    const { streamId, pfx } = currentStream;
    fetch(`/api/stream/${streamId}/cancel`, { method: 'POST' })
      .then((r) => r.json().catch(() => ({})))
      .then(() => { showToast('已停止后台转换（仅可观看已转换部分）'); removeStreamStatus(pfx); })
      .catch((err) => showToast(`停止失败：${err.message}`, true));
  }

  // 会话进度经 socket → macos.js/ios.js 转发为 window CustomEvent，此处按 streamId 订阅
  window.addEventListener('transcode-status', (ev) => {
    const s = ev.detail || {};
    if (!currentStream || s.streamId !== currentStream.streamId) return;
    if (s.status === 'running') {
      streamConvertedSec = s.convertedSec || 0;
      updateStreamStatus(currentStream.pfx, `后台转换中 ${s.progress ?? 0}%（已转换 ${fmtSec(streamConvertedSec)}）`);
    } else if (s.status === 'finalizing') {
      updateStreamStatus(currentStream.pfx, '转换完成，封装入库中…');
    } else if (s.status === 'done') {
      if (s.durationSec) streamConvertedSec = s.durationSec;
      removeStreamStatus(currentStream.pfx);
      showToast('转换完成，MP4 已入库');
    } else if (s.status === 'failed') {
      removeStreamStatus(currentStream.pfx);
      showToast(`转换失败：${s.error || '未知错误'}`, true);
    } else if (s.status === 'cancelled') {
      removeStreamStatus(currentStream.pfx);
    }
  });

  /** 等待播放列表出现首个分片（转换启动约 2-5 秒；404=尚未生成，继续轮询） */
  async function waitPlaylistReady(url, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (res.ok) {
          const text = await res.text();
          if (text.includes('#EXTINF')) return true;
        }
      } catch { /* 网络瞬态错误继续轮询 */ }
      await new Promise((r) => setTimeout(r, 700));
    }
    return false;
  }

  /** 起播边转边播流：等待首分片 → 用 HLS 播放器打开（src 指向 /api/stream/…） */
  async function playStream(pfx, name, streamId, playlistPath) {
    const tk = getAuthToken();
    const url = `${playlistPath}${tk ? `?token=${encodeURIComponent(tk)}` : ''}`;
    showStreamStatus(pfx, '边转边播启动中…');
    const ready = await waitPlaylistReady(url, 25000);
    if (!ready) {
      removeStreamStatus(pfx);
      showToast('流启动超时，请重试', true);
      showTranscodeNotice(pfx, name);
      return;
    }
    currentStream = { streamId, name, pfx };
    streamConvertedSec = 0;
    openPlayer(name, url, `stream:${streamId}`, pfx === 'private' ? 'private' : 'browse');
    updateStreamStatus(pfx, '边转边播中…');
  }

  /**
   * 点击「需转码」文件即触发边转边播（替代旧「等全量转码完成」）：
   *   200 → 起播流；409 exists → 直接播 MP4 产物；409 running → 起播现有会话流；
   *   失败 → 落回手动「边转边播」入口（showTranscodeNotice）并提示原因
   */
  let startingStreamName = null; // 启动中的文件名：探测+静默检测双信号并发时防重复 POST
  async function startStreamAndPlay(pfx, name) {
    if (startingStreamName === name) return;
    if (currentStream && currentStream.name === name
      && currentPlay && currentPlay.id === `stream:${currentStream.streamId}`) return; // 同一文件正在播流
    startingStreamName = name;
    try {
      const res = await fetch('/api/transcode', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // ⭐ 409 续接：产物已存在（如用户重进页面）→ 直接播产物；转换中 → 起播现有会话流
        if (res.status === 409 && data.output) {
          if (data.code === 'exists') {
            showToast('转码产物已存在，直接播放');
            playLibrary(data.output);
            return;
          }
          if (data.code === 'running' && data.playlist && data.streamId) {
            await playStream(pfx, name, data.streamId, data.playlist);
            return;
          }
        }
        showToast(data.error || `转换请求失败 (${res.status})`, true);
        showTranscodeNotice(pfx, name);
        return;
      }
      await playStream(pfx, name, data.streamId, data.playlist);
    } catch (err) {
      showToast(`转换请求失败: ${err.message}`, true);
      showTranscodeNotice(pfx, name);
    } finally {
      if (startingStreamName === name) startingStreamName = null;
    }
  }

  return {
    configure, openPlayer, closePlayer, closePrivatePlayerOnly,
    playLibrary, playPrivateVideo, playUrl,
    getCurrentPlay, setUserPaused, getUserPaused, isHlsActive,
    needsTranscode,
  };
})();
