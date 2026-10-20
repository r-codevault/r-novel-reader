<script setup lang="ts">
/**
 * ReaderArea.vue — 正文阅读区(留白 + 纸面 + 左右宽度拖拽手柄)
 * 宽度拖拽与手柄定位自包含; resize 对齐由 App 调用 positionHandles()
 */
import { computed, onMounted, reactive, ref, watch } from 'vue';
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

// ---------------------------------------------------------------- 笔记: 段落悬浮预览(已记笔记的段落)
const paraTip = ref<{ index: number; top: number; left: number } | null>(null);
let tipTimer: number | null = null;
const TIP_EST_H = 110;
const TIP_MAX_W = 340;

function onParaEnter(index: number, e: MouseEvent): void {
  if (!paraNotes.value.has(index)) { return; }
  onParaLeave();
  const item = e.currentTarget as HTMLElement;
  tipTimer = window.setTimeout(function () {
    const rect = item.getBoundingClientRect();
    const w = Math.min(TIP_MAX_W, window.innerWidth - 32);
    // 默认显示在段落上方; 空间不足(触顶)翻到段落下方
    let top = rect.top - TIP_EST_H - 10;
    if (top < 8) { top = rect.bottom + 10; }
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - w - 8));
    paraTip.value = { index, top, left };
    tipTimer = null;
  }, 250);
}
function onParaLeave(): void {
  if (tipTimer !== null) { window.clearTimeout(tipTimer); tipTimer = null; }
  paraTip.value = null;
}
// 章变化/滚动时预览悬在错误位置, 直接收起
watch(function () { return state.chapter; }, function () { onParaLeave(); });

/** 空笔记占位: 与笔记浮层保持一致 */
function tipText(n: NoteItem): string {
  return n.text && n.text.trim() ? n.text : '（未填写内容）';
}

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
  onParaLeave();
  if (hadSelection) { hadSelection = false; return; }
  if (selectionActive()) { return; }
  const ch = state.chapter;
  if (!ch) { return; }
  const text = (ch.paragraphs[index] || '').trim();
  if (!text) { return; }
  if (resizingWidth.value) { return; }
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  state.noteComposer = {
    phase: 'composing',
    chapterTitle: ch.title,
    chapterIndex: ch.index,
    paragraphIndex: index,
    quote: text,
    text: '',
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
  window.setTimeout(function () { el.classList.remove('note-focus'); }, 1600);
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
  // 滚动时收起段落笔记预览(固定定位会悬在错误位置)
  window.addEventListener('scroll', onParaLeave, { passive: true });
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
        @mousedown="onParaMouseDown" @click="onParaClick(i, $event)"
        @mouseenter="onParaEnter(i, $event)" @mouseleave="onParaLeave">{{ p }}</p>
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

    <!-- 段落悬浮笔记预览: 显示在该段上方(触顶翻到下方), 不拦截指针 -->
    <div v-if="paraTip" class="para-note-tip"
      :style="{ top: paraTip.top + 'px', left: paraTip.left + 'px' }" aria-hidden="true">
      <div v-for="n in (paraNotes.get(paraTip.index) || [])" :key="n.id" class="pnt-item">
        <p class="pnt-text" :class="{ 'pnt-text-empty': !(n.text && n.text.trim()) }">{{ tipText(n) }}</p>
      </div>
    </div>
  </main>
</template>
