/**
 * MKV 转码修复 — 集成测试（服务端转码管线 + 互斥 + 防穿越 + socket 进度推送）
 *
 * 覆盖（对 src/index.js POST /api/transcode 与 src/transcode.js）：
 *   ⑤ 转码链路：POST /api/transcode → transcode-status（user 房间推送）→ 产物 <原名>.mp4 入库
 *   ⑥ 重复转码互斥：产物已存在/运行中重复提交 → 409
 *   ⑦ 路径穿越防护：../ 等非法 name 被拒绝
 *
 * ffmpeg 探测契约：`ffmpeg -version` 可用则跑真实断言；不可用则 t.skip（不失败）。
 *
 * 运行：node --test test/transcode.test.js
 * 基建与 test/library.test.js 同款：子进程启动服务、VD_DATA_DIR/VD_DOWNLOADS_DIR 隔离、
 * 手写 engine.io/socket.io v4 握手帧、轮询 deadline 不用固定 sleep。
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(REPO_ROOT, 'src', 'index.js');

const SAMPLE_MKV = 'transcode-sample.mkv';
const OUTPUT_MP4 = 'transcode-sample.mp4';

// ─── 共享夹具状态 ────────────────────────────────────
let tmpRoot = null;
let child = null;
let port = 0;
let token = null;
let username = null;
let userDir = null;
let ffmpegOk = false;
let childLogTail = '';

// ─── 小工具（与 library.test.js 保持同构） ───────────
function randPort() {
  return 21000 + Math.floor(Math.random() * 20000);
}

async function api(method, p, { authToken, body } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: {
      ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function waitFor(fn, { timeoutMs, intervalMs = 100, label = '条件' }) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`等待超时（${timeoutMs}ms）：${label}${lastErr ? `，最后错误：${lastErr.message}` : ''}`);
}

async function listLibrary() {
  const { status, json } = await api('GET', '/api/library', { authToken: token });
  assert.equal(status, 200, `/api/library 应返回 200，实际 ${status}: ${JSON.stringify(json)}`);
  assert.ok(Array.isArray(json), '/api/library 应返回文件数组');
  return json.map((f) => f.name);
}

async function openSocketIO(authToken, { timeoutMs = 8000 } = {}) {
  const frames = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* noop */ }
      reject(new Error('socket.io 握手超时'));
    }, timeoutMs);
    ws.addEventListener('message', (ev) => {
      const data = typeof ev.data === 'string' ? ev.data : String(ev.data);
      if (data.startsWith('42')) frames.push(data);
      else if (data.startsWith('0')) ws.send('40' + JSON.stringify({ token: authToken }));
      else if (data.startsWith('40')) { clearTimeout(timer); resolve(); }
      else if (data.startsWith('2')) ws.send('3');
    });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('WebSocket 连接失败')); });
  });
  return { ws, frames };
}

function probeFfmpegBin() {
  return new Promise((resolve) => {
    execFile('ffmpeg', ['-version'], { timeout: 5000 }, (err) => resolve(!err));
  });
}

/** 用 ffmpeg lavfi 生成一个 0.6s 的 H.264/AAC MKV 样本（走 remux 快速管线，产物确定性高） */
function makeSampleMkv(dest) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'testsrc=duration=0.6:size=160x120:rate=12',
      '-f', 'lavfi', '-i', 'sine=duration=0.6:frequency=440',
      '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
      dest,
    ], { timeout: 30000 }, (err, _stdout, stderr) => {
      if (err) return reject(new Error(`生成 MKV 样本失败: ${err.message}\n${String(stderr).slice(-400)}`));
      resolve();
    });
  });
}

async function spawnServer(attempt = 0) {
  port = randPort();
  const c = spawn(process.execPath, [ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      VD_DATA_DIR: path.join(tmpRoot, 'data'),
      VD_DOWNLOADS_DIR: path.join(tmpRoot, 'downloads'),
      AUTO_START_QUEUE: '0',
      ALLOWED_ORIGINS: '*',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  c.stdout.on('data', (d) => { childLogTail = (childLogTail + d).slice(-4000); });
  c.stderr.on('data', (d) => { childLogTail = (childLogTail + d).slice(-4000); });
  try {
    await waitFor(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`);
        return res.ok;
      } catch {
        return false;
      }
    }, { timeoutMs: 15000, intervalMs: 200, label: `服务启动（端口 ${port}）` });
  } catch (err) {
    try { c.kill('SIGKILL'); } catch { /* noop */ }
    if (attempt === 0) return spawnServer(1);
    throw new Error(`服务启动失败：${err.message}\n子进程日志尾部：\n${childLogTail}`);
  }
  return c;
}

// ─── 装配 / 拆卸 ────────────────────────────────────
before(async () => {
  ffmpegOk = await probeFfmpegBin();
  if (!ffmpegOk) return; // 无 ffmpeg 环境：用例在 test 体内 t.skip，不装配服务

  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vd-transcode-'));
  fs.mkdirSync(path.join(tmpRoot, 'downloads'), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, 'data'), { recursive: true });
  username = `vd_transtest_${Date.now().toString(36)}`;

  child = await spawnServer();

  const reg = await api('POST', '/api/auth/register', { body: { username, password: 'transtest-pass' } });
  assert.equal(reg.status, 200, `注册测试用户失败: ${JSON.stringify(reg.json)}`);
  const login = await api('POST', '/api/auth/login', { body: { username, password: 'transtest-pass' } });
  assert.equal(login.status, 200, `登录测试用户失败: ${JSON.stringify(login.json)}`);
  token = login.json.token;
  assert.ok(token, '登录应返回 token');

  // 探测服务实际生效的 downloads 根（VD_DOWNLOADS_DIR 生效 → 临时目录）
  const tmpCandidate = path.join(tmpRoot, 'downloads', username);
  const repoCandidate = path.join(REPO_ROOT, 'downloads', username);
  if (fs.existsSync(tmpCandidate)) userDir = tmpCandidate;
  else if (fs.existsSync(repoCandidate)) userDir = repoCandidate;
  else throw new Error(`无法定位服务生效的用户下载目录（${tmpCandidate} 与 ${repoCandidate} 均不存在）`);

  await makeSampleMkv(path.join(userDir, SAMPLE_MKV));
});

after(async () => {
  if (child) {
    try { child.kill('SIGTERM'); } catch { /* noop */ }
    const exited = await waitFor(async () => child.exitCode !== null || child.killed, {
      timeoutMs: 3000, intervalMs: 100, label: '子进程退出',
    }).catch(() => false);
    if (!exited) { try { child.kill('SIGKILL'); } catch { /* noop */ } }
  }
  try { if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* noop */ }
  if (userDir && userDir.startsWith(path.join(REPO_ROOT, 'downloads'))) {
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

// ─── ⑤ 转码链路：POST → transcode-status 推送 → 产物入库 ──
test('⑤ MKV 转码：POST /api/transcode 后产物 MP4 入库且经 socket 推送进度', async (t) => {
  if (!ffmpegOk) return t.skip('未检测到 ffmpeg，跳过转码断言');
  const { ws, frames } = await openSocketIO(token);
  try {
    const res = await api('POST', '/api/transcode', { authToken: token, body: { name: SAMPLE_MKV } });
    assert.equal(res.status, 200, `POST /api/transcode 应返回 200，实际 ${res.status}: ${JSON.stringify(res.json)}`);
    assert.equal(res.json.output, OUTPUT_MP4, '响应应声明转码产物名 <原名>.mp4');

    // socket 推送（user 房间定向）：等待 done 帧
    await waitFor(() => frames.some((f) => {
      if (!f.startsWith('42["transcode-status",')) return false;
      try { return JSON.parse(f.slice(2))[1]?.status === 'done'; } catch { return false; }
    }), { timeoutMs: 30000, intervalMs: 150, label: 'transcode-status done 事件' });
    const doneFrame = frames.find((f) => {
      if (!f.startsWith('42["transcode-status",')) return false;
      try { return JSON.parse(f.slice(2))[1]?.status === 'done'; } catch { return false; }
    });
    assert.ok(doneFrame, '应存在 status=done 的 transcode-status 帧');
    const payload = JSON.parse(doneFrame.slice(2))[1];
    assert.equal(payload.owner, username, 'transcode-status 应定向推送给文件所属用户');
    assert.equal(payload.output, OUTPUT_MP4, 'done 事件应携带产物名');
    assert.equal(payload.progress, 100, 'done 事件进度应为 100');

    // 产物自动进入视频库（白名单 .mp4），源 MKV 仍在库中
    const names = await waitFor(async () => {
      const list = await listLibrary();
      return list.includes(OUTPUT_MP4) ? list : null;
    }, { timeoutMs: 30000, intervalMs: 250, label: `产物 ${OUTPUT_MP4} 出现在 /api/library` });
    assert.ok(names.includes(SAMPLE_MKV), '源 MKV 仍应在视频库中（白名单内）');
  } finally {
    try { ws.close(); } catch { /* noop */ }
  }
});

// ─── ⑥ 重复转码互斥 ─────────────────────────────────
test('⑥ 重复转码互斥：产物已存在时再次提交应被 409 拒绝', async (t) => {
  if (!ffmpegOk) return t.skip('未检测到 ffmpeg，跳过转码断言');
  const res = await api('POST', '/api/transcode', { authToken: token, body: { name: SAMPLE_MKV } });
  assert.equal(res.status, 409, `重复转码应被 409 拒绝，实际 ${res.status}: ${JSON.stringify(res.json)}`);
});

// ─── ⑦ 路径穿越防护 ─────────────────────────────────
test('⑦ 转码接口路径穿越防护：../ 与反斜杠路径被拒绝', async (t) => {
  if (!ffmpegOk) return t.skip('未检测到 ffmpeg，跳过转码断言');
  const dotdot = await api('POST', '/api/transcode', { authToken: token, body: { name: '../other-user/secret.mkv' } });
  assert.ok([400, 404].includes(dotdot.status),
    `../ 穿越应被拒绝（400/404），实际 ${dotdot.status}: ${JSON.stringify(dotdot.json)}`);
  assert.notEqual(dotdot.status, 200, '穿越请求不得成功');
  const backslash = await api('POST', '/api/transcode', { authToken: token, body: { name: '..\\..\\evil.mkv' } });
  assert.equal(backslash.status, 400, `反斜杠路径应被 400 拒绝，实际 ${backslash.status}`);
});
