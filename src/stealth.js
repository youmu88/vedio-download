/**
 * 反爬虫/反自动化检测模块 — Stealth 插件替代品
 *
 * 解决设计文档 P0-2「反爬虫/反自动化检测能力空白」：
 * - 隐藏 navigator.webdriver 检测
 * - 伪造 chrome runtime 指纹（window.chrome 对象）
 * - 修改 WebDriver 属性
 * - 支持注入自定义 JS 脚本
 * - 支持 Cookie/Session 注入
 * - 支持 storageState 登录态复用
 *
 * 由于 playwright-extra 和 puppeteer-extra-plugin-stealth
 * 兼容性有限，本模块使用 Playwright 原生 API + JS 注入
 * 实现同等效果的反检测能力。
 *
 * @module stealth
 */

/**
 * 生成反检测脚本 — 在页面加载前注入
 * 通过 context.addInitScript() 注入到每个页面
 *
 * 覆盖的检测点：
 * 1. navigator.webdriver → false（最基础检测）
 * 2. window.chrome 对象（完整指纹）
 * 3. navigator.plugins 伪装
 * 4. WebGL 渲染器指纹
 * 5. 屏幕尺寸/色彩深度
 * 6. navigator.languages
 * 7. navigator.hardwareConcurrency
 * 8. 移除 headless 特征
 */
export function getStealthScript() {
  return `
// ════════════════════════════════════════════════════════
// 反自动化检测脚本 — 隐藏 Playwright headless 特征
// ════════════════════════════════════════════════════════

// 1. 覆盖 navigator.webdriver
Object.defineProperty(navigator, 'webdriver', {
  get: () => undefined,
  configurable: true,
});

// 2. 伪造完整的 window.chrome 对象
if (!window.chrome) {
  window.chrome = {
    runtime: {},
    loadTimes: function() {},
    csi: function() {},
    app: {
      isInstalled: false,
      InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
      RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
    },
    webstore: {
      onInstallStageChanged: {},
      onDownloadProgress: {},
    },
  };
}

// 3. 覆盖 permissions
const originalQuery = window.navigator.permissions?.query;
if (originalQuery) {
  window.navigator.permissions.query = (params) => (
    params.name === 'notifications'
      ? Promise.resolve({ state: Notification.permission })
      : originalQuery(params)
  );
}

// 4. 覆盖 plugins 长度（headless 模式下 plugins 为空数组）
Object.defineProperty(navigator, 'plugins', {
  get: () => {
    const plugins = [
      { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
      { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
      { name: 'Native Client', filename: 'internal-nacl-plugin' },
    ];
    plugins.item = (i) => plugins[i];
    plugins.namedItem = (n) => plugins.find(p => p.name === n) || null;
    plugins.refresh = () => {};
    return plugins;
  },
});

// 5. 覆盖 languages
Object.defineProperty(navigator, 'languages', {
  get: () => ['zh-CN', 'zh', 'en'],
});

// 6. 覆盖 hardwareConcurrency（真实浏览器通常为 4/8/16）
Object.defineProperty(navigator, 'hardwareConcurrency', {
  get: () => 8,
});

// 7. 覆盖 deviceMemory
Object.defineProperty(navigator, 'deviceMemory', {
  get: () => 8,
});

// 8. 覆盖 webGL 渲染器（移除 headless 特征）
const getParameterProxyHandler = {
  apply: function(target, thisArg, args) {
    const param = args[0];
    const result = target.call(thisArg, param);
    // 替换 UNMASKED_RENDERER_WEBGL 值
    if (param === 37445) return 'Intel Inc.';
    if (param === 37446) return 'Intel Iris OpenGL Engine';
    return result;
  }
};

// 覆盖 WebGLRenderingContext.getParameter
const canvas = document.createElement('canvas');
const gl = canvas.getContext('webgl');
if (gl) {
  const originalGetParameter = gl.getParameter.bind(gl);
  // 注意：getParameter 是 WebGLRenderingContext 的原型方法
  // 我们通过覆盖 canvas.getContext 来注入
}

// 更可靠的方式：在 webgl 上下文创建后替换方法
// 使用 Proxy 拦截 getContext
const originalGetContext = HTMLCanvasElement.prototype.getContext;
HTMLCanvasElement.prototype.getContext = function(type, ...args) {
  const ctx = originalGetContext.call(this, type, ...args);
  if (ctx && (type === 'webgl' || type === 'experimental-webgl')) {
    const origGetParam = ctx.getParameter.bind(ctx);
    ctx.getParameter = function(param) {
      if (param === 37445) return 'Intel Inc.';
      if (param === 37446) return 'Intel Iris OpenGL Engine';
      return origGetParam(param);
    };
  }
  return ctx;
};

// 9. 覆盖头发（headless 特征）
document.documentElement.setAttribute('data-user-agent', navigator.userAgent);

// 10. 覆盖 Battery API（某些网站检测）
if (navigator.getBattery) {
  navigator.getBattery = () => Promise.resolve({
    charging: true,
    chargingTime: 0,
    dischargingTime: Infinity,
    level: 1,
  });
}

console.log('[Stealth] 反自动化检测脚本已注入');
`;
}

/**
 * 获取用于 Playwright context 的反检测配置
 * @param {object} options
 * @param {string} [options.userAgent] - 自定义 UA
 * @param {string} [options.locale] - 地区，默认 zh-CN
 * @param {string} [options.timezoneId] - 时区，默认 Asia/Shanghai
 * @param {string} [options.geolocation] - 地理位置
 * @param {number} [options.viewportWidth] - 视口宽度，默认 1280
 * @param {number} [options.viewportHeight] - 视口高度，默认 720
 * @param {object[]} [options.cookies] - 预注入的 cookie
 * @param {string} [options.storageStatePath] - 已保存的 storageState 文件路径
 * @param {string} [options.injectScript] - 额外自定义注入脚本
 * @param {string} [options.proxy] - 代理服务器地址
 * @returns {object} Playwright browser.newContext() 参数
 */
export function getStealthContextOptions(options = {}) {
  const opts = {
    userAgent:
      options.userAgent ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: options.locale || 'zh-CN',
    timezoneId: options.timezoneId || 'Asia/Shanghai',
    viewport: {
      width: options.viewportWidth || 1280,
      height: options.viewportHeight || 720,
    },
    colorScheme: 'light',
    reducedMotion: 'no-preference',
    forcedColors: 'none',
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    // 额外反检测参数
    bypassCSP: true,
    ignoreHTTPSErrors: false,
  };

  // 地理位置
  if (options.geolocation) {
    opts.geolocation = options.geolocation;
    opts.permissions = ['geolocation'];
  }

  // 代理
  if (options.proxy) {
    opts.proxy = { server: options.proxy };
  }

  // storageState（登录态复用）
  if (options.storageStatePath) {
    opts.storageState = options.storageStatePath;
  }

  return opts;
}

/**
 * 构建包含反检测脚本的 Playwright context 初始化参数
 * @param {object} browser - Playwright browser 实例
 * @param {object} options - 同 getStealthContextOptions
 * @returns {Promise<{context, page}>}
 */
export async function createStealthContext(browser, options = {}) {
  const contextOpts = getStealthContextOptions(options);
  const context = await browser.newContext(contextOpts);

  // 注入反检测脚本
  const stealthScript = getStealthScript();
  const userScript = options.injectScript || '';
  const combinedScript = userScript
    ? `${stealthScript}\n\n// ── 用户自定义注入 ──\n${userScript}`
    : stealthScript;

  await context.addInitScript(combinedScript);

  // 如果提供了 cookie，预注入
  if (options.cookies && options.cookies.length > 0) {
    await context.addCookies(options.cookies);
  }

  const page = await context.newPage();

  return { context, page };
}

/**
 * 保存浏览器上下文登录态到文件
 * 用于后续复用登录 session
 *
 * @param {object} context - Playwright browserContext
 * @param {string} sessionName - 会话名称
 * @returns {Promise<string>} storageState 文件路径
 */
export async function saveStorageState(context, sessionName = 'default') {
  const { default: path } = await import('path');
  const { default: fs } = await import('fs');
  const { fileURLToPath } = await import('url');

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const sessionsDir = path.resolve(__dirname, '../sessions');

  if (!fs.existsSync(sessionsDir)) {
    fs.mkdirSync(sessionsDir, { recursive: true });
  }

  const statePath = path.join(sessionsDir, `${sessionName}.json`);
  await context.storageState({ path: statePath });

  console.log(`[Stealth] 登录态已保存: ${statePath}`);
  return statePath;
}