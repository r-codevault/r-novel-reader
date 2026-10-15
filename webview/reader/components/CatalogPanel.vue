<script setup lang="ts">
/**
 * CatalogPanel.vue — 目录面板(参考起点中文网目录)
 */
import { computed, ref, watch, nextTick } from 'vue';
import { state, gotoChapter } from '../composables/vscode';
import { chapterParts, buildCatalogGroups } from '../composables/catalog';

interface DisplayItem { index: number; no: string; name: string; title: string }
interface DisplayGroup {
  name: string; entry: number; collapsed: boolean; total: number;
  items: DisplayItem[]; entryNo: string; entryName: string;
}

const rootRef = ref<HTMLElement | null>(null);
const catBodyRef = ref<HTMLElement | null>(null);
defineExpose({ el: rootRef });

const groups = computed<DisplayGroup[]>(function () {
  let gs = buildCatalogGroups(state.chapters);
  if (state.catReverse) {
    gs = gs
      .slice()
      .reverse()
      .map(function (g) { return { name: g.name, entry: g.entry, items: g.items.slice().reverse() }; });
  }
  return gs.map(function (g) {
    const parts = g.entry >= 0 ? chapterParts(g.name) : { no: '', name: '' };
    return {
      name: g.name,
      entry: g.entry,
      collapsed: (state.catCollapsed || []).indexOf(g.name) >= 0,
      total: g.items.length + (g.entry >= 0 ? 1 : 0),
      items: g.items.map(function (c) {
        const p = chapterParts(c.title);
        return { index: c.index, no: p.no, name: p.name || c.title, title: c.title };
      }),
      entryNo: parts.no,
      entryName: g.entry >= 0 ? (parts.name || g.name) : '',
    };
  });
});

const subText = computed(function () {
  return state.chapters.length > 0 ? '共 ' + state.chapters.length + ' 章' : '';
});

const posText = computed(function () {
  if (!state.chapter || state.chapters.length === 0) { return ''; }
  return '第 ' + (state.chapter.index + 1) + ' / ' + state.chapters.length + ' 章';
});

function toggleGroup(g: DisplayGroup): void {
  const list = state.catCollapsed || [];
  const at = list.indexOf(g.name);
  if (g.collapsed) {
    if (at >= 0) { list.splice(at, 1); }
  } else {
    if (at < 0) { list.push(g.name); }
  }
  state.catCollapsed = list.slice();
}

function onItemClick(item: DisplayItem): void {
  gotoChapter(item.index);
  state.catalogOpen = false;
}

/** 当前章变化: 高亮/展开由响应式 class 驱动; 面板开着时滚到当前章 */
watch(function () { return state.chapter && state.chapter.index; }, function () {
  if (!catBodyRef.value) { return; }
  const cur = catBodyRef.value.querySelector('.cat-item.cur');
  if (cur) {
    const group = cur.closest('.cat-group');
    if (group && group.classList.contains('collapsed')) {
      const name = (group as HTMLElement).dataset.g as string;
      const list = state.catCollapsed || [];
      const at = list.indexOf(name);
      if (at >= 0) { list.splice(at, 1); state.catCollapsed = list.slice(); }
    }
  }
});

watch(function () { return state.catalogOpen; }, function (open) {
  if (open && state.chapters.length > 0) {
    nextTick(function () {
      const el = catBodyRef.value && catBodyRef.value.querySelector('.cat-item.cur');
      if (el) { el.scrollIntoView({ block: 'center' }); }
    });
  }
});
</script>

<template>
  <section id="catalogPanel" ref="rootRef" class="catalog-panel" :class="{ open: state.catalogOpen }">
    <div class="cat-head">
      <span class="cat-title">目录</span>
      <span class="cat-sub">{{ subText }}</span>
      <span class="spacer"></span>
      <button class="cat-btn" :class="{ on: state.catReverse }" @click="state.catReverse = !state.catReverse">
        {{ state.catReverse ? '正序' : '倒序' }}
      </button>
      <button class="cat-btn" :disabled="!state.chapter || state.chapter.index <= 0"
        @click="state.chapter && gotoChapter(state.chapter.index - 1)">上一章</button>
      <button class="cat-btn"
        :disabled="!state.chapter || !state.novel || state.chapter.index >= state.novel.totalChapters - 1"
        @click="state.chapter && gotoChapter(state.chapter.index + 1)">下一章</button>
      <button class="cat-btn" @click="state.catalogOpen = false">关闭</button>
    </div>
    <div ref="catBodyRef" class="cat-body">
      <div v-if="state.chapters.length === 0" class="empty-tip">尚未打开小说</div>
      <template v-else>
        <div v-for="g in groups" :key="g.name" class="cat-group" :class="{ collapsed: g.collapsed }" :data-g="g.name">
          <div class="cat-group-head" title="展开 / 收起本卷" @click="toggleGroup(g)">
            <span class="cat-group-name">{{ g.name }}</span>
            <span class="cat-group-count">共 {{ g.total }} 章</span>
            <span class="cat-group-toggle" title="展开 / 收起本卷">⌃</span>
          </div>
          <div class="cat-items">
            <div v-if="g.entry >= 0" class="cat-item" :data-i="g.entry" :title="g.name"
              :class="{ cur: state.chapter && state.chapter.index === g.entry }"
              @click="onItemClick({ index: g.entry, no: g.entryNo, name: g.entryName, title: g.name })">
              <span v-if="g.entryNo" class="cat-no">{{ g.entryNo }}</span>
              <span class="cat-name">{{ g.entryName }}</span>
            </div>
            <div v-for="c in g.items" :key="c.index" class="cat-item" :data-i="c.index" :title="c.title"
              :class="{ cur: state.chapter && state.chapter.index === c.index }" @click="onItemClick(c)">
              <span v-if="c.no" class="cat-no">{{ c.no }}</span>
              <span class="cat-name">{{ c.name }}</span>
            </div>
          </div>
        </div>
      </template>
    </div>
    <div class="cat-foot"><span>{{ posText }}</span></div>
  </section>
</template>
