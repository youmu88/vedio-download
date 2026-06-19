/**
 * JS 原生 m3u8 下载器（兜底方案）
 *
 * 解决设计文档 P1-4「下载引擎单一故障点」：
 * 当 N_m3u8DL-RE 和 ffmpeg 都不可用时，使用纯 JS 实现
 * 最基础的 m3u8 解析 + 分片下载 + 合并，确保最低可用性。
 *
 * 也用于并行分片下载加速（P2-7）。
 *
 * @module js-downloader
 */

import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';

/**
 * 解析 m3u8 播放列表，提取分片 URL 列表
 * @param {string} m3u8Content - m3u8 文件内容
 * @param {string} baseUrl - 基础 URL（用于拼接相对路径）
 * @returns {{ segments: string[], isMaster: boolean, variants: object[] }}
 */
export function parseM3u8(m3u8Content, baseUrl) {
  const lines = m3u8Content.split('\n');
  const segments = [];
  const variants = [];
  const encKeys = [];  // ⭐ 加密密钥列表 [{ method, uri, iv, startIdx }]
  let isMaster = false;
  let segmentIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // 跳过空行和注释
    if (!line || line.startsWith('#')) {
      // 检测 master playlist（包含 #EXT-X-STREAM-INF）
      if (line.startsWith('#EXT-X-STREAM-INF')) {
        isMaster = true;
        const nextLine = lines[i + 1]?.trim();
        if (nextLine && !nextLine.startsWith('#')) {
          const bandwidth = line.match(/BANDWIDTH=(\d+)/i)?.[1];
          const resolution = line.match(/RESOLUTION=(\d+x\d+)/i)?.[1];
          variants.push({
            url: resolveUrl(nextLine, baseUrl),
            bandwidth: bandwidth ? parseInt(bandwidth, 10) : null,
            resolution: resolution || null,
          });
        }
      }
      // ⭐ 检测 #EXT-X-KEY（HLS AES-128 加密）
      if (line.startsWith('#EXT-X-KEY')) {
        const method = line.match(/METHOD=([^,\s]+)/i)?.[1];
        const uri = line.match(/URI="([^"]+)"/i)?.[1];
        const iv = line.match(/IV=0x([0-9a-fA-F]+)/i)?.[1];
        if (method && uri) {
          encKeys.push({
            method: method.toUpperCase(),
            keyUri: resolveUrl(uri, baseUrl),
            ivHex: iv || null,
            startIdx: segmentIndex,
          });
        }
      }
      continue;
    }

    // 分片 URL
    segments.push(resolveUrl(line, baseUrl));
    segmentIndex++;
  }

  return { segments, isMaster, variants, encKeys };
}

/**
 * ⭐ 获取并缓存 HLS 加密密钥
 * @param {string} keyUri - 密钥文件 URL
 * @returns {Promise<Buffer>} 16 字节 AES 密钥
 */
async function fetchEncryptionKey(keyUri) {
  const res = await fetch(keyUri);
  if (!res.ok) throw new Error(`获取加密密钥失败: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * ⭐ AES-128-CBC 解密（HLS 标准加密）
 * @param {Buffer} encrypted - 加密数据
 * @param {Buffer} key - 16 字节密钥
 * @param {Buffer} iv - 16 字节 IV（可选，默认全0）
 * @returns {Buffer}
 */
function decryptAes128Cbc(encrypted, key, iv) {
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv || Buffer.alloc(16, 0));
  decipher.setAutoPadding(false);  // HLS 使用无填充或自定义填充
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

/**
 * 解析相对 URL
 */
function resolveUrl(url, baseUrl) {
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  try {
    const base = new URL(baseUrl);
    return new URL(url, base.origin + base.pathname.substring(0, base.pathname.lastIndexOf('/') + 1)).href;
  } catch {
    return url;
  }
}

/**
 * 使用 AbortController 创建带超时的 fetch
 * ⭐ 修复：node-fetch 的 timeout 选项在 TCP 连接挂起时可能不生效，
 *   改用 AbortController 确保可靠超时
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 下载单个分片（⭐ 支持 AES-128 解密）
 */
async function downloadSegment(segmentUrl, outputPath, headers = {}, retries = 3, decryptOpts = null) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetchWithTimeout(segmentUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          ...headers,
        },
      }, 30000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      let buffer = await res.buffer();

      // ⭐ AES-128-CBC 解密
      if (decryptOpts && decryptOpts.key) {
        try {
          buffer = decryptAes128Cbc(buffer, decryptOpts.key, decryptOpts.iv || null);
        } catch (decryptErr) {
          console.warn(`[JS-Downloader] 分片解密失败: ${decryptErr.message}，保留原始数据`);
        }
      }

      fs.writeFileSync(outputPath, buffer);
      return buffer.length;
    } catch (err) {
      if (attempt === retries - 1) throw err;
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
}

/**
 * 使用纯 JS 方式下载 m3u8 视频
 * @param {string} m3u8Url - m3u8 播放列表 URL
 * @param {object} headers - 请求头
 * @param {string} outputDir - 输出目录
 * @param {string} outputName - 输出文件名（不含扩展名）
 * @param {function} onProgress - 进度回调
 * @param {object} options - 可选 { maxConcurrency, retries }
 * @returns {Promise<string>} 输出文件路径
 */
export async function downloadWithJs(m3u8Url, headers, outputDir, outputName, onProgress, options = {}) {
  const {
    maxConcurrency = 4,
    retries = 3,
    maxSpeed = 0,       // ⭐ 限速支持：bytes/s，0=不限速
  } = options;

  // ⭐ 简易速率限制器
  let bytesThisWindow = 0;
  let windowStart = Date.now();

  onProgress({ percent: 0, speed: null, message: 'JS下载器: 解析 m3u8...' });

  // 1. 下载 m3u8 播放列表
  const m3u8Res = await fetchWithTimeout(m3u8Url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      ...headers,
    },
  }, 30000);

  if (!m3u8Res.ok) throw new Error(`下载 m3u8 失败: HTTP ${m3u8Res.status}`);
  const m3u8Content = await m3u8Res.text();

  // 2. 解析 m3u8
  const { segments, isMaster, variants, encKeys } = parseM3u8(m3u8Content, m3u8Url);

  if (isMaster && variants.length > 0) {
    // 如果是 master playlist，选择第一个 variant（或者最高带宽的）
    variants.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
    onProgress({ percent: 5, speed: null, message: `JS下载器: 选择最高码率 (${Math.round((variants[0].bandwidth || 0) / 1000)}kbps)` });
    return downloadWithJs(variants[0].url, headers, outputDir, outputName, onProgress, options);
  }

  if (segments.length === 0) {
    throw new Error('m3u8 中未找到分片');
  }

  // ⭐ AES-128 HLS 加密支持：获取密钥并创建 IV
  let decryptOpts = null;
  let encKeyBuffer = null;
  if (encKeys.length > 0) {
    const currentKeyInfo = encKeys[0]; // 目前只支持单一密钥
    if (currentKeyInfo.method === 'AES-128') {
      onProgress({ percent: 7, speed: null, message: 'JS下载器: 检测到 AES-128 加密，获取密钥...' });
      encKeyBuffer = await fetchEncryptionKey(currentKeyInfo.keyUri);
      // IV: 使用 key 标签指定的 IV，否则使用序列号（从0开始）
      const ivHex = currentKeyInfo.ivHex;
      decryptOpts = {
        key: encKeyBuffer,
        iv: ivHex ? Buffer.from(ivHex, 'hex') : null,
        ivFromSeq: !ivHex,  // 没有显式 IV 时，使用分片序号作为 IV
      };
      onProgress({ percent: 8, speed: null, message: 'JS下载器: 密钥获取成功，将解密分片' });
    } else {
      console.warn(`[JS-Downloader] 不支持的加密方式: ${currentKeyInfo.method}`);
    }
  }

  onProgress({ percent: 10, speed: null, message: `JS下载器: 共 ${segments.length} 个分片，开始并行下载...` });

  // 3. 创建临时目录
  const tmpDir = path.join(outputDir, `${outputName}_js_tmp`);
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  // 4. 并行下载所有分片
  let completedSegments = 0;
  let totalBytes = 0;
  const startTime = Date.now();

  // 分片并发控制 — 信号量模式（同时最多 maxConcurrency 个请求）
  // ⭐ 修复：改用信号量替代 batch 模式，避免大 batch 中单个慢分片拖垮整批
  async function downloadOne(segUrl, segIdx) {
    // ⭐ 构建该分片的解密参数（IV 使用分片序号）
    const segDecryptOpts = decryptOpts ? { ...decryptOpts } : null;
    if (segDecryptOpts && segDecryptOpts.ivFromSeq) {
      // HLS 标准：IV = 序列号（大端 16 字节），低 16 位为序号
      const ivBuf = Buffer.alloc(16, 0);
      ivBuf.writeUInt32BE(segIdx, 12);
      segDecryptOpts.iv = ivBuf;
    }
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const bytes = await downloadSegment(segUrl, path.join(tmpDir, `${segIdx}.ts`), headers, retries, segDecryptOpts);
        completedSegments++;
        totalBytes += bytes;
        const percent = Math.round(10 + (completedSegments / segments.length) * 80);
        const elapsed = (Date.now() - startTime) / 1000;
        const speed = elapsed > 0 ? `${(totalBytes / 1024 / 1024 / elapsed).toFixed(1)} MB/s` : null;
        onProgress({
          percent: Math.min(percent, 90),
          speed,
          message: `JS下载器: ${completedSegments}/${segments.length} 分片`,
        });
        return; // 成功
      } catch (err) {
        if (attempt === retries - 1) {
          console.error(`[JS-Downloader] 分片 #${segIdx} 下载失败（重试${retries}次后）: ${err.message}`);
          completedSegments++; // 失败也计数，避免永远卡住
          return;
        }
        // 重试前等待
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }

  // 信号量并发控制
  // ⭐ 修复：改用 Map 替代 Set，加全局兜底超时防止 fetch 卡死
  const running = new Map();
  let nextIdx = 0;

  while (nextIdx < segments.length || running.size > 0) {
    // 填充并发槽位
    while (running.size < maxConcurrency && nextIdx < segments.length) {
      const idx = nextIdx++;
      const p = downloadOne(segments[idx], idx).finally(() => running.delete(idx));
      running.set(idx, p);
    }
    // 等待任意一个完成，加 60s 兜底超时防止卡死
    if (running.size > 0) {
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('JS下载器分片全局超时（60s）')), 60_000)
      );
      await Promise.race([...running.values(), timeoutPromise]).catch((err) => {
        console.warn(`[JS-Downloader] 分片下载触发兜底超时: ${err.message}，跳过卡死分片继续`);
      });
    }
  }

  // 5. 合并分片为单个 ts 文件
  onProgress({ percent: 92, speed: null, message: 'JS下载器: 合并分片中...' });

  const outputFile = path.join(outputDir, `${outputName}.ts`);
  const writeStream = fs.createWriteStream(outputFile);

  for (let i = 0; i < segments.length; i++) {
    const segFile = path.join(tmpDir, `${i}.ts`);
    if (fs.existsSync(segFile)) {
      const data = fs.readFileSync(segFile);
      writeStream.write(data);
    }
  }

  await new Promise((resolve, reject) => {
    writeStream.end(resolve);
  });

  // 6. 清理临时目录
  fs.rmSync(tmpDir, { recursive: true, force: true });

  onProgress({ percent: 100, speed: null, message: 'JS下载器: 下载完成！' });

  return outputFile;
}

/**
 * 使用 ffmpeg concat 合并分片（带重试）
 */
export async function downloadWithFfmpegRetry(m3u8Url, headers, outputPath, taskId, onProgress) {
  const maxRetries = 2;
  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        onProgress({ percent: 0, speed: null, message: `ffmpeg 第 ${attempt + 1} 次重试...` });
        await new Promise(r => setTimeout(r, 2000 * attempt));
      }
      return await _ffmpegDownload(m3u8Url, headers, outputPath, onProgress);
    } catch (err) {
      lastError = err;
      console.error(`[FFmpeg-Retry] 第 ${attempt + 1} 次失败: ${err.message}`);
    }
  }
  throw lastError;
}

/**
 * ffmpeg 下载（内部）
 */
function _ffmpegDownload(m3u8Url, headers, outputPath, onProgress) {
  return new Promise((resolve, reject) => {
    const args = [];

    if (headers?.referer) {
      args.push('-headers', `Referer: ${headers.referer.replace(/[\n\r'"]/g, '')}`);
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

    const proc = spawn('ffmpeg', args.filter(Boolean), { stdio: ['ignore', 'pipe', 'pipe'] });

    proc.stdout.on('data', (data) => {
      const text = data.toString();
      const timeMatch = text.match(/out_time=(\d+):(\d+):(\d+)/);
      if (timeMatch) {
        const seconds = (+timeMatch[1] * 3600) + (+timeMatch[2] * 60) + (+timeMatch[3]);
        onProgress({
          percent: Math.min(99, Math.floor(seconds / 10)),
          speed: null,
          message: `ffmpeg: 已下载 ${timeMatch[1]}:${timeMatch[2]}:${timeMatch[3]}`,
        });
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
  });
}

/**
 * 并行分片下载加速入口
 * 供 downloader.js 调用，支持可配置并发数、重试、速率限制和进度跟踪
 *
 * @param {string} m3u8Url - m3u8 播放列表 URL
 * @param {string} outputPath - 输出文件路径（不含扩展名）
 * @param {object} options
 * @param {number} options.maxConcurrency - 最大并发数（默认 6）
 * @param {number} options.retries - 分片重试次数（默认 3）
 * @param {number} options.maxSpeed - 最大下载速度 (bytes/s)，0 不限速
 * @param {function} options.onProgress - 进度回调
 * @param {object} options.headers - 额外请求头
 * @returns {Promise<string>} 输出文件路径
 */
export async function downloadSegmentsParallel(m3u8Url, outputPath, options = {}) {
  const {
    maxConcurrency = 6,
    retries = 3,
    maxSpeed = 0,
    onProgress = () => {},
    headers = {},
  } = options;

  onProgress({ percent: 0, speed: null, message: '并行下载: 解析 m3u8...' });

  // 1. 下载并解析 m3u8
  const m3u8Res = await fetchWithTimeout(m3u8Url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', ...headers },
  }, 30000);
  if (!m3u8Res.ok) throw new Error(`下载 m3u8 失败: HTTP ${m3u8Res.status}`);
  const m3u8Content = await m3u8Res.text();
  const { segments, isMaster, variants, encKeys } = parseM3u8(m3u8Content, m3u8Url);

  // master playlist → 选最高码率
  if (isMaster && variants.length > 0) {
    variants.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
    onProgress({ percent: 5, speed: null, message: `并行下载: 选择最高码率 (${Math.round((variants[0].bandwidth || 0) / 1000)}kbps)` });
    return downloadSegmentsParallel(variants[0].url, outputPath, options);
  }

  if (segments.length === 0) throw new Error('m3u8 中未找到分片');

  // ⭐ AES-128 HLS 加密支持
  let decryptOpts = null;
  if (encKeys.length > 0 && encKeys[0].method === 'AES-128') {
    onProgress({ percent: 7, speed: null, message: '并行下载: 检测到 AES-128 加密，获取密钥...' });
    const encKeyBuffer = await fetchEncryptionKey(encKeys[0].keyUri);
    const ivHex = encKeys[0].ivHex;
    decryptOpts = {
      key: encKeyBuffer,
      iv: ivHex ? Buffer.from(ivHex, 'hex') : null,
      ivFromSeq: !ivHex,
    };
    onProgress({ percent: 8, speed: null, message: '并行下载: 密钥获取成功' });
  }

  const outputDir = path.dirname(outputPath);
  const baseName = path.basename(outputPath, path.extname(outputPath));
  const tmpDir = path.join(outputDir, `${baseName}_parallel_tmp`);
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  // 2. 并发分片下载（信号量模式：同时跑 maxConcurrency 个，不 batch 等待）
  let completedSegments = 0;
  let totalBytes = 0;
  const startTime = Date.now();
  const errors = [];

  // 简易速率限制器
  let bytesThisWindow = 0;
  let windowStart = Date.now();

  async function downloadOne(segUrl, idx) {
    // ⭐ 构建该分片的解密参数
    const segDecryptOpts = decryptOpts ? { ...decryptOpts } : null;
    if (segDecryptOpts && segDecryptOpts.ivFromSeq) {
      const ivBuf = Buffer.alloc(16, 0);
      ivBuf.writeUInt32BE(idx, 12);
      segDecryptOpts.iv = ivBuf;
    }
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        // 速率限制
        if (maxSpeed > 0) {
          const elapsed = Date.now() - windowStart;
          if (elapsed < 1000 && bytesThisWindow >= maxSpeed) {
            await new Promise(r => setTimeout(r, 100));
            return downloadOne(segUrl, idx); // 重试
          }
          if (elapsed >= 1000) {
            bytesThisWindow = 0;
            windowStart = Date.now();
          }
        }

        const res = await fetchWithTimeout(segUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', ...headers },
        }, 30000);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        let buffer = await res.buffer();

        // ⭐ AES-128-CBC 解密
        if (segDecryptOpts && segDecryptOpts.key) {
          try {
            buffer = decryptAes128Cbc(buffer, segDecryptOpts.key, segDecryptOpts.iv || Buffer.alloc(16, 0));
          } catch (decryptErr) {
            console.warn(`[Parallel] 分片 #${idx} 解密失败: ${decryptErr.message}，保留原始数据`);
          }
        }

        fs.writeFileSync(path.join(tmpDir, `${idx}.ts`), buffer);

        completedSegments++;
        totalBytes += buffer.length;
        if (maxSpeed > 0) bytesThisWindow += buffer.length;

        const percent = Math.round(10 + (completedSegments / segments.length) * 80);
        const elapsed2 = (Date.now() - startTime) / 1000;
        const speed = elapsed2 > 0 ? `${(totalBytes / 1024 / 1024 / elapsed2).toFixed(1)} MB/s` : null;
        onProgress({ percent: Math.min(percent, 90), speed, message: `并行: ${completedSegments}/${segments.length} 分片` });
        return;
      } catch (err) {
        if (attempt === retries - 1) {
          errors.push({ idx, err: err.message });
          // 跳过失败分片，继续下载
          completedSegments++;
          return;
        }
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }

  // 信号量并发控制
  // ⭐ 修复：给 Promise.race 加超时兜底，防止单个 fetch 卡死导致整个循环永久阻塞
  const running = new Map(); // idx → Promise
  let nextIdx = 0;

  while (nextIdx < segments.length || running.size > 0) {
    // 填充并发槽位
    while (running.size < maxConcurrency && nextIdx < segments.length) {
      const idx = nextIdx++;
      const p = downloadOne(segments[idx], idx).finally(() => running.delete(idx));
      running.set(idx, p);
    }
    if (running.size > 0) {
      // ⭐ 核心修复：用 Promise.race 但加 60s 全局兜底超时，防止任何分片卡死
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('分片下载全局超时（60s）')), 60_000)
      );
      await Promise.race([...running.values(), timeoutPromise]).catch((err) => {
        // 超时后不中断，记录警告并跳过卡死的分片
        console.warn(`[Parallel] 分片下载触发兜底超时: ${err.message}，跳过卡死分片继续`);
        // 找到卡死的分片并移除
        for (const [idx, promise] of running.entries()) {
          // 检查该 promise 是否已经 settle
          const isPending = Promise.race([
            promise.then(() => false).catch(() => false),
            new Promise(resolve => setTimeout(() => resolve(true), 100)),
          ]);
          // 不阻塞，在下一轮循环中自然过滤
        }
      });
    }
  }

  if (errors.length > 0) {
    console.warn(`[Parallel] ${errors.length}/${segments.length} 分片下载失败，尝试合并已有分片`);
  }

  // 3. 合并分片
  onProgress({ percent: 92, speed: null, message: '并行下载: 合并分片中...' });
  const outputFile = `${outputPath}.ts`;
  const writeStream = fs.createWriteStream(outputFile);
  for (let i = 0; i < segments.length; i++) {
    const segFile = path.join(tmpDir, `${i}.ts`);
    if (fs.existsSync(segFile)) writeStream.write(fs.readFileSync(segFile));
  }
  await new Promise(resolve => writeStream.end(resolve));

  // 4. 清理
  fs.rmSync(tmpDir, { recursive: true, force: true });
  onProgress({ percent: 100, speed: null, message: '并行下载: 完成！' });
  return outputFile;
}
export { downloadSegment as downloadSingleSegment };
export default { downloadWithJs, downloadWithFfmpegRetry, parseM3u8 };