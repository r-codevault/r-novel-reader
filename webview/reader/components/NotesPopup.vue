<script setup lang="ts">
/**
 * NotesPopup.vue — 阅读笔记浮层
 *
 * 结构: 头部(条数) → 按书分组(可折叠) → 条目(正文预览/章节/时间)
 * 交互: 点击条目跳回原文; hover 浮层预览整段引文; 行内编辑; 两步确认删除
 */
import { computed, nextTick, ref, watch } from 'vue';
import { state, send, type NoteItem } from '../composables/vscode';
import { groupNotes, isGroupOpen, relativeTime, toggleGroupOpen, type NoteBookGroup } from '../composables/notesView';

const emit = defineEmits<{ (e: 'jump', note: NoteItem): void }>();

const rootRef = ref<HTMLElement | null>(null);
defineExpose({ el: rootRef });

const groups = computed<NoteBookGroup[]>(function () {
  const shelfPaths = new Set(state.shelf.map(function (b) { return b.filePath; }));
  const current = state.novel && (state.novel as { filePath?: string }).filePath || '';
  return groupNotes(state.notes, current, shelfPaths);
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

/** 空笔记占位: 允许只记原文锚点、不写正文 */
const EMPTY_NOTE_TEXT = '（未填写内容）';
function noteHasText(n: NoteItem): boolean {
  return !!(n.text && n.text.trim());
}
function notePreviewText(n: NoteItem): string {
  return noteHasText(n) ? n.text : EMPTY_NOTE_TEXT;
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

// ---------------------------------------------------------------- 悬浮预览
const previewNote = ref<NoteItem | null>(null);
const previewPos = ref({ left: 0, top: 0 });
let hoverTimer: number | null = null;
let hideTimer: number | null = null;

function showPreview(n: NoteItem, e: MouseEvent): void {
  hidePreview();
  const item = e.currentTarget as HTMLElement;
  hoverTimer = window.setTimeout(function () {
    const rect = item.getBoundingClientRect();
    const popup = rootRef.value?.getBoundingClientRect();
    const w = Math.min(340, window.innerWidth - 32);
    const estimated = 220;
    let left = (popup ? popup.right : rect.right) + 10;
    if (left + w > window.innerWidth - 8) {
      left = (popup ? popup.left : rect.left) - w - 10;
    }
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    const top = Math.max(8, Math.min(rect.top, window.innerHeight - estimated - 8));
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
/** 鼠标移出条目时留一点缓冲, 便于把指针移到浮层上点「定位到本章原文」 */
function hideSoon(): void {
  if (hoverTimer !== null) { window.clearTimeout(hoverTimer); hoverTimer = null; }
  if (hideTimer !== null) { window.clearTimeout(hideTimer); }
  hideTimer = window.setTimeout(function () { hideTimer = null; hidePreview(); }, 180);
}
function cancelHide(): void {
  if (hideTimer !== null) { window.clearTimeout(hideTimer); hideTimer = null; }
}

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
      <button class="popup-close" @click="toggleGroup(g)">关闭</button>
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
          <span class="nt-caret" aria-hidden="true">▸</span>
          <span class="nt-book-title" :title="g.bookPath">{{ g.bookTitle }}</span>
          <span v-if="g.current" class="nt-tag">在读</span>
          <span v-else-if="g.orphan" class="nt-tag nt-tag-off">已移出书架</span>
          <span class="spacer"></span>
          <span class="nt-book-count">{{ g.items.length }}</span>
        </button>

        <div v-if="!isCollapsed(g)" class="nt-items">
          <div v-for="n in g.items" :key="n.id" class="nt-item" :data-note-id="n.id"
            :class="{ editing: editingId === n.id }"
            @click="editingId === n.id ? null : jumpTo(n)"
            @mouseenter="showPreview(n, $event)" @mouseleave="hideSoon()" @focusin="showPreview(n, $event)">
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
              <p class="nt-text" :class="{ 'nt-text-empty': !noteHasText(n) }">{{ notePreviewText(n) }}</p>
              <div class="nt-meta">
                <span class="nt-chap" :title="n.chapterTitle">{{ n.chapterTitle }}</span>
                <span class="nt-time">{{ relativeTime(n.updatedAt) }}</span>
              </div>
              <div class="nt-acts">
                <button class="nt-act" @click.stop="beginEdit(n)">编辑</button>
                <button class="nt-act nt-act-danger" :class="{ confirming: pendingDeleteId === n.id }"
                  @click.stop="requestDelete(n)">{{ pendingDeleteId === n.id ? '确认删除' : '删除' }}</button>
              </div>
            </template>
          </div>
        </div>
      </div>
    </div>

    <div class="popup-foot nt-foot">
      <span class="nt-foot-tip">在正文中单击任意段落即可记笔记</span>
    </div>

    <!-- 悬浮预览: 引用原文(整段) + 章节 -->
    <div v-if="previewNote" class="note-preview" :style="{ left: previewPos.left + 'px', top: previewPos.top + 'px' }"
      @mouseenter="cancelHide()" @mouseleave="hidePreview()">
      <div class="np-head">
        <span class="np-book">{{ previewNote.bookTitle }}</span>
        <span class="np-chap">{{ previewNote.chapterTitle }}</span>
      </div>
      <div class="np-quote">{{ previewNote.quote }}</div>
      <button class="np-go" @click.stop="jumpTo(previewNote)">定位到本章原文 →</button>
    </div>
  </section>
</template>
