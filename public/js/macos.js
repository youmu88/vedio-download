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
    lock: '<rect x="5" y="10.5" width="14" height="9.5" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8.5 10.5V8a3.5 3.5 0 017 0v2.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="12" cy="15" r="1.4" fill="currentColor"/>',
    xmark: '<path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    person: '<circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M4 21c0-5 3.6-9 8-9s8 4 8 9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    film: '<rect x="2" y="3" width="20" height="18" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M2 8h20M2 16h20" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="9" cy="12" r="2" fill="none" stroke="currentColor" stroke-width="1.4"/>',
    folder: '<path d="M2.5 6.5V19c0 .8.7 1.5 1.5 1.5h16c.8 0 1.5-.7 1.5-1.5V8.5c0-.8-.7-1.5-1.5-1.5h-7l-2-3h-7c-.8 0-1.5.7-1.5 1.5z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
    plus: '<path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    checkmark: '<path d="M6 12l4 4 8-8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    ellipsis: '<circle cx="5" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="19" cy="12" r="1.5" fill="currentColor"/>',
    minus: '<path d="M5 12h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
'chevron-left': '<path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    'chevron-down': '<path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    'square-grid': '<rect x="3" y="3" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="14" y="3" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="3" y="14" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="14" y="14" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.6"/>',
    'list-bullet': '<path d="M4 6h16M4 12h16M4 18h16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="4" cy="6" r="1.5" fill="currentColor"/><circle cx="4" cy="12" r="1.5" fill="currentColor"/><circle cx="4" cy="18" r="1.5" fill="currentColor"/>',
    'xmark-circle': '<circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M9 9l6 6M15 9l-6 6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    magnifying: '<circle cx="11" cy="11" r="6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M16 16l4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    backspace: '<path d="M7 7l10 10M17 7L7 17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  };
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" aria-hidden="true">${paths[name] || paths.play}</svg>`;
}

// ═══════════════════════════════════════════════════════
// 窗口管理器（macOS：菜单栏 + 多窗口 + Dock）
// ═══════════════════════════════════════════════════════
const APP_ORDER = ['downloads', 'browse', 'settings', 'private'];
const winState = {};
let activeApp = 'downloads';
let zTop = 20;
APP_ORDER.forEach((name) => { winState[name] = { open: false, minimized: false, maximized: false, fullscreen: false, rect: null, prevFull: null }; });

function dockTop() { return $('dock').getBoundingClientRect().top; }
function computeDefaultRect(name, idx) {
  const maxH = Math.max(320, dockTop() - 40);
  const w = Math.min(680, window.innerWidth - 80);
  const h = Math.min(620, maxH);
  const x = Math.max(24, (window.innerWidth - w) / 2 - 140 + idx * 48);
  const y = Math.max(20, (maxH - h) / 2 - 20 + idx * 30);
  return { x, y, w, h };
}
function applyRect(win, r) {
  win.style.left = `${r.x}px`; win.style.top = `${r.y}px`;
  win.style.width = `${r.w}px`; win.style.height = `${r.h}px`;
  win.style.right = 'auto'; win.style.bottom = 'auto';
}
function currentRect(win) {
  const r = win.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}
function updateDock() {
  document.querySelectorAll('.dock-icon').forEach((b) => b.classList.toggle('active', b.dataset.app === activeApp));
}
function updateNoDock() {
  const anyFull = APP_ORDER.some((name) => winState[name].fullscreen);
  document.body.classList.toggle('no-dock', anyFull);
}
function updateDesktopHint() {
  const anyOpen = APP_ORDER.some((name) => winState[name].open && !winState[name].minimized);
  $('desktopHint').classList.toggle('hidden', anyOpen);
}
function focusApp(name) {
  const win = $('win-' + name);
  win.classList.remove('closed');
  winState[name].open = true;
  winState[name].minimized = false;
  win.style.zIndex = winState[name].fullscreen ? 999 : ++zTop;
  activeApp = name;
  updateDock();
  updateDesktopHint();
  if (name === 'browse') { loadLibrary(); loadLists(); }
  if (name === 'settings') { loadServerSettings(); loadHealth(); }
  if (name === 'private') { loadPrivateLists().then(renderPrivateBrowse); }
}
function ensureOpen(name) {
  if (winState[name].open && !winState[name].minimized) { focusApp(name); return; }
  if (!winState[name].rect) {
    winState[name].rect = computeDefaultRect(name, APP_ORDER.indexOf(name));
    applyRect($('win-' + name), winState[name].rect);
  }
  focusApp(name);
}
function closeApp(name) {
  clearFullscreenState(name);
  winState[name].open = false;
  winState[name].minimized = false;
  $('win-' + name).classList.add('closed');
  if (activeApp === name) activeApp = null;
  updateDock();
  updateNoDock();
  updateDesktopHint();
  try {
    if (name === 'browse' && $('inlinePlayer') && !$('inlinePlayer').hidden) closePlayer('browse');
    else if (name === 'private' && $('privateInlinePlayer') && !$('privateInlinePlayer').hidden) closePrivatePlayerOnly();
  } catch (_) {}
  if (name === 'private') {
    $('privateDockIcon').hidden = true;
    $('privateDockSep').hidden = true;
    setPrivateToken('');
    privateCtx = false;
    privateFolder = null;
  }
}
function minimizeApp(name) {
  clearFullscreenState(name);
  winState[name].minimized = true;
  $('win-' + name).classList.add('closed');
  if (activeApp === name) activeApp = null;
  updateDock();
  updateNoDock();
  updateDesktopHint();
  try {
    if (name === 'browse' && $('inlinePlayer') && !$('inlinePlayer').hidden) closePlayer('browse');
    else if (name === 'private' && $('privateInlinePlayer') && !$('privateInlinePlayer').hidden) closePrivatePlayerOnly();
  } catch (_) {}
}
function clearFullscreenState(name) {
  const st = winState[name];
  if (!st.fullscreen) return;
  st.fullscreen = false;
  const win = $('win-' + name);
  win.classList.remove('fullscreen');
  win.querySelector('.tl.green').classList.remove('active');
}
function maximizeApp(name) {
  const st = winState[name];
  const win = $('win-' + name);
  if (st.fullscreen) { exitFullscreen(name); return; }
  if (st.maximized) {
    st.maximized = false;
    win.classList.remove('maximized');
    applyRect(win, st.rect || computeDefaultRect(name, APP_ORDER.indexOf(name)));
  } else {
    st.rect = currentRect(win);
    st.maximized = true;
    win.classList.add('maximized');
    win.style.left = '0'; win.style.top = '0'; win.style.right = '0';
    win.style.bottom = `${Math.max(0, window.innerHeight - dockTop())}px`;
    win.style.width = 'auto'; win.style.height = 'auto';
  }
}
function toggleFullscreen(name) {
  const st = winState[name];
  const win = $('win-' + name);
  if (st.fullscreen) { exitFullscreen(name); return; }
  st.prevFull = { maximized: st.maximized, rect: currentRect(win) };
  st.fullscreen = true;
  st.maximized = false;
  win.classList.add('fullscreen');
  win.classList.remove('maximized');
  win.style.inset = '0';
  win.style.width = 'auto'; win.style.height = 'auto';
  win.style.zIndex = 999;
  win.querySelector('.tl.green').classList.add('active');
  activeApp = name;
  updateNoDock();
  updateDock();
}
function exitFullscreen(name) {
  const st = winState[name];
  const win = $('win-' + name);
  st.fullscreen = false;
  updateNoDock();
  win.classList.remove('fullscreen');
  win.querySelector('.tl.green').classList.remove('active');
  win.style.zIndex = ++zTop;
  if (st.prevFull?.maximized) {
    st.maximized = true;
    win.classList.add('maximized');
    win.style.left = '0'; win.style.top = '0'; win.style.right = '0';
    win.style.bottom = `${Math.max(0, window.innerHeight - dockTop())}px`;
    win.style.width = 'auto'; win.style.height = 'auto';
  } else {
    applyRect(win, st.prevFull?.rect || st.rect || computeDefaultRect(name, APP_ORDER.indexOf(name)));
  }
}

// 窗口事件（拖动 / 双击最大化 / 红黄绿按钮）
APP_ORDER.forEach((name) => {
  const win = $('win-' + name);
  const bar = win.querySelector('.titlebar');
  bar.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.traffic')) return;
    const st = winState[name];
    if (st.maximized || st.fullscreen) return;
    const r = win.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    const move = (ev) => {
      const x = Math.min(window.innerWidth - 40, Math.max(0, ev.clientX - dx));
      const y = Math.min(Math.max(0, dockTop() - 40), Math.max(0, ev.clientY - dy));
      win.style.left = `${x}px`; win.style.top = `${y}px`;
      win.style.right = 'auto'; win.style.bottom = 'auto';
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  bar.addEventListener('dblclick', (e) => {
    if (e.target.closest('.traffic')) return;
    maximizeApp(name);
  });
  win.querySelectorAll('.traffic .tl').forEach((btn) => {
    btn.addEventListener('click', () => {
      const act = btn.dataset.act;
      if (act === 'close') closeApp(name);
      else if (act === 'min') minimizeApp(name);
      else toggleFullscreen(name);
    });
  });
});

// Dock 图标点击
document.querySelectorAll('.dock-icon').forEach((btn) => {
  btn.addEventListener('click', () => ensureOpen(btn.dataset.app));
});
window.addEventListener('resize', () => {
  APP_ORDER.forEach((name) => {
    const st = winState[name];
    if (st.maximized && !st.fullscreen && winState[name].open) {
      const win = $('win-' + name);
      win.style.bottom = `${Math.max(0, window.innerHeight - dockTop())}px`;
    }
  });
});

// ── macOS 菜单栏（App/文件/编辑/显示/窗口） ──
const menuItems = {
  app: [
    { label: '关于视频下载器', action: () => showToast('视频下载器 · macOS 桌面版') },
    { sep: true },
    { label: '退出登录…', action: () => doLogout() },
  ],
  file: [
    { label: '新建下载任务 ⌘N', action: () => { ensureOpen('downloads'); setTimeout(() => $('urlInput')?.focus(), 80); } },
    { label: '关闭窗口 ⌘W', action: () => { if (activeApp) closeApp(activeApp); } },
  ],
  edit: [
    { label: '聚焦地址栏 ⌘F', action: () => { ensureOpen('downloads'); setTimeout(() => $('urlInput')?.focus(), 80); } },
    { label: '聚焦播放链接 ⌘L', action: () => { ensureOpen('browse'); setTimeout(() => $('playUrlInput')?.focus(), 80); } },
  ],
  view: [
    { label: '浅色外观', action: () => { settings.theme = 'light'; saveSettings(); applyTheme(); } },
    { label: '深色外观', action: () => { settings.theme = 'dark'; saveSettings(); applyTheme(); } },
    { label: '自动外观', action: () => { settings.theme = 'auto'; saveSettings(); applyTheme(); } },
    { sep: true },
    { label: '进入全屏 ⌃⌘F', action: () => { if (activeApp) toggleFullscreen(activeApp); } },
  ],
  window: [
    { label: '下载 ⌘1', action: () => ensureOpen('downloads') },
    { label: '浏览 ⌘2', action: () => ensureOpen('browse') },
    { label: '设置 ⌘3', action: () => ensureOpen('settings') },
  ],
};
function buildMenus() {
  document.querySelectorAll('#menuBar .mb-item[data-menu]').forEach((item) => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('#menuBar .menu-pop').forEach((p) => p.remove());
      const key = item.dataset.menu;
      const items = menuItems[key] || [];
      const pop = document.createElement('div');
      pop.className = 'menu-pop';
      pop.innerHTML = items.map((it) => it.sep
        ? '<div class="menu-sep"></div>'
        : `<button class="menu-opt" data-act="${key}">${escapeHtml(it.label)}</button>`).join('');
      document.body.appendChild(pop);
      const r = item.getBoundingClientRect();
      pop.style.left = `${r.left}px`;
      pop.style.top = `${r.bottom + 4}px`;
      pop.querySelectorAll('.menu-opt').forEach((btn, i) => {
        btn.addEventListener('click', () => { pop.remove(); items[i].action && items[i].action(); });
      });
    });
  });
  document.addEventListener('click', () => document.querySelectorAll('#menuBar .menu-pop').forEach((p) => p.remove()));
}
buildMenus();

// ── macOS 全局快捷键 ──
document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return;
  const k = e.key.toLowerCase();
  if (k === 'n') { e.preventDefault(); ensureOpen('downloads'); setTimeout(() => $('urlInput')?.focus(), 80); }
  else if (k === 'w') { e.preventDefault(); if (activeApp) closeApp(activeApp); }
  else if (k === 'f') { e.preventDefault(); ensureOpen('downloads'); setTimeout(() => $('urlInput')?.focus(), 80); }
  else if (k === 'l') { e.preventDefault(); ensureOpen('browse'); setTimeout(() => $('playUrlInput')?.focus(), 80); }
  else if (k === '1') { e.preventDefault(); ensureOpen('downloads'); }
  else if (k === '2') { e.preventDefault(); ensureOpen('browse'); }
  else if (k === '3') { e.preventDefault(); ensureOpen('settings'); }
  else if (e.key === 'Enter' && activeApp === 'downloads') { e.preventDefault(); submitDownload(); }
});

// ═══════════════════════════════════════════════════════
// 设置持久化
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
  $('desktop').className = 'desktop' + (name === 'default' ? '' : ` wallpaper-${name}`);
  document.querySelectorAll('#wallpaperPicker .swatch').forEach((s) => s.classList.toggle('active', s.dataset.wallpaper === name));
}
function renderSettingsForm() {
  $('engineSelect').value = settings.engine;
  $('formatSelect').value = settings.format;
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
  $('engineSelect').addEventListener('change', (e) => { settings.engine = e.target.value; saveSettings(); });
  $('formatSelect').addEventListener('change', (e) => { settings.format = e.target.value; saveSettings(); });
  $('parallelSwitch').addEventListener('change', (e) => { settings.parallel = e.target.checked; saveSettings(); });
  $('parallelCountInput').addEventListener('change', (e) => { settings.parallelCount = Math.min(16, Math.max(1, parseInt(e.target.value, 10) || 4)); e.target.value = settings.parallelCount; saveSettings(); });
  $('maxSpeedInput').addEventListener('change', (e) => { settings.maxSpeedMB = Math.max(0, parseFloat(e.target.value) || 0); e.target.value = settings.maxSpeedMB; saveSettings(); });
  $('timeoutInput').addEventListener('change', (e) => { settings.timeoutMin = Math.min(600, Math.max(1, parseInt(e.target.value, 10) || 30)); e.target.value = settings.timeoutMin; saveSettings(); });
  $('libraryViewToggle') && $('libraryViewToggle').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    settings.libraryView = btn.dataset.view;
    saveSettings();
    document.querySelectorAll('#libraryViewToggle button').forEach(b => b.classList.toggle('active', b === btn));
    renderBrowse();
  });
  $('privateViewToggle') && $('privateViewToggle').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    settings.libraryView = btn.dataset.view;
    saveSettings();
    document.querySelectorAll('#privateViewToggle button').forEach(b => b.classList.toggle('active', b === btn));
    renderPrivateBrowse();
  });
}
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
  document.querySelectorAll('.conn-dot').forEach(d => d.className = 'conn-dot on');
  loadTasks();
});
socket.on('disconnect', () => document.querySelectorAll('.conn-dot').forEach(d => d.className = 'conn-dot off'));
socket.on('task-status', (task) => updateTaskCard(task));
socket.on('task-list-update', (tasks) => renderTasks(tasks));
socket.on('task-finalized', ({ taskId }) => socket.emit('unsubscribe', taskId));
// ⭐ 视频库自动刷新：服务端 fs.watch/下载完成推送 library-update（browse 未打开时不打扰，进页必刷兑底）
socket.on('library-update', () => { if (activeApp === 'browse') loadLibrary(); });
// 转码进度 → PlayerCore（socket 实例在本文件，跨文件经 window CustomEvent 解耦）
socket.on('transcode-status', (s) => window.dispatchEvent(new CustomEvent('transcode-status', { detail: s })));

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
  created: ['排队中', ''], running: ['进行中', 'running'],
  completed: ['已完成', 'completed'], failed: ['失败', 'failed'], cancelled: ['已停止', 'cancelled'],
};
function buildTaskRow(task) {
  const status = task.status || 'created';
  const [statusText, cls] = STATUS_TEXT[status] || [status, ''];
  const progress = Math.max(0, Math.min(100, task.progress || 0));
  const actions = [];
  if (status === 'created' || status === 'running') actions.push(`<button class="icon-btn danger" title="停止" onclick="actionTask('${task.id}','stop')">${icon('stop', 17)}</button>`);
  if (status === 'failed' || status === 'cancelled') actions.push(`<button class="icon-btn" title="重试" onclick="actionTask('${task.id}','retry')">${icon('retry', 17)}</button>`);
  actions.push(`<button class="icon-btn danger" title="删除" onclick="actionTask('${task.id}','delete')">${icon('trash', 17)}</button>`);
  if (status === 'completed' && task.outputFile) {
    const name = task.outputFile.split('/').pop();
    actions.push(`<button class="icon-btn green" title="播放文件" onclick="playLibrary('${name.replace(/'/g, "\\'")}')">${icon('play', 17)}</button>`);
  }
  const metaParts = [];
  metaParts.push(`<span class="task-status ${cls}">${statusText}</span>`);
  if (task.progress != null) metaParts.push(`<span>${Math.round(progress)}%</span>`);
  if (task.speed) metaParts.push(`<span>${escapeHtml(task.speed)}</span>`);
  if (task.outputSizeBytes) metaParts.push(`<span>${formatBytes(task.outputSizeBytes)}</span>`);
  const errorHtml = task.error ? `<div class="task-error">⚠ ${escapeHtml(task.error)}</div>` : '';
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
    list.innerHTML = '<div class="empty"><div class="big">' + icon('download', 42) + '</div>还没有下载任务</div>';
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
// 浏览页：视频库 + 播放
// ═══════════════════════════════════════════════════════
let libraryFiles = [];
async function loadLibrary() {
  try {
    const res = await fetch('/api/library');
    if (!res.ok) throw new Error();
    libraryFiles = await res.json();
    renderBrowse();
  } catch {
    $('libraryGrid').innerHTML = '<div class="empty"><div class="big">' + icon('xmark-circle', 42) + '</div>视频库读取失败</div>';
  }
}
// ⭐ 视频库自动刷新兑底：macOS Docker Desktop 的 bind mount 下宿主拹入不触发容器内 fs.watch，
// 「页面重新可见 + ≤15s 轮询」是唯一可靠的自动更新途径（进 browse 页必刷仍在 ensureOpen 保留）
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && activeApp === 'browse') loadLibrary();
});
setInterval(() => { if (activeApp === 'browse' && !document.hidden) loadLibrary(); }, 15000);
let browseFolder = null; // null=根视图 | {id,name,isPrivate}

function renderBrowse() {
  const grid = $('libraryGrid');
  const folderEl = $('folderGrid');
  const crumb = $('browseCrumb');
  const isList = browseFolder && browseFolder.id;
  const view = settings.libraryView || 'grid';

  if (isList) {
    crumb.innerHTML = `<button class="folder-back" onclick="browseFolder=null;renderBrowse()">‹ 返回</button> ${escapeHtml(browseFolder.name)}`;
    folderEl.hidden = true;
    grid.className = view === 'list' ? 'library-list' : 'library-grid';
    grid.innerHTML = '<div class="empty">加载中…</div>';
    renderListVideos({ grid, count: $('libraryCount'), folder: browseFolder, nameAttr: 'data-name', rmAttr: 'data-rm-list', isPrivate: !!browseFolder.isPrivate, onLoaded: () => renderListVideos({ grid, count: $('libraryCount'), folder: browseFolder, nameAttr: 'data-name', rmAttr: 'data-rm-list', isPrivate: !!browseFolder.isPrivate }) });
    return;
  }
  crumb.innerHTML = '';
  folderEl.hidden = false;
  grid.className = view === 'list' ? 'library-list' : 'library-grid';
  renderRootFolders();
  renderLibraryGrid(libraryFiles);
}

function renderRootFolders() {
  const el = $('folderGrid');
  const pubs = myLists.map((l) => `
    <div class="folder-card" data-enter="list" data-id="${l.id}" data-name="${escapeHtml(l.name)}">
      <div class="folder-icon">${icon('folder', 24)}</div>
      <div class="folder-name">${escapeHtml(l.name)}</div>
      <div class="folder-meta">${l.items.length} 个视频</div>
      <button class="list-item-del" data-del-list="${l.id}" onclick="event.stopPropagation();removeList('${l.id}')">删除列表</button>
    </div>`).join('');
  const newCard = `<div class="folder-card" data-new="1" style="border:1.5px dashed var(--separator);background:transparent;box-shadow:none;">
        <div class="folder-icon" style="background:var(--fill);color:var(--accent);">${icon('plus', 24)}</div>
        <div class="folder-name" style="color:var(--accent);">新建列表</div>
        <div class="folder-meta">按主题创建列表，将视频加入</div>
      </div>`;
  el.innerHTML = (pubs ? pubs : '<div class="folder-card" style="cursor:default;"><div class="folder-meta">暂无公开列表<br>点击下方新建列表</div></div>') + newCard;
  el.querySelectorAll('[data-enter="list"]').forEach((card) => {
    card.addEventListener('click', () => enterListFolder(card.dataset.id, card.dataset.name, false));
  });
  el.querySelector('[data-new="1"]')?.addEventListener('click', () => openCreateList(false));
}

function renderLibraryGrid(files) {
  const grid = $('libraryGrid');
  const view = settings.libraryView || 'grid';
  grid.className = view === 'list' ? 'library-list' : 'library-grid';
  if (!files.length) {
    grid.innerHTML = '<div class="empty"><div class="big">' + icon('film', 42) + '</div>视频库为空<br>下载完成后会出现在这里</div>';
    return;
  }
  grid.innerHTML = files.map((f) => {
    const pct = libraryProgress(f.name);
    const needTc = PlayerCore.needsTranscode(f.name);
    const progressHtml = pct === null ? '' : view === 'list'
      ? `<div class="video-progress">${pct}%<span class="bar" style="width:${pct}%"></span></div>`
      : `<span class="video-progress">${pct}%</span>`;
    const selCls = selectedSet.has(f.name) ? ' selected' : '';
    const sel = selectionMode ? `<i class="sel-check">${icon('checkmark', 14)}</i>` : '';
    if (view === 'list') {
      return `
      <div class="video-card${selCls}" data-name="${escapeHtml(f.name)}">
        ${sel}
        <div class="video-thumb"><span class="play-badge">${icon('play', 16)}</span></div>
        <div class="video-info">
          <div class="video-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</div>
          <div class="video-meta">${formatBytes(f.size)} · ${formatDate(f.mtime)}${needTc ? ' · <span class="video-progress">需转码</span>' : ''}</div>
          ${progressHtml}
        </div>
        <button class="video-delete" data-delete-name="${escapeHtml(f.name)}" title="删除视频">${icon('trash', 15)}</button>
      </div>`;
    }
    return `
    <div class="video-card${selCls}" data-name="${escapeHtml(f.name)}">
      ${sel}
      <div class="video-thumb">
        <span class="play-badge">${icon('play', 20)}</span>
        ${needTc ? '<span class="video-progress">需转码</span>' : ''}
        ${progressHtml}
        <button class="video-delete" data-delete-name="${escapeHtml(f.name)}" title="删除视频">${icon('trash', 14)}</button>
      </div>
      <div class="video-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</div>
      <div class="video-meta">${formatBytes(f.size)} · ${formatDate(f.mtime)}</div>
    </div>`;
  }).join('');
  bindLibraryCardEvents();
}

function bindLibraryCardEvents() {
  const grid = $('libraryGrid');
  grid.querySelectorAll('.video-card').forEach((card) => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.video-delete')) return;
      const name = card.dataset.name;
      if (selectionMode) { toggleSelect(name); return; }
      playLibrary(name);
    });
    grid.querySelectorAll('.video-delete').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteVideo(btn.dataset.deleteName);
      });
    });
  });
  // 文件夹导航事件
  $('folderGrid').querySelectorAll('[data-del-list]').forEach((btn) => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); removeList(btn.dataset.delList); });
  });
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
    grid.innerHTML = '<div class="empty"><div class="big">' + icon('folder', 42) + '</div>列表为空<br>在浏览页选择视频后可加入</div>';
    return;
  }
  grid.innerHTML = items.map((i) => {
    const pct = libraryProgress(i.name);
    const progressHtml = pct === null ? '' : view === 'list'
      ? `<div class="video-progress">${pct}%<span class="bar" style="width:${pct}%"></span></div>`
      : `<span class="video-progress">${pct}%</span>`;
    const meta = [i.size ? formatBytes(i.size) : '', i.mtime ? formatDate(i.mtime) : '', i.addedAt ? formatDate(i.addedAt) + ' 加入' : ''].filter(Boolean).join(' · ');
    return view === 'list'
      ? `
      <div class="video-card" ${nameAttr}="${escapeHtml(i.name)}">
        <div class="video-thumb"><span class="play-badge">${icon('play', 16)}</span>${progressHtml}</div>
        <div class="video-info">
          <div class="video-name" title="${escapeHtml(i.name)}">${escapeHtml(i.name)}</div>
          <div class="video-meta">${meta}</div>
        </div>
        <button class="video-delete" ${rmAttr}="${folder.id}|${escapeHtml(i.name)}" title="从列表移除">${icon('trash', 15)}</button>
      </div>`
      : `
      <div class="video-card" ${nameAttr}="${escapeHtml(i.name)}">
        <div class="video-thumb">
          <span class="play-badge">${icon('play', 20)}</span>
          ${progressHtml}
          <button class="video-delete" ${rmAttr}="${folder.id}|${escapeHtml(i.name)}" title="从列表移除">${icon('trash', 14)}</button>
        </div>
        <div class="video-name" title="${escapeHtml(i.name)}">${escapeHtml(i.name)}</div>
        <div class="video-meta">${meta}</div>
      </div>`;
  }).join('');
  grid.querySelectorAll('.video-card').forEach((card) => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.video-delete')) return;
      const name = card.getAttribute(nameAttr);
      if (name) { if (isPrivate) playPrivateVideo(name); else playLibrary(name); }
    });
  });
  grid.querySelectorAll('.video-delete').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (btn.hasAttribute(rmAttr)) {
        const [fid, nm] = btn.getAttribute(rmAttr).split('|');
        removeListVideo(fid, nm, isPrivate);
      } else if (btn.dataset.deleteName) {
        deleteVideo(btn.dataset.deleteName);
      }
    });
  });
}

function enterListFolder(id, name, isPrivate) {
  browseFolder = { id, name, isPrivate };
  renderBrowse();
}
function backToRoot() { browseFolder = null; renderBrowse(); }
async function removeListVideo(folderId, name, isPrivate) {
  try {
    const res = isPrivate
      ? await privateFetch(`/api/lists/${folderId}/items`, {
          method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ names: [name] }),
        }, () => removeListVideo(folderId, name, isPrivate))
      : await fetch(`/api/lists/${folderId}/items`, {
          method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ names: [name] }),
        });
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

// ── 播放器核心（已抽取至 player-core.js，双端仅注入页面导航/标题差异）──
PlayerCore.configure({
  navigateTo(target) {
    ensureOpen(target === 'private' ? 'private' : 'browse');
  },
  // 私密模式：不重新渲染列表（避免打断播放）
  setTitle(titleEl, title, target) {
    if (target !== 'private') {
      titleEl.textContent = title;
    }
  },
});

// 全局委托（保持 HTML onclick / 事件绑定兼容）
function openPlayer(title, src, id, target) { return PlayerCore.openPlayer(title, src, id, target); }
function closePlayer(target) { return PlayerCore.closePlayer(target); }
function closePrivatePlayerOnly() { return PlayerCore.closePrivatePlayerOnly(); }
function playLibrary(name) { return PlayerCore.playLibrary(name); }
function playPrivateVideo(name) { return PlayerCore.playPrivateVideo(name); }
function playUrl() { return PlayerCore.playUrl(); }

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
    $('healthEngines').innerHTML = `${dot(eng.ffmpeg)} ffmpeg &nbsp; ${dot(eng.ffprobe)} ffprobe`;
    $('healthNre').innerHTML = `${dot(eng.n_m3u8dl_re)} 可用`;
    $('healthDisk').textContent = h.disk || '—';
  } catch {}
}
function dot(ok) { return `<span class="status-dot ${ok ? 'ok' : 'no'}"></span>`; }

// ═══════════════════════════════════════════════════════
// Toast / 弹窗管理
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
const modalMask = $('modalMask');
const modalCard = $('modalCard');
function openModal(html) {
  modalCard.innerHTML = html;
  modalMask.hidden = false;
}
function closeModal() {
  modalMask.hidden = true;
  modalCard.innerHTML = '';
}
modalMask.addEventListener('click', (e) => { if (e.target === modalMask) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modalMask.hidden) closeModal(); });

// ── macOS Action Sheet 确认菜单（替代原生 confirm） ──
function showActionSheet({ title, message, confirmText = '删除', cancelText = '取消', danger = true, onConfirm }) {
  openModal(`
    <div class="action-sheet">
      <div class="as-title">${title}</div>
      <div class="as-message">${message}</div>
      <button class="as-btn ${danger ? 'danger' : ''}" id="asConfirm">${confirmText}</button>
      <button class="as-btn cancel" onclick="closeModal()">${cancelText}</button>
    </div>`);
  $('asConfirm').addEventListener('click', () => { closeModal(); onConfirm && onConfirm(); });
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
// 浏览页：列表数据 + 选择模式 + 批量操作
// ═══════════════════════════════════════════════════════
let myLists = [];
let myPrivateLists = [];
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
  renderLibrary(libraryFiles);
}
function exitSelectionMode() {
  selectionMode = false;
  selectedSet.clear();
  $('selectModeBtn').textContent = '选择';
  $('batchBar').hidden = true;
  renderLibrary(libraryFiles);
}
function toggleSelect(name) {
  if (selectedSet.has(name)) selectedSet.delete(name);
  else selectedSet.add(name);
  updateBatchBar();
  renderLibrary(libraryFiles);
}
function updateBatchBar() {
  $('batchCount').textContent = `已选 ${selectedSet.size} 项`;
  $('batchSelectAllBtn').textContent = (selectedSet.size === libraryFiles.length && libraryFiles.length) ? '全不选' : '全选';
}
function toggleSelectAll() {
  if (selectedSet.size === libraryFiles.length) selectedSet.clear();
  else libraryFiles.forEach(f => selectedSet.add(f.name));
  updateBatchBar();
  renderLibrary(libraryFiles);
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

// ── 批量操作：动态菜单 ──
function openBatchOps() {
  if (!selectedSet.size) { showToast('请先选择视频', true); return; }
  const n = selectedSet.size;
  const listBtns = myLists.map(l => `
    <button class="as-btn" onclick="addSelectedTo('${l.id}', false)">加入「${escapeHtml(l.name)}」</button>`).join('');
  openModal(`
    <div class="action-sheet">
      <div class="as-title">批量操作</div>
      <div class="as-message">已选 ${n} 个视频</div>
      <button class="as-btn danger" id="asBatchDel">删除所选</button>
      ${listBtns}
      <button class="as-btn" onclick="openAddToList(true)">加入私密列表</button>
      <button class="as-btn" onclick="closeModal();openCreateList(false)">新建列表并加入</button>
      <button class="as-btn cancel" onclick="closeModal()">取消</button>
    </div>`);
  $('asBatchDel').addEventListener('click', () => { closeModal(); batchDeleteSelected(); });
}

// ── 加入列表 ──
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
      <span class="list-tile-icon">${icon('folder', 18)}</span>
      <span class="list-tile-main">
        <span class="list-tile-name">${escapeHtml(l.name)}</span>
        <span class="list-tile-meta">${l.items.length} 项</span>
      </span>
    </div>`).join('');
  openModal(`
    <div class="modal-head"><span class="modal-title">加入列表</span><button class="modal-close" onclick="closeModal()">${icon('xmark', 16)}</button></div>
    <div class="modal-body">
      ${items || '<div class="empty">暂无列表</div>'}
      <button class="list-tile" style="justify-content:center;color:var(--accent);" onclick="closeModal();openCreateList(false)">${icon('plus', 16)} 新建列表</button>
    </div>`);
}

async function openPrivateListPicker() {
  const listArr = myPrivateLists;
  if (!listArr.length) { showToast('暂无私密列表，请先创建', true); return; }
  const items = listArr.map(l => `
    <div class="list-tile" onclick="addSelectedTo('${l.id}', true)">
      <span class="list-tile-icon private">${icon('lock', 18)}</span>
      <span class="list-tile-main">
        <span class="list-tile-name">${escapeHtml(l.name)}</span>
        <span class="list-tile-meta">${l.items.length} 项</span>
      </span>
    </div>`).join('');
  openModal(`
    <div class="modal-head"><span class="modal-title">加入私密列表</span><button class="modal-close" onclick="closeModal()">${icon('xmark', 16)}</button></div>
    <div class="modal-body">${items || '<div class="empty">暂无列表</div>'}</div>`);
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
    closeModal();
    exitSelectionMode();
    loadLists();
    loadLibrary();
  } catch (err) { showToast(err.message, true); }
}

// ── 创建列表 ──
function openCreateList(isPrivate = false) {
  openModal(`
    <div class="modal-head"><span class="modal-title">${isPrivate ? icon('lock', 16)+' ' : ''}创建${isPrivate ? '私密' : ''}列表</span><button class="modal-close" onclick="closeModal()">${icon('xmark', 16)}</button></div>
    <div class="modal-body">
      <input class="text-input" id="newListName" placeholder="列表名称" maxlength="40" style="width:100%;">
      ${isPrivate ? '<p class="pin-tip">' + icon('lock', 14) + ' 私密列表仅凭密码可见</p>' : ''}
    </div>
    <div class="modal-foot">
      <button class="btn-secondary" onclick="closeModal()">取消</button>
      <button class="btn-primary" onclick="submitCreateList(${isPrivate})">创建</button>
    </div>`);
  setTimeout(() => { const el = $('newListName'); if (el) el.focus(); }, 60);
}
async function submitCreateList(isPrivate) {
  const name = ($('newListName')?.value || '').trim();
  if (!name) { showToast('请输入列表名称', true); return; }
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (isPrivate) headers['X-Private-Token'] = getPrivateToken();
    const res = await fetch('/api/lists', { method: 'POST', headers, body: JSON.stringify({ name, private: isPrivate }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '创建失败');
    showToast('列表已创建');
    closeModal();
    loadLists();
    if (isPrivate) loadPrivateLists();
  } catch (err) { showToast(err.message, true); }
}

async function removeList(listId) {
  showActionSheet({
    title: '删除列表',
    message: '删除后列表内视频将恢复显示在浏览页，已下载文件不受影响。',
    confirmText: '删除',
    onConfirm: async () => {
      try {
        const res = await fetch(`/api/lists/${listId}`, { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '删除失败');
        showToast('列表已删除');
        closeModal();
        loadLists();
        loadLibrary();
      } catch (err) { showToast(err.message, true); }
    },
  });
}

// ═══════════════════════════════════════════════════════
// 私密列表认证（PIN 密码）
// ═══════════════════════════════════════════════════════
const PRIVATE_TOKEN_KEY = 'vd.private.token';
let privateCtx = false;
let pendingPrivateAction = null;
let pinState = null;

function getPrivateToken() { return localStorage.getItem(PRIVATE_TOKEN_KEY) || ''; }
function setPrivateToken(t) { if (t) localStorage.setItem(PRIVATE_TOKEN_KEY, t); else localStorage.removeItem(PRIVATE_TOKEN_KEY); }

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
    openPrivateVerify();
    return null;
  }
  return res;
}

function openPinScreen({ title, sub, len = 4, seg = false, autoBoth = false, onDone }) {
  pinState = { title, sub, len, seg, autoBoth, pin: '', err: '', onDone };
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
  openModal(`
    <div class="modal-head"><span class="modal-title">${icon('lock', 18)} 私密列表</span><button class="modal-close" onclick="closeModal()">${icon('xmark', 16)}</button></div>
    <div class="modal-body">
      <div class="pin-screen">
        <div class="pin-screen-title">${s.title}</div>
        <div class="pin-screen-sub">${s.sub}</div>
        ${segHtml}
        <div class="pin-dots">${dots}</div>
        <div class="numpad">
          ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<button onclick="pinKey(${n})">${n}</button>`).join('')}
          <button class="key-del" onclick="pinKey('del')">⌫</button>
          <button onclick="pinKey(0)">0</button>
          <button style="visibility:hidden"></button>
        </div>
        <div class="pin-error" id="pinError">${s.err}</div>
      </div>
    </div>`);
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
    title: '设置密码', sub: '保护你的私密列表（4 或 6 位数字）', len: 4, seg: true, autoBoth: true,
    onDone: async (p) => {
      openPinScreen({
        title: '确认密码', sub: '再次输入以确认', len: p.length,
        onDone: async (p2) => {
          if (p2 !== p) { pinSetError(`两次输入不一致`); return; }
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
            showToast('私密密码已设置');
            closeModal();
            afterPrivateUnlock();
          } catch (e) { pinSetError(e.message + '，请重试'); }
        },
      });
    },
  });
}

function openPrivateVerify() {
  openPinScreen({
    title: '输入密码', sub: '验证后进入私密列表', len: 4, autoBoth: true,
    onDone: async (p) => {
      try {
        const res = await fetch('/api/private/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: p }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '密码错误');
        setPrivateToken(data.token || '');
        showToast('解锁成功');
        closeModal();
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
  closeModal();
  openPrivateApp();
}

function openPrivateApp() {
  privateCtx = true;
  $('privateDockIcon').hidden = false;
  $('privateDockSep').hidden = false;
  browseFolder = null;
  privateFolder = null;
  ensureOpen('private');
  loadPrivateLists().then(renderPrivateBrowse);
}

function closePrivateApp() {
  try { closeApp('private'); } catch (_) {}
  $('privateDockIcon').hidden = true;
  $('privateDockSep').hidden = true;
  const tk = getPrivateToken();
  if (tk) { try { privateFetch('/api/private/logout', { method: 'POST' }); } catch (_) {} }
  setPrivateToken('');
  privateCtx = false;
  privateFolder = null;
  try {
    const v = $('privateInlinePlayerVideo');
    if (v) { v.pause(); v.removeAttribute('src'); v.load(); }
    $('privateInlinePlayer').hidden = true;
  } catch (_) {}
  showToast('已退出私密浏览');
}

let privateFolder = null;

function renderPrivateBrowse() {
  const grid = $('privateLibraryGrid');
  const folderEl = $('privateFolderGrid');
  const crumb = $('privateBrowseCrumb');
  const view = settings.libraryView || 'grid';
  const isList = privateFolder && privateFolder.id;

  crumb.innerHTML = isList
    ? `<button class="folder-back" onclick="privateFolder=null;renderPrivateBrowse()">‹ 私密列表</button> ${escapeHtml(privateFolder.name)}`
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
  const newBtn = `<div class="folder-card" data-pnew="1" style="border:1.5px dashed var(--separator);background:transparent;box-shadow:none;">
        <div class="folder-icon" style="background:var(--fill);color:var(--accent);">${icon('plus', 24)}</div>
        <div class="folder-name" style="color:var(--accent);">新建私密列表</div>
        <div class="folder-meta">创建后即可加入视频</div>
      </div>`;
  if (!myPrivateLists.length) {
    folderEl.innerHTML = '<div class="empty"><div class="big">' + icon('lock', 42) + '</div>暂无私密列表<br>点击右上角新建</div>' + newBtn;
  } else {
    folderEl.innerHTML = myPrivateLists.map((l) => `
      <div class="folder-card" data-pfolder="${l.id}" data-pname="${escapeHtml(l.name)}">
        <div class="folder-icon private">${icon('lock', 24)}<span class="folder-badge">${l.items.length}</span></div>
        <div class="folder-name">${escapeHtml(l.name)}</div>
        <div class="folder-meta">${l.items.length} 个视频</div>
      </div>`).join('') + newBtn;
  }
  grid.innerHTML = '';
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

async function removePrivateList(listId) {
  showActionSheet({
    title: '删除私密列表',
    message: '删除后其中视频将恢复显示在浏览页。',
    confirmText: '删除',
    onConfirm: async () => {
      try {
        const res = await privateFetch(`/api/lists/${listId}`, { method: 'DELETE' }, () => removePrivateList(listId));
        if (res === null) return;
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '删除失败');
        showToast('私密列表已删除');
        closeModal();
        loadLists();
        loadLibrary();
      } catch (err) { showToast(err.message, true); }
    },
  });
}

async function removePrivateItem(listId, name) {
  try {
    const res = await privateFetch(`/api/lists/${listId}/items`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ names: [name] }),
    }, () => removePrivateItem(listId, name));
    if (res === null) return;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '移除失败');
    showToast('已移除');
    renderPrivateBrowse();
    loadLists();
    loadLibrary();
  } catch (err) { showToast(err.message, true); }
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
            closeModal();
          } catch (err) { showToast(err.message, true); }
        },
      });
    },
  });
}

// ═══════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════
// 登录鉴权

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
  const lbl = $('currentUserLabel');
  const u = getAuthUser();
  if (lbl) lbl.textContent = u ? `当前用户：${u}` : '';
}
function hideLogin() { const s = $('loginScreen'); if (s) s.classList.add('hidden'); }
async function doLogout() {
  try { await _origFetch('/api/auth/logout', { method: 'POST' }); } catch (_) {}
  setAuthToken(''); setAuthUser('');
  // 退出登录同时清除私密状态（安全）
  setPrivateToken(''); privateCtx = false;
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
// 事件绑定与初始化
// ═══════════════════════════════════════════════════════
$('cleanCompletedBtn').addEventListener('click', cleanCompleted);
$('selectModeBtn').addEventListener('click', () => { selectionMode ? exitSelectionMode() : enterSelectionMode(); });
$('batchSelectAllBtn').addEventListener('click', toggleSelectAll);
$('batchOpsBtn').addEventListener('click', openBatchOps);
$('batchCancelBtn').addEventListener('click', exitSelectionMode);
$('openListsBtn').addEventListener('click', () => { browseFolder = null; renderBrowse(); });
$('privateEntryBtn').addEventListener('click', openPrivateEntry);
$('privateLockBtn').addEventListener('click', closePrivateApp);
$('privateChangePinBtn')?.addEventListener('click', openChangePin);
$('downloadBtn').addEventListener('click', submitDownload);
$('urlInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitDownload(); });
$('playUrlBtn').addEventListener('click', playUrl);
$('playUrlInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') playUrl(); });
$('inlinePlayerClose').addEventListener('click', () => closePlayer('browse'));
$('privateInlinePlayerClose').addEventListener('click', () => closePlayer('private'));
$('cacheMenuBtn').addEventListener('click', () => {
  if (!PlayerCore.getCurrentPlay()) return;
  const btn = $('cacheMenuBtn');
  if (preloadManager.isCaching) { showToast('正在缓存中…'); return; }
  btn.innerHTML = '<span style="font-size:11px;">0%</span>';
  btn.style.width = '36px';
  preloadManager.startCache((pct) => {
    if (pct >= 100) {
      btn.innerHTML = icon('checkmark', 16);
      btn.style.width = '';
      showToast('视频已缓存到本地');
      refreshCacheStats(document.getElementById('cacheStats'));
    } else {
      btn.innerHTML = '<span style="font-size:11px;">' + pct + '%</span>';
    }
  }).catch(() => {
    btn.innerHTML = icon('folder', 16);
    btn.style.width = '';
    showToast('缓存失败', true);
  });
});
$('privateCacheMenuBtn').addEventListener('click', () => {
  if (!PlayerCore.getCurrentPlay()) return;
  const btn = $('privateCacheMenuBtn');
  if (preloadManager.isCaching) { showToast('正在缓存中…'); return; }
  btn.innerHTML = '<span style="font-size:11px;">0%</span>';
  btn.style.width = '36px';
  preloadManager.startCache((pct) => {
    if (pct >= 100) {
      btn.innerHTML = icon('checkmark', 16);
      btn.style.width = '';
      showToast('视频已缓存到本地');
      refreshCacheStats(document.getElementById('cacheStats'));
    } else {
      btn.innerHTML = '<span style="font-size:11px;">' + pct + '%</span>';
    }
  }).catch(() => {
    btn.innerHTML = icon('folder', 16);
    btn.style.width = '';
    showToast('缓存失败', true);
  });
});
$('refreshHealth').addEventListener('click', loadHealth);
$('clearCacheBtn').addEventListener('click', async () => {
  await clearAllCache();
  showToast('已清空视频缓存');
});
$('loginBtn').addEventListener('click', doLogin);
$('loginPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
$('loginUser').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
$('logoutBtn')?.addEventListener('click', (e) => { e.preventDefault(); doLogout(); });

// 视图切换
$('libraryViewToggle').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  settings.libraryView = btn.dataset.view;
  saveSettings();
  document.querySelectorAll('#libraryViewToggle button').forEach(b => b.classList.toggle('active', b === btn));
  renderLibrary(libraryFiles);
});
$('privateViewToggle').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  settings.libraryView = btn.dataset.view;
  saveSettings();
  document.querySelectorAll('#privateViewToggle button').forEach(b => b.classList.toggle('active', b === btn));
  renderPrivateBrowse();
});

// 文件夹网格事件（事件委托）
$('folderGrid').addEventListener('click', (e) => {
  const card = e.target.closest('[data-enter="list"], [data-new="1"]');
  if (!card) return;
  const del = e.target.closest('[data-del-list]');
  if (del) { event.stopPropagation(); removeList(del.dataset.delList); return; }
  if (card.dataset.new) { openCreateList(false); return; }
  enterListFolder(card.dataset.id, card.dataset.name, false);
});
$('privateFolderGrid').addEventListener('click', (e) => {
  const card = e.target.closest('[data-pfolder], [data-pnew]');
  if (!card) return;
  if (card.dataset.pnew) { openCreateList(true); return; }
  privateFolder = { id: card.dataset.pfolder, name: card.dataset.pname };
  renderPrivateBrowse();
});

// macOS 菜单栏
document.querySelectorAll('.mb-item').forEach((item) => {
  item.addEventListener('click', () => {
    const m = item.dataset.menu;
    const actions = {
      'app': () => { showToast('视频下载器 v2.2 · Playwright 流拦截 + 多引擎下载'); },
      'file': () => { ensureOpen('downloads'); setTimeout(() => $('urlInput').focus(), 100); },
      'edit': () => { ensureOpen('downloads'); setTimeout(() => $('urlInput').select(), 100); },
      'view': () => {
        const t = settings.theme === 'dark' ? 'light' : 'dark';
        settings.theme = t; saveSettings(); applyTheme();
        showToast(t === 'dark' ? '已切换深色模式' : '已切换浅色模式');
      },
      'window': () => { ensureOpen('browse'); },
    };
    (actions[m] || actions['app'])();
  });
});

// 键盘快捷键（macOS 惯例：Cmd/Ctrl + 键）
document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return;
  const k = e.key.toLowerCase();
  if (k === 'enter') { e.preventDefault(); submitDownload(); }
  else if (k === 'f') { e.preventDefault(); ensureOpen('downloads'); setTimeout(() => $('urlInput').focus(), 80); }
  else if (k === 'w') { e.preventDefault(); if (activeApp) closeApp(activeApp); }
  else if (k === 'm') { e.preventDefault(); if (activeApp) minimizeApp(activeApp); }
  else if (k === '1') { e.preventDefault(); ensureOpen('downloads'); }
  else if (k === '2') { e.preventDefault(); ensureOpen('browse'); }
  else if (k === '3') { e.preventDefault(); ensureOpen('settings'); }
});

// 播放器快捷键：空格=暂停/继续，←/→=后退/前进 30 秒
document.addEventListener('keydown', (e) => {
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  const browseBox = $('inlinePlayer');
  const privBox = $('privateInlinePlayer');
  let video = null, box = null, target = 'browse';
  if (browseBox && !browseBox.hidden) { video = $('inlinePlayerVideo'); box = browseBox; }
  else if (privBox && !privBox.hidden) { video = $('privateInlinePlayerVideo'); box = privBox; target = 'private'; }
  if (!video || !box) return;

  if (e.code === 'Space') {
    e.preventDefault();
    e.stopPropagation();
    if (video.paused) { PlayerCore.setUserPaused(false); video.play().catch(() => {}); }
    else { PlayerCore.setUserPaused(true); video.pause(); }
    const cp = PlayerCore.getCurrentPlay();
    if (cp) upsertHistory({ ...cp, time: video.currentTime || 0, duration: video.duration || 0, updatedAt: Date.now() });
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    video.currentTime = Math.max(0, (video.currentTime || 0) - 30);
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    video.currentTime = Math.min(video.duration || Infinity, (video.currentTime || 0) + 30);
  }
});

// PIN 物理键盘输入
document.addEventListener('keydown', (e) => {
  if (pinState && !$('modalMask').hidden) {
    if (/^[0-9]$/.test(e.key)) pinKey(parseInt(e.key, 10));
    else if (e.key === 'Backspace') pinKey('del');
  }
});

// 初始化
window.addEventListener('load', () => {
  applyTheme();
  applyWallpaper();
  renderSettingsForm();
  bindSettingsForm();
  bindLibraryCardEvents();
  // ⭐ Dock 图标注入（HEAD 契约：SVG 图标 + label，缺失会导致只剩纯色方块）
  document.querySelector('.dock-icon[data-app="downloads"]').innerHTML = `${icon('download', 24)}<span class="label">下载</span>`;
  document.querySelector('.dock-icon[data-app="browse"]').innerHTML = `${icon('playRect', 24)}<span class="label">浏览</span>`;
  document.querySelector('.dock-icon[data-app="settings"]').innerHTML = `${icon('gear', 24)}<span class="label">设置</span>`;
  document.querySelector('.dock-icon[data-app="private"]').innerHTML = `${icon('lock', 24)}<span class="label">私密</span>`;
  if (!getAuthToken()) { showLogin(); return; }
  hideLogin();
  // socket 由 io() 自动连接（L461），无需手动 socketConnect()
  loadLists();
  loadTasks();
  loadHealth();
  refreshCacheStats(document.getElementById('cacheStats'));
  ensureOpen('downloads');
});

// 暴露给 e2e 的全局接口
window.loadLists = loadLists;
window.loadPrivateLists = loadPrivateLists;
window.renderPrivateBrowse = renderPrivateBrowse;
window.backToRoot = backToRoot;
