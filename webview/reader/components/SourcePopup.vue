<script setup lang="ts">
/**
 * SourcePopup.vue — 书源面板外壳(搜索 / 管理 两个视图)
 *
 * 与其它弹窗一致: 无 props, 靠 state.sourceOpen 控制显隐,
 * 互斥由 App.vue 的 popupKeys 统一收敛。
 */
import { computed, ref, watch } from 'vue';
import { send, state } from '../composables/vscode';
import { enabledSources } from '../composables/sourceView';
import SourceSearchView from './SourceSearchView.vue';
import SourceManageView from './SourceManageView.vue';

const rootRef = ref<HTMLElement | null>(null);
defineExpose({ el: rootRef });

const enabledCount = computed(function () { return enabledSources(state.sources).length; });

// 每次打开: 拉最新列表 + 回到搜索视图(管理是次级入口)
watch(function () { return state.sourceOpen; }, function (open) {
  if (!open) { return; }
  send({ type: 'requestSources' });
  state.sourceView = 'search';
});
</script>

<template>
  <section id="sourcePopup" ref="rootRef" class="popup" :class="{ open: state.sourceOpen }">
    <div class="popup-head">
      <b class="popup-title">书源</b>
      <span class="popup-sub">{{ enabledCount }} / {{ state.sources.length }} 个启用</span>
      <span class="spacer"></span>
      <button class="popup-close" title="关闭" @click="state.sourceOpen = false">✕</button>
    </div>
    <div class="src-tabs">
      <button class="src-tab" :class="{ on: state.sourceView === 'search' }" data-src-tab="search"
        @click="state.sourceView = 'search'">搜索</button>
      <button class="src-tab" :class="{ on: state.sourceView === 'manage' }" data-src-tab="manage"
        @click="state.sourceView = 'manage'">书源管理</button>
    </div>
    <SourceSearchView v-if="state.sourceView === 'search'" />
    <SourceManageView v-else />
  </section>
</template>
