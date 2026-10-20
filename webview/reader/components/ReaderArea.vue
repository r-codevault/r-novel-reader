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

/** 两侧箭头显示模式: always 常驻(默认) / hover 鼠标移到箭头区域才显示 */
const sideNavHoverOnly = computed(() => state.settings?.sideNavMode === 'hover');

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

    <!-- 正文两侧: 上/下一章箭头(垂直居中; 阅读设置可切换 常驻/悬浮显示) -->
    <button class="side-nav side-nav-prev" :class="{ 'hover-only': sideNavHoverOnly }" :disabled="isFirst"
      title="上一章 (Alt+←)" aria-label="上一章" @click="prevChapter">
      <svg viewBox="0 0 1024 1024" fill="currentColor" aria-hidden="true">
        <path d="M213.752501 517.216385a90.360598 90.360598 0 0 0 2.336192 12.265012 60.490705 60.490705 0 0 0 15.185253 27.366829l3.504289 3.504289L695.759123 1003.895393A65.16309 65.16309 0 0 0 747.071928 1023.753031a63.911558 63.911558 0 0 0 61.825672-66.748364 65.413397 65.413397 0 0 0-20.441686-41.717727L373.197655 516.632336c-1.168096-1.168096-2.336193-1.752145-4.672386-4.088337a20.942299 20.942299 0 0 0 5.256434-2.920241Q581.786292 310.296457 789.62401 110.301671a66.748364 66.748364 0 0 0 21.025735-39.047793c0-0.584048 0.584048-0.584048 0.584048-1.168096l0-13.099366c0-0.584048-0.584048-1.168096-0.584048-2.336193a62.826898 62.826898 0 0 0-47.808516-51.312805l-9.928819-2.336193-14.017157-1e-8c0 0.584048-0.584048 0.584048-1.168096 0.58404901a64.745913 64.745913 0 0 0-40.799937 20.942299c-29.703022 29.118974-60.073527 57.737335-90.360598 86.856308l-369.53563 355.601909a55.317707 55.317707 0 0 0-15.769301 22.694444c-2.920241 8.34354499-5.256434 16.687091-7.592626 24.446588z" />
      </svg>
    </button>
    <button class="side-nav side-nav-next" :class="{ 'hover-only': sideNavHoverOnly }" :disabled="isLast"
      title="下一章 (Alt+→)" aria-label="下一章" @click="nextChapter">
      <svg viewBox="0 0 1024 1024" fill="currentColor" aria-hidden="true">
        <path d="M810.247499 506.783615a90.360598 90.360598 0 0 0-2.336192-12.265012 60.490705 60.490705 0 0 0-15.185253-27.366829l-3.504289-3.504289L328.240877 20.104607A65.16309 65.16309 0 0 0 276.928072 0.246969a63.911558 63.911558 0 0 0-61.825672 66.748364 65.413397 65.413397 0 0 0 20.441686 41.717727L650.802345 507.367664c1.168096 1.168096 2.336193 1.752145 4.672386 4.088337a20.942299 20.942299 0 0 0-5.256434 2.920241Q442.213708 713.703543 234.37599 913.698329a66.748364 66.748364 0 0 0-21.025735 39.047793c0 0.584048-0.584048 0.584048-0.584048 1.168096v13.099366c0 0.584048 0.584048 1.168096 0.584048 2.336193a62.826898 62.826898 0 0 0 47.808516 51.312805l9.928819 2.336193h14.017157c0-0.584048 0.584048-0.584048 1.168096-0.584049a64.745913 64.745913 0 0 0 40.799937-20.942299c29.703022-29.118974 60.073527-57.737335 90.360598-86.856308l369.53563-355.601909a55.317707 55.317707 0 0 0 15.769301-22.694444c2.920241-8.343545 5.256434-16.687091 7.592626-24.446588z" />
      </svg>
    </button>

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
