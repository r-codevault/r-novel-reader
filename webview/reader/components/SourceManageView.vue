<script setup lang="ts">
/**
 * SourceManageView.vue — 书源管理(导入 / 启停 / 编辑 / 删除 / 检查 / 导出)
 *
 * 导入对话框(URL 输入、文件选择)由扩展侧命令完成, 这里只发模式。
 */
import { computed, ref } from 'vue';
import { send, state } from '../composables/vscode';
import type { BookSourceView } from '../composables/vscode';
import { filterSources, statusText } from '../composables/sourceView';

const keyword = ref('');
const pendingDeleteId = ref('');
/** 增量渲染: 几千条书源一次全渲染会卡, 先渲染 60 行, 滚动到底再加载 */
const PAGE = 60;
const limit = ref(PAGE);
const editName = ref('');
const editSearchUrl = ref('');

const filtered = computed(function () { return filterSources(state.sources, keyword.value); });
const list = computed(function () { return filtered.value.slice(0, limit.value); });
const restCount = computed(function () { return Math.max(0, filtered.value.length - limit.value); });

function loadMore(): void {
  limit.value += PAGE;
}

function importBy(mode: 'url' | 'clipboard' | 'file'): void {
  send({ type: 'sourceImport', mode });
}

function toggle(s: BookSourceView): void {
  send({ type: 'sourceToggle', id: s.id, enabled: !s.enabled });
}

function startEdit(s: BookSourceView): void {
  state.sourceEditingId = s.id;
  editName.value = s.name;
  editSearchUrl.value = s.searchUrl;
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

/** 两步删除: 第一次点变「确认删除」, 再点才真删 */
function askDelete(s: BookSourceView): void {
  if (pendingDeleteId.value === s.id) {
    send({ type: 'sourceRemove', id: s.id });
    pendingDeleteId.value = '';
    return;
  }
  pendingDeleteId.value = s.id;
}

function check(s?: BookSourceView): void {
  send({ type: 'sourceCheck', id: s ? s.id : undefined });
}

function exportAll(): void {
  send({ type: 'sourceExport' });
}
</script>

<template>
  <div class="popup-body">
    <div class="src-tools">
      <button class="popup-secondary" data-src-import="url" @click="importBy('url')">从 URL 导入</button>
      <button class="popup-secondary" data-src-import="clipboard" @click="importBy('clipboard')">粘贴 JSON</button>
      <button class="popup-secondary" data-src-import="file" @click="importBy('file')">本地文件</button>
      <span class="spacer"></span>
      <button class="popup-btn" @click="check()">检查全部</button>
      <button class="popup-btn" @click="exportAll">导出</button>
    </div>

    <input v-model="keyword" class="src-input src-filter" type="text" placeholder="筛选书源(名称/分组/地址)" />

    <div v-if="!state.sources.length" class="popup-empty src-empty">
      <p>还没有书源。可以从 Yiove 等书源仓库复制导入地址。</p>
    </div>
    <div v-else-if="!list.length" class="popup-empty src-empty">没有匹配的书源</div>

    <div v-for="s in list" :key="s.id" class="src-row" :data-source-id="s.id">
      <button class="src-switch" :class="{ on: s.enabled }" :title="s.enabled ? '点击停用' : '点击启用'"
        :data-src-toggle="s.id" @click="toggle(s)">
        <span class="src-knob"></span>
      </button>
      <div class="src-row-main">
        <div class="src-row-title">
          <span class="src-row-name" :title="s.name">{{ s.name }}</span>
          <span v-if="s.group" class="src-row-group">{{ s.group }}</span>
        </div>
        <div class="src-row-sub">
          <span class="src-status" :class="'is-' + (s.lastCheckOk === true ? 'ok' : s.lastCheckOk === false ? 'bad' : 'unknown')">
            {{ statusText(s) }}
          </span>
          <span v-if="s.lastCheckMessage" class="src-row-msg">{{ s.lastCheckMessage }}</span>
          <span v-else class="src-row-url">{{ s.url }}</span>
        </div>

        <div v-if="state.sourceEditingId === s.id" class="src-edit">
          <input v-model="editName" class="src-input" data-src-edit-name placeholder="书源名称" />
          <input v-model="editSearchUrl" class="src-input" data-src-edit-url placeholder="搜索地址, 支持 {{key}}" />
          <div class="src-edit-actions">
            <button class="popup-primary" data-src-edit-save @click="saveEdit">保存</button>
            <button class="popup-btn" @click="cancelEdit">取消</button>
          </div>
        </div>
      </div>
      <div class="src-row-acts">
        <button class="popup-btn" :data-src-check="s.id" @click="check(s)">检查</button>
        <button class="popup-btn" :data-src-edit="s.id" @click="startEdit(s)">编辑</button>
        <button class="popup-btn src-del" :class="{ confirming: pendingDeleteId === s.id }"
          :data-src-del="s.id" @click="askDelete(s)">
          {{ pendingDeleteId === s.id ? '确认删除' : '删除' }}
        </button>
      </div>
    </div>

    <button v-if="restCount > 0" class="popup-btn src-load-more" data-src-load-more @click="loadMore">
      加载更多（还有 {{ restCount }} 个）
    </button>
    <p class="src-risk">书源来自第三方, 可能失效或包含脚本。只导入你信任的书源。</p>
  </div>
</template>
