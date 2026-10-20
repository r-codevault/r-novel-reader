<script setup lang="ts">
/**
 * NotesPopup.vue — 阅读笔记浮层
 *
 * 结构: 头部(条数) → 书分组(可折叠) → 章分组(可折叠) → 条目(正文/原文/时间)
 * 交互: 点条目或「定位到原文」跳回原文; 悬浮笔记正文 → 右侧浮窗看完整笔记+原文; 行内编辑; 两步确认删除
 */
import { computed, nextTick, ref, watch } from 'vue';
import { state, send, type NoteItem } from '../composables/vscode';
import {
  groupNotes, isChapterOpen, isGroupOpen, relativeTime,
  toggleChapterOpen, toggleGroupOpen,
  type NoteBookGroup, type NoteChapterGroup,
} from '../composables/notesView';

const emit = defineEmits<{ (e: 'jump', note: NoteItem): void }>();

const rootRef = ref<HTMLElement | null>(null);
defineExpose({ el: rootRef });

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
  return !isGroupOpen(state.noteGroupOpen, g);
}
function toggleGroup(g: NoteBookGroup): void {
  // 即将收起: 先收掉正在编辑的草稿与悬浮预览, 避免它们悬在已收起的分组上
  if (!isCollapsed(g)) {
    cancelEdit();
    hidePreview();
  }
  toggleGroupOpen(state.noteGroupOpen, g);
}
function isChapCollapsed(bookPath: string, c: NoteChapterGroup): boolean {
  return !isChapterOpen(state.noteChapterOpen, bookPath, c);
}
function toggleChapter(bookPath: string, c: NoteChapterGroup): void {
  if (!isChapCollapsed(bookPath, c)) {
    cancelEdit();
    hidePreview();
  }
  toggleChapterOpen(state.noteChapterOpen, bookPath, c);
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
const pendingDeleteId = ref<string>('');
let deleteTimer: number | null = null;

function requestDelete(n: NoteItem): void {
  cancelEdit();
  if (pendingDeleteId.value === n.id) {
    clearDeleteTimer();
    pendingDeleteId.value = '';
    // 该条目即将从列表移除: 元素被删除时 mouseleave 不会触发, 预览会一直悬在原地 → 主动收起
    hidePreview();
    send({ type: 'removeNote', id: n.id });
    return;
  }
  pendingDeleteId.value = n.id;
  clearDeleteTimer();
  deleteTimer = window.setTimeout(function () {
    pendingDeleteId.value = '';
    deleteTimer = null;
  }, 3000);
}
function clearDeleteTimer(): void {
  if (deleteTimer !== null) { window.clearTimeout(deleteTimer); deleteTimer = null; }
}
watch(function () { return state.notesOpen; }, function (open) {
  if (!open) { cancelEdit(); pendingDeleteId.value = ''; clearDeleteTimer(); hidePreview(); }
});

// ---------------------------------------------------------------- 悬浮预览(浮层右侧浮窗: 笔记 + 完整原文; 悬浮「笔记正文」触发, 原文行不触发)
const previewNote = ref<NoteItem | null>(null);
const previewPos = ref({ left: 0, top: 0 });
let hoverTimer: number | null = null;
let hideTimer: number | null = null;

function showPreview(n: NoteItem, e: MouseEvent): void {
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
  if (n.bookPath !== (state.novel as { filePath?: string } | null)?.filePath) { return; }
  hidePreview();
  emit('jump', n);
}

const emptyText = '还没有笔记。在正文中单击任意段落，写下第一条想法。';
</script>

<template>
  <section id="notesPopup" ref="rootRef" class="popup" :class="{ open: state.notesOpen }">
    <div class="popup-head">
      <b class="popup-title">笔记</b>
      <span class="popup-sub" v-show="total > 0">共 {{ total }} 条 · {{ groups.length }} 本书</span>
      <span class="spacer"></span>
      <button class="popup-close" @click="state.notesOpen = false">关闭</button>
    </div>

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
        <button class="nt-book-head" :aria-expanded="!isCollapsed(g)" @click="toggleGroup(g)">
          <span class="nt-caret" aria-hidden="true">
            <svg viewBox="0 0 1024 1024" fill="currentColor">
              <path d="M175.95 210.96c13.35-11.58 33.56-10.14 45.14 3.22l282.1 331.38c4 4.61 11.17 4.6 15.14-0.04l284.48-331.39c11.51-13.41 31.71-14.95 45.12-3.44 13.41 11.51 14.95 31.71 3.44 45.12L526.12 634.7c-7.96 9.27-22.29 9.3-30.29 0.07L172.73 256.1c-11.57-13.35-10.13-33.56 3.22-45.14z" />
              <path d="M175.95 430.31c13.35-11.58 33.56-10.14 45.14 3.22l282.1 331.38c4 4.61 11.17 4.6 15.14-0.04l284.48-331.39c11.51-13.41 31.71-14.95 45.12-3.44 13.41 11.51 14.95 31.71 3.44 45.12L526.12 854.05c-7.96 9.27-22.29 9.3-30.29 0.07l-323.1-378.68c-11.57-13.34-10.13-33.55 3.22-45.13z" />
            </svg>
          </span>
          <span class="nt-book-title" :title="g.bookPath">{{ g.bookTitle }}</span>
          <span v-if="g.current" class="nt-tag">在读</span>
          <span v-else-if="g.orphan" class="nt-tag nt-tag-off">已移出书架</span>
          <span class="spacer"></span>
          <span class="nt-book-count">{{ g.items.length }}</span>
        </button>

        <div v-if="!isCollapsed(g)" class="nt-items">
          <div v-for="c in g.chapters" :key="c.chapterTitle" class="nt-chap-group"
            :class="{ collapsed: isChapCollapsed(g.bookPath, c) }">
            <button class="nt-chap-head" :title="c.chapterTitle"
              :aria-expanded="!isChapCollapsed(g.bookPath, c)" @click="toggleChapter(g.bookPath, c)">
              <span class="nt-caret" aria-hidden="true">
                <svg viewBox="0 0 1024 1024" fill="currentColor">
                  <path d="M175.95 210.96c13.35-11.58 33.56-10.14 45.14 3.22l282.1 331.38c4 4.61 11.17 4.6 15.14-0.04l284.48-331.39c11.51-13.41 31.71-14.95 45.12-3.44 13.41 11.51 14.95 31.71 3.44 45.12L526.12 634.7c-7.96 9.27-22.29 9.3-30.29 0.07L172.73 256.1c-11.57-13.35-10.13-33.56 3.22-45.14z" />
                  <path d="M175.95 430.31c13.35-11.58 33.56-10.14 45.14 3.22l282.1 331.38c4 4.61 11.17 4.6 15.14-0.04l284.48-331.39c11.51-13.41 31.71-14.95 45.12-3.44 13.41 11.51 14.95 31.71 3.44 45.12L526.12 854.05c-7.96 9.27-22.29 9.3-30.29 0.07l-323.1-378.68c-11.57-13.34-10.13-33.55 3.22-45.13z" />
                </svg>
              </span>
              <span class="nt-chap-title">{{ c.chapterTitle }}</span>
              <span v-if="c.current" class="nt-tag">在读</span>
              <span class="spacer"></span>
              <span class="nt-book-count">{{ c.items.length }}</span>
            </button>
            <div v-if="!isChapCollapsed(g.bookPath, c)" class="nt-items">
          <div v-for="n in c.items" :key="n.id" class="nt-item" :data-note-id="n.id"
            :class="{ editing: editingId === n.id }"
            @click="editingId === n.id ? null : jumpTo(n)"
            @mouseenter="showPreview(n, $event)" @mouseleave="hideSoon()">
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
              <div class="nt-acts">
                <button class="nt-act nt-go" @click.stop="jumpTo(n)">定位到原文</button>
                <span class="spacer"></span>
                <button class="nt-act" @click.stop="beginEdit(n)">编辑</button>
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
      <span class="nt-foot-tip">在正文中单击任意段落即可记笔记</span>
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
