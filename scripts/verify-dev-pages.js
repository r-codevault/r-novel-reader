/**
 * verify-dev-pages.js — 浏览器调试页实机验证(需要 dev server 已启动)
 *   1) npm run dev
 *   2) npm i --no-save playwright-core   (仅本脚本需要, 不进 package.json)
 *   3) node scripts/verify-dev-pages.js
 * 用系统 Edge/Chrome(channel) 打开 dev 页面, 断言关键 DOM 渲染 + 无 JS 报错。
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

  await browser.close();

  if (errors.length) {
    console.log('发现错误:');
    for (const e of errors) { console.log(' -', e); }
    process.exit(1);
  }
  if (title && paras > 0) {
    console.log('浏览器实机验证(阅读面板): 通过 ✔');
  } else {
    console.log('浏览器实机验证: 渲染不完整');
    process.exit(1);
  }
})();
