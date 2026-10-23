<script setup lang="ts">
/**
 * HistoryPopup.vue — 阅读历史(本地 / 在线分栏, 各最多 1000 本, 列表 15 行滚动)
 */
import { computed, ref, watch } from 'vue';
import { send, state } from '../composables/vscode';
import type { HistoryItemView } from '../composables/vscode';
import { flushProgress } from '../store';

const rootRef = ref<HTMLElement | null>(null);
defineExpose({ el: rootRef });

const list = computed(function () { return state.history[state.historyTab] || []; });
const total = computed(function () {
  return (state.history.local ? state.history.local.length : 0)
    + (state.history.online ? state.history.online.length : 0);
});

function tabCount(kind: 'local' | 'online'): number {
  return state.history[kind] ? state.history[kind].length : 0;
}

function progress(e: HistoryItemView): string {
  if (e.chapterIndex < 0) { return '未开始'; }
  return '读至 第 ' + (e.chapterIndex + 1) + ' 章'
    + (e.totalChapters ? ' / 共 ' + e.totalChapters + ' 章' : '');
}

function timeText(ts: number): string {
  if (!ts) { return ''; }
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (sameDay) { return '今天 ' + hh + ':' + mm; }
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (d.getFullYear() === yesterday.getFullYear()
    && d.getMonth() === yesterday.getMonth() && d.getDate() === yesterday.getDate()) {
    return '昨天 ' + hh + ':' + mm;
  }
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-'
    + String(d.getDate()).padStart(2, '0');
}

function openBook(e: HistoryItemView): void {
  if (!e.filePath) { return; }
  flushProgress();
  send({ type: 'openBook', filePath: e.filePath });
  state.historyOpen = false;
}

watch(function () { return state.historyOpen; }, function (open) {
  if (open) { send({ type: 'requestHistory' }); }
});
</script>

<template>
  <section id="historyPopup" ref="rootRef" class="popup" :class="{ open: state.historyOpen }">
    <div class="popup-head">
      <b class="popup-title">历史记录</b>
      <span class="popup-sub">共 {{ total }} 本</span>
      <span class="spacer"></span>
      <button class="popup-close" @click="state.historyOpen = false">关闭</button>
    </div>

    <div class="hist-tabs">
      <button class="hist-tab" :class="{ on: state.historyTab === 'local' }" data-hist-tab="local"
        @click="state.historyTab = 'local'">本地 {{ tabCount('local') }}</button>
      <button class="hist-tab" :class="{ on: state.historyTab === 'online' }" data-hist-tab="online"
        @click="state.historyTab = 'online'">在线 {{ tabCount('online') }}</button>
    </div>

    <div class="hist-list" data-hist-list>
      <div v-if="!list.length" class="popup-empty">
        {{ state.historyTab === 'local' ? '还没有本地阅读记录。' : '还没有在线书阅读记录。' }}
      </div>
      <div v-for="e in list" :key="e.kind + ':' + e.filePath" class="hist-row" :data-hist-path="e.filePath"
        :title="e.title" @click="openBook(e)">
        <span class="bk-tag">{{ e.kind === 'online' ? '在线' : '本地' }}</span>
        <span class="hist-main">
          <span class="hist-title">{{ e.title }}</span>
          <span class="hist-meta">{{ progress(e) }}{{ e.author ? ' · ' + e.author : '' }}</span>
        </span>
        <span class="hist-time">{{ timeText(e.lastReadAt) }}</span>
      </div>
    </div>

    <div class="hist-foot">本地 / 在线各保留最近 1000 本 · 列表 15 行内滚动</div>
  </section>
</template>
