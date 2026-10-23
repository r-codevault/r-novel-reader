<script setup lang="ts">
/**
 * SourceSearchView.vue — 书源搜索
 *
 * 搜索范围 = 「书源」Tab 里勾选启用、且未失效的书源。
 * 结果区上下分栏：本次结果 / 历史搜索(上一次)；分隔条可按行拖动。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { send, state } from '../composables/vscode';
import {
  allocResultRows, deadSources, failedNames, resultMeta, resultSummary,
  searchableSources, sourceLabel,
} from '../composables/sourceView';

const inputRef = ref<HTMLInputElement | null>(null);
defineExpose({ el: inputRef });

const searchable = computed(function () { return searchableSources(state.sources); });
const deadCount = computed(function () { return deadSources(state.sources).length; });
const noSource = computed(function () { return state.sources.length === 0; });
const noSearchable = computed(function () { return state.sources.length > 0 && searchable.value.length === 0; });
const progressPercent = computed(function () {
  const p = state.searchProgress;
  if (!p || !p.total) { return 0; }
  return Math.min(100, Math.round((p.done / p.total) * 100));
});
const errorNames = computed(function () {
  return failedNames(state.searchErrors.map(function (e) { return e.sourceName; }));
});

/** 历史搜索(仅上一次) */
const hasHistory = computed(function () {
  return !!state.searchHistory && state.searchHistory.items.length > 0;
});
const alloc = computed(function () {
  return allocResultRows(
    state.searchResults.length,
    state.searchHistory ? state.searchHistory.items.length : 0,
    hasHistory.value,
    state.splitCurrentRows
  );
});

/** 是否已加入在线书架(本次会话内) */
function isAdded(item: { bookUrl: string }): boolean {
  return state.onlineAdded.indexOf(item.bookUrl) >= 0;
}

/** 点击结果行: 临时预览阅读(不加入书架) */
function previewBook(item: { sourceName?: string } & Record<string, unknown>): void {
  send({ type: 'previewOnlineBook', item });
  state.sourceOpen = false;
}

function addOnline(item: { bookUrl: string }): void {
  if (isAdded(item)) { return; }
  send({ type: 'addOnlineBook', item });
}

function doSearch(): void {
  const key = state.searchKeyword.trim();
  if (!key || state.searching) { return; }

  // 上一次的结果归档为「历史搜索」(同词重搜不覆盖, 空结果不覆盖)
  if (state.searchResults.length > 0 && state.searchKey && state.searchKey !== key) {
    state.searchHistory = {
      key: state.searchKey,
      items: state.searchResults.slice(),
      errors: state.searchErrors.slice(),
    };
  }

  state.searchKey = key;
  state.searching = true;
  state.searchDone = false;
  state.searchCancelled = false;
  state.searchResults = [];
  state.searchErrors = [];
  state.searchSkipped = 0;
  state.searchDeadAdded = 0;
  state.searchProgress = null;
  state.searchPaused = false;
  state.splitCurrentRows = null;
  state.searchToken += 1;
  send({ type: 'sourceSearch', key, token: state.searchToken });
}

/**
 * 取消本轮: 停止发请求, 丢弃迟到的回包, 但保留已搜到的结果。
 * (取消后 token+1, 旧结果回包会被 token 校验挡掉)
 */
function cancelSearch(): void {
  if (!state.searching) { return; }
  send({ type: 'sourceSearchCancel', token: state.searchToken });
  state.searchToken += 1;
  state.searching = false;
  state.searchPaused = false;
  state.searchProgress = null;
  state.searchDone = false;
  state.searchCancelled = true;
  state.searchSkipped = 0;
  state.searchDeadAdded = 0;
}

/** 搜索中/暂停时改写关键词 -> 取消本轮, 回到未搜索状态(结果保留) */
watch(function () { return state.searchKeyword; }, function (v) {
  if (state.searching && v.trim() !== state.searchKey) { cancelSearch(); }
});

/** 暂停/继续: 只影响"是否启动新源", 已在途的会完成 */
function togglePause(): void {
  if (!state.searching) { return; }
  state.searchPaused = !state.searchPaused;
  send({ type: 'sourceSearchPause', token: state.searchToken, paused: state.searchPaused });
}

// ---------------------------------------------------------------- 分隔条拖动
const dragging = ref(false);
let splitDrag: { startY: number; startRows: number; handle: HTMLElement; pointerId?: number } | null = null;

function rowPx(): number {
  const pop = document.getElementById('sourcePopup');
  const raw = pop ? getComputedStyle(pop).getPropertyValue('--src-result-h') : '';
  const v = parseFloat(raw || '');
  return isFinite(v) && v > 0 ? v : 44;
}

function beginSplit(e: PointerEvent): void {
  if (e.button !== 0) { return; }
  const handle = e.currentTarget as HTMLElement | null;
  if (!handle) { return; }
  e.preventDefault();
  splitDrag = {
    startY: e.clientY,
    startRows: alloc.value.curAlloc,
    handle,
    pointerId: e.pointerId,
  };
  dragging.value = true;
  if (typeof handle.setPointerCapture === 'function' && e.pointerId !== undefined) {
    try { handle.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
  }
  document.body.style.userSelect = 'none';
  document.body.style.cursor = 'row-resize';
}

function moveSplit(e: PointerEvent): void {
  if (!splitDrag) { return; }
  const delta = Math.round((e.clientY - splitDrag.startY) / rowPx());
  state.splitCurrentRows = splitDrag.startRows + delta;
}

function endSplit(): void {
  if (!splitDrag) { return; }
  const handle = splitDrag.handle;
  if (typeof handle.releasePointerCapture === 'function' && splitDrag.pointerId !== undefined) {
    try { handle.releasePointerCapture(splitDrag.pointerId); } catch { /* 忽略 */ }
  }
  document.body.style.userSelect = '';
  document.body.style.cursor = '';
  dragging.value = false;
  splitDrag = null;
}

/** 键盘: 上下各挪一行 */
function onSplitKey(e: KeyboardEvent): void {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') { return; }
  e.preventDefault();
  const delta = e.key === 'ArrowDown' ? 1 : -1;
  const cap = 10;
  const next = Math.max(1, Math.min(cap, alloc.value.curAlloc + delta));
  state.splitCurrentRows = next;
}

onMounted(function () {
  document.addEventListener('pointermove', moveSplit);
  document.addEventListener('pointerup', endSplit);
  document.addEventListener('pointercancel', endSplit);
});

onBeforeUnmount(function () {
  document.removeEventListener('pointermove', moveSplit);
  document.removeEventListener('pointerup', endSplit);
  document.removeEventListener('pointercancel', endSplit);
  // 卸载时把拖拽残留状态收干净(分隔条 v-if 消失时 pointerup 可能收不到)
  if (splitDrag) {
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    splitDrag = null;
    dragging.value = false;
  }
});

function goManage(): void {
  state.sourceView = 'manage';
}

function goDead(): void {
  state.sourceView = 'dead';
}
</script>

<template>
  <div class="popup-body src-search-body">
    <div class="src-search">
      <input ref="inputRef" v-model="state.searchKeyword" class="src-input" type="text"
        placeholder="输入书名或作者, 回车搜索" data-src-input @keydown.enter="doSearch" />
      <button class="src-go" :disabled="state.searching || noSearchable" data-src-go @click="doSearch">
        {{ state.searching ? '搜索中…' : '搜索' }}
      </button>
      <button v-if="state.searching" class="src-pause" data-src-pause @click="togglePause">
        {{ state.searchPaused ? '继续' : '暂停' }}
      </button>
      <button v-if="state.searching" class="src-cancel" data-src-cancel @click="cancelSearch">取消</button>
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
      <div v-if="state.searching" class="src-hint src-progress" data-src-progress>
        <template v-if="state.searchProgress">
          <span class="src-progress-prefix">{{ state.searchPaused ? '已暂停' : '正在搜索' }}</span>
          <span class="src-progress-count">{{ state.searchProgress.done }}/{{ state.searchProgress.total }}</span>
          <span class="src-progress-name" :title="state.searchProgress.sourceName">刚完成 {{ state.searchProgress.sourceName }}</span>
          <span :class="state.searchProgress.ok ? 'src-ok' : 'src-bad'">{{ state.searchProgress.ok ? '✓' : '✗' }}</span>
          <span v-if="state.searchProgress.failed > 0" class="src-skip src-progress-fail">失败 {{ state.searchProgress.failed }}</span>
        </template>
        <template v-else>
          <span class="src-progress-prefix">正在准备搜索…</span>
        </template>
        <span class="src-found" data-src-found>已找到 {{ state.searchResults.length }} 本</span>
      </div>
      <div v-if="state.searching && state.searchProgress" class="src-bar" data-src-bar>
        <i :style="{ width: progressPercent + '%' }"></i>
      </div>
      <div v-else-if="state.searchDone" class="src-hint">
        {{ resultSummary(state.searchResults, state.searchErrors.length) }}
        <span v-if="state.searchDeadAdded > 0" class="src-skip">· {{ state.searchDeadAdded }} 个源失败已移入失效</span>
        <span v-if="state.searchSkipped > 0" class="src-skip">（另有 {{ state.searchSkipped }} 个书源未参与）</span>
      </div>

      <div v-if="state.searchDone && state.searchErrors.length" class="src-errors" data-src-errors>
        <span class="src-error-line">
          {{ state.searchErrors.length }} 个书源搜索失败{{ errorNames }}；失败的源已移入失效
        </span>
        <button class="src-link" data-src-error-dead @click="goDead">查看失效书源</button>
      </div>

      <div class="src-results" data-src-results>
        <div class="src-pane src-pane-current" data-src-pane="current"
          :style="{ maxHeight: alloc.curRender * 44 + 'px' }">
          <div v-for="(item, i) in state.searchResults" :key="item.bookUrl + i" class="src-result"
            :data-src-result="i" :title="'点击预览: ' + item.title" @click="previewBook(item)">
            <div class="src-result-main">
              <div class="src-result-title">{{ item.title }}</div>
              <div class="src-result-meta">{{ resultMeta(item) }}</div>
            </div>
            <div class="src-result-side">
              <span class="src-badge">{{ sourceLabel(item) }}</span>
              <button class="popup-btn src-add" :class="{ added: isAdded(item) }" :disabled="isAdded(item)"
                :title="isAdded(item) ? '已在书架' : '加入在线书架'" @click.stop="addOnline(item)">
                {{ isAdded(item) ? '已加入' : '加入书架' }}
              </button>
            </div>
          </div>
        </div>

        <template v-if="hasHistory">
          <div class="src-split" data-src-split :class="{ dragging }" role="separator"
            aria-orientation="horizontal" tabindex="0" :aria-valuemin="1" :aria-valuemax="10"
            :aria-valuenow="alloc.curAlloc" aria-label="历史搜索, 可拖动调整"
            @pointerdown="beginSplit" @keydown="onSplitKey">
            <span class="src-split-line"></span>
            <span class="src-split-label" data-src-history-label>历史搜索 · {{ state.searchHistory?.key }}</span>
            <span class="src-split-line"></span>
          </div>

          <div v-if="alloc.histRender > 0" class="src-pane src-pane-history" data-src-pane="history"
            :style="{ maxHeight: alloc.histRender * 44 + 'px' }">
            <div v-for="(item, i) in state.searchHistory?.items || []" :key="'h' + item.bookUrl + i"
              class="src-result src-result-history" :data-src-history-result="i">
              <div class="src-result-main">
                <div class="src-result-title">{{ item.title }}</div>
                <div class="src-result-meta">{{ resultMeta(item) }}</div>
              </div>
              <div class="src-result-side">
                <span class="src-badge">{{ sourceLabel(item) }}</span>
              </div>
            </div>
          </div>
        </template>
      </div>
    </template>
  </div>
</template>
