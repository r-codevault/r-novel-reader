<script setup lang="ts">
/**
 * CatalogPanel.vue — 目录面板(参考起点中文网目录)
 */
import { computed, ref, watch, nextTick } from 'vue';
import { state, gotoChapter } from '../composables/vscode';
import { startDownload, pauseDownload, resumeDownload, cancelDownload, exportOfflineTxt } from '../composables/offline';
import { chapterParts, buildCatalogGroups, isVolumeTitle } from '../composables/catalog';

interface DisplayItem {
  index: number; no: string; name: string; title: string;
  /** 断网可读性: offline=已下载(永久) / cache=仅临时缓存 / ''=需要联网 */
  mark: '' | 'offline' | 'cache';
  /** 已读(在「读到的最大章号」之前, 或读过并留有位置记忆) */
  read: boolean;
}
interface DisplayGroup {
  name: string; entry: number; collapsed: boolean; total: number;
  items: DisplayItem[];
}

const rootRef = ref<HTMLElement | null>(null);
const catBodyRef = ref<HTMLElement | null>(null);
defineExpose({ el: rootRef, handleEscape });

// ---------------------------------------------------------------- 每章标记

/** 只有在线书才需要区分「联网 / 已缓存 / 已下载」; 本地 txt 全都能离线读 */
const isOnline = computed(function () { return !!(state.novel && state.novel.online); });
/** 主动下载的章(永久离线, 删书架时可选保留) */
const downloaded = computed(function () { return (state.offline && state.offline.downloaded) || []; });
const dlSet = computed(function () { return new Set(downloaded.value); });
/** 临时读缓存(读过就存, 清缓存/删书架会没) */
const cachedSet = computed(function () { return new Set(state.marks.cached || []); });
const readSet = computed(function () { return new Set(state.marks.read || []); });
const readUpTo = computed(function () { return state.marks.readUpTo; });
const totalChapters = computed(function () { return state.chapters.length; });

function markOf(index: number): '' | 'offline' | 'cache' {
  if (dlSet.value.has(index)) { return 'offline'; }
  if (cachedSet.value.has(index)) { return 'cache'; }
  return '';
}

function isReadChapter(index: number): boolean {
  return index < readUpTo.value || readSet.value.has(index);
}

const offlineCount = computed(function () { return downloaded.value.length; });
const cacheOnlyCount = computed(function () {
  const cached = state.marks.cached || [];
  let n = 0;
  for (const i of cached) { if (!dlSet.value.has(i)) { n += 1; } }
  return n;
});
/** 既没下载也没缓存的章(需要联网才能读) */
const noneCount = computed(function () {
  return Math.max(0, totalChapters.value - offlineCount.value - cacheOnlyCount.value);
});

const filterKey = computed(function () { return state.catFilter || 'all'; });

/**
 * 筛选项(同时充当圆点图例: 实心=已下载 / 空心=仅缓存)。
 * 计数为 0 的项直接不显示 —— 没有内容可筛时留个空按钮只会误导。
 */
const chips = computed(function () {
  const out: { key: 'all' | 'offline' | 'cache' | 'none'; label: string; count: number }[] = [];
  out.push({ key: 'all', label: '全部', count: totalChapters.value });
  if (offlineCount.value > 0) { out.push({ key: 'offline', label: '已下载', count: offlineCount.value }); }
  if (cacheOnlyCount.value > 0) { out.push({ key: 'cache', label: '仅缓存', count: cacheOnlyCount.value }); }
  if (noneCount.value > 0) { out.push({ key: 'none', label: '需联网', count: noneCount.value }); }
  return out;
});

// 正在用的筛选项如果变成 0 条(例如离线内容被清空), 自动退回「全部」
watch(chips, function (list) {
  const key = filterKey.value;
  if (key === 'all') { return; }
  if (!list.some(function (c) { return c.key === key; })) { state.catFilter = 'all'; }
});

function setFilter(key: 'all' | 'offline' | 'cache' | 'none'): void {
  state.catFilter = state.catFilter === key ? 'all' : key;
}

function inFilter(index: number): boolean {
  const f = filterKey.value;
  if (f === 'all') { return true; }
  const mark = markOf(index);
  if (f === 'none') { return mark === ''; }
  return mark === f;
}

const groups = computed<DisplayGroup[]>(function () {
  let gs = buildCatalogGroups(state.chapters);
  if (state.catReverse) {
    gs = gs
      .slice()
      .reverse()
      .map(function (g) { return { name: g.name, entry: g.entry, items: g.items.slice().reverse() }; });
  }
  return gs
    .map(function (g) {
      const items = g.items
        .map(function (c) {
          const p = chapterParts(c.title);
          return {
            index: c.index,
            no: p.no,
            name: p.name || c.title,
            title: c.title,
            mark: markOf(c.index),
            read: isReadChapter(c.index),
          };
        })
        .filter(function (it) { return inFilter(it.index); });
      return {
        name: g.name,
        entry: g.entry,
        collapsed: (state.catCollapsed || []).indexOf(g.name) >= 0,
        // 卷头的「共 N 章」跟随筛选后的条数, 否则筛完还显示原卷规模会很怪
        total: items.length,
        items,
      };
    })
    // 筛选后没有命中的卷整块隐藏
    .filter(function (g) { return g.items.length > 0; });
});

/** 总章数不含卷/篇标题行(篇名不算一章); 筛选时改为显示命中条数 */
const subText = computed(function () {
  const f = filterKey.value;
  if (f === 'offline') { return '已下载 ' + offlineCount.value + ' 章'; }
  if (f === 'cache') { return '仅缓存 ' + cacheOnlyCount.value + ' 章'; }
  if (f === 'none') { return '需联网 ' + noneCount.value + ' 章'; }
  const n = state.chapters.filter(function (c) { return !isVolumeTitle(c.title); }).length;
  return n > 0 ? '共 ' + n + ' 章' : '';
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

/** 窄屏折叠的次级动作（正序/上一章/下一章） */
const catMoreOpen = ref(false);
function toggleCatMore(): void {
  catMoreOpen.value = !catMoreOpen.value;
}

/**
 * Esc 分层的第一层：先收起「更多」折叠菜单。
 * 返回 true = 这一层已消费，App 不再关面板。
 */
function handleEscape(): boolean {
  if (catMoreOpen.value) {
    catMoreOpen.value = false;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- 离线下载

const dlDone = computed(function () { return downloaded.value.length; });
const dlFailed = computed(function () { return (state.offline && state.offline.failed) || 0; });
const dlRunning = computed(function () {
  if (state.dlRun) { return state.dlRun.running; }
  return !!(state.offline && state.offline.running);
});
const dlPaused = computed(function () { return !!(state.dlRun && state.dlRun.paused); });

/** 进度条: 优先本轮范围进度, 没有则按全书已下载比例 */
const dlPct = computed(function () {
  const run = state.dlRun;
  if (run && run.total > 0 && run.running) {
    return Math.min(100, Math.round((run.done / run.total) * 100));
  }
  const total = totalChapters.value;
  return total > 0 ? Math.min(100, Math.round((dlDone.value / total) * 100)) : 0;
});

const dlText = computed(function () {
  const total = totalChapters.value;
  const run = state.dlRun;
  if (run && run.running) {
    return (run.paused ? '已暂停 · ' : '下载中 · ') + run.done + '/' + run.total +
      (run.failed ? ' · 失败 ' + run.failed : '');
  }
  if (dlDone.value > 0) {
    return '已下载 ' + dlDone.value + '/' + total + ' 章' + (dlFailed.value ? ' · 失败 ' + dlFailed.value : '');
  }
  return total ? '尚未下载（共 ' + total + ' 章）' : '';
});

const dlStart = ref(1);
const dlEnd = ref(1);

function toggleDlRow(): void {
  state.dlRowOpen = !state.dlRowOpen;
  if (state.dlRowOpen) {
    dlStart.value = 1;
    dlEnd.value = totalChapters.value || 1;
  }
}

/** 整本: 1 → 末章 */
function fillWhole(): void {
  dlStart.value = 1;
  dlEnd.value = totalChapters.value || 1;
}

/** 当前章起: 当前章 → 末章(适合只补后面没读过的) */
function fillFromCurrent(): void {
  const cur = state.chapter ? state.chapter.index + 1 : 1;
  dlStart.value = Math.min(Math.max(1, cur), totalChapters.value || 1);
  dlEnd.value = totalChapters.value || 1;
}

/** 界面 1 基 → 协议 0 基(含端点), 只在这里换算一次 */
function startDl(): void {
  const last = totalChapters.value;
  if (!last) { return; }
  const a = Math.min(Math.max(1, Math.round(Number(dlStart.value) || 1)), last);
  const b = Math.min(Math.max(a, Math.round(Number(dlEnd.value) || last)), last);
  dlStart.value = a;
  dlEnd.value = b;
  startDownload(a - 1, b - 1);
}

function togglePause(): void {
  if (dlPaused.value) { resumeDownload(); } else { pauseDownload(); }
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
  <section id="catalogPanel" ref="rootRef" class="catalog-panel" :class="{ open: state.catalogOpen }"
    role="dialog" aria-modal="false" aria-labelledby="catalogPanelTitle">
    <div class="cat-head">
      <h2 class="cat-title" id="catalogPanelTitle" tabindex="-1">目录</h2>
      <span class="cat-sub">{{ subText }}</span>
      <span class="spacer"></span>
      <button v-if="isOnline" class="cat-btn" data-cat-dl :class="{ on: state.dlRowOpen }"
        title="下载整本或指定区间，断网也能读" @click="toggleDlRow">下载</button>
      <!-- 宽屏常显的次级动作；窄屏(≤576px)由 CSS 隐藏，收进「更多」 -->
      <span class="cat-tools-secondary">
        <button class="cat-btn" :class="{ on: state.catReverse }" @click="state.catReverse = !state.catReverse">
          {{ state.catReverse ? '正序' : '倒序' }}
        </button>
        <button class="cat-btn" :disabled="!state.chapter || state.chapter.index <= 0"
          @click="state.chapter && gotoChapter(state.chapter.index - 1, 'prev')">上一章</button>
        <button class="cat-btn"
          :disabled="!state.chapter || !state.novel || state.chapter.index >= state.novel.totalChapters - 1"
          @click="state.chapter && gotoChapter(state.chapter.index + 1, 'next')">下一章</button>
      </span>
      <button class="cat-btn cat-more" data-cat-more :aria-expanded="catMoreOpen" aria-controls="catMoreMenu"
        title="更多目录操作" @click="toggleCatMore">更多</button>
      <button class="cat-btn" @click="state.catalogOpen = false">关闭</button>
    </div>
    <!-- 窄屏「更多」展开的菜单: 渲染同一组按钮, 不复制逻辑 -->
    <div v-if="catMoreOpen" id="catMoreMenu" class="cat-more-menu">
      <button class="cat-btn" :class="{ on: state.catReverse }" @click="state.catReverse = !state.catReverse">
        {{ state.catReverse ? '正序' : '倒序' }}
      </button>
      <button class="cat-btn" :disabled="!state.chapter || state.chapter.index <= 0"
        @click="state.chapter && gotoChapter(state.chapter.index - 1, 'prev')">上一章</button>
      <button class="cat-btn"
        :disabled="!state.chapter || !state.novel || state.chapter.index >= state.novel.totalChapters - 1"
        @click="state.chapter && gotoChapter(state.chapter.index + 1, 'next')">下一章</button>
    </div>
    <!-- 下载范围行: 起止章 + 快捷范围 + 开始/暂停/取消 + 进度 -->
    <div v-if="isOnline && state.dlRowOpen" class="cat-dl" data-cat-dl-row>
      <span class="cat-dl-label">第</span>
      <input v-model.number="dlStart" data-cat-dl-start type="number" min="1" :max="totalChapters" aria-label="起始章" />
      <span class="cat-dl-label">至</span>
      <input v-model.number="dlEnd" data-cat-dl-end type="number" min="1" :max="totalChapters" aria-label="结束章" />
      <span class="cat-dl-label">章</span>
      <button class="popup-btn cat-dl-mini" @click="fillWhole">整本</button>
      <button class="popup-btn cat-dl-mini" @click="fillFromCurrent">当前章起</button>
      <button v-if="!dlRunning" class="popup-primary cat-dl-go" data-cat-dl-go
        :disabled="!totalChapters" @click="startDl">开始下载</button>
      <template v-else>
        <button class="popup-btn cat-dl-mini" data-cat-dl-pause @click="togglePause">
          {{ dlPaused ? '继续' : '暂停' }}
        </button>
        <button class="popup-btn cat-dl-mini" data-cat-dl-cancel @click="cancelDownload">取消</button>
      </template>
      <button v-if="dlDone > 0 && !dlRunning" class="popup-btn cat-dl-mini"
        data-cat-dl-export title="把已下载的章节导出成一本本地 txt" @click="exportOfflineTxt">导出 txt</button>
      <span class="spacer"></span>
      <span class="cat-dl-text" data-cat-dl-text>{{ dlText }}</span>
    </div>
    <div v-if="isOnline && (dlRunning || dlDone > 0)" class="cat-bar" role="progressbar"
      aria-label="正在下载章节" :aria-valuemin="0" :aria-valuemax="100" :aria-valuenow="dlPct"><i :style="{ width: dlPct + '%' }"></i></div>
    <div v-if="isOnline && state.dlNotice" class="cat-dl-notice" data-cat-dl-notice>{{ state.dlNotice }}</div>
    <div ref="catBodyRef" class="cat-body">
      <div v-if="state.chapters.length === 0" class="empty-tip">尚未打开小说</div>
      <div v-else-if="groups.length === 0" class="empty-tip" data-cat-empty>没有符合条件的章节</div>
      <template v-else>
        <div v-for="(g, gi) in groups" :key="g.name" class="cat-group" :class="{ collapsed: g.collapsed }" :data-g="g.name">
          <!-- 卷头是原生 button: 自带 Enter/Space, aria-expanded/aria-controls 让读屏知道它控制哪一块 -->
          <button type="button" class="cat-group-head" :aria-expanded="!g.collapsed"
            :aria-controls="'cat-items-' + gi" title="展开 / 收起本卷" @click="toggleGroup(g)">
            <span class="cat-group-name">{{ g.name }}</span>
            <span class="cat-group-count">共 {{ g.total }} 章</span>
            <span class="cat-group-toggle" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <path d="M6 15l6-6 6 6" />
              </svg>
            </span>
          </button>
          <div class="cat-items" :id="'cat-items-' + gi">
            <!-- 卷/篇标题行不再作为目录条目(它是分组头, 不是一章);
                 其卷首引子内容仍保留在章节流里, 从组内第一章「上一章」可达 -->
            <button v-for="c in g.items" :key="c.index" type="button" class="cat-item" :data-i="c.index"
              :class="{ cur: state.chapter && state.chapter.index === c.index, read: c.read }"
              :aria-current="state.chapter && state.chapter.index === c.index ? 'true' : undefined"
              :title="c.title + (c.mark === 'offline' ? ' · 已下载（断网可读）' : c.mark === 'cache' ? ' · 已缓存（断网可读）' : '')"
              @click="onItemClick(c)">
              <span v-if="c.no" class="cat-no">{{ c.no }}</span>
              <span class="cat-name">{{ c.name }}</span>
              <span v-if="c.mark" class="cat-dot" :class="'is-' + c.mark" :data-cat-mark="c.mark"
                :title="c.mark === 'offline' ? '已下载' : '已缓存（临时）'"></span>
            </button>
          </div>
        </div>
      </template>
    </div>
    <div class="cat-foot">
      <span>{{ posText }}</span>
      <!-- 筛选项同时充当圆点图例: 实心=已下载(永久), 空心=仅缓存(临时) -->
      <div v-if="isOnline && chips.length > 1" class="cat-filter" data-cat-filter>
        <button v-for="c in chips" :key="c.key" class="cat-chip" :class="{ on: filterKey === c.key }"
          :data-cat-chip="c.key" :title="c.key === 'all' ? '显示全部章节' : '只看' + c.label + '的章节'"
          @click="setFilter(c.key)">
          <i v-if="c.key === 'offline' || c.key === 'cache'" class="cat-dot" :class="'is-' + c.key"></i>
          {{ c.label }} {{ c.count }}
        </button>
      </div>
    </div>
  </section>
</template>
