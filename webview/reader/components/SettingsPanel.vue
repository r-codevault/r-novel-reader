<script setup lang="ts">
/**
 * SettingsPanel.vue — 设置面板(起点风格)
 * 面板定位(贴合悬浮球)由 App 协调, 本组件暴露根元素
 */
import { computed, ref } from 'vue';
import { state, THEMES, persistSettings, pickCustomTheme, stepFontSize, stepSetting, resetSettings } from '../store';
import { shortcutLabel } from '../composables/shortcut';

const rootRef = ref<HTMLElement | null>(null);
defineExpose({ el: rootRef });

/** 自定义主题滑块(遮罩浓度/模糊): 输入即生效 */
function onSlider(key: 'customBgMask' | 'customBgBlur', e: Event): void {
  const v = Number((e.target as HTMLInputElement).value);
  if (!Number.isFinite(v)) { return; }
  persistSettings({ [key]: v } as Record<string, number>);
}

const widthSteps = [640, 800, 1000, 1200];
const fontOptions = [
  { id: 'heiti', name: '黑体' },
  { id: 'songti', name: '宋体' },
  { id: 'kaiti', name: '楷体' },
];

const settings = computed(() => state.settings);
const shortcutHintText = computed(function () {
  const s = state.settings;
  if (!s) { return ''; }
  return 'Ctrl + 滚轮 缩放字号 · 上一章 ' + shortcutLabel(s.shortcutPrev) +
    ' · 下一章 ' + shortcutLabel(s.shortcutNext) +
    '（可在 VS Code 设置中自定义）';
});
</script>

<template>
  <section id="settingsPanel" ref="rootRef" class="settings-panel" :class="{ open: state.settingsOpen }">
    <div class="sp-head">
      <b class="sp-title">设置</b>
      <span class="spacer"></span>
      <button class="popup-close" @click.stop="state.settingsOpen = false">关闭</button>
    </div>
    <div class="sp-row">
      <span class="sp-label">阅读主题</span>
      <div class="sp-themes">
        <span v-for="t in THEMES" :key="t.id" class="sp-dot" :data-theme="t.id" :title="t.name"
          :style="{ background: t.id === 'dark' ? '#1c1c1c' : t.bg, color: t.fg, '--sp-check': t.fg }"
          :class="{ active: settings && settings.theme === t.id }"
          @click="persistSettings({ theme: t.id })"></span>
        <!-- 自定义: 点一下选一张本地图片当阅读背景 -->
        <span class="sp-dot sp-dot-custom" data-theme="custom" title="自定义背景图(选择本地图片)"
          :class="{ active: settings && settings.theme === 'custom' }"
          @click="pickCustomTheme()">＋</span>
      </div>
    </div>
    <!-- 自定义主题: 遮罩浓度 + 模糊(保证任何图片下正文都看得清) -->
    <div class="sp-row" v-if="settings && settings.theme === 'custom'">
      <span class="sp-label">背景调节</span>
      <div class="sp-sliders">
        <div class="sp-slider-row">
          <label>遮罩浓度</label>
          <input type="range" min="0" max="100" step="5" :value="settings.customBgMask"
            @input="onSlider('customBgMask', $event)" />
          <span class="sp-slider-val">{{ settings.customBgMask }}%</span>
        </div>
        <div class="sp-slider-row">
          <label>模糊</label>
          <input type="range" min="0" max="12" step="1" :value="settings.customBgBlur"
            @input="onSlider('customBgBlur', $event)" />
          <span class="sp-slider-val">{{ settings.customBgBlur }}px</span>
        </div>
      </div>
    </div>
    <div class="sp-row">
      <span class="sp-label">正文字体</span>
      <div class="sp-seg">
        <button v-for="f in fontOptions" :key="f.id" class="sp-seg-btn"
          :class="{ active: settings && settings.fontFamily === f.id }"
          @click="persistSettings({ fontFamily: f.id })">{{ f.name }}</button>
      </div>
    </div>
    <div class="sp-row">
      <span class="sp-label">字号大小</span>
      <div class="sp-step">
        <button class="sp-step-btn" @click="stepFontSize(-1)">−</button>
        <span class="sp-step-val">{{ settings ? settings.fontSize : '' }}</span>
        <button class="sp-step-btn" @click="stepFontSize(1)">＋</button>
      </div>
    </div>
    <div class="sp-row">
      <span class="sp-label">行距</span>
      <div class="sp-step">
        <button class="sp-step-btn" @click="stepSetting('lineHeight', -0.1, 1.2, 2.8)">−</button>
        <span class="sp-step-val">{{ settings ? Number(settings.lineHeight).toFixed(1) : '' }}</span>
        <button class="sp-step-btn" @click="stepSetting('lineHeight', 0.1, 1.2, 2.8)">＋</button>
      </div>
    </div>
    <div class="sp-row">
      <span class="sp-label">段距</span>
      <div class="sp-step">
        <button class="sp-step-btn" @click="stepSetting('paragraphSpacing', -0.1, 0, 2)">−</button>
        <span class="sp-step-val">{{ settings ? Number(settings.paragraphSpacing).toFixed(1) : '' }}</span>
        <button class="sp-step-btn" @click="stepSetting('paragraphSpacing', 0.1, 0, 2)">＋</button>
      </div>
    </div>
    <div class="sp-row">
      <span class="sp-label">页面宽度</span>
      <div class="sp-seg">
        <button v-for="w in widthSteps" :key="w" class="sp-seg-btn"
          :class="{ active: settings && Number(settings.contentWidth) === w }"
          @click="persistSettings({ contentWidth: w })">{{ w }}</button>
      </div>
    </div>
    <button class="sp-reset" @click="resetSettings">恢复默认设置</button>
    <div class="settings-hint">{{ shortcutHintText }}</div>
  </section>
</template>
