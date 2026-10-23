<script setup lang="ts">
/**
 * SourceManageView.vue — 书源管理(紧凑单行 + 批量勾选 + 常驻图标操作)
 *
 * 勾选框 = 是否启用(参与搜索)。失效书源不在这里出现, 统一去「失效」Tab。
 */
import { computed, nextTick, ref, watch } from 'vue';
import { send, state } from '../composables/vscode';
import type { BookSourceView } from '../composables/vscode';
import { aliveSources, checkStatus, filterSources, statusText } from '../composables/sourceView';

const keyword = ref('');
const pendingDeleteId = ref('');
const editName = ref('');
const editSearchUrl = ref('');

/** 增量渲染: 几千条书源一次全渲染会卡 */
const PAGE = 60;
const limit = ref(PAGE);

const alive = computed(function () { return aliveSources(state.sources); });
const filtered = computed(function () { return filterSources(alive.value, keyword.value); });
const list = computed(function () { return filtered.value.slice(0, limit.value); });
const restCount = computed(function () { return Math.max(0, filtered.value.length - limit.value); });
const enabledCount = computed(function () { return filtered.value.filter(function (s) { return s.enabled; }).length; });
/** 搜索地址里没有 {{key}} 也不是脚本: 提示用户关键词不会生效 */
const searchUrlNeedsKey = computed(function () {
  const u = editSearchUrl.value.trim();
  if (!u) { return false; }
  if (u.indexOf('{{key}}') >= 0) { return false; }
  if (/^@js:/i.test(u) || /^<js>/i.test(u)) { return false; }
  return true;
});
const allChecked = computed(function () { return filtered.value.length > 0 && enabledCount.value === filtered.value.length; });
const someChecked = computed(function () { return enabledCount.value > 0 && enabledCount.value < filtered.value.length; });

watch(keyword, function () { limit.value = PAGE; });
// 正在编辑的源被判失效移出后, 清掉编辑态
watch(function () { return state.sources; }, function () {
  const id = state.sourceEditingId;
  if (!id) { return; }
  if (!alive.value.some(function (s) { return s.id === id; })) { state.sourceEditingId = ''; }
});

function importBy(mode: 'url' | 'clipboard' | 'file'): void {
  send({ type: 'sourceImport', mode });
}

function check(s?: BookSourceView): void {
  send(s ? { type: 'sourceCheck', id: s.id } : { type: 'sourceCheck', scope: 'active' });
}

/** 「检查全部」运行中变成暂停/继续 */
const checkAllRunning = computed(function () { return state.checkRunning && state.checkScope === 'active'; });
const checkAllLabel = computed(function () {
  if (!checkAllRunning.value) { return '检查全部'; }
  return state.checkPaused ? '继续' : '暂停';
});

/** 取消本次检查(已完成的结果保留) */
function cancelCheckAll(): void {
  send({ type: 'sourceCheckCancel' });
  state.checkRunning = false;
  state.checkPaused = false;
  state.checkScope = '';
}

function toggleCheckAll(): void {
  if (checkAllRunning.value) {
    state.checkPaused = !state.checkPaused;
    send({ type: 'sourceCheckPause', paused: state.checkPaused });
    return;
  }
  check();
}

function exportAll(): void {
  send({ type: 'sourceExport' });
}

function toggle(s: BookSourceView): void {
  send({ type: 'sourceToggle', id: s.id, enabled: !s.enabled });
}

/** 批量启停: 只把真正变化的条目发给扩展(一次写盘) */
function bulkSet(valueOf: (s: BookSourceView) => boolean): void {
  const patches: { id: string; enabled: boolean }[] = [];
  for (const s of filtered.value) {
    const next = valueOf(s);
    if (next !== s.enabled) { patches.push({ id: s.id, enabled: next }); }
  }
  if (patches.length) { send({ type: 'sourceSetEnabled', patches }); }
}

function toggleAll(): void {
  const next = !allChecked.value;
  bulkSet(function () { return next; });
}

function invertAll(): void {
  bulkSet(function (s) { return !s.enabled; });
}

function disableAll(): void {
  bulkSet(function () { return false; });
}

function startEdit(s: BookSourceView): void {
  state.sourceEditingId = s.id;
  editName.value = s.name;
  editSearchUrl.value = s.searchUrl;
  // 编辑最后几行时表单可能在滚动区外
  void nextTick(function () {
    const root = document.querySelector('#sourcePopup [data-src-edit-name]') as HTMLElement | null;
    if (root && typeof root.scrollIntoView === 'function') {
      root.scrollIntoView({ block: 'nearest' });
    }
  });
}

function cancelEdit(): void {
  state.sourceEditingId = '';
}

function saveEdit(): void {
  const id = state.sourceEditingId;
  if (!id) { return; }
  send({ type: 'sourceUpdate', id, name: editName.value.trim(), searchUrl: editSearchUrl.value.trim() });
  state.sourceEditingId = '';
}

/** 两步删除: 第一次点变「确认」, 再点才真删 */
function askDelete(s: BookSourceView): void {
  if (pendingDeleteId.value === s.id) {
    send({ type: 'sourceRemove', id: s.id });
    pendingDeleteId.value = '';
    return;
  }
  pendingDeleteId.value = s.id;
}

function loadMore(): void {
  limit.value += PAGE;
}
</script>

<template>
  <div class="popup-body src-manage-body">
    <div class="src-tools">
      <button class="popup-secondary" data-src-import="url" @click="importBy('url')">从 URL 导入</button>
      <button class="popup-secondary" data-src-import="clipboard" @click="importBy('clipboard')">粘贴 JSON</button>
      <button class="popup-secondary" data-src-import="file" @click="importBy('file')">本地文件</button>
      <span class="spacer"></span>
      <button class="popup-btn" data-src-check-all @click="toggleCheckAll">{{ checkAllLabel }}</button>
      <button v-if="checkAllRunning && state.checkPaused" class="popup-btn" data-src-check-cancel
        @click="cancelCheckAll">取消</button>
      <button class="popup-btn" data-src-export @click="exportAll">导出</button>
    </div>

    <div v-if="checkAllRunning" class="src-hint src-progress" data-src-check-progress>
      <span class="src-progress-prefix">{{ state.checkPaused ? '已暂停' : '检查中' }}</span>
      <span class="src-progress-count">{{ state.checkDone }}/{{ state.checkTotal }}</span>
      <span class="src-progress-name" :title="state.checkSource">{{ state.checkSource }}</span>
    </div>

    <div class="src-bulk">
      <input type="checkbox" class="src-check" data-src-all :checked="allChecked"
        :indeterminate.prop="someChecked" title="全选(勾选=参与搜索)" @change="toggleAll" />
      <span class="src-bulk-label">全选</span>
      <span class="src-bulk-count">{{ enabledCount }} / {{ filtered.length }} 启用</span>
      <span class="spacer"></span>
      <button class="src-bulk-btn" data-src-invert @click="invertAll">反选</button>
      <button class="src-bulk-btn" data-src-clear @click="disableAll">全部停用</button>
    </div>

    <input v-model="keyword" class="src-input src-filter" type="text" placeholder="筛选书源(名称/分组/地址)"
      data-src-filter />

    <div v-if="!state.sources.length" class="popup-empty src-empty">
      <p>还没有书源。可以从 Yiove 等书源仓库复制导入地址。</p>
    </div>
    <div v-else-if="!filtered.length" class="popup-empty src-empty">没有匹配的书源</div>

    <div class="src-list" data-src-list>
    <template v-for="s in list" :key="s.id">
      <div class="src-row" :data-source-id="s.id">
        <input type="checkbox" class="src-check" :checked="s.enabled" :data-src-toggle="s.id"
          :title="s.enabled ? '已启用(参与搜索)' : '已停用'" @change="toggle(s)" />
        <span class="src-row-name" :title="s.name + ' · ' + s.url">{{ s.name }}</span>
        <span class="src-status" :class="'is-' + checkStatus(s)">{{ statusText(s) }}</span>
        <span v-if="s.group" class="src-row-group" :title="s.group">{{ s.group }}</span>
        <span class="src-row-acts">
          <button class="src-ico" :data-src-check="s.id" title="检查" @click="check(s)">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 12a8.5 8.5 0 1 1-2.5-6"/><path d="M20.5 3.5V9H15"/></svg>
          </button>
          <button class="src-ico" :data-src-edit="s.id" title="编辑" @click="startEdit(s)">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L20 8l-4-4L4 16v4Z"/><path d="M14 6l4 4"/></svg>
          </button>
          <button class="src-ico src-ico-del" :class="{ confirming: pendingDeleteId === s.id }"
            :data-src-del="s.id" :title="pendingDeleteId === s.id ? '再点一次确认删除' : '删除'" @click="askDelete(s)">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M6 7l1 13h10l1-13"/></svg>
            <span v-if="pendingDeleteId === s.id" class="src-ico-tip">确认</span>
          </button>
        </span>
      </div>
      <div v-if="state.sourceEditingId === s.id" class="src-edit">
        <input v-model="editName" class="src-input" data-src-edit-name placeholder="书源名称" />
        <input v-model="editSearchUrl" class="src-input" data-src-edit-url placeholder="搜索地址, 支持 {{key}}" />
        <p v-if="searchUrlNeedsKey" class="src-edit-warn" data-src-edit-warn>
          地址里没有关键词占位符，搜索时不会跟随输入变化；建议保留形如双花括号 key 的占位符。
        </p>
        <div class="src-edit-actions">
          <button class="popup-primary" data-src-edit-save @click="saveEdit">保存</button>
          <button class="popup-btn" @click="cancelEdit">取消</button>
        </div>
      </div>
    </template>
    </div>

    <button v-if="restCount > 0" class="popup-btn src-load-more" data-src-load-more @click="loadMore">
      加载更多（还有 {{ restCount }} 个）
    </button>
    <p class="src-risk">勾选 = 启用并参与搜索；失败一次的书源会自动移到「失效」Tab（可重查恢复）。书源来自第三方，只导入你信任的。</p>
  </div>
</template>
