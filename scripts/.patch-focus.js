/** 一次性: 断言焦点框规则(鼠标无框/键盘有框) */
const fs = require('fs');
const f = 'scripts/smoke-reader-vue.js';
let s = fs.readFileSync(f, 'utf8');
const anchor = "  assert(/\\.menu svg\\s*\\{[^}]*width:\\s*20px/.test(capturedHtml), '菜单图标应统一 20px');";
if (!s.includes(anchor)) { throw new Error('锚点未找到'); }
s = s.replace(anchor, [
  anchor,
  '',
  '  // 鼠标点击不应残留焦点框(仅键盘导航显示)',
  '  assert(',
  '    /button:focus:not\\(:focus-visible\\)\\s*\\{[^}]*outline:\\s*none/.test(capturedHtml),',
  "    '鼠标点击后不应残留焦点框(:focus:not(:focus-visible) -> outline:none)'",
  '  );',
  '  assert(/button:focus-visible\\s*\\{[^}]*outline:\\s*2px/.test(capturedHtml), \'键盘导航仍应保留焦点框\');',
].join('\n'));
fs.writeFileSync(f, s);
console.log('断言已加');
