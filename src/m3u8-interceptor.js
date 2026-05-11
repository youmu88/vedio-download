/**
 * Playwright m3u8 网络拦截器
 * 打开目标播放页，拦截所有 .m3u8 请求，返回 m3u8 URL + 请求头
 */

import { chromium } from 'playwright';

/**
 * 捕获 m3u8 URL
 * @param {string} pageUrl    - 视频播放页 URL
 * @param {object} options    - 可选配置
 * @param {number} options.timeout      - 页面加载超时（ms），默认 30000
 * @param {number} options.waitAfterLoad - 页面加载后额外等待时间（ms），默认 5000
 * @param {boolean} options.headless    - 是否无头模式，默认 true
 * @param {function} options.onProgress - 进度回调
 * @returns {Promise<{m3u8Url: string, headers: object, pageTitle: string}>}
 */
export async function captureM3u8(pageUrl, options = {}) {
  const {
    timeout = 30000,
    waitAfterLoad = 5000,
    headless = true,
    onProgress = () => {},
  } = options;

  onProgress({ stage: 'launching', message: '正在启动浏览器...' });

  const browser = await chromium.launch({
    headless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 720 },
  });

  const page = await context.newPage();
  let capturedM3u8 = null;
  let capturedHeaders = null;

  // ── 核心：拦截所有 .m3u8 网络请求 ──────────────────
  await page.route('**/*', (route, request) => {
    const url = request.url();
    // 匹配 .m3u8 或 .m3u8?xxx
    if (/\.m3u8(\?|$)/i.test(url)) {
      capturedM3u8 = url;
      capturedHeaders = request.headers();
      console.log(`[m3u8] 拦截到: ${url}`);
      // 仍然放行，但记录下来了
      route.continue().catch(() => {});
    } else {
      route.continue().catch(() => {});
    }
  });

  try {
    onProgress({ stage: 'navigating', message: '正在加载播放页...' });

    // 打开页面，domcontentloaded 即可（不等待所有资源加载完）
    await page.goto(pageUrl, {
      waitUntil: 'domcontentloaded',
      timeout,
    });

    onProgress({ stage: 'waiting', message: '等待视频请求触发...' });

    // 等待一段时间让页面 JS 触发视频加载
    // 同时尝试点击播放按钮（很多网站需要手动触发）
    for (let i = 0; i < waitAfterLoad / 500 && !capturedM3u8; i++) {
      await page.waitForTimeout(500);

      // 尝试自动点击常见的播放按钮
      if (i === 0) {
        try {
          const playBtn = await page.$(
            'video, .play-btn, .video-play, #player, [class*="play"], [id*="play"]'
          );
          if (playBtn) await playBtn.click().catch(() => {});
        } catch (_) {
          // 忽略点击错误
        }
      }
    }

    const pageTitle = await page.title();

    if (!capturedM3u8) {
      throw new Error(
        `未能拦截到 .m3u8 请求。已等待 ${waitAfterLoad / 1000}s。` +
        `可能原因：1) 页面需要登录 2) 视频延迟加载较长 3) 网站使用了其他视频格式`
      );
    }

    onProgress({ stage: 'captured', message: '成功捕获 m3u8 URL！' });

    return {
      m3u8Url: capturedM3u8,
      headers: capturedHeaders,
      pageTitle,
    };
  } finally {
    await browser.close();
  }
}
