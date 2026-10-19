<script setup lang="ts">
/**
 * App.vue — 根组件: 装配 + 协调
 * 布局: .shell = [ SideMenu(占位式, 展开把正文推右) | .main(正文/弹窗/状态栏) ]
 * 弹窗互斥: 任何时刻最多一个弹窗(目录/阅读设置/书架/存储)
 */
import { onMounted, nextTick, ref, watch } from 'vue';
import { state, vscode, gotoChapter, saveRestoreState, type ChapterPayload, type DrawerTab, type ShelfItemView } from './composables/vscode';
import { applyThemeVars, DEFAULT_SETTINGS, persistSettings, sendProgress, type ReadingSettings } from './store';
import { parseShortcut, matchShortcut } from './composables/shortcut';
import CatalogPanel from './components/CatalogPanel.vue';
import SettingsPanel from './components/SettingsPanel.vue';
import ReaderArea from './components/ReaderArea.vue';
import StatusBar from './components/StatusBar.vue';
import SideMenu from './components/SideMenu.vue';
import ShelfPopup from './components/ShelfPopup.vue';
import StoragePopup from './components/StoragePopup.vue';
import './reader.css';

const catalogRef = ref<InstanceType<typeof CatalogPanel> | null>(null);
const settingsRef = ref<InstanceType<typeof SettingsPanel> | null>(null);
const shelfRef = ref<InstanceType<typeof ShelfPopup> | null>(null);
const storageRef = ref<InstanceType<typeof StoragePopup> | null>(null);
const readerRef = ref<InstanceType<typeof ReaderArea> | null>(null);

// ---------------------------------------------------------------- 设置应用 / 菜单宽度
function applySettings(s: ReadingSettings): void {
  state.settings = s;
  applyThemeVars(s);
  state.prevCombo = parseShortcut(s.shortcutPrev);
  state.nextCombo = parseShortcut(s.shortcutNext);
  nextTick(function () { readerRef.value?.positionHandles(); });
}

// 菜单宽度写入 CSS 变量(状态栏需要让出左侧空间, 与菜单同步过渡)
watch(function () { return state.menuExpanded; }, function (expanded) {
  document.documentElement.style.setProperty('--menu-w', expanded ? '176px' : '48px');
}, { immediate: true });

// ---------------------------------------------------------------- 弹窗互斥(同一时刻只允许一个)
const popupKeys = ['catalogOpen', 'settingsOpen', 'shelfOpen', 'storageOpen'] as const;

/** 状态栏是否显示(设置项, 默认显示) */
function statusBarVisible(): boolean {
  return !state.settings || state.settings.showStatusBar !== false;
}

function anyPopupOpen(): boolean {
  return state.catalogOpen || state.settingsOpen || state.shelfOpen || state.storageOpen;
}

/** 关闭全部弹窗(点击弹窗外任意处/按 Esc 时调用) */
function closeAllPopups(): void {
  state.catalogOpen = false;
  state.settingsOpen = false;
  state.shelfOpen = false;
  state.storageOpen = false;
}

function openOnly(key: typeof popupKeys[number]): void {
  closeAllPopups();
  state[key] = true;
}

// 双保险: 任何途径(组件内直接赋值)导致的"多弹窗"都会收敛为最后打开的那个
watch(function () {
  return popupKeys.map(function (k) { return state[k] ? '1' : '0'; }).join('');
}, function (sig, oldSig) {
  const opens = popupKeys.filter(function (k) { return state[k]; });
  if (opens.length <= 1) { return; }
  // 保留本次新打开的那个(oldSig 中为 '0' 的), 其余关闭
  let keep: typeof popupKeys[number] | null = null;
  for (let i = 0; i < popupKeys.length; i++) {
    if (sig[i] === '1' && oldSig[i] === '0') { keep = popupKeys[i]; }
  }
  if (!keep) { keep = opens[0]; }
  for (const k of popupKeys) { if (k !== keep) { state[k] = false; } }
});

/** openDrawer 兼容协议: tab -> 对应弹窗 */
function openTab(tab: DrawerTab | undefined): void {
  if (tab === 'shelf') { openOnly('shelfOpen'); }
  else if (tab === 'catalog') { openOnly('catalogOpen'); }
  else if (tab === 'storage') { openOnly('storageOpen'); }
  else { openOnly('shelfOpen'); }
}

// ---------------------------------------------------------------- 扩展消息
function handleExtensionMessage(msg: { type?: string; payload?: Record<string, unknown> }): void {
  if (!msg || !msg.type) { return; }
  switch (msg.type) {
    case 'init': {
      const p = msg.payload as Record<string, unknown>;
      state.novel = {
        totalChapters: p.totalChapters as number,
        totalWords: p.totalWords as number,
        bookTitle: p.bookTitle as string,
        author: p.author as string | undefined,
      };
      document.title = (p.bookTitle as string) + ' - 小说阅读';
      state.chapters = (p.chapters as { index: number; title: string }[]) || [];
      state.catReverse = false;
      state.catCollapsed = [];
      applySettings(p.settings as ReadingSettings);
      // 恢复信息必须用**本次真实载入的章节**, 不能写死 0:
      // 否则刚恢复好的第 N 章会被立刻覆盖成第 0 章, 下次重开窗口就回到开头
      saveRestoreState({
        filePath: (p.filePath as string) || '',
        chapterIndex: (p.chapterIndex as number) || 0,
        scrollRatio: (p.scrollRatio as number) || 0,
      });
      state.chapter = {
        index: p.chapterIndex as number,
        title: p.chapterTitle as string,
        paragraphs: (p.paragraphs as string[]) || [],
        totalChapters: p.totalChapters as number,
        chapterWords: (p.chapterWords as number) || 0,
        scrollRatio: (p.scrollRatio as number) || 0,
      };
      if (p.openSettings) { closeAllPopups(); state.settingsOpen = true; }
      state.shelf = (p.shelf as ShelfItemView[]) || [];
      state.libraryPath = (p.libraryPath as string) || '';
      break;
    }
    case 'chapter':
      state.chapter = msg.payload as unknown as ChapterPayload;
      break;
    case 'settings':
      applySettings(msg.payload as unknown as ReadingSettings);
      break;
    case 'openSettings':
      openOnly('settingsOpen');
      break;
    case 'shelf':
      state.shelf = (msg as { items?: ShelfItemView[] }).items || [];
      break;
    case 'library':
      state.libraryPath = ((msg as { path?: string }).path) || '';
      break;
    case 'openDrawer':
      openTab((msg as { tab?: DrawerTab }).tab);
      break;
  }
}

/** 章节变化: 恢复滚动位置 + 对齐手柄 + 立即上报进度 */
watch(function () { return state.chapter; }, function (ch) {
  if (!ch) { return; }
  nextTick(function () {
    const max = document.body.scrollHeight - window.innerHeight;
    window.scrollTo(0, max > 0 ? (ch.scrollRatio || 0) * max : 0);
    readerRef.value?.positionHandles();
  });
  sendProgress(true);
});

// ---------------------------------------------------------------- 全局事件

/** 滚动上报(节流 600ms, 内部已有debounce); 只在已载入章节时上报 */
function onScroll(): void {
  if (!state.chapter) { return; }
  sendProgress(false);
}

/** 页面转入后台/关闭前立即上报一次, 防止最后一段滚动位置丢失 */
function onVisibilityChange(): void {
  if (document.visibilityState === 'hidden') {
    sendProgress(true);
  }
}

function onDocMouseDown(e: MouseEvent): void {
  if (!anyPopupOpen()) { return; }
  const target = e.target as Node;
  const el = e.target as HTMLElement;
  const inside =
    (catalogRef.value?.el && catalogRef.value.el.contains(target)) ||
    (settingsRef.value?.el && settingsRef.value.el.contains(target)) ||
    (shelfRef.value?.el && shelfRef.value.el.contains(target)) ||
    (storageRef.value?.el && storageRef.value.el.contains(target)) ||
    (el.closest ? !!el.closest('.menu') : false);
  if (!inside) { closeAllPopups(); }
}

/**
 * 清掉当前焦点(仅用于 Esc 等键盘收尾动作)。
 * 原因: 鼠标点过的按钮仍持有焦点, 此时按任意键会让 Chromium 判定为
 *      "键盘导航" 并画出 :focus-visible 焦点框(视觉上像"莫名其妙多了个边框");
 *      主动 blur 可避免该残留, 同时不影响真正的 Tab 键盘导航。
 */
function blurActiveElement(): void {
  const el = document.activeElement as HTMLElement | null;
  if (el && typeof el.blur === 'function' && el !== document.body) {
    el.blur();
  }
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    // Esc: 有弹窗先关弹窗; 否则收起菜单; 两种情况都清掉焦点残留
    if (anyPopupOpen()) {
      e.preventDefault();
      closeAllPopups();
      blurActiveElement();
      return;
    }
    if (state.menuExpanded) {
      e.preventDefault();
      state.menuExpanded = false;
      blurActiveElement();
      return;
    }
  }
  const tag = e.target && (e.target as HTMLElement).tagName
    ? String((e.target as HTMLElement).tagName).toLowerCase() : '';
  if (tag === 'input' || tag === 'select' || tag === 'textarea') { return; }
  if (matchShortcut(state.prevCombo, e)) {
    e.preventDefault();
    blurActiveElement();
    if (state.chapter) { gotoChapter(state.chapter.index - 1); }
    return;
  }
  if (matchShortcut(state.nextCombo, e)) {
    e.preventDefault();
    blurActiveElement();
    if (state.chapter) { gotoChapter(state.chapter.index + 1); }
  }
}

// Ctrl(或 Cmd) + 滚轮: 放大 / 缩小字号
function onWheel(e: WheelEvent): void {
  if (!e.ctrlKey && !e.metaKey) { return; }
  e.preventDefault();
  const cur = (state.settings ? state.settings.fontSize : 0) || DEFAULT_SETTINGS.fontSize;
  const next = Math.min(32, Math.max(12, cur + (e.deltaY < 0 ? 1 : -1)));
  if (next !== cur) { persistSettings({ fontSize: next }); }
}

// ---------------------------------------------------------------- 生命周期
onMounted(function () {
  window.addEventListener('message', function (e: MessageEvent) {
    handleExtensionMessage(e.data as { type?: string; payload?: Record<string, unknown> });
  });
  document.addEventListener('mousedown', onDocMouseDown);
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('wheel', onWheel, { passive: false, capture: true });
  window.addEventListener('resize', function () {
    readerRef.value?.positionHandles();
  });
  // 滚动上报(节流): 不然章内滚动位置永远存不住, 重开窗口只会回到章首
  window.addEventListener('scroll', onScroll, { passive: true });
  // 页面隐藏/关闭前补一次上报, 避免最后一次滚动丢失
  document.addEventListener('visibilitychange', onVisibilityChange);
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(function () { readerRef.value?.positionHandles(); }).observe(document.body);
  }
  applySettings(state.settings || DEFAULT_SETTINGS);
  // 通知扩展: webview 就绪(acquireVsCodeApi 全局只能调用一次, 复用 composables 里的实例)
  vscode.postMessage({ type: 'ready' });
});
</script>

<template>
  <div class="shell">
    <SideMenu />
    <div class="main">
      <CatalogPanel ref="catalogRef" />
      <SettingsPanel ref="settingsRef" />
      <ShelfPopup ref="shelfRef" />
      <StoragePopup ref="storageRef" />
      <ReaderArea ref="readerRef" />
      <StatusBar v-show="statusBarVisible()" />
    </div>
  </div>
</template>
