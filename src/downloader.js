/**
 * 下载调度器（增强版） — 多引擎 + 断点续传 + 代理轮换 + 限速 + 格式扩展
 *
 * ⭐ P0/P1/P2 增强：
 *  - 三引擎降级：N_m3u8DL-RE → ffmpeg → JS downloader
 *  - 断点续传与分片恢复（P1-4）
 *  - 网络代理/多IP轮换（P1-5）
 *  - 视频格式扩展（DASH/MPD/直链 mp4）（P1-6）
 *  - 并行分片下载加速（P2-7）
 *  - 智能码率选择（P2-8）
 *  - 下载限速与资源管控（P2-9）
 *
 * @module downloader
 */

import { spawn, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { decryptAndFix, isCctvUrl } from './decrypt-cctv.js';
import {
  downloadWithJs,
  parseM3u8,
  downloadSegmentsParallel,
  downloadSingleSegment,
} from './js-downloader.js';
import logger from './logger.js';
import { assertStreamUrlLiteral } from './security.js';
const log = logger.child({ module: 'downloader' });

const DOWNLOADS_DIR = path.resolve(process.cwd(), 'downloads');
const PROXY_LIST_PATH = path.resolve(process.cwd(), 'config', 'proxies.txt');
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 1800_000; // ⭐ 默认下载超时：30分钟

// 确保目录存在
if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}
const configDir = path.resolve(process.cwd(), 'config');
if (!fs.existsSync(configDir)) {
  fs.mkdirSync(configDir, { recursive: true });
}

// 启动清理：删除 7 天前的断点续传分片缓存（防止长期占盘）
try {
  const cacheRoot = path.join(DOWNLOADS_DIR, '.cache');
  if (fs.existsSync(cacheRoot)) {
    const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    for (const entry of fs.readdirSync(cacheRoot)) {
      const p = path.join(cacheRoot, entry);
      const stat = fs.statSync(p);
      if (stat.isDirectory() && now - stat.mtimeMs > CACHE_MAX_AGE_MS) {
        fs.rmSync(p, { recursive: true, force: true });
        console.log(`[Cleanup] 已清理过期分片缓存: ${p}`);
      }
    }
  }
} catch (err) {
  console.warn(`[Cleanup] 分片缓存清理失败: ${err.message}`);
}

// ─── 代理轮换管理器 ────────────────────────────────
class ProxyManager {
  constructor() {
    this.proxies = [];
    this.currentIndex = 0;
    this._loadProxies();
  }

  _loadProxies() {
    try {
      if (fs.existsSync(PROXY_LIST_PATH)) {
        const content = fs.readFileSync(PROXY_LIST_PATH, 'utf-8');
        this.proxies = content
          .split('\n')
          .map(l => l.trim())
          .filter(l => l && !l.startsWith('#'))
          .filter(l => /^https?:\/\//.test(l) || /^\d+\.\d+\.\d+\.\d+:\d+/.test(l));
        console.log(`[Proxy] 已加载 ${this.proxies.length} 个代理`);
      }
    } catch (err) {
      console.warn(`[Proxy] 加载代理列表失败: ${err.message}`);
    }
  }

  getNextProxy() {
    if (this.proxies.length === 0) return null;
    const proxy = this.proxies[this.currentIndex % this.proxies.length];
    this.currentIndex++;
    return proxy;
  }

  addProxy(proxyUrl) {
    this.proxies.push(proxyUrl);
    fs.appendFileSync(PROXY_LIST_PATH, `\n${proxyUrl}`);
  }
}

const proxyManager = new ProxyManager();

// ─── 全局速率限制器 ────────────────────────────────
class BandwidthLimiter {
  constructor(maxBytesPerSecond = 0) { // 0 = 默认不限速，可用 MAX_BANDWIDTH 开启
    this.maxBytesPerSecond = maxBytesPerSecond;
    this.currentUsage = 0; // 每秒实测下载字节数
    this.activeDownloads = new Map(); // taskId → { startTime, bytesDownloaded, maxSpeed, measuredSpeed }
    this.interval = setInterval(() => this._tick(), 1000);

    // ⭐ 智能码率选择相关状态
    this.measuredBandwidth = 0;         // 实测带宽 (bytes/s)
    this.bandwidthHistory = [];         // 带宽历史，用于平滑
    this.BANDWIDTH_SAMPLES = 5;         // 取最近 5 次测速做平滑
    this.lastMeasureTime = Date.now();
  }

  /**
   * 注册一个下载任务
   */
  register(taskId, maxSpeed = null) {
    this.activeDownloads.set(taskId, {
      startTime: Date.now(),
      bytesDownloaded: 0,
      windowBytes: 0,
      maxSpeed: maxSpeed || null,
      measuredSpeed: 0,
    });
  }

  /**
   * 报告已下载字节数
   */
  reportBytes(taskId, bytes) {
    const entry = this.activeDownloads.get(taskId);
    if (entry) {
      entry.bytesDownloaded += bytes;
      entry.windowBytes += bytes;
    }
  }

  /**
   * 获取当前任务允许的下载速度（字节/秒）
   * @returns {number|null} null 表示不限速
   */
  getAllowedSpeed(taskId) {
    const entry = this.activeDownloads.get(taskId);
    if (!entry) return null;

    // 单任务限速
    if (entry.maxSpeed) return entry.maxSpeed;

    // 全局带宽分配（0=无限制）
    const activeCount = this.activeDownloads.size;
    if (this.maxBytesPerSecond > 0 && activeCount > 0) {
      return Math.floor(this.maxBytesPerSecond / activeCount);
    }
    return null;
  }

  /**
   * ⭐ 智能码率选择：根据实测带宽推荐最优码率
   *
   * 码率分层（用于 HLS/DASH variant 选择）：
   *   - 4K (2160p):  > 40 Mbps
   *   - 1080p (高):  15~40 Mbps
   *   - 1080p (中):  8~15 Mbps
   *   - 720p (高):   5~8 Mbps
   *   - 720p (低):   3~5 Mbps
   *   - 480p:        1.5~3 Mbps
   *   - 360p:        < 1.5 Mbps
   *
   * @param {object[]} variants - 可用码率列表 [{ bandwidth, resolution, url }]
   * @param {number} safetyMargin - 安全系数（默认 0.8，即只用 80% 实测带宽）
   * @returns {object} { selected: object|null, recommended: string, bandwidthMbps: number }
   */
  selectBestVariant(variants, safetyMargin = 0.8) {
    if (!variants || variants.length === 0) {
      return { selected: null, recommended: 'unknown', bandwidthMbps: 0 };
    }

    const measuredBps = this.measuredBandwidth || 50 * 1024 * 1024; // 默认 50Mbps
    const safeBps = measuredBps * safetyMargin;
    const bandwidthMbps = safeBps / 1024 / 1024;

    // 按码率从高到低排序
    const sorted = [...variants].sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));

    // 选择不超过安全带宽的最高码率
    let selected = sorted[sorted.length - 1]; // 最低码率兜底
    for (const v of sorted) {
      if ((v.bandwidth || 0) <= safeBps) {
        selected = v;
        break;
      }
    }

    // 推荐标签
    const bps = selected?.bandwidth || 0;
    let recommended = 'unknown';
    if (bps > 40_000_000) recommended = '4K (2160p)';
    else if (bps > 15_000_000) recommended = '1080p 高码率';
    else if (bps > 8_000_000) recommended = '1080p 中码率';
    else if (bps > 5_000_000) recommended = '720p 高码率';
    else if (bps > 3_000_000) recommended = '720p 低码率';
    else if (bps > 1_500_000) recommended = '480p';
    else recommended = '360p';

    return { selected, recommended, bandwidthMbps: Math.round(bandwidthMbps * 10) / 10 };
  }

  /**
   * ⭐ 更新实测带宽（每次下载一段数据后调用）
   * @param {number} bytes - 本次下载的字节数
   * @param {number} elapsedMs - 本次下载耗时（毫秒）
   */
  updateMeasuredBandwidth(bytes, elapsedMs) {
    if (elapsedMs <= 0) return;
    const instantBps = (bytes / elapsedMs) * 1000;
    this.bandwidthHistory.push(instantBps);
    if (this.bandwidthHistory.length > this.BANDWIDTH_SAMPLES) {
      this.bandwidthHistory.shift();
    }
    // 滑动平均
    this.measuredBandwidth = this.bandwidthHistory.reduce((a, b) => a + b, 0) / this.bandwidthHistory.length;
  }

  /**
   * 移除任务
   */
  unregister(taskId) {
    this.activeDownloads.delete(taskId);
  }

  _tick() {
    // 每秒实测带宽汇总
    let usage = 0;
    for (const entry of this.activeDownloads.values()) {
      usage += entry.windowBytes || 0;
      entry.windowBytes = 0;
    }
    this.currentUsage = usage;

    // 周期任务：清理过期测速数据
    const now = Date.now();
    if (now - this.lastMeasureTime > 5000 && this.bandwidthHistory.length > 0) {
      // 5 秒无新数据则平滑衰减（防止带宽突降）
      this.bandwidthHistory = this.bandwidthHistory.map(v => v * 0.9);
      this.measuredBandwidth = this.bandwidthHistory.reduce((a, b) => a + b, 0) / this.bandwidthHistory.length;
    }
  }

  destroy() {
    clearInterval(this.interval);
  }
}

const bandwidthLimiter = new BandwidthLimiter();

// ─── 主导出函数 ────────────────────────────────────

/**
 * 启动下载任务（增强版）
 * @param {string} m3u8Url - m3u8/MPD/直链 URL
 * @param {object} headers - 请求头
 * @param {string} taskId - 任务 ID
 * @param {function} onProgress - 进度回调
 * @param {object} options - 可选配置
 * @param {number} options.maxSpeed - 单任务限速（字节/秒）
 * @param {boolean} options.useProxy - 是否使用代理轮换
 * @param {boolean} options.parallel - 是否启用并行分片下载
 * @param {number} options.parallelCount - 并行分片数
 * @param {string} options.preferredCodec - 首选编码（如 'h264', 'avc', 'hevc'）
 * @returns {Promise<string>} 输出文件路径
 */
export function startDownload(m3u8Url, headers, taskId, onProgress, options = {}) {
  return new Promise((resolve, reject) => {
    // 可读输出名（默认 taskId，实际由 index.js 根据页面标题生成）
    const outputName = options.outputName || taskId;
    const outputPath = path.join(DOWNLOADS_DIR, outputName);

    // 注册带宽
    bandwidthLimiter.register(taskId, options.maxSpeed || null);

    // 流 URL SSRF 字面量校验（DNS 级校验在 index.js 完成）
    try {
      assertStreamUrlLiteral(m3u8Url);
    } catch (err) {
      bandwidthLimiter.unregister(taskId);
      reject(err);
      return;
    }

    // 检测 URL 格式并选择下载策略
    const formatType = detectFormat(m3u8Url);

    // 构建额外参数
    const reportBytes = (n) => bandwidthLimiter.reportBytes(taskId, n);
    const extraArgs = {
      headers,
      outputPath,
      taskId,
      onProgress,
      proxy: options.useProxy ? proxyManager.getNextProxy() : null,
      maxSpeed: bandwidthLimiter.getAllowedSpeed(taskId),
      parallel: options.parallel || false,
      parallelCount: options.parallelCount || 4,
      preferredCodec: options.preferredCodec || null,
      engine: options.engine || 'auto',
      formatType,
      onBytes: reportBytes,
      resumeDir: path.join(DOWNLOADS_DIR, '.cache', taskId),
      allowPartial: options.allowPartial || false,
    };

    let downloadPromise;

    switch (formatType) {
      case 'mpd':
        // DASH 格式 — 用 ffmpeg 或 N_m3u8DL-RE
        downloadPromise = downloadWithEngine(m3u8Url, extraArgs);
        break;
      case 'direct':
        // 直链 mp4/mkv — 用 ffmpeg 或 curl
        downloadPromise = downloadDirectLink(m3u8Url, extraArgs);
        break;
      default:
        // HLS (m3u8) — 三引擎降级
        downloadPromise = downloadWithEngine(m3u8Url, extraArgs);
    }

    // ⭐ 全局下载超时保护（30分钟），防止任务永久卡死占用槽位
    const timeoutPromise = new Promise((_, timeoutReject) => {
      const timeoutMs = options.timeoutMs || DEFAULT_DOWNLOAD_TIMEOUT_MS;
      const timeoutId = setTimeout(() => {
        cancelDownload(taskId);
        timeoutReject(new Error(`下载超时（${Math.round(timeoutMs / 60000)}分钟），已自动取消`));
      }, timeoutMs);
      // 存储 timeoutId 便于清理
      downloadPromise.finally(() => clearTimeout(timeoutId));
    });

    Promise.race([downloadPromise, timeoutPromise])
      .then(async (result) => {
        bandwidthLimiter.unregister(taskId);

        // CCTV 花屏修复（先修后校验）
        if (isCctvUrl(m3u8Url)) {
          const fixedPath = await fixCctvVideo(result, m3u8Url, outputPath, taskId, onProgress);
          if (fixedPath !== result && fs.existsSync(result)) {
            try { fs.unlinkSync(result); } catch (_) {}
          }
          result = fixedPath;
        }

        // JS 下载器产出 .ts 时，用 ffmpeg 无损转封装为 mp4（失败则保留 ts）
        if (result.endsWith('.ts') && which('ffmpeg')) {
          const remuxed = await remuxToMp4(result, outputPath);
          if (remuxed !== result) {
            try { fs.unlinkSync(result); } catch (_) {}
            result = remuxed;
          }
        }

        // ⭐ 所有引擎统一完整性校验（存在性 + 非0字节 + ffprobe 视频轨道）
        const verify = await verifyDownloadedFile(result);
        if (!verify.ok) {
          throw new Error(`视频完整性校验失败: ${verify.reason || path.basename(result)}`);
        }

        return result;
      })
      .then(resolve)
      .catch((err) => {
        bandwidthLimiter.unregister(taskId);
        reject(err);
      });
  });
}

/**
 * 检测 URL 格式
 */
function detectFormat(url) {
  if (/\.mpd(\?|$)/i.test(url)) return 'mpd';
  if (/\.(mp4|mkv|webm|avi)(\?|$)/i.test(url)) return 'direct';
  if (/\.m3u8(\?|$)/i.test(url)) return 'hls';
  return 'hls'; // 默认 HLS
}

/**
 * 三引擎降级下载
 */
async function downloadWithEngine(m3u8Url, extra) {
  const {
    outputPath, taskId, onProgress, headers, proxy, maxSpeed, parallel, parallelCount, engine,
    onBytes, resumeDir, allowPartial, formatType,
  } = extra;

  const jsOptions = {
    headers,
    onProgress,
    maxConcurrency: parallelCount,
    maxSpeed,
    proxy,
    onBytes,
    resumeDir,
    allowPartial,
  };

  // ⭐ 修复：支持用户指定引擎，优先按指定引擎执行
  if (engine && engine !== 'auto') {
    if (engine === 'n_m3u8dl_re') {
      const n_m3u8dl_re_path = which('N_m3u8DL-RE');
      if (n_m3u8dl_re_path) {
        try {
          return await downloadWithN_m3u8DL_RE(m3u8Url, headers, outputPath, taskId, onProgress, {
            binPath: n_m3u8dl_re_path,
            proxy,
            maxSpeed,
          });
        } catch (err) {
          console.warn(`[Download] N_m3u8DL-RE 失败，降级到三引擎自动选择: ${err.message}`);
          cleanupOutputFiles(outputPath);
        }
      }
    } else if (engine === 'ffmpeg') {
      if (which('ffmpeg')) {
        try {
          return await downloadWithFFmpeg(m3u8Url, headers, outputPath, taskId, onProgress, { proxy, onBytes });
        } catch (err) {
          console.warn(`[Download] ffmpeg 失败，降级到三引擎自动选择: ${err.message}`);
          cleanupOutputFiles(outputPath);
        }
      }
    } else if (engine === 'js') {
      // 用户指定 JS 引擎
      if (parallel) {
        return await downloadSegmentsParallel(m3u8Url, outputPath, jsOptions);
      } else {
        const outputDir = path.dirname(outputPath);
        const baseName = path.basename(outputPath);
        return await downloadWithJs(m3u8Url, headers, outputDir, baseName, onProgress, jsOptions);
      }
    }
    // 指定引擎不可用时，继续走 auto 降级
  }

  // 方案 A: N_m3u8DL-RE（首选）
  const n_m3u8dl_re_path = which('N_m3u8DL-RE');
  if (n_m3u8dl_re_path) {
    try {
      return await downloadWithN_m3u8DL_RE(m3u8Url, headers, outputPath, taskId, onProgress, {
        binPath: n_m3u8dl_re_path,
        proxy,
        maxSpeed,
      });
    } catch (err) {
      console.warn(`[Download] N_m3u8DL-RE 失败，降级到 ffmpeg: ${err.message}`);
      cleanupOutputFiles(outputPath);
    }
  }

  // 方案 B: ffmpeg 回退
  if (which('ffmpeg')) {
    try {
      return await downloadWithFFmpeg(m3u8Url, headers, outputPath, taskId, onProgress, {
        proxy,
        onBytes,
      });
    } catch (err) {
      console.warn(`[Download] ffmpeg 失败，降级到 JS 下载器: ${err.message}`);
      cleanupOutputFiles(outputPath);
    }
  }

  // 方案 C: JS 原生下载器（兜底）
  if (formatType === 'mpd') {
    throw new Error('DASH/MPD 格式需要 ffmpeg 或 N_m3u8DL-RE 支持，且两者均不可用');
  }
  onProgress({ percent: 0, speed: null, message: '使用 JS 原生下载器（兜底模式）...' });

  if (parallel) {
    return await downloadSegmentsParallel(m3u8Url, outputPath, jsOptions);
  } else {
    const outputDir = path.dirname(outputPath);
    const baseName = path.basename(outputPath);
    return await downloadWithJs(m3u8Url, headers, outputDir, baseName, onProgress, jsOptions);
  }
}

/**
 * 下载直链 mp4/mkv
 */
async function downloadDirectLink(url, extra) {
  const { outputPath, onProgress, proxy, taskId, headers, onBytes } = extra;
  const finalPath = `${outputPath}.mp4`;

  // 方案 A：ffmpeg（完整请求头 + 重试），失败后回退 fetch
  if (which('ffmpeg')) {
    try {
      return await attemptWithRetry(
        () => downloadDirectWithFFmpeg(url, headers, outputPath, taskId, onProgress, { proxy, onBytes }),
        2,
        'ffmpeg 直链'
      );
    } catch (err) {
      console.warn(`[Download] ffmpeg 直链失败，回退到 fetch: ${err.message}`);
      try { fs.unlinkSync(finalPath); } catch (_) {}
    }
  }

  // 方案 B：fetch + Range 断点续传 + 流式写入
  onProgress({ percent: 0, speed: null, message: '使用 fetch 下载直链...' });
  return downloadDirectWithFetch(url, headers, outputPath, taskId, onProgress, { proxy, onBytes });
}

/**
 * ffmpeg 下载直链（带完整防盗链请求头与字节上报）
 */
function downloadDirectWithFFmpeg(url, headers, outputPath, taskId, onProgress, options = {}) {
  return new Promise((resolve, reject) => {
    const { proxy, onBytes } = options;
    const args = [
      '-i', url,
      '-c', 'copy',
      '-movflags', '+faststart',
      '-progress', 'pipe:1',
      '-nostats',
      '-y',
      `${outputPath}.mp4`,
    ];

    const headerStr = buildFfmpegHeaders(headers);
    if (headerStr) args.unshift('-headers', headerStr);
    if (proxy) args.unshift('-http_proxy', proxy);

    onProgress({ percent: 0, speed: null, message: '使用 ffmpeg 下载直链...' });

    const proc = spawn('ffmpeg', args.filter(Boolean), { stdio: ['ignore', 'pipe', 'pipe'] });
    let lastTotalSize = 0;

    proc.stdout.on('data', (data) => {
      const text = data.toString();
      const timeMatch = text.match(/out_time=(\d+):(\d+):(\d+)/);
      if (timeMatch) {
        const seconds = (+timeMatch[1] * 3600) + (+timeMatch[2] * 60) + (+timeMatch[3]);
        onProgress({
          percent: Math.min(99, Math.floor(seconds / 10)),
          speed: null,
          message: `已下载 ${timeMatch[1]}:${timeMatch[2]}:${timeMatch[3]}`,
        });
      }
      // ffmpeg -progress 会周期性输出 total_size，用于真实带宽统计
      const sizeMatch = text.match(/total_size=(\d+)/);
      if (sizeMatch && onBytes) {
        const totalSize = parseInt(sizeMatch[1], 10);
        if (totalSize > lastTotalSize) {
          onBytes(totalSize - lastTotalSize);
          lastTotalSize = totalSize;
        }
      }
    });

    proc.on('close', (code) => {
      if (code === 0) {
        onProgress({ percent: 100, speed: null, message: '下载完成！' });
        resolve(`${outputPath}.mp4`);
      } else {
        reject(new Error(`ffmpeg 直链下载退出码 ${code}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`启动 ffmpeg 失败: ${err.message}`));
    });

    activeProcesses.set(taskId, proc);
  });
}

/**
 * fetch + 流式写入直链（支持 Range 断点续传、完整请求头、取消、字节上报）
 */
async function downloadDirectWithFetch(url, headers, outputPath, taskId, onProgress, options = {}) {
  const { default: fetch } = await import('node-fetch');
  const { createWriteStream } = await import('fs');
  const { onBytes } = options;
  const finalPath = `${outputPath}.mp4`;
  const partPath = `${outputPath}.part.mp4`;

  let startByte = 0;
  if (fs.existsSync(partPath)) {
    startByte = fs.statSync(partPath).size;
  }

  const reqHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    ...sanitizeHeaders(headers),
  };
  if (startByte > 0) reqHeaders['Range'] = `bytes=${startByte}-`;

  const response = await fetch(url, { headers: reqHeaders });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  // 服务器忽略 Range 时（返回 200），丢弃旧的分片重新下载
  let resumeOk = startByte > 0 && response.status === 206;
  if (startByte > 0 && !resumeOk) {
    try { fs.unlinkSync(partPath); } catch (_) {}
    startByte = 0;
  }

  const contentLength = response.headers.get('content-length');
  const totalBytes = contentLength ? parseInt(contentLength, 10) + (resumeOk ? startByte : 0) : 0;
  const flags = resumeOk ? 'a' : 'w';
  const fileStream = createWriteStream(partPath, { flags });

  return new Promise((resolve, reject) => {
    activeProcesses.set(taskId, { kill: () => { fileStream.destroy(); } });

    let downloadedBytes = resumeOk ? startByte : 0;
    response.body.on('data', (chunk) => {
      downloadedBytes += chunk.length;
      if (onBytes) onBytes(chunk.length);
      if (totalBytes > 0) {
        onProgress({
          percent: Math.round((downloadedBytes / totalBytes) * 100),
          speed: null,
          message: `直链下载 ${(downloadedBytes / 1024 / 1024).toFixed(1)}MB / ${(totalBytes / 1024 / 1024).toFixed(1)}MB`,
        });
      }
    });

    response.body.pipe(fileStream);
    fileStream.on('finish', () => {
      activeProcesses.delete(taskId);
      fs.renameSync(partPath, finalPath); // 原子收尾
      onProgress({ percent: 100, speed: null, message: '下载完成！' });
      resolve(finalPath);
    });
    fileStream.on('error', (err) => {
      activeProcesses.delete(taskId);
      reject(err);
    });
  });
}

// ─── N_m3u8DL-RE 下载（增强版） ──────────────────
function downloadWithN_m3u8DL_RE(m3u8Url, headers, outputPath, taskId, onProgress, options = {}) {
  return new Promise((resolve, reject) => {
    const { binPath, proxy, maxSpeed } = options;

    if (!isValidUrl(m3u8Url)) {
      reject(new Error(`非法的 m3u8 URL: ${m3u8Url.slice(0, 100)}`));
      return;
    }

    const args = [
      m3u8Url,
      '--save-dir', DOWNLOADS_DIR,
      '--save-name', path.basename(outputPath),
      '--thread-count', '4',
      '--auto-select',
      '--download-retry-count', '5',
      '--check-segments-count',
      '--log-level', 'debug',
      '--no-log',
    ];

    // 代理支持
    if (proxy) {
      args.push('--proxy', proxy);
    }

    // 限速支持
    if (maxSpeed) {
      args.push('--max-speed', `${Math.floor(maxSpeed / 1024 / 1024)}M`); // N_m3u8DL-RE 使用 M 单位
    }

    // 请求头（Referer/Origin/Cookie/UA 等全部透传）
    for (const [key, value] of Object.entries(sanitizeHeaders(headers))) {
      args.push('--header', `${key}:${value}`);
    }

    onProgress({ percent: 0, speed: null, message: '启动 N_m3u8DL-RE 下载...' });

    const proc = spawn(binPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let lastPercent = 0;

    const onData = (text) => {
      const percentMatch = text.match(/(\d+\.?\d*)%/);
      const speedMatch = text.match(/([\d.]+)\s*(MB|KB|GB)\/s/i);
      if (percentMatch) {
        const percent = parseFloat(percentMatch[1]);
        if (percent > lastPercent) {
          lastPercent = percent;
          onProgress({
            percent: Math.round(percent),
            speed: speedMatch ? `${speedMatch[1]} ${speedMatch[2]}/s` : null,
            message: text.trim().slice(0, 200),
          });
        }
      }
    };

    proc.stdout.on('data', (data) => onData(data.toString()));
    proc.stderr.on('data', (data) => onData(data.toString()));

    proc.on('close', (code) => {
      if (code === 0) {
        const mp4Path = `${outputPath}.mp4`;
        const tsPath = `${outputPath}.ts`;
        const finalPath = fs.existsSync(mp4Path) ? mp4Path : fs.existsSync(tsPath) ? tsPath : outputPath;

        // 完整性校验统一在 startDownload 层执行
        cleanupTempDir(outputPath);
        onProgress({ percent: 100, speed: null, message: '下载完成！' });
        resolve(finalPath);
      } else {
        reject(new Error(`N_m3u8DL-RE 退出码 ${code}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`启动 N_m3u8DL-RE 失败: ${err.message}`));
    });

    activeProcesses.set(taskId, proc);
  });
}

// ─── ffmpeg 下载（增强版，带重试） ────────────────
function downloadWithFFmpeg(m3u8Url, headers, outputPath, taskId, onProgress, options = {}) {
  const { proxy, onBytes } = options;

  return attemptWithRetry(
    async () => {
      if (!isValidUrl(m3u8Url)) {
        throw new Error(`非法的 m3u8 URL: ${m3u8Url.slice(0, 100)}`);
      }

      return new Promise((resolve, reject) => {
        const args = [];

        const headerStr = buildFfmpegHeaders(headers);
        if (headerStr) args.push('-headers', headerStr);

        if (proxy) {
          args.push('-http_proxy', proxy);
        }

        args.push(
          '-i', m3u8Url,
          '-c', 'copy',
          '-err_detect', 'ignore_err',
          '-bsf:a', 'aac_adtstoasc',
          '-progress', 'pipe:1',
          '-nostats',
          '-y',
          `${outputPath}.mp4`,
        );

        onProgress({ percent: 0, speed: null, message: '启动 ffmpeg 下载...' });

        const proc = spawn('ffmpeg', args.filter(Boolean), { stdio: ['ignore', 'pipe', 'pipe'] });
        let lastTotalSize = 0;

        proc.stdout.on('data', (data) => {
          const text = data.toString();
          const timeMatch = text.match(/out_time=(\d+):(\d+):(\d+)/);
          if (timeMatch) {
            const seconds = (+timeMatch[1] * 3600) + (+timeMatch[2] * 60) + (+timeMatch[3]);
            onProgress({
              percent: Math.min(99, Math.floor(seconds / 10)),
              speed: null,
              message: `已下载 ${timeMatch[1]}:${timeMatch[2]}:${timeMatch[3]}`,
            });
          }
          const sizeMatch = text.match(/total_size=(\d+)/);
          if (sizeMatch && onBytes) {
            const totalSize = parseInt(sizeMatch[1], 10);
            if (totalSize > lastTotalSize) {
              onBytes(totalSize - lastTotalSize);
              lastTotalSize = totalSize;
            }
          }
        });

        proc.on('close', (code) => {
          if (code === 0) {
            onProgress({ percent: 100, speed: null, message: '下载完成！' });
            resolve(`${outputPath}.mp4`);
          } else {
            reject(new Error(`ffmpeg 退出码 ${code}`));
          }
        });

        proc.on('error', (err) => {
          reject(new Error(`启动 ffmpeg 失败: ${err.message}`));
        });

        activeProcesses.set(taskId, proc);
      });
    },
    2, // 最多重试 2 次
    'ffmpeg'
  );
}

/**
 * 带重试的异步操作
 */
async function attemptWithRetry(fn, maxRetries = 2, label = '操作') {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) {
        console.warn(`[Retry] ${label} 第 ${attempt + 1}/${maxRetries} 次重试: ${err.message}`);
        await new Promise(r => setTimeout(r, 2000 * Math.pow(2, attempt)));
      }
    }
  }
  throw lastErr;
}

// ─── CCTV 花屏修复 ────────────────────────────────
async function fixCctvVideo(videoPath, m3u8Url, outputPath, taskId, onProgress) {
  onProgress({ percent: 95, speed: null, message: '检测到 CCTV 视频，正在解密修复花屏...' });
  console.log(`[CCTV-Fix] 检测到 CCTV 视频: ${m3u8Url.slice(0, 80)}...`);

  const saveName = path.basename(outputPath);
  const tsDir = path.join(DOWNLOADS_DIR, `${saveName}_tmp`);

  let fixed = false;
  let fixedFile = null;

  if (fs.existsSync(tsDir)) {
    const result = await decryptAndFix(tsDir, m3u8Url, outputPath);
    if (result.fixed && result.outputFile) {
      fixed = true;
      fixedFile = result.outputFile;
      try { fs.rmSync(tsDir, { recursive: true, force: true }); } catch (_) {}
    }
  }

  if (!fixed) {
    onProgress({ percent: 96, speed: null, message: '正在用 ffmpeg 重新编码修复视频...' });
    const { fixWithFfmpeg } = await import('./decrypt-cctv.js');
    try {
      fixedFile = await fixWithFfmpeg(videoPath, outputPath);
      fixed = true;
    } catch (err) {
      console.error(`[CCTV-Fix] ffmpeg 修复失败: ${err.message}`);
      return videoPath;
    }
  }

  if (fixed && fixedFile) {
    console.log(`[CCTV-Fix] ✅ 花屏修复完成: ${fixedFile}`);
    onProgress({ percent: 100, speed: null, message: '下载完成！视频花屏已修复' });
    return fixedFile;
  }

  return videoPath;
}

// ─── 辅助函数 ──────────────────────────────────────

function cleanupTempDir(outputPath) {
  const saveName = path.basename(outputPath);
  const tmpDir = path.join(DOWNLOADS_DIR, `${saveName}_tmp`);
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log(`[Cleanup] 已删除临时碎片目录: ${tmpDir}`);
  }
}

function cleanupOutputFiles(outputPath) {
  for (const ext of ['.mp4', '.ts', '.mkv']) {
    const p = `${outputPath}${ext}`;
    if (fs.existsSync(p)) {
      try { fs.unlinkSync(p); } catch (_) {}
    }
  }
}

/**
 * 统一完整性校验：存在性 + 非0字节 + ffprobe 可解析出视频轨道
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
function verifyDownloadedFile(filePath) {
  return new Promise((resolvePromise) => {
    if (!filePath || !fs.existsSync(filePath)) {
      resolvePromise({ ok: false, reason: '输出文件不存在' });
      return;
    }

    const stat = fs.statSync(filePath);
    if (stat.size === 0) {
      resolvePromise({ ok: false, reason: '输出文件为 0 字节' });
      return;
    }

    const ffprobePath = which('ffprobe');
    if (!ffprobePath) {
      console.warn('[Verify] ffprobe 未安装，仅做文件大小校验');
      resolvePromise({ ok: true });
      return;
    }

    const proc = spawn(ffprobePath, [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name',
      filePath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      if (code === 0) {
        resolvePromise({ ok: true });
      } else {
        const errMsg = stderr.trim().slice(0, 300);
        console.warn(`[Verify] 视频完整性检查失败: ${errMsg}`);
        resolvePromise({ ok: false, reason: errMsg || '视频轨道数据损坏' });
      }
    });

    proc.on('error', (err) => {
      resolvePromise({ ok: false, reason: `启动 ffprobe 失败: ${err.message}` });
    });
  });
}

/**
 * 过滤请求头白名单（防注入，只保留下载真正需要的头）
 * @returns {object} 键名小写
 */
function sanitizeHeaders(headers = {}) {
  const allowed = new Set([
    'referer', 'origin', 'cookie', 'user-agent', 'accept', 'accept-language',
    'authorization', 'x-requested-with', 'range',
  ]);
  const result = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const k = String(key).toLowerCase();
    if (!allowed.has(k)) continue;
    const v = String(value || '').replace(/[\r\n]/g, '');
    if (v) result[k] = v;
  }
  return result;
}

/**
 * 构造 ffmpeg -headers 多行头字符串
 */
function buildFfmpegHeaders(headers = {}) {
  const clean = sanitizeHeaders(headers);
  return Object.entries(clean)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\r\n');
}

/**
 * 无损转封装 .ts → .mp4（流复制，不重新编码）
 * @returns {Promise<string>} 成功返回 mp4 路径，失败返回原输入路径
 */
function remuxToMp4(inputPath, outputPath) {
  return new Promise((resolvePromise) => {
    const output = `${outputPath}.mp4`;
    const proc = spawn('ffmpeg', [
      '-i', inputPath,
      '-c', 'copy',
      '-movflags', '+faststart',
      '-y',
      output,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(output) && fs.statSync(output).size > 0) {
        resolvePromise(output);
      } else {
        console.warn(`[Remux] ts→mp4 转封装失败（保留 ts）: ${stderr.slice(-200)}`);
        resolvePromise(inputPath);
      }
    });
    proc.on('error', () => resolvePromise(inputPath));
  });
}

// 活跃进程表
const activeProcesses = new Map();

/**
 * 取消下载任务
 */
export function cancelDownload(taskId) {
  const proc = activeProcesses.get(taskId);
  if (proc) {
    proc.kill('SIGTERM');
    activeProcesses.delete(taskId);
    return true;
  }
  return false;
}

/**
 * 获取代理管理器实例
 */
export function getProxyManager() {
  return proxyManager;
}

/**
 * 获取带宽限制器实例
 */
export function getBandwidthLimiter() {
  return bandwidthLimiter;
}

/**
 * 添加代理到代理池
 * @param {string} proxyUrl - 代理 URL，如 http://127.0.0.1:1080
 */
export function addProxy(proxyUrl) {
  proxyManager.addProxy(proxyUrl);
  console.log(`[Proxy] 已添加代理: ${proxyUrl}`);
}

/**
 * 获取当前带宽使用情况
 * @returns {{ currentUsage: number, limit: number, activeTasks: number }}
 */
export function getBandwidthUsage() {
  return {
    currentUsage: bandwidthLimiter.currentUsage || 0,
    limit: bandwidthLimiter.maxBytesPerSecond || 0,
    activeTasks: bandwidthLimiter.activeDownloads?.size || 0,
  };
}

/**
 * 设置全局带宽限制
 * @param {number} bytesPerSecond - 每秒字节数限制（0=无限制）
 */
export function setBandwidthLimit(bytesPerSecond) {
  bandwidthLimiter.maxBytesPerSecond = bytesPerSecond || 0;
  console.log(`[Bandwidth] 全局带宽限制已设置为: ${bytesPerSecond > 0 ? (bytesPerSecond / 1024 / 1024).toFixed(1) + ' MB/s' : '无限制'}`);
}

/**
 * 获取下载引擎可用性（供健康检查/前端展示）
 */
export function getEngineAvailability() {
  return {
    ffmpeg: !!which('ffmpeg'),
    ffprobe: !!which('ffprobe'),
    nM3u8DLRe: !!which('N_m3u8DL-RE'),
  };
}

/**
 * 检查磁盘空间是否足够
 * @param {number} [requiredBytes] - 需要的字节数，默认 1GB
 * @returns {{ ok: boolean, freeBytes: number, message: string }}
 */
export function validateDiskSpace(requiredBytes = 1024 * 1024 * 1024) {
  try {
    // ⭐ 修复：require() 在 ESM 模块中不可用，改用顶层已导入的 execSync
    let freeBytes = 0;

    // 尝试用 df 获取可用空间
    try {
      const dfOutput = execSync(`df -k "${DOWNLOADS_DIR}"`, { encoding: 'utf-8' });
      const lines = dfOutput.trim().split('\n');
      if (lines.length >= 2) {
        const parts = lines[1].split(/\s+/);
        // 第4列是可用空间（KB）
        freeBytes = parseInt(parts[3], 10) * 1024;
      }
    } catch {
      // df 失败时，尝试用 statfs
      freeBytes = 1024 * 1024 * 1024 * 10; // 默认假设有 10GB
    }

    const ok = freeBytes >= requiredBytes;
    return {
      ok,
      freeBytes,
      message: ok
        ? `磁盘空间充足: ${(freeBytes / 1024 / 1024 / 1024).toFixed(1)} GB 可用`
        : `磁盘空间不足: ${(freeBytes / 1024 / 1024 / 1024).toFixed(1)} GB 可用，需要 ${(requiredBytes / 1024 / 1024 / 1024).toFixed(1)} GB`,
    };
  } catch (err) {
    return { ok: true, freeBytes: 0, message: `磁盘检查跳过: ${err.message}` };
  }
}

// ─── 安全校验 ──────────────────────────────────────
function isValidUrl(url) {
  if (typeof url !== 'string' || url.length === 0) return false;
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

const ALLOWED_CMDS = new Set(['N_m3u8DL-RE', 'ffmpeg', 'ffprobe']);

function which(cmd) {
  if (!ALLOWED_CMDS.has(cmd)) {
    console.error(`[Security] which() 拒绝查找未授权命令: ${cmd}`);
    return false;
  }

  try {
    const output = execSync(`which ${cmd}`, { stdio: ['ignore', 'pipe', 'ignore'] });
    const fullPath = output.toString().trim().split('\n')[0];
    if (fullPath && fs.existsSync(fullPath)) return fullPath;
  } catch {
    // continue
  }

  const homeDir = os.homedir();
  const userBinDirs = [
    path.join(homeDir, 'bin'),
    path.join(homeDir, '.local', 'bin'),
    path.join(homeDir, '.cargo', 'bin'),
  ];
  for (const dir of userBinDirs) {
    const fullPath = path.join(dir, cmd);
    if (fs.existsSync(fullPath)) return fullPath;
  }
  return false;
}
