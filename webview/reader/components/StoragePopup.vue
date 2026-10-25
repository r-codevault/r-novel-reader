<script setup lang="ts">
/**
 * StoragePopup.vue — 存储位置弹窗(书库目录 + 离线缓存)
 * 弹窗互斥由 App 统一保证
 *
 * 无障碍与终态约定：
 *  - 标题是真 `<h2 id>`，`role="dialog" aria-modal="false" aria-labelledby`；
 *  - 不可用的按钮 disabled 且有 `aria-describedby` 指向"为什么不可用"（R7-06）；
 *  - 危险操作（清本书 / 清全部）走统一 ConfirmDialog，不再弹宿主模态框；
 *  - 任务表列出所有下载任务（按 filePath），可对**非当前书**暂停/继续（R9-06）。
 */
import { computed, ref, watch } from 'vue';
import { state, send, currentBookKey } from '../composables/vscode';
import { formatBytes, requestOfflineStatus, exportOfflineTxt, pauseDownload, resumeDownload } from '../composables/offline';
import { askConfirm } from '../composables/ops';

const rootRef = ref<HTMLElement | null>(null);
defineExpose({ el: rootRef, handleEscape: () => false });

const libSet = computed(function () { return !!state.libraryPath; });

watch(function () { return state.storageOpen; }, function (open) {
  // 打开时拉一次最新快照(下载可能是在别的书/别的窗口里完成的)
  if (open) { requestOfflineStatus(); }
});

const isOnline = computed(function () { return !!(state.novel && state.novel.online); });
const currentOffline = computed(function () { return state.offline; });
const hasCurrentOffline = computed(function () {
  const o = currentOffline.value;
  return !!o && o.filePath === currentBookKey() && o.done > 0;
});

/** 全部下载任务（含已完成的），任务表按 filePath 排序保证稳定 */
const taskList = computed(function () {
  const all = Object.keys(state.downloadTasks).map(function (k) { return state.downloadTasks[k]; });
  return all.sort(function (a, b) { return (a.bookTitle || '').localeCompare(b.bookTitle || ''); });
});

const runningCount = computed(function () {
  return taskList.value.filter(function (t) { return t.running; }).length;
});

/** 导出: 只有在线书且有离线内容才可能成功（其余禁用并说明原因） */
const canExport = computed(function () { return isOnline.value; });
const canClearCurrent = computed(function () { return isOnline.value && hasCurrentOffline.value; });
const canClearAll = computed(function () { return state.offlineStats.books > 0; });

function onExport(): void {
  if (!canExport.value) { return; }
  exportOfflineTxt();
}

/** 清除本书离线内容: 结构化确认(书名 + 章数 + 占用空间 + 不可恢复) */
function onClearCurrent(): void {
  if (!canClearCurrent.value) { return; }
  const o = currentOffline.value;
  askConfirm({
    title: '清除本书离线内容',
    lines: [
      '书籍：' + (state.novel ? state.novel.bookTitle : ''),
      '章数：' + (o ? o.done : 0) + ' / ' + (o ? o.total : 0) + ' 章',
      '占用空间：' + formatBytes(o ? o.bytes : 0),
      '不可恢复；已导出的本地 txt 不受影响',
    ],
    confirmText: '清除',
    op: 'offline:clearCurrent',
    payload: {},
  });
}

/** 清理全部离线缓存 */
function onClearAll(): void {
  if (!canClearAll.value) { return; }
  askConfirm({
    title: '清理全部离线缓存',
    lines: [
      '共 ' + state.offlineStats.books + ' 本书 / ' + formatBytes(state.offlineStats.bytes),
      '不可恢复；已导出的本地 txt 不受影响',
      '书架里的书不会因此被移除',
    ],
    confirmText: '清理全部',
    op: 'offline:clearAll',
    payload: {},
  });
}

/** 任务行上的暂停/继续: 用任务自己的 filePath, 不依赖"当前书" */
function toggleTask(filePath: string, running: boolean, paused: boolean): void {
  if (!running) { return; }
  if (paused) { resumeDownload(filePath); } else { pauseDownload(filePath); }
}

/** 任务状态双通道文案(R11-06): 颜色之外还有文字 */
function taskState(t: { running: boolean; paused: boolean }): string {
  if (!t.running) { return '已完成'; }
  return t.paused ? '已暂停' : '下载中';
}
</script>

<template>
  <section id="storagePopup" ref="rootRef" class="popup" :class="{ open: state.storageOpen }"
    role="dialog" aria-modal="false" aria-labelledby="storagePopupTitle">
    <div class="popup-head">
      <h2 class="popup-title" id="storagePopupTitle" tabindex="-1">存储位置</h2>
      <span class="spacer"></span>
      <button class="popup-close" @click="state.storageOpen = false">关闭</button>
    </div>
    <div class="popup-body popup-body-pad">
      <div class="sp-row-line">
        <span class="popup-label">书库目录</span>
        <span class="popup-val" :class="{ empty: !libSet }" :title="state.libraryPath">{{ state.libraryPath || '未设置 · 读取文件原路径' }}</span>
      </div>
      <div class="popup-actions">
        <button class="popup-btn" @click="send({ type: 'pickLibrary' })">选择书库目录…</button>
        <button class="popup-btn" v-show="libSet" @click="send({ type: 'openLibraryFolder' })">在文件管理器中打开</button>
        <button class="popup-btn" v-show="libSet" @click="send({ type: 'clearLibrary' })">使用原路径（不拷贝）</button>
      </div>
      <p class="popup-tip">默认不设置：直接读取你选择的文件原路径。设置书库目录后，<b>导入时会把小说复制到该目录</b>并从副本读取，原文件之后可以自行移动或删除；同名文件会自动改名，不会覆盖。</p>

      <div class="sp-row-line sp-row-gap">
        <span class="popup-label">离线下载</span>
        <span class="popup-val" data-sp-offline-size>
          {{ state.offlineStats.books }} 本 · {{ formatBytes(state.offlineStats.bytes) }}
        </span>
      </div>
      <div class="popup-actions">
        <button class="popup-btn" data-sp-export :disabled="!canExport" aria-describedby="storageHintExport"
          @click="onExport">当前书导出 txt</button>
        <button class="popup-btn" data-sp-clear-current :disabled="!canClearCurrent" aria-describedby="storageHintClear"
          @click="onClearCurrent">清除本书离线内容</button>
        <button class="popup-btn" data-sp-clear-all :disabled="!canClearAll" aria-describedby="storageHintAll"
          @click="onClearAll">清理全部离线缓存</button>
      </div>
      <!-- 禁用原因必须可读(R7-06): 用 aria-describedby 指到这三句 -->
      <p class="popup-tip" id="storageHintExport" data-sp-hint>仅在线书可导出；本地 txt 本身就是文件。</p>
      <p class="popup-tip" id="storageHintClear" data-sp-hint>这本书还没有离线内容。</p>
      <p class="popup-tip" id="storageHintAll" data-sp-hint>暂无离线内容。</p>

      <!-- 任务表: 列出所有下载任务, 与"当前打开哪本书"无关(R9-06) -->
      <div v-if="taskList.length" class="dl-tasks" data-sp-tasks>
        <div class="dl-tasks-head">
          <span>离线任务 {{ taskList.length }} 个（进行中 {{ runningCount }}）</span>
        </div>
        <div v-for="t in taskList" :key="t.filePath" class="dl-task-row" :data-sp-task="t.filePath">
          <span class="dl-task-title" :title="t.bookTitle">{{ t.bookTitle }}</span>
          <span class="dl-task-num">{{ t.done }}/{{ t.total }}</span>
          <span class="dl-task-num">{{ taskState(t) }}{{ t.failed ? ' · 失败 ' + t.failed : '' }}</span>
          <button v-if="t.running" class="dl-task-btn" :data-sp-task-toggle="t.filePath"
            @click="toggleTask(t.filePath, t.running, t.paused)">{{ t.paused ? '继续' : '暂停' }}</button>
        </div>
      </div>

      <p class="popup-tip">离线内容存放在扩展缓存目录（与书库目录无关）。从书架移除在线书时会询问<b>保留还是删除</b>离线内容；「导出为本地 txt」<b>只保存一个 txt 文件</b>（不自动打开、也不加入书架），需要时再用「＋ 添加书籍」导入。</p>
    </div>
  </section>
</template>
