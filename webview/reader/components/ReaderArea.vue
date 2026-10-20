<script setup lang="ts">
/**
 * ReaderArea.vue — 正文阅读区(留白 + 纸面 + 左右宽度拖拽手柄)
 * 宽度拖拽与手柄定位自包含; resize 对齐由 App 调用 positionHandles()
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { state, gotoChapter, type NoteItem } from '../composables/vscode';
import { findParagraph } from '../../../src/noteAnchor';
import { persistSettings, CONTENT_WIDTH, syncXScrollbar } from '../store';

// 与 settings.ts 的 CONTENT_WIDTH 一致: 上限放宽到 4000, 允许拖出窗口宽度(横向滚动)
const WIDTH_MIN = CONTENT_WIDTH.min;
const WIDTH_MAX = CONTENT_WIDTH.max;

const readerRef = ref<HTMLElement | null>(null);
const contentRef = ref<HTMLElement | null>(null);
const handleLeftRef = ref<HTMLElement | null>(null);
const handleRightRef = ref<HTMLElement | null>(null);
const handleLeftStyle = reactive({ left: 'auto', right: 'auto' });
const handleRightStyle = reactive({ left: 'auto', right: 'auto' });
const resizingWidth = ref(false);

const chapter = computed(() => state.chapter);
const paras = computed(() => (state.chapter && state.chapter.paragraphs) || []);

const isFirst = computed(() => !state.chapter || state.chapter.index <= 0);
const isLast = computed(() =>
  !state.chapter || !state.novel || state.chapter.index >= state.novel.totalChapters - 1
);

// ---------------------------------------------------------------- 笔记: 段落下划线标记
/**
 * 当前章节每个段落锚定的笔记(引文精确命中才收录)。
 * 持久下划线与悬浮预览共用这一份数据。
 */
const paraNotes = computed<Map<number, NoteItem[]>>(function () {
  const ch = state.chapter;
  const out = new Map<number, NoteItem[]>();
  if (!ch) { return out; }
  const filePath = (state.novel as { filePath?: string } | null)?.filePath || '';
  for (const n of state.notes) {
    if (n.bookPath !== filePath || n.chapterTitle !== ch.title) { continue; }
    const found = findParagraph(ch.paragraphs, n.paragraphIndex, n.quote);
    if (!found.exact) { continue; }
    const list = out.get(found.index);
    if (list) { list.push(n); } else { out.set(found.index, [n]); }
  }
  return out;
});

/** 正在新建笔记(卡片打开)的段落 → 高亮虚线下划线 */
const composerPara = computed<number>(function () {
  const c = state.noteComposer;
  const ch = state.chapter;
  if (!c || !ch || c.chapterTitle !== ch.title) { return -1; }
  return c.paragraphIndex;
});

/** mousedown 时是否已有文本选区(拖选复制/查词时不应弹卡片) */
let hadSelection = false;

function selectionActive(): boolean {
  const sel = window.getSelection();
  return !!(sel && !sel.isCollapsed && sel.toString().trim());
}

function onParaMouseDown(): void {
  hadSelection = selectionActive();
}

function onParaClick(index: number, e: MouseEvent): void {
  if (hadSelection) { hadSelection = false; return; }
  if (selectionActive()) { return; }
  const ch = state.chapter;
  if (!ch) { return; }
  const text = (ch.paragraphs[index] || '').trim();
  if (!text) { return; }
  if (resizingWidth.value) { return; }
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  // 该段落已有笔记 → 带入最近编辑的一条内容(保存走 updateNote); 否则新建
  const existing = paraNotes.value.get(index);
  let latest: NoteItem | null = null;
  if (existing && existing.length) {
    latest = existing.reduce(function (a, b) { return (b.updatedAt || 0) > (a.updatedAt || 0) ? b : a; });
  }
  state.noteComposer = {
    phase: 'composing',
    chapterTitle: ch.title,
    chapterIndex: ch.index,
    paragraphIndex: index,
    quote: text,
    text: latest ? latest.text : '',
    editId: latest ? latest.id : undefined,
    anchorTop: rect.top,
    anchorBottom: rect.bottom,
    anchorLeft: rect.left,
  };
}

/** 滚动到指定段落并短暂高亮; 引文找不到时落到 hint 附近 */
function scrollToParagraph(target: { paragraphIndex: number; quote: string }): { index: number; exact: boolean } {
  const ch = state.chapter;
  const found = ch
    ? findParagraph(ch.paragraphs, target.paragraphIndex, target.quote)
    : { index: target.paragraphIndex, exact: false };
  const el = document.querySelector('#content p[data-p="' + found.index + '"]') as HTMLElement | null;
  if (!el) { return found; }
  el.scrollIntoView({
    block: 'center',
    behavior: window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
  });
  // 重复跳转先清掉旧高亮, 避免多处同时闪
  document.querySelectorAll('#content p.note-focus').forEach(function (n) { n.classList.remove('note-focus'); });
  el.classList.add('note-focus');
  window.setTimeout(function () { el.classList.remove('note-focus'); }, 3600);
  return found;
}

function prevChapter(): void {
  if (state.chapter && !isFirst.value) { gotoChapter(state.chapter.index - 1, 'prev'); }
}
function nextChapter(): void {
  if (state.chapter && !isLast.value) { gotoChapter(state.chapter.index + 1, 'next'); }
}

function positionHandles(): void {
  if (!contentRef.value) { return; }
  const rect = contentRef.value.getBoundingClientRect();
  const readerRect = readerRef.value
    ? readerRef.value.getBoundingClientRect()
    : { left: 0, right: window.innerWidth };
  handleLeftStyle.left = rect.left - readerRect.left + 'px';
  handleLeftStyle.right = 'auto';
  handleRightStyle.right = readerRect.right - rect.right + 'px';
  handleRightStyle.left = 'auto';
}

let widthDrag: { side: 'left' | 'right'; startX: number; startW: number; handle: HTMLElement } | null = null;

function beginWidthDrag(side: 'left' | 'right', e: PointerEvent): void {
  if (e.button !== 0 || !contentRef.value) { return; }
  e.preventDefault();
  const handle = side === 'left' ? handleLeftRef.value : handleRightRef.value;
  if (!handle) { return; }
  widthDrag = { side: side, startX: e.clientX, startW: contentRef.value.getBoundingClientRect().width, handle: handle };
  resizingWidth.value = true;
  // 拖拽期间一律按「自定义」处理: 允许拖过窗口宽度, 由文档横向滚动承载
  document.documentElement.dataset.widthMode = 'custom';
  // 命中窄窗口时实际渲染宽度可能小于设定值, 先把变量钉到当前渲染宽度, 避免按下瞬间跳宽
  document.documentElement.style.setProperty('--content-width', Math.round(widthDrag.startW) + 'px');
  // 捕获指针: 保证松手(手指抬起)即结束拖拽
  if (handle.setPointerCapture && e.pointerId !== undefined) {
    try { handle.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
  }
  document.body.style.userSelect = 'none';
  positionHandles();
}

function moveWidthDrag(e: PointerEvent): void {
  if (!widthDrag) { return; }
  const delta = e.clientX - widthDrag.startX;
  // 左缘向右拖 → 变窄; 右缘向右拖 → 变宽; 上限放开到 CONTENT_WIDTH.max, 超出窗口即横向滚动
  const factor = widthDrag.side === 'left' ? -1 : 1;
  const next = Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, Math.round(widthDrag.startW + factor * delta)));
  document.documentElement.style.setProperty('--content-width', next + 'px');
  positionHandles();
  syncXScrollbar();
}

function endWidthDrag(e: PointerEvent): void {
  if (!widthDrag) { return; }
  if (widthDrag.handle.releasePointerCapture && e.pointerId !== undefined) {
    try { widthDrag.handle.releasePointerCapture(e.pointerId); } catch { /* 忽略 */ }
  }
  resizingWidth.value = false;
  document.body.style.userSelect = '';
  const finalW = parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--content-width')
  );
  if (isFinite(finalW) && finalW > 0) {
    // 拖拽 = 自定义像素宽度: 同时关掉比例档, 否则会被比例覆盖
    persistSettings({ contentWidth: Math.round(finalW), widthRatio: 0 });
  }
  widthDrag = null;
}

onMounted(function () {
  document.addEventListener('pointermove', function (e: PointerEvent) { moveWidthDrag(e); });
  document.addEventListener('pointerup', function (e: PointerEvent) { endWidthDrag(e); });
  document.addEventListener('pointercancel', function (e: PointerEvent) { endWidthDrag(e); });
  window.addEventListener('resize', positionHandles);
  window.addEventListener('resize', syncXScrollbar);
  requestAnimationFrame(positionHandles);
});

defineExpose({ positionHandles, scrollToParagraph });
</script>

<template>
  <main id="reader" ref="readerRef" :class="{ 'resizing-width': resizingWidth }">
    <article id="content" ref="contentRef">
      <h2 class="chapter-title">{{ chapter ? chapter.title : '' }}</h2>
      <p v-if="paras.length === 0" class="empty-tip">(本章无内容)</p>
      <p v-for="(p, i) in paras" :key="i" class="rd-para" :data-p="i"
        :class="{ 'rd-para-noted': paraNotes.has(i), 'rd-para-active': composerPara === i }"
        @mousedown="onParaMouseDown" @click="onParaClick(i, $event)">{{ p }}</p>
    </article>

    <!-- 章节底部导航(纸面外侧, 跟随页面滚动) -->
    <div class="ch-nav" v-if="chapter">
      <button class="ch-nav-btn" :disabled="isFirst" @click="prevChapter">← 上一章</button>
      <button class="ch-nav-btn" :disabled="isLast" @click="nextChapter">下一章 →</button>
    </div>
    <div ref="handleLeftRef" class="width-handle" :style="handleLeftStyle" aria-hidden="true"
      @pointerdown="beginWidthDrag('left', $event)"></div>
    <div ref="handleRightRef" class="width-handle" :style="handleRightStyle" aria-hidden="true"
      @pointerdown="beginWidthDrag('right', $event)"></div>
  </main>
</template>
