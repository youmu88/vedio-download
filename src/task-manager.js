/**
 * 任务队列管理器 — 持久化存储 + 完整生命周期管理
 *
 * 任务状态流转：
 *   created → running → completed
 *                       → failed → (重试→running) / (放弃→failed)
 *                       → cancelled → (手动重试→running)
 *
 * 持久化：data/tasks.json，状态变更立即写入，进度更新防抖写入
 * 排序：按创建时间倒序，新的总在最上面
 * 重试：默认最多 3 次，指数退避（1s → 2s → 4s）；永久性错误不重试
 */

import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { isPermanentError } from './errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// ⭐ 数据目录支持环境变量覆盖：测试/隔离环境可用 VD_DATA_DIR 指向独立目录，避免污染真实数据
const DATA_DIR = process.env.VD_DATA_DIR ? path.resolve(process.env.VD_DATA_DIR) : path.resolve(__dirname, '../data');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

// 确保 data 目录存在
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ─── 任务状态枚举 ───────────────────────────────────
export const TaskStatus = {
  CREATED: 'created',       // 已创建（初始状态）
  RUNNING: 'running',       // 运行中（拦截/下载）
  COMPLETED: 'completed',   // 完成
  FAILED: 'failed',         // 失败
  CANCELLED: 'cancelled',   // 用户手动取消（可重试续跑）
};

// ─── 默认配置 ───────────────────────────────────────
const DEFAULT_MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 1000; // 退避基数 1 秒

class TaskManager extends EventEmitter {
  constructor(maxConcurrent = null) {
    super();
    this.tasks = new Map();          // taskId → task 对象
    this.queue = [];                 // 等待队列（created 状态的任务 ID）
    this.running = new Set();        // 正在执行的任务 ID 集合
    this.maxConcurrent = maxConcurrent || this._loadSettings().maxConcurrent || 3; // 默认并行下载 3
    this._saveTimer = null;          // 持久化防抖定时器

    // 启动时从持久化文件恢复
    this._loadFromDisk();
  }

  // ═══════════════════════════════════════════════════
  // 核心 CRUD
  // ═══════════════════════════════════════════════════

  /**
   * 创建新任务（初始状态：created）
   * @param {string} url - 目标视频播放页 URL
   * @param {object} [opts] - 可选配置 { cookies, injectScript, maxSpeed, proxy, engine, ... }
   * @returns {string} taskId
   */
  create(url, opts = {}) {
    const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const task = {
      id: taskId,
      url,
      status: TaskStatus.CREATED,
      m3u8Url: null,
      outputFile: null,
      progress: 0,
      speed: null,
      error: null,
      retryCount: 0,
      maxRetries: DEFAULT_MAX_RETRIES,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      // ⭐ 修复：存储 API 传入的额外配置（之前被静默丢弃）
      cookies: opts.cookies || null,
      injectScript: opts.injectScript || null,
      maxSpeed: opts.maxSpeed || 0,
      proxy: opts.proxy || null,
      engine: opts.engine || 'auto',
      format: opts.format || 'auto',
      targetBandwidth: opts.targetBandwidth || null,
      parallel: opts.parallel || false,
      parallelCount: opts.parallelCount || 4,
      preferredCodec: opts.preferredCodec || null,
      timeoutMs: opts.timeoutMs || null,        // 任务级下载超时（null=默认30分钟）
      streamHeaders: null,                       // 捕获到的防盗链请求头（用于续跑）
      outputSizeBytes: null,                     // 输出文件大小（前端展示）
      failureType: null,                         // 'permanent' | 'transient' | null
    };
    this.tasks.set(taskId, task);
    this.queue.push(taskId);
    this._saveToDisk();
    this.emit('task-created', task);
    return taskId;
  }

  /**
   * 获取单个任务
   * @param {string} taskId
   * @returns {object|null}
   */
  get(taskId) {
    return this.tasks.get(taskId) || null;
  }

  /**
   * 获取所有任务（按创建时间倒序，新的在最上面）
   * @returns {object[]}
   */
  listAll() {
    return [...this.tasks.values()].sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
    );
  }

  // ═══════════════════════════════════════════════════
  // 服务端设置（并行下载数）
  // ═══════════════════════════════════════════════════

  /**
   * 获取当前并行下载数
   */
  getMaxConcurrent() {
    return this.maxConcurrent;
  }

  /**
   * 设置并行下载数（1～10），持久化并立即生效
   * @returns {number} 生效后的值
   */
  setMaxConcurrent(n) {
    const value = Math.min(10, Math.max(1, parseInt(n, 10) || 3));
    this.maxConcurrent = value;
    this._saveSettings();
    return value;
  }

  _loadSettings() {
    try {
      if (!fs.existsSync(SETTINGS_FILE)) return {};
      const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
      const data = JSON.parse(raw);
      return data && typeof data === 'object' ? data : {};
    } catch {
      return {};
    }
  }

  _saveSettings() {
    try {
      const tmpFile = `${SETTINGS_FILE}.tmp`;
      fs.writeFileSync(tmpFile, JSON.stringify({ maxConcurrent: this.maxConcurrent }, null, 2), 'utf-8');
      fs.renameSync(tmpFile, SETTINGS_FILE);
    } catch (err) {
      console.error('[Persistence] 设置写入失败:', err.message);
    }
  }

  /**
   * 弹出下一个待执行任务（created 状态）
   * 受 maxConcurrent 限制
   * @returns {object|null}
   */
  dequeue() {
    // 每次出队前同步磁盘设置，保证并行下载数改动即使绕过 API 也即时生效
    const diskSetting = this._loadSettings().maxConcurrent;
    if (diskSetting && diskSetting !== this.maxConcurrent) {
      this.maxConcurrent = diskSetting;
    }
    if (this.running.size >= this.maxConcurrent) return null;
    while (this.queue.length > 0) {
      const taskId = this.queue.shift();
      const task = this.tasks.get(taskId);
      if (task && task.status === TaskStatus.CREATED) {
        this.running.add(taskId);
        return task;
      }
    }
    return null;
  }

  // ═══════════════════════════════════════════════════
  // 状态更新
  // ═══════════════════════════════════════════════════

  /**
   * 通用更新
   * @param {object} [opts] { immediate: boolean } 是否立即同步写盘（状态变更用）；
   *   默认防抖写盘，避免进度高频更新阻塞事件循环
   */
  update(taskId, updates, opts = {}) {
    const task = this.tasks.get(taskId);
    if (!task) return;
    Object.assign(task, updates, { updatedAt: new Date().toISOString() });
    if (opts.immediate) this._saveToDisk();
    else this._scheduleSave();
    this.emit('task-updated', task);
  }

  /**
   * 标记为运行中（created → running）
   * ⭐ 清除旧的 error 和 message，避免前端显示上一次失败的错误信息
   */
  markRunning(taskId) {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== TaskStatus.CREATED) return false;
    this.running.add(taskId);
    this.update(taskId, {
      status: TaskStatus.RUNNING,
      error: null,          // ⭐ 清除旧错误信息
      message: '任务开始执行...', // ⭐ 重置为正向消息
    }, { immediate: true });
    return true;
  }

  /**
   * 标记为完成（running → completed）
   */
  markCompleted(taskId, outputFile, extra = {}) {
    const task = this.tasks.get(taskId);
    if (!task) return;
    this.update(taskId, {
      status: TaskStatus.COMPLETED,
      outputFile: outputFile || task.outputFile,
      progress: 100,
      failureType: null,
      ...extra,
    }, { immediate: true });
    this.running.delete(taskId);
    this.emit('task-completed', this.tasks.get(taskId));
  }

  /**
   * 标记为失败（running → failed）
   * 如果 retryCount < maxRetries，自动触发重试
   * @returns {boolean} true=已自动重试, false=彻底失败
   */
  markFailed(taskId, error) {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    // 用户已取消的任务：不再自动重试、不覆盖取消状态
    if (task.status === TaskStatus.CANCELLED) return false;

    const newRetryCount = (task.retryCount || 0) + 1;
    const failureType = isPermanentError(error) ? 'permanent' : 'transient';

    // 永久性错误（403/404/非法URL/磁盘不足等）：直接判死，不消耗重试
    if (failureType === 'permanent') {
      this.update(taskId, {
        status: TaskStatus.FAILED,
        error,
        failureType,
        retryCount: newRetryCount,
      }, { immediate: true });
      this.running.delete(taskId);
      this.emit('task-failed', this.tasks.get(taskId));
      return false;
    }

    if (newRetryCount < task.maxRetries) {
      // ── 自动重试（指数退避）──────────────────
      const delay = BACKOFF_BASE_MS * Math.pow(2, newRetryCount - 1);
      this.update(taskId, {
        status: TaskStatus.CREATED,
        error: `[第${newRetryCount}次重试] ${error}`,
        retryCount: newRetryCount,
        progress: 0,
        speed: null,
        m3u8Url: null,
        outputFile: null,
        failureType,
      }, { immediate: true });
      this.running.delete(taskId);
      // 重新入队
      this.queue.push(taskId);

      console.log(
        `[Retry] 任务 ${taskId} 第 ${newRetryCount}/${task.maxRetries} 次重试，` +
        `退避 ${delay}ms`
      );

      this.emit('task-retry', this.tasks.get(taskId));

      // 延迟后触发重试执行（指数退避）
      setTimeout(() => {
        this.emit('task-retry-ready', taskId);
      }, delay);

      return true; // 已自动重试
    } else {
      // ── 彻底失败 ─────────────────────────────
      this.update(taskId, {
        status: TaskStatus.FAILED,
        error: error,
        retryCount: newRetryCount,
        failureType,
      }, { immediate: true });
      this.running.delete(taskId);
      this.emit('task-failed', this.tasks.get(taskId));
      return false; // 彻底失败
    }
  }

  /**
   * 标记为取消（running/created → cancelled）
   * 不删除任务、保留分片缓存，允许手动重试续跑
   * @returns {boolean}
   */
  markCancelled(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if (![TaskStatus.CREATED, TaskStatus.RUNNING].includes(task.status)) return false;

    this.running.delete(taskId);
    this.queue = this.queue.filter(id => id !== taskId);
    this.update(taskId, {
      status: TaskStatus.CANCELLED,
      message: '任务已取消，可重试续跑',
      error: null,
      failureType: null,
    }, { immediate: true });
    this.emit('task-cancelled', this.tasks.get(taskId));
    return true;
  }

  // ═══════════════════════════════════════════════════
  // 手动续跑（failed / cancelled 状态）
  // ═══════════════════════════════════════════════════

  /**
   * 手动续跑单个失败/取消任务（failed|cancelled → created）
   * @param {string} taskId
   * @returns {boolean}
   */
  retry(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if (![TaskStatus.FAILED, TaskStatus.CANCELLED].includes(task.status)) return false;

    this.update(taskId, {
      status: TaskStatus.CREATED,
      error: null,
      progress: 0,
      speed: null,
      retryCount: 0,       // 手动续跑重置重试计数
      maxRetries: DEFAULT_MAX_RETRIES,
      failureType: null,
      message: '已重新加入队列',
    }, { immediate: true });
    this.queue.push(taskId);
    this.emit('task-retry', this.tasks.get(taskId));
    return true;
  }

  /**
   * 批量重试失败任务
   * @param {string[]} taskIds
   * @returns {{ success: number, failed: number }}
   */
  retryBatch(taskIds) {
    let success = 0;
    let failed = 0;
    for (const id of taskIds) {
      if (this.retry(id)) success++;
      else failed++;
    }
    return { success, failed };
  }

  // ═══════════════════════════════════════════════════
  // 删除
  // ═══════════════════════════════════════════════════

  /**
   * 删除单个任务（从内存和磁盘中彻底移除）
   * @param {string} taskId
   * @returns {boolean}
   */
  remove(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return false;

    this.running.delete(taskId);
    this.queue = this.queue.filter(id => id !== taskId);
    this.tasks.delete(taskId);

    this._saveToDisk();
    this.emit('task-removed', taskId);
    return true;
  }

  /**
   * 批量删除任务
   * @param {string[]} taskIds
   * @returns {{ success: number, failed: number }}
   */
  removeBatch(taskIds) {
    let success = 0;
    let failed = 0;
    for (const id of taskIds) {
      if (this.remove(id)) success++;
      else failed++;
    }
    return { success, failed };
  }

  // ═══════════════════════════════════════════════════
  // 检查
  // ═══════════════════════════════════════════════════

  /**
   * 任务是否已被取消/删除
   */
  isCancelled(taskId) {
    const task = this.tasks.get(taskId);
    return !task || task.status === TaskStatus.FAILED;
  }

  // ═══════════════════════════════════════════════════
  // 持久化
  // ═══════════════════════════════════════════════════

  /**
   * 从磁盘加载任务数据
   * ⭐ P1-5 增强：损坏自动从 .bak 恢复
   */
  _loadFromDisk() {
    try {
      if (!fs.existsSync(TASKS_FILE)) {
        // 尝试从备份恢复
        if (fs.existsSync(`${TASKS_FILE}.bak`)) {
          console.log('[Persistence] 主文件不存在，从 .bak 恢复');
          fs.copyFileSync(`${TASKS_FILE}.bak`, TASKS_FILE);
        } else {
          console.log('[Persistence] 无持久化文件，从空状态启动');
          return;
        }
      }
      let raw = fs.readFileSync(TASKS_FILE, 'utf-8');
      // ⭐ 空文件保护：防止 JSON.parse('') 报错
      if (!raw || raw.trim().length === 0) {
        console.warn('[Persistence] 主文件为空，尝试从 .bak 恢复');
        if (fs.existsSync(`${TASKS_FILE}.bak`)) {
          fs.copyFileSync(`${TASKS_FILE}.bak`, TASKS_FILE);
          raw = fs.readFileSync(TASKS_FILE, 'utf-8');
        } else {
          console.log('[Persistence] 无备份可恢复，从空状态启动');
          return;
        }
      }
      let tasksArray;
      try {
        tasksArray = JSON.parse(raw);
      } catch (parseErr) {
        // JSON 损坏，尝试从 .bak 恢复
        console.error(`[Persistence] JSON 损坏: ${parseErr.message}`);
        if (fs.existsSync(`${TASKS_FILE}.bak`)) {
          console.log('[Persistence] 从 .bak 恢复');
          fs.copyFileSync(`${TASKS_FILE}.bak`, TASKS_FILE);
          raw = fs.readFileSync(TASKS_FILE, 'utf-8');
          tasksArray = JSON.parse(raw);
        } else {
          throw parseErr;
        }
      }
      if (!Array.isArray(tasksArray)) return;

      for (const task of tasksArray) {
        if (!task || !task.id) continue;
        this.tasks.set(task.id, task);
        // 恢复队列：只有 created 状态的任务才重新入队
        // 运行中的任务在重启后重置为 created（因为进程已终止）
        if (task.status === TaskStatus.RUNNING) {
          task.status = TaskStatus.CREATED;
          task.error = '服务重启，任务已重置';
          task.progress = 0;
          task.retryCount = 0;
          task.failureType = null;
        }
        if (task.status === TaskStatus.CREATED) {
          this.queue.push(task.id);
        }
      }

      console.log(
        `[Persistence] 已恢复 ${tasksArray.length} 个任务 ` +
        `（${this.queue.length} 个待执行）`
      );
    } catch (err) {
      console.error('[Persistence] 加载失败:', err.message);
    }
  }

  /**
   * 将当前所有任务写入磁盘（原子写入：先写临时文件 → rename）
   * ⭐ P1-5 增强：原子写入 + 自动备份
   */
  _saveToDisk() {
    try {
      const tasksArray = [...this.tasks.values()];
      const tmpFile = `${TASKS_FILE}.tmp`;
      fs.writeFileSync(tmpFile, JSON.stringify(tasksArray, null, 2), 'utf-8');
      fs.renameSync(tmpFile, TASKS_FILE);
      this._writeCounter = (this._writeCounter || 0) + 1;
      // 每 50 次操作自动备份
      if (this._writeCounter % 50 === 0) {
        const bakFile = `${TASKS_FILE}.bak`;
        fs.copyFileSync(TASKS_FILE, bakFile);
        console.log(`[Persistence] 自动备份: ${bakFile}`);
      }
    } catch (err) {
      console.error('[Persistence] 写入失败:', err.message);
    }
  }

  /**
   * 防抖写盘：进度类高频更新合并为低频写入（状态变更走 immediate 同步写）
   */
  _scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._saveToDisk();
    }, 500);
    if (this._saveTimer.unref) this._saveTimer.unref();
  }

  /**
   * 立即刷新持久化（优雅关闭前调用）
   */
  flush() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    this._saveToDisk();
  }
}

// 单例导出
const taskManager = new TaskManager();
export default taskManager;
