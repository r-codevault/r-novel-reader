<script setup lang="ts">
/**
 * SourceManageView.vue — 书源管理(紧凑单行 + 批量勾选 + 常驻图标操作)
 *
 * 勾选框 = 是否启用(参与搜索)。失效书源不在这里出现, 统一去「失效」Tab。
 *
 * 信息层级（PRD R11-01/02）：
 *  - 工具区三层: 唯一主操作「导入书源 ▾」｜次操作「检查全部」｜「更多 ▾」(导出 / 全部停用)；
 *  - 批量操作条 `.src-bulk` **只在管理模式**出现，危险动作（删除所选）用 `.src-danger-zone`
 *    与普通操作分隔，避免"全选"和"删光"挨在一起被误点；
 *  - 每个图标按钮与输入都有含**具体源名**的可访问名称（R12-03/04/05）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { send, state } from '../composables/vscode';
import type { BookSourceView } from '../composables/vscode';
import { aliveSources, checkStatus, filterSources, statusText } from '../composables/sourceView';

const keyword = ref('');
const pendingDeleteId = ref('');
const editName = ref('');
const editSearchUrl = ref('');

/** 管理模式: 批量条与危险区只在此模式出现 */
const managing = ref(false);
/** 导入子菜单 / 更多子菜单 */
const importOpen = ref(false);
const moreOpen = ref(false);
const importBtnRef = ref<HTMLElement | null>(null);
const importMenuRef = ref<HTMLElement | null>(null);
const moreMenuRef = ref<HTMLElement | null>(null);

/** 增量渲染: 几千条书源一次全渲染会卡 */
const PAGE = 60;
const limit = ref(PAGE);
const listRef = ref<HTMLElement | null>(null);

const alive = computed(function () { return aliveSources(state.sources); });
const filtered = computed(function () { return filterSources(alive.value, keyword.value); });
const list = computed(function () { return filtered.value.slice(0, limit.value); });
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

// ---------------------------------------------------------------- 菜单开合
function toggleManaging(): void {
  managing.value = !managing.value;
  if (!managing.value) { pendingDeleteId.value = ''; }
}

function closeMenus(): void {
  importOpen.value = false;
  moreOpen.value = false;
}

/** 点菜单外任意处关闭(与浮层的"点外部关闭"一致) */
function onDocMouseDown(e: MouseEvent): void {
  const el = e.target as HTMLElement | null;
  if (!el || !el.closest) { return; }
  if (el.closest('.src-menu') || el.closest('[data-src-import-toggle]') || el.closest('[data-src-more-toggle]')) {
    return;
  }
  closeMenus();
}

onMounted(function () { document.addEventListener('mousedown', onDocMouseDown); });
onBeforeUnmount(function () { document.removeEventListener('mousedown', onDocMouseDown); });

/** 子菜单项聚焦(方向键移动的核心) */
function menuItems(which: 'import' | 'more'): HTMLElement[] {
  const root = which === 'import' ? importMenuRef.value : moreMenuRef.value;
  if (!root) { return []; }
  return Array.from(root.querySelectorAll('[role="menuitem"]')) as HTMLElement[];
}

function focusMenuItem(which: 'import' | 'more', index: number): void {
  const items = menuItems(which);
  if (!items.length) { return; }
  const i = Math.max(0, Math.min(items.length - 1, index));
  items[i].focus();
}

/** 主操作按钮的键盘: Enter/Space 由原生 click 处理, 这里只补"展开即聚焦第一项" */
function onImportKey(e: KeyboardEvent): void {
  if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
    if (!importOpen.value) { return; }   // 交给原生 click 打开
    e.preventDefault();
    focusMenuItem('import', 0);
    return;
  }
  if (e.key === 'Escape' && importOpen.value) {
    e.preventDefault();
    e.stopPropagation();
    importOpen.value = false;
    importBtnRef.value?.focus();
  }
}

/**
 * 子菜单内的键盘: 上下移动 / Home / End / Esc / Enter。
 *
 * 处理过的键必须 stopPropagation: 否则同一次按键还会冒泡到 document,
 * 被 App 的 Esc 分层再消费一次(会一路把「书源」面板退回搜索页)。
 */
function onMenuKey(which: 'import' | 'more', e: KeyboardEvent): void {
  const items = menuItems(which);
  const current = items.indexOf(document.activeElement as HTMLElement);
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    e.stopPropagation();
    focusMenuItem(which, current + 1);
    return;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    e.stopPropagation();
    focusMenuItem(which, current - 1);
    return;
  }
  if (e.key === 'Home') { e.preventDefault(); e.stopPropagation(); focusMenuItem(which, 0); return; }
  if (e.key === 'End') { e.preventDefault(); e.stopPropagation(); focusMenuItem(which, items.length - 1); return; }
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeMenus();
    importBtnRef.value?.focus();
  }
}

function openImport(): void {
  importOpen.value = !importOpen.value;
  moreOpen.value = false;
  if (importOpen.value) {
    void nextTick(function () { focusMenuItem('import', 0); });
  }
}

function openMore(): void {
  moreOpen.value = !moreOpen.value;
  importOpen.value = false;
  if (moreOpen.value) {
    void nextTick(function () { focusMenuItem('more', 0); });
  }
}

function importBy(mode: 'url' | 'clipboard' | 'file'): void {
  closeMenus();
  send({ type: 'sourceImport', mode });
}

function check(s?: BookSourceView): void {
  send(s ? { type: 'sourceCheck', id: s.id } : { type: 'sourceCheck', scope: 'active' });
}

/** 「书源」Tab 自己的检查状态(与失效 Tab 完全独立) */
const checkState = computed(function () { return state.checkStates.active; });
const checkAllRunning = computed(function () { return checkState.value.running; });
const checkAllLabel = computed(function () {
  if (!checkState.value.running) { return '检查全部'; }
  return checkState.value.paused ? '继续' : '暂停';
});

/** 取消本次检查(已完成的结果保留) */
function cancelCheckAll(): void {
  const st = state.checkStates.active;
  send({ type: 'sourceCheckCancel', scope: 'active', runId: st.runId });
  st.running = false;
  st.paused = false;
}

function toggleCheckAll(): void {
  const st = state.checkStates.active;
  if (st.running) {
    st.paused = !st.paused;
    send({ type: 'sourceCheckPause', scope: 'active', paused: st.paused, runId: st.runId });
    return;
  }
  // 新一轮: 重置本 Tab 状态(不影响失效 Tab)
  st.runId += 1;
  st.running = true;
  st.paused = false;
  st.done = 0;
  st.total = 0;
  st.sourceName = '';
  send({ type: 'sourceCheck', scope: 'active', runId: st.runId });
}

function exportAll(): void {
  closeMenus();
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
  closeMenus();
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

/** 删除所选: 当前勾选(=启用)的书源; 扩展侧二次确认后批量删除 */
function removeSelected(): void {
  const ids = filtered.value.filter(function (s) { return s.enabled; }).map(function (s) { return s.id; });
  if (!ids.length) { return; }
  send({ type: 'sourceRemoveMany', ids });
}

/** 触底自动加载: 距底 32px 内追加一页 */
function onListScroll(): void {
  const el = listRef.value;
  if (!el || filtered.value.length <= limit.value) { return; }
  // happy-dom 没有真实布局(scrollHeight/clientHeight 常为 0), 此时不自动全量渲染
  if (el.scrollHeight <= el.clientHeight) { return; }
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 32) {
    limit.value += PAGE;
  }
}

/** Esc 分层: 先收子菜单, 再让位给"关面板" */
function handleEscape(): boolean {
  if (importOpen.value || moreOpen.value) {
    closeMenus();
    return true;
  }
  return false;
}

defineExpose({ handleEscape });
</script>

<template>
  <div class="popup-body src-manage-body">
    <!-- 工具区三层: 主操作(导入) / 次操作(检查全部) / 更多(低频) -->
    <div class="src-tools">
      <button ref="importBtnRef" class="popup-primary" data-src-import-toggle
        aria-haspopup="menu" :aria-expanded="importOpen ? 'true' : 'false'"
        aria-controls="srcImportMenu"
        :title="importOpen ? '收起导入方式' : '导入书源'" @click="openImport" @keydown="onImportKey">
        导入书源 ▾
      </button>
      <div v-if="importOpen" id="srcImportMenu" ref="importMenuRef" class="src-menu"
        role="menu" aria-label="导入书源" @keydown="onMenuKey('import', $event)">
        <button type="button" role="menuitem" class="src-menu-item" data-src-import="url"
          @click="importBy('url')">从 URL 导入</button>
        <button type="button" role="menuitem" class="src-menu-item" data-src-import="clipboard"
          @click="importBy('clipboard')">粘贴 JSON</button>
        <button type="button" role="menuitem" class="src-menu-item" data-src-import="file"
          @click="importBy('file')">本地文件</button>
      </div>

      <button class="popup-secondary" data-src-check-all @click="toggleCheckAll">{{ checkAllLabel }}</button>
      <button v-if="checkAllRunning && checkState.paused" class="popup-btn" data-src-check-cancel
        @click="cancelCheckAll">取消</button>

      <span class="spacer"></span>

      <button class="popup-btn" data-src-manage-toggle :aria-pressed="managing ? 'true' : 'false'"
        :title="managing ? '退出管理模式' : '管理模式（批量启用/停用/删除）'"
        @click="toggleManaging">{{ managing ? '完成' : '管理' }}</button>
      <button class="popup-btn" data-src-more-toggle
        aria-haspopup="menu" :aria-expanded="moreOpen ? 'true' : 'false'"
        aria-controls="srcMoreMenu" @click="openMore" @keydown="onImportKey">更多 ▾</button>
      <div v-if="moreOpen" id="srcMoreMenu" ref="moreMenuRef" class="src-menu"
        role="menu" aria-label="更多书源操作" @keydown="onMenuKey('more', $event)">
        <button type="button" role="menuitem" class="src-menu-item" data-src-export
          @click="exportAll">导出书源</button>
        <button type="button" role="menuitem" class="src-menu-item" data-src-disable-all
          @click="disableAll">全部停用</button>
      </div>
    </div>

    <div v-if="checkAllRunning" class="src-hint src-progress" data-src-check-progress>
      <span class="src-progress-prefix">{{ checkState.paused ? '已暂停' : '检查中' }}</span>
      <span class="src-progress-count">{{ checkState.done }}/{{ checkState.total }}</span>
      <span class="src-progress-name" :title="checkState.sourceName">{{ checkState.sourceName }}</span>
    </div>

    <!-- 批量条只在管理模式出现; 危险动作单独成区(分隔线隔开) -->
    <div v-if="managing" class="src-bulk" data-src-bulk>
      <input type="checkbox" class="src-check" id="srcBulkAll" data-src-all :checked="allChecked"
        :indeterminate.prop="someChecked" @change="toggleAll" />
      <label class="src-check-label" for="srcBulkAll">
        <span class="src-bulk-label">全选</span>
      </label>
      <span class="src-bulk-count">{{ enabledCount }} / {{ filtered.length }} 启用</span>
      <span class="spacer"></span>
      <button class="src-bulk-btn" data-src-invert @click="invertAll">反选</button>
      <button class="src-bulk-btn" data-src-clear @click="disableAll">全部停用</button>
      <span class="src-danger-zone">
        <button class="src-bulk-btn src-bulk-danger" data-src-remove-selected :disabled="!enabledCount"
          title="删除当前勾选的 N 个书源" @click="removeSelected">删除所选</button>
      </span>
    </div>

    <label class="sr-only" for="srcFilterInput">筛选书源</label>
    <input id="srcFilterInput" v-model="keyword" class="src-input src-filter" type="text"
      placeholder="筛选书源(名称/分组/地址)" aria-label="筛选书源（名称/分组/地址）" data-src-filter />

    <div v-if="!state.sources.length" class="popup-empty src-empty">
      <p>还没有书源。可以从 Yiove 等书源仓库复制导入地址。</p>
    </div>
    <div v-else-if="!filtered.length" class="popup-empty src-empty">没有匹配的书源</div>

    <div ref="listRef" class="src-list" data-src-list @scroll.passive="onListScroll">
    <template v-for="s in list" :key="s.id">
      <div class="src-row" :data-source-id="s.id">
        <!-- 复选框用 label 包住"勾选框 + 名称": 点名称也能切换, 命中面积覆盖整段文字 -->
        <label class="src-check-label" :for="'srcChk-' + s.id">
          <input :id="'srcChk-' + s.id" type="checkbox" class="src-check" :checked="s.enabled"
            :data-src-toggle="s.id"
            :aria-label="'启用书源：' + s.name"
            :title="s.enabled ? '已启用(参与搜索)' : '已停用'" @change="toggle(s)" />
          <span class="src-row-name" :title="s.name + ' · ' + s.url">{{ s.name }}</span>
        </label>
        <span class="src-status" :class="'is-' + checkStatus(s)">{{ statusText(s) }}</span>
        <span v-if="s.group" class="src-row-group" :title="s.group">{{ s.group }}</span>
        <span class="src-row-acts">
          <button class="src-ico" :data-src-check="s.id" title="检查"
            :aria-label="'检查书源：' + s.name" @click="check(s)">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 12a8.5 8.5 0 1 1-2.5-6"/><path d="M20.5 3.5V9H15"/></svg>
          </button>
          <button class="src-ico" :data-src-edit="s.id" title="编辑"
            :aria-label="'编辑书源：' + s.name" @click="startEdit(s)">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L20 8l-4-4L4 16v4Z"/><path d="M14 6l4 4"/></svg>
          </button>
          <button class="src-ico src-ico-del" :class="{ confirming: pendingDeleteId === s.id }"
            :data-src-del="s.id" :aria-label="'删除书源：' + s.name"
            :title="pendingDeleteId === s.id ? '再点一次确认删除' : '删除'" @click="askDelete(s)">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M6 7l1 13h10l1-13"/></svg>
            <span v-if="pendingDeleteId === s.id" class="src-ico-tip">确认</span>
          </button>
        </span>
      </div>
      <div v-if="state.sourceEditingId === s.id" class="src-edit">
        <label class="sr-only" :for="'srcEditName-' + s.id">书源名称</label>
        <input :id="'srcEditName-' + s.id" v-model="editName" class="src-input" data-src-edit-name
          placeholder="书源名称" aria-label="书源名称" />
        <label class="sr-only" :for="'srcEditUrl-' + s.id">搜索地址</label>
        <input :id="'srcEditUrl-' + s.id" v-model="editSearchUrl" class="src-input" data-src-edit-url
          placeholder="搜索地址, 支持 {{key}}" aria-label="搜索地址" />
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

    <p class="src-risk">勾选 = 启用并参与搜索；连续 2 次失败的书源会自动移到「失效」Tab（可重查恢复）。书源来自第三方，只导入你信任的。</p>
  </div>
</template>
