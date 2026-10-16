<script setup lang="ts">
/**
 * App.vue — 根组件: 只做"装配 + 协调"
 *  - 各区块拆分在 components/ 下(Catalog/Settings/Reader/Fab/Status)
 *  - 跨组件协调: 扩展消息 / 全局快捷键 / 设置面板定位 / 尺寸变化重排
 */
import { onMounted, nextTick, ref, watch } from 'vue';
import { state, vscode, gotoChapter, type ChapterPayload, type DrawerTab, type ShelfItemView } from './composables/vscode';
import { applyThemeVars, DEFAULT_SETTINGS, persistSettings, sendProgress, type ReadingSettings } from './store';
import { parseShortcut, matchShortcut } from './composables/shortcut';
import CatalogPanel from './components/CatalogPanel.vue';
import SettingsPanel from './components/SettingsPanel.vue';
import ReaderArea from './components/ReaderArea.vue';
import FabToolbar from './components/FabToolbar.vue';
import StatusBar from './components/StatusBar.vue';
import DrawerPanel from './components/DrawerPanel.vue';
import './reader.css';

const catalogRef = ref<InstanceType<typeof CatalogPanel> | null>(null);
const settingsRef = ref<InstanceType<typeof SettingsPanel> | null>(null);
const readerRef = ref<InstanceType<typeof ReaderArea> | null>(null);
const fabRef = ref<InstanceType<typeof FabToolbar> | null>(null);

// ---------------------------------------------------------------- 设置应用
function applySettings(s: ReadingSettings): void {
  state.settings = s;
  applyThemeVars(s);
  state.prevCombo = parseShortcut(s.shortcutPrev);
  state.nextCombo = parseShortcut(s.shortcutNext);
  const fabDragged =
    typeof s.fabLeft === 'number' && s.fabLeft >= 0 &&
    typeof s.fabTop === 'number' && s.fabTop >= 0;
  nextTick(function () {
    if (fabDragged) {
      fabRef.value?.applyFabPosition({ left: s.fabLeft as number, top: s.fabTop as number });
    } else {
      fabRef.value?.syncFabAnchor();
    }
    readerRef.value?.positionHandles();
  });
}

// ---------------------------------------------------------------- 设置面板定位(贴合悬浮球, 夹回视口)
function positionSettingsPanel(): void {
  const panel = settingsRef.value?.el;
  const fabEl = fabRef.value?.el;
  if (!panel) { return; }
  const margin = 12;
  const gap = 10;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const maxH = Math.max(200, vh - margin * 2);
  panel.style.maxHeight = maxH + 'px';
  const pw = panel.offsetWidth || 520;
  const ph = Math.min(panel.offsetHeight || 420, maxH);
  const anchor = fabEl ? fabEl.getBoundingClientRect() : null;
  const hasAnchor = !!(anchor && (anchor.width || anchor.height));
  let left: number;
  let top: number;
  if (hasAnchor && anchor) {
    left = anchor.left + anchor.width / 2 > vw / 2 ? anchor.left - gap - pw : anchor.right + gap;
    top = anchor.top;
  } else {
    left = (vw - pw) / 2;
    top = margin;
  }
  if (left + pw > vw - margin) { left = vw - margin - pw; }
  if (left < margin) { left = margin; }
  if (!isFinite(left)) { left = margin; }
  if (top + ph > vh - margin) { top = vh - margin - ph; }
  if (top < margin) { top = margin; }
  if (!isFinite(top)) { top = margin; }
  panel.style.left = Math.round(left) + 'px';
  panel.style.top = Math.round(top) + 'px';
}

// 面板打开时机统一在这里定位(悬浮球切换/消息打开都走 state.settingsOpen)
watch(function () { return state.settingsOpen; }, function (open) {
  // 同一时刻只显示一个浮层: 设置面板 / 目录浮层 / 左抽屉
  if (open && state.catalogOpen) { state.catalogOpen = false; }
  if (open && state.drawerOpen) { state.drawerOpen = false; }
  if (open) { nextTick(positionSettingsPanel); }
});

// 打开目录浮层时同理关掉其它两个
watch(function () { return state.catalogOpen; }, function (open) {
  if (open && state.settingsOpen) { state.settingsOpen = false; }
  if (open && state.drawerOpen) { state.drawerOpen = false; }
});

// 展开左抽屉时收起两个浮层
watch(function () { return state.drawerOpen; }, function (open) {
  if (open && state.catalogOpen) { state.catalogOpen = false; }
  if (open && state.settingsOpen) { state.settingsOpen = false; }
});

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
      state.chapter = {
        index: p.chapterIndex as number,
        title: p.chapterTitle as string,
        paragraphs: (p.paragraphs as string[]) || [],
        totalChapters: p.totalChapters as number,
        chapterWords: (p.chapterWords as number) || 0,
        scrollRatio: (p.scrollRatio as number) || 0,
      };
      if (p.openSettings) { state.settingsOpen = true; }
      // 初始书架/书库数据(抽屉)
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
      state.settingsOpen = true;
      break;
    // 抽屉数据/打开请求
    case 'shelf':
      state.shelf = (msg as { items?: ShelfItemView[] }).items || [];
      break;
    case 'library':
      state.libraryPath = ((msg as { path?: string }).path) || '';
      break;
    case 'openDrawer':
      state.drawerTab = (((msg as { tab?: DrawerTab }).tab) || 'shelf');
      state.drawerOpen = true;
      break;
  }
}

// ---------------------------------------------------------------- 全局事件
function onDocMouseDown(e: MouseEvent): void {
  // 点击面板外部关闭(用 mousedown: 拖动滑块时鼠标可能在面板外松开, 不应误关)
  const settingsEl = settingsRef.value?.el;
  const fabEl = fabRef.value?.el;
  const catalogEl = catalogRef.value?.el;
  const inSettings = settingsEl && settingsEl.contains(e.target as Node);
  const inFabs = fabEl && fabEl.contains(e.target as Node);
  if (state.settingsOpen && !inSettings && !inFabs) { state.settingsOpen = false; }
  if (state.catalogOpen && catalogEl && !catalogEl.contains(e.target as Node) && !inFabs) {
    state.catalogOpen = false;
  }
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    if (state.catalogOpen) { e.preventDefault(); state.catalogOpen = false; return; }
    if (state.settingsOpen) { e.preventDefault(); state.settingsOpen = false; return; }
  }
  const tag = e.target && (e.target as HTMLElement).tagName
    ? String((e.target as HTMLElement).tagName).toLowerCase() : '';
  if (tag === 'input' || tag === 'select' || tag === 'textarea') { return; }
  if (matchShortcut(state.prevCombo, e)) {
    e.preventDefault();
    if (state.chapter) { gotoChapter(state.chapter.index - 1); }
    return;
  }
  if (matchShortcut(state.nextCombo, e)) {
    e.preventDefault();
    if (state.chapter) { gotoChapter(state.chapter.index + 1); }
  }
}

// Ctrl(或 Cmd) + 滚轮: 放大 / 缩小字号(capture 尽早拦截, 阻止页面缩放)
function onWheel(e: WheelEvent): void {
  if (!e.ctrlKey && !e.metaKey) { return; }
  e.preventDefault();
  const cur = (state.settings ? state.settings.fontSize : 0) || DEFAULT_SETTINGS.fontSize;
  const next = Math.min(32, Math.max(12, cur + (e.deltaY < 0 ? 1 : -1)));
  if (next !== cur) { persistSettings({ fontSize: next }); }
}

// 尺寸变化(窗口缩放、侧边栏展开/收起)后重排悬浮球/面板/手柄
function syncFabOnResize(): void {
  if (state.settingsOpen) { positionSettingsPanel(); }
  const fab = fabRef.value;
  if (!fab) { return; }
  if (!fab.isFabDragged()) {
    fab.syncFabAnchor();
    return;
  }
  const el = fab.el;
  const left = parseFloat(el.style.left);
  const top = parseFloat(el.style.top);
  if (isNaN(left) || isNaN(top)) { return; }
  const mid = left + (el.offsetWidth || 58) / 2;
  const side: 'left' | 'right' = mid < window.innerWidth / 2 ? 'left' : 'right';
  const pos = fab.snapFabPosition(side, top);
  fab.applyFabPosition(pos);
  persistSettings({ fabLeft: pos.left, fabTop: pos.top });
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
    syncFabOnResize();
    readerRef.value?.positionHandles();
  });
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(function () {
      syncFabOnResize();
      readerRef.value?.positionHandles();
    }).observe(document.body);
  }
  applySettings(state.settings || DEFAULT_SETTINGS);
  // 通知扩展: webview 就绪(扩展会回推 init)
  // 注意: acquireVsCodeApi 全局只能调用一次, 必须复用 composables/vscode 里已获取的实例
  vscode.postMessage({ type: 'ready' });
});
</script>

<template>
  <DrawerPanel />
  <CatalogPanel ref="catalogRef" />
  <SettingsPanel ref="settingsRef" />
  <ReaderArea ref="readerRef" />
  <FabToolbar ref="fabRef" />
  <StatusBar />
</template>
