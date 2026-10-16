<script setup lang="ts">
/**
 * DrawerPanel.vue — 左侧抽屉(书架 / 目录 / 存储)
 * 由左侧边缘按钮展开/收起; 与目录浮层、设置面板互斥(由 App 协调)
 */
import { computed, ref, watch, nextTick } from 'vue';
import { state, gotoChapter, send, type ShelfItemView } from '../composables/vscode';
import { buildCatalogGroups, chapterParts } from '../composables/catalog';

const rootRef = ref<HTMLElement | null>(null);
defineExpose({ el: rootRef });

type Tab = 'shelf' | 'catalog' | 'storage';

const tabs: { id: Tab; name: string }[] = [
  { id: 'shelf', name: '书架' },
  { id: 'catalog', name: '目录' },
  { id: 'storage', name: '存储' },
];

const catBodyRef = ref<HTMLElement | null>(null);

// ---------------------------------------------------------------- 书架
const shelfHas = computed(function () { return state.shelf.length > 0; });

function shelfProgress(b: ShelfItemView): string {
  return b.chapterIndex >= 0
    ? '读至 第 ' + (b.chapterIndex + 1) + ' 章' + (b.totalChapters ? ' / 共 ' + b.totalChapters + ' 章' : '')
    : b.totalChapters
      ? '共 ' + b.totalChapters + ' 章 · 未开始'
      : '未开始阅读';
}

function onShelfClick(b: ShelfItemView, ev: MouseEvent): void {
  const target = ev.target as HTMLElement;
  if (target.closest && target.closest('.dw-del')) {
    ev.stopPropagation();
    send({ type: 'removeBook', filePath: b.filePath });
    return;
  }
  send({ type: 'openBook', filePath: b.filePath });
  state.drawerOpen = false;
}

// ---------------------------------------------------------------- 目录
interface DisplayItem { index: number; no: string; name: string; title: string }
interface DisplayGroup {
  name: string; entry: number; collapsed: boolean; total: number;
  items: DisplayItem[]; entryNo: string; entryName: string;
}

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

function onChapterClick(index: number): void {
  gotoChapter(index);
  state.drawerOpen = false;
}

/** 抽屉打开/切到目录页时, 把当前章滚到可见位置 */
watch([function () { return state.drawerOpen; }, function () { return state.drawerTab; }], function ([open, tab]) {
  if (!open || tab !== 'catalog' || !state.chapter) { return; }
  nextTick(function () {
    const el = catBodyRef.value && catBodyRef.value.querySelector('.cat-item.cur');
    if (el) { el.scrollIntoView({ block: 'center' }); }
  });
});

// ---------------------------------------------------------------- 存储
const libSet = computed(function () { return !!state.libraryPath; });
</script>

<template>
  <!-- 左侧展开/收起按钮(常驻) -->
  <button class="dw-toggle" :class="{ active: state.drawerOpen }" :title="state.drawerOpen ? '收起侧栏' : '展开侧栏'"
    @click="state.drawerOpen = !state.drawerOpen">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
      <path d="M4 5.5h4.5v13H4zM10.5 5.5H20v13h-9.5z" />
    </svg>
    <span class="dw-toggle-label">{{ state.drawerOpen ? '收起' : '书架' }}</span>
  </button>

  <aside id="drawer" ref="rootRef" class="drawer" :class="{ open: state.drawerOpen }">
    <div class="dw-tabs">
      <button v-for="t in tabs" :key="t.id" class="dw-tab" :class="{ active: state.drawerTab === t.id }"
        @click="state.drawerTab = t.id">{{ t.name }}</button>
      <span class="spacer"></span>
      <button class="dw-close" title="收起" @click="state.drawerOpen = false">✕</button>
    </div>

    <!-- 书架 -->
    <div class="dw-body" v-show="state.drawerTab === 'shelf'">
      <div class="list dw-list">
        <div v-for="b in state.shelf" :key="b.filePath" class="bk" :class="{ cur: b.current }"
          :title="b.title" @click="onShelfClick(b, $event)">
          <span class="bk-main">
            <span class="bk-title">{{ b.title }}</span>
            <span class="bk-sub">{{ shelfProgress(b) }}{{ b.author ? ' · ' + b.author : '' }}</span>
          </span>
          <span class="dw-del" title="从书架移除">✕</span>
        </div>
      </div>
      <div class="empty" v-show="!shelfHas">书架空空如也。</div>
      <div class="dw-foot">
        <button class="dw-add" title="添加本地 txt 小说" @click="send({ type: 'openFile' })">＋ 添加书籍</button>
        <div class="dw-count" v-show="shelfHas">共 {{ state.shelf.length }} 本 · 阅读进度自动记录</div>
      </div>
    </div>

    <!-- 目录 -->
    <div class="dw-body" v-show="state.drawerTab === 'catalog'">
      <div class="dw-cat-tools">
        <button class="dw-mini" :class="{ on: state.catReverse }" @click="state.catReverse = !state.catReverse">
          {{ state.catReverse ? '正序' : '倒序' }}
        </button>
        <span class="spacer"></span>
        <span class="dw-count" v-show="state.chapters.length">{{ state.chapter ? '第 ' + (state.chapter.index + 1) + ' / ' + state.chapters.length + ' 章' : '' }}</span>
      </div>
      <div class="cat-body dw-cat" ref="catBodyRef">
        <div v-if="state.chapters.length === 0" class="empty">尚未打开小说。</div>
        <template v-else>
          <div v-for="g in groups" :key="g.name" class="cat-group" :class="{ collapsed: g.collapsed }" :data-g="g.name">
            <div class="cat-group-head" title="展开 / 收起本卷" @click="toggleGroup(g)">
              <span class="cat-group-name">{{ g.name }}</span>
              <span class="cat-group-count">共 {{ g.total }} 章</span>
              <span class="cat-group-toggle">⌃</span>
            </div>
            <div class="cat-items">
              <div v-if="g.entry >= 0" class="cat-item" :data-i="g.entry" :title="g.name"
                :class="{ cur: state.chapter && state.chapter.index === g.entry }" @click="onChapterClick(g.entry)">
                <span v-if="g.entryNo" class="cat-no">{{ g.entryNo }}</span>
                <span class="cat-name">{{ g.entryName }}</span>
              </div>
              <div v-for="c in g.items" :key="c.index" class="cat-item" :data-i="c.index" :title="c.title"
                :class="{ cur: state.chapter && state.chapter.index === c.index }" @click="onChapterClick(c.index)">
                <span v-if="c.no" class="cat-no">{{ c.no }}</span>
                <span class="cat-name">{{ c.name }}</span>
              </div>
            </div>
          </div>
        </template>
      </div>
    </div>

    <!-- 存储 -->
    <div class="dw-body" v-show="state.drawerTab === 'storage'">
      <div class="dw-sec">
        <div class="dw-sec-h">存储位置</div>
        <div class="dw-row">
          <span class="dw-label">书库目录</span>
          <span class="dw-val" :class="{ empty: !libSet }" :title="state.libraryPath">{{ state.libraryPath || '未设置 · 读取文件原路径' }}</span>
        </div>
        <div class="dw-actions">
          <button class="dw-btn" @click="send({ type: 'pickLibrary' })">选择书库目录…</button>
          <button class="dw-btn" v-show="libSet" @click="send({ type: 'openLibraryFolder' })">在文件管理器中打开</button>
          <button class="dw-btn" v-show="libSet" @click="send({ type: 'clearLibrary' })">使用原路径（不拷贝）</button>
        </div>
        <p class="dw-tip">默认不设置：直接读取你选择的文件原路径。设置书库目录后，<b>导入时会把小说复制到该目录</b>并从副本读取，原文件之后可以自行移动或删除；同名文件会自动改名，不会覆盖。</p>
      </div>
      <div class="dw-sec">
        <p class="dw-tip">阅读设置（字号 / 字体 / 主题）在右侧工具栏的「阅读设置」里调整。</p>
      </div>
    </div>
  </aside>
</template>
