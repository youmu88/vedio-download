/**
 * 转码模块 — MKV 等浏览器无法直接播放的容器 → H.264/AAC MP4
 *
 * 管线：ffprobe 探测音视频编码 →
 *   H.264/AAC（或无音频轨）→ ffmpeg -c copy remux（秒级，零质量损失）
 *   其他编码              → ffmpeg libx264 + aac 转码（-preset veryfast -crf 23）
 *
 * 设计约束（与委派一致）：
 *   - 独立模块：不向 index.js 堆砌转码逻辑，index.js 仅做路由/鉴权/推送桥接；
 *   - 产物写入同一用户 downloads 目录（<原名>.mp4），扩展名在 /api/library 白名单内自动入库；
 *   - 进度经 onStatus 回调上抛，由 index.js 转发到 user:<owner> socket 房间（transcode-status）；
 *   - 运行中/重复转码互斥：同一 owner+name 仅允许一个运行中的转码；
 *   - 失败清理：ffmpeg 非零退出时删除半成品 mp4，避免坏文件入库。
 */

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

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

// ─── 转码状态登记：owner::name → state（运行中/重复转码互斥依据） ───
const transcodeStates = new Map();

function stateKey(owner, name) {
  return `${owner}::${name}`;
}

export function getTranscodeState(owner, name) {
  return transcodeStates.get(stateKey(owner, name)) || null;
}

export function isTranscoding(owner, name) {
  return getTranscodeState(owner, name)?.status === 'running';
}

/** 可直接 remux 的编码集合（H.264 视频 + AAC 音频/无音轨 → -c copy 秒级封装） */
const REMUXABLE_VIDEO = new Set(['h264']);

/** ffprobe 探测：音视频编码 + 总时长（进度百分比分母） */
function probeMedia(filePath) {
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

/** 对外状态快照（显式字段：排除 child 进程句柄，保证可安全经 socket 序列化） */
function publicState(state) {
  return {
    owner: state.owner,
    name: state.name,
    output: state.output,
    status: state.status,
    progress: state.progress,
    mode: state.mode,
    error: state.error,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
  };
}

/**
 * 启动转码（同步返回 state，内部异步执行；前置校验由 index.js 路由层完成）：
 *   - 同一文件已在转码中 → 抛错（路由层已用 isTranscoding 预检，此处兜底）；
 *   - onStatus 在状态变化时收到 publicState 快照（index.js 负责 socket 推送）。
 */
export function startTranscode({ owner, name, userDir, onStatus }) {
  if (isTranscoding(owner, name)) throw new Error('该文件正在转码中');

  const ext = path.extname(name);
  const inputPath = path.join(userDir, name);
  const outputName = name.slice(0, -ext.length) + '.mp4';
  const outputPath = path.join(userDir, outputName);

  const state = {
    owner, name, output: outputName,
    status: 'running', // running | done | failed
    progress: 0,
    mode: null,        // remux | transcode
    error: null,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    child: null,
    errorTail: '',
  };
  transcodeStates.set(stateKey(owner, name), state);

  const emit = () => {
    state.updatedAt = Date.now();
    try { onStatus?.(publicState(state)); } catch { /* 回调异常不影响转码本体 */ }
  };
  emit(); // 立即上抛 running（前端可即时反馈）

  (async () => {
    try {
      // 1. 编码探测 → 管线选择
      const media = await probeMedia(inputPath);
      const canRemux = REMUXABLE_VIDEO.has(media.videoCodec)
        && (!media.audioCodec || media.audioCodec === 'aac');
      state.mode = canRemux ? 'remux' : 'transcode';
      emit();

      // 2. 构造 ffmpeg 参数
      const args = ['-y', '-i', inputPath];
      if (canRemux) {
        args.push('-c', 'copy');
      } else {
        args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac');
      }
      args.push('-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', outputPath);

      // 3. 执行 + 进度解析
      await new Promise((resolve, reject) => {
        const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        state.child = child;
        let lastEmit = 0;
        let buf = '';
        let tail = '';
        child.stderr.on('data', (d) => { tail = (tail + d.toString()).slice(-800); state.errorTail = tail; });
        child.stdout.on('data', (d) => {
          buf += d.toString();
          let idx;
          while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            // out_time_us 优先；out_time_ms 在 ffmpeg 中历史上同样以微秒计（兼容旧版本）
            const m = line.match(/^out_time_us=(\d+)/) || line.match(/^out_time_ms=(\d+)/);
            if (m && media.durationSec > 0) {
              const outSec = Number(m[1]) / 1e6;
              state.progress = Math.min(99, Math.round((outSec / media.durationSec) * 100));
              const now = Date.now();
              if (now - lastEmit >= 500) { lastEmit = now; emit(); }
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

      state.status = 'done';
      state.progress = 100;
      emit();
    } catch (err) {
      state.status = 'failed';
      state.error = err.message;
      emit();
      // 失败清理：删除半成品 mp4，避免坏文件经白名单入库
      try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch { /* 清理失败忽略 */ }
    } finally {
      state.child = null;
    }
  })();

  return state;
}

/** 优雅关闭：终止所有运行中的转码子进程（防僵尸 ffmpeg） */
export function cancelAllTranscodes() {
  for (const state of transcodeStates.values()) {
    if (state.status === 'running' && state.child) {
      try { state.child.kill('SIGKILL'); } catch { /* noop */ }
    }
  }
}
