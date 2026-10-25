/**
 * 视频库扫描与路径解析单测（src/library.js）
 *
 * 缺陷回归（20261024）：/api/library 原用 fs.readdirSync 只扫一层 + stat.isFile() 过滤目录，
 * 手工拷贝到 downloads/<账号>/子文件夹/ 的视频永远不可见；删除/转码/媒体探测各自 path.basename
 * 只认单层文件名。本文件锁定「相对路径 name」的统一语义与安全边界。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VIDEO_EXTS, MAX_LIBRARY_DEPTH, resolveUserFile, listLibraryFiles } from '../src/library.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vd-libscan-'));
}

function writeFile(root, rel, bytes = 16) {
  const p = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(bytes, 1));
  return p;
}

function namesOf(root, opts) {
  return listLibraryFiles(root, opts).map((f) => f.name);
}

test('resolveUserFile：合法相对路径 → 账号目录内绝对路径 + POSIX 相对名', () => {
  const root = tmpDir();
  try {
    assert.deepEqual(resolveUserFile(root, 'a.mp4'), {
      absPath: path.join(root, 'a.mp4'),
      relName: 'a.mp4',
    });
    assert.deepEqual(resolveUserFile(root, '子目录/更深/b.mkv'), {
      absPath: path.join(root, '子目录', '更深', 'b.mkv'),
      relName: '子目录/更深/b.mkv',
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveUserFile：拒绝穿越 / 绝对路径 / 反斜杠 / 空段 / 超深', () => {
  const root = tmpDir();
  try {
    const bad = [
      '', '/etc/passwd', '../x.mp4', 'a/../../x.mp4', 'a//b.mp4', 'a/./b.mp4',
      'a\\b.mp4', '.', '..', 'a/..', 'a/b/../../../x.mp4',
    ];
    for (const name of bad) {
      assert.equal(resolveUserFile(root, name), null, `应拒绝: ${JSON.stringify(name)}`);
    }
    const tooDeep = Array.from({ length: MAX_LIBRARY_DEPTH }, (_, i) => `d${i}`).join('/') + '/x.mp4';
    assert.equal(resolveUserFile(root, tooDeep), null, `超过 ${MAX_LIBRARY_DEPTH} 段应拒绝`);
    const maxOk = Array.from({ length: MAX_LIBRARY_DEPTH - 1 }, (_, i) => `d${i}`).join('/') + '/x.mp4';
    assert.ok(resolveUserFile(root, maxOk), `恰好 ${MAX_LIBRARY_DEPTH} 段应允许`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('listLibraryFiles：递归列出子目录视频，name 为相对 POSIX 路径', () => {
  const root = tmpDir();
  try {
    writeFile(root, '顶层.mp4');
    writeFile(root, '子目录/视频.mkv');
    writeFile(root, '子目录/更深/三级.webm');
    const names = namesOf(root);
    assert.deepEqual(new Set(names), new Set(['顶层.mp4', '子目录/视频.mkv', '子目录/更深/三级.webm']));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test(`listLibraryFiles：深度上限 ${MAX_LIBRARY_DEPTH} 层（第 ${MAX_LIBRARY_DEPTH} 层可见，第 ${MAX_LIBRARY_DEPTH + 1} 层不可见）`, () => {
  const root = tmpDir();
  try {
    const visible = Array.from({ length: MAX_LIBRARY_DEPTH - 1 }, (_, i) => `d${i}`).join('/') + '/ok.mp4';
    const hidden = Array.from({ length: MAX_LIBRARY_DEPTH }, (_, i) => `d${i}`).join('/') + '/deep.mp4';
    writeFile(root, visible);
    writeFile(root, hidden);
    const names = namesOf(root);
    assert.ok(names.includes(visible), `${MAX_LIBRARY_DEPTH} 段路径应可见: ${visible}（实际 ${JSON.stringify(names)}）`);
    assert.ok(!names.includes(hidden), `${MAX_LIBRARY_DEPTH + 1} 段路径不应可见: ${hidden}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('listLibraryFiles：隐藏目录/隐藏文件/符号链接/临时文件/非视频均被排除', () => {
  const root = tmpDir();
  try {
    writeFile(root, '正常.mp4');
    writeFile(root, '.hidden/隐藏目录.mp4');
    writeFile(root, '.隐藏文件.mp4');
    writeFile(root, '子目录/.cache/缓存.mp4');
    writeFile(root, '断点.part.mp4');
    writeFile(root, '旧临时.part');
    writeFile(root, '说明.txt');
    // 符号链接（指向真实目录）：不跟进
    const realDir = path.join(root, '真实目录');
    fs.mkdirSync(realDir, { recursive: true });
    fs.writeFileSync(path.join(realDir, '链接内视频.mp4'), Buffer.alloc(16));
    try { fs.symlinkSync(realDir, path.join(root, '链接目录')); } catch { /* 平台不支持则跳过该断言 */ }
    const names = namesOf(root);
    assert.ok(names.includes('正常.mp4'));
    assert.ok(!names.some((n) => n.startsWith('.')), `隐藏文件/目录不应出现: ${JSON.stringify(names)}`);
    assert.ok(!names.some((n) => n.includes('.cache')), '子目录内隐藏目录不应出现');
    assert.ok(!names.some((n) => n.includes('.part')), '下载临时文件不应出现');
    assert.ok(!names.includes('说明.txt'), '白名单外扩展名不应出现');
    if (fs.existsSync(path.join(root, '链接目录'))) {
      assert.ok(!names.some((n) => n.startsWith('链接目录/')), '符号链接目录不应被跟进');
    }
    assert.ok(names.includes('真实目录/链接内视频.mp4'), '真实目录内的视频应正常出现');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('VIDEO_EXTS：覆盖前端可转码格式（前后端口径一致）', () => {
  // 前端 TRANSCODE_EXTS（public/js/player-core.js）：.mkv/.ts/.avi/.wmv/.flv/.mpg/.mpeg/.vob/.3gp
  for (const ext of ['.mkv', '.ts', '.avi', '.wmv', '.flv', '.mpg', '.mpeg', '.vob', '.3gp']) {
    assert.ok(VIDEO_EXTS.has(ext), `后端白名单必须覆盖前端可转码格式: ${ext}`);
  }
  for (const ext of ['.mp4', '.webm', '.mov', '.m3u8', '.m4v']) {
    assert.ok(VIDEO_EXTS.has(ext), `应有格式: ${ext}`);
  }
  for (const ext of ['.txt', '.zip', '.srt', '.json', '.jpg']) {
    assert.ok(!VIDEO_EXTS.has(ext), `非媒体格式不应入库: ${ext}`);
  }
});

test('listLibraryFiles：isExcluded 回调生效（运行中任务 / 已入列表过滤复用点）', () => {
  const root = tmpDir();
  try {
    writeFile(root, 'a.mp4');
    writeFile(root, '子/x.mp4');
    const names = namesOf(root, { isExcluded: (rel, base) => rel === 'a.mp4' || base === 'x.mp4' });
    assert.deepEqual(names, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('listLibraryFiles：按 mtime 倒序（最新在前）', () => {
  const root = tmpDir();
  try {
    const oldP = writeFile(root, 'old.mp4');
    const newP = writeFile(root, 'new.mp4');
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(oldP, past, past);
    const names = namesOf(root);
    assert.deepEqual(names, ['new.mp4', 'old.mp4']);
    assert.ok(fs.statSync(newP).mtimeMs > fs.statSync(oldP).mtimeMs);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
