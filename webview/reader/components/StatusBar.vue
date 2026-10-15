<script setup lang="ts">
/**
 * StatusBar.vue — 底部状态栏(整书进度条 + 书名/章/字数)
 */
import { computed } from 'vue';
import { state } from '../composables/vscode';
import { thousand } from '../composables/catalog';

const bookInfoText = computed(function () {
  const n = state.novel;
  if (!n) { return ''; }
  const words = n.totalWords >= 10000 ? (n.totalWords / 10000).toFixed(1) + ' 万字' : n.totalWords + ' 字';
  return n.bookTitle + (n.author ? ' · ' + n.author : '') + ' · 共 ' + n.totalChapters + ' 章 · 约 ' + words;
});

const chapterWordsText = computed(function () {
  const words = state.chapter ? state.chapter.chapterWords : 0;
  return words > 0 ? '本章 ' + thousand(words) + ' 字' : '';
});

const chapterInfoText = computed(function () {
  const total = state.novel ? state.novel.totalChapters : 0;
  const idx = (state.chapter ? state.chapter.index : 0) + 1;
  return total > 0 ? '第 ' + idx + ' 章 / 共 ' + total + ' 章' : '';
});

const chapterTitleText = computed(function () {
  return state.chapter ? state.chapter.title : '';
});

const progressPct = computed(function () {
  const total = state.novel ? state.novel.totalChapters : 0;
  const idx = (state.chapter ? state.chapter.index : 0) + 1;
  return total > 0 ? (idx / total) * 100 : 0;
});
</script>

<template>
  <footer class="statusbar">
    <div class="progress-track"><div class="progress-fill" :style="{ width: progressPct + '%' }"></div></div>
    <div class="status-row">
      <span id="bookInfo">{{ bookInfoText }}</span>
      <span class="spacer"></span>
      <span id="chapterTitle" class="status-title" :title="chapterTitleText">{{ chapterTitleText }}</span>
      <span class="spacer"></span>
      <span id="chapterWords">{{ chapterWordsText }}</span>
      <span id="chapterInfo">{{ chapterInfoText }}</span>
    </div>
  </footer>
</template>
