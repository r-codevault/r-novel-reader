<script setup lang="ts">
/**
 * SideMenu.vue — 左侧常驻功能菜单(占位式: 参与标准流, 展开时把正文推右)
 * 菜单项只负责"打开对应弹窗", 弹窗互斥由 App 统一保证。
 */
import { computed } from 'vue';
import { state, send } from '../composables/vscode';
import { persistSettings } from '../store';
// 品牌 logo 小图(48px, 米色圆角底+图形留白); 构建时 <4KB 自动内联为 data URL
import logoUrl from '../assets/logo.png';
// 摸鱼模式: 偷懒的猫图标(用户提供的摸鱼猫, 1000×1000, fill 已转 currentColor); vite ?raw 原样引入
import SVG_SLACKER from '../assets/slacker-cat.svg?raw';

/** 状态栏显隐(默认显示) */
function statusBarVisible(): boolean {
  return !state.settings || state.settings.showStatusBar !== false;
}

function toggleStatusBar(): void {
  // 独立开关, 不影响已打开的弹窗
  persistSettings({ showStatusBar: !statusBarVisible() });
}

interface MenuItem {
  id: 'shelf' | 'catalog' | 'notes' | 'settings' | 'storage' | 'source';
  name: string;
  key: 'shelfOpen' | 'catalogOpen' | 'notesOpen' | 'settingsOpen' | 'storageOpen' | 'sourceOpen';
  /** 完整内联 SVG(fill/stroke 由各自定义, 颜色统一用 currentColor 跟随主题) */
  svg: string;
}

/** 书架: 书柜 + 三本书(中间一本用主题强调色) —— 设计稿矢量版 707×704 */
const SVG_SHELF =
  '<svg viewBox="0 0 707 704" aria-hidden="true">' +
  '<rect x="23" y="23" width="660" height="658" rx="96" fill="none" stroke="currentColor" stroke-width="46"/>' +
  '<rect x="110" y="120" width="90" height="380" rx="12" fill="currentColor"/>' +
  '<rect x="260" y="80" width="90" height="420" rx="12" fill="var(--sp-accent)"/>' +
  '<rect x="410" y="140" width="90" height="360" rx="12" fill="currentColor"/>' +
  '<path d="M70 560 H640 M150 583 V660 M560 583 V660" fill="none" stroke="currentColor" stroke-width="46" stroke-linecap="round"/>' +
  '</svg>';

/** 目录: 列表方框 + 三个圆点(首点强调色) + 三条线 —— 设计稿矢量版 */
const SVG_CATALOG =
  '<svg viewBox="0 0 707 704" aria-hidden="true">' +
  '<rect x="23" y="23" width="660" height="658" rx="96" fill="none" stroke="currentColor" stroke-width="46"/>' +
  '<circle cx="145" cy="185" r="34" fill="var(--sp-accent)"/>' +
  '<circle cx="145" cy="352" r="34" fill="currentColor"/>' +
  '<circle cx="145" cy="519" r="34" fill="currentColor"/>' +
  '<path d="M255 185 H560 M255 352 H500 M255 519 H440" fill="none" stroke="currentColor" stroke-width="46" stroke-linecap="round"/>' +
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

/** 阅读设置: 齿轮 + 中心强调色圆 —— 设计稿矢量版 */
const SVG_SETTINGS =
  '<svg viewBox="0 0 707 704" aria-hidden="true">' +
  '<g fill="currentColor">' +
  '<rect x="322" y="4" width="63" height="126" rx="20"/>' +
  '<rect x="322" y="4" width="63" height="126" rx="20" transform="rotate(45 353.5 352)"/>' +
  '<rect x="322" y="4" width="63" height="126" rx="20" transform="rotate(90 353.5 352)"/>' +
  '<rect x="322" y="4" width="63" height="126" rx="20" transform="rotate(135 353.5 352)"/>' +
  '<rect x="322" y="4" width="63" height="126" rx="20" transform="rotate(180 353.5 352)"/>' +
  '<rect x="322" y="4" width="63" height="126" rx="20" transform="rotate(225 353.5 352)"/>' +
  '<rect x="322" y="4" width="63" height="126" rx="20" transform="rotate(270 353.5 352)"/>' +
  '<rect x="322" y="4" width="63" height="126" rx="20" transform="rotate(315 353.5 352)"/>' +
  '</g>' +
  '<circle cx="353.5" cy="352" r="205" fill="none" stroke="currentColor" stroke-width="46"/>' +
  '<circle cx="353.5" cy="352" r="86" fill="var(--sp-accent)"/>' +
  '</svg>';

/** 书源: 云朵 + 下载箭头(箭头用主题强调色, 与其它图标语言一致) */
const SVG_SOURCE =
  '<svg viewBox="0 0 707 704" aria-hidden="true">' +
  '<path d="M196 500 C 116 500 62 442 62 372 C 62 306 112 252 176 244 C 194 158 268 96 356 96 C 456 96 536 170 544 268 C 612 280 660 334 660 400 C 660 452 630 490 590 512" fill="none" stroke="currentColor" stroke-width="46" stroke-linecap="round"/>' +
  '<path d="M353 430 V 590" fill="none" stroke="var(--sp-accent)" stroke-width="52" stroke-linecap="round"/>' +
  '<path d="M282 528 L 353 604 L 424 528" fill="none" stroke="var(--sp-accent)" stroke-width="52" stroke-linecap="round" stroke-linejoin="round"/>' +
  '</svg>';

/** 存储位置: 立方体 + 内部强调色块 —— 设计稿矢量版 */
const SVG_STORAGE =
  '<svg viewBox="0 0 707 704" aria-hidden="true">' +
  '<path d="M353 40 L660 210 V500 L353 670 L46 500 V210 Z" fill="none" stroke="currentColor" stroke-width="46" stroke-linejoin="round"/>' +
  '<path d="M46 210 L353 380 L660 210 M353 380 V670" fill="none" stroke="currentColor" stroke-width="46" stroke-linejoin="round"/>' +
  '<rect x="160" y="430" width="120" height="78" rx="16" fill="var(--sp-accent)"/>' +
  '</svg>';



const items: MenuItem[] = [
  { id: 'shelf', name: '书架', key: 'shelfOpen', svg: SVG_SHELF },
  { id: 'catalog', name: '目录', key: 'catalogOpen', svg: SVG_CATALOG },
  { id: 'notes', name: '笔记', key: 'notesOpen', svg: SVG_NOTES },
  { id: 'settings', name: '阅读设置', key: 'settingsOpen', svg: SVG_SETTINGS },
  { id: 'storage', name: '存储位置', key: 'storageOpen', svg: SVG_STORAGE },
  { id: 'source', name: '书源', key: 'sourceOpen', svg: SVG_SOURCE },
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
  state.sourceOpen = false;
  state[key] = willOpen;
}

/** 摸鱼模式: 不开弹窗, 直接请求扩展打开伪装代码文档(编辑器列) */
function startSlacker(): void {
  send({ type: 'slackerStart' });
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
        <svg viewBox="0 0 707 704" aria-hidden="true">
          <rect x="23" y="242" width="660" height="220" rx="110" fill="none" stroke="currentColor" stroke-width="46"/>
          <template v-if="statusBarVisible()">
            <!-- 显示中: 胶囊内强调色进度条 -->
            <rect x="100" y="300" width="230" height="104" rx="52" fill="var(--sp-accent)" />
            <path d="M380 352 H560" fill="none" stroke="currentColor" stroke-width="46" stroke-linecap="round" />
          </template>
          <template v-else>
            <!-- 隐藏: 空心细线 + 斜线 -->
            <path d="M300 352 H540" fill="none" stroke="currentColor" stroke-width="46" stroke-linecap="round" />
            <path d="M150 610 L570 110" fill="none" stroke="currentColor" stroke-width="46" stroke-linecap="round" />
          </template>
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

    <!-- 摸鱼模式: 动作入口(不开弹窗), 图标为趴着偷懒的猫(用户提供的摸鱼猫图标);
         摸鱼会话开启中高亮 -->
    <button class="menu-item" :class="{ active: state.slackerActive }" data-menu="slacker"
      title="摸鱼模式（伪装成写代码阅读）" @click="startSlacker">
      <span class="menu-ico" v-html="SVG_SLACKER"></span>
      <span class="menu-label">摸鱼模式</span>
    </button>
  </nav>
</template>
