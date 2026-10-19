<script setup lang="ts">
/**
 * SettingsPanel.vue — 设置面板(起点风格)
 * 面板定位(贴合悬浮球)由 App 协调, 本组件暴露根元素
 */
import { computed, ref, watch } from 'vue';
import { state, THEMES, PROVINCES, SOLAR_TERMS, persistSettings, previewTheme, restoreTheme, stepFontSize, stepSetting, resetSettings } from '../store';
import { shortcutLabel } from '../composables/shortcut';

const rootRef = ref<HTMLElement | null>(null);
defineExpose({ el: rootRef });

/** 当前选中省份(未启用地域主题时也回退到已选省, 便于预览) */
const provinceCode = computed(function () {
  const s = state.settings;
  return s ? s.province : '110000';
});

/** 省份/节气列表展开状态(自绘下拉, 避免原生 select 的粗滚动条) */
const provinceOpen = ref(false);
const termOpen = ref(false);

/** 按钮文案: 只有正在使用地域主题时才显示省份名, 否则显示占位「地域色彩」 */
const provinceName = computed(function () {
  if (!state.settings || state.settings.theme !== 'province') { return '地域色彩'; }
  const found = PROVINCES.find(function (p) { return p.code === provinceCode.value; });
  return found ? found.name : '地域色彩';
});

/** 点击面板其他位置时收起省份列表 */
function closeProvinceMenu(e: MouseEvent): void {
  const picker = rootRef.value ? rootRef.value.querySelector('.sp-province-picker') : null;
  if (!picker || !picker.contains(e.target as Node)) { provinceOpen.value = false; }
}

watch(provinceOpen, function (open) {
  if (open) {
    document.addEventListener('mousedown', closeProvinceMenu, true);
  } else {
    document.removeEventListener('mousedown', closeProvinceMenu, true);
    restoreTheme(); // 关闭列表时结束任何预览
  }
});

/** 悬浮预览预设主题(不落盘) */
function previewPreset(themeId: string): void {
  previewTheme({ theme: themeId });
}

/** 选中预设主题: 先清预览, 再持久化 */
function choosePreset(themeId: string): void {
  restoreTheme();
  persistSettings({ theme: themeId });
}

/** 悬浮预览: 不落盘, 只看色板效果 */
function previewProvince(code: string): void {
  previewTheme({ theme: 'province', province: code });
}

/** 节气按钮文案: 仅在正在使用节气主题时显示节气名, 否则为占位「廿四节气」 */
const termName = computed(function () {
  if (!state.settings || state.settings.theme !== 'term') { return '廿四节气'; }
  const found = SOLAR_TERMS.find(function (t) { return t.id === state.settings!.term; });
  return found ? found.name : '廿四节气';
});

/** 悬浮预览节气 */
function previewTerm(id: string): void {
  previewTheme({ theme: 'term', term: id });
}

/** 选择节气 */
function chooseTerm(id: string): void {
  termOpen.value = false;
  restoreTheme();
  if (!id) { return; }
  persistSettings({ term: id, theme: 'term' });
}

/** 结束预览, 还原当前真实主题 */
function endPreview(): void {
  restoreTheme();
}

/** 选择省份: 同时切到「地域色彩」主题 */
function chooseProvince(code: string): void {
  provinceOpen.value = false;
  // 先还原预览态, 再交给持久化后的正式设置接管, 避免预览变量残留
  restoreTheme();
  if (!code) { return; }
  persistSettings({ province: code, theme: 'province' });
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
    <div class="sp-row sp-row-theme">
      <span class="sp-label">阅读主题</span>
      <div class="sp-themes" @mouseleave="endPreview()">
        <div class="sp-theme-dots">
          <span v-for="t in THEMES" :key="t.id" class="sp-dot" :data-theme="t.id" :title="t.name"
            :style="{ background: t.id === 'dark' ? '#1c1c1c' : t.bg, color: t.fg, '--sp-check': t.fg }"
            :class="{ active: settings && settings.theme === t.id }"
            @mouseenter="previewPreset(t.id)" @focus="previewPreset(t.id)"
            @click="choosePreset(t.id)"></span>
        </div>
        <!-- 第二行: 地域色彩 / 廿四节气 两个选择器(仍归属于「阅读主题」行) -->
        <div class="sp-theme-extra">
        <div class="sp-province-picker">
          <button class="sp-province-btn" :class="{ open: provinceOpen }"
            :title="settings && settings.theme === 'province' ? '当前使用地域色彩主题' : '选择省份后自动切换到地域色彩主题'"
            @click.stop="provinceOpen = !provinceOpen; termOpen = false">
            <span>{{ provinceName }}</span>
            <svg class="sp-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
              stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
          <div v-if="provinceOpen" class="sp-province-menu" @mouseleave="endPreview()">
            <!-- 仅在正在使用地域主题时才高亮"当前省", 否则与占位文案语义保持一致 -->
            <button v-for="p in PROVINCES" :key="p.code" class="sp-province-item"
              :class="{ active: settings && settings.theme === 'province' && p.code === provinceCode }"
              :style="{ borderLeftColor: p.colors[0] ? p.colors[0].hex : 'transparent' }"
              :title="p.name + (p.colors[0] ? ' · ' + p.colors[0].name : '')"
              @mouseenter="previewProvince(p.code)" @focus="previewProvince(p.code)"
              @click="chooseProvince(p.code)">{{ p.name }}</button>
          </div>
        </div>
        <!-- 廿四节气: 与地域色彩同一行 -->
        <div class="sp-province-picker" data-kind="term">
          <button class="sp-province-btn" :class="{ open: termOpen }"
            :title="settings && settings.theme === 'term' ? '当前使用廿四节气主题' : '选择节气后自动切换到廿四节气主题'"
            @click.stop="termOpen = !termOpen; provinceOpen = false">
            <span>{{ termName }}</span>
            <svg class="sp-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
              stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
          <div v-if="termOpen" class="sp-province-menu sp-term-menu" @mouseleave="endPreview()">
            <button v-for="t in SOLAR_TERMS" :key="t.id" class="sp-province-item"
              :class="{ active: settings && settings.theme === 'term' && settings.term === t.id }"
              :style="{ borderLeftColor: t.hex }" :title="t.name + ' · ' + t.color"
              @mouseenter="previewTerm(t.id)" @focus="previewTerm(t.id)"
              @click="chooseTerm(t.id)">{{ t.name }}</button>
          </div>
        </div>
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
