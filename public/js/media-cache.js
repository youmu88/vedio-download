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
      store.put({ url, data, type, timestamp: Date.now(), size }).onsuccess = () => {
        this._recalcStats();
        // 自动 LRU 淘汰：超出上限时清理最旧的数据
        if (this._cacheBytes + this._preloadBytes > MAX_CACHE_BYTES) {
          this._prune(MAX_CACHE_BYTES * 0.7); // 缩到 70% 释放空间
        }
        resolve();
      };
      store.put({ url, data, type, timestamp: Date.now(), size }).onerror = (e) => reject(e.target.error);
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
  }

  load(context, config, callbacks) {
    // 仅处理分片加载（frag），不拦截 manifest/key
    if (context.type === 'frag' && context.frag && context.url) {
      const url = context.url;
      mediaCache.get(url).then(cached => {
        if (cached && cached.data) {
          // 缓存命中
          const data = cached.data instanceof Blob ? cached.data : new Blob([cached.data]);
          const now = performance.now();
          callbacks.onSuccess(
            { url, data },
            { trequest: now - 10, tfirst: now - 5, tload: now, loaded: data.size, total: data.size },
            context,
            null
          );
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
      callbacks.onError(
        { url, message: err.message, code: 0 },
        context,
        null
      );
    });
  }

  abort() {
    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }
    this._defaultLoader.abort();
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
  _statusTimer: null,        // 缓存状态更新定时器
  _onStatusUpdate: null,     // 缓存状态回调

  /** 启动预加载，绑定到 hls 实例 */
  start(hls) {
    this.stop();
    this._hls = hls;
    this._active = true;
    this._fragmentList = [];
    this._preloadedUrls.clear();
    bandwidthEstimator.reset();

    // 监听分片列表加载完成
    hls.on(Hls.Events.LEVEL_LOADED, (_e, data) => {
      if (data.details && data.details.fragments) {
        this._fragmentList = data.details.fragments.map(f => ({
          url: f.url || (f._url || f.relurl),
          sn: f.sn,
          duration: f.duration || 0,
        })).filter(f => f.url);
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

    // 找出需要预加载的分片
    let pendingFragments = this._fragmentList.filter(f => {
      return !this._preloadedUrls.has(f.url);
    });

    // 动态批量大小：根据带宽自动调整
    const batchSize = bandwidthEstimator.recommendedBatchSize();
    const toPreload = pendingFragments.slice(0, batchSize);

    if (toPreload.length === 0) {
      this._schedule();
      return;
    }

    // 并行预加载（使用带宽估算记录耗时）
    const startTime = performance.now();
    let totalBytes = 0;
    let loaded = 0;

    await Promise.all(toPreload.map(async (frag) => {
      if (!this._active) return;
      if (this._preloadedUrls.has(frag.url)) return;
      try {
        const cached = await mediaCache.get(frag.url);
        if (cached) {
          this._preloadedUrls.add(frag.url);
          return;
        }
        const res = await fetch(frag.url, { credentials: 'omit' });
        if (!res.ok && res.status !== 206) return;
        const data = await res.arrayBuffer();
        totalBytes += data.byteLength;
        const blob = new Blob([data]);
        const storeType = this._isCaching ? 'cache' : 'preload';
        await mediaCache.put(frag.url, blob, storeType);
        this._preloadedUrls.add(frag.url);
        loaded++;
      } catch (_) {}
    }));

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
    while (this._cacheQueue.length > 0 && this._isCaching) {
      const batch = this._cacheQueue.splice(0, batchSize);
      await Promise.all(batch.map(url => this._cacheOne(url)));
      const pct = Math.min(99, Math.round((this._cacheDone / this._cacheTotal) * 100));
      if (this._onCacheProgress) this._onCacheProgress(pct);
    }
    if (this._isCaching) {
      this._isCaching = false;
      if (this._onCacheProgress) this._onCacheProgress(100);
    }
  },

  async _cacheOne(url) {
    try {
      const res = await fetch(url, { credentials: 'omit' });
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
