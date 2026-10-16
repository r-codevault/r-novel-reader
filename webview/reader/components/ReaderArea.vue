<script setup lang="ts">
/**
 * ReaderArea.vue — 正文阅读区(留白 + 纸面 + 左右宽度拖拽手柄)
 * 宽度拖拽与手柄定位自包含; resize 对齐由 App 调用 positionHandles()
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { state, gotoChapter } from '../composables/vscode';
import { persistSettings } from '../store';

// 与 settings.ts 的 contentWidth clamp 范围一致
const WIDTH_MIN = 480;
const WIDTH_MAX = 1200;

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

function prevChapter(): void {
  if (state.chapter && !isFirst.value) { gotoChapter(state.chapter.index - 1); }
}
function nextChapter(): void {
  if (state.chapter && !isLast.value) { gotoChapter(state.chapter.index + 1); }
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
  // 左缘向右拖 → 变窄; 右缘向右拖 → 变宽; 上限 1200 拖拽过程即实时回弹
  const factor = widthDrag.side === 'left' ? -1 : 1;
  const next = Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, Math.round(widthDrag.startW + factor * delta)));
  document.documentElement.style.setProperty('--content-width', next + 'px');
  positionHandles();
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
    persistSettings({ contentWidth: Math.round(finalW) });
  }
  widthDrag = null;
}

onMounted(function () {
  document.addEventListener('pointermove', function (e: PointerEvent) { moveWidthDrag(e); });
  document.addEventListener('pointerup', function (e: PointerEvent) { endWidthDrag(e); });
  document.addEventListener('pointercancel', function (e: PointerEvent) { endWidthDrag(e); });
  window.addEventListener('resize', positionHandles);
  requestAnimationFrame(positionHandles);
});

defineExpose({ positionHandles });
</script>

<template>
  <main id="reader" ref="readerRef" :class="{ 'resizing-width': resizingWidth }">
    <article id="content" ref="contentRef">
      <h2 class="chapter-title">{{ chapter ? chapter.title : '' }}</h2>
      <p v-if="paras.length === 0" class="empty-tip">(本章无内容)</p>
      <p v-for="(p, i) in paras" :key="i">{{ p }}</p>
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
