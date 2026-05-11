/**
 * 任务队列管理器 — 轻量内存队列，管理下载任务生命周期
 */

import { EventEmitter } from 'events';

// 任务状态枚举
export const TaskStatus = {
  PENDING: 'pending',         // 排队中
  CAPTURING: 'capturing',     // 正在拦截 m3u8
  DOWNLOADING: 'downloading', // N_m3u8DL-RE 下载中
  DONE: 'done',               // 完成
  FAILED: 'failed',           // 失败
};

class TaskManager extends EventEmitter {
  constructor(maxConcurrent = 2) {
    super();
    this.tasks = new Map();          // taskId → task 对象
    this.queue = [];                 // 等待队列
    this.running = new Set();       // 正在执行的任务 ID 集合
    this.maxConcurrent = maxConcurrent;
  }

  /**
   * 创建新任务
   * @param {string} url - 目标视频播放页 URL
   * @returns {string} taskId
   */
  create(url) {
    const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const task = {
      id: taskId,
      url,
      status: TaskStatus.PENDING,
      m3u8Url: null,
      outputFile: null,
      progress: 0,
      speed: null,
      error: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.tasks.set(taskId, task);
    this.queue.push(taskId);
    this.emit('task-created', task);
    return taskId;
  }

  /**
   * 获取任务信息
   */
  get(taskId) {
    return this.tasks.get(taskId) || null;
  }

  /**
   * 获取所有任务（按创建时间倒序）
   */
  listAll() {
    return [...this.tasks.values()].sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
    );
  }

  /**
   * 弹出下一个待执行任务
   */
  dequeue() {
    if (this.running.size >= this.maxConcurrent) return null;
    while (this.queue.length > 0) {
      const taskId = this.queue.shift();
      const task = this.tasks.get(taskId);
      if (task && task.status === TaskStatus.PENDING) {
        this.running.add(taskId);
        return task;
      }
    }
    return null;
  }

  /**
   * 更新任务状态
   */
  update(taskId, updates) {
    const task = this.tasks.get(taskId);
    if (!task) return;
    Object.assign(task, updates, { updatedAt: new Date().toISOString() });
    this.emit('task-updated', task);
  }

  /**
   * 标记任务完成
   */
  markDone(taskId, outputFile) {
    this.update(taskId, { status: TaskStatus.DONE, outputFile, progress: 100 });
    this.running.delete(taskId);
    this.emit('task-done', this.tasks.get(taskId));
  }

  /**
   * 标记任务失败
   */
  markFailed(taskId, error) {
    this.update(taskId, { status: TaskStatus.FAILED, error });
    this.running.delete(taskId);
    this.emit('task-failed', this.tasks.get(taskId));
  }

  /**
   * 任务是否已取消
   */
  isCancelled(taskId) {
    const task = this.tasks.get(taskId);
    return !task || task.status === TaskStatus.FAILED;
  }
}

// 单例导出
const taskManager = new TaskManager();
export default taskManager;
