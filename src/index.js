/**
 * 主服务入口 — Express + Socket.io
 * POST /api/download  → 创建下载任务
 * GET  /api/task/:id  → 查询任务状态
 * GET  /api/tasks     → 列出所有任务
 * WebSocket           → 实时进度推送
 */

import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import taskManager, { TaskStatus } from './task-manager.js';
import { captureM3u8 } from './m3u8-interceptor.js';
import { startDownload } from './downloader.js';
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

// 监听 taskManager 事件 → 广播到 WebSocket
taskManager.on('task-updated', (task) => {
  io.to(`task:${task.id}`).emit('task-status', task);
  io.emit('task-list-update', taskManager.listAll());
});

taskManager.on('task-created', (task) => {
  io.emit('task-list-update', taskManager.listAll());
});

// ─── REST API ───────────────────────────────────────

/**
 * POST /api/download
 * Body: { url: string }
 * 创建下载任务并立即开始执行
 */
app.post('/api/download', async (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: '缺少 url 参数' });
  }

  const taskId = taskManager.create(url);
  // 异步启动任务，不阻塞响应
  processTask(taskId).catch((err) => {
    console.error(`[Task ${taskId}] 执行异常:`, err.message);
  });

  res.json({ taskId, status: TaskStatus.PENDING });
});

/**
 * GET /api/task/:id — 查询单个任务状态
 */
app.get('/api/task/:id', (req, res) => {
  const task = taskManager.get(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  res.json(task);
});

/**
 * GET /api/tasks — 列出所有任务
 */
app.get('/api/tasks', (_req, res) => {
  res.json(taskManager.listAll());
});

/**
 * DELETE /api/task/:id — 取消任务
 */
app.delete('/api/task/:id', (req, res) => {
  const task = taskManager.get(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (task.status === TaskStatus.DONE) {
    return res.status(400).json({ error: '任务已完成，无法取消' });
  }
  taskManager.markFailed(req.params.id, '用户取消');
  res.json({ ok: true });
});

// ─── 核心流程：拦截 m3u8 → 下载 ────────────────────

/**
 * 完整任务处理流水线
 */
async function processTask(taskId) {
  const task = taskManager.get(taskId);
  if (!task) return;

  try {
    // Step 1: 拦截 m3u8
    taskManager.update(taskId, { status: TaskStatus.CAPTURING });
    const captureResult = await captureM3u8(task.url, {
      onProgress: ({ stage, message }) => {
        const stageMap = { launching: 5, navigating: 15, waiting: 25, captured: 30 };
        taskManager.update(taskId, {
          progress: stageMap[stage] || 20,
          message,
          status: TaskStatus.CAPTURING,
        });
      },
    });

    if (!captureResult || !captureResult.m3u8Url) {
      throw new Error('未能拦截到 m3u8 地址，可能页面无视频或需要额外触发');
    }

    taskManager.update(taskId, {
      m3u8Url: captureResult.m3u8Url,
      message: `捕获到: ${captureResult.m3u8Url.slice(0, 80)}...`,
      progress: 30,
      status: TaskStatus.DOWNLOADING,
    });

    // Step 2: 调用下载器
    const outputFile = await startDownload(
      captureResult.m3u8Url,
      captureResult.headers || {},
      taskId,
      ({ percent, speed, message }) => {
        const mapped = 30 + Math.floor(percent * 0.7);
        taskManager.update(taskId, { progress: mapped, speed, message });
      }
    );

    taskManager.markDone(taskId, outputFile);
  } catch (err) {
    taskManager.markFailed(taskId, err.message);
  }
}

// ─── 启动 ───────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`🚀 视频下载服务已启动: http://0.0.0.0:${PORT}`);
  console.log(`📡 WebSocket: ws://0.0.0.0:${PORT}`);
  console.log(`📋 API: POST http://0.0.0.0:${PORT}/api/download`);
});
