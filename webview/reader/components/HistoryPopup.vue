<script setup lang="ts">
/**
 * HistoryPopup.vue — 阅读历史(本地 / 在线分栏, 各最多 1000 本, 列表 15 行滚动)
 *
 * 支持批量: 「管理」进入多选 -> 全选/删除所选; 另有「清空本栏」。
 *
 * 无障碍与终态约定（R1 / R7 / R9）：
 *  - 行 = 容器 + `button.hist-row-main`，勾选用原生 checkbox；
 *  - 删除与清空都走统一 ConfirmDialog（宿主的模态框只留给命令面板调用）；
 *  - `opResult` 成功才退出管理模式并清空选择，失败保留（用户可以只重试）。
 */
import { computed, ref, watch } from 'vue';
import { send, state, opRunning } from '../composables/vscode';
import type { HistoryItemView } from '../composables/vscode';
import { flushProgress } from '../store';
import { askConfirm } from '../composables/ops';

const rootRef = ref<HTMLElement | null>(null);
defineExpose({ el: rootRef, handleEscape: () => false });

const list = computed(function () { return state.history[state.historyTab] || []; });
const total = computed(function () {
  return (state.history.local ? state.history.local.length : 0)
    + (state.history.online ? state.history.online.length : 0);
});

/** 批量模式 */
const selecting = ref(false);
const selected = ref<string[]>([]);

watch(function () { return state.historyOpen; }, function (open) {
  if (open) {
    send({ type: 'requestHistory' });
    return;
  }
  selecting.value = false;
  selected.value = [];
});

// 切栏 / 记录变少时要修剪选择(否则"已选 3 条"里混着另一栏的路径)
watch(function () { return state.historyTab; }, function () {
  selected.value = [];
});
watch(function () { return list.value.length; }, function () {
  const alive = new Set(list.value.map(function (e) { return e.filePath; }));
  const next = selected.value.filter(function (p) { return alive.has(p); });
  if (next.length !== selected.value.length) { selected.value = next; }
  if (!list.value.length) { selecting.value = false; }
});

/** 写操作终态: 成功才退出管理模式(R7-03) */
watch(function () { return state.lastOp; }, function (op) {
  if (!op || !op.ok) { return; }
  if (op.op !== 'history:remove' && op.op !== 'history:clear') { return; }
  selecting.value = false;
  selected.value = [];
});

const allSelected = computed(function () {
  return list.value.length > 0 && selected.value.length === list.value.length;
});
const someSelected = computed(function () {
  return selected.value.length > 0 && selected.value.length < list.value.length;
});

/** 行键: 同一 filePath 只会在某一栏出现, 直接用它 */
function isSelected(e: HistoryItemView): boolean {
  return selected.value.indexOf(e.filePath) >= 0;
}

function toggleOne(e: HistoryItemView): void {
  if (isSelected(e)) {
    selected.value = selected.value.filter(function (p) { return p !== e.filePath; });
  } else {
    selected.value = selected.value.concat([e.filePath]);
  }
}

function toggleSelecting(): void {
  selecting.value = !selecting.value;
  selected.value = [];
}

function selectAll(): void {
  selected.value = allSelected.value ? [] : list.value.map(function (e) { return e.filePath; });
}

/** 删除所选: 统一确认框（含数量 + 是否可恢复） */
function removeSelected(): void {
  if (!selected.value.length) { return; }
  askConfirm({
    title: '删除 ' + selected.value.length + ' 条阅读记录',
    lines: [
      '将删除：' + selected.value.slice(0, 5).join('、') + (selected.value.length > 5 ? ' 等' : ''),
      '只删阅读记录，不影响书架、笔记与已下载的离线内容',
      '删除后无法恢复',
    ],
    confirmText: '删除',
    op: 'history:remove',
    payload: { filePaths: selected.value.slice() },
  });
}

/**
 * 单条删除: 复用批量协议 —— `history:remove` 收的是 filePaths 数组,
 * 传 [e.filePath] 即可, 宿主与协议零改动(HistoryStore.removeMany 对单元素已生效)。
 * 管理模式下行内按钮不渲染, 这里再兜一层, 避免批量进行中重复提交。
 */
function removeOne(e: HistoryItemView): void {
  if (selecting.value || opRunning('history:remove')) { return; }
  askConfirm({
    title: '删除「' + e.title + '」的阅读记录',
    lines: [
      '书籍：' + e.title + (e.author ? ' · ' + e.author : ''),
      progress(e),
      '只删阅读记录，不影响书架、笔记与已下载的离线内容',
      '删除后无法恢复',
    ],
    confirmText: '删除',
    op: 'history:remove',
    payload: { filePaths: [e.filePath] },
  });
}

/** 清空当前栏 */
function clearCurrent(): void {
  if (!list.value.length) { return; }
  const label = state.historyTab === 'online' ? '在线' : '本地';
  askConfirm({
    title: '清空' + label + '阅读记录',
    lines: [
      '共 ' + list.value.length + ' 条' + label + '记录',
      '只删记录，不影响书架、笔记与已下载的离线内容',
      '删除后无法恢复',
    ],
    confirmText: '清空',
    op: 'history:clear',
    payload: { kind: state.historyTab },
  });
}

function tabCount(kind: 'local' | 'online'): number {
  return state.history[kind] ? state.history[kind].length : 0;
}

function progress(e: HistoryItemView): string {
  if (e.chapterIndex < 0) { return '未开始'; }
  return '读至 第 ' + (e.chapterIndex + 1) + ' 章'
    + (e.totalChapters ? ' / 共 ' + e.totalChapters + ' 章' : '');
}

function timeText(ts: number): string {
  if (!ts) { return ''; }
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (sameDay) { return '今天 ' + hh + ':' + mm; }
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (d.getFullYear() === yesterday.getFullYear()
    && d.getMonth() === yesterday.getMonth() && d.getDate() === yesterday.getDate()) {
    return '昨天 ' + hh + ':' + mm;
  }
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-'
    + String(d.getDate()).padStart(2, '0');
}

/** 主按钮动作: 打开这本书 */
function openBook(e: HistoryItemView): void {
  if (!e.filePath) { return; }
  if (selecting.value) {
    toggleOne(e);
    return;
  }
  flushProgress();
  send({ type: 'openBook', filePath: e.filePath });
  state.historyOpen = false;
}
</script>

<template>
  <section id="historyPopup" ref="rootRef" class="popup" :class="{ open: state.historyOpen }"
    role="dialog" aria-modal="false" aria-labelledby="historyPopupTitle">
    <div class="popup-head">
      <h2 class="popup-title" id="historyPopupTitle" tabindex="-1">历史记录</h2>
      <span class="popup-sub">共 {{ total }} 本</span>
      <span class="spacer"></span>
      <button v-show="list.length" class="popup-ghost" data-hist-batch title="管理历史记录（多选删除）"
        :aria-pressed="selecting ? 'true' : 'false'" @click="toggleSelecting">
        {{ selecting ? '完成' : '管理' }}
      </button>
      <button class="popup-close" @click="state.historyOpen = false">关闭</button>
    </div>

    <div class="hist-tabs">
      <button class="hist-tab" :class="{ on: state.historyTab === 'local' }" data-hist-tab="local"
        :aria-pressed="state.historyTab === 'local' ? 'true' : 'false'"
        @click="state.historyTab = 'local'">本地 {{ tabCount('local') }}</button>
      <button class="hist-tab" :class="{ on: state.historyTab === 'online' }" data-hist-tab="online"
        :aria-pressed="state.historyTab === 'online' ? 'true' : 'false'"
        @click="state.historyTab = 'online'">在线 {{ tabCount('online') }}</button>
    </div>

    <div class="hist-list" data-hist-list>
      <div v-if="!list.length" class="popup-empty">
        {{ state.historyTab === 'local' ? '还没有本地阅读记录。' : '还没有在线书阅读记录。' }}
      </div>
      <div v-for="e in list" :key="e.kind + ':' + e.filePath" class="hist-row"
        :class="{ sel: selecting && isSelected(e) }" :data-hist-path="e.filePath">
        <label v-if="selecting" class="bk-check-label">
          <input type="checkbox" class="bk-check" data-hist-check
            :checked="isSelected(e)" :aria-label="'选择《' + e.title + '》的记录'"
            @change="toggleOne(e)" />
        </label>
        <span class="bk-tag">{{ e.kind === 'online' ? '在线' : '本地' }}</span>
        <button type="button" class="hist-row-main" :title="e.title" @click="openBook(e)">
          <span class="hist-title">{{ e.title }}</span>
          <span class="hist-meta">{{ progress(e) }}{{ e.author ? ' · ' + e.author : '' }}</span>
        </button>
        <span class="hist-time">{{ timeText(e.lastReadAt) }}</span>
        <!-- 单条删除: 与书架行同款悬停描边小按钮; 管理模式走批量勾选, 故隐藏 -->
        <button v-if="!selecting" type="button" class="bp-del hist-del" data-hist-del
          :aria-label="'删除《' + e.title + '》的阅读记录'" title="删除阅读记录"
          :disabled="opRunning('history:remove')" @click.stop="removeOne(e)">删除</button>
      </div>
    </div>

    <div v-if="!selecting" class="hist-foot">
      <span class="hist-tip">本地 / 在线各保留最近 1000 本 · 列表 15 行内滚动</span>
      <span class="spacer"></span>
      <button v-show="list.length" class="popup-ghost" data-hist-clear
        :disabled="opRunning('history:clear')" @click="clearCurrent">
        清空{{ state.historyTab === 'online' ? '在线' : '本地' }}记录
      </button>
    </div>
    <div v-else class="hist-foot">
      <label class="bk-check-label">
        <input type="checkbox" class="bk-check" data-hist-select-all
          :checked="allSelected" :indeterminate.prop="someSelected"
          aria-label="全选当前记录" @change="selectAll" />
        <span>{{ allSelected ? '取消全选' : '全选' }}</span>
      </label>
      <span class="sel-count" data-hist-sel-count>已选 {{ selected.length }} 条</span>
      <span class="spacer"></span>
      <button class="popup-primary popup-danger" data-hist-remove-selected
        :disabled="!selected.length || opRunning('history:remove')"
        :title="!selected.length ? '请先勾选要删除的记录' : '删除所选'"
        @click="removeSelected">删除所选</button>
    </div>
  </section>
</template>
