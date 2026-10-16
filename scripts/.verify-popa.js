/** 临时: 校验各弹窗底色 = 正文纸面色(与 #content 一致), 并截图三种主题 */
const { chromium } = require('playwright-core');

(async () => {
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('http://localhost:5207/webview/reader/dev.html', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#content .chapter-title', { timeout: 8000 });
  await page.waitForTimeout(300);

  const bgOf = (sel) => page.evaluate((s) => {
    const el = document.querySelector(s);
    return el ? getComputedStyle(el).backgroundColor : 'N/A';
  }, sel);

  const read = async () => ({
    content: await bgOf('#content'),
    catalog: await bgOf('#catalogPanel'),
    settings: await bgOf('#settingsPanel'),
    shelf: await bgOf('#shelfPopup'),
    storage: await bgOf('#storagePopup'),
  });

  // 默认主题(白)
  console.log('白:', JSON.stringify(await read()));

  // 切羊皮纸(sepia) 验证对比
  await page.locator('.menu-item[data-menu="settings"]').click();
  await page.waitForTimeout(250);
  await page.locator('#settingsPanel .sp-dot[data-theme="sepia"]').click();
  await page.waitForTimeout(250);
  console.log('sepia:', JSON.stringify(await read()));
  await page.screenshot({ path: '.dev-popup-sepia.png' });

  // 黑夜
  await page.locator('#settingsPanel .sp-dot[data-theme="dark"]').click();
  await page.waitForTimeout(250);
  console.log('dark:', JSON.stringify(await read()));
  await page.screenshot({ path: '.dev-popup-dark.png' });

  console.log(errors.length ? ('JS 错误: ' + errors.join(' | ')) : '无 JS 错误 ✔');
  await browser.close();
})();
