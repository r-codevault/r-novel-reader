/**
 * webview/reader/composables/shortcut.js — 快捷键解析与匹配
 * (从旧内嵌脚本平移; 不用正则 split 解析, 避免 bundler 下转义歧义)
 */

export function normalizeKey(k) {
  if (k === 'left') { return 'arrowleft'; }
  if (k === 'right') { return 'arrowright'; }
  if (k === 'up') { return 'arrowup'; }
  if (k === 'down') { return 'arrowdown'; }
  if (k === 'esc') { return 'escape'; }
  if (k === 'space' || k === 'spacebar') { return ' '; }
  return k;
}

/** 快捷键字符串 -> {ctrl,alt,shift,meta,key}; 空/非法返回 null(表示禁用) */
export function parseShortcut(str) {
  if (!str || typeof str !== 'string') { return null; }
  var raw = str.toLowerCase().split('+');
  var parts = [];
  for (var i = 0; i < raw.length; i++) {
    var trimmed = raw[i].split(' ').join('');
    if (trimmed) { parts.push(trimmed); }
  }
  var combo = { ctrl: false, alt: false, shift: false, meta: false, key: '' };
  for (var j = 0; j < parts.length; j++) {
    var p = parts[j];
    if (p === 'ctrl' || p === 'control') { combo.ctrl = true; }
    else if (p === 'alt' || p === 'option') { combo.alt = true; }
    else if (p === 'shift') { combo.shift = true; }
    else if (p === 'meta' || p === 'cmd' || p === 'command' || p === 'win') { combo.meta = true; }
    else { combo.key = normalizeKey(p); }
  }
  return combo.key ? combo : null;
}

export function matchShortcut(combo, e) {
  if (!combo) { return false; }
  var key = (e.key || '').toLowerCase();
  if (key === 'esc') { key = 'escape'; }
  return (
    !!combo.ctrl === !!e.ctrlKey &&
    !!combo.alt === !!e.altKey &&
    !!combo.shift === !!e.shiftKey &&
    !!combo.meta === !!e.metaKey &&
    combo.key === key
  );
}

/** 快捷键展示文本(设置面板提示用) */
export function shortcutLabel(str) {
  var combo = parseShortcut(str);
  if (!combo) { return '未设置'; }
  var parts = [];
  if (combo.ctrl) { parts.push('Ctrl'); }
  if (combo.alt) { parts.push('Alt'); }
  if (combo.shift) { parts.push('Shift'); }
  if (combo.meta) { parts.push('Cmd/Win'); }
  var key = combo.key === ' ' ? 'Space' : combo.key.replace('arrow', '');
  key = key.charAt(0).toUpperCase() + key.slice(1);
  parts.push(key);
  return parts.join('+');
}
