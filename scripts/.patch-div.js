/** 一次性: 断言顺序更新(分隔线移到折叠按钮之后) */
const fs = require('fs');
const f = 'scripts/smoke-reader-vue.js';
let s = fs.readFileSync(f, 'utf8');

const oldOrder = "    JSON.stringify([null, 'shelf', 'catalog', 'statusbar', 'settings', 'storage', 'divider']),";
if (!s.includes(oldOrder)) { throw new Error('顺序断言未找到'); }
s = s.replace(oldOrder, "    JSON.stringify([null, 'divider', 'shelf', 'catalog', 'statusbar', 'settings', 'storage']),");

const oldMsg = "    '菜单顺序应为 书架/目录/状态栏/阅读设置/存储位置 + 末尾分割线, 实际: ' + JSON.stringify(order)";
if (!s.includes(oldMsg)) { throw new Error('顺序提示未找到'); }
s = s.replace(oldMsg, "    '菜单顺序应为 折叠按钮 + 分割线 + 书架/目录/状态栏/阅读设置/存储位置, 实际: ' + JSON.stringify(order)");

const oldLast = [
  "  assert(",
  "    document.querySelector('.menu').lastElementChild.classList.contains('menu-divider'),",
  "    '分割线应在菜单最下方'",
  "  );",
].join('\n');
if (!s.includes(oldLast)) { throw new Error('lastElementChild 断言未找到'); }
s = s.replace(oldLast, [
  "  assert(",
  "    document.querySelector('.menu').children[1].classList.contains('menu-divider'),",
  "    '分割线应在折叠按钮之后(菜单项之前)'",
  "  );",
].join('\n'));

fs.writeFileSync(f, s);
console.log('断言已更新');
