<script setup lang="ts">
/**
 * StoragePopup.vue — 存储位置弹窗(书库目录)
 * 弹窗互斥由 App 统一保证
 */
import { computed, ref } from 'vue';
import { state, send } from '../composables/vscode';

const rootRef = ref<HTMLElement | null>(null);
defineExpose({ el: rootRef });

const libSet = computed(function () { return !!state.libraryPath; });
</script>

<template>
  <section id="storagePopup" ref="rootRef" class="popup" :class="{ open: state.storageOpen }">
    <div class="popup-head">
      <b class="popup-title">存储位置</b>
      <span class="spacer"></span>
      <button class="popup-close" @click="state.storageOpen = false">关闭</button>
    </div>
    <div class="popup-body popup-body-pad">
      <div class="sp-row-line">
        <span class="popup-label">书库目录</span>
        <span class="popup-val" :class="{ empty: !libSet }" :title="state.libraryPath">{{ state.libraryPath || '未设置 · 读取文件原路径' }}</span>
      </div>
      <div class="popup-actions">
        <button class="popup-btn" @click="send({ type: 'pickLibrary' })">选择书库目录…</button>
        <button class="popup-btn" v-show="libSet" @click="send({ type: 'openLibraryFolder' })">在文件管理器中打开</button>
        <button class="popup-btn" v-show="libSet" @click="send({ type: 'clearLibrary' })">使用原路径（不拷贝）</button>
      </div>
      <p class="popup-tip">默认不设置：直接读取你选择的文件原路径。设置书库目录后，<b>导入时会把小说复制到该目录</b>并从副本读取，原文件之后可以自行移动或删除；同名文件会自动改名，不会覆盖。</p>
    </div>
  </section>
</template>
