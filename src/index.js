/**
 * 主服务入口（增强版） — Express + Socket.io + 所有增强功能
 *
 * ⭐ 新增功能：
 *   - BrowserPool 浏览器实例复用
 *   - Stealth 反检测
 *   - Token 时效性处理
 *   - 多引擎降级下载
 *   - 断点续传
 *   - 代理轮换
 *   - 格式扩展（DASH/MPD/直链）
 *   - 并行分片加速
 *   - 智能码率选择
 *   - 限速与资源管控
 *   - 结构化日志
 *   - API 速率限制（P2-11 安全加固）
 *   - SSRF 防护（P2-11）
 *   - CORS 收紧（P2-11）
 *   - 路径注入防护（P2-11）
 *
 * REST API：
 *   POST   /api/download              → 创建下载任务
 *   GET    /api/tasks                  → 列出所有任务
 *   GET    /api/task/:id               → 查询单个任务
 *   POST   /api/task/:id/retry         → 手动续跑（仅 failed）
 *   POST   /api/tasks/retry-batch      → 批量续跑
 *   DELETE /api/task/:id               → 删除单个任务
 *   POST   /api/tasks/delete-batch     → 批量删除
 *   POST   /api/download/advanced      → 高级下载（含自定义选项）
 *   POST   /api/proxy/add              → 添加代理
 *   GET    /api/stats                  → 系统统计（P2-9）
 */

import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import taskManager, { TaskStatus } from './task-manager.js';
import { captureM3u8, captureMpd, captureDirectUrl, isM3u8Url, isMpdUrl, parseTokenExpiry } from './m3u8-interceptor.js';
import { startDownload, cancelDownload, validateDiskSpace, getBandwidthUsage, setBandwidthLimit, addProxy, getEngineAvailability } from './downloader.js';
import { createLogger, taskLogger } from './logger.js';
import { assertPublicUrl } from './security.js';
import browserPool from './browser-pool.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3456;
const MAX_GLOBAL_BANDWIDTH = process.env.MAX_BANDWIDTH ? parseInt(process.env.MAX_BANDWIDTH, 10) : 0; // 0 = 无限制

// ─── 结构化日志 ────────────────────────────────────
const log = createLogger({ module: 'index' });

// ─── Express 配置 ──────────────────────────────────
const app = express();

// ⭐ CORS 收紧：默认仅允许本机同源，可通过 ALLOWED_ORIGINS=* 显式放开
const defaultOrigins = [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`];
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
  : defaultOrigins;

// ⭐ 可选 API Token：设置 API_TOKEN 后，除 /api/health 外所有 API 均需携带
const API_TOKEN = process.env.API_TOKEN || '';
const requireAuth = (req, res, next) => {
  if (!API_TOKEN) return next();
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '') || req.headers['x-api-token'];
  if (token !== API_TOKEN) {
    return res.status(401).json({ error: '未授权：缺少或错误的 API Token' });
  }
  next();
};

app.use(cors({
  origin: allowedOrigins.includes('*') ? '*' : allowedOrigins,
  methods: ['GET', 'POST', 'DELETE'],
}));
app.use(express.json({ limit: '1mb' }));

// ⭐ P2-11: 全局 API 速率限制
const globalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 分钟
  max: 100,
  message: { error: '请求过于频繁，请稍后再试' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(globalLimiter);

// ⭐ P2-11: 下载 API 速率限制（更严格）
const downloadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: '下载请求过于频繁，每分钟最多 10 次' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ─── 静态文件服务 ──────────────────────────────────
// 前端资源本地化（socket.io client 从 node_modules 提供，避免 CDN 依赖）
app.use('/vendor/socket.io', express.static(path.join(__dirname, '../node_modules/socket.io/client-dist')));
app.use(express.static(path.join(__dirname, '../public')));

// 下载文件保护：DOWNLOADS_AUTH=1 + API_TOKEN 时需鉴权
if (process.env.DOWNLOADS_AUTH === '1' && API_TOKEN) {
  app.use('/downloads', requireAuth);
}
app.use('/downloads', express.static(path.join(__dirname, '../downloads')));

// ─── HTTP Server & Socket.IO ────────────────────────
const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: { origin: allowedOrigins.includes('*') ? '*' : allowedOrigins, methods: ['GET', 'POST'] },
});

// WebSocket 连接
io.on('connection', (socket) => {
  log.info({ socketId: socket.id }, 'WS 客户端连接');

  socket.on('subscribe', (taskId) => {
    socket.join(`task:${taskId}`);
    const task = taskManager.get(taskId);
    if (task) socket.emit('task-status', task);
  });

  socket.on('unsubscribe', (taskId) => {
    socket.leave(`task:${taskId}`);
  });

  socket.on('disconnect', () => {
    log.info({ socketId: socket.id }, 'WS 客户端断开');
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
  // ⭐ Socket.IO 房间清理：通知客户端退订已完成任务
  io.to(`task:${task.id}`).emit('task-finalized', { taskId: task.id });
});

taskManager.on('task-failed', (task) => {
  io.emit('task-list-update', taskManager.listAll());
  // ⭐ Socket.IO 房间清理：通知客户端退订失败任务
  io.to(`task:${task.id}`).emit('task-finalized', { taskId: task.id });
});

taskManager.on('task-cancelled', (task) => {
  io.emit('task-list-update', taskManager.listAll());
  io.to(`task:${task.id}`).emit('task-finalized', { taskId: task.id });
});

taskManager.on('task-removed', (taskId) => {
  io.emit('task-list-update', taskManager.listAll());
});

// 重试就绪事件 → 交给统一调度器（受 maxConcurrent 限制）
taskManager.on('task-retry-ready', () => {
  scheduleNext();
});

// ═══════════════════════════════════════════════════════
// REST API
// ═══════════════════════════════════════════════════════

/**
 * GET /api/health — 健康检查（供负载均衡/监控使用）
 */
app.get('/api/health', (_req, res) => {
  const tasks = taskManager.listAll();
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    version: '2.0.0',
    tasks: {
      total: tasks.length,
      queued: taskManager.queue.length,
      running: tasks.filter(t => t.status === TaskStatus.RUNNING).length,
      completed: tasks.filter(t => t.status === TaskStatus.COMPLETED).length,
      failed: tasks.filter(t => t.status === TaskStatus.FAILED).length,
      cancelled: tasks.filter(t => t.status === TaskStatus.CANCELLED).length,
    },
    browserPool: browserPool.stats(),
    engines: getEngineAvailability(),
    disk: validateDiskSpace(1024 * 1024 * 1024).message,
  });
});

// ⭐ API 鉴权（/api/health 已在上方注册，天然免鉴权）
app.use('/api', requireAuth);

/**
 * POST /api/download — 创建下载任务
 * Body: { url: string, cookies?: object[], injectScript?: string, maxSpeed?: number, proxy?: string }
 */
app.post('/api/download', downloadLimiter, async (req, res) => {
  const { url, cookies, injectScript, maxSpeed, proxy } = req.body;
  if (!url) {
    return res.status(400).json({ error: '缺少 url 参数' });
  }

  // ⭐ SSRF 防护：字面量 + DNS 解析 + 重定向链
  try {
    await assertPublicUrl(url);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const taskId = taskManager.create(url, { cookies, injectScript, maxSpeed, proxy });
  log.info({ taskId, url: url.slice(0, 100) }, '创建下载任务');

  scheduleNext();

  res.json({ taskId, status: TaskStatus.CREATED });
});

/**
 * POST /api/download/advanced — 高级下载
 * Body: { url, engine?: 'auto'|'n_m3u8dl_re'|'ffmpeg'|'js', ... }
 */
app.post('/api/download/advanced', downloadLimiter, async (req, res) => {
  const { url, engine, cookies, injectScript, maxSpeed, proxy, format, bandwidth, parallel, parallelCount, timeoutMs } = req.body;
  if (!url) {
    return res.status(400).json({ error: '缺少 url 参数' });
  }

  try {
    await assertPublicUrl(url);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  // 参数白名单校验
  const ENGINES = ['auto', 'n_m3u8dl_re', 'ffmpeg', 'js'];
  const FORMATS = ['auto', 'mp4', 'ts', 'mkv'];
  const cleanEngine = ENGINES.includes(engine) ? engine : 'auto';
  const cleanFormat = FORMATS.includes(format) ? format : 'auto';
  const cleanParallelCount = Math.min(Math.max(parseInt(parallelCount, 10) || 4, 1), 16);
  const cleanTimeout = Math.min(Math.max(parseInt(timeoutMs, 10) || 0, 0), 10 * 60 * 60 * 1000);

  const taskId = taskManager.create(url, {
    cookies, injectScript, maxSpeed, proxy,
    engine: cleanEngine,
    format: cleanFormat,
    targetBandwidth: bandwidth || null,
    parallel: !!parallel,
    parallelCount: cleanParallelCount,
    timeoutMs: cleanTimeout || null,
  });

  log.info({ taskId, url: url.slice(0, 100), engine: cleanEngine, format: cleanFormat }, '创建高级下载任务');
  scheduleNext();

  res.json({ taskId, status: TaskStatus.CREATED });
});

/**
 * GET /api/tasks — 列出所有任务
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
 * DELETE /api/task/:id — 删除任务
 */
app.delete('/api/task/:id', (req, res) => {
  const task = taskManager.get(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  cancelDownload(req.params.id);
  const ok = taskManager.remove(req.params.id);
  if (!ok) return res.status(500).json({ error: '删除失败' });
  res.json({ ok: true });
});

/**
 * POST /api/task/:id/cancel — 停止任务（不删除，保留分片缓存，可重试续跑）
 */
app.post('/api/task/:id/cancel', (req, res) => {
  const task = taskManager.get(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (![TaskStatus.CREATED, TaskStatus.RUNNING].includes(task.status)) {
    return res.status(400).json({ error: '仅运行中/等待中的任务可停止' });
  }
  cancelDownload(req.params.id);
  const ok = taskManager.markCancelled(req.params.id);
  if (!ok) return res.status(500).json({ error: '停止失败' });
  res.json({ ok: true, taskId: req.params.id, status: TaskStatus.CANCELLED });
});

/**
 * POST /api/task/:id/retry — 手动续跑
 */
app.post('/api/task/:id/retry', async (req, res) => {
  const task = taskManager.get(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (![TaskStatus.FAILED, TaskStatus.CANCELLED].includes(task.status)) {
    return res.status(400).json({ error: '仅失败/已停止状态的任务可以续跑' });
  }
  const ok = taskManager.retry(req.params.id);
  if (!ok) return res.status(500).json({ error: '续跑失败' });
  scheduleNext();
  res.json({ ok: true, taskId: req.params.id, status: TaskStatus.CREATED });
});

/**
 * POST /api/tasks/retry-batch — 批量续跑
 */
app.post('/api/tasks/retry-batch', async (req, res) => {
  const { taskIds } = req.body;
  if (!Array.isArray(taskIds) || taskIds.length === 0) {
    return res.status(400).json({ error: '缺少 taskIds 参数或为空' });
  }
  const result = taskManager.retryBatch(taskIds);
  scheduleNext();
  res.json({ ok: true, ...result });
});

/**
 * POST /api/tasks/delete-batch — 批量删除
 */
app.post('/api/tasks/delete-batch', (req, res) => {
  const { taskIds } = req.body;
  if (!Array.isArray(taskIds) || taskIds.length === 0) {
    return res.status(400).json({ error: '缺少 taskIds 参数或为空' });
  }
  for (const id of taskIds) cancelDownload(id);
  const result = taskManager.removeBatch(taskIds);
  res.json({ ok: true, ...result });
});

/**
 * POST /api/proxy/add — 添加代理
 */
app.post('/api/proxy/add', (req, res) => {
  const { proxy } = req.body;
  if (!proxy) return res.status(400).json({ error: '缺少 proxy 参数' });
  addProxy(proxy);
  log.info({ proxy }, '添加新代理');
  res.json({ ok: true, message: `代理已添加: ${proxy}` });
});

/**
 * GET /api/stats — 系统统计信息（P2-9 监控增强）
 */
app.get('/api/stats', (_req, res) => {
  const tasks = taskManager.listAll();
  const total = tasks.length;
  const completed = tasks.filter(t => t.status === 'completed').length;
  const failed = tasks.filter(t => t.status === 'failed').length;
  const running = tasks.filter(t => t.status === 'running').length;
  const pending = tasks.filter(t => t.status === 'created').length;

  // 下载速率统计
  const bwUsage = getBandwidthUsage();

  res.json({
    total,
    completed,
    failed,
    running,
    pending,
    successRate: total > 0 ? `${((completed / total) * 100).toFixed(1)}%` : '0%',
    bandwidth: bwUsage,
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage(),
  });
});

// ═══════════════════════════════════════════════════════
// 核心流程：拦截 → 下载（增强版）
// ═══════════════════════════════════════════════════════

/**
 * 完整任务处理流水线（增强版）
 *
 * 增强点：
 *   - 使用 BrowserPool 复用浏览器（P0-1）
 *   - Stealth 反检测（P0-2）
 *   - Token 时效性检测（P0-3）
 *   - 多格式支持（DASH/直链）（P1-6）
 *   - 智能码率选择（P2-8）
 *   - 磁盘空间预检（P2-9）
 */
async function processTask(taskId) {
  const task = taskManager.get(taskId);
  if (!task) return;

  const tLog = taskLogger(taskId, 'processTask');

  try {
    // ── 磁盘空间预检 ────────────────────────────
    const diskOk = validateDiskSpace();
    if (!diskOk) {
      throw new Error('磁盘空间不足（< 500MB），拒绝下载');
    }

    // ── 标记为运行中 ────────────────────────────
    if (!taskManager.markRunning(taskId)) {
      // 任务已被删除/取消/重复调度，直接结束
      return;
    }

    // ── 回合 1: 拦截流媒体 URL ──────────────────
    taskManager.update(taskId, {
      phase: 'preparing',
      message: '正在解析页面，获取视频流地址...',
    });

    const url = task.url;
    let captureResult = null;

    // 根据 URL 类型选择拦截策略
    if (isM3u8Url(url)) {
      // 如果本身就是 m3u8 URL，直接捕获
      captureResult = { m3u8Url: url, headers: {}, pageTitle: '' };
      tLog.info('直接 m3u8 URL，跳过浏览器拦截');
    } else if (isMpdUrl(url)) {
      // DASH MPD URL
      captureResult = await captureMpd(url, {
        onProgress: (p) => {
          taskManager.update(taskId, { progress: p.progress || 20, message: p.message, phase: 'preparing' });
        },
      });
      if (captureResult) {
        captureResult.format = 'mpd';
      }
    } else {
      // 普通播放页 URL → 浏览器拦截
      const extraOpts = {};
      if (task.cookies) extraOpts.cookies = task.cookies;
      if (task.injectScript) extraOpts.injectScript = task.injectScript;
      if (task.proxy) extraOpts.proxy = task.proxy;

      captureResult = await captureM3u8(url, {
        onProgress: ({ stage, message }) => {
          const stageMap = { launching: 10, navigating: 40, waiting: 70, captured: 100 };
          taskManager.update(taskId, {
            progress: stageMap[stage] || 20,
            message,
            phase: 'preparing',
          });
        },
        ...extraOpts,
      });

      // 如果没抓到 m3u8，尝试 MPD
      if (!captureResult || !captureResult.m3u8Url) {
        tLog.info('未捕获到 m3u8，尝试 DASH/MPD...');
        captureResult = await captureMpd(url, {
          onProgress: (p) => {
            taskManager.update(taskId, { progress: p.progress || 50, message: p.message, phase: 'preparing' });
          },
        });
        if (captureResult) captureResult.format = 'mpd';
      }

      // 如果还没抓到，尝试直链
      if (!captureResult || !captureResult.m3u8Url) {
        tLog.info('未捕获到 m3u8/MPD，尝试直链...');
        captureResult = await captureDirectUrl(url, {
          onProgress: (p) => {
            taskManager.update(taskId, { progress: p.progress || 60, message: p.message, phase: 'preparing' });
          },
        });
        if (captureResult) captureResult.format = 'direct';
      }
    }

    if (!captureResult || !captureResult.m3u8Url) {
      throw new Error('未能获取到视频流地址，可能页面无视频或需要登录');
    }

    const streamUrl = captureResult.m3u8Url;
    const streamFormat = captureResult.format || 'm3u8';

    // ⭐ SSRF 全链路：捕获到的流地址同样做字面量 + DNS + 重定向校验
    await assertPublicUrl(streamUrl);

    // ── Token 时效性检测 ────────────────────────
    const tokenInfo = parseTokenExpiry(streamUrl);
    if (tokenInfo.timeToLive !== null && tokenInfo.timeToLive < 60000) {
      tLog.warn({ timeToLive: tokenInfo.timeToLive }, 'Token 即将过期');
      taskManager.update(taskId, {
        message: `⚠ Token 将在 ${Math.round(tokenInfo.timeToLive / 1000)}s 后过期，需快速下载`,
      });
    }

    taskManager.update(taskId, {
      m3u8Url: streamUrl,
      streamHeaders: pickStreamHeaders(captureResult.headers || {}),
      message: `捕获到 ${streamFormat.toUpperCase()}: ${streamUrl.slice(0, 80)}...`,
      progress: 100,
      phase: 'preparing_done',
    });

    tLog.info({ streamUrl: streamUrl.slice(0, 80), format: streamFormat }, '视频流捕获成功');

    // ── 回合 2: 下载 ───────────────────────────
    taskManager.update(taskId, {
      message: '开始下载...',
      progress: 0,
      phase: 'downloading',
    });

    // 构建下载选项（headers 通过 startDownload 第2参数单独传入，不放在 options 里）
    const downloadOpts = {
      engine: task.engine || 'auto',
      format: task.format || streamFormat,
      maxSpeed: task.maxSpeed || 0,
      useProxy: !!task.proxy,
      proxy: task.proxy || null,
      targetBandwidth: task.targetBandwidth || null,
      parallel: task.parallel || false,
      parallelCount: task.parallelCount || 4,
      preferredCodec: task.preferredCodec || null,
      timeoutMs: task.timeoutMs || null,
    };

    // ⭐ 修复：参数顺序必须匹配 startDownload(m3u8Url, headers, taskId, onProgress, options)
    const outputFile = await startDownload(
      streamUrl,
      captureResult.headers || {},     // 第2参数：headers（包含 Referer/Origin/Cookie 等防盗链头）
      taskId,                           // 第3参数：taskId
      ({ percent, speed, message }) => {
        taskManager.update(taskId, { progress: percent, speed, message, phase: 'downloading' });
      },
      downloadOpts                      // 第5参数：options（engine/maxSpeed/parallel/format 等）
    );

    let outputSizeBytes = null;
    try {
      outputSizeBytes = fs.statSync(outputFile).size;
    } catch (_) {}
    taskManager.markCompleted(taskId, outputFile, { outputSizeBytes });
    tLog.info({ outputFile }, '下载完成');
  } catch (err) {
    tLog.error({ err: err.message }, '任务执行失败');
    // 用户已取消/删除的任务：不再自动重试
    const current = taskManager.get(taskId);
    if (!current || current.status === TaskStatus.CANCELLED) return;
    const autoRetried = taskManager.markFailed(taskId, err.message);
    if (autoRetried) {
      tLog.info('已自动加入重试队列');
    } else {
      tLog.error('已耗尽重试次数');
    }
  } finally {
    scheduleNext();
  }
}

/**
 * 统一任务调度器：受 maxConcurrent 限制，从队列取任务并启动
 * 所有入口（新建/重试/自动重试/任务结束/启动恢复）都走这里
 */
function scheduleNext() {
  let next;
  while ((next = taskManager.dequeue())) {
    log.info({ taskId: next.id }, '启动下一个任务');
    processTask(next.id).catch((err) => {
      log.error({ taskId: next.id }, `执行异常: ${err.message}`);
    });
  }
}

// ═══════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════

/**
 * 挑选需要透传给下载引擎的请求头（防注入 + 控制体积）
 */
function pickStreamHeaders(headers = {}) {
  const allowed = new Set([
    'referer', 'origin', 'cookie', 'user-agent', 'accept', 'accept-language',
    'authorization', 'x-requested-with',
  ]);
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    const k = String(key).toLowerCase();
    if (!allowed.has(k)) continue;
    const v = String(value || '').replace(/[\r\n]/g, '');
    if (v) result[k] = v;
  }
  return result;
}

// ═══════════════════════════════════════════════════════
// 启动
// ═══════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════
// 启动 & 优雅关闭
// ═══════════════════════════════════════════════════════

httpServer.listen(PORT, () => {
  log.info({ port: PORT }, '🚀 视频下载服务已启动');
  log.info(`  API: http://0.0.0.0:${PORT}/api/download`);
  log.info(`  WS:  ws://0.0.0.0:${PORT}`);
  log.info(`  📊 统计: http://0.0.0.0:${PORT}/api/stats`);
  log.info(`  ❤️ 健康检查: http://0.0.0.0:${PORT}/api/health`);

  // 设置全局带宽限制
  if (MAX_GLOBAL_BANDWIDTH > 0) {
    setBandwidthLimit(MAX_GLOBAL_BANDWIDTH);
    log.info({ maxBandwidth: MAX_GLOBAL_BANDWIDTH }, '全局带宽限制已启用');
  }

  // 恢复上次未完成任务（重启后 running → created 已重新入队）
  scheduleNext();
});

// ⭐ 优雅关闭：释放 BrowserPool，清理子进程，防止僵尸 Chromium
let isShuttingDown = false;
async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log.warn({ signal }, `收到 ${signal} 信号，开始优雅关闭...`);

  // 1. 停止接收新 HTTP 请求
  httpServer.close(() => log.info('HTTP 服务器已关闭'));

  // 2. 取消所有活跃下载
  for (const task of taskManager.listAll()) {
    if (task.status === 'running' || task.status === 'created') {
      cancelDownload(task.id);
    }
  }

  // 3. 刷新任务持久化
  taskManager.flush();

  // 4. 销毁浏览器池（强制关闭所有 Chromium 进程）
  try {
    await browserPool.destroy();
    log.info('BrowserPool 已销毁');
  } catch (err) {
    log.error({ err: err.message }, 'BrowserPool 销毁异常');
  }

  process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
