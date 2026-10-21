<script setup lang="ts">
/**
 * App.vue — 根组件: 装配 + 协调
 * 布局: .shell = [ SideMenu(占位式, 展开把正文推右) | .main(正文/弹窗/状态栏) ]
 * 弹窗互斥: 任何时刻最多一个弹窗(目录/阅读设置/书架/存储)
 */
import { onMounted, nextTick, ref, watch } from 'vue';
import { state, vscode, gotoChapter, saveRestoreState, currentScrollRatio, type ChapterPayload, type DrawerTab, type NoteItem, type ShelfItemView } from './composables/vscode';
import { applyThemeVars, DEFAULT_SETTINGS, persistSettings, sendProgress, setProgressSuppressed, setSuppressParaClick, type ReadingSettings } from './store';
import { resolveChapterIndex } from '../../src/noteAnchor';
import { parseShortcut, matchShortcut } from './composables/shortcut';
import CatalogPanel from './components/CatalogPanel.vue';
import SettingsPanel from './components/SettingsPanel.vue';
import ReaderArea from './components/ReaderArea.vue';
import StatusBar from './components/StatusBar.vue';
import SideMenu from './components/SideMenu.vue';
import ShelfPopup from './components/ShelfPopup.vue';
import StoragePopup from './components/StoragePopup.vue';
import NotesPopup from './components/NotesPopup.vue';
import NoteComposer from './components/NoteComposer.vue';
import './reader.css';

const catalogRef = ref<InstanceType<typeof CatalogPanel> | null>(null);
const settingsRef = ref<InstanceType<typeof SettingsPanel> | null>(null);
const shelfRef = ref<InstanceType<typeof ShelfPopup> | null>(null);
const storageRef = ref<InstanceType<typeof StoragePopup> | null>(null);
const notesRef = ref<InstanceType<typeof NotesPopup> | null>(null);
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
const popupKeys = ['catalogOpen', 'settingsOpen', 'shelfOpen', 'storageOpen', 'notesOpen'] as const;

/** 状态栏是否显示(设置项, 默认显示) */
function statusBarVisible(): boolean {
  return !state.settings || state.settings.showStatusBar !== false;
}

function anyPopupOpen(): boolean {
  return state.catalogOpen || state.settingsOpen || state.shelfOpen || state.storageOpen || state.notesOpen;
}

/** 关闭全部弹窗(点击弹窗外任意处/按 Esc 时调用) */
function closeAllPopups(): void {
  state.catalogOpen = false;
  state.settingsOpen = false;
  state.shelfOpen = false;
  state.storageOpen = false;
  state.notesOpen = false;
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
  else if (tab === 'notes') { openOnly('notesOpen'); }
  else { openOnly('shelfOpen'); }
}

// ---------------------------------------------------------------- 扩展消息
function handleExtensionMessage(msg: { type?: string; payload?: Record<string, unknown> }): void {
  if (!msg || !msg.type) { return; }
  switch (msg.type) {
    case 'init': {
      const p = msg.payload as Record<string, unknown>;
      state.novel = {
        filePath: (p.filePath as string) || '',
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
      state.notes = (p.notes as NoteItem[]) || [];
      // 换书/重开: 笔记相关的临时态一律清空
      state.noteComposer = null;
      state.noteReturn = null;
      state.noteJump = null;
      // 折叠态是"用户显式选择", 换书/重发 init 都不清空(新书默认展开靠 current 推导)
      // 跨书笔记跳转: 目标书 init 落地后按笔记章节定位
      const pending = state.pendingNoteJump;
      if (pending && pending.bookPath === state.novel.filePath) {
        state.pendingNoteJump = null;
        state.noteJump = {
          id: pending.id,
          chapterTitle: pending.chapterTitle,
          chapterIndex: pending.chapterIndex,
          paragraphIndex: pending.paragraphIndex,
          quote: pending.quote,
        };
        gotoChapter(resolveChapterIndex(state.chapters, pending), 'jump');
      } else if (pending) {
        // 打开的书不是目标书(打开失败或用户手动换了书): 丢弃过期的待跳转
        state.pendingNoteJump = null;
      }
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
    case 'notes':
      state.notes = (msg as { items?: NoteItem[] }).items || [];
      break;
    case 'noteUpserted': {
      const item = (msg as { item?: NoteItem }).item;
      if (!item) { break; }
      const i = state.notes.findIndex(function (n) { return n.id === item.id; });
      if (i >= 0) { state.notes.splice(i, 1, item); } else { state.notes.push(item); }
      // 新建卡片: 保存成功才关闭(失败保留草稿)
      if (state.noteComposer && state.noteComposer.phase === 'saving') { state.noteComposer = null; }
      break;
    }
    case 'noteRemoved': {
      const id = (msg as { id?: string }).id;
      state.notes = state.notes.filter(function (n) { return n.id !== id; });
      break;
    }
    case 'noteError': {
      if (state.noteComposer) {
        state.noteComposer.phase = 'composing';
        state.noteComposer.error = (msg as { message?: string }).message || '保存失败';
      }
      break;
    }
  }
}

/**
 * 章节变化: 定位滚动位置 + 对齐手柄 + 立即上报进度
 *
 * 时序要点: nextTick 只保证 DOM 已更新, **不保证布局已完成** ——
 * 此刻 scrollHeight 可能还是上一章的高度, 导致 scrollTo 落点算错
 * (切章后停在"和上一章差不多的位置")。必须再等一帧让布局落定。
 */
watch(function () { return state.chapter; }, function (ch) {
  if (!ch) { return; }
  // 笔记跳转: 章节到位后按段落定位, 不按比例滚动, 也不回写进度
  if (state.noteJump) {
    const target = state.noteJump;
    state.noteJump = null;
    nextTick(function () {
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          readerRef.value?.scrollToParagraph({
            paragraphIndex: target.paragraphIndex,
            quote: target.quote,
          });
          setProgressSuppressed(true, 600);
          readerRef.value?.positionHandles();
        });
      });
    });
    return;
  }
  // 用户自己导航(上一章/下一章/目录): 之前记下的"返回阅读位置"已失效
  state.noteReturn = null;
  const ratio = ch.scrollRatio || 0;
  nextTick(function () {
    requestAnimationFrame(function () {
      const max = Math.max(0, document.body.scrollHeight - window.innerHeight);
      window.scrollTo(0, max > 0 ? ratio * max : 0);
      // 恢复落位期间不上报: 此刻若上报会把"旧位置"当成新章位置写进记录(位置错乱)
      setProgressSuppressed(true, 600);
      // 手柄位置按最终滚动结果对齐
      requestAnimationFrame(function () { readerRef.value?.positionHandles(); });
    });
  });
});

// ---------------------------------------------------------------- 全局事件

/** 滚动上报(节流 600ms, 内部已有debounce); 只在已载入章节时上报 */
function onScroll(): void {
  if (!state.chapter) { return; }
  // 笔记卡片锚定段落, 滚动后位置失效 -> 自动关闭
  if (state.noteComposer) { state.noteComposer = null; }
  sendProgress(false);
}

/** 页面转入后台/关闭前立即上报一次, 防止最后一段滚动位置丢失 */
function onVisibilityChange(): void {
  if (document.visibilityState === 'hidden') {
    sendProgress(true);
  }
}

// ---------------------------------------------------------------- 笔记跳转 / 返回上次位置
/** 从笔记跳回原文: 同书直接定位; 跨书先换书, init 落地后再定位 */
function jumpToNote(note: NoteItem): void {
  if (!note) { return; }
  const currentPath = (state.novel && state.novel.filePath) || '';
  if (note.bookPath !== currentPath) {
    // 跨书跳转: 先换书(openBook 复用当前面板并重发 init), 原返回点属于上一本书, 丢弃
    state.noteReturn = null;
    state.noteComposer = null;
    state.pendingNoteJump = note;
    state.notesOpen = false;
    vscode.postMessage({ type: 'openBook', filePath: note.bookPath });
    return;
  }
  const cur = state.chapter;
  if (!cur) { return; }

  state.noteReturn = {
    chapterIndex: cur.index,
    scrollRatio: currentScrollRatio(),
    chapterTitle: cur.title,
  };
  state.noteComposer = null;
  state.notesOpen = false;

  const target = resolveChapterIndex(state.chapters, note);
  if (target === cur.index) {
    nextTick(function () {
      requestAnimationFrame(function () {
        readerRef.value?.scrollToParagraph({
          paragraphIndex: note.paragraphIndex,
          quote: note.quote,
        });
        setProgressSuppressed(true, 600);
      });
    });
    return;
  }
  state.noteJump = {
    id: note.id,
    chapterTitle: note.chapterTitle,
    chapterIndex: note.chapterIndex,
    paragraphIndex: note.paragraphIndex,
    quote: note.quote,
  };
  gotoChapter(target, 'jump');
}

/** 返回跳转前的阅读位置(同章滚回原比例; 跨章走精确恢复) */
function backToReadingPos(): void {
  const pos = state.noteReturn;
  if (!pos) { return; }
  const cur = state.chapter;
  state.noteReturn = null;
  if (cur && cur.index === pos.chapterIndex) {
    const max = Math.max(0, document.body.scrollHeight - window.innerHeight);
    window.scrollTo(0, Math.max(0, pos.scrollRatio * max));
    setProgressSuppressed(true, 600);
    return;
  }
  gotoChapter(pos.chapterIndex, 'jump', pos.scrollRatio);
}

/** 关闭返回提示条(× 按钮): 结束本次返回交互 */
function dismissNoteReturn(): void {
  state.noteReturn = null;
}

function onDocMouseDown(e: MouseEvent): void {
  const target = e.target as Node;
  const el = e.target as HTMLElement;
  // 新建笔记卡片: 点卡片外任意处即关闭。
  // 关闭后吞掉紧随的一次段落 click —— 本次点击只"关而不选", 再点一次才选中新段落
  if (state.noteComposer && !(el.closest && el.closest('.note-composer'))) {
    state.noteComposer = null;
    setSuppressParaClick(true);
  }
  if (!anyPopupOpen()) { return; }
  const inside =
    (catalogRef.value?.el && catalogRef.value.el.contains(target)) ||
    (settingsRef.value?.el && settingsRef.value.el.contains(target)) ||
    (shelfRef.value?.el && shelfRef.value.el.contains(target)) ||
    (storageRef.value?.el && storageRef.value.el.contains(target)) ||
    (notesRef.value?.el && notesRef.value.el.contains(target)) ||
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
    // 优先级: 新建笔记卡片 → 弹窗 → 菜单
    if (state.noteComposer) {
      e.preventDefault();
      state.noteComposer = null;
      blurActiveElement();
      return;
    }
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
  // 任何 click 冒泡到 document 都清掉"吞点击"标志(段落 click handler 先于它执行)
  document.addEventListener('click', function () { setSuppressParaClick(false); });
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
      <NotesPopup ref="notesRef" @jump="jumpToNote" />
      <NoteComposer />
      <ReaderArea ref="readerRef" />
      <StatusBar v-show="statusBarVisible()" />
      <div v-if="state.noteReturn" class="note-return">
        <button class="nr-main" @click="backToReadingPos">↩ 返回上次阅读位置 · {{ state.noteReturn.chapterTitle }}</button>
        <button class="nr-close" @click="dismissNoteReturn">关闭</button>
      </div>
    </div>
  </div>
</template>
