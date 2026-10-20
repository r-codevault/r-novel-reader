<script setup lang="ts">
/**
 * SideMenu.vue — 左侧常驻功能菜单(占位式: 参与标准流, 展开时把正文推右)
 * 菜单项只负责"打开对应弹窗", 弹窗互斥由 App 统一保证。
 */
import { computed } from 'vue';
import { state } from '../composables/vscode';
import { persistSettings } from '../store';

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

/** 笔记: 便签(线性, 与阅读设置/存储位置同族: 24×24 stroke 1.6 currentColor) */
const SVG_NOTES =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"' +
  ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M6.5 3.5h7l4 4v13h-11z"/>' +
  '<path d="M13.5 3.5v4h4"/>' +
  '<path d="M9 11.5h6M9 15h4"/></svg>';

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
      <!-- 品牌 logo(用户提供): 三色改为主题令牌(强调色/正文色/纸面色)。
           原先硬编码的橙 #ED8F27 / 深棕 #300604 / 米白 #FCE3C3 在多数主题下与侧栏底几乎同色。
           viewBox 收紧到图形实际边界(原 SVG 四周有 ~14% 空白, 会显得小且视觉偏左) -->
      <svg viewBox="158 184 686 720" aria-hidden="true">
        <path d="M430.602 443.728H172.941v409.721h257.661l9.723 22.763h123.159l12.965-22.763h251.179V437.225z" fill="var(--accent)" />
        <path d="M563.484 888.712H440.325l-11.495-7.59-6.48-15.173H172.94l-12.5-12.5v-409.72l12.5-12.5H430.5l396.923-6.502 12.705 12.498V853.45l-12.5 12.5H583.714l-9.367 16.449-10.863 6.313z m-114.906-25h107.641l9.367-16.449 10.862-6.313h238.68V449.931l-384.525 6.298H185.44V840.95h245.162l11.495 7.59 6.481 15.172z" fill="var(--chrome-fg)" />
        <path d="M772.531 386.823s-221.458-42.273-266.298 50.402l-22.982 384.568h52.685l4.862-31.937h231.733V386.823z" fill="var(--page-bg)" />
        <path d="M535.936 831.793h-52.685l-9.982-10.597 22.981-384.568 0.98-3.759c11.444-23.653 33.769-41.182 66.351-52.099 24.92-8.351 56.024-12.892 92.449-13.499 61.296-1.015 116.074 9.29 118.376 9.729l8.125 9.822v403.034l-10 10H549.39l-3.568 23.441-9.886 8.496z m-42.07-20h33.477l3.568-23.441 9.886-8.495h221.734V395.259c-17.44-2.796-60.6-8.781-106.461-7.984-93.223 1.611-127.655 29.096-139.979 52.604l-22.225 371.914z" fill="var(--chrome-fg)" />
        <path d="M224.797 386.823H469.99v403.034H224.797z" fill="var(--page-bg)" />
        <path d="M469.99 799.856H224.797l-10-10V386.822l10-10H469.99l10 10v403.034l-10 10z m-235.193-20H459.99V396.822H234.797v383.034z" fill="var(--chrome-fg)" />
        <path d="M292.542 310.406s139.34 22.474 190.709 81.026c27.337 31.16 26.78 73.506 26.78 73.506v317.628c0 12.645-6.106 24.506-16.384 31.825l-10.396 7.403s0.118-26.71-27.886-44.677-162.823-66.744-162.823-66.744V310.406z" fill="var(--page-bg)" />
        <path d="M489.052 829.938l-15.801-8.189c-0.013-0.789-0.575-21.645-23.286-36.216-21.401-13.731-114.557-49.018-160.825-65.758l-6.598-9.403V310.406l11.593-9.872c5.834 0.94 143.502 23.743 196.634 84.304 29.188 33.269 29.287 77.311 29.262 80.148v317.579c0 15.851-7.694 30.793-20.583 39.971l-10.396 7.402z m-186.51-126.567c27.82 10.177 132.917 49.092 158.224 65.328 17.225 11.052 25.318 25.077 29.12 35.95a29.13 29.13 0 0 0 10.145-22.084l0.001-317.76c0.003-0.365 0.059-39.017-24.297-66.778-40.047-45.646-139.256-68.81-173.192-75.589v380.933zM610.066 444.946h123.76v27.902h-123.76zM610.066 510.959h123.76v27.902h-123.76zM665.936 689.082h62.532v27.902h-62.532z" fill="var(--chrome-fg)" />
        <!-- 书上方的放射线条: 颜色由 CSS 给 var(--accent), 与主题高亮同色 -->
        <path class="logo-spark" d="M633.087 194.47l16.4 11.448-80.858 115.834-16.4-11.448zM725.26 204.73l13.734 14.54L634.785 317.7l-13.733-14.539zM800.489 240.542l13.142 15.076-52.696 45.935-13.142-15.076zM468.638 187.397l27.52 56.292-17.968 8.784-27.52-56.292zM331.501 204.24l120.28 98.428-12.666 15.478-120.28-98.427zM243.412 238.813l42.402 17.49-7.626 18.488-42.402-17.49z" />
      </svg>
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
