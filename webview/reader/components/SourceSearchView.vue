<script setup lang="ts">
/**
 * SourceSearchView.vue — 书源搜索
 *
 * 搜索范围 = 「书源」Tab 里勾选启用、且未失效的书源。
 * 结果区上下分栏：本次结果 / 历史搜索(上一次)；分隔条可按行拖动。
 *
 * 状态语义（PRD R9-01 ~ R9-04）：
 *  - 搜索中: 进度行是 `role="progressbar"`（aria-valuenow 随 done 更新），
 *    但**可见区 aria-live=off** —— 播报交给 App 里那个 sr-only 的节流 live region，
 *    否则同一信息会被读屏念两遍；
 *  - 失败明细: 摘要行 + `.src-errors-toggle[aria-expanded]`，展开后每源一行
 *    （源名 / 类别徽章 / 精简原因 / 单源重试）；
 *  - 只有"最终失败"（done && 有错误 && 无结果）那一行用 `role="alert"`，且只出现一次；
 *  - 空结果 vs 全失败由 `resultSummary()` 的四分支区分文案。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { plainSearchBook, send, state } from '../composables/vscode';
import { flushProgress } from '../store';
import {
  RESULT_ROW_CAP, allocResultRows, deadSources, errorCategory, failedNames,
  resultMeta, resultSummary, searchableSources, shortReason, sourceLabel,
} from '../composables/sourceView';

const inputRef = ref<HTMLInputElement | null>(null);
/** 根元素(容量实测要读它在真实布局下的高度) */
const bodyRef = ref<HTMLElement | null>(null);
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
/** 是否正在搜「输入框里这个词」(改词后按钮应恢复可点) */
const searchingThis = computed(function () {
  return state.searching && state.searchKeyword.trim() === state.searchKey;
});

/**
 * 结果区实测可容纳的行数（R4-04）。
 *
 * 以前写死 10 行：窗口一矮，第 8~10 行就被挤到面板外面，用户以为"只搜到这些"。
 * 现在按 pane 的 clientHeight ÷ 实测行高算，并用 ResizeObserver 跟随面板尺寸变化。
 */
const capacity = ref(RESULT_ROW_CAP);

function measureCapacity(): void {
  const pane = document.querySelector('#sourcePopup .src-results') as HTMLElement | null;
  const row = document.querySelector('#sourcePopup .src-result') as HTMLElement | null;
  const rowH = row && row.getBoundingClientRect().height > 0
    ? row.getBoundingClientRect().height
    : 44;
  const avail = pane ? pane.clientHeight : 0;
  if (rowH > 0 && avail > 0) {
    capacity.value = Math.max(1, Math.min(30, Math.floor(avail / rowH)));
  }
}

/** 历史搜索(仅上一次) */
const hasHistory = computed(function () {
  return !!state.searchHistory && state.searchHistory.items.length > 0;
});
const alloc = computed(function () {
  return allocResultRows(
    state.searchResults.length,
    state.searchHistory ? state.searchHistory.items.length : 0,
    hasHistory.value,
    state.splitCurrentRows,
    capacity.value
  );
});

/**
 * 分栏容量: JS 只给「行数」, 高度由 CSS 用 --src-result-h 乘出来。
 * 之前这里写死 * 44 —— 改行高变量时容器高度不跟随, 拖拽与渲染还会各算一套。
 */
const curAllocStyle = computed(function () {
  return { '--src-alloc-rows': String(alloc.value.curRender) };
});
const histAllocStyle = computed(function () {
  return { '--src-alloc-rows': String(alloc.value.histRender) };
});

/** 失败明细是否已展开 */
const errorsOpen = computed(function () { return !!state.searchErrorOpen; });
const errorCount = computed(function () { return state.searchErrors.length; });

function toggleErrors(): void {
  state.searchErrorOpen = !state.searchErrorOpen;
}

/** 最终失败: 有错误、无结果、且已结束 —— 只有这一行用 role=alert */
const finalFailure = computed(function () {
  return state.searchDone && errorCount.value > 0 && state.searchResults.length === 0;
});

// ---------------------------------------------------------------- 单源重试
/** 单源重试的请求号(每次点击 +1, 与宿主的回包 reqId 对上) */
let retrySeq = 0;

function retryOf(sourceId: string): { running: boolean; ok?: boolean; message?: string } | null {
  return state.sourceRetries[sourceId] || null;
}

function retryText(sourceId: string): string {
  const r = retryOf(sourceId);
  if (!r) { return '重试'; }
  if (r.running) { return '重试中…'; }
  return r.ok ? '已恢复' : '重试';
}

/** 单源重试: 成功则移出失败列表并按 bookUrl 去重合并，失败保留该行并更新原因 */
function retrySource(sourceId: string): void {
  const st = retryOf(sourceId);
  if (st && st.running) { return; }
  retrySeq += 1;
  state.sourceRetries[sourceId] = { running: true };
  send({ type: 'sourceRetry', reqId: retrySeq, sourceId, key: state.searchKey });
}

/**
 * 已加入书架对应的书架记录。
 *
 * 两个来源缺一不可:
 *  - state.shelf: 书架真相源, 跨会话也认得出(重开 VS Code 后仍显示"已加入")
 *  - state.onlineAdded: 本次刚加入、书架快照还没推下来的过渡态
 */
function shelfEntryOf(item: { bookUrl: string }) {
  return state.shelf.find((s) => s.onlineBookUrl === item.bookUrl);
}

/** 是否已加入在线书架 */
function isAdded(item: { bookUrl: string }): boolean {
  return !!shelfEntryOf(item) || state.onlineAdded.indexOf(item.bookUrl) >= 0;
}

/** 从书架移出(二次确认由扩展侧 removeFromShelf 的 modal 负责) */
function removeOnline(item: { bookUrl: string }): void {
  const entry = shelfEntryOf(item);
  if (!entry) {
    // 还没有书架快照(极端时序): 交给下一次 shelf 推送, 不盲发空路径
    return;
  }
  send({ type: 'removeBook', filePath: entry.filePath });
}

/** 当前行徽标: 已打开的正式书显示「在读」, 其余(含加载中)显示「预览中」 */
function currentLabel(item: { bookUrl: string }): string {
  if (isPreviewing(item)) { return '解析中…'; }
  const online = state.novel && state.novel.online;
  return online && online.bookUrl === item.bookUrl && !online.preview ? '在读' : '预览中';
}

function isPending(item: { bookUrl: string }): boolean {
  return state.onlineAddPending.indexOf(item.bookUrl) >= 0;
}

/** 点击结果行主按钮: 临时预览阅读(不加入书架) */
function previewBook(item: { bookUrl: string; title: string } & Record<string, unknown>): void {
  // 解析中禁止再点其他结果, 避免多个预览互相覆盖
  if (state.previewPending) { return; }
  // 切书前先把上一本的章节/章内位置发给扩展(此时面板仍指向旧书)
  flushProgress();
  state.onlineError = '';
  state.previewBookUrl = item.bookUrl;
  state.previewPending = {
    bookUrl: item.bookUrl,
    title: item.title,
    sourceName: sourceLabel(item as never),
    at: Date.now(),
    dismissed: false,
  };
  // 弹窗保持打开, 等扩展回 previewReady 后再关
  send({ type: 'previewOnlineBook', item: plainSearchBook(item as never) });
}

function isPreviewing(item: { bookUrl: string }): boolean {
  return !!state.previewPending && state.previewPending.bookUrl === item.bookUrl;
}

function addOnline(item: { bookUrl: string } & Record<string, unknown>): void {
  if (isAdded(item) || isPending(item)) { return; }
  state.onlineError = '';
  state.onlineAddPending.push(item.bookUrl);
  // 必须传纯对象: Vue 响应式 Proxy 无法被 postMessage 结构化克隆
  send({ type: 'addOnlineBook', item: plainSearchBook(item as never) });
}

function doSearch(): void {
  // 直接读输入框实际值: 中文输入法下 v-model 可能还没同步到 state
  const key = (inputRef.value ? inputRef.value.value : state.searchKeyword).trim();
  if (!key) { return; }
  if (state.searchKeyword !== key) { state.searchKeyword = key; }
  if (state.searching) {
    if (key === state.searchKey) { return; }
    // 搜索中换了关键词: 取消旧轮, 接着发起新搜索
    cancelSearch();
  }

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
  state.onlineError = '';
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

/** 输入框一变就取消旧搜索: 让按钮立即从「搜索中…」恢复, 不必先点取消 */
function onKeywordInput(e: Event): void {
  const target = e.target as HTMLInputElement | null;
  const value = target ? target.value : state.searchKeyword;
  if (state.searching && value.trim() !== state.searchKey) { cancelSearch(); }
}

/** 输入法确认候选的回车不触发搜索 */
function onEnter(e: KeyboardEvent): void {
  // isComposing / keyCode 229 都是输入法组合态(Chrome/Electron 两者都可能出现)
  if (e.isComposing || e.keyCode === 229) { return; }
  doSearch();
}

/** 兜底: 程序化改 state.searchKeyword 时同样取消旧搜索 */
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

/** 键盘: 上下各挪一行(上限 = 实测容量, 不再写死 10) */
function onSplitKey(e: KeyboardEvent): void {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') { return; }
  e.preventDefault();
  const delta = e.key === 'ArrowDown' ? 1 : -1;
  const cap = Math.max(1, capacity.value);
  const next = Math.max(1, Math.min(cap, alloc.value.curAlloc + delta));
  state.splitCurrentRows = next;
}

let resizeObserver: ResizeObserver | null = null;

function onWindowResize(): void {
  measureCapacity();
}

onMounted(function () {
  document.addEventListener('pointermove', moveSplit);
  document.addEventListener('pointerup', endSplit);
  document.addEventListener('pointercancel', endSplit);
  window.addEventListener('resize', onWindowResize);
  const pop = document.getElementById('sourcePopup');
  if (typeof ResizeObserver !== 'undefined' && pop) {
    resizeObserver = new ResizeObserver(function () { measureCapacity(); });
    resizeObserver.observe(pop);
  }
  measureCapacity();
});

// 结果条目数变化时重算(行高可能因标题换行而变)
watch(function () { return state.searchResults.length; }, function () { measureCapacity(); });

onBeforeUnmount(function () {
  document.removeEventListener('pointermove', moveSplit);
  document.removeEventListener('pointerup', endSplit);
  document.removeEventListener('pointercancel', endSplit);
  window.removeEventListener('resize', onWindowResize);
  if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
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
  <div class="popup-body src-search-body" ref="bodyRef">
    <div class="src-search">
      <input ref="inputRef" v-model="state.searchKeyword" class="src-input" type="text"
        placeholder="输入书名或作者, 回车搜索" data-src-input aria-label="搜索书名或作者"
        @input="onKeywordInput" @keydown.enter="onEnter" />
      <button class="src-go" :disabled="searchingThis || noSearchable" data-src-go @click="doSearch">
        {{ searchingThis ? '搜索中…' : '搜索' }}
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
      <div v-if="state.onlineError" class="src-op-error" data-src-op-error>{{ state.onlineError }}</div>
      <!-- 进度行: progressbar 语义, 但可见区不参与播报(避免与 sr-only 的 live region 双播报) -->
      <div v-if="state.searching" class="src-hint src-progress" data-src-progress
        role="progressbar" aria-label="正在搜索书源" aria-live="off"
        :aria-valuemin="0" :aria-valuemax="state.searchProgress ? state.searchProgress.total : 0"
        :aria-valuenow="state.searchProgress ? state.searchProgress.done : 0">
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
        <span v-if="state.searchDeadAdded > 0" class="src-skip">· {{ state.searchDeadAdded }} 个源连续失败已移入失效</span>
        <span v-if="state.searchSkipped > 0" class="src-skip">（另有 {{ state.searchSkipped }} 个书源未参与）</span>
      </div>

      <!-- 最终失败: 唯一一个 role=alert(有错误 + 无结果 + 已结束) -->
      <div v-if="finalFailure" class="src-final-error" data-src-final-error role="alert">
        <span>所有书源都失败了：展开明细查看原因，或对单个书源重试</span>
      </div>

      <!-- 失败明细: 摘要行 + 展开/收起 + 每源一行(源名/类别/原因/重试) -->
      <div v-if="state.searchDone && errorCount" class="src-errors" data-src-errors>
        <div class="src-errors-head">
          <button type="button" class="src-errors-toggle" data-src-errors-toggle
            :aria-expanded="errorsOpen ? 'true' : 'false'" aria-controls="srcErrorList"
            @click="toggleErrors">
            {{ errorCount }} 个书源搜索失败{{ errorNames }}<template v-if="state.searchDeadAdded > 0">；连续失败 2 次的源已移入失效</template>{{ errorsOpen ? '（收起明细）' : '（查看明细）' }}
          </button>
          <button class="src-link" data-src-error-dead @click="goDead">查看失效书源</button>
        </div>
        <ul v-if="errorsOpen" class="src-error-list" id="srcErrorList" data-src-error-list>
          <li v-for="err in state.searchErrors" :key="err.sourceId" class="src-error-row"
            :data-src-error-row="err.sourceId">
            <span class="src-error-name" :title="err.sourceName">{{ err.sourceName }}</span>
            <span class="src-error-cat" :data-src-error-cat="err.kind">{{ errorCategory(err.kind) }}</span>
            <span class="src-error-msg" :title="err.message">{{ shortReason(err.message) }}</span>
            <!-- 单源重试: 状态来自 state.sourceRetries, 重试中禁用防重复 -->
            <button type="button" class="src-error-retry" :data-src-error-retry="err.sourceId"
              :disabled="!!(retryOf(err.sourceId) && retryOf(err.sourceId)!.running)"
              :aria-label="'重试书源 ' + err.sourceName"
              @click="retrySource(err.sourceId)">{{ retryText(err.sourceId) }}</button>
          </li>
        </ul>
      </div>

      <div class="src-results" data-src-results>
        <div class="src-pane src-pane-current" data-src-pane="current" :style="curAllocStyle">
          <div v-for="(item, i) in state.searchResults" :key="item.bookUrl + i" class="src-result"
            :class="{ cur: state.previewBookUrl === item.bookUrl, pending: isPreviewing(item), added: isAdded(item) }"
            :data-src-result="i" :data-src-current="state.previewBookUrl === item.bookUrl ? '1' : undefined"
            :data-src-added="isAdded(item) ? '1' : undefined"
            :data-src-preview-busy="isPreviewing(item) ? '1' : undefined">
            <!-- 结果行是"容器 + 主按钮 + 动作组": 点主按钮预览, 加入书架是独立的按钮 -->
            <button type="button" class="src-result-main" :title="'点击预览: ' + item.title"
              @click="previewBook(item)">
              <span class="src-result-title">{{ item.title }}</span>
              <span class="src-result-meta">{{ resultMeta(item) }}</span>
            </button>
            <div class="src-result-side">
              <span v-if="state.previewBookUrl === item.bookUrl" class="src-cur-badge" data-src-cur-badge>
                {{ currentLabel(item) }}
              </span>
              <!-- 已存书架的标记: 与行高亮叠加, 让"这本我有了"在扫列表时更进一步可读
                   当前行不重复挂(那行已有「在读/预览中」胶囊, 再挂两个太挤) -->
              <span v-else-if="isAdded(item)" class="src-added-badge" data-src-added-badge
                title="已在书架">已存书架</span>
              <span class="src-badge">{{ sourceLabel(item) }}</span>
              <button class="popup-btn src-add" :class="{ added: isAdded(item) }"
                :disabled="isPending(item) || (!isAdded(item) && !!state.previewPending)"
                :title="isAdded(item) ? '从书架移出（会二次确认）' : '加入在线书架'"
                @click.stop="isAdded(item) ? removeOnline(item) : addOnline(item)">
                {{ isAdded(item) ? '移出书架' : (isPending(item) ? '加入中…' : '加入书架') }}
              </button>
            </div>
          </div>
        </div>

        <template v-if="hasHistory">
          <div class="src-split" data-src-split :class="{ dragging }" role="separator"
            aria-orientation="horizontal" tabindex="0" :aria-valuemin="1" :aria-valuemax="capacity"
            :aria-valuenow="alloc.curAlloc" aria-label="历史搜索, 可拖动调整"
            @pointerdown="beginSplit" @keydown="onSplitKey">
            <span class="src-split-line"></span>
            <span class="src-split-label" data-src-history-label>历史搜索 · {{ state.searchHistory?.key }}</span>
            <span class="src-split-line"></span>
          </div>

          <div v-if="alloc.histRender > 0" class="src-pane src-pane-history" data-src-pane="history"
            :style="histAllocStyle">
            <div v-for="(item, i) in state.searchHistory?.items || []" :key="'h' + item.bookUrl + i"
              class="src-result src-result-history" :data-src-history-result="i">
              <div class="src-result-main src-result-main-static">
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
