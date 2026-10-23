<script setup lang="ts">
/**
 * SourcePopup.vue — 书源面板外壳(搜索 / 书源 / 失效 三个 Tab)
 *
 * 与其它弹窗一致: 无 props, 靠 state.sourceOpen 控制显隐, 互斥由 App.vue 统一收敛。
 */
import { computed, ref, watch } from 'vue';
import { send, state } from '../composables/vscode';
import { deadSources, searchableSources } from '../composables/sourceView';
import SourceSearchView from './SourceSearchView.vue';
import SourceManageView from './SourceManageView.vue';
import SourceDeadView from './SourceDeadView.vue';

const rootRef = ref<HTMLElement | null>(null);
defineExpose({ el: rootRef });

const searchableCount = computed(function () { return searchableSources(state.sources).length; });
const deadCount = computed(function () { return deadSources(state.sources).length; });

// 每次打开: 拉最新列表 + 回到搜索视图(管理/失效是次级入口)
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
      <span class="popup-sub">
        {{ searchableCount }} 个可搜<template v-if="deadCount"> · {{ deadCount }} 个失效</template>
      </span>
      <span class="spacer"></span>
      <button class="popup-close" title="关闭" @click="state.sourceOpen = false">✕</button>
    </div>
    <div class="src-tabs">
      <button class="src-tab" :class="{ on: state.sourceView === 'search' }" data-src-tab="search"
        @click="state.sourceView = 'search'">搜索</button>
      <button class="src-tab" :class="{ on: state.sourceView === 'manage' }" data-src-tab="manage"
        @click="state.sourceView = 'manage'">书源</button>
      <button class="src-tab" :class="{ on: state.sourceView === 'dead' }" data-src-tab="dead"
        @click="state.sourceView = 'dead'">
        失效<span v-if="deadCount" class="src-tab-num" data-src-dead-count>{{ deadCount }}</span>
      </button>
    </div>
    <SourceSearchView v-if="state.sourceView === 'search'" />
    <SourceManageView v-else-if="state.sourceView === 'manage'" />
    <SourceDeadView v-else />
  </section>
</template>
