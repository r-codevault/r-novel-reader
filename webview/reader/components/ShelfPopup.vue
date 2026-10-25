<script setup lang="ts">
/**
 * ShelfPopup.vue — 书架弹窗(书籍列表 / 打开 / 移除 / 添加 / 批量移除)
 * 弹窗互斥由 App 统一保证
 *
 * 无障碍与终态约定（PRD R1 / R7 / R9）：
 *  - 行是"容器 + 主按钮 + 独立删除按钮"：不能把删除塞进主按钮里（会导致按钮嵌套）；
 *  - 批量勾选用**原生** checkbox（自带 role/键盘/不定态），不再用 span 模拟；
 *  - 危险操作走统一 ConfirmDialog，`opResult` 成功才退出管理模式，失败保留选择；
 *  - 后台下载任务在底部给一行入口（切走面板也能查）。
 */
import { computed, ref, watch } from 'vue';
import { state, send, opRunning, type ShelfItemView } from '../composables/vscode';
import { flushProgress } from '../store';
import { askConfirm } from '../composables/ops';

const rootRef = ref<HTMLElement | null>(null);
defineExpose({ el: rootRef, handleEscape: () => false });

const shelfHas = computed(function () { return state.shelf.length > 0; });

/** 批量模式(局部状态: 关弹窗就退出, 不必跨会话保留) */
const selecting = ref(false);
const selected = ref<string[]>([]);

watch(function () { return state.shelfOpen; }, function (open) {
  if (!open) {
    selecting.value = false;
    selected.value = [];
  }
});

/** 书架快照变化(移除成功)后修剪已不存在的选择 */
watch(function () { return state.shelf.length; }, function () {
  const alive = new Set(state.shelf.map(function (b) { return b.filePath; }));
  const next = selected.value.filter(function (p) { return alive.has(p); });
  if (next.length !== selected.value.length) { selected.value = next; }
  if (!state.shelf.length) { selecting.value = false; }
});

/**
 * 写操作终态: **成功才退出管理模式**；失败保留选择，用户可以只重试或取消。
 * (以前点了就清空，失败后用户得重新勾一遍 —— R7-03)
 */
watch(function () { return state.lastOp; }, function (op) {
  if (!op || !op.ok) { return; }
  if (op.op !== 'books:remove' && op.op !== 'books:removeMany') { return; }
  selecting.value = false;
  selected.value = [];
});

const allSelected = computed(function () {
  return state.shelf.length > 0 && selected.value.length === state.shelf.length;
});

/** 半选(部分选中): 原生 checkbox 的 indeterminate 只能走 property */
const someSelected = computed(function () {
  return selected.value.length > 0 && selected.value.length < state.shelf.length;
});

function toggleSelecting(): void {
  selecting.value = !selecting.value;
  selected.value = [];
}

function isSelected(b: ShelfItemView): boolean {
  return selected.value.indexOf(b.filePath) >= 0;
}

function toggleOne(b: ShelfItemView): void {
  if (isSelected(b)) {
    selected.value = selected.value.filter(function (p) { return p !== b.filePath; });
  } else {
    selected.value = selected.value.concat([b.filePath]);
  }
}

function selectAll(): void {
  selected.value = allSelected.value ? [] : state.shelf.map(function (b) { return b.filePath; });
}

/** 批量移除: 先走统一确认框，用户确认后才发请求（带 opId） */
function removeSelected(): void {
  if (!selected.value.length) { return; }
  const names = state.shelf
    .filter(function (b) { return selected.value.indexOf(b.filePath) >= 0; })
    .map(function (b) { return b.title; });
  askConfirm({
    title: '移除 ' + names.length + ' 本书',
    lines: [
      '将移除：' + names.slice(0, 5).join('、') + (names.length > 5 ? ' 等 ' + names.length + ' 本' : ''),
      '只移除书架记录；文件是否移入回收站取决于书库目录设置',
      '已下载的离线内容默认保留',
    ],
    confirmText: '移除',
    op: 'books:removeMany',
    payload: { filePaths: selected.value.slice() },
  });
}

/** 单本移除: 同样走确认框（宿主不再弹模态框） */
function removeOne(b: ShelfItemView): void {
  askConfirm({
    title: '从书架移除「' + b.title + '」',
    lines: [
      '书籍：' + b.title + (b.author ? ' · ' + b.author : ''),
      '只移除书架记录；文件是否移入回收站取决于书库目录设置',
      '已下载的离线内容默认保留',
    ],
    confirmText: '移除',
    op: 'books:remove',
    payload: { filePath: b.filePath },
  });
}

function progress(b: ShelfItemView): string {
  return b.chapterIndex >= 0
    ? '读至 第 ' + (b.chapterIndex + 1) + ' 章' + (b.totalChapters ? ' / 共 ' + b.totalChapters + ' 章' : '')
    : b.totalChapters
      ? '共 ' + b.totalChapters + ' 章 · 未开始'
      : '未开始阅读';
}

/** 主按钮动作: 打开这本书（真正的点击目标，不是整行） */
function openBook(b: ShelfItemView): void {
  if (selecting.value) {
    toggleOne(b);
    return;
  }
  // 换书前先落盘当前进度, 避免最后 600ms 内的滚动丢失
  flushProgress();
  send({ type: 'openBook', filePath: b.filePath });
  state.shelfOpen = false;
}

function addBook(): void {
  // 不关闭弹窗: 添加完成后新书会实时出现在列表里, 方便连续添加/查看
  send({ type: 'openFile' });
}

/**
 * 按书库目录重新扫描 —— 两阶段：先要预演，宿主回 `shelfRefreshPlan` 后
 * App 弹确认框（用户在确认框里点「执行刷新」才真的写盘）。
 */
function refreshFromLibrary(): void {
  send({ type: 'refreshLibraryPreview' });
}

/** 后台下载任务表: 进行中的任务（与"当前书"无关） */
const runningTasks = computed(function () {
  const all = Object.keys(state.downloadTasks).map(function (k) { return state.downloadTasks[k]; });
  return all.filter(function (t) { return t.running; });
});

function openTaskList(): void {
  state.shelfOpen = false;
  state.storageOpen = true;
}
</script>

<template>
  <section id="shelfPopup" ref="rootRef" class="popup" :class="{ open: state.shelfOpen }"
    role="dialog" aria-modal="false" aria-labelledby="shelfPopupTitle">
    <div class="popup-head">
      <h2 class="popup-title" id="shelfPopupTitle" tabindex="-1">书架</h2>
      <span class="popup-sub" v-show="shelfHas">共 {{ state.shelf.length }} 本 · 进度自动记录</span>
      <span class="spacer"></span>
      <button v-show="shelfHas" class="popup-ghost" data-shelf-batch title="管理书架（多选移除）"
        :aria-pressed="selecting ? 'true' : 'false'" @click="toggleSelecting">
        {{ selecting ? '完成' : '管理' }}
      </button>
      <button class="popup-close" @click="state.shelfOpen = false">关闭</button>
    </div>
    <div class="popup-body">
      <div v-if="!shelfHas" class="popup-empty" data-shelf-empty>
        还没有书。先导入书源在线搜书，或添加本地 txt。
      </div>
      <div v-for="b in state.shelf" :key="b.filePath" class="bk"
        :class="{ cur: b.current && !selecting, sel: selecting && isSelected(b) }"
        :data-bk-path="b.filePath">
        <!-- 批量勾选: 原生 checkbox（自带 role/键盘/indeterminate） -->
        <label v-if="selecting" class="bk-check-label">
          <input type="checkbox" class="bk-check" data-shelf-check
            :checked="isSelected(b)" :aria-label="'选择《' + b.title + '》'"
            @change="toggleOne(b)" />
        </label>
        <!-- 主按钮: 打开这本书。aria-current 让读屏知道"这是当前在读的那本" -->
        <button type="button" class="bk-main" :title="b.title"
          :aria-current="b.current ? 'true' : undefined" @click="openBook(b)">
          <span class="bk-title">{{ b.title }}</span>
          <span class="bk-sub">
            <!-- 在线书直接显示书源名(如「起点男频」), 比笼统的「在线」有用得多 -->
            <span v-if="b.online" class="bk-tag bk-tag-online" data-bk-source
              :title="b.sourceName ? '来源：' + b.sourceName : '在线书（来源未知）'">{{ b.sourceName || '在线' }}</span>
            <span v-else class="bk-tag bk-tag-local" title="本地 txt 文件">本地</span>
            <span v-if="b.offline && b.offline.done > 0" class="bk-tag bk-tag-offline" data-bk-offline
              :title="'已离线下载 ' + b.offline.done + ' / ' + b.offline.total + ' 章'">离线 {{ b.offline.done }}</span>
            {{ progress(b) }}{{ b.author ? ' · ' + b.author : '' }}
          </span>
        </button>
        <button v-if="!selecting" type="button" class="bp-del" data-bk-del
          :aria-label="'从书架移除《' + b.title + '》'" title="从书架移除"
          :disabled="opRunning('books:remove')" @click="removeOne(b)">✕</button>
      </div>
    </div>
    <div v-if="!selecting" class="popup-foot">
      <button class="popup-primary" title="添加本地 txt 小说" @click="addBook">＋ 添加书籍</button>
      <button class="popup-secondary" v-show="state.libraryPath" title="按书库目录重新扫描书籍"
        @click="refreshFromLibrary">↻ 刷新书架</button>
    </div>
    <div v-else class="popup-foot">
      <label class="bk-check-label">
        <input type="checkbox" class="bk-check" data-shelf-select-all
          :checked="allSelected" :indeterminate.prop="someSelected"
          aria-label="全选书架里的书" @change="selectAll" />
        <span>{{ allSelected ? '取消全选' : '全选' }}</span>
      </label>
      <span class="sel-count" data-shelf-sel-count>已选 {{ selected.length }} 本</span>
      <span class="spacer"></span>
      <button class="popup-primary popup-danger" data-shelf-remove-selected
        :disabled="!selected.length || opRunning('books:removeMany')"
        :title="!selected.length ? '请先勾选要移除的书' : '移除所选'"
        @click="removeSelected">移除所选</button>
    </div>
    <!-- 后台下载任务入口(R9-06): 不弹系统模态, 一行入口进存储面板看详情 -->
    <div v-if="runningTasks.length" class="dl-tasks" data-shelf-dl-tasks>
      <div class="dl-tasks-head">
        <span>离线任务 {{ runningTasks.length }} 个（进行中 {{ runningTasks.length }}）</span>
        <span class="spacer"></span>
        <button class="dl-task-btn" @click="openTaskList">查看</button>
      </div>
    </div>
    <div v-if="state.shelfNotice" class="popup-tip" data-shelf-notice role="status">{{ state.shelfNotice }}</div>
  </section>
</template>
