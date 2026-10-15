/**
 * webview/reader/composables/shortcut.ts — 快捷键解析与匹配
 */

export interface ShortcutCombo {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  key: string;
}

export function normalizeKey(k: string): string {
  if (k === 'left') { return 'arrowleft'; }
  if (k === 'right') { return 'arrowright'; }
  if (k === 'up') { return 'arrowup'; }
  if (k === 'down') { return 'arrowdown'; }
  if (k === 'esc') { return 'escape'; }
  if (k === 'space' || k === 'spacebar') { return ' '; }
  return k;
}

/** 快捷键字符串 -> {ctrl,alt,shift,meta,key}; 空/非法返回 null(表示禁用) */
export function parseShortcut(str: string | undefined): ShortcutCombo | null {
  if (!str || typeof str !== 'string') { return null; }
  const raw = str.toLowerCase().split('+');
  const parts: string[] = [];
  for (const item of raw) {
    const trimmed = item.split(' ').join('');
    if (trimmed) { parts.push(trimmed); }
  }
  const combo: ShortcutCombo = { ctrl: false, alt: false, shift: false, meta: false, key: '' };
  for (const p of parts) {
    if (p === 'ctrl' || p === 'control') { combo.ctrl = true; }
    else if (p === 'alt' || p === 'option') { combo.alt = true; }
    else if (p === 'shift') { combo.shift = true; }
    else if (p === 'meta' || p === 'cmd' || p === 'command' || p === 'win') { combo.meta = true; }
    else { combo.key = normalizeKey(p); }
  }
  return combo.key ? combo : null;
}

export function matchShortcut(combo: ShortcutCombo | null, e: KeyboardEvent): boolean {
  if (!combo) { return false; }
  let key = (e.key || '').toLowerCase();
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
export function shortcutLabel(str: string | undefined): string {
  const combo = parseShortcut(str);
  if (!combo) { return '未设置'; }
  const parts: string[] = [];
  if (combo.ctrl) { parts.push('Ctrl'); }
  if (combo.alt) { parts.push('Alt'); }
  if (combo.shift) { parts.push('Shift'); }
  if (combo.meta) { parts.push('Cmd/Win'); }
  let key = combo.key === ' ' ? 'Space' : combo.key.replace('arrow', '');
  key = key.charAt(0).toUpperCase() + key.slice(1);
  parts.push(key);
  return parts.join('+');
}
