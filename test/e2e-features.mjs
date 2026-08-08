/**
 * 行为级验证脚本 — Playwright 驱动真实浏览器验证 4 项新功能
 * 运行：node test/e2e-features.mjs
 */
import { chromium } from 'playwright';

const BASE = 'http://localhost:3456';
let passed = 0, failed = 0;
const results = [];

function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
  results.push({ name, ok, detail });
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => { console.log('  ⚠️ 页面JS错误:', e.message); });
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon')) console.log('  ⚠️ console.error:', m.text()); });

try {
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

  // ── 3. 我的列表 + 创建列表 ──
  await page.click('#openListsBtn');
  await page.waitForTimeout(400);
  const listsModal = await page.$eval('#modalMask', el => !el.hidden);
  check('我的列表面板弹出', listsModal);
  // 新建列表入口
  const createEntry = await page.$eval('#modalCard', el => el.textContent.includes('新建公开列表'));
  check('面板含新建列表入口', createEntry);
  await page.click('#modalMask .modal-close');
  await page.waitForTimeout(200);

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
  const manageModal = await page.$eval('#modalCard', el => el.textContent.includes('私密列表'));
  check('设置成功自动解锁进入私密列表管理', manageModal);

  // 管理面板含全部操作
  const manageText = await page.$eval('#modalCard', el => el.textContent);
  check('管理面板含全部操作', manageText.includes('新建私密列表') && manageText.includes('修改密码') && manageText.includes('退出锁定'));
  // 关闭管理面板
  await page.click('#modalMask .modal-close');
  await page.waitForTimeout(200);

  // 再次进入：仅需输入密码（iOS PIN 验证）
  await page.click('#privateEntryBtn');
  await page.waitForTimeout(400);
  const verifyTitle = await page.$eval('#modalCard .pin-screen-title', el => el.textContent).catch(() => '');
  check('已设置密码后进入输入密码界面', verifyTitle.includes('输入密码'), `title=${verifyTitle}`);

  // 输入错误密码 9999 → 提示错误并转 6 位
  for (const d of ['9', '9', '9', '9']) { await page.click(`#modalCard .numpad button:text-is("${d}")`); await page.waitForTimeout(80); }
  await page.waitForTimeout(500);
  const errText = await page.$eval('#pinError', el => el.textContent).catch(() => '');
  check('错误密码提示', errText.includes('密码错误'), errText);

  // 输入正确密码 1234 解锁（管理面板特有内容：新建私密列表）
  for (const d of ['1', '2', '3', '4']) { await page.click(`#modalCard .numpad button:text-is("${d}")`); await page.waitForTimeout(80); }
  await page.waitForTimeout(800);
  const manageAgainText = await page.$eval('#modalCard', el => el.textContent).catch(() => '');
  check('正确密码解锁进入私密列表管理', manageAgainText.includes('新建私密列表'), manageAgainText.slice(0, 60));

  // ── 4.5 删除视频：iOS Action Sheet 确认菜单（替代原生 confirm） ──
  await page.click('#modalMask .modal-close');
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
  // 模拟未解锁状态（清除本地 token）
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
  // 输入正确密码解锁 → 自动继续加入流程（PIN 界面关闭）
  for (const d of ['1', '2', '3', '4']) { await page.click(`#modalCard .numpad button:text-is("${d}")`); await page.waitForTimeout(80); }
  await page.waitForTimeout(800);
  const pinClosed = await page.$eval('#modalCard .pin-screen', el => !el).catch(() => true);
  check('解锁后自动继续加入流程（PIN 界面关闭）', pinClosed);
  // 退出选择模式，清理状态
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
    for (const d of ['1', '2', '3', '4']) { await page.click(`#modalCard .numpad button:text-is("${d}")`); await page.waitForTimeout(80); }
    await page.waitForTimeout(800);
  }
  const manageHasCreate = await page.$eval('#modalCard', el => el.textContent.includes('新建私密列表')).catch(() => false);
  check('解锁后进入私密列表管理', manageHasCreate);

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
}

console.log(`\n════ 结果: ${passed} 通过 / ${failed} 失败 ════`);
process.exit(failed > 0 ? 1 : 0);
