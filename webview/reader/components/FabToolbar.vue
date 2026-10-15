<script setup lang="ts">
/**
 * FabToolbar.vue — 悬浮球工具栏(上一章 / 目录 / 下一章 / 阅读设置)
 * 拖动/吸附/闲置淡化自包含; 定位与吸附由 App 通过 expose 的方法协调
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { state, gotoChapter } from '../composables/vscode';
import { persistSettings } from '../store';

const IDLE_MS = 3000;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let lastPointerActivate = 0;
let lastFabPressAt = 0;
let fabDragged = false;
let fabPress: {
  pressId: string | null; dragging: boolean;
  startX: number; startY: number; originLeft: number; originTop: number;
} | null = null;

const rootRef = ref<HTMLElement | null>(null);
const fabStyle = reactive({ right: '16px', left: 'auto', top: '50%', transform: 'translateY(-50%)' });

const chapter = computed(() => state.chapter);

function wakeFabs(): void {
  state.fabAwake = true;
  if (idleTimer) { clearTimeout(idleTimer); }
  idleTimer = setTimeout(function () { state.fabAwake = false; }, IDLE_MS);
}

function fabMaxTop(): number {
  const h = (rootRef.value && rootRef.value.offsetHeight) || 240;
  const statusEl = document.querySelector('.statusbar');
  const statusH = statusEl ? statusEl.offsetHeight : 30;
  return Math.max(8, window.innerHeight - h - statusH - 8);
}

function applyFabPosition(pos: { left: number; top: number }): void {
  if (!pos) { return; }
  const maxX = Math.max(0, window.innerWidth - 60);
  fabStyle.left = Math.min(Math.max(0, pos.left), maxX) + 'px';
  fabStyle.top = Math.min(Math.max(0, pos.top), fabMaxTop()) + 'px';
  fabStyle.right = 'auto';
  fabStyle.transform = 'none';
}

function fabLayoutMetrics(): { BALL_W: number; GAP: number; vw: number; contentW: number; gutter: number } {
  const BALL_W = 58;
  const GAP = 12;
  const vw = window.innerWidth;
  const cssW =
    parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--content-width')) || 720;
  const contentW = Math.min(cssW, Math.max(0, vw - 40));
  const gutter = (vw - contentW) / 2;
  return { BALL_W: BALL_W, GAP: GAP, vw: vw, contentW: contentW, gutter: gutter };
}

function snapFabPosition(side: 'left' | 'right', top: number): { left: number; top: number } {
  const m = fabLayoutMetrics();
  const hasRoom = m.gutter >= m.GAP + m.BALL_W + 12;
  let left: number;
  if (side === 'left') {
    left = hasRoom ? m.gutter - m.GAP - m.BALL_W : 16;
  } else {
    left = hasRoom ? m.vw - m.gutter + m.GAP : m.vw - m.BALL_W - 16;
  }
  const maxY = fabMaxTop();
  return {
    left: Math.round(Math.min(Math.max(16, left), m.vw - m.BALL_W - 16)),
    top: Math.round(Math.min(Math.max(8, top), maxY)),
  };
}

function syncFabAnchor(): void {
  if (fabDragged) { return; }
  const m = fabLayoutMetrics();
  let right = m.gutter - m.BALL_W - m.GAP;
  if (!isFinite(right) || right < 12) { right = 12; }
  fabStyle.right = right + 'px';
  fabStyle.left = 'auto';
  const h = (rootRef.value && rootRef.value.offsetHeight) || 240;
  const statusEl = document.querySelector('.statusbar');
  const avail = window.innerHeight - (statusEl ? statusEl.offsetHeight : 30) - 16;
  if (h > avail) {
    fabStyle.top = '8px';
    fabStyle.transform = 'none';
  } else {
    fabStyle.top = '50%';
    fabStyle.transform = 'translateY(-50%)';
  }
}

function resetFabPosition(): void {
  fabDragged = false;
  fabStyle.left = 'auto';
  fabStyle.transform = 'translateY(-50%)';
  syncFabAnchor();
  persistSettings({ fabLeft: -1, fabTop: -1 });
}

function activateFab(id: string): void {
  if (id === 'fabPrev') {
    if (state.chapter) { gotoChapter(state.chapter.index - 1); }
  } else if (id === 'fabNext') {
    if (state.chapter) { gotoChapter(state.chapter.index + 1); }
  } else if (id === 'fabCatalog') {
    state.catalogOpen = !state.catalogOpen;
  } else if (id === 'fabSettings') {
    if (state.settingsOpen) { state.settingsOpen = false; } else { state.settingsOpen = true; }
  }
}

function onPointerdown(e: PointerEvent): void {
  const target = e.target as HTMLElement;
  const btn = target.closest ? target.closest('.fab') : null;
  fabPress = {
    pressId: btn ? btn.id : null,
    dragging: false,
    startX: e.clientX,
    startY: e.clientY,
    originLeft: rootRef.value ? rootRef.value.getBoundingClientRect().left : 0,
    originTop: rootRef.value ? rootRef.value.getBoundingClientRect().top : 0,
  };
  state.fabAwake = true;
  wakeFabs();
}

function onPointermove(e: PointerEvent): void {
  if (!fabPress) { return; }
  const dx = e.clientX - fabPress.startX;
  const dy = e.clientY - fabPress.startY;
  if (!fabPress.dragging) {
    if (Math.abs(dx) <= 3 && Math.abs(dy) <= 3) { return; }
    fabPress.dragging = true;
    state.fabDragging = true;
    if (rootRef.value && rootRef.value.setPointerCapture) {
      try { rootRef.value.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
    }
  }
  e.preventDefault();
  applyFabPosition({ left: fabPress.originLeft + dx, top: fabPress.originTop + dy });
}

function endDrag(): void {
  if (!fabPress) { return; }
  if (fabPress.dragging && rootRef.value) {
    const rect = rootRef.value.getBoundingClientRect();
    const side: 'left' | 'right' = rect.left + rect.width / 2 < window.innerWidth / 2 ? 'left' : 'right';
    const pos = snapFabPosition(side, rect.top);
    applyFabPosition(pos);
    fabDragged = true;
    persistSettings({ fabLeft: pos.left, fabTop: pos.top });
  } else if (fabPress.pressId) {
    // 未移动 -> 视为点击(不依赖 click 事件); 双击恢复默认位置
    lastPointerActivate = Date.now();
    if (lastPointerActivate - lastFabPressAt < 350) {
      lastFabPressAt = 0;
      resetFabPosition();
    } else {
      lastFabPressAt = lastPointerActivate;
      activateFab(fabPress.pressId);
    }
  }
  fabPress = null;
  state.fabDragging = false;
}

function onClick(e: MouseEvent): void {
  // 兜底: 键盘回车/空格触发的 click(指针路径已由 endDrag 处理, 避免重复)
  const target = e.target as HTMLElement;
  const btn = target.closest ? target.closest('.fab') : null;
  if (!btn) { return; }
  if (Date.now() - lastPointerActivate < 600) { return; }
  activateFab(btn.id);
}

onMounted(function () {
  document.addEventListener('mousemove', wakeFabs, { passive: true });
  document.addEventListener('scroll', wakeFabs, { passive: true });
});

defineExpose({
  el: rootRef,
  syncFabAnchor,
  applyFabPosition,
  snapFabPosition,
  isFabDragged: () => fabDragged,
});
</script>

<template>
  <div id="fabs" ref="rootRef" :class="{ awake: state.fabAwake, dragging: state.fabDragging }" :style="fabStyle"
    @pointerdown="onPointerdown" @pointermove="onPointermove" @pointerup="endDrag"
    @pointercancel="endDrag" @click="onClick">
    <button id="fabPrev" class="fab" title="上一章" :class="{ off: !chapter || chapter.index <= 0 }">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
      <span class="fab-label">上一章</span>
    </button>
    <button id="fabCatalog" class="fab" title="目录">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>
      <span class="fab-label">目录</span>
    </button>
    <button id="fabNext" class="fab" title="下一章"
      :class="{ off: !chapter || !state.novel || chapter.index >= state.novel.totalChapters - 1 }">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M19 12l-7 7-7-7"/></svg>
      <span class="fab-label">下一章</span>
    </button>
    <button id="fabSettings" class="fab" title="阅读设置">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7V4h16v3M9 20h6M12 4v16"/></svg>
      <span class="fab-label fab-label-sm">阅读设置</span>
    </button>
  </div>
</template>
