/**
 * 流式转码模块 — MKV 等浏览器无法直接播放的容器 → HLS 事件播放列表（边转边播）
 *
 * 模型：用户点击不可播文件 → 建立一个「流式会话」（streamId）：
 *   ffmpeg 以 -readrate 限速持续产出 HLS 分片（4s/片，EVENT 播放列表全量保留），
 *   前端 hls.js 从第 0 秒起播、缓冲随转换进度增长（转换速率 ≥1 倍速 → 永远领先播放）；
 *   转换完成自动合封为 <原名>.mp4 入库（复用既有 fs.watch 库刷新链路）。
 *
 * 管线矩阵（probeMedia 探测编码后决定，convert 参数见 buildFfmpegArgs）：
 *   视频 H.264 + 音频 AAC/无  → remux：音视频全直拷（零质量损失）
 *   视频 H.264 + 其他音频     → copy-audio：视频直拷 + 音频转 AAC（实测 ≈77 倍速）
 *   其他视频编码              → encode：libx264 + AAC 重编码（-readrate 限速至 ~1.25 倍速）
 *
 * 设计约束：
 *   - 独立模块：index.js 仅做路由/鉴权/推送桥接；
 *   - 同 owner+name 同时只允许一个活动会话（重复请求由路由层返回 409 续接契约）；
 *   - 并发上限 MAX_CONCURRENT_SESSIONS（超出抛 code='busy'，路由层映射 429）；
 *   - 产物时长校验通过才落盘入库（不把坏文件写进视频库）；
 *   - 分片目录 downloads/<user>/.vd-stream/<streamId>/（点开头 → 不入库/不触发库刷新）；
 *     结束后由 sweepSessions 定时清理（done 30 分钟无访问 / failed·cancelled 5 分钟）。
 */

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ─── ffmpeg 可用性探测（进程级缓存：服务启动探测一次） ───
let ffmpegProbeResult = null; // null = 尚未探测
export function probeFfmpeg() {
  if (ffmpegProbeResult !== null) return Promise.resolve(ffmpegProbeResult);
  return new Promise((resolve) => {
    execFile('ffmpeg', ['-version'], { timeout: 5000 }, (err) => {
      ffmpegProbeResult = !err;
      resolve(ffmpegProbeResult);
    });
  });
}

// ─── 流式转换速率 / 并发上限（环境变量可调；默认值依据 M1 Pro 实测标定） ───
// encode：限速到 1.25 倍速 → CPU ≈0.6 核（10 核机 6%），播放始终领先转换；
// copy 系（视频直拷）：CPU 本就极低，限速 6 倍速仅为磁盘 IO 温和，全片十几分钟转完。
const RATE_ENCODE = Number(process.env.VD_STREAM_RATE_ENCODE) || 1.25;
const RATE_COPY = Number(process.env.VD_STREAM_RATE_COPY) || 6;
export const MAX_CONCURRENT_SESSIONS = Number(process.env.VD_STREAM_MAX_CONCURRENT) || 2;
const SEGMENT_SECONDS = 4;                    // HLS 分片时长（关键帧对齐）
const INITIAL_BURST_SECONDS = 12;             // 启动预读：首屏 ≈2 个分片可用，约 5 秒内可播
const CLEANUP_GRACE_DONE_MS = 30 * 60 * 1000; // 完成后分片保留窗口（在播的客户端不受影响）
const CLEANUP_GRACE_SHORT_MS = 5 * 60 * 1000; // 失败/取消后的保留窗口（留现场供排查）

/** ffprobe 探测：音视频编码 + 总时长（进度百分比分母；GET /api/media-info 复用） */
export function probeMedia(filePath) {
  return new Promise((resolve, reject) => {
    execFile('ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name', '-of', 'json', filePath],
      { timeout: 15000, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(new Error(`ffprobe 探测失败: ${err.message}`));
        try {
          const parsed = JSON.parse(stdout);
          const streams = parsed.streams || [];
          const video = streams.find((s) => s.codec_type === 'video');
          const audio = streams.find((s) => s.codec_type === 'audio');
          resolve({
            videoCodec: video?.codec_name || null,
            audioCodec: audio?.codec_name || null,
            durationSec: parseFloat(parsed.format?.duration) || 0,
          });
        } catch (e) {
          reject(new Error(`ffprobe 输出解析失败: ${e.message}`));
        }
      });
  });
}

// ─── 管线矩阵：探测结果 → 转换模式 ───
/**
 * @returns {{mode: 'remux'|'copy-audio'|'encode'}}
 *   remux      = 视频直拷 + 音频直拷（仅当视频 H.264 且音频 AAC/无音轨）
 *   copy-audio = 视频直拷 + 音频转 AAC（主流资源快路：MKV 里 H.264 + AC3/DTS 等）
 *   encode     = 视频重编码 + 音频转 AAC
 */
export function resolvePipeline(media) {
  if (!media.videoCodec) {
    // 纯音频文件（罕见边界）：音频可直拷则 remux，否则按 copy-audio（仅转音频）处理
    const audioCopyable = !media.audioCodec || media.audioCodec === 'aac';
    return { mode: audioCopyable ? 'remux' : 'copy-audio' };
  }
  if (media.videoCodec === 'h264') {
    const audioCopyable = !media.audioCodec || media.audioCodec === 'aac';
    return { mode: audioCopyable ? 'remux' : 'copy-audio' };
  }
  return { mode: 'encode' };
}

/** 构造 HLS 产出的 ffmpeg 参数（-progress pipe:1 供进度解析） */
function buildFfmpegArgs({ media, mode, inputPath, dir }) {
  const videoArgs = mode === 'encode'
    ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23']
    : ['-c:v', 'copy'];
  const audioArgs = mode === 'remux' ? ['-c:a', 'copy'] : ['-c:a', 'aac'];
  // -force_key_frames 仅重编码模式可加：copy 无法插入关键帧，分段随源 GOP
  const keyframeArgs = mode === 'encode'
    ? ['-force_key_frames', `expr:gte(t,n_forced*${SEGMENT_SECONDS})`]
    : [];
  const mapArgs = media.videoCodec
    ? ['-map', '0:v:0', '-map', '0:a:0?']
    : ['-map', '0:a:0?'];
  return [
    '-y',
    '-readrate', String(mode === 'encode' ? RATE_ENCODE : RATE_COPY),
    '-readrate_initial_burst', String(INITIAL_BURST_SECONDS),
    '-i', inputPath,
    ...mapArgs,
    '-sn', // MKV 常内嵌 ASS/SSA 字幕，mp4/TS 均不支持该编码 → 显式丢弃（消除版本不确定性）
    ...videoArgs, ...audioArgs, ...keyframeArgs,
    '-f', 'hls',
    '-hls_time', String(SEGMENT_SECONDS),
    '-hls_list_size', '0',            // 全量保留分片：播放窗口始终覆盖第 0 秒（可回拖）
    '-hls_playlist_type', 'event',    // EVENT：播放列表随转换增长，收尾自动写 ENDLIST
    '-hls_flags', 'independent_segments+temp_file', // 关键帧对齐 + 分片/列表原子落地
    '-hls_segment_filename', path.join(dir, 'seg%05d.ts'),
    '-progress', 'pipe:1', '-nostats',
    path.join(dir, 'index.m3u8'),
  ];
}

// ─── 会话登记：streamId → state；owner::name → streamId（同文件互斥索引） ───
const sessions = new Map();
const fileIndex = new Map();
const ACTIVE_STATUSES = new Set(['running', 'finalizing']);

function fileKey(owner, name) {
  return `${owner}::${name}`;
}

export function getSession(streamId) {
  return sessions.get(streamId) || null;
}

/** 同 owner+name 的活动会话（路由层 409 running 契约依据） */
export function findActiveSession(owner, name) {
  const id = fileIndex.get(fileKey(owner, name));
  const s = id ? sessions.get(id) : null;
  return s && ACTIVE_STATUSES.has(s.status) ? s : null;
}

/** 播放列表/分片请求打点：延后清理窗口，保护正在观看的客户端 */
export function touchSession(streamId) {
  const s = sessions.get(streamId);
  if (s) s.lastAccessAt = Date.now();
}

/** 对外状态快照（显式字段：排除 child 进程句柄，保证可安全经 socket 序列化） */
function publicState(s) {
  return {
    streamId: s.streamId,
    owner: s.owner,
    name: s.name,
    output: s.output,
    status: s.status,
    mode: s.mode,
    progress: s.progress,
    convertedSec: Math.round(s.convertedSec * 10) / 10,
    durationSec: Math.round(s.durationSec * 10) / 10,
    error: s.error,
    startedAt: s.startedAt,
    updatedAt: s.updatedAt,
  };
}

function emit(s) {
  s.updatedAt = Date.now();
  try { s.onStatus?.(publicState(s)); } catch { /* 回调异常不影响转码本体 */ }
}

/**
 * 启动流式会话（同步返回 state，内部异步执行；前置校验由 index.js 路由层完成）：
 *   - 同文件已有活动会话 → 直接复用（幂等）；
 *   - 并发超限 → 抛 code='busy'；
 *   - 旧的非活动会话（failed/cancelled）→ 先清理目录再新建（重新开始语义）。
 */
export function startStreamSession({ owner, name, userDir, onStatus }) {
  const active = findActiveSession(owner, name);
  if (active) return active;

  const activeCount = [...sessions.values()].filter((s) => ACTIVE_STATUSES.has(s.status)).length;
  if (activeCount >= MAX_CONCURRENT_SESSIONS) {
    const err = new Error(`并发转换已达上限（${MAX_CONCURRENT_SESSIONS}），请等待其他文件转换完成`);
    err.code = 'busy';
    throw err;
  }

  // 旧会话（已结束）先清理，避免同文件分片目录叠加
  const oldId = fileIndex.get(fileKey(owner, name));
  if (oldId) removeSession(oldId, { deleteDir: true });

  const streamId = crypto.randomBytes(16).toString('hex');
  const ext = path.extname(name);
  const outputName = `${name.slice(0, -ext.length)}.mp4`;
  const dir = path.join(userDir, '.vd-stream', streamId);
  fs.mkdirSync(dir, { recursive: true });

  const state = {
    streamId,
    owner,
    name,
    dir,
    sourcePath: path.join(userDir, name),
    playlistPath: path.join(dir, 'index.m3u8'),
    output: outputName,
    outputPath: path.join(userDir, outputName),
    status: 'running', // running | finalizing | done | failed | cancelled
    mode: null,        // remux | copy-audio | encode（探测后确定）
    progress: 0,
    convertedSec: 0,
    durationSec: 0,
    error: null,
    cancelRequested: false,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    lastAccessAt: Date.now(),
    child: null,
    finalizeChild: null,
    errorTail: '',
    onStatus,
  };
  sessions.set(streamId, state);
  fileIndex.set(fileKey(owner, name), streamId);
  emit(state); // 立即上抛 running（前端可即时反馈）

  runSession(state).catch((err) => {
    // runSession 内部已兜底，此处仅防未捕获拒绝导致进程告警
    state.status = 'failed';
    state.error = err.message;
    emit(state);
  });

  return state;
}

/** 会话主体：探测 → HLS 转换（限速）→ 合封 MP4 → done */
async function runSession(state) {
  try {
    const media = await probeMedia(state.sourcePath);
    state.durationSec = media.durationSec || 0;
    state.mode = resolvePipeline(media).mode;
    emit(state);
    // 取消可能发生在探测窗口期（此时尚无 ffmpeg 子进程），在此消费取消请求
    if (state.cancelRequested) { state.status = 'cancelled'; emit(state); return; }

    const args = buildFfmpegArgs({ media, mode: state.mode, inputPath: state.sourcePath, dir: state.dir });
    await waitChild(state, args);
    if (state.cancelRequested) { state.status = 'cancelled'; state.progress = Math.min(state.progress, 99); emit(state); return; }

    state.status = 'finalizing';
    state.progress = 100;
    emit(state);
    await finalizeMp4(state);

    state.status = 'done';
    state.progress = 100;
    emit(state);
  } catch (err) {
    if (state.cancelRequested) {
      state.status = 'cancelled';
      state.error = null;
    } else {
      state.status = 'failed';
      state.error = err.message;
    }
    emit(state);
  } finally {
    state.child = null;
    state.finalizeChild = null;
  }
}

/** 启动 ffmpeg 并解析 -progress 输出（out_time_us / out_time_ms 历史上均以微秒计） */
function waitChild(state, args) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    state.child = child;
    // 取消发生在 spawn 与登记之间的小窗口：登记后立即补杀
    if (state.cancelRequested) {
      try { child.kill('SIGKILL'); } catch { /* noop */ }
    }
    let buf = '';
    let tail = '';
    let lastEmit = 0;
    child.stderr.on('data', (d) => { tail = (tail + d.toString()).slice(-800); state.errorTail = tail; });
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        const m = line.match(/^out_time_us=(\d+)/) || line.match(/^out_time_ms=(\d+)/);
        if (m && state.durationSec > 0) {
          state.convertedSec = Number(m[1]) / 1e6;
          state.progress = Math.min(99, Math.round((state.convertedSec / state.durationSec) * 100));
          const now = Date.now();
          if (now - lastEmit >= 500) { lastEmit = now; emit(state); }
        } else if (line === 'progress=end') {
          state.progress = 99;
        }
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg 退出码 ${code}${state.errorTail ? `：${state.errorTail.split('\n').pop()}` : ''}`));
    });
  });
}

/** 合封：HLS 分片 -c copy 包成正式 MP4（+faststart），时长校验通过才 rename 入库 */
async function finalizeMp4(state) {
  const tmpPath = path.join(state.dir, 'final.mp4');
  await new Promise((resolve, reject) => {
    const child = spawn('ffmpeg',
      ['-y', '-v', 'error', '-i', state.playlistPath, '-c', 'copy', '-movflags', '+faststart', tmpPath],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    state.finalizeChild = child;
    if (state.cancelRequested) {
      try { child.kill('SIGKILL'); } catch { /* noop */ }
    }
    let tail = '';
    child.stderr.on('data', (d) => { tail = (tail + d.toString()).slice(-800); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`合封 MP4 失败：ffmpeg 退出码 ${code}${tail ? `：${tail.split('\n').pop()}` : ''}`));
    });
  });

  // 时长校验（容差 max(2s, 2%)）：时间轴异常的产物宁可失败也不入库
  let outDuration = 0;
  try { outDuration = (await probeMedia(tmpPath)).durationSec; } catch { /* 探测失败不阻断：产物本体仍可用 */ }
  const expect = state.durationSec;
  if (expect > 0 && outDuration > 0 && Math.abs(outDuration - expect) > Math.max(2, expect * 0.02)) {
    try { fs.rmSync(tmpPath, { force: true }); } catch { /* noop */ }
    throw new Error(`合封产物时长异常（源 ${expect.toFixed(1)}s / 产物 ${outDuration.toFixed(1)}s），已丢弃`);
  }
  fs.renameSync(tmpPath, state.outputPath);
}

/** 会话移除：注销登记 + 可选删除分片目录 */
function removeSession(streamId, { deleteDir = false } = {}) {
  const s = sessions.get(streamId);
  if (!s) return;
  sessions.delete(streamId);
  if (fileIndex.get(fileKey(s.owner, s.name)) === streamId) fileIndex.delete(fileKey(s.owner, s.name));
  if (deleteDir) {
    try { fs.rmSync(s.dir, { recursive: true, force: true }); } catch { /* 清理失败忽略 */ }
  }
}

/** 取消会话：终止 ffmpeg（含合封子进程），close 回调统一置 cancelled */
export function cancelSession(streamId) {
  const s = sessions.get(streamId);
  if (!s || !ACTIVE_STATUSES.has(s.status)) return false;
  s.cancelRequested = true;
  try { s.child?.kill('SIGKILL'); } catch { /* noop */ }
  try { s.finalizeChild?.kill('SIGKILL'); } catch { /* noop */ }
  return true;
}

/** 定时清理：结束态会话超龄后删除分片目录并注销（由 index.js 每分钟调用） */
export function sweepSessions() {
  const now = Date.now();
  for (const [id, s] of [...sessions]) {
    if (ACTIVE_STATUSES.has(s.status)) continue;
    const grace = s.status === 'done' ? CLEANUP_GRACE_DONE_MS : CLEANUP_GRACE_SHORT_MS;
    if (now - Math.max(s.updatedAt, s.lastAccessAt) > grace) removeSession(id, { deleteDir: true });
  }
}

/** 启动时清理孤儿分片目录（上次进程残留；点开头目录，不入库不影响库扫描） */
export function cleanupOrphanDirs(downloadsRoot) {
  let users = [];
  try { users = fs.readdirSync(downloadsRoot, { withFileTypes: true }); } catch { return; }
  for (const ent of users) {
    if (!ent.isDirectory()) continue;
    const streamRoot = path.join(downloadsRoot, ent.name, '.vd-stream');
    let dirs = [];
    try { dirs = fs.readdirSync(streamRoot); } catch { continue; }
    for (const d of dirs) {
      try { fs.rmSync(path.join(streamRoot, d), { recursive: true, force: true }); } catch { /* noop */ }
    }
    try { fs.rmdirSync(streamRoot); } catch { /* noop */ }
  }
}

/** 优雅关闭：终止所有运行中的转换子进程（防僵尸 ffmpeg） */
export function cancelAllSessions() {
  for (const s of sessions.values()) {
    if (!ACTIVE_STATUSES.has(s.status)) continue;
    s.cancelRequested = true;
    try { s.child?.kill('SIGKILL'); } catch { /* noop */ }
    try { s.finalizeChild?.kill('SIGKILL'); } catch { /* noop */ }
  }
}
