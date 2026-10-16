<script setup lang="ts">
/**
 * SideMenu.vue — 左侧常驻功能菜单(占位式: 参与标准流, 展开时把正文推右)
 * 菜单项只负责"打开对应弹窗", 弹窗互斥由 App 统一保证。
 */
import { state } from '../composables/vscode';

interface MenuItem {
  id: 'shelf' | 'catalog' | 'settings' | 'storage';
  name: string;
  key: 'shelfOpen' | 'catalogOpen' | 'settingsOpen' | 'storageOpen';
  icon: string; // path d
}

const items: MenuItem[] = [
  {
    id: 'shelf', name: '书架', key: 'shelfOpen',
    icon: 'M4 5.5h4.5v13H4zM10.5 5.5H20v13h-9.5z',
  },
  {
    id: 'catalog', name: '目录', key: 'catalogOpen',
    icon: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  },
  {
    id: 'settings', name: '阅读设置', key: 'settingsOpen',
    icon: 'M4 7V4h16v3M9 20h6M12 4v16',
  },
  {
    id: 'storage', name: '存储位置', key: 'storageOpen',
    icon: 'M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 21V11',
  },
];

function toggle(item: MenuItem): void {
  const key = item.key;
  const willOpen = !state[key];
  // 互斥: 先全部关闭, 再打开目标(唯一弹窗)
  state.catalogOpen = false;
  state.settingsOpen = false;
  state.shelfOpen = false;
  state.storageOpen = false;
  state[key] = willOpen;
}
</script>

<template>
  <nav class="menu" :class="{ expanded: state.menuExpanded }">
    <button class="menu-toggle" :title="state.menuExpanded ? '收起菜单' : '展开菜单'"
      @click="state.menuExpanded = !state.menuExpanded">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
        <path d="M4 6h16M4 12h16M4 18h16" />
      </svg>
      <span class="menu-label">菜单</span>
    </button>
    <button v-for="it in items" :key="it.id" class="menu-item"
      :class="{ active: state[it.key] }" :data-menu="it.id" :title="it.name" @click="toggle(it)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
        <path :d="it.icon" />
      </svg>
      <span class="menu-label">{{ it.name }}</span>
    </button>
  </nav>
</template>
