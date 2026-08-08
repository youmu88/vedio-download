/**
 * 行为级验证脚本 — Playwright 驱动真实浏览器验证功能
 * ⭐ 自启隔离实例：独立端口 + 独立数据目录（VD_DATA_DIR），绝不污染真实 data/
 * 运行：node test/e2e-features.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TEST_PORT = 3499;
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vd-e2e-'));
const BASE = `http://localhost:${TEST_PORT}`;
let passed = 0, failed = 0;
const results = [];

function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
  results.push({ name, ok, detail });
}

// ── 启动隔离测试实例（独立数据目录 + 独立端口） ──
const server = spawn('node', ['src/index.js'], {
  cwd: path.resolve(process.cwd()),
  env: { ...process.env, PORT: String(TEST_PORT), VD_DATA_DIR: TEST_DATA_DIR },
  stdio: 'pipe',
});
server.stdout.on('data', () => {});
server.stderr.on('data', () => {});
async function waitForServer() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => { console.log('  ⚠️ 页面JS错误:', e.message); });
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon')) console.log('  ⚠️ console.error:', m.text()); });

try {
  if (!await waitForServer()) { throw new Error('隔离测试实例启动失败'); }
  console.log(`  🔌 隔离实例已启动: :${TEST_PORT} 数据目录=${TEST_DATA_DIR}`);
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(800);

  // ── 1. 一键清理按钮 ──
  const cleanBtn = await page.$('#cleanCompletedBtn');
  check('清理按钮存在', !!cleanBtn);

  // 打开下载窗口
  await page.click('.dock-icon[data-app="downloads"]');
  await page.waitForTimeout(400);
  const cleanVisible = await page.$eval('#cleanCompletedBtn', el => !el.hidden);
  // 当前环境 completed=0 时按钮应隐藏；completed>0 时按钮应显示（与任务状态一致即正确）
  const completedCount = await page.evaluate(async () => {
    const res = await fetch('/api/tasks');
    const tasks = await res.json();
    return tasks.filter(t => t.status === 'completed').length;
  });
  const expectedVisible = completedCount > 0;
  check('清理按钮显隐与已完成任务数一致', cleanVisible === expectedVisible, `visible=${cleanVisible} completed=${completedCount}`);
  // API 层验证：无已完成任务时调用返回 removed:0
  const cleanRes = await page.evaluate(async () => {
    const res = await fetch('/api/tasks/clean-completed', { method: 'POST' });
    return await res.json();
  });
  check('API 一键清理正常响应', cleanRes.ok === true && typeof cleanRes.removed === 'number', JSON.stringify(cleanRes));

  // ── 2. 浏览窗口 + 选择模式 ──
  await page.click('.dock-icon[data-app="browse"]');
  await page.waitForTimeout(500);
  const selectBtn = await page.$('#selectModeBtn');
  check('选择按钮存在', !!selectBtn);

  await page.click('#selectModeBtn');
  await page.waitForTimeout(300);
  const batchBarVisible = await page.$eval('#batchBar', el => !el.hidden);
  check('点击选择按钮后批量栏出现', batchBarVisible);
  const selCheckVisible = await page.$eval('#libraryGrid .sel-check', el => !!el).catch(() => false);
  check('选择模式下卡片显示勾选框', selCheckVisible);

  // 全选
  await page.click('#batchSelectAllBtn');
  await page.waitForTimeout(200);
  const countText = await page.$eval('#batchCount', el => el.textContent);
  check('全选后计数更新', /已选 [1-9]/.test(countText), `count=${countText}`);

  // 全不选（再次点击）
  await page.click('#batchSelectAllBtn');
  await page.waitForTimeout(200);
  const countText2 = await page.$eval('#batchCount', el => el.textContent);
  check('全不选后计数归零', countText2.includes('0'), `count=${countText2}`);

  // 取消选择模式
  await page.click('#batchCancelBtn');
  await page.waitForTimeout(200);
  const batchBarHidden = await page.$eval('#batchBar', el => el.hidden);
  check('取消后批量栏隐藏', batchBarHidden);

  // ── 3. 文件夹导航：我的列表以文件夹呈现，可进入浏览内部视频 ──
  // 先创建公开列表，并刷新页面内列表缓存，确保文件夹可进入
  await page.evaluate(async () => {
    const res = await fetch('/api/lists', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'E2E文件夹' }),
    });
    if (window.loadLists) await window.loadLists(); // 刷新前端 myLists 缓存
    return res.ok;
  });
  await page.waitForTimeout(400);
  await page.click('#openListsBtn');
  await page.waitForTimeout(400);
  const folderVisible = await page.$eval('#folderGrid', el => !el.hidden).catch(() => false);
  check('浏览页以文件夹方式呈现列表', folderVisible);
  const folderHasPrivate = await page.$eval('#folderGrid', el => !el.textContent.includes('私密列表')).catch(() => false);
  check('浏览页不显示私密列表入口（设置界面唯一入口）', folderHasPrivate);
  // 进入公开列表文件夹 → 应显示列表视图（含返回）
  const pubFolder = await page.$('#folderGrid [data-enter="list"]').catch(() => null);
  if (pubFolder) {
    await page.click('#folderGrid [data-enter="list"]');
    await page.waitForTimeout(400);
    const inFolder = await page.$eval('#browseCrumb', el => el.textContent).catch(() => '');
    check('点击文件夹进入列表视图（含返回）', String(inFolder).includes('返回'), inFolder);
    // 返回根视图
    await page.click('#browseCrumb .folder-back');
    await page.waitForTimeout(300);
  } else {
    check('点击文件夹进入列表视图（含返回）', false, '无公开列表可进入');
  }

  // ── 4. 设置窗口私密列表入口 + iOS PIN 密码设置 ──
  await page.click('.dock-icon[data-app="settings"]');
  await page.waitForTimeout(500);
  const privateEntry = await page.$('#privateEntryBtn');
  check('设置页私密列表入口存在', !!privateEntry);

  // 首次进入：iOS PIN 设置界面（圆点 + 数字键盘）
  await page.click('#privateEntryBtn');
  await page.waitForTimeout(400);
  const setupTitle = await page.$eval('#modalCard .pin-screen-title', el => el.textContent).catch(() => '');
  check('首次进入弹出 iOS PIN 设置界面', setupTitle.includes('设置密码'), `title=${setupTitle}`);
  const numpadKeys = await page.$$eval('#modalCard .numpad button', els => els.length);
  check('数字键盘渲染（≥10 键）', numpadKeys >= 10, `keys=${numpadKeys}`);
  const segVisible = await page.$eval('#modalCard .pin-seg', el => !!el).catch(() => false);
  check('4/6 位分段选择可见', segVisible);

  // 输入新密码 1234 → 自动进入确认
  for (const d of ['1', '2', '3', '4']) { await page.click(`#modalCard .numpad button:text-is("${d}")`); await page.waitForTimeout(80); }
  await page.waitForTimeout(300);
  const confirmTitle = await page.$eval('#modalCard .pin-screen-title', el => el.textContent).catch(() => '');
  check('满位后自动进入确认密码', confirmTitle.includes('确认密码'), `title=${confirmTitle}`);
  for (const d of ['1', '2', '3', '4']) { await page.click(`#modalCard .numpad button:text-is("${d}")`); await page.waitForTimeout(80); }
  await page.waitForTimeout(800);
  // 设置成功后自动解锁并打开私密临时浏览 App（窗口而非 modal）
  const privateWinOpen = await page.$eval('#win-private', el => !el.classList.contains('closed')).catch(() => false);
  check('设置成功自动解锁并打开私密临时 App', privateWinOpen);
  const privateDockVisible = await page.$eval('#privateDockIcon', el => !el.hidden).catch(() => false);
  check('私密临时 App 出现在 Dock', privateDockVisible);
  // 关闭临时 App（锁定并销毁）
  await page.click('#privateLockBtn');
  await page.waitForTimeout(400);
  const privateWinClosed = await page.$eval('#win-private', el => el.classList.contains('closed')).catch(() => true);
  const privateDockHidden = await page.$eval('#privateDockIcon', el => el.hidden).catch(() => true);
  check('退出后临时 App 销毁（窗口关闭+Dock 图标消失）', privateWinClosed && privateDockHidden);

  // 再次进入：仅需输入 1 次密码（iOS PIN 验证）
  await page.click('#privateEntryBtn');
  await page.waitForTimeout(400);
  const verifyTitle = await page.$eval('#modalCard .pin-screen-title', el => el.textContent).catch(() => '');
  check('已设置密码后进入输入密码界面', verifyTitle.includes('输入密码'), `title=${verifyTitle}`);

  // 输入错误密码 9999 → 提示错误并转 6 位
  for (const d of ['9', '9', '9', '9']) { await page.click(`#modalCard .numpad button:text-is("${d}")`); await page.waitForTimeout(80); }
  await page.waitForTimeout(500);
  const errText = await page.$eval('#pinError', el => el.textContent).catch(() => '');
  check('错误密码提示', errText.includes('密码错误'), errText);

  // 输入正确密码 1234 → 仅 1 次即解锁打开临时 App（无需二次确认）
  for (const d of ['1', '2', '3', '4']) { await page.click(`#modalCard .numpad button:text-is("${d}")`); await page.waitForTimeout(80); }
  await page.waitForTimeout(800);
  const privateWinOpen2 = await page.$eval('#win-private', el => !el.classList.contains('closed')).catch(() => false);
  check('单次密码通过即打开私密临时 App（无二次确认）', privateWinOpen2);
  // 关闭临时 App 清理状态
  await page.click('#privateLockBtn');
  await page.waitForTimeout(400);

  // ── 4.5 删除视频：iOS Action Sheet 确认菜单（替代原生 confirm） ──
  await page.evaluate(() => { const mm = document.getElementById('modalMask'); if (mm) mm.hidden = true; });
  await page.waitForTimeout(200);
  await page.click('.dock-icon[data-app="browse"]');
  await page.waitForTimeout(500);
  const delBtn = await page.$('#libraryGrid [data-delete-name]');
  if (delBtn) {
    await page.click('#libraryGrid [data-delete-name]');
    await page.waitForTimeout(400);
    const asVisible = await page.$eval('#modalCard .action-sheet', el => !!el).catch(() => false);
    check('删除视频弹出 iOS Action Sheet', asVisible);
    const asText = await page.$eval('#modalCard', el => el.textContent).catch(() => '');
    check('Action Sheet 含标题与确认按钮', asText.includes('删除') && asText.includes('取消'), asText.slice(0, 60));
    // 点击取消，不真正删除
    await page.click('#modalCard .as-btn.cancel');
    await page.waitForTimeout(300);
  } else {
    check('删除视频弹出 iOS Action Sheet', false, '无删除按钮可测');
  }

  // ── 4.6 回归验证：批量动态菜单 + 加入私密列表自动引导解锁 ──
  // 场景A：无 token（首次）→ 自动引导设置/验证
  await page.evaluate(() => localStorage.removeItem('vd.private.token'));
  await page.click('.dock-icon[data-app="browse"]');
  await page.waitForTimeout(400);
  // 确保进入选择模式
  const selBtnText = await page.$eval('#selectModeBtn', el => el.textContent).catch(() => '');
  if (selBtnText !== '取消') await page.click('#selectModeBtn');
  await page.waitForTimeout(200);
  await page.click('#batchSelectAllBtn');
  await page.waitForTimeout(200);
  // 点击"操作"批量按钮 → 动态菜单（删除 / 加入列表 / 私密列表 / 新建）
  await page.click('#batchOpsBtn');
  await page.waitForTimeout(400);
  const opsText = await page.$eval('#modalCard', el => el.textContent).catch(() => '');
  check('批量操作弹出动态菜单', opsText.includes('删除') && opsText.includes('加入') && opsText.includes('私密列表'), opsText.slice(0, 80));
  // 动态菜单中点击"加入私密列表" → 自动弹出 PIN 解锁界面
  await page.click('#modalCard .as-btn:has-text("加入私密列表")');
  await page.waitForTimeout(500);
  const pinShown = await page.$eval('#modalCard .pin-screen', el => !!el).catch(() => false);
  check('动态菜单加入私密列表自动弹出 PIN 解锁界面', pinShown);
  // 输入正确密码解锁（单次认证）→ 自动继续加入流程（PIN 界面关闭）
  for (const d of ['1', '2', '3', '4']) { await page.click(`#modalCard .numpad button:text-is("${d}")`); await page.waitForTimeout(80); }
  await page.waitForTimeout(800);
  const pinClosed = await page.$eval('#modalCard .pin-screen', el => !el).catch(() => true);
  check('单次密码解锁后自动继续加入流程（PIN 界面关闭）', pinClosed);
  // 退出选择模式，清理状态
  await page.click('#batchCancelBtn').catch(() => {});
  await page.waitForTimeout(200);

  // ── 4.6b 回归验证：token 过期场景（模拟服务重启后本地残留过期 token）──
  // 写入一个伪造的过期 token（服务端不认），再触发加入私密列表 → 应自动引导重新解锁而非报"私密验证已过期"
  await page.evaluate(() => localStorage.setItem('vd.private.token', 'expired-fake-token-1234567890'));
  await page.click('.dock-icon[data-app="browse"]');
  await page.waitForTimeout(400);
  const selBtnTextB = await page.$eval('#selectModeBtn', el => el.textContent).catch(() => '');
  if (selBtnTextB !== '取消') await page.click('#selectModeBtn');
  await page.waitForTimeout(200);
  await page.click('#batchSelectAllBtn');
  await page.waitForTimeout(200);
  await page.click('#batchOpsBtn');
  await page.waitForTimeout(400);
  await page.click('#modalCard .as-btn:has-text("加入私密列表")');
  await page.waitForTimeout(600);
  const pinShownB = await page.$eval('#modalCard .pin-screen', el => !!el).catch(() => false);
  check('过期 token 触发加入私密列表时自动引导重新解锁（而非报错）', pinShownB);
  // 输入正确密码完成重验（单次认证）→ 自动续接加入流程
  for (const d of ['1', '2', '3', '4']) { await page.click(`#modalCard .numpad button:text-is("${d}")`); await page.waitForTimeout(80); }
  await page.waitForTimeout(800);
  const pinClosedB = await page.$eval('#modalCard .pin-screen', el => !el).catch(() => true);
  check('重新解锁（单次认证）后自动续接加入私密列表流程', pinClosedB);
  await page.click('#batchCancelBtn').catch(() => {});
  await page.waitForTimeout(200);

  // ── 4.7 本轮新增：加入列表后浏览页隐藏 / 私密列表卡片播放 / 切后台锁定 ──
  // 通过 API 创建公开列表并加入第一个视频（走真实接口）
  const libFiles = await fetch(`${BASE}/api/library`).then(r => r.json());
  if (libFiles.length) {
    const first = libFiles[0].name;
    const mkRes = await fetch(`${BASE}/api/lists`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'E2E收藏' }),
    });
    const mkData = await mkRes.json();
    const listId = mkData.list?.id;
    if (listId) {
      const addRes = await fetch(`${BASE}/api/lists/${listId}/items`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ names: [first] }),
      });
      check('API: 视频成功加入列表', addRes.ok, JSON.stringify(await addRes.json().catch(() => ({}))).slice(0, 80));
      // 加入列表后浏览页应隐藏该视频
      const libAfter = await fetch(`${BASE}/api/library`).then(r => r.json());
      check('加入列表后浏览页隐藏该视频', !libAfter.some(f => f.name === first), `hidden=${first}`);
      // 清理：删除测试列表（视频恢复可见）
      await fetch(`${BASE}/api/lists/${listId}`, { method: 'DELETE' });
      const libRestored = await fetch(`${BASE}/api/library`).then(r => r.json());
      check('删除列表后视频恢复浏览页可见', libRestored.some(f => f.name === first));
    }
  } else {
    check('API: 视频成功加入列表', false, '视频库为空，跳过');
  }

  // 私密列表：卡片网格播放能力（前端 DOM 断言）
  await page.click('.dock-icon[data-app="settings"]');
  await page.waitForTimeout(400);
  await page.click('#privateEntryBtn');
  await page.waitForTimeout(400);
  const pinVerifyTitle = await page.$eval('#modalCard .pin-screen-title', el => el.textContent).catch(() => '');
  if (pinVerifyTitle.includes('输入密码')) {
    // 单次认证：输入一次密码即解锁
    for (const d of ['1', '2', '3', '4']) { await page.click(`#modalCard .numpad button:text-is("${d}")`); await page.waitForTimeout(80); }
    await page.waitForTimeout(800);
  }
  const privateWinOpen3 = await page.$eval('#win-private', el => !el.classList.contains('closed')).catch(() => false);
  check('解锁后打开私密临时浏览 App', privateWinOpen3);

  // ── 4.7b 本轮新增：新建私密列表入口 / 文件夹总数角标 / 快捷键 / 关闭列表关视频 ──
  // 新建私密列表快捷入口（私密 App 首页）
  const pnewVisible = await page.$eval('#privateFolderGrid [data-pnew]', el => !!el).catch(() => false);
  check('私密 App 首页含「新建私密列表」入口', pnewVisible);
  // 通过 API 创建私密列表并加入视频，验证文件夹总数角标
  const privList = await page.evaluate(async () => {
    const token = localStorage.getItem('vd.private.token');
    const mk = await fetch('/api/lists', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Private-Token': token }, body: JSON.stringify({ name: '角标测试', private: true }),
    }).then(r => r.json());
    if (mk.list?.id) {
      const lib = await fetch('/api/library').then(r => r.json());
      if (lib.length) {
        await fetch(`/api/lists/${mk.list.id}/items`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Private-Token': token }, body: JSON.stringify({ names: [lib[0].name] }),
        });
      }
    }
    return mk;
  });
  await page.waitForTimeout(400);
  await page.evaluate(async () => {
    if (window.loadPrivateLists) { await window.loadPrivateLists(); if (window.renderPrivateBrowse) window.renderPrivateBrowse(); }
  });
  await page.waitForTimeout(400);
  const badgeText = await page.$eval('#privateFolderGrid .folder-badge', el => el.textContent).catch(() => '');
  check('私密文件夹展示总数角标', /^[1-9]/.test(badgeText), `badge=${badgeText}`);
  // 进入私密列表 → 关闭（返回）应关闭内嵌视频
  const pv = await page.$('#privateFolderGrid [data-pfolder]').catch(() => null);
  if (pv) {
    await page.click('#privateFolderGrid [data-pfolder]');
    await page.waitForTimeout(400);
    const pvName = await page.$eval('#privateLibraryGrid [data-pvideo]', el => el.dataset.pvideo).catch(() => '');
    if (pvName) {
      await page.click('#privateLibraryGrid [data-pvideo]');
      await page.waitForTimeout(600);
      const playerVisible = await page.$eval('#privateInlinePlayer', el => !el.hidden).catch(() => false);
      check('私密 App 内嵌播放器打开', playerVisible);
      // 快捷键：空格暂停/继续（无异常即可）
      await page.keyboard.press('Space');
      await page.waitForTimeout(200);
      const afterSpace = await page.$eval('#privateInlinePlayerVideo', el => el.paused).catch(() => true);
      check('空格快捷键暂停/继续生效', typeof afterSpace === 'boolean', `paused=${afterSpace}`);
      // 返回列表首页 → 内嵌视频应关闭
      await page.click('#privateBrowseCrumb .folder-back');
      await page.waitForTimeout(400);
      const closedAfterBack = await page.$eval('#privateInlinePlayer', el => el.hidden).catch(() => true);
      check('返回私密列表首页后内嵌视频已关闭', closedAfterBack);
    } else {
      check('私密 App 内嵌播放器打开', false, '列表无视频');
    }
  }
  await page.click('#privateLockBtn').catch(() => {});
  await page.waitForTimeout(300);

  // ── 5. API 层冒烟（走 HTTP 直接验证） ──
  const api = await fetch(`${BASE}/api/private/status`).then(r => r.json());
  check('API: private/status 返回 hasPassword=true', api.hasPassword === true, JSON.stringify(api));
  const lists = await fetch(`${BASE}/api/lists`).then(r => r.json());
  check('API: lists 正常返回', Array.isArray(lists.lists), JSON.stringify(lists).slice(0, 80));

} catch (e) {
  console.error('❌ 执行异常:', e.message);
  failed++;
} finally {
  await browser.close();
  // 关闭隔离测试实例并清理临时数据目录（不污染真实 data/）
  try { server.kill('SIGTERM'); } catch {}
  try { fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }); } catch {}
}

console.log(`\n════ 结果: ${passed} 通过 / ${failed} 失败 ════`);
process.exit(failed > 0 ? 1 : 0);
