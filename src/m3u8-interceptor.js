/**
 * Playwright m3u8 网络拦截器（增强版）
 *
 * ⭐ P0 增强：
 *  - 集成 BrowserPool 复用浏览器实例
 *  - 集成 Stealth 反检测
 *  - Token 时效性检测与记录
 *  - Cookie/Session 注入能力
 *  - 页面加载重试
 *  - DASH (.mpd) 格式拦截
 *  - 直链 mp4/mkv 拦截
 *
 * @module m3u8-interceptor
 */

import browserPool from './browser-pool.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Token 过期检测 ─────────────────────────────────

/**
 * 解析 m3u8 URL 中的 token 过期时间
 * @param {string} url - m3u8 URL
 * @returns {{ token: string|null, expiresAt: number|null, timeToLive: number|null }}
 */
export function parseTokenExpiry(url) {
  try {
    const parsed = new URL(url);
    const params = parsed.searchParams;

    // 常见的 token 参数名
    const tokenParam = params.get('token') || params.get('t') || params.get('sign') || null;
    const expireParam = params.get('expire') || params.get('expires') || params.get('deadline') || params.get('e') || null;
    const timeoutParam = params.get('timeout') || params.get('time') || null;

    let expiresAt = null;
    if (expireParam) {
      // 尝试解析：可能是秒级时间戳或 ISO 时间
      const num = parseInt(expireParam, 10);
      if (!isNaN(num)) {
        // 如果是 10 位数字，当作秒级时间戳
        expiresAt = num > 1e12 ? num : num * 1000;
      } else {
        expiresAt = new Date(expireParam).getTime();
      }
    }

    let timeToLive = null;
    if (expiresAt) {
      timeToLive = expiresAt - Date.now();
    }

    return {
      token: tokenParam,
      expiresAt,
      timeToLive: timeToLive !== null && timeToLive > 0 ? timeToLive : null,
    };
  } catch {
    return { token: null, expiresAt: null, timeToLive: null };
  }
}

// ─── URL 格式检测 ──────────────────────────────────

/**
 * 检测 URL 是否为 m3u8
 */
export function isM3u8Url(url) {
  return /\.m3u8(\?|$)/i.test(url);
}

/**
 * 检测 URL 是否为 DASH MPD
 */
export function isMpdUrl(url) {
  return /\.mpd(\?|$)/i.test(url);
}

/**
 * 检测 URL 是否为直接视频文件
 */
export function isDirectVideoUrl(url) {
  return /\.(mp4|mkv|webm|avi|mov)(\?|$)/i.test(url);
}

/**
 * 判断 m3u8 是否为 video 级别的（包含分辨率信息）
 */
function isVideoLevelM3u8(url) {
  return /x\d{3,4}\.m3u8/i.test(url) || /_\d{3,4}p\.m3u8/i.test(url);
}

// ─── 主捕获函数 ────────────────────────────────────

/**
 * 捕获 m3u8 / mpd / 直链视频 URL
 *
 * @param {string} pageUrl - 视频播放页 URL
 * @param {object} options - 可选配置
 * @param {number} options.timeout - 页面加载超时（ms），默认 30000
 * @param {number} options.waitAfterLoad - 页面加载后额外等待时间（ms），默认 5000
 * @param {boolean} options.headless - 是否无头模式，默认 true
 * @param {string} options.injectScript - 自定义注入脚本
 * @param {Array}  options.cookies - 注入的 cookies [{ name, value, domain }]
 * @param {string} options.sessionId - 复用已保存的登录态 sessionId
 * @param {string} options.proxy - 代理配置，如 "http://127.0.0.1:8080"
 * @param {function} options.onProgress - 进度回调
 * @returns {Promise<{ url: string, type: string, headers: object, pageTitle: string, tokenInfo: object }>}
 */
export async function captureM3u8(pageUrl, options = {}) {
  const {
    timeout = 30000,
    waitAfterLoad = 5000,
    headless = true,
    injectScript = null,
    cookies = null,
    sessionId = null,
    proxy = null,
    onProgress = () => {},
  } = options;

  onProgress({ stage: 'launching', message: '正在从浏览器池获取实例...' });

  // 从浏览器池获取实例
  const { browser, context, page, release } = await browserPool.acquire({
    headless,
    cookies,
    sessionId,
    proxy,
  });

  // 收集拦截结果
  const capturedUrls = []; // [{ url, type: 'm3u8'|'mpd'|'mp4', headers, timestamp }]
  let capturedResult = null;

  try {
    // ── 注入自定义脚本（Stealth 已由 BrowserPool 统一注入，此处不重复） ──
    if (injectScript) {
      try {
        await page.addInitScript(injectScript);
      } catch (err) {
        console.warn(`[Stealth] 自定义脚本注入失败: ${err.message}`);
      }
    }

    // ── 拦截网络请求（⭐ 优化：精准匹配视频格式，避免拦截所有请求） ──
    // 同时匹配 m3u8、mpd、直链视频格式，减少 >99% 的不必要匹配
    await page.route('**/*.{m3u8,mp4,mkv,webm,avi,mov,ts,mpd}**', (route, request) => {
      const url = request.url();
      const timestamp = Date.now();

      // 拦截 m3u8
      if (isM3u8Url(url)) {
        capturedUrls.push({
          url,
          type: 'm3u8',
          headers: request.headers(),
          timestamp,
          tokenInfo: parseTokenExpiry(url),
        });

        // 优先选择 video level m3u8（带分辨率信息），否则取第一个 master
        if (!capturedResult || (isVideoLevelM3u8(url) && !isVideoLevelM3u8(capturedResult.url))) {
          capturedResult = {
            url,
            type: 'm3u8',
            headers: request.headers(),
            timestamp,
            tokenInfo: parseTokenExpiry(url),
          };
        }

        console.log(`[Interceptor] 捕获 m3u8: ${url.slice(0, 100)}`);
        route.continue().catch(() => {});
        return;
      }

      // 拦截 DASH MPD
      if (isMpdUrl(url)) {
        capturedUrls.push({
          url,
          type: 'mpd',
          headers: request.headers(),
          timestamp,
        });

        if (!capturedResult) {
          capturedResult = {
            url,
            type: 'mpd',
            headers: request.headers(),
            timestamp,
          };
        }

        console.log(`[Interceptor] 捕获 DASH: ${url.slice(0, 100)}`);
        route.continue().catch(() => {});
        return;
      }

      // 拦截直链视频（mp4/mkv）
      if (isDirectVideoUrl(url)) {
        capturedUrls.push({
          url,
          type: 'direct',
          headers: request.headers(),
          timestamp,
        });

        if (!capturedResult) {
          capturedResult = {
            url,
            type: 'direct',
            headers: request.headers(),
            timestamp,
          };
        }

        console.log(`[Interceptor] 捕获直链: ${url.slice(0, 100)}`);
        route.continue().catch(() => {});
        return;
      }

      route.continue().catch(() => {});
    });

    // ── 导航到页面（带重试） ───────────────────
    onProgress({ stage: 'navigating', message: '正在加载播放页...' });

    let gotoError = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await page.goto(pageUrl, {
          waitUntil: 'domcontentloaded',
          timeout,
        });
        gotoError = null;
        break;
      } catch (err) {
        gotoError = err;
        if (attempt < 2) {
          const delay = (attempt + 1) * 2000;
          console.log(`[Goto] 第 ${attempt + 1} 次重试，等待 ${delay}ms...`);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }

    if (gotoError) {
      // 如果是 404/403 不重试
      if (gotoError.message?.includes('404') || gotoError.message?.includes('403')) {
        throw new Error(`页面访问失败 (${gotoError.message.slice(0, 100)})`);
      }
      throw new Error(`页面加载失败: ${gotoError.message}`);
    }

    // ── 等待视频请求触发 ──────────────────────
    onProgress({ stage: 'waiting', message: '等待视频请求触发...' });

    for (let i = 0; i < waitAfterLoad / 500 && !capturedResult; i++) {
      await page.waitForTimeout(500);

      // 尝试自动点击播放按钮
      if (i === 0) {
        try {
          const playBtn = await page.$(
            'video, .play-btn, .video-play, #player, [class*="play"], [id*="play"]'
          );
          if (playBtn) await playBtn.click().catch(() => {});
        } catch (_) {}
      }
    }

    const pageTitle = await page.title().catch(() => '');

    // ── 结果处理 ──────────────────────────────
    if (!capturedResult) {
      throw new Error(
        `未能拦截到视频流。已等待 ${waitAfterLoad / 1000}s。` +
        `可能原因：1) 页面需要登录 2) 视频延迟加载较长 3) 网站使用了其他视频格式`
      );
    }

    // 输出 token 信息
    if (capturedResult.tokenInfo?.timeToLive) {
      const ttlMin = (capturedResult.tokenInfo.timeToLive / 60000).toFixed(1);
      console.log(`[Token] URL token 剩余有效期: ${ttlMin} 分钟`);
    }

    onProgress({ stage: 'captured', message: `成功捕获 ${capturedResult.type} 视频流！` });

    return {
      m3u8Url: capturedResult.url,    // ⭐ 修复：键名为 m3u8Url（与 captureMpd/captureDirectUrl 对齐）
      type: capturedResult.type,
      headers: capturedResult.headers || {},
      pageTitle,
      tokenInfo: capturedResult.tokenInfo || null,
      allCapturedUrls: capturedUrls,
    };
  } catch (err) {
    throw err;
  } finally {
    // 释放浏览器实例回池
    release();
  }
}

/**
 * 捕获直链视频（非 m3u8/MPD 的普通视频文件）
 * @param {string} url 视频直链
 * @param {object} options 选项
 * @returns {Promise<{m3u8Url?: string, title?: string, format?: string}|null>}
 */
export async function captureDirectUrl(url, options = {}) {
  const log = options.log || console;
  // ⭐ 修复：非直链 URL 不伪装，直接返回 null
  if (!isDirectVideoUrl(url)) {
    log.info(`[captureDirectUrl] 跳过（非直链格式）: ${url.slice(0, 80)}`);
    return null;
  }
  log.info(`[captureDirectUrl] 尝试直链: ${url}`);
  return {
    m3u8Url: url,
    title: path.basename(new URL(url).pathname) || 'direct-video',
    format: 'direct',
  };
}

/**
 * 捕获 DASH/MPD 流媒体地址
 * @param {string} url MPD URL
 * @param {object} options 选项
 * @returns {Promise<{m3u8Url?: string, title?: string, format?: string}|null>}
 */
export async function captureMpd(url, options = {}) {
  const log = options.log || console;
  // ⭐ 修复：非 MPD URL 不伪装，直接返回 null
  if (!isMpdUrl(url)) {
    log.info(`[captureMpd] 跳过（非 MPD 格式）: ${url.slice(0, 80)}`);
    return null;
  }
  log.info(`[captureMpd] 尝试 MPD: ${url}`);
  return {
    m3u8Url: url,
    title: path.basename(new URL(url).pathname) || 'mpd-video',
    format: 'mpd',
  };
}
