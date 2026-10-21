<script setup lang="ts">
/**
 * SideMenu.vue — 左侧常驻功能菜单(占位式: 参与标准流, 展开时把正文推右)
 * 菜单项只负责"打开对应弹窗", 弹窗互斥由 App 统一保证。
 */
import { computed } from 'vue';
import { state } from '../composables/vscode';
import { persistSettings } from '../store';
// 品牌 logo 小图(48px, 米色圆角底+图形留白); 构建时 <4KB 自动内联为 data URL
import logoUrl from '../assets/logo.png';

/** 状态栏显隐(默认显示) */
function statusBarVisible(): boolean {
  return !state.settings || state.settings.showStatusBar !== false;
}

function toggleStatusBar(): void {
  // 独立开关, 不影响已打开的弹窗
  persistSettings({ showStatusBar: !statusBarVisible() });
}

interface MenuItem {
  id: 'shelf' | 'catalog' | 'notes' | 'settings' | 'storage';
  name: string;
  key: 'shelfOpen' | 'catalogOpen' | 'notesOpen' | 'settingsOpen' | 'storageOpen';
  /** 完整内联 SVG(fill/stroke 由各自定义, 颜色统一用 currentColor 跟随主题) */
  svg: string;
}

/** 书架: 书柜(用户提供) */
const SVG_SHELF =
  '<svg viewBox="0 0 1024 1024" fill="currentColor" aria-hidden="true">' +
  '<path d="M894.2 960.2h-767c-17.6 0-32-14.4-32-32v-834c0-17.6 14.4-32 32-32h767c17.6 0 32 14.4 32 32v834c0 17.7-14.4 32-32 32z m-759-40h751v-818h-751v818z"/>' +
  '<path d="M130.7 331.7h760v40h-760zM130.7 650.7h760v40h-760z"/>' +
  '<path d="M510.7 944c-11 0-20-9-20-20V86c0-11 9-20 20-20s20 9 20 20v838c0 11-9 20-20 20zM265.4 659.8c-9 0-17.1-6.1-19.4-15.2L218.6 535c-2.7-10.7 3.8-21.6 14.6-24.3 10.7-2.7 21.6 3.8 24.3 14.6l27.4 109.6c2.7 10.7-3.8 21.6-14.6 24.3-1.7 0.4-3.3 0.6-4.9 0.6zM195.4 660.8c-9 0-17.1-6.1-19.4-15.2L148.6 536c-2.7-10.7 3.8-21.6 14.6-24.3 10.7-2.7 21.6 3.8 24.3 14.6l27.4 109.6c2.7 10.7-3.8 21.6-14.6 24.3-1.7 0.4-3.3 0.6-4.9 0.6zM665.4 364.8c-9 0-17.1-6.1-19.4-15.2L618.6 240c-2.7-10.7 3.8-21.6 14.6-24.3 10.7-2.7 21.6 3.8 24.3 14.6l27.4 109.6c2.7 10.7-3.8 21.6-14.6 24.3-1.7 0.4-3.3 0.6-4.9 0.6zM595.4 365.8c-9 0-17.1-6.1-19.4-15.2L548.6 241c-2.7-10.7 3.8-21.6 14.6-24.3 10.7-2.7 21.6 3.8 24.3 14.6l27.4 109.6c2.7 10.7-3.8 21.6-14.6 24.3-1.7 0.4-3.3 0.6-4.9 0.6z"/>' +
  '<path d="M676.4 942.8c-9 0-17.1-6.1-19.4-15.2L629.6 818c-2.7-10.7 3.8-21.6 14.6-24.3 10.7-2.7 21.6 3.8 24.3 14.6l27.4 109.6c2.7 10.7-3.8 21.6-14.6 24.3-1.7 0.4-3.3 0.6-4.9 0.6zM606.4 943.8c-9 0-17.1-6.1-19.4-15.2L559.6 819c-2.7-10.7 3.8-21.6 14.6-24.3 10.7-2.7 21.6 3.8 24.3 14.6l27.4 109.6c2.7 10.7-3.8 21.6-14.6 24.3-1.7 0.4-3.3 0.6-4.9 0.6z"/>' +
  '</svg>';

/** 目录: 列表方框(用户提供, 去掉硬编码 fill 以跟随主题) */
const SVG_CATALOG =
  '<svg viewBox="0 0 1024 1024" fill="currentColor" aria-hidden="true">' +
  '<path d="M 863.113 0 H 160.887 A 161.064 161.064 0 0 0 0 160.887 v 702.225 a 161.064 161.064 0 0 0 160.887 160.887 h 702.225 a 161.064 161.064 0 0 0 160.887 -160.887 V 160.887 a 161.064 161.064 0 0 0 -160.887 -160.887 Z m 96.5324 863.113 a 96.6451 96.6451 0 0 1 -96.5324 96.5324 H 160.887 a 96.6451 96.6451 0 0 1 -96.5324 -96.5324 V 160.887 a 96.6451 96.6451 0 0 1 96.5324 -96.5324 h 702.225 a 96.6451 96.6451 0 0 1 96.5324 96.5324 Z"/>' +
  '<path d="M 776.941 484.062 H 416.087 a 24.1331 24.1331 0 0 0 0 48.2662 h 360.854 a 24.1331 24.1331 0 0 0 0 -48.2662 Z M 776.941 284.771 H 416.087 a 24.1331 24.1331 0 0 0 0 48.2662 h 360.854 a 24.1331 24.1331 0 0 0 0 -48.2662 Z M 776.941 677.642 H 416.087 a 24.1331 24.1331 0 0 0 0 48.2662 h 360.854 a 24.1331 24.1331 0 0 0 0 -48.2662 Z M 242.94 484.062 h -6.06545 a 24.1331 24.1331 0 0 0 0 48.2662 H 242.94 a 24.1331 24.1331 0 0 0 0 -48.2662 Z M 242.94 284.771 h -6.06545 a 24.1331 24.1331 0 0 0 0 48.2662 H 242.94 a 24.1331 24.1331 0 0 0 0 -48.2662 Z M 242.94 677.642 h -6.06545 a 24.1331 24.1331 0 0 0 0 48.2662 H 242.94 a 24.1331 24.1331 0 0 0 0 -48.2662 Z"/>' +
  '</svg>';

/** 笔记: 纸+笔(来自设计稿的矢量化版本, 707×704)
 *  笔杆填充绑定主题强调色 var(--sp-accent), 纸/线/笔沿用 currentColor —— 切换主题时实时跟随 */
const SVG_NOTES =
  '<svg viewBox="0 0 707 704" aria-hidden="true">' +
  '<path d="M 552 205 V 118 A 110 110 0 0 0 442 8 H 118 A 110 110 0 0 0 8 118 V 552 A 110 110 0 0 0 118 662 H 208" fill="none" stroke="currentColor" stroke-width="46" stroke-linecap="round"/>' +
  '<path d="M 158 182 H 468" fill="none" stroke="currentColor" stroke-width="46" stroke-linecap="round"/>' +
  '<path d="M 158 312 H 342" fill="none" stroke="currentColor" stroke-width="46" stroke-linecap="round"/>' +
  '<g transform="translate(300,655) rotate(-45)">' +
  '<path d="M 0 0 L 118 -80 H 446 A 46 46 0 0 1 446 80 H 118 Z" fill="currentColor"/>' +
  '<path d="M 132 -46 H 438 A 18 18 0 0 1 438 46 H 132 Z" fill="var(--sp-accent)"/>' +
  '</g></svg>';

/** 阅读设置: 字号图标(线性) */
const SVG_SETTINGS =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">' +
  '<path d="M4 7V4h16v3M9 20h6M12 4v16"/></svg>';

/** 存储位置: 立方体(线性) */
const SVG_STORAGE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">' +
  '<path d="M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 21V11"/></svg>';

const items: MenuItem[] = [
  { id: 'shelf', name: '书架', key: 'shelfOpen', svg: SVG_SHELF },
  { id: 'catalog', name: '目录', key: 'catalogOpen', svg: SVG_CATALOG },
  { id: 'notes', name: '笔记', key: 'notesOpen', svg: SVG_NOTES },
  { id: 'settings', name: '阅读设置', key: 'settingsOpen', svg: SVG_SETTINGS },
  { id: 'storage', name: '存储位置', key: 'storageOpen', svg: SVG_STORAGE },
];

/** 当前书的笔记条数(角标; 0 不显示) */
const currentNoteCount = computed(function () {
  const path = state.novel && (state.novel as { filePath?: string }).filePath;
  if (!path) { return 0; }
  return state.notes.filter(function (n) { return n.bookPath === path; }).length;
});

function toggle(item: MenuItem): void {
  const key = item.key;
  const willOpen = !state[key];
  // 互斥: 先全部关闭, 再打开目标(唯一弹窗)
  state.catalogOpen = false;
  state.settingsOpen = false;
  state.shelfOpen = false;
  state.storageOpen = false;
  state.notesOpen = false;
  state[key] = willOpen;
}
</script>

<template>
  <nav class="menu" :class="{ expanded: state.menuExpanded }">
    <button class="menu-toggle" :title="state.menuExpanded ? '收起菜单' : '展开菜单'"
      @click="state.menuExpanded = !state.menuExpanded">
      <!-- 品牌 logo(用户提供的锐阅读器图标): 位图小图(米色圆角底+图形留白),
           构建时内联为 data URL, 深色/浅色侧栏下都清晰 -->
      <img class="menu-logo" :src="logoUrl" alt="锐阅读器" aria-hidden="true" />
    </button>

    <!-- 菜单分隔线(位于折叠按钮与菜单项之间) -->
    <div class="menu-divider"></div>

    <button v-for="it in items.filter(function (x) { return x.id === 'shelf' || x.id === 'catalog' || x.id === 'notes'; })"
      :key="it.id" class="menu-item" :class="{ active: state[it.key] }" :data-menu="it.id"
      :title="it.name" @click="toggle(it)">
      <span class="menu-ico" v-html="it.svg"></span>
      <span class="menu-label">{{ it.name }}</span>
      <span v-if="it.id === 'notes' && currentNoteCount > 0" class="menu-badge">{{ currentNoteCount }}</span>
    </button>

    <!-- 状态栏显示/隐藏开关(默认显示; 放在「目录」下方)
         图标: 底栏样式(矩形+底部实心条), 避免用眼睛被误认为护眼模式 -->
    <button class="menu-item menu-toggle-statusbar" :class="{ active: statusBarVisible() }"
      :data-menu="'statusbar'" :title="statusBarVisible() ? '隐藏状态栏' : '显示状态栏'"
      @click="toggleStatusBar">
      <span class="menu-ico">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="4" width="18" height="16" rx="2.5" />
          <!-- 底部条: 显示中为实心块, 隐藏时为空心细线 -->
          <rect v-if="statusBarVisible()" x="6.5" y="15" width="11" height="2.4" rx="1"
            fill="currentColor" stroke="none" />
          <path v-else d="M6.5 16.2h11" />
          <!-- 隐藏时加斜线, 与"已关闭"语义一致 -->
          <path v-if="!statusBarVisible()" d="M4 20L20 4" />
        </svg>
      </span>
      <span class="menu-label">状态栏</span>
    </button>

    <button v-for="it in items.filter(function (x) { return x.id !== 'shelf' && x.id !== 'catalog' && x.id !== 'notes'; })"
      :key="it.id" class="menu-item" :class="{ active: state[it.key] }" :data-menu="it.id"
      :title="it.name" @click="toggle(it)">
      <span class="menu-ico" v-html="it.svg"></span>
      <span class="menu-label">{{ it.name }}</span>
    </button>
  </nav>
</template>
