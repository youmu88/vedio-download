/**
 * MKV 静默黑屏 → 「点击即获得可播产物」 — RED 测试（TDD）
 *
 * 根因依据：.handoff/obj_1788961990968_si3lmm/mkv-repro-report.md（dbg-repro）
 *   主断点（结构性）：public/js/player-core.js 转码入口仅由 video.onerror 驱动，
 *     但 Chromium 对「matroska demux 成功 + 视频编码不可解（如 HEVC）」的处理是静默弃轨：
 *     canplaythrough/playing 照发、时间轴照走、videoWidth=0、0 帧输出、全程不抛 error
 *     → 转码入口结构性不可达 → 用户看到黑屏无提示，POST /api/transcode 永不发出
 *     （服务端零「开始转码」日志即其上游投影）。
 *   次级发现：可播性是浮动面（同 HEVC in MKV 真机 Chrome VideoToolbox 可直解），
 *     error 事件不可作为唯一信号源；WebKit/iOS 现有 onerror 链路已验证可用，须保留。
 *
 * 用例（编号续接 library.test.js ①-④ / transcode.test.js ⑤-⑦）：
 *   ⑧ [RED] 现象级：库列表含 HEVC MKV → 点击卡片 → 必须到达可播状态：
 *        直解（src 仍指向 MKV 且 videoWidth>0）或 边转边播（src 切到 /api/stream/ 且 videoWidth>0）
 *        → 转换完成后合封产物 .mp4 落盘 + ffprobe 可解（h264）+ 入库
 *   ⑨ [RED] 静默失败检测契约：videoWidth 恒 0 且全程无 error 事件（实例级 stub 精确复现
 *        Chromium 静默弃轨签名，与运行环境解码能力无关）→ 必须自动启动边转边播（不得只依赖 onerror）
 *   ⑩ [护栏·现状应绿] 服务端半链路：POST HEVC MKV → 200 → done → 产物 h264/aac、
 *        duration>0、入库（修复只在前端时，此线守住服务端产物可播性）
 *   ⑪ [护栏·现状应绿] WebKit 回归：WebKit 拒收 matroska（onerror/主动预判）→ 自动边转边播 → 流可播
 *   ⑫ [护栏·现状应绿] 409 exists 续接：API 预转码制造 exists 场景 → 浏览器点击
 *        同一 mkv 卡片 → 自动 POST 409 code=exists → 前端直接 playLibrary(产物 mp4)（src 切
 *        .mp4、videoWidth>0）且未重复启动转换（单次 409 POST + 产物 mtime 不变 + 无新「开始…转换」日志）
 *
 * 运行：node --test test/mkv-play.test.js
 * 基建与 test/transcode.test.js 同款：mkdtemp 隔离 VD_DATA_DIR/VD_DOWNLOADS_DIR、
 * 随机端口子进程起 src/index.js、AUTO_START_QUEUE=0；浏览器用仓库依赖 playwright
 * （bundled chromium headless 复现静默黑屏形态；webkit 走对照组）。
 * 无 ffmpeg/libx265/playwright 的环境 t.skip，不失败。
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

// ─── 样本（与复现报告矩阵同构：lavfi 生成，触发要素=matroska 容器+指定编码） ───
const SAMPLE_HEVC = 'mkvB_hevc_aac.mkv';        // B 形态：Chromium headless 静默黑屏
const SAMPLE_HEVC_MP4 = 'mkvB_hevc_aac.mp4';    // B 形态转码产物名
const SAMPLE_H264 = 'mkvA_h264_aac.mkv';        // A 形态：chromium 可直解（⑨ 的 stub 载体）
const SAMPLE_API = 'mkv_hevc_api.mkv';          // ⑩ 专用（避免与 ⑧ 的转码互斥 409）
const SAMPLE_API_MP4 = 'mkv_hevc_api.mp4';
const SAMPLE_WEBKIT = 'mkvA_webkit.mkv';        // ⑪ 专用（避免修复若自动转码与 ⑨ 撞产物）
const SAMPLE_WEBKIT_MP4 = 'mkvA_webkit.mp4';
const SAMPLE_RESUME = 'mkvB_resume.mkv';        // ⑫ 专用：API 预转码制造 exists 场景，测 409 续接
const SAMPLE_RESUME_MP4 = 'mkvB_resume.mp4';

// ─── 共享夹具状态 ────────────────────────────────────
let tmpRoot = null;
let child = null;
let port = 0;
let token = null;
let username = null;
let password = 'mkvplay-pass';
let userDir = null;
let ffmpegOk = false;
let libx265Ok = false;
let chromiumBrowser = null;
let webkitBrowser = null;
let childLogTail = '';
let childLogFull = ''; // 完整日志缓冲（不截尾）：⑫ 断言「未重复启动转码」需按偏移切片，滚动窗口 childLogTail 会使其失效

// ─── 小工具（与 transcode.test.js 保持同构） ────────
function randPort() {
  return 21000 + Math.floor(Math.random() * 20000);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    await sleep(intervalMs);
  }
  throw new Error(`等待超时（${timeoutMs}ms）：${label}${lastErr ? `，最后错误：${lastErr.message}` : ''}`);
}

/** 轮询到条件满足返回值，超时返回 null（由调用方决定断言失败信息） */
async function pollUntil(fn, { timeoutMs, intervalMs = 400 }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch { /* 轮询内的瞬态错误（如页面导航中）不算失败 */ }
    await sleep(intervalMs);
  }
  return null;
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

function probeBin(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) =>
      resolve(err ? null : String(stdout)));
  });
}

/** 生成 2s lavfi 样本：testsrc + sine，视频编码由 vcodec 决定（libx264 / libx265） */
function makeMkv(dest, vcodec) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', [
      '-y',
      '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=12',
      '-f', 'lavfi', '-i', 'sine=duration=2:frequency=440',
      '-shortest', '-c:v', vcodec, '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
      dest,
    ], { timeout: 60000 }, (err, _stdout, stderr) => {
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

/** 产物可播性契约：h264 视频 + aac 音频 + duration>0（HEVC 源必须重编码，禁止 copy 出不可解产物） */
function assertPlayableMp4(probe, label) {
  const video = (probe.streams || []).find((s) => s.codec_type === 'video');
  const audio = (probe.streams || []).find((s) => s.codec_type === 'audio');
  assert.ok(video, `${label}：ffprobe 应解析出视频流`);
  assert.equal(video.codec_name, 'h264',
    `${label}：产物视频流应为 h264（HEVC 源必须重编码而非 -c copy），实际 ${video.codec_name}`);
  assert.ok(audio && audio.codec_name === 'aac', `${label}：产物应含 aac 音频流`);
  const dur = parseFloat(probe.format?.duration);
  assert.ok(dur > 0, `${label}：产物时长应 > 0，实际 ${dur}`);
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
  c.stdout.on('data', (d) => { const s = d.toString(); childLogFull += s; childLogTail = (childLogTail + s).slice(-4000); });
  c.stderr.on('data', (d) => { const s = d.toString(); childLogFull += s; childLogTail = (childLogTail + s).slice(-4000); });
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

// ─── 浏览器侧工具 ───────────────────────────────────
/** 真实用户链路：UI 登录 → dock 切浏览 → 目标卡片可见 */
async function loginAndOpenBrowse(page, cardName) {
  await page.goto(`http://127.0.0.1:${port}/macos.html`);
  await page.fill('#loginUser', username);
  await page.fill('#loginPass', password);
  await page.click('#loginBtn');
  await page.waitForSelector('#dock .dock-icon[data-app="browse"]', { timeout: 15000 });
  await page.click('#dock .dock-icon[data-app="browse"]');
  await page.waitForSelector(`.video-card[data-name="${cardName}"]`, { timeout: 15000 });
}

/** 点击卡片前注入：video 事件记录 + transcode-status 窗口事件记录（复现脚本同款） */
async function injectRecorder(page) {
  await page.waitForSelector('#inlinePlayerVideo', { state: 'attached', timeout: 5000 });
  await page.evaluate(() => {
    const v = document.getElementById('inlinePlayerVideo');
    window.__vlog = [];
    ['loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough',
      'play', 'playing', 'pause', 'ended', 'waiting', 'error'].forEach((t) =>
      v.addEventListener(t, () => window.__vlog.push({ t: Date.now(), type: t })));
    window.addEventListener('transcode-status', (ev) =>
      window.__vlog.push({ t: Date.now(), type: 'window:transcode-status', detail: ev.detail }));
  });
}

/**
 * 播放上下文（PlayerCore.getCurrentPlay）：id=file:/stream:/url:，src=媒体 URL。
 * ⚠️ 流式（hls.js/MSE）下 video.currentSrc 是 blob: URL，判断「在播什么」必须用本上下文。
 */
function collectCurrentPlay(page) {
  return page.evaluate(() => {
    try { return window.PlayerCore.getCurrentPlay(); } catch { return null; }
  });
}

/** 采集播放器终态（含事件流，供断言失败信息输出现象证据） */
function collectPlayerState(page) {
  return page.evaluate(() => {
    const v = document.getElementById('inlinePlayerVideo');
    const box = document.getElementById('inlinePlayer');
    const notice = box ? box.querySelector('.transcode-notice') : null;
    return {
      src: (v.currentSrc || v.src || '').replace(/^.*\/downloads\//, '/downloads/').slice(0, 120),
      readyState: v.readyState,
      videoWidth: v.videoWidth,
      videoHeight: v.videoHeight,
      decodedFrames: v.webkitDecodedFrameCount ?? null,
      currentTime: +(v.currentTime || 0).toFixed(2),
      error: v.error ? { code: v.error.code, message: v.error.message } : null,
      noticeVisible: !!notice,
      noticeBtnText: notice ? (notice.querySelector('button') || {}).textContent || '' : '',
      events: (window.__vlog || []).map((e) => e.type),
    };
  });
}

// ─── 装配 / 拆卸 ────────────────────────────────────
before(async () => {
  ffmpegOk = !!(await probeBin('ffmpeg', ['-version']));
  if (ffmpegOk) {
    const encoders = await probeBin('ffmpeg', ['-hide_banner', '-encoders']);
    libx265Ok = !!encoders && /libx265/.test(encoders);
  }
  if (!ffmpegOk) return; // 无 ffmpeg：用例体内 t.skip，不装配服务

  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vd-mkvplay-'));
  fs.mkdirSync(path.join(tmpRoot, 'downloads'), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, 'data'), { recursive: true });
  username = `vd_mkvplay_${Date.now().toString(36)}`;

  child = await spawnServer();

  const reg = await api('POST', '/api/auth/register', { body: { username, password } });
  assert.equal(reg.status, 200, `注册测试用户失败: ${JSON.stringify(reg.json)}`);
  const login = await api('POST', '/api/auth/login', { body: { username, password } });
  assert.equal(login.status, 200, `登录测试用户失败: ${JSON.stringify(login.json)}`);
  token = login.json.token;
  assert.ok(token, '登录应返回 token');

  const tmpCandidate = path.join(tmpRoot, 'downloads', username);
  const repoCandidate = path.join(REPO_ROOT, 'downloads', username);
  if (fs.existsSync(tmpCandidate)) userDir = tmpCandidate;
  else if (fs.existsSync(repoCandidate)) userDir = repoCandidate;
  else throw new Error(`无法定位服务生效的用户下载目录（${tmpCandidate} 与 ${repoCandidate} 均不存在）`);

  await makeMkv(path.join(userDir, SAMPLE_H264), 'libx264');
  if (libx265Ok) {
    await makeMkv(path.join(userDir, SAMPLE_HEVC), 'libx265');
    await makeMkv(path.join(userDir, SAMPLE_API), 'libx265');
    await makeMkv(path.join(userDir, SAMPLE_RESUME), 'libx265');
  }
  await makeMkv(path.join(userDir, SAMPLE_WEBKIT), 'libx264');

  try {
    const pw = await import('playwright');
    chromiumBrowser = await pw.chromium.launch({
      headless: true,
      args: ['--autoplay-policy=no-user-gesture-required'],
    });
  } catch (err) {
    console.error(`[fixture] chromium 启动失败，浏览器用例将跳过：${err.message}`);
    chromiumBrowser = null;
  }
});

after(async () => {
  try { await chromiumBrowser?.close(); } catch { /* noop */ }
  try { await webkitBrowser?.close(); } catch { /* noop */ }
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

// ─── ⑧ [RED] 现象级：MKV 点击即获得可播产物 ─────────
test('⑧ 现象级：点击 HEVC MKV 卡片必须到达可播状态（直解 或 边转边播流出画面 + 产物入库）', async (t) => {
  if (!ffmpegOk) return t.skip('未检测到 ffmpeg，跳过');
  if (!libx265Ok) return t.skip('ffmpeg 无 libx265 编码器，无法生成 HEVC 样本，跳过');
  if (!chromiumBrowser) return t.skip('chromium 启动失败，跳过浏览器用例');

  const ctx = await chromiumBrowser.newContext();
  const page = await ctx.newPage();
  const transcodePosts = [];
  page.on('response', (res) => {
    if (res.url().includes('/api/transcode')) {
      transcodePosts.push({ url: res.url().replace(`http://127.0.0.1:${port}`, ''), status: res.status() });
    }
  });
  try {
    await loginAndOpenBrowse(page, SAMPLE_HEVC);
    await injectRecorder(page);

    // 真实用户动作：点击库中的 MKV 卡片
    await page.click(`.video-card[data-name="${SAMPLE_HEVC}"]`);

    // 可播状态窗口：直解（仍播源文件 MKV 且出画面）或 边转边播流（播放上下文切到 stream: 且出画面）
    // ⚠️ 用播放上下文判定：hls.js/MSE 下 video.currentSrc 是 blob: URL，不能用作判据
    const outcome = await pollUntil(async () => {
      const st = await collectPlayerState(page);
      const cp = await collectCurrentPlay(page);
      if (!cp) return null;
      const onStream = typeof cp.id === 'string' && cp.id.startsWith('stream:');
      const playable = st.videoWidth > 0 && (st.decodedFrames ?? 0) > 0 && !st.error;
      if (onStream || playable || st.noticeVisible) return { playable, onStream, cp, st };
      return null;
    }, { timeoutMs: 30000, intervalMs: 500 });

    if (!outcome) {
      const st = await collectPlayerState(page);
      const cp = await collectCurrentPlay(page);
      assert.ok(false, [
        '现象级断点：点击 HEVC in MKV 卡片后 30s 内未到达任何可播状态（黑屏死胡同）。',
        `video=${st.videoWidth}x${st.videoHeight}（0x0=黑屏） decodedFrames=${st.decodedFrames} readyState=${st.readyState}`,
        `播放上下文=${JSON.stringify(cp)}`,
        `error=${JSON.stringify(st.error)}（null=Chromium 静默弃轨：demux 成功但不抛 error）`,
        `POST /api/transcode 请求数=${transcodePosts.length}（0=点击未触发边转边播）`,
        `事件流=[${st.events.join(' → ')}]`,
      ].join('；'));
    }

    if (!outcome.onStream && outcome.playable) {
      // 本环境能直解（如真机硬解）：现象「点击即可播」已满足，产物断言不适用
      t.diagnostic(`本环境可直解 HEVC in MKV（videoWidth=${outcome.st.videoWidth}），走直解路径`);
      return;
    }

    // ── 边转边播链路：点击即自动触发（POST 200，无需手动按钮）→ 流可播 ──
    const posted = await waitFor(() => transcodePosts.length > 0 ? transcodePosts[0] : null,
      { timeoutMs: 10000, intervalMs: 200, label: 'POST /api/transcode 发出' });
    assert.equal(posted.status, 200,
      `点击后应自动发起 POST /api/transcode 且 200，实际 ${posted.status}（${posted.url}）`);

    const streamed = await pollUntil(async () => {
      const st = await collectPlayerState(page);
      return (st.videoWidth > 0 && !st.error) ? st : null;
    }, { timeoutMs: 30000, intervalMs: 500 });
    assert.ok(streamed, [
      '边转边播流应在点击后 30s 内出画面（videoWidth>0、无 error）。',
      `终态=${JSON.stringify(await collectPlayerState(page))}`,
    ].join('；'));
    t.diagnostic(`点击即播：cp.src=${outcome.cp.src}（边转边播流）`);

    // 产物契约：磁盘存在 + ffprobe 可解（h264/aac/duration>0）+ 入库
    const productPath = path.join(userDir, SAMPLE_HEVC_MP4);
    await waitFor(() => fs.existsSync(productPath), { timeoutMs: 60000, intervalMs: 300, label: `产物 ${SAMPLE_HEVC_MP4} 落盘` });
    assertPlayableMp4(await ffprobeJson(productPath), `⑧ 产物 ${SAMPLE_HEVC_MP4}`);
    const names = await waitFor(async () => {
      const list = await listLibrary();
      return list.includes(SAMPLE_HEVC_MP4) ? list : null;
    }, { timeoutMs: 15000, intervalMs: 500, label: `产物出现在 /api/library` });
    assert.ok(names.includes(SAMPLE_HEVC), '源 MKV 仍应在库中');
  } finally {
    await ctx.close();
  }
});

// ─── ⑨ [RED] 静默失败检测契约：无 error 事件也必须给转码入口 ──
test('⑨ 静默失败检测：videoWidth 恒 0 且全程无 error 时必须自动启动边转边播（不得只依赖 onerror）', async (t) => {
  if (!ffmpegOk) return t.skip('未检测到 ffmpeg，跳过');
  if (!chromiumBrowser) return t.skip('chromium 启动失败，跳过浏览器用例');

  const ctx = await chromiumBrowser.newContext();
  const page = await ctx.newPage();
  try {
    await loginAndOpenBrowse(page, SAMPLE_H264);
    await injectRecorder(page);

    // 实例级 stub：H264+AAC MKV 本可被 chromium 直解（夹具自检保证加载正常），
    // 把 videoWidth/videoHeight 钉死为 0 —— 精确复现 Chromium 对不可解编码的
    // 「demux 成功、canplaythrough 照发、0 帧输出、不抛 error」静默弃轨签名，
    // 使断言与运行环境的解码能力/硬解可用性解耦。
    await page.evaluate(() => {
      const v = document.getElementById('inlinePlayerVideo');
      Object.defineProperty(v, 'videoWidth', { configurable: true, get: () => 0 });
      Object.defineProperty(v, 'videoHeight', { configurable: true, get: () => 0 });
    });

    await page.click(`.video-card[data-name="${SAMPLE_H264}"]`);

    // 夹具自检 1：媒体应正常到达 HAVE_FUTURE_DATA（stub 不影响 demux/加载）
    const reached = await pollUntil(() => page.evaluate(() =>
      document.getElementById('inlinePlayerVideo').readyState >= 3),
    { timeoutMs: 15000, intervalMs: 300 });
    assert.ok(reached, '夹具自检失败：H264+AAC MKV 应正常加载到 readyState>=3（stub 不拦截加载）');

    // 观察窗口：留足实现（canplaythrough 检测 / 点击预判）的触发时机
    await sleep(3000);

    // ── 契约：静默失败签名下必须自动启动边转边播（播放上下文切到 stream:，无需手动按钮） ──
    const onStream = await pollUntil(async () => {
      const cp = await collectCurrentPlay(page);
      return (cp && typeof cp.id === 'string' && cp.id.startsWith('stream:')) ? cp : null;
    }, { timeoutMs: 30000, intervalMs: 400 });
    assert.ok(onStream, [
      '静默失败检测断点：videoWidth=0、readyState>=3 且全程无 error 事件（Chromium 静默弃轨签名），',
      '但未自动启动边转边播（播放上下文未切到 stream:）—— 转码入口不得只依赖 onerror。',
      `终态=${JSON.stringify(await collectPlayerState(page))} cp=${JSON.stringify(await collectCurrentPlay(page))}`,
    ].join(''));

    const st = await collectPlayerState(page);
    const errorFired = st.events.includes('error');
    // 夹具自检 2：本形态静默 —— 不抛 error（这正是 Chromium 最大失败类别的签名）
    assert.ok(!errorFired, `夹具自检失败：本形态不应触发 error 事件（events=${st.events.join(',')}）`);

    // 解除实例级 stub（delete 后回落原型 getter），验证流真实出画面
    await page.evaluate(() => {
      const v = document.getElementById('inlinePlayerVideo');
      delete v.videoWidth;
      delete v.videoHeight;
    });
    const playing = await pollUntil(async () => page.evaluate(() => {
      const v = document.getElementById('inlinePlayerVideo');
      return v.videoWidth > 0 && !v.error ? 1 : null;
    }), { timeoutMs: 30000, intervalMs: 500 });
    assert.ok(playing, [
      '解除 stub 后边转边播流应真实出画面（videoWidth>0、无 error）。',
      `终态=${JSON.stringify(await collectPlayerState(page))}`,
    ].join('；'));
  } finally {
    await ctx.close();
  }
});

// ─── ⑩ [护栏·现状应绿] 服务端半链路：HEVC 源 → 产物必须可播 ──
test('⑩ 服务端半链路护栏：POST HEVC MKV 转码 → 产物 h264/aac mp4 落盘且 ffprobe 可解并入库', async (t) => {
  if (!ffmpegOk) return t.skip('未检测到 ffmpeg，跳过');
  if (!libx265Ok) return t.skip('ffmpeg 无 libx265 编码器，无法生成 HEVC 源，跳过');

  const { ws, frames } = await openSocketIO(token);
  try {
    const res = await api('POST', '/api/transcode', { authToken: token, body: { name: SAMPLE_API } });
    assert.equal(res.status, 200, `POST /api/transcode 应返回 200，实际 ${res.status}: ${JSON.stringify(res.json)}`);
    assert.equal(res.json.output, SAMPLE_API_MP4, '响应应声明产物名 <原名>.mp4');

    await waitFor(() => frames.some((f) => {
      if (!f.startsWith('42["transcode-status",')) return false;
      try { return JSON.parse(f.slice(2))[1]?.status === 'done'; } catch { return false; }
    }), { timeoutMs: 45000, intervalMs: 200, label: 'transcode-status done' });

    const productPath = path.join(userDir, SAMPLE_API_MP4);
    await waitFor(() => fs.existsSync(productPath), { timeoutMs: 10000, intervalMs: 250, label: '产物落盘' });
    assertPlayableMp4(await ffprobeJson(productPath), `⑩ 产物 ${SAMPLE_API_MP4}`);

    await waitFor(async () => (await listLibrary()).includes(SAMPLE_API_MP4),
      { timeoutMs: 15000, intervalMs: 500, label: '产物入库' });
  } finally {
    try { ws.close(); } catch { /* noop */ }
  }
});

// ─── ⑪ [护栏·现状应绿] WebKit onerror 链路回归 ──────
test('⑪ WebKit 回归护栏：WebKit 拒收 MKV → 自动边转边播 → 流可播且产物入库', async (t) => {
  if (!ffmpegOk) return t.skip('未检测到 ffmpeg，跳过');
  if (!webkitBrowser) {
    try {
      const pw = await import('playwright');
      webkitBrowser = await pw.webkit.launch({ headless: true });
    } catch (err) {
      return t.skip(`webkit 启动失败：${err.message.split('\n')[0]}`);
    }
  }

  const ctx = await webkitBrowser.newContext();
  const page = await ctx.newPage();
  const transcodePosts = [];
  page.on('response', (res) => {
    if (res.url().includes('/api/transcode')) {
      transcodePosts.push({ status: res.status() });
    }
  });
  try {
    await loginAndOpenBrowse(page, SAMPLE_WEBKIT);
    await injectRecorder(page);
    await page.click(`.video-card[data-name="${SAMPLE_WEBKIT}"]`);

    // WebKit 不支持 matroska 容器 → onerror/主动预判 → 自动启动边转边播（替代旧手动入口）
    const onStream = await pollUntil(async () => {
      const cp = await collectCurrentPlay(page);
      return (cp && typeof cp.id === 'string' && cp.id.startsWith('stream:')) ? cp : null;
    }, { timeoutMs: 30000, intervalMs: 400 });
    assert.ok(onStream, `WebKit 下点击 MKV 应自动切到边转边播流（播放上下文 stream:）；终态=${JSON.stringify(await collectPlayerState(page))}`);

    await waitFor(() => transcodePosts.length > 0, { timeoutMs: 10000, intervalMs: 200, label: 'POST /api/transcode 发出' });
    assert.equal(transcodePosts[0].status, 200, `POST /api/transcode 应 200，实际 ${transcodePosts[0].status}`);

    // 流可播（WebKit：原生 HLS 或 hls.js 链路）
    const playing = await pollUntil(async () => page.evaluate(() => {
      const v = document.getElementById('inlinePlayerVideo');
      return v.videoWidth > 0 && !v.error ? 1 : null;
    }), { timeoutMs: 40000, intervalMs: 500 });
    assert.ok(playing, `WebKit 边转边播流应出画面（终态=${JSON.stringify(await collectPlayerState(page))}）`);

    // 产物最终入库（服务端半链路在 WebKit 环境同样成立）
    await waitFor(async () => (await listLibrary()).includes(SAMPLE_WEBKIT_MP4),
      { timeoutMs: 30000, intervalMs: 500, label: '⑪ 产物入库' });
  } finally {
    await ctx.close();
  }
});

// ─── ⑫ [护栏·现状应绿] 409 exists 续接：浏览器链路级验收标准⑤ ──
// 场景：产物已存在（如用户重进页面后再次点击转码入口）→ 服务端 409 code=exists/output →
// 前端（player-core.js requestTranscodeAndPlay exists 分支）直接 playLibrary(产物) 续播，
// 不重启转码任务。与 ⑧ 的区别：⑧ 测首次转码 200 → done → 续播；⑫ 测 409 续接半链路。
test('⑫ 409 exists 续接：产物已存在时点击转码入口 → 409 → 直接续播产物 mp4 且不重复启动转码', async (t) => {
  if (!ffmpegOk) return t.skip('未检测到 ffmpeg，跳过');
  if (!libx265Ok) return t.skip('ffmpeg 无 libx265 编码器，无法生成 HEVC 样本，跳过');
  if (!chromiumBrowser) return t.skip('chromium 启动失败，跳过浏览器用例');

  // ── 前置：API 预转码一次完成，制造 exists 场景（产物落盘 + 入库） ──
  const { ws, frames } = await openSocketIO(token);
  try {
    const pre = await api('POST', '/api/transcode', { authToken: token, body: { name: SAMPLE_RESUME } });
    assert.equal(pre.status, 200, `预转码应 200，实际 ${pre.status}: ${JSON.stringify(pre.json)}`);
    await waitFor(() => frames.some((f) => {
      if (!f.startsWith('42["transcode-status",')) return false;
      try { return JSON.parse(f.slice(2))[1]?.status === 'done'; } catch { return false; }
    }), { timeoutMs: 45000, intervalMs: 200, label: '⑫ 预转码 done' });
  } finally {
    try { ws.close(); } catch { /* noop */ }
  }
  const productPath = path.join(userDir, SAMPLE_RESUME_MP4);
  assert.ok(fs.existsSync(productPath), '预转码产物应已落盘');
  assertPlayableMp4(await ffprobeJson(productPath), `⑫ 预转码产物 ${SAMPLE_RESUME_MP4}`);

  // ── exists 基线快照：产物 mtime + 完整日志偏移（「未重复启动转码」断言的对照基线） ──
  const mtimeBefore = fs.statSync(productPath).mtimeMs;
  const logBefore = childLogFull.length;

  const ctx = await chromiumBrowser.newContext();
  const page = await ctx.newPage();
  const transcodePosts = [];
  page.on('response', (res) => {
    if (res.url().includes('/api/transcode')) {
      transcodePosts.push({ status: res.status() });
    }
  });
  try {
    await loginAndOpenBrowse(page, SAMPLE_RESUME);
    await injectRecorder(page);

    // 真实用户动作：点击库中同一 HEVC MKV 卡片（产物 mp4 也在库中，卡片按 data-name 精确匹配）
    await page.click(`.video-card[data-name="${SAMPLE_RESUME}"]`);

    // 新模型：点击即自动 POST；产物已存在 → 409 exists → 前端直接播产物 mp4（播放上下文回 file:）
    // ⚠️ 用播放上下文判定：流式/MSE 下 video.currentSrc 是 blob: URL
    const outcome = await pollUntil(async () => {
      const st = await collectPlayerState(page);
      const cp = await collectCurrentPlay(page);
      if (!cp) return null;
      const src = cp.src || '';
      if (/\.mp4(\?|$)/.test(src) && st.videoWidth > 0 && !st.error) return { kind: 'mp4', st, cp };
      if (typeof cp.id === 'string' && cp.id.startsWith('stream:')) return { kind: 'stream', st, cp };
      if (/\.mkv(\?|$)/.test(src) && st.videoWidth > 0 && !st.error) return { kind: 'direct', st, cp };
      return null;
    }, { timeoutMs: 30000, intervalMs: 400 });
    assert.ok(outcome, `点击卡片后 30s 内未到达任何状态（终态=${JSON.stringify(await collectPlayerState(page))}）`);
    if (outcome.kind === 'direct') {
      return t.skip('本环境 chromium 可直解 HEVC in MKV，409 续接路径不可达，跳过');
    }
    assert.equal(outcome.kind, 'mp4', [
      '产物已存在时应 409 续接直接播产物 mp4（不得重新启动边转边播流）。',
      `实际走了 ${outcome.kind} 路径（cp.src=${outcome.cp.src}）`,
    ].join('；'));

    // ── 断言 1：POST /api/transcode 恰发出一次且被 409 拒绝（产物已存在） ──
    const posted = await waitFor(() => transcodePosts.length > 0 ? transcodePosts[0] : null,
      { timeoutMs: 10000, intervalMs: 200, label: 'POST /api/transcode 发出' });
    assert.equal(posted.status, 409, `产物已存在时 POST 应 409，实际 ${posted.status}`);
    assert.equal(transcodePosts.length, 1,
      `应只发出一次转码请求，实际 ${transcodePosts.length} 次: ${JSON.stringify(transcodePosts)}`);

    // ── 断言 2：409 exists → 前端直接续播产物 mp4（src 切 .mp4 + videoWidth>0 + 无 error，
    //    不等待 transcode-status done —— exists 路径语义就是免转码直接播） ──
    const resumed = await pollUntil(async () => {
      const st = await collectPlayerState(page);
      const cp = await collectCurrentPlay(page);
      const onMp4 = cp && /\.mp4(\?|$)/.test(cp.src || '');
      return (onMp4 && st.videoWidth > 0 && !st.error) ? 1 : null;
    }, { timeoutMs: 20000, intervalMs: 400 });
    assert.ok(resumed, [
      '409 exists 后前端应直接 playLibrary(产物)：src 切 .mp4、videoWidth>0、无 error。',
      `终态=${JSON.stringify(await collectPlayerState(page))}`,
    ].join('；'));

    // ── 断言 3：未重复启动转码 —— 三重证据：单次 409 POST + 产物 mtime 不变 + 无新「开始转码」日志 ──
    await sleep(1500); // 观察窗口：若误重启转码，新日志/二次 POST 将在此窗口内暴露
    assert.equal(transcodePosts.length, 1,
      `观察窗口内不得出现第二次转码请求，实际 ${transcodePosts.length} 次`);
    assert.equal(fs.statSync(productPath).mtimeMs, mtimeBefore,
      '产物 mtime 应不变（未重跑转码重写产物）');
    const newLog = childLogFull.slice(logBefore);
    assert.ok(!newLog.includes(`"name":"${SAMPLE_RESUME}"`),
      `观察窗口内服务端不应有针对 ${SAMPLE_RESUME} 的「开始转码」日志（未重复启动转码），新增日志尾部：${newLog.slice(-500)}`);
  } finally {
    await ctx.close();
  }
});
