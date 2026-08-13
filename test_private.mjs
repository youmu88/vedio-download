const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  await page.goto('http://localhost:3456/macos.html', { waitUntil: 'networkidle', timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1000);

  // Try to login with common passwords
  const loginUser = await page.$('#loginUser');
  const loginPass = await page.$('#loginPass');
  const loginBtn = await page.$('#loginBtn');
  if (loginUser && loginPass && loginBtn) {
    // Try common passwords
    for (const pw of ['test123', 'admin', 'password', '123456', 'wilsonwen']) {
      await loginUser.fill('wilsonwen');
      await loginPass.fill(pw);
      await loginBtn.click();
      await page.waitForTimeout(500);
      const loginScreen = await page.$('#loginScreen');
      const isVisible = loginScreen ? await loginScreen.isVisible() : false;
      if (!isVisible) {
        console.log('Logged in with password:', pw);
        break;
      }
    }
  }

  const loginScreen = await page.$('#loginScreen');
  const isLoginVisible = loginScreen ? await loginScreen.isVisible() : false;
  console.log('Login screen visible:', isLoginVisible);

  // Check playPrivateVideo source
  const pfResult = await page.evaluate(() => ({
    source: (window.playPrivateVideo || Function('')).toString().substring(0, 300),
  }));
  console.log('playPrivateVideo:', pfResult.source);
  console.log('Errors:', errors.slice(0, 5));
  await browser.close();
})().catch(e => { console.error(e.message); process.exit(1); });