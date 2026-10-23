<script setup lang="ts">
/**
 * SourceSearchView.vue — 书源搜索
 *
 * 搜索范围 = 「书源」Tab 里勾选启用、且未失效的书源(选源统一在那边设置)。
 * 搜索结果里的报错只做一行摘要；连续 2 次失败的源会自动进入「失效」Tab。
 */
import { computed, ref } from 'vue';
import { send, state } from '../composables/vscode';
import { deadSources, failedNames, resultMeta, resultSummary, searchableSources, sourceLabel } from '../composables/sourceView';

const inputRef = ref<HTMLInputElement | null>(null);
defineExpose({ el: inputRef });

const searchable = computed(function () { return searchableSources(state.sources); });
const deadCount = computed(function () { return deadSources(state.sources).length; });
const noSource = computed(function () { return state.sources.length === 0; });
const noSearchable = computed(function () { return state.sources.length > 0 && searchable.value.length === 0; });
const errorNames = computed(function () {
  return failedNames(state.searchErrors.map(function (e) { return e.sourceName; }));
});

function doSearch(): void {
  const key = state.searchKeyword.trim();
  if (!key || state.searching) { return; }
  state.searching = true;
  state.searchDone = false;
  state.searchResults = [];
  state.searchErrors = [];
  state.searchSkipped = 0;
  state.searchToken += 1;
  send({ type: 'sourceSearch', key, token: state.searchToken });
}

function goManage(): void {
  state.sourceView = 'manage';
}

function goDead(): void {
  state.sourceView = 'dead';
}
</script>

<template>
  <div class="popup-body">
    <div class="src-search">
      <input ref="inputRef" v-model="state.searchKeyword" class="src-input" type="text"
        placeholder="输入书名或作者, 回车搜索" data-src-input @keydown.enter="doSearch" />
      <button class="src-go" :disabled="state.searching || noSearchable" data-src-go @click="doSearch">
        {{ state.searching ? '搜索中…' : '搜索' }}
      </button>
    </div>

    <div v-if="noSource" class="popup-empty src-empty">
      <p>还没有导入书源。</p>
      <button class="popup-primary" data-src-open-manage @click="goManage">去导入书源</button>
    </div>
    <div v-else-if="noSearchable" class="popup-empty src-empty">
      <p v-if="deadCount">没有可用的书源（{{ deadCount }} 个已失效）。</p>
      <p v-else>所有书源都已停用。</p>
      <div class="src-empty-acts">
        <button class="popup-primary" data-src-go-manage @click="goManage">去「书源」勾选启用</button>
        <button v-if="deadCount" class="popup-btn" data-src-go-dead @click="goDead">查看失效书源</button>
      </div>
    </div>

    <template v-else>
      <div v-if="state.searching" class="src-hint">正在搜索 {{ searchable.length }} 个书源…</div>
      <div v-else-if="state.searchDone" class="src-hint">
        {{ resultSummary(state.searchResults, state.searchErrors.length) }}
        <span v-if="state.searchSkipped > 0" class="src-skip">（另有 {{ state.searchSkipped }} 个书源未参与: 单次最多搜 100 个）</span>
      </div>

      <div v-if="state.searchErrors.length" class="src-errors" data-src-errors>
        <span class="src-error-line">
          {{ state.searchErrors.length }} 个书源搜索失败{{ errorNames }}；连续 2 次失败将标记失效
        </span>
        <button class="src-link" data-src-error-dead @click="goDead">查看失效书源</button>
      </div>

      <div v-for="(item, i) in state.searchResults" :key="item.bookUrl + i" class="src-result" :data-src-result="i">
        <div class="src-result-main">
          <div class="src-result-title">{{ item.title }}</div>
          <div class="src-result-meta">{{ resultMeta(item) }}</div>
        </div>
        <div class="src-result-side">
          <span class="src-badge">{{ sourceLabel(item) }}</span>
          <button class="popup-btn src-add" disabled title="在线阅读将在下一版本接入">加入书架</button>
        </div>
      </div>
    </template>
  </div>
</template>
