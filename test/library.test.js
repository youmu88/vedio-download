/**
 * 视频库自动扫描识别 — RED 测试（TDD）
 *
 * 覆盖 4 组行为契约（当前 src/index.js 均未实现，预期全部 RED）：
 *   ① /api/library 扩展名白名单过滤（白名单内可见，白名单外隐藏）
 *   ② .part.mp4 直链断点续传临时文件过滤（现状 index.js:406 仅 endsWith('.part')）
 *   ③ 进行中/排队中任务的实际输出文件名过滤（现状 index.js:407 仅按 taskId 前缀，
 *      实际输出名来自 resolveOutputName 的标题命名 → 标题命名文件泄漏入库）
 *   ④ 服务端 fs.watch 检测新增文件 → socket 向 user:<owner> 房间推送 'library-update'
 *      （现状无 fs.watch、无 library-update 事件）
 *
 * 运行：node --test test/library.test.js
 *
 * 测试基建说明：
 *   - src/index.js 模块级 listen（:1096），只能以子进程方式启动；
 *   - AUTO_START_QUEUE=0 进入待命模式：预置的排队任务不会被真实执行（无网络副作用）；
 *   - VD_DATA_DIR 指向 mkdtemp 临时目录：隔离 vd.db / tasks.json，不污染 data/；
 *   - VD_DOWNLOADS_DIR 声明下载目录隔离意图（实现落地后生效）；测试在服务启动、
 *     注册用户后探测其实际生效的 downloads 根（register 会在生效目录下建用户子目录），
 *     夹具始终写入被服务实际读取的目录，保证 RED 失败原因是断言不满足而非夹具错位；
 *     若服务回落到仓库 downloads/，仅使用独立测试用户子目录并在 after 中清除；
 *   - socket 客户端基于 Node 原生 WebSocket 手写 engine.io/socket.io v4 握手帧
 *     （0 open → 40{"token":...} CONNECT → 40 连接确认 → 42 事件帧），零新增依赖；
 *   - 事件等待统一为轮询 deadline，不使用固定 sleep，避免 flaky。
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(REPO_ROOT, 'src', 'index.js');

// ─── 共享夹具状态（文件级 before 一次性装配） ──────────
let tmpRoot = null;
let child = null;
let port = 0;
let token = null;
let username = null;
let userDir = null;        // 服务实际读取的 <downloads>/<username> 目录
let childLogTail = '';     // 子进程 stdout/stderr 尾部（启动失败诊断用）

const RUNNING_TASK_FILE = 'Sunset Timelapse 4K.mp4'; // ③ 进行中任务的标题命名产物
const RUNNING_TASK_ID = 'task_libtest_inprogress';

// ─── 小工具 ─────────────────────────────────────────
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

async function listLibrary() {
  const { status, json } = await api('GET', '/api/library', { authToken: token });
  assert.equal(status, 200, `/api/library 应返回 200，实际 ${status}: ${JSON.stringify(json)}`);
  assert.ok(Array.isArray(json), '/api/library 应返回文件数组');
  return json.map((f) => f.name);
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

function writeFixture(name, size = 1024) {
  const p = path.join(userDir, ...name.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(size, 0));
}
function removeFixture(name) {
  try { fs.unlinkSync(path.join(userDir, ...name.split('/'))); } catch { /* 已清理 */ }
}

/**
 * 极简 socket.io v4 客户端（engine.io v4 WebSocket 传输）：
 * 返回 { frames, waitEvent } — waitEvent 轮询收到的 42 事件帧直到匹配 eventName。
 */
async function openSocketIO(authToken, { timeoutMs = 8000 } = {}) {
  const frames = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* noop */ }
      reject(new Error('socket.io 握手超时（未在时限内完成 0→40 握手）'));
    }, timeoutMs);
    ws.addEventListener('message', (ev) => {
      const data = typeof ev.data === 'string' ? ev.data : String(ev.data);
      if (data.startsWith('42')) frames.push(data);
      else if (data.startsWith('0')) ws.send('40' + JSON.stringify({ token: authToken })); // CONNECT + auth
      else if (data.startsWith('40')) { clearTimeout(timer); resolve(); }
      else if (data.startsWith('2')) ws.send('3'); // engine.io ping → pong
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('WebSocket 连接失败'));
    });
  });
  // 轮询事件帧（deadline 内不固定 sleep）
  const waitEvent = async (eventName, timeoutMs2 = 8000) => {
    const deadline = Date.now() + timeoutMs2;
    while (Date.now() < deadline) {
      const hit = frames.find((f) => f.startsWith(`42[${JSON.stringify(eventName)},`));
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  };
  return { ws, frames, waitEvent };
}

async function spawnServer(attempt = 0) {
  port = randPort();
  const c = spawn(process.execPath, [ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      VD_DATA_DIR: path.join(tmpRoot, 'data'),
      VD_DOWNLOADS_DIR: path.join(tmpRoot, 'downloads'), // 隔离意图；实现落地前服务回落仓库 downloads/
      AUTO_START_QUEUE: '0', // 待命模式：预置任务不真实执行
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
    if (attempt === 0) return spawnServer(1); // 端口偶发占用，换端口重试一次
    throw new Error(`服务启动失败：${err.message}\n子进程日志尾部：\n${childLogTail}`);
  }
  return c;
}

// ─── 装配 / 拆卸 ────────────────────────────────────
before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vd-libtest-'));
  fs.mkdirSync(path.join(tmpRoot, 'downloads'), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, 'data'), { recursive: true });

  username = `vd_libtest_${Date.now().toString(36)}`;

  // 预置 tasks.json：一个「进行中」任务的输出名为页面标题（真实场景：resolveOutputName 标题命名，
  // 引擎直接落最终名文件）。AUTO_START_QUEUE=0 保证其不会被真实执行。
  const now = new Date().toISOString();
  const seededTask = {
    id: RUNNING_TASK_ID,
    url: 'https://example.com/watch/sunset-timelapse',
    owner: username,
    status: 'created', // 处理器的过滤集合为 created+running（index.js:396）
    m3u8Url: null,
    outputFile: RUNNING_TASK_FILE,
    outputName: RUNNING_TASK_FILE,
    title: 'Sunset Timelapse 4K',
    pageTitle: 'Sunset Timelapse 4K',
    progress: 42,
    speed: null,
    error: null,
    retryCount: 0,
    maxRetries: 3,
    engine: 'auto',
    format: 'auto',
    createdAt: now,
    updatedAt: now,
  };
  fs.writeFileSync(path.join(tmpRoot, 'data', 'tasks.json'), JSON.stringify([seededTask], null, 2));

  child = await spawnServer();

  // 注册 + 登录（register 会在服务实际生效的 downloads 根下创建用户子目录）
  const reg = await api('POST', '/api/auth/register', { body: { username, password: 'libtest-pass' } });
  assert.equal(reg.status, 200, `注册测试用户失败: ${JSON.stringify(reg.json)}`);
  const login = await api('POST', '/api/auth/login', { body: { username, password: 'libtest-pass' } });
  assert.equal(login.status, 200, `登录测试用户失败: ${JSON.stringify(login.json)}`);
  token = login.json.token;
  assert.ok(token, '登录应返回 token');

  // 探测服务实际生效的 downloads 根：优先临时目录（VD_DOWNLOADS_DIR 生效），否则回落仓库 downloads/
  const tmpCandidate = path.join(tmpRoot, 'downloads', username);
  const repoCandidate = path.join(REPO_ROOT, 'downloads', username);
  if (fs.existsSync(tmpCandidate)) {
    userDir = tmpCandidate;
  } else if (fs.existsSync(repoCandidate)) {
    userDir = repoCandidate; // 实现未落地前的回落路径；after() 中清理
  } else {
    throw new Error(`无法定位服务生效的用户下载目录（${tmpCandidate} 与 ${repoCandidate} 均不存在）`);
  }
  fs.mkdirSync(userDir, { recursive: true });
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
  // 回落场景：仅清理本测试的独立用户目录，不触碰任何既有用户数据
  if (userDir && userDir.startsWith(path.join(REPO_ROOT, 'downloads'))) {
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

// ─── ① 扩展名白名单过滤 ─────────────────────────────
test('① /api/library 扩展名白名单：白名单外文件（.txt/.zip/.srt）不得入库', async () => {
  const whitelisted = [
    'libtest-whitelist-ok.mp4',
    'libtest-whitelist-clip.webm',
    'libtest-whitelist-movie.mkv',
    'libtest-whitelist-home.mov',
    'libtest-whitelist-stream.m3u8',
  ];
  const rejected = [
    'libtest-whitelist-notes.txt',
    'libtest-whitelist-archive.zip',
    'libtest-whitelist-subs.srt',
  ];
  for (const n of [...whitelisted, ...rejected]) writeFixture(n);
  try {
    const names = await listLibrary();
    // 正向对照：白名单内文件必须可见（证明列表链路本身工作）
    for (const n of whitelisted) {
      assert.ok(names.includes(n), `白名单内文件应入库：${n}（实际列表：${JSON.stringify(names)}）`);
    }
    // 核心断言（RED 点）：白名单外文件不得入库
    for (const n of rejected) {
      assert.ok(!names.includes(n), `白名单外文件不应出现在视频库：${n}（实际列表：${JSON.stringify(names)}）`);
    }
  } finally {
    for (const n of [...whitelisted, ...rejected]) removeFixture(n);
  }
});

// ─── ② .part.mp4 临时文件过滤 ───────────────────────
test('② /api/library 应过滤 .part.mp4 直链续传临时文件', async () => {
  const finalName = 'libtest-episode.mp4';
  const partMp4Name = 'libtest-episode.part.mp4'; // downloader.js:592 的断点续传写盘形态（RED 点）
  const plainPartName = 'libtest-legacy.part';    // 既有 endsWith('.part') 已覆盖（对照）
  for (const n of [finalName, partMp4Name, plainPartName]) writeFixture(n);
  try {
    const names = await listLibrary();
    assert.ok(names.includes(finalName), `完成态最终文件应入库：${finalName}（实际列表：${JSON.stringify(names)}）`);
    assert.ok(!names.includes(partMp4Name),
      `.part.mp4 临时文件不应出现在视频库：${partMp4Name}（实际列表：${JSON.stringify(names)}）`);
    assert.ok(!names.includes(plainPartName), `.part 临时文件不应出现在视频库：${plainPartName}`);
  } finally {
    for (const n of [finalName, partMp4Name, plainPartName]) removeFixture(n);
  }
});

// ─── ③ 进行中任务实际输出名过滤 ─────────────────────
test('③ 进行中任务按实际输出文件名过滤：标题命名的下载中文件不得入库', async () => {
  const decoy = 'libtest-finished-video.mp4'; // 无任务关联的普通文件（对照，须可见）
  writeFixture(RUNNING_TASK_FILE);
  writeFixture(decoy);
  try {
    const names = await listLibrary();
    assert.ok(names.includes(decoy), `无任务关联文件应入库：${decoy}（实际列表：${JSON.stringify(names)}）`);
    // 核心断言（RED 点）：任务实际输出名（标题命名）应被过滤，而非仅按 taskId 前缀匹配
    assert.ok(!names.includes(RUNNING_TASK_FILE),
      `进行中任务的实际输出文件不应出现在视频库：${RUNNING_TASK_FILE}` +
      `（任务 ${RUNNING_TASK_ID} 的 outputFile/outputName；实际列表：${JSON.stringify(names)}）`);
  } finally {
    removeFixture(RUNNING_TASK_FILE);
    removeFixture(decoy);
  }
});

// ─── ④ fs.watch 新增文件 → socket 推送 library-update ──
test('④ 服务端检测到新增文件后应向用户房间推送 library-update 事件', async () => {
  const { ws, waitEvent } = await openSocketIO(token);
  try {
    // 先订阅等待，再触发文件写入，避免竞态
    const waitPromise = waitEvent('library-update', 8000);
    writeFixture('libtest-watch-discovery.mp4');
    const frame = await waitPromise;
    assert.ok(frame !== null,
      '服务端应在文件新增后（fs.watch → 广播链路）向 user 房间推送 library-update 事件（8s 内未收到）');
    // 事件名命中后，若载荷含 owner 字段则校验用户定向正确（载荷形态不强约束）
    try {
      const payload = JSON.parse(frame.slice(2))[1];
      if (payload && typeof payload === 'object' && 'owner' in payload) {
        assert.equal(payload.owner, username, 'library-update 应定向推送给文件所属用户');
      }
    } catch { /* 载荷形态不强约束 */ }
  } finally {
    removeFixture('libtest-watch-discovery.mp4');
    try { ws.close(); } catch { /* noop */ }
  }
});

// ─── ⑤ 子目录递归可见（20261024 缺陷回归）────────────
test('⑤ /api/library 递归列出子目录视频，name 为相对路径', async () => {
  const fixtures = [
    'libtest-sub/top.mp4',
    'libtest-sub/dir/clip.mp4',
    'libtest-sub/dir/deep/episode.mkv',
  ];
  fixtures.forEach((n) => writeFixture(n));
  try {
    const names = await listLibrary();
    for (const n of fixtures) {
      assert.ok(names.includes(n), `子目录视频应可见：${n}（实际列表：${JSON.stringify(names)}）`);
    }
  } finally {
    fixtures.forEach(removeFixture);
  }
});

// ─── ⑥ 深度上限 + 隐藏目录 / 符号链接 ──────────────
test('⑥ 第 7 层视频不列出；隐藏目录与符号链接目录不跟进', async () => {
  const okDeep = 'libtest-depth/a/b/c/d/ok.mp4';              // 6 段（等于上限）
  const tooDeep = 'libtest-depth/a/b/c/d/e/deep.mp4';         // 7 段（超上限）
  const hidden = 'libtest-depth/.hidden/secret.mp4';
  const realDir = path.join(userDir, 'libtest-depth', 'real');
  const linkDir = path.join(userDir, 'libtest-depth', 'link');
  [okDeep, tooDeep, hidden].forEach((n) => writeFixture(n));
  fs.mkdirSync(realDir, { recursive: true });
  fs.writeFileSync(path.join(realDir, 'inside.mp4'), Buffer.alloc(64));
  try { fs.symlinkSync(realDir, linkDir); } catch { /* 平台不支持则跳过符号链接断言 */ }
  try {
    const names = await listLibrary();
    assert.ok(names.includes(okDeep), `第 6 层应可见：${okDeep}（实际：${JSON.stringify(names)}）`);
    assert.ok(!names.includes(tooDeep), `第 7 层不应可见：${tooDeep}`);
    assert.ok(!names.includes(hidden), `隐藏目录内视频不应可见：${hidden}`);
    assert.ok(names.includes('libtest-depth/real/inside.mp4'), '真实目录内视频应可见');
    if (fs.existsSync(linkDir)) {
      assert.ok(!names.some((n) => n.startsWith('libtest-depth/link/')), '符号链接目录不应被跟进');
    }
  } finally {
    [okDeep, tooDeep, hidden].forEach(removeFixture);
    try { fs.unlinkSync(path.join(realDir, 'inside.mp4')); } catch { /* noop */ }
    try { if (fs.existsSync(linkDir)) fs.unlinkSync(linkDir); } catch { /* noop */ }
  }
});

// ─── ⑦ 白名单覆盖前端可转码格式 ──────────────────
test('⑦ /api/library 列出 .avi/.flv/.wmv/.mpg/.ts（前端有转码能力的格式），非媒体仍隐藏', async () => {
  const now = ['libtest-format.avi', 'libtest-format.flv', 'libtest-format.wmv', 'libtest-format.mpg', 'libtest-format.ts'];
  const notMedia = ['libtest-format.txt', 'libtest-format.zip'];
  [...now, ...notMedia].forEach((n) => writeFixture(n));
  try {
    const names = await listLibrary();
    for (const n of now) assert.ok(names.includes(n), `应入库：${n}（实际：${JSON.stringify(names)}）`);
    for (const n of notMedia) assert.ok(!names.includes(n), `不应入库：${n}`);
  } finally {
    [...now, ...notMedia].forEach(removeFixture);
  }
});

// ─── ⑧ 收藏列表：相对路径条目 + 隐藏语义保持 ──────
test('⑧ 已加入列表的相对路径条目在浏览页隐藏；../ 条目被拒', async () => {
  const rel = 'libtest-listed/sub/clip.mp4';
  writeFixture(rel);
  const created = await api('POST', '/api/lists', { authToken: token, body: { name: 'libtest 列表' } });
  assert.equal(created.status, 200, `创建列表失败：${JSON.stringify(created.json)}`);
  const listId = created.json.list.id;
  try {
    const added = await api('POST', `/api/lists/${listId}/items`, { authToken: token, body: { names: [rel] } });
    assert.equal(added.status, 200, `添加相对路径条目失败：${JSON.stringify(added.json)}`);
    assert.ok(added.json.list.items.some((i) => i.name === rel), '列表应保存相对路径条目');
    const names = await listLibrary();
    assert.ok(!names.includes(rel), '已入列表的条目不应在浏览页出现（隐藏语义保持）');

    const bad = await api('POST', `/api/lists/${listId}/items`, { authToken: token, body: { names: ['../escape.mp4'] } });
    assert.equal(bad.status, 400, `../ 条目应被拒（实际 ${bad.status}）`);
  } finally {
    removeFixture(rel);
    await api('DELETE', `/api/lists/${listId}`, { authToken: token });
  }
});

// ─── ⑨ DELETE：子目录相对路径 + 穿越拒绝 ───────────
test('⑨ DELETE 子目录文件只删目标、不误删顶层同名文件；../ 与绝对路径返回 400', async () => {
  const nested = 'libtest-del/sub/same.mp4';
  const topSame = 'libtest-del/same.mp4';
  writeFixture(nested);
  writeFixture(topSame);
  try {
    const del = await api('DELETE', `/api/library/${encodeURIComponent(nested)}`, { authToken: token });
    assert.equal(del.status, 200, `删除子目录文件失败（${del.status}）：${JSON.stringify(del.json)}`);
    assert.equal(del.json.name, nested, '返回的 name 应为相对路径');
    assert.ok(!fs.existsSync(path.join(userDir, 'libtest-del', 'sub', 'same.mp4')), '子目录目标文件应被删除');
    assert.ok(fs.existsSync(path.join(userDir, 'libtest-del', 'same.mp4')), '顶层同名文件不应被误删');

    const traversal = await api('DELETE', `/api/library/${encodeURIComponent('../escape.mp4')}`, { authToken: token });
    assert.equal(traversal.status, 400, `../ 穿越应返回 400（实际 ${traversal.status}）`);
    const absolute = await api('DELETE', `/api/library/${encodeURIComponent('/etc/passwd')}`, { authToken: token });
    assert.equal(absolute.status, 400, `绝对路径应返回 400（实际 ${absolute.status}）`);
  } finally {
    removeFixture(nested);
    removeFixture(topSame);
  }
});

// ─── ⑩ media-info / transcode 接受相对路径 ─────────
test('⑩ media-info 与 transcode 接受子目录相对路径（不再被 basename 截断成 400/404）', async () => {
  const rel = 'libtest-media/sub/clip.mkv';
  writeFixture(rel, 4096);
  let streamId = null;
  try {
    const info = await api('GET', `/api/media-info?name=${encodeURIComponent(rel)}`, { authToken: token });
    assert.ok(![400, 404].includes(info.status),
      `media-info 不应因路径截断而 400/404（实际 ${info.status}: ${JSON.stringify(info.json)}）`);
    const tc = await api('POST', '/api/transcode', { authToken: token, body: { name: rel } });
    assert.ok(![400, 404].includes(tc.status),
      `transcode 不应因路径截断而 400/404（实际 ${tc.status}: ${JSON.stringify(tc.json)}）`);
    streamId = tc.json?.streamId || null;
  } finally {
    if (streamId) await api('POST', `/api/stream/${streamId}/cancel`, { authToken: token });
    removeFixture(rel);
  }
});

// ─── ⑪ 播放 URL：子目录逐段编码 → 206 Range ─────────
test('⑪ 子目录视频播放 URL（逐段编码）可 Range 取流', async () => {
  const rel = 'libtest-play/sub/clip.mp4';
  writeFixture(rel, 4096);
  try {
    const urlPath = rel.split('/').map(encodeURIComponent).join('/');
    const res = await fetch(`http://127.0.0.1:${port}/downloads/${urlPath}?token=${encodeURIComponent(token)}`, {
      headers: { range: 'bytes=0-99' },
    });
    assert.equal(res.status, 206, `子目录播放 URL 应支持 Range（实际 ${res.status}）`);
    assert.equal((await res.arrayBuffer()).byteLength, 100);
  } finally {
    removeFixture(rel);
  }
});
