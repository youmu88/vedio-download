// ═══════════════════════════════════════════════════════
// 视口校准：iOS standalone（添加到主屏幕）中布局视口高度存在已知偏差
// （documentElement.clientHeight < 物理屏幕高），根画布与 fixed inset:0 层
// 底部会露出 WebView 默认白色。CSS 的 100%/100dvh 均基于该偏差视口，无法自愈，
// 因此用 screen.height（iOS 上即逻辑像素）做一次性校准。
// 仅在检测到偏差时生效（clientHeight < screen.height），正常环境零影响。
// ═══════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', function calibrateViewport() {
  try {
    const doc = document.documentElement;
    const physical = window.screen && window.screen.height;
    if (!physical) return;
    if (doc.clientHeight < physical) {
      doc.style.minHeight = physical + 'px';
    }
  } catch (e) { /* 视口校准失败不阻塞功能 */ }
});

// ═══════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════
const $ = (id) => document.getElementById(id);
const escapeHtml = (s) => {
  if (!s) return '';
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
};
function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
function formatTime(sec) {
  if (!isFinite(sec) || sec < 0) return '00:00';
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
function formatDate(ts) {
  const d = new Date(ts);
  const diff = Date.now() - d;
  if (diff < 60 * 1000) return '刚刚';
  if (diff < 3600 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 24 * 3600 * 1000) return `${Math.floor(diff / 3600000)} 小时前`;
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

// ═══════════════════════════════════════════════════════
// 图标（内联 SVG，Apple 风格）
// ═══════════════════════════════════════════════════════
function icon(name, size = 18) {
  const paths = {
    download: '<circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 8.5v6m0 0l-2.4-2.4M12 14.5l2.4-2.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
    play: '<path d="M8 5.5v13l11-6.5z" fill="currentColor"/>',
    playRect: '<rect x="3" y="5" width="18" height="14" rx="3" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10 9.2v5.6l4.8-2.8z" fill="currentColor"/>',
    gear: '<circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 2.8l1 2.2 2.4-.6 1 2.1 2.3.8-.3 2.4 2 1.2-1.5 1.9 1.5 1.9-2 1.2.3 2.4-2.3.8-1 2.1-2.4-.6-1 2.2-1-2.2-2.4.6-1-2.1-2.3-.8.3-2.4-2-1.2 1.5-1.9L2.3 12l2-1.2-.3-2.4 2.3-.8 1-2.1 2.4.6z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>',
    stop: '<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor"/>',
    retry: '<path d="M4.5 12a7.5 7.5 0 101.6-4.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M4.8 3.5v4.5h4.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
    trash: '<path d="M4.5 6.5h15M9 6.5V4.8a1.3 1.3 0 011.3-1.3h3.4A1.3 1.3 0 0115 4.8v1.7m3 0l-.8 11a1.6 1.6 0 01-1.6 1.5H8.4a1.6 1.6 0 01-1.6-1.5l-.8-11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
    dlFile: '<path d="M12 4v10m0 0l-3.4-3.4M12 14l3.4-3.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 15.5V18a2 2 0 002 2h12a2 2 0 002-2v-2.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
    xmark: '<path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    // SF Symbols style additions
    person: '<circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M4 21c0-5 3.6-9 8-9s8 4 8 9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    folder: '<path d="M2.5 6.5V19c0 .8.7 1.5 1.5 1.5h16c.8 0 1.5-.7 1.5-1.5V8.5c0-.8-.7-1.5-1.5-1.5h-7l-2-3h-7c-.8 0-1.5.7-1.5 1.5z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
    'folder-plus': '<path d="M2.5 6.5V19c0 .8.7 1.5 1.5 1.5h16c.8 0 1.5-.7 1.5-1.5V8.5c0-.8-.7-1.5-1.5-1.5h-7l-2-3h-7c-.8 0-1.5.7-1.5 1.5z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M12 11v6M9 14h6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 11V7a4 4 0 118 0v4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    'lock-open': '<rect x="5" y="11" width="14" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 11V7a4 4 0 018 0" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    square: '<rect x="3" y="3" width="18" height="18" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/>',
    'square-grid': '<rect x="3" y="3" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="14" y="3" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="3" y="14" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="14" y="14" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.6"/>',
    'list-bullet': '<path d="M4 6h16M4 12h16M4 18h16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="4" cy="6" r="1.5" fill="currentColor"/><circle cx="4" cy="12" r="1.5" fill="currentColor"/><circle cx="4" cy="18" r="1.5" fill="currentColor"/>',
    'chevron-left': '<path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    'chevron-down': '<path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    plus: '<path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    'xmark-circle': '<circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M9 9l6 6M15 9l-6 6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    ellipsis: '<circle cx="5" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="19" cy="12" r="1.5" fill="currentColor"/>',
    'arrow-up': '<path d="M12 20V4M5 11l7-7 7 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
    'arrow-down': '<path d="M12 4v16M5 13l7 7 7-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
    film: '<rect x="2" y="3" width="20" height="18" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M2 8h20M2 16h20" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="9" cy="12" r="2" fill="none" stroke="currentColor" stroke-width="1.4"/>',
    checkmark: '<path d="M6 12l4 4 8-8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    'backspace': '<path d="M7 7l10 10M17 7L7 17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    magnifying: '<circle cx="11" cy="11" r="6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M16 16l4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  };
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" aria-hidden="true">${paths[name] || paths.play}</svg>`;
}

// ═══════════════════════════════════════════════════════
// 桌面引擎（iOS 主屏幕：图标启动 App + 返回桌面）
// ═══════════════════════════════════════════════════════
const APP_META = {
  downloads: { title: '视频下载', load: () => {} },
  browse: { title: '视频库', load: () => { loadLibrary(); loadLists(); } },
  settings: { title: '设置', load: () => { loadServerSettings(); } },
  status: { title: '服务器', load: () => { loadHealth(); renderStatusPage(); } },
};
const APP_ORDER = ['downloads', 'browse', 'settings', 'status'];
let activeApp = null;           // 当前打开的 App（null = 桌面）
let privatePageActive = false;  // 私密浏览页（App 内全屏覆盖）

function appTitle(name) { return APP_META[name]?.title || ''; }

function navBackTo(text) {
  $('navBack').innerHTML = icon('chevron-left', 22) + ' ' + text;
}

// App 内直接切换页面（无启动动画，用于私密页退出等场景）
function switchAppTo(name) {
  if (!APP_META[name]) return;
  activeApp = name;
  document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.id === 'page-' + name));
  $('navTitle').textContent = appTitle(name);
  $('navTitle').classList.remove('small');
  $('navBack').hidden = false;
  $('navBack').dataset.back = 'home';
  navBackTo('桌面');
  APP_META[name].load();
  $('mainScroll').scrollTop = 0;
}

// 从图标位置启动 App（iOS 缩放动画）
function launchApp(name) {
  if (!APP_META[name] || privatePageActive) return;
  const icon = document.querySelector(`.home-app[data-app="${name}"]`);
  const stage = $('appStage');
  const r = icon ? icon.getBoundingClientRect() : { left: innerWidth / 2, top: innerHeight / 2, width: 60, height: 60 };
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  activeApp = name;
  document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.id === 'page-' + name));
  $('navTitle').textContent = appTitle(name);
  $('navTitle').classList.remove('small');
  $('navBack').hidden = false;
  $('navBack').dataset.back = 'home';
  navBackTo('桌面');
  $('mainScroll').scrollTop = 0;
  APP_META[name].load();
  $('homeScreen').style.visibility = 'hidden'; // 桌面退场（App 层透明，避免图标透出）
  stage.style.transformOrigin = `${cx}px ${cy}px`;
  stage.style.transform = 'scale(0.12)';
  stage.style.borderRadius = '18px';
  stage.style.transition = 'none';
  stage.hidden = false;
  stage.offsetWidth; // 强制重排，确保起始帧生效
  stage.style.transition = 'transform 0.42s cubic-bezier(0.3,0.85,0.32,1), border-radius 0.42s cubic-bezier(0.3,0.85,0.32,1)';
  stage.style.transform = 'scale(1)';
  stage.style.borderRadius = '0px';
  setTimeout(() => { stage.style.transition = ''; stage.style.transformOrigin = ''; }, 450);
}

// 返回桌面（反向缩放动画收回到图标）
function closeApp() {
  const stage = $('appStage');
  const name = activeApp;
  const icon = document.querySelector(`.home-app[data-app="${name}"]`);
  const r = icon ? icon.getBoundingClientRect() : null;
  const cx = r ? r.left + r.width / 2 : innerWidth / 2;
  const cy = r ? r.top + r.height / 2 : innerHeight / 2;
  $('homeScreen').style.visibility = 'visible'; // 桌面浮现承接收起动画
  stage.style.transformOrigin = `${cx}px ${cy}px`;
  stage.style.transition = 'transform 0.36s cubic-bezier(0.4,0.7,0.4,1), border-radius 0.36s cubic-bezier(0.4,0.7,0.4,1)';
  stage.style.transform = 'scale(0.12)';
  stage.style.borderRadius = '18px';
  setTimeout(() => {
    stage.hidden = true;
    stage.style.transition = '';
    stage.style.transformOrigin = '';
    stage.style.transform = '';
    stage.style.borderRadius = '';
    activeApp = null;
    // 回桌面图标弹跳反馈
    const iconEl = document.querySelector(`.home-app[data-app="${name}"]`);
    if (iconEl) { iconEl.classList.remove('pop'); void iconEl.offsetWidth; iconEl.classList.add('pop'); }
  }, 370);
}

// ── 返回桌面手势（拖动 appStage，桌面在下方缩放浮现）──
let homeSwiping = false;
function homeSwipeBegin() {
  const stage = $('appStage');
  const home = $('homeScreen');
  if (!stage || !home) return false;
  homeSwiping = true;
  swipeActive = true;
  home.style.visibility = 'visible'; // 拖动 App 时桌面在下方露出
  stage.style.transition = 'none';
  stage.style.transform = 'translateX(0px)';
  home.style.transition = 'none';
  home.style.transform = 'scale(0.92)';
  document.documentElement.style.touchAction = 'none';
  document.body.style.overflow = 'hidden';
  return true;
}
function homeSwipeMove(dx) {
  const w = innerWidth;
  const p = Math.min(Math.max(dx, 0) / w, 1);
  const ease = 1 - Math.pow(1 - p, 2.2); // iOS 式轻微缓动
  $('appStage').style.transform = `translateX(${dx * 0.92}px)`;
  $('homeScreen').style.transform = `scale(${0.92 + ease * 0.08})`;
}
function homeSwipeFinish(commit) {
  const stage = $('appStage');
  const home = $('homeScreen');
  const appName = activeApp;
  if (commit) {
    stage.style.transition = 'transform 0.34s var(--spring-settle)';
    stage.style.transform = 'translateX(100%)';
    home.style.transition = 'transform 0.34s var(--spring-settle)';
    home.style.transform = 'scale(1)';
    setTimeout(() => {
      stage.hidden = true;
      stage.style.transition = ''; stage.style.transform = '';
      home.style.transition = ''; home.style.transform = '';
      activeApp = null;
      homeSwiping = false;
      swipeActive = false;
      document.documentElement.style.touchAction = '';
      document.body.style.overflow = '';
      const iconEl = document.querySelector(`.home-app[data-app="${appName}"]`);
      if (iconEl) { iconEl.classList.remove('pop'); void iconEl.offsetWidth; iconEl.classList.add('pop'); }
    }, 350);
  } else {
    stage.style.transition = 'transform 0.28s var(--spring-settle)';
    stage.style.transform = 'translateX(0)';
    home.style.transition = 'transform 0.28s var(--spring-settle)';
    home.style.transform = 'scale(1)';
    setTimeout(() => {
      homeSwiping = false; swipeActive = false;
      home.style.visibility = 'hidden'; // 取消返回：桌面重新退场
      document.documentElement.style.touchAction = ''; document.body.style.overflow = '';
    }, 300);
  }
}

// 大标题滚动动画：滚动时标题从 34px 缩为 17px
function initNavScroll() {
  try {
    const main = $('mainScroll');
    const title = $('navTitle');
    if (!main || !title) return;
    let ticking = false;
    main.addEventListener('scroll', () => {
      if (!ticking) {
        requestAnimationFrame(() => {
          const y = main.scrollTop;
          title.classList.toggle('small', y > 20);
          ticking = false;
        });
        ticking = true;
      }
    }, { passive: true });
  } catch (_) {}
}

// ═══════════════════════════════════════════════════════
// 设置持久化（本地 + 服务端）
// ═══════════════════════════════════════════════════════
const SETTINGS_KEY = 'vd.settings.v2';
const defaultSettings = {
  theme: 'auto', wallpaper: 'default', engine: 'auto', format: 'auto',
  parallel: false, parallelCount: 4, maxSpeedMB: 0, timeoutMin: 30, libraryView: 'grid',
};
function loadSettings() {
  try { return { ...defaultSettings, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; }
  catch { return { ...defaultSettings }; }
}
function saveSettings() { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }
let settings = loadSettings();

function applyTheme() {
  const dark = settings.theme === 'dark' ||
    (settings.theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  document.querySelector('meta[name="theme-color"]').setAttribute('content', dark ? '#000000' : '#F2F2F7');
  document.querySelectorAll('#themeSeg button').forEach(b => b.classList.toggle('active', b.dataset.themeOpt === settings.theme));
}
function applyWallpaper() {
  const name = settings.wallpaper || 'default';
  document.documentElement.className = 'wallpaper-' + name;
  document.querySelectorAll('#wallpaperPicker .swatch').forEach((s) => s.classList.toggle('active', s.dataset.wallpaper === name));
}
const ENGINE_OPTIONS = [
  { v: 'auto', label: '自动选择' },
  { v: 'n_m3u8dl_re', label: 'N_m3u8DL-RE' },
  { v: 'ffmpeg', label: 'ffmpeg' },
  { v: 'js', label: 'JS 原生' },
];
const FORMAT_OPTIONS = [
  { v: 'auto', label: '自动' },
  { v: 'mp4', label: 'MP4' },
  { v: 'ts', label: 'TS' },
  { v: 'mkv', label: 'MKV' },
];

function renderSettingsForm() {
  $('engineValue').textContent = ENGINE_OPTIONS.find(o => o.v === settings.engine)?.label || settings.engine;
  $('formatValue').textContent = FORMAT_OPTIONS.find(o => o.v === settings.format)?.label || settings.format;
  $('parallelSwitch').checked = settings.parallel;
  $('parallelCountInput').value = settings.parallelCount;
  $('maxSpeedInput').value = settings.maxSpeedMB;
  $('timeoutInput').value = settings.timeoutMin;
}
function bindSettingsForm() {
  $('themeSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    settings.theme = btn.dataset.themeOpt;
    saveSettings(); applyTheme();
  });
  $('wallpaperPicker').addEventListener('click', (e) => {
    const btn = e.target.closest('.swatch');
    if (!btn) return;
    settings.wallpaper = btn.dataset.wallpaper;
    saveSettings(); applyWallpaper();
  });
  $('parallelSwitch').addEventListener('change', (e) => { settings.parallel = e.target.checked; saveSettings(); });
  $('parallelCountInput').addEventListener('change', (e) => { settings.parallelCount = Math.min(16, Math.max(1, parseInt(e.target.value, 10) || 4)); e.target.value = settings.parallelCount; saveSettings(); });
  $('maxSpeedInput').addEventListener('change', (e) => { settings.maxSpeedMB = Math.max(0, parseFloat(e.target.value) || 0); e.target.value = settings.maxSpeedMB; saveSettings(); });
  $('timeoutInput').addEventListener('change', (e) => { settings.timeoutMin = Math.min(600, Math.max(1, parseInt(e.target.value, 10) || 30)); e.target.value = settings.timeoutMin; saveSettings(); });
  $('libraryViewToggle').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    settings.libraryView = btn.dataset.view;
    saveSettings();
    document.querySelectorAll('#libraryViewToggle button').forEach(b => b.classList.toggle('active', b.dataset.view === settings.libraryView));
    renderBrowse();
  });
}

// iOS 风格：点击设置行弹 Action Sheet 选择器
function openEnginePicker() {
  openSheet(`
    <div class="sheet-head"><span class="sheet-title">下载引擎</span><button class="sheet-close" onclick="closeSheet()">${icon('xmark', 16)}</button></div>
    <div class="sheet-body">
      <div class="sheet-options">
        ${ENGINE_OPTIONS.map(o => `<button class="sheet-option${settings.engine === o.v ? ' selected' : ''}" onclick="pickEngine('${o.v}')">${o.label}</button>`).join('')}
      </div>
    </div>`);
}
function pickEngine(v) { settings.engine = v; saveSettings(); renderSettingsForm(); closeSheet(); }
function openFormatPicker() {
  openSheet(`
    <div class="sheet-head"><span class="sheet-title">输出格式</span><button class="sheet-close" onclick="closeSheet()">${icon('xmark', 16)}</button></div>
    <div class="sheet-body">
      <div class="sheet-options">
        ${FORMAT_OPTIONS.map(o => `<button class="sheet-option${settings.format === o.v ? ' selected' : ''}" onclick="pickFormat('${o.v}')">${o.label}</button>`).join('')}
      </div>
    </div>`);
}
function pickFormat(v) { settings.format = v; saveSettings(); renderSettingsForm(); closeSheet(); }

async function loadServerSettings() {
  try {
    const res = await fetch('/api/settings');
    if (res.ok) {
      const data = await res.json();
      $('parallelDownloadsInput').value = data.maxConcurrent ?? 3;
    }
  } catch {}
}
async function saveServerSettings() {
  const value = Math.min(10, Math.max(1, parseInt($('parallelDownloadsInput').value, 10) || 3));
  $('parallelDownloadsInput').value = value;
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxConcurrent: value }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      showToast(data.error || '保存失败', true);
      return;
    }
    showToast(`并行下载数已设为 ${value}`);
  } catch (err) { showToast(err.message, true); }
}

// ═══════════════════════════════════════════════════════
// 播放记录
// ═══════════════════════════════════════════════════════
const HISTORY_KEY = 'vd.history.v2';
function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); }
  catch { return []; }
}
let history = loadHistory();
function saveHistory() { localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 50))); }
function upsertHistory(entry) {
  history = history.filter(h => h.id !== entry.id);
  history.unshift(entry);
  saveHistory();
}
function removeHistory(id) {
  history = history.filter(h => h.id !== id);
  saveHistory();
}

// ═══════════════════════════════════════════════════════
// Socket.IO 连接
// ═══════════════════════════════════════════════════════
const socket = io(window.location.origin, {
  transports: ['websocket', 'polling'],
  auth: (cb) => cb({ token: getAuthToken() }),
});
socket.on('connect', () => {
  document.querySelectorAll('.nav-conn').forEach(d => d.className = 'nav-conn on');
  loadTasks();
});
socket.on('disconnect', () => document.querySelectorAll('.nav-conn').forEach(d => d.className = 'nav-conn off'));
socket.on('task-status', (task) => updateTaskCard(task));
socket.on('task-list-update', (tasks) => renderTasks(tasks));
socket.on('task-finalized', ({ taskId }) => socket.emit('unsubscribe', taskId));

// ═══════════════════════════════════════════════════════
// 下载页：提交任务
// ═══════════════════════════════════════════════════════
async function submitDownload() {
  const input = $('urlInput');
  const btn = $('downloadBtn');
  const url = input.value.trim();
  if (!url) { input.focus(); return; }
  if (!/^https?:\/\//i.test(url)) { showToast('请输入以 http(s):// 开头的链接'); input.focus(); return; }
  btn.disabled = true;
  btn.textContent = '提交中…';
  try {
    const res = await fetch('/api/download/advanced', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        engine: settings.engine,
        format: settings.format,
        parallel: settings.parallel,
        parallelCount: settings.parallelCount,
        maxSpeed: Math.round(settings.maxSpeedMB * 1024 * 1024),
        timeoutMs: settings.timeoutMin * 60 * 1000,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
    input.value = '';
    socket.emit('subscribe', data.taskId);
    loadTasks();
    showToast('任务已创建，开始解析');
  } catch (err) {
    showToast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '下载';
  }
}

async function loadTasks() {
  try {
    const res = await fetch('/api/tasks');
    if (res.ok) renderTasks(await res.json());
  } catch {}
}

async function actionTask(taskId, action) {
  const map = {
    stop: ['POST', `/api/task/${taskId}/cancel`, '已停止，可续跑'],
    retry: ['POST', `/api/task/${taskId}/retry`, '已重新加入队列'],
    delete: ['DELETE', `/api/task/${taskId}`, '已删除'],
  };
  const [method, url, okMsg] = map[action];
  try {
    const res = await fetch(url, { method });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '操作失败');
    showToast(okMsg);
    if (action === 'retry') socket.emit('subscribe', taskId);
    loadTasks();
  } catch (err) { showToast(err.message, true); }
}

const STATUS_TEXT = {
  created: ['排队中', ''],
  running: ['进行中', 'running'],
  completed: ['已完成', 'completed'],
  failed: ['失败', 'failed'],
  cancelled: ['已停止', 'cancelled'],
};

function buildTaskRow(task) {
  const status = task.status || 'created';
  const [statusText, cls] = STATUS_TEXT[status] || [status, ''];
  const progress = Math.max(0, Math.min(100, task.progress || 0));
  const actions = [];
  if (status === 'created' || status === 'running') actions.push(`<button class="icon-btn danger" title="停止" onclick="actionTask('${task.id}','stop')">${icon('stop', 18)}</button>`);
  if (status === 'failed' || status === 'cancelled') actions.push(`<button class="icon-btn" title="重试" onclick="actionTask('${task.id}','retry')">${icon('retry', 18)}</button>`);
  actions.push(`<button class="icon-btn danger" title="删除" onclick="actionTask('${task.id}','delete')">${icon('trash', 18)}</button>`);
  if (status === 'completed' && task.outputFile) {
    const name = task.outputFile.split('/').pop();
    actions.push(`<button class="icon-btn green" title="播放文件" onclick="playLibrary('${name.replace(/'/g, "\\'")}')">${icon('play', 18)}</button>`);
  }
  const metaParts = [];
  metaParts.push(`<span class="task-status ${cls}">${statusText}</span>`);
  if (task.progress != null) metaParts.push(`<span>${Math.round(progress)}%</span>`);
  if (task.speed) metaParts.push(`<span>${escapeHtml(task.speed)}</span>`);
  if (task.outputSizeBytes) metaParts.push(`<span>${formatBytes(task.outputSizeBytes)}</span>`);
  const errorHtml = task.error ? `<div class="task-error">${icon('xmark-circle', 14)} ${escapeHtml(task.error)}</div>` : '';
  return `
    <div class="row task-row" data-id="${task.id}">
      <div class="task-icon ${cls}">${status === 'completed' ? icon('dlFile', 17) : status === 'failed' ? icon('xmark', 17) : icon('download', 17)}</div>
      <div class="task-main">
        <div class="task-url" title="${escapeHtml(task.url)}">${escapeHtml(task.url)}</div>
        <div class="task-meta">${metaParts.join('')}</div>
        ${task.message ? `<div class="task-message" title="${escapeHtml(task.message)}">${escapeHtml(task.message)}</div>` : ''}
        <div class="task-progress"><i class="${cls}" style="width:${progress}%"></i></div>
        ${errorHtml}
      </div>
      <div class="task-actions">${actions.join('')}</div>
    </div>`;
}

function renderTasks(tasks) {
  const list = $('taskList');
  $('taskCount').textContent = tasks.length ? `(${tasks.length})` : '';
  $('cleanCompletedBtn').hidden = !tasks.some(t => t.status === 'completed');
  if (!tasks.length) {
    list.innerHTML = '<div class="empty"><div class="big">' + icon('download', 44) + '</div>还没有下载任务</div>';
    return;
  }
  const sorted = [...tasks].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  list.innerHTML = sorted.map(buildTaskRow).join('');
}

function updateTaskCard(task) {
  const list = $('taskList');
  const rows = [...list.querySelectorAll('.task-row')];
  const idx = rows.findIndex(r => r.dataset.id === task.id);
  if (idx !== -1) {
    const tmp = document.createElement('div');
    tmp.innerHTML = buildTaskRow(task);
    list.replaceChild(tmp.firstElementChild, rows[idx]);
  } else {
    loadTasks();
  }
}

// ═══════════════════════════════════════════════════════
// 浏览页：视频库 + 文件夹导航 + 播放
// ═══════════════════════════════════════════════════════
let libraryFiles = [];
let browseFolder = null;
let myLists = [];
let myPrivateLists = [];
// ═══════════════════════════════════════════════════════
// 浏览页：文件夹导航 + 渲染
// ═══════════════════════════════════════════════════════
async function loadLibrary() {
  try {
    const res = await fetch('/api/library');
    if (!res.ok) throw new Error();
    libraryFiles = await res.json();
    renderBrowse();
  } catch {
    $('libraryGrid').innerHTML = '<div class="empty"><div class="big">' + icon('xmark-circle', 44) + '</div>视频库读取失败</div>';
  }
}

function renderBrowse() {
  const grid = $('libraryGrid');
  const folderEl = $('folderGrid');
  const crumb = $('browseCrumb');
  const isList = browseFolder && browseFolder.id;
  const view = settings.libraryView || 'grid';

  if (isList) {
    crumb.innerHTML = `<button class="folder-back" onclick="backToRoot()">${icon('chevron-left', 16)} 返回</button> ${escapeHtml(browseFolder.name)}`;
    folderEl.hidden = true;
    renderListVideos({
      grid, count: $('libraryCount'), folder: browseFolder,
      nameAttr: 'data-name', rmAttr: 'data-rm-list', isPrivate: false,
    });
    return;
  }
  crumb.innerHTML = '';
  $('libraryCount').textContent = '';
  folderEl.hidden = false;
  renderRootFolders();
  renderLibraryGrid(libraryFiles, grid, view);
}

function renderRootFolders() {
  const el = $('folderGrid');
  const pubs = myLists.map((l) => `
    <div class="folder-card" data-enter="list" data-id="${l.id}" data-name="${escapeHtml(l.name)}" onclick="enterListFolder('${l.id}','${escapeHtml(l.name).replace(/'/g, "\\'")}',false)">
      <div class="folder-icon">${icon('folder', 24)}</div>
      <div class="folder-name">${escapeHtml(l.name)}</div>
      <div class="folder-meta">${l.items.length} 个视频</div>
    </div>`).join('');
  const newCard = `<div class="folder-card" data-new="1" onclick="openCreateList(false)">
        <div class="folder-icon" style="background:var(--fill);color:var(--accent);">${icon('plus', 24)}</div>
        <div class="folder-name" style="color:var(--accent);">新建列表</div>
        <div class="folder-meta">按主题创建列表，将视频加入</div>
      </div>`;
  el.innerHTML = (pubs || '<div class="folder-card" style="cursor:default;"><div class="folder-meta">暂无公开列表</div></div>') + newCard;
}

function renderLibraryGrid(files, grid, view) {
  grid.className = view === 'list' ? 'library-list' : 'library-grid';
  if (!files.length) {
    grid.innerHTML = '<div class="empty" style="grid-column:1/-1;"><div class="big">' + icon('film', 44) + '</div>视频库为空<br>下载完成后会出现在这里</div>';
    return;
  }
  grid.innerHTML = files.map((f) => {
    const pct = libraryProgress(f.name);
    const progressHtml = pct === null ? '' : view === 'list'
      ? `<div class="video-progress">${pct}%</div>`
      : `<span class="video-progress">${pct}%</span>`;
    const sel = selectionMode ? `<span class="sel-check">${icon('checkmark', 14)}</span>` : '';
    const selCls = selectionMode && selectedSet.has(f.name) ? ' selected' : '';
    if (view === 'list') {
      return `
      <div class="video-card${selCls}" data-name="${escapeHtml(f.name)}" onclick="onVideoCardTap('${escapeHtml(f.name).replace(/'/g, "\\'")}')">
        ${sel}
        <div class="video-thumb"><span class="play-badge">${icon('play', 16)}</span></div>
        <div class="video-info">
          <div class="video-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</div>
          <div class="video-meta">${formatBytes(f.size)} · ${formatDate(f.mtime)}</div>
          ${progressHtml}
        </div>
        <button class="video-delete" data-delete-name="${escapeHtml(f.name)}" onclick="event.stopPropagation();deleteVideo('${escapeHtml(f.name).replace(/'/g, "\\'")}')">${icon('trash', 15)}</button>
      </div>`;
    }
    return `
    <div class="video-card${selCls}" data-name="${escapeHtml(f.name)}" onclick="onVideoCardTap('${escapeHtml(f.name).replace(/'/g, "\\'")}')">
      ${sel}
      <div class="video-thumb">
        <span class="play-badge">${icon('play', 20)}</span>
        ${progressHtml}
        <button class="video-delete" data-delete-name="${escapeHtml(f.name)}" onclick="event.stopPropagation();deleteVideo('${escapeHtml(f.name).replace(/'/g, "\\'")}')">${icon('trash', 14)}</button>
      </div>
      <div class="video-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</div>
      <div class="video-meta">${formatBytes(f.size)} · ${formatDate(f.mtime)}</div>
    </div>`;
  }).join('');
}

/** iOS 卡片点击：选择模式下切换选中，否则播放 */
function onVideoCardTap(name) {
  if (selectionMode) { toggleSelect(name); return; }
  playLibrary(name);
}

async function renderListVideos({ grid, count, folder, nameAttr, rmAttr, isPrivate, onLoaded }) {
  const view = settings.libraryView || 'grid';
  grid.className = view === 'list' ? 'library-list' : 'library-grid';
  if (count) count.textContent = '';
  let items = [];
  try {
    const res = isPrivate
      ? await privateFetch(`/api/lists/${folder.id}`, {}, onLoaded)
      : await fetch(`/api/lists/${folder.id}`);
    if (res === null) return;
    if (res.ok) {
      const list = await res.json();
      items = list.items || [];
    }
  } catch (_) {}
  if (!items.length) {
    grid.innerHTML = '    <div class="empty" style="grid-column:1/-1;"><div class="big">' + icon('folder', 44) + '</div>列表为空<br>在浏览页选择视频后可加入</div>';
    return;
  }
  grid.innerHTML = items.map((i) => {
    const pct = libraryProgress(i.name);
    const progressHtml = pct === null ? '' : view === 'list'
      ? `<div class="video-progress">${pct}%</div>`
      : `<span class="video-progress">${pct}%</span>`;
    const meta = [i.size ? formatBytes(i.size) : '', i.mtime ? formatDate(i.mtime) : '', i.addedAt ? formatDate(i.addedAt) + ' 加入' : ''].filter(Boolean).join(' · ');
    const playOn = `onclick="${isPrivate ? "playPrivateVideo" : "playLibrary"}('${escapeHtml(i.name).replace(/'/g, "\\'")}')"`;
    if (view === 'list') {
      return `
      <div class="video-card" ${nameAttr}="${escapeHtml(i.name)}" ${playOn}>
        <div class="video-thumb"><span class="play-badge">${icon('play', 16)}</span>${progressHtml}</div>
        <div class="video-info">
          <div class="video-name" title="${escapeHtml(i.name)}">${escapeHtml(i.name)}</div>
          <div class="video-meta">${meta}</div>
        </div>
        <button class="video-delete" ${rmAttr}="${folder.id}|${escapeHtml(i.name)}" onclick="event.stopPropagation();removeListVideo('${folder.id}','${escapeHtml(i.name).replace(/'/g, "\\'")}',${isPrivate})">${icon('trash', 15)}</button>
      </div>`;
    }
    return `
    <div class="video-card" ${nameAttr}="${escapeHtml(i.name)}" ${playOn}>
      <div class="video-thumb">
        <span class="play-badge">${icon('play', 20)}</span>
        ${progressHtml}
        <button class="video-delete" ${rmAttr}="${folder.id}|${escapeHtml(i.name)}" onclick="event.stopPropagation();removeListVideo('${folder.id}','${escapeHtml(i.name).replace(/'/g, "\\'")}',${isPrivate})">${icon('trash', 14)}</button>
      </div>
      <div class="video-name" title="${escapeHtml(i.name)}">${escapeHtml(i.name)}</div>
      <div class="video-meta">${meta}</div>
    </div>`;
  }).join('');
}

function enterListFolder(id, name, isPrivate) {
  browseFolder = { id, name, isPrivate };
  renderBrowse();
}
function backToRoot() { browseFolder = null; renderBrowse(); }

async function removeListVideo(folderId, name, isPrivate) {
  try {
    const opts = {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ names: [name] }),
    };
    const res = isPrivate
      ? await privateFetch(`/api/lists/${folderId}/items`, opts, () => removeListVideo(folderId, name, isPrivate))
      : await fetch(`/api/lists/${folderId}/items`, opts);
    if (res === null) return;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '移除失败');
    showToast('已从列表移除');
    loadLists();
    loadLibrary();
  } catch (err) { showToast(err.message, true); }
}

function libraryProgress(name) {
  const h = history.find(x => x.id === 'file:' + name);
  if (!h || !h.duration) return null;
  return Math.min(100, Math.round((h.time / h.duration) * 100));
}

function renderLibrary(files) { renderBrowse(); }

async function deleteVideo(name) {
  showActionSheet({
    title: '删除视频',
    message: `「${name}」删除后无法恢复。`,
    confirmText: '删除',
    onConfirm: async () => {
      try {
        const res = await fetch(`/api/library/${encodeURIComponent(name)}`, { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '删除失败');
        removeHistory('file:' + name);
        showToast('已删除');
        loadLibrary();
      } catch (err) { showToast(err.message, true); }
    },
  });
}

// ═══════════════════════════════════════════════════════
// 播放器核心（HLS + 缓存优先 + 进度保存）
// ═══════════════════════════════════════════════════════
let hls = null;
let currentPlay = null;
let lastSaveTime = 0;
let userPaused = false;
let playSession = 0;      // 播放会话代际：异步回调代际不匹配时丢弃，防止切换竞态
let activeBlobUrl = null;  // 当前播放的 blob URL（切换/关闭时 revoke 防泄漏）

function openPlayer(title, src, id, target = 'browse') {
  const pfx = target === 'private' ? 'private' : '';
  const box = $(pfx ? 'privateInlinePlayer' : 'inlinePlayer');
  const titleEl = $(pfx ? 'privateInlinePlayerTitle' : 'inlinePlayerTitle');
  const video = $(pfx ? 'privateInlinePlayerVideo' : 'inlinePlayerVideo');
  if (target === 'private') {
    // 确保私密页可见但不重新渲染列表（避免打断播放）
    privatePageActive = true;
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    $('page-private').classList.add('active');
    $('navTitle').textContent = '私密列表';
    $('navTitle').classList.add('small');
    $('navBack').hidden = false;
    $('navBack').dataset.back = 'private:home';
  } else {
    switchAppTo('browse');
  }
  titleEl.textContent = title;
  box.hidden = false;
  userPaused = false;
  if (currentPlay) upsertHistory({ ...currentPlay, updatedAt: Date.now() });
  currentPlay = { id, title, src, time: 0, duration: 0, updatedAt: Date.now() };

  if (hls) { hls.destroy(); hls = null; }
  video.pause();
  video.removeAttribute('src');
  video.load();
  // ⚠️ 会话代际：本次播放的唯一标识，异步回调（mediaCache.get / hls 事件）
  // 必须代际匹配才生效，防止快速切换视频时旧回调覆盖新视频状态
  const session = ++playSession;
  if (activeBlobUrl) { URL.revokeObjectURL(activeBlobUrl); activeBlobUrl = null; }

  const isHls = /\.m3u8($|\?)/i.test(src);
  if (isHls && window.Hls && Hls.isSupported()) {
    // ⚠️ 使用局部 hlsInst 引用（而非全局 hls）：快速切换后全局 hls 已指向新实例，
    // 旧实例的 ERROR 事件若引用全局 hls 会误操作新实例
    const hlsInst = new Hls({ enableWorker: true, maxBufferLength: 60, fLoader: CachedFragmentLoader });
    hls = hlsInst;
    let fatalNetErrors = 0;
    hlsInst.loadSource(src);
    hlsInst.attachMedia(video);
    hlsInst.on(Hls.Events.ERROR, (_e, data) => {
      if (session !== playSession) return; // 已切换到其他视频，忽略过期事件
      if (data.fatal) {
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          // 退避重试：连续网络错误超过 3 次则放弃，避免无限 startLoad 重试卡死
          fatalNetErrors++;
          if (fatalNetErrors >= 3) {
            showToast('播放失败：网络不稳定，请重试', true);
            if (hlsInst) { hlsInst.destroy(); if (hls === hlsInst) hls = null; }
            return;
          }
          setTimeout(() => {
            if (session === playSession && hls === hlsInst) hlsInst.startLoad();
          }, Math.min(500 * fatalNetErrors, 2000));
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          hlsInst.recoverMediaError();
        } else {
          showToast('播放失败：流地址不可用', true);
        }
      }
    });
    // 启动预加载
    preloadManager.start(hlsInst);
    // 缓存状态指示器：更新缓存按钮标题
    preloadManager.onStatusUpdate((status) => {
      const btn = $(pfx ? 'privateCacheMenuBtn' : 'cacheMenuBtn');
      if (!btn) return;
      if (status.cached >= status.total) {
        btn.title = '全部已缓存 ✓';
        btn.classList.add('cached');
      } else if (status.cached + status.preloaded >= status.total) {
        btn.title = '已预加载 ' + (status.cached + status.preloaded) + '/' + status.total;
      } else if (status.cached > 0 || status.preloaded > 0) {
        btn.title = '已缓存 ' + status.cached + '/' + status.total + ' · 预加载 ' + status.preloaded;
      }
    });
  } else {
    // 非 HLS 流（mp4 直链），检查缓存
    mediaCache.get(src).then(cached => {
      if (session !== playSession) return; // 已切换视频，丢弃过期回调
      if (cached && cached.data) {
        const blob = cached.data instanceof Blob ? cached.data : new Blob([cached.data]);
        activeBlobUrl = URL.createObjectURL(blob);
        video.src = activeBlobUrl;
      } else {
        video.src = src;
      }
    });
  }

  const prev = history.find(h => h.id === id);
  video.onloadedmetadata = () => {
    if (session !== playSession || !currentPlay) return;
    currentPlay.duration = video.duration || 0;
    if (prev && prev.time > 3 && prev.time < (video.duration || Infinity) - 5) {
      video.currentTime = prev.time;
    }
    if (!userPaused) video.play().catch(() => {});
  };
  video.ontimeupdate = () => {
    if (session !== playSession || !currentPlay) return;
    currentPlay.time = video.currentTime || 0;
    currentPlay.duration = video.duration || 0;
    const now = Date.now();
    if (now - lastSaveTime > 5000) {
      lastSaveTime = now;
      upsertHistory({ ...currentPlay, updatedAt: now });
    }
  };
  video.onpause = () => { if (session === playSession && currentPlay) upsertHistory({ ...currentPlay, updatedAt: Date.now() }); };
  video.onended = () => {
    if (session !== playSession || !currentPlay) return;
    currentPlay.time = currentPlay.duration;
    upsertHistory({ ...currentPlay, updatedAt: Date.now() });
  };
  video.onerror = () => { if (session === playSession) showToast('播放失败：请确认链接可访问且格式受支持', true); };
}

function closePlayer(target = 'browse') {
  const pfx = target === 'private' ? 'private' : '';
  const box = $(pfx ? 'privateInlinePlayer' : 'inlinePlayer');
  const video = $(pfx ? 'privateInlinePlayerVideo' : 'inlinePlayerVideo');
  playSession++; // 使所有在途异步回调失效
  if (currentPlay) upsertHistory({ ...currentPlay, updatedAt: Date.now() });
  currentPlay = null;
  if (hls) { hls.destroy(); hls = null; }
  preloadManager.stop();
  // 回收 blob URL 防泄漏
  if (activeBlobUrl) { URL.revokeObjectURL(activeBlobUrl); activeBlobUrl = null; }
  // 恢复缓存按钮默认标题
  const b = $(pfx ? 'privateCacheMenuBtn' : 'cacheMenuBtn');
  if (b) { b.title = '缓存视频'; b.classList.remove('cached'); }
  video.pause();
  video.removeAttribute('src');
  video.load();
  box.hidden = true;
  if (target === 'browse') loadLibrary();
}
function closePrivatePlayerOnly() { closePlayer('private'); }

function playLibrary(name) {
  const tk = getAuthToken();
  const q = tk ? `?token=${encodeURIComponent(tk)}` : '';
  openPlayer(name, `/downloads/${encodeURIComponent(name)}${q}`, `file:${name}`);
}

/** 私密 App 内播放：保持私密上下文（私密播放器） */
function playPrivateVideo(name) {
  const tk = getAuthToken();
  const q = tk ? `?token=${encodeURIComponent(tk)}` : '';
  openPlayer(name, `/downloads/${encodeURIComponent(name)}${q}`, `file:${name}`, 'private');
}

function playUrl() {
  const url = $('playUrlInput').value.trim();
  if (!/^https?:\/\//i.test(url)) { showToast('请输入有效的 http(s) 链接', true); return; }
  switchAppTo('browse');
  openPlayer(url, url, `url:${url}`);
}

// ═══════════════════════════════════════════════════════
// 服务器状态 App（图标启动）
// ═══════════════════════════════════════════════════════
function renderStatusPage() {
  const u = getAuthUser();
  const su = $('statusUser'); if (su) su.textContent = u || '—';
  const on = socket && socket.connected;
  const dot = $('statusConnDot'); if (dot) dot.className = 'status-dot ' + (on ? 'ok' : 'no');
  const txt = $('statusConnText'); if (txt) txt.textContent = on ? '已连接' : '已断开';
  refreshCacheStats(document.getElementById('statusCacheStats'));
}
socket.on('connect', renderStatusPage);
socket.on('disconnect', renderStatusPage);

// ═══════════════════════════════════════════════════════
// 设置页：服务状态
// ═══════════════════════════════════════════════════════
async function loadHealth() {
  try {
    const res = await fetch('/api/health');
    if (!res.ok) throw new Error();
    const h = await res.json();
    $('healthVersion').textContent = h.version || '—';
    $('healthUptime').textContent = `${Math.floor(h.uptime / 60)} 分钟`;
    $('healthQueue').textContent = `${h.tasks.queued} / ${h.tasks.running}（上限 ${h.tasks.maxConcurrent}）`;
    const eng = h.engines || {};
    $('healthEngines').innerHTML = `${statusTag(eng.ffmpeg, 'ffmpeg')}  ${statusTag(eng.ffprobe, 'ffprobe')}`;
    $('healthNre').innerHTML = statusTag(eng.n_m3u8dl_re, 'N_m3u8DL-RE');
    $('healthDisk').textContent = h.disk || '—';
  } catch {}
}
// iOS 风格状态标签：绿色「可用」/ 红色「不可用」文字
function statusTag(ok, name) {
  return `<span style="color:${ok ? 'var(--green)' : 'var(--red)'};font-weight:600;">${ok ? '✓' : '✕'} ${name}</span>`;
}

// ═══════════════════════════════════════════════════════
// Toast / Sheet 弹窗
// ═══════════════════════════════════════════════════════
let toastTimer = null;
function showToast(msg, isError = false) {
  let t = document.querySelector('.toast');
  if (!t) {
    t = document.createElement('div');
    t.className = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.toggle('error', isError);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
}

const sheetMask = $('sheetMask');
const sheetCard = $('sheetCard');
function openSheet(html) {
  sheetCard.innerHTML = html;
  sheetMask.hidden = false;
}
function closeSheet() {
  sheetMask.hidden = true;
  sheetCard.innerHTML = '';
}
sheetMask.addEventListener('click', (e) => { if (e.target === sheetMask) closeSheet(); });

function showActionSheet({ title, message, confirmText = '删除', cancelText = '取消', danger = true, onConfirm }) {
  openSheet(`
    <div class="action-sheet">
      <div class="as-title">${title}</div>
      <div class="as-message">${message}</div>
      <button class="as-btn ${danger ? 'danger' : ''}" id="asConfirm">${confirmText}</button>
      <button class="as-btn cancel" onclick="closeSheet()">${cancelText}</button>
    </div>`);
  $('asConfirm').addEventListener('click', () => { closeSheet(); onConfirm && onConfirm(); });
}

// ═══════════════════════════════════════════════════════
// 下载页：一键清理已完成
// ═══════════════════════════════════════════════════════
async function cleanCompleted() {
  try {
    const res = await fetch('/api/tasks/clean-completed', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '清理失败');
    showToast(`已清理 ${data.removed || 0} 条已完成记录`);
    loadTasks();
  } catch (err) { showToast(err.message, true); }
}

// ═══════════════════════════════════════════════════════
// 列表数据 + 选择模式 + 批量操作
// ═══════════════════════════════════════════════════════
let selectionMode = false;
let selectedSet = new Set();

async function loadLists() {
  try {
    const res = await fetch('/api/lists');
    if (!res.ok) return;
    const data = await res.json();
    myLists = data.lists || [];
    if (data.hasPrivate && getPrivateToken()) loadPrivateLists();
    renderBrowse();
  } catch {}
}
async function loadPrivateLists() {
  try {
    const res = await privateFetch('/api/private/lists', {}, () => loadPrivateLists());
    if (res === null) return;
    if (res.ok) myPrivateLists = (await res.json()).lists || [];
  } catch {}
}

function enterSelectionMode() {
  selectionMode = true;
  selectedSet.clear();
  $('selectModeBtn').textContent = '取消';
  $('batchBar').hidden = false;
  renderBrowse();
}
function exitSelectionMode() {
  selectionMode = false;
  selectedSet.clear();
  $('selectModeBtn').textContent = '选择';
  $('batchBar').hidden = true;
  renderBrowse();
}
function toggleSelect(name) {
  if (selectedSet.has(name)) selectedSet.delete(name);
  else selectedSet.add(name);
  updateBatchBar();
  renderBrowse();
}
function updateBatchBar() {
  $('batchCount').textContent = `已选 ${selectedSet.size} 项`;
  $('batchSelectAllBtn').textContent = (selectedSet.size === libraryFiles.length && libraryFiles.length) ? '全不选' : '全选';
}
function toggleSelectAll() {
  if (selectedSet.size === libraryFiles.length) selectedSet.clear();
  else libraryFiles.forEach(f => selectedSet.add(f.name));
  updateBatchBar();
  renderBrowse();
}
async function batchDeleteSelected() {
  if (!selectedSet.size) { showToast('请先选择视频', true); return; }
  const names = [...selectedSet];
  showActionSheet({
    title: '批量删除',
    message: `确定删除选中的 ${names.length} 个视频文件？删除后无法恢复。`,
    confirmText: '删除',
    onConfirm: async () => {
      let ok = 0;
      for (const name of names) {
        try {
          const res = await fetch(`/api/library/${encodeURIComponent(name)}`, { method: 'DELETE' });
          if (res.ok) { ok++; removeHistory('file:' + name); }
        } catch {}
      }
      showToast(`已删除 ${ok} 个视频`);
      exitSelectionMode();
      loadLibrary();
    },
  });
}

function openBatchOps() {
  if (!selectedSet.size) { showToast('请先选择视频', true); return; }
  const n = selectedSet.size;
  const listBtns = myLists.map(l => `
    <button class="as-btn" onclick="addSelectedTo('${l.id}', false)">加入「${escapeHtml(l.name)}」</button>`).join('');
  openSheet(`
    <div class="action-sheet">
      <div class="as-title">批量操作（${n} 项）</div>
      <button class="as-btn danger" onclick="closeSheet();batchDeleteSelected()">删除选中视频</button>
      ${listBtns}
      <button class="as-btn" onclick="closeSheet();openPrivateListPicker()">加入私密列表</button>
      <button class="as-btn" onclick="closeSheet();openCreateList(false)">新建列表并加入</button>
      <button class="as-btn cancel" onclick="closeSheet()">取消</button>
    </div>`);
}

function openAddToList(isPrivate = false) {
  // 私密列表：统一走解锁门控，token 有效才加载并打开列表（过期时自动引导重新验证并续接）
  if (isPrivate) {
    ensurePrivateUnlock(async () => {
      await loadPrivateLists();
      openPrivateListPicker();
    });
    return;
  }
  const listArr = myLists;
  if (!listArr.length) { showToast('暂无列表，请先创建', true); return; }
  const items = listArr.map(l => `
    <div class="list-tile" onclick="addSelectedTo('${l.id}', false)">
      <span class="list-tile-icon">${icon('folder', 20)}</span>
      <span class="list-tile-main">
        <span class="list-tile-name">${escapeHtml(l.name)}</span>
        <span class="list-tile-meta">${l.items.length} 项</span>
      </span>
    </div>`).join('');
  openSheet(`
    <div class="sheet-head"><span class="sheet-title">加入列表</span></div>
    <div class="sheet-body">
      ${items || '<div class="empty">暂无列表</div>'}
      <button class="list-tile" style="justify-content:center;color:var(--accent);" onclick="closeSheet();openCreateList(false)">${icon('plus', 18)} 新建列表</button>
    </div>`);
}

async function openPrivateListPicker() {
  const listArr = myPrivateLists;
  if (!listArr.length) { showToast('暂无私密列表，请先创建', true); return; }
  const items = listArr.map(l => `
    <div class="list-tile" onclick="addSelectedTo('${l.id}', true)">
      <span class="list-tile-icon private">${icon('lock', 20)}</span>
      <span class="list-tile-main">
        <span class="list-tile-name">${escapeHtml(l.name)}</span>
        <span class="list-tile-meta">${l.items.length} 项</span>
      </span>
    </div>`).join('');
  openSheet(`
    <div class="sheet-head"><span class="sheet-title">加入私密列表</span></div>
    <div class="sheet-body">${items || '<div class="empty">暂无列表</div>'}</div>`);
}

async function addSelectedTo(listId, isPrivate) {
  const names = [...selectedSet];
  if (!names.length) { showToast('请先选择视频', true); return; }
  try {
    const res = await fetch(`/api/lists/${listId}/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ names }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '加入失败');
    showToast(`已加入 ${names.length} 项`);
    closeSheet();
    exitSelectionMode();
    loadLists();
    loadLibrary();
  } catch (err) { showToast(err.message, true); }
}

function openCreateList(isPrivate = false) {
  openSheet(`
    <div class="sheet-head"><span class="sheet-title">${isPrivate ? icon('lock', 18)+' ' : ''}创建${isPrivate ? '私密' : ''}列表</span><button class="sheet-close" onclick="closeSheet()">${icon('xmark', 16)}</button></div>
    <div class="sheet-body">
      <input class="text-input" id="newListName" placeholder="列表名称" maxlength="40" style="width:100%;">
      ${isPrivate ? '<p class="pin-tip">' + icon('lock', 14) + ' 私密列表仅凭密码可见</p>' : ''}
    </div>
    <div class="sheet-foot">
      <button class="btn-secondary" onclick="closeSheet()">取消</button>
      <button class="btn-primary" onclick="submitCreateList(${isPrivate})">创建</button>
    </div>`);
  setTimeout(() => { const el = $('newListName'); if (el) el.focus(); }, 60);
}

async function submitCreateList(isPrivate) {
  const name = ($('newListName')?.value || '').trim();
  if (!name) { showToast('请输入列表名称', true); return; }
  try {
    const headers = { 'Content-Type': 'application/json' };
    const bodyObj = { name };
    if (isPrivate) bodyObj.private = true;
    const res = isPrivate
      ? await privateFetch('/api/lists', { method: 'POST', headers, body: JSON.stringify(bodyObj) }, () => submitCreateList(isPrivate))
      : await fetch('/api/lists', { method: 'POST', headers, body: JSON.stringify(bodyObj) });
    if (res === null) return;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '创建失败');
    showToast('列表已创建');
    closeSheet();
    loadLists();
  } catch (err) { showToast(err.message, true); }
}

function removeList(listId) {
  showActionSheet({
    title: '删除列表',
    message: '删除后列表中的视频会恢复显示在浏览页，视频文件不受影响。',
    confirmText: '删除',
    onConfirm: async () => {
      try {
        const res = await fetch(`/api/lists/${listId}`, { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '删除失败');
        showToast('列表已删除');
        closeSheet();
        loadLists();
        loadLibrary();
      } catch (err) { showToast(err.message, true); }
    },
  });
}

// ═══════════════════════════════════════════════════════
// 私密列表：PIN 认证 + 门控 + 私密浏览页
// ═══════════════════════════════════════════════════════
const PRIVATE_TOKEN_KEY = 'vd.private.token';
function getPrivateToken() { return localStorage.getItem(PRIVATE_TOKEN_KEY) || ''; }
function setPrivateToken(t) { if (t) localStorage.setItem(PRIVATE_TOKEN_KEY, t); else localStorage.removeItem(PRIVATE_TOKEN_KEY); }
let privateCtx = false;
let pinState = null;
let pendingPrivateAction = null;
let privateFolder = null;

async function openPrivateEntry() {
  try {
    const res = await fetch('/api/private/status');
    if (!res.ok) throw new Error();
    const st = await res.json();
    if (!st.hasPassword) openPrivateSetup();
    else openPrivateVerify();
  } catch { showToast('无法获取私密状态', true); }
}

async function ensurePrivateUnlock(action) {
  const token = getPrivateToken();
  if (!token) {
    pendingPrivateAction = action;
    openPrivateEntry();
    return;
  }
  try {
    const res = await fetch('/api/private/status', { headers: { 'X-Private-Token': token } });
    const st = await res.json().catch(() => ({}));
    if (res.ok && st.tokenValid) { action(); return; }
  } catch {}
  setPrivateToken('');
  pendingPrivateAction = action;
  openPrivateEntry();
}

async function privateFetch(url, opts = {}, reauthAction = null) {
  const headers = { ...(opts.headers || {}), 'X-Private-Token': getPrivateToken() };
  const res = await fetch(url, { ...opts, headers });
  if (res.status === 401) {
    setPrivateToken('');
    pendingPrivateAction = reauthAction;
    openPrivateEntry();
    return null;
  }
  return res;
}

function openPinScreen({ title, sub, len, seg = false, autoBoth = false, onDone }) {
  pinState = { title, sub, len, seg, autoBoth, pin: '', err: '', onDone };
  // 锁屏沉浸：立即隐藏当前 Toast，避免「欢迎」提示透出破坏隐私氛围
  clearTimeout(toastTimer);
  const t = document.querySelector('.toast');
  if (t) t.classList.remove('show');
  renderPinScreen();
}

function renderPinScreen() {
  const s = pinState;
  if (!s) return;
  const dots = Array.from({ length: s.len }, (_, i) => `<i class="pin-dot${i < s.pin.length ? ' filled' : ''}"></i>`).join('');
  const segHtml = s.seg ? `
    <div class="pin-seg">
      <button class="${s.len === 4 ? 'active' : ''}" onclick="pinSetLen(4)">4 位</button>
      <button class="${s.len === 6 ? 'active' : ''}" onclick="pinSetLen(6)">6 位</button>
    </div>` : '';
  $('pinScreen').innerHTML = `
    <div class="pin-lock-label">${icon('lock', 15)} 私密列表</div>
    <div class="pin-center">
      <div class="pin-screen-title">${s.title}</div>
      <div class="pin-screen-sub">${s.sub}</div>
      ${segHtml}
      <div class="pin-dots">${dots}</div>
      <div class="pin-error">${s.err}</div>
    </div>
    <div class="pin-numpad">
      ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<button onclick="pinKey(${n})">${n}</button>`).join('')}
      <button class="key-fn" onclick="closePinScreen()">取消</button>
      <button onclick="pinKey(0)">0</button>
      <button class="key-fn key-del" onclick="pinKey('del')">${icon('backspace', 26)}</button>
    </div>`;
  $('pinScreen').hidden = false;
}

function closePinScreen() {
  $('pinScreen').hidden = true;
  $('pinScreen').innerHTML = '';
  pinState = null;
}

function pinSetLen(n) {
  pinState.len = n; pinState.pin = ''; pinState.err = '';
  renderPinScreen();
}

function pinKey(k) {
  if (!pinState) return;
  if (k === 'del') { pinState.pin = pinState.pin.slice(0, -1); renderPinScreen(); return; }
  if (typeof k !== 'number') return;
  if (pinState.pin.length >= pinState.len) return;
  pinState.pin += String(k);
  renderPinScreen();
  const reached = pinState.autoBoth
    ? (pinState.pin.length === 4 || pinState.pin.length === 6)
    : (pinState.pin.length === pinState.len);
  if (reached) {
    const p = pinState.pin;
    pinState.pin = '';
    setTimeout(() => pinState.onDone && pinState.onDone(p), 120);
  }
}

function pinSetError(msg) {
  if (!pinState) return;
  pinState.err = msg;
  renderPinScreen();
}

function openPrivateSetup() {
  openPinScreen({
    title: '设置密码', sub: '输入 4 位数字密码（可切 6 位）', len: 4, seg: true, autoBoth: true,
    onDone: async (p) => {
      openPinScreen({
        title: '确认密码', sub: '再次输入以确认', len: p.length,
        onDone: async (p2) => {
          if (p2 !== p) { pinSetError('两次输入不一致，请重试'); return; }
          try {
            const res = await fetch('/api/private/password', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ password: p }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || '设置失败');
            // ⭐ 后端 password 接口不签发 token：设置成功后需 verify 获取 token 再解锁
            const vres = await fetch('/api/private/verify', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ password: p }),
            });
            const vdata = await vres.json().catch(() => ({}));
            if (vres.ok && vdata.token) setPrivateToken(vdata.token);
            privateCtx = true;
            closePinScreen();
            showToast('私密密码已设置');
            openPrivateApp();
          } catch (e) { pinSetError(e.message + '，请重试'); }
        },
      });
    },
  });
}

function openPrivateVerify() {
  openPinScreen({
    title: '输入密码', sub: '进入私密列表', len: 4, autoBoth: true,
    onDone: async (p) => {
      try {
        const res = await fetch('/api/private/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: p }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          const msg = data.needSetup ? '请先设置密码' : (data.error || '密码错误');
          pinSetError(msg);
          if (data.needSetup) { setTimeout(() => { closePinScreen(); openPrivateSetup(); }, 600); }
          return;
        }
        setPrivateToken(data.token);
        privateCtx = true;
        closePinScreen();
        afterPrivateUnlock();
      } catch (e) { pinSetError(e.message + '，请重试'); }
    },
  });
}

function afterPrivateUnlock() {
  if (pendingPrivateAction) {
    const fn = pendingPrivateAction;
    pendingPrivateAction = null;
    fn();
    return;
  }
  openPrivateApp();
}

function openPrivateApp() {
  privateCtx = true;
  privatePageActive = true;
  browseFolder = null;
  privateFolder = null;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  $('page-private').classList.add('active');
  $('navTitle').textContent = '私密列表';
  $('navTitle').classList.add('small');
  $('navBack').hidden = false;
  $('navBack').dataset.back = 'private:home';
  navBackTo('返回');
  loadPrivateLists().then(renderPrivateBrowse);
}

function closePrivateApp() {
  privatePageActive = false;
  $('navTitle').classList.remove('small');
  // 退出私密页必须移除 active，否则与设置页同时显示（switchTab 不处理 private）
  $('page-private').classList.remove('active');
  const tk = getPrivateToken();
  if (tk) { try { privateFetch('/api/private/logout', { method: 'POST' }); } catch (_) {} }
  setPrivateToken('');
  privateCtx = false;
  privateFolder = null;
  try {
    const v = $('privateInlinePlayerVideo');
    if (v) { v.pause(); v.removeAttribute('src'); v.load(); }
    $('privateInlinePlayer').hidden = true;
    // 清空私密列表 DOM，避免内容残留
    $('privateLibraryGrid').innerHTML = '';
    $('privateFolderGrid').innerHTML = '';
    $('privateBrowseCrumb').innerHTML = '';
  } catch (_) {}
  switchAppTo('settings');
  showToast('已退出私密浏览');
}

function renderPrivateBrowse() {
  const grid = $('privateLibraryGrid');
  const folderEl = $('privateFolderGrid');
  const crumb = $('privateBrowseCrumb');
  const view = settings.libraryView || 'grid';
  const isList = privateFolder && privateFolder.id;

  crumb.innerHTML = isList
    ? `<button class="folder-back" onclick="privateFolder=null;renderPrivateBrowse()">${icon('chevron-left', 16)} 私密列表</button> ${escapeHtml(privateFolder.name)}`
    : '私密列表';
  $('privateCount').textContent = '';

  if (!isList) {
    const pbox = $('privateInlinePlayer');
    if (pbox && !pbox.hidden) closePrivatePlayerOnly();
  }

  if (isList) {
    folderEl.hidden = true;
    renderPrivateFolderVideos(privateFolder);
    return;
  }
  folderEl.hidden = false;
  const newBtn = `<div class="folder-card" data-pnew="1" onclick="openCreateList(true)">
        <div class="folder-icon" style="background:var(--fill);color:var(--accent);">${icon('plus', 24)}</div>
        <div class="folder-name" style="color:var(--accent);">新建私密列表</div>
        <div class="folder-meta">创建后即可加入视频</div>
      </div>`;
  if (!myPrivateLists.length) {
    folderEl.innerHTML = '<div class="empty" style="grid-column:1/-1;"><div class="big">' + icon('lock', 44) + '</div>暂无私密列表<br>点击下方新建</div>' + newBtn;
  } else {
    folderEl.innerHTML = myPrivateLists.map((l) => `
      <div class="folder-card" data-pfolder="${l.id}" data-pname="${escapeHtml(l.name)}" onclick="enterPrivateFolder('${l.id}','${escapeHtml(l.name).replace(/'/g, "\\'")}')">
        <div class="folder-icon private">${icon('lock', 24)}<span class="folder-badge">${l.items.length}</span></div>
        <div class="folder-name">${escapeHtml(l.name)}</div>
        <div class="folder-meta">${l.items.length} 个视频</div>
      </div>`).join('') + newBtn;
  }
  grid.innerHTML = '';
}

function enterPrivateFolder(id, name) {
  privateFolder = { id, name, isPrivate: true };
  renderPrivateBrowse();
}

async function renderPrivateFolderVideos(folder) {
  await renderListVideos({
    grid: $('privateLibraryGrid'),
    count: $('privateCount'),
    folder,
    nameAttr: 'data-pvideo',
    rmAttr: 'data-prm',
    isPrivate: true,
    onLoaded: () => renderPrivateFolderVideos(folder),
  });
}

function removePrivateList(listId) {
  showActionSheet({
    title: '删除私密列表',
    message: '删除后列表中的视频会恢复显示在浏览页。',
    confirmText: '删除',
    onConfirm: async () => {
      try {
        const res = await privateFetch(`/api/lists/${listId}`, { method: 'DELETE' }, () => removePrivateList(listId));
        if (res === null) return;
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '删除失败');
        showToast('私密列表已删除');
        closeSheet();
        loadLists();
        loadLibrary();
      } catch (err) { showToast(err.message, true); }
    },
  });
}

function openChangePin() {
  openPinScreen({
    title: '修改密码', sub: '输入新密码（4 或 6 位数字）', len: 4, seg: true,
    onDone: async (newP) => {
      openPinScreen({
        title: '修改密码', sub: '再次输入新密码', len: newP.length,
        onDone: async (newP2) => {
          if (newP2 !== newP) { showToast('两次输入不一致，请重新设置', true); openChangePin(); return; }
          try {
            const res = await privateFetch('/api/private/change', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ newPassword: newP }),
            }, () => openChangePin());
            if (res === null) return;
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || '修改失败');
            showToast('密码已修改');
            closePinScreen();
          } catch (err) { showToast(err.message, true); }
        },
      });
    },
  });
}

// ═══════════════════════════════════════════════════════
// 登录鉴权
// ═══════════════════════════════════════════════════════
const AUTH_KEY = 'vd.auth.token';
const USER_KEY = 'vd.auth.user';
function getAuthToken() { return localStorage.getItem(AUTH_KEY) || ''; }
function setAuthToken(t) { if (t) localStorage.setItem(AUTH_KEY, t); else localStorage.removeItem(AUTH_KEY); }
function getAuthUser() { return localStorage.getItem(USER_KEY) || ''; }
function setAuthUser(u) { if (u) localStorage.setItem(USER_KEY, u); else localStorage.removeItem(USER_KEY); }
const _origFetch = window.fetch;
window.fetch = async (input, init) => {
  const opts = { ...(init || {}), headers: { ...((init && init.headers) || {}) } };
  const tk = getAuthToken();
  if (tk && !/\/api\/auth\//.test(String(input))) opts.headers['Authorization'] = 'Bearer ' + tk;
  const res = await _origFetch(input, opts);
  // 401 门控：仅普通业务请求的 401 视为登录失效；私密认证端点（/api/private/*）与私密业务请求（意图携带 X-Private-Token）的 401 由私密流程专门处理
  const isPrivateReq = /\/api\/private\//.test(String(input)) || !!(opts.headers && ('X-Private-Token' in opts.headers));
  if (res.status === 401 && !/\/api\/auth\//.test(String(input)) && !isPrivateReq) { setAuthToken(''); showLogin(); }
  return res;
};
function showLogin() {
  const s = $('loginScreen'); if (s) s.classList.remove('hidden');
  const app = $('app'); if (app) app.hidden = true;
  const lbl = $('currentUserLabel');
  const u = getAuthUser();
  if (lbl) lbl.textContent = u ? `当前用户：${u}` : '';
  // 无登录用户时不显示「退出登录」（避免逻辑矛盾）
  const out = $('logoutBtn');
  if (out) out.style.display = u ? '' : 'none';
}
function hideLogin() {
  const s = $('loginScreen'); if (s) s.classList.add('hidden');
  const app = $('app'); if (app) app.hidden = false;
  // 登录后回到桌面（主屏幕）
  const stage = $('appStage'); if (stage) stage.hidden = true;
  const home = $('homeScreen'); if (home) home.style.visibility = 'visible';
  activeApp = null;
}
async function doLogout() {
  try { await _origFetch('/api/auth/logout', { method: 'POST' }); } catch (_) {}
  setAuthToken(''); setAuthUser('');
  // 退出登录同时清除私密状态（安全）
  setPrivateToken(''); privateCtx = false; privatePageActive = false;
  socket.disconnect();
  showLogin();
  showToast('已退出登录');
}
async function doLogin() {
  const user = ($('loginUser')?.value || '').trim();
  const pass = $('loginPass')?.value || '';
  const err = $('loginError');
  if (err) err.textContent = '';
  try {
    const res = await _origFetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: user, password: pass }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { if (err) err.textContent = data.error || '登录失败'; return; }
    setAuthToken(data.token); setAuthUser(data.username); hideLogin();
    showToast('欢迎，' + data.username);
    socket.auth = { token: data.token };
    socket.disconnect();
    socket.connect();
    loadLists(); loadLibrary(); loadTasks();
  } catch (e) { if (err) err.textContent = e.message; }
}

// ═══════════════════════════════════════════════════════
// 播放器快捷键（物理键盘：空格/方向键）
// ═══════════════════════════════════════════════════════
document.addEventListener('keydown', (e) => {
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  const browseBox = $('inlinePlayer');
  const privBox = $('privateInlinePlayer');
  let video = null, box = null;
  if (browseBox && !browseBox.hidden) { video = $('inlinePlayerVideo'); box = browseBox; }
  else if (privBox && !privBox.hidden) { video = $('privateInlinePlayerVideo'); box = privBox; }
  if (!video || !box) return;
  if (e.code === 'Space') {
    e.preventDefault(); e.stopPropagation();
    if (video.paused) { userPaused = false; video.play().catch(() => {}); }
    else { userPaused = true; video.pause(); }
    if (currentPlay) upsertHistory({ ...currentPlay, time: video.currentTime || 0, duration: video.duration || 0, updatedAt: Date.now() });
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    video.currentTime = Math.max(0, (video.currentTime || 0) - 30);
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    video.currentTime = Math.min(video.duration || Infinity, (video.currentTime || 0) + 30);
  }
});

// ═══════════════════════════════════════════════════════
// iOS 手势：左缘右滑返回（跟手拖动 + 前页缩放 + 回弹/滑出动画）
// ═══════════════════════════════════════════════════════
let swipeStartX = null, swipeStartY = null, swipeStartT = 0;
let swipeActive = false;      // 手势已激活（页面正在跟手拖动）
let gestureCommitted = false; // 松手后动画进行中
let frontSnapshot = null;     // 前页 DOM 快照

function canIosBack() {
  if (!activeApp) return false;                        // 桌面：无返回
  if (privatePageActive) return true;                  // 私密页：返回设置 App
  if (browseFolder && browseFolder.id && activeApp === 'browse') return true; // 文件夹：返回浏览根
  if (selectionMode) return false;                     // 批量选择模式禁用手势
  return true;                                         // App 根页：返回桌面
}

function gestureBegin() {
  // App 根页：直接拖动 appStage 返回桌面（无需克隆层）
  if (!privatePageActive && !(browseFolder && browseFolder.id)) {
    return homeSwipeBegin();
  }
  const layer = $('gestureLayer');
  const front = $('gestureFront');
  const back = $('gestureBack');
  const mask = $('gestureMask');
  const activePage = document.querySelector('.page.active');
  if (!activePage || !canIosBack()) return false;
  // 前页快照（克隆，原 DOM 留在 main 供返回动作正常渲染）
  frontSnapshot = activePage.cloneNode(true);
  front.innerHTML = '';
  front.appendChild(frontSnapshot);
  back.innerHTML = '';
  back.style.transform = 'scale(0.92)';
  back.style.transition = 'none';
  mask.style.opacity = '1';
  mask.style.transition = 'none';
  front.style.transform = 'translateX(0)';
  front.style.transition = 'none';
  layer.hidden = false;
  swipeActive = true;
  // 手势期间禁用滚动与浏览器原生边缘手势，交由 JS 接管
  document.documentElement.style.touchAction = 'none';
  document.body.style.overflow = 'hidden';
  return true;
}

function gestureMove(dx) {
  if (homeSwiping) { homeSwipeMove(dx); return; }
  const w = innerWidth;
  const p = Math.min(Math.max(dx, 0) / w, 1);
  const ease = 1 - Math.pow(1 - p, 2.2); // iOS 式轻微缓动
  $('gestureFront').style.transform = `translateX(${dx * 0.88}px)`;
  $('gestureBack').style.transform = `scale(${0.92 + ease * 0.08})`;
  $('gestureMask').style.opacity = `${1 - ease * 0.72}`;
}

function gestureFinish(commit) {
  if (homeSwiping) { homeSwipeFinish(commit); return; }
  const w = innerWidth;
  const layer = $('gestureLayer');
  const front = $('gestureFront');
  const back = $('gestureBack');
  const mask = $('gestureMask');
  if (commit) {
    gestureCommitted = true;
    // 执行真实返回动作（操作 main 中的真实 DOM）
    handleIosBack();
    // 返回后的目标页移入 back 层做入场动画
    const target = document.querySelector('.page.active');
    if (target) {
      back.innerHTML = '';
      back.appendChild(target);
      back.style.transform = 'scale(0.92)';
    }
    front.style.transition = 'transform 0.34s var(--spring-settle)';
    front.style.transform = `translateX(${w}px)`;
    back.style.transition = 'transform 0.34s var(--spring-settle)';
    back.style.transform = 'scale(1)';
    mask.style.transition = 'opacity 0.34s ease-out';
    mask.style.opacity = '0';
    setTimeout(() => gestureCleanup(true), 360);
  } else {
    front.style.transition = 'transform 0.28s var(--spring-settle)';
    front.style.transform = 'translateX(0)';
    back.style.transition = 'transform 0.28s var(--spring-settle)';
    back.style.transform = 'scale(0.92)';
    mask.style.transition = 'opacity 0.28s ease-out';
    mask.style.opacity = '1';
    setTimeout(() => gestureCleanup(false), 300);
  }
}

function gestureCleanup(committed) {
  const layer = $('gestureLayer');
  if (layer.hidden) return;
  const front = $('gestureFront');
  const back = $('gestureBack');
  // 目标页移回 main，保持后续切换逻辑正常
  const target = back.querySelector('.page');
  const main = $('mainScroll');
  if (target && target.parentNode === back) main.appendChild(target);
  front.innerHTML = '';
  back.innerHTML = '';
  layer.hidden = true;
  frontSnapshot = null;
  swipeActive = false;
  gestureCommitted = false;
  document.documentElement.style.touchAction = '';
  document.body.style.overflow = '';
}

document.addEventListener('touchstart', (e) => {
  if (swipeActive || gestureCommitted) return;
  if (!canIosBack()) return;
  const t = e.touches[0];
  // iOS 边缘手势：仅从屏幕左缘 28px 内起手
  if (t.clientX < 28) {
    swipeStartX = t.clientX; swipeStartY = t.clientY; swipeStartT = Date.now();
  }
}, { passive: true });

document.addEventListener('touchmove', (e) => {
  if (gestureCommitted) return;
  if (swipeStartX === null) return;
  const t = e.touches[0];
  const dx = t.clientX - swipeStartX;
  const dy = Math.abs(t.clientY - swipeStartY);
  if (!swipeActive) {
    // 方向判定：横向移动超过纵向 1.3 倍才激活（避免误触列表滚动）
    if (Math.abs(dx) < 6 && dy < 6) return;
    if (dx > 0 && dx > dy * 1.3) {
      if (!gestureBegin()) { swipeStartX = null; return; }
      try { e.preventDefault(); } catch (_) {}
    } else {
      swipeStartX = null; // 纵向滚动，放弃边缘手势
      return;
    }
  }
  if (swipeActive) {
    try { e.preventDefault(); } catch (_) {}
    gestureMove(dx);
  }
}, { passive: false });

document.addEventListener('touchend', (e) => {
  if (swipeStartX === null && !swipeActive) return;
  if (swipeActive) {
    const t = e.changedTouches[0];
    const dx = t.clientX - swipeStartX;
    const dt = Math.max(Date.now() - swipeStartT, 1);
    const vx = dx / dt; // px/ms
    // 位移 > 32% 屏宽，或位移 > 60px 且快速右滑 → 完成返回；否则回弹
    const commit = dx > innerWidth * 0.32 || (dx > 60 && vx > 0.7);
    gestureFinish(commit);
  }
  swipeStartX = null; swipeStartY = null;
}, { passive: true });

document.addEventListener('touchcancel', () => {
  if (swipeActive) gestureFinish(false);
  swipeStartX = null; swipeStartY = null;
}, { passive: true });

function handleIosBack() {
  if (privatePageActive) {
    if (privateFolder && privateFolder.id) { privateFolder = null; renderPrivateBrowse(); }
    else closePrivateApp();
    return;
  }
  if (browseFolder && browseFolder.id) { backToRoot(); return; }
  closeApp(); // App 根页兜底：返回桌面
}

// ═══════════════════════════════════════════════════════
// 绑定事件 + 初始化
// ═══════════════════════════════════════════════════════
$('downloadBtn').addEventListener('click', submitDownload);
$('urlInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitDownload(); });
$('playUrlBtn').addEventListener('click', playUrl);
$('playUrlInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') playUrl(); });
$('inlinePlayerClose').addEventListener('click', () => closePlayer('browse'));
$('privateInlinePlayerClose').addEventListener('click', () => closePrivatePlayerOnly());
$('cacheMenuBtn').addEventListener('click', () => {
  if (!currentPlay) return;
  const btn = $('cacheMenuBtn');
  if (preloadManager.isCaching) { showToast('正在缓存中…'); return; }
  btn.innerHTML = '<span style="font-size:11px;">0%</span>';
  btn.style.width = '36px';
  preloadManager.startCache((pct) => {
    if (pct >= 100) {
      btn.innerHTML = icon('checkmark', 16);
      btn.style.width = '';
      showToast('视频已缓存到本地');
      refreshCacheStats(document.getElementById('statusCacheStats'));
    } else {
      btn.innerHTML = '<span style="font-size:11px;">' + pct + '%</span>';
    }
  }).catch(() => {
    btn.innerHTML = icon('folder', 16);
    btn.style.width = '';
  });
});
$('privateCacheMenuBtn').addEventListener('click', () => {
  if (!currentPlay) return;
  const btn = $('privateCacheMenuBtn');
  if (preloadManager.isCaching) { showToast('正在缓存中…'); return; }
  btn.innerHTML = '<span style="font-size:11px;">0%</span>';
  btn.style.width = '36px';
  preloadManager.startCache((pct) => {
    if (pct >= 100) {
      btn.innerHTML = icon('checkmark', 16);
      btn.style.width = '';
      showToast('视频已缓存到本地');
      refreshCacheStats(document.getElementById('statusCacheStats'));
    } else {
      btn.innerHTML = '<span style="font-size:11px;">' + pct + '%</span>';
    }
  }).catch(() => {
    btn.innerHTML = icon('folder', 16);
    btn.style.width = '';
  });
});
$('cleanCompletedBtn').addEventListener('click', cleanCompleted);
$('selectModeBtn').addEventListener('click', () => { selectionMode ? exitSelectionMode() : enterSelectionMode(); });
$('batchSelectAllBtn').addEventListener('click', toggleSelectAll);
$('batchOpsBtn').addEventListener('click', openBatchOps);
$('batchCancelBtn').addEventListener('click', exitSelectionMode);
$('openListsBtn').addEventListener('click', () => { browseFolder = null; renderBrowse(); });
// 私密列表入口已改为行点击（onclick="openPrivateEntry()"）
$('privateLockBtn').addEventListener('click', closePrivateApp);
if ($('privateChangePinBtn')) $('privateChangePinBtn').addEventListener('click', openChangePin);
// 清理缓存已改为行点击（onclick="clearAllCache()"）
// 刷新状态已改为行点击（onclick="loadHealth()"）
$('parallelDownloadsInput').addEventListener('change', saveServerSettings);
$('navBack').addEventListener('click', () => {
  if (privatePageActive) {
    if (privateFolder && privateFolder.id) { privateFolder = null; renderPrivateBrowse(); }
    else closePrivateApp();
  } else if (browseFolder && browseFolder.id) {
    backToRoot();
  } else {
    closeApp(); // App 根页：返回桌面
  }
});

// 桌面：图标启动 App + 搜索过滤
document.querySelectorAll('.home-app').forEach((btn) => {
  btn.addEventListener('click', () => launchApp(btn.dataset.app));
});
$('homeSearchInput')?.addEventListener('input', (e) => {
  const q = String(e.target.value || '').trim().toLowerCase();
  document.querySelectorAll('.home-app').forEach((b) => {
    const title = APP_META[b.dataset.app]?.title || '';
    b.style.opacity = q && !title.toLowerCase().includes(q) ? '0.22' : '';
  });
});
$('loginBtn').addEventListener('click', doLogin);
$('loginPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
$('loginUser').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
$('logoutBtn')?.addEventListener('click', (e) => { e.preventDefault(); doLogout(); });
// 设置页行点击（元素已改为 div+onclick 直接绑定，无需此处 addEventListener）

bindSettingsForm();
applyTheme();
applyWallpaper();
renderSettingsForm();

// iOS 键盘弹收后的视口恢复：input/textarea 失焦后强制重排，
// 修复 iOS WebKit 键盘收起后 layout viewport 卡在缩小状态导致底部露白。
document.addEventListener('focusout', (e) => {
  const tag = String(e.target?.tagName || '').toLowerCase();
  if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') return;
  setTimeout(() => {
    window.scrollTo(0, 0);
    void document.documentElement.offsetHeight; // 强制重排，触发 iOS 视口回弹
  }, 80);
});

if (!getAuthToken()) {
  showLogin();
} else {
  hideLogin();
  loadLists();
  loadTasks();
}

initNavScroll();

// 暴露给外部（e2e / 调试）的全局接口
window.loadLists = loadLists;
window.loadPrivateLists = loadPrivateLists;
window.renderPrivateBrowse = renderPrivateBrowse;
window.backToRoot = backToRoot;
