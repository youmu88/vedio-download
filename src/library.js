/**
 * 视频库扫描与路径解析 —— 单一抽象
 *
 * 为什么独立成模块（20261024 缺陷根因）：
 *   原 /api/library 用 fs.readdirSync 只扫账号目录一层，且 filter 要求 stat.isFile()，
 *   子目录被整棵丢弃 → 手工拷贝到 downloads/<账号>/子文件夹/ 的视频永远不可见。
 *   同一「name 就是单层文件名」的假设还散落在删除/转码/媒体探测三处（各自 path.basename），
 *   一旦 name 变成相对路径就会「看得到、删不掉、转不了」。因此把「扫描」与「name → 绝对路径解析」
 *   收敛到本模块，index.js 的四个路由共用同一套规则（含越界/穿越校验）。
 *
 * name 语义（唯一约定）：相对账号目录的 POSIX 路径，如 `子目录/视频.mp4`；
 *   顶层文件即 `视频.mp4`。收藏列表条目名使用同一语义。
 */

import fs from 'fs';
import path from 'path';

/**
 * 视频库扩展名白名单：列出「浏览器可直接播放」或「服务端可边转边播」的媒体格式。
 * ⚠️ 必须覆盖前端 TRANSCODE_EXTS（public/js/player-core.js:248），否则会出现
 *    「前端有转码入口、后端不入库」的割裂 —— 手工拷贝的 .avi/.flv/.wmv/.mpg/.ts 永远不可见。
 * 本集合同时作为 fs.watch 变更事件的过滤依据（非白名单文件变更不触发刷新推送）。
 */
export const VIDEO_EXTS = new Set([
  '.mp4', '.webm', '.mkv', '.mov', '.m3u8',
  '.avi', '.flv', '.wmv', '.m4v', '.mpg', '.mpeg', '.ts', '.3gp', '.vob',
]);

/** 递归扫描深度上限（= name 的最大路径段数；1 = 仅账号目录顶层） */
export const MAX_LIBRARY_DEPTH = 6;

/** 下载临时文件：X.part（旧形态）与 X.part.mp4（直链断点续传写盘形态）、X.tmp */
function isTempFile(name) {
  return /\.part($|\.)/i.test(name) || /\.tmp$/i.test(name);
}

/** 单个路径段合法性：非空、非 . / ..、无分隔符与控制字符 */
function isSafeSegment(seg) {
  return Boolean(seg) && seg !== '.' && seg !== '..' && !seg.includes('\\') && !seg.includes('\0');
}

/**
 * 把前端传入的 name（相对账号目录的 POSIX 路径）解析为绝对路径。
 * 拒绝：空、绝对路径、反斜杠、空段 / `.` / `..`、超过深度上限、解析后越出账号目录。
 * @param {string} userDir 账号下载目录（绝对路径）
 * @param {string} name 相对路径
 * @returns {{ absPath: string, relName: string } | null}
 */
export function resolveUserFile(userDir, name) {
  const raw = String(name ?? '');
  if (!raw || raw.includes('\\') || raw.includes('\0') || path.isAbsolute(raw)) return null;
  const segments = raw.split('/');
  if (segments.length > MAX_LIBRARY_DEPTH) return null;
  if (!segments.every(isSafeSegment)) return null;
  const root = path.resolve(userDir);
  const absPath = path.resolve(root, ...segments);
  if (absPath !== root && !absPath.startsWith(root + path.sep)) return null;
  return { absPath, relName: segments.join('/') };
}

/**
 * 递归列出账号目录内可入库的视频（含子目录，深度上限 MAX_LIBRARY_DEPTH）。
 * 过滤：隐藏文件/目录（含 .vd-stream 等点开头目录）、符号链接（防环/越界）、
 *       非常规文件、白名单外扩展名、下载临时文件、调用方自定义排除项。
 * @param {string} userDir 账号下载目录
 * @param {{ isExcluded?: (rel: string, base: string) => boolean }} [opts]
 * @returns {{ name: string, size: number, mtime: number }[]} 按 mtime 倒序
 */
export function listLibraryFiles(userDir, { isExcluded = null } = {}) {
  const root = path.resolve(userDir);
  const out = [];
  const walk = (dir, prefix, depth) => {
    if (depth > MAX_LIBRARY_DEPTH) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const base = ent.name;
      if (base.startsWith('.')) continue;                 // 隐藏文件/目录 + .vd-stream
      if (ent.isSymbolicLink()) continue;                 // 符号链接：不跟进（防环 / 越出账号目录）
      const rel = prefix ? `${prefix}/${base}` : base;
      if (ent.isDirectory()) {
        walk(path.join(dir, base), rel, depth + 1);
        continue;
      }
      if (!ent.isFile()) continue;
      if (!VIDEO_EXTS.has(path.extname(base).toLowerCase())) continue;
      if (isTempFile(base)) continue;
      if (isExcluded && isExcluded(rel, base)) continue;
      let stat;
      try { stat = fs.statSync(path.join(dir, base)); } catch { continue; }
      out.push({ name: rel, size: stat.size, mtime: stat.mtimeMs });
    }
  };
  walk(root, '', 1);
  return out.sort((a, b) => b.mtime - a.mtime);
}
