/**
 * 任务队列管理器 — 持久化存储 + 完整生命周期管理
 *
 * 任务状态流转：
 *   created → running → completed
 *                       → failed → (重试→running) / (放弃→failed)
 *
 * 持久化：data/tasks.json，每次状态变更同步写入
 * 排序：按创建时间倒序，新的总在最上面
 * 重试：默认最多 3 次，指数退避（1s → 2s → 4s）
 */

import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../data');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');

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
};

// ─── 默认配置 ───────────────────────────────────────
const DEFAULT_MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 1000; // 退避基数 1 秒

class TaskManager extends EventEmitter {
  constructor(maxConcurrent = 2) {
    super();
    this.tasks = new Map();          // taskId → task 对象
    this.queue = [];                 // 等待队列（created 状态的任务 ID）
    this.running = new Set();        // 正在执行的任务 ID 集合
    this.maxConcurrent = maxConcurrent;

    // 启动时从持久化文件恢复
    this._loadFromDisk();
  }

  // ═══════════════════════════════════════════════════
  // 核心 CRUD
  // ═══════════════════════════════════════════════════

  /**
   * 创建新任务（初始状态：created）
   * @param {string} url - 目标视频播放页 URL
   * @returns {string} taskId
   */
  create(url) {
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

  /**
   * 弹出下一个待执行任务（created 状态）
   * 受 maxConcurrent 限制
   * @returns {object|null}
   */
  dequeue() {
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
   */
  update(taskId, updates) {
    const task = this.tasks.get(taskId);
    if (!task) return;
    Object.assign(task, updates, { updatedAt: new Date().toISOString() });
    this._saveToDisk();
    this.emit('task-updated', task);
  }

  /**
   * 标记为运行中（created → running）
   */
  markRunning(taskId) {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== TaskStatus.CREATED) return;
    this.update(taskId, { status: TaskStatus.RUNNING });
  }

  /**
   * 标记为完成（running → completed）
   */
  markCompleted(taskId, outputFile) {
    const task = this.tasks.get(taskId);
    if (!task) return;
    this.update(taskId, {
      status: TaskStatus.COMPLETED,
      outputFile: outputFile || task.outputFile,
      progress: 100,
    });
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

    const newRetryCount = (task.retryCount || 0) + 1;

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
      });
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
      });
      this.running.delete(taskId);
      this.emit('task-failed', this.tasks.get(taskId));
      return false; // 彻底失败
    }
  }

  // ═══════════════════════════════════════════════════
  // 手动续跑（仅限 failed 状态）
  // ═══════════════════════════════════════════════════

  /**
   * 手动续跑单个失败任务（failed → created）
   * @param {string} taskId
   * @returns {boolean}
   */
  retry(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if (task.status !== TaskStatus.FAILED) return false;

    this.update(taskId, {
      status: TaskStatus.CREATED,
      error: null,
      progress: 0,
      speed: null,
      m3u8Url: null,
      outputFile: null,
      retryCount: 0,       // 手动续跑重置重试计数
      maxRetries: DEFAULT_MAX_RETRIES,
    });
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
   */
  _loadFromDisk() {
    try {
      if (!fs.existsSync(TASKS_FILE)) {
        console.log('[Persistence] 无持久化文件，从空状态启动');
        return;
      }
      const raw = fs.readFileSync(TASKS_FILE, 'utf-8');
      const tasksArray = JSON.parse(raw);
      if (!Array.isArray(tasksArray)) return;

      for (const task of tasksArray) {
        this.tasks.set(task.id, task);
        // 恢复队列：只有 created 状态的任务才重新入队
        // 运行中的任务在重启后重置为 created（因为进程已终止）
        if (task.status === TaskStatus.RUNNING) {
          task.status = TaskStatus.CREATED;
          task.error = '服务重启，任务已重置';
          task.progress = 0;
          task.retryCount = 0;
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
   * 将当前所有任务写入磁盘
   */
  _saveToDisk() {
    try {
      const tasksArray = [...this.tasks.values()];
      fs.writeFileSync(TASKS_FILE, JSON.stringify(tasksArray, null, 2), 'utf-8');
    } catch (err) {
      console.error('[Persistence] 写入失败:', err.message);
    }
  }
}

// 单例导出
const taskManager = new TaskManager();
export default taskManager;