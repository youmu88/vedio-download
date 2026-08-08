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

  // ── 4. 设置窗口私密列表入口 + 密码设置 ──
  await page.click('.dock-icon[data-app="settings"]');
  await page.waitForTimeout(500);
  const privateEntry = await page.$('#privateEntryBtn');
  check('设置页私密列表入口存在', !!privateEntry);

  await page.click('#privateEntryBtn');
  await page.waitForTimeout(400);
  const setupModal = await page.$eval('#modalCard', el => el.textContent.includes('设置私密密码'));
  check('首次进入弹出密码设置弹窗', setupModal);

  // 输入密码 1234 + 确认
  await page.fill('#pinNew', '1234');
  await page.fill('#pinConfirm', '1234');
  await page.click('#modalCard .btn-primary');
  await page.waitForTimeout(600);
  const verifyModal = await page.$eval('#modalCard', el => el.textContent.includes('输入私密密码'));
  check('设置成功后进入验证弹窗', verifyModal);

  // 输入错误密码
  await page.fill('#pinInput', '9999');
  await page.click('#modalCard .btn-primary');
  await page.waitForTimeout(500);
  const errText = await page.$eval('#pinError', el => el.textContent).catch(() => '');
  check('错误密码提示', errText.includes('密码错误'), errText);

  // 输入正确密码
  await page.fill('#pinInput', '1234');
  await page.click('#modalCard .btn-primary');
  await page.waitForTimeout(800);
  const manageModal = await page.$eval('#modalCard', el => el.textContent.includes('私密列表'));
  check('正确密码解锁进入私密列表管理', manageModal);
  // 管理面板含新建私密列表 + 修改密码 + 退出锁定
  const manageText = await page.$eval('#modalCard', el => el.textContent);
  check('管理面板含全部操作', manageText.includes('新建私密列表') && manageText.includes('修改密码') && manageText.includes('退出锁定'));

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
