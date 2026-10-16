/**
 * verify-dev-pages.js — 浏览器调试页实机验证(需要 dev server 已启动)
 *   1) npm run dev:reader   (或 dev:sidebar, 任一并存)
 *   2) npm i --no-save playwright-core   (仅本脚本需要, 不进 package.json)
 *   3) node scripts/verify-dev-pages.js
 * 用系统 Edge/Chrome(channel) 打开两个 dev 页面, 断言关键 DOM 渲染 + 无 JS 报错。
 * 无对应浏览器时自动 SKIP。
 */
const { chromium } = require('playwright-core');

(async () => {
  let browser;
  try {
    browser = await chromium.launch({ channel: process.env.PW_CHANNEL || 'msedge' });
  } catch (e) {
    console.log('SKIP: 未找到系统 Chrome, 跳过浏览器实机验证 (' + e.message.split('\n')[0] + ')');
    process.exit(0);
  }
  const errors = [];
  const page = await browser.newPage();

  // 阅读面板
  page.on('console', (m) => { { const t = m.text(); if (m.type() === 'error' && !/favicon|404/.test(t)) { errors.push('[reader console] ' + t); } } });
  page.on('pageerror', (e) => { errors.push('[reader pageerror] ' + e.message); });
  await page.goto('http://localhost:5199/webview/reader/dev.html', { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  const title = await page.textContent('#content .chapter-title').catch(() => null);
  const paras = await page.locator('#content p').count();
  const bookInfo = await page.textContent('#bookInfo').catch(() => null);
  console.log('reader 标题:', title, '| 段落数:', paras, '| 状态栏:', (bookInfo || '').slice(0, 30));

  // 侧边栏
  const page2 = await browser.newPage();
  page2.on('console', (m) => { { const t = m.text(); if (m.type() === 'error' && !/favicon|404/.test(t)) { errors.push('[sidebar console] ' + t); } } });
  page2.on('pageerror', (e) => { errors.push('[sidebar pageerror] ' + e.message); });
  await page2.goto('http://localhost:5199/webview/sidebar/dev.html', { waitUntil: 'networkidle' });
  await page2.waitForTimeout(400);
  const chs = await page2.locator('.ch').count();
  const cardTitle = await page2.textContent('#currentCard .t').catch(() => null);
  const bg = await page2.evaluate(() => getComputedStyle(document.body).backgroundColor);
  console.log('sidebar 章节数:', chs, '| 当前阅读条:', cardTitle, '| body 背景:', bg);

  await browser.close();

  if (errors.length) {
    console.log('发现错误:');
    for (const e of errors) { console.log(' -', e); }
    process.exit(1);
  }
  if (title && paras > 0 && chs > 0) {
    console.log('浏览器实机验证: 通过 ✔');
  } else {
    console.log('浏览器实机验证: 渲染不完整');
    process.exit(1);
  }
})();
