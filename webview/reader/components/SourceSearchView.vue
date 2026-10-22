<script setup lang="ts">
/**
 * SourceSearchView.vue — 书源搜索(关键词 + 书源多选 + 结果列表)
 *
 * 一期只做「搜索」: 加入书架/下载在下一版接入在线阅读链路,
 * 按钮先置灰并说明原因, 避免给出会失败的入口。
 */
import { computed, ref } from 'vue';
import { send, state } from '../composables/vscode';
import { enabledSources, resultMeta, resultSummary, selectedSourcesText, sourceLabel } from '../composables/sourceView';

const inputRef = ref<HTMLInputElement | null>(null);
defineExpose({ el: inputRef });

const sources = computed(function () { return enabledSources(state.sources); });
const noSource = computed(function () { return state.sources.length === 0; });
const noEnabled = computed(function () { return state.sources.length > 0 && sources.value.length === 0; });

function isPicked(id: string): boolean {
  return state.searchSourceIds.indexOf(id) >= 0;
}

function pickAll(): void {
  state.searchSourceIds = [];
}

function togglePick(id: string): void {
  const idx = state.searchSourceIds.indexOf(id);
  if (idx >= 0) {
    state.searchSourceIds.splice(idx, 1);
  } else {
    state.searchSourceIds.push(id);
  }
}

function doSearch(): void {
  const key = state.searchKeyword.trim();
  if (!key || state.searching) { return; }
  state.searching = true;
  state.searchDone = false;
  state.searchResults = [];
  state.searchErrors = [];
  state.searchToken += 1;
  send({
    type: 'sourceSearch',
    key,
    sourceIds: state.searchSourceIds.length ? state.searchSourceIds.slice() : undefined,
    token: state.searchToken,
  });
}

function openManage(): void {
  state.sourceView = 'manage';
}

function addToShelf(item: { title: string; sourceName: string }): void {
  // 二期接入在线阅读后改为真正入架; 现在只给出明确提示
  void item;
  state.searchKeyword = state.searchKeyword;
}
</script>

<template>
  <div class="popup-body">
    <div class="src-search">
      <input ref="inputRef" v-model="state.searchKeyword" class="src-input" type="text"
        placeholder="输入书名或作者, 回车搜索" data-src-input @keydown.enter="doSearch" />
      <button class="src-go" :disabled="state.searching" data-src-go @click="doSearch">
        {{ state.searching ? '搜索中…' : '搜索' }}
      </button>
    </div>

    <!-- 书源多选: 全部启用 / 逐个勾选 -->
    <div v-if="!noSource" class="src-picks">
      <button class="src-chip" :class="{ on: state.searchSourceIds.length === 0 }" data-src-all @click="pickAll">
        全部启用
      </button>
      <button v-for="s in sources" :key="s.id" class="src-chip" :class="{ on: isPicked(s.id) }"
        :title="s.name" @click="togglePick(s.id)">{{ s.name }}</button>
    </div>
    <div class="src-picked">{{ selectedSourcesText(state.searchSourceIds, state.sources) }}</div>

    <div v-if="noSource" class="popup-empty src-empty">
      <p>还没有导入书源。</p>
      <button class="popup-primary" data-src-open-manage @click="openManage">去导入书源</button>
    </div>
    <div v-else-if="noEnabled" class="popup-empty src-empty">
      <p>所有书源都已停用。</p>
      <button class="popup-primary" @click="openManage">去启用</button>
    </div>

    <template v-else>
      <div v-if="state.searching" class="src-hint">正在搜索 {{ sources.length }} 个书源…</div>
      <div v-else-if="state.searchDone" class="src-hint">
        {{ resultSummary(state.searchResults, state.searchErrors.length) }}
      </div>

      <div v-if="state.searchErrors.length" class="src-errors">
        <div v-for="(e, i) in state.searchErrors" :key="i" class="src-error">
          <b>{{ e.sourceName || '搜索' }}</b>
          <span>{{ e.message }}</span>
        </div>
      </div>

      <div v-for="(item, i) in state.searchResults" :key="item.bookUrl + i" class="src-result" :data-src-result="i">
        <div class="src-result-main">
          <div class="src-result-title">{{ item.title }}</div>
          <div class="src-result-meta">{{ resultMeta(item) }}</div>
        </div>
        <div class="src-result-side">
          <span class="src-badge">{{ sourceLabel(item) }}</span>
          <button class="popup-btn src-add" disabled title="在线阅读将在下一版本接入" @click="addToShelf(item)">
            加入书架
          </button>
        </div>
      </div>
    </template>
  </div>
</template>
