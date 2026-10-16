<script setup lang="ts">
/**
 * ShelfPopup.vue — 书架弹窗(书籍列表 / 打开 / 移除 / 添加)
 * 弹窗互斥由 App 统一保证
 */
import { computed, ref } from 'vue';
import { state, send, type ShelfItemView } from '../composables/vscode';

const rootRef = ref<HTMLElement | null>(null);
defineExpose({ el: rootRef });

const shelfHas = computed(function () { return state.shelf.length > 0; });

function progress(b: ShelfItemView): string {
  return b.chapterIndex >= 0
    ? '读至 第 ' + (b.chapterIndex + 1) + ' 章' + (b.totalChapters ? ' / 共 ' + b.totalChapters + ' 章' : '')
    : b.totalChapters
      ? '共 ' + b.totalChapters + ' 章 · 未开始'
      : '未开始阅读';
}

function onBookClick(b: ShelfItemView, ev: MouseEvent): void {
  const target = ev.target as HTMLElement;
  if (target.closest && target.closest('.bp-del')) {
    ev.stopPropagation();
    // 乐观移除: 立即从本地列表删掉该行(即时反馈);
    // 扩展侧确认后(二次确认框)会推送权威列表, 失败则会自动"弹回"
    state.shelf = state.shelf.filter(function (x) { return x.filePath !== b.filePath; });
    send({ type: 'removeBook', filePath: b.filePath });
    return;
  }
  send({ type: 'openBook', filePath: b.filePath });
  state.shelfOpen = false;
}

function addBook(): void {
  send({ type: 'openFile' });
  state.shelfOpen = false;
}
</script>

<template>
  <section id="shelfPopup" ref="rootRef" class="popup" :class="{ open: state.shelfOpen }">
    <div class="popup-head">
      <b class="popup-title">书架</b>
      <span class="popup-sub" v-show="shelfHas">共 {{ state.shelf.length }} 本 · 进度自动记录</span>
      <span class="spacer"></span>
      <button class="popup-close" @click="state.shelfOpen = false">关闭</button>
    </div>
    <div class="popup-body">
      <div v-if="!shelfHas" class="popup-empty">书架空空如也。</div>
      <div v-for="b in state.shelf" :key="b.filePath" class="bk" :class="{ cur: b.current }"
        :title="b.title" @click="onBookClick(b, $event)">
        <span class="bk-main">
          <span class="bk-title">{{ b.title }}</span>
          <span class="bk-sub">{{ progress(b) }}{{ b.author ? ' · ' + b.author : '' }}</span>
        </span>
        <span class="bp-del" title="从书架移除">✕</span>
      </div>
    </div>
    <div class="popup-foot">
      <button class="popup-primary" title="添加本地 txt 小说" @click="addBook">＋ 添加书籍</button>
    </div>
  </section>
</template>
