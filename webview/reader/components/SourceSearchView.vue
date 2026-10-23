<script setup lang="ts">
/**
 * SourceSearchView.vue — 书源搜索(关键词 + 书源选择 + 结果列表)
 *
 * 书源可能上千条: 内联只展示前若干个 + 「选择书源…」独立弹窗
 * (搜索过滤 / 全选 / 反选 / 清空 / 已选计数)。
 * 一期只做搜索: 加入书架/下载在后续版本接入, 按钮先置灰并说明原因。
 */
import { computed, ref } from 'vue';
import { send, state } from '../composables/vscode';
import { enabledSources, resultMeta, resultSummary, selectedSourcesText, sourceLabel } from '../composables/sourceView';

const inputRef = ref<HTMLInputElement | null>(null);
defineExpose({ el: inputRef });

/** 内联最多展示多少个 chip(再多就只走选择弹窗) */
const INLINE_LIMIT = 10;
const PICKER_PAGE = 80;
const pickerLimit = ref(PICKER_PAGE);

const sources = computed(function () { return enabledSources(state.sources); });
const inlineSources = computed(function () { return sources.value.slice(0, INLINE_LIMIT); });
const noSource = computed(function () { return state.sources.length === 0; });
const noEnabled = computed(function () { return state.sources.length > 0 && sources.value.length === 0; });
const selectedCount = computed(function () { return state.searchSourceIds.length; });

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
  state.searchSkipped = 0;
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

// ---------------------------------------------------------------- 选择书源弹窗
const pickerFiltered = computed(function () {
  const k = state.sourcePickerFilter.replace(/\s+/g, '').toLowerCase();
  if (!k) { return sources.value; }
  return sources.value.filter(function (s) {
    return (s.name + '|' + s.group + '|' + s.url).replace(/\s+/g, '').toLowerCase().indexOf(k) >= 0;
  });
});
const pickerVisible = computed(function () { return pickerFiltered.value.slice(0, pickerLimit.value); });

function openPicker(): void {
  state.sourcePickerDraft = state.searchSourceIds.slice();
  state.sourcePickerFilter = '';
  pickerLimit.value = PICKER_PAGE;
  state.sourcePickerOpen = true;
}

function closePicker(): void {
  state.sourcePickerOpen = false;
}

function pickerHas(id: string): boolean {
  return state.sourcePickerDraft.indexOf(id) >= 0;
}

function pickerToggle(id: string): void {
  const idx = state.sourcePickerDraft.indexOf(id);
  if (idx >= 0) { state.sourcePickerDraft.splice(idx, 1); }
  else { state.sourcePickerDraft.push(id); }
}

function pickerSelectAll(): void {
  state.sourcePickerDraft = pickerFiltered.value.map(function (s) { return s.id; });
}

function pickerInvert(): void {
  const all = pickerFiltered.value.map(function (s) { return s.id; });
  const set = new Set(state.sourcePickerDraft);
  state.sourcePickerDraft = all.filter(function (id) { return !set.has(id); });
}

function pickerClear(): void {
  state.sourcePickerDraft = [];
}

function pickerConfirm(): void {
  state.searchSourceIds = state.sourcePickerDraft.slice();
  state.sourcePickerOpen = false;
}

function loadMore(): void {
  pickerLimit.value += PICKER_PAGE;
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

    <!-- 书源选择: 少量内联, 大量走独立弹窗 -->
    <div v-if="!noSource && !noEnabled" class="src-picks-bar">
      <button class="src-chip" :class="{ on: selectedCount === 0 }" data-src-all @click="pickAll">
        全部启用
      </button>
      <div class="src-picks">
        <button v-for="s in inlineSources" :key="s.id" class="src-chip" :class="{ on: isPicked(s.id) }"
          :title="s.name" @click="togglePick(s.id)">{{ s.name }}</button>
      </div>
      <button class="src-more" data-src-picker @click="openPicker">
        {{ selectedCount ? '已选 ' + selectedCount + ' 个 · 修改' : '选择书源…' }}
      </button>
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
      <div v-if="state.searching" class="src-hint">正在搜索 {{ selectedCount || sources.length }} 个书源…</div>
      <div v-else-if="state.searchDone" class="src-hint">
        {{ resultSummary(state.searchResults, state.searchErrors.length) }}
        <span v-if="state.searchSkipped > 0" class="src-skip">（另有 {{ state.searchSkipped }} 个书源未参与: 单次最多搜 100 个）</span>
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
          <button class="popup-btn src-add" disabled title="在线阅读将在下一版本接入">加入书架</button>
        </div>
      </div>
    </template>
  </div>

  <!-- 书源选择弹窗: 必须放在 .popup-body 之外(否则会被其 overflow 裁剪) -->
  <div v-if="state.sourcePickerOpen" class="src-picker" data-src-picker-modal @click.self="closePicker">
      <div class="src-picker-card">
        <div class="src-picker-head">
          <b>选择搜索书源</b>
          <span class="src-picker-count">已选 {{ state.sourcePickerDraft.length }} / 共 {{ sources.length }}</span>
          <span class="spacer"></span>
          <button class="popup-close" title="关闭" @click="closePicker">✕</button>
        </div>
        <div class="src-picker-tools">
          <input v-model="state.sourcePickerFilter" class="src-input" type="text" placeholder="筛选书源"
            data-src-picker-filter />
          <button class="popup-btn" data-src-picker-all @click="pickerSelectAll">全选</button>
          <button class="popup-btn" data-src-picker-invert @click="pickerInvert">反选</button>
          <button class="popup-btn" data-src-picker-clear @click="pickerClear">清空</button>
        </div>
        <div class="src-picker-list">
          <label v-for="s in pickerVisible" :key="s.id" class="src-picker-row" :data-src-picker-row="s.id">
            <input type="checkbox" :checked="pickerHas(s.id)" @change="pickerToggle(s.id)" />
            <span class="src-picker-name" :title="s.name">{{ s.name }}</span>
            <span v-if="s.group" class="src-picker-group">{{ s.group }}</span>
          </label>
          <button v-if="pickerFiltered.length > pickerVisible.length" class="popup-btn src-picker-more"
            data-src-picker-more @click="loadMore">
            加载更多（还有 {{ pickerFiltered.length - pickerVisible.length }} 个）
          </button>
          <div v-else-if="!pickerFiltered.length" class="popup-empty">没有匹配的书源</div>
        </div>
      <div class="src-picker-foot">
        <button class="popup-primary" data-src-picker-ok @click="pickerConfirm">确定</button>
        <button class="popup-btn" @click="closePicker">取消</button>
      </div>
    </div>
  </div>
</template>
