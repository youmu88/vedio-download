/**
 * 边转边播（流式转换） — 契约测试
 *
 * 覆盖（对 src/index.js 流式路由与 src/transcode.js 会话模块）：
 *   ⑬ 快路矩阵：H.264 + AC3 源 → mode='copy-audio'（视频直拷 + 音频 AAC），产物可播入库
 *   ⑭ 渐进产出：HEVC 源 → 播放列表先出现分片（ENDLIST 之前，边转边播成立）→ 分片可取
 *                → 转换完成 ENDLIST + 合封 MP4 入库
 *   ⑮ 鉴权与 token 重写：无 token 401 / 他人 token 404 / 播放列表分片行附 token
 *   ⑯ 取消会话：cancel → socket cancelled 帧 → 可重新启动新会话（旧会话让位）
 *   ⑰ 流式路由防护：非法 streamId / 非法分片名一律 404
 *
 * 运行：node --test test/stream.test.js
 * 基建与 transcode.test.js 同款：mkdtemp 隔离 VD_DATA_DIR/VD_DOWNLOADS_DIR、
 * 随机端口子进程起 src/index.js、AUTO_START_QUEUE=0；无 ffmpeg 环境各用例 t.skip。
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

// ─── 样本 ────────────────────────────────────────────
const SAMPLE_COPY = 'stream-copy.mkv';            // H.264 + AC3 → copy-audio 快路
const SAMPLE_COPY_MP4 = 'stream-copy.mp4';
const SAMPLE_PROG = 'stream-progress.mkv';        // HEVC + AAC 20s → 渐进产出观察窗
const SAMPLE_PROG_MP4 = 'stream-progress.mp4';
const SAMPLE_AUTH = 'stream-auth.mkv';            // 鉴权用例专用
const SAMPLE_CANCEL = 'stream-cancel.mkv';        // 取消用例专用
const SAMPLE_PROT = 'stream-prot.mkv';            // 路由防护用例专用

// ─── 共享夹具状态 ────────────────────────────────────
let tmpRoot = null;
let child = null;
let port = 0;
let token = null;
let token2 = null;
let username = null;
let username2 = null;
let userDir = null;
let ffmpegOk = false;
let libx265Ok = false;
let childLogTail = '';

// ─── 小工具（与 transcode.test.js 保持同构） ───────────
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

/** 解析 socket 帧为 transcode-status 载荷数组 */
function transcodePayloads(frames) {
  return frames
    .filter((f) => f.startsWith('42["transcode-status",'))
    .map((f) => { try { return JSON.parse(f.slice(2))[1]; } catch { return null; } })
    .filter(Boolean);
}

function probeBin(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) =>
      resolve(err ? null : String(stdout)));
  });
}

/** 生成指定时长样本（视频编码由 vcodec 决定；audio 参数如 '-c:a ac3 -ac 2'） */
function makeSample(dest, vcodec, seconds, audioArgs = ['-c:a', 'aac']) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', [
      '-y',
      '-f', 'lavfi', '-i', `testsrc=duration=${seconds}:size=320x240:rate=24`,
      '-f', 'lavfi', '-i', `sine=duration=${seconds}:frequency=440`,
      '-shortest', '-c:v', vcodec, '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', ...audioArgs,
      dest,
    ], { timeout: 90000 }, (err, _stdout, stderr) => {
      if (err) return reject(new Error(`生成样本失败（${vcodec}）: ${err.message}\n${String(stderr).slice(-400)}`));
      resolve();
    });
  });
}

function ffprobeJson(file) {
  return new Promise((resolve, reject) => {
    execFile('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file],
      { timeout: 15000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
        if (err) return reject(new Error(`ffprobe 失败: ${err.message}`));
        try { resolve(JSON.parse(stdout)); } catch (e) { reject(new Error(`ffprobe 输出解析失败: ${e.message}`)); }
      });
  });
}

/** 产物可播性契约：h264 视频 + aac 音频 + duration>0 */
function assertPlayableMp4(probe, label) {
  const video = (probe.streams || []).find((s) => s.codec_type === 'video');
  const audio = (probe.streams || []).find((s) => s.codec_type === 'audio');
  assert.ok(video, `${label}：ffprobe 应解析出视频流`);
  assert.equal(video.codec_name, 'h264', `${label}：产物视频流应为 h264，实际 ${video.codec_name}`);
  assert.ok(audio && audio.codec_name === 'aac', `${label}：产物应含 aac 音频流`);
  const dur = parseFloat(probe.format?.duration);
  assert.ok(dur > 0, `${label}：产物时长应 > 0，实际 ${dur}`);
}

/** 读取播放列表原文（服务端已把 token 重写进分片行） */
async function fetchPlaylist(streamId, authToken) {
  const q = authToken ? `?token=${encodeURIComponent(authToken)}` : '';
  const res = await fetch(`http://127.0.0.1:${port}/api/stream/${streamId}/index.m3u8${q}`);
  const text = res.ok ? await res.text() : null;
  return { status: res.status, text };
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
  ffmpegOk = !!(await probeBin('ffmpeg', ['-version']));
  if (ffmpegOk) {
    const encoders = await probeBin('ffmpeg', ['-hide_banner', '-encoders']);
    libx265Ok = !!encoders && /libx265/.test(encoders);
  }
  if (!ffmpegOk) return;

  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vd-stream-'));
  fs.mkdirSync(path.join(tmpRoot, 'downloads'), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, 'data'), { recursive: true });
  username = `vd_stream_${Date.now().toString(36)}`;
  username2 = `vd_stream2_${Date.now().toString(36)}`;

  child = await spawnServer();

  for (const u of [username, username2]) {
    const reg = await api('POST', '/api/auth/register', { body: { username: u, password: 'stream-pass' } });
    assert.equal(reg.status, 200, `注册测试用户失败: ${JSON.stringify(reg.json)}`);
  }
  const login = await api('POST', '/api/auth/login', { body: { username, password: 'stream-pass' } });
  assert.equal(login.status, 200, `登录测试用户失败: ${JSON.stringify(login.json)}`);
  token = login.json.token;
  const login2 = await api('POST', '/api/auth/login', { body: { username: username2, password: 'stream-pass' } });
  token2 = login2.json.token;

  const tmpCandidate = path.join(tmpRoot, 'downloads', username);
  const repoCandidate = path.join(REPO_ROOT, 'downloads', username);
  if (fs.existsSync(tmpCandidate)) userDir = tmpCandidate;
  else if (fs.existsSync(repoCandidate)) userDir = repoCandidate;
  else throw new Error(`无法定位服务生效的用户下载目录（${tmpCandidate} 与 ${repoCandidate} 均不存在）`);

  // H.264 + AC3（快路矩阵）、HEVC 20s（渐进/取消观察窗）、小样本（鉴权/防护）
  await makeSample(path.join(userDir, SAMPLE_COPY), 'libx264', 6, ['-c:a', 'ac3', '-ac', '2']);
  await makeSample(path.join(userDir, SAMPLE_AUTH), 'libx264', 4);
  await makeSample(path.join(userDir, SAMPLE_PROT), 'libx264', 2);
  if (libx265Ok) {
    await makeSample(path.join(userDir, SAMPLE_PROG), 'libx265', 20);
    await makeSample(path.join(userDir, SAMPLE_CANCEL), 'libx265', 20);
  }
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

// ─── ⑬ 快路矩阵：H.264 + AC3 → copy-audio ────────────
test('⑬ 快路矩阵：H.264+AC3 源走 copy-audio（视频直拷+音频 AAC），产物可播入库', async (t) => {
  if (!ffmpegOk) return t.skip('未检测到 ffmpeg，跳过');

  const { ws, frames } = await openSocketIO(token);
  try {
    const res = await api('POST', '/api/transcode', { authToken: token, body: { name: SAMPLE_COPY } });
    assert.equal(res.status, 200, `POST /api/transcode 应 200，实际 ${res.status}: ${JSON.stringify(res.json)}`);
    assert.equal(res.json.status, 'running', '首次提交应为 running');
    assert.match(res.json.streamId, /^[a-f0-9]{32}$/, 'streamId 应为 32 位十六进制（路由安全契约）');
    assert.equal(res.json.playlist, `/api/stream/${res.json.streamId}/index.m3u8`,
      '响应应携带播放列表 URL（前端起播依据）');
    assert.equal(res.json.output, SAMPLE_COPY_MP4, '响应应声明产物名 <原名>.mp4');

    const done = await waitFor(() => transcodePayloads(frames).find((s) => s.status === 'done' && s.name === SAMPLE_COPY),
      { timeoutMs: 45000, intervalMs: 150, label: 'transcode-status done' });
    assert.equal(done.mode, 'copy-audio',
      `H.264 视频 + AC3 音频应走 copy-audio 快路（视频直拷、音频转 AAC），实际 mode=${done.mode}`);
    assert.equal(done.progress, 100, 'done 帧进度应为 100');
    assert.equal(done.streamId, res.json.streamId, 'done 帧应携带 streamId');

    const productPath = path.join(userDir, SAMPLE_COPY_MP4);
    await waitFor(() => fs.existsSync(productPath), { timeoutMs: 10000, intervalMs: 250, label: '产物落盘' });
    assertPlayableMp4(await ffprobeJson(productPath), `⑬ 产物 ${SAMPLE_COPY_MP4}`);
    await waitFor(async () => (await listLibrary()).includes(SAMPLE_COPY_MP4),
      { timeoutMs: 15000, intervalMs: 500, label: '产物入库' });
  } finally {
    try { ws.close(); } catch { /* noop */ }
  }
});

// ─── ⑭ 渐进产出：边转边播成立（分片先于完成） ────────
test('⑭ 渐进产出：首个分片先于转换完成（边转边播），收尾 ENDLIST + 合封 MP4 入库', async (t) => {
  if (!ffmpegOk) return t.skip('未检测到 ffmpeg，跳过');
  if (!libx265Ok) return t.skip('ffmpeg 无 libx265 编码器，无法生成 HEVC 样本，跳过');

  const res = await api('POST', '/api/transcode', { authToken: token, body: { name: SAMPLE_PROG } });
  assert.equal(res.status, 200, `POST 应 200，实际 ${res.status}: ${JSON.stringify(res.json)}`);
  const { streamId } = res.json;

  // 1) 分片先出现（转换尚未完成：EVENT 列表尚无 ENDLIST）—— 边转边播的核心时间序
  const first = await waitFor(async () => {
    const { status, text } = await fetchPlaylist(streamId, token);
    if (status !== 200 || !text) return null;
    const seg = text.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
    return seg ? { text, seg } : null;
  }, { timeoutMs: 30000, intervalMs: 400, label: '播放列表首个分片出现' });
  assert.ok(!first.text.includes('#EXT-X-ENDLIST'),
    '首个分片出现时转换应仍在进行（列表不应已有 ENDLIST）——否则不是边转边播');

  // 2) 分片可立即取用（播放器边播边追的数据面）
  const segName = first.seg.split('?')[0];
  const segRes = await fetch(`http://127.0.0.1:${port}/api/stream/${streamId}/${segName}${first.seg.includes('?') ? `?${first.seg.split('?')[1]}` : ''}`);
  assert.equal(segRes.status, 200, `首分片应可 GET，实际 ${segRes.status}`);
  const segBuf = Buffer.from(await segRes.arrayBuffer());
  assert.ok(segBuf.length > 0, '首分片内容应非空');
  assert.equal(segBuf[0], 0x47, 'TS 分片应以同步字节 0x47 开头');

  // 3) 转换完成：ENDLIST + 合封产物可播入库
  await waitFor(async () => {
    const { text } = await fetchPlaylist(streamId, token);
    return text && text.includes('#EXT-X-ENDLIST');
  }, { timeoutMs: 60000, intervalMs: 500, label: '播放列表 ENDLIST（转换完成）' });

  const productPath = path.join(userDir, SAMPLE_PROG_MP4);
  await waitFor(() => fs.existsSync(productPath), { timeoutMs: 15000, intervalMs: 250, label: '合封产物落盘' });
  assertPlayableMp4(await ffprobeJson(productPath), `⑭ 产物 ${SAMPLE_PROG_MP4}`);
  await waitFor(async () => (await listLibrary()).includes(SAMPLE_PROG_MP4),
    { timeoutMs: 15000, intervalMs: 500, label: '合封产物入库' });
});

// ─── ⑮ 鉴权与 token 重写 ─────────────────────────────
test('⑮ 鉴权与 token 重写：无 token 401 / 他人 token 404 / 播放列表分片行附 token', async (t) => {
  if (!ffmpegOk) return t.skip('未检测到 ffmpeg，跳过');

  const res = await api('POST', '/api/transcode', { authToken: token, body: { name: SAMPLE_AUTH } });
  assert.equal(res.status, 200, `POST 应 200，实际 ${res.status}: ${JSON.stringify(res.json)}`);
  const { streamId } = res.json;

  // 无 token → 401（未登录）
  const noToken = await fetch(`http://127.0.0.1:${port}/api/stream/${streamId}/index.m3u8`);
  assert.equal(noToken.status, 401, `无 token 访问播放列表应 401，实际 ${noToken.status}`);

  // 他人 token → 404（会话归属隔离：不泄漏存在性）
  const other = await fetch(`http://127.0.0.1:${port}/api/stream/${streamId}/index.m3u8?token=${encodeURIComponent(token2)}`);
  assert.equal(other.status, 404, `他人 token 访问应 404（用户隔离），实际 ${other.status}`);
  const otherSeg = await fetch(`http://127.0.0.1:${port}/api/stream/${streamId}/seg00000.ts?token=${encodeURIComponent(token2)}`);
  assert.equal(otherSeg.status, 404, `他人 token 取分片应 404，实际 ${otherSeg.status}`);

  // 本人 token → 播放列表可读，且每个分片行都已重写带上 token（分片加载器 credentials:'omit' 依赖）
  const mine = await waitFor(async () => {
    const { status, text } = await fetchPlaylist(streamId, token);
    if (status !== 200 || !text) return null;
    return text.includes('#EXTINF') ? text : null;
  }, { timeoutMs: 30000, intervalMs: 400, label: '本人播放列表可读' });
  const segLines = mine.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  assert.ok(segLines.length > 0, '播放列表应含分片行');
  for (const line of segLines) {
    assert.ok(line.includes('token='), `分片行应被服务端重写附加 token，实际：${line}`);
  }

  // 收尾：等待完成，避免悬挂会话影响后续用例（会话间互斥按文件隔离，无强依赖）
  await waitFor(async () => {
    const { text } = await fetchPlaylist(streamId, token);
    return text && text.includes('#EXT-X-ENDLIST');
  }, { timeoutMs: 45000, intervalMs: 500, label: '⑮ 会话完成收尾' });
});

// ─── ⑯ 取消会话：cancel → cancelled 帧 → 可重新启动 ──
test('⑯ 取消会话：cancel 终止转换并置 cancelled，且同文件可重新启动新会话', async (t) => {
  if (!ffmpegOk) return t.skip('未检测到 ffmpeg，跳过');
  if (!libx265Ok) return t.skip('ffmpeg 无 libx265 编码器，无法生成长样本，跳过');

  const { ws, frames } = await openSocketIO(token);
  try {
    const first = await api('POST', '/api/transcode', { authToken: token, body: { name: SAMPLE_CANCEL } });
    assert.equal(first.status, 200, `首次提交应 200，实际 ${first.status}: ${JSON.stringify(first.json)}`);
    const firstId = first.json.streamId;

    const cancel = await api('POST', `/api/stream/${firstId}/cancel`, { authToken: token });
    assert.equal(cancel.status, 200, `取消应 200，实际 ${cancel.status}`);
    assert.equal(cancel.json.ok, true, '取消应返回 ok=true');

    const cancelled = await waitFor(
      () => transcodePayloads(frames).find((s) => s.streamId === firstId && s.status === 'cancelled'),
      { timeoutMs: 15000, intervalMs: 150, label: 'cancelled 事件' });
    assert.equal(cancelled.progress < 100, true, '取消时会话进度应 < 100（未完成）');

    // 同文件可重新启动（旧会话已终结让位）
    const again = await api('POST', '/api/transcode', { authToken: token, body: { name: SAMPLE_CANCEL } });
    assert.equal(again.status, 200, `重新启动应 200（旧会话已让位），实际 ${again.status}: ${JSON.stringify(again.json)}`);
    assert.notEqual(again.json.streamId, firstId, '重新启动应生成新 streamId');

    // 收尾：取消新会话，避免悬挂 ffmpeg
    const cancel2 = await api('POST', `/api/stream/${again.json.streamId}/cancel`, { authToken: token });
    assert.equal(cancel2.status, 200, '收尾取消失败');
  } finally {
    try { ws.close(); } catch { /* noop */ }
  }
});

// ─── ⑰ 流式路由防护 ──────────────────────────────────
test('⑰ 流式路由防护：非法 streamId / 非法分片名一律 404（不触达文件系统）', async (t) => {
  if (!ffmpegOk) return t.skip('未检测到 ffmpeg，跳过');

  // 非 32 位十六进制 id → 404
  const badId = await api('GET', '/api/stream/not-a-valid-id/index.m3u8', { authToken: token });
  assert.equal(badId.status, 404, `非法 streamId 应 404，实际 ${badId.status}`);

  // 合法会话 + 非法分片名（穿越形态）→ 404
  const res = await api('POST', '/api/transcode', { authToken: token, body: { name: SAMPLE_PROT } });
  assert.equal(res.status, 200, `POST 应 200，实际 ${res.status}: ${JSON.stringify(res.json)}`);
  const { streamId } = res.json;
  for (const badSeg of ['..%2F..%2Fsecret.ts', 'secret.ts', 'seg00000.mp4', 'seg1.ts']) {
    const r = await api('GET', `/api/stream/${streamId}/${badSeg}`, { authToken: token });
    assert.equal(r.status, 404, `非法分片名 ${badSeg} 应 404，实际 ${r.status}`);
  }

  // 收尾：等待完成（小样本秒级）
  await waitFor(async () => {
    const { text } = await fetchPlaylist(streamId, token);
    return text && text.includes('#EXT-X-ENDLIST');
  }, { timeoutMs: 30000, intervalMs: 400, label: '⑰ 会话完成收尾' });
});
