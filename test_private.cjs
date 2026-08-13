const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', err => { errors.push(err.message); console.error('PAGE ERROR:', err.message); });
  page.on('console', msg => { if (msg.type() === 'error') console.error('CONSOLE ERROR:', msg.text()); });
  page.on('response', resp => {
    if (resp.status() >= 400) console.error('HTTP ERROR:', resp.status(), resp.url());
  });

  // Login
  await page.goto('http://localhost:3456/macos.html', { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForTimeout(1000);
  
  await page.fill('#loginUser', 'wilsonwen');
  await page.fill('#loginPass', 'Wenq5201314');
  await page.click('#loginBtn');
  await page.waitForTimeout(2000);
  console.log('After login, URL:', page.url());
  
  // Check if login succeeded
  const loginScreen = await page.$('#loginScreen');
  const loginVisible = loginScreen ? await loginScreen.isVisible() : false;
  console.log('Login screen visible:', loginVisible);
  
  if (loginVisible) {
    console.log('Login failed - trying alternative...');
    await browser.close();
    return;
  }
  
  // Navigate to private section
  // Click settings
  await page.click('.dock-icon[data-app="settings"]');
  await page.waitForTimeout(500);
  
  // Click private entry
  await page.click('#privateEntryBtn');
  await page.waitForTimeout(1000);
  
  // Check for private password screen
  console.log('Checking private password...');
  
  // Check if we need to set a password
  const pinScreen = await page.$('.pin-screen');
  if (pinScreen && await pinScreen.isVisible()) {
    console.log('Private PIN screen visible');
    // Try to set password '1234'
    // Click digits
    for (const digit of '1234') {
      const btn = await page.$(`[data-pin="${digit}"]`);
      if (btn) await btn.click();
      await page.waitForTimeout(100);
    }
    await page.waitForTimeout(1000);
    console.log('After PIN entry');
  }
  
  // Check private window
  const privateWin = await page.$('#win-private');
  const privateVisible = privateWin ? !(await privateWin.getAttribute('class'))?.includes('closed') : false;
  console.log('Private window visible:', privateVisible);
  
  // Check private folder grid
  const folderGrid = await page.$('#privateFolderGrid');
  const folderHidden = folderGrid ? await folderGrid.getAttribute('hidden') : 'N/A';
  console.log('Private folder grid hidden:', folderHidden);
  
  // Check if there are private folders
  const folders = await page.$$('[data-pfolder]');
  console.log('Private folders count:', folders.length);
  
  // Click on first private folder if exists
  if (folders.length > 0) {
    await folders[0].click();
    await page.waitForTimeout(1000);
    
    // Check for video cards
    const videoCards = await page.$$('#privateLibraryGrid .video-card');
    console.log('Private video cards:', videoCards.length);
    
    // Click first video
    if (videoCards.length > 0) {
      // Take screenshot before clicking
      await page.screenshot({ path: '/tmp/vd-before-click.png' });
      
      await videoCards[0].click();
      await page.waitForTimeout(2000);
      
      // Check if player is visible
      const player = await page.$('#privateInlinePlayer');
      const playerHidden = player ? await player.getAttribute('hidden') : 'N/A';
      console.log('Private player hidden:', playerHidden);
      
      const videoEl = await page.$('#privateInlinePlayerVideo');
      const videoSrc = videoEl ? await videoEl.getAttribute('src') : 'N/A';
      console.log('Video source:', videoSrc?.substring(0, 100));
      
      await page.screenshot({ path: '/tmp/vd-after-click.png' });
    }
  }
  
  console.log('Errors:', errors.slice(0, 10));
  await browser.close();
})().catch(e => { console.error(e.message); process.exit(1); });