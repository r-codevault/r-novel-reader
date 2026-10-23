<script setup lang="ts">
/**
 * SourceDeadView.vue — 失效书源
 *
 * 任意一次失败(检查或搜索)自动进入这里, 同时退出搜索与「书源」列表。
 * 重查成功会自动恢复; 「恢复」只清失效标记不检查; 清除会真正删除数据。
 */
import { computed, ref } from 'vue';
import { send, state } from '../composables/vscode';
import type { BookSourceView } from '../composables/vscode';
import { deadSources } from '../composables/sourceView';

const pendingDeleteId = ref('');
const PAGE = 60;
const limit = ref(PAGE);

const dead = computed(function () { return deadSources(state.sources); });
const list = computed(function () { return dead.value.slice(0, limit.value); });
const restCount = computed(function () { return Math.max(0, dead.value.length - limit.value); });

function recheck(s: BookSourceView): void {
  send({ type: 'sourceCheck', id: s.id, scope: 'dead' });
}

function recheckAll(): void {
  send({ type: 'sourceCheck', scope: 'dead' });
}

function revive(s: BookSourceView): void {
  send({ type: 'sourceRevive', id: s.id });
}

function clearAll(): void {
  // 确认框在扩展侧(模态), 这里只发意图
  send({ type: 'sourceClearDead' });
}

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
  <div class="popup-body">
    <div class="src-tools">
      <span class="src-dead-title">共 {{ dead.length }} 个失效书源</span>
      <span class="spacer"></span>
      <button class="popup-btn" data-src-recheck-all :disabled="!dead.length" @click="recheckAll">全部重查</button>
      <button class="popup-btn src-del" data-src-clear-dead :disabled="!dead.length" @click="clearAll">清除全部</button>
    </div>
    <p class="src-risk">任意一次失败(检查或搜索)即判定失效并退出搜索；成功一次自动恢复。</p>

    <div v-if="!dead.length" class="popup-empty src-empty">没有失效的书源。</div>

    <div v-for="s in list" :key="s.id" class="src-row src-row-dead" :data-dead-id="s.id">
      <span class="src-row-name" :title="s.name + ' · ' + s.url">{{ s.name }}</span>
      <span class="src-dead-reason" :title="s.deadReason || '未知原因'">{{ s.deadReason || '未知原因' }}</span>
      <span class="src-dead-count">{{ s.failStreak }} 次失败</span>
      <span class="src-row-acts">
        <button class="src-ico" :data-src-recheck="s.id" title="重查(成功会自动恢复)" @click="recheck(s)">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 12a8.5 8.5 0 1 1-2.5-6"/><path d="M20.5 3.5V9H15"/></svg>
        </button>
        <button class="src-ico" :data-src-revive="s.id" title="恢复(不检查, 直接重新参与搜索)" @click="revive(s)">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>
        </button>
        <button class="src-ico src-ico-del" :class="{ confirming: pendingDeleteId === s.id }"
          :data-src-del="s.id" :title="pendingDeleteId === s.id ? '再点一次确认删除' : '删除'" @click="askDelete(s)">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M6 7l1 13h10l1-13"/></svg>
          <span v-if="pendingDeleteId === s.id" class="src-ico-tip">确认</span>
        </button>
      </span>
    </div>

    <button v-if="restCount > 0" class="popup-btn src-load-more" data-src-load-more @click="loadMore">
      加载更多（还有 {{ restCount }} 个）
    </button>
  </div>
</template>
