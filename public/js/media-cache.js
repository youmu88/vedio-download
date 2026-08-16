/**
 * MediaCache — HLS 分片级缓存 + 预加载系统
 *
 * 核心能力：
 * 1. 分片级 IndexedDB 存储（ts/m4s），key 为分片 URL
 * 2. hls.js 自定义 fLoader，缓存优先加载
 * 3. 播放期间智能预加载后续分片
 * 4. 缓存按钮：预加载→升级为永久缓存，支持后台下载与进度
 * 5. 设置面板：显示缓存/预加载统计，一键清理
 *
 * @module media-cache
 */

const MEDIA_CACHE_DB = 'vd-media-cache-v2';
const MEDIA_CACHE_STORE = 'segments';

// 最大缓存字节数（500MB），超出自动 LRU 淘汰
const MAX_CACHE_BYTES = 500 * 1024 * 1024;

// ═══════════════════════════════════════════════════════
// IndexedDB 存储核心
// ═══════════════════════════════════════════════════════

const mediaCache = {
  _db: null,
  _initPromise: null,
  _cacheBytes: 0,
  _preloadBytes: 0,
  _cacheCount: 0,
  _preloadCount: 0,

  async _init() {
    if (this._initPromise) return this._initPromise;
    this._initPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(MEDIA_CACHE_DB, 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(MEDIA_CACHE_STORE)) {
          const store = db.createObjectStore(MEDIA_CACHE_STORE, { keyPath: 'url' });
          store.createIndex('type', 'type', { unique: false });
          store.createIndex('timestamp', 'timestamp', { unique: false });
        }
      };
      req.onsuccess = (e) => {
        this._db = e.target.result;
        this._db.onversionchange = () => { this._db.close(); };
        this._recalcStats();
        resolve();
      };
      req.onerror = (e) => reject(e.target.error);
    });
    return this._initPromise;
  },

  async _recalcStats() {
    if (!this._db) return;
    try {
      const tx = this._db.transaction(MEDIA_CACHE_STORE, 'readonly');
      const store = tx.objectStore(MEDIA_CACHE_STORE);
      const all = await new Promise((resolve) => {
        const result = [];
        store.openCursor().onsuccess = (e) => {
          const c = e.target.result;
          if (c) { result.push(c.value); c.continue(); }
          else resolve(result);
        };
      });
      this._cacheBytes = 0;
      this._preloadBytes = 0;
      this._cacheCount = 0;
      this._preloadCount = 0;
      for (const item of all) {
        if (item.type === 'cache') {
          this._cacheBytes += item.size;
          this._cacheCount++;
        } else {
          this._preloadBytes += item.size;
          this._preloadCount++;
        }
      }
    } catch (_) {}
  },

  async get(url) {
    await this._init();
    if (!this._db) return null;
    const tx = this._db.transaction(MEDIA_CACHE_STORE, 'readonly');
    const store = tx.objectStore(MEDIA_CACHE_STORE);
    return new Promise((resolve) => {
      store.get(url).onsuccess = (e) => resolve(e.target.result || null);
    });
  },

  async put(url, data, type = 'cache') {
    await this._init();
    if (!this._db) return;
    const size = data instanceof Blob ? data.size : data.byteLength;
    const tx = this._db.transaction(MEDIA_CACHE_STORE, 'readwrite');
    const store = tx.objectStore(MEDIA_CACHE_STORE);
    return new Promise((resolve, reject) => {
      // ⚠️ 只能 put 一次：onsuccess/onerror 必须绑定在同一个 request 上
      // （此前对同一事务执行两次 put，若首次失败则 promise 永不 settle，预加载挂死）
      const req = store.put({ url, data, type, timestamp: Date.now(), size });
      req.onsuccess = () => {
        this._recalcStats();
        // 自动 LRU 淘汰：超出上限时清理最旧的数据
        if (this._cacheBytes + this._preloadBytes > MAX_CACHE_BYTES) {
          this._prune(MAX_CACHE_BYTES * 0.7); // 缩到 70% 释放空间
        }
        resolve();
      };
      req.onerror = (e) => reject(e.target.error);
    });
  },

  async delete(url) {
    await this._init();
    if (!this._db) return;
    const tx = this._db.transaction(MEDIA_CACHE_STORE, 'readwrite');
    const store = tx.objectStore(MEDIA_CACHE_STORE);
    return new Promise((resolve) => {
      store.delete(url).onsuccess = () => { this._recalcStats(); resolve(); };
    });
  },

  async clear() {
    await this._init();
    if (!this._db) return;
    const tx = this._db.transaction(MEDIA_CACHE_STORE, 'readwrite');
    const store = tx.objectStore(MEDIA_CACHE_STORE);
    return new Promise((resolve) => {
      store.clear().onsuccess = () => {
        this._cacheBytes = 0;
        this._preloadBytes = 0;
        this._cacheCount = 0;
        this._preloadCount = 0;
        resolve();
      };
    });
  },

  async getStats() {
    await this._init();
    return {
      cacheBytes: this._cacheBytes,
      preloadBytes: this._preloadBytes,
      cacheCount: this._cacheCount,
      preloadCount: this._preloadCount,
      totalBytes: this._cacheBytes + this._preloadBytes,
    };
  },

  /** 将预加载分片升级为永久缓存 */
  async promote(url) {
    await this._init();
    if (!this._db) return;
    const tx = this._db.transaction(MEDIA_CACHE_STORE, 'readwrite');
    const store = tx.objectStore(MEDIA_CACHE_STORE);
    const existing = await new Promise((resolve) => {
      store.get(url).onsuccess = (e) => resolve(e.target.result || null);
    });
    if (existing && existing.type === 'preload') {
      existing.type = 'cache';
      existing.timestamp = Date.now();
      store.put(existing);
    }
  },

  /** 将所有预加载分片升级为永久缓存 */
  async promoteAll() {
    await this._init();
    if (!this._db) return;
    const tx = this._db.transaction(MEDIA_CACHE_STORE, 'readwrite');
    const store = tx.objectStore(MEDIA_CACHE_STORE);
    const index = store.index('type');
    return new Promise((resolve) => {
      index.openCursor('preload').onsuccess = (e) => {
        const c = e.target.result;
        if (c) {
          c.value.type = 'cache';
          c.value.timestamp = Date.now();
          c.update(c.value);
          c.continue();
        } else {
          this._recalcStats();
          resolve();
        }
      };
    });
  },

  /** 获取所有指定类型的 URL 列表 */
  async getUrlsByType(type) {
    await this._init();
    if (!this._db) return [];
    const tx = this._db.transaction(MEDIA_CACHE_STORE, 'readonly');
    const store = tx.objectStore(MEDIA_CACHE_STORE);
    const index = store.index('type');
    return new Promise((resolve) => {
      const urls = [];
      index.openCursor(type).onsuccess = (e) => {
        const c = e.target.result;
        if (c) { urls.push(c.value.url); c.continue(); }
        else resolve(urls);
      };
    });
  },

  /** 获取所有 URL 列表 */
  async getAllUrls() {
    await this._init();
    if (!this._db) return [];
    const tx = this._db.transaction(MEDIA_CACHE_STORE, 'readonly');
    const store = tx.objectStore(MEDIA_CACHE_STORE);
    return new Promise((resolve) => {
      const urls = [];
      store.openCursor().onsuccess = (e) => {
        const c = e.target.result;
        if (c) { urls.push(c.value.url); c.continue(); }
        else resolve(urls);
      };
    });
  },

  /**
   * LRU 淘汰：删除最旧的条目直到总大小 ≤ targetBytes
   * 优先淘汰 preload 类型，再淘汰 cache 类型
   */
  async _prune(targetBytes) {
    if (!this._db) return;
    const tx = this._db.transaction(MEDIA_CACHE_STORE, 'readwrite');
    const store = tx.objectStore(MEDIA_CACHE_STORE);
    const all = await new Promise((resolve) => {
      const result = [];
      store.openCursor().onsuccess = (e) => {
        const c = e.target.result;
        if (c) { result.push(c.value); c.continue(); }
        else resolve(result);
      };
    });
    // 按时间戳排序（最旧在前），preload 优先淘汰
    all.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'preload' ? -1 : 1;
      return a.timestamp - b.timestamp;
    });
    let total = all.reduce((s, i) => s + i.size, 0);
    for (const item of all) {
      if (total <= targetBytes) break;
      store.delete(item.url);
      total -= item.size;
    }
    this._recalcStats();
  },

  /** 获取指定 URL 集合的缓存状态 */
  async getBulkStatus(urls) {
    await this._init();
    if (!this._db || !urls.length) return { cached: 0, preloaded: 0, total: urls.length };
    const tx = this._db.transaction(MEDIA_CACHE_STORE, 'readonly');
    const store = tx.objectStore(MEDIA_CACHE_STORE);
    let cached = 0;
    let preloaded = 0;
    for (const url of urls) {
      const item = await new Promise((resolve) => {
        store.get(url).onsuccess = (e) => resolve(e.target.result || null);
      });
      if (item) {
        if (item.type === 'cache') cached++;
        else preloaded++;
      }
    }
    return { cached, preloaded, total: urls.length };
  },
};

// ═══════════════════════════════════════════════════════
// 带宽估算器（用于动态调整预加载速率）
// ═══════════════════════════════════════════════════════

const bandwidthEstimator = {
  _samples: [],
  _maxSamples: 10,

  /** 记录一次下载的字节数和耗时（ms） */
  record(bytes, durationMs) {
    if (durationMs <= 0) return;
    const bps = (bytes * 1000) / durationMs; // bytes/sec
    this._samples.push(bps);
    if (this._samples.length > this._maxSamples) {
      this._samples.shift();
    }
  },

  /** 获取估算带宽（bytes/sec），取中位数抗抖动 */
  estimate() {
    if (this._samples.length === 0) return 500 * 1024; // 默认 500 KB/s
    const sorted = [...this._samples].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  },

  /** 根据带宽估算推荐并发预加载数 */
  recommendedBatchSize() {
    const bps = this.estimate();
    if (bps > 5 * 1024 * 1024) return 8;   // >5MB/s
    if (bps > 2 * 1024 * 1024) return 5;   // >2MB/s
    if (bps > 500 * 1024) return 3;         // >500KB/s
    return 2;                                 // 慢速
  },

  reset() {
    this._samples = [];
  },
};

// ═══════════════════════════════════════════════════════
// hls.js 自定义分片加载器（fLoader）
// ═══════════════════════════════════════════════════════

class CachedFragmentLoader {
  constructor(config) {
    this._defaultLoader = new (Hls.DefaultConfig.loader)(config);
    this._abortController = null;
    this._aborted = false;
  }

  load(context, config, callbacks) {
    // 仅处理分片加载（frag），不拦截 manifest/key
    if (context.type === 'frag' && context.frag && context.url) {
      const url = context.url;
      this._aborted = false;
      mediaCache.get(url).then(cached => {
        if (this._aborted) return; // 已被 abort，丢弃过期回调
        if (cached && cached.data) {
          // ⚠️ 缓存命中必须转 ArrayBuffer：hls.js 对 payload 执行 new Uint8Array(data)，
          // 传 Blob 会得到空数组导致分片解析失败（seek 到已缓存区域即中断）
          const blob = cached.data instanceof Blob ? cached.data : new Blob([cached.data]);
          blob.arrayBuffer().then(buf => {
            if (this._aborted) return;
            const now = performance.now();
            callbacks.onSuccess(
              { url, data: buf },
              { trequest: now - 10, tfirst: now - 5, tload: now, loaded: buf.byteLength, total: buf.byteLength },
              context,
              null
            );
          }).catch(err => {
            if (this._aborted) return;
            callbacks.onError({ url, message: err.message, code: 0 }, context, null);
          });
          return;
        }
        // 缓存未命中，走网络
        this._loadNetwork(context, config, callbacks, url);
      });
      return;
    }
    // 非分片请求直接走默认
    this._defaultLoader.load(context, config, callbacks);
  }

  _loadNetwork(context, config, callbacks, url) {
    this._abortController = new AbortController();
    const signal = this._abortController.signal;

    fetch(url, {
      signal,
      headers: { 'Range': 'bytes=0-' },
      credentials: 'omit',
    }).then(res => {
      if (!res.ok && res.status !== 206) {
        throw new Error(`HTTP ${res.status}`);
      }
      return res.arrayBuffer();
    }).then(data => {
      if (this._aborted) return;
      const now = performance.now();
      const blob = new Blob([data]);
      // 如果当前正在缓存，存为永久；否则存为预加载
      const storeType = preloadManager._isCaching ? 'cache' : 'preload';
      mediaCache.put(url, blob, storeType).catch(() => {});

      callbacks.onSuccess(
        { url, data },
        { trequest: now - 100, tfirst: now - 50, tload: now, loaded: data.byteLength, total: data.byteLength },
        context,
        null
      );
    }).catch(err => {
      if (err.name === 'AbortError') return;
      if (this._aborted) return;
      callbacks.onError(
        { url, message: err.message, code: 0 },
        context,
        null
      );
    });
  }

  abort() {
    // ⚠️ 不能调用 this._defaultLoader.abort()：hls.js 的 abort 流程会触发
    // onAbort → resetLoader → destroy() → 本 abort() → _defaultLoader.abort() → onAbort…
    // 无限递归导致 Maximum call stack size exceeded（已实测复现）。
    // 只需取消自身的 fetch 并标记，让过期回调被丢弃。
    this._aborted = true;
    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }
  }

  destroy() {
    this.abort();
    this._defaultLoader.destroy();
  }

  get stats() {
    return this._defaultLoader.stats;
  }
}

// ═══════════════════════════════════════════════════════
// 预加载管理器
// ═══════════════════════════════════════════════════════

const preloadManager = {
  _hls: null,
  _timer: null,
  _active: false,
  _isCaching: false,       // 是否正在执行缓存操作
  _cacheQueue: [],          // 待缓存的分片 URL 队列
  _cacheTotal: 0,
  _cacheDone: 0,
  _onCacheProgress: null,  // 缓存进度回调
  _preloadedUrls: new Set(),
     _fragmentList: [],        // 当前 HLS 分片列表
  _fragmentTimes: [],       // 分片起始时间（seek 感知预加载用）
  _statusTimer: null,        // 缓存状态更新定时器
  _onStatusUpdate: null,     // 缓存状态回调
  _abortCtrl: null,          // 在途预加载请求的取消控制器
  _preloadSeq: 0,            // 预加载轮次号（丢弃过期轮次结果）

  /** 启动预加载，绑定到 hls 实例 */
  start(hls) {
    this.stop();
    this._hls = hls;
    this._active = true;
    this._fragmentList = [];
    this._fragmentTimes = [];
    this._preloadedUrls.clear();
    bandwidthEstimator.reset();

    // 监听分片列表加载完成
    hls.on(Hls.Events.LEVEL_LOADED, (_e, data) => {
      if (data.details && data.details.fragments) {
        // 记录每个分片的起始时间，供 seek 感知预加载定位
        let acc = 0;
        this._fragmentTimes = [];
        this._fragmentList = data.details.fragments.map(f => {
          const rec = {
            url: f.url || (f._url || f.relurl),
            sn: f.sn,
            duration: f.duration || 0,
            start: acc,
          };
          acc += (f.duration || 0);
          this._fragmentTimes.push(acc);
          return rec;
        }).filter(f => f.url);
        // 分片列表更新后立即刷新缓存状态
        this._updateStatus();
      }
    });

    // 监听分片加载完成（标记已加载的不用预加载）
    hls.on(Hls.Events.FRAG_LOADED, (_e, data) => {
      if (data.frag && data.frag.url) {
        this._preloadedUrls.add(data.frag.url);
        this._updateStatus();
      }
    });

    // 启动定时预加载
    this._schedule();
  },

  stop() {
    this._active = false;
    // 取消所有在途预加载请求（切换视频/关闭播放器时立即释放带宽与连接）
    if (this._abortCtrl) {
      this._abortCtrl.abort();
      this._abortCtrl = null;
    }
    this._preloadSeq++; // 使过期轮次的结果全部失效
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (this._statusTimer) {
      clearTimeout(this._statusTimer);
      this._statusTimer = null;
    }
    this._hls = null;
  },

  _schedule() {
    if (!this._active) return;
    // 动态间隔：带宽高时延长间隔，带宽低时缩短
    const bps = bandwidthEstimator.estimate();
    const interval = Math.max(1000, Math.min(5000, Math.round(2e7 / bps)));
    this._timer = setTimeout(() => this._preloadNext(), interval);
  },

  async _preloadNext() {
    if (!this._active || !this._hls) return;

    // 获取当前播放进度
    const video = this._hls.media;
    if (!video || video.paused || video.ended) {
      this._schedule();
      return;
    }

    const currentTime = video.currentTime || 0;
    const buffered = video.buffered;

    // 计算当前缓冲末端
    let bufferedEnd = currentTime;
    if (buffered && buffered.length > 0) {
      bufferedEnd = buffered.end(buffered.length - 1);
    }

    // ⚠️ seek 感知：优先预加载当前播放位置附近的未缓存分片，
    // 而不是永远从列表头开始（此前快进后仍在预加载开头分片，浪费带宽且对快进无帮助）
    let pendingFragments = this._fragmentList.filter(f => {
      return !this._preloadedUrls.has(f.url);
    });

    // 找出最接近当前播放位置、且尚未预加载的分片（按起始时间排序取前 batchSize）
    const horizon = Math.max(currentTime, bufferedEnd - 2);
    pendingFragments.sort((a, b) => {
      const da = Math.max(0, a.start - horizon);
      const db = Math.max(0, b.start - horizon);
      return da - db;
    });

    // 动态批量大小：根据带宽自动调整
    const batchSize = bandwidthEstimator.recommendedBatchSize();
    const toPreload = pendingFragments.slice(0, batchSize);

    if (toPreload.length === 0) {
      this._schedule();
      return;
    }

    // 本轮代际：结果只有在代际一致时才生效（防止切换视频后旧轮次覆盖）
    const seq = this._preloadSeq;
    const abortCtrl = new AbortController();
    this._abortCtrl = abortCtrl;
    const signal = abortCtrl.signal;

    // 并行预加载（使用带宽估算记录耗时）
    const startTime = performance.now();
    let totalBytes = 0;

    await Promise.all(toPreload.map(async (frag) => {
      if (!this._active || seq !== this._preloadSeq) return;
      if (this._preloadedUrls.has(frag.url)) return;
      try {
        const cached = await mediaCache.get(frag.url);
        if (cached) {
          this._preloadedUrls.add(frag.url);
          return;
        }
        const res = await fetch(frag.url, { credentials: 'omit', signal });
        if (!res.ok && res.status !== 206) return;
        const data = await res.arrayBuffer();
        if (!this._active || seq !== this._preloadSeq) return; // 已切换，丢弃
        totalBytes += data.byteLength;
        const blob = new Blob([data]);
        const storeType = this._isCaching ? 'cache' : 'preload';
        await mediaCache.put(frag.url, blob, storeType);
        this._preloadedUrls.add(frag.url);
      } catch (_) { /* AbortError 或网络错误静默忽略 */ }
    }));

    if (!this._active || seq !== this._preloadSeq) return; // 已切换/停止，丢弃本轮

    // 记录带宽样本
    if (totalBytes > 0) {
      const elapsed = performance.now() - startTime;
      bandwidthEstimator.record(totalBytes, elapsed);
    }

    this._updateStatus();
    this._schedule();
  },

  /** 开始缓存整个视频 */
  async startCache(onProgress) {
    this._isCaching = true;
    this._onCacheProgress = onProgress;

    // 先升级所有已预加载的分片为永久缓存
    await mediaCache.promoteAll();

    // 收集所有分片 URL
    const allUrls = this._fragmentList.map(f => f.url).filter(Boolean);
    const cachedUrls = await mediaCache.getAllUrls();
    const cachedSet = new Set(cachedUrls);

    // 找出未缓存的分片
    this._cacheQueue = allUrls.filter(u => !cachedSet.has(u));
    this._cacheTotal = this._cacheQueue.length + this._fragmentList.length;
    this._cacheDone = this._fragmentList.length - this._cacheQueue.length;

    if (this._cacheQueue.length === 0) {
      if (onProgress) onProgress(100);
      this._isCaching = false;
      return;
    }

    // 后台批量下载
    this._processCacheQueue();
  },

  async _processCacheQueue() {
    const batchSize = 3;
    this._abortCtrl = new AbortController();
    const signal = this._abortCtrl.signal;
    while (this._cacheQueue.length > 0 && this._isCaching) {
      const batch = this._cacheQueue.splice(0, batchSize);
      await Promise.all(batch.map(url => this._cacheOne(url, signal)));
      const pct = Math.min(99, Math.round((this._cacheDone / this._cacheTotal) * 100));
      if (this._onCacheProgress) this._onCacheProgress(pct);
    }
    if (this._isCaching) {
      this._isCaching = false;
      if (this._onCacheProgress) this._onCacheProgress(100);
    }
  },

  async _cacheOne(url, signal) {
    try {
      const res = await fetch(url, { credentials: 'omit', signal });
      if (!res.ok && res.status !== 206) return;
      const data = await res.arrayBuffer();
      const blob = new Blob([data]);
      await mediaCache.put(url, blob, 'cache');
    } catch (_) {}
    this._cacheDone++;
  },

  stopCache() {
    this._isCaching = false;
    this._cacheQueue = [];
    if (this._abortCtrl) {
      this._abortCtrl.abort();
      this._abortCtrl = null;
    }
  },

  get isCaching() { return this._isCaching; },

  /** 设置缓存状态回调（播放器栏显示缓存进度） */
  onStatusUpdate(cb) {
    this._onStatusUpdate = cb;
  },

  /** 刷新缓存状态并通知回调 */
  async _updateStatus() {
    if (!this._onStatusUpdate) return;
    if (this._fragmentList.length === 0) return;
    const urls = this._fragmentList.map(f => f.url).filter(Boolean);
    if (urls.length === 0) return;
    const status = await mediaCache.getBulkStatus(urls);
    this._onStatusUpdate(status);
  },

  /** 获取当前视频的缓存状态 */
  async getVideoStatus() {
    const urls = this._fragmentList.map(f => f.url).filter(Boolean);
    if (urls.length === 0) return null;
    return mediaCache.getBulkStatus(urls);
  },
};

// ═══════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return val.toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
}

// ═══════════════════════════════════════════════════════
// 全局 API（供 HTML 页面调用）
// ═══════════════════════════════════════════════════════

window.mediaCache = mediaCache;
window.preloadManager = preloadManager;
window.CachedFragmentLoader = CachedFragmentLoader;
window.formatBytes = formatBytes;
window.bandwidthEstimator = bandwidthEstimator;

/** 刷新缓存统计显示 */
async function refreshCacheStats(displayEl) {
  try {
    const stats = await mediaCache.getStats();
    const parts = [];
    if (stats.cacheCount > 0) parts.push('缓存 ' + stats.cacheCount + ' 项 · ' + formatBytes(stats.cacheBytes));
    if (stats.preloadCount > 0) parts.push('预加载 ' + stats.preloadCount + ' 项 · ' + formatBytes(stats.preloadBytes));
    if (parts.length === 0) parts.push('无缓存');
    if (displayEl) displayEl.textContent = parts.join(' / ');
    return stats;
  } catch (_) {
    if (displayEl) displayEl.textContent = '—';
    return null;
  }
}

window.refreshCacheStats = refreshCacheStats;

/** 一键清理所有缓存 */
async function clearAllCache() {
  await mediaCache.clear();
  refreshCacheStats(document.getElementById('cacheStats'));
}

window.clearAllCache = clearAllCache;
