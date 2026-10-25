<script setup lang="ts">
/**
 * NotesPopup.vue — 阅读笔记浮层
 *
 * 结构: 头部(条数) → 书分组(可折叠) → 章分组(可折叠) → 条目(正文/原文/时间)
 * 交互: 点条目或「定位到原文」跳回原文; 悬浮笔记正文 → 右侧浮窗看完整笔记+原文; 行内编辑; 两步确认删除
 */
import { computed, nextTick, ref, watch } from 'vue';
import { state, send, markOpPending, newOpId, opRunning, type NoteItem } from '../composables/vscode';
import { askConfirm } from '../composables/ops';
import {
  groupNotes, isChapterOpen, isGroupOpen, relativeTime,
  toggleChapterOpen, toggleGroupOpen,
  type NoteBookGroup, type NoteChapterGroup,
} from '../composables/notesView';

const emit = defineEmits<{ (e: 'jump', note: NoteItem): void }>();

const rootRef = ref<HTMLElement | null>(null);

/**
 * Esc 分层(与 SettingsPanel 同一套约定)：
 *  1. 先退出行内编辑；2. 再退两步删除确认；3. 全无则返回 false 让位给"关面板"。
 */
function handleEscape(): boolean {
  if (editingId.value) { cancelEdit(); return true; }
  if (pendingDeleteId.value) { cancelDelete(); return true; }
  if (pendingGroupKey.value) { cancelGroupDelete(); return true; }
  if (moreOpenId.value) { moreOpenId.value = ''; return true; }
  return false;
}

defineExpose({ el: rootRef, handleEscape });

/** 组头/章节组的稳定 id（供 aria-controls 指向真实容器） */
function itemsIdOf(key: string): string {
  return 'ntItems-' + key.replace(/[^A-Za-z0-9_-]+/g, '_');
}

/**
 * 笔记条目「更多」：常显入口，展开动作组。
 * 以前 `.nt-acts` 只在 hover 时 display:flex —— 触屏与键盘用户永远看不到「编辑/删除」（R11-03/04）。
 */
const moreOpenId = ref('');
function toggleMore(id: string): void {
  moreOpenId.value = moreOpenId.value === id ? '' : id;
}

const groups = computed<NoteBookGroup[]>(function () {
  const shelfPaths = new Set(state.shelf.map(function (b) { return b.filePath; }));
  const novel = state.novel as { filePath?: string } | null;
  const current = novel && novel.filePath || '';
  const chapterTitle = state.chapter ? state.chapter.title : '';
  return groupNotes(state.notes, current, shelfPaths, chapterTitle);
});
const total = computed(function () {
  return state.notes.length;
});

function isCollapsed(g: NoteBookGroup): boolean {
  // 管理模式强制展开: 免得"选中了看不见的条目"
  if (managing.value) { return false; }
  return !isGroupOpen(state.noteGroupOpen, g);
}
function toggleGroup(g: NoteBookGroup): void {
  if (managing.value) { return; }
  // 即将收起: 先收掉正在编辑的草稿与悬浮预览, 避免它们悬在已收起的分组上
  if (!isCollapsed(g)) {
    cancelEdit();
    hidePreview();
  }
  pendingGroupKey.value = '';
  toggleGroupOpen(state.noteGroupOpen, g);
}
function isChapCollapsed(bookPath: string, c: NoteChapterGroup): boolean {
  if (managing.value) { return false; }
  return !isChapterOpen(state.noteChapterOpen, bookPath, c);
}
function toggleChapter(bookPath: string, c: NoteChapterGroup): void {
  if (managing.value) { return; }
  if (!isChapCollapsed(bookPath, c)) {
    cancelEdit();
    hidePreview();
  }
  pendingGroupKey.value = '';
  toggleChapterOpen(state.noteChapterOpen, bookPath, c);
}

// ---------------------------------------------------------------- 管理(多选删除)
const managing = ref(false);
const selectedIds = ref<string[]>([]);

const allSelected = computed(function () {
  return state.notes.length > 0 && selectedIds.value.length === state.notes.length;
});

function toggleManaging(): void {
  managing.value = !managing.value;
  selectedIds.value = [];
  // 进出管理模式都清掉上一条过期报错(P3-3)
  opFailText.value = '';
  if (managing.value) {
    // 进入管理: 结束编辑/悬停预览/两步确认, 避免和勾选抢事件
    cancelEdit();
    hidePreview();
    pendingDeleteId.value = '';
    pendingGroupKey.value = '';
  }
}

function isSelectedNote(n: NoteItem): boolean {
  return selectedIds.value.indexOf(n.id) >= 0;
}

/** 条目复选框的可访问名称来源: 优先笔记正文, 没有正文就用引文; 截 20 字 */
function noteSnippet(n: NoteItem): string {
  const raw = (n.text && n.text.trim()) || (n.quote && n.quote.trim()) || n.chapterTitle || '';
  const oneLine = raw.replace(/\s+/g, ' ');
  return oneLine.length > 20 ? oneLine.slice(0, 20) + '…' : oneLine;
}

function toggleNote(n: NoteItem): void {
  if (isSelectedNote(n)) {
    selectedIds.value = selectedIds.value.filter(function (id) { return id !== n.id; });
  } else {
    selectedIds.value = selectedIds.value.concat([n.id]);
  }
}

function selectAllNotes(): void {
  selectedIds.value = allSelected.value ? [] : state.notes.map(function (n) { return n.id; });
}

/**
 * 批量删除笔记（R7-01 明确列出的三类危险操作之一）。
 *
 * 旧实现点一下就 send + 立刻清空选择、退出管理 —— 没有确认框、没有 opId、
 * 也没有终态：宿主失败时用户的选择和草稿已经丢了（R7-03/R9-05）。
 * 现在走统一 ConfirmDialog，**成功回包才清空并退出管理**。
 */
function removeSelectedNotes(): void {
  if (!selectedIds.value.length) { return; }
  opFailText.value = '';
  const ids = selectedIds.value.slice();
  const titles: string[] = [];
  const chapters = new Set<string>();
  for (const n of state.notes) {
    if (ids.indexOf(n.id) < 0) { continue; }
    if (titles.indexOf(n.bookTitle) < 0) { titles.push(n.bookTitle); }
    chapters.add(n.bookPath + '\u0000' + n.chapterTitle);
  }
  askConfirm({
    title: '删除 ' + ids.length + ' 条笔记',
    lines: [
      '将删除 ' + ids.length + ' 条笔记',
      '涉及 ' + titles.length + ' 本书 / ' + chapters.size + ' 章：' +
        titles.slice(0, 5).join('、') + (titles.length > 5 ? ' 等' : ''),
      '删除后不可恢复',
    ],
    confirmText: '删除',
    op: 'notes:remove',
    payload: { ids },
  });
}

/**
 * 写操作失败的**就地**提示（role=alert）。
 * 确认框在失败时会保留并显示原因，但用户也可能先关掉确认框，
 * 所以面板自己也要有一份，避免"点完没反应"（R7-03/R9-05）。
 */
const opFailText = ref('');

/**
 * 笔记类写操作的终态: 成功才退出管理并清空选择，失败保留上下文。
 *
 * 陈旧错误清理(P3-3)：opFailText 只描述"上一次笔记写操作"，所以**任何**成功操作
 * 都应该把它清掉（否则在别的面板成功做完事，回到这里仍挂着一条过期报错）。
 * 注意：确认框自己的失败提示不受影响 —— 那是 ConfirmDialog 的 failText。
 */
watch(function () { return state.lastOp; }, function (op) {
  if (!op) { return; }
  if (op.ok) { opFailText.value = ''; }
  if (op.op !== 'notes:remove' && op.op !== 'notes:removeGroup') { return; }
  if (!op.ok) {
    opFailText.value = op.message || '删除失败，请重试';
    return;
  }
  if (op.op === 'notes:remove') {
    managing.value = false;
    selectedIds.value = [];
  }
});

/** 一组笔记的勾选态: all=全选 / some=部分 / none=未选 */
function selState(items: NoteItem[]): 'all' | 'some' | 'none' {
  if (!items.length) { return 'none'; }
  let picked = 0;
  for (const n of items) { if (selectedIds.value.indexOf(n.id) >= 0) { picked += 1; } }
  return picked === 0 ? 'none' : picked === items.length ? 'all' : 'some';
}

/** 整组勾选/取消: 书头、章头用, 一下选中整本书 / 整章的笔记 */
function toggleGroupNotes(items: NoteItem[]): void {
  const ids = items.map(function (n) { return n.id; });
  const allPicked = ids.every(function (id) { return selectedIds.value.indexOf(id) >= 0; });
  if (allPicked) {
    selectedIds.value = selectedIds.value.filter(function (id) { return ids.indexOf(id) < 0; });
    return;
  }
  const merged = selectedIds.value.slice();
  for (const id of ids) { if (merged.indexOf(id) < 0) { merged.push(id); } }
  selectedIds.value = merged;
}

/** 条目点击: 管理模式下只勾选, 否则跳回原文 */
function onNoteClick(n: NoteItem): void {
  if (managing.value) {
    toggleNote(n);
    return;
  }
  if (editingId.value === n.id) { return; }
  jumpTo(n);
}

// 笔记变少(删除成功)后修剪选择
watch(function () { return state.notes.length; }, function () {
  if (!selectedIds.value.length) { return; }
  const alive = new Set(state.notes.map(function (n) { return n.id; }));
  const next = selectedIds.value.filter(function (id) { return alive.has(id); });
  if (next.length !== selectedIds.value.length) { selectedIds.value = next; }
});

// ---------------------------------------------------------------- 书/章分组批量删除(组头 hover 按钮, 两步确认)
const pendingGroupKey = ref('');
function bookDelKey(g: NoteBookGroup): string { return 'b:' + g.bookPath; }
function chapDelKey(bookPath: string, c: NoteChapterGroup): string { return 'c:' + bookPath + '\u0000' + c.chapterTitle; }
function groupDeleteConfirming(key: string): boolean { return pendingGroupKey.value === key; }
function requestGroupDelete(key: string, bookPath: string, chapterTitle?: string): void {
  // 已有组删除在跑: 不再开第二个 opId(P3-2)
  if (opRunning('notes:removeGroup')) { return; }
  if (pendingGroupKey.value === key) {
    pendingGroupKey.value = '';
    opFailText.value = '';
    // 带 opId + pending: 失败时宿主回 opResult 能就地报错, 连点也不会产生多个 opId(R9-05)
    const opId = newOpId();
    markOpPending(opId, 'notes:removeGroup');
    send({ type: 'removeNoteGroup', bookPath, chapterTitle, opId });
    return;
  }
  pendingGroupKey.value = key;
}
function cancelGroupDelete(): void {
  pendingGroupKey.value = '';
}

/** 空笔记不渲染正文行: 只记原文锚点时, 列表里只留原文/时间/操作 */
function noteHasText(n: NoteItem): boolean {
  return !!(n.text && n.text.trim());
}

// ---------------------------------------------------------------- 编辑态
const editingId = ref<string>('');
const editingText = ref<string>('');

function beginEdit(n: NoteItem): void {
  pendingDeleteId.value = '';
  editingId.value = n.id;
  editingText.value = n.text;
  nextTick(function () {
    const el = rootRef.value?.querySelector('.nt-edit-area') as HTMLTextAreaElement | null;
    if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
  });
}
function cancelEdit(): void {
  editingId.value = '';
  editingText.value = '';
}
function saveEdit(): void {
  // 允许清空正文(与新建一致); 内容未变化则直接退出编辑
  const text = editingText.value.trim();
  const cur = state.notes.find(function (n) { return n.id === editingId.value; });
  if (!cur) { cancelEdit(); return; }
  if (text === cur.text) { cancelEdit(); return; }
  send({ type: 'updateNote', id: editingId.value, text });
  // 立即退出编辑态: 之前要等 noteUpserted 回执, 期间编辑框还在,
  // 用户以为没存上再点一次 → "保存要点击两次"的错觉(数据其实第一次就存了)
  cancelEdit();
}
function onEditKey(e: KeyboardEvent): void {
  e.stopPropagation();
  if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); return; }
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) {
    e.preventDefault();
    saveEdit();
  }
}

// ---------------------------------------------------------------- 两步删除
// 确认态常驻: 直到点「确认删除」/「取消」/点浮层内其它地方才结束
const pendingDeleteId = ref<string>('');

function requestDelete(n: NoteItem): void {
  cancelEdit();
  if (pendingDeleteId.value === n.id) {
    pendingDeleteId.value = '';
    // 该条目即将从列表移除: 元素被删除时 mouseleave 不会触发, 预览会一直悬在原地 → 主动收起
    hidePreview();
    send({ type: 'removeNote', id: n.id });
    return;
  }
  pendingDeleteId.value = n.id;
}
/** 两步删除的「取消」: 回到普通态, 不发 removeNote */
function cancelDelete(): void {
  pendingDeleteId.value = '';
}
/** 浮层内点击其它地方 → 结束条目/分组删除确认态(确认/取消按钮自身的 click 先于冒泡处理, 不受影响) */
function onPopupClick(e: MouseEvent): void {
  const el = e.target as HTMLElement;
  if (el.closest && (el.closest('.nt-act-danger') || el.closest('.nt-act[data-cancel]') || el.closest('.ng-del'))) { return; }
  if (pendingDeleteId.value) { cancelDelete(); }
  if (pendingGroupKey.value) { cancelGroupDelete(); }
}
watch(function () { return state.notesOpen; }, function (open) {
  if (!open) {
    cancelEdit();
    pendingDeleteId.value = '';
    pendingGroupKey.value = '';
    managing.value = false;
    selectedIds.value = [];
    hidePreview();
  }
});

// ---------------------------------------------------------------- 悬浮预览(浮层右侧浮窗: 笔记 + 完整原文; 悬浮「笔记正文」触发, 原文行不触发)
const previewNote = ref<NoteItem | null>(null);
const previewPos = ref({ left: 0, top: 0 });
let hoverTimer: number | null = null;
let hideTimer: number | null = null;

function showPreview(n: NoteItem, e: MouseEvent): void {
  if (managing.value) { return; }
  hidePreview();
  const item = e.currentTarget as HTMLElement;
  hoverTimer = window.setTimeout(function () {
    const itemRect = item.getBoundingClientRect();
    const popupRect = rootRef.value?.getBoundingClientRect();
    const w = Math.min(340, window.innerWidth - 32);
    const estimated = 220;
    // 放在浮层右侧; 右侧放不下再翻到左侧, 都不行就夹取到视口内
    let left = (popupRect ? popupRect.right : itemRect.right) + 10;
    if (left + w > window.innerWidth - 8) {
      left = (popupRect ? popupRect.left : itemRect.left) - w - 10;
    }
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    const top = Math.max(8, Math.min(itemRect.top - 4, window.innerHeight - estimated - 8));
    previewPos.value = { left, top };
    previewNote.value = n;
    hoverTimer = null;
  }, 240);
}
function hidePreview(): void {
  if (hoverTimer !== null) { window.clearTimeout(hoverTimer); hoverTimer = null; }
  if (hideTimer !== null) { window.clearTimeout(hideTimer); hideTimer = null; }
  previewNote.value = null;
}
/** 鼠标移出条目时留一点缓冲, 便于把指针移到浮窗里看完整内容 */
function hideSoon(): void {
  if (hoverTimer !== null) { window.clearTimeout(hoverTimer); hoverTimer = null; }
  if (hideTimer !== null) { window.clearTimeout(hideTimer); }
  hideTimer = window.setTimeout(function () { hideTimer = null; hidePreview(); }, 180);
}
function cancelHide(): void {
  if (hideTimer !== null) { window.clearTimeout(hideTimer); hideTimer = null; }
}
// 兜底: 预览中的笔记被移除时收起。预览为 null 必须映射为 true,
// 否则 showPreview 内部先 hidePreview 的正常流程会误触发本 watch 清掉 hover 定时器
// (本段必须位于 previewNote 声明之后: watch 立即求值, 提前引用会踩 TDZ)
watch(function () {
  const id = previewNote.value?.id;
  return id ? state.notes.some(function (n) { return n.id === id; }) : true;
}, function (exists) { if (!exists) { hidePreview(); } });

// ---------------------------------------------------------------- 跳转
function jumpTo(n: NoteItem): void {
  // 跨书条目也允许: App.jumpToNote 会先换书再按笔记定位
  hidePreview();
  emit('jump', n);
}

const emptyText = '还没有笔记。在正文中单击任意段落，写下第一条想法。';
</script>

<template>
  <section id="notesPopup" ref="rootRef" class="popup" :class="{ open: state.notesOpen }" @click="onPopupClick"
    role="dialog" aria-modal="false" aria-labelledby="notesPopupTitle">
    <div class="popup-head">
      <h2 class="popup-title" id="notesPopupTitle" tabindex="-1">笔记</h2>
      <span class="popup-sub" v-show="total > 0">共 {{ total }} 条 · {{ groups.length }} 本书</span>
      <span class="spacer"></span>
      <button v-show="total > 0" class="popup-ghost" data-note-manage title="管理笔记（多选删除）"
        @click="toggleManaging">{{ managing ? '完成' : '管理' }}</button>
      <button class="popup-close" @click="state.notesOpen = false">关闭</button>
    </div>

    <!-- 写操作失败就地可见(role=alert)：失败瞬间就能看到，不必先关掉确认框。 -->
    <div v-if="opFailText" class="op-error" data-note-op-error role="alert">{{ opFailText }}</div>

    <div class="popup-body">
      <div v-if="groups.length === 0" class="popup-empty nt-empty">
        <span class="nt-empty-ico" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"
            stroke-linecap="round" stroke-linejoin="round">
            <path d="M6.5 3.5h7l4 4v13h-11z" />
            <path d="M13.5 3.5v4h4" />
            <path d="M9 11.5h6M9 15h4" />
          </svg>
        </span>
        <p class="nt-empty-main">{{ emptyText }}</p>
        <p class="nt-empty-sub">笔记只保存在本机。</p>
      </div>

      <div v-for="g in groups" :key="g.bookPath" class="nt-book" :class="{ collapsed: isCollapsed(g) }">
        <!-- 组头三件套: 容器(无 click) + 展开按钮 + 原生复选框 + 删除按钮。
             以前是 <button> 里嵌可聚焦 span, 浏览器会解析成"按钮内嵌可聚焦元素",
             读屏与 Enter 行为都不确定(R1-04)。 -->
        <div class="nt-book-head" :class="{ managing }">
          <button type="button" class="nt-expand" :aria-expanded="!isCollapsed(g)"
            :aria-controls="itemsIdOf('b:' + g.bookPath)"
            :title="'展开 / 收起《' + g.bookTitle + '》'" @click="toggleGroup(g)">
            <span class="nt-caret" aria-hidden="true">
              <svg viewBox="0 0 1024 1024" fill="currentColor">
                <path d="M175.95 210.96c13.35-11.58 33.56-10.14 45.14 3.22l282.1 331.38c4 4.61 11.17 4.6 15.14-0.04l284.48-331.39c11.51-13.41 31.71-14.95 45.12-3.44 13.41 11.51 14.95 31.71 3.44 45.12L526.12 634.7c-7.96 9.27-22.29 9.3-30.29 0.07L172.73 256.1c-11.57-13.35-10.13-33.56 3.22-45.14z" />
                <path d="M175.95 430.31c13.35-11.58 33.56-10.14 45.14 3.22l282.1 331.38c4 4.61 11.17 4.6 15.14-0.04l284.48-331.39c11.51-13.41 31.71-14.95 45.12-3.44 13.41 11.51 14.95 31.71 3.44 45.12L526.12 854.05c-7.96 9.27-22.29 9.3-30.29 0.07l-323.1-378.68c-11.57-13.34-10.13-33.55 3.22-45.13z" />
              </svg>
            </span>
            <span class="nt-book-title" :title="g.bookPath">{{ g.bookTitle }}</span>
            <span v-if="g.current" class="nt-tag">在读</span>
            <span v-else-if="g.orphan" class="nt-tag nt-tag-off">已移出书架</span>
            <span class="nt-book-count">{{ g.items.length }}</span>
          </button>
          <span class="spacer"></span>
          <!-- 半选用原生 indeterminate, 全选用 checked; 不再靠 role=checkbox 模拟 -->
          <input v-if="managing" type="checkbox" class="bk-check nt-head-check"
            :data-note-book-check="selState(g.items)"
            :checked="selState(g.items) === 'all'"
            :indeterminate.prop="selState(g.items) === 'some'"
            :aria-label="'选择《' + g.bookTitle + '》的全部笔记'"
            @change="toggleGroupNotes(g.items)" />
          <template v-else>
            <button type="button" v-if="groupDeleteConfirming(bookDelKey(g))" class="ng-del ng-cancel"
              aria-label="取消删除" title="取消删除" @click="cancelGroupDelete()">取消</button>
            <button type="button" class="ng-del" :data-note-group-del="1"
              :class="{ confirming: groupDeleteConfirming(bookDelKey(g)) }"
              :aria-label="'删除《' + g.bookTitle + '》的全部笔记'"
              :disabled="opRunning('notes:removeGroup')"
              :title="groupDeleteConfirming(bookDelKey(g)) ? '再次点击删除本书全部笔记' : '删除本书全部笔记'"
              @click="requestGroupDelete(bookDelKey(g), g.bookPath)">
              {{ groupDeleteConfirming(bookDelKey(g)) ? '确认删除' : '删除' }}</button>
          </template>
        </div>

        <div v-if="!isCollapsed(g)" class="nt-items" :id="itemsIdOf('b:' + g.bookPath)">
          <div v-for="c in g.chapters" :key="c.chapterTitle" class="nt-chap-group"
            :class="{ collapsed: isChapCollapsed(g.bookPath, c) }">
            <!-- 章组头同构: 容器 + 展开按钮 + 原生复选框 + 删除按钮 -->
            <div class="nt-chap-head" :class="{ managing }">
              <button type="button" class="nt-expand" :aria-expanded="!isChapCollapsed(g.bookPath, c)"
                :aria-controls="itemsIdOf('c:' + g.bookPath + ':' + c.chapterTitle)"
                :title="c.chapterTitle" @click="toggleChapter(g.bookPath, c)">
                <span class="nt-caret" aria-hidden="true">
                  <svg viewBox="0 0 1024 1024" fill="currentColor">
                    <path d="M175.95 210.96c13.35-11.58 33.56-10.14 45.14 3.22l282.1 331.38c4 4.61 11.17 4.6 15.14-0.04l284.48-331.39c11.51-13.41 31.71-14.95 45.12-3.44 13.41 11.51 14.95 31.71 3.44 45.12L526.12 634.7c-7.96 9.27-22.29 9.3-30.29 0.07L172.73 256.1c-11.57-13.35-10.13-33.56 3.22-45.14z" />
                    <path d="M175.95 430.31c13.35-11.58 33.56-10.14 45.14 3.22l282.1 331.38c4 4.61 11.17 4.6 15.14-0.04l284.48-331.39c11.51-13.41 31.71-14.95 45.12-3.44 13.41 11.51 14.95 31.71 3.44 45.12L526.12 854.05c-7.96 9.27-22.29 9.3-30.29 0.07l-323.1-378.68c-11.57-13.34-10.13-33.55 3.22-45.13z" />
                  </svg>
                </span>
                <span class="nt-chap-title">{{ c.chapterTitle }}</span>
                <span v-if="c.current" class="nt-tag">在读</span>
                <span class="nt-book-count">{{ c.items.length }}</span>
              </button>
              <span class="spacer"></span>
              <input v-if="managing" type="checkbox" class="bk-check nt-head-check"
                :data-note-chap-check="selState(c.items)"
                :checked="selState(c.items) === 'all'"
                :indeterminate.prop="selState(c.items) === 'some'"
                :aria-label="'选择本章全部笔记：' + c.chapterTitle"
                @change="toggleGroupNotes(c.items)" />
              <template v-else>
                <button type="button" v-if="groupDeleteConfirming(chapDelKey(g.bookPath, c))"
                  class="ng-del ng-cancel" aria-label="取消删除" title="取消删除"
                  @click="cancelGroupDelete()">取消</button>
                <button type="button" class="ng-del" :data-note-group-del="1"
                  :class="{ confirming: groupDeleteConfirming(chapDelKey(g.bookPath, c)) }"
                  :aria-label="'删除本章全部笔记：' + c.chapterTitle"
                  :disabled="opRunning('notes:removeGroup')"
                  :title="groupDeleteConfirming(chapDelKey(g.bookPath, c)) ? '再次点击删除本章全部笔记' : '删除本章全部笔记'"
                  @click="requestGroupDelete(chapDelKey(g.bookPath, c), g.bookPath, c.chapterTitle)">
                  {{ groupDeleteConfirming(chapDelKey(g.bookPath, c)) ? '确认删除' : '删除' }}</button>
              </template>
            </div>
            <div v-if="!isChapCollapsed(g.bookPath, c)" class="nt-items"
              :id="itemsIdOf('c:' + g.bookPath + ':' + c.chapterTitle)">
          <div v-for="n in c.items" :key="n.id" class="nt-item" :data-note-id="n.id"
            :class="{ editing: editingId === n.id, managing: managing, sel: managing && isSelectedNote(n), 'more-open': moreOpenId === n.id }"
            @click="onNoteClick(n)"
            @mouseenter="showPreview(n, $event)" @mouseleave="hideSoon()">
            <!-- 条目级勾选用原生 checkbox: 可 Tab 到达、有含上下文的名称(R12-03/R12-04)。
                 I1 修复: label 必须自己 @click.stop。
                 - 点 16px 框: input 的 .stop.prevent 吃掉事件 → 只切换一次;
                 - 点 label 外圈: 浏览器的"label→input 激活"会合成一次 input click → 切换一次,
                   若 label 不 stop, 原始 click 还会冒泡到整行触发 onNoteClick → 净效果为 0(命中区等于失效)。
                   这里只 stop 不 prevent, 原生激活必须保留。 -->
            <label v-if="managing" class="nt-check-label" @click.stop>
              <input type="checkbox" class="bk-check nt-check" data-note-check
                :checked="isSelectedNote(n)"
                :aria-label="'选择笔记：' + noteSnippet(n)"
                @click.stop.prevent="toggleNote(n)" />
            </label>
            <template v-if="editingId === n.id">
              <textarea class="nt-edit-area" v-model="editingText" rows="3"
                @keydown="onEditKey" @click.stop></textarea>
              <div class="nt-edit-foot">
                <span class="spacer"></span>
                <button class="nt-act" @click.stop="cancelEdit()">取消</button>
                <button class="nt-act nt-act-primary" @click.stop="saveEdit()">保存</button>
              </div>
              <div class="nt-quote-hint" :title="n.quote">原文：{{ n.quote }}</div>
            </template>
            <template v-else>
              <p v-if="noteHasText(n)" class="nt-text">{{ n.text }}</p>
              <div class="nt-meta">
                <span class="nt-quote">原文：{{ n.quote }}</span>
                <span class="nt-time">{{ relativeTime(n.updatedAt) }}</span>
              </div>
              <!-- 「更多」常显入口: 触屏/键盘不再依赖 hover 才能看到动作组(R11-03/04)。
                   点击笔记正文定位原文的行为保持不变(正文与 meta 仍是主点击区)。 -->
              <div v-if="!managing" class="nt-more-row">
                <button type="button" class="nt-more" :data-note-more="n.id"
                  :aria-expanded="moreOpenId === n.id ? 'true' : 'false'"
                  :aria-label="'更多操作：' + (n.text || n.quote).slice(0, 12)"
                  @click.stop="toggleMore(n.id)">{{ moreOpenId === n.id ? '收起' : '更多' }}</button>
              </div>
              <div v-if="!managing" class="nt-acts">
                <button class="nt-act nt-go" @click.stop="jumpTo(n)">定位到原文</button>
                <span class="spacer"></span>
                <button class="nt-act" @click.stop="beginEdit(n)">编辑</button>
                <button v-if="pendingDeleteId === n.id" class="nt-act" data-cancel
                  @click.stop="cancelDelete()">取消</button>
                <button class="nt-act nt-act-danger" :class="{ confirming: pendingDeleteId === n.id }"
                  @click.stop="requestDelete(n)">{{ pendingDeleteId === n.id ? '确认删除' : '删除' }}</button>
              </div>
            </template>
          </div>
          </div>
        </div>
      </div>
    </div>
    </div>

    <div class="popup-foot nt-foot">
      <template v-if="!managing">
        <span class="nt-foot-tip">在正文中单击任意段落即可记笔记</span>
      </template>
      <template v-else>
        <button class="popup-btn" data-note-select-all @click="selectAllNotes">
          {{ allSelected ? '取消全选' : '全选' }}
        </button>
        <span class="sel-count" data-note-sel-count>已选 {{ selectedIds.length }} 条</span>
        <span class="spacer"></span>
        <button class="popup-primary popup-danger" data-note-remove-selected
          :disabled="!selectedIds.length || opRunning('notes:remove')"
          :title="!selectedIds.length ? '请先勾选要删除的笔记' : '删除所选'"
          @click="removeSelectedNotes">删除所选</button>
      </template>
    </div>

    <!-- 悬浮预览: 浮层右侧, 笔记 + 完整原文(可滚动); 悬浮「笔记正文」触发 -->
    <div v-if="previewNote" class="note-preview" :style="{ left: previewPos.left + 'px', top: previewPos.top + 'px' }"
      @mouseenter="cancelHide()" @mouseleave="hidePreview()">
      <template v-if="noteHasText(previewNote)">
        <div class="np-label">笔记</div>
        <div class="np-note">{{ previewNote.text }}</div>
      </template>
      <div class="np-label">原文</div>
      <div class="np-quote">{{ previewNote.quote }}</div>
    </div>
  </section>
</template>
