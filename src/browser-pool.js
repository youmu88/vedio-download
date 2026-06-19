/**
 * 浏览器池（Browser Pool） — 管理 Playwright 浏览器实例的复用与健康
 *
 * 解决设计文档 P0-1「浏览器实例泄漏与崩溃恢复」：
 * - 预启动 2~3 个 browser context，复用而非每次新建
 * - 池化策略：最大实例数 = maxConcurrent，空闲超时 60s 自动回收
 * - 健康检查：每次 acquire 前 ping browser.isConnected()，断开则自动重建
 * - 硬超时兜底：30s 硬超时强制关闭
 * - 僵尸进程巡检：每 5 分钟检查僵尸 Chromium 进程
 *
 * @module browser-pool
 */

import { chromium } from 'playwright';
import { spawn, execSync } from 'child_process';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── 默认配置 ───────────────────────────────────────
const DEFAULTS = {
  maxInstances: 6,              // 最大浏览器实例数（从3调整为6，支持更多并发解析）
  idleTimeoutMs: 60_000,        // 空闲超时 60s
  hardTimeoutMs: 30_000,        // 基础硬超时 30s（实际超时 = 基础超时 + 排队位置 * 每任务额外时间）
  extraTimeoutPerQueuedMs: 15_000, // 每个排队任务额外增加 15s 超时
  maxHardTimeoutMs: 120_000,    // 最大硬超时上限 120s（2分钟）
  zombieCheckIntervalMs: 300_000, // 僵尸进程巡检间隔 5min
  pollIntervalMs: 500,          // 等待队列轮询间隔（检查是否有空闲实例）
  launchArgs: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-web-security',
    '--disable-features=IsolateOrigins,site-per-process',
    '--disable-blink-features=AutomationControlled', // 隐藏自动化标记
    '--disable-dev-shm-usage',
  ],
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

// ─── 内部状态 ───────────────────────────────────────
let instanceCounter = 0;
let zombieTimer = null;

/**
 * 浏览器池单例
 */
class BrowserPool {
  constructor(options = {}) {
    this.config = { ...DEFAULTS, ...options };
    this.instances = []; // { browser, context, page, createdAt, lastUsedAt, busy }
    this.waitQueue = []; // [{ resolve, reject, timeoutId, pollInterval }]
    this._destroyed = false;

    // 启动僵尸进程巡检
    this._startZombieWatcher();
  }

  /**
   * 从池中获取一个浏览器实例（含 context 和 page）
   * @param {object} [extraOpts] - 额外配置，如 { headless, cookies, injectScript, proxy }
   * @returns {Promise<{ browser, context, page, release: Function }>}
   */
  async acquire(extraOpts = {}) {
    if (this._destroyed) {
      throw new Error('BrowserPool 已销毁');
    }

    // 先清理过期空闲实例
    this._reapIdleInstances();

    // 查找可用实例
    let instance = this.instances.find(
      (inst) => !inst.busy && this._isHealthy(inst)
    );

    if (!instance && this.instances.length < this.config.maxInstances) {
      // 创建新实例
      instance = await this._createInstance(extraOpts);
      this.instances.push(instance);
    }

    if (instance) {
      instance.busy = true;
      instance.lastUsedAt = Date.now();

      // 返回包装对象，含 release 方法
      return this._wrapInstance(instance, extraOpts);
    }

    // ─── 无可用实例，加入等待队列（轮询等待） ───
    // 改进：每 500ms 轮询检查是否有空闲实例，而不是被动等 release() 触发
    // ⭐ 修复：动态超时，排队越靠后的任务等待时间越长，避免前序任务解析稍慢就全部超时
    return new Promise((resolve, reject) => {
      const pollInterval = setInterval(() => {
        // 再次清理过期实例
        this._reapIdleInstances();

        // 查找刚释放的空闲实例
        let idleInst = this.instances.find(
          (inst) => !inst.busy && this._isHealthy(inst)
        );

        // 如果没有空闲实例但还有容量，尝试创建新实例
        if (!idleInst && this.instances.length < this.config.maxInstances) {
          // 异步创建，不要阻塞轮询
          this._createInstance(extraOpts)
            .then((newInst) => {
              // 检查这个等待者是否还在队列中（可能已经被超时移除了）
              const idx = this.waitQueue.findIndex((w) => w.pollInterval === pollInterval);
              if (idx === -1) {
                // 已超时移除，销毁新创建的实例
                this._destroyInstance(newInst).catch(() => {});
                return;
              }

              newInst.busy = true;
              newInst.lastUsedAt = Date.now();
              this.instances.push(newInst);

              // 从队列移除
              const [entry] = this.waitQueue.splice(idx, 1);
              clearInterval(entry.pollInterval);
              clearTimeout(entry.timeoutId);

              resolve(this._wrapInstance(newInst, extraOpts));
            })
            .catch((err) => {
              // 创建失败，继续轮询等待空闲实例
              console.warn(`[BrowserPool] 等待时创建实例失败: ${err.message}`);
            });
          return; // 等异步结果，不继续本轮检查
        }

        if (idleInst) {
          // 找到空闲实例，从队列移除
          const idx = this.waitQueue.findIndex((w) => w.pollInterval === pollInterval);
          if (idx === -1) return; // 已被超时移除

          const [entry] = this.waitQueue.splice(idx, 1);
          clearInterval(entry.pollInterval);
          clearTimeout(entry.timeoutId);

          idleInst.busy = true;
          idleInst.lastUsedAt = Date.now();
          resolve(this._wrapInstance(idleInst, extraOpts));
        }
      }, this.config.pollIntervalMs);

      // ⭐ 动态超时：排队越靠后，给越多时间（基础 30s + 排队位置 * 15s，上限 120s）
      const queuePosition = this.waitQueue.length; // 加入前的排队位置
      const dynamicTimeout = Math.min(
        this.config.hardTimeoutMs + queuePosition * this.config.extraTimeoutPerQueuedMs,
        this.config.maxHardTimeoutMs
      );

      const timeoutId = setTimeout(() => {
        const idx = this.waitQueue.findIndex((w) => w.pollInterval === pollInterval);
        if (idx !== -1) {
          const [entry] = this.waitQueue.splice(idx, 1);
          clearInterval(entry.pollInterval);
        }
        reject(new Error(`等待浏览器实例超时（${Math.round(dynamicTimeout / 1000)}s）`));
      }, dynamicTimeout);

      this.waitQueue.push({ resolve, reject, timeoutId, pollInterval });
    });
  }

  /**
   * 释放实例回池
   * @param {object} instance - acquire 返回的实例
   */
  async release(instance) {
    if (!instance || !instance._poolInstance) return;
    const inst = instance._poolInstance;

    // 检查健康状况，不健康则销毁
    if (!this._isHealthy(inst)) {
      await this._destroyInstance(inst).catch(() => {});
      return;
    }

    // ⭐ 关闭旧 page 并创建新 page，防止内存累积和路由残留
    try {
      if (inst.page && !inst.page.isClosed()) {
        await inst.page.close().catch(() => {});
      }
      if (inst.context) {
        inst.page = await inst.context.newPage();
      }
    } catch (err) {
      console.warn(`[BrowserPool] 刷新 page 失败 #${inst.id}: ${err.message}`);
    }

    inst.busy = false;
    inst.lastUsedAt = Date.now();
    // ⚡ 注意：不再需要手动调用 _processWaitQueue
    // 等待队列中的任务会通过轮询自动发现这个空闲实例
  }

  /**
   * 获取池状态统计
   */
  stats() {
    return {
      total: this.instances.length,
      busy: this.instances.filter((i) => i.busy).length,
      idle: this.instances.filter((i) => !i.busy).length,
      waiting: this.waitQueue.length,
      maxInstances: this.config.maxInstances,
    };
  }

  /**
   * 销毁整个池
   */
  async destroy() {
    this._destroyed = true;
    if (zombieTimer) {
      clearInterval(zombieTimer);
      zombieTimer = null;
    }

    // 拒绝所有等待队列
    for (const w of this.waitQueue) {
      clearInterval(w.pollInterval);
      clearTimeout(w.timeoutId);
      w.reject(new Error('BrowserPool 已销毁'));
    }
    this.waitQueue = [];

    // 销毁所有实例
    for (const inst of this.instances) {
      await this._destroyInstance(inst).catch(() => {});
    }
    this.instances = [];
  }

  // ─── 内部方法 ─────────────────────────────────────

  /**
   * 创建新的浏览器实例
   */
  async _createInstance(extraOpts) {
    const id = ++instanceCounter;
    console.log(`[BrowserPool] 创建浏览器实例 #${id}（总数: ${this.instances.length + 1}）`);

    const browser = await chromium.launch({
      headless: extraOpts.headless !== false,
      args: this.config.launchArgs,
    });

    const context = await browser.newContext({
      userAgent: this.config.userAgent,
      viewport: { width: 1280, height: 720 },
      // 注入反检测脚本（默认启用）
      bypassCSP: true,
    });

    const page = await context.newPage();

    // 注入反自动化检测脚本
    await this._injectAntiDetectionScripts(context, extraOpts);

    // 如果提供了 cookies，注入到 context
    if (extraOpts.cookies && Array.isArray(extraOpts.cookies)) {
      await context.addCookies(extraOpts.cookies);
    }

    // 注入自定义 JS 脚本
    if (extraOpts.injectScript) {
      await page.addInitScript(extraOpts.injectScript);
    }

    const instance = {
      id,
      browser,
      context,
      page,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      busy: false,
      headless: extraOpts.headless !== false,
    };

    // 监听浏览器断开事件
    browser.on('disconnected', () => {
      console.log(`[BrowserPool] 浏览器实例 #${id} 已断开`);
      this._removeInstance(instance);
    });

    return instance;
  }

  /**
   * 注入反自动化检测脚本到 context 中的所有页面
   */
  async _injectAntiDetectionScripts(context, extraOpts) {
    // 隐藏 navigator.webdriver
    await context.addInitScript(() => {
      // 覆盖 webdriver 属性
      Object.defineProperty(navigator, 'webdriver', {
        get: () => false,
        configurable: true,
      });

      // 伪造 chrome 对象
      if (!window.chrome) {
        window.chrome = {
          runtime: {},
          loadTimes: function () {},
          csi: function () {},
          app: {},
        };
      }

      // 覆盖 plugins 和 mimeTypes
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5],
        configurable: true,
      });

      Object.defineProperty(navigator, 'languages', {
        get: () => ['zh-CN', 'zh', 'en'],
        configurable: true,
      });

      // 隐藏 headless 特征
      // 覆盖 permissions
      const originalQuery = window.navigator.permissions?.query;
      if (originalQuery) {
        window.navigator.permissions.query = (parameters) =>
          parameters.name === 'notifications'
            ? Promise.resolve({ state: Notification.permission })
            : originalQuery(parameters);
      }
    });
  }

  /**
   * 包装实例，提供 release 方法和硬超时保护
   */
  _wrapInstance(instance, extraOpts) {
    const wrapper = {
      _poolInstance: instance,
      browser: instance.browser,
      context: instance.context,
      page: instance.page,

      release: () => {
        this.release(wrapper);
      },
    };

    return wrapper;
  }

  /**
   * 检查浏览器实例是否健康
   */
  _isHealthy(instance) {
    try {
      return instance.browser && instance.browser.isConnected();
    } catch {
      return false;
    }
  }

  /**
   * 销毁单个实例
   */
  async _destroyInstance(instance) {
    const id = instance.id;
    try {
      if (instance.page && !instance.page.isClosed()) {
        await instance.page.close().catch(() => {});
      }
      if (instance.context) {
        await instance.context.close().catch(() => {});
      }
      if (instance.browser && instance.browser.isConnected()) {
        await instance.browser.close().catch(() => {});
      }
    } catch (err) {
      console.warn(`[BrowserPool] 关闭实例 #${id} 时出错: ${err.message}`);
    }
    this._removeInstance(instance);
  }

  /**
   * 从池中移除实例
   */
  _removeInstance(instance) {
    const idx = this.instances.indexOf(instance);
    if (idx !== -1) {
      this.instances.splice(idx, 1);
      console.log(`[BrowserPool] 实例 #${instance.id} 已移除（剩余: ${this.instances.length}）`);
    }
  }

  /**
   * 清理过期空闲实例
   */
  _reapIdleInstances() {
    const now = Date.now();
    for (let i = this.instances.length - 1; i >= 0; i--) {
      const inst = this.instances[i];
      if (
        !inst.busy &&
        now - inst.lastUsedAt > this.config.idleTimeoutMs
      ) {
        console.log(`[BrowserPool] 回收空闲实例 #${inst.id}（空闲 ${(now - inst.lastUsedAt) / 1000}s）`);
        this._destroyInstance(inst).catch(() => {});
      }
    }
  }

  /**
   * 当前忙碌实例数
   */
  runningCount() {
    return this.instances.filter((i) => i.busy).length;
  }

  /**
   * 启动僵尸进程巡检
   */
  _startZombieWatcher() {
    if (zombieTimer) return;

    zombieTimer = setInterval(() => {
      this._checkZombieProcesses();
    }, this.config.zombieCheckIntervalMs);

    // 避免阻止进程退出
    if (zombieTimer.unref) {
      zombieTimer.unref();
    }

    console.log('[BrowserPool] 僵尸进程巡检已启动（每 5 分钟）');
  }

  /**
   * 巡检并清理僵尸 Chromium 进程
   */
  _checkZombieProcesses() {
    try {
      const platform = os.platform();
      let chromiumProcesses = [];

      if (platform === 'darwin' || platform === 'linux') {
        const output = execSync(
          'ps aux | grep -i chromium | grep -v grep || true',
          { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }
        ).toString().trim();

        if (output) {
          chromiumProcesses = output.split('\n').filter(Boolean);
        }
      } else if (platform === 'win32') {
        const output = execSync(
          'tasklist /FI "IMAGENAME eq chrome.exe" /FO CSV /NH',
          { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }
        ).toString().trim();
        if (output) {
          chromiumProcesses = output.split('\n').filter(Boolean);
        }
      }

      // 计算不在池管理下的 Chromium 进程
      const poolPids = new Set();
      for (const inst of this.instances) {
        if (inst.browser && inst.browser.process) {
          try {
            const pid = inst.browser.process().pid;
            if (pid) poolPids.add(pid);
          } catch {}
        }
      }

      // 如果 Chromium 进程过多且不在池管理下，杀之
      const unknownCount = chromiumProcesses.length - poolPids.size;
      if (unknownCount > 3) {
        console.warn(
          `[BrowserPool] 发现 ${unknownCount} 个潜在僵尸 Chromium 进程，尝试清理...`
        );

        // 只在极端情况下才全局清理（超过 10 个未知进程）
        if (unknownCount > 10) {
          if (platform === 'darwin' || platform === 'linux') {
            execSync('pkill -f "chromium" --signal TERM 2>/dev/null || true', {
              timeout: 3000,
            });
          }
          console.log('[BrowserPool] 已执行僵尸进程清理');
        }
      }
    } catch (err) {
      // 巡检失败不应影响主流程
      console.warn(`[BrowserPool] 僵尸巡检异常: ${err.message}`);
    }
  }
}

// ─── 单例导出 ───────────────────────────────────────
const pool = new BrowserPool();
export default pool;
export { BrowserPool };