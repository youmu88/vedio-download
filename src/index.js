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
import listStore from './list-store.js';
import { probeFfmpeg, isTranscoding, startTranscode, cancelAllTranscodes } from './transcode.js';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// ⭐ 下载目录支持环境变量覆盖：测试/隔离环境可用 VD_DOWNLOADS_DIR 指向独立目录，避免污染真实下载
const DOWNLOADS_DIR = process.env.VD_DOWNLOADS_DIR ? path.resolve(process.env.VD_DOWNLOADS_DIR) : path.resolve(__dirname, '../downloads');

// ⭐ 视频库扩展名白名单：/api/library 仅列出浏览器可直接播放或可服务端转码的媒体格式。
// .ts 容器（Chrome/Firefox <video> 不支持）且无转码入口 → 不入库；
// 本集合同时作为 fs.watch 变更事件的过滤依据（非白名单文件变更不触发刷新推送）。
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mkv', '.mov', '.m3u8']);

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

// ⭐ 登录会话：持久化到 SQLite（服务重启后登录态保留），由 listStore 管理
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000; // 7 天
const AUTH_COOKIE = 'vd_auth_token'; // 用于 video 标签等无法带 Authorization header 的场景

/** 极简 cookie 解析（避免引入 cookie-parser 依赖） */
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) {
      const k = part.slice(0, idx).trim();
      const v = decodeURIComponent(part.slice(idx + 1).trim());
      if (k) out[k] = v;
    }
  }
  return out;
}

/** 从 header 或 cookie 提取凭据 */
function resolveToken(req) {
  return req.headers.authorization?.replace(/^Bearer\s+/i, '')
    || req.headers['x-auth-token']
    || parseCookies(req)[AUTH_COOKIE]
    || req.query.token
    || null;
}

const requireAuth = (req, res, next) => {
  const token = resolveToken(req);
  const username = token ? listStore.getSessionUser(token) : null;
  if (!username) {
    return res.status(401).json({ error: '未登录：请先登录' });
  }
  req.user = username;
  // ⭐ 用户隔离：列表查询/写入按当前登录用户过滤
  listStore.setCurrentUser(username);
  next();
};

// ⭐ 全局中间件必须先于所有路由注册，否则 req.body 无法解析
app.use(cors({
  origin: allowedOrigins.includes('*') ? '*' : allowedOrigins,
  methods: ['GET', 'POST', 'DELETE'],
}));
app.use(express.json({ limit: '1mb' }));

// 登录 API（放置于 requireAuth 挂载之前，免登录访问）
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  try {
    const user = listStore.login(username, password);
    const token = crypto.randomBytes(32).toString('hex');
    listStore.createSession(token, user.username, SESSION_TTL_MS);
    // ⭐ 同时下发 cookie：video 标签播放 /downloads 时无法带 Authorization header
    // SameSite=None; Secure 确保 video 子资源请求携带 cookie
    res.cookie(AUTH_COOKIE, token, {
      httpOnly: false,
      sameSite: 'none',
      secure: true,
      maxAge: SESSION_TTL_MS,
      path: '/',
    });
    res.json({ ok: true, token, username: user.username });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

// 登出 API：清除会话 token
app.post('/api/auth/logout', (req, res) => {
  const token = resolveToken(req);
  if (token) listStore.deleteSession(token);
  res.clearCookie(AUTH_COOKIE, { path: '/' });
  res.json({ ok: true });
});

// 注册 API（保留能力；前端按钮置灰，暂不开放）
app.post('/api/auth/register', (req, res) => {
  const { username, password } = req.body || {};
  try {
    const user = listStore.register(username, password);
    // ⭐ 用户隔离：注册成功即初始化专属下载目录
    const dir = path.join(DOWNLOADS_DIR, user.username);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    res.json({ ok: true, username: user.username });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ⭐ P2-11: 全局 API 速率限制
// ⚠️ 仅挂 /api 路由：/downloads 视频流是播放器高频 Range 请求路径，
// 挂全局会导致快进/拖拽/切换视频时被限流误伤（实测第 78 个请求即 429），播放直接不可用。
const globalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 分钟
  max: 100,
  message: { error: '请求过于频繁，请稍后再试' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api', globalLimiter);

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
app.use('/vendor/hls.js', express.static(path.join(__dirname, '../node_modules/hls.js/dist')));
app.use(express.static(path.join(__dirname, '../public')));

// ⭐ 下载文件按用户隔离：cookie 鉴权（video 标签无法带 Authorization header）
// 映射到 downloads/<username>/ 子目录，实现用户隔离
app.use('/downloads', (req, res, next) => {
  const token = resolveToken(req);
  const username = token ? listStore.getSessionUser(token) : null;
  if (!username) {
    return res.status(401).json({ error: '未登录：请先登录' });
  }
  req.user = username;
  listStore.setCurrentUser(username);
  const userDir = path.join(DOWNLOADS_DIR, username);
  express.static(userDir, { fallthrough: false })(req, res, () => {
    res.status(404).json({ error: '文件不存在' });
  });
});

// ─── HTTP Server & Socket.IO ────────────────────────
const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: { origin: allowedOrigins.includes('*') ? '*' : allowedOrigins, methods: ['GET', 'POST'] },
});

// WebSocket 连接（⭐ 用户隔离：从握手 auth 解析用户并加入对应房间）
io.on('connection', (socket) => {
  log.info({ socketId: socket.id }, 'WS 客户端连接');

  // 从握手 auth 或 query 解析登录用户
  const authToken = socket.handshake?.auth?.token
    || socket.handshake?.query?.token
    || null;
  const authUser = authToken ? listStore.getSessionUser(authToken) : null;
  if (authUser) socket.join(`user:${authUser}`);

  socket.on('subscribe', (taskId) => {
    const task = taskManager.get(taskId);
    // 用户隔离：仅允许订阅自己拥有的任务
    if (task && authUser && (!task.owner || task.owner === authUser)) {
      socket.join(`task:${taskId}`);
      socket.emit('task-status', task);
    }
  });

  socket.on('unsubscribe', (taskId) => {
    socket.leave(`task:${taskId}`);
  });

  socket.on('disconnect', () => {
    log.info({ socketId: socket.id }, 'WS 客户端断开');
  });
});

// ─── taskManager 事件 → WebSocket 广播 ────────────
// ⭐ 用户隔离：任务列表只推送给该任务所属用户的客户端
function broadcastTaskList(owner) {
  io.to(`user:${owner}`).emit('task-list-update', taskManager.listByOwner(owner));
}

// ⭐ 视频库变更定向推送：fs.watch / 下载完成 / 转码后按 owner 房间通知前端刷新视频库
function broadcastLibrary(owner) {
  io.to(`user:${owner}`).emit('library-update', { owner });
}

taskManager.on('task-updated', (task) => {
  io.to(`task:${task.id}`).emit('task-status', task);
  broadcastTaskList(task.owner || 'wilsonwen');
});

taskManager.on('task-created', (task) => {
  broadcastTaskList(task.owner || 'wilsonwen');
});

taskManager.on('task-retry', (task) => {
  broadcastTaskList(task.owner || 'wilsonwen');
});

taskManager.on('task-completed', (task) => {
  broadcastTaskList(task.owner || 'wilsonwen');
  broadcastLibrary(task.owner || 'wilsonwen'); // ⭐ 下载完成是最高频入库事件，立即推送视频库刷新
  // ⭐ Socket.IO 房间清理：通知客户端退订已完成任务
  io.to(`task:${task.id}`).emit('task-finalized', { taskId: task.id });
});

taskManager.on('task-failed', (task) => {
  broadcastTaskList(task.owner || 'wilsonwen');
  // ⭐ Socket.IO 房间清理：通知客户端退订失败任务
  io.to(`task:${task.id}`).emit('task-finalized', { taskId: task.id });
});

taskManager.on('task-cancelled', (task) => {
  broadcastTaskList(task.owner || 'wilsonwen');
  io.to(`task:${task.id}`).emit('task-finalized', { taskId: task.id });
});

taskManager.on('task-removed', ({ taskId, owner }) => {
  // ⭐ 用户隔离：向该任务所属用户广播更新
  broadcastTaskList(owner || 'wilsonwen');
});

// 重试就绪事件 → 交给统一调度器（受 maxConcurrent 限制）
taskManager.on('task-retry-ready', () => {
  scheduleNext();
});

// ─── 视频库自动扫描：fs.watch 递归监听 downloads → 防抖 → 定向推送 library-update ───
// ⭐ 平台边界：Docker Desktop (macOS) 的 bind mount 下，宿主侧拷入文件不会传播事件到容器内，
//    该场景由前端「进页必刷 + visibilitychange + ≤15s 轮询」兜底；本监听覆盖服务自身写盘
//    （下载完成 rename / 转码产物落盘 / 服务进程内删除）的实时推送。
const LIBRARY_WATCH_DEBOUNCE_MS = 300;   // 合并批量写盘事件，避免逐文件抖动
const libraryWatchTimers = new Map();    // owner → debounce timer
let libraryWatcher = null;
try {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  libraryWatcher = fs.watch(DOWNLOADS_DIR, { recursive: true }, (_event, filename) => {
    try {
      if (!filename) return;
      const parts = String(filename).split(/[/\\]/).filter(Boolean);
      if (parts.length < 2) return; // 非用户子目录内的变更（downloads 根目录级事件，如启动迁移）
      const owner = parts[0];
      const base = parts[parts.length - 1];
      if (base.startsWith('.')) return;                                  // 隐藏文件 / .cache 目录内容
      if (/\.part($|\.)/i.test(base) || /\.tmp$/i.test(base)) return;   // 下载临时文件（X.part / X.part.mp4）
      if (!VIDEO_EXTS.has(path.extname(base).toLowerCase())) return;     // 仅白名单媒体文件触发刷新
      const prev = libraryWatchTimers.get(owner);
      if (prev) clearTimeout(prev);
      libraryWatchTimers.set(owner, setTimeout(() => {
        libraryWatchTimers.delete(owner);
        broadcastLibrary(owner);
      }, LIBRARY_WATCH_DEBOUNCE_MS));
    } catch { /* 单个事件解析失败可忽略 */ }
  });
  libraryWatcher.on('error', (err) => log.warn({ err: err.message }, 'fs.watch 视频库监听异常'));
  log.info({ dir: DOWNLOADS_DIR }, '视频库 fs.watch 监听已启动（library-update 推送）');
} catch (err) {
  log.warn({ err: err.message }, 'fs.watch 初始化失败：视频库自动推送不可用（前端轮询兜底）');
}

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
    version: '2.2.0',
    tasks: {
      total: tasks.length,
      queued: taskManager.queue.length,
      maxConcurrent: taskManager.getMaxConcurrent(),
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

  const taskId = taskManager.create(url, { cookies, injectScript, maxSpeed, proxy, owner: req.user });
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
    owner: req.user,
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
app.get('/api/tasks', (req, res) => {
  res.json(taskManager.listByOwner(req.user));
});

/**
 * GET /api/library — 已下载视频库（供“浏览”页播放，按用户隔离）
 */
app.get('/api/library', (req, res) => {
  const userDir = path.join(DOWNLOADS_DIR, req.user);
  // 进行中/排队中任务：既按 taskId 前缀过滤，也按实际输出名过滤
  // （引擎按 resolveOutputName 的标题命名直接落最终文件，仅 taskId 前缀匹配不住）
  const runningTasks = taskManager.listByOwner(req.user)
    .filter(t => [TaskStatus.CREATED, TaskStatus.RUNNING].includes(t.status));
  const runningIds = new Set(runningTasks.map(t => t.id));
  const runningOutputs = new Set(
    runningTasks.flatMap(t => [t.outputFile, t.outputName])
      .filter(Boolean)
      .map(n => path.basename(String(n)))
  );
  // 已加入列表（含私密列表）的视频：浏览页不再直接可见，仅存于对应列表
  const listedNames = listStore.allItemNames();
  let files = [];
  try {
    files = fs.readdirSync(userDir)
      .filter((name) => {
        if (name.startsWith('.')) return false;
        // ⭐ 下载临时文件：X.part（旧形态）与 X.part.mp4（直链断点续传写盘形态）
        if (name.endsWith('.part') || name.includes('.part.')) return false;
        if (runningIds.has(name) || [...runningIds].some(id => name.startsWith(`${id}.`))) return false;
        // ⭐ 进行中/排队中任务的实际输出文件（标题命名）不得泄漏入库
        if (runningOutputs.has(name)) return false;
        // ⭐ 扩展名白名单：仅可播放/可转码格式入库（.txt/.zip/.srt/.ts 等一律隐藏）
        if (!VIDEO_EXTS.has(path.extname(name).toLowerCase())) return false;
        if (listedNames.has(name)) return false; // ⭐ 已入列表：浏览页隐藏
        const p = path.join(userDir, name);
        let stat;
        try { stat = fs.statSync(p); } catch { return false; }
        return stat.isFile();
      })
      .map((name) => {
        const p = path.join(userDir, name);
        const stat = fs.statSync(p);
        return { name, size: stat.size, mtime: stat.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch (err) {
    return res.status(500).json({ error: `读取视频库失败: ${err.message}` });
  }
  res.json(files);
});

/**
 * DELETE /api/library/:name — 删除视频库中的文件
 * 仅允许删除 downloads 根目录下的普通文件，且不允许删除运行中任务的文件
 */
app.delete('/api/library/:name', (req, res) => {
  const userDir = path.join(DOWNLOADS_DIR, req.user);
  const name = path.basename(req.params.name || '');
  if (!name || name === '.' || name === '..') {
    return res.status(400).json({ error: '非法文件名' });
  }
  const filePath = path.join(userDir, name);
  if (!filePath.startsWith(userDir + path.sep)) {
    return res.status(400).json({ error: '非法文件名' });
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return res.status(404).json({ error: '文件不存在' });
  }
  const runningIds = new Set(
    taskManager.listByOwner(req.user)
      .filter(t => [TaskStatus.CREATED, TaskStatus.RUNNING].includes(t.status))
      .map(t => t.id)
  );
  if ([...runningIds].some(id => name.startsWith(`${id}.`))) {
    return res.status(409).json({ error: '该文件属于运行中的任务，请先停止任务' });
  }
  try {
    fs.unlinkSync(filePath);
    log.info({ name }, '删除视频库文件');
    res.json({ ok: true, name });
  } catch (err) {
    res.status(500).json({ error: `删除失败: ${err.message}` });
  }
});

/**
 * POST /api/transcode — 将浏览器无法直接播放的容器（MKV 等）转为 H.264/AAC MP4
 *
 * 管线（src/transcode.js）：ffprobe 探测编码 → H.264/AAC 走 -c copy remux（秒级），
 * 否则 libx264+aac 转码；产物 <原名>.mp4 落同一用户 downloads 目录（白名单内自动入库）；
 * 进度经 user 房间 socket 推送 transcode-status；未安装 ffmpeg 时明确 503（不静默）。
 */
app.post('/api/transcode', async (req, res) => {
  const ffmpegOk = await probeFfmpeg();
  if (!ffmpegOk) return res.status(503).json({ error: '服务端未安装 ffmpeg，无法转码' });
  // ⭐ 防路径穿越：与 DELETE /api/library/:name 同款 basename + startsWith 校验
  const name = path.basename(req.body?.name || '');
  if (!name || name === '.' || name === '..' || name.includes('\\')) {
    return res.status(400).json({ error: '非法文件名' });
  }
  const userDir = path.join(DOWNLOADS_DIR, req.user);
  const inputPath = path.join(userDir, name);
  if (!inputPath.startsWith(userDir + path.sep)) {
    return res.status(400).json({ error: '非法文件名' });
  }
  const ext = path.extname(name).toLowerCase();
  if (!VIDEO_EXTS.has(ext)) return res.status(400).json({ error: '不支持的媒体格式' });
  if (ext === '.mp4' || ext === '.m3u8') {
    return res.status(400).json({ error: '该格式浏览器可直接播放，无需转码' });
  }
  if (!fs.existsSync(inputPath) || !fs.statSync(inputPath).isFile()) {
    return res.status(404).json({ error: '文件不存在' });
  }
  const outputName = name.slice(0, -ext.length) + '.mp4';
  if (fs.existsSync(path.join(userDir, outputName))) {
    return res.status(409).json({ error: `转码产物已存在：${outputName}` });
  }
  if (isTranscoding(req.user, name)) {
    return res.status(409).json({ error: '该文件正在转码中，请稍候' });
  }
  try {
    startTranscode({
      owner: req.user,
      name,
      userDir,
      onStatus: (s) => {
        // ⭐ 转码进度经 user 房间 socket 推送（与任务广播同一隔离模型）
        io.to(`user:${req.user}`).emit('transcode-status', s);
      },
    });
    log.info({ owner: req.user, name, outputName }, '开始转码');
    res.json({ ok: true, name, output: outputName, status: 'running' });
  } catch (err) {
    res.status(500).json({ error: `转码启动失败: ${err.message}` });
  }
});

/**
 * GET /api/settings — 读取服务端设置
 */
app.get('/api/settings', (_req, res) => {
  res.json({ maxConcurrent: taskManager.getMaxConcurrent() });
});

/**
 * POST /api/settings — 更新服务端设置（并行下载数 1～10）
 */
app.post('/api/settings', (req, res) => {
  const { maxConcurrent } = req.body || {};
  const value = parseInt(maxConcurrent, 10);
  if (isNaN(value) || value < 1 || value > 10) {
    return res.status(400).json({ error: '并行下载数需在 1～10 之间' });
  }
  const applied = taskManager.setMaxConcurrent(value);
  log.info({ maxConcurrent: applied }, '更新并行下载数');
  res.json({ ok: true, maxConcurrent: applied });
});

/** 校验任务归属：返回任务或 403/404 响应 */
function ownedTask(req, res, id) {
  const task = taskManager.get(id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (task.owner && task.owner !== req.user) {
    return res.status(403).json({ error: '无权访问该任务' });
  }
  return task;
}

/**
 * GET /api/task/:id — 查询单个任务
 */
app.get('/api/task/:id', (req, res) => {
  const task = ownedTask(req, res, req.params.id);
  if (!task) return;
  res.json(task);
});

/**
 * DELETE /api/task/:id — 删除任务
 */
app.delete('/api/task/:id', (req, res) => {
  const task = ownedTask(req, res, req.params.id);
  if (!task) return;
  cancelDownload(req.params.id);
  const ok = taskManager.remove(req.params.id);
  if (!ok) return res.status(500).json({ error: '删除失败' });
  res.json({ ok: true });
});

/**
 * POST /api/task/:id/cancel — 停止任务（不删除，保留分片缓存，可重试续跑）
 */
app.post('/api/task/:id/cancel', (req, res) => {
  const task = ownedTask(req, res, req.params.id);
  if (!task) return;
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
  // ⭐ 用户隔离：仅操作当前用户的任务
  const owned = taskIds.filter((id) => {
    const t = taskManager.get(id);
    return t && (!t.owner || t.owner === req.user);
  });
  const result = taskManager.retryBatch(owned);
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
  // ⭐ 用户隔离：仅操作当前用户的任务
  const owned = taskIds.filter((id) => {
    const t = taskManager.get(id);
    return t && (!t.owner || t.owner === req.user);
  });
  for (const id of owned) cancelDownload(id);
  const result = taskManager.removeBatch(owned);
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
app.get('/api/stats', (req, res) => {
  const tasks = taskManager.listByOwner(req.user);
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
// 列表系统 API（公开列表 + 私密列表 + 私密密码）
// ═══════════════════════════════════════════════════════

/** 从 Header 读取私密 token（私密操作鉴权） */
function privateToken(req) {
  return (req.headers['x-private-token'] || '').toString();
}

/**
 * GET /api/lists — 列出公开列表（私密列表默认不可见）
 */
app.get('/api/lists', (_req, res) => {
  res.json({ lists: listStore.listAll(), hasPrivate: listStore.hasPrivateList() });
});

/**
 * GET /api/lists/private-meta — 私密列表元数据（id/name/count，不含 items）
 * ⭐ 供前端“将视频加入私密列表”时选择目标列表，无需密码（密码仅用于进入/浏览列表内容）
 * 必须定义在 /api/lists/:id 之前，避免被 :id 通配捕获
 */
app.get('/api/lists/private-meta', (req, res) => {
  res.json({ lists: listStore.listPrivateMeta() });
});

/**
 * GET /api/lists/:id — 查询单个列表（私密列表需 token）
 */
app.get('/api/lists/:id', (req, res) => {
  const list = listStore.get(req.params.id);
  if (!list) return res.status(404).json({ error: '列表不存在' });
  if (list.private) {
    try { listStore.verifyToken(privateToken(req)); }
    catch (err) { return res.status(401).json({ error: err.message }); }
  }
  // 为列表条目补充文件信息（大小/修改时间），供浏览页列表内视频卡片展示
  const items = (list.items || []).map((it) => {
    const p = path.join(DOWNLOADS_DIR, it.name);
    let size = it.size, mtime = it.mtime;
    try {
      if (fs.existsSync(p)) {
        const st = fs.statSync(p);
        size = st.size; mtime = st.mtimeMs;
      }
    } catch (_) {}
    return { ...it, size, mtime };
  });
  res.json({ ...list, items });
});

/**
 * POST /api/lists — 创建列表
 * Body: { name: string, private?: boolean }
 * 创建私密列表需携带 x-private-token
 */
/**
 * POST /api/lists — 创建列表（含私密，不需要密码：密码仅用于进入/浏览私密列表内容）
 * Body: { name: string, private?: boolean }
 */
app.post('/api/lists', (req, res) => {
  const { name, private: isPrivate } = req.body || {};
  try {
    const list = listStore.create(name, !!isPrivate);
    log.info({ listId: list.id, name: list.name, private: list.private }, '创建列表');
    res.json({ ok: true, list });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * DELETE /api/lists/:id — 删除列表（私密列表需 token）
 */
app.delete('/api/lists/:id', (req, res) => {
  try {
    const ok = listStore.remove(req.params.id, privateToken(req));
    if (!ok) return res.status(404).json({ error: '列表不存在' });
    log.info({ listId: req.params.id }, '删除列表');
    res.json({ ok: true });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

/**
 * POST /api/lists/:id/items — 添加条目到列表（含私密，不需要密码）
 * Body: { names: string[] }
 */
app.post('/api/lists/:id/items', (req, res) => {
  const { names } = req.body || {};
  try {
    const list = listStore.addItems(req.params.id, names);
    res.json({ ok: true, list });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * DELETE /api/lists/:id/items — 从列表移除条目（含私密，不需要密码）
 * Body: { names: string[] }
 */
app.delete('/api/lists/:id/items', (req, res) => {
  const { names } = req.body || {};
  try {
    const list = listStore.removeItems(req.params.id, names);
    res.json({ ok: true, list });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /api/tasks/clean-completed — 一键清理所有已完成任务记录（保留已下载文件）
 */
app.post('/api/tasks/clean-completed', (req, res) => {
  const completed = taskManager.listByOwner(req.user)
    .filter(t => t.status === TaskStatus.COMPLETED)
    .map(t => t.id);
  if (completed.length === 0) {
    return res.json({ ok: true, removed: 0 });
  }
  const result = taskManager.removeBatch(completed);
  log.info({ removed: result.success }, '一键清理已完成任务记录');
  res.json({ ok: true, removed: result.success, ...result });
});

/**
 * GET /api/private/status — 私密密码状态（是否已设置 / 是否存在私密列表）
 */
app.get('/api/private/status', (req, res) => {
  const token = privateToken(req);
  let tokenValid = false;
  if (token) {
    try { listStore.verifyToken(token); tokenValid = true; } catch (_) {}
  }
  res.json({
    hasPassword: listStore.hasPassword(),
    hasPrivate: listStore.hasPrivateList(),
    tokenValid, // token 是否有效（前端据此决定是否引导重新解锁）
  });
});

/**
 * POST /api/private/password — 首次设置私密密码（4/6 位数字）
 * Body: { password: string }
 */
app.post('/api/private/password', (req, res) => {
  if (listStore.hasPassword()) {
    return res.status(400).json({ error: '私密密码已设置，如需修改请先验证' });
  }
  const { password } = req.body || {};
  try {
    listStore.setPassword(password);
    log.info('设置私密密码');
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /api/private/verify — 验证私密密码，签发 token（永不过期，认证由前端锁会话控制）
 * Body: { password: string }
 */
app.post('/api/private/verify', (req, res) => {
  const { password } = req.body || {};
  try {
    const { token, expiresAt } = listStore.verifyPassword(password);
    res.json({ ok: true, token, expiresAt });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

/**
 * POST /api/private/logout — 私密登出/锁定：删除服务端私密 token
 * ⭐ 前端在软件到后台或退出私密列表时调用，使私密认证失效并清理服务端会话
 */
app.post('/api/private/logout', (req, res) => {
  const token = privateToken(req);
  if (token) listStore.deletePrivateSession(token);
  res.json({ ok: true });
});

/**
 * POST /api/private/change — 修改私密密码（需 token，已认证无需原密码）
 * Body: { newPassword }
 */
app.post('/api/private/change', (req, res) => {
  const { newPassword } = req.body || {};
  try {
    listStore.changePassword(privateToken(req), newPassword);
    log.info('修改私密密码');
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * GET /api/private/lists — 列出私密列表（需 token）
 */
app.get('/api/private/lists', (req, res) => {
  try {
    listStore.verifyToken(privateToken(req));
  } catch (err) {
    return res.status(401).json({ error: err.message });
  }
  res.json({ lists: listStore.listPrivate(privateToken(req)) });
});

// ═══════════════════════════════════════════════════════
// 核心流程：拦截 → 下载（增强版）
// ═══════════════════════════════════════════════════════
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
    // ⭐ 用页面标题/链接提取可读文件名，而不是 taskId
    const outputName = resolveOutputName(task, captureResult, streamUrl);

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
      owner: task.owner || 'wilsonwen',
      outputDir: path.join(DOWNLOADS_DIR, task.owner || 'wilsonwen'), // ⭐ 用户隔离：下载到用户专属目录
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
      outputName,
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

/**
 * 清理文件名中的非法字符
 */
function sanitizeFileBase(name) {
  return String(name || '')
    .replace(/[\\/:*?"<>|\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/**
 * 从捕获结果/流地址推导可读输出文件名
 * 优先页面标题；直链/流地址取路径文件名；均不可用时退回 taskId
 */
function resolveOutputName(task, captureResult, streamUrl) {
  const userDir = path.join(DOWNLOADS_DIR, task.owner || 'wilsonwen');
  let base = '';
  if (captureResult.pageTitle) base = sanitizeFileBase(captureResult.pageTitle);
  else if (captureResult.title) base = sanitizeFileBase(captureResult.title);
  else {
    try {
      const file = path.basename(new URL(streamUrl).pathname);
      const clean = file.replace(/\.(m3u8|mpd|mp4|mkv|webm|ts)$/i, '');
      if (clean && !/^(index|playlist|master)$/i.test(clean)) base = sanitizeFileBase(clean);
    } catch (_) {}
  }
  if (!base) return task.id;
  // 存在同名文件时追加短任务号，避免覆盖其他任务（按用户目录检查）
  const conflict = ['.mp4', '.ts', '.mkv'].some(ext => fs.existsSync(path.join(userDir, base + ext)));
  return conflict ? `${base}_${task.id.slice(-6)}` : base;
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

  // ⭐ ffmpeg 可用性探测：转码能力前置声明（不可用时 POST /api/transcode 明确 503，不静默）
  probeFfmpeg().then((ok) => {
    if (ok) log.info('ffmpeg 可用，MKV 等容器的服务端转码已启用');
    else log.warn('未检测到 ffmpeg，转码功能不可用（POST /api/transcode 将返回 503）');
  });

  // 设置全局带宽限制
  if (MAX_GLOBAL_BANDWIDTH > 0) {
    setBandwidthLimit(MAX_GLOBAL_BANDWIDTH);
    log.info({ maxBandwidth: MAX_GLOBAL_BANDWIDTH }, '全局带宽限制已启用');
  }

  // 恢复上次未完成任务（重启后 running → created 已重新入队）
  // AUTO_START_QUEUE=0 可进入“待命模式”，不自动处理队列（维护/调试用）
  if (process.env.AUTO_START_QUEUE !== '0') {
    scheduleNext();
  }

  // ⭐ 用户隔离：为数据库中的每个用户初始化专属下载目录
  try {
    const users = listStore.listUsers();
    for (const u of users) {
      const dir = path.join(DOWNLOADS_DIR, u.username);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }
    // ⭐ 历史数据迁移：downloads 根目录旧文件归入默认用户（wilsonwen）子目录
    try {
      const rootEntries = fs.readdirSync(DOWNLOADS_DIR);
      const defaultUser = 'wilsonwen';
      const userNames = new Set(users.map(u => u.username));
      const legacyDir = path.join(DOWNLOADS_DIR, defaultUser);
      if (fs.existsSync(legacyDir)) {
        for (const entry of rootEntries) {
          if (userNames.has(entry)) continue; // 跳过用户子目录
          if (entry.startsWith('.')) continue; // 跳过隐藏（.cache 等）
          const src = path.join(DOWNLOADS_DIR, entry);
          let st; try { st = fs.statSync(src); } catch { continue; }
          if (!st.isFile()) continue;
          const dst = path.join(legacyDir, entry);
          if (fs.existsSync(dst)) continue;
          try {
            fs.renameSync(src, dst);
            log.info({ from: entry, to: defaultUser }, '迁移历史下载文件到用户目录');
          } catch (err) {
            log.warn({ entry, err: err.message }, '历史文件迁移失败');
          }
        }
      }
    } catch (err) {
      log.warn({ err: err.message }, '历史下载文件迁移扫描失败');
    }
    log.info({ users: users.map(u => u.username) }, '已为用户初始化下载目录');
  } catch (err) {
    log.error({ err: err.message }, '用户下载目录初始化失败');
  }

  // ⭐ 可选优化：启动时主动清理已过期的登录/私密会话（避免表无限增长）
  try {
    const clearedLogin = listStore.sweepSessions();
    const clearedPrivate = listStore.sweepPrivateSessions();
    if (clearedLogin || clearedPrivate) {
      log.info({ clearedLogin, clearedPrivate }, '启动时已清理过期会话');
    }
  } catch (err) {
    log.warn({ err: err.message }, '启动时清理过期会话失败');
  }
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

  // 2.5 终止运行中的转码子进程（防僵尸 ffmpeg）
  cancelAllTranscodes();

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
