/**
 * 下载调度器 — 调用 N_m3u8DL-RE（优先）或 ffmpeg（回退）下载视频
 */

import { spawn, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DOWNLOADS_DIR = path.resolve(process.cwd(), 'downloads');

// 确保下载目录存在
if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

/**
 * 启动下载任务
 * @param {string} m3u8Url   - m3u8 地址
 * @param {object} headers   - 请求头（Referer、Origin 等）
 * @param {string} taskId    - 任务 ID
 * @param {function} onProgress - 进度回调 ({ percent: number, speed: string, message: string })
 * @returns {Promise<string>} 输出文件路径
 */
export function startDownload(m3u8Url, headers, taskId, onProgress) {
  return new Promise((resolve, reject) => {
    // 构建文件名：taskId + 时间戳
    const outputName = `${taskId}_${Date.now()}`;
    const outputPath = path.join(DOWNLOADS_DIR, outputName);

    // ── 方案 A：N_m3u8DL-RE（首选）──────────────────
    const n_m3u8dl_re_path = which('N_m3u8DL-RE');
    if (n_m3u8dl_re_path) {
      downloadWithN_m3u8DL_RE(m3u8Url, headers, outputPath, taskId, onProgress, n_m3u8dl_re_path)
        .then(resolve)
        .catch(reject);
      return;
    }

    // ── 方案 B：ffmpeg 回退 ─────────────────────────
    if (which('ffmpeg')) {
      downloadWithFFmpeg(m3u8Url, headers, outputPath, taskId, onProgress)
        .then(resolve)
        .catch(reject);
      return;
    }

    reject(new Error(
      '未找到下载工具。请安装 N_m3u8DL-RE 或 ffmpeg：\n' +
      '  N_m3u8DL-RE: https://github.com/nilaoda/N_m3u8DL-RE/releases\n' +
      '  ffmpeg: sudo apt install ffmpeg'
    ));
  });
}

/**
 * 清理 N_m3u8DL-RE 下载后残留的临时碎片目录
 * N_m3u8DL-RE 会在 --save-dir 下生成 ${save-name}_tmp/ 目录存放 .ts 碎片
 * 下载完成后这些碎片已无用途，应彻底删除
 */
function cleanupTempDir(outputPath) {
  const saveName = path.basename(outputPath);
  // N_m3u8DL-RE 的临时目录命名格式：${save-name}_tmp/
  const tmpDir = path.join(DOWNLOADS_DIR, `${saveName}_tmp`);
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log(`[Cleanup] 已删除临时碎片目录: ${tmpDir}`);
  }
}

// ── N_m3u8DL-RE 下载实现 ──────────────────────────
function downloadWithN_m3u8DL_RE(m3u8Url, headers, outputPath, taskId, onProgress, binPath) {
  return new Promise((resolve, reject) => {
    const args = [
      m3u8Url,
      '--save-dir', DOWNLOADS_DIR,
      '--save-name', path.basename(outputPath),
      '--thread-count', '4',
      '--auto-select',
      '--no-log',
    ];

    // 添加请求头
    if (headers?.referer) args.push('--header', `Referer:${headers.referer}`);
    if (headers?.origin) args.push('--header', `Origin:${headers.origin}`);

    onProgress({ percent: 0, speed: null, message: '启动 N_m3u8DL-RE 下载...' });

    // 使用 which() 返回的完整路径，避免子进程 PATH 不含 ~/bin 导致 ENOENT
    const proc = spawn(binPath || 'N_m3u8DL-RE', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let lastPercent = 0;

    proc.stdout.on('data', (data) => {
      const text = data.toString();
      // 解析 N_m3u8DL-RE 输出：典型的进度格式
      // 如 "Downloaded 45.2% 12.3MB/s"
      const percentMatch = text.match(/(\d+\.?\d*)%/);
      const speedMatch = text.match(/([\d.]+)\s*(MB|KB|GB)\/s/i);

      if (percentMatch) {
        const percent = parseFloat(percentMatch[1]);
        if (percent > lastPercent) {
          lastPercent = percent;
          onProgress({
            percent: Math.round(percent),
            speed: speedMatch ? `${speedMatch[1]} ${speedMatch[2]}/s` : null,
            message: text.trim().slice(0, 200),
          });
        }
      }
    });

    proc.stderr.on('data', (data) => {
      const text = data.toString();
      // N_m3u8DL-RE 有时把进度打 stderr
      const percentMatch = text.match(/(\d+\.?\d*)%/);
      if (percentMatch) {
        const percent = parseFloat(percentMatch[1]);
        if (percent > lastPercent) {
          lastPercent = percent;
          onProgress({ percent: Math.round(percent), speed: null, message: text.trim().slice(0, 200) });
        }
      }
    });

    proc.on('close', (code) => {
      if (code === 0) {
        // 查找输出文件（N_m3u8DL-RE 会自动加 .mp4 后缀）
        const mp4Path = `${outputPath}.mp4`;
        const tsPath = `${outputPath}.ts`;
        const finalPath = fs.existsSync(mp4Path) ? mp4Path : fs.existsSync(tsPath) ? tsPath : outputPath;

        // ✅ 清理临时碎片目录（合成 mp4 后删除 .ts 碎片）
        cleanupTempDir(outputPath);

        onProgress({ percent: 100, speed: null, message: '下载完成！' });
        resolve(finalPath);
      } else {
        reject(new Error(`N_m3u8DL-RE 退出码 ${code}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`启动 N_m3u8DL-RE 失败: ${err.message}`));
    });

    // 保存 proc 引用，支持取消（通过 taskManager）
    activeProcesses.set(taskId, proc);
  });
}

// ── ffmpeg 回退下载 ─────────────────────────────
function downloadWithFFmpeg(m3u8Url, headers, outputPath, taskId, onProgress) {
  return new Promise((resolve, reject) => {
    const args = [];

    // 安全构建 -headers 参数，仅在 referer 存在时添加
    if (headers?.referer) {
      args.push('-headers', `Referer: ${headers.referer}`);
    }

    args.push(
      '-i', m3u8Url,
      '-c', 'copy',
      '-bsf:a', 'aac_adtstoasc',
      '-progress', 'pipe:1',
      '-nostats',
      '-y',
      `${outputPath}.mp4`,
    );

    onProgress({ percent: 0, speed: null, message: '启动 ffmpeg 下载...' });

    const proc = spawn('ffmpeg', args.filter(Boolean), { stdio: ['ignore', 'pipe', 'pipe'] });

    proc.stdout.on('data', (data) => {
      const text = data.toString();
      // ffmpeg -progress 输出 time=... 格式
      const timeMatch = text.match(/out_time=(\d+):(\d+):(\d+)/);
      if (timeMatch) {
        const seconds = (+timeMatch[1] * 3600) + (+timeMatch[2] * 60) + (+timeMatch[3]);
        // 粗略进度（无法知道总时长，所以用简单脉冲）
        onProgress({
          percent: Math.min(99, Math.floor(seconds / 10)),
          speed: null,
          message: `已下载 ${timeMatch[1]}:${timeMatch[2]}:${timeMatch[3]}`,
        });
      }
    });

    proc.on('close', (code) => {
      if (code === 0) {
        onProgress({ percent: 100, speed: null, message: '下载完成！' });
        resolve(`${outputPath}.mp4`);
      } else {
        reject(new Error(`ffmpeg 退出码 ${code}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`启动 ffmpeg 失败: ${err.message}`));
    });

    activeProcesses.set(taskId, proc);
  });
}

// 活跃进程表（用于取消任务）
const activeProcesses = new Map();

/**
 * 取消下载任务
 */
export function cancelDownload(taskId) {
  const proc = activeProcesses.get(taskId);
  if (proc) {
    proc.kill('SIGTERM');
    activeProcesses.delete(taskId);
    return true;
  }
  return false;
}

/**
 * 增强版 which 实现
 * 除了标准 PATH 检查，还额外扫描用户级 bin 目录（~/bin、~/.local/bin 等）
 * 解决 execSync 子进程不加载 shell rc 文件导致的 PATH 不完整问题
 *
 * @param {string} cmd - 命令名
 * @returns {string|false} 返回完整路径（可用作 spawn 的第一个参数），找不到返回 false
 */
function which(cmd) {
  // 方式1：标准 PATH 检查
  try {
    const output = execSync(`which ${cmd}`, { stdio: ['ignore', 'pipe', 'ignore'] });
    const fullPath = output.toString().trim().split('\n')[0];
    if (fullPath && fs.existsSync(fullPath)) {
      return fullPath;
    }
  } catch {
    // 继续到方式2
  }

  // 方式2：直接检查常见用户 bin 目录
  const homeDir = os.homedir();
  const userBinDirs = [
    path.join(homeDir, 'bin'),
    path.join(homeDir, '.local', 'bin'),
    path.join(homeDir, '.cargo', 'bin'),
  ];
  for (const dir of userBinDirs) {
    const fullPath = path.join(dir, cmd);
    if (fs.existsSync(fullPath)) {
      return fullPath;
    }
  }
  return false;
}