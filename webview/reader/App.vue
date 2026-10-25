<script setup lang="ts">
/**
 * App.vue — 根组件: 装配 + 协调
 * 布局: .shell = [ SideMenu(占位式, 展开把正文推右) | .main(正文/弹窗/状态栏) ]
 * 弹窗互斥: 任何时刻最多一个弹窗(目录/阅读设置/书架/存储)
 */
import { onMounted, nextTick, ref, watch } from 'vue';
import { send, state, vscode, gotoChapter, saveRestoreState, currentScrollRatio, currentBookKey, ownedBy, clearOpPending, type ChapterPayload, type DrawerTab, type NoteItem, type ShelfItemView, type OfflineStatusView, type ChapterMarksView, type DownloadTaskView, type OpResultPayload } from './composables/vscode';
import { applyThemeVars, DEFAULT_SETTINGS, flushProgress, persistSettings, sendProgress, setProgressSuppressed, setSuppressParaClick, type ReadingSettings } from './store';
import { resolveChapterIndex } from '../../src/noteAnchor';
import { parseShortcut, matchShortcut } from './composables/shortcut';
import CatalogPanel from './components/CatalogPanel.vue';
import SettingsPanel from './components/SettingsPanel.vue';
import ReaderArea from './components/ReaderArea.vue';
import StatusBar from './components/StatusBar.vue';
import SideMenu from './components/SideMenu.vue';
import ShelfPopup from './components/ShelfPopup.vue';
import HistoryPopup from './components/HistoryPopup.vue';
import StoragePopup from './components/StoragePopup.vue';
import NotesPopup from './components/NotesPopup.vue';
import NoteComposer from './components/NoteComposer.vue';
import SourcePopup from './components/SourcePopup.vue';
import ConfirmDialog from './components/ConfirmDialog.vue';
import { OVERLAY_SPECS, markOpen, focusInto, restoreFrom, handOff, type PopupKey } from './composables/overlay';
import { toggleNoteMode, resetCursorForChapter } from './composables/noteMode';
import { askConfirm, cancelConfirm, summarizeShelfPlan } from './composables/ops';
import './reader.css';

const catalogRef = ref<InstanceType<typeof CatalogPanel> | null>(null);
const settingsRef = ref<InstanceType<typeof SettingsPanel> | null>(null);
const shelfRef = ref<InstanceType<typeof ShelfPopup> | null>(null);
const historyRef = ref<InstanceType<typeof HistoryPopup> | null>(null);
const sourceRef = ref<InstanceType<typeof SourcePopup> | null>(null);
const storageRef = ref<InstanceType<typeof StoragePopup> | null>(null);
const notesRef = ref<InstanceType<typeof NotesPopup> | null>(null);
const readerRef = ref<InstanceType<typeof ReaderArea> | null>(null);
const confirmRef = ref<InstanceType<typeof ConfirmDialog> | null>(null);

/** popupKey -> 组件实例（`el` 与 `handleEscape` 由各组件 defineExpose） */
function overlayRef(key: PopupKey): { el?: HTMLElement | null; handleEscape?: () => boolean } | null {
  switch (key) {
    case 'catalogOpen': return catalogRef.value;
    case 'settingsOpen': return settingsRef.value;
    case 'shelfOpen': return shelfRef.value;
    case 'storageOpen': return storageRef.value;
    case 'notesOpen': return notesRef.value;
    case 'sourceOpen': return sourceRef.value;
    case 'historyOpen': return historyRef.value;
    default: return null;
  }
}

/** 当前打开的浮层 key（按固定的内外层顺序：内部下拉由各组件的 handleEscape 先消费） */
function openKeys(): PopupKey[] {
  return popupKeys.filter(function (k) { return !!state[k]; }) as PopupKey[];
}

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
const popupKeys = ['catalogOpen', 'settingsOpen', 'shelfOpen', 'storageOpen', 'notesOpen', 'sourceOpen', 'historyOpen'] as const;

/** 状态栏是否显示(设置项, 默认显示) */
function statusBarVisible(): boolean {
  return !state.settings || state.settings.showStatusBar !== false;
}

function anyPopupOpen(): boolean {
  return state.catalogOpen || state.settingsOpen || state.shelfOpen || state.storageOpen
    || state.notesOpen || state.sourceOpen || state.historyOpen;
}

/** 关闭全部弹窗(点击弹窗外任意处/按 Esc 时调用) */
function closeAllPopups(): void {
  state.catalogOpen = false;
  state.settingsOpen = false;
  state.shelfOpen = false;
  state.storageOpen = false;
  state.notesOpen = false;
  state.sourceOpen = false;
  state.historyOpen = false;
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
  else if (tab === 'source') { openOnly('sourceOpen'); }
  else { openOnly('shelfOpen'); }
}

// ---------------------------------------------------------------- 浮层焦点栈
// 打开/关闭散落在 SideMenu / openTab / closeAllPopups / 组件内赋值 / init 五处,
// 所以统一在 App 用 sync watch 观测 popupKeys 签名：
//   某 key 0->1            -> markOpen(同步读 activeElement) + nextTick focusInto
//   某 key 1->0 且无新开    -> nextTick restoreFrom
//   同一 tick 内既有开也有关 -> handOff（只聚焦新浮层, 不为旧浮层恢复焦点）
watch(function () {
  return popupKeys.map(function (k) { return state[k] ? '1' : '0'; }).join('');
}, function (sig, oldSig) {
  const opened: PopupKey[] = [];
  const closed: PopupKey[] = [];
  for (let i = 0; i < popupKeys.length; i++) {
    if (sig[i] === '1' && oldSig[i] === '0') { opened.push(popupKeys[i] as PopupKey); }
    if (sig[i] === '0' && oldSig[i] === '1') { closed.push(popupKeys[i] as PopupKey); }
  }
  for (const key of opened) { markOpen(OVERLAY_SPECS[key]); }
  if (opened.length > 0) {
    const to = opened[opened.length - 1];
    nextTick(function () {
      // 互斥切换: 只为新浮层聚焦一次, 不给旧浮层恢复焦点（否则焦点会抖）
      if (closed.length > 0) { handOff(closed, to); } else { focusInto(to); }
    });
    return;
  }
  if (closed.length > 0) {
    const from = closed[closed.length - 1];
    nextTick(function () { restoreFrom(from); });
  }
}, { flush: 'sync' });

// ---------------------------------------------------------------- 扩展消息
let previewTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 写一条下载任务表记录(按 filePath 键)。
 *
 * 任务表是**全局**视图: 只有"当前打开的书"才会同步到 offline/dlRun,
 * 别的书的进度只落在这里 —— 这正是修复"B 书显示 A 的下载进度"的关键。
 */
function upsertTask(filePath: string, patch: Partial<DownloadTaskView>): void {
  if (!filePath) { return; }
  const prev = state.downloadTasks[filePath];
  state.downloadTasks[filePath] = {
    filePath,
    bookTitle: patch.bookTitle || (prev ? prev.bookTitle : ''),
    done: typeof patch.done === 'number' ? patch.done : (prev ? prev.done : 0),
    total: typeof patch.total === 'number' ? patch.total : (prev ? prev.total : 0),
    failed: typeof patch.failed === 'number' ? patch.failed : (prev ? prev.failed : 0),
    running: typeof patch.running === 'boolean' ? patch.running : (prev ? prev.running : false),
    paused: typeof patch.paused === 'boolean' ? patch.paused : (prev ? prev.paused : false),
    updatedAt: Date.now(),
  };
}

/** 任务表全量快照(宿主下发): 以快照为准, 不保留快照里没有的运行中任务 */
function replaceTasks(tasks: DownloadTaskView[]): void {
  const next: Record<string, DownloadTaskView> = {};
  for (const t of tasks || []) {
    if (!t || !t.filePath) { continue; }
    next[t.filePath] = {
      filePath: t.filePath,
      bookTitle: t.bookTitle || t.filePath,
      done: t.done || 0,
      total: t.total || 0,
      failed: t.failed || 0,
      running: !!t.running,
      paused: !!t.paused,
      updatedAt: t.updatedAt || Date.now(),
    };
  }
  state.downloadTasks = next;
}

/** 归属 + 轮次校验后的章节回包是否可应用 */
function acceptChapter(msg: { filePath?: string; reqId?: number }, tag: string): boolean {
  if (!ownedBy(msg, tag)) { return false; }
  if (typeof msg.reqId === 'number') {
    // 回退的 reqId = 上一轮(或上一本书)的迟到回包
    if (msg.reqId < state.chapterReqSeq) {
      console.warn('[reader] 丢弃回退的章节回包', tag, msg.reqId, state.chapterReqSeq);
      return false;
    }
    state.chapterReqSeq = msg.reqId;
  }
  return true;
}

// ---------------------------------------------------------------- 搜索播报节流
// 读屏播报必须节流: 每完成一个源就播一次会把屏幕阅读器刷爆(R9-03)。
let announceDone = -1;
let announceAt = 0;

/** 更新 sr-only 播报文案(done 变化 && (≥800ms 或已到总数)) */
function announceSearchProgress(done: number, total: number): void {
  if (done === announceDone) { return; }
  const now = Date.now();
  const finished = total > 0 && done >= total;
  if (!finished && now - announceAt < 800) { return; }
  announceDone = done;
  announceAt = now;
  state.searchAnnounce = total > 0 ? '正在搜索书源（' + done + '/' + total + '）' : '正在搜索书源';
}

/** 新一轮搜索开始时重置播报节流状态 */
function resetSearchAnnounce(): void {
  announceDone = -1;
  announceAt = 0;
  state.searchAnnounce = '';
}

function clearPreviewPending(): void {
  if (previewTimer) { clearTimeout(previewTimer); previewTimer = null; }
  state.previewPending = null;
}

function startPreviewTimer(): void {
  if (previewTimer) { clearTimeout(previewTimer); previewTimer = null; }
  const pending = state.previewPending;
  if (!pending) { return; }
  previewTimer = setTimeout(function () {
    const current = state.previewPending;
    if (!current || current.at !== pending.at) { return; }
    const dismissed = current.dismissed;
    clearPreviewPending();
    state.previewBookUrl = '';
    state.onlineError = '预览解析超时(>45s)，请重试';
    state.sourceView = 'search';
    if (!dismissed) { state.sourceOpen = true; }
  }, 45000);
}

watch(function () { return state.previewPending; }, function (pending) {
  if (pending) { startPreviewTimer(); } else if (previewTimer) {
    clearTimeout(previewTimer);
    previewTimer = null;
  }
});

// 用户解析中手动关闭弹窗: 失败时不再强行重开
watch(function () { return state.sourceOpen; }, function (open, old) {
  if (old && !open && state.previewPending) { state.previewPending.dismissed = true; }
});

// 新一轮搜索: 重置播报节流、收起失败明细、清掉上一轮的单源重试状态
watch(function () { return state.searching; }, function (on) {
  if (!on) { return; }
  resetSearchAnnounce();
  state.searchErrorOpen = false;
  state.sourceRetries = {};
});

function handleExtensionMessage(msg: { type?: string; payload?: Record<string, unknown> }): void {
  if (!msg || !msg.type) { return; }
  switch (msg.type) {
    case 'init': {
      const p = msg.payload as Record<string, unknown>;
      state.chapterLoading = null;
      state.chapterError = null;
      // 协议协商: 宿主声明 protocolVersion>=2 才开严格归属校验(见 src/protocol.ts)
      state.ownershipStrict = ((p.protocolVersion as number) || 0) >= 2;
      // 换书/重开: 轮次归零, 旧书任何迟到的 reqId 都会因"归属不符"被丢弃
      state.chapterReqSeq = 0;
      // 任务表是全局视图, 不因换书清空
      if (Array.isArray(p.downloadTasks)) {
        replaceTasks(p.downloadTasks as DownloadTaskView[]);
      }
      state.novel = {
        filePath: (p.filePath as string) || '',
        totalChapters: p.totalChapters as number,
        totalWords: p.totalWords as number,
        bookTitle: p.bookTitle as string,
        author: p.author as string | undefined,
        online: p.online,
      };
      document.title = (p.bookTitle as string) + ' - 小说阅读';
      state.previewBookUrl = (p.online && (p.online as { bookUrl?: string }).bookUrl) || '';
      if (state.previewPending) {
        const initUrl = (p.online as { bookUrl?: string } | undefined)?.bookUrl;
        if (initUrl && initUrl === state.previewPending.bookUrl) {
          // init 先于 previewReady 到达: 同样视为成功
          clearPreviewPending();
          state.sourceOpen = false;
        } else {
          // 已经切到别的书(本地书/其他在线书), 放弃这次预览状态
          clearPreviewPending();
        }
      }
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
      state.sources = (p.sources as typeof state.sources) || [];
      // 离线下载状态: 随 init 首帧一次带下来, 避免目录面板再请求一次
      state.offline = (p.offline as OfflineStatusView | undefined) || null;
      state.dlRowOpen = false;
      state.dlRun = null;
      state.dlNotice = '';
      // 换书先清空目录标记, 等 chapterMarks 异步补上(避免短暂显示上一本的标记)
      state.marks = {
        cached: [],
        read: [],
        readUpTo: (p.chapterIndex as number) || 0,
      };
      state.catFilter = 'all';
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
    case 'chapter': {
      const p = msg.payload as unknown as ChapterPayload;
      if (!acceptChapter(p, 'chapter')) { break; }
      state.chapterLoading = null;
      state.chapterError = null;
      state.chapter = p;
      // 阅读进度: 推进「读到的最大章号」, 目录里靠它把已读章压灰
      if (state.chapter && state.chapter.index > state.marks.readUpTo) {
        state.marks.readUpTo = state.chapter.index;
      }
      break;
    }
    case 'settings':
      applySettings(msg.payload as unknown as ReadingSettings);
      break;
    case 'openSettings':
      openOnly('settingsOpen');
      break;
    case 'chapterLoading': {
      const p = msg.payload as { index: number; title?: string; filePath?: string; reqId?: number };
      if (!acceptChapter(p, 'chapterLoading')) { break; }
      state.chapterLoading = { index: p.index, title: p.title || '' };
      state.chapterError = null;
      break;
    }
    case 'chapterError': {
      const p = msg.payload as { index: number; message: string; filePath?: string; reqId?: number };
      if (!acceptChapter(p, 'chapterError')) { break; }
      state.chapterLoading = null;
      state.chapterError = { index: p.index, message: p.message || '加载失败' };
      break;
    }
    case 'previewReady': {
      const m = msg as { bookUrl?: string };
      if (state.previewPending && m.bookUrl && m.bookUrl === state.previewPending.bookUrl) {
        clearPreviewPending();
        state.onlineError = '';
        state.sourceOpen = false;
      } else if (!state.previewPending && m.bookUrl) {
        // 超时清理后迟到的成功回包: 书已打开, 同样收起弹窗
        state.previewBookUrl = m.bookUrl;
        state.sourceOpen = false;
      }
      break;
    }
    case 'previewSaved':
      state.previewAddPending = false;
      if (state.novel && state.novel.online) {
        state.novel = { ...state.novel, online: { ...state.novel.online, preview: false } };
      }
      break;
    // 加入失败: 扩展已弹错误通知, 这里只把按钮从「加入中…」恢复可点
    case 'previewAddFailed':
      state.previewAddPending = false;
      break;
    // 当前书被移出书架: 回到预览态, 正文「+ 加入书架」重新出现(previewSaved 的反向)
    case 'previewReset': {
      state.previewAddPending = false;
      const fp = (msg as { filePath?: string }).filePath;
      if (state.novel && state.novel.online && (!fp || state.novel.filePath === fp)) {
        state.novel = { ...state.novel, online: { ...state.novel.online, preview: true } };
      }
      break;
    }
    case 'onlineBookAdded': {
      const m = msg as { bookUrl?: string; ok?: boolean; message?: string };
      if (m.bookUrl) {
        const pending = state.onlineAddPending.indexOf(m.bookUrl);
        if (pending >= 0) { state.onlineAddPending.splice(pending, 1); }
      }
      if (m.ok && m.bookUrl) {
        if (state.onlineAdded.indexOf(m.bookUrl) < 0) { state.onlineAdded.push(m.bookUrl); }
        state.onlineError = '';
      } else {
        state.onlineError = m.message || '加入书架失败';
      }
      break;
    }
    case 'previewError': {
      const m = msg as { message?: string; bookUrl?: string };
      if (m.bookUrl && state.previewPending && m.bookUrl !== state.previewPending.bookUrl) { break; }
      const dismissed = !!(state.previewPending && state.previewPending.dismissed);
      clearPreviewPending();
      state.onlineError = m.message || '预览失败';
      state.previewBookUrl = '';
      if (!dismissed) {
        state.sourceView = 'search';
        state.sourceOpen = true;
      }
      break;
    }
    case 'history': {
      const p = msg.payload as { local?: unknown[]; online?: unknown[] } | undefined;
      state.history = {
        local: (p && Array.isArray(p.local) ? p.local : []) as typeof state.history.local,
        online: (p && Array.isArray(p.online) ? p.online : []) as typeof state.history.online,
      };
      break;
    }
    case 'shelf': {
      const items = (msg as { items?: ShelfItemView[] }).items || [];
      state.shelf = items;
      // 书架快照是真相源: 清掉已不在书架里的"本次会话已加入"标记,
      // 否则搜索结果里的「移出书架」执行后面板仍判定为已加入, 按钮不会复原
      const urls = new Set(items.map((i) => i.onlineBookUrl).filter((u): u is string => !!u));
      state.onlineAdded = state.onlineAdded.filter(
        (u) => urls.has(u) || state.onlineAddPending.indexOf(u) >= 0
      );
      break;
    }
    case 'library':
      state.libraryPath = ((msg as { path?: string }).path) || '';
      break;
    case 'slackerActive':
      state.slackerActive = !!(msg as { payload?: boolean }).payload;
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
    case 'sourceCheckProgress': {
      const m = msg as { scope?: string; done?: number; total?: number; sourceName?: string; paused?: boolean; runId?: number };
      const scope = m.scope === 'dead' ? 'dead' : m.scope === 'active' ? 'active' : null;
      if (!scope) { break; }
      const st = state.checkStates[scope];
      // 只认当前轮: 旧轮迟到的进度不能串到新轮
      if (m.runId !== undefined && st.runId !== m.runId) { break; }
      st.running = true;
      st.done = m.done || 0;
      st.total = m.total || 0;
      st.sourceName = m.sourceName || '';
      // 暂停状态以用户点击为准, 不被在途回包覆盖
      break;
    }
    case 'sourceCheckDone': {
      const m = msg as { scope?: string; runId?: number };
      const scope = m.scope === 'dead' ? 'dead' : m.scope === 'active' ? 'active' : null;
      if (!scope) { break; }
      const st = state.checkStates[scope];
      if (m.runId !== undefined && st.runId !== m.runId) { break; }
      st.running = false;
      st.paused = false;
      st.done = 0;
      st.total = 0;
      st.sourceName = '';
      break;
    }
    case 'searchBatch': {
      const m = msg as { token?: number; items?: typeof state.searchResults; errors?: typeof state.searchErrors };
      if (m.token !== undefined && m.token !== state.searchToken) { break; }
      const seenUrls = new Set(state.searchResults.map(function (i) { return i.bookUrl; }));
      for (const item of m.items || []) {
        if (seenUrls.has(item.bookUrl)) { continue; }
        seenUrls.add(item.bookUrl);
        state.searchResults.push(item);
      }
      const seenErr = new Set(state.searchErrors.map(function (e) { return e.sourceId; }));
      for (const e of m.errors || []) {
        if (seenErr.has(e.sourceId)) { continue; }
        seenErr.add(e.sourceId);
        state.searchErrors.push(e);
      }
      break;
    }
    case 'searchProgress': {
      const m = msg as { token?: number; done?: number; total?: number; sourceName?: string; ok?: boolean; failed?: number };
      if (m.token !== undefined && m.token !== state.searchToken) { break; }
      const done = m.done || 0;
      const total = m.total || 0;
      state.searchProgress = {
        done,
        total,
        sourceName: m.sourceName || '',
        ok: !!m.ok,
        failed: m.failed || 0,
      };
      // 播报节流(R9-03): 进度行本身 aria-live="off", 由这个 sr-only 区统一播报。
      // 每完成一个源就播一次会把读屏刷屏, 所以 800ms 或结束时才更新。
      announceSearchProgress(done, total);
      break;
    }
    case 'sources':
      state.sources = (msg as { items?: typeof state.sources }).items || [];
      break;
    case 'searchResults': {
      const m = msg as { token?: number; items?: typeof state.searchResults; errors?: typeof state.searchErrors; done?: boolean; skippedSources?: number; deadAdded?: string[] };
      // 只有最后一次搜索的结果才落地(用户连续搜索时丢弃过期回包)
      if (m.token !== undefined && m.token !== state.searchToken) { break; }
      state.searchResults = m.items || [];
      state.searchErrors = m.errors || [];
      state.searchSkipped = m.skippedSources || 0;
      state.searchDeadAdded = (m.deadAdded || []).length;
      state.searchProgress = null;
      state.searchPaused = false;
      state.searchCancelled = false;
      state.searchDone = !!m.done;
      state.searching = false;
      break;
    }
    case 'noteError': {
      if (state.noteComposer) {
        state.noteComposer.phase = 'composing';
        state.noteComposer.error = (msg as { message?: string }).message || '保存失败';
      }
      break;
    }
    // ---- 离线下载 / 缓存 ----
    case 'offlineStatus': {
      const next = (msg.payload as OfflineStatusView | undefined) || null;
      if (next && next.filePath && next.filePath !== currentBookKey()) {
        // 别的书的离线状态: 只落任务表, 不动当前面板(否则 B 书会显示 A 的进度)
        upsertTask(next.filePath, {
          done: next.done, total: next.total, failed: next.failed,
          running: next.running, paused: next.paused,
        });
        break;
      }
      // 下载进行中时宿主索引还没刷新(downloaded 可能是空的),
      // 同一本书就用本地已有的章号列表兜住, 避免圆点突然全灭
      state.offline = next && state.offline &&
        next.filePath === state.offline.filePath &&
        next.downloaded.length < state.offline.downloaded.length
        ? { ...next, downloaded: state.offline.downloaded }
        : next;
      if (next && next.filePath) {
        upsertTask(next.filePath, {
          done: next.done, total: next.total, failed: next.failed,
          running: next.running, paused: next.paused,
        });
      }
      break;
    }
    case 'offlineStats':
      state.offlineStats = (msg.payload as { bytes: number; books: number }) || { bytes: 0, books: 0 };
      break;
    case 'downloadProgress': {
      const p = msg.payload as unknown as {
        done: number; total: number; failed: number;
        running: boolean; paused: boolean;
        index?: number; title?: string; added?: number[];
        filePath?: string; bookTitle?: string;
      };
      const fp = p.filePath || currentBookKey();
      // 任务表: 无论是不是当前书都更新(R9-06 切走面板仍可查)
      upsertTask(fp, {
        done: p.done, total: p.total, failed: p.failed,
        running: p.running, paused: p.paused, bookTitle: p.bookTitle,
      });
      if (fp !== currentBookKey()) { break; }   // 别的书: 只更新任务表
      // 本轮进度单独放 dlRun: offline.total 是全书章数, 二者不能混用
      // (区间下载时范围大小 != 全书章数)
      state.dlRun = { done: p.done, total: p.total, failed: p.failed, running: p.running, paused: p.paused };
      const base: OfflineStatusView = state.offline || {
        filePath: state.novel?.filePath || '',
        total: state.chapters.length,
        done: 0, failed: 0,
        running: false, paused: false,
        downloaded: [], bytes: 0,
        totalBytes: state.offlineStats.bytes,
        bookCount: state.offlineStats.books,
      };
      // 只合并新增章号(扩展侧不会每帧重发全量 downloaded, 5000 章会拖慢渲染)
      const added = p.added || [];
      const downloaded = added.length
        ? base.downloaded.concat(added)
            .filter(function (v, i, arr) { return arr.indexOf(v) === i; })
            .sort(function (a, b) { return a - b; })
        : base.downloaded;
      state.offline = {
        ...base,
        running: p.running,
        paused: p.paused,
        downloaded,
      };
      break;
    }
    case 'downloadDone': {
      const p = msg.payload as {
        ok?: boolean; cancelled?: boolean; done?: number; total?: number; failed?: number;
        message?: string; filePath?: string;
      };
      const fp = p.filePath || currentBookKey();
      upsertTask(fp, { done: p.done, total: p.total, failed: p.failed, running: false, paused: false });
      if (fp !== currentBookKey()) { break; }   // 别的书结束: 只更新任务表
      if (state.offline) {
        state.offline = { ...state.offline, running: false, paused: false };
      }
      if (state.dlRun) { state.dlRun = { ...state.dlRun, running: false, paused: false }; }
      state.dlNotice = p.cancelled
        ? '已取消下载'
        : p.failed
          ? '下载结束，' + p.failed + ' 章失败（再次下载会自动重试）'
          : p.message || '下载完成';
      break;
    }
    case 'offlineExported': {
      const p = msg.payload as { ok?: boolean; message?: string; chapters?: number; missing?: number; filePath?: string };
      const name = p.filePath ? String(p.filePath).split(/[\\/]/).pop() : '';
      state.dlNotice = p.ok
        ? '已保存' + (name ? '：' + name : '') +
          (p.chapters ? '（' + p.chapters + ' 章）' : '') +
          (p.missing ? ' · ' + p.missing + ' 章未下载' : '')
        : p.message || '导出失败';
      break;
    }
    // 目录每章标记: 已缓存(临时) / 已读
    case 'chapterMarks': {
      if (!ownedBy(msg as { filePath?: string }, 'chapterMarks')) { break; }
      const p = (msg.payload as ChapterMarksView | undefined) || { cached: [], read: [], readUpTo: -1 };
      state.marks = {
        cached: p.cached || [],
        read: p.read || [],
        // 本地已推进得更多时不要回退(读盘快照可能比当前阅读落后)
        readUpTo: Math.max(p.readUpTo, state.marks.readUpTo),
      };
      break;
    }
    // 刚读完的章已落进临时缓存 → 目录立即点亮
    case 'chapterCached': {
      const p = msg.payload as { index?: number; filePath?: string; reqId?: number } | undefined;
      if (!ownedBy(p || {}, 'chapterCached')) { break; }
      const index = p && typeof p.index === 'number' ? p.index : -1;
      if (index >= 0 && state.marks.cached.indexOf(index) < 0) {
        state.marks = { ...state.marks, cached: state.marks.cached.concat([index]).sort(function (a, b) { return a - b; }) };
      }
      break;
    }
    // 刷新书架: 预演计划到达 -> 弹确认框（用户取消则什么都不写）
    case 'shelfRefreshPlan': {
      const plan = msg.payload as typeof state.shelfPlan;
      if (!plan) { break; }
      state.shelfPlan = plan;
      askConfirm({
        title: '刷新书架',
        lines: summarizeShelfPlan(plan),
        danger: false,
        confirmText: '执行刷新',
        op: 'shelf:refresh',
        payload: { planId: plan.planId },
      });
      break;
    }
    // 刷新书架: 执行结果 -> 就地提示计数（不弹系统模态），差异说明追加一句
    case 'shelfRefreshResult': {
      const r = msg.payload as {
        added?: number; skippedDup?: number; merged?: number;
        retitled?: number; pruned?: number; driftNote?: string;
      } | undefined;
      if (!r) { break; }
      state.shelfNotice =
        '已刷新：新增 ' + (r.added || 0) + ' / 跳过 ' + (r.skippedDup || 0) +
        ' / 合并 ' + (r.merged || 0) + ' / 修正 ' + (r.retitled || 0) +
        ' / 清理 ' + (r.pruned || 0) + (r.driftNote ? '（' + r.driftNote + '）' : '');
      break;
    }
    // 下载任务表全量快照
    case 'downloadTasks': {
      const p = msg.payload as { tasks?: DownloadTaskView[] } | undefined;
      replaceTasks((p && p.tasks) || []);
      break;
    }
    // 写操作终态: opId 匹配才收敛 UI(清 pending / 关确认框 / 退出管理态)
    case 'opResult': {
      const r = msg.payload as OpResultPayload | undefined;
      if (!r || !r.opId) { break; }
      clearOpPending(r.opId);
      // 只有成功才关闭确认框。失败时**保留**它 —— 框内的 role=alert 会显示原因，
      // 用户可以重试或取消；否则用户会以为"点了没反应"(R7-03/R9-05)。
      if (r.ok && state.confirm && state.confirm.opId === r.opId) {
        state.confirm = null;
      }
      // 各面板(书架/历史/笔记/存储)watch 这个广播来决定"退出管理态"还是"保留选择"
      state.lastOp = { opId: r.opId, op: r.op, ok: !!r.ok, message: r.message || '', at: Date.now() };
      state.opError = r.ok ? '' : (r.message || '操作失败');
      break;
    }
    // 单源重试结果: 成功则把该源移出失败列表并合并命中
    case 'sourceRetryResult': {
      const p = msg.payload as {
        reqId?: number; sourceId?: string; sourceName?: string;
        ok?: boolean; message?: string; items?: typeof state.searchResults;
      } | undefined;
      if (!p || !p.sourceId) { break; }
      state.sourceRetries[p.sourceId] = { running: false, ok: !!p.ok, message: p.message };
      if (p.ok) {
        state.searchErrors = state.searchErrors.filter(function (e) { return e.sourceId !== p.sourceId; });
        const seen = new Set(state.searchResults.map(function (i) { return i.bookUrl; }));
        for (const item of p.items || []) {
          if (seen.has(item.bookUrl)) { continue; }
          seen.add(item.bookUrl);
          state.searchResults.push(item);
        }
      } else if (p.message) {
        // 保留连续失败计数策略不变, 只更新就地原因
        state.searchErrors = state.searchErrors.map(function (e) {
          return e.sourceId === p.sourceId ? { ...e, message: p.message as string } : e;
        });
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
  // 换章后段落数变了: 笔记模式的 roving 游标必须重置, 否则会指到不存在的段落
  resetCursorForChapter();
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
    flushProgress();
    send({ type: 'openBook', filePath: note.bookPath });
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
  // 确认框是"浮层内的确认层": 层内点击交给按钮自己处理, 不能继续走到 closeAllPopups。
  // 否则 mousedown 早于 click, 用户按下「删除」的瞬间就会先关掉发起操作的浮窗。
  if (state.confirm) {
    if (el.closest && el.closest('.confirm-dlg')) { return; }
    // 点遮罩只取消确认框; 执行中不允许取消。两种情况都必须 return, 保留原浮层。
    if (!state.pendingOps[state.confirm.opId]) { state.confirm = null; }
    return;
  }
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
    (sourceRef.value?.el && sourceRef.value.el.contains(target)) ||
    (historyRef.value?.el && historyRef.value.el.contains(target)) ||
    (el.closest ? !!el.closest('.menu') : false);
  if (!inside) { closeAllPopups(); }
}

/**
 * Esc 分层（PRD R5-05）：从最内层往外逐层消费。
 *
 * 顺序: 确认层 → 笔记卡片 → 各浮层的内部层（下拉/行内编辑/删除确认）→ 浮层本身 → 侧栏。
 * 每一层都要求"确实消费了才 preventDefault"，否则 Esc 会同时关掉两层。
 *
 * 注: 这里**不再** `blurActiveElement()`。焦点残留问题已由 `:focus-visible` 规则解决，
 * 而主动 blur 会让键盘用户在关掉浮层后直接掉到 body 上（R5-04 明确禁止）。
 */
function onKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    if (state.confirm) {
      e.preventDefault();
      cancelConfirm();
      return;
    }
    if (state.noteComposer) {
      e.preventDefault();
      state.noteComposer = null;
      return;
    }
    // 内部下拉 / 行内编辑 / 两步删除确认: 由各浮层自己决定是否吃掉这一层
    for (const key of openKeys()) {
      const ref = overlayRef(key);
      if (ref && typeof ref.handleEscape === 'function' && ref.handleEscape()) {
        e.preventDefault();
        return;
      }
    }
    if (anyPopupOpen()) {
      e.preventDefault();
      closeAllPopups();
      return;
    }
    if (state.menuExpanded) {
      e.preventDefault();
      state.menuExpanded = false;
      return;
    }
  }
  const tag = e.target && (e.target as HTMLElement).tagName
    ? String((e.target as HTMLElement).tagName).toLowerCase() : '';
  if (tag === 'input' || tag === 'select' || tag === 'textarea') { return; }
  // Alt+N: 切换笔记本模式（与 alt+←/→ 翻章、ctrl+alt+* 摸鱼均不冲突）
  if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'n' || e.key === 'N')) {
    e.preventDefault();
    toggleNoteMode();
    return;
  }
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

// Ctrl(或 Cmd) + 滚轮: 放大 / 缩小字号
function onWheel(e: WheelEvent): void {
  if (!e.ctrlKey && !e.metaKey) { return; }
  e.preventDefault();
  const cur = (state.settings ? state.settings.fontSize : 0) || DEFAULT_SETTINGS.fontSize;
  const next = Math.min(32, Math.max(12, cur + (e.deltaY < 0 ? 1 : -1)));
  if (next !== cur) { persistSettings({ fontSize: next }); }
}

// 弹窗/浮层根节点: 命中即认为滚轮发生在浮层内
const OVERLAY_SEL = '.popup, #catalogPanel, #settingsPanel, .note-preview, .note-composer';

/** 该元素在当前滚动方向上是否还能滚 */
function canScrollY(el: HTMLElement, deltaY: number): boolean {
  if (el.scrollHeight <= el.clientHeight + 1) { return false; }
  const top = el.scrollTop;
  return deltaY < 0 ? top > 0 : top + el.clientHeight < el.scrollHeight - 1;
}

/**
 * 阻止滚动穿透: 在浮层内从目标向上找, 任意一层还能滚就放行;
 * 到浮层根都没人能接住, 才吞掉滚轮(正文不再跟着滚)。
 * 这样列表与外层面板两层滚动都能正常接力。
 */
function onWheelGuard(e: WheelEvent): void {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey) { return; } // Ctrl+滚轮交给字号缩放
  if (Math.abs(e.deltaY) < 1) { return; }                       // 横向/惯性尾帧
  const target = e.target as HTMLElement | null;
  const overlay = target && target.closest ? target.closest(OVERLAY_SEL) : null;
  if (!target || !overlay) { return; }                          // 正文区域不干预
  for (let el: HTMLElement | null = target; el; el = el.parentElement) {
    if (canScrollY(el, e.deltaY)) { return; }
    if (el === overlay) { break; }                              // 只在浮层内部找, 不到 body/html
  }
  e.preventDefault();
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
  document.addEventListener('wheel', onWheelGuard, { passive: false, capture: true });
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
      <HistoryPopup ref="historyRef" />
      <StoragePopup ref="storageRef" />
      <NotesPopup ref="notesRef" @jump="jumpToNote" />
      <SourcePopup ref="sourceRef" />
      <NoteComposer />
      <ConfirmDialog ref="confirmRef" />
      <ReaderArea ref="readerRef" />
      <StatusBar v-show="statusBarVisible()" />
      <!-- 搜索进度播报: 可见进度区 aria-live=off, 由这个 sr-only 区统一播报(节流) -->
      <span class="sr-only" role="status" aria-live="polite" aria-atomic="true">{{ state.searchAnnounce }}</span>
      <div v-if="state.noteReturn" class="note-return">
        <button class="nr-main" @click="backToReadingPos">↩ 返回上次阅读位置 · {{ state.noteReturn.chapterTitle }}</button>
        <button class="nr-close" @click="dismissNoteReturn">关闭</button>
      </div>
    </div>
  </div>
</template>
