/**
 * 主服务入口 — Express + Socket.io
 *
 * REST API：
 *   POST   /api/download          → 创建下载任务（状态：created）
 *   GET    /api/tasks              → 列出所有任务（按创建时间倒序）
 *   GET    /api/task/:id           → 查询单个任务
 *   POST   /api/task/:id/retry     → 手动续跑（仅 failed 状态）
 *   POST   /api/tasks/retry-batch  → 批量续跑
 *   DELETE /api/task/:id           → 删除单个任务
 *   POST   /api/tasks/delete-batch → 批量删除任务
 *
 * WebSocket 实时推送：
 *   subscribe/unsubscribe → task-status（单任务状态）
 *   task-list-update      → 列表变更通知
 */

import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import taskManager, { TaskStatus } from './task-manager.js';
import { captureM3u8 } from './m3u8-interceptor.js';
import { startDownload, cancelDownload } from './downloader.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3456;

const app = express();
app.use(cors());
app.use(express.json());

// ─── 静态文件服务 ──────────────────────────────────
app.use(express.static(path.join(__dirname, '../public')));
app.use('/downloads', express.static(path.join(__dirname, '../downloads')));

const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

// ─── WebSocket 连接 ─────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[WS] client connected: ${socket.id}`);

  socket.on('subscribe', (taskId) => {
    socket.join(`task:${taskId}`);
    const task = taskManager.get(taskId);
    if (task) socket.emit('task-status', task);
  });

  socket.on('unsubscribe', (taskId) => {
    socket.leave(`task:${taskId}`);
  });

  socket.on('disconnect', () => {
    console.log(`[WS] client disconnected: ${socket.id}`);
  });
});

// ─── taskManager 事件 → WebSocket 广播 ────────────
taskManager.on('task-updated', (task) => {
  io.to(`task:${task.id}`).emit('task-status', task);
  io.emit('task-list-update', taskManager.listAll());
});

taskManager.on('task-created', (task) => {
  io.emit('task-list-update', taskManager.listAll());
});

taskManager.on('task-retry', (task) => {
  io.emit('task-list-update', taskManager.listAll());
});

taskManager.on('task-completed', (task) => {
  io.emit('task-list-update', taskManager.listAll());
});

taskManager.on('task-failed', (task) => {
  io.emit('task-list-update', taskManager.listAll());
});

taskManager.on('task-removed', (taskId) => {
  io.emit('task-list-update', taskManager.listAll());
});

// 重试就绪事件 → 自动执行
taskManager.on('task-retry-ready', (taskId) => {
  processTask(taskId).catch((err) => {
    console.error(`[Retry ${taskId}] 执行异常:`, err.message);
  });
});

// ─── REST API ───────────────────────────────────────

/**
 * POST /api/download
 * Body: { url: string }
 * 创建下载任务，状态为 created，异步开始执行
 */
app.post('/api/download', async (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: '缺少 url 参数' });
  }

  const taskId = taskManager.create(url);
  // 异步启动任务
  processTask(taskId).catch((err) => {
    console.error(`[Task ${taskId}] 执行异常:`, err.message);
  });

  res.json({ taskId, status: TaskStatus.CREATED });
});

/**
 * GET /api/tasks — 列出所有任务（按创建时间倒序）
 */
app.get('/api/tasks', (_req, res) => {
  res.json(taskManager.listAll());
});

/**
 * GET /api/task/:id — 查询单个任务
 */
app.get('/api/task/:id', (req, res) => {
  const task = taskManager.get(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  res.json(task);
});

/**
 * DELETE /api/task/:id — 删除任务（彻底移除记录）
 */
app.delete('/api/task/:id', (req, res) => {
  const task = taskManager.get(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });

  // 如果正在运行，先杀掉进程
  cancelDownload(req.params.id);

  const ok = taskManager.remove(req.params.id);
  if (!ok) return res.status(500).json({ error: '删除失败' });

  res.json({ ok: true });
});

/**
 * POST /api/task/:id/retry — 手动续跑单个失败任务
 * 仅对状态为 failed 的任务生效
 */
app.post('/api/task/:id/retry', async (req, res) => {
  const task = taskManager.get(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (task.status !== TaskStatus.FAILED) {
    return res.status(400).json({ error: '仅失败状态的任务可以续跑' });
  }

  const ok = taskManager.retry(req.params.id);
  if (!ok) return res.status(500).json({ error: '续跑失败' });

  // 异步重新执行
  processTask(req.params.id).catch((err) => {
    console.error(`[Retry ${req.params.id}] 执行异常:`, err.message);
  });

  res.json({ ok: true, taskId: req.params.id, status: TaskStatus.CREATED });
});

/**
 * POST /api/tasks/retry-batch — 批量续跑失败任务
 * Body: { taskIds: string[] }
 */
app.post('/api/tasks/retry-batch', async (req, res) => {
  const { taskIds } = req.body;
  if (!Array.isArray(taskIds) || taskIds.length === 0) {
    return res.status(400).json({ error: '缺少 taskIds 参数或为空' });
  }

  const result = taskManager.retryBatch(taskIds);

  // 异步执行所有续跑成功的任务
  for (const id of taskIds) {
    const task = taskManager.get(id);
    if (task && task.status === TaskStatus.CREATED) {
      processTask(id).catch((err) => {
        console.error(`[BatchRetry ${id}] 执行异常:`, err.message);
      });
    }
  }

  res.json({ ok: true, ...result });
});

/**
 * POST /api/tasks/delete-batch — 批量删除任务
 * Body: { taskIds: string[] }
 */
app.post('/api/tasks/delete-batch', (req, res) => {
  const { taskIds } = req.body;
  if (!Array.isArray(taskIds) || taskIds.length === 0) {
    return res.status(400).json({ error: '缺少 taskIds 参数或为空' });
  }

  // 先杀掉所有正在运行的任务进程
  for (const id of taskIds) {
    cancelDownload(id);
  }

  const result = taskManager.removeBatch(taskIds);
  res.json({ ok: true, ...result });
});

// ─── 核心流程：拦截 m3u8 → 下载 ────────────────────

/**
 * 完整任务处理流水线
 * 1. 标记为 running
 * 2. 拦截 m3u8
 * 3. 下载视频
 * 4. 完成 / 失败（失败时 taskManager.markFailed 自动处理重试）
 * 5. 无论成功失败，尝试出队下一个任务
 */
async function processTask(taskId) {
  const task = taskManager.get(taskId);
  if (!task) return;

  try {
    // ── 标记为运行中 ────────────────────────────
    taskManager.markRunning(taskId);

    // ── 回合 1: 拦截 m3u8 ──────────────────────
    taskManager.update(taskId, {
      phase: 'preparing',
      message: '正在拦截 m3u8 地址...',
    });

    const captureResult = await captureM3u8(task.url, {
      onProgress: ({ stage, message }) => {
        const stageMap = { launching: 10, navigating: 40, waiting: 70, captured: 100 };
        taskManager.update(taskId, {
          progress: stageMap[stage] || 20,
          message,
          phase: 'preparing',
        });
      },
    });

    if (!captureResult || !captureResult.m3u8Url) {
      throw new Error('未能拦截到 m3u8 地址，可能页面无视频或需要额外触发');
    }

    taskManager.update(taskId, {
      m3u8Url: captureResult.m3u8Url,
      message: `捕获到: ${captureResult.m3u8Url.slice(0, 80)}...`,
      progress: 100,
      phase: 'preparing_done',
    });

    // ── 回合 2: 下载 ───────────────────────────
    taskManager.update(taskId, {
      message: '开始下载...',
      progress: 0,
      phase: 'downloading',
    });

    const outputFile = await startDownload(
      captureResult.m3u8Url,
      captureResult.headers || {},
      taskId,
      ({ percent, speed, message }) => {
        taskManager.update(taskId, { progress: percent, speed, message, phase: 'downloading' });
      }
    );

    taskManager.markCompleted(taskId, outputFile);
  } catch (err) {
    // markFailed 内部自动处理重试逻辑（指数退避）
    const autoRetried = taskManager.markFailed(taskId, err.message);
    if (autoRetried) {
      console.log(`[Task ${taskId}] 已自动加入重试队列`);
    } else {
      console.error(`[Task ${taskId}] 执行失败（已耗尽重试次数）:`, err.message);
    }
  } finally {
    // 任务结束后，尝试启动下一个任务
    tryDequeueNext();
  }
}

/**
 * 从队列中取出下一个待执行任务并启动
 */
function tryDequeueNext() {
  const next = taskManager.dequeue();
  if (next) {
    console.log(`[Queue] 启动下一个任务: ${next.id}`);
    processTask(next.id).catch((err) => {
      console.error(`[Task ${next.id}] 执行异常:`, err.message);
    });
  }
}

// ─── 启动 ───────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`🚀 视频下载服务已启动: http://0.0.0.0:${PORT}`);
  console.log(`📡 WebSocket: ws://0.0.0.0:${PORT}`);
  console.log(`📋 API: POST http://0.0.0.0:${PORT}/api/download`);
  console.log(`📦 持久化: data/tasks.json`);
});